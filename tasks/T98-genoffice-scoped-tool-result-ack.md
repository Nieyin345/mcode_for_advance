# T98｜GenOffice Docs 原生工具结果 ACK 协议前置（解除 T92 阻断）

| 项目 | 值 |
|---|---|
| 编号 | T98 |
| 优先级 | P0；T92 继续实现的前置 |
| 来源 | T92 回写提交 6cb87b3b、a7091fc4：原生 tool-call 无受信的请求级结果 ACK |
| 目标 | 仅为 Mcode 托管的 GenOffice Docs 增加可信 renderer→Host 工具执行回执；保留原生 AgentSkill.executeTool 和既有 standalone 行为 |
| 独占可写 | genoffice/packages/agent-core/src/electron-transport.ts、genoffice/packages/agent-core/src/loop.ts、genoffice/apps/docs/src/renderer/ai/transport.ts、genoffice/apps/docs/src/renderer/ai/AiPanel.tsx、genoffice/apps/docs/src/preload/mcode-view.ts、genoffice/apps/docs/src/main/mcode-ai.ts、genoffice/apps/docs/src/main/mcode-ipc.ts、genoffice/apps/docs/src/shared/ipc.ts 中必需的最小改动；新增 apps/desktop/scripts/t98-docs-tool-result-ack-smoke/**；新增可重放 patches/genoffice/0013-*.patch；对应 apps/desktop/build/genoffice-upstream.lock.json、verify-genoffice-upstream.cjs 补丁链；本任务卡 |
| 禁写 | apps/desktop/src/main/document/**（T92 独占）、RuntimeManager/三 SDK adapters（T86）、apps/desktop/src/main/workflowEngines/** 与 orchestration/**（T93/T94/T97）、vendor-licenses/**、原厂 standalone preload index.ts、用户文件 |

## 必须先看

1. audit-ledgers/README.md、tasks/README.md、T83/T86/T87/T92 全文与 T92 的 #1–#5 未达证据。
2. GenOffice 的 agent-core electron-transport、loop 的 finishTurn、Docs 的 renderer ai/transport、AiPanel、mcode-view preload、mcode-ai、mcode-ipc 和 shared/ipc。
3. Mcode 的 T86 externalTools/externalToolHandler 协议与 T83 fail-closed 门禁，只读；T87 patch lineage 与测试。
4. git status 与 git -C genoffice status。任何共享文件正在被其它任务改动，就停止该文件并说明冲突，禁止 reset/clean/覆盖。

## 已有 E2 证据

- GenOffice agent-core 的 stream 包已经有 tool-call，但 finishTurn 等 done 后才执行 renderer skill.executeTool，并把结果留在本地 history、再在新一轮 ai:stream 发送。
- T86 Host 的 externalToolHandler 会暂停当前 SDK turn 等待真实工具结果。二者协议节奏不一致；把后续 history 当 ACK 既不满足同轮约束，也无法防跨请求串线。
- Mcode Docs preload 的 MCODE_DOCS_CHANNEL_POLICY 没有专门的 tool-result ACK；生产 IPC 是 GenOffice 原厂 mcode-ipc + mcode-ai，不是 Mcode 的 fallback docsVendorIpc。

## 执行

1. 建隔离旧红：模型结构化发出工具调用后，当前 T86 SDK 仍在等待，renderer 无法通过可信通道回送 requestId/callId，不能把普通文本/下一轮历史冒充成功。
2. 设计只在 Mcode Hosted Docs 启用的严格 opt-in 工具流：Host 认可的待执行 requestId + callId + tool schema 送给受信 renderer；renderer 用原生 AgentSkill.executeTool 执行后在 SDK 同轮仍等待时发出真实 success/error/cancelled 结果；禁止工具被原生 loop 和新通道重复执行。
3. 只增加精确、最小、方向受限的 preload IPC 路由。mcode-ai 内应对活请求、sender 绑定、工具名、callId、payload 尺寸、取消、超时、重复/迟到 ACK 做 fail-closed 校验；不能信任 renderer 自报 docId、文件路径或 session 身份。可以提供可注入的 Host callback seam 给 T92，但本卡不接 T92 的主进程。
4. 不把 renderer 的本地 history、done chunk 或伪造的工具 success 当 Host callback。无匹配 Host 请求或审批未通过时拒绝；单独保证 standalone AI 的旧流程完全不变。
5. 新建 T98 E1 smoke：正常原生工具执行回执、两个请求乱序、跨 sender/doc/pane、未知工具、畸形/超大结果、取消后的迟到回执、renderer 结束、无 Host callback、任意未授权 ai:* IPC。至少两项反向变异红→绿且逐字节恢复。
6. 原厂源码变更必须按既有批准 patch stack 创建可审计的新增补丁；在隔离副本验证基线 + 12 个旧 patch + 新 patch 可以精确重放并匹配树哈希。更新 upstream lock/严格 verifier 的增量证明，不能仅更改期望 SHA，也不能回退原有 12 个 patch。不修改许可证与 releaseEligible。
7. 跑 T98、T83、T86、T87 lineage、genoffice-editors-release-smoke 及双包 TypeScript。只精准提交本任务可写文件，分别回写主仓/嵌套 repo SHA（如果有）、全部测试与变异/字节恢复证据。
8. 本卡只交付原生安全协议。完成后由 T92 原执行对话继续把 Mcode 的 docsAiPorts/nativeEditorToolTransport 接入 T86 externalToolHandler，另做真实 Docs 编辑 + SDK 同轮往返。不可把协议接线当 T92 全部验收。

## 验收判据

1. 可信 sender 的原生 AgentSkill.executeTool 结果可在同一 SDK turn 等待期间按 requestId/callId 精确回传，不等到下一轮历史。
2. Mcode-only opt-in 不改变 standalone AI loop；无重入双执行；任意/冒名/跨请求/已取消/重复结果及开放式 IPC 都拒绝。
3. 隔离正反测试、至少两项变异及源字节恢复、T83/T86/T87 代表回归与双包 tsc 通过。
4. GenOffice 追加 patch 的完整重放链、增量 SHA 与 tree 哈希有证据；已有 T87/T88 许可证阻断不因本卡放宽。
5. 不修改 T92 Host 文件、T93–T97 或真实用户资料；若无法安全实现，停留在 fail-closed 并指出最小不可解决契约缺口。

## 结果回写区

<!-- 追加实现提交、原厂 patch SHA、测试计数/日志、旧红→新绿、变异与字节恢复和 remaining。 -->


### 2026-10-22｜实现回写（E1）

- **主仓实现提交**：`e0009be48b9743476ca4a8da3b8ca4d2aae72435`（`feat(docs): add scoped native tool result ACK protocol`）。
- **GenOffice 嵌套仓提交**：`635dee2f6a38d7f0a3aec31a487afc3e2369a5cf`，父提交 `355e667353ad90da7d0b3c6823fad0f525b729c3`，最终 tree `532e6727eb1f4e94e686cee1ab55a99bddf8f6f0`。
- **可重放补丁**：`patches/genoffice/0013-feat-docs-ack-native-tool-results-in-hosted-turn.patch`，SHA-256 `7572ccf2650806cd7707f43d8e011d21ad1545e01ecbdbccbe15df6eb672409c`，65,835 bytes。lock/verifier 已固定第 13 个补丁的提交、父提交、字节数、SHA-256 和最终 tree；旧 12 个补丁均保留。
- **正向与回归**：`t98-docs-tool-result-ack-smoke` **55/55 PASS**；`t83-mcode-editor-tool-bridge-smoke`、`t86-runtime-native-tool-protocol-smoke`、`genoffice-editors-release-smoke` **4 套全 PASS**；T87 provenance/license smoke **71/71 PASS**，第 13 个补丁逐项重放后 tree 精确匹配。
- **构建/类型检查**：GenOffice `format:check --base 355e667353ad90da7d0b3c6823fad0f525b729c3` 通过；agent-core **189/189 tests**、agent-core/docs typecheck 通过；desktop 与 contracts 两个 `tsc --noEmit` 通过。
- **变异验证与字节恢复**：
  1. 移除 ACK 的 sender 对象同一性校验后，T98 smoke **52/55**，跨 sender ACK 与 request A/B 绑定断言变红。
  2. 绕过 session/document 一致性校验后，T98 smoke **53/55**，跨文档 ACK 拒绝与取消断言变红。
  两次均恢复源文件原始字节并复跑变绿；恢复文件 SHA-256 均为 `f00e4d22963125922dcc5cfd946faae955a25db0df70491d6dca418a445603f3`（21,603 bytes）。GenOffice 工作树最终干净。
- **remaining**：T98 交付的是 Mcode-hosted Docs 的原生工具 ACK 协议和 Host callback seam；T92 仍需把 `docsAiPorts/nativeEditorToolTransport` 接入 T86 `externalToolHandler`，并做真实 Docs 编辑往返。未改 T92 Host 文件，未运行真实 Electron/在线 SDK/U1。T87 仍明确 **8/18** 完整许可证文本已验证、**10 项**缺权威完整文本，release 保持 BLOCKED；未放宽许可证门禁。
