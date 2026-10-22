# T93｜Node-RED 原生 Deploy 与工作流库双版本对账/恢复门（NR-M1）

| 项目 | 值 |
|---|---|
| 编号 | T93 |
| 工作包 | ARC-006 / FULL-3 / T72 NR-M1；为迁移 G2 准备，不实际激活旧图 |
| 优先级 | P0 关键架构 |
| 依赖 | T58/T59/T72/T85 已有回写；不等待 T89–T92，但不运行真实 G2 切换 |
| 可派 | **立即**，与 T89–T92/T94–T97 文件写边界分离 |
| 独占可写 | `apps/desktop/src/main/workflowEngines/nativeLibrarySync.ts`、`registry.ts` 中 **`mcode-deploy-final` 与库镜像接线局部**，新建 `nativeDeployReconciliation.ts`（确有必要才建）、新建 `apps/desktop/scripts/t93-native-deploy-reconciliation-smoke/**`、本任务卡 |
| 禁写 | `nodeRedStorage.ts`、`fileExecutorOwnershipStore.ts`、`executorOwnership.ts`、`automationRunner.ts`、`packages/contracts/**`、`node-red/**`、`main/document/**`、`main/appControl/**`、`main/modules/**`、T77/T92 的所有测试或文件 |


## 已核实的生产缺口

`registry.ts` 在原生 `mcode-deploy-final` 成功后启动 `void this.syncLibrary(pending.flows).catch(err => log.error(...))`。即使原版 Node-RED 已 Deploy 成功、Mcode SQL 的 CAS 因并发编辑失败，也只留下日志，宿主尚无可复查的 pending/uncertain 对账状态；`nativeLibrarySync.ts` 又逐张 `get→revision→save`，多 tab 同步在中途失败时可能部分成功。**不能把两份持久化说成已原子提交，也不能用重试覆盖更新**。上游 Node-RED 的编辑/存储、Mcode WorkflowRepo 的审批/CAS 均继续复用。

## 开工前必读

1. `audit-ledgers/README.md`、T72 八维度/G0–G5、T85 结果、T58/T59/T60 回写；确认本卡只做 NR-M1，不做 G2 用户迁移按钮。
2. `registry.ts` 的 `onDeployMessage`（`mcode-deploy-prepare/final`）、`nativeLibrarySync.ts`、`nodeRedStorage.ts`、`orchestration/library.ts` 的 SQL/CAS/review 语义、`workflowSaveVersion.ts`（后三项只读）。
3. `node-red-e2e-smoke`、`workflow-native-load-smoke`、`workflow-save-version-integrity-smoke`、`workflow-repo-integrity-smoke`；确认原生 Deploy 2xx 与 SQL commit 真实顺序。
4. 仓库当前 `git status`，同一个文件如被别的执行对话占用则停止共享文件修改并回写。

## 执行

1. **先做旧红**：受控假 `syncLibrary` 在原生 deploy 成功后返回 `CAS conflict`、异常、部分 tab 成功/后续失败、进程中断，并检查当前只有日志/无法对账的状态。不能在实验里写真实 `flows.json`、SQL 或用户工作区。
2. 在现有两个文件内实现**最小明确的对账事实模型**：记录 deploy identity、native revision/hash、每 doc 的原 SQL expected/observed revision、已镜像/冲突/UNKNOWN、恢复操作允许条件；状态必须可查询、可在重启后由隔离持久证据恢复才可声明“durable”。若现有持久化边界不足以安全增加对账日志，只做测试与确定性 fail-closed 状态，明确列出不可实现项，**不宣称完成跨存储原子性**。
3. 对镜像失败显示/记录不可自动覆写的 `UNCERTAIN`，禁止 silent success、自动覆盖用户已并发编辑的文档，也不得误报告为原生 Deploy 失败或悄悄释放相冲突的 executor owner。
4. 多 tab 逐张对账报告要区分已提交、未提交和冲突；不得把前面已成功的 SQL 保存“逆转”但实际没有 rollback 记账。对于来自原生的编辑继续 `untrustedOrigin:import` 重新审查。
5. 测试两个假编辑客户端交错 Deploy、原生成功后 SQL CAS 失败、cancel/crash、重复/迟到 `mcode-deploy-final`、重放、旧版本覆盖、人工重试、Native node 全局配置/第三方节点保留；禁止实际执行用户工作流。
6. 保持 `Node-RED POST /flows` 官方运行路径；不复制 Node-RED storage adapter，不把整个 `registry.ts` 重写。真实 Electron / G2 迁移需后续 T77 /独立批准。

## 验收判据

1. 原生部署与 SQL 库同步可明确呈现 success/partial/conflict/UNCERTAIN 和对应 revision，不是仅落日志就算同步成功；无能力持久化的阶段如实标未验。
2. CAS 冲突、同一 flow 双编辑端、重复回执、取消与重启预检均 fail-closed；没有静默覆盖，也没有未授权提升执行权。
3. SQL 审批对原生 untrusted 变更仍重新审查，Node-RED 原生节点及无 Mcode docId 的 tabs 不被破坏。
4. 新 Smoke 有至少两项撤掉约束→红的变异并逐字节恢复；相关 Node-RED/原生装载/库版本 Smoke、双包 tsc 通过。
5. 只提交本卡独占文件并回写证据；未能证明双存储真正原子/跨进程 crash 恢复时不可写完成 G2。

## 不做
不直接迁任何旧图，不改 SQL schema/用户 DB/Node-RED 源码，不在本卡做主机真 Deploy 并启动触发器、不动 T89–T92 或 T97 的文件。

## 结果回写区

<!-- 只追加实施提交 SHA、旧红→新绿、测试命令/日志、变异→恢复字节、未验判据和剩余风险。 -->
