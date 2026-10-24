# W2｜在 UI 里点一下，看到执行结果

- Status: **blocked-by W1**（等 W1 的「从零搭」旅程落地后再派）
- Category: **产品主线验收（Node-RED）**
- Priority: **P0 —— 与 W1 合起来才是「工作流能用」的完整闭环**
- Depends on: W1（拿到一张可操作的图）
- Exclusive writable files:
  - `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-run-and-see-result.ts`（新建）
  - `apps/desktop/scripts/t8-node-red-u1/journeys/index.ts`（注册）
  - `apps/desktop/scripts/t8-node-red-u1/editor-flow.ts`（**只追加**）
  - **不改 `apps/desktop/src/**`**

## Required Skills
- `mcode-smoke`：U1 套件跑法。
- `desktop-testing-electron`：真 Electron 输入与等待。

## 已经有什么、还缺什么

**无头层已经有了**（不要重复验证）：

`node-red-e2e-smoke` 真跑过 「Mcode 执行器 → Node-RED HTTP-in 流 → 返回值回灌」
（`main.ts:2` 的文件头原话），并断言了 `msg.payload` 回灌的内容。

**真 Electron UI 层没有**：

```bash
$ grep -n "debug\|sidebar\|注入" apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts
（只有第 6 行提到「注入」，是凭据注入，不是 inject 节点）
```

**所以缺口是：用户在画布上点一下 inject，能不能在 debug 侧栏看到输出的消息。**

## 任务

### 一、新建旅程 `node-red-run-and-see-result`

在 W1 建好的图上（inject → debug），**多走三步**：

| # | 步 | 判据 |
|---|---|---|
| 1 | 打开 debug 侧栏（`#red-ui-header-button-sidebar-button-debug` 或对应 selector） | 侧栏可见 |
| 2 | **点 inject 节点的按钮**（节点左侧的小方块） | 触发一次 |
| 3 | **debug 侧栏里出现那条消息** | 侧栏 DOM 里有 payload 文本 |

**如果第 2 步「点 inject 按钮」在真实 DOM 里点不到**（Node-RED 的 inject 按钮是
SVG 里的一小块），**降级为调用编辑器的 API**（如 `RED.nodes.getNode(id)` 的
`inject` 方法，或直接 `RED.view.select` + 触发），**但必须在回写里写明是降级**。

### 二、判据要说清「看到了什么」

**不要写「debug 面板有内容」这种模糊判据。** 具体要求：

- 断言 payload 的**具体文本**（W1 建图时可以给 inject 设一个固定 payload，比如 `"w2-probe"`）；
- 断言它出现在 debug 侧栏**而不是别的侧栏**（Node-RED 侧栏有多个 tab）。

### 三、变异验证

1. **把「点 inject」那一步改成空操作** → 第 2/3 步必须红；
2. 还原后逐字节确认。

## 验收判据

1. 3 步全绿，且断言的是**具体 payload 文本**；
2. **W1 的旅程仍全绿**（不许回归）；
3. 变异验证：撤掉「点 inject」→ 红；
4. 若用了 API 降级，明确写明；
5. 不改产品代码；
6. 不跑全量。

## 边界

- 只改 `t8-node-red-u1/` 下的文件；
- 不碰 `apps/desktop/src/**`。

## 回写

`tasks/workflow/W2-run-and-see-result.md` 末尾追加 `## 结果回写`：
三步实测、payload 文本、是否降级、变异结果、套件数字。

## 结果回写

执行时间：2026-10-24（会话 `94c213a0`）。**未提交**（协调者要求不 commit）。

### 0. 判据口径（两个已知前提）

- **包装器退出码**：`--only=<正式旅程>` 跑时，套件内**退 0**、`run.mjs` 包装器**退 1**（它写死「期望 1」）。本卡按协调者给定口径：**不把包装器 1 当失败**，看 `journey-result.json` 的 `literalStatus` / `expectation`。
- **旧红 `rename-node-via-tray`**：与本卡无关（W1 已用单文件 stash 对照证明），本卡不新增红。

### 1. 三步实测（+ 前置 + 旁证，共 6 个判据步 + 2 张截图）

最终确认跑：`.tmp/electron-u1/2026-10-24T11-18-20-496Z/node-red-run-and-see-result/journey-result.json`
`literal=PASS`、`expectation=all-pass`、8 个 step（6 判据 + 2 截图）、1 个 OS 进程、6092ms。

| 步 | 状态 | **实际观察到什么** |
|---|---|---|
| `build-inject-to-debug`（前置） | PASS / 3745ms | 空白画布起：`before:0`；两个 palette 拖拽都 `dropped:true`（`before 0→1`、`0→1`）；鼠标端口拖线 `linked:true`、`filterLinks=1`、`wires:["3014310d16134479"]`；起点 `(656,241)`、终点 `(876,241)` 两端 `inChart:true`。**同一组 `editor-flow.ts` 辅助函数，不是 import JSON、不是 `addLink`**。 |
| `deploy-with-fixed-payload`（前置） | PASS / 182ms | `setInjectPayload` 把模型改成 `{payloadType:"str", payloadValue:"w2-probe-1792840706571"}`；真点部署后磁盘 `flows.json` 从 `null` → `a9e031ed…c319`，解析出的 inject 带 `{"p":"payload","v":"w2-probe-1792840706571","vt":"str"}`。 |
| **1. `debug-sidebar-open`** | PASS / 6ms | `opened:true`、`cleared:true`、`chromeVisible:true`（debug 面板独有的清空工具条 `#red-ui-sidebar-debug-clear` 可见）、`messagesBefore:0`。**`clickedToOpen:false`、`visibleInitially:true`** —— 见 §5 第 1 条：debug 侧栏在新编辑器里**本来就是展开的**，本步如实记录而没有伪造点击。旁证 `runtimeState:{started:true, state:"running-class"}`（runtime 真的在跑，不是 safeMode）。 |
| **2. `click-inject-button`** | PASS / 369ms | 按钮 rect 实际几何 `{x:543, y:241, w:16, h:18, inChart:true, shape:"rect"}`；真发 `mouseMove → mouseDown → mouseUp`。**通知条文本 `["部署成功", "成功注入: w2-probe-1792840706571"]`**（`successCount:2, errorCount:0`）—— 证明 `POST inject/<id>` 被运行时接受（200），不是「点了但 HTTP 失败」。 |
| **3. `debug-shows-payload`（主判据）** | PASS / 1ms | 侧栏里**恰好 1 条**消息（`total:1, visible:1`）：`payloadText:'"w2-probe-1792840706571"'`（**带引号** → 字符串渲染，不是时间戳）、`sourceName:"节点: debug 1"`、`flowClass:"564eb380dfe221a7"` = 当前页签 id（`inCurrentFlow:true`、`quoted:true`）。 |
| `payload-on-disk-unchanged`（旁证） | PASS | 盘上 inject 的 payload 仍是 `{v:"w2-probe-1792840706571", vt:"str"}`，sha 仍是部署后的 `a9e031ed…`（点击 inject 没有改图）。 |

**主判据的「具体文本」是三个条件一起**：① 前缀固定 `w2-probe-`；② 后缀是本轮 `Date.now()`（同进程里不可能有第二条同后缀消息，排除残留）；③ 文本**带引号**（证明 `payloadType` 真的落成了 `str`，不是默认的时间戳）。

### 2. 第 2 步：**真鼠标，没有降级**

`clickInjectNodeButton()` 取 `<g class="red-ui-flow-node-button"><rect class="red-ui-flow-node-button-button" width=16 height=18>` 的矩形中心（实测 16×18 px，确实很小），确认落在画布可见区后发 `mouseMove → mouseDown → mouseUp`。

**上游依据**（`view.js:5653-5697`）：`click` 绑的就是这个 rect → `nodeButtonClicked` → inject 的 `button.onclick` → `doInject()`（`POST inject/<id>`）。**没有**退回 `RED.nodes.getNode(id).receive()` 之类的 API。

**唯一一处「不是鼠标」的地方**：给 inject **设 payload**（`setInjectPayload`）是直接改模型字段 + `redraw()`，没点编辑对话框。理由：W1 已证明「点托盘输入框拿不到焦点」是已知缺陷（`rename-node-via-tray` 的红，另一张卡负责），让 W2 押在那条坏路径上会把「跑一次 inject」的验收绑在一个已知红上。**payload 是被测数据的输入，不是被测动作**；被测动作（点按钮）是真鼠标。**这条已在函数注释里写明，不藏在回写里。**

### 3. 变异验证

每条变异前都 `cp` 了 pristine，跑完都 `sha256sum -c` 还原。

| # | 变异（撤掉什么） | 预期红 | **实际红** | 红因对不对 |
|---|---|---|---|---|
| M1 | `clickInjectNodeButton` 开头无条件早退（报 `clicked:true`，**不发任何鼠标事件**） | 第 2 步 | **`failedStep=click-inject-button`**（FAIL 后 runner 停，第 3 步没跑） | 是：`notified:false`、`notifications.texts:[]` |
| M2 | 第 3 步不读侧栏，直接返回空列表 | 第 3 步 | **`failedStep=debug-shows-payload`** | 是：证明第 3 步有独立判据，不是搭第 2 步通知的便车 |
| M3 | **点节点主体**而不是按钮（真实会犯的错：坐标取 `.red-ui-flow-node` 中心） | 第 2 步 | **`failedStep=click-inject-button`** | 是：`shape:"node-body"`、`notified:false`、`texts:[]` —— 证明「点哪里」是判据的一部分，点节点主体只会选中节点、不会注入 |

**还原后逐字节一致**：

```
a50b01ae…6815e  editor-flow.ts
994485db…57833  journeys/index.ts
8ea6988e…f4b3593  journeys/node-red-run-and-see-result.ts
```

**没做到的变异（照实说）**：
- **没有**单独变异「payload 文本」那三个条件（前缀/后缀/引号）。M2/M3 让第 3 步整体红，已经证明**这条判据在判东西**；但「如果只把 `quoted` 改成恒真，第 3 步还红不红」**没测**。风险：`quoted` 那条可能被 `payloadText.includes(probe)` 兜底 —— 不过它们是**不同条件**（有引号 vs 含子串），且我看了实际值 `'"w2-probe-…"'`，两者确实分别成立。
- **没有**验证「debug 侧栏收起时第 3 步会红」。设计上它应该红（`visible:true` 要求），但没实跑过。

### 4. W1 回归

```
node scripts/t8-node-red-u1/run.mjs --only=node-red-canvas-build-from-scratch
→ literal=PASS expectation=all-pass (2 OS processes)   套件内退 0
```

**W1 仍全绿**，`editor-flow.ts` 的 W2 追加没有破坏 W1 用的三个函数（`dragPaletteNodeToCanvas` / `dragNodeOutputToInput` / `canvasNodePorts`）。

### 5. 卡上写错 / 需要修正的地方

1. **「打开 debug 侧栏（`#red-ui-header-button-sidebar-button-debug` 或对应 selector）」—— 这个选择器不存在，而且 debug 侧栏默认就是开着的。**
   - 真实选择器是 `button[data-tab-id="debug"]`（`sidebar.js:239`）；卡里给的 `#red-ui-header-button-sidebar-button-debug` 在 5.0.8 里**零命中**。
   - 更要紧的是：`sidebar.js:42` 的默认布局把 debug 放在 right sidebar **bottom 段**且设为 active —— **新编辑器里它直接可见**。所以「打开 debug 侧栏」这个动作在默认状态下**无事可做**。本旅程如实记 `clickedToOpen:false / visibleInitially:true`，没有为了凑「点击」而伪造一次点击。

2. **「点 inject 节点的按钮（节点左侧的小方块）」—— 位置对，但左上角的按钮不是 `-x` 侧唯一元素。** 实测注入按钮 rect 只有 **16×18 px**，中心 `(543,241)`；`mouseMove → mouseDown → mouseUp` 三件套在真 Electron 下**能点中**（M3 反证：点节点主体就注入不了）。所以**不需要降级**，卡里「如果点不到就降级」的预案没用上。

3. **「W1 的图里 inject 没设 payload」** —— 准确：W1 拖出来的 inject 默认 `payloadType:"date"`（**每次注入是时间戳**，不是「没有 payload」）。所以断言具体文本必须显式设 str，本旅程做了（`setInjectPayload`）。

4. **「复用你刚才建的图，不要重建」在技术上做不到「复用磁盘状态」**：`build.mjs` 给每条旅程 mktemp **独立 `runDir`**，W1 部署的 `flows.json` 在 W1 进程退出后**不会**进到 W2（各自 `data/workflow-engines/node-red/`）。本旅程的「复用」= **复用 W1 的辅助函数与手势**，在 W2 自己的 runDir 里重建同一张 `inject → debug` 图。若协调者要的是「同一条旅程里接着 W1 往下跑」，那应该是把 W2 三步**追加进 W1 旅程**（本卡边界不是那样写的，我没改 W1 的 6 步）。

5. **第 1 步的判据「侧栏可见」能过，但它对默认状态几乎没有区分力**（本来就可见）。真正有区分力的是第 3 步的 `visible:true` + `flowClass` + `sourceName`。我在回写里把两者都记了，没有把第 1 步说成「证明了打开动作」。

### 6. 我觉得不对但没改的

- **`#red-ui-sidebar-container` 这个 id 是 5.0.8 的**。上游把它同时用于左右两条侧栏的父容器；本卡的选择器 `#red-ui-sidebar-container .red-ui-debug-msg` 依赖它。如果将来 Node-RED 改了这个外层 id，**第 3 步会红**（找不到消息），不会静默绿 —— 这是可接受的失败方向。
- **通知条会残留**：`doInject` 的成功通知 `timeout: 2000`，而「部署成功」那条是 `RED.notify(...)` 无 timeout（可能在页面停留更久）。第 2 步的判据是「**出现**含 probe 的成功通知」，不是「恰好一条」—— 所以残留不会造成假绿（probe 后缀是本轮唯一）。但如果有人把它改成 `texts.length === 1` 会不稳定。
- **`setInjectPayload` 绕过了编辑对话框的 `validate`**（`RED.validators.typedInput`）。本旅程只写 `vt:'str'`，是合法组合，下游部署与运行时都接受了（`payload-on-disk-unchanged` 与 debug 侧栏消息都证明了）。但**这不等价于「用户在对话框里输了一个字符串」** —— 对话框路径没有走过。真正的「编辑 inject payload」UI 旅程还没人写。
- **safeMode 与「部署即信任」**：`registry.ts:109` 的 `safeMode` 默认是 `MCODE_ENGINE_TRUSTED !== "1"`，而探针 runDir 是全新的、**没有** `engine-trust.json`（默认 untrusted）。但上游 `setFlows` 在收到 **full deploy** 时会 `delete settings.safeMode` 并真启动（`runtime/lib/flows/index.js:124-131`）。本旅程的首次部署正好走了 full（`deploymentType` 默认 `full`），所以 `runtimeState.started:true`。**如果将来有人把部署类型改成 "modified flows" 而画布又没改**，可能进了 safe 分支导致 inject 按钮 `node-button-stopped`、点击无效 —— 那时第 2 步会红，属于**可发现的失败**，不是静默绿。
