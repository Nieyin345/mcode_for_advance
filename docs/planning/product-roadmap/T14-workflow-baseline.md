# T14｜Node-RED 唯一工作流内核现状与迁移基线（只读）

> **注（2026-10-26）**：本报告写于台账制度废止之前，文中对 `tasks/` 与 `audit-ledgers/` 的引用是**历史记录**，那两个目录已删除。功能目标见 `docs/功能文档.md`；进度看代码与套件。

> 2026-10-23 执行。任务卡：`tasks/T14-workflow-baseline.md`（P1 strategic baseline，只读）。
> **性质：E2 源码调用链 + 本轮 E1 隔离复跑 + U1 缺口清单。不是 ARC-006 完成声明，也不把“UI 能打开 Node-RED”当作“唯一运行时”。**
> 正式完成状态以 `audit-ledgers/Mcode_统一审查台账.md` 为准；本文件不改动任何 MC/ARC/UXG 勾选。

## 0. 基线身份与纪律

### 0.1 外层仓库（Mcode）

| 项 | 值 |
|---|---|
| HEAD | `2c93f70ef863084426790c46c11e916644b43904`（2026-10-23 01:52:31 +0800，`docs(tasks): record T5 commit SHA`） |
| 分支 | `master` |
| 工作树 dirty（**保持原样，本任务未重置/未清理**） | `.aoci/baseline.json`、`.gitignore`、`apps/desktop/scripts/maint-m35-smoke/pickers-prelude.ts`、`apps/desktop/scripts/orchestration-ipc-smoke/run.sh`、`apps/desktop/scripts/release-readiness-smoke/check-reviewed.cjs`、`apps/desktop/src/main/appControl/apiCatalog.generated.ts`、`apps/desktop/src/main/ipc/settingsTransfer.ts` |
| 本任务写边界 | 仅本报告 + 任务卡回写；未改 workflow 实现、测试、许可证门禁、`tasks/README.md` |

### 0.2 vendor 的 Node-RED（独立 Git checkout，被主仓 `/node-red/` 忽略）

| 项 | 值 |
|---|---|
| 路径 | `node-red/`（独立 `.git`；`.gitignore:72` `/node-red/`；`git check-ignore` 确认） |
| 分支 / HEAD | `mcode/integration` / `935b8d3e12ec8be064f3a72ac6547131f778a7b1` = upstream tag **5.0.8** |
| 与 tag 的差异 | `git diff --stat 5.0.8..HEAD` 为空、`git log 5.0.8..HEAD` 为空 —— **当前 integration 分支没有额外补丁，内容逐字节等于 5.0.8 tag** |
| 工作树 | clean（`git status --porcelain` 空） |
| 远程 | `ghfast.top` 镜像的 `https://github.com/node-red/node-red.git`（加速镜像；源仓库 URL 不变） |
| 包版本（E1，本机 `require package.json`） | `node-red`、`@node-red/editor-client`、`@node-red/runtime`、`@node-red/editor-api`、`@node-red/registry`、`@node-red/nodes`、`@node-red/util` 全部 `5.0.8` |
| 固定点常量 | `apps/desktop/build/stage-node-red-resources.cjs` `BASE_COMMIT`/`VERSION`；`apps/desktop/src/main/workflowEngines/runtimeSupervisor.ts:721` `NODE_RED_VENDOR_VERSION = "5.0.8"`，`:752` 版本不符即拒绝 vendor |

> 历史卡 T13（`docs/planning/node-red-vendor-integration-map.md`）记录的固定 commit 与本轮实测一致；T19 已 vendor 的声明成立。

## 1. 结论先行

1. **Node-RED 目前不是唯一运行时。** 仓库里同时存在两套执行器（`orchestration/runner.ts` 的宿主调度器 与 Node-RED 子进程 runtime）、两套触发器（`automation/automationRunner.ts` 的 cron/fs.watch/事件订阅 与 Node-RED 的 inject/watch/mcode-trigger/http-in）、两套审批（SQL 的 `workflow.review.v1.*` 与引擎目录的 `engine-trust.json`），以及**两处 flow 存储事实**（SQL `WorkflowDoc` 与引擎 `flows.json`）。
2. **“单图单引擎”是真的，“全应用单 runtime”不是。** `doc.engine` 在保存、启动、手动运行、派发四处被校验（E2 + 既有 E1）；但 `automationRunner.buildTriggers()` 在**安装监听时完全不看 engine**（`automationRunner.ts:497-586`，全文没有 import `workflowEngineSelection`），因此 `engine=node-red` 的图仍会被旧 runner 装上 cron 计时与目录监听，只是每次派发在 `fire()` 里被 owner 冲突或 `runner.ts:947` 的 assert 挡下。
3. **Deploy→Library 镜像仍是“成功后异步、失败只 log”**（`registry.ts:556-558` + `nativeLibrarySync.ts:47-58`），没有可查询的 pending/UNCERTAIN 对账状态；多 tab 同步还可能部分成功。T2 卡尚未落到具体 seam。
4. **持久化 flow 在重启后不会自动执行**：`safeMode` 默认开（`registry.BOOTSTRAP` `:99,114`），只有 `engine-trust.json = {"trusted":true}` 才放开（`registry.ts:409-417`），而**生产代码里没有任何 writer 写这个标记**（全仓 grep 只有读 + 两套 smoke 写）——`workflow.approve`（`workflowTrust.ts:89`）写的是 SQL 审批记录，不是引擎信任标记。用户批准过的原生 flow 重启后仍停跑。这是真实 U1 缺口，不是设计细节。
5. **owner 账本跨进程没有 OS 锁**：`FileExecutorOwnershipStore` 构造时整份载入内存 Map，`insert/remove` 后 `atomicReplaceFileSync` 整份覆写（`fileExecutorOwnershipStore.ts:65-167`），没有 `withOsFileLease`。而同一目录的 per-flow 存储 `NodeRedFlowStorage.saveFlow` 是有的（`nodeRedStorage.ts:375`）—— 两个并发机制并存，owner 账本弱于 flow 账本。T4 的验收正是要证伪/证实它。
6. **per-flow CAS 存储库（`NodeRedFlowStorage`，含项目隔离、docId 不漂移、OS 租约、坏档不装空）已经实现且测试很厚（E1），但生产没有任何调用方**：除 `nativeLibraryLoad.ts` 用 `readNativeCanvas/replaceNativeCanvas` 外，`NodeRedFlowStorage` 只在 smoke 里被 import。它是“可用的适配器库”，不是当前存储 owner —— 不能据此说“MERGE-1 存储唯一已落地”。

## 2. 单一事实源图：谁拥有什么

```
                     ┌──────────────────────────── 写路径 ────────────────────────────┐
 用户/Agent/UI 保存 ──► orchestration/library.ts saveWorkflow (:313-393)
                       │  校验 → engine 切换体检(checkEngineSwitch) → CAS(workflowSaveVersion)
                       ▼
                 SQL WorkflowDoc（WorkflowRepo，sql.js）  ◄── workflow.approve 写 workflow.review.v1.*
                       │                                       （workflowTrust.ts:89-121，SQL）
                       │  (1) workflowEngine.load：migrate → replaceNativeCanvas → 重启引擎
                       │      nativeLibraryLoad.ts:32-105（要求 doc.engine==="node-red" :44）
                       ▼
 用户原厂编辑器 ──► Node-RED 子进程 runtime（真 5.0.8）
   Deploy(POST /flows)   │  bootstrap adminAuth + Host owner 握手（registry.ts:214-289）
                       ▼
               <dataRoot>/workflow-engines/node-red/flows.json
                       │  上游 localfilesystem storageModule 落盘（未注入自定义 storageModule）
                       │  (2) 部署 2xx 后异步回写 SQL：nativeLibrarySync.syncNativeLibraryDocs
                       │      untrustedOrigin:"import" 强制重审（:76）；失败只 log
                       └──► 回到 SQL WorkflowDoc（单向镜像，非事务）

 触发器（两套，且互不知晓对方“安装”）：
   旧：automationRunner (全局 30s ticker :310-318 / fs.watch :622+ / runtimeManager.subscribe)
        └─ fire() 派发前 claim(mcode)（:2446,2569-2584）；startWorkflowRun 内再 assert（runner.ts:947）
   新：Node-RED 内置 inject/watch/http-in + mcode-trigger(事件订阅 port，nodePackProductionPorts.ts:186-199)

 执行归属（唯一读口）：executor-ownership.json（FileExecutorOwnershipStore）
        ├─ 引擎启动/认证 Deploy 预领取（registry.ts:535-609 / nodeRedOwnership.ts:69-84）
        ├─ 旧 runner 派发前领取（automationRunner.ts:2569）
        └─ 旧 runner 所有运行（含手动/API）acquireExecution（runner.ts:975）
        ⚠ 该文件无 OS 租约；启动时按 flows.json 对账（fileExecutorOwnershipStore.ts:85-113）

 审批（两套）：
   SQL：workflow.review.v1.<id>（origin/approvedRevision，workflowTrust.ts）
        管旧 runner 与 Agent 导入；Node-RED 部署回写时强制置 pending
   引擎：engine-trust.json（{"trusted":true} 才放开 safeMode）—— 当前无生产 writer
```

**所有权结论（逐个回答“谁拥有”）**：

| 对象 | 当前 owner | 竞争/旁路 |
|---|---|---|
| flow 内容（库语义） | SQL `WorkflowDoc` | 引擎 `flows.json` 是执行面副本，二者非同一事务 |
| flow 内容（执行面） | Node-RED 进程内存 + `flows.json`（上游 localfilesystem） | `NodeRedFlowStorage` 的 per-flow 档案是**未接线**的第三份（仅测试） |
| 触发安装 | 旧 `automationRunner`（无条件安装）+ Node-RED（部署后 runtime 内） | 旧端没有 engine gate（见 §4） |
| 执行归属 | `ExecutorOwnershipRegistry`（进程内 + 单文件） | 文件无跨进程锁；Node-RED 子进程自身不查账本，只由父进程握手 |
| 审批 | SQL review 记录（旧/Agent） + `engine-trust.json`（原生自动执行） | 两者互不引用；trust 标记无人写 |
| 运行历史 | 旧 runner：`runStore.ts` + 事件块；Node-RED：仅内存 runboard（`@node-red-runboard:<wf>`） | 原生运行没有持久运行史 |

## 3. 字段级迁移矩阵：旧 WorkflowDoc ↔ Node-RED flow

证据：`flowMigration.ts`（迁移器 v4，`FLOW_MIGRATOR_VERSION = 4`，`:233`）。正向 `migrateWorkflowDoc` `:713-1065`；反向 `flowToWorkflowDoc` `:1109-1419`；往返判据 `roundTripMismatchPaths` `:1425`。

### 3.1 文档/tab 级

| WorkflowDoc 字段 | Node-RED 落点 | 反向读取 | 证据 / 判据 |
|---|---|---|---|
| `id` | `tab.x-mcode.docId`；native tab id=`tab_<id>`、flow id=`flow_<id>` | `meta.docId`；tab 缺失时回落 `flow.id` | `:1008-1043`, `:1398` |
| `name` | `tab.label` + `x-mcode.name` | 原生 `tab.label` 优先（用户改名不丢） | `:1118-1121` |
| `engine` | `x-mcode.engine` | 原样；无 meta 的 flow 反推 `"node-red"` | `:1028`, `:1400` |
| `description/icon/prompt/frameworkNote/trigger/schemaVersion/inputSchema/outputSchema/builtin/updatedAt` | `tab.x-mcode.*`（**tab 是唯一能活过真实 GET /flows 的容器**） | 同键原样 | `:1025-1043`, `:1401-1412` |
| 文档级未知字段 | `x-mcode.unknown`（`safeUnknownFields` 剔除保留键、挡 `__proto__`） | 原样贴回 | `:389-398`, `:1039`, `:1413-1417` |
| 顶层 `links`（Mcode 私有边 sidecar） | **不是 Node-RED 格式**；部署只发 `nodes`，边元数据另挂源节点 `x-mcode.edgeMeta` | 真引擎回读无 `links` 时按 `edgeMeta` + wires 多重集匹配恢复 | `:986-1006`, `:1073-1095`, `:1301-1334` |

### 3.2 节点级（type 映射 = `NODE_RED_TYPE_OF_RUNNER` `:250-261` + `effectiveNodeRedTypeOf` `:285-300`）

| Mcode runner.kind | 原生 type | 原生可编辑字段（写进节点顶层） | 往返语义 |
|---|---|---|---|
| `prompt` (mcode.agent) | `mcode-agent` | `instruction/capability/outputVar` | Host 端口执行；原生表单为准，`x-mcode.params` 仅兜底（`mcodeNodePack.ts:112-120`） |
| `conversation` / `mcode.main` | `mcode-conversation` | 同上 | **需人工裁决**：主对话/会话挂接在事件触发下不存在（`:600-608`，MERGE-0 #1） |
| `branch` (decider=user) | `mcode-branch` | `decider/outputVar/note` | **需人工裁决**：真人挂起无原生等价（`:609-617`，#2）；decider=model 不挂起 |
| `condition` | `switch` | 最小规则：`mcode.condition` true→口0，否则口1 | lossy：完整表达式求值由 Host 承担（`:806-823`, `:848-857`） |
| `trigger` manual/schedule | `inject` | `crontab`/`once`/`repeat`/`props` | lossy：debounce/项目/task 留 sidecar（`:630-647`） |
| `trigger` file | `watch` | `files`/`recursive`（取 `paths`） | lossy：excludePaths/debounce 无原生等价 |
| `trigger` event | `mcode-trigger` | —（Host 订阅 `runtimeManager`） | **需人工裁决**：事件名/载荷映射（`:648-657`）；见 §5.3 |
| `command` | `exec` | `command/timer(秒)` | **需人工裁决**：非零退出在 Mcode 是 success、exec 视为错误（`:659-668`，#4）；code/command 产出契约 lossy（`:858-865`） |
| `code` language=node | `function` | `func/outputs/timeout(秒)` | timeout 毫秒→秒（`:327-329`） |
| `code` 其他语言 | `exec` | `command=解释器前缀+脚本文本` | **需人工裁决**：语言面/沙箱不等价（#3）；`input` 参数无原生接口（`:866-874`） |
| `module-capability` | `mcode-module-capability` | `moduleId/contributionId/path` | Host ModuleHost 执行 |
| `node-red` | `mcode-node-red-call` | `enginePath/engineMethod/engineBody` | 回环 Admin 调用，非 GET 需真人确认（`nodePackProductionPorts.ts:145-183`） |
| 未知 type | `mcode-unknown`，原始 type 留 `x-mcode.type` | — | `unmapped` 报告；**禁止**伪装可执行（`:757-763`） |

节点身份与元数据：

| 字段 | 落点 | 反向规则 |
|---|---|---|
| `nodes[].id` | native id `n_<id>`（折叠冲突用 hash 后缀）；`x-mcode.nodeId`、`x-mcode.nativeId` | 克隆/复制：复制节点获得新 Mcode 身份 `mcode_copy_*`，不继承旧审批（`:1129-1161`, `:1235-1244`） |
| `nodes[].type` | 原生 `node.type`；原 type 在 `x-mcode.type`；`nativeType` 记录派生类型 | 原生 type 与 `nativeType` 不一致 → **抛错拒读**（`:1162-1208`） |
| `title` | `node.name` | 原生名优先 |
| `params` | `x-mcode.params` + 原生顶层可编辑子集（`nativeNodeConfigOf` `:316-375`） | 原生表单字段优先；**明确清空不得被旧 sidecar 复活**（`mcodeNodePack.ts:112-118`） |
| `capability` | `x-mcode.capability` | 克隆后强降为 read（`:1238-1243`） |
| `position` | 画布 `x/y` 整数（小数舍入 → lossy 报告）+ `x-mcode.position` 原值 | 用户拖动 → 取原生坐标；未动 → 原值（`:840-846`, `:1210-1216`） |
| 未知节点字段 / position 未知分量 | `x-mcode.unknown` / `x-mcode.unknownPosition` | `safeUnknownFields` 过滤后原样贴回 |

### 3.3 边 / wires（Node-RED 的真相是 `wires[port][]` 里放**目标节点 id**）

| Mcode 边 | Node-RED | 反向 |
|---|---|---|
| `edges[].from/to` | `source.wires[port][]` 追加 target native id | 真编辑器回读以 wires 为准；sidecar 仅当与 wires 多重集完全一致才采用（`:1073-1095`, `:1251-1287`） |
| branch 出边顺序 | 端口号 = 文档内该源节点出边顺序（`:889-908`, `:959-976`） | 端口→边序还原；branch label 缺省由目标标题兜底（lossy 报告 `:938-947`） |
| condition label `true/false` | 端口 0 / 1 | 端口 0 回填 label "true"、1 回填 "false"（`:1359-1361`） |
| `label/note`/边未知字段 | `x-mcode-edge` + 源节点 `x-mcode.edgeMeta`（**不是原生 link 属性**） | 按 `sourceNativeId/sourcePort/targetNativeId` 精确匹配；改线/复制不继承（`:986-1006`, `:1301-1334`）；重复 edgeId 用 hash 修复（`:1253-1276`, `:1374-1392`） |

### 3.4 迁移不可无损的三类（沿用 T72 F-A～F-I 分类，本轮只做字段/源码复核）

- **SAFE 候选**：纯 Host 节点（agent/branch-model/condition 布尔/command）+ 整数坐标 + 无未知字段 + 无触发语义差异的图；判据 `checkEngineSwitch`（`workflowEngineSelection.ts:84-119`）+ `roundTripMismatchPaths` 全 0，且迁移报告 `unmapped/needsHumanDecision/lossy(位置除外)` 为空。
- **REJECT**：未知 type（`mcode-unknown` 必进 unmapped）；原生 type 漂移（`flowToWorkflowDoc` 抛错）；全局配置节点（`nativeFlowForWorkflow` 拒绝，`:69-73`）；多 tab 指向同一 docId（`nodeRedOwnership.ts:64`）、重复/空节点 id（`nodeRedStorage.looksLikeFlow`）；`flows.json` 损坏（`readNativeCanvas` 抛错，`nodeRedStorage.ts:543-560`）。
- **HUMAN**：会话/主代理绑定（#1）、branch 真人挂起（#2）、code 非 JS 语言面（#3）、command 非零退出（#4）、事件触发映射、cron 时区/漏点补跑、watch debounce/exclude、审批中断续跑、原生 runboard 历史。`workflowMigrationPreflight.ts:1443` 已有只读预检实现（T85 交付，34/34 断言），但**同样未接线到任何 IPC/Agent 入口**（全仓仅 smoke 引用）。

## 4. 触发器与执行归属：逐条现状（E2，全部可在源码复现）

| 事实 | 位置 | 结论 |
|---|---|---|
| 旧调度器 30s 全局 ticker | `automationRunner.ts:310-318`（`TICK_MS`），`onTick` `:897+` | 应用在跑就会计算全部 cron；错过分钟只记账不补跑（`sweepMissedSchedules`） |
| 旧文件监听 | `:622+` `rebuildWatchers`，`fs.watch(dir,{recursive})` 按目录共享 | 与 engine 无关 |
| `buildTriggers` 是否看 engine | `:497-586`；**全文无 `effectiveWorkflowEngine`/`workflowEngineSelection` import**（grep 无命中） | **安装阶段无 engine gate**；`engine=node-red` 的图也装监听 |
| 派发前 owner 领取 | `:2446` → `claimExecutorOwner` `:2569-2584` | Node-RED 正在运行时（其启动/Deploy 已预领取）→ 冲突，可见 skip，不执行 |
| 运行入口硬校验 | `runner.ts:947` `assertWorkflowExecutor(doc,"mcode")`（node-red 图直接抛）；`:975` `acquireExecution` | 即使 owner 账本为空（引擎从未启动、未部署），旧 runner 也只会建会话后失败——**不会真的跑 node-red 图**，但会留下失败运行与“已领取”瞬态 |
| 手动/API 直调 | `scheduler.ts:2342` assert；`runner.ts:947` assert | 同样拒绝 |
| Node-RED 启动预领取 | `registry.ts:601-609` + `nodeRedOwnership.claimNativeFlows` `:69-84` | 启动前按 flows.json 领取全部 native tab（含 `@node-red-native:*`） |
| 认证 Deploy 预领取 | `registry.ts:535-599` bootstrap `:226-289`；409 视为未应用、其它失败保留领取 | `assertNativeEngineSelection` 用 **Host SQL** 判定每张 tab 的 engine，伪造 `x-mcode.engine` 无效（`workflowEngineSelection.ts:25-43`） |
| 子进程退出/崩溃 | bootstrap `process.on("disconnect")` → `process.exit(0)`（`registry.ts:301-305`）；父侧 `onTerminated → releaseOwned` | 不留孤儿执行 |
| 归属持久化 | `fileExecutorOwnershipStore.ts` 构造对账 `:85-113`，启动时缺失/损坏 → 备份并 `blocked`；flows.json 有 native 而持久 owner 为 mcode → 阻断旧 runner | fail-closed 取向正确 |
| 归属并发 | `:145-162` 内存 Map 覆写 + `atomicReplaceFileSync`，**无 `withOsFileLease`** | 双进程可同时认为空并各自 insert（静态风险，T4 需双 OS 进程证伪） |

### 4.1 重复触发矩阵

| 场景 | 旧 runner 行为 | Node-RED 行为 | 现值判定 |
|---|---|---|---|
| 引擎 running + `engine=node-red` 图有 cron/watch 节点 | ticker/watch 仍安装；fire 先 claim → 冲突 skip（可见 lastError） | 原生 inject/watch 各自触发 | **执行 0 双跑；监听 2 份**（浪费+误导，T3 未闭环） |
| 引擎 stopped，图 `engine=node-red` 且**从未部署** | 安装监听；fire claim 成功 → `startWorkflowRun` assert 抛错 → 失败运行可见 | 无 | **无副作用双跑，但留失败运行/会话**；根因是缺 buildTriggers engine gate |
| 引擎 stopped，图已部署过（flows.json 有 docId） | 启动时对账把 owner 恢复为 node-red（`fileExecutorOwnershipStore.ts:93-104`）→ fire 冲突 skip | 无（引擎停） | 安全，但**原生触发在引擎停时整体哑火**（无“引擎应常驻”策略） |
| 同一 flow 两个原生 tab（同 docId） | — | `nativeFlowIdsOfNodes` 抛“拒绝重复触发”（`nodeRedOwnership.ts:64`）；`nativeFlowForWorkflow` 要求唯一 tab | fail-closed |
| 原生 Deploy 与旧 runner 同时图触发 | claim 一胜一败 | 父进程握手先于 apply | 双跑被挡；**但镜像写库失败只 log**（§5.1） |
| 重复/迟到 deploy-final | — | id 不匹配即忽略；uncertain 保留全部领取至引擎停 | 安全 |
| 崩溃后重启 | triggerClaims：CLAIMED→UNCERTAIN，不重跑（`triggerClaim.ts` 头注释）；lastMinute 跨重启去重 | 对账 flows.json 恢复 native owner | 安全取向 |
| 双 Mcode 进程同时 claim 同一 flow | 账本无锁 → 可能双成功（静态） | 子进程不直接写账本 | **T4 待证** |

## 5. 失败/恢复矩阵

| # | 失败点 | 当前行为 | 证据 | 用户可见性 |
|---|---|---|---|---|
| 5.1 | 原生 Deploy 2xx 后 SQL 镜像失败/崩溃 | `void this.syncLibrary(...).catch(log.error)`；无 pending 记录；多 tab 逐张 save，中途失败前面的已写 | `registry.ts:550-558`；`nativeLibrarySync.ts:47-58` | **只有日志**，库与原生版本可长期分叉（T2 根因） |
| 5.2 | Deploy 期间客户端断开/超时 | 子进程 5s 超时 → `final(false)`；`close` → `final(false,true)`；父进程 uncertain 保留领取 | `registry.ts:245-287` | 引擎日志 + 下次启动对账 |
| 5.3 | 镜像回写触发重审 | `saveWorkflow(..., untrustedOrigin:"import")` → 置 pending，旧 runner 立即停跑该图 | `nativeLibrarySync.ts:76`；`workflowTrust.ts:60-63` | 界面 pending 文案（library/runner 一致） |
| 5.4 | 原生 flow 重启后是否执行 | `safeMode` 默认开；`engine-trust.json` 只有 `{"trusted":true}` 算数；**生产无 writer** | `registry.ts:99,114,409-417,758-759` | 编辑器可见图但不跑；用户无入口批准原生执行 → **U1 缺口** |
| 5.5 | 库→原生装载失败 | `replaceNativeCanvas` 内容寻址备份 + 精确字节回滚；启动失败还原 | `nodeRedStorage.ts:572-609`；`nativeLibraryLoad.ts:85-97` | `requiresConfirmation` + 原因；smoke 17/17 |
| 5.6 | 引擎启动失败 | `EngineRuntime` 状态机 failed + reason；`beforeStart`（节点清单）失败阻断 spawn | `ipc/workflowEngine.ts:102-132`；`ipc/index.ts:237-243,282-284` | 面板徽标 + 原因 |
| 5.7 | owner 账本损坏 | 原档改名备份，`legacyBlocked` 持久化，旧 runner 拒绝接管；flows.json 不可验证同阻断 | `fileExecutorOwnershipStore.ts:69-113` | `executor-ownership` diagnostics 日志；UI 暴露程度未验（U1） |
| 5.8 | 旧定时中断 | CLAIMED 落盘 → 重启 `recoverIncompleteClaims` → UNCERTAIN；同分钟不重跑 | `triggerClaim.ts:1-70`；`automationRunner.ts:324-328` | 事实表 lastError |
| 5.9 | 错过 cron 分钟 | 只经 `sweepMissedSchedules` 记账，不补跑 | `automationRunner.ts:333-345,873+` | 错过提示（AUTO-09） |
| 5.10 | mcode-trigger 事件订阅溢出 | NodePackHost 每订阅缓冲 ≤256，超限关闭并抛错；引擎停则 dispose 全部 | `nodePackHost.ts:53-77,97-101` | 节点 error（Catch 可接） |
| 5.11 | 存档坏档 | `NodeRedFlowStorage.loadFlow` → `corrupt` 带原因，保存拒绝覆盖；list 显式列出 | `nodeRedStorage.ts:255-306,482-534` | **生产未接线**，暂无用户面 |
| 5.12 | 审批记录损坏 | `parseFlowTrust` 失败 → 视为 pending（不静默变批准）；审批 compareAndSet 防并发覆盖 | `workflowTrust.ts:54-121` | 重审文案 |

## 6. 精确测试证据（本轮 E1 复跑，隔离 dataRoot，未触真实用户数据）

| 套件 | 结果 | 覆盖本次结论 |
|---|---|---|
| `workflow-engine-selection-smoke` | **16/16 PASS** | 旧图默认 mcode、双向拒绝、伪造 x-mcode、找不到宿主文档拒绝 |
| `executor-ownership-smoke` | **17/17 PASS** | 单 owner 冲突/释放/防劫持快照 |
| `workflow-native-load-smoke` | **17/17 PASS** | 库→原生装载、确认替换、启动失败原子回滚、装载不写库 |
| `executor-gate-d-smoke` | **85/85 PASS** | 启动/Deploy 预领取、重启用 flows.json 对账、坏档 fail-closed、SIGKILL 后仍阻断 |
| `flow-migration-smoke` | **249/249 PASS** | 字段映射/往返/未知字段/备份/项目隔离/OS 租约/trust 组合 |
| `node-red-e2e-smoke` | **106/106 PASS** + vendor 阶段 PASS | 真 node-red@5.0.8 进程：bootstrap 挂载、adminAuth 401、safeMode 不执行、trusted 后执行、Admin Deploy、HTTP-in、owner 握手、vendor 5.0.8 编辑器与匿名拒绝 |

命令形态：`bash apps/desktop/scripts/<suite>/run.sh`（Windows 下经 Git Bash；`run-smokes.mjs` 以 `cwd=apps/desktop` 调 `scripts/<name>/run.sh`）。

**测试盲点（负控缺口）**：
- 没有任何套件以**两个真实 OS 进程**竞争 `executor-ownership.json`（`flow-storage-integrity-smoke` 只对 `NodeRedFlowStorage.saveFlow` 做了子进程，不覆盖 owner 账本）——T4 验收所需。
- 没有“`engine=node-red` 的图被旧 buildTriggers 装上 cron/watch”的红例——T3 需要先立此红。
- 没有“Deploy 2xx + 镜像 CAS 失败”的可查询对账红例——T2 需要先立此红（T93 卡已描述，但仓库无 `t93-*` 套件、无对应提交）。
- `node-red-e2e-smoke/run.sh` 从仓库根以相对路径调用时，`source "$(dirname "$0")/../lib/esbuild-path.sh"` 会失败（先 `cd` 再以相对 `$0` 解析）；经 `run-smokes.mjs`（cwd=apps/desktop）不受影响。用管道跑会吞掉非 0 退出码，形成假绿——本轮已改用绝对路径复跑取证。

## 7. 真实 U1 缺口（未取得真 Electron 证据，全部如实留空）

1. **真 Electron 主窗口 + 真 Node-RED 原生画布**的拖拽/Deploy/重开全链（T77、当前 T8）——本轮只有 headless E1。
2. **原生 flow 重启自动执行**：因 `engine-trust.json` 无生产 writer，用户无法通过任何真实入口批准“重启后继续跑”；`workflow.approve` 只作用于 SQL 图。
3. **原生编辑器凭据注入链**（`documentView.setEditorCredentials` → WebContentsView）只有源码与单测，无真窗口验证。
4. **多 tab 原生 Deploy → 库镜像**在真实编辑器多 tab 场景下的用户可见状态（当前冲突/失败仅日志）。
5. **原生 runboard 持久性**：`@node-red-runboard:<workflowId>` 事件经 `emitExternal` 进入渲染端会话块；重启后运行史是否保留未验（旧 runner 有 `runStore`，原生没有对应持久化）。
6. **三 SDK + 审批 + 取消 + 迁移**联合旅程（T8 依赖 T2/T3/T4）。
7. Node-RED 进程在真实安装包（vendor resources）中的启动/升级/回退演练（`node-red-vendor` 阶段已在 smoke 中 PASS，但非安装版 U1）。

## 8. T2/T3/T4 各自还缺什么（不重复卡片正文）

- **T2（Deploy/Library 对账）**：卡面已定义目标，缺的是**精确 seam 与负控**：接线点唯一在 `registry.ts` `mcode-deploy-final` → `syncLibrary` 调用处（`:550-558`）；镜像实现 `nativeLibrarySync.ts:47-58` 是逐张串行、失败即抛（部分成功）。T2 需要落一个可查询的 reconciliation 记录（pending/conflict/UNCERTAIN + 每 doc expected/observed revision）并把 `syncLibrary` 从 fire-and-forget 改为可审计；现有套件无此红例。
- **T3（触发单一归属）**：卡面要求“legacy 不能重复 Node-RED 拥有的触发器”。现状：**执行**被 owner claim + `runner.ts:947` 双重挡住，但**触发器安装**没有 engine gate（`buildTriggers` 不看 `doc.engine`），引擎停止且图从未部署时会走“claim 成功→运行入口抛错→失败运行”的次生路径。T3 的最小改动面应只在 `automationRunner.ts`（`buildTriggers`/`apply`/`reload`）加 `effectiveWorkflowEngine` 门并在事实表写明“交给 Node-RED”，不得顺带改 owner 账本。
- **T4（跨进程 CAS）**：卡面要求真双 OS 进程。现状证据：`fileExecutorOwnershipStore.ts:145-162` 无 OS 租约、整文件覆写；`nodeRedStorage` 的 `withOsFileLease` 模式可复用但**不能直接搬**（owner store 接口是同步的）。仓库里没有 `t97-*` 套件、也没有 T97 实施提交（`git log --all --grep=T97` 空）。T4 需要 (a) 双进程红例，(b) 在同步接口约束下引入锁或回写“接口不匹配”结论。

## 9. Top 受限实现切片（互不重叠的候选文件）

> 每个切片一行目标 + 独占文件；彼此不共享写入文件，可按此顺序派发。T8 仍须在 T2/T3/T4 之后串行占用 Electron。

| # | 切片 | 独占/候选文件（不重叠） | 前置红例 | 验收 |
|---|---|---|---|---|
| S1 | **触发器安装的 engine gate** | `apps/desktop/src/main/orchestration/automationRunner.ts`（仅 `buildTriggers/apply/reload` 邻域）+ 新 `apps/desktop/scripts/t3-engine-trigger-gate-smoke/**` | 虚构 `engine=node-red` 图仍装 cron/watch（本轮 E2 可复现） | 该图零监听、事实表显示“由 Node-RED 管理”；无 engine 旧图行为不变；两组变异红→绿 |
| S2 | **Deploy↔Library 对账记录** | `apps/desktop/src/main/workflowEngines/nativeLibrarySync.ts` + `registry.ts` 仅 `mcode-deploy-final`/`syncLibrary` 局部 + 新 `nativeDeployReconciliation.ts` + 新 `apps/desktop/scripts/t2-deploy-reconciliation-smoke/**` | 镜像 CAS 失败/部分 tab 失败仅日志 | success/partial/conflict/UNCERTAIN 可查询；重试不覆盖新版本；多 tab 逐张报告 |
| S3 | **owner 账本跨进程 CAS** | `apps/desktop/src/main/workflowEngines/fileExecutorOwnershipStore.ts` + 新 `fileExecutorOwnershipLease.ts` + 新 `apps/desktop/scripts/t4-owner-cross-process-smoke/**` | 两个真实 Node 子进程同 flowId 竞争可双成功（待证） | 至多一个 owner；不同 id 并发不丢；坏档/超时 fail-closed；两组变异 |
| S4 | **引擎信任标记的真人写入路径** | 新 `apps/desktop/src/main/workflowEngines/engineTrustMarker.ts` + `apps/desktop/src/main/ipc/orchestration.ts`（仅 `WORKFLOW_APPROVE` handler 邻域）+ 新 `apps/desktop/scripts/engine-trust-marker-smoke/**` | 批准后重启仍不执行（safeMode 永久开） | 仅 `workflow.approve`（真人、版本绑定）写 `{"trusted":true}`；撤销/修订变化即回退 untrusted；不新增第二授权入口 |
| S5 | **per-flow 存储适配器接线（后续，需先定 S2 方向）** | 新 `apps/desktop/src/main/workflowEngines/nodeRedStorageAdapter.ts` + bootstrap/launchSpec 的 storageModule 注入点（与 S2 协调同一文件，**不得并行**） | 两个客户端同时保存后写赢（当前只有上游 rev CAS） | 复用 NodeRedFlowStorage CAS；上游 GET/POST 不破；需另卡 |

不建议在本轮直接动的：`WorkflowCanvas`（已不存在，T45 删除 `351e4d9b`）、`nativeLibraryLoad.ts`（现有装载链已带备份/回滚，S2/S5 只读它）。

## 10. 已知限制

- 本报告是**只读源码 + 隔离 E1**；无真 Electron、无真三 SDK、无真双 OS 进程（S3 红例）、无多 tab 原生编辑器。
- `node-red-e2e-smoke` 的 106/106 来自本机 `.tmp/nr-e2e` 安装树 + `.tmp/node-red-release` vendor 阶段；不构成安装包 U1。
- 未读取真实用户 `flows.json`/SQL 库；未启动任何用户自动化。
- 工作树既有 dirty 文件未触碰；报告的 6 处“竞争”结论均可在所列 `path:line` 复现。
