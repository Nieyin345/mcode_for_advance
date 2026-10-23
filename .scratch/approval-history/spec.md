# 审批历史 —— 三个设计问题的答案

> **这张 spec 的读法**：每一节都有「依据」和「怎么自己核一遍」。
> **不要相信这里的转述** —— 我在这轮里已经犯过一次「读别人的卡当成现状」（见 T102 卡）。
> 代码变了，这里就过期了。

**写于**：2026-10-24，基于 `5aa02cfc`。

---

## 问题 1：审批和任务是什么关系？

### 结论

**没关系。`taskId` 不该进表。**

### 依据

**① `links.sessionIds` 确实存在**，但它不是「审批的归属」，是「还有谁在推进这个任务」：

```ts
// packages/contracts/src/ipc/task.ts:120
export const TaskLinksSchema = z.object({
  sessionIds: z.array(z.string().min(1).max(200)).max(64).default([]),
  workflowIds: z.array(z.string().min(1).max(200)).max(64).default([]),
}).strict();
```

**② 但「审批 → 任务」的反查是可行的，靠 `origin.ref` 不是 `links`。**

**⚠️ 这一节我第一版写错了，2026-10-24 更正。** 第一版写的是
「`links.sessionIds` 是空的，所以反查不了」——**前半句对，后半句错**。
自动记账建任务时确实不写 `links`，但**发起者记在 `origin.ref` 里**：

```ts
// autoCreate.ts:174
origin: { kind: "session", ref: args.sessionId, ... }
```

`origin.ref` 就是那个会话的 id（契约 `task.ts:106` 的注释：`ref` = 会话 id / 工作流 id / 自动化 id）。

**所以反查是能做的**（sql.js 1.14.1 / SQLite 3.49.1 实测支持，还能给表达式建索引）：

```sql
SELECT * FROM tasks
 WHERE json_extract(origin, '$.kind') = 'session'
   AND json_extract(origin, '$.ref')      = :sessionId
```

**这个区别很重要**：按我第一版的说法，下一个人会以为「审批和任务永远关联不上」，
于是不写这条 join。**实际上能关联，只是列名是 `origin.ref` 不是 `links.sessionIds`。**

**③ 但结论不变：不建 `task_id`。理由是更硬的那一条 ——**

> **审批发生时，任务可能还不存在。**

`classifyTurn` 在 `turn.done` **才**建任务，而审批发生在 `turn.done` **之前**
（工具调用要等用户点了才继续，那一轮才可能产出文件）。

**所以即使某次审批最终对应了某个任务，在审批被处理的那一刻，那个 task id 还没被生成。**
存一个当时不存在的 id，只能存 `null`。

**这比「大多数审批没有任务」更根本**：后者说的是一种概率，前者说的是**时序上的不可能**。

### 表里放什么

**`session_id` 是唯一的外键**（`PendingApproval` 本来就有 `sessionId`，`resolveApproval` 返回的也是它）。

**不建 `task_id` 列。** 如果将来真的要「按任务看审批」，正确的做法是**按时间窗 + 会话**
在查询层关联，不是外键——因为两者的对应关系本来就不确定。

### 怎么自己核一遍

```bash
sed -n '120,124p' packages/contracts/src/ipc/task.ts     # links 的形状
sed -n '170,182p' apps/desktop/src/main/tasks/autoCreate.ts   # create 只传 goal/origin/dependsOn，且 origin.ref = sessionId
grep -n "links:" apps/desktop/src/main/tasks/autoCreate.ts
```

**最后一条的预期是「无命中」** —— `TaskRepo.create` 里没有 `links:`。

⚠️ 但**不要用 `grep -n "links"`**：它会命中 `autoCreate.ts:35` 那段**设计注释**
（讲「`origin` + `links` 双轨」），看起来像「有」，实际没有代码。
**这就是「按名字搜是引用数」**：注释里的名字和代码里的名字在 grep 眼里一样。

**反查可行性单独验一遍**（sql.js 的 `json_extract` 不是所有构建都有）：

```bash
node .scratch/approval-history/json-extract-probe.mjs    # 输出 PASS 才说明那条 join 成立
```

---

## 问题 2：存什么，不存什么？

### 先说一个卡上没有的事实：**出口有五个，不是一个**

卡上写「写入点只有一个：`ApprovalBridge.resolveApproval`」。**实际有五个出口**：

```bash
grep -nE "^\s+(resolve|dismiss)[A-Z][A-Za-z]*\(" apps/desktop/src/main/claude/ApprovalBridge.ts
```

| # | 方法 | 行 | 用户在做什么 | 是「决定」吗 |
|---|---|---|---|---|
| 1 | `resolveApproval` | `:90` | 对工具调用点允许/拒绝 | **是** |
| 2 | `resolveUserInput` | `:153` | 回答了模型提的问题 | **是** |
| 3 | `dismissUserInput` | `:167` | **关掉了问题卡片**（没回答） | **是**（「跳过」也是一种决定） |
| 4 | `resolvePlanApproval` | `:201` | 批准/否掉了计划 | **是** |
| 5 | `rejectPending` | `:212` | **会话被取消**，所有 pending 一起失效 | **否 —— 这是系统清理** |

**如果只守 `resolveApproval`，另外三类决定永远记不上**（这正是「提到它 ≠ 守住每个出口」）。

**第五个出口要不要记？** 我判断**要，但用不同的 `kind`**：用户会想知道
「我刚才那个操作怎么没反应了」——而「会话被取消导致审批失效」正是答案。
但它不能记成 `deny`（用户没拒绝过任何东西）。

### 表形状

```sql
CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,   -- requestId
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,      -- 'tool' | 'question' | 'plan'
  subject       TEXT NOT NULL,      -- 工具名 / 问题摘要 / 计划摘要
  decision      TEXT NOT NULL,      -- 'allow' | 'deny' | 'answered' | 'dismissed' | 'cancelled'
  always        INTEGER NOT NULL DEFAULT 0,   -- 用户勾了「始终允许」吗
  decided_at    INTEGER NOT NULL,
  detail        TEXT                        -- 见下：JSON，可空
);
CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id, decided_at);
CREATE INDEX IF NOT EXISTS idx_approvals_decided ON approvals(decided_at);
```

**为什么 `kind` 单独成列**：三类决定的语义完全不同（工具/提问/计划），
查询几乎总要按它筛。放进 JSON 就没法走索引。

**为什么 `subject` 是 `TEXT` 而不是外键**：工具名是字符串，问题/计划是自由文本。
统一成「一行能读懂是什么」的文本。

### ⚠️ `input_digest`：**不存**，理由如下

卡上要我判断「要么给它一个消费者，要么不存」。**我判断不存**，两个理由：

**① 我找不到诚实的消费者。** 一个 digest 有用的前提是「有人会拿另一份 input 来比对，
判断是不是同一个操作」。谁能做这个比对？

- `redactValue` 会打码，所以**同一份原始 input 打码两次结果相同**（它是纯函数）——
  digest 稳定，这点没问题；
- 但**没有任何场景需要「这两次审批是不是同一个操作」**。用户要问的是
  「我批了什么」，而 `tool_name` + `subject` + 时间已经回答了；
- 「防止篡改」也不成立：这里不是审计链，没有人拿 digest 去验证原文。

**② 它会让表看起来比实际严谨。** 这正是 CLAUDE.md 第十二条
「假门禁比没有门禁更坏」的同型：**一个没人读的校验字段，会让后来的人以为
「这里有完整性保证」。**

**如果将来真需要**：那时再存一份**脱敏后的摘要文本**（`redactValue` 的输出截断），
它对人可读、可搜索，比一个 hex digest 有用得多。

### 存什么「具体内容」

**不存 `input` 原文**（A 的警告，我采纳）。`redactValue` 存在本身就说明它当敏感物。

**但存一点人话上下文**，否则历史列表是一堆工具名：

- `subject`：工具名 / 问题第一句（截 200 字）/ 计划标题；
- `detail`（JSON，可空）：**只放已经脱敏的、结构化的少量字段**——
  例如工具的 `description`（审批卡上用户看到的第二行）。

**判断依据**：**用户在审批卡上看到过什么，历史里就存什么。** 用户没看到的，不存。

### 怎么自己核一遍

```bash
grep -nE "^\s+(resolve|dismiss)[A-Z][A-Za-z]*\(" apps/desktop/src/main/claude/ApprovalBridge.ts
sed -n '70,76p' apps/desktop/src/main/claude/ApprovalBridge.ts   # set 时只存 4 个字段
```

**注意**：`PendingApproval` 只存 `{resolve, reject, sessionId, toolName}`。
**`description` 在 set 时被丢弃了**（只用于 emit）。所以要存 `subject`，
**必须在 `makeApprovalHandler` 的 `set` 里多存一个字段** —— 这也是改 `ApprovalBridge.ts` 的第二个理由。

---

## 问题 3：数据量级 —— **量不出来，而且不该用推导值**

### 结论

**量不出来。** 而且**这不是「懒得量」，是当前代码里没有任何可量的痕迹。**

### 依据（实测，不是推导）

```bash
# 1. ApprovalBridge 里一行日志都没有
grep -c "log\." apps/desktop/src/main/claude/ApprovalBridge.ts     # → 0
grep -n "import.*logger" apps/desktop/src/main/claude/ApprovalBridge.ts  # → 无

# 2. 已有的 172 个日志文件里零条审批记录
grep -rl "approval\|approve" ~/.mcode/debug/*.txt | wc -l          # → 0

# 3. 套件里的次数是测试造的，不是真实使用量
```

**第 2 条尤其说明问题**：本机从 2026-10-10 起有 172 个日志文件，
**没有一条能告诉我审批发生过几次**。不是因为审批没发生，是因为**没人记**。

### 为什么不用推导值

A 给的推导（「一次改 Word ≈ 3–6 次编辑 ≈ 3–6 条」）听起来合理，但它有一个隐藏前提：
**「每次编辑都要审批」**。而实际上：

- `alwaysAllowedTools` 会让同一会话里同一工具**只问一次**（`resolveApproval:105-112`）；
- `permissionMode` 为 `acceptEdits` 时可能根本不问；
- 只读操作直接放行，不产生审批。

**所以真实条数可能比推导航低一个数量级，也可能因为长会话而高** —— **两个方向都可能，
推导给不出区间。**

### 表的形状怎么定（在没有量级的情况下）

**定成「不依赖量级也安全」的形状**：

- **两个索引**（`session_id + decided_at`、`decided_at`）—— 无论量级，这两个查询都是主路径；
- **不做分页**（列表默认 `LIMIT 200`，`approval.list` 支持 `before` 游标）；
- **不做过期清理** —— 但**留一个 `approval.prune(before: number)` 的口子**，
  等真的量出来再说。**现在就写清理策略是在猜。**

### 将来怎么量（一条具体、不改产品的路）

**下次改 `ApprovalBridge` 时顺手加一行计数**（不是为这张卡专门加）：

```ts
log.info(`approval resolved: kind=${kind} decision=${decision}`);
```

**跑几天真实使用，`grep -c "approval resolved"` 就是那个数字。**

**但如果这张卡现在就做**，写入路径本身就会产生这个数据 —— **表建好之后，
`SELECT COUNT(*) FROM approvals` 就是答案**。**所以「量不出来」不阻塞建表，
它只阻塞「要不要分页 / 清理」。**

---

## 表形状的最终判断

**建。** 理由：它是**唯一不需要先知道量级就能做对**的那部分 ——
记录本身是纯增量，查询按 `session + 时间` 有天然索引，清理/分页可以在有数据之后再定。

**但 UI 先不做。** 卡上第三节问我「UI 上要在哪显示」，我的答案：

**现在没有合适的落点。**

- 任务中心不行：大多数审批没有任务，塞进去会让面板变成「什么都有」的列表；
- 会话里需要新面板或可展开区，那是另一个交互设计。

**所以：只做写入 + 一条 `approval.list` RPC，不做 UI。** 卡上说这是「诚实的部分交付」，我同意。

---

## 一个附带发现（不在本卡范围，但影响判断）

**`origin.kind` 有 `session` 这个值，但任务中心不显示来源**（T102 卡的已知缺口）。
这是「字段建好了，消费者没接」的又一例。

**审批历史如果也没有消费者，就会是同一件事的第二次。** 所以我在上面的建议里
**没有**做 UI，但**写入必须真做** —— 因为写入是「将来有消费者时数据已经在」，
而 UI 是「现在就给用户看一个空列表」。

**这两件事的价值不同，不能一起做也不能一起不做。**
