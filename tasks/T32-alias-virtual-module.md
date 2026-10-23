# T32｜`genofficeNativeVendor.ts` 的 alias 虚拟模块破坏了 11 套 smoke 打包（卡面原写 15，已按实测校正）

- Status: ready-for-agent
- Category: **bug（测试基础设施）**
- Priority: **P0 工具链**
- Depends on: none
- Exclusive writable files: `apps/desktop/src/main/document/genofficeNativeVendor.ts`、`apps/desktop/electron.vite.config.ts` 的 alias 段、`apps/desktop/scripts/run-smokes.mjs`（若需补 alias）、相关 stub。逐个确认后写进回写区。

## Required Skills
- `codebase-design`: 决定是「给 smoke runner 补 alias」还是「让源码可被裸 esbuild 解析」。
- `mcode-smoke`: 理解这套无头 smoke 的打包方式，并验证修复。

Read before work: `CLAUDE.md`、`apps/desktop/src/main/document/genofficeNativeVendor.ts`、`apps/desktop/electron.vite.config.ts`（**第 257/261 行附近**）、`apps/desktop/scripts/run-smokes.mjs`、`apps/desktop/src/main/document/genofficeEntryTypes.d.ts`、`genofficeNativeVendorStub.ts`。

## 缺陷（T31 全量跑实测）

11 套 smoke 在**打包阶段**就失败，同一个根因：

```
X [ERROR] Could not resolve "@main/document/genofficeSheetsEntry.js"
X [ERROR] Could not resolve "@main/document/genofficeSlidesEntry.js"
X [ERROR] Top-level return cannot be used inside an ECMAScript module
```

**来源**：`dc974b2c`（旧卡 T29「connect upstream Sheets and Slides native views」）在 `genofficeNativeVendor.ts` 里 import 了这两个模块。

**问题**：它们是 **electron-vite 配置里的 alias 虚拟模块**（`electron.vite.config.ts:257/261`），**仓库里没有对应源文件**。裸 esbuild 的 smoke runner 没有这个 alias，于是在打包阶段直接失败。

**受影响的 11 套**（实测；T31 列 15 套里 4 套当时已按 T52 补过）：`agent-guide`、`claude-ipc`、`custom-ui-refresh`、`extension-authoring`、`host-mcp-server`、`host-mcp-stdio`、`memory`、`panel-screenshot`、`scene-apply`、`scene-crash-resume`、`watch-templates-cas-electron` 等。

## 两条修法

**(A) 给 smoke runner 补 alias**

在 `run-smokes.mjs` 或各套的 `run.sh` 里，把这些别名指向真实模块或 stub。

- 优点：不改产品源码
- 缺点：每个套件都要加，或者改共享的 runner（影响面大）
- **注意**：仓库里已有 `genofficeNativeVendorStub.ts`，可能就是为此准备的——先看它是什么

**(B) 让源码可被裸 esbuild 解析**

把 `@main/document/genofficeSheetsEntry.js` 这类写法改成运行时 `require()`/动态 import，或提供一个真实存在的入口文件。

- 优点：一次性解决
- 缺点：动产品源码，要验证 electron-vite 构建仍正常

**选一个并论证。** 先查 `genofficeNativeVendorStub.ts` 的用途——如果它就是为此准备的 stub，那 (A) 可能已经有半成品。

## 验收判据

1. 回写区给出：`genofficeNativeVendorStub.ts` 是什么、现在谁在用。
2. 明确修法（A 或 B）与论证。
3. **11 套 smoke 全部能打包并运行**（不必全绿，但必须不再卡在打包阶段）。
4. `electron-vite build` 仍正常（**真跑一次构建**）。
5. T23 的 `production-build-preload-smoke` 18/18、`genoffice-editors-release-smoke` 29/29 不回归。
6. 变异验证：撤掉修复 → 至少一套回到打包失败 → `cmp` 还原。
7. 双包 typecheck 通过。

## 边界

- **不动** T27/T28（`workflowEngines/`）、T19（`appPermission.ts` + `ModuleHost.ts`）。
- **不改** `build/vendor-licenses/`。
- **不改** T31 刚修的三个套件。
- 若改 `run-smokes.mjs`，**必须保证其他 500+ 套不受影响**——改完跑一次全量对照。

## 重要：这个 checkout 是多会话共享的

- **用 `git commit -o <path>` 按路径提交**，不要 `git add` 后停在那里
- **绝对不要读 `.tmp/` 下的文件当提交信息**（我犯过这个错，读了 11 天前的旧文件）
- **绝对不要用 `git worktree` + junction**（前面删过 `packages/contracts/`）

## 结果回写（2026-10-23）

### 起点

- 开工 HEAD `4c460bb2`（`docs(tasks): open T32 …`）。工作树有 14 项他人未提交修改，**全部原样保留**，未 reset/stash/clean；本卡未提交任何他人路径。
- 本卡实际写入（3 类，11 个文件）：
  - 10 个 `scripts/<suite>/run.sh` 各 +1 行 alias
  - `scripts/watch-templates-cas-electron-smoke/build.mjs` 的 `alias` 段（该套走 `esbuild.build()` JS API，不是 CLI）
  - 本卡回写
- 未改 `genofficeNativeVendor.ts`、未改 `electron.vite.config.ts`、未改 `run-smokes.mjs`、未改任何 stub、未改产品源码。

### 1. `genofficeNativeVendorStub.ts` 是什么、谁在用

它是 **vendor 接缝的 fail-closed 打包替身**：与 `genofficeNativeVendor.ts` 同一组导出（`vendorAvailable=false`，`configureNativeRuntimes` / `createNativeView` 调用即抛 `GenOffice vendor snapshot is not installed`），只 import `type DocumentViewLike`——**不 import 任何 vendor 文件**。`genoffice/` 是 gitignored 的可选快照，这个 stub 让快照不在场的机器也能构建。

**谁在用（两条路）**：

1. **产品构建**：`electron.vite.config.ts:250-254` 在五个 `genoffice/apps/<kind>/src/main/<kind>-main.ts` 全部存在时指向真实现，否则指向 stub——这是 T28/T29 设计的生产 seam（`vendorAvailable=false` 时装配层不 attach，能力报告如实报 false）。
2. **无头 smoke**：31 套 `run.sh`/`build.mjs` 已带 `--alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts`，是 **T52（`3675af25`，2026-10-21 15:53，T29 提交后 40 分钟）** 定下的统一做法，文件头写明用途。

也就是说：**卡上 15 套里，4 套（`host-mcp-server`/`memory`/`panel-screenshot`/`scene-apply`… 实际按日志为 `mcp-text`/`mobile-pairing`/`orchestration-ipc`/`scene-deploy-electron`）当时已按 T52 补过，剩下这 11 套是漏网的**——stub 确实是"为此准备的"，(A) 已有半成品且是仓库既定惯例。

### 2. 修法：选 (A)，逐套补 alias（不改共享 runner）

**论证**：

- **`run-smokes.mjs` 根本不调 esbuild**——它只 spawn 各套的 `run.sh`，打包参数全在各套入口文件里。所以"改共享 runner"这条路在本仓库不存在；改 `run-smokes.mjs` 既解决不了问题、又只能影响发现/调度逻辑（500+ 套共用）。卡上说的"给 smoke runner 补 alias"实际落点只能是**各套的 `run.sh`/`build.mjs`**，这也是 T52 已用的做法。
- **选 (A) 而非 (B) 的理由**：
  1. stub 语义正确：无头套件不验原生文档视图；`vendorAvailable=false` 只让这些套件的 `configureGenofficeNativeViews` 提前返回 unavailable——行为是**显式**的（能力报 false / 调用即抛错），不是静默跳过，符合"坏东西显式报出来"。
  2. (B) 要动产品代码，把静态 import 改成运行时 require/动态 import 会破坏 electron-vite 打包期的 tree-shaking/闭包校验，且真实现还在 html-main 里拖进 html2docx 的 `?raw` 浏览器脚本（**第三条错误** `Top-level return…` 就是它）——裸 esbuild 依旧解析不了。等于用更大的风险换取同样的结果。
  3. 31 套已有同款做法，新增 11 套是**收敛到既定惯例**，不是发明新机制。
- **影响面**：只碰这 11 个套件自己的入口文件；其他 500+ 套的参数、发现规则、调度全部未变（全量对照见下）。

### 3. 11 套（含根因）的实际结果

T31 的清单里 `host-mcp-server`/`memory`/`panel-screenshot`/`scene-apply` 等有些对不上，我按**日志实测**确定名单：扫 `run-smokes --all` 最近一次全量日志（`541 logs`），带 `Could not resolve "@main/document/genoffice{Sheets,Slides}Entry.js"` **和** `Top-level return` 两条签名的**恰好 11 套**（与卡上"15 套"的差异来自 T31 回写把早期 180 套部分跑里 4 套老账并进来了；那 4 套 `mcp-text`/`mobile-pairing`/`orchestration-ipc`/`scene-deploy-electron` 已在 T52 修过，HEAD 日志显示它们本来就绿）：

| # | 套件 | 修复前 | 修复后 |
|---|---|---|---|
| 1 | `agent-guide` | 打包失败 | **44/44 通过** |
| 2 | `claude-ipc` | 打包失败 | **444/444 通过** |
| 3 | `custom-ui-refresh` | 打包失败 | **全部场景 PASS**（approval/live panel/invalid data/removal/read-write race/persistence failure/mobile boundary） |
| 4 | `extension-authoring` | 打包失败 | **24/24 通过** |
| 5 | `host-mcp-server` | 打包失败 | **50/50 通过** |
| 6 | `host-mcp-stdio` | 打包失败 | **32/32 通过** |
| 7 | `memory` | 打包失败 | **305/305 通过** |
| 8 | `panel-screenshot` | 打包失败 | **49/49 通过** |
| 9 | `scene-apply` | 打包失败 | **333/333 通过** |
| 10 | `scene-crash-resume` | 打包失败 | **14/14 通过** |
| 11 | `watch-templates-cas-electron` | 打包失败 | **21/21 真 Electron 断言通过** |

- 统一跑：`node scripts/run-smokes.mjs …11 套` → **`Smoke summary: 11 pass, 0 fail (11 suites)`**。
- 四条既有绿（全量日志实测）：`mcp-text` 108 checks、`mobile-pairing` 285/285、`orchestration-ipc` 433/433、`scene-deploy-electron` 14/14。
- **11 套全部通过，不只是"能打包"**——比卡上"不必全绿"的判据更强。

### 4. `electron-vite build` 真跑

```
node build/build-node-pack.cjs                    → exit 0
node node_modules/electron-vite/bin/electron-vite.js build → exit 0（✓ built in 2m 38s）
```

主进程/preload/renderer 三段全过，无 alias 解析错误。**注意**：`build-node-pack.cjs` 会重写 `src/main/workflowEngines/nodePackBundle.generated.ts`；我比对了两版 payload，差异**只有 esbuild 的源路径注释**（`apps/desktop/src/…` vs `src/…`，取决于调用 cwd），无代码差异。该文件在 T27 边界内且构建前是干净的——已用 `git restore` 逐字节还原，`git status` 复核为空。

### 5. T23 两套不回归

```
production-build-preload-smoke: 18/18 PASS
genoffice-editors-release-smoke: 29/29 PASS
```

### 6. 变异验证

撤掉 `agent-guide-smoke/run.sh` 里那行 alias（Python 精确删行，CRLF 安全，断言"恰好 1 处"）→

```
X [ERROR] Could not resolve "@main/document/genofficeSheetsEntry.js"
  src/main/document/genofficeNativeVendor.ts:13:79
exit=1
```

即**至少一套回到打包失败**，错误与原始缺陷逐字一致。`cp` 还原后 `cmp` 逐字节一致，复跑 **44/44 通过**。

### 7. 双包 typecheck

```
node node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json  → exit 0
node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json       → exit 0
```

（本次改动全是 `.sh`/`.mjs` 的 alias 行，tsc 覆盖不到；仍跑了作基线。）

### 8. 其他套件

按 `smokes-for.sh src/main/document/genofficeNativeVendor.ts` 的连通块共 ~100 套，其中 31 套早就带 stub alias（T52），剩下 11 套即本卡修完。**未跑一次全量 541 套**——本卡改的是 11 个入口文件、没有改共享调度/发现/打包参数，按卡上"若改 run-smokes.mjs 才需全量对照"的门槛，不触发；而且 11 套已全部通过、其他套件的参数逐字未动。

### 提交

- 按路径提交，**只含本卡 12 个文件**（11 个套件入口 + 本卡）：`git commit -o <paths>`。
- **实现提交 SHA：`4da81702`**（12 文件，120+/1-）。提交后 `git status` 复核：本卡 11 个入口文件与任务卡全部干净；他人未提交修改（`.aoci/baseline.json`、`.gitignore`、`document-view-host-smoke/` 三项、`maint-m35-smoke/pickers-prelude.ts`、`orchestration-ipc-smoke/run.sh`、`release-readiness-smoke/check-reviewed.cjs`、`src/main/ipc/settingsTransfer.ts`、`src/main/workflowEngines/nativeLibraryLoad.ts`、`src/main/modules/ModuleHost.ts`、`t27-load-entry-deadlock-smoke/`）原样保留、未入提交。

### 遗留 / 备注

- T31 回写里的"15 套"实际是 11 套同根因 + 4 套老账（T52 已修），本卡结论已校正。
- 若以后 vendor 再加新的主进程入口（像 T29 这样新增 `@main/document/genofficeXxxEntry.js`），**同一模式需要再补一次 alias**——根治办法是给无头 smoke 抽一个共享的 esbuild 参数片段（当前各 run.sh 各自拼参数，没有共享层），但那是独立的工具链重构，超出本卡边界。
