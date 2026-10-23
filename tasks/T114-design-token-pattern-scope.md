# T114｜`design-tokens-smoke` 那条判据只认一种写法

- Status: ready-for-agent
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
