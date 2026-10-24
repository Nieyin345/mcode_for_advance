# T146 — 七档字号尺度和上游 Claude **不是同一个基准**，迁移方向要重新判断

**Status**：`needs-triage`（**产品决策卡，不是执行卡**）
**Category**：P0 产品主线（UI）
**写卡时间**：2026-10-24 21:25。**下面前提都是这一刻实测的。**

## 一、这张卡要回答一个问题

**T121/T130/T133/T142 一直在做「把硬写的 px 迁移到七档 token」。**

**如果上游 Claude 根本不用七档，那这条路方向就错了。**

## 二、实测证据（不是推理）

### 上游硬编码字号的分布

```bash
grep -rhoE "text-\[[0-9.]+px\]" open-claude-ui/code-examples/*.tsx | sort | uniq -c | sort -rn
```

```
     53 text-[10px]
     32 text-[11px]
      4 text-[9px]
      4 text-[15px]
      2 text-[13px]
      1 text-[14.5px]
      1 text-[12px]
      1 text-[11.5px]
      1 text-[10.5px]
```

### 我们硬编码字号的分布

```bash
grep -rhoE "text-\[[0-9.]+px\]" apps/desktop/src/renderer/ --include=*.tsx | sort | uniq -c | sort -rn
```

```
    261 text-[11px]
    187 text-[10px]
     50 text-[12px]
     45 text-[13px]
     41 text-[9px]
      8 text-[9.5px]
      8 text-[10.5px]
      5 text-[11.5px]
      4 text-[8px]
      4 text-[15px]
      2 text-[7px]
      1 text-[12.5px]
```

### 关键结论

**两边形状一致**：都是 `10px` / `11px` 为主，`9px` / `13px` 零星。

**Claude 上游从来不用七档 token，它用的就是这套 px 值。**

### ★★★ 最硬的证据：上游 tailwind.config.js **没有 fontSize 段**

`open-claude-ui/code-examples/tailwind.config.js` 全文 93 行，`theme.extend` 下只有：

```js
colors: {...}
fontFamily: {...}      // 只是字体族，不是字号档位
borderRadius: {...}    // 圆角有 token（xs/sm/md/lg/panel/xl/2xl/bubble/composer/pill/card）
boxShadow: {...}
animation: {...}
```

**没有 `fontSize`。**

**意思是：Claude 桌面端没有「七档字号体系」这个东西。** 它圆角有 token、阴影有 token、颜色有 token、
**唯独字号是直接写 px 的** —— `text-[10px]`、`text-[11px]`、`text-[15px]`。

**所以我们花 T121 / T130 / T133 / T142 四张卡建立的七档，是 Claude 没有的东西。**

## 三、我们七档里的值，上游都没有

| 我们的档 | 值 | 上游有吗 |
|---|---|---|
| `caption` | 11/16 | 有 `text-[11px]`，但**没有固定行高**（走浏览器 normal ≈ 13.2px） |
| `footnote` | 12/14 | 有 `text-[12px]`，行高同样不固定 |
| `code` | 12/16 | 同上 |
| `body` | 14/20 | **上游没有 14px**（正文是 15px） |
| `prose` | 15/22 | 有 `text-[15px] leading-relaxed`（≈1.625 → 24.4px），**不是 22px** |
| `heading` | 16/20 | 上游没找到对应 |
| `title` | 20/24 | 上游没找到对应 |

**所以「迁移到七档」不是「更接近 Claude」，是「引入一套 Claude 没有的体系」。**

## 四、正文的真实情况（这一条最要紧）

### 上游的正文

```tsx
// ChatMessageBubbles.tsx:361
<div className="prose text-[15px] leading-relaxed ...">
```

**15px，`leading-relaxed` = 1.625 → 行高 24.4px。**

### 我们的正文

`MessageRow.tsx` **不用 `text-body` / `text-prose`**，正文走 `--chat-font-size`：

```css
/* styles.css:310 */
  --chat-font-size: 15px; /* default = upstream message body size */
/* styles.css:1996 */
  --chat-md-leading: 1.45;   /* CDS 上游 1.42857, 取整到 1.45 */
```

**15px / 1.45 → 行高 21.75px。上游是 24.4px —— 我们紧 2.65px。**

**⚠️ 而且 T142 刚刚把 22 处 `text-sm`（14/20）迁到了 `text-body`（14/20）。**
**这 22 处现在是 14px，而上游对应的位置多半是 10–11px 或 15px，很少是 14px。**

## 五、`--cds-rem-scale` 是另一个陷阱（容易被误读）

```css
/* cds-theme.css:9 */
  --cds-rem-scale: calc(16 / 17); /* 桌面端光学微调系数 ≈ 0.94117647 */
/* :178 */
  --chat-body: calc(.875rem * var(--cds-rem-scale, 1));   /* ≈ 13.18px */
```

**我一度以为这是正文的真实字号。错的。** 证据：

```bash
grep -rn "chat-body\|chat-leading" open-claude-ui/code-examples/*.tsx
# → 只有一行注释提到，没有一个组件真的用它
```

**`--chat-body` 是样式表里的变量，组件不用它。真实正文是 `.tsx` 里写的 `text-[15px]`。**

**这和 CLAUDE.md 记的 `var(--x, #fallback)` 是同一类陷阱**：CSS 里定义了一个值，不代表它在用。

## 六、所以要决定的事（三选一，需要用户拍板）

### 方案 A：**放弃七档，改成「上游 px 值 + 少量 token」**

- 承认上游就是 10/11/12/13/15 这套 px
- 七档只保留真正被使用的几档，其余删掉
- **优点**：和上游完全一致，迁移工作归零
- **缺点**：前四张卡（T121/T130/T133/T142）的成果部分作废

### 方案 B：**保留七档，但按上游真实值重定标**

| 档 | 现在 | 改成 | 依据 |
|---|---|---|---|
| `caption` | 11/16 | **11px，行高不固定**（或用上游的 normal） | 上游 `text-[11px]` 无固定行高 |
| `footnote` | 12/14 | **10px 或 12px**，行高不固定 | 上游主力是 10px |
| `code` | 12/16 | 12/16 保留 | 代码块需要固定行高 |
| `body` | 14/20 | **15/24.4**（`leading-relaxed`） | 上游正文 |
| `prose` | 15/22 | **15/24.4** | 同上 |
| `heading` | 16/20 | 保留（上游无对应） | — |
| `title` | 20/24 | 保留 | — |

- **优点**：保留体系，但值对齐上游
- **缺点**：`caption` 和 `footnote` 失去固定行高，那本来就是 T121 的设计意图（「11px 用 16px 行高和 20px 用 24px 是不同的视觉密度」）—— **这个意图和上游不一致**

### 方案 C：**接受「我们比上游多一套体系」，继续迁移**

- 继续把 px 迁到七档
- **优点**：内部一致性
- **缺点**：**迁移完和 Claude 不一样** —— 而这正是用户反复说的「UI 就是全盘模仿 Claude」

## 七、结论（两轮取证后定稿）

### 上游的完整字号谱系 = 6 个硬编码 px + 3 个 Tailwind 内置档

```bash
# 硬编码
grep -rhoE 'text-\[[0-9.]+px\]' open-claude-ui/ --include=*.tsx --include=*.ts | sort | uniq -c | sort -rn
     53 text-[10px]
     32 text-[11px]
      4 text-[9px]
      4 text-[15px]
      2 text-[13px]
      1 text-[14.5px] / text-[12px] / text-[11.5px] / text-[10.5px]

# 内置档（第一版漏了）
grep -rhoE '\btext-(xs|sm|base|lg|xl|2xl)\b' open-claude-ui/code-examples/*.tsx | sort | uniq -c | sort -rn
     72 text-xs     → 12px / 16px
     12 text-sm     → 14px / 20px
      4 text-base   → 16px / 24px
```

**合起来覆盖 9px–16px，9 个不同值。**

### 我们的七档对照

| 我们的档 | 值 | 上游依据 | 上游用量 | 判定 |
|---|---|---|---|---|
| `caption` | 11/16 | `text-[11px]` | **32 处** | ✅ 有依据 |
| `footnote` | 12/14 | `text-xs`（12/16）+ `text-[12px]` | **73 处** | ✅ 有依据（**行高不同：我们 14，上游 16**） |
| `code` | 12/16 | `text-xs` | 同上 | ✅ 有依据（行高一致） |
| `body` | 14/20 | **`text-sm`（14/20）** | **12 处** | ✅ **逐值相同** |
| `prose` | 15/22 | `text-[15px] leading-relaxed` | 4 处 | ⚠️ 字号对，**行高错（我们 22，上游 24.4）** |
| `heading` | 16/20 | `text-base`（16/24） | 4 处 | ⚠️ 字号对，**行高错（我们 20，上游 24）** |
| `title` | 20/24 | **无对应** | 0 | ⚠️ 上游样本里没有「主页面」，属于**样本未覆盖**，不是编的 |

### 所以：七档没有一档是编的，但有两个真问题

**问题 1：缺 10px 档**

`text-[10px]` 是上游**第一主力（53 处）**，而我们的七档最低是 `caption` 11px。
**我们缺了上游用得最多的那一档。**

**问题 2：行高不是上游的**

- `prose` 22 vs 上游 24.4
- `heading` 20 vs 上游 24
- `footnote` 14 vs 上游 16

**只有 `body`（14/20 = `text-sm`）和 `code`（12/16 = `text-xs`）逐值相同。**

### 结论：**七档方向对，但要重定标**

| 动作 | 内容 | 影响 |
|---|---|---|
| **① 补 10px 档** | 新增 `micro: ["10px", ...]` 或把 `footnote` 改成 10px | 187 处 `text-[10px]` 有档可归（但**不等于要迁移**） |
| **② 改 `prose` 行高** | 22 → **24.4**（`leading-relaxed`） | 长文段落变松 |
| **③ 改 `heading` 行高** | 20 → **24**（`text-base` 的默认） | 标题变松 |
| **④ 改 `footnote` 行高** | 14 → **16**（`text-xs` 的默认） | 辅助说明变松 |
| **⑤ `caption` 保持 11/16** | 上游 `text-[11px]` 无固定行高（走 normal 13.2），但**我们有 39 处用它，改行高会动很多** | **建议保持**，并注明「这是我们的选择，上游不固定」 |

**⚠️ ①②③④ 全部会改变用户看得见的东西，需要用户拍板。**

**这也是 T147（正文行高 1.45 → 1.625）的配套**：T147 改的是 `--chat-md-leading`（对话正文），
本卡改的是七档里的 `prose`/`heading`/`footnote`（组件级）。

### 为什么不是「放弃七档」

**Office 总控的纠正成立**：「上游没有 token」不等于「不该有档位」。
上游有一组固定像素值（9 个），只是没命名。**给它起名字是在命名一个已存在的体系。**

**而实测证明：我们七档里的 6 档都能在上游找到对应值。方向是对的，值需要校准。**

## 八、动手之前必须先回答的三件事 —— **我已经答完了**

### 1. 上游的 `leading` 到底是什么 —— **`leading-relaxed`（1.625），不是 1.42857**

**证据**：`cds-theme.css` 里**一条 `line-height` 规则都没有**：

```bash
grep -n "line-height:" open-claude-ui/code-examples/cds-theme.css
# → 零命中
```

`--chat-leading: 1.42857` 只在 `:179` 定义，**组件不用它**（同 `--chat-body` 的陷阱）。

**真实行高来自 `.tsx` 里的 Tailwind 类**：

```tsx
// ChatMessageBubbles.tsx:361
<div className="prose text-[15px] leading-relaxed ...">
```

`leading-relaxed` = **1.625** → 15 × 1.625 = **24.4px**。

**我们的 `--chat-md-leading: 1.45` → 21.75px。比上游紧 2.65px。**

### 2. `--cds-rem-scale` 作用在什么上 —— **只作用在圆角，不影响字号**

**证据**：全文件只有 5 处引用

```
:9    定义
:158  border-radius
:164  border-radius
:178  --chat-body（无人用的死变量）
:611  border-radius
```

**所以 `rem-scale` 是圆角的光学微调系数，和字号无关。** 我之前推的「正文 ≈13.18px」是错的 ——
那是一个**没人用的变量**算出来的值。

### 3. 用户要哪个 —— **需要在 T146 里拍板，但证据指向 (a) 数值一致**

用户原话「先照着 claude 做，先和 claude 一样」 → 是 (a)。

**而 (a) 意味着：Claude 没有七档，我们也不该强行有。**

## 九、如果选方案 A（我推荐），执行步骤

**⚠️ 这张卡本身不执行。它要的是决策。**

**决策之后（假设选 A）：**

### 第一步：把七档的值改成和上游 px 对齐

| 档 | 现在 | 改成 | 上游依据 |
|---|---|---|---|
| `caption` | 11/16 | **11px / 上线高** | 上游 `text-[11px]` 无固定行高 |
| `footnote` | 12/14 | **10px 或 12px / 无固定行高** | 上游主力是 10px |
| `code` | 12/16 | 12/16 保留 | 代码块需要 |
| `body` | 14/20 | **15 / 24.4**（`leading-relaxed`） | 上游正文 |
| `prose` | 15/22 | **15 / 24.4** | 同上 |
| `heading` | 16/20 | 保留 | 上游无对应 |
| `title` | 20/24 | 保留 | 上游无对应 |

### 第二步：**不改那 261 处 `text-[11px]`**

因为它们**已经和上游一致**。改了反而偏。

### 第三步：改正文行高（这一条用户能看见）

`--chat-md-leading: 1.45` → **1.625**

**这会让我们的大脑正文行高从 21.75px 变成 24.4px，松 2.65px。**
**这是真正「更像 Claude」的一处改动。**

### 第四步：跑视觉基线

T141 已经修好（`ccd96c4e`，51 格全拍，`unregistered: 0`）。现在能用了。

## 十、回写

1. **用户选了哪个方案**
2. 如果选 A：七档值改成了什么、正文行高改没改
3. 如果继续保留七档但停止迁移：写清「以后新代码可以用 px」
4. **你觉得不对但没改的**

---

## 附：我已经核实的事实清单（执行者不用重查）

| # | 事实 | 怎么核的 |
|---|---|---|
| 1 | 上游 `tailwind.config.js` 无 `fontSize` 段 | 读全文 93 行 |
| 2 | 上游 `cds-theme.css` 无 `line-height` 规则 | `grep -n "line-height:"` → 0 |
| 3 | 上游 `--chat-body` / `--chat-leading` 无人使用 | `grep -rn` 只命中注释 |
| 4 | 上游正文真身 = `text-[15px] leading-relaxed` | `ChatMessageBubbles.tsx:361` |
| 5 | 上游用户气泡 = `text-[14.5px] leading-relaxed` | `:154` |
| 6 | 上游输入框 = `text-[15px] leading-[1.4]` | `ChatComposer.tsx:145` |
| 7 | 上游硬编码分布：10px(53) / 11px(32) / 9px(4) / 15px(4) / 13px(2) | `grep -rhoE` |
| 8 | 我们硬编码分布：11px(261) / 10px(187) / 12px(50) / 13px(45) / 9px(41) | 同上 |
| 9 | 我们正文走 `--chat-font-size: 15px` + `--chat-md-leading: 1.45` | `styles.css:310,1996` |
| 10 | `--cds-rem-scale` 只用在圆角 | `grep -rn "rem-scale"` → 5 处，3 处 radius |
| 11 | 上游 `leading-relaxed` = 1.625（Tailwind 内置）| Tailwind 文档 + 未在 config 覆盖 |
| 12 | T142 完成后 `text-sm: 0` / `text-body: 114` | `grep -c` 实测 |
| 13 | T141 视觉基线可用（`ccd96c4e`，51 格，unregistered 0）| 我实跑 `run.sh`，EXIT=0 |
