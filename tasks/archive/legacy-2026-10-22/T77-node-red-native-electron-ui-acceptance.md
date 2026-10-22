# T77｜Node-RED 真 Electron 编辑器：六节点拖拽、Deploy、库回写与看板 U1 验收

| 项目 | 值 |
|---|---|
| 编号 | T77 |
| 工作包 | ARC-006 FULL-2/3/5 |
| 优先级 | P1；产出真实功能断点，代替仅 headless 的“已经接好”说法 |
| 路线 | L1 Node-RED 5.0.8 editor-client/runtime + L2 Mcode WebContentsView/Host IPC |
| 可派 | **等 T79 节点 UI 修复回写，并独占 Electron 测试窗口时**；T70 已提交 `941de215`；与 T71 绝不并行 |
| 允许写 | 仅本任务结果回写、新建 `apps/desktop/scripts/t77-node-red-native-ui-acceptance/` 和 `.tmp/t77-*` 夹具/日志 |
| 禁写 | `workflowEngines/*`、`node-red/*`、`orchestration/*`、`renderer/*`、`packages/contracts/*`、既有 smoke；不修业务代码 |


## 缘由
T42 的真实引擎测试证明 `GET /nodes` 可发现六节点，T58 实现 `mcode-deploy-final` 到 Mcode 库的反向写入，T59 选中库文档装载原生画布，T60 采集原生节点运行事件。但原任务自己明确**没有**覆盖实际 Mcode Electron 主窗口的人手拖拽、真实 Node-RED 画布保存/选择库工作流/可见 Debug/真实审批 UI 闭环。T70 会先给 T43/T44 的 17 条差距矩阵，本卡仅承担 U1，不重写已有流程。

## 开工前必读
1. `audit-ledgers/README.md`、T42/T45/T46/T58/T59/T60 及 T70 结果回写。
2. `workflowEngines/registry.ts`、`nativeLibraryLoad.ts`、`nativeLibrarySync.ts`、`nodePackProductionPorts.ts`、`flowMigration.ts`。
3. 当前 `node-red-e2e-smoke`、`workflow-native-load-smoke`、`workflow-ui-smoke` 和真实 Electron E2E 夹具启动/自动退出方式。
4. 切换/部署要遵守宿主审批、用户工作区/SQLite 分离，不允许用外部 API 假装用户真正保存过。

## 执行内容
1. 建立隔离的 `dataRoot`、工作区、临时 SQLite 和虚构两份 workflow A/B；保证不覆盖用户已有 Node-RED `flows.json`、端口、真实会话。
2. 在真实 Electron 主窗口打开 Node-RED 原生编辑器，验证 6 个 Mcode 节点在调色板、表单/i18n/帮助中的可见性；至少一条 `inject → mcode-agent → debug` 的真原生 UI 操作（外部模型可假 provider，但必须真实画布和进程，标 E1/U1 边界）。
3. 从 Mcode Workflow Library 点击 A/B 装载并在原厂编辑器可见，修改原生节点或标题→真实点击 Deploy→在库中读回并重启后保持；失败/取消/拒绝不更新库，无法映射原生节点不悄悄丢失。
4. 检查同一 flow 无重复运行/触发，真实原生 inject/debug 和看板 `workflow.node.*` 可见性；把 Node-RED 纯原生节点与 Mcode Agent 节点分别记录而不是假装全已覆盖。
5. 只记录版本、真实操作、截图/录屏路径、测试执行与复现实验；缺真人批准/真实三 SDK 凭据即标未验，不绕过安全链。
6. 发现产品缺口只建议分领域新卡，不直接动被多个任务共用的 `registry.ts`、`scheduler.ts` 或 UI 代码。

## 验收判据
1. 真实 Electron + 真 Node-RED 进程与原生 UI 交互的可查证据；不能以直接 `POST /flows` / jsdom 模拟拖动代替。
2. A/B 装载→原生修改→Deploy→Mcode Workflow Library/SQLite/重启回读，各环节有 PASS/FAIL/未验。
3. 审批拒绝、迁移损失拒绝、无重复触发与原生节点 runboard 按各自事实记录，没覆盖的不填 PASS。
4. 所有夹具严格隔离、不触碰生产数据库/真实项目凭据；Electron 探针不得与 T71/其它 UI E2E 抢资源。
5. 仅提交专卡和自己的新测试，若新增了断言，至少一个反例撤掉原生部署同步或库回读后确实变红，再恢复；只验不补断言则标 N/A。

## 不做
不把旧 mcode 调度器直接删掉；不解决 T72 的最终“唯一存储内核”决策；不改 Node-RED 源码或审计代替产品开发。

## 结果回写区

<!-- 只在下面追加：提交 SHA、旧红→新绿、原始命令/日志、变异/还原字节、剩余未验；不得覆盖本任务正文。 -->
