# T104｜Orca↔Mcode 安全授权 / IPC / Agent 自控与插件扩展源码对照

> **结论类型：只读设计取证（E2 静态源码）**。本报告不代表动态安全验证或产品端到端验收；没有运行测试、Electron、Agent 回合、远程主机或真实用户数据。

## 0. 基线、范围与结论摘要

| 项目 | 本轮记录 |
|---|---|
| Orca 固定基线 | `ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560`，`orca/.git/HEAD` 指向 `refs/heads/mcode/integration`，该 ref 内容与固定 SHA 相同；版本字符串 1.4.214 |
| Orca 工作区 | 基线检查时 `git --git-dir=orca/.git --work-tree=orca status --short` 为空；全程未写 `orca/**`，未 fetch、安装、构建或启动 |
| Mcode HEAD | 源码检查开始时为 `35904aa56d8190b4b3ee101c8e050156aab21e32`；调查过程中并行提交使 HEAD 前进。报告写入前复核为 `2bcad370da1867f6745aff49f66635a354c17910` |
| Mcode 工作区 dirty（最后一次观察） | `.aoci/baseline.json`、`.gitignore`、`apps/desktop/scripts/maint-m35-smoke/pickers-prelude.ts`、`apps/desktop/scripts/orchestration-ipc-smoke/run.sh`、`apps/desktop/scripts/release-readiness-smoke/check-reviewed.cjs`、`apps/desktop/src/main/appControl/apiCatalog.generated.ts`、`apps/desktop/src/main/ipc/settingsTransfer.ts`、`docs/research/orca-mcode/T101-diff-review.md`、`tasks/T102-remote-cli.md` 均在最后一次状态检查时显示为未提交修改（其中 T101/T102 可能是并行执行者的后续改动，本任务未修改）；另有状态行 `?? ['dev`。这些都不是本任务写入目标，必须保留原样 |
| 唯一写入范围 | 本报告 `docs/research/orca-mcode/T104-ipc-extensibility.md` 与本任务卡结果回写区 |

结论先行：

1. **Mcode 并不缺 Agent 自发现与调用通道。** `app_api_list → app_api_describe → app_api_call` 已通过 `invokeAppTool → callRpc → rpcHandlerFor` 复用与桌面 IPC 相同的主进程 handler；`dbGuardedIpc` 还把数据库就绪和副作用幂等包装放在共同入口。
2. **Orca 最值得借鉴的是插件 host call 的深模块接口，而不是照搬一套新 API。** worker 和 sandboxed panel 汇入同一个 host-call choke point，那里集中做 method/schema/capability/panel 限制/变更审计。Mcode 已有 `app_api_call`、`ModuleHost.authorizeAppMethod`、`APP_METHOD_PERMISSIONS` 与操作账本，但它们服务于不同调用者；不能把这些授权层混成一张表，也不应再造平行执行通道。
3. **身份必须由 host 绑定。** Orca panel owner 从 `event.sender.id` 派生，并用 owner + session token + manifest revision 绑定调用；Mcode 的 ModuleHost 也由 host 持有 module identity、按 manifest version/fingerprint 校验 grants。相反，Mcode 通用 `app_api_call`/panel `api.call` 调用 handler 时不提供 renderer sender 身份，依赖它的功能不应被放进可委托方法表。
4. **Orca 的 YOLO/full-access 默认值不能移植为 Mcode 默认值。** Orca 的 `DEFAULT_TUI_AGENT_ARGS` 指向 `YOLO_TUI_AGENT_ARGS`，默认设置同时包含 `nativeChatPermissionMode: 'full-access'`。Mcode 的通用 app-control 对 `danger` 方法要求每次用户本人批准，审批通道缺失时拒绝执行；这是不同的安全取舍。
5. Mcode 对 workflow/Node-RED 的执行归属、版本和 trust 已有强约束。尤其 `flowTrustGate.canExecuteFlow` 将 owner 与内容审批分开，审批记录缺失、损坏、revision 不匹配是不同拒绝状态；不可把普通本地工作流的 legacy 兼容规则套到 Node-RED 引擎侧。

本报告分类统计（按下方矩阵的 9 项计）：**等价已有 3、部分已有 5、与定位冲突 1、真缺失 0、证据不足 0**。这里的“等价已有”只针对矩阵所描述的能力/职责，不代表整个产品端到端等价。

## 1. 代表性调用链

### 1.1 Orca 插件 panel / worker → host API → 实际能力

**Panel 路径（E2）**

`orca/src/main/ipc/plugins.ts`：

- `plugins:readPanelEntry` 从 Electron `event.sender.id` 生成 `rendererPanelOwner(event.sender.id)`，再调用 `pluginService.panels.open(ownerKey, pluginKey, panelId)`；同时用 `bindPluginPanelOwnerLifecycle` 在 owner 生命周期结束时撤销 session。
- `plugins:panelAction` 再次从当前 `event.sender.id` 生成 owner，并调用 `pluginService.panels.execute(ownerKey, args)`，没有信任 renderer 自报的 owner。
- `orca/src/main/plugins/plugin-panel-controller.ts:open/execute` 通过 `PluginPanelSessions.issue/resolve(ownerKey, sessionToken)` 绑定调用者；执行前再次核对已批准插件、`rootDir`、manifest revision 与 panel 是否仍存在。缺 token、token 属于别的 owner、插件被替换或 panel 被删除时拒绝。
- `orca/src/main/plugins/plugin-service.ts:executeHostCall` 将 panel 与 worker 请求汇入 `executePluginHostCallRequest`。worker 侧的 `plugin-host-runtime.ts` 只发 `hostCall` 消息；`plugin-service.ts` 给 worker controller 注入的 `executeHostCall(pluginKey, ...)` 从 host 持有的 plugin key 进入同一个执行口。
- `orca/src/main/plugins/plugin-host-call-adapter.ts:executePluginHostCallRequest` 校验 qualified plugin key 和严格的请求 envelope，再由 host 解析 consent/capabilities、services、audit。
- `orca/src/main/plugins/plugin-host-methods.ts:executePluginHostCall` 先调用 `shared/plugins/plugin-capability-gate.ts:gatePluginHostCall`；panel 还受 `viaPanel` 的窄方法集约束。随后验证 params schema、mutation audit log 的 `attempt` 先于副作用写入、调用绑定 handler、验证 result schema。缺 audit log 的 mutation 不执行。

**实际副作用边界（E2）**：`plugin-host-method-bindings.ts` 将 API v0 方法绑定到 host 服务；例如 `terminal.sendText` 在发送前重新解析 active worktree 并重新列出终端，拒绝不属于当前 worktree 的 terminal id。插件不是拿到任意 IPC/Electron 对象，而是拿到经过 schema、capability 与作用域检查的窄 host API。

**Mcode 对应路径（E2）**

- Agent 的 `app_api_list / app_api_describe / app_api_call` 在 `apps/desktop/src/main/appControl/tools.ts` 暴露；`invokeAppTool` 校验工具和入参、查 `findEntry(method)`、检查注册状态、权限策略、授权与副作用幂等账本，再进入 `callRpc`。
- `apps/desktop/src/main/appControl/registry.ts:rpcHandlerFor` 返回 handler 注册表中的同一函数。`apps/desktop/src/main/ipc/dbGuardedIpc.ts:createDbGuardedIpc` 在注册 IPC 时先包 `awaitDb()`、需要时包共享操作账本，然后把同一份 guarded handler 交给 `recordRpcHandler`。所以 Agent 调用和 UI 点击并不是两份业务实现。
- `apps/desktop/src/main/modules/ModuleHost.ts:authorizeAppMethod/callAppFromExtension` 是更接近“可执行扩展”的 host-side seam：module id 由 host 的已安装 manifest 绑定；授权记录必须匹配 manifest version 和 fingerprint；每次 RPC 前后都重新核对 grant 与模块是否被替换/撤销。损坏的权限 archive 直接拒绝。
- `packages/contracts/src/appPermission.ts:APP_METHOD_PERMISSIONS/assertAppMethodPermission` 是 ModuleHost 的方法委托表；例如 `workflowEngine.load: null` 明确不可委托。此表是**扩展授权**，不是 `appControl/policy.ts:policyFor` 的 Agent 审批档位表，二者不能互相替代。

**判定**：Mcode 已有统一 Agent 自发现/调用接口和 host-side 扩展授权，不应宣称“缺少插件 API”后另造并行 registry。Orca 的可借鉴处是把 panel 与 worker 的插件调用汇入一个小而深的执行口；未来若要增强 Mcode 扩展 host API，应复用现有 `app_api_call` / ModuleHost seam 与生成器，而非再维护一套 method-to-handler 映射。

### 1.2 Orca CLI destructive action → runtime RPC → 主进程 decommission

**CLI / RPC 路径（E2）**

1. `orca/src/cli/index.ts` 在分派前调用 `refuseConflictingSessionCallerFlags(commandSpec, parsed.flags)`；`session-caller-flags.ts:refuseConflictingSessionCallerFlags` 会拒绝 Agent session 用 `--from/--terminal` 冒充其他 caller。
2. `orca/src/cli/command-spec.ts:CommandSpec.destructive` 的实际用途是 `command-suggestion.ts:suggestCommands` 的 typo recovery：不让一个普通拼写错误被建议成无关 destructive verb。它本身不是执行授权。
3. 真正的 `environment stop` CLI handler 在 `orca/src/cli/handlers/managed-server.ts` 中先要求 `--yes`，否则返回 `confirmation_required`，不会发 RPC；`environment forget` 也要求 `--yes`，并明确表示不会停止远端进程。
4. `orca/src/main/runtime/rpc/methods/managed-server.ts` 的 `managedServer.stop` 要求 `host-admin`，并验证 `ManagedServerSelector`；它没有 `confirmed` 参数，因此 CLI 的 `--yes` 是 CLI caller 的确认，不是所有 RPC caller 都必须提供的主进程确认令牌。
5. `orca/src/main/managed-server/lifecycle/orcad-runtime-decommission.ts:stopManagedOrcadEnvironment` 仍会拒绝正在作为新项目默认 host 的环境；`stopRemote` 处理/恢复 decommission journal，并只有在 host 证明 orcad 已退出后才 `unlinkEnvironmentLocally`。因此“确认”与“状态/恢复安全”是两层不同的判据。

**Mcode 对应路径（E2）**

- `apps/desktop/src/main/appControl/policy.ts:policyFor` 将动作分为 `read/ui/write/danger/blocked`；`tools.ts:gateAppAction` 对 `danger` 使用单独的审批前缀，每次都请求用户批准，`requestApproval` 缺失时拒绝。只有 `write` 可以受显式 permission mode / 已记住的同方法许可影响；`danger` 不走这两条捷径。
- `apps/desktop/src/main/claude/ApprovalBridge.ts` 对 `APP_DANGER_APPROVAL_PREFIX` 请求不保存“始终允许”（`remember = always && !dangerPrefix`）。
- `apps/desktop/src/main/appControl/tools.ts:invokeAppTool` 中的 `app_api_call` 还把 `sessionId`、method 和参数摘要写进操作意图；同 id 换 session/method/params 会冲突，已在途/状态不确定不会重复派发。

**判定**：Orca 的 `--yes` 对 CLI UX 有价值，但不能替代 Mcode 的 host-side `danger` 审批。若一个动作的安全要求是“任何 Agent/插件调用都必须由用户当次确认”，仅在 renderer 或 CLI 入口放确认弹窗/flag 不够。

### 1.3 Orca 自动化 dispatch → 目标复核 → durable run state

**Orca 路径（E2）**

- `orca/src/main/runtime/rpc/methods/automations.ts` 为 `automation.runNow` 定义 `workspace` permission 与 `AutomationId` schema；mutation 会通过 `mutationOwner` 取得/回传 `AutomationOwnerPrecondition`。支持 owner-fencing 的客户端必须回传 expected owner；对已声明 capabilities、但不支持 owner-fencing 的客户端会在 RPC 边界捕获 owner；未声明 capabilities 的兼容路径仍按原有规则处理。
- `orca/src/main/runtime/workspaces/persisted-surfaces/automation-operations.ts:runAutomationNow` 调用 automation service。`orca/src/main/automations/automation-dispatch-request.ts:requestAutomationDispatch` 在异步 dispatch 前保存 automation definition 与 destination 快照；run 状态从 pending 进入 dispatching 后再次读取 run、definition、目标 host/repo/path，并在 renderer ACK 等等待之后仍做复核。目标变了就拒绝/标记 skipped，不在新目标上“继续旧任务”。
- 若走 headless 路径，`headless-dispatch-runner.ts:runHeadlessAutomationDispatch` 先跑 scheduled precheck；拒绝和执行失败落成不同 run status；启动后把 workspace/terminal 归属写入 run 并挂 completion watcher。
- `orca/src/main/ipc/automations.ts:requireCapturedOwner` 对外部 automation manager 请求要求显式 owner 的 authority 与 selector；没有 captured owner 就拒绝，不能解析成“当前正在看的 host”。

**Mcode 对应路径（E2）**

- `apps/desktop/src/main/ipc/orchestration.ts:IPC.AUTOMATION_RUN` 校验 `AutomationRunSchema` 后调用 `automationRunner.runNow`；同一 handler 也被 Agent 的 `automation.run` 通过 `app_api_call` 调用。
- `apps/desktop/src/main/orchestration/automationRunner.ts:runNow/fire` 先检查 `workflowReviewError`；`fire` 再读当前工作流，比较 `workflowRevision` 与触发器快照、核对项目仍存在、检查全部关联自动化会话是否仍有 active run，并在启动前检查执行器归属，避免同一 flow 被 Mcode 与 Node-RED 双执行。
- `apps/desktop/src/main/orchestration/runner.ts:runWorkflow` 也有防绕过调用方预检的二次门：`assertWorkflowExecutor(doc, "mcode")`、`workflowReviewError`、resume revision / replay guard 与 `sharedExecutorOwnership.acquireExecution`。
- `apps/desktop/src/main/workflowEngines/flowTrustGate.ts:canExecuteFlow` 的 Node-RED 路径先检查 owner，再检查盘上 flow revision，最后检查 trust 记录。无记录/待审、损坏记录、旧 revision 分别拒绝。

**判定**：两边都不是“收到一次 run 请求就直接启动”。Orca 的 dispatch target snapshot / ACK 后复核值得借鉴为异步入口的设计模式；Mcode 已有工作流 revision、执行器 owner、review marker 和 Node-RED trust gate，不需要再加第二个 workflow runner。

### 1.4 权限模式默认值：与 Mcode 的 fail-closed 策略不兼容

**Orca 事实（E2）**

- `orca/src/shared/tui-agent-permissions.ts:YOLO_TUI_AGENT_ARGS` 为多种 TUI Agent 指定 skip/bypass 参数（例如 Claude 的 `--dangerously-skip-permissions`、Codex 的 `--dangerously-bypass-approvals-and-sandbox`）。
- `orca/src/shared/tui-agent-launch-defaults.ts:DEFAULT_TUI_AGENT_ARGS` 直接等于 `YOLO_TUI_AGENT_ARGS`；`orca/src/shared/default-global-settings.ts` 默认将其写入 `agentDefaultArgs`，并把 `nativeChatPermissionMode` 设为 `full-access`。这是当前固定源码的默认设置事实，不代表每一个 agent/每条运行路径最终都接受同一种 flag：`tui-agent-launch-defaults.ts` 对部分 agent 的不支持参数还会清理。
- `orca/src/shared/agent-chat-permission-mode.ts:savedChatPermissionMode/effectiveChatPermissionMode` 对 native chat 也显式提供 `full-access`；实际生效模式由 host 保存的会话/设置决定。

**Mcode 事实（E2）**

- `apps/desktop/src/main/appControl/policy.ts` 将高风险操作显式归为 `danger` 或 `blocked`，并说明 danger 即使在完全访问模式下也必须每次由用户批准。
- `apps/desktop/src/main/appControl/tools.ts:gateAppAction` 在没有 `requestApproval` 时 fail-closed；`dontAsk` 模式若没有预先允许也拒绝；`blocked` 直接拒绝。这里的 write bypass 是一个显式 permission mode 的有限例外，不能解释成“所有危险操作都可自动放行”。
- `ApprovalBridge.ts` 不为 danger 记住“始终允许”；`workflowTrust.ts` 与 `flowTrustGate.ts` 也把 imported/AI revision 的用户审查作为执行前置条件。

**判定**：把 Orca 的默认 YOLO/full-access 值直接搬进 Mcode，属于**与定位冲突**，不是安全等价迁移。Mcode 可以保留用户主动选择的权限模式，但不能因此取消 host-side danger gate、用户审查或缺少审批通道时的拒绝。

## 2. 能力对照矩阵

| 能力 / seam | Orca：可复核证据 | Mcode：可复核证据 | 分类与证据 |
|---|---|---|---|
| 主进程 IPC schema / handler 复用 | `src/main/ipc/plugins.ts` 对 plugin IPC 输入做 Zod 校验；panel call 在 `PluginPanelController.execute` 二次解析 `panelActionCallSchema` | `packages/contracts/src/ipc/**` 定义 IPC 契约；`ipc/index.ts` 使用 `createDbGuardedIpc`；`dbGuardedIpc.ts` 将同一个 guarded handler 登记给 `app_api_call` | **等价已有 · E2**：两边都在主进程执行输入校验与副作用门；Mcode 额外明确 contract/preload/handler 三层 |
| Agent 自发现并调用宿主能力 | Orca 插件 worker/panel 有固定 `PLUGIN_HOST_API_V0`，不是直接暴露任意 Electron IPC | `app_api_list → app_api_describe → app_api_call`；`invokeAppTool → findEntry → policyFor/gateAppAction → callRpc` | **等价已有 · E2**：Mcode 已满足通用 Agent 自发现；无需再建“插件专用 Agent API” |
| 插件 host method 单一执行 choke point | `plugin-service.ts:executeHostCall` → `executePluginHostCallRequest` → `executePluginHostCall`，panel/worker 共用 capability/schema/audit 判据 | `ModuleHost.callAppFromExtension` 用安装授权表校验；通用 Agent/panel 使用 `invokeAppTool/panelApiCall`；方法授权与 Agent policy 分属 `appPermission.ts` 和 `policy.ts` | **部分已有 · E2**：行为职责存在，但不是同一张插件 host method spec；未来只能在既有 seam 上收敛，不能另造 handler 表 |
| sender/session/module identity | `plugins.ts` 从 `event.sender.id` 派生 panel owner；`plugin-panel-controller.ts` 将 owner + session token + plugin root/manifest revision 绑定 | `ModuleHost` host-side 绑定 module id、manifest version/fingerprint；`app_api_call` 的 operation identity 由 host 的 `sessionId` 生成。通用 `callRpc` 传入空 event，不提供 renderer sender | **部分已有 · E2**：扩展身份已有 host 绑定；但 generic app_api 不具备 sender 语义，依赖 sender 的 handler 必须不可委托 |
| 用户审批 / bypass defaults | `DEFAULT_TUI_AGENT_ARGS = YOLO_TUI_AGENT_ARGS`；默认 native chat permission 为 `full-access` | `gateAppAction` 的 danger 每次请求用户批准，缺审批通道拒绝；`ApprovalBridge` 不记住 danger 的 always-allow | **与定位冲突 · E2**：不能把 Orca 的默认 YOLO/full-access 设成 Mcode 默认或绕过 danger gate |
| destructive CLI | `CommandSpec.destructive` 只限制 typo suggestion；`environment stop/forget` handler 要求 `--yes`；runtime RPC 仍用 `host-admin` | Agent 的高风险 app method 由主进程 `policyFor/gateAppAction` 控制，danger 不能“始终允许” | **部分已有 · E2**：CLI 的 `--yes` 是调用端确认；不等同于 Mcode 的 host-side 每次审批 |
| 自动化并发、目标变更和恢复 | `requestAutomationDispatch` 复核 automation definition/destination，headless runner 区分 skipped 与 failed，并记录启动目标 | `automationRunner.fire` 检查 workflow revision、项目、active run 和 executor owner；run ledger 与 workflow trust 阻止盲目重放 | **等价已有 · E2**：相同的防旧目标/双执行原则已经存在；细节需保持各自状态机，不复制另一套调度器 |
| imported workflow / Node-RED trust | Orca automation 有 precheck、目标 owner 与 revision/dispatch snapshot；未见其与 Mcode flow trust 三态完全同构 | `workflowTrust.ts` 把 imported/AI review pin 到 workflow revision；`flowTrustGate.canExecuteFlow` 先 owner 后 trust，区分 untrusted/corrupt/revision mismatch | **部分已有 · E2**：Mcode 在 Node-RED 侧有明确三态 fail-closed；不可用普通本地 workflow 的“无 marker = legacy”语义替代它 |
| 插件安装、激活与运行时 | Orca `plugins:consent/setEnabled` 走 main-side enablement/consent；host call 有 capability + mutation audit；panel session 可撤销 | Mcode provider plugin 安装后 disabled，组件 review 目前由 UI 触发；`pluginManager.setPluginEnabled` 本身只验证安装/配置健康。真正可执行扩展另在 `ModuleHost`，其 grant 有 fingerprint 并在每次调用前后复核 | **部分已有 · E2**：两套 plugin 概念不同。Mcode 的 UI review 不应被当作 main-process 安全授权；如果 review 是安全不变量，后续应让 host 校验 reviewed fingerprint |

矩阵中没有“真缺失”结论：当前源码显示，相关能力大多已在 Mcode 以通用 API、模块权限、workflow trust 或执行器所有权等不同 seam 存在；差异主要在统一程度和授权入口，不应因 Orca 有专门目录就判断 Mcode 缺功能。

## 3. 最关键的三条权限 / 恢复边界

### B1. YOLO 是默认值事实，但不能成为 Mcode 的默认安全模型

- **源码事实 E2**：Orca 默认 TUI 参数表包含多种 bypass flags；默认全局设置也包含 `nativeChatPermissionMode: 'full-access'`。
- **Mcode 判据 E2**：`gateAppAction` 的 danger 分支不会被普通 write 的 bypass / always-allow 逻辑放行；审批通道缺失则拒绝。Workflow 与 Node-RED trust 还各有独立的 revision/owner 检查。
- **失败反例设计（未执行）**：将某个默认 provider 设置成“无审批自动允许”，再让 Agent 调用一个 `danger` 方法或运行未审查的 imported workflow。预期是 host-side 拒绝/要求用户当次确认，而不是因 Agent mode 或 UI 未弹窗就执行。此处仅为测试设计，不声称已动态复现。

### B2. CLI confirmation 与 UI review 都不能代替 host-side 授权

- **源码事实 E2**：Orca `environment stop` 的 `--yes` 检查发生在 CLI 发 RPC 之前；`managedServer.stop` 的 RPC schema 没有确认字段，权限是 `host-admin`。主进程另有活动 host 拒绝、远端退出证明与 journal recovery。
- **源码事实 E2**：Mcode `plugins.ts` 的注释明确写明组件 review gate 在 UI；`setPluginEnabled(name, enabled)` 的主进程实现没有接收 reviewed fingerprint，只检查插件安装与配置状态。因此 review 对话框本身不是主进程可验证的授权凭证。此项是静态架构风险，不等于已经动态利用或证明存在外部攻击面；是否要求恶意/失陷 renderer 也不能绕过，需产品安全模型明确。
- **失败反例设计（未执行）**：直接调用 `managedServer.stop` RPC（不经过 CLI）时，不能假定 CLI 的 `--yes` 已生效；Mcode 中若绕过插件 review UI 直接调用 `plugins:setEnabled`，主进程当前没有 reviewed fingerprint 可核验。若确认必须是安全不变量，未来实现应把“被审查的 manifest/component fingerprint”传入并由 main 比对，而不是只在 UI 层隐藏按钮/显示对话框。

### B3. 异步间隙必须复核 owner、revision 与 trust 的原始状态

- **源码事实 E2**：Orca 的 automation dispatch 在 claim/等待之后复核 automation definition 与 destination；Mcode `automationRunner.fire` 和 `runner.runWorkflow` 再核对 workflow revision、review marker 与 executor owner。Node-RED 的 `flowTrustGate` 将无记录、坏记录和 revision mismatch 分开。
- **失败/恢复反例设计（未执行）**：
  1. 一个 automation 已进入 `dispatching`，等待 renderer ACK 或长时间 precheck 时，用户把项目从 host A 改到 host B / 删除再重注册 host。预期：拒绝旧 dispatch、记录可见的 skipped/refused 状态，不在新 host 上沿用旧快照。
  2. Node-RED flow 的 trust JSON 损坏或 `approvedRevision` 指向旧版本。预期：分别返回 `trust-corrupt` / `revision-mismatch`；不得降级成“从未审查”后静默重置，也不得继续执行。
  3. Panel A 的 session token 被 renderer B 重用，或原插件在 panel 打开后被升级/替换。预期：owner/token 或 manifest revision 检查拒绝旧调用，不让旧 UI 操作新插件实例。

以上均为**反例设计**，不是本轮执行测试的结果。E1 / U1 未做。

## 4. Top 2 借鉴点与复杂度

### Top 1 — 借鉴设计：插件调用收敛到一个 host-side choke point（复杂度 M）

- **值得借鉴**：Orca 的 `executePluginHostCallRequest → executePluginHostCall` 把身份、方法 envelope、capability、panel 限制、params/result schema、mutation audit 集中到同一条窄接口；panel 和 worker 不各自实现权限。
- **Mcode 适配边界**：复用 `app_api_call → callRpc` 与 `ModuleHost.authorizeAppMethod`；保留 Agent 的 `policyFor/gateAppAction`、ModuleHost 的安装授权、`APP_METHOD_PERMISSIONS` 的不可委托项与操作账本。不要把“用户审批”“模块 grant”“IPC schema”合并成同一种权限，也不要再建第二份 handler registry。
- **预期影响**：改善扩展方法的 locality、可测性和审计一致性；不改变 Provider 接口，不新增 Agent loop，不放宽 `danger/blocked`。
- **未来完整回归门（本轮不运行）**：Orca 参考套件至少覆盖 `plugin-host-methods.test.ts`、`plugin-panel-controller.test.ts`、`plugin-panel-sessions.test.ts` 与 `plugin-host-process.test.ts`；Mcode 实施任务需用 `apps/desktop/scripts/smokes-for.sh` 为实际修改文件选定 smoke，再通过 `pnpm test:all` 和双包 typecheck。另需隔离验证无审批通道、错误 schema、panel-only 禁止方法、缺审计存储和结果 schema 不符均不产生副作用。

### Top 2 — 小模块适配：异步 dispatch 前后复核 owner / destination / revision（复杂度 S–M）

- **值得借鉴**：Orca `requestAutomationDispatch` 保存 definition/destination 快照，在状态 claim 与异步等待后重新解析；owner 缺失时不猜“当前 host”。这比在入口检查一次就永久相信参数更适合自动化/远程调度。
- **Mcode 适配边界**：Mcode 已有 `automationRunner.fire`、`sharedExecutorOwnership`、`workflowRevision`、`workflowTrustError` 与 Node-RED `canExecuteFlow`，优先补隔离回归测试证明所有入口共用这些判据；不要新增第二个调度器或复制 Orca 状态机。
- **预期影响**：保护通用 Agent、手动 UI、自动触发器与 Node-RED 之间的执行所有权；不改现有 trigger/Provider 语义。
- **未来完整回归门（本轮不运行）**：针对“等待期间目标变化”“同一 flow owner 冲突”“trust marker 缺失/损坏/旧 revision”“恢复时旧运行缺 revision 或有 in-flight 副作用节点”写隔离测试；再按 `smokes-for.sh` 选取涉及 `automationRunner.ts`、`runner.ts`、`flowTrustGate.ts`、`nodeRedStorage.ts` 的 smoke，最后跑 `pnpm test:all` 与双包 typecheck。任何静态或无头通过都不代替 U1 的真实桌面/真实远程旅程。

## 5. 不该照搬的设计

### 不把 YOLO / skip-permission / full-access 作为默认值

**结论：暂不引入（安全代价高，配置实现复杂度虽低，但回归风险高）。** Orca 当前源码的默认参数就是多种 Agent 的 YOLO flags，且 native chat 默认 full-access；这是 Orca 的产品选择，不是通用 Agent 的必备架构。Mcode 的定位要求 host 核实身份、需要审批的操作由用户本人批准、无审批通道时 fail-closed。可保留用户明确选择的受限 permission mode，但不得默认跳过 danger gate、workflow review、module grants 或 Node-RED trust。测试门必须覆盖“显式 write bypass 不会顺带放行 danger / blocked”“没有 approval provider 时拒绝”“旧/坏 trust record 不会被当作批准”。

## 6. 证据等级、许可与未覆盖项

- **E2**：以上调用链与判据由本地源码静态定位；核心符号/路径均可在固定 Orca SHA 与 Mcode 当前源码中复核。
- **E3**：B2 中“直接 IPC 调用是否属于实际可利用威胁”依赖 Electron renderer 信任模型；本轮只确认 handler 的授权参数/校验缺口，没有动态利用证明。失败反例均是建议测试设计，不是实测结果。
- **E1 / U1**：未执行任何单测、smoke、typecheck、Electron 交互、真实 Agent 回合、远程 host 或用户旅程；不声称运行通过或产品端到端安全已验。
- **并行开发影响**：Mcode HEAD 在调查期间从 `35904aa...` 前进到 `2bcad370...`；Mcode 工作区存在其他任务的 dirty 文件，均保留。本任务只允许写本报告与 T104 回写区，未读取/修改真实用户数据库、凭据或远程环境。
- **许可**：`orca/LICENSE` 声明 MIT（Copyright © 2026 Lovecast Inc.）。本报告只建议借鉴设计，不复制 Orca 源码。MIT 主许可证不自动覆盖仓库内所有依赖、字体、图像或其他嵌入资产；任何未来代码移植须另行核对对应依赖/资源许可。
