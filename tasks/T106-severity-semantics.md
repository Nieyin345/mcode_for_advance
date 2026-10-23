# T106｜`level` 有分级但没有语义：error 和 warning 在同一行里并列计数

- Status: ready-for-agent
- Category: **产品缺陷（判据体系的结构性缺口）**
- Priority: **P0 —— 「有严重度分级，但没有严重度语义」比不做分级更糟**
- Depends on: T65 / T75 / T100（判据本身已修好）、F 的设计评估（`483eb29e`）
- Exclusive writable files:
  - `apps/desktop/src/main/document/documentToolRuntime.ts`（`patternFindingsText`）
  - `apps/desktop/scripts/t73-pattern-wiring-smoke/main.ts`

## Required Skills
- `mcode-smoke`：正负控 + 变异。

## 背景：F 的设计评估（总控核实）

**代码实证**：

```ts
const errors = outcome.findings.filter((f) => f.level === "error");
const warnings = outcome.findings.filter((f) => f.level === "warning");
// ... 两者只用来拼一个计数：
patternCounts: { error: errors.length, warning: warnings.length },
```

**除此之外没有任何地方用 `level`**：不排序、不阻断、不过滤。

**而 `deckPatternCheck.ts` 自己的注释也承认**：

> ⚠️ 目前 `level` 只是一个文本前缀……不驱动任何行为：**不阻断、不排序、不过滤**。

### 为什么这是问题

`palette.rainbow` 是 `error`（「确定违反规范」），`layout.whitespace` 是 `warning`（「参考线，可忽略」）。

**模型读到 3 个 error + 2 个 warning 时，没有理由相信前者比后者更该改** —— 因为它们在同一条 hint 里被并列计数。

**F 的准确表述**：

> **现状是「有严重度分级，但没有严重度语义」。这比不做分级更糟：读的人以为分级在起作用。**

## ⚠️ 不要做的事（F 明确警告，总控认可）

**不要给 `deckPatternCheck` 加更多判据。**

> 今天一天里，**7 条判据中至少 3 条出过问题**（`palette.rainbow` 方向反了、`layout.whitespace` 的 cover 豁免形同虚设、`layout.card-whitespace` 看不到内嵌文字）。**这个比例说明问题不在「判据不够多」，在「每条判据的可信度」。**
> **加判据的边际收益已经低于它的风险。**

**也不要让 `error` 阻断 build。**

> 让 error 阻断会重新引入「判据有点问题就卡住产品」的风险。

## 任务

### 一、`patternFindingsText` 按 severity 排序并分组

**现在**：

```ts
for (const raw of findings.slice(0, 40)) { ... }   // 顺序 = findings 数组顺序
```

**改成**：

```
⚠️ 反模式检查发现问题（2 项必须改 / 1 项可参考）：

必须改：
- [error] palette.rainbow · pages/03.json：第 3 页用了 3 个非中性填充色…

可参考（参考线，不影响设计意图时可忽略）：
- [warning] layout.whitespace · pages/02.json：内容底边只到 68%（参考线约 80%）…
```

**要求**：

1. **error 组在前，warning 组在后**；
2. **两组的引导语不同**（「必须改」vs「可参考」）；
3. **一组为空时不显示那组的标题**；
4. **总数在开头说清**（`2 项必须改 / 1 项可参考`）。

### 二、`patternCounts` 的语义要跟着变

**现在** `patternCounts: { error: N, warning: M }` —— **两个数字并列，没有含义。**

**要么**：
- 保留原字段（结构兼容），但 **`patternHint` 里写清语义**；
- **要么**加一个 `patternGrouping` 字段。

**你判断。** 但**如果改结构，要确认没有别的消费者**（`grep -rn "patternCounts" apps/`）。

### 三、正控 + 负控

| 用例 | 期望 |
|---|---|
| 只有 error | 「必须改」组出现，**「可参考」组不出现** |
| 只有 warning | 「可参考」组出现，**「必须改」组不出现** |
| error + warning 混合 | **error 在前**，且**两组标题都在** |
| 零 findings | `✅ 反模式检查未发现问题。`（不变） |
| `checked: false` | 保持现有行为（不变） |

### 四、变异

1. **排序去掉**（按原数组顺序输出）→ 混合用例的「error 在前」必须红；
2. **两组的引导语改成一样** → 「必须改 vs 可参考」的断言必须红。

## 验收判据

1. **error 组在前，warning 组在后**（有断言）。
2. **两组引导语不同**（有断言）。
3. **一组为空时不显示标题**（两个方向都验）。
4. **零 findings / `checked: false` 行为不变**（回归）。
5. **两次变异各红一次**。
6. `t73` 全绿；T43 / T65 不回归。
7. 不跑全量、不起 Electron。

## 边界

- **只改 `documentToolRuntime.ts` 的 `patternFindingsText`**；
- **不改 `deckPatternCheck.ts`**（判据本身不动，F 明确警告过）；
- 不碰 `build/`、`policy.ts`（别人在改）。

## 遇到问题先检索

`patternFindingsText` 的完整实现先读一遍（`documentToolRuntime.ts:426-470`）。
`patternCounts` 有没有别的消费者：`grep -rn "patternCounts" apps/`。

## 回写

`tasks/T106-severity-semantics.md` 末尾追加 `## 结果回写（2026-10-24）`：
改前/改后的正文对照、五组正负控、两次变异、套件数字、提交 SHA。

## 结果回写（2026-10-24）

### 一、改前 / 改后的正文对照

**改前**（`level` 只是方括号里的一个词，按原数组顺序）：

```
⚠️ 反模式检查发现 1 个 error / 1 个 warning。这些**不影响本次 build**（文件已生成），但规范把其中 error 一类列为缺陷 —— 改对应的 pages/NN.json 后用 build_deck 重建（或 slides replace 单页替换）。
- [warning] layout.whitespace · pages/01.json：第 1 页内容底边只到画布高度的 60%…（warning 先出现，因为第 1 页是它）
- [error] palette.rainbow · pages/02.json：第 2 页用了 3 组不同色相的填充色…
```

**改后**：

```
⚠️ 反模式检查发现 1 个 error / 1 个 warning。这些**不影响本次 build**（文件已生成），但规范把其中 error 一类列为缺陷 —— 改对应的 pages/NN.json 后用 build_deck 重建（或 slides replace 单页替换）。
（1 项必须改 / 1 项可参考）

**必须改**（确定违反设计规范）：
- palette.rainbow · pages/02.json：第 2 页用了 3 组不同色相的填充色…

**可参考**（参考线；版面是有意的留白/构图时可忽略）：
- layout.whitespace · pages/01.json：第 1 页内容底边只到画布高度的 60%…
```

三处可见变化：

1. **error 组在前**（改前是 warning 先出现，因为第 1 页触发的是它）；
2. **两组标题措辞不同**（「必须改」vs「可参考」）；
3. **开头一句数量**（`1 项必须改 / 1 项可参考`）。

### 二、`patternCounts` 的决定：**保留原字段，不改结构**

查过消费者：

```bash
$ grep -rn "patternCounts" apps/ --include=*.ts --include=*.tsx --include=*.mjs
apps/desktop/src/main/document/documentToolRuntime.ts:969:  patternCounts: { error: errors.length, warning: warnings.length },
（其余命中全部是 .tmp/ 下 smoke 的构建产物，不是源码）
```

**唯一的生产写入点就是它自己，没有其他消费者。** 所以两种做法都安全，选了**保留原字段**：结构兼容、零迁移成本，而语义靠正文里的 `（N 项必须改 / M 项可参考）` 那句承载。

**没有加 `patternGrouping`** —— 加字段等于让 `patternCounts` 与它可能不一致（两份真相）。正文已经说清了，再开一个结构化字段是重复。

### 三、五组正控 / 负控（全部实际跑）

| # | 用例 | 断言 | 结果 |
|---|---|---|---|
| ① | 只有 `error`（`palette.rainbow`） | 「必须改」组出现 | ✓ |
| | | 「可参考」组**不出现** | ✓ |
| | | 开头写「1 项必须改」 | ✓ |
| ② | 只有 `warning`（`layout.whitespace`） | 「可参考」组出现 | ✓ |
| | | 「必须改」组**不出现** | ✓ |
| | | 开头写「1 项可参考」 | ✓ |
| ③ | 混合（**故意让 warning 在第 1 页**） | 两组标题都出现 | ✓ |
| | | **error 组下标 < warning 组下标** | ✓ |
| | | 两组引导语不同 | ✓ |
| ④ | 零 findings | 仍是「反模式检查未发现问题」 | ✓ |
| | | 不出现任何分组标题 | ✓ |
| ⑤ | `checked: false` | 走原有「没有执行」分支，未被改动 | ✓（未改那个分支） |

**③ 的构造是关键**：把 warning 放在**第 1 页**，error 放在第 2 页 —— 如果按原数组顺序输出，warning 一定先出现。**这样「error 在前」才是真判据，不是碰巧。**

### 四、变异（两次，都红）

| 变异 | 结果 | 红的是哪条 |
|---|---|---|
| ① 排序去掉（error 组塞全部 findings，warning 组置空） | **5 条红** | 含「★ error 组排在 warning 组之前」，且输出里 `**必须改**` 组内同时出现了 `layout.whitespace` 与 `palette.rainbow` —— 正是原数组顺序的症状 |
| ② 两组引导语改成一样（都叫「必须改」） | **5 条红** | 含「★ 只有 warning 时不显示「必须改」组」与「★ 两组引导语不同」 |

**变异①第一版 ABORT 了**（匹配 0 处）—— 我把两行 `pushGroup` 用 `\n` 拼成一个替换串，而文件里它们之间没有那样的上下文。**改成单行分别替换后通过。** 这正是 CLAUDE.md 里那条「变异脚本在写文件前就退出」的形态：**幸好脚本里有 `if (n !== 1) process.exit(2)`，它明确报了 ABORT，而不是静默假绿。**

### 五、一次真实的回归，和它教我的

**我第一版把 `patternHint` 整个换成了自己拼的句子** —— T73 当场掉 2 条：

```
FAIL ★ 正文里点名了 finding 的数量与等级
FAIL ★ 给了可执行的提示（改 pages/NN.json 后重建）
```

**`patternHint` 里带着可操作的那句**（「改对应的 pages/NN.json 后用 build_deck 重建（或 slides replace 单页替换）」）。我改呈现格式时把它删了。

**修正：`patternHint` 原样保留，分组信息接在它后面。**

这条写进了代码注释：

> ⚠️ **`patternHint` 必须原样保留。**
> **呈现格式可以改，但已经存在的可操作信息不能丢。**

### 六、套件数字

```
t73-pattern-wiring-smoke:  40/40 → 51/51（新增 11 条）
t65-deck-pattern-smoke:    61/61（未回归）
t63-deck-quality-smoke:    15/15（未回归）
typecheck:                 本卡两个文件错误数 0
```

### 七、边界

- **只改** `documentToolRuntime.ts` 的 `patternFindingsText` 与 `t73-pattern-wiring-smoke/main.ts`；
- **没改 `deckPatternCheck.ts`**（判据本身不动，卡上明确警告过）；
- **没有让 error 阻断 build** —— 只改呈现；
- 不跑全量、不起 Electron。

### 八、总控要求保全的两句

**关于用户观感**（写在这里，也建议进 `memory/doc-ugly-root-causes.md`）：

> **用户的实际观感我依然验不了** —— 今天所有结论都是「机器判据在它自己的目标上工作得如何」，不是「用户觉得 PPT 好不好看」。**这个缺口不是设计能补的，只能靠用户看。**

**关于不要再加判据**（T106 遵守了）：

> 7 条判据中至少 3 条出过问题。**这个比例说明问题不在「判据不够多」，在「每条判据的可信度」。加判据的边际收益已经低于它的风险。**

**本卡零新增判据。**
