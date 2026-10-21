# T59｜选中的库文档要能装进 Node-RED 画布

| 项目 | 值 |
|---|---|
| 编号 | T59 |
| 类型 | **功能缺口**（T45 的①，T58 明确说没解决） |
| 优先级 | **最高** —— 用户点「编辑这张图」看到的是空的 |
| 建议并发 | 改 `workflowEngines/` + `settings/workflows/`；**与 T55 不冲突** |
| 预计规模 | 中 |

---

## 前置条件

- **T45 已完成**：`351e4d9b`（删画布，切原厂编辑器）
- **T58 已完成**：`74aeaa79`（保存回写工作流库）
- **T46 已完成**：`5b8f9cbb`（执行归属）

三条都齐，本卡才有意义 —— 缺任何一条，链路都是断的。

---

## 缺口（T58 回写原文）

> **T45 的①**：**未解决**。本卡解决已有 Mcode 标记/已在原厂内的 flow 经 Deploy 回写；
> 点击工作流库中某份文档目前仅跳到原厂编辑器页，**没有把选中的该份文档自动装入
> Node-RED 画布**。

**用户视角**：

```
工作流列表 → 点「编辑这张图」
  ↓
打开 Node-RED 编辑器
  ↓
画布上是空的（或者上一次打开的那张图）
  ↓
用户：「我选的那张图呢？」
```

---

## 现在的链路（实读）

### 已经通的

| 方向 | 实现 | 状态 |
|---|---|---|
| **Node-RED → Mcode 库** | `nativeLibrarySync.ts` 的 `syncDeployedNativeWorkflows` | ✅ T58 做的 |
| Mcode 库 → Node-RED flows.json | `migrateWorkflowDoc` | ✅ 有函数，但**没有调用入口** |

### 断在哪

`WorkflowNativeEditorEntry.tsx`（T45 新建，15 行）只做一件事：跳转到编辑器。
**它没有把选中的文档先写进 `flows.json`。**

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/renderer/components/settings/workflows/WorkflowNativeEditorEntry.tsx`
   —— T45 的入口（15 行）。
3. `apps/desktop/src/main/workflowEngines/nativeLibrarySync.ts` ——
   **T58 的反向链路**，本卡要做的是它的镜像。
4. `apps/desktop/src/main/workflowEngines/registry.ts` ——
   `mcode-deploy-final` 握手与 `syncLibrary` 的位置。
5. `apps/desktop/src/main/workflowEngines/flowMigration.ts` 的
   `migrateWorkflowDoc(doc, options)` —— 返回 `FlowMigrationResult`。
6. `apps/desktop/src/main/workflowEngines/nodeRedStorage.ts` ——
   怎么读写 `flows.json`。
7. `apps/desktop/src/main/workflowEngines/registry.ts` 的启动链 ——
   引擎启动时怎么加载 flows。

---

## 执行内容

### 第 1 步：确定「装进画布」的正确时机

**三个候选**：

- **A. 引擎启动前**：用户点「编辑」→ 把 doc 写成 `flows.json` → 再启动引擎
  - 优点：引擎一启动就加载好了
  - 问题：如果引擎已经在跑（用户之前开了别的），就要先停再启 —— 会打断
- **B. 引擎运行时，经 `POST /flows` 部署**：把 doc 迁移后走部署握手
  - 优点：不用重启
  - 问题：部署会触发 `mcode-deploy-*` 握手，可能与 T58 的回写形成循环
- **C. 每次打开编辑器 tab 时，让编辑器加载指定的 flow**

**倾向 A**，但要处理「引擎已在跑」的情况。

**关键约束**：**不能和 T58 的回写形成循环**。

```
现在：编辑器 Deploy → syncDeployedNativeWorkflows → 写 Mcode 库
如果：打开库文档 → 写 flows.json → 引擎加载 → 触发 deploy → 回写库
```

这个循环会覆盖用户刚改的东西。

**判据**：装载进去的那次**不能**被当成「用户 Deploy」。

### 第 2 步：实现装载

新增一个函数（建议与 `nativeLibrarySync.ts` 同目录，命名 `nativeLibraryLoad.ts`）：

```ts
export async function loadWorkflowIntoNative(
  workflowId: string,
): Promise<{ ok: true } | { ok: false; reason: string }>
```

流程：

1. 从 `workflow` 表读 doc
2. `migrateWorkflowDoc(doc)` → `FlowMigrationResult`
3. 如果迁移有 `unmapped` 或记不清的语义 → **拒绝并列出**
4. 写进引擎的 `flows.json`（走 `nodeRedStorage.ts`）
5. **标记这次写入不是用户 Deploy**（见第 1 步的循环问题）

### 第 3 步：UI 接线

`WorkflowNativeEditorEntry.tsx` 现在的行为（跳到编辑器）前面加一步：

```
点「编辑」
  ↓
调 loadWorkflowIntoNative(workflowId)
  ↓
成功了 → 跳编辑器
失败了 → 显示原因（"这张图有 N 个节点无法迁移到 Node-RED"）
```

**失败时不要静默跳到编辑器** —— 用户会以为装上了，实际上看到的是别的图。

### 第 4 步：跟 T46 的引擎归属对齐

T46 定了 `engine: "mcode" | "node-red"`。

- `engine === "node-red"` 的图 → 装载进去
- `engine === "mcode"` 的图 → **不装载**，而是提示用户「这张图归原生调度器，要不要切换到 Node-RED？」

**不要静默改 engine。**

---

## 边界（不要碰）

- **不改 `genoffice/`**。
- 不改 T58 的 `nativeLibrarySync.ts`（只允许在旁边加新文件）。
- 不改 T46 的 `workflowEngineSelection.ts`。
- 不改 `flowMigration.ts` 的映射规则（只用它，不改它）。
- 不改 Node-RED 上游。

---

## 验收判据

1. **两张工作流 A、B 交替打开**：点 A 的「编辑」→ 画布是 A → 关掉 → 点 B 的「编辑」→ 画布是 B（有断言）。
2. 迁移会丢数据的图 → **拒绝装载并列出丢什么**（有断言）。
3. 装载之后**不被回写成用户 Deploy**（有断言：装载后 `workflow` 表的 `updatedAt` 不变）。
4. `engine === "mcode"` 的图 → 不装载，给提示（有断言）。
5. 引擎已经在跑时点「编辑」→ 行为正确（要么重启引擎、要么走部署路径，二选一，说清楚）。
6. 现有 `workflow-*` / `flow-migration*` / `executor-gate-d` 全绿。
7. 双包 tsc 干净。
8. **变异验证**：撤掉装载 → 判据 1 红；撤掉「不算用户 Deploy」的标记 → 判据 3 红。

---

## 回写区要回答

- 最终选了 A / B / C 哪条时机？为什么？
- 「引擎已经在跑」的情况怎么处理的？
- 装载会不会覆盖用户在编辑器里还没部署的改动？（这是最危险的一条）
- `migrateWorkflowDoc` 对现有 13 份图（T45 验过的）装载后，Node-RED 里显示得对吗？
- T46 的 `engine` 字段怎么和这个装载入口配合？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
