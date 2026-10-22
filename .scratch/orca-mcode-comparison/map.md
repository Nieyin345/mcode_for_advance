# Orca → Mcode 源码对照：依赖与派发图

## 目标
识别 Orca 当前本地固定源码可验证、Mcode 尚未等价覆盖而值得引入的最小能力，避免换底座或制造平行实现。

## 独立前沿：可同时派给六个执行对话

| 规划票 | 正式任务卡 | 写入报告 | 阻塞 |
|---|---|---|---|
| [01](issues/01-worktree-lifecycle.md) | T99 | docs/research/orca-mcode/T99-worktree-lifecycle.md | 无 |
| [02](issues/02-agent-runtime-pty.md) | T100 | docs/research/orca-mcode/T100-agent-runtime-pty.md | 无 |
| [03](issues/03-diff-review.md) | T101 | docs/research/orca-mcode/T101-diff-review.md | 无 |
| [04](issues/04-remote-cli.md) | T102 | docs/research/orca-mcode/T102-remote-cli.md | 无 |
| [05](issues/05-ui-ux.md) | T103 | docs/research/orca-mcode/T103-ui-ux.md | 无 |
| [06](issues/06-ipc-extensibility.md) | T104 | docs/research/orca-mcode/T104-ipc-extensibility.md | 无 |

## 后续阻塞任务（先不派）

| 规划票 | 正式任务卡 | 阻塞 |
|---|---|---|
| [07](issues/07-synthesis.md) | T105 | T99、T100、T101、T102、T103、T104 的研究报告全部完成 |

## 总控决策规则

- 审计报告必须分清：Mcode 已有（等价）、部分已有、确实缺失、证据不足。
- 不允许把文档功能宣传、路径存在、E2 静态阅读当 U1 产品已验。
- 不允许 Orca 补丁/许可文件悄悄并入 Mcode，也不将 `mcode/integration` 强制重置为上游。
- 若与 T92–T97 在飞模块重叠，研究卡只读；实施选择必须等总控重新核对所有权。
- 六份报告齐后，T105 用“影响 x 集成复杂度 x 安全代价 x 测试可证明性”排优先级，提出**一个**下一批真正可实现的代码任务卡候选，不自行实现。

## 决策状态

- 已决定：继续以 Mcode 为主线，Orca 是本地源码对照与可用实现参考；没有决定整体二开 Orca。
- 未决定：首个最小 PoC、是否需要独立许可来源整合、具体代码归属和用户旅程 U1 门禁。
