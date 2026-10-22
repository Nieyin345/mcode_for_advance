# T21｜悬挂的适配器：把 NodeRedFlowStorage 与 workflowMigrationPreflight 接上生产路径

- Status: ready-for-agent
- Category: bug
- Priority: P0 架构
- Depends on: **T2 与 T4 完成后才能开工**（它们会改动 `registry.ts`、`fileExecutorOwnershipStore.ts`；本卡要接的写路径与它们重叠）
- Exclusive writable files: 接线点所在的调用方文件（逐个确认后写进回写区），以及新建回归套件。**不改** `nodeRedStorage.ts` 与 `workflowMigrationPreflight.ts` 的内部实现——它们是已验收的资产。

## Required Skills
- `codebase-design`: 判断「接上」的正确接点在哪，以及是否应该删除其中一个事实源而不是两边都留。
- `mcode-smoke`: 证明接线后生产路径真的走了这些适配器，而不是绕开。
- `code-review`: 确认没有引入第二套存储语义。

Read before work: `CLAUDE.md`、`audit-ledgers/README.md`、`docs/planning/product-roadmap/T14-workflow-baseline.md`（**必读，第 5 节**）、`docs/planning/node-red-vendor-integration-map.md`、`tasks/T2-node-red-deploy-reconciliation.md`、`tasks/T4-workflow-owner-cross-process-cas.md`。

## 总控核实过的事实（已用 grep 验证，不是推测）

有两个**已实现、已测试、但没有生产调用方**的模块：

| 模块 | 行数 | 生产调用方 | 测试 |
|---|---|---|---|
| `apps/desktop/src/main/workflowEngines/nodeRedStorage.ts`（`NodeRedFlowStorage`） | **609** | **0**（只有定义与自身注释） | `flow-storage-integrity-smoke`、`flow-migration-smoke`、`flow-migration-identity-smoke` |
| `apps/desktop/src/main/workflowEngines/workflowMigrationPreflight.ts` | **1631** | **0**（grep `workflowMigrationPreflight` / `runMigrationPreflight` 零命中） | `t85-workflow-migration-preflight-smoke` |

`NodeRedFlowStorage` 具备 per-flow CAS、项目隔离、坏档不装空，并且**已经用了 `withOsFileLease`**。`workflowMigrationPreflight` 有 SAFE/HUMAN/REJECT 判据。

**它们的能力比现在生产路径上用的更强，但没有任何代码调用它们。**

T14 报告第 5 节的结论原话：「形成『有适配器、无 owner』的悬挂事实源。」

## 为什么要开这张卡

这不是「多写了代码」的洁癖问题。它意味着：

1. **真正在跑的是更弱的那套**。生产路径用的是 `executor-ownership.json` 的内存 Map + 整表覆写（T4 正在修），而旁边 609 行的 CAS 存储没人用。
2. **两套并发机制并存**。`NodeRedFlowStorage` 用 `withOsFileLease`，`FileExecutorOwnershipStore` 没有。同一目录里一半有锁一半没锁。
3. **迁移预检没有守卫**。1631 行的 SAFE/HUMAN/REJECT 判据，用户迁移旧 flow 时根本不会经过它。
4. **测试在给死代码护航**。五套套件全绿，但护的是没人调用的路径——这是本仓库已经吃过亏的那类假绿。

## 目标

二选一，**必须做出明确选择并论证**：

**(A) 接线**：把生产路径改为走这两个模块。
- 存储：`registry.ts` 的 flow 持久化改走 `NodeRedFlowStorage`，或把它的 CAS/租约能力上提为唯一实现。
- 迁移：`automationRunner` 或迁移入口在装 flow 前必须过 `workflowMigrationPreflight`，`REJECT` 直接拒、`HUMAN` 要求确认、`SAFE` 放行。
- **接线后必须证明生产路径真的走了它**（打点或断言，不能只看 import）。

**(B) 删除**：如果调查发现它们已被更好的实现取代，**删掉代码与对应测试**，并在回写里说明为什么。

**不允许的选择**：留着不动、或者在回写里写「未来会接」。这两种都会让问题继续存在。

## 硬约束

- **不改**两个模块的内部实现（它们是已验收资产）。只改调用方。
- **不引入第二套存储语义**：如果接线时发现两套语义冲突，先停下报告冲突，不要私自合并。
- **必须处理 T2/T4 的在飞改动**：开工前先确认它们已提交、工作区干净到足以判断边界。
- 迁移预检接线时**不得**让 `REJECT` 有放行后门。

## 验收判据

1. 回写区给出明确选择（A 接线 或 B 删除），并论证。
2. 若选 A：
   - 生产路径打点证明 `NodeRedFlowStorage` 的方法被真实调用（不是测试里调用）。
   - 一次真实迁移经过 `workflowMigrationPreflight`，`SAFE` 通过、`REJECT` 被拒。
   - 那五套既有测试仍然全绿。
3. 若选 B：两个文件删除，五套测试同步删除或改写，`run-all-smokes` 不出现找不到套件的错误。
4. 变异验证：把接线点改回旧路径，对应断言必须变红；逐字节还原（`cmp`）。
5. 双包 typecheck 通过。
6. **不得**宣称 ARC-006 完成。

## 结果回写（2026-10-23）

### 选择：A（接线）

**论证。** 两个模块都是**更强的实现**、没有被取代，删除会让生产路径退回更弱的一套：

- `workflowMigrationPreflight` 的 SAFE/HUMAN/REJECT 判据（round-trip、未知节点、触发语义、
  审批 stale、在途运行、未知字段、原型污染键）在生产路径上**没有任何等价物**。删掉它，
  装载唯一的防线就是 `migrateWorkflowDoc` 的 unmapped/needsHumanDecision/lossy 报告 ——
  那份报告不判审批、不判在途、不查未知字段、不管 `__proto__` 键（本轮变异 M1 实测：
  去掉预检后，带 `__proto__` 数据键的文档 `ok:true` 装载成功）。
- `NodeRedFlowStorage` 的 per-flow CAS + 跨进程 OS 租约 + docId 防漂移 + 坏档不装空，
  在它自己的领域（per-document 记录）里是唯一实现；`fileExecutorOwnershipStore` 是
  **另一个领域**（执行归属账本），不是它的替代品。

**核实过的前提修正（要如实说）：** 任务卡表格写 `nodeRedStorage.ts` "生产调用方 0"，这
对**整份文件**不成立 —— `readNativeCanvas` / `replaceNativeCanvas` 早已被
`nativeLibraryLoad.ts`（经 `ipc/index.ts` 注册的 `workflowEngine.load`）生产调用，T59 起
就在跑。真正零调用方的是 **`NodeRedFlowStorage` 类**（per-flow 存档 API）。本卡接的是后者。

**为什么接在装载入口而不是 `registry.ts` 的 flow 持久化：** T14 报告 S5 已把"引擎
`flows.json` 接自定义 `storageModule`（让 Node-RED 的每次内部落盘都走 per-flow CAS）"
定义为**另一张卡**（`nodeRedStorageAdapter.ts` + bootstrap/launchSpec 注入点，需先定 S2
方向，且与 S2 共用文件、不得并行）。在本卡里改 `registry.ts` 的持久化会同时碰到
T2 刚交付的 `nativeLibrarySync` 协调面和 S5 的保留文件，且**拿不到**"一次真实迁移"这条
可断言的生产路径。装载入口 `loadWorkflowIntoNative` 是 `workflowMigrationPreflight` 唯一
语义正确的接点：它就是应用里"把库文档变成 Node-RED 画布"的那一刻，一次真实迁移。

**不引入第二套存储语义（code-review 轴）。** 装载记录是**派生的装载日志**，不是第二份
flow 真相：`flows.json` 仍是引擎权威（内容寻址备份/回滚原样保留），SQL `WorkflowDoc`
仍是用户文档，Node-RED 的 storageModule 仍是它自己的落盘者。记录只回答"Mcod 上次为
这张图往画布里放了什么"，供三件事：坏档拒覆盖、错绑拒绝、确认文案说明画布是否漂移。

### 接线点清单（本卡独占写入的文件）

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/main/workflowEngines/nativeLibraryLoad.ts` | 生产装载入口：先过迁移预检（REJECT/UNREADABLE 无条件拒，HUMAN 要 `confirmReplace`），再写 `NodeRedFlowStorage` per-document 装载记录（读前置、CAS、坏档/错绑拒覆盖、启动失败回滚记录），然后才动画布 |
| `apps/desktop/src/main/workflowEngines/workflowMigrationGate.ts` | **新建**：宿主事实 → 预检 `runtimeFacts` 的投影 + 临时隔离目录里跑 `runWorkflowMigrationPreflight` 的胶水（判据一条不复制） |
| `apps/desktop/src/main/workflowEngines/executorOwnership.ts` | 只加只读 `runningFlowIds()`（在途事实的唯一可信来源） |
| `apps/desktop/src/main/ipc/index.ts` | 生产装配注入 `migrationFacts`：`workflowReviewOf(doc)` + `sharedExecutorOwnership.runningFlowIds()` |
| `apps/desktop/scripts/t21-orphaned-adapters-wired-smoke/{main.ts,run.sh}` | **新建**回归套件（33 断言） |
| `apps/desktop/scripts/workflow-native-load-smoke/main.ts` | 夹具补 `migrationFacts` 的诚实声明（无审批、无在跑） |

**没碰**：`nodeRedStorage.ts` / `workflowMigrationPreflight.ts` 内部实现（零改动）、
`fileExecutorOwnershipStore.ts`、`lib/osFileLease.ts`、`nativeLibrarySync.ts`、`registry.ts`、
`automationRunner.ts`（T3 的在飞改动原样保留）。

### 一个必须记录的判据事实（否则接线会错）

预检的 approval 判据要求 `approvedRevision` **严格等于**它对送检文档现算的 revision；
而 SQL 侧 `workflowTrust.workflowRevision` 是**另一个文档形状**上的哈希（保留 `engine`，
而装载投影必须删 `engine`，否则预检 100% REJECT `workflow-already-node-red-owned` ——
已实测）。两者**不可能相等**。本轮实测：把真实审批 revision 塞进去 → 已批准文档被判
`approval-revision-mismatch` REJECT。这是 `flowTrustGate.ts` 文件头写明的同类问题：
不同形状的 revision 之间不做换算。所以投影为：无记录 → `not-required`；待审 →
`pending`；已批准 → `unknown`（**如实**：拿不到可比对快照）。`pending`/`unknown` 都只
升 HUMAN（要求人工确认），**绝不放宽成 SAFE**；`REJECT` 永远来自预检自身。

### 生产路径打点证据

新套件驱动的是**生产函数** `loadWorkflowIntoNative`（`ipc/index.ts` 注册进
`workflowEngine.load` 的那一个），不是两个适配器单独调用：

- `★ REJECT 消息点名缺失类型（预检判据，不是旧的迁移报告）` —— 断言拒绝消息含
  `迁移预检` + `unmapped-mcode-node-type`，证明预检而不是旧迁移报告在判。
- `★ 生产装载为这份文档写出了 per-document 装载记录（NodeRedFlowStorage 路径）` +
  `★ 记录可被 NodeRedFlowStorage 读回，且 docId 绑定这份文档` + `★ 记录内容就是迁移器
  产出的原生节点` —— 三条合起来证明 `NodeRedFlowStorage.saveFlow` 在生产调用里**真的
  执行**并落盘（不是只看 import）。
- `★ 同一文档两份并发装载记录写入：恰好一成一败（CAS + OS 租约）`。
- 一次真实迁移经预检：`★ SAFE 文档直接装载`、`★ 用户明确确认后 HUMAN 文档装载成功`、
  `★ 未知节点类型：REJECT 拒绝装载`（判据 2 的"SAFE 通过、REJECT 被拒"）。
- `★ REJECT 不是「要求确认」——confirmReplace 不是放行后门`：REJECT/UNREADABLE 分支不读
  `confirmReplace`（变异 M2 实测：改成"确认可越过"后，带 `__proto__` 键的文档
  `ok:true` 装载成功，5 条断言变红）。

### 五套既有测试结果（接线后）

| 套件 | 结果 |
|---|---|
| `flow-storage-integrity-smoke` | **54/54 通过** |
| `flow-migration-smoke` | **249/249 通过** |
| `flow-migration-identity-smoke` | **21/21 通过** |
| `t85-workflow-migration-preflight-smoke` | **34/34 passed**（含其自带两组变异红与源哈希不变） |
| `workflow-native-load-smoke` | **17/17 通过** |

新套件 `t21-orphaned-adapters-wired-smoke`：**33/33 通过**。
相关面另跑：`memory-codex-smoke` 234/234、`executor-ownership-smoke` 17/17、
`workflow-engine-runtime-smoke` 114/114、`workflow-engine-selection-smoke` 16/16、
`executor-gate-d-smoke` 85/85、`orchestration-ipc-smoke` 433/433、
`node-red-deploy-reconciliation-smoke` 75/75、`t3-engine-trigger-gate-smoke` 54/54。

### 变异证据（对最终代码逐项执行，`cmp` 逐字节还原）

备份 `nativeLibraryLoad.ts`（SHA-256 `7330bb79…`）→ 每项单独施加 → 跑新套件 →
还原 → `cmp -s` 通过：

| 变异 | 结果 |
|---|---|
| M1 预检整段不跑（当 SAFE） | **6 条红**（含"原型污染键…`{"ok":true}`"） |
| M2 REJECT 分支改成 `&& !confirmReplace`（后门） | **5 条红**（含未知节点/污染键被放行） |
| M3 装载记录不写（`saveFlow` 换成假成功） | **4 条红** |
| M4 坏档/错绑记录被忽略 | **2 条红** |
| M5 HUMAN 不再要求确认 | **3 条红**（未确认的 HUMAN 文档 `ok:true`） |

五次还原后 `cmp -s` 全部逐字节一致，最终文件 SHA-256 `7330bb79b4ed272dd04e901a4c916b80e4b8ac7359476d6a6d5972d3c265583c`。

### 其他

- 双包 typecheck：`apps/desktop` exit 0、`packages/contracts` exit 0。
- `run-smokes` 动态发现 536 套，新套件名字合法（`t21-orphaned-adapters-wired-smoke`）。
- **不宣称 ARC-006 完成。** 本卡只把两个悬挂适配器接上装载入口；MERGE-1 的
  storageModule 注入（S5）、MERGE-2/3 的单执行/单触发、真 Electron U1 均未触及。
- 剩余风险如实记：装载记录是派生日志，引擎内部落盘仍不经过它（S5 另卡）；预检对
  "已批准"只能报 unknown（跨形状 revision 不可比），因此已批准的图装载仍需人工确认
  一次 —— 这是 fail-closed 的正确形态，不是缺陷。
- 提交 SHA：`（见下方提交行，提交后回填）`。
