# F018｜VS Code 兼容层：先建契约骨架与编译期闸门（不写实现）

- Status: done
- Category: **P0 扩展主线（B 方案第一步）**
- Depends on: F017（Theia PoC `9dc2bf78`，已证「接 Theia 可行但会改掉产品定位」）；用户裁决「自己做，要做完整的」
- Exclusive writable files:
  - 新建 `packages/vscode-compat/`（**新包**：契约骨架 + 类型闸门）
  - 新建 `apps/desktop/scripts/vscode-compat-gate-smoke/`
  - `pnpm-lock.yaml`（**只因为新增 `@types/vscode` 这一个 devDependency**）
  - 本卡回写
- **不碰**：`apps/desktop/src/**`（本卡不接进产品）、`packages/contracts/**`、`.tmp/theia-poc/`（那是 PoC 产物，保留作参照）、**根 `package.json`**（不用改）

> **`pnpm-workspace.yaml` 不用动** —— 它的 glob 是 `packages/*`，新包自动被收进来。我查过了。
> **`@types/vscode` 本机未安装**（`pnpm ls` 为零），要装进新包的 `devDependencies`。
> **装之前先 `git status --porcelain pnpm-lock.yaml`**：非空说明另一个会话在改依赖，
> **停下来等它**，不要和别人抢 lockfile。

## Required Skills
- 无特殊；需要会读 TypeScript 类型、会写构建脚本。

---

## 为什么第一步不是写 `vscode.commands`

用户要做**完整**的 VS Code 兼容层。参照物是 Theia 的 `plugin-ext`：

```
26,961 行（lib/plugin/ 全部）
```

Mcode 现在 `vscodeL1Bridge.ts` 是 **1,261 行**。

**26,961 行不可能一次写完，必须能分批、能中途停下、能每批独立验证。** 而分批的前提是**先有一副骨架说明「每一块该长什么样」**——否则第一批代码就会变成「看起来像 vscode 但不是」，后面所有批次都建在沙子上。

**所以这张卡只做骨架 + 闸门，一行 API 实现都不写。**

---

## 核心杠杆：`@types/vscode` 做编译期闸门

已核实：

```
@types/vscode@1.140.0    MIT    零 dependencies    745 KB
```

**它是微软官方的 VS Code API 类型定义。** 我们写的实现对象如果写成：

```ts
export const commands: typeof import("vscode").commands = { /* 缺一个方法就编译不过 */ }
```

**那么「缺哪个方法」由 TypeScript 在编译期告诉我们，不需要人肉对照文档，也不需要写测试去数。**

**这比任何测试都可靠**——测试要人写、会漏、会过时；类型不会。

### 闸门写法已验（写卡人实测，你直接照用）

我在 `.tmp/types-probe/` 里用 `@types/vscode@1.140.0` + `tsc` 实测了三种写法：

```ts
import type * as vscode from "vscode";

// ❌ as —— 缺成员也编译通过，等于没闸门
const a = { registerCommand: f } as typeof vscode.commands;

// ❌ satisfies Partial<...> —— 同上，部分满足就算满足
const b = { registerCommand: f } satisfies Partial<typeof vscode.commands>;

// ✅ 裸 satisfies —— 对象字面量必须满足全部成员
const c = { registerCommand: f } satisfies typeof vscode.commands;
// → g1.ts(5,3): error TS2739: Type '{ registerCommand: ... }' is missing
//   the following properties from type 'typeof commands':
//   registerTextEditorCommand, executeCommand, getCommands
```

**结论：`import type * as vscode from "vscode"` + `typeof vscode.commands` 可用，
裸 `satisfies` 是唯一会拦的写法。**

**这一步不用你重验**，但**要在套件里把「`as` 和 `satisfies Partial` 都会假绿」也测一条** ——
否则下一个人会以为随便哪种写法都行，把闸门改成 `as` 之后套件仍然全绿。

---

## 任务

### 一、建包骨架

```
packages/vscode-compat/
  package.json          # name: @mcode/vscode-compat, private
  tsconfig.json
  src/
    index.ts            # 导出各命名空间
    _gate.ts            # 编译期闸门：每个命名空间一个 satisfies
```

**新包不许依赖 anything 的运行时代码**（本卡只校验类型）。

### 二、列出要实现的命名空间清单

从 `@types/vscode` 里提取**全部顶层命名空间**，逐个标注：

| 命名空间 | 方法/属性数 | 本仓能提供的底层 | 难度 |
|---|---|---|---|

**「本仓能提供的底层」这一列是重点**：Mcode 已经有 Monaco（主编辑器）、终端（`terminal/`）、文件系统、LSP（`lsp/`）、任务系统。**哪些 VS Code API 能直接映射到它们，哪些完全没对应——这张表决定后面 26,961 行里有多少是真要写的。**

**把这张表写进回写区，它比代码更有价值。**

### 三、建闸门 —— 但要和包的 tsc 分开

这里有个必须解决的矛盾：

- **闸门要能编译失败**（缺方法时红），
- **整包又要 `tsc` 通过**（验收第 1 条）。

**所以 `_gate.ts` 从包的 `tsconfig.json` 里 `exclude` 掉。** 它不进正常构建，
只由套件单独编译。

```
packages/vscode-compat/tsconfig.json
  "exclude": ["src/_gate.ts"]        ← 少了这行，整包永远编译不过
```

`_gate.ts` 里每个命名空间一组：

```ts
import type * as vscode from "vscode";

// ── commands ── 缺口：registerTextEditorCommand / executeCommand / getCommands
const _commands_impl = {
  registerCommand: (id: string, cb: (...a: unknown[]) => unknown) => ({ dispose() {} }),
};
export const _commands = _commands_impl satisfies typeof vscode.commands;   // ← 必须红
```

**每一行都要真的红**（这就是「缺口清单」的可执行形式）。**别写 `as`、别写
`satisfies Partial<...>`——那两种我实测过，缺成员也过。**

**如果某个命名空间方法太多、一个个写缺口不现实**，就写：

```ts
// ── window ── 缺口：未实现（方法数见回写区表格）
```

用注释而不是假实现。**注释不会假装通过。**

### 四、套件：验证闸门真的会拦

`vscode-compat-gate-smoke`，四个断言组：

1. **`_gate.ts` 确实被 exclude** —— 读 `tsconfig.json`，断言 `exclude` 里有它；
   然后断言**包本身** `tsc --noEmit` **exit 0**。
2. **正向：完整对象编译通过** —— 用 `satisfies typeof vscode.commands` 写一个
   **把三个方法都实现**的对象，断言 `tsc` exit 0。
   > 没有这条，闸门恒红时第 3 条照样绿。
3. **负向：缺一个方法编译失败** —— 断言 exit ≠ 0，**并且**报错文本里出现
   **那个具体缺的方法名**。只断言「失败了」不够：语法写错也是失败。
4. **假闸门对照：`as` 和 `satisfies Partial<>` 都会放过缺方法** ——
   同一份不完整对象，换成这两种写法，断言 **exit 0**。

**第 4 条是本卡真正的判据。** 它证明「我们选的写法」比别的写法严，
而不是「随便什么写法都拦」。**没有它，下一个人把 `satisfies` 改成 `as`，
套件仍然全绿。**

**每条断言都要先写出「预期红几条」，再跑。** 记在回写区。

---

## ⚠️ 这张卡允许「做不完」

**B 方案是数万行的工程。** 本卡只做第一层。

**如果你发现「命名空间数量 / 方法数」远超预期**（比如某个命名空间有 200 个方法），**如实报出来，不要硬撑**——那个数字本身就是用户该知道的信息。

---

## 验收判据

1. **`packages/vscode-compat/` 存在**，能 `tsc` 通过（`_gate.ts` 已 exclude 掉）；
2. **命名空间清单表完成**，含「本仓能提供的底层」一列；
3. **`_gate.ts` 明确标注为未实现**（不是假装实现，且每行都真的编译失败）；
4. **套件四组断言都有**，特别是第 4 组（`as` / `satisfies Partial` 假绿对照）；
5. **每条断言先写预期红数**，再跑，结果记进回写区；
6. **不改 `apps/desktop/src/**`**（本卡不接产品）；
7. 不跑全量、不起 Electron。

---

## 回写

1. **命名空间清单表**（这是本卡最有价值的产出）；
2. **总方法数**（数出来的，不是估的）；
3. **其中多少个能直接映射到 Mcode 现有底层**（Monaco / 终端 / LSP / 文件系统）；
4. **闸门变异的实际结果**——四组断言各自预期红几条、实际几条、报错原文；
5. **你对总工作量的判断**——基于方法数，不是感觉；
6. 提交 SHA。

> **`typeof import("vscode")` 的写法结论我已经验完了，写在卡里第三节上方。**
> 你不用重验，但要照它写，并测出「`as` / `satisfies Partial` 会假绿」那一条。

---

## 结果回写（2026-10-24）

### 结论先说

**骨架 + 闸门建好了，一行 API 实现都没写。** 16 个顶层命名空间、**218 个唯一成员**（raw 语句 251，重载合并后 218）。套件 **45/45 全绿**，七种变异各自按预期变红。

**卡上的两个事实断言需要修正，都在下面单独标注**：
1. 「`as` 会假绿」**有前提**（类型需「足够重叠」），不是无条件；
2. 组 2 的「三个方法都实现」是笔误（`commands` 有 **4** 个成员）。

**`pnpm install` 会顺带升级两个无关包**（`@iconify/react`、`on-finished`），超出本卡边界 —— 我手工把 lockfile 收窄成纯新增，`pnpm install --frozen-lockfile` 验证通过。详见下面「lockfile 插曲」。

---

### 一、命名空间清单表（数出来的）

**怎么数的**：TypeScript compiler API（TS 5.7.2）解析
`packages/vscode-compat/node_modules/@types/vscode/index.d.ts`（1.140.0，21,244 行），
遍历 `declare module 'vscode'` 的直接子 `ModuleDeclaration`，收集 `body.statements`，
**按成员名去重**（重载合并：`showTextDocument` 有 3 个重载 = 1 个 API）。
计数脚本在 `.tmp/vscode-gate-probe/count-unique.mjs`（不入库），核心是：

```
ts.createSourceFile(dts, …) → 找 ModuleDeclaration 'vscode'
→ 每个子 namespace 的 body.statements → new Set(成员名)
```

> ⚠️ **用 grep 数会数错**：`grep -c "export function"` 会把重载各数一次（251），
> 而且漏掉 `const` 属性（`env.appName`、`workspace.fs`、`window.state`、`window.tabGroups` 这类共 55 个）。

| 命名空间 | 唯一成员数 | 本仓能提供的底层 | 难度 |
|---|---:|---|---|
| window | 57 | **部分**：Monaco 编辑器（`FileEditor.tsx`）+ 终端（`terminal/TerminalManager.ts`）+ 通知（`notifications/NotificationManager.ts`）+ 浏览器（`browser/BrowserManager.ts` 可做 webview）。**没有**：树视图、状态栏、QuickPick/InputBox、装饰类型、output channel。 | **高**（UI 面最宽，一半以上无对应） |
| workspace | 45 | **部分**：文件系统（`library/`、`ipc/files.ts`）、配置（`settings/`）、文件监视（`lib/fileSnapshot` + `ipc/rg.ts` 的 ripgrep）、任务（`tasks/`）。**没有**：workspace folder 多根模型、`applyEdit` 批量编辑事务、notebook document、file system provider 注册。 | **高** |
| languages | 40 | **部分**：LSP（`lsp/LspManager.ts` 已接 diagnostics/hover/definition/completion 等原生能力）。**没有**：provider 注册表（40 个里 **33 个是 `register*Provider`**，每个都要把 LSP 结果转成 VS Code 类型）、语义 token、folding range、inlay hints。 | **高**（数量多但形状单一：都是「provider 适配器」） |
| env | 21 | **部分**：`app.*`（appName/appRoot/shell）+ `settings/`（logLevel）+ Electron `clipboard`/`shell.openExternal`。**没有**：machineId、sessionId、telemetry、remoteName、asExternalUri。 | 低（多数是常量） |
| debug | 18 | **无** —— 全仓 `grep debugAdapter` 零命中。 | 高（要新写 DAP 客户端） |
| tasks | 8 | **部分**：`tasks/executor.ts`（自有任务系统，不是 VS Code Task API 的模型）。 | 中 |
| lm | 7 | **部分**：本仓本来就是 Agent 宿主（三家引擎）。但 `LanguageModelChat` 的会话语义要新写。 | 中 |
| commands | 4 | **直接**：`vscodeL1Bridge.ts` 的 `handlers` Map；`executeCommand` 要扩到跨扩展。 | **低**（4 个成员，最小） |
| authentication | 4 | **无** —— 有 MCP 的鉴权但不是账号体系。 | 中 |
| notebooks | 3 | **无** —— 无 notebook 模型。 | 中（要新写文档模型 + 渲染） |
| extensions | 3 | **部分**：`modules/ModuleHost.ts` + `service.ts`（自有扩展清单，不是 VSIX 模型）。 | 中 |
| l10n | 3 | **直接**：`lib/i18n/{zh,en}/` 双词典 + `t()`。 | **低**（几乎直接映射） |
| scm | 2 | **部分**：`ipc/git.ts` + `ipc/gitHistory.ts` + `lib/worktreeOps.ts`。 | 中 |
| comments | 1 | **无**。 | 低（单个 controller，但要锚定到编辑器选区） |
| tests | 1 | **无**（仓里有 smoke 但不是 TestController 模型）。 | 中 |
| chat | 1 | **直接**：本身就是聊天客户端；`createChatParticipant` 要桥接到会话编排。 | 低 |

**合计 218 个唯一成员。**

**「本仓能提供的底层」这一列的口径**：说「部分」= 有**可复用的底层能力**但**没有 VS Code 形状的适配层**（那正是后面要写的工作量）。
说「直接」= 底层能力与 API 语义几乎同构（如 `l10n.t` ↔ 现有 `t()`）。
说「无」= 本仓没有该领域的任何实现。

---

### 二、总方法数（数与估计分开）

| 指标 | 数 | 怎么来的 |
|---|---:|---|
| 顶层命名空间 | **16** | compiler API 遍历 `declare module 'vscode'` 的直接子 namespace |
| 唯一成员（重载合并） | **218** | 同上，`Set(名字)` 去重 |
| raw 语句（含重载重复） | 251 | 不去重 |
| 命名空间**外**的顶层成员 | **187 值 + 322 类型** | 这是**另一层**工作量：`Uri`、`EventEmitter`、`Disposable`、`ThemeColor`… 它们不是命名空间成员，但实现层必须全部提供。**卡上没提这一块，而它是 218 之外的必写项。** |

> **`grep` 数会是错的**：`grep -c "export function"` 数到 145，漏掉 55 个 `const` 属性（`env.appName`、`workspace.fs`、`window.state`、`window.tabGroups` 等）且把重载各数一次。

---

### 三、能映射到现有底层的比例

**按 218 个唯一成员逐项判断**（见上表「本仓能提供的底层」列）：

| 类别 | 成员数 | 占比 | 说明 |
|---|---:|---:|---|
| **直接映射**（底层同构） | 约 **8** | ~4% | `l10n.t/bundle/uri`、`commands.registerCommand`、`env.appName/appRoot/shell/logLevel`、`chat.createChatParticipant` |
| **部分映射**（有底层，要写适配层） | 约 **92** | ~42% | `window` 的编辑器/终端/通知、`workspace` 的文件/配置/任务、`languages` 的 40 个 provider（有 LSP 但每个都要做类型转换）、`scm`、`tasks`、`extensions`、`lm`、`authentication` 部分 |
| **无对应**（要新写整个子系统） | 约 **118** | ~54% | `debug`（18，DAP 客户端）、`notebooks`（3 + 文档模型）、`window` 的树视图/QuickPick/状态栏/装饰、`workspace` 的多根模型与 `applyEdit`、`tests`、`comments`、大部分 `languages` 的 provider 注册表 |

> ⚠️ 「直接 / 部分 / 无」按成员**数量**分，不按工作量分。`debug` 的 18 个成员比 `window` 的 20 个无对应成员**贵得多**（DAP 协议客户端 vs UI 组件）。

**这个比例推翻一个直觉**：「有 Monaco + 终端 + LSP，所以大部分能直接映射」——**不成立。**
真实现状是「**约一半成员背后完全没有子系统**」，而另一半里绝大多数是**适配层工作**，不是接线。

---

### 四、闸门实现与变异结果

**实现**：`packages/vscode-compat/src/_gate.ts` —— 16 个命名空间各一行裸 `satisfies`，全部**故意**不完整（`commands` 只写 1/4，其余 15 个写空对象）。
`tsconfig.json` 的 `exclude` 排除它，所以包本身 `tsc` exit 0，而套件单独编译它时**每行都红**。

**套件**：`apps/desktop/scripts/vscode-compat-gate-smoke/` —— **45 条**断言，5 个组（卡的 4 组 + 1 个附加组）。

#### 预期 vs 实际（跑之前写下的，原样保留）

| 组 | 预期 | 实际 | 结果 |
|---|---|---|---|
| 组 1（exclude + 包 tsc） | 绿 5 | 绿 5 | ✅ |
| 组 2（完整对象正控） | 绿 1 | 绿 1 | ✅ |
| 组 3（缺方法红 + 16 命名空间点名） | 绿 19 | 绿 19 | ✅ |
| 组 4（`as` / `Partial` 假绿对照） | 绿 2 | 绿 2 | ✅ |
| 附加（16 satisfies + 2 写法禁令） | 绿 18 | 绿 18 | ✅ |
| **合计** | **45/45** | **45/45** | ✅ |

#### 变异验证（每次先写预期红数）

| # | 变异 | 预期红 | 实际红 | 红的位置 | 结论 |
|---|---|---:|---:|---|---|
| A | `_commands` 的 `satisfies` → `as` | 3 | **3** | 组 3 点名 / 附加 satisfies / 附加 no-as | ✅ 正中目标 |
| B | 删 `tsconfig.exclude` 的 `src/_gate.ts` | **1** | **2** | 组 1 的 exclude 断言 + 组 1 的包 tsc | ⚠️ **我的预期漏了**：`exclude` 那条断言本身也会红。两条都指向同一件事，不是判据错 |
| C | 组 2 正控夹具删 `getCommands` | 1 | **1** | 组 2 | ✅ 证明组 2 不是空转 |
| D | 组 3/4 的「缺方法」夹具补全 | 2 | **2** | 组 3 的 exit≠0 + 点名 | ✅ 证明组 3 的夹具真在缺成员 |
| E | 删 `_gate.ts` 的 `workspace` 行 | 2 | **2** | workspace 点名 + workspace satisfies | ✅ |
| F | `lm` 的 `satisfies` → `as` | 3 | **3** | lm 点名 / lm satisfies / no-as | ✅（验证新增的 11 个命名空间不是摆设） |
| G | 删 `_gate.ts` 的 `scm` 行 | 2 | **2** | scm 点名 + scm satisfies | ✅ |

**还原核验**：每次变异后 `sha256sum -c` 逐字节比对，全部 OK。变异脚本里 `assert count==1`，不满足即 `exit 2`，不会出现「没改就报跑过了」。

#### 报错原文（组 3 的闸门报错，节选）

```
src/_gate.ts(43,41): error TS1360: Type '{ registerCommand: ... }' does not satisfy
  the expected type 'typeof commands'.
  Type ... is missing the following properties from type 'typeof commands':
  registerTextEditorCommand, executeCommand, getCommands
src/_gate.ts(49,37): error TS1360: Type '{}' does not satisfy the expected type 'typeof window'.
  Type '{}' is missing the following properties from type 'typeof window':
  showTextDocument, showNotebookDocument, createTextEditorDecorationType, showInformationMessage, and 53 more.
...
src/_gate.ts(89,31): error TS1360: Type '{}' does not satisfy the expected type 'typeof chat'.
  Property 'createChatParticipant' is missing in type '{}' but required in type 'typeof chat'.
```

**16 行全部红，报错点名缺口。**

---

### ⚠️ 卡上的事实断言修正（两条 + 一条过期）

#### 1. 「`as` 缺成员也编译通过」—— **有前提，卡上没写全**

写卡人在 `.tmp/types-probe/g1.ts` 用的样本是「只实现 1 个方法」，那种形状下 `as` 确实放行。
但本套件第一版用「缺 1 个方法、其余 3 个签名正确」的对象测 `as`，**`tsc` exit 2**：

```
error TS2352: Conversion of type '{...}' to type 'typeof commands' may be a mistake
  because neither type sufficiently overlaps with the other.
  Property 'registerTextEditorCommand' is missing in type ... but required in type 'typeof commands'.
```

**拦住它的是 `as` 的「类型足够重叠」规则（TS2352），不是完整性检查。**
当源对象只剩一个成员时，它是目标类型的子集，重叠成立 → 放行；成员多且签名不兼容时，重叠不成立 → `as` 也拦。

**结论不变，但要带前提写**：对 `_gate.ts` 这种「从零开始只写几个成员」的用法，`as` 会假绿；对「几乎写全但签名写错」的对象，`as` 可能拦（但拦的理由不对 —— 是重叠规则，不是缺口检查）。
套件第 4 组的断言名里已经写进了这个限定（「仅在类型重叠成立时」）。

#### 2. 组 2 的「三个方法都实现」是笔误 —— `commands` 有 **4** 个成员

`registerCommand` / `registerTextEditorCommand` / `executeCommand` / `getCommands`。
套件组 2 实现的是**全部 4 个**（完整对象才是正控）。

#### 3. 附带：卡上「`@types/vscode` 本机未安装」已过期

装之前 `packages/vscode-compat/node_modules/@types/vscode` 不存在；现在装好了（本包 devDependency）。

---

### ⚠️ lockfile 插曲（`pnpm install` 会「顺带升级」）

按卡正常 `pnpm install` 之后，`git diff pnpm-lock.yaml` **除了新增 `@types/vscode`，还改了两处无关依赖**：

```
'@iconify/react':  6.0.2 → 6.0.3        (specifier 是 ^6.0.2，允许)
'on-finished':     2.4.1 → 2.4.2        (传递依赖)
```

**`minimumReleaseAge` 没有配置，pnpm 就按最新版本全图重解析** —— 那是超过本卡边界的改动（会改别人的依赖树、无法在本卡验收）。

**处理**：`git checkout -- pnpm-lock.yaml` 还原，然后**手工只补三处**（importer / packages / snapshots 各一条 `@types/vscode@1.140.0`），
`pnpm install --frozen-lockfile --filter @mcode/vscode-compat` **exit 0**，证明手改的形状与 pnpm 期望一致。

**建议**（不在本卡做）：给仓库配 `minimumReleaseAge`，否则每一次 `pnpm install` 都会顺手升级无关包，而「升级了什么」藏在几百行 diff 里没人看。

---

### 五、对总工作量的判断（基于方法数）

| 层 | 数量 | 判断依据 |
|---|---:|---|
| 命名空间成员 | **218** | 数出来的 |
| 命名空间**外**的类型 + 值 | **509**（187 值 + 322 类型） | 数出来的。`Uri`/`EventEmitter`/`Disposable`/`ThemeColor`/`Position`/`Range`… 实现层必须全部提供 |
| 合计 API 面 | **727** | 218 + 509 |
| 其中「无对应子系统」 | 约 118（命名空间内） + 未知（命名空间外） | 见上表 |
| Theia `plugin-ext` 参照 | 26,961 行 | F017 实测 |
| Mcode 现有 `vscodeL1Bridge.ts` | 1,261 行 | 它只是 L1/L2 小 shim，**不是通用 API** |

**判断**：
- **218 个命名空间成员 + 509 个顶层类型/值**，按「一个有测试的实现平均 20–40 行」是 **15k–30k 行**，与 Theia 的 27k 行是同一量级。**卡里「数万行」的判断成立**，依据是数出来的成员数而不是感觉。
- **`commands` 只有 4 个成员，是全表最小的命名空间** —— 拿它当「第一步」在**验证闸门**上是对的，但在**工作量代表性**上是**最不具代表性的那一个**（它和 `window` 的 57 个差一个数量级）。
- **最大单块是 `languages`（40，其中 33 个 `register*Provider`）和 `window`（57）**。`languages` 的形状单一（都是「LSP 结果 → VS Code 类型」的适配器），可以批量做；`window` 的形状最杂（UI 组件各不同），**不能批量**。
- **`debug`（18）是唯一「要新写整个协议客户端」的块**，DAP 本身是另一个规范。
- **727 个成员里约一半背后没有子系统** —— 这决定了「先做哪批」：应该先做**有底层可接的**（`commands` 4 + `l10n` 3 + `env` 大部分 + `window` 的编辑器/终端/通知子集 + `workspace` 的文件/配置子集 + `scm`），**再决定要不要碰 `debug`/`notebooks`/`tests`**。

---

### 六、未做 / 我觉得不对但没改的

1. **没写任何 API 实现** —— 按卡要求。
2. **`_gate.ts` 只覆盖 16 个命名空间，不覆盖 509 个顶层类型/值**。类型（如 `Uri`）无法用 `satisfies` 做「实现必须完整」的闸门（它们是 interface/type，没有运行时对象）。**这是本卡方法的一个盲区，下一张卡要用别的方式守**（比如先用类型别名 + 运行时断言覆盖常用子集）。
3. **`pnpm-workspace.yaml` 不用改** —— 卡上这条我核实了：glob 是 `packages/*`，新包自动收进来。
4. **组 1 的「JSONC 解析」是我自己写的 30 行剥离器**，不是标准库。它处理 `//` 和块注释，且不把字符串里的 `//` 当注释。这一条不是卡要求的，是为「读配置文件」这个动作本身服务。
5. **`packages/vscode-compat/src/index.ts` 只导出一个 `PACKAGE_STATUS` 常量**，不导出任何 API。理由写在文件头：让 import 失败比让调用静默 no-op 好。
6. **`_gate.ts` 里 `commands` 写了 1 个成员、其余 15 个命名空间写空对象** —— 空对象也是一种「故意不完整」，报错会一次性列出全部缺口（`showTextDocument, …, and 53 more`）。**逐个造假实现对 57 个成员的窗口没有信息量**，卡里也允许用注释；但注释不会红，所以我保留了空对象的 `satisfies` 行（**它仍然真的红**）。
7. **没跑全量、没起 Electron、没碰 `apps/desktop/src/**` 和 `packages/contracts/**`**。
8. **desktop 单包 typecheck（`npx tsc --noEmit -p apps/desktop/tsconfig.json`）exit 0** —— 新套件在 `scripts/**/*` 内，已被它检查。
