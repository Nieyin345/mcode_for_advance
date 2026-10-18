# ARC-006 WF0/EX0 —— 依赖许可审计与扩展基础设施盘点

> **这份文档是什么**：台账 2026-10-18「开源工作流生态 + VS Code 扩展兼容桥」规划里
> **WF0（依赖/许可审计）**与 **EX0（现有扩展基础设施盘点）**的交付物。
>
> **它不是什么**：不是「已经在用 React Flow / 已经兼容 VS Code 扩展」的声明。两项都
> 是规划 D，ARC-006 状态仍双空；本文只把**可复核的事实**固定下来，供后续 PoC 决策。

## 一、WF0 依赖与许可审计（E1：npm registry 实查，2026-10-18）

| 项目 | 版本（npm 实查） | 许可（`npm view` 原文） | 结论 | 约束 |
|---|---|---|---|---|
| **React Flow** | `@xyflow/react` **12.12.0**（`reactflow` 11.11.4 是旧包名） | **MIT** | **可引入**，第一优先 PoC | 固定 lockfile 与 commit；只做画布视图，不接执行语义 |
| **Node-RED** | **5.0.8** | **Apache-2.0** | 第二阶段**研究**其 flow editor/runtime | 不首期嵌入第二套 runtime；不得绕过 Mcode 权限 |
| **Temporal（TypeScript SDK）** | `temporalio` **1.9.3** | **MIT** | 暂缓 | 引入意味着独立服务集群 + 第二套 Workflow 定义，仅当现有执行器经测试不足时评估 |
| **n8n** | **2.43.7** | **`SEE LICENSE IN LICENSE.md`**（Sustainable Use License，**非 OSI 开源**） | **不作为默认内核依赖** | 任何嵌入/再分发前须针对具体用法做许可判断，不能把"源码可见/可自托管"说成开源许可 |
| **Activepieces** | **不在 npm registry**（连 `activepieces` 包都不存在；其连接器在 GitHub 仓库内按目录分发） | 核心仓库 MIT，但 pieces/企业功能需逐项核对 | 选择性复用连接器 | 须按目录逐个核对 LICENSE；不整体带入其服务栈/Worker/DB/UI |
| **Eclipse Theia (`@theia/plugin-ext`)** | **1.76.0**（`@eclipse-theia/plugin-ext` 包名不存在） | **`EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0`** | 只研究可独立拆分的 shim/RPC | **双许可且含 GPL**：在确定复用具体文件前必须由许可证审计核实传递依赖；不能整包引入前端 |

**审计方法可复核**：上表每一行的版本与许可都来自 `npm view <pkg> version license repository.url`
的原文输出（2026-10-18 实跑）。**未做的事**：未下载 tarball 逐文件核对 LICENSE/NOTICE、未做 SBOM、
未评估安全公告。那些属于锁定版本后的下一步，**不能拿这张表宣称 WF0 完成**。

**Mcode 侧的硬边界（与台账一致，逐条登记）**：

1. 画布只负责编辑体验；`orchestration/runner.ts`、`scheduler.ts`、`automationRunner.ts`、
   `workflowTrust.ts` 继续作为能力事实源，不造第二个 Agent loop / 调度器。
2. 节点合同唯一且版本化（`NodeDefinition` / `NodeExecutionContext` / `WorkflowGraph`），
   画布、预检、`app_api_*`、自动化与导入导出共用**同一个注册表**。
3. 连接器输入/输出映射到 Mcode 类型；本地路径、凭据、环境变量不得透传给第三方代码。
4. 旧工作流档案可迁移；新画布不得无声丢弃未知节点/字段。
5. AI 可以创建工作流草稿，但**创建 ≠ 执行授权**，仍走既有 trust/revision/approval。

## 二、EX0 现有扩展基础设施盘点（E1：源码实读）

### 现在的扩展模型（没有 VS Code）

| 组件 | 行数 | 职责 | 与 VS Code 兼容桥的关系 |
|---|---|---|---|
| `main/modules/ModuleHost.ts` | 614 | 校验并托管模块清单、能力执行、任务取消、工作流目标 | **原生 Extension SDK 的宿主**；兼容桥最终要落到这里 |
| `main/modules/permissionedProcessRunner.ts` | 272 | 用 Node `--permission` 在子进程执行扩展代码，按单文件放行 | 兼容桥的 Extension Host **可复用**这套隔离；但 worker_threads 不是沙箱 |
| `main/modules/service.ts` | 122 | 惰性初始化、审批端口注入、已装清单持久化 | 安装/恢复/撤销的既有入口 |
| `main/lib/extensionStore.ts` | 506 | 扩展专用键值/文件区（配额、围栏、坏档拒写） | 扩展数据的既有事实源；不得为兼容桥另开第二份 |

**能力模型**：模块声明 `query` / `action` / `task` 三类贡献，`action` 必须显式
`resource.write` 且有审批通道（`packages/contracts/src/modules.ts` 的
`missingCapabilityPermission` / `actionInvocationRefusal` 两份判定）。
**这就是兼容桥的映射目标** —— VS Code 的 `commands` 映射到 `action`/`query`，
`configuration` 映射到设置页，`tree views` 映射到 Mcode 侧栏树。

### 关键缺口（如实）

1. **零 VSIX / VS Code API 支持**：`grep -rn "vsix|vscode"` 在 `src/main` 与
   `packages/contracts` 只命中无关的忽略目录列表与一条注释。兼容桥是从零开始。
2. **没有外部扩展宿主进程**：`permissionedProcessRunner` 是**按单次调用**起子进程，
   不是长驻的 Extension Host（VS Code 扩展需要 activate/deactivate、事件订阅、
   跨调用状态）。EX2 需要的是**长驻受控宿主**，这是新工程，不是复用现有 runner。
3. **没有 `vscode` runtime shim**：`vscode.d.ts` 只是类型，行为（`workspace.getConfiguration`、
   文件事件、`OutputChannel`、`StatusBarItem`）全部需要实现。
4. **贡献点没有映射表**：`package.json` 的 `contributes.commands/menus/views/...`
   目前没有解析器，也没有到 Mcode 命令/菜单/设置的映射。
5. **MC-035 的前置仍未闭合**（台账 ARC-002 复核失败的原因）：真实生产的
   "外部用户代码审查 → 受限装载 → 注册执行 → 撤销"通路已随本轮 MC-035 切片补齐
   （安装期核验 + 能力绑定 + OS 权限隔离），但**真 Electron 三引擎 U1 未做**。

### 兼容层级（与本仓现状的对照）

| 层级 | 含义 | 现状 |
|---|---|---|
| L1 直接运行 | 原始 VSIX 无修改运行常见 API | **不可能**：零 shim、零宿主 |
| L2 自动映射 / 小补丁 | contributes 映射到 Mcode 原生 UI | **不可能**：无解析器 |
| L3 专用适配器或不支持 | 复杂 Webview/内部模块/Debug Adapter | 需要先有 L1/L2 的宿主才能谈 |

**结论**：EX0 盘点的价值是**否定了"只实现 vscode.d.ts 就宣布兼容"这条路** ——
本仓连宿主进程都还没有。EX1（原生 SDK 补全）是 EX2 的**硬前置**，而 EX1 正是
MC-035 的真实目标。**EX2–EX4 在此之前不应开工**。

## 三、WF0/EX0 之后可以立即做的（不引入依赖）

1. **WF1 画布 PoC 的前置**：把现有工作流节点类型整理成一份**可机器读的 NodeDefinition
   清单**（`nodeTypes.ts` 的 `BUILTIN_NODE_TYPES` 已有，需要补 schema/version/权限档）。
   这不依赖 React Flow。
2. **EX1 的验收网**：MC-035 的 `module-extension-lifecycle-smoke` 已覆盖安装→核验→
   隔离执行→撤销；缺的是**长驻宿主**与**三引擎发现**。前者可以在不引入 VSIX 的前提下
   先做（把 `permissionedProcessRunner` 从"每次起进程"升级为"常驻 + 按调用投递"）。
3. **许可证的下一步**：锁定 React Flow 12.12.0 的 tarball 后逐文件核对 LICENSE/NOTICE，
   产出可复用文件白名单（WF0 的正式完成条件）。

## 四、边界声明

- 本文 **D + E1**：D 是台账规划，E1 是 npm registry 与源码实读。
- **ARC-006 状态仍 `[ ]/[ ]`**：没有引入任何依赖、没有实现 Bridge、没有更换画布。
- 未做：版本锁定的逐文件许可审计、SBOM、安全公告、React Flow PoC、Theia shim 可拆分性
  研究、10 个 VSIX 兼容测试、真 Electron/三引擎 U1。
