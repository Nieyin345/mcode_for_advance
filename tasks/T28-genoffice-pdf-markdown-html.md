# T28｜GenOffice pdf / markdown / html：**直接调原厂 `createXxxView`**

| 项目 | 值 |
|---|---|
| 编号 | T28 |
| 类型 | **ARC-007 主线**（用户：GenOffice 的功能基本全保留，只把 AI 换成我们的） |
| 优先级 | **最高** |
| 建议并发 | 改 `src/main/document/` + `GenofficeViewHostPane.tsx`；**不要与 T29 / T07 同派** |
| 预计规模 | 小到中（主要是接线，不是写代码） |

---

## 一句话结论（已实读源码，不是推测）

**GenOffice 自己就有一套完整的壳**：`genoffice/apps/shell/src/main/tab-manager.ts`。
它给六个 app 各建一个 `WebContentsView` 塞进主窗口。Mcode 要做的是**同一件事**，
不是重新设计一个文档宿主。

Mcode 现在的 `DocumentViewHost` 已经具备所需的全部能力
（`contentView.addChildView` / `setBounds` / 保活 / 焦点 / 崩溃诊断），
它的问题只是：**自己手写了一个最小 preload，只接了 docs**。

---

## 实读证据（按文件行号，可直接核对）

### 1. 原厂每个 app 都已经导出视图工厂

```ts
// genoffice/apps/pdf/src/main/pdf-main.ts:2042
export function createPdfView(openPath?: string | null): WebContentsView

// genoffice/apps/markdown/src/main/markdown-main.ts:1327
export function createMarkdownView(openPath?: string | null): WebContentsView

// genoffice/apps/html/src/main/html-main.ts:1941
export function createHtmlView(openPath?: string | null): WebContentsView
```

函数体做了全部必要的安全设置（实读 `createDocsView` / `createSheetsView` 同一形状）：

```ts
new WebContentsView({ webPreferences: {
  preload: runtime.preloadPath,      // 原厂自己的预加载
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  backgroundThrottling: false,
}})
grantAndTrack(view.webContents, openPath)   // 路径授权 + windowOpen 拦截
void view.webContents.loadURL(rendererUrl(runtime.rendererUrl, 'pdf'))
```

### 2. 原厂壳只需要给它 3–5 个值

`genoffice/apps/shell/src/main/index.ts:507-547`（实读）：

```ts
configurePdfRuntime({
  preloadPath: join(PDF_OUT, 'preload', 'index.js'),
  rendererUrl: process.env.PDF_RENDERER_URL,
  rendererFile: join(PDF_OUT, 'renderer', 'index.html'),
  openGeneratedPath: (path) => openGeneratedDocument(path),
  createDocument: createAiDocument,
})
// markdown / html 同形（少了 createDocument）
```

**别的一概不用改。** 没有 `electron.vite.config.ts` 改造，没有 preload 重写。

### 3. 原厂壳装配视图的方式就是 Mcode 已经在做的方式

```ts
// genoffice/apps/shell/src/main/tab-manager.ts:406
openPdfTab(openPath: string): string {
  const view = createPdfView(openPath)
  this.shellWindow.contentView.addChildView(view)
  view.setVisible(false)
  this.trackHtmlFullScreen(view)
  this.tabs.push({ id, kind: 'pdf', view, title: basename(openPath), filePath: openPath })
  this.activateTab(id)
  return id
}
```

对照 Mcode `apps/desktop/src/main/document/documentViewHost.ts`：
`DocumentViewHost` 已经在做 `contentView.addChildView` + `setBounds` + 保活 + 焦点跟踪。
**它缺的只是「谁来造这个 view」这一步。**

### 4. `createView` 已经是一个可注入端口

```ts
// apps/desktop/src/main/document/documentViewHost.ts:163
createView?: (webPreferences: DocumentViewWebPreferences) => DocumentViewLike;
```

但它的签名**只传 webPreferences** —— 这对 docs 够用（docs 走 `loadURL` 一个 URL），
对原厂 `createPdfView(openPath)` 不够（需要路径参数）。

### 5. AI 通道只有 docs 与 slides 注册了

```bash
$ grep -rn "AI_CHANNELS.stream|'ai:stream'" genoffice/apps/*/src/main/*.ts
apps/docs/src/main/docs-main.ts:4084:  ipcMain.handle('ai:stream', ...)
apps/slides/src/main/ai-ipc.ts:172:     ipcMain.handle('ai:stream', ...)
```

**pdf / markdown / html 的主进程根本没有 AI 实现。**
但它们的 preload 都暴露了 `aiStream` / `aiStreamCancel` / `onAiStream`
（`apps/pdf/src/preload/index.ts:119-121` 等），渲染端的 `ai/transport.ts`
（六个 app 每个 18 行，完全同形）在调一个**不存在的通道**。

**这意味着 AI 替换比想象的简单**：对这三个 app 不是「替换原厂 AI」，
而是「给一个原本就空的通道填上 Mcode 的实现」。

### 6. 原厂六个 app 的 AI 渲染端接缝完全一致

```ts
// genoffice/apps/docs/src/renderer/ai/transport.ts（sheets/slides/pdf/markdown/html 逐字相同）
export function createElectronTransport(getSettings: () => AiSettings): AgentTransport {
  return createIpcTransport<AiSettings>({
    onStream: (listener) => window.desktop.onAiStream(listener),
    start: (request) => window.desktop.aiStream(request),
    cancel: (requestId) => void window.desktop.aiStreamCancel(requestId),
    getSettings,
    ...
  })
}
```

**一个桥，六个 app 共用。** docs 已经有一份可抄的：
`genoffice/apps/docs/src/main/mcode-ai.ts`（206 行，见 `patches/genoffice/0008-*`）。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）。
2. `genoffice/apps/shell/src/main/index.ts:475-555` —— **原厂壳怎么装配六个 runtime**。
   这一段的形状就是本卡要照抄的。
3. `genoffice/apps/shell/src/main/tab-manager.ts:338-470` —— **原厂壳怎么把视图塞进窗口**。
4. `genoffice/apps/pdf/src/main/pdf-main.ts:2042-2057`（`createPdfView`）、
   `markdown-main.ts:1327-1340`、`html-main.ts:1941-1955`。
5. `apps/desktop/src/main/document/documentViewHost.ts` 的
   `DocumentViewHostPorts`（第 156–230 行）与 `open()` 的状态机。
6. `apps/desktop/src/renderer/components/ide/GenofficeViewHostPane.tsx:141-178`
   的 `hasHostOpenChannel` / `editorPageUrl` —— 现在只认 docs 与 slides。
7. `genoffice/apps/docs/src/main/mcode-ai.ts`（206 行）+ `mcode-ipc.ts:271`
   —— AI 桥的现成范本。

---

## 执行内容

### 第 1 步：把 `createView` 端口扩展成「原厂视图工厂」

`DocumentViewHost` 现在的端口是：

```ts
createView?: (webPreferences: DocumentViewWebPreferences) => DocumentViewLike;
```

它只够造一个空壳视图。改成**同时接受两种工厂**：

```ts
/**
 * - webPreferences 形态：本宿主自建（docs 现状，最小 preload）
 * - vendor 形态：原厂 createXxxView(openPath)，它自己管 preload / IPC / 路径授权
 */
createView?: ((webPreferences: DocumentViewWebPreferences) => DocumentViewLike)
  | { vendor: (openPath: string | null, kind: DocumentKind) => DocumentViewLike };
```

**只加字段，不改既有语义**（仓库硬规矩：T02 定型的接口只允许加）。

vendor 形态下：
- 宿主**不设** `preload`（原厂视图自己设了）；
- 宿主**不再** `loadURL`（原厂视图构造时就加载了）；
- 但 `setBounds` / `addChildView` / 保活 / 焦点 / 崩溃诊断**照旧由宿主负责**。

### 第 2 步：主进程装配三个 runtime

在 `apps/desktop/src/main/document/` 下新增一个装配模块（命名自定，建议
`genofficeViewFactories.ts`），照 `genoffice/apps/shell/src/main/index.ts` 的
`configureXxxRuntime` 逐字抄：

```ts
configurePdfRuntime({
  preloadPath: join(PDF_OUT, 'preload', 'index.js'),
  rendererUrl: undefined,                    // 生产靠 rendererFile
  rendererFile: join(PDF_OUT, 'renderer', 'index.html'),
  openGeneratedPath: (p) => { /* Mcode 侧：交给 FileEditor 打开 */ return false; },
})
```

`PDF_OUT` 等路径按 Mcode 的实际布局算（开发是 `<repo>/genoffice/apps/pdf/out`，
安装是 `<resources>/genoffice/...`）。**照 `editorPageUrl` 已有的两套路径判据**，
不要发明第三套。

**必须做**：`genoffice/` 是 gitignored 快照，缺失时构建不能红。
照 `slidesVendorModules.ts` / `slidesVendorModulesStub.ts` 的别名模式做一份 stub
（`electron.vite.config.ts` 里 `existsSync` 判断 + 别名替换）。

### 第 3 步：接上渲染端

- `hasHostOpenChannel` 现在返回 `host === "docs" || (host === "slides" && slidesHost)`。
  把 pdf / markdown / html 加进去（判据改成「能力报告说这个 host 装配了」）。
- `editorPageUrl` 现在假设路径是 `<root>/genoffice/apps/<host>/out/renderer/index.html`。
  **这条不用改** —— 原厂 `createXxxView` 自己算 URL，宿主不再需要拼。
  所以 `GenofficeViewHostPane` 走 vendor 分支时**不应该**再拼 URL。

### 第 4 步：AI 桥（三个 app 共用一个）

- 三个 app 的主进程**都没有** `ai:stream` 实现（已核实）。
- 照 `genoffice/apps/docs/src/main/mcode-ai.ts` 做一份**通用的**
  `mcode-view-ai.ts`，让 pdf / markdown / html 的 preload 暴露的
  `aiStream` / `aiStreamCancel` 都走同一个 Mcode session。
- **不要**装 `@genoffice/ai-provider`，**不要**引任何云账号状态。
- 产出 `patches/genoffice/0010-*`。

### 第 5 步：能力报告

`apps/desktop/src/main/ipc/document.ts:323` 现在是：

```ts
hosts: { docs: true, slides: hostsSlidesOverride ?? slidesBridge.available, sheets: false }
```

加上 pdf / markdown / html 三项，各自如实报告（装配成功才 true）。

---

## 边界（不要碰）

- **不改 `genoffice/` 上游源码**，除了第 4 步的 AI 桥（必须产出补丁）。
- 不改 `sheets` / `slides`（T29 负责）。
- 不删 `PdfPreviewPane`、Milkdown、`OnlyOfficeEditorPane`（它们是 fallback）。
- 不改 `DocumentViewHost` 已有的 docs 行为（vendor 形态是**新增分支**）。
- 不改 `packages/contracts` 既有字段（只允许加）。
- 不动 `src/main/modules/`（扩展线）。

---

## 验收判据

1. 三个 app 都能在 Pane 里打开真实文件：读、改、保存、关闭后其它查看器回读一致。
2. **打开→不改→关闭，文件字节不变**（三个 app 各一条断言）。
3. 拖动 Pane 时视图跟随且**不重载**（用现有保活判据）。
4. `document.capabilities.hosts` 如实；未装配时显式降级并点名原因。
5. AI：至少 pdf 的 AI 面板能经 Mcode session 拿到真实回复
   （md / html 可仅有接线 + 单测）。
6. 现有 `document-view-*` 五套 + `arc005-pane-*` 七套全绿。
7. 三包 tsc（desktop / contracts / genoffice）干净。
8. **变异验证**：撤掉路径围栏 → 越界打开断言红；撤掉 AI 桥的 session 校验 →
   未授权调用断言红；撤掉 stub 别名 → 无 vendor 快照时构建断言红。

---

## 回写区要回答

- `createXxxView` 直接被 `DocumentViewHost` 托管，实际卡在哪一步？（如果顺利，说明我判断对了）
- 原厂 `_OUT` 路径在 Mcode 的开发/安装两种布局下分别是什么？第三套判据有没有出现？
- 三个 app 的 preload 各注册了多少条 IPC？有多少条**会越出 Pane 边界**
  （弹窗、系统菜单、全屏、拖拽），宿主是否需要额外拦截？
- 原厂 `openGeneratedPath` 回调在 Mcode 里应该接到哪？（FileEditor？资料库？）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->


### 2026-10-21 执行回写（T28）

**源码实现与工厂落点**

- `DocumentViewHostPorts.createView` 在原有构造器形态之外增加 `{vendor(openPath,kind)}`；生产另有 `setVendorViewFactory` 注入原厂工厂。`open` 的 PDF/Markdown/HTML 分支只允许初始化时通过已知工作区围栏的真实文件，沿用宿主 attach/bounds/hide/show/focus/diagnostic/close；原厂自建 preload、初始授权与页面导航，宿主不重复 `loadURL`。同一个 docId 不能偷偷换文件或换视图类型；不同 docId 不能持有相同物理文件。
- 原厂 `createPdfView`、`createMarkdownView`、`createHtmlView` 直接从 gitignored GenOffice 源码导入，在 `genofficeNativeVendor.ts` 单一接缝装配；快照不存在时由 `electron.vite.config.ts` 的**精确别名**指向 `genofficeNativeVendorStub.ts`。实际阻碍不是宿主缺少生命周期 API，而是原厂 `genoffice-app://` 自定义协议、三份完整主进程依赖、运行时 preload/renderer 静态资源；现已做协议与部署目录装配。主进程 bundler 曾先遇到原项目坏的 preload 正则与 `docx-engine/lazy-media` 子路径解析，修正 alias 后本地 main build 已通过一次；最终修改后正在复跑。
- 资源路径**只有两套**：开发 `<repo>/genoffice/apps/{pdf|markdown|html}/out/{preload/index.js,renderer/index.html}`；安装 `<resources>/genoffice/apps/{pdf|markdown|html}/out/{preload/index.js,renderer/index.html}`。由既有 CLI 的 `genoffice/packages/cli/dist/genoffice.cjs` 和 `genoffice/cli/genoffice.cjs` 两套可信后缀反推出目录，不接受第三套路径。原厂视图采用固定 `genoffice-app://{host}/index.html` 身份，由主进程 factory 实际决定页面内容，Pane 不再拼 vendor 的 file URL。
- `document.capabilities.hosts.pdf/markdown/html` 分别由对端实际资源与 factory 装配结果报告。不可用时 Pane 显示显式错误，不影响现有 PDF 预览、Milkdown、OnlyOffice 默认回退。
- 原厂 `openGeneratedPath` 最终应该转交 Mcode 的 `FileEditor` 文档打开入口（新 tab/切换现有文件），**不是**资料库自动收录：生成文件仍须通过主进程工作区围栏。目前按任务给定的安全占位返回 `false`，原厂走揭示文件的降级，不伪称新 tab 已打开。

**Preload 与 Pane 边界核对**

- 原厂三个 `src/preload/index.ts` 中 `ipcRenderer` 调用表达式计数（按 `invoke/send/on`）分别为 PDF **56/4/11 = 71**、Markdown **44/5/15 = 64**、HTML **39/7/13 = 59**；是调用位点数，**不是**等价于 71/64/59 个独立 channel，且不包含原厂封装的拖拽工具内部注册。确实会越出 Pane 的类型有系统文件打开/另存为对话框、打印与 PDF 导出、证书选择、附件/图片选择、HTML 演示全屏/新标签、浏览器外链以及拖拽打开系统文件；应用设置与文件上下文菜单也不完全属于视图内 DOM。宿主已限制初始文件路径、页面身份以及原厂 `setWindowOpenHandler` 自带的外链处理，但这些原厂系统副作用并未逐通道换成 Mcode 自有审批（因此不能把原厂所有功能都算作已通过宿主围栏）。后续需要和 FileEditor/系统对话框能力边界协调，此处不扩到上游主进程业务改造。
- 三者的 `ai:stream/get-settings/cancel` 通过一个 upstream `mcode-view-ai.ts` handler 接同一 Mcode SDK 会话，handler 以真实 `event.sender` 反查宿主绑定 `sessionId + filePath`；`docsAiPorts` 对实际选择的 Pi/Claude/Codex session、工作区匹配和人类批准再次检查。页面自报 session 与文件路径被忽略，陌生 sender/失效 session 直接拒绝。vendor 侧单独提交并产出 `patches/genoffice/0010-*`。

**验证记录与未实证部分**

- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`、`pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` 通过。
- `npm run typecheck -w @genoffice/pdf && npm run typecheck -w @genoffice/markdown && npm run typecheck -w @genoffice/html` 通过。
- `node apps/desktop/scripts/run-smokes.mjs document-view-electron-smoke document-view-host-smoke document-view-open-smoke document-view-renderer-smoke document-view-vendor-page-smoke arc005-pane-dock-keys-smoke arc005-pane-docking-smoke arc005-pane-electron-smoke arc005-pane-first-paint-smoke arc005-pane-free-grid-smoke arc005-pane-layout-edges-smoke arc005-pane-write-race-smoke`：**12/12 PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792559391141-29124-xfFo8D`。
- 新增 `genoffice-native-view-smoke`：原厂工厂签收授权初始文件、三个格式的 open→unchanged→close 字节一致、宿主边界外文件拒绝、sender AI 身份、非法 openPath 拒绝、resize/hide/show 不重建也不重载、真实 AI 桥的 SDK 路由/取消与陌生 sender/失效 session；无快照 stub bundle 与降级 5 项断言：**PASS**，恢复后的绿例日志 `apps/desktop/.tmp/smoke-runs/1792559808001-31496-a8fo0v`。
- 确定性变异：`documentViewHost.ts` 撤掉 `withinWorkspace` 时越界打开断言**红**；`mcode-view-ai.ts` 撤掉 `describe(session)` 权限检查时失效 session 断言**红**；两者自动恢复并校验源码哈希，恢复后 suite 复绿。
- **未实证**：真实 Electron 视图上三格式用户手动编辑/保存再从外部查看器回读（含 PDF AI 面板真实网络模型回复）未做端到端 GUI 验证；stub 别名已模拟快照缺失构建成功，但“从构建配置撤掉 stub alias → 真正移除 vendor 快照 → 完整打包失败”的第三组破坏性变异未在多任务共享工作树执行。对此不声称验收已通过。
