/**
 * **操作账本(MC-067 / ARC-009 步②)** —— 让「同一个 operationId 不重复执行」成为一条
 * **有可信请求身份、原子领取、可结算状态**的规则,而不是「结束后按字符串缓存一张 Map」。
 *
 * ## 它在补哪个洞(源码可确认的旧行为)
 *
 * 旧 `operationLog` 只按 `operationId` 字符串缓存**已完成结果**:换会话 / 换方法 / 换参数
 * 复用同一 id 会命中旧结果(B 拿到 A 的成功回执);两个并发请求都能穿过缓存各执行一次;
 * RPC 抛错(UNCERTAIN)没记入 Map,同 id 再试仍会真调一次。根因是把「幂等」简化成「结束后
 * 按字符串缓存」,缺一个**意图身份**和**在途状态**。
 *
 * ## 这份账本做什么
 *
 *   - **原子领取(claim)**:执行**副作用之前**先登记 `CLAIMED`;同 id 已在途 → 只能 JOIN
 *     或拒绝,**绝不双执行**;
 *   - **意图绑定**:领取时把方法名 + 请求参数的**规范化摘要** + 授权主体(owner/session)
 *     一起记下。同 id 换方法 / 换参数 / 换主体 = 变了一个意图 → `OPERATION_ID_CONFLICT`,
 *     **不回放旧成功**;
 *   - **全态结算**:SUCCEEDED / SUCCEEDED_WITH_WARNINGS / REJECTED / FAILED / UNCERTAIN
 *     全部落账;UNCERTAIN 同 id 重试**不盲发第二次**。
 *
 * ## 生产用哪份实现
 *
 * 这里的 {@link MemoryOperationLedger} 是**进程内**默认实现(供无 DB 的无头验证 / 注入使用);
 * 生产在 `main/index.ts` 启动时装上 `store/operationLedger.ts` 的 **sql.js durable 版**
 * (表 + 唯一约束 + `commitNow` 落盘),那才是跨进程权威。装上之后就**不再回退**内存版 ——
 * 静默降级会让「已经持久记账」变成假象。
 */
import { createHash } from "node:crypto";
import type { OperationIntent, OperationRecord, OperationStatus, OperationResult } from "@contracts/appControl";
import { OPERATION_ID_MAX_BYTES } from "@contracts/appControl";

/** 一次结算要写的信息。 */
export interface OperationSettlement {
  status: OperationStatus;
  /** 结算后的完整结果(同主体幂等重放的依据)。 */
  result?: OperationResult;
  /** 已提交成功时的结果正文(仅供同主体幂等重放)。 */
  body?: string;
}

/**
 * 原子领取的判定结果。**这是唯一一处**「同一个 operationId 到底该怎么办」的裁决:
 *   - `claimed` —— 首次(或重开)领取成功,调用方**现在可以执行副作用**;
 *   - `conflict` —— 同 id 被复用在一个**不同意图**上 → OPERATION_ID_CONFLICT;
 *   - `in-progress` —— 同意图的同 id **正在执行中** → 绝不双执行;
 *   - `replay` —— 同意图已**提交成功** → 回放旧结果,绝不重跑;
 *   - `uncertain` —— 同意图上次**结果不确定** → 回旧 UNCERTAIN,绝不盲发第二次。
 */
export type BeginOutcome =
  | { begin: "claimed"; record: OperationRecord }
  | { begin: "conflict"; record: OperationRecord }
  | { begin: "in-progress"; record: OperationRecord }
  | { begin: "replay"; record: OperationRecord }
  | { begin: "uncertain"; record: OperationRecord };

export interface OperationLedger {
  /**
   * 原子领取/裁决:`operationId` 首次出现(或是可重开的 REJECTED/FAILED)则登记
   * `CLAIMED` 并返回 `claimed=true`;**执行副作用之前必须调用**。其余情况返回该行的裁决。
   */
  begin(intent: OperationIntent): BeginOutcome;
  /** 结算一条操作(写终态 + 完整结果 / 正文)。 */
  settle(operationId: string, settlement: OperationSettlement): void;
  get(operationId: string): OperationRecord | undefined;
}

/** 意图指纹 —— 同方法 + 同参数 + 同主体才算「同一件事」。`grantRevision` 不参与。 */
export function intentFingerprint(intent: OperationIntent): string {
  return `${intent.ownerId}\u0000${intent.sessionId}\u0000${intent.method}\u0000${intent.requestDigest}`;
}

/**
 * 请求参数的**规范化摘要**:递归按 key 排序后序列化,再 sha256。同一份参数(键序不同也算
 * 同一份)得到同一个摘要;换一个字段就是另一个摘要 —— 这正是「同 id 换参数 = 换意图」的判据。
 */
export function requestDigestOf(input: unknown): string {
  return sha256(canonicalize(input));
}

/** 稳定序列化:对象按 key 排序,数组保持顺序;undefined 与缺失同义。 */
export function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v === undefined ? null : v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = walk(obj[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 幂等键的**字节**长度上限(模型可自选,得挡滥用)。超限返回 false。 */
export function operationIdWithinLimit(operationId: string): boolean {
  return Buffer.byteLength(operationId, "utf8") <= OPERATION_ID_MAX_BYTES;
}

/** 进程内账本 —— 正确的语义(意图绑定 + 原子领取 + 全态结算),只是不跨进程。 */
export class MemoryOperationLedger implements OperationLedger {
  private readonly records = new Map<string, OperationRecord>();

  begin(intent: OperationIntent): BeginOutcome {
    const existing = this.records.get(intent.operationId);
    if (existing) {
      // 同 id **不同意图** → 冲突。绝不回放旧成功(这正是 MC-067 跨会话串单的根因)。
      if (intentFingerprint(existing) !== intentFingerprint(intent)) {
        return { begin: "conflict", record: { ...existing } };
      }
      switch (existing.status) {
        case "CLAIMED":
        case "RUNNING":
          return { begin: "in-progress", record: { ...existing } };
        case "SUCCEEDED":
        case "SUCCEEDED_WITH_WARNINGS":
          return { begin: "replay", record: { ...existing } };
        case "UNCERTAIN":
          return { begin: "uncertain", record: { ...existing } };
        case "REJECTED":
        case "FAILED":
          // 「没执行 / 确定没落定」 —— 同意图重试**允许重新领取**执行。
          break;
      }
    }
    const record: OperationRecord = { ...intent, status: "CLAIMED", updatedAt: Date.now() };
    this.records.set(intent.operationId, record);
    return { begin: "claimed", record: { ...record } };
  }

  settle(operationId: string, s: OperationSettlement): void {
    const existing = this.records.get(operationId);
    if (!existing) return;
    const next: OperationRecord = { ...existing, status: s.status, updatedAt: Date.now() };
    // result / body 只在给定时覆盖 —— 结算 REJECTED 不必擦掉已有的结果。
    if (s.result !== undefined) next.result = s.result;
    if (s.body !== undefined) next.body = s.body;
    this.records.set(operationId, next);
  }

  get(operationId: string): OperationRecord | undefined {
    const r = this.records.get(operationId);
    return r ? { ...r } : undefined;
  }

  clear(): void {
    this.records.clear();
  }
}

/**
 * 当前生效的账本。**默认是内存版**;生产在启动时装上 sql.js durable 版(见文件头)。
 * 一旦装上 durable 版就**不再回退**内存版 —— `setOperationLedger(null)` 只给测试用。
 */
let activeLedger: OperationLedger = new MemoryOperationLedger();

export function getOperationLedger(): OperationLedger {
  return activeLedger;
}

/** 装配 / 测试用。传 null 重置回一个**全新**的内存版(每个用例前清一次,免得串味)。 */
export function setOperationLedger(ledger: OperationLedger | null): void {
  activeLedger = ledger ?? new MemoryOperationLedger();
}
