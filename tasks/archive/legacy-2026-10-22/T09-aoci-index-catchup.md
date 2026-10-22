# T09｜AOCI 索引补录 —— **已取消（2026-10-20 用户决定不再使用 AOCI）**

> **不要执行本任务。** 保留文件只为记录历史与已发生的阻塞事实。
>
> 用户决定：Mcode 不再维护 AOCI 索引。索引相关的工具调用（`aoci_maintain` /
> `aoci_update_entry` / `aoci_overview`）在新的派活里**一律不再出现**。
> 如果某个任务文件里还提到 AOCI，以本说明为准。
>
> 下面原文保留，不再具有执行意义。

---

# 原任务：AOCI 索引补录（819 条积压）

| 项目 | 值 |
|---|---|
| 编号 | T09 |
| 类型 | 索引维护（AOCI code volume） |
| 优先级 | 中（不做会拖慢所有后续开发，但不阻塞功能） |
| 建议并发 | **单独开一个对话长期跑**，可与其它任务并行 |
| 预计规模 | 大（819 条，约 17 个批次） |

---

## 为什么做这个任务

`aoci_maintain` 目前返回 `authoring_required`，积压：

- `missing` 400 —— 磁盘上有、索引里没有（主要是这几个月新增的 smoke 套件）
- `stale` 469 —— 文件改过、索引条目里的描述可能已过期
- `unbaselined` 400 —— 同上，未进入基线

索引旧了会直接拖慢开发：所有依赖 `aoci_overview` / `aoci_search` 快速定位的
对话都会读到过时描述，甚至找不到新文件。

---

## 开工前第 0 步：确认 AOCI 工具真的可用（否则立刻停）

**这一步不通过，后面全部做不了** —— AOCI 的写入只能走 MCP 工具，
CLI（`aoci.exe`）只有 scope 管理，**没有任何 authoring 命令**。
所以「工具不在」时不要尝试手改 `aoci.code.txt` / `.aoci/`，那会破坏索引。

检查：能不能调用 `aoci_maintain` 这个工具？

- **能** → 继续下面。
- **不能** → 立刻在回写区写「阻塞：本会话未暴露 AOCI MCP 工具」并停止。
  同时把下面这两条信息一并写进去，方便宿主排查：
  - `.mcp.json` 里配置的是 `D:/destop/work_space/work_for_reseach/tools/aoci/aoci.exe`
    （已确认该文件存在），参数 `--repo <仓库根> mcp`；
  - 本会话可用的工具里有没有名字含 `aoci` 的项。

  **不要**用 Bash 直接跑 `aoci.exe` 的 scope 命令试图绕过 —— 那改的是 scope 策略
  不是索引条目，且会与 MCP 侧状态打架。

## 开工前必读

1. `audit-ledgers/README.md`（规则，但本任务不改台账）
2. **AOCI 的合同文档**：先调 `aoci_rules`（如果可用），再调 `aoci_header`
   拿到当前的 Meta 与标签字典。**每个会话都要重新拿一次**，不要沿用旧对话里的。
3. 本文件的「作者化规范」一节（下面）。

> 文件名提示：本任务是 `tasks/T09-aoci-index-catchup.md`。若指令里写的是
> `tasks/T09.md`，以本文件为准 —— 先 `ls tasks/ | grep T09` 找到实际文件再读。

---

## 执行方式（严格照做）

### 循环

```
1. 调 aoci_maintain（无参数）
2. 如果 result == "authoring_required"：
   a. 读出返回的 candidates（每次最多 50 条）
   b. 逐条读对应源码（只需读文件头注释 + 关键导出，大文件不用逐行）
   c. 按下面的规范为每条写一行 entry
   d. 一次性调 aoci_update_entry，提交**整批**（不能只交一部分）
   e. 看返回的 remaining；非零 → 回到第 1 步
3. 如果 result == "aligned" → 完成
4. 如果返回 repair_required → 按 findings 里的 `safe_repair_action` 修正后
   重提**同一批**，不要重新 maintain
```

### 关键约束（来自 AOCI 合同，违反会被拒）

- `code_batch_id` 必须等于 `code_plan.batch_id`，也等于每个 candidate 的 `batch_id`。
  **不要**把 `authoring_batch.batch_identity` 填进去。
- 每个 candidate 的 `candidate_id` 与 `source_sha256` 必须原样带上。
- **整批提交**，不能挑选子集。
- 不要自己生成 S 字段里的"约束"——没有合格约束就写 `S:-`。

---

## 作者化规范（Tag 与 F/R/A/S）

### Tag 格式（compact）

`A+B+C+[D]+E`，例如 `T5B8S`。

- **A（层）**：测试文件用 `T`；生产源码按实际层（`C` 共享基础 / `E` 入口 / `A` 应用编排 /
  `D` 领域 / `K` 算法 / `M` 中间件 / `P` 持久化 / `I` 集成 / `R` 运行基础 / `L` 库 /
  `F` 配置 / `O` 运维 / `S` 文档 / `X` 工具）。
- **B（模块）**：按被测功能域，不要按"它是个测试"就一律写 `Q`。
  只有测试基础设施本身才用 `Q`。
- **C（重要性）**：1–9。核心安全/数据一致性 = 8–9；普通 UI = 5–6；纯脚本 = 3–4。
- **E（规模）**：L>400 行 / M 200–400 / S 100–200 / T<100。

### F / R / A / S 的写法

| 字段 | 要求 | 例子 |
|---|---|---|
| **F**（是什么） | ≤160 字，一句话说清这个文件**做什么**，不是"这是一个测试" | `F:验证 agent 清理钩子在不可序列化异常下仍执行后续 disposer` |
| **R**（强关系） | 精确 `code:path` 身份，逗号分隔；无强关系写 `-` | `R:code:apps/desktop/src/main/mcp/agentSessionCleanup.ts` |
| **A**（行为要点） | ≤400 字，不超过 6 项，写这个文件**怎么做**、导出什么 | `A:registerAgentSessionDisposer;disposeAllAgentResources` |
| **S**（不可推断的约束） | **只有**无法从 F/R/A 推导、且不写会让后来的修改者踩坑的事实 | `S:清理函数自身抛错必须被吞掉，否则会中断后续 disposer` |

**S 是最容易被写坏的字段**。判据：

- ✅ 写：`S:导出只有 exportBytes() 一个出口，其余路径会重置 pragma 导致外键静默失效`
- ❌ 不写：`S:使用 TypeScript 编写`（可从扩展名推出）
- ❌ 不写：`S:这是一个测试文件`（F 已经说了）
- 没有合格约束 → **保持 `S:-`**。

### 测试文件的 R 字段

指向**被它验证的生产源码**，不是指向别的测试。一个测试验多个文件就都列上
（最多 8 项）。

---

## 边界（不要碰）

- **只读**所有源码。本任务不修改任何被索引的文件。
- **不要**改 `aoci.txt` / `aoci.code.txt` / `aoci.meta.txt` / `.aoci/`（那是工具自己的）。
- **不要**改 `.gitignore`、managed scope 规则。
- **不要**为了让条目"更完整"而去读整个大文件 —— 读文件头与导出处即可。

---

## 验收判据

1. `aoci_maintain` 最终返回 `aligned: true`（`remaining: 0`）。
2. 抽样 10 条新条目：F 能说清用途、R 指向真实存在的生产文件、S 不是 `S:-` 的
   条目里确实有不可推断的事实（而不是从代码一眼可见的东西）。
3. **不要**出现"同一批里 entries 数量少于 candidates 数量"。
4. 提交整批时若被拒，按 `safe_repair_action` 修正后重提，**不要**跳过该条。

---

## 你要在回写区回答的问题

- 一共跑了几轮 `aoci_maintain`？最后 remaining 是多少？
- 有多少条你写了 `S:-`（没有合格约束）？大概比例。
- 有没有遇到 entry 被拒？原因是什么？
- 索引补完之后，`aoci_overview` 的 `whole_index_tokens` 是多少？（当前 392693，
  预算上限 400000 —— 如果补完会超，**立刻停下**并在回写区报警。）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。每完成一轮写一行。 -->

### 2026-10-20｜任务取消（用户决定）

用户决定：**Mcode 不再使用 AOCI**，索引维护停止。本任务作废，不再派发。

取消前已发生的两件事，记录备查：

1. **执行对话在启动即阻塞**（提交 `71147781` / `5f99d2a9`，仅改本任务文件：
   指令里的 `tasks/T09.md` 不存在，实际是本文件；该会话也未暴露 AOCI MCP 工具）。
2. **总控自行尝试补录一批，失败且未写入**：`aoci_update_entry` 提交 50 条，
   `applied: 0`，`remaining: 50`，`formal_writes_started: false`。
   46 条 `fras_tag_invalid` —— 我写的 tag（如 `T6G8T`、`T5U7S`）不符合它的
   `ABCDE_compact_or_dotted` 语法。**没有任何字节写入索引**，因此无需回滚。

此后 `aoci_maintain` / `aoci_update_entry` / `aoci_overview` 等调用一律不再出现。
若后续某个任务文件仍提到 AOCI，以本说明为准。

### 2026-10-20｜执行阻塞（本轮未做 AOCI 索引修改）

- **阻塞原因**：用户指定的入口 `tasks/T09.md` 不存在（`ENOENT`）；`tasks/README.md` 仅列出 `tasks/T09-aoci-index-catchup.md` 为 T09 实际文件。依 `tasks/_PROMPT_TEMPLATE.md` 的「要求与仓库现状不符时停止、不猜」约束，停止执行索引写入。
- **第二阻塞**：当前远程连接暴露的工具中没有 `aoci_rules`、`aoci_header`、`aoci_maintain`、`aoci_update_entry`、`aoci_overview` 接口。`where aoci` 返回退出码 1；`.mcp.json` 中虽然指定了 AOCI MCP 可执行文件，但它没有作为本会话的可调用 MCP 工具暴露。为避免绕过 AOCI 当前运行合同和原子批次校验，未直接编辑任何 AOCI 管理文件。
- **本轮命令与摘要**：`git status --short`：` M .aoci/baseline.json`（开工前即已存在的其他改动，未触碰）；`git ls-files tasks/T09-aoci-index-catchup.md`：文件受 Git 追踪；`where aoci`：FAIL（找不到命令）。未建立运行日志文件；AOCI 命令 PASS 0 / FAIL 0 / 未调用 5 种接口。
- **维护计数**：`aoci_maintain` 0 轮；最终 `remaining` 未知（文中 819 是历史记录，非本轮测量）；新条目 0，`S:-` 0（比例不适用）；`aoci_update_entry` 拒绝数 0（未提交）；`whole_index_tokens` 未能实测（文中 392693 为旧参考值）。
- **验收结果**：① `aligned:true` / `remaining:0` **未达成**；② 10 条抽样 **未执行**；③ 未提交任何批次（无法验证整批原子性）；④ `safe_repair_action` **未执行**（无接口/响应）。未新增测试断言，变异验证及 `cmp` 不适用。
- **改动及风险**：仅在本任务文件结果回写区记录阻塞，不修改源码、台账及 `aoci.txt`、`aoci.code.txt`、`aoci.meta.txt`、`.aoci/` 等受工具管理文件。索引积压未消除；既有 `.aoci/baseline.json` 工作树改动保留。提交 SHA 将在下一条回写中记录。
- **本轮阻塞记录提交 SHA**：`71147781a1a23c8244e4d48e6b0019ac40e8b1cb`（仅任务日志提交，并非 AOCI 索引修复提交）。
