# W3｜画布删了，但「点节点看参数」没接上

- Status: ready-for-agent
- Category: **产品主线缺陷（Node-RED 工作流）**
- Priority: **P0 —— 用户每天都会撞上：搭图时点不到节点、看不到参数**
- Depends on: W0（缺口 G2）
- Exclusive writable files:
  - `apps/desktop/src/renderer/components/settings/workflows/WorkflowLibraryView.tsx`
  - `apps/desktop/src/renderer/components/settings/workflows/NodeInspector.tsx`（若需）
  - `apps/desktop/scripts/workflow-view-smoke/main.ts`（**只追加**断言）
  - 新建 `apps/desktop/scripts/workflow-node-select-smoke/`（若现有套件不适合）

## Required Skills
- `mcode-smoke`：无头渲染端套件的写法。
- `codebase-design`：判断状态该进 store 还是留组件。

## 缺陷（W0 实测，`e2b` 证据）

**手写画布已在 T45 删除**（`grep -rn "WorkflowCanvas" apps/desktop/src/` = **0**），
工作流 UI 现在挂的是原厂 Node-RED 编辑器。**但删画布时，「选中某个节点 → 右侧看它的参数」
这条交互没有接上。**

证据：

```bash
$ grep -n "setSelectedNodeId" WorkflowLibraryView.tsx
195:  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);   ← 初始化
296:      setSelectedNodeId(selectNodeId);   ← openWorkflow 的初始值（打开时选触发器）
562:    if (!next.nodes.some(...)) setSelectedNodeId(null);   ← 节点没了就清空
718:      setSelectedNodeId(null);                               ← 清空
873:    if (selectedNodeId === id) setSelectedNodeId(null);     ← 删除时清空
```

**四处全是「初始化 / 清空」，没有一处是「用户点了某个节点」。**

后果：`NodeInspector` 恒显示「工作流本体」，**用户点不到某个节点、也看不到它的参数**。

## 为什么没被发现

```bash
$ grep -n "selectedNodeId:" apps/desktop/scripts/workflow-view-smoke/main.ts
552:        selectedNodeId: "B",
```

**套件直接构造组件并传 `selectedNodeId: "B"`** —— 它验的是「给了选中 id 之后渲染对不对」，
**不是「用户怎么让它变成 B」**。763 条全绿，但那条路径从来没被走过。

**这是 CLAUDE.md 第二十六条（套件验的是副本/绕过了真实入口）的又一实例。**

## 任务

### 一、先确认「点节点」现在到底走哪条路

**不要假设必须自己造一套选中机制。** 先查：

1. 工作流库视图里，节点是怎么渲染的（`WorkflowNodeCard`？列表？）；
2. 那个节点卡片上**有没有** `onClick`；
3. 如果有 —— 它调了什么？为什么没写回 `selectedNodeId`？
4. 原厂 Node-RED 编辑器那边选中节点时，宿主**收不收到**事件？（`documentView` 有没有选中同步）

**把答案写进回写**，再决定改哪里。**如果原厂编辑器已经能同步选中，那就不该在库视图再造一套。**

### 二、修法（按你第一步的发现选）

**情形 A：节点卡片有 onClick 但没接 `setSelectedNodeId`**
→ 接上即可。**最小改动。**

**情形 B：节点卡片没有 onClick**
→ 加一个，并确保它同时更新 `selectedNodeId`，让 `NodeInspector` 显示该节点。

**情形 C：原厂编辑器能同步选中**
→ 走那条路，**不要**在库视图造第二套选中状态（那会变成两套真相）。

**无论哪种，都不要动 `openWorkflow` 那个「打开时自动选中触发器」的既有行为。**

### 三、加断言（这是本卡的重点）

**现有的 `workflow-view-smoke` 用 `selectedNodeId: "B"` 直接构造，绕过了真实入口。**

⚠️ **更正（我先前判断错了）**：它不是纯逻辑套件——`main.ts:540-560` 的 `renderCriteria`
**真的用 `createElement(NodeInspector, {...})` + `html()` 渲染**，只是**直接喂了 `selectedNodeId: "B"`**。

所以你可以**复用它的渲染方式**（`createElement` + `html()` + `withLocale`），但**起点必须是「点击」**：

```ts
// 关键：不是把 "B" 传进去，而是先渲染一个 selectedNodeId=null 的树，再点
const before = html(createElement(WorkflowLibraryView, { ...selectedNodeId: null }));
// ↑ NodeInspector 应显示「工作流本体」
await clickNode(before, "B");      // 真实点击节点卡片
// ↑ 之后 NodeInspector 应显示 B 的参数
```

**如果现有的 `html()` 快照方式做不了「点击后重新渲染」**，那就用 `.tmp/` 下已有的预览台
（`ask-preview` / `retry-preview` / `card-preview` 是同类的真浏览器预览台），或者新建一个最小渲染套件。

**判据必须包含**：
1. 点击前，`NodeInspector` 显示「工作流本体」；
2. 点击节点 B 后，`NodeInspector` 显示 B 的参数；
3. 点击节点 C 后，切到 C（**不是叠加**）。

### 四、变异验证（不能省）

**把你的点击改成空操作** → 上面 3 条必须红。
**如果第 2、3 条仍然绿，说明你的断言没有真的依赖那次点击。**

## 验收判据

1. **用户点节点 → 右侧显示该节点参数**（有断言，且断言从点击开始）；
2. **变异验证**：点击变空操作 → 断言红；
3. **`workflow-view-smoke` 原 763 条不回归**；
4. `tsc` EXIT=0；
5. **不改 `apps/desktop/src/main/**`**；
6. 不跑全量。

## 边界

- 只改上面列的渲染端文件 + 套件；
- **不碰** `apps/desktop/src/main/**`、`tasks/T*.md`、`tasks/README.md`；
- **不碰其他总控的文件**（UI 总控占 `ClassicShell.tsx` / `ThreePaneLayout.tsx` / `App.tsx`；Office 与扩展总控各有边界）。

## 一个提醒

**`workflow-view-smoke` 763 条全绿是个陷阱**：它证明的是「给了选中 id 之后渲染正确」，
不是「用户能选中」。你改的时候别被这个绿安慰到。

## 回写

`tasks/workflow/W3-node-select-wiring.md` 末尾追加 `## 结果回写`：
第一步的四种答案、选了哪种修法、断言与变异结果、套件数字、**以及你觉得卡上写错的地方**。
