# T58｜T45 删画布后的三处遗留：两个套件红 + 一条功能缺失

| 项目 | 值 |
|---|---|
| 编号 | T58 |
| 类型 | **回归修复 + 功能补齐**（T45 留下的） |
| 优先级 | **最高** —— 工作流 UI 现在是半残状态 |
| 建议并发 | 改 `renderer/components/settings/workflows/` + `scripts/`；**与 T57 不冲突** |
| 预计规模 | 中 |

---

## 前置条件

- **T45 已完成**：`351e4d9b`，删了 `WorkflowCanvas.tsx`（685 行）
- **T50 已完成**：`7eb548c9`
- **无其它前置**

---

## 背景：T45 删了画布，但新入口没接完

T45 的回写区自己列了三条未闭环：

> ① 原厂入口可打开但**不能保证选中库文档在原厂编辑器内拖拽/保存**
> ② **原厂保存回写工作流库缺失**
> ⑥ 旧 `workflow-ui-smoke` 浏览器夹具仍以已删除的自绘画布 DOM 为前提而失败

**但 T45 漏报了一条**：`module-phase2-e2e-smoke` 也依赖那个画布。

---

## 三条要做的事

### A. `workflow-ui-smoke`（T45 自己承认）

浏览器夹具以已删除的 `WorkflowCanvas` DOM 为前提。

**要做的**：夹具改成针对**新入口**（`WorkflowNativeEditorEntry`）。
如果新入口没有可断言的 DOM（它就是个按钮 + 打开原厂编辑器），
那这个套件的价值就变了 —— **要么改断言目标，要么这个套件该退场**。

**判断依据**：`workflow-view-smoke` 在 T45 里是 763/763 全绿的，
说明已经有一套覆盖了工作流 UI。那 `workflow-ui-smoke` 还剩什么独有的？

### B. `module-phase2-e2e-smoke`（T45 漏报）

失败点：

```ts
// native-main.ts:54
await wait("document.querySelector('[role=button][title=\"File inspection\"]')");
```

它在**工作流画布的节点卡片**里找这个按钮。测试自己造了一张图：

```ts
{ id: "inspect", type: "mcode.module-capability", title: "File inspection", ... }
```

新入口打开的是 **Node-RED 原厂编辑器**，节点是 SVG/canvas 画的，
**不存在 `[role=button][title=...]` 这种 DOM**。

**要做的**：这个 e2e 的「原生窗口 + 真实调度 + 工作流 UI」这一段，
在新架构下没法用原来的选择器验。

两条路：

- **A1**：改成验 **Node-RED 里的节点**（查 `GET /flows` 或编辑器 DOM 的 `data-testid`）
- **A2**：如果这段的工作流 UI 验证意义已经不大（因为编辑器换成了原厂的），
  **把这段从 e2e 里摘掉**，在回写区说明它被哪个套件取代

**建议 A2**：`module-phase2-e2e-smoke` 的核心价值是「宿主 + 真实调度 + 隔离」，
不是「工作流画布长什么样」。那个画布已经被删了，验它没有意义。

**但摘掉之前必须确认**：那段里有没有别的断言（不依赖画布的）会被一起删掉。
有就保留。

### C. 保存回写工作流库缺失（**功能缺失，不是测试问题**）

T45 说的：

> ② 原厂保存回写工作流库缺失

意思是：用户在 Node-RED 编辑器里改了工作流、点了「保存」，
**Mcode 自己的工作流库（`workflow` 表）不会更新**。

**这是功能缺口。** 用户看到的是：编辑器里改好了，回到库列表还是旧的。

**要做的**：Node-RED 保存（`POST /flows`）成功后，把 flow 反向转回
`WorkflowDoc`，写回 `workflow` 表。

- 已有的 `flowToWorkflowDoc(flow)` 就是干这个的
- 已有的 `POST /flows` 握手（`registry.ts` 的 `BOOTSTRAP`）里有 `mcode-deploy-final`
  回包 —— 在那里接
- **注意**：T45 说的是「原厂保存」，要走的是**用户在编辑器里点 deploy** 那条路

**判据**：在编辑器里改一个节点标题 → 保存 → 回到 Mcode 工作流列表 → 看到新标题。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `tasks/T45-workflow-canvas-to-node-red.md` 的**回写区全文**。
3. `apps/desktop/src/renderer/components/settings/workflows/WorkflowNativeEditorEntry.tsx`
   —— T45 新建的入口（15 行）。
4. `apps/desktop/scripts/module-phase2-e2e-smoke/native-main.ts:54-90` —— 要摘的那段。
5. `apps/desktop/scripts/workflow-ui-smoke/` —— 旧夹具。
6. `apps/desktop/src/main/workflowEngines/registry.ts` 的 `BOOTSTRAP` ——
   `mcode-deploy-final` 握手的位置。
7. `apps/desktop/src/main/workflowEngines/flowMigration.ts` 的 `flowToWorkflowDoc`。

---

## 边界（不要碰）

- **不改 Node-RED 上游**。
- 不改 T50 的贡献点 schema。
- 不改 T57 的 `slidesExecutor`。
- 不改 `packages/contracts/`。

---

## 验收判据

1. `workflow-ui-smoke` 要么全绿，要么**明确退场**并在回写区说明被谁取代。
2. `module-phase2-e2e-smoke` 全绿（摘掉画布那段后，其余断言仍然有效）。
3. **在 Node-RED 编辑器里改一个节点标题 → 保存 → Mcode 工作流列表能看到新标题**（有断言）。
4. `workflow-view-smoke` / `flow-migration-smoke` / `workflow-engine-runtime-smoke` 不回归。
5. 双包 tsc 干净。
6. **变异验证**：撤掉保存回写 → 判据 3 红。

---

## 回写区要回答

- `workflow-ui-smoke` 和 `workflow-view-smoke` 的覆盖重叠多少？前者还有什么独有的？
- `module-phase2-e2e-smoke` 那段里，除画布外的断言有哪些？摘掉安全吗？
- 保存回写的触发点是 `mcode-deploy-final` 还是别的地方？
- `flowToWorkflowDoc` 能把用户在原厂编辑器里做的改动完整转回来吗？
- 「不能保证选中库文档在原厂编辑器内拖拽/保存」（T45 的①）本卡有没有解决？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
