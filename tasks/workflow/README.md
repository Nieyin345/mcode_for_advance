# 工作流主线：任务卡索引

> 本目录是 **Node-RED 工作流/自动化主线** 的执行卡。编号从 `W0` 开始，与仓库根 `tasks/T*.md` 的全局编号**互不占用**。
> 维护者：工作流总控。执行：子代理（每卡独占文件边界）。

## 路线图要求（`docs/planning/mcode-product-roadmap.md` §2）

> **Node-RED 工作流/自动化** —— 原生画布、运行时、存储、触发权与 Mcode Agent/Host/权限统一
> **唯一流程内核、唯一触发/存储事实源；不长期保留两套运行器或双触发**

四条拆解（验收时逐条对照）。**下表是 W0 实测后的版本**（原文写于写卡时，有两条被 W0 纠正）：

| # | 要求 | 当前判断（W0 实测） | 依据 |
|---|---|---|---|
| 1 | **原生画布** | **有画布，缺库内编辑入口**。手写 `WorkflowCanvas.tsx` 已于 T45（`351e4d9b`）删除，`grep -rn "WorkflowCanvas" apps/desktop/src/` = **0**；UI 挂的是原生 `WebContentsView` 里的原厂编辑器。**但 `setSelectedNodeId` 的 4 处写入全是初始化/清空，无一处由点击驱动** —— 用户点不到节点、看不到它的参数（缺口 G2） | W0 §1①、§G2 |
| 2 | **运行时统一** | **对「旧 runner」成立，对「整机」不成立**。调用链只有一条（`manifest.runner.kind` → `runner.ts` → `ExecutionEngine` → `nodeRedExecutor`），但**模块级 `executionEngine` 单例永远不注册 `node-red` 执行器**（装配顺序：`index.ts:46` 的 import 早于 `:86` 的端口注入），实际存在两个执行面 | W0 §2.2 探针 |
| 3 | **存储、触发权统一** | **两份存储**：SQL `workflows` 表与 `<engineDir>/flows.json`。`NodeRedFlowStorage` 只是装载日志（`JOURNAL_PROJECT_ID = null`），**不是真相源**。触发分流由 `legacyTriggerOwnerOf` 执行且 fail-closed，`t3-engine-trigger-gate-smoke` 54/54 | W0 §1③ |
| 4 | **不长期保留两套运行器/双触发** | **双跑 = 否**（四层防线全过）；**只保留一套 = 否**（两套都在，靠 owner 表互斥）。**红线满足，目标未达成**，属迁移期状态 | W0 §1④ |

**W0 纠正的三处卡面错误**（已订正，原始判断留在这里以免有人复述旧话）：

- 旅程是 **20 步**，不是 12 步；
- README 原第 1 条「原生画布已达成」→ 应为「有画布、缺库内编辑入口」；
- README 原第 2 条「运行时统一」→ 只对旧 runner 成立。

## 卡列表

| 卡 | 标题 | 状态 |
|---|---|---|
| [W0](W0-workflow-baseline-and-gaps.md) | 工作流主线基线核实与缺口清单 | ready-for-agent（已派，进行中） |
| [W1](W1-palette-drag-from-scratch.md) | 从 palette 拖节点：把「从零搭」变成可验收旅程 | ready-for-agent（已派，进行中） |
| [W2](W2-run-and-see-result.md) | 在 UI 里点一下，看到执行结果 | **blocked-by W1** |

### 队列里还没写的（按依赖排序）

| 下一张 | 要解决什么 | 为什么还没写 |
|---|---|---|
| W3 | **Agent 建图有没有证据**（不是「能不能」） | 已核实：`workflow_guide` 有完整方法论（节点选择表、数据流、失败重试、验收四步），`workflow.nodeTypes` 给参数，`workflow.save` 的 `expectedRevision: null` 就是「创建」。**能力齐全，缺的是「成功过一次」的证据。** 等 W0 确认是否已有。 |
| W4 | 两条触发路径的**同一份事实**（`automationRunner` 与 Node-RED runtime） | 已核实：`automationRunner` 最终也走 `startWorkflowRun`，且 T3 有 `legacyTriggerOwnerOf` fail-closed 守卫。**等 W0 的实测确认守卫真的生效。** |
| W5 | 存储单一事实源：`nodeRedStorage.ts` 与 `workflow.save` 是否同一份 | 已核实：`nodeRedStorage.ts` 609 行，每 flow 一文件 + CAS + 坏档不装空。**等 W0 确认它与 `workflow.save` 的关系。** |


## 已完成（不在本目录）

历史卡在 `tasks/`：T2（部署对账）、T3（触发 owner 守卫）、T4（跨进程 CAS）、T8（Node-RED U1）、
T10（许可集成）、T13/T19（vendor 集成地图）、T45（删手写画布）、T48/T51/T54（Agent 发现与 guide）、
T81（四步链路）、T84（journey 陈旧断言）、T89（fixup 崩溃）、T95（产品可用性核查）。

**本目录只放从今天起的增量工作**，不复述历史。
