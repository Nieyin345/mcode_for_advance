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
> 我没有做「删缓存 vs 不删」的对照就下了因果。
> Office 总控三次实测都退 2（含删缓存后），我两次实测都退 1，**两边不一致，原因未定**。
> **下面的「换判据」结论仍然成立**（用错误数不用退出码），但**不要把「缓存」当成原因记下来**。

### 我实测到的

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
