# T128｜Hover / Active 做成可复用类，并拆出独立的 active 色

- Status: ready-for-agent
- Category: **P0 产品主线（UI）—— T121 三件事的第二件**
- Priority: **P0**
- Depends on: T121（`5d9fdb72` / `2e73db35`，规范对照已就绪）
- Exclusive writable files:
  - `apps/desktop/src/renderer/styles.css`（**只加新类，不改 surface / edge / 气泡**）
  - `apps/desktop/tailwind.config.js`（**只加 `surface.active`；如果 T128 开工时 `fontSize` 还在未提交状态，先等**）
  - `apps/desktop/src/renderer/components/ui/`（把一个基础组件接上新类作为示范）
  - `apps/desktop/scripts/t128-hover-active-smoke/`（新建）

## Required Skills
- `frontend-design`：目测悬停与按下的手感差别。
- `mcode-smoke`：变异验证。

---

## 零、开工前核三件事

```bash
git status --porcelain apps/desktop/tailwind.config.js apps/desktop/src/renderer/styles.css
git log --oneline -3 -- apps/desktop/tailwind.config.js
grep -c "surface-active" apps/desktop/src/renderer/styles.css
```

**最后一条应该是 0** —— 现在 `--surface-active` **不存在**（我实测过）。

**⚠️ 如果 `tailwind.config.js` 有未提交改动，先确认是谁的**（K 在加 `surface.raised` / `surface.overlay`，L 在加 `fontSize`）。**别人的改动不要碰、不要提交。**

---

## 一、两个缺陷

### 缺陷 A：active 和 hover 是同一个颜色

`styles.css:113` 的注释原文：

```css
--surface-hover: var(--m-gray-50); /* #f0efec — hover/active fills */
```

**它明确写着 `hover/active fills` —— 一个是悬停，一个是按下，共用同一个值。**

**后果**：点击按钮时，除了浏览器默认的极短暂按下态，**用户看到的颜色和悬停时一模一样**。按下没有额外反馈。

实测：全仓 `active:scale-*` 只有 **6 处**，而 `hover:bg-surface-hover` 有 **308 处**。

### 缺陷 B：308 处 `hover:bg-surface-hover` 各写各的，没有可复用的类

CDS 规范（storybook `:242-266`）把 hover 行为做成了**可复用 CSS 类**：

```css
.cds-hover-ghost {
  transition: background-color 150ms cubic-bezier(0.16, 1, 0.3, 1),
              color 150ms ease,
              transform 100ms ease;
}
.cds-hover-ghost:hover  { background: var(--cds-fill-ghost-hover);   /* 5% alpha */ }
.cds-hover-ghost:active { background: var(--cds-fill-ghost-selected); /* 10% alpha */
                          transform: scale(0.98); }

.cds-card-interactive {
  transition: box-shadow 200ms cubic-bezier(0.16,1,0.3,1),
              transform  200ms cubic-bezier(0.16,1,0.3,1),
              border-color 200ms ease;
}
.cds-card-interactive:hover  { box-shadow: var(--cds-panel-shadow-hover);
                               transform: translateY(-1.5px);
                               border-color: var(--cds-border-strong); }
.cds-card-interactive:active { transform: translateY(0); }
```

**规范的核心不是数值，是「行为做成了可复用类」** —— 所以每个组件不必各写一遍 hover。

而 Mcode 这边：`cds-hover-ghost` / `cds-card-interactive` **零命中**。

## 二、要做的三件事

### 一、拆出 `--surface-active`

```css
/* :root */
--surface-hover: var(--m-gray-50);   /* #f0efec — 悬停 */
--surface-active: <更深一档>;        /* 按下 */

/* .dark */
--surface-hover: var(--m-gray-750);  /* #2c2c2a */
--surface-active: <更深/更亮一档>;    /* 按下 */
```

**⚠️ 取值要满足两个约束，和 T121 修边框那次同型：**

1. **对 `--surface` 足够可辨**（按下要能看出来）；
2. **与 `--surface-hover` 不同值**（否则按下和悬停还是没区别）。

**算出来再定，不要凭感觉挑。** 把两个对比度写进注释。

### 二、把两个类搬进 `styles.css`

**名字保留 `cds-hover-ghost` / `cds-card-interactive`**（和上游同名，便于对照）。

**但值要用我们的 token**（`var(--surface-hover)` / `var(--surface-active)`），不是上游的 `--cds-fill-ghost-hover`。

### 三、接一个基础组件作为示范

**不要一次改 308 处。** 选**一个**最基础、影响面最广的组件接上新类，证明这条路能走通。

**建议 `components/ui/button.tsx`**（如果存在）或者别的最高频组件。

**如果 `button.tsx` 已经有一整套 hover 逻辑**（而不是裸的 `hover:bg-surface-hover`），**先看它再决定** —— 别把已有的正确实现改坏。

## 三、验收判据

1. **`--surface-active` 在亮暗两套里都存在，且与 `--surface-hover` 不同值**（有断言）。
2. **`--surface-active` 对 `--surface` 的对比度 ≥ 某个下限**（你算，写进断言）。
3. **`.cds-hover-ghost` 的 `:active` 与 `:hover` 背景不同**（有断言，读 CSS）。
4. **至少一个组件用上了该类**，且它的旧 `hover:bg-surface-hover` 被移除（有断言）。
5. **不回归**：现有 UI 套件全绿。

## 四、变异（正控/负控分开）

| 变异 | 正控（该红） | 负控（该绿） |
|---|---|---|
| `--surface-active` 改成与 `--surface-hover` 同值 | 1 | — |
| 删掉 `.cds-hover-ghost:active` 那条 | 1 | — |
| 示范组件改回 `hover:bg-surface-hover` | 1 | — |

**第一行是核心**：它模拟「忘了拆 active」这个原始缺陷。

## 五、边界

**可以改**：
- `styles.css`（**只加新类和新 token**）
- `tailwind.config.js`（**只加 `surface.active`**）
- 一个基础组件的示范接线
- 新建套件目录

**不许碰**：
- 308 处 `hover:bg-surface-hover` 的其余部分（那是下一张迁移卡）
- 任何 `chat/` 下的组件
- `fontSize` / 字重（L 的边界）
- `surface.raised` / `surface.overlay`（K 的边界）

## 六、回写

1. `--surface-active` 的取值 + 两个对比度
2. 示范组件是哪个、为什么选它
3. 308 处迁移的**建议分批方式**（下一张卡要用）
4. 套件数字、变异（正控/负控分开）、提交 SHA
5. 你觉得不对但没改的地方

---

## 七、选中态：上游四态的真值（2026-10-24 核实，纠正过一次）

**我最初给执行者的值是错的**（把 `var()` 的 fallback 当成了真值）。以下是从 `cds-theme.css` 逐层解析出来的真值。

### 真值链

```
--cds-bg-selected          = --cds-fill-ghost-selected   (:221)
--cds-fill-ghost-selected  = --cds-alpha-2               (:135)
--cds-alpha-2              = hsla(0, 0%, 8%, 0.10)       (:99)
暗色 --cds-alpha-2          = hsla(0, 0%, 100%, 0.09)    (:276)

--cds-text-accent          = --cds-clay                  (:228)
--cds-clay                 = #d97757                     (:11)
```

**`#f3ece7` / `#3a2c27` 是 `var(--cds-bg-selected, …)` 的 fallback，不是真值。**

### 四态

| 状态 | 底色 | 文字 |
|---|---|---|
| 未选中静止 | 透明 | `#1a1a1a` |
| 未选中悬停 | `--cds-bg-hover` = `#f2f2ef` | 不变 |
| **选中静止** | **`hsla(0,0%,8%,.10)`**（中性灰 10%） | **`#d97757` + `font-medium`** |
| **选中悬停** | **同选中（不变）** | 同选中 |

**关键：区分「选中」和「悬停」靠的是「文字变品牌色 + 加粗」，底色只差 5% → 10%。**
**「选中 + 悬停不变色」是对的，不是缺陷。**

### 实现时的选择

| 写法 | 做法 | 风险 |
|---|---|---|
| **a. 存三元组 + `/10`** | `--selected-bg: 31 31 31`，用 `bg-selected/10` | **忘了带 `/10` 就是一块黑** |
| **b. 存已合成实色** | 叠在 `--surface` 上算出的固定色 | 换 surface 时要重算，脱离色阶 |

**倾向 a** —— 上游语义就是「alpha 叠在任何底上」，它在 `surface` / `raised` / `hover` 上都能正确工作。

**选 a 必须有断言**：所有 `bg-selected` 的使用点都带 alpha 后缀。
