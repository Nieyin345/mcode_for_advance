# T18｜输入框重做（复用 RichComposerWithMentions + ChatComposer）

| 项目 | 值 |
|---|---|
| 编号 | T18 |
| 类型 | ARC-005 UI（复用 `open-claude-ui` 的逆向成果） |
| 优先级 | 高 —— 输入框是最高频的交互面 |
| 建议并发 | 只改渲染端，可与 T05b / T19 并行 |
| 预计规模 | 大 |

---

## 目标

把输入框做成 Claude 桌面端的形态。**照着抄，不要自己设计。**

`open-claude-ui/code-examples/` 里有三个相关的逆向件：

| 件 | 行数 | 它能给你什么 |
|---|---|---|
| **`RichComposerWithMentions.tsx`** | 约 400 | `@` 提及的完整交互：触发检测、浮层定位、键盘导航、选中插入、光标恢复 |
| **`ChatComposer.tsx`** | 约 300 | 输入框本体：自动增高、占位符、快捷键、附件区 |
| **`ChatComposerChin.tsx`** | 约 200 | 底部那条「下巴」：模型/努力/权限、发送键、工具条 |

Mcode 现在用的是 `ComposerEditor.tsx`（626 行，Tiptap）+ `ChatPane` 里的内联结构。
**不要推翻 Tiptap**——它是真实编辑器，有 IME、撤销、粘贴处理。要抄的是
**外壳、几何、交互规则**，不是替换编辑器内核。

---

## 开工前必读

1. 三个逆向件**全文**。
2. `apps/desktop/src/renderer/components/chat/ComposerEditor.tsx`（626 行）——
   现在的编辑器，读懂它已经处理了什么（IME、粘贴、撤销、@ 触发）。
3. `apps/desktop/src/renderer/components/chat/ChatPane.tsx` 里 composer 那一段
   （搜索 `composer-card`）—— 外壳、发送键、工具条都在这儿。
4. `apps/desktop/src/renderer/styles.css` 的 `.composer-*` 段 —— 已有大量
   CSS（minipill、lvl bars、sweep、spring），**先看有什么，别重复写**。
5. `CLAUDE.md` 硬规矩第 7 条。

---

## 执行内容

### 第 1 步：先画差距表，再动手

读完后产出一张表：

| 能力 | 逆向件有 | Mcode 现在有 | 差距 |
|---|---|---|---|
| @ 提及 | ? | ComposerEditor 的 mention 扩展 | ? |
| 自动增高 | ? | ? | ? |
| 附件区 | ? | 已有 attach 按钮 | ? |
| 「下巴」布局 | ? | 已有 minipill | ? |
| 键盘快捷键 | ? | ? | ? |
| 浮层定位 | ? | 已有 `@floating-ui` | ? |

**只在有差距的行上动手。** 已经做好的不要重写——那是"为了抄而抄"。

### 第 2 步：按差距逐项补

每项单独提交，提交信息写清「抄了哪个逆向件的哪条规则」。

**重点抄这些物理规则**（它们是 Claude 手感的核心）：

- `@` 浮层的**定位与翻转**（上方空间不足时翻到下方）
- 提及列表的**键盘导航**（上/下/Enter/Tab/Esc，与 IME 守卫）
- 输入框的**自动增高上限**（超过后内部滚动，不是无限长）
- 「下巴」的**容器查询折叠**（窄时只留图标）
- 发送键的**状态机**（不可发送 / 可发送 / 运行中变停止）

### 第 3 步：不要丢现有能力

Tiptap 已经处理的东西**必须保留**：

- IME 组合输入（中文/日文）
- 粘贴处理（长文本转 tag、图片粘贴）
- 撤销/重做
- `@` 触发的现有扩展（`mention` + `suggestion`）
- 拖放文件到输入框

替换前先跑一遍相关 smoke（`ime-enter-smoke`、`ime-enter-smoke`、
`attach-links-smoke`、`content-tag-smoke`），记下当前断言。

---

## 边界（不要碰）

- **只改渲染端**（`apps/desktop/src/renderer/**`）。
- **不要替换 Tiptap**（`ComposerEditor.tsx` 的内核不动，只改外壳与交互规则）。
- **不加依赖**（`framer-motion` 不装；`@floating-ui` 已有）。
- 不改 `MessageBlocks` / `MessageRow`（T17 刚动过）。
- 不改主进程、contracts。
- 不改 `open-claude-ui/`。

---

## 验收判据

1. 第 1 步的差距表完整，**只在有差距的行上动手**。
2. 每一项都有**行为断言**（不是源码字符串）：提及键盘导航真的移动选中项、
   自动增高真的到上限后停止、发送键真的在三个状态间切换。
3. **IME 相关 smoke 全绿**（`ime-enter-smoke` 等）—— 这是硬底线。
4. 现有 composer 相关 smoke 全绿。
5. 双包 tsc 干净。
6. **变异验证**：撤掉自动增高上限 → 断言红；撤掉浮层翻转 → 断言红。

---

## 回写区要回答

- 差距表里哪几行真的有差距？哪几行 Mcode 已经做好了？
- 抄了哪些物理规则？哪条改了、为什么？
- Tiptap 的哪些现有能力必须保住？有没有丢？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21 执行对话／开工差距表（对照三份逆向件全文）

| 能力 | 逆向件 | Mcode 开工现状 | 差距及处理 |
|---|---|---|---|
| @ 提及 | 检测与插入、键盘导航及 IME 防误提交 | ChatPane.recomputePicker + FileMentionPicker + Tiptap chip；实文件搜索、键盘 ↑↓/Enter/Tab/Esc、阻止 IME 期间选中 | 主功能已有，不重写；WebKit compositionend 后虚假 Enter 缺二次防护（补） |
| 自动增高 | 原生 field-sizing/content；min 48px / max min(40svh, 24rem)，内部滚动 | Tiptap .ProseMirror 由内容自然撑高，min 3rem，max 固定 18rem，overflow-y auto | 上限未随小视口变化（补响应式 cap，保留内部滚动及 Tiptap） |
| 附件区 | 标签列、删除、+ 添加内容 | ChatPane tags/pendingImages、file drop/paste/clipboard、attach picker、去重 | 核心能力已有，不重复 |
| 「下巴」布局 | 20px 外框、模型/思考/权限工具条与发送反馈 | composer-card + ComposerToolbar minipill + ComposerToolbarToggle + T17 容器查询压缩 + send 动画 | 已有，不另造 |
| 键盘快捷键 | Enter/Shift+Enter，菜单 ↑↓/Enter/Tab/Esc，IME 守卫 | ComposerEditor 按 sendKey 支持 Enter 与 Ctrl/Cmd+Enter；picker 有 ↑↓/Enter/Tab/Esc，IME 与 229 守卫 | 主功能已有；仅补 WebKit 合成后误回车防护 |
| 浮层定位 | 上/下随空间翻转 | FileMentionPicker / SlashCommandPicker 固定 top=anchor.top-8 + translateY(-100%) | 缺空间翻转与防溢出（补同一共享位置计算） |

基线：`node scripts/run-smokes.mjs ime-enter-smoke attach-links-smoke content-tag-smoke arc005-picker-layer-smoke`，4/4 PASS；工作树存在其他任务的未提交 main/document 改动，本任务不碰它们。

### 2026-10-21 执行结果／验收证据

- **真正差距**：@/slash 浮层固定上开无翻转、小视口下编辑区 18rem 固定上限不随视口变化、WebKit compositionend 后 500ms 内伪 Enter 误提交风险。**已有且保留**：Tiptap 编辑内核、真实文件查询与 @ 触发、↑↓/Enter/Tab/Esc、普通 IME/229 守卫、历史撤销重做、长粘贴与图片粘贴转 tag、文件拖放、附件显示删除、minipill 与容器查询、send/stop/queue 语义。
- **采用逆向物理规则**：共享浮层布局依据可用空间上/下翻转并限制高度与横向溢出（RichComposerWithMentions）；编辑区以 `min(40svh,24rem)` 且最小 3rem 自然增长、超上限内部滚动（ChatComposer）；WebKit 500ms post-composition 虚假 Enter 守卫（RichComposerWithMentions）；发送状态归入单一决策（ChatComposer/ChatComposerChin），保留 Mcode 的运行中非空输入“排队”路径而不是盲目覆盖为停止。下巴/附件/命令键本来已有，未重写。
- **变更文件**：`components/chat/{composerPhysicalRules.ts,useComposerPickerPlacement.ts,FileMentionPicker.tsx,SlashCommandPicker.tsx,ComposerEditor.tsx,ChatPane.tsx}`、`styles.css`，以及渲染目录下的 `components/chat/tests/t18-*`。
- **E1 动态行为断言**：`"C:\\Program Files\\Git\\bin\\bash.exe" src/renderer/components/chat/tests/t18-run.sh`（cwd `apps/desktop`）：19/19 PASS。运行真实 `FileMentionPicker`、真实事件处理器（fake React hooks 调度，仅替换 RPC/i18n），验证 ↑↓ 选中项真实迁移、Tab 选中第二条、Esc 关闭、IME 阻断选择、近顶时渲染到下方；同一生产规则动态验证视口限高、浮层防溢出、发送禁用/可发/停止/排队切换以及 WebKit 误 Enter 保护。
- **E1 变异红例**：撤除定位规则的翻转分支 → `floating @ menu flips below near top` FAIL（17/18 PASS、exit 1）；恢复；撤除高度规则的 `24rem` 上限 → `auto-grow stops at 24rem on tall viewport` FAIL（17/18 PASS、exit 1）；恢复后 19/19 PASS。
- **关联回归**：修改前 `node scripts/run-smokes.mjs ime-enter-smoke attach-links-smoke content-tag-smoke arc005-picker-layer-smoke` → 4/4 PASS；修改后 `node scripts/run-smokes.mjs ime-enter-smoke attach-links-smoke content-tag-smoke conversation-queue-smoke arc005-picker-layer-smoke arc005-file-picker-error-smoke arc005-library-picker-search-smoke frontend-smoke arc005-chrome-polish-smoke` → 9/9 PASS。
- **类型检查**：`npx tsc --noEmit -p apps/desktop/tsconfig.json && npx tsc --noEmit -p packages/contracts/tsconfig.json` → 0 error；`git diff --check` → PASS。
- **剩余**：本任务列出的六项无未达成；E1 无头 + E2 源码，**未做真 Electron 人工操作（U1，不在 T18 验收六条内）**。不替换 Tiptap，不改主进程/contracts/MessageBlocks/MessageRow/open-claude-ui，无新依赖，不覆盖他人并发改动。
