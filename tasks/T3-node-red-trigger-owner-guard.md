# T3｜Node-RED 工作流触发器单一归属门禁

- Status: ready-for-agent
- Category: bug
- Priority: P0
- Depends on: coordinate with T2 and T4; do not modify their exclusive files
- Exclusive writable files: identify exact trigger dispatch/ownership files before editing; stop if the required path overlaps another active card.
## Required Skills
  - `mcode-smoke`: test trigger ownership and prevent duplicate firing.
  - `code-review`: verify legacy/new runner ownership semantics.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, `audit-ledgers/Mcode_统一审查台账.md`, archived T46/T72/T94.
- Acceptance: one flow has exactly one active trigger owner; legacy AutomationRunner cannot duplicate Node-RED-owned scheduled/event triggers. Cover migration, restart, stale owner, cancellation, and fallback behavior.
- Execute: confirm current code still permits dual ownership; make a narrow change and run isolated smoke. No live user automations.
- Result writeback: proof of one owner, tests, touched paths, remaining deployment/U1 risks, commit SHA.

## 结果回写（2026-10-23）

### 1. 双监听真实存在（修复前 HEAD 的 E1 红例）

新套件 `apps/desktop/scripts/t3-engine-trigger-gate-smoke/`（54 条断言）先在**修复前的
HEAD 版本**上跑，用**真实触发次数**取证（不是读代码）：

| 触发路 | 修复前（HEAD `automationRunner.ts`） | 修复后 |
|---|---|---|
| `engine=node-red` 的定时图（cron `* * * * *`） | 启动那一跳起 **1 次**运行；同一分钟第二跳 + 下一分钟再起 → **2 次** | **0 次**，且该图不进入 `entries` |
| `engine=node-red` 的文件图 | 项目目录被**真装上 `fs.watch`**；写一个 `*.md` → 起 **1 次** | **0 次**，`watchers` 里没有该目录，也没有攒出 pending 批次 |
| `engine=node-red` 的事件图 | `runtimeManager.emit(library.item.downloaded)` → 起 **1 次** | **0 次**，没有 pending 批次 |
| owner 账本 | 每次派发都登记 `mcode`（E1：`executorOwnerOf → "mcode"`），随后被 `runner.ts:947` 的 assert 拒掉 —— **留下失败运行与陈旧登记**，并把 Node-RED 侧的 claim 挡住 | 从不登记；Node-RED 侧可正常 claim |

同一轮红例里，事实表把 node-red 触发器报成 `armed: true`（"响着"），而 `detail` 里没有任何
"由引擎管理"的说明 —— 用户看到的是"它明明挂着却不派发"。

### 2. 下游兜底的真实行为（源码核对，E2）

- `fire()` 在派发前 `claimExecutorOwner(flowId)`（`automationRunner.ts` `claimExecutorOwner`）：Node-RED
  运行中/部署过时 → 冲突，`skip()` 可见但**已经是最后一次派发尝试**；账本为空时 claim 成功，
  然后 `runner.ts` 的 `assertWorkflowExecutor(doc,"mcode")`（`:947`）对 `engine=node-red` 图**抛错**，
  `.catch` 记 `运行失败`，运行入口已经建了后台会话、`bindSession`、写 `recordFired` ——
  **有失败运行、有"已领取"瞬态，且有把 mcode 登记留在账本里的窗口**（修复后实测过：见下面第 5 条变异 3）。
- 时序竞争：`saveWorkflow` 把 engine 从 mcode 切到 node-red 之后到 `reload()` 真正换 `entries`
  之前，旧 crontick / 去抖计时器仍会被叫醒 —— 只靠 owner claim 挡不住"账本为空"的窗口
  （引擎没启动过、从没部署过时 claim 会成功）。

### 3. 修复点（`apps/desktop/src/main/orchestration/automationRunner.ts`，未改 `runner.ts`）

1. **安装门（`buildTriggers`）**：装任何监听之前先取 `legacyTriggerOwnerOf(doc)`，判据复用
   `@main/workflowEngines/workflowEngineSelection.js` 的 **`effectiveWorkflowEngine`**（与保存、
   启动、派发同一份）。`node-red` / 未知值 → **一个监听都不装**（cron / fs.watch / 事件都在
   `entries` 之外），但每条触发器仍在事实表留一行：`armed:false` + `detail`
   「由 Node-RED 引擎管理：旧自动化执行器不安装 cron / 文件监听 / 事件订阅（触发在引擎侧）」。
2. **派发门（`fire`）**：每次派发前**再核一次**同一判据（挡住切换后晚到的 tick / 计时器）；
   拒绝时先把本进程此前登记过的 `mcode` owner **释放**（`releaseExecutorOwner` 只释放自己
   claim 过的，绝不会碰 Node-RED 的登记），再 `skip()` 进事实。
3. **手动入口（`runNow` / `runWithTarget`）**：同样在入口给出"由 Node-RED 管理"的可读拒绝，
   不再走"建会话 → claim → assert 失败 → 留一次失败运行"的老路。

`runner.ts` 一行未改（`assertWorkflowExecutor` 原样保留作最后一道）。

### 4. 迁移期行为（明确且 fail-closed）

- **缺 `engine` 的历史图** → `effectiveWorkflowEngine` 归一成 `mcode`，行为一字不变
  （E1：定时照跑、同分钟去重、文件 watcher 照装）。
- **契约外的 engine 值**（手改库 / 未来新增引擎未在此放行）→ 私有判据直测为
  `{legacy:false, owner:"unknown"}`，**不当作 mcode**；存储层 `WorkflowRepo.parseWorkflowDoc`
  对这类值判坏档（E1 断言：读取抛错，不会流进 `buildTriggers`）。
- **重启**：旧版本在 `automation.lastMinute` 里留下的 node-red 条目由既有 `apply()` 清理路径
  删除（E1 断言盘上那条消失）；第二个进程启动/下一分钟都不再为 node-red 图起运行。
- **取消/释放路径**：`dispose()` 只释放自己 claim 的 flow（E1：node-red 的登记不被偷走）；
  引擎门拒绝路径会把陈旧 `mcode` 登记释放，Node-RED 可立即接管。

### 5. 变异证据（逐字节还原，`cmp` 确认）

| 变异 | 结果 |
|---|---|
| 整个文件换回修复前 HEAD 版本 | **27 条红**（含 3 条"node-red 定时器 0 次"、"真文件事件/真事件 0 次"） |
| 只把 `buildTriggers` 的引擎门置 `false` | **10 条红**，全部是安装/事实/重启残留断言（44/54） |
| 只把 `fire` 的派发门置 `false` | **2 条红**，恰好是"晚到拒绝不动 owner 账本"与"晚到拒绝写进事实"（52/54） |

三次变异后 `cmp -s` 确认源码逐字节还原，再跑 **54/54 通过**。

### 6. 测试与命令

```
bash apps/desktop/scripts/t3-engine-trigger-gate-smoke/run.sh   # 54/54
bash apps/desktop/scripts/automation-smoke/run.sh               # 820/820 + self-budget 10/10
bash apps/desktop/scripts/orchestration-ipc-smoke/run.sh        # 433/433
node-live / memory-codex / event-vertical / module-phase2-e2e / scene-deploy-electron(14/14) /
watch-templates-cas-electron(21/21) / workflow-engine-selection(16/16) / scheduler(111/111) /
executor-ownership(17/17) / executor-gate-d(85/85) —— 全绿
npx tsc --noEmit -p apps/desktop/tsconfig.json   # 0
npx tsc --noEmit -p packages/contracts/tsconfig.json  # 0
```

（`automation-smoke` 等套件须在 `apps/desktop` 下以相对 `$0` 调 `run.sh`，从仓库根直接跑会因
`source "$(dirname "$0")/../lib/esbuild-path.sh"` 解析失败而假红 —— T14 §6 已记录。）

### 7. 提交

- 提交 SHA：`1edec5d8`（`1edec5d883ef1c80b6cbfb85088a94f6bc7dda6a`，代码 + 套件）
- 改动文件：`apps/desktop/src/main/orchestration/automationRunner.ts`；
  新增 `apps/desktop/scripts/t3-engine-trigger-gate-smoke/{main.ts,run.sh,stubs/runner.ts,stubs/runtimeManager.ts}`；
  本任务卡回写（另一次提交）。

### 8. 剩余风险

- **真 Electron U1 未验**：本卡是 E1（无头、假 flow、临时数据根），不冒充 T8 的真实编辑器旅程。
- **旧 runner 删除**不在本卡（T21 候选）；本卡只让 Node-RED 图在**上游**不装监听。
- **`engine=node-red` 图在引擎停止时整体不触发**：这是既有事实（T14 §4.1 行 3），本卡不引入也不修复。
- **引擎切换的保存路径**（`saveWorkflow` 的 `checkEngineSwitch` 等）未改；本卡只读它依赖的同一份
  `effectiveWorkflowEngine`。
- 非 E1 的 `engine` 手改绕过存储层（直接改 SQLite 文件）不在防护面内 —— 与仓库其它"外部改库"同一立场。

