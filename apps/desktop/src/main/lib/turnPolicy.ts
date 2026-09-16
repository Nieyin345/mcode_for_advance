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
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as TurnBudgetSetting;
    if (!v || typeof v !== "object" || v.enabled !== true) return undefined;
    const out: TurnBudget = {};
    if (typeof v.maxTurns === "number" && Number.isFinite(v.maxTurns) && v.maxTurns > 0) {
      out.maxTurns = Math.floor(v.maxTurns);
    }
    if (typeof v.maxUsd === "number" && Number.isFinite(v.maxUsd) && v.maxUsd > 0) {
      out.maxUsd = v.maxUsd;
    }
    if (typeof v.maxTotalTokens === "number" && Number.isFinite(v.maxTotalTokens) && v.maxTotalTokens > 0) {
      out.maxTotalTokens = Math.floor(v.maxTotalTokens);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
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
