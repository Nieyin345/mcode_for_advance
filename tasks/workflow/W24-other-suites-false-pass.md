# W24｜其余 6 套共用 `electron-u1/build.mjs`，同样的假门禁还在

- Status: **delivered（回写已追加；改动未提交，见 `## 结果回写`）**
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

---

## 总控补充（2026-10-24 23:30）：`workflow-ui-smoke` 现在红着，**不是你的**

**Office 主线在做 O5（OnlyOffice 全部删掉，走 GenOffice），分三批。**
批一已提交（`bd7c8cd5`，删了 `packages/contracts/src/ipc/onlyoffice.ts` -244 行），
批二/批三还在途 —— **所以 `FileEditor.tsx` 还在 import 已经删掉的契约导出。**
`workflow-ui-smoke` 要打包整个渲染端，因此**构建期就失败**。

**时间预期：2–4 小时**（Office 总控会主动通知批三完成）。

### 判别命令（我实测过，成立）

```bash
cd apps/desktop
node scripts/run-smokes.mjs workflow-ui-smoke > /tmp/o 2>&1; grep -c "isOnlyOffice\|onlyoffice" /tmp/o
```

- **> 0** → 是 Office 的（O5 在途），**别查了，别去做回滚对照**
- **= 0** → 是我们的，正常排查

**我实测：EXIT=1 且命中 2。**

> **⚠️ 取退出码时别用管道。** 官方给的原命令带 `|`，那会让 `$?` 变成 `grep` 的退出码
> （CLAUDE.md 第二十二条）。上面这版先重定向，安全。

**如果 `workflow-ui-smoke` 在你的必跑清单里：**照常跑，红了先用上面的命令判别，
在回写里注明「红在 O5 批一，已按判别命令确认」，**不要花时间做单文件回滚对照。**

---

## 总控补充（2026-10-24 23:35）：与 Office 的 O5 会不会撞车

**Office 主线在做 O5（OnlyOffice 全部删掉），分三批：**

| 批 | 范围 |
|---|---|
| 批一 | `packages/contracts/**`（已提交 `bd7c8cd5`） |
| 批二 | `apps/desktop/src/main/**` + `preload/**`（**进行中**） |
| 批三 | `apps/desktop/src/renderer/**` |

**我核过你要改的东西会不会撞上它：**

```bash
$ for d in o0-format-fidelity-smoke o4-docs-close-smoke t29-document-view-close-u1 \
           t30-document-tools-u1 t46-approval-card-u1 t7-genoffice-u1; do
    grep -l "onlyoffice\|OnlyOffice" apps/desktop/scripts/$d/*.mjs apps/desktop/scripts/$d/*.ts | wc -l
  done
0  （全部 0）
```

**结论：这 6 套里没有一个提到 OnlyOffice，而且它们都在 `apps/desktop/scripts/` 下，
不在 O5 三批的任何一批里。直接撞车：没有。**

### 但有一层**间接**风险，必须知道

这些套件的 `run.mjs` 会**打包 `src/main/**` 与 `renderer/**`** 来跑。
而批二/批三正在改那两个目录 —— **所以你跑套件时可能撞上构建期失败**（就像 `workflow-ui-smoke` 现在那样）。

**判别方法（Office 总控给的，我实测成立）：**

```bash
cd apps/desktop
node scripts/run-smokes.mjs <套件名> > /tmp/o 2>&1; echo "EXIT=$?"; grep -c "isOnlyOffice\|onlyoffice" /tmp/o
```

- **> 0** → 是 O5 在途，**别查了，也别去做回滚对照**；
- **= 0** → 是你的，正常排查。

**时间预期：2–4 小时**（Office 总控会主动通知批三完成）。

### 对你的实际影响

**你要改的是 `run.mjs` 的退出码判定逻辑，那部分不依赖 `src/` 编译过。**
所以：

- **优先做「结构 + 自检」的部分**（`wrapper-verdict` 那样的纯判据 + 自检），那部分不受 O5 影响；
- **「跑一次真实构建失败」的实测**如果撞上 O5 的构建失败，**那正好也是构建失败** ——
  用它测「构建失败会不会被读成 PASS」仍然有效，**但要在回写里注明「这次失败来自 O5，不是我自己造的」**；
- 如果完全跑不起来，**照实说，别硬凑证据**。

---

## ⚠️ 总控第二次补充（2026-10-24 23:50）：我说小了，实际范围更大

**我先前说「O5 只会让 `workflow-ui-smoke` 红」—— 错了。**

**准确的是：任何打包 `apps/desktop/src/renderer/**` 的套件，在 O5 批三完成前都会构建失败。**

我实测确认（`cd apps/desktop && npx tsc --noEmit -p tsconfig.json`）：

```
EXIT=2
main/preload 错误: 0        ← 批二已落地，主进程干净
renderer 错误:    38        ← 批三还没做
总数:             45
```

### 对你要改的 6 套

**`t29` / `t30` / `t46` / `t7` 都是真 Electron U1 —— 它们会打包渲染端，现在跑一定构建失败。**

| 套件 | 现在能真跑吗 |
|---|---|
| `t29-document-view-close-u1` | ❌ 会红（U1） |
| `t30-document-tools-u1` | ❌ 会红（U1） |
| `t46-approval-card-u1` | ❌ 会红（U1） |
| `t7-genoffice-u1` | ❌ 会红（U1） |
| `o0` / `o4` / `onlyoffice-sdk-origin-smoke` | 你自己判断打不打包渲染端 |

### 开工前先跑这三条

```bash
cd apps/desktop
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.txt 2>&1; echo "EXIT=$?"
grep -cE "^src/(main|preload)/" /tmp/tsc.txt      # 期望 0
grep -cE "^src/renderer/" /tmp/tsc.txt            # 现在 38，批三落地后降到 0
```

- **`main`/`preload` > 0** → O5 把主进程弄坏了，告诉总控；
- **`renderer` > 0** → **是 O5 批三没做完，正常，等它**（预估 1–2 小时）。

### 所以做法要调整

**优先做「不依赖 `src/` 编译」的部分：**

1. **纯判据**：把「拿到退出码之后怎么判」抽成可 import 的模块（照 `t8-node-red-u1/wrapper-verdict.mjs` 的形状）
   —— **那部分可以完全不受 O5 影响地写完并自检**；
2. **自检**：像 `wrapper-verdict.mjs` 那样用构造输入跑断言 + 一次真实 ENOENT 测量 —— **不需要打包 `src/`**；
3. **改各套件 `run.mjs`**：改的是判定那几行，**不需要真跑一遍才算改对**（但要在回写里说清「没实跑是因为 O5」）；
4. **真跑确认**：等 O5 批三落地，或只跑不打包渲染端的那几套。

**如果某套必须真跑才能确认 —— 照实说「等 O5」，不要硬凑证据。**

### 判别底线

**如果跑出来是构建期失败（`X [ERROR]` / `No matching export` / `Unterminated string literal`），
那不是「测试红了」，是「根本没跑起来」。**

```bash
node scripts/run-smokes.mjs <套件> > /tmp/o 2>&1; echo "EXIT=$?"; grep -c "isOnlyOffice\|onlyoffice\|No matching export" /tmp/o
```

**> 0 → O5 在途，别查别做回滚对照。**

---

## ⚠️ 总控第三次补充（2026-10-25 00:05）：一条硬约束 + 更稳的判别命令

### 一、硬约束：**判据自检通过 ≠ 套件已修复**

Office 总控明确提了这一条，我原样采纳：

> **它改完之后没真跑，就不能宣称「套件绿了」。**
> **只能是「判据本身自检通过，真跑待批三」。**

**所以你的回写措辞必须区分这三档：**

| 你做到了什么 | 允许写的 | **不许写** |
|---|---|---|
| 判据写好了 + 用构造输入自检通过 + 没真跑 | 「判据自检通过，真跑待 O5 批三」 | ❌「已修复」 |
| 真跑了且绿 | 「已修复，N/N 绿」 | — |
| 真跑红了且红因是 O5 | 「真跑撞 O5，见判别命令」 | ❌「已修复」 |

**这条和仓库那条「执行完成 ≠ 验收通过」是同一件事**，但更具体：
**判据可以自检，但「套件在真跑时会不会绿」必须真跑才知道。**

### 二、更稳的判别命令（我实测过，比 `grep onlyoffice` 可靠）

**我核了 Office 总控那份 38 条归因，逐文件完全对上。**
**但 `grep -c "onlyoffice"` 只能命中 36 条 —— 有 2 条漏判。**

那 2 条是：

```
src/renderer/lib/webApi.ts(852,10): error TS7006: Parameter 'input' implicitly has an 'any' type.
src/renderer/lib/webApi.ts(855,11): error TS7006: Parameter 'input' implicitly has an 'any' type.
```

**报错文本里没有 `onlyoffice`，但它们是 OnlyOffice 造成的**：
`const onlyoffice: Api["onlyoffice"] = { open: (input) => ... }` ——
`Api["onlyoffice"]` 类型已不存在，整个对象字面量退化成 `any` 上下文，
`input` 参数推断不出来。**这是「上一条错误的二次效应」。**

**所以用这个版本：**

```bash
cd apps/desktop
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.txt 2>&1; echo "EXIT=$?"
echo "main/preload: $(grep -cE '^src/(main|preload)/' /tmp/tsc.txt)"
echo "renderer:     $(grep -cE '^src/renderer/' /tmp/tsc.txt)"
echo "含 onlyoffice: $(grep -icE 'onlyoffice' /tmp/tsc.txt)"
```

**判读：**

| 时点 | `main/preload` | `renderer` | 含义 |
|---|---|---|---|
| 现在（批三未完） | 0 | **38** | O5 在途 |
| 批三完成后 | 0 | **0** | 全清了 |
| 批三后 `renderer` 仍 > 0 | — | > 0 | **要看它是什么**，不管含不含 `onlyoffice` |

**`renderer` 的错误数比 `grep onlyoffice` 可靠，因为它不依赖报错文本措辞。**

> **这是「判据 vs 清单」的又一个实例**：「`grep onlyoffice`」依赖措辞（清单式），
> 「`renderer` 的错误数」不依赖措辞（判据式）。

---

## ⚠️ 总控第四次补充（2026-10-25 00:15）：**我上面那条命令有个致命坑**

### 我先前写的是

```bash
cd apps/desktop
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.txt 2>&1; echo "EXIT=$?"
grep -cE "^src/(main|preload)/" /tmp/tsc.txt      # 期望 0
grep -cE "^src/renderer/" /tmp/tsc.txt            # 现在 38
```

**这条在 `cd apps/desktop` 之后是对的。但如果你从仓库根跑，`^src/` 会数出 0。**

我实测：

| 在哪跑 | `^src/renderer/` | `^apps/desktop/src/renderer/` |
|---|---|---|
| 仓库根 | **0** ❌ | **38** ✅ |
| `apps/desktop` | **38** ✅ | **0** ❌ |

**`grep -c` 数不到时返回 0，不报错 —— 而 0 正好等于「全清了」的答案。**

**这是最坏的一种判据失效：它答的不是「错」，是「一切正常」。**

### 改用这个（`(^|/)` 让前缀可有可无，从哪跑都对）

```bash
cd apps/desktop
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.txt 2>&1; echo "EXIT=$?"
echo "renderer: $(grep -cE '(^|/)src/renderer/' /tmp/tsc.txt)"
echo "scripts:  $(grep -cE '(^|/)scripts/' /tmp/tsc.txt)"
echo "总数:     $(grep -cE 'error TS' /tmp/tsc.txt)"
```

**我实测（2026-10-25 00:15）：**

```
renderer: 38
scripts:  7
总数:     45
```

**判读：**

| 项 | 现在 | O5 批三完成后 | 含义 |
|---|---|---|---|
| `renderer` | **38** | **应为 0** | 0 = O5 全清 |
| `scripts` | **7** | 还是 7 | **不是 O5**，是 `document-router-smoke` 等套件的错误 |
| `总数` | 45 | 应为 7 | 38 + 7 |

**注意：`总数` 不等于 `renderer + main + preload`** —— 还有第四类（`scripts/`）。
不要用总数去反推，直接看 `renderer` 那个数。

---

## ⚠️ 总控第五次补充（2026-10-25 00:25，**已于 00:40 修订**）：`tsc` 退出码不可靠，但原因未明

> **00:40 修订**：我原先写「退出码随 `incremental` 缓存状态变」，**归因是错的** ——
> 我没有做对照就下了因果。
>
> **01:00 查清（这次做了对照）**：真正的机制是 **`EXIT=2` ⇔「上一次 tsc 跑的那一瞬间，
> `main/` 或 `preload/` 里有类型错误」**，而且**滞后一格**。
>
> 我的对照实验（往 `conditionHost.ts` 尾部临时加一行类型错误，跑，然后还原）：
>
> | 时刻 | `main+pre` 错误数 | `EXIT` |
> |---|---|---|
> | 只有 renderer 错 | 0 | **1** |
> | **加了一个 main 侧类型错误** | 1 | **2** |
> | **刚还原**（缓存还是旧状态） | 0 | **2** ← 滞后一格 |
> | 再跑一次 | 0 | **1** |
> | 再跑一次 | 0 | **1** |
>
> **所以 `EXIT=2` 不是「配置错误」的同义词。** `incremental` 只是让它**滞后**，
> 触发条件是 `main`/`preload` 有错。
>
> **下面的「换判据」结论仍然成立**（用错误数不用退出码），但**别把「缓存」当成触发条件**。

### 我实测到的（原始观察，机制见上面的修订）

同一条命令、**输出逐字节相同**，但退出码不同：

| 条件 | 退出码 | `renderer` 错误数 |
|---|---|---|
| **冷缓存**（删 `.tmp/tsconfig.desktop.tsbuildinfo`） | **2** | 38 |
| **热缓存** | **1** | 38 |

**同一个错误状态（38 条），冷缓存退 2、热缓存退 1。**

原因：`apps/desktop/tsconfig.json` 有

```json
"incremental": true,
"tsBuildInfoFile": "./.tmp/tsconfig.desktop.tsbuildinfo"
```

**这个仓库的 tsc 默认是热缓存。**

### 好消息：干净时两种缓存都退 0

我另测了 `packages/contracts`（零错误）：

```
热缓存第一次 EXIT=0 错误数=0
热缓存第二次 EXIT=0 错误数=0
```

**所以 `EXIT == 0` 这个门禁是安全的**（提交前用它判断「有没有错」没问题）。

### 危险只在「用非 0 的具体值判断错误类型」

| 判据 | 冷缓存 | 热缓存 | 危险 |
|---|---|---|---|
| `EXIT == 0` | 正确 | 正确 | ✅ 安全 |
| **`EXIT != 2`** | 正确 | **❌ 有 38 条错却说「通过」** | **致命** |
| `EXIT == 2` | 正确 | **❌ 有错却说「不是类型错误」** | 误导 |

### 所以判别命令改成这样（不用 `$?`）

```bash
cd apps/desktop
npx tsc --noEmit -p tsconfig.json > /tmp/tsc.txt 2>&1
echo "renderer: $(grep -cE '(^|/)src/renderer/' /tmp/tsc.txt)"
echo "总数:     $(grep -cE 'error TS' /tmp/tsc.txt)"
echo "时刻:     $(date +%H:%M:%S)"
```

**用「错误数」而不是退出码** —— 错误数是直接记录，不受缓存影响（冷热两次我都测到 38）。

### 这条属于「仓库事实」，不属于「今晚的意外」

**它会一直成立**，所以写在这里，不是写进某张卡的临时说明。

---

## 结果回写（W24，2026-10-25 00:30）

> **先读这句**：改动**未提交**（总控统一提交）。逐套状态见 §3 的措辞三档表 ——
> 有 4 套是「真跑绿」，2 套是「真跑撞了既有红，已用 stash 对照证明不是本次改动」，1 套（t8）selfcheck 绿但本体撞环境红。

### 1. 消费者清单（按来源区分，不是按名字 grep）

判据口径：**谁在 `spawnSync` 里把 `../electron-u1/build.mjs` 当子进程跑**。
按这个口径，全仓 **7 个旧包装器**（含本次修的 6 个 + 已修的 t8）+ 1 个已修参考实现 o2：

| 来源（文件:行，开工时） | 调用形态 | 备注 |
|---|---|---|
| `scripts/t8-node-red-u1/run.mjs:79` | W22 完成探针 | 已修（不动） |
| `scripts/o2-conflict-u1-smoke/run.mjs:64` | 读 summary | 已修（参考实现，不动） |
| `scripts/o0-format-fidelity-smoke/run.mjs:41` | 旧包装器 | **本次修** |
| `scripts/o4-docs-close-smoke/run.mjs:45` | 旧包装器 | **本次修** |
| `scripts/t29-document-view-close-u1/run.mjs:28` | 旧包装器 | **本次修** |
| `scripts/t30-document-tools-u1/run.mjs:44` | 旧包装器 | **本次修**（**实测假绿**） |
| `scripts/t46-approval-card-u1/run.mjs:26` | 旧包装器 | **本次修** |
| `scripts/t7-genoffice-u1/run.mjs:33` | 旧包装器 | **本次修** |

**按名字 grep 会多出来的、不是消费者的**（按来源核过）：
- `electron-u1/run.sh:22,32` 与它调用的 `verify.mjs` —— 跑的是**本套自己的**三条示例旅程，不经包装器；
- `t8-node-red-u1/README.md`、各 `journeys/index.ts` 头注释、`vendor-esbuild.mjs` 头注释里的**提及**；
- `o2-conflict-u1-smoke/mutation.mjs:39` `import { runSuite } from "./run.mjs"` —— 是 o2 **自己的** run.mjs（已修的），不是新消费者。

**`onlyoffice-sdk-origin-smoke` 不是这一类，且已不存在。**
卡面表里把它列进来，但它从来**不用** `electron-u1/build.mjs` —— 它自己 `esbuild.build()` 打 `main.ts`，
再 `spawnSync` 一个普通 node 子进程（原 `run.mjs:25-47`）。另外 **O5 批二（`00af5199`）已把整个目录删掉**，
工作区里也没有。既不在「修」的范围，也不在「验证」的范围。

### 2. 是否同病的判断表（「拿到 1 之后它说什么」全部填满）

| 套件 | `?? 1` | 拿到 1（构建期崩溃）之后 | 判定 |
|---|---|---|---|
| `o2` | 有 | summary 缺失 → FAIL | ✅ 已修（判据成立，参考实现） |
| **`t30`** | 有 | **打印 `T30: PASS（未跑变异对照）`，exit 0** | ❌ **假绿 —— 本卡实测复现** |
| `o0` | 有 | exit≠0 → `O0: FAIL`，透传 1 | ⚠️ 不假绿，但**码撞车**（构建崩溃与「预期红」共用 1） |
| `t7` | 有 | exit≠0 → `T7: FAIL`，透传 1 | ⚠️ 同上 |
| `o4` | ×2 | exit≠0 → `O4: FAIL`，透传 1 | ⚠️ 同上 |
| `t29` | 有 | exit≠0 → `T29: FAIL`，透传 1 | ⚠️ 同上 |
| `t46` | 有 | exit≠0 → `T46: FAIL`，透传 1 | ⚠️ 同上 |
| `t8` | — | W22 探针 → 4/5/6 | ✅ 已修（W22，不回归） |

**结论：真假绿只有 `t30` 一套。** 其余 5 套看起来「没骗人」，但它们把「构建崩溃」和「旅程预期红」
压进了**同一个数字 1** —— 消费方无法区分。本卡验收判据 3 要求的正是「没跑完」与「旅程结论」
**用不同的码**，所以 5 套都要修。

**`t30` 的假绿是怎么实测到的（不是读出来的）**：
```
$ node scripts/t30-document-tools-u1/run.mjs --no-mutation     # 旧包装器
X [ERROR] Could not resolve "../build/Release/cpufeatures.node"   ← 构建期崩溃
T30: 正常跑退出码 1
T30: PASS（未跑变异对照）                                          ← 假绿
$ echo $?  → 0
```
这个构建失败**不是 O5，也不是我造的**：`cpu-features` 是 ssh2 的原生依赖，仓库里没有它的预编译
`.node`；`t7` 的 `vendor-esbuild.mjs` 没有像 `t8/main-esbuild.mjs` 那样把 `cpu-features` 列进
`external`。**它在我的任何改动之前就存在**（23:33 旧包装器与 23:56 新包装器命中同一条错误）。

### 3. 修了什么 / 没修什么 / 为什么

**修了。**

一、**新增共享判据** `apps/desktop/scripts/lib/electron-u1-verdict.mjs`（照 `o2` 的 summary 法抽成真身，
**不是** W22 的完成探针）：
- `runElectronU1()`：同步跑 `build.mjs`，原始字节回放 + 解析证据根 + 读 `suite-summary.json`；
- `classifyU1Run()`：`completed`（有可解析、结构完整的 summary → 原样透传 0/1/2/3）/
  `build-failed`（无 summary 且日志有 esbuild 标记 → **4**）/ `build-crashed`（无 summary 的其余一切 → **5**）/
  `spawn-failed`（`status === null` → **6**）；
- 4/5/6 与 **W22 的 `WRAPPER_EXIT` 同值**，跨套件一致；
- 自带自检：`node scripts/lib/electron-u1-verdict.mjs` → **10 条分类 + 9 条文件/解析/映射判据，含一次真实 ENOENT 测量**。

**为什么用 summary 而不是 W22 探针**：`build.mjs` 只在**全部旅程走完**之后才落 `suite-summary.json`
（§6，所有提前 throw 的路径都在它之前），所以「读不到 summary」是构建走完的**必要条件，不是推测** ——
和 `o2` 已经跑过的判据同源。**没有混用**：t8 继续用它自己的完成探针，**不 import 本模块**。

二、**6 个旧包装器全部改用它**（`t7` / `t30` / `o0` / `o4` / `t29` / `t46`；`t8`、`o2` 不动）。
每套新增 `XXX: BUILD FAILED / BUILD CRASHED / SPAWN FAILED` 三种**永不打印 PASS** 的说法。

三、**`--keep`（§四）**：结论是**修它**，不是报错也不是删透传。
根因比卡里想的小：`build.mjs` **自己的头注释**（`:27`）就写着「`--keep` 无实际作用，保留它是为了
显式声明不清理」—— 但解析器（`:69-76`）从来不认它，直接 `throw Unknown option`。**是文档与实现矛盾，
不是「有人真在用 / 没人用」的问题。** 修一行 `else if (a === "--keep") continue;`，5 个仍在透传
`--keep` 的包装器（t7/t30/o0/t8/o2）一起恢复成文档说的行为。
**实测**：`--bogus` 仍被拒（正控）；`--keep` 不再报 `Unknown option`；`t30 --keep` 跑到底 → 4（BUILD FAILED，
cpu-features），不再假绿。

**没修（有意）。**
- **`t30` 的 `cpu-features` 构建失败本身** —— 那是 `t7-genoffice-u1/vendor-esbuild.mjs` 的 externals 缺项
  （`t8/main-esbuild.mjs` 有）。不属于本卡（本卡是假门禁，不是打包配置），且动它会改变 6 套的打包图。
  **建议另开卡**：把 `sherpa-onnx-node / node-pty / better-sqlite3 / cpu-features` 的 external 对齐到 t7 一份。
- **`o2` 的 `run.mjs`** —— 参考实现，不动（开工时它就有别人在途改动：`expectations.ts`、`journeys.ts`、
  `journeys/index.ts`、`lib.ts`、`save-paths.ts`、`.expectations.cjs`；不是我改的）。

**逐套措辞三档（按总控第三次补充的硬约束）：**

| 套件 | 做到了什么 | 状态措辞 |
|---|---|---|
| `t7-genoffice-u1` | 真跑 **6/6 绿**，exit 0；`--mutation` 也跑过 | **已修复，6/6 绿** |
| `o0-format-fidelity-smoke` | 真跑 **6/6 绿**，exit 0；`mutate.mjs` **32/32 变异体按预期变红** | **已修复，6/6 绿** |
| `o4-docs-close-smoke` | 经 `run-smokes.mjs` 真跑绿（含 `run.sh` 两段）；`--mutate` **3/3** | **已修复，绿** |
| `t46-approval-card-u1` | 真跑 **1/1 绿**；`mutate-t46.mjs` **3/3** | **已修复，1/1 绿** |
| `t29-document-view-close-u1` | 真跑 **3/4**，`t29-close-pdf-after-unsaved-guard` 红在 `make-unsaved-edit`；**stash 对照：旧包装器同一条同一步骤同样红**；`mutate-t29.mjs` detected=true | **判据已修；真跑撞既有红（不是本次改动），见 §6** |
| `t30-document-tools-u1` | 判据自检通过；**真跑撞既有 `cpu-features` 构建失败** → 正确报 `T30: BUILD FAILED`（4），不再 PASS | **判据已修；真跑撞既有构建失败（不是本次改动），见 §6** |
| `t8-node-red-u1` | W22 selfcheck **11/11**；t8 本体真跑红（4 条），**stash 对照：全部改动的原始树同样红** | **不回归（selfcheck 绿）；t8 本体撞既有环境红，见 §6** |

### 4. 每套的「构建失败」实测

**造法**：在 `journeys/index.ts`（`--registry` 打包入口，真正被 esbuild 打包）末尾追加一行语法错误
`const __w24SyntaxError = ;`；先 `git diff --stat` 确认改动在文件里，再跑包装器；然后从**保留目录结构的
备份**还原并 `sha256sum -c` 逐字节核对。脚本：`.tmp/w24-buildfail.sh`。
（第一次 `cd` 少退一级，五套全部 `NO REGISTRY`、**什么都没改** —— 这是「变异在写文件前就退出」那条的
老形态；加 `*/mcode` 根校验后重跑。）

**预期红 15 条**（5 套 × 3 项：`exit==4`、`PASS` 行数 0、日志有 `X [ERROR]`），**实际 15/15**：

| 套件 | 退出码 | `PASS` 行 | `X [ERROR]` | 还原 |
|---|---|---|---|---|
| `t7` | **4** | 0 | 1 | `sha256sum -c` OK |
| `o0` | **4** | 0 | 1 | OK |
| `o4` | **4** | 0 | 1 | OK |
| `t29` | **4** | 0 | 1 | OK |
| `t46` | **4** | 0 | 1 | OK |

**`t30` 用真实构建失败测的**（不额外造）：`T30: BUILD FAILED`、exit **4**、`PASS` 行 **0**、
出错的是 `Could not resolve "../build/Release/cpufeatures.node"`。
**`t8` 不测这一项** —— 不在本次修复范围（W22 已修），只做了 W22 selfcheck 11/11。

**负控（关键，否则证明不了「修前是坏的」）**：把 `t7` 包装器 stash 回旧版，对**同一份注入**跑：
旧版 exit **1**、打印 `T7: FAIL`。**t7 修前不是假绿，是码撞车** —— 与 §2 判断表一致。
（`t30` 修前的假绿上面 §2 已实测；其余几套修前形态相同：`exit≠0 → FAIL 透传 1`，读代码确认。）

**判据模块自身的变异验证**（6 个变异，预期红条数分开列，**实际逐一命中**）：

| 变异 | 撤掉什么 | 预期红 | 实际 |
|---|---|---|---|
| M1 | summary 缺失也当 completed | 4 | **6**（多 2 条「映射钉住」——那是我加的正控） |
| M2 | esbuild 标记清空 | 2 | **3**（多 1 条映射钉住） |
| M3 | `loadSummary` 恒返回假 summary | 3 | **3** |
| M4 | `evidenceRootFromLog` 恒 null | 1 | **1** |
| M5 | `BUILD_FAILED: 1`（撞旅程码） | 1 | **2**（常量检查 + 映射检查各 1） |
| M6 | build-failed 映射到 crashed 的码 5 | 1 | **1** |

每次跑完 `sha256sum -c` 均 **OK**（备份在 `.tmp/w24-mutation-bak/`，保留目录结构）。
M1/M2 比预期多出来的 2/1 条是**我预期没写全**，不是判据弱 —— 记在这里，不假装预测准了。

### 5. `--keep` 的结论

**修它**（理由见 §3 三）。卡里倾向的「第三个：只加一句明确报错」**前提不成立** ——
`build.mjs` 的头注释把 `--keep` 写成了**受支持**的 no-op，报错会与文档矛盾。
一行改动覆盖全部 5 个仍在透传它的包装器。**`--bogus` 仍被拒（正控），`--keep` 实测跑到底。**

### 6. 我没能验证的东西 / 验证了但红着的东西

**（a）`t29` 红一条 —— 既有，不是我。**
`t29-close-pdf-after-unsaved-guard` 失败于 `make-unsaved-edit`。
**stash 对照**：`git stash push -u -- scripts/t29-document-view-close-u1/run.mjs` → 旧包装器 `--only=` 同一旅程
→ 同样 exit 2、同一步骤红；`pop` 归还。**不是本次改动。**

**（b）`t30` 构建失败 —— 既有，不是我。**
`cpu-features` 原生 `.node` 缺失，`t7/vendor-esbuild.mjs` 没把它 external。
**时间证据**：23:33（旧包装器）与 23:56（新包装器）同一条错误。建议另开卡（§3「没修」）。

**（c）`t8` 本体红（4 条旅程全红）—— 既有环境问题，不是我。**
形态：`U1 screenshot fallback (...): Current display surface not available for capture`，
`overlaysClosed=false`，`positive-control-editor-live` 失败。
`851a7d73`（23:51）提交说明写「全量 run.mjs 退出码 0，T8: PASS」；我 00:04 起跑就红。
**把本次全部 8 个文件 stash 掉、原始树重跑 → 完全相同**；`negative-control.sh` 也红在同一步。
`Get-Process electron` 计数 0。**未验证**：它是否只是「当前会话」的问题 —— 同一时段其它 Electron 套件
（t7/o0/o4/t46）在 23:58–00:19 是绿的，00:22 之后 t7 `--mutation` 与 o0（经 CI）也撞上同一句
`display surface`。**同一台机器、时绿时红，指向环境而不是代码。**

**（d）`o0` 在 00:19 经 `run-smokes.mjs` 红 3 条**（`xlsx` / `pdf` / `html`）。
同一句 `display surface not available`。**stash 对照**：旧包装器 `--only=xlsx-fidelity` → 同样红在同一步。
更早 00:01 它 6/6 绿、`mutate.mjs` 32/32。**归到 (c) 同一个环境问题。**
**00:30 再重试一次**：仍 3 红（同样 6 条 `display surface`）—— 环境未恢复，不是偶发单次。

**（e）`t7 --mutation` 00:22 起红 6 条**（`display surface`）。
**stash 对照**：旧包装器 `--mutation` → 同样 6 红、同样 14 条 `display surface`。
更早 23:58 正常跑 6/6 绿。**归到 (c)。**

**（f）`tsc` —— 我交付时是红的，但不是我的文件。**
`npx tsc --noEmit -p apps/desktop/tsconfig.json` → **2 条错**，都在
`scripts/o2-conflict-u1-smoke/journeys.ts`（`TS1005` / `TS1351`，第 144 行一个模板字符串里写进了真的多行
字符串）。**该文件 `mtime` 00:12:20，我的 tsc 跑在 00:13 —— 别的会话正在写它。**
我的 7 个文件 + 新模块在错误列表里 **0 条**；`packages/contracts` tsc **EXIT=0**。
按 CLAUDE.md 第九/二十四条：这是**在途中间态**，不是我的缺陷。
**已复核（00:28）**：该文件 00:27:35 写完，重跑 tsc → **EXIT=0、0 条错**。交付时的 `tsc` 门禁是**绿的**（`apps/desktop` 与 `packages/contracts` 双包都 0 错）。

**（g）没跑的**：全量 smoke（本卡明令不跑）；`electron-u1/run.sh` 自身（不在范围）；
`t29` 的 `mutate-t29.mjs` 跑过且 detected=true，但它只覆盖 1 条旅程。

### 7. W22 / 这张卡上写错的地方

1. **卡题写「6 套」**，实际旧包装器是 **7 个消费点**（`t7`/`t30`/`o0`/`o4`/`t29`/`t46` 六套本次修 +
   `t8` 已修）。卡面表里 `onlyoffice-sdk-origin-smoke` **从来不是** `build.mjs` 消费者，**且已被 O5 删除**。
2. **卡面表把 `onlyoffice-sdk-origin-smoke` 写成「有 `?? 1` 的套件之一」—— 它的 `?? 1` 在 `run.mjs:47`
   只是把它自己的普通 node 子进程退出码透传成 `process.exitCode`。**不是 `build.mjs` 包装器。**
3. **W22 回写说「`--keep` 既有 bug：包装器透传给 build.mjs，后者拒收」是对的，但漏了根因** ——
   `build.mjs` **头注释**把 `--keep` 写成受支持（`:27`），**是文档与实现矛盾**。所以「加一句明确报错」
   会让文档更错。**修解析器才是最小改动。**
4. **卡面「优先照 o2 做」判断正确，`o2` 的判据确实成立**；但 `o2` 的 `run.mjs` **不是**「读 summary 后
   缺了就 FAIL」这么简单 —— 它还有 `judge()` 按 `expectations.ts` 逐条核对旅程名。**本卡只抽了
   「summary 缺失 = 构建失败」这一半**，没抽 `judge()`（各套期望不同，抽不出来），这点卡里没写。
5. **卡面说 `?? 1` 那 8 处「不是缺陷，关键看拿到 1 之后说什么」—— 对的。** 但**六套里只有 `t30` 真会
   打印 PASS**；另五套的「码撞车」也是缺陷（验收判据 3 要求不同码），只是**不叫假绿**。卡面把两者
   混在「是否同病」一栏，容易让人以为五套都不用改。
6. **总控的判别命令**：开工时 `tsc` 是 45 错（38 renderer、7 scripts），00:00 前后 O5 批三落地后变 **0**。
   **O5 批三落地时间比我预期早**；我按总控要求，构建失败/红都用 stash 对照而不是「猜是 O5」。
   **总控第四次补充的 `grep -cE '(^|/)src/renderer/'` 在本机实测成立**：`apps/desktop` 下 38，仓库根也 38。

---

## 总控验收（2026-10-25 00:40）

**结论：通过。它的核心发现比我的卡准，而且我采纳了它的一个「建议另开卡」。**

### 一、它纠正我的第一处：真假绿只有 `t30` 一套

我卡上说「7 套都有同样的假门禁」。**它分出了两种病，我核实了：**

| 套件 | 旧逻辑 | 构建失败退 1 时 |
|---|---|---|
| **`t30`** | `if (normal !== 0 && normal !== 1) FAIL` | **落在「允许」区间 → 打印 `T30: PASS`** ← **真·假绿** |
| `t7`（及其它） | `if (normal !== 0) FAIL` | 正确判成 `T7: FAIL` ← **不是假绿，是码撞车** |

**我读了 `git show HEAD:` 的两个文件确认：`t30` 的注释就写着「正常跑允许 0（全绿）或 1（预期红）」——
而构建失败也退 1，于是被吞掉。`t7` 没有这个区间。**

**所以「只有 `t30` 会打印 PASS」是对的。** 但另外 5 套的码撞车仍然要修（不同事实要不同码），
**它按验收判据 3 全修了，这个判断对。**

### 二、它纠正我的第二处：`onlyoffice-sdk-origin-smoke` 从来不是消费者

我卡面表列了它。**它查证：那不是 `build.mjs` 消费者，且已被 O5（`00af5199`）删掉。**

**我核实了**：`apps/desktop/scripts/onlyoffice-sdk-origin-smoke/` 现在不存在。

### 三、它纠正我的第三处：`--keep` 的根因

我卡上说「`--keep` 是既有 bug，透传给 build.mjs，后者拒收」。

**它查到的更准**：`build.mjs` **自己的头注释（`:27`）把 `--keep` 写成受支持的 no-op**，
而解析器却 throw —— **是文档与实现矛盾**，不是「有没有人用」的问题。
**它修了解析器（一行），覆盖全部 5 个仍在透传的包装器，并留了 `--bogus` 正控。这个判断对。**

### 四、我采纳了它说「另开卡」的那一条，自己修了

它说：

> **`t30` 的 `cpu-features` 构建失败本身** —— 那是 `t7-genoffice-u1/vendor-esbuild.mjs` 的
> externals 缺项（`t8/main-esbuild.mjs` 有）。不属于本卡（本卡是假门禁，不是打包配置），
> **建议另开卡**。

**我认为这一行不值得另开卡 —— 它正是让 6 套跑得起来的那个缺项。我修了：**

`apps/desktop/scripts/t7-genoffice-u1/vendor-esbuild.mjs` 加了 `external: ["electron", "sherpa-onnx-node", "node-pty", "better-sqlite3", "cpu-features"]`
（与 `t8/main-esbuild.mjs` 同源，注释写清了为什么）。

**修完实测：`t30` 不再构建失败** —— 现在报的是运行时错误 `主窗口尚未就绪，无法创建文档视图`。
**这证明构建期已经通了。**

### 五、它报的「`t8` 全红」，我复现了，**是环境不是代码**

它说：

> **`t8` 本体：4 条旅程全红（`Current display surface not available for capture`，
> `overlaysClosed=false`）**。把本次全部 8 个文件 stash 掉、原始树重跑 → 完全相同。

**我自己复现了：**

| 时刻 | 结果 |
|---|---|
| **23:49** | **全绿**（`literalStatus: PASS`，21 步） |
| **00:35** | **四条全红**，红在 `canvas-editor-ready` / `blank-workflow-open` 等前置步骤 |

日志：`U1 screenshot fallback: Current display surface not available for capture` +
`不是空白工作流（ready=true, **overlaysClosed=false**, ...）`

**同一个仓库、同一份代码，46 分钟前绿、现在红。** `git status` 确认 `t8` 目录这期间没被改。

**诊断：`tasklist` 显示有 4 个 `electron.exe` 在跑**（211MB / 175MB / 102MB / 61MB），
而它报告「`Get-Process electron` 为 0」。**我们跑的时刻不同。**

`t30` 的日志更直接：`U1 host window: offscreen right-below primary work area 1463x775
(no secondary display)` → 窗口被摆到屏幕外 → `主窗口尚未就绪`。

**所以：这不是任何人的代码问题，是这台机器的桌面/显示会话状态变了。**

**我没有杀那 4 个 electron 进程** —— 它们可能属于别的会话，误杀会打断别人的工作。

### 六、它做的两件事我特别认

1. **它把「构建失败注入」做成 5 套 × 3 项 = 预期 15、实际 15/15**，全部 `sha256sum -c` 逐字节还原；
2. **它把判据抽成 `apps/desktop/scripts/lib/electron-u1-verdict.mjs`（358 行），6 个包装器共用，
   且明确「未混用」**：t8 继续用自己的探针，o2 不动。**这正是「共享实现只有一份」那条的正面样本。**

---

## 结果回写补记（W24 续，2026-10-25 00:50）：你的 externals 修好后，假门禁后面还有两个真缺陷

**总控的 `69c2c835` 生效**：`t30` 不再 `BUILD FAILED`，构建期通了。然后第一次真正跑到旅程，
**`T30: PASS` 这块布下面盖着的两个缺陷露出来了。两个都已修，改动在工作区（未提交）。**

### 缺陷 A：t30 的惰性注册表吞掉了 `failBecause` → 故意失败旅程被判「非预期」

构建期打通后第一次跑（00:39）：
```
UNEXPECTED FAILURE deliberate-failure: expect:"fail" 缺少 failBecause
```
**而 `deliberate-failure.ts` 里有 `failBecause`**（`deacf188` 起就有，没人删过）。
问题在 `journeys/index.ts` 的惰性壳：它只透出 `name/launch/steps/expect`，`failBecause` 被吞。
`driver/verdict.ts` 的 `classifyJourney` 读的是 journey 对象本身 → 找不到 → 判 `unexpected-failure`。

**这是 `t8` 和 `o2` 注册表里都写过的同一个坑**：
- `t8/journeys/index.ts:53-55`：「惰性壳必须把 `failBecause` 一起透出……只给 name/steps/launch 会让
  『故意失败』被判成『缺少 failBecause』」；
- `o2/journeys/index.ts:33-36` 同一句。

**t30 的注册表（`deacf188` 建）从来没有透出它。** 这个缺陷被假门禁盖了 6 天：旧包装器对构建失败
打印 PASS，套件从没跑到「注册表被真正的 verdict 读」那一步。

**修**：`apps/desktop/scripts/t30-document-tools-u1/journeys/index.ts` 给 `LazyJourney` 加
`failBecause?`，惰性壳加 `get failBecause()`。
**实测**：`--only=deliberate-failure` → `expectation=expected-failure (failed at assert-missing-view)`；
`--mutation` → `literal=PASS expectation=all-pass`、exit 0（**两个方向都对**）。

> **边界说明**：卡写「各套件的 `journeys/**` 不许碰（除非某处确实是判据本身）」。这一处**是判据的输入** ——
> 注册表决定 `classifyJourney` 看见什么，不是产品旅程逻辑。改的是 3 行 getter + 类型，没有碰任何旅程步骤。

### 缺陷 B：`@main/window.js` 在 t30 的产物里是**两份模块实例**，生产单例读到 null

修完 A 再跑，三条产品旅程全部：
```
Error: T30: docs 视图打开失败：主窗口尚未就绪，无法创建文档视图
```
`t30/window-holder.ts` 的注释写着「直接复用 T7 的 `window-holder.ts`」——**但它是抄的一份，不是同一份**。
esbuild 产物里实测**两个模块**（`grep -c "function setMainWindowForU1" .tmp/electron-u1-build-*/journeys.cjs` → **2**；
初始化器叫 `window_holder` 与 `window_holder2`）：

| 谁 | import 形态 | 落到哪份 |
|---|---|---|
| `t7-genoffice-u1/harness.ts` 的 `setMainWindowForU1(win)` | **相对路径** `./window-holder.js` | T7 那份 |
| 生产 `documentViewHost.liveWindow()` 的 `@main/window.js` | **esbuild alias** | t30 那份 |

于是 harness 把窗口写进 T7 那份，生产单例从 t30 那份读 → **永远 null**。

**这是「共享实现只有一份」的反面实例**：注释说「直接复用」，实际是复制；两条 import 路径让复制品
在同一个 bundle 里变成两个实例。

**修**：`t30/window-holder.ts` 的 `getMainWindow()` **先读 T7 那份**（`import * as` 同一 bundle 内成立），
`setMainWindowForU1()` 两边都写。不改 T7 的交付物（卡边界），不出现两份状态。
**实测**：`sheets-tool-call` 由「setup 抛错」变成 **all-pass**；`docs-tool-*` 两条从「视图创建失败」
前进到 `docs-editor-opened` / `wired-docs-opened` —— **卡在 `capturePage 返回空图`**（下面的环境问题）。

### 这两个缺陷为什么现在才发现 —— 这正是本卡的论点

**假门禁的代价不只是「一次误报」，是它把后面所有的红都盖住了。** t30 从 `deacf188`（10-23）起
就一直 `T30: PASS`，所以没有人跑到旅程、没有人看到注册表吞 `failBecause`、没有人看到双 window-holder。
**修好一块假门禁，露出两层真缺陷。**

### 现在 t30 的状态（措辞按三档表）

| 项 | 状态 |
|---|---|
| 构建期 | ✅ 通（总控 `69c2c835`） |
| `deliberate-failure`（含变异两方向） | ✅ **绿 / 翻转正确** |
| `sheets-tool-call` | ✅ **all-pass** |
| `docs-tool-roundtrip-production` / `-wired` | ⚠️ 红在 `capturePage 返回空图`（**环境**，见下） |
| t30 套件整体 | **判据已修 + 两个真缺陷已修；真跑待显示环境恢复** |

### 环境问题的决定性证据（补强总控的复现）

| 时刻 | 宿主窗口落点 | 结果 |
|---|---|---|
| 00:01 | **`secondary display (id=3569894473, 1920x1080) (x=1523, y=60)`** | t7 **6/6 绿**、o0 **6/6 绿** |
| 00:20 之后 | **`offscreen right-below primary work area 1463x775 (no secondary display) (x=1543, y=855)`** | `capturePage 返回空图` / `display surface not available` |

**同一份代码，窗口从「有第二显示器」变成「没有第二显示器、摆到主屏右下角外」**。
`driver/runner.ts:468,477` 的 `capturePage` 对屏幕外窗口返回空图 —— 这就是全部红因。
**这台机器的第二显示器在 00:01–00:20 之间掉了。** 不是代码，不是任何会话的改动。

### 本轮新增/改动的文件（仍未提交）

```
 M apps/desktop/scripts/t30-document-tools-u1/journeys/index.ts   （缺陷 A，3 行 getter + 类型）
 M apps/desktop/scripts/t30-document-tools-u1/window-holder.ts    （缺陷 B，读 T7 那份 + 双向 set）
```
`tsc`（`apps/desktop`）重跑 **EXIT=0、0 错**。t7 不 import t30 的任何文件（依赖是单向 t30→t7），
`--only=markdown-open-edit-save-reopen` 红在 `step-07-screenshot`（同一环境）。

---

## 总控验收·补记（2026-10-25 00:55）

**我修 externals 之后，它挖出了两个被假门禁盖住的真缺陷。两个都核实成立。**

### 我核实 A：`failBecause` 被惰性注册表吞掉

| 检查 | 结果 |
|---|---|
| `deliberate-failure.ts` 有 `failBecause` 吗 | **有**（`deacf188` 起） |
| `t30/journeys/index.ts` 的惰性壳透出它吗 | **没有** —— 它只透出 `name/launch/steps/expect` |
| `classifyJourney` 读哪 | **journey 对象本身** → 判 `unexpected-failure` |

**它指出 `t8`（`:53-55`）和 `o2`（`:33-36`）的注册表都写了注释警告过这件事，
只有 `t30` 的注册表从来没透出。** 这个判断对 —— 而且这正是「坏东西显式报出来」的反面。

**它修的是 3 行 getter + 类型，没碰任何步骤。** 边界说明也写清了（那是 verdict 的输入，
不是旅程逻辑）。**我接受这个越界判断。**

### 我核实 B：两份 `window-holder` 模块实例

| 检查 | 结果 |
|---|---|
| `t30/window-holder.ts` 与 `t7/window-holder.ts` 内容一样吗 | **不一样**：3472 vs 1743 字节 |
| `t30` 那份多什么 | `updateTitleBarOverlay` / `createMainWindow`（t7 那份没有） |
| `t30` 的 alias 指向 | **自己那份**（`resolve("scripts/t30-document-tools-u1/window-holder.ts")`） |
| `o0` 的 alias 指向 | **`t7` 那份** ← 所以 `o0` 没有这个问题 |

**所以它说的「同一个逻辑在产物里是两个模块实例」成立**：
`t7/harness.ts` 用相对路径 import 它自己那份，而生产 `documentViewHost` 经 alias 读 `t30` 那份。

**它修的方案（让 t30 那份去读 t7 那份）是对症的权宜之计。我接受，但记下真正的解法：**

> **真正的解法是「只有一份」**：把 `updateTitleBarOverlay` / `createMainWindow` 两个 no-op
> 补进 `t7-genoffice-u1/window-holder.ts`，然后把 `t30` 的 alias 改成指向 `t7` 那份
> （像 `o0` / `o4` 那样），删掉 t30 自己那份。
>
> **它没这么做是对的** —— 那要改 `t7` 的交付物，超出本卡边界。
> **这是 W27 的事。**

### 它的同族建议：我 grep 了，只有 `t30` 一处

它说：

> **B 那个「注释说复用、实际复制」的形态值得 grep 一遍** ——
> 其它套件的 `window-holder`/替身模块可能有同族（两条 import 路径 → 两个实例）。

**我 grep 了，结论是「没有同族」：**

```
重名桩文件：electron.ts 41 份、window.ts 36 份、logger.ts 33 份、dataRoot.ts 29 份、
repositories.ts 23 份、runtimeManager.ts 23 份 ...
```

**这些重复本身不是缺陷** —— 每个套件要的假行为不同。

**真正的缺陷形态是「同一个逻辑被两条 import 路径带进同一个 bundle」**，
而那只在**同时 import 别人的 harness、且自己的 alias 指向另一份**时发生。

**逐个核对三个候选：**

| 套件 | alias 指向 | import 谁 | 是同一份吗 |
|---|---|---|---|
| `o0` | `t7/window-holder.ts` | `../t7-genoffice-u1/harness.js` | ✅ 是 |
| `o4` | （用 `o0` 的 vendor-esbuild） | 同 `t7` | ✅ 是 |
| **`t30`** | **自己那份** | `../t7-genoffice-u1/harness.js` | ❌ **不是** |

**只有 `t30` 一处。** 它的怀疑方向对，但范围比它想的小。

### 它找到的环境决定性证据，我采纳

> | 时刻 | 宿主窗口落点 | 结果 |
> |---|---|---|
> | **00:01** | `secondary display (id=3569894473, 1920x1080) (x=1523,y=60)` | t7 6/6 绿、o0 6/6 绿 |
> | **00:20 后** | `offscreen ... 1463x775 (no secondary display) (x=1543,y=855)` | `capturePage 返回空图` |

**第二显示器在 00:01–00:20 之间掉了。** 这比我那条「23:49 绿 / 00:35 红」更精确 ——
**它给出了「什么时候、什么变了」。**

---

## 结果回写补记 2（W24 续，2026-10-25 01:20）：环境红因找到了 —— 是**无副屏分支把窗口摆到所有显示器之外**

> **⚠️ 本节推翻我上一条补记里的归因**（「第二显示器在 00:01–00:20 之间掉了 → 等它回来」）。
> 显示器确实掉过（现在只剩 1 块 1463×823），**但它不是红因**。红因是代码里一个**从没在单屏机器上验过**
> 的分支。下面是完整的对照实测，全部在 `.tmp/` 一次性探针里跑（不属产品代码）。

### 一、探针矩阵（Electron 44.4.5，本机单屏 1463×823）

**`BrowserWindow.webContents.capturePage()` —— 全部成功：**

| 位置 | opacity | 结果 |
|---|---|---|
| 屏外 (1543,855) | 0 / 1 | ✅ 非空，中心像素纯红 |
| 屏内 (40,40) | 0 / 1 | ✅ 非空 |

**`WebContentsView.webContents.capturePage()`（U1 套件真正捕获的对象）—— 位置才是变量：**

| 窗口位置 | 第一次成功 | 说明 |
|---|---|---|
| **屏外 (1543,855)**（`pickHostWindowPlacement` 无副屏分支的逐字坐标） | **永不成功** | 一直抛 `Current display surface not available for capture`，load 完成后也不行 |
| 屏内 + `opacity: 0` | +122ms / +235ms | ✅ 非空 —— **不可见但可合成** |
| 屏内 + `opacity: 1` | +93ms | ✅ 非空 |

**结论（三条，缺一不可）：**
1. **「离屏窗口不能 `opacity:0`」是错的** —— `runner.ts` 里两处注释这么写（`createWindow` 上方、`pickHostWindowPlacement` 上方），实测屏内 + opacity 0 完全正常；
2. **「窗口在屏外仍被合成器认为有 surface」也是错的** —— 那是 `5ec95339` 提交说明里的假设，它只在这台**当时有两块屏**的机器上验过（副屏分支），无副屏分支从没跑过；
3. `addChildView` 之后 view 需要约 100–250ms 才拿到 surface（先 `UnknownVizError`，后成功）。**这一条不是红因**（runner 的 setup 远长于 250ms），但解释了早期探针里偶发的 `UnknownVizError`。

### 二、为什么 00:01 绿、00:20 之后红（时间线现在闭合了）

| 时刻 | 显示器 | runner 走哪个分支 | 结果 |
|---|---|---|---|
| 00:01 | **2 块**（副屏 1920×1080） | 副屏分支 → 窗口在**真实显示器上** | ✅ t7 6/6、o0 6/6 |
| 00:20 之后 | **1 块** | **无副屏分支 → 窗口在 (1543,855)，所有显示器之外** | ❌ 所有 view 截图失败 |

**所以「第二显示器掉了」是触发条件，不是病因。** 病因是无副屏分支；显示器回来会让它「碰巧又绿」，
**但换一台单屏机器、或这台一直单屏，就永远是红的**。

### 三、端到端验证（临时变异，已逐字节还原）

把 `pickHostWindowPlacement` 的无副屏分支临时改成「屏内 (20,20)」+ `createWindow` 加 `opacity: 0`，
跑 `t30`：**`docs-tool-roundtrip-production` 的截图步骤从 FAIL 变成 PASS** —— 失败点前移到
`apps-discovery`（见下），`wired` / `sheets` / `deliberate-failure` 全对。

**还原**：`.tmp/w24-runner.bak.ts` → `cp` 回，`sha256sum -c` **OK**，`git status` 干净。
`runner.ts` **不在本卡可写边界内**（`apps/desktop/scripts/electron-u1/build.mjs` 可写，`driver/` 不在），
所以**我没改它**。**建议开卡**：无副屏分支改为「主屏工作区内 + `opacity: 0`」，并把两条注释里的错误因果改掉。

### 四、`t30` 剩下的红：一个**过期的字面量**（与 W24 无关）

临时变异下唯一剩下的红：
```
apps-discovery :: 目录总数不是 139  ::  {"total": 140}
```
`deacf188`（10-23）写这条断言时目录是 139 个；现在 **140**（T102 等之后新增）。
`tasks/T30-document-tools-u1.md:52,79` 也写着 139 —— **文档与断言同源、同时过期**。
不是判据弱（它精确抓到了一个真实变化），是**写死的数字需要有人决定「140 是不是新的正确值」**。
不在本卡范围，**未改**。

### 五、最终逐套状态（覆盖前面 §3 的措辞）

| 套件 | 状态 |
|---|---|
| `t7` / `o0` / `o4` / `t46` | ✅ 已修复、曾真跑绿（00:01 前后）；**现在单屏**下截图步骤会红 —— **红因是无副屏分支，不是本卡改动** |
| `t30` | ✅ 判据已修 + 两个真缺陷已修（`9ca0f192`）；**截图步骤同样撞无副屏分支**；另有一条过期字面量 `139→140` |
| `t29` | ✅ 判据已修；`t29-close-pdf-after-unsaved-guard` 既有红（stash 对照证明） |
| `t8` | ✅ 不回归（W22 selfcheck 11/11）；本体红同因（环境/无副屏） |

**「本卡改动本身是否正确」的证据不依赖显示器**：构建失败注入 5 套 × 3 项 = 15/15、
判据模块 6 个变异全部按预期变红、`--keep` 正控、t30 的 `deliberate-failure` 变异两方向翻转。
**截图红是「U1 骨架在单屏机器上的既有缺陷」，不是判据缺陷。**
