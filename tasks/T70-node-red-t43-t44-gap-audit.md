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
