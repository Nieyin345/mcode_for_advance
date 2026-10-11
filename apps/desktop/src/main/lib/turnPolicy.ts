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

/** 尝试从 last-good 备份读出一份**有效或明确关闭**的预算。返回 null = 没有可用备份
 *  (缺失/损坏);返回 `{ budget }` = 备份有效(`budget` 可能是 undefined,表示备份记录的是
 *  "用户明确关闭" —— 那也是合法的不限制,与"没有备份"必须区分开)。 */
export function readLastGoodBudget(backupRaw: string | null | undefined): { budget: TurnBudget | undefined } | null {
  if (!backupRaw) return null;
  try {
    const v = JSON.parse(backupRaw) as TurnBudgetSetting;
    if (!v || typeof v !== "object") return null;
    if (v.enabled === false) return { budget: undefined }; // 明确关闭 = 合法的不限制
    if (v.enabled !== true) return null;
    const out: TurnBudget = {};
    if (typeof v.maxTurns === "number" && Number.isFinite(v.maxTurns) && v.maxTurns >= 1) out.maxTurns = Math.floor(v.maxTurns);
    if (typeof v.maxUsd === "number" && Number.isFinite(v.maxUsd) && v.maxUsd > 0) out.maxUsd = v.maxUsd;
    if (typeof v.maxTotalTokens === "number" && Number.isFinite(v.maxTotalTokens) && v.maxTotalTokens >= 1) out.maxTotalTokens = Math.floor(v.maxTotalTokens);
    return { budget: Object.keys(out).length > 0 ? out : undefined };
  } catch {
    return null;
  }
}

/**
 * 【MC-083】带状态地解析轮预算。`backupRaw` 是 last-good 备份的原始值(调用方从
 * `lastGoodTurnBudgetKey` 读出)。INVALID 时有备份就用备份、无备份则 `budget: undefined`
 * 但 `status: "INVALID"` —— **调用方据 status 决定"拒绝自动执行/要求重新确认",而不是
 * 把 INVALID 当成合法的不限制**。
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
  // 用户**明确关闭** = 合法不限制(与"损坏"不同)。
  if (v.enabled === false) return { status: "DISABLED", budget: undefined, recovered: false };
  // enabled 缺失或非 true:旧约定上等于没开 —— 但若是"有值却没开",按 MISSING 处理(合法)。
  if (v.enabled !== true) return { status: "MISSING", budget: undefined, recovered: false };
  const out: TurnBudget = {};
  // maxTurns / maxTotalTokens 必须是 **>=1 的整数** —— 0.2 轮经 Math.floor 会变 0,
  // 而 0 不是合法预算(会立刻触顶)。只收 `>=1` 的有限整数。
  if (typeof v.maxTurns === "number" && Number.isFinite(v.maxTurns) && v.maxTurns >= 1) out.maxTurns = Math.floor(v.maxTurns);
  if (typeof v.maxUsd === "number" && Number.isFinite(v.maxUsd) && v.maxUsd > 0) out.maxUsd = v.maxUsd;
  if (typeof v.maxTotalTokens === "number" && Number.isFinite(v.maxTotalTokens) && v.maxTotalTokens >= 1) out.maxTotalTokens = Math.floor(v.maxTotalTokens);
  // 开了但三个上限一个都没有 → 没有限什么;与旧约定一致视为"无预算"(但状态仍是 VALID:配置本身合法)。
  return { status: "VALID", budget: Object.keys(out).length > 0 ? out : undefined, recovered: false };
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
