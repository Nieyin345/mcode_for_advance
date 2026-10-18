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
 *     然后以 `docs:open-path` 事件把**字节或路径**交回页面；
 *   - 几个页面首次渲染必需的只读默认值（语言/主题/自动保存），全部写死为安全值，
 *     不走任何 IPC。
 *
 * ## 安全边界（逐条）
 *
 * 1. **不暴露 `ipcRenderer`**：页面拿不到任意 IPC 通道。
 * 2. **不暴露文件系统**：`openDocxPath` 只是把路径**上送**，由宿主决定给不给；
 *    页面无法自己读写盘。
 * 3. **不暴露 AI/知识库/附件**：vendor 的 AI 面板在本宿主里不接（Mcode 用三引擎
 *    驱动对话），相关方法一律不定义 —— 页面里 `typeof ... === 'function'` 的分支
 *    会自然降级（vendor 代码里这类检查是有的，见 `AiPanel` 的 `kbList` 分支）。
 * 4. **contextIsolation + sandbox 不变**：本 preload 只经 `contextBridge` 暴露
 *    一个冻结对象，不改宿主页的作用域。
 *
 * ## 它现在**还不做**什么（如实）
 *
 *   - 只转发 `openDocxPath`：表格/演示文稿的打开入口要各自补（先做 docs）；
 *   - 没有"保存"通道：本切片只解决"打开"，保存仍走 `document.*` 或旧引擎；
 *   - 没有主题/语言的动态同步：页面用写死的默认值，Mcode 切主题不会传导过去。
 */
import { contextBridge, ipcRenderer } from "electron";

/** 页面允许请求的宿主动作 —— 只有这一条。 */
const OPEN_DOCUMENT_CHANNEL = "mcode:document-view:open-path";

/** 页面首次渲染需要的只读默认值。**全部写死**，不走 IPC：
 *  它们只影响界面语言/主题，不是文档事实；走 IPC 等于给页面多一条通道。 */
const DEFAULTS = {
  language: "zh" as const,
  theme: "system" as const,
  documentTheme: "follow" as const,
  autoSave: true,
} as const;

const api = {
  /** 打开一个文档。宿主会先核对路径是否在已知工作区内。
   *
   *  `docId` 从页面自己的 URL 读（宿主 open 时带上的同名 query）—— preload 与页面
   *  同源，`location.search` 就是宿主给的那一份，页面改不了宿主对它的判断。 */
  openDocxPath: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(OPEN_DOCUMENT_CHANNEL, { filePath: path }),

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

  /** 【安全】**明确不提供**的能力（页面里的特性检测会据此降级）：
   *  - 文件对话框（openDocx / saveDocx / pickAttachments）
   *  - 密码与加密
   *  - AI 设置 / 知识库 / 附件 / 模型
   *  - 任意 IPC / 剪贴板 / 系统对话框
   *
   *  这里不写 `undefined` —— 对象上没有这些键，`typeof window.desktop.X` 即为
   *  `"undefined"`，与"没装 preload"的降级路径一致。 */
};

contextBridge.exposeInMainWorld("desktop", Object.freeze(api));
