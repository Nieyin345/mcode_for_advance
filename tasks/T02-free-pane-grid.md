# T02｜自由 Pane 网格停靠与布局恢复

| 项目 | 值 |
|---|---|
| 编号 | T02 |
| 类型 | ARC-005 核心缺口（台账反复点名的「自由 Pane 拖拽/布局恢复」） |
| 优先级 | 高 |
| 建议并发 | 可与 T01/T03/T04 并行 |
| 预计规模 | 大（这是本清单里最重的一项） |

---

## 为什么做这个任务

台账里 ARC-005 的 remaining 从 2026-10-19 起反复出现同一句话：
**「自由 Pane 拖拽与布局保存恢复仍是未解核心差距」**。

现状是（读源码确认，不是猜）：

- `apps/desktop/src/renderer/components/layout/paneDock.ts` 只支持**二选一**：
  `type PaneDock = "left" | "right"`。右栏可以在左/右之间换边，仅此而已。
- 分栏靠 `flex` 的 `order` 实现（`dockFlexOrder`），**不是**网格/树。
- 尺寸持久化是三个独立字段：`leftWidthPct` / `rightWidth` / `editorWidthPct`。

目标不是"重写布局内核"，而是：**在保住 PTY / Monaco / Tiptap 全程挂载的前提下，
把「一个可停靠的右栏」扩展成「可停靠的多个面板」**，并让停靠结果能持久化与恢复。

---

## 开工前必读

1. `audit-ledgers/README.md` §2.3/§2.4（双勾纪律、证据等级）。
2. `CLAUDE.md` 全文 —— 尤其「看这几条才动得了手」第 3 条（工作流编排）与
   「环境事实」（PTY/Monaco 必须全程挂载）。
3. `apps/desktop/src/renderer/components/shell/ClassicShell.tsx` 文件头注释 ——
   它写明了**为什么不能卸载子树**。这是本任务的头号约束。
4. `apps/desktop/src/renderer/components/layout/paneDock.ts` 全文（60 行，很短）。
5. `apps/desktop/src/renderer/components/layout/ThreePaneLayout.tsx` 全文。
6. 现有相关 smoke：`arc005-pane-docking-smoke`、`arc005-pane-dock-keys-smoke`、
   `arc005-pane-layout-edges-smoke`、`arc005-pane-first-paint-smoke`、
   `arc005-right-pane-keepalive-smoke`、`arc005-right-tabs-keepalive-smoke`。
   **这些是你要保住的既有合同**，先全部跑一遍确认基线绿。

---

## 执行内容

### 1. 数据模型：从「dock 二选一」到「布局快照」

新增 `apps/desktop/src/renderer/components/layout/paneLayout.ts`（纯函数，无 React）：

```ts
export type PaneId = "left" | "right" | "bottom" | "editor";
export type DockSide = "left" | "right" | "bottom";
export interface PanePlacement { id: PaneId; side: DockSide; order: number; sizePct: number; }
export interface PaneLayout { version: 1; placements: PanePlacement[]; }
```

要求：

- `parsePaneLayout(unknown): PaneLayout` —— 对**任何**损坏输入（null、旧格式、字段缺失、
  越界、重复 id、NaN）都必须返回一个**合法的默认布局**，绝不抛错、绝不返回非法值。
  这是「坏东西显式报出来，不静默跳过」的反面应用：**损坏的输入要退回默认并且可诊断**，
  所以再加一个 `parsePaneLayoutDetailed()` 返回 `{ layout, repaired: string[] }`。
- `movePane(layout, id, side, order)` —— 纯函数，返回新布局，不修改入参。
- `clampLayout(layout)` —— 尺寸夹取在合理区间（沿用现有 `LEFT_WIDTH_PCT_MIN/MAX` 的
  思路），且**总宽度不超过 100%**（多个面板同侧时要分配，不能相加溢出）。

**不要**直接把 `PaneDock` 类型删掉 —— 现有 6 套 smoke 和 store 都在用它。做法是：
保留 `paneDock.ts` 原样，新增 `paneLayout.ts`，并在 store 里新增字段
`paneLayout: PaneLayout`（与旧的 `rightDock` / `leftWidthPct` 等**并存**，
旧字段继续作为"当前简化视图"读出新模型的值）。这是迁移期，不是推翻。

### 2. 持久化与恢复

- 新增 setting key（走既有 `SettingRepo`，不要新造存储）：
  `ui.paneLayout`（JSON 字符串）。
- 读取失败 / 版本不匹配 / 内容损坏 → 用默认布局，并在**设置页可诊断的位置**
  留一条可见提示（不是 console）。参考现有 `settings` 里"损坏记录保留原档"的做法。
- 首帧恢复必须**不闪**：沿用 `arc005-pane-first-paint-smoke` 已有的机制，
  先读持久化布局再渲染，不要在默认布局上渲染一帧再跳。

### 3. 停靠交互

- 鼠标拖拽：沿用现有 `PANE_DOCK_MIME` 的思路，扩展为可以在 left / right / bottom
  三个落点之间移动面板。
- 键盘：沿用 `paneDockFromKeyboard` 的规则（方向键映射到视觉侧、忽略 IME 与修饰键），
  扩展到三向；补 Home/End 回到默认布局。
- **拖动过程中 PTY / Monaco / Tiptap 不得卸载**。这条要用真 Electron 探针证明，
  不是靠读代码。

### 4. 测试

新增 `apps/desktop/scripts/arc005-pane-grid-smoke/`：

- 纯函数层（E1）：`paneLayout.ts` 的解析/移动/夹取，覆盖 ≤ 20 条断言，
  其中**至少 1/3 是损坏输入**（null、NaN、重复 id、超大 size、旧格式）。
- 源码接线（E2）：`ThreePaneLayout` / store 真的读新字段，不是只写不读。
- 真 Electron 探针（U1 子项）：拖动后 PTY 会话 id 不变、Monaco 模型没被重建
  （用 `monaco.editor.getModels().length` 或等价判据）。

---

## 边界（不要碰）

- 不要改 `apps/desktop/src/main/**`（布局是纯渲染端状态）。
- 不要改工作流、文档、扩展、移动端相关代码。
- 不要删 `paneDock.ts`，不要动 `ClassicShell.tsx` 的挂载结构。
- 不要改 `arc005-pane-*` 现有 6 套 smoke 的断言（除非某条断言的前提因为新能力
  变得不成立 —— 那种情况要在回写区逐条说明并给理由）。

---

## 验收判据

1. 现有 6 套 `arc005-pane-*` smoke **全部仍然 PASS**（这是回归底线）。
2. 新增 `arc005-pane-grid-smoke` **全部 PASS**，且损坏输入类断言确实覆盖了
   解析器的每个分支（用覆盖率或逐条列举说明）。
3. 真 Electron 探针证明拖动后 PTY / Monaco 未重建。
4. 损坏布局文件 → 启动后是默认布局 + 可见提示，**不是白屏也不是崩溃**。
5. 双包 `tsc --noEmit` 干净，`pnpm test:all` 全绿。
6. **变异验证**：对「总宽度不超过 100%」这条，撤掉夹取 → 必须有断言变红；
   对「损坏输入退回默认」这条，改成抛错 → 必须有断言变红。

---

## 你要在回写区回答的问题

- 旧字段（`rightDock` / `leftWidthPct` / `rightWidth` / `editorWidthPct`）与新
  `paneLayout` 现在是什么关系？有没有出现"两处都能写、互相打架"的路径？
- 多面板同侧时尺寸怎么分配？谁赢？
- 哪些交互**没有**做（比如跨窗口拖出、任意网格 N×M）？明确列出来。

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
