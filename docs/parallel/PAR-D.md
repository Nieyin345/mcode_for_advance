# PAR-D：Automation / Trigger 平台化

先阅读 `MCode-Development-Roadmap.md` 第 12 节。

## 任务
- ID：PAR-D / AUTO-05 / AUTO-06 / AUTO-07 / AUTO-09 / AUTO-10
- 完成 schedule / file / event trigger 的后台自动化基础设施。
- schedule：cron lifecycle、startup restore、start/stop、error record。
- file watcher：glob/filter/debounce/lifecycle/invalid watcher handling。
- event：复用现有 hook/event contract；trigger payload 必须结构化。
- dashboard：enabled/running/last run/last error；保留 active-run dedup 与 entry payload。

## 负责文件
- `apps/desktop/src/main/orchestration/automationRunner.ts`
- watcher/schedule/automation orchestration
- automation renderer、smoke/test
- `packages/contracts/src/hook.ts`

## 禁止直接修改
scheduler、executionEngine、executorRegistry、nodeInputBuilders、codeRunner、commandRunner、Runtime State model、PAR-E capability model。

## 约束
Automation 只决定“何时触发”；workflow runtime 决定“如何执行”。保留 trigger → workflow run 链路，不实现第二套执行引擎或 RunState。

## 开始前
`git status --short` + 负责文件 diff，记录 baseline，不覆盖已有改动。

## 跨任务
hook.ts 是本任务 contract owner。需要 runtime 状态字段时向 PAR-B 提 Proposal；需要执行接口时向 PAR-A 提 Proposal。

## 验收
schedule/startup/stop/invalid、file/debounce、event、dedup、payload、entry、error smoke；desktop typecheck；automation/workflow smoke；`git diff --check`。

## 最终报告
`STATUS / BASELINE / CHANGES / FILES / TRIGGERS / TESTS / PROPOSALS / CONFLICTS / NEXT`
