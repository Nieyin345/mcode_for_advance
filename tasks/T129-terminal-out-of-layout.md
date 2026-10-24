# T129｜终端不再是布局的一部分（**方案待重定，见 §零.B**）

- Status: **needs-info** —— 原方案「搬到右栏页签」被实测推翻，见 §零.B
- Category: **P0 产品主线（UI）—— 两栏的最后一块**
- Priority: **P0**
- Depends on: T119（`1330e13f`，drawer 已接线）

## ⚠️ §零.B：原方案「搬到右栏页签」为什么不行

**`BottomTerminalBar.tsx` 的文件头原文：**

> Replaces the terminal that used to be a tab in the right panel — **the fixed 360px sidebar was too narrow for a usable terminal**, so it moved to a wider bottom bar scoped to the center pane's width.

**终端以前就在右栏页签里，是因为太窄才搬下来的。** 而 T119 的 drawer 宽度（`ThreePaneLayout:243-245`）是：

```ts
const drawerOpenWidth = rightWidthPct !== undefined
  ? `min(${rightWidthPct}%, 30%)`
  : `min(${rightWidth ?? 360}px, 30%)`;
```

**封顶 30%** —— 1400px 窗口下约 420px，**比当年的 360px 好不了多少**。

**所以「搬到右栏页签」是往回走，不是前进。**

---

## 零、开工前必须核实的三件事

```bash
# 1. 底栏终端现在挂在哪
grep -n "bottomTerminal" apps/desktop/src/renderer/components/shell/ClassicShell.tsx \
                            apps/desktop/src/renderer/components/layout/ThreePaneLayout.tsx
# 2. 右栏内置页签的清单
grep -n "BUILTIN_TAB_IDS" apps/desktop/src/renderer/components/customUi/registry.ts
# 3. 这些文件有没有别人的在途改动
git status --porcelain apps/desktop/src/renderer/components/shell/ClassicShell.tsx \
                      apps/desktop/src/renderer/components/layout/ThreePaneLayout.tsx \
                      apps/desktop/src/renderer/components/layout/RightPanel.tsx \
                      apps/desktop/src/renderer/components/customUi/registry.ts
```

**写卡时（2026-10-24 16:40）核实结果**：

- 底栏在 `ThreePaneLayout` 的 `bottomTerminal` prop 里（`:383-400`），由 `ClassicShell:662` 传入 `<BottomTerminalBar active={bottomTerminalOpen} />`
- **右栏内置页签：`files / git / browser / turns / flow / tasks / taskcenter / preview`** —— **没有 terminal**
- **右栏也没有任何其他终端入口**（grep `TerminalPanel` 只命中 `BottomTerminalBar.tsx`）

**所以这是一个「必须先有替代品，才能移除」的改动，不是删除。**

---

## 一、⚠️ 为什么这张卡危险

`ClassicShell.tsx:608-620` 有一段注释，是**之前踩坑留下的**：

> **Workspace shell is ALWAYS mounted** … This is critical: **BottomTerminalBar (→ TerminalPanel → every TerminalView) lives inside ThreePaneLayout.** A ternary swap `settingsOpen ? <Settings> : <Workspace>` would unmount the whole workspace subtree on every settings open, **killing all live PTYs** (TerminalView's cleanup calls `api.terminal.kill`) and destroying scrollback — and racing many concurrent `pty.kill()` calls on Windows occasionally **crashes the main process**.

**这段注释是这张卡的验收核心**：搬动终端的宿主时，**必须保证 PTY 不被卸载**。

**搬完之后必须证明**：切页签、开设置、切左右栏，**PTY 都活着，scrollback 都在**。

---

## 一.B、三个可行方案（要选一个，先论证再动）

| 方案 | 做法 | 代价 | 用户看到什么 |
|---|---|---|---|
| **a. 终端变成浮层/全屏面板** | 从工具栏按钮打开一个覆盖在对话区上的面板，像 Claude 的 artifacts 全屏 | **宽度够**（可到 80%+）；但要新写一层外壳 | 点按钮 → 终端盖住对话，再点回来 |
| **b. 保持底栏，但改成可折叠+默认关闭** | 不动宿主关系，只是默认 `bottomTerminalOpen=false`，用户点才展开 | **最小改动**；但「底栏是布局的一部分」这件事没解决 | 平时看不见，点按钮才出现 |
| **c. 右栏 drawer 加宽上限** | 把 drawer 的 30% 上限提到 50%，终端放进去 | 会**压缩对话区** —— 而用户要「对话和文件同时看见」 | 右栏变宽，对话变窄 |

**我的倾向：b。**

理由：
- **用户抱怨的是「UI 不像 Claude」，不是「终端在下面」**。Claude 桌面端本来就没有终端；
- **b 的代价最小**，而且**它解决了实际问题**（默认看不见 = 不占布局）；
- **a 会引入一个新的全屏层**，那是又一堆 keep-alive 和 z-index 问题；
- **c 直接违反用户的第三条约束**（对话和文件同时看见）。

**但这是产品判断，不是技术判断。** 如果用户要「终端必须存在且顺手」，a 更好；如果用户要「像 Claude，终端是少数派工具」，b 更好。

**⚠️ 动手前必须先回答：用户上次用终端是什么场景？** 如果有证据表明终端是高频功能，b 会让它更难用。

---

## 二、要做的事（**下面是 b 的路径；选 a 或 c 时这节整段作废，重写**）

### 一、默认关闭

`bottomTerminalOpen` 的初值改成 `false`。

**先查它现在从哪来**：

```bash
grep -rn "bottomTerminalOpen" apps/desktop/src/renderer/ --include=*.ts --include=*.tsx | head -10
```

**如果它存在 sessionStore / settings 里**（持久化的），那「默认关闭」只对**新用户**生效，老用户保留他们上次的状态 —— **这是对的，别覆盖用户的记忆**。

### 二、终端的显隐状态要能表达「它存在但不占地方」

**⚠️ 关键**：`BottomTerminalBar` 现在是「高度塌到 0 但**始终挂载**」（`ThreePaneLayout:395-400` 的 `h-0` + `inert`）。

**这个机制本身就是对的** —— 它已经满足「不占布局」（高度 0）+「PTY 存活」（挂载）。

**所以 b 方案其实不需要改结构，只需要改默认值。**

**⚠️ 但要确认一件事**：`bottomTerminalOpen=false` 时，`ThreePaneLayout` 里那个 `border-t` 还会不会画？看 `:392-398`：

```tsx
bottomTerminalOpen ? "border-t" : "h-0"
```

**`false` 时只有 `h-0`，没有 `border-t`** —— 所以视觉上是干净的。**这条要核实。**

### 三、终端按钮的位置

现在在 `Titlebar` 上（`ClassicShell:630` 的 `onToggleBottomTerminal`）。

**如果默认关闭了，这个按钮的可见性就变得重要** —— 用户得能找到它。

**要么保留在标题栏，要么放进右栏页签或某个菜单。** 你判断，但**不能出现「终端还在但找不到」**。

### 三、终端按钮去哪儿了

现在 `Titlebar` 有 `onToggleBottomTerminal`（`ClassicShell:630`）。**底栏移除后这个按钮要么改成「打开右栏 terminal 页签」，要么删掉。**

**你判断哪个更好**，但必须有一个入口 —— **不能出现「终端还在但用户找不到」**。

## 三、验收判据

1. **右栏有 `terminal` 页签，能打开终端**（有断言）。
2. **底栏不再占布局高度** —— `ThreePaneLayout` 不渲染 `bottomTerminal`（有断言）。
3. **★ PTY 保活**：打开终端 → 切到别的页签 → 切回来，**会话还在、scrollback 还在**（这条必须有断言或可复现的探针）。
4. **★ 开设置不杀 PTY**：`ClassicShell:608` 那段注释保护的正是这个 —— 有断言。
5. **不回归**：`terminal-*` 套件全绿。

**第 3、4 条是这张卡的全部价值。** 如果它们验不了（headless 下 PTY 难验），**停下来回报，不要交付一个「看起来搬完了」的版本**。

## 四、变异（正控/负控分开）

| 变异 | 正控（该红） | 负控（该绿） |
|---|---|---|
| `"terminal"` 从 `CACHED_BUILTIN_RIGHT_TABS` 去掉 | 1（PTY 保活那条） | — |
| 右栏页签加回卸载逻辑 | 1 | — |
| `BUILTIN_TAB_IDS` 删掉 `"terminal"` | 1 | — |

**第一行是核心**：它模拟「搬到右栏但没接 keep-alive」，而那正是会把 PTY 杀死的那条路。

## 五、边界

**可以改**：§Exclusive writable files 列的六个文件。

**不许碰**：
- `TerminalPanel.tsx` 内部逻辑（只改它的宿主关系）
- `TerminalView.tsx`（PTY 的宿主，动它会 ripple 到整个 keep-alive 体系）
- `styles.css`（K / L / F 在改）
- `tailwind.config.js`
- 任何 `chat/` 下的东西

## 六、回写

1. 终端的新家在哪、入口按钮怎么处理
2. **PTY 保活怎么验的**（这一条最重要 —— 是断言、探针，还是「验不了」）
3. keep-alive 接在哪（`CACHED_BUILTIN_RIGHT_TABS` 还是别处）
4. 套件数字、变异（正控/负控分开）、提交 SHA
5. **你觉得不对但没改的地方**

---

## 结果回写（2026-10-24，K）

### 零、结论先行：**产品代码零改动 —— 要的功能已经在树上**

**`bottomTerminalOpen` 的初值本来就是 `false`**（`sessionStore.ts:770`），而且它**不在持久化字段列表里**（`PanePersistedField` 只含 `bottomTerminalHeight`），所以每次启动都是关闭态。

**`ThreePaneLayout` 的关闭态本来就是 `h-0` 塌陷 + `{bottomTerminal}` 始终渲染**（`:393-403`），`BottomTerminalBar` 自己用 `invisible` 隐藏而不是卸载。

**所以这张卡从「改结构」变成了「把已有行为钉住」。** 一条产品代码都没改，只加了回归套件。

### 一、卡片前提的三处核实

| 卡的疑问 | 实测 |
|---|---|
| ① `bottomTerminalOpen` 从哪来 | `sessionStore.ts:770`，初值 `false`；**不持久化** |
| ② 关闭时视觉干不干净 | 外层 `h-0` + `overflow-hidden`，内层 `BorderTerminalBar` 的 `border-t` 被裁掉；外层 h-0 分支**不带** `border-t` |
| ③ 终端按钮找得到吗 | `Titlebar.tsx:270` 有开关按钮，`aria-label` 随状态变化 |

**第 ① 条有个重要含义**：既然它不持久化，那「老用户的选择不被覆盖」这条验收判据**不适用** —— 从来就没有被记住过。**这不是缺陷**（终端开关是低成本的重复动作），但下一个人不该以为它会记住。

### 二、★ PTY 保活怎么验的（这是这张卡的全部价值）

**验的是「必要条件」，不是「充分条件」。**

PTY 保活依赖「组件始终挂载」，挂载由三条结构条件保证：

1. `ThreePaneLayout` 的 `{bottomTerminal}` 作为**子节点**无条件渲染（条件在外层 div）；
2. 关闭态是 `h-0` 塌陷，**不是 `return null`**；
3. `inert` + `aria-hidden` 让它不可交互但留在 DOM。

**这三条在，xterm 实例与 node-pty 连接就活着** —— 清理只发生在卸载时。

**验不了的部分我明说**：「关掉再打开，scrollback 真的还在」需要真 Electron + 真 ConPTY，本套不起 Electron。**所以这一条是「结构上不会死」，不是「实测活着」。**

### 三、套件与变异

`t129-terminal-smoke`（新建，**13/13**）。五节：默认关闭 / 关闭态不占布局 / PTY 保活结构条件 / 按钮找得到 / 负控。

| 变异 | 正控（该红） | 实际 | 负控（该绿） |
|---|---|---|---|
| 初值改 `true` | 1 | **1** ✓ | — |
| `ThreePaneLayout` 删 `h-0` 分支 | 1 | **1** ✓ | — |
| **`BottomTerminalBar` 改成 `if (!active) return null`** | **1** | **1** ✓ | — |

**第三行是核心**：它模拟「为了不占地方而卸载」，而那会杀死所有 PTY。**它红了，说明判据守住了这条。**

回归：`terminal-smoke` / `terminal-panel-worktree-smoke` / `terminal-bus-recovery-smoke` 全绿。

### 四、没做的 / 觉得不对但没改的

- **没有把终端搬回右栏** —— 卡里已论证过（`BottomTerminalBar.tsx` 文件头：360px 太窄才搬到下边）。
- **`bottomTerminalHeight` 是持久化的**，而 `bottomTerminalOpen` 不是。**两者不对称** —— 用户调整过的高度被记住，但「它开着还是关着」不被记住。这是有意还是遗漏，我没改，也没找到说明。
- **真机 scrollback 验证未做**（见第二节）。
