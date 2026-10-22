# T4｜工作流 owner 跨进程 CAS 互斥证明

- Status: ready-for-agent
- Category: bug
- Priority: P0
- Depends on: coordinate with T2/T3; independent files only
- Exclusive writable files: exact owner registry/CAS implementation and dedicated smoke files after inspection; do not overlap T2/T3.
## Required Skills
  - `mcode-smoke`: launch real OS child processes for competing owner acquisition.
  - `code-review`: review atomicity and recovery assumptions.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, `audit-ledgers/Mcode_统一审查台账.md`, archived T03/T10/T97.
- Acceptance: two real OS processes racing for the same flow cannot both become owner; stale owner recovery and process crash are tested. In-process mocks alone do not satisfy acceptance.
- Execute: inspect existing lock/CAS implementation and use temp paths; do not change persistent production user data.
- Result writeback: process-level race evidence, tests, failure injection, commit SHA, limitations.

## 总控核实过的缺陷（静态 E2，需你用真实双进程证明或推翻）

`apps/desktop/src/main/workflowEngines/fileExecutorOwnershipStore.ts`：

```ts
insert(record: ExecutorOwnershipRecord): boolean {
  if (this.records.has(record.flowId)) return false;   // 只查本实例内存
  const next = new Map(this.records);
  next.set(record.flowId, { ...record });
  this.persist(next);                                  // 整表覆盖写盘
  this.records = next;
  return true;
}
```

两个 OS 进程各自持有 `records` Map。A 写盘后 B 的 Map 仍是旧的，B 再 `insert` 会把 A 的记录**整表覆盖**，双方都以为自己拿到 owner。`remove()` 同样问题；`constructor` 末尾的 `persist(this.records)` 也会整表重写。

### 仓库已有现成的跨进程原语（先用它，不要另造）

`apps/desktop/src/main/lib/osFileLease.ts`（MC-069 / MC-097 收口产物）：

- `acquireOsFileLease(lockPath, waitMs?)` → `Promise<() => Promise<void>>`
- `withOsFileLease(lockPath, fn)` → `Promise<T>`

机制：`open(wx)` = `O_CREAT|O_EXCL`，内核保证同路径只有一个进程能创建成功；抢到的写 `{host,pid,token,createdAt}` 并持有到操作结束；抢不到的若持有者是本机已死进程（`process.kill(pid,0)` 抛 `ESRCH`）或锁过期（`LEASE_STALE_MS = 120s`）就回收重抢；否则抖动重试到超时，超时抛 `FILE_VERSION_CONFLICT`。

**关键障碍**：`osFileLease` 是**异步**的（`promises as fs`），而 `ExecutorOwnershipStore` 的接口是**同步**的。必须显式处理这个不匹配，三选一：

- **(a)** 把 store 写路径改成异步 —— 需核实所有调用点能否接受，`ExecutorOwnershipStore` 契约见 `workflowEngines/executorOwnership.ts`
- **(b)** 用同步等价原语（`openSync(path, 'wx')`）实现同款租约 —— **必须在回写里论证**它与 `osFileLease` 的语义差异、为什么不能直接复用、如何避免仓库明令禁止的「两份并存的实现」
- **(c)** 别的能证明跨进程互斥的方案

### 文件边界（独占）

**可写**：`workflowEngines/fileExecutorOwnershipStore.ts`、`workflowEngines/executorOwnership.ts`（仅当 CAS 契约必须扩展时逐项说明）、新建 `apps/desktop/scripts/<name>-smoke/`。

**不要碰**：`workflowEngines/registry.ts` 与 `nativeLibrarySync.ts`（T2 占用）、`orchestration/automationRunner.ts`（T3 将占用）、`appControl/apiCatalog.generated.ts`、`ipc/settingsTransfer.ts`、`lib/worktreeOps.ts`、`renderer/components/chat/ApprovalPrompt.tsx`、`McpToolDecisionCard.tsx`、`arc005-visual-baseline/`、`genoffice/`、`patches/`。

套件目录名必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*-smoke$/`。
