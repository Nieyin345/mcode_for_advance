# T74｜T34 GenOffice 无头能力第一批：create / merge / selection / render 原厂 CLI 薄适配

| 项目 | 值 |
|---|---|
| 编号 | T74（实现 GenOffice 路线图 T34 的独立切片；T34 原编号保留规划索引） |
| 工作包 | ARC-007 FULL-2 / FULL-3（Agent 不打开 GUI 也能完成文档任务） |
| 优先级 | P1 |
| 路线 | L1 `genoffice/packages/cli/src/commands/` 原厂命令 + L2 `main/document/genofficeCli.ts` 宿主路径/子进程围栏 |
| 可派 | **立即**；可与 T64/T65/T69/T70/T73 独立并行 |
| 独占可写 | `apps/desktop/src/main/document/genofficeCli.ts`、新建 `apps/desktop/scripts/t74-genoffice-headless-smoke/`、本任务卡；若必须修改其它文件，只回写阻塞 |
| 禁写 | `main/appControl/*`、`main/modules/*`、`main/orchestration/*`、`packages/contracts/*`（在飞）、`genoffice/*` 上游源码、原生视图/Pane/保存业务 |


## 已核实背景
本仓 `genofficeCli.ts` 已实现 `docsRead`、`pdfRead`、`pdfRender`、`docsApply`、`slidesRead`、`sheetRead`、`slidesApply`、`sheetApply`、`guideOps`、`convertFile`，使用 `requireWorkspacePath`、`invoke` 与失败 envelope。上游 `genoffice/packages/cli/src/cli.ts` 实际注册 `createCommand`、`mergeCommand`、`selectionCommand`、`renderCommand`。路线图仍列 T34 缺口，不应重复已有 apply/convert。

## 开工前必读
1. `audit-ledgers/README.md`、`tasks/GENOFFICE-ROADMAP.md` 阶段 3、`tasks/T28-genoffice-pdf-markdown-html.md`、`tasks/T53-genoffice-sheet-slide-verification.md` 的保真与限制。
2. `apps/desktop/src/main/document/genofficeCli.ts` 全文（含 `invoke`、路径围栏及输出 DTO）。
3. `genoffice/packages/cli/src/cli.ts`、`commands/create.ts`、`commands/merge.ts`、`commands/selection.ts`、`commands/render.ts`；先读原厂命令实际参数/写盘/输入输出语义，不盲写 CLI 标志。
4. `apps/desktop/scripts/genoffice-cli-smoke/main.ts`、`genoffice-format-gates-smoke/main.ts`、`document-read-smoke/main.ts` 的现有保护网。

## 执行内容
1. 建立原厂 CLI 已注册命令与 Mcode 已接调用矩阵：列出 create/merge/selection/render 和可能存在的 txn 真实调用参数、输出 envelope、必要资源；不存在的命令不能伪造成功。
2. **先做测试**：隔离数据目录中构造有效文档样本，证明现有缺调用以及后续可读/可写边界。沿用 `GenofficePorts` 和 `invoke`，不编一套新的子进程执行器。
3. 在 **同一 `genofficeCli.ts`** 内为实际存在且可在无头调用的命令增加最窄的 typed wrapper；每一输入文件及输出目录、临时目录先经已有工作区/物理 symlink 围栏。与 `convertFile` 一致区分覆盖许可、缺资源、取消和写失败；保留原厂格式和参数，不自行计算 Office 文档。
4. 对不支持、必须真实 GUI 或无法验证 CAS 的写操作，**明确拒绝并回写后续连接计划**；不能为了赶进度绕开版本/用户确认，不能把新 wrapper 自动暴露到有风险的外部 RPC。
5. 检验“生成→再读”“合并→重开”“选区→回读”“render→独立回读”，且不修改用户原始文档；特别测试越界输出、指向外部的符号链接、损坏源、原厂 CLI 缺失、AbortSignal 和重复调用。
6. 若将来需要 `app_api_list/describe/call` 暴露，此卡只记录 T49 合并后的最小 API 接线建议，不改 `appControl` 或新的 RPC 合约。

## 验收判据
1. 真实上游命令、参数与包装范围有源码证据；不存在或只支持 GUI 的项目报告 unsupported，不发明假实现。
2. 新增 wrapper 走原 `requireWorkspacePath`/ `invoke`，明确工作区外、软链越界和未授权写入拒绝；无新子进程或权限事实源。
3. 至少一项真实可用操作通过“原厂 CLI 落盘→独立读回”，输入样本不被改写；对其余命令逐一列 PASS/FAIL/unsupported 和日志。
4. 既有 `genoffice-cli-smoke`、`genoffice-format-gates-smoke` 以及相关 document Smoke 不回归，双包 tsc 通过（工作树冲突需如实记）。
5. 对新增 wrapper 的越界/缺资源至少两组源码变异能使红例失败，恢复后 `cmp`/hash 一致。
6. 只提交本卡所属文件，不触碰 GenOffice 上游或 T49 的 RPC，报告下一张 Agent 可调用任务的准确差距。

## 不做
不修改原厂 `file-parse`、`xlsx-gateway` 和转换引擎（规划 T35/T36）；不触碰 T64 `schedulerPrompt.ts`，不抢 T65/T30 渲染端；不将 E1 当真实六编辑器 GUI U1。

## 结果回写区

<!-- 只在下面追加：提交 SHA、旧红→新绿、原始命令/日志、变异/还原字节、剩余未验；不得覆盖本任务正文。 -->


### 2026-10-21 T74 执行回写（T34 无头切片）

**实现 SHA**：087307ba17623436ab262c6b6e27c78ec3314982。只改 apps/desktop/src/main/document/genofficeCli.ts，新增 apps/desktop/scripts/t74-genoffice-headless-smoke/ 三文件。沿用 GenofficePorts、requireWorkspacePath（真实路径/junction 围栏）、invoke（spawnRun、最小环境、超时、AbortSignal、原厂 JSON envelope）；未引入新执行器，未改 vendor、appControl、RPC 或 contracts。

**原厂命令和真实 CLI 参数矩阵**（上游 genoffice/packages/cli/src/cli.ts defaultRegistry() + commands/*.ts）：

| 命令 | 上游真实调用与依赖 | 本卡 wrapper 与结果 |
|---|---|---|
| create | create --type pptx/xlsx/docx/pdf --ops/-spec/-from SOURCE --out TARGET [--force] | createFromFile 限 docx --from HTML fragment 或 xlsx --from CSV/JSON，输出新文件、拒绝 force。**PASS**：真实 HTML→DOCX→独立 docsRead；真实 CSV→XLSX→独立 sheet check；源文件 SHA256 均未改变。PPTX ops/spec 可能间接引用外部文件、Markdown 可能引用图片，PDF 需要 headless app：本卡 **unsupported**。 |
| merge | merge TEMPLATE.docx/pptx/xlsx --data json-file/inline-json/- --out TARGET [--strict] [--force] | mergeTemplate 仅 JSON 对象经 stdin（--data -），默认 --strict，只能新输出。**PASS**：DOCX 模板→新文件→独立 docsRead；模板字节未改变。PPTX/XLSX 分支未单独验真（XLSX 可能需 sidecar），不冒称通过。 |
| selection | selection FILE --json；原厂用 controlEndpoint/controlRequest 请求正在运行的 GenOffice GUI 选区 | **unsupported（真 GUI 依赖，不能无头假造）**。真实 CLI 结果 exit 4 / app_unavailable，测试 PASS。 |
| render | render FILE --out DIR [--page n] [--scale n] [--el ids] [--grid] | 既有 pdfRender 负责单页；新增 renderPdfPages 仅 PDF，允许指定页/全页/缩放，但输出目录必须全新。**PASS**：原厂 PDFium 落 PNG→独立检查 PNG magic 与源 PDF SHA256。非 PDF 渲染需要 GenOffice headless-export/GUI，**unsupported**。 |
| txn | defaultRegistry 没有 txn 顶层命令；commands/txn.ts 是事务结果辅助 | **unsupported（未注册）**。真实 CLI 结果 exit 1 / unknown_command，测试 PASS。 |

**旧红→新绿**：先编写测试，原始构建红（No matching export: createFromFile、mergeTemplate、renderPdfPages）；加入最窄 wrapper 后，真 vendor CLI（genoffice/packages/cli/dist/genoffice.cjs）在随机临时工作区跑出 36/36 PASS。覆盖输出已存在时拒绝而非覆盖、越界输入/输出、相对路径、junction 读写逃逸、损坏模板、不合法 JSON、CLI 缺失时 unavailable、预先 AbortSignal 取消、重复调用、真实落盘和独立读回。没有非法输出，也未修改用户原件。

**回归与类型检查**：node apps/desktop/scripts/run-smokes.mjs genoffice-cli-smoke genoffice-format-gates-smoke document-read-smoke → 3/3 PASS，日志 apps/desktop/.tmp/smoke-runs/1792590714394-31400-IEfB5l；node apps/desktop/scripts/run-smokes.mjs t74-genoffice-headless-smoke → 1/1 PASS（内部 36/36），日志 apps/desktop/.tmp/smoke-runs/1792591000141-4416-OcC8nh。node_modules/.bin/tsc.cmd --noEmit -p apps/desktop/tsconfig.json 以及 -p packages/contracts/tsconfig.json 双包 exit 0；git diff --check 通过。

**两组故障变异**：node apps/desktop/scripts/t74-genoffice-headless-smoke/mutate.cjs → T74_MUTATIONS 2/2 RED_CONFIRMED_AND_BYTE_IDENTICAL。① 撤掉 create 的工作区围栏，越界源/目标、相对路径、junction 断言转红。② 撤掉 invoke 的 CLI 缺失检查，原本 unavailable 变 failed，缺资源断言转红。每次原地变异后 finally 恢复原始 Buffer、逐字节比较；恢复 SHA256=256c48e7e9d12104829169c7944c3a835f0efdfc620ed245c8d14b745816441c。

**下一张 Agent 可调用任务的准确差距**：本卡仅主进程 typed exports，**没有** app_api_list/describe/call、MCP 或 IPC 接线。未来 T49 合并后，应由唯一可信授权入口对 create/merge/render 分别定义严格 DTO、输出目标确认、并发互斥及期望版本/CAS；没有 CAS 前绝不能放行 --force、原始 --ops/--spec 或任意路径型 --data。PPTX 素材、Markdown 图片、XLSX merge、GUI selection、非 PDF render、txn 需要独立能力/资源和回读验收，不在本卡内伪称完成。

**验收**：限定范围 1–6 均达成；selection、txn、非 PDF render 明确 unsupported 属正确拒绝，不是已实现功能。未作危险的 GUI/RPC/覆盖接线。
