# T13｜GenOffice 六原生编辑器功能与接线基线矩阵（只读调查）

> 调查日期：2026-10-23。性质：**只读基线**，不是功能交付、不是验收通过。
> 证据等级按 `audit-ledgers/README.md` §2.4：E1 隔离动态 / E2 源码调用链 / E3 待证实 / D 设计 / U1 真实用户旅程。
> 本报告**不修改** `genoffice/`、`patches/`、许可证文件、发布门禁或任何产品源码；结论全部来自读源码、读既有 smoke 日志/产物与 `git` 只读命令。

## 0. Git 快照与调查口径

### 0.1 两个 Git 身份（开工时）

| 仓库 | HEAD | 分支 | 工作树 |
|---|---|---|---|
| Mcode 外层 | `2c93f70ef863084426790c46c11e916644b43904`（`docs(tasks): record T5 commit SHA`） | `master`，领先 `origin/master` 332 | 7 项他人 dirty：`.aoci/baseline.json`、`.gitignore`、`maint-m35-smoke/pickers-prelude.ts`、`orchestration-ipc-smoke/run.sh`、`release-readiness-smoke/check-reviewed.cjs`、`apiCatalog.generated.ts`、`ipc/settingsTransfer.ts` |
| GenOffice 嵌套仓 | `635dee2f6a38d7f0a3aec31a487afc3e2369a5cf`（`feat(docs): ack native tool results in hosted turn`） | `mcode/integration` | **干净**（`git status --porcelain` 空） |

调查期间外层 HEAD 被并行会话推进到 `eb3f1e0b5d9f5ec79e4c9f16fa2d6ee18c6506ed`（`docs(agents): install four verified skills…`），并出现 T0 并行施工的 dirty（`docsAiPorts.ts`、`nativeEditorToolTransport.ts`、`tasks/T0-…md` 与两个新 smoke 目录）。**本报告没有 reset/clean/覆盖任何 dirty 文件**；下文凡引用"当前源码"均以 `2c93f70e` 为准，并在受影响处标注 `eb3f1e0b` 的差异。回写时再次记录两个 SHA。

### 0.2 嵌套仓 lineage（已可复现，E2）

- 上游基线 `cbec600a`，首条已审查补丁 `73ba9180`，之后 13 个 Mcode 补丁（`patches/genoffice/0001..0013`），最终 HEAD `635dee2f`，tree `532e6727eb1f4e94e686cee1ab55a99bddf8f6f0`；锁定于 `apps/desktop/build/genoffice-upstream.lock.json`（`format: mcode.genoffice.upstream-lock.v2`）。
- 校验器 `apps/desktop/build/verify-genoffice-upstream.cjs:15-37` 把 13 条 patch 的 revision/parent/SHA-256 与最终 tree 全部钉死；T87 已用临时副本重放 13 补丁并核对 tree（`tasks/archive/legacy-2026-10-22/T87-genoffice-patch-lineage-and-license-notices.md`）。
- 补丁覆盖面（`patches/genoffice/*.patch` 的 `diff --git` 清单）：0001–0009 集中在 **Docs**（preload/main/privileged/AI/媒体）；0010 是 **PDF/Markdown/HTML 的 AI 桥**（`apps/pdf/src/main/mcode-view-ai.ts`）；0011 是 **Sheets/Slides 的 Pane 围栏**（`mcode-sheets-scoped.ts` 等）；0012 是 Slides AI/媒体 fail-closed；0013 是 Docs + agent-core 的工具结果 ACK。
- **没有任何补丁触及 PDF/Markdown/HTML 的打开/保存主链**（其宿主适配完全在 Mcode 侧）。

### 0.3 "CLI/API 跑通"与"GUI 集成"的分栏口径

- **CLI/API**：`document.read/edit/convert` → GenOffice CLI 子进程（`apps/desktop/src/main/document/genofficeCli.ts`）或 `document.*` 的侧车。它只证明**文件层**读写/转换。
- **GUI**：Mcode `DocumentViewHost` + `WebContentsView` + 原厂 `out/renderer` 页面 + 原厂/Mcode preload 的真实图形链。
- **U1(harness)**：真实 Electron + 真 vendor 页面，但 **preload 由测试脚本自行打包到探针目录**、或页面由 `file://` 直接加载；它不证明**发行构建**里同一链路存在。
- **U1(shipped)**：`electron-vite build` + `electron-builder` 产物、按 `extraResources` staging 后启动的真实安装面。**本次调查未运行任何安装包**，因此六类**全部没有 U1(shipped) 证据**。

### 0.4 本次实际执行的命令（只读）

`git rev-parse/status/log/show/diff/grep`、`Read/Grep`、`bash apps/desktop/scripts/smokes-for.sh --uncovered`（只读清单）、`node -e` 读取文件、读取 `apps/desktop/.tmp/smoke-runs/**` 与 `.tmp/*/checks.json` 既有证据。
**披露一处越界但非破坏性动作**：调查中一次误执行了不带参数的 `node apps/desktop/scripts/run-smokes.mjs`（默认 = 17 套 critical）。结果 16 套 PASS；`mcp-endpoint-smoke` FAIL 于 esbuild 无 `.node` loader（`sherpa-onnx-linux-arm64/sherpa-onnx.node`），属既有环境/打包配置问题，与 GenOffice 无关；日志 `apps/desktop/.tmp/smoke-runs/1792692726764-24244-8Zy0Tx/`。该次运行只写 `.tmp`，未改产品文件。

## 1. 结论摘要（六类 × 两层）

### 1.1 CLI/API 层（文件读写/转换）

| 格式 | CLI/API 能力 | 证据 |
|---|---|---|
| Docs (.docx/.odt/.ott) | `document.read/edit` 走 CLI `docs`/`apply`；`genoffice-format-gates-smoke` G1 打开不重写、G2 docx 生成→apply→read 回读，**110/110 PASS** | E1（日志 `1792590714394-31400-IEfB5l`） |
| Sheets (.xlsx/.xlsm/.xls/.csv/.ods) | `sheet check`（纯 Node）可读；`sheet read/apply --cells` 需 Rust sidecar；`sheet apply --ops` 部分纯 JS | E1（format-gates；`document-read-smoke` 另需 Python 工具链） |
| Slides (.pptx/.odp) | CLI `slides create/apply/read` 可读写；Mcode 另有 `slidesExecutor` 走 vendor `pptx-engine` | E1（format-gates 110/110） |
| PDF | CLI 仅文本层读取（`pdf read`）；编辑/签名/redaction 在 vendor PDF 主进程，CLI 不覆盖 | E2（`capabilitiesStatic().local/needsApp`，`ipc/document.ts:325-343`） |
| Markdown | `md → docx/html` 转换；`document.read` 对 md 走 `file.readFile`（路由拒绝，`genofficeFileRoute`/format-gates G3） | E1/E2 |
| HTML | CLI 侧 `html → docx` 需 app 渲染；`document.read` 对 html 返回 `unavailable`（G3） | E1/E2 |

### 1.2 GUI 层（本报告核心）

| 格式 | GUI 打开链是否存在 | GUI 编辑/保存链 | 已有真实 Electron 证据 | **真实 U1 状态** | 最大缺口 |
|---|---|---|---|---|---|
| Docs | 存在（`menu:command("open-path")` + handoff 拉取 + 回执） | Mcode 宿主 CAS/租约保存（`saveOpenedFile`），AI 走 Mcode 三引擎 | U1(harness)：open 39/39、electron 17/17、vendor-page 9/9、AI Ask 20/20（mock 模型） | **U1(harness) 正控；U1(shipped) 缺失** | **生产构建不产出 `documentViewPreload.js`**，发行包里 Docs 视图拿不到 `window.desktop` 桥（§2 发现 A）；原生工具同轮往返在已提交 HEAD 仍 fail-closed（T0 在飞） |
| Sheets | 存在（`createSheetsView` + `queueWorkbookForView` → 页面 `selectWorkbook`） | vendor 主进程 + Rust sidecar；保存有 vendor 级 sha 守卫，非 Mcode 租约 | 无真实 Electron；E1：真实 sidecar/真实 XLSX 21/21、Pane 围栏 109/109 | **E1 only，无 U1** | 无任何真实 Electron 打开/编辑/保存/重开；页面挂载时 `ai:get-settings` 在 Mcode 中被跳过注册（§3 Sheets） |
| Slides | 两条并存：vendor `createSlidesView(pendingByWc)` 与 Mcode `prepareSlidesOpen`+执行器 | 生产 vendor preload 走 `slides:save`（vendor 直写）；Mcode 执行器 CAS 只在 Mcode preload 路线 | U1(harness)：open 段真 vendor OpenResult + 保存重开；slides-edit 12/12（用 **vendor 全量 preload**） | **U1(harness) 正控（双路线之一）；U1(shipped) 缺失** | 生产 native 路线的保存**绕过 Mcode CAS/租约**（vendor `slides:save` 直写，§4 Slides）；生产 preload 只桥 2 个编辑操作，其余 ABI 为诚实桩 |
| PDF | 存在（`createPdfView(openPath)`，`genoffice-app://pdf`） | vendor 主进程保存（原子写 + 每 wc 路径授权），无 Mcode 租约 | 无真实 Electron；只有 fake view/资源/门禁 E1 | **E1/E2 only，无 U1** | 无 GUI 验收；发行 staging **不带 pdf preload**（发现 B）；`pdfium.wasm`/`hb-subset.wasm` 运行路径与 Mcode 资源布局不一致（§5 PDF） |
| Markdown | 存在（`createMarkdownView(openPath)`） | vendor 主进程保存（原子写 + 每 wc 路径授权） | 无真实 Electron | **E1/E2 only，无 U1** | 发行 staging 不带 markdown preload（发现 B）；本地图片 `md-asset://` 未注册为特权 scheme（E3） |
| HTML | 存在（`createHtmlView(openPath)`） | vendor 主进程保存（原子写 + 每 wc 路径授权） | 无真实 Electron | **E1/E2 only，无 U1** | 发行 staging 不带 html preload（发现 B）；`html-asset`/`html-preview` scheme 特权只由 vendor standalone 注册，Mcode 宿主未注册（E3） |

> **本报告不宣称六编辑器验收通过。** 六类中只有 Docs 与 Slides 有"真实 Electron + 真 vendor 页面"的正控，且两者都不是发行构建下的 U1。

## 2. 三个跨格式重大发现（全部 E2 + 构建产物事实）

### 发现 A：生产构建不产出 `documentViewPreload.js` —— Docs 原生视图在构建产物里没有桥

- 宿主为**非原厂 kind** 的视图（即 docs，`NativeKind` 只含 pdf/markdown/html/sheets/slides，见 `apps/desktop/src/main/document/genofficeViewFactories.ts:15-17`）创建 `WebContentsView` 时挂自己的 preload：`documentViewHost.ts:608-613` 调 `resolveViewPreload()`；该函数返回 `join(__dirname, "documentViewPreload.js")`（`documentViewHost.ts:410-419`），即构建后的 `out/main/documentViewPreload.js`。
- **生产构建配置从未声明这个入口**：`apps/desktop/electron.vite.config.ts` 的 `main.build.lib.entry` 只有 `src/main/index.ts`（`:215-216`），`preload` 段只有 `index` 与 `browserPicker`（`:304-318`）。`git rev-list --all -- electron.vite.config.ts` 的 22 个历史版本逐版 grep `documentViewPreload` **零命中**；`apps/desktop/build/*.cjs`、`scripts/*.mjs`、CI workflow 亦无该产物。
- 现成构建产物印证：`apps/desktop/out/preload/` 只有 `index.mjs`/`browserPicker.mjs`/`browserPicker.cjs`（`grep openDocxPath = 0`、`grep mcode:document-view = 0`）；`find apps/desktop/out -name "documentViewPreload*"` 为空；`grep -l installMcodeDocsViewPreload` 在 `out/` 下为空。
- 该文件只在**测试脚本自己打包**时存在：`document-view-electron-smoke/build.mjs:80-86`、`document-view-open-smoke/build.mjs:84-107`、`document-view-vendor-page-smoke/build.mjs:98-115`、`genoffice-ai-ask-smoke/build.mjs:81-141` 都把 `documentViewPreload.ts` esbuild 到探针目录，于是 `__dirname` 恰好同目录 → 探针绿；这**恰好解释了为何 17/17、39/39、9/9、20/20 全绿而发行面仍可能白屏**。
- 后果（E2 推断，未做发行版运行时复现）：Docs 页首帧读 `window.desktop.*`（`genoffice/apps/docs/src/renderer/App.tsx` 挂载 effect；`documentViewPreload.ts:1-40` 文件头记录过"缺首帧方法 React 19 整树卸载"），无桥 → 白屏。`document.capabilities.hosts.docs` 却**无条件报 true**（`apps/desktop/src/main/ipc/document.ts:324`），能力报告会与真实能力不符。
- **附带事实**：`electron.vite.config.ts` 的 `preload` 段确实有一条把 `@main/document/docsVendorPreload.js` 别名到 vendor `genoffice/apps/docs/src/preload/mcode-view.ts` 的规则（`:325-332`），但该别名只作用于被构建的 preload 入口；`documentViewPreload.ts` 不是入口，所以 **vendor 侧 0001–0009/0013 的受限 Docs preload 也从未进入任何生产 bundle**。`grep -rl installMcodeDocsViewPreload apps/desktop/out` 为空可佐证。
- 定级：**发行阻塞（Docs GUI）**；证据 E2 + 构建产物（`out/`）事实；最小复现建议见 §12。

### 发现 B：发行 staging 只复制 sheets/slides 的原厂 preload；pdf/markdown/html 在安装包里不可用

- 运行时判定：`genofficeViewFactories.ts:52-62` 对**每种 kind** 都用 `join(dirs[kind], "preload", "index.js")` 作为 `preloadPath`，并要求它存在才置 `status[kind]=true`；`status` 直接来自 `nativeHostStatus()`，被 `ipc/index.ts:148-152` 用来决定 `setVendorViewFactory` 与 `document.capabilities.hosts`。
- 但 staging 只带两家 preload：`apps/desktop/build/stage-genoffice-resources.cjs:431-440` 定义 `nativePreloads = ["sheets","slides"]`，`:505-515` 只复制这两家；`verify-genoffice-editors-after-pack.cjs:183-216` 的 `preloadNames` 同样只有 `["sheets","slides"]`；`genoffice-editors-release-smoke/main.cjs` 的夹具也只造这两家 preload。
- 后果（E2 + 代码事实）：即使 `MCODE_INCLUDE_GENOFFICE_EDITORS=1`，安装包内 `apps/pdf/out/preload`、`apps/markdown/out/preload`、`apps/html/out/preload` 缺失 → `status.pdf/markdown/html=false` → `GenofficeViewHostPane` 走"原厂视图不可用：缺少…预加载/渲染资源"的显式降级（`GenofficeViewHostPane.tsx:459-467`）→ **PDF/Markdown/HTML 三类原生 GUI 在发行包里不可用**，而开发仓里可用（`genoffice/apps/*/out/preload/index.js` 六家都存在，见 §0 的产物体检）。
- 定级：**发行阻塞（PDF/MD/HTML GUI）**。

### 发现 C：vendor 构建产物旧于 0013 补丁 —— ACK 工具通道不在 Docs 页面产物里

- `genoffice/apps/docs/out/renderer` 与 `out/preload` 时间戳为 2026-10-18/10-19，而 0013（ACK 协议）于 2026-10-22 落地。对 `apps/docs/out/renderer/assets/*.js` grep `ai:tool-result` / `aiToolResult` = **0 命中**；源码 `apps/docs/src/renderer/ai/transport.ts:7-10` 才刚引入 `window.desktop.aiToolResult`。
- 同理，六家 `out/renderer` 均早于 T29/T54/0011/0012 的 main 侧改动（main 侧在构建时被打进 Mcode 主进程，不受影响；renderer/preload 侧受影响）。
- 后果：任何"用现有 `genoffice/apps/*/out` 产物"的真实 Electron 验证，都**没有**验证到 0013 的 renderer 半边；发行前必须按 pinned HEAD 重新构建六家 renderer/preload 并重新生成资源 digest。
- 定级：**发行前置（证据真实性）**，不是缺陷本身。

## 3. Docs（.docx/.odt/.ott）

### 3.1 原生 UI 与内核源码

- 页面：`genoffice/apps/docs/src/renderer/`（ProseMirror/Tiptap 富文本，`editor/*.ts`、`App.tsx`、`file-actions.ts`）；构建产物 `genoffice/apps/docs/out/renderer/`（26 MB）。
- 内核包：`genoffice/packages/docx-engine`（分页/样式/表格/修订/媒体）、`packages/font-metrics`、`packages/file-parse`、`packages/docx-engine/{lazy-media,zip-splice,math}`；文档解析/序列化在 renderer，主进程只做文件与导出。
- 独立主进程（**Mcode 不用**）：`genoffice/apps/docs/src/main/docs-main.ts`（281 KB；文件对话框/任意路径/AI/密码/项目存储）。Mcode 只用受限入口：`mcode-ipc.ts`、`mcode-ai.ts`、`mcode-privileged.ts`、`patches/genoffice/0001..0009,0013`。

### 3.2 Mcode 侧实际调用链（E2）

1. **打开**：`FileEditor.tsx:118-147` 只有在用户把该文件切到 `genoffice-view` 档且 `document.capabilities().cli.available && hosts` 就绪时才渲染 `GenofficeViewHostPane`（默认档是 OnlyOffice/Milkdown/预览，见 §3.7）。
2. 渲染端 `GenofficeViewHostPane.tsx:264-272` 给出 `file://<...>/genoffice/apps/docs/out/renderer/index.html?mode=tab`；`useEffect` 里 `documentView.open({docId,url,bounds,visible,mcodeSessionId})`（`:288-339`）。
3. 宿主 `documentViewHost.ts:516-682`：URL 白名单（仅 file:// 与回环 http，`checkDocumentViewUrl`）→ 建 `WebContentsView`（`contextIsolation:true/nodeIntegration:false/sandbox:true`，`:610-613`）→ 挂 `resolveViewPreload()`（即 `documentViewPreload.js`）。
4. 渲染端再调 `documentView.openPath({docId,filePath})`（总入口 `ipc/documentView.ts:283-314`）→ `host.openPath`（`:806-865`）：工作区围栏 → 持锁预检 → 记 `pendingOpen` → `webContents.send("menu:command","open-path",path)`（vendor 唯一认识的形状）。
5. 页面 `openRecent(path)` → preload `openDocxPath` → invoke `mcode:document-view:read-opened`（`ipc/documentView.ts:129-149`）→ `host.readOpened`（`:879-936`）：围栏复核、非空、PK 魔数、大小上限、sha256、签发一次性 `genoffice-docx-media://handoff/<token>`（`documentViewHandoff.ts:52`）。
6. 页面解析并显示 → 调 `getRecentFiles()` → preload 转成 `mcode:document-view:open-committed`（`ipc/documentView.ts:153-174`）→ `settlePendingOpen`（`:947-975`）→ `claimOpenedPath` 提交会话、记 `openedFileRevision`。
7. **保存**：页面 `saveDocx(path,data)`（`file-actions.ts:1114`）→ preload 映射到 `mcode:document-view:save`（`genoffice/apps/docs/src/preload/mcode-view.ts:28`；页面传的 path 被忽略）→ `ipc/documentView.ts:541-589` → `host.saveOpenedFile`（`:1434-1574`）：会话持有者校验 → `withOsFileLease`（与 `file.writeFile` 同一把跨进程锁）→ `fileContentVersion` 比较 → `atomicReplaceFile`。新建首存走 `saveNewFile`（`:1609-1716`，目录锚定已打开文件所在目录，`fs.link` no-replace）。
8. **AI**：页面 `ai:stream` → `mcode-view.ts:51` → `mcode:docs:ai-stream` → vendor `mcode-ai.ts:300-390` 的 `requestRendererTool` ACK 协议（requestId/callId、schema 对照、重复/超时/取消拒绝）→ Mcode `docsAiPorts.ts`。
9. **导出/打印/附件**：`docs:pick-image/save-image-as/export-pdf/print/printers/files:*` 等 14 条 privileged 通道（`mcode-view.ts:32-48`）→ `docsPrivilegedPorts.ts:36-103`：Mcode 自己的 picker（`ipc/dialog.ts`）、`atomicReplaceFile`、`findContainingWorkspaceRoot`、每次打印真人确认（`:82-99`）。

### 3.3 打开/编辑/保存/重开：已验证到什么

| 行为 | 证据 | 等级 |
|---|---|---|
| 真 Electron 下 docs 页挂载、`window.desktop` 桥注入、`menu:command("open-path")` 端到端到达页面 | `document-view-electron-smoke` 17/17（日志 `1792584727328-35168-iRgjl0`） | U1(harness) |
| 真实 vendor docs 页在**生产 preload 源码**下首帧零异常、`.ProseMirror/.doc-page` 出现 | `document-view-vendor-page-smoke` 9/9（日志 `1792597170741-37972-EBd5ES`；页面为 `file://` 产物，preload 由套件打包） | U1(harness) |
| 打开指定 DOCX → DOM 出现唯一文本 → 编辑 → 保存写回 → 关闭重开字节回读 → 脏拒绝/坏档/越界/过期版本冲突 | `document-view-open-smoke` 39/39（日志 `1792594721069-21264-MPBmMV`；测试内的"编辑"用等价字节模板，不是 vendor `buildDocBytes`） | U1(harness) |
| AI Ask：选中 → 浮动 chip → 气泡 → 队列 → mock SSE + 工具调用 → 文档被改 → 静默首存落盘 | `genoffice-ai-ask-smoke` 20/20（`checks.json` 时间 2026-10-22 01:34，`.tmp/genoffice-ai-ask-IjVfsP`；**mock 端点 + 探针追加 AI 桥**，生产 preload 明确无 `aiStream`） | U1(harness, mock 模型) |
| 宿主 CAS/租约/冲突/围栏/持有者唯一 | `document-view-host-smoke`（含 500+ 条历史断言；最新日志 `1792604023391-1444-jDXkcA`） | E1 |
| 工具结果同轮 ACK 协议（vendor 侧） | `t98-docs-tool-result-ack-smoke` 55/55（日志 `1792656756330-42852-kxtSLK`） | E1 |
| **发行构建里 Docs 桥存在** | **不存在**（§2 发现 A；`out/` 无 `documentViewPreload.js`） | E2 + 产物 |
| 原生 AgentSkill 工具同轮往返（Mcode Host 侧） | 已提交 HEAD `2c93f70e` 仍 fail-closed：`docsAiPorts.ts:113` 调 `nativeEditorToolBridgeBlockReason`，三引擎 status 全为 `needs upstream`（`nativeEditorToolTransport.ts:21-34`）。调查中 `eb3f1e0b` 工作树出现 T0 的未提交实现（`externalTools`+`externalToolHandler`+新 smoke），**尚未提交、未验收** | E2（HEAD）/ E3（工作树） |

### 3.4 导入导出、AI、原生资源

- 导入：仅 `.docx`（README 声称 odt/ott 路由到 docs，但 Docs preload 只接受 `isLikelyDocx` 的 PK 魔数，见 `documentViewHost.ts:208-210,917-919`；odt/ott 是否能打开未验证，E3）。图片/附件经 `docs:pick-image`/`files:*`（E2）。
- 导出：PDF（Chromium print，`docs:export-pdf`/`print-pdf-buffer`/`save-merged-pdf`）、图片（`pick-export-images-target`/`write-export-image`）→ `docsPrivilegedPorts` 的原子写与临时目录（`exportTempRoot` 在 dataRoot/docs/export-tmp）。T22 真 Electron 断言（DOCX→PDF→PNG 写盘、临时文件不泄漏）在 `document-view-open-smoke` 内通过（U1(harness)）。
- AI：Mcode 三引擎会话（`docsAiPorts.ts:46-55` 绑定 Mcode 会话与工作区），**不使用** GenOffice 云账户；工具调用在 HEAD 仍拒绝（§3.3 末行）。
- 原生资源：renderer 26 MB（字体、字体度量、分页）；无 Rust sidecar；`genoffice-app` 协议由 Mcode 提供（`genofficeViewFactories.ts:96-117`，含 symlink 逃逸防护）。

### 3.5 既有测试

- GenOffice 自带：`genoffice/apps/docs/tests` **393 个 test 文件**（`docs-main`/renderer/agent/分页/AI 等），`npm run test -w @genoffice/docs`（vitest）。本次未运行（只读）。
- Mcode：`document-view-host/open/electron/vendor-page/renderer-smoke`、`genoffice-ai-ask-smoke`、`t98-docs-tool-result-ack-smoke`、`t83-mcode-editor-tool-bridge-smoke` 19/19、`genoffice-native-view-smoke`（docs 相关段）、`document-read-smoke`、`genoffice-format-gates-smoke`。
- 变异证据：`document-view-open-smoke` 支持 `MCODE_T05A_MUTATE_SCOPE=1`（越界误放行必红）；`document-view-electron-smoke` 内置 `--mutate-bounds/--mutate-reload`；`document-view-host-smoke` 有 `mutate-native-docs.mjs`。

### 3.6 许可证来源

- GenOffice 根 `LICENSE` = Apache-2.0；`NOTICE` 声明 Copyright 2026 Mainfunc, Inc.；`apps/shell/build/THIRD-PARTY-NOTICES.txt`（1.39 MB，570 个 npm 包段）由 `tools/gen-third-party-notices.mjs` 生成。
- 第三方缺口见 §11：当前 manifest **8/18 verified、10 blocked、`releaseEligible=false`**。

### 3.7 真实 U1 状态与缺口

- **U1(harness) 正控**：打开/编辑/保存/重开/脏拒绝/AI Ask（mock）都有真实 Electron 证据，但 preload 与页面来源是套件自造。
- **U1(shipped) = 缺失**：发现 A（桥不产出）+ 发现 C（产物旧）。
- 默认 UI 路径不是 GenOffice：`FileEditor.tsx:118-151,184-207` 默认 office→OnlyOffice、md→Milkdown、pdf→`PdfPreviewPane`、html→Monaco `edit`（浏览器预览是工具栏按钮 `canPreviewHtml`）；GenOffice 原生视图需用户显式切到 `genoffice-view`（`FileEditor.tsx:147,229-231`）。
- 最大缺口：**生产 preload 构建接线**；其次是 T0 同轮工具往返（在飞）、真实三 SDK 在线回合。

## 4. Sheets（.xlsx/.xlsm/.xls/.csv/.ods）

### 4.1 原生 UI 与内核

- 页面：`genoffice/apps/sheets/src/renderer/`（**Univer 0.25.x**，`createUniver()` 于 `App.tsx:129,1749`）；构建产物 34 MB。
- 内核：`packages/xlsx-gateway`（JS xlsx 读写/公式缓存）、`apps/sheets/native/xlsx-engine`（**Rust `xlsx-sidecar`**，8.9 MB exe + PROVENANCE.md）、`packages/file-parse`、`packages/docx-engine`（导出 docx）。
- 独立主进程（Mcode 不用其生命周期）：`apps/sheets/src/main/sheets-main.ts`（233 KB）；Mcode 通过 `mcode-sheets-scoped.ts`（补丁 0011）把原 handler 包进 sender/路径围栏后**原地复用**。

### 4.2 Mcode 调用链（E2）

1. 能力：`genofficeViewFactories.ts:52-62` 要求 `out/preload/index.js` + `out/renderer/index.html` + Rust sidecar 三者都是普通文件才 `hosts.sheets=true`；`document.capabilities` 报 `hosts.sheets`（`ipc/document.ts:324`）。
2. 打开：`GenofficeViewHostPane.tsx:264-272` 用 `genoffice-app://sheets/index.html`；`documentView.open({editor:"sheets",filePath})` → `documentViewHost.ts:516-682`：文件必须存在且在工作区内 → `vendorCreateView(filePath,"sheets")` = `genofficeNativeVendor.ts:63-67` 的 `createSheetsView({includeAiHandlers:false, openingWorkbook:true})` + `queueWorkbookForView(view.webContents,path)`。
3. `createSheetsView`（`sheets-main.ts:2453-2490`）建视图、`registerSheetsIpc()`（`:2723-2730`，全局一次）、`registerSheetsSession`、loadURL `?mode=tab&openingWorkbook=1`。
4. 页面侧：`renderer/main.tsx:91-96` 在首帧前 `hasQueuedWorkbook()`；`App.tsx:1899-1902` 轮询到排队后 `handleInspectWorkbook()` → `window.desktopApi.selectWorkbook()`（`preload/index.ts:107-108`）→ `sheets-main.ts:2882-2890` → `openSelectedWorkbook`（`:2820-2880`）读 `queuedWorkbookPaths`（`:2240-2246`，key = webContents.id）→ `prepareWorkbookForOpen` + `openWorkbookSession`。
5. 围栏：`mcode-sheets-scoped.ts:104-106` 只包 `slides:|sheets:|workbook:|shell:` 前缀；`:122-147` 校验 sender 属于本 Pane、分类 A（路径）/B（拒绝屏幕采集/字体安装）/C（http(s) 外链）、`slides:save` 额外要求 `documentPath`；`:198-203` 的 `defaultDocumentDirectory` 把新建/另存锚定到宿主打开的文件目录。Mcode 注入的 guard 在 `genofficeNativeVendor.ts:21-33`（`docIdForSender` + `editorOf` + `findContainingWorkspaceRoot`）。
6. 保存：页面 `workbook:save` → `sheets-main.ts:3363-3475`：CSV 原地写、`.xlsm` 保扩展名、Save As、恢复副本；外部改动检查用 **vendor 自己的 sha256**（`:3433-3456`）；写盘 `writeWorkbookTo`（sidecar/JS 路径）。**不经过 Mcode 的 `withOsFileLease`/`saveOpenedFile`**。

### 4.3 已验证行为

| 行为 | 证据 | 等级 |
|---|---|---|
| 真 Rust sidecar 打开真实 XLSX、读 range、未修改不改写一个字节；真实 `xlsx-gateway` 写回；无 sidecar 时 fail-closed | `genoffice-native-view-smoke` 的 `real.ts` 21/21（日志 `1792604023391-1444-jDXkcA`；隔离 temp 工作区） | E1（真二进制、真文件；无 Electron） |
| Pane 围栏：越界读写/外部链接/屏幕采集拒绝、两个变异必红、源文件 SHA 复原 | `genoffice-pane-fence-smoke` 109/109 + MUTATION A/B（日志 `1792584727328-35168-iRgjl0`） | E1 |
| 视图状态机（围栏先于工厂、单文件持有、hide/show 保活、关闭字节不变） | `genoffice-native-view-smoke/main.ts`（fake view） | E1 |
| 页面能挂载、能打开、能编辑、能保存、能重开 | **无** | — |

### 4.4 导入导出、AI、原生资源

- 导入：xlsx/xlsm/xls/ods/ots/csv/tsv（`genofficeFileRoute` 的 XLSX_RE）；xls/ods 走转换副本、首存另存为 xlsx；宏工作簿 `.xlsm` 保 `vbaProject.bin`。E2。
- 导出：PDF（自有 `pdf-export.ts` + 隐藏窗口）、CSV、图片；保存/另存为/合并（`workbook:select-for-merge`/`open-for-merge`）均在 `PATH_OPERATIONS` 围栏内。E2。
- AI：Mcode **关闭**了 sheets 自己的 AI handler 注册（`includeAiHandlers:false`，`genofficeNativeVendor.ts:64`），`registerSheetsAiIpc`（sheets 版 `ai:get-settings`/`ai:stream`）不注册。但 `ai:*` 通道由**共享的视图 AI 桥** `mcode-view-ai.ts` 全局注册（`ipc/index.ts:153-159`，条件是任一 native host 就绪；`MCODE_VIEW_AI_HANDLERS` 见 `mcode-view-ai.ts:31-37`），其 `authorized()` 经 `vendorAiContextForSender` 接受 sheets（`documentViewHost.ts:1081-1088` 明确包含 sheets）。因此页面挂载时的 `getAiSettings()`（`App.tsx:1728-1732`）拿到的是 Mcode 兼容形状（`mcode-view-ai.ts:151-160`），**不是无 handler**。注意：该桥的 `stream` 最终调 `docsAiPorts.run`，携带 renderer 工具 schema 的请求在 HEAD 会以 `unsupported:` 拒绝（`docsAiPorts.ts:113`、`nativeEditorToolTransport.ts:82-94`）；纯文本请求可走 Mcode 会话。
- Sheets 自身仍注册 `sheets:ai-generate-image`（`sheets-main.ts:2732-2749`），受 `sheets:` 前缀围栏（`mcode-sheets-scoped.ts:104-106`），**会**被 `ownsSender` 校验——与 `ai:*`（无前缀、不受 Pane 围栏、改由视图 AI 桥的 sender 绑定）是两条不同通道。
- 原生资源：Rust sidecar（dev 路径 `genoffice/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe`；发行 `resources/genoffice/native/xlsx-sidecar`）；staging 校验存在/非空/sha（`stage-genoffice-resources.cjs:445-460`）；afterPack 复验（`verify-genoffice-editors-after-pack.cjs:183-216`）。

### 4.5 测试与许可证

- vendor：`genoffice/apps/sheets/tests` **327 个 test 文件**；`npm test -w @genoffice/sheets` 还会先跑 `native:test`/`native:build`（需 Rust 工具链）。
- Mcode：`genoffice-native-view-smoke`、`genoffice-pane-fence-smoke`、`genoffice-file-routing-smoke`（比对 `app-routing.ts`）、`genoffice-format-gates-smoke`、`document-view-renderer-smoke`（渲染端显式降级断言）。
- 许可证：同 §11；Sheets 侧依赖（Univer、@fluentui、fast-xml-parser、jszip、pdf-lib 等）已进 570 段 notice，其中 18 个缺全文的包里有 Univer protocol 等（见 §11）。

### 4.6 U1 状态与最大缺口

- **E1 only，无任何真实 Electron/真实页面证据**。最大缺口：**没有一次"真 Electron 打开真实 xlsx → 编辑单元格/公式 → 保存 → 重开回读"的 U1**；其次是 `ai:*` 视图桥虽已注册，但携带原生工具 schema 的请求在 HEAD 仍 fail-closed（同 Docs），以及无需 Pane 围栏的 `ai:*` 通道与 `sheets:`/`workbook:` 围栏通道并存造成的边界不直观（E2，需安全复核）。

## 5. PDF（.pdf）

### 5.1 原生 UI 与内核

- 页面：`genoffice/apps/pdf/src/renderer/`（pdf.js 6.x/`pdfjs-dist` 渲染 + 文本层编辑、注释、表单、签名、redaction）；构建产物 8.1 MB（含 `pdfjs/`）。
- 内核：`packages/pdf2docx`（PDFium 文本抽取）、`@embedpdf/pdfium@2.15.1`（WASM）、`harfbuzzjs`（字体子集，`hb-subset.wasm`）、pdf-lib、pdfjs-dist。
- 主进程：`apps/pdf/src/main/pdf-main.ts`（82 KB）+ `save-pdf.ts`（53 KB）+ `text-edit.ts`（107 KB）+ `redaction.ts`/`pdf-sign.ts`/`pdf-signatures.ts`；打开/保存链是 **vendor 自己的**，Mcode 只提供视图工厂与 AI 桥。

### 5.2 Mcode 调用链（E2）

1. `GenofficeViewHostPane.tsx:264-272` → `genoffice-app://pdf/index.html`；`open({editor:"pdf",filePath})` → `documentViewHost.ts:516-682` → `genofficeNativeVendor.ts:58-60` 的 `createPdfView(path)`。
2. `createPdfView`（`pdf-main.ts:2042-2055`）：`registerPdfIpc()`（全局一次）→ `WebContentsView{preload: runtime.preloadPath}` → `grantAndTrack(wc, openPath)`（`:2007-2040`：按 webContents.id 存 `allowedByWc`/`openPathByWc`，`setWindowOpenHandler` 只放 http/https/mailto 到系统浏览器）→ `loadURL(genoffice-app://pdf/index.html)`。
3. 页面首帧 `consumePending`（`pdf-main.ts:1145`）拿 `openPathByWc` 的路径；`readFile`（`:1173-1177`）只读被授权的路径。
4. **保存**：`PDF_CHANNELS.save`（`:1199-1266`）→ `savePdfToPath`（`save-pdf.ts:1182-1194`）：读源字节 → `applySaveRequest` → `verifyContentEdits` → `writePdfAtomically`（`atomic-write.ts:13-40`，独占临时文件 + fsync + rename）。redaction 必须 Save As 副本（`:1218-1240`）。**无 Mcode 租约/CAS**；并发保护来自「每 wc 授权路径」与 vendor 原子写本身。
5. AI：`mcode-view-ai.ts`（补丁 0010）注册 `ai:*` 15 条通道，sender→Mcode 会话绑定由 `documentViewHost.vendorAiContextForSender` 提供（`documentViewHost.ts:1081-1088`）；每次 prompt 弹 `docsAiPorts.confirm`（`mcode-view-ai.ts:122-131`）；`get-settings` 只回 Mcode 引擎名，`gsk-login`/`web-search` 等一律可读拒绝（`:160-178`）。

### 5.3 已验证行为

| 行为 | 证据 | 等级 |
|---|---|---|
| 视图工厂在 sidecar/renderer/preload 缺失或围栏外时拒绝 | `genoffice-native-view-smoke`（fake view） | E1 |
| 六 renderer/wasm/sidecar 可被 staging/afterPack 校验（含 PDFium WASM magic） | `genoffice-editors-release-smoke` 25/25、`t76`/`t87` smoke | E1 |
| 真 Electron 打开真实 PDF、文本/注释编辑、保存重开 | **无** | — |
| 发行包内 PDF 原生视图可用 | **否**：preload 未 staging（§2 发现 B） | E2 + 产物 |

### 5.4 资源/许可证要点

- `pdfium.wasm`：dev 由 `genoffice/node_modules/@embedpdf/pdfium/dist/pdfium.wasm` 解析；打包回落 `process.resourcesPath/wasm/pdfium.wasm`（`genoffice/apps/pdf/src/main/wasm-path.ts:10-19`）。Mcode 的 staging 把它放在 `resources/genoffice/wasm/pdfium.wasm`（`stage-genoffice-resources.cjs:494-498`），**与 vendor 回落路径不一致**；`hb-subset.wasm` **完全没有**被 Mcode staging。→ 发行包内 PDF 文本编辑/字体子集在 `createRequire` 解析失败时会找不到 WASM（**E2 推断，未在安装包验证**）。定级：发行前置/潜在阻塞。
- 许可证：PDFium LICENSE/LICENSE.pdfium 与 GenOffice 许可由 staging 收入（`stage-genoffice-resources.cjs:410-420`）；strict bundle 仍被 §11 的 18 项门禁阻断。

### 5.5 U1 状态与最大缺口

- **E1/E2 only，无 U1**。最大缺口：没有任何真实 Electron 的 PDF 打开/编辑/保存/重开证据；其次是发行 staging 的 preload 与 WASM 布局两处不一致。

## 6. Slides（.pptx/.odp/.otp）

### 6.1 原生 UI 与内核

- 页面：`genoffice/apps/slides/src/renderer/`（Konva 画布 + 缩略图 + 文本编辑，`SlideCanvas`）；构建产物 8.3 MB。
- 内核：`packages/pptx-engine`（open/save zip 事务）、`pptx-ops`（runTxn）、`pptx-render`（buildRenderSlide）、`harfbuzzjs`/`utif2`/`pngjs`；主进程 `apps/slides/src/main/slides-main.ts`（206 KB）、`session-state.ts`、`ai-ipc.ts`、`slides-ai-boundary.ts`（补丁 0011/0012）。

### 6.2 Mcode 两条并存路线（E2）

- **路线 1（生产 native，vendor 全量）**：`documentView.open({editor:"slides",url:"genoffice-app://slides/index.html",filePath})` → `genofficeNativeVendor.ts:68` `createSlidesView(path)`（`slides-main.ts:5066-5083`）→ 视图挂 **vendor preload**，`pendingByWc.set(wc.id,path)` → 页面挂载调 `consumePendingOpen`（`preload/index.ts:150`）→ vendor `slides:consume-pending-open` → `openAndBuild` → 页面渲染。保存 `slidesApi.save()` → `slides:save`（`slides-main.ts:4583-4610`）→ `savePptxToFile(session.path)` **直写**（只有 `mcodePane` 的 sender/路径围栏；未命名 deck 落 `defaultDocumentDirectory`）。
- **路线 2（Mcode preload + 执行器 CAS，测试主用）**：`documentView.openPath`（`ipc/documentView.ts:286-307`）检测 `editorOf==="slides"` → `prepareSlidesOpen`（`documentViewHost.ts:991-1022`）→ `slides.openDeck(webContentsId,docId,path,1280)`（`slidesExecutor.ts`，内部调 vendor `openPptx`+`buildRenderSlide`）→ 缓存并 `slides:opened` 推送 → 页面 `slides-read-opened`（`ipc/documentView.ts:397-455`）→ `settleSlidesOpen` 提交会话。保存 `mcode:document-view:slides-save`（`:465-493`）→ `slidesExecutor.saveDeck`（`slidesExecutor.ts:254-340`）：`withOsFileLease` + `fileContentVersion` 比较 + 同目录 staging + rename，含 `SLIDES_FILE_VERSION_CONFLICT`/`SLIDES_POST_COMMIT_UNCERTAIN` 语义。
- **生产环境实际走哪条**：`GenofficeViewHostPane.tsx:259-272` 在 `nativeHosts.slides===true` 时用 `genoffice-app://slides/index.html` + `editor:"slides"` + `filePath`，宿主 `open()` 的 `kind` 非空（`documentViewHost.ts:517-518`）→ **路线 1 建视图**；随后面板仍调 `openPath`，`onOpenPath` 又走路线 2 的 `prepareSlidesOpen`。两条 OpenResult 会同时被准备（vendor `pendingByWc` 与 Mcode `pendingOpen`），页面先消费哪一条取决于挂载时序。**该双开是否造成重复会话/双写机会，未有 U1 证据（E3）**；保存按钮在 vendor 页面里走 `slidesApi.save`（路线 1），Mcode 执行器 CAS（路线 2）在 native 视图里不生效。

### 6.3 已验证行为

| 行为 | 证据 | 等级 |
|---|---|---|
| Mcode 生产路由：`openPath` 经 executor 解析真实 pptx → 页面拉取 OpenResult（含 render tree）→ 页面显示文件名/缩略图；保存写回同一文件；重开仍含唯一文本（真 zip 往返）；工作区外拒绝 | `document-view-open-smoke` slides 段（同一 39/39 日志） | U1(harness) |
| 真实 vendor slides 页 + **vendor 全量 preload** + vendor `registerSlidesIpc`：加页→加文本框→改文字→保存→重开 | `slides-edit-smoke` 12/12（日志 `1792584727328-35168-iRgjl0`；保存落隔离 `documents/GenOffice`） | U1(harness, vendor preload) |
| 执行器会话 epoch/保存竞态/结果契约 | `slides-executor-session-epoch-smoke`、`slides-save-add-race-smoke`、`slides-bridge-*`（5/5 attach）、`slides-preload-abi-smoke` | E1 |
| Pane 围栏（含 slides 导出/保存/媒体路径） | `genoffice-pane-fence-smoke` 109/109 | E1 |
| 发行包内 slides 原生视图可用 | preload 已 staging；但 renderer/preload 产物旧于 0012/0013（发现 C），且无 packaged U1 | E2 |
| 双路线并存下的唯一打开/保存所有权 | **未验证** | E3 |

### 6.4 导入导出、AI、原生资源

- 导入：pptx/odp/otp；odp 需转换副本（E2）。
- 导出：PDF（`slides:export-pdf`）、逐页 PNG（`slides:export-images`）、打印、全屏放映（`slides:show-fullscreen`，C 类）、`slides:save-picture`、媒体插入（图片/音频/视频/3D）——全部在 `PATH_OPERATIONS`/`ALLOWED_EFFECTS` 分类内（`mcode-sheets-scoped.ts:38-58`）。字体安装/下载/录制/麦克风被 B 类拒绝（`:28-35`）。
- AI：vendor 仍有自己的 `ai:stream` 实现（`ai-ipc.ts:123-302`），但 **Mcode 的 `createSlidesView` 不调用 `registerAiIpc`**（只在 `startSlidesStandalone` 调，`slides-main.ts:5280`），因此 Mcode 视图里 slides 的 `ai:*` 由 `mcode-view-ai.ts`（0010）接管；Slides-only AI 通道在 hosted 模式注册可读拒绝（`registerSlidesOnlyAiIpc(isMcodeHosted)`，`slides-main.ts:4835`；`slides-ai-boundary.ts:27-54`）。生产 Mcode preload 的 `slidesApi` 只桥了 `getAiSettings` 桩，**没有** `aiStream/onAiStream`（`documentViewPreload.ts` 的 slidesApi 键表），即路线 2 下幻灯片页面 AI 面板无法发起请求（诚实桩）；路线 1 用 vendor preload 时会调 `ai:stream`，由 Mcode 视图 AI 桥处理。
- 原生资源：无 sidecar；`slides/renderer`、`slides/out/preload`（staging 已带）。

### 6.5 测试与许可证

- vendor：`genoffice/apps/slides/tests` **138 个 test 文件**（含 `ai-*`、动画、剪贴板、字体）。
- Mcode：`slides-edit-smoke`（真 Electron）、`slides-bridge-attach/result/epoch`、`slides-save-add-race`、`slides-preload-abi`、`t84-slides-ai-boundary`、`genoffice-pane-fence`。
- 许可证：同 §11（pptx 依赖、harfbuzzjs、utif2 等已入 notice；缺全文包见 §11）。

### 6.6 U1 状态与最大缺口

- **U1(harness) 正控存在于两条路线各自的 harness**；**没有 U1(shipped)**。
- 最大缺口：① 生产 native 视图的保存走 vendor 直写、**无 Mcode CAS/租约**，与 `slidesExecutor` 的 CAS 语义分叉，双路线打开时序未验证；② 生产 Mcode preload 只桥 2 个编辑操作（`addBlankSlide`/`editText`），其余（动画/备注/版式/图表数据）按 `docs/planning/arc007-genoffice-native-integration-map.md` 所述仍为硬编码空值桩——使用 vendor preload 的 native 路线则绕开这些桩，但代价是保存所有权移交 vendor；③ 无安装包 U1。

## 7. Markdown（.md/.markdown；`.txt/.json` 仍走 Mcode 代码源文本）

### 7.1 原生 UI 与内核

- 页面：`genoffice/apps/markdown/src/renderer/`（Tiptap + CodeMirror 源档 + Mermaid/WaveDrom/Katex）；构建产物 15 MB。
- 内核：`@tiptap/*`、`katex`、`mermaid`、`wavedrom`、`json5`、`pdfjs-dist`；主进程 `markdown-main.ts`（52 KB）含 `md-asset://` 图片协议、wiki 索引/反链、Markdown→PDF/DOCX 导出、无头导出。

### 7.2 Mcode 调用链（E2）

- `FileEditor.tsx:118-147`：md 默认档是 Mcode 自己的 Milkdown（`MarkdownEditorPane`），只有用户显式切 `genoffice-view` 且 `hosts.markdown===true` 才进 `GenofficeViewHostPane`。
- `open({editor:"markdown",filePath})` → `documentViewHost.ts:516-682` → `createMarkdownView(path)`（`markdown-main.ts:1327-1340`）：`registerMarkdownIpc()` → vendor preload → `grantAndTrack`（`:1242-1267`：`openPathByWc`/`savePathByWc`/`allowedByWc`）→ `genoffice-app://markdown/index.html`。
- 页面 `consumePending`（`:749`）拿路径；`readFile`（`:776`）只读授权路径。
- 保存：`MARKDOWN_CHANNELS.save`（`:820-900`）：`resolveSaveTarget` → `writeTextAtomic`（`atomic-write.ts`）→ 资产（图片）对账/回滚 → 更新 `savePathByWc`。**无 Mcode 租约/CAS**。
- 图片：`md-asset://`（`:709-735`）只服务"打开文档目录内、扩展名白名单"的图片；`resolveSafeRelativeImagePath` 复用 `asset-lifecycle.ts`。
- 导出：DOCX（`exportDocx`）、PDF（Chromium print）、导出图片、无头导出（`--headless-export`，隐藏窗口 + `headlessExportTargets`）。AI：走 `mcode-view-ai.ts`（0010）的 `ai:*`，与 PDF 同一条 Mcode 会话桥。

### 7.3 已验证行为

| 行为 | 证据 | 等级 |
|---|---|---|
| 视图工厂/资源门禁/无 sidecar 依赖 | `genoffice-native-view-smoke`（fake view） | E1 |
| 共享格式路由（md→markdown，.txt/.json 仍代码文本） | `genoffice-file-routing-smoke`、`genoffice-format-gates-smoke` G3 | E1 |
| 真 Electron 打开 md、编辑、保存、重开 | **无** | — |
| 发行包内 markdown 原生视图可用 | **否**：preload 未 staging（§2 发现 B） | E2 + 产物 |
| `md-asset://` 在 `genoffice-app://` 安全页下能加载本地图片 | **未验证**；`registerRendererScheme()` 只注册 `genoffice-app` 与 `genoffice-docx-media` 两个特权 scheme（`packages/electron-utils/src/renderer-scheme.ts:5-30`），`md-asset` 只被 `protocol.handle` 而未进入特权列表。是否被 mixed-content/CORS 阻挡，未实测 | E3 |

### 7.4 测试与许可证

- vendor：`genoffice/apps/markdown/tests` **57 个 test 文件** + `tests/browser`；Mcode：`markdown-mode/preview/quote/image-path/write-cache-budget-smoke`、`genoffice-file-routing`、`genoffice-format-gates`。
- 许可证：同 §11；`katex`/`mermaid` 等已入 notice。

### 7.5 U1 状态与最大缺口

- **E1/E2 only，无 U1**。最大缺口：发行 preload staging（发现 B）+ 无真实 Electron 打开/编辑/保存/重开；`md-asset://` 特权问题（E3）。

## 8. HTML（.html/.htm）

### 8.1 原生 UI 与内核

- 页面：`genoffice/apps/html/src/renderer/`（CodeMirror 6 源码编辑 + 预览 iframe/Inspector + 元素级 Ask AI）；构建产物 2.8 MB。
- 内核：`packages/html2docx`（HTML→DOCX）、`packages/file-parse`；主进程 `html-main.ts`（80 KB）含 `html-asset://`、`html-preview://` 预览协议、单文件导出、present 视图。

### 8.2 Mcode 调用链（E2）

- `FileEditor.tsx` 的 HTML 默认档是 Mcode 浏览器预览；原生档要 `hosts.html===true` 且用户切 `genoffice-view`。
- `open({editor:"html",filePath})` → `createHtmlView(path)`（`html-main.ts:1941-1954`）：`registerHtmlIpc()`（`registerImageProtocol` + `registerPreviewProtocol`，`:1275-1285`）→ vendor preload → `grantAndTrack`（`:1828-1847`）→ `genoffice-app://html/index.html`。
- 保存：`HTML_CHANNELS.save`（`:1377-1460`）：`resolveSaveTarget` → `atomicWriteFile`（`atomic-write.ts`）→ 资产对账；**无 Mcode 租约/CAS**。
- 导出：DOCX（`html2docx`）、PDF、逐页图片、单文件 HTML（`single-file-html.ts`）、present 视图（`createHtmlPresentView`，只渲染 owner 的预览，`:1868-1885`）。AI：`ai:*` 经 `mcode-view-ai.ts`；页面另有 iframe `postMessage("askAi")` 与 Inspector 入口（`docs/planning/genoffice-ai-interaction.md` §1.4）。

### 8.3 已验证行为

| 行为 | 证据 | 等级 |
|---|---|---|
| 视图工厂/资源门禁 | `genoffice-native-view-smoke` | E1 |
| 路由（html→html，未知扩展名拒绝） | `genoffice-file-routing-smoke`、format-gates G3 | E1 |
| 真 Electron 打开/编辑/保存/重开 | **无** | — |
| 发行包内 html 原生视图可用 | **否**：preload 未 staging（§2 发现 B） | E2 + 产物 |
| `html-preview://`/`html-asset://` 在 Mcode 宿主可用 | **未验证**：`registerPrivilegedSchemes()` 只在 vendor `startHtmlStandalone`/`createHtmlPresentView` 路径使用；Mcode `main/index.ts:67-72` 只注册 `mcode-panel`/`genoffice-docx-media`/`genoffice-app`。非特权自定义 scheme 能否作为 `<img>`/iframe 子资源被 secure 页面加载，未实测 | E3 |

### 8.4 测试与许可证

- vendor：`genoffice/apps/html/tests` **37 个 test 文件**（含 asset-lifecycle、preview、i18n）。
- Mcode：`html-preview-electron-smoke`（**测的是 Mcode 自己的 HTML 浏览器预览，不是 GenOffice HTML 编辑器**）、`genoffice-file-routing`、format-gates。
- 许可证：同 §11；`html2docx` 相关依赖已入 notice。

### 8.5 U1 状态与最大缺口

- **E1/E2 only，无 U1**。最大缺口：发行 preload staging + 无真实 Electron 打开/编辑/保存/重开；宿主未注册 html 预览/资产 scheme 特权（E3）。

## 9. 六类对照：保存所有权、围栏与 CAS

| 格式 | 生产 GUI 使用的 preload | 保存入口 | 保存写盘实现 | Mcode 租约/CAS | 路径围栏 |
|---|---|---|---|---|---|
| Docs | Mcode `documentViewPreload.ts`（**构建未产出**，发现 A） | `mcode:document-view:save` | `atomicReplaceFile`（`documentViewHost.ts:1434-1574`） | **有**（`withOsFileLease` + sha256） | 会话持有者 + `withinWorkspace` |
| Sheets | vendor `apps/sheets/out/preload`（staging 已带） | `workbook:save` | `writeWorkbookTo`（sidecar/JS） | 无（vendor 级 sha 守卫，`sheets-main.ts:3433-3456`） | `mcode-sheets-scoped.ts` A 类 |
| Slides（native 路线） | vendor `apps/slides/out/preload`（staging 已带） | `slides:save` | `savePptxToFile` 直写（`slides-main.ts:4583-4610`） | 无（vendor 内部） | `mcode-sheets-scoped.ts` A 类 + `documentPath` |
| Slides（Mcode preload 路线） | Mcode `documentViewPreload.ts`（构建未产出） | `mcode:document-view:slides-save` | `slidesExecutor.saveDeck`（staging+rename） | **有**（`withOsFileLease` + revision） | 宿主 pendingOpen + saveTarget |
| PDF | vendor `apps/pdf/out/preload`（**staging 未带**） | `pdf:save` | `writePdfAtomically`（`save-pdf.ts:1182-1194`） | 无 | 每 wc `allowedByWc` |
| Markdown | vendor `apps/markdown/out/preload`（**staging 未带**） | `markdown:save` | `atomicWriteFile`（`markdown-main.ts:820-900`） | 无 | 每 wc `allowedByWc` |
| HTML | vendor `apps/html/out/preload`（**staging 未带**） | `html:save` | `atomicWriteFile`（`html-main.ts:1377-1460`） | 无 | 每 wc `allowedByWc` |

> 含义：**"共享实现只有一份"（CLAUDE.md 硬规矩 2）在六格式上未成立**——保存路径按格式分叉成 3 套（Mcode host CAS / Mcode slides executor CAS / vendor 原子写），且只有 Docs 与 Slides-路线2 的写盘经过 `withOsFileLease`。这是后续卡必须裁决的架构事实，本报告只登记、不改策略。

## 10. AI 交互矩阵（GUI）

| 格式 | 面板来源 | 生产是否已接 Mcode 三引擎 | 原生工具（AgentSkill）同轮往返 | 证据 |
|---|---|---|---|---|
| Docs | vendor Docs AI 面板（selection→Ask→队列→侧栏） | 是（`mcode-ai.ts` + `docsAiPorts.ts`），每 prompt 真人确认 | **HEAD 否**（fail-closed，`docsAiPorts.ts:113`）；T0 工作树在飞 | E2 + U1(harness, mock) |
| Sheets | vendor Sheets AI 面板 | 部分：`ai:*` 由共享视图 AI 桥（`mcode-view-ai.ts`）处理，`vendorAiContextForSender` 接受 sheets；工具 schema 请求 HEAD 仍 fail-closed | 否 | E2 |
| Slides（native 路线） | vendor Slides AI 面板（`ai:*` 由 `mcode-view-ai.ts` 接管） | 是（视图 AI 桥） | 否（`mcode-view-ai` 无 tools 往返；`mcode-ai.ts` 只属 Docs） | E2 |
| Slides（Mcode 路线） | 同上 | 部分：Mcode preload 的 `slidesApi` 无 `aiStream` | 否 | E2 |
| PDF | vendor PDF AI 面板 | 是（`mcode-view-ai.ts`，0010），每次确认 | 否 | E2 |
| Markdown | vendor Markdown AI 面板 | 是（`mcode-view-ai.ts`） | 否 | E2 |
| HTML | vendor HTML AI 面板（Inspector/iframe/选区） | 是（`mcode-view-ai.ts`） | 否 | E2 |

**结论**：六类里只有 Docs 有"文档内 AI 调用 Mcode 会话"的 U1(harness, mock) 证据；其余都是静态接线。原生 `AgentSkill.executeTool` 同轮往返只在 Docs 协议层（T98/vendor `agent-core`）具备，Mcode Host 侧尚未提交。

## 11. 许可证与精确发行阻塞项（不改任何策略）

### 11.1 来源

- GenOffice 根：`genoffice/LICENSE` = Apache-2.0；`genoffice/NOTICE`（Copyright 2026 Mainfunc, Inc.，含字体/字体镜像说明）；上游仓库 `https://github.com/genspark-ai/genoffice`。
- 第三方：`genoffice/apps/shell/build/THIRD-PARTY-NOTICES.txt` 570 个 npm 包段 + Chromium `LICENSES.chromium.html`（随 Electron 版本）。
- Mcode 许可证来源 manifest：`apps/desktop/build/vendor-licenses/genoffice/manifest.json`（`mcode.genoffice.third-party-license-sources.v1`）：**expectedPackageCount=18、resolvedCount=8、blockedCount=10、releaseEligible=false**。

### 11.2 精确版本的阻塞项

| # | package@version | SPDX | 状态 | 阻塞性质 |
|---|---|---|---|---|
| 1 | `@electron-internal/extract-zip@1.0.5` | BSD-2-Clause | blocked | 发布包与精确 commit 均无完整条款；README 仅 14 字节 `BSD-2-Clause`；需权利方补发版本特定全文 |
| 2 | `lazy-val@1.0.5` | MIT | blocked | 发布包/上游全历史无 LICENSE；需维护者全文 |
| 3 | `ot-text-unicode@4.0.0` | ISC | blocked（**冲突**） | npm/tag 声明 ISC，README 为缺保留条款的 MIT；需维护者裁决/补发 |
| 4 | `react-remove-scroll-bar@2.3.8` | MIT | blocked | README 仅 `MIT` 4 字节；gitHead 不可取；不能借用 2.3.7/2025 LICENSE |
| 5 | `fastdom@1.0.12` | MIT | blocked（取证完成） | 准确 tarball README 内嵌完整 MIT；解除取决于载体政策（是否承认 README 内嵌全文） |
| 6 | `hash.js@1.1.7` | MIT | blocked（取证完成） | 同上（精确 commit README 一致） |
| 7 | `isarray@1.0.0` | MIT | blocked（取证完成） | 同上（含 HTML 实体原字节） |
| 8 | `ot-json1@1.0.2` | ISC | blocked（取证完成） | 同上 |
| 9 | `strictdom@1.0.1` | MIT | blocked（取证完成） | 同上 |
| 10 | `unicount@1.1.0` | ISC | blocked（取证完成） | 同上 |

- 已 verified 的 8 项：`@napi-rs/canvas-win32-x64-msvc@1.0.3`、`@nodable/entities@3.0.0`、`@univerjs/protocol@0.25.1`、`emoji-regex@8.0.0`、`franc-min@6.2.0`、`is-potential-custom-element-name@1.0.1`、`punycode@2.3.1`、`saxes@6.0.0`（`apps/desktop/build/vendor-licenses/genoffice/licenses/*.txt`）。
- T9 报告：`docs/research/genoffice-license/T9-unresolved-evidence.md`（10 项逐包 SRI/来源/正文 SHA-256；6 可解/4 权利方阻塞的裁决建议，未实施）。T11（材料集成与门禁复验）尚未开始。
- strict gate 行为：`stage-genoffice-resources.cjs:181-244` 在 `blockedCount!==0` 时抛错（fail-closed）；普通开发包可 opt-out（`editorsBundled:false`）。

### 11.3 其他发行阻塞/前置（非许可证）

1. 发现 A：生产构建缺 `documentViewPreload.js`（Docs GUI）。
2. 发现 B：staging 缺 pdf/markdown/html preload（三格式发行 GUI）。
3. 发现 C：vendor `out/renderer|preload` 产物体旧于 0013（以及 0011/0012 的 renderer 侧）——发行前必须重建并重算 digest。
4. PDF WASM 布局：`resources/genoffice/wasm/pdfium.wasm` vs vendor 回落 `resources/wasm/pdfium.wasm`；`hb-subset.wasm` 完全未 staging。
5. T0：Mcode Host 的原生工具同轮往返未提交（HEAD fail-closed）。
6. 无 Win/macOS/Linux 安装包 U1（所有六类）。

## 12. 建议的下一批有界任务（按文件属主拆分，互不重叠）

| 建议 | 所有者文件（独占） | 目标 | 依赖 |
|---|---|---|---|
| T-A｜Docs 视图 preload 构建接线 | `apps/desktop/electron.vite.config.ts`（或新增 `apps/desktop/build/build-view-preload.cjs`）、`documentViewHost.ts` 的 `resolveViewPreload` 注释、`release-readiness-smoke/check-unpacked.cjs` 增检查、新 smoke 目录 | 让 `electron-vite build` 产出 `out/main/documentViewPreload.js`，并在 afterPack 验证其存在与 digest；负例：删产物必红 | 无 |
| T-B｜发行 staging 六 preload | `apps/desktop/build/stage-genoffice-resources.cjs`、`verify-genoffice-editors-after-pack.cjs`、`genoffice-editors-release-smoke/main.cjs`（同一 owner） | `nativePreloads` 扩为六家；afterPack 复验六家；夹具补齐；负例必红 | 与 T-A 不同文件，可并行 |
| T-C｜vendor 产物重建与 digest 刷新 | `genoffice/` 构建命令（只读产物重建，不改源码）、`apps/desktop/build/*` 中 digest 相关（若需） | 按 pinned HEAD 重建六家 renderer/preload；确认 0013 ACK 进入 Docs 产物；重跑 release smoke | 需用户批准在 vendor 目录跑构建（会写 `out/`） |
| T-D｜Sheets 真实 Electron U1 | 只读产品源码；新增 `apps/desktop/scripts/sheets-electron-u1/` 与隔离夹具 | 打开真实 xlsx→改单元格/公式→保存→重开；记录 `ai:*` 视图桥与 `sheets:ai-generate-image` 在 hosted 下的实际行为 | T-A/T-B 完成后；独占 Electron |
| T-E｜PDF/MD/HTML 真实 Electron U1 | 新增各自 U1 夹具目录 | 三格式打开/编辑/保存/重开；PDF 覆盖文本编辑与 redaction Save As | T-B/T-C 完成后；独占 Electron，串行 |
| T-F｜保存所有权收敛裁决（架构） | 只读产出决策文档；不改代码 | 在"vendor 直写 + 每 wc 授权"与"Mcode 租约/CAS"之间给出唯一事实源方案（尤其 Slides 双路线） | 需总控/用户裁决 |
| T-G｜T0 收尾（已存在） | 原 T0 owner | 提交并验收 Host 侧工具同轮往返；真实三 SDK 在线回合另卡 | 现状：工作树在飞 |

> 不建议现在开"六编辑器统一默认入口"类任务：默认档仍是 OnlyOffice/Milkdown/预览（`FileEditor.tsx:118-151`），切换默认需要单独产品决策与 U1。

## 13. 未解问题（E3 / 未验证）

1. 发行构建下 Docs 视图是否真的白屏（发现 A 的运行时复现）——需要一次 `pnpm build` + 隔离 Electron 启动 + `documentView.list()` 的 `lastFailure` 证据。
2. Slides 双路线同时准备 OpenResult 的时序与保存所有权冲突。
4. `md-asset://`/`html-asset://`/`html-preview://` 在 Mcode 的 `genoffice-app://` 安全页下是否可加载。
5. PDF `pdfium.wasm`/`hb-subset.wasm` 在打包环境中的实际解析结果。
6. 六格式在真实安装包（Win/macOS/Linux）中的可用性——全部未验。
7. GenOffice 六家 vendor 自带 vitest 套件本次未运行（只读约束；运行会写 vendor 目录缓存）。
8. `ai:*` 视图桥（不受 `slides:|sheets:|workbook:|shell:` Pane 围栏）与 vendor 自身 `ai:*` 通道在 hosted 模式下的边界，需要独立安全复核。
9. Docs 的 odt/ott 路由：`genofficeFileRoute` 把它们映射到 docs，但 `readOpened` 只接受 PK/docx 魔数（`documentViewHost.ts:208-210,917-919`）——odt/ott 能否真正打开未验证。

## 14. 证据索引（可直接复核）

- 日志根：`apps/desktop/.tmp/smoke-runs/`；关键批次：
  - `1792584727328-35168-iRgjl0`：document-view-electron 17/17、slides-edit 12/12、pane-fence 109/109 + 2 变异、slides-bridge-attach 5/5。
  - `1792594721069-21264-MPBmMV`：document-view-open 39/39（含 slides 段）。
  - `1792597170741-37972-EBd5ES`：document-view-vendor-page 9/9。
  - `1792604023391-1444-jDXkcA`：genoffice-native-view（real 21/21、ai 12/12、sidecar 2/2）、document-view-host。
  - `1792590714394-31400-IEfB5l`：genoffice-format-gates 110/110。
  - `1792656756330-42852-kxtSLK`：t98 55/55、t83 19/19、genoffice-editors-release 25/25。
- AI Ask `checks.json`：`apps/desktop/.tmp/genoffice-ai-ask-IjVfsP/checks.json`（20/20，2026-10-22）。
- 构建产物事实：`apps/desktop/out/preload/{index.mjs,browserPicker.*}`、`apps/desktop/out/main/`（无 `documentViewPreload.js`）、`genoffice/apps/*/out/{renderer,preload}`（六家均在，时间戳早于 0013）。
- 任务卡：T0/T7/T9/T11（当前）、T71/T76/T87/T89/T90/T92（归档）、`tasks/README.md`。
- 施工地图：`docs/planning/arc007-genoffice-native-integration-map.md`、`docs/planning/genoffice-ai-interaction.md`。
- 许可证：`apps/desktop/build/vendor-licenses/genoffice/manifest.json`、`docs/research/genoffice-license/T9-unresolved-evidence.md`。
