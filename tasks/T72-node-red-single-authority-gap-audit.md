# T72｜Node-RED 最终唯一工作流权威：T46 双引擎过渡与 FULL-3 差距审计

| 项目 | 值 |
|---|---|
| 编号 | T72 |
| 类型 | ARC-006 / FULL-3 架构门禁，**只读调查** |
| 优先级 | 高；待 T70 差距审查后派发 |
| 复用等级 | L1 Node-RED 5.0.8 的 runtime/editor/storage/nodes + L2 Mcode 宿主授权和迁移 |
| 写边界 | 仅本任务回写与 `.tmp/t72-*` 分析证据；不改产品/测试源码 |

## 问题
正式总路线图要求 Node-RED 最终成为**唯一 flow 画布、执行内核、存储与触发权威**；T46 当时为了历史图保真选择 B：`engine:"mcode"` 与 `engine:"node-red"` 两套**显式按图归属**的过渡机制。这能避免双触发，却不是最终“只有一套工作流内核”的交付证据。应先证明哪些旧图可以无损迁移、哪些必须保留兼容、怎样防止静默丢失，再决定切换和退役；不得直接删除旧 scheduler。

## 开工前必读
1. `audit-ledgers/README.md`、`audit-ledgers/Mcode_统一审查台账.md` 2026-10-20 “FULL-0～6”目标、`tasks/T46-execution-ownership.md`、T58/T59/T60 回写及 T70 结果。
2. `apps/desktop/src/main/workflowEngines/workflowEngineSelection.ts`、`executorOwnership.ts`、`nativeLibraryLoad.ts`、`nativeLibrarySync.ts`、`nodeRedOwnership.ts`、`flowMigration.ts`、`nodeRedStorage.ts`，`orchestration/scheduler.ts`/`runner.ts`；调用链以最新源码为准。
3. 既有 `workflow-engine-selection-smoke`、`executor-ownership-smoke`、`flow-migration-*-smoke`、`node-red-e2e-smoke` 的安全/迁移/幂等覆盖情况。

## 执行内容
1. 对“画布唯一、存储唯一、执行唯一、触发唯一、Agent 可达、审批唯一、版本 CAS、审计/恢复”八个维度给**现状/过渡合理性/尚未闭环/可复用的上游能力**矩阵；按真正可定位的源码和 E1/E2/U1 判定。
2. 不动用户数据库；在虚构 fixture 上分析 `mcode → node-red` 的可无损、明确拒绝、需人工裁决三类迁移；包括未知 Node-RED 节点、原生全局配置、原生编辑保存反向映射、旧 cron/文件触发器、审批状态和 workflow runboard。严禁把“仓库 13/13 夹具”当用户现存流程完整迁移率。
3. 检查 T46/T58/T59/T60 上报的闭环是否已经跨越部署/读取/重复执行/重启；区分“一个工作流明确单 engine”与“整个应用单 runtime”的两层目标。
4. 给出有界的退役路径：**先兼容读取/无损迁移，再证明原流程不双跑，再切默认/保留只读回退，最后考虑禁用旧 runner**；明确停止条件和回滚证据。不能把迁移失败视为允许清空旧图。
5. 只提交阶段门禁和后续最小新任务建议。正式代码修改、跨进程 CAS/原生 GUI U1 需新的独立实现卡；不要此卡动业务。

## 验收判据
1. 八维度全填，关键结论各有源码位置、当前测试证据等级与未达证据。
2. 给出**可执行的**迁移分批方案、门禁指标、回滚与数据保全方案；对不可无损的旧图明确保留安全过渡。
3. 不宣称现在已经“唯一 Node-RED”完成，除非有真正端到端及独立复核。
4. 结合 T70 而不重复 T43/44 节点工作，不为原 Node-RED 已有能力从零写宿主副本。
5. 无新产品或测试代码；只读调查无需变异，标 N/A；若采用隔离复现，记录版本、命令、结果及负控。

## 边界（不要碰）
不改 `orchestration/**`、`workflowEngines/**`、`node-red/**`、`packages/contracts/**`、`apps/desktop/scripts/**`、其它任务卡或正式台账。任何有实际数据破坏风险的操作都不做。

## 结果回写区
<!-- 执行对话追加八维矩阵、迁移/回滚门禁和建议后续任务卡。 -->
