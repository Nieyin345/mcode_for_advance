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

（执行者在此追加：选择与论证、接线点清单、生产路径打点证据、五套测试结果、变异证据、提交 SHA）
