/**
 * 把「这次对话选的工作流」变成一段要追加的系统提示词。
 *
 * ## 为什么解析在 host,而不是在提供方
 *
 * 过去 `StartTurnRequest` 带的是 `composerMode`,由**提供方**自己去查
 * `COMPOSER_MODE_PROMPTS`。结果是只有 claude-sdk 实现了那套查表 —— Pi 与 Codex
 * 完全忽略这个字段,工作流在那边根本不生效(见 `docs/工作模式.md` 的「已知边界」)。
 *
 * 现在 host 解析好一段字符串传下去(`StartTurnRequest.workflowPrompt`),提供方只负责
 * `appends.push(...)`。三个提供方的差别因此从"要不要实现一套查表逻辑"缩小成"append
 * 一个字符串"。
 *
 * ## 固定条件(输入框上方那排下拉框)**不**在这里拼
 *
 * 它们随**运行的最初那条提示词**进主节点,一次,之后不再重复 —— 注入点在
 * `orchestration/runner.ts` 的 `startWorkflowRun`(拼法见 `main/lib/searchPrefs.ts`
 * 的 `nodeCriteriaPrompt`)。这里只负责工作流的**正文**:提示词型工作流的说明文字。
 * 图型工作流没有正文(流程在节点里),解析出来是空,提供方拿到的就是 `undefined`。
 */
import { getWorkflowPrompt } from "./library.js";

/**
 * 这次对话实际要追加的片段。没有流程(或流程没有提示词)时返回 `undefined`,
 * 调用方据此不传这个字段。
 */
export function resolveWorkflowPrompt(workflowId: string): string | undefined {
  return getWorkflowPrompt(workflowId) || undefined;
}
