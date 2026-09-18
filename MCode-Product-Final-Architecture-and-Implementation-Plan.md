# MCode 最终产品架构与实施计划

> ⚠️ **本文已废弃（2026-09-18）**：内容已被 `MCode-Architecture-Plan-v2.md` 取代（本文的产品愿景保留在 v2 §1，阶段排序已按实际进度重排）。执行事实源为 `MCode-Development-Roadmap.md`。

## 目标

MCode 的目标不是重新开发 Agent，而是基于成熟 Agent SDK（Claude Code SDK、Codex 等）构建一个完整的本地智能工作流平台。

最终产品：

> 用户描述需求，Agent 自动生成 Workflow 或 Automation，MCode 负责本地执行、文件管理、监控和长期结构化记忆。

核心闭环：

```
User Goal
   ↓
Agent SDK
   ↓
Workflow / Automation Generation
   ↓
MCode Runtime
   ↓
Local Files + Tools + Applications
   ↓
Monitoring
   ↓
Structured Memory
```

---

# 一、最终产品架构

```
MCode

├── Frontend
│   ├── Monaco Editor
│   ├── Workflow Designer
│   ├── Automation Center
│   ├── File Explorer
│   ├── Monitoring Dashboard
│   └── Memory Explorer
│
├── Core Runtime
│   ├── Workflow Engine
│   ├── Automation Engine
│   ├── Scheduler
│   ├── Event Bus
│   └── Execution Context
│
├── Agent Layer
│   ├── Claude Code SDK Adapter
│   ├── Codex Adapter
│   └── Agent Interface
│
├── Capability Layer
│   ├── Local File System
│   ├── Tool Execution
│   └── Application Control
│
├── Memory System
│   ├── Project Memory
│   ├── User Preference
│   ├── Experience
│   ├── Failure Records
│   └── Decisions
│
└── Monitoring
    ├── Logs
    ├── Metrics
    ├── Trace
    └── Execution History
```

---

# 二、前端技术路线

## Monaco Editor 集成

采用 Monaco Editor 作为核心编辑器，不直接依赖 VS Code。

原因：

- 完全控制产品 UI
- 适合 Workflow、Automation、Memory 编辑
- 后续可扩展为独立 IDE

架构：

```
React Frontend
      |
      ├── Monaco Editor
      ├── Workflow Canvas
      ├── Dashboard
      └── Panels

      |

MCode API
```

---

# 三、前端模块设计

## 1. Workspace

类似 IDE 工作区。

功能：

- 文件浏览
- 项目管理
- Agent 上下文入口

---

## 2. Workflow Designer

可视化工作流编辑。

支持：

- 节点拖拽
- 连线
- 参数配置
- 调试运行
- 保存版本

节点类型：

```
Agent Node
Tool Node
File Node
Condition Node
Output Node
```

同时支持 Monaco 编辑 Workflow YAML/JSON。

---

## 3. Automation Center

管理自动任务：

- 定时任务
- 文件变化触发
- 系统事件
- 手动执行

---

## 4. Monitoring Dashboard

展示：

- Workflow 执行过程
- Agent 调用记录
- Tool 调用记录
- 错误位置
- 系统资源

---

## 5. Memory Explorer

采用 Markdown/结构化文件方式。

支持人工检查和 Agent 维护。

---

# 四、核心代码架构

## Workflow Engine

```
Workflow Definition
        ↓
Parser
        ↓
Planner
        ↓
Runtime Engine
        ↓
Executor
```

Execution Context 保存：

- task_id
- 当前节点
- 输入输出
- 状态
- 错误信息

---

# 五、Local File System

只支持本地文件系统。

架构：

```
Agent
 ↓
File Capability
 ↓
Permission Layer
 ↓
Local File System
```

功能：

- 文件读取
- 文件写入
- 文件索引
- 文件监听
- 项目扫描

---

# 六、Memory System

参考 Claude Code AutoMemory 思路。

不使用简单上下文压缩作为长期记忆。

结构：

```
Memory

├── Rules
├── Project Facts
├── User Preference
├── Experience
├── Failures
└── Decisions
```

原则：

- 稳定规则进入配置
- 项目事实进入 Memory
- 失败经验长期保存
- 定期检查、去重、更新

流程：

```
检查
 ↓
衔接
 ↓
维护
```

---

# 七、开发阶段

## Phase 1

完成 Workflow 完整闭环。

## Phase 2

完成 Automation 系统。

## Phase 3

完成 Monaco 前端工作空间。

## Phase 4

完成 Monitoring Dashboard。

## Phase 5

完成 Memory System。

## Phase 6

产品打磨和插件扩展。

---

# 八、最终产品形态

```
                 MCode

        ┌─────────────────┐
        │ Workflow Builder │
        └─────────────────┘

        ┌─────────────────┐
        │ Monaco Workspace│
        └─────────────────┘

        ┌─────────────────┐
        │ Agent Assistant │
        └─────────────────┘

        ┌─────────────────┐
        │ Monitoring      │
        └─────────────────┘

        ┌─────────────────┐
        │ Memory          │
        └─────────────────┘

                 ↓

          MCode Runtime

                 ↓

          Local Computer
```

目标：形成一个 Agent 驱动的本地智能自动化开发环境。
