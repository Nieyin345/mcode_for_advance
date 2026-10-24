# W24｜其余 6 套共用 `electron-u1/build.mjs`，同样的假门禁还在

- Status: ready-for-agent
- Category: **假门禁（W22 的同源问题）**
- Priority: **P1 —— W22 只修了 `t8-node-red-u1` 一个入口**
- Depends on: W22（已交付）
- 来源：W22 执行会话的遗留第 5 条

## ⚠️ 派活时总控核实过：不是 6 套，是 6 套 **+ 一个已经修好的参考实现**

我 grep 了全仓，**8 套有 `?? 1` 兜底**：

```
o0-format-fidelity-smoke/run.mjs:48
o2-conflict-u1-smoke/run.mjs:91          ← 已修，见下
o4-docs-close-smoke/run.mjs:34,51
onlyoffice-sdk-origin-smoke/run.mjs:47
t29-document-view-close-u1/run.mjs:34
t30-document-tools-u1/run.mjs:53
t46-approval-card-u1/run.mjs:31
t7-genoffice-u1/run.mjs:40
```

**但 `?? 1` 本身不是缺陷** —— 关键是**拿到 1 之后它说什么**。
我逐个看了它们有没有「翻译成 PASS」：

| 套件 | 有 `?? 1` | 拿到 1 之后 | 现状 |
|---|---|---|---|
| `o2-conflict-u1-smoke` | 有 | **读 `suite-summary.json`，缺了就 FAIL** | ✅ **已修**（**拿它当参考实现**） |
| `o0-format-fidelity-smoke` | 有 | 打印 `O0: PASS` 并 `exit(0)` | ❌ 待查 |
| `t30-document-tools-u1` | 有 | 打印 `T30: PASS（未跑变异对照）` | ❌ 待查 |
| `t7-genoffice-u1` | 有 | 打印 `T7: PASS` 并 `exit(0)` | ❌ 待查 |
| `o4-docs-close-smoke` | 有 ×2 | 直接 `process.exit(r.status ?? 1)` | 待查是否有 PASS 翻译 |
| `t29-document-view-close-u1` | 有 | `const status = ...` | 待查 |
| `t46-approval-card-u1` | 有 | `const status = ...` | 待查 |
| `onlyoffice-sdk-origin-smoke` | 有 | `process.exitCode = ...` | 待查 |

### 参考实现：`o2-conflict-u1-smoke` 已经踩过这个坑并修好了

它文件头（`:13-25`）的原话：

> ## ⚠️ 构建失败 ≠ 预期红（本文件第一版在这里栽过）
>
> `electron-u1/build.mjs` 在**构建期**崩溃时进程退出码也是 `1` —— 与「旅程按预期红」
> 的退出码完全相同。第一版直接把 exit 1 读成「四个格式按预期红」并打印 PASS，
> 而真实情况是 esbuild 连 `journeys.cjs` 都没打出来（一个模块路径写错）。
> **这是典型的假绿**
>
> 所以本文件不再相信退出码，而是读 `build.mjs` 落盘的
> `suite-summary.json`（`counts` 逐条分类）再下结论；**没有 summary 就是构建
> 失败，一律 FAIL。**

**它的判据是成立的，而且不是代理指标**：因为 `build.mjs` **只在成功构建之后**才落盘
`suite-summary.json`，所以「读不到 summary」是**构建成功的必要条件**，不是推测。

**所以：优先照 `o2` 的做法改其余几套。** 我已经替 W22 的结论（「读产物是代理指标」）
做了修正 —— **W22 用的是更好的方案（完成探针），但 `o2` 这条也成立，且已经跑过**。
两套方案并存可以，但**不要在同一套里混用两种**。

## 任务

### 一、先数清楚：一共几套

**已经数过了（见上表）。** 你要做的是**逐个确认「拿到 1 之后它说什么」**，
把上表里「待查」的四套填满。

**⚠️ 这条要用「按来源区分」而不是「按名字搜」** —— 这个仓库在这上面栽过多次。
`grep electron-u1` 出来的可能包括注释里的提及，那些不是消费者。

### 二、判断每一套是否同病

对每个消费者，问：

1. **它的包装器有没有 `?? 1` 之类的兜底**（把「没跑起来」读成某个正常码）？
2. **构建失败时它退什么码？** 和「旅程按预期失败」的码撞不撞？
3. **它有没有 `T8: PASS` 这种绝对说法**（不管实际结果都打印）？

**把这张表写进回写。**

### 三、修的范围

**两个可参考的实现，先看清各自适用于什么：**

| 实现 | 判据 | 什么时候用 |
|---|---|---|
| **`o2-conflict-u1-smoke`（已修，先看它）** | 读 `suite-summary.json`，**缺了就 FAIL** | 该套件的 `build.mjs` 会在成功构建后落 summary。**最省，且已经跑过** |
| **`t8-node-red-u1`（W22 新修）** | 注入完成探针，看 `beforeExit` | 需要区分「构建失败 / 构建崩溃 / 根本没起来」三档时 |

**我倾向：照 `o2` 做** —— 改一个套件只需要几行，而且它的判据（summary 缺失 = 构建失败）
在这个仓库里是可验证的事实，不是推测。

**除非**某个套件需要区分 4/5/6 三档（比如它自己要按「构建失败」和「spawn 失败」
做不同的重试），那才用 W22 那套。

**⚠️ 不要在同一套里混用两种**，那会让下一个人不知道看哪个判据。

**W22 的模块位置**（如果要用）：

```
apps/desktop/scripts/t8-node-red-u1/wrapper-verdict.mjs   ← classifyChildRun + WRAPPER_EXIT
apps/desktop/scripts/t8-node-red-u1/child-completion-probe.mjs
```

**如果要跨套件复用，把它们移到 `apps/desktop/scripts/lib/`** —— 但移动之后
**必须跑一次 `t8-node-red-u1`** 确认没坏（它现在 import 它们）。

### 四、`--keep` 那个既有 bug

W22 报：

> `--keep` 是既有 bug：`run.mjs` 透传给 `electron-u1/build.mjs`，后者拒收 → 旧包装器同样读成 PASS。

**现在它会被新包装器归到 `build-crashed`（5）—— 至少不再是 PASS。**

**你要做的**：核实这条，然后判断
- 是**修 `--keep`**（让 `build.mjs` 接受它），
- 还是**从 `run.mjs` 的透传里删掉它**（既然没人用），
- 还是**只加一句明确报错**（"`--keep` 不再支持"）。

**我倾向第三个**（最小、最明确）。但如果你查到有人真的在用 `--keep`，那就修它。

## 验收判据

1. **消费者清单**（按来源区分，不是按名字 grep）；
2. **每套是否同病的判断表**；
3. **修完之后每套都有**：「没跑完」与「旅程结论」用不同的码；
4. **`t8-node-red-u1` 不回归**（W22 刚修好，别把它弄坏）；
5. **`--keep` 有明确结论**；
6. **每套都实测一次「构建失败」**（在打包文件里植语法错误 → 确认不是 PASS → 还原并 `sha256sum -c` 核对）；
7. `tsc` EXIT=0；
8. **不跑全量**。

## 边界

**可以改：**

- `apps/desktop/scripts/electron-u1/build.mjs`
- 各套件的 `run.mjs`
- `apps/desktop/scripts/lib/`（若要移共享模块）
- `apps/desktop/scripts/t8-node-red-u1/run.mjs`（**只在移共享模块时，且必须复跑验证**）

**不许碰：**

- `apps/desktop/src/**`
- 各套件的 `journeys/**`（除非某处确实是判据本身）
- `apps/desktop/scripts/mcode-node-pack-smoke/`、`mcode-node-pack-ports-smoke/`、`mcode-agent-capability-smoke/`
- `tasks/T*.md`、`tasks/README.md`、`tasks/workflow/README.md`

**⚠️ 开工第一步** `git status --porcelain apps/desktop/scripts/` —— 有别人在途改动就记下来。

## 回写

`tasks/workflow/W24-other-suites-false-pass.md` 末尾追加 `## 结果回写`：

1. 消费者清单（按来源区分）；
2. 是否同病的判断表；
3. 修了什么、没修什么、为什么；
4. **每套的「构建失败」实测**（退出码是多少，不是 PASS 吧）；
5. `--keep` 的结论；
6. **你没能验证的东西**；
7. **W22 / 这张卡上写错的地方**。

## 一条判断标准

**W22 修的是「一个入口」，不是一个「类别」。**

这个仓库里同一个形态出现过很多次：一个套件修好了，另外几个还带着同样的病。
**修完一个不数一遍，等于只修了一个。**
