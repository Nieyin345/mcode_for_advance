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

**T14 报告补充的强论据**：同一目录下的 `workflowEngines/nodeRedStorage.ts`（609 行，`NodeRedFlowStorage`）**已经在用 `withOsFileLease`**。也就是说这个仓库里已经存在「用租约保护 workflow 存储」的实现，只是 `FileExecutorOwnershipStore` 没用它。这不是「缺原语」，是「同一目录一半用了一半没用」。

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

## 结果回写（2026-10-23）

### 1. 进程级竞态证据（先证明，后改代码）

**怎么起进程**：临时 repro 脚本（`.tmp/t4-repro/`，验完即删，不入库）用 esbuild 打包
`FileExecutorOwnershipStore` + 一段 driver；driver 用 `child_process.spawn(process.execPath, ...)`
各起**两个真实 OS 进程**，每个进程各自 `new FileExecutorOwnershipStore(<同一个 mktemp -d 目录>)`，
然后自旋到同一毫秒（`startAt = Date.now() + 1500`）再 `insert` 同一 flowId。

**修复前观察（改动前源码，2 轮一致）**：

```
[same-flow]        A(mcode)=>insert=true  B(node-red)=>insert=true
                   disk=[{"flowId":"flow-race","owner":"node-red", ...}]   ← 只剩一条
[different-flows]  A(flow-a)=>true  B(flow-b)=>true
                   disk=[{"flowId":"flow-a"|"flow-b", ...}]                ← 只留一条，丢了另一条
```

**两个进程都返回成功，磁盘上只剩一条记录** —— 双持竞态成立；且不同 flowId 的并发
insert 也会整表覆盖丢记录（T97 预言的第二半）。

**修复后同一 repro**：`same-flow` 两轮都是 `insert=true / insert=false`，磁盘一条；
`different-flows` 两轮都是两个 `true`、磁盘两条。

### 2. 方案选择与论证（选 (b)，同步等价原语）

选 **(b)**：在 `lib/osFileLease.ts` 内新增 `withOsFileLeaseSync`，与现有异步
`withOsFileLease` **同文件、同协议**。

- **为何不走 (a) 异步化**：`ExecutorOwnershipStore` 的 `insert/remove` 是同步契约，
  生产调用点 `runner.ts:975`（`acquireExecution` 在异步启动前同步占位）、
  `automationRunner.ts:2446`（`claimExecutorOwner` 同步决定本次派发是否 skip）、
  `registry.ts` 的 deploy 预占都是同步判据；改成异步会把这些判据全部推迟到 `await` 之后，
  等于重写调用方，超出本卡「独立文件、最小修复」边界。
- **与 `osFileLease` 的语义差异（只有两处，均刻意）**：
  1. 默认等待 5s（`LEASE_SYNC_WAIT_MS`）而非异步版 60s —— 同步版阻塞主线程，临界区是
     毫秒级小文件读-改-写，超时即 `FILE_VERSION_CONFLICT` fail-closed；
  2. 等待用 `Atomics.wait` 阻塞而非 `setTimeout` 让出事件循环。
- **为何不直接复用异步版**：同步函数无法 `await`；在同步上下文里等异步租约只能
  busy-wait 宏任务，等价于自造。
- **如何避免「两份并存的实现」**：两版共用同一份 `LeaseRecord` 类型、
  `isCompleteLeaseRecord` / `leaseOwnerAlive` / `LEASE_STALE_MS` / `LEASE_FRESH_GRACE_MS`
  与同一 `${real}.mcode-lock` 命名 —— **同一把锁文件互斥**（套件 J 双向实证：进程用同步
  租约持锁时，父进程异步 `acquireOsFileLease` 冲突；同步持有者被杀后异步租约按同一套
  pid 死活判据回收成功）。差异被收敛为「等待方式」一个参数化的点，不是两套锁协议。
- **boot 路径同样进租约**：constructor 的启动对账（stale 释放 / native 恢复 / blocked
  写回）本身是共享文件的读-改-写，旧实现无条件 `persist`，会覆盖并发进程刚写下的记录。
  现在整个对账在租约内跑，且**仅在结果与盘上不同时**才写（`serializeArchive` 单一序列化出口）。
- **写路径每次先读盘（CAS）**：`insert/remove` 在租约内 `readFreshLocked()` 重新解析，
  在新鲜状态上判定后 `atomicReplaceFileSync` 落盘，再刷新内存。运行中文件损坏 →
  抛错（fail-closed），**磁盘字节不动、内存不多记录**；跨进程的 `legacyBlocked` 是粘性的，
  别的进程标过不可验证后本进程拒绝 mcode 登记。

### 3. 测试

新增 `apps/desktop/scripts/executor-owner-cross-process-cas-smoke/`
（`main.ts` + `child-owner.ts` + `run.sh`，名字匹配 `*-smoke`），全部 `mktemp` 临时目录，
子进程走生产同一份 store：

| 组 | 断言 |
|---|---|
| A（5 轮） | 两个真进程竞争同一 flowId → 至多一个 `insert` 成功，磁盘恰一条，成功方与磁盘 owner 一致 |
| B（3 轮） | 两个真进程插不同 flowId → 都成功，磁盘两条（无整表覆盖） |
| C（3 轮） | 启动对账与并发 insert 相撞 → 对账不覆盖 `late-flow`，同时恢复 `native-flow` |
| D | 持租约进程被 SIGKILL → 锁文件留在盘上（死 pid）→ 下一进程回收并成功登记 |
| E | 崩溃进程留下的持久 owner 在新进程可见，可按 owner 身份释放并交接；非 owner 不能释放 |
| F | `.mcode-tmp` 崩溃碎片被忽略，原档完整、新登记成功 |
| G | 运行中文件损坏 → `insert`/`remove` 抛错，磁盘字节原样、内存无凭空记录 |
| H | 启动时损坏 → 原档逐字节改名保留、`legacyBlocked`、mcode 登记被拒、node-red 恢复可用 |
| I | 同进程两实例：后写者先读盘不覆盖；被拒的重复登记不回写旧快照 |
| J | 同步租约与异步 `osFileLease` 是同一把 `.mcode-lock`（双向） |

结果：**`executor-owner-cross-process-cas-smoke: 78/78 通过`**。
回归（同一 HEAD）：`executor-gate-d-smoke`、`executor-ownership-smoke`、
`executor-owner-identity-smoke`、`executor-registry-guard-smoke`、`arc006-registry-guard-smoke`、
`os-file-lease-health-smoke`、`flow-storage-integrity-smoke`、`automation-smoke`、
`node-red-e2e-smoke`、`workflow-native-load-smoke`、`workflow-engine-runtime-smoke`、
`doc-ops-smoke`、`extension-store-smoke`、`mcp-text-smoke`、`pi-models-store-smoke` 全 PASS。
双包 `tsc --noEmit` 干净。

已知非本卡红：`document-view-host-smoke` 在 `default channel strategy does not route unknown channels`
失败；**用 `git show HEAD:` 换回我改的两个文件的原始版本同样失败**，属并发会话/既有问题，与本卡无关。

### 4. 变异验证（撤修复 → 红 → 逐字节还原）

备份并以 `sha256sum` 记账，逐次 `cmp` 确认还原：

1. **撤写路径租约**（insert/remove 退回「查本实例 Map + 整表写」）：
   `60/78`；A 5 轮双成功、B 3 轮丢一条、G 运行中损坏被静默重建、H mcode 登记放行、I 丢记录 —— 全红。
2. **撤 boot 租约**（构造/对账退回无条件 `writeLocked`）：`77/78`；C 首轮即红
   （`["native-flow:node-red"]`，`late-flow` 被覆盖）。
3. **让 `withOsFileLeaseSync` 变 no-op**（只保留读盘、不加锁）：`27/41`；A 5 轮双成功、
   B 3 轮丢记录、D 锁文件不存在 —— 证明断言真正依赖**跨进程锁**，不是只靠 re-read。

三次还原后源文件哈希：`osFileLease.ts` = `a9bbdedd…3ab8cc`，
`fileExecutorOwnershipStore.ts` = `99bd8646…1b8f75`，均与变异前 `cmp` 逐字节一致；
还原后套件回到 `78/78`。

### 5. 提交

（见下方提交 SHA。）

### 6. 剩余限制

- **同步租约阻塞主线程最多 5s**：仅在另一进程长时间持锁时发生；临界区本身是毫秒级。
  若将来 owner 文件变大或写盘变慢，应评估把 store 异步化（方案 (a)）而不是加长等待。
- **`get()`/`list()` 仍只读本实例内存**（沿用 T10 契约，热路径不读盘）：先构造的实例
  在后发生的跨进程写入前读到的仍是旧快照。写路径会刷新自己；**读路径的陈旧窗口**
  在语义上安全（写时必先读盘、冲突必现），但不是跨进程实时视图。
- **跨机共享目录（网络盘）** 未验证：`leaseOwnerAlive` 对异机 pid 只能靠 120s 过期兜底，
  与异步版同一限制。
- **Windows 进程退出时锁文件残留**：靠 `process.kill(pid,0)` 判死回收（D 已证），
  但 pid 复用窗口内可能退让到 120s 过期；安全方向是拒绝而非双持。
- **未做真 Electron U1**：本卡证据等级 E1（真双 OS 进程 + 隔离磁盘），不是 U1。

