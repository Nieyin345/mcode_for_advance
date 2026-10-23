# T22｜smokes-for 覆盖映射漏掉 .tsx，导致「该跑哪几套」判断失真

- Status: done（2026-10-23 执行回写，见文末）
- Category: bug
- Priority: P0 开发工具链
- Depends on: none
- Exclusive writable files: `apps/desktop/scripts/smokes-for.py`、其测试（若有）、新建回归套件。**不改**任何产品源码。

## Required Skills
- `mcode-smoke`: 理解这套无头 smoke 的发现机制，并给工具本身建回归。
- `code-review`: 确认修复没有把「没覆盖」误报成「已覆盖」——两个方向都要对。

Read before work: `CLAUDE.md`、`apps/desktop/scripts/smokes-for.py`、`apps/desktop/scripts/smokes-for.sh`、`apps/desktop/scripts/run-smokes.mjs`。

## 总控核实过的缺陷（T12 报告第 2 条，我已逐行验证）

`apps/desktop/scripts/smokes-for.py` 扫描 smoke 套件时：

```python
for ts in d.rglob("*.ts"):     # 第 99 行 —— 漏掉 .tsx
for mjs in d.rglob("*.mjs"):   # 第 104 行
```

**`.tsx` 一个都不扫。**

后果：渲染端组件被 Electron 套件真实 import，但工具报「无覆盖」。

T12 实测案例：`apps/desktop/src/renderer/components/chat/ApprovalPrompt.tsx` 被 `arc005-focus-ownership-smoke` 等套件真实 import，`smokes-for` 却把它列进 `--uncovered` 清单。

## 为什么这是 P0

`smokes-for` 的存在意义就是回答「改这个文件该跑哪几套」。它给错答案有两种方向，**两种都危险**：

1. **漏报覆盖**（当前 bug）：开发者以为某个 `.tsx` 组件没有网，于是不跑、或以为需要新建套件。实际有套件覆盖它。
2. **误报覆盖**：把没覆盖的说成覆盖了，改完不跑就提交。

当前是第 1 种。修复时**不能引入第 2 种**。

## 目标

1. **把 `.tsx` 纳入扫描**（`rglob("*.ts")` 那一行）。
2. **同时检查其它被漏掉的扩展名**：`.jsx` / `.cjs` / `.mts` / `.cts` 在本仓库是否存在？逐个核实并用证据说明要不要扫。
3. **两个方向都要验**：
   - 正向：`ApprovalPrompt.tsx` 现在应该被映射到真实覆盖它的套件，不再出现在 `--uncovered`。
   - 反向：造一个真的没人 import 的 `.tsx` 文件（或用现有真无覆盖的），确认它**仍然**被报「无覆盖」——不能因为放宽扫描就把一切都算成覆盖。
4. **`--uncovered` 计数要如实变化**：修复前后各跑一次，记录精确数字，并解释每一项增减的原因。

## 硬约束

- **不改任何产品源码**，只改工具与它的回归。
- **不得为了让 `--uncovered` 数字变小而放宽判据**——数字变小必须是因为真的发现了覆盖关系。
- 如果发现 `.tsx` 的 import 解析还有别的坑（例如路径别名 `@renderer/`），一并修，但要分开说明。

## 验收判据

1. `bash apps/desktop/scripts/smokes-for.sh src/renderer/components/chat/ApprovalPrompt.tsx` 返回真实覆盖它的套件列表（非空）。
2. 一个真无覆盖的 `.tsx` 仍被报「无覆盖」。
3. 修复前后 `--uncovered` 的完整差异，逐项解释。
4. 变异验证：把 `.tsx` 从扫描里去掉 → 第 1 条必须变红；逐字节还原（`cmp`）。
5. 既有 `run-smokes.mjs` 的套件发现**不受影响**（它用正则匹配目录名，与文件扩展名无关——请核实并写明）。
6. 双包 typecheck 通过。

## 结果回写（2026-10-23）

**TL;DR**：扫描入口从 `rglob("*.ts")` 改为 `("*.ts", "*.tsx", "*.jsx")`；`.cjs` 经实测**故意不扫**（会凭空"覆盖" 85 个脚本文件，清一色来自 `alias:{...}` 字符串的假阳性）。`--uncovered` 计数 **11 → 11 不变**——修复前也不变，因为 bug 不在那个口径里（详见 §3）；真正变化的是 renderer 映射：受控 A/B 下 **161 个文件新获得映射、334 个已有映射补上了套件、0 个丢失**。`ApprovalPrompt.tsx` 从「没有套件覆盖它」变为 `maint-m22-smoke settings-panels-electron-smoke ui-interaction-smoke`。

### 1. 修改点

| 文件 | 改动 |
|---|---|
| `apps/desktop/scripts/smokes-for.py` | `coverage()` 的扫描入口：`for ts in d.rglob("*.ts")` → `for pattern in ("*.ts", "*.tsx", "*.jsx"): for entry in d.rglob(pattern)`。文件头「判据」段同步改写（原文只写 TypeScript 入口）。 |
| `apps/desktop/scripts/tsx-coverage-smoke/main.py`（新增） | 10 条行为断言，fixture 在临时目录里搭最小仓库，子进程跑真脚本看它打印什么。 |
| `apps/desktop/scripts/tsx-coverage-smoke/run.sh`（新增） | 复用 `smokes-for.sh` 同款 Python 探测（Store 占位别名会假成功）+ `cygpath` 路径转换。 |

**没有动任何产品源码。** `git status --porcelain apps/desktop/src` 里的两项（`apiCatalog.generated.ts`、`settingsTransfer.ts`）是其他会话在本次开工前就有的未提交修改，我未触碰。

**`resolve()` 本来就已经支持 `.tsx`，不要和扫描入口混为一谈。** 第 67-73 行的候选表是 `(base.with_suffix(".ts"), base.with_suffix(".tsx"), base / "index.ts", base / "index.tsx")`，另有 `.js` 说明符回退到 `.ts`/`.tsx`。`@renderer/` 也早在 2026-09-26 就能解析。所以这次**不需要**改解析层——漏的只是「哪些文件被当成入口」。

### 2. 扩展名核查（每项带命中数）

统计命令：`find apps/desktop/src apps/desktop/scripts packages -name '<ext>' -not -path '*/node_modules/*' | wc -l`

| 扩展名 | 全仓命中 | 在 `*-smoke/` 内的命中 | 结论 | 证据 |
|---|---|---|---|---|
| `.tsx` | **301**（`src/main` 下 0 个） | **18**（13 个套件目录 + 3 个非套件预览台 `arc005-visual-baseline` / `flow-preview` / `md-preview`） | **要扫** | `settings-panels-electron-smoke/renderer.tsx:14` 静态 `import { ApprovalPrompt } from "@renderer/components/chat/ApprovalPrompt.js"`；`build.mjs:59` 把它作为 `entryPoints` 打包进真 Electron。 |
| `.jsx` | **13** | **13**（13 个套件各 1 个，全部是入口） | **要扫** | 13 个套件里 11 个是 `build.mjs` 的 `entryPoints:[...main.jsx]`（`custom-models-ui-smoke`、`maint-m17/m22/m25`、`mcp-ui`、`memory-injection-ui`、`module-catalog-ui`、`module-ui`、`plugins-ui`、`skills-management-ui`、`ui-interaction`），另 2 个 `module-contributions-smoke/ui-harness.jsx`、`module-phase2-e2e-smoke/native-renderer.jsx` 分别由 `ui-build.mjs:22`、`native-build.mjs:39` 打包。实测扫 `.jsx` 额外带出 2 个产品源码：`MobileFilesScreen.tsx`、`MobileFileViewer.tsx`（`ui-interaction-smoke/main.jsx:10` 真渲染 `MobileFilesScreen`），以及 13 个套件入口自身。 |
| `.cjs` | **90** | **88**（67 个套件目录） | **不扫** | 全部是 esbuild 启动器（`run.cjs`/`electron-host.cjs`/`bridge.cjs`）或桩（`iconsStub.cjs`/`stubs/*.cjs`）。实测若扫，会**凭空"覆盖" 85 个 `scripts/` 文件、0 个产品源码**——其中的"import"全部来自 `alias:{"@main/...":"./stubs.ts"}` 这类字符串。这正是本卡禁止的第 2 类错误（误报覆盖）。 |
| `.mts` | **0** | 0 | 不扫 | 仓库里不存在。 |
| `.cts` | **0** | 0 | 不扫 | 仓库里不存在。 |
| `.js`（补充核查） | 13（`scripts` 下 `maxdepth 2`） | 13 | 不扫 | 均为套件的浏览器辅助脚本，无一 import 产品源码（`grep -E "(from\|import).*(@main/\|@renderer/\|@contracts/\|\.\./\.\./src/)"` 零命中）。 |

**`.tsx` 的 import 解析还有没有别的坑？** 查了三种形态，均无缺口，所以**没有改 `resolve()`**：
- `.jsx` → `.jsx` 相对 import：0 处；
- `.ts`/`.tsx` → `.jsx` 说明符：0 处；
- 路径别名：`@main/`、`@renderer/` 都能解析，`@contracts/` 按原设计返回 `None`（另一个包）。

### 3. `--uncovered` 前后对比：11 → 11，逐项解释

修复前后各跑一次，**两份清单逐行完全相同**（`diff` 无输出）：

```
apps/desktop/src/main/document/genofficeEntryTypes.d.ts
apps/desktop/src/main/document/genofficeExternalTypes.d.ts
apps/desktop/src/main/document/genofficeNativeVendorStub.ts
apps/desktop/src/main/document/genofficeViewAiVendorStub.ts
apps/desktop/src/main/document/slidesVendorModulesStub.ts
apps/desktop/src/main/document/slidesVendorShims.d.ts
apps/desktop/src/main/mcp/hostMcpMain.ts
apps/desktop/src/main/modules/moduleApproval.ts
apps/desktop/src/main/providers/claude-sdk/index.ts
apps/desktop/src/main/raw-imports.d.ts
apps/desktop/src/main/workflowEngines/nodePackChildRuntime.ts
共 11 个;主进程下覆盖到的 480 个。
```

**逐项增减：0 增 0 减。** 原因不是「没修好」，而是**这个口径定义上就看不到该 bug**：`--uncovered` 的分母是 `MAIN.rglob("*.ts")`（`smokes-for.py:135`），`ApprovalPrompt.tsx` 从来不在这个集合里——它既不会出现在"未覆盖"，也不可能出现在"已覆盖"。修复前它被误报的现场是**单文件查询**和 `--all` 的 renderer 行。

**为什么加了扫描入口，主进程 `.ts` 的判定一个都没变？** 已用受控 A/B 证明（见 §4）：`.tsx`/`.jsx` 入口 import 的是 `@renderer/...` 与相对 renderer 文件，新增覆盖全部落在 `src/renderer/`；`src/main/` 下 **0 个文件新增映射、0 个文件套件集合改变**。那 11 个文件依旧没人 import（多为 `.d.ts`、vendor stub、独立子进程入口），这是真实的无网区域，不是判据放宽。

### 4. renderer 映射的前后差异（受控 A/B，逐项解释）

⚠️ 原始前后对比会被**并行会话污染**：另一个会话在基线跑完之后（02:50）新建了未跟踪的 `scripts/t0-genoffice-native-tool-roundtrip-smoke/`，它 import `@main/claude/RuntimeManager.js`，会带进 400+ 个主进程文件。所以改用**同一棵树、背靠背、只切换扫描模式**：

1. 把真 `smokes-for.py` 原地改成 `for pattern in ("*.ts",):`（仅此一处），跑 `--all` / `--uncovered`；
2. 逐字节还原（`cmp` 通过），再跑一遍。

先证明「HEAD 版 ≈ 原地 ts-only 版」：把 `git show HEAD:...smokes-for.py` 放到同目录跑 `--all`，与 ts-only 副本逐文件比对，**文件集合与每行套件集合均 0 差异**——所以 ts-only 就是可靠的"修复前"。

| 指标 | ts-only（修复前） | ts+tsx+jsx（修复后） |
|---|---|---|
| `--all` 里有映射的文件 | 2090 | **2251**（+161） |
| 丢失映射的文件 | — | **0** |
| 已有映射补上新套件的文件 | — | **334** |
| 零覆盖套件自省段 | 40 套 | **28 套** |
| `--uncovered` | 11 | 11（不变） |

**新增的 161 个文件，按扩展名拆开**：

- **`.tsx` 132 个**：例如 `ApprovalPrompt.tsx`、`ChatPane.tsx`、`App.tsx`、`SettingsPage.tsx`，以及 `.tsx` 入口顺着 import 带出的 `.ts`（`composerFluidTier.ts` 等）。来源只有两个：`settings-panels-electron-smoke/renderer.tsx`（它 import `App`/`ApprovalPrompt`/`ChatPane`，一整条 renderer 树）与 `workflow-ui-smoke/main.tsx`（SettingsPage 树）。其中 16 个是 `.ts`，都住在 `src/renderer/`。
- **`.jsx` 13 个**：全部是套件自己的入口文件（`main.jsx` / `ui-harness.jsx` / `native-renderer.jsx`），由 `rglob` 直接收录。
- **`.ts` 16 个**：同上，是 `.tsx` 入口带出来的 renderer `.ts`，不是新扩展名。

**已有映射的 334 个文件补上了哪些套件**（每个套件新增 claim 的 `src/` 文件数）：`settings-panels-electron-smoke` 465、`workflow-ui-smoke` 233、`maint-m22-smoke` 220、`ui-interaction-smoke` 185、`memory-injection-ui-smoke` 158、`maint-m17-smoke` 143、`module-phase2-e2e-smoke` 143、`html-preview-electron-smoke` 142、`maint-m25-smoke` 131、`module-catalog-ui-smoke` 130、`markdown-preview-smoke` 123、`skills-management-ui-smoke` 119、`mcp-ui-smoke` 115、`plugins-ui-smoke` 114、`project-init-ui-smoke` 110、`custom-models-ui-smoke` 109、`module-ui-smoke` 106、`module-contributions-smoke` 88、`file-links-ui-smoke` 83、`markdown-quote-smoke` 78、`scene-deploy-electron-smoke` 70、`watch-templates-cas-electron-smoke` 66、`editor-market-smoke` 42、`t21-smoke` 5。

这套数字偏大，原因在别的会话新建的套件 + `.tsx` 入口本来就把整棵 `SettingsPage`/`ChatPane` 树编译进 bundle（`settings-panels-electron-smoke/build.mjs:59` 是 `entryPoints:[renderer.tsx]`，它的 import 图包含 `App.tsx` → 几乎所有面板）。**这些是真实被 bundle 进去的文件，不是判据放宽**：抽查 `useNarrowViewport.ts`（新获映射）的 import 链确实存在——`EffortPermissionControl.tsx:16` / `ModelDropdown.tsx:15` / `WorkflowDropdown.tsx:43` static import 它，而这三个组件都在 `ChatPane` 静态 import 图里。

**12 个套件从「零覆盖」段消失**：`custom-models-ui-smoke`、`file-links-ui-smoke`、`maint-m17-smoke`、`maint-m22-smoke`、`maint-m25-smoke`、`mcp-ui-smoke`、`memory-injection-ui-smoke`、`plugins-ui-smoke`、`project-init-ui-smoke`、`skills-management-ui-smoke`、`t21-smoke`、`ui-interaction-smoke`。它们从前被列为"只测契约层"，实际都是 `.jsx`/`.tsx` 入口的浏览器套件——**这条自省段本身也在骗人**，修复后如实了。没有套件新增"零覆盖"。

### 5. 双向验证

**正向**（`ApprovalPrompt.tsx`，验收判据 1）：

```
$ bash apps/desktop/scripts/smokes-for.sh src/renderer/components/chat/ApprovalPrompt.tsx
apps/desktop/src/renderer/components/chat/ApprovalPrompt.tsx
  跑这些: maint-m22-smoke settings-panels-electron-smoke ui-interaction-smoke
```

三套都是真的：`settings-panels-electron-smoke/renderer.tsx:14` 静态 import；`ui-interaction-smoke/main.jsx:5` import 并在 `:124` 真渲染（`<ApprovalPrompt providerName="Agent A" …/>`）；`maint-m22-smoke` 经 `ChatPane.tsx:65`（`import { ApprovalPrompt } from "./ApprovalPrompt.js"`）传递获得。修复前同一条命令输出「⚠️ 没有套件覆盖它」。

**反向**（真没人 import 的 `.tsx` 仍然无覆盖，验收判据 2）：

```
$ bash apps/desktop/scripts/smokes-for.sh src/renderer/main.tsx
  ⚠️ 没有套件覆盖它 —— 改这里没有回归网。
$ bash apps/desktop/scripts/smokes-for.sh src/renderer/AppMobile.tsx
  ⚠️ 没有套件覆盖它 —— 改这里没有回归网。
```

`main.tsx` 是 Vite 入口（`src/renderer/index.html:43` 引用），**没有任何套件把它当 entryPoints**（`grep -rn 'renderer/main' */build.mjs */run.mjs */run.sh` 零命中）；`AppMobile.tsx` 只被 `main.tsx` import，手机端的独立组件树。二者在 `--all` 里也不出现。修复后 `--uncovered` 之外新确立的"无覆盖 renderer 文件"共 6 个（`main.tsx`、`AppMobile.tsx`、`MobileSessionDrawer.tsx`、`MobileSettingsSheet.tsx`、`MobileViewerOverlay.tsx`、`PairingScreen.tsx`），全部核实过 import 链，均为真实无网。

### 6. 变异验证（验收判据 4）

把扫描模式改成 `("*.ts", "*.jsx")`（去掉 `.tsx`），跑新回归：

```
FAIL .tsx 与 .jsx 入口都被扫到：ApprovalPrompt.tsx 映射到两个套件
FAIL 同一套件的 .tsx 入口也能带出 .ts 依赖
FAIL --uncovered 只列真正没人碰的主进程 .ts
FAIL --uncovered 的计数口径与名单一致
FAIL --all 里 ApprovalPrompt.tsx 同时列出 .tsx 与 .jsx 两个入口套件
tsx-coverage-smoke: 5/10 通过        (exit 1)
```

10 条中 5 条变红，**第 1 条正向断言在列**。还原：

```
$ cp .tmp/t22-smokes-for.py.bak apps/desktop/scripts/smokes-for.py
$ cmp .tmp/t22-smokes-for.py.bak apps/desktop/scripts/smokes-for.py
BYTE-IDENTICAL RESTORE OK
$ bash apps/desktop/scripts/tsx-coverage-smoke/run.sh
tsx-coverage-smoke: 10/10 通过
```

### 7. `run-smokes.mjs` 的套件发现不受影响（验收判据 5，已核实）

`run-smokes.mjs:30` 的 `SUITE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-smoke$/`，`:32-36` 的 `discoverSuites()` 只做 `readdirSync(scripts).filter(entry.isDirectory() && SUITE_NAME.test(entry.name))`——**只匹配目录名，从不读目录里的文件，与任何扩展名无关**。实测：`discoverSuites()` 现在返回 528 套，含新套件 `tsx-coverage-smoke`；`pnpm test:smoke tsx-coverage-smoke` → `PASS tsx-coverage-smoke`；`node --test scripts/run-smokes.test.mjs` → 12/12 通过。

### 8. typecheck（验收判据 6）

- `packages/contracts`：`npx tsc --noEmit -p packages/contracts/tsconfig.json` → **exit 0**。
- `apps/desktop`：`npx tsc --noEmit -p tsconfig.json` 有 **2 个错误，全部位于 `scripts/electron-u1/driver/steps.ts`**——这是**另一个会话未跟踪的新目录**（`git status` 显示 `?? apps/desktop/scripts/electron-u1/`），与本卡无关。把该目录排除后重跑（临时 tsconfig，仅用于证明）：**exit 0**。本卡只新增 `.py`/`.sh`，不在 tsc 的 include 范围内。

### 9. 顺带跑过的相邻套件

`maint-m22-smoke` 16/16、`ui-interaction-smoke` 全绿、`leftbar-render-smoke` 11/11、`workflow-ui-smoke` 21 passed / 0 failed。

`settings-panels-electron-smoke` **失败 1 条**（`MC-045 前置:真 App 能挂起来…`），错误是 `TypeError: Cannot read properties of undefined (reading 'flatMap') at contributionsOf (ModuleContributions.tsx)`——发生在**产品源码的模块贡献渲染**上，与本工具无关（本工具只决定"该跑哪套"，不改产品代码）。该套件在本次修复前**从未被 `smokes-for` 识别为覆盖者**，也没有任何证据表明本卡让它变红；这是它自身/并行会话改动面的问题，留给该套件的归属方。

### 10. 提交

`39bbc5c850c1b1e54c4cc9bd1dfa45c22b5f1d72` — `fix(scripts): smokes-for 扫描入口补上 .tsx/.jsx，修正渲染端覆盖映射`

只暂存了本卡负责的 4 个文件（`smokes-for.py`、`tsx-coverage-smoke/main.py`、`tsx-coverage-smoke/run.sh`、本卡）。其他会话的未提交修改（`.aoci/baseline.json`、`.gitignore`、`apiCatalog.generated.ts`、`settingsTransfer.ts`、`maint-m35-smoke/pickers-prelude.ts`、`orchestration-ipc-smoke/run.sh`、`release-readiness-smoke/check-reviewed.cjs`、`t83-mcode-editor-tool-bridge-smoke/*`、`docsAiPorts.ts`、`nativeEditorToolTransport.ts`、若干任务卡）以及未跟踪目录 `scripts/electron-u1/`、`scripts/t0-genoffice-native-tool-roundtrip-smoke/` 原样保留。

**提交后重跑**（记忆规则：报绿前要在提交后重跑）：`tsx-coverage-smoke` 10/10、`--uncovered` 11 个、`ApprovalPrompt.tsx` 映射三套，全部与提交前一致。

残余风险：
- `.cjs` 不扫意味着 12 个 cjs-only 套件（`release-readiness-smoke`、`t73-…` 等）**用 `readFileSync` + `typescript.transpileModule` 读产品源码**，工具不会知道它们覆盖了什么。这是修复前就存在的盲区，本卡**没有扩大**（扫描只加不删），也未在本卡范围内解决；正确做法是让它们声明 `// @smoke-covers` 或提供 `.ts` 入口，需另开卡。
- `resolve()` 不认 `.jsx` 说明符（本仓 0 处），将来若出现会静默漏报；新回归只锁住"入口扩展名"，不锁这一点。

