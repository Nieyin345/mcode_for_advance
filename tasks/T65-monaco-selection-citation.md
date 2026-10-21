# T65｜Monaco 编辑器的选段引用（三处里的最后一处）

| 项目 | 值 |
|---|---|
| 编号 | T65 |
| 类型 | **功能缺口**（优化方向 §⑤「选段引用覆盖三处」） |
| 优先级 | 中 —— 三处已有两处，缺最后一块 |
| 建议并发 | 改 `ide/FileEditor.tsx` + `ide/NoteEditor.tsx`；**与 T62/T63/T64 不冲突** |
| 预计规模 | 小到中 |

---

## 前置条件

- **无前置**，可直接派。

---

## 现状（`优化方向.md` 原文）

| 位置 | 机制 | 状态 |
|---|---|---|
| 消息 | `SelectionToolbar` | ✅ |
| 文献预览 | `SelectionToolbar` | ✅ |
| **文献编辑**（`NoteEditor` / `FileEditor`，**Monaco**） | **Monaco 自己的选区模型** | ❌ **没有** |

> ⚠️ **Monaco 那条是另一个机制，不是"再接一份 `SelectionToolbar`"就完事**

---

## 这一条的关键难点

Monaco 不是 DOM 文本 —— 它是 canvas 渲染的。所以：

- **不能**用 `window.getSelection()` 拿选中文字
- **不能**用 `SelectionToolbar` 的浮层定位逻辑（它依赖 DOM 矩形）
- **必须**用 Monaco 自己的 API：
  - `editor.getSelection()` → 行/列范围
  - `editor.getModel().getValueInRange(selection)` → 文字
  - `editor.getScrolledVisiblePosition(position)` → **屏幕坐标**（这才能定位浮层）

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `apps/desktop/src/renderer/components/ide/FileEditor.tsx` —— Monaco 怎么挂的。
3. `apps/desktop/src/renderer/components/ide/NoteEditor.tsx` —— 同上。
4. **现有两处的 `SelectionToolbar`** —— `renderer/components/chat/` 或 `library/` 里，
   先找到它，看它的接口。
5. `apps/desktop/src/renderer/lib/attachToChat.ts` —— 「引用到对话」的落点。
6. Monaco 的 `getScrolledVisiblePosition` 文档（本地
   `node_modules/monaco-editor/` 的类型定义）。

---

## 执行内容

### 第 1 步：先看现有两处怎么做的

`SelectionToolbar` 的接口是什么？

- 它接收什么参数？（文本？位置？）
- 它怎么触发「引用到对话」？

**如果它只接受 DOM 矩形**，那要做的第一件事就是**把它的「位置」参数抽象出来**，
让 Monaco 也能传。**不要复制一份工具栏。**

### 第 2 步：Monaco 侧的选区监听

```ts
editor.onDidChangeCursorSelection((e) => {
  const sel = e.selection;
  if (sel.isEmpty()) { hideToolbar(); return; }
  const text = editor.getModel()?.getValueInRange(sel) ?? "";
  // 用 getScrolledVisiblePosition 拿屏幕坐标
  const start = editor.getScrolledVisiblePosition(sel.getStartPosition());
  // 转成整个页面坐标（要考虑编辑器容器的 offset）
  showToolbar({ text, rect: ... });
});
```

**注意**：`getScrolledVisiblePosition` 返回的是**相对编辑器**的坐标，
要加上编辑器容器的 `getBoundingClientRect()` 偏移。

### 第 3 步：滚动时更新位置

用户选完文字后滚动，工具栏要跟着走（或者干脆隐藏）。

**建议**：滚动时**重新计算位置**，拿不到就隐藏。
不要让它停在错误的位置上。

### 第 4 步：多光标 / 大选区

- **多光标**：只取第一个非空选区（或直接隐藏，说明不支持）
- **大选区**（几千行）：引用到对话会爆上下文。**加一个上限**，
  超了就提示「选区太长，只引用前 N 行」

---

## 边界（不要碰）

- **不复制 `SelectionToolbar`** —— 扩展它的接口，让三处共用。
- 不改消息/文献预览那两处的行为。
- 不改 Monaco 的配置（主题、快捷键等）。
- 不改 `attachToChat.ts` 的落点。
- 不改 `FileEditor` 的其它模式（Milkdown / 源码视图）。

---

## 验收判据

1. 在 `FileEditor` 的 Monaco 模式里选中文字 → 出现引用工具栏（有断言）。
2. 在 `NoteEditor` 里选中文字 → 同上（有断言）。
3. 点「引用到对话」→ 输入框里出现引用（有断言）。
4. 滚动时工具栏位置正确或隐藏（有断言）。
5. 超大选区有上限提示（有断言）。
6. 消息 / 文献预览两处的行为不回归（有断言）。
7. 双包 tsc 干净。
8. **变异验证**：撤掉 Monaco 的选区监听 → 判据 1 红。

---

## 回写区要回答

- `SelectionToolbar` 的接口最后改成什么样了？三处共用了吗？
- Monaco 的坐标转换怎么做的？
- 滚动时是重新计算还是隐藏？
- 多光标怎么处理的？
- 超大选区的上限是多少？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21 执行记录（T65）

- **实际现状**：任务描述写于旧版本。当前 `NoteEditor.tsx` 已在 2026-09-26 删除（`docs/planning/优化方向.md` §3.19，仓库无引用）；在用的 Monaco 编辑器是 `FileEditor.tsx` / `EditPane`。其选段引用链早已接好，但缺超长保护，且 DOM `selectionchange` / 引用菜单搜索框 autofocus 导致旧工具栏或菜单误关闭；Monaco 内部滚动也未显式处理。**没有复活废弃的 NoteEditor。**
- **共用接口**：`SelectionToolbarState` 继续统一承载 `rect`、`text`、`messageId`、`role`、`lines?`，加了可选 `truncated?: { maxLines, maxChars }`；组件加可选 `selectionSource?: "dom" | "monaco"`，默认 DOM，两处原调用保持不变；Monaco 不触发 DOM selectionchange 关闭。仍是同一个 `SelectionToolbar` 和 `SelectionQuoteMenu`。
- **坐标**：`captureMonacoCitationSelection` 使用 Monaco `getSelection` / `getModel().getValueInRange` / `getScrolledVisiblePosition`，加 `getDomNode().getBoundingClientRect()` 得到 viewport `position:fixed` 坐标；只用可见端点，端点都不可见则隐藏。
- **滚动**：通过 `onDidScrollChange` 清掉引用条及定位失效的引用菜单；`document` 捕获 scroll 仍覆盖 DOM 两处。
- **多光标**：`getSelections().length > 1` 直接隐藏，避免产生不明确的来源。
- **上限**：200 行或 12,000 字符（先达者生效），共享工具栏显示明确截断提示，截断文本和行号在同一快照中；切文件 / 引用菜单失焦也不会把新文件与旧选区错配。
- **引用落点**：保持 `makeQuoteTag` → `useSessionStore.getState().quoteIntoComposer(target.id, tag)`，未修改 `attachToChat.ts`。
- **测试**：`node scripts/ide-quote-snapshot-smoke/build.mjs`（在 `apps/desktop` cwd）26/26 PASS；覆盖 FileEditor 真 React 函数 + 假 Monaco 选区事件 → 共享工具栏 → 目标菜单 → composer 标签、滚动隐藏、坐标、多光标、截断 UI、DOM 工具栏原行为。`pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` PASS；`pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` PASS。
- **变异验证**：把 `subscribeMonacoCitationChanges` 的 `onDidChangeCursorSelection` 临时换成 `onDidScrollChange`，该 smoke 立即红（`选中后弹出引用工具条` FAIL，退出码 1）；精确还原后 26/26 绿，原文件 SHA256 `555c346b0dd9ce574ad1bd46253dc023e410f895ea6b03f9760bfcd270384742`。
- **未满足（按任务字面判据）**：**#2** 要求在已被删除且无调用者的 `NoteEditor` 里选中文字出现工具栏（有断言），现版本已无此入口，无法履行；没有为了满足过期文件名而扩大范围重建它。其余 #1、#3～#8 在现存入口通过上述无头 E1/tsc/变异测试；未宣称真 Electron 手工 U1 验收。
