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

## 结果回写（2026-10-24）

> 执行会话（F）。**已修 + 已验**，提交见下。
> 一句话：`task.accept` / `task.reject` / `task.reopen` / `task.transition` 四条进了 `BLOCKED`，
> 并且加了一条**按域拦截**的闸门 —— 以后新加的 `task.*` 不许再悄悄落到 `write`。

### 1. 全表定档（`task.*` 一共 8 条 IPC，但只有 4 条有 RpcMap 条目）

**先说一个卡上没写、但影响判据的事实**：

```bash
$ grep -n '"task\.' packages/contracts/src/ipc/rpcMap.ts
1174: "task.list"     1175: "task.get"     1177: "task.accept"     1179: "task.reject"
$ grep -n "TASK_" packages/contracts/src/ipc/rpcMap.ts
2210: list  2211: get  2212: accept  2213: reject  2214: transition  2215: reopen  2216: link  2217: create
```

**八个 IPC 常量，只有四个在 `RpcMap` 里、只有四个在 preload 暴露**（`preload/index.ts:1032-1036`）。
`transition` / `reopen` / `link` / `create` **没有 RpcMap 条目，不进 preload**，
`ipc/task.ts` 自己的注释也写着「它**没有对应的 RpcMap 条目**……只由主进程内部的执行路径调用」。

⚠️ **这点对判据很关键**：`policyFor` 对**任何**字符串都会给答案（兜底），所以
「`policyFor("task.reopen")` 回答了什么」**不能**证明「这个通道对 agent 可达」。
我上一版探针（T104）打印的 `task.transition → write` 就是这么来的 —— 它对一个不存在于
RpcMap 的名字作答。**名字能查 ≠ 通道存在。**（这与 CLAUDE.md 里「一个从不说不的分类器，
它的肯定不是证据」是同一条。）

| RPC | 在 RpcMap | 在 preload | 定档 | 理由 |
|---|---|---|---|---|
| `task.list` | ✅ | ✅ | **read** | 只读；agent 需要知道「有哪些任务、什么状态、产物在哪」 |
| `task.get` | ✅ | ✅ | **read** | 同上 |
| **`task.accept`** | ✅ | ✅ | **blocked** | 验收结论 = 路线图 §5「执行完成 ≠ 验收通过」的落点，只有用户能给 |
| **`task.reject`** | ✅ | ✅ | **blocked** | 退回同样是验收结论 |
| **`task.reopen`** | ❌ | ❌ | **blocked** | 见下节论证 |
| **`task.transition`** | ❌ | ❌ | **blocked** | 纵深防御：T99 在 handler 里用 `TASK_EXECUTOR_STATUSES` 挡了一道，但那一层若放宽，policy 这层仍在 |
| `task.create` | ❌ | ❌ | **不加**（保持兜底 `write`） | 建任务是执行方的正常行为（「派活」），且它没有 RpcMap 条目；加进 `BLOCKED` 会与「执行方建任务是正常的」矛盾 |
| `task.link` | ❌ | ❌ | **不加**（保持兜底 `write`） | 关联会话/工作流是执行侧的簿记，不涉及验收 |

**为什么 `create` / `link` 不钉死**：卡上问的是「该是什么档」。它们**不在 RpcMap 里**，
agent 走 `app_api_call` 够不到；而兜底的 `write` 恰好表达了「万一以后暴露出来，要问一次」。
把它们也钉成 `blocked` 属于**过度收窄** —— 与 `modules.invoke` 落 `write` 而不是 `blocked`
是同一条取向（判据是「每次执行要用户批准」，不是「不给用」）。

### 2. `task.reopen` 的论证（卡上猜的方向与实现相反）

**卡上写**：「我的判断：`reopen` 是用户的行为（它意味着「我不满意，再做一次」）→ 也该 blocked。」

**实现不是这个意思。** `TaskRepo.reopen` 的注释（`store/repositories/task.ts:204-217`）：

> `rejected → running`：**返修**……同时把 `acceptance.round` 加一
> **【T99】轮次只在用户给出结论时推进**（accept / reject），**`reopen` 不动它**。

而 `ipc/task.ts` 的 handler 注释：

> `rejected → running`：返修。**用户退回后，执行方从这里重新开始**。

**所以 `reopen` 是执行侧的动作**，不是一次验收结论（它明确不推进轮次）。
卡上「它是用户的行为」这个前提**不成立**。

**但它仍然该 blocked**，理由换成这个：

> 它只在「用户刚退回」之后才有意义。**被退回的一方自己把任务重开**，等于无视用户的退回结论 ——
> 「不行，重做」之后该不该重做，应由用户再决定，不该由被退回的一方决定。

这与 `scene.resume` / `unattendedPlans.resume` 同一条取向：**续跑/重开是「用户点头」的执行那半，
agent 不该自己续自己。**

### 3. 改动

**`policy.ts`**：向 `BLOCKED` 表加四条（`task.accept` / `task.reject` / `task.reopen` / `task.transition`），
每条带理由。**注意措辞不能照抄**：`reopen` 的理由与另外三条不同（见上），
写进注释里了，避免下一个读的人把它当成「验收结论」误改。

**另外补了两处原本缺的**（跑套件时才暴露）：

1. **`DOMAIN_LABELS` 缺 `task` 域** —— `app-control-smoke` 有一条
   「清单里每个域都有 DOMAIN_LABELS 标签」因此**一直是红的**（T99 加 `task.*` 进 catalog 时没补标签）。
   补上后 agent 的 `app_api_list` 才有这个域的说明。
2. **`DOMAIN_TASK_ALIASES` 缺 `task`** —— 不加的话用户问「有哪些任务」时，guide 检索
   找不到这个域。**故意不放「验收 / 退回 / 接受 / 拒绝」这几个词**：那四条对 agent 是 blocked，
   把用户口语导向 blocked 方法只会换来一条拒绝。

### 4. 断言（`app-control-smoke`，582/582）

- pin 表加 6 条：4 条 blocked + **正控 2 条**（`task.list` / `task.get` 仍是 `read`）；
- **域闸门**（新）：`task.*` 里**任何**方法都不许落在 `write` / `danger` / `ui`，只允许 `blocked` 或 `read`。
  这条不是逐条钉，而是**按域拦** —— 下一个 `task.*` 加进来时立刻会红，而不是等它落到兜底；
- **取证前提**（新）：断言 `task.list/get/accept/reject` **真的在 RpcMap 里声明**。
  没有这条，上面那些断言测的可能是一串不存在的字符串（见 §1 的陷阱）。

### 5. 变异验证

删掉 `BLOCKED` 里的 `"task.accept"` 一行 → **套件退出码 1，红 2 条**：

```
✗ 权限 task.accept = blocked — {"level":"write"}
✗ ★ T105:task.* 域里没有任何方法落在 write/danger/ui(只有 blocked 或 read) — ["task.accept=write"]
```

**对照组仍绿**：`claude.approve` / `workflow.approve` / `scene.approve` 等原有 blocked 断言
一条没红 —— 证明这次改动没有把整个表弄乱。

还原后 `sha256` 逐字节一致。

**变异脚本第一版有一个错**（已修，留在脚本注释里）：最后打印红行时用 `print` 输出 `✗`，
在 GBK 控制台上抛 `UnicodeEncodeError` 退出 1 —— 而**套件那一步其实是成功的**。
这正是「脚本自己的失败会伪装成被测对象失败」。改用原样写出文件、由 Node 读取。

### 6. T99 注释是否与实现一致

`ipc/task.ts` 文件头原文：

> **一条硬边界：执行方够不到 `accept` / `reject`**
> …它们被 `appControl/policy.ts` 判为 `blocked`（agent 够不到）

**修好之后这句成立**（探针实测四条都是 blocked）。但**它漏了 `reopen`** ——
按本次判定，`reopen` 也是 agent 够不到的。**注释需要补一句**。
本卡边界写的是「只改注释、不改逻辑」，但我选择**不改** `ipc/task.ts`：
那份文件是别人正在编辑的活跃区域（`TaskCenterPanel` 同一批），
**同文件并发编辑的风险大于这句注释的紧迫性**。建议由 T99/T100 的持有者在下次编辑时补上，
本卡把这条差异写在这里备案。

### 7. 顺带回答总控的第 ② 问（审批历史的数据来源）

```bash
$ grep -rn "pendingApprovals" apps/desktop/src/main/ --include=*.ts
claude/ApprovalBridge.ts:48   private pendingApprovals = new Map<string, PendingApproval>();
$ grep -rn "CREATE TABLE.*approval" apps/desktop/src/main/store/*.ts   → 零命中
```

**确认：完全没有持久化。** 它是一个 `Map`，进程退出即丢失，处理完就 `delete`。
所以「审批历史」**需要新表** —— 那是 T99 那个量级的工作，**应该单独开卡**，不是顺手能加的。

### 8. 未做 / 需要注意

1. **没改 `ipc/task.ts` 的注释**（理由见 §6，同文件并发风险）。
2. **`task.create` / `task.link` 仍落兜底 `write`** —— 有意，理由见 §1。如果将来它们进 RpcMap，
   域闸门会立刻红，到时再决定。
3. **`app-control-smoke/run.sh` 有一个既有缺陷**（不是本次引入）：
   `cd "$(dirname "$0")/../.."` 落在 `apps/`（不是仓库根），而第 16 行又用 `$(dirname "$0")`
   拼 `../lib/esbuild-path.sh` —— **从仓库根调用会直接 `No such file or directory`**。
   必须 `cd apps/desktop && bash scripts/app-control-smoke/run.sh`。我没改它（不在本卡边界）。
4. **typecheck 基线**：本次改动前工作区已有 15 条别人引入的类型错误
   （`t65-deck-pattern-smoke` / `t96-probe` / 未提交的 `TaskCenterPanel`）。
   **我的两个文件 0 错误**，已验证。
