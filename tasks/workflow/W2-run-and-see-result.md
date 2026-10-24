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
