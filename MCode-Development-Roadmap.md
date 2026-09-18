# Mcode 开发总路线图

> 用途：这是当前 `mcode` 重构/扩展工作的唯一任务总表。后续可以开多个对话并行推进，但每个对话必须认领独立任务，避免同时修改同一核心文件。
>
> 项目根目录：`D:\destop\work_space\work_for_reseach\mcode`
>
> 当前目标：把 Mcode 从“偏学术用途的固定 Agent”继续演进成“可自定义工作场景的 Agent + 工作流 + 自动化运行平台”，同时保持现有 Claude / Pi / Codex、多会话、IDE、移动端等基础能力稳定。

## 1. 总体方向

Mcode 不再把“文献下载、PDF 转录、学术检索”等功能视为核心业务能力，而是把它们视为可以由用户自己组合出来的工作流/自动化。

核心抽象逐步收敛为：

```text
用户场景
   ↓
Workflow / Automation
   ↓
Scheduler
   ↓
NodeRunInput
   ↓
Execution Engine
   ↓
Executor Registry
   ├── Agent / Conversation
   ├── Code
   ├── Command
   ├── Branch
   ├── Trigger
   └── Future executors / plugins
   ↓
NodeOutcome
   ├── summary
   ├── outputs
   ├── artifacts
   └── execution metadata
```

最终的运行时上下文目标：

```text
Workflow Runtime Context
├── execution identity
├── node input
├── upstream outputs
├── artifacts
├── workflow variables
├── execution state
├── cancellation
├── progress
└── persistence / resume
```

## 2. 当前已完成的工作

### P0 — 原有工作流基础能力

- [x] 工作流从固定“模式提示词”抽象为可编辑节点图。
- [x] 节点以 `type + params` 表达，不再通过封闭的 `kind` 列表描述节点行为。
- [x] 节点类型采用可注册清单，支持 builtin / plugin / local 来源。
- [x] 工作流依赖以 `edges` 为唯一事实来源，不再维护第二份 `dependsOn` 真相。
- [x] 图布局与执行语义分离：布局列只用于画布展示，真正执行只看依赖边。
- [x] Branch 节点选项直接来自出边；边支持 `label` / `note`。
- [x] 支持用户选择分支、模型选择分支。
- [x] 支持分支后的 `unselected` 与 `failed/skipped` 区分。
- [x] 支持回头/循环式工作流迭代，并已有重新布防逻辑。
- [x] 已实现可恢复运行状态：记录、轮次、选择、节点结局、等待中的节点、触发器入口均可保存。
- [x] 已实现自动化 Trigger 基础模型：手动 / schedule / file / event / webhook 语义。
- [x] Trigger 节点作为运行入口，`WorkflowDoc.trigger` 从 Trigger 节点反推。

### P1 — Workflow Prompt / Variable 基础设施

- [x] 创建统一 `{{...}}` 模板语法。
- [x] 支持 `{{user}}`。
- [x] 支持 `{{Node.output}}`、`{{Node.status}}`、`{{Node.error}}`、`{{Node.title}}`。
- [x] 支持 `{{Node.params.xxx}}`。
- [x] 支持产出变量短写法 `{{Node.xxx}}`。
- [x] 支持 `{{Node.outputs.xxx}}`。
- [x] 支持 artifacts 路径引用。
- [x] 只允许引用当前节点的上游。
- [x] 支持节点 id / 节点标题两种引用方式，并处理标题歧义。
- [x] 引用错误会在执行前明确失败，而不是把 `{{...}}` 原样交给模型。
- [x] Renderer 已有“插入变量”候选机制。
- [x] 已有 output variable 表：变量名 + 示例。
- [x] 已有输出硬约束：模型产出按变量表检查，缺失变量则节点失败。
- [x] 已将解析出的结构化变量写入 `NodeOutcome.outputs`，供下游继续引用。
- [x] 已统一 `outputValueText` 等结构化输出展示逻辑。

### P2 — Scheduler / Dataflow 基础

- [x] Scheduler 实现“就绪即派发”，不是按整层等待。
- [x] 支持真正的并发执行。
- [x] 支持最大并发数限制。
- [x] 支持失败传播。
- [x] 支持取消传播。
- [x] 支持前置检查：节点类型缺失、执行方式未实现、参数缺失等。
- [x] 支持 branch / loop / resume。
- [x] 已把 `NodeRunInput` 从 Scheduler 内部定义提升为稳定 runtime contract。
- [x] 新增 `WorkflowDataContext`：统一承载 userInput / upstreamText / upstreamOutputs / upstreamArtifacts。
- [x] Code / Command 节点已经可以直接接收结构化上游数据。
- [x] 已加入 artifact URI 标准化。
- [x] 已验证 downstream 能拿到结构化输出和 artifact 引用。

### P3 — Execution Engine / Executor Registry

- [x] 新增 `ExecutionContext`，把 host-only 的取消 / 进度能力与 contracts 分离。
- [x] 新增 `NodeExecutor` 接口。
- [x] 新增 `NodeExecutorRegistry`。
- [x] `ExecutionEngine` 改为通过 Registry 找 executor，而不是写死 runner 分支。
- [x] 已注册 `CommandExecutor`。
- [x] 已注册 `CodeExecutor`。
- [x] 新 executor 可以通过注册实现扩展，而 Scheduler 不需要增加新的 kind 分支。
- [x] Executor 有统一执行元数据：runId / sessionId / nodeId / timing。
- [x] Missing executor 会得到明确的 failed outcome。
- [x] 已有 Execution Engine smoke test，当前 10/10 通过。

### P4 — Code / Command 执行器

- [x] Code runner 支持 Python / Node / shell / PowerShell。
- [x] 支持 JSON stdin / structured result。
- [x] 支持 progress 协议。
- [x] 修复 protocol stdout 污染：`@@mcode:*` 行不再混入普通 stdout。
- [x] 支持 stderr、非零退出、timeout、AbortSignal cancellation。
- [x] Artifact 相对路径能够转换成稳定引用。
- [x] Code runner smoke 当前 15 项全部通过。
- [x] Dataflow smoke 当前 6/6 通过。

### P5 — 当前回归基线

- [x] Contracts typecheck 已通过过完整基线。
- [x] Desktop typecheck 已通过过完整基线。
- [x] Scheduler smoke 当前基线为 426/426 通过。
- [x] Code / artifact smoke 为 15/15。
- [x] Execution Engine smoke 为 10/10。
- [x] Dataflow smoke 为 6/6。
- [x] `git diff --check` 已通过。

> 注：本文件创建前，最近一次尝试继续抽离 `nodeInputBuilders.ts` 时曾短暂删掉 Scheduler 中仍存在的 `commandOf/commandTimeoutOf` 导入，导致一次 desktop typecheck 失败；随后已恢复导入。该抽离目前处于“已建立 Registry、仍需进一步清理旧分支”的中间态，详见任务 `RUNTIME-03`。

## 3. 未完成工作总表

状态定义：

- `TODO` = 尚未开始。
- `WIP` = 已有代码基础，但仍需完成收口/验证。
- `BLOCKED` = 依赖其它任务完成后再做。
- `DONE` = 已完成并有对应验证。

### RUNTIME — 运行时与数据流

| ID | 状态 | 任务 | 主要范围 | 可否并行 |
|---|---|---|---|---|
| RUNTIME-01 | DONE | 稳定 NodeRunInput contract | `packages/contracts/src/runtime.ts` | — |
| RUNTIME-02 | DONE | WorkflowDataContext 数据流 | scheduler / contracts / smoke | — |
| RUNTIME-03 | DONE | 完成 NodeInputBuilderRegistry 抽离 | `scheduler.ts` + `nodeInputBuilders.ts` | 可与 UI 并行 |
| RUNTIME-04 | DONE | 统一 Runtime State | variables / artifacts / execution state | 等 RUNTIME-03 |
| RUNTIME-05 | DONE | 统一 Executor 生命周期 | start/progress/settle/cancel | 可并行 |
| RUNTIME-06 | TODO | Executor plugin 扩展点 | 第三方 executor 注册 | 等 RUNTIME-05 |
| RUNTIME-07 | DONE | NodeOutcome / artifact 持久化边界 | runStore / resume | 可并行 |
| RUNTIME-08 | TODO | 运行事件标准化 | started/progress/settled/error | 等 RUNTIME-05 |
| RUNTIME-09 | WIP | Run / Node / Artifact 调试信息统一 | logs + metadata | BLOCKED |

### VARIABLES — 变量、引用与结构化数据

| ID | 状态 | 任务 | 主要范围 | 可否并行 |
|---|---|---|---|---|
| VAR-01 | DONE | `{{...}}` 模板解析 | `nodeTemplate.ts` | — |
| VAR-02 | DONE | 上游限制 / 引用校验 | `nodeTemplate.ts` + scheduler | — |
| VAR-03 | DONE | outputVars 声明与硬约束 | `outputConstraint.ts` | — |
| VAR-04 | DONE | structured outputs 写入 NodeOutcome | scheduler | — |
| VAR-05 | TODO | 明确“运行时变量表”与“节点 outputs”的关系 | runtime contract | 可并行 |
| VAR-06 | DONE | 统一全局输入变量 / 触发器输入变量 | automation + runtime（`{{trigger.*}}` 名字空间 + scheduler 预展开） | — |
| VAR-07 | TODO | 支持更完整的路径表达式 | nested object / arrays | 可并行 |
| VAR-08 | TODO | 变量候选 UI 完整覆盖 | NodeInspector / ParamField | 可与 Runtime 并行 |
| VAR-09 | TODO | 变量引用错误的统一诊断模型 | contract + UI | 依赖 VAR-05 |

### EXECUTOR — 节点执行器

| ID | 状态 | 任务 | 主要范围 | 可否并行 |
|---|---|---|---|---|
| EXEC-01 | DONE | NodeExecutor interface | `executorRegistry.ts` | — |
| EXEC-02 | DONE | Executor Registry | `executorRegistry.ts` | — |
| EXEC-03 | DONE | ExecutionContext 解耦 | `executionContext.ts` | — |
| EXEC-04 | DONE | CommandExecutor | command runner | — |
| EXEC-05 | DONE | CodeExecutor | code runner | — |
| EXEC-06 | TODO | Conversation/AgentExecutor | runner 内模型会话逻辑 | 可并行 |
| EXEC-07 | TODO | BranchExecutor / interactive executor 边界 | branch wait/resume | 依赖 RUNTIME-05 |
| EXEC-08 | TODO | TriggerExecutor 边界 | automation trigger | 可并行 |
| EXEC-09 | TODO | Executor 错误分类 | user error / runtime error / provider error | 可并行 |
| EXEC-10 | TODO | Executor capability metadata | input/output/artifact/progress/cancel | 依赖 EXEC-09 |

### SCHEDULER — 调度器

| ID | 状态 | 任务 | 主要范围 | 可否并行 |
|---|---|---|---|---|
| SCHED-01 | DONE | 就绪即派发 | `scheduler.ts` | — |
| SCHED-02 | DONE | 并发上限 | scheduler | — |
| SCHED-03 | DONE | failure / skip propagation | scheduler | — |
| SCHED-04 | DONE | cancellation | scheduler | — |
| SCHED-05 | DONE | branch / unselected | scheduler | — |
| SCHED-06 | DONE | loop / rewind | scheduler | — |
| SCHED-07 | DONE | resume | scheduler / runStore | — |
| SCHED-08 | DONE | Scheduler 进一步缩小职责 | prompt/input/output/execute 全部下沉 | 依赖 RUNTIME-03 |
| SCHED-09 | DONE | Executor Registry 完全接管执行分派 | 去掉残留 kind 分支 | 依赖 EXEC |
| SCHED-10 | DONE | Scheduler state machine 文档化 | ready/running/awaiting/settled | 可并行 |
| SCHED-11 | TODO | scheduler smoke 拆成稳定测试套件 | 将超大 smoke 按主题拆分 | 可并行 |

### WORKFLOW — 工作流模型与编辑器

| ID | 状态 | 任务 | 主要范围 | 可否并行 |
|---|---|---|---|---|
| WF-01 | DONE | 通用 WorkflowDoc | contracts/workflow.ts | — |
| WF-02 | DONE | Edge = dependency source of truth | workflow.ts | — |
| WF-03 | DONE | Branch option = edge | workflow.ts / scheduler | — |
| WF-04 | DONE | Trigger node 基础模型 | nodeType / workflow | — |
| WF-05 | DONE | 工作流输入/输出 schema | WorkflowDoc input/output contract | — |
| WF-06 | DONE | 工作流版本 / schemaVersion | import/export compatibility | — |
| WF-07 | TODO | 子工作流 / nested workflow | branch/flow composition | 依赖 runtime |
| WF-08 | DONE | Workflow import/export | share / backup / validation | — |
| WF-09 | DONE | Workflow validation report | 图错误、类型缺失、引用错误 | — |
| WF-10 | WIP | Workflow editor UX 收口 | 节点、边、变量、触发器配置 | 可与 runtime 并行 |

### AUTOMATION — 自动化与触发器

| ID | 状态 | 任务 | 主要范围 | 可否并行 |
|---|---|---|---|---|
| AUTO-01 | DONE | Trigger contract | manual/schedule/file/event/webhook | — |
| AUTO-02 | DONE | automationRunner 基础路径 | 触发 → workflow run | — |
| AUTO-03 | DONE | debounce 基础能力 | file/event 合并 | — |
| AUTO-04 | DONE | active-run 防重入 | 同一自动化运行中跳过 | — |
| AUTO-05 | DONE | Schedule trigger 完整化 | cron 注册/恢复/状态 | 可并行 |
| AUTO-06 | DONE | File watcher 完整化 | watcher 生命周期、路径规则 | 可并行 |
| AUTO-07 | DONE | Event trigger 完整化 | hook/event matcher | 可并行 |
| AUTO-08 | TODO | Webhook trigger | 外部 HTTP 入口 | 依赖服务端能力 |
| AUTO-09 | DONE | Automation dashboard | enabled/running/last run/error | 可并行 |
| AUTO-10 | DONE | Trigger payload schema | 让触发事件可以结构化进入变量系统（`{{trigger.*}}`） | — |

### UI — 工作流 / 自动化界面

| ID | 状态 | 任务 | 主要范围 | 可否并行 |
|---|---|---|---|---|
| UI-01 | DONE | NodeInspector 基础配置 | 参数、能力、触发器等 | — |
| UI-02 | DONE | 变量插入基础 UI | `useRefOptions` / ParamField | — |
| UI-03 | DONE | 输出变量配置 UI | outputVars | — |
| UI-04 | DONE | Runtime data inspector | 查看某次运行的 input/output/artifacts | 可独立开发 |
| UI-05 | DONE | Node execution status | queued/running/success/failed/skipped/cancelled（含 queued 入队事件） | — |
| UI-06 | DONE | Progress rendering | workflow.node.progress | 可独立开发 |
| UI-07 | DONE | Artifact viewer | 文件 / 数据 / 外部 URI | 依赖 artifact contract |
| UI-08 | DONE | Run history panel | 每次 workflow run 的完整记录（RunHistorySection + `runs.history` IPC） | — |
| UI-09 | DONE | Automation management UI | trigger 配置、启停、执行历史（AutomationRunSection 消费 `automation.statusAll`） | — |
| UI-10 | DONE | Variable picker 增强 | outputs / params / artifacts / trigger payload | 依赖 VAR-05/06 |

### PROVIDER / SKILL / TOOL — 能力映射

| ID | 状态 | 任务 | 主要范围 | 可否并行 |
|---|---|---|---|---|
| CAP-01 | DONE | 节点 params 中 skills / MCP / plugins | runtime input 已有统一字段 | — |
| CAP-02 | DONE | Renderer skill/provider/project candidates | useRefOptions | — |
| CAP-03 | DONE | Skill → workflow node capability model | 哪些节点能使用哪些 skill | 可并行 |
| CAP-04 | DONE | MCP capability declaration | executor / node type 所需 MCP | 依赖 CAP-03 |
| CAP-05 | DONE | Plugin capability discovery | plugin 提供的 executor / node / skill | 依赖 CAP-03 |
| CAP-06 | DONE | Provider capability compatibility check | provider/model 是否满足节点要求 | 可并行 |
| CAP-07 | TODO | “学术能力”从 core 抽离 | literature search/download/transcription 不进入 core | 依赖 workflow executor |
| CAP-08 | DONE | 第三方 skill 安装/映射测试 | 真实插件场景验证 | 依赖 CAP-03/05 |

## 4. 需要从 Core 中继续拆出的旧业务能力

这些能力原则上不应该继续作为 Mcode 核心流程里的固定逻辑，而应该逐渐成为 workflow/automation 可以调用的能力：

- [ ] 文献搜索。
- [ ] 文献下载与 OA resolver chain。
- [ ] PDF → Markdown 转录。
- [ ] DOI / arXiv / Crossref / OpenAlex 等学术检索能力。
- [ ] 引用验证。
- [ ] 文献整理 / 去重 / 入库。
- [ ] 学术写作流水线。
- [ ] 固定的“search / read / write / review / code”学术流程。

拆分原则：核心只提供“Agent + Workflow + Automation + Execution + Data/Artifact + Persistence”，具体业务通过节点类型、技能、MCP、插件、Code/Command 等组合。

## 5. 代码结构目标

目标依赖方向：

```text
contracts
  ↑
workflow / node definitions
  ↑
scheduler
  ↑
input builders + execution engine
  ↑
executor registry
  ├── Agent/Conversation
  ├── Code
  ├── Command
  ├── Branch
  ├── Trigger
  └── plugin executors

renderer
  └── consumes contracts/events, does not own execution semantics
```

必须保持的原则：

1. Scheduler 决定“什么时候能跑”，Executor 决定“怎么跑”。
2. Scheduler 不知道具体 executor 的实现细节。
3. Renderer 不成为第二套 workflow 语义引擎。
4. `WorkflowDoc.edges` 是依赖唯一真相。
5. `NodeRunInput` 是稳定输入契约，host-only 的 AbortSignal / progress 不进入 contracts。
6. `NodeOutcome` 是统一输出契约。
7. `outputVars` 与 `{{...}}` 引用继续共用现有实现，不再创造第二套变量语法。
8. Artifact 使用稳定引用，不把大文件内容塞进普通 runtime event。
9. 可分享的 workflow 在缺少某节点类型时仍然可以打开/保存，运行时再明确失败。
10. 所有重大重构必须有 smoke / typecheck 回归。

## 6. 并行开发任务分配

建议同时开多个对话时按下面的“文件边界”划分。原则是：**不同对话尽量不改同一个文件。**

### 对话 A — Runtime / Scheduler

认领：`RUNTIME-*` + `SCHED-*` + `EXEC-*`。

核心目标：完成 RuntimeContext、InputBuilder、Executor Registry、Outcome、resume/state 的最终收口。

禁止同时大改 Renderer。对话 A 主要负责：

```text
scheduler.ts
executionContext.ts
executionEngine.ts
executorRegistry.ts
nodeInputBuilders.ts
codeExecutor.ts
commandExecutor.ts
runStore.ts
```

### 对话 B — Workflow UI

认领：`UI-*` + `WF-09/10`。

核心目标：让用户能直观看见并配置变量、输入输出、执行状态、进度和 artifacts。

主要文件：

```text
renderer/components/settings/workflows/*
renderer/components/chat/WorkflowStepCard.tsx
renderer/stores/sessionStore.ts
```

### 对话 C — Automation

认领：`AUTO-*`。

核心目标：把工作流真正变成 n8n 风格的“事件 → 自动运行”，并做好启停、状态、去重、历史。

主要文件：

```text
automationRunner.ts
automation / trigger 相关 contracts
automation UI
```

### 对话 D — Capability / Skills / Plugins

认领：`CAP-*` + `VAR-08/10`。

核心目标：解决“一个节点到底能用哪些 skill / MCP / plugin / provider”的能力映射问题，同时保证这些能力可被插件扩展。

主要文件：

```text
nodeType.ts
plugin 相关 contracts
useRefOptions.ts
NodeInspector.tsx
```

### 对话 E — Data / Artifact / Observability

认领：`RUNTIME-07/08/09` + `UI-04/07/08`。

核心目标：运行记录、artifact、日志、耗时、进度、历史查看统一起来。

### 对话 F — Legacy Domain Extraction

认领：第 4 节旧业务拆分任务。

核心目标：把文学/学术专用功能逐步移出 core，验证它们能不能由 workflow + skills + MCP + code/command 节点重新组合出来。

## 7. 推荐执行顺序

### 阶段 2A — Runtime 收口

- [x] NodeRunInput。
- [x] WorkflowDataContext。
- [x] ExecutionContext。
- [x] Executor Registry。
- [x] Code / Command Executor。
- [x] 完成 NodeInputBuilderRegistry 清理。（PAR-A，2026-09-18）
- [x] 收口 Runtime State / variables / artifacts。（PAR-B，2026-09-18）
- [x] 收口 executor lifecycle。（PAR-A，2026-09-18）

### 阶段 2B — 可观察性

- [ ] 每个 NodeRun 有稳定 run identity。
- [ ] started / progress / settled 统一事件。
- [ ] execution timing 统一。
- [ ] artifacts 统一。
- [ ] run snapshot 与历史记录统一。

### 阶段 3 — Workflow UX

- [ ] 用户能配置输入变量。
- [ ] 用户能配置输出变量。
- [ ] 用户能插入上游变量。
- [ ] 用户能查看结构化输出。
- [ ] 用户能查看 artifact。
- [ ] 用户能查看单次运行全过程。

### 阶段 4 — Automation

- [ ] schedule。
- [ ] file watcher。
- [ ] event hook。
- [ ] webhook。
- [ ] 自动化状态 / 历史。

### 阶段 5 — Extension Platform

- [ ] plugin executor。
- [ ] custom node type。
- [ ] custom skill。
- [ ] MCP capability mapping。
- [ ] workflow import/export。
- [ ] versioning。

### 阶段 6 — Domain Extraction

- [ ] 抽离文献搜索。
- [ ] 抽离下载。
- [ ] 抽离 PDF 转录。
- [ ] 抽离学术写作流程。
- [ ] 用真实工作流复现原来的学术场景。

## 8. 完成判据

一个阶段不能只以“代码写了”为完成标准，而要同时满足：

- TypeScript typecheck 通过。
- 对应 smoke test 通过。
- 不破坏已有 scheduler 基线。
- 不新增第二套变量 / workflow 语义。
- 能从真实用户路径跑通至少一个完整场景。
- 新增扩展点时不需要回到 Scheduler 中添加新的硬编码分支。

当前已知回归基线（2026-09-18 第二轮并行整合门，run-all-smokes **33 套件 0 失败**；第一轮为 29 套件，新增 4 个）：

```text
Scheduler smoke        426/426
Execution Engine smoke  14/14（含 setDefault 4 条新增断言）
Dataflow smoke           6/6
Code/Artifact smoke     15/15
Command runner smoke    33/33
Automation smoke       135/135
Capability smoke        25/25
Runtime state smoke     51/51
Run store smoke         20+14/14
Workflow view smoke    478/478
Session store smoke     70/70
Longtask smoke          79/79（新增）
Memory smoke            60/60（新增）
Monitoring smoke        29/29（新增）
Workflow validation     29/29（新增）
Contracts typecheck       PASS
Desktop typecheck         PASS
```

## 9. 当前工作快照

截至本路线图建立时，正在进行的工作重点是：

> **把“节点输入如何构造”和“节点如何执行”都从 Scheduler 进一步抽象出去，形成真正可扩展的 workflow runtime。**

近期新增/修改的关键文件包括：

```text
packages/contracts/src/runtime.ts
packages/contracts/src/nodeTemplate.ts
packages/contracts/src/outputConstraint.ts
apps/desktop/src/main/orchestration/executionContext.ts
apps/desktop/src/main/orchestration/executionEngine.ts
apps/desktop/src/main/orchestration/executorRegistry.ts
apps/desktop/src/main/orchestration/nodeInputBuilders.ts
apps/desktop/src/main/orchestration/codeExecutor.ts
apps/desktop/src/main/orchestration/commandExecutor.ts
apps/desktop/src/main/orchestration/artifactRefs.ts
apps/desktop/scripts/code-runner-smoke/
apps/desktop/scripts/dataflow-smoke/
apps/desktop/scripts/execution-engine-smoke/
apps/desktop/scripts/scheduler-smoke/
```

## 10. 对话协作规则

1. 开新对话后，先读取本文件，找到自己认领的任务 ID。
2. 只修改自己任务范围内的核心文件。
3. 修改公共 contracts 前，要先确认是否会影响其它任务。
4. 完成一个任务后，在本文件对应行更新状态，并增加必要的测试说明。
5. 不要为了“顺手重构”去改其它任务的模块。
6. 两个对话如果发现必须同时修改同一个核心文件，应先把共享接口收口，再分别继续。
7. 如果上下文快满了，在当前对话最后明确写出“下次从哪个任务 ID 继续”。
8. Git working tree 可以共享，但不要同时对同一个文件进行大块编辑。

## 11. 第一批推荐直接并行开的任务

当前最适合马上拆给多个对话的是：

```text
A  RUNTIME-03   完成 NodeInputBuilderRegistry，彻底删除 scheduler 中重复的 Code/Command 输入构造
B  UI-04/05/06  Workflow Runtime Inspector + 节点状态 + Progress
C  AUTO-05/06   Schedule/File 自动化生命周期完整化
D  CAP-03/06     Skill/Provider/Node capability mapping
E  RUNTIME-07    Run / Outcome / Artifact persistence boundary
```

依赖关系：

```text
RUNTIME-03
   ↓
RUNTIME-04 → RUNTIME-05 → RUNTIME-06
      ↓          ↓
    VAR-05     UI-04/05/06
      ↓
    VAR-06 → AUTO-10

CAP-03 → CAP-04/CAP-05/CAP-06

RUNTIME-07 ─────────→ UI-08
```

其中 A/B/C/D/E 可以并行启动，但 **A 与 E 都属于 Runtime 区域，不要同时大改 `scheduler.ts` / `runStore.ts` 的同一段代码**。

## 8. 五个可并行执行任务：直接复制给新的对话

这一节是给“并行子对话 / 并行 Agent”直接使用的任务说明。

### 并行总协议（每个任务都必须遵守）

> **你现在执行的是一个并行任务，不是独立重构整个项目。**
>
> 你正在和其他 Agent 同时开发同一个 Mcode 项目。其他 Agent 会同时修改其它模块。你的首要目标不是“顺手把整个项目都改好”，而是只完成你被分配的任务，并严格尊重文件所有权。
>
> 规则：
> 1. 开始前先读取根目录的 `MCode-Development-Roadmap.md`，确认当前任务 ID、已完成项和其它并行任务。
> 2. 先检查当前工作区实际状态，不假设其它任务没有修改代码。
> 3. **只修改本任务允许的文件。** 其它文件即使看起来可以顺手优化，也不要动。
> 4. 如果必须修改其它任务拥有的文件才能继续，先停止扩散修改，把原因记录在最终报告里。
> 5. 不重写已经工作的旧逻辑；优先抽离、复用已有 contract、registry、helper 和测试。
> 6. 每完成一个逻辑单元就运行针对性 smoke/typecheck；不要最后才一次性发现问题。
> 7. 不删除别的任务新增的代码，不回滚别的任务的修改。
> 8. 不创建临时补丁脚本留在仓库中。
> 9. 完成后必须报告：修改文件、完成内容、测试结果、未完成事项、是否发现与其他并行任务的潜在冲突。
> 10. **不要把“我建议以后再做”当成已完成。** 文档状态必须区分 DONE / WIP / BLOCKED。
>
> 推荐工作方式：每个并行任务使用独立 Git branch + worktree。若当前环境不能建立独立 worktree，则至少严格遵守下面的“文件所有权”，避免两边同时写同一个文件。

---

### TASK A — Runtime / Scheduler 解耦

**任务 ID：`PAR-A / RUNTIME-03 / SCHED-08 / SCHED-09`**

**目标：**继续完成当前 Scheduler → NodeInputBuilder → ExecutionEngine 的职责拆分，让 Scheduler 逐渐只负责流程控制，不再知道越来越多的具体节点类型。

**允许修改的文件：**

- `apps/desktop/src/main/orchestration/scheduler.ts`
- `apps/desktop/src/main/orchestration/nodeInputBuilders.ts`
- `apps/desktop/src/main/orchestration/executionContext.ts`
- `apps/desktop/src/main/orchestration/executorRegistry.ts`
- `apps/desktop/src/main/orchestration/executionEngine.ts`
- 与本任务直接对应的 smoke/test 文件。

**不要修改：**

- Renderer UI 文件。
- `automationRunner.ts`。
- `packages/contracts/src/workflow.ts` 的业务模型。
- `packages/contracts/src/outputConstraint.ts` 的变量语义。

**重点：**

- 完成 `NodeInputBuilderRegistry` 抽离，删掉 Scheduler 中已经由 builder 负责的旧分支。
- 确保新增 NodeInputBuilder / Executor 时，Scheduler 不需要继续增加 `kind === xxx` 分支。
- 保持 branch / trigger / conversation 等流程语义不被错误地塞进普通 executor。
- 保证 `NodeRunInput → ExecutionContext → NodeExecutor` 的输入边界稳定。
- 保持现有 426/426 scheduler smoke 等行为不变。

**完成标准：**

- TypeScript typecheck 通过。
- scheduler smoke 全部通过。
- execution-engine / dataflow / code-runner smoke 不回归。
- Scheduler 中不再保留已经被 Builder/Registry 接管的重复参数翻译逻辑。

**给 Agent 的额外提醒：**当前 `nodeInputBuilders.ts` 是最近刚加入的 WIP，不要重新设计一套新的输入协议；继续现有 `NodeRunInput` / `WorkflowDataContext` 设计。

---

### TASK B — Runtime State / Persistence / Run Resume

**任务 ID：`PAR-B / RUNTIME-04 / RUNTIME-07 / RUNTIME-09 / SCHED-10`**

**目标：**把“运行时状态”从零散的 `RunState / NodeOutcome / artifact / resume` 结构继续收口，形成清晰的运行记录与恢复边界。

**允许修改的文件：**

- `apps/desktop/src/main/orchestration/runStore.ts`
- `apps/desktop/src/main/orchestration/executionContext.ts`（仅在需要扩充 host runtime metadata 时）
- `packages/contracts/src/runtime.ts`（仅处理 Runtime State / persistence contract）
- `packages/contracts/src/nodeType.ts`（只有在 NodeOutcome contract 确实必须扩展时）
- `apps/desktop/scripts/execution-engine-smoke/`
- 新增专用 runtime-state smoke/test 文件。

**不要修改：**

- `scheduler.ts` 的调度算法。
- Renderer workflow 编辑器。
- `automationRunner.ts`。
- Executor 的实际进程实现。

**重点：**

- 明确 `runId / sessionId / nodeId` 的层级关系。
- 明确“运行状态”“节点结局”“持久化快照”“最终结果”的区别。
- 明确 artifact 是结果引用还是状态本身，避免同一数据保存两份真相。
- 检查 resume 后的 `settled / awaiting / entry / rounds / picks / outcomes` 是否有重复语义。
- 为未来 run history / debugging / crash recovery 留出稳定边界。
- 任何 contract 扩展都必须向后兼容已有旧存档。

**完成标准：**

- 能用一个清晰的 contract 描述“一次 workflow run 现在是什么状态”。
- 旧 run snapshot 可以继续读取。
- resume 相关 smoke 通过。
- 不改变现有 scheduler 的实际调度行为。

---

### TASK C — Workflow Editor / Variable / Runtime Data UI

**任务 ID：`PAR-C / UI-04 / UI-05 / UI-06 / UI-07 / UI-10 / WF-10`**

**目标：**把已经存在于 Runtime 的结构化数据真正呈现给用户，让 Workflow 编辑器和运行结果界面能看到 input / output / artifacts / status / progress，而不是只有一段 summary。

**允许修改的文件：**

- `apps/desktop/src/renderer/components/settings/workflows/`
- `apps/desktop/src/renderer/components/chat/WorkflowStepCard.tsx`
- `apps/desktop/src/renderer/components/chat/` 下与 workflow result/progress 直接相关的组件。
- `apps/desktop/src/renderer/stores/sessionStore.ts` 中与 workflow runtime 展示直接相关的状态。
- 对应 renderer i18n 文件。

**不要修改：**

- `scheduler.ts`。
- `runner.ts` 的执行逻辑。
- `automationRunner.ts`。
- contracts 的 Runtime 语义；若发现 contract 缺字段，只在报告中指出。

**重点：**

- Runtime data inspector：查看节点收到的 `input.data`、结构化 `outputs` 和 `artifacts`。
- Node execution status：queued / running / success / failed / skipped / cancelled / unselected。
- Progress：消费 `workflow.node.progress`。
- Artifact viewer：至少把 file / directory / data 引用以稳定方式展示。
- Variable picker：让用户能够从上游 output / params / artifacts 中选值，而不是手打 `{{...}}`。
- 保持现在的 `useRefOptions` / `insertables` 思路，不设计第二套变量系统。

**完成标准：**

- 编辑器能配置已有变量。
- 运行后用户能看见节点状态与进度。
- structured output 不再只能靠 summary 猜。
- UI 不直接复制一套 parser；应该尽可能调用 contracts 的统一逻辑。

---

### TASK D — Automation / Trigger 平台化

**任务 ID：`PAR-D / AUTO-05 / AUTO-06 / AUTO-07 / AUTO-09 / AUTO-10`**

**目标：**把现有 automationRunner 从“已经能触发 workflow”继续发展成完整的后台自动化基础设施：schedule / file / event、状态、payload、运行监控。

**允许修改的文件：**

- `apps/desktop/src/main/orchestration/automationRunner.ts`
- `apps/desktop/src/main/orchestration/` 下与 trigger watcher / schedule / event subscription 直接相关的文件。
- 与自动化管理页面直接对应的 renderer 文件。
- 对应 automation smoke/test 文件。

**不要修改：**

- `scheduler.ts` 的核心算法。
- `executionEngine.ts` / executor implementations。
- Workflow editor 的基础变量 parser。

**重点：**

- Schedule trigger：cron 生命周期、启动恢复、启停、异常记录。
- File trigger：watcher 生命周期、glob/filter、debounce、失效处理。
- Event trigger：复用现有 hook/event contract，不重新定义另一套 event vocabulary。
- Trigger payload：结构化描述这次为什么被触发、携带了什么数据，为后续变量系统做准备。
- Automation dashboard：enabled / running / last run / last error 等事实状态。
- 保持已有 active-run 防重入语义。

**完成标准：**

- 自动化启动 / 停止 / 重启后的状态行为明确。
- trigger payload 可被后续 Runtime 使用。
- 不改变现有 `entry` → workflow run 的总体模型。
- 有针对性 smoke，覆盖至少 schedule/file/event 的关键生命周期。

---

### TASK E — Capability / Skill / MCP / Plugin 扩展体系

**任务 ID：`PAR-E / CAP-03 / CAP-04 / CAP-05 / CAP-06 / CAP-08 / WF-06 / WF-08`**

**目标：**把“节点到底能用什么能力”从目前的 params 字符串逐渐提升成可检查、可发现、可扩展的能力模型，同时为第三方节点/插件留接口。

**允许修改的文件：**

- `packages/contracts/src/nodeType.ts`
- `packages/contracts/src/provider.ts`
- `packages/contracts/src/plugin.ts` 或插件能力相关 contracts。
- `apps/desktop/src/main/orchestration/nodeTypes.ts`
- Renderer 中 capability / node-type configuration 的专用文件。
- 对应 smoke/test。

**不要修改：**

- `scheduler.ts` 的并发 / dependency 算法。
- `automationRunner.ts`。
- `codeRunner.ts` / `commandRunner.ts` 的执行细节。

**重点：**

- Skill 是否适用于某个 executor / provider。
- MCP capability 声明与节点需求之间的兼容性。
- Plugin 提供 node type / executor / skill 时如何发现与声明。
- Provider capability 与 node requirement 的兼容性检查。
- 不把“学术研究”重新写死进 core；“academic research”应该最终成为 skill / plugin / workflow 能力。
- 第三方 node type / executor 的发现必须继续沿用现有 registry 思路。

**完成标准：**

- 有一个可扩展的 capability 描述模型。
- 不满足 capability 时能在运行前或配置阶段给出明确诊断。
- 已有 Claude / Pi / Codex 不回归。
- 至少有一个 builtin + 一个 plugin/模拟 plugin 的能力检查 smoke。

---

## 9. 五个并行任务的启动顺序与文件冲突表

### 推荐同时启动

```text
PAR-A  Runtime/Scheduler
PAR-B  Runtime State/Persistence
PAR-C  Workflow UI
PAR-D  Automation
PAR-E  Capability/Plugin
```

### 文件所有权

| 文件/模块 | A | B | C | D | E |
|---|:---:|:---:|:---:|:---:|:---:|
| scheduler.ts | ✅ | ❌ | ❌ | ❌ | ❌ |
| nodeInputBuilders.ts | ✅ | ❌ | ❌ | ❌ | ❌ |
| executionEngine/executorRegistry | ✅ | ❌ | ❌ | ❌ | ❌ |
| runStore.ts | ❌ | ✅ | ❌ | ❌ | ❌ |
| runtime.ts | ❌ | ✅ | ❌ | ❌ | ✅* |
| workflow renderer | ❌ | ❌ | ✅ | ❌ | ✅* |
| automationRunner.ts | ❌ | ❌ | ❌ | ✅ | ❌ |
| nodeType.ts | ❌ | ❌ | ❌ | ❌ | ✅ |

`*` 表示尽量不要碰；只有 contract 真有缺口时才修改，并在报告中明确列出。

### 五个任务之间的依赖

```text
PAR-A ───────┐
PAR-B ───────┼──→ Phase 2 Runtime consolidation
PAR-C ───────┤
PAR-D ───────┤
PAR-E ───────┘

后续整合阶段：
Runtime + Variables + Automation + Capability
                ↓
      Nested Workflow / Subworkflow
                ↓
      Workflow marketplace / sharing
                ↓
      Academic functions completely extracted from core
```

**不要因为五个任务并行，就五个 Agent 都去碰 `scheduler.ts` / `runtime.ts` / `nodeType.ts`。这些共享核心文件必须有明确 owner。**

---

## 10. 可直接复制的五段提示词

### Prompt A

```text
你现在是 Mcode 并行开发任务 A（PAR-A）。
这是一个并行任务，不是让你独占整个项目，也不是让你顺手重构其它模块。

项目：D:\destop\work_space\work_for_reseach\mcode
先读取根目录 MCode-Development-Roadmap.md，尤其是第 8、9 节。

你的任务 ID：PAR-A / RUNTIME-03 / SCHED-08 / SCHED-09
任务：完成 Scheduler → NodeInputBuilder → ExecutionEngine 的职责解耦。

你拥有的文件：
- apps/desktop/src/main/orchestration/scheduler.ts
- apps/desktop/src/main/orchestration/nodeInputBuilders.ts
- apps/desktop/src/main/orchestration/executionContext.ts
- apps/desktop/src/main/orchestration/executorRegistry.ts
- apps/desktop/src/main/orchestration/executionEngine.ts
- 与本任务直接对应的 smoke/test 文件

严禁主动修改其它并行任务负责的模块，尤其是：
- runStore.ts
- automationRunner.ts
- renderer workflow UI
- academic/business logic

背景：当前 NodeRunInput + WorkflowDataContext + ExecutorRegistry 已经存在，code/command executor 也已经有。不要设计第二套输入协议。继续现有架构。

请完成：
1. 检查 nodeInputBuilders.ts 当前 WIP 状态。
2. 把 scheduler 中已经由 Builder 接管的 code/command 输入构造彻底去重。
3. 确保新增 executor/builder 时 Scheduler 不需要继续增加新的 kind 分支。
4. 保持 branch / trigger / conversation 的特殊流程语义正确，不要为了“统一”把它们错误塞进普通 executor。
5. 保留 NodeRunInput → ExecutionContext → NodeExecutor 的稳定边界。
6. 修复由你负责的类型或测试问题。
7. 运行 contracts typecheck、desktop typecheck，以及 scheduler / execution-engine / dataflow / code-runner smoke。

并行协作规则：
- 不要回滚其它 Agent 的修改。
- 如果发现其它 Agent 正在修改你拥有的文件，先读取实际内容再继续，不要按旧上下文覆盖。
- 不要为了方便修改别人的文件；真的需要时只报告冲突，不要扩散修改。

完成后报告：
- 修改了哪些文件
- 每个文件做了什么
- 测试结果
- 还有哪些 WIP
- 是否发现与 PAR-B/C/D/E 的冲突风险
```

### Prompt B

```text
你现在是 Mcode 并行开发任务 B（PAR-B）。
明确：这是并行任务。其它 Agent 正在同时开发 Mcode 的 Scheduler、UI、Automation、Capability 模块。不要重构整个项目。

项目：D:\destop\work_space\work_for_reseach\mcode
第一步读取 MCode-Development-Roadmap.md 第 8、9 节。

任务 ID：PAR-B / RUNTIME-04 / RUNTIME-07 / RUNTIME-09 / SCHED-10
目标：统一 Runtime State / persistence / resume 边界。

你拥有的文件：
- apps/desktop/src/main/orchestration/runStore.ts
- apps/desktop/src/main/orchestration/executionContext.ts（仅 host runtime metadata）
- packages/contracts/src/runtime.ts（仅 runtime state / persistence contract）
- packages/contracts/src/nodeType.ts（只有 NodeOutcome contract 确实需要扩展时）
- execution-engine/runtime-state smoke/test

不要修改：
- scheduler.ts 调度算法
- automationRunner.ts
- renderer workflow editor
- codeRunner.ts / commandRunner.ts

请重点解决：
1. runId / sessionId / nodeId 的层级关系。
2. RunState、NodeOutcome、snapshot、final result 各自负责什么。
3. artifact 是结果引用还是状态，避免两份真相。
4. resume 的 settled / awaiting / entry / rounds / picks / outcomes 是否存在重复语义。
5. 为 run history / debugging / crash recovery 留稳定边界。
6. 旧 snapshot 必须可读，不能破坏已有数据。

请优先小改动收口已有模型，不要创造第二套 Runtime Context。

测试：至少运行 contracts typecheck、desktop typecheck、resume/scheduler 相关 smoke，以及你新增的 runtime-state smoke。

如果发现 scheduler 或其它模块必须改才能完成，不要直接扩散修改；记录 BLOCKED 原因。

最终报告必须包含：文件、设计变化、兼容性、测试结果、冲突风险。
```

### Prompt C

```text
你现在是 Mcode 并行开发任务 C（PAR-C）。
这是并行开发。不要碰 Scheduler / Automation / Executor 的实现逻辑；其它 Agent 会同时修改这些地方。

项目：D:\destop\work_space\work_for_reseach\mcode
先读 MCode-Development-Roadmap.md 第 8、9 节。

任务 ID：PAR-C / UI-04 / UI-05 / UI-06 / UI-07 / UI-10 / WF-10
目标：把已有 runtime data 真正展示到 Workflow UI。

你拥有的范围：
- apps/desktop/src/renderer/components/settings/workflows/
- apps/desktop/src/renderer/components/chat/WorkflowStepCard.tsx
- 与 workflow result/progress 直接相关的 renderer chat 组件
- apps/desktop/src/renderer/stores/sessionStore.ts 中 workflow runtime 展示相关字段
- renderer i18n

不要修改：
- scheduler.ts
- runner.ts 执行逻辑
- automationRunner.ts
- contracts 的核心 Runtime 语义

已有能力：NodeRunInput.data 已包含 userInput / upstreamText / upstreamOutputs / upstreamArtifacts；NodeOutcome 有 outputs / artifacts / execution；已经有 workflow.node.progress。

请完成：
1. Runtime data inspector。
2. Node execution status 展示：queued/running/success/failed/skipped/cancelled/unselected。
3. workflow.node.progress 展示。
4. artifact viewer 基础能力。
5. Variable picker 增强：outputs / params / artifacts / trigger payload。
6. 继续复用现有 {{...}}、useRefOptions、insertables，不设计第二套变量语法。

不要为了 UI 方便在 renderer 自己复制 nodeTemplate/outputConstraint 的 parser；尽量调用现有 contract/helper。

测试：运行 desktop typecheck，以及你能执行的 renderer/workflow smoke。

如果发现 contract 缺少字段，不要擅自修改 runtime.ts；把缺口作为报告交给 PAR-B。

最终报告：UI 修改、交互变化、测试、与 PAR-A/B/D/E 的潜在冲突。
```

### Prompt D

```text
你现在是 Mcode 并行开发任务 D（PAR-D）。
这是一个独立的并行任务。其它 Agent 正在修改 Runtime、UI、Capability，不要重构整个项目。

项目：D:\destop\work_space\work_for_reseach\mcode
先读取 MCode-Development-Roadmap.md 第 8、9 节。

任务 ID：PAR-D / AUTO-05 / AUTO-06 / AUTO-07 / AUTO-09 / AUTO-10
目标：把 Automation / Trigger 做成完整后台基础设施。

你拥有的主要文件：
- apps/desktop/src/main/orchestration/automationRunner.ts
- 与 schedule/file/event watcher 直接相关的 orchestration 文件
- automation management renderer 文件
- automation smoke/test

不要修改：
- scheduler.ts 核心调度算法
- executionEngine.ts / executor implementations
- nodeTemplate.ts 变量 parser

已有模型：Trigger 节点 + WorkflowDoc.trigger；automationRunner 已经可以 trigger → startWorkflowRun，并有 debounce、active-run 防重入、entry payload。

请完成：
1. schedule cron 生命周期、启动恢复、启停、错误记录。
2. file watcher 生命周期、glob/filter、debounce/失效处理。
3. event trigger 继续复用现有 hook/event contract。
4. trigger payload 结构化，明确“为什么触发、携带什么”。
5. automation dashboard 的事实状态：enabled/running/last run/last error。
6. 保持 entry → workflow run 语义不变。

不要重新定义一套 Trigger 类型。如果发现 contracts 缺字段，不要扩散修改；报告缺口。

测试：automation smoke + desktop typecheck。

最终报告必须说明每种 trigger 的生命周期、错误处理、测试结果，以及与 PAR-B/C 的数据边界。
```

### Prompt E

```text
你现在是 Mcode 并行开发任务 E（PAR-E）。
这是并行开发任务。其它 Agent 正在同时处理 Runtime、Scheduler、UI、Automation。不要碰这些模块的执行逻辑。

项目：D:\destop\work_space\work_for_reseach\mcode
第一步读取 MCode-Development-Roadmap.md 第 8、9 节。

任务 ID：PAR-E / CAP-03 / CAP-04 / CAP-05 / CAP-06 / CAP-08 / WF-06 / WF-08
目标：建立可扩展的 Capability / Skill / MCP / Plugin 能力模型。

主要拥有文件：
- packages/contracts/src/nodeType.ts
- packages/contracts/src/provider.ts
- packages/contracts/src/plugin.ts 或 plugin capability contracts
- apps/desktop/src/main/orchestration/nodeTypes.ts
- capability/node-type renderer 文件
- capability smoke/test

不要修改：
- scheduler.ts
- automationRunner.ts
- codeRunner.ts / commandRunner.ts

背景：当前 NodeInput 已有 skills / mcpServerNames / pluginNames / providerId；node types 已经是 registry/catalog 模型；useRefOptions 已经提供候选项。不要推翻这些基础设施。

请完成：
1. Skill 与节点/executor/provider 的适用性模型。
2. MCP capability declaration 与节点 requirement 的兼容性检查。
3. Plugin 提供 node type / executor / skill 时的 capability discovery。
4. Provider capability compatibility check。
5. 运行前/配置阶段的清晰诊断。
6. 为第三方 executor/node type 保留扩展接口。
7. 不把“学术研究”重新写死进 core；academic research 应该最终成为 skill/plugin/workflow 能力。

不要因为 capability 模型看起来不完整就同时重构 scheduler。先建立 contracts + discovery + validation 的边界。

测试：contracts typecheck、desktop typecheck，以及至少一个 builtin + 一个 plugin/mock plugin capability smoke。

最终报告：contract 变化、兼容性、测试、扩展方式、和 PAR-A/B/C/D 的潜在冲突。
```

## 11. 并行开发后的整合规则

五个 Agent 可以同时工作，但**合并不是五个 Agent 任意互相覆盖**。

推荐整合顺序：

```text
PAR-A / PAR-B
     ↓
先稳定 Runtime / Scheduler / Persistence 边界
     ↓
PAR-D / PAR-E
     ↓
稳定 Automation / Capability contracts
     ↓
PAR-C
     ↓
最后让 UI 消费稳定后的 Runtime contracts
```

如果五个任务全部已经有独立 commit，再由一个“Integration Agent”负责：

1. 读取五个任务报告。
2. 检查 diff 是否跨越文件所有权边界。
3. 按依赖顺序合并。
4. 解决 contract 冲突，而不是简单选择一边覆盖另一边。
5. 重新执行完整验证：contracts typecheck、desktop typecheck、scheduler smoke、code-runner smoke、execution-engine smoke、dataflow smoke、automation smoke、capability smoke。
6. 更新本文件，把对应任务从 TODO/WIP 改成 DONE 或 BLOCKED。

**重要：当前这个根目录是共享工作区时，逻辑上的“并行”不等于 Git 层面的物理隔离。五个 Agent 最好使用不同 worktree；否则至少遵守本节文件所有权。**


---

## 12. 优化版并行开发协议（覆盖前述并行分配中的冲突）

> **本节为当前并行开发的执行基准。** 如第 6～11 节与本节存在冲突，以本节为准；旧内容保留作为历史记录和任务来源参考，不再作为文件所有权的最终依据。

### 12.1 为什么要调整

当前五并行方案的任务主题本身没有问题，但原方案存在四类实际冲突：

1. **职责和文件 owner 没完全对齐。** `runner.ts`、`nodeTemplate.ts`、部分 smoke/test 没有明确归属，而它们实际上处在 Runtime 主链上。
2. **A/B 对 `executionContext.ts` 有交叉修改权。** 这会让 Runtime 类型在两个并行任务里同时漂移。
3. **B/E 对 contracts 有交叉修改权。** `runtime.ts` / `nodeType.ts` 一旦同时改，最容易形成“各自 typecheck 通过、合并后失败”。
4. **“五个任务都能立即开工”不等于“五个任务都适合同时大改核心接口”。** UI、Automation、Capability 可以先做消费侧工作，但共享 contract 必须先冻结。

因此后续采用：

```text
主题并行
  +
文件单 owner
  +
共享接口冻结
  +
跨任务修改走 Interface Proposal
  +
固定 Integration Gate
```

### 12.2 五个任务重新定义

#### PAR-A — Core Runtime / Scheduler / Execution

**目标：**完成 `Workflow → NodeInputBuilder → ExecutionContext → ExecutionEngine → Executor` 主链收口。

**Owner：**

```text
apps/desktop/src/main/orchestration/scheduler.ts
apps/desktop/src/main/orchestration/nodeInputBuilders.ts
apps/desktop/src/main/orchestration/executionContext.ts
apps/desktop/src/main/orchestration/executionEngine.ts
apps/desktop/src/main/orchestration/executorRegistry.ts
apps/desktop/src/main/orchestration/runner.ts   # Runtime glue 由 A 统一维护
apps/desktop/src/main/orchestration/codeExecutor.ts
apps/desktop/src/main/orchestration/commandExecutor.ts
apps/desktop/src/main/orchestration/artifactRefs.ts
apps/desktop/src/main/orchestration/schedulerPrompt.ts
apps/desktop/src/main/orchestration/contextInherit.ts
apps/desktop/scripts/*-smoke/               # 与 Runtime 主链直接对应的 smoke
packages/contracts/src/nodeTemplate.ts      # 只负责 Runtime 已使用的模板语义；语义扩展需提案
```

**原则：**A 是唯一可以同时触碰 Scheduler、InputBuilder、ExecutionContext、ExecutionEngine、Runner glue 的任务。这样可以彻底避免“Scheduler 已经抽出来了，但真实 Runner 还保留另一套执行路径”。

**禁止：**修改 `automationRunner.ts`、Workflow Renderer、RunStore 持久化模型、Capability 领域模型。

**完成标志：**

```text
新增 builder / executor
        ↓
Registry 注册
        ↓
Scheduler 无需新增 kind 分支
        ↓
NodeRunInput → ExecutionContext → Executor
        ↓
现有 smoke 全通过
```

#### PAR-B — Runtime State / Persistence / Resume

**目标：**统一 Run / NodeRun / Outcome / Snapshot / Resume 的持久化边界。

**Owner：**

```text
apps/desktop/src/main/orchestration/runStore.ts
packages/contracts/src/runtime.ts
apps/desktop/scripts/runtime-state-smoke/
apps/desktop/scripts/execution-engine-smoke/runtime-state-* # 如有专门案例
```

`executionContext.ts` **不再属于 B**。B 需要 host metadata 时，只能通过 Interface Proposal 请求 A 扩展；B 不直接编辑 A-owned runtime 文件。

**原则：**B 不能改调度算法，不能改 executor 实际执行过程。B 只定义“这次运行现在是什么状态、如何保存、如何恢复”。

**重点输出：**

```text
RunIdentity
  ├── runId
  ├── sessionId
  └── nodeId

RunState
  ├── lifecycle
  ├── awaiting
  ├── rounds
  ├── picks
  └── settled outcomes

NodeOutcome
  ├── status
  ├── summary
  ├── outputs
  ├── artifacts
  └── execution metadata

Snapshot
  └── 可恢复的最小事实集合
```

#### PAR-C — Workflow UX / Variables / Runtime Observability

**目标：**把 Runtime 已经稳定的 input / outputs / artifacts / status / progress / variables 完整暴露给用户。

**Owner：**

```text
apps/desktop/src/renderer/components/settings/workflows/**
apps/desktop/src/renderer/components/chat/WorkflowStepCard.tsx
apps/desktop/src/renderer/components/chat/*Workflow*
apps/desktop/src/renderer/stores/sessionStore.ts      # 仅 workflow UI 状态
apps/desktop/src/renderer/i18n/**                    # 对应 workflow 文案
```

**变量规则：**C 可以使用现有 `{{...}}`、`useRefOptions`、`insertables`；不允许创建第二套 parser。若发现 contract 缺字段，只提交 Interface Proposal 给 B/A，不直接修改 Runtime contract。

**原则：**C 是 Runtime 的消费者，不再承担 Runtime 语义定义。

#### PAR-D — Automation / Trigger Platform

**目标：**把 Trigger → Automation Runner → Workflow Run 做成可靠的后台运行基础设施。

**Owner：**

```text
apps/desktop/src/main/orchestration/automationRunner.ts
apps/desktop/src/main/orchestration/*watcher*
apps/desktop/src/main/orchestration/*schedule*
apps/desktop/src/main/orchestration/*automation*
packages/contracts/src/hook.ts
对应 automation renderer / smoke
```

**原则：**D 可以定义 trigger 的事实载荷，但不得重新定义 Workflow Runtime 的 RunState。需要保存运行状态时统一调用 B 的持久化边界。

#### PAR-E — Capability / Skill / Provider / MCP / Plugin

**目标：**把“节点需要什么能力”变成可声明、可发现、可诊断、可扩展的 capability model。

**Owner：**

```text
packages/contracts/src/nodeType.ts
packages/contracts/src/provider.ts
packages/contracts/src/plugin.ts
apps/desktop/src/main/orchestration/nodeTypes.ts
对应 capability / node-type renderer
对应 capability smoke/test
```

`runtime.ts` **不属于 E**。任何 capability 如果真的需要增加 runtime 字段，必须向 B 提 Interface Proposal，由 B 决定 contract 落点。

### 12.3 文件所有权最终表

| 核心区域 | A | B | C | D | E |
|---|:---:|:---:|:---:|:---:|:---:|
| `scheduler.ts` | ✅ | | | | |
| `nodeInputBuilders.ts` | ✅ | | | | |
| `executionContext.ts` | ✅ | | | | |
| `executionEngine.ts` | ✅ | | | | |
| `executorRegistry.ts` | ✅ | | | | |
| `runner.ts` | ✅ | | | | |
| `runStore.ts` | | ✅ | | | |
| `runtime.ts` | | ✅ | | | |
| workflow renderer | | | ✅ | | |
| `sessionStore.ts` workflow runtime view | | | ✅ | | |
| `automationRunner.ts` | | | | ✅ | |
| `hook.ts` | | | | ✅ | |
| `nodeType.ts` | | | | | ✅ |
| `provider.ts` | | | | | ✅ |
| `plugin.ts` | | | | | ✅ |
| `nodeTypes.ts` | | | | | ✅ |

### 12.4 共享 contracts 改动协议

共享 contract 不采用“两个 Agent 都能改”的方式，而采用 **Single Writer + Proposal**：

```text
发现缺字段
   ↓
提交 Interface Proposal
   ├── 为什么现有字段不够
   ├── 新字段最小形状
   ├── 谁消费
   ├── 是否向后兼容
   └── 对应 smoke
   ↓
Owner 修改 contract
   ↓
所有受影响任务重新 typecheck
   ↓
Proposal 标记 MERGED
```

Contract owner：

```text
runtime.ts    → B
nodeType.ts   → E
hook.ts       → D
nodeTemplate.ts Runtime 相关语义 → A；变量语义扩展先走 Proposal
provider.ts   → E
plugin.ts     → E
```

### 12.5 并行启动顺序优化

不是“五个 Agent 一起自由改”，而是分成 **1 个基础冻结窗口 + 5 条并行线 + 1 个整合门**。

```text
                 Interface Freeze
                       │
        ┌──────────────┼──────────────┐
        │              │              │
       PAR-A          PAR-B          PAR-E
        │              │              │
        └──────────────┼──────────────┘
                       │
              PAR-C / PAR-D
                       │
                 Integration Gate
                       │
                 Regression Gate
```

其中：

**Freeze：**先冻结现有 `NodeRunInput`、`WorkflowDataContext`、`WorkflowExecutionContext`、`NodeOutcome`、`RuntimeEvent` 的字段，不在并行开发第一轮随意改 shape。

**PAR-A / PAR-B / PAR-E：**可以同时启动，但各自只能写自己的 owner 文件。A 收口 Runtime 主链，B 收口 state，E 收口 capability。

**PAR-C：**可以马上做 UI，但只消费当前稳定字段；不要因为未来字段提前改 contract。

**PAR-D：**可以马上做 automation 生命周期，但 Run persistence、resume、outcome 统一调用 B 的边界。

**Integration Gate：**A/B/E 任一个改了共享 contract，C/D 必须重新跑受影响 typecheck / smoke，再继续后续工作。

### 12.6 任务依赖改成“接口依赖”，不要改成“文件等待”

推荐依赖图：

```text
                     Contracts
                ┌────────┼────────┐
                ↓        ↓        ↓
                A        B        E
                │        │        │
                │        └──┐     │
                │           │     │
                └──────┬────┘     │
                       ↓          │
                       C          D
                       │          │
                       └────┬─────┘
                            ↓
                     Integration Gate
```

真正的依赖是：

```text
A → runtime execution semantics
B → runtime state semantics
E → capability semantics
C → consume A/B/E outputs
D → trigger A + persist B
```

而不是：

```text
“等某个文件改完，我才能开始”
```

这样并行度更高，也更不容易造成整条流水线互相等待。

### 12.7 每个任务都必须有自己的 DoD + Cross-check

除原来的 typecheck / smoke 外，新增一条 **Cross-check**：

```text
PAR-A:
  Scheduler 中新增 kind 分支 = 0（除 Branch/Trigger 等流程语义特判）

PAR-B:
  旧 snapshot 可读取；resume 后 settled 节点不重复执行

PAR-C:
  renderer 不存在第二套 template/parser

PAR-D:
  trigger 不直接伪造新的 RunState；必须进入统一 run 入口

PAR-E:
  新 capability 不要求修改 Scheduler 的 kind 分支
```

每个任务最终报告固定为：

```text
TASK: PAR-X
STATUS: DONE | WIP | BLOCKED
FILES:
- ...
CHANGES:
- ...
TESTS:
- ...
INTERFACE PROPOSALS:
- ...
CROSS-TASK CONFLICTS:
- none | ...
NEXT:
- ...
```

### 12.8 当前仓库的特别处理

当前工作区已经存在一批未提交的 Runtime / UI / contract 修改，因此**第一轮并行任务不得假设仓库是 clean**。

启动每个 Agent 时必须先做：

```text
git status --short
git diff -- <自己拥有的文件>
git diff -- <共享 contract>
```

然后把“启动时基线”记录下来。

特别注意当前已经出现修改/新增痕迹的文件：

```text
scheduler.ts
runner.ts
nodeTypes.ts
codeRunner.ts
commandRunner.ts
WorkflowStepCard.tsx
WorkflowNodeCard.tsx
sessionStore.ts
runtime.ts
nodeType.ts
nodeTemplate.ts
hook.ts
executionContext.ts
executionEngine.ts
executorRegistry.ts
nodeInputBuilders.ts
codeExecutor.ts
commandExecutor.ts
artifactRefs.ts
```

其中：

- `scheduler.ts / runner.ts / executionContext.ts / executionEngine.ts / executorRegistry.ts / nodeInputBuilders.ts` → PAR-A 基线。
- `runtime.ts / runStore.ts` → PAR-B 基线。
- `WorkflowStepCard.tsx / WorkflowNodeCard.tsx / sessionStore.ts` → PAR-C 基线。
- `hook.ts` → PAR-D 基线。
- `nodeType.ts / nodeTypes.ts` → PAR-E 基线。
- `codeRunner.ts / commandRunner.ts` 暂不作为新的并行任务范围；若 A 认为必须动，只允许做与现有 executor 接口直接相关的最小改动，并在报告里列出。

### 12.9 本轮推荐启动顺序

```text
Step 0  Interface Freeze / baseline
  ↓
Step 1  PAR-A + PAR-B + PAR-E 并行
  ↓
Step 2  PAR-C + PAR-D 持续消费稳定接口
  ↓
Step 3  Integration Gate
  ↓
Step 4  全量 regression
  ↓
Step 5  再开启下一轮扩展
```

**不要在第一轮同时推进大量新功能。第一轮的价值是把边界锁死。**

最终目标不是“5 个 Agent 同时改代码”，而是：

> **5 个 Agent 可以同时工作，但任何一个 Agent 都不需要知道另一个 Agent 的内部实现；他们只通过稳定的 contracts、events、NodeRunInput、NodeOutcome、Capability descriptors 和 persistence boundary 协作。**

---

## 13. 第一轮并行（PAR-A~E）整合结果（2026-09-18，Integration Gate）

五个并行任务全部 DONE，文件所有权零越界（各报告声明与 git status 逐一核对一致；`docs/parallel/` 为上一轮基线遗留）。Integration Gate 结果：**desktop/contracts typecheck 0 错误，run-all-smokes 29 套件 0 失败**。

### 各任务落地情况

| 任务 | 结果 | 要点 |
|---|---|---|
| PAR-A | DONE | RUNTIME-03/05、SCHED-08/09 收口：prompt/input 下沉进 `buildNodeInput`（`ModelInputScope`/`RunnableNodeInput`）；`ExecutionEngine.setDefault()` 兜底，`ports.execute` 只剩一行委托，分派链零 `kind` 分支；conversation/model 也带统一 `execution` 计时 |
| PAR-B | DONE | RUNTIME-04/07、SCHED-10：`decodeSnapshot` 元素级加固（修掉坏 attempts 元组导致 resume 崩溃的缺口）；新增 `runHistory()` 读模型；身份层级/生命周期/三条单一真相不变量落成文档（runStore 头部 + runtime.ts contract 注释）；旧存档兼容 |
| PAR-C | DONE | UI-04/06/07/10：变量菜单新增 `{{user}}`、上游 params 候选、`status/error/artifacts` meta；artifact viewer 按 kind 分图标可打开 file/directory；步骤卡新增 execution 行（executorKind + 耗时）；i18n zh/en 同步 |
| PAR-D | DONE | AUTO-05/06/07/09：cron 同分钟去重提炼为纯函数 + 事实登记；watcher 失效重试；event 复用 `HOOK_EVENT_OF` 契约（8 条断言钉住与钩子同源）；新建 `automationStatus.ts`（armed/lastFireAt/lastError 事实状态，内存态）；`payloadFactsOf` 钉死 trigger payload 形状 |
| PAR-E | DONE | CAP-03/04/05/06/08：`capability.ts` zod 单一事实源 + `CAPABILITY_MODEL_VERSION`（WF-06/08 预留）；`capabilityResolver.ts` inventory/requirements/诊断三件套；manifest `requirements` 引用共享 schema；第三方 executor 按 `Registry.kinds()` 收编，无特判 |

### Integration Gate 修复的基线遗留（非本轮代理引入）

1. `commandRunner.ts` 基线已把产出键改为 `exitCode`/`stdout`（与 `@@mcode:` 协议、code 节点、code-runner-smoke 一致），但 command 节点 manifest `outputs` 与旧 smoke 还是中文键 → `nodeTypes.ts` manifest 对齐英文键（label/描述保留中文），`command-runner-smoke` 断言键同步。
2. `mcode.code` 的 `language`/`code` 参数缺 help → 已补（≤60 字，mcode-admin-smoke 约束）。

### 遗留 Interface Proposals（下一轮排期）

1. **PAR-C→A/B**：`WorkflowNodeResultEvent` 不带 `input.data`（完整 runtime inspector 受限）、无 queued 入队事件、事件缺 runId。
2. **PAR-D→A**：`startWorkflowRun` 的 `entry` 增加 `payload?: TriggerPayload`（AUTO-10 收口，接 VAR-06）。
3. **PAR-D→IPC owner**：`automation:status/statusAll` 通道，把 `AutomationFacts` 接到管理页 UI。
4. **PAR-D→contracts**：per-trigger enabled/暂停开关的持久化契约。
5. **PAR-E→A**：scheduler 前置检查接入 `requirementsForNode` + `checkNodeCapabilities` + `describeCapabilityProblems`（live inventory preflight）。
6. **PAR-E→C**：NodeInspector 配置期诊断直接消费 contracts 的 `resolveCapabilities`/`describeCapabilityProblems`。
7. **PAR-A**：EXEC-06（conversation/模型轮升级为正式 AgentExecutor 注册类）——边界已通，只需把闭包换成注册类。
8. **RUNTIME-09**：logs + metadata 调试信息统一（WIP）。

### 整合门核定的其他事项

- execution-engine smoke 基线数字 10→14（PAR-A 新增 `setDefault` 断言）。
- `upstream-headers-smoke` 偶发端口竞态仍在观察名单（本轮两趟全量均通过）。
- 改动全部留在工作区未提交；建议按 §11 整合顺序（A/B → D/E → C）分批 commit。

## 14. 第二轮并行（R/M/C/W/U）整合结果（2026-09-18，Integration Gate）

五个并行任务全部 DONE，文件所有权零越界。Integration Gate 结果：**desktop/contracts typecheck 0 错误，run-all-smokes 33 套件 0 失败**（新增 longtask / memory / monitoring / workflow-validation 四个套件）。对应 v2 计划（`MCode-Architecture-Plan-v2.md`）的 Phase 1~3 全部兑现、Phase 4 的 workflow 生成闸门部分兑现。

### 各任务落地情况

| 任务 | 结果 | 要点 |
|---|---|---|
| R | DONE | contracts：`workflow.node.queued` 事件、节点事件补可选 `runId`、结果事件补 `input?.trigger`、`longTask.ts`（LongTask/协议提示词/parseTaskOutcome）；IPC 契约与 preload：`automation.statusAll`、`runs.history`、`memory.*`、`monitoring.*`、`longtask.*` |
| M | DONE | G4 变量闭环 + Memory：`triggerVars.ts` 零依赖叶子（`{{trigger.*}}` 展开，`renderTemplate` 硬失败语义之前预展开）；`nodeInputBuilders` 接 Memory 注入（`params.memory` 开关）；`main/memory/` 三件套（store CRUD + 路径四道闸、retrieval 快照聚合、maintenance 过期/去重纯函数） |
| C | DONE | Monitoring：`main/monitoring/`（collector 订阅 mobileEventBus / NDJSON 持久化 / aggregate）；修掉 runStatusOf 直接迭代 Map 的真 bug；Dashboard 数据源 `monitoring.overview/runs` |
| W | DONE | WF-05/06/08/09：contracts `inputSchema`/`outputSchema`、`WORKFLOW_SCHEMA_VERSION` 兼容规则、`exportWorkflowDoc`/`importWorkflowDoc`、`workflowValidation.ts` 纯函数（13 个错误码，orphan 降 warning）；`library.ts` 三路保存汇合点全部改走 validation |
| U | DONE | 消费层 UI：RunHistorySection（新建）、AutomationRunSection 消费 statusAll、WorkflowStepCard queued chip（`workflow.node.queued`）、变量菜单 trigger 分组、MonitoringPanel + MemoryExplorerPanel 挂 SettingsPage；i18n 净增 42 key × zh/en |

### Integration Gate 修复记录（跨任务接口问题）

1. **`{{trigger.*}}` 在 scheduler 硬失败**（M 预警属实）：`renderTemplate` 对解不开的引用直接抛错且 NodeTemplateScope 无 trigger 名字空间，而 `expandParams` 先于 `buildNodeInput` 执行 → scheduler 在 `expandParams` 里先调 `expandTriggerVars`（传 `entry?.payload`）预展开，trigger 变量在所有节点类型可用。
2. **回归 4 挂（scheduler/dataflow smoke "Dynamic require of fs"）**：scheduler → nodeInputBuilders → memory/retrieval → dataRoot → electron 被拖进冒烟打包图 → 抽 `triggerVars.ts` 零依赖叶子 + 两个 smoke run.sh 补 dataRoot/logger esbuild alias（memory-smoke 同款模式）。
3. **回归 mcode-admin 17 挂**：`graph.orphan-node` 按 error 拦截了旧 `validateDag` 语义合法的多入口图 → 整合门裁定「新闸门不能比旧语义更严」，orphan 降级 warning，smoke 断言同步。
4. **hook.ts 补 `"longtask.update": null`**（编译期全覆盖表漏行）；**taskRunner IPC 方法改名 `attach()`**（原 `start` 与生命周期方法重名，TS2393）。

### 遗留与下一轮入口

1. **Phase 0 端到端真实场景试跑（最高优先级）**：真实 app 跑通「定时/文件监听 → 命令节点检索 → 模型节点整理 → 产物入资料库」，暴露的卡点转下一轮任务。
2. Phase 4 剩余：Monaco 工作空间打磨（Workflow YAML/JSON schema 提示校验、Memory 文件编辑）。
3. CAP-07 学术能力抽离：依赖 Phase 0 试跑结论。
4. VAR-05/07/08/09、WF-07（子工作流）、AUTO-08（webhook）、EXEC-06、RUNTIME-09 维持 TODO/WIP。
5. longtask-smoke 曾在全量连跑时出现 1 次时序抖动（held 闸门断言），单跑与后续全量均稳定通过——若复现，优先检查 `waitUntil` 返回值是否被断言化。
