# Claude Code 桌面端 · UI 细节逆向报告

> **来源**：Claude Code 桌面端 `Claude 2.31226.1.0`（Electron 44.4.3，Windows MSIX 安装包）。
> 包 `app.asar` SHA-256 `efa9e2310cf943b333b153c093babb8b5a92f80a23cb68764dba9b29a0801d4a`，
> 44,590,401 字节。抽取树在 `%TEMP%\rea-extracted-338538fd-…\`。
>
> **方法**：REA 的静态分析（`analyze_javascript_application`，证据
> `ev_92ab1a5263d4afaaf2134b730a66710a95d71aeff301966cc84943b81c5c0240`）
> + 逐文件读产物。**没有运行过那个 app**，也没有截图——下面每一条都是**读到的**
> CSS/HTML 事实，不是我看它长什么样猜的。
>
> **读的文件（SHA-256 前 16 位 / 字节数）**
>
> | 文件 | SHA-256(16) | 字节 |
> |---|---|---|
> | `main_window/assets/MainWindowPage-yE7nSc5c.css` | `1e0a316b76c39621` | 216,822 |
> | `main_window/index.html` | `4a1694880ecc4862` | 9,198 |
> | `about_window/window-shared.css` | `d0c1b7d689506c04` | 8,327 |
> | `about_window/window-legacy-pins.css` | `7948836002a0067f` | 6,444 |
> | `local_exec_consent/localExecConsent.html` | `34fe4865f2ae1bd0` | 7,081 |
> | `quick_window/quick-window.html` | `445f1d447c606bad` | 217,981 |
> | `quick_window/assets/main-CiwjW8Wn.css` | `7b23cc44e4e805e2` | 2,226 |
> | `buddy_window/assets/main-a4mzyXdA.css` | `19f295cb0c29dd22` | 4,185 |

---

## 零、先划清楚边界（不然下面的建议会跑偏）

| 分类 | 内容 |
|---|---|
| **① 可以直接搬的界面细节** | 设计 token 架构、状态属性词表、动效语义、无障碍约定、外壳窗口布局。**机械的、与产品无关的**。 |
| **② 值得学但形态不同** | 「启动骨架屏」「首帧主题」「小窗独立 HTML」。mcode 是本地优先、单窗口三栏，形态要对齐但实现路径不同。 |
| **③ 明确不该学** | 主窗口正文从 `claude.ai` 远程加载；正文 CSS 是**构建期**类名扫描产物。mcode 离线自足（CSP `default-src 'self'`），这条复制不了也不必复制。 |

**证据等级**（E1 = 真机跑过；E2 = 源码静态读出；E3 = 尚未实施）：本报告几乎全是 **E2**（源码调用链/静态读出的判据）。**没有 E1**——没跑过对方 app，没做过变异验证。凡我写「实测」都是在 mcode 侧的静态计数，不是运行结果。

---

## 一、最值得看的一件事：三层 token + 一个「作用域标记」

### 1.1 三层，各自管一件事

```
第一层  原始色阶      --cds-gray-10: #fcfcfb        （35 档 × 11 个色系 = 385 个）
第二层  角色           --cds-role-accent-450: var(--cds-blue-450)
第三层  语义           --cds-fill-accent: var(--cds-role-accent-fill)
                      --cds-bg-accent:   var(--cds-role-accent-100)
                      --cds-text-accent: var(--cds-role-accent-600)
```

色阶**不是 11 个色相各 11 档**，而是每个色相 **35 档**：`0/10/20/…/100`（浅端每 10 一档）、
`150/200/250/…/800`（中间每 50 一档）、`810/820/…/890`（深端每 10 一档）、`900`。
这样浅端和深端**在各自密集处**都有足够分辨率，中间少浪费。灰阶（`--cds-gray-*`）是整个
暗色主题的骨干——**暗色不是另配一套色，是把 `--cds-surface-0..3` 重新指到灰阶的另一端**：

```css
/* 亮 */
--cds-surface-0: var(--cds-gray-20);   /* #f9f9f7  最外层底 */
--cds-surface-1: var(--cds-gray-10);   /* #fcfcfb  卡片 */
--cds-surface-2: var(--cds-gray-0);    /* #fff     最内层/纸面 */
```

**注意方向**：亮色下 `surface-0` 最深（灰 20）、`surface-2` 最白——层级是**由外向内越来越亮**。
暗色下同一组名字指向灰阶的深端，于是层级反过来由内向外越来越暗而**变量名一个都不用改**。

### 1.2 作用域标记：`class="cds-root" data-mode="system"`

这是整套东西能被**一个开关**翻转的关键。每个外壳文档的 `<html>` 上挂三个属性：

```html
<html class="cds-root" data-mode="system" data-density="comfortable" data-platform="desktop">
```

- `cds-root` → 所有 token、所有组件基样式都在 `.cds-root` / `:where(.cds-root)` 之下，**永不漏到宿主页**。
- `data-mode="light|dark|system"` → 明暗。
- `data-density` / `data-platform` → 尺寸与平台约定（桌面**按钮是箭头光标、链接才是手型**，与网页相反，见 §3.5）。

**明暗三条规则并列**，而不是只写一条 `.dark`：

```css
:where([data-mode=dark] .cds-root:not([data-mode=light]):not([data-mode=system]),
       .cds-root[data-mode=dark],
       .cds-dark-scope[data-mode=dark]) { …暗色覆写… }

:where([data-mode=system] .cds-root:not([data-mode=light]):not([data-mode=dark]),
       .cds-root[data-mode=system],
       .cds-root:not([data-mode]):not([data-mode] *)) { …同一份暗色覆写… }
```

第二条那个 `:not([data-mode] *)` 是**防嵌套**：一个亮色 `cds-root` 嵌在暗色祖先里时，
`[data-mode=dark] .cds-root` 会错误命中它——加这条把它排除掉。
**副作用是「可嵌套的局部明暗」**：`<div class="cds-dark-scope" data-mode="dark">` 可以在
亮色应用里画一块暗色区域（那 42 处 `.cds-dark-scope` 就是这个用途）。

### 1.3 尺寸/字号：档位覆盖，不写两份规则

```css
.cds-root [data-size=lg] {
  --cds-radius: var(--cds-radius--lg);
  --cds-h-control: var(--cds-h-control--lg);
  --cds-icon: var(--cds-icon--lg);
  --cds-pad-xs: var(--cds-pad-xs--lg);  /* …pad-sm/md/lg/xl 同样 */
  --cds-font-size-caption: var(--cds-font-size-caption--lg);
  --cds-font-size-body: var(--cds-font-size-body--lg);
  --cds-leading-body: var(--cds-leading-body--lg);
  --cds-checkbox: var(--cds-checkbox--lg);
  --cds-switch-h: var(--cds-switch-h--lg);
}
```

**一条规则翻转整套尺寸**。所有组件都只读 `--cds-h-control` / `--cds-pad-md` / `--cds-icon`，
没有一个组件自己写 `height: 32px`。档位值只有 `xs | sm | lg`（默认档 = 不写属性）。

字号另有一层 **`data-text-size`（阅读密度）**，只挂在消息体上：

```css
.cds-root :where([data-cds=AssistantMessage],[data-cds=UserMessage])[data-text-size=sm] { …--textsm… }
                                                                          [data-text-size=md] { …}
                                                                          [data-text-size=lg] { …}
```

**关键**：它**同时**覆盖 `font-size` **和** `leading`（行高）。只改字号不改行高，正文会
挤在一起——这是很多「字号设置」功能做残的地方。

### 1.4 全局缩放：乘一个系数，不碰根字号

```css
--cds-radius:    calc(.3125rem * var(--cds-rem-scale, 1));
--cds-font-size-body: calc(.8125rem * var(--cds-rem-scale, 1));
--cds-gap-md:    calc(.5rem * var(--cds-rem-scale, 1));
```

**每一处长度都乘 `--cds-rem-scale`，而 `--cds-rem-scale` 全文没有一处声明**——它只在
运行时被 `style.setProperty` 写。为什么不用「改 `html { font-size }`」那套：那会连带缩放
宿主页里所有 `rem`（包括用户自己的内容、代码块、嵌入的网页），而乘系数**只缩放 UI 自身**。

---

## 二、动效：四档时长、三条曲线、一个总闸

```css
--cds-dur-fast: 60ms;    /* 按下、微反馈 */
--cds-dur-snap: .12s;    /* 揭示、状态切换 */
--cds-dur-base: .2s;     /* 默认 */
--cds-dur-sheet: .3s;    /* 面板滑入 */
--cds-dur-slow: .45s;    /* 回弹归位 */

--cds-ease-out:       cubic-bezier(0, 0, .2, 1);
--cds-ease-snap:      cubic-bezier(.32, .72, 0, 1);      /* 快起慢收，手感脆 */
--cds-ease-overshoot: cubic-bezier(.34, 1.3, .64, 1);    /* 过冲，活泼 */
```

**最有意思的是弹性的写法**——不是 cubic-bezier，是 **`linear()` 采样**：

```css
--cds-btn-spring: linear(0, .2459, .6526, .9468, 1.0764, 1.0915, 1.0585, 1.0219,
                         .9993, .9914, .9921, .9957, .9988, 1.0004, 1);
```

16 个采样点描出「冲过 1.09、回落到 0.99、收敛到 1」的**真弹簧**。`cubic-bezier` 最多一个
过冲拐点，做不出这种二次回弹。用在按钮按下的**释放**上：

```css
.cds-root .cds-btn-squish {
  transform-origin: 50%;
  transition: transform var(--cds-dur-slow) var(--cds-btn-spring);   /* 松手：慢速回弹 */
}
.cds-root .group\/btn:not([disabled]):active .cds-btn-squish {
  transition: transform var(--cds-dur-fast) ease-out;                /* 按下：60ms 立刻 */
  transform: scale(.975);
}
```

**按下快、松开慢**——这一个不对称就是「有重量感」和「塑料感」的分界。

### 2.1 总闸：`data-reduce-motion="true"` 在祖先上，而不是媒体查询

```css
.cds-root:where([data-reduce-motion=true],[data-reduce-motion=true] *) .cds-btn-squish { animation: none; }
.cds-root:where([data-reduce-motion=true],[data-reduce-motion=true] *) .cds-flipbook    { animation: none; }
/* …70 处，覆盖每一条动画… */
```

**为什么不用 `@media (prefers-reduced-motion: reduce)`**：媒体查询只能表达「跟随系统」，
做不出「应用内单独开关」——用户想留动画而系统关着，或反过来。把闸做成**属性**之后，
一个 `setAttribute` 就能切，且能**局部**（某个子树关掉）。全文 `prefers-reduced-motion`
只出现 13 次（主要在 Tailwind 的 `motion-reduce:` 工具类里），`data-reduce-motion` 70 次。

---

## 三、值得逐条搬的界面细节

### 3.1 骨架屏是「最后一次布局的轮廓」，不是灰条

`main_window/index.html` 里这段是**给用户看的第一个东西**：

```js
var paintShapes = function (shapes, scale) {
  for (var i = 0; shapes && i < shapes.length; i++) {
    var s = shapes[i];
    var el = document.createElement("div");
    el.style.top = s.top * scale + "px";
    el.style.left = s.left * scale + "px";
    el.style.width = s.width * scale + "px";
    el.style.height = s.height * scale + "px";
    el.style.borderRadius = s.radius * scale + "px";
    host.appendChild(el);
  }
};
```

`shapes` 是一串 `{top,left,width,height,radius}` —— **侧栏上一次的条目轮廓**，
按 `scale` 等比缩放后画成半透明方块：

```css
--boot-placeholder-sidebar: color-mix(in srgb, #f9f9f7 50%, #fcfcfb);
--boot-placeholder-row:     rgba(11, 11, 11, 0.05);
--boot-placeholder-seam:    rgba(11, 11, 11, 0.1);
```

`color-mix` 让骨架侧栏底色**由当前背景算出**（而不是写死一个灰），换主题自动跟。
宽度来自 `frame.sidebarWidth * scale`；窗口太窄（`width/scale <= narrowViewportMaxWidth`）
或上次是收起状态时**不画**，改为挂 `data-boot-placeholder-frame="collapsed"`。
同一段还带一条拖拽条：

```css
#boot-placeholder-drag-strip { height: calc(48px * var(--boot-placeholder-scale,1)); -webkit-app-region: drag; }
```

**骨架期窗口就能拖动**，不会出现「点标题栏没反应」的假死感。

### 3.2 修一个真实的首帧闪烁（这段注释本身就是教益）

```css
/* Resolve the page colors from the OS/nativeTheme scheme in CSS so the shell's
 * very first paint is already the right color. windowBaseCore.ts only adds
 * .darkTheme once its module graph has loaded, and the body paints before that:
 * without this block a dark-mode window flashed light (#fcfcfb) for a few frames
 * on launch, masked where the window is revealed only after load and exposed
 * where it is shown on construction. Same values as .darkTheme below. */
@media (prefers-color-scheme: dark) {
  :root { --claude-background-color: #151515; --claude-foreground-color: white; }
}
```

**根因**：「JS 加载完才加 `.dark`」与「body 已经画了」之间有窗口期。
**修法**：把同样的值**再写一份**在 `@media (prefers-color-scheme: dark)` 里，
让 CSS 自己解析，不等 JS。mcode 现在用的是 [`lib/theme.ts`](../../apps/desktop/src/renderer/lib/theme.ts)
里的 `initFoucGuard()`（由 `main.tsx` 在 React 挂载前同步调用；`index.html` 里只有一段
指向它的注释）+ 随后 `useTheme()` 修正——
**同样是两段式，同样有一段窗口期**。
（2026-10-18 核对：原链接 `../apps/...` 从 `docs/design/` 少一层 `../`，且 `initFoucGuard()`
不在 `index.html`，实际在 `lib/theme.ts`。）这份可以对照着看，但 mcode 是**单窗口本地应用**，
首帧本来就短，我倾向**不动**它，除非真观察到闪。**这条列为「知道有这回事」，不是待办。**

### 3.3 主窗口用 `.dark` 类名（老派）+ CDS 用 `data-mode`（新派）并存

同一份 `window-shared.css` 里两套都在：主题旧的 `.darkTheme` 类，
新的是 `html.cds-root[data-mode]`。**这不是混乱，是迁移中的兼容层**，而且有明确的拆除模型：

```css
/* Removal model: when a surface is rebuilt on CDS components, its document
 * simply stops importing this file (and any pin whose last consumer that
 * removes gets deleted here). A rebuilt document then takes every CDS
 * default … deliberately and all at once. */
html.cds-root[data-mode] { color-scheme: normal; font-variation-settings: normal; }

@layer utilities {
  .rounded { border-radius: 0.25rem; }      /* 旧值 4px；CDS 默认 8px */
  .font-bold { --tw-font-weight: 700; font-weight: 700; }   /* 旧值 700；CDS 默认 600 */
  .space-y-2 > :not([hidden]) ~ :not([hidden]) { margin-top: 0.5rem; }  /* Tailwind v3 语义 */
  .space-y-2 > :not(:last-child) { margin-bottom: 0; }
}
```

**`window-legacy-pins.css` 这个文件本身就是一条方法论**：换设计系统时，把「旧值」
集中成一个**可删的文件**，谁迁完谁不 import 它；而不是在每个组件里加 `!important` 打补丁。
`@layer` 顺序也依赖构建：`window-shared.css` 第一行是 `@layer cds-card;`，
`cds-card` 必须在 `theme`/`base`/`components`/`utilities` **之前**声明，否则整层被丢掉。

**这条直接对应台账的「系统性修复不打补丁」（README 3.5.2）**——同一个思路。

### 3.4 `@property` 注册：让本来不可动画的变量可动画

90 个 `@property`。挑一个最能说明问题的：

```css
@property --cds-scroll-fade-top { syntax: "<length>"; inherits: false; initial-value: 0; }

@keyframes cds-scroll-fade-top {
  0%  { --cds-scroll-fade-top-raw: 0px }
  to  { --cds-scroll-fade-top-raw: var(--cds-scroll-fade-size) }
}
```

未注册的自定义属性是「字符串」，**不能逐帧插值**；`@property` 给它类型之后就能。
配套的 `--cds-scroll-fade-y-active` / `-x-active`（`syntax:"<number>"`）是「有没有可滚」
的布尔，用 `@keyframes { 0%,to { …:1 } }` 表达——**用 keyframes 当开关**，
只在被应用时才置 1。

同类的还有 `--cds-sticky-edge-start/-end/-active`（粘性表头边缘阴影）、
`--cds-message-actions-opacity`（消息动作栏显隐）。**共同点：这些值都被两个状态共享、
需要平滑过渡，而不是切换时瞬跳。**

### 3.5 桌面光标约定（与网页相反，很容易搞错）

```css
:where(.cds-root) :where(button,[role=button],[role=tab],[role=menuitem],…,[role=radio]) {
  cursor: var(--cds-cursor-interactive);   /* data-platform=desktop 时解析为 "default" */
}
```

注释写得很直白：**CDS 桌面约定是「按钮上是箭头，链接上才是手型」**。
而 Tailwind v4 的 preflight **不再**给 `button` 设 `cursor:pointer`（v3 设了），
所以旧文档要靠 pins 文件把它加回来：

```css
@layer base {
  button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer; }
}
```

**mcode 目前用的是 Tailwind v3（`tailwindcss@3.4.19`）**，preflight 自带给按钮加
`cursor:pointer`，所以现在没问题；但**将来升 v4 时，所有按钮的光标会一起变箭头**——
这是一次性的大面积变化，提前知道比到时候满地找强。

### 3.6 焦点环：1px 内描边 + 外环 + 6px 光晕，且**永远不为零尺寸**

```css
--cds-focus-shadow: inset 0 0 0 1px var(--cds-page-bg), 0 0 0 1px var(--cds-fill-accent), 0 0 6px 1px var(--cds-bg-accent);
--cds-focus-shadow-danger: inset 0 0 0 1px var(--cds-page-bg), 0 0 0 1px var(--cds-fill-danger), 0 0 6px 1px var(--cds-bg-danger);
```

三层：**内 1px 背景色**（把元素和紧邻的背景隔开）+ **1px 强调色环** + **6px 光晕**。
内层那 1px 是让焦点环在**任何背景**上都读得出来的关键——元素贴在有色卡上时，
少了它环会糊进卡片色里。危险操作（删除等）用同一套但换成 danger 色，
**形状语义一致、只换颜色**，用户不用重新学。

配合一条反直觉但正确的写法：

```css
outline: 2px solid #0000;   /* 透明 */
outline-offset: 2px;
box-shadow: var(--cds-focus-shadow);
```

用**透明的 outline** 占住位置（Windows 高对比度模式下 UA 会把 `#0000` 换成系统色），
真正可见的是 `box-shadow`。**不能省掉那句 outline**，否则强制高对比模式里没有焦点指示。

### 3.7 禁用态：`aria-disabled` 不等于 `disabled`

```css
.cds-root .group\/btn:not([disabled]):active .cds-btn-squish { …按下缩放… }
.cds-root .group\/btn:not([disabled]):has(:active) .cds-btn-squish { … }
```

按下反馈**显式排除 `[disabled]`**——禁用的按钮按下去不该有回弹。
`data-*` 状态词表里有 `[data-disabled]`（7 处）和 `aria-disabled` 两种写法并存，
说明它把「原生 disabled」（不可聚焦）与「视觉/语义 disabled」（仍可聚焦、可被读屏播报）
**分开处理**。这是个容易被忽略的正确做法。

### 3.8 高对比度：`forced-colors` 6 处，不是 0 处

```css
@media (forced-colors:active) { … }
@media (not (forced-colors:active)) { … }
```

现代 CSS 里最容易漏的适配。~~**mcode 的 `styles.css` 里一处都没有**~~（下面 §5 有清单）。
**2026-10-18 核对**：现已有 1 个 `@media (forced-colors: active)` 适配块
（`styles.css:2571`，覆盖焦点环、状态形状与用户气泡边界）。

---

## 四、系统观：这些窗口是一个体系，不是六个独立页

| 窗口 | 做法 | 可搬性 |
|---|---|---|
| `main_window` | 只有**标题栏 + 骨架 + 错误覆盖层**；正文从 `claude.ai` 拉 | 形态可学，实现不可复制 |
| `about_window` | 走 CDS + Tailwind v4 完整管线 | **可学**：五套小窗共用 `window-shared.css` |
| `quick_window` | 独立 217KB HTML，**内联**同一份星芒 logo path | **可学**：见下 |
| `find_in_page` | 独立 HTML，`body` **空的**，全由 JS 建 | 中性 |
| `buddy_window` | 独立一套 cream/clay 手作色板 | 场景特定 |
| `local_exec_consent` | **故意零依赖**（不引 React/Tailwind），内容走 query，只用 `textContent` 渲染 | **强烈建议学** |

### 4.1 `quick_window` 的 logo：把共享性写成一句注释

```html
<!-- Inlined Claude starburst logo. This is the same path used by the React
     AppLogo in src/renderer/components/Icons.tsx — keep them in sync.
     Replaced the lit-based <app-logo> custom element so this page doesn't
     need to ship a second component framework alongside React. -->
```

**为了不给一个 18px 图标再拉一个组件框架，宁可把 SVG 路径内联，并注明同步源。**
取舍很清楚：**「少一个运行时」比「少一份重复」重要**。
mcode 有 [`brand-logo.png`](../../apps/desktop/src/renderer/brand-logo.png) 与
[`lib/icons.tsx`](../../apps/desktop/src/renderer/lib/icons.tsx)（Tabler 图标封装，`components/` 下没有
`Icons.tsx` —— 2026-10-18 核对），同类取舍可以参考这句。

### 4.2 `local_exec_consent`：安全界面不跑任何可被影响的栈

```html
<!-- Main-owned confirm for direct-MCP Connect / Disconnect, the standing Chat
     grant, and 3P's bootstrap-settings prompt, packaged like the app's other
     windows. Deliberately dependency-free (no windowBase / React): the consent
     surface must not run any stack the web-origin renderer could influence.
     Content arrives via query; the page renders it with textContent only. -->
```

**这是全篇最该学的一条。** 一个「是否允许本地执行」的确认框，**不用 React、不用 Tailwind、
不 import 任何共享模块**——因为那些栈可能被 web 来源渲染进程影响，而这块界面的职责
恰恰是**让用户做出可信的授权决定**。内容通过 query 传进来，用 `textContent`（不是
`innerHTML`）渲染。

它的 CSS 同样自足，颜色是**解析后的字面值**而不是引 token：

```css
:root { --bg:#f9f9f7; --fg:#0b0b0b; --dim:#52514e; --border:rgba(11,11,11,.1);
        --warn:rgba(217,119,6,.08); --warn-border:rgba(217,119,6,.25); }
@media (prefers-color-scheme: dark) { :root { --bg:#0b0b0b; --fg:#fff; … } }
```

两个细节写得很讲究：

```css
/* The author display:flex above would otherwise beat the UA [hidden] rule,
   showing the disconnect banner on Connect. */
.warn[hidden] { display: none; }

/* Input protection: held disabled until the page arms them after main's
   LOCAL_EXEC_CONSENT_INPUT_PROTECTION_MS. */
.btn:disabled { opacity: .5; cursor: default; }
```

- 前者：**作者写的 `display:flex` 会盖掉 UA 的 `[hidden]`** ——凡给元素写
  `display` 的地方都要补一条 `[hidden] { display:none }`。
- 后者：**两个按钮初始 disabled，主进程过一段时间才由页面解锁** ——
  防「弹窗一出现用户就条件反射按回车」。这个模式 mcode 的
  [`confirm-dialog.tsx`](../../apps/desktop/src/renderer/components/ui/confirm-dialog.tsx)
  和审批卡片都值得对照。
  （2026-10-18 核对：原链接少一层 `../`；链接已修正。）

### 4.3 五套小窗共用一个 `window-shared.css`，主窗口不 import 它

代价与好处都写在注释里了。主窗口**刻意不引**那份，因为它只要自己那一小段首帧规则：

```html
<!-- First-frame rules only. … Tailwind/CDS and the fonts arrive with the lazy
     MainWindowPage chunk: the shell draws no text and no styled element at
     rest. -->
```

**首帧只加载「画底」需要的那几行，其余懒加载**——这是 9KB 的 shell HTML 敢放
216KB 正文 CSS 的前提。

---

## 五、对到 mcode 上：现状与缺口

### 5.1 现状（静态计数，非运行实测）

> **2026-10-18 核对**：下表「mcode」列已按当前源码更新（ARC-005 V0 迁移后的值）；
> 上游「Claude 桌面端」列的计数保持本次逆向时的读数不变。

| 机制 | mcode | Claude 桌面端 |
|---|---|---|
| 设计 token 层数 | **3 层**（`tokens.cds.css` 原始色阶 → `styles.css` 语义层 → Tailwind 别名；`"R G B"` 三元组） | **3 层**（385 色阶 → 角色 → 语义） |
| 主题切换 | `.dark` 类名（`darkMode:"class"`） | `data-mode="light\|dark\|system"` + 可嵌套 `cds-dark-scope` |
| 尺寸档位 | 部分（`--chat-font-size`/`--right-panel-font-size` 可调 + `--chat-fs-*` 派生；无 `data-size` 档位） | `data-size` + `data-text-size` + `--cds-rem-scale` |
| 动效 token | 5 档时长 + 10 条曲线 + `--spring-btn`（`styles.css:852-873`） | 5 档时长 + 3 条曲线 + `linear()` 弹簧 |
| 减弱动效 | `html[data-reduce-motion]` 属性总闸已接（`styles.css:929-957`）；`prefers-reduced-motion` 9 个媒体块（`styles.css`）+ 2 个 TSX 的 `matchMedia` 调用 | 属性总闸 70 处 |
| `@property` | **0 处** | 90 处 |
| `view-transition` | **0 处** | 21 处 |
| `mask-image` | 1 处（`ActivityCluster.tsx:181-182` 的 radial-gradient 环） | 有 |
| `:has()` | 1 个文件（`styles.css` 4 条） | 48 条规则 |
| `color-mix()` | 1 个文件（`styles.css` 2 处） | 112 处 |
| `forced-colors` 高对比 | 1 个 `@media (forced-colors: active)` 块（`styles.css:2571`） | 6 处 |
| 焦点环 | 统一 `--focus-ring` 三层 token（`styles.css:902-927`，含 danger 变体） | 统一 `--cds-focus-shadow`（含 danger 变体） |
| 骨架屏 | `components/ui/spinner.tsx` 有 `Skeleton`；**有约定但无「按上次布局画轮廓」** | 轮廓式骨架 + 可拖动骨架条 |
| 窗口数 | 2 个 HTML 入口（`index.html` 主窗 + `pair.html` 手机配对页） | 6 个，各带独立 shell |
| 首帧防闪 | `initFoucGuard()`（`lib/theme.ts`，`main.tsx` 同步调用）+ `useTheme()` 两段式 | CSS `@media` 一次解析 + JS 只做后续 |

### 5.2 缺口清单（按「值不值得做」排序）

> **2026-10-18 核对（状态回填）**：A 档 1（`data-reduce-motion` 总闸）、2（统一焦点环）、
> 3（动效时长/曲线 token）已落地（`styles.css:838-957`）；A 档 5 的审批卡输入保护、
> B 档各项、C 档各项仍未做。清单文字保留原文作为当时的判断记录。

**A 档 · 成本低、各面板都受益，建议先做**

1. **`data-reduce-motion` 总闸**：把「减弱动效」从媒体查询升级成一个可点的设置项 +
   挂在 `<html>` 上的属性。mcode 现在 0 处，意味着**系统关了动画、mcode 里照样动**——
   这既是无障碍问题，也正好是「AI 能自配置」里一个现成的开关。
2. **统一焦点环（含 danger 变体）**：把 `--cds-focus-shadow` 那三层的写法落成两个
   token，替掉各处散装的 `focus-visible:ring-*`。
3. **动效时长/曲线 token**：`--dur-fast/snap/base/sheet` + `--ease-snap/overshoot`，
   顺手把按钮按下做成「快进慢出」的不对称。做一次，全局手感一起变。
4. **`[hidden] { display:none }` 的守卫**：`confirm-dialog` / 审批卡片 / 各类覆盖层
   凡写了 `display` 的，补一条。这是真会咬人的（见 §4.2）。
5. **危险操作按钮的输入保护**：审批/删除类弹窗，主按钮初始 disabled 一小段。
   mcode 有审批链（`orchestration/`），这条直接对症。

**B 档 · 值得做，但要设计决策**

6. **`--cds-rem-scale` 式缩放**：mcode 的 `"R G B"` 三元组体系要引入「乘系数」，
   得先决定要不要保留三元组写法（三元组是为了 `bg-surface/50` 的 alpha，
   乘系数不冲突，可以并存）。
7. **`data-text-size`（字号档 + **同步行高**）**：对话正文的阅读密度，值得做成设置项；
   注意必须同时改 `line-height`。
8. **轮廓式骨架**：需要先有「记住上次侧栏布局」的数据，是个小功能而不是纯样式。
9. **`@property` 注册**：至少把要参与过渡的几个值注册成类型化（如滚动渐隐、
   消息动作栏透明度）。零风险、纯增量。

**C 档 · 记下来，别现在做**

10. **三层 token 重构**：现在 mcode 的 8 个语义 token 能用；升成 385 色阶是
    **为「用户/AI 自定义主题」铺路**的大工程，应该跟着那个需求一起做，而不是单独重构。
11. **Tailwind v4**：v4 的 preflight 会让所有按钮光标变箭头（§3.5）、
    `space-y-*` 语义变化（§3.3）、`rounded` 默认值变化——**升级时要一次性对齐**，
    可以照抄 `window-legacy-pins.css` 那个「可删的兼容层」写法。
12. **`data-mode="system"` 可嵌套明暗作用域**：等真出现「在亮色应用里画一块暗色区」
    的需求再做。

### 5.3 明确**不要**搬的

- 主窗口正文从远程加载（mcode 离线自足，CSP 自限）。
- 216KB 那种 **构建期类名扫描**的巨型 CSS——mcode 现在 Tailwind v3 的按需产出是对的。
- `buddy_window` 的 cream/clay 手作色板、`clawdQuestEngine` 的游戏 UI：**场景特定**，
  按台账第零节的结构原则，这类东西**不该进本体**。
  真要做，走「工作流 / 扩展 / 自定义 UI 面板」。

---

## 六、如果只挑三件做

1. **`data-reduce-motion` 总闸**（A1）——半天量级，同时补上无障碍缺口和一个可被
   Agent 自配置的开关。
2. **动效 token + 统一焦点环**（A2/A3）——手感与一致性一次性到位，改的是变量不是组件。
3. **`local_exec_consent` 的那套做法**（§4.2）——**不是搬样式，是搬原则**：
   凡是「让用户做授权决定」的界面，依赖要少到可审计、输入保护要有、
   渲染只用 `textContent`。这条对 mcode 的审批/权限链直接适用。

---

## 附：本次分析的可复现路径

```bash
# 已完成，无需重跑
# 1) 静态分析（REA）
#    analyze_javascript_application  input_path=<app.asar>  integrity_policy=record-and-continue
#    → evidence ev_92ab1a5263d4afaaf2134b730a66710a95d71aeff301966cc84943b81c5c0240
# 2) 抽取
#    extract_artifact → output_root=%TEMP%\rea-extracted-338538fd-3762-46e1-a160-6b835a5493eb
```

**未做的事（如实写）**：
- **没有运行**那个 app，**没有截图**——所有「看起来怎样」都是从 CSS/HTML 推的，不是看的。
- **没有做变异验证**——本报告不产生 mcode 侧断言，没有可撤掉的修复可验。
- **没读** `apps/claude-ai/**` 与 `renderer/**` 的 JS 源码（只读了 CSS/HTML 产物）；
  组件级的实现（React 组件结构、状态管理）**没有覆盖**。
- `data-density` 只有 `comfortable` 一个值出现在产物里，**其他档位是否存在无法从产物判断**——
  可能被 tree-shake 掉了。
