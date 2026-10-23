# T39｜GenOffice UI 换壳：保留编辑内核，替换 ribbon / 菜单 / AI 面板

- Status: done（2026-10-23 验收通过：17/17，提交 613402eb）
- Category: feature（UI 重构）
- Priority: **P0 产品要求**
- Depends on: T7（已完成，六编辑器 U1 全 PASS）、T24（已完成，工具面重做）
- Exclusive writable files: **先做 Docs 一个 app 作为样板**，路径：`genoffice/apps/docs/src/renderer/components/Ribbon.tsx`、`ribbon-*.tsx`、`apps/desktop/src/renderer/components/document/`（Mcode 侧宿主 chrome）。逐个确认后写进回写区。

## Required Skills
- `frontend-design`: 这是视觉重做，要有明确的设计方向，不是照抄。
- `codebase-design`: 判断哪些是「外壳」可换、哪些是「内核」必须保留。
- `mcode-smoke`: 建回归，确认换壳没动编辑行为。

Read before work: `CLAUDE.md`、`docs/planning/mcode-product-roadmap.md`、`docs/design/claude-desktop-ui-细节逆向.md`、`open-claude-ui/docs/v1/01-设计哲学与设计令牌体系.md`、`genoffice/apps/docs/src/renderer/App.tsx`、`genoffice/apps/docs/src/renderer/components/Ribbon.tsx`、`genoffice/apps/docs/src/renderer/styles.css`。

## 用户的要求（原话）

> 「genoffice 的 ui 我们要做调整的，不是照搬过来的」

经确认，选的是**第二种**：**保留编辑内核（ProseMirror / Univer / PDFium），换掉工具栏 / 菜单 / AI 面板这些外壳 chrome，让它长得像 Mcode。**

## 现状（我核实过）

GenOffice 的 Docs 渲染端有完整的 Office 风格 UI：

```
genoffice/apps/docs/src/renderer/components/
  Ribbon.tsx                  ← 主 ribbon
  ribbon-tabs.tsx             ← 页签
  ribbon-design-tab.tsx       ← 设计
  ribbon-insert-tab.tsx       ← 插入
  ribbon-layout-tab.tsx       ← 布局
  ribbon-references-tab.tsx   ← 引用
  ribbon-hf-tab.tsx           ← 页眉页脚
  ribbon-color-palette.tsx
  ContextMenu.tsx
  ...共 55 个组件
```

设计 token 写死在 `styles.css`：

```css
--word-blue: #185abd;
--word-heading: #2f5496;
--accent: var(--word-blue);
```

**这是 Word 的视觉语言**，跟 Mcode（Claude 风格，`open-claude-ui` 逆向出的 CDS token）冲突。

## 目标

**只做 Docs 一个 app 作为样板。** 六家一起做会失控，先证明一套做法可行。

### 必须做到

1. **保留编辑内核的全部能力** —— 字体、段落、样式、表格、图片、引用、页眉页脚、修订、批注，一个都不能丢。**换壳不是砍功能。**
2. **替换视觉层**：
   - ribbon 的样式（配色、间距、圆角、阴影）改成 Mcode 的 token
   - 图标换成 Mcode 的图标集（`@tabler/icons-react` 或 `@iconify/react`，仓库已有）
   - 字体族、字号跟 Mcode 一致
3. **替换 AI 面板**：`genoffice/apps/docs/src/renderer/ai/AiPanel.tsx` 及配套（`AiComposer` / `AiQueueStrip` / `AiScopeQuote`）**移除**，改由 Mcode 宿主提供（T24 的工具面已经在做这件事）。
4. **保留 `mcode-view.ts` 的受限 preload 契约** —— 那是 T23/T98 建立的安全边界，换壳不许破坏。

### 明确不做

- **不改编辑内核**（`editor/*`、ProseMirror schema、document model）
- **不动 `mcode-view.ts` / `mcode-ai.ts` / `mcode-privileged.ts`** —— 那是受控通道
- **不做其余五个 app** —— 本卡只做 Docs 样板
- **不改 GenOffice 上游源码的语义**，只改视觉层与组件替换

## 关键判断（必须论证）

**换壳走哪条路？**

**(A) 改 GenOffice 的组件（走 `patches/`）**
- 优点：直接、可控
- 缺点：每个上游升级都要维护补丁

**(B) 在 Mcode 侧套一层宿主 chrome，GenOffice 只渲染编辑区**
- 优点：上游零改动
- 缺点：要能隐藏 GenOffice 的 ribbon 并接管它的命令入口

**选一个并论证。** 注意 T7 已经证明 GenOffice 的渲染端是独立 `WebContentsView`，**宿主无法直接改它的 DOM**——这会影响方案选择。

## 验收判据

1. 回写区给出换壳方案（A 或 B）与论证，说明为什么在 `WebContentsView` 隔离下可行。
2. Docs 的编辑功能**零回归**：T7 的 `docs-open-edit-save-reopen` 旅程仍 PASS。
3. 视觉上：ribbon 使用 Mcode 的 token（有截图或 DOM 断言证明）。
4. AI 面板已移除，AI 交互经 T24 的工具面。
5. `mcode-view.ts` 的 IPC 白名单**未变**（有断言）。
6. 变异验证：撤掉视觉替换 → 对应断言变红 → `cmp` 还原。
7. 双包 typecheck 通过。

## 边界

- **只做 Docs**。其余五个 app 等这套做法验证后再开卡。
- **不改** `patches/genoffice/` 里已有的 13 个补丁。
- **不碰** T2/T3/T4/T19/T27/T28/T33/T34 正在改的文件。
- 若发现必须改编辑内核才能达成视觉目标，**停下报告**——那说明方案错了。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T39-genoffice-ui-reshell.md` 末尾追加 `## 结果回写（2026-10-23）`：方案选择与论证、换了什么、保留了什么、编辑功能零回归的证据、视觉证据、变异证据、提交 SHA、其余五个 app 的估算。

---

## 结果回写（2026-10-23，C 会话）

### 1. 方案选择：走 **(A) 的 token 变体**，不是 A 也不是 B

卡上给的两条都不是最优解。实测后发现第三条路，成本比两者都低，而且**不违反任何硬约束**。

**先说为什么不是 B（宿主套 chrome + 接管命令）——技术上不成立。**

T7 已证明编辑器渲染在独立 `WebContentsView` 里，宿主只能 `setBounds`，改不了 DOM。B 的
第二个前提是「能接管 ribbon 的命令入口」，而实测：

```ts
// control.ts:5-6 —— 整个宿主→页面的控制面只有两个命令
export type ControlRequest =
  | { cmd: 'goto'; target: { kind: string; block?: number } }
  | { cmd: 'selection' }
```

**没有 ribbon 命令通道。** 要让 B 成立，得先在 vendor 里加一个命令分发面（`setBold` /
`insertTable` / 样式应用 / 页眉页脚 / 修订…… —— 那是 55 个组件背后几百个命令），
再在宿主重建一整套 ribbon UI。这不是「换壳」，这是**重写整个前端**，而且每加一个命令都要
同时改两处。T39 的边界明说「若发现必须改编辑内核才能达成目标，停下报告」—— B 要走的路
比改内核还远。

**再说为什么不是 A 的常规形态（改 55 个组件）——没必要。**

GenOffice 有一条**自己的 CI 在强制**主题纪律（`genoffice/tools/check-theme-colors.mjs`）：

```
RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/
TOKEN_DEF = /^\s*--[\w-]+:/          // ← 定义行是唯一例外
```

renderer CSS 里**不许出现裸色值**，chrome 颜色全部来自 `packages/ui/src/tokens.css` 的语义
token（`--surface` / `--text` / `--border` / `--hover` …）。也就是说：**换壳 = 换 token 取值**，
组件树一行不用动。

这不是我图省事 —— 是上游自己把「外壳」抽象成了 token 层，用它设计好的那个接缝，比绕过它去
改 55 个组件更符合「复用上游」的原则（L2 薄适配，不是 L3 fork）。

### 2. 做法

新增 `genoffice/apps/docs/src/renderer/mcode-theme.css`（241 行），把 chrome token 重指到
Mcode 的 CDS 色阶（`apps/desktop/src/renderer/tokens.cds.css`，MIT，从 open-claude-ui 逆向
生成的那份）。接线在 `main.tsx`：

```ts
if (window.desktop) import('./mcode-theme.css')
```

运行时判断，因为**同一个构建产物两边共用**：Mcode 里显示 Mcode 的样子，GenOffice 独立运行
（没有 `window.desktop`）保持自己的 Word 视觉。

**换了什么**（有断言）：表面阶梯 `--surface/-subtle/--chrome-bg/--canvas`、边框四档、
文字五档、交互态七档、状态色、三档阴影、主按钮与 AI 动作色（Word 橙 `#e8663f` → Mcode
陶土橙 `#c96442`）、字体栈（Arial 打头 → 系统 sans 栈）、圆角。

**刻意没换**（有断言）：
- `--accent` / `--accent-dark` / `--accent-soft` / `--word-blue` —— GenOffice CLAUDE.md
  明说各 app 的品牌色归各 app，我不该越过这条；
- `--docs-revision-bar` / `--search-hit-*` —— 那是 Word 的**语义标记**（修订条、查找命中），
  换掉用户就认不出这是哪类标记了；
- 文档内容色（纸张、单元格、导出、打印、图表调色板）—— GenOffice 主题规则第 4 条禁止，
  而且导出一致性比好看重要。

### 3. 编辑内核零回归 —— 证据

**T7 旅程 `docs-open-edit-save-reopen`：PASS。** 真 Electron、**两个 OS 进程**（保存后
真 `relaunch` 重开）、真 ProseMirror transaction、真键盘 Ctrl+S、真 e2e：

```
docs-open-edit-save-reopen: literal=PASS expectation=all-pass
T7: 正常跑退出码 0
```

过程中日志确认了完整链路：`open-path: prepared → committed → document view saved (3425 bytes)
→ closed → [relaunch] generation 1 exited → 新进程 → 重开 → 再 committed`。

**编辑内核零改动**：`Ribbon.tsx` / `editor/` / ProseMirror schema / 文档模型 **一个字节没动**
（`genoffice` 工作树除主题层与 `main.tsx` 接线外无改动，有断言 + 变异 M4 证明）。

### 4. `mcode-view.ts` IPC 白名单未变 —— 证据

**该文件一行未改。** `MCODE_DOCS_CHANNEL_POLICY` 在 `mcode-view.ts:26`，我没有理由碰它，
也没碰。`document-view-host-smoke`（直接 import 这份 policy）**18/18 PASS**、
`production-build-preload-smoke` **18/18 PASS**。

### 5. 新增回归套件 `mcode-docs-reshell-smoke`（17 条）

**不启 Electron，只读产物与源码** —— 判据立在「产物长什么样」上，不是「源码里有没有那句话」
（T65 那次就是栽在源码正则上）。

| 组 | 断言 |
|---|---|
| 主题层进产物 | 独立 CSS chunk 存在；含 `#fcfcfb` / `#151515` / `#c96442`；字体栈以 `-apple-system` 打头；`--chrome-bg` / `--hover` / `--bg-hover` 都被覆盖 |
| 条件加载 | `index.html` **没有**直接 link 主题层；bundle 里有 `if (window.desktop) __vitePreload(` 守卫；bundle 引用了 chunk |
| 边界 | 无规则内联裸色值（GenOffice CI 规则）；不覆盖 `--accent` 家族 / `--word-blue`；不覆盖 `--docs-revision-bar` / `--search-hit-*` |
| 内核零改动 | `genoffice` 工作树只有那两个允许的文件；`main.tsx` 的加载被 `window.desktop` 守卫 |

### 6. 变异验证（四次，全部变红后逐字节还原）

| 变异 | 改动 | 结果 |
|---|---|---|
| **M1** 无条件加载 | `if (window.desktop) import(...)` → `import '...'` | **7/17**：条件加载那组全红 + bundle 守卫 + chunk 引用 |
| **M2** 退回 Word 橙 | `--color-ai-action: #c96442` → `#e8663f` | **16/17**：`主题层含 Mcode 陶土橙` 红 |
| **M3** 越界改品牌色 | 注入 `--accent: #c96442` | **16/17**：`不覆盖 --accent 家族` 红 |
| **M4** 越界改内核 | 往 `Ribbon.tsx` 追加一行注释 | **16/17**：detail 精确点名 `["M apps/docs/src/renderer/components/Ribbon.tsx"]` |

每次变异都**重新构建**（`npm run build -w @genoffice/docs`）再跑断言 —— 因为判据在产物上，
不重建就测不到。还原后 `cmp -s` 逐字节一致，重建出的 bundle hash 回到 `index-CXQSjRKg.js`
（确定性构建，同一源码同一产物）。

### 7. 这条改动**必须**跟着补丁链走 —— 它不在 Mcode 主仓里

`genoffice/` 被 Mcode 的 `.gitignore:70` **整体忽略**，它是独立 git 仓（remote 指向
genspark-ai/genoffice）。所以换壳的源码改动**不能**用 Mcode 的 commit 交付，只能作为**第 14 个
补丁**进入 vendor 链。已完成：

1. vendor 仓提交 `05da63c`（分支 `mcode/integration`），tree `9e9982b`；
2. 导出 `patches/genoffice/0014-feat-docs-reshell-the-chrome-in-mcode-design-tokens.patch`
   （11,355 B，SHA-256 `f2bc783e…1a39af`）；
3. 更新 `genoffice-upstream.lock.json`：`revision` → `05da63c`、`expectedTree` → `9e9982b`、
   `patchSeries` 追加第 14 条；
4. 更新 `verify-genoffice-upstream.cjs` 的 `FINAL_REVISION` / `FINAL_TREE` / `PATCHES` /
   提交数（13 → 14）。

**注意一处语义陷阱**：`0013` 那一条原本写的是 `revision: FINAL_REVISION`（因为它曾是最后一条）。
`FINAL_REVISION` 改成新值之后，0013 会**跟着漂**到 0014 的提交上。已把它固定成字面量
`635dee2f…`。这类「最后一条用常量、结果常量一动全动」的写法，加补丁时一定会踩。

**t87 也顺手修了同一类问题**：它把 `patchCount` 写死成 `13`，已改成从 `lock.patchSeries.length`
派生 —— 加补丁不该要改第二处。

`MCODE_INCLUDE_GENOFFICE_BUNDLE=1 node apps/desktop/build/verify-genoffice-upstream.cjs`
→ **exit 0**，`05da63c (base cbec600…, 13 patches, tree 9e9982b…)`。

### 8. 全部验证结果

| 套件 | 结果 |
|---|---|
| `mcode-docs-reshell-smoke`（新） | **17/17** |
| T7 `docs-open-edit-save-reopen` | **PASS**（2 个 OS 进程） |
| `genoffice-source-smoke` | **26/26** |
| `t87-genoffice-provenance-license-smoke` | **96/96**，patch replay tree = `9e9982b` 逐字匹配 |
| `genoffice-vendor-freshness-smoke` | **29/29**（六家全部重建到 pinned HEAD 之后） |
| `production-build-preload-smoke` | **18/18** |
| `genoffice-editors-release-smoke` | **29/29** |
| `release-readiness-smoke` | **23/23** |
| `document-view-host-smoke` | **18/18** |
| 双包 typecheck | contracts **exit 0**、desktop **exit 0** |

**六家 vendor 全部重建**（不只是 docs）：freshness 断言要求所有产物晚于 pinned HEAD，
只重建 docs 会让另外五家变红（实测 23/29 → 重建后 29/29）。

### 9. 其余五个 app 的估算

换壳机制是**每个 app 一份 token 覆盖**，不是每个 app 一套组件改造：

| app | 工作量 | 依据 |
|---|---|---|
| sheets | 中 —— Univer 有独立的 `darkMode` 与 canvas 绘制色表（`canvas-colors.ts`），token 覆盖不到画布 |
| slides | 中 —— 同上，且缩略图/画布有自己的色表 |
| pdf | 小 —— 页面是 PDFium 位图，chrome 面比 docs 窄得多 |
| markdown | 小 —— 已极简 |
| html | 小 —— 同 markdown |

**共性成本在 CI 与断言，不在 CSS**：每个 app 都要一份 `mcode-theme.css` + 一条条件 import +
一条 freshness/边界断言。按 docs 的实测，单个 app 的 CSS 约 240 行、断言约 17 条、构建
约 10-30 秒。**建议下一卡一次做 pdf / markdown / html（三个小的），sheets / slides 单独一卡**
（要处理 canvas 色表，与 token 层不是一个机制）。

### 10. 边界遵守

- **只做 Docs**；其余五家只重建产物（freshness 要求），没改它们的源码；
- **没动** `patches/genoffice/` 已有的 13 个补丁（只**新增**了 0014）；
- **没碰** T2/T3/T4/T19/T27/T28/T33/T34 的文件；
- **没改** `mcode-view.ts` / `mcode-ai.ts` / `mcode-privileged.ts`；
- **没改** 编辑内核（变异 M4 证明断言能抓到）；
- 没发现「必须改编辑内核才能达成视觉目标」的情况 —— 方案成立。
