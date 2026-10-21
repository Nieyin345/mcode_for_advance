# T60｜Node-RED 原生节点也要进运行看板

| 项目 | 值 |
|---|---|
| 编号 | T60 |
| 类型 | **功能缺口**（T46 明确说没做到） |
| 优先级 | 中高 —— 用户放了原生节点，看板什么都不显示 |
| 建议并发 | 改 `workflowEngines/nodePackProductionPorts.ts` + `registry.ts` 的 BOOTSTRAP；**与 T59 不冲突** |
| 预计规模 | 中 |

---

## 前置条件

- **T46 已完成**：`5b8f9cbb`（执行归属 + 看板事件源统一）
- **T42 已完成**：`9d390a7e`（节点包装进 Node-RED）
- **无其它前置**

---

## 缺口（T46 回写原文）

> **尚未全覆盖**：验收 #5 对 **Node-RED 纯原生 `inject/switch/watch/exec`** 等
> 不经过 Mcode Host port 的节点，当前无法逐步补发 `workflow.node.*`；
> Mcode Host-backed 节点已接线。

**用户视角**：

```
用户在 Node-RED 编辑器里拖一个 inject → debug
点 Deploy
点「运行」
  ↓
运行看板：什么都不显示
```

而如果拖的是 `mcode-agent` 节点，看板就正常显示。

---

## 为什么现在只有 Mcode 节点能进看板

T46 的实现（实读）：

```ts
// nodePackProductionPorts.ts
runSelectedSession → 发 workflow.node.queued/progress/result
```

**只有经过 `McodeAgentPort` 的节点才发事件。** 因为那个 port 是 Mcode 自己写的，
它知道什么时候开始、什么时候结束。

**原生节点不经过 Mcode 的任何代码** —— 它是 Node-RED runtime 直接调度的。

---

## Node-RED 给的现成能力（关键）

Node-RED **本来就有一套运行时事件系统**，不需要改它的节点：

### 1. `RED.events`（运行时的 EventEmitter）

关键事件：

| 事件 | 何时触发 |
|---|---|
| `nodes:add` / `nodes:remove` | 节点增删 |
| `flows:started` / `flows:stopped` | runtime 启停 |
| `runtime-event` 带 `id: "node-status"` | **节点状态变化**（`node.status({...})`） |

### 2. `Node` 对象的 `status` 与 `send`

每个节点都有 `node.status({fill, shape, text})`。原生节点（`inject`/`switch`/`exec`）
**都调了它**。

### 3. `runtime.events.on("runtime-event", handler)`

在 `BOOTSTRAP` 里可以订阅。

**这意味着**：不需要改原生节点，**订阅 `runtime-event` 就能拿到每个节点的状态**。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `tasks/T46-execution-ownership.md` 的回写区 —— 尤其「看板」那一段。
3. `apps/desktop/src/main/workflowEngines/nodePackProductionPorts.ts` ——
   **Mcode 节点现在怎么发事件的**。
4. `apps/desktop/src/main/workflowEngines/registry.ts` 的 `BOOTSTRAP` ——
   要在里面加 `runtime-event` 订阅。
5. `apps/desktop/src/renderer/lib/workflowLive.ts` —— 看板消费的事件形状。
6. `node-red/packages/node_modules/@node-red/runtime/lib/api/comms.js` ——
   `runtime-event` 的实际形状。
7. `node-red/packages/node_modules/@node-red/nodes/core/common/21-debug.js` 等
   —— 看原生节点怎么调 `node.status`。

---

## 执行内容

### 第 1 步：先弄清 `runtime-event` 的实际形状

在真引擎里跑一次，抓 `runtime-event`：

```js
RED.events.on("runtime-event", (event) => {
  console.error("[probe]", JSON.stringify(event));
});
```

**产出**：一次 `inject → debug` 运行中，收到了几条、每条长什么样。

**这一步的产出写回写区，不是代码。**

### 第 2 步：在 BOOTSTRAP 里订阅

`registry.ts` 的 `BOOTSTRAP` 加一段：

```js
// 原生节点的状态 → 发给宿主，让运行看板能显示
RED.events.on("runtime-event", function (event) {
  if (!process.send) return;
  if (event && event.id === "node-status") {
    try {
      process.send({
        kind: "mcode-node-event",
        nodeId: event.data?.id,
        status: event.data?.status,
        at: Date.now(),
      });
    } catch (_) {}
  }
});
```

**注意**：
- `BOOTSTRAP` 是内联字符串常量，改它**必须 +1 `version`**
  （`bootstrapManifest.ts` 头注写死的规则）
- 不要在这里做重活 —— 它是子进程的主线程

### 第 3 步：宿主侧接住

`registry.ts` 里已经有 `process.on("message")` 的处理器（处理 `mcode-deploy-*`）。
加一类 `mcode-node-event`：

```ts
if (message.kind === "mcode-node-event") {
  // 转成 workflow.node.progress / workflow.node.result
  // 按 T46 的 tabId + docId 映射归到工作流
}
```

**关键**：T46 已经建立了「原生 tab → 工作流」的映射
（`Host-owned 原生 tab 映射`）。复用它，不要新造。

### 第 4 步：事件的粒度

`runtime-event` 的 `node-status` 只给「状态」（running / success / error + text），
**不给「这一轮跑了什么」**。

看板需要的是：

| 看板要的 | `runtime-event` 给不给 |
|---|---|
| 这个节点在跑 | ✅ `status.fill === "blue"` |
| 这个节点成功 | ✅ `status.fill === "green"` |
| 这个节点失败 | ✅ `status.fill === "red"` |
| 这个节点输出了什么 | ❌ **不给** |

**所以**：
- 状态列（跑 / 成 / 败）→ 用 `runtime-event`
- 产出内容 → 引擎的 `debug` 标签页才有，看板拿不到

**判据**：看板能显示「跑到哪一步、成没成」，**不要求显示产出内容**。
后者要另开卡（可能需要订阅 `debug` 流）。

### 第 5 步：Mcode 节点的事件不要重复

`mcode-agent` 等节点**已经在发** `workflow.node.*`。
加了 `runtime-event` 订阅后，它们会**多发一次**（因为 Node-RED 也会给它们发
`node-status`）。

**要做的**：在订阅里按 nodeId 过滤掉 `mcode-*` 类型的节点，
或者让两边合并同一条事件（按 nodeId 去重）。

---

## 边界（不要碰）

- **不改 `node-red/` 上游**。
- 不改 T46 的 `assertWorkflowExecutor` 与执行归属。
- 不改 T58 的 `nativeLibrarySync.ts`。
- 不改 `workflowLive.ts` 的既有事件形状（只允许加字段）。
- 不改 `mcode-*` 节点的既有事件发送逻辑。

---

## 验收判据

1. **在 Node-RED 里放 `inject → debug`，Deploy 后运行** → 看板显示 `inject` 与 `debug` 两个节点的状态（有断言）。
2. `mcode-agent` 节点**不重复计数**（一个节点一次运行只看板一条） （有断言）。
3. 节点失败（比如 `exec` 报错）→ 看板显示红色（有断言）。
4. 现有 `mcode-node-pack-smoke` / `node-red-e2e-smoke` / `workflow-engine-runtime-smoke` 全绿。
5. 双包 tsc 干净。
6. **变异验证**：撤掉 `runtime-event` 订阅 → 判据 1 红；撤掉 mcode 节点过滤 → 判据 2 红。

---

## 回写区要回答

- `runtime-event` 的实际形状是什么？一次 `inject → debug` 收到几条？
- `node-status` 的 `fill` 有哪几种颜色？分别对应什么？
- 原厂节点**没有**产出内容的事件吗？还是藏在别处？（比如 `debug` 的 `debug` 事件）
- Mcode 节点重复计数怎么去重的？
- 引擎重启后，看板能恢复状态吗？还是清空？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->


### 2026-10-21｜T60 执行结果

- **真实 Node-RED 5.x 事件形状纠偏（E2 + E1）**：`@node-red/runtime/lib/api/comms.js` 将 `node-status`（`{id, status:{fill,shape,text}}`）和 `runtime-event`（`{id,payload,retain}`，如 `runtime-deploy`/`runtime-state`）分别监听；**不存在** `runtime-event.id === "node-status"` 的节点执行流。未改 `node-red/` 上游。默认原生 `inject → debug` 在一次输入时不调用 `node.status()`，因此关联这次输入的 `node-status` 为 **0 条**；真实的 `onReceive/onComplete` 共 **4 条**（两个节点各 running/settled 1 条）。不能把 deploy/start 的全局 `runtime-event` 误计为节点执行事件。
- **接线**：引导脚本订阅 Node-RED 官方 `RED.hooks.onReceive/onComplete`、`RED.events.on("node-status")` 与 runtime-state（仅清理旧关联）；子进程 IPC **只发送节点 id/tab id/type/名称、`_msgid`、阶段、失败标志及截断状态文字，不发送原始 msg/输出**。宿主 `OwnedNodeRedRuntime` 以 T46 现有 `nativeTabs`、部署成功后的节点索引和 executor ownership 核对身份，转成同一 `runtimeManager.emitExternal` 的 `workflow.node.progress/result`；`BOOTSTRAP_VERSION` 3 → 4。只有已登记的 tab/node 能进入看板；原生节点独立使用 `@node-red-runboard:<workflowId>` 会话标识，避免冒充真实聊天。右侧看板在当前选中 workflowId 相等时也读取对应的原生运行。Mcode Host-backed `mcode-*` 类型在子进程采集入口排除，沿用 T46 原事件，不重复上报；父进程对同 runId/nodeId 的多次红灯与完成事件只记一条终态。
- **fill 观察（E1）**：真引擎 `exec` 退出非零时见 `blue`（进程开始）、`red`（执行失败）和空状态（清理），看板终态为 failed；上游 exec 的 spawn 分支还用 `yellow` 表示非零退出，因此宿主红/黄都按失败处理。常见 `green` 仅表示节点自身所声明的成功状态，不能把它当所有节点必发的事件；没有状态的 inject/debug 以 `onComplete` 成功为准。原厂消息内容属于 `debug` 节点内部 `sendDebug`/comms debug 通道；`node-status` 与 hooks 的本片 IPC 没有原始输出，本片按边界不展示产出内容。
- **引擎停止/重启**：子进程退出后 Host 清理 tab/节点索引和 ownership；重启按持久化 `flows.json` 重建归属和采集，**不从盘上恢复旧执行中的节点状态**。Renderer `workflowLive` 本来就是内存快照，已完成的旧卡仍可能留在进程内直到裁剪/用户清理，不宣称自动清空全部旧卡。
- **隔离真实引擎断言（E1）**：`apps/desktop/scripts/mcode-node-pack-smoke/main.ts` 真正以 Node-RED Admin POST /flows 部署原生 `inject → debug` 及会非零退出的 `exec`，POST /inject 触发，断言两原生节点有运行/成功收场、exec 失败、三个节点各只有一条终态、独立 tab 使用独立 namespace；再次部署带 `x-mcode.docId` 的原生节点 tab，断言归属进指定 Mcode 工作流；Mcode-agent/conversation 等已有 Host-backed 节点不从原生 hooks 重复出事件。
- **绿例与命令**：`node apps/desktop/scripts/run-smokes.mjs mcode-node-pack-smoke node-red-e2e-smoke workflow-engine-runtime-smoke` → **3/3 PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792577709804-17092-tlTYlu`；`pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json && pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` → **0 errors**。
- **变异红例（E1，均原样还原）**：①禁用 `onReceive.mcode-runboard` 时 `mcode-node-pack-smoke` **183/187**、inject/debug 的运行态断言红（实际 Node-RED 没有原题写的 `runtime-event.id=node-status`，只能按真实事件源撤掉采集）；②撤掉子进程 `mcode-*` 类型过滤后 **186/187**，Mcode 不重复断言红，能抓到来自 `mcode-agent`/`mcode-conversation` 的额外原生事件；回滚后 3/3 全绿。两次变异未修改 `node-red/`。
- **验收边界**：验收 #1 的 **Mcode 库工作流（有 `x-mcode.docId` 的 tab）**已取得真实引擎事件 + 宿主关联的无头断言（E1），但未进行真 Electron 手工打开看板的 U1 点击验证；不把无头 E1 冒充 U1。纯 Node-RED **没有库内对应文档的独立 tab**可产生带隔离 ID 的状态事件，但按 T58 规则不自动伪造 Mcode 工作流记录，不能声称它在选中的 Mcode 对话看板里自动出现。原题 #6 指定的 `runtime-event` 移除变异基于不成立的 Node-RED 事件前提，已用真实起作用的 `onReceive` 删除变异替代。产出内容属于后续卡，本片不取。
