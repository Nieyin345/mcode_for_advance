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
