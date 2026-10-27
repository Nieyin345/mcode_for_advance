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

## 五个已经踩过的坑

### 一、`rem-scale` 是 `calc(16 / 17)`，不是 `1`

写成「rem × 16」会让**每一格偏大 6.25%**，而输出看上去完全正常。
`extract-tokens` 里 `toPx` 会先把 `var(--cds-rem-scale)` 换成裸数值再算，并打印 scale 本身。

### 二、裸 `rem` 不乘 scale

`--cds-font-size-prose: .875rem` 是 **14.00px**，不是 13.18px。
这是全表**唯一**一条裸值，容易当成笔误「修正」掉。

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

### 五、`data-cds` 组件名在 CSS 里≠在 JS 里

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

## 静态拿不到的东西（**已实测确认**）

### 1. 运行时几何：侧栏行高、标题栏实际高度、输入框实际宽高

`--df-row-h` / `--df-row-gap` / `--df-row-px` / `--df-leading-slot` 这些变量：

- **CSS 里没有默认值**（搜遍 `main.css` 零定义）
- **JS 里没有赋值**（唯一的出现是 `getComputedStyle` 转发：`shared-46` 里 `t.style.setProperty(e, r.getPropertyValue(e))`）
- **渲染进程内存里 0 命中**

它们由运行时根据密度/字号档算出来后写在 style 上。静态无从得知。

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
