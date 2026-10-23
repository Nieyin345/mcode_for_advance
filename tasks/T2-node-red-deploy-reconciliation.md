# T2｜Node-RED Deploy 与 Mcode Library 对账恢复

- Status: done（2026-10-23 核查：回写含精确可写文件集与实现范围；提交 4fc72d22）
- Category: bug
- Priority: P0
- Depends on: none; coordinate shared workflow files before starting T3/T4
- Exclusive writable files: declare exact files after inspecting current state; do not overlap T3/T4 or alter release/license gates.
## Required Skills
  - `mcode-smoke`: build isolated deploy/recovery regression with fake flow and storage.
  - `code-review`: inspect state ownership and error paths.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, `audit-ledgers/Mcode_统一审查台账.md`, archived T72/T85/T93.
- Acceptance: native Deploy and Library mirror cannot silently diverge; failures are observable and recoverable; duplicate/late ACK, crash/restart, invalid data, and retry paths are tested. Do not claim cross-store atomicity unless demonstrated.
- Execute: inspect current owner/reconciliation code and Git state; isolate one bounded seam; add old-red/new-green tests and run targeted smoke.
- Result writeback: changed paths, tests, failure/recovery evidence, remaining multi-process/U1 limitations, commit SHA.

## 结果回写（2026-10-23）

### 精确可写文件集（本卡实际写入）

- `apps/desktop/src/main/workflowEngines/nativeLibrarySync.ts`（重写；T58 的 `nativeLibraryDocsOf` / `syncNativeLibraryDocs` 原语义保留）
- `apps/desktop/src/main/workflowEngines/registry.ts`（只改 `mcode-deploy-final` 成功分支、`OwnedNodeRedRuntime` 构造/启动与 `ProductionWorkflowEngineRegistry` 的注入签名）
- `apps/desktop/scripts/node-red-deploy-reconciliation-smoke/{main.ts,run.sh}`（新建）
- 本任务卡

未触碰：`automationRunner.ts`、`fileExecutorOwnershipStore.ts`、`executorOwnership.ts`、`apiCatalog.generated.ts`、`settingsTransfer.ts`、`worktreeOps.ts`、`ApprovalPrompt.tsx`、`McpToolDecisionCard.tsx`、`arc005-visual-baseline/*`、`genoffice/`、`patches/`。

### 实现范围

缺陷原状（旧红）：`registry.ts:557` 的 `void this.syncLibrary(pending.flows).catch(err => log.error(...))` —— 原生 Deploy 2xx 已提交，库镜像失败只有一行日志，没有可查状态、没有重试入口；下一张 Deploy 会拿旧镜像覆盖，重启后用户看不到任何“两边不一致”的事实。

现在的行为（全部在 `nativeLibrarySync.ts` 单一实现，`registry.ts` 只接线）：

1. **可观测**：`mcode-deploy-final(success)` 收到后，在**任何 await 之前**同步把待对账意图写入 `<engine dataDir>/deploy-reconciliation.json`（`recordIntent`）。每份文档结果为 `mirrored | conflict | failed | skipped-native-only | skipped-deleted | removed | superseded`；失败同时经 `nativeMirrorEvents` 发到既有看板通道（`workflow.node.result`，`@node-red-runboard:<docId>`），并经 `OwnedNodeRedRuntime.libraryMirrorState()` 暴露给状态/诊断。
2. **可恢复**：`retryPending` 按**当前**原生 `flows.json` 重放；引擎 `start()` 与下一次 Deploy 自动调用；`acceptNativeRevision` 是唯一的显式覆盖决定。无需用户手工比对。
3. **不宣称跨存储原子**：报告/文案只描述“原生 Deploy 已提交，库镜像待对账”；`describeNativeMirrorFailure` 明说两边可能不一致；镜像失败**不**释放 executor owner、不冒充 Deploy 失败。
4. **精确失败分类**：保存被拒后重读 SQL 文档 —— revision 与预期不符 ⇒ `conflict`（绝不自动覆盖，自动重试也不覆盖）；一致 ⇒ `failed`（可重放）；文档被删 ⇒ `skipped-deleted`；原生 tab 已不存在 ⇒ `removed`。
5. **重复/迟到 ACK**：账本持久记录 `applied` 水位（每文档最近一次成功镜像的 deploy `at`/`deployId`）；同一回执幂等；比已应用（或更新 pending 意图）更旧的迟到回执直接标 `superseded`，不写库。
6. **崩溃/重启**：意图同步落盘，崩溃窗口内（镜像排队/执行中）重启后账本仍在；start 时自动重放。
7. **卡死保护**：单文档保存有 30s 上限，超时记为 `failed` 并可重试，不会永久堵住对账队列。兼容入口 `syncNativeLibraryDocs` 保持 T58 原有微任务时序（不引入超时跳转）。
8. **非法数据**：重复/非法 docId 同步抛错并只写 `lastError`（不伪造 pending）；坏 `flows.json` 时重试显式失败且保留 pending；坏账本隔离为 `*.corrupt-*`（原字节保留）并按空账继续，不静默吞掉。

### 动态证据（E1，无头；未起 Electron）

基线 HEAD：`bb5305b4`；实现提交：`4fc72d22`（提交后在提交状态复跑，见下）。

```
bash scripts/node-red-deploy-reconciliation-smoke/run.sh
  → node-red-deploy-reconciliation-smoke: 75/75 通过

node scripts/run-smokes.mjs node-red-deploy-reconciliation-smoke executor-gate-d-smoke \
  workflow-engine-runtime-smoke arc006-registry-guard-smoke flow-migration-smoke \
  node-red-e2e-smoke workflow-native-load-smoke
  → Smoke summary: 7 pass, 0 fail (7 suites)

node scripts/run-smokes.mjs mcode-node-pack-smoke node-red-theme-smoke
  → 2 pass, 0 fail
node scripts/run-smokes.mjs orchestration-ipc-smoke startup-wiring-smoke automation-smoke workflow-seed-smoke
  → 4 pass, 0 fail
node scripts/run-smokes.mjs workflow-save-version-integrity-smoke workflow-repo-integrity-smoke
  → 2 pass, 0 fail（与 native-load 同批）

npx tsc --noEmit -p apps/desktop/tsconfig.json   → 无本卡相关错误
npx tsc --noEmit -p packages/contracts/tsconfig.json → 通过
```

套件覆盖：§1 旧红例（CAS 失败 → 持久账本 + 看板事件 + 并发编辑未被覆盖）；§2 重试清账；§3 冲突不自动覆盖 / 显式接受才覆盖；§4 重复回执幂等 + 迟到旧回执 superseded；§5 崩溃/重启（意图同步落盘、保存超时、重启重放、恢复事件）；§6 非法载荷/非法画布/坏账本隔离；§7 多文档部分成功不回滚；§8 原生独有 tab / 已删除文档不 upsert；§9 生产入口同步登记与 T58 兼容层；§10 Runtime 接线（deploy-final 后 owner 保留、失败状态可查、措辞如实）；§11 启动重放。

### 变异验证（撤修复 → 必红 → 逐字节还原）

1. 把 `registry.ts` 的 `this.startDeployMirror(pending.flows);` 换回“只 log”实现：
   `FAIL Runtime：镜像失败在状态里可查（不是只剩日志）`、`FAIL Runtime：失败措辞说明“原生已提交、库镜像未完成”`（73/75）。
2. 撤掉 `nativeLibrarySync.ts` 中同步 `recordIntent`：
   `FAIL 崩溃/重启：镜像尚未完成时账本已有 pending`、`FAIL 崩溃/重启：pending 记录 SQL 预期修订`、`FAIL 生产入口：同步登记 pending（await 之前）`（72/75）。

两次均 `cmp` 确认字节还原（恢复后 md5 与备份一致），再跑回 75/75。

注：验证过程中 `.tmp/t2-mutation` 备份目录一度被并行会话清理，`registry.ts` 的变异块残留在工作区；已按原文本手工还原并用 md5（`d7e8699a…`）核对。随后改用与被测文件同目录的 `.mut-*.bak` 备份，还原后再删。

### 剩余限制（如实）

- **跨进程不串行**：对账队列只在单进程内（按 dataDir 串行）；两个 Mcode 进程同时镜像同一引擎目录没有跨进程互斥。原生 `flows.json` 与账本的写各自原子，但二者之间仍不是同一事务。
- **账本写在引擎数据目录**：`deploy-reconciliation.json` 与 `flows.json` 同目录、`atomicReplaceFileSync` 原子替换；若该目录被替换成链接/非普通文件会被拒绝读取，但目录自身被整体替换的场景不在本卡防护范围。
- **无真实 SQL 集成**：套件用与生产端口同形状的 stub（`get/save/revision/changed`）；生产 `saveWorkflow` 的真实校验/CAS 行为只在既存 `executor-gate-d-smoke` / `module-phase2-e2e-smoke` 中覆盖，本卡没有把二者组合成一条端到端 SQL E1。
- **真实 Node-RED Deploy**：`node-red-e2e-smoke` 与 `mcode-node-pack-smoke` 在本机有真实 5.0.8 时通过；它们不走本卡新账本（仅验证旧路径不回归）。本卡没有在真编辑器 GUI 里点 Deploy 并观察账本。
- **U1 未做**：真实 Electron 用户旅程（真编辑器 Deploy → 库镜像失败 → 用户在看板上看到 → 重启后恢复）需要 T8/后续 U1 卡在独占 Electron 下完成；本卡结论仅 E1。
- **没有新增用户可点的“重试”按钮**：重试入口是 `libraryMirrorState()` / `retryLibraryMirror()` / start 自动重放；渲染端 UI 入口留给 T8，不在本卡文件边界内。
- **并发编辑仍会冲突**：镜像失败的 `conflict` 状态需要用户/Agent 明确决定（重新 Deploy 或 `acceptNativeRevision`），本卡不自动合并两版内容。

### 提交

- 实现提交：`4fc72d22`（`fix(T2): make Node-RED deploy↔library mirror observable and recoverable`）
- 仅暂存上述 4 个文件；提交前 `git diff --cached --stat` = `4 files changed, 1431 insertions(+), 22 deletions(-)`；其他会话的未提交修改保持原样未动。
