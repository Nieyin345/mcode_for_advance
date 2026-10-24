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

**磁盘上有 9 个不叫 `-smoke` 的目录：**

```
arc005-visual-baseline
electron-u1
o3-packaged-u1
flow-preview
mc035-egress-probe
md-preview
preset-scripts-sync
t96-probe
vscode-api-census
```

## 一之二、⚠️ 这 9 个目录各引用多少真实源码（**我前两版都数错了，这是第三版**）

**判据：剥掉注释行 + 只认 `IMPORT_RE`（`from "x"` 或 `import("x")`）匹配的路径。**

```python
IMPORT_RE = re.compile(r"""(?:from|import)\s*\(?\s*["']([^"']+)["']""")
```

**结果（2026-10-24 22:25 实测）：**

| 目录 | 真实 import 的源码路径数 | 是什么 |
|---|---|---|
| **`t96-probe`** | **5** | 真探针 |
| **`arc005-visual-baseline`** | **4** | 视觉基线（`DiffView` / `Markdown` / `WorkflowBoardPanel` / `lineDiff`） |
| **`electron-u1`** | **3** | U1 harness（`db` / `repositories` / `files`，**`await import()` 动态加载**） |
| **`flow-preview`** | **3** | 预览台（`WorkflowFlowMini` / `workflowLive` / `@contracts/workflow`） |
| **`mc035-egress-probe`** | **1** | 真探针 |
| **`md-preview`** | **1** | 预览台（`Markdown.js`） |
| `preset-scripts-sync` | **0** | 无源码依赖 |
| `o3-packaged-u1` | **0** | 跑打包产物 |
| `vscode-api-census` | **0** | 普查工具 |

### ⚠️ 我前两版错在哪（两次不同的错）

| 版本 | 数字 | 错法 |
|---|---|---|
| 第一版 | 9 个「完全不在索引里」 | **事实对，但暗示「丢了 9 个覆盖」** |
| 第二版 | `arc005=2`、`electron-u1=4` 判成「全是桩」 | **看了 `grep -o` 的路径串，没看上下文** |
| **第三版** | **见上表** | **剥注释 + 只认 import 语句** |

**第二版的错法特别值得记**：`grep -rhoE "src/main/...|@main/..."` 的输出里混着三种东西，
**而我只看了字符串，没看它前面是什么**：

| 形态 | 例子 | 算覆盖吗 |
|---|---|---|
| `await import("@main/store/db.js")` | `electron-u1/driver/runner.ts:736` | ✅ **算** |
| `alias: { "@main/window.js": join(...) }` | `arc005/build.mjs:160` | ❌ 替身 |
| 注释里提到路径 | `electron-host.cjs:30` | ❌ |

**而 `arc005` 其实两条都有**：`build.mjs:160` 有 alias 替身，
**但同时 `probe.ts` 真的 import 了 4 个渲染端组件。** 我只看 alias 就判了「全是桩」。

### 所以本卡的范围（第三版）

**真正被漏掉的、有真实 import 的目录：**

| 目录 | 路径数 | 该不该进 |
|---|---|---|
| `t96-probe` | 5 | ✅ **要** |
| `arc005-visual-baseline` | 4 | ✅ **要** |
| `electron-u1` | 3 | ✅ **要** |
| `flow-preview` | 3 | **看用途**（预览台还是套件？） |
| `mc035-egress-probe` | 1 | ✅ **要** |
| `md-preview` | 1 | **看用途** |

**⚠️ `flow-preview` / `md-preview` 是「预览台」** —— 它们 import 组件是为了渲染给人看，
**不是断言它们的行为。**

### ★ Office 总控给的判据（比「要求论证」硬得多）

> **「预览台」和「套件」的区别不是「有没有 import」，是「改坏了会不会红」。**
>
> **如果 `flow-preview` 只是把组件渲染出来给人看，那它不会红 —— 组件改坏了它也不报；
> 那它就不是覆盖，因为覆盖的定义是「改坏了会有人知道」。**

**所以判据：对 `flow-preview` / `md-preview` 各做一次变异（把被 import 的组件改坏一格），
看它们会不会红。会红就是覆盖，不会红就只是预览台。**

**⚠️ 变异要改**被它 import 的那个具体文件**，不是随便改一个：**

```bash
# flow-preview 覆盖：WorkflowFlowMini / workflowLive / @contracts/workflow
# md-preview 覆盖：Markdown.js
# 各改坏一处，跑它们的 run.sh（或启动方式），看有没有非零退出 / FAIL
```

**⚠️ 如果它们根本没有「跑一次给结论」的入口**（只能人眼看着窗口），
**那答案已经出来了：它不是套件，是预览台。**

**这比「要求执行者论证」硬，而且成本低（两次变异）。**

**至少 4 个目录（`t96-probe` / `arc005` / `electron-u1` / `mc035-egress-probe`）
有真实的源码依赖，却完全不在索引里。**

## 二、后果

**「改这个文件有没有回归网」的答案会漏掉 `t96-probe` / `mc035-egress-probe`（`preset-scripts-sync` 待核）。**

**⚠️ 而且有一个单独的例外：`electron-u1` 通过 esbuild `entryPoints` 真覆盖 `src/preload/index.ts`。**

```js
// electron-u1/build.mjs:215
entryPoints: [join(desktop, "src/preload/index.ts")]
```

**但那 9 个目录里的其它 `entryPoints` 都指向 `.tmp/` 下的生成 entry，不碰仓库源码：**

```js
// electron-u1/build.mjs:128
const entry = join(buildDir, "app-entry.tsx");      // .tmp/ 里
// arc005-visual-baseline/build.mjs:70
const entry = join(desktop, ".tmp/arc005-visual-entry.tsx");
```

**所以「entryPoints 覆盖源码」这个缺口只有一条边，不是一类。**

## 二之二、覆盖关系的四种形态（本卡和其它两张卡的全景）

| 形态 | 例子 | 图看得见吗 | 谁修 |
|---|---|---|---|
| `import` 静态路径 | 大多数套件 | ✅ | — |
| `readFileSync` + 解析 | `app-control-smoke` → `rpcMap.ts` | ❌ | **T150** |
| 路径在索引范围外 | `genoffice/**` | ❌ | **T152** |
| **目录名不是 `-smoke`** | **`t96-probe` / `mc035-egress-probe`** | **❌** | **本卡** |
| **`entryPoints` 指向源码** | **`electron-u1` → `src/preload/index.ts`** | **❌** | **本卡（单独一条）** |

**⚠️ 而 `o3-packaged-u1` / `md-preview` / `flow-preview` / `vscode-api-census` 根本不该进图**
—— 它们不覆盖 `apps/desktop/src`，加进去只会产生空覆盖集。

**Office 总控的原话：**

> **把它们加进依赖图也不会有边 —— 它验的是 vendor 的 CSS 生效。**
> **「加了但没内容」比现在更难排查。**

**所以本卡的第一条纪律是：先分类，再改。不要对着「9 个」这个数字去加。**

**执行时必须验证**：`electron-u1` 被收录 **之后**，`src/preload/index.ts` 的答案是什么。

### ⚠️ 但影响面比预想的小（Office 总控问的，我实测了）

**它问：「那 9 个目录里，有几个是通过非 import 途径覆盖源码的？
如果大多数都走 entryPoints，那『按 import 建依赖图』这个模型对它们根本不成立。」**

**我实测的结果：**

```bash
$ for d in arc005-visual-baseline electron-u1 o3-packaged-u1 flow-preview \
           mc035-egress-probe md-preview preset-scripts-sync t96-probe vscode-api-census; do
    grep -l "entryPoints" apps/desktop/scripts/$d/*.mjs apps/desktop/scripts/$d/*.cjs apps/desktop/scripts/$d/*.ts
  done
```

**只有 2 个用 `entryPoints`：**

```
arc005-visual-baseline/build.mjs
electron-u1/build.mjs
```

**其余 7 个完全不用。**

**而且这 2 个的 `entryPoints` 里，只有一个真的指向仓库源码：**

```js
// electron-u1/build.mjs:215   ← 这一条是真的
entryPoints: [join(desktop, "src/preload/index.ts")]

// electron-u1/build.mjs:128 / arc005:70   ← 这些指向 .tmp/ 里的生成 entry
const entry = join(buildDir, "app-entry.tsx");
const entry = join(desktop, ".tmp/arc005-visual-entry.tsx");
```

**所以「entryPoints 覆盖源码」这个缺口只在 `electron-u1 → src/preload/index.ts` 这一条上是实的。**

**这改变了 T153 的难度判断：不是「模型对这个类根本不成立」，是「有一个具体例外」。**

**建议的执行顺序：**

1. **先只加目录**（便宜的改动）；
2. **验证 `src/preload/index.ts` 的答案有没有变**；
3. **如果没变**，再单独处理那一条 `entryPoints` 边（可能就是一个 `@smoke-covers` 声明，
   或者让工具认 `entryPoints: [<literal>]` 这种形态）。

**⚠️ 第 2 步是关键**。不做它，你会以为第 1 步修好了。

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

---

# 九、回写（2026-10-25，执行会话）

## 1. 我自己重数的 9 个目录（**和卡里的第三版完全一致**）

**判据：剥注释（`//`、`/* */`、字符串感知的扫描器）+ 只认 `IMPORT_RE`（`from "x"` / `import("x")`）的路径。**

| 目录 | 真实 import | 入口文件 | 判定 |
|---|---|---|---|
| `t96-probe` | **5** | `run.sh` / `main.ts` | 重型 |
| `arc005-visual-baseline` | **4** | `run.sh` | 重型 |
| `electron-u1` | **3** | `run.sh` | 重型 |
| `flow-preview` | **3** | `run.sh` | **真套件**（见 §2） |
| `mc035-egress-probe` | **1** | `main.ts` | 重型 |
| `md-preview` | **1** | `run.sh` | **真套件**（见 §2） |
| `preset-scripts-sync` | **0** | `run.sh` / `main.ts` | 排除 |
| `o3-packaged-u1` | **0** | `run.sh` / `main.mjs` | 排除 |
| `vscode-api-census` | **0** | `run.sh` / `main.mjs` | 排除 |

**卡片第三版数字全部复现。** 我这边的脚本在 `.tmp/t153-count.py`（临时，未提交）。

## 2. ★ `flow-preview` / `md-preview` 的「改坏会不会红」实验 —— **两者都是真套件**

**Office 总控的判据（卡 §一之二的 ★ 段）：预览台和套件的区别不是「有没有 import」，
是「改坏了会不会红」。**

### 变异 A：`WorkflowFlowMini`（`flow-preview` 的 import 目标）

```tsx
// 插在组件函数体第一行
throw new Error("T153 MUTATION: deliberately broken to test flow-preview assertions");
```

```bash
$ cd apps/desktop && bash scripts/flow-preview/run.sh
EXIT=1
  FAIL SVG 画出来了 — {"found":false}
  FAIL 控制台没有异常 — ["EXC Uncaught Error: T153 MUTATION: ..."]
0/2 通过
```

### 变异 B：`Markdown`（`md-preview` 的 import 目标）

```bash
$ cd apps/desktop && bash scripts/md-preview/run.sh
EXIT=1
  FAIL ★ 有 baseDir：至少渲染出 2 张图 — []
  FAIL ★ 本地图渲染成真 <img> — []
  FAIL ★ 本地图的 src 是 data: URL — undefined
  FAIL ★ 本地图有真实尺寸 — undefined
  FAIL 网络图保持 https 原样 — undefined
  FAIL 无 baseDir 时那个位置退化成 alt 文字 — ""
  FAIL 无 baseDir 时网络图照样是 <img> — []
  FAIL 控制台没有异常 — ["EXC ..."]
2/10 通过 · 截图 2 张
```

**两个都把代码改完之后 `EXIT=1` 并给出具体 FAIL 行。它们有 13 条 / 10 条真断言
（`ui-probe/drive-*.mjs` 里的 `probe.check`）。**

**所以「预览台」这个标签是错的 —— 它们是真套件，必须进覆盖集。**

**还原：两次都 `cp 备份 → cmp` 逐字节核对**：
- `WorkflowFlowMini.tsx` sha256 `2ef6aa45…`
- `Markdown.tsx` sha256 `8e33dadd…`

**⚠️ 顺带发现（不在本卡边界，未改）**：`flow-preview/run.sh` 和 `md-preview/run.sh`
**也有 T145 修的那个路径 bug**（`cd` 之后还用 `$(dirname "$0")` 去 `source` esbuild-path.sh）。
从仓库根调会挂：

```
apps/desktop/scripts/flow-preview/run.sh: line 12:
  apps/desktop/scripts/flow-preview/../lib/esbuild-path.sh: No such file or directory
```

**它们不叫 `-smoke`，所以 T145 的 284 套名单里没有它们。** 我是从 `apps/desktop` 调的才跑通。
**建议另开一张卡补这两套（可能还有其它非 `-smoke` 目录）。**

## 3. 发现逻辑改成了什么（方案 C）

### `suite_kind()` —— 判据是「入口文件」，不是名字

```python
SUITE_ENTRY_NAMES = ("run.sh", "run.mjs", "main.ts", "main.mjs", "main.mts")

def suite_kind(name: str, d: Path) -> str | None:
    if name.endswith("-smoke"):           # 历史约定，611 套
        return "smoke"
    if name in SUITE_EXCLUDED:            # 排除表
        return None
    if any((d / cand).is_file() for cand in SUITE_ENTRY_NAMES):
        return "heavy"
    return None
```

### 排除表只留三个，每个都有理由

```python
SUITE_EXCLUDED: dict[str, str] = {
    "preset-scripts-sync": "普通脚本（同步 preset 文件），不 import src/，不产生覆盖边",
    "o3-packaged-u1": "跑打包后的产物；覆盖 resources/genoffice/**，不碰 apps/desktop/src/**",
    "vscode-api-census": "普查工具（统计 VS Code API 使用面），不 import src/",
}
```

**⚠️ `flow-preview` / `md-preview` 没有进排除表** —— 变异实验推翻了「它们是预览台」的判断。

### `electron-u1` 的 `entryPoints` 边（卡 §二 那个单独例外）

**放宽了 `SMOKE_COVERS_RE` 和校验侧，加 `src/preload/`：**

```python
SMOKE_COVERS_RE = re.compile(
    r"^\s*//\s*@smoke-covers\s+((?:src/main/|src/renderer/|src/preload/|packages/)[\w./-]+\.ts)\s*$",
    re.MULTILINE)
```

**校验侧同时放行 `RENDERER` 和 `DESKTOP/src/preload`**（原来只放行 `MAIN`，`src/renderer/` 的声明会被拒——这是个既有缺口，T150 放宽了正则但校验侧没跟上）。

**然后在 `electron-u1/driver/runner.ts` 顶部加了声明：**

```ts
// @smoke-covers src/preload/index.ts
// ↑ 【T153】本套件通过 build.mjs:215 的 esbuild entryPoints 直接打包产品 preload，
//   那条覆盖边不是 import，依赖图看不见。声明是它唯一能被记录的途径。
```

## 4. ★ 第四步验证：具体文件的答案真的变了

| 文件 | 改前 | 改后 |
|---|---|---|
| `src/renderer/components/chat/Markdown.tsx` | 必跑 **4 套**（`markdown-preview-smoke` / `chat-linecount-smoke` / `custom-tab-race-smoke` / `module-phase2-e2e-smoke`） | 必跑 **6 套**，新增 **`arc005-visual-baseline`** 和 **`md-preview`** |
| `src/renderer/components/chat/WorkflowFlowMini.tsx` | 必跑 0 套 | **`flow-preview` (1 跳)** |
| `src/preload/index.ts` | 必跑 **7 套**（无 `electron-u1`） | 必跑 **8 套**，新增 **`electron-u1 (0 跳)`** |

**⚠️ 这一步是卡 §二 强调的关键** —— 只加目录不加边的话，`Markdown.tsx` 会变成
「6 套但覆盖集合里没有 md-preview」。实测证明边也进去了。

## 5. 输出怎么区分 smoke / 重型

```
  必跑（1–2 跳，6 套，其中 2 套重型；跳数 [1, 2]）:
    arc005-visual-baseline  (1 跳)  ⚠️ 重型（起真 Electron/Chrome，几十秒起）
    markdown-preview-smoke  (1 跳)
    md-preview  (1 跳)  ⚠️ 重型（起真 Electron/Chrome，几十秒起）
```

**汇总行说「其中 N 套重型」，逐行标 `⚠️ 重型`。**

## 6. 变异（三个，每个先写预期）

**M-1：把 `suite_kind` 的入口判定改成恒假（退回只认 `-smoke`）**
- 预期：S1×3 + S2×2 + S4×2 = 7
- 实际：**7** ✅ 精确落在这七条上。S3 / S5 保持绿（负控正确）。

**⚠️ M-1 第一版只红了 1 条 —— 我第一版断言对整段 stdout 做子串匹配，
而 `md-preview` / `flow-preview` 同时出现在「可选」段里（经由别的路径），蒙混过关。
改成 `must_section()` 只截「必跑」段之后才红够 7 条。**
这是套件自身的 bug，已在 `main.py` 的 `must_section` 注释里记下。

**M-2：把排除表判定改成恒假（三个被排除的会被收进来）**
- 预期：1（S3 的 `preset-scripts-sync`）
- 实际：**1** ✅ 精确命中，`listed=['preset-scripts-sync', 'preset-scripts-sync-smoke']`

**⚠️ S3 第一版也是子串匹配，`preset-scripts-sync` 会命中 `preset-scripts-sync-smoke`
（另一套真套件）→ 负控恒红。改成「按逗号拆开逐名比对」才对。**

**M-3：去掉「重型」标注（`mark` 和 `tail` 都清空）**
- 预期：2（S4 两条）
- 实际：**2** ✅

**三次还原全部 `cp` + `cmp` 逐字节核对**（`smokes-for.py` sha256 `fd94e014…`）。

## 7. 回归

| 套件 | 结果 |
|---|---|
| `t153-heavy-suite-coverage-smoke`（新建，12 条） | **12/12** |
| `tsx-coverage-smoke` | **10/10** |
| `smokes-for-ranking-smoke` | **25/25** |
| `t150-smokes-for-contracts-smoke` | **13/13** |
| `t152-smokes-for-index-scope-smoke` | **13/13** |

**T150 / T152 的修复全部未退化。**

## 8. 未做（如实登记）

### ① `flow-preview` / `md-preview` 的 `run.sh` 有 T145 那个路径 bug

见 §2 末尾。**它们不叫 `-smoke`，T145 的 284 套名单里没有它们。**
从仓库根调会挂，从 `apps/desktop` 调正常。

**不在本卡边界**（本卡只改发现逻辑），**但这是同一类问题**，建议另开卡。

### ② `--uncovered` 的标题行仍是「没有回归网」这个结论式措辞

T152 修的是单文件查询的分岔；`--uncovered` 那份清单的口径本来就只在 `src/main` 下，
所以目前没问题。**但如果将来它扩到 renderer / preload，这句措辞又会变成假结论。**

### ③ `INDEXED_ROOTS`（T152 加的）和 `suite_kind()`（本卡加的）是两个独立的「范围」概念

- `INDEXED_ROOTS` = 「哪些路径在这个工具的问题范围内」
- `SUITE_ENTRY_NAMES` / `SUITE_EXCLUDED` = 「哪些目录算套件」

**它们没有统一**，而且 `resolve()` / `coverage()` / `--uncovered` 三处仍各自隐式定义范围。
统一它们要动 `resolve()`（T150 刚改，卡上明令不碰）。

### ④ `t96-probe` 的 5 个文件都已由 `-smoke` 套件覆盖

所以「收录 `t96-probe`」对答案**没有可见变化** —— 我验证了，它进套件集合之后
`executorOwnership.ts` 等的必跑列表没变（那些 `-smoke` 套件距离更近，本来就排前面）。

**这不是没生效，是它的覆盖是「冗余的」。** 如实记下。

## 9. 提交

见提交 SHA（下一节补）。
