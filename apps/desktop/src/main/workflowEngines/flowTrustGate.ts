/**
 * 【ARC-006 MERGE-1 / P1-6】**graphRevision ↔ workflowTrust 的可信关联判据**。
 *
 * ## 它回答什么
 *
 * 「这条 flow 的**这一版**能不能执行」—— 只此一句。回答"谁执行"的是
 * `executorOwnership.ts`（owner 判据）。**两者组合时顺序是：owner 先、trust 后**：
 *   1. `executorOwnerOf(flowId)` → 不是 `node-red`（或该跑的端）→ 不执行（归属问题）；
 *   2. `flowExecutableUnderTrust(...)` → 这一版没被真人批准 / 批准后被改过 → 不执行。
 * 顺序的理由：owner 是**身份**（这条 flow 归谁），trust 是**内容许可**（这一版准不准跑）。
 * 先判身份能避免"给一条不归你执行的 flow 反复做审批比对"；反过来先判 trust 会在
 * owner 冲突时错误地暴露 revision 信息。
 *
 * ## trust 记录的 revision 语义
 *
 * `workflowTrust.ts` 的审批记录（`ReviewRecord`）里，`approvedRevision` 是**审批那一刻
 * 的图内容修订**：`workflowRevision(doc)`（按 WorkflowDoc 形状、剪掉 updatedAt/icon/
 * 坐标）。Node-RED 侧执行的是 **flow 文件**，锚点必须是 **flow 的 revision**
 * （`flowRevision(flow)`，见 `nodeRedStorage.ts`）。本判据把两者对齐的方式是：
 * **审批记录里的 `approvedRevision` 必须等于盘上 flow 现算的 `flowRevision`** ——
 * 即"真人批准的那一版"就是"引擎里躺着的那一版"。迁移器产出的 flow 与 doc 一一对应
 * （`x-mcode.docId`），所以调用方在审批时应记录 flow 侧 revision（或由装配层把
 * doc revision 换算后写入）。本模块不替调用方做换算，只做**严格相等**判据。
 *
 * ## 三态（必须可区分，不能合并）
 *
 * | 情形 | 结果 | 为什么不能合并 |
 * |---|---|---|
 * | 没有记录 / 空标记 / `approvedRevision: null`（待审） | `untrusted` | 「没人批过」 |
 * | 记录坏（非 JSON、不是对象、origin 非法、approvedRevision 形状不对） | `trust-corrupt` | 「审批账本坏了」——需要人工修复，不是"从没批过" |
 * | 记录好但与盘上 revision 不等 | `revision-mismatch` + 两个 revision | 「批的是旧版」——要重新审查，不是"没批过" |
 *
 * ⚠️ 与 `workflowTrust.ts` 的一处**有意差异**：那边"没有记录"= 本地既有工作流，保持
 * 历史行为（可执行）。这边是**引擎侧 fail-closed**：Node-RED 里的 flow 默认来自迁移/
 * 导入/远端部署，没有审批记录就**不允许执行**。两者面向的信任边界不同，不要互相套用。
 *
 * ## 纯逻辑
 *
 * 不读 SettingRepo、不碰盘：调用方把 trust 的**原始值**（字符串或 null，见
 * `workflowTrust.recordOf` 的读法）传进来；flow 的当前 revision 由调用方从存储层取。
 * 因此本模块可在无头套件里直接测，也能被将来的落盘 trust store 复用。
 */

/** 审批记录的原始读取面：返回 settings 里那条记录的**原文**（或 null/undefined/空串）。 */
export type FlowTrustRawReader = (flowId: string) => string | null | undefined;

/** 解析后的审批记录（与 `workflowTrust.ts` 的 `ReviewRecord` 同义）。 */
export interface FlowTrustRecord {
  origin: "import" | "ai";
  /** 审批那一刻的 flow revision；`null` = 已登记待审（`requireWorkflowReview` 写的形状）。 */
  approvedRevision: string | null;
  reviewedAt?: number;
}

export type FlowTrustParseResult =
  | { ok: true; record: FlowTrustRecord }
  | { ok: false; reason: "untrusted" }
  | { ok: false; reason: "trust-corrupt"; detail: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * 解析 trust 原文。**三态严格区分**：
 *  - null / undefined / 空串（`clearWorkflowReview` 的空标记）→ `untrusted`；
 *  - 坏 JSON / 非对象 / origin 非法 / approvedRevision 既不是 null 也不是 64 位
 *    hex → `trust-corrupt`（带 detail，便于界面显示"账本坏了"而不是"没批过"）。
 */
export function parseFlowTrust(raw: string | null | undefined): FlowTrustParseResult {
  if (raw === null || raw === undefined || raw === "") return { ok: false, reason: "untrusted" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: "trust-corrupt", detail: `审批记录不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "trust-corrupt", detail: "审批记录不是对象" };
  }
  const entry = value as Record<string, unknown>;
  if (entry["origin"] !== "import" && entry["origin"] !== "ai") {
    return { ok: false, reason: "trust-corrupt", detail: `审批记录的 origin 非法：${JSON.stringify(entry["origin"])}` };
  }
  // 审计时间虽然兼容老版本缺省，但存在时必须是有效毫秒戳。
  // 过去把非法 reviewedAt 丢掉，却仍按 approvedRevision 授权执行，
  // 使坏审批记录看上去像健康批准；这是信任账本的 fail-open。
  const reviewedAt = entry["reviewedAt"];
  if (Object.prototype.hasOwnProperty.call(entry, "reviewedAt") &&
      !(typeof reviewedAt === "number" && Number.isSafeInteger(reviewedAt) && reviewedAt >= 0)) {
    return { ok: false, reason: "trust-corrupt", detail: "审批记录的 reviewedAt 不是有效毫秒时间戳" };
  }
  const approved = entry["approvedRevision"];
  if (approved !== null && !(typeof approved === "string" && SHA256_HEX.test(approved))) {
    return {
      ok: false,
      reason: "trust-corrupt",
      detail: `审批记录的 approvedRevision 形状非法：${JSON.stringify(approved)}`,
    };
  }
  return {
    ok: true,
    record: {
      origin: entry["origin"],
      approvedRevision: approved,
      ...(typeof entry["reviewedAt"] === "number" && Number.isFinite(entry["reviewedAt"])
        ? { reviewedAt: entry["reviewedAt"] }
        : {}),
    },
  };
}

export type FlowExecutableResult =
  | { ok: true; approvedRevision: string; origin: "import" | "ai"; currentRevision: string }
  | {
      ok: false;
      reason: "untrusted" | "trust-corrupt" | "revision-mismatch";
      /** 审批记录里的 revision（`untrusted` 时可能是 null）。 */
      approvedRevision: string | null;
      /** 盘上现算的 flow revision（`trust-corrupt` 时也给出，便于对照修复）。 */
      currentRevision: string;
      detail: string;
    };

/**
 * **纯判据**：这一版 flow 能否在 trust 下执行。
 *
 * @param currentRevision 盘上现算的 `flowRevision`（调用方从存储层取；**不**信任任何
 *                        文件内自报的 revision）
 * @param trustRaw       trust 记录原文（`FlowTrustRawReader` 的返回值）
 *
 * 顺序：先解析记录（区分 untrusted / trust-corrupt），再比 revision。
 * 记录坏时**不**降级成 untrusted —— 账本坏了要修，不能说成"没批过"。
 */
export function flowExecutableUnderTrust(
  currentRevision: string,
  trustRaw: string | null | undefined,
): FlowExecutableResult {
  const parsed = parseFlowTrust(trustRaw);
  if (!parsed.ok && parsed.reason === "untrusted") {
    return {
      ok: false,
      reason: "untrusted",
      approvedRevision: null,
      currentRevision,
      detail: "这条 flow 没有经过真人审批（引擎侧 fail-closed：没有审批记录不允许执行）",
    };
  }
  if (!parsed.ok) {
    return {
      ok: false,
      reason: "trust-corrupt",
      approvedRevision: null,
      currentRevision,
      detail: `审批账本损坏：${parsed.detail}（需要人工修复，不等于从未审批）`,
    };
  }
  const approved = parsed.record.approvedRevision;
  if (approved === null) {
    return {
      ok: false,
      reason: "untrusted",
      approvedRevision: null,
      currentRevision,
      detail: "这条 flow 已登记为待审查，但还没有被批准",
    };
  }
  if (approved !== currentRevision) {
    return {
      ok: false,
      reason: "revision-mismatch",
      approvedRevision: approved,
      currentRevision,
      detail: "审批的是旧版本，盘上 flow 在那之后被修改过；需要重新审查当前版本",
    };
  }
  return { ok: true, approvedRevision: approved, origin: parsed.record.origin, currentRevision };
}

/** 组合判据的便捷形式：先 owner（身份）后 trust（内容许可）—— 见文件头。 */
export function canExecuteFlow(input: {
  owner: "mcode" | "node-red" | null;
  /** 期望执行的一端（Node-RED 引擎侧传 "node-red"；旧 runner 侧传 "mcode"）。 */
  expectedOwner: "mcode" | "node-red";
  currentRevision: string | null;
  trustRaw: string | null | undefined;
}):
  | { ok: true; approvedRevision: string }
  | { ok: false; reason: "owner-mismatch" | "flow-missing" | "untrusted" | "trust-corrupt" | "revision-mismatch"; detail: string; approvedRevision?: string | null; currentRevision?: string | null } {
  // ① 身份：owner 必须存在且等于期望端。
  if (input.owner === null) {
    return { ok: false, reason: "owner-mismatch", detail: "这条 flow 没有任何 executor owner 登记（先登记归属再执行）" };
  }
  if (input.owner !== input.expectedOwner) {
    return { ok: false, reason: "owner-mismatch", detail: `这条 flow 由 ${input.owner} 执行，不是 ${input.expectedOwner}` };
  }
  // ② 内容许可：盘上 revision 必须存在（flow 没读到就谈不上审批比对）。
  if (input.currentRevision === null) {
    return { ok: false, reason: "flow-missing", detail: "盘上没有这条 flow（或读不出来），无法核对审批版本" };
  }
  // ③ trust。
  const trust = flowExecutableUnderTrust(input.currentRevision, input.trustRaw);
  if (!trust.ok) {
    return {
      ok: false,
      reason: trust.reason,
      detail: trust.detail,
      approvedRevision: trust.approvedRevision,
      currentRevision: trust.currentRevision,
    };
  }
  return { ok: true, approvedRevision: trust.approvedRevision };
}
