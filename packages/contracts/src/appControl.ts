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
    }
  | { op: "send"; sessionId: string; prompt: string; workflowId?: string; background?: boolean }
  | { op: "interrupt"; sessionId: string }
  | { op: "open_file"; path: string; line?: number }
  | { op: "open_settings"; section?: string }
  | { op: "close_settings" }
  | { op: "panel"; panel: AppUiPanel; open: boolean; tab?: AppUiRightTab }
  | { op: "open_url"; url: string }
  | { op: "notify"; title: string; body?: string; kind?: "info" | "warning" | "error" }
  | { op: "set_pref"; key: AppUiPrefKey; value: string | number };

export interface AppUiReply {
  ok: boolean;
  error?: string;
  data?: unknown;
}
