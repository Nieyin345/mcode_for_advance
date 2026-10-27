# T15｜通用 Agent、Provider 与 Host 能力基线矩阵（只读）

> **注（2026-10-26）**：本报告写于台账制度废止之前，文中对 `tasks/` 与 `audit-ledgers/` 的引用是**历史记录**，那两个目录已删除。功能目标见 `docs/功能文档.md`；进度看代码与套件。

> 2026-10-23 执行。任务卡：`tasks/T15-agent-host-baseline.md`（P1 strategic baseline，只读）。
> **性质：E2 源码调用链 + 本轮 E1 隔离复跑。不是任何 MC/ARC 的完成声明；不把「目录里有」当成「已实现」。**
> 正式完成状态以 `audit-ledgers/Mcode_统一审查台账.md` 为准；本文件不改动任何勾选。

## 0. 基线身份与纪律

| 项 | 值 |
|---|---|
| HEAD（开工时） | `4e2d2e0f547fcfcdf631dce7d3d3dec1e5900176`（2026-10-23 02:13:42 +0800，`revert: drop the controller's duplicate T9 writeback`） |
| HEAD（提交时） | `19e950215cbd93c7cd9357c7626cf309c168a47b`（2026-10-23 03:01:27 +0800，`docs(tasks): open T23 …`）—— 调查期间并行对话推进了 master；本报告结论基于源码文件内容，不受该推进影响，但行号以**开工时 HEAD 为准** |
| 分支 | `master` |
| 工作树 dirty（开工时，**原样保留，本任务未 reset/clean/暂存**） | `.aoci/baseline.json`、`.gitignore`、`apps/desktop/scripts/maint-m35-smoke/pickers-prelude.ts`、`apps/desktop/scripts/orchestration-ipc-smoke/run.sh`、`apps/desktop/scripts/release-readiness-smoke/check-reviewed.cjs`、`apps/desktop/src/main/appControl/apiCatalog.generated.ts`、`apps/desktop/src/main/ipc/settingsTransfer.ts` |
| 提交时新增的并行改动（非本任务，未暂存） | `apps/desktop/scripts/smokes-for.py`、`t83-mcode-editor-tool-bridge-smoke/{main.ts,run.sh}`、`src/main/document/{docsAiPorts.ts,nativeEditorToolTransport.ts}`、`tasks/T0-genoffice-native-tool-roundtrip.md`、新增 `scripts/electron-u1/`、`scripts/t0-…-smoke/`、`scripts/tsx-coverage-smoke/` 等 |
| 本任务写边界 | 仅本报告 + 任务卡回写；未改产品代码、测试、`tasks/README.md`、`audit-ledgers/` |
| 依赖版本（E1，`apps/desktop/package.json`） | `@anthropic-ai/claude-agent-sdk` 0.3.258（:25）、`@earendil-works/pi-coding-agent` 0.83.0（:45）、`@openai/codex` 0.153.4（:54）、`electron` 44.4.5（:75） |

**证据口径**：E1 = 本轮真跑；E2 = 源码调用链静态可复现；E3 = 有线索未证实；U1 = 真 Electron/真三引擎在线旅程（本轮**未取得**，全部如实留白）。

**本轮 E1 复跑（27 套，全部隔离 dataRoot/临时目录，未触真实用户数据）**：

| 套件 | 结果 | 覆盖 |
|---|---|---|
| `app-control-smoke` | **571/572，1 红** | 五档策略、审批、打码、幂等、目录漂移守门 |
| `ipc-wiring-smoke` | 45/45 | 契约→preload→主进程三层对齐 |
| `ipc-parity-smoke` | 13/13 | 每个 register* 被调一次、请求渠道全注册 |
| `module-app-call-smoke` | 13 pass + 3 变异红 | `core.app.call` NDJSON 桥、授权/取消 |
| `module-permissions-smoke` | 绿 + 3 变异红 | 安装授权表、撤权即拒、版本变更重新同意 |
| `module-extension-lifecycle-smoke` | 160/160 | 受控子进程 fs 放行、隔离失败码 |
| `module-phase2-security-smoke` | 32 passed / 0 failed | 任务取消终态、超时不成假成功 |
| `module-catalog-smoke` | 21/0 | 内置能力目录与恢复 |
| `extension-authoring-smoke` | 24/24 | 安装持久化入口、宿主 RPC 调用 |
| `file-version-integrity-smoke` | 6/6 | sha256 版本、流式、读错≠不存在 |
| `memory-smoke` | 305/305 | 记忆读写、作用域、注入、密钥遮蔽 |
| `terminal-smoke` | 128/128 | 真 PTY、项目围栏、大小写漂移 |
| `git-discard-smoke` | 28/28 | 仓库围栏、discard 不越界 |
| `library-trash-smoke` | 69/69 | 资料库回收与关联 |
| `workflow-save-version-integrity-smoke` | 16/16 | 工作流保存版本/过期检测 |
| `hooks-ipc-smoke` | 184/184 | 钩子与 host-hook 授权 |
| `skill-engines-smoke` | 120 checks / 0 failures | 三引擎技能可见性 |
| `unattended-plan-view-smoke` | 67/67 | 无人值守计划视图与 blocked 钉死 |
| `trigger-policy-signature-smoke` | 8/8 | 触发器签名 |
| `host-mcp-server-smoke` | 50/50 | 宿主 MCP 工具表同源 |
| `session-fork-smoke` | 103/103 | 分叉 Saga、孤儿补偿 |
| `runtime-state-smoke` | 51/51 | 运行时存档坏档如实呈现 |
| `effective-tools-smoke` | 140/140 | 三 provider 工具画像同源 |
| `provider-context-smoke` | 56/56 | provider 上下文快照 |
| `provider-health-smoke` | 24/24 | 探测取消不伪装可用 |
| `claude-ipc-smoke` | 444/444 | 会话/turn/审批/fork/中断全链（无头） |
| `engine-regressions-smoke` | node --test pass 34 / fail 0 | 三引擎关键回归 |
| `ipc-error-boundary-smoke` | 6/6 | 恶意 error 不二次抛 |

---

## 1. 结论先行

1. **三家原生 loop 都真实接入且各自保留原生能力**：Claude 走 `query()` 流式输入（`ClaudeAgentSdkProvider.ts:514,1523`），Pi 走 `createAgentSession()` + JSONL `SessionManager`（`PiAgentSdkProvider.ts:93,109,127,350`），Codex 走 `codex app-server` stdio JSON-RPC（`CodexAppServerClient.ts:73,109`）。宿主只做适配，**没有第二个 Agent loop**（E2 + E1 `engine-regressions`/`claude-ipc`/`provider-context`）。
2. **能力发现/调用通道是真实闭环**：`app_api_list → app_api_describe → app_api_call` 背后是 `ipc/index.ts` 登记的**同一批 handler**（`dbGuardedIpc.ts:89 recordRpcHandler` ← `tools.ts:624 callRpc` → `rpcHandlerFor`）。446 条 RpcMap、446 条 preload invoke、五档策略（本轮 E1 实算分布 read 131 / ui 4 / write 143 / danger 92 / blocked 76）。
3. **但「目录与契约对齐」当前是红的**：`app-control-smoke` 本轮 **571/572**，红的一条是 `framework.list/save/reset` 不在 `apiCatalog.generated.ts`。HEAD 目录缺 6 条（framework×3 + modules.egressConsent*/setPermissions），工作树目录缺 3 条（framework×3）。这不是本任务造成，但它是 Agent 发现面的真实缺口（E1+E2）。
4. **扩展→RPC 的第二条通道已经存在，且比 T19 卡面假设的宽**：无面板扩展的程序经 `core.app.call`（`ModuleHost.ts:318,400` → `permissionedProcessRunner.ts:555` NDJSON 双工）就能 `mcode.api.call(method)`；判据是**安装期授权表**（`assertAppMethodPermission`），**没有逐次审批**。当前 91 个 danger 档方法可经此委托（仅 `workflowEngine.load` 被钉 null）。这是对 T19 验收第 3 条的直接反证（E1 实算 + E2）。
5. **文件和记忆的版本/CAS 是完整的**：文件 `sha256(raw bytes)` + OS 租约 + `expectedVersion`（`fileVersion.ts:20`、`files.ts:557-574`），记忆 sha256 revision（`memory/store.ts:227,245,254`），资料库 PDF 高亮/笔记 revision，设置 `compareAndSet`（`setting.ts:66`），工作流保存版本（`workflowSaveVersion.ts:70,74`）。E1 分别有套件。
6. **任务还不是「一级对象」**：`SceneTaskRegistry` 是**纯内存**（`sceneTaskRegistry.ts:127`，启动时 `assembleSceneRuntime()` 重置），无持久化、无 RPC、无 UI 读面；`workflow_runs` 只覆盖工作流运行。产品路线 §3「任务是独立于聊天的一级对象」**缺失**。
7. **执行环境只有 local/worktree 两种**，`envMode` 为会话级布尔（`contracts/session.ts:201`；`sessionSchema.ts:168-172`）；没有环境管理器、没有 Docker/远程/WSL/VM 选择面。远端能力只以 `agent_ssh_*` / `agent_remote_job_*` **工具**形式存在（`agentTools.ts:1736-1987`），不是会话执行环境。
8. **治理面有「登记了但没人看」的孤岛**：`GrantStore`（`appControl/grants.json`）无 list/revoke RPC；`ForkOrphanRepo`（`store/forkOrphans.ts:89`）有 `list/resolve` 但全仓无 IPC/渲染端读取点（E2 grep）。违反「坏东西显式报出来」的结构原则。
9. **扩展安装权限的持久化语义已经比 T18 假设的完整**：安装时逐项勾选 + 代码执行二次同意（`ModuleSurface.tsx:76-87,137-163`），授权表按「模块 id + 版本 + 指纹」绑定（`ModuleHost.ts:373-382`），升级改权限**强制重新同意**（`ModuleHost.ts:480-495`）。缺的是「允许一次」语义和「任何入口安装都弹卡片」，不是从零建模型。
10. **U1 全缺**：本轮无真 Electron 用户旅程、无真三引擎在线回合、无真公网。仓库有 15 份各自手抄的 `electron-host.cjs`（`ls apps/desktop/scripts/*/electron-host.cjs`），说明「起真 Electron」不是不会，而是**没有可复用的旅程骨架**（T16 的真实缺口）。

---

## 2. 能力矩阵

> 每格给：**判定（已实现/部分/缺失/未知）**、证据等级、精确路径、调用者→handler→效果。

### 2.1 三家原生 SDK loop 与 Provider 适配器

| 项 | 判定 | 证据 |
|---|---|---|
| Provider 抽象与注册 | **已实现** | E1/E2。`providers/registry.ts:25` `ProviderRegistry`、`:53 getRequired` 取不到即抛 `PROVIDER_UNAVAILABLE`（绝不回退默认）、`:93-95` 注册三家；默认引擎唯一出口 `providers/defaultProvider.ts:19` → `@contracts/ipc/settings.ts:14`。`claude-ipc-smoke`/`provider-context-smoke` 绿。 |
| Claude 适配 | **已实现** | E2。`ClaudeAgentSdkProvider.ts:514 startTurn` → `:1523 query({prompt, options})`；审批桥 `:802 canUseTool`；会话恢复 `:580 resume`；分叉 `:494 forkSession`；in-process MCP `:1319`；`strictMcpConfig :1474`。 |
| Pi 适配 | **已实现** | E2。`PiAgentSdkProvider.ts:93 startTurn` → `:350 createAgentSession`；恢复 `:109 SessionManager.open`（失败**抛错不静默开新会话**，`:114-126`）；审批由 inline extension `tool_call` 处理器实现（`pi-sdk/mcodeExtension.ts`）。 |
| Codex 适配 | **已实现** | E2。`CodexAgentSdkProvider.ts:359 startTurn` → `CodexAppServerClient.ts:109 spawn(codexPath, ["app-server"])`，JSON-RPC 双工；`dynamicTools` 走 `CodexDynamicTools.ts:10`。 |
| 第四种「网页模型」 | **部分** | E2。不是独立 Provider：`customModel.ts:150-153 protocol:"web"`，`RuntimeManager.ts:1440-1490` 起本地 Anthropic 兼容桥（`bridge/webUpstream.ts:274 runPrompt` → `extensionBridge.ts` SSE）。可用性取决于用户浏览器扩展在线；属于「桥」而非原生 loop。 |
| Provider 能力声明 | **部分** | E2。`ProviderCapabilities`（`contracts/provider.ts:25-87`）三家各自声明（Claude `:424-470`，Pi `:63-92`，Codex `:329-357`）。无**机器可验证**的「声明 vs 实际」矩阵门禁；升级兼容矩阵（路线图 §3 要求）**缺失**。 |
| 引擎选择不静默回退 | **已实现** | E2+E1。`RuntimeManager.ts:1272-1287` 会话记的引擎取不到 → 结构化失败（`provider_unavailable`），`EngineCapabilityMatrix` 只展示不决策。 |

**调用链（turn 主干）**：renderer `api.claude.sendTurn`（`preload/index.ts`）→ `IPC.CLAUDE_SEND_TURN`（`ipc/claude.ts:188`）→ `RuntimeManager.sendTurn`（`:1127`）→ `sendTurnBound`（`:1246`）→ `providerRegistry.get(session.providerId)`（`:1272`，fail-closed）→ `provider.startTurn` → `ctx.emit(RuntimeEvent)` → `claude:event` 广播。

### 2.2 能力发现/调用 API（`app_api_list → describe → call`）

| 项 | 判定 | 证据 |
|---|---|---|
| 三工具 + guide/tutorial | **已实现** | E1/E2。`appControl/tools.ts:1093/1184/1362`，`appApiTutorials.ts`，`guide.ts`（topic 从权威源现场派生）。`app-control-smoke` 系统性断言绿（除目录漂移）。 |
| 与 UI 同一 handler | **已实现** | E1。`dbGuardedIpc.ts:28-90` 每条 `ipcMain.handle` 同时 `recordRpcHandler`；`callRpc` 直接调 `rpcHandlerFor`（`tools.ts:624-628`）。`ipc-wiring-smoke` 45/45、`ipc-parity-smoke` 13/13。 |
| 五档策略 | **已实现** | E1 实算（446 条）：read 131 / ui 4 / write 143 / danger 92 / blocked 76。`policy.ts:486 policyFor`；三张表 `BLOCKED:62`、`DANGER:174`、`CREDENTIAL_BEARING:419`；blocked-but-mutating 显式表 `:468`。 |
| 审批落点 | **已实现** | E2/E1。`gateAppAction`（`tools.ts:510-542`）：write 可「始终允许」、danger 每次问（bypass 也问）、dontAsk 拒绝、无通道 fail-closed；`app-control-smoke` 逐条覆盖（§“审批”断言，571/572 中全绿）。 |
| 幂等/操作账本 | **已实现** | E1/E2。`operations.ts`（意图指纹 + 原子领取 + 全态结算）、`store/operationLedger.ts` durable 版经 `startup/assembleStartup.ts:79` 装配；桌面 `__operationId` 走 `channelIdempotency.ts`（`dbGuardedIpc.ts:33-84`）。 |
| 结果打码 | **已实现** | E1。`redact.ts` 字段/形态双判据，`app-control-smoke` 有正反控。 |
| **目录与 RpcMap 对齐** | **部分（当前红）** | E1。`app-control-smoke` 571/572：`{"missing":["framework.list","framework.reset","framework.save"]}`。HEAD 目录 440/446，工作树 443/446。`gen-app-api-catalog.mjs` 本轮在临时副本上可生成 446 条（E1），说明生成器本身没坏，是**产物过期**。 |
| 域标签/检索 | **部分** | E1 实算：`DOMAIN_LABELS` 缺 `framework`（`policy.ts:508` 无该键；`app-control-smoke` 的「无名域」断言只扫 API_CATALOG，而 framework 恰恰不在目录里 → 空过）。`DOMAIN_TASK_ALIASES` 同样缺。 |
| 扩展权限映射覆盖 | **部分** | E1 实算：`APP_METHOD_PERMISSIONS`（`appPermission.ts:47`）443/446，缺同样 3 条 framework；blocked 档 77 条全部为 null（正控通过）；**danger 档 91 条可委托**（见 §2.9）。 |

### 2.3 IPC / preload / Host

| 项 | 判定 | 证据 |
|---|---|---|
| 契约层 | **已实现** | E1。`packages/contracts/src/ipc/rpcMap.ts:145 interface RpcMap`，**446** 条（与 CLAUDE.md 的 313 已过时）；33 个域契约文件。 |
| preload 白名单 | **已实现** | E1。`preload/index.ts:1414 exposeInMainWorld("api")`，`grep -c ipcRenderer.invoke` = **446**。 |
| 主进程注册 | **已实现** | E1。`ipc/index.ts:105 registerIpcHandlers` 串 40+ `register*`；`ipc-parity-smoke` 验证「契约有/主进程注册/preload 可达」三边一致且每个 register* 恰好调一次。 |
| 统一 DB 闸 + 幂等 | **已实现** | E2。`createDbGuardedIpc`（`dbGuardedIpc.ts:28`）每条先 `awaitDb()`，再按 `sideEffectClassOf` 决定账本。 |
| Host 侧装配顺序 | **已实现** | E2。`startup/assembleStartup.ts:79-115`：视觉中继→durable 账本→GrantStore→无人值守存档→host-hook 授权→模块审批端口→场景运行时→扩展桥令牌；失败即中止（不半初始化）。 |
| 无 handler 通道的如实报错 | **已实现** | E2。`callRpc` 抛「当前版本没有注册」；`apiEntries` 把「已注册但不在目录」的通道并回清单（`tools.ts:205-220`）。 |

### 2.4 项目与文件身份、版本/CAS

| 项 | 判定 | 证据 |
|---|---|---|
| 项目身份 | **部分** | E2。行 id `proj_*` + `projects.path`（`store/db.ts:163-170`，**path 无 UNIQUE、无规范化/去重**；`ipc/projects.ts:32-48` 建项目不查重）。围栏判据唯一：`lib/pathGuard.ts:43 pathWithin`（物理路径，含 symlink/junction）→ `realPathWithin.ts:82`；`:49 findContainingProject`、`:98 isKnownWorkspaceRoot`（项目 ∪ worktree ∪ 资料库/模版）。同一物理目录可被登记两次 → 两个项目根、两套会话桶（E2 推断，未做竞态红例）。 |
| worktree 身份 | **已实现** | E2。`sessionSchema.ts:168-172`（`env_mode`/`worktree_path`）、`wt_style`；物化 `ipc/claude.ts:91-150 resolveSessionCwd/materializeWorktreeSession`（非 git 仓库显式降级并广播）；`lib/worktreeOps.ts`。 |
| 文件版本/CAS | **已实现** | E1。`lib/fileVersion.ts:20 fileContentVersion`（sha256 原始字节、流式、EACCES/EISDIR 抛≠不存在）；`ipc/files.ts:113 readFileGuarded` 回传 version；`:557-574` `withOsFileLease` 内比对 `expectedVersion`，冲突写副本（MC-024）。`file-version-integrity-smoke` 6/6。 |
| 文档编辑 CAS | **已实现** | E2。`document/documentViewHost.ts:1504-1509`（lease + revision 比对）、`ipc/document.ts:32`、`document/genofficeCli.ts`。 |
| 记忆 CAS | **已实现** | E1。`memory/store.ts:227 revisionOf=sha256(raw)`、`:245 assertRevision`、`:254 saveMemoryFile`；契约 `memory.ts:167 expectedRevision`。`memory-smoke` 305/305。 |
| 资料库 CAS | **已实现** | E2。`ipc/library.ts:980-1024`（PDF 高亮 `expectedRevision`，缺省即 fail-closed）、`contracts/ipc/library.ts:274,297`（笔记 revision）。 |
| 设置 CAS | **已实现** | E2（既有套件 `setting-cas-smoke`，本轮未跑）。`store/repositories/setting.ts:66 compareAndSet`；`workflowSaveVersion.ts:70,74`（工作流保存过期检测，`workflow-save-version-integrity-smoke` 16/16）。 |
| 数据完整性底线 | **已实现** | E2。`db.ts:110 PRAGMA foreign_keys=ON`；`:686-689` 导出后恢复 pragma（sql.js 坑的唯一出口）。 |

### 2.5 Git 与终端

| 项 | 判定 | 证据 |
|---|---|---|
| Git | **已实现** | E1/E2。`ipc/git.ts:649 registerGitHandlers`，25 条 RPC（status/stage/commit/push/pull/diff/log/branch/merge/worktree…）；simple-git 懒加载 `:87`；仓库围栏 `findContainingProject :270`；worktree 四操作 `:1172-1200` 薄封装 `lib/worktreeOps.ts`。`git-discard-smoke` 28/28。危险动作钉 danger：`policy.ts:252-257`（push/discard/deleteBranch/worktreeRemove/worktreeMergeBack/merge）。 |
| 终端 | **已实现** | E1/E2。`ipc/terminal.ts:28 registerTerminalHandlers`；cwd 必须 `isKnownWorkspaceRoot` 且 `pathWithin`（`:34-41`）；node-pty 懒加载 `terminal/TerminalManager.ts:81`；`origin` 必留来路。`terminal-smoke` 128/128（真 pwsh，含中文带空格目录）。 |
| Agent 侧文件/搜索 | **已实现** | E2。`file.*` 11 条 RPC（search/grep 走 ripgrep 快路径 `lib/rgSearch.ts`，JS 回退）；`agent_glob/grep/bash/process_*` 在 `mcp/agentTools.ts`。 |
| Git 的 Agent 面 | **部分** | E2。Agent 经 `app_api_call git.*` 可达（write/danger 审批），但 `git.checkout` 靠 EXPLICIT 钉 write（`policy.ts:306`），无「按仓库/分支」的资源级授权（`signPlanGrantForUserApproval` 只签指纹作用域，`tools.ts:562-587`）。 |

### 2.6 权限/审批（`appControl/policy.ts` 五档）

| 项 | 判定 | 证据 |
|---|---|---|
| 五档判定 | **已实现** | E1。`policyFor`（`:486`）；顺序 BLOCKED→CREDENTIAL_BEARING→DANGER→EXPLICIT→动词猜测→兜底 write。实算分布见 §2.2。 |
| danger 语义 | **已实现** | E1。`gateAppAction`：danger 每次弹、不给「始终允许」、bypass 也问；`app-control-smoke` 有正反控。 |
| 计划级授权 | **已实现（有边界）** | E2。`GrantStore`（`grantStore.ts:125`）issue/claimUse/releaseUse；预判 `tools.ts:2626-2644 planGrantPrecheck`；签发只在「用户新鲜点头」`signPlanGrantForUserApproval :579`（agent/system 放行不签发）。只签指纹作用域方法（`:587`），资源作用域方法留待后续。 |
| 真人审批通道 | **已实现** | E2。`ApprovalBridge`（`claude/ApprovalBridge.ts:65-90`）→ `claude.approve`（agent blocked，`policy.ts:63`）→ 渲染端 `components/chat/ApprovalPrompt.tsx`。 |
| 无通道 fail-closed | **已实现** | E1。`gateAppAction :531`；模块审批 `service.ts:34-39`；`module-phase2-security` 32/0。 |
| 引擎原生审批对齐 | **已实现** | E1。`shouldAutoApprove` 唯一判据（`mcp/toolRules.ts`），Claude canUseTool、Pi extension、网页 `webToolHost` 共用；`provider-context-smoke`/`engine-regressions` 绿。 |
| 扩展安装权限模型 | **已实现** | E1/E2。`ModuleInstallSchema`（`contracts/ipc/modules.ts:5-24`）：`confirmReadAccess: literal(true)`、`grantedPermissions` 子集校验、带 `program` 必须 `confirmExecutableCode`；`ModuleHost.install:428` 校验 + 指纹 `:373-382` + 升级改权限重同意 `:480-495` + 失败回滚（权限/工作流授权双向）`:496-528`；持久档案 `ui-modules/module-permissions.json`（`service.ts:50-73`，普通文件/非链接/256KiB/坏档 fail-closed）。 |
| 扩展程序权限执行 | **部分（见 §2.9 阻塞项 B2）** | E1。`ModuleHost.invoke:859-960` 对 action 每次审批、网络独立审批、挂起后重验授权；但 `callAppFromExtension`（`:400-410`）只查安装期授权表，**不逐次审批**，且 91 个 danger 方法可委托。 |
| 审批 UI 一致性 | **部分** | E2（T12 已报告）。`PlanApprovalPrompt` 与 `ApprovalPrompt` 键盘合同不一致，后台会话等审批无侧栏标识 → 归 T6/T12-U1-A，不重复开卡。 |

### 2.7 会话/任务

| 项 | 判定 | 证据 |
|---|---|---|
| 会话对象 | **已实现** | E2。`sessions` 表由 `sessionSchema.ts` 单一列定义生成（30 列：kind/parent_session_id/env_mode/worktree_path/node_id/agent_profile/todos/usage_history…）；`messages` 表 `db.ts:177`。17 条 session RPC。 |
| 会话分叉/补偿 | **已实现** | E1。`lib/sessionFork.ts` + `store/forkOrphans.ts`（`compensateProviderFork :182`）；`session-fork-smoke` 103/103。**但孤儿只有写、没有读面**（见 §3 B4）。 |
| 自动归档 | **已实现** | E2。`session/AutoArchiver.ts`（设置驱动、pin/运行中排除、经 `session.changed` 广播）。 |
| **任务一级对象** | **缺失** | E2。契约 `contracts/sceneTask.ts` 只有类型；`SceneTaskRegistry`（`orchestration/sceneTaskRegistry.ts:127`）纯内存，`sceneTaskRuntime.ts:50` 装配，`runner.ts:1937` 每个节点 `spawn` 一条；**无表、无 RPC、重启即失**（`assembleStartup.ts:105` 每次新建）。`workflow_runs`（`db.ts:238`）只覆盖工作流运行快照；无人值守计划是 JSON 存档（`appServices/unattendedTaskPlan.ts` + `unattendedPlanStore.ts`），与 chat/workflow 任务无统一身份。 |
| 验收 ≠ 执行完成 | **部分** | E2。`OperationResult`（SUCCEEDED/SUCCEEDED_WITH_WARNINGS/REJECTED/FAILED/UNCERTAIN）与 `decodeDomainOutcome` 已落地；但无「任务验收证据」对象。 |

### 2.8 记忆/资料库

| 项 | 判定 | 证据 |
|---|---|---|
| 记忆存储/CAS/审计 | **已实现** | E1/E2。`memory/store.ts`（frontmatter + sha256 revision + 历史/恢复 `:402`）；9 条 RPC；`memory.review`/`categories` 只读开放给 Agent。`memory-smoke` 305/305。 |
| 记忆作用域 | **已实现** | E1/E2。`memory/paths.ts:23 visibleMemory`（global/project/legacy）；Agent 走 `app_api_call` 时由 `tools.ts:2734-2735 runWithAgentMemoryScopeForSession` 包 `AsyncLocalStorage`（`memory/agentScope.ts`），身份取自 `SessionRepo`，**不采信模型参数**。 |
| 记忆注入 | **已实现** | E1/E2。`RuntimeManager.ts:1547-1567 scopedMemorySnapshot` → `memory/retrieval.ts:346`（pinned + 检索 + 最近，cap 12k）；注入回执 `memory/injection.ts traceMemoryTurn`；`memory-injection-smoke` 级套件既有绿。 |
| 记忆写入审批 | **已实现** | E2。`memory/engineTools.ts:12-29`：非只读工具每次 `ctx.requestApproval`，无通道即拒。 |
| 资料库 | **已实现** | E1/E2。48 条 RPC；导入分派 `library/importDispatch.ts:38 importAnyFiles`（pdf/笔记/通用三管线）；条目表 `db.ts:348`；`library-trash-smoke` 69/69。资料库 MCP 工具 `mcp/libraryServer.ts`。 |
| 资料库与对话互通 | **已实现** | E2。`library.attachToChat`（`ipc/library.ts:1145` 邻域）+ 渲染端「+」菜单；引用/关联 `library_item_links`。 |

### 2.9 自动化与扩展宿主（`src/main/modules/` 及相邻）

| 项 | 判定 | 证据 |
|---|---|---|
| 工作流执行内核 | **已实现** | E1/E2。`ExecutionEngine.execute`（`executionEngine.ts:181-205`）：`manifest.runner.kind` → `NodeExecutorRegistry`，未注册落模型兜底，**module-capability 例外 fail-closed**；`scheduler`/`runner`/`runStore`（`workflow_runs`）。 |
| 自动化触发器 | **部分** | E1/E2。`automationRunner.ts:161,2744`；schedule/file/event 三类的装载在 `buildTriggers:497-586`；`trigger-policy-signature-smoke` 8/8。**webhook 无独立执行器**（`WORKFLOW_TRIGGERS` 含 "webhook" `workflow.ts:249`，但 runner 不消费；迁移预检才提到，`workflowMigrationPreflight.ts:841`）；且 `buildTriggers` **不看 `doc.engine`**（T14 已报告），引擎归属与触发安装存在双轨。 |
| 第三方工作流引擎（Node-RED） | **部分** | E1（T14 报告）+ E2。`workflowEngines/registry.ts:635,791`；`ipc/workflowEngine.ts:102`；`workflowEngineSelection.ts:9-20` 单一引擎判据。T14 已证「单图单引擎成立、全应用单 runtime 不成立」。 |
| 扩展宿主（ModuleHost） | **已实现** | E1。`ModuleHost.ts:96`：manifest 校验 `:206`、能力注册/替换原子性 `:146-199,460-528`、任务取消 `:528-546`、隔离执行 `permissionedProcessRunner`（Node `--permission` + 网络拦截 + 协议防伪 `:575-600`）。`module-extension-lifecycle` 160/160、`module-phase2-security` 32/0、`module-catalog` 21/0。 |
| 扩展→RPC（`core.app.call`） | **部分 / 有安全边界缺口** | E1+E2。链路：扩展程序 → `mcode.api.call` → NDJSON `@@mcode:ext-call`（`permissionedProcessRunner.ts:745-757`，上限 128 次/8 在途/64KiB 行）→ `ModuleHost.callAppFromExtension :400` → `authorizeAppMethod :390`（安装期授权）→ `appControl/tools.ts:2851 invokeExtensionAppCall` → `invokeAppTool("app_api_call", …, trustedExtension)`；`trustedExtension` 在 `tools.ts:2653` **跳过 `gateAppAction`** → `acceptResult`。**E1 实算**：`APP_METHOD_PERMISSIONS` 中 danger 档 91 条非 null（git.push/discard/merge、project.delete、session.delete、setting.set、modules.install、mcp.*、plugins.install*、agentSsh.approveHost/revokeHost、runtimes.install、document.edit、workflowEngine.nodeInstall…），仅 `workflowEngine.load` 为 null（`gen-module-permission-map.mjs:43-50` 有明文注释）。 |
| 面板扩展→RPC | **已实现** | E2。`renderer/components/customUi/panelBridge.ts:216 api.call` → `api.customUi.panelApiCall` → `ipc/customUiPanel.ts:26 panelApiCall`（`tools.ts:660`）：blocked 直拒、write/danger 先回 `needsApproval`、桥弹框后带 `approved:true` 重调；`extensionStore.*` 包「无扩展身份」作用域（`agentScope.ts extensionAccessRefusal`）。 |
| VS Code L1 桥 | **部分（无生产 caller）** | E2。`modules/vscodeL1Bridge.ts`（仅 ZIP STORE、两文件、CRC、24KiB 上限）；全仓除 `vscode-l1-smoke` 外**零引用**，无 RPC/UI。 |
| 钩子/插件/技能 | **已实现** | E1/E2。`hooks/`（HookRunner + hostHookGrants，`hooks-ipc-smoke` 184/184）；`plugins/pluginManager.ts`；`skills` 43 RPC（`skill-engines-smoke` 120 checks）。 |
| 自定义 UI 面板宿主 | **已实现** | E2。`customUi/panelProtocol.ts`（`mcode-panel://` 独立 CSP、内容寻址、LRU 48/24MiB）；`customUiPanelPanel.ts` staged；`panelAsk`、`runAutomation`。 |

### 2.10 运行时环境选择

| 项 | 判定 | 证据 |
|---|---|---|
| 引擎运行时安装 | **已实现** | E2。`runtimes/runtimeInstaller.ts`、`runtimeAvailability.ts:166 probeRuntimeAvailability`、`managedRuntimeRoots.ts`；IPC `ipc/runtimes.ts:44-76`（list/install/installLocal/remove）；Pi 从托管目录加载 `piSdkLoader.ts`。 |
| 工具链管理 | **已实现** | E2。`env/toolInstall.ts`、`env/toolchain.ts`、`env/managedToolRoots.ts`；`env/agentEnv.ts:104 applyAgentEnvironment` 注入 PATH/PYTHONUTF8/CLAUDE_CONFIG_DIR（三家子进程 + 终端共享）。 |
| **会话执行环境** | **缺失（仅 local/worktree）** | E2。`envMode: "local" | "worktree"`（`contracts/session.ts:201`、`contracts/ipc/session.ts:57`）；UI `components/chat/WorktreeModeChip.tsx`；无 Docker/WSL/VM/远程环境抽象、无环境管理器、无「不可用即明确报错」的统一对象。 |
| 远端执行（工具形态） | **部分** | E2。`agent_ssh_connect/exec/status`、`agent_remote_job_*`（`mcp/agentRemoteSsh.ts`，主机信任授权 `ipc/agentSsh.ts`，`agentSsh.approveHost` 对 Agent 是 danger、对扩展可委托）；这是**命令级**远端能力，不是会话执行环境。 |
| AI 不调度环境 | **部分（边界尚可）** | E2。`app_session_new` 不暴露 envMode（`tools.ts:1434-1460`）；但 `claude.startSession`（write 档）schema 允许 `envMode`（`ipc/session.ts:57`），Agent 经 `app_api_call` 带审批可请求 worktree；`session.updateSettings` 为 danger（改既有会话环境需每次批）。无自动切换路径。 |

---

## 3. 跨域阻塞项

**B1｜`app_api` 目录漂移把「发现面」撕开一个口子（E1 红）**
`app-control-smoke` 571/572：`framework.*` 三条不在 `apiCatalog.generated.ts`。后果：Agent `app_api_list` 看不到 `framework` 域，`app_api_describe framework.save` 落到「没有这个方法」；同时 `DOMAIN_LABELS`/`DOMAIN_TASK_ALIASES`/`APP_METHOD_PERMISSIONS` 三处同缺（E1 实算），扩展经 `core.app.call` 调 `framework.*` 会命中「未知方法，没有可授权的权限映射」被拒（fail-closed，方向安全但能力不可达）。根因：T64（`a1690047`，2026-10-21 21:27）加契约后未重跑生成器；T67 的重生成（`5b14a9c3`，20:13）在其之前。`gen-app-api-catalog.mjs` 在当前源码上可产 446 条（E1 临时副本验证），产物可修。
**影响面**：所有经 `app_api_*` 的自动化/扩展/教程；`app-control-smoke` 门禁长期带一红会让「红是常态」。

**B2｜扩展程序的 RPC 委托绕过了逐次审批（E1/E2，安全边界）**
`core.app.call` 通道在 `invokeAppTool` 里以 `trustedExtension` 身份跳过 `gateAppAction`（`tools.ts:2653`），只复核安装期授权表。后果：一个在安装时拿到 `git.write`/`project.write`/`modules.install`/`terminal.run` 的扩展，其程序可以**无逐次真人点头**执行 `git.push`、`project.delete`、`modules.install`、甚至 `agentSsh.approveHost`（映射到 `terminal.run`，`appPermission.ts:48-50`）。这与「AI 可配置但不可自授权」「危险操作真人点头」的边界存在张力——扩展不是 Agent，但它是**同一台机器上的第三方代码**。`gen-module-permission-map.mjs:43-45` 的注释承认这一设计（“Extension RPCs bypass invokeAppTool's interactive approval gate once the host has authenticated the extension”），但只把 `workflowEngine.load` 一条钉成不可委托。**这是 T19 的前置问题**：不先收敛，T19 开放 API 面等于把 91 条 danger 通道正式化。

**B3｜任务不是一级对象（E2，产品结构缺口）**
路线图 §3 要求「稳定 ID、目标、依赖、审批、状态、日志、检查点、产物、验收证据，可由聊天/工作流/自动化/多 Agent 关联推进」。现状：`SceneTaskRegistry` 纯内存、无 RPC、无表；`workflow_runs` 只覆盖工作流；无人值守计划另存 JSON。跨入口无法回答「这个任务是谁派的、总花了多少、失败在哪一步、验收过没有」。

**B4｜治理面只写不读（E2，违反「坏东西显式报出来」）**
- `GrantStore`（`appControl/grants.json`）：29 处 `getGrantStore()` 消费，**无 list/revoke RPC**（`rpcMap.ts` grep `grant` 只有 host-hook 与 agentSsh）。
- `ForkOrphanRepo.list/resolve`（`store/forkOrphans.ts:132,159`）：除 smoke 外**无 IPC/渲染端读取点**。
- 后果：计划级授权（含 TTL）与引擎侧孤儿会话文件在用户界面上都不可见，只能靠日志。

**B5｜执行环境只有本地/worktree（E2，产品主线缺口）**
路线图 §3「执行环境由用户选，AI 不调度；逐步支持本机、Docker、远程服务器、云、WSL、虚拟机；统一环境管理器」。现状只有 `envMode` 二值。`agent_ssh_*` 是工具级远端命令，不能承接「项目默认环境 + 单任务覆盖」。

**B6｜Provider 升级兼容矩阵不存在（E2，维护性缺口）**
三家 SDK 版本在 `package.json` 硬钉；`ProviderCapabilities` 是声明，无机器校验「声明 vs 实际行为」；路线图 §2 要求「升级通过兼容矩阵与测试验证」。当前靠 `engine-regressions-smoke` 等散套，升级时没有一张可执行矩阵。

---

## 4. 共享文件争用

| 文件 | 争用方 | 现状/风险 |
|---|---|---|
| `apps/desktop/src/main/appControl/apiCatalog.generated.ts` | **当前已 dirty**（工作树改动 +57/−33，补了 modules.* 三条）；任何再生成卡；T19 明确「不改」 | 谁再跑生成器都会覆盖现有 dirty 内容。再生成卡必须先与该 dirty 的 owner 协调或以「提交后的新 HEAD」为基线。 |
| `apps/desktop/src/main/appControl/tools.ts` | 扩展 RPC（`invokeExtensionAppCall`）、审批、计划授权、幂等 | 2869 行、全仓库最多调用链；`core.app.call` 收敛与 T19 都会碰它 → 必须串行。 |
| `packages/contracts/src/appPermission.ts` | **生成文件**（`gen-module-permission-map.mjs` 写出） | 手改会被下次生成覆盖；扩展权限收敛卡必须先改生成器。 |
| `apps/desktop/src/main/modules/ModuleHost.ts` | T18/T19/T20、扩展权限收敛 | 安装事务/授权/隔离执行全在这里；同文件多代理写入必冲突。 |
| `apps/desktop/src/main/appControl/policy.ts` | 五档表、T6、T19 | 新方法归类与 danger 收敛都要动；改表会影响 `app-control-smoke` 的多条钉死断言。 |
| `packages/contracts/src/ipc/rpcMap.ts` | 所有新 RPC | 改它要同时跑 `gen-app-api-catalog.mjs` + `gen-module-permission-map.mjs` + `ipc-wiring`/`ipc-parity`/`app-control` 三套。 |
| `apps/desktop/scripts/*/electron-host.cjs` | **15 份手抄副本**（arc005-pane、arc005-visual、document-view×2、genoffice-ai-ask、html-preview、module-phase2-e2e、scene-deploy、settings-focus、settings-panels、slides-edit、t73-browser、watch-templates-cas、workflow-engine） | 每份都重复 `app.setPath` 隔离骨架；T16 的「可复用驱动」落地后应作为唯一来源，否则每加一条 Electron 旅程就多一份漂移。 |
| `tasks/README.md` | 总控 | 本任务只读；新卡由总控登记。 |

---

## 5. T16–T20 前提勘误（只读核对结论，不改卡）

- **T16**：卡面「现在整个项目**能拍静态截图，但不能跑用户旅程**」过强。仓库已有 15 套真 Electron 套件在做**聚焦旅程**（如 `settings-focus-electron-smoke` 用真 `sendInputEvent` 验焦点所有权与 inert 时序；`document-view-electron-smoke` 开真编辑视图；`scene-deploy-electron-smoke`、`workflow-engine-electron-smoke`）。真实缺口是**可复用的声明式驱动骨架**与「故意失败」自检，不是「不会起 Electron」。建议 T16 顺带把 15 份 `electron-host.cjs` 的隔离骨架抽成共享模块（否则它交付后又多一份）。其余判据（真 `app.whenReady`、每步证据、三种断言档、零新依赖优先）成立。
- **T17**：卡面「仍在各自判定的地方」表已过时——`renderer/components/ide/fileEditorKinds.ts` **已经**委托契约层（`isPdfFile`/`isMarkdown`/`isImage`/`isUnsupported` 均转 `genofficeAppForPath`/`documentKindOf`，:70-91；`languageForExt` 是 Monaco 语言映射，不是文档路由）。真正残留：`renderer/stores/sessionStoreHelpers.ts:69 isMarkdownPath`、`:74 isImagePath`、`:91+ isUnsupportedPath`（自带扩展名表，注释明确说「不是镜像」）、`components/library/ItemDetail.tsx:426`（`mdPath.endsWith(".md")`），以及主进程 `document/genofficeCli.ts:496`（转换输出白名单）与 `documentViewHost.ts:234-250`（.docx 命名，非路由）。执行前请以实际 grep 为准；「四份判据」的旧假设应改成「契约层三入口 + 若干残留调用点」。
- **T18**：卡面「当前**没有任何安装确认 UI**（`grep installConfirm` 零命中）」不准确。`renderer/components/modules/ModuleSurface.tsx` 已有安装时逐项权限勾选（`:137-155`，高风险标注）、只读声明同意勾（`:156`）、可执行代码独立同意勾（`:160-163`）、安装按钮按同意态禁用（`:163`）、安装后逐权限开关（`:114-129`）；接线在 `settings/CustomUiPanelParts.tsx:774-776` 与 `ide/FilesPanel.tsx:92`。且「权限集变化必须重新询问」**已经实现**（`ModuleHost.install :480-495` + 指纹绑定 `:373-382`），坏档 fail-closed 也在（`modulePermissionArchive :367-372`）。T18 真正缺的是：①「允许一次（本次安装+本次运行）」与「始终允许」的二态卡片；②把设置页里的选择器提升为**任何安装入口都必过的模态卡片**（目前只存在于 manifest 粘贴式安装）；③超时/丢消息=拒绝的显式合同。建议按「提升现有 UI + 补一次语义」重写卡面，而不是从零建权限模型。
- **T19**：卡面「扩展已经能调任意 RPC，但入口很窄：`panelBridge.ts:216` 的 `api.call`，**只对有面板 UI 的扩展开放**」与源码不符。无面板扩展的程序已经通过 `core.app.call` 拿到 `mcode.api.call`（`ModuleHost.ts:318` → `permissionedProcessRunner.ts:555` → `tools.ts:2851`），且有 `module-app-call-smoke` 的 E1 正控（「extension calls file.readFile and claude.sendTurn twice over live NDJSON, without approval」）。因此 T19 的「抽成独立 API 面」不是「开新面」，而是**统一两条已有面（面板桥 + program 桥）并补授权分层**。更关键：T19 验收第 3 条「danger 档直接被拒」与现状（91 条 danger 可委托）冲突——这条若成立，改动会**收紧**现有扩展能力，必须在卡面写明「这是行为变更，需要迁移已安装扩展的授权表」。另外 `workflowEngine.load` 是唯一不可委托项（`gen-module-permission-map.mjs:45-50`），可作为收敛的起点。
- **T20**：闭环中「静态校验」「沙箱冒烟」「安装与回滚」三块**已有半成品可复用**：`extension_validate` 已对 Agent 暴露（`tools.ts:1081`，`extensionValidate.ts`，用与安装同一个受控核验器）；安装前程序核验（`verifyProgram` → `verifyPermissionedProgram`）、失败不落盘、权限/授权回滚（`ModuleHost.install:443-528`）、运行中任务取消（`:528-546`）均已实现并有 E1。T20 真正缺的是**工坊 UI + 生成流程 + 「沙箱内先调一个 read 方法」的预装冒烟**（现有核验只求值工厂，不跑调用）。卡面无需改依赖，但应把「复用清单」写死，避免重造。

---

## 6. 下一批实现卡建议（≤5，按依赖与杠杆排序；与 T16–T20 不重复）

> 原则：按独占文件切；每条只写「为什么现在、独占路径、验收判据」。编号仅建议，由总控登记。

**N1｜扩展委托危险档收敛（T19 的前置，不替代 T19）**
- 为什么：B2 是当前唯一「已存在的越权面」，T19 一旦开放更多面会把它合法化。台账原则「不让 Agent 自授权」在同机第三方代码上应同向收紧。
- 独占路径：`apps/desktop/scripts/gen-module-permission-map.mjs`（判据源）、`packages/contracts/src/appPermission.ts`（生成物）、`apps/desktop/src/main/modules/ModuleHost.ts`（`authorizeAppMethod` 邻域）、`apps/desktop/src/main/appControl/tools.ts`（`invokeExtensionAppCall`/`trustedExtension` 邻域）、新建 `apps/desktop/scripts/extension-danger-delegation-smoke/**`。
- 判据：danger 档或经逐次审批、或钉 null 不可委托（二选一由卡面定，推荐「按资源作用域逐次审批」）；迁移已装扩展授权表（版本/指纹变化触发重同意）；91 条逐一有断言；变异验证（把一条 danger 改回可委托必须变红）；`module-permissions`/`module-app-call`/`app-control` 不回归。
- 与 T19 的边界：T19 开 API 面与能力发现；N1 只收紧**已经存在**的委托判据。两者共享 `tools.ts`，必须串行。

**N2｜`app_api` 目录再生成与漂移门禁**
- 为什么：B1，E1 红；Agent 自发现通道是产品最高原则 3 的核心，目录缺一条就是「以为没有这个功能」。
- 独占路径：`apps/desktop/src/main/appControl/apiCatalog.generated.ts`（**当前 dirty，须等其 owner 提交后以新 HEAD 为基线**）、`apps/desktop/scripts/gen-app-api-catalog.mjs`（若需补 `framework` 支持）、新建生成器同步断言（可并入 `app-control-smoke` 或新套件）；`policy.ts` 的 `DOMAIN_LABELS`/`DOMAIN_TASK_ALIASES` 补 `framework`。
- 判据：生成器输出 446/446；`app-control-smoke` 572/572；`appPermission.ts` 重生成后 446/446；「生成物 = 现源码重生成结果」成为一条可执行断言（不是只比对条数）。

**N3｜一级任务对象持久化（Task identity）**
- 为什么：B3，路线图 §3 的结构性缺口；也是多 Agent/DAG 编排、验收证据的承载物。
- 独占路径：`packages/contracts/src/task.ts`（新）、`apps/desktop/src/main/store/db.ts`（新表；注意与 N2 不共享文件）、`apps/desktop/src/main/store/repositories/task.ts`（新）、`apps/desktop/src/main/orchestration/sceneTaskRuntime.ts` + `sceneTaskRegistry.ts`（落盘/恢复邻域）、`packages/contracts/src/ipc/rpcMap.ts`（新增 `task.*`，与 N2 串行）、新建 `apps/desktop/scripts/task-identity-smoke/**`。
- 判据：chat/workflow 节点/自动化三条入口写同一任务行（宿主铸造 origin，不采信模型参数）；重启后父子链与预算归属仍在；坏档 fail-closed；`session-fork`/`scene-task`/`runtime-state` 不回归；变异验证（把 origin 改成来自模型参数必须变红）。

**N4｜治理视图：计划授权 / 分叉孤儿 / 无人值守存档健康**
- 为什么：B4，「坏东西显式报出来」的结构原则；T12 也点名后台审批不可见，但那是 UI 层，这里是**宿主事实没有读口**。
- 独占路径：`apps/desktop/src/main/appControl/grantStore.ts`（只读枚举/撤销邻域）、`apps/desktop/src/main/store/forkOrphans.ts`（只读邻域）、新建 `apps/desktop/src/main/ipc/governance.ts` + `packages/contracts/src/ipc/governance.ts`、`preload/index.ts`（新增命名空间）、渲染端新面板（设置页新文件），新建 `apps/desktop/scripts/governance-view-smoke/**`。
- 判据：grant 列表/撤销走真人 IPC（Agent 侧 blocked）；孤儿列表可读、`resolve` 需用户确认；损坏存档在视图里如实显示（不显示空表）；撤销在途授权后下一次预判立即可见；与 T18 的「扩展权限」不重叠（那是安装决策，这是宿主授权/孤儿）。

**N5｜执行环境抽象与用户选择面（本地/worktree 先行，AI 不调度）**
- 为什么：B5，路线图 §3；当前 `envMode` 二值撑不起「项目默认环境 + 单任务覆盖」。
- 独占路径：`packages/contracts/src/executionEnvironment.ts`（新）、`packages/contracts/src/ipc/session.ts`（`StartSessionSchema` 邻域）、`apps/desktop/src/main/env/`（新 `environments.ts`，**不碰** `agentEnv.ts`）、`apps/desktop/src/main/ipc/claude.ts`（`resolveSessionCwd` 邻域）、渲染端 `components/chat/WorktreeModeChip.tsx`（邻域）、新建 `apps/desktop/scripts/execution-environment-smoke/**`。
- 判据：环境对象含 id/kind/local|worktree|unavailable/健康检查；不可用环境**明确报错且不自动切换**；`app_session_new` 仍不暴露环境参数，`claude.startSession` 的环境字段仅接受用户显式选择（Agent 侧按 blocked 或 danger 钉死，卡面裁决）；worktree 现有行为逐字节不回归（`worktree-path-guard`/`terminal-panel-worktree` 绿）；变异验证（把「不可用→回退本地」写进去必须变红）。
- 明确禁止：AI 自主调度/切换执行环境；本卡只交付「用户选 + 显式失败」。

---

## 7. 已知限制

- 本轮**无 U1**：未起真 Electron、未跑真三引擎在线回合、未连真公网/sshd；所有链路结论最高 E2（多套 E1 只证明隔离行为）。
- `app-control-smoke` 的 1 条红与工作树既有 dirty（`apiCatalog.generated.ts`）相关，**不是本任务修改造成**；本任务未触碰该文件。
- 未运行 `pnpm typecheck`/`pnpm test:all` 全量；本轮按域挑选 27 套（见 §0）。
- `terminal-smoke` 与 `git-discard-smoke` 会真起子进程/临时 git 仓库，均在 `mktemp` 隔离目录；未触用户仓库。
- `module-permissions-smoke` 输出以套件自报的 3 组变异红→绿为准（未逐条重放其内部断言）。
- Provider 能力矩阵、扩展委托面、执行环境三处的「未来架构」判断属于本报告的建议（D），不是验收结论。
- 工作树 dirty 与并行对话状态：`apiCatalog.generated.ts` 的改动者未知；N2 开工前必须先确认该文件已提交或放弃改动。
- **调查期间并行推进**：提交时 master 已前进到 `19e95021`（T23 开卡），且 `apps/desktop/scripts/electron-u1/` 已由并行 T16 执行出现。本报告 §5 对 T16 的判断（缺可复用骨架、15 份手抄 `electron-host.cjs`）描述的是**开工时**的基线；T16 的进展以其卡回写为准，本报告不评价其质量。
- 同理，`scripts/t0-…-smoke/`、`scripts/tsx-coverage-smoke/`、`smokes-for.py` 等并行改动出现在提交时的工作树里，均**未被本任务暂存或修改**。
