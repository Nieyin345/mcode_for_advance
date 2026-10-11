/**
 * **mcode-app** —— 本地 agent(Claude / Codex / Pi)控制 Mcode 本身的那组工具。
 *
 * 两半:
 *   - 主进程那半(`main/appControl/`):把全部 RPC 功能按权限表开放给 agent;
 *   - 界面那半(`renderer/lib/appControlHost.ts`):切对话、开文件、开面板、像用户一样发消息
 *     —— 这些状态只在渲染端的 store 里,主进程经 `executeJavaScript` 调过去。
 *
 * 这个文件只放两边都要认的常量和指令形状。
 */

/** 进程内 MCP server 名(Claude 侧看到的是 `mcp__mcode-app__<工具名>`)。 */
export const APP_MCP_SERVER = "mcode-app";

/**
 * 高风险操作的审批卡 `toolName` 前缀。带这个前缀的卡:
 *   - 界面不显示「始终允许」(`ApprovalPrompt`);
 *   - 主进程 `ApprovalBridge` 也**不记**始终允许 —— 就算有客户端硬传 `always: true`。
 * 每次都得用户本人点。
 */
export const APP_DANGER_APPROVAL_PREFIX = "mcode-app-danger:";

/** 渲染端挂在 `window` 上的入口名。主进程 `executeJavaScript` 调它。 */
export const APP_CONTROL_RENDERER_GLOBAL = "__mcodeAppControl";

export type AppUiPanel = "left" | "right" | "terminal" | "browser";

/**
 * 一个自定义面板在**屏幕上的矩形**(CSS 像素,相对主窗口视口左上角)—— 面板截图要用的那块。
 *
 * 它**不是**面板内部坐标(那是 `customUiPanel` 的 `layout.viewport/content`),而是面板那个
 * iframe 元素此刻落在窗口上的位置,由 `PanelFrame` 用 `getBoundingClientRect()` 量。全仓无
 * `zoomFactor`,所以 CSS px == DIP,可直接当 `webContents.capturePage(rect)` 的参数。
 */
export interface PanelCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 右栏页签(与 `RightPanelTabSchema` 一致,这里不 import 以免把 zod 拖进来)。 */
export type AppUiRightTab = "files" | "git" | "browser" | "turns" | "preview" | "flow" | "tasks";

/** 能经 `set_pref` 改的界面偏好(都是用户在界面上能直接点的那些)。 */
export type AppUiPrefKey = "locale" | "themeStyle" | "displayMode" | "chatFontSize" | "chatDensity" | "workflowId" | "permissionMode";

export type AppUiCommand =
  | { op: "state" }
  | { op: "open_session"; sessionId: string }
  | { op: "select_project"; projectId: string }
  | {
      op: "new_session";
      projectId?: string;
      providerId?: string;
      model?: string;
      prompt?: string;
      workflowId?: string;
      /** true = 建完(并发完第一条)切回原来那个对话,不把用户的视线带走。 */
      background?: boolean;
      /** 给新对话起个标题(不必等自动标题生成)。省略则用默认占位,之后按会话标题
       *  生成的设置自动起名。 */
      title?: string;
    }
  | { op: "send"; sessionId: string; prompt: string; workflowId?: string; background?: boolean }
  | { op: "interrupt"; sessionId: string }
  | { op: "open_file"; path: string; line?: number }
  | { op: "open_settings"; section?: string }
  | { op: "close_settings" }
  | { op: "panel"; panel: AppUiPanel; open: boolean; tab?: AppUiRightTab }
  | { op: "open_url"; url: string }
  | { op: "notify"; title: string; body?: string; kind?: "info" | "warning" | "error" }
  | { op: "set_pref"; key: AppUiPrefKey; value: string | number }
  /**
   * 读回一个正在渲染的自定义面板的**渲染结果**(报告 E10)。面板在沙箱 iframe 里(opaque
   * origin),外面读不到它的 DOM —— 由面板自己读、经 `PanelFrame` 的桥回话。`itemId`
   * 省略 = 读当前最该读的那个(浮窗 > 设置页预览 > 右栏页签)。
   */
  | { op: "read_panel"; itemId?: string }
  /**
   * 打开一个**已保存的**自定义面板(报告 E10 的自验闭环):像用户右键那样弹浮窗。面板先
   * 得在配置里(`customUi.config.v1`),这里只负责打开。配合 `read_panel` 就能
   * 「开 → 读 → 看渲染成什么样」。喂的是按挂载位造的样例目标(不碰真实资料库)。
   */
  | { op: "open_panel"; itemId: string }
  /**
   * 量一个正在渲染的面板的**屏幕矩形**(报告 Q1 的截图诉求,第一半)。由宿主 `PanelFrame`
   * 用 `getBoundingClientRect()` 量它那个 iframe 元素 —— 面板自己(沙箱 iframe 内)量不到自
   * 己在**窗口**里的位置,而截图恰恰要的是这个。
   *
   * 为什么单开一条 op、而不是把矩形塞进 `read_panel` 的 `PanelProbeReply`:那个 reply 是
   * **面板自己**发的消息(文本 / HTML / 版式都是面板脚本读自己 DOM 得来的),而矩形必须由
   * **宿主**(可信侧)量 —— 把宿主量的几何混进面板自治的 reply 会糊掉信任边界(恶意面板能
   * 伪造它)。截图也只需要矩形、不需要那几百 KB 的文本 / HTML,单开一条更省。
   *
   * `itemId` 省略 = 与 `read_panel` 同一口径(浮窗 > 预览 > 页签)。`data.rect` 为 null
   * 表示量不到(面板还没布局好 / 没挂着)。
   */
  | { op: "panel_rect"; itemId?: string };

export interface AppUiReply {
  ok: boolean;
  error?: string;
  data?: unknown;
}
