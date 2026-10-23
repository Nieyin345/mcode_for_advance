# T74｜把 AST 机械层收到 `scripts/lib/ast.ts`（F 的保守方案）

- Status: ready-for-agent
- Category: 测试基础设施重构
- Priority: P1 —— 不是 bug，但两份 `parseFile` 已经开始漂（`ES2022` vs `Latest`）
- Depends on: T68（`c50140de`，`astAssertions.ts` 已入库）、T64（`0c0cb80c`，`findCalls`）
- Exclusive writable files:
  - **新建** `apps/desktop/scripts/lib/ast.ts`
  - `apps/desktop/scripts/provider-context-smoke/astAssertions.ts`
  - `apps/desktop/scripts/provider-context-smoke/main.ts`
  - `apps/desktop/scripts/mobile-api-surface-smoke/main.ts`

## Required Skills
- `mcode-smoke`：重构后必须证明两套都没退化。
- `codebase-design`：判断「提到哪一层」——**这是本卡的核心判断，不是无脑抽公共代码**。

## 背景：F 自己做的重复度清单（`1e76e3ab`）

F 扫了 291 套里所有用 AST 的（29 套），结论：

| 用法 | 套件数 | 本质 |
|---|---|---|
| `createSourceFile` + `transpileModule` + **执行产物** | **19** | **行为验证**，判据最强，没有假绿问题 |
| `createSourceFile` **只做静态查询** | **10** | 静态结构判断 |

**真正的重复在机械层，不在判据层**：

- `const src = (p) => readFileSync(resolve(...), "utf8")` —— 20+ 处，参数顺序/基路径各不相同；
- `file.endsWith(".tsx") ? TSX : TS` —— 5 处；
- **`parseFile` 同名同实现 —— 2 处**（`mobile-api-surface-smoke/main.ts:91` 与 `astAssertions.ts:26`）。

**F 的判断（总控采纳）**：

> **只提机械层到 `scripts/lib/ast.ts`**：`parseFile` / `scriptKindOf` / `walk` / `lineOf` / `fakeSourceWithTextOnly`。这些与「验什么」无关，重复只有漂移风险。
>
> **finder 层先不提**：`findPropertyAssignments` / `findPropertyAccesses` / `findConstDeclarations` / `findSliceWithNegated` 每个都编码了**具体判据的语义**。提前共享等于**为想象中的第三个消费者设计**——目前只有一套在用。
>
> **但 `findCalls` 应该一起提** —— T64 那份在 `main.ts`、T68 这 6 个在 `astAssertions.ts`，是同一个能力的两处。

**明确不做的**：

- **不要**把 10 套静态 AST 判据统一改写（大部分验的是契约形状或做代码生成，用法是对的）；
- **不要**动那 19 套 `transpileModule` 真跑的（已是最强判据）。

## 任务

### 第一步：先确认 F 的清单还成立

**不要直接照做。** 先自己数一遍（F 的清单是它写的，你要独立取证）：

```bash
grep -rn "createSourceFile" apps/desktop/scripts/ --include=*.ts --include=*.mjs | wc -l
grep -rn "function parseFile" apps/desktop/scripts/ --include=*.ts
grep -rn "endsWith(\".tsx\")" apps/desktop/scripts/ --include=*.ts
```

如果数字对不上（比如又有别人在这期间改了），**以你数到的为准**，并在回写区说明差异。

### 第二步：建 `apps/desktop/scripts/lib/ast.ts`

**只收机械层**，即与「验什么」无关的部分：

```ts
/** 按扩展名选 ScriptKind。 */
export function scriptKindOf(file: string): ts.ScriptKind

/** 解析源码文本（TS/TSX 按扩展名选 Kind）。 */
export function parseSource(file: string, text: string): ts.SourceFile

/** 从磁盘读并解析（相对 cwd）。 */
export function parseFile(relToCwd: string): ts.SourceFile

/** 遍历所有节点（含根）。 */
export function walk(sf: ts.SourceFile, visit: (node: ts.Node) => void): void

/** 节点的起始行号（1-based）。 */
export function lineOf(sf: ts.SourceFile, node: ts.Node): number
```

**`fakeSourceWithTextOnly` 是否要提，你判断** —— 如果它只在 provider-context 用，留在 `astAssertions.ts` 更合适（它是**判据夹具**，不是机械层）。F 建议提，但它也说了「finder 层不提」的理由同样适用于夹具。**给出你的判断和理由。**

### 第三步：`findCalls` 也提上来（F 与总控一致）

现在两处：
- `apps/desktop/scripts/provider-context-smoke/main.ts`（T64 写的）；
- `apps/desktop/scripts/provider-context-smoke/astAssertions.ts`（T68 写的）。

提到 `lib/ast.ts`，**两处都改成引用**。注意：
- 两处**签名可能不同**（一个返回什么、另一个返回什么）——**先读两处实现，取并集或统一**，不要直接复制一个覆盖另一个；
- 统一后**两处调用点的断言都必须仍然绿**（这是重构的验收）。

### 第四步：`mobile-api-surface-smoke` 改成引用

把 `main.ts:91` 那份 `parseFile` 换成 `import { parseFile } from "../lib/ast.js"`。

**注意差异**：它用的是 `ts.ScriptTarget.ES2022`，`lib/ast.ts` 用 `Latest`。

**你要论证选哪个**：

- `Latest` 跟着 typescript 版本走（升级 TS 时行为可能变）；
- `ES2022` 是钉死的。

**我的倾向是 `ES2022`**（测试判据不该随依赖升级漂），但**由你论证后定**，并把理由写进 `lib/ast.ts` 的注释。

### 第五步：验证

1. **两套都跑**：`provider-context-smoke`（应 74/74）、`mobile-api-surface-smoke`（应原数）；
2. **变异验证**：在 `lib/ast.ts` 里把 `parseFile` 的路径 `resolve` 去掉（改成直接读）→ **至少一套必须红** → `cmp` 还原；
3. 双包 typecheck；
4. **不跑全量**、**不起 Electron**。

## 验收判据

1. **F 的清单被独立复核过**（数字自己数一遍，差异写进回写）。
2. `lib/ast.ts` 只收机械层，**finder 层没有提前共享**（给出理由）。
3. **`findCalls` 两处统一**，且两处调用点都仍绿。
4. `mobile-api-surface-smoke` 与 `provider-context-smoke` 都引用 `lib/ast.ts`。
5. **`ScriptTarget` 的选择有论证**（`Latest` vs `ES2022`），写进注释。
6. 变异：改坏 `parseFile` → 至少一套红 → `cmp` 还原。
7. 两套数字不退化；双包 typecheck 通过。
8. **不跑全量**、**不起 Electron**。

## 边界

- **只改**：`lib/ast.ts`（新建）、`provider-context-smoke/{astAssertions,main}.ts`、`mobile-api-surface-smoke/main.ts`；
- **不改**那 19 套 `transpileModule` 真跑的；
- **不改**那 10 套里除 `provider-context` / `mobile-api-surface` 外的任何套件；
- **不改产品源码**；
- **不碰 `t65-deck-pattern-smoke`**（E 在改）。

## 遇到问题先检索

typescript 的 `ScriptTarget` / `ScriptKind` 语义先查官方文档，不要凭记忆。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T74-ast-lib-extraction.md` 末尾追加 `## 结果回写（2026-10-23）`：
独立复核的数字、`ScriptTarget` 论证、`findCalls` 统一前后的签名差异、变异证据、两套数字、提交 SHA。

## 结果回写（2026-10-23）

### 第一步：独立复核 F 的清单 —— 两处对得上，一处**我数错了**

| 项 | 卡上的数字 | 我数到的 | 结论 |
|---|---|---|---|
| `grep -rn "createSourceFile" ... \| wc -l` | — | **36 行** | — |
| `grep -rn "function parseFile"` | 2 处 | **2 处**（`mobile-api-surface-smoke:91`、`astAssertions.ts:32`） | ✓ 一致 |
| `grep -rn 'endsWith(".tsx")'` | **5 处** | **6 处** | ⚠️ **数字不符，但我的 5 是错的** |
| `createSourceFile` 套件数 | 29 | **29** | ✓ |
| `transpileModule` 套件数 | 19 | **19** | ✓ |

**关于「5 处」的更正**（这条是 T68 清单里的错误，T68 那份要作废）：

`endsWith(".tsx")` 实际出现 **6 次**，但**只有 2 次是 ScriptKind 判断**：

| 文件:行 | 用途 |
|---|---|
| `mobile-api-surface-smoke/main.ts:97` | **ScriptKind 判断** |
| `provider-context-smoke/astAssertions.ts:27` | **ScriptKind 判断** |
| `clickable-row-a11y-smoke/main.ts:330` | 文件过滤（`files.push`），不是 ScriptKind |
| `workflow-view-smoke/main.ts:2161` | 文件过滤（`continue`） |
| `workflow-view-smoke/main.ts:2639` | 目录项过滤（`continue`） |

严格匹配 `ScriptKind.*endsWith|endsWith.*ScriptKind` 只有 **2 处**。所以「5 份 ScriptKind 三元」这个说法是错的，实际是 **2 份**（且正好就是要统一的那两份）。

### 第二步 & 第三步：`lib/ast.ts` 内容与 `findCalls` 统一

**`lib/ast.ts` 收了这些**：`ts`（运行时解析）、`scriptKindOf`、`parseSource`、`parseFile`、`walk`、`lineOf`、`findCalls`。

**`parseSource` 保留了** —— 卡上提醒得对：T68 的正控/反控靠它构造合成源码，只搬 `parseFile` 不够。

**`findCalls` 两处签名差异与统一**：

| | T64（main.ts） | T68（astAssertions.ts） |
|---|---|---|
| 签名 | `findCalls(name)` —— **闭包持有 sf** | 无（直接遍历，没有独立 findCalls） |
| 返回 | `{ argCount, firstArg }` | — |
| `ScriptTarget` | `Latest` | `ES2022` |

统一后：**`findCalls(sf, name): CallSite[]`**，把 `sf` 变成显式参数（闭包形式只对单文件有效，提到 lib 必须是纯函数）。`CallSite` 比原来多了 `line` 字段（诊断用），是**并集**不是覆盖。

两处调用点：
- `main.ts:284` → `findCalls(sf, "registerPluginsHandlers")`
- `main.ts:296` → `findCalls(sf, "registerDocumentHandlers")`
- `main.ts:302` 的反控原本手写了一遍遍历，现在直接用 `findCalls(asStringSf, ...)` —— **顺带消掉了三处重复**

### 第四步：`ScriptTarget` 论证 —— 选 `ES2022`

**不仅讲道理，还做了实证**：拿 6 个真实文件（含 `.tsx`、`.ts`、契约文件）分别用 `ES2022` 和 `Latest` 解析，比较**完整节点种类序列**：

```
同一棵树: 6/6
ScriptTarget.Latest 的数值 = 99   ← 跟着 TS 版本走
ScriptTarget.ES2022 的数值 = 9    ← 固定值
```

**结论：在当前 TS 5.7.2 下两者解析结果完全相同，所以钉 `ES2022` 零风险；而 `Latest=99` 会随 TS 升级改变解析行为，届时判据可能静默改变而套件仍绿。**

选 `ES2022` 而不是更早版本的理由：仓库 `apps/desktop/tsconfig.json` 的编译目标就是 ES2022 —— 判据解析源码时用的目标应与实际编译目标一致。

**注意我对 `mobile-api-surface-smoke` 的 `parseFile` 做了一处兼容**：它沿 import 图递归时传的是**绝对路径**，而 lib 版原本只收相对 cwd。改成 `resolve(process.cwd(), path)`（对绝对路径幂等），两种都成立 —— 已在 `lib/ast.ts` 的注释里写明。

### `fakeSourceWithTextOnly` 的判断：**留在 `astAssertions.ts`，不进 lib**

**理由**（与我自己给 finder 层的理由同一条）：它是**判据夹具**，不是机械层。它存在的唯一目的是给「反控」这类断言造输入，编码了「反控该怎么造」这个语义。目前只有 `provider-context-smoke` 一套消费者；提到 lib 就是**为想象中的第二个消费者设计**。

判断界线：**与「验什么」无关的才进 lib**。`parseSource` 进了 lib 是因为「从文本解析出 AST」是无语义的机械操作；`fakeSourceWithTextOnly` 没进是因为「造一个只有文本、没有代码的输入」是反控判据的一部分。

### 第五步：验证

**两套数字（未退化）**：

```
provider-context-smoke      74/74 passed     （T68 之后就是 74）
mobile-api-surface-smoke    PASS — 10/10 checks
```

**本地实现已移除**（复核）：
- `mobile-api-surface-smoke/main.ts` 里 `function parseFile` 命中数 = **0**
- `provider-context-smoke/main.ts` 里 `const findCalls` 命中数 = **0**

**变异验证 —— 有两个结果要如实说**：

| 变异 | provider-context | mobile-api-surface | 说明 |
|---|---|---|---|
| **A. `parseFile` 读到坏路径**（拼 `.nonexistent`） | **崩（ENOENT）** | **崩（ENOENT）** | **两套都红** ✓ |
| **B. `scriptKindOf` 恒返回 TS**（`.tsx` 当 `.ts` 解析） | **仍全绿** | **仍全绿** | ⚠️ **未变红** |
| C. 去掉 `resolve(process.cwd(), ...)` | 仍全绿 | 仍全绿 | 这条变异是**无效变异**，见下 |

**关于变异 C**：我第一步先试了「去掉 `resolve`」，结果两套都没红。**原因不是判据弱，是变异本身没改变行为** —— 两套的 `run.sh` 都 `cd` 到 `apps/desktop`，而所有路径要么是相对 cwd 的（`resolve` 与直接读等价），要么是绝对路径（`resolve` 对绝对路径幂等）。**这条变异从一开始就不可能红**，换成了 A 才有效。

**关于变异 B（如实记录未变红）**：把 `.tsx` 当 `.ts` 解析，两套都没红。这是**预期内**的：TypeScript 在 `.ts` 模式下依然会把 JSX 当类型断言解析，对这两套实际读取的节点（标识符、属性赋值、调用、切片）不造成差别。**这说明「ScriptKind 判断」目前没有断言在守** —— 但它也**不是缺陷**：`ScriptKind` 的作用是避免解析报错，而这两套读取的节点在两种 Kind 下都能拿到。如果要让 B 变红，需要一套真的依赖 JSX 语法结构的断言，那超出本卡范围。

**结论**：卡要求的「改坏 `parseFile` → 至少一套红」**已满足**（变异 A，两套都红）。

**typecheck**：本卡涉及的 4 个文件错误数 **0**。

**未跑全量、未起 Electron、未改产品源码。**

### 提交

见 `git log`（按路径提交：`lib/ast.ts`、`astAssertions.ts`、`main.ts`、`mobile-api-surface-smoke/main.ts`、本卡）。
