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
 * 它们随**那次对话第一轮**的运行提示词进主节点,一次 —— 之后它已经在上下文里,不再
 * 重复。注入点在 `orchestration/runner.ts` 的 `startWorkflowRun`(拼法见
 * `main/lib/searchPrefs.ts` 的 `nodeCriteriaPrompt`)。这里只负责工作流的**正文**:
 * 提示词型工作流的说明文字。图型工作流没有正文(流程在节点里),解析出来是空,提供方
 * 拿到的就是 `undefined`。
 */
import { getWorkflowPrompt } from "./library.js";

/**
 * 这次对话实际要追加的片段。没有流程(或流程没有提示词)时返回 `undefined`,
 * 调用方据此不传这个字段。
 */
export function resolveWorkflowPrompt(workflowId: string): string | undefined {
  return getWorkflowPrompt(workflowId) || undefined;
}

/**
 * 「这个对话是谁」—— 从会话行上那份**档案快照**取出来的角色提示词。
 *
 * ## 为什么也在 host 拼,而且是每轮
 *
 * 与工作流同一条路(`runtimeState.workflowPrompt` → 提供方只 append 一个字符串):
 * 解析放在 host,提供方不查表。**每轮都带**是刻意的 —— 只拼第一轮的话,第二轮它就不知道
 * 自己是谁了,而用户看到的是"它怎么忘了"。这正是节点那边「入口节点才发指令」不能照搬的
 * 地方:节点是一个步骤,对话是一个**持续的身份**。
 *
 * ## 为什么从会话行读,而不是现读档案
 *
 * 会话行上那份是**建会话那一刻**抄下来的快照(`lib/sessionAgentProfile.ts` 的文件头解释了
 * 为什么不是每轮回读档案)。所以改了档案,已经开出去的对话不跟着变 —— 那是**选定的**行为,
 * 不是这里漏读了一次文件。
 *
 * 内容只有 `instruction` 一段:**档案里的能力参数(技能 / MCP / 模型 / 记忆开关)是节点
 * 才用得到的**,会话这一侧不需要 —— 会话自己有模型、有权限、有工作流,再叠一份就是把
 * 同一个东西管两遍。
 *
 * 空串返回 `undefined`,调用方据此不传。不编一句默认角色顶上:那会让"没有角色"伪装成
 * "有一个没用的角色"。
 */
export function resolveAgentPrompt(
  agentProfile: { instruction: string } | null | undefined,
): string | undefined {
  const text = agentProfile?.instruction?.trim() ?? "";
  return text.length > 0 ? text : undefined;
}
