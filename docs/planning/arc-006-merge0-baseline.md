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


## 八、FULL-0 补充：按真实 Schema 与迁移器逐字段对照（2026-10-20）

> 这张表补足此前 MERGE-0 只有 runner/category 级映射的缺口。证据取自
> `packages/contracts/src/workflow.ts` 的 `WorkflowDocSchema` /
> `WorkflowNodeSchema` / `WorkflowEdgeSchema` 与
> `apps/desktop/src/main/workflowEngines/flowMigration.ts` 的
> `migrateWorkflowDoc`、`flowToWorkflowDoc`；后者是对**原版 Node-RED
> nodes[]/wires[] 的 L2 窄适配**，绝不是自造编辑器或独立执行内核。
> 表内“已有映射”只代表源码实现，不代表可在真实原厂画布中无损编辑或通过 U1。

| 原始 WorkflowDoc 字段 | 迁往原版 Node-RED 的真实位置 / 当前方向 | 编辑器修改后读回 / 边界 | FULL-2/MERGE-0 判定 |
| --- | --- | --- | --- |
| `id` | `flow.x-mcode.docId`，并克隆在 tab 的 `x-mcode.docId`；native `flow.id/tab.id` 是折叠独立 ID | `flowToWorkflowDoc` 以原 docId 恢复；未标的外来流用 native id | L2 已接，宿主 CAS/身份不可由 native id 猜 |
| `name` | `flow.label`、tab 的原生 `label`，另 `tab.x-mcode.name` 存原值 | **原版 tab label 的用户修改优先**于旧元数据；不能用 sidecar 覆盖名字 | L1 原版编辑属性，L2 对齐 |
| `description` | `tab.x-mcode.description` | 原版没有等价工作流字段；sidecar 回写 | L2 暂存，Host/UI 语义待联 |
| `icon` | `tab.x-mcode.icon` | 原版无等价工作流图标属性 | L2 暂存 |
| `prompt` | `tab.x-mcode.prompt` | 原版 Node-RED 无 Mcode 内置 prompt-workflow 执行语义 | L2 暂存；MERGE-2 专有 Agent Node 待集成 |
| `frameworkNote` | `tab.x-mcode.frameworkNote` | 原版无 Agent 框架追加说明 | L2 暂存，Host Prompt 继续唯一负责 |
| `trigger` | `tab.x-mcode.trigger` | 顶层 `trigger` 值不等于已经部署 inject/watch，需核节点的 `runner.kind=trigger` | MERGE-3 切旧触发时必须单 owner |
| `schemaVersion` | `tab.x-mcode.schemaVersion` | 这是 Mcode 导入/导出的版本，不是 Node-RED runtime 版本 | L2 暂存，Host 独立审核 |
| `inputSchema` / `outputSchema` | `tab.x-mcode.inputSchema/outputSchema` | 原版没有通用工作流契约执行器 | L2 暂存，执行前 Host 验证待集成 |
| `builtin` | `tab.x-mcode.builtin` | 原版 tab 的 `disabled` 不表示 Mcode 内置/授权 | L2 暂存，保留 Host 的审批与来源身份 |
| `updatedAt` | `tab.x-mcode.updatedAt` | 原版编辑后的真实 revision 须由 storage CAS 重新计算，不能信旧时间戳 | MERGE-1/Host CAS 必须接实测 |
| `nodes[]` | Node-RED `nodes[]` + 所属 `tab`，所有普通节点带 `z=tab.id` | 真 GET /flows 以节点数组为真相；tab 本身不能变成 Mcode Node | L1 原生容器已映射 |
| `nodes[].id` | 原生 `node.id` 为消冲突的折叠 ID；原值在 `node.x-mcode.nodeId` | 原厂复制节点也会复制 unknown metadata，**必须根据新 native id 分离重复身份** | L2 修复后窄测试，真画布 U1 待做 |
| `nodes[].type` | 原生 `node.type` 选 switch/exec/inject/watch/原生或定制 Node；原类型在 `x-mcode.type` | 直接编辑或原生 palette 变化不能让旧 sidecar 偷偷恢复成另一执行器 | MERGE-2 仍需逐类型等价/许可检验 |
| `nodes[].title` | Node-RED 原生 `node.name`，历史值留 `x-mcode.title` | 原版 node.name 用户改动优先；原生未知节点可保留 type | L1/L2 已有读回规则 |
| `nodes[].params` | `node.x-mcode.params` 保留 Mcode 专有参数；当前已把自定义节点表单字段及原生 exec/function/inject/watch 对应字段同步到顶层配置 | 已映射字段由原生属性表单作回读事实源，显式空串清除旧值；未映射字段继续保留 sidecar 并在可识别时报告 loss | L2 窄映射通过 20 项专项，**其余参数与运行契约仍未等价** |
| `nodes[].capability` | `node.x-mcode.capability` | Node-RED 原生没有 Mcode 审批级别字段；绝不据原生 flow 自授权 | L2 Host-only，MERGE-3/4 审批硬门 |
| `nodes[].position.x/y` | Node-RED 原生 `node.x/y` 整数 + `x-mcode.position` 原始数值 | 当原生编辑器位置偏离原折叠整数时，以**编辑后的原生坐标**为准；往返小数舍入报 lossy | L1 画布坐标 + L2 浮点留存 |
| `nodes[].position.`未知键 | `node.x-mcode.unknownPosition` | 通过 `unknownWorkflowFieldPaths` 判据收集 | L2 保留，仅 sidecar |
| `edges[].id` | Mcode `flow.links[].x-mcode-edge.edgeId` 加源节点 `node.x-mcode.edgeMeta[].edgeId` 的只读注释副本；原生连接**没有独立边 ID** | native `nodes[].wires` 读回时，只有 source native id + port + target 完全一致才还原注释；不匹配的连线产生新身份，重复 ID 用 native 元组稳定消冲突 | L2 窄保全；**未确认原版 editor-client 全部编辑命令保留未知 metadata** |
| `edges[].from/to` | 原生源节点 `wires[port][]` 中的目标 native ID；旧 `links` 为注释 sidecar | `links` 与 wires 多重集不同时必须按**原厂 wires**重建，避免 sidecar 覆盖画布用户改连线 | L1 原生 wires 是单一事实源 |
| `edges[].label` / `note` | `flow.links[].x-mcode-edge` 与源节点内嵌 `x-mcode.edgeMeta` 注释；这不是原生 wires 属性 | 非复制且原生 connection 三元组未变时，可从原版 `nodes[]` 形状恢复旧标签/备注；复制的旧 source native id 不匹配或重新连线时**不沿用旧注释** | L2 部分保全，真实 editor-client U1 / 断链提示与独立注释存储仍未完成 |
| 文档/节点/边其他未知字段 | 依 `unknownWorkflowFieldPaths` 分层收集到 `tab.x-mcode.unknown`、`node.x-mcode.unknown`、`x-mcode-edge.unknown` | 不认识的语义保留字节，但不自动取得 Node-RED 执行/编辑等价 | MERGE-0 安全报告，MERGE-2 后续审 |
| `edges[]` 数组顺序、branch 选择 | `sourcePort` 为 branch 出边顺序；condition true/false 映射端口0/1 | 原生 wires 没有边元数据；真人分支等待与取消语义未实现 | MERGE-3 需宿主 durable journal |

### 这一版尚不能放行的真实差距

1. **原版 Node-RED 的 `wires` 不承载边的 label/note/未知字段**，`flow.links` 也不是原厂存储格式。现在 L2 迁移器把旧边注释额外挂在**源 native 节点**的 `x-mcode.edgeMeta` 上，严格绑定 source native id / output port / target native id；模拟真实 GET /flows 的纯 `nodes[]` 回读可恢复未改连线的注释，改线或复制节点则不能继承不匹配的旧注释。**仍未实证原版 editor-client GUI 的所有编辑/保存操作都保留该未知字段**，也未完成对有意识改线后丢失注释的可见冲突报告与 Host 双对象原子存储；不能据此宣布 FULL-2 无损或整包 MERGE-0 通过。
2. **`params` 已补上部分双向映射，但不能宣称全部等价**：mcode-agent/conversation/branch/trigger/module-capability/node-red-call 表单字段、command.exec、code.function/exec、inject.crontab、watch.files 已从原生字段正向初始化并反向读回；原生字段清空不会被旧 sidecar 覆盖。Node-RED 5.0.8 的 exec.timer/function.timeout 单位是秒，已与 Mcode timeoutMs 毫秒互换；exec 三路输出槽位保持完整。`code.input` 无等价原生 stdin/input-template，code/command 输出对象也与原生消息契约不同，现均明确列 loss。condition.expression、触发器事件过滤/防抖/项目、代码沙箱、命令非零退出、branch 真人挂起仍须 Host/正式语义裁决，不能把已映射字段当作全参数等价。
3. **单一 revision/执行 owner/U1 未通过**：继续按 MERGE-1～5 使用原生 storageModule、
   Host CAS、真人授权与官方运行时；禁止把本表和纯函数 smoke 绿灯算作原生画布完全迁移。
4. Node-RED 原版行为的实证入口依已有 `node-red-e2e-smoke`、`flow-migration-smoke` 与新增 `flow-migration-identity-smoke` / `flow-native-param-smoke`；新专项只测原版 native 配置形状的 L2 窄适配，不能替代原厂 editor-client 实际复制/保存后的浏览器 U1。

## 九、FULL-2 补充：原生属性面板参数双向同步与 Node-RED 单位合同（2026-10-20）

> 证据来自生产 flowMigration.ts、原版 Node-RED 5.0.8 安装树
> apps/desktop/.tmp/nr-e2e/workflow-engines/node-red/node_modules/@node-red/nodes/core/function/90-exec.js
> 和 10-function.js，以及新建的独立 flow-native-param-smoke。此处只确认能表达的
> 原生字段，不将 Mcode runner / Host RPC 尚未等价的部分伪装成原版执行能力。

| 节点 / 字段 | 正向迁入原版配置 | 反向保存规则 | 已知边界 |
| --- | --- | --- | --- |
| mcode-agent / mcode-conversation | 原生 instruction、capability、outputVar | 原生属性存在即为编辑事实源，包含显式空值；能力回写至声明字段，read 默认值不会凭空制造旧文档中不存在的声明 | 只同步节点包当前暴露的三个字段；技能/MCP/模型/记忆等其它 Mcode 参数仍在 sidecar |
| mcode-branch | 原生 decider、outputVar、note | 反向读取；原先存在的 note 被清空时不复活旧值 | 真人挂起/恢复仍须 Host durable journal，不能用原生消息冒充 |
| mcode-trigger | 原生 triggerKind、task、cron | 原生字段回读；可选空值不擅自添入原 Mcode 参数中 | event filters、debounce、项目/模型/provider 仍需 Host 触发器 |
| mcode-module-capability / mcode-node-red-call | 原生 moduleId/contributionId/path、enginePath/engineMethod/engineBody | 反向读取；原生 HTTP 方法选项已补 PATCH，与合同方法集合一致 | Node-RED 自定义节点的生产 Host port 仍需端到端验收 |
| command → 原生 exec | command、addpay=false、append=""、useSpawn=false、timer；wires 保留三槽 | 原生 command/timer 回写到 params.command/timeoutMs，清空命令和 timer 不会复活旧值 | exec 三路 stdout/stderr/return-code 消息与 Mcode exitCode/stdout/stderr 产出对象不等价，显式报 loss；非零退出成功语义仍待 Host 统一 |
| code(language=node) → 原生 function | func、outputs=1、initialize=""、finalize=""、libs=[]、timeout | 原生 func 回写 params.code；timeout 秒转 Mcode timeoutMs 毫秒 | function sandbox、结构化产出/变量绑定不等价；input JSON 模板无等价原生接口，存在时显式报 loss |
| code(language!=node) → 原生 exec | command 带原有解释器前缀、addpay=false、append=""、useSpawn=false、timer，并保留原生三输出槽 | 可识别的解释器前缀回写语言与源码；已知 timer 秒乘 1000 后写回毫秒；未知语言走 Python fallback 时保留原语言声明且报告需人工裁决 | Node-RED 5.0.8 原生 exec 不提供 Mcode 的 input-template/stdin 注入等价；代码输入参数被保留但不自动执行；退出码/错误/产出契约仍不同 |
| trigger(schedule) → inject | crontab；trigger(file) → watch.files | inject 的 crontab / watch 的 files 回写到 cron / paths 与触发方式；清空原本存在的 cron 保留 schedule 语义并让验证报告可见 | native repeat/once 组合、文件递归/排除/防抖不是完整 Mcode trigger 契约 |
| condition → 原生 switch | 现有布尔 msg.mcode.condition 最小两口配置 | 原 Mcode params.expression 保留，避免假装 native switch 的规则可逆映射 | 完整 expression 的多规则/不同引用/and-or 无原生等价，仍显式 lossy / Host 待实现 |

### E1 / E2 与本轮验收

- **E1**：新独立专项首次接上旧生产适配器时，原生表单值初始化/回写/显式清空/exec timeout/Function 代码/PATCH 方法 17 项仅 3 项通过（日志 apps/desktop/.tmp/smoke-runs/1792447665283-33632-hGhw8k）。另发现 round-trip 将原 Mcode 默认字段无意义扩写，修正后 flow-migration-smoke 的已知字段 round-trip 从 247/248 恢复为 248/248。
- **E2**：flow-native-param-smoke 20/20、flow-migration-smoke 248/248、flow-migration-identity-smoke 11/11、flow-storage-integrity-smoke 54/54、真实 Node-RED 5.0.8 E2E 88/88、mcode-node-pack-smoke 156/156；同批 6/6 suites PASS，日志 apps/desktop/.tmp/smoke-runs/1792448457245-31236-aRwj8V。Desktop 与 Contracts tsc --noEmit 同批 exit 0（后续日志已核对）。
- **真实单位合同**：上游 90-exec.js 用 Number(n.timer || 0) * 1000，上游 10-function.js 用 n.timeout * 1000。因此二者 UI/config 单位都是秒；迁移器已明确转换 timeoutMs ↔ seconds，不再把 1500 毫秒错误写成 1500 秒。
- **迁移版本号协调已完成（2026-10-20）**：Q8V4 原负责人在单独 claim 下先把 `flow-migration-smoke/main.ts` 版本断言同步至 v3，再将生产 `FLOW_MIGRATOR_VERSION` 从 2 升为 3，并补旧 sidecar 兼容用例；现完整迁移专项为 249/249 PASS。证据见 Q8V4 发来的 `MSG-20261020T000452683476Z-a9f727b2df` 与独立 reviewer `MSG-20261020T005055034082Z-16fbbb8cb2`。之前“仍是 2”的段落仅是历史阶段日志，不再是当前阻塞。
- **正式边界**：此为 FULL-2 的 L2 adapter / node-pack UI 字段切片；没有真实 Electron 原厂 editor-client 全字段 save/reopen U1，没有把 condition.expression、代码输入、Host port、触发器/审批语义宣布等价；ARC-006 统一开发/独立整包状态仍按原门槛，不因本轮无头测试转绿而勾选。


### FULL-2 L2 后续真实 Admin API 回灌与新建原生节点默认值（2026-10-20）

- 真实原版 Node-RED 5.0.8：在 production EngineRuntime/production bootstrap 中，Admin API v2 先 GET /flows → 修改 11 个不同执行/编辑节点的顶层原生属性（含 multiline 指令、清空 note/body/path、capability write→read、原生 exec/function 秒单位、inject.crontab、watch.files）→ POST /flows 带 rev → GET /flows 再读 → flowToWorkflowDoc 逆迁回 Mcode；对比已修改字段及未改 x-mcode 中 code.input、边 id/label/note。旧 rev 再部署须收到 409，不许盖过新版。真 Node-RED 专项由 92/92 增至 98/98，全部 PASS，日志 apps/desktop/.tmp/smoke-runs/1792450839949-32128-y1Vy95。此过程运行于隔离临时目录/测试流，未涉及用户数据。
- 新建 mcode-node-red-call 默认 HTTP 方法过去在自定义运行端口中为 GET，Node-RED 编辑器表单新节点的 engineMethod 初值为空；均与 Mcode NodeRed 合同的默认 POST 不一致。补 E1 断言时 flow-native-param-smoke 21/23（2 红）；现运行端口对缺失/空白 method 回退 POST，palette 的 defaults.engineMethod 初始化为 POST，明确有值的 GET/PATCH/等方法仍原样保留，专项 23/23 PASS。此改动在 mcodeNodeTypes.ts，未改他人认领的 mcodeNodePack.ts。
- 连带修复新增 Node-RED E2E 报告筛选中 optional issue.nodeId 未判空引发的 TS2345（测试文件 1023 行）；六位并行 AI 报告后由该文件 claimant 处理，已向 all 发送复验通知 MSG-20261019T225950991939Z-fd815e271d。Desktop/Contracts 双包 tsc 连续 exit0，未让其他对话越权编辑所认领测试。
- 最新统一 E2：flow-native-param-smoke 23/23、flow-migration-smoke 248/248、flow-migration-identity-smoke 11/11、flow-storage-integrity-smoke 54/54、真 Node-RED 5.0.8 E2E 98/98、mcode-node-pack-smoke 156/156、workflow-engine-bridge-smoke 88/88，合计 7/7 suites、678 条断言 PASS；日志 apps/desktop/.tmp/smoke-runs/1792451142260-40508-rt59QD。双包 TypeScript exit0，git diff --check exit0，开工/复验 Git HEAD 由 daec3dfd 到 b86d379b（并发 commits，未自行提交他人文件）。
- 正式留口：FULL-2 的逐字段映射尚不等同全部执行语义，三 SDK 宿主/审批/重启及真实 Electron editor-client U1 未封口；v3 版本常量和旧 sidecar 兼容断言已经由 Q8V4 协同更新并经独立复跑 249/249，不能再将 v2 记作当前阻塞。ARC-006/完全体整包状态不得自勾。

### FULL-2 扩展字段与能力权威隔离的实修验证（2026-10-20，RG91-039）

| 实际根因 | 无修复前真实反例 | 仅修复现有 L2 adapter 的行为 |
| --- | --- | --- |
| Native agent/conversation 被用户从 write 改 read | 历史 x-mcode.params.capability 仍是 write；Mcode 反向只修 node.capability，旧 write 参数未同步；再次迁出时 params.write 反压 native read | 原生已声明 capability 的选择为唯一编辑事实源；历史 params.capability 仅在原来有键时同步更新；重新迁出时显式 node.capability 优先于老 params（Host 仍须真人审批） |
| 任意扩展 unknown 覆盖节点正式字段 | 复制/外部 flow 的 x-mcode.unknown 可包含 id/type/params/capability/position，从旧 object spread 覆盖 canonical 字段 | safeUnknownFields 按节点 Schema 保留真正扩展名，过滤 id/type/title/params/position/capability 与 prototype 污染项；position 的 x/y 也不能被 unknown 覆盖 |
| 文档级 unknown 伪造基本身份 | tab 的 x-mcode.unknown 可含 id/name/nodes/edges/builtin 覆盖正式 Mcode 文档，甚至反转 builtin | 过滤 WorkflowDoc 所有已知主字段；保留其他安全扩展值；正式 id/name/builtin 和当前 native nodes/wires 不从 unknown 字段恢复 |
| 边 unknown 伪造源/目标和 ID | x-mcode-edge.unknown 能把 from/to/id/label/note 覆盖已验证的 wires/旧关联注释；native-only edgeMeta 路径同样受影响 | links 与 native-only wires 两条逆映射路径都过滤这些保留字段，其他扩展字段仍可回传，不允许重定向实际图结构 |
| 真实原版引擎持久化跨格式检验 | 新独立专项旧代码出现以上五个旧红：23/28 PASS；失败日志 apps/desktop/.tmp/smoke-runs/1792458551930-18300-g4gCzq | Node-RED 5.0.8 Admin API v2 真的 POST 保存带恶意 unknown 和历史 write 副本的 nodes → GET → 仅按 tab 的原始元数据还原，证明降权与文档/节点身份不被覆盖，真实 E2E 100/100 PASS |

**本阶段 E2**：flow-native-param-smoke **28/28**、flow-migration-smoke **249/249**、flow-migration-identity-smoke **11/11**、flow-storage-integrity-smoke **54/54**、真实 node-red-e2e-smoke **100/100**、mcode-node-pack-smoke **166/166**、workflow-engine-bridge-smoke **88/88**，合计 **7/7 suites / 696/696 断言通过**；日志 apps/desktop/.tmp/smoke-runs/1792458898342-19420-oFmgXf。Desktop + Contracts 两包 tsc --noEmit exit0，git diff --check exit0。本任务仅补 L2 adapter/测试与矩阵；仍归 ARC-006 FULL-2，不以局部 E1/E2 冒充 Electron GUI 与 Host 真人审批 U1。FLOW_MIGRATOR_VERSION=3 既有 v2→v3 问题已由 Q8V4 解决；新增权限与 unknown 过滤语义是否单独升 v4 交原 owner 协调报告断言。

## 十、FULL-2 安全增补：原生复制节点权限与类型漂移（2026-10-20）

> TASK-20261020-RG91-040。范围仍是 Node-RED 5.0.8 原生 nodes[]/wires[] + Mcode L2 适配器，属于局部 E1/E2，不代表真实 editor-client 的 GUI U1 或 ARC-006 全包签收。

| 原生动作 | 旧风险 | 新逻辑 |
| --- | --- | --- |
| 复制已有写权限的 Agent | 副本继承原 x-mcode 的 write 声明 | 新复制节点身份需要新审批，node.capability 和 Agent params.capability 均显式降为 read；原节点保持原授权 |
| 复制后删除原件 | 旧代码在分组只有一个节点时恢复历史 nodeId 和 write 声明 | 新 nativeId 标记关联真正原生节点 ID；副本保留旧标记时重新分配稳定 mcode_copy_* 身份并降权 |
| 删除原件后有多个副本 | 旧代码强迫一个副本继承原 nodeId | 所有副本重新分配新身份，按原生 ID 决定稳定结果，不随 nodes[] 排序改变 |
| 原生节点 exec 被换成 function，或 Function 换成 exec | 旧 x-mcode.type/params 仍在，逆迁后错误继续使用旧的 Mcode runner | 迁出存 nativeType，读回检查原生类型，类型不一致必须明确重新映射，不能静默套旧权限和代码 |
| 历史 mcode-unknown 占位符及外部插件 | 严格校验可能挡住旧档案 | 仅无 nativeType 标记的非可执行 mcode-unknown 允许旧文档继续读取；无 Mcode sidecar 的插件按其 native type 导入 |
| 改标题、坐标、原生节点排序 | 过严校验可能拒绝正常编辑 | 原类型未变时保留原 Mcode ID，name 和 x/y 原生字段优先，兼容旧导入 |

**E1 红灯证据**：修复前复制权限断言报 write != read，日志 apps/desktop/.tmp/smoke-runs/1792461500495-32556-AvtX9Y；新增类型防护后旧 mcode-unknown 档案先红，日志1792461638434-21216-fmPfDz；补原件已删、孤儿副本复活旧身份的测试先红，日志1792461749416-22168-TPmC76。

**最终局部 E2**：flow-migration-identity-smoke 21/21、flow-native-param-smoke 28/28、flow-migration-smoke 249/249、flow-storage-integrity-smoke 54/54、真实 Node-RED 5.0.8 E2E 103/103、mcode-node-pack-smoke 166/166、workflow-engine-bridge-smoke 88/88：7/7 suites、709/709 断言 PASS，日志 apps/desktop/.tmp/smoke-runs/1792462013713-11748-6dGi6C。Desktop+Contracts 双包 tsc exit0，git diff --check PASS，取证 HEAD dd0f2acd。

真实 Node-RED Admin API GET 保留新 nativeId/nativeType 标记；回读的原生数据副本被用于模拟 Clone/Delete/Replace 后做 L2 降权/拒绝测试；**没有实际驱动原版浏览器 GUI 点击 Duplicate/Delete**，U1 仍缺。

**后续版本裁决**：Q8V4 已将 FLOW_MIGRATOR_VERSION 更新到 3，并给出旧 sidecar 249/249 证据。本轮新增 nativeId/nativeType 是可选的源节点存档字段，是否升级 v3→v4 须同 Q8V4 的 flow-migration-smoke/存储双写负责人协调；没有自行编辑其已有 dirty 测试。ARC-006 双勾继续保留未完成。

**remaining**：真实 Electron editor-client GUI 复制/删除/替换/重开、三 SDK 动态审批与 Host CAS/journal、GenOffice 六原生编辑器与全链路 FULL-5/6 U1。
