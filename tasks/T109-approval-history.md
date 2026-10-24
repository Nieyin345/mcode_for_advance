# T109｜审批没有历史：`pendingApprovals` 是一个 Map，进程退出即丢

- Status: ready-for-agent
- Category: **P0 产品主线（UI 工作台的「审批」这一项半可见）**
- Priority: **P0 —— 路线图 §2 要求「统一会话、项目、文件、Git/Diff、终端、任务、审批、Office、工作流的可见状态和操作」，九项里只有「审批」看不到历史**
- Depends on: T99（`tasks` 表）、T104（A 的盘点，第 1 名缺口）、A 的 `ApprovalBridge` 调查

## Required Skills
- `mcode-smoke`：表 schema + 写入路径回归。
- `codebase-design`：判断审批记录该挂在哪个域。

## 背景：A 的实测（T104 回写 + 本轮调查）

**`ApprovalBridge.ts` 的完整生命周期**：

| 阶段 | 行 | 做什么 |
|---|---|---|
| 进 Map | `:48` | `private pendingApprovals = new Map<string, PendingApproval>()` |
| set | `:72` | `set(req.requestId, { resolve, reject, sessionId, toolName })` —— **只存最小身份** |
| delete（成功） | `:91` / `:99` | 拿到 `resolve` 后 `delete(requestId)` |
| delete（批量） | `:215-218` | 遍历后 `delete` —— **没有 await、没有持久化** |

**全仓 `grep "CREATE TABLE.*approval"` → 零命中。**

**后果**：

- 处理完就从列表消失；
- 进程退出即丢；
- **用户看不到「上次那个操作我批了没」「这轮一共批了几次」**；
- **路线图 §5 要求任务中心「追踪状态、失败、审批、产物与证据」—— 四项里只有「审批」追踪不了。**

## 这不是新做一张表那么简单 —— 三个设计问题必须先答

### 问题 1：审批和任务是什么关系？

**A 的实测**：

- 一次审批发生在**会话**里（`PendingApproval` 存的是 `sessionId`）；
- 任务与会话是 `links.sessionIds` 的**多对多**；
- **一次审批不等于一次任务** —— 一个会话里可能有 5 次审批，但只对应 1 个任务，**或 0 个任务**（普通对话里的审批没有任务）。

**所以外键主要指向 `sessionId`，`taskId` 只能作可空外键。**

**⚠️ 但这条要你验证**：`task.links.sessionIds` 真的存在吗？还是只有 `origin.ref`？

### 问题 2：存什么，不存什么？

**A 的警告（我认可）**：

> **不要存 `input` 原文** —— `gateAppAction` 传进来的 input 会被 `redactValue` 打码，说明它本来就当敏感物对待。

**建议形状（A 提的，待你论证）**：

```
approvals:  id (= requestId), session_id, tool_name,
            decision ('allow'|'deny'), reason?, decided_at,
            task_id NULL,            -- 可空
            input_digest             -- 不存 input 原文
```

**但有一件事 A 没说清**：**`input_digest` 用来干什么？** 如果没有人会去比对它，**那它只是「看起来严谨」的字段**（`CLAUDE.md` 第十二条：假门禁比没有门禁更坏）。

**你判断：要么给它一个消费者，要么不存。**

### 问题 3：数据量级 —— 不许估

**A 明确说它没法诚实作答**：

> 套件里 `pendingApprovals` 只出现在 stub；运行时日志不记审批条数；真实会话的用户数据我不该读。

**所以 A 给的是推导，不是实测**（一次「改一份 Word 报告」≈ 3–6 次编辑 ≈ 3–6 条）。

**要求**：**这个数字决定表的形状（要不要索引、要不要分页、要不要过期清理）**。**先量。**

**量法（不读用户数据）**：

1. 在 `resolveApproval` 里加一行**计数**（`log.info` 或内存计数器），跑一轮真实 U1，看数字；
2. **或者**在现有套件里跑一个「多步文档任务」，数 `gateAppAction` 被调几次。

**如果量不出来 → 报告，别用推导值写进设计。**

## 任务

### 一、先答上面三个问题，再动手

**产出**：`.scratch/approval-history/spec.md`，三个问题的答案 + 你选的表形状。

**⚠️ 这一步不写代码。** 因为表一旦建了，改 schema 要迁移。

### 二、建表 + 写入路径

**按答完的形状建**。要点：

1. **独立的 `APPROVALS_CREATE_SQL`**，放 `store/approvalSchema.ts`（**照 `taskSchema.ts` 的形状**）；
2. **不改 `TASKS_CREATE_SQL`**（那是 C 的边界）；
3. **写入点只有一个**：`ApprovalBridge.resolveApproval`（`:90`）—— **「用户点的」和「AI 调的」都走它**（硬规矩 2）。

**⚠️ 写入必须不影响审批本身**：**如果写库失败，审批必须照常完成。** 审批是用户的动作，历史记录是附属品 —— **不能因为记不下来就不让用户批。**

**这条要有断言**：写库抛错时 `resolveApproval` 仍然返回 `sessionId`。

### 三、读取路径

**最少一条**：`approval.list`（按 sessionId 或 taskId 查）。

**但先查**：**UI 上要在哪显示？**

- 如果只在任务中心（E 的 `TaskCenterPanel.tsx`），**那需要 `taskId` 非空**，而大多数审批没有任务；
- 如果在会话里，**那需要一个新的面板或一个可展开的区域**。

**你判断。如果判断「现在没有合适的落点」，那就只做写入 + 一条查询 RPC，不做 UI** —— 那是诚实的部分交付。

### 四、`webApi.ts`

**如果加 RPC，必须补 `webApi.ts`**（手机端是独立组件树，漏一项整棵卸载）。

**任务中心那四项是 `webUnsupported` —— 审批历史应该也是**，除非你论证手机端能显示。

## 验收判据

1. **三个设计问题都有答案**（不是「待定」）。
2. **数据量级有实测或明确说「量不出来」**。
3. **表建好，写入路径唯一**（`resolveApproval`）。
4. **写库失败不影响审批**（有断言）。
5. **不存 `input` 原文**（有断言）。
6. **`input_digest` 要么有消费者，要么不存**。
7. 正控 + 负控 + 变异（至少：删掉写入调用 → 断言红）。
8. 不跑全量、不起 Electron。

## 边界

- `apps/desktop/src/main/claude/ApprovalBridge.ts`
- `apps/desktop/src/main/store/approvalSchema.ts`（新建）
- `apps/desktop/src/main/store/db.ts`（**只加一行 import + 一行建表**，`db.ts` 有别人在改）
- `packages/contracts/src/ipc/`（新 RPC，如果需要）
- `apps/desktop/src/renderer/lib/webApi.ts`
- 新建套件 `apps/desktop/scripts/approval-history-smoke/`

**不碰**：`store/repositories/task.ts`（C）、`store/taskSchema.ts`（C）、`documentToolRuntime.ts`（F）、`deckPatternCheck.ts`（F）、`policy.ts`（A）。

## 遇到问题先检索

```bash
grep -n "pendingApprovals" apps/desktop/src/main/claude/ApprovalBridge.ts
grep -rn "CREATE TABLE" apps/desktop/src/main/store/db.ts
sed -n '1,60p' apps/desktop/src/main/store/taskSchema.ts      # 照它的形状
grep -n "links\|sessionIds" apps/desktop/src/main/store/taskSchema.ts
```

**`tasks/T104-ui-workbench-closed-loop.md` 的第 1 名缺口那一节先读一遍** —— A 已经把这个问题的边界划好了。

## 回写

`tasks/T109-approval-history.md` 末尾追加 `## 结果回写（2026-10-24）`：
三个问题的答案、数据量级、表形状、写入/读取路径、正负控与变异、提交 SHA。

## 结果回写（2026-10-24，E 会话）

### 〇、先说我推翻了卡上哪几条

| 卡上写的 | 实际做的 | 依据 |
|---|---|---|
| 「外键主要指向 `sessionId`，`taskId` 只能作可空外键」 | **不建 `task_id` 列** | 审批发生在 `turn.done` **之前**，而任务在 `turn.done` **才**建 —— 存一个当时还不存在的 id 只能存 `null`。见 spec 问题 1 |
| 「写入点只有一个：`resolveApproval`」 | **五个出口全接** | `ApprovalBridge` 里有 `resolveApproval` / `resolveUserInput` / `dismissUserInput` / `resolvePlanApproval` / `rejectPending` |
| 「`input_digest` —— 你判断」 | **不存** | 找不到诚实的消费者；一个没人读的校验字段会让后来的人以为这里有完整性保证 |
| （卡上没提） | **`PendingApproval` 多存一个 `description`** | 结算时拿不到「这次批的是什么」。这是第二个改动点，我 spec 里发现的 |

### 一、表

`apps/desktop/src/main/store/approvalSchema.ts`（新建）：

```sql
CREATE TABLE IF NOT EXISTS approvals (
  id          TEXT PRIMARY KEY,   -- = requestId
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,      -- 'tool' | 'question' | 'plan'
  subject     TEXT NOT NULL,      -- 工具名 / 问题第一句 / 计划第一行（≤240 字，超长截断）
  decision    TEXT NOT NULL,      -- 七种，见下
  always      INTEGER NOT NULL DEFAULT 0,
  decided_at  INTEGER NOT NULL,
  detail      TEXT                -- 少量结构化补充，可空
);
CREATE INDEX idx_approvals_session ON approvals(session_id, decided_at DESC);
CREATE INDEX idx_approvals_decided ON approvals(decided_at DESC);
```

**没有 `input` 列、没有 `digest` 列、没有 `task_id` 列** —— 三条都有断言守（查 `PRAGMA table_info`）。

`db.ts` 只加了一行 import + 一行建表。

### 二、五个出口

| # | 出口 | `kind` | `decision` | 断言 |
|---|---|---|---|---|
| 1 | `resolveApproval` | `tool` | `allow` / `deny` | ✅ |
| 2 | `resolveUserInput` | `question` | `answered` | ✅ |
| 3 | `dismissUserInput` | `question` | **`dismissed`** | ✅ 专门一条「不是 answered」 |
| 4 | `resolvePlanApproval` | `plan` | `approved` / `rejected` | ✅ |
| 5 | `rejectPending`（三个循环） | 三种都有 | **`cancelled`** | ✅ 专门一条「不是 deny」 |

**`cancelled ≠ deny` 的理由**：用户没有拒绝过任何东西，是会话被取消了。
混成 `deny` 会让「我拒绝过几次」这个统计是假的。

**写入统一走一个私有方法 `recordApproval`**（五个调用点各写一个 try/catch 迟早漏一个）。

### 三、三条硬要求

**① 写库失败不影响审批** —— `recordApproval` 整个包在 try/catch 里，失败 `log.warn` 带 requestId。
断言：把 `approvals` 表临时改名（INSERT 必然失败），`resolveApproval` **仍返回 `sessionId`**。

**② 不存 `input` 原文** —— 表里根本没有那一列。断言查 `PRAGMA table_info`。

**③ 不存 `input_digest`** —— 同上。断言查列名里没有 `digest`。

### 四、读取

`approval.list`（`sessionId` **必填**）→ `listApprovals()`。
有 `limit`（1–500，默认 200）和 `before` 游标。
`webApi.ts` 补了 `approval.list = webUnsupported`（手机端没有那条桥）。

**UI：不做**（卡上定的）。任务详情视图（T111）是它将来的落点。

### 五、验证

| 套件 | 结果 |
|---|---|
| `approval-history-smoke`（新） | **32/32** |
| `task-first-class-smoke` | 32/32 不回归 |
| `t100-task-center-smoke` | 96/96 不回归 |
| `ipc-parity-smoke` | 13/13（新通道没破坏守卫） |
| `ipc-wiring-smoke` | 45/45 |
| 双包 typecheck | **0 error** |

### 六、变异（两条，都是卡上要的）

| # | 变异 | 结果 |
|---|---|---|
| **1** | 删掉出口 3（`dismissUserInput`）的写入调用 | **精确红**：`★ 出口 3 写了一条 — 0` + `★ 记成 dismissed 不是 answered` |
| **2** | `recordApproval` 的 `catch` 改成 `throw` | **精确红两条**：`★ 不抛异常 — "no such table: approvals"` + `★ 仍返回 sessionId — null` |

**变异 2 第一次做的时候整个进程崩了** —— `resolveApproval` 抛出后套件在断言执行前退出，
**没有那条断言的报告**。这是 CLAUDE.md 第八条第 3 类（运行失败 ≠ 断言红）。
所以我把 `resolveApproval` 的调用包进 try，让崩溃变成一条**显式断言**，然后再做变异 ——
这样它红的形态就对了。

### 七、一个套件自身的 bug（已修）

第 ③ 节第一版用 `DROP TABLE approvals` 制造「写库失败」，**连带毁掉了 ② 节写的数据**，
导致 ⑤ 节「按 sessionId 查到 s1 那条」变成 0（假红）。

改成 **`ALTER TABLE ... RENAME`**（表不见了所以 INSERT 必然失败，但**行数据一条不少**），
验完改回来，并加了一条对照断言「② 节写的数据仍在」。

### 八、命名冲突（记录）

我第一版把落库的枚举叫 `ApprovalDecision`，与 `packages/contracts/src/session.ts:246`
已有的同名接口冲突（那个是「用户对审批卡怎么答的（IPC 层）」）。
改成 **`ApprovalOutcome`**，并在契约文件里写明了这个区分。

### 九、未做

- **UI 没做**（卡上定的）。审批历史目前有一个 IPC 读取入口但**没有任何界面消费者** ——
  这是刻意的：任务详情视图（T111）是将来加那一段的地方。
- **`repositories/approval.ts` 没拆** —— 卡边界只到 `approvalSchema.ts`，所以读写函数
  和建表 SQL 放在同一个文件。文件头写明了「如果将来长出更多查询，应该拆出去」。
- **没有过期清理** —— 量级实测不出来（`ApprovalBridge` 零日志、172 个日志文件零条记录），
  所以不写清理策略。表形状定成不依赖量级也安全（两个索引 + LIMIT 200 + before 游标）。
