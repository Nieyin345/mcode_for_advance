/**
 * 工具审批闸门 —— **一套规则,两处使用**。
 *
 * ## 为什么它得单独一个文件
 *
 * 同一条规矩("哪些工具不用问用户")本来只活在 Claude 那条通路上(canUseTool 里的
 * `shouldAutoApprove`)。网页端那条通路一开,就有**第二处**要判同一件事 —— 而两处
 * 各写一遍的判据一定会在下次加只读工具时漂移,漂移的方向还总是"一边忘了加",也就是
 * 悄悄多弹一次审批、或者悄悄少弹一次。少弹的那次是安全边界,不能靠自觉。
 *
 * 所以这里只放**判定**:名字清单 + 纯函数。闸门的执行(怎么弹、怎么等用户点)各家自己
 * 做 —— Claude 那边是 SDK 的 canUseTool 回调,网页那边是 `webToolHost` 走
 * `ApprovalBridge`(与界面上那些审批卡**同一条**链路,见那个文件头)。
 *
 * ## 两种名字
 *
 * 同一个工具,两条通路上**名字不一样**:
 *
 *   - Claude 那条:`canUseTool` 给的是 SDK 组装过的 `mcp__mcode-library__library_search`
 *     —— 带 server 前缀,所以判定时必须**前缀一起对上**:只按裸名匹配的话,第三方
 *     MCP 服务器暴露一个同名工具就会被白白放行;
 *   - 网页那条:浏览器里的扩展是标准 MCP 客户端,`tools/call` 里带的是**裸名**
 *     (`library_search`),没有前缀可言。
 *
 * 于是导出两个入口:`shouldAutoApprove`(带前缀的)与 `isReadOnlyToolName`(裸名的)。
 * 底下是同一份清单。
 */
import type { PermissionMode } from "@contracts/runtime";
import {
  AGENT_EDIT_TOOLS,
  AGENT_MCP_SERVER,
  AGENT_READONLY_TOOLS,
} from "@main/mcp/agentTools.js";
import { LIBRARY_MCP_SERVER, LIBRARY_READONLY_TOOLS } from "@main/mcp/libraryServer.js";
import { WORKFLOW_MCP_SERVER, WORKFLOW_READONLY_TOOLS } from "@main/mcp/mcodeServer.js";

/** Tools that mutate files on disk — auto-approved under `acceptEdits`
 *  mode without prompting the user. Mirrors Claude Code's own grouping. */
export const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The MCP server name under which the browser tools are registered (via
 *  `createSdkMcpServer` in `ClaudeAgentSdkProvider`). The SDK surfaces each tool
 *  to canUseTool as `mcp__<server>__<tool>`.
 *
 *  浏览器 server 本身建在那个 provider 里(它的工具要用到 cwd / turnNumber 那些
 *  每轮才有的东西),但**它的名字**得在这儿:闸门要用它去认前缀。 */
export const BROWSER_MCP_SERVER = "mcode-browser";
export const BROWSER_MCP_PREFIX = `mcp__${BROWSER_MCP_SERVER}__`;

/** Read-only browser tools (can't mutate the page, navigate, or submit) —
 *  auto-approved in every mode, like the Pi provider's MCODE_BROWSER_READONLY
 *  set. scroll/wait/find are pure reading aids; save_pdf writes only into the
 *  managed artifacts dir with sanitized names (same class as screenshot's
 *  best-effort save). The side-effecting navigate/click/type/keys/select/
 *  upload_file/history/close_tab go through approval. */
export const BROWSER_READONLY_SUFFIXES = new Set([
  "browser_list",
  "browser_snapshot",
  "browser_screenshot",
  "browser_find",
  "browser_scroll",
  "browser_wait",
  "browser_switch_tab",
  "browser_save_pdf",
  "browser_downloads",
]);

/**
 * server 名 → 它的只读工具名。**唯一的一份清单。**
 *
 * 各 server 自己的只读集合定义在它们自己那份文件里(mcodeServer / libraryServer /
 * agentTools 的文件头都解释了分档的理由)—— 这里只是把索引建起来,让"按名字判"这件事
 * 有个落点。加新 server 时,在这里挂一行。
 */
const READONLY_BY_SERVER: Record<string, ReadonlySet<string>> = {
  [BROWSER_MCP_SERVER]: BROWSER_READONLY_SUFFIXES,
  [LIBRARY_MCP_SERVER]: LIBRARY_READONLY_TOOLS,
  [WORKFLOW_MCP_SERVER]: WORKFLOW_READONLY_TOOLS,
  [AGENT_MCP_SERVER]: AGENT_READONLY_TOOLS,
};

/** `mcp__<server>__<tool>` 拆成两半。不是这个形状的(内置的 Read / Edit 等)返回 null。 */
const MCP_TOOL_NAME_RE = /^mcp__(.+?)__(.+)$/;

/**
 * 这个工具名是不是 **mcode 自己那几个 server** 里的只读工具?
 *
 * 两个入口共用它:`shouldAutoApprove` 先拆前缀再问,网页那条通路直接把裸名交进来 ——
 * 所以传进来的名字**必须是裸名**(前缀由调用方拆掉)。
 *
 * 名字在几个 server 之间是唯一的(库里一律 `library_` / `templates_` 开头,工作流一律
 * `workflow_` / `node_` / `agent_profile` 开头,浏览器一律 `browser_` 开头,agent 工具一律
 * `agent_` 开头但不含 `agent_profile`),所以这里不必再问"是哪个 server 的"。
 */
export function isReadOnlyToolName(bareName: string): boolean {
  for (const set of Object.values(READONLY_BY_SERVER)) {
    if (set.has(bareName)) return true;
  }
  return false;
}

/** 带前缀的那一份判定 —— 见文件头"两种名字"。 */
function isReadOnlyNamespacedTool(toolName: string): boolean {
  const matched = MCP_TOOL_NAME_RE.exec(toolName);
  if (!matched) return false;
  return READONLY_BY_SERVER[matched[1]]?.has(matched[2]) ?? false;
}

/**
 * Decide whether a tool should be auto-approved (skip the prompt) based on
 * the session's CURRENT permission mode. This runs in canUseTool on every
 * call, so a mid-turn mode flip applies to the next tool immediately.
 *  - bypassPermissions / dontAsk → everything auto-approved
 *  - acceptEdits                  → file-editing tools auto-approved
 *  - default / plan / auto        → prompt the user (return false)
 */
export function shouldAutoApprove(mode: PermissionMode | undefined, toolName: string): boolean {
  if (!mode) return false;
  if (mode === "bypassPermissions" || mode === "dontAsk") return true;
  // 只读的那三类(浏览器 / 文献库 / 工作流)从来不问 —— 它们改不了任何东西。
  if (isReadOnlyNamespacedTool(toolName)) return true;
  if (mode === "acceptEdits") return FILE_EDIT_TOOLS.has(toolName);
  return false;
}

/**
 * 网页那条通路的同一问 —— 名字是裸的(见文件头)。
 *
 * 与 `shouldAutoApprove` 分开写,是因为两边对 `acceptEdits` 的回答不同:claude 那条
 * 对 SDK 内置的 Edit / Write 放行;网页这条没有那些内置工具,但有自己的文件改写工具
 * (`agent_write_file` / `agent_edit_file`)—— 同样只在 `acceptEdits` 档免问,其余档
 * 照旧弹审批卡。`agent_bash` 永远不在自动放行之列(用户点过"始终允许"的除外,那是
 * 闸门执行层的事,见 webToolHost)。合成一个函数再传两种名字形状进来,只会让那张
 * "哪些模式放行哪些工具"的表在两个形状之间打结。
 */
export function shouldAutoApproveWebTool(mode: PermissionMode | undefined, bareName: string): boolean {
  if (!mode) return false;
  if (mode === "bypassPermissions" || mode === "dontAsk") return true;
  if (isReadOnlyToolName(bareName)) return true;
  if (mode === "acceptEdits" && AGENT_EDIT_TOOLS.has(bareName)) return true;
  return false;
}