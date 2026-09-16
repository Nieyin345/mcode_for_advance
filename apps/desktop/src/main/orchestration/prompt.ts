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
 * ## 「文献检索」为什么在这里多拼一段
 *
 * 检索流程还要带上用户在输入框下方**筛选条**上设的固定条件(时间范围 / 期刊层次 /
 * 影响因子 / 每源条数)。那些是"一贯的习惯",在界面上选一次就一直在,不该每轮在对话
 * 里再问一遍 —— 所以直接拼进系统提示词(见 `main/lib/searchPrefs.ts`)。
 *
 * ⚠️ 这个 id 是**硬编码**的:筛选条目前只挂在检索这一个流程上。将来工作流应该能在
 * 设置里自己声明"我要读哪些设置",那时这段特例要改成一份声明,而不是继续加 `if`。
 */
import { getWorkflowPrompt } from "./library.js";
import { joinPromptSections } from "@main/lib/systemPrompt.js";
import { searchCriteriaPrompt } from "@main/lib/searchPrefs.js";
import { log } from "@main/lib/logger.js";

/** 检索流程的 id —— 只有它会额外拼上筛选条那几条固定条件。 */
const SEARCH_WORKFLOW_ID = "search";

/**
 * 这次对话实际要追加的片段。没有流程(或流程没有提示词)时返回 `undefined`,
 * 调用方据此不传这个字段。
 */
export function resolveWorkflowPrompt(workflowId: string): string | undefined {
  const flow = getWorkflowPrompt(workflowId);

  let criteria: string | undefined;
  if (workflowId === SEARCH_WORKFLOW_ID) {
    try {
      criteria = searchCriteriaPrompt();
    } catch (err) {
      // 读设置失败不该把整轮打掉 —— 少一段条件,检索照样能做。与过去 provider 里
      // 那段 try/catch 同一个理由。
      log.warn(`search criteria prompt failed: ${(err as Error).message}`);
    }
  }

  // 用同一个 `joinPromptSections`(两段之间放空行)。过去这两段是分别 push 进
  // 提供方的 `appends` 再由它拼的;现在先在这里拼好、再由提供方拼一次 ——
  // 因为拼接是"空行分隔"的,结果**逐字相同**。
  return joinPromptSections(flow ?? "", criteria ?? "") || undefined;
}
