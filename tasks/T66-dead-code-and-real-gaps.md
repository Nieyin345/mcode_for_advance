# T66｜修掉 T61 查出的 5 处「看起来在验、实际没执行」

- Status: ready-for-agent
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
