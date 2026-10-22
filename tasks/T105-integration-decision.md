# T105｜Orca→Mcode 六域源码证据汇总与首个优化切片选型

| 项目 | 内容 |
|---|---|
| 编号/优先级 | T105 / P1，**依赖前六份报告，不可现在与 T99–T104 同时派出** |
| 固定 Orca SHA | `ea60ec5d7cb9b542d2b5b3fd986acfc8861e4560` |
| 前置 | T99、T100、T101、T102、T103、T104 六份报告与各自任务回写完成 |
| 独占可写 | `docs/research/orca-mcode/T105-integration-decision.md`，本任务卡的结果回写区 |
| 禁写 | 两项目源码、`orca/**`、其他六份审查报告、`.scratch/**`、其他 tasks、所有业务/许可证/安装器/真实用户资料 |

## Required Skills

- `codebase-design`：把六域候选抽成 Mcode 可复用的 interface/seam，先读 `.claude/skills/codebase-design/SKILL.md`。
- `writing-for-agents`：给未来真正开发任务写清可验证判据和边界而不堆砌细节，先读 `.claude/skills/writing-for-agents/SKILL.md`。
- `research`：检查证据是否真来自双方固定 SHA 的一手源码，先读 `.claude/skills/research/SKILL.md`；本卡不可开后台子代理，只沿用其一手证据方法。

## 开工前必读

`audit-ledgers/README.md`、`tasks/_PROMPT_TEMPLATE.md`、`CLAUDE.md`、`docs/agents/issue-tracker.md`、`.scratch/orca-mcode-comparison/{spec.md,map.md}`，以及 T99–T104 的**完整**任务卡、所有六份报告、对应提交和回写。

## 执行内容

1. 核实六份报告真实存在并核验各自 Orca SHA（固定 `ea60ec5d`）、Mcode HEAD、分类及证据；任一缺失则本卡标 **BLOCKED** 并停止汇总，不根据报告标题臆补。
2. 去重合并六域能力对照，形成明确可追溯索引：每一候选标注 Orca 和 Mcode 的源码符号/调用链、是否已有、E2/E3、合规风险；对冲突结论回到只读源码裁决。
3. 给至少 5 个候选按 **用户价值/对 Mcode 总目标贡献、复制难度、主程序改动规模、跨 SDK/跨端/跨平台影响、授权与第三方许可、能否用隔离测试证明** 六轴打 S/M/L；评分不可假装精确工时。
4. 给出优先顺序 **Top 3**；每个写具体收益、已有能力、要避免的重复实现、预计改动模块、共享 ABI/事件/IPC/扩展边界及验收难点；至少 3 个“现在不做”选择与证据。
5. 首推 **一个** 最小工程 PoC 候选（允许纯设计/测试桩），提出下一张独立代码任务的**任务草案**：唯一 write-set/禁写、预期 E1 老红新绿、审批和数据隔离、依赖其他 T92–T97 的冻结状态。**不直接创建下一编号 T 卡，不实施源码**，交由总控批准。
6. 许可证：明确哪些内容只借鉴设计，哪些复制需保留 Orca 原版权文本并另审资源/依赖；不改变任何发行门禁。
7. 交付 `docs/research/orca-mcode/T105-integration-decision.md`，追加本卡结果回写，精准提交报告与本卡，不推送。

## 边界（不要碰）

- 不运行 Orca/npm install/build/Electron，不重置/更新独立仓，不使用真实服务器、SSH 密钥、用户数据库、在线 SDK。
- 不把 smoke 绿、E2 源码阅读冒充 U1。没有证据支持的改善点明确标 E3，不纳入第一优先级。
- 与 T93–T97 或 T92 未合并稳定的函数交叉则**仅列依赖，不能直接派并行代码任务**。
- 不修改 `tasks/README.md` 或 `audit-ledgers/`，总控统一维护全局状态。

## 验收判据

1. 六份报告前置齐全、版本可验证，所有结论有双仓符号与证据来源；冲突有裁决依据。
2. 完整覆盖六域、至少 5 候选的六轴权衡、Top 3 和至少 3 不做项，清楚说明为何不直接迁 Orca 底座。
3. 给出一个可交付、保有安全审查、明确禁写的下一步最小 PoC 任务草案，但**本任务不实现或派发它**。
4. 唯一报告已提交且只修改授权两个文件；已写报告 SHA、任务回写 SHA、剩余 U1/许可证/动态测试等限制。

## 结果回写区

<!-- 追加六报告核验结果、候选数、报告文件/哈希、提交 SHA、未达判据。 -->
