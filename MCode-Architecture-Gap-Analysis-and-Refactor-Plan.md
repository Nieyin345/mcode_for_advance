# MCode 最终产品架构差距分析与重构实施计划

> ⚠️ **本文已废弃（2026-09-18）**：内容已被 `MCode-Architecture-Plan-v2.md` 取代（本文写作时低估了已建成部分——Runtime/Workflow/Automation/Monaco 均已实现；packages 拆包方案已废弃）。执行事实源为 `MCode-Development-Roadmap.md`。

## 0. 分析目标

根据当前代码目录，对照最终产品架构：

- Monaco 前端工作空间
- Workflow Engine
- Automation Engine
- Local File System
- Monitoring System
- Structured Memory
- Claude Code SDK Agent Adapter

进行架构检查，并制定具体代码改造计划。

---

# 1. 当前代码状态检查

## 当前已有基础

当前仓库已经具备产品化基础：

```
mcode
├── apps
│   └── desktop
│       └── Electron Desktop 应用
│
├── packages
│   └── contracts
│       └── 类型契约层
│
├── docs
├── prototypes
└── cask
```

说明：

当前不是从零开发，而是在已有 Electron 桌面框架上扩展。

---

# 2. 与最终架构对照

## 2.1 Frontend Layer

目标：

```
React
+
Monaco Editor
+
Workflow Designer
+
Dashboard
```

当前：

已有：

- Electron
- Renderer
- Preload
- Main Process

缺少：

- Monaco 集成层
- Workflow UI
- Automation UI
- Memory UI
- Monitoring UI

改造：

新增：

```
apps/desktop/src/renderer/

├── editor/
│   └── Monaco 集成
│
├── workflow/
│   ├── canvas
│   ├── nodes
│   └── designer
│
├── automation/
│
├── monitoring/
│
├── memory/
│
└── file-explorer/
```

---

# 3. Core Runtime 架构补充

当前需要进一步确认和整理 Runtime 边界。

目标：

```
Workflow Definition
        |
        v
Workflow Engine
        |
        v
Execution Context
        |
        v
Executor
        |
        v
Capability
```

新增模块：

```
packages/runtime

├── workflow-engine
├── execution-context
├── executor
├── event-bus
└── state-manager
```

---

# 4. Workflow System 重构计划

目标：支持：

1. 用户手动创建
2. Agent 自动生成
3. 可视化编辑
4. 文件保存
5. 执行记录

数据结构：

```typescript
Workflow {
 id
 name
 nodes
 edges
 variables
 metadata
}
```

Node：

```typescript
Node {
 id
 type
 config
 executor
}
```

节点类型：

```
AgentNode
ToolNode
FileNode
ConditionNode
OutputNode
```

新增：

```
packages/workflow
```

---

# 5. Automation Engine 添加计划

目标：

Workflow + Trigger。

架构：

```
Trigger
  |
Scheduler
  |
Workflow Launcher
  |
Runtime
```

新增：

```
packages/automation

├── scheduler
├── triggers
├── jobs
└── history
```

第一版支持：

- 手动触发
- Cron 定时
- 本地文件变化触发

---

# 6. Local File System 设计

范围限制：

只支持本地文件。

不加入云存储。

架构：

```
File Service
     |
     |
Local File Adapter
     |
Filesystem
```

新增：

```
packages/filesystem

├── manager
├── watcher
├── indexer
└── permission
```

功能：

- 文件读取
- 文件写入
- 文件搜索
- 文件监听
- 项目索引

---

# 7. Agent SDK 接入优化

当前方向：

Claude Code SDK 已经完成。

不重新开发 Agent。

只优化 Adapter。

架构：

```
MCode Agent Interface
          |
----------------------
Claude Adapter
Codex Adapter
Other Adapter
```

新增：

```
packages/agent

├── interface
├── claude
├── codex
└── context
```

负责：

- Context 注入
- Tool 权限
- Workflow 调用
- Memory 调用

---

# 8. Memory System 添加计划

采用结构化 AutoMemory 思路。

目录：

```
.mcode/memory/

├── rules
├── project
├── preferences
├── experiences
├── failures
└── decisions
```

新增：

```
packages/memory

├── storage
├── retrieval
├── maintenance
└── index
```

原则：

- 不保存全部聊天
- 保存长期有效信息
- 保存失败经验
- 支持人工修改

---

# 9. Monitoring System

目标：完整可视化运行状态。

架构：

```
Runtime
 |
Event Bus
 |
Monitor Collector
 |
Storage
 |
Dashboard
```

新增：

```
packages/monitoring

├── logger
├── metrics
├── trace
└── storage
```

监控：

- Workflow执行
- Agent调用
- Tool调用
- 错误
- 系统状态

---

# 10. 最终代码结构目标

```
mcode

├── apps
│   └── desktop
│       └── Monaco + React UI
│
├── packages
│
│   ├── runtime
│   ├── workflow
│   ├── automation
│   ├── filesystem
│   ├── agent
│   ├── memory
│   ├── monitoring
│   └── contracts
│
└── storage
    └── .mcode
```

---

# 11. 实施顺序

## Phase 1

整理 Core Runtime 边界。

完成：

- contracts
- execution context
- event bus

---

## Phase 2

Workflow 产品化。

完成：

- Schema
- Designer
- Executor
- History

---

## Phase 3

Monaco 前端。

完成：

- Editor
- YAML/JSON workflow
- Memory 编辑

---

## Phase 4

Automation。

完成：

- Scheduler
- Trigger
- Job管理

---

## Phase 5

Local File System。

完成：

- Index
- Watcher
- Permission

---

## Phase 6

Monitoring + Memory。

完成最终产品闭环。

---

# 最终目标

用户只需要描述需求：

```
帮我分析这个项目并生成报告
```

MCode：

1. Claude Code SDK 理解需求
2. 自动生成 Workflow
3. 调用本地文件系统
4. 执行任务
5. 全程监控
6. 保存结构化记忆

最终形成完整 Agent 工作环境。
