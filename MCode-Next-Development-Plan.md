# MCode 下一阶段开发计划与架构演进方案

> 基于 `MCode-Development-Roadmap.md` 当前完成状态制定。
>
> 当前阶段：第一轮 PAR-A~E 并行开发已完成，Runtime、Scheduler、Automation、Capability、UI 基础边界已经形成。
>
> 下一阶段目标：从“可扩展 Workflow Runtime”进一步演进为“通用 Agent Automation Platform”。

---

# 1. 当前架构状态总结

当前已经完成：

- Workflow 图模型稳定化。
- Scheduler 与 Executor 解耦。
- NodeRunInput / ExecutionContext / NodeExecutor 链路形成。
- Code / Command Executor 可扩展。
- Runtime State 与 RunStore 基础完成。
- Trigger → Workflow Run 自动化链路完成。
- Capability / Skill / Plugin 基础模型完成。
- UI 已可以展示运行状态、变量、artifact。

当前架构：

```
User
 ↓
Workflow Editor
 ↓
WorkflowDoc
 ↓
Scheduler
 ↓
NodeInputBuilder
 ↓
ExecutionEngine
 ↓
ExecutorRegistry
 ├── AgentExecutor
 ├── CodeExecutor
 ├── CommandExecutor
 ├── BranchExecutor
 ├── TriggerExecutor
 └── Plugin Executor
 ↓
NodeOutcome
 ↓
RunStore / Artifact Store / History
```

---

# 2. 下一阶段核心目标

## 目标 A：完成 AgentExecutor 正式化

当前缺口：

Conversation / Model 执行仍需要进一步纳入统一 Executor 体系。

计划：

- 新增正式 AgentExecutor。
- 模型调用、上下文继承、工具调用统一进入 executor lifecycle。
- 支持：
  - streaming output
  - tool calls
  - checkpoint
  - retry
  - cancellation

目标架构：

```
AgentExecutor
 ├── Provider
 ├── Model
 ├── Context Builder
 ├── Skill Resolver
 ├── Tool Resolver
 └── Output Parser
```

任务：

- EXEC-06
- RUNTIME-09

---

# 3. Runtime 第二阶段升级

## 3.1 Event Driven Runtime

当前：

```
Scheduler
 ↓
Executor
 ↓
Outcome
```

升级：

```
Runtime Event Bus
 ├── node.started
 ├── node.progress
 ├── node.output
 ├── node.failed
 ├── node.completed
 ├── workflow.paused
 └── workflow.resumed
```

收益：

- UI 实时更新。
- Debugger。
- Workflow replay。
- 外部插件监听。

任务：

- Runtime Event Contract
- Event persistence
- Event replay

---

## 3.2 Workflow Debugger

新增：

```
Run Debugger
 ├── execution timeline
 ├── node input snapshot
 ├── node output snapshot
 ├── logs
 ├── artifacts
 └── retry / replay
```

目标：达到类似开发工具调试体验。

---

# 4. Workflow 能力升级

## 4.1 Nested Workflow

目标：支持工作流组合。

示例：

```
Research Workflow
 ├── Search Workflow
 ├── Reading Workflow
 └── Writing Workflow
```

新增：

```
SubWorkflowExecutor
```

需要解决：

- 输入映射。
- 输出映射。
- 子流程状态。
- 错误传播。

任务：

- WF-07

---

## 4.2 Workflow Versioning

目标：支持：

- 保存历史版本。
- 回滚。
- 分享。
- 导入导出。

新增：

```
WorkflowVersion
 ├── schemaVersion
 ├── createdAt
 ├── author
 └── checksum
```

任务：

- WF-06
- WF-08

---

# 5. Automation 平台化

当前：Trigger 可以启动 Workflow。

下一阶段：形成完整 Automation Engine。

架构：

```
Trigger
 ↓
Automation Engine
 ↓
Workflow Instance
 ↓
Runtime
 ↓
History
```

新增：

## 5.1 Persistent Automation State

支持：

- 开机恢复。
- 启停。
- 执行历史。
- 错误恢复。

## 5.2 Webhook Gateway

新增：

```
HTTP Request
 ↓
Webhook Trigger
 ↓
Workflow
```

任务：

- AUTO-08
- AUTO-10

---

# 6. Plugin Ecosystem

目标：MCode 从内部平台变成扩展平台。

插件类型：

```
Plugin
 ├── Node Type
 ├── Executor
 ├── Skill
 ├── MCP Connector
 ├── UI Extension
 └── Workflow Template
```

新增：

## Plugin Manifest

```
plugin.json

{
 name,
 version,
 capabilities,
 executors,
 nodes,
 skills
}
```

任务：

- Plugin discovery
- Plugin sandbox
- Plugin lifecycle

---

# 7. Skill Marketplace 方向

当前：Skill 是能力描述。

未来：

```
Skill Package
 ├── metadata
 ├── prompts
 ├── tools
 ├── workflows
 ├── examples
 └── tests
```

例如：

```
Academic Research Skill
 ↓
Search
 ↓
PDF Processing
 ↓
Citation
 ↓
Writing
```

注意：

学术能力不进入 Core，而作为 Skill / Plugin / Workflow 存在。

---

# 8. 数据层升级

新增统一 Artifact System。

目标：

```
Artifact
 ├── file
 ├── directory
 ├── dataset
 ├── message
 ├── report
 └── external URI
```

能力：

- 生命周期管理。
- 引用追踪。
- 删除策略。
- 缓存。

---

# 9. 下一轮任务拆分

## PAR-F Runtime Evolution

负责：

- AgentExecutor
- Event Bus
- Runtime Debugger
- Replay

核心文件：

```
executionEngine.ts
executorRegistry.ts
runtime events
agentExecutor.ts
```

---

## PAR-G Workflow Platform

负责：

- Nested Workflow
- Versioning
- Import/Export

---

## PAR-H Automation Platform

负责：

- Webhook
- Persistent Automation
- Dashboard

---

## PAR-I Plugin Ecosystem

负责：

- Plugin manifest
- Plugin discovery
- Extension API

---

## PAR-J Observability

负责：

- Runtime Event
- Debugger
- Timeline
- Logs

---

# 10. 开发原则

继续保持：

1. Scheduler 不知道 Executor 实现。
2. Executor 不负责 Workflow 调度。
3. UI 不复制 Runtime 逻辑。
4. Skill 不进入 Core。
5. Artifact 不复制大对象。
6. Contract 使用单 Owner。
7. 所有重大修改必须有 smoke/typecheck。

---

# 11. 推荐执行顺序

```
Phase 1
 |
 AgentExecutor + Runtime Event
 |
Phase 2
 |
 Debugger + History
 |
Phase 3
 |
 Nested Workflow + Versioning
 |
Phase 4
 |
 Automation Platform
 |
Phase 5
 |
 Plugin Ecosystem
 |
Phase 6
 |
 Marketplace / Community Extension
```

---

# 12. 最终愿景

MCode 最终不是一个固定用途 Agent。

目标架构：

```
                 MCode Platform
                       |
        --------------------------------
        |              |               |
     Workflow      Automation      Plugin
        |              |               |
     Runtime       Trigger        Capability
        |              |               |
        -------- Execution Engine -----
                       |
              Agent / Code / Tool
                       |
                 User Scenario
```

核心保持稳定：

> MCode 提供执行平台，而不是限制用户只能完成某一种任务。
