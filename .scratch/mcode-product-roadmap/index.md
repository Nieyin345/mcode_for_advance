# Mcode 产品路线知识索引

恢复时间：2026-10-23。此目录是产品路线 grilling 的可持续记录，不替代正式执行任务与审查台账。

## 决策与背景
- [正式产品路线总纲](../../docs/planning/mcode-product-roadmap.md) — 用户确认的长期方向、近期交付优先级与统一验收边界（非实现完成证据）。
- [spec.md](spec.md) — Q1–Q51 grilling 的路线恢复稿：可确认决定、优先级、安全原则、明确未决定项。
- [sources.md](sources.md) — 来源和置信度：区分用户原话、个人上下文摘要、既有技术台账；说明未找回的原始题干。
- [map.md](map.md) — 从现有尾项到 FULL-0 基线、四条主线、端到端验证的依赖图。

## 可派发规划票
- [T12 UI 基线](issues/12-ui-workbench-baseline.md) — 对应正式任务 tasks/T12-ui-workbench-baseline.md。
- [T13 GenOffice 基线](issues/13-genoffice-baseline.md) — 对应正式任务 tasks/T13-genoffice-baseline.md。
- [T14 工作流基线](issues/14-workflow-baseline.md) — 对应正式任务 tasks/T14-workflow-baseline.md。
- [T15 Agent/Host 基线](issues/15-agent-host-baseline.md) — 对应正式任务 tasks/T15-agent-host-baseline.md。

## 治理规则
- 本目录保存产品决策历史与规划；tasks/README.md 是正式执行任务入口。
- audit-ledgers/README.md 与 audit-ledgers/Mcode_统一审查台账.md 是正式缺陷/架构状态与验收证据来源。
- 不将恢复稿伪装成原始 Q1–Q51 逐字记录；找到原始记录后只追加来源与更正，不抹去本次恢复过程。

## 状态说明（2026-10-23）

T12-T15 四张票均为 `ready-for-agent`、彼此无依赖，可同时派发；报告写入 `docs/planning/product-roadmap/`（目录已建）。Orca 对照线的七张票已全部 `resolved`，那条线不再有 frontier。
