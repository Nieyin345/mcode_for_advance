# T70｜Node-RED T42 与 T43/T44 交叉验收：消除重复派工（只读审计）

| 项目 | 值 |
|---|---|
| 编号 | T70 |
| 类型 | ARC-006 / FULL-2～3 源码差距审查 |
| 优先级 | 高：旧 T43/T44 尚无回写，但 T42 已包含 port/i18n 实现 |
| 复用等级 | L1 Node-RED 5.0.8 + 原厂 locale/节点扩展 + 既有 `nodePackProductionPorts`；L2 Mcode Host IPC |
| 可派 | 立即只读审计 |
| 写边界 | 仅 `tasks/T70-node-red-t43-t44-gap-audit.md` 结果回写和 `.tmp/t70-*`；**不改任何产品/测试源码** |

## 为什么有这张卡
T43 原题要连生产 `McodeAgentPort`、真实三引擎/审批、失败/超时；T44 原题要六节点的图标、语言、表单、帮助。T42 自己的 2026-10-21 回写已经声明 `mcode-node-request/reply`、`RuntimeManager`、`ModuleHost`、中文 locale、六节点产物和原生 Node-RED 流执行。直接将旧 T43/T44 派发会造成同一代码二次开发。

## 开工前必读
1. `audit-ledgers/README.md`、`tasks/T42-node-red-node-pack-install.md`、`tasks/T43-node-red-agent-port.md`、`tasks/T44-node-red-node-pack-i18n.md` 全文。
2. `apps/desktop/src/main/workflowEngines/nodePackHost.ts`、`nodePackProductionPorts.ts`、`nodePackChildRuntime.ts`、`nodePackManifest.ts`、`mcodeNodePack.ts`、`mcodeNodeTypes.ts`、`registry.ts`。
3. `apps/desktop/scripts/mcode-node-pack-smoke/`、`t42-node-pack-smoke/`、`node-red-e2e-smoke/`；Node-RED 原厂 Node 和 locale 真实形状。

## 执行内容
1. 将 T43 **10 条**、T44 **7 条**验收判据逐条列成 17 行矩阵：已有实现文件/函数；已经取得的 E1/E2/真实 U1 证据；缺少什么；是否存在过期/错误前提。不能因为“有一个函数名”就填 U1 PASS。
2. 特别查：六节点各自的 Host port 是否真正跨进程且带身份/超时/断线拒绝；真实工具审批卡是否被测试桩代替；六节点编辑表单、中文英文切换、不同图标/帮助内容是否只是静态产物。
3. 比较 T42、T46、T58、T59、T60 的原生节点和看板链，确认旧 T43/T44 是否已被后续提交覆盖、哪里确实是新缺口，避免把重复内容重新造一次。
4. 给出明确结论：T43、T44 各是“已有证据覆盖 / 缺 U1 / 有具体产品缺口 / 证据不足”哪些条；若有真实缺口，给出**最小新任务建议**（文件边界、红例、验收），由总控另编号，不在本卡直接修。
5. 默认只读与使用既有日志。只有当前无并行 Electron、Node-RED 测试竞争且样本完全隔离时才选定最小 smoke 单跑；不启动 `--all`。

## 验收判据
1. T43 10/10 + T44 7/7 均已逐条**审核、分级**；不是要求全部 PASS。
2. 对每条“已有实现”的结论有真实源码路径和调用关系或提交记录；“缺 U1”的条目有明确实机交互步骤。
3. 明确建议 T43/T44 是否继续保留“待派”，以及是否必须拆新卡；不得与 T42 重复做同一功能。
4. 若发现安全或真实功能红例，记录失败输入/版本/调用链，归入原 ARC/MC；独立复核证据不足则标 `REVIEW_INSUFFICIENT`。
5. 不改任何产品和测试文件，不提交未归属的工作树内容；无新增断言时变异验证不适用。

## 边界（不要碰）
严禁改 `node-red/`、`workflowEngines/` 及其它任务卡、README 和正式台账；本卡只提交自己的结论回写。

## 结果回写区
<!-- 执行对话在此追加按 T43/T44 判据编号的 17 行矩阵。 -->

### 2026-10-21｜T70 独立源码交叉审计（ARC-006 / FULL-2～3）

**审计性质与版本**：审计基线 HEAD `08a796964f806ee4af1650a9f9470d25eb4584d2`；本轮审阅源码/现存冒烟断言及 T42、T46、T58、T59、T60 回写，没有执行真 Electron / 在线三 SDK、没有发起新 smoke（工作树存在多个其他任务并发改动，按本卡第 5 步避免 Node-RED/Electron 资源竞争）。以下 **E2** 是本轮静态独立核对；**E1（既存）** 是任务卡记载的既往隔离动态证据，**不是本轮独立复跑**；**U1：无**。状态“已有实现/覆盖”不等于独立验收通过。

**源文件调用关系（E2）**：`ProductionWorkflowEngineRegistry.launchSpec → ensureNodePack → nodePackManifest.expectedNodePackFiles` 写入六对 `.js/.html`、独立 `package.json`、12 个 locale 和共享 `mcode-runtime.cjs`；`registry.BOOTSTRAP.RED.init(nodesDir)` 由 Node-RED 上游 `getNodeFiles` 装载；各节点 `nodePackChildRuntime.registerType → mcodeNodeTypes.registerMcodeNodePack / mcodeNodePack.registerMcodeAgentNodes → invoke(process.send)`；宿主 `OwnedNodeRedRuntime.start(onMessage) → NodePackHost.handle → productionNodePackServices.execute/subscribe → runtimeManager.sendTurn / getModuleHost().invoke / 已认证 Node-RED loopback Admin API / runtimeManager.subscribe`。子进程包无三 SDK 与 Electron 导入。子进程 `pending` 有 10 分钟定时器、`disconnect → failAll`；宿主 `NodePackHost` 校验操作、非空 nodeId、在途上限，宿主的 workflow 归属映射另由 `OwnedNodeRedRuntime` 核验，**并不等于所有节点参数都经 Host 逐一授权**。生产 agent/conversation 绑定 **任意存在且 kind=chat 的 sessionId** 并从会话读 `providerId`，没有独立 provider/profile 配置字段；返回 `{text, artifacts: [], runId}`，文本来自 `text.delta` + `turn.done`，而非 `sendTurn` 直接返回文字/附件。工具审批由原生 `RuntimeManager` 链承担，但真实主窗口弹卡未验。

**既有证据定位**：`apps/desktop/scripts/t42-node-pack-smoke/main.ts`（清单/IPC 缺席/Host 假服务）；`apps/desktop/scripts/mcode-node-pack-smoke/main.ts`（原生 Node-RED 5.x、GET /nodes、GET locale、GET/POST /flows、真子进程 IPC，`OwnedNodeRedRuntime(..., hostServices)` 注入**假 Host**，不在线调用三引擎；branch/module 等用假回执，node-red-call 分支未触发）；`apps/desktop/scripts/node-red-e2e-smoke/main.ts`（原生 Admin API/归属/部署等，非主窗口审批 U1）。T42 回写称前三套绿、E2E 曾因 T47 主题断言红；后续 **T60 回写**记录 `node apps/desktop/scripts/run-smokes.mjs mcode-node-pack-smoke node-red-e2e-smoke workflow-engine-runtime-smoke` 3/3 PASS、双包 tsc 0 errors、原生 inject/debug/exec 的 E1，故旧 T42 红例不能当当前已知失败，但本轮未重跑，不能断言当前工作树全部绿。

#### 17 条验收判据矩阵（“已有证据覆盖 / 缺 U1 / 具体产品缺口 / 证据不足”可并存）

| 编号 | 已有实现文件 / 函数及调用证据 | 既有 E1/E2/U1 证据及分级 | 缺项、过期前提与下一步 |
|---|---|---|---|
| T43-01 真实 `inject → mcode-agent → debug` | `mcodeNodePack.runAgentNode → nodePackChildRuntime.invoke("agent.run") → NodePackHost.handle → nodePackProductionPorts.runSelectedSession → runtimeManager.sendTurn` | **E2 已实现；E1（既存）仅真 Node-RED + 假 Host；缺 U1；REVIEW_INSUFFICIENT** | 用 U43-A 真模型回复和 Electron debug 检查；生产 `artifacts: []` 固定空，若确有产物应从原生会话工件链提取，不能把假 Host 返回的 file artifact 当生产能力 |
| T43-02 provider 与节点配置一致 | `runSelectedSession` 从 `SessionRepo.get(params.sessionId).providerId` 选择三 SDK；`agentNodeHtml.defaults` 只有 `sessionId`、无 `provider/profile` | **E2 间接按会话选引擎；缺 U1；具体配置语义缺口** | 原题“按节点 provider/profile 配置”前提**过期**：当前只能选已有会话并继承 provider；U43-A 各跑 Claude/Pi/Codex、核对事件 provider；是否允许节点单独选引擎须由总控决定，不得再建独立 Agent loop |
| T43-03 真实工具审批卡 | `runSelectedSession → runtimeManager.sendTurn` 复用原生工具审批链；`module.invoke → getModuleHost().invoke` | **E2 有调用链；E1（既存）假 Host 不验真实审批；缺 U1，REVIEW_INSUFFICIENT** | U43-B 在真 Electron + 在线引擎触发需授权工具，确认主窗口审批卡、拒绝不执行、批准后恢复、部署握手不被干扰 |
| T43-04 引擎崩溃时在途全部 `ok:false` 且 Catch 接住 | `nodePackChildRuntime.failAll` 在 `process.disconnect` 拒 pending；`NodePackHost.dispose` 清订阅/在途；`createNodeInputLifecycle` close 结算 done | **E2 局部 fail-closed；E1（既存）缺失 IPC 拒绝/close；缺真实故障 U1，原验收前提有误** | **Node-RED 子进程已经崩溃就没有存活的 Catch 节点可接包**；`dispose` 也不会逐个发送 `ok:false`。拆成“Host IPC 断线而子进程仍活 → Catch”与“子进程崩溃 → supervisor 报错/回收”，分别在隔离进程测 |
| T43-05 5 秒未回包后的超时 | `nodePackChildRuntime.RPC_TIMEOUT_MS = 10 * 60_000`；`invoke` 超时拒绝并触发 `done(err)`；部署握手另有 5000ms，不同协议 | **E2 存在 10 分钟兜底；无 5 秒动态注入证据；具体可测性/超时缺口** | 不能把部署 5 秒超时错认为节点 5 秒超时。隔离 fake Host 无回包，给节点 RPC 可注入短时钟/短超时后证实 Catch + 清 pending，保护真实长运行可配超时 |
| T43-06 conversation 在可见主对话 | `runConversationNode → "conversation.run" → runSelectedSession`，仅接受 `session.kind === "chat"` 的会话 | **E2 已实现既有聊天会话复用；E1（既存）假 Host；缺 U1** | U43-C 选择真实可见会话、注入、查看聊天流及侧栏、手工继续聊；“当前主会话”未被额外核定，文本 sessionId 可指向另一聊天会话，需明确目标语义 |
| T43-07 branch model/user 双分支 | `mcodeNodeTypes.runBranchNode → "branch.decide"`；`chooseBranch` model 用 session 分类调用，user 用 `electron.dialog.showMessageBox` 等待选择 | **E2 两分支均存在；E1（既存）假 port/branch 端口范围；缺 U1；决策语义差异** | 原卡第 4 步**要求方案 A**“不挂起，等人工出口并由上游重触发”，实际是等待 modal 对话框后同次继续，需总控认可变更；U43-D 测真人选择/取消、model 数字越界/失败、真正多出口 |
| T43-08 四套 smoke 全绿 | `mcode-node-pack-smoke`、`node-red-e2e-smoke`、`workflow-engine-runtime-smoke`；T46 对 scheduler / workflow 类另有回归记录 | **E1（既存）T60 3/3；不是本轮 4 套与 orchestration 全量复核，证据不足** | 旧 T42 105/106 T47 CSS 红已被后续 T60 3/3 覆盖；需要独立隔离补齐 orchestration 相关套件及版本一致性；本轮未抢并行测试资源 |
| T43-09 双包 tsc | T60 结果回写 `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` 和 `packages/contracts/tsconfig.json` | **E1（既存）0 errors；本轮工作树有其他并发修改，未重验，证据不足于当前 HEAD 工作树** | 独立无竞争窗口重新跑双包；勿因历史 T42 文档相关阻断断定目前红 |
| T43-10 3 种原位变异 | `t42-node-pack-smoke` 做静态移除字符串“应红”比较、无 IPC 运行拒绝、manifest 字节篡改；`mcode-node-pack-smoke` 对错误/关闭有断言 | **E1（既存）覆盖部分负例，未证明“撤超时/撤 disconnect/假文本 → 各自必红”；证据不足** | 在隔离副本添加最小断言、原位变异复红；禁止本审计改测试代码，缺口归未来独立任务 |
| T44-01 mcode 分组、6 个不同图标 | `agentNodeHtml` 是 `fa-user`；`mcodeNodeTypes.htmlFor` 其余 **五个全是 `font-awesome/fa-cube`**，分类全为 `mcode` | **E2 确认分组/六图标字段；E1（既存）GET /nodes HTML；“不同图标”明确产品缺口** | **静态红例**：输入现有六节点 HTML，提取 icon 仅 2 个 distinct（预期 6）；T42 既有测试只计 icon 字段个数 ≥6，不能覆盖此判据；U44-A 拖入画布目视 |
| T44-02 中英切换整个表单 | `nodePackManifest.localeText` 生成 `locales/en-US|zh-CN/<type>.json`，表单标签 `data-i18n="mcode.label.*"` | **E2 标签国际化；E1（既存）真实 zh-CN locale HTTP 返回“指令”；缺 U1；部分具体产品缺口** | `htmlFor` 的 option 文本 `user/model/manual/schedule/file/event/GET...`、textarea/input placeholder 仍是硬编码英文（agent 也有），未用 `data-i18n="[placeholder]..."`，不满足原卡“每个 option/placeholder 本地化”；U44-B 原厂编辑器中/英来回切换目视 |
| T44-03 6 节点右键帮助可读 | `agentNodeHtml` 有 `data-help-name`；其余 `htmlFor` 统一短句 “minimal: delegates execution to the host-issued port” | **E2 存在六份帮助；仅静态内容，缺 U1；产品说明缺口** | 未逐节点写清输入/输出及审批（agent/branch/module），与 T44 第 3 步不符；U44-C 六节点逐一右键帮助核对内容及是否弹授权 |
| T44-04 六份 HTML 三段齐全 | `nodePackManifest.expectedNodePackFiles` 调用 `agentNodeHtml` 与 5 个 `*NodeHtml`；均输出 `registerType` + `data-template-name` + `data-help-name` | **E2 结构覆盖；E1（既存）真 Node-RED GET /nodes HTML 六份；已有证据覆盖（非 U1）** | 无三段缺失；表单真实交互、字段持久化是独立 U44-A/B 问题，不应重写六份注册外壳 |
| T44-05 mcode-node-pack-smoke 全绿 | `mcode-node-pack-smoke/main.ts` 纯函数、包注册、真 Node-RED + 假 Host 的大量断言；T60 3/3 记录 | **E1（既存）PASS，未本轮复跑；已有证据覆盖部分** | 既有断言没有校验**六图标唯一**与**六份帮助含审批/输入输出**，需要增量红断言；本轮不改测试 |
| T44-06 双包 tsc | 同 T43-09；T60 回写当时双包干净 | **E1（既存）PASS；当前未复跑，证据不足于当前工作树** | 避免重跑 Node-RED 竞争；选独立窗口补时以当前 HEAD/工作树记录 |
| T44-07 帮助/分组变异必红 | `t42-node-pack-smoke` 断言节点包结构；`mcode-node-pack-smoke` 断言有 HTML 类型/部分表单 | **E2 测试存在，但无“删一个 data-help-name”及“改一个 category”原位变异红证据；证据不足** | 先补精确断言再撤字段验证失败，记录失败用例和恢复绿，不能拿“HTML 含某字符串”代替变异验证 |

#### 后续提交覆盖 / 任务派发判定

- **T42 `9d390a7e` 已实装** Node-RED 原厂装载、六种 node type、独立中英 locale、跨进程 IPC 和共享 Host services；旧 T43 “生产 port 为空”、旧 T44 “五节点没有 HTML / 全部一个图标”中的前两项前提都过期（五个确有 HTML，但图标仍重复）。**禁止按原 T43/T44 整卡重复派工**。
- **T46 `5b8f9cbb`** 解决 workflow 显式执行归属和 Host-backed 节点经 `runtimeManager.emitExternal` 上报看板；**T58 `74aeaa79`** 解决认证 `mcode-deploy-final` 后原生编辑保存回写；**T59 `d3517719`** 补“库文档 → 原厂画布”的装载链，非产品 GUI U1；**T60 `edbee229`** 用原厂 `onReceive/onComplete`（不是旧卡误写的 `runtime-event.id=node-status`）补原生 inject/debug/exec 看板 E1，同时排除 mcode-* 重计。以上各自不等于 T43 真实三引擎审批通过，也没有解决 T44 的图标/帮助/选项国际化。
- **建议状态**：T43 **不保留“待派整卡”**；01/03/06/07 缺真实 U1，02/05 有配置或超时产品缺口，04 原验收设定不成立需改故障模型，08/09/10 独立验收证据不足。T44 **不保留“待派整卡”**；01/02/03 有明确产品缺口及 U1，04 已有 E1+E2 核心结构覆盖，05/06 有历史绿但待独立复跑，07 缺变异证据。二卡均不得写“全部 PASS / 已 U1 验收”。
- **最小新任务建议（由总控另编号；本卡不改源码）**：**A—Host 真实旅程/故障证据卡**：文件边界测试目录中新增隔离单进程/双进程桥测试及 Electron 人工验收记录，产品修改仅当测试红证实需调 `nodePackChildRuntime.ts`、`nodePackHost.ts`、`nodePackProductionPorts.ts`。红例：Host 不回包 5 秒、Host IPC 断线而子进程仍存活、子进程直接崩溃（改验 supervisor 而非 Catch）、真 SDK 工具审批拒绝/批准、三 provider 回复与会话继续/附件；验收是明确 Catch/拒绝/回收/正确 provider、独立 E1 + 真 U1、超时/断线/伪造文本三类变异各自必红。**B—Node-RED 节点 UX 微修卡**：文件边界 `mcodeNodePack.ts`、`mcodeNodeTypes.ts`、`nodePackManifest.ts` 和现有 node-pack smoke 测试（不改上游 `node-red/`）。红例：六节点 icon distinct=2<6、切 zh-CN 后选项/placeholder 英文、帮助不含输入/输出/审批；修后 6/6 不同图标、en/zh 全字段、逐节点帮助齐备、中英原厂 GUI 切换 U1、删帮助或改 category 的变异必红。**C（仅决策后）—branch 出口/会话选择细化卡**：先决定人工分支到底用 modal 当次继续还是原 T43 A“人工出口 + 上游重触发”，和节点 provider 是否只随 Host 会话；若坚持 A，再定义最小节点/表单与 Host 职责测试，不凭旧文档重写已有 model/user 实现。
- **U1 实机操作索引**：U43-A：真 Electron 打开指定 Node-RED 文档 → 各拖 `inject → mcode-agent → debug` 配真实 sessionId → Deploy/触发 → debug 面板核真实模型答复、artifact、provider 事件，三 SDK 各一轮；U43-B：在同一路径要求真实工具写入 → Electron 主窗出现审批卡 → 先拒绝、再批准 → 对比是否继续、是否同时阻塞 `mcode-deploy-*`；U43-C：`mcode-conversation` 指定某可见聊天 → 检查消息流/侧栏/继续对话；U43-D：双输出 `mcode-branch` 的 model 正常/非法数字与 user 点击/取消；U44-A：真编辑器拖六节点、核分组/图标及字段可保存；U44-B：切到 zh-CN 再 en-US（含 option/placeholder），刷新仍一致；U44-C：右键六节点帮助，逐项核输入/输出/审批。以上均**待执行，不能冒充已完成**。
- **独立安全/功能红项归属**：T44-01 的 5 个 `fa-cube` 是**静态直接可观察功能红例**；T44-02/03 是静态产物缺口，均归 **ARC-006 / FULL-2～3**；T43-05 10 分钟与题设 5 秒不符，属 **ARC-006** 协议/验收口径缺口；尚无实机输入证明它绕过审批。另有 **E2 待复核风险（REVIEW_INSUFFICIENT）**：`nodePackHost.handle` 只检查 payload.nodeId 非空，而 `runSelectedSession` 接受节点表单传入的任意现存可见 chat sessionId；建议新卡在**虚构的两个 session + 独立 flow** 中验证是否需要 Host-owned 授权会话绑定，不可仅凭源码就宣告可跨用户越权或另立 MC。T43-04 “崩溃后 Catch 接住”是进程生命周期上无法成立的**错误验收前提**，不是已证安全红例。
- **写入约束复核**：本轮只在 T70 本卡追加以上文字；未改任何产品源码、测试、上游、别的任务卡、台账及 README；无新增断言，**变异验证对 T70 本身不适用**。提交只准 stage 本文件，保留其余并发工作树原状。
