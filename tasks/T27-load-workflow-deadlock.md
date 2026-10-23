# T27｜`loadWorkflowIntoNative` 拒绝一切可保存的 Node-RED 图 —— 装载入口是死路

- Status: ready-for-agent
- Category: **bug（P0 功能不可用）**
- Priority: **P0**
- Depends on: T21（已交付 `6e690e48`，接线上这个入口）、T8（`d58a0b1e`，发现这个缺陷）
- Exclusive writable files: `apps/desktop/src/main/workflowEngines/nativeLibraryLoad.ts`、`workflowMigrationGate.ts`、迁移器相关文件，新建回归套件。逐个确认后写进回写区。

## Required Skills
- `codebase-design`: 两个闸门互相矛盾，要先看懂它们各自在防什么。
- `mcode-smoke`: 建回归，并做变异验证。

Read before work: `CLAUDE.md`、`tasks/T21-orphaned-workflow-adapters.md`（含回写区）、`tasks/T8-node-red-electron-u1.md`（缺陷 1 的原话）、`docs/planning/product-roadmap/T14-workflow-baseline.md`。

## T8 实测出的缺陷（原话）

> **P0**：生产 T59 装载入口 `loadWorkflowIntoNative` **拒绝一切可保存的 Node-RED 图**（迁移器必报 lossy/human，保存闸门又要求 trigger/main 节点，两者叠加无解）。

## 目标

让「用户把库里的工作流迁到 Node-RED 画布」这条路径**真的能走通**。

### 必须做的事

**第一步：把两个闸门的矛盾说清楚。**

- **迁移器**（`workflowMigrationGate.ts` / `workflowMigrationPreflight.ts`）会在什么情况下报 lossy / HUMAN？
- **保存闸门**要求 trigger/main 节点——这个要求从哪来？为什么？
- **两者叠加为什么无解**：具体是哪一类文档永远过不去？

**把这些写成一张表**，不要只说「有冲突」。

**第二步：判断哪个闸门的要求是错的。**

三种可能：
- **(a) 迁移器太严** —— 某些 lossy 其实不影响可迁移性
- **(b) 保存闸门太严** —— 要求 trigger/main 节点的规则不适用于「迁到 Node-RED」这个场景
- **(c) 两者都对，但中间缺一个转换步骤** —— 需要在装载前把文档转成两边都接受的形状

**选一个并论证。不要两边都放松了事。**

**第三步：实施修复。**

要覆盖：
- 一个**普通的、含 trigger 节点的 Mcode 工作流**能成功迁到 Node-RED 画布
- 一个**含 Mcode 特有节点类型**的工作流（迁移器可能报 lossy）的行为要明确
- 真正不可迁移的（`REJECT`）仍然拒绝
- 失败时给**可读的理由**，不是「两者冲突」

**第四步：变异验证。**

把修复撤掉 → 对应断言必须变红 → 逐字节还原（`cmp`）。

## 边界

- **不改** T2 的 `nativeLibrarySync.ts`、T3 的 `automationRunner.ts`、T4 的 `fileExecutorOwnershipStore.ts`。
- **不改** `genoffice/`、`patches/`。
- **不宣称 ARC-006 完成**。
- 若发现修复需要改 `registry.ts`，先停下报告——那是 T2 的领地。

## 验收判据

1. 回写区给出**两个闸门的矛盾表**（哪类文档、被哪个闸门、以什么理由拒）。
2. 明确修的是哪个闸门（a/b/c），并论证。
3. 一个普通 trigger 工作流能成功装载到 Node-RED 画布（真跑，不是单测）。
4. `REJECT` 的仍被拒，且理由可读。
5. 变异验证：撤修复 → 断言变红 → `cmp` 还原。
6. 双包 typecheck 通过。
7. T21 的套件 `t21-orphaned-adapters-wired-smoke` 33/33 不回归。

## 结果回写（2026-10-23）

### 1. 两个闸门的矛盾表（实测，不是推测）

实测方式：`.tmp/t27-probe/main.ts` 用**真实内置节点类型表**（`loadNodeTypes()`，10 种类型）对
5 类夹具分别跑**真的保存闸门**（`validateWorkflowDoc` + `deriveTrigger`）与**真的迁移预检**
（`evaluateWorkflowMigration` → `migrateWorkflowDoc`），逐条记录判定。以下结论全部来自这次
探针 + 源码定位（`library.ts:330-337`、`workflowValidation.ts:170-200,298-360`、
`flowMigration.ts:591-670,758-763,839-880`、`workflowMigrationPreflight.ts:934-974,983,
833-849`）。

| 文档类别（含什么） | 保存闸门（`saveWorkflow`） | 迁移器报告（`migrateWorkflowDoc`） | 迁移预检（`evaluateWorkflowMigration`） | T27 前的装载入口 | 具体理由（原话/来源） |
|---|---|---|---|---|---|
| **A. 普通自动化：`mcode.trigger`(manual) + `mcode.agent`×2** | **PASS** | `lossy=1`：trigger→`inject`，debounce/project/task 留在 `x-mcode.params` | **HUMAN**（`migration-semantics-need-review` + `trigger-semantics-unverified`），不 REJECT | **拒**（"无法无损装载"） | 迁移器 `flowMigration.ts:633-639`；预检 HUMAN 来自同一报告（`workflowMigrationPreflight.ts:968-974`）+ 触发语义门（`:833-849`） |
| **B. 定时自动化：`trigger`(schedule) + `condition` + agent×2** | **PASS** | `lossy=1`（trigger→inject，crontab 原样写入）+ condition 的 lossy（表达式求值归 Host） | **HUMAN**，不 REJECT | **拒** | `flowMigration.ts:633-639`（schedule 分支）、`:848-857`（condition） |
| **C. 普通图（非自动化）：`mcode.main` + agent** | **PASS** | `needsHumanDecision=1`：`mcode.main` 是 `conversation` runner，Node-RED 事件触发下没有"用户正在看的对话" | **HUMAN**（`migration-semantics-need-review`） | **拒** | `flowMigration.ts:597-608`（MERGE-0 #1）；保存闸门要求普通图恰好一个主节点（`workflowValidation.ts:329-347`，`graph.no-main-node`） |
| **D. 含 `mcode.code`/`mcode.command`/`mcode.branch(user)`/`mcode.conversation`** | **PASS**（只要参数合规） | `lossy`（产出契约）+ `needsHumanDecision`（语言面/非零退出/人工挂起） | **HUMAN**，不 REJECT | **拒** | `flowMigration.ts:609-629,659-668,858-874` |
| **E. 未知节点类型（`vendor.mystery`）** | PASS（存盘档 `unknownTypeSeverity:"warning"`） | `unmapped=1`（→ `mcode-unknown`） | **REJECT**（`unmapped-mcode-node-type`） | 拒（**应当拒**） | `flowMigration.ts:757-763`；`workflowMigrationPreflight.ts:954-960` |
| **F. 真正不可保存的图**（无 trigger 的自动化、无主节点的普通图、condition 缺 true/false 边…） | **FAIL**（`graph.no-trigger-node` / `graph.no-main-node` / `condition.edges`） | —（到不了这一层） | — | — | 保存闸门本身拒绝，不属于本缺陷 |

**叠加后的推导（为什么交集为空）**：

1. 保存闸门的要求是**旧 runner 的入口语义**：普通图必须有一个 `mcode.main`（用户那句话的入口），
   自动化必须有至少一个 trigger 节点（`workflowValidation.ts:326-364`；`deriveTrigger` 同源）。
   这些要求**对旧调度器是对的**——`scheduler.ts` 的入口就是主节点/触发器。
2. 迁移器对这两类入口**必然**报条目：`mcode.main` 是 `conversation` runner → 必报
   `needs-human-decision`（MERGE-0 #1，`flowMigration.ts:597-608`）；每个 trigger 必报
   `lossy`（manual/schedule→inject，file→watch）或 `needs-human-decision`（event→`mcode-trigger`），
   `:630-657`。agent/condition/code 另有各自的已知损失。
3. T27 前的 `nativeLibraryLoad.ts:132-140` 把**任何** `lossy`/`needsHumanDecision` 当硬否决
   （`issues.length > 0` 即拒），且**没有确认参数**。
4. 因此：**能保存的图 ⟺ 有 trigger 或 main ⟹ 迁移器报告非空 ⟹ 装载入口必拒**。唯一"能过"的
   文档是既过保存闸门、又让迁移器报告为空——而这样的图必须"有 trigger/main"却"没有 trigger/main
   的迁移条目"，不存在。**交集为空，装载入口是死路。**（探针实测：A/B/C 全部 `ok:false`。）

### 2. 修的是哪个闸门：**(a) 装载入口对迁移报告的用法错了**（不是迁移器太严，也不是保存闸门太严）

> 任务卡的 a/b/c 三分法里，本卡实际修的是 **(a) 的一个精确子集**：不是"迁移器把某些 lossy 判错
> 了"（它的判据一条没改），而是**装载入口把"已知损失报告"误用成了"不可迁移证明"**。用卡面的
> 语言说：**装载入口不是第三个闸门，它的要求是错的**。下面按 (a)/(b)/(c) 逐一论证为什么不是另两个。

- **不是 (b)「保存闸门太严」**：`graph.no-main-node` / `graph.no-trigger-node` 是旧 runner
  （`scheduler.ts`）的入口要求，对 `engine=mcode` 的图**必须**保留——放松它会让一张没有入口的
  图存进库、在旧执行器里静默不跑。且保存闸门对 `engine=node-red` 的图也照常适用（它不判引擎），
  改它等于给所有引擎放松，副作用远超本缺陷。**保存闸门一行未改。**
- **不是 (c)「缺一个转换步骤」**：迁移器产出的 `flow`（tab + 节点 + wires + `x-mcode` sidecar）
  是完整、可回读的——预检的 round-trip（`roundTripMismatchPaths`）对 A/B/C 全部 0 差异，所以
  预检**不 REJECT**、只判 HUMAN。缺的不是转换，而是"人看一眼"这个动作被写成了"拒绝"。
  另有一个真实的转换缺口（`mcode.main` 的会话绑定，MERGE-0 #1）——那是**预检 HUMAN 的正确内容**，
  不是装载入口该私自补的一步。
- **为什么 (a) 的落点是装载入口**：`flowMigration.ts` 的报告语义是**描述**（"这个参数原生不表达，
  留在 `x-mcode.params`，由 Host 承担"），不是**否决**。把它当否决的是 `nativeLibraryLoad.ts`
  自己的二次判据（T59 引入，`d3517719`）。T21 接进来的预检已经把"已知损失"正确地投影成
  **HUMAN（要人确认）**；装载入口却又用同一份报告做了一次更严的拒绝——**同一事实两个权威，
  严的那个赢**。T27 删掉的是这个第二权威，不是迁移器的判据。

**修法（只改 `nativeLibraryLoad.ts`）**：

1. `lossy` / `needsHumanDecision` **不再拒绝**，改为**确认文案的一部分**（与画布替换确认合并成
   一次 `confirmReplace`）。文案列出**具体**条目（哪个节点、哪条参数留在 `x-mcode.params`），
   不是"两者冲突"。
2. `unmapped` 保留一道**防御性拒绝**（纵深防御：预检已 REJECT，正常到不了这里；到了说明内部
   矛盾，必须 fail-closed 而不是写出 `mcode-unknown` 占位）。
3. 是否需要确认**只由预检决定**（`evaluation.decision === "HUMAN"`）——不在装载入口重复判
   "有 lossy 就要确认"，避免第二个会漂移的权威（变异 M2 证明：删掉这条重复判据后，
   预检的 HUMAN 仍然拦住所有需要确认的图）。

**没改**：`workflowMigrationGate.ts`（零改动）、`workflowMigrationPreflight.ts`（零改动）、
`flowMigration.ts`（零改动）、`nodeRedStorage.ts`、`registry.ts`、`nativeLibrarySync.ts`、
`automationRunner.ts`、`fileExecutorOwnershipStore.ts`、保存闸门、`document/`、`genoffice/`、
`patches/`、Node-RED 上游。**本卡的修改面只有 `nativeLibraryLoad.ts` + 两个套件 + 本卡。**

### 3. 覆盖的场景（新套件 `t27-load-entry-deadlock-smoke`，40/40，其中真引擎段 10 条）

新套件驱动**生产函数** `loadWorkflowIntoNative`（`ipc/index.ts` 的 `workflowEngine.load` 端口），
夹具先过**真的** `saveWorkflow`（全部 PASS——证明测的是"用户可保存的图"）：

| 场景 | 断言要点 | 结果 |
|---|---|---|
| 普通 trigger 工作流（manual） | 首次装载 `requiresConfirmation`；确认文案点名字面损失（debounceMs / `x-mcode.params`）；确认后 `ok:true`；画布 = `tab,inject,mcode-agent,mcode-agent`；tab `x-mcode.docId` 绑定；`NodeRedFlowStorage` 装载记录写出；再次装载仍要求 HUMAN 确认、再确认后成功 | **全 PASS** |
| 含 Mcode 特有节点（condition / branch(model) / module-capability / code） | 未确认时 `requiresConfirmation` + 点名节点；确认文案列出"不会由 Node-RED 原生表达"的具体内容；确认后装载成功；画布保留 `mcode-*`/`switch`/`function` 类型 | **全 PASS** |
| 未知节点类型（真正不可迁移） | 无论 `confirmReplace` 与否都 `ok:false`、`requiresConfirmation !== true`；理由点名 `迁移预检` + `vendor.mystery-node`；零启动、零画布写入 | **全 PASS** |
| T21 判据未放宽 | 待审文档 → `approval-pending` HUMAN；在跑文档 → `workflow-in-flight` HUMAN；都要求确认 | **全 PASS** |
| **真 `node-red@5.0.8`** | 生产装载入口写出的 `flows.json` → 生产 `ProductionWorkflowEngineRegistry.launchSpec`（真 bootstrap.cjs + vendor 解析 + adminAuth + 节点包）→ 真启动 → `GET /flows` 读回：`tab`/`inject`/`mcode-agent` 全在（节点包真的注册）、tab 仍绑 `docId`、inject 保留 `once:true` | **全 PASS** |

真引擎段用的是仓库 vendor `node-red/`（`packages/node_modules/node-red` 5.0.8，`git -C node-red log -1`
= `935b8d3`），经生产 `resolveNodeRedPackage`（`process.resourcesPath` 指向只含 junction 的临时
resources 根）；未安装时显式 SKIP、0 退出。**这不是单测**：真子进程、真端口、真 Admin API。

### 4. 变异验证（对最终代码逐项执行，`cmp` 逐字节还原）

备份 `nativeLibraryLoad.ts`（SHA-256 `00fec32c…`）→ 每项单独施加（Python 精确 `str.replace`，
先核出现次数）→ 跑 `t27-load-entry-deadlock-smoke` → 还原 → 逐字节核对：

| 变异 | 代码改动 | 结果 |
|---|---|---|
| M1 退回 T27 前的硬否决 | `knownLoss.length > 0` 即 `return ok:false` | **11 条红**（首次装载被拒、确认文案、确认后装载、画布内容、装载记录…） |
| M2 预检 HUMAN 不再要求确认 | 判据只剩 `canvasNeedsConfirmation` | **6 条红**（未确认就装载、待审/在跑文档被放行） |
| M3 确认文案不列具体损失 | 去掉 `+ lossPart` | **3 条红**（文案只剩"切换会替换画布"，不提 `x-mcode.params`） |
| M4 预检 REJECT 分支不生效（只留 UNREADABLE） | — | **1 条红**（拒绝理由退回"含无法映射…"，不再点名"迁移预检 + 缺失类型"） |
| M5 REJECT 与 unmapped 两层都去掉 | — | **3 条红**（未知类型 `{"ok":true}` 被写进画布） |

五次还原后 `cmp` 全部逐字节一致，最终文件 SHA-256 `00fec32c552f516a5c9443e07572d1e089c034a6e764dd4de7f08401dbe85af3`。
**如实说明**：M2 第一版变异（只删"`knownLoss.length > 0` 也要确认"这一条重复判据）**是绿的**
——这恰好证明了第 2 节的设计：确认只由预检决定，那条重复判据是冗余的；因此最终代码里删掉了它，
M2 改为"连预检 HUMAN 一起删"才成为有效变异。**没有把冗余判据留在代码里凑变异数。**

### 5. 其他验收事实

- **双包 typecheck**：`apps/desktop` exit 0、`packages/contracts` exit 0。
- **T21 套件**：`t21-orphaned-adapters-wired-smoke` **33/33**（未回归）。
- **T59 套件**：`workflow-native-load-smoke` **18/18**（原 17/17；两条"迁移舍入坐标也保守拒绝"
  的旧断言按 T27 契约改写为"已知损失 → 确认 → 装载"，并补一条"未确认不动画布"）。
- **相关面**：`memory-codex-smoke` 234/234、`flow-migration-smoke`、`flow-migration-identity-smoke`、
  `flow-storage-integrity-smoke`、`t85-workflow-migration-preflight-smoke`、`node-red-e2e-smoke`、
  `node-red-deploy-reconciliation-smoke`、`workflow-engine-selection-smoke`、`executor-gate-d-smoke`、
  `orchestration-ipc-smoke`、`t3-engine-trigger-gate-smoke` —— 全 PASS（全量 `run-smokes` 结果）。
- **全量 `run-smokes`**：541 套，519 pass / 22 fail。22 个失败**均与本卡无关**，失败点在
  **esbuild 打包期**（根本没跑到断言）：`@main/document/genofficeSheetsEntry.js` /
  `genofficeSlidesEntry.js` 解析不到（这两个入口由 `electron.vite.config.ts:257` 的插件在
  **构建期生成**，无头 esbuild 套件没有那个插件；`genoffice/` 是 gitignored vendor），或旧桩
  缺导出（`mcode-admin-smoke` / `maint-m35-smoke` 的桩与源码漂移）、或与本卡无关的断言
  （`aoci-index-smoke` 的台账悬空引用、`capability-smoke` 的 `core.app.call` 声明表、
  `module-permissions-smoke` 的 `document.apps` 映射、`renderer-pure-smoke` 的 MC-098）。
  这些失败在 T27 前就存在（失败原因是构建/桩/台账，不是装载入口）；**本卡没有把它们算进"绿"**。
- **本卡独占写入的文件**：`apps/desktop/src/main/workflowEngines/nativeLibraryLoad.ts`（唯一产品
  改动）、`apps/desktop/scripts/t27-load-entry-deadlock-smoke/{main.ts,run.sh}`（新建）、
  `apps/desktop/scripts/workflow-native-load-smoke/main.ts`（旧契约断言按 T27 改写，
  `smokes-for.sh` 把它列为 `nativeLibraryLoad.ts` 的覆盖套件）、本卡回写。
  他人的未提交修改（`.aoci/baseline.json`、`.gitignore`、`document-view-host-smoke/*`、
  `maint-m35-smoke/pickers-prelude.ts`、`orchestration-ipc-smoke/run.sh`、
  `release-readiness-smoke/check-reviewed.cjs`、`settingsTransfer.ts`、`genoffice-*`）**原样保留、未暂存**。
- **不宣称 ARC-006 完成。** 本卡只修"库 → 原生画布"装载入口的判定；MERGE-1 的 storageModule
  注入（S5）、MERGE-2/3 的单执行/单触发、T8 缺陷 2（`x-mcode` 经编辑器 Import 丢失）均未触及。

### 6. 仍需 T8 重验的部分

1. **真 Electron 里点一次**「打开原生编辑器」：确认对话框（现在会列出具体损失）→ 确认 → 画布
   出现 tab + inject + `mcode-agent`；这是 T8 旅程的 `production-load-entry` 步骤，当前它把
   `known-lossy-refusal` 当作可接受事实；**修好后该步骤应直接 `loaded`**（T8 脚本无需改，
   `succeeded` 分支已接受）。
2. **T8 缺陷 2（`x-mcode` 经编辑器手工 Import 丢失）**仍在——本卡不改节点包 `defaults`，
   那是 T28 的范围。
3. 真编辑器里对装载出的图做一次 Deploy → T2 对账账本应把这张 docId 镜像回 SQL（装载入口本身
   不 Deploy，这是用户动作）。
4. 多 tab / 引擎运行中装载的行为未在真 Electron 复验（T59 套件用假运行时覆盖了 stop/start 顺序）。

### 7. 提交

提交 SHA：**`5348bcbb828b1c1cf6899fc48ba0a83977c11502`**（提交后在同一提交状态复跑：
`t27-load-entry-deadlock-smoke` 40/40、`t21-orphaned-adapters-wired-smoke` 33/33、
`workflow-native-load-smoke` 18/18、双包 tsc exit 0）。

