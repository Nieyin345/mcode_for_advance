# T100｜Orca↔Mcode 多 Agent/PTY/会话生命周期与恢复源码对照

## 0. 范围、基线与证据规则

本报告只做源码静态研究，不修改产品实现，不启动 Electron、PTY、服务或远端环境，也不运行测试。没有 E1 真实产品端到端证据或 U1 真实用户旅程证据；下文不会把源码存在、无头测试或设计推断写成运行成功。

- Orca 固定参考：版本 1.4.214，Git HEAD = ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560；调查时 git status --short 为空。未 fetch、checkout、build、安装依赖或写入 Orca。
- Mcode 源码快照：调查时 HEAD = 9100e65678c9c0b73dde5c98f3f007f4660dea09，分支 master。
- 调查开始时已存在的 Mcode dirty 状态，全部保留：修改的 .aoci/baseline.json、.gitignore、apps/desktop/scripts/maint-m35-smoke/pickers-prelude.ts、apps/desktop/scripts/orchestration-ipc-smoke/run.sh、apps/desktop/scripts/release-readiness-smoke/check-reviewed.cjs、apps/desktop/src/main/appControl/apiCatalog.generated.ts、apps/desktop/src/main/ipc/settingsTransfer.ts、tasks/T102-remote-cli.md；未跟踪项包括 Git 显示为 ?? ['dev 的路径，以及 docs/research/orca-mcode/T101-diff-review.md。调查时没有暂存文件。上述内容不属于 T100。
- 线索目录已核实：orca/src/main/agent-launch、provider-process、pty、providers、daemon 均存在；PTY 逻辑不只在 pty/，也经过 daemon/、ipc/pty/runtime/ 与 runtime/terminal/launch/。
- E2 = 可在固定源码快照复核的静态事实；E3 = 未运行或未覆盖范围的风险推断。分类只使用“等价已有 / 部分已有 / 真缺失 / 证据不足 / 与定位冲突”。

## 1. 核心结论

两边不是“同一套 AgentProvider 的不同实现”。Orca 的 structured agent session 可以持有一个跨多轮的 provider child/连接，并通过 session record、journal、runtime fence、acquisition generation 与退出证明协调恢复；Orca 的 CLI agent 又可能走独立 PTY/terminal 路径。Mcode 则用统一的 AgentProvider / ProviderContext / TurnHandle / RuntimeEvent 承接三家 SDK 的原生语义：每轮由 provider 创建、停止和清理对应的 SDK handle/client/session，逻辑会话 ID 与 transcript 落库，但不等于保存一个可跨应用重启重新 attach 的活进程。

Mcode 已有 per-session 并发保护、turn token、审批桥、provider session ID 持久化、工作流隐藏 node session、集成终端的缓冲和清理；不能把这些说成“没有生命周期管理”。明确差异是：Mcode 的集成终端进程和 scrollback 由主进程内存持有，应用退出时清理；在本次审查的 TerminalManager 路径里没有 Orca 那种 daemon attach / PTY 冷恢复 / 持久 checkpoint / producer backpressure 组合。

## 2. 三条以上真实调用链

### 链 A：Agent launch → structured session → lease/recovery

**Orca：**

1. agent-launch/agent-launch-executor.ts 的 executeAgentLaunch 先决定 structured 或 terminal surface；createSurface 在 structured 模式调用 surfaces.createStructuredSession。结构化创建若被明确拒绝，可以降级到 createTerminalSurface，但这不表示两种 surface 的执行模型相同。
2. runtime/rpc/methods/agent-launch-surfaces.ts 的 agentLaunchSurfaceFactory.createStructuredSession 生成/接收 sessionId，调用 runtime/rpc/methods/structured-agent-session-create.ts 的 createStructuredAgentSessionForWorktree。无 prompt 且客户端声明相应能力时可以 at-rest 创建，避免“创建会话”本身就启动 provider。
3. native-chat/agent-session-wire/structured-agent-session-host.ts 安装 createRestartReconciler，并把 claimStructuredAgentSessionAgent 接入 host。structured-agent-session-agent-start.ts 的 claimStructuredAgentSessionAgent / runStart 串行处理同一 session 的启动、已有 child 的关闭、lease reconcile、recovery resolution 与 attach。
4. structured-agent-session-restart-reconcile.ts 明确规定：从磁盘加载的 lease 初始为 unreconciled，不能直接授权新 writer；只有 probe/adjudication 结束后才能写。无法证明 owner 状态时保留拒绝/待重试状态，不把“探测失败”当成“owner 已不存在”。

**Mcode 对照：**

1. apps/desktop/src/main/orchestration/runner.ts 的 createNodeSession 为工作流节点创建持久 SessionRepo 行，字段包括 kind=node、parentSessionId、nodeId；执行节点时调用 RuntimeManager.sendTurn(nodeSession, ...)，不是启动一个与 AgentProvider 平行的第二套 loop。
2. apps/desktop/src/main/claude/RuntimeManager.ts 的 bindSession 从 SessionRepo 恢复 providerSessionId（持久字段仍通过 updateClaudeSessionId 命名）；onProviderSessionId 将 SDK 的逻辑 session/thread ID 写回数据库。sendTurn 在 startingSessions / handle 状态上阻止同一 session 的重入，再调用 provider.startTurn。
3. 这能恢复逻辑对话与 provider session/thread，不等于恢复此前的 OS child、PTY master FD 或 SDK client。该区别在三个 provider 的实际生命周期中可见，见链 B、C。

**判断：** Mcode 已有逻辑会话恢复与工作流隐藏子会话；Orca 的 durable process ownership / lease fencing 是额外的宿主能力，不应直接推断成 Mcode 的 Provider 缺陷。E2。

### 链 B：SDK 原生事件、审批、取消与 provider child 退出

**Orca：**

- Claude structured 路径：claude/claude-structured-session-adapter.ts 按 sessionId 持有 session；claude-structured-session-acquisition.ts 通过 buildClaudePermissionCallbacks 连接 canUseTool / onUserDialog，并打开 stream-json connection。claude-agent-sdk-process-spawn.ts 进入 managed-provider-process；provider-process-supervisor.ts、provider-process-teardown.ts 与 claude-child-exit-proof-ladder.ts 分别负责受控 spawn、关闭/树终止和退出证明。该链保留可核验的 child identity/exit 证据，不只靠一个通用 done 事件猜测。
- Codex structured 路径：codex/codex-structured-session-adapter.ts 以 sessionId 持有 CodexSession 和 acquisition registry；codex-structured-session-acquire.ts 调用 spawnCodexAppServerConnection、生成 process identity / acquisition generation，并在 onExit 里记录 exitProven、结束原因和 observedAt，再通过 journal translator 送事件。它与 Mcode 的 per-turn Codex client 不是同一生命周期。
- ACP 路径：acp/acp-structured-session-adapter.ts 的 acquire 会先要求旧 child 被证明停止；cancelTurn 发出 ACP turn interrupt，closeAll 在 child 无法被证明停止时失败关闭。acp-incoming-requests.ts 为入站请求保留 AbortController / capacity，并区分 request cancelled 与 handler error；acp-permission-requests.ts 的 answerAcpPermission 对无 handler、abort、无效回复、未提供的 option 或 handler 异常一律回 cancelled。ACP 权限不是 PTY 输出事件。

**Mcode 对照：**

- packages/contracts/src/provider.ts 的 ProviderContext / TurnHandle / AgentProvider 是现有统一 seam；packages/contracts/src/runtime.ts 定义 turn.done、subagent.transcript 等 RuntimeEvent。
- Claude：providers/claude-sdk/ClaudeAgentSdkProvider.ts 使用 SDK 的 canUseTool 和 onUserDialog，把原生回调映射到 ctx.requestApproval / requestUserInput 等；每次 startTurn 构造 query/AbortController，TurnHandle.interrupt 通过 abort 取消这一轮。此路径没有在 provider 源码里注入 Orca 那种 spawnManagedProviderProcess / PID identity hook。
- Pi：providers/pi-sdk/PiAgentSdkProvider.ts 使用 SessionManager.open / createAgentSession，并以 SDK 的 tool_call 扩展守卫实现工具审批；每轮完成/失败后 dispose session，不能据此说 Pi 的会话文件不持久化，但活 AgentSession 并非跨轮常驻。
- Codex：providers/codex-sdk/CodexAgentSdkProvider.ts 把 app-server 的 commandExecution/fileChange approval 与 tool/requestUserInput 映射到同一 host approval API；CodexAppServerClient 提供进程 exit 通知与 dispose。注意一个源码注释不一致：CodexAppServerClient.ts 顶部注释称“每个 GUI session 一个 app-server”，但当前 CodexAgentSdkProvider.startTurn 在每次调用内 new CodexAppServerClient，并在该轮 done 的 finally 中 dispose；按 RuntimeManager 的每轮调用链，实际观察到的是 per-turn client，不应按注释假定为跨轮常驻。
- RuntimeManager.interrupt 会先处理 ApprovalBridge 的 pending 请求，再对正在启动或已经返回的 TurnHandle 取消；turn token 用于避免旧轮的完成事件覆盖新轮状态。它提供的是逻辑 turn 生命周期，不是统一的跨重启进程 lease。

**判断：** 高层审批/事件入口已有统一抽象，但 Claude、Pi、Codex 的原生请求与生命周期不同；Orca 的 CLI/ACP/PTY 更不能压成一种通用 SDK provider。E2。

### 链 C：terminal agent → pane admission → PTY spawn / attach / checkpoint / teardown

**Orca：**

1. agent-launch-executor.ts 的 createTerminalSurface 走 terminal surface；runtime/terminal/launch/terminal-create.ts 调用 spawnInAdmittedPane。runtime/runtime-pane-admission.ts 先写 pane/layout admission，再调用 controller.spawn；失败时按 owner/keepOnFailure 规则撤回或保留错误 pane。
2. ipc/pty/runtime/controller.ts 的 installPtyRuntimeController 安装 spawn/kill/attach/stopAndWait 等能力；ipc/pty/runtime/spawn.ts 的 spawnPtyFromRuntimeController 进入 prepare → execute → commit。ipc/pty/runtime/spawn-execute.ts 在实际 spawn 前校验 pane/owner，必要时 reconcile agentSessionOwners，然后调用当前 PTY provider 的 spawn，并校验 spawn reply 是否仍然 live、登记 incarnation/输出序列后才继续提交。
3. daemon/daemon-pty-session-spawn.ts 先 ensureConnected，再尝试 create-or-attach；对于不能 attach 的旧 session，会根据 historyReader / detectColdRestoreState 构建恢复 seed。spawn reply 前已到达的 exit 会按 sessionId + incarnationId 匹配，避免旧 incarnation 的迟到 exit 把新进程判死。
4. daemon/terminal-host.ts 的 handleSessionExit 写入 retired-incarnation tombstone、释放 agent-session owner 并 reap dead session；pauseProducer/resumeProducer 与 kill 经 host 转发到 live session / session teardown。
5. daemon/daemon-pty-session-control.ts 的 shutdown({keepHistory:true}) 在 kill 前等待 final checkpoint，并检测 cold-restore state；sleep 路径保留历史且不写“用户显式关闭”的 tombstone，显式 close 才移除历史并拒绝误 attach。daemon-pty-checkpoint-persistence.ts 保存增量输出/快照。
6. daemon/daemon-stream-backpressure.ts 对 socket/client queue 做总量和 per-session 字节计数，触及 high-water 时 pause producer、回落后 resume；stall 路径有受控释放，避免慢消费者无限压住 PTY。这里是 queue/socket backpressure，不应误称为 renderer ACK 协议。
7. pty/posix-pty-process-groups.ts 通过进程表、TTY 与 Linux session identity 验证可发送信号的 process groups；不能证明归属时退回更窄的 root-pid 路径。Windows 另有 ConPTY/job ownership 与 node-pty patch 的处理；node-pty-self-exit-pseudoconsole-close.test.ts 是机制 pin，不是本次运行的测试结果。

**Mcode 对照：**

1. apps/desktop/src/main/ipc/terminal.ts 的 IPC.TERMINAL_CREATE 进入 apps/desktop/src/main/terminal/TerminalManager.ts 的 create；TerminalManager 持有主进程内 Map，生成随机 terminalId 并 node-pty.spawn。
2. onData 把数据追加到 pendingData，16ms 合并后推送 renderer，并把最近的输出尾巴保存在 TERMINAL_BUFFER_CHARS 限制的内存 buffer。注释明确说明 buffer 不落盘，退出/应用重启即丢。onExit 会 flush、删除 Map 项并发送 TERMINAL_EXIT；kill 则调用 pty.kill 并立即清理/通知。
3. main/index.ts 的 before-quit 路径调用 TerminalManager.disposeAll，终端 PTY 被清理。现有集成终端具备创建、输入、resize、kill、退出通知、按 session/project 清理和有界 scrollback tail；在这条路径中没有 daemon attach/cold restore/checkpoint，也没有可见的 producer pause/resume 或按 socket queue bytes 限流机制。
4. Mcode 的 node-pty kill 行为是否覆盖所有后代进程，不能仅凭 TerminalManager 这几行判定；本次只确认 host 没有显式调用 Orca 的 process-group identity / descendant sweep。没有动态测试，故不把它写成已复现的 orphan process bug。

**判断：** Mcode 的集成终端生命周期并非空白，但“主进程内存持有”与 Orca 的 daemon/session-incarnation/checkpoint/reconnect 是明确不同的能力。E2；压力场景的实际丢帧/卡顿表现未测，属 E3。

## 3. 能力对照矩阵

| 能力 | Orca 源码证据 | Mcode 源码证据 | 分类与结论 |
|---|---|---|---|
| SDK 原生审批与统一事件 | claude-structured-session-acquisition.ts 的 buildClaudePermissionCallbacks；codex-structured-provider-events；acp-permission-requests.ts 的 answerAcpPermission | packages/contracts/src/provider.ts 的 ProviderContext / TurnHandle；RuntimeManager.ts 的 ApprovalBridge 接线；Claude canUseTool/onUserDialog、Pi tool_call、Codex server request handler | **部分已有 · E2**。Mcode 已统一 host API，但各 SDK 的原生权限/事件不能被 PTY/CLI 事件替代。 |
| 单 session 的 turn 并发、取消与旧事件 | structured-agent-session-agent-start.ts 的 start flight / lease reconciliation；ACP cancelTurn；Codex acquisition generation | RuntimeManager.ts 的 startingSessions、turn token、interrupt；ApprovalBridge.ts 的 rejectPending | **部分已有 · E2**。Mcode 防止同一 session 重入并清理审批；Orca 还在 provider child / lease / fence 层判定 owner。 |
| provider 子进程持有权、退出证明 | provider-process-supervisor.ts、provider-process-teardown.ts、claude-child-exit-proof-ladder.ts；Codex/ACP adapter 的 process identity 与 exitProven | Claude query AbortController；Pi session dispose；CodexAppServerClient onExit/dispose；没有统一的跨重启 provider-process lease | **部分已有 · E2**。per-turn cleanup 已有；统一、可跨宿主重启 adjudicate 的活进程所有权不是现有 Provider 契约。 |
| 工作流隐藏子会话 vs Orca structured agent | structured-agent-session-create.ts + host lease/journal；按 sessionId 持有 provider child | orchestration/runner.ts 的 createNodeSession（kind=node）与 RuntimeManager.sendTurn；SessionRepo 持久 node row 和 provider session ID | **部分已有 · E2**。Mcode 的 workflow node 是隐藏逻辑会话；不能等同于 Orca 的 session-scoped OS child、worktree pane 和 journal/fence。 |
| PTY 创建、退出、清理 | runtime-pane-admission.ts → ipc/pty/runtime/spawn-execute.ts → daemon-pty-session-spawn.ts；terminal-host.ts handleSessionExit | terminal.ts → TerminalManager.create/kill/onExit/disposeAll | **部分已有 · E2**。Mcode 能清理本进程中的 PTY，但没有在此路径中证明 descendant-tree ownership 或跨 host 的 incarnation fencing。 |
| 活 PTY attach 与冷恢复 | daemon-pty-session-spawn.ts 的 create-or-attach / detectColdRestore；daemon-pty-session-control.ts final checkpoint / keepHistory | TerminalManager.ts 的内存 Map、非持久 buffer；main/index.ts 应用退出清理 | **真缺失 · E2（限定于 Mcode 集成终端路径）**。若需求是应用重启后重新 attach 活 PTY 或从持久 checkpoint 冷恢复，需要另行设计；这不是说 Mcode 的 AgentProvider session/thread 无法恢复。 |
| PTY 输出背压 | daemon-stream-backpressure.ts 的总队列 / per-session 阈值、pause/resume 和 stall release | TerminalManager.ts 16ms batch + bounded tail buffer；pendingData 没有本类可见的硬上限或 producer pause | **部分已有 · E2**。批量推送与滚动尾部已有；端到端 producer backpressure 未见于该路径。事件循环阻塞时 pendingData 累积属于静态风险，实际影响 E3。 |
| 两个 session 抢同一 worktree 的写入互斥 | Orca 的 pane admission、agentSessionOwners 解决 pane/agent-session owner 冲突；不能据此推断它提供全 worktree 文件写锁 | RuntimeManager 的 guard 以 sessionId 为键；本任务范围未完整审计 Mcode 所有 worktree/file-write 锁 | **证据不足 · E3**。不能仅凭两条调用链宣称存在或不存在全局 worktree 互斥，需专门查锁所有权并做双 session 隔离测试。 |

**结论计数（8 行）：** 等价已有 0；部分已有 6；真缺失 1；证据不足 1；与定位冲突 0。计数只覆盖上表明确限定的能力，不代表产品总体成熟度。

## 4. 三个关键异常 / 权限 / 恢复边界（仅为测试设计，不是已复现缺陷）

1. **启动中的取消 + 延迟审批/旧 turn.done。** 让 provider.startTurn 暂停在未返回 handle 的窗口，此时用户 Stop；再让旧轮延迟返回 handle、审批回调或 turn.done。Mcode 应保持 startingSessions / interruptRequested / turn token 与 ApprovalBridge pending rejection 的一致性；Orca structured host 需遵守 start attempt signal、lease/fence 与 adapter cancel/close 语义。ACP 的取消权限请求应回 cancelled，而不是在 handler 超时/失败时默认批准。当前只做静态追踪，未运行这个时序测试（E3）。
2. **PTY 在 spawn reply 前退出，随后同 sessionId 重启新 incarnation。** 让旧 exit 在新 spawn 注册之后到达。Orca 有 resultForExitBeforeSpawnReply、incarnationId 与 retired tombstone；Mcode 的 terminalId 是每次创建的新 UUID，不支持同 ID reattach，但 kill() 先发 TERMINAL_EXIT，异步 onExit 仍会执行通知路径，renderer 是否完全幂等应由测试确认。后者是待验证边界，不直接判成 bug（E3）。
3. **同 worktree 两个 session 并发 + renderer 消费停滞。** 同时启动两个 workflow/agent session 指向同一 worktree，再制造大量 PTY 输出和 renderer/daemon 断连。检查 pane/agent-session owner 是否正确拒绝冲突、pending output 是否有界、恢复后输出顺序/缺口是否明确。Orca 有 pane admission 与 socket backpressure；Mcode 的 RuntimeManager 只证明 per-session guard，不能替代 worktree 锁审计。此场景尚未执行，是否存在跨 session 写入冲突为 E3。

## 5. Top 2 借鉴点 + 1 条不应照搬的设计

### 借鉴点 1：窄范围的 incarnation / exit-evidence 语义

- **选择：小模块适配，不复制 Orca 代码。复杂度：M；若升级为跨应用重启的持久 process lease，则是 L。**
- 可先给 Mcode 现有 TerminalManager 的 exit/kill 事件建立显式生命周期状态与幂等规则；只有底层能提供可靠身份时才增加 incarnation/process identity。把“连接不可用”“退出已证明”“用户请求关闭”“provider 异常退出”分开，不把 probe error 直接当作 process absent。
- 不要求所有 SDK 都暴露 PID，不改成第二套 agent loop；ProviderContext 的审批回调和 RuntimeEvent 保持原样。不要新增 app_api_* 权限或工作流特例。工作流 node 继续通过 RuntimeManager / SessionRepo。
- 后续回归门：先用 bash apps/desktop/scripts/smokes-for.sh src/main/terminal/TerminalManager.ts 找覆盖该文件的真实套件，再跑命中的 pnpm test:smoke SUITE_NAME、相关 IPC/preload 测试和 pnpm typecheck；对 kill 后迟到 onExit、重复 exit、旧 turn event 进行隔离测试。若涉及真实 PTY/进程树，还需要 Windows ConPTY 与 POSIX 集成测试；无头测试不能替代端到端退出证明。

### 借鉴点 2：对现有 terminal output 增加明确的有界队列/背压边界

- **选择：借鉴设计，复用现有 TerminalManager / IPC；复杂度：M。** 先度量输出压力，再为 pendingData/IPC 待发队列建立字节上限、高低水位、消费者恢复和显式 gap/overflow 语义。只有当 node-pty/IPC 真实提供可用的暂停能力时才做 producer pause/resume；不要假定不存在的 API。保留当前尾部 buffer 用于重新打开终端时展示最近输出。
- 不修改 AgentProvider 或审批路径；不新建平行 terminal manager，不为 app_api_* 另开通道。工作流或 agent 打开的终端仍沿用同一 TerminalManager，并保留 origin/sessionId 清理语义。
- 后续回归门：输出 flood、慢消费者、event loop stall、断连后重连、最后一段输出 flush、顺序/缺口提示的隔离测试；按 smokes-for.sh 找到的真实套件运行，再跑 pnpm test:all 与 pnpm typecheck。T100 未运行这些测试。

### 不应照搬：把 Orca 的持久 child/session 模型强塞给三家 Mcode SDK

- **选择：暂不引入；若做成所有 provider 的统一常驻进程模型，复杂度 L，风险高。** Orca 的 Claude/Codex structured adapter 与 ACP/PTY 各有 process/connection 生命周期；Mcode 的 Claude query、Pi AgentSession、Codex app-server client 在当前代码里都按 turn 创建/释放 handle 或 client，session/thread ID 只负责逻辑恢复。强行统一会混淆 SDK 原生审批、取消、事件结束和恢复语义，并把 PTY shell 误当成 SDK AgentProvider。
- 保留 Provider / ProviderContext / TurnHandle / RuntimeEvent 的现有边界；若未来需要某个 provider 的 process identity，只增加可选的生命周期能力，不把 engine-specific callback 搬到第二个 agent loop。对 CodexAppServerClient 的“每 GUI session 一个 app-server”注释与实际 per-turn 创建/释放不一致，可单独开文档校正任务；T100 不修改源码。
- 未来验证门：Claude / Pi / Codex 各自审批与取消的 targeted smoke、pnpm test:all、pnpm typecheck；如果改动 PTY，则另加真实跨平台 PTY/退出/背压测试。当前没有运行任何这些门禁。

## 6. 许可证、限制与未证风险

- Orca/LICENSE 声明 MIT，但这不自动覆盖全部内嵌资源、第三方依赖或其他资产。T100 没有复制 Orca 代码或资产；以上均为源码路径、符号与设计层面的观察。
- 未运行测试、build、typecheck、服务或真实产品流程；没有 E1 / U1 证据。所有“压力后果”“并发写冲突”均明确标为 E3，不能写成复现缺陷。
- 未审计 Mcode 所有 worktree/file-write 锁，也未逐一证明 node-pty 的平台级 descendant termination 语义；不从本次有限源码范围外推结论。
- 未修改 Orca、Mcode 产品代码、共享配置、许可证、用户数据、其他任务卡或其他报告。写入范围仅为本报告与 T100 的结果回写。
