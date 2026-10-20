/**
 * 【ARC-006 MERGE-3 第一刀】**执行 owner 的单一事实源**。
 *
 * ## 它解决什么
 *
 * 合并期同一份工作流可能被**两端同时执行**，而两端彼此不知道对方存在：
 *
 * | 端 | 入口 | 执行什么 | 触发源 |
 * |---|---|---|---|
 * | `mcode` | `main/orchestration/automationRunner.ts` 的 `fire()` / `runNow()` → `runner.ts` 的 `runWorkflow()` | 库里的 `WorkflowDoc`（`workflowId` = `doc.id`） | 它自己的 cron ticker / 文件监听 / 事件订阅 / 手动按钮 |
 * | `node-red` | 引擎里的 flow（迁移器产出，Flow 的 `x-mcode.docId` 保留原 `doc.id`） | `flows.json` 里的 nodes/links | 引擎自己的 inject / http-in / `mcode-trigger` |
 *
 * 同一 `flowId` 若两边都登记，同一个事件会跑两次、cron 会响两遍、手动运行可能同时在
 * 两端起 —— 台账 MERGE-3 的验收门正是「同一个事件只有一次副作用」。本模块把
 * 「这条 flow 归谁执行」变成**一个可查询、可拒绝的事实**：
 *
 *   - {@link ExecutorOwnershipRegistry.executorOwnerOf} 是唯一读入口：
 *     `"mcode" | "node-red" | null`；
 *   - 登记是**显式冲突**（第二个 owner 被拒，带可读原因），**不是后写赢** ——
 *     后者正是"两边都以为自己拥有"的成因；
 *   - 释放只允许**当前 owner** 做（陈旧的一方不能把所有权偷走）；
 *   - 未登记 = `null`：调用方必须显式处理「没人拥有」，而不是默认落到某一端
 *     （防空过：把未知当 mcode 会让 Node-RED 已拥有的 flow 又被旧 runner 跑一遍）。
 *
 * ## 本片的边界
 *
 * 只做**判据 + 内存实现**：不读盘、不写库、不改 `automationRunner`/`runner` 的
 * 行为（本片只读它们确认冲突形态）。生产装配将来把 {@link ExecutorOwnershipStore}
 * 换成落盘的版本（与 flows.json 同一事务边界）—— 届时本模块的判据原样复用。
 *
 * ## 身份约定
 *
 * `flowId` 一律用 **Mcode `WorkflowDoc.id`**：迁移器把它保留在 Flow 的
 * `x-mcode.docId` 上（见 `flowMigration.ts`），所以两端说的是同一个键。Node-RED
 * 内部生成的 Flow id（`flow_<docId>`）**不**作为登记键 —— 那是引擎侧的实现细节。
 *
 * ## 纯函数面（便于无头测试与将来落盘）
 *
 * 判断本身不依赖时间、IO 或全局状态；{@link decideClaim} 是纯函数，
 * {@link ExecutorOwnershipRegistry} 只是在注入的 store 上做原子插入/删除。
 */

import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "@main/lib/dataRoot.js";
import { FileExecutorOwnershipStore } from "./fileExecutorOwnershipStore.js";

/** 谁执行这条 flow。只有两端 —— 新端要进来必须先改这里（有意封闭）。 */
export const EXECUTOR_OWNERS = ["mcode", "node-red"] as const;
export type ExecutorOwner = (typeof EXECUTOR_OWNERS)[number];

export function isExecutorOwner(value: unknown): value is ExecutorOwner {
  return typeof value === "string" && (EXECUTOR_OWNERS as readonly string[]).includes(value);
}

/** 一条登记记录。`reason` 是**登记方自报**的来源说明（装配点/节点包/迁移），只用于诊断。 */
export interface ExecutorOwnershipRecord {
  flowId: string;
  owner: ExecutorOwner;
  reason?: string;
  /** 登记时刻（毫秒；调用方注入，判据不看它）。 */
  claimedAt?: number;
}

/**
 * 可注入的存储面。**原子**是关键：`insert` 在已存在时必须失败（而不是覆盖）；
 * 落盘实现要用同一事务保证这一点。
 */
export interface ExecutorOwnershipStore {
  get(flowId: string): ExecutorOwnershipRecord | null;
  /** 已存在（无论 owner）→ 返回 false 且**不改动**已有记录。 */
  insert(record: ExecutorOwnershipRecord): boolean;
  /** 只有 owner 匹配才删除；返回是否真的删了。 */
  remove(flowId: string, owner: ExecutorOwner): boolean;
  list(): ExecutorOwnershipRecord[];
  /** Optional fail-closed guard for recovered but unverified disk state. */
  refuseLegacy?(): string | null;
  /** A boot-restored native reservation may be consumed once by its engine. */
  takeRecoveredNativeClaim?(flowId: string): boolean;
}

/** 内存实现（本片唯一实现；生产落盘版将来替换它，接口不变）。 */
export class InMemoryExecutorOwnershipStore implements ExecutorOwnershipStore {
  private readonly records = new Map<string, ExecutorOwnershipRecord>();

  get(flowId: string): ExecutorOwnershipRecord | null {
    const record = this.records.get(flowId);
    return record === undefined ? null : { ...record };
  }

  insert(record: ExecutorOwnershipRecord): boolean {
    if (this.records.has(record.flowId)) return false;
    // Never store a caller-owned mutable reference: otherwise a consumer can
    // change the owner after an approved claim without release/claim checks.
    this.records.set(record.flowId, { ...record });
    return true;
  }

  remove(flowId: string, owner: ExecutorOwner): boolean {
    const current = this.records.get(flowId);
    if (current === undefined || current.owner !== owner) return false;
    this.records.delete(flowId);
    return true;
  }

  list(): ExecutorOwnershipRecord[] {
    // Diagnostics/UI may annotate their local rows. Those mutations must not
    // change the sole owner registry or bypass conflict checks.
    return [...this.records.values()].map((record) => ({ ...record }));
  }
}

/** 登记结果。冲突是**一等结果**，带双方身份，调用方可直接展示。 */
export type ExecutorClaimResult =
  | { ok: true; flowId: string; owner: ExecutorOwner; alreadyOwned: boolean }
  | {
      ok: false;
      flowId: string;
      reason: string;
      /** 冲突时的双方；`current === null` 表示不是"被另一端占用"这一类（如非法入参）。 */
      conflict: { requested: ExecutorOwner; current: ExecutorOwner } | null;
    };

/** 释放结果。 */
export type ExecutorReleaseResult =
  | { ok: true; flowId: string; owner: ExecutorOwner }
  | { ok: false; flowId: string; reason: string };

/**
 * **纯判据**：给定现有记录与一次登记意图，决定允许还是冲突。不读写任何存储。
 *
 * 规则（三条，都是一个方向：不替用户做主、不让后写赢）：
 *  1. 未登记 → 允许；
 *  2. 已由**同一个** owner 登记 → 允许且 `alreadyOwned`（重复登记是幂等的：
 *     `automationRunner.reload()` 会反复登记同一触发器的归属，那不是冲突）；
 *  3. 已由**另一个** owner 登记 → 拒绝，原因点名双方。
 */
export function decideClaim(
  existing: ExecutorOwnershipRecord | null,
  requested: ExecutorOwner,
): { ok: true; alreadyOwned: boolean } | { ok: false; current: ExecutorOwner } {
  if (existing === null) return { ok: true, alreadyOwned: false };
  if (existing.owner === requested) return { ok: true, alreadyOwned: true };
  return { ok: false, current: existing.owner };
}

/** 登记参数的合法性（防空键：空 flowId 不能成为"没人拥有"之外的第二条路）。 */
function validateFlowId(flowId: unknown): flowId is string {
  // Host-owned workflow IDs are opaque (do not normalize), but must never
  // introduce control characters into logs/lookup keys or unbounded records.
  return typeof flowId === "string" &&
    flowId.length <= 512 && flowId.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(flowId);
}

function invalidFlowIdDisplay(value: unknown): string {
  // Never coerce an untrusted object in an error path. Object.create(null)
  // has no toString and would otherwise crash the only owner registry.
  return typeof value === "string" ? value.slice(0, 120) : "<非法类型>";
}

/**
 * 执行 owner 的注册表 —— **唯一**的读写入口。
 *
 * 生产装配将来：`new ExecutorOwnershipRegistry(persistentStore)`；
 * 本片：`new ExecutorOwnershipRegistry(new InMemoryExecutorOwnershipStore())`。
 */
export class ExecutorOwnershipRegistry {
  /** A running legacy workflow holds its owner through asynchronous execution,
   * even if its automation trigger is removed while that run is in flight. */
  private readonly executions = new Map<string, { owner: ExecutorOwner; count: number; transient: boolean; releaseRequested: boolean }>();
  constructor(private readonly store: ExecutorOwnershipStore) {}

  /** 这条 flow 归谁执行；未登记 → `null`（调用方必须显式处理，不允许默认落端）。 */
  executorOwnerOf(flowId: string): ExecutorOwner | null {
    if (!validateFlowId(flowId)) return null;
    return this.store.get(flowId)?.owner ?? null;
  }

  /** 登记归属。另一端已拥有 → 显式冲突（带双方），绝不覆盖。 */
  claim(flowId: string, owner: ExecutorOwner, options: { reason?: string; now?: () => number } = {}): ExecutorClaimResult {
    if (!validateFlowId(flowId)) {
      return {
        ok: false,
        flowId: invalidFlowIdDisplay(flowId),
        reason: "flowId 非法：必须是非空、无控制字符且不超过 512 字符的字符串",
        conflict: null,
      };
    }
    if (!isExecutorOwner(owner)) {
      return {
        ok: false,
        flowId,
        reason: `未知的 executor owner（只允许 ${EXECUTOR_OWNERS.join(" / ")}）`,
        conflict: null,
      };
    }
    const refusal = owner === "mcode" ? this.store.refuseLegacy?.() : null;
    if (refusal) return { ok: false, flowId, reason: refusal, conflict: null };
    const existing = this.store.get(flowId);
    const decision = decideClaim(existing, owner);
    if (!decision.ok) {
      return {
        ok: false,
        flowId,
        reason:
          `「${flowId}」已由 ${decision.current} 执行 —— 拒绝 ${owner} 重复登记`
          + `（同一 flow 只能有一个 executor owner；先由 ${decision.current} 释放后再切换）`,
        conflict: { requested: owner, current: decision.current },
      };
    }
    if (decision.alreadyOwned) {
      // An automation registration promotes an in-flight-only claim into a
      // persistent trigger owner; a running lease cannot do that implicitly.
      const lease = this.executions.get(flowId);
      if (lease?.owner === owner) {
        lease.transient = false;
        lease.releaseRequested = false;
      }
      return { ok: true, flowId, owner, alreadyOwned: true };
    }
    const record: ExecutorOwnershipRecord = {
      flowId,
      owner,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.now !== undefined ? { claimedAt: options.now() } : {}),
    };
    // 原子插入失败 = 并发下另一条登记抢先；按冲突处理（不覆盖）。
    if (!this.store.insert(record)) {
      const winner = this.store.get(flowId);
      if (winner !== null && winner.owner === owner) return { ok: true, flowId, owner, alreadyOwned: true };
      return {
        ok: false,
        flowId,
        reason: `「${flowId}」在登记过程中被 ${winner?.owner ?? "另一端"} 抢先登记`,
        conflict: winner === null ? null : { requested: owner, current: winner.owner },
      };
    }
    return { ok: true, flowId, owner, alreadyOwned: false };
  }

  /** Hold a running workflow until completion, separate from persistent trigger claims. */
  acquireExecution(flowId: string, owner: ExecutorOwner):
    | { ok: true; release: () => void }
    | { ok: false; reason: string } {
    const refusal = owner === "mcode" ? this.store.refuseLegacy?.() : null;
    if (refusal) return { ok: false, reason: refusal };
    const inFlight = this.executions.get(flowId);
    if (inFlight !== undefined) {
      if (inFlight.owner !== owner || this.executorOwnerOf(flowId) !== owner) {
        return { ok: false, reason: `flow「${flowId}」运行归属与现有 owner 冲突` };
      }
      inFlight.count++;
    } else {
      const result = this.claim(flowId, owner, { reason: "legacy workflow run", now: Date.now });
      if (!result.ok) return { ok: false, reason: result.reason };
      this.executions.set(flowId, {
        owner, count: 1, transient: !result.alreadyOwned, releaseRequested: false,
      });
    }
    let released = false;
    return { ok: true, release: () => {
      if (released) return;
      released = true;
      const lease = this.executions.get(flowId);
      if (lease === undefined || lease.owner !== owner) return;
      if (--lease.count !== 0) return;
      this.executions.delete(flowId);
      if (lease.transient || lease.releaseRequested) {
        const result = this.release(flowId, owner);
        if (!result.ok) throw new Error(result.reason);
      }
    } };
  }

  /** 释放归属。**只有当前 owner** 能释放（陈旧的一方不能偷走所有权）。 */
  release(flowId: string, owner: ExecutorOwner): ExecutorReleaseResult {
    if (!validateFlowId(flowId)) {
      return { ok: false, flowId: invalidFlowIdDisplay(flowId), reason: "flowId 非法，拒绝释放执行归属" };
    }
    const current = this.store.get(flowId);
    if (current === null) {
      return { ok: false, flowId, reason: `「${flowId}」没有登记过，无需释放` };
    }
    if (current.owner !== owner) {
      return {
        ok: false,
        flowId,
        reason: `「${flowId}」当前归 ${current.owner}，${owner} 不能释放（先由 ${current.owner} 释放）`,
      };
    }
    const lease = this.executions.get(flowId);
    if (lease?.owner === owner && lease.count > 0) {
      // Trigger shutdown must not make an active workflow available to Node-RED.
      lease.releaseRequested = true;
      return { ok: true, flowId, owner };
    }
    // 不能把持久化存储的拒删 / 并发变化伪装成已释放，否则切换执行端时
    // 两侧会基于虚假的成功结论继续部署，最终出现双执行或卡住的归属。
    if (!this.store.remove(flowId, owner)) {
      return {
        ok: false,
        flowId,
        reason: `「${flowId}」释放失败（存储拒绝删除或所有权已变化），请重新读取归属后重试`,
      };
    }
    return { ok: true, flowId, owner };
  }

  /** Admit only a verified native claim that was restored on this process boot. */
  adoptRecoveredNativeClaim(flowId: string): boolean {
    return this.store.takeRecoveredNativeClaim?.(flowId) ?? false;
  }

  /** 当前全部登记（诊断/界面用；顺序为登记顺序）。 */
  list(): ExecutorOwnershipRecord[] {
    return this.store.list();
  }
}

/** 本片的默认实例（内存）。生产装配会换成落盘版 —— 调用方只依赖类接口。 */
export function createInMemoryExecutorOwnership(): ExecutorOwnershipRegistry {
  return new ExecutorOwnershipRegistry(new InMemoryExecutorOwnershipStore());
}

/**
 * Lazy disk binding: importing the singleton in a headless test never touches
 * a real data root. Production first use resolves the very same Node-RED
 * engine directory as registry.dataDirOf("node-red").
 */
class LazyFileExecutorOwnershipStore implements ExecutorOwnershipStore {
  private active: FileExecutorOwnershipStore | null = null;

  private store(): FileExecutorOwnershipStore {
    if (this.active) return this.active;
    const root = dataRoot();
    // No implicit trust of a replaced junction inside the managed engine tree.
    for (const path of [root, join(root, "workflow-engines"), join(root, "workflow-engines", "node-red")]) {
      try {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("受管引擎目录不是独立目录：" + path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        mkdirSync(path);
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("受管引擎目录状态不可验证：" + path);
      }
    }
    this.active = new FileExecutorOwnershipStore(join(root, "workflow-engines", "node-red"));
    return this.active;
  }
  get(flowId: string): ExecutorOwnershipRecord | null { return this.store().get(flowId); }
  insert(record: ExecutorOwnershipRecord): boolean { return this.store().insert(record); }
  remove(flowId: string, owner: ExecutorOwner): boolean { return this.store().remove(flowId, owner); }
  list(): ExecutorOwnershipRecord[] { return this.store().list(); }
  refuseLegacy(): string | null { return this.store().refuseLegacy(); }
  takeRecoveredNativeClaim(flowId: string): boolean { return this.store().takeRecoveredNativeClaim(flowId); }
  diagnostics() { return this.store().diagnostics(); }
}

/** The one per-main-process registry shared by native runtime, legacy runs and automation. */
export const sharedExecutorOwnership = new ExecutorOwnershipRegistry(new LazyFileExecutorOwnershipStore());
