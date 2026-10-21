# T82｜T69 确认的 emit-path-smoke 事件扫描器误判修复

| 项目 | 值 |
|---|---|
| 编号 | T82 |
| 类型 | ARC-006/T60 测试断言回归（非 Node-RED 运行逻辑改造） |
| 优先级 | P2（原全量一套有明确旧断言差异） |
| 复用路线 | L1 现有 `workflowLive`、`emitExternal` 统一事件通路，不增第二事件源 |
| 可派 | **立即**；只改单个既有测试文件，源码只读 |
| 独占可写 | `apps/desktop/scripts/emit-path-smoke/main.ts`、如必需专属最小 fixture、本任务卡 |
| 禁写 | `main/workflowEngines/*`、`main/orchestration/*`、`packages/contracts/*`、所有 Node-RED 原厂源码及其它 smoke |


## 证据及任务性质
T69 把 `emit-path-smoke` 归 B 类，历史 `main.ts` 的 event sink 静态扫描对 `nodePackProductionPorts.ts:18,57` 的动态 `emitExternal(event)` 报假阳性，旧日志在 `apps/desktop/.tmp/smoke-runs/1792584727328-35168-iRgjl0/emit-path-smoke.log`；T69 建议原 **34/36** → **36/36**。这只能证明历史断言与当前源码形状不一致，**不能随便删掉动态事件的未知类型报警**。

## 开工前必读
1. `audit-ledgers/README.md`、T69 第 15 条与建议 5、T60 已提交事件分发记录。
2. `apps/desktop/scripts/emit-path-smoke/main.ts` 全文及其运行入口，`apps/desktop/src/main/workflowEngines/nodePackProductionPorts.ts` 的事件产出与 `workflowLive` 统一事件模型（只读）。

## 执行步骤
1. 在隔离环境首先重跑真实旧 34/36 红例，定位扫描器为什么把受约束动态事件类型当作未知。
2. 修**测试如何识别真实 producer/emitExternal 路径**，不让未知事件直接绕开检查。保留所有旧事件类型/路径/安全断言；新增至少一个合法动态来源正例和未知来源负例。
3. 运行原 Smoke 全部断言和有代表性的 T60 相关事件回归，不修改生产 event 底座。
4. 变异：将合法 sink 改为无法追踪的 broadcast 或引入非法事件类型，扫描器必红；恢复后原字节一致。

## 验收判据
1. 原 2 个假阳性在合法 production 事件形状下转绿，完整 36 条原断言不减少；不能变成无条件放行。
2. 新增未知事件/丢事件 sink 的负控确实红，正例原事件传递 E1/E2 与提交 SHA 完整。
3. 双包 TypeScript 与原 Smoke 在可复现、无争用环境运行；其它并行源码造成的错误注明不越权修。
4. 仅提交本测试与独立 fixture、任务卡；不改变 T79 节点 HTML/locale 生产源码。

## 不做
不重写 Node-RED 运行态事件，不修改 T69/70 已签的历史审计记录。

## 结果回写区

<!-- 执行对话仅追加证据、提交 SHA、实际命令/计数、原红→新绿、变异/恢复、未验风险。 -->
