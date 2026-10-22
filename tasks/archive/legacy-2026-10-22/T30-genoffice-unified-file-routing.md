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

### T30 执行回写（2026-10-21；E1/E2）

**提交代码**：`0a1dfc387cec6a368a72c9d9e33b26411c54dd14`。仅提交本卡 7 个文件，未推送；开工时 T65 已由 `b41d41e4` 提交，`FileEditor.tsx`、`sessionStoreHelpers.ts` 和其他在飞卡的脏文件未改。最终回写单独提交。

**原厂事实源**：`genoffice/apps/shell/src/main/app-routing.ts` 的 `appForPath`；GenOffice Git `aba076cc9b292461cc419288ee555e524f6250e1`，`genoffice/LICENSE` 为 Apache-2.0。原厂主进程不可直接作为 renderer 模块运行，故在 `packages/contracts/src/genofficeFileRoute.ts` 建立唯一 L2 纯映射 `genofficeAppForPath`，由 IDE 原生视图、`fileEditorKinds`、资料库两个查看入口复用。smoke 将两份**真实实现打包运行并逐输入核对**，防止上游漂移。

| 后缀（大小写不敏感） | 原厂 app | 宿主预览/编辑策略 |
| --- | --- | --- |
| .docx、.odt、.ott | docs | 仅原生视图显式选用且资源/宿主可用时用 docs；其他原有 Office 预览保留 |
| .xlsx、.xlsm、.xls、.csv、.tsv、.ods、.ots | sheets | 原生 sheets 仍经资源/sidecar/工作区校验；库预览保留旧只读行为 |
| .pptx、.odp、.otp | slides | 原生 slides 经能力报告/工作区校验；库预览保留旧只读行为 |
| .pdf | pdf | 资料库/IDE 现有 PDF 阅读/只读预览不变；原生模式需能力就绪 |
| .md、.markdown、.txt、.json | markdown | 原厂归 markdown；Mcode `.txt`/`.json` **继续代码源文本**，仅 .md/.markdown 使用富文档模式 |
| .html、.htm | html | IDE 本地 HTML 浏览器预览仍先验证工作区；原生模式要资源可用 |
| 未命中 | undefined | **拒绝路由**，不再默认误送 docs |

**盘点出的实际冲突**：`GenofficeViewHostPane.editorHostForPath` 原有默认 docs，会把未知名、部分 GenOffice 不认识的旧 OnlyOffice 扩展名误当原厂 Docs；原有枚举漏 `.xls/.csv/.tsv/.ots/.ott/.otp/.txt/.json`，且错误把 `.xltx/.pptm/.potx` 归入原厂表格/幻灯片。资料库两入口通过 `documentKindOf`/DS 表选择显示，此时非同一原厂路由；现在两个查看入口同读 `genofficeAppForPath` 判原厂 app，**不将它冒充当前 renderer 能力/授权**，仍保留 `isOnlyOfficeSupportedPath` 的 DS viewer、PDF 的 `PdfPreview`、Markdown 只读/纯文本策略，避免旧文件静默降级。IDE 的 `FileEditor.tsx` 与旧用户视图偏好/T65 Monaco 选段引用完全不改；拖拽、重复打开、关闭及 pane 几何由原有通道负责，未重写。

**路由≠授权**：纯函数**只认后缀**，不接受外部提供的 MIME 当权限；`DocumentViewHost` 继续独立执行 `withinWorkspace`、磁盘存在、`physicalPath` 等主进程硬闸，以及固定 `genoffice-app://` 页面、原厂视图工厂与 sidecar 能力校验。没有可用资源/对端时 **零 open + 明确错误**。旧 DS `isOnlyOfficeSupportedPath` 是另一个**格式/引擎能力**集合，不是本卡的安全围栏；资料库 linked 外部条目不因识别出 app 而取得本机任意文件打开授权。

**可复跑证据（实际运行，非“全量”）**：
- `node apps/desktop/scripts/genoffice-file-routing-smoke/run.mjs`：**52/52 PASS**，含原厂逐路径对照、六基本格式、大小写、旧扩展、复合扩展、无扩展、伪造及越界、四个入口共享调用、授权与资源 guard；包含真实宿主五种原生 view 的正例。
- **变异 #1 真红**：仅在 esbuild 内存替换共享 DOCX 判据 → 与原厂 app 结果不一致的断言触发；**变异 #2 真红**：仅在 esbuild 内存撤掉真宿主 `withinWorkspace` → 隔离宿主越界文件测试报 FAIL；恢复后两份源码字符串/字节一致、原正例再绿，没有改动真实用户文件。
- `node apps/desktop/scripts/document-view-renderer-smoke/build.mjs`：**172/172 PASS**，包括六种 CLI 资源缺失拒绝、未知后缀拒绝、真实组件挂载/关闭/重复挂载/openPath/Pane 几何/偏好。
- Git Bash `apps/desktop/scripts/genoffice-native-view-smoke/run.sh`：**50/50** host；**6/6** stub；**12/12** AI；**2/2** 缺 sidecar 拒绝；**21/21** 真实 XLSX/PPTX 隔离文件编辑、CAS、保存。
- Git Bash `apps/desktop/scripts/document-view-host-smoke/run.sh`：退出码 **0**；其中 native-docs-boundary **176/176**、native-mcode-docs-ai-sdk **18/18**，其余宿主验证同次退出 0，未冒称每段完整计数。
- Git Bash `apps/desktop/scripts/file-viewer-basedir-smoke/run.sh`：**21/21 PASS**；`file-view-unsaved-smoke/run.sh`：**42/42 PASS**；`frontend-smoke/run.sh`：**49/49 PASS**。
- `pnpm --dir packages/contracts exec tsc --noEmit -p tsconfig.json`：**0 错误**；`pnpm --dir apps/desktop exec tsc --noEmit -p tsconfig.json`：**0 错误**；`git diff --check`：PASS。
- Windows 直接用相对路径调用 3 个 Git Bash 套件时一度因 `source ../lib/esbuild-path.sh` 相对 cwd 失败（**未进入测试**），全部改用**绝对 Git Bash 脚本路径**重跑，3 套分别通过 21/21、42/42、49/49。没有改动其他任务正在修改的 run.sh / 全量 smoke 脚手架。未启动抢占其他在飞任务的 Electron 真机测试。

**精确文件清单**：
1. `packages/contracts/src/genofficeFileRoute.ts`（新增）
2. `apps/desktop/src/renderer/components/ide/GenofficeViewHostPane.tsx`
3. `apps/desktop/src/renderer/components/ide/fileEditorKinds.ts`
4. `apps/desktop/src/renderer/components/library/FilePreview.tsx`
5. `apps/desktop/src/renderer/components/library/FileViewer.tsx`
6. `apps/desktop/scripts/genoffice-file-routing-smoke/run.mjs`（新增）
7. `apps/desktop/scripts/document-view-renderer-smoke/main.ts`

**验收与 remaining**：
- 第 1 条的六格式**路由映射** E1 对照一致、旧原生通路不被此卡覆盖；原有默认 OnlyOffice/只读预览仍按既有产品策略运行，**不表示切换到原生就是完整可编辑**。
- 第 2 条有五类原生工厂/资源与外部工作区拒绝、Docs 现有边界的隔离测试证据；没有跑遍六个 app 在**真实 Electron** 中的工厂、拒绝与渲染组合，必须另记 U1。
- 第 3 条已有旧用户文件打开/预览/关闭/Pane 的代表性无头回归 **E1**，但真实用户文件树、资料库 linked/attached、拖拽、关闭重开及 Pane 切换的**整条 Electron U1**未复验，**不能声明整条充分验收**。
- 第 4 条仅声称上述实跑且存在的相关代表性套件；`document-view-open`、`document-view-electron`、`document-view-vendor-page` 等**真 Electron**套件本轮未跑；不声称全部 `document-view-*` 全绿。
- 第 5 条双包 tsc PASS；第 6 条两条变异确实在内存故障注入时 RED，源码原样恢复。
- 第 7 条逐项列未完成的 **U1**：① 六个 GenOffice GUI 原厂界面逐格式打开并可视化编辑、Pane 操作和重开；② 六种原厂编辑器 AI 经 Mcode 三引擎的真实在线回合与选区/批准；③ 六格式真实 GUI 编辑→保存→退出/重启→重开的持久化、PDF 的只读/注释和字节/CAS 检查。现有无头 Docs/Sheets/Slides 片段不能替代这些 U1；继续由后续 T71/相关卡真实验收，**本卡不越界实现**。
