# MCode 产品化路线规划

> 基于当前代码状态重新制定。
>
> 目标：先完成一个稳定、完整、可使用的 Agent Workflow 产品，而不是追求 Agent 自我演化。

## 1. 产品定位

MCode 不负责重新开发基础 Agent 能力。

底层 Agent 已通过 Claude Code SDK 等成熟 Agent Runtime 接入。

MCode 的职责：

- 将用户需求转化为 Workflow / Automation。
- 提供可靠执行环境。
- 管理本地文件与工具。
- 提供完整监控。
- 提供结构化长期记忆。

核心流程：

```
用户需求
  ↓
Agent (Claude Code SDK / 其他 Agent)
  ↓
生成 Workflow / Automation
  ↓
MCode Runtime 执行
  ↓
文件系统 / 工具 / 软件操作
  ↓
监控反馈
  ↓
Memory 保存
```

---

# 2. 核心系统范围

## 2.1 Workflow System

目标：支持用户自定义工作流，并支持 Agent 自动生成。

需要完善：

- Workflow Schema
- Workflow Editor
- Workflow Version
- Workflow Debug
- Workflow Import / Export

示例：

```
研究任务
 ↓
读取文件
 ↓
分析内容
 ↓
调用工具
 ↓
生成结果
```

---

## 2.2 Automation System

目标：支持自动化任务。

包括：

- 定时触发
- 文件变化触发
- 系统事件触发
- 手动触发

示例：

```
每天 9:00
 ↓
检查论文目录
 ↓
发现新文件
 ↓
自动分析
 ↓
生成摘要
```

---

## 2.3 Local File System

只支持本地文件系统。

不设计云存储依赖。

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

能力：

- 文件读取
- 文件写入
- 文件索引
- 项目目录管理
- 文件变化监听

---

## 2.4 Monitoring System

监控是产品核心能力。

覆盖：

### Workflow

- 执行状态
- 成功失败
- 执行时间
- 错误信息

### Automation

- 触发记录
- 历史执行
- 异常记录

### Runtime

- Agent 调用
- Tool 调用
- 日志
- 资源占用

最终：

```
Monitoring Dashboard

任务
运行
日志
错误
历史
资源
```

---

# 3. Memory System

采用结构化记忆思想。

不依赖简单上下文压缩。

设计：

```
Memory

├── Project Memory
├── User Preference
├── Workflow Experience
├── Failure Record
└── Decision History
```

原则：

1. 不把所有内容写入长期记忆。
2. 稳定规则进入配置文件。
3. 项目事实进入 Memory。
4. 失败经验和重要决策长期保存。
5. 定期维护、去重、更新。

类似 Claude Code AutoMemory：

- 检查
- 衔接
- 维护

---

# 4. Agent Integration

当前已经完成 Agent SDK 接入。

后续重点不是重新开发 Agent。

优化方向：

```
Agent Adapter

Claude Code SDK
Codex
Other Agent

        ↓

MCode Interface

        ↓

Runtime
```

重点：

- 上下文管理
- 工具权限
- Workflow 调用
- Memory 调用

---

# 5. 产品开发阶段

## Phase 1：Workflow 完整化

目标：

用户可以创建、修改、运行 Workflow。

---

## Phase 2：Automation 完整化

目标：

用户可以创建自动执行规则。

---

## Phase 3：File System 完善

目标：

让 Agent 安全、高效管理本地项目文件。

---

## Phase 4：Monitoring Dashboard

目标：

完整查看系统运行状态。

---

## Phase 5：Memory System

目标：

实现跨任务、跨会话的信息保持。

---

# 6. 保持扩展性的原则

未来增加：

- Multi-Agent
- Knowledge Base
- 自动优化
- 更多工具

都应该通过扩展层实现。

不要修改核心 Runtime。

架构保持：

```
                 MCode

                  |

          Workflow Runtime

                  |

--------------------------------

Workflow
Automation
File System
Monitoring
Memory
Agent Adapter

--------------------------------

        Local Execution
```

---

# 7. 当前目标

最终产品目标：

> 用户只需要描述需求，MCode 通过成熟 Agent 自动生成 Workflow 或 Automation，并可靠控制本地软件环境完成任务，同时拥有完整监控和长期记忆能力。
