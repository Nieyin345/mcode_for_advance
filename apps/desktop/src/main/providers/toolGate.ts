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
 * ## ⚠️ 规则本身搬去了 `@main/mcp/toolRules.js`,这里只是入口
 *
 * 2026-09-22:那张表和那几个函数放在这里,会把**整个 provider 图**拖进任何想引它的
 * 地方 —— 这个文件住在 `providers/` 下,邻居(`ClaudeAgentSdkProvider` /
 * `pi-sdk/mcodeExtension`)都在同一层,esbuild 顺着链会去解析 SDK、插件管理、二十几个
 * `?raw` 的 `.py` 资源…… 无头 smoke 只要 import 一次就报
 * `No loader is configured for ".py" files`,而报的那个文件与被测逻辑毫无关系。
 *
 * 搬走之后:**要断言的规则引 `toolRules.js`**(叶子,只依赖几个 server 的常量),
 * 要"弹不弹审批"的执行侧继续引这里 —— 既有引用路径一个都不用改(下面这些转出就是
 * 为它留的)。
 */
export {
  BROWSER_MCP_PREFIX,
  BROWSER_MCP_SERVER,
  BROWSER_READONLY_SUFFIXES,
  FILE_EDIT_TOOLS,
  isReadOnlyToolName,
  shouldAutoApprove,
  shouldAutoApproveWebTool,
} from "@main/mcp/toolRules.js";
