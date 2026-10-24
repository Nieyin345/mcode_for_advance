# T119｜UI 重构第一步：把三栏外壳换成 Claude 桌面端的两栏

- Status: ready-for-agent
- Category: **P0 产品主线（UI）—— 用户明确说「这不是重构，只是换了颜色」**
- Priority: **P0 —— 「最终效果 = Claude 桌面端的 UI」是路线图 §2 的原话**
- Depends on: 无（但和 T120/T121 有文件边界冲突，见「并行分组」）
- Exclusive writable files:
  - `apps/desktop/src/renderer/components/shell/ClassicShell.tsx`
  - `apps/desktop/src/renderer/components/layout/ThreePaneLayout.tsx`
  - `apps/desktop/src/renderer/App.tsx`（只改壳层装配）
  - `apps/desktop/scripts/layout-*-smoke/`（新建或延伸）

## Required Skills
- `codebase-design`：判断哪些状态该进 store、哪些该留在组件里。
- `frontend-design`：目测密度与留白。
- `mcode-smoke`：无头挂载验证。

## 背景：用户的原话

> **「现在的 ui 有很大的问题，我之前不是说要 ui 重构吗，整个 ui 贴近 claude code 桌面端，现在还是之前的 ui，你只是换了一下颜色，这叫什么重构呢」**

**核实过的现状**：

| 项 | 实际 |
|---|---|
| `open-claude-ui/` | **有 36 个组件示例 + 247KB storybook + 两版完整逆向文档** |
| 我们用了什么 | **只有 `cds-theme.css` 的颜色值**（`gen-cds-tokens.mjs`），外加个别组件照抄过形状 |
| 当前外壳 | `ThreePaneLayout` = **左\|中\|右 + 底部终端**（可拖拽、可停靠、keep-alive） |
| Claude 桌面端 | **两栏**：左侧会话列表 + 右侧对话区。**没有右栏，没有底部终端** |

**所以用户说得对：我们做的是配色对齐，不是结构对齐。**

## 用户已经选定的方向

**彻底改成两栏**（AskUserQuestion 的选项 1）：

```
┌──────────┬────────────────────────────┐
│ Mcode    │  ⌘K   对话标题        ⋯   │
│          ├────────────────────────────┤
│ + 新建   │                            │
│          │   你：帮我整理这份数据      │
│ 今天     │                            │
│  会话 A   │   Claude：我先看看文件…    │
│  会话 B   │   ┌──────────────────┐    │
│ 昨天     │   │ 📄 report.docx   │    │
│  会话 C   │   └──────────────────┘    │
│          ├────────────────────────────┤
│ ⚙ 设置   │  ⎡ 输入消息…          ⎤ ➤ │
└──────────┴────────────────────────────┘
右栏、底栏都消失；文件/Git/终端
改成对话区里的侧滑抽屉或弹层。
```

**明确：右栏和底栏都消失。**

## 本卡范围（**只做第一步**）

**这一步只改「骨架」：把三栏壳换成两栏，把右栏/底栏的内容保住但换承载方式。**

### 一、结构改造

1. **`ThreePaneLayout` 改成两栏布局**（或新建 `TwoPaneLayout`，你判断 —— 但要考虑 `left={null}` 的调用方式）；
2. **`ClassicShell` 不再渲染 `RightPanel` 作为第三栏**；
3. **底部终端不再是布局的一部分**。

### 二、右栏和底栏的内容去哪（**这是本卡最难的部分**）

**它们不能消失，只是换承载方式。** 三选一（你论证）：

| 方案 | 做法 | 代价 |
|---|---|---|
| **a. 侧滑抽屉** | 点标题栏按钮从右侧滑出，覆盖在对话区上 | 宽度受限、和「两栏」的视觉冲突小 |
| **b. 弹层/全屏面板** | 独立 overlay，像设置页那样 | 上下文丢失（看文件时看不见对话） |
| **c. 顶部页签切换** | 对话区顶部加 tab：对话 / 文件 / Git / 终端 | 失去「对话始终可见」这个核心体验 |

**我倾向 a**（侧滑抽屉），理由：**Claude 桌面端本身就有类似的「artifacts 侧栏」**，而且它不破坏「对话区是主区」这个事实。

**⚠️ 但你要先确认一件事**：**底栏终端是 PTY 的宿主**，而 `ThreePaneLayout` 的注释里明确写着「keep-alive: always mounted … PTYs survive」。**换成抽屉后，终端组件如果卸载，所有 PTY 会死。** 你必须保住 keep-alive。

### 三、`open-claude-ui` 的组件要用起来

**这一步至少接一个**，证明「用上游组件」这件事真的在做（不是又只取色）：

| 组件 | 接哪 | 优先级 |
|---|---|---|
| `ChatComposer.tsx` | 现在的输入框 | **最高**（用户每次都在用） |
| `DraggableSessionList.tsx` | 左栏会话列表 | 高 |
| `ChatMessageBubbles.tsx` | 消息气泡 | 中 |
| `ModelSelectorEffort.tsx` | 模型选择 | 中 |

**我选 `ChatComposer`** —— 因为它是用户最高频接触的部件，而且现在的输入框是手写的。

## 验收判据

1. **`ThreePaneLayout`（或新的两栏壳）真的只有两栏**（`grep -c "right=" ClassicShell.tsx` 为 0 或语义等价）。
2. **右栏的九个面板仍然能打开**（文件/Git/任务/工作流/Office…），只是换了承载方式。
3. **PTY 不因切换布局而死**（有断言：进抽屉/切走再回来，终端会话还在）。
4. **`ChatComposer` 用的是 `open-claude-ui` 的组件**（不是照抄形状，是 import 或明确移植并注明来源）。
5. **现有套件不回归**（`layout-*` / `ui-*` / `chat-*` 全部）。
6. 不跑全量、不起 Electron。

## 边界

- `ClassicShell.tsx` / `ThreePaneLayout.tsx` / `App.tsx`（壳层装配）
- 新建 `apps/desktop/src/renderer/components/chat/ClaudeComposer.tsx`（或直接移植）
- **不碰** `RightPanel.tsx` 内部（那是 T120 的边界）
- **不碰** `TaskCenterPanel.tsx` / `deckPatternCheck.ts` / `policy.ts`

## ⚠️ 这张卡会撞别人

**`App.tsx` 和 `ClassicShell.tsx` 是全应用最中心的两个文件。** 任何在改 UI 的会话都会想动它们。

**所以开工前必须**：
1. `git status` 确认这两个文件没有别人的在途改动；
2. **声明你占用它们**，我在 `tasks/README.md` 上标注。

## 遇到问题先检索

```bash
sed -n '600,700p' apps/desktop/src/renderer/components/shell/ClassicShell.tsx
sed -n '1,60p' apps/desktop/src/renderer/components/layout/ThreePaneLayout.tsx
ls open-claude-ui/code-examples/ | head -20
grep -rn "open-claude-ui" apps/desktop/src/renderer/ | head
```

**`open-claude-ui/docs/README.md` 先读** —— 它列了两版逆向文档的全部章节。

## 回写

`tasks/T119-ui-two-pane-shell.md` 末尾追加 `## 结果回写（2026-10-24）`：
结构改动、右栏/底栏的新承载方式与论证、PTY 保活怎么验的、接了哪个上游组件、套件数字、提交 SHA。


## ⚠️ 卡面修正（2026-10-24，A 核实后）

**原文写「三栏壳 → 两栏」，那个方向有两个问题：**

### 一、用户的原话比我写的更精确

> **「其中最主要的就是 ai 聊天部分的 ui 重构，这部分要和 claude 一模一样最好，还有就是我们的主页面的文件打开，然后 ai 对话的右边栏显示这个功能要保留下来，现在的 claude 的对话只能中间显示，文件查看只能右边栏预览，还有我们的引用都要保留」**

**三条约束**：
1. **AI 聊天区要像 Claude**（最主要）；
2. **「打开文件 → 右栏显示」必须保留** —— **这是 Claude 桌面端没有、而我们要有的**；
3. 引用要保留。

### 二、36 条源码文本断言会被直接删三栏的方案打红

| 套件 | 断言 | 其中源码文本 |
|---|---|---|
| `arc005-pane-docking-smoke` | 28 | 14 |
| `arc005-pane-free-grid-smoke` | 36 | 14 |
| `arc005-right-pane-keepalive-smoke` | 17 | 3 |
| `arc005-editor-keepalive-smoke` | 12 | 5 |
| `arc005-pane-layout-edges-smoke` | 15 | 0 |
| **合计** | **108** | **36** |

它们读 `.tsx` 源码做匹配（`order: order.aside`、`rightDock === "left"`、`dockSideAtRect(...)`），守的是 **`T02/T23/ARC-005 的右栏停靠/宽屏模式**。

**直接删 = 顺手废掉那套功能。用户要的是「看着像两栏」，不是「删掉停靠」。**

### 三、采纳的方案

**`ThreePaneLayout` 增加 `rightSurface?: "pane" | "drawer"`，默认 `"pane"`：**

- **`pane`（默认）**：今天的全部行为，**36 条断言原样绿**；
- **`drawer`**：右栏与底栏不再参与 flex，改成可滑出的第三区；**两者仍然挂载**，只切换可见性 —— **PTY 与 `RightPanel` 的文件树/Git 扫描全部存活**。

**`drawer` 下右栏不该完全遮住对话** —— 用户要「对话和文件同时看」。所以是「对话区收窄 + 右栏滑出」，不是浮层。

**底部终端保持现在的行为**（用户没提要动它）。

### 四、优先级修正

**`ChatComposer` 移植优先于结构改造** —— 因为用户说「最主要的是 ai 聊天部分的 ui 重构」，而输入框是用户每次都在用的部件。

**顺序**：① `ClaudeComposer.tsx` 移植并替换现有输入框 → ② `rightSurface` 两栏模式 → ③ 36 条断言回归验证。
