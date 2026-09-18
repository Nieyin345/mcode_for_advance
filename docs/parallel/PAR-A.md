# PAR-A：Runtime / Scheduler 解耦

先阅读项目根目录 `MCode-Development-Roadmap.md`，重点第 12 节。

## 任务
- ID：PAR-A / RUNTIME-03 / SCHED-08 / SCHED-09
- 完成 Scheduler → NodeInputBuilderRegistry → NodeRunInput → ExecutionContext → ExecutionEngine → ExecutorRegistry → NodeExecutor 解耦。
- Scheduler 只负责依赖、就绪、并发、失败/取消、Branch/Loop/Resume 等流程语义。
- 新增 builder/executor 不应要求 Scheduler 增加具体 kind 分支。

## 负责文件
- `apps/desktop/src/main/orchestration/scheduler.ts`
- `nodeInputBuilders.ts`、`executionContext.ts`、`executionEngine.ts`
- `executorRegistry.ts`、`runner.ts`
- 直接相关 smoke/test

## 禁止直接修改
`automationRunner.ts`、Workflow Renderer、`packages/contracts/src/outputConstraint.ts`、UI workflow editor、PAR-B RunStore/runtime state、PAR-E capability model。

## 约束
- 不重设计 `NodeRunInput`、`NodeOutcome`、`{{...}}`。
- AbortSignal/progress 属于 host runtime，不进入 contracts。
- 保留 Branch/Trigger/Conversation 特殊流程语义。
- CodeRunner/CommandRunner 仅在接口确有必要时做最小修改。

## 开始前
`git status --short`，再查看负责文件当前 diff，记录 baseline；不要覆盖已有改动。

## 验收
contracts typecheck、desktop typecheck、Scheduler/Engine/Dataflow/Code-Artifact smoke、`git diff --check`。
特别检查：Scheduler 新增具体 node kind 分支应为 0（真实 flow semantics 除外）。

## 跨任务协议
缺 contract 字段时提交 Interface Proposal，不直接修改其他 owner 的 contract。写明原因、最小字段、消费者、兼容性、smoke。

## 最终报告
`STATUS / BASELINE / CHANGES / FILES / ARCHITECTURE / TESTS / INTERFACE PROPOSALS / CONFLICTS / NEXT`
