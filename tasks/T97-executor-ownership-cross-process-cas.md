# T97｜持久化工作流 owner 双进程争抢 CAS 证明及最小修复（G3 前置）

| 项目 | 值 |
|---|---|
| 编号 | T97 |
| 工作包 | ARC-006 FULL-3 / T72 G3（只围绕 owner 文件跨进程一致性，不启动 G2） |
| 优先级 | P0 |
| 可派 | **立即**；与 T89–T96 可并行，独占 ownership store 文件 |
| 独占可写 | `apps/desktop/src/main/workflowEngines/fileExecutorOwnershipStore.ts`、确有必要新增的该目录 `fileExecutorOwnershipLease.ts`、新增 `apps/desktop/scripts/t97-cross-process-owner-cas-smoke/**`、本任务卡 |
| 禁写 | `executorOwnership.ts`、`registry.ts`、`nodeRedStorage.ts`、`nativeLibrarySync.ts`、`automationRunner.ts`、`orchestration/**`、`packages/contracts/**`、T92 或其他任务测试 |


## 已知源码与测试缺口（须动态核实，不能先下产品缺陷结论）

`FileExecutorOwnershipStore` 当前构造时把 `executor-ownership.json` 载入实例内 Map；`insert/remove` 从此 Map 复制记录后直接 `atomicReplaceFileSync`，没有明显的 OS 跨进程获取锁/重新读取流程。两个 Mcode 进程可能同时认为空、分别成功 insert 或在撤销中覆盖别人的记录。**这只是静态风险，必须先用两个 OS 子进程争抢夹具证明，不得直接凭观察改动。** 已有 Node-RED `nodeRedStorage.ts` 的 per-file lease 可以作为 L2 薄适配参考，但不复制一套随意新锁。

## 开工前必读

1. `audit-ledgers/README.md`、T72 G2/G3/T46 旧记录、T85 G0/G1 回写。
2. `fileExecutorOwnershipStore.ts`、`executorOwnership.ts`（只读）、`nodeRedStorage.ts` 的 `withOsFileLease`/原子写实现（只读）、`main/lib/atomicFile.ts`。
3. `executor-ownership-smoke`、`executor-gate-d-smoke`、`workflow-engine-selection-smoke`，以及任何既有真实双进程测试。不得拿两对象同进程交替模拟冒充 OS 级并发。

## 执行

1. 在显式隔离的临时 dataDir 用 **两个真实 Node 子进程** 同时构造 store / claim 不同 owner 同 flowId，另测不同 flowId 的并发插入不丢记录、同时 remove/insert、实例启动时 native flows.json 对账、crash 后恢复。
2. 旧源实际红例必须可复现（可能有系统兼容限制，须说明），保存两进程 exit code、磁盘最后记录、owner 事实与原字节 hash；没有红证据禁止改生产源码。
3. 若证实竞态，**复用 OS 锁与每次写前 re-read + CAS** 的现有安全路径，确保跨 OS/进程竞争不产生两个成功 owner、不丢无冲突记录、失败不修改内存 map/磁盘。锁争抢超时/坏档/权限不足一律 fail-closed，不得改为“后写赢”。
4. 如果现有同步 `ExecutorOwnershipStore` 接口无法安全获得锁或实现阻塞会造成 UI 主线程不可接受的等待，回写精确接口不匹配和需要的契约卡，禁止无界 spin、Sleep 或退回不加锁。
5. 同步检查 native flow 在启动的 owner reconciliation 是否可能覆盖其他活进程；兼容 `legacyBlocked`、坏档备份、所有者身份与恢复 claim，不能越权释放。
6. 变异移除 lock / 写前 read / CAS 检查应让真实双进程测试红，逐字节恢复并证明哈希一致；再跑旧 owner/engine 回归和双包 tsc。

## 验收判据

1. **真实 OS 双进程**同 id 竞争至多一个成功 owner；不同 id 并发 insert 不丢记录；跨进程 remove/insert、重启与坏档按 fail-closed 设计一致。
2. 两个实际执行进程不能都认为自己已经取得同一 flow 执行权；证据包含文件最终字节 hash、进程结果、审计/冲突说明。
3. 若发现而无法安全修复必须写明 blocked，不能把一条普通单进程 Smoke 通过当 G3 完成。
4. 至少两项故障注入/变异让动态并发用例变红，源码恢复 hash 相同；原 owner 回归和双包 tsc 不回归。
5. 不实际启动 Node-RED/旧工作流触发器，不变更真实用户 owner 文件或迁移状态；只提交自己所有权范围。

## 不做
不改 Node-RED 或工作流触发算法、不接入真实用户数据、不直接执行 G2/G4/G5 或关闭旧执行器。

## 结果回写区

<!-- 只追加实施提交 SHA、旧红→新绿、测试命令/日志、变异→恢复字节、未验判据和剩余风险。 -->
