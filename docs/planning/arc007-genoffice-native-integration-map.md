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

1. **发布版的原厂编辑器页面目前没有随 CLI 打包**。现 `apps/desktop/build/stage-genoffice-resources.cjs` 的 opt-in `prepareGenofficeResources` 只搬 `cli/genoffice.cjs`、`cli/node_modules`、`wasm/pdfium.wasm` 与许可证；`apps/desktop/electron-builder.yml` 只收这一份 stage。`document.capabilities().cli.available` 不是「原版六个 renderer 都可用」。应原封不动打包每个经过审计、已构建的 `genoffice/apps/<module>/out/renderer` 及相对 assets/字体/wasm，保留 LICENSE/NOTICE 与平台 sidecar，并在安装包 post-pack gate 对**每个格式的资产存在性和真加载**独立核验；未构建时明确 unavailable。不要再让 `editorPageUrl` 从未知路径猜 URL。2026-10-19 已新增 `03aefc99`：只修 dev/release CLI 定位与 URL 保真（旧 4 例红→新绿），**尚未发布原厂页面**。
2. **vendor API 的主进程对端缺失不可用空桩糊弄**：见 `GenofficeViewHostPane.tsx` 原来的 `workbook:select`、`slides:open-path` 对端诊断；必须选择原主进程业务处理代码经最小安全 Bridge 复用或在合法 Host 服务里重接同一原引擎，无须重新实现 `WorkbookFile` / `OpenResult` 或错误地返回空数组当做「没有动画/备注」。
3. **AI 面与审批闭环缺口**：GenOffice 原版 AI Ask/文档内编辑不能通过「Mcode 另有聊天」直接算等价；把原版编辑工具的 *操作接口* 经 Mcode 三 SDK Agent/能力目录适配，真实展示应用修改、Diff、Accept/Reject/Undo，禁止拷贝 GenOffice 独立凭据和 Agent loop。
4. **可靠性与许可**：打开→编辑→改后版本→保存/另存→关闭→重开、格式保真、原字节保留、并发外部修改/冲突拒写、虚构大文件/原生 sidecar；测试中不能把真 DOM 挂载当作文件格式编辑成功。历史格式转换需与 vendor 路由及许可证逐项核验，Rust/Native sidecar 必须作为可用性单独报告。
5. **工作分配/认领**：文档 owner 依本表从源文件逐项接功能；打包 owner 接发布资源+验收；UI owner 只接主题/Pane/Tab/焦点；流程 owner 用唯一 Node-RED runtime；扩展 owner 优先源码复用与成熟 host shim。任何 owner 先查 `audit-ledgers/collaboration/README.md`、`coord.py locks`、`git status` 并 claim 文件，跨组消息用 `messages` Reply-To。

## 最小回归与分阶段放行

- **E1/E2**：`node apps/desktop/scripts/run-smokes.mjs document-view-renderer-smoke document-view-host-smoke document-view-open-smoke slides-edit-smoke slides-preload-abi-smoke genoffice-cli-smoke genoffice-ai-ask-smoke release-readiness-smoke`；前后记录准确 PASS/FAIL 及特定 CLI 错误来源。各格式的 vendor 测试应优先直接执行 `genoffice/apps/<module>/tests` 的现有测试，必要时仅增加宿主 IPC/身份/资源接线的新测试；禁止从零重写格式测试体系。
- **真 Electron U1**：六格式各至少一份包含复杂内容的隔离样例，用户 UI 与 Agent 两种入口共同编辑、保存重开和对比结构/渲染，不可缺失/篡改未知行、公式、备注、图片或版式。真实构建完成的成品 `resources/genoffice`、安全 preload、AI tool bridge 与三 SDK 按格式独立验收。
- **发布门禁**：缺少任何声明 `available=true` 的原版资源即失败；没有打包就显式 `available=false` 且界面给出可执行说明。与 node-red/扩展一样，**功能广度由原开源项目决定，Mcode 不另造一套删减版**。

2026-10-19 现场 E1 异常保留：相关 `document-view-renderer/host/open` 专项 3/3 PASS（日志 `apps/desktop/.tmp/smoke-runs/1792397455478-38608-xWCSjH`）；联跑 `genoffice-cli-smoke` 为 **38/40 FAIL**（调用外部 GenOffice Electron `electron.exe` 时报告 `conversion_failed` 而脚本期待 `app_unavailable`，日志 `1792397336995-18772-cM4mtM`）；当时 `src/main/document/genofficeCli.ts` 已被其他 AI 改动且未提交，不能归因于本次纯渲染页 URL 修改。CLI 失败应由源码 owner 复核/修复后重新运行，**不可声称全套 GenOffice 绿**。
