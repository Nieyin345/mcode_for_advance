# ARC-007｜GenOffice 原生六编辑器迁入 Mcode 的源码复用对照表（施工地图）

> 2026-10-19；责任：remote-auditor-20261019-6d29；证据等级 D（用户最新决策）+ E2（下列逐一实查本仓源码）+ 若干既有 E1（见原 ARC-007）。**这是施工地图，不是另一份验收台账**。任何完成状态/双勾一律只在 `audit-ledgers/Mcode_统一审查台账.md` 的 ARC-007 维护。严禁以本页「可复用」当作「Mcode 已实现」。

## 不变原则与唯一可信数据流

- **编辑器核心必须复用**：`genoffice/apps/{docs,sheets,slides,pdf,markdown,html}/src/{renderer,preload,main,shared}`、`genoffice/packages/*` 已在本仓。不另写一套 Word 排版、Rust XLSX 公式/表格、PPTX 渲染树或 PDFium 内核；原则上沿用原 editor React 组件和原生算法/导出器。改动主要是宿主 UI 外壳/命令入口/主题、原版 preloads 的**有界** IPC 映射、可审计启动/保存与依赖资源搬运。
- **保留 Mcode 单一身份/授权/写盘事实源**：打开项目路径、会话/文档代次与指派、真人审批、文件版本 CAS/租约、日志与回滚由 Mcode Host 负责；GenOffice 原开源 editor 负责展示、编辑和合法编辑命令。不得直接暴露任意 `ipcRenderer`、外部 Electron shell API、第三方密钥或第二套 AI Provider。三原生 SDK 经 Mcode 既有 Agent/能力目录进入 GenOffice 的编辑指令/审阅链，不克隆新的 Agent loop。
- **产品/UI 由 Mcode 融合**：与 Claude Code Desktop 风格的文件卡、Pane/Tab、编辑/审阅并排、键盘/焦点/主题、AI 对话统一，无需复刻 GenOffice 自己的独立窗口/账户页面；但不能用隐藏上游功能取代集成。依上游 LICENSE/NOTICE 与依赖授权记录复用来源和修改补丁。

## 每个格式的原始实现、当前 Mcode 接线和真实缺口

| 格式/上游来源 | 必须直接使用的原始代码和能力 | Mcode 当前代码/事实（非已验收） | 迁入差距 / owner 下一步 |
| --- | --- | --- | --- |
| **DOCX / Docs**：`genoffice/apps/docs/src/{renderer,preload,main}`、`genoffice/packages/docx-engine`、`font-metrics` | 原版分页/样式、表格/修订、选择/查找、文件解析、AI 编辑并可撤销、原格式保真保存 | `src/main/document/documentViewHost.ts` 原生 `WebContentsView`，`documentViewPreload.ts` docs 最小桥 `openDocxPath`/`saveDocx`/`saveDocxNew`，`GenofficeViewHostPane.tsx` 复用原 `out/renderer/index.html`；已接部分打开/保存的 E1 | 原版 preload 的编辑功能、AI 工具/差异撤销/导入导出、密码/打印、图片、知识库等大部不可用（当前源码显式「不给」）。按原 vendor IPC 与 Host 权限一一映射；逐项比较原版与 Mcode 编辑器，不能凭打开 DOCX 声称全量完成 |
| **XLSX / Sheets**：`genoffice/apps/sheets/src/{renderer,preload,main}`、`apps/sheets/native/xlsx-engine`、`genoffice/packages/xlsx-gateway` | 原版 Univer 编辑 UI、Rust 引擎、公式/图表/条件格式/筛选/透视/导入与原生格式往返 | `src/main/ipc/document.ts:capabilitiesStatic().hosts.sheets=false`；`GenofficeViewHostPane.tsx:hasHostOpenChannel("sheets")` 恒 false；仅 `document.*` CLI 有部分读取/编辑能力 | **P1 首要接线**：复用 vendor `workbook:select`/session/原版 `WorkbookFile` 生成与分页读取逻辑，安全映射 Mcode docId/文件授权；装配 Rust sidecar/引擎版本和 native 发布资源。不得伪造空 `WorkbookFile` 让页面「看起来打开」 |
| **PPTX / Slides**：`genoffice/apps/slides/src/{renderer,preload,main}`、`genoffice/packages/{pptx-engine,pptx-ops,pptx-render}` | 原版多页画布、元素渲染树、文字/形状/布局、保存/撤销、版式/动画/批注/放映和 AI 修改 | `src/main/document/slidesBridge.ts`、`slidesExecutor.ts`、`slidesVendorModules.ts` 已复用上述 vendor 三包并打通新增页、编辑文字及保存局部；`documentViewPreload.ts:slidesApi` 部分 ABI 真测过 | **P1 高优先**：目前 preload 的 `getTransition/getAnimations/getNotes/getSections/getChartData` 等回硬编码空值，不能冒充原 deck 无内容；与 vendor 原 session-state/main IPC 按权限重接其真实数据/命令，补撤销/审阅、批注/动画、放映、图片/字体和真实安装包的编辑-保存-重开 |
| **PDF**：`genoffice/apps/pdf/src/{renderer,preload,main}`、`genoffice/packages/pdf2docx`、PDFium | 原版 PDFium 文本/页面编辑与转换、缩略图/注释/页面导航、格式导出 | `FileEditor.tsx` 当前 PDF 走 Mcode `PdfPreviewPane`（一般预览），`document.*` CLI 有部分 PDF 文本读；未接 GenOffice PDF 原 editor | **P1** 复用原 PDF 编辑器/官方渲染、转换，不满足于现有 pdf.js 预览；保持批注/文本更改和 PDF→DOCX/XLSX/PPTX 的真正原路径 |
| **Markdown / MD**：`genoffice/apps/markdown/src/{renderer,preload,main}` | 原版 Markdown 块编辑、源编辑、图片/表格/导出/AI Ask | `FileEditor.tsx` Markdown 编辑主要走 Mcode `MarkdownEditorPane`；vendor `markdownApi` 原 preload 在 `apps/markdown/src/preload/index.ts` 有 `readFile/save/exportDocx/exportPdf` 等真实业务入口 | 优先复用 vendor 编辑器与导出/图片操作的原实现，按同一个 DocumentHost 路径与 Mcode 受信文件保存接入；要保留现有 Mcode 源码编辑能力，不让两个编辑器各写自己的文件状态 |
| **HTML / HTML editor**：`genoffice/apps/html/src/{renderer,preload,main}`、`genoffice/packages/html2docx` | 原版 HTML 所见即所得/代码视图、局部修改与输出、AI 生成、导出 DOCX/PDF | `FileEditor.tsx` 的 HTML 是打开浏览器预览路径，不是 GenOffice HTML 原生编辑器；Mcode CLI 部分转换存在 | 托管原 HTML editor + 源码/元素选择/导出能力，以 Mcode 受控文档/浏览器安全分域承接，不把浏览器页面当作有编辑能力的替身 |

## 跨格式的硬阻断（不能先把整包勾完成）

1. **原厂六编辑器 renderer 打包链路已实现显式 opt-in（仅是静态资源，不是六格式功能全验收）**：2026-10-19 `000841d0` 更新 `apps/desktop/build/stage-genoffice-resources.cjs`：`MCODE_INCLUDE_GENOFFICE_BUNDLE=1` 保留历史 CLI/WASM 发行方式；**另外设置** `MCODE_INCLUDE_GENOFFICE_EDITORS=1` 时，从上游原 `genoffice/apps/{docs,sheets,slides,pdf,markdown,html}/out/renderer` 按原相对路径及所有 assets/字体/静态资源一字节不变打进 `resources/genoffice/apps/*/out/renderer`。六个 index.html、引用的 Vite 入口 JS/CSS、路径不出界、无 vendor symlink/junction 都是提交前全检；不齐即拒绝、保留上次有效 staged 资源，不拿空壳应付。2026-10-19 `ce50efda` 新增 `apps/desktop/build/verify-genoffice-editors-after-pack.cjs` 并接入 `electron-builder.yml:afterPack`：真实 Electron 打包输出必须在 Win/Linux resources/ 或 macOS .app/Contents/Resources 下有和 manifest 一致的六套完整页面，否则安装器构建失败；CLI-only/默认无页面保持显式 unavailable，禁止残留假页面。新 `genoffice-editors-release-smoke` **15/15**（漏单格式、漏引用 JS、虚假 manifest、Win/macOS 布局、CLI-only、回滚）与既有 `release-readiness-smoke` **14/14**，加 `document-view-renderer-smoke` **3/3 suites PASS**，使用**真实六个上游编译目录**进行隔离 stage→copy 也成功。**关键边界**：`editorsBundled` 只说明原版页面静态资产存在，绝不等于 DocumentHost/IPC/AI/原生 Rust XLSX 侧车已可用或 `document.capabilities()` 可宣称完整支持。此 Windows 开发机没有 `cargo`，`npm run build -w @genoffice/sheets` 的原版 Rust xlsx-sidecar 阶段失败；仅使用原厂 `electron-vite build` 生成其页面（非工作簿运行时/写盘），其余 PDF/Markdown/HTML 及已有 Docs/Slides 上游原版 renderer 成功构建。**后续阻断**：原版 sidecar/IPC/完整资源与 Electron 用户操作依格式补齐，不能仅凭复制页面就标 ARC-007 通过；`03aefc99` 早期 URL 定位修复仍是必需前置。
2. **vendor API 的主进程对端缺失不可用空桩糊弄**：见 `GenofficeViewHostPane.tsx` 原来的 `workbook:select`、`slides:open-path` 对端诊断；必须选择原主进程业务处理代码经最小安全 Bridge 复用或在合法 Host 服务里重接同一原引擎，无须重新实现 `WorkbookFile` / `OpenResult` 或错误地返回空数组当做「没有动画/备注」。
3. **AI 面与审批闭环缺口**：GenOffice 原版 AI Ask/文档内编辑不能通过「Mcode 另有聊天」直接算等价；把原版编辑工具的 *操作接口* 经 Mcode 三 SDK Agent/能力目录适配，真实展示应用修改、Diff、Accept/Reject/Undo，禁止拷贝 GenOffice 独立凭据和 Agent loop。
4. **可靠性与许可**：打开→编辑→改后版本→保存/另存→关闭→重开、格式保真、原字节保留、并发外部修改/冲突拒写、虚构大文件/原生 sidecar；测试中不能把真 DOM 挂载当作文件格式编辑成功。历史格式转换需与 vendor 路由及许可证逐项核验，Rust/Native sidecar 必须作为可用性单独报告。
5. **工作分配/认领**：文档 owner 依本表从源文件逐项接功能；打包 owner 接发布资源+验收；UI owner 只接主题/Pane/Tab/焦点；流程 owner 用唯一 Node-RED runtime；扩展 owner 优先源码复用与成熟 host shim。改动前先查 `git status` 并确认文件归属；跨组依赖直接登记在统一台账（协作协议已于 2026-10-20 删除）。

## 2026-10-20 用户拍板：在 vendor 源码上直接二开（覆盖本表「B 方案/桥接替身」的过渡做法）

用户追问「为什么要复制他的代码，为什么不能在他的代码上二开，直接改他的代码」。现场核查确认 `genoffice/` 是完整 git clone（自带 `.git`，仅被根 `.gitignore` 排除），因此**直接改 = 在该仓库建分支**，无需复制。定案：

1. `git -C genoffice checkout -b mcode/integration`；Mcode 改动以少量、带注释、可 `rebase` 的提交落在上游源码上。
2. **只改边界**：各 `apps/*/src/preload/index.ts` 增加 channel 策略表（默认拒绝、白名单放行；文件对话框/任意路径读写/AI/附件/剪贴板写改指向 Mcode 围栏服务）；`apps/*/src/main` 的注册入口整理为可被 Mcode `require` 的 `register*Ipc()`（slides 已由 `slides-edit-smoke` 12/12 证明可行）。编辑器核心（分页/表格/公式/渲染树/导出器）一律不重写。
3. **随原生链打通删除 Mcode 替身**：`documentViewPreload.ts` 手写 docs 桩、`slidesExecutor.ts` 自建 DeckSession/会话 Map、`slidesBridge` 里重复的上游业务逻辑。
4. **升级**：`rebase` 上游 + 重跑 GenOffice 自带 `apps/<app>/tests` + `document-view-*`/`slides-*`/真 Electron 探针。补丁运维待定：导出 `patches/mcode-integration/*.patch` 入库，或提交固定分支+重建脚本（未定前该分支只在本机）。
5. **首步试点**：仅 Docs —— vendor preload + 策略表替换手写 preload，注册 vendor docs handler，真 Electron 打开→编辑→保存→重开；通过后按 Slides → Sheets → PDF → MD → HTML 滚动。
6. 边界不变：不引入 GenOffice Agent loop/账号/云 AI/第二套存储；不碰 `ee/`；复用不豁免真人审批、路径围栏、许可核验与失败回滚。

### 2026-10-20｜Docs 单页试点：受限原生 preload + scoped native IPC（有界 DEV_CLAIM）

- **独立 vendor Git**：基线 `73ba918083b5e2bedff7633925c3d7f625e04449`；分支 `mcode/integration`；本地提交 `8d379b1d7db7721a4982aaab8f904f624a59a832`（只修改 `genoffice/apps/docs/src/preload/mcode-view.ts`、`genoffice/apps/docs/src/main/mcode-ipc.ts`）。可以用 `git -C genoffice checkout mcode/integration` 检查；**不可把 Mcode 主仓 HEAD 当成 vendor 提交**。
- **可重建补丁**：`patches/genoffice/0001-feat-docs-add-scoped-Mcode-native-preload-and-IPC-bo.patch`，由 `git -C genoffice format-patch 73ba918..8d379b1` 导出并纳入 Mcode 主仓。另一个全新 checkout 先 checkout 原版基线，再在 vendor Git 仓执行 `git am ../patches/genoffice/*.patch`（运行时路径相对 `genoffice/`），不要仅靠被忽略的本地 vendor 文件。
- **复用与权限界面**：`mcode-view.ts` 保留上游 Docs `DesktopApi` 接口名、事件签名，给 WebContentsView 单独暴露白名单（默认拒绝）：文档打开/保存/打开回执/脏文档确认转到 Mcode 既有 DocumentViewHost 的 sender 身份、工作区围栏、CAS 和 OS 租约；原版完整 `index.ts` 继续供 GenOffice 单体使用，Mcode 的旧 `documentViewPreload.ts` Docs 桩只在 vendor 源缺失时退回。源仍以 vendor 分支为权威，Mcode 构建通过精确 alias 选择。
- **vendor 主进程**：`mcode-ipc.ts` 导出可供 Mcode 主进程 require/打包的 `registerDocsIpc(ipc, isDocsSender)`；只迁原厂字体度量与 Chromium 拼写语言（3 个 `mcode:docs:native-*` handler），每次入口均验证视图 sender。**不直接注册原厂 `docs-main.ts` 原有的全局 `registerDocsIpc()`**，其功能还包含文件对话框、任意路径读取/写入、AI、聊天与存储，整体接入会绕过 Mcode 安全层。
- **验证事实（有界）**：`document-view-open-smoke`、`document-view-host-smoke`、`document-view-electron-smoke`、`document-view-vendor-page-smoke` **4/4 suites PASS**（真 Electron 的两套均运行）；`document-view-host-smoke` 原 500/500 + vendor 新 46/46；`npx tsc --noEmit -p apps/desktop/tsconfig.json`、`npx tsc --noEmit -p genoffice/apps/docs/tsconfig.json` PASS。运行 `node apps/desktop/scripts/document-view-host-smoke/mutate-native-docs.mjs`，撤去 `docs:save` channel 路由后套件 **exit 1 真红**，再还原并以 `cmp -s` 核对逐字节一致。验收日志 `apps/desktop/.tmp/smoke-runs/1792485425376-22960-HdNJAl`。
- **remaining（不伪报完成）**：目前 scoped vendor 主进程**仅迁 3 条只读/设备级 IPC**，原版 `docs-main.ts` 的加密/受控导出/文件打开后的业务能力尚未做逐功能 Mcode 围栏适配；`index.ts` 本身没有整体替换，Mcode 缺 vendor 时仍含旧 docs 桩；没有完整原版 Docs 所有菜单/附件/选区 AI 等价与复杂 DOCX 保真/重开矩阵，也没有安装版/跨 OS U1 或独立审核。**ARC-007 整包 DEV/REVIEW 双空不变**；本次仅是 Docs 的安全边界与原厂页面首轮试点。

## 最小回归与分阶段放行

- **E1/E2**：`node apps/desktop/scripts/run-smokes.mjs document-view-renderer-smoke document-view-host-smoke document-view-open-smoke slides-edit-smoke slides-preload-abi-smoke genoffice-cli-smoke genoffice-ai-ask-smoke release-readiness-smoke`；前后记录准确 PASS/FAIL 及特定 CLI 错误来源。各格式的 vendor 测试应优先直接执行 `genoffice/apps/<module>/tests` 的现有测试，必要时仅增加宿主 IPC/身份/资源接线的新测试；禁止从零重写格式测试体系。
- **真 Electron U1**：六格式各至少一份包含复杂内容的隔离样例，用户 UI 与 Agent 两种入口共同编辑、保存重开和对比结构/渲染，不可缺失/篡改未知行、公式、备注、图片或版式。真实构建完成的成品 `resources/genoffice`、安全 preload、AI tool bridge 与三 SDK 按格式独立验收。
- **发布门禁**：缺少任何声明 `available=true` 的原版资源即失败；没有打包就显式 `available=false` 且界面给出可执行说明。与 node-red/扩展一样，**功能广度由原开源项目决定，Mcode 不另造一套删减版**。

### 2026-10-19｜GenOffice 原生 Shell 缺构建导致反复弹窗：实证与修复

- **先前的 E1 红例（保留历史，不再认定当前仍红）**：`document-view-renderer/host/open` 3/3 PASS（`1792397455478-38608-xWCSjH`），`genoffice-cli-smoke` 曾 38/40 FAIL（`1792397336995-18772-cM4mtM`），表现为 `conversion_failed` 而非预期 `app_unavailable`。用户随后截图原生 Windows 错误窗：`Unable to find Electron app at .../genoffice/apps/shell` 与 `Cannot find .../out/main/index.js`。
- **查明根因**：`genoffice/apps/shell/package.json` 声明 `"main":"out/main/index.js"`；现场该产物**不存在**，而 GenOffice 官方 `packages/cli/src/resources.ts:appLaunch` 以前仅验证 `electron.exe` 存在，立即启动未构建 Shell。原 `packages/cli/src/formats/app-export.ts` 于是调用原生 Electron 产生弹窗，并将退出 1 当成转换失败；这与 Mcode 文件 URL 定位无关。
- **本机恢复**：在 **GenOffice 原项目**目录运行 `npm run build -w @genoffice/shell` 成功，原版入口、preload 和 renderer 均生成；再运行 `node apps/desktop/scripts/run-smokes.mjs genoffice-cli-smoke` **44/44 PASS**（`1792398341144-20688-dPPIcj`）。
- **永久防止再次误启动**：修补的也是 **GenOffice 原厂 CLI 源码**，不另造 Mcode Shell：`packages/cli/src/resources.ts` 从原 `apps/shell/package.json` 的 `main` 查实际文件，连同原本的 preload/renderer 验证全有才选择开发态 Electron Shell；少任意一个时默认退回已有安装的 GenOffice 或明确不可用，**不会无脑 spawn Electron**。原 `packages/cli/tests/app-export.test.ts` 用隔离临时仓覆盖主入口/预载/页面缺失和恶意 main；focused **11 PASS/2 SKIP**、`npm run typecheck -w @genoffice/cli` 和 `npm run build -w @genoffice/cli` PASS，Mcode `genoffice-cli-smoke document-view-renderer-smoke` **2/2 suites PASS**（`1792398899889-14132-uEkzLE`）。
- **重要版本事实**：`genoffice/` 既被 **Mcode 主仓 .gitignore 排除**，又是**独立嵌套 Git 仓库**；修复应以 **GenOffice Git commit `cbec600ace9c930b2646b6739cf6df3741bb9d6a`** 为来源固定和交付依据，Mcode 主仓 HEAD 无法代表这两份原版源码。当前仅本地原厂 Shell/CLI 成功构建，不等于成品 GenOffice GUI 已被 Mcode 安装器打包。
- **不隐瞒其他失败**：完整原 GenOffice CLI suite 在此 Windows 主机 **373 PASS/25 FAIL/53 SKIP/1 unhandled**，含 symlink EPERM、chmod 模式差异和 named-pipe EADDRINUSE 等未归类/未修问题；不能将专项绿扩展成六种格式与全平台验收完成。正式剩余问题和整包状态仍只在 `audit-ledgers/Mcode_统一审查台账.md` ARC-007。
