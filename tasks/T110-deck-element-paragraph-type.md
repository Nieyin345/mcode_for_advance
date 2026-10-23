# T110｜`DeckElement.paragraphs` 的类型漏了上游规范里的一等字段

- Status: ready-for-agent
- Category: **P1 类型缺陷（唯一一条让 `tsc` 不干净的错误）**
- Priority: **P1 —— 不阻塞 smoke，但让「双包 typecheck 干净」这条验收标准永远不成立**
- Depends on: T100b（`483eb29e`，引入了那个 `as DeckElement`）
- Exclusive writable files:
  - `apps/desktop/src/main/document/deckPatternCheck.ts`（只改类型定义）
  - `apps/desktop/scripts/t65-deck-pattern-smoke/main.ts`

## Required Skills
- `mcode-smoke`：类型改动后确认断言不变。
- `codebase-design`：判断哪些字段该进类型、哪些不该。

## 现象

```bash
$ npx tsc --noEmit -p apps/desktop/tsconfig.json
EXIT=2
scripts/t65-deck-pattern-smoke/main.ts(395,24): error TS2352:
  Conversion of type '{ paragraphs: { align: string; runs: [...] }[]; ... }'
  to type 'DeckElement' may be a mistake ...
  'align' does not exist in type '{ runs?: [...] }'
```

**这是当前唯一的 typecheck 错误。**

## 根因：不是测试写错，是生产类型漏了字段

`deckPatternCheck.ts:58`：

```ts
paragraphs?: Array<{ runs?: Array<{ text?: string; sizePt?: number }> }>;
```

**上游规范里 `align` 是 paragraph 的一等字段**：

```bash
$ node genoffice/packages/cli/dist/genoffice.cjs guide slides spec
```

第 59 行（shape 的示例）：

```json
"paragraphs": [
  { "align": "center", "runs": [{ "text": "Label", "sizePt": 14, "color": "#FFFFFF" }] }
]
```

第 76-84 行（text 元素）：

```json
"paragraphs": [
  { "align": "left", "lineSpacingPct": 110, "spaceAfterPt": 6, "bullet": false,
    "runs": [{ "text": "Headline", ... }] }
]
```

**所以 `align` / `lineSpacingPct` / `spaceAfterPt` / `bullet` 都是合法输入，而类型里一个都没有。**

## `483eb29e` 当时是怎么绕过去的

那个提交加了 `import type { DeckElement }`，然后在测试里写：

```ts
paragraphs: [{ align: "center", runs: [{ text: "标签", sizePt: 24 }] }] } as DeckElement,
```

**`as` 把类型检查关掉了。** 而那个提交的信息里写着：

> **`DeckElement` gains `valign` so the code no longer casts around the type.**

**`valign` 加上了，但 `paragraphs.align` 没有** —— 所以那个 `as` 留了下来，**它是现在 `tsc` 红的原因。**

## 任务

### 一、照上游规范补全 `paragraphs` 的类型

**⚠️ 不要照下面这份写** —— 这是我从规范示例里读到的字段，**你要自己去跑 `genoffice guide slides spec` 逐个核实**，尤其是 `runs` 支持哪些（示例里有 `color`，`bold` / `italic` 我没验）。

**待核实清单**：

| 字段 | 在哪见的 | 核实方法 |
|---|---|---|
| `align` | shape 示例 + text 示例 | `guide slides spec` 第 59、78 行 |
| `lineSpacingPct` | text 示例 | 第 79 行 |
| `spaceAfterPt` | text 示例 | 第 80 行 |
| `bullet` | text 示例 | 第 81 行 |
| `runs[].color` | shape 示例 | 第 59 行 |
| `runs[].bold` / `italic` | **未验** | 自己查 |

**还有一个该问的问题**：**`text` 元素的 `paragraphs` 和 `shape` 的是同一个类型吗？** 如果上游有两套，**Mcode 侧的类型该不该分成两个**？

**你判断。** 如果它们确实不同，`paragraphs` 补成两套比补成一个大而全的更准确。

### 二、补完之后删掉测试里的 `as DeckElement`

**判据**：**删掉 `as` 之后 `tsc` 仍然 EXIT=0。** 如果还红，说明还有字段没补，**继续按规范补齐，不要加回 `as`。**

**这是本卡的验收核心** —— **`as` 存在就说明类型还没补全。**

### 三、`deckPatternCheck` 自己读不读这些字段？

**它现在只读 `card.paragraphs` 判断有没有标签文字**（`:487`），**不读 `align`。**

**所以补类型不改变任何判据行为。** 这是**纯类型改动**，`checkDeckPatterns` 的逻辑一行不动。

**但要证明这一点**：t65 / t73 / t63 三套的数字必须和改前一致。

## 验收判据

1. **`npx tsc --noEmit -p apps/desktop/tsconfig.json` → EXIT=0**（当前 EXIT=2）。
2. **`t65-deck-pattern-smoke` 里的 `as DeckElement` 已删除**（`grep -c "as DeckElement"` → 0）。
3. **`t65` / `t73` / `t63` 数字不变**（纯类型改动，零行为变化）。
4. **补的每个字段都有 `guide slides spec` 的依据**（回写区列表）。
5. 不跑全量、不起 Electron。

## 边界

- **只改 `deckPatternCheck.ts` 的类型定义**（`:44-59`），**不碰任何判据逻辑**；
- **只改 `t65-deck-pattern-smoke/main.ts` 的类型标注**，**不碰任何断言**；
- **不碰 `documentToolRuntime.ts` / `build/` / `policy.ts`**（别人在改）。

## ⚠️ 为什么卡上写「不许照抄我给的字段表」

**2026-10-24 我在 T107/T108 上给过两次「照这个写」的代码示例，两条都有事实错误**，D 用四条命令核实出来。

**给了错的方法，比不给方法更坏。** 所以这里的字段表**标了「待核实」**，而不是「照抄」。

## 遇到问题先检索

```bash
node genoffice/packages/cli/dist/genoffice.cjs guide slides spec
grep -n "paragraphs" -A 20 apps/desktop/src/main/document/deckPatternCheck.ts
grep -c "as DeckElement" apps/desktop/scripts/t65-deck-pattern-smoke/main.ts
```

## 回写

`tasks/T110-deck-element-paragraph-type.md` 末尾追加 `## 结果回写（2026-10-24）`：
补了哪些字段 + 各自的规范依据、`as` 删除前后的 `tsc` 结果、三套数字对照、提交 SHA。
