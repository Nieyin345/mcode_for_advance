# T85｜Node-RED 唯一内核迁移 G0/G1：旧工作流无损预检与可恢复清单

| 项目 | 值 |
|---|---|
| 编号 | T85（T72 后续 NR-M0/G0–G1） |
| 重要性 | **P1 架构主链**：先证明旧图迁得了，才考虑旧执行器退役 |
| 来源 | T72 8 维度审计/G0–G5 门禁；ARC-006 FULL-3 |
| 复用 | L1 Node-RED 5.0.8 原生节点/flows storage + L2 现有 `flowMigration.ts` / `roundTripMismatchPaths` / WorkflowRepo |
| 可派 | **立即**；只做数据预检，T49/T73 在飞可并行；不要同时给其它人编辑 `flowMigration.ts` |
| 独占可写 | 新建 `apps/desktop/src/main/workflowEngines/workflowMigrationPreflight.ts`；确需最小适配才改 `flowMigration.ts`（先读现有实现），新增 `apps/desktop/scripts/t85-workflow-migration-preflight-smoke/*` 与本任务卡 |
| 禁写 | `nodeRedStorage.ts`、`registry.ts`、`nativeLibrarySync.ts`（属于 NR-M1 后续）、`orchestration/runner.ts`/ `automationRunner.ts`/ `scheduler.ts`（M2）、`modules/*`/ `appControl/*`、`node-red/**` |


## 核心前提
T72 已确认 T46 每图唯一 engine ownership 只是**兼容过渡**：旧 Mcode 调度器并未统一给 Node-RED；库 SQL 版本与原生 Deploy 版本未原子同步；还有未知第三方节点、原生 Node-RED tab、旧 cron/watch/user-approval 语义不等价。直接清空旧库或强迁会破坏任务/用户数据。T72 定义 G0 只读冻结清单、G1 安全分批 dry-run、G2–G5 才允许触发/切换。**本卡只实现前两步**。

## 开工前必读
1. `audit-ledgers/README.md`、`tasks/T72-node-red-single-authority-gap-audit.md` 8 维矩阵、F-A～I 与 G0–G5 放行表、T46/T58/T59/T60 的最新结果。
2. `apps/desktop/src/main/workflowEngines/flowMigration.ts`、`workflowEngineSelection.ts`、`executorOwnership.ts`、`nodeRedStorage.ts`、`nativeLibraryLoad.ts`（读后者不写）。
3. 既有 `flow-migration-smoke` / `flow-migration-identity-smoke` / `flow-snapshot-isolation-smoke` / `node-red-e2e-smoke` 真实变异/备份契约；不以 13 已知夹具代替用户实际迁移比例。

## 执行
1. 提供一个**纯只读**、在明确隔离工作目录下使用的 Preflight API：输入必须是用户授权的**导出副本**或虚构 WorkflowDoc/flows.json，不接受默认生产 dataRoot；返回每份 doc id、engine、revision、内容 hash、触发来源、审批/在途与未知依赖摘要，和不可读计数。
2. 在相同 clone 上复用原 `migrateWorkflowDoc`、`flowToWorkflowDoc`、`roundTripMismatchPaths` 做 SAFE/HUMAN/REJECT 三分；显式记录字段 diff、未知节点/type、全局配置/原生多 tab、旧 cron/watch debounce、用户分支与待审批语义差异，**不能只凭字段 roundtrip=0 宣称无损可执行**。
3. 对 T72 的 F-A～I 构造虚构 fixture/负例：未知类型、原生复制/改 type、旧审批中断、待触发旧 watcher、损坏 flows.json、并发更新、跨项目路径和额外未识别字段。审计统计 SAFE+HUMAN+REJECT+不可读必须等于总扫描数，任何不可验证归 HUMAN/REJECT 而非静默放行。
4. 不启动/停止任何用户真实 workflow，不部署、不得写真实库/原生 flows.json、不触发外部文件事件。产出的 manifest 含敏感路径或凭据时只存隔离本地和脱敏日志，路径及凭据绝不回传模型聊天。
5. 将用户看得懂的迁移预检报告 DTO 留作后续 UI/Agent 共享通道使用，但不要越权改 T49 的 app_api 或 Node-RED Admin。下一步 NR-M1/M2 是否可派必须经本卡结果与 T77 U1 的实际失败证据。

## 验收
1. F-A～I 的 SAFE/HUMAN/REJECT/不可读判断正确且没有同一 doc 漏掉/重复；原因码和最小修复建议明确。
2. 两次执行 manifest 稳定、源数据完整 byte-for-byte 未变；无法打开、断电模拟、文件篡改/越界/不可信配置**明确拒绝**。
3. 原生第三方节点不被丢弃或误改成 Mcode 已知节点；“未知 Node”不可能在 report 中变 SAFE；旧触发/审批语义异同清单齐全。
4. 两组红→绿变异：撤掉未知节点判据或 trigger 语义门禁，应将 REJECT/HUMAN 错报 SAFE 且专项断言必红；恢复源码 hash 同一。
5. 关联 flow migration / ownership 代表 Smoke 与双包 tsc 绿或如实记录外因；没有真实用户文件/数据库操作。
6. 本卡**不代表** Node-RED 已为唯一引擎，NR-M1 Deploy CAS / NR-M2 触发所有权交接 / NR-M3 GUI U1 都待新卡，不能在此卡删除旧 runner。

## 不做
不实现迁移按钮、不真正 Deploy/切 engine、不让旧调度器提前停用、不借快照校验读取用户实际机密数据。

## 结果回写区

<!-- 执行对话只追加：实际提交、旧红→新绿、源码/上游 SHA、失败负控、测试命令与计数、仍未满足的 U1，不要覆盖正文。 -->


### T85 执行结果（2026-10-21）

- 实现提交：96825dc90b5d75f9ae405547b9d2f956433ace10；上游基线：1c74a2faf29d44ac54e4c5eda912b6ca5ccd94e1。
- 新增纯只读 WorkflowMigrationPreflight DTO/API：只读取显式标记的隔离导出副本或虚构输入；检查文件身份/硬链接/路径越界、UTF-8/JSON、schema、源 hash 与 revision；复用既有迁移适配器做 round-trip 与语义门禁；报告未知依赖、原生多 tab/全局配置/悬空引用、审批/在途/Runboard 历史、触发语义及 G0–G5 放行状态。报告不含绝对源路径；credential-like field path / workflow identity 做脱敏；activationAllowed 始终为 false。
- F-A～I 及附加负例：34/34 断言通过；两次相同快照 manifestHash 稳定；源文件在扫描期间 byte-for-byte 不变。截断 JSON、缺失文件、篡改 hash/revision、跨目录路径、硬链接、原型污染 key、损坏 isolation marker 均明确拒绝/不可读。
- 红色变异负控：移除未知 Mcode 节点门禁后，F-B 专项断言失败；移除 trigger 语义门禁后，顶层 legacy trigger 专项断言失败。变异只在 OS 临时副本执行，源码 SHA-256 前后保持 10cea9dfa3087b0236f9913ff448d7088bf96945bbbddf463cdb756158766a79。
- 测试：node scripts/run-smokes.mjs t85-workflow-migration-preflight-smoke flow-migration-smoke flow-migration-identity-smoke flow-snapshot-isolation-smoke workflow-engine-selection-smoke executor-ownership-smoke executor-gate-d-smoke node-red-e2e-smoke（8/8 suites pass；T85 34/34）；pnpm exec tsc --noEmit -p tsconfig.json（apps/desktop，pass）；pnpm --filter @mcode/contracts typecheck（pass）；git diff --check（pass，只有其他在飞文件的 CRLF 警告）。
- 验收判据：本卡 G0/G1 的 1–5 均通过；无本卡验收判据未达成。T77 U1 的真实 Electron 编辑、Deploy/GET、SQL 回读及重启持久化未在本卡执行；G2–G5 仍明确 blocked，未触发真实 workflow、未 Deploy、未写生产库/flows.json，未删除旧 runner。U1/NR-M1/M2/M3 需后续任务独立验收。
