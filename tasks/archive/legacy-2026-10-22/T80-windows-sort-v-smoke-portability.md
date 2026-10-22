# T80｜T69 环境阻断 A1：22 套 Smoke 的 Windows sort -V 入口修复

| 项目 | 值 |
|---|---|
| 编号 | T80 |
| 类型 | T52/T68 / 测试基础设施，不是产品功能 |
| 优先级 | **P0**；修通已有测试保护网，避免 22 套构建前直接红 |
| 复用路线 | L1 既有 `scripts/lib/esbuild-path.sh` 缓存/可执行解析器，不再每套复制 `find | sort -V` |
| 可派 | **立即**，与 T81 按 22+27 个不重叠 run.sh 切片并行 |
| 独占可写 | T69 60 项矩阵中**A 类 sort -V 的 22 个对应** `apps/desktop/scripts/<suite>/run.sh`、`apps/desktop/scripts/lib/esbuild-path.sh`（必要最小修改）、本任务卡；不能改其它脚本/源码/测试断言 |


## 旧红例/问题定位
T69 独立复跑 `arc005-focus-ownership-smoke/run.sh` 得到 `-V系统找不到指定的文件。`，T68 60 fail 中 22 条为同源。示例 `scripts/arc005-focus-ownership-smoke/run.sh` 使用 `find ../../node_modules/.pnpm -path ... | sort -V | tail -1` 解析 esbuild。现有统一 `scripts/lib/esbuild-path.sh` 已有 `MCODE_ESBUILD`、共享缓存、pnpm glob、find 后备和 npx fallback，但**其自身**也有 `sort -V`，不能只机械替换引用而保留相同错误。

## 开工前必读
1. `audit-ledgers/README.md`、`tasks/T69-60-smoke-failure-triage.md` 完整 60 表与最后 A1 建议、T52/T68 回写。
2. `apps/desktop/scripts/lib/esbuild-path.sh` 与 T69 表中 22 套各自 `run.sh`；理解引导变量、工作目录、ESBuild 路径+回退链和 Windows/Git Bash 差异。
3. `apps/desktop/scripts/run-smokes.mjs` 的调用/缓存、工作目录与轻重套限流规定。

## 执行步骤
1. 以 T69 记录的 **22 个** exact suite 为范围清单，先复现一个失败 `-V` 的既有红例及工具版本/调用命令；禁止扩大到目录下所有脚本。
2. 使用已有 `esbuild-path.sh` 解析功能，让 22 套复用同一信任路径，必要时修其 `sort -V` 在目标 Windows 上的可移植实现。**不能**将排序功能改成挑“任意一个旧 esbuild”，且必须保留环境直给、缓存、版本选择和后备。仅为测试基础设施，不改 `run-smokes.mjs`。
3. 测同一批套件真正完成其原有断言，先跑代表性 light suite，再有界批量执行；环境不具备的分类计数并给详细原因。不能把不再出现 shell 首错视为整体 PASS。
4. 增加一个最小负控：恢复错误 `sort -V` 或刻意喂入两个不同版本路径，确保现有测试或新专项断言真正识别错误选择，恢复后逐字节相同。
5. 保证所有 22 套 `run.sh` 保留原有 `dataRoot`、alias、脚本出入参、cleanup trap、变异测试，不能删除测试或跳过不适用部分。

## 验收判据
1. 22/22 个目标入口不再因 Windows `sort -V` 首错失败；有逐 suite 的运行结果与原因记录（仍 fail 的明确分类）。
2. 原始断言没有减少；代表性套件真正 exit 0，所有 22 套在安全非竞争环境中尽可能绿，不能造全绿。
3. helper 在 Linux/macOS/Windows 对版本解析等价且 fail-closed，不依赖 WSL/Git Bash 指定一个机主固定路径。
4. 负控恢复旧错误选择→明确红例，源码还原后 HASH 相同，最后双包 TS/专项测试不回归。
5. 只提交 22 对应 run.sh + 共用 esbuild helper + 本卡，不抢 T81 的 node_modules helper 或 T49/T64/T65 产品代码。

## 不做
不修 Node-RED、GenOffice、设置页/模块权限业务功能；T69 的 27 项 ln 问题由 T81 处理，不在这里交叉编辑。

## 结果回写区

<!-- 执行对话仅追加证据、提交 SHA、实际命令/计数、原红→新绿、变异/恢复、未验风险。 -->


### 2026-10-21 T80 执行结果（E1 动态 Windows smoke，E2 shell/版本比较）

- **限定文件**：仅 T69 A1 表列明的 22 个 `apps/desktop/scripts/<suite>/run.sh`，加共享 `apps/desktop/scripts/lib/esbuild-path.sh` 和本任务卡；T81 的 27 个 `ln -s` 入口、`run-smokes.mjs`、产品源码及原断言均未由本任务编辑。开工时仓库已有其他执行对话的未提交编辑，不将那些文件纳入本任务提交。
- **原红（E1）**：在 Windows `apps/desktop` 中执行 `D:\anaconda1\Library\usr\bin\bash.exe scripts/arc005-focus-ownership-smoke/run.sh`，旧入口 `find ... | sort -V | tail -1` **exit 1**，stderr `-V系统找不到指定的文件。`。系统 `where sort` 首个是 `C:\Windows\System32\sort.exe`，其不支持 GNU `-V`。
- **实现**：22 套按原有工作目录 `source "scripts/lib/esbuild-path.sh"`，调用 `mcode_esbuild`，保留原测试参数、alias、dataRoot、cleanup trap 和全部断言。helper 保留 `MCODE_ESBUILD` 显式可执行文件、共享缓存、pnpm 顶层 glob、递归 find 和 npx 回退；仅将两处 `sort -V` 改为 Node 实现的 semver 高版本筛选（数字段及预发布段均比较，无法解析时不任选旧版本），`npx --no-install` 且 offline，避免未授权下载以及把 `"npx esbuild"` 当单个可执行文件的旧缺陷。
- **版本路径专项（E1）**：在同一 Windows Bash 中经 `source scripts/lib/esbuild-path.sh` 调 `_mcode_latest_esbuild`，将模拟路径 `esbuild@0.9.99`、`esbuild@0.10.0-beta.2`、`esbuild@0.10.0-beta.10`、`esbuild@0.10.0` 混排输入，输出严格为 `esbuild@0.10.0`。不要求或硬编码机主 Git Bash、WSL 路径；运行入口通过现有 `MCODE_TEST_BASH` 配置。Linux/macOS 本机未提供真实操作系统实跑，等价性由 POSIX Bash + Node 内置解析的源码与合成排序用例支持，不冒充跨 OS E1。
- **最终完整 22 套复跑**：在 `apps/desktop` 执行 `MCODE_TEST_BASH=D:\anaconda1\Library\usr\bin\bash.exe MCODE_SMOKE_JOBS=2 MCODE_SMOKE_HEAVY_JOBS=1 node scripts/run-smokes.mjs <下面22套>`（Windows cmd 用对应 `set` 形式传环境变量）；日志 `apps/desktop/.tmp/smoke-runs/1792590847587-10756-8IL1Qn/`；**21 PASS / 1 FAIL**，**22/22 均无 `sort -V` 首错**，且全部进入原打包/断言路径。

  | Suite | 最终结果 | 详情 |
  |---|---|---|
  | arc005-file-picker-error-smoke | PASS | 原断言执行，exit 0 |
  | arc005-focus-ownership-smoke | PASS | 10/10，exit 0 |
  | arc005-gesture-runtime-smoke | PASS | 原断言执行，exit 0 |
  | arc005-library-picker-search-smoke | PASS | 原断言执行，exit 0 |
  | arc005-picker-layer-smoke | PASS | 原断言执行，exit 0 |
  | arc005-recorder-input-smoke | PASS | 原断言执行，exit 0 |
  | design-tokens-smoke | PASS | 原断言执行，exit 0 |
  | document-router-smoke | **PASS（尾项收尾）** | T30 后的旧 `documentKindOf` 源码断言已按共享 `genofficeAppForPath` 语义修正；指定命令 **133/133**，真实 `FileViewer` 组件回归 **25/25**；详见下方尾项收尾记录 |
  | engine-bootstrap-integrity-smoke | PASS | 原断言执行，exit 0 |
  | engine-secret-integrity-smoke | PASS | 原断言执行，exit 0 |
  | engine-secret-path-safety-smoke | PASS | 原断言执行，exit 0 |
  | flow-migration-smoke | PASS | 原临时 dataRoot、备份与原断言，exit 0 |
  | flow-snapshot-isolation-smoke | PASS | 原断言执行，exit 0 |
  | mc035-egress-isolation-smoke | PASS | 原断言执行，exit 0 |
  | module-extension-lifecycle-smoke | PASS | 原断言执行，exit 0 |
  | module-protocol-integrity-smoke | PASS | 原断言执行，exit 0 |
  | vscode-l1-smoke | PASS | 原断言执行，exit 0 |
  | workflow-engine-bridge-smoke | PASS | 原断言执行，exit 0 |
  | workflow-engine-runtime-smoke | PASS | 原隔离 dataRoot + 原断言，exit 0 |
  | workflow-engine-selection-smoke | PASS | 原隔离 dataRoot + 原断言，exit 0 |
  | workflow-extension-seams-smoke | PASS | 原断言执行，exit 0 |
  | workflow-native-load-smoke | PASS | 原隔离 dataRoot + 原断言，exit 0 |
- **负控（E1）**：先在已修复 `arc005-focus-ownership-smoke/run.sh` 临时把 `source` 精确改回旧 `find ... | sort -V | tail -1`，相同 Windows Bash 立即 **exit 1**、同样 `-V系统找不到指定的文件。`；恢复原 `source` 后在最后 22 套全量重跑中该套 **PASS**。恢复前后此文件 SHA256 逐字节相同：`793f135956c54bc84bdd494e3f24116d58400067c7ec80358f50678447443255`。
- **不回归（T80 原执行批次）**：`node node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json` exit 0；`node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json` exit 0；`git diff --check -- apps/desktop/scripts` exit 0。原 22 套批次当时为 21 PASS、`document-router-smoke` 124/125；本次只定向重跑 PDF 路由相关套件，未重跑完整 22 套批次。
- **按判据回写**：① T80 原执行批次的 Windows shell 首错已清；② PDF 路由尾项现已通过独立定向复验，但本次未重跑完整 22 套批次；③ Windows E1 + 语义版本合成验证已做，Linux/macOS 原生 E1 **未覆盖**；④ 负控红→恢复 hash 一致、双包 TS 绿，已达成；⑤ T80 原提交边界未改动。

### document-router-smoke PDF 路由尾项收尾（2026-10-21）

- **代码提交**：`e9e2dbf53c27bbead3171654ea0ac812323fbfcd`（仅测试文件，不改产品路由）。
- **根因**：T30 将原厂 app 识别收敛到 `genofficeAppForPath`，旧结构断言却要求 `FileViewer` 必须直接调用 `documentKindOf(visibleName) === "pdf"`。这测试的是旧实现形状，而不是 PDF 的实际显示行为。
- **真实 MIME 边界**：项目文件 `readBinaryGuarded` 使用 `BINARY_MIME[ext] ?? "application/octet-stream"`，其 MIME 表只覆盖图片，所以项目 `.pdf` 可真实返回 `application/octet-stream`；资料库 `readEntryFile` 对 `.pdf` 映射 `application/pdf`。两条来源都已在 smoke 中核对。共享路由令 `.pdf` 在通用 MIME 下仍进入 `PdfPreview`。
- **定向实测**：`node apps/desktop/scripts/run-smokes.mjs document-router-smoke` **133/133 PASS**；`node apps/desktop/scripts/genoffice-file-routing-smoke/run.mjs` **52/52 PASS**（含两条真实 RED 变异）；`node apps/desktop/scripts/run-smokes.mjs file-viewer-basedir-smoke` **25/25 PASS**，实际驱动 `FileViewer` 并检查 PDF bytes 与子文件 path 传给 `PdfPreview`。
- **未知后缀 / MIME 冲突**：未知后缀 + 通用 MIME 不进入 PDF/Office；未知后缀 + `application/pdf` 按内容 MIME 回退到 `PdfPreview`；`.pdf` + `application/octet-stream` 仍走 `PdfPreview`；`.pdf.exe` 不冒充 PDF；未知后缀不默认走 Docs。
- **产品修复判断**：未发现需要改动产品代码的缺陷；保留现有共享路由和 MIME 回退，不恢复重复格式判断。
- **本尾项未达成判据**：无。**范围外未复验**：T80 的完整 22 套批次本次没有重跑，Linux/macOS 原生 E1 仍未覆盖。
