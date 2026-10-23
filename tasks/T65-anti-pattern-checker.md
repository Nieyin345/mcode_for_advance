# T65｜反模式检查器：把规范里的 7 条「treat as defects」变成可执行判据

- Status: ready-for-agent
- Category: **feature（P0 产品能力）**
- Priority: **P0 —— 这是「AI 做 PPT 又烂又丑」里唯一还能在 Mcode 侧解决的部分**
- Depends on: T62（`0c02692e`，端到端验收发现问题）、T43（`0a2aa805`）、T47（`0bf8a957`）
- Exclusive writable files: `apps/desktop/src/main/document/`（新模块）、`apps/desktop/src/main/appControl/tools.ts`（若需暴露）、新建套件。

## Required Skills
- `codebase-design`: 判断检查器放在哪一层（`documentToolRuntime` 的门禁？还是独立模块？）。
- `mcode-smoke`: 无头回归 + **正控/负控配对**。

Read before work: `CLAUDE.md`（**「任何断言的价值都不超过它取证方法的正确性」与「对照组」两节**）、`tasks/T62-doc-ai-end-to-end-acceptance.md` 回写区 §5、`tasks/T63-deck-quality-regression.md`、`genoffice/skills/genoffice/SKILL.md` 的 `## 4. Anti-patterns (treat as defects)` 全节。

## 背景：E 的 T62 发现了什么

**链路全通，规范也被写进了上游检查器**（`offPalette` / `Overlap` / `Text overflow` / `outline.findings` 全都会报）。

**但 E 的原话**：

> **`audit` 能抓出界、溢出、重叠，但抓不到「卡片下半截空着」。** 我那三根「空柱子」在所有检查里都是零问题。而规范第 3 节明写「Fill the page」，**这条没被实现成检查**。
> **后果**：模型按规范写 deck，仍可能产出大量留白的页面，而所有检查都绿。**这正是用户抱怨的「又烂又丑」里最常见的一种。**

## 关键判断：这块**能做**，因为判据从 spec 算得出来

上游 `audit` 的能力边界是它自己的事。**但规范里的 7 条反模式，大部分是 spec 的结构问题，Mcode 侧能算。**

规范原文（`guide slides design` 的 `## 4. Anti-patterns`）：

```
- A thin vertical accent bar on the left of every card, a colored bar on top of cards,
  a small bar left of titles. Express hierarchy with background, weight and size contrast.
- Rainbow cards: a different accent per item.
- Decorative corner blocks or short lines; decoration that moves around from page to page.
- Every page as "shape + bold subtitle + description" list. The cover must not be a flat
  title plus subtitle: give it a visual anchor (a large color block, a geometric
  composition, a huge number, a hero image).
- A deck-wide header bar with the page title on every page. Vary the composition.
- Sibling cards whose hero numbers mix metrics (a market share next to a price next to a
  count): one row, one unit, one source. A number's label must say exactly what the
  source measured.
- Two lines that say the same thing: a subtitle that restates the chart caption, a
  takeaway that repeats a bullet.
```

## 目标

**实现一个 spec 级的反模式检查器**，覆盖能从结构算出来的那几条。

### 建议的判据（逐条论证可行性，做不到的如实说）

| # | 反模式 | 能否从 spec 算 | 判据草案 |
|---|---|---|---|
| 1 | 卡片左侧细竖条 / 顶部色条 | ✅ | 找 `w < 20px 且 h > 100px` 的 rect（细竖条）或 `h < 20px 且 w > 100px`（顶部条） |
| 2 | 彩虹卡片：每项一个强调色 | ✅ | 同一页里出现的不同填充色 > 2 个（黑白除外） |
| 3 | 装饰性角落方块 | ⚠️ 难 | 角落区域的小 rect，但「装饰」vs「功能」难分——**如实说做不到，或者给出保守判据** |
| 4 | 每页都是「形状 + 粗副标题 + 描述」 | ✅ | 逐页统计「headline + 卡片阵列」这个组合，连续 N 页相同 → 报 |
| 5 | 封面是平标题 + 副标题 | ✅ | 封面页的元素里没有 `w*h > 画布 20%` 的视觉锚点（大色块 / 大数字 / 大图） |
| 6 | 全篇统一页眉条 | ✅ | 每页都有同一位置的同一个 rect → 报 |
| 7 | 两行说同一件事 | ❌ | **需要语义理解，Mcode 侧做不到**——如实说 |
| — | **留白过度**（E 发现的缺口） | ⚠️ | 我刚试过「元素面积占画布比」：**三根空柱子的 57.3% 比干净封面的 61.8% 还低一点，判不出来**。真判据要看「文字占它所在卡片的比例」 |

### 硬要求

1. **每条判据必须有正控 + 负控配对**：
   - 正控：合规 spec → 不报；
   - **负控：故意违反 → 必须报**（这条是判别力的证明）。
2. **做不到的判据如实标 `not-implemented`**，并说明为什么（**不要写一个永远返回空的假检查**）。
3. **放在哪一层要论证**：
   - 挂到 `documentToolCall` 的门禁里（编辑后自动跑）？
   - 还是独立的 `document_check_patterns` 工具（模型主动调）？
   - **参考 `DOCUMENT_QA_GATES` 的现有形状**。

## 验收判据

1. **回写区先给可行性表**：7 条 + 留白，逐条标「能做 / 做不到」，做不到的说明理由。
2. **做出来的每条都有正控 + 负控**。
3. **变异验证**：撤掉某条判据 → 对应负控必须红 → `cmp` 还原。
4. **不假装**：如果某条只能做弱版本（比如「疑似」而不是「确定」），如实标注，不要把它当确定缺陷报给模型。
5. T43 的 57/57、T47 的 27/27 不回归。
6. 双包 typecheck 通过。
7. **不跑全量**、**不起 Electron**。

## 边界

- 改 `apps/desktop/src/main/document/`（新模块）、`appControl/tools.ts`（若需暴露）、新建套件；
- **不改 `genoffice/` 上游**（那是 vendor 快照）；
- **不碰** `policy.ts`、`ipc/index.ts`、`renderer/`；
- **不碰** T43 的套件（它是别人的产物，只引用不修改）。

## 遇到问题先检索

`genoffice guide slides design` 的原文就是需求文档，**先读它**。
spec 的字段定义跑 `genoffice guide slides spec`。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**

## 回写

`tasks/T65-anti-pattern-checker.md` 末尾追加 `## 结果回写（2026-10-23）`：可行性表、每条的判据与正负控、变异证据、未做的、提交 SHA。
