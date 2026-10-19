/**
 * **分叉孤儿登记表**(MC-027)—— 引擎侧会话复制成功、本地写入失败时的**补偿收尾**。
 *
 * ## 它在补哪个洞
 *
 * `lib/sessionFork.ts` 的 forkSession 分两步:先 `provider.forkSession`(在**引擎那边**
 * 复制一份上下文 —— 产生外部的会话文件),再在本地建会话行 + 抄消息。这两步里,**本地那
 * 一步能进一个 SQL 事务**(本地 Session + Messages 同 BEGIN/COMMIT,已做);可引擎那一
 * 步是**外部副作用**,进不了本地 SQL 事务。
 *
 * 于是有一个跨边界窗口:引擎那步成了、本地那步失败(磁盘满 / JSON 序列化错 / SQL 错),
 * 本地**整体回滚** —— 干净。但引擎侧那份复制**再没有任何本地行指向它**:它占着磁盘、
 * 还可能出现在引擎自己的会话列表里,而且用户根本不知道它存在。
 *
 * ## 补偿(Saga 的收尾那一步)
 *
 * forkSession 在本地事务**抛错之后**、把错误往上抛之前,回头处理那份外部复制:
 *   - 引擎提供了 `deleteSession` 且删成功 → 干干净净,什么都不留;
 *   - 引擎**没有**删除入口,或删的时候又失败 → 在这里**登记一行孤儿**(status
 *     `ORPHANED`),把"哪段对话残留了哪一个引擎侧会话、在哪个目录、为什么没删掉"记下来,
 *     供人工/后续工具清理。**绝不悄悄遗忘** —— 这正是台账反复点名的要求。
 *
 * 为什么不是"直接递归删 SDK 的数据目录":台账明说别这么干(SDK 的会话目录结构不是
 * 本仓库的契约,直接删会连带删掉引擎自己管的东西)。要删就删**它给出的那一份会话 id**。
 *
 * ## 为什么单独一个模块
 *
 * 与 `sessionFork.ts` 同一个理由:它要能在没有 Electron 的环境里被单跑一遍
 * (`scripts/session-fork-smoke`),不能把 IPC / Electron 拉进来。它只碰 db。
 */
import { getDb, persistNowOrThrow } from "@main/store/db.js";
import type { BindValue } from "@main/store/sessionSchema.js";
import { log } from "@main/lib/logger.js";
import { safeErrorMessage } from "@main/lib/ipcError.js";
import { withStatement } from "./repositories/withStatement.js";

/** 一条孤儿记录(表行 → 对象)。 */
export interface ForkOrphan {
  id: string;
  sourceSessionId: string;
  providerSessionId: string;
  providerId: string;
  cwd: string;
  reason: string;
  status: "ORPHANED" | "RESOLVED";
  createdAt: number;
  updatedAt: number;
}

export type ForkOrphanStatus = ForkOrphan["status"];

interface Row {
  id: string;
  source_session_id: string;
  provider_session_id: string;
  provider_id: string;
  cwd: string;
  reason: string;
  status: string;
  created_at: number;
  updated_at: number;
}

function rowToOrphan(r: Row): ForkOrphan {
  return {
    id: r.id,
    sourceSessionId: r.source_session_id,
    providerSessionId: r.provider_session_id,
    providerId: r.provider_id,
    cwd: r.cwd,
    reason: r.reason,
    status: r.status === "RESOLVED" ? "RESOLVED" : "ORPHANED",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** 登记一行"引擎侧复制没被清掉"的孤儿。 */
export interface OrphanInput {
  sourceSessionId: string;
  providerSessionId: string;
  providerId: string;
  cwd: string;
  reason: string;
  /** 由调用方给(便于无头测试钉死 id)。省略则现取。 */
  id?: string;
}

export const ForkOrphanRepo = {
  /**
   * 登记一行孤儿,返回它的 id。必须在返回前同步 durable 落盘:
   * 这是外部 SDK fork 已发生但本地事务失败后的唯一补偿线索,
   * 不能等合并写的微任务,否则当前进程崩溃时线索又丢失。
   */
  add(input: OrphanInput): string {
    const db = getDb();
    const id = input.id ?? `orphan_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = Date.now();
    const bind: BindValue[] = [
      id,
      input.sourceSessionId,
      input.providerSessionId,
      input.providerId,
      input.cwd,
      input.reason,
      "ORPHANED",
      now,
      now,
    ];
    db.run(
      `INSERT INTO fork_orphans
         (id, source_session_id, provider_session_id, provider_id, cwd, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind,
    );
    // A pending fork compensation is more important than an ordinary
    // coalesced setting write. Fail visibly if the only orphan record could
    // not be fsync'd to disk before control leaves this recovery path.
    persistNowOrThrow();
    return id;
  },

  get(id: string): ForkOrphan | undefined {
    const stmt = getDb().prepare("SELECT * FROM fork_orphans WHERE id = ?");
    return withStatement(stmt, (query) => {
      query.bind([id]);
      const found = query.step();
      const row = found ? (query.getAsObject() as unknown as Row) : undefined;
      return row ? rowToOrphan(row) : undefined;
    });
  },

  /** 待清理的孤儿(默认只列 ORPHANED)。 */
  list(status: ForkOrphanStatus = "ORPHANED"): ForkOrphan[] {
    const stmt = getDb().prepare(
      "SELECT * FROM fork_orphans WHERE status = ? ORDER BY created_at DESC",
    );
    return withStatement(stmt, (query) => {
      query.bind([status]);
      const out: ForkOrphan[] = [];
      while (query.step()) out.push(rowToOrphan(query.getAsObject() as unknown as Row));
      return out;
    });
  },

  /** 某段源对话名下、还待清理的孤儿数(排查/断言用)。 */
  countForSource(sourceSessionId: string): number {
    const stmt = getDb().prepare(
      "SELECT COUNT(*) AS n FROM fork_orphans WHERE source_session_id = ? AND status = 'ORPHANED'",
    );
    return withStatement(stmt, (query) => {
      query.bind([sourceSessionId]);
      query.step();
      return Number((query.getAsObject() as { n: number }).n);
    });
  },

  /** 标记一条孤儿已处理(清理者删掉了引擎侧那份后调它)。 */
  resolve(id: string): void {
    const db = getDb();
    db.run(
      "UPDATE fork_orphans SET status = 'RESOLVED', updated_at = ? WHERE id = ?",
      [Date.now(), id],
    );
    // Completing the external compensation is also a durability boundary.
    // A scheduled flush is insufficient: an immediate crash would resurrect
    // a resolved orphan and invite another cleanup of the same SDK session.
    if (db.getRowsModified() > 0) persistNowOrThrow();
  },
};

/**
 * 补偿清理的**收口**:本地写失败后,尽力删掉引擎侧那份复制;删不掉就登记孤儿。
 *
 * 异步,**绝不抛** —— 它就是错误处理路径的一部分。它自己失败(登记都写不进去)时只记
 * 一条 error 日志,把"还能怎么办"交代清楚,然后把控制权交回给调用方去抛**原始**的本地
 * 写错误(fork 失败的主因是那个,不能让补偿的次生错误盖过它)。
 *
 * 调用方**应当 await 它**(见 `sessionFork.ts` 的 try/catch):这样"删掉了没有 / 登记了
 * 没有"在返回前就尘埃落定,不会留一个还在跑的异步尾巴。
 */
export async function compensateProviderFork(args: {
  sourceSessionId: string;
  providerSessionId: string;
  providerId: string;
  cwd: string;
  /** 引擎的删除入口(有就用;没有就登记孤儿)。 */
  deleteSession?: (providerSessionId: string, opts: { cwd: string }) => Promise<void>;
  /** 本地那一步为什么失败(记进孤儿的 reason,便于排查)。 */
  cause: string;
}): Promise<void> {
  const { sourceSessionId, providerSessionId, providerId, cwd, deleteSession, cause } = args;

  // 没有删除入口 = 引擎不支持清理。当场登记孤儿,不假装删过。
  if (!deleteSession) {
    recordOrphan({
      sourceSessionId,
      providerSessionId,
      providerId,
      cwd,
      reason: `引擎 ${providerId} 没有删除入口,本地写入失败后的引擎侧复制无法自动回收:${cause}`,
    });
    log.warn(
      `session fork compensated: provider ${providerId} has no deleteSession; ` +
        `recorded orphan ${providerSessionId} (source=${sourceSessionId}, cwd=${cwd}). ${cause}`,
    );
    return;
  }

  // 有删除入口 —— 尝试删。
  try {
    await deleteSession(providerSessionId, { cwd });
    log.info(
      `session fork compensated: deleted leaked provider session ${providerSessionId} ` +
        `(source=${sourceSessionId}, provider=${providerId}, cwd=${cwd}). ${cause}`,
    );
  } catch (err) {
    // SDK implementations are allowed to throw ANY JavaScript value:
    // null, Object.create(null), or even an Error with a throwing message
    // getter. The compensating catch must never itself throw before we
    // durably record the external session that could not be deleted.
    const detail = safeErrorMessage(err);
    recordOrphan({
      sourceSessionId,
      providerSessionId,
      providerId,
      cwd,
      reason: `补偿删除失败:${detail}(本地写入失败原因:${cause})`,
    });
    log.warn(
      `session fork compensation: deleteSession failed for ${providerSessionId} ` +
        `(source=${sourceSessionId}, provider=${providerId}, cwd=${cwd}): ` +
        `${detail}. Recorded orphan.`,
    );
  }
}

/** 尽力登记一行孤儿;连同它自己失败也吞掉(只记 error),绝不打断补偿路径。 */
function recordOrphan(input: OrphanInput): void {
  try {
    ForkOrphanRepo.add(input);
  } catch (err) {
    log.error(
      `session fork compensation FAILED to record orphan ${input.providerSessionId} ` +
        `(source=${input.sourceSessionId}, provider=${input.providerId}, cwd=${input.cwd}): ` +
        `${safeErrorMessage(err)}. Engine-side copy remains untracked.`,
    );
  }
}
