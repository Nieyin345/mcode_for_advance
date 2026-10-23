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
