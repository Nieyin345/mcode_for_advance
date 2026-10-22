# T12｜UI 工作台现状与用户旅程基线矩阵

- Status: ready-for-agent
- Category: task
- Priority: P1 strategic baseline
- Depends on: none
- Exclusive writable files: only new report docs/planning/product-roadmap/T12-ui-workbench-baseline.md. Read all other files as needed but do not modify source, tests, audit-ledgers, tasks/README.md, or another report.
## Required Skills
- frontend-design: evaluate the actual shell and user journeys against the product direction; do not redesign by taste alone.
- code-review: distinguish source-backed behavior from assumptions and tests from real user-journey evidence.
- mcode-smoke: understand existing smoke evidence without treating headless results as Electron U1.
- domain-modeling: use the recovered product spec vocabulary consistently.
- Read each named Skill's SKILL.md before work.
- Read before work: CLAUDE.md, audit-ledgers/README.md, audit-ledgers/Mcode_统一审查台账.md, .scratch/mcode-product-roadmap/spec.md, relevant ARC-005/ARC-004 sections, and tasks/README.md.
- Goal: create a source-backed baseline matrix for the UI/workbench line, showing existing screens/modules, real main-to-renderer entry points, shared shell integration, existing tests, proven behavior, and uncovered U1 journeys.
- Execute: first record current HEAD and full git status; preserve every dirty/untracked file. Read-only investigation only. Cite concrete paths/functions/tests and evidence level. Separate implemented, partial, missing, and unknown. Map keyboard/focus, sessions, tabs/panes, terminal, diff, approval, GenOffice, Node-RED, memory and extension navigation.
- Acceptance: report includes (1) source/entry-point matrix; (2) prior evidence vs real Electron U1 gap; (3) top five blockers ranked by impact and dependency; (4) proposed next bounded implementation cards with candidate exclusive paths; (5) no claims based solely on screenshot/mock/headless tests.
- Do not: modify product code or tests; mark ARC complete; edit another task card; infer features from filenames alone.
- Result writeback: report path, HEAD observed, files inspected, commands/tests merely inspected vs actually run, exact blockers and commit SHA. If report is all that changed, state that clearly.

## 结果回写（2026-10-23）

- **报告路径**：`docs/planning/product-roadmap/T12-ui-workbench-baseline.md`（267 行，只读调查；产品代码/测试/tasks/README.md/audit-ledgers 均未改）。
- **观测到的 HEAD**：开工 `2c93f70ef863084426790c46c11e916644b43904`；提交前被并行 T14 对话推进到 `5283c100ec7594de5a950d7cfc4e536ed740f548`；本报告提交 `5609c955bedb93132c525b359123b209393b83b7`。开工时 7 个 dirty 文件与并行对话生成的 4 张 T16–T19 卡、T14 报告全部原样保留，未 reset/clean。
- **读了哪些文件**：`tasks/T12-ui-workbench-baseline.md`、`tasks/README.md`、`audit-ledgers/README.md`、`docs/planning/mcode-product-roadmap.md`、`.scratch/mcode-product-roadmap/spec.md`；四份 Required Skill 的 `SKILL.md`（frontend-design / code-review / mcode-smoke / domain-modeling）；台账 ARC-004/ARC-005 段、MC-035/036；`CLAUDE.md`、`docs/testing.md`、`docs/planning/前端待办.md`、`docs/design/claude-code-reference-matrix.md`。源码侧读透 `App.tsx`、`ClassicShell/WorkspaceShell`、`ThreePaneLayout/paneLayout/paneDock`、`RightPanel/rightPanelKeepAlive`、`UnifiedTabsBar/SessionTabs/TabBarChrome`、`ApprovalPrompt/PlanApprovalPrompt/QuestionPrompt/ChatPane(审批段)/useApprovalArming`、`useGlobalShortcuts/shortcuts.ts/commands.ts/useFocusTrap/escapeLayer`、`TerminalPanel/TerminalView/BottomTerminalBar/ReadonlyTerminal`、`GitDiffDialog/DiffView/gitStore`、`GenofficeViewHostPane/GenofficeDocumentPane/FileEditor/fileEditorKinds/genofficeFileRoute/documentViewHost/ipc/document`、`EngineRuntimePanel/WorkflowsPanel/WorkflowNativeEditorEntry`、`MemoryExplorerPanel/MemoryAssistantButton`、`ModuleContributions/panelBridge/CustomSlotHosts/CommandPalette(扩展段)`、`settings/SettingsPage`、`sessionStore` 相关段、`main/window.ts`、`main/ipc/index.ts`、`claude/ApprovalBridge.ts`、`RuntimeManager` 审批段、`appControl/policy.ts`。测试侧读了 10 个 `*-electron-smoke` 的 `build.mjs/probe.ts/api-stub.js/electron-host.cjs`、`arc005-visual-baseline` README+probe、`smokes-for.py`、`run-smokes.mjs`。
- **实际运行（E1，全部隔离）**：`arc005-pane-free-grid-smoke` 34/34；`t5-visual-probe-integrity-smoke` 27/27；`run-smokes.mjs` 联跑 `arc005-pane-dock-keys / arc005-filetab-keyboard / arc005-panel-rail / arc005-tab-reorder / arc005-right-pane-keepalive / ui-interaction` → 6 pass 0 fail（日志 `.tmp/smoke-runs/1792691951914-2612-lQb1oM`）；两条 `smokes-for.sh`（含 `--uncovered`）仅作诊断。**未跑** `pnpm test:all`、`pnpm typecheck`、`pnpm dev`、任何 `*-electron-smoke`、打包/安装器、真实三引擎/真 Node-RED/真手机。
- **确切阻塞项（Top 5）**：① 无真实 Electron U1 驱动骨架，10 个真 Electron 入口全部是夹具页 + api-stub，从不启动生产主进程/打包渲染端；② `smokes-for` 对渲染端覆盖映射失真（只扫 `.ts`/`.mjs`，`ApprovalPrompt.tsx` 被误报"无覆盖"而 Electron 套件确实 import 它）；③ 后台会话的待工具审批/待计划审批不进入"等你"状态（`StreamSidebar.statusOf`），且 `PlanApprovalPrompt` 缺 Esc/role/初始焦点，与 `ApprovalPrompt`/`QuestionPrompt` 合同不一致；④ 只有右栏可停靠、`openTabs` 不持久化，"并行会话 + 重启全恢复"不成立；⑤ GenOffice 默认档仍是 OnlyOffice、sheets 无宿主打开通道、DOC 停靠只认 `.docx`、Node-RED Electron 证据基于假引擎。
- **提交 SHA**：`5609c955bedb93132c525b359123b209393b83b7`（仅 `docs/planning/product-roadmap/T12-ui-workbench-baseline.md`，1 file +267）。

