/**
 * **操作账本的 sql.js durable 版(MC-067 / ARC-009 步②)** —— 生产用它,让「同一个
 * operationId 不重复执行」成为一条**跨进程**(重启后仍成立)的规则。
 *
 * ## 与内存版的关系
 *
 * `appControl/operations.ts` 的 {@link MemoryOperationLedger} 语义正确但不跨进程;本文件
 * 是它的**持久化权威版**,由 `main/index.ts` 启动时装上(`setOperationLedger(...)`)。
 * 装上之后不再回退内存版 —— 静默降级会让「已经持久记账」变成假象。
 *
 * ## 原子领取靠数据库
 *
 * `begin()` 用 `INSERT ... ON CONFLICT(operationId) DO NOTHING`(见仓储写法)先试着登记
 * 一行 `CLAIMED`:插入生效(改动行数 1)= 领取成功;没插进去(该 id 已存在)= 读出那一行
 * 再按意图指纹 / 状态裁决。sql.js 是**同步**的,整个 begin 没有 await 点,因此在事件循环里
 * 是原子的 —— 两个并发调用不可能同时领到同一个 id。这与「内存锁」不同:它落在**唯一约束**
 * 上,跨进程也成立。
 *
 * ## ⚠️ 领取必须在**允许外部副作用之前**真正 durable(MC-084)
 *
 * 光「内存里 INSERT 了一行 CLAIMED」不够 —— sql.js 的内存表重启即失。假如领到 CLAIMED、
 * 就返回 `claimed` 让业务去执行外部副作用,而这次领取**只在内存里**(`persist()` 是 250ms
 * 合并落盘),此刻崩溃重启,磁盘上根本没有这一行 → 同一个 `operationId` **会被再次领取并
 * 重复执行外部动作**。这正是 MC-084 的 E1。
 *
 * 所以领到 CLAIMED 之后、返回 `claimed` 之前,走 `commitNow()`(与 `@contracts/commit`
 * 同一份判据)**同步 fsync 整库**;只有 `DURABLE` 才允许执行。非 DURABLE 时**回滚掉这次
 * 内存领取**(若它是本 begin 新插入/重开的行),返回 `claim-not-durable` —— 让上层拒绝执行,
 * 绝不把「领取成功但没落盘」这种态抛给业务去跑。代价是每次**带 operationId 的**有副作用调用
 * 多一次整库 fsync;一次性 `app_api_call` 的延迟里这可以接受,而正确性不能省。
 *
 * 反过来说:只读档的凭据在 `app_api_call` 层就不进账本(见 `tools.ts`),所以「每个普通只读
 * 请求都 fsync 整库」不会发生 —— 账本只对**带了幂等键的**调用生效。
 */
import type { OperationIntent, OperationRecord, OperationStatus, OperationResult, OperationResultKind } from "@contracts/appControl";
import { getDb, persist, commitNow } from "@main/store/db.js";
import { durableRevisionOf } from "@contracts/commit";
import { log } from "@main/lib/logger.js";
import {
  intentFingerprint,
  type BeginOutcome,
  type OperationLedger,
  type OperationSettlement,
} from "@main/appControl/operations.js";

interface Row {
  operation_id: string;
  owner_id: string;
  session_id: string;
  scene_id: string;
  method: string;
  request_digest: string;
  effect_kind: string;
  grant_revision: string;
  status: string;
  result_json: string | null;
  body: string | null;
  updated_at: number;
}

function rowToRecord(r: Row): OperationRecord {
  const record: OperationRecord = {
    operationId: r.operation_id,
    ownerId: r.owner_id,
    sessionId: r.session_id,
    sceneId: r.scene_id,
    method: r.method,
    requestDigest: r.request_digest,
    effectKind: r.effect_kind === "mutating" ? "mutating" : "readonly",
    grantRevision: r.grant_revision,
    status: r.status as OperationStatus,
    updatedAt: r.updated_at,
  };
  if (r.result_json) {
    try {
      record.result = JSON.parse(r.result_json) as OperationResult;
    } catch {
      /* 结果正文坏掉不影响「这一行存在」这个去重事实;不抛。 */
    }
  }
  if (r.body !== null) record.body = r.body;
  return record;
}

function readRow(operationId: string): OperationRecord | undefined {
  const stmt = getDb().prepare("SELECT * FROM operations WHERE operation_id = ?");
  stmt.bind([operationId]);
  const found = stmt.step();
  const row = found ? (stmt.getAsObject() as unknown as Row) : undefined;
  stmt.free();
  return row ? rowToRecord(row) : undefined;
}

/**
 * 把一条记录**整行写回**(回滚用)。领取在落盘前失败时,把这一行还原成重开之前的
 * 终态 —— 内存必须与磁盘一致,不能留下「重开了但没落盘」这种只有内存知道的态。
 */
function writeRow(record: OperationRecord): void {
  getDb().run(
    `UPDATE operations SET owner_id = ?, session_id = ?, scene_id = ?, method = ?, request_digest = ?,
       effect_kind = ?, grant_revision = ?, status = ?, result_json = ?, body = ?, updated_at = ?
     WHERE operation_id = ?`,
    [
      record.ownerId,
      record.sessionId,
      record.sceneId,
      record.method,
      record.requestDigest,
      record.effectKind,
      record.grantRevision,
      record.status,
      record.result !== undefined ? JSON.stringify(record.result) : null,
      record.body !== undefined ? record.body : null,
      record.updatedAt,
      record.operationId,
    ],
  );
}

/** 与内存版同形的裁决逻辑,只是行住在表里(复用 {@link intentFingerprint} 一处判据)。 */
function decide(existing: OperationRecord, intent: OperationIntent): BeginOutcome {
  if (intentFingerprint(existing) !== intentFingerprint(intent)) {
    return { begin: "conflict", record: existing };
  }
  switch (existing.status) {
    case "CLAIMED":
    case "RUNNING":
      return { begin: "in-progress", record: existing };
    case "SUCCEEDED":
    case "SUCCEEDED_WITH_WARNINGS":
      return { begin: "replay", record: existing };
    case "UNCERTAIN":
      return { begin: "uncertain", record: existing };
    default:
      // REJECTED / FAILED —— 没执行 / 确定没落定,允许重新领取执行(不 upsert,交由 begin 覆盖)。
      return { begin: "claimed", record: existing };
  }
}

export const DurableOperationLedger: OperationLedger = {
  begin(intent: OperationIntent): BeginOutcome {
    const db = getDb();
    // 先按唯一约束登记一行(已存在则不动),看改动行数判「是不是我领到的」。
    db.run(
      `INSERT INTO operations
         (operation_id, owner_id, session_id, scene_id, method, request_digest, effect_kind, grant_revision, status, result_json, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CLAIMED', NULL, NULL, ?)
       ON CONFLICT(operation_id) DO NOTHING`,
      [
        intent.operationId,
        intent.ownerId,
        intent.sessionId,
        intent.sceneId,
        intent.method,
        intent.requestDigest,
        intent.effectKind,
        intent.grantRevision,
        Date.now(),
      ],
    );
    if (db.getRowsModified() > 0) {
      // 插入生效 = 我领到了。**有副作用的操作在允许外部副作用之前,这次领取必须真正 durable。**
      // 领取只在内存里(还没 fsync)时,此刻崩溃重启 → 磁盘上没有这一行 → 同一 id 会被
      // 再次领取、重复执行外部动作(MC-084 的 E1)。所以对 mutating 操作同步落盘;落盘不成即
      // 回滚这次领取(删掉刚插入的行),返回 claim-not-durable,让上层拒绝执行。
      //
      // 只读操作不设耐久栅栏:重跑一次读没有外部副作用(幂等),为它每次 fsync 整库纯属浪费
      // (台账系统性方案第 4 条:「只读操作的性能不被多余落盘劣化」)。只读仍走合并的 persist()。
      const record: OperationRecord = { ...intent, status: "CLAIMED", updatedAt: Date.now() };
      if (intent.effectKind === "mutating") {
        if (commitNow().outcome !== "DURABLE") {
          db.run("DELETE FROM operations WHERE operation_id = ?", [intent.operationId]);
          return { begin: "claim-not-durable", record };
        }
      } else {
        persist();
      }
      return { begin: "claimed", record };
    }
    // 已存在 —— 读出来裁决。
    const existing = readRow(intent.operationId);
    if (!existing) {
      // 理论不该发生(并发删?);保守当在途,绝不重复执行。
      return { begin: "in-progress", record: { ...intent, status: "CLAIMED", updatedAt: Date.now() } };
    }
    const outcome = decide(existing, intent);
    if (outcome.begin === "claimed") {
      // REJECTED / FAILED 可重开:把这一行重置成这次意图的 CLAIMED(意图已核对相同)。
      // 同样,对 mutating 操作重开这个动作也必须在执行前 durable;落盘不成就把这一行还原成
      // 重开前的终态,返回 claim-not-durable(内存与磁盘都停在原来那个终态)。
      const reopened: OperationRecord = { ...existing, status: "CLAIMED", result: undefined, body: undefined, grantRevision: intent.grantRevision, effectKind: intent.effectKind, updatedAt: Date.now() };
      db.run(
        `UPDATE operations SET status = 'CLAIMED', result_json = NULL, body = NULL,
           grant_revision = ?, effect_kind = ?, updated_at = ? WHERE operation_id = ?`,
        [intent.grantRevision, intent.effectKind, reopened.updatedAt, intent.operationId],
      );
      if (intent.effectKind === "mutating") {
        if (commitNow().outcome !== "DURABLE") {
          writeRow(existing);
          return { begin: "claim-not-durable", record: existing };
        }
      } else {
        persist();
      }
      return { begin: "claimed", record: reopened };
    }
    return outcome;
  },

  settle(operationId: string, s: OperationSettlement): void {
    // 先读出这条操作的副作用类别(结算本身不带)——决定要不要 fsync。**在 UPDATE 之前读**。
    const effectKind = readRow(operationId)?.effectKind;
    getDb().run(
      `UPDATE operations SET status = ?, result_json = ?, body = ?, updated_at = ? WHERE operation_id = ?`,
      [
        s.status,
        s.result !== undefined ? JSON.stringify(s.result) : null,
        s.body !== undefined ? s.body : null,
        Date.now(),
        operationId,
      ],
    );
    // mutating 的结算也必须是**可持久**的:重启后不能误把已 DONE 的操作降成可重开的 FAILED
    // (那样同 id 会再次执行)。这里同步 durable;失败只记日志、**绝不把已经发生的业务事实
    // 改标**(进程仍握着内存里的终态,退避重试会补上)。只读结算走合并 persist() 即可。
    if (effectKind === "mutating") {
      const result = commitNow();
      if (result.outcome !== "DURABLE") {
        log.warn(`operation settle not durable (${operationId} → ${s.status}): ${result.reason ?? "unknown"}`);
      } else if (s.result !== undefined && s.result.durableRevision === undefined) {
        // 【ARC-009】结算这次**落盘成功** → 把落盘版本号盖进结果。于是同 id 回放时,
        // 调用方能读到「这一份是哪次落盘」—— 与 `OperationResult.durableRevision` 的
        // 语义对齐(不是内存修订号,是整库 durable 序列)。失败路径**不盖**(没落盘没有版本)。
        const rev = durableRevisionOf(result);
        if (rev !== undefined) {
          s.result.durableRevision = rev;
          getDb().run("UPDATE operations SET result_json = ? WHERE operation_id = ?", [
            JSON.stringify(s.result),
            operationId,
          ]);
        }
      }
    } else {
      persist();
    }
  },

  get: readRow,
};

/**
 * 结算时把 `OperationResult` 的 `resultKind` 也存进 `result_json` —— 上层直接读 `result`。
 * (这里不需要额外处理: settle 收的就是完整 OperationResult。)
 */
export type { OperationResultKind };
