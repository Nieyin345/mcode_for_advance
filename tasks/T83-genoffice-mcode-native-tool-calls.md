# T83｜T75 确认断点：Mcode SDK 到 GenOffice 原生 AgentSkill 的结构化工具调用能力门

| 项目 | 值 |
|---|---|
| 编号 | T83（GenOffice 路线图 T31-A 第一阶段） |
| 重要性 | **P0 功能主链**：当前 AI 面板可能只会给编辑建议，工具未真正执行 |
| 来源 | T75 结果回写；ARC-007 / FULL-3 |
| 复用 | L1 GenOffice agent-core 原厂 tool-call/tool-result 规范及三家 SDK 事件；L2 Mcode docsAiPorts / transport，不新造 Agent loop |
| 可派 | **立即**；在 T49（appControl）和 T73（browser）在飞情况下可并行 |
| 可写 | `apps/desktop/src/main/document/docsAiPorts.ts`、必要时 `apps/desktop/src/main/document/docsAiTypes.ts` / `genofficeViewAiVendor.ts` 的**工具事件类型区域**、新增 `nativeEditorToolTransport.ts` 与 `apps/desktop/scripts/t83-mcode-editor-tool-bridge-smoke/*`、本卡 |
| 禁止 | `genoffice/**` 上游编辑算法、`packages/contracts/**`、`appControl/**`、`modules/**`、`workflowEngines/**`、`documentViewHost.ts`、T73 浏览器、真实用户文档 |


## 证据与限定
T75 指出 `docsAiPrompt` 对 GenOffice 请求只取 `messages` 文本、丢弃 tool schema；`dispatchDocsAiTurn` 目前只向 renderer 输出 `delta/reasoning/error/done`。原厂 `electron-transport.ts` 需 `tool-call` chunk，之后 `agent-core/loop.ts` 才能调用 `skill.executeTool`。因此不能把“模型返回文本建议”当“原厂编辑器已经执行工具”。原厂六编辑器都已有各自 skill，**不改它们的算法**。

## 开工前必读
1. `audit-ledgers/README.md` 与 `tasks/T75-genoffice-agent-skills-six-app-audit.md` 的原始 6×9 能力审查及下一卡建议。
2. `genoffice/packages/agent-core/src/electron-transport.ts`、`agent-core/src/loop.ts`、六 app 已注册 tools 的 schema；确认 tool ID、参数、取消、异步结果以及与 token 用量的差别。
3. Mcode `main/document/docsAiPorts.ts`、`docsVendorIpc.ts`、`genofficeViewAiVendor.ts`、`genofficeViewAiVendorStub.ts` 和真实三家 SDK `RuntimeManager` 的事件类型；区分模型自发工具、宿主 built-in 工具与原厂编辑器工具。
4. `genoffice-ai-ask-smoke` 原厂 mock 模型、`genoffice-native-view-smoke/ai.ts`、T05c/T54 的宿主 sender 授权/取消验证。

## 执行
1. **先立旧红**：受控假 Mcode SDK 以结构化 tool-call 请求 `replace_selection` 或 `apply_ops`，证明目前 renderer 收不到原生 `tool-call`。同时证明返回文本 `{"tool":"..." }` 不能被误执行。
2. 阅读三 SDK 的**真实已暴露**消息/流事件和工具回执形状，做实际能力矩阵；不能因为上游 `ai-provider` 能做到就假定 Mcode 原生 SDK 自带工具映射。若 RuntimeManager 没有安全暴露 tool-call，明确返回 `unsupported` 并回写**最窄前置任务**，不能伪装运行成功。
3. 在只允许现有可信会话（宿主 sender、路径/工作区、选中会话、用户审批、requestId、AbortSignal）的前提下，提供 Mcode native tool-call 到 GenOffice renderer `ViewAiChunk`/Docs chunk 的**窄类型桥**；工具执行和 undo/save 必须留在原厂 renderer。让工具回执回到对应原模型轮次，不得把结果错误广播到所有 pane。
4. 工具名/args 输入必须匹配已公开白名单/schema 与可编辑文档身份；陌生工具、跨文档、跨 pane、伪请求、没有审批 token、错误工具结果、取消后的迟到包，一律 fail-closed；**不能**通过解析模型纯文本 JSON 冒充 tool call。
5. 真三 SDK 逐个标 `supported/unsupported/needs upstream`，不在此卡修改模型 loop 或不相干 RPC。如果同一文件其他执行者已占用，停止并联系总控。
6. 重点构造假 provider E1 `request A`/ `request B` 并行与切 pane、取消、审批拒绝、非法工具和正常多轮回执的负控。若实际接线必须修改 T49 正在改的 appControl/contract，停工并回写，不越界。

## 验收
1. 执行者能展示**真实结构化**工具调用→类型化 renderer chunk→原厂 `AgentSkill.executeTool` 入口或精确指出哪个 SDK 缺协议并正确拒绝；**仅返回工具建议文本不算通过**。
2. Docs 正向受控选区/工具结果至少有 E1 动态单测；五种其它原生格式列出 schema 共用性及差距，暂不冒充 6/6 GUI 可编辑。
3. 假 sender、错误 filePath/session、串流跨 request、晚到回执、未知工具、未审批和取消均拒绝；原厂编辑器 save/CAS 边界不绕过。
4. 既有 `genoffice-ai-ask-smoke`、`genoffice-native-view-smoke` 和有关 Docs/AI 的代表性套件通过（若与在飞 Electron 竞争只跑 E1、标 U1 待验）；双包 tsc 通过或注明外部在飞阻断。
5. 两类变异：去掉工具事件 schema/映射→正向用例红；去掉 sender/requestId/工具 allowlist 之一→越权负控红；源码完整恢复且列文件 SHA。
6. 三家在线 SDK + 六编辑器真 Electron、UI 选区/修改/撤销/保存重开仍须后续 T71/T83-B U1，不给 ARC-007 整包双勾。

## 禁止
不私自启动在线计费模型、不把官方 GenOffice 工具源码复制进 Mcode、不添加第二套文档编辑器、不把框架提示词“请编辑”当授权、不改 T49/T73 在飞区。

## 结果回写区

<!-- 执行对话只追加：实际提交、旧红→新绿、源码/上游 SHA、失败负控、测试命令与计数、仍未满足的 U1，不要覆盖正文。 -->
