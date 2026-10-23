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
