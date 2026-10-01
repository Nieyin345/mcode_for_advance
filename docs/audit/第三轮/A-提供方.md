# 第三轮 · A 提供方(providers / claude / runtimes)

范围:`apps/desktop/src/main/{providers,claude,runtimes}`(47 个文件,约 1.9 万行)。
验证:增量 tsc 通过;lint-changed 7 个文件 0 问题;相关 smoke 14 个全过
(maint-m18、installers-ipc、tunnel-manager、public-mcp-session、mcp-endpoint、upstream-headers、
agent-mail、engine-regressions、engine-commands、provider-context、node-session、budget-guard、
event-vertical、claude-ipc)。

## 修复的问题

| 编号 | 位置 | 问题 | 修复 |
|---|---|---|---|
| A1 | `claude/RuntimeManager.ts` | 发送后立刻点「停止」无效(所有引擎)。`startTurn` 期间(建桥、Pi 加载 SDK / createAgentSession、Claude 拉起 MCP、Codex 启动,常常好几秒)`rt.handle` 还是上一轮已经结束的 handle,`interrupt()` 调它等于空操作,这一轮照常跑完 | `SessionRuntime.interruptRequested`:启动期间收到停止就记下;`sendTurn` 拿到本轮 handle 后立即补发 `interrupt()`(并 reject 挂起的审批);入口和 finally 清标志 |
| A2 | `providers/codex-sdk/CodexAgentSdkProvider.ts` | Codex 回合开始前的停止不生效。`initialize` / `thread/start|resume` / `skills/extraRoots/set` 期间(每个最长 120 秒超时)没有 turnId,无法 `turn/interrupt`;等它们返回后还会照常发 `turn/start`,白烧 token | `interrupt()` 时如果还没有 turnId,直接 dispose 这个只属于本轮的 app-server 进程(挂起的请求立刻失败,走「已中断」收尾);`runTurnAndWait` 发 `turn/start` 前检查 abort。顺带清掉 2 秒宽限竞速里没清理的 setTimeout |
| A3 | `providers/pi-sdk/PiAgentSdkProvider.ts` | Pi:在 agent 循环真正开始前(`prompt()` 里还在鉴权/压缩)停止,`session.abort()` 没有可中止的 run,是空操作,随后 agent 照常开跑(A1 补发的 interrupt 也会落进这个窗口) | 订阅回调里收到 `agent_start` 时如果已 abort,补一次 `session.abort()`(不 await;agent_start 时 run 的 AbortController 已经建好,见 pi-agent-core `agent.js` 的 runWithLifecycle) |
| A4 | `providers/pi-sdk/PiAgentSdkProvider.ts` | Pi 结构化输出:用户停止后如果最终回复解析失败,仍会**追发一轮纠错 prompt**(停了还在烧 token),并报 schema 不符 | 已 abort 时跳过纠错轮,按 `interrupted` 收尾 |
| A5 | `providers/claude-sdk/ClaudeAgentSdkProvider.ts` | Claude 结构化输出降级路径:用户停止后可能弹出「结构化输出校验失败」卡片,并按 error 收尾 | 已 abort 时跳过校验 |
| A6 | `runtimes/runtimeInstaller.ts` | 内核 tarball 下载没有超时,连接卡死就永远挂着:`installing` 一直为 true,面板上「重试」也点不了,只能重启应用 | 按「停滞」计的超时(60 秒没收到数据就放弃,每收到一块数据重新计时;慢网下长时间下载不受影响),给出中文提示 |
| A7 | `runtimes/runtimeInstaller.ts` | 重装同一版本时先 `rmSync` 掉正在用的目录。安装没有「有回合在跑」的守卫(只有卸载有),在 win32 上会删掉一半(跑着的 exe 删不掉,旁边的文件已经没了),原安装就坏了 | 旧目录先改名挪到 `.<ver>.old-*`(改名是整体操作:被占用就失败、原安装原封不动,并提示先停回合);staging 改名失败时还原 |
| A8 | `runtimes/runtimeInstaller.ts` | 安装成功后清理其它版本时,如果某个目录被占用(EBUSY/EPERM),异常会把**已经成功的安装报成失败**,而且同样会删掉一半 | 清理改为尽力而为:先改名到 `.<ver>.trash-*` 再删,被占用就跳过并记日志,下次安装再清 |
| A9 | `providers/bridge/bridgeServer.ts` | 自定义模型的本地转发口(127.0.0.1 随机端口)不验任何凭证(`routeToken` 生成后从没被使用)。网页可以用 DNS 重绑定把自己的域名指向 127.0.0.1,变成「同源」,借用户的上游 key 跑模型并读到结果 | 校验 Host 头只能是 `127.0.0.1` / `localhost` / `[::1]`(可带本端口),否则 403。Claude 二进制拨的就是 `http://127.0.0.1:<port>`,不受影响 |
| A10 | `providers/bridge/tunnelManager.ts` | cloudflared 输出按数据块逐块 split,域名正好被切在两块之间时匹配不上,白等 60 秒再重连(快速隧道还会换域名) | 逐行处理不变,另外拿「上一块末尾 256 字符 + 这一块」再找一次域名 |

## 已排查(无需再查)

- `providers/codex-sdk/`:CodexAppServerClient(请求超时、退出、dispose 幂等)、CodexAgentSdkProvider(线程恢复、结构化守卫、计划模式收尾、临时图片清理)、codexBinaryResolve(win32 固定 `codex.exe`,不存在 `.cmd` 问题)。
- `providers/claude-sdk/ClaudeAgentSdkProvider.ts`:传输重试只在没出内容时进行;abort 走 flushFinal。
- `providers/pi-sdk/`:PiAgentSdkProvider、PiMessageAdapter(turn.done 只在终态 `agent_end` 发;defer 模式;flushFinal)。确认**不会**双发 turn.done:启动前的错误(没模型/没鉴权)直接抛、不发 agent_end;abort 走 agent_end(stopReason aborted → interrupted)后 `prompt()` 正常返回。
- `claude/RuntimeManager.ts`:sendTurn / sendTurnBound / interrupt / 预算守卫;`claude/ApprovalBridge.ts`:中断时 rejectPending 正常。
- `runtimes/`:runtimeInstaller(完整性校验 sha512、版本目录名白名单、npm 组装超时杀整棵树)、managedRuntimeRoots、runtimeAvailability。
- `providers/bridge/`:extensionBridge(常量时间令牌比较、Origin 白名单、1MB 请求体上限)、mcpEndpoint(4MB 上限,挂在已鉴权的扩展桥上)、publicMcpServer(路径密钥 + timingSafeEqual,只监听 127.0.0.1)、publicMcpSession、tunnelManager(重连退避封顶 6 次)、bridgeServer(32MB 上限)、bridgeRegistry、webUpstream。

## 已知限制(不改)

- Codex 计划模式只是提示性的:完全访问下自动批准不看 `planMode.active`;`approvalPolicy=never` 时 codex 根本不会来问。
- `CodexAppServerClient` 没有监听 `child.stdin` 的 error;全局 `uncaughtException` 只记日志(`src/main/index.ts`),不会崩。
- bridgeServer 仍然挡不住网页对 127.0.0.1 的「盲发」POST(读不到结果,但会消耗额度,而且得先猜中随机端口)。要彻底挡住需要让 Claude 二进制带上 routeToken,改动面较大,暂不动。
- `ensureCodexHomeIdentity` 写共享的 `CODEX_HOME/AGENTS.md` 不是原子写(并发概率极低)。

## 打包后请验证

1. 每个引擎(Claude / Codex / Pi / 自定义模型)**发送后立刻点停止**:应在几秒内显示「已中断」,不再继续输出、也不再执行工具。
2. Codex 冷启动时停止:不应该再有回复出现;任务管理器里本轮的 codex.exe 应该退出。
3. 自定义模型(走本地转发)正常对话一轮,确认 Host 校验没有误伤。
4. 设置 → 内核:有回合在跑时重装同一版本,应提示「正在使用中」,原内核仍可用;正常升级后旧版本目录被清掉(被占用则下次再清,不应报安装失败)。
5. 开启公网隧道:能拿到 `trycloudflare.com` 域名。
