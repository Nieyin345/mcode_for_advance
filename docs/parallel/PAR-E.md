# PAR-E：Capability / Skill / MCP / Plugin

先阅读 `MCode-Development-Roadmap.md` 第 12 节。

## 任务
- ID：PAR-E / CAP-03 / CAP-04 / CAP-05 / CAP-06 / CAP-08 / WF-06 / WF-08
- 建立可检查、可发现、可扩展的 Capability / Skill / Provider / MCP / Plugin / Node Type 模型。
- 目标链：node requirements → capability resolver → provider/skill/MCP/plugin → available/missing。
- 支持第三方 node/executor/skill discovery，并提供 missing capability diagnostics。
- academic research 不得硬编码进 core。

## 负责文件
- `packages/contracts/src/nodeType.ts`
- `provider.ts`、`plugin.ts`
- `apps/desktop/src/main/orchestration/nodeTypes.ts`
- capability/node-type renderer、smoke/test

## 禁止直接修改
scheduler、automationRunner、executionEngine、nodeInputBuilders、codeRunner、commandRunner、`packages/contracts/src/runtime.ts`。

## 约束
- 明确 node requirement、provider capability、skill applicability、MCP declaration、plugin declaration。
- 至少一个 builtin capability + 一个 plugin/simulated-plugin capability smoke。
- 保持 Claude / Pi / Codex 回归正常。
- 不创建第二套变量 parser、Runtime State 或 Scheduler kind branches。

## 开始前
`git status --short` + 负责文件 diff，记录 baseline，不覆盖已有改动。

## 跨任务
nodeType/provider/plugin 是本任务 contract owner。需要 runtime 字段时向 PAR-B 提 Interface Proposal；执行接口问题向 PAR-A 提 Proposal。

## 验收
contracts/desktop typecheck、capability/node type smoke、builtin check、plugin check、missing diagnostics、Claude/Pi/Codex regression、`git diff --check`。

## 最终报告
`STATUS / BASELINE / CHANGES / FILES / CAPABILITY MODEL / TESTS / PROPOSALS / CONFLICTS / NEXT`
