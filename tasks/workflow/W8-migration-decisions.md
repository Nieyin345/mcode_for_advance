# W8｜二开决策：七个旧能力，哪些搬、哪些用上游、哪些不搬

- Status: ready-for-agent
- Category: **决策卡（读代码 + 论证，不改产品代码）**
- Priority: **P0 —— W9–W14 全部依赖这张卡的结论**
- Depends on: 无
- Exclusive writable files: **只读 + `.tmp/w8/` 探针**。**不改任何产品代码。**

## Required Skills
- `codebase-design`：判断「该复用上游」还是「该写薄壳」。
- `code-review`：区分「能跑」和「语义等价」。

## 背景：用户的方向

> **「我们的这个工作流不要之前自己写的工作流了，全面用现在的 node red，进行二开，保留我们之前的工作流的一些功能，很多功能是可以集成到现在的 node red 里面的，所以要二开」**

**关键理解**：
- 「不要之前自己写的」= **旧的自研画布/执行器不是终态**；
- 「全面用 Node-RED 二开」= **Node-RED 是唯一内核，我们在它上面加**；
- 「保留旧的一些功能」= **不是全搬**，是「一些」——**哪些要论证**。

## ⛔ 2026-10-24 更正（派活后总控发现）：前提错了，任务形状已改

**原文写「已经搬进 Node-RED 的只有 `mcode-agent` 一个节点类型」。这是错的。**

`apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts:54-68`：

```ts
export const MCODE_CONVERSATION_NODE_TYPE = "mcode-conversation";
export const MCODE_BRANCH_NODE_TYPE = "mcode-branch";
export const MCODE_TRIGGER_NODE_TYPE = "mcode-trigger";
export const MCODE_MODULE_CAPABILITY_NODE_TYPE = "mcode-module-capability";
export const MCODE_NODE_RED_CALL_NODE_TYPE = "mcode-node-red-call";

export const MCODE_NODE_PACK_TYPES = [
  MCODE_AGENT_NODE_TYPE, MCODE_CONVERSATION_NODE_TYPE, MCODE_BRANCH_NODE_TYPE,
  MCODE_TRIGGER_NODE_TYPE, MCODE_MODULE_CAPABILITY_NODE_TYPE, MCODE_NODE_RED_CALL_NODE_TYPE,
] as const;
```

**六个，全部真的 `registerType`**（`:344-480`），`nodePackManifest.ts:226` 为每个类型生成
`<type>.js`。**`mcode-branch` 甚至已经实现了「1 入 N 出、按端口 send」**（`:361-386`）。

**所以本卡原来的「七个能力 × 搬 / 用上游 / 不搬」问错了问题。**
真正的问题是：**这六个节点里，哪些真的能跑，哪些只是注册了？**

新的决策表形状：

| 旧能力 | 对应 `mcode-*` | 真的能跑吗（证据） | 和旧语义等价吗 | 还差什么 |
|---|---|---|---|---|
| `agent` | `mcode-agent` | | | |
| `conversation` | `mcode-conversation` | | | |
| `branch` | `mcode-branch` | | | |
| `trigger` | `mcode-trigger` | | | |
| `condition` | 无（用上游 `switch`） | | | |
| `command` | 无 | | | |
| `code` | 无 | | | |
| `prompt` | 无 | | | |

**外加两个不在旧表里的**：`mcode-module-capability`、`mcode-node-red-call` —— 它们是什么、谁来用。

**结论只需三类**：① 已经能用、不用再做；② 有代码但没接通、要接线；③ 真没有、要写。
**「要写」不再是默认答案。**

### 「真的能跑吗」怎么取证（这是新任务的核心）

`registerType` 只证明节点出现在 palette 里。**Host 端口接没接**才是分界：

- `port.run` / `port.decide` / `port.subscribe`（`nodePackChildRuntime.ts:70-90`）
- 生产上这些 port 由谁注入？`apps/desktop/src/main/workflowEngines/` 里的 Host RPC 实现是否存在？
- 有没有套件**真跑过**这个节点（不是「有断言说它注册了」）？

**六个节点逐个查，每个都要有「能跑 / 不能跑」的直接证据，不能靠推断。**

---

## 原文（保留，但上面那段更正优先）

## 现状（已核实）

**已经搬进 Node-RED 的只有 `mcode-agent` 一个节点类型**
（`workflowEngines/mcodeNodePack.ts` 的 `MCODE_AGENT_NODE_TYPE = "mcode-agent"`）。

> ⛔ **上面这句是错的。见本卡开头的更正。**

旧的 `runner.kind` 全集（`nodeTypes.ts` 实测）：

| `runner.kind` | 节点类型 | 是什么 |
|---|---|---|
| `conversation` | `mcode.conversation` | **在主对话里说一句**（不是子会话） |
| `command` | `mcode.command` | 本机跑 shell，退出码+输出给下游 |
| `code` | （代码节点） | 跑一段代码 |
| `branch` | （分支） | 岔路口，选项是**边** |
| `condition` | （条件） | 条件判断 |
| `prompt` | （提示词型） | 纯文本流程，**不是图** |
| `trigger` | （触发器） | cron / fs.watch / 事件订阅 |
| `agent` | `mcode.agent` | 子 agent —— **✅ 已迁** |

## 任务：产出逐能力决策表

对上面**七个未迁的能力**，每个回答四件事：

### ① 它在旧系统里到底做什么（读源码，不是猜）

**每个能力都要指出具体文件与函数**，例如：
- `command` → `nodeTypes.ts` 的哪个 runner？命令怎么起、退出码怎么取、有没有审批门？
- `conversation` → 它在主对话里「说一句」是怎么实现的？和子 agent 的差别只在「在哪跑」吗？

**判断标准**：你写的描述，要能让另一个没读过这个文件的人照着理解。

### ② Node-RED 上游有没有等价能力

**逐个对照 Node-RED 5.0.8 原生节点**（源码在 `node-red/packages/node_modules/@node-red/nodes/core/`）：

| 旧能力 | Node-RED 候选 | 现在判断 |
|---|---|---|
| `command` | `exec` | **不够**（缺审批门 + 工作目录围栏） |
| `branch` / `condition` | `switch` | **够**（选项是规则） |
| `code` | `function` | **不够**（跑在 Node-RED 进程内，没有隔离/审批） |
| `conversation` | 无 | — |
| `trigger` | `inject` / `http-in` | **部分够**（缺宿主身份判定） |

**这只是我的初判，你要读上游源码核实。** 尤其是：
- `switch` 能不能表达 `branch` 的**边作为选项**语义？
- `exec` 有没有办法接审批（还是必须写新节点）？

### ③ 结论：搬 / 用上游 / 不搬

**三选一，并给理由。**

**判断原则**（来自 CLAUDE.md 与路线图）：
- **能复用上游就不造** —— `branch`/`condition` 若 `switch` 真能表达，就**不写新节点**；
- **不能因为「好写」就重造** —— 写 `mcode-*` 节点只在「上游语义不够 + 缺了会破坏 Mcode 的安全边界」时才做；
- **`prompt` 大概率不该搬** —— 它是「一段流程文字」，`WorkflowDocSchema` 的注释说
  「硬掰成图反而是倒退」。**但你要论证，不能默认。**

### ④ 若搬：它需要什么

- 走哪个 Node-RED 扩展点（`RED.nodes.registerType` 的节点 vs 自定义 palette）；
- **审批/权限怎么接**（这是 Mcode 的硬边界：`mcode.agent` 是怎么做的？照它）；
- 参数形状（给 `NodeInspector` 用的那份）；
- **和 `NodeTypesView` / `NodeInspector` 的关系**（旧 UI 要认这些节点吗？）。

## 还要回答一个结构问题

### Q：旧图（`engine: "mcode"`）怎么办

现在 `assertWorkflowExecutor(doc, "mcode")` 在 `runner.ts:947` 与 `scheduler.ts:2342`
两处 fail-closed，所以**两张图各跑各的**。搬完之后：

| 方案 | 做什么 |
|---|---|
| A. 彻底删 | 删 `executionEngine` + `runner.ts` 的图执行路径 |
| B. 冻结 | 保代码但不接新图，旧图仍能跑 |
| C. 迁移后删 | 先写迁移器把旧图转成 Node-RED，再删 |

**路线图 §5 的退场阶段 A→B→C 已经给了路径**（并存 → 旧画布只读 → 删除手写画布）。
**现在已经到「C 的前一步」**（画布已删，执行器还在）。

**你判断该走哪条，并说明「删之前必须先有什么」。**

## 验收判据

1. **七个能力，每个都有**：它做什么（带文件/函数）、上游有没有等价、结论（搬/用上游/不搬）、理由；
2. **`switch` 能否表达 `branch`/`condition`**：有上游源码依据 + 你的验证；
3. **`prompt` 的取舍有论证**（不能默认搬家也不能默认不搬）；
4. **Q（旧图怎么办）有明确结论**，并写清「删之前必须先有什么」；
5. **不改任何产品代码**（`git status` 里不能有 `apps/desktop/src/**`）；
6. **不跑全量**。

## 边界

- **只读 + `.tmp/w8/` 探针**；
- 可以跑单套 `node-red-*` / `workflow-*` 套件验证上游行为；
- **不写卡、不改代码**——结论交回，由总控写后续实现卡。

## 回写

`tasks/workflow/W8-migration-decisions.md` 末尾追加 `## 结果回写`：
七行决策表、`switch` 验证结果、`prompt` 论证、旧图处置方案、**以及你发现的我判断错的地方**。

---

# 结果回写

> 执行时间：2026-10-24 19:30–20:20。工作区基线：`d31f065e` + 在途改动（`git status` 有他人未提交文件）。
> **未改任何产品代码**（`apps/desktop/scripts/` 下临时探针已删除；探针只留在 `.tmp/w8/` 与 `apps/desktop/.tmp/w8/`）。
> **未 commit，未跑全量。** 跑过的套件：`mcode-node-pack-smoke`（393/393，**真引擎段实际执行，未 SKIP**）。
> ⚠️ 写回写期间本文件被另一个会话追加过「⛔ 更正」段（`:22-75`）。**那段更正与本回写的结论一致**（六个节点不是六个「可能没接」，而是六个都接了端口）；本回写独立完成后才看到它。两段没有冲突，本节 `§0` 的表格是更正段要求的最终形状。

## 0. 先说结论（给总控写后续卡的最小输入）

| 旧能力 | 对应的 `mcode-*` 节点 | 它真的能跑吗（证据） | 和旧语义等价吗 | 结论 |
|---|---|---|---|---|
| `agent` | `mcode-agent` | ✅ 能。`nodePackProductionPorts.ts:131`；真引擎套件 `mcode-node-pack-smoke` 实测跑到（`conversation 收到 instruction` / `agent 收到 instruction` 均 ok） | ⚠️ **部分**：缺 `{{模板}}` 展开、缺输出约束校验、缺重试 | **② 有代码但没接全，要补** |
| `conversation` | `mcode-conversation` | ✅ 能，但**迁移出来的图跑不了**：`runSelectedSession` 要求 `params.sessionId` 且 `SessionRepo.kind === "chat"`（`nodePackProductionPorts.ts:35-40`），而**迁移器不写 sessionId**（实测探针：`sessionId(native)=null / sidecar=null`） | ❌ **不等价**：旧 `conversation` 是「跑在这张图那条会话里」，新的是「跑在用户手填 id 的那条 chat 会话里」。旧图迁移后必须人工补 sessionId，否则每次执行都抛 `Mcode sessionId is required` | **② + ③ 语义要补** |
| `branch` | `mcode-branch` | ✅ 能。`decider:"user"` → `dialog.showMessageBox` 真弹窗（`:110-122`）；`decider:"model"` → 跑一轮取整数端口（`:98-108`），非数字/越界都抛 | ⚠️ **半等价**：端口/弹窗/模型选都在；**边的 `label`/`note` 没有进运行期**。`edgeMeta` 在迁移产物里活着（探针实测 `[{"edgeId":"e_b_true","label":"继续","note":"接着往下做"}]`），但 native 侧**没有任何消费者**把 note 拼进下一步提示词（旧侧 `schedulerPrompt.ts:275 arrivalSection()` 做的事，native 侧没有对应物） | **② 要补「选中后把 label/note 传下去」** |
| `condition` | 无（上游 `switch`） | ✅ 迁移器产出合法（探针：`wires.length=2`、`rules=[{t:"true"},{t:"else"}]`、`checkall:"false"`），真引擎 `switch` 实测按 true/else 两口分流（`mcode-node-pack-smoke` 真引擎段部署 200 并整组启动） | ❌ **不等价**：`switch` 查的是 `msg.mcode.condition`，而**全仓没有生产者**（`grep -rn "mcode.condition" src/` 只命中迁移器自己的规则与 `nodePackBundle` 里透传的那个 `meta.condition`）。也就是说：condition 节点迁移到 Node-RED 后，**永远走 else 口** | **② 有映射但没接通**（见 §2 实测） |
| `command` | 无 | 上游 `exec` 可用（真引擎段实测：`非零进程码 → 看板失败` ok） | ❌ **不等价**：① `exec` **没有 `cwd` 选项**（`90-exec.js:38-42` 的 `execOpt`/`spawnOpt` 只设 encoding/maxBuffer/windowsHide/shell，全文件 0 次 `cwd`）—— 旧 `command` 相对项目目录跑（`commandExecutor.ts:66,98` 的 `cwd`），迁移后进程落在 Node-RED 进程的当前目录；② 非零退出语义确实翻了（迁移器没设 `oldrc`，默认 `oldrc=false` 仍发口 2，Mcode 侧是 success），但**没人把 `mcode.command` 的「退出码进 stdout 变量」契约接上** | **③ 要写 `mcode-command`**（薄壳）或给 `exec` 补围栏 |
| `code` | 无 | 上游 `function`（JS）/ `exec`（其它语言）都可跑 | ❌ **不等价且不安全**：`function` 跑在 Node-RED 引擎进程里（`10-function.js` 用 `vm` + `acorn`），**没有 Mcode 的沙箱/审批**；`exec` 走的是 `python -c "..."` **裸命令字符串**（`flowMigration.ts:270-274`），旧 `codeRunner` 是**写临时文件 + `python -u` + `resolvePythonExe` 跳过捆绑解释器**（`codeRunner.ts:21-23,52-64`）。缓冲行为、解释器选择、临时文件清理三样都不一样 | **③ 要写 `mcode-code`**（走受控子进程） |
| `trigger` | `mcode-trigger` **只保留 event** | ✅ 能（`productionNodePackPorts.ts:186-199`，`mcode-node-pack-smoke` 真引擎段 `trigger 收到 triggerKind` ok） | ⚠️ **有意收窄**：`manual`/`schedule`/`file` **显式拒绝**（`:188-190` 抛「Use Node-RED native inject/watch」）。但迁移器把 schedule 映射成 `inject` 的 `crontab`、file 映射成 `watch`，而 **`inject` 没有 `enabled` 字段**（`grep -c enabled 20-inject.js` = 0）→ **旧 trigger 的「启用」开关在迁移中丢失**（迁移器全文 0 次 `enabled`）。另：native 侧用 `params.task` 当事件名（`:191`），而旧侧事件名在 `params.events`（`nodeType.ts:172` / `automationRunner.ts:1914`），`task` 是「这次要做什么」的用户请求（`nodeTypes.ts:1068-1074`）——**字段用错了** | **② 收窄是设计决定；但要补 `enabled` 与 `events`/`task` 的字段对齐** |
| `prompt`（提示词型**工作流**） | 无 | — | — | **不搬**（见 §3 论证） |

**额外两个不在旧能力表里的节点**：

| 节点 | 是什么 | 生产实现 | 和旧图迁移的关系 |
|---|---|---|---|
| `mcode-module-capability` | 调用宿主内置模块的只读文件能力 | `getModuleHost().invoke`，要求 `projectPath` 绑定 Host 授权（`nodePackProductionPorts.ts:135-143`） | 对应旧 `runner.kind === "module-capability"`（`nodeTypes.ts:894`），**是旧能力表漏掉的第 8 种** |
| `mcode-node-red-call` | 向本机受管引擎发一次回环 HTTP | `fetch` + 路径围栏 + 非 GET 只许 `POST /flows` 且弹窗批准（`:145-183`） | 对应旧 `runner.kind === "node-red"`（`nodeTypes.ts:948`），**是第 9 种** |

**所以旧能力实际是 9 种，不是 7 种。** 卡的 `runner.kind` 表漏了 `module-capability` 与 `node-red` 两个（这两个恰好都已经有 `mcode-*` 节点并已接生产端口）。

## 1. 六个 `mcode-*` 节点成立吗（逐条）

**全部 6 个都 `registerType` 并在 `nodePackManifest.ts:226` 生成了 `<type>.js`/`<type>.html`；全部 6 个的 Host 端口都在 `nodePackProductionPorts.ts` 有生产实现，并挂在 `registry.ts:723` 的 `NodePackHost` 上。**

| 节点 | 注册 | 生产端口 | 真引擎跑过 | 缺口 |
|---|---|---|---|---|
| `mcode-agent` | ✅ | ✅ `runSelectedSession` | ✅ | 模板展开/输出约束/重试 |
| `mcode-conversation` | ✅ | ✅ 同上（同函数） | ✅ | 同上 + **sessionId 无来源** |
| `mcode-branch` | ✅ | ✅ `chooseBranch` | ✅ | 选中后 `label`/`note` 不到下游 |
| `mcode-trigger` | ✅ | ✅ `subscribe` | ✅ | 只支持 event；`enabled` 丢失；`task` vs `events` 混用 |
| `mcode-module-capability` | ✅ | ✅ `getModuleHost` | ✅ | 无明显缺口 |
| `mcode-node-red-call` | ✅ | ✅ 受控 fetch | ⚠️ 套件里因 branch 选 0 未走到（`check` 名字自己写了） | 无独立端到端证据 |

**「注册了」和「能跑」是两件事，本卡实测出的差别就在 `mcode-conversation`：节点本身能跑，但迁移产物跑不了（缺 `sessionId`）。**

## 2. `switch` 能否表达 `branch` / `condition`（源码 + 实测）

### `condition` → `switch`：**能，但当前接不通**

- 上游 `switch` 的规则运算符覆盖 `exists`/`eq`/`cont`/`true`/`false`/`else` 等（`10-switch.js:20-80`），Mcode 的三个谓词 `exists`/`equal`/`contains` 都能表达。
- **⚠️ 默认行为会咬人：`this.checkall = n.checkall || "true"`（`10-switch.js:264`）** —— 默认「所有命中的规则全部放行」，一条消息可能同时走多个出口。要互斥必须显式 `checkall: "false"`。迁移器**已经写了** `checkall: "false"`（探针实测），这点是对的。
- **但规则查的是 `msg.mcode.condition`，全仓无生产者。** 实测（`.tmp/w8/probe-switch-real.cjs`，用**真上游 `10-switch.js`** 配最小 RED stub）：

```
A1 msg.mcode 不存在              → [["·","MSG"]]   ← 走 else
A2 msg.mcode = {}                → [["·","MSG"]]
B1 msg.mcode.condition = true    → [["MSG"]]       ← 走 true
B2 msg.mcode.condition = false   → [["·","MSG"]]
B3 msg.mcode.condition = 'true'  → [["·","MSG"]]   ← 字符串不认（=== true）
```

  **结论**：`switch` 表达 `condition` 没问题；**问题在「谁把求值结果写成 `msg.mcode.condition`」这一环没有**。旧 `conditionOutcome`（`scheduler.ts:1208-1230`）在调度器内求值 `{{上游.字段}}` + `and`/`or`，native 侧没有对应物 —— 迁移器的 `lossy` 报告已经点名了这件事（`flowMigration.ts:849-856`：「由 Host 侧承担（MERGE-3 接 mcode-condition）」）。
- 另：`switch` 的 `wires.length` 必须 = `rules.length`，否则 `Node.send` 按 `this.wires.length` 截断（`Node.js:420`），多出来的规则静默丢弃。实测 D1（rules=3 / wires=2）→ 第三个口没发。

### `branch` → `switch`：**不该用 `switch`，但也不该再造新东西 —— `mcode-branch` 已经有了**

- 旧 `branch` 的语义是「**选项是边**」（`nodeTypes.ts:774-776`：「表会有两种真相，边不会」）+ 两种决定权（`user` 挂起 / `model` 跑一轮）。
- 上游 `switch` 只能按值匹配自动分流，**没有「挂起等真人」**、**没有「把选中的边名交给下游」**。`switch` 的输出口是规则序号，不是 Mcode 的 `edgeId`/`label`/`note`。
- **`mcode-branch` 已经把这套做完了**（`mcodeNodeTypes.ts:361-386`：1 入 N 出、`port.decide({portCount, decider})`、只往选中口发、其余发 `null`），生产端口还接了真弹窗与模型选（`nodePackProductionPorts.ts:100-124`）。
- **所以这条的正确结论不是「`switch` 够/不够」，而是「`mcode-branch` 还差什么」** —— 差的是「选中之后把这条边的 `label`/`note` 交给下游」，见 §0 表。

## 3. `prompt`（提示词型工作流）的论证

**先纠正一个概念混淆（卡上把它当成 `runner.kind` 了）**：

- `runner.kind === "prompt"` 是**子 agent 节点**（`mcode.agent`）的执行原语（`nodeType.ts:656`、`nodeTypes.ts:662`）—— **它已经在 Node-RED 里了（`mcode-agent`）**。
- **提示词型工作流**是**文档级**的 `WorkflowDoc.prompt`（`workflow.ts:278-283`），形态判据是 `nodes.length === 0`（`workflow.ts:381-382` 的 `kind: "prompt" | "graph"`）。它不是一个节点，进不了图。

**结论：不搬，且不该搬。** 三条论证：

1. **它不是图**。`WorkflowDocSchema.prompt` 的注释原文：「两种形态并存是有意的：五个内置模式里有几个本质就是"一段流程"，硬掰成图反而是倒退。」（`workflow.ts:279-281`）
2. **它的执行路径完全不经过任何图执行器**。`assertWorkflowExecutor` 第一行就是 `if (doc.nodes.length === 0) return; // prompt-only flows have no graph scheduler`（`workflowEngineSelection.ts:15`）；真正读它的是 `getWorkflowPrompt` → `resolveWorkflowPrompt` → `RuntimeManager.sendTurn` 的 `workflowPrompt` 字段（`library.ts:290-297`、`prompt.ts:26-28`、`RuntimeManager.ts:1524`）—— **它走的是「对话」，不是「工作流引擎」**。搬进 Node-RED 等于给「一段文字」造一个只有一个节点的图。
3. **证据：出厂预设里 4/7 就是提示词型**。实测 `apps/desktop/resources/presets/workflows.json`：

```
search            nodes=4  promptLen=0
read              nodes=0  promptLen=559   ← 提示词型
write             nodes=5  promptLen=0
review            nodes=0  promptLen=503   ← 提示词型
code              nodes=0  promptLen=224   ← 提示词型
wf_auto_download  nodes=4  promptLen=0  trigger=event
wf_auto_convert   nodes=2  promptLen=0  trigger=event
```

   搬它 = 要迁移 3/7 出厂预设，而它们**现在一次图执行器都不进**。

**但要补一条边界**：`newWorkflowDoc` 新建时 `prompt: ""`（空串，不是省略），且 `engine: "node-red"`（`workflowEdit.ts:56`）。所以「新建一张空白工作流、只写提示词、不画图」这条路**在当前代码里是存在的**，它靠 `nodes.length === 0` 走进对话路径 —— 与 `engine` 字段无关。**这条不需要 Node-RED，也不需要搬。**

## 4. 旧图（`engine: "mcode"`）怎么办

### 现状实测

- 新图/新自动化**默认就是 `engine: "node-red"`**（`workflowEdit.ts:56` `newWorkflowDoc`）。
- **出厂预设 7 份全部没有 `engine` 字段** → `effectiveWorkflowEngine` 归一成 `"mcode"`（`workflowEngineSelection.ts:9-12`）→ **7/7 走旧执行器**。
- `assertWorkflowExecutor` 两处（`runner.ts:947` / `scheduler.ts:2342`）仍是硬闸；`automationRunner.legacyTriggerOwnerOf`（`:513-518`）也按 `effectiveWorkflowEngine` 分派，`node-red` 的图旧 runner 一个监听都不装。
- **迁移器在生产上真被调用**：`ipc/index.ts:300` → `loadWorkflowIntoNative`（`nativeLibraryLoad.ts:176` 调 `migrateWorkflowDoc`）。而且它前面有预检（`evaluateWorkflowMigration`，REJECT/UNREADABLE 无条件拒绝）与审批（`flowTrustGate`）。**所以「W13 写迁移器」这件事确实已经做完了，不是「做完了没接」。**
- 但 `loadWorkflowIntoNative` 只接受 `doc.engine === "node-red"`（`nativeLibraryLoad.ts:145`），旧图要先用 UI 的引擎下拉框手切（`WorkflowLibraryView.tsx:1118`），切换时 `checkEngineSwitch` 做无损检查（`library.ts:377`）。

### 结论：走 **C（迁移后删）**，但现在还在「C 之前」，**不能删**

理由：
1. 7/7 出厂预设仍是 `mcode`；删执行器 = 内置工作流全部失效。
2. `condition` 迁移后**永远走 else**（§2）—— 出厂预设 `wf_auto_download` 就含 `mcode.condition`，删旧执行器等于让这条自动化静默走错分支。
3. 语义等价缺口还有 5 条（模板、输出约束、重试、`label`/`note`、`sessionId`）。

**「删 `ExecutionEngine` 图执行路径之前，必须先有」**（按依赖排序）：

1. **`condition` 求值有一个生产者** —— 把旧 `conditionOutcome` 的 `{{}}` + `and`/`or` 求值接到 native 侧，写出 `msg.mcode.condition`。**这是最硬的一条**：没有它，迁移后的 condition 图**有 50% 的路径是静默错的**，而这一点在套件里看不出来（`mcode-node-pack-smoke` 的 condition 断言只验了「规则形状对」，没验「真值从哪来」）。
2. **`mcode-conversation` 的 sessionId 有确定来源** —— 要么迁移时绑 `x-mcode.docId` 对应的主会话，要么在编辑器里强制选。现在缺了它，**每一张迁移过来的、含 `mcode.main`/`mcode.conversation` 的图都跑不了**，而 7/7 预设里有 3 张含 `mcode.main`。
3. **`branch` 的 `label`/`note` 到下游** —— 否则「再改一轮」那一步拿不到「上一轮为什么被否」。
4. **`command` 的 cwd 围栏 + 非零退出的产出契约** —— 现在 `exec` 无 `cwd`，迁移后的命令在引擎进程目录里跑。
5. **`code` 的受控子进程** —— `function` 在引擎进程内、`exec` 是裸字符串，两者都不是旧 `code` 的安全面。
6. **`trigger.enabled`** —— 迁到 `inject` 后「关掉这条触发器」没有落点（`inject` 无 `enabled`）。
7. **出厂 7 份预设的 engine 全部显式化 + 迁移验证** —— 现在它们连 `engine` 字段都没有。
8. 真 Electron U1：迁移 → 部署 → 编辑 → 再部署的完整旅程（`node-red-vendor-integration-map.md` §5 的 C 阶段判据）。

**不建议 A（彻底删）、也不建议 B（冻结）**：B 就是现状，而路线图明确「不长期保留两套执行器或双触发」；A 会在上面 8 条补完之前造成功能倒退。

## 5. 卡上判断错的地方（逐条）

1. **「已经搬进 Node-RED 的只有 `mcode-agent` 一个节点类型」—— 错。** 实际 6 个：`mcode-agent` / `mcode-conversation` / `mcode-branch` / `mcode-trigger` / `mcode-module-capability` / `mcode-node-red-call`（`mcodeNodeTypes.ts:54-68`），且 6 个都在 `nodePackManifest.ts:226` 生成了独立文件、都在 `registry.ts:723` 接了生产端口。

2. **「`branch`/`condition` 能不能直接用上游 `switch`」这个问法本身有问题。** `condition` 能用（但接通还差一环）；`branch` 的情况是「**`mcode-branch` 已经做了，不需要 `switch`，也不需要新造**」。卡把 `branch` 和 `condition` 绑在一起问，会引导出「造一个 `mcode-branch`」的错误结论 —— 而它早就存在了。

3. **「`exec` 有没有办法接审批（还是必须写新节点）」—— 问题前提偏了。** 上游 `exec` 真正的缺口不是审批，是 **`cwd`（整个文件 0 次）**。旧 `command` 的语义里**本来就没有审批**（`nodeTypes.ts:868` 的 usage 原文：「**没有审批**，「能力」那一项也管不着它」），所以「缺审批门」这个理由站不住 —— 真正缺的是工作目录围栏与产出契约。

4. **「`trigger` → `inject`/`http-in`」—— `http-in` 不是候选。** 旧 trigger 的四种是 manual/schedule/file/event，迁移器映射到 `inject`（once / crontab）/ `watch` / `mcode-trigger`（`flowMigration.ts:285-300`）。`http-in` 是外部 HTTP 入口，与 Mcode 的触发源没有对应关系。

5. **`prompt` 被当成 `runner.kind`。** 见 §3：`runner.kind === "prompt"` 是子 agent（`mcode-agent`）；提示词型工作流是文档级 `WorkflowDoc.prompt`。这两个在卡上被混成一个「能力」，导致「搬不搬」这个问题问错了对象。

6. **「七个未迁的能力」—— 实际是 9 种 `runner.kind`。** 少了 `module-capability` 与 `node-red`（`IMPLEMENTED_RUNNER_KINDS`，`nodeType.ts:1346`），而这两个恰好**都已经有节点且已接生产端口**，是「已经能用」的两项。

7. **「W13 写迁移器」这个后续卡的前提也不成立。** 迁移器 `flowMigration.ts`（1476 行）+ `flow-migration-smoke` 已存在，且**在生产路上被调用**（`ipc/index.ts:300` → `nativeLibraryLoad.ts:176`），还带预检与审批闸。W13 应改成「验迁移器 + 补语义缺口」，不是「写迁移器」。

8. **「不跑全量」（卡上第 6 条验收）与「可以跑单套」是一致的，但卡同时说「不改任何产品代码」，而 `mcode-node-pack-smoke/run.sh` 因为 `scripts/lib/esbuild-path.sh` 在本工作区**存在但被另一个会话的改动影响**（`bash run.sh` 报 `No such file or directory`，走 `node scripts/run-smokes.mjs mcode-node-pack-smoke` 才跑起来）—— 这属于本仓库的并行会话坑，不是卡的问题，记在这里供后续卡注意。

## 6. 我觉得不对但没改的地方

1. **`mcode-node-pack-smoke` 的 condition 断言只验形状，不验真值**（`main.ts:894-899`：wires 长度 + `rules.map(r=>r.t).join(",") === "true,else"`）。真引擎段也没给 `msg.mcode.condition` 赋值 —— 所以「condition 永远走 else」这个缺陷**在 393/393 全绿的情况下完全不可见**。这是「套件名说的范围大于它检查的范围」的一个实例（CLAUDE.md 第二十八条同族）。
2. **`nodePackProductionPorts.ts` 里 `params.task` 当事件名**（`:191`），与旧侧 `params.events`（逗号分隔多个事件名）+ `task`（用户请求）语义冲突。迁移器把 `task` 原样带到 native 顶层（`flowMigration.ts:344`），于是迁移后的 trigger 会拿一句人话当事件名去匹配 `event.type` —— **永远匹配不上**。这条比 `enabled` 更隐蔽。
3. **`productionPortsStub.ts` 的 `productionNodePackServices` 直接抛错**（「Node-pack smoke has no real Mcode approval session」），意味着**没有任何套件覆盖生产端口的真实行为**。`chooseBranch` 的弹窗、`node-red-call` 的围栏、`module-capability` 的 `projectPath` 要求，全部只有代码、没有测试。这是「真引擎段」与「生产端口段」之间的空白。
4. **`mcode-node-red-call` 在真引擎段「因 branch 选 0 未走到」**（套件自己的 check 名字写着）。所以六节点里它是唯一**没有端到端执行证据**的一个。
5. **`flowMigration.ts` 的 `EXEC_LANGUAGE_PREFIX.python = "python -c"`** 会与旧 `codeRunner` 的 `python -u` 产生**缓冲行为差异**：无 `-u` 时长任务的进度输出会攒到进程结束，`@@mcode:progress` 协议等于失效。这条在迁移的 `lossy` 报告里**没有点名**（只点了「语言面不等价」）。
6. **`branch` 的 `mcode-branch` 在 native 侧不会「作废其余支路」**。旧调度器里未选中的边 `edgeLive` 判死、下游整片 `unselected`（`scheduler.ts:1143-1148`）；Node-RED 里未选中的口就是不发消息，**下游等待同一节点另一条入边的汇合点不会自动跑**。迁移报告没有把这条记为 `lossy`。
7. **权限：`runSelectedSession` 不检查 `payload.capability`**（`nodePackProductionPorts.ts` 全文 0 次 `capability`），与 agent 节点 HTML 的 help 文案「selecting write is not authorization」一致 —— 但这意味着 **`mcode-agent` 的 `capability: "read"` 在 native 路径上不产生任何约束**。旧侧 `nodeSessionOf` 会用 `permissionModeForCapability` 推权限模式（`runner.ts:2845`）。这是「可配置但不可自授权」在 native 侧的一个空洞：不是提权，而是**声明的限制没生效**。

## 7. 本卡跑过的东西（可复核）

| 项 | 命令 / 文件 | 结果 |
|---|---|---|
| 上游 `switch` 语义 | `node .tmp/w8/probe-switch-real.cjs`（真 `10-switch.js` + RED stub） | 见 §2 的五组输出 |
| `switch` 端口/规则对齐 | `node .tmp/w8/probe-switch-send.mjs` | `Node.send` 按 `wires.length` 截断；rules=3/wires=2 时第三口不发 |
| 迁移产物字段 | `apps/desktop/.tmp/w8/probe-migrate-sessionid.ts`（esbuild 打包后跑） | `sessionId` 三处全 null；`edgeMeta` 保留 `label`/`note`；`switch` 的 `checkall:"false"` |
| 真引擎全链 | `node scripts/run-smokes.mjs mcode-node-pack-smoke` | **393/393 通过，真引擎段实跑未 SKIP**（日志：`apps/desktop/.tmp/smoke-runs/1792841825050-17544-dOj3Ka/`） |
| 出厂预设形状 | `node -e` 读 `apps/desktop/resources/presets/workflows.json` | 7 份，engine 全缺省，4 图 3 提示词型（其中 `search`/`write` 是图） |

**未做**：没跑 `node-red-e2e-smoke`（需另一份隔离数据根，且本工作区有并行会话在改 `scripts/`）；没跑真 Electron U1；没验证 `mcode-node-red-call` 的端到端。
