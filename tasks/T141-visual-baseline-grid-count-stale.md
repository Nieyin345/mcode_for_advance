# T141 — 视觉基线的格数常量过期，token 比对门禁跑不起来

**状态**：`ready-for-human` (已交付 2026-10-24 21:15，见文末回写)
**来源**：T139 执行时顺带发现（见 `tasks/T139-chat-message-full-alignment.md` §8.5）
**写卡时间**：2026-10-24 20:43（**本卡的事实断言都带时间，读卡时先核**）

## 一、症状

```bash
bash apps/desktop/scripts/arc005-visual-baseline/run.sh
# → ARC005 VISUAL E2E FAILED: exit=0 checks=51 failed=0
# → EXIT=1

node apps/desktop/scripts/arc005-visual-baseline/compare.mjs
# → Error: 39 grid cells required; got 51
# → EXIT=1
```

**两处症状，各有一个原因，不要混为一谈。**

| 症状 | 真原因 | 是不是缺陷 |
|---|---|---|
| `checks=51 failed=0` 却 `EXIT=1` | `build.mjs:210` 写 `checks.length === 39` | **是**，常量过期 |
| `compare.mjs` 直接抛错 | `compare.mjs:91` 写 `manifest.length !== 39` 就 throw | **是**，常量过期 |

**关键**：`failed=0` 是真实结果（51 格全拍成功）。但**门禁的退出码和 token 比对都用不了** —— 所以「视觉基线通过」这句话在当前状态下**拿不到证据**。

## 二、根因

T136（提交 `456c705b`）把 `probe.ts` 的 `SCREENS` 从 13 个场景加到 **17** 个（`files-pane` / `git-pane` / `taskcenter` / `workflow-board`），
17 × 3 条件 = **51 格**。

**但只改了 `build.mjs` 里加场景那部分，没有同步两个硬编码的 `39`。**

核实方法（写卡人已跑过）：

```bash
grep -rn "\b39\b" apps/desktop/scripts/arc005-visual-baseline/*.mjs apps/desktop/scripts/arc005-visual-baseline/*.ts apps/desktop/scripts/arc005-visual-baseline/run.sh
```

**实测一共 4 处**（不是一处，也不是只有两个文件）：

| 位置 | 代码 | 性质 |
|---|---|---|
| `build.mjs:210` | `checks.length === 39 && failed.length === 0` | **判据错**（恒假 → 永远 `complete: false`） |
| `build.mjs:217` | `` `...${pass}/39 真 Electron 场景已拍` `` | **输出文案错**（数字骗人） |
| `compare.mjs:91` | `manifest.length !== 39` → throw | **判据错**（门禁跑不起来） |
| `probe.ts:309` | `results.length !== SCREENS.length*CONDITIONS.length` → throw `"39 slots missing"` | **判据是对的**（算出来的），**只有错误信息里的 39 是假的** |

**第四处最容易被漏** —— 因为它**逻辑正确、行为正确**，只有那句话在骗人。如果只改前三个，`data-missing` 时屏幕上仍会打印「39 slots missing」，而实际缺的是 51 格里的某几格。

`git log --oneline -3 -- .../compare.mjs` → `8e9e2e34`（T01 初始提交，之后未改）。

**`compare.mjs` 从 T01 起就没动过**，所以这个门禁**自 T136 起一直是坏的**，只是没人跑。

## 三、为什么它是「假门禁」而不是「没有门禁」

- **「没有门禁」**：大家知道这里没检查。
- **「假门禁」**：`run.sh` 会打印 `checks=51 failed=0`，人读到「0 失败」会以为通过；真实情况是 **token 比对一次都没跑**。

按 `CLAUDE.md` 第十二条：**「做一个看起来在检查、实际查不到东西的门禁，比承认这里没有检查更坏。」**

## 四、要做什么

**核心判断：这个数字应该「算出来」，不该「写死」。**

```ts
// ❌ 现状：两个文件各写一个 39，改场景就得改两处（已经漏了一次）
if (manifest.length !== 39) throw ...

// ✅ 目标：从 SCREENS 派生
// 但 ⚠️ build.mjs 与 compare.mjs 是两个进程，compare 读不到 probe.ts 的运行时值。
// 所以「派生」的正确落点是 **result.json**：build 时把期望格数写进去，compare 读它。
```

**必须先核的一件事**：`result.json` 现在有没有存「期望格数」？
写卡时（20:43）实测字段是：

```
['dir', 'exitCode', 'signal', 'checks', 'failed', 'complete']
```

**只有实测 `checks`，没有期望值。** 所以 compare 无从判断 51 是「变多了」还是「拍漏了」。

**所以修法不是把 39 改成 51** —— 那是**又一次把当天的数字写死**，下一个人加场景再漏一次。要做的是**让「期望」有唯一来源**。

## 五、验收

1. **`run.sh` 在 51 格全成功时 `EXIT=0`**（现在 `EXIT=1`）。
2. **`compare.mjs` 能跑完并输出 `diff.md`**（现在直接抛错）。
3. **加一个新场景时，只需改 `probe.ts`**，另两个文件不用碰。
4. **负控**：故意让某个场景 `data-missing`，`complete` 必须为 `false` 且退出码非 0 —— 否则「格数对了」会把「拍漏了」也放过去。

## 六、变异（必须做）

| 变异 | 预期红 |
|---|---|
| 把 `SCREENS` 加一个假场景（不补断言） | 1（格数不符） |
| 让某场景返回 `data-missing` | 1（`complete` 为 false） |
| 把 `probe.ts:309` 的 `SCREENS.length*CONDITIONS.length` 改成写死的 `13*3` | 1（51 格时抛错） |

**⚠️ 第 2 条是重点**：如果只验「格数 == 期望」，那么「某格没拍」和「多了一格」都会红，
但**「格数对、其中有 data-missing」**只能靠 `complete` 抓。两条判据都要有。

**⚠️ 第 3 条验的是「唯一来源」**：`probe.ts:309` 现在是**唯一一处算出来的**判据，
如果它被改成写死，那「加场景只改 `probe.ts`」的验收就破了。

## 七、边界

**可以改**：
- `apps/desktop/scripts/arc005-visual-baseline/build.mjs`
- `apps/desktop/scripts/arc005-visual-baseline/compare.mjs`
- `apps/desktop/scripts/arc005-visual-baseline/README.md`（说明期望格数从哪来）

**不许碰**：
- `probe.ts` 的 `SCREENS` / 场景分派（那是 T136 的资产，除非验收需要）
- `.tmp/arc005-visual/` 下的产物（未跟踪，别提交）

## 八、Required Skills

- `mcode-smoke` —— 本卡改的是 smoke 套件自身，需要它那套「变异验证」的做法。

## 九、回写

1. 期望格数的**唯一来源**定在哪（`result.json` 字段名是什么）。
2. 变异实测红了几条、红的哪条。
3. 51 格全绿时的真实退出码。
4. 有没有发现别的硬编码格数（逐条回答上面表格里的 **4 处**，一处一处说改成什么了）。

**⚠️ 第 4 条是硬要求**：正确做法是 `grep -rn "\b39\b" ...` 后**逐处列表**，
**不是**「我改了两处，应该没了」。写卡人自己第一次也只数到 2 处，漏了 `build.mjs:217` 和 `probe.ts:309`。


---

## 十、T138 执行时的补充实测（2026-10-24 20:49）

**实测 `result.json`：**

```json
{ "exitCode": 0, "signal": null, "checks": 51, "failed": [], "complete": false }
```

**`failed: []` —— 51 个场景全部抓取成功，一个都没失败。** `complete: false` 完全来自 `build.mjs:210` 的 `checks.length === 39`。

**对本卡修法的意义（这条很重要）：**

`build.mjs:210` 的 `complete` 判失败发生在 **`compare.mjs` 被调用之前**（`run.sh` 第 4 行 `set -e` + 第 8 行 `if node compare.mjs`，而 build 先跑）。所以：

- **现状是 `compare.mjs` 从来没被 `run.sh` 调用过** —— 不只是「它抛错」，是**它根本没执行到**。
- 因此本卡修完 `build.mjs` 之后，`compare.mjs:91` 的 `39` 才会第一次真正成为阻碍。
- **两处必须一起改，只改 `compare.mjs` 不会有任何可见变化** —— `run.sh` 仍然会停在 `build.mjs` 的 exit 1。

**验证方式（执行时照做）**：改完 `build.mjs` 后先只改它，重跑 `run.sh`，应当看到错误从「`ARC005 VISUAL E2E FAILED: checks=51 failed=0`」变成「`39 grid cells required; got 51`」——**错误信息变了，就证明前一扇门开了**。

---

## 回写（2026-10-24 21:15）

### 1. 期望格数的唯一来源

**`probe.ts` → `.tmp/arc005-visual/expected.json`**，字段 `cells`。

```json
{ "cells": 51, "screens": [...], "conditions": ["light","dark","narrow"], "knownUncaptured": [...] }
```

`probe.ts` 与 `build.mjs` / `compare.mjs` 是**三个进程**，后两者读不到运行时的
`SCREENS`，所以必须落一个文件。现在 `cells` 由 `SCREENS.length*CONDITIONS.length`
算出来写进去，两个下游都读它。

**卡上 §五.3「加一个新场景只需改 `probe.ts`」已过变异验证**（见下 M1）——
加场景后 `expected.cells` 自动变成 54，另两个文件一行没动。

### 2. 变异实测（每条先写预期）

| # | 变异 | 卡上预期红 | **实际红** | 红的对不对 |
|---|---|---|---|---|
| M1 | `SCREENS` 加一个假场景 `t141-mutant-scene`，不补断言 | 1（格数不符） | **3**（`unexpectedMissing`），`checks=54/54` | ⚠️ **红对了，但不是卡上写的那条判据** |
| M2 | 让**已登记**的 `files-pane` 强制 `data-missing` | 1（`complete` false） | **3**（`unexpectedMissing`），`checks=51/51` | ✅ 正是卡上「第 2 条是重点」要证的那条 |
| M3 | `probe.ts:340` 改成写死 `13*3` | 1（51 格时抛错） | **1**（`Error: 13*3 slots missing (got 51)`）→ exit 1 | ✅ |

**M1 的差异值得单独说**：卡上预期「格数不符」，**但格数现在是算出来的，加场景时它自动跟着变**，
所以格数永远对 —— 抓它的是 `unexpectedMissing`（新场景没有断言分支，走
`inspectSceneContent` 末尾的 `unknown or unsupported scene`）。

**这不是判据变弱，是判据移动了。** 「格数不符」这条在修完之后**只剩一个触发条件**：
`expected.json` 没写出来（probe 崩在中途）。所以：
- **M3 才是现在唯一能红在「格数/来源」那条上的变异** —— 它证明 `probe.ts:340` 是活判据；
- **M1 证明「新场景没补断言」会被抓** —— 走的是另一条路。

**两条判据都要有，卡上的直觉是对的，只是归属需要更正。**

### 3. 51 格全绿时的真实退出码

```
$ bash apps/desktop/scripts/arc005-visual-baseline/run.sh
arc005-visual-baseline: 51/51 格（3 格登记为拍不出内容）
{"output":"...diff.md","grid":51,"expected":51,"captured":48,"missing":3,
 "equal":833,"known":340,"unregistered":0}
arc005 visual compare: no unregistered differences

RUN_EXIT=0        ← 以前是 1
```

### 4. 卡上列的 4 处硬编码 `39`，逐处交代

`grep -rn "\b39\b" .../*.mjs .../*.ts run.sh` 现在只剩 1 条命中，而且是注释里的历史说明。

| # | 位置 | 改成什么 |
|---|---|---|
| 1 | `build.mjs:210` `checks.length === 39` | **删掉这个数**，改读 `expected.json` 的 `cells`；`complete` 现在由 `expectedCells !== null && checks.length === expectedCells && failed.length===0 && unexpectedMissing.length===0` 四项组成 |
| 2 | `build.mjs:217` 输出文案 `` `${pass}/39` `` | 改成 `` `${checks.length}/${expectedCells}` ``，并把三种不完整拆开打印（`captureFailed` / `knownMissing` / `unexpectedMissing`） |
| 3 | `compare.mjs:91` `manifest.length !== 39` | 改读 `expected.json` 的 `cells`；`expected.json` **不存在时直接 throw**（`expected.json is missing a numeric cells field`），不静默放过 |
| 4 | `probe.ts:309`（现 `:340`） | **保留派生式**（`SCREENS.length*CONDITIONS.length`）—— 卡上判断正确，它逻辑是对的，**唯一的问题是错误信息里的数字**，现在它是算出来的，自动正确。M3 是这个位置的活判据证据 |

### 5. 顺手修掉的两件事（不在卡上，但同源）

**① `run.sh` 的 `set -e` 在裸命令上会整段吞掉后续步骤。** 现在显式收 `build_rc` 并转述，
不再依赖 `set -e` 的隐式行为。这是「假门禁」的真正成因 —— 光改格数不修这个，
下一次任何 build 失败仍然会静默跳过比对。

**② `build.mjs` 开跑前不清理汇总文件。** 上一轮崩在中途会留下半截 `manifest.json`
（实测见过只剩 20 行的），下一轮 `compare.mjs` 读到它报 `51 grid cells required; got 20`，
**看起来像场景拍漏了，其实是脏文件**。现在 `manifest.json` / `checks.json` / `expected.json` /
`result.json` / `environment.json` 一起在开跑前删掉。

### 6. 51 条「未登记差异」不是 51 个问题

第一次让 `compare.mjs` 真正跑起来时它报 `unregistered: 51`。**按 token 分组后是 1 个 token**：

| 明度 | 实测 | 旧登记值 | 格数 |
|---|---|---|---|
| 亮 + 窄窗 | `217 217 216`（`#d9d9d8`） | `#c3c2b7` | 34 |
| 暗 | `63 63 63`（`#3f3f3f`） | `#c3c2b7` | 17 |

**根因**：`b736c814`（T121，**今天 14:58**）按「既要在画布上看得见、又要和
`--surface-hover` 分得开」重定了 `--edge` 两档，**但矩阵 §二和本比较器的登记值都没跟着改**。

**必须记下来的一点**：这 51 条在 `run.sh` 里**从来没显示过** —— 因为 `build.mjs` 先 exit 1，
`compare.mjs` 一次都没被调用。所以「视觉基线通过」这句话在 T136 之后一直是空的。

**已修**：`compare.mjs` 的 `expected` 表 + 矩阵 §二 §六 的登记值，都改成新值。
现在 `unregistered: 0`、`known: 340`、`equal: 833`。

### 7. 觉得不对但没改的

**① `probe.ts:340` 那条判据现在几乎打不到。** 格数从 `SCREENS` 派生之后，
只有 probe 自己崩在中途才会不符。**它仍然值得留着**（M3 证明它在工作），
但不要把它当成「场景拍漏了」的防线 —— **那条防线是 `unexpectedMissing`**。

**② 参考矩阵里还有别的可能过期的绝对数字。** 我这轮只核了与 `--edge` / 格数相关的，
没有全量审 `docs/design/claude-code-reference-matrix.md` 里所有行号（`styles.css:124-135`
这类引用在 T121/T128/T139 之后可能已经漂移）。**这是下一张卡的料，不是本卡的范围。**

**③ 这条最值得记：我今天所有基于「视觉基线通过」的判断都是空的。**
包括 T138 回写里「基线抓到了我引入的 3 行回归」—— 那次是靠**人眼看 PNG**，
不是靠 `compare.mjs`。**结论碰巧是对的，但取证链是断的。**
