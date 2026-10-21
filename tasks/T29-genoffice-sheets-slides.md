# T29｜GenOffice sheets + slides：**直接调原厂 `createXxxView`**

| 项目 | 值 |
|---|---|
| 编号 | T29 |
| 类型 | **ARC-007 主线** |
| 优先级 | **最高** |
| 建议并发 | 改 `src/main/document/` + `GenofficeViewHostPane.tsx`；**不要与 T28 / T07 同派** |
| 预计规模 | 中（比 T28 大，但仍是接线） |

---

## 一句话结论

Mcode 现在的注释说 sheets「没有对端」（`documentViewHost.ts:65-74`），
**这句话是错的**：原厂 `createSheetsView` 就在
`genoffice/apps/sheets/src/main/sheets-main.ts:2444`，而且它接受
`{ includeAiHandlers: false }` —— **原厂壳自己就是这么调用的**
（`tab-manager.ts:361`）。

slides 同理：`createSlidesView(openPath)` 在
`genoffice/apps/slides/src/main/slides-main.ts:5051`。

Mcode 现有的 `slidesBridge` / `slidesExecutor`（只开 3 个操作）是**重复劳动**，
应当退成 fallback 或直接删掉。

---

## 实读证据

### sheets

```ts
// genoffice/apps/sheets/src/main/sheets-main.ts:2444
export function createSheetsView(
  options: { includeAiHandlers?: boolean; openingWorkbook?: boolean } = {},
): WebContentsView {
  const client = sidecar ?? new XlsxSidecarClient(resolveSidecarPath())
  sidecar = client
  client.start()                                    // ← 自动拉起 xlsx sidecar
  const view = new WebContentsView({
    webPreferences: {
      preload: runtime.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  registerSheetsIpc()
  if (options.includeAiHandlers ?? true) registerSheetsAiIpc()   // ← 本卡传 false
  registerSheetsSession(view.webContents, client)
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', (event) => event.preventDefault())
  void view.webContents.loadURL(
    rendererUrl(runtime.rendererUrl, 'sheets', {
      mode: 'tab',
      ...(options.openingWorkbook ? { openingWorkbook: '1' } : {}),
    }),
  )
  return view
}
```

**注意**：`createSheetsView` **不接受 `openPath`**。打开文件走的是另一条路：

```ts
// genoffice/apps/shell/src/main/tab-manager.ts:360-391
openSheetsTab(openPath?: string, options?: { newBlank?: boolean }): string {
  if (options?.newBlank) setSheetsNewBlank()
  const spare = this.takeSpareSheetsView()
  const view = spare ?? createSheetsView({ includeAiHandlers: false, openingWorkbook: Boolean(openPath) })
  // bind the path to this tab's webContents
  if (openPath) {
    queueWorkbookForView(view.webContents, openPath)
    if (spare) nudgeQueuedWorkbook(view.webContents)
  }
  ...
}
```

即：**`queueWorkbookForView(webContents, path)` 是打开入口**，
不是 `createSheetsView(openPath)`。这是 sheets 与其它五个 app 的关键差异，别搞错。

### slides

```ts
// genoffice/apps/slides/src/main/slides-main.ts:5051
export function createSlidesView(openPath?: string | null): WebContentsView {
  const view = new WebContentsView({ webPreferences: { preload: runtime.preloadPath,
    contextIsolation: true, nodeIntegration: false, sandbox: true } })
  registerSlidesIpc()                       // ← 155 条 ipcMain 全注册
  trackSlidesWebContents(view.webContents)
  armVibrancy(view)
  if (openPath && existsSync(openPath)) pendingByWc.set(view.webContents.id, openPath)
  void view.webContents.loadURL(rendererUrl(runtime.rendererDevUrl, 'slides', { mode: 'tab' }))
  return view
}
```

**注意**：`registerSlidesIpc()` 内部会调 `registerSlidesOnlyAiIpc()`
（`slides-main.ts:4820`）。它注册的是 `ai:stream` 等通用通道吗？

```ts
// genoffice/apps/slides/src/main/ai-ipc.ts:332-336
// Must be registered inside registerSlidesIpc (not registerAiIpc): in shell aggregate mode the
// generic ai:* channels are registered by docs-main.registerAiIpc, and slides' registerAiIpc is
// skipped to avoid a double registration.
export function registerSlidesOnlyAiIpc(): void {
```

**这是关键陷阱**：slides 依赖「别人先注册 `ai:stream`」。
Mcode 必须自己提供这条通道（同 T28 的 AI 桥）。

### 原厂壳的 AI 处理（可直接照抄）

```ts
// genoffice/apps/shell/src/main/index.ts:6625
registerAiIpc()                    // ← 来自 docs-main，全局一份
```

即：**原厂壳也是用 docs 的那份 AI 实现，全六 app 共用。**
Mcode 已经有这份的移植（`genoffice/apps/docs/src/main/mcode-ai.ts`），
只要让它对 slides/sheets 的 webContents 也生效即可。

### Mcode 现有的 slides 代码是重复的

- `apps/desktop/src/main/document/slidesBridge.ts` —— 3 个操作
- `apps/desktop/src/main/document/slidesExecutor.ts` —— 包装 vendor 的
  `openAndBuild` / `saveSlides`
- `apps/desktop/src/main/document/slidesVendorModules.ts` —— 静态 import 三个 vendor 包

原厂 `createSlidesView` 已经把 `registerSlidesIpc()` 全做了（155 条）。
**Mcode 这 3 个文件的存在，是因为当时以为不能直接用原厂视图。**

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）。
2. `genoffice/apps/shell/src/main/index.ts:507-547`（runtime 装配）
   与 `tab-manager.ts:360-470`（tab 创建）。
3. `genoffice/apps/sheets/src/main/sheets-main.ts:2444-2478`（`createSheetsView`）
   与 `tab-manager.ts:360-391`（`queueWorkbookForView` 的用法）。
4. `genoffice/apps/slides/src/main/slides-main.ts:5051-5070`（`createSlidesView`）
   与 `ai-ipc.ts:332-340`（AI 注册的先后依赖）。
5. `apps/desktop/src/main/document/slidesBridge.ts` / `slidesExecutor.ts`
   —— 判断哪些能删、哪些要留作 fallback。
6. `apps/desktop/src/main/ipc/document.ts:323`（能力报告）。

---

## 执行内容

### 第 1 步：sheets —— 先证明能打开

- 主进程 `configureSheetsRuntime({...})`，路径照原厂壳的算法。
- `createSheetsView({ includeAiHandlers: false, openingWorkbook: true })`
- **打开路径用 `queueWorkbookForView(view.webContents, path)`** —— 这是原厂入口，
  不要自己写一个「Mcode 版打开器」。
- 判据：xlsx 能在 Pane 里打开，看到真实表格数据。

**sidecar 依赖**：`createSheetsView` 会 `client.start()` 拉起 xlsx-engine sidecar
（`SIDECAR_BIN`，原厂编译的 Rust 可执行）。先确认：
- 开发期 sidecar 在不在盘上（`genoffice/apps/sheets/native/xlsx-engine/target/release/`）；
- 安装包里怎么带（原厂 `electron-builder` 有 `extraResources`）。
- **不在盘上就显式失败并说明**，不要假装表格能用。

### 第 2 步：sheets 保存与回读

- 打开→不改→关闭，文件字节不变。
- 改一格→保存→用独立读取器回读一致。
- 保存走原厂自己的链路（`createSheetsView` 已经接好），
  **不要**额外的 CAS 层 —— 除非原厂没有，那才补。

### 第 3 步：slides —— 直接换视图

- `configureSlidesRuntime({...})` + `createSlidesView(openPath)`。
- 现有的 `slidesBridge` / `slidesExecutor` 三条通道（`slidesAddSlide` /
  `slidesEditText` / `openPath`）**先保留**，等新路验证通过再决定删不删。
  （仓库硬规矩：不删旧能力，未迁移完成前继续用 fallback。）

### 第 4 步：AI 桥（与 T28 共用同一份）

- slides 的 `registerSlidesIpc()` 会调 `registerSlidesOnlyAiIpc()`，
  后者**不注册** `ai:stream` —— 它假设别人先注册了。
- sheets 传 `includeAiHandlers: false` 后也不会自己注册。
- **所以宿主必须提供 `ai:stream`**。这份实现与 T28 的完全一样，
  由 T28 产出（`mcode-view-ai.ts`）。
- 本卡若先于 T28 开工，则自己产出同一份，后续 T28 直接复用 —— 不要写两份。

### 第 5 步：能力报告

`document.capabilities.hosts` 加 `sheets` 与 `slides` 两项，如实报告。
未装配时显式降级（照 `GenofficeViewHostPane` 的 `unsupportedHost` 分支）。

### 第 6 步：评估旧代码的下场（**只评估，不急删**）

本卡完成后在回写区回答：
- `slidesBridge` / `slidesExecutor` 还有没有用？
- `slidesVendorModules.ts` 的静态 import 还需不需要？
- `OnlyOfficeEditorPane` 要不要保留？

**不要在本卡里删它们** —— 另开卡，等新路稳定一段时间。

---

## 边界（不要碰）

- **不改 `genoffice/` 上游源码**，除了 AI 桥（产出 `patches/genoffice/0010-*` 起）。
- 不改 pdf / markdown / html（T28）。
- 不改 docs 既有行为。
- 不删 `slidesBridge` / `slidesExecutor` / `OnlyOfficeEditorPane`。
- 不改 `DocumentViewHost` 既有语义（只允许加）。
- 不动 `src/main/modules/`。

---

## 验收判据

1. xlsx：打开真实文件 → 看到数据 → 改一格 → 保存 → 独立读取器回读一致。
2. xlsx：打开→不改→关闭，字节不变。
3. pptx：打开已有文件 → 加一页 → 保存 → 重开可见。
4. pptx：打开→不改→保存，字节不变。
5. AI：两个 app 都能经 Mcode session 拿到真实回复（不是只接线）。
6. `document.capabilities.hosts` 如实；未装配时显式降级。
7. 现有 `document-view-*` 五套 + `arc005-pane-*` 七套全绿。
8. 三包 tsc 干净。
9. **变异验证**：撤掉 sheets 的路径绑定 → 打开错文件断言红；
   撤掉 slides 的 `pendingByWc` → 打开失败断言红；
   撤掉 AI 桥的 session 校验 → 未授权调用断言红。

---

## 回写区要回答

- `createSheetsView` 到底需不需要改？如果需要，卡在哪一步？
- xlsx sidecar 在 Mcode 的开发/安装两种布局下分别怎么定位？能不能直接复用原厂的？
- `queueWorkbookForView` 是原厂的打开入口 —— 它有没有对「未授权路径」做围栏？
  如果没有，Mcode 的围栏应该加在它前面还是后面？
- slides 的 155 条 IPC 里，有多少条会越出 Pane（弹窗、系统菜单、全屏、文件对话框）？
- Mcode 现有的 3 个 slides 文件（bridge/executor/vendorModules）在不在这条路上？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
