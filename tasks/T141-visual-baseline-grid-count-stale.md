# T141 — 视觉基线的格数常量过期，token 比对门禁跑不起来

**状态**：`ready-for-agent`
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
