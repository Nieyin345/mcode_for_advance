# W30｜稳定真实 Electron 的 Node-RED 拖拽输入

- Status: **completed-with-caveat**（3 轮完整 Electron 回归通过；`leftbuttondown` 单变量因果未证实）
- Category: **工作流主线验收基础设施（Node-RED U1）**
- Priority: **P0** —— 从零搭建与执行结果两条用户旅程共用真实鼠标拖拽，当前已出现跨轮失败。
- Depends on: W1、W2 已有实现；W29 稳定性验收被本卡的共享拖拽问题阻塞。
- Required Skills:
  - `mcode-smoke`：验证范围、失败证据与变异纪律。
  - `desktop-testing-electron`：Electron 原生输入事件、视图焦点与资源清理。
- Exclusive writable files:
  - `apps/desktop/scripts/t8-node-red-u1/editor-flow.ts`（本卡允许修改两个现有拖拽函数）
  - `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-build-from-scratch.ts`（仅为必要的输入状态诊断/断言）
  - `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-run-and-see-result.ts`（仅为必要的输入状态诊断/断言）
  - 本卡的结果回写
  - `tasks/workflow/README.md` 与 `audit-ledgers/Mcode_统一审查台账.md` 的本卡结果摘要
- 明确不修改:
  - `apps/desktop/src/**` 产品代码
  - `apps/desktop/scripts/workflow-settings-entry-u1/**`（W26 并行工作）
  - `apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts`（W29 独占）
  - 其他 U1 driver、其他任务卡与用户真实工作流数据

## 问题证据

2026-10-26 的两轮完整 `node scripts/t8-node-red-u1/run.mjs` 均未达到 T8 通过标准：

1. `.tmp/electron-u1/2026-10-26T06-21-12-866Z/`
   - `node-red-canvas-build-from-scratch` 通过。
   - `node-red-run-and-see-result` 在 `build-inject-to-debug` 失败，inject/debug 拖拽后节点数仍为 0。
2. `.tmp/electron-u1/2026-10-26T06-26-50-982Z/`
   - `node-red-canvas-build-from-scratch` 在 `drag-inject-to-canvas` 失败。
   - `node-red-run-and-see-result` 在 `build-inject-to-debug` 失败。

失败证据均显示：palette selector 存在、目标在画布可见矩形内、workspace 未锁定，但拖拽后节点数仍为 0。成功轮中同样的旅程可通过，说明存在输入事件不稳定或前置条件未充分验证的问题。当前 helper 的拖动中间事件使用 `button: "left"`；Electron 本地 `InputEvent.modifiers` 类型还定义了 `leftbuttondown`。这是待验证的根因线索，不能未经实测直接视为结论。

## 任务

1. 检查 Electron `sendInputEvent` 的鼠标状态语义，以及 Node-RED palette / port 上游处理；对间歇失败给出可复核证据。若单变量变异不能隔离唯一因果，必须明确标记未证实，不能把相关性写成根因。
2. 修复共享拖拽输入序列，至少覆盖 `dragPaletteNodeToCanvas` 和 `dragNodeOutputToInput`。必须保留真实 `mouseDown/mouseMove/mouseUp`，不得用 `RED.nodes.add`、`RED.nodes.addLink`、DOM 事件派发或其他模型/API 操作替代用户拖拽。
3. 对事件输入状态增加最少但有用的失败诊断：起点/终点、视图焦点、画布边界、workspace lock、拖拽前后节点/连线数量。不得只加无条件 sleep 或无限重试；不能把失败重试到绿而不报告第一次失败。
4. 运行 W1、W2 与完整 T8 的真实 Electron 旅程。修复后至少 **3 轮连续完整 T8 全绿**（三个正式旅程 PASS，故意失败旅程按预期 FAIL，`unexpected-failure=0`）。
5. 变异验证：撤去本卡修复的按键保持状态/关键输入事件后，至少一条真实拖拽旅程必须按预期红；恢复后逐字节确认。
6. 运行 Desktop TypeScript 检查与 `git diff --check`。

## 验收判据

- [x] 共享拖拽函数在 palette 节点和节点连线两类手势中显式表达按键保持状态。
- [x] 失败证据包含起止坐标、视图焦点、命中元素、画布边界、workspace 锁状态与拖拽前后节点/连线计数。
- [x] 3 轮连续完整 T8 真实 Electron 运行达到预期状态；故意失败旅程按预期 FAIL，`unexpected-failure=0`。
- [x] 删除 palette `mouseUp` 的变异使真实拖拽旅程红；恢复后源文件 SHA-256 与变异前完全一致。
- [x] Desktop TypeScript 检查与 `git diff --check` 通过。
- [x] 未触碰产品代码、W26、W29 专属旅程或真实用户工作流数据。

## 结果回写

### 执行结果（2026-10-26）

- **修改文件**：`apps/desktop/scripts/t8-node-red-u1/editor-flow.ts`、`apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-build-from-scratch.ts`。未修改产品代码或 W26/W29 专属旅程。
- **上游依据**：Electron `InputEvent.modifiers` 明确支持 `leftbuttondown`；Node-RED 上游在 `palette.js:370` 将 palette 项设为 jQuery UI draggable，在 `view.js:969` 将画布设为 droppable。共享 helper 现在在所有拖动 `mouseMove` 上显式携带 `leftbuttondown`，保留真实 `mouseDown/mouseMove/mouseUp`；失败详情新增 palette/target 坐标、`document.hasFocus`、activeElement、`elementFromPoint` 命中元素，连线失败还保留 source/target 端口、wires 与 linkCount。
- **连续完整 T8**：以下三轮连续通过，均为 `all-pass=3, expected-failure=1, unexpected-failure=0`，外层 EXIT=0：
  1. `.tmp/electron-u1/2026-10-26T06-38-41-666Z/`
  2. `.tmp/electron-u1/2026-10-26T06-41-12-542Z/`
  3. `.tmp/electron-u1/2026-10-26T06-43-20-376Z/`
- **恢复后额外确认**：变异恢复后再次完整 T8，`.tmp/electron-u1/2026-10-26T07-01-07-162Z/`，同样 `all-pass=3, expected-failure=1, unexpected-failure=0`，EXIT=0。
- **变异验证**：只移除 `leftbuttondown` 的 2 次 W1、1 次 W2 和 1 次完整 T8 运行仍通过，因此不能声称该 modifier 单独解释了先前的间歇失败。关键事件变异则有效：临时将 palette 拖拽的 `mouseUp` 改为普通 `mouseMove`，`.tmp/electron-u1/2026-10-26T06-55-52-680Z/` 在 `drag-inject-to-canvas` 按预期失败（EXIT=2）。恢复后 `editor-flow.ts` SHA-256 精确回到 `0240d1513be817b94845ac3b69cf6d2f444feb991c0bc6cd1ac27d7fc8c3d94b`。
- **静态验证**：`pnpm run typecheck`（apps/desktop）EXIT=0；`git diff --check` EXIT=0。
- **因果限制**：当前实现已达到 3 轮连续稳定验收，且测试对缺失关键 mouseUp 敏感；但 modifier-only 变异未复现失败，故先前间歇拖拽失败的唯一因果因素仍未隔离。保留该限制，不宣称已证明 `leftbuttondown` 是唯一根因。
