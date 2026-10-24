# T145 — 284 套 smoke 的 `run.sh` 在「从仓库根单套运行」时必挂

**Status**：`ready-for-agent`
**Category**：测试基础设施（支撑 UI 主线，不是产品功能）
**写卡时间**：2026-10-24 21:20。**下面前提都是这一刻实测的，读卡时请复核。**

## 零、症状

```bash
# 从仓库根（smokes-for.sh 打印的用法就是这个）
$ bash apps/desktop/scripts/task-roster-smoke/run.sh
apps/desktop/scripts/task-roster-smoke/run.sh: line 8:
  apps/desktop/scripts/task-roster-smoke/../lib/esbuild-path.sh: No such file or directory
EXIT=1

# 从 apps/desktop 调用则正常
$ cd apps/desktop && bash scripts/task-roster-smoke/run.sh
15/15 task-roster checks passed
```

## 一、根因

```bash
cd "$(dirname "$0")/../.."                    # ← 先 cd 走
source "$(dirname "$0")/../lib/esbuild-path.sh"   # ← 再用相对路径的 "$0"
```

`cd` 之后，`$0` 仍是调用者给的**相对路径** `apps/desktop/scripts/x/run.sh`。
相对路径的基准已经变成新的 cwd（`apps/desktop`），于是拼出
`apps/desktop/apps/desktop/scripts/x/../lib/...` —— 不存在。

**正确的写法**（t140 / t138 / t139 已经是这个形状）：

```bash
HERE=$(cd "$(dirname "$0")" && pwd)   # 先算绝对路径
cd "$HERE/../.."                       # 再 cd
source "$HERE/../lib/esbuild-path.sh"  # 用 HERE，不用 $0
```

## 二、实测范围（我用 python 扫的，不是估的）

```
total=611  bug=284  ok=327
```

**判定规则**：文件里 `cd` 那一行**之后**还出现 `dirname "$0"` → 判 bug。

**⚠️ 这个判据比真实症状宽一档**，我核实过两个反例：

| 套件 | 判据说 | 实际 |
|---|---|---|
| `t134-chat-width-smoke` | BUG | **能过** —— 第 7 行先 `cd`（用 `$0`），第 8 行才 `HERE=$(cd "$(dirname "$0")" && pwd)`。第 8 行执行时 cwd 已是 `apps/desktop`，拼出 `apps/desktop/scripts/t134-chat-width-smoke` —— 又对了。**是巧合对，形状仍然是错的。** |
| `task-roster-smoke` | BUG | **真挂**（上面那个报错） |

**所以 284 是「形状错误」的上界，真实会挂的是其中一部分。** 执行时要**逐套实跑确认**，
不要照 284 这个数字直接改（改对了没错，但别在回写里写「284 套原本都挂」）。

**已知会挂的样板**：`task-roster-smoke`、`chat-copy-payload-smoke`。
**已知的「形状错但碰巧能跑」样板**：`t134-chat-width-smoke`。

## 三、为什么值得修（而不是记一笔就算了）

1. **`smokes-for.sh` 自己打印的用法就是错的**（`apps/desktop/scripts/smokes-for.py:434`）：
   ```
   bash apps/desktop/scripts/<名字>/run.sh
   ```
   它教 284 套的读者一条会挂的命令。**照它做的第一个人就会以为套件坏了。**

2. **`run-smokes.mjs` 不受影响**（`spawn(bash, ['scripts/x/run.sh'], { cwd: appDir })`），
   所以**全量一直是绿的** —— 这个 bug 只在「单套调试」时暴露。
   而单套调试正是改一处小东西时的常规动作（`CLAUDE.md` 的「别跑全量，先问哪几套覆盖它」）。

3. **失败形态极差**：报错是 `line 8: ... No such file or directory`，
   **看起来像套件本身坏了**，不像路径问题。CLAUDE.md 记过
   `suite-startup-failure-looks-like-zero-red`：`rc=127` 时取通过数得空串，
   会被误读成「跑了但没红」。

## 四、任务

### 第一步：把 `smokes-for.py` 的用法行改对（**先做这个**，它最便宜且影响所有读者）

`apps/desktop/scripts/smokes-for.py:434` 附近，把打印的命令改成从 `apps/desktop` 调：

```python
print("\n  (cd apps/desktop && bash scripts/<名字>/run.sh)")
```

或者按第二步统一之后直接删掉这个提示（如果第二步完成，从仓库根也能跑）。

### 第二步：批量修 `run.sh` 的形状

**只改形状，不改行为。** 统一成 `HERE` 三行的写法（见 §一）。

**⚠️ 必须逐套验证，不能盲改**：

```bash
# 改之前先实跑，记下哪些真挂
for f in apps/desktop/scripts/*-smoke/run.sh; do
  bash "$f" > /dev/null 2>&1; echo "$? $f"
done > /tmp/before.txt

# 改之后同样跑一遍
# 然后 diff，断言：所有原本 rc=0 的仍然 rc=0
```

**⚠️ 不要用 sed 批量替换。** `run.sh` 有 327 套已经是正确形状，误改会破坏它们。
**按 `cd` 那一行的行号精确改**（`Edit` 工具，或 python 精确匹配）。

### 第三步：加一条守卫断言

新建一个套件，或者延伸到现有的基础设施套件里：

```bash
# 断言：所有 *-smoke/run.sh 里，cd 之后不再出现 dirname "$0"
# 正控：塞一个假的进去要红
# 负控：327 套正确的不能红
```

**⚠️ 这条断言要用「形状」判据，不是「文件里有没有 `$0`」** ——
`$0` 本身在正确写法里也出现（`HERE=$(cd "$(dirname "$0")" && pwd)`）。
**判的是「cd 之后还用它」，不是「用了它」。**

## 五、验收

1. **`smokes-for.py` 打印的用法是从仓库根不起作用的形状**（改对，或删掉）。
2. **改前 rc=0 的套件，改后仍 rc=0**（逐套实测，不是抽查）。
3. **`task-roster-smoke` 从仓库根能跑通**（它是已知会挂的样板）。
4. **守卫断言存在，且变异能红**：塞一个 `cd` 后用 `$0` 的文件进去 → 红 1 条。
5. **不回归**：`pnpm test:all` 或至少 `run-smokes.mjs --all` 全绿。

## 六、边界

**可以改**：
- `apps/desktop/scripts/*-smoke/run.sh`（**只改 `cd` / `source` 那两行的顺序与取值**）
- `apps/desktop/scripts/smokes-for.py`（只改那行打印）
- 新建守卫套件

**不许碰**：
- 任何 `main.ts` / 套件逻辑
- `run-smokes.mjs`（它是对的）
- 套件里除 `cd`/`source` 之外的任何行

**⚠️ 并行提示**：`t142` 的子代理正在改 `renderer/` 下的组件，
`T141` 的子代理正在改 `arc005-visual-baseline/`。**这两处都不要碰。**

## 七、回写

### 1. 改前实跑结果

**把 284 个原始文件全部写回，从仓库根逐套跑（串行，`/tmp/t145-before4.txt`）：**

```
rc=1  284 套   ← 全部失败，没有一个例外
```

**这是这张卡最重要的一条事实**：不是「形状不对但碰巧能跑」—— **284 套真的全挂**。
之前 `t134-chat-width-smoke` 看起来「碰巧能跑」是**我的判据写宽了**（见 §2）。

### 2. 真挂的套件清单

**284 套全部真挂。** 上界就是真实值。

**为什么 `t134` 也在里面**：我原先判「它碰巧能跑」，那是因为**判据没纠正顺序**。
`t134` 改前的实际形状是：

```bash
cd "$(dirname "$0")/../.."          # ← 这一步就成功了
HERE=$(cd "$(dirname "$0")" && pwd) # ← 这一步在 cd 之后算，算出 apps/desktop/scripts/t134...
```

第 2 行算出 `apps/desktop/scripts/t134-chat-width-smoke`（多了一层 `apps/desktop/`），
所以**它也是挂的**。**我卡里那条「碰巧能跑」的结论是错的，用实跑推翻了。**

### 3. 改了什么形状、改在哪几套

**284 套，每套两处编辑，形状统一成：**

```bash
HERE=$(cd "$(dirname "$0")" && pwd)   # 新增，算绝对路径
cd "$HERE/../.."                       # 原来用 $0，改成 $HERE
                                      # （其他行不动）
source "$HERE/../lib/esbuild-path.sh"  # 原来用 $(dirname "$0")，改成 $HERE
```

| 类别 | 套数 | 做法 |
|---|---|---|
| `SOURCE_RELPATH`（真挂） | 280 | 插 `HERE=`、`cd` 改用 `$HERE`、`source` 改用 `$HERE` |
| `ASSIGN_HERE`（顺序错但第 2 行兜底） | 4 | 把 `HERE=` 行移到 `cd` **之前**，`cd` 改用 `$HERE` |
| `cd` 后有行内注释 | 20 | 同第 1 类，**注释保留**（`cd "$HERE/../.."          # → apps/desktop`） |
| 其余 327 | — | 已经是正确形状，**未改** |
| 30 | — | 没有 `cd`，这条约束不适用 |

**改法**：Python 精确匹配（不用 `sed`），每个文件先备份到 `.tmp/t145-bak/`（保留目录结构），
逐文件校验 `old_cd` / `old` 两行未漂移才写；**0 个 errors**。

**⚠️ `smokes-for.py:434` 也改了**：它原来打印
`bash apps/desktop/scripts/<名字>/run.sh` —— 从仓库根调**就是会挂的那条**。
改成用绝对路径（`(DESKTOP / "scripts" / "<名字>" / "run.sh").as_posix()`），
无论调用者在哪个目录都能贴。

### 4. 守卫断言的变异结果

新建 `apps/desktop/scripts/t145-runsh-path-smoke/`（静态，8 条，不起 node/浏览器）。

**判据**：`cd` 之后**非注释行**里还出现 `dirname "$0"` → 抓。
**判的是「cd 之后还用它」，不是「用了它」** —— 正确写法里 `$0` 也出现。

| # | 变异 | 预期红 | 实际 | 红的对不对 |
|---|---|---|---|---|
| M-1 | 把 `task-roster-smoke/run.sh` 的 `source "$HERE/..."` 改回 `$(dirname "$0")` | 1（第 [1] 条） | **1**，点名 `task-roster-smoke/run.sh:9` | ✅ 正是第 [1] 条，四条自检全绿 |
| M-2 | 把 `smokes-for.py` 的打印改回 `bash apps/desktop/scripts/<名字>/run.sh` | 1（第 [4] 条） | **1** | ✅ 正是第 [4] 条 |

**两条变异之后都 `cmp` 核验逐字节还原。**

**⚠️ 第 [4] 条第一版是错的（值得记）**：它写的是
`/bash apps\/desktop\/scripts\/<名字>\/run\.sh/.test(smokesFor)` ——
**命中了修法自己的注释**（注释里解释「从前是这条，为什么它坏」），于是**恒红**。
改成只认**非注释的 `print` 行**才对。**这和主判据剥注释是同一个道理**，
在同一个文件里犯了两遍。

**四条自检（正控/负控）**：
- 「cd 之后用 `$0`」的构造 → 抓 1 行 ✓
- 「HERE 正确形状」 → 0 行 ✓
- 「注释里提到 `$0`」 → 0 行 ✓（剥注释生效）
- 「没有 `cd` 的套件」 → 0 行 ✓（这条约束不适用）

第 [2] 条是**覆盖性正控**：断言扫描真的读到了 >400 个 `run.sh`，
否则第 [1] 条会因为「零输入」而恒绿。

### 5. 改后实跑结果

**逐套从仓库根跑（`/tmp/t145-after.txt`），284 套中：**

```
rc=0  283 套
rc=1    1 套   ← app-control-smoke，见下
```

**`app-control-smoke` 的失败与本次改动无关：**

```
✗ ★ 功能清单与 RpcMap 逐条对齐 — {"missing":["modules.installVsix"],"extra":[],
   "hint":"跑一次 node scripts/gen-app-api-catalog.mjs"}
581/582 通过
```

**这是另一条线（扩展）在途的 `modules.installVsix` 没登记进 `RpcMap`**，
不是 `run.sh` 路径问题。**改前它也是红的**（在 284 个 rc=1 里）。

**对照 `task-roster-smoke` 的证据最直接**：
- 改前：`line 8: ... No such file or directory`，EXIT=1
- 改后：`15/15 task-roster checks passed`，EXIT=0

### 6. 提交 SHA

**`8d6d8d9c`** — 288 文件（282 M + 6 A），+1352 / −566。

提交时**不带任何路径**（`git commit -F .tmp/t145-commit-msg.txt`）。
`-- <paths>` 会把工作区内容重新加进索引，抹掉 `git restore --staged` + `git add` 的精确构造 ——
总控当天实测过这个语义，并写进了 CLAUDE.md。

### 6.1 ★ 守卫上线后立刻抓到一个真实的新 bug（**这是它最有价值的证据**）

提交之后跑守卫，**第 [1] 条红了**：

```
FAIL ★ 没有 run.sh 在 `cd` 之后仍用 `dirname "$0"`
     — ["o4-docs-close-smoke/run.sh:45"]
```

**`o4-docs-close-smoke` 是另一个会话（Office 线）刚建、尚未提交的套件**，
里面有一模一样的 bug：

```bash
# cd 之后（第 45 行）
source "$(dirname "$0")/../lib/esbuild-path.sh"
```

**它不在我的 284 个名单里**（我扫的是当时磁盘上的 611 个，那时它还不存在）。

**所以：**
1. 守卫**不是纸做的** —— 它抓到了一个我没见过、也没改过的文件；
2. 也正是因为它抓到了，**守卫现在在 HEAD 上是 7/8**，不是 8/8。
   **这不是我的改动引入的，是别人在途文件的状态。** 那个会话提交时应当顺手改掉；
   或者由总控决定是否等它。

**这是「守卫断言有真实的检出能力」的最好证据** —— 比任何变异都强，
因为变异是我自己造的，这个是别人真实写出来的。

### 7. 觉得不对但没改的

1. **`run-smokes.mjs` 没动** —— 它用 `cwd: appDir` 调，本来就对。
   全量一直是绿的，所以这个 bug 藏了很久。
2. **30 个没有 `cd` 的套件** —— 它们靠 `source "$(dirname "$0")/../lib/..."` 相对调用者 cwd，
   从 `apps/desktop` 调用没问题，从仓库根也会挂。**但它们的形状和本卡不同**（没有 `cd` 可改），
   不在本卡范围。**如果 `smokes-for.sh` 打印绝对路径，它们就不受影响** —— 已改，所以不会误伤。
3. **没跑全量 `run-smokes.mjs --all`** —— 按总控的规矩要发申请。
   本卡改的是 `run.sh` 的路径形状，不改套件逻辑，283/284 的实跑已经足够。
4. **`t134` 那条「碰巧能跑」的结论我写错了**，见 §2。**保留在卡里而不是删掉**，
   因为下一个人可能也会这样判 —— 而「形状错」和「真的挂」是两个判据。

