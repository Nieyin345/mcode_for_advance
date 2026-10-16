import { randomUUID } from "node:crypto";
import { BROWSER_MCP_SERVER } from "@main/providers/toolGate.js";
import { z } from "zod";
import type { ProviderContext } from "@contracts/provider";
import { loadCreateMcpServer } from "@main/mcp/sdk.js";
import {
  browserList,
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserType,
  browserKeys,
  browserScroll,
  browserWait,
  browserHistory,
  browserSelect,
  browserFind,
  browserSwitchTab,
  browserCloseTab,
  browserUploadFile,
  browserSavePdf,
  browserDownloads,
  browserEvaluate,
  browserScreenshot,
  BROWSER_TOOL_SPECS,
  BROWSER_TOOLS_FLOW,
} from "@main/browser/agentBrowserTools.js";

/**
 * Claude 引擎的**浏览器 MCP server 构造**（从 `ClaudeAgentSdkProvider.ts` 拆出）。
 *
 * `buildBrowserMcpServer` 只依赖 `agentBrowserTools` 那批 `browserXxx`、`z`、
 * `randomUUID`、`loadCreateMcpServer` —— 对 provider 类零引用。**纯搬迁，函数体逐字节一致。**
 */
/**
 * Build the in-process MCP server that exposes the `browser_*` tools to
 * Claude (the SDK equivalent of Pi's `pi.registerTool`). Each tool's handler
 * delegates to the shared `agentBrowserTools` implementation so both
 * providers drive the browser identically.
 *
 * Claude surfaces each tool to canUseTool as `mcp__mcode-browser__<name>`;
 * the read-only ones (list/snapshot/screenshot) are auto-approved by
 * `shouldAutoApprove`, while navigate/click go through the normal approval
 * prompt. Screenshots return an image content block that the store parses
 * from the tool_result to render inline.
 */
export async function buildBrowserMcpServer(
  projectPath: string,
  ctx: ProviderContext,
  sessionId: string,
  turnNumber?: number,
) {
  const createSdkMcpServer = await loadCreateMcpServer();

  return createSdkMcpServer({
    name: BROWSER_MCP_SERVER,
    version: "1.0.0",
    instructions:
      "Mcode 应用内浏览器控制工具。" + BROWSER_TOOLS_FLOW,
    alwaysLoad: true,
    tools: [
      {
        name: "browser_list",
        description: BROWSER_TOOL_SPECS.browser_list.description,
        inputSchema: {},
        handler: async () => browserList(projectPath),
      },
      {
        name: "browser_navigate",
        description: BROWSER_TOOL_SPECS.browser_navigate.description,
        inputSchema: {
          url: z.string().describe("目标 URL,http(s):// 网页或 file:/// 本地文件"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则自动复用当前目标视图或新建"),
          device: z
            .enum(["desktop", "iphone", "android"])
            .optional()
            .describe("打开方式:desktop(PC 全宽,默认)/iphone(移动端)/android(移动端),仅新建视图时生效"),
          newTab: z.boolean().optional().describe("true=强制新开一个标签页再导航"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserNavigate(
            {
              url: args.url as string,
              browserId: args.browserId as string | undefined,
              device: args.device as "desktop" | "iphone" | "android" | undefined,
              newTab: args.newTab === true,
            },
            projectPath,
          ),
      },
      {
        name: "browser_snapshot",
        description: BROWSER_TOOL_SPECS.browser_snapshot.description,
        inputSchema: {
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSnapshot({ browserId: args.browserId as string | undefined, projectPath }),
      },
      {
        name: "browser_click",
        description: BROWSER_TOOL_SPECS.browser_click.description,
        inputSchema: {
          index: z.number().optional().describe("要点击元素的索引(来自最近一次 browser_snapshot 的 [n]),优先使用"),
          selector: z.string().optional().describe("要点击元素的 CSS selector(index 的替代写法)"),
          coordinateX: z.number().optional().describe("视口坐标点击的 X(canvas 等无 selector 元素用)"),
          coordinateY: z.number().optional().describe("视口坐标点击的 Y"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserClick({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            coordinateX: typeof args.coordinateX === "number" ? args.coordinateX : undefined,
            coordinateY: typeof args.coordinateY === "number" ? args.coordinateY : undefined,
            browserId: args.browserId as string | undefined,
            projectPath,
          }),
      },
      {
        name: "browser_type",
        description: BROWSER_TOOL_SPECS.browser_type.description,
        inputSchema: {
          index: z.number().optional().describe("目标输入元素的索引(来自最近一次 browser_snapshot),优先使用"),
          selector: z.string().optional().describe("目标输入元素的 CSS selector(index 的替代写法)"),
          text: z.string().describe("要输入的文本内容;空串=清空字段"),
          clear: z.boolean().optional().describe("true(默认)=清空后输入;false=追加到现有内容之后"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserType({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: typeof args.text === "string" ? args.text : "",
            clear: args.clear !== false,
            browserId: args.browserId as string | undefined,
            projectPath,
          }),
      },
      {
        name: "browser_keys",
        description: BROWSER_TOOL_SPECS.browser_keys.description,
        inputSchema: {
          keys: z.string().describe('按键或组合键,如 "Enter" / "Escape" / "Tab" / "ArrowDown" / "Control+a" / "Shift+Enter"'),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserKeys({
            keys: typeof args.keys === "string" ? args.keys : "",
            browserId: args.browserId as string | undefined,
            projectPath,
          }),
      },
      {
        name: "browser_scroll",
        description: BROWSER_TOOL_SPECS.browser_scroll.description,
        inputSchema: {
          direction: z.enum(["up", "down"]).describe("滚动方向"),
          pages: z.number().optional().describe("滚动量(单位=视口高,默认 1;10≈滚到底)"),
          selector: z.string().optional().describe("改为滚动该元素内部的滚动区"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserScroll({
            direction: args.direction === "up" ? "up" : "down",
            pages: typeof args.pages === "number" ? args.pages : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            browserId: args.browserId as string | undefined,
            projectPath,
          }),
      },
      {
        name: "browser_wait",
        description: BROWSER_TOOL_SPECS.browser_wait.description,
        inputSchema: {
          selector: z.string().optional().describe("等待该 CSS selector 元素出现"),
          text: z.string().optional().describe("等待该文本出现在页面中"),
          seconds: z.number().optional().describe("固定等待秒数"),
          timeoutSeconds: z.number().optional().describe("等待超时(默认 10,上限 30)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserWait({
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: typeof args.text === "string" ? args.text : undefined,
            seconds: typeof args.seconds === "number" ? args.seconds : undefined,
            timeoutSeconds: typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : undefined,
            browserId: args.browserId as string | undefined,
            projectPath,
          }),
      },
      {
        name: "browser_history",
        description: BROWSER_TOOL_SPECS.browser_history.description,
        inputSchema: {
          action: z.enum(["back", "forward", "reload"]).describe("后退/前进/刷新"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserHistory({
            action: args.action as "back" | "forward" | "reload",
            browserId: args.browserId as string | undefined,
            projectPath,
          }),
      },
      {
        name: "browser_select",
        description: BROWSER_TOOL_SPECS.browser_select.description,
        inputSchema: {
          index: z.number().optional().describe("下拉框元素的索引(来自最近一次 browser_snapshot),优先使用"),
          selector: z.string().optional().describe("下拉框元素的 CSS selector(index 的替代写法)"),
          value: z.string().describe("选项的 value 或精确可见文本"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSelect({
            index: typeof args.index === "number" ? args.index : undefined,
            selector: typeof args.selector === "string" ? args.selector : undefined,
            value: typeof args.value === "string" ? args.value : "",
            browserId: args.browserId as string | undefined,
            projectPath,
          }),
      },
      {
        name: "browser_find",
        description: BROWSER_TOOL_SPECS.browser_find.description,
        inputSchema: {
          selector: z.string().optional().describe("按 CSS 查询元素(与 text 二选一)"),
          text: z.string().optional().describe("在页面文本中搜索(与 selector 二选一)"),
          regex: z.boolean().optional().describe("text 按正则解释(默认字面)"),
          caseSensitive: z.boolean().optional().describe("区分大小写(默认不区分)"),
          contextChars: z.number().optional().describe("文本匹配的上下文字符数(默认 150)"),
          maxResults: z.number().optional().describe("最多返回条数(默认 25)"),
          attributes: z.array(z.string()).optional().describe('selector 模式下要提取的属性,如 ["href","src"]'),
          cssScope: z.string().optional().describe("把查找范围限定在该 CSS selector 内"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserFind({
            selector: typeof args.selector === "string" ? args.selector : undefined,
            text: typeof args.text === "string" ? args.text : undefined,
            regex: args.regex === true,
            caseSensitive: args.caseSensitive === true,
            contextChars: typeof args.contextChars === "number" ? args.contextChars : undefined,
            maxResults: typeof args.maxResults === "number" ? args.maxResults : undefined,
            attributes: Array.isArray(args.attributes) ? (args.attributes as unknown[]).filter((a): a is string => typeof a === "string") : undefined,
            cssScope: typeof args.cssScope === "string" ? args.cssScope : undefined,
            browserId: args.browserId as string | undefined,
            projectPath,
          }),
      },
      {
        name: "browser_switch_tab",
        description: BROWSER_TOOL_SPECS.browser_switch_tab.description,
        inputSchema: {
          browserId: z.string().describe("要切换到的浏览器视图 id(browser_list 查询)"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSwitchTab({ browserId: args.browserId as string, projectPath }),
      },
      {
        name: "browser_close_tab",
        description: BROWSER_TOOL_SPECS.browser_close_tab.description,
        inputSchema: {
          browserId: z.string().describe("要关闭的浏览器视图 id"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserCloseTab({ browserId: args.browserId as string, projectPath }),
      },
      {
        name: "browser_upload_file",
        description: BROWSER_TOOL_SPECS.browser_upload_file.description,
        inputSchema: {
          index: z.number().optional().describe("文件输入框元素的索引(来自最近一次 browser_snapshot),优先使用"),
          selector: z.string().optional().describe('文件输入框元素的 CSS selector(index 的替代写法)'),
          paths: z.array(z.string()).describe("要上传的本地文件路径数组(绝对路径,或相对项目根的路径)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserUploadFile(
            {
              index: typeof args.index === "number" ? args.index : undefined,
              selector: typeof args.selector === "string" ? args.selector : undefined,
              paths: args.paths,
              browserId: args.browserId as string | undefined,
            },
            projectPath,
          ),
      },
      {
        name: "browser_save_pdf",
        description: BROWSER_TOOL_SPECS.browser_save_pdf.description,
        inputSchema: {
          fileName: z.string().optional().describe("保存的文件名(不含路径;省略则按时间戳命名)"),
          paperFormat: z.enum(["letter", "legal", "tabloid", "a3", "a4", "a5"]).optional().describe("纸张格式,默认 a4"),
          landscape: z.boolean().optional().describe("横向(默认纵向)"),
          printBackground: z.boolean().optional().describe("是否打印背景色/图(默认 true)"),
          scale: z.number().optional().describe("缩放 0.1-2(默认 1)"),
          headerFooter: z.boolean().optional().describe("显示页眉页脚(默认 false)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserSavePdf(
            {
              fileName: typeof args.fileName === "string" ? args.fileName : undefined,
              paperFormat: typeof args.paperFormat === "string" ? args.paperFormat : undefined,
              landscape: args.landscape === true,
              printBackground: args.printBackground !== false,
              scale: typeof args.scale === "number" ? args.scale : undefined,
              headerFooter: args.headerFooter === true,
              browserId: args.browserId as string | undefined,
              projectPath,
            },
            {
              toolCallId: randomUUID(),
              sessionId,
              turnNumber,
            },
          ),
      },
      {
        name: "browser_downloads",
        description: BROWSER_TOOL_SPECS.browser_downloads.description,
        inputSchema: {},
        handler: async () => browserDownloads(),
      },
      {
        name: "browser_evaluate",
        description: BROWSER_TOOL_SPECS.browser_evaluate.description,
        inputSchema: {
          script: z.string().describe("要在页面中执行的 JavaScript 代码(可访问 document/window 等页面对象)"),
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
        },
        handler: async (args: Record<string, unknown>) =>
          browserEvaluate({
            script: args.script as string,
            browserId: args.browserId as string | undefined,
            projectPath,
          }),
      },
      {
        name: "browser_screenshot",
        description: BROWSER_TOOL_SPECS.browser_screenshot.description,
        inputSchema: {
          browserId: z.string().optional().describe("目标浏览器视图 id;省略则用当前目标视图"),
          fullPage: z.boolean().optional().describe("true=截整页(含滚动外内容)"),
        },
        handler: async (args: Record<string, unknown>) => {
          // The returned image content block flows back to the model via the
          // SDK and is also surfaced to the user: the claude binary round-
          // trips the tool_result content (including the image) back as a user
          // message, which SdkMessageAdapter transparently forwards as a
          // ToolResultEvent; the store then extracts the image (in Anthropic
          // {source:{data,media_type}} or MCP {data,mimeType} form) and
          // attaches an inline image block. No separate browser.image emit is
          // needed here — unlike the Pi path, the toolCallId isn't available
          // in the MCP handler's extra, so we rely solely on the tool_result.
          return browserScreenshot(
            { browserId: args.browserId as string | undefined, fullPage: args.fullPage === true, projectPath },
            {
              toolCallId: randomUUID(),
              sessionId,
              turnNumber,
            },
          );
        },
      },
    ],
  });
}
