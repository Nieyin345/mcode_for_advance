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
- **`mcode-condition-bridge-smoke/`** —— 它是 O5 的在途文件，**先问 Office 线**
- `arc005-visual-baseline/` / `electron-u1/`（T153 刚建声明）
- `smokes-for.py` 的 `suite_kind()` / `resolve()`（T150/T152/T153 刚改）

## 七、回写

1. 5 个目录各自的形状（是不是同一个 bug）
2. 改了什么、从仓库根实跑的结果
3. **T145 守卫的范围扩没扩，判据是否和 T153 的发现逻辑一致**
4. 变异结果
5. `smokes-for.sh` 推荐的套件抽样实跑结果
6. 提交 SHA
7. **未做项 / 觉得不对但没改的**

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
