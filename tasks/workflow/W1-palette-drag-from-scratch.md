# W1｜从 palette 拖一个节点：把「从零搭工作流」变成可验收的旅程

- Status: ready-for-agent
- Category: **产品主线验收（Node-RED）**
- Priority: **P0 —— 这是「用户能不能用工作流」的第一个动作**
- Depends on: W0（基线核实）；`t8-node-red-u1` 现成 harness
- Exclusive writable files:
  - `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-build-from-scratch.ts`（新建）
  - `apps/desktop/scripts/t8-node-red-u1/journeys/index.ts`（注册新旅程）
  - `apps/desktop/scripts/t8-node-red-u1/editor-flow.ts`（**只追加**拖拽辅助函数）
  - **不改 `apps/desktop/src/**`**

## Required Skills
- `mcode-smoke`：U1 套件的跑法与退出码语义。
- `desktop-testing-electron`：真实 Electron 的输入事件与等待策略。

## 为什么是这件事

现有 U1 旅程 `node-red-canvas-load-edit-deploy-reopen`（459 行、12 步）覆盖了：
加载 → **导入现成夹具** → 部署 → 改节点名 → 单 owner → 跨进程 CAS → 重开。

**它没有覆盖「从零搭」。** 具体地：

```bash
$ grep -c "palette\|drag" apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts
0
```

**而这正是用户第一次打开工作流时会做的事。** 导入一个 JSON 是「我已经有图了」，
拖一个节点才是「我要做一张图」。

## 上游的拖拽机制（已核实，供你直接照着写）

`node-red/packages/node_modules/@node-red/editor-client/src/js/ui/palette.js`：

```js
$(d).draggable({
    helper: 'clone',
    appendTo: '#red-ui-editor',
    revert: 'invalid',          // ← 落点无效会弹回，所以落点必须真的在画布内
    revertDuration: 200,
    containment:'#red-ui-main-container',
    start: ...                  // dropEnabled = !(workspace locked)
    stop: function() { if (dropEnabled) {...} }
})
```

**三条约束**（直接影响你的写法）：

1. **`revert: 'invalid'`** —— 落点不在画布上，节点会弹回去。**必须精确落在
   `#red-ui-workspace-chart` 的可见区域内**，不能落在 palette 或 header 上。
2. **`dropEnabled` 依赖 workspace 未锁定** —— 新建的 tab 默认未锁，但**先确认一次**。
3. **jQuery UI draggable 需要真实的 mousedown → mousemove → mouseup 序列**，
   合成 DOM 事件不生效（本套件 `editor-flow.ts:66-68` 的 `sendInputEvent` 三件套正是为此）。

## 任务

### 一、在 `editor-flow.ts` 追加拖拽辅助（只追加，不改现有函数）

建议签名（你可以按实际需要调整，但**必须复用现有的 `js()` / `centerOf()` / `clickAt()`**）：

```ts
/** 从 palette 拖一个节点类型到画布坐标。返回是否落成。 */
export async function dragPaletteNodeToCanvas(
  wc: WebContents,
  nodeType: string,          // 例如 "inject" / "debug"
  target: { x: number; y: number },
): Promise<{ dropped: boolean; detail?: string }>;
```

**要点**：
- 起点用 `centerOf(wc, '#red-ui-palette-container .red-ui-palette-node[data-palette-type="<type>"]')`；
- 中间至少发 **2 次 `mouseMove`**（一次中间点、一次终点）——jQuery UI 需要位移才能触发 drag；
- 终点后 `mouseUp`，然后**等待 200ms 以上**（`revertDuration: 200`）；
- 判据：`RED.nodes.createCompleteNodeSet()` 里出现了该类型。

### 二、新建旅程 `node-red-canvas-build-from-scratch`

**必须完整走通这 6 步**，每步一个 `step.run(..., "名字", { assert: true })`：

| # | 步 | 判据 |
|---|---|---|
| 1 | 打开一个**空白**工作流（不是导入夹具） | `RED.nodes.createCompleteNodeSet().filter(n => n.type !== 'tab').length === 0` |
| 2 | **拖一个 `inject` 节点到画布** | 画布节点数 0 → 1，且类型是 inject |
| 3 | **拖一个 `debug` 节点到画布** | 节点数 1 → 2 |
| 4 | **把 inject 的输出连到 debug 的输入** | `RED.nodes.node(id).wires[0][0] === debugId` |
| 5 | **点部署** | 复用现有 `clickDeploy(wc)`；flows 落盘（复用现有 sha 比较方式） |
| 6 | **重开工作流，两个节点和连线都还在** | 重开后 `createCompleteNodeSet()` 的节点数 = 2，且 wires 指向不对 |

**第 4 步（连线）如果做不到，如实报告**：用 `RED.nodes.addLink()` 之类的**编辑器 API**
代替拖拽连线是**可接受的降级**，但要在回写里写明「这一步用的是编辑器 API，不是模拟鼠标拖线」。
**不要假装是鼠标拖的。**

### 三、变异验证

按本仓库纪律，新断言必须证明「它真的会红」：

1. **把「拖节点」那一步的返回值强制改成 `{dropped:false}`** → 第 2、3 步必须红；
2. **把第 4 步的连线断言改成恒真** → 必须能说清它能抓什么（如果改成恒真，第 4 步应当红）；
3. **还原后逐字节确认**（`git diff` 为空 或 `cmp`）。

**如果某条断言在变异后仍然绿，那说明它没在验那件事** —— 写进回写。

## 验收判据

1. 新旅程 **6/6 步全绿**，且 `run.mjs` 整体退出码 **0**；
2. **原有旅程 `node-red-canvas-load-edit-deploy-reopen` 仍然全绿**（不许回归）；
3. **变异验证**：撤掉拖拽 → 第 2/3 步红；还原后全绿；
4. **第 4 步用的是鼠标还是编辑器 API，明确写清**；
5. **不改 `apps/desktop/src/**`**（`git status` 里不能有产品代码改动）；
6. **不跑全量**。

## 边界

- 只改 `apps/desktop/scripts/t8-node-red-u1/` 下的三个文件；
- **不碰** `apps/desktop/src/**`、`tasks/T*.md`、`tasks/README.md`、其他总控的卡；
- **不改现有旅程的断言**（只新增旅程）。

## 跑法

```bash
cd apps/desktop
node scripts/t8-node-red-u1/run.mjs --only=node-red-canvas-build-from-scratch
```

**注意**：这是真 Electron 套件，单次要几分钟。**不要放在 shell 循环里跑**（esbuild 争用会产生假的非零退出码）。退出码语义：`0` 全绿 / `1` 预期红 / `2` 意外红。

## 回写

`tasks/workflow/W1-palette-drag-from-scratch.md` 末尾追加 `## 结果回写`：
每步的实测结果、第 4 步的实现方式、变异结果、套件数字、以及**任何你觉得卡上写错的地方**。
