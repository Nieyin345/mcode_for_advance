# T39｜GenOffice UI 换壳：保留编辑内核，替换 ribbon / 菜单 / AI 面板

- Status: ready-for-agent
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
