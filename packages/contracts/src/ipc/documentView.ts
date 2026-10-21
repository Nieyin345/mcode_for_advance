/**
 * 【ARC-007】**受控文档视图宿主（WebContentsView）** 的 IPC 契约。
 *
 * ## 它是什么
 *
 * GenOffice 的编辑器页面（Docs/Sheets/Slides/Markdown/PDF）在 Mcode 里不是 React 组件，
 * 而是一个叠在主窗口上的 OS 级视图（与浏览器面板同一种载体，语义不同）。渲染端只拿
 * 一个 `docId`，量好占位矩形后把像素 bounds 发下来；视图的创建/定位/显隐/销毁全在主进程
 * （`main/document/documentViewHost.ts`）。这一份是那条边界的**唯一**形状来源。
 *
 * ## 为什么 URL 校验写进契约注释（真正的闸在主进程）
 *
 * 台账 ARC-007 的判据是「CSP 自限、离线自足」：文档视图**不加载远程内容**。这里的
 * schema 只保证"字段类型对"，**不**做 URL 白名单 —— 白名单必须由主进程逐次复核，
 * 因为渲染端/Agent 递进来的字符串一律不可信（与路径围栏同一条纪律）。主进程只放行
 * `file://`（repo 内 GenOffice 快照的编辑器页）与本机回环 `http(s)://127.0.0.1|localhost`，
 * 其余一律 fail-closed。
 *
 * ## bounds 为什么钉成整数并封顶
 *
 * 这些数字直接进 `WebContentsView.setBounds()`，是 OS 层的像素矩形。小数会让
 * Electron 的 DIP 换算出现半像素抖动；负数/0 尺寸是一个不可见的视图（用户以为
 * "打开失败了"）；超大值是渲染端算错时最可能的形状，放任它会分配一块巨大的合成面。
 * 16384 对 8K 屏也绰绰有余，超过它基本可以确定是 bug 而不是真实布局。
 */
import { z } from "zod";

/* ── 通道常量 ──
 * 字符串本体钉在这里（与 `_CHANNEL` 系列同一种写法），IPC 表只引用、不重写第二份 ——
 * 改一处而另一处静默漂移是这套表最典型的坏法。 */
export const DOCUMENT_VIEW_OPEN_CHANNEL = "documentView:open";
/** 【ARC-007】请求把某个文档载入已打开的视图（渲染端 → 主进程）。
 *
 *  为什么需要:视图里是**编辑器起始页**,不请求打开就永远空白。路径围栏在主进程
 *  （`findContainingWorkspaceRoot` 那一份),渲染端只表达"想打开哪个文件"。 */
export const DOCUMENT_VIEW_OPEN_PATH_CHANNEL = "documentView:openPath";
export const DOCUMENT_VIEW_BOUNDS_CHANNEL = "documentView:bounds";
export const DOCUMENT_VIEW_SHOW_CHANNEL = "documentView:show";
export const DOCUMENT_VIEW_HIDE_CHANNEL = "documentView:hide";
export const DOCUMENT_VIEW_FOCUS_CHANNEL = "documentView:focus";
export const DOCUMENT_VIEW_CLOSE_CHANNEL = "documentView:close";
export const DOCUMENT_VIEW_LIST_CHANNEL = "documentView:list";

/** `docId` 由宿主（未来的 DocumentSessionRegistry）分配；这里只限形状，不猜来源。 */
const DocIdSchema = z.string().min(1).max(200);

/** 窗口坐标系（DIP）里的像素矩形，与 `BrowserRect` 同一空间。 */
export const DocViewRectSchema = z.object({
  x: z.number().int().min(0).max(16384),
  y: z.number().int().min(0).max(16384),
  width: z.number().int().min(1).max(16384),
  height: z.number().int().min(1).max(16384),
});
export type DocViewRect = z.infer<typeof DocViewRectSchema>;

/**
 * `documentView:open` 的入参。
 *
 * `visible=false` 也合法（提前建好视图、等面板真正展开再 show）—— 隐藏视图保活是
 * 文档面板切标签时不丢编辑状态的机制，不是可选优化。
 *
 * ## `workflowEngineId`：编辑器页的凭据由**宿主注入**，令牌不出主进程
 *
 * 【ARC-006 Gate A 缺口】第三方工作流引擎（Node-RED）的编辑器页走 Admin API 时会
 * 要求 `Authorization: Bearer <宿主令牌>`；把令牌拼进 `url`（`?access_token=`）等于
 * 让令牌进入 `workflowEngine.list/status` 这类 Agent 可读的快照，**不行**。
 * 这里的字段只表达「这个视图加载的是该引擎的编辑器页」；真正的令牌由主进程从
 * 引擎数据目录读取，经 `session.webRequest.onBeforeSendHeaders` 按
 * `webContentsId + 回环 origin` 注入 —— 令牌不经过渲染端、不进 URL、不进快照、
 * 不落日志。绑定与过期判据在 `main/document/documentViewCredentialBroker.ts`。
 *
 * 省略该字段 = 普通文档视图（GenOffice 页），宿主不注入任何凭据。
 */
export const DocViewOpenSchema = z.object({
  docId: DocIdSchema,
  /** `file://`（GenOffice 快照的编辑器页）或本机回环 http(s)；主进程复核，见文件头。 */
  url: z.string().min(1).max(4096),
  bounds: DocViewRectSchema,
  visible: z.boolean(),
  /** 工作流引擎 id（`[a-z][a-z0-9-]*`，与 `workflowEngine.*` 同一套形状）。 */
  workflowEngineId: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/).optional(),
  /** 【ARC-007 P1/GA1】编辑器域。`"slides"` = 这个视图是演示文稿页：宿主对它的
   *  `openPath` 走 **vendor 解析器**（`slides:open-path` 同一份实现），字节与
   *  一次性 handoff 仍由宿主发出；页面拿到的 `OpenResult` 由
   *  `slidesBridge` 的执行器构造，页面**不接触任意路径**。
   *
   *  省略 = 普通文档视图（docs 语义），现有调用方行为不变。 */
  editor: z.enum(["slides", "pdf", "markdown", "html"]).optional(),
  /** Vendor factory 的初始路径，只给 pdf/markdown/html；主进程先过物理工作区围栏。 */
  filePath: z.string().min(1).max(4096).optional(),
  /** T05c: the Mcode shell's selected conversation at view creation; never
   * accepted as an approval grant or a provider override. Main validates
   * this session against the actual opened document's workspace. */
  mcodeSessionId: z.string().min(1).max(200).optional(),
});
export type DocViewOpenInput = z.infer<typeof DocViewOpenSchema>;

/** `documentView:openPath` 的入参。`filePath` 由主进程过围栏后才交给页面。 */
export const DocViewOpenPathSchema = z.object({
  docId: DocIdSchema,
  filePath: z.string().min(1).max(4096),
}).strict();
export type DocViewOpenPathInput = z.infer<typeof DocViewOpenPathSchema>;

/** `documentView:bounds` 的入参：只改几何，不动 URL/可见性。 */
export const DocViewBoundsSchema = z.object({
  docId: DocIdSchema,
  bounds: DocViewRectSchema,
});
export type DocViewBoundsInput = z.infer<typeof DocViewBoundsSchema>;

/** 只带 `docId` 的输入：show / hide / focus / close 四者同形，各写一份没有信息量。 */
export const DocViewDocIdSchema = z.object({ docId: DocIdSchema });
/** `close` 的契约名（任务书点名的 schema）；与 show/hide/focus 用的是同一份形状。 */
export const DocViewCloseSchema = DocViewDocIdSchema;
export type DocViewCloseInput = z.infer<typeof DocViewCloseSchema>;

/**
 * 一次视图操作的结果。`reason` 是**给人/模型看的句子**（拒绝 URL、主窗口未就绪、
 * docId 不存在……），不是异常原文 —— 与 browser 域的 `{ok,error}` 同一条取向。
 */
export type DocViewResult = { ok: true } | { ok: false; reason: string };

/** `documentView:list` 的一条状态快照（只读、诊断用；不含 webContents id 等内部句柄）。 */
export interface DocViewSnapshot {
  docId: string;
  /** 最近一次成功 open 的 URL（可能已经 await 过导航）。 */
  url: string;
  visible: boolean;
  bounds: DocViewRect;
  /** 【ARC-007】最近一次加载/渲染失败（成功后清空）。
   *
   *  为什么要有:vendor 编辑器页依赖 preload 桥（`window.desktop.*`），而本宿主
   *  刻意不给 preload。页面加载后会抛错、或渲染进程直接退出 —— 没有这个字段时
   *  外层只看到空白，分不清"没加载"和"加载了但崩了"。 */
  lastFailure?: { kind: "load" | "render-gone"; reason: string; at: number };
  /** 【ARC-007】最近一次**保存冲突**（保存成功后清空）。
   *
   *  为什么与 `lastFailure` 分开:页面加载失败与"页面想保存、被宿主以版本冲突
   *  拦下"是两件不同的事，混进一个字段会让诊断文案说谎。保存通道的冲突回包
   *  已经交给页面（`reason:"conflict"` + `error`），这个字段是给面板的第二条
   *  可见路径 —— 将来页面若吞掉失败原因，面板仍能从这里显示。 */
  lastSaveConflict?: {
    expectedRevision: string | null;
    currentRevision: string | null;
    message: string;
    at: number;
  };
}

/**
 * `documentView:list` 的返回。包一层对象而不是裸数组：`app_api_describe` 的清单
 * 对裸数组类型会摊成 `length/toString/...` 的数组原型字段（实测），agent 读不出
 * "这里面有什么" —— 包成具名字段后清单里直接可见 `views: DocViewSnapshot[]`。
 */
export interface DocViewListResult {
  views: DocViewSnapshot[];
}

/* ────────────────────── 【ARC-007】slides 编辑通道（A 方案第一步） ──────────────────────
 *
 * slides 渲染端的所有编辑操作都经 vendor 主进程的 session 表执行
 * （`genoffice/apps/slides/src/main/session-state.ts:50`），渲染端只持有渲染树。
 * Mcode 的最小桥因此**不照搬 vendor 全量 slidesApi**（198 个方法里有 42 个危险
 * channel，见 `docs/planning/genoffice-ai-interaction.md` 第 9 节）：这里只开
 * 两个编辑操作，经宿主 typed 通道转发到 vendor 执行器。
 *
 * 身份纪律与 open/save 完全相同：**docId 由宿主从 `event.sender`
 * 反查**（`DocumentViewHost.docIdForSender`），不是页面自行授权。
 * 真实注入 preload 不携带 docId；若旧调用方仍发送 docId，宿主必须
 * 对其作一致性校验，伪造别的 docId 一律拒绝。
 */
/** 【ARC-007】**内部通道**（与 `mcode:document-view:save` 同一形态）：只由我们注入的
 *  视图 preload 调用，不进 `RpcMap` 的 renderer 面 —— 渲染端/Agent 都没有这个入口。
 *  原因：`documentView.*` 是 `Api["documentView"]` 的完整类型面，加进 RpcMap 会
 *  强制手机端 HTTP 桥（`webApi.ts`，本片禁区）同步补条目；而 slides 编辑本来
 *  也只能发生在承载视图的桌面进程里（手机端没有 WebContentsView），走内部通道
 *  与既有 save/newDocument 一致。契约仍在此定义 schema 与结果类型（唯一形状来源）。 */
export const DOCUMENT_VIEW_SLIDES_ADD_SLIDE_CHANNEL = "mcode:document-view:slides-add-slide";
export const DOCUMENT_VIEW_SLIDES_EDIT_TEXT_CHANNEL = "mcode:document-view:slides-edit-text";
/** 【ARC-007 P1/GA1】打开链（slides）：页面用 `openPptxPath`/`consumePendingOpen`
 *  换取宿主准备好的 `OpenResult`；保存用 `save()`（宿主写回打开会话，页面不传路径）。
 *  与上面两条同一形态：**内部通道**，只由注入的视图 preload 调用。 */
export const DOCUMENT_VIEW_SLIDES_READ_OPENED_CHANNEL = "mcode:document-view:slides-read-opened";
export const DOCUMENT_VIEW_SLIDES_SAVE_CHANNEL = "mcode:document-view:slides-save";

/** `documentView:slidesAddSlide` 的入参：生产视图 preload 实际发送 `{}`。
 *  docId 是历史兼容的**可选一致性提示**，不用于授权或选择目标会话；
 *  新页位置仍由 vendor `addBlankSlide` 语义决定。 */
export const DocViewSlidesAddSlideSchema = z.object({
  docId: DocIdSchema.optional(),
  /** Original vendor AddBlankSlideOp position. Never accepts a file/session. */
  sourceIndex: z.number().int().min(0).max(100_000).optional(),
  before: z.boolean().optional(),
}).strict();
export type DocViewSlidesAddSlideInput = z.infer<typeof DocViewSlidesAddSlideSchema>;

/** `documentView:slidesEditText` 的入参。
 *
 *  - `docId`：旧调用方可选的一致性提示；生产 preload 不发送，宿主必须从 sender 识别会话；
 *  - `slideIndex`：页序号（0-based；vendor `EditTextOp.slideIndex`，`shared/ipc.ts:199`）；
 *  - `elementId`：vendor 的元素 `sourceId`（渲染树里 `RenderNode.sourceId`，
 *    由 `addElement`/读页返回）；
 *  - `text`：替换该元素的纯文本（vendor 侧会转成一个 run 的 `EditParagraph[]`）。
 *    上限 200 000 字符与 vendor 聊天存储同一条量级；超过直接拒。 */
export const DocViewSlidesEditTextSchema = z
  .object({
    docId: DocIdSchema.optional(),
    slideIndex: z.number().int().min(0).max(10_000),
    elementId: z.string().min(1).max(512),
    text: z.string().max(200_000),
  })
  .strict();
export type DocViewSlidesEditTextInput = z.infer<typeof DocViewSlidesEditTextSchema>;

/** slides 编辑通道的结果。失败时 `reason` 是给人/模型看的一句话 ——
 *  包括「vendor 主进程未装配」这种 fail-closed 情形（绝不假装成功）。 */
export type DocViewSlidesResult =
  | { ok: true; slideCount: number; slides: unknown[]; index: number }
  | ({ ok: true; text: string } & Record<string, unknown>)
  | { ok: false; reason: string };

/* ────────────────────── 【ARC-007 P1/GA1】slides 打开/保存链 ──────────────────────
 *
 * 形状来源是 vendor 的 `OpenResult`（`genoffice/apps/slides/src/shared/ipc.ts:91-98`）：
 * `{ path, slides: RenderSlide[], size: {cx,cy}, defaultFont? }`。宿主把 vendor
 * 解析器（同一份 `openPptx`/`buildAllRenderSlides` 代码，见 `slidesBridge.ts`）
 * 构造的结果**原样**交给页面 —— 契约层不重写 vendor 的形状，只把它标成
 * `unknown` 之外的具名 alias，方便调用方识别。
 *
 * `path` 只作为**标题栏显示**回给页面：页面拿它做不了任何事（保存不认路径，
 * 打开不认路径 —— 那两条都由宿主从自己的待打开/已打开记录里取）。
 */
export interface DocViewSlidesOpenResult {
  /** 宿主已过围栏的文件路径（仅显示用）。空串 = 未命名 deck。 */
  path: string;
  /** vendor `RenderSlide[]`（形状由 vendor 契约定义，见上）。 */
  slides: unknown[];
  size: { cx: number; cy: number };
  defaultFont?: string;
}

/** 【ARC-007 P1/GA1】页面拉取打开结果的回包：ok 时带 vendor `OpenResult` 形状；
 *  `hash` 是宿主对**这次打开读到的字节**算的 sha256（保存时的乐观锁基准与
 *  handoff 响应同源）。失败一律 `{ ok:false, reason }`，页面按"打开失败"处理。 */
export type DocViewSlidesReadOpenedResult =
  | { ok: true; result: DocViewSlidesOpenResult; hash: string }
  | { ok: false; reason: string };
