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
 * ## ⚠️ 写盘走 `persist()`
 *
 * 账本状态要落盘,但**不能每次记账都同步 fsync 整库**(那是「每来一个工具调用就重写整个
 * 数据库文件」)。领取 / 结算改内存表 + `persist()`(合并落盘,250ms 兜底),与其它仓储
 * 一致。真正的「操作已 durable」由权威业务那侧的 `commitNow` 负责(见 `@contracts/commit`),
 * 账本的责任是**去重与状态**,不是替代业务落盘。
 */
import type { OperationIntent, OperationRecord, OperationStatus, OperationResult, OperationResultKind } from "@contracts/appControl";
import { getDb, persist } from "@main/store/db.js";
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
      // 插入生效 = 我领到了。
      persist();
      const record: OperationRecord = { ...intent, status: "CLAIMED", updatedAt: Date.now() };
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
      db.run(
        `UPDATE operations SET status = 'CLAIMED', result_json = NULL, body = NULL,
           grant_revision = ?, effect_kind = ?, updated_at = ? WHERE operation_id = ?`,
        [intent.grantRevision, intent.effectKind, Date.now(), intent.operationId],
      );
      persist();
      return { begin: "claimed", record: { ...existing, status: "CLAIMED", grantRevision: intent.grantRevision, updatedAt: Date.now() } };
    }
    return outcome;
  },

  settle(operationId: string, s: OperationSettlement): void {
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
    persist();
  },

  get: readRow,
};

/**
 * 结算时把 `OperationResult` 的 `resultKind` 也存进 `result_json` —— 上层直接读 `result`。
 * (这里不需要额外处理: settle 收的就是完整 OperationResult。)
 */
export type { OperationResultKind };
