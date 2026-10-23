# T31｜三处既有失败挡住 `run-smokes --all`，全量基线跑不起来

- Status: ready-for-agent
- Category: **bug（测试基础设施）**
- Priority: **P0 工具链**
- Depends on: none
- Exclusive writable files: `apps/desktop/scripts/genoffice-file-routing-smoke/`、`apps/desktop/scripts/release-readiness-smoke/check-genoffice.cjs`、`apps/desktop/scripts/genoffice-source-smoke/`、相关夹具。逐个确认后写进回写区。

## Required Skills
- `mcode-smoke`: 理解 `run-smokes.mjs` 的发现规则与单套约定。
- `code-review`: 判断某条失败是「夹具过时」还是「真的坏了」，不要一律放宽断言。

Read before work: `CLAUDE.md`、`apps/desktop/scripts/run-smokes.mjs`、`apps/desktop/scripts/smokes-for.sh`、T10 与 T11 的回写区（记录了这三条）。

## T10 / T11 独立确认的三处既有失败

### ① `genoffice-file-routing-smoke` 没有 `run.sh`，挡住 `--all`

T11 原话：
> `run-smokes.mjs --all` 目前在 `genoffice-file-routing-smoke/run.sh`（T30 交付，只有 `run.mjs`）处拒绝启动

`run-smokes.mjs` 的发现规则是目录名匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*-smoke$/`，然后**执行 `run.sh`**。只有 `run.mjs` 就没有入口。

**修法**：补一个 `run.sh`（参照 T87 刚补的那个）。

### ② `release-readiness-smoke/check-genoffice.cjs` 在 afterPack 夹具上失败

> 抛 `native CLI/dependency/PDFium integrity manifest is missing or invalid`（HEAD 复跑同样 exit 1）

**要先判断**：是夹具过时（afterPack 契约变了），还是检测逻辑真的漏了什么。

### ③ `genoffice-source-smoke` 在 fixture lock 上失败

> 抛 `GenOffice source lock differs from …`（HEAD 复跑同样 exit 1）

同样要先判断：是 fixture 该更新，还是 lock 真的不一致。

## 工作顺序

**第一步：先让 `--all` 能启动。**

补 `run.sh`（①）。这是纯机械的，先做。

**第二步：逐条诊断 ②③。**

每条都要回答：**这个失败是「测试过时」还是「产品有问题」？**

- 若测试过时 → 更新夹具，**说明产品哪里有意的变更导致它过时**
- 若产品有问题 → **停下报告**，另开卡修，本卡不修产品

**不许为了让套件变绿而放宽断言。** 这是本仓库的硬规矩。

**第三步：跑全量，给出真实基线。**

`bash apps/desktop/scripts/run-all-smokes.sh` 跑完，给出：
- 总套数
- 通过 / 失败
- **每一条失败的原因**（不许只给数字）

如果还有别的既有红，一并列出。

## 验收判据

1. `run-smokes.mjs --all` 能启动，不再卡在找不到 `run.sh`。
2. ②③ 各给出诊断结论（测试过时 / 产品有问题）。
3. 全量跑完，给出**真实基线**：总套数、通过数、失败数，以及每条失败的原因。
4. 若修了夹具，说明产品哪里变了导致它过时。
5. **不得**为了让套件变绿而放宽断言。
6. 双包 typecheck 通过。

## 边界

- **不改产品源码**。若诊断出产品问题，停下报告。
- **不改** `run-smokes.mjs` 的发现规则（那会影响所有套件）。
- **不改** T27/T28/T19 正在改的文件。

## 结果回写（2026-10-23）

### 起点与边界

开工 HEAD `4de708f2`。工作树原有 10 项他人未提交修改（`.aoci/baseline.json`、`.gitignore`、`document-view-host-smoke/` 三项、`maint-m35-smoke/pickers-prelude.ts`、`orchestration-ipc-smoke/run.sh`、`release-readiness-smoke/check-reviewed.cjs`、`src/main/ipc/settingsTransfer.ts`、`src/main/workflowEngines/nativeLibraryLoad.ts`）全部保留，未 reset/stash/clean。本卡只写：

- `apps/desktop/scripts/genoffice-file-routing-smoke/run.sh`（新建）
- `apps/desktop/scripts/release-readiness-smoke/check-genoffice.cjs`
- `apps/desktop/scripts/genoffice-source-smoke/main.cjs`
- 本卡

未改 `run-smokes.mjs`、未改任何产品源码、未碰 `build/vendor-licenses/`。诊断与变异验证期间临时改过的产品文件（`verify-genoffice-upstream.cjs`、`verify-genoffice-editors-after-pack.cjs`、`stage-genoffice-resources.cjs`）全部逐字节还原并 `git status` 复核干净。

### ① `genoffice-file-routing-smoke` 缺 `run.sh` —— 已修

新增 `apps/desktop/scripts/genoffice-file-routing-smoke/run.sh`，与 T87 同款极简入口：

```bash
#!/usr/bin/env bash
set -euo pipefail
node "$(dirname "$0")/run.mjs"
```

`run.mjs` 本身不需要 cwd、不写仓库（只在 OS temp 建目录）。实跑 **52/52 PASS（2 red mutants verified）**，两个内存变异都真的变红。`run-smokes.mjs --list --all` 现为 **541 套，逐套 `run.sh` 存在性检查 0 缺失**，`--all` 不再在启动处拒绝。

### ② `release-readiness-smoke/check-genoffice.cjs` —— 结论：**测试过时**（产品是有意的加强）

**失败点**：`check-genoffice-resources.cjs` → `verifyPackagedGenofficeEditorAssets` → `verifyPackagedNativeRuntime` 抛 `native CLI/dependency/PDFium integrity manifest is missing or invalid`。

**产品哪次变更导致过时**：

1. **`ab9149eb`（T76，2026-10-21）** 给 afterPack 增加 `cliSha256`/`cliDependenciesSha256`/`pdfiumWasmSha256` 三项必需完整性字段，并要求 `hashFile(cli)`/`hashResourceTree(deps)`/WASM magic 逐项匹配；staging 侧同步在 `availability.json` 里写这三项。
2. **`239eb863`（T23，2026-10-23）** 又加了 Docs 渲染器的 patch-0013 ACK 标记检查（`aiToolResult`/`toolResultAck`）。

夹具在这两次变更后仍用**手写重声明**的 `availability.json`（只有 `format/bundled/editorsBundled/editors/editorAssetsSha256`），既没有 T76 的三个摘要字段，Docs 渲染器也没有 0013 标记。产品门禁按设计拒绝这种「声明为完整打包、却缺少完整性清单」的包 —— **不是产品坏了，是夹具停留在 T76 之前的旧契约**。

**修法（只补夹具，不放宽断言）**：

- 所有合成 `availability.json` 改为**以真实 staging 产出的 marker 为底、只覆盖需要变动的字段**（`markerWith()`）。这样夹具继承真实的 `cliSha256` 等字段，afterPack 的完整性校验被真正执行到，而不是被绕过。
- 六个编辑器夹具里 docs 的 `app.js` 带上 0013 两个标记（其余五个不需要）。
- 额外**新增**一条断言：把 docs `app.js` 换成无 0013 标记的旧构建、并重新盖章 digest，门禁仍必须以 `0013|aiToolResult|toolResultAck` 拒绝 —— 证明 ACK 检查在这个套件里是承重的，而不是只靠兄弟套件覆盖。

**验证**：`release-readiness-smoke` 全套 **run.cjs + check-window + check-libraries + check-reviewed + check-genoffice 五段全绿**，`check-genoffice.cjs` 单独 **23/23 PASS**。

**变异证据**：临时删掉 `verify-genoffice-editors-after-pack.cjs` 里的 `assertDocsRendererHasAckTransport(...)` 一行 → 新断言变红（`ACK assertion: LOST`，exit 1）；`sha256` 逐字节还原后重新全绿。

**没有放宽任何断言**：原夹具会**跳过**整个 `verifyPackagedLicenseAssets` 分支（因为 marker 没有 `licenseBundleVersion`，afterPack 走 legacy 早返回）；改为继承真实 marker 后，license 分支现在也被真正执行。

### ③ `genoffice-source-smoke` —— 结论：**测试过时**（lock 契约 v1 → v2 是有意的）

**失败点**：`assertUpstreamRevision` 在第一条正向用例就抛 `GenOffice source lock differs from the pinned upstream/base/final-tree/six-app contract`（`verify-genoffice-upstream.cjs:71`）。

**产品哪次变更导致过时**：`fe6ee970`（T87，2026-10-22）把 `verify-genoffice-upstream.cjs` 从 `mcode.genoffice.upstream-lock.v1`（`{format, repository, revision, license, editors}`）重写为 **v2**：新增 `baseRevision`/`expectedTree`/`approvedPatch`/13 条 `patchSeries`（每条含 revision/parentRevision/sha256/bytes/subject），并要求 **整个 lock 与写死的常量逐字段相等**。旧套件的合成 Git 仓库只能产出 v1 形状的 lock，正向路径在 v2 下永远不可能通过 —— 这不是产品回归，是夹具没跟上 T87。

**独立佐证（产品契约本身是对的）**：

- 真实 vendor checkout：HEAD `635dee2f…`、tree `532e6727…`、`c633..HEAD` 恰好 14 个提交（1 个 approved patch + 13 个 patch series）、`status --porcelain` 干净，与 `apps/desktop/build/genoffice-upstream.lock.json` 完全一致。
- **T87 套件对真实 checkout 95/95 PASS**（`t87-genoffice-provenance-license-smoke`），它也复用同一个 `assertUpstreamRevision` —— 证明「产品有问题」不成立。

**修法（重写夹具，断言不减弱）**：

- Section A（无 vendor 也能跑）：opt-in 语义三条原样保留。
- Section B（无 vendor 也能跑）：以**真实 lock** 为底做 10 类畸形（v1 格式、少一个 editor、改 final revision、改 tree、改 approved patch 的 subject/parent/paths、删一条 patch、重排 patch），逐条必须被 v2 契约拒绝 —— 这正是旧夹具踩坑的那条分支，现在被显式覆盖。
- Section C（vendor 在时）：clone 真实 `genoffice/` 到 OS temp，逐项验证并恢复：
  - 真实 pinned lineage 正向通过（base/revision/tree/patchCount/editors）；
  - patch 字节篡改 → SHA-256 拒绝；dirty tracked 文件 → 拒绝；`package.json`/`package-lock.json` 漂移 → 拒绝；根级未跟踪脚本 → 拒绝；`apps/` 下未跟踪源码 → 拒绝；**被 ignore 但可被相对 import 的编辑器源码 → 拒绝**（通过 `.git/info/exclude` 注入，避免脏化工作树）；少一个 renderer 源根 → 拒绝；缺 NOTICE → 拒绝；额外提交 → 拒绝；每条之后 `status` 必须重新干净并正向通过；真实 vendor checkout 前后 HEAD/status 不变。
- vendor 不在时 Section C **显式打印 skip 行且不计数**，绝不假装验过（沿用 `genoffice-vendor-freshness-smoke` 的既有约定）。

**结果**：`genoffice-source-smoke: 26/26 PASS`。

**变异证据（产品源码临时改、`sha256` 逐字节还原并复核）**：

| 变异 | 结果 |
|---|---|
| M1 删 verifier 的 ignored-source 拒绝分支 | 红：`ignored-but-runtime-loadable original editor source cannot evade HEAD pin` 及其后多条断言消失，exit 1 |
| M2 删 verifier 的 dirty-tree 拒绝 | 红：11 条断言消失，exit 1 |
| M3 只删 lineage 检查 | 仍绿 —— **不是假绿**：最终 HEAD 检查同样能拒绝额外提交（纵深防御） |
| M4 只删 final-HEAD 检查 | 仍绿 —— 同上，lineage 检查兜住 |
| M5 同时删 lineage + final-HEAD | 红：`extra commit after the pinned final HEAD is rejected` 丢断言，`Missing expected exception`，exit 1 —— 证明该断言在两层防护都在时由任一层承重，且断言本身有效 |

每次变异后均 `sha256` 复核源文件回到原值（`8768f3e5…`），`git status -- apps/desktop/build/` 为空。

### 全量基线（`bash apps/desktop/scripts/run-all-smokes.sh`，提交前工作树）

```
Running 541 suites (light ×2, browser ×1)
Smoke summary: 518 pass, 23 fail (541 suites)
```

- **总数 541**，通过 **518**，失败 **23**。
- 本卡三套全部 **PASS**：`genoffice-file-routing-smoke`、`genoffice-source-smoke`、`release-readiness-smoke`。
- 与 T10 记录的 24 失败对照：`genoffice-source-smoke`、`release-readiness-smoke` 两条已转绿；其余 23 条为**预先存在的红**，本卡范围内未处理（原因见下）。

**23 条失败及原因**（逐条读过各自日志）：

**A. esbuild 打包失败 —— 15 套，同一个根因**（`agent-guide`、`claude-ipc`、`custom-ui-refresh`、`extension-authoring`、`host-mcp-server`、`host-mcp-stdio`、`memory`、`panel-screenshot`、`scene-apply`、`scene-crash-resume`、`watch-templates-cas-electron` 等）：

```
X [ERROR] Could not resolve "@main/document/genofficeSheetsEntry.js"
X [ERROR] Could not resolve "@main/document/genofficeSlidesEntry.js"
X [ERROR] Top-level return cannot be used inside an ECMAScript module
```

`dc974b2c`（T29）在 `genofficeNativeVendor.ts` 里 import 了 `@main/document/genofficeSheetsEntry.js` / `genofficeSlidesEntry.js`，这两个是 **electron-vite 配置里的 alias 虚拟模块**（`electron.vite.config.ts:257/261`），仓库里没有对应源文件，裸 esbuild 的测试 runner 没有这个 alias，于是在打包阶段直接失败。属于**产品 import 与无头 smoke 工具链的契约缺口**，不是本卡三处之一，需要另卡统一在 smoke runner 里补 alias 或在源码里换可解析的入口。

**B. `mcode-admin-smoke`**：stub 缺导出 —— `dataRoot.ts` 无 `migrateLegacyIntoDataRoot`、`window.ts` 无 `updateTitleBarOverlay`、`pluginManager.ts` 无 `getEnabledPlugins`/`getPluginMcpServers`。产品接口变了，stub 没跟。

**C. `mcp-endpoint-smoke`**：`No loader is configured for ".node" files: sherpa-onnx…node` —— 原生模块没有 `--loader:.node=copy`。

**D. `maint-m35-smoke`**：`No matching export in stubs/reactEffects/index.ts for import "default"`。

**E. `module-contributions-smoke`**：`TypeError: fetch failed / bad port` —— 浏览器/HTTP 夹具端口问题。

**F. `module-permissions-smoke`**：`T48 baseline failed`（其内部基线日志失败，详情见 `.tmp/module-permissions-*/baseline.log`）。

**G. `settings-panels-electron-smoke`**：真实 Electron 里 `contributionsOf` 读 `undefined.flatMap`；`reloadCustomModels`/`reloadLspLanguages` 也抛。渲染端 contributions 数据源问题。

**H. 断言级失败 2 套**：`renderer-pure-smoke` 319/320（`MC-098: readMonacoSelection 返回 lines`）；`settings-panel-smoke` 153/154（`toggleEnabled 检查 {ok:false} 并走 toast 报错`）。

**I. `aoci-index-smoke`**：2 条悬空引用（`code:docs/planning/Status-and-Plan.md`、`code:…WorkflowCanvas.tsx`）——AOCI 索引陈旧，非代码门禁。

**J. `approval-bridge-parity-smoke`**：`ReferenceError: dispatchCodexExternalToolCall is not defined`。

**K. `capability-smoke`**：`core.app.call` 在 declared/file 表里有、host 表里缺（MC-099 E1 三处同源不一致）。

**L. `markdown-mode-smoke`**：`genofficeAppForPath is not defined`（1/32）。

### 双包 typecheck

- `npx tsc --noEmit -p packages/contracts/tsconfig.json` → **exit 0**。
- `npx tsc --noEmit -p apps/desktop/tsconfig.json` → **exit 2，但唯一错误在 `apps/desktop/scripts/t27-load-entry-deadlock-smoke/main.ts(401,14): Cannot find name 'bootstrapDir'`**。该目录 `git status` 为 `??`（**未跟踪**），是 T27 会话正在写的工作文件，属本卡明令不得触碰的 T27 边界。过滤该文件后无任何错误；本卡改动的三个文件均不产生 TS 诊断（两个 `.cjs`、一个 `main.cjs` 更不在 tsc 范围内）。

### 提交

- 提交以 `git commit -o` 按路径提交，只含本卡四个文件（`genoffice-file-routing-smoke/run.sh`、`release-readiness-smoke/check-genoffice.cjs`、`genoffice-source-smoke/main.cjs`、本卡）。
- 提交 SHA 见 `git log --grep T31`（本节随提交入库，SHA 由提交自身确定）。
- 他人 10 项 dirty 原样保留、未入提交。

### 遗留（不在本卡范围，建议另开卡）

1. **15 套 smoke 因 `@main/document/genoffice{Sheets,Slides}Entry.js` alias 缺失而在 esbuild 阶段失败**（最大的一块红，产品 import 与 smoke runner 的契约缺口）。
2. 上述 B–L 各条（stub 漂移、原生模块 loader、fetch bad port、Electron 渲染端 contributions、2 条断言级、AOCI 索引、Codex tool call、capability 三处同源、markdown 路由未定义）。
3. T27 未跟踪文件里的 `bootstrapDir` TS 错误（T27 会话自行收尾）。

