# T27｜`loadWorkflowIntoNative` 拒绝一切可保存的 Node-RED 图 —— 装载入口是死路

- Status: ready-for-agent
- Category: **bug（P0 功能不可用）**
- Priority: **P0**
- Depends on: T21（已交付 `6e690e48`，接线上这个入口）、T8（`d58a0b1e`，发现这个缺陷）
- Exclusive writable files: `apps/desktop/src/main/workflowEngines/nativeLibraryLoad.ts`、`workflowMigrationGate.ts`、迁移器相关文件，新建回归套件。逐个确认后写进回写区。

## Required Skills
- `codebase-design`: 两个闸门互相矛盾，要先看懂它们各自在防什么。
- `mcode-smoke`: 建回归，并做变异验证。

Read before work: `CLAUDE.md`、`tasks/T21-orphaned-workflow-adapters.md`（含回写区）、`tasks/T8-node-red-electron-u1.md`（缺陷 1 的原话）、`docs/planning/product-roadmap/T14-workflow-baseline.md`。

## T8 实测出的缺陷（原话）

> **P0**：生产 T59 装载入口 `loadWorkflowIntoNative` **拒绝一切可保存的 Node-RED 图**（迁移器必报 lossy/human，保存闸门又要求 trigger/main 节点，两者叠加无解）。

## 目标

让「用户把库里的工作流迁到 Node-RED 画布」这条路径**真的能走通**。

### 必须做的事

**第一步：把两个闸门的矛盾说清楚。**

- **迁移器**（`workflowMigrationGate.ts` / `workflowMigrationPreflight.ts`）会在什么情况下报 lossy / HUMAN？
- **保存闸门**要求 trigger/main 节点——这个要求从哪来？为什么？
- **两者叠加为什么无解**：具体是哪一类文档永远过不去？

**把这些写成一张表**，不要只说「有冲突」。

**第二步：判断哪个闸门的要求是错的。**

三种可能：
- **(a) 迁移器太严** —— 某些 lossy 其实不影响可迁移性
- **(b) 保存闸门太严** —— 要求 trigger/main 节点的规则不适用于「迁到 Node-RED」这个场景
- **(c) 两者都对，但中间缺一个转换步骤** —— 需要在装载前把文档转成两边都接受的形状

**选一个并论证。不要两边都放松了事。**

**第三步：实施修复。**

要覆盖：
- 一个**普通的、含 trigger 节点的 Mcode 工作流**能成功迁到 Node-RED 画布
- 一个**含 Mcode 特有节点类型**的工作流（迁移器可能报 lossy）的行为要明确
- 真正不可迁移的（`REJECT`）仍然拒绝
- 失败时给**可读的理由**，不是「两者冲突」

**第四步：变异验证。**

把修复撤掉 → 对应断言必须变红 → 逐字节还原（`cmp`）。

## 边界

- **不改** T2 的 `nativeLibrarySync.ts`、T3 的 `automationRunner.ts`、T4 的 `fileExecutorOwnershipStore.ts`。
- **不改** `genoffice/`、`patches/`。
- **不宣称 ARC-006 完成**。
- 若发现修复需要改 `registry.ts`，先停下报告——那是 T2 的领地。

## 验收判据

1. 回写区给出**两个闸门的矛盾表**（哪类文档、被哪个闸门、以什么理由拒）。
2. 明确修的是哪个闸门（a/b/c），并论证。
3. 一个普通 trigger 工作流能成功装载到 Node-RED 画布（真跑，不是单测）。
4. `REJECT` 的仍被拒，且理由可读。
5. 变异验证：撤修复 → 断言变红 → `cmp` 还原。
6. 双包 typecheck 通过。
7. T21 的套件 `t21-orphaned-adapters-wired-smoke` 33/33 不回归。

## 结果回写（2026-10-23）

（执行者在此追加：矛盾表、修的是哪个闸门与论证、覆盖的场景、变异证据、提交 SHA、仍需 T8 重验的部分）
