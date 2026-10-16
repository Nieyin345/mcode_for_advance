/**
 * Pi 引擎的**浏览器工具注册**（从 `mcodeExtension.ts` 拆出）。
 *
 * `registerBrowserTools` 是纯自足的一段：只依赖 `pi`、`deps`、`agentBrowserTools`
 * 里的那批 `browserXxx` 与 `BROWSER_TOOL_SPECS`、以及 `typebox` 的 `Type`。
 * 拆出来是为了让「浏览器工具怎么接进 Pi」单独可读。
 * **纯搬迁，函数体逐字节一致。**
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProviderContext } from "@contracts/provider";
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
  type ToolResult,
} from "@main/browser/agentBrowserTools.js";
import { toolTextOf } from "@main/mcp/sdk.js";

/**
 * Register the `browser_*` tools that drive the app's embedded browser (the
 * same `BrowserManager` `WebContentsView` the browser panel uses). The actual
 * operations live in `agentBrowserTools.ts` (shared with the Claude provider);
 * here we only define the typebox parameter schemas + bridge screenshots to
 * `ctx.emit` so the renderer can render them inline.
 *
 * Read-only tools (list/snapshot/screenshot) are auto-approved by the
 * `tool_call` guard (see `MCODE_BROWSER_READONLY`); `navigate`/`click` have
 * side effects and go through the normal approval prompt.
 */
export function registerBrowserTools(
  pi: ExtensionAPI,
  deps: { ctx: ProviderContext; sessionId: string; projectPath: string; turnNumber?: number },
): void {
  const { ctx, sessionId, projectPath, turnNumber } = deps;

  // Convert a shared ToolResult into Pi's execute() return shape. They're
  // structurally identical (content[] + details), so this is effectively an
  // identity — but spelling it out keeps the return type tied to ToolResult's
  // TextBlock|ImageBlock union, which satisfies Pi's (TextContent|ImageContent)[].
  const toPiResult = (r: ToolResult) => ({
    content: r.content,
    details: (r.details ?? {}) as Record<string, unknown>,
  });

  pi.registerTool({
    name: "browser_list",
    label: "Browser List",
    description: BROWSER_TOOL_SPECS.browser_list.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_list.promptSnippet,
    parameters: Type.Object({}),
    async execute() {
      return toPiResult(browserList(projectPath));
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: BROWSER_TOOL_SPECS.browser_navigate.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_navigate.promptSnippet,
    parameters: Type.Object({
      url: Type.String({ description: "目标 URL,http(s):// 网页或 file:/// 本地文件" }),
      browserId: Type.Optional(
        Type.String({ description: "目标浏览器视图 id;省略则自动复用当前目标视图或新建" }),
      ),
      device: Type.Optional(
        Type.Union(
          [
            Type.Literal("desktop"),
            Type.Literal("iphone"),
            Type.Literal("android"),
          ],
          { description: "打开方式:desktop(PC 全宽,默认)/iphone(移动端)/android(移动端),仅新建视图时生效" },
        ),
      ),
      newTab: Type.Optional(Type.Boolean({ description: "true=强制新开一个标签页再导航" })),
    }),
    async execute(_toolCallId, params) {
      const { url, browserId, device, newTab } = params as {
        url: string;
        browserId?: string;
        device?: "desktop" | "iphone" | "android";
        newTab?: boolean;
      };
      return toPiResult(await browserNavigate({ url, browserId, device, newTab }, projectPath));
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: BROWSER_TOOL_SPECS.browser_snapshot.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_snapshot.promptSnippet,
    parameters: Type.Object({
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { browserId } = params as { browserId?: string };
      return toPiResult(await browserSnapshot({ browserId, projectPath }));
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: BROWSER_TOOL_SPECS.browser_click.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_click.promptSnippet,
    parameters: Type.Object({
      index: Type.Optional(Type.Number({ description: "要点击元素的索引(来自最近一次 browser_snapshot 的 [n]),优先使用" })),
      selector: Type.Optional(Type.String({ description: "要点击元素的 CSS selector(index 的替代写法)" })),
      coordinateX: Type.Optional(Type.Number({ description: "视口坐标点击的 X(canvas 等无 selector 元素用)" })),
      coordinateY: Type.Optional(Type.Number({ description: "视口坐标点击的 Y" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { index, selector, coordinateX, coordinateY, browserId } = params as {
        index?: number;
        selector?: string;
        coordinateX?: number;
        coordinateY?: number;
        browserId?: string;
      };
      return toPiResult(await browserClick({ index, selector, coordinateX, coordinateY, browserId, projectPath }));
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Browser Type",
    description: BROWSER_TOOL_SPECS.browser_type.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_type.promptSnippet,
    parameters: Type.Object({
      index: Type.Optional(Type.Number({ description: "目标输入元素的索引(来自最近一次 browser_snapshot),优先使用" })),
      selector: Type.Optional(Type.String({ description: "目标输入元素的 CSS selector(index 的替代写法)" })),
      text: Type.String({ description: "要输入的文本内容;空串=清空字段" }),
      clear: Type.Optional(Type.Boolean({ description: "true(默认)=清空后输入;false=追加" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { index, selector, text, clear, browserId } = params as {
        index?: number;
        selector?: string;
        text: string;
        clear?: boolean;
        browserId?: string;
      };
      return toPiResult(await browserType({ index, selector, text, clear, browserId, projectPath }));
    },
  });

  pi.registerTool({
    name: "browser_keys",
    label: "Browser Keys",
    description: BROWSER_TOOL_SPECS.browser_keys.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_keys.promptSnippet,
    parameters: Type.Object({
      keys: Type.String({ description: '按键或组合键,如 "Enter" / "Escape" / "Control+a" / "Shift+Enter"' }),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { keys, browserId } = params as { keys: string; browserId?: string };
      return toPiResult(await browserKeys({ keys, browserId, projectPath }));
    },
  });

  pi.registerTool({
    name: "browser_scroll",
    label: "Browser Scroll",
    description: BROWSER_TOOL_SPECS.browser_scroll.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_scroll.promptSnippet,
    parameters: Type.Object({
      direction: Type.Union([Type.Literal("up"), Type.Literal("down")], { description: "滚动方向" }),
      pages: Type.Optional(Type.Number({ description: "滚动量(单位=视口高,默认 1;10≈滚到底)" })),
      selector: Type.Optional(Type.String({ description: "改为滚动该元素内部的滚动区" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { direction, pages, selector, browserId } = params as {
        direction: "up" | "down";
        pages?: number;
        selector?: string;
        browserId?: string;
      };
      return toPiResult(await browserScroll({ direction, pages, selector, browserId, projectPath }));
    },
  });

  pi.registerTool({
    name: "browser_wait",
    label: "Browser Wait",
    description: BROWSER_TOOL_SPECS.browser_wait.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_wait.promptSnippet,
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "等待该 CSS selector 元素出现" })),
      text: Type.Optional(Type.String({ description: "等待该文本出现在页面中" })),
      seconds: Type.Optional(Type.Number({ description: "固定等待秒数" })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "等待超时(默认 10,上限 30)" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { selector, text, seconds, timeoutSeconds, browserId } = params as {
        selector?: string;
        text?: string;
        seconds?: number;
        timeoutSeconds?: number;
        browserId?: string;
      };
      return toPiResult(await browserWait({ selector, text, seconds, timeoutSeconds, browserId, projectPath }));
    },
  });

  pi.registerTool({
    name: "browser_history",
    label: "Browser History",
    description: BROWSER_TOOL_SPECS.browser_history.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_history.promptSnippet,
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload")],
        { description: "后退/前进/刷新" },
      ),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { action, browserId } = params as { action: "back" | "forward" | "reload"; browserId?: string };
      return toPiResult(await browserHistory({ action, browserId, projectPath }));
    },
  });

  pi.registerTool({
    name: "browser_select",
    label: "Browser Select",
    description: BROWSER_TOOL_SPECS.browser_select.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_select.promptSnippet,
    parameters: Type.Object({
      index: Type.Optional(Type.Number({ description: "下拉框元素的索引(来自最近一次 browser_snapshot),优先使用" })),
      selector: Type.Optional(Type.String({ description: "下拉框元素的 CSS selector(index 的替代写法)" })),
      value: Type.String({ description: "选项的 value 或精确可见文本" }),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { index, selector, value, browserId } = params as {
        index?: number;
        selector?: string;
        value: string;
        browserId?: string;
      };
      return toPiResult(await browserSelect({ index, selector, value, browserId, projectPath }));
    },
  });

  pi.registerTool({
    name: "browser_find",
    label: "Browser Find",
    description: BROWSER_TOOL_SPECS.browser_find.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_find.promptSnippet,
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "按 CSS 查询元素(与 text 二选一)" })),
      text: Type.Optional(Type.String({ description: "在页面文本中搜索(与 selector 二选一)" })),
      regex: Type.Optional(Type.Boolean({ description: "text 按正则解释(默认字面)" })),
      caseSensitive: Type.Optional(Type.Boolean({ description: "区分大小写(默认不区分)" })),
      contextChars: Type.Optional(Type.Number({ description: "文本匹配的上下文字符数(默认 150)" })),
      maxResults: Type.Optional(Type.Number({ description: "最多返回条数(默认 25)" })),
      attributes: Type.Optional(Type.Array(Type.String(), { description: 'selector 模式下要提取的属性,如 ["href","src"]' })),
      cssScope: Type.Optional(Type.String({ description: "把查找范围限定在该 CSS selector 内" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { selector, text, regex, caseSensitive, contextChars, maxResults, attributes, cssScope, browserId } =
        params as {
          selector?: string;
          text?: string;
          regex?: boolean;
          caseSensitive?: boolean;
          contextChars?: number;
          maxResults?: number;
          attributes?: string[];
          cssScope?: string;
          browserId?: string;
        };
      return toPiResult(
        await browserFind({ selector, text, regex, caseSensitive, contextChars, maxResults, attributes, cssScope, browserId, projectPath }),
      );
    },
  });

  pi.registerTool({
    name: "browser_switch_tab",
    label: "Browser Switch Tab",
    description: BROWSER_TOOL_SPECS.browser_switch_tab.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_switch_tab.promptSnippet,
    parameters: Type.Object({
      browserId: Type.String({ description: "要切换到的浏览器视图 id(browser_list 查询)" }),
    }),
    async execute(_toolCallId, params) {
      const { browserId } = params as { browserId: string };
      return toPiResult(await browserSwitchTab({ browserId, projectPath }));
    },
  });

  pi.registerTool({
    name: "browser_close_tab",
    label: "Browser Close Tab",
    description: BROWSER_TOOL_SPECS.browser_close_tab.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_close_tab.promptSnippet,
    parameters: Type.Object({
      browserId: Type.String({ description: "要关闭的浏览器视图 id" }),
    }),
    async execute(_toolCallId, params) {
      const { browserId } = params as { browserId: string };
      return toPiResult(await browserCloseTab({ browserId, projectPath }));
    },
  });

  pi.registerTool({
    name: "browser_upload_file",
    label: "Browser Upload File",
    description: BROWSER_TOOL_SPECS.browser_upload_file.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_upload_file.promptSnippet,
    parameters: Type.Object({
      index: Type.Optional(Type.Number({ description: "文件输入框元素的索引(来自最近一次 browser_snapshot),优先使用" })),
      selector: Type.Optional(Type.String({ description: '文件输入框元素的 CSS selector(index 的替代写法)' })),
      paths: Type.Array(Type.String(), { description: "要上传的本地文件路径数组(绝对路径,或相对项目根的路径)" }),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { index, selector, paths, browserId } = params as {
        index?: number;
        selector?: string;
        paths: string[];
        browserId?: string;
      };
      return toPiResult(await browserUploadFile({ index, selector, paths, browserId }, projectPath));
    },
  });

  pi.registerTool({
    name: "browser_save_pdf",
    label: "Browser Save PDF",
    description: BROWSER_TOOL_SPECS.browser_save_pdf.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_save_pdf.promptSnippet,
    parameters: Type.Object({
      fileName: Type.Optional(Type.String({ description: "保存的文件名(不含路径;省略则按时间戳命名)" })),
      paperFormat: Type.Optional(
        Type.Union(
          [
            Type.Literal("letter"),
            Type.Literal("legal"),
            Type.Literal("tabloid"),
            Type.Literal("a3"),
            Type.Literal("a4"),
            Type.Literal("a5"),
          ],
          { description: "纸张格式,默认 a4" },
        ),
      ),
      landscape: Type.Optional(Type.Boolean({ description: "横向(默认纵向)" })),
      printBackground: Type.Optional(Type.Boolean({ description: "是否打印背景色/图(默认 true)" })),
      scale: Type.Optional(Type.Number({ description: "缩放 0.1-2(默认 1)" })),
      headerFooter: Type.Optional(Type.Boolean({ description: "显示页眉页脚(默认 false)" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { fileName, paperFormat, landscape, printBackground, scale, headerFooter, browserId } = params as {
        fileName?: string;
        paperFormat?: string;
        landscape?: boolean;
        printBackground?: boolean;
        scale?: number;
        headerFooter?: boolean;
        browserId?: string;
      };
      return toPiResult(
        await browserSavePdf(
          { fileName, paperFormat, landscape, printBackground, scale, headerFooter, browserId, projectPath },
          { toolCallId: _toolCallId, sessionId, turnNumber },
        ),
      );
    },
  });

  pi.registerTool({
    name: "browser_downloads",
    label: "Browser Downloads",
    description: BROWSER_TOOL_SPECS.browser_downloads.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_downloads.promptSnippet,
    parameters: Type.Object({}),
    async execute() {
      return toPiResult(browserDownloads());
    },
  });

  pi.registerTool({
    name: "browser_evaluate",
    label: "Browser Evaluate",
    description: BROWSER_TOOL_SPECS.browser_evaluate.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_evaluate.promptSnippet,
    parameters: Type.Object({
      script: Type.String({ description: "要在页面中执行的 JavaScript 代码(可访问 document/window 等页面对象)" }),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { script, browserId } = params as { script: string; browserId?: string };
      return toPiResult(await browserEvaluate({ script, browserId, projectPath }));
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: BROWSER_TOOL_SPECS.browser_screenshot.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_screenshot.promptSnippet,
    parameters: Type.Object({
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
      fullPage: Type.Optional(Type.Boolean({ description: "true=截整页(含滚动外内容)" })),
    }),
    async execute(toolCallId, params) {
      const { browserId, fullPage } = params as { browserId?: string; fullPage?: boolean };
      const r = await browserScreenshot({ browserId, fullPage, projectPath }, {
        toolCallId,
        sessionId,
        turnNumber,
        onImage: (info) => {
          // Emit a structured event so the renderer attaches an inline image
          // block (Pi path). Claude's image surfacing happens via the
          // tool_result content instead.
          ctx.emit({
            type: "browser.image",
            sessionId,
            toolCallId: info.toolCallId,
            data: info.data,
            mimeType: info.mimeType,
          });
        },
      });
      return toPiResult(r);
    },
  });
}