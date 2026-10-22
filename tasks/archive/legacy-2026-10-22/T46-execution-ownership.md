# T46｜执行归属：Mcode 原生调度器 vs Node-RED 运行时

| 项目 | 值 |
|---|---|
| 编号 | T46 |
| 类型 | **ARC-006 主线**（架构决策） |
| 优先级 | **高** —— T45 做完后必须回答，否则会出现「两套执行器跑同一张图」 |
| 建议并发 | 改 `workflowEngines/` + `orchestration/`；**先完成 T45** |
| 预计规模 | 中 |

---

## 前提已变（2026-10-21 用户决策）

用户已明确：**手写画布不要了，工作流统一用 Node-RED 编辑器**。

这改变了本卡的问题形态：

- **不再是**「两个编辑器并存，用户选哪个」
- **而是**「编辑统一在 Node-RED，但执行逻辑仍有两套代码路径」

所以本卡的范围收窄为：**决定执行归谁，并让不归自己的那条链显式拒绝。**

## 问题

Mcode 现在有**两套工作流执行器**：

| | Mcode 原生 | Node-RED |
|---|---|---|
| 调度 | `orchestration/scheduler.ts`（就绪即派发、并发上限） | Node-RED runtime 的消息流 |
| 节点执行 | `orchestration/runner.ts` → `runtimeManager.sendTurn` | `mcode-agent` 节点 → port → 同一个 `runtimeManager` |
| 持久化 | `workflow` 表（sql.js） | `flows.json` |
| 续跑 | `runStore` | Node-RED 自己的 context |
| 审批 | `approvalBridge` | 也是 `runtimeManager`（经 port） |

**T42/T43 做完之后，两边都能跑同一张图的语义。** 这会带来真实问题：

- 同一张图被两边同时跑 → 两次执行、两倍 token
- `executorOwnership.ts` 的 owner 注册表只有一份，两边抢同一把锁
- 用户不知道「这个工作流到底归谁跑」

---

## 已有的机制（先读，别重复造）

`apps/desktop/src/main/workflowEngines/` 下已经有：

- **`executorOwnership.ts`** —— owner 注册表（T03/T10 做的），跨进程 CAS
- **`nodeRedOwnership.ts`** —— 从 Node-RED 的 flow 里提取「原生节点」的 flowId
- **`flowTrustGate.ts`** —— 未审批的 flow 不进 runtime
- **`registry.ts` 的 BOOTSTRAP** —— 部署必须走 `POST /flows` 的 owner 握手

**这套「谁拥有这条 flow」的机制已经存在**，本卡要做的是把它扩展到「整张图归哪个执行器」。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/workflowEngines/executorOwnership.ts` **全文**。
3. `apps/desktop/src/main/workflowEngines/nodeRedOwnership.ts` **全文**（83 行）。
4. `apps/desktop/src/main/workflowEngines/flowTrustGate.ts` **全文**。
5. `apps/desktop/src/main/orchestration/scheduler.ts` 的派发逻辑与并发上限。
6. `apps/desktop/src/main/workflowEngines/registry.ts:120-200` 的部署握手。
7. T45 的回写区 —— 它回答了迁移器能到什么程度。

---

## 执行内容

### 第 1 步：确定「一张图归谁」的判据

用户已经把编辑统一到 Node-RED，所以**默认归属就是 `node-red`**。
剩下的问题是：Mcode 原生调度器还要不要保留？

- **A：`node-red` 为唯一执行器** —— 删掉 `orchestration/scheduler.ts` 的图执行路径，
  只留 prompt（提示词型工作流）那一档。
- **B：两者并存，整图显式归属** —— 保留原生调度器给纯 Mcode 节点类型的旧图，
  新图一律 `node-red`。

**倾向 A**，理由：用户的要求是「Node-RED 直接搬」，
留一套并行执行器就是留两套语义要维护。但**要先量迁移成功率**（T45 第 1 步）：
如果大量旧图迁不过去，A 会破坏用户既有工作流，那时选 B。

**这条判断必须写进回写区，不能凭感觉选。**

### 第 2 步：加 `engine` 字段（若选 B）

- 契约给 `WorkflowDoc` / `manifest` 加 `engine: "mcode" | "node-red"`。
- 旧数据默认 `mcode`（**不静默改成 node-red**）。
- 新数据默认 `node-red`。

### 第 3 步：调度器拒绝越界

- 若选 A：原生调度器只处理 prompt 型，遇到图型 → 显式拒绝并指向 Node-RED。
- 若选 B：按 `engine` 字段拒绝。

**双向 fail-closed**，不静默跳过。

### 第 4 步：切换引擎时的迁移

用户在 UI 上改 `engine` 字段时：
- `mcode → node-red`：跑 `migrateWorkflowDoc` + `roundTripMismatchPaths`，
  有丢数据就**拒绝切换并列出丢什么**。
- `node-red → mcode`：跑 `flowToWorkflowDoc`，同样检查。

### 第 5 步：运行看板的数据源

`WorkflowBoardPanel` 读 `workflowLive` 事件，那是 Mcode 原生调度器发出的。

- Node-RED 执行时，这些事件由谁发？
- T43 的 port 实现里，`mcode-agent` 节点的执行已经在 `runtimeManager` 里了 ——
  能不能从那里补发 `workflow.node.*` 事件？

**这是 T46 最实的一块**：让运行看板在两种引擎下都能工作。

---

## 边界（不要碰）

- 不改 `executorOwnership.ts` 的 CAS 语义（只允许扩展）。
- 不改 Node-RED 上游。
- 不改 `runner.ts` 的执行语义。
- 不删 `scheduler.ts`（它是原生引擎的调度器，仍要用）。
- 不改 `document/`。

---

## 验收判据

1. 每个工作流有明确的 `engine` 字段，UI 可见。
2. `engine: "mcode"` 的图被 Node-RED 拒绝执行；`engine: "node-red"` 的图被原生调度器拒绝。
   两条都有断言，且是**显式拒绝**（有可读原因）不是静默跳过。
3. 旧数据加载时，`engine` 按 `roundTripMismatchPaths` 正确推断（有断言）。
4. 切换引擎时，会丢数据的切换被拒绝并列出丢什么（有断言）。
5. 运行看板在两种引擎下都能显示步骤状态。
6. 现有 `executor-ownership-*` / `flow-migration-*` / `workflow-*` 套件全绿。
7. 双包 tsc 干净。
8. **变异验证**：撤掉调度器的越界检查 → 判据 2 红；撤掉切换前的迁移检查 →
   判据 4 红。

---

## 回写区要回答

- 最终选了 A / B / C 哪条判据？为什么？
- 旧数据里有多少张图能完整迁移到 Node-RED？（真实统计，不是估计）
- Node-RED 执行时，`workflow.node.*` 事件从哪发？
- 两张引擎同时存在，用户会不会看到「同一个工作流两个入口」？
- `executorOwnership` 的跨进程 CAS 在节点 port 场景下够用吗？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21｜T46 执行结果

- **最终判据：B（整图显式双引擎归属）**。T45 对仓库可见 5 份自带、7 份预设、1 份示例的已知字段往返给出 13/13，但这**不是用户现存数据库的全量统计**，而且不等于全部节点执行语义可无损迁移。未取得/遍历用户真实库，不虚报迁移成功总数或覆盖率；贸然选 A 删除旧调度器会破坏既有图，因此保留原生调度器只供旧图。所有新建工作流的默认引擎为 `node-red`，仓库旧行缺 `engine` 经 `WorkflowRepo.parseWorkflowDoc` 读取后补 `mcode`，库保存显式写 `engine`。
- **一图一执行器**：`scheduler.runWorkflow` 和 `runner.startWorkflowRun` 都在派发前以同一 `assertWorkflowExecutor` 阻止 `node-red` 图进入原生调度器；Node-RED 宿主的启动及经认证的 `POST /flows` 部署握手，以库内引擎归属核对已标记的 `x-mcode.docId`，拒绝把 `mcode` 图作为原生流执行（不信任网络请求中声称的 engine 字段）。底层 owner CAS 未改，跨进程 flowId 排他仍通过 `executorOwnership` 协议；port 侧共享同一 native owner 租约，不为每步重建所有权。Node-RED 独立原生 tab 不自动伪装成库内 Mcode workflow。
- **切换**：`workflowEngineSelection.ts` 在引擎切换前调用 `migrateWorkflowDoc`、`flowToWorkflowDoc`、`roundTripMismatchPaths`，把 `unmapped` / 人工裁决 / 语义损失和已知字段差异列到拒绝原因；反向切换要求先停运行中的 Node-RED，再只读其真实 `flows.json` 取得唯一 docId 对应 tab，禁止拿旧 SQL 快照替代真实 flow；拒绝未知、损坏和有全局配置节点的模糊迁移；检查全部完成后再做现有 CAS。UI 显示选择框和保存错误。新增测试含旧记录默认值、双向拒绝、双向无损与拒绝案例。
- **看板**：不引入第二套事件事实源。Node-RED `mcode-agent`/`mcode-conversation` 通过 `nodePackProductionPorts.runSelectedSession` 已有的 RuntimeManager Host 端口发 `workflow.node.queued/progress/result`，节点真实结束后才报成功/失败；nodeId 和 tabId 经 Host-owned 原生 tab 映射归入工作流，`_msgid` 作为整轮 runId 的传播后备值。原生 Mcode 的事件保持不变。两种引擎都从 `workflowLive` 消费同一类事件，列表/编辑入口只有一份工作流 + 选择引擎，不另造第二个工作流入口。
- **测试**：`workflow-engine-selection-smoke`、`scheduler-smoke`、`mcode-node-pack-smoke` 通过；`executor-gate-d`、`executor-ownership`、`flow-migration(-identity)`、相关 `workflow-*` 套件复测 16/17，唯一失败的 `workflow-ui-smoke` 当时浏览器未能启动，之后单独复跑已通过（之后选出的 11 个相关套件一起全绿）。两项变异：禁用 `assertWorkflowExecutor` 后归属测试 9/12（红），删除实际 `scheduler.runWorkflow` 守卫后 `scheduler-smoke` 109/111（红）；禁用 `checkEngineSwitch` 后迁移测试 10/12（红）；全部还原为绿。包级 tsc 最终输出及提交 SHA 以随后实测为准。
- **尚未全覆盖**：验收 #5 对 **Node-RED 纯原生 `inject/switch/watch/exec`** 等不经过 Mcode Host port 的节点，当前无法逐步补发 `workflow.node.*`；Mcode Host-backed 节点已接线。用户真实数据库的迁移成功/失败总数无法在仓库隔离夹具内给出，不把 13/13 误写成用户真实统计。
