# W4｜自动化预检说「缺执行器」，而这条流其实能跑

- Status: ready-for-agent
- Category: **产品缺陷（Node-RED 工作流）**
- Priority: **P1 —— 假失败，把用户指向错误方向**
- Depends on: W0（缺口，探针 `.tmp/w0/executor-registry-order-probe.ts`）
- Exclusive writable files:
  - `apps/desktop/src/main/orchestration/executionEngine.ts`
  - 新建 `apps/desktop/scripts/workflow-executor-registry-order-smoke/`
  - **不改 `apps/desktop/src/main/index.ts`**（装配顺序的另一半，见下）

## Required Skills
- `mcode-smoke`：无头主进程套件。
- `diagnosing-bugs`：先证明因果，再改。

## 缺陷（W0 探针实测）

```
$ node .tmp/w0/executor-registry-order-probe.ts
module singleton kinds BEFORE port set: [ 'command', 'code', 'module-capability' ]
module singleton kinds AFTER port set:  [ 'command', 'code', 'module-capability' ]
a fresh engine created after port set:  [ 'command', 'code', 'module-capability', 'node-red' ]

verdict:
  module singleton registers node-red: false
  per-run engine registers node-red:   true
```

**模块级单例 `executionEngine` 永远不注册 `node-red` 执行器**，而运行期新建的引擎有。

## 根因（代码位置已核）

`executionEngine.ts:265`：

```ts
if (workflowEngineUsable(NODE_RED_ENGINE_ID)) { engine.register(nodeRedExecutor(...)); }
```

`:142-146`：

```ts
function workflowEngineUsable(engineId: string): boolean {
  if (workflowEngineStatusPort === null) return false;   // ← 装配期必然是 null
  ...
}
```

`:280`：

```ts
export const executionEngine = createBuiltinExecutionEngine();   // 模块加载时执行
```

而 `index.ts:46` 先 `import { setWorkflowEngineStatusPort }`，`:86` 才调用它注入端口。
**模块单例在 import 那一刻就构造完了，那时端口还是 null。**

## 后果

| 消费方 | 读到什么 | 用户看到什么 |
|---|---|---|
| `scenePreflight.ts:75` | `executorKinds` 里没有 `node-red` | 场景预检说「缺执行器」 |
| `ipc/orchestration.ts:396` | 同上 | 同样的假失败 |

**而那条 flow 实际能跑**（运行期新建的引擎有 `node-red`）。

**假失败的代价**：用户以为是配置错了，去查一个不存在的问题；或者放弃用 Node-RED。

## 任务

### 一、先证明因果（不要直接改）

**判据**：让单例在端口注入**之后**仍拿到正确的 `kinds()`。

建议先写一个**不依赖修法**的探针，证明「顺序是唯一原因」：

1. 构造一个引擎，**在 `setWorkflowEngineStatusPort` 之前**创建 → kinds 无 node-red；
2. 同一个进程里，**在之后**创建 → kinds 有 node-red；
3. **中间不改变任何其他东西**。

**如果第 1、2 条结果与 W0 的探针一致，因果成立。**

### 二、选一个修法（论证哪个对）

**候选 A：把单例改成惰性**

```ts
let singleton: ExecutionEngine | null = null;
export function executionEngineInstance(): ExecutionEngine {
  return (singleton ??= createBuiltinExecutionEngine());
}
```

- 优点：改动小、语义清楚；
- 缺点：**所有消费方都要改成调用函数**（`executionEngine.kinds()` → `executionEngineInstance().kinds()`），
  而且要看有没有人在**端口注入之前**就用它。

**候选 B：让 `register` 延迟到首次 `kinds()` / `execute()`**

- 优点：消费方不改；
- 缺点：引擎内部多一层惰性状态，可能引入「注册两次」的风险。

**候选 C：改 `index.ts` 的装配顺序**（端口先注入，再 import 引擎）

- 优点：最贴近根因；
- 缺点：**`index.ts` 是别人的边界（本卡不许改）**，而且 ESM import 是提升的，
  顺序不一定可控。

**你要论证选哪个，并说明为什么不选另外两个。** 写进回写。

### 三、加断言

新建 `workflow-executor-registry-order-smoke/`，**必须包含**：

1. **正控**：端口注入后，单例的 `kinds()` **包含** `node-red`；
2. **负控**：端口**未注入**时（模拟装配早期），`kinds()` **不含** `node-red`（fail-closed 仍然正确）；
3. **回归**：`kinds()` 里 `command` / `code` / `module-capability` 三个内置执行器**一直都在**。

**第 2 条很重要**：修法不能变成「无条件注册 node-red」——那会让「引擎没起来」时
也声称能跑，是另一个方向的错。

### 四、变异验证

- 把修法撤掉 → 第 1 条必须红；
- **第 2、3 条必须仍然绿**（它们验的是另外两件事，不该被这个变异影响）。

**如果第 2 或 3 条跟着红，说明它们和修法耦合了** —— 重新设计。

## 验收判据

1. **单例在端口注入后 `kinds()` 含 `node-red`**（探针 + 断言双证）；
2. **端口未注入时仍不含**（fail-closed 未被破坏）；
3. **三个内置执行器不受影响**；
4. **变异**：撤修法 → 第 1 条红、第 2/3 条绿；
5. **`workflow-engine-*` 既有套件不回归**（至少跑 `workflow-engine-selection-smoke` 与 `workflow-engine-runtime-smoke`）；
6. `tsc` EXIT=0；
7. 不跑全量。

## 边界

- 只改 `executionEngine.ts` + 新建套件；
- **不碰 `index.ts`**（别人边界）；
- **不碰** `apps/desktop/src/renderer/**`（UI 总控）、`tasks/T*.md`、`tasks/README.md`。

## 一个提醒

**W0 发现这条时，`scenePreflight` 与 `ipc/orchestration.ts` 两处都在读单例。**
你改完之后要确认**两处都拿到正确结果**，不是只改一处。
（这正是 CLAUDE.md 里「T40 有两处注入，只包一处等于没修」的同类。）

## 回写

`tasks/workflow/W4-executor-registry-order.md` 末尾追加 `## 结果回写`：
因果证明、选了什么修法、为什么不选另外两个、四条断言、变异结果、套件数字。
