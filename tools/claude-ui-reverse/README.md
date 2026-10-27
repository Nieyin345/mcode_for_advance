# Claude UI 逆向工具

从本机安装的 Claude Desktop 里提取 UI 事实。**只读，不执行目标程序。**

## 为什么需要这套脚本

Claude 的渲染端是 **minified bundle**（3797 个 chunk，118 MiB），而且：

- CSS 是 **Tailwind 的原子类产物** —— 读得到 `width:18rem`，读不出「哪个组件用了它」
- JS 是 **混淆后的工厂函数** —— REA 的语义图给出 `modules: 0`，549k 个 AST 节点全匿名
- 语言包**键是混淆 id**（`+/cwsayrqk`），只能按**值**匹配

所以「结构」必须从五处分别挖，再交叉验证：

| 来源 | 能回答什么 | 脚本 |
|---|---|---|
| CSS `--cds-*` 变量 | 设计 token 的**真值**（字号、间距、圆角） | `extract-tokens.mjs` |
| CSS 颜色/阴影/层级 | 亮暗两套颜色、阴影链、z-index | `extract-visual.mjs` |
| CSS 语义类 | `shadow-composer` / `rounded-card` 的真实值 | `extract-semantic-classes.mjs` |
| JS `className` | 哪个元素用了哪些类 + 解成 px | `scan-all-classnames.mjs` / `extract-geometry.mjs` |
| `en-US.json` 的**值** | 界面上实际显示的文字 | `extract-i18n.mjs` |
| 渲染进程内存 | 哪些组件**真的**出现在 DOM 里 | `dump-renderer-memory.mjs` |

`resolve-class.mjs` 是共用件：把 Tailwind 类名解成计算后的 px（含 `var()` 与 `calc()` 展开）。
`extract-all-css.mjs` 扫**全部 25 个 CSS**，按前缀报告变量分布与分档 —— **别只跑主 CSS**。

## 用法

```bash
# 0. 先确认版本（版本变了，结论全部作废）
powershell -c "Get-Process claude | Select-Object -First 1 Path"

# 1. 把需要的文件拷到 .tmp/rev/
mkdir -p .tmp/rev
P="C:/Program Files/WindowsApps/Claude_<版本>_x64__pzs8sxrjxfjjc/app/resources"
cp "$P/ion-dist/assets/v1/<主CSS>.css" .tmp/rev/main.css
cp "$P/en-US.json" .tmp/rev/en-US.json

# 2. 跑（顺序有依赖：tokens 要先于 visual）
node tools/claude-ui-reverse/extract-tokens.mjs            # → tokens.json
node tools/claude-ui-reverse/extract-visual.mjs            # → visual-tokens.txt
node tools/claude-ui-reverse/extract-semantic-classes.mjs  # → semantic-classes.txt
node tools/claude-ui-reverse/resolve-class.mjs             # 自检
node tools/claude-ui-reverse/extract-geometry.mjs          # → hardcoded-geometry.txt
node tools/claude-ui-reverse/scan-all-classnames.mjs       # → component-geometry.txt
node tools/claude-ui-reverse/extract-i18n.mjs              # → i18n-ui.txt
python tools/claude-ui-reverse/icon-names.py               # → icon-names.txt

# 3. 运行时佐证（可选，需 Claude 正在运行）
node tools/claude-ui-reverse/dump-renderer-memory.mjs      # → renderer-hits.txt
```

所有脚本的路径都**相对仓库根**解析，从任何目录调用都能跑（已验证）。

---

## 六个已经踩过的坑

### 一、`rem-scale` 在 Windows 上**根本不存在**，`var(..., 1)` 取 **1**

> ⚠️ **2026-10-28 更正 —— 这一节的原文写反了，照着它做会错 6%。**
>
> 原文说「`rem-scale` 是 `calc(16 / 17)`，不是 `1`，写成 rem × 16 会让每一格偏大
> 6.25%」。**前半句对，结论错。**

`--cds-rem-scale: calc(16 / 17)` 在 25 个 CSS 里**只声明一处**，且落在：

```css
@supports (font:-apple-system-body) and (-webkit-touch-callout:default) {
  :root { --cds-rem-scale: calc(16 / 17) }
}
```

那是 **Apple / iOS 专属分支**。真 Electron 44.4.5 / 45.1.0 on Windows 实测：

```
CSS.supports("font", "-apple-system-body")                        → false
CSS.supports("-webkit-touch-callout", "default")                  → false
getComputedStyle(.cds-root).getPropertyValue("--cds-rem-scale")   → ""（空串）
```

所以 `calc(Nrem * var(--cds-rem-scale, 1))` 在 Windows 上取 **N × 16**。

**静态解析 CSS 看不见 `@supports` 的作用域。** 一个「找到 `名字:` 就抄值」的
解析器会把 Apple 专属值当成通用值，导出后每一项都**小 6%** —— 字号、圆角、
间距、控件高，全套。而输出看上去完全正常，这是最难发现的一类错。

正确做法：**算每个声明是否落在 `@supports` 里**（按花括号配对求块头栈），
无条件定义不存在时按 CSS 语义回落成 `1`。`gen-cds-tokens.mjs` 的
`uncondRemScale()` 就是这么做的。

### 二、裸 `rem` 不乘 scale —— 指的是它没有 `calc()` 包装

`--cds-font-size-prose: 1rem` 是 **16px**（comfortable 层）。

> ⚠️ 原文写的是 `.875rem` = 14px，并把「13.18」当成错误值。实际上
> `.875rem` 是 **`.cds-root` 基础层**的 prose，comfortable 层是 `1rem`；
> 而 13.18 是「`.875rem` × 16/17」—— 两个错乘出来的。
>
> 真值：`.prose` 的计算字号 = **16px**，行高 = **24px**
> （`--cds-leading-prose: 1.5rem`）。

这一档之所以特殊，是因为它**写成裸 `rem` 而不是 `calc(Nrem * scale)`**，
所以在任何密度/尺寸档下都是整数 px，不随 `--cds-rem-scale` 变化。

### 三、选择器要用「完全相等」判，且要**按逗号拆开**

- `.cds-root [data-step="3"]` 也含 `.cds-root` → 用 `includes` 会让字号档覆盖 base。
- 暗色三层写在**一个**逗号组合的选择器里：
  ```
  [data-mode=dark] .cds-root:not(...):not(...),
  .cds-root[data-mode=dark],
  .cds-dark-scope[data-mode=dark] { … }
  ```
  不拆的话只会命中第一段。

### 四、调色板在 `:where(:root,:host)` 上

只认 `:root` 会让所有 `var(--cds-gray-20)` 解不开 —— 颜色全空。

### 五、**只解析了 25 个 CSS 里的 1 个**

我把 `--df-row-h` 判成「CSS 里零定义」写进了文档 —— 它在 `shared-styles-*.css` 里。
`extract-all-css.mjs` 现在扫全部 25 个，并按前缀告诉你「该看哪个文件」。

### 六、`data-cds` 组件名在 CSS 里≠在 JS 里

`ChatComposerDock` 在 CSS 里出现 10 次，在 JS 里 **0 次**。
输入框的真实 DOM 标识是 `.epitaxy-prompt` / `.epitaxy-prompt-input` / `[data-cds="ChatComposer"]`。

---

## 输出解读

`tokens-out.txt` 里每一行都带原始值：

```
  body    13.176px  lh   18.824px   [calc(.875rem * var(--cds-rem-scale,1))]
```

**原始值在方括号里** —— 数字与原始值对不上时，先怀疑解析器而不是数据。

`tokens.json` 按**层**分：
`root` / `base` / `dark` / `dark-media` / `theme-claude` /
`comfortable` / `compact` / `step1..5` / `size-xs|sm|lg` / `cmp-*`。

> ⚠️ `comfortable` 是真实默认（`index.html` 里 `<html data-density="comfortable">`）。
> 只看 `base` 会得到「整屏字偏小」的结论 —— 那是错的，base 只是无 density 覆盖时的值。

---

## 静态拿不到的东西（已实测确认）

### 1. ~~运行时几何~~ —— **这一条上一轮判错了，已更正**

上一版这里写着：「`--df-row-h` / `--df-row-gap` … CSS 里没有默认值」。
**那是错的。** 我只解析了主 CSS（`c6a992d55-*.css`），而它们在
**`shared-styles-D_GJawPO.css`** 里，还有 6 个定义点。

**侧栏真实值**（`.dframe-root` / comfortable / comfortable+desktop）：

| 变量 | 基准 | comfortable | +desktop |
|---|---|---|---|
| `--df-sidebar-width` | **288px**（唯一值） | | |
| `--df-row-h` | 26px | **32px** | **30px** |
| `--df-row-gap` | 4px | 8px | 8px |
| `--df-row-font` | 13px | 14px | 14px |
| `--df-leading-slot` | 24px | 28px | 28px |
| `--df-icon-size` | 16px | 20px | 20px |
| `--df-radius-pill` | 6px | 8px | 8px |
| `--df-header-h` | **48px** | | |
| `--df-chrome-bar-height` | 0px / **36px**（有 `[data-wco]`） | | |

用 `extract-all-css.mjs` 可以重跑，它**扫全部 25 个 CSS**。

**教训**：「我搜过了」必须写清「搜了哪些文件」。

### 2. 图标 SVG path

图标是**编译期组件**（`y(Re,{name:"ArrowReturn",size:"sm"})`），名字→path 的表被 minify 改名。
`extract-icons.mjs` 试过，只捞到 32 个且全是误报（`yMd` 是日期格式串）。**保留该脚本是为了说明为什么不行。**

**图标名字能拿到**（276 个，见 `icon-names.txt`）—— 画的时候按名字找近似图形。

### 3. 运行时调试通道：**两条都堵死**（实测）

| 方式 | 结果 |
|---|---|
| `--remote-debugging-port=9333` | Claude **自己拒绝启动**：`refusing to start — a debugging or network-override switch is present on the command line.` |
| `--inspect=9334` | fuse `EnableNodeCliInspectArguments` 是 **disabled**；且 `--user-data-dir` 指向新目录时缓存目录被占用（`Unable to move the cache: 拒绝访问`） |

`inspect_electron_fuses` 实测：`RunAsNode` disabled / `EnableNodeCliInspectArguments` disabled /
`EnableEmbeddedAsarIntegrityValidation` enabled / `OnlyLoadAppFromAsar` enabled。

### 4. 内存转储能做什么、不能做什么

`dump-renderer-memory.mjs` 能拿到「哪些组件真的在页面上」：

```
MessageActions 74 · Prose 64 · MessageAttachmentsImage 49 · Card 38
AssistantMessage 38 · ChatComposerDock 23 · Icon 17 · Toolbar 14 · Page 13
```

**不能**拿到父子关系与计算尺寸 —— 那些在 C++ 的 layout 对象里，不是字符串。

---

## 数据快照（Claude 3.6556.2.0）

| 文件 | 内容 |
|---|---|
| `tokens.json` | 全部 `--cds-*`，按层分 |
| `tokens-out.txt` | 七档字号 × 每层的人读表 |
| `visual-tokens.txt/json` | 颜色（亮/暗并排）、阴影、z-index、动画、字体 |
| `semantic-classes.txt` | `shadow-composer` 这类语义类的真值 |
| `hardcoded-geometry.txt` | 骨架里**写死**的 px（不含运行时变量） |
| `component-geometry.txt` | 组件 className 解算结果 |
| `i18n-ui.txt` | 界面文案（按值归类） |
| `icon-names.txt/json` | 276 个图标名（无 path） |
| `renderer-hits.txt` | 运行时 DOM 里真实出现的组件名统计 |

**快照有保质期**：版本一变，全部作废。用之前先核对 `# 0.` 那一步的版本号。
