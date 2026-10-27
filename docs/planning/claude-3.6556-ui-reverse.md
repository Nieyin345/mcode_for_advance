# Claude Desktop 3.6556.2.0 逆向结果

> 逆向时间：2026-10-27
> 目标：`C:\Program Files\WindowsApps\Claude_3.6556.2.0_x64__pzs8sxrjxfjjc`
> 方法：只读静态分析（CSS token 提取 + JS 字面量扫描 + i18n 文案）+ REA 语义图
> **未执行目标程序**，未挂 CDP。

---

## 0. 先记三个「上一版逆向踩过的坑」

这些坑让上一版的结论**整批作废**，记下来免得再犯。

| # | 坑 | 表现 |
|---|---|---|
| 1 | **版本号变了** | 上一版按 `3.1623.4.0` 逆向；现在装的是 **`3.6556.2.0`**。CSS 主文件 hash 从 `Bt_TAkxU` 变成 `Che1orl5`，体积 1446KB → 1493KB。 |
| 2 | **主题变量不在 `:root` / `.dark`** | 在 **`.cds-root`** 上；暗色走 `[data-mode=dark]` 与 `@media (prefers-color-scheme:dark)`。按 `.dark` 找会得到 0 个变量。 |
| 3 | **选择器用 `includes` 判会串层** | `.cds-root [data-step="3"]` 也含 `.cds-root`。必须**完全相等**才算 base，否则「文本大小档 3」会覆盖真 base。 |

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

## 9. 与 Mcode 现状的逐条差异

> 这一节是**结论**，不是计划。改不改、怎么改，等用户决定。
> Mcode 侧的值取自 `apps/desktop/src/renderer/styles.css`（2026-10-27 当前 HEAD）。

### 9.1 字号：Mcode 用的是「基础层」，Claude 真实默认是 comfortable 层

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

### 9.2 ★ 正文行高：Mcode 用了 body 的 leading，Claude 用 chat-leading

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

### 9.3 消息间距：公式对了，数值也碰巧对上

| | Mcode | Claude | 差 |
|---|---|---|---|
| 轮次之间 `--chat-turn-gap` | 12.24 × 1.5378 × .75 = **14.12px** | 13.1765 × 1.4286 × .75 = **14.1179px** | ✅ 几乎相同 |
| 轮内 `--chat-item-gap` | 12.24 × 1.5378 × .50 = **9.41px** | 13.1765 × 1.4286 × .50 = **9.4120px** | ✅ 几乎相同 |
| `--chat-gutter` | 未见 | **32px** | 缺 |
| 消息区上下留白 | 未见 | **pt 48px / pb 32px** | 缺 |

**公式对了，数值也碰巧对上** —— 同样是「字号偏小 + 比值偏大」互相抵消。

### 9.4 助手消息左侧缩进：Mcode 是 0，Claude 是 4px

| | Mcode | Claude |
|---|---|---|
| `--cds-assistant-message-text-inset` | 无（默认 0） | **4px**（气泡变体才是 0） |
| `--cds-turn-status-hang` | 无 | 参与 calc，默认取 fallback `0px` |

上一版逆向把 inset 报成 0，是抓到了 `[data-variant=bubble]` 那个变体。
**默认助手消息有 4px 缩进。**

### 9.5 界面文案：核心动词不一样

| 位置 | Mcode | Claude | 判 |
|---|---|---|---|
| 新建 | `layout.newSession` → **New Session** | **`New Chat`** | ✗ 不同 |
| 输入框占位符 | 待查 | **`What can I help you with today?`** | 待核 |
| 模式切换 | Cowork / **Code** | **Cowork / Code / Design / Claude Code** | Mcode 少两个 |
| 搜索 | 底部图标 | **`Search…`** 输入框 | 形态不同 |

### 9.6 右侧面板：Claude 是 6 个能力，不是一个 tile

Claude 的右侧可以显示：`Files` / `Terminal` / `Preview` / `Changes` / `Browser` / `Side Chat`。

Mcode 把右侧做成了**单个 tile 容器**，并把「Background tasks」放了进去。
而 **Background tasks 语义在 Claude 里是 `Sessions Waiting for You` / `Needs Your Input`** ——
那是**会话列表里的一个分区**，不在右侧。

### 9.7 响应式：Claude 用命名容器查询，Mcode 用视口断点

Claude：`@container feed` / `run` / `titlebar` / `list` / `memory` / `library` / `docbar` / `agents` / `branch-row` / `browser`，断点 400–800px。

**这是结构性差异**：容器查询让「侧栏折叠」和「窗口变窄」解耦。
Mcode 用 `@media` 的话，缩窗口会同时改变所有区域。

### 9.8 已经对齐的部分（不要改）

| 项 | 状态 |
|---|---|
| 七档字号的 **基础层** 数值 | ✅ 逐条正确 |
| `--cds-radius` 5.65px / `--cds-radius-composer` 11.29px | ✅（若已用） |
| `--cds-pad-*` / `--cds-gap-*` 阶梯 | ✅（若已用） |
| 间距的**乘法公式**（不是写死 px） | ✅ 思路正确 |
| 助手消息没有身份头 | ✅ |

---

## 10. 静态分析拿不到的东西（要运行时才有）

REA 的语义图对 minified bundle 帮助有限：`modules: 0`，549,350 个 AST 节点全在匿名工厂里。
**以下事实必须跑起来才能拿**：

1. **侧栏真实宽度** —— CSS 里没有 `288px`（那是 `MessageAttachments` 的图片宽度上限，
   上一版把它误当侧栏宽度）。真实宽度是运行时算的。
2. **标题栏高度与拖拽区**
3. **输入框完整几何**（实际宽高、按钮排布）
4. **右面板宽度与默认状态**
5. **各区块的实际间距**（gap 之外还有 padding / outline）
6. **图标**（全是 SVG path，静态读不出视觉）

**两条可行路径**：
- `--remote-debugging-port=9222` 启动一个独立 profile 的 Claude，CDP 只读量取
- 主进程打补丁让 `app.commandLine.appendSwitch("remote-debugging-port")` 生效

> `inspect_electron_fuses` 结果：`EnableNodeCliInspectArguments` **disabled**、
> `RunAsNode` **disabled**、`EnableEmbeddedAsarIntegrityValidation` **enabled**、
> `OnlyLoadAppFromAsar` **enabled**。所以 `--inspect` 走不通，`remote-debugging-port` 仍可能。

---

## 9. 原始数据在哪

```
.tmp/rev/main.css          主 CSS（1.49 MB）
.tmp/rev/shared-styles.css
.tmp/rev/en-US.json        语言包
.tmp/rev/tokens.json       全部 1009 个 base + 265 个 dark token
.tmp/rev/tokens-out.txt    七档 × 每层的人读表
.tmp/rev/layout-out.txt    按 data-cds 归类的布局规则
.tmp/rev/classnames.txt    JS 里的组件 className
.tmp/rev/i18n-ui.txt       UI 文案（按值归类）
.tmp/rev/i18n-all.json     全部键值
```

**脚本**（都可重跑）：

```
.tmp/rev/extract-tokens.mjs    CSS token → px（含 rem-scale 解析）
.tmp/rev/extract-layout.mjs    按组件抽布局规则
.tmp/rev/extract-i18n.mjs      文案按值归类
.tmp/rev/scan-js-layout.mjs    JS chunk 布局常量
.tmp/rev/scan-classnames.mjs   JS 组件 className
```
