# T105｜🔴 P0 安全：`task.accept` / `task.reject` 对 Agent 开放 —— 注释说不能，代码说能

- Status: ready-for-agent
- Category: **P0 安全**
- Priority: **P0 —— 破坏路线图 §5「执行完成 ≠ 验收通过」**
- Depends on: T99（`3e4083f7`，建了 task.* 但没配权限）、T104（A 的探针 `6c196e7f`）
- Exclusive writable files:
  - `apps/desktop/src/main/appControl/policy.ts`
  - `apps/desktop/scripts/` 下新建或延伸的权限套件

## Required Skills
- `mcode-smoke`：权限矩阵回归。
- 无前端需求。

## 背景：注释和实现相反

**T99 的 `ipc/task.ts` 文件头写着**：

> **一条硬边界：执行方够不到 `accept` / `reject`**
> …它们被 `appControl/policy.ts` 判为 `blocked`（agent 够不到）

**A 的探针实测（`.tmp/t104/policy-probe.ts`，直接调 `policyFor`）**：

```
task.list        → read
task.transition  → write
task.accept      → write      ← 应是 blocked
task.reject      → write      ← 应是 blocked
claude.approve   → BLOCKED    ← 对照：真的 blocked
workflow.approve → BLOCKED    ← 对照
```

**根因**：

```
policyFor 的判定顺序：
  BLOCKED → CREDENTIAL_BEARING → DANGER → EXPLICIT → 按动词猜 → 兜底 write
```

**`grep -n "task\." policy.ts` → 零命中。**

**所以 `task.accept` 不在 `BLOCKED`，`accept` 也不匹配 `READ_VERB`，落到兜底 `write`。**

### 后果

`write` 在正常模式下是「需批准」——**但**：

```ts
// tools.ts:554
if (mode && BYPASS_MODES.has(mode)) return null;   // ← 直接放行
```

**在 `bypassPermissions` / `full-access` 下，Agent 可以自己把任务标成「已验收」。**

**而路线图 §5 明写**：

> **执行完成 ≠ 验收通过。** ……不许拿「报告已写」「测试跑绿」冒充产品通过。

**这条漏洞让 Agent 能绕过它。**

## 任务

### 一、加进 `BLOCKED`

```ts
const BLOCKED = new Set([
  ...
  "task.accept",
  "task.reject",
]);
```

**照 `claude.approve` / `workflow.approve` 的写法**（它们在 `BLOCKED` 里）。

### 二、做一张完整的权限矩阵，别只补两条

**`task.*` 一共几条？**（T99 建了 `list` / `get` / `create` / `transition` / `reopen` / `link` / `accept` / `reject`）

**逐条定档**：

| RPC | 该是什么档 | 理由 |
|---|---|---|
| `task.list` | read | 只读 |
| `task.get` | read | 只读 |
| `task.create` | write？ | **执行方建任务是正常行为**（那是「派活」） |
| `task.transition` | write？ | 状态流转（pending → running） |
| `task.reopen` | ? | **返修** —— 这算执行还是验收？ |
| `task.link` | ? | 关联会话/C 任务 |
| **`task.accept`** | **blocked** | **只有用户能验收** |
| **`task.reject`** | **blocked** | **只有用户能退回** |

**`task.reopen` 要论证**：把 rejected 改回 running，**是用户说「再试一次」还是 Agent 说「我再试一次」？**

**我的判断**：**`reopen` 是用户的行为**（它意味着「我不满意，再做一次」）→ **也该 blocked**。

**但你要论证，并写进回写。**

### 三、加一条套件，把「注释说的」和「代码做的」对齐

**新建或延伸一个权限套件**，断言：

1. `task.accept` / `task.reject` / `task.reopen` → **`blocked`**；
2. `task.list` / `task.get` → `read`；
3. `task.create` / `task.transition` / `task.link` → `write`；
4. **对照组**：`claude.approve` / `workflow.approve` 仍然是 `blocked`（没被这次改动破坏）。

**第 4 条必须有** —— 它证明你没把整个表弄乱。

### 四、⚠️ 检查 T99 的注释

**`ipc/task.ts` 文件头那句「执行方够不到 accept / reject」在修好之后才成立。**

**如果 `task.reopen` 也进 blocked，注释要一起更新**（现在只写了 accept/reject）。

## 验收判据

1. **`task.accept` / `task.reject` → `blocked`**（探针实测）。
2. **`task.*` 全表逐条定档**，每条有理由。
3. **`task.reopen` 的论证**。
4. **对照组**：`claude.approve` / `workflow.approve` 仍 blocked。
5. **变异**：把 `task.accept` 从 `BLOCKED` 移除 → 断言必须红。
6. **T99 的注释与实际一致**。
7. 不跑全量、不起 Electron。

## 边界

- 只改 `policy.ts` + 权限套件；
- **不改 `ipc/task.ts` 的逻辑**（只改注释）；
- 不改 `TaskRepo`；
- 不碰 `documentToolRuntime.ts` / `build/` / `deckPatternCheck.ts`（别人在改）。

## 遇到问题先检索

`policy.ts:518-537` 的判定顺序、`BLOCKED` / `EXPLICIT` / `READ_VERB` 的定义先读一遍。
`claude.approve` / `workflow.approve` 为什么在 `BLOCKED` 里 —— **照它们的理由办**。

## 回写

`tasks/T105-task-accept-permission.md` 末尾追加 `## 结果回写（2026-10-24）`：
全表定档与理由、`task.reopen` 的论证、探针输出、变异、T99 注释更新、提交 SHA。
