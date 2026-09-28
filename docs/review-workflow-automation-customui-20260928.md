# mcode 审查：工作流 / 自动化 / 自定义 UI 的现存问题

审查时间 2026-09-28，通过远程 MCP 只读通读代码 + 实跑验证。
范围：`apps/desktop/src/main/orchestration/*`、`main/customUi/*`、`renderer/components/customUi/*`、
`renderer/stores/customUiStore.ts`、`packages/contracts/src/customUi.ts`，对照
`docs/workflow-automation-resilience-20260928.md`、`docs/custom-ui.md`、`MCode-前端待办.md`。

**基线（我实跑过）**：`npx tsc --noEmit -p tsconfig.json` → 0 错误；
`node scripts/run-smokes.mjs custom-ui-smoke automation-smoke scheduler-smoke workflow-validation-smoke workflow-view-smoke`
→ 5 pass / 0 fail。所以下面列的**不是回归或类型问题**，是设计边界、可见性与资源代价上的问题。

---

## 一、工作流 / 自动化

### P0-1 看门狗判死之后，引擎那一轮可能还活着，而调度器已经开始重试
`runner.ts: armStallWatchdog()` 判死 → `interrupt()`（"真卡死时没人接"是它自己写的前提）→ `trip()` →
`Promise.race([handle.done, watchdog.tripped])` 返回 → `finally` 里 `active.executing -= 1`、
`releaseText/releaseEnd` 解除扣留 → `outcomeOf` 给 `failed + retryable: true` →
`scheduler.ts: executeOne` 的重试循环**立刻在同一条会话上再发一轮**。

后果：
- 并发额度提前释放，`active.executing` 与真实在跑的轮数不符；
- 对话节点跑在**主对话**上，两轮可能交错吐字到用户的聊天记录里；
- 第二轮 `sendTurn` 遇到没收干净的会话会拿到 `null`，被记成"目标对话没能接上（它正忙）"——
  用户看到的错误原因指向错误的方向。

建议：判死后把该 sessionId 标成 poisoned，重试前要求 `runtimeManager` 确认 idle（或 dispose 重建）；
`target.id === session.id` 的对话节点直接不参与自动重试。

### P0-2 「agent 默认开重试」与「副作用不幂等就不开」的论证自相矛盾
`docs/workflow-automation-resilience-20260928.md` 用"命令/代码节点可能已经写了半个文件"排除它们，
却给 `mcode.agent` 默认 3 次。agent 节点本身就在调工具写盘、跑命令。被看门狗在 30 分钟静默处判死的
那一轮，**最可能的状态恰恰是"工具调用中途"**——重试就是把副作用做第二遍。
建议：agent 的重试限定在"尚未产生任何工具写入"的前提下（有 `tool.use` 记录就不重试），
或在重试的提示词里显式声明"上一轮可能已部分完成，请先核对现状"。

### P1-3 忙碌时的攒批是 1 秒一次的轮询
`automationRunner.fire()` 撞上 `hasActiveRun` 且载荷带数据时 → `this.rearm(pending, 1_000)`。
一次跑几小时的自动化，就是几小时里每秒一次 flush：每次都 `getWorkflow` + `workflowRevision` +
`SessionRepo.listAutomationsByWorkflow` + `hasActiveRun`。没有退避、没有上限。
建议：指数退避（1s → 30s 封顶），或干脆由运行结束事件唤醒这一格。

### P1-4 "已排队一批"在界面上看不见
同一处：被攒起来时直接 `return { ok: true }`，**不记事实**；而 schedule / 无数据事件走 `skip()` 会记
`lastError`。于是"文件改了但排队中"和"跑完了"在 AUTO-09 那一栏长得一样，
恰恰违背该模块自己立的"该跑而没跑成要看得见"。建议加一个 `pendingCount` / `queuedAt` 事实字段。

### P1-5 `withSelfTriggerStatus` 只改 `lastError`，不改 `lastErrorAt`
`automationRunner.statusOf/statusAll` 把自触发停摆原因塞进 `lastError`，时间戳留着上一条的。
界面会把"刚刚发生的停摆"配上一个几天前的时间，或者干脆没有时间。

### P1-6 自触发额度：每次派发整库重写，且只能靠人工重置
`SELF_TRIGGER_COUNT_PREFIX + workflowId` 走 `SettingRepo.set`，而文件头自己写明
`SettingRepo.set` 内部 `persist()` **重写整个数据库文件**（`lastMinute` 那处专门为此做了"值没变就不写"，
这里没有）。更要紧的是额度**只有手动运行才清零**：无人值守场景里一条链在夜里耗尽 10 次额度后
永久停摆，直到有人点一下——这正是这批改动想消灭的那类"依赖人看到并点一下"。
建议：改成滑动时间窗配额（例如每小时 10 次），或成功一次且来源为外部事件时衰减。

### P1-7 `automation.eventChain.<sessionId>` 只写不删
`automationEventOrigin.ts` 的这批 settings 行在 `fire()` 里每次运行都写，没有任何删除路径
（会话删除、工作流删除、清理任务都没有）。settings 表单调增长，且每次写又是一次整库重写。

### P1-8 文件触发在 Linux 上直接不可用
`armWatcher()`：`process.platform !== "win32" && !== "darwin"` 一律不挂。Node ≥ 20 的
`fs.watch(recursive)` 在 Linux 上已可用；headless（`mcodeServer.ts` 那条路）与 Linux 桌面用户的
文件自动化是完全残废的，只有日志和事实表里一行说明。

### P1-9 递归监听项目根，没有生成目录排除
同上 `armWatcher`：`watch(dir, { recursive: true })` 直接盯项目根，`node_modules` / `.git` / `dist`
全在内。大仓库一次 `npm i` 就是几万条事件，每条都要对所有文件触发器跑 glob。
`walkCache` 那边有跳过生成目录的先例，这里应复用。

### P2-10 `pending.files` 只增不减、无条数上限
`onFsChange` 里 `pending.files.push(abs)`，注释明确说"`pending.files` 本身不动"。
一个长期抖动的目录会让这个数组不断变长，最终整批塞进提示词。
自定义 UI 侧有 `CUSTOM_UI_MAX_BATCH = 200`，自动触发这一侧没有对称上限。

### P2-11 来源链超过 64 → 永久跳过，且无自愈
`eventChainForRun()` 抛错 → `skip()`。对用户表现为"自动化突然不跑了"，
提示是"请手动运行建立新链"——又回到需要人工干预。

### P2-12 右键/手动跑一次会全量重扫节点清单
`runNow` / `runWithTarget` 找不到触发器就 `await this.reload(workflowId)`，而 `reload` → `loadTypes()`
会扫插件目录、解析每份清单。文件头自己写"它不该在热路径上被调"，但右键菜单就是热路径。

### P2-13 错过统计的两份状态不同寿
`lastMinute` 跨重启落盘，`missedSweptTo` 与 `AutomationFacts` 只在内存。重启后 warning 消失、
同一段有可能被重新结算一次。另外要确认 `start()` 里 `sweepMissedSchedules()` 与 `reloadAll()` 的先后：
entries 还空着时结算等于一次都数不到。

---

## 二、自定义 UI

### P0-14 用户清空配置后，每次启动都被重新预置
`customUiStore.load()`：`if (parsed.items.length === 0) void seedDefaults(...)`。
没有"已预置过"的标记。一个刻意把自定义项全删光的用户，每次开应用都会被塞回一套默认菜单，
还附带一条 toast。建议加 `customUi.seeded.v1` 标记键。

### P1-15 seedDefaults 整份覆盖，会吃掉 layout 与并发编辑
`save({ version: 1, items, layout: {} })`：把布局清空，并且它是在 `load()` 之后异步跑的——
如果用户此刻已经在设置页保存过一次，这一发覆盖会盖掉。

### P1-16 保存失败后内存与磁盘长期分叉
`save()` 先 `set({ config: next })` 再落盘，失败只弹 toast，内存保留新配置。此后任何一次局部改动都
基于内存再写一遍，用户以为一直保存成功；重启后配置回到旧版本，没有任何冲突提示。

### P1-17 `prompt` 动作会清空已有草稿的富文本
`runCustomItem.ts`：`deliverComposerDraft(sessionId, { text: ..., html: "", tags: prev?.tags ?? [] })`。
`html` 被写死成空串——已有草稿里的富文本/格式内容被丢掉，只有纯文本被接上。

### P1-18 两处"配了却永远不生效"的静默陷阱
- **`when` 用在 `toolbar` / `rightPanel.tab`**：`matchesWhen` 对 `workspace` 目标遇 `requires` 直接
  `return false`，遇 `extensions` 因为 `paths = []` 也 false。结果是这一项**永远不出现**，
  而配置能存下去、设置页也不会拦。
- **`skipWhen.groupIds`**：主进程 `targets.shouldSkipItem()` 构造的 item target 不带 `groupId`，
  于是 `matchesWhen` 里 `gid === undefined` → false → **永远不跳过**。
  契约允许写，实现恒不命中。

两处都应在设置页保存前拦住（或在契约层按 slot 收紧 schema）。

### P1-19 `file` 动作没有路径边界
`resolveWorkspacePath()` 不拦 `..`，且允许绝对路径；工具栏那条路是 `openFileInIde(abs)`，
**不过读文件 RPC 的项目根白名单**（注释自己承认）。目前只有本机用户能写配置所以风险可控，
但设置页已经有 JSON 导入（`coerceCustomUiConfig`）——导入一份别人给的配置就已经越过了那个前提。
建议现在就补：相对路径归一化后必须仍在项目根内，绝对路径要用户确认一次。

### P2-20 自定义页签：读失败与空文件分不开，且轮询代价固定
`CustomTabView.FileTab`：`catch { setContent("") }`，主进程读不到也回空串，界面统一说"文件为空"——
路径写错的用户没有任何线索。另外 4 秒一次整文件读（上限 20 万字符），没有 mtime/哈希短路；
`{{today}}` 只在重新渲染时才换算，跨午夜后轮询仍然盯着昨天那个文件。

### P2-21 批量确认的数字与实际执行可能不一致
`runAutomationWithTarget` 先 `dryRun: true` 数一遍，确认后再真展开一次（`runCustomUiAutomation` 里
重新 `expand`）。两次之间库发生变化，确认框上的 N 就是错的；超过 200 条时是硬失败而不是分批。

### P2-22 其它小口子
- `InputFormDialog` 没有按 form 设 `key`，连续打开两个不同项的表单时 `values` 可能残留；
- `expand()` 里 `existsSync` 后 `statSync` 的竞态会直接抛出（IPC 拿到的是栈信息而不是人话）；
- `copy` 动作依赖 `navigator.clipboard`，失败只有 toast，没有 textarea 回退；
- `collectCollectionIds` 对 group 只在**根分类**上过滤 `isTrash`，后代里的回收站分类仍会被收进去
  （条目层面有 `trashedItemIds` 兜住，但分类层面的语义不一致）。

---

## 三、和现有文档的关系

- `MCode-前端待办.md` 里仍未处理的：#1 文档系统三级创建/移动/链接、#6 GPT 网页桥、#7 远程控制重复结果。
- 本次列的问题与该清单**不重叠**：那份是用户报的现象，这份是代码边界。
- 上面每条都能用现有冒烟钉住：P0-1/P0-2 → `scheduler-smoke`；P1-3~P1-7 → `automation-smoke`；
  P0-14~P1-19 → `custom-ui-smoke`（纯函数部分已在 `targets.ts` / `contracts/customUi.ts` 里）。

## 建议的动手顺序

1. P0-1（看门狗后的重试并发）— 它会污染用户的主对话，且现有断言覆盖不到。
2. P1-18 两处静默失效 — 改动小，属于"配了不生效"这类最伤信任的问题。
3. P0-14 / P1-16 自定义 UI 配置的持久化语义。
4. P1-6 / P1-7 settings 的写入代价与清理。
5. P1-8 / P1-9 文件触发的平台与目录范围。

---

## 修复记录（2026-09-28，同一轮）

全部 22 条已改完。**验证**：`npx tsc --noEmit` → 0 错误；
`run-smokes.mjs scheduler automation workflow-validation node-session node-live run-store frontend workflow-ui custom-ui workflow-view` → **10 pass / 0 fail**。
（没起 Electron 实看界面——下面凡涉及界面的都标了。）

| # | 改了什么 | 落在哪 |
|---|---|---|
| P0-1 | 看门狗判死后**拆掉那段会话的运行时**（`disposeOnTrip`，只对隔离节点会话）；对话节点跑在主对话上不拆，改成**判死后不自动重试** | `runner.ts` |
| P0-2 | 重试判据从"节点类型"改成**事实**：这一轮调过工具（`toolUsed`）就不自动重试，错误里如实说"已经动过工具，可能改了文件" | `runner.ts` |
| P1-3 | 忙碌时攒批由每秒轮询改成**指数退避 1s→30s 封顶** | `automationRunner.ts` |
| P1-4 | 新增 `queuedCount` / `queuedAt` 事实 + `recordQueued`；设置页那栏多一行「N 条排队中」（界面未实看） | `automationStatus.ts`、`ipc/orchestration.ts`、`AutomationRunSection.tsx`、i18n |
| P1-5 | `withSelfTriggerStatus` 同时更新 `lastErrorAt`——否则 `latestFailureOf` 会把这条停摆提示整个吞掉 | `automationRunner.ts` |
| P1-6 | 自触发额度改成**6 小时滑动窗口**（安静下来自动恢复，不再只能人工点）；计数写入前比值、时刻单独存 | `automationRunner.ts` |
| P1-7 | 启动时清掉没人认领的 `automation.eventChain.<sessionId>`；`SettingRepo` 新增 `keysWithPrefix` / `delete` / `deleteMany`（后者只 persist 一次） | `automationRunner.ts`、`repositories.ts` |
| P1-8 | 递归监听放开到 **Linux（Node ≥ 20）**，真不支持时由 `watch()` 抛错如实记账 | `automationRunner.ts` |
| P1-9 | 监听回调按**路径段**跳过 `node_modules`/`.git`/`dist` 等生成目录 | `automationRunner.ts` |
| P2-10 | `pending.files` 上限 500，挤掉最早的一条并记日志（不静默少办事） | `automationRunner.ts` |
| P2-12 | `loadTypes()` 加 5 秒短缓存——右键连点不再每次全量扫插件目录 | `automationRunner.ts` |
| P2-13 | `missedSweptTo` 跟着 `lastMinute` 一起**落盘**，重启不再把同一段"错过"重复数一遍 | `automationRunner.ts` |
| P0-14 | 预置改由 `customUi.seeded.v1` 标记把关，清空过菜单的用户不再每次启动被塞回默认项 | `customUiStore.ts` |
| P1-15 | 预置**合进当前配置**（保留 layout 与用户新建项），不再整份覆盖 | `customUiStore.ts` |
| P1-16 | `save()` 落盘失败**退回落盘前那一份**，内存与磁盘不再长期分叉 | `customUiStore.ts` |
| P1-17 | `prompt` 动作保留已有草稿的 `html`（接在后面，转义后追加），不再清空富文本 | `runCustomItem.ts` |
| P1-18 | 新增 `whenKeysForSlot` / `sanitizeWhen` / `sanitizeSkipWhen`：读配置与设置页保存**同一把尺**裁掉说不通的条件（工具栏/页签上的 requires·extensions、skipWhen 里的 groupIds） | `contracts/customUi.ts`、`CustomUiPanel.tsx` |
| P1-19 | `resolveWorkspacePath` 拒绝相对路径里的 `..`（按段比，不误伤 `..foo`） | `contracts/customUi.ts` |
| P2-20 | 页签区分「读不到 {path}」与「文件是空的」；`{{today}}` 每分钟对表，跨午夜自动换文件 | `CustomTabView.tsx`、i18n |
| P2-21 | 批量确认带上 `expectCount`，两次展开之间条数变了就整次拒绝并说清 | `contracts/customUi.ts`、`main/customUi/runAutomation.ts`、`runCustomItem.ts` |
| P2-22 | `statSync` 竞态兜住；回收站分类不再混进批量；表单按 `id` 设 `key`（值不残留）；剪贴板加 textarea 兜底 | 同上 + `CustomUiHost.tsx`、`customUiStore.ts` |

### 还留着的两件事（说清楚，不装作修了）

1. **来源链超过 64 仍然是"跳过并要求手动建新链"**。自触发额度已经能自愈（滑动窗口），但链长这一条改不动数据模型就没法自愈——它属于"要动图的模型"那一批，和评审里没做的 `onError` 边同一档。
2. **界面没有实看**。新增的那行「N 条排队中」、页签的两句新文案，都只有类型与冒烟背书。

### 建议补的断言（这一轮没加，冒烟都还是绿的）

- `scheduler-smoke`：动过工具的卡死 → `retryable: false`；对话节点卡死不重试。
- `automation-smoke`：忙碌退避曲线、`recordQueued` 的写与清、自触发窗口过期后恢复、`eventChain` 清理只删不存在的会话。
- `custom-ui-smoke`：`sanitizeWhen` / `sanitizeSkipWhen` 的裁剪矩阵、`resolveWorkspacePath` 对 `..` 的拒绝、`expectCount` 不符时拒绝。


