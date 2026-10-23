# T6｜审批卡键盘、焦点与拒绝路径回归

- Status: done（2026-10-23 执行回写，见文末）
- Category: bug
- Priority: P1 security
- Depends on: none
- Exclusive writable files: approval component and its isolated regression suite only, after exact paths are confirmed.
## Required Skills
  - `mcode-smoke`: cover keyboard/focus/IME regressions with deterministic component tests.
  - `security-best-practices`: ensure keyboard shortcuts cannot bypass approval or convert denial into allow.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, relevant approval/security ledger entries, archived T96.
- Acceptance: Enter never grants unexpectedly; Esc denies/closes according to current contract; IME composition, hidden panes, stale focus, and dangerous-method denials are safe. Unknown or ambiguous state fails closed.
- Execute: verify current behavior first; no permission semantic changes without evidence.
- Result writeback: test matrix, old-red/new-green, commit SHA, real Electron cases still outstanding.

## 结果回写（2026-10-23）

### 实现范围（具体文件）

源码（两处真实缺陷，只动本卡边界内的两个组件）：

- `apps/desktop/src/renderer/components/chat/ApprovalPrompt.tsx` —— 初始聚焦守卫由
  `document.querySelector('[aria-modal="true"]')` 改为共享的
  `hasTopmostForeignDialog(cardRef.current)`（`hooks/useFocusTrap.ts`，同一份判据，
  未造第二份）。原因：全仓唯一的模态是 Base UI Dialog，它**从不输出**
  `aria-modal`（`useFocusTrap.ts:96` 与 `settings-focus-electron-smoke/probe.ts:451`
  都已记录同一结论），旧守卫恒为假 → 审批卡会把焦点从已打开的设置/命令面板/确认框
  里抢走，后台 Esc/Enter 落进审批卡。
- `apps/desktop/src/renderer/components/chat/McpToolDecisionCard.tsx` —— 新增
  `mcpCardOutcome()`：把「`status:"done"` 但结果为空 / 等于回合结束占位
  `"(no result — turn ended)"`」从 `success` 拉回 `error`（fail-closed）。
  `turn.done` 会把仍在 running 的工具收成这种形状（sessionStore 的 turn.done
  分支），用户中断回合或有审批未决定时工具从未执行，旧逻辑却显示「已完成」。
  共享纯函数 `mcpDecisionView` 及其既有 `done+''→success` 合同**未改**
  （`mcpDecision.test.mjs` 仍 2/2），收敛在卡片自己的判定里。

新增独立回归套件（独占目录）：`apps/desktop/scripts/approval-keyboard-safety-smoke/`
（`run.sh` + `build.mjs` + `main.tsx` + `verify.mjs` + 自包含 `browser.mjs`）。

### 动态证据（确切命令 + 通过数）

- `bash apps/desktop/scripts/approval-keyboard-safety-smoke/run.sh` → **51/51 通过**
  （真 Chromium + 真 React 19 + 两个生产组件 + 真 Base UI Dialog；CDP 派发真
  keyDown/keyUp，判据读真 `document.activeElement` / 真 `disabled` / 真 DOM）。
  覆盖：无意 Enter（开卡瞬间连按、武装到期后焦点在卡上按 Enter）、Esc=拒绝（含
  延迟期内）、Esc `stopPropagation` 不泄漏、IME `isComposing`/`keyCode 229`、
  隐藏卡与 `active=false` 卡不抢焦点/不决策、模态打开时焦点所有权（焦点日志证明
  卡从未获得焦点）、队列换头同一帧重新武装、danger 卡无 always-allow 且点「允许」
  不升级为 always、MCP 卡只读/不自合成终态/「回合结束无结果」与错误不显示成功、
  真成功正控、拒绝后焦点可移出。
- `pnpm test:smoke approval-keyboard-safety-smoke chat-copy-payload-smoke
  chat-derived-smoke chat-linecount-smoke maint-m22-smoke module-phase2-e2e-smoke
  ui-interaction-smoke`（`smokes-for.sh` 对两个改动文件给出的映射）→
  **7/7 suites PASS**（日志 `.tmp/smoke-runs/1792697295833-21352-q5JyTP`）。
- `pnpm test:smoke settings-panels-electron-smoke`（真 Electron）：四条工具审批卡
  断言（焦点在卡、延迟内不可批、延迟后真批、Esc=真拒绝）全部 PASS；该套件整体
  仍红在**无关**的 `MC-045 前置`（`ModuleViewDock`/`contributionsOf` 对未返回的
  module catalog 崩溃）。已用**未改动的 HEAD 版本**复跑证明同一失败在修复前就存在
  （`TypeError: Cannot read properties of undefined (reading 'flatMap')`），
  与本卡文件无关。
- `node --test apps/desktop/src/renderer/components/chat/mcpDecision.test.mjs` →
  2/2 pass（共享纯函数合同未被破坏）。
- `npx tsc --noEmit -p packages/contracts/tsconfig.json` → **exit 0**。
- `npx tsc --noEmit -p apps/desktop/tsconfig.json` → 仅剩并行工作未提交的
  `src/main/workflowEngines/*` 与其新套件报错（临时以 HEAD 版本对照验证过归属）；
  `ApprovalPrompt`/`McpToolDecisionCard`/`mcpDecision`/新套件 **0 条**报错。

### 变异验证（撤什么、几条红、还原确认）

每一种变异都先备份原文件，Python `str.replace` 精确替换（保持 LF 行尾），跑完
`cp` 还原并 `cmp` 逐字节确认：

| 变异 | 变红的断言 | 结果 |
|---|---|---|
| 模态守卫改回 `[aria-modal="true"]` | 1 条（模态已打开后到的卡把焦点抢走，焦点日志出现 `card:`） | 51→51 中 1 红；`cmp` 一致 |
| 删掉 MCP「无结果 → error」守卫 | 1 条（回合结束无结果显示 `success`） | 1 红；`cmp` 一致 |
| `Escape` 分支改死键 | 5 条（Esc 拒绝、不泄漏、正控、拒绝后等） | 47/52→5 红；`cmp` 一致 |
| `disabled={!allowArmed}` → `disabled={false}` | 2 条（开卡延迟、队列换头帧） | 2 红；`cmp` 一致 |
| 删掉 `decide()` 的 `promptActive` 门 | 1 条（`active=false` 卡仍能拒绝） | 1 红；`cmp` 一致 |
| `allowAlways = true`（撤 danger 门） | 2 条（danger 仍出勾选框；点「允许」带 `always:false`） | 2 红；`cmp` 一致 |

模态那条特别处理过：最初只看最终 `activeElement`，Base UI 的焦点守卫会把焦点抢回
弹窗，导致**修复前也假绿**。改成「弹窗先开、卡后到」的生产时序 + `focusin` 焦点日志，
撤掉修复后该断言真红（`{"inModal":false,"log":["card:DIV[role=alertdialog]"]}`）。

### 提交 SHA 与并行工作影响

- 实现提交：**`290d3d16`**（7 个文件：两个组件 + 新套件 5 文件）。
  ⚠️ 如实记录：该提交同时含并行会话的 `tasks/T24-*` 文档（另一会话在我
  `git add` 与 `git commit` 之间执行了提交，共享索引把已暂存内容一并带走）。
  提交内本卡 7 个文件的内核内容与我的改动一致；未做 reset/rebase 改写历史
  （硬规矩与本卡授权均禁止）。提交信息与内容不匹配，属并行索引竞态的事实。
- 提交后在该 HEAD 上复跑 `approval-keyboard-safety-smoke` → 51/51 通过。

### 未做项与证据边界

- **真实 Electron U1 未做**：本卡只给 E1 隔离组件证据（真 Chromium、真组件、真
  事件），**不是** U1。真 Electron 下的真实键盘/IME、多窗口、`settingsOpen`
  暂停提示行为仍需 U1 任务验证。
- 主进程审批桥（`ApprovalBridge`）、真实 `claude:approve` IPC、三引擎在线审批的
  拒绝语义另验；本卡 `ApproveBridge` 只做静态 E2 阅读。
- 未覆盖 macOS 的 `Cmd` 键语义与真实输入法（Sogou/微软拼音）的 composition 事件
  序列；IME 用合成事件驱动生产守卫的唯一入口 `isComposing` / `keyCode 229`。
- `McpToolDecisionCard` 对「`done` + 空结果」也判 error（比原 `mcpDecisionView`
  更严）；若上游真有正常空结果的成功工具，需要单独证据再放宽——当前按 fail-closed
  处理。

### 独立复核（2026-10-23，另一执行会话 A，未改任何源码）

对已提交状态 `290d3d16` 做了一次**独立复跑 + 变异**，结论与上表一致：

- `bash apps/desktop/scripts/approval-keyboard-safety-smoke/run.sh` → **51/51**（工作区干净，
  相对 HEAD 无改动）。
- 变异：`ApprovalPrompt.tsx` 的 `hasTopmostForeignDialog(cardRef.current)` 改回
  `document.querySelector('[aria-modal="true"]') !== null`（修复前写法，Python 精确替换）→
  **50/51**，唯一红的是
  `★ 模态已打开时，后到的审批卡不得把焦点从弹窗里抢走(焦点从未落到卡片)`，
  observed `{"inModal":false,"log":["card:DIV[role=alertdialog]"]}` —— 焦点确实落到了卡上。
  还原后 `cmp` 逐字节一致，复跑 **51/51**。
- 存档记录：该卡的 `290d3d16` 提交里混入了并行会话的 `tasks/T24-*` 文档（共享索引
  竞态）。按今天的提交纪律（`git commit -m … -- <paths>`），后续提交不会再出现。
