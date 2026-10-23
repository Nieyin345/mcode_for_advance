# T66｜修掉 T61 查出的 5 处「看起来在验、实际没执行」

- Status: done（2026-10-23 执行回写，见文末）
- Category: 测试质量缺陷（P1）
- Priority: P1
- Depends on: T61（`b4aa6547` + D 的补充节）
- Exclusive writable files: **只改这 5 个套件的 `main.ts`**：
  - `apps/desktop/scripts/mcp-text-smoke/main.ts`
  - `apps/desktop/scripts/relay-smoke/main.ts`
  - `apps/desktop/scripts/flow-native-param-smoke/main.ts`
  - `apps/desktop/scripts/activity-console-count-smoke/main.ts`

## Required Skills
- `mcode-smoke`：改断言后必须做**变异验证**（撤掉被测对象 → 断言必须红 → `cmp` 还原）。

Read before work: `docs/planning/assertion-integrity-audit.md`（T61 报告，含全部五处的变异证据）、`CLAUDE.md` 的「任何断言的价值都不超过它取证方法的正确性」一节。

## 背景

T61 用「静态筛查 425 套 + 变异验证 7 套」查出 **5 处空过**。它们的共同点是：

> **代码写了、看起来在验，实际上从来不执行。**

死代码本身不是缺陷，**但它让读代码的人以为那里在验东西** —— 这比「断言写得弱」更糟：弱断言至少跑了，死代码连跑都没跑。

## 五处的逐条判断（T61 已核实，本卡直接采用）

| # | 位置 | 形态 | **判断** | 理由 |
|---|---|---|---|---|
| 1 | `mcp-text-smoke:19` `readAgentToolSources` | 整块死代码，零调用 | **改用** | 它想验的「整组里没有第二份实现」是**真判据**；当前 SKIP_DIRS 那条（`main.ts:236-249`）**手写重读了同样三个文件**，正是这个函数想消除的重复。用它可以删掉那份手写重读。 |
| 2 | `mcp-text-smoke:283` `docOpsSrc` | 读了但结果丢弃 | **改用** | **这是真缺口，不是死代码。** 上方注释明写「文档工具（`agentDocumentOps`）与文档转换工具（`agentTools`）从前各写一份朴素取法……**两处都必须** import 共享的 `resolvePythonExe`」——而当前断言只检查了 `agentToolSrcs2`（三个文件），**`agentDocumentOps.ts` 被读进来却排除在条件之外**。等于「说了两处，只验了一处」。 |
| 3 | `relay-smoke:164` `lastPush` | 定义了，同文件用 `pushes()` | **删除** | 它没有任何独有判据 —— `pushes()` 返回整个数组，调用方都是 `.map()` / `.every()` 整批看；没有一处需要「只看最后一条」。删掉。 |
| 4 | `flow-native-param-smoke:36` `eq` | 定义了，同文件 74 处 `assert.equal` | **删除** | 两个判据并存会让后来者不知道该跟哪个；`assert.equal` 是 `node:assert` 的原生用法，保留它。 |
| 5 | `activity-console-count-smoke:83` `textOf` | 10 行树遍历，零调用 | **删除** | 它的用途是「从节点树里摘出一段文本(用于认 chip 的 label)」，但该套件实际是按别的特征定位 chip 的。删掉，并在注释里留一句为什么不需要。 |

## 必须做到

### 1、2 两处（改用）

- **#1**：让 `readAgentToolSources()` 真正被调用，并用它替换 `main.ts:236-249` 那段手写重读（三个文件只读一次）。
- **#2**：把 `docOpsSrc` 纳入 `resolvePythonExe` 那条断言的条件里 —— 判据变成「**四个文件**里都不能自带朴素取法，且 `agentDocumentOps.ts` 也必须 import 共享的 `resolvePythonExe`」。

### 3、4、5 三处（删除）

- 删掉函数定义；
- **在原位置留一行注释**说明为什么不需要它（防止下一个人又加回来）；
- 确认删除后套件仍全绿（删死代码不应该改变任何判定）。

### 变异验证（针对 1、2 两处，因为它们是「让断言变强」）

| 变异 | 期望 |
|---|---|
| 把 `agentDocumentOps.ts` 里的 `resolvePythonExe` import 删掉、改成自带 `for (const exe of candidates)` | **#2 的断言必须红** |
| 把 `agentWalkGlob.ts` 里塞一个 `const SKIP_DIRS = new Set(...)` | **#1 的断言必须红** |

两次都要 `cmp` 逐字节还原。

### 硬要求

- **不跑全量**（用户规矩：全量由总控执行）；
- **不起 Electron**；
- **不改产品源码** —— 只改这 4 个套件的 `main.ts`；
- 变异后先 `git diff` 确认改动真的在，再跑（CLAUDE.md 记过这个坑）。

## 验收判据

1. 五处各有明确处置（用 / 删），理由写在回写区；
2. `#1`、`#2` 有**变异证据**证明改强后的断言真的会红（不是仍然空过）；
3. `#3`、`#4`、`#5` 删除后，对应套件仍全绿；
4. 四个套件全部通过；
5. 双包 typecheck 通过（只改套件，理论上不影响，但要跑）；
6. 回写区说明「为什么 #2 不是死代码而是真缺口」——这条最容易被人当成噪音删掉。

## 边界

- 只改上述 4 个套件的 `main.ts`；
- **不改** `docs/planning/assertion-integrity-audit.md`（那是 T61 的报告）；
- **不改**产品源码 —— 发现产品问题另开卡。

## 提交

`git add <明确路径>` 后立刻 `git commit -m "<信息>" -- <明确路径>`。**`-m` 必须在 `--` 前面。**

提交信息末尾加：

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T66-fix-dead-assertions.md` 末尾追加 `## 结果回写（2026-10-23）`：五处处置与理由、变异证据、套件结果、提交 SHA、未做的事。

## 结果回写（2026-10-23）

### 五处处置与理由

| # | 位置 | 处置 | 理由 |
|---|---|---|---|
| 1 | `mcp-text-smoke:19` → 用在 `:241` | **改用** | 它想验的「整组 agent 工具文件里只有一份 SKIP_DIRS」是真判据；而原代码在 `:241-245` **手写重读了同样三个文件**，与 `readAgentToolSources()` 逐行重复。改用它后三个文件只读一次，判据只有一处。 |
| 2 | `mcp-text-smoke:283` `docOpsSrc` | **改用（真缺口）** | 上方注释原话：「文档工具(`agentDocumentOps`)与文档转换工具(`agentTools`)……**两处都必须** import 共享的 `resolvePythonExe`」。但旧断言的条件只有 `agentToolSrcs2`（三个 agentTools 文件）—— **`agentDocumentOps.ts` 被读进来后从没进过条件**，等于「说了两处，只验了一处」。 |
| 3 | `relay-smoke:164` `lastPush` | **删除** | 零调用；所有调用方都是 `pushes().map()` / `.every()` 整批看，没有一处需要「只看最后一条」。原位留注释：真要最后一条用 `pushes().at(-1)` 即可。 |
| 4 | `flow-native-param-smoke:36` `eq` | **删除** | 零调用；同文件 74 处全用 `assert.equal`。两个判据并存会让后来者不知道该跟哪个。 |
| 5 | `activity-console-count-smoke:83` `textOf` | **删除** | 零调用；10 行树遍历，本套件实际按别的特征定位 chip。原位留注释指向下面现成的查找函数。 |

### 改了什么（具体）

**#1**：`agentToolSrcs` 从「手写 `readFileSync` × 3」改为解构 `readAgentToolSources()`。
**#2**：新增 `allToolSrcs = [docOpsSrc, ...agentToolSrcs2]`，「不自带朴素取法」那条从看 3 个文件改成看 **4 个**；并**另加一条断言**「文档工具也走共享的 resolvePythonExe」——因为放宽成「四处一起扫」之后，必须补一条正控证明它确实用了共享实现，光「没人自带」不够。
**#3/#4/#5**：删函数定义，原位留一段注释说明为什么不需要 + 将来真需要时该用什么。

### 变异证据（两次，都精确命中目标断言）

**变异 A（针对 #2）**：在 `src/main/mcp/agentDocumentOps.ts` 末尾追加一行注释
`// T66_MUTATION: for (const exe of candidates) {}`（只改文本、不改行为）：

```
AssertionError [ERR_ASSERTION]: ★ agent 工具走共享的 resolvePythonExe(不自带「取 PATH 第一个」)
```

**变异 B（针对 #1）**：在 `src/main/mcp/agentWalkGlob.ts` 末尾追加一行注释
`// T66_MUTATION: const SKIP_DIRS = new Set(["coverage"]);`：

```
AssertionError [ERR_ASSERTION]: ★ agent 工具里只有一份 SKIP_DIRS(改用 agentSearchSessions 那份)
```

两次均 `cmp` 逐字节还原（`BYTE-EXACT`）。

> **为什么变异用「加注释」而不是「改行为」**：`agentDocumentOps.ts` 被 `agentTools.ts` import，改它的实现会让 bundle 运行出错、套件以崩溃结束——那是**打包/运行失败，不是断言红**（CLAUDE.md 记过这个坑）。而这两条断言读的是**源码文本**，所以只在末尾加一行会被正则命中的注释，就能精确测到「断言是否真的在读那段文本」，且不干扰运行。
>
> 第一次我确实试了「改回自带候选遍历」，结果套件崩在 `ERR_ASSERTION` 之外的位置 —— 那次变异无效，已丢弃重做。

### 修复前后数字

| 套件 | 改前 | 改后 |
|---|---|---|
| `mcp-text-smoke` | 108 checks | **109 checks**（#2 新增一条正控） |
| `relay-smoke` | 177 条断言 0 红 | 177 条断言 0 红（删死代码不改变判定） |
| `flow-native-param-smoke` | 28/28 | 28/28 |
| `activity-console-count-smoke` | 7/7 | 7/7 |

### 未做的事

- **没改产品源码**：`git status` 确认只有 4 个套件的 `main.ts` 变更。
- **没跑全量**（用户规矩）；**没起 Electron**。
- **没查** `readAgentToolSources` 的 `walkSrc` / `runtimeSrc` 除了 SKIP_DIRS 那条之外还有没有别的用途 —— 本卡只把它接回已有的那条判据。若将来要加「整组里没有第二份 XXX」，直接用这个函数即可。

### 提交

见下方 SHA。
