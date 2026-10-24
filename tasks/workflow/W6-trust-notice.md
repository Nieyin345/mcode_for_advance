# W6｜发布了的工作流，重启后不会自己跑——而且没人告诉用户

- Status: ready-for-agent
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

## 回写

`tasks/workflow/W6-trust-notice.md` 末尾追加 `## 结果回写`：
三步事实核准的实测、提示放在哪、最终文案、双向断言与变异结果、i18n 词条位置。
