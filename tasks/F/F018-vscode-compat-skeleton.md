# F018｜VS Code 兼容层：先建契约骨架与编译期闸门（不写实现）

- Status: ready-for-agent
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
