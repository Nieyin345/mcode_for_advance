# T71｜GenOffice 六原生编辑器：真实 Electron 用户旅程验收与缺口矩阵

| 项目 | 值 |
|---|---|
| 编号 | T71 |
| 类型 | ARC-007 / FULL-2～5 的 **U1 验收专卡**，非功能重写 |
| 优先级 | 高；**只在没有其它任务运行 Electron/编辑共享依赖时派发** |
| 复用等级 | L1 原厂 Docs/Sheets/Slides/PDF/Markdown/HTML 编辑器 + L2 `DocumentViewHost` |
| 依赖 | T28/T29/T53/T54/T57 已提交；**T30 完成后**核对统一路由 |
| 写边界 | 只允许本卡回写、独立测试夹具 `apps/desktop/scripts/t71-genoffice-gui-acceptance/`（确需时）、`.tmp/t71-*`；不改产品功能源码 |

## 目标
不再用“原厂工厂有加载/CLI 能读”推断“六种编辑器 GUI 能用”。在真实 Mcode Electron 宿主下用**虚构文件和隔离 dataRoot**，逐一验证原厂页面、操作、保存、重新打开和权限。无法在本机模拟真实点击/确认时，要记录未验，而不是用 fake view 冒充 U1。

## 开工前必读
1. `audit-ledgers/README.md`、`tasks/GENOFFICE-ROADMAP.md`，T28/T29/T53/T54/T57 各任务回写。
2. `apps/desktop/src/main/document/documentViewHost.ts`、`genofficeViewFactories.ts`、`genofficeNativeVendor.ts`、`apps/desktop/src/renderer/components/ide/GenofficeViewHostPane.tsx`；六个 vendor `createXxxView` 的签名/资源前置。
3. 既有 `genoffice-native-view-smoke`、`document-view-electron-smoke` / `document-view-*-smoke`，官方侧 `genoffice/apps/{docs,sheets,slides,pdf,markdown,html}` 的原生功能测试与样本。
4. 当前 T30 提交的唯一文件路由；Node-RED 或其它 Electron 探针如在跑，**不得**并行启动。

## 执行内容
1. 隔离复制六种**真实有效文件**（必须包含非空文本、Sheets 公式/单元格、Slides 真实页、PDF 页），保留开测前 hash；不接触用户项目/生产账号/真实隐私文档。
2. 每种格式记录“从资料库/文件树打开 → 真原厂编辑器而不是 fallback → 执行至少一个原生支持的操作 → 保存/关闭/重启重开 → 独立工具回读”，严格按可编辑性区分 PDF 只读/批注行为，不虚构源应用没有的功能。额外测无修改关闭字节不变、外部修改 CAS 拒覆、缺 sidecar 明确不可用。
3. 测 Mcode Pane 拖动/隐藏/切回是否保持编辑会话与脏态、用户拒绝保存后的数据完整性；不把旧 stub DOM 当真 UI。
4. 对 AI 面板，分清 Mcode 假 Provider E1 与真实三 SDK 在线 U1；没真实凭据/用户审批时**不要绕过**，记录 U1 待验。原厂 AgentSkill 的选区→修改→撤销须逐项列是否能在 GUI 到达。
5. 产出六格式 × 路由/编辑/保存/重开/原厂资源/AI/权限/Pane 的完整证据矩阵、可复现日志/截图路径、源 SHA 和未闭环清单。需要修复的缺口只建议新卡，不在本卡擅自改编辑器产品代码。
6. 对关键完整链尽可能使用实际 Electron 和安装侧资源，无法启动时登记具体阻塞与最小替代证据级别。不得将 U1 旁路为 E1。

## 验收判据
1. 六种格式每种都有实际测试样本、原厂来源、所需资源/sidecar、文件 hash、测试路径与结果；矩阵 **6/6 行齐全**，失败也如实记。
2. 各自编辑、保存、回读、无修改、外部改动和 Pane 切换的通过/失败/未测有明确证据等级；不要求虚报全绿。
3. 所有操作在隔离工作目录，拒绝审批/越界不放行，未修改生产文件。
4. 可验证真实 Electron U1 的结果必须留真正进程/点击及文件回读证据；假接口/Node 脚本只标 E1。
5. 已有相关 smoke 与双包 tsc **在安全环境下**复查；如被并发进程/源码阻断，精确记录并停止，不谎报绿灯。
6. 若补了新断言，至少一处针对真实路由/保存的负控或变异证明它真能红；若纯审计无新断言则注明 N/A。
7. 输出明确下一张实际开发卡建议，按 format/文件边界拆分，不跨 T30、T49、Node-RED。

## 边界（不要碰）
- 不改 `apps/desktop/src/main/document/**` 业务实现、`genoffice/**` / `patches/genoffice/**`，不做“顺手一把修”。
- 不与其它真实 Electron 测试任务并行；不要向真实账户发模型请求或未经真人允许执行风险权限。
- 审批/在线模型做不到就留 `U1 pending`；不新建第二份文档内核。

## 结果回写区
<!-- 执行对话追加六种格式的证据矩阵、日志、源 SHA、缺口与推荐新卡。 -->
