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
