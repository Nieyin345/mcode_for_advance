# T79｜T70 确定缺口：Node-RED 六节点辨识度、全字段双语、帮助内容

| 项目 | 值 |
|---|---|
| 编号 | T79 |
| 类型 | ARC-006 / T44 真实剩余功能缺口 |
| 优先级 | 高：T70 已独立定位静态红例 |
| 实现路线 | L1 Node-RED 5.0.8 原生 `registerType` / `data-i18n` / locale / 帮助机制，L2 修改 Mcode 既有节点包生成，不 fork 第二套 UI |
| 依赖 | **T70 已审计并提交 `941de215`** |
| 可派 | **立即**；与 T64/T65/T49/T73/T74/T76 不共享目标文件 |
| 允许写 | `apps/desktop/src/main/workflowEngines/mcodeNodePack.ts`、`mcodeNodeTypes.ts`、`nodePackManifest.ts` 的 HTML/locale/图标/帮助相关区域及 `apps/desktop/scripts/mcode-node-pack-smoke/*` 与专属测试；本任务回写 |
| 禁写 | `registry.ts`、`nodePackHost.ts`、`nodePackProductionPorts.ts`、`nodePackChildRuntime.ts`、`orchestration/*`、`genoffice/*`、`main/modules/*`、`main/appControl/*`、`node-red/*` |


## 独立已发现红例（不要重复调查或报“已完成”）
T70 源码矩阵显示 `mcode-agent` 使用 `fa-user`，而 `mcodeNodeTypes.ts:htmlFor` 给另外五节点一律 `font-awesome/fa-cube`；**六节点只有 2 个不同图标（要求 6）**。同一个 `htmlFor` 中各 select 的 `option` 直接显示 `user/model/manual/schedule/.../GET` 英文，input/textarea 的 placeholder 也硬编码英文；帮助统一只有“minimal: delegates execution to the host-issued port”，没有逐节点输入输出和审批含义。T42 的 E1 真实 Node-RED `GET /nodes` 和 zh-CN locale HTTP 只能证明资源存在，**不能证明这些 UI 需求满足**。

## 开工前必读
1. `audit-ledgers/README.md`、T42/T44/T70（特别是 T70 17 条矩阵）、T60 生产节点与 GUI 验收限制。
2. `mcodeNodePack.ts:agentNodeHtml`、`mcodeNodeTypes.ts:htmlFor` 及六节点列表与 `nodePackManifest.localeText` 的原有字段。
3. Node-RED 原厂 `data-i18n`、`[placeholder]`、`[title]` 属性和节点 locale 约定；六节点真实输入/输出/审批行为（只读 Host 实现，不可改）。
4. `apps/desktop/scripts/mcode-node-pack-smoke/` 与 `t42-node-pack-smoke/` 中已有断言和构建入口。

## 执行步骤
1. 先把六份生成 HTML 拉成不变基线并补“六图标不同”“六帮助有输入/输出及批准状态”“所有用户可见占位/选项支持中英”的精确断言；旧源应至少有对应红例，不接受只检查存在 `icon:` 的弱断言。
2. **最小只改编辑器资源生成**：六种官方可用且确实存在的不同 icon；所有字段复用官方 `data-i18n` 及 `locales/en-US/zh-CN`，任何语言切换均不改变持久化 value/类型；帮助逐节点交代行为、`msg.payload`/outputs、是否依赖宿主审批，符合真实 Port 语义（不能声称无需审批）。
3. 保护 `mcode-branch` 现有动态 outputs、多路径与 Node-RED 编辑/部署契约；不重构 Host RPC、不更改六节点运行算法。
4. 真原生编辑器视觉语言切换 U1 若与其它 Electron 测试抢资源，可只记 U1 pending；E1 static/Node-RED locale HTTP 与源变异必须独立完成，不要用跳过实机验收冒充通过。
5. 关联 `mcode-node-pack-smoke` / `node-red-e2e-smoke` / `workflow-engine-runtime-smoke` 只在安全非竞争时复跑；如原包重建，保证 manifest hash 与原厂节点正常加载。

## 验收判据
1. 六节点产生 **6/6 不同且真实支持**的图标，分类仍为 `mcode`；变异把任一图标改成已有值 → 专项红例。
2. 中英文标签、选项、placeholder/tooltip 全部可切换，持久化值不翻译，双语言资源齐全；撤掉任一属性 → 明确红例。
3. 六份帮助内容分别包含输入、输出、是否触发 Mcode 审批的真实说明；删掉 `data-help-name`/错写帮助断言变红。
4. 六个完整 `registerType + data-template-name + data-help-name` 结构和 `mcode-branch` 多出口不回归。
5. Node-RED 相关 smoke 与双包 TypeScript 按现场可用性通过、记录命令和独立日志；源代码/新测试只提交自己所有权。
6. 真实 Electron U1 若没完成必须写明确 U1 pending；不宣称 T43 整卡/ARC-006 整体验收。

## 不做
不修 T70 指出的超时/跨 session 授权等 Host 行为，也不改变节点运行功能；这属于后续另卡。与 T77 Electron GUI U1 **串行**。

## 结果回写区

<!-- 执行对话仅追加证据、提交 SHA、实际命令/计数、原红→新绿、变异/恢复、未验风险。 -->
