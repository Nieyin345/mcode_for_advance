# T14｜Node-RED 唯一工作流内核现状与迁移基线

- Status: done（2026-10-23 执行回写，见文末）
- Category: task
- Priority: P1 strategic baseline; data-loss/duplicate-execution findings escalate as P0
- Depends on: none
- Exclusive writable files: only new report docs/planning/product-roadmap/T14-workflow-baseline.md. Do not modify workflow implementation, tests, release/license gates, tasks/README.md, or other reports.
## Required Skills
- research: establish exact Node-RED version/source and evidence for upstream behavior.
- code-review: follow flow state, storage, deploy and trigger ownership paths.
- mcode-smoke: interpret existing migration/deploy regression evidence and identify missing negative controls.
- Read each named Skill's SKILL.md before work.
- Read before work: CLAUDE.md, audit-ledgers/README.md, audit-ledgers/Mcode_统一审查台账.md, .scratch/mcode-product-roadmap/spec.md, archived T72/T77/T85/T93/T94/T97 and active T2/T3/T4/T8/T10 cards.
- Goal: document how Node-RED editor-client/runtime/registry/nodes are actually integrated and where Mcode still has duplicate or competing workflow/automation state.
- Execute: record current outer HEAD/status and exact upstream/fork source SHA/version; preserve dirty state. Trace flow import/migration fields, IDs/wires/tabs/metadata, persistence, deploy/restore, runtime execution, trigger owner, old AutomationRunner overlap, Node/extension entry points, permissions and real Electron evidence. Read-only only.
- Acceptance: provide field-level old-flow-to-Node-RED migration matrix; single-source-of-truth diagram; failure/recovery and duplicate-trigger matrix; exact source/test evidence; U1 gaps; top bounded implementation slices with non-overlapping candidate file paths.
- Do not: change workflow source, execute live user automations, or claim Node-RED is the only runtime merely because the UI loads.
- Result writeback: report path, source SHAs, inspected commands/tests, blockers and commit SHA.

## 结果回写（2026-10-23）

- 报告：`docs/planning/product-roadmap/T14-workflow-baseline.md`
- 源码基线：外层 HEAD `2c93f70ef863084426790c46c11e916644b43904`（master，保留既有 7 个 dirty 文件未动）；vendor `node-red/` = `mcode/integration` @ `935b8d3e12ec8be064f3a72ac6547131f778a7b1` = upstream tag 5.0.8，`git diff 5.0.8..HEAD` 为空（无额外补丁），工作树 clean。
- 读了什么：`tasks/README.md`、`audit-ledgers/README.md` 与统一台账 ARC-006/MERGE-0～5 段、`docs/planning/mcode-product-roadmap.md`、`docs/planning/node-red-vendor-integration-map.md`、`.scratch/mcode-product-roadmap/spec.md`；归档 T72/T77/T85/T93/T94/T97 与当前 T2/T3/T4/T8/T10；Skill `research`/`code-review`/`mcode-smoke` 的 SKILL.md。
- 查了什么（E2）：`workflowEngines/{registry,runtimeSupervisor,nodeRedStorage,nativeLibraryLoad,nativeLibrarySync,nodeRedOwnership,executorOwnership,fileExecutorOwnershipStore,flowMigration,flowTrustGate,workflowEngineSelection,workflowMigrationPreflight,mcodeNodePack,mcodeNodeTypes,nodePackHost,nodePackProductionPorts,engineNodeRegistry,engineNodeReadiness,bootstrapManifest}.ts`；`orchestration/{automationRunner,runner,scheduler,library,workflowTrust,triggerClaim}.ts`；`ipc/{workflowEngine,index,orchestration}.ts`、`appControl/policy.ts`；渲染端 `WorkflowLibraryView/WorkflowNativeEditorEntry/EngineRuntimePanel/WorkflowsPanel`；上游 5.0.8 的 `runtime/lib/api/flows.js`（rev 409 CAS）、`runtime/lib/flows/index.js`（safeMode）、`runtime/lib/storage/index.js`（storageModule 注入点）、`nodes/core/common/20-inject.js`（crontab）。
- 跑了什么（E1，隔离 dataRoot；`bash apps/desktop/scripts/<suite>/run.sh`）：`workflow-engine-selection-smoke` 16/16、`executor-ownership-smoke` 17/17、`workflow-native-load-smoke` 17/17、`executor-gate-d-smoke` 85/85、`flow-migration-smoke` 249/249、`node-red-e2e-smoke` 106/106 + vendor 5.0.8 阶段 PASS。
- 关键发现：①旧 `buildTriggers` 无 engine gate（`automationRunner.ts:497-586`，不 import engine selection），`engine=node-red` 图仍装 cron/watch，靠派遣前 owner claim + `runner.ts:947` 兜底；②Deploy→Library 镜像 fire-and-forget、失败仅 log（`registry.ts:550-558`、`nativeLibrarySync.ts:47-58`）；③`engine-trust.json` 无生产 writer，审批过的原生 flow 重启后仍不执行（`registry.ts:409-417` vs `workflowTrust.ts:89`）；④`FileExecutorOwnershipStore` 无 OS 锁（`fileExecutorOwnershipStore.ts:145-162`），而 `NodeRedFlowStorage` 有（`nodeRedStorage.ts:375`）；⑤`NodeRedFlowStorage`/`workflowMigrationPreflight` 均未接线生产；⑥`engine-trust.json` 只在两套 smoke 里被写。
- 阻塞项：无写操作阻塞；U1 全缺（真 Electron 原生画布、真三 SDK、真双 OS 进程、安装版 vendor 启动）——如实留空。T2/T3/T4 的“先立红”未取得（仓库无 `t93-*`/`t97-*` 套件，T97 无实施提交），报告中已给各片段的候选红例。
- 提交：`c2de98c5ca9c6ddd5b82226e9030d670d21c5b39`（仅本报告；未暂存其他 dirty 文件）。
