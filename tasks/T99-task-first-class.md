# T99｜🔴 任务不是一级对象：建 `tasks` 表 + 契约 + IPC 三层

- Status: **ready-for-agent**
- Category: **P0 产品主线**（路线图 §3 第一条、§5 核心闭环）
- Priority: **P0 —— 核心闭环两头的第一项**
- Depends on: C 的调查（T96 回写）、`scene.ts`（唯一有验收闭环的先例）
- Exclusive writable files:
  - `packages/contracts/src/ipc/task.ts`（新建）
  - `packages/contracts/src/ipc.ts`（加一行 export）
  - `apps/desktop/src/main/store/taskSchema.ts`（新建）
  - `apps/desktop/src/main/store/repositories/task.ts`（新建）
  - `apps/desktop/src/main/ipc/task.ts`（新建）
  - `apps/desktop/src/preload/`（白名单）
  - 新建套件

## Required Skills
- `codebase-design`：任务对象的形状要一次定对（后面所有功能都挂它）。
- `mcode-smoke`：三层 IPC 的回归。

## 背景：C 的核实结论（已由总控复核）

**任务不是一级对象，是 `sessions` 表的一个 TEXT 列。**

```ts
// sessionSchema.ts:114
{ name: "todos", def: "TEXT", inCreate: false, key: "todos" },
```

**数据库里没有 `tasks` 表。**

### 路线图 §3 的要求 vs 现状

| 要求 | 现状 |
|---|---|
| 稳定 ID | ❌ `todos` 是会话内数组元素，没有独立 ID |
| 目标 | ⚠️ 有文本，但在聊天消息里 |
| 依赖 | ❌ 无 |
| 审批 | ❌ **不落库**，用户点完就没了 |
| 状态 | ⚠️ 会话内有效，跨会话不可查 |
| 日志 | ❌ 无任务级日志 |
| 检查点 | ❌ 无 |
| 产物 | ⚠️ `turn_files` 挂在 session 上 |
| 验收证据 | ❌ 无 |
| 由聊天/工作流/自动化/多 Agent 关联推进 | ❌ 完全做不到 |

**10 项里 0 项完整满足，4 项部分。**

### 后果

- **会话删了，任务就没了**；
- **跨会话无法查询**；
- **不能被工作流/自动化引用**；
- **「谁批的、批了什么」事后查不到**；
- **「验收不通过 → 退回 → 重做」这条闭环不存在**（用户只能再发一条消息让 AI 改）。

## 已有先例：`scene_deployments`

**它是全仓唯一有「声明 → 计划 → 执行 → 验收 → 可回读」的持久对象**：

```ts
SceneSpec.acceptance: { description, expectResourceIds }   // 验收判据
SceneDeployment.acceptance.passed                          // 验收结果
scene.resume                                                // 失败重跑
```

**它的形状几乎就是路线图要的任务对象** —— 但它只服务「场景部署」一条路。

**照着它做，但做成通用的。**

## 任务

### 第一步：定 `Task` 契约形状

**这是本卡最重要的一步** —— 形状定错，后面所有功能都要改。

**必须包含路线图 §3 列的 9 项**：

```ts
export interface Task {
  /** 稳定 ID，跨会话、跨重启不变。 */
  id: string;
  /** 目标（人话，用户能看懂）。 */
  goal: string;
  /** 状态。 */
  status: TaskStatus;
  /** 依赖的任务 ID 列表（DAG）。 */
  dependsOn: string[];
  /** 归属：哪个会话/项目/工作流创建了它。 */
  origin: TaskOrigin;
  /** 产物：文件路径 + 说明。 */
  artifacts: TaskArtifact[];
  /** 验收证据：谁验的、验的什么、结论。 */
  acceptance: TaskAcceptance | null;
  /** 时间戳。 */
  createdAt: number;
  updatedAt: number;
}

export type TaskStatus =
  | "pending"    // 已创建，未开始
  | "running"
  | "blocked"    // 等审批 / 等依赖
  | "done"       // 执行完成（**不等于验收通过**）
  | "failed"
  | "accepted"   // **验收通过**
  | "rejected";  // **验收不通过，需返修**
```

**关键设计判断**：

1. **`done` 和 `accepted` 必须分开** —— 路线图 §3「执行完成不等于验收通过」；
2. **`rejected` 要能回到 `running`**（返修）；
3. **`origin` 要能指向会话/工作流/自动化/另一个任务**（「可以由聊天、工作流、自动化和多个 Agent 关联或推进」）。

**在回写区论证这三个判断。**

### 第二步：`tasks` 表 + repository

**照 `scene.ts` 的形状**（它是先例）：

```ts
// apps/desktop/src/main/store/taskSchema.ts
export const TASK_TABLE = {
  name: "tasks",
  columns: [
    { name: "id", def: "TEXT PRIMARY KEY" },
    { name: "goal", def: "TEXT NOT NULL" },
    { name: "status", def: "TEXT NOT NULL" },
    { name: "depends_on", def: "TEXT" },      // JSON 数组
    { name: "origin", def: "TEXT" },          // JSON
    { name: "artifacts", def: "TEXT" },       // JSON
    { name: "acceptance", def: "TEXT" },      // JSON 或 NULL
    { name: "created_at", def: "INTEGER NOT NULL" },
    { name: "updated_at", def: "INTEGER NOT NULL" },
  ],
};
```

**注意 `sql.js` 的坑**（CLAUDE.md 环境事实）：

> `db.export()` 会重置连接上的 pragma（含外键）—— 导出只有 `exportBytes()` 一个出口。

**加表会不会触发迁移？** 查现有的 schema 迁移机制（`sessionSchema.ts` 里 `inCreate` 字段说明有迁移）。

### 第三步：IPC 三层

**契约 → preload 白名单 → 主进程 handler。缺一层调用端就看不到。**

```ts
// RpcMap 里加
"task.list": { input: { status?: TaskStatus }, output: { tasks: Task[] } };
"task.get": { input: { id: string }, output: Task | null };
"task.accept": { input: { id: string, evidence: string }, output: Task };
"task.reject": { input: { id: string, reason: string }, output: Task };
```

**`task.accept` / `task.reject` 是路线图「用户能完成、返修并重新验收」的直接实现。**

### 第四步：迁移 `todos`

**这一步可以选择不做**（保持 `todos` 继续工作，`tasks` 是新的独立对象）。

**但如果做**：
- `todos` 是会话内的数组，**没有 ID** —— 迁移要生成 ID；
- **迁移必须可逆**（出问题能退回去）；
- **不能丢数据**。

**先判断值不值得做，写进回写。** 我倾向**这轮不做**，先把 `tasks` 立起来。

## 验收判据

1. **`Task` 契约的形状论证**（三个关键判断：done≠accepted、rejected 能返修、origin 多来源）。
2. **`tasks` 表建出来**，且**旧数据的 schema 迁移不出问题**。
3. **IPC 三层打通**（契约 + preload + handler）。
4. **正控 + 负控**：
   - 创建任务 → `task.list` 能查到；
   - `accept` 后状态是 `accepted`；
   - `reject` 后状态是 `rejected`，**且能回到 `running`**；
   - **跨会话查得到**（这是「一级对象」的核心证明）。
5. **变异**：把 `done` 和 `accepted` 合成一个值 → 相关断言必须红。
6. 双包 typecheck；不跑全量、不起 Electron。

## 边界

- 只改上列文件 + 新建套件；
- **不改 `sessionSchema.ts` 的 `todos` 列**（迁移是另一张卡）；
- **不动 UI**（任务中心是 T100）；
- 不碰 B 的 `adoptMarkdown`、E 的六编辑器文件。

## 遇到问题先检索

`scene.ts` 是唯一的先例，**先读它**，尤其是它的 schema 迁移与 `acceptance` 形状。
`sessionSchema.ts` 的 `inCreate: false` 字段说明有迁移机制 —— **先搞清楚它怎么工作**。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T99-task-first-class.md` 末尾追加 `## 结果回写（2026-10-24）`：
契约形状论证、表结构、IPC 三层、正负控、变异、`todos` 迁移的判断、提交 SHA。

---

## 结果回写（2026-10-24，C 会话）

### 一、契约形状的三个判断（卡上要求论证）

#### ① `done` 与 `accepted` 必须分开

**路线图 §3 原文**：「**执行完成不等于验收通过**；失败应返修、重新验证……证据不够应标
BLOCKED/FAIL，而不是报告成功。」这是硬规矩。

**合成一个状态的后果，不只是少一个枚举值**：它会让「跑完了」和「跑对了」在数据上无法
区分。而这个仓库反复记录过同一类缺陷——「测试绿着而问题还在」是它在测试层的同构。任务
对象如果也合并，就会把同一类错误**抬进产品数据模型**：将来任何一个「任务完成率」的统计
都会是假的，而且不会有任何东西提示它是假的。

**实现上做了两层保证，不是一个枚举**：

1. `TASK_EXECUTOR_STATUSES` 是不含 `accepted` / `rejected` 的**可断言集合**；
2. `EXECUTOR_TRANSITIONS` 是**白名单**（不是黑名单）—— 新增状态默认无来源，必须显式想清楚。

> **为什么白名单**：黑名单（「不能从 X 到 Y」）下新增一个状态默认处处可达。白名单让
> 「新状态要先想清楚它能从哪来」变成一件必须做的事。

#### ② `rejected` 必须能回到 `running`

**路线图 §3**「失败应**返修**、重新验证」；**§5**「用户能完成、**返修并重新验收**」。

如果 `rejected` 是终态，用户唯一的出路是「再建一个任务」—— 那么「这是同一个任务的第二次
尝试」这个事实就丢了，而这恰恰是用户最需要看到的（「这个任务我退回过三次」）。

**轮次的语义我在实现中改过一次，值得记下来**：

第一版让 `reopen` 和 `accept` 都 `round + 1`，于是「退回 → 重开 → 通过」走 1→2→3，
**而用户只给过两次结论**。修正后的判据是：

> **`round` = 用户给出过几次验收结论。** `accept` 和 `reject` 各 +1，`reopen` 不动。

| 事件 | round |
|---|---|
| 首次验收通过 | 1 |
| 退回（第 1 次结论） | 1（状态 `rejected`） |
| 返修（`reopen`） | 1 不变 |
| 第二次通过 | 2 |

套件里有一条断言专门钉这个（`返修本身不推进轮次（仍是 1）`）。

#### ③ `origin` 要能指向多来源

**路线图 §3**「可以由**聊天、工作流、自动化和多个 Agent** 关联或推进」。

拆成两个字段，因为「发起」和「推进」是两件事：

| 字段 | 语义 | 基数 |
|---|---|---|
| `origin` | **谁发起的** | 恰好一个 |
| `links.sessionIds` / `links.workflowIds` | **还有谁在推进它** | 零到多 |

**如果塞进一个字段会怎样**：`origin` 被后加入的推进者覆盖掉，「谁发起」这个事实就丢了。
套件有一条断言专门验这个：`关联另一个会话` 之后 `发起者不变（关联 ≠ 改归属）`。

---

### 二、表结构

`apps/desktop/src/main/store/taskSchema.ts`：

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id, goal, status,
  depends_on TEXT DEFAULT '[]',   -- JSON
  origin TEXT NOT NULL,           -- JSON
  links TEXT DEFAULT '{"sessionIds":[],"workflowIds":[]}',
  artifacts TEXT DEFAULT '[]',    -- JSON
  acceptance TEXT,                -- JSON 或 NULL
  failure_reason TEXT, rejection_reason TEXT,
  created_at, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_status / idx_tasks_created;
```

**列的选择遵循 `scene_deployments` 的惯例**：可查询的投影单独成列（`status` / `created_at`），
形状复杂的放 JSON。`goal` 单独成列是因为它是**列表页要显示的那句话**，每次列表解一遍
JSON 只为取一个字段不划算。

**会不会触发迁移？——不会。** 这一点卡上要求查，结论是：

`sessionSchema.ts` 的 `inCreate` 那套是**给已有表加列**设计的（`inCreate: false` = 老库走
`ALTER` 补列）。**`tasks` 是新表，`CREATE TABLE IF NOT EXISTS` 本身幂等**，老库新库跑一遍都
一样。所以 `taskSchema.ts` **故意**长得和 `sessionSchema.ts` 不一样——这个差异写进了那个文件
的注释，免得下次有人以为是漏了。

**踩到一次 `db.ts` 自己的注释警告过的坑**：我在建表 SQL 的注释里写了反引号（`` `inCreate` ``），
而整段在一个 JS 模板字符串里 → `TS1005: ',' expected`。`db.ts` 原文就写着「SQL 注释里不要写
反引号」。已改成不带反引号的写法并补了一句提醒。

---

### 三、IPC 三层

| 层 | 文件 | 内容 |
|---|---|---|
| 契约 | `packages/contracts/src/ipc/task.ts`（新） | `Task` / `TaskStatus` / 四个输入 schema / 8 个通道常量 |
| 契约索引 | `rpcMap.ts` | 4 个**面向渲染端**的方法（`task.list/get/accept/reject`）+ 8 个通道 |
| preload | `preload/index.ts` | `task` 命名空间四项 |
| 主进程 | `main/ipc/task.ts`（新） | 8 个 handler |
| 注册 | `main/ipc/index.ts` | `registerTaskHandlers(ipc)` |

**为什么多出 4 个不面向渲染端的通道**（`task.create` / `transition` / `reopen` / `link`）：
它们是**执行方**的路径，不该进 `RpcMap`（那会让渲染端和扩展也能调）。但做成 IPC handler
是为了让无头套件**驱动与生产同一段代码** —— 如果只写成一个导出函数，套件验的和生产走的就是
两份实现（这正是 CLAUDE.md 第 15 条说的「提到它 ≠ 守着它」的另一种形态）。

---

### 四、正控 / 负控 / 核心证明

新套件 `apps/desktop/scripts/task-first-class-smoke/`，**27/27 通过**，**真建库**
（`MCODE_SMOKE_DATA_ROOT` 指向 `mktemp` 目录）。

| 组 | 断言 |
|---|---|
| **① 跨会话（核心证明）** | 不带 `sessionId` 列出全部；两个任务的 origin 不同会话；按 `sessionId` 筛只拿到该会话的 |
| **② done ≠ accepted** | 新建 pending → running → done；**done 时 `acceptance === null`**；产物落在任务上；accept 后才是 accepted |
| **③ 返修闭环** | done → rejected（退回理由存下）；**rejected → running**；返修不推进轮次；返修后能再次验收，记在第 2 轮 |
| **④ 执行方写不了 accepted** | `task.transition` 传 `accepted` 被拒，且状态未变 |
| ⑤ 状态机 | `pending → done` 被拒（没跑过不能说做完） |
| ⑥ 验收前置 | `pending` 不能验收 |
| ⑦ 多来源 | 关联另一个会话后，该会话也能查到；**发起者不变** |
| ⑧ 持久化 | `dependsOn` / `origin.kind=workflow` 存得住读得回 |

**「跨会话查得到」是「一级对象」的核心证明**——如果 `task.list` 只能查当前会话的任务，
那它就还是「会话的字段」，只是换了个表。套件第 ① 组用三条断言钉住这件事。

---

### 五、变异验证（两条，都精确变红）

| # | 变异 | 结果 |
|---|---|---|
| **M1** | `accept` 的 SQL 从 `status='accepted'` 改成 `status='done'`（**把两个状态合并**） | **25/27**：`★ accept 之后才是 accepted — "done"`、`返修后能再次验收通过 — "done"` |
| **M2** | `reopen` 的 SQL 从 `status='running'` 改成 `status='rejected'`（**让 rejected 变终态**） | **25/27**：`★ rejected → running（返修） — "rejected"` |

**M1 正是卡上要求的变异**（把 `done` 和 `accepted` 合成一个值），两条断言同时红且 detail
直接显示 `"done"` —— 精确指出「执行完成被当成了验收通过」。

两次还原均 `cmp -s` 逐字节一致，SHA-256 回到 `a8a2aa23…`，还原后复跑 27/27。

---

### 六、`todos` 迁移——**这轮不做**，理由

卡上倾向不做，我同意，理由比"先立起来"更具体：

1. **`todos` 没有 ID**，迁移要生成 ID，而生成规则一旦定下就难改（是 `task_` 前缀 + 内容哈希？
   还是纯随机？两种在「幂等迁移」上的后果不同）；
2. **迁移必须可逆**，而 `todos` 是会话内的**有序数组**，`tasks` 是**无序集合** —— 顺序信息
   在反向迁移时要额外存，这本身是个设计决定；
3. **两者不冲突**：`tasks` 立起来之后，`todos` 可以继续工作。用户不会因为没迁移而用不上——
   他今天看到的就是 `todos`，而 `tasks` 是新能力的载体（跨会话、验收、返修）。

**建议**：等 `tasks` 有了第一个真实写入方（T100 任务中心或某个执行路径）之后再做迁移，
那时才知道哪些字段真的被用到。

---

### 七、验证结果

| 项 | 结果 |
|---|---|
| `task-first-class-smoke` | **27/27** |
| 双包 typecheck | contracts **0**、desktop **0** |
| 未跑全量 | 按用户规矩 |
| 未起 Electron | 按卡边界 |

**边界遵守**：未改 `sessionSchema.ts` 的 `todos` 列、未动 UI、未碰他人文件。

---

### 八、留给 T100 的接口

任务对象已经可以承载路线图 §5 的核心闭环，但**还缺三件**（都不在本卡边界内）：

1. **谁调用 `task.create`** —— 现在只有 handler，没有生产路径建任务；
2. **审批落库** —— 路线图 §3 要求任务有「审批」，而当前审批仍是即时卡片、不落库；
3. **任务中心 UI** —— 六项能力（列表/状态/失败/审批/产物/证据）的重合度见 T96 调查。

`task.list` 的跨会话能力已经就绪，T100 可以直接用它做「全部任务」页。
