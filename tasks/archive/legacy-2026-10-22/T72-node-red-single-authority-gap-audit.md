# T72｜Node-RED 最终唯一工作流权威：T46 双引擎过渡与 FULL-3 差距审计

| 项目 | 值 |
|---|---|
| 编号 | T72 |
| 类型 | ARC-006 / FULL-3 架构门禁，**只读调查** |
| 优先级 | 高；待 T70 差距审查后派发 |
| 复用等级 | L1 Node-RED 5.0.8 的 runtime/editor/storage/nodes + L2 Mcode 宿主授权和迁移 |
| 写边界 | 仅本任务回写与 `.tmp/t72-*` 分析证据；不改产品/测试源码 |

## 问题
正式总路线图要求 Node-RED 最终成为**唯一 flow 画布、执行内核、存储与触发权威**；T46 当时为了历史图保真选择 B：`engine:"mcode"` 与 `engine:"node-red"` 两套**显式按图归属**的过渡机制。这能避免双触发，却不是最终“只有一套工作流内核”的交付证据。应先证明哪些旧图可以无损迁移、哪些必须保留兼容、怎样防止静默丢失，再决定切换和退役；不得直接删除旧 scheduler。

## 开工前必读
1. `audit-ledgers/README.md`、`audit-ledgers/Mcode_统一审查台账.md` 2026-10-20 “FULL-0～6”目标、`tasks/T46-execution-ownership.md`、T58/T59/T60 回写及 T70 结果。
2. `apps/desktop/src/main/workflowEngines/workflowEngineSelection.ts`、`executorOwnership.ts`、`nativeLibraryLoad.ts`、`nativeLibrarySync.ts`、`nodeRedOwnership.ts`、`flowMigration.ts`、`nodeRedStorage.ts`，`orchestration/scheduler.ts`/`runner.ts`；调用链以最新源码为准。
3. 既有 `workflow-engine-selection-smoke`、`executor-ownership-smoke`、`flow-migration-*-smoke`、`node-red-e2e-smoke` 的安全/迁移/幂等覆盖情况。

## 执行内容
1. 对“画布唯一、存储唯一、执行唯一、触发唯一、Agent 可达、审批唯一、版本 CAS、审计/恢复”八个维度给**现状/过渡合理性/尚未闭环/可复用的上游能力**矩阵；按真正可定位的源码和 E1/E2/U1 判定。
2. 不动用户数据库；在虚构 fixture 上分析 `mcode → node-red` 的可无损、明确拒绝、需人工裁决三类迁移；包括未知 Node-RED 节点、原生全局配置、原生编辑保存反向映射、旧 cron/文件触发器、审批状态和 workflow runboard。严禁把“仓库 13/13 夹具”当用户现存流程完整迁移率。
3. 检查 T46/T58/T59/T60 上报的闭环是否已经跨越部署/读取/重复执行/重启；区分“一个工作流明确单 engine”与“整个应用单 runtime”的两层目标。
4. 给出有界的退役路径：**先兼容读取/无损迁移，再证明原流程不双跑，再切默认/保留只读回退，最后考虑禁用旧 runner**；明确停止条件和回滚证据。不能把迁移失败视为允许清空旧图。
5. 只提交阶段门禁和后续最小新任务建议。正式代码修改、跨进程 CAS/原生 GUI U1 需新的独立实现卡；不要此卡动业务。

## 验收判据
1. 八维度全填，关键结论各有源码位置、当前测试证据等级与未达证据。
2. 给出**可执行的**迁移分批方案、门禁指标、回滚与数据保全方案；对不可无损的旧图明确保留安全过渡。
3. 不宣称现在已经“唯一 Node-RED”完成，除非有真正端到端及独立复核。
4. 结合 T70 而不重复 T43/44 节点工作，不为原 Node-RED 已有能力从零写宿主副本。
5. 无新产品或测试代码；只读调查无需变异，标 N/A；若采用隔离复现，记录版本、命令、结果及负控。

## 边界（不要碰）
不改 `orchestration/**`、`workflowEngines/**`、`node-red/**`、`packages/contracts/**`、`apps/desktop/scripts/**`、其它任务卡或正式台账。任何有实际数据破坏风险的操作都不做。

## 结果回写区
<!-- 执行对话追加八维矩阵、迁移/回滚门禁和建议后续任务卡。 -->


### 2026-10-21｜T72 只读架构门禁：T46 单图单引擎 ≠ FULL-3 单应用 Node-RED

**审计基线/纪律**：审阅时 Git HEAD = de6a13e3138d0e59232e8b82c191b5b9da1d036e，工作树已存在其他执行对话修改（未触碰它们）。依据 audit-ledgers/README.md §2.4，本文的 **E2** = 本次源码静态核对；**E1（既存）** = T46/T58/T59/T60 及 smoke 源码报告的历史隔离结果，**不是本次复跑**；**D** = FULL-0～6 终态要求/迁移方案；**U1 缺失** = 未验证真 Electron 完整用户旅程。只读审计，未读取或修改用户数据库、引擎持久文件或真实 SSH；不启动竞争中的 Electron/Node-RED 测试。无新断言，变异验证 **N/A**；也没有本次新增 E1 或 U1。验收讨论均为阶段门禁，不签 ARC-006 完成。

**目标口径**：统一台账 2026-10-20 FULL-2/3 和 MERGE-0～5 要求原版 Node-RED 5.0.8 editor/runtime/nodes/storage 为唯一 flow 画布、存储、执行和触发权威；Node-RED 原生能力优先 L1，Mcode 只补身份/审批/CAS/审计的 L2/L4 薄适配。T46 选择 B（新图 node-red、旧图默认 mcode）保障迁移期间保数据与拒绝错误执行是**合理安全过渡**，却保留两套执行/触发/存储事实源；“每张图明示单一 engine”不构成“整个应用只有一个 runtime”。FULL-3 仍 **NOT MET / REVIEW_INSUFFICIENT**。

#### 八维矩阵（每行含当前实现、过渡理由、缺口/放行证据、上游复用）

| 维度 | 当前实现 / 源码锚点（E2） | 过渡合理性与既存测试 | 尚未闭环及可复用能力 |
| --- | --- | --- | --- |
| **1 画布唯一** | T45 删除 Mcode 自绘画布；renderer/components/settings/workflows/WorkflowNativeEditorEntry.tsx → ipc/workflowEngine.ts 的 workflowEngine.load → workflowEngines/nativeLibraryLoad.ts:31-100 启动前装入 Node-RED flows.json。 | **单编辑入口**与 A→B→A 的选择一致；T59 workflow-native-load-smoke 17/17（**E1 既存**，假 runtime、无真 GUI）；T58 workflow-ui-smoke 有 Chromium 入口覆盖。 | Native editor 的切页、拖拽、未 Deploy 草稿、重启后所见、第三方节点字段保真 **U1 无**。一次 load 会替换整份原生 flows.json 并重启，不能当“多张图同时在编辑器中可用”。优先继续复用上游 editor-client，不另造画布。 |
| **2 存储唯一** | orchestration/library.ts:313-389 的 workflow SQL 库仍为旧/新 doc 入口；workflowEngines/nodeRedStorage.ts:309-431 为宿主 per-flow CAS 档案，:543-610 为真实 flows.json/备份；nativeLibrarySync.ts:23-79 把已 Deploy 原生 tab 反向写回 SQL。registry.ts:540-559 的 mcode-deploy-final **先确认原生成功后异步调用** syncLibrary，失败只 log。 | T58 executor-gate-d-smoke 85/85（既存 E1，模拟原生部署/假 Host），T59 装载不改 SQL updatedAt（既存 E1）；备份内容哈希、磁盘 lease、原子替换属于安全过渡。 | flows.json、工作流 SQL、per-flow 存档及 approval/version 不构成**同一个事务**：Deploy 已成功但 SQL 镜像写失败/崩溃会产生双版本；原生 Admin 流没有统一 Host revision CAS 证据。需要跨存储提交账本/重放/冲突检测、重启一致性和 U1；复用 Node-RED 官方 storageModule/flows API 而非维护永久双写。 |
| **3 执行唯一** | workflowEngineSelection.ts:9-37 按 doc.engine 双向拒绝；scheduler.ts:2339-2342 与 runner.ts:947,975 在旧端校验并领取；nodeRedOwnership.ts:27-84 / registry.ts:572-629 在原生启动与认证 Deploy 时校验并预领取，executorOwnership.ts 的 sharedExecutorOwnership + fileExecutorOwnershipStore.ts 持久登记。 | T46 workflow-engine-selection-smoke / scheduler-smoke；executor-gate-d-smoke 的启动/异常与磁盘恢复、executor-ownership-smoke 的冲突（**E1 既存，非双真实进程**）。每图一 owner、拒绝跨端起跑是合理的防重闸。 | 同一应用仍有 orchestration/runner.ts 和 Node-RED runtime **两个执行核**；动态注册与租约并非未来单 runtime 的证明。要测真正两个独立 OS 进程并发领取、异常中断与重复提交副作用的**零双跑**，以及退役旧 executor 后所有可迁图的等价执行。L1 Node-RED 消息分发，L2 保留 Host executor identity/审批。 |
| **4 触发唯一** | orchestration/automationRunner.ts:897-970 仍跑 30 秒 cron ticker、:622-727 的 fs.watch、:2289-2579 的 fire/owner claim；flowMigration.ts:626-656、:765-792 映到原厂 inject/watch 或 mcode-trigger。Node-RED 另有 inject/watch 等原厂触发器。 | 旧 fire 在派发时持有 owner/对冲突可见 skip（E2）；部分历史自动化恢复 smoke 为旧路 E1，不等于同一事件两系统严格 once。 | buildTriggers（automationRunner.ts:493-580）仍按旧 doc 解析节点，没有以 engine=node-red 关闭旧监听的前置过滤；owner 冲突能挡旧**执行**，不能证明双监听/重复领取/重启延迟事件已经消除。cron 时区、错过分钟策略、文件合并/排除、Hook payload 不等价（迁移器已标 lossy/人工）；必须先成对采集旧/新事件 fingerprint 与重启交错红例，再迁唯一触发权威。原厂 inject/watch 优先，不重造。 |
| **5 Agent 可达** | ipc/workflowEngine.ts:102 起的 handler 经 recordRpcHandler 共用 UI 与 appControl 的 app_api_list/describe/call；nativeLibraryLoad.ts 可被 workflowEngine.load 调用；nodePackProductionPorts.ts 的 Host 节点可经 runtimeManager.sendTurn/模块服务执行。 | E2 具备单端点统一发现/调用的连接；T59 IPC/UI smoke 和 T60 原生节点 hooks 的 **E1 既存**；T70 仅证明真实 Node-RED + 假 Host，不是真三 SDK。 | Agent 能否完成“选旧图→报告→审核→迁移→原厂 Deploy→取消/恢复→runboard”整个闭环没有 U1；真 provider/授权身份/跨页面操作未联合验。不得把 app_api 能看到一个函数等同于 Agent 完整自主管理。复用现有 appControl 与原厂 Admin/Node API，不能复制 Agent loop。 |
| **6 审批唯一** | orchestration/workflowTrust.ts / flowTrustGate.ts 的 revision 审核、library.ts:389 对不可信来源重审；registry.ts 启动/Deploy 前 assertNativeEngineSelection；engineNodeApprovalBridge.ts:66-125 管节点安装真人回执，nodePackProductionPorts.ts 把 Agent 行为经 Host runtimeManager。 | E2 证明分层阻断与单 Host 复用的设计；T58/T60/T70 历史 E1 为 mock/隔离层；原厂任意第三方节点的实际文件/网络/exec 副作用**不是**“每一步经过审批”的动态证明。 | 真 Electron 拒绝/批准/关闭窗口、未审图原生触发停用、审批状态跨存储/迁移/复启绑定版本、撤权后的在途行为缺全链 U1；不能只靠 Node-RED trusted 标记或伪造 x-mcode 代替 Host 审批。复用现有 workflowTrust、ApprovalBridge、ModuleHost/原厂节点生态，不新造第二套授权。 |
| **7 版本 CAS** | orchestration/workflowSaveVersion.ts:68-75 计算整个 WorkflowDoc 存储版本；library.ts:382 先检查期望版本；nativeLibrarySync.ts:48-57 用当前 get→revision→save；nodeRedStorage.ts:375 为独立 per-flow 文件锁+CAS；nodeRedStorage.ts:572-610 的画布替换可检测冲突后拒绝回滚。 | T58 修改标题后 CAS/重审、T59 失败回滚、相关 save-version/storage smoke 属**既存 E1**；适合迁移阶段最大限度保数据。 | SQL 文档版本与 Node-RED Admin POST /flows 的部署版本**非原子同提交**，async 镜像可能在两个 Deploy 之间写旧状态；不是跨进程全链 CAS 的证明。需要原版 storage adapter + Host revision/部署顺序号 + 重启重放/拒绝陈旧写 E1（双进程）和 U1，且保留旧字节。 |
| **8 审计/恢复** | executorOwnership.ts / fileExecutorOwnershipStore.ts 重启读取与冲突拒绝；nodeRedStorage.ts 内容 SHA 备份+异常恢复；automationRunner.ts 的旧触发 claim/运行账、runner.ts 的 runStore；registry.ts:540-565 原生 Deploy 镜像失败只落 error log；T60 workflowLive 原生事件为内存 runboard 状态。 | E2 + 历史 executor-gate-d/native-load/node-red-e2e 和 T60 mcode-node-pack smoke **E1 既存**，分别覆盖一些异常，不是串起数据库→Deploy→再次打开→二次运行/复启的同一条完整旅程。 | 尚无跨 SQL/native/owner/review/runboard 的稳定迁移操作 ID、双向 revision、提交重放账、用户可见修复向导、原生 runboard 重启后历史重建；失败不得靠日志冒充已同步。需单一审计事件与双 OS 进程 crash-point E1、真 Electron U1。复用现有审计与 Node-RED persistence/hooks，不从零造 runboard 执行器。 |

**特别警告/当前源码与旧记录差异**：统一台账 FULL-0 的“ID 二次碰撞 / x-mcode links 盖过原版更改”曾有 E1 红例；但最新 flowMigration.ts:1119-1159、:1196-1239、:1255-1410 已有复制节点 ID 修复、原生 type 漂移拒绝、以 live wires 为准和重复边稳定 ID 修复，flow-migration-identity-smoke/main.ts 亦含对应断言（本轮 **E2**）。不能无视后续代码，把旧红例直接当当前必现 BUG；同样不能在**未本轮复跑 + 未真编辑器**的情况下宣布已闭环。T70 的 T43/T44 17 条差距审计已说明六节点/Host 桥、原厂节点看板等上游实现；本卡**不再派重做 T42/T43/T44**，真实 Host/U1、图标/帮助/i18n 的细分属 T70 后续建议，与本次唯一执行/迁移门禁分别跟踪。

#### 虚构 fixture 的三类迁移判定（只读推演；不把 13/13 当用户成功率）

- **可无损候选 / SAFE-DRY-RUN**：F-A = fictional-plain（显式 engine=mcode，两个**已安装且在 manifest 内**的 Host-backed 普通节点、整数画布坐标、一条普通线、无未知属性/审批中运行/触发器）。在隔离副本执行 migrateWorkflowDoc → flowToWorkflowDoc → roundTripMismatchPaths，必须 unmapped/needsHumanDecision/lossy/字段差异全 0；再按同一 Host 行为契约比较原/新执行可观察结果与 source hash。**仅静态字段往返为候选，不等于安全激活**。F-A-pass 只是**预期判据**，本卡没有跑出 E1。
- **明确拒绝 / REJECT**：F-B = fictional-unknown-type（旧 node.type 不在 manifest → mcode-unknown + unmapped；不得在 NR 内直接执行）；F-C = fictional-native-foreign（从原生编辑器引入未识别第三方节点/全局 config 或跨 tab 引用；nativeFlowForWorkflow 对全局节点直接拒绝，外部 type 缺可验证 Host 语义时不能宣称能反向无损）；F-D = fictional-mutable-type（原版编辑时 exec→function 却保留旧 x-mcode.type，flowToWorkflowDoc 直接拒绝）；F-E = fictional-stale-or-corrupt（flows.json 损坏、多个同 docId tab、revision 不匹配或审批账本坏 → 拒绝切换与覆盖，保留现场）。Node-RED 原生第三方节点**可以留在原生 tab**，不可因 Mcode 库不支持就删原生节点或虚构已迁移文档。
- **需要人工裁决 / HUMAN**：F-F = fictional-cron-watch（旧 cron/漏点补跑、文件监听 debounce/exclude/project/task 与原厂 inject/watch 行为不一致，迁移报告 lossy；按用户逐个明确语义和输入/去重键）；F-G = fictional-user-approval（user branch/待审批/恢复中旧 runStore，不可假设 Node-RED 能续跑同一 token/步骤；先 drain/封存并取得真人放行）；F-H = fictional-live-editor（原生编辑 name/position/tab/wires/复制节点后，虽然最新代码按原生值优先，必须在真实原厂 Deploy→GET/flows→SQL 回读→重启复读上校验未知字段、授权、身份与重复边）；F-I = fictional-runboard（native inject/debug 已有事件但没有持久输出/历史；不能把内存状态当可迁的 workflow-run/审批审计）。对 F-F/F-G/F-H/F-I，字段零差异也**不代表语义等价**。不删除原账、不把待裁决自动归成功。

**边界明确**：T45 所述仓库内 5 自带 + 7 预设 + 1 示例的 13/13 是已知 schema 字段夹具往返；本次**没有**读取用户真实工作流、版本、项目触发器、已安装第三方节点，分母未知，用户实际无损比例 **N/A**。每张真实图须按独立记录生成分项报告，unknown/unmapped/lossy/humanDecision 均不得静默放行。

#### 有界退役次序、指标、停止/回滚门（建议给总控拆独立实现卡，D）

| 批次/阶段 | 操作（正式实施须新卡；本 T72 不执行） | 放行证据/量化门槛 | 失败时处理 |
| --- | --- | --- | --- |
| G0 冻结与发现 | 只读列举 SQL doc/engine、旧 trigger/watch/cron、review/runStore/runboard 引用、安装 node registry 和 flows.json 多 tab/global nodes；区分新增 NR 原生 tab；在**用户授权的导出副本**上工作。每份文件和 SQLite 导出生成 manifest：id、revision、字节长度、SHA256、触发源与批准版本；加密/凭据只在本地受控存档，不导出聊天。 | 清单数 = 已扫描数 + 明确不可读数；每份备份 SHA256 重读一致；未取得备份/审计清单 **一票否决**。 | 不进行任何切换，不把未扫描或损坏数据算空库。 |
| G1 虚构样本+用户副本只读预检 | 先 F-A～I 再在经授权隔离副本逐图 dry-run、字段/未知键/参数/边/位置/cron 差异分类和并行“旧/新读回”比对；迁移建议书逐项显示风险，0 新触发实际动作。 | 尝试数/SAFE/HUMAN/REJECT 总和精确等于清单数；每个 SAFE 的 roundtrip 报告 **0 无解释差异**且原生 Node-RED 节点许可/依赖齐全；UNKNOWN/HUMAN **0 被自动激活**。 | 记失败路径；保留 mcode engine+旧数据只读快照供继续兼容运行，不静默迁图。 |
| G2 小批显式切换（先 1 个，再同类型 ≤5 个/批） | 仅用户逐份同意、处于**无在途执行/人工审批**的 SAFE 流；记录 before SQL/flows/review/owner/trigger claim hash → 先停止/撤销旧触发所有权 → 原生部署+读回 → Host revision 审核/对账 → 开启 NR 触发。保持原 SQL 原件不可变备份与可撤销 engine 映射；原生第三方原件单独备份。 | 每批 100% owner 单值/版本一致；部署→GET/read→SQL→新进程重启 roundtrip **0 无解释差异**；审批未经人点不运行；任何重复写/重复触发 = **0 容忍**。 | 任一步不明/超时/后验不符则**停新触发**、标记 UNCERTAIN、冻结两端执行直到核对，禁止“为了恢复”直接再执行有副作用的事件；凭 SHA 验证原档后经用户确认回切旧 engine。 |
| G3 双跑证明（不实际双执行） | 对隔离**虚构**调度/文件/Hook 输入做 owner 抢占、跨 OS 进程交错、部署失败与重启中断、重复 eventId 投递；仅一端真正接发，另一端仅记“would-fire” shadow trace。相同 payload 指纹对齐错误/权限/窗口/节流差异。 | 含冷启动/重复/取消/掉电恢复的每个输入：实际副作用次数 ≤1（按测试应运行者=1，不应运行者=0）；宿主日志、NR hooks、SQLite/flows 修订、审批、runboard 全链有同一 correlation；双进程 E1 + Electron U1+独立复核齐备。 | 出现两次执行或漏执行→整批 HALT，禁止推默认；保留旧调度兼容，不靠删除 watcher 消灭数据。 |
| G4 默认切换 + 保留只读回退 | 仅当 G0～G3 全绿，新增图默认 NR（目前已有），旧图仍按显式 per-doc 已签映射；原库/旧 runner 改成只读兼容/不可发新触发，保留历史查看/导出/经审批恢复；监控版本漂移。 | 连续至少两次**真实进程重启** + 一轮取消/拒绝/手动触发/cron/文件事件，0 双跑、0 不明 revision、0 审批绕过、0 用户可见数据丢失；实现需新的独立 U1/E1 卡。 | 停止 rollout；不允许把“迁移失败”解释为清空旧图许可。 |
| G5 后置退役旧执行器 | 仅在已迁流 **100%** 通过跨部署/读取/反复触发/重启/历史恢复、不可迁流取得用户授权的安全替代或受控只读兼容策略、独立签核且不再有活旧 trigger 依赖后，才考虑关闭旧 runner。 | 未迁/需裁决/运行中/缺审批/备份校验失败计数全部=0 **或明确隔离在不可执行的兼容阅读区**；FULL-3/FULL-5 正式 ARC 复核成立。 | 否则保留旧 runner 的**有界隔离**，不设日期强拆、不清理旧库和 runStore；对安全旧图继续按显式 engine 运行直到逐份迁完。 |

**故障恢复证据必备**：原库快照 SHA/size + 持久 revision、Node-RED flows.json/credentials/全局配置/插件版本、原 owner/trigger claim/审批记录、旧 runStore、部署序号、迁移判定报告、原生 Deploy GET 对账、新版本回滚审计、用户批准动作与事件副作用 fingerprint。恢复先禁两端触发、读回比对，再单向选 owner；对可能已执行但没有回执的外部副作用一律标 **UNCERTAIN** 而不是自动补跑。人工拒绝不可触发自动回退到未经批准旧 runner。

**T46/T58/T59/T60 联合门禁结论**：T46 单图双向拒绝 E1（既存）→ T58 原生 Deploy 回库 E1（既存，异步镜像）→ T59 库图载入原生 E1（既存，假 runtime）→ T60 Node-RED 真实 inject/debug/exec hooks 及 Host 看板 E1（既存，非真 Electron）。四者是**相互补强但非同一条部署→读取→重复运行→跨重启→审批/审计恢复的连续 U1**；既没有消除旧 automationRunner 触发源，也没有证明 SQL/原生部署的统一 revision CAS，更没有一次只有一套 runtime。故 **FULL-3 / MERGE-3 阶段门禁未通过**，不能更新正式 ARC-006 开发/独立复核双空。

**仅建议总控新拆的最小实现卡（本卡不创建、不修业务）**：

1. **NR-M0｜双向数据与语义迁移门**：限定 flowMigration.ts + 独立迁移/原生 UI 测试。红例：已知字段 round-trip 绿却旧 cron debounce、文件排除/Hook/人工审批执行语义改变；及真实 Deploy 克隆/改类型/全局配置导致库资料偏移。验收：逐字段/触发/待审场景 red→green、真 Admin GET↔POST+原厂 GUI U1、未知节点明确隔离，用户图成功率不编造。
2. **NR-M1｜原生 Deploy↔库一致提交和 CAS**：限定 registry.ts、nativeLibrarySync.ts、nodeRedStorage.ts 与 Host storage adapter/隔离 crash tests（实施者先协调所有权，不能把既有 SQL 直接删）。红例：Deploy 2xx 后库 CAS 失败、同时两编辑端改变、sync crash/重启后旧镜像覆新图；验收：可恢复/可查询 pending commit、同一 revision 一次提交、冲突不覆原档、二进程重放 E1 + Electron U1。复用 Node-RED 官方 storageModule。
3. **NR-M2｜触发 owner 安全交接与旧 runner 退役门**：限定 automationRunner.ts、scheduler.ts、runner.ts、executorOwnership.ts/触发日志，且**先补隔离测试再动**。红例：旧 watcher 已挂/在途时 Node-RED inject/watch 开始、两进程相同事件、取消/重启 UNCERTAIN 重试；验收：每事件实效 0/1 的双 OS 进程 E1、真审批/重启 U1、旧库保全和受控 rollback。仅达到 G0～G4 之后另案决定 G5，不在本卡删 scheduler。
4. **NR-M3｜统一回看/历史可恢复 U1 证据卡**（可与 M1 后接、与 T70 的 T43/44 不重叠）：限定 workflowLive/runboard 事件投影、Host审计对账与 Electron E2E；红例：原生 inject→debug 执行后切页/重启仅留瞬时进度、部署成功回库失败用户不知；验收：用户可见版本冲突与恢复原因、真实批准/拒绝、同一 runId 可复查，不能用 mock Host 当真人卡。

**T72 自检**：八维已逐项标 E2/E1（既存）/D/U1 与源码锚点，迁移 F-A～I 分三类，G0～G5 写明指标、停止和备份回滚；与 T70 工作边界不重叠。仅本卡文档追加；正式代码/测试/台账改动 0，变异 **N/A**。本轮是门禁审计完成，不代表 FULL-3 产品验收完成。
