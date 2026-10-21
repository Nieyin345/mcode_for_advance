# T43｜`McodeAgentPort` 的生产实现 —— 节点真正跑在 Mcode 三引擎上

| 项目 | 值 |
|---|---|
| 编号 | T43 |
| 类型 | **ARC-006 主线**（用户：Node-RED 只加和 AI 交互的节点，引擎用我们自己的） |
| 优先级 | **高** |
| 建议并发 | 改 `src/main/workflowEngines/`；**必须先完成 T42** |
| 预计规模 | 中到大 |

---

## 一句话

`mcode-agent` 等 6 个节点现在只有一个**接口** `McodeAgentPort`，生产实现是空的。
本卡把它接到 `runtimeManager`（Mcode 的 provider 抽象层），
**Node-RED 自己不含任何 LLM 调用，AI 全部由 Mcode 三引擎提供。**

---

## 实读证据

### 1. 节点侧只认一个 port

```ts
// apps/desktop/src/main/workflowEngines/mcodeNodePack.ts
export interface McodeAgentPort {
  run(payload: McodeAgentRunPayload): Promise<McodeAgentRunResult>;
}
```

节点的注释写死了方向：

> 生产装配将来把 port 接到 Host RPC（三 SDK + 审批 + runStore）；测试注入假实现

全仓 grep `registerMcodeAgentNodes` —— **只在 `mcode-node-pack-smoke` 里被调用**，
生产零装配。

### 2. Mcode 的主流程本来就是三引擎

```ts
// apps/desktop/src/main/orchestration/runner.ts
:125  import { runtimeManager } from "@main/claude/RuntimeManager.js";
:1102 providerId: session.providerId,          // ← claude | pi | codex
:1625 const handle = await runtimeManager.sendTurn(target, {
        prompt, cwd, automationOrigin, memoryManagedByWorkflow: true, ... });
```

`runtimeManager.sendTurn()` 是**用户聊天框发一句话走的同一条路**
（审批、工具、会话、事件全都在里面）。

### 3. 引擎是独立进程，port 不能是进程内对象

```ts
// runtimeSupervisor.ts
command: environment.execPath,                       // 或 Electron 二进制
args: (port, dataDir) => [entry, String(port), dataDir],
env: { ...(options.env ?? {}), NODE_PATH: ..., ... }, // env 完全替换
```

所以 port 必须跨进程。**已有的管道就是答案**：`registry.ts` 的 `BOOTSTRAP`
里已经用 `process.send` 做了部署审批握手（`mcode-deploy-prepare` /
`mcode-deploy-reply` / `mcode-deploy-final`），有超时、有失败回包、有 423 语义。

---

## 开工前必读

1. `audit-ledgers/README.md`（规则）。
2. `apps/desktop/src/main/workflowEngines/mcodeNodePack.ts` **全文** ——
   `McodeAgentRunPayload` / `McodeAgentRunResult` / `snapshotMcodeNodeInvocation`
   的精确形状。
3. `apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts` **全文** ——
   另外 5 个节点的 port 形状（在文件头那张表里）。
4. `apps/desktop/src/main/workflowEngines/registry.ts:120-200` ——
   **现有的 `process.send` 握手**。本卡要复用这条管道，不要新开一条。
5. `apps/desktop/src/main/orchestration/runner.ts` 的 `startWorkflowRun` 与
   `runtimeManager.sendTurn` 调用点（:1600-1700）—— 看它怎么建会话、怎么收结果。
6. `apps/desktop/src/main/claude/RuntimeManager.ts` 的 `sendTurn` / `subscribe` /
   `usageOf` / `dispose` 签名。
7. `apps/desktop/scripts/mcode-node-pack-smoke/main.ts` —— 现有测试怎么注入假 port。

---

## 执行内容

### 第 1 步：扩展握手协议（复用现有管道）

在现有 `mcode-deploy-*` 旁边加三类消息，**同一套 `process.send`**：

```
子进程 → 宿主：{ kind: "mcode-node-request", id, nodeType, payload }
宿主 → 子进程：{ kind: "mcode-node-reply", id, ok, result?, error? }
宿主 → 子进程：{ kind: "mcode-node-progress", id, text? }   // 可选，长任务
```

**必须做到**：
- 每个请求有超时（与部署握手同量级，长任务可配）
- 宿主崩溃 / `disconnect` 时，在途请求全部回 `ok:false`，节点报错而不是永远挂着
- 不回包 = 节点 `node.error()`，**不静默成功**

### 第 2 步：宿主侧的执行器

主进程新增一个模块（建议 `workflowEngines/nodeRequestHost.ts`），按 `nodeType` 分派：

| nodeType | 执行 |
|---|---|
| `mcode-agent` | `runtimeManager.sendTurn()`，用节点配置的 profile/provider |
| `mcode-conversation` | 同上，但目标是**主对话会话**（用户可见） |
| `mcode-branch` | `decider:"model"` → 一次便宜的分类调用；`decider:"user"` → 挂起等真人（见第 4 步） |
| `mcode-trigger` | 订阅 Mcode 事件源 |
| `mcode-module-capability` | `ModuleHost.invoke`（走既有授权链） |
| `mcode-node-red-call` | 反调引擎 HTTP API（带宿主令牌） |

**关键**：`mcode-agent` 与 `mcode-conversation` **必须是同一条 `sendTurn`**
—— 仓库硬规矩 2「用户点的和 AI 调的走同一个函数」。
两者唯一的差别是目标会话不同，不是两套实现。

### 第 3 步：结果形状对齐

`McodeAgentRunResult` 现在是 `{ text, artifacts }`。
`runtimeManager` 的回合产出是事件流（`turn.done` / `message` / 工具事件）。

- **不要**在 T43 里发明第二套结果模型 —— 复用 `orchestration/runner.ts` 已有的
  「一次节点运行 = 一个 nodeSession」的做法（`nodeSessionOf(对话, 节点)`）。
- 从那个会话里取最后一条助手消息当 `text`，产出物走既有的 artifact 引用。

### 第 4 步：`mcode-branch` 的「等人」语义

`mcodeNodeTypes.ts` 头注已经点明这是**未决语义**：

> Node-RED 的消息流**没有持久挂起通道**（MERGE-0 未知语义 #2，需人工裁决）

两条路：
- **A**：节点**不挂起**，只在 `decider:"user"` 时把消息送到「等人工」的输出端口，
  由宿主在会话里问，用户回答后再由**上游**重新触发。节点本身无状态。
- **B**：用 Node-RED 的 context store 持久化状态 + 一个 resume 节点。

**选 A**，并在回写区说明为什么 B 不合适（引入第二套持久化，与 Mcode 的 runStore 冲突）。

### 第 5 步：审批

`runtimeManager.sendTurn` 自带审批闸门。**不要**在节点层再做一套。

要验证的是：节点触发的 agent 步骤里，需要审批的工具调用**真的会在 Mcode 主窗口
弹出审批卡**，而不是在 Node-RED 的子进程里静默失败。

---

## 边界（不要碰）

- **不改 `node-red/` 上游源码**。
- 不改 `registry.ts` 的 `BOOTSTRAP` 里已有的认证 / safeMode / 部署握手逻辑。
- 不改 `orchestration/runner.ts` 的既有语义（只允许复用它的函数，不改它）。
- 不新开 HTTP 端口给节点用。
- 不引入 Node-RED 社区包。
- 不改 `document/`（T28/T29）。

---

## 验收判据

1. `mcode-agent` 节点真跑一次：`inject → mcode-agent → debug`，deploy，
   debug 面板出现 `{text, artifacts}`，且 text 是真实模型回复。
2. 这次运行的 provider 与节点配置的一致（可用三家各跑一次，或用 provider 事件断言）。
3. 节点里触发一个需要审批的工具 → **Mcode 主窗口弹审批卡**，批准后节点才继续。
4. 引擎进程崩溃时，在途节点请求全部得到 `ok:false` 并可被 Catch 节点接住。
5. 超时：宿主 5 秒内不回包（测试注入），节点报错而不是永久挂起。
6. `mcode-conversation` 跑在主对话里，用户能在聊天流里看到。
7. `mcode-branch` 的 model/user 两条路都有断言。
8. 现有 `mcode-node-pack-smoke` / `node-red-e2e-smoke` / `workflow-engine-runtime-smoke`
   / `orchestration` 相关套件全绿。
9. 双包 tsc 干净。
10. **变异验证**：撤掉超时 → 判据 5 红；撤掉 `disconnect` 清理 →
    判据 4 红；把 `mcode-agent` 改成直接返回假文本 → 判据 1 红。

---

## 回写区要回答

- `runtimeManager.sendTurn` 的返回值能直接给出 `{text, artifacts}` 吗？
  不能的话，是从哪个事件里取的？
- 节点跑出来的会话，用户能不能在侧栏看到并继续聊？
- `mcode-branch` 的「等人工」最终选了哪条路？为什么？
- 三家 provider 各跑一次 `mcode-agent` 的结果差异有多大？
- 审批卡弹出时，Node-RED 的部署握手管道会不会被打断？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
