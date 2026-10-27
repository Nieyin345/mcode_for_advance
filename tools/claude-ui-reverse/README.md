# Claude UI 逆向工具

从本机安装的 Claude Desktop 里提取 UI 事实。**只读，不执行目标程序。**

## 为什么需要这套脚本

Claude 的渲染端是 **minified bundle**（4259 个 chunk），而且：

- CSS 是 **Tailwind 的原子类产物** —— 读得到 `width:18rem`，读不出「哪个组件用了它」
- JS 是 **混淆后的工厂函数** —— REA 的语义图给出 `modules: 0`，549k 个 AST 节点全匿名
- 语言包**键是混淆 id**（`+/cwsayrqk`），只能按**值**匹配

所以「结构」必须从三处分别挖，再交叉验证：

| 来源 | 能回答什么 |
|---|---|
| CSS `--cds-*` 变量 | 设计 token 的**真值**（字号、间距、圆角） |
| CSS 组件选择器 | 某个 `data-cds` 组件上的**专属变量** |
| JS `className` 字符串 | 哪个元素用了哪些类（布局意图） |
| `en-US.json` 的**值** | 界面上实际显示的文字 |

## 用法

```bash
# 0. 先确认装的是哪个版本（版本变了，结论全部作废）
ls -d "C:/Program Files/WindowsApps/Claude_"*

# 1. 把需要的文件拷到 .tmp/rev/
mkdir -p .tmp/rev
P="C:/Program Files/WindowsApps/Claude_<版本>_x64__pzs8sxrjxfjjc/app/resources"
cp "$P/ion-dist/assets/v1/<主CSS>.css" .tmp/rev/main.css
cp "$P/en-US.json" .tmp/rev/en-US.json

# 2. 跑
node tools/claude-ui-reverse/extract-tokens.mjs    # → .tmp/rev/tokens-out.txt
node tools/claude-ui-reverse/extract-layout.mjs    # → 组件级布局规则
node tools/claude-ui-reverse/extract-i18n.mjs      # → 界面文案
node tools/claude-ui-reverse/scan-classnames.mjs   # → 组件 className
node tools/claude-ui-reverse/scan-js-layout.mjs    # → JS 里的布局常量
```

脚本里的路径是**写死的绝对路径**，换版本要改。这是故意的 —— 版本号必须显式核对，
不能让它悄悄指向旧版本。

## 三个已经踩过的坑

**一、`rem-scale` 是 `calc(16 / 17)`，不是 `1`。**
写成「rem × 16」会让**每一格偏大 6.25%**，而输出看上去完全正常。
脚本里 `toPx` 会先把 `var(--cds-rem-scale)` 换成裸数值再算，并在输出里打印 scale 本身。

**二、裸 `rem` 不乘 scale。**
`--cds-font-size-prose: .875rem` 是 **14.00px**，不是 13.18px。
这是全表**唯一**一条裸值，容易当成笔误「修正」掉。

**三、选择器要用「完全相等」判，不能用 `includes`。**
`.cds-root [data-step="3"]` 也含 `.cds-root` —— 用 `includes` 会让「文本大小档 3」
覆盖掉真正的 `.cds-root` base。

## 输出解读

`tokens-out.txt` 里每一行都带原始值，形如：

```
  body    13.176px  lh   18.824px   [calc(.875rem * var(--cds-rem-scale,1))]
```

**原始值在方括号里** —— 数字与原始值对不上时，先怀疑解析器而不是数据。

`tokens.json` 是全量表，按**层**分：
`root` / `base` / `comfortable` / `step1..5` / `size-xs|sm|lg` / `cmp-*`。

> ⚠️ `comfortable` 是真实默认（`index.html` 里 `<html data-density="comfortable">`）。
> 只看 `base` 会得到「整屏字偏小」的结论 —— 那是错的，base 只是无 density 覆盖时的值。

## 数据快照

同目录下的 `tokens.json` / `tokens-out.txt` / `i18n-ui.txt` / `classnames.txt` /
`layout-out.txt` 是 **Claude 3.6556.2.0** 的快照，供没装那个版本时对照。

**快照有保质期**：版本一变，全部作废。用之前先核对 `# 0.` 那一步的版本号。
