# T104｜UI 工作台闭环：一个窗口里看得见全部

- Status: ready-for-agent
- Category: **P0 产品主线（UI）**
- Priority: **P0 —— 「最终效果 = Claude 桌面端的 UI」**
- Depends on: 无
- Exclusive writable files: 见「边界」

## Required Skills
- `codebase-design`：判断壳层结构。
- `mcode-smoke`：无头验证。

## 背景：路线图 §2 对 UI 线的要求

> **统一会话、项目、文件、Git/Diff、终端、任务、审批、Office、工作流的可见状态和操作**
> **保持数据/工具/工作流的单一业务入口，真实 Electron U1 为关键验收**

**九个东西要「可见状态和操作」。**

## 任务

### 第一步：九个东西现在各自在哪

逐项查「能不能在 UI 里看到、能不能操作」：

| # | 能力 | 能看到 | 能操作 | 在哪 |
|---|---|---|---|---|
| 1 | 会话 | ? | ? | ? |
| 2 | 项目 | ? | ? | ? |
| 3 | 文件 | ? | ? | ? |
| 4 | Git/Diff | ? | ? | ? |
| 5 | 终端 | ? | ? | ? |
| 6 | **任务** | ? | ? | **C 刚建了表，UI 还没有** |
| 7 | 审批 | ? | ? | ? |
| 8 | **Office** | ? | ? | **E 今晚修了出口** |
| 9 | **工作流** | ? | ? | ? |

**每格要有代码证据**（哪个组件、哪个 RPC）。

### 第二步：哪个是「单一业务入口」的违反

> **保持数据/工具/工作流的单一业务入口**

**查有没有重复入口**：
- 同一个能力有两个地方能触发？
- 同一个数据有两个地方能改？

**这是设计边界，不是功能缺失。**

### 第三步：找出「用户最缺的那一个」

**九个里，哪个目前完全不可见？**

**我猜是 #6（任务）** —— C 刚建表，UI 还没有。**但你要自己查，不要信我。**

**然后判断**：**补它需要什么？**（一个新面板？接进现有面板？）

### 第四步：如果我猜对了（任务不可见）

**那就把「任务在 UI 里可见」作为本卡的第一件实事** —— 但它和 E 正在做的重复。

**所以先做第一步（九个东西的盘点表），把结果给我，我再决定派谁做哪个。**

## 验收判据

1. **九个 × 两项（可见/可操作）的表**，每格有证据。
2. **重复入口的检查结果**。
3. **用户最缺的那一个**（按影响排序，不要只列一个）。
4. **不改产品代码**（这一轮先盘点）。
5. 不跑全量、不起 Electron。

## 边界

- **只读 + `.tmp/` 探针**；
- **不改产品代码**；
- 不起 Electron（用户说过不用桌面测试）。

## 回写

`tasks/T104-ui-workbench-closed-loop.md` 末尾追加 `## 结果回写（2026-10-24）`：
九项表、重复入口、最缺的那一个、提交 SHA。

## 结果回写（2026-10-24）

> 执行会话（F）。**只读 + `.tmp/t104/` 探针**，未改产品代码，未起 Electron。
> 结论先行：**九项里八项已经可见且可操作**（其中 #6 任务是几分钟前另一个会话刚做的，
> 尚未提交）；**真正坏的是一处「单一业务入口」违反 —— agent 够得到 `task.accept`。**

### 0. 先纠正卡上的一个过时前提

卡上写「任务：C 刚建表，UI 还没有」。**这条在我开始读的时候就已经不成立**：

```
$ ls -l --time-style=+%H:%M apps/desktop/src/renderer/components/ide/TaskCenterPanel.tsx
-rw-r--r-- 16832 01:35   ← 未提交（git status: ??）
$ grep -rn "TaskCenterPanel" apps/desktop/src --include=*.tsx | grep -v TaskCenterPanel.tsx
RightPanel.tsx:19: import { TaskCenterPanel } from ...
RightPanel.tsx:408: {tab === "taskcenter" && <TaskCenterPanel />}
```

它已经挂进右栏（`registry.ts:95` 的 `BUILTIN_TAB_IDS`），读 `api.task.list`、
写 `api.task.accept` / `api.task.reject`，**但尚未提交** —— 所以「有没有」取决于
另一个会话什么时候提交。这条要写进卡：**盘点结论有保质期。**

### 1. 九项盘点

| # | 能力 | 能看到 | 能操作 | 在哪（代码证据） |
|---|---|---|---|---|
| 1 | 会话 | ✅ 左栏流视图 | ✅ 新建/重命名/归档/置顶/分叉/删除 | `layout/StreamSidebar.tsx:160`（`useSessionStore` 的 projects/streamSessions/pinned/archived/running…）、`layout/SessionTabs.tsx`、`layout/SessionTabContextMenu.tsx` |
| 2 | 项目 | ✅ 左栏作用域下拉 | ✅ 新建/重命名/归档/分组/置顶/删除 | `layout/ProjectManageMenu.tsx`、`layout/LeftBar.tsx:70`（`mode === "stream" ? <StreamSidebar/> : <LeftBar/>`） |
| 3 | 文件 | ✅ 右栏 Files 页签 | ✅ 读/写/新建/删除/改名 + Monaco/预览 | `RightPanel.tsx:376` `{id === "files" && <FilesPanel/>}`；`ide/FileTree.tsx:428`（`file.rename`）、`:1013`（`file.delete`）、`:292`（`file.writeFile` 新建）、`lib/markdownFileWrites.ts:77` |
| 4 | Git/Diff | ✅ 右栏 Git 页签 + 主区 | ✅ 提交/暂存/检出/合并/冲突解决 | `RightPanel.tsx:377` `{id === "git" && <GitPanel/>}`；`ide/GitRepoCard.tsx`、`GitDiffDialog.tsx`、`MergeConflictResolveDialog.tsx`、`WorktreeMergeBack.tsx` |
| 5 | 终端 | ✅ 底部终端栏 | ✅ 新建/写/kill | `shell/ClassicShell.tsx:658` `bottomTerminal={<BottomTerminalBar/>}`；`layout/BottomTerminalBar.tsx` → `ide/TerminalPanel.tsx`（`api.terminal.write` / `kill`） |
| 6 | **任务** | ✅ 右栏「任务中心」页签 | ✅ **验收/退回**（accept/reject） | `RightPanel.tsx:408` → `ide/TaskCenterPanel.tsx`（`useRpc(api.task.list)`；`:144` accept、`:146` reject）。**未提交** |
| 7 | 审批 | ⚠️ **只能看当前待处理的** | ✅ 允许/拒绝 | `chat/ChatPane.tsx:3202` `<ApprovalPrompt/>`，数据源 `sessionStore.pendingApprovals`（`:591`）。**没有历史视图** —— 一旦处理完就消失 |
| 8 | **Office** | ✅ 中栏三种视图模式 | ✅ 编辑/保存 | `ide/FileEditor.tsx:284/290/293`：`genoffice`（只读结构化）、`genoffice-view`（GenOffice 编辑器宿主）、`wysiwyg`（OnlyOffice）。保存走 `onlyoffice.forceSave`（`OnlyOfficeEditorPane.tsx:345`） |
| 9 | **工作流** | ✅ 右栏 Flow 页签 | ✅ 运行/重试/看历史 | `RightPanel.tsx:405` → `chat/WorkflowBoardPanel.tsx`（`api.workflow.get/retry`、`api.runs.history`、`api.session.listNodes`） |

### 2. 「单一业务入口」检查

#### ⚠️ 违反一处：`task.accept` / `task.reject` 对 agent 开放（**这是真问题**）

T99 的 `ipc/task.ts` 文件头写着：

> **一条硬边界：执行方够不到 `accept` / `reject`**
> …它们被 `appControl/policy.ts` 判为 `blocked`（agent 够不到）

**实测不是。** 探针 `.tmp/t104/policy-probe.ts` 直接调 `policyFor`：

```
  task.list                        → read
  task.get                         → read
  task.transition                  → write
  task.accept                      → write      ← 应是 blocked
  task.reject                      → write      ← 应是 blocked
  claude.approve                   → BLOCKED    ← 对照：真的 blocked
  workflow.approve                 → BLOCKED    ← 对照
  hooks.issueHostHookGrant         → BLOCKED    ← 对照
  nonexistent.list                 → read       ← 说明兜底对任何未注册名字都给 read
```

**根因**：`policyFor`（`policy.ts:518-537`）的判定顺序是
`BLOCKED → CREDENTIAL_BEARING → DANGER → EXPLICIT → 动词 → 兜底 write`，
而 `task.accept` **不在 `BLOCKED` 里**（`grep -n "task\." policy.ts` 零命中），
动词 `accept` 也不匹配 `READ_VERB`（`/^(list|get|read|status|…)/`），
于是落到最后的兜底 `write`。

**后果**：`write` 档在 `bypassPermissions` 模式下**直接放行**（`gateAppAction:554` 的
`if (mode && BYPASS_MODES.has(mode)) return null;`），或在用户「始终允许」过同名前缀时放行。
**「AI 自己把任务标成已验收」在代码层是可走通的**，而 T99 的注释说它走不通。

**这条比「任务 UI 有没有」重要得多**：它破坏的是「执行完成 ≠ 验收通过」这条路线图纪律。
修法很小（把两条加进 `BLOCKED`），但**本卡是盘点卡，没有改**。

#### 已确认**不是**重复入口的三处

| 疑点 | 结论 | 证据 |
|---|---|---|
| `ClassicShell` vs `WorkspaceShell` 两套壳 | **不是两棵树**，是同一棵子树的变体摆放 | `WorkspaceShell.tsx` 文件头：切壳改的是 class 不是组件类型；`App.tsx` 永远渲染 `<ClassicShell variant=…>`。显式设计以避免 PTY/Monaco 卸载重建 |
| `TaskListPanel`（"任务列表"页签）vs `TaskCenterPanel`（"任务中心"页签） | **两件不同的事**，名字像 | `TaskListPanel` 读 `terminal.list` + `subagentsBySession` + 活动节点（「此刻在跑什么」）；`TaskCenterPanel` 读 `task.list`（「有哪些任务、谁等我验收」） |
| Office 三条路径 | **同一文件同时只挂一个**，由 `effectiveMode` 二选一 | `FileEditor.tsx:283-293` 是三元链；`genoffice` / `genoffice-view` / `wysiwyg` 互斥渲染 |

#### 手机端：有意的缺口，不是违反

`lib/webApi.ts:894-898` 把 `task.list/get/accept/reject` 全部映射成 `webUnsupported`。
注释写明「手机端没有那条桥」—— **设计上不接受，且显式抛错而不是静默返回空**。
这符合硬规矩 9（未知能力 fail-closed），不算重复入口。

### 3. 用户最缺的那一个

按「完全不可见 → 半可见 → 可见不可操作」排序：

| 排名 | 缺口 | 严重度 | 说明 |
|---|---|---|---|
| **1** | **审批没有历史**（#7 半可见） | **高** | `pendingApprovals` 是瞬时的：处理完就从列表消失。用户看不到「上次那个操作我批了没」「这轮一共批了几次」。**而这正是任务中心的「证据」来源** —— 路线图 §5 要求「追踪状态、失败、审批、产物与证据」，审批这一项现在**追踪不了** |
| 2 | 任务没有「产物」列 | 中 | `Task` 有 `artifacts` 字段（`taskSchema` / `TaskRepo`），但 `TaskCenterPanel` 只展示 goal/status/验收按钮。T97 实测的「生成了一份 docx」**没有出现在任何任务记录里**（`document_tool_call` 零运行记录，见 T97 回写） |
| 3 | `task.accept` 对 agent 开放 | **高（安全）** | 见上。这不是「缺功能」，是**边界破了** |

**所以最缺的不是「任务不可见」——那个已经补上了。**
最缺的是 **#7 审批的可追溯性**，以及它背后的统一问题：**「这次任务批了什么、产出了什么」没有任何一处能完整回答。**

### 4. 需要总控裁决

1. **`task.accept` / `task.reject` 是否立即修？** 两行加进 `policy.ts` 的 `BLOCKED`。
   我认为**应该单独开一张 P0**，因为它破坏的是路线图 §5 的验收纪律，而且修法极小。
   （本卡是盘点卡，未改。）
2. **审批历史**：要不要做？如果要，数据从哪来（`pendingApprovals` 是内存态，没有落表）。
   这是「任务中心能不能追踪证据」的前置条件。
3. **任务卡要有「保质期」**：本次盘点的第 6 项在我读卡时就已经过时（另一个会話刚做完）。
   建议卡上写明「读到某一行时请先 `git status` 确认它还在不在」。

### 5. 未做

- 没改任何产品代码（包括那两条 `BLOCKED` 建议）。
- 没起 Electron，没跑全量。
- 没验 `TaskCenterPanel` 的**实际渲染**（只读了源码；它未提交，也可能还在改）。
