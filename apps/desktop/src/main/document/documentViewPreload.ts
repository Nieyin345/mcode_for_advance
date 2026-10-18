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
 *   - 只转发 `openDocxPath`/`saveDocx`：表格/演示文稿的打开入口要各自补（先做 docs）；
 *   - 保存只写回本视图打开的那份文件，没有"另存为"；
 *   - 没有主题/语言的动态同步：页面用写死的默认值，Mcode 切主题不会传导过去。
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
   *  但**忽略 vendor 传进来的 path**：那是页面自己的说法，不可信。 */
  saveDocx: (path: string, data: ArrayBuffer | Uint8Array, auto?: boolean): Promise<{ ok: boolean; bytes?: number; error?: string }> => {
    void path;
    return ipcRenderer.invoke(SAVE_DOCUMENT_CHANNEL, {
      bytes: data instanceof Uint8Array ? data : new Uint8Array(data),
      auto: auto === true,
    });
  },

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
