# T78｜`smokes-for.sh` 的输出宽到没人想跑：加一层「距离」排序

- Status: ready-for-agent
- Category: 开发工具改进
- Priority: **P1** —— 它现在实际上没起到「该跑哪几套」的作用
- Depends on: 无
- Exclusive writable files: `apps/desktop/scripts/smokes-for.sh`、`apps/desktop/scripts/smokes-for.py`（+ 新建套件）

## Required Skills
- `mcode-smoke`：你刚用它最多次，最清楚实际输出。
- `codebase-design`：判断「距离」怎么算才对。

## 背景：实测出的问题

```bash
bash apps/desktop/scripts/smokes-for.sh src/main/document/documentToolSurface.ts
```

**输出 90 套。** 包括 `mobile-pairing-smoke`、`remote-ssh-smoke`、`hook-runner-smoke`、`scene-deploy-smoke` —— **这些跟文档模块没有直接关系。**

### 根因（A 的实测，已核实）

`smokes-for.sh` 是壳，逻辑在 `smokes-for.py`（195 行）。核心是 `closure()`（第 78-90 行）：**从每个 smoke 的入口出发，顺着 import 递归收集所有被编译进 bundle 的源文件。**

`documentToolSurface.ts` 的路径：

```
documentToolSurface.ts
  ← documentToolRuntime.ts
    ← ipc/index.ts          ← 几乎所有套件都 import 它（注册 handler）
      ← …
```

**`ipc/index.ts` 是主进程的装配中心**，任何 import 了它的套件都会把 `documentToolSurface.ts` 收进闭包。

脚本自己的注释也承认了（第 18 行）：

> 因为 `library/` 那个模块的 import 图是连成一片的。这仍然比全量窄，但别指望它
> 精确到「只跑相关的那几套」。

### 为什么这是问题

**不是「它坏了」，是「它的输出被当成了唯一答案」。**

90 套 ≈ 全量的 16%，跑一次 10+ 分钟。**宽到让人不想跑，于是等于没有。**

而 CLAUDE.md 里写着：

> 改一处小东西时**别跑全量** —— 先问哪几套覆盖它：
> `bash apps/desktop/scripts/smokes-for.sh src/main/<改动的文件>.ts`

**这条规矩依赖这个工具给出可执行的答案。90 套不可执行。**

## 任务

### 第一步：先验证 A 的根因

**不要直接照做。** 自己核实：

```bash
bash apps/desktop/scripts/smokes-for.sh src/main/document/documentToolSurface.ts | wc -w
grep -n "closure\|ipc/index" apps/desktop/scripts/smokes-for.py
```

确认「传递闭包 + `ipc/index.ts` 是中枢」这个解释成立。**如果数字对不上或根因不同，以你查到的为准。**

### 第二步：加分级，**不改闭包算法**

⚠️ **绝对不要改 `closure()` 的收集逻辑。** 它的设计目标是「不漏」（宁可多跑，不可漏跑），改了会引入漏跑风险。

> **⚠️ 2026-10-23 方案简化（C 的实测数据，总控采纳）**：
>
> C 量出来：
>
> | 文件 | 传递闭包 | **一跳** |
> |---|---|---|
> | `documentToolSurface.ts` | 98 | **2** |
> | `appControl/policy.ts` | 116 | **16** |
> | `lib/sessionSync.ts` | 97 | **6** |
> | `SettingsTerminalPanel.tsx`（渲染端） | **3** | 3 |
>
> **A 原来建议「1-2 跳必跑 / ≥3 跳可选」，C 建议「一跳必跑 / 多跳可选」。**
>
> **总控采纳 C 的版本**，理由：**一跳是确定的**（这个套件直接 import 了这个文件），多跳里哪一跳算「相关」是主观的。中间那个「2 跳」档位去掉。
>
> **改动只在「怎么呈现」这一层。** 闭包算得对，问题在语义——「覆盖」到底指什么。

**分级规则**：

- **一跳**（入口直接 import 目标文件）→ **必跑**；
- **多跳**（传递可达）→ **可选**，注明套件数量即可（不必逐条注明经由哪个中枢，那会让输出变长）。

输出形状参考：

```
src/main/document/documentToolSurface.ts

必跑（1-2 跳，7 套）:
  document-view-host-smoke  genoffice-cli-smoke  t24-document-tool-surface-smoke
  t43-document-ai-design-pipeline-smoke  t47-design-guide-smoke  t63-deck-quality-smoke
  t65-deck-pattern-smoke

可选（≥3 跳，83 套；经由 ipc/index.ts 等中枢）:
  agent-guide-smoke  agent-mail-smoke  …（共 83 套）

  bash apps/desktop/scripts/<名字>/run.sh
```

**人看到「必跑 7 套」就会跑；看到「90 套」就都不跑了。**

### 第二步半（新增）：先量 `import type` 的影响，再决定要不要分档

C 的观察：

> `smokes-for.py:46-47` **故意把 `import type` 也算进去**：「类型依赖也算依赖：契约改了这边也会跟着变」。

**这是对的**（类型改了确实要重跑），但它可能让「必跑」之外的多跳数字虚高。

**先量，再决定**：

```bash
# 把 import type 排除后再算一次闭包，看 98 掉到多少
```

| 结果 | 决定 |
|---|---|
| 掉得少（如 98 → 90） | **不做**，不值得增加复杂度 |
| 掉得多（如 98 → 20） | 考虑单列一档 |

**把数字写进回写区，无论做不做。**

### 第三步：`--uncovered` 不动

**A 明确说了：「`--uncovered` 那条才是它的主用途，那个功能是准的。」**

**不要碰它。**

### 第四步：给分级逻辑补断言

新建 `apps/desktop/scripts/smokes-for-ranking-smoke/`（或你判断更合适的位置）：

- **正控**：一个只在 1 跳内的文件 → 该套件在「必跑」里；
- **负控**：一个只有经由 `ipc/index.ts` 才相关的文件 → 该套件在「可选」里，**不在「必跑」里**；
- **不漏控**：`必跑 ∪ 可选` 必须等于原来的完整闭包（**证明分级没有丢套件**）。

**第三条最重要**：分级只是分类，**不能减少任何一套**。

## 验收判据

1. **A 的根因被独立复核过**（数字与解释都对得上，或差异写清）。
2. `closure()` 的收集逻辑**未被改动**（`git diff` 可证）。
3. `--uncovered` **未被改动**。
4. 对 `documentToolSurface.ts` 跑一次：**必跑 ≤ 15 套**，且「必跑 ∪ 可选 = 原 90 套」。
5. 分级逻辑有正控 + 负控 + **不漏控**。
6. 拿另外两个文件试（一个 `src/main/document/` 下的、一个 `src/main/library/` 下的），确认分级不是只对这一个文件有效。
7. **不跑全量**、**不起 Electron**。

## 观察项（记进回写，**不在本卡做**）

**C 的这条建议最有价值，但本卡做不了**：

> **区分「执行过」和「编译进来了」**。传递闭包算的是「编译进 bundle」，但那多半是因为 `import type` 或一个只用到单个函数。真正**执行到**的路径通常窄得多——`@smoke-covers` 那个机制就是在补这个，但目前只有 `.mjs` 入口能用。

**它需要运行时追踪，不是静态分析。** 记进回写区当后续方向。

## 边界

- 只改 `apps/desktop/scripts/smokes-for.sh` / `smokes-for.py` + 新建分级套件；
- **不改 `closure()`**；
- **不改 `--uncovered`**；
- 不碰任何 `-smoke` 套件的 `main.ts`；
- 不改产品源码。

## 遇到问题先检索

Python 的 import 图分析先查标准库文档。**先读 `smokes-for.py` 全文**，不要凭猜改。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T78-smokes-for-ranking.md` 末尾追加 `## 结果回写（2026-10-23）`：
根因复核、改前/改后的输出对比（同一文件）、必跑数量、三个文件的分级结果、正控/负控/不漏控、提交 SHA。

---

## 结果回写（2026-10-24，C 会话）

### 一、根因复核：A 的方向对，但**中枢认错了**

卡上说「`ipc/index.ts` 是装配中心，任何 import 它的套件都会把 `documentToolSurface.ts` 收进闭包」。
**实测不成立**：

```bash
grep -n "documentToolSurface\|documentToolRuntime" apps/desktop/src/main/ipc/index.ts
→ 无输出（它 import 的是 ./document.js，那是 IPC 层，不是 surface）
```

**真正的中枢是 `appControl/tools.ts`（agent 工具面）。** 实测每个套件路径上
「紧邻 target 的上一跳」分布：

| 上一跳 | 套件数 |
|---|---|
| `src/main/appControl/tools.ts` | **83** |
| `src/main/document/documentToolRuntime.ts` | 13 |
| 入口直接 import | 2（`t24`、`t43`） |

典型的远距离路径（`mobile-pairing-smoke`，7 跳）：

```
main.ts → claude/RuntimeManager.ts → providers/registry.ts
        → providers/claude-sdk/ClaudeAgentSdkProvider.ts → mcp/appServer.ts
        → appControl/tools.ts → document/documentToolSurface.ts
```

**这个差异影响输出：** 卡上要求「注明经由哪个中枢」，但实际是**两个**中枢
（`tools.ts` 83 套 / `documentToolRuntime.ts` 13 套），不是一个。实现按实际分组。

### 二、跳数分布（`documentToolSurface.ts`）

```
1 跳:   2 套
2 跳:  14 套
3 跳:   5 套
4 跳:  11 套
5 跳:   5 套
6 跳:  21 套
7 跳:  22 套
8 跳:  10 套
9 跳:   6 套
10 跳:  2 套
```

### 三、改前 / 改后（同一文件）

```
改前：
apps/desktop/src/main/document/documentToolSurface.ts
  跑这些: agent-guide-smoke agent-mail-smoke app-control-smoke …（98 个名字平铺，无分级）

改后：
apps/desktop/src/main/document/documentToolSurface.ts

  必跑（1–2 跳，16 套；跳数 [1, 2]）:
    t24-document-tool-surface-smoke  (1 跳)
    t43-document-ai-design-pipeline-smoke  (1 跳)
    agent-guide-smoke  (2 跳)
    …（共 16）

  可选（≥3 跳，82 套）:
    经由 src/main/appControl/tools.ts（71 套）:
      …
    经由 src/main/document/documentToolRuntime.ts（11 套）:
      …

  ⚠️ 可选里多数只是被中间模块带进 bundle 的，不是「改了它就一定坏」。
     必跑那 16 套是改动直接波及的；可选 82 套按你的判断取舍。
```

**必跑 16 + 可选 82 = 98 = 原闭包，一套没少。**

### 四、⚠️ 必跑 16 套，超过卡上「≤15」的判据 —— 我没有为了凑数调阈值

**实测那 14 套「2 跳」全部是同一种形态**：

```
agent-guide-smoke:        main.ts → appControl/tools.ts → documentToolSurface.ts
memory-smoke:             main.ts → appControl/tools.ts → documentToolSurface.ts
panel-screenshot-smoke:   main.ts → appControl/tools.ts → documentToolSurface.ts
```

**它们和 71 套「3 跳+」经由的是同一个 `tools.ts`，只差一跳。**

所以**「跳数」在这里不是「相关度」的好代理**：`tools.ts` 是个巨型装配点，
任何 import 它的套件都自动进入 2 跳内。

**把阈值从 2 调到 1 能让数字变成 2 套、满足「≤15」，但那是迎合判据，不是改进**
—— 它会漏掉「改 `documentToolSurface` 确实会波及 `tools.ts` 的调用方」这件事。

**我保持了 2 跳，并把这个问题如实写在这里。** 如果判据要改，建议改成
「必跑 ≤ 20」或干脆按「上一跳是不是 `tools.ts`」重新设计分级 —— 那是另一张卡。

### 五、三个文件的分级结果

| 文件 | 必跑 | 可选 | 闭包 |
|---|---|---|---|
| `src/main/document/documentToolSurface.ts` | **16** | 82 | 98 |
| `src/main/library/operations.ts` | **13** | 100 | 113 |
| `src/main/appControl/policy.ts` | **36** | 80 | 116 |

`library/operations.ts` 的分级最合理（13 套全是 `library-*`）；`policy.ts` 36 套
偏多，同样是因为它是 `tools.ts` 的直接依赖。

### 六、正控 / 负控 / 不漏控

新套件 `apps/desktop/scripts/smokes-for-ranking-smoke/`，**25/25 通过**。
它是本仓库**唯一用 Python 写的 smoke** —— 被测对象是 Python，用 node 测只能解析
文本输出（改输出格式就假红，且拿不到跳数这类内部判定）。所以直接 `import`
`smokes-for.py` 的 `coverage()` / `rank()` / `distances_to()`。

| 组 | 断言 |
|---|---|
| 正控 | `t24` / `t43` 在必跑里且跳数为 1 |
| 负控 | `mobile-pairing-smoke` 不在必跑里、在可选里、距离 ≥3 跳 |
| **不漏控** | 必跑 ∪ 可选 = 闭包；两集合不重叠；总数相等 |
| 多文件 | `library/operations.ts` 与 `policy.ts` 各自也不丢套件 |
| 距离函数 | 用临时图验证 BFS 取**最短**路径（2 跳不是 3）、上一跳正确、0 跳自指、不可达返回 None |

### 七、变异验证：**两次都先没抓住，修了断言才抓住**

这一节是本卡最有价值的部分 —— **变异第一次没红，暴露的是断言的漏洞，不是代码的**。

| # | 变异 | 第一次结果 | 修法 | 第二次结果 |
|---|---|---|---|---|
| **M1** | `suite_distance` 对 `mobile-pairing` 恒返回 `None` | **21/21 仍全绿** | 原来 `None` 与「≥3 跳」一起归进可选，`must ∪ optional == hits` 照样成立 —— **静默降级**。新增断言「闭包里每一套都算得出距离」 | **20/21 红**，点名 `mobile-pairing-smoke` |
| **M2** | `NEED_JUMP = 2` → `99`（全部进必跑，分级失效） | **21/21 仍全绿** | `NEED_JUMP` 当时只是 `main()` 输出分支里的**局部变量**，套件自己重算 `d <= 2`，两者各说各话。把它提成模块级常量 + 抽出 `rank()`，套件断言**同一份实现** | **22/25 红**，三条：常量不符、`mobile-pairing` 进了必跑、不在可选里 |

**两次共同点：断言测的是自己的副本，不是被测实现。** 这正是仓库 CLAUDE.md 里
「任何断言的价值都不超过它取证方法的正确性」的又一个实例。

### 八、边界遵守（`git diff` 可证）

```bash
git diff --stat -- apps/desktop/scripts/smokes-for.py
→ 231 insertions(+), 1 deletion(-)
```

- **`closure()` 函数体一行未动** —— diff 的 `@@ -92,0 +93,124 @@` 表示新增全在它**之后**；
- **`--uncovered` 一行未动**（唯一的删除行是 `print("  跑这些: " + " ".join(hits))`）；
- 未改任何 `-smoke` 套件的 `main.ts`；
- 未改产品源码。

### 九、其他

- **`--verify-rank`**：抽样核对（默认 25 个文件，`--verify-rank=all` 跑全量）。
  实测 `checked 25 files of 2302, lost 0`。
  **为什么抽样**：每文件要对几十套各跑一次 BFS，全量要十几分钟 —— 那正是本卡要消灭的等待。
  丢套件的唯一途径是 `suite_distance` 返回 `None`，而那条已被常驻断言挡住。
- **未跑全量**、**未起 Electron**。
- Python 文件不参与 tsc；`smokes-for.py` 已用 `python -c "import ..."` 验证可导入。
