# Claude Desktop 3.6556.2.0 逆向结果

> 逆向时间：2026-10-27
> 目标：`C:\Program Files\WindowsApps\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc`
> 方法：只读静态分析（CSS token 提取 + JS 字面量扫描 + i18n 文案）+ REA 语义图
> **未执行目标程序**，未挂 CDP。

---

## 0. 先记五个「逆向踩过的坑」

这些坑让上一版的结论**整批作废**，记下来免得再犯。

| # | 坑 | 表现 |
|---|---|---|
| 1 | **版本号变了** | 上一版按 `3.1623.4.0` 逆向；现在装的是 **`3.6556.2.0`**。CSS 主文件 hash 从 `Bt_TAkxU` 变成 `Che1orl5`，体积 1446KB → 1493KB。 |
| 2 | **主题变量不在 `:root` / `.dark`** | 在 **`.cds-root`** 上；暗色走 `[data-mode=dark]` 与 `@media (prefers-color-scheme:dark)`。按 `.dark` 找会得到 0 个变量。 |
| 3 | **选择器用 `includes` 判会串层** | `.cds-root [data-step="3"]` 也含 `.cds-root`。必须**完全相等**才算 base，否则「文本大小档 3」会覆盖真 base。**而且要先按逗号拆开** —— 暗色三层写在同一个逗号组合选择器里，不拆只命中第一段。 |
| 4 | **调色板在 `:where(:root,:host)` 上** | 只认 `:root` 会让所有 `var(--cds-gray-20)` 解不开，颜色表全空。 |
| 5 | **`data-cds` 名在 CSS 里≠在 JS 里** | `ChatComposerDock` 在 CSS 出现 10 次，在 JS 出现 **0 次**。输入框的真实 DOM 标识是 `.epitaxy-prompt` / `[data-cds="ChatComposer"]`。 |

还有两个纯计算错误（都在我自己的脚本里，已修）：

| 错 | 后果 |
|---|---|
| `calc(16 / 17)` 这种「无单位无 `*`」的形状没解析 | `rem-scale` 解成 null → 回落 1 → **每一格偏大 6.25%** |
| 裸 `rem` 也乘了 `rem-scale` | `prose: .875rem` 报成 13.18px，实际 **14.00px** |

---

## 1. 字号：七档 × 多层可变

**这不是一组固定数字。** Claude 的字号由三层正交设置决定：

```
.cds-root                                 默认
.cds-root[data-density=comfortable]       宽松密度
.cds-root [data-step="1".."5"]            文本大小设置（5 档）
.cds-root [data-size=xs|sm|lg]            组件尺寸
```

计算基：`--cds-rem-scale: calc(16 / 17)` ≈ **0.941176**
公式：`calc(Nrem × rem-scale)` → `N × 16 × 0.941176`

### 1.1 基础层（`.cds-root`，无 density 覆盖）

| 档 | 字号 | 行高 | 原始值 |
|---|---|---|---|
| caption | **10.353px** | 16.000px | `calc(.6875rem * scale)` |
| footnote | **11.294px** | 14.118px | `calc(.75rem * scale)` |
| code | **11.294px** | 16.000px | `calc(.75rem * scale)` |
| body | **12.235px** | 17.882px | `calc(.8125rem * scale)` |
| prose | **14.000px** | 20.000px | **`.875rem`（裸值，不乘 scale）** |
| heading | **13.176px** | 16.941px | `calc(.875rem * scale)` |
| title | **18.824px** | 23.529px | `calc(1.25rem * scale)` |

> ⚠️ **`prose` 是唯一一条裸 `rem`**。它不乘 `rem-scale`，所以是 14.00 而不是 13.18。
> 这一条已经让上一版算出过错误结论，值得单独记。

### 1.2 comfortable 密度（**这是真实默认**）

`index.html` 的 `<html>` 上写着 `data-density="comfortable"` —— 所以真实首屏用的是这一层：

| 档 | 字号 | 行高 |
|---|---|---|
| caption | 11.294px | 16.000px |
| footnote | 12.235px | 16.000px |
| code | 12.235px | 17.882px |
| body | 13.176px | 18.824px |
| prose | 16.000px | 24.000px |
| heading | 14.118px | 18.824px |
| title | 20.706px | 26.353px |

### 1.3 文本大小 5 档（`data-step`）

| step | caption | body | prose | title |
|---|---|---|---|---|
| 1 | 9.412 | 11.294 | 13.000 | 18.824 |
| 2 | 10.353 | 12.235 | 14.000 | 18.824 |
| 3 | 11.294 | 13.176 | 15.000 | 18.824 |
| 4 | 11.294 | 13.176 | 16.000 | 18.824 |
| 5 | 11.294 | 13.176 | 16.941 | 18.824 |

> heading 五档都是 13.176 —— 它**不随 step 变**。

---

## 2. ★ 正文排版：`--chat-body` / `--chat-turn-gap`（最有价值的一组）

`.epitaxy-root` 是聊天区的根，正文排版由它派生：

```css
.epitaxy-root .epitaxy-transcript-typography {
  --chat-body:        calc(.875rem * var(--cds-rem-scale,1));
  --chat-leading:     1.4286;
  --chat-turn-gap:    calc(var(--chat-body) * var(--chat-leading) * .75);
  --chat-item-gap:    calc(var(--chat-body) * var(--chat-leading) * .5);
  font-size:          var(--chat-body);
  line-height:        var(--chat-leading);
}
.epitaxy-root {
  --chat-gutter: 32px;
  --prompt-text-code:  .928571em;
  --prompt-leading-code: 1.53846;
}
```

算出来：

| 量 | 值 | 说明 |
|---|---|---|
| `--chat-body` | **13.1765px** | 正文实际字号 |
| 实际 line-height | **18.8239px** | `13.1765 × 1.4286` |
| `--chat-turn-gap` | **14.1179px** | 轮次之间 |
| `--chat-item-gap` | **9.4120px** | 轮内条目之间 |
| `--chat-gutter` | **32px** | 固定，不随字号 |

**文本大小三档的正交覆盖：**

| `data-chat-text-size` | body | line-height | turn-gap |
|---|---|---|---|
| `s` | 12.2353 | 17.4793 | 13.1095 |
| （默认） | 13.1765 | 18.8239 | 14.1179 |
| `l` | 14.1176 | 20.7059 | 15.5294 |

**消息区容器的间距与留白**（来自 className）：
```
epitaxy-transcript-typography … flex flex-col gap-[var(--chat-turn-gap)] pt-[48px] pb-[32px]
```

- 上下留白 **48px / 32px**（固定 px，不是 rem）
- 轮次间距走 `gap`，不是各自 margin

---

## 3. 几何 token（基础层，已折算 px）

| token | 值 | 原始 |
|---|---|---|
| `--cds-radius` | 5.647px | `calc(.375rem * scale)` |
| `--cds-radius--sm` | 4.706px | `calc(.3125rem * scale)` |
| `--cds-radius--xs` | 4.706px | `calc(.3125rem * scale)` |
| `--cds-radius-composer` | 11.294px | `calc(.75rem * scale)` |
| `--cds-panel-radius` | 9.412px | `calc(.625rem * scale)` |
| `--cds-panel-gap` | 7.529px | `calc(.5rem * scale)` |
| `--cds-panel-inset` | 7.529px | `calc(.5rem * scale)` |
| `--cds-pad-xs` | 3.765px | `calc(.25rem * scale)` |
| `--cds-pad-sm` | 5.647px | `calc(.375rem * scale)` |
| `--cds-pad-md` | 7.529px | `calc(.5rem * scale)` |
| `--cds-pad-lg` | 11.294px | `calc(.75rem * scale)` |
| `--cds-pad-xl` | 18.824px | `calc(1.25rem * scale)` |
| `--cds-gap-xs` | 5.647px | `calc(.375rem * scale)` |
| `--cds-gap-sm` | 7.529px | `calc(.5rem * scale)` |
| `--cds-gap-md` | 11.294px | `calc(.75rem * scale)` |
| `--cds-gap-lg` | 18.824px | `calc(1.25rem * scale)` |
| `--cds-gap-xl` | 30.118px | `calc(2rem * scale)` |
| `--cds-h-control` | 22.588px | `calc(1.5rem * scale)` |
| `--cds-h-control--sm` | 18.824px | `calc(1.25rem * scale)` |
| `--cds-h-control-nested` | 16.941px | `calc(1.125rem * scale)` |
| `--cds-font-size-text-entry-floor` | **16.000px** | 输入框最小字号（防 iOS 缩放） |

**comfortable 层会整体放大**（pad-lg 11.29→15.06、h-control 22.59→30.12、radius 5.65→7.53…）。

---

## 4. 消息组件

### 4.1 组件级变量（各自的选择器上）

```css
/* 助手消息 —— 注意：不是 0 */
.cds-root [data-cds=AssistantMessage] {
  --cds-assistant-message-text-inset: 4px;
  --cds-assistant-message-text-stop:  clamp(0px, (100% - 384px) * .175, 56px);
}

/* 气泡变体（[data-variant=bubble]）—— 这才是 0 */
.cds-root [data-cds=AssistantMessage][data-variant=bubble] {
  --cds-assistant-message-text-inset: var(--cds-message-bubble-pad-x);
  --cds-assistant-message-text-stop:  0px;
  --cds-message-bubble-item-gap:      0px;
  --cds-message-bubble-stack-gap:     2px;
}

/* 气泡几何 —— 只在 UserMessage 与 bubble 助手消息上 */
.cds-root [data-cds=UserMessage],
.cds-root [data-cds=AssistantMessage][data-variant=bubble] {
  --cds-message-bubble-measure:  85%;
  --cds-message-bubble-pad-x:    var(--cds-pad-lg);
  --cds-message-bubble-pad-y:    var(--cds-pad-md);
  --cds-message-bubble-radius:   calc(var(--cds-radius) + calc(.25rem * var(--cds-rem-scale,1)));
}
```

> ⚠️ **上一版把 `--cds-assistant-message-text-inset` 报成 0，是抓错了变体。**
> 默认助手消息是 **4px**；0 只属于气泡变体。

### 4.2 气泡布局

```css
.cds-root [data-cds=AssistantMessage][data-variant=bubble] [data-cds=Prose] {
  width: fit-content;
  max-width: var(--cds-message-bubble-measure);      /* 85% */
  padding: var(--cds-message-bubble-pad-y) var(--cds-message-bubble-pad-x);
  border-radius: var(--cds-message-bubble-radius);
}
```

### 4.3 ★ 关键的隐藏量：`--cds-outset-x` / `--cds-turn-status-hang`

```css
*, :before, :after, ::backdrop {
  --cds-outset-x: 0px;
  --cds-outset-y: 0px;
  --cds-scroll-fade-size: 28px;
  --cds-scroll-fade-top: 0px;
  --cds-scroll-fade-bottom: 0px;
}

/* 消息左侧缩进 = inset − outset − turn-status-hang */
.ms-[calc(var(--cds-assistant-message-text-inset,0px)
        - var(--cds-outset-x,0px)
        - var(--cds-turn-status-hang,0px))]
```

**`--cds-turn-status-hang` 在 CSS 里从未被赋值** —— 它只出现在 `calc()` 里。
所以默认它取 fallback `0px`，但**它是一个可运行时改写的旋钮**（用于「回合状态」图标挂在左边时把正文推出去）。
逆向时若只看 `.cds-root` 会完全漏掉这条。

---

## 5. 布局骨架：命名容器查询

Claude 用 **container query** 而不是 media query 做响应式，且**按区域命名**：

| 容器名 | 断点 | 用途 |
|---|---|---|
| `feed` | `width>=36rem` | 消息流 |
| `run` | `width>=640px` | 一次运行 |
| `titlebar` | `width>=480px` | 标题栏 |
| `list` | `width>=400px` | 列表 |
| `memory` | `width>=30rem` | 记忆 |
| `library` | `width>=40rem` | 资料库 |
| `docbar` | `width>=32rem` | 文档栏 |
| `agents` / `branch-row` / `branch-chip` / `browser` | — | 分支/浏览器 |

其他断点（匿名容器）：`480px` / `640px` / `800px` / `20rem` / `24rem` / `28rem` / `30rem` / `32rem` / `36rem` / `40rem` / `460px`。

---

## 6. 界面文案（en-US.json，按值归类）

> **键是混淆 id**（如 `+/cwsayrqk`），按键名匹配会 0 命中。必须按值匹配。

### 6.1 三个并列模式

`Cowork` · `Code` · `Design` · `Claude Code`

### 6.2 侧栏 / 导航

| 文案 | 说明 |
|---|---|
| `Sidebar` | 侧栏本身 |
| `Hide Sidebar` / `Show Sidebar` | 折叠 |
| `Search…` | 搜索框占位符 |
| `New Chat` | ⚠️ **不是 `New Session`** |
| `Pin folder` / `Unpin folder` / `Manage folders` / `Add folder` / `Remove folder` | 文件夹管理 |
| `Reopen Closed Session` / `Close Session` | 会话 |
| `Sessions Waiting for You` / `Needs Your Input` | 待处理区 |
| `New Session Below` / `New Session on the Right` / `New Session in New Window` | 新建的三个位置 |

### 6.3 标题栏 / 窗口

`Minimize` · `Close Window` · `Enter Full Screen` / `Exit Full Screen` · `Split View` · `Close Split View` · `Move Split View {Up,Down,Left,Right}` · `Close Pane`

### 6.4 输入框

| 文案 | 说明 |
|---|---|
| `What can I help you with today?` | **占位符原文** |
| `Send to Claude` | 发送 |
| `Upload` / `Uploading…` | 上传 |

⚠️ 有意思的**缺失**：`输入框` 组里**没有** `Attach file` / `Add file` 之类短文案 ——
说明附件入口是**图标按钮 + tooltip**，或者用的是别的词。

### 6.5 面板 / 右侧

`Show Files` · `Show Terminal` · `Show Preview` · `Show Changes` · `Show Browser` · `Show Side Chat` · `Hide Side Chat` · `Close Pane` · `Side Chat` · `New Side Chat`

> 右侧不是「Background tasks」——**有 Background tasks 语义的是 `Sessions Waiting for You` / `Needs Your Input`**。
> 右侧能力是：**Files / Terminal / Preview / Changes / Browser / Side Chat**。

### 6.6 消息区

`Copy` · `Retry` · `Regenerate` · `Previous Chat` / `Next Chat` · `Previous Session` / `Next Session` · `Previous Task` / `Next Task`

---

## 7. 组件清单（57 个 `data-cds`）

```
Accordion AccordionHeader Aside AskUserQuestion AssistantMessage Banner
Button ButtonGroup Card CardLink ChartContainer ChatComposerActions
ChatComposerChin ChatComposerDock ChatComposerEditor ChatComposerNotices
ChatComposerQueuedMessages Checkbox Collapsible CommentCard DataTable
DiffIndicator FileDiff Heatmap Icon MessageActions MessageAttachments
MessageAttachmentsFile MessageAttachmentsImage MessageAttachmentsQuote
MessageAttachmentsVideo Meter ModelSelector ModelSelectorEffort
OverflowTooltip Page Panel PointChartContainer PreviewCard ProductLogo
Prose Pulse Skeleton SkeletonGroup SplitDropdownButton Surface Switch
Table Tabs TextArea TextInput TextLink Toolbar TurnStatus TurnStatusStep
UserMessage VideoPlayer
```

**输入框拆成 5 个部件**：`ChatComposerDock`（外壳）/ `ChatComposerEditor`（编辑区）/
`ChatComposerActions`（按钮区）/ `ChatComposerChin`（下巴）/ `ChatComposerNotices`（提示）/
`ChatComposerQueuedMessages`（排队消息）。

---

### 7.1 输入框的完整结构（10 个部件）

`ChatComposer` 拆得比 CSS 里看到的多。全仓扫 `"data-cds":"…"` 得到：

```
ChatComposer              ← 根
├── ChatComposerHeader     ← 顶部（附件/引用等）
├── ChatComposerTray       ← 托盘
├── ChatComposerEditor     ← 编辑区（ProseMirror，DOM 类 .epitaxy-prompt-input）
├── ChatComposerOverlay    ← 绝对定位覆盖层（placeholder / 高亮）
├── ChatComposerActions    ← 底部按钮区（发送 / 停止）
├── ChatComposerPrimaryAction ← 发送按钮本体
├── ChatComposerChin       ← 下巴（其下还有一层工具条）
├── ChatComposerNotices    ← 提示条
├── ChatComposerQueuedMessages ← 排队消息
├── ChatComposerDropScrim  ← 拖拽文件的遮罩
└── ChatComposerDropPanel  ← 拖拽落点面板
```

**样式**：
- 底色 `bg-surface-3`
- 圆角 `rounded-card` = `calc(--cds-radius + .25rem×scale)` ≈ **9.41px**
- 阴影 `shadow-composer`
- 编辑区字号下限 `--cds-font-size-text-entry-floor: 16px`（防 iOS 缩放）

**DOM 里另外两个标识**（CSS 里没有，只在 JS 里用）：
`.epitaxy-prompt`（外层）、`.epitaxy-prompt-input`（编辑区）。

---

### 7.2 CSS 里没有、只在 JS 里出现的组件

扫全仓 `"data-cds":"…"` 得到 60+ 个，其中这些**不在 CSS 的 57 个里**：

```
Spark · Counter · ContextMenu · RadioGroup · FilterCombobox · Slider
ChartLegend · FileUpload · BarChart · ScatterChart · StackedMeter
DropdownButton · LanguagePicker · Dots · TableRowActions · NavigationTabs
NumberInput · EmojiPicker · CodeView · DropZone · Kbd · WorkingMark
AnimatedPictogram · ScrollPager · PageHeader · CalendarRange · Calendar
DateInput · Reactions · CommentPin · CommentComposer · ClaudeLogo
```

**为什么 CSS 里没有**：这些组件的样式全部由 Tailwind 原子类拼成，
不需要额外的语义选择器。所以「CSS 里没有」不等于「不存在」。

---

## 8. 与 Mcode 现状的逐条差异

> 这一节是**结论**，不是计划。改不改、怎么改，等用户决定。
> Mcode 侧的值取自 `apps/desktop/src/renderer/styles.css`（2026-10-27 当前 HEAD）。

### 8.1 字号：Mcode 用的是「基础层」，Claude 真实默认是 comfortable 层

| 档 | Mcode 现值 | Claude 基础层 | Claude comfortable（真实默认） | 差 |
|---|---|---|---|---|
| caption | 10.35px | 10.353px ✅ | **11.294px** | 默认层小 8% |
| footnote | 11.29px | 11.294px ✅ | **12.235px** | 小 8% |
| code | 11.29px | 11.294px ✅ | **12.235px** | 小 8% |
| body | 12.24px | 12.235px ✅ | **13.176px** | 小 7% |
| prose | 14.00px | 14.000px ✅ | **16.000px** | 小 12.5% |
| heading | 13.18px | 13.176px ✅ | **14.118px** | 小 7% |
| title | 18.82px | 18.824px ✅ | **20.706px** | 小 9% |

**Mcode 的七个值逐条等于 Claude 的 `.cds-root` 基础层 —— 算对了。**
但 `<html data-density="comfortable">` 说明真实首屏用的是 comfortable 层。
所以**整屏字比真机小 7–12%**，这正是「看着不像」的一个来源。

### 8.2 ★ 正文行高：Mcode 用了 body 的 leading，Claude 用 chat-leading

| | Mcode | Claude | 差 |
|---|---|---|---|
| 字号 `--chat-body` | 12.24px | **13.1765px** | 小 7% |
| 行高（px） | 12.24 × 1.5378 = **18.82px** | 13.1765 × 1.4286 = **18.8239px** | **几乎相同** |
| 行高（比值） | 1.5378 | **1.4286** | 比值错，px 恰好对上 |

**这是巧合，不是对齐。** Mcode 用 `--cds-leading-body / --cds-font-size-body`
（1.25rem×scale ÷ .8125rem×scale = 1.5378），而 Claude 聊天区用的是
`--chat-leading: 1.4286`。两个比值差 7.6%，只因为字号也差 7% 才抵消掉。

**一旦把字号改成 comfortable（13.176），行高会跟着变成 20.26px —— 反而错了。**
正确做法是**分开定义**：行高跟 `--chat-leading`，字号跟 `--chat-body`。

### 8.3 消息间距：公式对了，数值也碰巧对上

| | Mcode | Claude | 差 |
|---|---|---|---|
| 轮次之间 `--chat-turn-gap` | 12.24 × 1.5378 × .75 = **14.12px** | 13.1765 × 1.4286 × .75 = **14.1179px** | ✅ 几乎相同 |
| 轮内 `--chat-item-gap` | 12.24 × 1.5378 × .50 = **9.41px** | 13.1765 × 1.4286 × .50 = **9.4120px** | ✅ 几乎相同 |
| `--chat-gutter` | 未见 | **32px** | 缺 |
| 消息区上下留白 | 未见 | **pt 48px / pb 32px** | 缺 |

**公式对了，数值也碰巧对上** —— 同样是「字号偏小 + 比值偏大」互相抵消。

### 8.4 助手消息左侧缩进：Mcode 是 0，Claude 是 4px

| | Mcode | Claude |
|---|---|---|
| `--cds-assistant-message-text-inset` | 无（默认 0） | **4px**（气泡变体才是 0） |
| `--cds-turn-status-hang` | 无 | 参与 calc，默认取 fallback `0px` |

上一版逆向把 inset 报成 0，是抓到了 `[data-variant=bubble]` 那个变体。
**默认助手消息有 4px 缩进。**

### 8.5 界面文案：核心动词不一样

| 位置 | Mcode | Claude | 判 |
|---|---|---|---|
| 新建 | `layout.newSession` → **New Session** | **`New Chat`** | ✗ 不同 |
| 输入框占位符 | 待查 | **`What can I help you with today?`** | 待核 |
| 模式切换 | Cowork / **Code** | **Cowork / Code / Design / Claude Code** | Mcode 少两个 |
| 搜索 | 底部图标 | **`Search…`** 输入框 | 形态不同 |

### 8.6 右侧面板：Claude 是 6 个能力，不是一个 tile

Claude 的右侧可以显示：`Files` / `Terminal` / `Preview` / `Changes` / `Browser` / `Side Chat`。

Mcode 把右侧做成了**单个 tile 容器**，并把「Background tasks」放了进去。
而 **Background tasks 语义在 Claude 里是 `Sessions Waiting for You` / `Needs Your Input`** ——
那是**会话列表里的一个分区**，不在右侧。

### 8.7 响应式：Claude 用命名容器查询，Mcode 用视口断点

Claude：`@container feed` / `run` / `titlebar` / `list` / `memory` / `library` / `docbar` / `agents` / `branch-row` / `browser`，断点 400–800px。

**这是结构性差异**：容器查询让「侧栏折叠」和「窗口变窄」解耦。
Mcode 用 `@media` 的话，缩窗口会同时改变所有区域。

### 8.8 已经对齐的部分（不要改）

| 项 | 状态 |
|---|---|
| 七档字号的 **基础层** 数值 | ✅ 逐条正确 |
| `--cds-radius` 5.65px / `--cds-radius-composer` 11.29px | ✅（若已用） |
| `--cds-pad-*` / `--cds-gap-*` 阶梯 | ✅（若已用） |
| 间距的**乘法公式**（不是写死 px） | ✅ 思路正确 |
| 助手消息没有身份头 | ✅ |

---

## 9. 颜色 / 阴影 / 层级 / 动画（亮暗并排）

完整表在 `tools/claude-ui-reverse/visual-tokens.txt`。这里只列骨架会用到的。

### 9.1 底色

| token | 亮 | 暗 |
|---|---|---|
| `--cds-surface-0` | `#f9f9f7` | `#0b0b0b` |
| `--cds-surface-1` | `#fcfcfb` | `#151515` |
| `--cds-surface-2` | `#fff` | `#1a1a19` |
| `--cds-surface-3` | `#fff` | `#20201f` |
| `--cds-surface-panel` | `#fff` | `#1a1a19` |
| `--cds-surface-popover` | `#fff` | `#20201f` |
| `--cds-page-bg` | `#f9f9f7` | `#0b0b0b` |

### 9.2 文字

| token | 亮 | 暗 |
|---|---|---|
| `--cds-text-primary` | `#0b0b0b` | `#f0efec` |
| `--cds-text-secondary` | `#52514e` | `#c3c2b7` |
| `--cds-text-muted` | `#898781` | `#898781`（**不变**） |
| `--cds-text-accent` | `#184f95` | `#6da7ec` |
| `--cds-text-danger` | `#8e2626` | `#ec7e7e` |
| `--cds-text-success` | `#006300` | `#0ca30c` |
| `--cds-text-warning` | `#734500` | `#db9300` |
| `--cds-text-disabled` | `hsl(0 0% 4% / 35%)` | `hsl(0 0% 100% / 35%)` |

### 9.3 填充 / 边框

| token | 亮 | 暗 |
|---|---|---|
| `--cds-fill-primary` | `#0b0b0b` | `#fff` |
| `--cds-fill-primary-hover` | `#2c2c2a` | `#e1e0d9` |
| `--cds-fill-accent` | `#2a78d6` | （继承亮色） |
| `--cds-fill-brand` | `#c6613f` | （继承亮色） |
| `--cds-fill-danger` | `#d03b3b` | （继承亮色） |
| `--cds-fill-success` | `#009300` | （继承亮色） |
| `--cds-fill-warning` | `#fab219` | （继承亮色） |
| `--cds-fill-ghost-hover` | `hsl(0 0% 4% / 5%)` | `hsl(0 0% 100% / 7.5%)` |
| `--cds-fill-ghost-selected` | `hsl(0 0% 4% / 10%)` | `hsl(0 0% 100% / 15%)` |
| `--cds-border` | `hsl(0 0% 4% / 10%)` | `hsl(0 0% 100% / 10%)` |
| `--cds-border-strong` | `hsl(0 0% 4% / 20%)` | `hsl(0 0% 100% / 20%)` |

### 9.4 阴影

| 名称 | 值 |
|---|---|
| `--cds-focus-shadow` | `inset 0 0 0 1px <表面色>, 0 0 0 1px #2a78d6, 0 0 6px 1px #cde2fb` |
| `--cds-panel-shadow` | `0 0 0 1px <边框>, 0 1px 2px 0 …, 0 2px 8px 0 …` |
| `--cds-shadow-sm` | `0 1px 2px 0 hsl(0 0% 4% / 5%)` |
| `--cds-shadow-md` | `0 2px 4px 0 …/7%, 0 6px 16px 0 …/8%` |
| `--cds-shadow-lg` | `0 4px 8px 0 …/8%, 0 12px 28px -2px …/8%` |
| `shadow-composer`（类） | `0 .25rem 1.25rem color-mix(#000 3.5%), inset 0 0 0 0 ring, 0 0 0 1px ring` |
| `shadow-field-ring`（类） | `inset 0 0 0 1px var(--cds-fill-field-ring)` |
| `shadow-card-ring`（类） | `inset 0 0 0 0 ring, 0 0 0 1px ring` |

### 9.5 z-index

| 值 | 用途 |
|---|---|
| `-1` | toolbar-ground / page-header-ground |
| `0` | dock-masked |
| `1` | scroll-fade-strip（上/下） |
| `20` / `z-header` | 标题栏、表头 |
| `30` / `z-sidebar` | **侧栏** |
| `50` | 浮层 |
| `999` | 最高 |

### 9.6 动画

| token | 值 |
|---|---|
| `--cds-dur-fast` | `60ms` |
| `--cds-dur-snap` | `120ms` |
| `--cds-dur-base` | `200ms` |
| `--cds-dur-sheet` | `300ms` |
| `--cds-dur-slow` | `450ms` |
| `--cds-ease-out` | `cubic-bezier(.165, .84, .44, 1)` |
| `--cds-ease-overshoot` | `cubic-bezier(.34, 1.3, .64, 1)` |
| `--cds-ease-snap` | `cubic-bezier(.32, .72, 0, 1)` |

### 9.7 字体

```
--font-anthropic-sans:  "anthropic-sans", <系统无衬线 + CJK 回退>
--font-anthropic-serif: "anthropic-serif", <Georgia/Times 回退>
--font-anthropic-mono:  "anthropic-mono", ui-monospace, monospace
--font-sans:            var(--cds-font-sans)
--font-mono:            var(--cds-font-mono)
```

字重：regular **400** / medium **500** / semibold **580** / bold **600**。
`--cds-font-grad-semibold: 180`、`--cds-font-grad-bold: 200`（可变字体的 GRAD 轴）。
还有 `--font-open-dyslexic` 与 `--font-atkinson-hyperlegible` 两套无障碍字体。

---

## 10. 骨架里**写死**的几何（不含运行时变量）

完整表在 `tools/claude-ui-reverse/hardcoded-geometry.txt`。以下是从 className 解出来的、**确定**的数字。

| 区域 | 关键值 |
|---|---|
| **侧栏宽度** | `w-[var(--session-rail-w,17.5rem)]` = **280px**（fallback 就是默认） |
| **标题栏高度** | `dframe-chrome-bar … h-[36px] z-20` = **36px** |
| 侧栏项内边距 | `px-2`(8) / `px-3`(12) / `ps-[var(--df-row-px)]` |
| 侧栏会话区圆角 | `rounded-[var(--df-radius-pill)]`（胶囊形） |
| 侧栏外层 | `gap-2.5`(10px) + `p-px`(1px) |
| 搜索框 | `h-control`(22.6px) + `rounded`(5.6px) + `px-sm`(5.6px) |
| 输入框底色 | `bg-surface-3` |
| 输入框圆角 | `rounded-card` = `calc(var(--cds-radius) + .25rem×scale)` = **9.41px** |
| 输入框阴影 | `shadow-composer` |
| 消息区 | `flex flex-col gap-[var(--chat-turn-gap)] pt-[48px] pb-[32px]` |
| 用户气泡 | `px-4 py-3 rounded-lg bg-neutral-30 w-fit max-w-lg`（16/12/8/512） |

---

## 11. 静态拿不到 —— **已实测确认，不是推测**

### 11.1 运行时几何：`--df-row-*` 系列

`--df-row-h` / `--df-row-gap` / `--df-row-px` / `--df-row-font` / `--df-row-ctl` /
`--df-leading-slot` / `--df-icon-size` / `--df-radius-pill` / `--df-footer-btn-size`：

- **CSS 里零定义**（搜遍 1.49 MB 的 `main.css`）
- **JS 里没有赋值** —— 唯一的出现是**读取并转发**：
  `shared-46` 里 `t.style.setProperty(e, r.getPropertyValue(e))`
- **渲染进程内存里 0 命中**（330 MB 转储，`--df-row-h` 出现 0 次）

结论：这些值由运行时按密度 / 字号档算出来后写在元素 style 上。**静态无从得知。**

### 11.2 图标 SVG path

图标是编译期组件（`y(Re,{name:"ArrowReturn",size:"sm"})`），名字→path 的表被 minify 改名。
`extract-icons.mjs` 试过，只捞到 32 个且**全是误报**（`yMd` 是日期格式串、`d`/`d2` 是变量名）。

**图标名字能拿到 276 个**（`icon-names.txt`），画的时候按名字找近似图形。

### 11.3 运行时调试通道：**两条都堵死**

| 方式 | 实测结果 |
|---|---|
| `--remote-debugging-port=9333` | Claude **自己拒绝启动**：<br>`refusing to start — a debugging or network-override switch is present on the command line.` |
| `--inspect=9334` | fuse `EnableNodeCliInspectArguments` **disabled**；且新 `--user-data-dir` 下缓存目录被占（`Unable to move the cache: 拒绝访问`） |

### 11.4 内存转储能做什么

`dump-renderer-memory.mjs` 跑通了（330 MB，346 MB 上限内），拿到的是**存在性证据**：

```
data-cds 命中 670 次（utf16le 617 / utf8 53）
MessageActions 74 · Prose 64 · MessageAttachmentsImage 49 · Card 38
AssistantMessage 38 · ChatComposerDock 23 · Icon 17 · Toolbar 14 · Page 13
TurnStatusStep 12 · SkeletonGroup 12 · UserMessage 11 · ChatComposerChin 3
聊天占位符 "What can I help you with today" 命中 1 次
```

**不能**拿到父子关系与计算尺寸 —— 那些在 C++ 的 layout 对象里，不是字符串。
类名碎片也只有 8 种（V8 里 className 多半已被 React 拆分复用，不以整串存在）。

**所以它只做佐证，不能替代 CDP。**

---

## 12. 数据与脚本在哪

```
tools/claude-ui-reverse/           ← 全部脚本 + 3.6556.2.0 快照
├── README.md                      用法 + 五个坑 + 拿不到的东西
├── extract-tokens.mjs             --cds-* → px（含 rem-scale）
├── extract-visual.mjs             颜色/阴影/z-index/动画/字体
├── extract-semantic-classes.mjs   shadow-composer 这类语义类
├── resolve-class.mjs              Tailwind 类名 → 计算 px（共用件）
├── extract-geometry.mjs           骨架里写死的 px
├── scan-all-classnames.mjs        全量 className 解算
├── extract-i18n.mjs               文案按值归类
├── icon-names.py                  276 个图标名
├── dump-renderer-memory.mjs       运行时 DOM 存在性佐证
└── *.txt / *.json                 上述脚本在 3.6556.2.0 上的输出快照
```

**快照有保质期**：Claude 版本一变，全部作废。用之前先核对版本号。
