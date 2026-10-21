# T92｜GenOffice 原生 AgentSkill 工具往返接线

| 项目 | 值 |
|---|---|
| 编号 | T92（T83-B；T86 后续集成切片） |
| 优先级 | P0 功能主链 |
| 依赖 | T83 fail-closed 能力门已提交；T86 request-scoped native tool protocol 已提交并通过隔离回归 |
| 目标 | 将 Mcode Host 的 request-scoped external tool handler 接到当前受信 GenOffice renderer 的原生 `AgentSkill.executeTool`，让工具结果回到同一 SDK turn；不另造 Agent loop |
| 独占可写 | `apps/desktop/src/main/document/docsAiPorts.ts`、`nativeEditorToolTransport.ts`、确有必要时 `docsAiTypes.ts` / `genofficeViewAiVendor.ts` 的工具事件类型与窄接线、现有 `docsVendorIpc.ts` 中本功能专属的 IPC 接线（如需），新增 `apps/desktop/scripts/t92-genoffice-renderer-tool-roundtrip-smoke/**`、本任务卡 |
| 只读 | `packages/contracts/src/provider.ts`、`apps/desktop/src/main/claude/RuntimeManager.ts`、三家 SDK provider adapters、`documentViewHost.ts`、`genoffice/**`、`patches/genoffice/**`、T49 `appControl/**`、T71/T77 测试夹具 |
| 禁止 | 不修改 T86 provider contract/RuntimeManager/adapter；不复制 GenOffice executor；不把 renderer 工具移到主进程执行；不把工具 schema 拼进 prompt 或解析文本 JSON；不调用在线计费模型，不访问真实用户文档 |

## 开工前必读

1. `audit-ledgers/README.md`、`tasks/README.md`、T83/T86 完整结果回写。
2. `packages/contracts/src/provider.ts` 中 `ExternalToolDefinition` / `ExternalToolCall` / `ExternalToolResult` / `ExternalToolHandler`；`RuntimeManager.sendTurn` 对 `externalTools` 和 `externalToolHandler` 的实际入参。
3. `docsAiPorts.ts`、`nativeEditorToolTransport.ts`、`docsVendorIpc.ts`、renderer `genofficeViewAiVendor.ts` 以及 GenOffice `electron-transport.ts`、`agent-core/loop.ts`、Docs 的真实 `AgentSkill.executeTool` 注册/调用路径。
4. 既有 `t83-mcode-editor-tool-bridge-smoke`、T86 protocol smoke、`document-view-host-smoke`、`genoffice-native-view-smoke` 和相关 sender/session/path/approval/cancel 负控。

## 执行内容

1. **先立正向旧红**：在隔离 harness 中以结构化 tool schema 触发一个 Docs 原生工具调用，证明当前路径因 T83 gate 返回 `unsupported`，且模型没有被当成已执行工具。
2. 使用 T86 已有的 `externalTools` + `externalToolHandler` 协议。Host 只注册当前 renderer request 的工具定义；工具 handler 发出带有明确 requestId/callId 的类型化事件到原请求对应的 renderer，等待该 renderer 的 `AgentSkill.executeTool` 执行结果，再把 success/error/cancelled 回传给同一 SDK turn。
3. 必须复用既有受信 view/session/path/sender 绑定；renderer 自报的 session、filePath、view 身份或工具权限不得成为事实源。若当前 IPC 无法证明 sender 与原 view/document 绑定，先停止并回写最窄阻塞点，不得绕过校验或修改 `documentViewHost.ts`。
4. 工具名称与参数严格按该次请求 schema/白名单校验。未知工具、schema 不匹配、跨 request/session/document/pane 回执、重复/过期 callId、审批拒绝、取消后的迟到结果、renderer 关闭或无回执均 fail-closed；不得返回空成功结果。
5. 至少用 Docs 的真实原生 `AgentSkill.executeTool` 注册表验证一个安全工具和一个会改变隔离文档内容的工具：读回结果、应用修改、将结果交回 SDK turn，并让模拟 SDK 在收到结果后继续同一 turn。保存/undo 只能调用原厂 renderer 路径，不得在主进程重实现。
6. 新建独立 T92 smoke，覆盖 request A/B 并行与乱序结果、sender/session/path/pane 绑定、未知工具、畸形/超大输入、审批拒绝、取消、迟到回执、renderer 崩溃/结束和结果 envelope 错配。至少两项确定性变异须先红、逐字节恢复后变绿。
7. 运行新 Smoke、`t83-mcode-editor-tool-bridge-smoke`、T86 protocol smoke、`document-view-host-smoke`、`genoffice-native-view-smoke`、`doc-ops-smoke` 和相关 provider 回归；运行 desktop/contracts typecheck。若失败属于并行工作树其他文件，记录精确错误与文件，不越界修复。
8. 本卡仅做隔离 E1；真实 Electron/在线三 SDK/U1 另行安排，不能用 harness 宣称用户旅程完成。

## 验收判据

1. Docs 原生工具的结构化调用真正到达 renderer `AgentSkill.executeTool`，结果 envelope 回到同一 SDK turn，SDK 在同轮结果后继续；纯文本 JSON 不会触发工具。
2. sender、session、document path、requestId/callId 与当前允许工具表均由 Host 绑定和核验；跨请求/跨 pane 回执不能串线。
3. 正常结果、工具错误、审批拒绝、取消、迟到结果和 renderer 结束均有明确状态；无 handler 或失败时不产生成功空结果。
4. request A/B 并行、未知工具、schema/大小限制和身份错配负控通过；至少两项变异能稳定变红且源文件逐字节恢复。
5. 新 Smoke、T83/T86 代表性回归及双包 typecheck 通过；所有未运行的在线模型/真实 Electron U1 明确留空。
6. 不修改 T86/T49/GenOffice 上游或共享 DocumentViewHost；只提交本卡可写文件，并记录 SHA、命令、计数、日志与 remaining。

## 不做

不做六格式完整 U1，不调用真实在线模型，不改 GenOffice 原厂 skill 算法，不重写 provider agent loop，不改变 T49 权限映射，不解除 T83 fail-closed gate 直到正向往返和负控均通过。

## 结果回写区

<!-- 只追加实现提交、旧红→新绿、SDK 同轮往返证据、变异/还原 SHA、测试命令/计数与 U1 remaining。 -->
