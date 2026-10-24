# T114｜`design-tokens-smoke` 那条判据只认一种写法

- Status: **part-done（判据完成，产品代码待 T116）** —— 判据部分已完成并验证（`2f2bebc9`）
- Category: **P1 测试判别力（判据的范围小于它声称的范围）**
- Priority: **P1 —— 「选中态不许用品牌淡底」这条设计规范，实际只抓到了 1/4 的写法**
- Depends on: E 的 T111（`2f783ef7`，详情视图）；E 的 `design-tokens` 修（`f9854a8c`）
- Exclusive writable files:
  - `apps/desktop/scripts/design-tokens-smoke/main.ts`（那条判据）

## Required Skills
- `mcode-smoke`：判别力验证 + 变异。

## 背景：E 在核对覆盖时发现的（总控已用 grep 核实）

**判据原文**（`design-tokens-smoke/main.ts:975`）：

```ts
if (/bg-accent\/15 text-accent/.test(src) && !ACTIVE_ACCENT_ALLOWED.some((a) => rel.endsWith(a))) {
  offenders.push(rel);
}
```

**它匹配的是「`bg-accent/15` 后面紧跟一个空格和 `text-accent`」这个精确组合。**

### 实测：全仓有大量同一违规的其他写法，判据一个都抓不到

| 文件:行 | 写法 | 被抓住？ |
|---|---|---|
| `chat/ActivityConsole.tsx:447` | `bg-accent/15 text-accent-strong` | ❌ **`text-accent-strong` ≠ `text-accent`** |
| `chat/AskChoiceDialog.tsx:186` | `border-accent bg-accent/15 text-content` | ❌ |
| `chat/BranchChoiceCard.tsx:127` | `border-accent bg-accent/15 text-content` | ❌ |
| `chat/BranchChoiceCard.tsx:165` | `... bg-accent/15 text-content hover:bg-accent/25` | ❌ |
| `chat/FileMentionPicker.tsx:443` | `bg-accent/15 text-content ring-1 ...` | ❌ |
| `chat/PlanViewer.tsx:243` | `bg-accent/15 text-accent hover:bg-accent/25` | ✅（子串命中） |

**而 `MessageTimeline.tsx:274` / `ModelDropdown.tsx:390` 那些 `bg-accent/15 ... text-accent` 是被空格隔开的多个类** —— 它们**在同一个 `className` 字符串里**，但中间还有 `px-1 py-0.5 text-[9px] font-bold`。

**所以这条判据的形状是**：**「两个类碰巧连在一起」才报。**

## 这不是「判据太宽」，是「判据的范围被写成了字面量」

**它想说的是**：「选中/开关态不许用 `bg-accent/15` 这类品牌淡底」。

**它实际说的是**：「文件里出现 `bg-accent/15 text-accent` 这个精确字符串」。

**两者差得很远** —— 而 `ACTIVE_ACCENT_ALLOWED` 白名单的存在**说明作者知道有例外**，只是例外的判据（按文件路径白名单）和主判据（字面量组合）的粒度不匹配。

## 任务

### 一、先判断：真违规有多少？

**上面那六处里，哪些是「选中态用品牌淡底」的真违规，哪些是合理的？**

| 判定 | 依据 |
|---|---|
| `AskChoiceDialog` / `BranchChoiceCard` 的 `border-accent bg-accent/15 text-content` | **可能是选项的选中态** → 违规（或该进白名单） |
| `ActivityConsole` 的 `bg-accent/15 text-accent-strong` | **可能是「当前」标记** → 需要看上下文 |
| `FileMentionPicker` 的 `ring-accent/40` | **可能是聚焦** → 不是选中态 |

**逐个看上下文，给出「真违规 / 合理 / 该进白名单」的判定。**

**⚠️ 这一步不要跳过。** 判据收紧之前，**你不知道会红多少条**，而**如果一下红 8 条，那可能说明这条规范本身没被贯彻**，而不是「补个正则」。

### 二、按判定结果决定改判据还是改代码

### ⚠️ E 的建议（总控采纳，写进卡）：放宽正则不是正确方向

> 那四处漏网的写法**都不是 bug，是合法的 Tailwind 组合**。所以修法不是「把正则放宽到能匹配它们」，而是**改为「同一个元素上出现过 `bg-accent/\d+` 且它不是允许的那几类信号」** —— 判据应该从「两个类连在一起」升级成「按元素/按字符串分段看」。
> **否则放宽正则只会把 `text-accent-strong` 这类合法变体也一起放过，判据仍然窄，只是窄得不一样。**

**这条是本卡最重要的约束。** 一个匹配 `bg-accent/\d+` 的正则**会把 `MessageTimeline` 的「当前」徽标、`ModelDropdown` 的 「1M」标记全都报出来** —— 那些是合理的。

**所以正确的形状是「按元素分段」**：从 `className` 字符串里切出**同一个元素的类集合**，然后判断这个集合里有没有「品牌淡底 + 它是选中态语义」。

**如果做不到（Tailwind 的类在运行时才拼，静态切分不可靠）** → **那就把判据缩小到「能可靠判定的形状」，并把局限写进判据名字，再加一条负控证明它抓不到什么。**

**如果大部分是「合理的」** → **判据该考虑的是「选中态」这个语义，而不是「哪个类跟着哪个类」**。

**这可能意味着**：**光靠正则做不了这条判据**。那就**把范围缩小到「能可靠判定的形状」**，并在判据的注释里**写清它不覆盖什么**（`CLAUDE.md` 第十二条：能力有限不是问题，不告诉使用者才是问题）。

**如果大部分是「真违规」** → 改代码，而不是改判据。

**你判断，并把理由写进回写。**

### 三、⚠️ 无论哪种，都要给判据写清「它覆盖什么、不覆盖什么」

**现在的判据名字是**：

```
★ 选中/开关态不再使用 bg-accent/15 品牌淡底
```

**这个名字声称的范围** = 「选中/开关态」。
**实际范围** = 「`bg-accent/15` 紧跟 `text-accent`」。

**改成**：

```
★ 选中/开关态不再使用 bg-accent/15（只认紧邻的 text-accent 组合；其他组合未覆盖）
```

**或者更好**：**加一条负控断言，明确「这条判据抓不到 `border-accent bg-accent/15 text-content`」**，让「覆盖到什么程度」变成可执行的事实。

**我倾向后者** —— 因为**一条写着局限的判据，仍然会让人以为局限之外已经验过了**。而**一条负控断言会红**。

## 验收判据

1. **六处的逐个判定**（真违规 / 合理 / 该进白名单），每处有上下文依据。
2. **判据的范围和它的名字一致**（改判据、改名字、或加负控三者之一）。
3. **如果改了代码**：每处都有「改前违规 / 改后合规」的证据。
4. **判别力验证**：构造一个「`border-accent bg-accent/15 text-content` 出现在未白名单文件」的样本 → 断言必须红（如果判据已放宽）。
5. **旧行为不回归**：`TaskCenterPanel` 那个已被修的组合（`bg-accent/15 text-accent`）如果塞回去，仍然红。
6. 不跑全量、不起 Electron。

## 边界

- **只改 `design-tokens-smoke/main.ts` 的那一条判据** + 可能的 `ACTIVE_ACCENT_ALLOWED`；
- **如果判定要改产品代码**：**报告给我，我另开卡** —— 那会跨多个文件（`AskChoiceDialog` / `BranchChoiceCard` / `ActivityConsole` / `FileMentionPicker`），而这张卡只该解决「判据」问题；
- **不改 `TaskCenterPanel.tsx`**（E 刚交付）。

## ⚠️ 这条和 T113 是同一类问题的两种形态

| 卡 | 断言的声称 | 实际 |
|---|---|---|
| T113 | 「撤权后不执行」 | 「撤权能不能赶上」 |
| **T114** | 「选中态不许用品牌淡底」 | **「两个类是否紧邻」** |

**共同点：断言的判据范围小于它名字声称的范围。**

**T113 的形态是时序，T114 的形态是字面量。**

## 遇到问题先检索

```bash
grep -n "bg-accent/15" apps/desktop/src/renderer/components/ -r --include=*.tsx | head -20
sed -n '940,985p' apps/desktop/scripts/design-tokens-smoke/main.ts
grep -n "ACTIVE_ACCENT_ALLOWED" -A 20 apps/desktop/scripts/design-tokens-smoke/main.ts
```

## 回写

`tasks/T114-design-token-pattern-scope.md` 末尾追加 `## 结果回写（2026-10-24）`：
六处逐个判定、判据改成什么形状、判别力验证、旧行为不回归、提交 SHA。

## 结果回写（2026-10-24）

### 结论先行：**判据改成「按 className 表达式分段」，它现在红了 6 个文件 —— 那是真违规**

`design-tokens-smoke`：**344 ok / 1 FAIL**。那条 FAIL 是新的选中态判据报出 6 个文件。
**不是判据误报，是这条设计规范在仓里确实没被贯彻。**

按卡上边界，**改产品代码要你另开卡**，我停在这里。

### 一、六处（实际是八处）逐个判定

先纠正卡上的数量：全仓 `bg-accent/15` 共 **32 处**，比卡上列的六处多。按「条件驱动 / 无驱动」分开后：

| 文件:行 | 写法 | 判定 | 依据 |
|---|---|---|---|
| `chat/AskChoiceDialog.tsx:186` | `picked === o.id ? "border-accent bg-accent/15 text-content"` | ✅ **真违规** | 选项按钮的选中态 |
| `chat/BranchChoiceCard.tsx:127` | 同上（`picked === o.id`） | ✅ **真违规** | 选项选中态 |
| `chat/BranchChoiceCard.tsx:165` | `picked.length === 0 \|\| busy ? … : "…bg-accent/15…"` | ✅ **合理** | **确认按钮可用态**，不是选中态 |
| `chat/FileMentionPicker.tsx:443` | `isActive ? "bg-accent/15 text-content ring-1 ring-inset ring-accent/40"` | ✅ **真违规** | 键盘高亮行 = 当前选中项 |
| `chat/SlashCommandPicker.tsx:314` | 同上（`isActive`） | ✅ **真违规** | 同上 |
| `ide/FileTree.tsx:1336` | `active ? "bg-accent/15 text-content"` | ✅ **真违规** | 当前文件 |
| `ide/SearchDialog.tsx:647` | `isActive ? "bg-accent/15 text-content"` | ✅ **真违规** | 结果高亮行 |
| `ide/SearchDialog.tsx:778` | 同上（另一段结果列表） | ✅ **真违规** | 同上 |
| `chat/ActivityConsole.tsx:447` | `latest ? "bg-accent/15 text-accent-strong"` | ✅ **合理** | 最新一行 = 运行/注意信号（已白名单） |
| `chat/PlanViewer.tsx:243` | `dirty ? "bg-accent/15 text-accent hover:bg-accent/25"` | ✅ **合理** | **保存按钮可执行态**（已白名单） |
| `chat/PlanStreamBlock.tsx:82` | `hasApproval ? "bg-accent/15 text-accent"` | ✅ **合理** | 待审批 = 注意信号（已白名单） |
| `chat/PlanViewer.tsx:334` / `ide/FileEditor.tsx:1694` | `saveState === "saved" && …` | ✅ **合理** | 保存成功提示 |
| `chat/activityShared.ts:57` / `ide/turnFlowModel.ts:239` / `ide/TurnFlowPanel.tsx:518` / `mobile/MobileGitScreen.tsx:62` | 静态分类色 | ✅ **合理** | 分类身份色（已白名单） |
| `settings/CustomModelsPanel.tsx:1572` | `bridge?.paired ? …` | ✅ **合理** | 桥接连接状态（已白名单） |
| 其余 15 处 | 无条件静态类 | ✅ **合理** | 全是徽标/提示（当前、1M、待审、自定义、活动数…） |

**真违规 8 处，涉及 6 个文件**（`AskChoiceDialog` / `BranchChoiceCard` / `FileMentionPicker` / `SlashCommandPicker` / `FileTree` / `SearchDialog`）。

### 二、判据改成了什么形状

**没有放宽正则。** 按你的方向「按元素分段」实现，只认**能静态可靠判定**的两种形状：

1. **相等比较驱动**：`picked === o.id` → 选中了某一项。
   - 排除与「空/布尔/undefined/数量」比较：`picked.length === 0`、`x === undefined`、`s === ""`。
   - 右侧**允许非空字符串字面量**（`mode === "select"`）—— 这条是判别力验证抓出来的：我第一版用 `[\w$.]+` 匹配右侧，`picked === "a"` 判不出来。
2. **布尔标识符驱动**：`active` / `isActive` / `isSelected` / `isPicked` / `activeIdx` / `currentIdx`。

**关键区分（实测）**：`BranchChoiceCard:127`（`picked === o.id`，选中）与 `:165`（`picked.length === 0`，可用）**能被静态分开**。

### 三、判别力怎么证（三层，缺一不可）

**① 正控**：`picked === o.id ? "…bg-accent/15…"` 必须被抓 —— ✅ 通过。

**② 负控**（三条，把「不覆盖什么」变成会红的断言）：
- `picked.length === 0`（按钮可用）不报 —— ✅
- `latest ? …`（运行中信号）不报 —— ✅
- 无驱动静态类 `className={…}` 不报 —— ✅
- **并且**加了一条明说不覆盖的断言：纯字符串 `className="…"` **不在扫描范围**（`classNameBlocks` 只找 `className={`），所以那一形状里的选中态这条判据看不见。

**③ 注入样本**：往 `src/renderer/components/` 写一个 `.tsx` 真文件（`picked === "a" ? "border-accent bg-accent/15 text-content"`），跑真实套件 → **它出现在 offenders 列表里**；删掉后消失。

**这一步抓到了判据自己的两个 bug**（都不是我事后想出来的，是它们让样本没红才发现的）：
1. 抹除 `bg-accent/15` 时用了 `bg-accent\/15[^"'`]*`，**贪心吃到下一个引号**，把其它分支里的 `===` 一起删了；
2. 相等比较右侧用 `[\w$.]+`，**匹配不到字符串字面量**。

### 四、旧行为不回归（变异）

把 `TaskCenterPanel` 的筛选条从
`active ? "border-edge bg-surface-muted text-content"` 改回 `active ? "bg-accent/15 text-accent"`：

- **旧形状判据**：红（`TaskCenterPanel.tsx`）✅
- **新判据**：第一版**没红** —— 因为 `active` 不在布尔名单里。补进名单后红 ✅

**补 `active` 之前先数了一遍**：全仓「含 `bg-accent/15` 且表达式里有裸 `active`」只有 2 处（`FileTree` 当前文件、`TaskCenterPanel` 筛选条），**都是真选中态，无误报**。
`TaskCenterPanel.tsx` 已逐字节还原（`bebf31c5…`，`git diff` 为空）。

### 五、未做 / 需要你决定

1. **6 个文件的产品代码没改** —— 按卡上边界，那是另一张卡。**如果这 6 处都要改，`design-tokens-smoke` 会一直红着。**
   要么另开卡改代码，要么把这 6 个文件加进 `ACTIVE_ACCENT_ALLOWED` 并注明理由（**我不建议后者** —— 它们是真选中态，加白名单等于承认规范作废）。
2. **没有把所有 32 处都写成断言** —— 负控只覆盖了 3 类代表形状。剩下的是「同类不同处」，不是不同类。
3. **`bg-accent/10` 那条判据没动** —— 它是另一条，范围问题同族，但不在本卡边界内。
4. **没跑全量**（按卡要求）。只跑了 `design-tokens-smoke` + `tsc --noEmit`（对 `scripts/design-tokens-smoke` 无错误）。
