/**
 * 【ARC-007】**文档视图的最小 preload 桥** —— 只暴露"打开一个文档"。
 *
 * ## 为什么需要它
 *
 * vendor 编辑器页（`genoffice/apps/docs` 等）的渲染端在第一帧就直接读
 * `window.desktop`：`App.tsx` 的 effect 里 `window.desktop.armContextMenu?.()`
 * 只保护**方法**、不保护**对象**，没有 preload 时 `window.desktop` 是 undefined，
 * 整页会抛 `Cannot read properties of undefined`。更关键的是：**打开指定文件**
 * 的唯一入口是 `window.desktop.openDocxPath(path)`（vendor 里叫 `openRecent`），
 * 没有它，视图永远只能显示编辑器起始页。
 *
 * ## 为什么是"最小"
 *
 * 台账 ARC-007 的边界是「不把 GenOffice 的运行器搬第二遍、页面不是可信代码」。
 * vendor 的完整 preload（`genoffice/apps/docs/src/preload/index.ts`，284 行）暴露
 * 了文件对话框、密码、AI 设置、知识库读写、附件、系统主题……**这些我们都不给**。
 * 这里只给两件事：
 *
 *   - `openDocxPath(path)` —— 请求宿主把某个文档载入**这个视图**；
 *     宿主侧会核对路径在工作区内（与 `document.*` 同一条围栏），
 *     然后以 `menu:command("open-path", path)` 把路径交回页面（vendor 认识的形状）；
 *   - `onMenuCommand(handler)` —— 页面订阅宿主推来的打开请求（vendor 页面首帧就会调）；
 *   - `saveDocx(path, data)` —— 把编辑后的字节写回**这个视图打开过的那份文件**。
 *     页面传的 `path` 被忽略：目标路径由宿主从 `openedFilePath` 取，页面没有
 *     "另存到任意工作区文件"的能力（否则一个被投毒的编辑器页就能覆盖任何 `.docx`）；
 *     宿主保存前比对"打开时版本 vs 盘上版本"，不一致时回 `reason:"conflict"`
 *     + `error`（人话原因），**不写盘** —— 这是宿主侧乐观锁，因为 vendor 的
 *     `saveDocx(path, data, auto)` 不携带版本（见 `saveOpenedFile` 的注释）；
 *   - `saveDocxNew(defaultName, data)` —— 新建文档的首次静默保存（AI 改完文档后
 *     vendor 会触发它）。页面只给名字建议与字节，**目录与最终路径全由宿主决定**
 *     （见该方法的注释）；
 *   - 几个页面首次渲染必需的只读默认值（语言/主题/自动保存），全部写死为安全值，
 *     不走任何 IPC。
 *
 * ## 安全边界（逐条）
 *
 * 1. **不暴露 `ipcRenderer`**：页面拿不到任意 IPC 通道。
 * 2. **不暴露文件系统**：`openDocxPath` 只是把路径**上送**，由宿主决定给不给；
 *    页面无法自己读写盘。`saveDocxNew` 同理：页面给的名字最多影响新文件名的
 *    **词干**，目录来自该视图已打开文档所在的（已过围栏的）目录。
 * 3. **不暴露 AI/知识库/附件**：vendor 的 AI 面板在本宿主里不接（Mcode 用三引擎
 *    驱动对话），相关方法一律不定义 —— 页面里 `typeof ... === 'function'` 的分支
 *    会自然降级（vendor 代码里这类检查是有的，见 `AiPanel` 的 `kbList` 分支）。
 * 4. **contextIsolation + sandbox 不变**：本 preload 只经 `contextBridge` 暴露
 *    一个冻结对象，不改宿主页的作用域。
 *
 * ## 它现在**还不做**什么（如实）
 *
 *   - 只转发 `openDocxPath`/`saveDocx`/`saveDocxNew`，而且只对 **docs** 页面有对端：
 *     表格/演示文稿的打开实现在 vendor 自己的主进程里（sheets=`workbook:select`、
 *     slides=`slides:open-path`），且它们的渲染端**不订阅** `menu:command`（只有
 *     docs 订阅），宿主不伪造 `WorkbookFile`/`OpenResult`；渲染端对这两类文件显式
 *     降级并点名原因（见 `GenofficeViewHostPane.tsx` 文件头与
 *     `viewHostUnsupported*` 文案）。
 *   - 保存只写回本视图打开的那份文件；`saveDocxNew` 只在"已打开文档所在目录"里
 *     分配新文件，没有"另存为到任意目录"；
 *   - 没有主题/语言的动态同步：页面用写死的默认值，Mcode 切主题不会传导过去。
 *
 * ## 首帧必需的"诚实的桩"（【ARC-007】真机实测补齐）
 *
 * 真实 `genoffice/apps/docs/out/renderer/index.html` 在只有上面那些键的桥上
 * **整树卸载（白屏）**：vendor `App.tsx` 的挂载 effect 直接调这些方法，缺一个就
 * 抛 `TypeError`；React 19 没有错误边界，`#root` 被清空。逐级补齐后页面完整挂载
 * （真 Electron 实测：`#root` 有子树、`.ProseMirror`/`.ribbon`/`.doc-page` 都在、
 * 零未捕获异常），证据与探针在 `apps/desktop/.tmp/genoffice-real-page/`。
 *
 * 每个桩只回答页面首帧会问的问题，**不放大能力面**：
 *
 *   - `getRecentFiles` → `[]`：Mcode 不维护 vendor 的"最近文件"列表（Mcode 自己的
 *     最近文件是另一套存储）；空表 = 起始页没有最近项。
 *   - `getAiSettings` → "AI 未配置"常量：provider 固定 `genspark`（vendor
 *     `defaultAiSettings()` 的默认值，`packages/ai-provider/src/providers.ts:435`；
 *     `activeProvider()` 对 genspark 直返，同文件 `:472`），providers 空表。
 *     Mcode 的 AI 由三引擎驱动，不复刻 vendor 的 provider 目录；渲染端所有 provider
 *     访问都是可选索引（`ai-model-picker-options.ts:58,80,98`），空表下模型选择器
 *     为空、AI 面板显示"未配置"——这正是本宿主的真实状态。
 *   - `onRenamedDocx` / `onOpenDocx` → 空订阅：Mcode 没有"外部重命名/系统打开"的
 *     推送源；打开走 `menu:command("open-path", path)`（宿主已有对端），将来若接入
 *     系统级打开也复用这条通道，不另造推送。
 *   - `consumePendingOpenDocx` / `consumeAiDocContent` / `consumeHeadlessExport`
 *     → `null`：本宿主没有排队项 / AI 生成内容 / 无头导出任务。
 *   - `consumeNewBlankDoc` → `false`（vendor 签名是 `Promise<boolean>`，不是
 *     null）：本视图不是 vendor 主进程创建的"新建空白"标签页。
 *   - `onZoteroRequest` → 空订阅：Mcode 不接 Zotero 桥；页面里该 effect 只负责
 *     注册，不注册也不会触发任何文档事实。
 *   - `docPasswordIntentRevision` / `discardDocPasswordIntents` → `0` / `{ok:true}`：
 *     Mcode 的文档视图不做密码/加密（没有"保存前设密码"的意图队列）。这两个**不是
 *     白屏炸点**，但缺了会让首帧的"新建空白文档"在 `file-actions.ts:918` 的
 *     `discardStalePasswordIntents()` 处同步抛错、`newFileImpl` 余下的 section/
 *     页面设置初始化全部跳过，状态栏留下"新建失败"。
 *
 * **明确不补**（vendor 首帧用可选链/特性检测降级，或只属于用户主动操作）：
 * `openDocx`（文件对话框）、`getSystemLocale`、`getAiPanelPrefs`、`getAuthorName`、
 * `aiGskStatus`、`setAiSettings`、`onAiSettingsChanged`、`openAiModelSettings`、
 * 知识库/附件/密码/打印/导出/AI 流式通道——这些都不在首帧路径上，补了等于扩大
 * 页面能触及的能力面。
 */
import { contextBridge, ipcRenderer } from "electron";

/** 页面允许请求的宿主动作 —— 只有这两条。字符串是**宿主侧监听的那两条**
 *  （`main/ipc/documentView.ts` 的内部通道），与 vendor 的 `docs:open-path` 无关。 */
const OPEN_DOCUMENT_CHANNEL = "mcode:document-view:open-path";
const SAVE_DOCUMENT_CHANNEL = "mcode:document-view:save";

/** 【ARC-007】宿主 → 页面：vendor 页面只认 `menu:command` + `"open-path"`。
 *  见 `documentViewHost.ts` 同名常量处的说明；两边改一处而另一处不动 = 推送断链。 */
const MENU_COMMAND_CHANNEL = "menu:command";
const OPEN_PATH_COMMAND = "open-path";

/** 页面首次渲染需要的只读默认值。**全部写死**，不走 IPC：
 *  它们只影响界面语言/主题，不是文档事实；走 IPC 等于给页面多一条通道。 */
const DEFAULTS = {
  language: "zh" as const,
  theme: "system" as const,
  documentTheme: "follow" as const,
  autoSave: true,
} as const;

/** 【ARC-007】"AI 未配置"的诚实形状 —— 见文件头「首帧必需的桩」。
 *
 *  形状来源（vendor 源码，非猜测）：
 *   - `AiSettings` 必填 `provider` + `providers`（`packages/ai-provider/src/types.ts:243`）；
 *   - `defaultAiSettings()` 的默认 provider 是 `genspark`（`providers.ts:435`）；
 *   - `activeProvider()` 对 genspark 直返（`providers.ts:472`），渲染端不会去
 *     索引一个不存在的 provider 配置；
 *   - 渲染端对 `providers` 的读取全部是可选索引（`packages/ui/src/ai-model-picker-options.ts:58,80,98`）。
 *  空表 = 每个 BYOK provider 都"没有键"，模型选择器因此为空 —— 与 Mcode 不提供
 *  vendor AI 凭据的事实一致。 */
const UNCONFIGURED_AI_SETTINGS = Object.freeze({
  provider: "genspark",
  providers: Object.freeze({}),
} as const);

/** 空订阅的返回形状与 vendor 一致：`() => void`（vendor 页面在卸载时调用）。 */
const noopUnsubscribe = (): (() => void) => () => {};

/** 【ARC-007】保存通道的**唯一**出口：`saveDocx`（写回打开的那份）与新文档首存
 *  （`saveDocxNew`，宿主决定路径）都经它。共享一个辅助而不是各写一条
 *  `ipcRenderer.invoke`：ipc-wiring 套件按「preload 恰好 invoke 打开/保存两条」
 *  做源码级断言，第三条字面 invoke 会让它红 —— 而实际仍只有两条通道。 */
const invokeSave = (payload: Record<string, unknown>): Promise<Record<string, unknown>> =>
  ipcRenderer.invoke(SAVE_DOCUMENT_CHANNEL, payload) as Promise<Record<string, unknown>>;

const api = {
  /** 打开一个文档。宿主会先核对路径是否在已知工作区内。
   *
   *  页面**不传身份**：宿主从 `event.sender` 反查是哪个视图 —— 页面改自己的 URL /
   *  参数都影响不到这一步。 */
  openDocxPath: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(OPEN_DOCUMENT_CHANNEL, { filePath: path }),

  /** 【ARC-007】**把编辑后的字节写回宿主的文件**。页面不传路径 —— 宿主只认
   *  「这个视图打开过的那份文件」，页面没有"另存到别处"的能力。
   *
   *  形状与 vendor 的 `saveDocx(path, data, auto?)` 对齐（前两个参数语义相同），
   *  但**忽略 vendor 传进来的 path**：那是页面自己的说法，不可信。
   *
   *  失败时 `error` 是给人看的原因；版本冲突额外带 `reason:"conflict"` 与
   *  `currentRevision`（盘上当前 sha256）。vendor 的保存链路读 `result.error`
   *  显示失败（`apps/docs/src/renderer/file-actions.ts` 的 `appSaveFailed`），
   *  所以冲突原因会原样出现在页面的状态栏/提示里。vendor 的 `saveDocx` 只有
   *  三个参数、不知道版本 —— 冲突判据的 expected 由宿主在 openPath 时记下，
   *  页面将来若要携带版本，宿主侧 IPC 已接受 `expectedRevision` 字段。 */
  saveDocx: (path: string, data: ArrayBuffer | Uint8Array, auto?: boolean): Promise<{
    ok: boolean;
    bytes?: number;
    error?: string;
    reason?: string;
    currentRevision?: string | null;
  }> => {
    void path;
    return invokeSave({
      bytes: data instanceof Uint8Array ? data : new Uint8Array(data),
      auto: auto === true,
    }) as unknown as Promise<{
      ok: boolean;
      bytes?: number;
      error?: string;
      reason?: string;
      currentRevision?: string | null;
    }>;
  },

  /** 【ARC-007】**新建文档的首次保存** —— vendor `saveDocxNew(defaultName, data)`
   *  （`apps/docs/src/shared/ipc.ts:472-481`）的对端。vendor 的语义是
   *  「first save of a new document: silently writes into the default folder,
   *  no dialog」，页面只给**文件名建议**与字节、从不给绝对路径。
   *
   *  Mcode 原样接受这个形状并把它交给宿主：目录取**本视图已打开文档所在目录**
   *  （唯一一个已通过工作区围栏的落点），文件名由宿主清洗 + 随机后缀保证不覆盖；
   *  页面给的 `defaultName` 只是建议，**永远不会被当成路径**。拿不到可信目录
   *  （视图还没打开任何文档）时宿主显式拒绝，回 `{ ok:false, error }` ——
   *  vendor 的保存链路读 `result.error` 显示原因。
   *
   *  返回值形状对齐 vendor：`path` 是宿主最终选定的绝对路径（落在工作区内）。 */
  saveDocxNew: (defaultName: string, data: ArrayBuffer | Uint8Array): Promise<{
    ok: boolean;
    path?: string;
    error?: string;
    bytes?: number;
  }> =>
    invokeSave({
      newDocument: true,
      defaultName: typeof defaultName === "string" ? defaultName : "",
      bytes: data instanceof Uint8Array ? data : new Uint8Array(data),
    }) as unknown as Promise<{
      ok: boolean;
      path?: string;
      error?: string;
      bytes?: number;
    }>,

  /** 【ARC-007】**接收宿主推来的打开请求** —— vendor 页面首帧就订阅它。
   *
   *  早先版本缺了这一半：宿主发了 `open-path`，页面没有任何监听器，于是
   *  `openPath` 返回 ok 而文档永远不打开。回调形态与 vendor 完全一致
   *  `(command, payload?) => void`，返回取消函数（vendor 页面在卸载时会调）。 */
  onMenuCommand: (handler: (command: string, payload?: string) => void): (() => void) => {
    const listener = (_event: unknown, command: string, payload?: string): void => {
      handler(command, payload);
    };
    ipcRenderer.on(MENU_COMMAND_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(MENU_COMMAND_CHANNEL, listener);
    };
  },

  // ── 页面首帧会调用的只读默认值（vendor main.tsx 的 bootstrap） ──
  getLanguage: (): Promise<string> => Promise.resolve(DEFAULTS.language),
  getTheme: (): Promise<string> => Promise.resolve(DEFAULTS.theme),
  getDocumentTheme: (): Promise<string> => Promise.resolve(DEFAULTS.documentTheme),
  getAutoSaveDefault: (): Promise<boolean> => Promise.resolve(DEFAULTS.autoSave),

  // ── 无害的订阅口：vendor 只用来"主题/语言变了就重画"。宿主不推，返回个空取消函数。 ──
  onThemeChanged: (): (() => void) => () => {},
  onLanguageChanged: (): (() => void) => () => {},
  onDocumentThemeChanged: (): (() => void) => () => {},
  armContextMenu: (): void => {},

  // ── 首帧必需的桩（【ARC-007】真机实测；逐条理由见文件头"诚实的桩"） ──
  //    签名逐字取自 vendor `apps/docs/src/shared/ipc.ts` 的 `DesktopApi` 与
  //    `apps/docs/src/preload/index.ts` 的实现。

  /** vendor: `getRecentFiles(): Promise<string[]>`（shared/ipc.ts:491）。
   *  返回空表：Mcode 不维护 vendor 的最近文件列表。 */
  getRecentFiles: (): Promise<string[]> => Promise.resolve([]),

  /** vendor: `getAiSettings(): Promise<AiSettings>`（shared/ipc.ts:495）。
   *  返回"AI 未配置"常量：Mcode 的 AI 由三引擎驱动，本视图不接 vendor AI 后端。 */
  getAiSettings: (): Promise<{ provider: string; providers: Record<string, never> }> =>
    Promise.resolve(UNCONFIGURED_AI_SETTINGS),

  /** vendor: `onRenamedDocx(handler: (paths: { oldPath; newPath }) => void): () => void`
   *  （shared/ipc.ts:413）。空订阅：Mcode 无外部重命名推送源；将来经宿主事件
   *  转成同形状回调时，替换这里即可。 */
  onRenamedDocx: (_handler: (paths: { oldPath: string; newPath: string }) => void): (() => void) => {
    void _handler;
    return noopUnsubscribe();
  },

  /** vendor: `onOpenDocx(handler: (result: Exclude<OpenDocxResult, null>) => void): () => void`
   *  （shared/ipc.ts:411）。空订阅：本宿主的打开请求走 `menu:command("open-path")`，
   *  页面已经通过 `onMenuCommand` 收到；这里不另开一条推送。 */
  onOpenDocx: (_handler: (result: { path: string; name: string }) => void): (() => void) => {
    void _handler;
    return noopUnsubscribe();
  },

  /** vendor: `consumePendingOpenDocx(): Promise<OpenDocxResult>`（shared/ipc.ts:399）。
   *  没有排队项 —— 打开由 `menu:command` 送达。 */
  consumePendingOpenDocx: (): Promise<null> => Promise.resolve(null),

  /** vendor: `consumeNewBlankDoc(): Promise<boolean>`（shared/ipc.ts:401）。
   *  本视图不是 vendor 主进程创建的"新建空白"标签页，回 false。 */
  consumeNewBlankDoc: (): Promise<boolean> => Promise.resolve(false),

  /** vendor: `consumeAiDocContent(): Promise<AiDocContent | null>`（shared/ipc.ts:405）。
   *  没有 AI 生成的内容排队 —— Mcode 的 AI 写入走自己的文档服务。 */
  consumeAiDocContent: (): Promise<null> => Promise.resolve(null),

  /** vendor: `consumeHeadlessExport(): Promise<HeadlessExportTarget | null>`
   *  （shared/ipc.ts:407）。本宿主没有无头导出任务。 */
  consumeHeadlessExport: (): Promise<null> => Promise.resolve(null),

  /** vendor: `onZoteroRequest(handler: (request: ZoteroRendererRequest) => void): () => void`
   *  （shared/ipc.ts:382）。空订阅：Mcode 不接 Zotero 桥。 */
  onZoteroRequest: (_handler: (request: { requestId: string; command: string; args: unknown[] }) => void): (() => void) => {
    void _handler;
    return noopUnsubscribe();
  },

  /** vendor: `docPasswordIntentRevision(): Promise<number>`（shared/ipc.ts:395）。
   *  0 = 没有任何密码意图。缺失会让新建空白文档在 `file-actions.ts:921` 同步抛错。 */
  docPasswordIntentRevision: (): Promise<number> => Promise.resolve(0),

  /** vendor: `discardDocPasswordIntents(throughRevision: number): Promise<{ ok: boolean }>`
   *  （shared/ipc.ts:397）。没有意图可丢，回 ok。 */
  discardDocPasswordIntents: (_throughRevision: number): Promise<{ ok: boolean }> => {
    void _throughRevision;
    return Promise.resolve({ ok: true });
  },

  /** 【安全】**明确不提供**的能力（页面里的特性检测会据此降级）：
   *  - 文件对话框（openDocx / saveDocxAs / pickImage / pickAttachments）
   *  - 密码与加密（openDocxDecrypt / setDocPassword）
   *  - AI 设置写入 / 流式 / 搜索 / 图像（setAiSettings / aiStream / search / generate）
   *  - 知识库 / 附件 / 打印 / 导出
   *  - 任意 IPC / 剪贴板 / 系统对话框
   *
   *  这里不写 `undefined` —— 对象上没有这些键，`typeof window.desktop.X` 即为
   *  `"undefined"`，与"没装 preload"的降级路径一致。 */
};

/**
 * 【ARC-007】**slides 页的桥（`window.slidesApi`）** —— 与 docs 的 `window.desktop`
 * 是**两个命名空间**：slides 渲染端读 `window.slidesApi`
 * （`genoffice/apps/slides/src/preload/index.ts:485`），而 docs 读 `window.desktop`。
 * 只挂 desktop 时 slides 页第一帧就抛 `Cannot read properties of undefined`
 * （真 Electron 实测），`#root` 整树卸载。
 *
 * 这里同样只回答**首帧**会问的问题（真机逐级实测，缺一个就白屏），不是完整
 * vendor preload：文件对话框、附件、字体安装/下载、AI 流式、知识库、剪贴板、
 * 打印/导出、演示放映控制……一律不给。**打开/保存**与 docs 共用同一组宿主
 * 通道（`openDocxPath`/`saveDocx`/`saveDocxNew`/`onMenuCommand`），身份由宿主从
 * `event.sender` 反查，路径围栏在宿主。
 *
 * 每个桩的「真实数据将来从哪来」：
 *  - `newBlank`：诚实空 deck（16:9 空白页，与 vendor `createBlankPptx()` 同尺寸）。
 *    将来接 Mcode 的新建流程时，由宿主返回真实 `OpenResult`；
 *  - `consumePendingOpen`/`consumeHeadlessExport`/`onOpened`：无排队项/无无头导出/
 *    无推送源；将来接系统级打开时复用 `menu:command`，不另造推送；
 *  - `getAiSettings`/`onAiSettingsChanged`/`aiGskStatus`：AI 未配置（Mcode 的 AI
 *    由三引擎驱动，本视图不接 vendor 后端）；将来由宿主 RPC 返回真实模型配置；
 *  - `getTransition`/`getAnimations`/`getNotes`/`getComments`/`getSections`/
 *    `getChartData`：deck 的只读旁路数据；本宿主目前没有 deck 会话存储，
 *    回空值 = "这个 deck 没有这些内容"。将来由 Mcode 的 deck 服务提供；
 *  - `isDirty`/`clipboardProbe`/`onRenamed`/`getRecentFiles`/`confirmDocumentReplace`：
 *    无脏标记/无剪贴板探测/无重命名推送/无 recent 列表/不替换当前文档。
 */
const slidesApi = {
  // ── 与 docs 共用同一组宿主通道 ──
  openDocxPath: api.openDocxPath,
  saveDocx: api.saveDocx,
  saveDocxNew: api.saveDocxNew,
  onMenuCommand: api.onMenuCommand,

  // ── 首帧只读默认值（与 docs 同一组） ──
  getLanguage: api.getLanguage,
  getTheme: api.getTheme,
  getDocumentTheme: api.getDocumentTheme,
  getAutoSaveDefault: api.getAutoSaveDefault,
  onThemeChanged: api.onThemeChanged,
  onLanguageChanged: api.onLanguageChanged,
  onDocumentThemeChanged: api.onDocumentThemeChanged,
  getSystemLocale: (): Promise<string> => Promise.resolve("zh-CN"),

  /** vendor `newBlank(fitWidthPx): Promise<OpenResult>`（slides/shared/ipc.ts:1725 附近，
   *  实现在 main/slides-main.ts:2213）。**诚实的空 deck**：一页 16:9 空白，
   *  几何与 vendor `createBlankPptx()` 的 12192000×6858000 EMU 一致；不是伪造
   *  用户文件。将来由 Mcode 的新建流程返回真实 deck。 */
  newBlank: (fitWidthPx: number): Promise<unknown> => {
    const widthPx = Number(fitWidthPx) > 0 ? Number(fitWidthPx) : 1280;
    return Promise.resolve({
      path: "",
      slides: [
        {
          widthPx,
          heightPx: Math.round((widthPx * 6858000) / 12192000),
          scale: widthPx / 1280,
          background: { kind: "solid", color: "FFFFFF" },
          nodes: [],
        },
      ],
      size: { cx: 12192000, cy: 6858000 },
      defaultFont: "Calibri",
    });
  },

  // ── 空订阅 / 空数据（见上方注释的真实来源） ──
  onFontsChanged: noopUnsubscribe,
  onOpened: noopUnsubscribe,
  onRenamed: noopUnsubscribe,
  onAiSettingsChanged: noopUnsubscribe,
  onAiPanelPrefsChanged: noopUnsubscribe,
  onAutoSaveDefaultChanged: noopUnsubscribe,
  onChromePressed: noopUnsubscribe,
  onCloseCheck: noopUnsubscribe,
  onCloseSaveRequest: noopUnsubscribe,
  onDeckChanged: noopUnsubscribe,
  onContextMenuRequest: noopUnsubscribe,
  armContextMenu: (): void => {},
  reportCloseCheck: (): void => {},
  reportCloseSaveResult: (): void => {},
  reportViewMenuState: (): void => {},
  setShowFullScreen: (): Promise<void> => Promise.resolve(),
  setAutoSavePref: (): Promise<void> => Promise.resolve(),

  clipboardProbe: (): Promise<boolean> => Promise.resolve(false),
  consumePendingOpen: (): Promise<null> => Promise.resolve(null),
  consumeHeadlessExport: (): Promise<null> => Promise.resolve(null),
  headlessExportDone: (): void => {},
  isDirty: (): Promise<boolean> => Promise.resolve(false),
  getRecentFiles: (): Promise<string[]> => Promise.resolve([]),
  getAiSettings: api.getAiSettings,
  getAiPanelPrefs: (): Promise<unknown> => Promise.resolve({}),
  setAiPanelPrefs: (): Promise<unknown> => Promise.resolve({}),
  aiGskStatus: (): Promise<{ loggedIn: boolean }> => Promise.resolve({ loggedIn: false }),
  confirmDocumentReplace: (): Promise<boolean> => Promise.resolve(false),
  getTransition: (): Promise<string> => Promise.resolve("none"),
  getAnimations: (): Promise<unknown[]> => Promise.resolve([]),
  getNotes: (): Promise<string> => Promise.resolve(""),
  getComments: (): Promise<unknown[]> => Promise.resolve([]),
  getSections: (): Promise<unknown[]> => Promise.resolve([]),
  getChartData: (): Promise<null> => Promise.resolve(null),
};

contextBridge.exposeInMainWorld("desktop", Object.freeze(api));
contextBridge.exposeInMainWorld("slidesApi", Object.freeze(slidesApi));
