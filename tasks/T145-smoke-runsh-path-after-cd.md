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

1. **改之前实跑的结果**：多少套 rc=0、多少套非 0、分别是哪些（`/tmp/before.txt` 的摘要）
2. **真挂的套件清单**（不是 284，是其中 rc≠0 的那些）
3. 改了什么形状、加在哪几套
4. **守卫断言的变异结果**（预期红 1，实际红几条，红的对不对）
5. 改后实跑结果，和 before 的 diff
6. 提交 SHA
7. 有没有觉得不对但没改的
