# T34｜执行归属：Mcode 原生调度器 vs Node-RED 运行时

| 项目 | 值 |
|---|---|
| 编号 | T34 |
| 类型 | **ARC-006 主线**（架构决策） |
| 优先级 | **高** —— T33 做完后必须回答，否则会出现「两套执行器跑同一张图」 |
| 建议并发 | 改 `workflowEngines/` + `orchestration/`；**先完成 T33** |
| 预计规模 | 中 |

---

## 问题

Mcode 现在有**两套工作流执行器**：

| | Mcode 原生 | Node-RED |
|---|---|---|
| 调度 | `orchestration/scheduler.ts`（就绪即派发、并发上限） | Node-RED runtime 的消息流 |
| 节点执行 | `orchestration/runner.ts` → `runtimeManager.sendTurn` | `mcode-agent` 节点 → port → 同一个 `runtimeManager` |
| 持久化 | `workflow` 表（sql.js） | `flows.json` |
| 续跑 | `runStore` | Node-RED 自己的 context |
| 审批 | `approvalBridge` | 也是 `runtimeManager`（经 port） |

**T30/T31 做完之后，两边都能跑同一张图的语义。** 这会带来真实问题：

- 同一张图被两边同时跑 → 两次执行、两倍 token
- `executorOwnership.ts` 的 owner 注册表只有一份，两边抢同一把锁
- 用户不知道「这个工作流到底归谁跑」

---

## 已有的机制（先读，别重复造）

`apps/desktop/src/main/workflowEngines/` 下已经有：

- **`executorOwnership.ts`** —— owner 注册表（T03/T10 做的），跨进程 CAS
- **`nodeRedOwnership.ts`** —— 从 Node-RED 的 flow 里提取「原生节点」的 flowId
- **`flowTrustGate.ts`** —— 未审批的 flow 不进 runtime
- **`registry.ts` 的 BOOTSTRAP** —— 部署必须走 `POST /flows` 的 owner 握手

**这套「谁拥有这条 flow」的机制已经存在**，本卡要做的是把它扩展到「整张图归哪个执行器」。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/main/workflowEngines/executorOwnership.ts` **全文**。
3. `apps/desktop/src/main/workflowEngines/nodeRedOwnership.ts` **全文**（83 行）。
4. `apps/desktop/src/main/workflowEngines/flowTrustGate.ts` **全文**。
5. `apps/desktop/src/main/orchestration/scheduler.ts` 的派发逻辑与并发上限。
6. `apps/desktop/src/main/workflowEngines/registry.ts:120-200` 的部署握手。
7. T33 的回写区 —— 它回答了迁移器能到什么程度。

---

## 执行内容

### 第 1 步：确定「一张图归谁」的判据

三个候选：

- **A：按工作流来源** —— 从 Mcode 新建的归原生，从 Node-RED 导入的归 Node-RED。
  简单，但用户改一次图就可能跨过边界。
- **B：按节点类型** —— 含 `mcode-*` 节点的必须走 Node-RED（因为只有它有那些节点），
  纯原生节点类型的可以走 Mcode 调度器。**但这样一张图会被拆开跑**，不现实。
- **C：整图归属，显式选择** —— 每个工作流有一个 `engine` 字段，用户显式选。
  迁移时按 A 推断默认值。

**倾向 C。** 理由：A 会因为编辑而漂移，B 会把一张图拆成两半。
C 的代价是用户要选一次，但**显式比隐式好**（仓库硬规矩 3「坏东西显式报出来」）。

### 第 2 步：加 `engine` 字段

- 契约（`packages/contracts/src/ipc/workflow*.ts` 或 `nodeType.ts`）给
  `WorkflowDoc` / `manifest` 加 `engine: "mcode" | "node-red"`。
- 旧数据默认推断：**能完整迁移到 Node-RED 的 → `node-red`，否则 `mcode`**
  （用 `roundTripMismatchPaths` 判）。
- **不要**默认全改成 `node-red` —— 那是静默改变用户既有工作流的行为。

### 第 3 步：调度器拒绝越界

- `orchestration/scheduler.ts` 遇到 `engine !== "mcode"` 的图 → **显式拒绝**，
  报「这张图归 Node-RED 执行」。
- Node-RED 侧同理：`flowTrustGate` / 部署握手拒绝非 `node-red` 的图。
- **双向 fail-closed**，不静默跳过。

### 第 4 步：切换引擎时的迁移

用户在 UI 上改 `engine` 字段时：
- `mcode → node-red`：跑 `migrateWorkflowDoc` + `roundTripMismatchPaths`，
  有丢数据就**拒绝切换并列出丢什么**。
- `node-red → mcode`：跑 `flowToWorkflowDoc`，同样检查。

### 第 5 步：运行看板的数据源

`WorkflowBoardPanel` 读 `workflowLive` 事件，那是 Mcode 原生调度器发出的。

- Node-RED 执行时，这些事件由谁发？
- T31 的 port 实现里，`mcode-agent` 节点的执行已经在 `runtimeManager` 里了 ——
  能不能从那里补发 `workflow.node.*` 事件？

**这是 T34 最实的一块**：让运行看板在两种引擎下都能工作。

---

## 边界（不要碰）

- 不改 `executorOwnership.ts` 的 CAS 语义（只允许扩展）。
- 不改 Node-RED 上游。
- 不改 `runner.ts` 的执行语义。
- 不删 `scheduler.ts`（它是原生引擎的调度器，仍要用）。
- 不改 `document/`。

---

## 验收判据

1. 每个工作流有明确的 `engine` 字段，UI 可见。
2. `engine: "mcode"` 的图被 Node-RED 拒绝执行；`engine: "node-red"` 的图被原生调度器拒绝。
   两条都有断言，且是**显式拒绝**（有可读原因）不是静默跳过。
3. 旧数据加载时，`engine` 按 `roundTripMismatchPaths` 正确推断（有断言）。
4. 切换引擎时，会丢数据的切换被拒绝并列出丢什么（有断言）。
5. 运行看板在两种引擎下都能显示步骤状态。
6. 现有 `executor-ownership-*` / `flow-migration-*` / `workflow-*` 套件全绿。
7. 双包 tsc 干净。
8. **变异验证**：撤掉调度器的越界检查 → 判据 2 红；撤掉切换前的迁移检查 →
   判据 4 红。

---

## 回写区要回答

- 最终选了 A / B / C 哪条判据？为什么？
- 旧数据里有多少张图能完整迁移到 Node-RED？（真实统计，不是估计）
- Node-RED 执行时，`workflow.node.*` 事件从哪发？
- 两张引擎同时存在，用户会不会看到「同一个工作流两个入口」？
- `executorOwnership` 的跨进程 CAS 在节点 port 场景下够用吗？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
