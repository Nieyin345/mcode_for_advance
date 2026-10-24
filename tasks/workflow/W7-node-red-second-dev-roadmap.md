# W7｜二开路线图：把旧工作流的七个能力搬进 Node-RED

- Status: **规划卡（总控用，不派给执行子代理）**
- Category: **路线决策 + 迁移清单**
- Priority: **P0 —— 用户明确要求：「不要之前自己写的工作流了，全面用 Node-RED 二开，保留旧的工作流的功能」**

## 用户的原话

> **「我们的这个工作流不要之前自己写的工作流了，全面用现在的 node red，进行二开，保留我们之前的工作流的一些功能，很多功能是可以集成到现在的 node red 里面的，所以要二开」**

这比路线图 §2 那句「唯一流程内核」更明确：**不是「迁移期并存」，是「以 Node-RED 为唯一内核，旧能力作为二开增量搬过去」。**

## ⛔ 2026-10-24 更正：这张卡的核心前提是错的，下面那段「已经搬了什么」已被推翻

**原文写「只有 `mcode-agent` 一个节点类型」。这是错的。**

`apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts:54-68` 实测：

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

**六个类型，全部真的 `registerType` 了**（`mcodeNodeTypes.ts:344-480`），
`nodePackManifest.ts:226` 还给每个类型生成 `<type>.js` 供 Node-RED 按文件加载。

**其中 `mcode-branch` 已经实现了「1 入 N 出、按端口 send」**（`:361-386`）——
调 `port.decide({ portCount, decider })`，拿到 `chosen.port` 后 `send(ports)`
只在选中那一口发。**这正是本卡 Q2 里说「要写 `mcode-branch`」的那个东西，它已经在了。**

**为什么会错**：我写这张卡时 grep 的是 `MCODE_AGENT_NODE_TYPE` 一个符号，看到命中就下了结论。
**按一个名字搜是引用数，不是出口数** —— README 第十五条写过这件事，我自己又踩了一次。

**所以本卡下面的「要搬的七个能力」表和 Q2 的初判，全部要按新事实重读：**
真正的问题不是「要搬哪些」，而是「**六个节点里哪些真的能跑、哪些只是注册了**」。

### 新事实带来的真问题（比原卡更硬）

| 问题 | 为什么 |
|---|---|
| **六个节点真的能跑吗** | `registerType` 只证明它出现在 palette 里。**Host 端口（`port.run` / `port.decide` / `port.subscribe`）接没接** 才是能不能跑的分界。**W8 正在查这个。** |
| **`mcode-branch` 有没有旧 `branch` 的 `label` / `note`** | 旧 `branch` 的选项在**边上**，`note` 会拼进下一步的提示词。`mcode-branch` 的 `send(ports)` 只选端口，**没有信息通道** —— 这部分可能真丢了 |
| **旧能力表里没有 `mcode-module-capability` / `mcode-node-red-call`** | 这两个是**新的**，不在七个旧 `runner.kind` 里。它们是谁、服务什么场景，是本卡原来完全没考虑的 |
| **`condition` / `command` / `code` / `prompt` 仍然没有 `mcode-*`** | 这四个才可能真的需要「写」或「用上游」。`condition` → `switch`（够），`prompt` → 大概率不搬 |

---

## 原文（保留，但读的时候记住上面那段更正）

## 现状：已经搬了什么

**只有 `mcode-agent` 一个节点类型**（`mcodeNodePack.ts` 的 `MCODE_AGENT_NODE_TYPE`）。

> ⛔ **上面这句是错的。见本卡开头的更正。**

## 要搬的：旧系统的七个 runner 能力

`nodeTypes.ts` 里的 `runner.kind` 全集（实测 grep）：

| `runner.kind` | 对应节点类型 | 是什么 | 已在 Node-RED 里？ |
|---|---|---|---|
| `conversation` | `mcode.conversation` | **在主对话里说一句**（不是子会话） | ❌ |
| `command` | `mcode.command` | 本机跑 shell 命令，退出码+输出尾部给下游 | ❌ |
| `code` | （代码节点） | 跑一段代码 | ❌（Node-RED 有 `function` 节点，但语义不同） |
| `branch` | （分支） | 岔路口，选项是**边**不是参数表 | ❌（Node-RED 有 `switch`，可映射） |
| `condition` | （条件） | 条件判断 | ❌（可映射到 `switch`） |
| `prompt` | （提示词型工作流） | 纯文本流程，不是图 | ❌（**这类可能不该进 Node-RED**） |
| `trigger` | （触发器） | cron / fs.watch / 事件订阅 | ❌（Node-RED 有 `inject`/`http-in`，但 `mcode-trigger` 有宿主身份） |
| **`agent`** | `mcode.agent` | 子 agent | ✅ **已迁** |

## 三个必须先回答的问题（不回答就写实现卡，会写出错方向）

### Q1：哪些是真该搬的，哪些不该

**`prompt`（提示词型工作流）本质是「一段流程文字」，不是图。**
`WorkflowDocSchema` 的注释说得很清楚：

> 图型工作流留空（流程由节点表达）。两种形态并存是有意的：五个内置模式里有几个本质就是"一段流程"，硬掰成图反而是倒退。

**所以 `prompt` 很可能不该搬** —— 它属于「对话」，不属于「工作流」。
**这条要论证，不能默认全搬。**

### Q2：Node-RED 已有的节点，能不能直接代替，还是要写 `mcode-*` 节点

| 旧能力 | Node-RED 原生 | 够不够 | 判断 |
|---|---|---|---|
| `command`（跑 shell） | `exec` 节点 | **不够**：`exec` 没有 Mcode 的**审批门**与**工作目录围栏** | 要写 `mcode-command`（薄壳，内部调宿主） |
| `branch` / `condition` | `switch` | **够**：选项是边 | **直接用 `switch`**，不造新节点 |
| `code` | `function` | **不够**：`function` 跑在 Node-RED 进程里，没有 Mcode 的隔离/审批 | 要写 `mcode-code`（走受控子进程） |
| `conversation` | 无 | — | 要写 `mcode-conversation` |
| `trigger` | `inject` / `http-in` | **部分够**：但 `mcode-trigger` 有宿主身份与「这条 flow 归谁」的判定 | 已有 `t3-engine-trigger-gate` 的归属机制，要确认是否需要 `mcode-trigger` |

**关键原则**（来自 CLAUDE.md 与路线图）：**能复用上游就不造**。所以
`branch`/`condition` 一律用 `switch`，不写新节点。

### Q3：搬完之后，旧的 `ExecutionEngine` 怎么办

**这是最硬的一条。** 三个候选：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 彻底删** | 删 `executionEngine` + `runner.ts` 的图执行路径，只留 Node-RED | 最大；`mcode.agent` 等四个节点要先在 Node-RED 里可用，否则功能倒退 |
| **B. 冻结** | 保留代码但不接新图；旧图（`engine: "mcode"`）仍能跑 | 中；路线图说「不长期保留两套」 |
| **C. 迁移后删** | 先把七个能力搬完 + 旧图迁移到 Node-RED，再删 | 最稳，但要先有迁移器 |

**路线图 §5 的 MERGE-3/4 与「退场阶段 A→B→C」已经给了路径**：
并存 → 旧画布只读 → 删除手写画布。**现在已经到了「C 的前一步」**（画布已删，但执行器还在）。

## 后续卡的写法（按依赖排序）

| 卡 | 内容 | 依赖 | 前置条件 |
|---|---|---|---|
| **W8** | 回答 Q1/Q2/Q3，产出**逐能力迁移决策表** | 无 | **读卡 + 读源码，不改代码** |
| **W9** | 迁 `mcode-command`（含审批门与工作目录围栏） | W8 | 决策表说「要迁」 |
| **W10** | 迁 `mcode-conversation` | W8 | 同上 |
| **W11** | 迁 `mcode-code` | W8 | 同上 |
| **W12** | `branch`/`condition` → `switch` 的映射验证 | W8 | 决策表说「直接用上游」 |
| **W13** | 旧图（`engine: "mcode"`）→ Node-RED 的**迁移器** | W9–W11 | 七个能力都有对应节点 |
| **W14** | 删 `ExecutionEngine` 的图执行路径（退场 C） | W13 | 迁移器验过 |

**W8 必须第一个做**，因为 W9–W14 全部依赖它的决策表。

## 与其他主线的边界

- **UI 总控**：`ClassicShell.tsx` / `ThreePaneLayout.tsx` / `App.tsx` / `layout-*-smoke/`；
- **Office 总控**：`document/**`、`genoffice/**`；
- **扩展总控**：`modules/**`、`vscodeL1Bridge.ts`。

**我这条线只碰**：`apps/desktop/src/main/workflowEngines/**`、`apps/desktop/src/main/orchestration/{executionEngine,nodeTypes,runner,scheduler,automationRunner}*`、
`apps/desktop/src/renderer/components/settings/workflows/**`、`apps/desktop/scripts/{t8-node-red-u1,node-red-*,workflow-*}/`。

## 一条提醒（写给下一个读卡的人）

**「保留旧功能」不等于「把旧节点逐个搬过去」。** 有些能力在 Node-RED 里有原生对应
（`switch`），搬了反而多一套；有些能力（`prompt`）根本不属于工作流。

**W8 的价值就在于把这两类分清楚，而不是无脑照搬。**
