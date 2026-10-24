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

1. 新旅程 **6/6 步全绿**；
   > **⚠️ 更正（W1 执行时发现）**：本卡原先写「且 `run.mjs` 退出码 0」是**自相矛盾的**。
   > `run.mjs:51` 写死「期望 1」——因为套件里有 `node-red-deliberate-failure` 这条**故意失败旅程**。
   > 所以 `--only=<正式旅程>` 跑时，**套件内部退 0、包装器必退 1**。**退出码 1 是正常的。**
2. **原有旅程 `node-red-canvas-load-edit-deploy-reopen` 不许因你的改动**新增红；
   > **⚠️ 它在我写卡时就已经红在 `rename-node-via-tray`**（W0 实测，通知遮挡）。你的责任是
   > **不新增红**，不是「让它全绿」。
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

## 结果回写

执行时间：2026-10-24（会话 `94c213a0`）。HEAD `0451709a`。**未提交**（卡要求不 commit）。

### 0. 开工前的工作区快照（重要：基线本来就是红的）

跑任何东西**之前**的 `git status --porcelain` 落盘在仓库根 `.tmp/w1-git-status-before.txt`。与 T8 相关的在途改动只有一处：

```
 M apps/desktop/src/main/workflowEngines/nodePackBundle.generated.ts   (1 增 1 删)
```

**旧旅程 `node-red-canvas-load-edit-deploy-reopen` 在我动手前就已经红了。**

**单文件回滚对照（按本仓库纪律，只 stash 这一个文件）：**

```
$ sha256sum apps/desktop/src/main/workflowEngines/nodePackBundle.generated.ts
80183258e50a13071b6d3657a4e0793c0db9481505fcf0a758beffd27f5b7a04
$ git stash push -u -m w1-temp-stash-nodePackBundle -- apps/desktop/src/main/workflowEngines/nodePackBundle.generated.ts
$ node scripts/t8-node-red-u1/run.mjs --only=node-red-canvas-load-edit-deploy-reopen
  → literal=FAIL expectation=unexpected-failure (failed at rename-node-via-tray)   exit=2
$ git stash pop
$ sha256sum ...nodePackBundle.generated.ts
80183258e50a13071b6d3657a4e0793c0db9481505fcf0a758beffd27f5b7a04   ← 逐字节归还
```

**结论：旧红与该生成产物无关。** 另外翻了 `.tmp/electron-u1/` 的历史：`2026-10-23T09-47-24-598Z` 那一跑就已经是同一条失败（`rename-node-via-tray`、`点名称框后焦点在「null」`），早于今天这份 node-pack 改动。

**失败形态（两次完全一致）**：托盘打开了（`trayOpened:true`）、输入框在视口内（`inputRect:{x:782,y:170,w:310,h:34}`、`inner:{w:1450,h:713}`），但真点之后 `document.activeElement.id` 是空串，`renameNodeViaEditor` 的补救点击也没拿到焦点。**这是编辑器页 `sendInputEvent` 焦点投递的问题，不是断言问题**；本卡不越界修它，照实记。

**所以本卡按协调者的判据验收**：新旅程 6/6 步全绿 + 旧旅程的红已证明与本卡改动无关。

### 1. 新旅程 6 步的实测输出

跑法（单次、不进循环）：

```
cd apps/desktop && node scripts/t8-node-red-u1/run.mjs --only=node-red-canvas-build-from-scratch
```

最终确认跑：`literal=PASS expectation=all-pass (2 OS processes)`、`U1 suite: 1 journeys — all-pass=1 expected-failure=0 unexpected-failure=0`。证据：`.tmp/electron-u1/2026-10-24T10-45-05-972Z/node-red-canvas-build-from-scratch/journey-result.json`（首跑是 `2026-10-24T10-38-42-714Z`，结论相同）。

| # | 步 | 状态 | **实际观察到什么** |
|---|---|---|---|
| 1 | `blank-workflow-open` | PASS / 2008ms | `nonTab:0`、`tabs:["流程 1"]`、`active:"流程 1"`、`locked:false`、`flowsOnDisk:false`。首次启动两层遮挡真的在：`consent` 框标题 `Enable Update Notifications`、点了 `No, do not enable notifications`；欢迎导览点了 `(close)`。引擎端口 7462。 |
| 2 | `drag-inject-to-canvas` | PASS / 612ms | 画布 rect `{left:215.6, top:40.6, w:1234.7, h:672.6}`，落点 `(635, 242)`。模型计数 `before:0 → after:1`；新节点 `{id:"7ab8da4478a0eae5", type:"inject", z:"f7fbbf0c56441dd3"}`。手势 `mouseMove → mouseDown → mouseMove(中点) → mouseMove(落点) → mouseUp`。 |
| 3 | `drag-debug-to-canvas` | PASS / 600ms | 落点 `(956, 242)`；`before:1 → after:2`；`types:["debug","inject"]`。 |
| 4 | `wire-inject-to-debug` | PASS / 556ms | **鼠标拖的**（见 §2）。起点 = inject 输出端口 rect 中心 `(656,241)`（`inChart:true`），终点 = debug 输入端口 rect 中心 `(876,241)`（`inChart:true`）；`linked:true`、`filterLinks=1`、`wires[0]=["19e078a512bf1347"]`（正是 debug 的 id）。 |
| 5 | `deploy-writes-native-flows` | PASS / 179ms | `clickDeploy` 真点（`deployDisabledBefore:false`，说明 dirty 状态确实把按钮点亮了）。盘上 `flows.json` 从**不存在**（`beforeSha:null`）变成 `8c10a77d…308c3c`。解析后：inject `{id:"7ab8da4478a0eae5", x:390, y:200, wires:[["19e078a512bf1347"]]}`、debug `{id:"19e078a512bf1347", name:"debug 1", x:720, y:200, wires:[]}`。部署告警没出现（`deployWarningConfirmed:false`）。 |
| 6 | `reopen-keeps-nodes-and-wire` | PASS / 25024ms | 真换了 OS 进程（`pids 30532 → 16676`，`generations:2`），引擎换端口（7462 → 3660）。重开后 `nonTab:2`、inject/debug 的 id 与部署前**完全相同**、`injectWires:["19e078a512bf1347"]`、`filterLinks=1`、`tabLabels:["流程 1"]`、DOM 里 2 个节点组；磁盘 sha 仍是 `8c10a77d…308c3c`（`bytesUnchanged:true`）。 |

（旅程共 9 个 step：6 个判据步 + 2 张截图 + 1 个 `relaunch` 占位。）

### 2. 第 4 步：**真鼠标拖线，不是编辑器 API**

`dragNodeOutputToInput()`（追加在 `editor-flow.ts`）的动作：

1. 用 `getBoundingClientRect()` 取 `.red-ui-flow-port-output rect` / `.red-ui-flow-port-input rect` 的**中心**，并核对两点都落在 `#red-ui-workspace-chart` 的可见矩形内；
2. `sendInputEvent` 依次发 `mouseMove(起点) → mouseDown(起点) → mouseMove(中点) → mouseMove(终点) → mouseUp(终点)`；
3. 判据：`RED.nodes.filterLinks({source,target}).length > 0`，且 `createCompleteNodeSet()` 里 inject 的 `wires[0]` 包含 debug 的 id。

**上游依据**（`node-red/packages/node_modules/@node-red/editor-client/src/js/ui/view.js`）：`portMouseDown` 绑在端口 `rect` 上（`:5958-5971` 区域的 `inputGroupPorts.on("mousedown", …)` 与 `:6024` 的 `portPort`），`mousedown` 进入 `RED.state.JOINING`；`mouseup` 命中目标端口才走 `portMouseUp`，那里才 `RED.nodes.addLink(link)`。**落在节点中间不算**（那是 `nodeMouseUp` 的另一条分支）。所以落点用的就是输入端口元素本身。

`RED.nodes.addLink` **只在变异 M2 之外的探索里没出现过；正式旅程里一次都没调**。

### 3. 变异验证（每条都先「撤掉证据源」，不是改比较表达式）

每条变异前都 `cp` 了 pristine 副本；每条跑完都 `sha256sum -c` 还原。**预期红 / 实际红**逐条列：

| # | 变异（撤掉什么） | 预期红 | **实际红** | 红因是不是我要证明的那个 |
|---|---|---|---|---|
| M1 | `dragPaletteNodeToCanvas` 开头无条件 `return {dropped:false}`（拖拽整体失效） | 第 2 步 | **`failedStep=drag-inject-to-canvas`**（FAIL 后 runner 立即停，第 3 步没跑） | 是：`detail:"W1 M1: forced dropped=false"`、`observed.dragged.dropped=false` |
| M1b | **只**让 `debug` 的拖拽失效（`nodeType === "debug"` 时返回 false） | 第 3 步红、第 2 步仍绿 | **`failedStep=drag-debug-to-canvas`**，前两步都 PASS | 是：证明第 3 步有独立判据，不是搭第 2 步的便车 |
| M2 | 删掉第 4 步的**全部鼠标手势**（直接 return，不建线） | 第 4 步 | **`failedStep=wire-inject-to-debug`** | 是：证明第 4 步真的靠鼠标手势取证 |
| M3 | 第 4 步 `wires` 那一半改判错的对象（`includes(injectId)` 而不是 `debugId`） | 第 4 步 | **`failedStep=wire-inject-to-debug`** | 是：说明 `wires[0]` 那条子判据**不是**被 `linkCount>0` 兜底着 |
| M4 | 第 5 步不点部署（`clickDeploy` 换成常量，保留 `clicked:true`） | 第 5 步 | **`failedStep=deploy-writes-native-flows`** | 是：没有部署就没有新的 `flows.json` |
| M5 | 第 6 步前把盘上 `flows.json` 删掉（模拟持久化失败） | 第 6 步 | **`failedStep=reopen-keeps-nodes-and-wire`**，`detail:"nonTab=0, idsMatch=false, wireKept=false, bytesUnchanged=false"`、`shaNow:null` | 是 |

**还原后逐字节一致**（`sha256sum -c` 三行全 `OK`）：

```
c258c13973df89ffe7054da8560673cdc4ae5857398b9bd40995908a4fc510b9  editor-flow.ts
54fa149557bd8dc7f690f54fb10818a72993caed87d22f9bfccd77f520e36c2a  journeys/index.ts
73df2d78051861101487a386c64d9ffc62310ceee037919cf8279dbaf51af1f9  journeys/node-red-canvas-build-from-scratch.ts
```

**没做到的变异（照实说）**：
- 「注释掉真代码」形态只对 M1/M2 做了等价物（整段 return 早退），**没有**逐条做「把断言注释掉」。本旅程的断言都是 `step.run` 的 `ok` 表达式，注释掉会让 `ok` 变 undefined → 直接 FAIL，与撤证据源等价。
- **没有**单独拆开验证第 5 步 `wrote`（字节变了）那一半：它与 `afterSha !== null` 有重叠，不是唯一证据源。

### 4. 旧旅程回归

```
cd apps/desktop && node scripts/t8-node-red-u1/run.mjs --only=node-red-canvas-load-edit-deploy-reopen
```

**仍然红在 `rename-node-via-tray`（`点名称框后焦点在「null」`），与开工前完全同一形态、同一步骤。** 前 7 步全 PASS（`engine-running` … `baseline-deploy`），第 8 步红。证据：`.tmp/electron-u1/2026-10-24T10-45-54-841Z`。**没有引入新的红。**

`node-red-canvas-load-edit-deploy-reopen.ts` **一行未动**。

### 5. 卡上写错 / 需要修正的地方

1. **「新旅程 6/6 步全绿，且 `run.mjs` 整体退出码 0」自相矛盾。** `run.mjs` 把「期望 1」写死（`run.mjs:51`），因为注册表里有 `expect:"fail"` 的 `node-red-deliberate-failure`。所以用 `--only=<新旅程>` 跑时套件内退 0、**包装器退 1**（它判 0 ≠ 1 = FAIL）；全注册表跑时旧红还会让它退 2。**验收判据应写成**「`--only` 跑的 `journey-result.json`：`literalStatus=PASS`、`expectation=all-pass`、6 个判据步全 PASS」，而不是「`run.mjs` 退出码 0」。

2. **`editor-flow.ts:66-68` 的「三件套」不是拖拽用的。** 那里是 `clickAt`（move → down → up），**没有中间位移**。jQuery UI 的 `_mouseDistanceMet`（`distance:1`）要求按住期间位置变化 ≥1px，down/up 同点不满足，所以卡里「复用它」做不到，必须新写带中间 `mouseMove` 的。已按后者实现。

3. **卡给的选择器不一定可见。** 「通用」分类折叠时 `data-palette-type` 条目 `offsetParent:null`。已在辅助函数里先点分类标题展开（真用户动作）再取 `centerOf`。

4. **卡的上游引用只读到 `palette.js`，但落点判定在 `view.js` 的 `chart.droppable({...})`。** `palette.js` 只管 `revert:'invalid'` 与 `dropEnabled`；决定「落点算不算」的是 droppable 的默认 `tolerance:"intersect"`（helper 与画布矩形相交）。只读 `palette.js` 会漏掉这一条。

5. **第 6 步判据「节点数 = 2，且 wires 指向不对」有笔误**（应为「指向对」）。已按后者实现：节点数 2、id 与部署前一致、`wires[0]` 含 debug id、`filterLinks>0`、磁盘 sha 未变。

### 6. 我觉得不对但没改的

- **旧旅程 `rename-node-via-tray` 红**：本卡边界是「不改现有旅程断言」，且它不是本卡的病灶。但失败形态（托盘开着、输入框在视口内、真点后 `activeElement` 为空）指向**编辑器视图焦点投递**问题，与 `renameNodeViaEditor` 的补救点击也没救回来一致的判断。**建议单开一张卡**：怀疑 `view.js` 的 `focusView()` 挂在 `mousedown` 上，把焦点从 tray 输入框抢走。

- **`run.mjs` 的「期望 1」与 `--only` 组合永远判 FAIL**：这是设计（它假定注册表含故意失败旅程），但对「只想跑一条绿旅程」的调试场景产生假红。**没改**（超出本卡边界，属别的主控的套件骨架）。调试时请看 `journey-result.json`，别看包装器退出码。

- **重开会重起引擎、换端口**（7462 → 3660）：`harness.startEngine()` 每代都跑。这符合「真持久化」语义，但**卡里没写引擎也会换端口**；谁想拿「端口不变」当「同引擎」的判据会踩坑。

- **M2 的变异实现里有一段不可达代码**（`return` 之后的函数声明），`esbuild` 只转译不报错；变异版没过 `tsc`（也没必要）。pristine 版本 `tsc` 干净（`TSC_EXIT=0`）。
