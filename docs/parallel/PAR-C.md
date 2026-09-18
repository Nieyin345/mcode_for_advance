# PAR-C：Workflow Editor / Runtime UI

先阅读 `MCode-Development-Roadmap.md` 第 12 节。

## 任务
- ID：PAR-C / UI-04 / UI-05 / UI-06 / UI-07 / UI-10 / WF-10
- 建立 Workflow Editor、Runtime Inspector、Variables、Artifacts、Status、Progress UI。
- 展示 `input.data`、structured outputs、artifacts，以及 queued/running/success/failed/skipped/cancelled/unselected。
- 使用 `workflow.node.progress` 展示进度；提供 artifact viewer 和变量 picker。

## 负责文件
- `apps/desktop/src/renderer/components/settings/workflows/**`
- `WorkflowStepCard.tsx`、相关 `*Workflow*` chat 组件
- `sessionStore.ts` 仅 workflow runtime view
- workflow i18n、UI smoke/test

## 禁止直接修改
scheduler、runner execution、executionEngine、executorRegistry、nodeInputBuilders、automationRunner、runtime contracts、nodeTemplate、codeRunner、commandRunner。

## 约束
- 复用现有 `{{...}}`、`useRefOptions`、`insertables`。
- 不创建第二套 template/parser/variable semantics。
- 不在 renderer 实现 scheduler readiness 或 NodeOutcome。
- contract 缺字段时提交 Interface Proposal 给对应 owner。

## 开始前
`git status --short` + 负责文件 diff，记录 baseline，不覆盖已有改动。

## 验收
desktop typecheck、renderer/UI smoke、变量插入/校验、artifact rendering、`git diff --check`。

## 最终报告
`STATUS / BASELINE / CHANGES / FILES / UI FLOW / TESTS / PROPOSALS / CONFLICTS / NEXT`
