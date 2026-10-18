# MERGE-0 基线交付物 —— Mcode 节点/触发器/数据合同 ↔ Node-RED 逐项映射

> **这份文档是什么**：台账 ARC-006「用户最终架构更正（Node-RED 为唯一工作流内核，
> 深度合并）」里 **MERGE-0** 的交付物。MERGE-0 的验收门是：
> 「无损迁移矩阵与未知语义清单，双引擎现状有可复现基线，不碰真用户资料」。
> 本文只交付**矩阵与清单**，不声称任何迁移已发生。
>
> **它不是什么**：不是「Node-RED 已合并」的声明，也不是最终映射的设计定稿。
> 每一行的「Node-RED 侧对应」都标了**证据强度**：
> `官方` = Node-RED 文档/API 明确支持；`需适配` = 要用自定义节点或 Host RPC 才能等价；
> `无对应` = 必须由 Mcode Host Services 承担，Node-RED 原生没有这个概念。
>
> 取证：Mcode HEAD `bccec2ed`（本文件提交前），Node-RED 5.0.8（npm 实查，Apache-2.0）。
> 真实用户资料、真实 Node-RED 进程均未改动。

## 一、执行模型映射（runner.kind → Node-RED）

Mcode 的节点执行由 `NodeRunnerSchema`（`packages/contracts/src/nodeType.ts:650-780`）
的判别联合决定，共 7 种 kind。Node-RED 侧是「节点类型 + 消息流」模型。

| Mcode runner.kind | 语义 | Node-RED 侧对应 | 强度 | 迁移要点 |
|---|---|---|---|---|
| `prompt` | 子 agent，独立会话跑一轮模型 | 自定义节点 `mcode-agent`（Node 内部经 Host RPC 调三 SDK） | 需适配 | Agent 会话身份、取消、超时、重试分类留在宿主；Node 只持 runId |
| `conversation` | 跑在主对话里（主代理 / 对话节点） | 自定义节点 `mcode-conversation` | 需适配 | **关键约束**：必须复用同一主对话回合通道；Node-RED 消息流没有「用户正在看的那个对话」概念 |
| `branch` | 分支/人工选择 | 自定义节点 `mcode-branch` + Node-RED 多输出端口 | 需适配 | 分支结果是**运行时**的边选择，不是静态图；Node-RED 的 switch 节点语义可承载，但人工选择需挂起等待 |
| `condition` | 纯条件真假出边 | Node-RED 原生 `switch` 节点 | 官方 | 无模型调用、无进程；直接映射，注意「不可作为环的人工闸门」语义要保留 |
| `trigger` | 触发器（定时/事件） | Node-RED 原生 `inject` / `cron-plus` 类节点 + `mcode-cron`/`mcode-file-watch`/`mcode-app-event` | 官方+需适配 | **唯一执行 owner** 是 MERGE-3 的硬门：切换前同一定时不能在两侧同时触发 |
| `command` | 两种形态：内置 shell 命令 / 清单自带脚本（entry） | Node-RED 原生 `exec` 节点（shell 形态）；`mcode-command-entry`（entry 形态） | 官方+需适配 | entry 形态的清单相对路径围栏、`bind` 参数（arg/env/stdin）、非零退出仍 success 的语义必须原样保留 |
| `code` | python/node/shell/powershell 代码块 | Node-RED `function` 节点（JS）+ `exec`（其它语言） | 需适配 | **语言面不等价**：Node-RED function 只跑 JS；python/shell/powershell 需经 exec 子进程，超时/取消语义要重做 |

**未知语义清单（必须在实施前裁决，不能猜）**：

1. **`conversation` 的「主对话」身份**：Node-RED flow 由运行时触发时，不存在「用户
   此刻正在看的对话」。是每次运行绑定一个会话 id，还是禁止后台触发 conversation
   节点？台账未裁决——这是 MERGE-2 前必须由人决定的产品问题。
2. **`branch` 的人工选择挂起**：Mcode 的 branch 可以等真人回应（长任务存档 + 恢复）。
   Node-RED 的消息流默认不持久化「等待中」状态；需要 `mcode-approval` 节点 + 宿主
   durable journal 才能等价（见第四节）。
3. **`code` 的语言面**：Node-RED function 节点是 JS；迁移后「node」可直跑，「python /
   shell / powershell」必须经 `exec`，其沙箱面**与 Node-RED function 不同**，不能当作
   「同一个 code 节点」宣称等价。
4. **非零退出仍 success**：Mcode 的 command 节点语义（`entryRunner` / `commandRunner`）
   是「进程跑完就算成功，退出码进产物」。Node-RED `exec` 默认把非零退出当错误。迁移
   时必须显式翻转，否则旧图行为全变。

## 二、数据与版本合同映射

| Mcode 合同 | 位置 | Node-RED 侧对应 | 强度 | 迁移要点 |
|---|---|---|---|---|
| `WorkflowDoc`（nodes/edges/schemaVersion） | `packages/contracts/src/workflow.ts` | flow JSON（`flows.json` 的 nodes/links） | 需适配 | 字段名、端口模型、边语义都不同；需要**一次性的、可回滚的**迁移器 + 迁移报告，不是长期双写 |
| `NodeTypeCatalog` / `NodeTypeManifest` | `main/orchestration/nodeTypes.ts`、`contracts/nodeType.ts` | Node-RED 节点注册表（`nodes` 目录 + runtime registry） | 需适配 | 画布 palette、预检、`app_api_*`、自动化必须读**同一份**注册表；不能画布一套、Agent 一套 |
| 未知字段保全（`mergeUnknownWorkflowFields`） | `contracts/workflow.ts` | Node-RED flow 的未知属性默认保留 | 官方（近似） | 方向相反：Mcode 要**主动**保全未知字段，Node-RED 默认透传；迁移器要把两边都钉住，避免切换时丢字节 |
| `workflowTrust`（AI/导入工作流的修订版审查） | `main/orchestration/workflowTrust.ts` | 无对应 | 无对应 | 必须由 Host Services 承担；Node-RED 的 Deploy 不能绕过真人审查 |
| revision/CAS（工作流保存） | `main/ipc/orchestration.ts` 等 | Storage API 自定义 storageModule | 需适配 | 用自定义 storageModule 落 Mcode 的 revision 语义；MERGE-1 的硬门是「UI 与 Agent 改同一 flow 不丢字节」 |
| `runStore` / 运行历史 | `main/orchestration/runStore.ts` | 无对应（Node-RED 有 debug 侧栏，不是持久运行账本） | 无对应 | 保留 Mcode 的 runStore，经运行事件映射写入；不能在 Node-RED 侧另立一套 |
| `operation ledger` / 幂等 | `main/appControl/` | 无对应 | 无对应 | 所有经 Host RPC 的副作用调用继续走 appControl 账本 |

## 三、触发器与自动化映射

| Mcode 触发器 | 位置 | Node-RED 侧对应 | 强度 | 迁移要点 |
|---|---|---|---|---|
| 工作流触发（手动/对话入口） | `scheduler.ts` | inject / 自定义入口节点 | 官方+需适配 | 对话入口不是 Node-RED 概念；需要 `mcode-conversation` |
| 自动化守望（定时/事件） | `main/automation/automationRunner.ts` | inject、cron、自定义 file-watch 节点 | 官方+需适配 | **双触发是 MERGE-3 的头号风险**：切换期必须有「同一 flow 只有一位 executor owner」的检测 |
| 文件监听 | `automationRunner` 的 fs.watch 路径 | 无原生（社区有 file-watch 节点） | 需适配 | 社区节点的许可/质量需逐个审计（MERGE-4）；或自写 `mcode-file-watch` |
| Hook 事件 | `main/hooks/HookRunner.ts` | 自定义 `mcode-hook-event` 节点 | 需适配 | Hook 的授权复核、去抖、审计留在 HookRunner；Node 只是订阅者 |
| 应用事件（会话/任务状态） | 事件总线 | 自定义 `mcode-app-event` 节点 | 需适配 | 事件去重语义留在宿主 |

## 四、崩溃恢复与审批（MERGE-3 前置事实）

| Mcode 能力 | 位置 | Node-RED 默认行为 | 缺口 |
|---|---|---|---|
| 崩溃续跑 / 只执行未完成步 | `sceneDeploy`、`runStore`、`renderer/lib/workflowLive.ts` | 消息流不持久化「已完成哪一步」 | 必须保留 Mcode 的 durable journal；Node-RED 运行事件只作为**输入**，不是真相 |
| 人工审批挂起（等待真人） | `appControl` 审批端口、`PlanApprovalBar` | 无对应（Node-RED 有 `catch`/`status`，不是审批） | `mcode-ask` / `mcode-approval` 节点必须挂起在宿主，Node-RED 侧只看到「等待中」状态 |
| 副作用精确一次 | `channelIdempotency`、operation ledger | 无对应 | 幂等键由宿主签发；Node 不得自报 idempotencyKey |
| 取消/超时传播 | `SceneTaskRegistry`、`spawnRun` | Node-RED 有节点级 catch，无父子取消传播 | 父子任务治理留在宿主 |

## 五、权限与安全边界（MERGE-0 已可固定的硬事实）

1. **Node-RED Function 节点与社区 npm 节点可执行任意 JS**，可联网、可读文件。
   仅把 HTTP 服务绑回环端口**不能**防本机其它进程或恶意节点越权（台账已写明）。
2. Mcode 现有的进程内网络拦截（`permissionedProcessRunner` 的 `NETWORK_GUARD`）**不是
   OS 沙箱**；Node-RED 运行时是**长驻进程**，不能沿用「每次调用起一个受限子进程」的模型。
   MERGE-4 之前必须裁决：是给 Node-RED 进程套 OS 级限制（AppContainer/seccomp/受限代理），
   还是禁止未审计节点出网。**这是 MERGE-0 交付的未知语义清单第 5 条，不是本文能裁决的。**
3. `mcode-app` 是进程内 SDK MCP server，外部进程连不上；Node-RED → Mcode 必须经
   **受认证窄 RPC / stdio MCP 代理**（见 `docs/planning/arc-006-wf-integration.md` 桥 2 修订），
   不能新开无审批通道。
4. 节点安装 = 装可执行代码：必须映射成 danger 级逐次真人审批（MC-035 的边界）。

## 六、可复现基线（当前双引擎现状）

| 项 | 命令 | 当前结果 |
|---|---|---|
| 工作流引擎运行时状态机 | `bash apps/desktop/scripts/workflow-engine-runtime-smoke/run.sh` | 通过（42 断言，含真端口分配） |
| 桥 1（Mcode → Node-RED HTTP-in） | `bash apps/desktop/scripts/workflow-engine-bridge-smoke/run.sh` | 通过（26 断言） |
| 真 Electron 引擎宿主 | `bash apps/desktop/scripts/workflow-engine-electron-smoke/run.sh` | 通过（14 断言） |
| 节点执行/路由/扩展缝 | `node apps/desktop/scripts/run-smokes.mjs execution-engine-smoke workflow-extension-seams-smoke` | 通过 |
| Node-RED 真进程（NR0） | 见 `docs/planning/arc-006-wf-integration.md` NR0 记录 | 已实测 5.0.8 可起、可读 flows.json、编辑器页可加载 |

**这批基线证明的是「当前双引擎状态可复现」，不是「迁移安全」。** MERGE-1 起每阶段
必须另立门（台账表格），且真实 Electron + 三 SDK U1 未做。

## 七、MERGE-0 未完成项（如实）

- **上游补丁队列**：还没有 fork 目录与 patch 队列；`node-red` 未进依赖。
- **逐字段无损迁移矩阵**：本文是**类别级**映射；`WorkflowDoc.nodes[]` 的每个字段
  （params/io/capability/retry/...）与 Node-RED node 属性的逐项对照表尚未做。
- **未知语义的裁决**：第一节列了 4 条、第五节列了 1 条，都需要产品决策，本文只登记。
- **不碰真用户资料**：本轮只读源码，未启动任何使用真实数据根的进程。
