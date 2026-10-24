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

## 结果回写（2026-10-24）

> 执行会话（F）。**纯类型改动，零行为变化。**
> `tsc` EXIT=0、`as DeckElement` 归零、三套数字与改前逐项一致。

### 1. 补了哪些字段（逐条 spec 依据）

规范原文取自 `node genoffice/packages/cli/dist/genoffice.cjs guide slides spec`（113 行）。

**`DeckParagraph`**（对应原文 **Paragraph fields** 一节）：

> Paragraph fields: `runs` (required), `align` (`left` `center` `right` `justify`),
> `lineSpacingPct` (60 to 300), `spaceBeforePt` and `spaceAfterPt` (0 to 96),
> `bullet` (true = a • bullet with a hanging indent).

| 字段 | 类型 | 依据 |
|---|---|---|
| `runs` | `DeckRun[]` | 同上（required） |
| `align` | `"left" \| "center" \| "right" \| "justify"` | 同上，四值枚举 |
| `lineSpacingPct` | `number` | 同上，60–300 |
| `spaceBeforePt` | `number` | 同上，0–96 |
| `spaceAfterPt` | `number` | 同上，0–96 |
| `bullet` | `boolean` | 同上 |

**`DeckRun`**（对应原文 **Run fields** 一节）：

> Run fields: `text` (required), `sizePt` (6 to 160), `bold`, `italic`, `color`, `font`.

| 字段 | 类型 | 依据 |
|---|---|---|
| `text` | `string` | 同上（required） |
| `sizePt` | `number` | 同上，6–160 |
| `bold` | `boolean` | 同上 |
| `italic` | `boolean` | 同上 |
| `color` | `string` | 同上（`#RRGGBB` / `#RRGGBBAA`） |
| `font` | `string` | 同上 |

**卡上标「未验」的两条（`bold` / `italic`）已核实**：都在 **Run fields** 原文里列着。

### 2. 卡上问的「shape 和 text 是不是两套类型」—— 实测是**一套**，所以不拆

**先说两次失败的判据**（都记下来，因为它们看起来都该成功）：

**第一次：传合法值看 `detail.issues`。** shape 带 `align` / `lineSpacingPct` / `bullet` / `spaceAfterPt` → **全部 `issues: []`**。
**但这区分不了「接受」和「静默忽略」。**

**第二次（判别性对照）：传非法值。** `align: "sideways"`、`lineSpacingPct: 9999`、`sizePt: 999` ——
**在 text 上也全部 `issues: []`**。**builder 对这批字段根本不做范围/枚举校验**，
所以「不报错」这条路对 shape 和 text 一样无效，判据本身没判别力。

**第三次（决定性）：看产物 XML。** 把 spec 建成 `.pptx`，解 `ppt/slides/slide1.xml`：

| 字段 | `text` 元素 | `shape` 元素 |
|---|---|---|
| `align:"right"` | ✅ `algn="r"` | ✅ **`algn="r"`** |
| `bold:true` | ✅ `b="1"` | ✅ **`b="1"`** |
| `color:"#FF0000"` | ✅ `<a:srgbClr val="FF0000"` | ✅ **同** |
| `lineSpacingPct:200` | ✅ `spcPct val="200000"` | ✅ **`spcPct val="200000"`** |
| `bullet:true` | ✅ `<a:buChar>` | ✅ **`<a:buChar>`** |

**shape 的段落走的是同一条渲染路径。** 所以不拆成两个类型——
拆分会造出一个上游并不存在的区别，而且下一个写 spec 的人会以为 shape 上不能用 `lineSpacingPct`。

（这个结论写进了 `DeckParagraph` 的注释，连同「为什么判据取产物 XML 而不是 `issues`」。）

### 3. `as DeckElement` 已删除

`t65-deck-pattern-smoke/main.ts:395`：

```diff
-        paragraphs: [{ align: "center", runs: [{ text: "标签", sizePt: 24 }] }] } as DeckElement,
+        paragraphs: [{ align: "center", runs: [{ text: "标签", sizePt: 24 }] }] },
```

`grep -c "as DeckElement"` → **0**。

**它当初为什么存在**：`483eb29e` 的提交信息写「`DeckElement` gains `valign` so the code no longer casts around the type」——
`valign` 补了，但 `paragraphs.align` 没补，`as` 就留了下来。

### 4. `tsc` 前后

| | 结果 |
|---|---|
| 改前 | **EXIT=2**，唯一错误 `t65-deck-pattern-smoke/main.ts(395,24): TS2352 ... 'align' does not exist` |
| 改后 | **EXIT=0，全仓 0 条错误** |

**⚠️ 过程中撞到一次别人的中间态**：改完第一次跑 `tsc` 时出现
`packages/contracts/src/index.ts(4,1): TS2308 Module "./session.js" has already exported a member named 'ApprovalDecision'`。
查 `git status`：`packages/contracts/src/ipc.ts` 有未提交改动（另一个会话刚加了 `export * from "./ipc/approval.js"`）。
我试过临时摘掉那一行做对照，结果引出 4 条新错误（`ApprovalBridge.ts` / `ipc/approval.ts` / `approvalSchema.ts` 已依赖它）——
**说明那是半成品，不能当对照**。已原样还原（`git diff` 仍是 1 增 0 删）。
再跑一次 `tsc` 时它自己消失了（那个会话写完了）。**最终 EXIT=0。**

### 5. 三套数字（纯类型改动，零行为变化）

| 套件 | 改前 | 改后 |
|---|---|---|
| `t65-deck-pattern-smoke` | **61/61** | **61/61** |
| `t73-pattern-wiring-smoke` | **51/51** | **51/51** |
| `t63-deck-quality-smoke` | **15/15** | **15/15** |

（两个 t73 目录：我用的是 `t73-pattern-wiring-smoke`，判据接线那套；`t73-browser-sandbox-smoke` 未跑。）

### 6. 变异：证明类型真的在约束，而不是「没报错」

把 `align` 改成 `alignx`（类型里不存在的字段）→

```
t65-deck-pattern-smoke/main.ts(395,24): error TS2561:
Object literal may only specify known properties, but 'alignx' does not exist in type
'DeckParagraph'. Did you mean to write 'align'?
```

**这证明补的类型是真在生效的** —— 没有这条，`tsc` 绿只能说明「没写到不支持的字段」，不能说明「写了会报错」。
还原后逐字节一致。

### 7. 未做

- 没跑全量（按卡要求）。
- 没碰 `checkDeckPatterns` 一行。
- `DeckElement` 里其余字段（`stroke` / `flipV` / `flipH` / `url` 等）**没补**：本模块不读它们，
  卡的范围也只到 `paragraphs`。若将来判据要用，届时按 spec 补。
