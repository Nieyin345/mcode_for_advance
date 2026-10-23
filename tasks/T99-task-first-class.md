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
