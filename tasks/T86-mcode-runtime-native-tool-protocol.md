# T86｜Mcode 三 SDK 的请求级结构化工具协议前置能力

| 项目 | 值 |
|---|---|
| 编号 | T86（T83 发现的唯一前置；GenOffice T31-A 后续切片） |
| 优先级 | **P0 前置**：没有同轮工具 schema / 调用 / 结果往返，T83 必须保持 fail-closed |
| 来源 | T83 源码审计与 E1 负控：`RuntimeManager.sendTurn` / `StartTurnRequest` 目前没有 request-scoped GenOffice tools 或 renderer-result callback |
| 目标 | 保留 Claude / Pi / Codex 各自原生 SDK 的 agent loop，让每轮可受控注册外部工具，并把该次工具调用的结果返回**同一 SDK turn** |
| 可派 | T83 结果已写回后可单独派发；不需要真实在线模型 |
| 独占可写 | `packages/contracts/src/provider.ts` 的最小工具协议契约；`apps/desktop/src/main/claude/RuntimeManager.ts` 的每轮入参透传；`apps/desktop/src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts`、`pi-sdk/PiAgentSdkProvider.ts`、`codex-sdk/CodexAgentSdkProvider.ts` 中对应原生 SDK 适配；必要时仅修改这些适配器直接使用的动态工具 helper；新增 `apps/desktop/scripts/t86-runtime-native-tool-protocol-smoke/*` 与本任务卡 |
| 禁写 | `apps/desktop/src/main/document/docsAiPorts.ts`、`nativeEditorToolTransport.ts`（T83）；`main/appControl/*`（T49）；`genoffice/**`、`patches/genoffice/**`；不复制任何 GenOffice 编辑器 executor |

## 已确认的断点（E2）

- `packages/contracts/src/provider.ts:120` 的 `StartTurnRequest` 没有本轮外部工具 schema；`ProviderContext` 没有调用外部 renderer tool 并等待结果的回调。
- `RuntimeManager.sendTurn` 目前只接收 prompt、cwd、skills、MCP / plugin allowlist 等输入，未接收 GenOffice 这轮传来的工具定义，也无法将 renderer 工具结果交回正在运行的 SDK turn。
- Claude 的 `options.mcpServers`、Pi 的 `customTools`、Codex 的 `dynamicTools` 都由 Mcode 已注册的宿主工具组装。它们产生的 `tool.use` / `tool.result` 是 Mcode 自有工具的执行事件，不能当成任意 GenOffice renderer tool 的执行回执。
- T83 已新增 fail-closed gate：带工具 schema / 结构化工具历史的请求会在 `sendTurn` 前得到显式 `unsupported`；不允许通过提示词里的 JSON、自然语言建议或宿主文件工具伪装成原生编辑器操作。

## 执行

1. 在 provider contract 中定义最小、provider-neutral 的**每轮**工具定义与调用回执类型（名称、描述、JSON Schema、call id、结构化输入、结果/错误、取消状态）；由 RuntimeManager 只把本次请求的定义交给选定 provider，并注入一个由 Host 创建的异步 handler。不要把函数、IPC 对象或 Electron sender 序列化进 prompt。
2. Claude / Pi / Codex 分别通过各自 SDK 的原生工具注册/调用机制消费这份 per-turn 工具定义；工具 handler 必须调用 Host 注入的 callback，等待同一 call id 的结果再返回给 SDK。不能将 schema 拼进纯文本、解析模型输出 JSON、另造第二个 ReAct loop，也不能让 provider 自己打开文件或访问 GenOffice renderer。
3. 保留 Mcode 原有用户审批与 provider 工具策略。无 handler、无审批、工具名不在本轮允许表、输入不符合 schema、重复/过期 call id、跨 session 回执、取消后迟到回执，一律拒绝；不能把工具调用回退成成功的空结果。SDK 端不能实现该往返时，provider 必须显式报 `unsupported`，不得静默换引擎。
4. 在新的隔离 smoke 中用 fake SDK / adapter harness 覆盖三家：原生 tool call → Host callback → fake renderer result → **同一 SDK turn 收到结果并继续**；并覆盖未知工具、畸形/超大输入、并行 request A/B、审批拒绝、取消、迟到回执和 provider 结束。禁止在线模型、真实文件、生产凭据和真实 Electron UI。
5. 对每家 SDK 记录真实适配入口与能力差异。若某 SDK API 不能支持动态工具/同轮结果往返，明确将其状态标为 `unsupported`，并保持 T83 的拒绝，不为凑齐三家而造一套主进程循环。
6. 跑新增 smoke、`document-view-host-smoke`、`genoffice-native-view-smoke`、相关三引擎 provider suites，以及 `apps/desktop` / `packages/contracts` TypeScript 检查；如失败，区分本卡回归与并行工作树阻断。

## 验收

1. 具备结构化 per-turn tools + async result round-trip 的 provider contract，RuntimeManager 只传入当前 request 的定义与 callback；没有把 Electron / renderer 对象塞进序列化数据。
2. 至少一个真实 provider adapter 的隔离 E1 正例证明 tool result 回到**同一 SDK turn**，模型/SDK 能基于结果继续；Claude / Pi / Codex 分别给出 E2 能力结论，不能用统一 fake harness 冒充三家均已支持。
3. 负控覆盖未知工具、schema/args 不符、无审批、错误 session/call id、request A/B 并行、取消与迟到回执；不得产生错误的成功结果或跨请求串流。
4. 至少两项确定性变异：撤去 request-local tool 定义/回执映射，正例必红；移除 call-id/session 校验或取消门禁之一，对应负控必红；恢复后源码 hash 与 smoke 全绿。
5. 新增 smoke、相关既有 Docs/AI 与三引擎回归套件、desktop/contracts tsc 通过；未运行真在线 SDK / 真 Electron UI 时明确留 U1 pending。
6. 不改 `docsAiPorts.ts`、T49 `appControl` 或 GenOffice 上游；本卡完成**不代表**原生编辑器工具已接通。之后需另派一个只负责把 T83 的 Host callback 接到 sender/session/path-bound renderer `AgentSkill.executeTool` 并验证实际选区编辑、tool result、undo/save 的集成卡。

## 不做

不实现 GenOffice renderer IPC / tool executor，不修改六个编辑器的 AgentSkill，不把 skill 迁入主进程，不重写 agent loop，不改 T49 权限面，不连真实模型/云端，不因某一家 SDK 不支持而静默降级。

## 结果回写区

<!-- 执行对话只追加：源码版本、红→绿、原始命令/计数、变异及还原 hash、每家 SDK 的能力结论与 remaining。 -->
