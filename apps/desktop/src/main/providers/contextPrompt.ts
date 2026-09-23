/**
 * Provider-neutral per-turn context sections.
 *
 * Host resolves the actual strings; providers only choose the backend-native
 * system/developer-instruction channel. Keeping the ordering here prevents
 * Claude / Pi / Codex from slowly drifting apart as new context layers land.
 */
import type { StartTurnRequest } from "@contracts/provider";

type TurnContextRequest = Pick<
  StartTurnRequest,
  "envPrompt" | "memoryPrompt" | "agentPrompt" | "workflowPrompt"
>;

/**
 * Lowest-priority background first, current workflow last.
 *
 * `envPrompt` 放**最前** —— 它是"我在什么机器上、有哪些项目和文档"这种最底层的
 * 背景事实。排在记忆/角色/工作流之前,模型读到后面那些时已经知道自己处在什么环境里。
 */
export function turnContextSections(req: TurnContextRequest): string[] {
  return [req.envPrompt, req.memoryPrompt, req.agentPrompt, req.workflowPrompt]
    .map((value) => value?.trim() ?? "")
    .filter((value) => value.length > 0);
}
