# T12｜UI 工作台现状与用户旅程基线矩阵（只读）

> **性质：只读源码调查 + 有界 E1 复核。不是 UI 验收，不改任何产品代码、测试、台账或任务卡（本卡回写除外）。**
> 覆盖要求：键盘/焦点、会话、tab/pane、终端、diff、审批、GenOffice、Node-RED、记忆、扩展导航。
> 证据分级沿用 `audit-ledgers/README.md` §2.4：**E1** 隔离动态 / **E2** 源码调用链 / **E3** 线索 / **D** 设计 / **U1** 真实用户旅程。
> **本报告不把任何无头/夹具 Electron 结果写进 U1 列。**

## 0. 基线身份与纪律

### 0.1 开工时仓库状态（原样保留，未 reset/clean）

| 项 | 值 |
|---|---|
| 开工 HEAD | `2c93f70ef863084426790c46c11e916644b43904`（`docs(tasks): record T5 commit SHA`） |
| 写回时 HEAD | `5283c100ec7594de5a950d7cfc4e536ed740f548`（并行 T14 对话推进，非本任务提交） |
| 分支 | `master` |
| 开工 dirty（**未触碰**） | `.aoci/baseline.json`、`.gitignore`、`apps/desktop/scripts/maint-m35-smoke/pickers-prelude.ts`、`apps/desktop/scripts/orchestration-ipc-smoke/run.sh`、`apps/desktop/scripts/release-readiness-smoke/check-reviewed.cjs`、`apps/desktop/src/main/appControl/apiCatalog.generated.ts`、`apps/desktop/src/main/ipc/settingsTransfer.ts` |
| 施工期间出现、同样未触碰的 untracked | `tasks/T16-electron-u1-harness.md`、`tasks/T17-unified-file-routing.md`、`tasks/T18-extension-install-permission-card.md`、`tasks/T19-extension-api-surface.md`（另一对话新建），以及并行对话产出的 `docs/planning/product-roadmap/T14-workflow-baseline.md` |
| 本任务写边界 | 仅本报告；任务卡只追加结果回写区 |

### 0.2 环境事实（读自 `apps/desktop/package.json`）

Electron `44.4.5`、React `^19.0.0`、`@base-ui/react ^1.6.0`。渲染端 485 个 TS/TSX（281 个 TSX）；`RpcMap` 共 **446** 条（`packages/contracts/src/ipc/rpcMap.ts`，`^  "domain.method"` 计数），preload 单文件 1424 行逐条手抄（`src/preload/index.ts`，桥接出口 `:1414` `exposeInMainWorld("api")`）。

---

## 1. 结论先行

1. **壳已经是"一套树、两个摆放变体"，不是两套 UI。** `App.tsx` 永远渲染同一个 `<ClassicShell variant=…>`（`App.tsx:320`），`workspace` 只改左栏最小宽度/圆角/分隔线（`ClassicShell.tsx:97-107`），因此切壳不会卸载 PTY/Monaco/草稿 —— 这条不变量有源码注释、smoke 与真 Electron 焦点探针共同背书。
2. **"已有 Electron 套件"全部是夹具页，不是产品 U1。** 9 套 `*-electron-smoke` 加上 `arc005-visual-baseline`（共 10 个真 Electron 入口，另有 `document-view-open`/`genoffice-ai-ask`/`slides-edit-smoke` 等共享 `electron-host.cjs`），全部用套件自写的 `page*.html`/`renderer.tsx` 直接挂载生产组件、`window.api` 由 `api-stub.js` 注入，**从不启动 `src/main/index.ts` 或打包产物**（`release-readiness-smoke/check-unpacked.cjs:3` 明说 "Never launches Mcode.exe"）。它们能证明真实 Electron 渲染管线 + 真组件，不能证明应用自身的 preload 白名单、主进程装配、导航与真实数据根下的用户旅程。
3. **审批的"人等待"状态在工作台里几乎不可见。** 会话侧栏的状态模型只有 working/input/failed/done/time，`input` 只认 `pendingQuestionBySession`，**待工具审批、待计划审批不会让一个后台会话显示"等你"**（`StreamSidebar.tsx:131-158`）；`ApprovalPrompt` 的键盘合同（Esc=拒绝、焦点在卡、500ms 武装）**没有对称地落到 `PlanApprovalPrompt`**（后者无 `role`、无 Esc，只有反馈输入框的 Enter，`PlanApprovalPrompt.tsx:376`）。
4. **Pane 仍是"一块可左右/底部停靠的右栏 + 固定左栏/底终端"，不是并行多 Pane 工作区。** `moveLayoutPane` 的可见效果只对 `right` 有意义（`sessionStore.ts:4557-4565`；`left={null}` 见 `ClassicShell.tsx:652`），`paneLayout.ts` 的四槽位是布局数据模型而非可自由拖拽的面板网格。跨重启只恢复最近项目/会话与落地 tab，**`openTabs` 不持久化**（`sessionStore.ts:642-645,1314`）——"并行会话侧栏 + 重启全恢复"的用户旅程不成立。
5. **渲染端的"改这个文件跑哪套"工具本身对渲染端失真。** `smokes-for.py` 只扫 `*.ts`/`*.mjs` 入口（`:99,:104`），`.tsx` 入口套件完全不可见；`@smoke-covers` 白名单只收 `src/main/*.ts`（`:46`）。实测 `bash scripts/smokes-for.sh src/renderer/components/chat/ApprovalPrompt.tsx` 输出"没有套件覆盖它"，而 `scripts/settings-panels-electron-smoke/renderer.tsx:14` 明明 import 了它并做了真键盘断言 —— 这条会直接误导下一批实现卡的回归选择。

---

## 2. 源码 / 入口点矩阵（按覆盖要求逐域）

> 状态口径：**已实现** = 源码链路完整且有测试；**部分** = 链路存在但缺关键路径/入口/证据；**缺失** = 源码可证没有；**未知** = 无源码或动态证据，需 U1 才能判。
> 所有行为结论至少 E2；标 E1 的是本轮或既有套件真的跑过的路径。

### 2.1 壳、启动与全局叠加层

| 项 | 源码入口 | 说明 | 证据 |
|---|---|---|---|
| 渲染端启动 | `renderer/main.tsx`（`Root = isElectron ? App : AppMobile`） | Electron 走桌面壳，普通浏览器走手机壳；两者 lazy 分离 | E2 |
| 工作区壳 | `App.tsx:293-359`、`shell/ClassicShell.tsx:579-686`、`shell/WorkspaceShell.tsx:52-60` | 单树 + `variant`；左栏 `WorkspaceSidebar` + `Titlebar` + `ThreePaneLayout` + `RightPanel` + `BottomTerminalBar` + `GitDiffDialog` | E2；`workspace-shell-smoke` E1（同树/偏好落盘/回退）；设置几何 `settings-layout-smoke` 真 Chrome E1 |
| 设置覆盖层 | `App.tsx:68-100` | 整窗覆盖、`useFocusTrap(rootRef, open)`、z-30；工作区包 `WorkspaceInertShell`（`ClassicShell.tsx:143-156`）在 `settingsOpen` 时 `inert` | E2；`settings-focus-electron-smoke` 21 条真 Electron U1_SLICE（21/21 见台账） |
| 全局叠加层 | `App.tsx:298-358` | CommandPalette、SearchDialog、ModelConfigPrompt、AskChoiceDialog、CustomUiHost、BrowserPanel overlay、WidePlanDialog、UpdateNotification、Toaster、VoiceListeningOverlay 全部根挂载 | E2 |
| 主窗口 | `main/window.ts:134-167` | 1440×900、`titleBarStyle:"hidden"`、`contextIsolation:true`、`nodeIntegration:false`、`sandbox:false`、preload `../preload/index.mjs` | E2 |
| IPC 三层 | `packages/contracts/src/ipc/rpcMap.ts` → `preload/index.ts` → `main/ipc/index.ts`（47 处 `register*Handlers` 调用） | 结构对账有 `ipc-wiring-smoke`（E1，PR 关键集） | E1/E2 |

**缺：** 没有任何套件启动生产 `src/main/index.ts`（装配序列只有抽出的 `assembleStartup()` 单测 `startup-wiring-smoke`）或打包后的 renderer；真实 CSP/协议注册（`mcode-panel://`、`genoffice-app://`）只在生产入口装配，夹具套件不覆盖。

### 2.2 键盘 / 焦点

| 项 | 源码入口 | 状态 | 证据 |
|---|---|---|---|
| 全局快捷键表 | `lib/shortcuts.ts:31-50`（17 条默认绑定） | **已实现** | E2 |
| 全局监听 | `hooks/useGlobalShortcuts.ts:35-87`：capture 阶段、录制态让行、IME/`keyCode 229`、repeat、可编辑目标只放行带修饰键 | **已实现** | E2；`arc005-recorder-input-smoke` E1（37/37，台账） |
| 命令注册表 | `lib/commands.ts:173` `STATIC_COMMANDS`（25 条）+ `:585-611` 动态 `session.switch.*` | **已实现（面窄）** | E2；`ShortcutsPanel` 由 `collectCommands` 派生（`ShortcutsPanel.tsx:46-88`） |
| 焦点陷阱原语 | `hooks/useFocusTrap.ts`：唯一生产消费者是设置层（`App.tsx:76`） | **部分** | E2；真 Electron 专题已有；命令面板/搜索框靠 Base UI Dialog 自带焦点管理（`CommandPalette.tsx:536-556`、`SearchDialog.tsx:349-363`） |
| Esc 层级仲裁 | `lib/escapeLayer.ts`：6 个消费者（ActivityCluster/FileMentionPicker/LibraryPicker/PlanViewer/SlashCommandPicker/TagPopover） | **部分** | E2；文件头自述 70+ 处裸 Escape 监听未逐一收编 |
| Tab 条键盘 | `layout/TabBarChrome.tsx:22-44`；SessionTabs `role=tab` + `aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"`（`SessionTabs.tsx:402-406`） | **已实现** | E2；`arc005-filetab-keyboard/arc005-pane-dock-keys/arc005-tab-reorder` E1 |
| 右栏 rail 漫游 | `RightPanel.tsx:203-219` + `panelRailNavigation.nextRailFocusIndex` | **已实现** | E1（本轮 6/6 套件联跑含 `arc005-panel-rail-smoke`，日志 `.tmp/smoke-runs/1792691951914-2612-lQb1oM`） |
| 分隔条键盘 | `layout/Divider.tsx:60-118`（`role=separator`、方向键 resize、双击复位、Esc 结束拖动） | **已实现** | E1（`arc005-divider-keyboard-smoke`） |
| 会话/文件 tab 循环切换 | — | **缺失**：无 Ctrl+Tab、无 Cmd+Shift+[ ]、无"下一个会话"命令（全仓 grep 无命中） | E2 |
| tab 右键菜单键盘入口 | `SessionTabContextMenu.tsx`（仅 `onContextMenu` 打开，`SessionTabs.tsx:226`） | **缺失**：无 Shift+F10 / ContextMenu 键绑定 | E2 |
| 计划审批卡键盘 | `PlanApprovalPrompt.tsx`：无 `role`、无 Esc、无初始焦点 | **部分**（见 2.6） | E2 |
| 读屏 / IME / 高 DPI / 多 OS | — | **未知**（U1 未做） | — |

### 2.3 会话

| 项 | 源码入口 | 状态 | 证据 |
|---|---|---|---|
| 会话生命周期 | `stores/sessionStore.ts`：`openTab:2207`、`closeTab:2355-2420`、`reorderTab:2421-2430`、`selectSession`（清 unread `:2186-2190`） | **已实现** | E1（`session-store-smoke` 真实 Zustand + 假 IPC，关键集） |
| 跨重启恢复 | `UI_LAST_PROJECT/SESSION` 写入 `:2127-2128`、读取 `:1287-1289`；`openTabs` 只在 init 种入落地会话 `:1314` | **部分**：只恢复一个 tab；多 tab/并行会话不恢复 | E2 |
| 左栏两模式 | `leftBarMode: tree|stream`（`sessionStore.ts:1058-1064`）；`ClassicShell.tsx:67-73` 路由 `LeftBar`/`StreamSidebar` | **已实现** | E2；`leftbar-render-smoke` E1 |
| 会话状态模型 | `StreamSidebar.tsx:131-158`：working / input（仅 question）/ failed / done / time | **部分**：待**工具审批**、待**计划审批**不进入 `input`；后台被审批卡住的会话仍显示 running | E2 |
| 侧聊 | `components/chat/SideChatPanel.tsx`；`openSideChatPanel` 把右栏切到 `flow`（`sessionStore.ts:6482-6490`）；快捷键 `sidechat.open`（⌘⇧Q） | **已实现（入口隐蔽）**：侧聊列表长在工作流看板下半部，无独立 tab | E2；`WorkflowBoardPanel.tsx:449-466` |
| 会话内子代理 | 归右栏"任务列表"（`ide/TaskListPanel.tsx:171`） | **已实现** | E2 |
| Agent 深链（切会话/开文件/开设置） | `renderer/lib/appControlHost.ts:91-300`；`open_settings` 只透传 `section` 字符串，最终由 `SettingsPage.tsx:304-321` 对 `NAV_ITEMS` 校验并显式回退 | **已实现** | E2；`settings-layout-smoke` 的 app_api 深链断言（E1） |

### 2.4 Tab / Pane / 布局

| 项 | 源码入口 | 状态 | 证据 |
|---|---|---|---|
| 两种 center 模式 | `ClassicShell.tsx:171-177`：`tabs` → `UnifiedTabbedPane`；`single` → `SplitCenterPane` | **已实现** | E2 |
| 会话/文件 tab 合一条 | `layout/UnifiedTabsBar.tsx:61+`；文件 tab 组 + plan 伪 tab + 只读预览 tab | **已实现** | E1（`arc005-tab-context/tab-motion/tab-reorder`） |
| 保活 | 后台 ChatPane 全挂载 CSS 隐藏（`ClassicShell.tsx:233-243,404-419`）；Monaco 宿主 `editorMountPolicy`（`:223`）；右栏 `CACHED_BUILTIN_RIGHT_TABS=["files","git","browser"]`（`rightPanelKeepAlive.ts:5`） | **已实现** | E1（keepalive 三套 + `arc005-pane-electron-smoke` PTY/Monaco 身份断言） |
| 右栏停靠 | `ThreePaneLayout.tsx:74-83` dnd-kit 手柄、`:230-256` drop 预览、`paneLayout.ts:206-213` 三向判定、`:224-240` split 物理（死区/折叠/最小像素/50% 吸附） | **已实现（仅右栏）** | E1（`arc005-pane-docking/pane-layout-edges/pane-dock-keys/pane-free-grid`）；真 Electron 拖动 `arc005-pane-electron-smoke`（真指针事件 + 真 xterm DOM，后端 api 为 stub） |
| 布局持久化 | `UI_PANE_LAYOUT_SETTING_KEY`（`sessionStore.ts:794,962-978`）、`stores/paneLayoutPrefs.ts`、`stores/paneWidthWriteQueue.ts`、损坏时可见 toast（`arc005-pane-electron-smoke` `CORRUPTION_*`） | **已实现** | E1/E2 |
| 预设布局 | `Titlebar.tsx:315-355` `PanePresetMenu`（chat/editor/balanced/重置） | **已实现** | E2 |
| 左/中/底任意网格、浮窗、跨面板拖放 | — | **缺失**：`left={null}`（`ClassicShell.tsx:652`）、`moveLayoutPane` 只对 `right` 生效（`sessionStore.ts:4557-4565`）；`paneLayout` 的 `left/editor` 槽位只是数据位 | E2 |
| GenOffice / Node-RED 入 pane | 右栏 DOC 按钮**只认 `.docx`**（`RightPanel.tsx:73`）；NR 按钮固定 `flowId:"node-red"`（`:268-274`）；宿主 `EngineRuntimePanel`/`GenofficeViewHostPane` 均按 `display:none` + `inert` 保活（`:341-360`） | **部分** | E2 |

### 2.5 终端

| 项 | 源码入口 | 状态 | 证据 |
|---|---|---|---|
| 底部终端保活 | `BottomTerminalBar.tsx`（`inert`/`aria-hidden` 随 active）、`ThreePaneLayout.tsx:350-371`（高度 0 不卸载） | **已实现** | E1（`arc005-editor-keepalive` 的 terminal 子项、`arc005-pane-electron-smoke` PTY_STABLE） |
| 多项目/工作树终端桶 | `ide/TerminalPanel.tsx:61-140`（按环境路径分桶、懒建 PTY）、`:146-177`（工作树路径并入活路径集合，防误清桶） | **已实现** | E1（`terminal-panel-worktree-smoke`） |
| xterm 宿主 | `ide/TerminalView.tsx`：create/write/resize/kill、FitAddon、active 才 fit/focus | **已实现** | E1（`terminal-smoke` 真 node-pty 仅限 `cmd /c` 立即退出进程） |
| 只读终端（任务输出） | `ide/ReadonlyTerminal.tsx`（xterm 解析控制序列，不接键盘） | **已实现** | E2 |
| IPC | `rpcMap.ts:551-559`（create/write/resize/kill/list）；`main/ipc/terminal.ts` + `TerminalManager` | **已实现** | E1（`terminal-smoke` §6 IPC 文案；`terminal-bus-recovery-smoke`） |
| 真实 Electron 下的真 ConPTY 用户旅程 | — | **未知/缺失**：`arc005-pane-electron-smoke/api-stub.js` 用 `Promise.resolve` 假 terminal.create/kill，"LIVE_PTY" 断言的是**真 xterm DOM + 假 PTY 总线** | E2（读 stub 原文） |

### 2.6 审批（工具 / 计划 / 提问 / MCP / 引擎节点安装）

| 项 | 源码入口 | 状态 | 证据 |
|---|---|---|---|
| 工具审批卡 | `chat/ApprovalPrompt.tsx:51-259`：`role=alertdialog`、焦点落卡不落"允许"、`useApprovalArming` 500ms（`hooks/useApprovalArming.ts:26`）、Esc=拒绝、危险前缀无"始终允许"、MCP 三档决策 | **已实现** | E2；真 Electron 夹具 `settings-panels-electron-smoke` `?panel=approval`（真 `webContents.sendInputEvent` Esc）E1/U1_SLICE |
| 计划审批卡 | `chat/PlanApprovalPrompt.tsx`（无 `role`、无 Esc、无初始焦点；只有反馈输入 Enter） | **部分**：与工具审批卡键盘合同不对称 | E2 |
| 提问卡 | `chat/QuestionPrompt.tsx:140-160`：card 作用域 Esc=撤回、Enter 前进，IME 守卫 | **已实现** | E2 |
| 队列与优先级 | `ChatPane.tsx:3168-3238`：工具审批 > 计划 > 提问；隐藏 pane 不抢键盘（`promptActive = isActive`，`:557`） | **已实现** | E2；`session-store-smoke` 有 approval 桶断言（E1） |
| 主进程裁决与跨端同步 | `claude/ApprovalBridge.ts:65-110`（pending map）、`RuntimeManager.ts:2167-2176`（`request.resolved` 广播）、`ApprovalBridge.ts:210-232`（取消时 reject 三类 pending） | **已实现** | E2；`claude-ipc-smoke` E1（关键集） |
| Agent 自授权拦截 | `appControl/policy.ts:69-72` 等：`claude.approve/respondQuestion/respondPlanApproval` 一律 blocked | **已实现** | E1（`approval-bridge-parity-smoke`、`app-control-smoke`） |
| 引擎节点安装审批 | `settings-panels-electron-smoke` 真 IPC 推送 + `EngineRuntimePanel` 真卡；`mc057-approval-identity-smoke`（发起窗口身份） | **已实现** | E1/U1_SLICE |
| 后台会话"等你"可见性 | `StreamSidebar.statusOf` 不含 approval/plan 桶；`NotificationManager` 只在 OS 通知层处理阻塞事件（`NotificationManager.ts:12,133-149`） | **部分/缺失** | E2 |
| 审批在真实 ChatPane（真事件流、多会话、设置打开、重载）中的 U1 | — | **未知**：现有 Electron 证据是**单组件夹具页**，不是真 store 事件链 | — |

### 2.7 Diff

| 项 | 源码入口 | 状态 | 证据 |
|---|---|---|---|
| turn 级 diff | `chat/TurnFilesCard.tsx` → `chat/DiffView.tsx:18` + `lib/lineDiff.ts`（有 1M cell 预算） | **已实现** | E1（`line-diff-budget/eol`、`renderer-pure`） |
| Git diff 对话框 | `ide/GitDiffDialog.tsx:47+`：多 tab、status/open 双请求序号、`useSuppressBrowserView`、Monaco DiffPane + inline `DiffView` | **已实现** | E1（`ide-diff-dialog-smoke`，极小 React 运行时） |
| 打开模式（center 内嵌 vs dialog） | `stores/gitStore.ts` `gitDiffOpenMode`；入口：`TurnFilesCard.tsx:324`、`GitHistoryView.tsx:215`、`GitRepoCardParts.tsx:679-731`；设置页 `SettingsGitPanel.tsx:60-95` | **已实现** | E2 |
| 真实 Electron 下点击/键盘/大文件 diff | — | **未知**：视觉基线只渲染静态两版文件（`arc005-visual-baseline` diff 场景 `fixture=real-lineDiff-DiffView`），没有 GitDiffDialog 的 Electron 交互套件 | — |

### 2.8 GenOffice

| 项 | 源码入口 | 状态 | 证据 |
|---|---|---|---|
| 文件类型路由 | `packages/contracts/src/genofficeFileRoute.ts`（docs/sheets/slides/pdf/markdown/html）+ `renderer/components/ide/fileEditorKinds.ts`（`isPdfFile/isMarkdown/canPreviewHtml`） | **已实现** | E1（`genoffice-file-routing-smoke`、`genoffice-format-gates-smoke`） |
| 编辑器档位 | `FileEditor.tsx:190-213`：默认 office → `wysiwyg`(**OnlyOffice**)；`genoffice`（结构化只读）/`genoffice-view`（WebContentsView）都是**用户显式偏好**才进入 | **部分**：GenOffice 不是默认档 | E2 |
| 文档视图宿主 | `main/document/documentViewHost.ts`（每 docId 一个 `WebContentsView`、URL 白名单 fail-closed、同路径唯一会话、保存 CAS 租约）、`ipc/documentView.ts` 8 条 RPC | **已实现** | E1（`document-view-host-smoke`）+ 真 Electron 17 条（夹具页） |
| 渲染端宿主面板 | `ide/GenofficeViewHostPane.tsx:104-123` `hasHostOpenChannel`：docs=true；slides=执行器装配；**sheets 恒 false**（vendor 打开通道在其主进程，源码逐条核对）；`:265-272` 无对端时显式降级不建视图 | **部分** | E2；`document-view-renderer-smoke` E1 |
| 真实 vendor 页挂载 | `document-view-vendor-page-smoke`：真 Electron 加载 `genoffice/apps/{docs,slides}/out/renderer/index.html`，各 5 条断言；产物缺失 = skip | **已实现（docs/slides 两页）** | E1 真 Electron（本机 `genoffice/apps/docs/out/renderer/index.html` 存在，未替用户跑） |
| 六格式编辑/保存/重开 GUI | — | **未知**（T7/T13 的范围） | — |

### 2.9 Node-RED

| 项 | 源码入口 | 状态 | 证据 |
|---|---|---|---|
| 引擎面板 | `settings/workflows/EngineRuntimePanel.tsx:656+`：start/stop 走 `useRpc`，running 时 `documentView.open(workflow-engine-<id>)`，停止/卸载 close；未安装给安装指引 | **已实现（宿主侧）** | E2 |
| 挂载点 | 设置→工作流→第三方引擎（`WorkflowsPanel.tsx:256-264`，页签切换只 `hidden` 不卸载）；右栏 NR 按钮（`RightPanel.tsx:268-274,353-360`） | **已实现** | E2 |
| 库→原生画布 | `WorkflowNativeEditorEntry.tsx`：`api.workflowEngine.load({workflowId,confirmReplace})`，未保存草稿禁用，需确认才替换当前画布 | **已实现** | E2 |
| IPC | `rpcMap.ts:1183-1199`（start/stop/status/list/load/nodesList/nodeInstall/respondNodeInstallApproval） | **已实现** | E1（`ipc-wiring`、`workflow-engine-electron-smoke` 的"八条 RPC 都经 recordRpcHandler 登记"） |
| 真 Node-RED 画布 U1 | `workflow-engine-electron-smoke` 用 **fake-engine.cjs**（真端口/HTTP，`0.0.0-fake-engine`） | **部分**：宿主/视图/鉴权链是真 Electron 真 IPC，但**引擎是假的**；真 Node-RED 需要 npm install（套件注释明说 U1 不联网） | E1；T8 负责真 U1 |

### 2.10 记忆

| 项 | 源码入口 | 状态 | 证据 |
|---|---|---|---|
| 设置→记忆 | `SettingsPage.tsx:214`（nav）+ `:447` 挂 `MemoryExplorerPanel`（lazy 重面板，`perf-startup` 守静态闭包） | **已实现** | E2 |
| 记忆 CRUD | `MemoryExplorerPanel.tsx:56-243` 走 `useRpc`（`memory.manage/categories/list/read/save/delete`，CAS `expectedRevision`）；IPC `rpcMap.ts:1215-1231`，主进程 `main/memory/*` | **已实现** | E1（`memory-smoke/list-integrity/review`；`memory-injection-ui-smoke` 真 Chrome 挂真组件） |
| 会话内入口 | 输入框 `MemoryAssistantButton`（`ComposerToolbar.tsx:133,183`，仅 Electron）、消息块深链 `setSettingsOpen(true,"memory")`（`MessageBlocks.tsx:1732`）、注入回执 `MemoryInjectionPreview` | **已实现** | E2 |
| Agent 侧 | `memory.*` 经 `app_api_call` 绑会话项目作用域（MC-092，`memory-smoke:1145-1215`） | **已实现** | E1 |
| 真 Electron 记忆导航/编辑 U1 | — | **未知** | — |

### 2.11 扩展 / 插件导航

| 项 | 源码入口 | 状态 | 证据 |
|---|---|---|---|
| 扩展设置页 | `SettingsPage.tsx:220-226`（plugins / extension-settings / skills / hooks / mcp / agent-ssh）；`PluginsPanel`、`ModuleSettingsPanel`（`ModuleContributions.tsx:135-151`） | **已实现** | E2 |
| 扩展命令进命令面板 | `CommandPalette.tsx:206-232`：`contributionsOf(moduleCatalog,"command")` 注入同一 group，统一 `createModuleClient(...).invoke` | **已实现** | E2；`module-contributions-smoke` E1 |
| 扩展视图挂载位 | `ModuleContributions.tsx:34-90` `ModuleViewDock`（left/right/bottom，声明式字段，不执行 HTML） | **已实现** | E2 |
| 自定义 UI 12 挂载位 | `packages/contracts/src/customUi.ts:60-73`；宿主组件 `CustomSlotHosts.tsx`（消息菜单/选中浮条/输入框工具栏/左栏右键/Monaco action）；右栏自定义 tab（`RightPanel.tsx:116-176,240-253`） | **已实现** | E1（`custom-ui-smoke/refresh`、`custom-tab-race`、`module-*` 多套） |
| 沙箱面板桥 | `customUi/panelBridge.ts:192-420`：`mcode-panel://` 沙箱 iframe，`handlePanelCall` 方法白名单 20+ 条（context/ask/api.call/automations/files/library/storage/extension/copy/openUrl/openFile/shell/toast），副作用项默认确认 | **已实现（白名单窄）** | E1（`custom-ui` 套件）；`packages/contracts/src/customUiPanel.ts` 类型即权限清单 |
| 安装时权限卡片 | — | **缺失**（T18 已开卡，未实现） | E2 |
| 扩展能调到全部宿主能力 | 现只有白名单 + `api.call`；无 VS Code/VSIX 宿主 | **缺失/长期** | E2（T19 已开卡；`docs/planning/extension-vscode-compat.md` 仅为规划） |
| 用户模块生命周期 | MC-035/036 仍双空（台账），模块安装→运行链有缺口 | **部分** | 台账 E1/E2 |

---

## 3. 既有证据 vs 真实 Electron U1 的差距

### 3.1 "Electron 套件"清单与真实度

| 套件 | 页面 | 后端 | 窗口 | 能证明 | 不能证明 |
|---|---|---|---|---|---|
| `settings-focus-electron-smoke`（21 检查） | 套件 `page.html` + 真 `App` + 真 store，`api`/`monacoSetup`/LeftBar/StreamSidebar 换桩（`build.mjs:51-66`） | `api-stub.js` | 隐藏窗口 | 设置层焦点循环、inert、嵌套弹窗、Esc 归还 | 生产 preload 白名单、真实数据、真 ChatPane 事件流 |
| `settings-panels-electron-smoke`（46 检查） | 真面板 + `?panel=app` 真 App | `api-stub.js` + 少数真 IPC（theme、节点审批推送） | 隐藏窗口 | 设置面板错误/重试/保存失败保留输入、审批卡键盘 | 同上 |
| `arc005-pane-electron-smoke`（8 条 + 2 条损坏布局反例） | 真 App | `api-stub.js`（terminal 假） | 离屏可见窗口 | 真 xterm DOM + 真 Monaco DOM 在停靠重排中身份稳定、原生指针拖动 | 真 PTY、真持久化 DB、真实项目 |
| `workflow-engine-electron-smoke`（15 检查） | 真 App 片段 | 真 IPC + **假引擎进程** | 隐藏窗口 | 引擎宿主/视图/鉴权/围栏链 | 真 Node-RED 画布 |
| `document-view-electron-smoke`（17 检查） | 自造最小 HTML 页 | 真 `DocumentViewHost` + 真 ipcMain | 隐藏窗口 | 视图生命周期/保存 CAS/冲突/围栏 | 真 vendor 编辑器 |
| `document-view-vendor-page-smoke`（每页 5 检查） | 真 vendor `out/renderer`（docs/slides） | 生产 preload 打包 | 隐藏窗口 | 真编辑器页能挂、不白屏、无首帧异常 | 打开/编辑/保存用户旅程 |
| `html-preview-electron-smoke`（10 检查） | 真 `HtmlPreviewButton` + 真 `BrowserPanel` | 真 BrowserManager/WebContentsView | 隐藏窗口 | HTML 预览→真视图加载 `file://` | 用户页面其它旅程 |
| `scene-deploy-electron-smoke`（14）/`watch-templates-cas-electron-smoke`（21）/`document-view-open-smoke`/`genoffice-ai-ask-smoke` | 各自夹具 | 真/假混合 | 隐藏 | 各自切片 | 工作台整体 |
| `code-electron-smoke` | 无窗口 | 真执行器 | — | Node/Electron 代码执行 | UI |

共同结论（E2，逐文件读）：**全部以 `win.loadFile(<suite>/page*.html)` 或套件自建 bundle 启动，主进程入口是套件自己的 `electron-host.cjs`；没有一套加载 Vite 产物 `out/renderer`，也没有一套启动生产 `src/main/index.ts`。** `release-readiness-smoke/check-unpacked.cjs:3` 明确"Never launches Mcode.exe or imports its main entry"。

### 3.2 视觉基线（`arc005-visual-baseline`）

- 真 Electron `capturePage()`，真 `App` + 真 store，39 格（13 屏 × 浅/深/窄），每格 JSON 带 `fixture` 类型与 `data-arc-fixture`（README 表格）。
- 已如实标注：terminal=`static-terminal`（无 PTY）、editor=`stub-editor`（非 Monaco）、sidechat=`sidechat-partial`、preview 仅 Markdown；`compare.mjs` 仍保留 13 处暗色 `--edge` 旧偏差（退出码 2 = 发现真实未登记差异）。
- **这是视觉 token/几何证据，不是功能证据**；T5（`d250a159`）已把探针收敛为 real/fixture-only/wrong-container/missing 四态（本轮复跑 `t5-visual-probe-integrity-smoke` 27/27）。
- 仍未取得用户安装版 Claude Desktop 的逐屏参照图（README "仍未覆盖"），所以"高相似度"没有最终基准。

### 3.3 与 U1 的差距（按域汇总）

| 域 | 已有最高证据 | 真实 Electron U1 缺口 |
|---|---|---|
| 壳/设置 | 真 Electron 焦点 21 条 + 几何真 Chrome | 生产 preload + 真实数据根 + 首启迁移；浅/深/窄窗逐屏对照 |
| 键盘 | E1 纯函数/假文档 + 真 Electron 设置焦点 | 全应用快捷键在真输入焦点（Monaco/xterm/IME）下的冲突矩阵；Shift+F10；Ctrl+Tab（缺失） |
| 会话 | E1 真 Zustand | 多会话并行 + 崩溃/重启恢复；后台审批可见性 |
| tab/pane | 真 Electron 拖动（假 API） | 真 DB 持久化重启、自由网格（未实现）、跨面板拖放 |
| 终端 | E1 假 PTY 总线（Electron 夹具）/ 真 node-pty（无头，`cmd /c`） | 真 ConPTY + xterm + 输入法 + 中文路径 + 高 DPI |
| diff | E1 极小 React + 真 Chrome 视觉格 | GitDiffDialog 真 Electron 点开/键盘/大文件 |
| 审批 | 真 Electron 单卡夹具 + 真 IPC 节点审批 | 真 ChatPane 队列、隐藏会话、设置打开、跨端 `request.resolved` |
| GenOffice | 真 Electron 视图宿主 + 真 vendor docs/slides 挂载 | 六格式打开→编辑→保存→重开；sheets 无打开通道（源码级） |
| Node-RED | 真 Electron 宿主 + 假引擎 | 真引擎画布编辑/部署/重启 |
| 记忆 | E1 + 真 Chrome 组件台 | 真 Electron 导航与编辑 |
| 扩展导航 | E1 多套 | 安装权限卡（缺失）、API 面（缺失）、VSIX 宿主（缺失） |

---

## 4. Top 5 阻塞项（按影响与依赖排序）

1. **没有可复用的真实 Electron U1 驱动骨架，所有套件止步于"夹具页 + api-stub"。** 影响：UI 线的每一个用户旅程（审批、终端、diff、GenOffice、Node-RED、记忆）都无法升级为 U1；T7/T8 只能各自再搭一套临时夹具，重复且不可比。依赖：无（T16 卡已由另一对话开出，`apps/desktop/scripts/electron-u1/` 目录尚不存在）。证据：本报告 §3.1。
2. **`smokes-for` 对渲染端的覆盖映射系统性失真，下一批实现卡会选错回归网。** 影响：`.tsx` 入口套件不可见（`smokes-for.py:99,104`）、`@smoke-covers` 只收 `src/main/*.ts`（`:46`）；实测 `ApprovalPrompt.tsx` 被判"无覆盖"，而 Electron 套件确实 import 它。依赖：无，廉价修复。证据：§1.5 实测输出。
3. **审批"人等待"在工作台不可见 + 三类审批卡键盘合同不一致。** 影响：多会话/自动化场景下，用户看不到哪个后台会话在等审批（`StreamSidebar.tsx:131-158`）；`PlanApprovalPrompt` 无 Esc/role/初始焦点（`PlanApprovalPrompt.tsx`），与 `ApprovalPrompt`/`QuestionPrompt` 不成体系；与最高原则"不静默、由用户本人点头"直接相关。依赖：T6（审批卡键盘/焦点）已在队列，需要按本报告扩展范围而不是新开重复卡。
4. **Pane/并行会话模型不满足产品方向。** 影响：只有右栏可停靠（`sessionStore.ts:4557-4565`），左/中/底固定；`openTabs` 不持久化（`:642-645,1314`），重启后并行会话列表丢失。这是"统一工作台"主线的结构性缺口，影响 T7/T8 的"同一壳内嵌 GenOffice/Node-RED"呈现方式。依赖：需先有 U1 骨架（阻塞项 1）才能验收。
5. **GenOffice/Node-RED 在壳内的真实可用面比界面看起来窄。** 影响：office 默认进 OnlyOffice（`FileEditor.tsx:190-213`）；sheets 无宿主打开通道（`GenofficeViewHostPane.tsx:104-123`，源码逐条核对过 vendor 入口）；DOC 停靠只认 `.docx`（`RightPanel.tsx:73`）；Node-RED 依赖用户自装 npm 引擎，现有 Electron 证据是假引擎。依赖：T0/T7/T8/T13/T14。

---

## 5. 建议的下一批受限实现卡（含候选独占路径）

> 原则：按**独占文件**切，不按问题名切；与既有 T6/T16/T18/T19 去重（它们已存在，直接复用，不新开同主题卡）。

| 候选卡 | 目标（有界） | 候选独占路径 | 依赖 |
|---|---|---|---|
| **U1-H：U1 驱动骨架落地**（= 既有 T16） | 真 Electron 启动生产 renderer 产物 + 生产 preload，最小真实旅程（开设置→焦点闭环→关设置→焦点归还），作为后续所有 U1 的基座；先证明它能对"假通过"变红 | `apps/desktop/scripts/electron-u1/**`（新建）；不碰 `arc005-visual-baseline/` | 无 |
| **U1-C：覆盖映射修正** | `smokes-for` 支持 `*.tsx`/`main.jsx`/`__smoke-covers` 白名单扩展到 `src/renderer/**`，并给 `ApprovalPrompt.tsx` 等 5 个渲染端文件建正控断言（撤掉 Electron 套件 import 必须变红） | `apps/desktop/scripts/smokes-for.py`、`apps/desktop/scripts/smokes-for.sh`、新建 `apps/desktop/scripts/smokes-for-self-smoke/**` | 无（最小、先做） |
| **U1-A：审批可见性与键盘对称** | 后台会话进入"等你"状态（工具审批 / 计划审批），侧栏/tab 有可读标识；`PlanApprovalPrompt` 与 `ApprovalPrompt` 同一键盘合同（Esc=拒绝、焦点不落危险按钮、IME 守卫）；只改 UI 状态投影，不改主进程裁决 | `apps/desktop/src/renderer/components/layout/StreamSidebar.tsx`、`components/chat/PlanApprovalPrompt.tsx`、`components/chat/ChatPane.tsx`（仅状态选择器）、新建 `apps/desktop/scripts/approval-visibility-smoke/**`；**与 T6 文件边界协调**（T6 已声明审批组件+套件） | U1-C（先有可信覆盖） |
| **U1-S：会话 tab 持久化与恢复** | 持久化 `openTabs`（含顺序/活动 tab），启动恢复并以失效清理；不改变 `closeTab` 语义；新键进 `settings.ts` 契约 + preload 无需新方法 | `packages/contracts/src/ipc/settings.ts`（新增 key）、`apps/desktop/src/renderer/stores/sessionStore.ts`（init/持久化分支）、新建 `apps/desktop/scripts/session-tabs-restore-smoke/**` | U1-H（验收重启旅程） |
| **U1-N：Node-RED 真引擎画布 U1**（= 既有 T8） | 真 Node-RED 5.0.8 起停、真画布编辑/部署/重开；不做产品修复 | 仅验收脚本/报告；缺陷另开卡 | T2/T3/T4；串行独占 Electron |

不建议本轮开：任意 Pane 网格/浮窗（需要先有 U1-H 与明确的布局模型决策）、VSIX 宿主（长期线）、GenOffice 六格式重验（T7/T13）。

---

## 6. 本轮实际执行 vs 仅查看

**实际运行（E1，隔离目录）**
- `bash apps/desktop/scripts/arc005-pane-free-grid-smoke/run.sh` → `arc005-pane-free-grid 34/34`（含两条 mutation-red 正向对照）。
- `bash apps/desktop/scripts/t5-visual-probe-integrity-smoke/run.sh` → `27/27 PASS`。
- `node apps/desktop/scripts/run-smokes.mjs arc005-pane-dock-keys-smoke arc005-filetab-keyboard-smoke arc005-panel-rail-smoke arc005-tab-reorder-smoke arc005-right-pane-keepalive-smoke ui-interaction-smoke` → **6 pass, 0 fail**；日志 `apps/desktop/.tmp/smoke-runs/1792691951914-2612-lQb1oM`。
- `bash apps/desktop/scripts/smokes-for.sh src/renderer/components/chat/ApprovalPrompt.tsx` → 输出"没有套件覆盖它"（与源码 import 事实冲突，见 §1.5）。
- `bash apps/desktop/scripts/smokes-for.sh --uncovered` → 主进程 11 个未覆盖（均为 GenOffice 类型桩/模块审批/`hostMcpMain`/节点子运行等，不含渲染端口径）。

**只读查看、未运行**
- 全部 9 套 `*-electron-smoke`、`document-view-open/vendor-page`、`genoffice-ai-ask`、`arc005-visual-baseline`（读 `README.md`/`build.mjs`/`probe.ts`/`probe-assertions.ts`，未执行截图与 compare）。
- `pnpm test:all`、`pnpm typecheck`、`pnpm dev`、打包/安装器、真实三引擎在线回合、真实 Node-RED、真实手机端：均未执行。
- 未修改任何产品代码、测试、`tasks/README.md`、`audit-ledgers/`。

---

## 7. 已知限制

- 本报告是**静态源码（E2）+ 有界 E1**；U1 列全部留空，不因夹具 Electron 绿而填写。
- 行号以写回时文件为准；并行对话仍在推进 T14/T16–T19，文件可能继续变化。
- 未读取真实用户 `mcode.db`、`flows.json`、`.docx` 等用户数据；未启动应用。
- "高相似度"没有用户安装版 Claude Desktop 参照图，无法给视觉一致性结论（该基准在 `docs/design/claude-code-reference-matrix.md` 标"待采集"）。
