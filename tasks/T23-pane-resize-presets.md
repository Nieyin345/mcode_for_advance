# T23｜Pane 的剩余能力：可调分割线 + 布局预设 + 重置

| 项目 | 值 |
|---|---|
| 编号 | T23 |
| 类型 | ARC-005 UI（T02 续篇） |
| 优先级 | 中 |
| 建议并发 | 改 `components/layout/`，不要与任何改 Pane 的任务并行 |
| 预计规模 | 中 |

---

## T02 已经做了什么、还差什么

T02 已交付（`8e486757` + `12dfd270` + `161583a1` + `ed2e3b02`）：
- 三向停靠（left / right / bottom）
- 50/50 双击吸附（走直接设宽，避开双重取反）
- 同侧多 pane 总宽 ≤ 100 的夹取
- 损坏布局的解析与提示
- 真 Electron 下的 PTY/Monaco 保活验证

**T13/T19 的结论是**：Node-RED 的 `editor-client` 要作为唯一画布嵌进 Pane，
所以现在**必须**把这些补上：

| 缺口 | 为什么现在需要 |
|---|---|
| **用户可拖的分割线比例** | 现在只有「双击 50/50」，不能让用户拖到任意比例。Node-RED 编辑器与聊天的比例必须可调 |
| **布局预设** | 用户需要「聊天优先 / 编辑器优先 / 对半」这类一键切换 |
| **重置布局** | 布局拖乱了要能一键回默认 |

---

## 开工前必读

1. `apps/desktop/src/renderer/components/layout/paneLayout.ts`（约 130 行）——
   `PaneLayout` / `PanePlacement` / `clampLayout` / `movePane`。
2. `apps/desktop/src/renderer/components/layout/ThreePaneLayout.tsx` ——
   现有的双击吸附、拖拽停靠、`DockSide`。
3. `apps/desktop/src/renderer/components/layout/Divider.tsx` ——
   **已有**的通用分割条（指针捕获 / 键盘 / IME / ResizeObserver）。
4. `apps/desktop/src/renderer/stores/paneWidthWriteQueue.ts` —— 写入队列。
5. `open-claude-ui/code-examples/ArtifactsSplitPaneResizer.tsx` 的
   **18% / 82% 折叠门限** 与 **380 / 420 最小宽**。

---

## 执行内容

### 1. 可拖的分割线（复用 Divider）

- `Divider` 已经能拖，问题在于 `ThreePaneLayout` 现在只用它做「停靠换边」，
  没有把它接到 `sizePct` 的连续调整上。
- 接上：拖动时更新对应 `PanePlacement.sizePct`，松手走
  `paneWidthWriteQueue`（已有）。
- **折叠门限**：拖到 < 18% 或 > 82% 时触发折叠（照抄 ArtifactsSplitPaneResizer）。
- 最小宽度：左 380px / 右 420px（照抄）。

### 2. 布局预设

三个预设，每个是一个 `PaneLayout` 常量：

```ts
export const LAYOUT_PRESETS = {
  chat:      /* 聊天优先：左 18% / 右 22% */,
  editor:    /* 编辑器优先：左 0（折叠） / 右 60% */,
  balanced:  /* 对半：左 22% / 右 50% */,
} as const;
```

- UI 入口：顶栏或右栏头部的一个下拉（复用 `Menu`）。
- 切换时走 `withViewTransition`（仓库已有）让布局平滑过渡。

### 3. 重置布局

- 一键回到 `DEFAULT_PANE_LAYOUT`。
- 放在同一个下拉里，或 `Ctrl/Cmd+Shift+0`。

### 4. 测试

- 在 `arc005-pane-free-grid-smoke` 里补（不新建套件）：
  - 拖动更新 `sizePct` 且经过夹取
  - 18%/82% 折叠门限
  - 三个预设的 `clampLayout` 结果合法
  - 重置回默认
- **行为断言**，不是源码字符串。

---

## 边界（不要碰）

- 不改 `paneDock.ts`（6 套 smoke 依赖）。
- 不改 `Divider.tsx`（它已经写好）。
- 不改 Node-RED vendor（T19 的产物）。
- 不改 `ComposerEditor.tsx`（T18 刚改）。
- 不改主进程。

---

## 验收判据

1. 分割线可拖，`sizePct` 连续变化并持久化（有断言）。
2. 折叠门限 18%/82% 生效（有断言）。
3. 最小宽度 380/420 生效（有断言）。
4. 三个预设切换后 `clampLayout` 结果合法（有断言）。
5. 重置回默认（有断言）。
6. 现有 7 套 `arc005-pane-*` smoke 全绿。
7. 双包 tsc 干净。
8. **变异验证**：撤掉折叠门限 → 断言红；撤掉最小宽度 → 断言红。

---

## 回写区要回答

- 拖动时是直接改 `sizePct` 还是走别的路径？持久化走哪条队列？
- 折叠门限触发后，用户怎么恢复？
- 三个预设的具体数值是多少？为什么这么分？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21 执行结果（T23）

- 实现：`paneLayout.ts` 新增三种 `LAYOUT_PRESETS`、`setPaneSizePct`，保持同侧份额总和 ≤ 100；`ThreePaneLayout` 复用原有 `Divider` 指针捕获，拖动时直接更新右栏 `PanePlacement.sizePct`，松手由 `sessionStore.setPaneRightSizePct(..., true)` 提交到已有 `schedulePaneWidthPersist` → 400ms 防抖 → `createCoalescedPaneWriter` → `ui.paneLayout`。键盘调整即时提交；Escape 恢复起始尺寸，不落库。保留双击直接像素设宽并同步 50% 的 placement。
- 折叠与恢复：指针比例 <18% / >82% 产生 0%/100% 折叠。右 Pane 被折叠后可从顶栏「显示右侧栏」恢复为 30%；中心区域被折叠后从「布局」下拉选预设或重置恢复。可行窗口宽度下按左 380px / 右 420px 限制拖动值。
- 预设：聊天优先 left18% / right22%，编辑器优先 left0% / right60%，对半 left22% / right50%；editor 虚拟份额为 0，避免同侧夹取抢占右栏实际比例；bottom30%。顶栏 `Menu` 单入口，切换 `withViewTransition`，重置深拷贝 `DEFAULT_PANE_LAYOUT`，不重挂载 Pane 子树。
- 验收：1、2、3、4、5、6、8 已通过。原套 `arc005-pane-free-grid-smoke` 新增比例流、同侧夹取、两侧折叠和恢复、像素最小宽、预设、重置、单次队列落盘的行为断言；同套 `mutations.mjs` 对内存中的产物做阈值删除、最小宽删除变异，均证明断言转红（不改产品源码）。七套 `arc005-pane-*-smoke`：7 pass / 0 fail（`apps/desktop/.tmp/smoke-runs/1792552488619-29508-UHkPCh`，含真实 Electron PTY/Monaco 保活）。
- **未通过判据 7**：`pnpm typecheck` contracts 成功、desktop 因范围外 `src/main/mcp/hostMcpStdio.ts:257,268,274` 三处 TS2349 失败；该文件未被本任务改动。遵守「不改主进程」边界，未擅自修复。
- 此轮保持其他并行任务的工作区文件原样，未触碰 `paneDock.ts`、`Divider.tsx`、Node-RED、`ComposerEditor.tsx` 或主进程。
