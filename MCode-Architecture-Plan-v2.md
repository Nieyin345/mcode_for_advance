# MCode 架构与实施计划 v2

> **文档定位**：本文取代以下两份文档，成为产品架构层的唯一规划文档：
> - ~~MCode-Product-Final-Architecture-and-Implementation-Plan.md~~
> - ~~MCode-Architecture-Gap-Analysis-and-Refactor-Plan.md~~
>
> **执行事实源仍是 `MCode-Development-Roadmap.md`**（任务状态、文件所有权、回归基线以它为准）。本文只回答三个问题：**现状有什么、差距是什么、接下来按什么顺序做**。
>
> 基线日期：2026-09-18（第一轮并行开发 PAR-A~E 已整合，run-all-smokes 29 套件 0 失败）。

---

## 1. 产品定位与最终形态

MCode 的目标不是重新开发 Agent，而是基于成熟 Agent 引擎（Claude Code / Codex / Pi）构建**面向学术科研的本地智能工作流平台**。

核心闭环（不变）：

```
User Goal
   ↓
Agent 引擎理解需求，自动生成 Workflow / Automation
   ↓
MCode Runtime 本地执行
   ↓
Local Files + Tools + 资料库 + Applications
   ↓
Monitoring 全程可观察
   ↓
Structured Memory 长期沉淀
```

学术场景是 first-class 用户路径，不是插件后补：

- 「监听文献目录 → 检索脚本 → 模型整理 → 产物入资料库」的自动化
- 「文献检索 → 精读 → 笔记入 note 类 → 综述初稿」的工作流
- 资料库既是产物归属地，也是 Agent 的知识源（经 MCP 暴露）

**验收底线**（沿袭 Roadmap §8，也是本计划的最终门槛）：

- 不新增第二套变量 / workflow 语义
- 新增扩展点不需要回到 Scheduler 加硬编码分支
- **能从真实用户路径跑通至少一个完整场景**（当前未兑现，见 Phase 0）

---

## 2. 架构现状盘点（已建成资产，勿重复建设）

### 2.1 前端（React + Monaco，已深度集成）

| 能力 | 位置 | 状态 |
|---|---|---|
| Monaco 编辑器（主题/模型缓存/LSP/快捷键） | `renderer/lib/monacoSetup.ts`、`editorThemes.ts`、`lspProviders.ts`、`FileEditor.tsx`、IDE 面板（终端/多标签/Git diff/Git 历史） | ✅ |
| Workflow UI（编辑器/步骤卡/进度卡/artifact viewer/变量菜单） | `renderer/components/settings/workflows/`、`chat/WorkflowStepCard.tsx`、`WorkflowNodeProgressCard.tsx` | ✅（workflow-view-smoke 478 项） |
| 统一资料库 UI（左栏大类/小类/集合/提示词面板） | `renderer/components/library/`、`LibrarySections` | ✅ |
| Monitoring Dashboard / Memory Explorer / Run History 面板 | — | ❌ 缺（见差距清单） |

### 2.2 Core Runtime（全部在 `apps/desktop/src/main/orchestration/`，已收口）

```
WorkflowDoc (contracts)
      ↓
Scheduler（调度/分支/循环/resume，流程语义）
      ↓
nodeInputBuilders（唯一输入翻译层：ModelInputScope / RunnableNodeInput）
      ↓
ExecutionContext → ExecutionEngine（setDefault 兜底，分派链零 kind 分支）
      ↓
NodeExecutor Registry（command / code / conversation / 第三方）
      ↓
NodeOutcome（outputs / artifacts / execution 元数据）→ runStore
```

- 契约单一事实源：`packages/contracts`（runtime.ts / nodeType.ts / nodeTemplate.ts / capability.ts / workflow.ts / hook.ts）
- 持久化：`runStore.ts` —— sessionId ⊇ runId ⊇ nodeId 身份层级、RunState/NodeOutcome/Snapshot 职责表、快照 resume、元素级损坏加固、`runHistory()` 读模型、旧存档兼容
- 已知缺口：queued 入队事件、事件携带 runId、`input.data` 完整下发（PAR-C 提案，见 §4-G6）

### 2.3 Automation（已完成第一版目标并超额）

- cron / file / event 三种触发器 + debounce + active-run 防重入 + watcher 失效重试（`automationRunner.ts`）
- 事实状态 `automationStatus.ts`（armed / lastFireAt / lastError，内存态）
- trigger payload 形状已钉死（`payloadFactsOf`），**尚未接入变量系统**

### 2.4 Capability 模型

- `contracts/capability.ts`（zod 单一事实源 + `CAPABILITY_MODEL_VERSION`）+ `capabilityResolver.ts`（inventory / requirements / checkNodeCapabilities / describeCapabilityProblems 三类诊断）
- manifest `requirements` 声明式需求；插件 capability discovery；第三方 executor 按 `Registry.kinds()` 收编，无特判
- 缺口：scheduler 运行前 preflight 未接线；NodeInspector 配置期诊断未接线

### 2.5 资料库（本产品独有资产，旧文档完全遗漏）

- 8 内置类型（paper/textbook/note/document/slides/latex/code/image）+ 左栏大类 + collection 三层提示词注入
- `libraryServer` MCP（含 `library_download`）——资料库已是 Agent 可用知识源
- 内置模板 + 模板启动自动迁移；通用文件条目 linked/attached 双模式

### 2.6 Agent 层与扩展面

- 三引擎 adapter：claude（stream-json）/ codex（app-server JSON-RPC）/ pi
- HookRunner 事件契约（`HOOK_EVENT_OF` 编译期全覆盖），automation event trigger 与钩子共用同一份匹配语义
- 浏览器扩展桥：`providers/bridge/extensionBridge.ts` + `mcode-bridge-ext/`（Chrome/Edge 扩展，复用登录态）
- Context files（CLAUDE.md 类）已支持 —— 注意：这是**引擎上下文文件**，不是 §4-G1 的结构化记忆

### 2.7 测试纪律

`run-all-smokes` 29 套件 0 失败（scheduler 426、runtime-state 51、automation 135、capability 25、workflow-view 478、command-runner 33、code-runner 15…）。任何新模块必须带 smoke；全量回归在 Integration Gate 执行。

### 2.8 当前真实代码结构（不拆包）

```
mcode/
├── apps/desktop/
│   └── src/
│       ├── main/
│       │   ├── orchestration/   ← Workflow + Automation + Runtime 核心
│       │   ├── providers/       ← 三引擎 + bridge + MCP
│       │   ├── library/         ← 统一资料库
│       │   ├── hooks/           ← HookRunner / eventSubjects
│       │   └── ...
│       └── renderer/            ← React + Monaco + Workflow/资料库 UI
├── packages/contracts/          ← 类型契约单一事实源
└── storage/.mcode (dataRoot)    ← sessions / library / templates / workflows
```

**约束**：不新建 packages/runtime、packages/workflow 等拆包。拆包的唯一触发条件：出现第二个消费者（如 headless CLI runner）。届时只抽 orchestration 的纯函数层，契约仍走 contracts。

---

## 3. 架构图（现状修正版）

```
┌────────────────────────── Renderer (React + Monaco) ──────────────────────────┐
│  IDE/编辑器   Workflow Designer   资料库   Automation Center   Chat/步骤卡     │
│  （已有）        （已有）           （已有）   （部分，缺状态接线）      （已有）   │
│  Memory Explorer（缺）   Monitoring Dashboard（缺）   Run History（缺）        │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                   │ IPC / RuntimeEvent
┌──────────────────────────────────┴────────────────────────────────────────────┐
│ Main                                                                          │
│  providers/  claude · codex · pi · bridge(浏览器扩展) · MCP endpoints          │
│  orchestration/  scheduler → nodeInputBuilders → executionEngine → executors   │
│                  automationRunner(事实状态) · runStore(快照/resume/history)     │
│                  nodeTypes(manifest registry) · capabilityResolver             │
│  library/    kindRegistry · fileImport · libraryServer(MCP)                    │
│  hooks/      HookRunner · eventSubjects（事件契约单一来源）                     │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                   │
                    contracts/（类型契约） + .mcode dataRoot（本地存储）
```

---

## 4. 差距清单（真缺口，每条挂任务号）

| 编号 | 差距 | 对应任务 | 优先级 |
|---|---|---|---|
| G1 | **结构化 Memory System**（rules/project/preferences/experiences/failures/decisions，文件化存储 + 检索注入 + 维护回路） | 新增 MEM-01~03（建议纳入 Roadmap §3） | 高 |
| G2 | **端到端真实场景验证**：真实 app 跑通一条完整学术工作流/自动化 | 本计划 Phase 0 Gate | 最高 |
| G3 | **UI 消费层收口**：automation 事实状态接管理页（IPC 通道）、Run History 面板、queued 状态展示 | UI-08 / UI-09 / RUNTIME-08 部分 | 高 |
| G4 | **变量闭环**：trigger payload 进变量系统（VAR-06）、事件带 runId、`input.data` 完整下发、queued 事件 | AUTO-10 / VAR-06 / RUNTIME-08 + PAR-C 提案 | 高 |
| G5 | **Capability 接线**：scheduler 运行前 preflight + NodeInspector 配置期诊断消费 `resolveCapabilities`/`describeCapabilityProblems` | RUNTIME-05 后续 / PAR-E 提案 | 中 |
| G6 | **Monitoring Dashboard**：基于 RuntimeEvent + runHistory 的聚合 collector 与可视化 | RUNTIME-09 + 新增 UI 任务 | 中 |
| G7 | **Workflow 生成闭环**：schemaVersion / import-export / validation report（Agent 生成工作流的质量闸门） | WF-05 / WF-06 / WF-08 / WF-09 | 中 |
| G8 | **File indexer**：项目/资料库索引与搜索（watcher、permission 已有） | 新增建议 FS-01 | 中 |
| G9 | **学术能力抽离**：文献检索/下载/转录从 core 迁出为 skill/plugin/workflow | CAP-07 | 低（依赖 G2） |

---

## 5. 设计原则（沿袭并强化）

1. **单一事实源**：契约只写 contracts；事件语义只认 `HOOK_EVENT_OF`；变量/模板 parser 只有一套（renderer 严禁复制 nodeTemplate 解析）。
2. **不建第二套**：权限复用 workflow capability 体系（exec/read/approval），不另建 Permission Layer；监控复用 RuntimeEvent，不另建 Event Bus；Memory 复用 .mcode dataRoot 与资料库存储，不另起存储层。
3. **Memory 与 Session 分层**：sessions 是原始记录（已存在），Memory 是蒸馏层（长期有效信息/失败经验/决策），二者不混存；Memory 文件人工可改，Agent 维护需留痕。
4. **并行开发纪律**：文件所有权 + Interface Proposal 协议 + Integration Gate，照 Roadmap §12 执行；单轮并行不超过 5 路，先锁边界再加功能。
5. **smoke 先行**：新模块必须带 headless smoke 才能合入；全量回归是整合门硬门槛。

---

## 6. 实施阶段（重排后）

> 旧文档的 Phase 1~2（Runtime/Workflow/Automation 闭环）已基本完成，整体顺序据此重排。

### Phase 0 — 端到端真实场景试跑（G2，最高优先级）

- 在真实 app 里跑通至少一条完整路径（建议：定时/文件监听 → 命令节点跑检索脚本 → 模型节点整理 → 产物入资料库）
- 暴露的卡点直接转为下一轮任务清单；**未过此 Gate 前不开新的大规模并行**
- DoD：一次真实运行全绿 + 暴露问题全部立卡

### Phase 1 — 消费层与变量闭环（G3 + G4）✅ DONE（2026-09-18 第二轮并行）

- automation 事实状态 IPC 通道（`automation:status/statusAll`）→ 管理页展示 enabled/armed/lastError ✅
- Run History 面板（消费 `runHistory()`）；queued 入队事件 + 事件补 runId ✅
- `startWorkflowRun` entry 增加 `payload?: TriggerPayload` → VAR-06 变量系统消费 ✅（`{{trigger.*}}` 名字空间，scheduler 预展开，见 Roadmap §14 修复记录 1）
- DoD：触发器携带的数据能在下游节点参数里选值；run 历史可在 UI 完整回看 ✅

### Phase 2 — Memory System（G1）✅ DONE（2026-09-18 第二轮并行）

- MEM-01 存储：`dataRoot/memory/<category>/` 文件化（rules/project/preferences/experiences/failures/decisions），markdown + frontmatter ✅
- MEM-02 检索注入：经 `nodeInputBuilders` 的 context 注入机制进入节点输入（`params.memory` 开关，不进 prompt 硬编码）✅
- MEM-03 维护回路：maintenance 纯函数（过期/去重建议）+ `api.memory.*` 人工可改 ✅
- DoD：跨会话的失败经验能影响下一次同类任务的节点输入；smoke 覆盖注入与维护 ✅（memory-smoke 60/60）

### Phase 3 — Monitoring Dashboard（G6）✅ DONE（2026-09-18 第二轮并行）

- collector 聚合 RuntimeEvent + runHistory，NDJSON 持久化走 dataRoot ✅
- Dashboard 面板（MonitoringPanel 挂 SettingsPage）：workflow 执行过程、run 汇总、错误定位、系统状态 ✅
- DoD：一次真实 run 可在 Dashboard 完整回放 ✅（monitoring-smoke 29/29；RUNTIME-09 调试信息统一仍 WIP）

### Phase 4 — Workflow 生成闭环 + Monaco 工作空间打磨（G7）◐ 部分完成（2026-09-18 第二轮并行）

- WF-09 validation report（13 个错误码，Agent 生成质量闸门，library.ts 三路保存汇合点全部接入）✅
- WF-05/06/08：input/output schema、schemaVersion 兼容规则、import/export ✅
- Monaco 侧：Workflow YAML/JSON 编辑（schema 提示/校验），Memory 文件编辑 ⬜ 未动
- DoD：Agent 生成的 workflow 必须通过 validation 才能保存/执行 ✅

### Phase 5 — 学术能力抽离 + 插件生态（G9，可选并行）

- CAP-07：文献检索/下载/转录从 core 迁出为 skill/plugin/workflow
- 真实第三方插件验证（CAP-08 从 mock 到真机）、File indexer（G8）
- DoD：core 无学术专有逻辑；第三方 skill 安装即用

---

## 7. 与旧文档的映射

| 旧文档内容 | 处置 |
|---|---|
| 产品愿景 / 核心闭环（§0/最终目标） | 保留，§1 |
| Monaco/Workflow/Automation/Memory/监控 前端模块设计 | 「已建成」部分并入 §2 现状盘点；缺口并入 §4 差距清单 |
| packages/runtime 等拆包方案 | 废弃，改为 §2.8 拆包约束 |
| Node/Workflow 数据结构草案 | 废弃，以 contracts 现有 WorkflowDoc/manifest 为准 |
| Automation 第一版范围 | 已完成，转入 §2.3 现状 |
| Memory 结构与原则 | 保留，强化为 §5.3 分层原则 + Phase 2 |
| Monitoring 架构 | Event Bus 部分删除（已存在），collector/Dashboard 进 Phase 3 |
| File System（含 indexer/permission） | permission 已有（capability 体系）；indexer 进 §4-G8 |
| Agent Adapter（仅 Claude/Codex） | 更正为三引擎 + bridge + MCP，见 §2.6 |

---

## 8. 最终产品形态

```
                 MCode（学术科研工作台）

        ┌────────────────────────────────┐
        │ IDE / Monaco Workspace          │ ← 已有
        ├────────────────────────────────┤
        │ Workflow Designer + Automation  │ ← 已有，Phase 1 收口
        ├────────────────────────────────┤
        │ 资料库（知识源 + 产物归属地）      │ ← 已有
        ├────────────────────────────────┤
        │ Agent Assistant（三引擎 + 生成）  │ ← 已有，Phase 4 加质量闸门
        ├────────────────────────────────┤
        │ Monitoring Dashboard            │ ← Phase 3
        ├────────────────────────────────┤
        │ Memory Explorer                 │ ← Phase 2
        └────────────────────────────────┘
                      ↓
              MCode Runtime（已收口）
                      ↓
              Local Computer（文件/资料库/应用）
```

用户描述需求 → Agent 生成带校验的 Workflow → Runtime 本地执行 → 全程可观察 → 经验沉淀进 Memory，形成完整的 Agent 工作环境。
