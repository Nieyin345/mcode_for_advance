# T30｜GenOffice 六编辑器文件路由收敛：统一格式判据

| 项目 | 值 |
|---|---|
| 编号 | T30（GenOffice 路线图预留编号） |
| 对应 | ARC-007、FULL-2，后续 T31–T33 的前置 |
| 状态 | 待派；**必须等 T65 提交后** |
| 复用等级 | L1 原厂 `genoffice/apps/shell/src/main/app-routing.ts` 的格式判据 + L2 Mcode 受控路由适配 |
| 预计边界 | `renderer/components/ide/fileEditorKinds.ts`、`GenofficeViewHostPane.tsx`、`library/FilePreview.tsx` / `FileViewer.tsx`、`sessionStoreHelpers.ts`、可复用的路由模块及专属 smoke；按实际调用链收敛 |
| 互斥 | **禁止与 T65 或任何修改 `FileEditor.tsx`/`sessionStoreHelpers.ts` 的任务并行**。T49 的 `main/appControl` / `modules` 不在此卡权限内 |

## 一句话
六种文档类型的“应由哪个原厂编辑器打开”只维护一份标准；不同入口不再独立猜扩展名。本卡只收敛路由，不重写 Office 业务引擎，也不放松宿主路径/授权围栏。

## 开工前必读
1. `audit-ledgers/README.md`、`tasks/GENOFFICE-ROADMAP.md` 阶段 1（T30）与 `tasks/README.md` 的最新总控派发表。
2. 原厂 `genoffice/apps/shell/src/main/app-routing.ts`，核对六种编辑器、扩展名大小写、只读/不支持格式的边界；锁定当前 GenOffice Git SHA。
3. `apps/desktop/src/renderer/components/ide/fileEditorKinds.ts`、`GenofficeViewHostPane.tsx`、`FileEditor.tsx` 的只读路由调用点。
4. `apps/desktop/src/renderer/components/library/FilePreview.tsx` / `FileViewer.tsx`、`apps/desktop/src/renderer/stores/sessionStoreHelpers.ts`，以及 `packages/contracts` 现有 `isOnlyOfficeSupportedPath`；若类型或实际位置已变化，以源码为准。
5. T28/T29/T53/T54/T57 的原生视图、sidecar、IPC 与 CAS 约束；T65 的最终提交及新 Monaco 引用不得回退。

## 执行内容
1. **先盘点**每个文件入口的格式判据、相同路径在文件树/资料库/拖拽/重开后的实际结果。列出六格式对照和冲突，确认“只读 PDF”与可编辑格式的产品策略。既有内容不可因为统一映射而静默降级。
2. **统一事实源**：优先复用原厂 `appForPath` 的明确能力矩阵；若不能直接在 Mcode renderer 依赖其运行时代码，仅做纯函数、可回溯的 L2 薄映射，并写上游 SHA/许可/源路径。不得复制第二份正则到每个消费者。
3. 让可改范围内入口共享同一个分类结果；对原生格式选择 `DocumentViewHost`/`createXxxView` 既有通路，非原生/只读/缺 sidecar 使用明确原因而非偷偷 fallback。保持 `isOnlyOfficeSupportedPath` 之类的权限/资源上限与纯文件路由语义分开，不把路由判据当授权判据。
4. 只改文件类型路由和必要回归，不动 `documents` 保存、GenOffice 上游编辑器算法、文件 CAS、权限审批、T65 的选段工具栏、Node-RED 或扩展系统。
5. 适用真实路径、大小写、复合扩展名、无扩展名、伪造类型、路径越界、资源缺失等测试；对每个现存入口断言一致且不跨项目授权。

## 验收判据
1. 六格式（DOCX/XLSX/PPTX/PDF/Markdown/HTML）在上述入口路由一致；原生已有可用路径不回退旧自绘 Office/空白视图。
2. 每一种格式至少有原厂工厂、缺资源拒绝、外部越界拒绝的可复验断言；PDF 只读等原策略不变。
3. 旧用户文件、资料库、文件树、重复打开/关闭/Pane 切换既有行为不回归。
4. 关联 `document-view-*`、`genoffice-native-view-smoke`、`frontend` / `file-view` 相关有代表性套件全绿，具体以实在存在的 suite 为准，不凭空声称“全量”。
5. 双包 tsc 通过；若在飞任务占用共享依赖，记录实际诊断，**不得**冒报通过。
6. 至少两条变异红例：撤掉共享格式映射 → 不同入口分歧断言红；撤掉资源/越界判据 → 安全拒绝断言红；恢复后源码字节和正例一致。
7. 逐项列出没完成的 GenOffice GUI 编辑、AI、保存 U1；本卡 E1/E2 不能冒充六原生编辑器完整验收。

## 边界（不要碰）
- 不改任何 `main/modules/*`、`main/appControl/*`、`node-red/`、`genoffice/` 上游业务逻辑；不改本次已完成的 T65 选段引用。
- 不做 CLI/AgentSkill 新接入（T31–T36 后续）。
- 如果发现新需求必须编辑 T65 文件或不可绕过的合并冲突，**停工回写**，由总控重新调整边界，禁止“顺手”覆盖。

## 回写区要回答
- 原厂格式源 SHA 与唯一映射位置是什么？
- 哪些入口之前冲突、统一后如何测红/绿？
- 路由与宿主资源授权如何保持两个不同概念？
- 六格式真实 U1 还有什么未验证？
- 提交 SHA、精确文件清单、命令与计数、变异、remaining。

---

## 结果回写区
<!-- 执行对话追加于此，不覆盖已有记录。 -->
