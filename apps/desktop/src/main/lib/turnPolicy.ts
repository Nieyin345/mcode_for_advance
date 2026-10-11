/**
 * 轮策略偏好 —— S3 轮预算 + S4 失败回退链的**解析与判定**纯函数层。
 *
 * 从 RuntimeManager 拆出来：这两条管线的入口都是"设置表里的一段 JSON"，
 * 坏输入必须安全降级（宁可没有预算/没有回退，也不能因为一段坏配置把会话
 * 弄瘫），而且都是纯函数 —— 边界多、值得无头 smoke 直测，就别和
 * RuntimeManager 那一身 electron 依赖绑在一起。
 */
import type { StartTurnRequest } from "@contracts/provider.js";

/** `runtime.turnBudget` 偏好的原始形态。 */
interface TurnBudgetSetting {
  enabled?: boolean;
  maxTurns?: number;
  maxUsd?: number;
  maxTotalTokens?: number;
}

/** 解析后的轮预算（与 StartTurnRequest.budget 同形）。 */
export type TurnBudget = NonNullable<StartTurnRequest["budget"]>;

/**
 * 解析轮预算偏好。**关（enabled≠true）→ undefined**；坏 JSON → undefined
 * （宁可没有预算也不能因为一段坏配置把会话弄瘫）；开了但三个上限一个都
 * 没有 → undefined（没有限什么）。数值只收正数。
 */
export function parseTurnBudget(raw: string | null | undefined): TurnBudget | undefined {
  return parseTurnBudgetDetailed(raw).budget;
}

/**
 * 【MC-083】预算是**费用与风险边界**,不能像普通偏好那样"坏输入就安全降级成不限制" ——
 * 用户此前确认过 maxUsd/maxTurns/maxTotalTokens,一段坏 JSON(写入中断/导入/迁移/外部改)
 * 若把它悄悄变成"无预算",等于把用户确认过的限额失效。所以要区分三种事实:
 *   - `MISSING`:从没设过 → 合法的不限制;
 *   - `VALID`:照常;
 *   - `DISABLED`:用户**明确关闭**(enabled===false)→ 合法的不限制;
 *   - `INVALID`:有值但读不出/坏 JSON/形状不对 → **不是**"用户主动关闭",不得当成不限制。
 */
export type TurnBudgetStatus = "VALID" | "MISSING" | "DISABLED" | "INVALID";

export interface TurnBudgetRead {
  status: TurnBudgetStatus;
  /** 实际应生效的预算。INVALID 时回退到最后确认有效的版本(有则用,无则 undefined)。 */
  budget: TurnBudget | undefined;
  /** INVALID 且成功从 last-good 恢复出预算时为 true。 */
  recovered: boolean;
  error?: string;
}

/** 与预算设置键同目录的「最后一份确认有效的预算」备份键。 */
export function lastGoodTurnBudgetKey(key: string): string {
  return `${key}.last-good`;
}

/**
 * 尝试从 last-good 备份读出一份**有效**预算。返回 null = 没有可用备份(缺失/损坏/**不合格**);
 * 返回 `{ budget }` = 备份有效(`budget` 可能是 undefined,**仅当**备份记录的是"用户明确关闭")。
 *
 * ⚠️ 【第 38 章】必须走**同一**严格校验 `validateBudgetObject`:`enabled:true` 但无有效上限的
 * 备份**不算可恢复**(否则 `RuntimeManager` 的 `INVALID && !recovered` 拒绝闸失效,仍会无限额)。
 */
export function readLastGoodBudget(backupRaw: string | null | undefined): { budget: TurnBudget | undefined } | null {
  if (!backupRaw) return null;
  let v: TurnBudgetSetting;
  try {
    v = JSON.parse(backupRaw) as TurnBudgetSetting;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = validateBudgetObject(v);
  if (r.kind === "disabled") return { budget: undefined }; // 明确关闭 = 合法的"不限制"
  if (r.kind === "valid") return { budget: r.budget };
  // not-enabled / invalid 的备份都**不算**可信恢复源。
  return null;
}

/**
 * 【MC-083 / 第 38 章复审】预算对象的**唯一**严格校验。返回:
 *   - `{ kind: "disabled" }`:`enabled===false` → 合法的"不限制";
 *   - `{ kind: "not-enabled" }`:`enabled` 缺失或非 true → 未启用(合法,MISSING);
 *   - `{ kind: "valid", budget }`:`enabled===true` 且**至少一项严格有效上限**;
 *   - `{ kind: "invalid", why }`:`enabled===true` 但**没有任何有效上限**,或有字段**格式不合法**
 *     (`maxUsd:"x"`、`maxTurns:0.2`、`maxTotalTokens:-8` 等)—— 这**不能**悄悄降级成"不限制"。
 *
 * 关键不变量(第 38 章):`enabled:true` 却 `budget===undefined` **是不允许的状态** —— 用户
 * 启用了预算就期望有限额;一个启用状态却没有任何有效上限,只能是因为配置坏了,按 INVALID 处理,
 * 绝不静默放行成无限额。last-good 恢复也必须走这条同一函数,否则恢复出的"可恢复"仍是无限额。
 */
function validateBudgetObject(v: TurnBudgetSetting):
  | { kind: "disabled" }
  | { kind: "not-enabled" }
  | { kind: "valid"; budget: TurnBudget }
  | { kind: "invalid"; why: string } {
  if (v.enabled === false) return { kind: "disabled" };
  if (v.enabled !== true) return { kind: "not-enabled" };
  const out: TurnBudget = {};
  let anyInvalidField = false;
  const checkInt = (name: "maxTurns" | "maxTotalTokens"): void => {
    const raw = v[name];
    if (raw === undefined) return;
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1) out[name] = Math.floor(raw);
    else anyInvalidField = true; // 有值但格式不合法(0.2 / 0 / 负 / 非数)→ 记 INVALID,不静默丢
  };
  checkInt("maxTurns");
  checkInt("maxTotalTokens");
  if (v.maxUsd !== undefined) {
    if (typeof v.maxUsd === "number" && Number.isFinite(v.maxUsd) && v.maxUsd > 0) out.maxUsd = v.maxUsd;
    else anyInvalidField = true;
  }
  if (anyInvalidField) return { kind: "invalid", why: "有上限字段格式不合法(非正/非有限/非整数)" };
  if (Object.keys(out).length === 0) return { kind: "invalid", why: "启用预算却没有任何有效上限" };
  return { kind: "valid", budget: out };
}

/**
 * 【MC-083】带状态地解析轮预算。`backupRaw` 是 last-good 备份的原始值(调用方从
 * `lastGoodTurnBudgetKey` 读出)。INVALID 时有**通过同一严格校验**的备份就用备份、无备份则
 * `budget: undefined` 但 `status: "INVALID"` —— **调用方据 status 决定"拒绝自动执行/要求
 * 重新确认",而不是把 INVALID 当成合法的不限制**。
 */
export function parseTurnBudgetDetailed(raw: string | null | undefined, backupRaw?: string | null): TurnBudgetRead {
  // 从没设过 = 合法不限制。
  if (!raw) return { status: "MISSING", budget: undefined, recovered: false };
  let v: TurnBudgetSetting;
  try {
    v = JSON.parse(raw) as TurnBudgetSetting;
  } catch (err) {
    const recovered = readLastGoodBudget(backupRaw);
    return {
      status: "INVALID",
      budget: recovered ? recovered.budget : undefined,
      recovered: recovered != null,
      error: `预算配置损坏(JSON 解析失败):${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    const recovered = readLastGoodBudget(backupRaw);
    return {
      status: "INVALID",
      budget: recovered ? recovered.budget : undefined,
      recovered: recovered != null,
      error: "预算配置损坏(不是对象)",
    };
  }
  const r = validateBudgetObject(v);
  if (r.kind === "disabled") return { status: "DISABLED", budget: undefined, recovered: false };
  if (r.kind === "not-enabled") return { status: "MISSING", budget: undefined, recovered: false };
  if (r.kind === "valid") return { status: "VALID", budget: r.budget, recovered: false };
  // enabled===true 却无有效上限/字段不合法 → INVALID(有 last-good 则按同一校验恢复)。
  const recovered = readLastGoodBudget(backupRaw);
  return {
    status: "INVALID",
    budget: recovered ? recovered.budget : undefined,
    recovered: recovered != null,
    error: `预算配置无效:${r.why}`,
  };
}

/**
 * 解析失败回退链偏好（JSON 字符串数组，元素形态同 `session.model`）。坏
 * JSON / 非数组 / 没有合法字符串 → 空链（= 不回退）。元素去首尾空白。
 */
export function parseFallbackModels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map((m) => m.trim());
  } catch {
    return [];
  }
}

/**
 * 预算三判的**纯判定**部分：返回已触发的上限描述（直接进 `turn.notice`
 * 的正文），空数组 = 没有超限。比较用 `>=`：计数器恰好到达上限即停 ——
 * 预算是"最多允许"，不是"超过才管"。日期敏感的副作用（emit / interrupt /
 * 防重入闸）留在 RuntimeManager.enforceBudget 里。
 */
export function budgetViolations(
  budget: TurnBudget,
  turns: number,
  usd: number,
  tokens: number,
): string[] {
  const reasons: string[] = [];
  if (budget.maxTurns !== undefined && turns >= budget.maxTurns) {
    reasons.push(`回合数 ${turns}/${budget.maxTurns}`);
  }
  if (budget.maxUsd !== undefined && usd >= budget.maxUsd) {
    reasons.push(`花费 $${usd.toFixed(2)}/$${budget.maxUsd.toFixed(2)}`);
  }
  if (budget.maxTotalTokens !== undefined && tokens >= budget.maxTotalTokens) {
    reasons.push(`Token ${tokens}/${budget.maxTotalTokens}`);
  }
  return reasons;
}
