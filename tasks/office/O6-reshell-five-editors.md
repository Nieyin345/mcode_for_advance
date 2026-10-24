# O6｜五个编辑器的换壳：把 GenOffice 的 chrome 重指到 Mcode 的 token

- Status: **ready-for-agent**（**五个格式互相独立，可以并行；但每个都要按批做**）
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

**只有宿主存在时才换壳；单独跑 GenOffice 保持它自己的 Word 视觉。**

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
| 2 | **单独跑 GenOffice**（无 `window.desktop`）时，**不加载**它（不换壳） |
| 3 | 被覆盖的 token **实际生效**：取一个已覆盖的 token，`getComputedStyle` 的值 = Mcode 的值 |
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
pnpm test:smoke o6-reshell-<format>      # 你那套
```

**不要因为 `smokes-for.sh` 说「没有回归网」而怀疑自己没做对。**
也**不要**为了「让它闭嘴」而去改 `apps/desktop/` 里无关的东西。

## 七、不要做的事

- **不要用 `insertCSS` 从外面硬藏**（那是 A 方案，用户明确选了 B）。
- **不要改组件树**。`0014` 证明不需要改。
- **不要改 `tokens.css` 本体**。
- **不要五个格式一个提交**。一个格式一个补丁，出问题能单独回退。
- **不要碰 `apps/desktop/**`** —— Mcode 侧一行都不用改，这正是 B 方案的好处。

## 八、结果回写区

（执行会话按格式追加：token 清单、覆盖了哪些、哪些故意没覆盖及理由、变异记录、补丁文件名）
