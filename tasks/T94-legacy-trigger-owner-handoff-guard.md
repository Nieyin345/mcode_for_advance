# T94｜Node-RED 迁移前旧触发器不双挂：AutomationRunner 身份门与阴影事件验证（NR-M2 前置）

| 项目 | 值 |
|---|---|
| 编号 | T94 |
| 工作包 | ARC-006 / FULL-3 / T72 NR-M2 小切片：触发注册与派发防重 |
| 优先级 | P0 关键架构 |
| 依赖 | T72/T85 G0/G1 已交付；正式 G2/旧引擎退役仍未授权 |
| 可派 | **立即**，与 T89–T93/T95–T97 并行但只做隔离 E1 |
| 独占可写 | `apps/desktop/src/main/orchestration/automationRunner.ts` 中 `buildTriggers/reload/apply/onTick/runNow/fire` 的最小 engine/owner gate（及必要局部辅助）；新增 `apps/desktop/scripts/t94-trigger-owner-shadow-smoke/**`；本任务卡 |
| 禁写 | `orchestration/library.ts`、`runner.ts`、`scheduler.ts`、`workflowEngines/{registry.ts,nativeLibrarySync.ts,fileExecutorOwnershipStore.ts,executorOwnership.ts,workflowMigrationPreflight.ts}`、`packages/contracts/**`、T92/GenOffice、测试外其他目录 |


## 已核实的风险

T72 源码审查指出：`automationRunner.ts:buildTriggers` 会对 SQL doc 解析并准备旧 cron/watch/event；`workflowEngineSelection.ts:effectiveWorkflowEngine(doc)` 已定义 `doc.engine ?? "mcode"`（旧文档仍归 mcode），但建立旧监听前没有相同来源的明确 engine gate。已有 executor owner claim 可阻挡真正运行冲突，却不能证明旧 watcher 没同时挂载、在途事件没双触发。**必须保留旧图运行，不可把所有 legacy runner 整体关掉**。

## 开工前必读

1. `audit-ledgers/README.md`、T72 的 G2/G3、T85 的 SAFE/HUMAN/REJECT/G0-G1 报告、T46 和 T60 结果。
2. `automationRunner.ts` 中 `reload/apply/buildTriggers/all/onTick/runNow/fire` 和 durable claim/事实表；`workflowEngineSelection.ts`（只读）、`executorOwnership.ts`（只读）。
3. 旧 `automation-*-smoke`、`executor-ownership-smoke`、`executor-gate-d-smoke` 与事件去重相关测试。不得删掉原有去重/批准/未决状态。
4. 独立确认任务期间没有第二名执行者修改 automationRunner；如有，停工记录冲突。

## 执行

1. 先用虚构 `engine:mcode`、`engine:node-red`、无 engine 旧文档、未知 engine 构造红例：旧 runner 绝不能为 Node-RED 所有的 workflow 建立 schedule/watch/event listener 或主动触发；**无 engine 的旧文档必须保持兼容**。
2. 使用现有 `effectiveWorkflowEngine` / owner 来源做 fail-closed guard，令 Node-RED 归属旧 listener 阻断前可追溯、事实表对用户报告“交给 Node-RED”而非静默消失；是否启动新的 Node-RED trigger **不属于本卡**。
3. 在真正触发旧任务之前重新核查当前 engine/revision/owner，避免更换 engine 时晚到旧 watcher/crontick/fire 恢复旧行为；持久 `CLAIMED/UNCERTAIN` 不得被自动重试、覆盖或丢失。对权威 owner 不明的状态拒绝执行，不将 null 默认视作 mcode。
4. 新建无真实副作用的 shadow E1：同一虚构 eventId 向旧调度和虚构 Native 端投递，分别记录 `would-fire` 和实际计数；从未授权/双 owner 冲突出发必须为 0 次副作用，合法归属为 1 次；重复事件、sleep/resume、reload、cancel、in-flight 都要覆盖。
5. 如证明必须改 T97 独占文件或 SQL schema 才能保证原子/跨进程，一律**不要**越界修：本卡只保守拒绝、准确回写 G3 待验项。
6. 运行专项和旧 automation/ownership 回归，另做至少两组变异（去掉 engine guard、去掉派发时 owner gate），源码逐字节恢复；双包 tsc 可并行在源码稳定时执行。

## 验收判据

1. `engine:node-red` 与未知权威不会安装旧监听/允许旧触发执行；无 engine 旧 doc 的正常自动化不回归。
2. 用户可看到“由原生 Node-RED 管理/拒绝旧运行”的事实，而非错误地显示旧 watcher 健康或静默无效。
3. 旧 cron/watch/event 手动与重复事件的隔离样本对同一动作实际 side effect 至多一次；在途/重启/UNCERTAIN 保守阻断，不使用“假 owner claim”装成功。
4. 两项变异红→绿、原测试语义保留、双包 tsc/相关专项通过；文件边界只属 T94。
5. 真实两 OS 进程+Node-RED 原生运行/真实用户迁移/审批与 G2～G5 **未在本卡完成**，如实留空。

## 不做
不删除旧 scheduler/runner，不改变 Node-RED 原生 inject/watch，不切换用户 WorkflowDoc.engine，不触碰数据库或真实定时任务。

## 结果回写区

<!-- 只追加实施提交 SHA、旧红→新绿、测试命令/日志、变异→恢复字节、未验判据和剩余风险。 -->
