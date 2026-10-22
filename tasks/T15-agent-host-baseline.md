# T15｜通用 Agent、Provider 与 Host 能力基线矩阵

- Status: ready-for-agent
- Category: task
- Priority: P1 strategic baseline
- Depends on: none
- Exclusive writable files: only new report docs/planning/product-roadmap/T15-agent-host-baseline.md. Do not modify Provider, IPC/contracts, appControl, memory, terminal, Git services, tests, tasks/README.md, or other reports.
## Required Skills
- codebase-design: identify deep module boundaries and the narrow shared interfaces that unblock multiple product lines.
- code-review: verify actual caller-to-handler-to-effect paths and fail-closed semantics.
- research: check official SDK/source/version facts where the repository does not establish them.
- mcode-smoke: classify existing E1/E2/U1 evidence accurately.
- Read each named Skill's SKILL.md before work.
- Read before work: CLAUDE.md, audit-ledgers/README.md, audit-ledgers/Mcode_统一审查台账.md, .scratch/mcode-product-roadmap/spec.md, and relevant ARC-001/002/003/006/MC-035/036 entries.
- Goal: map the general-purpose substrate that must serve UI, GenOffice and Node-RED without hardcoding the scientific-report scenario.
- Execute: record current HEAD and full Git status; preserve all dirty files. Trace native SDK loops and Provider adapters; capability discovery/call APIs; IPC/preload/Host; project/file identity and version/CAS; Git and terminal; approvals/permissions; sessions/tasks; memory/library; automation and extension host; runtime environment selection. Read-only investigation only.
- Acceptance: a capability matrix labels each area implemented/partial/missing/unknown, cites exact source path and caller chain, records tests and evidence grade, identifies cross-cutting blockers and shared-file contention, and proposes no more than five next implementation cards ordered by dependency and leverage.
- Do not: implement an alternative Agent loop, silently switch providers, propose AI-driven environment scheduling (user selects environment), or claim a capability from a catalog entry alone.
- Result writeback: report path, HEAD/status, exact evidence and remaining unknowns, proposed cards, commit SHA.

## 结果回写（2026-10-23）

- **报告路径**：`docs/planning/product-roadmap/T15-agent-host-baseline.md`（新建；本卡唯一产品写入）
- **HEAD**：开工 `4e2d2e0f547fcfcdf631dce7d3d3dec1e5900176`（2026-10-23 02:13:42 +0800）；提交时 master 已前进到 `19e950215cbd93c7cd9357c7626cf309c168a47b`（并行 T23 开卡）。报告行号以开工 HEAD 为准。
- **Git status（开工时，原样保留，未 reset/clean）**：`M .aoci/baseline.json`、`M .gitignore`、`M apps/desktop/scripts/maint-m35-smoke/pickers-prelude.ts`、`M apps/desktop/scripts/orchestration-ipc-smoke/run.sh`、`M apps/desktop/scripts/release-readiness-smoke/check-reviewed.cjs`、`M apps/desktop/src/main/appControl/apiCatalog.generated.ts`、`M apps/desktop/src/main/ipc/settingsTransfer.ts`。提交时另有并行改动（`smokes-for.py`、`t83-*`、`document/*`、新增 `scripts/electron-u1/` 等），**均未暂存、未修改**。
- **本轮只写**：本报告 + 本回写区。未改产品代码、测试、`tasks/README.md`、`audit-ledgers/`、其他报告。

### 关键证据（E1 / E2）

- **E1 复跑 27 套**（全部隔离 dataRoot / 临时目录）：`app-control-smoke` **571/572（1 红：`framework.list/save/reset` 不在 apiCatalog）**、`ipc-wiring-smoke` 45/45、`ipc-parity-smoke` 13/13、`module-app-call-smoke` 13+3 变异、`module-permissions-smoke` 绿+3 变异、`module-extension-lifecycle-smoke` 160/160、`module-phase2-security-smoke` 32/0、`module-catalog-smoke` 21/0、`extension-authoring-smoke` 24/24、`file-version-integrity-smoke` 6/6、`memory-smoke` 305/305、`terminal-smoke` 128/128、`git-discard-smoke` 28/28、`library-trash-smoke` 69/69、`workflow-save-version-integrity-smoke` 16/16、`hooks-ipc-smoke` 184/184、`skill-engines-smoke` 120/0、`unattended-plan-view-smoke` 67/67、`trigger-policy-signature-smoke` 8/8、`host-mcp-server-smoke` 50/50、`session-fork-smoke` 103/103、`runtime-state-smoke` 51/51、`effective-tools-smoke` 140/140、`provider-context-smoke` 56/56、`provider-health-smoke` 24/24、`claude-ipc-smoke` 444/444、`engine-regressions-smoke` pass 34/fail 0、`ipc-error-boundary-smoke` 6/6。
- **E1 实算策略分布**（446 条 RpcMap）：read 131 / ui 4 / write 143 / danger 92 / blocked 76。
- **E1 实算契约缺口**：HEAD 目录 440/446（缺 framework×3 + modules.egressConsentGet/Set + modules.setPermissions）；工作树目录 443/446（缺 framework×3）；`APP_METHOD_PERMISSIONS` 443/446（同缺 framework×3）；`DOMAIN_LABELS` 缺 `framework`。生成器在当前源码上可产 446 条（临时副本验证）。
- **E1 实算扩展可委托面**：`APP_METHOD_PERMISSIONS` 中 danger 档 **91 条可委托**，仅 `workflowEngine.load` 为 null。
- **E2 主干调用链**：`api.claude.sendTurn`（preload）→ `ipc/claude.ts:188` → `RuntimeManager.sendTurn:1127`/`sendTurnBound:1246` → `providerRegistry.get:1272`（fail-closed）→ 三家 `startTurn`（Claude `:514`→`query():1523`；Pi `:93`→`createAgentSession:350`；Codex `:359`→`CodexAppServerClient:109 spawn app-server`）。`app_api_call` → `tools.ts:2491 invokeAppTool` → `gateAppAction:510` → `callRpc:624` → `rpcHandlerFor`（`registry.ts:18`，由 `dbGuardedIpc.ts:89` 同函数登记）。扩展程序 → `mcode.api.call` → NDJSON（`permissionedProcessRunner.ts:745-757`）→ `ModuleHost.callAppFromExtension:400` → `authorizeAppMethod:390` → `tools.ts:2851`（`trustedExtension` 在 `:2653` 跳过 `gateAppAction`）。

### 跨域阻塞项（摘要）

B1 `app_api` 目录漂移（E1 红）；B2 扩展委托绕过逐次审批（91 条 danger）；B3 任务不是一级对象（`SceneTaskRegistry` 纯内存、无 RPC/表/UI）；B4 治理面只写不读（GrantStore 无 list/revoke RPC、ForkOrphanRepo 无读口）；B5 执行环境只有 local/worktree；B6 Provider 升级兼容矩阵不存在。
共享文件争用：`apiCatalog.generated.ts`（当前 dirty）、`appControl/tools.ts`、`appPermission.ts`（生成物）、`ModuleHost.ts`、`policy.ts`、`rpcMap.ts`、15 份手抄 `electron-host.cjs`。

### 剩余未知

- 全部 U1：真 Electron 旅程、真三引擎在线回合、真公网/sshd、真 Node-RED 画布（另行由 T7/T8/T16 承接）。
- `apiCatalog.generated.ts` 工作树改动的 owner 未知（N2 开工前必须先收）。
- 未跑 `pnpm typecheck` / `pnpm test:all` 全量（本轮按域挑 27 套）。
- `module-permissions-smoke` 的 3 组变异红以其自报输出为准，未逐条重放内部断言。
- 同一物理目录登记为两个项目根的竞态（B 类）只有 E2 推断，未做红例。

### 建议卡（与 T16–T20 不重复）

1. **N1 扩展委托危险档收敛**——T19 前置；独占 `gen-module-permission-map.mjs`、`appPermission.ts`、`ModuleHost.authorizeAppMethod` 邻域、`tools.ts invokeExtensionAppCall/trustedExtension` 邻域、新套件。与 T19 共享 `tools.ts`，必须串行。
2. **N2 `app_api` 目录再生成与漂移门禁**——独占 `apiCatalog.generated.ts`（等 dirty 收编）、`gen-app-api-catalog.mjs`、`policy.ts` 的 `DOMAIN_LABELS`/`DOMAIN_TASK_ALIASES`；把「生成物 = 现源码重生成」做成断言。
3. **N3 一级任务对象持久化**——新 `contracts/task.ts`、`store/db.ts` 新表、`store/repositories/task.ts`、`sceneTaskRuntime/Registry` 落盘恢复、`rpcMap.ts` 新增 `task.*`、新套件；宿主铸造 origin。
4. **N4 治理视图（计划授权/分叉孤儿/存档健康）**——`grantStore.ts` 只读枚举+撤销、`forkOrphans.ts` 只读邻域、新 `ipc/governance.ts` + `contracts/ipc/governance.ts`、preload 新命名空间、设置页新面板、新套件。
5. **N5 执行环境抽象与用户选择面（本地/worktree 先行）**——新 `contracts/executionEnvironment.ts`、`ipc/session.ts`（StartSessionSchema 邻域）、`env/environments.ts`（不碰 `agentEnv.ts`）、`ipc/claude.ts resolveSessionCwd` 邻域、`WorktreeModeChip` 邻域、新套件；**AI 不调度环境**，不可用即明确报错。

### T16–T20 前提勘误（详见报告 §5）

T16「不能跑用户旅程」过强（已有 15 套真 Electron 聚焦旅程，缺的是可复用骨架）；T17 的「仍在各自判定」表已过时（`fileEditorKinds.ts` 已委托契约层）；T18「没有任何安装确认 UI」不准确（`ModuleSurface.tsx` 已有逐项权限勾选+代码执行二次同意，且权限集变化重询问已实现；缺的是「允许一次」与全入口模态卡片）；T19「扩展只能经面板 `api.call`」不准确（`core.app.call` 已给无面板扩展开 RPC，且 danger 可委托与 T19 验收第 3 条冲突）；T20 的静态校验/沙箱核验/安装回滚已有半成品可复用。

### 提交 SHA

`__COMMIT_SHA__`
