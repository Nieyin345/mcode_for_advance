# T0｜GenOffice 原生工具同轮往返接线

- Status: ready-for-agent
- Category: bug
- Priority: P0
- Depends on: none (T83/T86/T98 protocol prerequisites are historical; revalidate current HEAD)
- Exclusive writable files: to be confirmed from current source call chain before editing; list exact paths in the result. Do not modify provider adapters, appControl/T49, GenOffice upstream, or patches unless this card is explicitly amended.
- Acceptance: a scoped Docs renderer tool call executes only in the bound trusted renderer and returns its result to the same SDK turn; test parallel A/B request binding, wrong sender/session/document/callId, duplicate/late ACK, cancellation, denial, and missing approval. Unknown operations fail closed.
## Required Skills
  - `mcode-smoke`: write isolated fake-IPC/renderer regressions and perform mutation verification.
  - `code-review`: review the final diff against this bounded integration contract.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, `audit-ledgers/Mcode_统一审查台账.md`, archived T92/T83/T86/T98.
- Execute: inspect current HEAD and dirty state; confirm old-red behavior first; implement only the Host↔renderer↔same-turn seam; run focused smoke and mutation check.
- Do not: claim live online SDK or Electron U1 passes from fakes.
- Result writeback: implementation SHA, exact tests/results, mutation proof, remaining U1 limitations, commit SHA.

## 结果回写（2026-10-23）

### 开工前声明：精确可写文件集（编辑前写入）

- `apps/desktop/src/main/document/nativeEditorToolTransport.ts` — 把 T83 的单一 block-reason 门改成「文本 / 宿主工具 / fail-closed」三态规划器；三个已验证 SDK 的能力状态由 `needs upstream` 改为 `supported`（依据 T86 + T98）。
- `apps/desktop/src/main/document/docsAiPorts.ts` — 消费 T98 第四参 `invokeRendererTool`：把 `request.tools` 收敛成 `externalTools` + `externalToolHandler` 交给既有 `RuntimeManager.sendTurn`，等待 ACK 后把 `success/error/cancelled` 回同一 SDK turn；发送端工具定义必须原样回传（GenOffice 侧按 canonical JSON 比对 schema）。
- `apps/desktop/scripts/t0-genoffice-native-tool-roundtrip-smoke/main.ts`、`run.sh`、`stubs/nativeAiMcode.ts`（新增套件）。
- `apps/desktop/scripts/t83-mcode-editor-tool-bridge-smoke/main.ts`、`run.sh` — 该套件钉住的正是本卡改变的行为（能力状态断言），必须随之更新；其余断言保持不变。
- `tasks/T0-genoffice-native-tool-roundtrip.md`（本回写区）。

不写：`packages/contracts/**`、`apps/desktop/src/main/providers/**`、`RuntimeManager.ts`、`appControl/**`、`documentViewHost.ts`、`genoffice/**`、`patches/genoffice/**`，以及其他对话正在修改的文件。

### 实现范围

- **规划器 `planNativeEditorTurn`**（`nativeEditorToolTransport.ts`）：四态——纯文本请求走旧文本桥；工具请求仅在「已验证 SDK 适配器 + T98 受信 ACK 回调存在」时生成 `tools` 计划；其余一律 `refuse` 并发出 `unsupported:` 错误。每个渲染端工具先过**既有共享**校验器 `validateExternalToolDefinitions`（唯一一份，未复制 schema 规则）；不能表达的（`type: [X,'null']` 联合、深度 >12）进 `withheld` 并在提示词里列名告知模型；全不可表达则拒绝。数量/总字节上限只由共享校验器裁决（尾部裁剪并逐项记入 withheld），本模块不另立常量。
- **桥 `createNativeEditorToolBridge`**：每个 SDK 调用绑定本请求 session + 允许表；校验 callId 格式、重复、输入为 JSON object、≤64 KiB；转发前检查取消；渲染端结果严格映射 `success/error/cancelled`；渲染通道抛错 → 带原因的显式 error；取消后晚到结果 → `cancelled`，绝不 success。
- **`docsAiPorts.ts`**：`run` 消费 T98 第四参；`plan.kind === "tools"` 时把 `plan.tools` 原样作为 `externalTools`、桥作为 `externalToolHandler` 交给**既有** `RuntimeManager.sendTurn`（审批 / dontAsk / 重复调用门仍由既有 dispatcher 在前）；turn 结束 `finally` 中止桥的 signal 并退订。无第四参时工具请求仍在 `sendTurn` 前 fail-closed。
- **能力表**：三个已验证适配器 `needs upstream → supported`（依据 T86 协议 + T98 ACK 均已落地并复跑通过）；未验证 provider 仍 `unsupported`。
- **真实 Docs 工具表探测（E1 前置事实）**：用真实 `AGENT_TOOLS` + 常量工具 + files/KB skill 共 **40** 个工具跑共享校验器 → **32 通过 / 8 拒绝**（`insert_chart/edit_chart` 联合类型、`set_page_setup/define_style/set_watermark/insert_text_box/insert_picture` 联合类型、`generate_mindmap` 深度超限）。即当前 Mcode 请求级契约最多能承载 Docs 的 32 个工具，其余 8 个按 withheld 明示，不静默消失。

### 动态证据（E1，全部为 fake SDK / fake IPC，非 U1）

- **旧红（HEAD 源码）**：`bash .tmp/t0-oldred/run.sh` → `{"turnStarted":false,"chunks":["error:unsupported: GenOffice 原生 AgentSkill 工具调"],"rendererToolExecuted":false,"sameTurnResult":false}`，`OLD-RED CONFIRMED`。即 HEAD 的 `docsAiPorts` 在 `sendTurn` 前拦截工具请求，渲染端工具从未执行、更无同轮回传。
- **新绿**：`bash apps/desktop/scripts/t0-genoffice-native-tool-roundtrip-smoke/run.sh` → **55/55 通过**。覆盖：正向（真实 T98 `registerDocsAiIpc` + 真实 `docsAiPorts`，假 SDK 循环调用请求级 handler，两工具结果按序回同一 turn）；纯文本请求不注册任何工具、JSON 形文本不被当工具；无 ACK 回调 / 未知 provider / 仅结构化历史 → fail-closed；并行 A/B 请求（不同 sender、不同文档、不同 session）串线、错 sender、错文档、错工具名、未知 callId、重复 ACK 全部拒绝且只有首个 ACK 到达对应 SDK turn；桥层错 session / allowlist 外 / 非法 callId / 重复 callId / 非 object 输入 / 取消 / 取消后晚到结果 / 渲染通道抛错 全部显式失败；withheld 与超限裁剪；审批拒绝不启动 turn、工具拒绝回显为 error；取消、renderer 销毁、缺失 ACK 超时均回 cancelled/error；纯文本 hosted turn 不触碰桥。
- **回归**：`node apps/desktop/scripts/run-smokes.mjs t0-genoffice-native-tool-roundtrip-smoke t83-mcode-editor-tool-bridge-smoke t86-runtime-native-tool-protocol-smoke t98-docs-tool-result-ack-smoke genoffice-native-view-smoke doc-ops-smoke genoffice-ai-ask-smoke genoffice-editors-release-smoke` → **8 pass / 0 fail**（日志目录 `apps/desktop/.tmp/smoke-runs/` 对应本轮）。其中 T83 从旧 19/19 更新为「能力已 supported」后的 **19/19**（仅改该条断言，其余 18 条不动）。
- **typecheck**：`npx tsc --noEmit -p packages/contracts/tsconfig.json` → PASS；`npx tsc --noEmit -p apps/desktop/tsconfig.json` → 我的文件全部干净，唯一报错来自**他人未跟踪**文件 `apps/desktop/scripts/electron-u1/driver/steps.ts`（本次开工前已在工作区，`git status ?? apps/desktop/scripts/electron-u1/`；临时移开该文件后 desktop tsc PASS，已原样放回）。按卡不越界修复。

### 变异验证（撤修复→红→逐字节还原→绿）

以 `.tmp/t0-mutate/mutate_t0.py` 精确 `str.replace`（带出现次数断言），备份在 `.tmp/t0-mutate/`。

1. **删掉桥的 session 绑定**（`nativeEditorToolTransport.ts`）：T0 套件 **49/55**、exit 1；跨 session、重复 callId、取消等负控变红。还原后 `cmp` 逐字节一致（transport SHA-256 仍 `8afe171a…`）。
2. **把「ACK 回调存在性」恒为 true**（`docsAiPorts.ts`）：T0 套件 **54/55**、exit 1；「无 ACK 回调的工具请求必须 fail-closed」变红。还原后 `cmp` 逐字节一致（ports SHA-256 仍 `e30165ed…`）。

两次还原后套件复跑 **55/55**。

### 文件 SHA-256（提交前）

```
8afe171a6529582cd76801f45798804b7dc6c81adacfccd0b4033367641dec64  src/main/document/nativeEditorToolTransport.ts
e30165ed4038bc87e0ba2bd74aac1ee1f50364d485a0d0e9dd533304d0246548  src/main/document/docsAiPorts.ts
c82a13d905c6201cb9e804811f44a0d96d0bc7608b62082853977ea513fea2b4  scripts/t0-genoffice-native-tool-roundtrip-smoke/main.ts
37c651bb9c8b937099116acb3396d3d9b7c907d90a8c9d235a2d60b9bc93c144  scripts/t0-genoffice-native-tool-roundtrip-smoke/run.sh
2eee2613c46b583fac725ab1faa55f475eee23b4d0fa26899af72f5d46ed57fe  scripts/t0-genoffice-native-tool-roundtrip-smoke/stubs/nativeAiMcode.ts
64f1e85283c0dd6fd58801ca4fdf9e5f2496a309df17632625f651ec4c0c84e4  scripts/t0-genoffice-native-tool-roundtrip-smoke/stubs/logger.ts
b74370bb6a2df71aed628eabfd63dd83bbc8e56d290e95a3ee2fbbe4ac2dec8c  scripts/t83-mcode-editor-tool-bridge-smoke/main.ts
125821dec07f3349356a1750c54d00b3245dbec4355399c8d087cd25a391dfeb  scripts/t83-mcode-editor-tool-bridge-smoke/run.sh
64f1e85283c0dd6fd58801ca4fdf9e5f2496a309df17632625f651ec4c0c84e4  scripts/t83-mcode-editor-tool-bridge-smoke/stubs/logger.ts
```

### 验收判据逐条

1. **scoped Docs 渲染端工具调用只在绑定的受信渲染端执行并回同一 SDK turn** — 达成（E1）：T98 的 `registerDocsAiIpc` 以 sender 对象同一性、session/document 快照、requestId/callId/name/status/output 做绑定；Mcode 侧不再拦截，改为请求级 handler 等待 ACK 回同轮。
2. **并行 A/B 绑定、错 sender/session/document/callId、重复/迟到 ACK** — 达成（E1）：T0 §4/§5/§7 全绿。
3. **取消、拒绝、缺审批、未知操作 fail-closed** — 达成（E1）：取消回 cancelled；审批拒绝不启动 turn；渲染端拒绝回显 error；未知工具/未知 callId/allowlist 外/非法输入全部 error 或 refuse，无空成功。
4. **至少两项变异先红、逐字节恢复后变绿** — 达成：见上（49/55、54/55 → 55/55）。

### 剩余限制（未冒充）

- **未做真实 Electron U1**（T7 排期）：本卡全部为 fake SDK / fake IPC 的 E1；真实 Docs 渲染端 `AgentSkill.executeTool`、真实选区编辑/undo/save 未在真窗口验证。
- **未跑在线三 SDK**：Claude/Pi/Codex 的 `supported` 依据是 T86 协议 + 本轮 fake 回合，不是在线模型回合；在线同轮往返仍 U1 pending。
- **真实 Docs 工具表 40 → 可承载 32**：8 个工具因共享 JSON-Schema 子集（联合类型/深度）无法进入请求级契约，本轮按 withheld 明示；若需全部 6 编辑器/全部工具，需另立卡扩展共享子集（不在本卡范围，且会触及 `nativeToolProtocol.ts`/provider 适配器）。
- **`document-view-host-smoke` 既有失败，非本卡引入**：`apps/desktop/scripts/document-view-host-smoke/nativeDocs.ts:34` 硬编码 `Object.keys(policy).length === 51`；T98 的提交 `635dee2` 在 GenOffice preload 增加 `ai:tool-result` 路由后策略条目变 52，该断言在**HEAD 源码**下同样失败（已实测）。该文件不在本卡可写集，未改；需另立/并入卡修正常量。
- **第三方未跟踪文件**：`apps/desktop/scripts/electron-u1/driver/steps.ts` 是他人未提交的 U1 工作，导致 `tsc -p apps/desktop` 出现两行报错；本卡未触碰，移开验证后我的文件类型干净。
- **提交 SHA**：见下方 `### 提交`。

### 提交

- 实现提交：`6bd8289e`（`feat(docs): round-trip GenOffice native tool results into the same SDK turn`），10 文件 +1125/−41。
- 提交后复跑（对提交后的工作树，非提交前）：`t0-genoffice-native-tool-roundtrip-smoke` **55/55**、`t83-mcode-editor-tool-bridge-smoke` **19/19**；`git archive HEAD` 与工作树逐字节一致。
- 本次提交只含上列 10 个文件；`.aoci/baseline.json`、`.gitignore`、`apiCatalog.generated.ts`、`settingsTransfer.ts`、`smokes-for.py`、`tasks/T13-genoffice-baseline.md` 及未跟踪的 `apps/desktop/scripts/electron-u1/` 等他人/并行改动均原样保留，未 reset/clean。
- 本回写区追记提交：`docs(tasks): record T0 commit SHA`（紧随 `6bd8289e` 的文档提交）。

