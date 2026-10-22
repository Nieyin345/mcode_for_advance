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

### 2026-10-22｜T92 范围门禁：阻塞，未解除 T83 fail-closed（E2 + E1）

- **阻塞证据提交**：`6cb87b3b9f3dee0abf8e25692e16f28ebaae5978`（仅本任务卡；未交付 T92 功能源码）。

- **只读前置核验**：T83 `docsAiPorts.ts` 在带 tools 的请求上依旧调用 `nativeEditorToolBridgeBlockReason`，返回 `unsupported:`，未调用 `RuntimeManager.sendTurn`；T86 `provider.ts` 已具备 `externalTools` / `externalToolHandler`，`RuntimeManager.sendTurn` 已透传，协议前置具备。未触碰 T86/T49/GenOffice/DocumentViewHost。
- **sender → view/document 已有宿主身份来源（E2）**：`documentViewHost.ts:1735` 的 `docIdForSender` 用 Electron `webContents` 对象同一性匹配；Docs `registerDocsIpc` 的 owner 源于此（约 483–493 行），`vendorAiContextForSender`（约 1081 行）绑定其他 GenOffice 格式的 session/path。不能让 renderer 自报身份代替这些绑定。
- **最窄阻塞点（E2）**：GenOffice `agent-core/src/electron-transport.ts` 当前只定义 renderer→Host 的 `start/cancel` 与 Host→renderer 的 `tool-call/done`；`agent-core/src/loop.ts` 的 `finishTurn()`（约 1176、1217、1285 行）在收到 `tool-call` + `done` 后调用 renderer 的 `skill.executeTool`，将结果留在本地 `history`，再用**下一次新的** `ai:stream` 请求发送历史。`genoffice/apps/docs/src/preload/mcode-view.ts` 的严格 `MCODE_DOCS_CHANNEL_POLICY` 仅暴露 `ai:stream` / `ai:stream-cancel` / `ai:stream-chunk`，没有携带原始 `requestId/callId` 的独立 tool-result ACK；`genoffice/apps/docs/src/main/mcode-ai.ts` 的已注册 IPC 同样没有该 handler。因此 Host 无法在原 T86 `externalToolHandler` 等待期间获得可验证的、与最初 renderer 请求及 tool call 显式绑定的回执；把下一轮 renderer 上报的历史当本轮执行成功会绕过本卡要求的显式回执/跨请求防串线，不能代替它。`apps/desktop/src/main/document/docsVendorIpc.ts` 虽在可写表，却是 vendor 缺失时的 fallback stub；`electron.vite.config.ts:239-241` 生产将其 alias 到只读的 `genoffice/apps/docs/src/main/mcode-ipc.ts`，修改该 stub 不能为生产 renderer 新增回执路径。
- **隔离旧红证据**：`node apps/desktop/scripts/run-smokes.mjs t83-mcode-editor-tool-bridge-smoke t86-runtime-native-tool-protocol-smoke` → **2 PASS / 0 FAIL**，原始日志目录 `apps/desktop/.tmp/smoke-runs/1792605090687-42040-meCsyU`。其中 T83 的负向 E1 明确验证结构化 `replace_selection` 请求被 `unsupported` 拦截且 provider 未调用（从正向往返判据看仍为旧红）；T86 仅验证 Host↔fake renderer 的 SDK 同轮协议，不代表真实 GenOffice executor 已接通。
- **停止/边界**：按本任务的 fail-closed、安全/只读边界，在没有受信的 renderer→Host 结果 ACK 及原 requestId/callId 验证通道前停止；不通过解析纯文本 JSON、任意 `ai:stream` 历史、main 中复制 executor 或向 vendor preload 注入未经授权 IPC 来伪造完成。需总控先明确批准一个可写的 renderer/preload 协议窄切片（保持原厂 `AgentSkill.executeTool` 原地执行），之后才能完成 T92 主链。
- **验收**：#1–#5 均未达成（未建立真实工具同轮回执、正向/负控独立 T92 smoke、两项变异及 T92 完整回归/typecheck）；#6 只满足**未越界更改**，未有实现提交及完整验收证据。真实 Electron/三家在线模型 U1 仍留空。未运行任何计费模型或真实用户文档测试。

### 2026-10-22｜总控协调：T98 前置协议卡已建立，T92 保持 blocked

- 复核 T89–T92 四卡后，确认 **T92 是唯一功能性未完成卡**：`docsAiPorts.ts` 仍 fail-closed，T83/T86 独立复跑 2/2 套件 PASS，但本卡 #1–#5 未满足；未有本卡功能实现提交。
- 已建立 `tasks/T98-genoffice-scoped-tool-result-ack.md`，专属写入 GenOffice Docs renderer/preload/main/agent-core 的 Mcode-only、requestId/callId 工具结果 ACK，并要求升级已审查 patch lineage；**不准 T92 擅自改 GenOffice 原厂、T86 或上游通道**。
- **执行顺序**：T98 提交并验收协议后，再让 T92 原执行对话继续其既定 `docsAiPorts.ts`/`nativeEditorToolTransport.ts` Host 接线与隔离正向工具往返；T98 自身不构成 T92 完成。若 T98 证明协议不可安全实现，则 T92 继续 blocked，不恢复不安全的纯文本结果冒充工具执行。


### 2026-10-22｜T98 已通过，T92 恢复执行条件满足

- T98 实现提交：主仓 `e0009be48b9743476ca4a8da3b8ca4d2aae72435`；GenOffice 嵌套仓 `635dee2f6a38d7f0a3aec31a487afc3e2369a5cf`；结果回写主仓 `7759c937`。第 13 个可重放补丁为 `patches/genoffice/0013-feat-docs-ack-native-tool-results-in-hosted-turn.patch`，SHA-256 `7572ccf2650806cd7707f43d8e011d21ad1545e01ecbdbccbe15df6eb672409c`。
- 总控独立复跑 `node apps/desktop/scripts/run-smokes.mjs t98-docs-tool-result-ack-smoke t83-mcode-editor-tool-bridge-smoke t86-runtime-native-tool-protocol-smoke genoffice-editors-release-smoke`：**4/4 PASS**。T98 回写还记录了专项 55/55、agent-core 189/189、typecheck、变异红/字节恢复和 13-patch tree 重放一致证据。
- **新的生产协议 seam（T92 必须消费）**：原厂 `DocsAiPorts.run(request, onChunk, signal, invokeRendererTool?)` 第四参可供 Host 调用，每次收到模型结构化 tool call 后传入原生 `AgentToolCall` 与 Host tool definition，返回 `{status: success|error|cancelled, output}`；GenOffice 的 `mcode-ai.ts` 会用原请求 active state 绑定 renderer、等待 ACK。renderer 使用新增精确 preload 方法 `aiToolResult(ack)` → `mcode:docs:ai-tool-result`；ACK shape 为 `requestId, callId, name, status, output`。拒绝跨 sender/session/document、未知/重复/迟到 callId、未知工具、schema 不匹配、过大 payload、取消和无活请求。
- **T92 下一步**：仅修改本卡原有可写的 Mcode Host 文件，将第四参 callback 与 T86 `RuntimeManager.sendTurn` 的 `externalTools` + `externalToolHandler` 接起来；对每个 Host-issued call，调用 callback 并 await 真实 renderer `AgentSkill.executeTool` ACK，随后把 success/error/cancelled 结果交回**同一个 SDK turn**。保持现有 sender/view/session/path/approval 绑定；不执行第二份工具、不读写 renderer 自报身份、不改 GenOffice/patches、T86 provider adapter 或 T49 权限映射。
- T98 只解除原厂协议缺口，不代表 T92 已通过；T83 fail-closed gate 在 T92 的正向/负控/变异证据通过前仍保持。先完成隔离 E1，真实 Electron/在线 SDK/U1 另排；许可证 gate 继续 BLOCKED。
