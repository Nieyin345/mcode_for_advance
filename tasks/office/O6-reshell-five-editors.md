# O6｜五个编辑器的换壳：把 GenOffice 的 chrome 重指到 Mcode 的 token

- Status: **批一已交付（html + markdown）**；批二待开（slides / pdf / sheets）
  - 批一：vendor `87d9b4b`(html) / `f69db1d`(markdown)，主仓 `f61e4168`；html 25/25、markdown 29/29
  - **desktop typecheck 尚未通过**：101 条错误全在 O5 在途的 onlyoffice 文件，O6 相关 0 条。O5 清掉后需重跑。
- Category: **Office / 用户可见的 UI 契合**
- Priority: **P0 —— 用户看到的是「GenOffice 应用被塞进一个面板」，不是「Mcode 的编辑器」**
- Depends on: **`0014-feat-docs-reshell-the-chrome-in-mcode-design-tokens.patch`（docs 已完成，是模板）**
- 独占写入边界：
  - `genoffice/apps/{sheets,slides,pdf,markdown,html}/src/renderer/mcode-theme.css`（新建）
  - `genoffice/apps/{sheets,slides,pdf,markdown,html}/src/renderer/main.tsx`（**只加一行 import**）
  - `patches/genoffice/00xx-*.patch`（由 `git -C genoffice format-patch` 导出）
  - **不得改**：组件树、`packages/ui/src/tokens.css` 本体、`apps/desktop/**`

## Required Skills

- 先读 `genoffice/apps/docs/src/renderer/mcode-theme.css` 的头部注释（**那就是规范**）

## 一、问题（用户截图确认过）

用户看到的是：**完整的 GenOffice 应用**——自己的 ribbon、自己的 File/Edit/View 菜单、自己的
「Genspark AI」侧栏、自己的品牌。

**原因**：我们加载的是 `genoffice/apps/<kind>/out/renderer/index.html`，
**上游原封不动的产物**。`genofficeViewFactories.ts` / `documentViewHost.ts` 里
**一行 `insertCSS` / `executeJavaScript` 都没有**（grep 过，只有 `setWindowOpenHandler`）。

**用户的选择是 B（vendor 二开）**，不是 A（外部 CSS 硬藏）、不是 C（接受）。

## 二、★ 但这件事已经做过一次了 —— docs 的 `0014`

`05da63c feat(docs): reshell the chrome in Mcode's design tokens`（235 行 CSS，2 个文件）。

**它是正确做法，照抄机制，不要重新发明。**

它为什么对（原文摘录）：

> GenOffice 的 chrome 颜色全部走 `packages/ui/src/tokens.css` 里的语义 token，
> 而且它自己有一条 CI（`tools/check-theme-colors.mjs`）强制这件事：
> renderer CSS 里**不许出现裸色值**。
>
> 所以换壳在这里不是「改组件」也不是「套宿主 DOM」，而是**替换 token 的取值**：
> 组件树、编辑内核、ProseMirror schema、文档模型、导出/打印路径一行不动。

**加载方式**（`apps/docs/src/renderer/main.tsx:26`）：

```ts
if (window.desktop) import('./mcode-theme.css')
```

**⚠️ 但这个开关只对 docs 成立 —— 不能照抄到其他五个。**

**执行会话实测（2026-10-24）**：

```
html/src/preload/index.ts:132       exposeInMainWorld('htmlApi', api)         ← 没有 desktop
markdown/src/preload/index.ts:164   exposeInMainWorld('markdownApi', api)     ← 没有 desktop
docs/src/preload/index.ts:284       exposeInMainWorld('desktop', api)         ← 只有 docs 有
```

**`window.desktop` 在 html/markdown 上是 `undefined`** —— 照抄的话 `import()` 永远不触发，
**换壳代码写了但从不执行，而套件断言源码里有那行所以全绿。**

## 用 UA 里的产品名做开关（实测可行）

Electron 默认 UA 带 `app.getName()`：同一份 html 产物，
app 名 `GenOffice HTML` 时 UA 是 `GenOfficeHTML/44.4.5`，app 名 `Mcode` 时是 `Mcode/44.4.5`。
（`apps/desktop/src/main/index.ts:89` 附近有 `app.setName("Mcode")`。）

```ts
// 各 app 的 main.tsx
if (/\bMcode\//.test(navigator.userAgent)) import('./mcode-theme.css')
```

**为什么 UA 更好**：`window.desktop` 问的是「我是谁」，而各 app 自己的命名空间在独立运行时也存在；
UA 问的是「谁在跑我」。

### 2.1 六个 app 共享同一个 token 层（我核实过）

六个 `main.tsx` **全部** import `packages/ui/src/tokens.css`：

```
docs / sheets / slides / pdf / markdown / html   →  genoffice/packages/ui/src/tokens.css
```

**所以这个模式对五个格式都成立，不需要各写一套机制。**

### 2.2 各格式的 token 用量（工作量预估）

| 格式 | 不同 token 数 | 备注 |
|---|---|---|
| docs | 197 | **已完成**（235 行 CSS） |
| slides | 150 | 第二大 |
| pdf | 115 | |
| sheets | 109 | 截图里那个（有 ribbon + AI 侧栏） |
| markdown | 95 | |
| html | 57 | 最小，**建议作为第二个做**（验证机制在非 docs 上成立） |

## 三、判据

### 3.1 硬判据（每个格式都要）

| # | 断言 |
|---|---|
| 1 | **宿主里**打开该格式，`mcode-theme.css` 被加载（`document.styleSheets` 里能找到，或某个被覆盖的 token 生效） |
| 2 | **单独跑 GenOffice**（app 名非 Mcode）时，**不加载**它（不换壳） |
| **2b** | **上面两条必须都在真 Electron 里跑**，不是读源码断言「有这个形状」 |

**⚠️ 判据 2b 的由来**：`0014`（docs）的套件只断言源码里有 `if (window.desktop)`，
**没断言它真的区分** —— 而实测表明它在独立 docs 里也换壳了。**源码形状 ≠ 行为。**
| 3 | 被覆盖的 token **实际生效**：取一个已覆盖的 token，`getComputedStyle` 的值 = Mcode 的值 |
| **3b** | **`--surface` 的计算值**：宿主里 `#fcfcfb`，独立里 `#ffffff` |

**为什么 3b 是单独一条**：**它防的是「sheet 加载了但没生效」**（选择器写错、被更晚的规则覆盖）。
判据 1 只证明「文件被加载」，不证明「值变了」。
| 4 | **组件树没变**：该格式的核心 DOM 结构（`.ProseMirror` / `#univer-container` / 画布等）仍在 |

### 3.2 不许破坏的东西（这是硬边界）

`0014` 的头部注释已经写明，**每一条都适用于其余五个**：

- **文档内容色一律不动**：纸张、单元格、导出、打印、图表调色板、高亮色表。
  **它们必须保持与 Word/Excel 一致的渲染结果**，不是「看起来像 Mcode」的对象。
- **语义色不动**：docs 的修订条 / 查找命中；**sheets 的公式引用高亮、错误值红、条件格式色**；
  slides 的母版参考线等。**换掉会让用户认不出这是 Excel 的哪一类标记。**
- **`packages/ui/src/tokens.css` 本体不动** —— 只新增覆盖层文件。

### 3.3 一句话验收

**「宿主里的编辑器和单独跑的 GenOffice 是同一个应用，只是 chrome 换成了 Mcode 的配色。」**
不是「重新画了一个编辑器」。

## 四、★ 那个 AI 侧栏（截图里最刺眼的部分）

`Genspark AI` / 「向 AI 询问这个工作簿」侧栏，默认 `showAiSidebar: true`
（`packages/ui/src/ai-panel-prefs.ts:39`）。

**它不是要「换壳」，是要「接线」**：

- 上游的 AI 面板已经**接到了 Mcode 的会话**（`0008` / `0010` 的 scoped AI bridge）；
- 所以它不该被藏掉，**它应该正常工作**（用 Mcode 的模型，不是 GenOffice 的账号）。

**但它的视觉要和 Mcode 的 AI 面板一致** —— 这属于本卡的 chrome 范畴。

**如果你发现它在宿主里根本没接上 Mcode 的会话（点了没反应、或者用了自己的账号），
记录成 findings，另开卡。不要在换壳卡里改接线。**

## 五、变异要求

1. **删掉 `if (window.desktop)` 条件**（变成无条件加载）→ 3.1 第 2 条必须红
   （单独跑 GenOffice 时不该换壳）；
2. **把某个被覆盖 token 的值改回上游值** → 3.1 第 3 条必须红；
3. **删掉 `main.tsx` 的那行 import** → 3.1 第 1 条必须红。

## 六、做法（五步，每个格式重复）

1. **读 `genoffice/apps/docs/src/renderer/mcode-theme.css` 全文** —— 那是规范；
2. 列出该格式**实际用到的 token**（`grep -rhoE 'var\(--[a-z-]+\)' apps/<k>/src/renderer/*.css | sort -u`）；
3. 与 docs 那份对照：**同名的直接复用取值，不同名的单独定**；
4. 新建 `apps/<k>/src/renderer/mcode-theme.css`，`main.tsx` 加一行 `if (window.desktop) import(...)`；
5. `git -C genoffice format-patch` 导出到 `patches/genoffice/`。

**先做 html（57 个 token，最小）** —— 用最小的验证机制成立，再推到大的。

## 六之一、⚠️ UA 判据的两个前提（先验，别假设）

**UI 线提醒的两个风险，我核过代码但没跑成探针 —— 你要在真 Electron 里验。**

### 前提 1：`app.setName` 必须在 `whenReady` 之前调用

```
apps/desktop/src/main/index.ts:101   app.setName("Mcode");
apps/desktop/src/main/index.ts:177   app.whenReady().then(...)
```

**101 < 177，成立。** 但**这是「读代码得到的」，不是「跑出来的」** ——
`setName` 在 ready 之后调用时，UA 可能只对之后创建的窗口生效。**你要在真 Electron 里看一眼 UA 字符串。**

### 前提 2：文档视图不能覆盖 UA

```bash
$ grep -rn "userAgent\|setUserAgent" apps/desktop/src/main/document/*.ts
(空)
```

**没覆盖。** 但如果你发现 GenOffice 的 BrowserWindow 用了独立的 `webPreferences`，
UA 可能不同 —— **核对 `genofficeViewFactories.ts` 创建窗口时的 `webPreferences`。**

### 如果 UA 判据不成立，退路是什么

**UI 线给的方向**：**在 preload 里注入一个由宿主设置的标记**。
**代价**：宿主和 vendor 两边都要改，比 UA 贵得多。

**先别走到那一步。** 先确认 UA 到底行不行 —— **一条 `console.log(navigator.userAgent)` 就够。**

### ★ 这条要作为「第一个判据」先跑

**在写任何 CSS 之前，先做这一步**：

1. 用真 Electron 打开 html（宿主里）；
2. 打印 `navigator.userAgent`；
3. 把 app 名改成 `GenOffice HTML` 再跑一次；
4. **两次的 UA 不同 → 判据成立；相同 → 停下来回报，别继续写五个格式的 CSS。**

**理由**：如果 UA 判据不成立，**你写的五份 `mcode-theme.css` 全部落空**
（和我在卡里抄 `if (window.desktop)` 是同一个错，只是换了一层）。

## 六之二、⚠️ `smokes-for.sh` 看不见这个目录 —— 那是**假阴性**，不是真的没覆盖

**实测**（2026-10-24）：

```bash
$ bash apps/desktop/scripts/smokes-for.sh genoffice/apps/html/src/renderer/main.tsx
genoffice/apps/html/src/renderer/main.tsx
  ⚠️ 没有套件覆盖它 —— 改这里没有回归网。
```

**这句话在这里是错的。**

`smokes-for.py` 建的是 `apps/desktop/src/**` → `apps/desktop/scripts/*` 的依赖图。
**`genoffice/` 是独立 git 仓库，从来不在那张图上。**

**所以它对 `genoffice/` 下的任何改动都会说「没覆盖」—— 包括你正要改的五个 renderer。**

**真正的覆盖是**：

```bash
pnpm test:smoke o6-reshell-<format>-smoke   # ⚠️ 名字必须以 -smoke 结尾
# 或者直接跑
bash apps/desktop/scripts/o6-reshell-<format>-smoke/run.sh
```

**⚠️ 套件目录必须以 `-smoke` 结尾，否则连发现器都不认它。**
`smokes-for.py:331-332` 的判据是 `if not d.name.endswith("-smoke"): continue` ——
**只认 `-smoke`**。全仓有 9 个目录因此完全不在索引里（含 `electron-u1`、`arc005-visual-baseline`）。

**两条限制叠在一起**（都在这张卡里）：
1. **`genoffice/` 不在依赖图上** → 说「没有套件覆盖」（假阴性，见上）；
2. **目录名不以 `-smoke` 结尾** → 连发现器都不认。

**所以：目录名必须 `*-smoke`，跑法用 `pnpm test:smoke <那个名字>`。**

**不要因为 `smokes-for.sh` 说「没有回归网」而怀疑自己没做对。**
也**不要**为了「让它闭嘴」而去改 `apps/desktop/` 里无关的东西。

## 六之三、★ 通用规则（2026-10-24 探测后确立）：**换壳 = 换共享 token，app 私有 token 一律不动**

**这条比「覆盖 54 个 chrome token」更准确，因为它解释了「为什么是这 54 个」** ——
**不是因为它们看起来像 chrome，是因为它们在共享层里。**

### 硬证据

```
$ grep -c -- "--pdf-statusbar-bg" genoffice/packages/ui/src/tokens.css
0                                                   ← 不在共享层

$ grep -n -- "--docs-statusbar-bg" genoffice/apps/docs/src/renderer/styles.css
44:  --docs-statusbar-bg: #f3f4f6;                   ← docs（已换壳）也没换它
```

**docs 是 0014 换过壳的，`--docs-statusbar-bg` 还是 `#f3f4f6`。**
**所以「只覆盖共享 token」不是偏好，是已经发生的事情。**

### 可验的形式（每个格式都加这条断言）

```bash
# 覆盖的每个 token 必须在 tokens.css 里
THEME=apps/<app>/src/renderer/mcode-theme.css
grep -oE '^\s*--[a-z0-9-]+' "$THEME" | sed 's/^\s*//' | while read -r t; do
  grep -q -- "$t:" genoffice/packages/ui/src/tokens.css || echo "私有 token 被覆盖了: $t"
done
```

**它防的是「有人觉得某个私有 chrome 也该换」而悄悄加进去** ——
**那是 html/markdown 套件里「不覆盖 `--hx-*` / `--md-*`」那些断言的通用化。**

### 各格式的私有 chrome 与内容色（探测结果，2026-10-24）

| app | 可覆盖（∩tokens.css） | app 私有 | 私有的典型 | 该不该换 |
|---|---|---|---|---|
| html | 41 | 26 | `--hx-*` | ❌ |
| markdown | 43 | 61 | `--md-*` / `--mdt-*` | ❌ |
| **pdf** | **41** | **82** | `--pdf-paper` / `--pdf-statusbar-bg` / `--pdf-ink-*` / `--pdf-search-hit-*` | ❌ |
| **slides** | **42** | **138** | `--slides-paper` / `--slides-show-fill-*` / `--slides-anim-*` | ❌ |
| **sheets** | **40** | **91** | `--sheets-paper` / `--sheets-chart-*` | ❌ |

**可覆盖的数几乎不变（40–43），私有的从 26 涨到 138** ——
**机制成立，但适用范围随 app 复杂度收窄。**

### canvas 不是第三层风险（探测结论）

**三家都没有 chrome 画在 canvas 上**：

| app | canvas 画什么 | 是 chrome 吗 |
|---|---|---|
| pdf | 页面渲染 + 导出填白 | ❌ 内容 |
| slides | 脱敏框（`redactFrame` 3 个值，注释明写「两种主题画得一样」） | ❌ 内容语义 |
| sheets | Univer 网格；**上游注释明说不吃 CSS token**（`App.tsx:1736`） | ❌ 内容 |

**所以「chrome 是 canvas 画的，CSS 管不到」这个担心不成立。**

## 七、不要做的事

- **不要用 `insertCSS` 从外面硬藏**（那是 A 方案，用户明确选了 B）。
- **不要改组件树**。`0014` 证明不需要改。
- **不要改 `tokens.css` 本体**。
- **不要五个格式一个提交**。一个格式一个补丁，出问题能单独回退。
- **`apps/desktop/**` 只允许改两个 vendor 账本**：
  `build/genoffice-upstream.lock.json` 与 `build/verify-genoffice-upstream.cjs`。
  **先例**（都动过）：
  ```
  613402eb feat(T39): reshell the Docs chrome in Mcode's design tokens
  d6822b86 chore(T115): carry the w:eastAsia fix as genoffice patch 0015
  ```
  **lock 里记 `revision` / `expectedTree` / `patchSeries`（每条补丁的 file + revision）** ——
  加了新补丁不更新它，**provenance / freshness 套件会红**。
  **除此之外 `apps/desktop/**` 一行不改**（不动任何 product source）。

## 八、结果回写区

（执行会话按格式追加：token 清单、覆盖了哪些、哪些故意没覆盖及理由、变异记录、补丁文件名）

---

## 结果回写：html + markdown（第一批，2026-10-24）

### 0. ★ 卡里的开关前提是错的 —— 已改正，并先验证再写代码

| | 卡里写的 | 实际 |
|---|---|---|
| 开关 | `if (window.desktop)` | **html/markdown 没有 `window.desktop`**（preload 暴露 `htmlApi` / `markdownApi`）。照抄 = 换壳永不触发 |
| 0014 的守卫 | 「单独跑不换壳」 | **对 docs 也失效**：原厂 docs preload 自己就 `exposeInMainWorld('desktop')`，真 Electron 实测独立 docs 会加载 `mcode-theme.css` |
| 0014 的套件 | 「条件加载」17/17 | 只断言**源码里有那个形状**，没断言它真的区分 —— 与「判据会骗人」同型 |

**采用的新开关（实测过三种形态）**：`if (/\bMcode\//.test(navigator.userAgent))`。

Electron 默认把 `app.getName()` 写进 UA 注释段：

```
app.setName("GenOffice HTML") → ... GenOfficeHTML/44.4.5 ...
app.setName("Mcode")          → ... Mcode/44.4.5 ...
无 preload + ProbeApp         → ... ProbeApp/44.4.5 ...   ← 排除「preload 塞的」
```

Mcode 主进程 `apps/desktop/src/main/index.ts:101` 在 `whenReady` 之前 `app.setName("Mcode")`；
`grep -rn "userAgent|setUserAgent" apps/desktop/src/main/document/*.ts` 为空；
vendor `createHtmlView` / `createMarkdownView` 的 `webPreferences` 只有
preload/contextIsolation/nodeIntegration/sandbox。**所以 UA 产品号能真正区分宿主与独立运行，且不动 `apps/desktop`。**

### 1. 覆盖了多少 token

| 格式 | 覆盖的 chrome token | 实际被消费 | 未被本 app 消费但保留 |
|---|---|---|---|
| html | **54** | 39 | 15（`--bg-hover*` 族、`--chrome-bg`、`--border-hover`、`--success*`、`--danger-bg/-border`、`--pressed`、`--shadow-btn-hover`、`--color-error-hover`、`--color-border-brand`） |
| markdown | **54** | 40 | 14（同上，另含 `--color-btn-primary-hover`、`--color-error`） |

**覆盖集与 docs 的 0014 逐字相同**：六个 app 共用同一个 token 层，同一套值才是同一个产品。
「未被本 app 消费」的那些由共享 `@genoffice/ui/*.css`（AI 面板、下拉、查找、颜色选择器…）消费，
或为与兄弟 app 保持一致而保留 —— 它们不写也不会错，但写了才能保证 chrome 跨 app 一致。

**markdown 额外钉住 18 亮 + 18 暗个文档内容 token**（见 §3）。

### 2. 故意没覆盖的，及理由

| 不覆盖 | 理由 |
|---|---|
| `--preview-page-bg`（html） | 预览 iframe 的底。浏览器里没有自己背景的页面永远是白色（上游注释写死），换掉就是改文档内容 |
| `--hx-*` 族（html） | HTML app 自己的**语义色**：AI 改动高亮、错误态、焦点环、shimmer。换掉用户认不出「哪些是 AI 改的」 |
| `--cm-*` 族（html） | CodeMirror 语法高亮色（tag/attr/string/keyword…）—— 代码文本的语义 |
| `--surface-2`（html） | 只在 `var(--surface-2, var(--surface))` 里被读，上游**从未定义**；定义它会改掉回退行为 |
| `--md-*` 族（markdown） | 正文排版语义：链接、代码块、引用、表格头、图表底、纸张阴影 |
| `--mdt-*`（markdown） | 纸张主题调色板（notion-light 等） |
| `--redact-*`（markdown） | 脱敏标记语义色 |
| `--accent` / `--accent-dark` / `--accent-soft` / `--word-blue` | 各 app 的品牌色归各 app（GenOffice CLAUDE.md 主题规则第 3 条） |
| `--search-hit-*` / `--docs-revision-bar` | 查找命中 / 修订条 —— 文档语义标记 |
| `--color-bg-overlay` | 模态遮罩，深色下上游是 60% vs 亮色 50%，属「视觉重量」不是 chrome 色阶；且两版都在暗底上，换不换看不出 |
| `--text-body-lg` / `--text-small` / `--text-caption` / `--transition-fast` / `--radius-30` / `--ui-scale` | 字号阶梯、动效时长、胶囊圆角、界面缩放 —— 不是颜色，Mcode 与 GenOffice 在这几项上本来一致（或由用户设置驱动） |

### 3. ★ markdown 的硬边界：纸张与 chrome 撞名

`apps/markdown/src/renderer/styles.css:200` 的 `.doc-page`（App.tsx:1262，**正文直接渲染在里面**）
用的是 `background: var(--surface)` —— 和 chrome 是同一个 token。只改 `:root` 会把正文纸张一起染成
Mcode 的暖白。

**处置**：在 `.doc-page` 作用域内把纸张与正文会读到的 18 个 token 钉回 `tokens.css` 的值
（亮/暗/系统暗三块）。钉住的作用域只到 `.doc-page` 自己：

- `.editor-scroll`（画布底，**属 chrome**）不受影响 —— 套件里有对照断言证明它**确实**换了；
- `html[data-markdown-theme='…'] .doc-page`（特异度 0,2,1）高于 `.doc-page`（0,1,0），
  所以用户选的纸张主题仍然获胜 —— 那是显式选择，不该被覆盖。

**防漂移断言**：套件逐条比对「钉住值 == tokens.css 当前值」，不等时消息点名是哪个 token
（`XXX: 钉住 #fff，上游现在是 #eee —— 上游改了纸张/墨色，要决定跟不跟`），不是一句 expected/got。

### 4. 四条判据的红绿（真 Electron，同一份构建产物跑两遍）

| # | 判据 | html | markdown |
|---|---|---|---|
| 1 | 宿主里 `mcode-theme.css` 被加载 | ✅ 1 个 sheet | ✅ |
| 2 | 独立运行（app 名非 Mcode）**不加载** | ✅ 0 个 sheet | ✅ |
| 3 | 被覆盖 token 实际生效（`getComputedStyle`） | ✅ `--surface` #fcfcfb、`--text` #151515、`--border` #e1e0d9、`.ribbon` 背景 rgb(252,252,251) | ✅ 同左 |
| 4 | 组件树没变 | ✅ `.ribbon`/`.app-main`/`.pane-preview`/`.status-bar` | ✅ `.ribbon`/`.app-main`/`.doc-page`/`.status-bar` |

**套件**：`o6-reshell-html-smoke` **25/25**、`o6-reshell-markdown-smoke` **29/29**
（markdown 多 4 条：纸张色彩两次相同、`.doc-page` 内 `--surface`/`--text` 钉住、`.editor-scroll` 对照、防漂移）。

两条套件都跑**真实构建产物 + 原厂 preload + vendor 自己的独立入口**
（`apps/<k>/out/main/index.js`），只改 `app.setName()` —— 两次运行的差异只可能来自开关。

### 5. 三个变异（每次都重新构建，还原后 sha256 逐字节核对）

**html**（基线 25/25）：

| 变异 | 结果 | 红了什么 |
|---|---|---|
| M1 删掉 UA 条件 → 无条件 import | **19/25**（6 红） | 独立模式那组 5 条 + 开关契约 1 条 |
| M2 `--surface` 改回上游 `#ffffff` | **23/25**（2 红） | `--surface` token 值 + `.ribbon` 计算背景（证明「sheet 加载了但值没生效」也抓得住） |
| M3 删掉 main.tsx 的 import | **18/25**（7 红） | 宿主模式那组 6 条 + 开关契约 |

**markdown**（基线 29/29）：

| 变异 | 结果 | 红了什么 |
|---|---|---|
| M1 无条件 import | **22/29**（7 红） | 独立模式 5 条 + 开关契约 + `.editor-scroll` 对照（独立也被换壳，两边相同） |
| M2 `--surface` 改回 `#ffffff` | **27/29**（2 红） | 同 html |
| M3 删 import | **21/29**（8 红） | 宿主模式 6 条 + 开关契约 + `.editor-scroll` 对照 |

**均先写预期红几条再跑**；还原后 `sha256sum` 逐字节一致（html main `772a13e3…`、theme `8e54e70b…`；
markdown main `ce9aec91…`、theme `ec0afe0b…`），重建后两套都回到全绿。

### 6. 交付物

**vendor 仓（`mcode/integration`）**：

| SHA | 内容 |
|---|---|
| `87d9b4b` | `feat(html): reshell the chrome in Mcode's design tokens`（2 文件，+261） |
| `f69db1d` | `feat(markdown): reshell the chrome in Mcode's design tokens`（2 文件，+357） |

**补丁**（一个格式一个，可单独回退）：

```
patches/genoffice/0016-feat-html-reshell-the-chrome-in-Mcode-s-design-token.patch   13077 B  4cad1b5b…f2c98f
patches/genoffice/0017-feat-markdown-reshell-the-chrome-in-Mcode-s-design-t.patch  17152 B  15558ac9…a7fb8
```

**vendor 账本**（T39/T115 先例；只改这两个文件，不动任何 product source）：

- `apps/desktop/build/genoffice-upstream.lock.json`：`revision` → `f69db1d2`、`expectedTree` → `1340bd51`、
  `patchSeries` 追加 0016/0017（15 → 17 条）；
- `apps/desktop/build/verify-genoffice-upstream.cjs`：`FINAL_REVISION` / `FINAL_TREE` 更新，
  `PATCHES` 追加两条。**同时把 0015 的 `revision: FINAL_REVISION` 钉成字面量
  `3cb99ab1…`** —— T39 记过这个陷阱：最后一条用常量，常量一动它跟着漂。
- 验证：`MCODE_INCLUDE_GENOFFICE_BUNDLE=1 node apps/desktop/build/verify-genoffice-upstream.cjs`
  → **exit 0**，`f69db1d (base cbec600, 17 patches, tree 1340bd51)`。

**套件**（`apps/desktop/scripts/`）：

- `o6-reshell-html-smoke/{build.mjs, probe.cjs, run.sh}` —— 25 条
- `o6-reshell-markdown-smoke/{build.mjs, probe.cjs, run.sh}` —— 29 条

两条 `run.sh` 都用 `HERE=$(cd "$(dirname "$0")" && pwd)` 再 `cd "$HERE/../.."`。
两个探针都在 **require vendor 入口之前**用 Proxy 替换 `BrowserWindow`，强制 `show:false` +
`skipTaskbar:true` —— 套件窗口不会弹到用户屏幕上（原来 vendor 入口默认可见）。

### 7. 已知未做 / 觉得不对但没改

1. **docs 的 0014 守卫失效**（独立运行也被换壳）：不在本批写入边界内，总控已同意另开卡。
   建议那张卡的判据就是本套件这条：「独立运行，`styleSheets` 里不能有 `mcode-theme`」。
2. **没有覆盖 `sheets` / `slides` / `pdf`** —— 本批只做 html + markdown。
3. **暗色只做了 token 层，没做真 Electron 暗色断言**：套件的两模式都是亮色（`data-theme` 未设）。
   暗色那两块是逐字镜像 docs 的 0014，但**没有实测**——如实记在这里。
4. **`--color-bg-overlay` / 字号阶梯 / 动效 / `--radius-30` / `--ui-scale` 没覆盖**（理由见 §2）。
5. **markdown 的 `markdown-themes.css` 纸张主题没有回归**：本套件只验默认主题。选 notion-light 等
   纸张主题时，`html[data-markdown-theme] .doc-page` 因特异度获胜（纸色由主题给），这一条是
   从 CSS 特异度推出来的，**没有真跑过**。

### 8. 补强：暗色断言 + 非默认纸张主题回归（2026-10-24，同日第二轮）

总控指出两条真缺口，已补并各自做了变异。

#### 8.1 暗色（两套各一组，html 36/36、markdown 45/45）

**暗色怎么触发**（先查清，不猜）：GenOffice 的 `UiTheme` 只有 `light | dark | system`；
`system` 时渲染端**不设** `data-theme`，暗色走 `tokens.css` 的
`@media (prefers-color-scheme: dark)` 块。独立运行的 html/markdown 没有 shell 注册
`app:get-theme`（`apps/shell/src/main/index.ts:4940` 才注册），渲染端 `catch` 到 `'system'`
——**所以暗色的真实触发路径就是 system + OS 深色**。探针用
`nativeTheme.themeSource = 'dark'` 精确控制它，只影响本进程。

**断言**（每种模式各 11 条，含两条「前提」）：
- ★ 前提：独立暗色 `--surface` = `#1e1e1e`（nativeTheme 真的传导了）
- ★ 前提：**亮 ≠ 暗**（否则暗色断言是空的 —— 这条防的是「跑了个寂寞」）
- 宿主暗色：theme 加载、`--surface` #151515、`--text` #f9f9f7、`.ribbon` rgb(21,21,21)
- 独立暗色：不加载、`--text` #e4e4e4、`.ribbon` rgb(30,30,30)
- ★ 对照：宿主暗色的 `.ribbon` **不等于**独立暗色
- 文档内容：html 的 `--preview-page-bg` 暗色下仍 #ffffff；
  markdown 的 `.doc-page` 纸张暗色下两次相同、且 `--surface` = #1e1e1e（钉住生效），
  同时 `.editor-scroll`（chrome）**确实**换成 Mcode 暗色 canvas rgb(15,14,14)

**变异**：删掉 `[data-theme='dark']` 块 → **仍然 36/36**（因为 `prefers-color-scheme`
那块还在，暗色照旧生效）。**这说明我第一次的变异选点不够狠**，于是把两块都删：

| 变异 | 结果 |
|---|---|
| 只删 `[data-theme='dark']` | **36/36** —— 断言没错，是变异没打到病灶 |
| `[data-theme='dark']` + `@media (prefers-color-scheme)` **都删** | **32/36**，4 红全在暗色组 |

#### 8.2 非默认纸张主题（markdown，**实测不是从特异度推的**）

**路径**：vendor 自己的 `getMarkdownTheme` 读 `userData/markdown-settings.json` 的
`markdownTheme`（`markdown-main.ts:959/994`）。探针预置这个文件，**走真实读取链**，
不在渲染端硬 `setAttribute` —— 后者验的是「属性有效」，不是「用户选主题时有效」。

选了 `newsprint`（纸张 `#f3f2ee`）：

| 断言 | 结果 |
|---|---|
| ★ 前提：独立运行纸张真的变成 rgb(243,242,238) | ok |
| ★ 宿主里纸张**也是** rgb(243,242,238)（主题赢过被换掉的 chrome） | ok |
| ★ 对照：同一轮 `.ribbon` 仍是 Mcode 表面 rgb(252,252,251)（主题只管纸张） | ok |
| ★ 对照：独立同一主题 `.ribbon` 是上游表面 rgb(255,255,255)（防恒真） | ok |

**变异**：给 `.doc-page` 的钉住 `--surface` 加 `!important`（模拟「钉住压过主题」）→
**41/45，4 红**：暗色纸张两次不同（宿主 #fff vs 独立 #1e1e1e）、暗色钉住失效、
newsprint 宿主纸张变成 #fff、防漂移也红（值里多了 `!important`）。
**全部精确落在纸张/主题这条线上** —— 证明「主题赢过钉住」是跑出来的，不是推的。

#### 8.3 一条方法论记录

「从特异度推出来」在这次被证明**不足以当证据**：我先写的变异（只删一个块）
让全套全绿，看起来像「暗色断言是空的」。真因是 CSS 有**两条**独立的暗色来源
（`[data-theme]` 与 `prefers-color-scheme`），删一条另一条兜住了。
**所以「删掉一处仍全绿」有两种含义：判据失效，或这次本来就不该红** —— 要换选点再试，
而不是立刻改判据。

---

## 结果回写：pdf（第二批，2026-10-24）

### 1. 覆盖了多少

**54 个共享 chrome token**，与 docs/html/markdown 逐字相同。pdf 自己的 CSS 实际消费其中 41 个。

### 2. ★ 两条通用规则（比「覆盖 54 个」更准确）

**规则 A —— 换壳 = 换共享 token，app 私有 token 一律不动。**

这条解释了**为什么是这 54 个**：不是因为它们看起来像 chrome，是因为它们**在共享层里**。
证据（总控核过）：docs 换壳后 `--docs-statusbar-bg` 仍是原值 `#f3f4f6`，pdf 的
`--pdf-statusbar-bg` 也是 `#f3f4f6` —— **已经发生的事情与这条规则一致**。

**可验形式**（已写进套件）：主题层覆盖的每个 `--x` 必须出现在 `tokens.css` 里。
```
ok  覆盖的每个 token 都来自 tokens.css（共享层共 65 个，本文件覆盖 54 个）
```

**规则 B —— PDF 比 markdown 简单，因为它的纸色不在共享层。**

markdown 的 `.doc-page` 用共享的 `var(--surface)`，必须在作用域内钉回上游；
**pdf 的纸张是 app 私有的 `--pdf-paper`（`styles.css:27`），不在覆盖集，自然保持上游白**。
所以 pdf 不需要任何「钉住」块，也不存在 markdown 那种撞名风险。

### 3. 故意没覆盖的

| 不覆盖 | 类别 |
|---|---|
| `--pdf-paper` | 纸张（文档内容） |
| `--pdf-search-hit-*` / `--pdf-search-hit-cur-*` | 查找命中（文档语义） |
| `--pdf-ink-*`（underline/strike/highlight） | 墨迹批注（文档语义） |
| `--pdf-redaction-stripe-*` / `--pdf-redaction-border` | 遮盖条纹（文档语义） |
| `--pdf-form-*` / `--pdf-formdesign-*` / `--pdf-textedit-*` | 表单域 / 文本编辑（文档语义） |
| `--pdf-statusbar-bg` / `--pdf-focus-ring` / `--pdf-shadow-menu` | **app 私有 chrome** —— 见规则 A |
| `--accent*` / `--search-hit-*` / `--docs-revision-bar` | 品牌色 / 文档语义标记 |

### 4. 判据（真 Electron，四种模式：宿主/独立 × 亮/暗）

| # | 判据 | 结果 |
|---|---|---|
| 1 | 宿主里 `mcode-theme.css` 被加载 | ✅ |
| 2 | 独立运行不加载 | ✅ |
| 3 | token 实际生效 | ✅ `--surface` #fcfcfb、`--text` #151515、`--border` #e1e0d9、`.ribbon` rgb(252,252,251)、字体栈 `-apple-system` |
| 4 | 组件树没变 | ✅ `.ribbon` / `.app` / `.status-bar` |
| + | 暗色（宿主/独立各一组 + 两条前提） | ✅ 宿主 `--surface` #151515 / `.ribbon` rgb(27,27,26)；独立 `--text` #e4e4e4 / `.ribbon` rgb(37,37,37) |
| + | 纸张 | ✅ `--pdf-paper` 两种模式都是 `#fff` |

**`o6-reshell-pdf-smoke`：38/38。**

### 5. 变异（先写预期，再跑，还原后 sha256 核对）

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 去掉 UA 门（无条件加载） | 独立模式 6 条 + 暗色独立 4 条 | **10 红**，全在独立/暗色独立组 ✅ |
| M2 `--surface` 改回 `#ffffff` | 1 条 | **1 红**（`--surface` token 值） |
| **M2b `--chrome-bg` 改回 `#ffffff`** | 1 条 | **1 红**（`.ribbon` 计算背景） |
| M3 删 import | 宿主 6 条 + 暗色宿主 6 条 | **12 红**，全在宿主组 ✅ |

**M2 与 M2b 的关系值得记**：pdf 的 `.ribbon` 读的是 `--chrome-bg`（`styles.css:204`），
不是 `--surface`。所以改 `--surface` 只红 token 那一条、`.ribbon` 不动；改 `--chrome-bg`
只红 `.ribbon` 那一条。**两条断言各管一个 token，互不兜底** —— 这正是「断言互相独立」
该有的样子，也说明我最初写的 `.ribbon` 断言标签（「Mcode 表面」）在说谎，已改成
`--chrome-bg`。

### 6. 交付物

- vendor 提交 `4c893cf`（2 文件，+254）
- `patches/genoffice/0018-feat-pdf-reshell-the-chrome-in-Mcode-s-design-tokens.patch`（12492 B，sha256 `6ad0e845…26156`）
- 账本：lock `revision` → `4c893cf4`、`expectedTree` → `17d9ff28`、patchSeries 18 条；
  verify `FINAL_*` 更新 + `PATCHES` 追加 0018
- `apps/desktop/scripts/o6-reshell-pdf-smoke/{build.mjs, probe.cjs, run.sh}`

### 7. 未做 / 需知

1. **`verify-genoffice-upstream.cjs` 暂时跑不了** —— vendor 树里有别人未提交的改动
   （`apps/pdf/src/main/save-pdf.ts`、`slides-main.ts`、`electron-utils/document-save-guard.ts`，
   看起来是 O9「覆盖保存」那条线）。verify 正确拒绝（dirty tree）。等它们提交后再验。
   **这不是我的改动造成的，我也没有碰那些文件。**
2. **pdf 的 ribbon 只在打开文档后才渲染**（起始页只有 8 个字符的「加载中」）。套件为此在
   自己临时目录里生成一份最小 PDF 作为 argv 传给 `startPdfStandalone()` —— 那是真实入口，
   不联网、不依赖用户文件、不污染仓库。
3. 暗色的两个期望值（rgb(27,27,26) / rgb(37,37,37)）是 `--chrome-bg` 的暗色值，
   不是 `--surface` 的 —— 第一次写错成 `--surface` 的值，红了两条；那是断言错，不是代码错。

---

## 结果回写：slides（第三批，2026-10-24）

### 1. ★ 这个 app 的开关最危险 —— 它自己也 expose 了 `window.desktop`

```
apps/slides/src/preload/index.ts:485   exposeInMainWorld('slidesApi', api)
apps/slides/src/preload/index.ts:499   exposeInMainWorld('desktop', filesApi)   ← 文件附件 API
```

**所以 docs 的 `if (window.desktop)` 在 slides 上恒为真** —— 独立运行也会被换壳，
和 0014 在 docs 上实际发生的事同型。用 UA 产品号（`/\bMcode\//`）才能区分。

### 2. 覆盖 54 个共享 chrome token（与四家一致）

### 3. ★ 138 个 app 私有 token 逐个判断：全部不覆盖

slides 是五个里私有 token 最多的（138 个），而且「该不该动」最难判断 —— pdf 只有
一个 `--pdf-paper`，slides 有母版、放映、动画一整套。逐个分类：

| 族 | 是什么 | 判断 |
|---|---|---|
| `--slides-paper` | 幻灯片纸张 `#fff` | **文档内容**，不动 |
| `--slides-show-*`（22 个） | 放映模式：`--slides-show-black: #000`、`--slides-show-white/ink/fill-*` | **放映是固定黑底白字，不跟 UI 主题**，不动 |
| `--slides-anim-*`（5 个） | 进入 `#107c41` / 强调 `#c28e00` / 退出 `#c43e1c` / 路径 `#2b7cd3` / 媒体 `#7a5cc4` | **PowerPoint 的动画类型色标** —— 用户靠颜色认是哪一类动画，不动 |
| `--slides-crop-*` / `--slides-guide` / `--slides-grid-line` | 裁剪遮罩、红色参考线、网格 | **编辑辅助语义**，不动 |
| `--slides-reading-*` | 阅读视图 `#2b2b2b` / `#eee` | **固定深色**，不跟主题，不动 |
| `--slides-laser-*` | 激光笔（红） | **演示语义**，不动 |
| `--slides-statusbar-bg` `#f3f4f6` / `--slides-rail-bg` `#ececec` / `--slides-focus-ring` / `--slides-shadow-menu` | **app 私有 chrome** | **规则 A：不动** —— 与 docs 的 `--docs-statusbar-bg` 在 0014 后仍是 `#f3f4f6` 一致 |
| `--slides-select-*` / `--slides-hover-wash*` / `--slides-cell-focus-bg` | 由 `var(--accent)` 派生 | 派生自品牌色，**它们自己会跟着 `--accent` 走**（而 `--accent` 不在覆盖集） |
| `--slides-ai-error*` / `--slides-error*` / `--slides-ok` | 状态语义 | 不动 |
| `--slides-ko*` / `--slides-badge-*` / `--slides-ph-*` / `--slides-swatch-*` | 占位符、徽标、色板环 | 不动 |

**`canvas-colors.ts` 也不动**：全文只有 `redactFrame: { stroke, chip, label }` 三个值，
注释明写「红框随图片进缩略图，两种主题画得一样」。**那是脱敏标记，不是 chrome。**

### 4. 判据（真 Electron，四种模式）

`o6-reshell-slides-smoke`：**39/39**。

| 组 | 断言 |
|---|---|
| 前提 | 独立暗色 `--surface` = `#1e1e1e`；亮 ≠ 暗 |
| 宿主亮 | theme 加载、`--surface` #fcfcfb、`--text` #151515、`--border` #e1e0d9、`.ribbon` rgb(252,252,251)、字体栈 |
| 独立亮 | 不加载、三个 token = 上游、`.ribbon` rgb(255,255,255)、Arial |
| 宿主暗 | theme 加载、`--surface` #151515、`--text` #f9f9f7、`.ribbon` rgb(27,27,26) |
| 独立暗 | 不加载、`--text` #e4e4e4、`.ribbon` rgb(37,37,37) |
| 对照 | 宿主暗 `.ribbon` ≠ 独立暗 |
| 文档内容 | `--slides-paper` 两种模式都是 `#fff` |
| 组件树 | `.ribbon` / `.app` / `.status-bar` |
| 边界 | 不覆盖 `--accent*` / `--word-blue` / `--slides-paper` / `--slides-show-*` / `--slides-anim-*` / `--slides-crop-*`+guide+grid / `--slides-reading-*` / `--slides-laser-*` / `--slides-statusbar-*`+rail+focus-ring+shadow-menu / `--search-hit-*`+revision-bar |
| 规则 A | 覆盖的每个 token 都来自 `tokens.css` |

**不需要 fixture**：`startSlidesStandalone()` 没有 `.pptx` argv 时，渲染端自己调
`newBlank(FIT_WIDTH)` 开空 deck（`App.tsx:1231`），外壳照样渲染。
（pdf 那套要造最小 PDF，因为它的 ribbon 只在打开文档后出现。）

### 5. 变异

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 去 UA 门 | 独立 6 + 暗色独立 4 + 开关契约 1 | **11 红** ✅ |
| M2 `--surface` → `#ffffff` | 1 | **1 红**（token 值）✅ |
| M2b `--chrome-bg` → `#ffffff` | 1 | **1 红**（`.ribbon`）✅ |
| M3 删 import | 宿主 6 + 暗色宿主 5 + 契约 1 | **12 红** ✅ |

M2 / M2b 与 pdf 同形：**改一个只红一条，改另一个只红另一条，互不兜底。**

还原后 sha256 逐字节（main `84e43322…`、theme `277fd9a2…`），重建回 39/39。

### 6. 交付物

- vendor 提交 `58cd1a13fb2482eae14962f758aac9e2d349936e`（2 文件，+261），父提交 `4c893cf`（pdf）
- `patches/genoffice/0019-feat-slides-reshell-the-chrome-in-Mcode-s-design-tok.patch`（12836 B，sha256 `fea2602d…aa853`）
- 账本：lock `revision` → `58cd1a13`、`expectedTree` → `a39cff94`、patchSeries 19 条；verify 同步
- `apps/desktop/scripts/o6-reshell-slides-smoke/{build.mjs, probe.cjs, run.sh}`

### 7. 未做 / 需知

1. **`verify-genoffice-upstream.cjs` 仍跑不了** —— vendor 树里 O10 的未提交改动
   （`save-pdf.ts`、`slides-main.ts`、`document-save-guard.ts`、三家 main、`electron-utils/package.json`）
   还在。**提交时我逐条核过暂存区只有我的两个 slides 文件**，没碰他们的、也没 stash。
2. **`?mode=audience` 放映窗不受影响**：`main.tsx` 的 audience 分支不调 `applyTheme`，
   且放映外观由 `--slides-show-*` 决定（不在覆盖集）。但**这一条是从代码读出来的，没有真跑**——
   套件只验普通编辑窗。
3. **Konva 画布上的内容（幻灯片本体）本来就不吃 CSS token** —— 那是文档内容，正确。

---

## 结果回写：sheets（第四批，最后一个，2026-10-24/25）

### 1. 覆盖 54 个共享 chrome token（与五家一致）

### 2. ★ Sheets 的特殊之处：网格是 Univer canvas，外壳是自家 DOM

**上游自己的注释就是答案**（`App.tsx:1736`）：

```
// Univer paints the grid on canvas, so it can't follow the CSS tokens —
// mirror the canvas state into its official darkMode flag
```

**网格不跟 token —— 而它也不该跟**：单元格、条件格式、图表配色是**文档内容**。
网格明暗由 Univer 的 `darkMode` 布尔决定，那个布尔读 `data-theme` / `prefers-color-scheme`
（`App.tsx:1745-1747`）—— 和本文件的开关同源，所以暗色下网格跟着变，那是上游自己的行为。

**外壳**（ribbon / 名字框 / 状态栏 / 对话框）是 `ExcelShell.tsx` 的自家 DOM，全走共享 token。

**一个副作用**：`.spreadsheet { background: var(--surface) }`（`styles.css:1938`）会被改掉，
但 Univer canvas 盖在它上面，用户看不见。**无害，但读代码的人会以为网格背景被换了。**

### 3. 91 个 app 私有 token 全部不覆盖

| 族 | 是什么 |
|---|---|
| `--sheets-paper` | 单元格纸张（`#ffffff`） |
| `--sheets-chart-*` / `--chart-*` | 图表配色与标签（文档数据） |
| `--sheets-pie-label-*` | 饼图标签 |
| `--sheets-shape-*` | 形状填充/描边（文档内容） |
| `--sheets-excel-blue` / `--excel-green*` | Excel 的语义蓝/绿 |
| `--sheets-content-danger` / `--sheets-validation-*` | 内容危险态 / 数据验证提示 |
| `--univer-primary-600` | Univer 自己的主题色 |
| `--sheets-statusbar-*` / `--sheets-scroll-thumb` / `--sheets-focus-ring` / `--sheets-shadow-*` | app 私有 chrome（规则 A：不动） |

### 4. ★ M2b 全绿 —— 这是正确的，且已记账

| 变异 | pdf | slides | **sheets** |
|---|---|---|---|
| M2 `--surface` → `#ffffff` | 1 红 | 1 红 | **2 红**（token + `.ribbon`） |
| M2b `--chrome-bg` → `#ffffff` | 1 红 | 1 红 | **0 红** |

**原因**：sheets 的 `.ribbon` 读 `--surface`（`styles.css` 的 `.ribbon` 规则），
pdf/slides 的读 `--chrome-bg`。**同一个语义位置，三个 app 用不同 token。**

**`--chrome-bg` 在 sheets 里零消费者**（renderer CSS 与共享 UI CSS 都没有）。覆盖它无害但无用；
不覆盖它会让覆盖集与另外五家分叉。**所以保留覆盖并记账。**

**新增一条断言把这事实打出来**：
```
覆盖集里本 app 不消费的 token（16）: --chrome-bg --pressed --active-bg --bg-hover …
ok  ★ 覆盖集里「本 app 零消费者」的 token 不超过 20 个
```
它不判对错，只钉住「数量不会悄悄涨」——涨了说明覆盖集混进了本 app 用不到的东西。

### 5. 判据：`o6-reshell-sheets-smoke` 42/42

四种模式（宿主/独立 × 亮/暗）+ 两条前提 + 正控 + 不消费记账 + 边界 8 条 + 规则 A。

### 6. 变异

| 变异 | 实际 |
|---|---|
| M1 去 UA 门 | **11 红**（独立 6 + 暗色独立 4 + 契约 1） |
| M2 `--surface` → `#ffffff` | **2 红**（token + `.ribbon`） |
| M2b `--chrome-bg` → `#ffffff` | **0 红**（正确答案，见 §4） |
| M3 删 import | **12 红**（宿主 6 + 暗色宿主 5 + 契约 1） |

还原后 sha256 逐字节（main `f840ae89…`、theme `996b5759…`），重建回 42/42。

### 7. 写这个套件时抓到两个断言 bug（都是我自己写的）

1. **DOM 断言假设有 `.app` 容器** —— sheets 没有（`ExcelShell` 直接渲染 `.ribbon` + `.sheet-body`）。
   改成 `.ribbon` / `#univer-container` / `.status-bar` / `.qa-btn`。
2. **「不是 window.desktop」用了子串匹配** —— 而 sheets 的 preload 暴露的是 `window.desktopApi`，
   **`includes("window.desktop")` 会被它满足**。改成单词边界 `/window\.desktop(?!\w)/`。
   **这是「断言的名字比它检查的范围大」的又一实例**：名字说「不是 window.desktop」，
   子串匹配把 `window.desktopApi` 也算进去了。

### 8. 交付物

- vendor 提交 `e9b4c41615f1ca615dd06ee10d05cbaac9382462`（2 文件，+270），父 `58cd1a13`
- `patches/genoffice/0020-feat-sheets-reshell-the-chrome-in-Mcode-s-design-tok.patch`（13523 B，sha256 `ff90a3e7…097b8`）
- 账本：lock 20 条、`revision` → `e9b4c416`、`expectedTree` → `0013dff4`；verify 同步
- `apps/desktop/scripts/o6-reshell-sheets-smoke/{build.mjs, probe.cjs, run.sh}`

### 9. 未做 / 需知

1. **sheets 构建要 Rust `cargo`，这台机器没有**。我用 `npx electron-vite build`（在 `apps/sheets`
   下）跳过 `native:build` —— 因为 `native/xlsx-engine/target/release/xlsx-sidecar.exe` **已存在**。
   **这不是常规构建路径**：正式重建 vendor 时应跑完整 `npm run build -w @genoffice/sheets`。
2. **`verify-genoffice-upstream.cjs` 仍跑不了** —— vendor 树里 O8（`docs/src/renderer/main.tsx`）
   与 O10（`save-pdf.ts` / `slides-main.ts` / `document-save-guard.ts` / 三家 main）的未提交改动还在。
   提交时逐条核过暂存区只有我的两个 sheets 文件。
3. **`NOT-COVERED` 已输出**：网格明暗只验了 CSS chrome，Univer canvas 的明暗未实测。

---

## 五家收尾状态（2026-10-25）

### 五套全绿（真 Electron，每次自建产物）

| 格式 | 套件 | 断言数 |
|---|---|---|
| html | `o6-reshell-html-smoke` | **36/36** |
| markdown | `o6-reshell-markdown-smoke` | **45/45** |
| pdf | `o6-reshell-pdf-smoke` | **39/39** |
| slides | `o6-reshell-slides-smoke` | **40/40** |
| sheets | `o6-reshell-sheets-smoke` | **42/42** |
| | **合计** | **202** |

### 五个 vendor 提交 / 五个补丁

| # | 格式 | vendor SHA | 补丁 | 字节 |
|---|---|---|---|---|
| 0016 | html | `87d9b4b` | `0016-feat-html-reshell-…patch` | 13077 |
| 0017 | markdown | `f69db1d` | `0017-feat-markdown-reshell-…patch` | 17152 |
| 0018 | pdf | `4c893cf` | `0018-feat-pdf-reshell-…patch` | 12492 |
| 0019 | slides | `58cd1a1` | `0019-feat-slides-reshell-…patch` | 12836 |
| 0020 | sheets | `e9b4c41` | `0020-feat-sheets-reshell-…patch` | 13523 |

lock 现有 **20 条** patchSeries，`revision` = `e9b4c416`、`expectedTree` = `0013dff4`。

### typecheck

- **contracts：exit 0**
- **desktop：exit 0**（101 → 38 → 0，O5/O10 落地后归零）

### 仍未验的一件事（如实）

**`verify-genoffice-upstream.cjs` 跑不了** —— vendor 树里还有 O10 的未提交改动
（`markdown-main.ts` / `save-pdf.ts` / `slides-main.ts` / `electron-utils/package.json` /
`document-save-guard.ts`）。**verify 正确拒绝 dirty tree。**
**O10 提交后必须补跑一次**，预期：
```
GenOffice original upstream approved: e9b4c416 (base cbec600, 20 patches, tree 0013dff4)
```
**在那之前，这五个补丁的「在干净树上能逐条 replay」这一条没有证据。**

### 五家共同的结论（给后续维护者）

1. **换壳 = 换共享 token，app 私有 token 一律不动**（规则 A）。可验：套件断言覆盖集的
   每个 token 都出现在 `tokens.css` 里，且有正控（≥ 40 个）防止正则失效后恒真。
2. **开关用 UA 产品号，不用 `window.desktop`** —— 它在 docs 恒真、在 slides 也恒真
   （slides 的 preload 用 `desktop` 暴露附件 API）、在 html/markdown/pdf/sheets 恒假。
   **一个名字在六个 app 上有四种含义。**
3. **断言要念它实际读的 token**：pdf/slides 的 `.ribbon` 读 `--chrome-bg`，sheets 的读
   `--surface`。写错时亮色下同值、只有暗色才暴露（实测：pdf 第一次就栽在这）。
4. **文档内容各有各的形态**：html 是预览 iframe 的底、markdown 是与 chrome 撞名的
   `.doc-page` 纸张、pdf 是 app 私有的 `--pdf-paper`、slides 是 138 个内容/语义 token、
   sheets 是 Univer canvas。**同一个卡、五种不一样的做法。**
