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

## 结果回写（2026-10-23，E 会话）

### 一、可行性表

| # | 反模式 | 结论 | 判据 | 强度 |
|---|---|---|---|---|
| 1 | 卡片左侧细竖条 / 顶部色条 | ✅ **做** | 竖条 `w<24 && h≥64`；顶部条 `h<24 && w≥64` **且贴在某张卡片上沿** | 强 |
| 2 | 彩虹卡片 | ✅ **做** | 同页**非中性**填充色 > 2 | 强 |
| 3 | 装饰性角落方块 | ❌ **不做** | 无法从结构区分「装饰」与「功能性色块」（封面大色块锚点、强调角标都是合法设计） | — |
| 4 | 每页都是「形状+粗副标题+描述」 | ✅ **做（弱）** | 连续 ≥3 页 `layout + 元素类型序列` 相同 | 弱（warning） |
| 5 | 封面是平标题+副标题 | ✅ **做** | 封面无面积 ≥12% 锚点、无 ≥60pt 大字、无 ≥12% 大图 | 强 |
| 6 | 全篇统一页眉条 | ✅ **做（弱）** | ≥3 页同一位置同尺寸（±4px）的扁条（h<80） | 弱（warning） |
| 7 | 两行说同一件事 | ❌ **不做** | 需要语义理解，Mcode 侧做不到 | — |
| — | **留白过度**（T62 缺口） | ✅ **做** | 内容底边 / 画布高，**按页型分档** | 强（阈值经验值） |

### 二、留白判据：我试错了两次，数据推翻了两个候选

**候选 1：元素面积占画布比** —— 总控已经试过，**不成立**（空柱子 57.3% vs 干净封面 61.8%）。

**候选 2：文字占它所在卡片的比例** —— 我实测，**同样不成立，而且方向是反的**：

```
T62 真实 deck：
  修复后（好的）  卡片文字填充 = 0.535
  修复前（空柱）  卡片文字填充 = 0.787   ← 更高！
```

**因为修复前卡片矮，文字自然占的比例更高。** 用这个判据会把好的判成坏的。

**成立的候选 3：内容底边 / 画布高**，实测同一份 deck：

```
封面          1.000   （满版色块）
内容页 好      0.872
内容页 空柱    0.667   ← 问题所在
KPI 页        0.833
收尾页        0.653   ← 设计意图，不该报
```

**所以必须按页型分档**：`content`/`data` 要求 ≥ **80%**，`cover`/`closing` 放宽到 **55%**。这两个数字来自上面这组实测，不是拍的。

这条是 **warning 而不是 error** —— 阈值是经验的，消息里写「只铺到 X%」而不是「一定丑」，让模型自己判断。

### 三、放在哪一层（论证）

**独立纯模块 `document/deckPatternCheck.ts`，不挂 `DOCUMENT_QA_GATES`。**

理由：`DOCUMENT_QA_GATES` 是**文件级**门禁（对 .docx/.pptx 跑 CLI 命令，`check`/`audit`/`render-probe`）。反模式检查算的是**页面描述本身的结构** ——

- 不需要真文件、不需要渲染器、不需要 Electron；
- 改 spec 的那一刻就能查，不必等 build；
- 纯函数，套件零依赖就能测。

**没有暴露成 `document_check_patterns` 工具**：卡上写「若需暴露」，我判断**现在不该暴露** —— 模型每写一页就能自己看到这些问题，多一个工具反而增加它要读的 schema。若将来要接进门禁，`checkDeckPatterns()` 是可以直接调的纯函数。

### 四、正控 / 负控（22 条断言，每条判据都有配对）

| 判据 | 正控（合规不报） | 负控（违规必报） |
|---|---|---|
| 细竖条 | 合规页不报 | `6×200` 竖条被报 |
| 顶部色条**误报防护** | 页脚分隔线（h=1，不贴卡片）不报 | —— |
| 彩虹卡片 | 两个强调色不报 | 三个非中性色被报 |
| 留白 | 铺满的内容页不报；**closing 65% 不报**（分档） | 内容只到 60% 被报；**closing 只到 30% 被报** |
| 构图雷同 | **两页同构不报**（阈值 3） | 三页同构被报 |
| 平面封面 | 有大色块锚点不报 | 平标题+副标题被报 |
| 页眉条 | 各页不同不报 | 每页同位置被报 |

**额外三条「不假装」**：`NOT_IMPLEMENTED` 的三个键都断言了「不在 `applied` 里」（不假装查过）+ 「有说明理由」。

### 五、变异证据

**逐条**撤掉判据（每次从 pristine 重置），对应负控全部变红：

```
accent-bar: rc=1 red=1   FAIL ★ 负控：细竖条被报出来
rainbow:    rc=1 red=1   FAIL ★ 负控：三个非中性色被报
whitespace: rc=1 red=2   FAIL ★ 负控：内容只到 60%；closing 只到 30%
repeated:   rc=1 red=1   FAIL ★ 负控：三页同构被报
flat-cover: rc=1 red=1   FAIL ★ 负控：平标题+副标题被报
header-bar: rc=1 red=1   FAIL ★ 负控：每页同位置页眉条被报
RESTORED: byte-identical
FINAL: rc=0
```

**每条都只红它自己的负控** —— 说明判据之间没有互相串味。

### 六、⚠️ 变异验证过程中我踩的坑（值得写下来）

前三次变异脚本**全部失败而我没察觉**：

1. `bash` 解析到 `C:\Windows\System32\bash.exe`（WSL shim），返回 **rc=127**（命令找不到）；
2. 我第一版脚本只看 `rc == 0` 判绿，**127 不是 0，但我只数了 FAIL 行数 = 0，误以为"撤掉后没红"**；
3. **更糟**：脚本在异常退出前已经把源文件写成了变异态，而**下一次运行又从变异态出发** —— 累积下来 `checkAccentBars` / `checkRainbow` 的调用行被永久删掉，而我看到的是「负控一直是红的」却以为那是正常的。

**根因与 T65 卡里记的那个坑同源，但形态又新了一层**：不是「断言在写文件前炸」，而是「**脚本中途失败、下一轮从脏状态继续**」。

**修正**：每次变异前从 `pristine` 重新写入 + 用 Git Bash 绝对路径 + 显式检查 `rc == 1`（不是 `!= 0`）+ 收尾再跑一次确认绿。

### 七、验证

- `t65-deck-pattern-smoke` **22/22**（提交后复跑仍 22/22）
- `t43-document-ai-design-pipeline-smoke` **57/57**（不回归）
- `t47-design-guide-smoke` **27/27**（不回归）
- 双包 typecheck 通过
- **没跑全量、没起 Electron**

### 八、未做 / 需要知道的

1. **三条判据如实标 not-implemented**（装饰角落方块 / 两行同义 / 混用量纲），理由写在 `NOT_IMPLEMENTED` 里，并且断言了它们**不出现在 `applied`** —— 不留假检查。
2. **没有接进模型工具面**（见第三节论证）。
3. **阈值是经验值**：80%/55% 来自 T62 那一份 deck 的实测。样本量是 1 份 deck、5 个页面。**更多真实 deck 可能推翻这两个数** —— 建议后续拿 T63 的回归集校准。
