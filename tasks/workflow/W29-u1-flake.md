# W29｜U1 旅程的抖动：断言求值一次就下结论，而 DOM 还没重绘

- Status: ready-for-agent
- Category: **测试基础设施（不稳定，会误伤每一次改动）**
- Priority: **P1 —— 5 趟只有 1 趟全绿，会让所有人学会「这个套件红了不用管」**
- Depends on: W28（已交付，它发现了这条）
- 来源：W28 的执行会话，附三个探针

## 现象（W28 实测）

`t8-node-red-u1` **5 趟只有 1 趟全绿**。两种红：

| 红在哪 | 症状 |
|---|---|
| **`canvas-label-shows-rename`** | **失败时 DOM 快照里已经有目标名** —— 判据早了一帧，不是改名失败 |
| `step-09-screenshot` | `Current display surface not available`（generation 2，view 刚 attach 2ms） |

**W28 补了三个探针排除了 `opacity` 与时间退化**：
- rAF 不被 `opacity:0` 节流（67 vs 67 帧）；
- capture 不随时间退化（0.25–30s 全成功）；
- 顺序对照证明变量是先后，不是 `opacity`。

**所以它不是 W28 引入的，是既有的。**

## 核心缺陷：这条断言没有等待

`journeys/node-red-canvas-load-edit-deploy-reopen.ts:480-484`：

```ts
step.assertEvaluated(
  `[...document.querySelectorAll('.red-ui-flow-node-label-text')].some((n) => (n.textContent || '').includes(${JSON.stringify(RENAME)}))`,
  true,
  "canvas-label-shows-rename",
),
```

**`assertEvaluated` 求值一次就下结论。** 而改名是异步的：
`renameNodeViaEditor` 提交后，Node-RED 要**重绘**那个标签。

**W28 的观察是决定性的**：「失败时 DOM 快照里**已有**目标名」——
说明**它求值的那一刻还没重绘，而快照（稍后拍的）已经有了。**

**这是一个只在「快」的机器上才绿的断言** —— 也就是**越快越容易红**。

## 任务

### 一、先找出所有「求值一次就下结论」的断言

```bash
grep -n "assertEvaluated" apps/desktop/scripts/t8-node-red-u1/journeys/*.ts
```

**逐个判断**：它断言的 DOM 状态是**在某个动作之后立刻确定**的，还是**需要重绘/异步**的？

| 类型 | 例子 | 该怎么办 |
|---|---|---|
| **同步确定** | 「部署按钮 exists」 | 可以保持一次求值 |
| **异步 / 需重绘** | 「改名后的标签文字」 | **必须等** |

**把这张表写进回写。**

### 二、把「需要等」的改成轮询

**参考 `editor-flow.ts` 里已有的 `waitEditorReady` / `waitFor` 形状**（只读它，别改它）。

要求：
1. **等的是「条件成立」，不是固定 sleep** —— `waitFor(() => 条件, timeoutMs)`；
2. **超时时把「最后一次求值的实际值」写进 `detail`** —— 不要只说「超时了」；
3. **超时时间**要够（Node-RED 重绘通常 <1s，给 10s）；
4. **不要为了让它变绿而放宽条件** —— 「包含目标名」这个判据本身是对的。

### 三、`step-09-screenshot` 的 `Current display surface not available`

**W28 说它发生在 generation 2、view 刚 attach 2ms。**

**先查清**：
- 那是 `relaunch` 之后的新进程吗？
- `capturePage` 前有没有等 `view` 真正 attach？

**如果只需在截图前加一个「等 surface 可用」的重试** —— 那是正当修法（截图确实需要等）。
**如果它要求改 `driver/runner.ts` 的截图机制** —— **停下来告诉我**，那超出本卡。

## 验收判据

1. **`assertEvaluated` 的逐个分类表**（同步 / 需要等）；
2. **「需要等」的改成轮询**，且超时 `detail` 带实际值；
3. **连续跑 5 趟**（或至少 3 趟），**全部绿** —— 这是本卡的核心判据：
   **一次绿不算数，因为这个缺陷就是「有时绿」**；
4. **变异验证**：把等待改回「求值一次」→ **必须能复现至少一次红**
   （如果变异后 5 趟全绿，说明这个抖动还有别的原因，照实写）；
5. **不改判据本身**（「包含目标名」保持）；
6. `tsc` EXIT=0；
7. **不跑全量**。

## 边界

**可以改：**

- `apps/desktop/scripts/t8-node-red-u1/journeys/*.ts`
- `apps/desktop/scripts/t8-node-red-u1/editor-flow.ts`（**只追加**）

**不许碰：**

- `apps/desktop/scripts/electron-u1/driver/runner.ts`（W28 刚改完；若确实要改，先问我）
- `apps/desktop/src/**`
- 其它套件
- `tasks/T*.md`、`tasks/README.md`、`tasks/workflow/README.md`

**⚠️ 与 W26 的冲突**：W26 在 `apps/desktop/scripts/workflow-settings-entry-u1/`，
**它复用 `electron-u1/build.mjs` 但不改 `t8` 的文件** —— 不冲突。
**但开工前 `git status --porcelain apps/desktop/scripts/t8-node-red-u1/` 确认。**

## 回写

`tasks/workflow/W29-u1-flake.md` 末尾追加 `## 结果回写`：

1. `assertEvaluated` 的分类表；
2. 改了哪几条、怎么改的（贴关键代码）；
3. **连续跑的趟数与结果**（这是核心）；
4. **变异后能复现几次红**；
5. **你没能验证的东西**；
6. **W28 / 这张卡上写错的地方**。

## 一条判断标准

**「5 趟 1 趟绿」比「5 趟全红」更糟。**

全红时人知道它坏了；**1/5 绿时，人会重跑到绿为止** ——
而**重跑到绿，等于把断言变成了「随机抽样」**。

**这条缺陷的最坏后果不是它红，是它教人重跑。**


## 结果回写（2026-10-25，本轮：部分通过 / 尚未完成稳定性验收）

### 文件边界与修改

开工 HEAD `09ac246b`；开工前 `git status --porcelain apps/desktop/scripts/t8-node-red-u1/` 为空。仅修改：

- `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`
- 本任务卡追加回写；未触及 `apps/desktop/src/**`、共享 U1 driver、W26 或其他人的未提交文件。

原文件全部 `assertEvaluated` 逐项分类（在本目录的三个正常旅程及一条预期失败旅程中搜索，实际只有下表两项）：

| 断言 | 类型 | 原因 / 修法 |
| --- | --- | --- |
| `canvas-label-shows-rename` | **异步** | 节点编辑托盘提交后，Node-RED 画布标签下一帧/后续帧重绘。原来单次求值可能早于真实 DOM。改为按原选择器轮询 DOM 的 `textContent.includes(RENAME)`，最长 10s；失败带最后标签集合、尝试次数。 |
| `reopen-dom-label` | **异步** | relaunch 后原生编辑器异步加载并重画标签。相同条件轮询 10s；失败保留实际值。 |

此外，在 `canvas-loaded` 与 `canvas-reopened-final` 的截图步骤之前加入 `capturePage()` 就绪探针：每 250ms 检查一次，最长 10s；空图或异常都继续等待，超时将最后 `lastError` 输出到步骤证据。**未修改**共享驱动的截图行为，不以宿主窗口截图替代 Node-RED 原生视图。没有增加无条件 sleep。

### 实际回归证据

1. `git diff --check -- apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`：PASS。
2. `cd apps/desktop && node_modules/.bin/tsc.cmd --noEmit --pretty false`：EXIT=0。
3. 定向真实 Electron：`node scripts/t8-node-red-u1/run.mjs --only=node-red-canvas-load-edit-deploy-reopen`：**被测旅程本身 PASS**，跨两个真实 OS 进程，证据 `.tmp/electron-u1/2026-10-24T19-26-47-977Z/`。注意外层 `run.mjs` 退出 1：其正式逻辑要求故意失败旅程同时参加；`--only` 过滤掉故意失败后，底层 U1 退出 0，被外层按“缺负控”判失败。故不能把这条单独计成“包装器 PASS”。
4. **完整 T8**：`cd apps/desktop && node scripts/t8-node-red-u1/run.mjs` → **EXIT=0 / T8: PASS**；三个正常旅程分别 PASS（装载/编辑/部署/重开，从零拖拽连线部署，点击执行并看结果），故意失败旅程 `sentinel-label-must-not-exist` 按预期 FAIL；`unexpected-failure=0`。证据 `.tmp/electron-u1/2026-10-24T19-28-47-961Z/`。
5. 第二次完整 T8 重跑**未能启动测试**，受到其他对话的重型测试互斥锁保护：`Mcode heavy test busy (PID 19236, run-smokes (1 heavy suites))`，包装器 EXIT=5 BUILD CRASHED。这不是产品/断言失败，也**不是**本轮第二次 PASS；没有抢占/终止持锁者。

### 验收状态 / 未完成项

- ✅ `assertEvaluated` 分类、两个异步断言轮询及真实值超时诊断，保持原判据语义。
- ✅ 截图前检查原生视图是否可捕获；原生 driver 未改。
- ✅ 类型检查、单个完整 T8 套件及其故意失败负控通过。
- ❌ **“连续至少 3 轮全绿”尚未满足**（完整正式套件成功 1 轮；其后重测被别的进程的互斥锁挡住）。
- ❌ **将轮询恢复为单次求值后的变异复现未执行**，不能据一次绿宣称消除了全部抖动。
- ⚠️ 在本轮已完成的真实测试中没有再观察到 `Current display surface not available`；这仅证明该次路径通过，不证明截图竞态彻底消失。

卡上的现象（5 趟 1 趟绿）是 W28 当时的统计，并非本轮复现率；要等重型锁释放后继续 3–5 次连续回归 + 变异，才能把本卡从“部分通过”改为“验收通过”。
