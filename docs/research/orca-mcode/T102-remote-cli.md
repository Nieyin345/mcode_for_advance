# T102｜Orca ↔ Mcode：远程 Host、CLI 与手机工作区路由源码对照

> **性质：只读源码研究（E2 静态证据为主；E3 为基于源码的风险推演）。**
> 没有运行产品、连接 SSH 远端、安装依赖、编译或执行测试；没有复制 Orca 源码。

## 0. 基线、范围与证据等级

- **Orca 固定基线：** `ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560`（1.4.214）。调查前后 `git -C orca rev-parse HEAD` 均匹配；`git -C orca status --short` 为空。
- **Mcode 写入前基线：** `35904aa56d8190b4b3ee101c8e050156aab21e32`。调查期间其他执行对话提交了 T99/T103 的报告与任务回写；本报告未改动或暂存它们。
- **调查时已有 Mcode dirty 文件（全部保留、未暂存）：** `.aoci/baseline.json`、`.gitignore`、`apps/desktop/scripts/maint-m35-smoke/pickers-prelude.ts`、`apps/desktop/scripts/orchestration-ipc-smoke/run.sh`、`apps/desktop/scripts/release-readiness-smoke/check-reviewed.cjs`、`apps/desktop/src/main/appControl/apiCatalog.generated.ts`、`apps/desktop/src/main/ipc/settingsTransfer.ts`，以及未跟踪文件 `['dev'`。
- **检索范围核实：** Orca 的 `src/main/ssh/**`、`src/main/daemon/**`、`src/cli/**`、`src/renderer/src/ssh/**`、`mobile/**` 均存在。注意 `src/main/host/**` 的实际文件主要是 Electron 主机适配、HTTP、secret store、keychain 等，不是 SSH 远程 Host 注册表；远程 SSH 目标与运行时路由主要在 `src/main/ssh/**`、`src/main/runtime/**`、`src/shared/execution-host.ts`。
- **等级：** E2 = 固定源码中可定位的事实；E3 = 未运行的故障推演/设计推断。没有 E1（实际运行端到端）或 U1（用户现场实测）证据。本文中的失败场景是静态推演，不声称已复现。

## 1. 核心结论

Orca 不是只有一个含义的“远程 Host”。至少要分开三层身份：

1. **执行主机：** `ExecutionHostId` 明确区分 `local`、`ssh:<targetId>`、`runtime:<environmentId>`。SSH target 与已配对的 Orca runtime 不是同一种对象。证据：`orca/src/shared/execution-host.ts` 的类型、解析与规范化函数；`orca/src/cli/execution-host-flag.ts:48-163`。
2. **工作区：** `Worktree.id` 是 `${repoId}::${path}`，另有 `hostId`、`projectId`、`runtimeOwnerEnvironmentId` 等字段。仅用 worktree ID 不足以唯一标识跨主机副本；`orca/src/shared/worktree/host-qualified-identity.ts` 提供 host-qualified identity/key，调用方可用 `hostId + worktreeId` 区分不同主机上同名/同路径的工作区。证据：`orca/src/shared/worktree/types.ts:100-115` 与上述 identity 模块。
3. **手机连接的桌面 vs. 工作区服务器：** 手机路由 `/h/[hostId]/session/[worktreeId]` 中，`hostId` 用于连接已配对桌面；可选的 `executionHost=runtime:<id>` 才指定工作区所在的远端 server。不能把 URL 的 `hostId`、`executionHost`、`worktreeId` 混成一个 ID。证据：`orca/mobile/src/navigation/workspace-route.tsx:19-54`、`orca/mobile/src/transport/workspace-server.ts:12-40`、`orca/mobile/src/transport/execution-host-scoped-rpc-client.ts:19-39`。

Mcode 已有两类相关能力，但它们**不等价于 Orca 的远程开发 Host**：

- **手机远控：** Mcode 手机通过设备 token 调用桌面主进程的白名单 RPC；`remote` 模式与 Cloudflare Tunnel/SSH Relay 改变的是访问桌面本机 Mobile HTTP Server 的网络路径，不会因此生成远端 repo/worktree 的执行主机。
- **Agent SSH：** Mcode 有明确输入的 SSH 连接、用户授信的主机指纹、短命令执行与脱离 SSH 生命周期的远程 job。连接按 `ownerSessionId` 隔离，job 用 `job_id` 持久化/幂等；它是远程命令与任务工具，不是带 project/worktree/host 路由的统一 workspace runtime。

所以正确结论不是“Mcode 没有远程能力”，而是**远程命令、手机访问桌面、远程工作区执行是三个不同的接口/职责**。当前 Mcode 的手机与 Agent SSH 契约中没有发现与 Orca 等价的多执行主机手机工作区路由；这个结论限定于下文列出的源码范围。

## 2. 调用链 A：Orca SSH Host 从 UI 连接到远端 managed runtime

### Orca 入口到状态/副作用

1. `orca/src/renderer/src/components/settings/SshPane.tsx:241-264`：`handleConnect(targetId)` 调用 `window.api.ssh.connect({ targetId })`；断开走同一 target ID 的 `ssh.disconnect`。
2. `orca/src/main/ipc/ssh/ssh-connection-handlers.ts`：IPC handler 将连接请求交给 `connectTarget`；`orca/src/main/ipc/ssh/ssh-connect-flow.ts` 负责目标解析、单目标 in-flight 协调、连接 attempt/authority 归属及清理。
3. `orca/src/main/ssh/connection/ssh-connection-manager.ts` 的 `connect` 路径创建/复用连接与状态；`orca/src/main/ssh/connection/ssh-connection.ts` 负责实际 SSH 连接、认证与传输生命周期。目标身份是持久化的 target ID，不是显示 label 或 IP 字符串。
4. 主机密钥不是简单的“连上就记住”：`orca/src/main/ssh/connection/ssh2-host-key-verification.ts:38-75,91-156` 的 `readHostKeyTrustSources` / `installSsh2HostKeyVerification` 读取 known_hosts、Orca 信任记录和可能存在的系统 SSH 策略，再按 target owner 的策略安装 verifier。信任源读取有超时；文件不可读不应被等同于“已证明这是新主机”。
5. `orca/src/main/ipc/ssh/ssh-host-server-connect.ts`、`ssh-host-server-on-connect-wiring.ts` 与 `orca/src/main/ssh/ssh-host-server-on-connect.ts` 决定连接后是否有可用的 managed `orcad` server，并协调创建/恢复 tunnel、server 状态与必要的部署/迁移流程。
6. `orca/src/main/managed-server/lifecycle/orcad-managed-tunnel.ts` 与 `orcad-managed-tunnel-transport.ts` 管理到远端 managed server 的隧道。TCP port-forwarding 不可用时有 stdio bridge 路径；transport 与连接 attempt 有自己的生命周期。SSH 可连通和远端 runtime 可用是两个状态，不应合并为一个布尔值。

**身份/权限边界（E2）：** `host-selector-alternatives.ts` 的 `fetchSshTargetSummaries` 优先取最小化的 target summary，并对旧端的 `method_not_found` 提供有限兼容回退；`resolveSshHostTargetId` 对不匹配或重名 label 不应随便挑一个。SSH target ID、认证配置、远端 runtime environment ID 与工作区 ID各自有主权。远端 Host 不可用时，路由不应悄悄落回本机。

### Mcode 对照入口

- **Relay（手机网络入口）：** `apps/desktop/src/main/ipc/relay.ts:14-54` → `RelayManager.connect()`（`apps/desktop/src/main/relay/RelayManager.ts:102-144,189-343`）→ 校验配置的 SSH 主机密钥指纹（`apps/desktop/src/main/relay/hostKey.ts:15-22`）→ 部署/连接 VPS 侧轻量 TCP forwarder → SSH `forwardIn`（`RelayManager.ts:523-544`）→ 桌面侧回连 `127.0.0.1:7331` 的 Mobile HTTP Server。断线按有界指数退避重连（`RelayManager.ts:559-584`）。这条链路把网络请求送回**本机 Mcode**，没有选择远端 repo/worktree 执行的步骤。
- **Agent SSH（远程命令入口）：** `apps/desktop/src/main/mcp/agentTools.ts:1736-1802` 的 `agent_ssh_connect` → `agentRemoteSsh.connect`；短命令由 `agent_ssh_exec`（1829-1863）调用 `agentRemoteSsh.exec`；长任务由 `agent_remote_job_start`（1866-1895）调用 `agentRemoteSsh.startJob`。该接口明确要求实际 host、username 与一种认证方式，不扫描密钥或自动展开 SSH Host 别名。远程 job 写在服务器 `~/.mcode/jobs/<job_id>`，SSH/MCP/聊天断开后可继续查询。
- **差异：** Orca SSH target 能成为工作区执行路由的一部分，并可接入 managed runtime；Mcode Relay 是手机传输隧道，Mcode Agent SSH 是按会话持有的通用远程命令/任务工具。它们不是彼此替代品。

## 3. 调用链 B：Orca CLI 的 Host 选择、命令分派与远程 Agent launch

1. `orca/src/cli/index.ts` 解析参数并建立 RuntimeClient，再进入 `orca/src/cli/dispatch.ts` 的命令/handler 分派；命令 handler 不是绕过运行时直接拼 shell 命令。
2. `orca/src/cli/execution-host-flag.ts:48-163` 的 `parseHostFlag` / `resolveHostFlagEnvironmentId` 解析 `--host local`、`--host ssh:<target-id>`、`--host runtime:<environment-id>` 或别名。它明确处理别名同时命中 SSH target 与配对 server 的歧义；读不到 SSH targets 时不应把别名默认解析成 server。显式的 `runtime:<id>` 与 `ssh:<id>` 是不同的选择轴。
3. `orca/src/cli/host-selector-alternatives.ts` 的 SSH target 查询优先使用不暴露凭据的 summary；旧端方法不存在时只对特定列表方法回退。其他失败不会被泛化成“本机目标”。
4. `orca/src/cli/handlers/agent-launch.ts` 与 `orca/src/cli/agent-launch-request.ts` 组合 Agent launch 请求、目标 worktree 与 RuntimeClient 调用。远端 cwd 不能从 CLI 进程所在的本机目录自动推断，因此远端启动需要明确的 worktree/host 选择；`agent.launchReplay` / operation ID 用于处理请求已到达但响应丢失的歧义。
5. `orca/src/cli/runtime/remote-runtime-compat-gate.ts` 在远端调用前检查 runtime 协议/能力兼容；launch 能力由 runtime 自身报告。缺能力或旧端不支持 replay 时，应返回可识别的兼容/结果未知错误，不能把静态源码上的方法名存在当成远端一定支持。
6. `orca/src/cli/handlers/environment.ts` 的 host/environment 列表区分本机、SSH targets 与配对 runtime。这个列表是发现/选择入口，不代表三者共享同一套凭据、生命周期或工作区状态。

### Mcode 对照入口

- Mcode 没有在本次检查的 `packages/contracts/src/mobile.ts`、`apps/desktop/src/main/mcp/agentTools.ts` 与 `apps/desktop/src/main/ipc/agentSsh.ts` 中发现同等的通用 CLI `--host` 路由器。现有入口是 app/IPC 与 MCP Agent 工具。
- Mcode 的 `agent_remote_job_start` 对 `job_id` 做幂等命中并返回 `created: false`，明确要求网络失败重试复用同一个 ID（`agentTools.ts:1866-1895`）。这解决的是“同一远端任务不要重复启动”，不是“选择一个远端 workspace 后将所有 repo/files/git/agent RPC 路由到它”。
- **定位判断（E2）：** 若需求只是从 Agent 对远端执行命令/持续任务，现有 SSH 工具已经覆盖，不应另建一套 CLI 或 job manager；只有需要把 repo/worktree/files/git/agent launch 全部绑定到一个远端工作区时，才需要新的一层 workspace 路由接口。

## 4. 调用链 C：Orca 手机进入工作区后如何固定在正确服务器

1. 手机路由（例如 `orca/mobile/app/h/[hostId]/session/[worktreeId].tsx`）保留配对桌面 ID 与工作区 ID。共享的 `WorkspaceRoute` 从 URL 参数读取 `hostId` 和 `executionHost`（`orca/mobile/src/navigation/workspace-route.tsx:25-54`）。
2. `useWorkspaceServer`（`orca/mobile/src/transport/workspace-server.ts:17-41`）通过同一个 relay-host feed 判断目标 server 是否可达，并读取目标 server 自己的 status/capabilities；server workspace 不复用桌面本机的能力状态。
3. `execution-host-scoped-rpc-client.ts:12-39,70-108` 只接受可识别的 `runtime:<id>` 作为手机远端 server route。它将 `executionHost` 写入 RPC envelope；如果桌面/旧 shell 不支持 envelope 或 server 不可达，`WorkspaceRoute` 显示明确的 unavailable screen，而不是默默在本机打开同一 ID 的工作区。
4. `orca/src/main/runtime/runtime-rpc/runtime-rpc-websocket-dispatch.ts:34-103,132-183` 验证已认证设备/作用域、检查 mobile method allowlist，再由 `relayMobileRequest` 决定本机处理还是转发。远端 route 只转发配置过的 runtime environment；没有加密配对、relay 不可用、executionHost 无效等情况返回明确错误。
5. `orca/src/main/runtime/runtime-rpc/runtime-rpc-mobile-method-routing.ts:4-8,159-165` 将手机方法分为 `execution-host` 与 `paired-desktop`。例如 agent launch、文件、Git 等在 execution-host 上运行；桌面本身持有的 SSH target 操作仍属于持有它们的桌面。方法 allowlist 与 route 分类共同限制转发范围。

### Mcode 对照入口

- `packages/contracts/src/mobile.ts:4-12,187-199` 描述手机调用的是桌面主进程白名单 RPC；wire request 是 `method + input + operationId?`，没有 `executionHost` 字段。设备 ID/token 是手机身份，不是远端执行主机 ID。
- `apps/desktop/src/main/ipc/mobile.ts:59-76,83-103,122-127` 的 `registerMobileHandlers` 创建配对会话、列出/撤销设备并启动手机 tunnel。remote mode 把 pairing endpoint 指向公网 relay endpoint；它没有把项目或 worktree 绑定到另一台执行主机。
- `apps/desktop/src/main/mobile/MobileHttpServer.ts:167-203,249-279,552-583,599-714`：`POST /api/rpc` 通过 Bearer device token 验证后调用 `dispatchMobileRpc`。明文 HTTP 的非回环凭据传输被拒绝；手机自有域名需要在公网终结 TLS、再经 tunnel 回连本机 loopback。Bearer token 是强权限凭据，查询参数 token 仅允许 SSE 兼容路径，普通 RPC 必须用 Authorization header。
- `apps/desktop/src/main/mobile/mobileRpc.ts:141-167` 中项目与会话 RPC 按本机 `projectId`、session/worktree 过滤工作区；写操作有 `operationId` 去重与冲突校验。它把请求分发给本机已有的 IPC/RuntimeManager handlers，而不是按 remote execution host 分发。
- `apps/desktop/src/main/store/repositories/project.ts:18-52,102-122` 的 ProjectRepo 将 `id` 与本机 `path` 持久化；`packages/contracts/src/session.ts:80,198-213` 将 `projectId` 与 `worktreePath` 分开。Mcode 的项目根路径守卫（`apps/desktop/src/main/ipc/files.ts:108-179`）保护本机文件操作，但这不等于为通用远端 SSH `cwd` 建立 host-qualified workspace sandbox。

**结论（E2）：** Mcode 手机远控是“手机 → 安全传输 → 配对的 Mcode 桌面 → 本机 RPC”；Orca 手机远程工作区是“手机 → 配对桌面 → executionHost envelope → 桌面 relay → 指定的 Orca runtime”。两者可共享身份认证/幂等思路，但不能用“手机能连进来”证明 Mcode 已有远程开发 Host。

## 5. 调用链 D：Orca terminal daemon 与远端 managed server 不是一回事

- `orca/src/main/daemon/daemon-server.ts:34-61,114-180,246-313`：`DaemonServer` 组合 `TerminalHost`、连接管理、session attachment、spawn admission、请求路由与生命周期。请求经 `DaemonRequestRouter` 路由；连接关闭时取消该 client 的准备工作、清理流状态并 detach 会话，不等于把远端任务随意杀掉。
- `orca/src/main/daemon/daemon-endpoint-ownership.ts:1-6,34-63,85-166,192-214,260-283`：daemon 先 bind 私有 socket，再发布 canonical endpoint；只有在 probe 明确证明旧 endpoint 已死、连续性检查仍成立时才可替换；`owned/lost/indeterminate` 分开处理，发布后还校验 dev+ino。目的是防止并发启动两个 daemon、误删活 daemon 的 endpoint 或把不确定状态误判成可抢占。
- 这个本机 PTY daemon 与 SSH Host 上运行的 managed `orcad` server 是不同层。前者拥有 terminal/session 的生命周期，后者承载远端 runtime RPC；再外面还有 SSH transport/tunnel。三层的断线、重启与取消语义不可互相替代。
- Mcode 本次核对到的是本机 Mobile HTTP/RPC、RelayManager 和远端 SSH job；没有在这些入口中找到与 Orca `DaemonServer + remote orcad runtime` 一一对应的单一远端 PTY daemon 接口。此处只作**检索范围内的证据不足**判断，不据此声称整个 Mcode 不存在任何后台进程管理。

## 6. 能力对照矩阵

分类是“相对 Orca 的结构化远程 Host/workspace 能力而言”，不是对产品成熟度打分。

| 能力项 | Orca 证据与现状 | Mcode 证据与现状 | 分类 / 等级 |
|---|---|---|---|
| SSH Host 发现与稳定身份 | SSH target registry/store 保存 target ID；CLI 按 ID/唯一 label 解析；执行主机 ID 与 runtime ID 分开。见 `src/main/ssh/targets/ssh-target-registry.ts`、`connection/ssh-connection-store.ts`、`cli/host-selector-alternatives.ts`。 | `agent_ssh_connect` 要调用方提供实际 host/username/auth；`connection_id` 是本会话连接句柄；RelayManager 保存的是一份 relay VPS 配置，不是远端开发主机目录。 | **部分已有（E2）**：有 SSH 连接，但没有同等持久的统一 Host 目录/别名路由。 |
| Host/worktree/project 三种身份 | `ExecutionHostId`、`Worktree.hostId`、`projectId` 分开；host-qualified identity/key 用于跨 Host 区分同一 worktree ID。见 `src/shared/execution-host.ts`、`src/shared/worktree/types.ts:100-115`、`host-qualified-identity.ts`。 | ProjectRepo 的 `id/path`、session 的 `projectId/worktreePath`、SSH 的 `ownerSessionId/connectionId` 各有用途，但手机/SSH contract 没有组合成 remote workspace identity。 | **真缺失（E2，限多执行主机 workspace 路由）**：现有字段不可直接当作 host-qualified workspace ref。 |
| 远端 server / proxy / daemon | SSH connect 后识别/恢复 managed `orcad`；SSH tunnel 支持 TCP forward 与 stdio bridge；本机 PTY daemon 另有 endpoint ownership protocol。 | RelayManager 以 SSH reverse forwarding 将公网 relay 请求送回本机 7331；Agent SSH job 在远端持久化并可脱离连接；不是 Orca 式 workspace runtime。 | **部分已有（E2）**：网络转发与持久任务已有，远端 workspace RPC server/统一 PTY daemon 的等价关系未建立。 |
| CLI Host 命令路由 | `--host local/ssh:<id>/runtime:<id>`、环境/target 冲突检查、worktree 选择、RuntimeClient 与 launch capability gate。 | 本次相关入口是桌面 IPC/MCP `agent_ssh_*` 与 `agent_remote_job_*`，不是 CLI host selector。 | **部分已有（E2）**：远程命令可做，CLI 到结构化 workspace 的路由没有等价证据。 |
| 跨版本兼容 | `remote-runtime-compat-gate`、launch capabilities/replay、有限的 `method_not_found` 旧端回退、managed server version admission。 | Zod contract/IPC validation、手机 `operationId`、SSH job `job_id` 提供各自局部兼容/重试机制；本次入口未见多 remote-runtime protocol/capability handshake。 | **部分已有（E2）**：有 schema 与幂等保护，未见等价的多 runtime 协商门。 |
| SSH 凭据与 Host Key 信任 | SSH config/known_hosts/Orca store/owner policy 共同决定 host-key 验证；target ID 不应被当作 host key 指纹。见 `ssh2-host-key-verification.ts` 与 `ssh-host-key-verifier.ts`。 | `agent_ssh_connect` 只接受显式的一种认证；未知 host 首连 pending；`expected_fingerprint` 本身不是批准。受信 IPC 的 `registerAgentSshHandlers` 固定 `approvalSource: "user"`、写盘后回读并支持撤销（`ipc/agentSsh.ts:41-96`）。 | **部分已有（E2）**：安全原则强，但 credential discovery 与 trust ownership 模型不同。 |
| 远程路径验证 | `sftp-namespace-resolution.ts:28-84,155-210` 验证 POSIX path segment、mapping suffix/root 和 marker；REALPATH/LSTAT 失败时保留 shell path。它解决 SFTP namespace 差异，不是通用 repo-root sandbox。 | `files.ts:108-179` 使用本机已知 Project roots 做 containment guard；通用 Agent SSH job 的 `cwd` 是远端路径参数，没有被该本机 project-root guard 约束。 | **部分已有（E2）**：本机路径有 guard，远端任意命令不等同于结构化 workspace 的路径授权。 |
| 断线恢复与取消 | SSH connect flow 的 attempt/authority 清理、managed tunnel 恢复、CLI launch replay 与 operation ID；daemon endpoint ownership 单独处理。 | Relay 有有界重连；短 SSH exec 超时会杀远端进程组；断开 SSH 不会停止远端 job；job status/log 可重连读取；手机写 RPC 可用 operationId 去重。 | **部分已有（E2）**：任务/连接生命周期有明确区分，但没有统一的 remote workspace session 生命周期。 |
| 手机多 Host workspace 路由 | URL 的 `hostId + worktreeId + executionHost` 分工，server 自己的 status/capability，method allowlist 与 route 分类；目标不可达时明确失败，不落回本机。 | 手机 request 只有 `method/input/operationId`；设备身份和公网 tunnel 只连接配对桌面。 | **真缺失（E2，限手机多执行主机 workspace 路由）**：已有手机远控，但不是远端 workspace routing。 |

## 7. 三个最重要的异常/权限/恢复边界

1. **Host label 同名 / 目标身份不确定（E2 源码，E3 故障推演）。** 输入一个同时命中 SSH target 和 paired runtime 的裸 label，或 target summary 查询失败时，Orca CLI 应要求用户使用 `ssh:<id>` / `runtime:<id>` 明确选择；不能任意选择，也不能静默回退 local。Mcode 的对应保护点是 SSH connect 要求显式真实 host/username，且不能用用户提供的 `expected_fingerprint` 替代宿主签发的 trust grant。
2. **未知/变化的 SSH host key（E2 源码，未做现场连接）。** Orca 会组合 known_hosts、信任 store、系统策略和 target owner policy；Mcode 首连候选指纹需由受信 IPC 的真实用户动作批准，批准源固定为 `user`，写盘后回读确认。失败应停在待确认/拒绝状态，不应为“让连接成功”而自动信任或提前发送凭据。
3. **请求已执行但 ACK 丢失，或 SSH 断开时任务仍运行（E2 源码，E3 故障推演）。** Orca CLI launch 应以同一个 operation ID 使用 replay/recovery 能力；旧端不支持 replay 时不能直接用新 ID 再 launch。Mcode 远程长任务应复用同一个 `job_id`，因为 `agent_ssh_disconnect` 明确不会停止远端 job；短命令超时杀进程组与长任务取消是不同操作。手机 RPC 写操作的 `operationId` 也是“同一意图重试”的幂等键，换参数/方法/设备不能被误认成同一次操作。

**额外路由不变量（E2）：** 手机进入某个 `runtime:<id>` workspace 后，旧桌面不支持 relay envelope 或 server 不可达时必须显示 unavailable；不能把相同 `worktreeId` 当作本机 worktree。这个反例由 `WorkspaceRoute` 与 `runtime-rpc-websocket-dispatch.ts` 的显式失败路径支持，未实际运行测试。

## 8. Top 2 借鉴点 + 1 条不该照搬的设计

### 1. 借鉴设计：把 Host 与 worktree 的归属变成显式、可验证的 identity（复杂度 S/M）

- **为什么：** Orca 的 `ExecutionHostId` 与 host-qualified worktree key 防止两个主机上同 ID 工作区互相覆盖；别名冲突时失败而不是猜。Mcode 当前的 `projectId`、`sessionId`、`connectionId` 分别正确服务于本地项目、对话所有权和 SSH 连接，不应把任何一个强行改成“远端 Host ID”。
- **可适配边界：** 只在未来确实需要结构化远程 workspace 时，先定义一个小的 `RemoteWorkspaceRef`（概念上明确 host + project/worktree identity + remote path ownership），再让现有 Provider/app_api_* 接口消费它；先做 identity/route resolver 的隔离测试，不在 Agent loop、手机 UI、Git/file handlers 中各自再写一套 Host 判定。
- **对 Mcode 的影响：** 不改现有 SSH 通用命令语义；不新增凭据持久化；所有有副作用的操作仍走既有权限/审批入口；工作流只传稳定 ID，不传一个可被误解为本机路径的字符串。
- **未来回归门（本任务未运行）：** 同名 label 冲突、两台 Host 存在同 `repoId::path`、host 不可达、缺失/迁移中的 hostId、错误 host 下的 file/Git/launch 请求均须 fail closed。

### 2. 小模块适配：统一“请求结果未知”的幂等重试契约（复杂度 M）

- **为什么：** Orca 的 `agent.launchReplay` 与 Mcode 已有的 mobile `operationId`、远程 job `job_id` 共同说明：网络失败不能简单等价为副作用失败。
- **可适配边界：** 不新建第二个 job manager；复用现有 operationId/job_id，确保每个写操作都明确区分“本次创建”与“同 ID 已存在/幂等命中”。若未来出现跨远端 runtime 的写调用，再增加一个薄的 capability/preflight adapter，旧端不支持时给出明确错误。
- **对 Mcode 的影响：** 保持统一 Provider 与 `app_api_list → app_api_describe → app_api_call` 约定；不绕过 AppControl 审批；不要在手机 RPC、Agent SSH 与工作流各自实现不同的重试语义。
- **未来回归门（本任务未运行）：** 首次执行成功但响应丢失、同 ID 同参数重试、同 ID 不同参数冲突、连接断开后 job 仍运行、旧 runtime 缺 replay capability、用户取消与旧 ACK 竞态。

### 3. 暂不引入 / 不照搬：Orca 的整套 managed `orcad` 部署、SSH target registry、系统 SSH 配置推导与远端 runtime pairing（复杂度 L）

- **为什么：** 这些是跨进程、跨机器的完整生命周期模块，不是一个可复制的 helper。直接照搬会在 Mcode 现有 Agent SSH 连接、RelayManager、手机 tunnel、AppControl/Provider 中叠加第二套 credential owner、连接池、重连状态机和权限模型。
- **更合适的边界：** Mcode 当前需求若只是“远程跑命令/训练并在断线后取日志”，继续使用显式 SSH 连接 + 持久 job；若产品确实要“远端 repo/worktree 是一等 workspace”，应先独立设计接口与授权模型，再决定是否需要 daemon/runtime 层。
- **版权/资产：** 已只读查看 `orca/LICENSE`，未复制任何 Orca 代码。顶层 MIT 不自动覆盖全部嵌入资源、第三方依赖或品牌资产；本任务没有完成全依赖/资产许可证审计。

## 9. 未验证项与剩余风险

- 这是源码静态审查。没有启动 Orca/Mcode，没有连接真实 SSH 主机/VPS，没有跑手机端或 CLI 端到端，也没有运行单元、smoke、build 或变异测试；不对运行时可靠性、实际兼容矩阵或产品成熟度作保证。
- Orca remote-runtime compatibility gate、managed server 部署/迁移、host key owner policy、relay host catalog 的具体故障时序仍需要后续在固定版本的隔离测试中验证；本报告只确认源码存在相应分支/状态处理。
- Mcode 的远程 SSH `cwd` 不由本机 ProjectRepo path guard 约束，是通用远程 shell 工具与本机文件 IPC 不同的权限模型，不单独构成已证实的产品缺陷；若将来把它改造成结构化 workspace 路由，必须另行设计远端 path containment 与 host ownership。
- Mcode 本次检查的 mobile/SSH contract 路径没有 `executionHost` 式手机多 Host workspace selector。结论仅限已列出的入口/契约，不扩大为“整个仓库绝无其他后台任务管理”。
- 未使用外部网页，不接触用户数据库、凭据或生产环境；未更改 Orca，也未修改 Mcode 产品代码/共享配置/其他任务卡/其他报告。后续实现前应按任务卡指定的完整回归测试门验证，不可把本报告当作实现 PASS。
