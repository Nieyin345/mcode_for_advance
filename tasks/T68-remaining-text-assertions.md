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
