# O20｜Mcode 内建 Sheets：可选插入引擎延迟加载

- Status: **2026-10-25 有界交付**。原厂生产 Sheets bundle 入口 JS -814,998 B（约 -3.92%），真实 Electron 单元格编辑→保存→OS 重启→重开经无截图镜像旅程 PASS；来源补丁 30/30、4 关联 smoke PASS。图标/公式对话框的**真实用户打开动作**、正常截图型 T7 全链、实际首屏延迟/RSS 节省仍待完整验收。
- 归属：ARC-007 / O16-O19。仅对 GenOffice 内建 Sheets 的 **非核心、按需辅助功能** 做 JS 启动接缝优化。没有第二个 Office 主窗口、第二个 AI SDK、替代保存路径或 UI 重构。

## 根因与有界修复

GenOffice `genoffice/apps/sheets/src/renderer/App.tsx` 静态 import `IconsDialog` 和 `EquationDialog`。二者仅在用户通过 Insert→Icons / Insert→Equation 请求时显示，但其依赖分别包含 `@fluentui/react-icons` 整套可选图标图库、`react-dom/server` SVG 生成以及 `@genoffice/docx-engine/math` 公式转换。普通表格启动根本不需要加载/解析这些模块。

修复：保持原有 `iconsDialogOpen` / `equationDialogOpen` 开关、picture insert 的 `handleInsertIconImpl(visualContext(),...)` / `handleInsertEquationImpl(visualContext(),...)` 完全不变；替换两个静态 import 为 React `lazy(() => import(...))`，在原条件组件节点内附加 `Suspense fallback={null}`。不会改变 Univer 核心计算、XLSX Rust worker、协同文件围栏或审批准入；首次**真正打开功能**时才编译并载入其依赖，独立版原厂仍有原功能。

## 生产构建字节对比（同一台 Windows 机器）

- 修改前 `genoffice/apps/sheets/out/renderer/assets/index-96T-iclc.js`: **20,774,701 B**。
- 修改后 `npx electron-vite build`（`genoffice/apps/sheets` 工作目录）产出 `index-2zBpTQpA.js`: **19,959,703 B**。
- **入口减少 814,998 B（3.92%，未压缩 JS 原始字节）**。
- 新按需块：`IconsDialog-BOIcZN36.js` **646,903 B**；`EquationDialog-P_O3KBVS.js` **165,857 B**。
- 该数值**不能冒充**压缩下载量、真实首帧快了多少毫秒、或内存 RSS 已减少多少 MiB，也不代表 20MB 主包的 Univer 网格/公式引擎已完全拆分。

## 真实功能与安全验收

- 原厂 `npm run typecheck -w @genoffice/sheets` → PASS；`npx electron-vite build` → PASS。GenOffice fork 产物仍是原厂 Electron/Vite 六家资源，没有重新写编辑器。
- 原始 `node apps/desktop/scripts/t7-genoffice-u1/run.mjs --only=sheets-open-edit-save-reopen` 在真实 Windows Electron 中开表、网格/名称框/AI UI 负断言 PASS，但**停在第 8 步截图**：远程显示面返回 `Current display surface not available for capture`，**未到保存步骤、不能把该 T7 判 PASS**。证据 `.tmp/electron-u1/2026-10-25T07-13-26-227Z`。
- 为不修改 T7 原判据，也不绕过主产品文件安全逻辑，新增独立 opt-in `sheets-nonvisual-edit-save-reopen` 旅程，它直接从现有 `sheetsJourney` 复用每一个原生用户输入/保存/独立 XLSX 数据读取/关闭/重启/重开操作和磁盘 SHA 判据，**仅过滤 screenshot 和 screenshotChanged 步骤，声明 `visual:false`**，不声称具备视觉 E2E 证据。命令：
  `node apps/desktop/scripts/office-perf-u1/run.mjs --only=sheets-nonvisual-edit-save-reopen` → **PASS**（2 个真实 OS Electron 进程，`.tmp/electron-u1/2026-10-25T07-15-35-838Z`）。内存中的编辑通过真实网格键入，保存通过实际按钮，磁盘侧独立 XLSX 读取器验证写入，重开后继续验证。
- 真实 U1 中偶见 Univer 内部 `[redi]: Expect 1 dependency ... SheetsScrollRenderController2 but get 0` renderer console error，以及重复 UI 插件注册 warning。这次未阻断保存或重开，但这**不是已修复**的稳定性问题，后续必须单独复现核验。
- Vendor `npx vitest run apps/sheets/tests/sidecar-idle-retirement.test.ts apps/sheets/tests/close-guard.test.ts ...` → **19/19 PASS**（脚本引用的第三文件不存在/未计入结果，仅实际两个测试文件），其他 Univer 实用功能仍待专项验证。
- Mcode 关联 `node apps/desktop/scripts/run-smokes.mjs genoffice-source-smoke genoffice-editors-release-smoke genoffice-native-view-smoke office-perf-smoke` → **4/4 PASS**，`apps/desktop/.tmp/smoke-runs/1792912651087-10704-jIZ3X7`；Desktop 与 Contracts 的 `tsc --noEmit` PASS。
- `set MCODE_INCLUDE_GENOFFICE_BUNDLE=1&& node apps/desktop/build/verify-genoffice-upstream.cjs` → **30 patches PASS**。
- Vendor 提交 `4c75d53afa5a2487766c38c71582b775f043c8f3`，parent `6a5a5cbf23e2e0ba608055a3138ae4e2b8665b67`，tree `38aa7ebc46c8edc9ffaa467e9640d47156e7336a`；patch `patches/genoffice/0030-perf-sheets-lazy-icon-equation-tools.patch` 3253 bytes、SHA256 `6693a818dde049566bc780731d8e912db19dde5fb9d42161c7b42f741413c175`。

## 下一步

- 单独在可用显示面验证用户点击打开「图标」「公式」后 chunk 加载、内容插入并保存/重开；这次只有生产编译/类型/常规 XLSX 旅程证明入口不退化，不冒称两个可选功能都完成 GUI 交互 U1。
- 以 O18 多文档驻留实测基线做改前改后相同夹具/机器的 P50/P95 启动延迟、CPU 主线程忙时间和 renderer RSS 对照。
- 仍在 19.96 MB 入口中的 Univer 网格/公式/数据有效性等是**必要核心依赖**；下一批应按依赖图、功能配置及语义验证做逐项分包，不可盲目禁用算式、批量表格或未保存事务。

### 提交前追加验收

- 在正确的 `genoffice` workspace 根目录重跑 `npm run typecheck -w @genoffice/sheets`：**PASS**。先前一个串联命令从 Mcode 根目录错误调用 vendor workspace 导致 `No workspaces found`，不是 TypeScript 产品失败。
- `node apps/desktop/scripts/office-perf-u1/run.mjs --only=six-editor-residency`：**真实 Electron PASS**（`.tmp/electron-u1/2026-10-25T07-21-06-620Z`），同一 Mcode 宿主内六格式原生启动、隐藏后复用视图与关闭均未退化。该旅程没有验证首次点击插入图标/公式的可选功能，此点仍未完成。
- 首次非截图旅程在 renderer console 仍有一次 `SheetsScrollRenderController2` 依赖注入异常，虽然保存与重开 PASS，但该日志须归为未完成的潜在 Sheets 稳定性隐患，不应据此声称无异常。
