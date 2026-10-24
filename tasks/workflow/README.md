# 工作流主线：任务卡索引

> 本目录是 **Node-RED 工作流/自动化主线** 的执行卡。编号从 `W0` 开始，与仓库根 `tasks/T*.md` 的全局编号**互不占用**。
> 维护者：工作流总控。执行：子代理（每卡独占文件边界）。

## 路线图要求（`docs/planning/mcode-product-roadmap.md` §2）

> **Node-RED 工作流/自动化** —— 原生画布、运行时、存储、触发权与 Mcode Agent/Host/权限统一
> **唯一流程内核、唯一触发/存储事实源；不长期保留两套运行器或双触发**

四条拆解（验收时逐条对照）：

| # | 要求 | 当前判断 | 依据 |
|---|---|---|---|
| 1 | **原生画布** | 已达成 | `WorkflowCanvas.tsx` 已于 T45（`351e4d9b`）删除，入口换成原厂编辑器 |
| 2 | **运行时统一** | 已达成的形态是「一个调度器 + 多个执行器」 | `nodeRedExecutor` 注册进自研 `ExecutionEngine`（`executionEngine.ts:266`），分派靠 `manifest.runner.kind` |
| 3 | **存储、触发权统一** | U1 已验单 owner + 跨进程 CAS | `t8-node-red-u1` 旅程 `trigger-single-ownership` / `cross-process-owner-cas` |
| 4 | **不长期保留两套运行器/双触发** | 结构上满足；**「只在一处触发」的边界还需持续守** | 同上 |

## 卡列表

| 卡 | 标题 | 状态 |
|---|---|---|
| [W0](W0-workflow-baseline-and-gaps.md) | 工作流主线基线核实与缺口清单 | ready-for-agent |

## 已完成（不在本目录）

历史卡在 `tasks/`：T2（部署对账）、T3（触发 owner 守卫）、T4（跨进程 CAS）、T8（Node-RED U1）、
T10（许可集成）、T13/T19（vendor 集成地图）、T45（删手写画布）、T48/T51/T54（Agent 发现与 guide）、
T81（四步链路）、T84（journey 陈旧断言）、T89（fixup 崩溃）、T95（产品可用性核查）。

**本目录只放从今天起的增量工作**，不复述历史。
