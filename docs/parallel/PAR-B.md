# PAR-B：Runtime State / Persistence / Resume

先阅读 `MCode-Development-Roadmap.md` 第 12 节。

## 任务
- ID：PAR-B / RUNTIME-04 / RUNTIME-07 / RUNTIME-09 / SCHED-10
- 统一 RunState、NodeRun、NodeOutcome、Snapshot、最终结果与 Resume 边界。
- 建立 crash recovery、run history、debug 信息和旧 snapshot 兼容策略。
- Resume 时 settled 节点不能无条件重跑。

## 负责文件
- `apps/desktop/src/main/orchestration/runStore.ts`
- `packages/contracts/src/runtime.ts`
- runtime state smoke/test

## 禁止直接修改
`scheduler.ts`、`nodeInputBuilders.ts`、`executionEngine.ts`、`executorRegistry.ts`、`automationRunner.ts`、`codeRunner.ts`、`commandRunner.ts`、Workflow Renderer、PAR-E capability 文件。
`executionContext.ts` 不直接改；需要字段时向 PAR-A 提 Interface Proposal。

## 约束
明确区分 RunState / NodeOutcome / Snapshot / final result；artifact 只保存稳定引用，不把大文件塞进普通 runtime event。

## 开始前
执行 `git status --short` 和负责文件 diff，记录 baseline，不覆盖已有改动。

## 验收
save/read run、outcome、snapshot；old snapshot；resume；awaiting；Branch/Loop；artifact refs；contracts/desktop typecheck；runtime smoke；Engine/Dataflow smoke；`git diff --check`。

## 跨任务
C/D 需要状态字段时走 Proposal；D 不得建立第二套 RunState；不改变 Scheduler 算法。

## 最终报告
`STATUS / BASELINE / CHANGES / STATE MODEL / PERSISTENCE / RESUME / BACKWARD COMPATIBILITY / TESTS / PROPOSALS / CONFLICTS / NEXT`
