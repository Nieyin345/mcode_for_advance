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
  editor: z.enum(["slides", "sheets", "pdf", "markdown", "html"]).optional(),
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
  /** A disk-writing Mcode document tool changed the open file after this view loaded it. */
  lastExternalMutation?: {
    at: number;
    source: "document-tool" | "markdown-edit" | "document-edit";
  };
  /** 【Office 深度集成】打开的文件超过体积提示阈值时存在（不阻止打开）。
   *
   *  为什么要暴露:O18 实测一个**空白** Sheets 就要 253 MiB 工作集,几百 MB 的
   *  工作簿能把整机拖住。用户有权在打开前/后知道"这个文件很大",而不是面对一个
   *  无声卡住十分钟的编辑器。 */
  largeFileWarning?: { bytes: number; thresholdBytes: number; at: number };
}

/**
 * `documentView:list` 的返回。包一层对象而不是裸数组：`app_api_describe` 的清单
 * 对裸数组类型会摊成 `length/toString/...` 的数组原型字段（实测），agent 读不出
 * "这里面有什么" —— 包成具名字段后清单里直接可见 `views: DocViewSnapshot[]`。
 */
export interface DocViewListResult {
  views: DocViewSnapshot[];
}

/* ─────────────── 【Office 深度集成】后台视图内存治理 ───────────────
 *
 * 六个 GenOffice 编辑器同时驻留约 1.70 GiB（O18 实测），其中绝大部分是各自的
 * renderer。`hide()` 只把视图挪到屏幕外，Chromium 仍保留整页。
 *
 * 宿主提供两条**只读**事实，由渲染端（它知道用户在哪些标签之间切换）决定何时
 * 回收：哪些视图可以无损回收、以及回收前必须保存的重建凭据。销毁本身仍走既有
 * `documentView:close` —— 不加第二条"销毁"通道，避免出现两个关闭入口。
 *
 * ⚠️ 判据只认三种状态：够久没显示、页面自报干净、真的打开过文件。**脏视图永不
 * 出现在这份清单里**（销毁 = 静默丢掉未保存编辑）。
 */
export const DOCUMENT_VIEW_DORMANT_LIST_CHANNEL = "documentView:dormantList";

/** `documentView:dormantList` 的返回。 */
export interface DocViewDormantListResult {
  /** 可以**无损**回收的视图：附重建凭据，调用方存下后再 `documentView:close`。 */
  candidates: DocViewDormantSnapshot[];
  /** 本轮被排除的数量与原因（诊断用，不参与决策）。 */
  excluded: { notVisible: number; dirtyOrUnknown: number; tooRecent: number; noDocument: number };
}

/** 一个可回收视图的完整重建凭据。 */
export interface DocViewDormantSnapshot {
  docId: string;
  url: string;
  /** 原厂编辑器种类；`null` = 普通文档视图（与 `DocViewOpenInput.editor` 同集）。 */
  editor: "pdf" | "markdown" | "html" | "sheets" | "slides" | null;
  filePath: string;
  bounds: DocViewRect;
  mcodeSessionId: string | null;
  /** 隐藏了多久（毫秒），供渲染端排序与诊断。 */
  hiddenForMs: number;
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

/* ─────────────── 【Office 深度集成】修订与复核（Overleaf 式） ───────────────
 *
 * 产品决定（2026-10-27）：
 *   - 六种格式先做 **Word 与 Markdown**，其余随后；
 *   - **AI 默认开复核模式**，人可在界面上切换自己的模式；
 *   - 人和 AI 走**同一套**机制，只是**颜色不同**；
 *   - 待审改动与评论都在**左栏**（AI 对话在右栏）。
 *
 * 这些类型是**渲染端与主进程之间**的形状；主进程内部的模型见
 * `main/document/pendingChanges.ts`（多一个 `capabilities` 之类的宿主细节）。
 */

export type DocRevisionEditor = "docs" | "sheets" | "slides" | "pdf" | "markdown" | "html";

export type DocRevisionKind = "insert" | "delete" | "replace" | "format" | "move" | "structural";

export interface DocRevisionAnchor {
  kind: "block" | "cell" | "element" | "page" | "range" | "unknown";
  block?: number;
  sheet?: string;
  address?: string;
  slide?: number;
  elementId?: string;
  page?: number;
  from?: number;
  to?: number;
}

export interface DocRevisionLocation {
  /** 文档内顺序（只在同一编辑器内可比）。 */
  order: number;
  /** 给人看的定位描述，例如「第 3 段」「第 12 行」。 */
  label: string;
  anchor?: DocRevisionAnchor;
}

export interface DocRevisionAuthor {
  id: string;
  label: string;
}

/** 一条待审改动。 */
export interface DocPendingChange {
  id: string;
  batchId?: string;
  location: DocRevisionLocation;
  kind: DocRevisionKind;
  /** 摘要文本（可能被截断；**只用于显示**，不用于应用/回滚）。 */
  before?: string;
  after?: string;
  author: DocRevisionAuthor;
  at: number;
  /** 只读的改动（例如依赖实时求值）按钮要禁用并给原因。 */
  readOnlyReason?: string;
}

/** 一条评论。**resolve 不是删除** —— 移出主列表，仍可查看。 */
export interface DocRevisionComment {
  id: string;
  location: DocRevisionLocation;
  author: DocRevisionAuthor;
  text: string;
  at: number;
  replies: Array<{ id: string; author: DocRevisionAuthor; text: string; at: number }>;
  resolved: boolean;
}

/** 一个文档的复核状态 —— 左栏的数据源。 */
export interface DocRevisionState {
  editor: DocRevisionEditor;
  filePath: string;
  /** `review` = AI 的改动变成待审条目；`edit` = 直接生效。 */
  mode: "edit" | "review";
  changes: DocPendingChange[];
  comments: DocRevisionComment[];
}

export const DOC_VIEW_REVISION_STATE_CHANNEL = "documentView:revisionState";
export const DOC_VIEW_REVISION_DECIDE_CHANNEL = "documentView:revisionDecide";
export const DOC_VIEW_REVISION_MODE_CHANNEL = "documentView:revisionMode";
export const DOC_VIEW_COMMENT_MUTATE_CHANNEL = "documentView:commentMutate";
/** 在当前选区上新建评论（锚点由页面算）。 */
export const DOC_VIEW_COMMENT_CREATE_CHANNEL = "documentView:commentCreate";
/**
 * 【EDIT-06】把编辑器滚到某条修订所在的位置（左栏点条目时用）。
 *
 * 锚点的语义由**页面**解释（它才知道 block/cell/element/range 怎么换算成滚动）；
 * 宿主只负责把锚点原样送过去 —— 这与修订上报的方向正好相反，形状是同一份。
 */
export const DOC_VIEW_REVISION_FOCUS_CHANNEL = "documentView:revisionFocus";

export const DocViewRevisionFocusSchema = z.object({
  filePath: z.string().min(1).max(4096),
  anchor: z.object({
    kind: z.enum(["block", "cell", "element", "page", "range", "unknown"]),
    block: z.number().optional(),
    sheet: z.string().optional(),
    address: z.string().optional(),
    slide: z.number().optional(),
    elementId: z.string().optional(),
    page: z.number().optional(),
    from: z.number().optional(),
    to: z.number().optional(),
    text: z.string().optional(),
  }).strict(),
}).strict();
export type DocViewRevisionFocusInput = z.infer<typeof DocViewRevisionFocusSchema>;

/**
 * 【EDIT-08】**取当前选区，交给 AI 改写**。
 *
 * 页面提交的是"用户的指令"（"改简洁点"）与选中的文字 —— 选区只在页面里有。
 *
 * ## 它**不发起 AI**
 *
 * 这是本契约最容易被读错的地方。名字叫 rewrite，但它**不调模型、不发请求**：
 * 它只做一件事 —— 把「这段文字 + 这句指令」变成对话草稿里的一个引用。
 * 用户自己按发送，AI 才动。理由与 EDIT-04 的「交给 Mcode AI」完全一致：
 * 自动开跑会让用户在一次点击里付出一轮模型费用，而他可能只是想先看看草稿长什么样。
 *
 * 写回落在哪种形态由**当前的编辑模式**决定（产品决定）：
 *   - 复核模式 → 变成待审条目（左栏能看到、能接受/拒绝）；
 *   - 编辑模式 → 直接替换（可撤销）。
 * 那一步由 AI 的 `replace_selection` 工具完成，与本契约无关。
 */
export const DOC_VIEW_REVISION_REWRITE_CHANNEL = "documentView:revisionRewrite";

export const DocViewRevisionRewriteSchema = z.object({
  filePath: z.string().min(1).max(4096),
  /** 用户的指令（「改简洁点」/「翻成英文」）。 */
  instruction: z.string().min(1).max(4000),
  /**
   * 选中的原文。**可选** —— 省略时由页面取**当前选区**。
   *
   * 为什么会省略：左栏（发起方）看不到编辑器的选区，而选区只在页面里。
   * 让页面自己取，比要求调用方先回传一段选区再发命令少一次往返；
   * 而调用方**确实知道**选区时（比如 AI 从上下文里构造的改写）仍然可以显式给。
   */
  selectedText: z.string().min(1).max(200_000).optional(),
}).strict();
export type DocViewRevisionRewriteInput = z.infer<typeof DocViewRevisionRewriteSchema>;

/**
 * 【EDIT-08】改写请求的回包。
 *
 * **必须有 `selectedText`**：调用方要拿它做引用块。旧版回的是
 * `DocViewRevisionResult`（只有 `ok`）—— 那样调用方拿到 `ok` 也不知道该改哪段，
 * 只能自己再猜一次选区，于是「用户选的是 A、改写的是 B」。
 * 宁可这次失败，也不要把一个没有选区的请求报成成功。
 */
export type DocViewRevisionRewriteResult =
  | { ok: true; selectedText: string }
  | { ok: false; reason: string };

/** 【EDIT-09】列出文件的历史版本（从旧到新）。 */
export const DOC_VIEW_HISTORY_LIST_CHANNEL = "documentView:historyList";
/** 【EDIT-09】回到某个历史版本。 */
export const DOC_VIEW_HISTORY_RESTORE_CHANNEL = "documentView:historyRestore";

export const DocViewHistoryListSchema = z.object({
  filePath: z.string().min(1).max(4096),
}).strict();
export type DocViewHistoryListInput = z.infer<typeof DocViewHistoryListSchema>;

export const DocViewHistoryRestoreSchema = z.object({
  filePath: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type DocViewHistoryRestoreInput = z.infer<typeof DocViewHistoryRestoreSchema>;

/** 一个历史版本（与主进程的 `DocumentVersion` 同形）。 */
export interface DocHistoryVersion {
  sha256: string;
  savedAt: number;
  bytes: number;
  source: "user" | "ai" | "restore";
}

export type DocViewHistoryListResult =
  | { ok: true; versions: DocHistoryVersion[] }
  | { ok: false; reason: string };

export type DocViewHistoryRestoreResult = { ok: true } | { ok: false; reason: string };

/** 页面回报：评论锚点已挂到文档上。 */
export const DOC_VIEW_COMMENT_CREATED_CHANNEL = "documentView:commentCreated";

export const DocViewRevisionStateSchema = z.object({
  filePath: z.string().min(1).max(4096),
}).strict();
export type DocViewRevisionStateInput = z.infer<typeof DocViewRevisionStateSchema>;

/** 接受/拒绝。`ids` 为空 = 全部（批量按钮用）。 */
export const DocViewRevisionDecideSchema = z.object({
  filePath: z.string().min(1).max(4096),
  action: z.enum(["accept", "reject"]),
  ids: z.array(z.string().min(1).max(200)).max(500),
}).strict();
export type DocViewRevisionDecideInput = z.infer<typeof DocViewRevisionDecideSchema>;

export const DocViewRevisionModeSchema = z.object({
  filePath: z.string().min(1).max(4096),
  mode: z.enum(["edit", "review"]),
}).strict();
export type DocViewRevisionModeInput = z.infer<typeof DocViewRevisionModeSchema>;

/**
 * 【Office 深度集成】在**当前选区**上新建一条评论。
 *
 * 与 `commentMutate({op:"add"})` 的分工 —— 两者都在左栏建条目，区别是锚点：
 *
 *   | | 谁决定位置 | 锚点进文档吗 |
 *   |---|---|---|
 *   | `commentCreate` | **页面**（它才知道选区在哪） | ✅ 打评论 mark |
 *   | `commentMutate({op:"add"})` | 调用方给的 `location` | ❌（可选 anchor 字符串，仅记录） |
 *
 * 用户从界面上"对选中文字加评论"走前者；AI 按位置提评论可以走后者。
 */
export const DocViewCommentCreateSchema = z.object({
  filePath: z.string().min(1).max(4096),
  text: z.string().min(1).max(20_000),
}).strict();
export type DocViewCommentCreateInput = z.infer<typeof DocViewCommentCreateSchema>;

export const DocViewCommentMutateSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    filePath: z.string().min(1).max(4096),
    text: z.string().min(1).max(20_000),
    location: z.object({ order: z.number(), label: z.string().max(200) }).strict(),
    anchor: z.string().max(4096).optional(),
  }).strict(),
  z.object({
    op: z.literal("edit"),
    filePath: z.string().min(1).max(4096),
    commentId: z.string().min(1).max(200),
    text: z.string().min(1).max(20_000),
  }).strict(),
  z.object({
    op: z.literal("reply"),
    filePath: z.string().min(1).max(4096),
    commentId: z.string().min(1).max(200),
    text: z.string().min(1).max(20_000),
  }).strict(),
  z.object({
    op: z.literal("resolve"),
    filePath: z.string().min(1).max(4096),
    commentId: z.string().min(1).max(200),
    resolved: z.boolean(),
  }).strict(),
]);
export type DocViewCommentMutateInput = z.infer<typeof DocViewCommentMutateSchema>;

/** 三个写操作的统一回包。失败一律带人能读的原因，不静默。 */
export type DocViewRevisionResult = { ok: true; state?: DocRevisionState } | { ok: false; reason: string };
