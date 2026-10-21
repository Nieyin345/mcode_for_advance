# T33｜工作流 UI：从手写画布切到 Node-RED 原厂编辑器

| 项目 | 值 |
|---|---|
| 编号 | T33 |
| 类型 | **ARC-006 主线**（用户：Node-RED 直接搬，画布也用它的） |
| 优先级 | **高** —— 这是「能抄就抄」在 UI 上最大的一处 |
| 建议并发 | 改 `renderer/components/settings/workflows/`；**先完成 T30**（节点要先能装进去） |
| 预计规模 | 中 |

---

## 现状：两套画布并存

| 画布 | 位置 | 行数 | 用途 |
|---|---|---|---|
| **`WorkflowCanvas.tsx`** | `settings/workflows/` | **685** | Mcode 手写的二维拖拽画布（松手写回 position、拖动连线、成环检测、自动布局） |
| **Node-RED 编辑器** | `editor-client` 的 `red.min.js` | 原厂 | 已作为 `WebContentsView` 嵌进 Pane（`EngineRuntimePanel.tsx:232` 的 `documentView.open({ workflowEngineId })`） |

**两套并存** = 用户在两处看到两种图，改一处另一处不会跟着变。

`WorkflowCanvas.tsx` 的文件头自己写着：

> 不引入 dnd-kit —— 仓库里 `@dnd-kit` 全是 sortable 的一维用法，
> 没有自由二维拖拽的先例，引进来反而要跟既有约定打架。

**这就是「自己写」的证据**：因为找不到现成的，所以手写了 685 行。

而原厂的编辑器**已经能用了**（T07 做完 pane 化）。

---

## 但有一个真实的差异（不能想当然）

两套画布的数据模型**不是一回事**：

| | Mcode 工作流 | Node-RED flow |
|---|---|---|
| 节点类型 | `manifest.runner.kind`（prompt / conversation / branch / command / code / module-capability / node-red-call / trigger） | `type` 字符串 |
| 图的形状 | `nodes[] + edges[]`（有显式边） | `nodes[] + wires[][]`（端口隐式连线） |
| 执行 | `orchestration/scheduler.ts` + `runner.ts` | Node-RED runtime |
| 持久化 | `workflow` 表（sql.js） | `flows.json` |

已经有 `flowMigration.ts`（`workflowEngines/` 下）在做转换。**本卡要确认它的
双向能力**，而不是假设。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/renderer/components/settings/workflows/WorkflowCanvas.tsx`
   **全文 685 行** —— 这是要退场的东西。记下它做了哪些事（拖拽、连线、
   成环检测、自动布局、缩放、框选？）。
3. `apps/desktop/src/renderer/components/settings/workflows/WorkflowLibraryView.tsx:1169`
   —— 它怎么调用 `WorkflowCanvas`。
4. `apps/desktop/src/renderer/components/chat/WorkflowBoardPanel.tsx` ——
   **这是运行看板，不是编辑器，要保留**。它读 `workflowLive` 事件，
   和编辑器是两件事。
5. `apps/desktop/src/main/workflowEngines/flowMigration.ts` **全文** ——
   现有的双向转换能力到哪一步。
6. `apps/desktop/src/main/workflowEngines/registry.ts` 的 `BOOTSTRAP` 与
   `runtimeSupervisor.ts` 的启动链 —— 编辑器 URL 从哪来。
7. `apps/desktop/src/renderer/components/settings/workflows/EngineRuntimePanel.tsx`
   —— 现在怎么把编辑器嵌进 pane 的。

---

## 执行内容

### 第 1 步：先量清楚流程迁移的双向能力

**不要直接删 `WorkflowCanvas`。** 先回答：

- `flowMigration.ts` 能把 Mcode 的 `nodes[] + edges[]` 转成 Node-RED 的
  `wires[][]` 吗？反向呢？
- 转过去再转回来，图会不会变形 / 丢参数 / 丢条件？
- `runner.kind` 与 Node-RED 节点类型的映射表在哪？完整吗？

**这一步的产出是回写区的一份对照表**，不是代码。

### 第 2 步：把编辑器设为**默认**绘制入口

在 `WorkflowLibraryView` 里，把「编辑这张图」的入口从 `WorkflowCanvas`
换成打开 Node-RED 编辑器（走 `EngineRuntimePanel` 已有的那条路）。

- 编辑器已经在 pane 里了，这里只是换入口。
- **保留**一个「只读预览」用 `WorkflowCanvas` 渲染（如果它还能工作），
  或者用一张静态图 —— 看第 3 步。

### 第 3 步：决定 `WorkflowCanvas` 的去留

三个选项，**先看第 1 步的结果再定**：

- **A**：完全删掉，所有绘制走 Node-RED 编辑器。
- **B**：降级成**只读预览**（不能拖、不能连），用在会话流里的小图。
- **C**：保留，作为「Mcode 原生工作流」的编辑器（与 Node-RED 工作流并存）。

**倾向 A 或 B。** 用户的要求是「Node-RED 直接搬」，两套编辑器不符合这个方向。

但如果第 1 步发现迁移会丢数据，**选 C 并在回写区说明为什么**。

### 第 4 步：会话流里的小图

`WorkflowBoardPanel`（657 行）现在画一张小流程图，用的是自己的一套渲染。

- 它显示的是**这次运行**的步骤状态（进行中 / 完成 / 失败 / 等人），
  不是可编辑的图。
- **保留它** —— Node-RED 的编辑器不适合做这个用途（太重，且要连引擎）。
- 但要确认：它读的数据源（`workflow.get` + `workflowLive` 事件）在
  Node-RED 托管之后还成立吗？

### 第 5 步：切换引擎的 UI

一个工作流用哪个引擎跑（Mcode 原生 vs Node-RED）现在有没有入口？

- 如果没有：在 `WorkflowLibraryView` 加一个来源徽标 + 切换。
- 如果有：确认切换时图能正确迁移（第 1 步的判据）。

---

## 边界（不要碰）

- **不改 `node-red/` 上游源码**。
- 不改 `WorkflowBoardPanel` 的运行看板语义（它是观察，不是编辑）。
- 不改 `orchestration/` 的执行逻辑。
- 不删 `FlowMigration` 已有的能力。
- 不改 `EngineRuntimePanel` 的引擎启停逻辑。
- 不改 `document/`（T28/T29）。

---

## 验收判据

1. 从工作流列表点「编辑」→ 打开 Node-RED 原厂编辑器，能拖节点、连线、保存。
2. 保存后回到列表，图的内容与编辑器里一致（往返一次不丢数据）。
3. 一个既有工作流（含 `prompt` / `branch` / `command` 节点）能正确显示在
   Node-RED 编辑器里，类型映射正确。
4. 运行看板仍能显示这次运行的步骤状态。
5. 现有工作流相关套件全绿（`flow-migration-smoke` / `workflow-*` / `orchestration-*`）。
6. 双包 tsc 干净。
7. **变异验证**：撤掉类型映射的一项 → 判据 3 红；断掉保存回写 →
   判据 2 红。

---

## 回写区要回答

- `flowMigration` 的双向能力到什么程度？往返一次会丢什么？
- `WorkflowCanvas` 最终选了 A / B / C 哪条？为什么？
- Node-RED 编辑器的保存是写 `flows.json`，Mcode 的 `workflow` 表怎么同步？
- `WorkflowBoardPanel` 的数据源在切换后还成立吗？
- 用户在 Node-RED 编辑器里能看到 Mcode 的 6 个节点吗？（依赖 T30）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
