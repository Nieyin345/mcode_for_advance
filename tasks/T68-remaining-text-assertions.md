# T68｜把 `provider-context-smoke` 剩余的 6 条文本断言统一换成 AST 判据

- Status: ready-for-agent
- Category: **bug（测试有效性）**
- Priority: **P1**
- Depends on: T64（已完成，提交 `0c0cb80c`，建立了可复用的 AST 判据）
- Exclusive writable files: `apps/desktop/scripts/provider-context-smoke/main.ts`

## Required Skills
- `mcode-smoke`: 这套无头 smoke 的写法 + 变异验证。
- `code-review`: 确认修的是取证方法，不是放宽断言。

## Read before work

- `CLAUDE.md`
- `tasks/T64-assertion-behavior-fixes.md`（**必读**：里面那套 AST 判据是本卡的模板）
- `docs/planning/assertion-integrity-audit.md`（T61，本线由来）
- `apps/desktop/scripts/provider-context-smoke/main.ts`（T64 已在那里建好 `findCalls` 解析器）

## 缺陷

`provider-context-smoke` 在 T64 里修掉 1 条，**还剩 6 条** `includes(源码文本)` 的断言。T64 的变异测试已证明这类判据不可靠：

- **肯定断言** `src.includes("X")` 在 **X 被注释掉** 时仍为真 → 假绿；
- **否定断言** `!src.includes("X")` 在 **X 被写进注释/字符串** 时也会为真 → 同样不可靠。

**总控的原话**：「`includes(...)` 的正负方向都不可靠……两个方向都需要换成 AST。」

### 6 条清单（已逐条核实可行性）

| # | 位置 | 断言 | 方向 | 产品侧现状 |
|---|---|---|---|---|
| 1 | `provider-context-smoke/main.ts` | `!runtime.includes("session.activePluginNames")` | 否定 | 真的没有（grep 零命中） |
| 2 | 同上 | `runtime.includes("pluginNames: input.pluginNames,")` | 肯定 | `RuntimeManager.ts:1655` 的 `PropertyAssignment` |
| 3 | 同上 | `!source(".../contracts/session.ts").includes("activePluginNames")` | 否定 | 真的没有 |
| 4 | 同上 | `!source(".../store/sessionSchema.ts").includes("active_plugin_names")` | 否定 | 真的没有 |
| 5 | 同上 | `source(".../CodexAppServerClient.ts").includes("timer.unref")` | 肯定 | `CodexAppServerClient.ts:166` 的 `timer.unref?.()` |
| 6 | 同上 | `runtime.includes("USAGE_HISTORY_LIMIT")` | 肯定 | `RuntimeManager.ts:300` 常量 + `:1118` 使用 |

**已核实的 AST 形态**（每条都做过实际 grep，不是猜）：

- **#2**：`pluginNames: input.pluginNames,` 是 **PropertyAssignment** 节点 —— `node.name` 是 `pluginNames`，`node.initializer` 是 `input.pluginNames`。同时要区分 `RuntimeManager.ts:1143` 那个**类型注解** `pluginNames?: string[];`（那是 `PropertySignature`，**不是**赋值）。
- **#5**：`timer.unref?.()` 是 **CallExpression**，callee 是 **PropertyAccessExpression**（`expression = timer`, `name = unref`），且**带 `questionDotToken`**（可选链）。⚠️ **该文件 L165 的注释里就写着 `.unref()`** —— 正是 `includes` 会假阳性的活样本。
- **#6**：`USAGE_HISTORY_LIMIT` 出现两处 —— **声明**（`VariableDeclaration`，`const USAGE_HISTORY_LIMIT = 200`）与**使用**（`slice(-USAGE_HISTORY_LIMIT)`）。断言应当**分别**验「声明存在且值合理」与「切片真的用了它」，否则「常量没被用」也能绿。
- **#1 / #3 / #4**：否定断言，AST 下要求「**找不到对应的标识符/属性名出现**」。注意 AST 判据的优势：**注释里的同名文本不算命中**（那是 `!includes` 的假阳性来源）。

## 工作顺序

### 第一步：复用 T64 的解析器，不要重写

`provider-context-smoke/main.ts` 里 T64 已经建好：

```ts
const requireFromHere = createRequire(resolve(process.cwd(), "package.json"));
const ts = requireFromHere("typescript") as typeof TS;
// ...
const findCalls = (name: string): Array<{ argCount: number; firstArg: string }> => { ... }
```

**把它抽成更通用的形式**（例如 `findNodes(rel, predicate)` 或几个具名查找器），供 6 条共用。抽的时候**不要破坏 T64 那 4 条已通过的断言**。

⚠️ 抽解析器时注意两条 T64 踩过的坑，别重犯：
1. `typescript` 必须用 `createRequire(process.cwd())` 运行时解析（bundle 在临时目录，静态 import 会 `ERR_MODULE_NOT_FOUND`）；
2. `run.sh` 的 `--external:typescript` 不能删。

### 第二步：逐条替换

每条都要写成**带正控/反控**的形式（照 T64 的做法）。建议模式：

| 断言类型 | 判据 | 正控 | 反控 |
|---|---|---|---|
| **肯定**（#2/#5/#6） | AST 里找到真实节点 | 同文件里找另一个**确定存在**的同类节点，证明解析器没坏 | 把目标文本塞进**字符串字面量/注释**再解析，断言命中数必须为 0 |
| **否定**（#1/#3/#4） | AST 里**找不到**该标识符 | 在**另一个确定含它的文件**上跑同一查找器，必须命中 ≥1（证明不是恒假） | 把该名字塞进目标文件的字符串字面量，断言**仍然找不到**（证明不是靠"名字出现"判的） |

**否定断言的正控尤其重要** —— 「找不到」有两种可能：真的没有，或者解析器/路径坏了。**必须有对照证明查找器本身能工作。**

### 第三步：变异验证

每条至少两个变异：

1. **肯定断言**：把目标代码注释掉 → 必须红；
2. **否定断言**：把被禁止的代码真的加回去 → 必须红（这条最关键，因为否定断言平时不常见红）；
3. 若环境允许，再加一条「改成字符串字面量」的变异。

**变异必须确认真的落地**（`git diff` 看得到），否则会出现「文件没改、套件没跑、误以为验过」。

### 第四步：还原与复核

`cmp` 逐字节确认；`git status` 复核无残留。

## 硬要求

1. **复用 T64 的解析器**，不重写第二份。
2. 每条都有**正控 + 反控**。
3. **如果某条用 AST 也验不了，如实说**，不要硬造一个看起来像判据的东西 —— 在回写里写清「这条验不了，原因是 X」，并说明它退化成什么。
4. **不跑全量**、**不起 Electron**。
5. **不改产品源码**（只改 `provider-context-smoke/main.ts`；如解析器需要小改 `run.sh`，说明理由）。

## 验收判据

1. 6 条各自的 AST 判据写法。
2. 每条的**正控 + 反控**证据。
3. 每条的**变异证据**（肯定：注释掉→红；否定：加回去→红）。
4. 数字对比（修复前 / 后）。
5. `cmp` 逐字节还原证据，`git status` 无残留。
6. 若某条验不了，如实列出并说明原因。

## 边界

- **只改 `apps/desktop/scripts/provider-context-smoke/main.ts`**（必要时 `run.sh` 加参数，需说明）。
- **不改产品源码。**
- 不碰 `policy.ts`、`documentToolRuntime.ts`、`renderer/`。
- 若发现某条断言的产品侧现状与上表不符（例如代码已经变了），**停下报告**，不要照着旧表硬改。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**

## 提交

```bash
git add apps/desktop/scripts/provider-context-smoke/main.ts tasks/T68-*.md
git commit -m "<信息>" -- <同样的路径>
```

⚠️ `-m` 必须在 `--` 之前。**禁止 `git commit -a` / 不带路径的 `git commit`。**

提交信息末尾加：

```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

`tasks/T68-remaining-text-assertions.md` 末尾追加 `## 结果回写（2026-10-23）`：6 条各自的判据、正控/反控证据、变异证据、数字对比、提交 SHA、验不了的条目及原因。

## 最终回复

只列：任务编号与标题；提交 SHA；6 条各自是否已换成 AST；正控/反控是否每条都有；有没有验不了的。

## 结果回写（2026-10-23）

### 数字

```
修复前：59/59（T64 之后）
修复后：74/74
```

新增 15 条 = 6 条主判据 + 9 条正控/反控。**6 条全部换成 AST，没有一条验不了。**

### 抽出的共用工具

新建 `apps/desktop/scripts/provider-context-smoke/astAssertions.ts`（**不是第二份解析器**）：

- `parseSource` / `parseFile` —— 按扩展名选 `ScriptKind`
- `walk` / `lineOf` —— 遍历与行号映射
- `findPropertyAssignments(sf, name)` —— **`PropertyAssignment`**（区分于 `PropertySignature` 类型注解）
- `findPropertyAccesses(sf, obj, prop)` —— 含 `?.` 与「是否被调用」
- `findIdentifiers(sf, name)` —— 任意位置的标识符
- `findConstDeclarations(sf, name)` —— `const X = ...`
- `findSliceWithNegated(sf, name)` —— `slice(-X)`
- `fakeSourceWithTextOnly(kind, snippet)` —— **反控夹具**：把目标塞进字符串/注释

T64 已建好的 `findCalls`（`registerPluginsHandlers` 那条）**原样保留、未改动**，那 4 条断言仍全绿。

### 6 条各自的判据与证据

| # | 原断言 | 新判据 | 正控 | 反控 |
|---|---|---|---|---|
| ① | `!runtime.includes("session.activePluginNames")` | `findPropertyAccesses` + `findIdentifiers` 命中数为 0 | 已知含该名字的源码上必须命中 ≥1 | 字符串字面量里的同名文本不命中 |
| ② | `runtime.includes("pluginNames: input.pluginNames,")` | `findPropertyAssignments`，`valueText === "input.pluginNames"` | **类型注解 `pluginNames?: string[]` 不算赋值**（区分 PropertySignature） | 注释里的赋值形状不命中 |
| ③ | `!source(session.ts).includes("activePluginNames")` | `findIdentifiers` 零命中 | 同上 | 注释里的同名文本不命中 |
| ④ | `!source(sessionSchema.ts).includes("active_plugin_names")` | `findIdentifiers` 零命中 | 同上 | 字符串里的同名文本不命中 |
| ⑤ | `source(CodexAppServerClient.ts).includes("timer.unref")` | `findPropertyAccesses("timer", "unref")` 且 `called === true` | 已知含 `timer.unref()` 的源码上命中 | **注释里的 `timer.unref()` 不命中**（原位证据） |
| ⑥a | `runtime.includes("USAGE_HISTORY_LIMIT")`（前半） | `findConstDeclarations`，且值是可解析的正整数 | 已知 `const X = 200` 命中 | 注释里的声明不命中 |
| ⑥b | 同一条正则（后半） | `findSliceWithNegated` —— `slice` 的唯一参数文本恰好 `-USAGE_HISTORY_LIMIT` | 已知切片命中 | 字符串里的切片形状不命中 |

⑥ 按总控要求**拆成两条独立断言**（⑥a 声明 / ⑥b 使用）。

### 变异证据（6 次，每次只红对应的那一条）

| 变异 | 目标文件 | 结果 |
|---|---|---|
| ① 把 `session.activePluginNames` **真实加回** | `RuntimeManager.ts` | **1 条红**（`{"found":3}`） |
| ② 注释掉 `pluginNames: input.pluginNames,` | `RuntimeManager.ts` | **1 条红**（报出剩下的 `req.pluginNames@1758`） |
| ③ 把 `activePluginNames` 加回契约 | `packages/contracts/src/session.ts` | **1 条红**（`{"found":1}`） |
| ④a 以**标识符**加回 `active_plugin_names` | `sessionSchema.ts` | **1 条红**（`{"found":1}`） |
| ④b 以**字符串**加回 `active_plugin_names` | `sessionSchema.ts` | **0 条红 —— 这是正确行为**（AST 不认字符串，原 `!includes` 会在这里误报） |
| ⑤ 注释掉 `timer.unref?.();` | `CodexAppServerClient.ts` | **1 条红**（`{"found":[]}`） |
| ⑥a 注释掉 `const USAGE_HISTORY_LIMIT = 200;` | `RuntimeManager.ts` | **1 条红**（只有 ⑥a 红，⑥b 仍绿） |
| ⑥b `.slice(-USAGE_HISTORY_LIMIT)` → `.slice(-200)` | `RuntimeManager.ts` | **1 条红**（只有 ⑥b 红，⑥a 仍绿） |

**总控要求的「⑥a / ⑥b 各自单独红」已证明**：撤声明只红 ⑥a、改使用只红 ⑥b，互不牵连。若两条总是一起红，说明是同一判据 —— 实际不是。

**八次变异全部 `cmp` 逐字节还原，`git status` 复核无残留。**

### 位置证据：`timer.unref` 那条

`CodexAppServerClient.ts:165` 的注释原文：

```
// 做法(那边显式 .unref())。清掉定时器的那几条路(pending 结算/进程退出)不受影响。
```

**这一行注释就能让 `includes("timer.unref")` 永远为真。** 变异 ⑤ 把真实调用 `timer.unref?.()` 注释掉后新判据变红 —— 而旧断言在这种情形下无从分辨。

### 未做 / 说明

1. **未跑全量**、**未起 Electron**。
2. **未改产品源码**（三次变异均为临时改写，全部还原并用 `git status` 复核）。
3. 新增文件 `astAssertions.ts`（在卡的「只改 main.ts」边界外一步）—— 理由：6 条共用，抽成独立模块比塞回 main.ts 更清晰，且避免与 T64 的 `findCalls` 混在一起。**如需严格限制在单文件，可以合并回 main.ts**，请指示。
4. `run.sh` 未改动（`--external:typescript` 沿用 T64）。
5. 全包 typecheck 里本套错误数为 **0**；`t63-deck-quality-smoke` 的红是别人在途文件。

### 提交

见下方 git log（按路径提交：`main.ts` + `astAssertions.ts` + 本卡）。
