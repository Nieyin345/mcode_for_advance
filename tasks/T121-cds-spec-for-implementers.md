# T121｜把 Claude 桌面端的设计规范变成「实现者清单」

> **这张卡不是文档复述。** 它回答一个问题：**照着改，改成什么值。**
>
> 每项都给「规范要求什么 / Mcode 现在是什么 / 差在哪 / 怎么改」，Mcode 那一列全部是从代码里读出来的真值（附 `file:line`），不是估的。

- **产物**：本文档
- **边界**：只读 + 写这一个 md。**不改任何代码**，不碰 `open-claude-ui/`。
- **来源**：`open-claude-ui/docs/claude-components-storybook.html`（10 节基础规范，结构化数据在第 629–720、755–1290 行）+ `docs/v1/`、`docs/v2/`
- **Mcode 侧取证**：`apps/desktop/src/renderer`（277 个 tsx）+ `styles.css`（3327 行）+ `tokens.cds.css` + `chat-motion.css` + `tailwind.config.js`，全量 grep 计数

---

## 零、先看这一节：三个会改变你判断的事实

### 事实 1：Mcode 的颜色**本来就是从 Claude 抄的**

`apps/desktop/src/renderer/tokens.cds.css` 文件头写明它由 `scripts/gen-cds-tokens.mjs` 从 `open-claude-ui` 生成，\`\`\`不要手改\`\`\`。颜色、部分圆角、部分阴影、部分缓动曲线**都是上游原值**。

**所以用户说「你只是换了一下颜色，这叫什么重构」是对的** —— 颜色恰恰是我们唯一已经抄对的部分。**再调颜色不会有任何变化。**

### 事实 2：真正的差距在**字号**，而这一项我们完全没有体系

`tailwind.config.js` 里**连 `fontSize` 都没有配置**。实际字号是三套并存：

| 来源 | 规模 |
|---|---|
| Tailwind 默认阶梯（`text-xs`/`text-sm`…） | 474 处 |
| **硬写 px 任意值** | **610 处，横跨 12 个档位**（7/8/9/9.5/10/10.5/11/11.5/12/12.5/13/15px） |
| **em 相对值**（`text-[0.7143em]` 等） | **728 处** |

**同一个层级的文字，在不同文件里可能是 10px、10.5px、11px、`text-xs`(12px) 四种之一。** 这就是「看起来不对劲但说不出哪不对」的主要来源。

### 事实 3：动效 token **建好了、接线了、基本没人用**

`styles.css:974-993` 有完整的 5 档时长 + 11 条曲线，`html[data-reduce-motion]` 总闸也接上了。但组件层实际是：

- 引用 `var(--dur-*)` 的地方：**6 处**
- 引用 `var(--ease-*)` 的地方：**7 处**
- 直接写 `duration-100` / `150` / `200`：**58 处**
- CSS 里手写 `cubic-bezier`：**27 次**

`styles.css:962-965` 的注释自己承认了这件事。**token 是摆设，实际节奏是「谁写这个组件谁随手挑一个数」决定的。**

---

## 一、逐项对照（十项）

### 1.1 Surface 0–3 分层

**规范**（storybook `:629`）：四层**明度阶梯**，逐层变亮。

| 层 | 亮色 | 暗色 | 用在哪 |
|---|---|---|---|
| Surface 0 | `#f5f5f3` | `#0b0b0a` | 侧边栏最底、无边框外壳 |
| Surface 1（主画布） | `#fcfcfb` | `#151515` | 主会话页面底色 |
| Surface 2 | `#ffffff` | `#1a1a19` | 独立卡片、面板 |
| Surface 3 | `#ffffff` | `#20201e` | 输入框、浮层顶色 |

**Mcode 现状**：只有 **2 个**背景层，而不是 4 个。

| 层 | Mcode 用什么 | 出处 |
|---|---|---|
| 最外层 / 侧栏 / 标题栏 | `bg-surface-muted` (`--m-gray-20` 亮 / `gray-800` 暗) | `ClassicShell.tsx:103`、`Titlebar.tsx:157` |
| 主区 / 中栏 | `bg-surface` (`--m-gray-10` 亮 / `gray-850` 暗) | `ThreePaneLayout.tsx:330` |
| **卡片** | **`bg-surface`（与主区同一个）** + `border border-edge` | `card.tsx:24` |
| **浮层/菜单** | **`bg-surface`（同一个）** + `border-edge` + `shadow-popover` | 53 处 |
| **弹窗** | **`bg-surface`（同一个）** + `border-edge` + `shadow-lg` | `dialog.tsx:84` |

**差在哪**：**主区、卡片、浮层、弹窗四层共用同一个 `--surface`。** 层次完全靠边框和阴影撑，没有「浮层比卡片更亮一档」的阶梯。这就是 Claude 那边看起来「有纵深」而 Mcode 看起来「平」的直接原因。

**怎么改**：新增 `--surface-raised`（卡片/浮层）与 `--surface-overlay`（弹窗），取值参照规范 —— 亮色按 `#fcfcfb → #ffffff → #ffffff`，暗色按 `#151515 → #1a1a19 → #20201e`。**注意亮色的 Surface 2 和 3 都是纯白**，所以亮色下真正起作用的是暗色阶梯和阴影。

**判定：⚠️ 有体系但层数不够（2 层 vs 4 层）。**

---

### 1.2 圆角层级

**规范**（storybook `:643`）：按**控件尺寸**分档，不是按感觉。

| 值 | 用在哪 |
|---|---|
| 2px | 微小分割指示器 |
| 4px | 键盘按键、代码微章 |
| **6px** | **XS 按钮（24px 高）、紧凑标签** |
| **8px** | **SM/MD 按钮、输入框、附件磁贴** |
| 10px | 工具栏面板、次级卡片 |
| **12px** | **LG 按钮（40px）、代码块、产物卡片** |
| **16px** | **模态弹窗、主外壳** |
| **18px** | **用户消息气泡** |
| 12px（2.0 扁平化后） | 输入终端（1.0 是 20px） |
| 999px | 分段胶囊、状态灯、头像 |

**Mcode 现状**：角色档 token 存在且**主力在用**，但底下压着大量裸值。

| Mcode token / 写法 | 值 | 消费点数 |
|---|---|---|
| `--radius-btn-xs` | 6px | 81 |
| `--radius-btn-md` | 8px | 57 |
| `--radius-card` | ≈12px | 19 |
| `--radius-dialog` | 16px | 11 |
| **`rounded`（裸 Tailwind）** | **4px** | **639** |
| `rounded-md`（裸） | 6px | 138 |
| `--radius-panel` | 10px | **0（定义了没人用）** |
| 用户气泡 | ≈12px + `rounded-br-[5px]` 小尾 | `MessageRow.tsx:316` |

**差在哪**：
1. **639 处裸 `rounded`(4px) 与 81 处 `--radius-btn-xs`(6px) 并存** —— 同样叫「小控件」，不同文件里是 4px 或 6px。
2. **气泡圆角 12px，规范是 18px。** 这是肉眼可辨的差距（Claude 的气泡明显更圆润）。
3. `--radius-panel` 定义了 0 消费。

**怎么改**：① 气泡改 18px；② 把 639 处裸 `rounded` 按「控件高度」归到 `--radius-btn-xs/md` 两档（≥32px 高用 8px，<32px 用 6px）；③ 删掉或接上 `--radius-panel`。

**判定：⚠️ 半体系 —— 角色档好用但被裸值淹没。**

---

### 1.3 编辑暖陶土色（Clay）

**规范**（storybook `:629` clayColors + `:81` 变量）：

| 角色 | 值 |
|---|---|
| Clay Base（主品牌色） | `#d97757` |
| Clay Hover | `#cc5a36`（亮）/ `#e08264`（暗，**反转：暗色下变亮**） |
| Clay Tint（浅底衬） | `#fbf3ef`（徽章背景、高亮浅衬） |

**Mcode 现状**：

| Mcode token | 亮色 | 暗色 |
|---|---|---|
| `--accent` | `194 81 36` = `#c25124` | `236 131 90` = `#ec835a` |
| `--accent-strong` | `174 70 28` = `#ae461c` | 同 `--accent` |
| `--brand-clay` | `#eb6834`（orange-350） | — |

**差在哪**：**Mcode 的 `--accent` 比 Claude 的 Clay 更深更红。** `#c25124` vs `#d97757` —— 前者是深砖红，后者是暖陶土。`--brand-clay` (`#eb6834`) 又比规范更亮更橙。**三个值互不相同，没有一个等于规范的 `#d97757`。**

这是「换了颜色但还是不对」的另一半原因：**不止层次平，主色本身也偏了**。

**怎么改**：`--brand-clay` 已存在且最接近，但 `#eb6834` ≠ `#d97757`。建议直接把 `--accent` 对齐到 `#d97757`（暗色 `#e08264`），并核对 AA 对比度 —— 现有注释写着 `--accent-strong` 是为了小字 AA 才加深的，那个用途要保留。

**判定：⚠️ 有 token，但值与规范不一致。**

---

### 1.4 中性灰与功能微色

**规范**（storybook `:755`）：10 档中性灰 + 一个专用冷灰蓝。

| 项 | 值 | 用在哪 |
|---|---|---|
| 中性灰阶 | `#f9f9f8` → `#151515`，10 档 | 全局 |
| `--cds-bg-tint-blue` | `#f0f4f8`（暗色 `rgba(255,255,255,0.06)`） | **用户气泡冷灰蓝底** |

**功能色**：storybook 1.4 节**只给了中性灰和 tint-blue，没有给成功/警告/错误/信息四色** —— 这四项在 Claude 桌面端是通过 Tailwind 原生调色板（red/amber/emerald/violet）用的，没有专门的 CDS token。

**Mcode 现状**：这一项**做得比规范更完整**。

| 语义 | 亮色 | 暗色 |
|---|---|---|
| `--danger` | red-600 | red-400 |
| `--warning` | amber-700 | amber-400 |
| `--info` | violet-600 | violet-400 |
| `--success` | emerald-700 | emerald-500 |
| `--user-bubble` | `#f7d8cb`（暖橙） | `#240e07` |

**差在哪**：功能四色 ✓ 没问题。**但用户气泡用的是暖橙 `#f7d8cb`，规范是冷灰蓝 `#f0f4f8`。**

**这里有个细节值得记下来**：`styles.css:261` 那条注释原文是

```css
--user-bubble: var(--m-orange-100); /* #f7d8cb — Claude user bubble */
```

**它确实是照着 Claude 取的 —— 但是 1.0 的 Claude。** 2.0 已经把用户气泡换成了冷灰蓝 `--cds-bg-tint-blue: #f0f4f8`。我们抄了一个已经被上游换掉的值，注释还写着「Claude user bubble」，读起来像是对的。

**这是「抄对了上游、但抄的是旧版」的一个具体样本** —— 也是为什么光看「值是不是从上游来的」不够，还得看是**哪一版**的上游。

**怎么改**：`--user-bubble` 改为 `#f0f4f8`（亮）/ `rgba(255,255,255,0.06)` 叠在 surface 上（暗）。

**判定：✅ 功能色齐全（比规范细）；⚠️ 气泡底色与规范相反（暖 vs 冷）。**

---

### 1.5 七档字阶

**规范**（storybook `:659`，7 档完整音阶）：

| 档位 | 实际 px | 行高 | 字重 | 用在哪 |
|---|---|---|---|---|
| caption | **11px** | 16px (1.55) | 500 / 580 | 微型标签、Kbd、时间戳、模型角标 |
| footnote | **12px** | 14px (1.25) | 400 / 500 | 辅助说明、文件大小、Token 统计 |
| code | **12px** | 16px (1.42) | 400 Mono | 代码块、行内代码、diff |
| **body（基准）** | **14px** | **20px (1.46)** | 400（暗色 360） | **对话正文、提问气泡、输入框、表单** |
| prose | **15px** | 22px (1.45) | 400 / 500 | 长文段落、Artifacts 文档正文 |
| heading | **16px** | 20px (1.29) | 580 / 600 | 卡片小节标题、弹窗标题、代码语言 |
| title | **20px** | 24px (1.25) | 580 / 600 | 主页面大标题、Project 名称 |

**Mcode 现状**：**没有这个阶梯。**

`tailwind.config.js` 的 `theme.extend` 里只有 `fontFamily.mono` 和 `colors`，**`fontSize` 完全没配**。实际字号三套并存：

| 来源 | 规模 | 举例 |
|---|---|---|
| Tailwind 默认 | 474 处 | `text-xs`(12/16)、`text-sm`(14/20) |
| **硬 px 任意值** | **610 处，12 个档位** | `text-[11px]` 280、`text-[10px]` 200、`text-[13px]` 45、`text-[9px]` 46 |
| **em 相对值** | **728 处** | `text-[0.7857em]` 294、`text-[0.7143em]` 239 |

字重也被全局改过：`font-normal`=500、`font-medium`=600、`font-semibold`=700、`font-bold`=800（`styles.css:511-537`）—— **比 Tailwind 默认各重 100~200**，与规范的 400/500/580/600 完全不同。

**语义位置对照**：

| 位置 | 规范 | Mcode 现在 | 差 |
|---|---|---|---|
| 对话正文 | 14 / 20 / 400 | `--chat-font-size` 14px，行高 **1.45** | ✓ 基本对（行高 1.45 vs 1.46） |
| 用户气泡 | 14 / 400 | 同上 | ✓ |
| 弹窗标题 | **16 / 20 / 600** | **`text-sm`(14px) semibold** | **小 2px** |
| 面板标题 | heading 16 | `--chat-fs-sm` ≈13px | **小 3px** |
| 元信息 | caption 11 / footnote 12 | `text-[0.7143em]`≈10px / `text-[10px]` | **小 1~2px** |
| 空态标题 | title 20 | `text-[0.8571em]`≈12px | **小 8px** |
| 首页大标题 | title 20 | `text-2xl`(24px) | **大 4px** |
| 按钮 sm / md | 13 / 14 | `text-[11px]` / `text-xs`(12px) | **小 2px** |

**判定：❌ 不存在。这是最大的一项差距。**

---

### 1.6 视网膜补偿（暗色字重减薄）

**规范**（storybook `:830`）：暗色下用可变字体轴**主动减薄**，因为高亮白字在 OLED 上会光渗膨胀 10~15%。

| 字重档 | 亮色 | 暗色 |
|---|---|---|
| Regular | 400 | **360**（-40） |
| Medium | 500 | **460**（-40） |
| Semibold | 580 | **550**（-30） |
| Bold | 700 | **660**（-40） |

**Mcode 现状**：**完全没有。** 字重是全局调高（normal=500、medium=600、semibold=700、bold=800），而且**亮暗同一套值**，没有暗色减薄。

**差在哪**：我们不但没减薄，反而整体**加重了**。在暗色下这是双重叠加 —— 白字本来就光渗，我们还给它 +100 字重。**这是「暗色模式看着糊/胖」的直接原因。**

**怎么改**：在 `.dark` 下用 `font-variation-settings: "wght" ...` 做逆补偿。**前提是字体支持可变轴** —— 需要先确认 `styles.css` 里的 sans 字体族是否加载了 variable font，否则这条件不成立（那就只能靠 `font-weight` 数值微调，效果差一些）。

**判定：❌ 不存在，而且方向相反。**

---

### 1.7 内容-字号矩阵

**规范**（storybook `:670`，18 行速查表）：按**区域**（chat / composer / artifacts / controls）+ **元素**给出字号、字重、字体族。

关键几条：

| 区域 | 元素 | 字号 | 字重 | 字体 |
|---|---|---|---|---|
| chat | 助手身份（"Claude"） | 12px | 580 | Sans |
| chat | 模型版本角标 | **10px** | 500 | **Mono** |
| chat | 消息时间戳 | **11px** | 400 | **Mono** |
| chat | 思考折叠触发器 | 12px | 500 | Sans |
| chat | 思考链内部日志 | 11~12px | 400 | **Mono** |
| composer | 输入框文字 | 14px | 400 | Sans |
| composer | 操作按钮 | 12px | 500 | Sans |
| artifacts | 代码块 | 12~13px | 400 | **Mono** |
| artifacts | Artifact 卡片标题 | 13px | 580 | Sans |
| controls | 标准按钮（SM 32 / MD 38） | **13 / 14px** | 500 | Sans |
| controls | 弹窗标题 | **15~16px** | 580 | Sans |
| controls | 快捷键徽章 Kbd | 10~11px | 580 | **Mono** |

**Mcode 现状**：**没有这张表。** 同层级元素散落在不同值上（见 1.5 的语义位置对照）。

**这条为什么重要**：它是 1.5 的**落地形式**。光有 7 档阶梯不够 —— 得知道「这个位置该用哪一档」。规范里这张表是 18 行，我们一行都没有。

**怎么改**：把这张表按 Mcode 现有的区域（对话流 / 输入框 / 编辑器 / 控件）翻译一遍，作为**评审时的检查清单**。

**判定：❌ 不存在。**

---

### 1.8 发丝线

**规范**（storybook `:972`）：视网膜屏上**避免 1px 粗黑边**，用 `0.5px` 发丝线。

| 粗细 | 值 | 用在哪 |
|---|---|---|
| **0.5px** | `--cds-ring-hairline` = `0.5px`（`calc(1px/3)` 兜底） | 表格内部分割、未激活 Tab 缝隙、次级标签、极细胶囊 |
| **1.0px** | `--cds-border` = `--cds-alpha-2`（10% alpha） | 主卡片面板、输入框常态、浮层外缘、顶栏分割线 |
| **1.5px** | `inset 1.5px` currentColor | 分段选择器选中滑块、单选/复选激活外环 |

关键：**规范里 1px 线的颜色是 10% alpha，不是实色。** 所以它在任何背景上都「几乎看不见但存在」。

**Mcode 现状**：

| 项 | Mcode |
|---|---|
| 默认边框 | `border` = 1px |
| 边框色 | `border-edge` **667 处**（`--edge` = `gray-200` 亮 / `gray-750` 暗，**实色不是 alpha**） |
| 结构分隔 | `border-edge-panel` 11 处 |
| 输入框 | `border-edge-input` 14 处 |
| **半像素** | **`border-[0.5px]` 全仓 0 处** |
| 唯一的 0.5px | `boxShadow: inset 0 0 0 0.5px rgb(var(--edge)/0.55)`（`Segmented.tsx:84,95`） |
| 选中态 | `ring-1 ring-inset ring-edge/70` 28 处 + `edge-selected` 12 处（**两种写法并存**） |

**差在哪**：
1. **没有 0.5px 发丝线** —— 视网膜屏上我们的 1px 边看起来比 Claude 重一倍。
2. **`--edge` 是实色 `#c3c2b7`，规范是 10% alpha。** 实色在深浅背景上对比度恒定，alpha 会自适应 —— 这是「边框太抢眼」的原因。
3. 选中态两套写法要统一。

**怎么改**：`--edge` 改为 `rgb(0 0 0 / 0.10)`（亮）/ `rgb(255 255 255 / 0.09)`（暗）；新增 `--hairline: 0.5px` 并给表格/Tab 缝隙用上。

**判定：⚠️ 简单但一致，缺发丝线和 alpha 自适应。**

---

### 1.9 四层弥散阴影

**规范**（storybook `:1057`）：**双层复合公式** —— 近距微遮蔽（Ambient Occlusion）+ 远距深层漫反射（Elevation Diffusion），不是单层模糊。

| token | 亮色值 | 用在哪 |
|---|---|---|
| `--cds-shadow-sm` | `0 1px 2px rgba(0,0,0,.05), 0 2px 8px rgba(0,0,0,.08)` | 基础微立体卡片 |
| `--cds-shadow-md` | `0 2px 4px .05, 0 6px 16px .08` | 悬浮展开卡片 |
| `--cds-shadow-lg` | `0 4px 8px .06, 0 12px 28px -2px .08` | 全局模态 |
| `--cds-shadow-popover` | `inset 0 0 0 1px ring, 0 8px 24px .12, 0 2px 6px .08` | **双环浮动气泡** |
| `--cds-shadow-composer` | `0 4px 20px .035, inset 0 0 0 1px edge` | 输入终端常态 |
| `--cds-shadow-composer-hover` | `0 4px 24px .06, inset 0 0 0 1px border-strong` | 输入终端 hover |
| `--cds-shadow-composer-focus` | `0 4px 24px .08, inset 0 0 0 1px border-strong` | 输入终端聚焦 |
| `--cds-focus-shadow` | `inset 0 0 0 1px surface, 0 0 0 1.5px clay, 0 0 8px 2px rgba(clay,.35)` | **三层光晕焦点环** |

**Mcode 现状**：**这一项抄得比较完整。**

| Mcode token | 对应规范 | 消费 |
|---|---|---|
| `--shadow-card`（= `--m-shadow-sm`） | ✓ 一致 | **0（定义了没人用）** |
| `--shadow-lg`（= `--m-shadow-lg`） | ✓ 一致 | 1 处 token + 5 处裸 `shadow-lg` |
| `--shadow-popover`（= `--m-shadow-popover`） | ✓ 基本一致 | **53 处（事实标准）** |
| `--composer-shadow` / `-focus` | ✓ 一致 | 各 1 处 |
| `--focus-ring` | 有，但只在 CSS 内部用 | tsx 0 次 |

**差在哪**：
1. **`--shadow-card` 零消费** —— `card.tsx:24` 只靠边框，不用阴影。所以卡片没有「浮起来」的感觉。
2. 抽屉/弹窗层还有 **24 处裸 `shadow-xl` / `2xl` / `lg`** 混用，没走 token。
3. `styles.css:1040` 有一条重要注释：`--shadow-lg` **曾经从未定义**，而 `dialog.tsx` 写了 `shadow-[var(--shadow-lg)]` —— **所有弹窗实际没有阴影**（已补）。

**怎么改**：① 卡片接上 `--shadow-card`；② 24 处裸 `shadow-xl/2xl` 归到 token；③ 检查还有没有别的「引用了未定义 token」的地方 —— 这是会静默失效的一类 bug。

**判定：✅ token 齐全（唯一抄得完整的几何项）；⚠️ 消费不完整，且有过静默失效史。**

---

### 1.10 Hover 微反馈

**规范**（storybook `:242-266`，做成了可复用 CSS 类）：

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

**Mcode 现状**：token 建好了，**基本没人用**。

| 项 | 数量 |
|---|---|
| `var(--dur-*)` 在 tsx 中 | **6 处** |
| `var(--ease-*)` 在 tsx 中 | **7 处** |
| `duration-100` | **36 处** |
| `duration-150` / `200` / `300` / `500` | 13 / 9 / 3 / 1 |
| CSS 里手写 `cubic-bezier` | **27 次** |
| `transition-colors` | 330 处 |
| hover 底色 | `hover:bg-surface-hover` **238 处** |
| hover 底色的半透明变体 | `/60` 51、`/50` 10、`/70` 6、`/40` 4、`/45` 2 |
| active | **与 hover 同一个 token**（`--surface-hover`，注释明写「hover/active fills」） |
| disabled | `opacity-50` 40、`opacity-40` 22、`opacity-30` 3、`opacity-60` 2（**三档混用**） |

**差在哪**：
1. **没有可复用的 hover 类** —— 238 处各写各的。
2. **active 和 hover 用同一个颜色** —— 按下没有额外反馈（只有 6 处 `active:scale-95`）。
3. **hover 底色 5 种 alpha 档**（/40 /45 /50 /60 /70）随手用。
4. **disabled 4 档 opacity 混用**。
5. 时长散在 100/150/200，token 躺着没人用。

**怎么改**：把 `.cds-hover-ghost` / `.cds-card-interactive` 这两个类照搬过来（值现成），然后把 238 处 `hover:bg-surface-hover` 收敛到这两个类上。

**判定：❌ 无统一机制（token 存在但未消费）。**

---

## 二、如果只改三件事，改哪三件

排序依据：**用户能看见的差距 ÷ 改动成本**。

### 第一件：立起字阶（1.5 + 1.7）

**为什么是它**：这是**唯一一项我们完全没有体系、而且用户每天都在看**的东西。610 处硬 px + 728 处 em + 474 处默认阶梯三套并存 —— 「看着不对劲但说不出哪不对」主要就是它。

**具体做**：
1. 在 `tailwind.config.js` 加 `fontSize`，照规范的 7 档（11/12/14/15/16/20），每档配 lineHeight。
2. 把 `styles.css:511-537` 那套「全局加重 100」的字重改回来（normal=400、medium=500、semibold=580）。
3. 按 1.7 的矩阵，逐区域把元素映射到档位上。

**成本**：中。要改 `tailwind.config.js` + 大量组件，但改动是机械的、可分批。

**用户感知**：**最高。** 字号统一之后，「像不像 Claude」会立刻变化。

---

### 第二件：Surface 分层 + 气泡底色（1.1 + 1.4）

**为什么是它**：**这两个是「平」和「暖」的直接原因**，而且改动极小。

**具体做**：
1. 新增 `--surface-raised`（卡片/浮层）与 `--surface-overlay`（弹窗），把 `card.tsx:24`、53 处浮层、`dialog.tsx:84` 接上（**现在是四层共用一个 `--surface`**）。
2. `--user-bubble` 从暖橙 `#f7d8cb` 改成冷灰蓝 `#f0f4f8`（暗色 `rgba(255,255,255,0.06)`）。
3. 卡片接上 `--shadow-card`（现在零消费，只靠边框）。

**成本**：**低。** 改 5 个 CSS 变量 + 几个 className。

**用户感知**：**高。** 纵深立刻出来，气泡不再和品牌色撞。

---

### 第三件：Hover / active 做成可复用类（1.10）

**为什么是它**：**token 建好了、总闸也接了，就差最后一步接线**，属于「成本最低、回报明确」的一项。而且它顺带修一个真 bug：**active 和 hover 同色**，按下没反馈。

**具体做**：
1. 把 `.cds-hover-ghost` / `.cds-card-interactive` 照搬进 `styles.css`（值现成，不用设计）。
2. 给 `--surface-hover` 拆出独立的 `--surface-active`（现在注释明写两者共用）。
3. 时长统一走 `--dur-*`，把 36 处 `duration-100` 迁过来。

**成本**：**低到中。** 两个类 + 一个 token + 批量替换。

**用户感知**：中高。手感变化明显，但不如前两项抢眼。

---

### 为什么**不**把「Clay 主色」放进前三

主色确实偏了（`#c25124` vs `#d97757`），但：

1. **用户已经说了「你只是换了一下颜色」** —— 再调一次颜色，不会改变这个印象，反而会强化它；
2. 颜色是**我们唯一已经接近规范**的一项，边际收益最低；
3. 它应该**跟着第一件的字阶一起做**（改字号时顺手对齐主色），而不是单独占一个坑位。

同理，**阴影（1.9）不进前三**：它抄得已经比较完整，53 处已经走了 `--shadow-popover`，剩下的是收敛 24 处裸值，属于清理而非提升。

---

### 补一条：两种病，别用同一种药

做这份对照时浮出来一个区分，**它会改变你处理每一行差异的方式**：

| 病 | 表现 | 药 |
|---|---|---|
| **没抄** | 字号三套并存、没有发丝线、hover 各写各的 | **建立体系**（前三件事都是这一类） |
| **抄了旧版** | 用户气泡 `#f7d8cb` 注释写着「Claude user bubble」，实际是 1.0 的值，2.0 已改成冷灰蓝 | **核对上游版本，再更新值** |

**第二种更危险**，因为它的注释读起来是对的 —— `/* #f7d8cb — Claude user bubble */` 让你以为这个值经过考据。**实际上它确实经过考据，只是考据的是两年前的 Claude。**

**所以每一项都要多问一句：这个值是从上游来的吗？如果是，是哪个版本的上游？**

同样的嫌疑也在主色上：`--accent` 是 `#c25124`，`--brand-clay`（注释写「上游原始陶土色」）是 `#eb6834`，而规范是 `#d97757`。**三个值互不相同，说明至少有两个已经漂移了。**

---

## 三、给实现者的检查清单

改任何一个界面之前，问这七个问题：

1. **这个元素的字号，是 7 档里的哪一档？** 不在任何一档 → 先停下来对齐。
2. **它在 Surface 的哪一层？** 卡片/浮层/弹窗是不是又被塞进了 `bg-surface`？
3. **边框是 `--edge` 实色还是 alpha？** 该用发丝线的地方用了 1px 吗？
4. **hover 用的是可复用类，还是又写了一遍 `hover:bg-surface-hover`？**
5. **active 有没有和 hover 区分开？**
6. **这个阴影是 token，还是裸 `shadow-xl`？**
7. **这个值是「照规范」，还是「看起来差不多」？**

**最后一个问题最要紧。** 这份文档存在的全部意义，就是让「看起来差不多」有一个可以对照的答案。

---

## 四、遗留与未覆盖

1. **没有核对亮色的实际观感** —— 本文档只比对数值。规范的亮色 Surface 2/3 都是纯白，视觉上靠阴影和 alpha 边框分层，改完需要真机看。
2. **没有覆盖 1.6 的前提** —— 暗色字重减薄依赖可变字体。`styles.css` 的 sans 字体族是否加载了 variable font **没有核对**。如果没加载，这一项要先解决字体，否则 `font-variation-settings` 无效。
3. **v2 文档里还有 47 项动效参数与 40 个组件命名空间**，本文档只取了基础规范十项，没有展开。
4. **组件级对照（C 在做的那 36 个组件）不在本文档范围内** —— 这里给的是**规范基准**，具体哪个组件要改成什么样，属于下一层工作。
