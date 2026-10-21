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
