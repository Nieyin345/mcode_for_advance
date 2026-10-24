# T154 — T153 收进来的 5 个套件有 T145 那个路径 bug

**Status**：`ready-for-agent`
**Category**：P0 测试基础设施
**发现者**：T153 的执行会话（它在回写 §未做 第 1 条记录）
**写卡时间**：2026-10-25 00:10。**下面前提我都实测过。**

## 一、症状

T145 修了 284 套 `run.sh` 的路径 bug（`cd` 之后还用 `dirname "$0"`）。
**但它的名单只包含 `*-smoke` 结尾的目录。**

T153 把发现逻辑从「名字以 `-smoke` 结尾」改成「有入口文件」，
**于是 5 个之前不在名单里的目录浮出来了，它们全都还有那个 bug：**

```bash
$ for f in apps/desktop/scripts/*/run.sh; do <检测>; done
剩余 5:
  apps/desktop/scripts/flow-preview/run.sh
  apps/desktop/scripts/mcode-condition-bridge-smoke/run.sh    ← 新的（O5 刚建）
  apps/desktop/scripts/md-preview/run.sh
  apps/desktop/scripts/preset-scripts-sync/run.sh
  apps/desktop/scripts/t96-probe/run.sh
```

**实测：**

```bash
$ bash apps/desktop/scripts/flow-preview/run.sh
apps/desktop/scripts/flow-preview/run.sh: line 12:
  apps/desktop/scripts/flow-preview/../lib/esbuild-path.sh: No such file or directory
EXIT=1
```

## 二、为什么现在比以前更严重

**T153 之后，`smokes-for.sh` 会把这些目录列为「必跑」：**

```bash
$ bash apps/desktop/scripts/smokes-for.sh src/renderer/components/chat/Markdown.tsx
  必跑（1–2 跳，6 套，其中 2 套重型；跳数 [1, 2]）:
    arc005-visual-baseline  (1 跳)  ⚠️ 重型
    markdown-preview-smoke  (1 跳)
    md-preview  (1 跳)  ⚠️ 重型              ← 它现在会推荐这个
    ...
  bash D:/.../apps/desktop/scripts/<名字>/run.sh    ← 打印的这条用法会挂
```

**所以：工具推荐了它，而工具打印的用法跑不了它。**

**这比修复前更坏** —— 修复前这些目录根本不被推荐，没人会去跑；
**现在它们被推荐了，而按文档跑就是红。**

## 三、根因

```bash
cd "$(dirname "$0")/../.."                          # ← 先 cd
source "$(dirname "$0")/../lib/esbuild-path.sh"     # ← 再用相对路径的 $0
```

**`cd` 之后 `$0` 仍是调用者给的相对路径**，所以拼出
`apps/desktop/apps/desktop/scripts/...` —— 不存在。

**正确的形状（`t138` / `t139` / `t140` 已经是）：**

```bash
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
```

## 四、任务

### 第一步：先确认这 5 个都是同一个形状（不要盲改）

```bash
for f in flow-preview mcode-condition-bridge-smoke md-preview preset-scripts-sync t96-probe; do
  echo "=== $f ==="
  grep -n "cd \|dirname\|HERE=" apps/desktop/scripts/$f/run.sh | head -6
done
```

**⚠️ `mcode-condition-bridge-smoke` 是新的**（O5 刚建），它可能形状不同 —— 先看。

### 第二步：逐套改

**⚠️ 每个文件都要：**
1. 先 `cp` 备份；
2. 改完从仓库根实跑一次，确认 `EXIT=0` 或至少不是路径错；
3. `cmp` 逐字节还原验证（如果要做变异）。

### 第三步：扩展 T145 的守卫

**`t145-runsh-path-smoke` 现在的判据是「所有 `*-smoke/run.sh`」吗？还是「所有 `run.sh`」？**

```bash
grep -n "glob\|rglob\|-smoke" apps/desktop/scripts/t145-runsh-path-smoke/main.* | head -5
```

**如果它只扫 `*-smoke`，那把范围扩到所有 `run.sh`。**

**⚠️ 但 T153 的发现逻辑已经改了** —— 守卫应该和它一致，否则会出现
「T153 说这是套件，T145 的守卫不看它」的分裂。

### 第四步：验证工具推荐的和能跑的一致

**这是本卡的核心判据：**

```bash
# 对每个被 smokes-for 推荐的套件，从仓库根跑一次
# 断言：不出现 "No such file or directory"
```

**做法**：延伸 `t145-runsh-path-smoke` 或新建，但**必须是「从仓库根实跑」而不是静态检查**
（CLAUDE.md 第三十五条：静态检查抓一种拼写，抓不住变体）。

**⚠️ 但它不能跑全部 600+ 套**（太慢）。**收窄到「不在 `-smoke` 里的那些」** ——
因为 `-smoke` 的那批已经过了 T145 的实跑验证。

## 五、验收

1. **5 个目录全部修好**，从仓库根跑 `EXIT=0` 或至少不是 `No such file or directory`。
2. **T145 的守卫覆盖到它们**（判据和 T153 的发现逻辑一致）。
3. **变异**：把其中一套改回 `cd` + `dirname "$0"` → 守卫必须红。
4. **不回归**：T145 的 8 条断言（除 `o4` 那条）、T153 的 12 条全绿。
5. **`smokes-for.sh` 推荐的每一套都能跑**（抽样验证，不用全量）。

## 六、边界

**可以改**：
- `apps/desktop/scripts/{flow-preview,md-preview,preset-scripts-sync,t96-probe}/run.sh`
- `apps/desktop/scripts/t145-runsh-path-smoke/`（扩范围）
- 新建套件

**不许碰**：
- ~~`mcode-condition-bridge-smoke/` —— 它是 O5 的在途文件，先问 Office 线~~
  **✅ 已确认可以改**：它已提交在 `032a6882`（`git status` 干净），不是在途文件。
- `arc005-visual-baseline/` / `electron-u1/`（T153 刚建声明）
- `smokes-for.py` 的 `suite_kind()` / `resolve()`（T150/T152/T153 刚改）

## 七、回写

### 1. 5 个目录各自的形状

**全部是同一个 bug，没有例外。** `mcode-condition-bridge-smoke` 虽然更新，结构与另外四个一致：

| 目录 | 原来的 `cd` 行 | 原来的 `source` 行 |
|---|---|---|
| `flow-preview` | `:8` | `:12` |
| `mcode-condition-bridge-smoke` | `:7` | `:13` |
| `md-preview` | `:8` | `:12` |
| `preset-scripts-sync` | `:10` | `:15` |
| `t96-probe` | `:16` | `:23` |

**⚠️ 注意 `flow-preview` / `md-preview` 还有第二次 `cd scripts/ui-probe`（`:25` / `:24`）** ——
那是相对 `apps/desktop` 的，**改成 `HERE` 之后不受影响**（它在 `cd "$HERE/../.."` 之后执行）。

### 2. 改了什么、从仓库根实跑的结果

**统一改成 `HERE` 形状，每套只动两处（`cd` 行 + `source` 行）：**

```bash
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
```

**改前（全部 rc=1，全是路径错）：**

```
flow-preview                   rc=1  .../lib/esbuild-path.sh: No such file or directory
mcode-condition-bridge-smoke   rc=1  同上
md-preview                     rc=1  同上
preset-scripts-sync            rc=1  同上
t96-probe                      rc=1  同上
```

**改后（从仓库根跑）：**

| 目录 | rc | path_err | 结果 |
|---|---|---|---|
| `flow-preview` | **0** | 0 | `20/20 通过 · 截图 3 张` |
| `mcode-condition-bridge-smoke` | **0** | 0 | `47/47 通过（其中负控 9 条）` |
| `md-preview` | **0** | 0 | `10/10 通过 · 截图 2 张` |
| `preset-scripts-sync` | **2** | 0 | **用法错**（见下） |
| `t96-probe` | **1** | 0 | 53/54，1 条真 FAIL（见下） |

**⚠️ `preset-scripts-sync` 的 rc=2 不是回归**：它要求 `--check` 或 `--write`，不带参数就退出 2。
**带 `--check` 从仓库根跑 → EXIT=0**（已验证：`预设里的 Python 正文与 assets.ts 一致`）。

**⚠️ `t96-probe` 的 rc=1 不是本卡引入的**：我用 `git stash` 把 `run.sh` 退回改前状态、
从 `apps/desktop` 跑（那条路改前就是通的），**同样 rc=1、同样 2 行 FAIL**。
失败内容是 `★ 6 个节点类型各有一个 .js — [7 个 .js]`（实际 7 个，断言写死 6 个）。
**与路径无关，是另一条线的账，本卡不改。**

### 3. T145 守卫的范围扩没扩

**扩了。** `t145-runsh-path-smoke/build.mjs:46` 原来：

```js
.filter((n) => n.endsWith("-smoke") && ...)
```

**改成 `allRunShDirs`（所有含 `run.sh` 的目录），判据循环也换到它上面。**

**判据与 T153 的发现逻辑一致**：T153 的 `suite_kind()` 用
`SUITE_ENTRY_NAMES = ("run.sh", "run.mjs", "main.ts", "main.mjs", "main.mts")`；
守 scope 取其中「有 `run.sh`」的子集 —— **因为本守卫要扫的就是 `run.sh`。**
差异只在于 T153 还认 `main.ts` 之类的入口（那些没有 `run.sh`，本守卫没有可扫的对象）。

**扫描规模：625 个 `-smoke` → 633 个含 `run.sh` 的目录。**

**改后 8/8 全绿**（包括 `o4-docs-close-smoke` —— 它已经被 Office 线修好了）。

### 4. 变异

| # | 变异 | 预期 | 实际 |
|---|---|---|---|
| M-1 | 把 `flow-preview` 改回 `cd` + `dirname "$0"` | 红 1（第 [1] 条） | **红 1**，点名 `flow-preview/run.sh:12` ✅ |

**还原用 `cp` + `cmp` 逐字节核对通过。还原后守卫复绿 8/8。**

### 5. `smokes-for.sh` 推荐的套件抽样实跑

**非 `-smoke` 且有 `run.sh` 的 8 个目录，全部从仓库根实跑：**

| 目录 | rc | path_err |
|---|---|---|
| `flow-preview` | 0 | 0 |
| `mcode-condition-bridge-smoke`（名字带 `-smoke`，一并验） | 0 | 0 |
| `md-preview` | 0 | 0 |
| `preset-scripts-sync` | 2（用法） | **0** |
| `t96-probe` | 1（真 FAIL） | **0** |
| `o3-packaged-u1` | 0（`O3: PASS`） | 0 |
| `vscode-api-census` | 0 | 0 |
| `arc005-visual-baseline` / `electron-u1` | **未实跑**（真 Electron，几分钟起） | 静态检查：只在 `cd` 那行用 `$0`，之后不再用 —— **安全** |

**⚠️ `arc005` / `electron-u1` 没实跑的原因**：它们起真 Electron，单套几分钟。
**它们的 `run.sh` 里 `$0` 只出现在 `cd` 行**（那行在 `cd` 之前求值，正确），
**所以静态判据已经能排除这个 bug。** 但「能跑」这件事我没实测 —— 记为未做。

### 6. 提交 SHA

见下方「提交」。

### 7. 未做 / 觉得不对但没改的

1. **`arc005-visual-baseline` / `electron-u1` 没从仓库根实跑** —— 真 Electron，几分钟。
   静态判据通过（`$0` 只在 `cd` 行），但「能跑」未实测。
2. **`t96-probe` 的 1 条 FAIL**（`6 个节点类型各有一个 .js` vs 实际 7 个）——
   与本卡无关（改前就是红的），**但它现在被 T153 收进推荐列表了，会在必跑里显示红。**
   这是另一条线的账，我没开卡（超出本卡边界）。
3. **`preset-scripts-sync` 不带参数 rc=2** —— 这是它的用法设计（要求 `--check` / `--write`）。
   **但 `smokes-for.sh` 推荐它时打印的用法不带参数** —— 读者照抄会得到 rc=2。
   **和本卡的症状是同一族**（工具推荐的东西按推荐用法跑不通），**但修法不同**（要么改用法提示，要么改推荐）。没改。
4. **守卫的判据 `runShCount > 400` 没跟着调** —— 现在是 633，阈值 400 仍然过，但**它离实际值越来越远**。
   没改（改阈值会削弱「零输入恒绿」的保护，需要单独判断）。

---

## 附：这条是「修复放大既有缺陷」的第二个实例

**CLAUDE.md 第三十八条记过第一个**：

> **T150 修的是「跳数/覆盖显示」两个 bug。它修好之后，那个「⚠️ 没有套件覆盖」会变得更可信 ——
> 而它在 vendor 路径上恰恰是错的。**
> **修得越好，错得越有说服力。**

**这次是同一个形态，但方向相反：**

| | T150 那次 | 这次 |
|---|---|---|
| 修复让什么变强 | 「没有覆盖」这句话的可信度 | **工具的推荐列表** |
| 放大了什么缺陷 | vendor 路径的假否定 | **被推荐的套件跑不了** |
| 后果 | 读者信了错的话 | **照文档做就是红** |

**共同点**：**修复提高了某个东西的可信度，而它相邻的另一半还没修。**

---

## 九、主控复核（2026-10-25 00:25）

**我亲自跑的（不是照抄回写）：**

```bash
$ bash apps/desktop/scripts/flow-preview/run.sh                    → rc=0, 20/20, path_err=0
$ bash apps/desktop/scripts/md-preview/run.sh                      → rc=0, 10/10, path_err=0
$ bash apps/desktop/scripts/mcode-condition-bridge-smoke/run.sh    → rc=0, 47/47, path_err=0

$ bash apps/desktop/scripts/t145-runsh-path-smoke/run.sh
t145-runsh-path-smoke —— 626 个 smoke 目录，共 634 个带 run.sh 的目录
8/8 passed; 0 failed
```

**全仓现在 0 个 `cd` 之后仍用 `$0` 的 `run.sh`。** 守卫从 625 扩到 634（覆盖所有带 `run.sh` 的目录）。

### 补一条回写没提的：`preset-scripts-sync` 的用法错在 `main.ts`，不在 `run.sh`

**回写说「不带参数 rc=2 是它的用法设计」—— 对，但值得说清它在哪：**

```bash
# run.sh 的最后一行把参数透传给它自己的 main.ts
node "$OUT/sync.mjs" "$@"
```

**所以用法检查在 `apps/desktop/scripts/preset-scripts-sync/main.ts` 里，不在 `run.sh` 里。**
**这意味着「改 `run.sh` 让它自动带 `--check`」是一个可行但需要判断的选择** ——
**因为 `--write` 是它的另一个正当用法，自动带 `--check` 会让 `--write` 失效。**

**所以这一条不该「修」，该「在推荐输出里注明」。** 归到 T151/T153 那条线（输出要说清用什么用法）。

### 另一条：`t96-probe` 的 53/54

**回写已经归因清楚了**（stash 验证过，与路径无关）。
**但它现在会出现在 T153 的推荐里** —— 读者会看到一条真 FAIL。
**这不是本卡能修的**（那是 `t96-probe` 自己的业务断言），建议另开卡。
