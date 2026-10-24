# F020｜加一条 RPC 却拿不到回归网：`smokes-for.sh` 看不见 `rpcMap.ts`

> ## ⛔ 本卡不执行 —— 已并给 `tasks/T150`
>
> 这张卡写完之后，UI 总控开了 **T150** 做同一件事（`0884087d`）。**两个人同时改
> `smokes-for.py` 必然打架**，所以这里只留档，不派。
>
> **保留它的理由是它记了 T150 卡里没有的机制**，那段已经单独发给 UI 总控：
>
> **contracts 文件是通过「套件里的相对路径 import」进图的，不是 `@contracts/`。**
>
> ```python
> # smokes-for.py resolve()
> elif spec.startswith("@contracts/"): return None      # 丢掉
> elif spec.startswith("."):                             # 相对路径照常解析
>     base = (from_file.parent / spec).resolve()
> ```
>
> 而真实套件里有：
> ```ts
> // capability-smoke/main.ts:1
> import { resolveCapabilities } from "../../../../packages/contracts/src/capability.js";
> ```
>
> **这条边解析成功 → contracts 进了图 → `:417` 的 `p.relative_to(DESKTOP)` 抛 `ValueError`。**
> 崩在 `moduleCapability.ts` 而不是 `modules.ts`，是因为 `modules.ts:4` 有一跳
> `import type ... from "./moduleCapability.js"`，`closure()` 顺着又走深了一层。
>
> **两个症状、两个修法，别混**：
>
> | 症状 | 机制 | 修法 |
> |---|---|---|
> | `rpcMap.ts` 答「没有覆盖」 | `readFileSync` + `ts.createSourceFile` 读文本，**图上完全没有这条边**（连相对 import 都没有） | 一条**显式声明**（`@smoke-covers` 或等价物） |
> | `modules.ts` 崩 | 相对路径 import **进了图**，但「上一跳」在 `apps/desktop` 外，距离算不出来 | 修 `:417`，用 `ROOT` 兜底，**别 try/except 吞掉**（吞了「上一跳是谁」就没了） |

- Category: **P0 扩展主线（闭环的必要条件）**
- 发现于：T148（`cc3e4da4`）—— F006 加了 `modules.installVsix`，`apiCatalog.generated.ts` 没跟，
  **而加 RPC 的人按仓库规矩跑 `smokes-for.sh` 得到的是一句「没有套件覆盖它」**
- 独占写入边界：
  - `apps/desktop/scripts/smokes-for.py`
  - `apps/desktop/scripts/smokes-for.sh`（若需同步）
  - 新建/扩充 `apps/desktop/scripts/smokes-for-smoke/`（若不存在，见下文「套件」一节）
  - `apps/desktop/src/main/appControl/channelIdempotency.ts`（**只加断言，不加逻辑**，见第四节）
  - `apps/desktop/scripts/app-control-smoke/main.ts`（只改那条断言的名字与 hint）
  - 本卡回写
- **不碰**：`packages/contracts/src/ipc/rpcMap.ts`、`apps/desktop/src/main/appControl/policy.ts`、
  `apiCatalog.generated.ts`（生成物由脚本重跑，不手改）

---

## ⚠️ 读卡前先做两件事

这张卡的事实前提是 **2026-10-24 21:45** 实测的。你读的时候可能已经变了：

```bash
git status --porcelain apps/desktop/scripts/smokes-for.py    # 有人还在改吗
git log --oneline -3 -- apps/desktop/scripts/smokes-for.py   # 最近有人提交过吗
```

**T145（`tasks/T145-smoke-runsh-path-after-cd.md`）在写卡时正在改这个文件**（只改打印那句）。
**如果它还没提交，先等它提交，从新 HEAD 开始。** 两个人同时改 `smokes-for.py` 一定会打架。

---

## 一、症状（两条，都要复现）

```bash
cd "<仓库根>"
bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/ipc/rpcMap.ts
```

**当前输出**：

```
  ⚠️ 没有套件覆盖它 —— 改这里没有回归网。
     要么补一套,要么改完自己写一次性探针验一遍然后删掉。
```

**但这是假的。** `app-control-smoke` 有一条断言：

```
★ 功能清单与 RpcMap 逐条对齐（差一条 agent 就看不见它的说明）
```

它在 `apps/desktop/scripts/app-control-smoke/main.ts:2781` 用
`ts.createSourceFile(...)` 解析 `rpcMap.ts`，**逐条比对** `API_CATALOG`。

**它是真的在守 `rpcMap.ts`，而且是这个仓库里唯一守它的东西。**

```bash
bash apps/desktop/scripts/smokes-for.sh src/main/appControl/apiCatalog.generated.ts
```

**当前输出**：`必跑（1–2 跳，14 套）` —— 改「症状文件」（生成物）有 14 套，
改「根因文件」（`rpcMap.ts`）得到一句放行。**方向刚好反过来。**

### 第二条：它还会崩

```bash
bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/modules.ts
```

**当前输出**（不是「没有覆盖」，是 traceback）：

```
File ".../smokes-for.py", line 417, in main
    key = p.relative_to(DESKTOP).as_posix() if p is not None else "(不可达)"
ValueError: '...\packages\contracts\src\moduleCapability.ts' is not in the subpath of
            '...\apps\desktop'
```

**一个「这个文件谁来守」的工具，对一个真实文件直接崩掉，等于那里完全没有答案。**

---

## 二、机制（我已查到，你要复核）

`smokes-for.py` 的覆盖图**只走 import**。`IMPORT_RE` 抓 `from "x"` / `import("x")` / `import "x"`。

而 `app-control-smoke` 是这样拿 `rpcMap.ts` 的：

```ts
// app-control-smoke/main.ts:274
const rpcSource = readFileSync(join(repoRoot, "packages/contracts/src/ipc/rpcMap.ts"), "utf8");
// :2781
const rpcFile = ts.createSourceFile("rpcMap.ts", src("../../packages/contracts/src/ipc/rpcMap.ts"), ...);
```

**`readFileSync` 不是 import，图上看不见。**

而 `resolve()` 里 `@contracts/` 是 `return None`（`:92`，「别的包，不算主进程文件」）。
**所以按理说 `rpcMap.ts` 根本不该进图 —— 那它为什么会有「命中 0 套」这个答案，而不是「这文件不在我的管辖范围」？**

**第二处 bug 要认真查**：`packages/contracts/src/modules.ts` 崩在 `p.relative_to(DESKTOP)`，
说明 `modules.ts` **确实有命中套件**，而且「上一跳」`p` 在 `packages/contracts` 下。
**`@contracts/` 既然 `return None`，这条边是从哪来的？** 要么 `resolve()` 有别的分支漏了，
要么套件里有 `../../packages/contracts/...` 这种相对路径 import（`resolve()` 的 `.` 分支会解析它）。

**先把这两条查清楚再动手。** 不要一上来就加 `@smoke-covers` 支持 —— 如果根因是
「相对路径 import 进了图但下不去」，那修法完全不同。

---

## 三、要改成什么

### 3.1 `@smoke-covers` 要能表达 `packages/contracts/**`

现在：

```python
SMOKE_COVERS_RE = re.compile(r"^\s*//\s*@smoke-covers\s+(src/main/[\w./-]+\.ts)\s*$", re.MULTILINE)
# 且 :277 硬拒绝不在 MAIN 下的路径
if not target.is_relative_to(MAIN) or not target.is_file():
    raise ValueError(...)
```

**改成能写 `packages/contracts/src/ipc/rpcMap.ts`。** 具体：

- 正则放宽到仓库相对路径（`packages/contracts/...` + 原有 `src/main/...`）；
- 校验从「必须在 `MAIN` 下」改成「必须在**仓库内**且**文件存在**」；
- **不要放宽到任意路径** —— `../../etc/passwd` 这种要拒（`is_relative_to(ROOT)`）。

### 3.2 在 `app-control-smoke` 里声明这条依赖

`app-control-smoke` 有 `main.ts`（走 esbuild），也有 `.mjs` 入口吗？**先看它目录里有没有 `*.mjs`**
—— `@smoke-covers` 只在 `.mjs` 里被扫描（`smokes-for.py:274`）。

**如果没有 `.mjs`，有两种做法**，选一个并写清理由：

| 做法 | 代价 |
|---|---|
| A. 把 `@smoke-covers` 的扫描范围也扩到 `.ts` | 会影响全部 284 套的图（改动面大，风险高） |
| B. 给 `app-control-smoke` 加一个 `covers.mjs`（只有注释，不被执行） | 多一个文件，但它只承载声明 |

**我倾向 B** —— 它把「这是一条声明」和「这是可执行代码」分开，改动面最小。
**但如果你发现 `.mjs` 扫描那边还有别的前提我没想到，按你查到的来，写清为什么。**

### 3.3 崩掉那处

`:417` 的 `p.relative_to(DESKTOP)` 要处理 `p` 不在 `DESKTOP` 下的情形（用 `ROOT` 或加兜底）。
**并且要有一条断言覆盖它** —— 否则改完还是没人知道它会不会再崩。

---

## 四、运行时那条：生成物缺项要能自己喊

`channelIdempotency.ts:110` 的 `methodForChannel` 找不到就返回 `null`，注释写着
「视为无副作用，幂等守卫不介入」。

**这个默认方向是对的**（误把只读当写会让每次重试都 fsync 整库），**但它没有让「新加未生成」
这件事被任何人看见。** `modules.installVsix` 就是这样静默失效的。

**要加的是一条断言，不是改逻辑：**

```ts
// 仅测试用导出（不要在产品路径上跑）
export function catalogDrift(): { missing: string[] } { ... }
```

**放在哪里由你判断**（导出给套件、或直接在 `app-control-smoke` 里用已有的 `rpcMethods`
和 `catalogMethods` 算）。**关键是有一条断言说：「catalog 里缺任何一个 RpcMap 方法 → 红」。**

**`app-control-smoke:2793` 那条已经做了这件事**，只是它的名字是
「功能清单与 RpcMap 逐条对齐（差一条 agent 就看不见它的说明）」——
**听起来像文档检查，实际守的是运行时**。

**所以这一节最低限度是：把那条断言的名字和 hint 改成说清它同时守运行时幂等映射。**

```ts
"★ 功能清单与 RpcMap 逐条对齐（agent 的说明 + 桌面幂等映射都靠它，缺一条就静默失效）"
```

---

## 五、`app-control-smoke` 该不该进 `CRITICAL_SUITES`

**现在不在**（`run-smokes.mjs:12-29` 的 17 套里没有它）。所以 `pnpm test` 不会跑它，
F006 只跑 critical 就必然漏。

**这一条要你判断，不要默认加。** 加进去之前先量：它跑多久？如果它本来就慢，
塞进 PR 门禁会让每次 PR 都等。**把实测耗时写进回写区，让下一个决定这个的人有依据。**

---

## 六、套件（本卡的核心判据）

**先查有没有 `smokes-for-smoke/`：**

```bash
ls apps/desktop/scripts/ | grep smokes-for
```

**如果有** → 扩充它；**如果没有** → 新建，但**不要只测「我加的那条路径能查到」**。

必须有的断言（**每条先写预期红几条**）：

1. **`packages/contracts/src/ipc/rpcMap.ts` 查询必须命中 `app-control-smoke`**
   —— 这是本卡的目的。**并且断言命中的套件里含 `app-control-smoke` 这个名字**，
   不只是「命中数 > 0」。
2. **`packages/contracts/src/modules.ts` 查询不能崩**（`rc == 0`），
   且**要么给出套件，要么明确说没有** —— 不能是 traceback。
3. **路径逃逸必须被拒**：`@smoke-covers ../../etc/passwd` 之类的声明要报错，不能静默接受。
4. **负控**：一个真的没人守的 contracts 文件（自己造一个 `packages/contracts/src/_no-suite-probe.ts`
   然后删掉？**不行，那会污染仓库**）—— 换成：查一个**已知没有套件**的文件，
   断言它**不**出现在「有覆盖」的结论里。

**变异（必须做，且要写清是哪一种）：**

| 变异 | 预期 |
|---|---|
| 删掉 `app-control-smoke` 里那行 `@smoke-covers` | 第 1 条红 |
| 把 `@smoke-covers` 的 `packages/...` 路径改错一个字 | 第 1 条红（不是「静默不命中」） |
| 把 `:417` 的修复撤掉 | 第 2 条红 |
| 把 `is_relative_to(ROOT)` 换成「什么都接受」 | 第 3 条红 |

**⚠️ 这个仓库记过 9 种变异失效形态，最容易犯的是第 7 种（断言被条件包着，条件不成立就整段跳过）**
—— 输出上「跳过的断言」和「通过的断言」长得一样。**别用 `if (...)` 包住断言块**，
条件缺失时逐条显式 FAIL。

---

## 七、验收判据

1. `bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/ipc/rpcMap.ts`
   **命中 `app-control-smoke`**（贴实际输出）；
2. `... packages/contracts/src/modules.ts` **不崩**，给出可用答案；
3. 路径逃逸被拒；
4. 四条变异各自红了**预期的那些条**（把实际红数写进回写区）；
5. `app-control-smoke` 那条断言的名字说清了它同时守运行时；
6. **不改 `rpcMap.ts` / `policy.ts` / 生成物**；
7. 不跑全量（本卡只跑局部：`smokes-for-smoke` + `app-control-smoke`）。

---

## 八、回写

1. **`@contracts/` 到底为什么进了图**（第二节那个疑问的实际答案）；
2. 你选了 A 还是 B（`@smoke-covers` 扫描范围），为什么；
3. **四条变异的实际红数与预期红数**，对不上要解释；
4. `app-control-smoke` 的实测耗时（决定要不要进 critical）；
5. 有没有你觉得不对但没改的；
6. 提交 SHA。
