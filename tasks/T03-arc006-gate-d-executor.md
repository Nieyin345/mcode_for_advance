# T03｜ARC-006 Gate D：唯一执行器 / 唯一触发器接线

| 项目 | 值 |
|---|---|
| 编号 | T03 |
| 类型 | ARC-006 架构工作包（Gate D / MERGE-2 + MERGE-3） |
| 优先级 | 高 —— Gate D 是 ARC-006 能否收口的硬门 |
| 建议并发 | 可与 T01/T02/T04 并行；**不要**与任何改 `workflowEngines/` 的任务并行 |
| 预计规模 | 大 |

---

## 为什么做这个任务

台账里 Gate D 的定义是：**「逐节点替换旧 Runner/触发器，三家 SDK、真人审批、
取消/重试/运行账本走 Mcode 唯一 Host Service；同一 cron/file event 没有第二次执行。」**

现在的地基已经有了，但**只到一半**：

- `workflowEngines/executorOwnership.ts` —— 执行 owner 的判据与内存注册表，写得很完整
  （显式冲突、只允许当前 owner 释放、未登记 = `null` 要求调用方显式处理）。
- `workflowEngines/nodeRedOwnership.ts` —— 从真实 `flows.json` 提取 flow id 做归属预检。
- `orchestration/automationRunner.ts` —— 已经在 `claimExecutorOwner` 里用了它。
- `workflowEngines/flowTrustGate.ts` —— owner 判据之后的信任闸。

**缺的是**：owner 注册表还**没有落盘**（文件头注释自己写着「本片只做判据 + 内存实现，
不读盘、不写库」），而 `runner.ts` 这条**手动运行**路径是否也走同一闸门，需要逐条核实。
切换期最危险的情形——同一个 cron 在两个执行器上各响一次——目前只有**内存里**的防线，
进程重启就没了。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）+ `CLAUDE.md`（架构与硬规矩）。
2. `docs/planning/arc-006-merge0-baseline.md` 全文 —— MERGE-2/3 的映射表与风险点都在这里。
3. `apps/desktop/src/main/workflowEngines/executorOwnership.ts` 全文（含文件头）。
4. `apps/desktop/src/main/workflowEngines/flowTrustGate.ts` 全文 —— 注意它写的组合顺序。
5. `apps/desktop/src/main/orchestration/automationRunner.ts` 里所有 `executorOwnership`
   的调用点（`grep -n "executorOwnership\\|claimExecutorOwner"`）。
6. 现有回归：`executor-ownership-smoke`、`executor-owner-identity-smoke`、
   `executor-registry-guard-smoke`、`executor-gate-d-smoke`、`node-red-e2e-smoke`、
   `automation-smoke`。先全跑一遍确认基线。

---

## 执行内容

### 1. owner 注册表落盘

把 `ExecutorOwnershipRegistry` 的内存实现换成**落盘**实现（保持同一接口，
现有调用点不改）：

- 存储位置：**不要**新造存储。放进现有的 flows 目录同级的一个文件
  （`<dataRoot>/workflow-engine/executor-ownership.json` 或项目内已有目录，
  先读 `projectFlowDir.ts` / `nodeRedStorage.ts` 确认放哪最不容易与 flows.json 脱节）。
- **原子写**：复用 `@main/lib/atomicFile.js` 的既有出口。不要自己写 `fs.writeFileSync`。
- **崩溃一致性**：写 owner 与写 flows.json 不能各写各的。至少要做到：
  如果 owner 文件损坏或缺失，启动时**不默认成任何一端**，而是走
  `nodeRedOwnership.nativeFlowIds()` 重新推导，并把推导结果显式记录。
- 所有"文件坏了"的分支必须**保留原档**（改名备份）而不是覆盖。

### 2. 核实并补齐 `runner.ts` 的手动运行路径

`automationRunner` 的定时/事件触发已经走 owner 闸；**手动运行**（用户点"运行"）
是否也走？读 `runner.ts` 的 `runWorkflow` 调用链确认。

- 如果没走：补上，且**手动运行必须是用户显式意图**——如果 flow 归 node-red 所有，
  正确行为是**拒绝并说明原因**，不是静默交给 mcode 跑。
- 如果已经走了：在回写区写清它走的是哪一行、哪个判据。**不要**因为"看起来有"就跳过。

### 3. 触发器唯一性

对每一种触发源，证明"同一事件只落一次"：

- cron 定时
- 文件变化（file watch）
- 应用事件（app event）
- 手动点击

做法：新增 `apps/desktop/scripts/executor-trigger-uniqueness-smoke/`，
用**真实 AutomationRunner + 假计时器**（不要用真 sleep 等一分钟）构造"两端都想响应
同一事件"的场景，断言副作用计数 = 1，且被拒的一端有可读原因。

### 4. 迁移期开关

必须有一个**显式的、默认关**的开关（setting key），控制"是否允许 node-red 接管执行"。
默认关意味着：今天的行为一字不变；打开后才走新路径。开关本身要有可诊断的
"当前谁拥有这条 flow"的查询（复用 `executorOwnerOf`）。

---

## 边界（不要碰）

- **不要**改 `apps/desktop/src/renderer/**`（这是纯主进程任务）。
- **不要**改 `document/`、`mobile/`、`modules/`（别的任务在用）。
- **不要**动 Node-RED 上游源码 `genoffice/` 或 `node_modules` 里的 node-red。
- **不要**重新设计 flow 迁移（`flowMigration.ts` 已有，只读）。
- 不要提交任何 `genoffice/` 下的改动。

---

## 验收判据

1. owner 注册表**重启后仍生效**：写一条 owner → 重建 registry → `executorOwnerOf`
   仍返回同一 owner。这是一条**真落盘**断言，不是 mock。
2. owner 文件损坏 → 保留原档 + 重新推导 + 不默认成任何一端（三条断言）。
3. 四种触发源的唯一性各有 ≥ 2 条断言，其中至少一条是"**被拒**"方向。
4. 迁移开关默认关：关着时 `automation-smoke` / `node-red-e2e-smoke` 行为与今天完全一致。
5. 现有 6 套相关 smoke 全绿。
6. 双包 `tsc --noEmit` 干净。
7. **变异验证**：撤掉落盘（改回内存）→ 「重启后仍生效」必须变红；
   撤掉触发器唯一性检查 → 对应的"副作用 = 1"必须变红。

---

## 你要在回写区回答的问题

- owner 文件与 flows.json 的写入顺序是什么？中间崩溃会留下什么状态？
- 手动运行在 flow 归 node-red 时，用户看到的是什么？（贴文案或截图路径）
- 迁移开关打开后，哪些既有行为会改变？逐条列。
- 还有哪些触发源**没有**接入？（例如 relay、手机端手动触发）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
