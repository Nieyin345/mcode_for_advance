# Mcode × GenOffice：文档内核整合与前端重构方案

> **状态**：方案评审稿，2026-10-18。未实施、未修改产品源码。先做架构试验和交互原型，验收后再逐域替换。
>
> **前端设计基线（用户明确偏好）**：以 Claude Code 桌面端的熟悉交互为主要参考——项目/会话导航、主对话与输入区、工具运行过程和结果、文件/差异的上下文查看；不采用固定占满屏幕的多栏 IDE 作为默认首页。借鉴交互范式，不复制品牌素材或把 Mcode 能力边界照搬成 Claude Code。
>
> **已核对的版本**：Mcode HEAD `1fb98af570fcc714a0e189475f67b2fede991b81`；GenOffice `main` 在本次读取时指向 `1f306a2a496227cae9194097897212c93d00a4e6`（2026-10-17 GitHub）。集成需固定独立依赖版本，禁止直接指向浮动 main。
>
> **范围**：替换 Office/Markdown/PDF/HTML 的文档编辑核心，重塑桌面工作台主导航、编辑工作区、检查器与设置页。**不替换** Claude Code/Codex/Pi SDK，不另造 Agent loop；不另造权限、文件写、记忆、工作流和工具发现机制。

## 1. 结论

**推荐：Mcode 为唯一宿主，GenOffice 作为受控、可升级的「文档能力子系统」接入；先集成文档，再重构前端壳。**

GenOffice 并不是一个 npm 包形式的通用编辑控件。实际仓库是 npm workspaces：独立的 apps/docs、apps/sheets、apps/slides、apps/pdf、apps/markdown、apps/html；packages/docx-engine、pptx-engine、xlsx-gateway、cli 等是多个内部包（package.json 均标记 private）。其 apps/shell/src/main/tab-manager.ts 采用 Electron WebContentsView，每个编辑器有自己的 main/preload/renderer。它们当前还不是供其它 Electron 宿主即插即用的稳定 public SDK。

可采取**双轨集成**：

1. **可视化轨**：在 Mcode 窗口内，用独立 WebContentsView 或经解耦后直接挂 React 编辑器渲染层承载 GenOffice Docs/Sheets/Slides/PDF/Markdown。第一版优先 WebContentsView：与 GenOffice 自己的 TabManager 实现接近，跨编辑器 CSS、快捷键、DOM 与依赖隔离较强。由 Mcode 现有的 BrowserManager/视图几何模式抽象出通用 DocumentViewHost，而非把另一个 shell/main 入口运行两遍。
2. **无头轨**：复用 packages/cli 与底层格式引擎的读取、编辑、渲染、转换能力，由 Mcode 主进程的 DocumentService 经受控 CLI/sidecar 或受控模块接口执行。能力只通过现有 app_api_list / app_api_describe / app_api_call 及用户明确授权暴露；不要把 GenOffice 内建 AI 面板与 Agent loop 再当成第四个引擎接进来。
3. **共同底座**：一个 DocumentSession、一个文件身份与版本、一个写入/回滚/冲突服务。用户点击、Mcode Agent、工作流/自动化共用同一份执行核与安全闸。

这比纯 CLI 更能达成“界面里直接编辑”；比简单 iframe 或复制整个 GenOffice shell 更容易保持 Mcode 的唯一权限与会话语义。

## 2. 现状与对应模块

| 文档种类 | Mcode 当前 | GenOffice 已有实现 | 推荐策略 |
| --- | --- | --- | --- |
| Markdown | Milkdown/Crepe，代码模式 Monaco，资料库预览另一套 Crepe/渲染；需要统一表格自然列宽 | apps/markdown：Tiptap + Markdown 序列化/源码模式、表格、Mermaid、数学 | **首批试验**；保留纯 MD 字节/未编辑不改盘保障，不盲信 roundtrip；编辑中支持手动列宽，预览按内容自适应 |
| DOCX | ONLYOFFICE Document Server（外部服务/JWT/会话） | apps/docs + packages/docx-engine；Tiptap/ProseMirror 画布，OOXML 解析/局部保存 | **首批试验**；本地无 DS 的保存/预览/批注修订压力测试通过后再删除 ONLYOFFICE 依赖 |
| XLSX | ONLYOFFICE | apps/sheets（Univer 前端 + Rust native/xlsx-engine + xlsx-gateway） | 第二批；必须保证公式、格式、合并、图表、宏相关警告、原文件保持 |
| PPTX | ONLYOFFICE | apps/slides（React Konva + pptx-engine/render/ops） | 第二批；测试母版、布局、文字度量、备注、图片、字体、批量生成 |
| PDF | pdfjs / @embedpdf 的预览为主 | apps/pdf（PDFium、本地文本编辑、注释/签名/转换） | 第三批；与普通 PDF 预览分开能力门控，保留只读 fallback |
| HTML | Monaco/浏览器预览 | apps/html，可视化+源码编辑 | 后续可选，不作为 Office 替换的阻塞项 |
| 代码、日志、Diff、终端 | Monaco/原生业务组件 | 不属于 GenOffice 编辑职责 | **保留原组件**，避免把文档与代码工作台强行混成一种编辑器 |

**Mcode 实际接入点**（按当前真实源码）：
- apps/desktop/src/renderer/components/ide/FileEditor.tsx：按文件类型选 MarkdownEditorPane / OnlyOfficeEditorPane / PdfPreview / Monaco。
- apps/desktop/src/renderer/components/library/FileViewer.tsx、FilePreview.tsx 与 mobile/MobileFileViewer.tsx：资料库和移动端也各自调用旧预览器。必须由**统一注册表**替换，不能只改 IDE 一个分支。
- apps/desktop/src/main/browser/BrowserManager.ts：已有 WebContentsView、bounds 同步、隐藏而不销毁、隔离 preload 的工程基础。**不要直接复用浏览器宽松的网页行为**；抽离中性 ViewHost 再收紧文档域能力。
- apps/desktop/src/main/appControl、packages/contracts/src/ipc 与 preload：AI 能力发现/权限/IPC 唯一入口。
- apps/desktop/src/renderer/App.tsx、ThreePaneLayout.tsx、SettingsPage.tsx：现有多栏/覆盖层/keep-alive 逻辑；更换视觉外壳不能卸载 PTY、丢文件草稿或抢焦点。

## 3. GenOffice 复用边界与技术风险

### 3.1 不是简单 npm install

GenOffice 根仓库 npm workspaces，内部包 private，未形成针对外部应用的稳定二进制 SDK。其编辑器具有各自 preload、IPC、Electron 主进程、文件 IO、主题和独立 React 根。直接 import 其 App.tsx 会有 IPC 命名/权限冲突、样式污染、软件包依赖链与升级成本。

**工程决策**：首批采用固定 commit 的 fork/vendor snapshot + 最小适配层。建立 VENDOR_MANIFEST（来源 commit、复制范围、修改 diff、许可证、升级记录），尽可能保留原版内部格式逻辑，不把大段第三方实现搬进 Mcode 业务核心。先验证 fork 能单独构建运行，再试接入 Mcode。

### 3.2 原生二进制和包体

XLSX 的 Rust xlsx-sidecar（cargo）、PDF 的 PDFium、Docs 字体度量和部分渲染资源带来各平台构建、签名、加载、安全扫描、资源释放的问题。应先做 Windows x64、Windows arm64/macOS/Linux 的支持矩阵；目标平台不可编译不能悄悄退回不兼容编辑器。现有仅凭 README 的功能描述，不等于原生格式完美往返；要用真实复杂样本做打开—不修改—保存—比对和受控编辑回归。

### 3.3 许可证和隐私

GenOffice 根 LICENSE 是 Apache-2.0；ee/ 独立 Enterprise License，**禁止当作普通 Apache 代码引入**。第三方依赖/字体/NOTICE 单独清点，在发行包保留版权、Apache LICENSE 和第三方告知，必要时咨询法务。不要带入 GenOffice 官方 app 的 Genspark 登录、云 AI 路由、默认分析上报；Mcode 只复用本地编辑能力，外部联网仍走 Mcode 的用户设置/授权。

### 3.4 不与 Mcode 现有平台平行造轮子

不引入 GenOffice 独立用户身份、聊天模型层、第二个项目管理/资料库、第二套快捷键总线、第二个自动化系统；不让 GenOffice 的 MCP server 和 CLI 绕开 Mcode 文件路径围栏/批准流程直接写磁盘。GenOffice 已有能力可以经 adapter 转译为 Mcode typed action，*不需要重建编辑算法*。

## 4. 建议的接入架构

```text
  Mcode 桌面窗口（单一 Electron 宿主）
  ├─ Mcode React WorkspaceShell / 统一导航 / 会话
  │  ├─ 文件/资料库 / 编辑器标签容器（DocumentHost Placeholder）
  │  ├─ Mcode Agent / 工具 / 审批 / Diff / 引用检查器
  │  └─ 终端、浏览器与工作流（保留原能力）
  │
  ├─ DocumentViewHost（WebContentsView 生命周期 + bounds + preload）
  │  ├─ GenOffice Docs UI       ──────┐
  │  ├─ GenOffice Sheets UI     ──────┤  typed DocumentBridge
  │  ├─ GenOffice Slides UI     ──────┤  open/read/change/save/selection
  │  ├─ GenOffice Markdown UI   ──────┤  ready/dirty/error/undo/events
  │  └─ GenOffice PDF UI       ──────┘
  │                                  │
  └─ Mcode Main Process               │
     ├─ DocumentService <────────────┘
     │  ├─ DocumentSessionRegistry / 唯一 docId/path/libraryId
     │  ├─ VersionedFileStore：原字节 SHA、CAS、冲突与快照
     │  ├─ Approval/Permission/PathGuard/OperationLedger
     │  ├─ GenOffice FormatEngineAdapter / CLI Sidecar (headless)
     │  └─ typed domain actions + progress / cancel / cleanup
     ├─ app_api_* / 三 SDK 原生工具映射 / 工作流 / 自动化
     └─ Mcode Memory / Library / Citation / Git
```

**宿主与文档子视图通信合同（示例，不是已实现 API）**：

- `doc.open({fileRef,mode}) → {documentId,format,revision,capabilities}`
- `doc.state({documentId}) → {ready,dirty,conflict,revision,saveStatus}`
- `doc.save({documentId,expectedRevision,changeSet}) → {revision,changedRanges}`
- `doc.read({documentId,range?,selection?})`；`doc.applyOps({documentId,expectedRevision,ops,dryRun?})`
- `doc.render({documentId,pages?,scale?})`；`doc.convert({sourceRef,format,destinationRef?})`
- `doc.diff({documentId,baselineRevision})`；`doc.undoChangeSet({documentId,changeSetId})`
- `doc.close({documentId,unsavedPolicy})`；`doc.selection.changed / doc.dirty.changed / doc.error` 事件

contracts 中每一项用 Zod/RPC schema，使用 documentId + 宿主绑定的真实工作区身份；不采信渲染端/Agent 自报路径。编辑子视图只看被授权的内容句柄，不透传 Node fs/child_process/任意网络。对每个写操作强制 expectedRevision（来自文件 SHA/版本）并记录 changeSet，Agent 修改后同时更新打开的 UI 文档或提示明确冲突；不允许旧 UI 的自动保存覆盖 Agent 已落盘内容。

**WebContentsView 几何与模态**：切文件/设置打开时隐藏视图，不销毁编辑实例；需要给主窗口的可视矩形裁切，否则原生子视图会盖住侧边栏/对话框；焦点由宿主决定，Esc/快捷键不越界，关闭脏文档先确认。Mcode 已有的 BrowserManager 模式可作为布局/生命周期参考，但文档预加载白名单与 browser 的网页权限不同。

**Agent 调用方案**：Mcode 将 doc.read/edit/render/convert/diff 纳入原 app_api_list → describe → call 的动态发现；对应文件/范围/变更均经 Mcode Policy/Grant；真正操作借用 GenOffice 引擎或固定路径的 CLI 可执行文件。CLI/MCP 的 skill 仅作为教程/帮助元数据按需加载，不能把大量命令常驻提示词。执行前可先 dryRun/showDiff，用户审阅后提交，不让 Agent 自授权。

## 5. 前端重构：以 Claude Code 桌面端的交互习惯为基线

**设计目标不是泛化的三栏 IDE，而是让熟悉 Claude Code 桌面端的人几乎不需要重新学习，就能使用 Mcode；再把 Mcode 的多引擎、文档编辑和自定义能力自然加进去。** 不要求像素级复刻，也不复制 Claude 的品牌资产。

### 5.1 默认首页：会话优先，而不是面板优先

默认打开 Mcode 后，主角应该是当前项目中的 Agent 会话：左侧负责项目/会话切换，中央负责对话、工具执行过程、结果与输入框；模型/引擎、权限与运行状态出现在用户需要的位置。文件、文档和差异从消息、文件列表或命令搜索打开，不要求用户先理解一套复杂的 IDE 导航。

```text
┌ Mcode  [工作区/项目]                 [引擎] [运行状态] [设置] ┐
│ 左侧导航/会话列表     │ 当前会话 / Agent 工作流                │
│                       │                                       │
│ [新建会话]            │ 用户消息                               │
│ 搜索项目/会话         │ Agent 回复 / 工具调用 / 进度 / 结果     │
│ 项目 A                │ ┌ 文件、Diff、终端结果或文档预览 ────┐ │
│   最近会话            │ │ 可打开、审阅并继续交给 Agent 修改   │ │
│ 项目 B                │ └───────────────────────────────────┘ │
│                       │                                       │
│ 文件/资料库（按需）   │ [附件/上下文] 输入任务……        [运行] │
└───────────────────────┴───────────────────────────────────────┘
```

此图是交互层级示意，不规定像素级布局。主界面优先呈现对话与输入，避免默认常驻多个窄栏、挤压消息宽度。项目、会话、搜索和新建任务应有稳定位置；工具执行状态与结果属于对话时间线的一部分，而不是隐藏在难找的独立面板里。

### 5.2 文档和 Office 是工作流中的一个自然视图

- 在 Agent 回复、文件列表或资料库中点击 DOCX/XLSX/PPTX/Markdown，打开 Mcode 内的文档视图；不启动另一个 GenOffice 主窗口，也不把用户送进一套视觉完全不同的应用。
- 文档视图拥有自己的标题、保存状态、撤销/重做和关闭入口。对话/会话上下文继续保留；用户可返回原对话，或按需展开 Agent 上下文栏继续讨论。
- **默认不强制三栏并排**。只有用户明确打开协作/审阅时，才出现可调整宽度的文档 + Agent / Diff 侧栏；侧栏可一键收起，文档画布优先获得可读宽度。
- 选择 Markdown 块、Word 段落、Excel 单元格范围、幻灯片对象或 PDF 页时，可以明确选择“引用到当前会话”，不要未经确认就自动发送或切换会话。
- 运行终端、浏览器和工具结果仍保留 Mcode 能力，但以按需打开的面板/标签呈现；PTY、文档实例和草稿不能因为视图切换而被卸载。

### 5.3 交互模式：一个默认模式，少量可选工作布局

- **会话模式（默认）**：左侧项目/会话 + 中央对话/输入框，工具调用、审批、文件结果在时间线上连续呈现。
- **文档模式**：文档画布为主，提供清晰的保存状态与文档工具栏；聊天通过返回会话或可选侧栏访问。
- **审阅模式（可选）**：文档与 Agent/Diff 并排，用于逐段修改、引用核对和变更批准；用户关闭侧栏后回到文档主画布。

布局和面板偏好按项目/工作区保存，但默认行为应简单、可预测。不能为追求视觉相似而牺牲 Mcode 的权限审批、动态工具发现、自定义 UI、三套 Agent SDK 或终端保活。

### 5.3 设置页从「一堆面板」改为任务导向

现有 SettingsPage 拥有 25+ 懒加载 panel，历史 docs/settings-redesign.md 已有三个交互原型与行组件/滚动问题分析；建议在其方案 C 的**可搜索单列/双列响应式设置**基础上做结构重组：

- 常用：外观/语言、编辑器与 Office 能力、引擎与模型、权限；
- 高级能力：Skills、MCP、Hooks、工作流、扩展、自动化；
- 连接/系统：网络、存储、终端、浏览器、诊断；
- 每个配置项仍由原业务核保存，改造共享 field/section/error/retry/dirty/reset 交互合同；设置窗口不再自己重新实现后端配置读写。
- 关联设置支持深链：从未加载的文件页跳到“文档内核诊断”，从缺权限的 Agent 结果跳到“该能力授权”，离开仍记住所处位置。

### 5.4 统一设计系统及交互规则

- 基础 token：颜色（灰阶+唯一强调色+语义警告色）、字体层级、8px spacing、边框和圆角、主题亮/暗、密度；**不在业务组件散落 magic values**。
- 原语：Button、Input、Combobox、Tabs、Panel、Dialog、Menu、Inspector、Toast、EmptyState、Loading/Error/Retry、Badge、FileIdentity/DirtyIndicator。
- 文件保存状态独立可见：未改动、保存中、已保存、冲突、失败。不要用一个轻飘飘的 success toast 冒充已落盘。
- 优先操作：Ctrl/Cmd+K 搜索命令；Ctrl/Cmd+P 快速打开文件；Ctrl/Cmd+S 保存；Alt+方向键切资源；Esc 关闭最内层；焦点归位；禁用/权限操作有语义说明。
- 响应式：窄窗侧栏自动坍缩，但不卸载活跃编辑器；横向拥挤时优先保证文档最小可读宽度。GenOffice 的原生子视图需同步重新计算 bounds。
- 需要真用户验证：构图、视觉秩序、字体、明暗、密度与高频动作路径；不是仅靠 smoke 测试颜色。

## 5.5 G0 静态评估结论（2026-10-18，固定 commit `1f306a2`）

> 读源码/清单得出，**未构建、未安装**；体积类为推断，已注明。

**架构事实**：六个编辑器 app 各自是完整 electron-vite 应用（main/preload/renderer），
shell 用 `WebContentsView` 挂载（`apps/shell/src/main/tab-manager.ts`），每个视图有
独立 preload、`sandbox:true` 与 `genoffice-app://` 特权 scheme；约 400 条 IPC
（docs 70 / sheets 53 / slides 178 / pdf 39 / markdown 25 / html 22 / shell 116），
同名 handler 会 `removeHandler` 重注册。纯引擎包（docx-engine / pptx-engine /
xlsx-gateway / markdown 转换）不 import Electron。

**AI 层的可分性（对"不要它的 agent 对话"直接相关）**：
- agent loop 在 `packages/agent-core`（纯 TS，callback transport）；
- provider 调用在 `packages/ai-provider`（只从 agent-core import 类型）；
- 编辑器里的 AI 面板是各 app 的 renderer 文件（`apps/*/src/renderer/ai/AiPanel.tsx`）；
- 主进程 AI IPC 由 shell 注册一次（`registerAiIpc`），可**不注册**；
- 编辑器工具已有干净协议：shell 推 `docs:mcp-command`，renderer 用同一
  `executeTool` 执行并回 `docs:mcp-result`（`shell/src/main/mcp/docs-bridge.ts`）。

**结论（2026-10-18 已被用户需求推翻 —— 见下）**：原方案是「保留 AI 管线/工具协议、去掉聊天 UI」的构建层排除。**这条不再成立**：用户实际试用了 GenOffice 官方软件后明确要求「genoffice 和 ai 的交互方式我要**完全的保留下来**」—— 选中元素 → 弹输入框 → 输入 → 确认 → 记录出现在侧边栏聊天对话；并明确「比我之前的 mcode 的 ai 交互编辑好太多了」。因此 `AiPanel` 与它的选择→弹框→侧栏会话交互**要保留**；需要重新裁决的是后端（vendor 的 ai-provider vs Mcode 三引擎）与权限/审批的接法，而不是「去掉聊天 UI」。测绘与三种落法见 `docs/planning/genoffice-ai-interaction.md`。

**CLI 能力与限制**：`convert/create/read/apply/render/info/merge/pdf/sheet/slides/...`；
单文件 esbuild CJS bundle（externals 仅 electron/jsdom/mermaid），可在
`ELECTRON_RUN_AS_NODE` 或 Node ≥22.12 运行。**纯 Node 可跑**：docx 读写、pptx 读写、
md→docx/html、受限 html→docx、xlsx 纯 JS 操作；**需要原生资源**：sheet read/重算/旧格式
（Rust xlsx-sidecar）、PDF 转换（pdfium.wasm）；**需要 GenOffice Electron 二进制
`--headless-export`**：所有 `→pdf`、docx→html、网页 html→docx、`render`（除直接 PDF）。

**许可证**：根 Apache-2.0；`ee/` 独立企业条款（当前只有 README/LICENSE，须整体排除）；
生产依赖白名单通过，无 copyleft；需随包 Apache LICENSE/NOTICE、PDFium 再分发条款、
OFL-1.1 字体与 Unicode License。**未发现阻止 vendoring 的许可证问题。**

**推荐路径（按风险从低到高）**：
1. **C（先做）**：vendor CLI bundle + 纯引擎 + pdfium.wasm（+ Windows sidecar），
   以 Mcode stdio MCP 方式接入，先证明 create/read/apply/render 与 `--json` 契约；
2. **A（随后）**：受控 WebContentsView 模块（复用 configure*Runtime/register*Ipc），
   替换文件对话框与保存为 Mcode 服务，不注册 ai:*；
3. **B 不推荐**：各编辑器 App.tsx 未组件化，直接抽 React 组件进 Mcode 成本高于收益。

**第一个可验证里程碑**：方案 C 在固定快照上跑通
`create docx/xlsx/pptx`、`docs_read/apply`、`slides_read/apply`、`sheet_read/apply`、
`render`；门是「打开→不改→保存字节一致」「稳定 --json 信封/退出码」「离线本地命令」，
并如实记录哪些路由仍需要 headless Electron 宿主。

## 6. 迁移阶段与验收门槛（按依赖顺序，不给虚假工期）

### G0：PoC / 技术决策（不得先重构 UI）

1. 固定 GenOffice commit，核对 Apache/ee/第三方版权、依赖锁与资源清单。
2. 只用**虚构样本文档**编译 Docs + Markdown，验证 Win x64 下在 Mcode 一个工作区 pane 内挂载 GenOffice WebContentsView/renderer，旧实例仍能打开同一文档。
3. 用 Mcode 的真实路径围栏和 FileStore 从 pane 打开、读取、编辑、写入、取消、碰撞错误、关闭、重新打开。检查 Mcode chat/editor/browser/terminal 同时开着时无热重启/焦点/原生层级异常。
4. CLI headless 路径以固定可执行文件运行一次 docx read、apply、render、export，确认 stdout/JSON 错误合同可由同一 DocumentService 消费。
5. 建立兼容测试资产清单，不允许仅凭 GenOffice README“字节级保留”当作已通过。

**Gate**：可嵌入、能保存且跨进程写入不丢数据，明确内存/启动/打包成本；否则保留原实现。

### G1：Markdown + DOCX（先替换痛点）

- MD：从当前 MarkdownEditorPane/资料库 preview 两入口切到同一 GenOffice Markdown adapter；编辑态列宽/纯文本 frontmatter/图片相对路径/公式/Mermaid 测试；**打开未编辑→关闭不得重新写文件**，外部编辑产生 revision conflict。
- DOCX：真实版式（分页/批注/修订/图片/脚注/表格）+ docx 原格式保存 + AI 结构化范围修订，未编辑原档保持；OnlyOffice 先继续作为 fallback，不立刻删配置、服务和旧版迁移能力。
- 在 FileEditor 和资料库 FileViewer/FilePreview 使用唯一 document-kind 路由表，避免三处分别判断格式/模式。

**Gate**：从打开→编辑→保存→关闭→Word/其它兼容查看器回读全过程可靠、冲突正确拒绝、UI/Agent 同步。

### G2：XLSX + PPTX

- XLSX：Rust sidecar 每个目标架构都可打包、沙箱和清理，运行时公式/多 sheet/样式/图片/图表/条件格式等一致；宏、数据透视、切片器、受保护工作簿给出明确支持/保留/只读级别，不要宣称全覆盖。
- PPTX：母版、字体替代、动画/图表、文本框排版和溢出、导出截图、编辑后 PowerPoint 回读；agent apply ops 后在同一 UI 视图刷新，使用 changeSet。
- **Gate**：每种格式至少简单/中等/复杂三类样本双向往返；任一不可无损编辑的类型先走只读+受控转换，不静默改坏。

### G3：PDF + 转换工具

- PDF 预览稳态保留现有路径；把 GenOffice PDFium 原位修改和批注签名能力按文件权限加到 DocumentAdapter；
- 不承诺扫描件 OCR/转换一定无损，生成新的文件时必须明说目标文件名及转换损失；只读 PDF、受保护 PDF、签名 PDF 默认 fail-closed 或明确只读。

### G4：前端信息架构/视觉重构

1. **先搭双版本可切换的 Claude Code 风格会话壳**（feature flag，保持主线程和已有 store 不变）：项目/会话导航、中央消息时间线、底部输入区、工具运行与结果状态。旧 UI 能一键回退。
2. 建立 tokens + 共享交互原语；优先统一导航、消息/工具调用、输入框、文件结果卡、Diff/审批、文档视图和设置壳。避免把所有能力都放到永久可见的侧栏。
3. 让 GenOffice 文档视图自然进入会话结果/文件打开流程；再分批迁移功能页，更新 i18n、键盘/可访问性、深链和移动端对应入口。
4. 用常见任务实测：新建会话、切项目、查看工具进度、批准操作、打开/编辑 Office、审阅 Diff、返回原会话、切换引擎和设置；同时比较固定分辨率截图、焦点、快捷键、滚动与内存。

### G5：统一 Agent 协作和整体验收

- 文档选择范围（Markdown 块、Word 段落、Sheet range、PPT 元素、PDF 页）→ Mcode 引用格式 → Agent 任务 → dry-run/diff → **用户批准**（有界范围）→ GenOffice ops → 保存/撤销；全部可审计。
- 文档可作为工作流节点、自动化产物及资料库资源；不生成另一个“仅 GenOffice AI 才能编辑”的孤岛。
- 对长文与大表格、关闭/重启/升级、恢复临时文件、离线、不兼容文件、只读权限、双窗口同文件冲突、Agent 与用户同时编辑各做测试。

## 7. 不可妥协的验收标准

1. **数据不丢**：未改过不写盘；正常保存不丢未知 OOXML 部件；两端冲突不得最后写入者默默覆盖；断电或进程退出后数据能恢复。
2. **同文件一致**：主区编辑器、资料库、Agent 工具与工作流共用 documentId、版本与保存核。
3. **安全不降级**：隔离 preload；不可突破 root、私有资料库授权、二进制 sidecar 进程权限；Agent 不能自行批准或通过 GenOffice 旁路绕过 Mcode。
4. **原生格式可用**：复杂 DOCX/XLSX/PPTX 在常用办公软件二次打开，公式/母版/宏相关边界等不会静默损坏；需要时显式降级只读。
5. **性能可控**：首屏 JS 不包含所有编辑器；按文档类型 lazy；切换隐藏不立即销毁，后台持有数量可配置和回收；低内存设备测试。
6. **UI 真正一致**：主交互遵循用户熟悉的 Claude Code 桌面端会话流程；任务/文件/资料库/文档/设置的导航、错误、保存/冲突反馈仍是一个系统。正常/窄窗/深色、鼠标/键盘/屏幕阅读器与模态可达均经过真实浏览器和 Electron 验证。
7. **可以回退**：迁移期按格式 feature flag 保留旧引擎；已用新引擎修改过的文件不在无验证时重新强行用旧引擎写回；迁移完成后才删除 ONLYOFFICE 专有配置和 Milkdown 依赖。
8. **许可清楚**：来源 commit/修改声明/NOTICE/字体/原生资源随构建审计；`ee/` 不集成。

## 8. 最小实施结构建议

```text
mcode/
  docs/planning/genoffice-integration-frontend-redesign.md   ← 本方案
  vendor/genoffice/          ← 固定来源+可控 upstream 补丁，不要把全部 shell 原样拷进核心
  packages/contracts/src/ipc/documents.ts   ← schema, typed RPC
  apps/desktop/src/main/documents/
    DocumentService.ts
    DocumentSessionRegistry.ts
    DocumentFileStore.ts
    GenOfficeEngineAdapter.ts
    DocumentViewHost.ts
    adapters/{markdown,docs,sheets,slides,pdf}.ts
  apps/desktop/src/preload/documents.ts      ← 独立窄白名单
  apps/desktop/src/renderer/features/documents/
    DocumentHost.tsx
    DocumentToolbar.tsx
    DocumentInspector.tsx
    DocumentConflictDialog.tsx
  apps/desktop/src/renderer/shell/
    WorkspaceShell.tsx
    WorkspaceNavigation.tsx
    WorkspaceTabs.tsx
    ContextInspector.tsx
  apps/desktop/src/renderer/components/ui/ ← 复用/整理已有原语与设计 token
  apps/desktop/scripts/document-integration-smoke/
  apps/desktop/scripts/document-e2e/
```

**避免重写过度**：早期保留原 App.tsx/ThreePaneLayout、旧页面，只增加 DocumentHost 与 feature flag；UI 骨架由既有 sessionStore 与文件 store 驱动，做到视觉可替换但运行状态不重置。切忌在重构期间同时换会话数据模型、Agent provider 接口和权限中枢。

## 9. 待评审的技术选择与否决条件

| 选择 | 推荐 | 何时否决 |
|---|---|---|
| GenOffice CLI/MCP 单独当外部进程编辑器 | 不作为 UI 主方案；可作无头过渡/格式任务 | 用户必须在 Mcode 内同步可视编辑，且进程调用没有版本/审计时 |
| 把所有 GenOffice React App.tsx 直接 import 入 Mcode | 不建议 | CSS、全局 IPC、生命周期、React 根/依赖隔离难保障 |
| GenOffice WebContentsView 嵌入（首推 PoC） | **优先试验**；源生态已有 shell TabManager 可参考 | 无法解决被 Mcode sidebar/modal 遮盖、文本选择引用、拖放、焦点和性能时 |
| 抽包为宿主无关的编辑器组件 | 中长期最佳形态 | 需要大范围 fork、升级分叉不可维护时 |
| 一次性删 OnlyOffice 与旧 Markdown | 不建议 | 未完成完整复杂样本兼容与回滚方案 |
| 整个 Mcode UI 一次性重写 | 不建议 | 会影响已有审批、终端保活、插件自定义 UI、设置深链、移动端并且缺兼容基线 |

## 10. 参考（本次实际读取）

- GenOffice 中文 README：https://github.com/genspark-ai/genoffice/blob/main/docs/i18n/README.zh-CN.md
- GenOffice 许可证/企业许可边界：https://github.com/genspark-ai/genoffice/blob/main/LICENSE 、https://github.com/genspark-ai/genoffice/blob/main/ee/README.md
- GenOffice 多视图宿主：https://github.com/genspark-ai/genoffice/blob/main/apps/shell/src/main/tab-manager.ts
- GenOffice CLI 使用及集成契约：https://github.com/genspark-ai/genoffice/blob/main/packages/cli/README.md
- GenOffice 文档引擎：https://github.com/genspark-ai/genoffice/tree/main/packages/docx-engine
- GenOffice Markdown 实现：https://github.com/genspark-ai/genoffice/tree/main/apps/markdown
- Mcode 既有设置重设计分析：docs/settings-redesign.md
- Mcode 唯一审查规范（如果进入实施前审查）：audit-ledgers/README.md

**下一步执行建议**：首先只实施 G0 的技术试验，证明「Mcode 单一宿主内打开一份 GenOffice Markdown 和 DOCX、修改后安全保存、Agent 读取同一版本」成立。试验结果决定后续选 WebContentsView 宿主还是逐个抽纯 React 编辑器；不要先批量移动现有组件。
