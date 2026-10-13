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
import { z } from "zod";

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

/* ───────────────────── OperationResult(ARC-009)───────────────────── */

/**
 * **一次控制命令的结果,按"业务是否真的落定"分类,而不是按"有没有报错文本"分类。**
 *
 * ## 为什么必须有这一个结构(它在补哪个洞)
 *
 * 从前 `app_api_call` 只有成功/失败两态。RPC **已经执行成功**之后,那句 UI 刷新通知
 * (`notifyAppSettingWrite`)一旦抛错,就被 `return fail("操作已完成,但桌面刷新通知失败…")`
 * ——**返回给 Agent 的是失败**,可数据副作用已经落定。Agent 按 fail 重试一个非幂等操作
 * (发消息 / 建资源),就会**重复执行**。(ARC-009 的具体路径,源码可确认。)
 *
 * 根因:把 Command(改变事实)与 Projection/Notify(提醒界面刷新)塞进了同一个 try/fail。
 * 通知是**提交之后**的一件独立事,它失败不该逆转一次已确认的业务提交;反过来,持久化
 * 未确认也绝不能标成成功。
 *
 * ## 五个 `resultKind` 的判据(一句一条)
 *
 *   - `SUCCEEDED`            业务已落定,后续一切正常。**要不要重试都行**(幂等)。
 *   - `SUCCEEDED_WITH_WARNINGS` 业务已落定,但**提交后的某一步**(通常是界面刷新通知)
 *     失败了。**绝不当失败**:失败会把 Agent 推去重复执行。`warnings` 里必须是**可观测**
 *     的原因,不能吞掉异常报一句"成功"。
 *   - `REJECTED`             命令**根本没执行**(方法不存在 / 审批被拒 / 只读模式 / 密钥键
 *     前置拦截 / 没有审批通道)。没有副作用,可安全重试或改条件重来。
 *   - `FAILED`               命令执行途中失败,且**能确定没有落定**(如只读方法取值失败)。
 *     可安全重试。
 *   - `UNCERTAIN`            命令途中断了,且**无法确定副作用有没有落定**(如写档 fsync
 *     失败、多步操作中途抛错)。**绝不标成功**,也**绝不默认安全重试**(`retryable=false`),
 *     否则非幂等操作会被重复执行。
 *
 * ## 两个字段是给谁看的
 *
 *   - `structuredContent.operation_result`(SDK 那条路的模型读字段);
 *   - 同一份结果格式化出的**文本**(所有 SDK 都读的那行字)。
 * 两者是同一件事实的两种投影,别只更新一边。
 *
 * ⚠️ **本切片的已知残余**(如实记录,不假称已经做全):
 *   1. `durableRevision` 目前一律**缺省** —— 把内存提交与 fsync 成功绑成一个版本号要改
 *      `store/db.ts` 的持久化协议,不在本切片允许改动的文件面内(尚未做)。
 *   2. `operationId` 的**跨进程**去重**已建**(MC-067):`main/store/operationLedger.ts` 的
 *      sql.js durable 账本,`main/index.ts` 启动时装上;**同进程**由 `appControl/operations.ts`
 *      的内存版兜底。本切片只对 `app_api_call` 这一条垂直切片生效 —— `app_session_new/send`、
 *      `app_workflow_run`、桌面 IPC、手机 RPC 与三 SDK 工具**尚未**都接唯一账本(见 MC-067 验收矩阵)。
 */
export const OperationResultKindSchema = z.enum([
  "SUCCEEDED",
  "SUCCEEDED_WITH_WARNINGS",
  "REJECTED",
  "FAILED",
  "UNCERTAIN",
]);
export type OperationResultKind = z.infer<typeof OperationResultKindSchema>;

/** 一条**可观测**的警告(不是被吞掉的异常)。`retryable` 指"这条警告对应的补救能否靠重试"。 */
export const OperationWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export type OperationWarning = z.infer<typeof OperationWarningSchema>;

/** 这次操作碰到的资源身份(便于跨端对账"到底改了哪一条")。 */
export const OperationResourceSchema = z.object({
  kind: z.string(),
  id: z.string(),
});
export type OperationResource = z.infer<typeof OperationResourceSchema>;

export const OperationResultSchema = z.object({
  resultKind: OperationResultKindSchema,
  /** 这次操作的幂等键。宿主为每次调用生成一个;Agent 若要重试同一件事,应原样带回来。 */
  operationId: z.string(),
  /** 被调用的方法名(如 `setting.set`)—— 跨端对账用,别只报一个布尔。 */
  method: z.string(),
  /** 整条操作要不要重试。**已提交的非幂等操作一律 false。** */
  retryable: z.boolean(),
  /** 落盘版本 / 时间戳。**当前一律缺省**(见上面残余说明,尚未接持久化协议)。 */
  durableRevision: z.string().optional(),
  warnings: z.array(OperationWarningSchema).default([]),
  resources: z.array(OperationResourceSchema).default([]),
  /** REJECTED / FAILED / UNCERTAIN 的原因(SUCCEEDED 系列为空)。 */
  reason: z.string().optional(),
  /** 稳定的机器可判短码(如 `method_not_found` / `approval_denied` / `rpc_failed`)。 */
  code: z.string().optional(),
});
export type OperationResult = z.infer<typeof OperationResultSchema>;

/** 界面刷新通知失败(业务已提交)这条 warning 的稳定短码。 */
export const OP_WARNING_UI_REFRESH_FAILED = "ui_refresh_failed";

/** 稳定结果短码 —— 桌面 / 手机 / 三个 SDK 判据一致,别各写各的字符串。 */
export const OP_CODE = {
  methodNotFound: "method_not_found",
  notRegistered: "method_not_registered",
  blocked: "blocked",
  policyDenied: "policy_denied",
  approvalDenied: "approval_denied",
  secretKeyRefused: "secret_key_refused",
  rpcFailed: "rpc_failed",
  rpcUncertain: "rpc_uncertain",
  /** 幂等键太长(模型自选 id 上限)。 */
  operationIdTooLong: "operation_id_too_long",
  /** 同一个 operationId 被复用在一个**不同意图**的请求上 —— 绝不回放旧成功。 */
  operationIdConflict: "operation_id_conflict",
  /** 同一个 operationId 的相同意图**正在执行中**(或上一进程领了没结算)。 */
  operationInProgress: "operation_in_progress",
  /** 幂等领取**无法同步落盘**(磁盘只读 / fsync 失败)—— 拒绝执行,绝不谎报已 durable。
   *  见 `store/operationLedger.ts` 的 begin:领取 CLAIMED 之后、允许外部副作用之前必须先
   *  真正 durable,失败即回滚内存里的这次领取并回这个码。 */
  claimNotDurable: "claim_not_durable",
  /** 业务层明确拒绝(如 `{ok:false,error}`,不是抛异常)—— 命令没执行。 */
  domainRejected: "domain_rejected",
  /** 乐观并发修订号对不上(ARC-001 步③:`ActionContext.expectedRevision`)—— 调用方要复用
   *  的那条会话空壳已经不是它读到的那一版。**什么都没执行**(没建行、没复用、没发首条),
   *  可安全重来:重新读取当前状态、合并后再试。判据见 `lib/sessionStart.ts` 的
   *  `SessionRevisionConflictError`。 */
  revisionConflict: "revision_conflict",
  /** 计划级授权句柄核不过(ARC-001 步④:`ActionContext.permissionGrant`)—— 调用方带来的
   *  `grantId` 不存在 / 已撤销 / 已过期 / 不覆盖这次动作(方法不在授权表内、或目标项目与授权
   *  钉住的资源不符)。**什么都没执行**(没建行、没复用、没发首条),属**没执行,可安全重来**
   *  (重取一枚有效授权再来)。判据见 `appServices/sessionCommands.ts` 的
   *  `SessionGrantRefusedError`。 */
  grantRefused: "grant_refused",
} as const;

/** 成功系列(业务已落定)—— 这两个 `resultKind` 都不该让 Agent 当成"失败去重试"。 */
export function isOperationCommitted(kind: OperationResultKind): boolean {
  return kind === "SUCCEEDED" || kind === "SUCCEEDED_WITH_WARNINGS";
}

/* ───────────────────── OperationIntent / OperationRecord(MC-067)───────────────────── */

/**
 * **一次控制命令的「意图身份」** —— 由**宿主**产生,模型只能自选其中的 `operationId`。
 *
 * ## 它在补哪个洞(源码可确认的旧行为)
 *
 * 旧 `operationLog` 是一个 `Map<operationId, 已提交结果>`,**只按 operationId 字符串**
 * 缓存:换会话 / 换方法 / 换参数复用同一个 id,B 不执行也能拿到 A 的成功回执;两个并发
 * 请求都能穿过缓存各执行一次;RPC 抛错后同 id 再试仍会真调一次。根因是把「幂等」简化成了
 * 「结束后按字符串缓存」,缺一个**可信的请求身份**。
 *
 * ## 每个字段是谁给的
 *
 * - `ownerId` / `sessionId` / `sceneId` —— **宿主**(调用方)给的,模型**不能自报**。
 *   授权范围与资源边界按它判 —— 这正是「别的会话不能拿同一 id 领我这单」的依据。
 * - `method` + `requestDigest` —— 方法名 + 请求参数的**规范化摘要**。同 id 换方法 / 换参数
 *   = 变了一个意图 → 必须 `OPERATION_ID_CONFLICT`,绝不回放旧成功。
 * - `grantRevision` —— 记录当时授权档(当前权限模式等),供审计;授权是否已撤销由**每次
 *   重放都重走审批闸**保证,不靠它在摘要里把它「冻住」。
 * - `effectKind` —— 只读 / 有副作用。有副作用的重试绝不能盲发。
 * - `operationId` —— **模型唯一可自选**的字段(幂等键)。宿主限制它的字节长度。
 */
export const OPERATION_ID_MAX_BYTES = 200;

export const OperationEffectKindSchema = z.enum(["readonly", "mutating"]);
export type OperationEffectKind = z.infer<typeof OperationEffectKindSchema>;

/** 一条操作的执行状态。`CLAIMED` / `RUNNING` 表示**已在执行中**(在途)。 */
export const OperationStatusSchema = z.enum([
  "CLAIMED",
  "RUNNING",
  "SUCCEEDED",
  "SUCCEEDED_WITH_WARNINGS",
  "REJECTED",
  "FAILED",
  "UNCERTAIN",
]);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;

export interface OperationIntent {
  operationId: string;
  /** 授权主体(宿主给的调用会话)。模型不能自报。 */
  ownerId: string;
  sessionId: string;
  /** 场景标识(如 `app_api_call`),供跨端对账。 */
  sceneId: string;
  /** 被调用的方法名。 */
  method: string;
  /** 请求参数的**规范化摘要**(同方法同参数的稳定指纹)。 */
  requestDigest: string;
  effectKind: OperationEffectKind;
  /** 当时授权档(当前权限模式等)。审计用;不参与意图指纹。 */
  grantRevision: string;
}

/** 账本里的一条记录 = 意图 + 状态(+ 结算后的完整结果,供同主体重放)。 */
export interface OperationRecord extends OperationIntent {
  status: OperationStatus;
  /**
   * 结算后的**完整结果**。在途(CLAIMED / RUNNING)时缺席。它是同主体(owner+session+
   * method+摘要)幂等重放的唯一依据 —— **绝不跨项目 / 跨会话向别的 Agent 复述**。
   */
  result?: OperationResult;
  /** 已提交成功时的结果正文(仅供同主体幂等重放)。 */
  body?: string;
  updatedAt: number;
}


/**
 * 把结构化结果格式化成**人能读、Agent 能读**的一段文本。所有 SDK 共用这一份 ——
 * 文本与 `structuredContent.operation_result` 是同一件事实的两种投影。
 *
 * `SUCCEEDED` 不带任何状态行(保持旧的"纯返回值"文案,不惊扰既有断言 / 既有阅读习惯);
 * 其余四态各带一行判据 + 警告 / 原因。UNCERTAIN 额外点一句"不要盲目重试"。
 */
export function formatOperationResult(r: OperationResult): string {
  const warnLines = r.warnings.map(
    (w) => `  ⚠️ ${w.message}${w.retryable ? "(可重试)" : "(不要凭重试解决)"}`,
  );
  switch (r.resultKind) {
    case "SUCCEEDED":
      return "";
    case "SUCCEEDED_WITH_WARNINGS":
      return [
        `操作已完成(${r.method},operationId=${r.operationId});但有 ${r.warnings.length} 条警告:`,
        ...warnLines,
        "业务副作用**已经提交**,不要因为上面的警告重复执行这次操作。",
      ].join("\n");
    case "REJECTED":
      return `操作未执行(${r.method}):${r.reason ?? "被拒绝"}`;
    case "FAILED":
      return `操作失败(${r.method}):${r.reason ?? "未知原因"}`;
    case "UNCERTAIN":
      return [
        `操作结果不确定(${r.method},operationId=${r.operationId}):${r.reason ?? "无法确认是否已提交"}`,
        ...warnLines,
        "业务副作用**是否已落定无法确认** —— 不要盲目重试(重试可能重复执行);请先查一次真实状态再决定。",
      ].join("\n");
  }
}
