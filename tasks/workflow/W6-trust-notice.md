# W6｜发布了的工作流，重启后不会自己跑——而且没人告诉用户

- Status: BLOCKED（2026-10-25：渲染端没有可验证的「部署成功」事实源；需先补契约/事件后才能满足本卡双向显隐验收）
- Category: **产品缺陷（Node-RED 自动化）**
- Priority: **P0 —— 用户以为「发布了 = 会自动跑」，实际不会**
- Depends on: W0（G5）
- Exclusive writable files:
  - `apps/desktop/src/renderer/components/settings/workflows/EngineRuntimePanel.tsx`
  - `apps/desktop/src/renderer/components/settings/workflows/WorkflowLibraryView.tsx`
  - `apps/desktop/src/renderer/lib/i18n/{zh,en}/`（新增词条）
  - `apps/desktop/scripts/` 下新建或延伸的套件

## Required Skills
- `codebase-design`：判断提示该放哪一层。
- `mcode-smoke`：无头断言。

## 缺陷（W0 实测 + 代码确认）

`registry.ts:412-420` 的注释原文：

> 持久化 flow 是否已被宿主标记为可信（Gate A 的「未审批 flow 重启后不得自动执行」）。
>
> 标记是宿主数据目录下的 `engine-trust.json`，**只有** `{"trusted":true}` 算数；
> 缺失、坏 JSON、其它形状一律 untrusted（fail-closed）。这里刻意**只读不写**：
> 写标记的入口**将来**接 Mcode 的 `workflow.approve`（工作流审查 + 真人点头），
> 本层不新造第二套授权通道。

**「将来」= 现在没有。** 实测：

```bash
$ grep -rn "isFlowTrusted" apps/desktop/src/main --include=*.ts
registry.ts:419:export function isFlowTrusted(...) { ... }     ← 定义
registry.ts:873:  MCODE_ENGINE_TRUSTED: isFlowTrusted(dir) ? "1" : "0",   ← 唯一读取点
```

**没有任何写入点。** 所以 `isFlowTrusted()` **永远返回 false**。

### 后果（按用户视角）

| 用户做的事 | 期望 | 实际 |
|---|---|---|
| 搭一张带 **inject 定时** 的流，部署 | 到点自动跑 | **重启后不跑** |
| 搭一张带 **http-in** 的流，部署 | 外部请求能进来 | **重启后 404** |
| 在**当前这次会话内**跑 | 能跑 | ✅ 能（不重启就正常） |

**W0 的原话**：「发布的 flow 重启后不自动执行，inject 定时/http-in 全 404。」

**而 UI 里没有任何地方说这件事**（`grep trusted|重启后` 在渲染端零命中）。

## 这不是「修个 bug」，是「承诺与现实的差距」

**修 `engine-trust.json` 的写入**是一个**授权设计问题**（谁批准、批准什么、怎么撤销），
需要 `workflow.approve` 那套审查 + 真人点头，**不是这张卡的范围**。

**这张卡只做一件事：让用户知道。**

## 任务

### 一、先确认「当前会话内能不能跑」

**在写提示之前，先把事实核准**（不要凭注释推断）：

1. 部署后、**不重启**的情况下，inject 定时 / http-in 能跑吗？
2. 重启后，同一张流还能跑吗？
3. `MCODE_ENGINE_TRUSTED=0` 时，上游 runtime 具体做了什么（哪些节点被跳过）？

**用 `node-red-e2e-smoke` 或新建探针验**，写进回写。

**如果发现「当前会话内也跑不了」，那这条的严重度要升级**，先告诉我再动手。

### 二、在 UI 上说清楚（这是本卡的核心）

**在用户能看到「发布/部署成功」的地方，加一条明确的说明。**

具体要求：

1. **位置**：`EngineRuntimePanel` 或 `WorkflowLibraryView` 里，用户部署成功后能看到的地方；
2. **措辞要准确**，不能含糊。**建议方向**（你定最终文案）：
   - 「这条流在当前会话内可以运行；**重启 Mcode 后不会自动运行**，因为宿主还没有工作流审查授权入口。」
   - **不要写**「即将支持」「敬请期待」这类空头承诺；
3. **i18n**：`zh` 与 `en` 都要加词条（`zh` 是 `MessageId` 的源，缺 key 会 typecheck 失败）；
4. **不要**做成一个可关闭的 toast —— 它是**持续事实**，不是一次性通知。

### 三、加断言

**断言这条提示真的出现**，且**只在它该出现时出现**：

1. 部署成功后 → 提示可见；
2. 提示文案里**包含「重启」和「不会自动运行」**这类关键语义（具体措辞你定，断言跟着你定的走）；
3. **正控**：未部署时**不显示**（不要变成常驻横幅，那样用户会忽略）。

### 四、变异验证

把提示的条件改成恒假 → 第 1 条必须红。
把条件改成恒真 → 第 3 条必须红。

**两个方向都要验** —— 只验一个方向，判据可能退化成恒真或恒假。

## 验收判据

1. **事实核准**：三种情形（不重启能跑 / 重启不跑 / 信任标记的作用）都有实测；
2. **UI 提示存在**，措辞准确、不承诺未来；
3. **`zh` / `en` 词条都在**，`maint-m37-smoke`（i18n 对齐）不红；
4. **断言双向**：该显示时显示、不该显示时不显示；
5. **变异双向**：恒假红第 1 条、恒真红第 3 条；
6. `tsc` EXIT=0；
7. 不跑全量。

## 边界

- 只改渲染端 + i18n + 套件；
- **不碰 `apps/desktop/src/main/**`**（写信任标记是另一张卡）；
- **不碰** `ClassicShell.tsx` / `ThreePaneLayout.tsx` / `App.tsx`（UI 总控）；
- 不碰 `tasks/T*.md`、`tasks/README.md`。

## ⚠️ 派活时总控追加：我核过上游，事实比卡面更精确 —— 别写成绝对说法

**上游源码**（`node-red/packages/node_modules/@node-red/runtime/lib/`）：

| 位置 | 行为 |
|---|---|
| `flows/index.js:320-327` | `if (settings.safeMode) { … state = 'safe'; emit('runtime-state', {state:'safe', error:'safe-mode'}); return; }` —— **装载了但一个节点都不启动** |
| `flows/index.js:124-131` | `if (settings.safeMode) { if (type !== "load") { type = "full"; delete settings.safeMode; } }` |
| `api/flows.js:314-316` | `state: "start"` 分支同样 `delete runtime.settings.safeMode` |

**所以准确的用户事实是三层，不是一句「重启后不跑」：**

1. **引擎启动时**（`registry.ts:109` `safeMode = process.env.MCODE_ENGINE_TRUSTED !== "1"`，
   而 `MCODE_ENGINE_TRUSTED` 来自 `registry.ts:873` 的 `isFlowTrusted(dir)`，恒 false）
   → **流被装载但不启动**（`state: 'safe'`）；
2. **用户只要在编辑器里点一次「部署」（full deploy）→ safeMode 被删掉、流真启动**
   —— 所以「当前会话内能跑」成立，且**重启后点一次部署也能跑**；
3. **但没有任何东西会替用户点那次部署** —— 重启后不打开编辑器、不点部署，
   inject 定时 / http-in 就是不会跑，而 UI 不说这件事。

**所以文案不许写成「重启后不运行」这种绝对说法**，那会误导用户以为流坏了。
正确的是：「重启后，**在你再次点部署之前**，这条流不会自动运行」。

**还有一层要注意**：引擎本身也**不会自动启动**（我 grep 过 `autoStart|startEngine|autostart`
在 `EngineRuntimePanel.tsx` 与 `apps/desktop/src/main/workflowEngines/` 都是零命中）。
所以重启后用户实际面对的是**两道手动步骤**（启动引擎 + 部署）。文案要把这个说清楚，
否则用户点了「启动」发现还是没跑，会以为是 bug。

**验证这三层是你的任务第一节的内容，别照抄我这段当结论** —— 我是读源码推的，你实跑一次。

## 回写

`tasks/workflow/W6-trust-notice.md` 末尾追加 `## 结果回写`：
三步事实核准的实测、提示放在哪、最终文案、双向断言与变异结果、i18n 词条位置。


## 2026-10-25 只读实测与阻塞回写

**状态：BLOCKED（产品代码未修改，不能伪称 UI 提示已落地）。**

### 真实 Node-RED 行为

- 本轮 `node apps/desktop/scripts/run-smokes.mjs node-red-e2e-smoke` **PASS（106/106）**，证据 `apps/desktop/.tmp/smoke-runs/1792871444125-43700-FKnpyi/node-red-e2e-smoke.log`。
- 未写信任标记：`MCODE_ENGINE_TRUSTED=0`，初始 `HTTP-in` **404**；经有凭据的真实 `POST /flows` 部署后 **200**（同一引擎会话内）。
- 部署后停止并重新启动：`flows.json` 中图仍在，`GET /flows` **200**，但未经审批的 `HTTP-in` **持续 404**。这是「图已保存、但重启没有自动执行」的直接证据。
- 测试手工写入 `engine-trust.json = {"trusted":true}` 后再重启，启动环境为 trusted 且 HTTP-in **200**；写坏 JSON 又回到 untrusted。**这些受控测试写入不等于生产应用具备批准入口**。
- 上游 `safeMode` 在未可信启动时阻止自动启动节点；显式 full deploy 在本次运行中可解除 safe mode。故将来的准确文案应包含「重新启动引擎，并再次点击部署之前，不会自动运行」，不能绝对说「重启后不能运行」。

### 无法在本卡范围内实现「已部署才显示、未部署不显示」

- 当前渲染端 `EngineRuntimePanel.tsx` 只通过 `api.workflowEngine.list/status` 获取 `WorkflowEngineStatusView`；`packages/contracts/src/ipc/workflowEngine.ts` 的公开状态只有 `engineId / state / port / reason / editorUrl`。
- `apps/desktop/src/main/ipc/workflowEngine.ts:90` 的 `toStatusView` 不输出部署 revision、是否已部署或 Node-RED safe-mode 的实时变化；`start/stop/list/status` handler 也不提供 `deploy succeeded` 事件。
- 因此「引擎 running + 已部署」与「引擎 running + 还未部署」在当前前端输入上可完全相同；使用 `state === "running"` 控制横幅必然破坏本卡正控「未部署时不显示」，使用库列表/已保存文档同样无法区分是否部署。
- 需要先在**另一个具备主进程/契约独占权限的切片**中提供**由 Node-RED 成功部署确认产生的权威状态**（至少 deployed / unknown，注意原生编辑器直接部署、重启、另一个窗口、失败/取消、版本变化的时序）。再由本卡接入渲染端并增加“恒假/恒真”双向变异。
- 本卡写入边界明确禁止触碰 `apps/desktop/src/main/**` 和契约；所以本轮**没有假造部署状态，也没有加常驻免责声明冒充按需提示**。未修改任何应用源码。必须由总控明确新的依赖/文件 owner 后再解除 BLOCKED。

**未达判据**：UI 条件显隐、i18n、双向变异、maint-m37-smoke 对齐和本卡产品改动 `tsc` 均尚未执行；只有真实 Node-RED 三态行为已验证。此任务应保持 BLOCKED，而不是 Done。
