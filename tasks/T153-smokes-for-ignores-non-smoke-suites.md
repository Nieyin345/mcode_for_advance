# T153 — `smokes-for.sh` 只认 `*-smoke` 结尾的目录，漏掉整类套件

**Status**：`ready-for-agent`
**Category**：P0 测试基础设施
**发现者**：总控（office）—— 它问「我的 `o3-packaged-u1` 会被认吗」，我查出来不会
**写卡时间**：2026-10-24 22:15。**下面前提我都实测过。**

## 一、症状

`smokes-for.py:331-332`：

```python
for d in sorted(HERE.iterdir()):
    if not d.is_dir() or not d.name.endswith("-smoke"):
        continue
```

**只扫 `-smoke` 结尾的目录。**

**所以下面这 9 个目录的覆盖完全不计入：**

```bash
$ ls -d apps/desktop/scripts/*/ | 排除 *-smoke
  arc005-visual-baseline       ← 真套件（build.mjs + compare.mjs + probe）
  electron-u1                  ← 真套件（journeys/）
  o3-packaged-u1               ← 真套件（main.mjs + run.sh）
  flow-preview
  mc035-egress-probe
  md-preview
  preset-scripts-sync
  t96-probe
  vscode-api-census
```

**其中至少 3 个是真的有覆盖能力的套件。**

## 二、后果

**「改这个文件有没有回归网」的答案会漏掉这些套件。**

**⚠️ 而且比「漏掉目录」更深：有些套件的覆盖关系在 `build.mjs` 的 `entryPoints` 里，不在 import 图上。**

**我实测的（写卡时）：**

```bash
# electron-u1/build.mjs 直接打包真实源码
:215   entryPoints: [join(desktop, "src/preload/index.ts")]
:249   entryPoints: [join(suite, "driver/runner.ts")]
:269   entryPoints: [registry]

# 但 journeys/ 里没有任何 `import ... from "@main/..."` 语句
$ grep -rhoE "^import .*from ['\"][^'\"]+['\"]" apps/desktop/scripts/electron-u1/ | grep -E "@main|src/main"
(空)
```

**所以 `electron-u1` 确实覆盖 `src/preload/index.ts`，但依赖图看不见这条边**
—— 因为它不是 `import`，是 esbuild 的 `entryPoints` 配置。

**⚠️ 这和 T150 的 `readFileSync` 是同一类问题（非 import 的覆盖关系），
但形态不同：**

| 形态 | 例子 | 图看得见吗 |
|---|---|---|
| `import` 静态路径 | 大多数套件 | ✅ |
| `readFileSync` + 解析 | `app-control-smoke` → `rpcMap.ts` | ❌（T150） |
| **esbuild `entryPoints`** | **`electron-u1` → `src/preload/index.ts`** | **❌（本卡）** |

**所以本卡不只是「加几个目录」，还要让工具认得 `entryPoints` 这种覆盖声明。**

**⚠️ 如果只加目录而不认 `entryPoints`，结果仍然是「套件被发现了但覆盖集合是空的」。**

**这个区别很重要**：目录加进 `suites` 之后，如果 `covered` 是空集，
答案仍然是「没有套件覆盖」—— **只是从「目录不认」变成了「认了但没内容」。**

**执行时必须验证**：`electron-u1` 被收录 **之后**，`src/preload/index.ts` 的答案是什么。

## 三、为什么它们不叫 `-smoke`

**看名字就知道：**

| 目录 | 为什么不是 smoke |
|---|---|
| `arc005-visual-baseline` | 它起**真 Electron** 截图，30+ 秒 |
| `electron-u1` | 真 Electron U1 harness |
| `o3-packaged-u1` | 打包后验证 |

**它们是「重型套件」**，而 `-smoke` 这个名字在本仓库的语义是「无头、秒级」。

**所以这不是「命名错了」，是「工具只认一类套件」。**

## 四、任务

### 第一步：先核实影响面（不要直接改）

```bash
# 1. 这 9 个目录里，哪些真的 import 了 src/？
for d in arc005-visual-baseline electron-u1 o3-packaged-u1 flow-preview mc035-egress-probe md-preview preset-scripts-sync t96-probe vscode-api-census; do
  echo "=== $d ==="
  grep -rl "src/main\|src/renderer\|@main/\|@renderer/" apps/desktop/scripts/$d/ 2>/dev/null | head -3
done

# 2. 它们覆盖了哪些 src/ 文件？
# 3. 这些文件里，有多少现在被报「无覆盖」？
```

**⚠️ 这一步的结果决定改法。**

**如果只有 2–3 个目录真的有覆盖**，就只加它们；
**如果 9 个都有**，就要考虑更一般的机制。

### 第二步：改发现逻辑

**两种做法：**

| 做法 | 说明 |
|---|---|
| **A. 按「有没有 run.sh 或 main.*」判** | 只要目录里有入口文件就当套件 |
| **B. 显式白名单** | 列出现在要收的目录名 |
| **C. 两者结合** | 默认按入口文件判，但有一个排除表（给 `flow-preview`、`md-preview` 这类预览台） |

**我倾向 C**，理由：

- A 会把 `md-preview` / `flow-preview` 这类**预览台**（不是套件）也收进来；
- B 会漏掉将来新增的重型套件；
- **C 的关键是「排除表要写明理由」** —— 每排除一个目录，写一行「它是预览台，不是套件」。

**⚠️ 但排除表的判据要可验**：不能只靠名字。建议判：

```
有 run.sh 或 run.mjs 或 main.{ts,mjs,mts} → 是套件
否则 → 记进排除表，并写明它是什么
```

### 第三步：「纯 smoke」和「全部」要有区别

**⚠️ 这可能改变 `smokes-for.sh` 的语义。**

现在的名字是 `smokes-for`，**如果它开始回答「重型套件也覆盖了」，那它就不再只是 smoke 的工具了。**

**两个选择：**

| 选择 | 说明 |
|---|---|
| **A. 保持一个工具**，但输出里标明「其中 N 个是重型套件」 | 简单 |
| **B. 加 `--include-u1` 开关**，默认只 smoke | 不改变现有语义，但默认答案仍是错的 |

**我倾向 A** —— **默认答案不该是错的。** 但要在输出里标明，让读者知道这个「套件」可能要跑 30 秒。

## 五、验收

1. **`electron-u1` / `arc005-visual-baseline` / `o3-packaged-u1` 的覆盖被计入。**
2. **预览台（`md-preview` 等）不被算成套件**，且排除理由写清。
3. **输出里能区分「smoke」和「重型」。**
4. **不回归**：现有的 611 套 `-smoke` 的判定完全不变。
5. **不回归**：T150 / T152 的修复仍然有效（`rpcMap.ts` → 必跑 1 套；`genoffice` → 「不在索引范围」）。

## 六、变异

| # | 变异 | 预期红 |
|---|---|---|
| M-1 | 把 `electron-u1` 从套件集合里去掉 | 1（它的覆盖那条） |
| M-2 | 把 `md-preview` 算成套件 | 1（排除表那条） |
| M-3 | 输出里不标「重型」 | 1（区分那条） |

## 七、边界

**可以改**：
- `apps/desktop/scripts/smokes-for.py` 的 `coverage()` 发现逻辑
- 新建套件

**不许碰**：
- `arc005-visual-baseline/` / `electron-u1/` / `o3-packaged-u1/` 内部（只读它们的目录结构）
- `apps/desktop/scripts/*/run.sh`（T145 刚改完）
- T150 / T152 修的 `resolve()` / 那个 `else` 分支

**⚠️ 与 T150 / T152 的关系**：它们在改同一个文件的不同部分。
**开工前必须确认那两张卡的改动已提交。**

## 八、回写

1. **第一步的影响面核实结果**（9 个目录里几个真有覆盖，覆盖了哪些文件）
2. 选了 A / B / C 哪个，排除表怎么定
3. 输出现状（区分轻重型了吗）
4. 变异结果
5. T150 / T152 的修复有没有回归
6. 提交 SHA
7. **你觉得不对但没改的**

---

## 附：这条和 T152 是同一族的两个方向

| 卡 | 错误方向 |
|---|---|
| **T152** | 不在索引里的路径 → 说「没有覆盖」（**假否定**） |
| **T153** | 在磁盘上、但名字不合规矩的套件 → 不索引（**漏收**） |

**两者合起来说明同一件事：`smokes-for.sh` 的「覆盖」概念有两个隐含边界（路径范围、命名规则），而它只对其中的一个说了一句话。**

**T152 修的是「路径范围」那一半，本条修「命名规则」那一半。**
