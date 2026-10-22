# Orca → Mcode 源码对照：依赖与派发图

> **状态（2026-10-23）：本轮已全部收口。** 七张规划票均已 `resolved`，六份对照报告与 T105 汇总均已提交。结论见 [07-synthesis](issues/07-synthesis.md) 与 `docs/research/orca-mcode/T105-integration-decision.md`。

## 目标
识别 Orca 当前本地固定源码可验证、Mcode 尚未等价覆盖而值得引入的最小能力，避免换底座或制造平行实现。

## 独立前沿：可同时派给六个执行对话（已全部交付）

| 规划票 | 正式任务卡 | 写入报告 | 阻塞 | 状态 |
|---|---|---|---|---|
| [01](issues/01-worktree-lifecycle.md) | T99 | docs/research/orca-mcode/T99-worktree-lifecycle.md | 无 | resolved |
| [02](issues/02-agent-runtime-pty.md) | T100 | docs/research/orca-mcode/T100-agent-runtime-pty.md | 无 | resolved |
| [03](issues/03-diff-review.md) | T101 | docs/research/orca-mcode/T101-diff-review.md | 无 | resolved |
| [04](issues/04-remote-cli.md) | T102 | docs/research/orca-mcode/T102-remote-cli.md | 无 | resolved |
| [05](issues/05-ui-ux.md) | T103 | docs/research/orca-mcode/T103-ui-ux.md | 无 | resolved |
| [06](issues/06-ipc-extensibility.md) | T104 | docs/research/orca-mcode/T104-ipc-extensibility.md | 无 | resolved |

## 后续阻塞任务（已解除并交付）

| 规划票 | 正式任务卡 | 阻塞 | 状态 |
|---|---|---|---|
| [07](issues/07-synthesis.md) | T105 | T99–T104 全部完成 | resolved |

## 总控决策规则

- 审计报告必须分清：Mcode 已有（等价）、部分已有、确实缺失、证据不足。
- 不允许把文档功能宣传、路径存在、E2 静态阅读当 U1 产品已验。
- 不允许 Orca 补丁/许可文件悄悄并入 Mcode，也不将 `mcode/integration` 强制重置为上游。
- 若与 T92–T97 在飞模块重叠，研究卡只读；实施选择必须等总控重新核对所有权。
- 六份报告齐后，T105 用“影响 x 集成复杂度 x 安全代价 x 测试可证明性”排优先级，提出**一个**下一批真正可实现的代码任务卡候选，不自行实现。

## 决策状态

- **已决定**：继续以 Mcode 为主线，Orca 是本地源码对照与可用实现参考；**不整体二开 Orca、不换底座、不复制大块代码**。
- **T105 已给出 Top 3**：① Docs 原生 AgentSkill 工具结果回到同一 SDK turn（现为 `tasks/T0`）；② Node-RED 单一工作流权威收敛（现为 `tasks/T2/T3/T4`）；③ UI 探针与审批键盘可观测性，再串行真机 U1（现为 `tasks/T5/T6`）。
- **已被 T105 明确否决**：默认 YOLO / skip-permission / full-access；把 Orca 的持久 provider child / PTY daemon 套给三家 SDK；完整 Hosted PR Review 与完整 VS Code API 的直接移植；凭 Orca 目录存在就判定 Mcode 缺失。
- **仍留白的**（属于后续任务，不在本目录决定）：远端 workspace 路由、PTY attach/checkpoint/输出背压、扩展 Host API 收敛——见 T105 §2 的六轴评分，用户已明确把它们放到后面。

## 本轮证据边界

六份报告与 T105 汇总都是 **E2 静态源码证据 + E3 假设**，没有运行真实 Electron、在线 SDK、SSH 或 U1 用户旅程。任何一条都不能被引用成「Mcode 已实现」或「Orca 已可在 Mcode 上跑」。实现验收只看 `tasks/` 与 `audit-ledgers/`。
