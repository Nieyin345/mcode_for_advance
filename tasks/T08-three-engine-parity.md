# T08｜三引擎能力对齐收尾（ARC-003）

| 项目 | 值 |
|---|---|
| 编号 | T08 |
| 类型 | ARC-003 |
| 优先级 | 中 |
| 建议并发 | 可与 T01/T02/T04/T06 并行；**不要**与任何改 provider 的任务并行 |
| 预计规模 | 中 |

---

## 为什么做这个任务

ARC-003 的定义是「Claude Code / Codex / Pi **基础工具语义对齐**与**可配置上下文注入**
统一交付」。台账里这条的记录几乎全是**单点安全修复**（异常处理、路径稳定性、
会话分叉 Saga），也就是：**在修 bug，而不是在验证"三家真的对齐了"**。

参照物已经有了：`docs/design/三引擎能力对照.md`。但那份文档是**静态描述**，
不是**可执行的对照矩阵**。缺的是「同一件事，三家分别怎么做，Mcode 是否一致」的
**机器可验证**清单。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）+ 台账 ARC-003 条目（搜 `### ARC-003`）。
2. `docs/design/三引擎能力对照.md` 全文 —— 这是现有的对照表，本任务把它变成可执行断言。
3. `CLAUDE.md` 的「看这几条才动得了手」第 2 条（AgentProvider 抽象）。
4. `apps/desktop/src/main/orchestration/` 下各 provider 的实现
   （`claude*` / `pi*` / `codex*`，先 `ls` 确认文件名）。
5. `apps/desktop/scripts/engine-capability-matrix-smoke/` 与
   `apps/desktop/scripts/base-capability-matrix-smoke/` —— 已有的矩阵测试，
   先跑一遍并读懂它们验的是什么、**没验什么**。

---

## 执行内容

### 1. 把对照文档变成矩阵

新增 `apps/desktop/scripts/engine-parity-matrix-smoke/`，把 `三引擎能力对照.md` 里
**每一条能力**变成一个三元组断言。能力清单至少包含（以现有文档为准，不要自行扩）：

- 预算（budget）与超限行为
- 模型回退（fallback）
- 结构化输出（structured output）校验失败时的行为
- 子代理（subagent）派发与结果回收
- elicitation / 提问交互
- 权限审批（approval）的落点与超时
- 上下文注入（可配置上下文）
- 取消（cancel）与中断后的状态
- 会话恢复（resume）

每条断言要回答：**三家的行为是否等价？不等价的地方是有意差异还是缺陷？**

**有意差异**（例如某家 SDK 没有 elicitation）：记为 `N/A`，并在矩阵里写原因。
**缺陷**：记为 `FAIL`，并在回写区列出来 —— **不要在本任务里顺手修**，
修是下一个任务的事（混在一起就无法判断基线是否可信）。

### 2. 找出"文档说一套、代码做一套"

`三引擎能力对照.md` 是**人写的**，可能已经过期。逐条核对：

- 文档说"已对齐"的，代码里真的对齐了吗？
- 文档说"不支持"的，代码里真的没有吗？

把不一致项列成一张表（文档原文 / 代码事实 / 结论）。

### 3. 上下文注入的唯一通路

`ARC-003` 标题里的「可配置上下文注入」目前散落在多处（系统提示词、`criteria-inject`、
`agentTools`、记忆注入）。核实：

- 是否存在**多于一条**注入通路？
- 如果有多条，它们的优先级与去重规则是什么？有没有重复注入同一段上下文？
- 新增一条断言：同一份上下文**只被注入一次**。

---

## 边界（不要碰）

- **不要**修任何 provider 的实现（本任务只做对照与断言）。
- **不要**改 `packages/contracts`。
- **不要**改工作流、文档、移动端。
- 如果发现某个 provider 有安全缺陷（例如凭据泄漏），**立刻停下并在回写区置顶写明**，
  不要继续做矩阵。

---

## 验收判据

1. `engine-parity-matrix-smoke` 覆盖对照文档里的**每一条**能力，没有漏项。
2. 每条断言都有明确的 `PASS` / `FAIL` / `N/A` 三态，`N/A` 必须带原因。
3. 「文档 vs 代码」不一致表完整，每条可追溯到文件行。
4. 上下文注入通路数量明确，且"只注入一次"有断言。
5. 现有 `engine-capability-matrix-smoke` / `base-capability-matrix-smoke` 全绿。
6. 双包 tsc 干净。
7. **变异验证**：对"只注入一次"这条，人为制造重复注入 → 必须变红。

---

## 你要在回写区回答的问题

- 三家**真正不一致**的有几条？分别是哪几条？（这些是下一批修复任务的输入）
- 对照文档有几条已经过期？
- 上下文注入有几条通路？有没有重复注入？
- 有没有发现安全缺陷（如果有，置顶写）？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->


### 2026-10-21 执行回写（T08 / ARC-003，E1+E2，未宣称 U1）

**源码提交**：`0100129a2b41622916801d693ff652d48ab6aac1`（`feat(T08): add executable three-engine parity matrix`）；仅提交，不推送。后续本任务卡回写单独提交。

**文件清单**：
- 新增 `apps/desktop/scripts/engine-parity-matrix-smoke/main.ts`：27 行能力 × Claude/Pi/Codex = 81 个三态格，每格说明与源码锚点；源码锚点漂移就让 smoke 红，真实产品缺陷以 `MATRIX|...|FAIL|` 显式报告，不因测试基线仍有缺陷而伪造通过。
- 新增 `apps/desktop/scripts/engine-parity-matrix-smoke/run.sh`：隔离 esbuild 编译；`T08_CONTEXT_MUTATION_FILE` 只在测试期 alias 一个副本，不碰 Provider、契约、真实项目数据。
- 仅追加本文件结果区；不修改 `audit-ledgers/`、Provider、`packages/contracts/`、工作流、移动端及其他对话文件。

**实际验证/原始日志**：
- 开工前：`node apps/desktop/scripts/run-smokes.mjs engine-capability-matrix-smoke base-capability-matrix-smoke` → **2/2 suites PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792532083143-29100-a59EEh`。
- 最终：`node apps/desktop/scripts/run-smokes.mjs engine-parity-matrix-smoke engine-capability-matrix-smoke base-capability-matrix-smoke` → **3/3 suites PASS，0 FAIL**；新矩阵 `284/284` 内部校验 PASS（指矩阵事实/锚点和正反例校验，**不代表**产品的 `MATRIX|FAIL` 已修）；日志 `apps/desktop/.tmp/smoke-runs/1792532904171-36724-Fb77IR`；同一脚本新增 27×3 状态汇总见 `engine-parity-matrix-smoke.log`。
- `npx tsc --noEmit -p apps/desktop/tsconfig.json` 与 `npx tsc --noEmit -p packages/contracts/tsconfig.json` → **双包 exit 0**。
- `git diff --cached --check -- apps/desktop/scripts/engine-parity-matrix-smoke` → **exit 0**；只暂存 T08 两份新增测试文件；其他对话已有改动不包含在本提交。
- **变异（E1）**：`node apps/desktop/.tmp/t08-mutate.cjs prepare` 将真实 `contextPrompt.ts` 的 `.filter(...)` 换成额外 `.concat('MEM-T08')`，只写 `apps/desktop/.tmp/t08-context-mutation.ts` 独立副本；`set T08_CONTEXT_MUTATION_FILE=./.tmp/t08-context-mutation.ts&& node apps/desktop/scripts/run-smokes.mjs engine-parity-matrix-smoke` → **1 suite FAIL，279/284（5 条红）**，日志 `apps/desktop/.tmp/smoke-runs/1792532892413-38236-5UrYUh`。执行 `node apps/desktop/.tmp/t08-mutate.cjs restore` → `CMP byte-identical: restored-mutation == original AND production == original`；随后正常真实代码**284/284，3/3 suites 绿**。未修改真实 `src/main/providers/contextPrompt.ts`。临时 `.tmp` 脚本及构建/日志受忽略规则管理，非交付源码。

**三引擎能力状态**：矩阵 27 行有 **8 类真正的引擎差异**：自定义子代理（Claude 接、Pi/Codex `N/A`）、MCP elicitation（Pi `N/A`）、MCP（Pi `N/A`）、Plan 模式写权限/沙箱（语义不同）、设置面板对三家无差异显示（Pi/Codex `FAIL`）、原生斜杠命令（Pi/Codex 当前 app 路径 `N/A`）、原生输出风格（Pi/Codex `N/A`）、provider 原生 fork（Pi/Codex `N/A`）。`N/A` 都标明原生 API 或当前接线的缺失原因，**不把有意差异算成 bug**。另 3 个按引擎专属历史缺陷验的行（Pi Bash 快照、Pi 停止原因、Codex 平台包）不应误算成产品整体三家能力差异。

**实际待修缺陷（仅登记，不在本任务里改实现）**：
1. 三家**共有** `fallback-custom`：`apps/desktop/src/main/claude/RuntimeManager.ts:1346-1350` 对 `session.workflowId/customModelId` 拒用回退链，即使用户已配置；`docs/design/三引擎能力对照.md:33-35` 旧报告指出的现象还在（要讨论业务上自定义模型 ID 如何映射回退目标）。
2. 三家**共有** `approval-timeout`：`apps/desktop/src/main/claude/ApprovalBridge.ts:65-82`  pending Promise 创建后无宿主过期 timer/自动拒绝；SDK 级时限未做真机验证，不能声称 SDK 绝不超时。无桥时 Provider 均有 deny/block 保护（Claude :995-1002、Pi `mcodeExtension.ts:468-483`、Codex :1197-1208）。
3. 三家**共有** `context-dedup`：`apps/desktop/src/main/providers/contextPrompt.ts:21-24` 只 trim/filter，`memoryPrompt` 与 `agentPrompt` 文本相同时真实纯函数输出 2 段；分别由 Claude :1203、Pi :306、Codex :577 交给 SDK。正例每段只有一次、每 Provider 消费一次；但**跨层同字节输入仍重复**，尚未修复，属验收第 4 条残余缺陷。
4. `settings-visibility`：`apps/desktop/src/renderer/components/settings/GeneralPanel.tsx:614-627` 三组件无条件展示，Pi/Codex 的输出风格无对应 SDK 消费入口，设置语义容易误导，记录 Pi/Codex `FAIL`（文档 :16-31）。

**历史文档 vs 现源码不一致表（6 组已过期；均 E2，文件行可查）**：

| 旧文档原文所述 / 位置 | 当前真实源码位置和事实 | 结论 |
|---|---|---|
| Pi 预算 token 为累积、USD 为空（对照 :23-27） | `PiAgentSdkProvider.ts:402-425` 捕获轮开始基线；`piTokenUsage.ts:96-123` 计算 `turnProcessedTokens/turnCostUsd`；基线丢失时可降级累计 | **已过期/有条件** |
| `workflowPrompt` 仅 Claude 接收，Pi/Codex 忽略（:47-55） | `RuntimeManager.ts:1509-1516,1623-1627` → `contextPrompt.ts:21-24` → Claude `:1203`、Pi `:304-307`、Codex `:575-584` | **已过期** |
| renderer 的 `supportsMcp` 零命中（:57-67） | `renderer/components/settings/workflows/ParamFieldParts.tsx:43-52` 在 MCP 表单能力不支持时显式提示 | **已过期**，不表示所有旗标都被消费 |
| Pi `stopReason` 总当正常结束（:114-117） | `pi-sdk/PiMessageAdapter.ts:605-621`，`length→max_tokens`、`toolUse→tool_use`、`aborted→interrupted` | **已过期** |
| Pi Bash 写入从不进 `turn.files` 快照（:114-117） | `pi-sdk/mcodeExtension.ts:375-403` 对解析出的字面写入目标 `recordPre`，shell 复杂动态写入仍未全覆盖 | **部分已过期** |
| Codex 平台包固定 macOS 包名（:103-110） | `codex-sdk/codexBinaryResolve.ts:109-112,152-160` 使用 `platformSuffix()` | **已过期** |

**仍与源码相符 / 尚待动态证实**：历史 :16-31 所述设置面板无条件显示仍存在；:33-35 所述自定义网关禁用回退仍存在；:80-88 的计划模式行为各异仍存在（`PiAgentSdkProvider.ts:128-139` “read-only gate”注释与 `mcodeExtension.ts:440-478` “写需审批”实际分支不一致；以实际 guard 为准）；:98 的 Claude `supportsAskUserQuestion: true` 仍是乐观声明（`ClaudeAgentSdkProvider.ts:431`），特殊网关真实体验没验证。历史关于 SDK 原生命令/structured output 无全应用调用方、i18n/工具卡 UI 的断言未开展真实 UI U1，不能把 E2 观察当作确认所有旧问题已解决。该文件是 2026-09-20 资料，不是当前完整产品状态。

**上下文注入通路数量与优先级**（按“用户可配置/工作流上下文”归并为 **3 条逻辑入口**，不是误算成 3 个可独立重复的 Provider）：① `RuntimeManager.ts:1511-1640` 宿主聚合环境/记忆/项目指令/角色/工作流 5 层，经唯一 `turnContextSections` 按 `env→memory→project→agent→workflow` 顺序交给 Claude system prompt、Pi resource loader、Codex developerInstructions；② `runner.ts:1040-1056` / `criteriaInject.ts:77-90` 在非恢复且消息表为空时将入口固定条件拼到首条 prompt（第一轮一次）；③ `runner.ts:1062-1073` / `criteriaInject.ts:102-117` 按用户勾选的向下传递开关，给**各下游节点**拼一节相同条件（这属于每个节点有意可见，非同一个节点重复）。其它 `RuntimeManager.ts:1590-1618` 回流/代理邮件/交接文本走 user prompt，是独立事件，不等同五层可配置 system context。通路①不同字段**无跨层去重**，输入碰撞会重复；通路②第一轮去重已有正控；通路③须按图节点逐次计入，不能以“整个工作流只出现一次”错误验收。

**验收逐条**：
1. **有界达成（E2/E1）**：27 类/81 格覆盖任务九个核心能力及对照文档其它重要引擎能力；文档是问题清单而非正式枚举，不声称已动态复现每个历史 UI 问题。
2. **达成**：全部单元 `PASS/FAIL/N/A`，`N/A` 有原因；产品 `FAIL` 不伪装成 smoke 错误。
3. **达成（E2 能力范围内）**：上述 6 组历史不一致 + 当前仍相符/未知清单均给出文档行、代码行，待真 SDK/真 Electron U1 的项目如实保留。
4. **未完全达成（真实缺陷）**：3 个配置注入入口识别；“每 Provider 的单次注入”与变异防护可验证，但不同字段同字节时**没有全局只注一次保证**（`context-dedup` 三家 `FAIL`）；按禁止触碰 provider/契约/工作流的边界，**本卡不修**。
5. **达成**：既有两个矩阵 smoke 全绿。
6. **达成**：双包 tsc exit0。
7. **达成**：隔离 context helper 变异 5 条红；字节恢复 cmp 一致、回绿。

**风险/未做**：未触碰三家 SDK 凭据、不运行真三引擎在线会话、不启动 Electron；故不具 U1 用户旅程证据。没有发现需立刻停工的**明确凭据泄漏等安全缺陷**；宿主审批超时是等待/可用性风险，缺审批桥的 deny 仍正常。现有并行工作树在其他 ARC/移动端有改动，本任务精准提交两测试文件、不干涉其他任务。**ARC-003 整包开发/独立复核双勾继续留空**。
