/**
 * 工具审批的**判定规则** —— 一张"哪些工具不用问用户"的表 + 几个纯函数。
 *
 * ## 为什么它和 `providers/toolGate.ts` 分开
 *
 * 那些判定本身**不依赖任何 provider**:它们是几个 `Set` 和三个读名字的函数。
 * 但 `toolGate.ts` 住在 `providers/` 下,而它的邻居(`ClaudeAgentSdkProvider`、
 * `pi-sdk/mcodeExtension`)都在 `providers/` 里 —— 于是**任何**想引这几个常量的
 * 地方,只要 import 路径写成 `@main/providers/toolGate.js`,esbuild 就会顺着
 * 那条链去解析整个 provider 图(插件管理、SDK、二十几个 `?raw` 的 `.py` 资源…)。
 *
 * 无头 smoke 就是这么撞上的:记忆那套要断言"`memory_write` 不在放行集里",
 * import 一次 `toolGate` 就报 `No loader is configured for ".py" files` —— 报在
 * 一个和被测逻辑毫无关系的文件上。
 *
 * 所以规则搬到这里(`mcp/` 下,与它管的那几个 server 同层)。
 *
 * ## 清单从各 server 读,不在这里重写一份
 *
 * 每个 server 的只读集定义在**它自己那个文件**里(那里连注释一起解释了为什么这几个
 * 算只读 —— 比如 `session_read_log` 放行的那段代价说明)。这里只把索引建起来。
 * 硬规矩 2:同一份清单不写两遍。
 *
 * ⚠️ **代价是:** 引这个文件会连带解析那四个 server 的依赖链。其中两条会碰到
 * electron —— `libraryServer` → `library/broadcast` → `RuntimeManager`,`memoryServer`
 * → `memory/broadcast` → `window.js`。所以**无头脚本用它时,那两个 broadcast 与
 * `window` 都要换桩**(各 smoke 的 run.sh 里已经这么做了;`mcp-endpoint-smoke` 那次
 * 是漏了 memory 那两个)。
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
 * 于是两个入口:`shouldAutoApprove`(带前缀的)与 `isReadOnlyToolName`(裸名的)。
 * 底下是同一份清单。
 */
import type { PermissionMode } from "@contracts/runtime";
import {
  AGENT_EDIT_TOOLS,
  AGENT_MCP_SERVER,
  AGENT_READONLY_TOOLS,
} from "@main/mcp/agentTools.js";
import { LIBRARY_MCP_SERVER, LIBRARY_READONLY_TOOLS } from "@main/mcp/libraryServer.js";
import { MEMORY_MCP_SERVER, MEMORY_READONLY_TOOLS } from "@main/mcp/memoryServer.js";
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
 * memoryServer / agentTools 的文件头都解释了分档的理由)—— 这里只是把索引建起来,
 * 让"按名字判"这件事有个落点。加新 server 时,在这里挂一行。
 */
const READONLY_BY_SERVER: Record<string, ReadonlySet<string>> = {
  [BROWSER_MCP_SERVER]: BROWSER_READONLY_SUFFIXES,
  [LIBRARY_MCP_SERVER]: LIBRARY_READONLY_TOOLS,
  [WORKFLOW_MCP_SERVER]: WORKFLOW_READONLY_TOOLS,
  [MEMORY_MCP_SERVER]: MEMORY_READONLY_TOOLS,
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
 * `workflow_` / `node_` / `agent_profile` / `session_` 开头,记忆一律 `memory_` 开头,
 * 浏览器一律 `browser_` 开头,agent 工具一律 `agent_` 开头但不含 `agent_profile`),
 * 所以这里不必再问"是哪个 server 的"。
 */
export function isReadOnlyToolName(bareName: string): boolean {
  for (const set of Object.values(READONLY_BY_SERVER)) {
    if (set.has(bareName)) return true;
  }
  return false;
}

/**
 * 一个工具的 MCP **annotations**(报给客户端的行为提示)。
 *
 * ## 为什么必须标
 *
 * ChatGPT 的开发者模式**靠 `readOnlyHint` 决定要不要弹确认框** —— 一个只读工具
 * 如果没标,它会**当成写工具**,每次都弹。(社区里一堆人踩过:加两个字段就好了。
 * OpenAI 的 Apps SDK 文档现在把 `readOnlyHint` / `destructiveHint` / `openWorldHint`
 * 列为 required。)
 *
 * ## 为什么不另写一份清单
 *
 * "哪些是只读"这件事**已经有唯一答案**:{@link isReadOnlyToolName}(它的底是各
 * server 自己的只读集合,见文件头)。再写一份"哪些标 readOnly"就是第二份清单,
 * 下次加工具必漂移 —— 硬规矩 2。所以这里**从它派生**。
 *
 * ## 各字段的取法
 *
 *   - `readOnlyHint`:只读就是 true。**默认值是 false**(协议故意从保守那侧来),
 *     所以写工具不用显式给 false,但给了更清楚 —— 这里都显式给。
 *   - `destructiveHint`:只读时无意义(协议说只读工具的这个字段被忽略),写工具默认
 *     **true**(协议默认值),这对我们是对的:`agent_bash` 能删库、`agent_kill_process`
 *     能杀进程,标成"可能破坏"是实话。
 *   - `idempotentHint`:只有只读工具敢说"重复调用无副作用"。写工具一律不给 —— 我们
 *     没有逐个分析过"重跑一次会不会更糟"。
 *   - `openWorldHint`:工具是否触及**外部世界**(网络/别的系统)。`agent_read_url`、
 *     SSH 那几样、浏览器那几样都要 true;纯本机文件/库操作 false。这里用名字前缀
 *     粗判 —— 判不准时**宁可 true**(把"外面"说大一点,让客户端更谨慎)。
 */
export function annotationsForTool(bareName: string): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: boolean;
} {
  const readOnly = isReadOnlyToolName(bareName);
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly,
    openWorldHint: touchesOpenWorld(bareName),
    // 只读的可以放心说"重复调用无副作用";写工具不说(没逐个分析过)。
    ...(readOnly ? { idempotentHint: true } : {}),
  };
}

/** 触及外部世界(网络 / 远程主机 / 浏览器)的工具 —— 见 {@link annotationsForTool}。 */
const OPEN_WORLD_PREFIXES = [
  "agent_ssh_",
  "agent_remote_job_",
  "agent_read_url",
  "browser_",
];

function touchesOpenWorld(bareName: string): boolean {
  return OPEN_WORLD_PREFIXES.some((p) => (p.endsWith("_") ? bareName.startsWith(p) : bareName === p));
}

/** 带前缀的那一份判定 —— 见文件头"两种名字"。 */
function isReadOnlyNamespacedTool(toolName: string): boolean {
  const matched = MCP_TOOL_NAME_RE.exec(toolName);
  if (!matched) return false;
  return READONLY_BY_SERVER[matched[1]!]?.has(matched[2]!) ?? false;
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
  // 只读的那几类(浏览器 / 文献库 / 工作流 / 记忆)从来不问 —— 它们改不了任何东西。
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
