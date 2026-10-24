# W0｜工作流主线基线核实与缺口清单

- Status: ready-for-agent
- Category: **基线核实**（不是功能交付）
- Priority: **P0 —— 后面所有实现卡都依赖这份清单**
- Depends on: 无
- Exclusive writable files: **只读 + `.tmp/w0/` 探针**。**不改任何产品代码。**

## Required Skills
- `mcode-smoke`：跑无头套件、读套件输出。
- `code-review`：区分「代码在」和「用户能用」。

## 为什么先做这个

路线图 §2 对工作流只有四条要求，但**「现在到底差多少」没有人量过**：

- T95 卡写于 2026-10-24，前提是「自研画布与 Node-RED 画布两套并存」。
- **但 `WorkflowCanvas.tsx` 已在 T45（`351e4d9b`）被删除。**
- 我（工作流总控）今天核实过一部分，但**没有系统证据**。

**在写实现卡之前，必须先把四条要求各自量清楚**，否则会写出「修一个已经不存在的问题」的卡。

## 任务

### 一、四条要求逐条取证

对路线图 §2 的四条，各给出**可复跑的命令 + 实际输出**：

| # | 要求 | 要回答的具体问题 |
|---|---|---|
| 1 | **原生画布** | `WorkflowCanvas.tsx` 是否真的不存在了？工作流 UI 现在挂的是不是原厂编辑器？有没有第二处画布入口？ |
| 2 | **运行时统一** | `nodeRedExecutor` 是怎么被调用的？除了 `ExecutionEngine` 之外，还有没有别的路径能执行 flow？ |
| 3 | **存储、触发权统一** | flow 存在哪（文件？DB？两处？）？`nodeRedStorage.ts` 与自研 `workflow.save` 是同一份还是两份？ |
| 4 | **不保留两套运行器/双触发** | 同一张图会不会被两条路径各跑一次？**这是红线，要明确回答是/否。** |

**每一条都要有**：命令、实际输出、结论。

### 二、产品可用性：用户能不能从零搭一个工作流

`t8-node-red-u1` 的旅程 `node-red-canvas-load-edit-deploy-reopen` 有 12 步，覆盖了
加载 / 导入夹具 / 部署 / 改节点名 / 单 owner / 跨进程 CAS / 重开。

**但它没有覆盖两件事**：

1. **从 palette 拖一个新节点**（旅程是导入现成夹具，不是"从零搭"）；
2. **真的跑起来看到结果**（部署成功 ≠ 执行出结果）。

**核实这两件事现在有没有别的证据**（套件、日志、手工记录）。**没有就明确写"没有"。**

### 三、输出缺口清单

按「对用户可见程度 × 修复成本」排序，每条写：

- **缺口是什么**（一句话）；
- **证据**（哪个文件/哪个套件/哪次实测）；
- **影响**（用户会看到什么）；
- **建议的修法方向**（只写方向，不写实现）；
- **预估规模**（几个文件、大概多少行）。

**不要写卡、不要派活、不要改代码。** 只给清单。

## 验收判据

1. **四条要求逐条有命令 + 输出 + 结论**；
2. **红线（第 4 条）明确回答是/否**；
3. **"拖新节点"和"真跑出结果"两个缺口明确回答有没有证据**；
4. **缺口清单按优先级排序，每条带证据与规模估计**；
5. **不改任何产品代码**（`git status` 里不能有你的产品文件改动）；
6. **不跑全量**（其他总控在并行改 UI/扩展/Office，全量不可靠）。

## 边界

- **只读 + `.tmp/w0/`**；
- 可以跑**单套**无头套件（`node-red-*` / `workflow-*` / `t8-node-red-u1` 的 `--only`）；
- **不碰** `apps/desktop/src/**`、`tasks/T*.md`、`tasks/README.md`（全局索引由其他总控维护）；
- **不写卡**——本目录的卡由工作流总控写。

## 已知的基线（我核实过，供你交叉验证）

这些是我今天跑的，**你要复跑确认，不要直接采信**：

| 事实 | 我的取证 |
|---|---|
| `node-red/` vendor 在，HEAD `935b8d3` | `git -C node-red rev-parse --short HEAD` |
| `WorkflowCanvas.tsx` 不存在 | `ls` 报 No such file |
| 它由 T45 `351e4d9b` 删除 | `git log --diff-filter=D` |
| `nodeRedExecutor` 注册进 `ExecutionEngine` | `executionEngine.ts:266` |
| `node-red-e2e-smoke` 通过 | 我跑过，`node-red-vendor runtime/editor verification: PASS` |

**⚠️ 按 CLAUDE.md 第二十七条：这些是「我取证那一刻」的状态。你读卡时先
`git log --oneline -3 -- <文件>` 确认还在不在。**

## 回写

`tasks/workflow/W0-workflow-baseline-and-gaps.md` 末尾追加 `## 结果回写`：
四条取证、红线判断、两个产品缺口、排序后的缺口清单。

---

## 结果回写（2026-10-24，W0 执行）

> 外层 HEAD `dbb571b8`（master，工作树有其它会话的在途改动）。所有结论都是**今天
> 单独复跑**得到的，不采信卡面上的「已知基线」。探针与日志在 `.tmp/w0/`。
> **没有改动任何产品代码**（`git status` 里 workflow 相关只有别人在途的
> `nodePackBundle.generated.ts`）。
>
> **⚠️ 取证时点**：T8 U1 的两次运行在 **18:11–18:20**；W1 的并行会话在 **18:37–18:40**
> 才写 `editor-flow.ts` / `journeys/index.ts` / 新的 `node-red-canvas-build-from-scratch.ts`。
> 所以下面 G4 的结论是**在 W1 改动之前**的树上取的——W1 若修了 `renameNodeViaEditor`
> 的通知遮挡，G4 的第 1 条可能已经消失，但**第 2 条（`baseline-deploy` 测别人职责）不受影响**。

### 零、先纠三处卡面 / 索引与事实不符的地方

| # | 卡/索引写的 | 实测 | 证据 |
|---|---|---|---|
| 1 | 卡面「`t8-node-red-u1` 的旅程有 **12 步**」 | **20 步**（14 个 `step.run` + 2 个 `assertEvaluated` + 3 个 screenshot + 1 个 relaunch；一次通过运行记录 `steps: 20`） | `node-red-canvas-load-edit-deploy-reopen.ts` 459 行；`.tmp/electron-u1/2026-10-23T05-22-35-284Z/suite-summary.json` `steps: 20` |
| 2 | `tasks/workflow/README.md` 第 1 条「**原生画布 已达成**」 | 前半句（手写画布已删）成立，但**「画布」只是"能看见"**：`WorkflowLibraryView` 的节点选择只剩 `selectedNodeId` 一个状态、没有**任何** UI 回写它（除 `openWorkflow` 的初始值）；右侧 `NodeInspector` 恒显示"工作流本体"，**用户点不到某个节点、也看不到它的参数**。见缺口 G2 | `grep -n "setSelectedNodeId(" WorkflowLibraryView.tsx` → 4 处全是清空/初始化，无一处由点击驱动；`WorkflowLibraryView.tsx:1153` 传 `selectedNodeId={selectedNodeId}`（值恒 null 或新建时选中的触发器） |
| 3 | `tasks/workflow/README.md` 第 2 条「运行时统一 = 一个调度器 + 多个执行器」 | **对"旧 runner"成立，对"整机"不成立**：模块级 `executionEngine` 单例**永远不注册** `node-red` 执行器（装配顺序，见 §2.2），所以自动化预检读到的 `executorKinds` 里没有 `node-red`。**实际上有两个执行面**：旧 `ExecutionEngine`（mcode 图）与 Node-RED runtime（node-red 图）——这就是路线图要统一的那个边界，不是"已经统一好了" | §2.2 探针 `.tmp/w0/executor-registry-order-probe.ts` 输出 |

**另外三处过期的引用**（不影响本次结论，但写卡/派活时会被照抄）：

- `tasks/workflow/W1` 与 `W2` 都说旅程「459 行、12 步」——行数对，**步数错**（20）。
- 两份卡都说 `editor-flow.ts` 的 `sendInputEvent` 三件套在「`:66-68`」——实际 `clickAt` 在 **`:64-69`**（文件已长到 360 行）。
- `tasks/workflow/README.md` 的 W5 写「`nodeRedStorage.ts` **609 行**」——文件现 609 行**未变**，但 `NodeRedFlowStorage` **类**只被 `nativeLibraryLoad.ts` 当"装载日志"用（`JOURNAL_PROJECT_ID = null`），**不是**存储真相源。

---

### 一、四条要求逐条取证

#### ① 原生画布

**Q1：`WorkflowCanvas.tsx` 是否真的不存在了？**

```
$ find apps/desktop/src -iname "*workflow*" | sort
（无 WorkflowCanvas.tsx）

$ grep -rn "WorkflowCanvas" apps/desktop/src/
（零命中，EXIT=1）

$ git log --oneline -3 -- apps/desktop/src/renderer/components/settings/workflows/WorkflowCanvas.tsx
351e4d9b feat(workflows): replace handwritten canvas entry with Node-RED editor (T45)
...
$ git show --stat 351e4d9b | grep WorkflowCanvas
 .../settings/workflows/WorkflowCanvas.tsx | 685 ---------------------
```

**结论：是。** 685 行删除，`grep` 零残留（连注释里的名字都清了——`WorkflowNodeCard` 与
`WorkflowFlowMini` 的头注释仍提到它，但那是对**图表卡片组件**的说明，不是导入）。

**Q2：工作流 UI 现在挂的是不是原厂编辑器？**

```
$ grep -rn "EngineRuntimePanel" apps/desktop/src/renderer --include=*.tsx | grep -v "EngineRuntimePanel.tsx"
RightPanel.tsx:6:  import { EngineRuntimePanel } from ".../EngineRuntimePanel.js";
RightPanel.tsx:360: <EngineRuntimePanel engineId={engineId} editorOnly active={selected} />
WorkflowsPanel.tsx:66: import { EngineRuntimePanel } from "./EngineRuntimePanel.js";
WorkflowsPanel.tsx:263: <EngineRuntimePanel key={nativeCanvasEpoch} active={view === "engines" && !flowDocked} />
```

渲染端**没有任何 iframe/webview 承载 Node-RED**；它是 `documentView.open({ ..., workflowEngineId })`
把一块**原生 `WebContentsView`** 摆到 `data-engine-view-stage` 的矩形上
（`EngineRuntimePanel.tsx:232`；主进程 `documentViewHost` 按 `workflowEngineId` 注入
`Authorization`，令牌不进 URL/status——见 `documentViewCredentialBroker.ts` 文件头）。

**Q3：有没有第二处画布入口？**

**有两处挂载，但共享同一个组件、同一个引擎、同一个 docId**——都是"原厂编辑器"，不是"第二块画布"：

| 入口 | 位置 | 说明 |
|---|---|---|
| 设置 → 工作流 → 第三方引擎页 | `WorkflowsPanel.tsx:263` | 详情面板的 `WorkflowNativeEditorEntry` 按钮 `workflowEngine.load` + `setView("engines")` |
| 右栏「NR」药丸（docked flow pane） | `RightPanel.tsx:360`，`flowId: "node-red"` | `EngineRuntimePanel editorOnly`，同一 `engineDocId("node-red")`，`active` 互斥（`flowDocked` 时引擎页传 `active=false`） |

**结论：是（唯一画布 = 原厂编辑器，两个入口，一个 docId）。** 但**「挂上原厂编辑器」≠「用户能编辑图」**——
见下面 G2：节点选择、加节点、连线、删除都没有 UI 路径（自研画布的交互被删干净了，替代品没接上）。

#### ② 运行时统一

**Q1：`nodeRedExecutor` 是怎么被调用的？**

```
$ grep -rn "nodeRedExecutor" apps/desktop/src/main/
executionEngine.ts:18,20 （import）
executionEngine.ts:266  engine.register(nodeRedExecutor({...}))   ← 条件注册
nodeRedExecutor.ts:191  export function nodeRedExecutor(ports): NodeExecutor
nodeTypes.ts:108,148,928 （清单引用，非调用）
```

调用链（**只有一条**）：

```
manifest.runner.kind === "node-red"
  → runner.ts:2100  runEngine.execute({ node, manifest, input, ... })
  → scheduler.ts:1609  await this.ports.execute(node, manifest, input)
  → ExecutionEngine.execute → registry.get("node-red") → nodeRedExecutor.execute
  → defaultNodeRedFetch → http://127.0.0.1:<enginePort>/api/...
```

**关键前置**：`executionEngine.ts:265` 的注册是**条件**的——只有 `workflowEngineUsable("node-red")`
（状态口说 running 且端口非 null）才 `register`。状态口由 `main/index.ts:86`
`setWorkflowEngineStatusPort(...)` 注入。

**Q2：除了 `ExecutionEngine` 之外，还有没有别的路径能执行 flow？**

**有，而且是设计上的另一半——Node-RED 自己的 runtime。** 两个执行面各跑各的图：

| 执行面 | 跑什么 | 入口 | 触发源 |
|---|---|---|---|
| 旧 `ExecutionEngine` | `engine === "mcode"` 的 `WorkflowDoc`（库里的图） | `runner.ts` / `scheduler.ts`（聊天、自动化、AI `app_workflow_run`） | `automationRunner` 的 cron / fs.watch / 事件订阅 |
| Node-RED runtime | `engine === "node-red"` 的 tab（`flows.json`） | `registry.ts` 的 `BOOTSTRAP`（子进程），部署走宿主中介的 `POST /flows` | 引擎自己的 inject / http-in / `mcode-trigger` |

`node-red` 图**不会**被旧引擎跑：`assertWorkflowExecutor(doc, "mcode")` 在 `runner.ts:947` 与
`scheduler.ts:2342` 两处 fail-closed；`automationRunner.buildTriggers` 的 `legacyTriggerOwnerOf`
（`:519`）对 `engine=node-red` **一个监听都不装**（`t3-engine-trigger-gate-smoke` 54/54 覆盖）。

**但这里有一个真实的装配缺陷（本轮新发现）**：

---

**⚠️ §2.2 模块级 `executionEngine` 单例永远拿不到 `node-red` 执行器**

`main/index.ts` 的装配顺序：

```
:46  import { setWorkflowEngineStatusPort } from "@main/orchestration/executionEngine.js"
       ↑ 模块体在这里求值：export const executionEngine = createBuiltinExecutionEngine()
         此刻 workflowEngineStatusPort === null → workflowEngineUsable() === false → 不注册 node-red
:86  setWorkflowEngineStatusPort((id) => workflowEngineRegistry.statusOf(id))
       ↑ 太晚了 —— 单例已经在 :280 构造完毕，注册是构造期一次性的
```

**探针实测**（`.tmp/w0/executor-registry-order-probe.ts`，真代码、注入假状态口）：

```
module singleton kinds BEFORE port set: [ 'command', 'code', 'module-capability' ]
module singleton kinds AFTER port set:  [ 'command', 'code', 'module-capability' ]
a fresh engine created after port set:  [ 'command', 'code', 'module-capability', 'node-red' ]

verdict:
  module singleton registers node-red: false
  per-run engine registers node-red:   true
```

**谁在读这个单例？**

```
$ grep -rn "executionEngine\b" apps/desktop/src/main --include=*.ts | grep -v executionEngine.ts
ipc/orchestration.ts:83,396   const executorKinds = [...executionEngine.kinds()];   ← 自动化预检
appServices/scenePreflight.ts:25,75   executorKinds: [...executionEngine.kinds()]   ← 场景预检
```

**影响**：`automationPreflight` 的 `executorKinds`（`ipc/orchestration.ts:396`）里**没有 `node-red`**。
`requirementsForNode(..., preflight.executorKinds)`（`automationPreflight.ts:166`）→ 含
`mcode.node-red` 节点的图在**预检**里被报「缺执行器」；而真正派发时用的是 `runner.ts:2039`
**每次运行新建**的 `createBuiltinExecutionEngine()`（那时端口已注入 → 注册了 node-red），
**能跑**。即：**预检说不能跑、实际能跑**——一条假失败，方向是"把用户往错处指"。

**代码里自己写过这条约束**（`executionEngine.ts:120-123`）：

> 「生产在装配处（`main/index.ts`）调 `setWorkflowEngineStatusPort(...)`」

——注释描述的是**意图**，实现是**构造期快照**。这不是"没做"，是**做了一半**。
`execution-engine-smoke` 63 条不红：它注入假状态口后**新建**引擎来验（同探针「fresh engine」
那一行），从不验模块单例。

#### ③ 存储、触发权统一

**Q1：flow 存在哪（文件？DB？两处？）**

**两处。** 这是已知的结构性事实（`tasks/README.md:269` 「flow 存储两份」仍成立），本轮复核确认：

| 存储 | 位置 | 谁写 | 谁是真相源 |
|---|---|---|---|
| SQL `workflows` 表 | `WorkflowRepo`（`store/repositories/workflow.ts`） | 界面「保存」/ AI `workflow_save` / 导入 | **用户文档**（Mcode 库） |
| `<engineDir>/flows.json` | `dataRoot/workflow-engines/node-red/` | Node-RED 引擎自己（`POST /flows`）；宿主 `replaceNativeCanvas` 在 load 时整份写 | **引擎执行** |
| `flows/<safe-doc-id>.json`（`NodeRedFlowStorage`） | 同上 `flows/` 子目录 | `nativeLibraryLoad.ts:194` 当**装载日志**用（`JOURNAL_PROJECT_ID = null`） | **不是**真相源——文件头自己写「derivative, never a source of truth」 |

两处之间靠 `nativeLibrarySync.ts` 的**非原子对账**连接（`deploy-reconciliation.json` + 启动重放），
`node-red-e2e-smoke` 106/106 里就有三条 `[error] ... 库镜像未完成 ... getDb() called before initDb()`
——**这是套件的预期路径（pending），不是失败**，但它是"两套存储之间没有事务"的直接证据。

**Q2：`nodeRedStorage.ts` 与自研 `workflow.save` 是同一份还是两份？**

**两份，不是同一份。** 两者的键是同一个（`x-mcode.docId === WorkflowDoc.id`），**内容模型不同**
（`WorkflowDoc` 有 `edges` / `position` / `params`，Node-RED flow 有 `wires` / `x,y` / `x-mcode`），
经 `flowMigration.ts` 双向转换。`NodeRedFlowStorage` 的 CAS 只在"装载日志"那层用，**不参与**
用户保存路径——用户点「保存」走 `saveWorkflow`（SQL），AI `workflow_save` 也走同一条。

**Q3：触发权在哪？**

**按 `doc.engine` 分流，fail-closed**（代码层面已做）：

```
automationRunner.buildTriggers (:553)  legacyTriggerOwnerOf(doc)
  mcode（含缺省） → 装 cron / fs.watch / 事件订阅
  node-red        → 一个监听都不装，事实表写「由 Node-RED 引擎管理」
  未知值          → 不装，事实表写 fail-closed
```

`t3-engine-trigger-gate-smoke` **54/54**（本轮复跑），覆盖六条判据含「契约外 engine 判坏档」。
`runNow` / `runWithTarget`（`:1987,:2028`）同一道 `foreignOwnerOf` 闸。

**但「触发权统一」缺一条**：**Node-RED 图的触发器从不在宿主侧登记，只在引擎里**。
宿主不知道某张 node-red 图有哪些触发器、是否启用——`automation.statusAll` 里只有
`armed:false, detail:"由 Node-RED 引擎管理"` 这一行**占位**。用户看不到"它什么时候会跑"。

**Q4（新发现）：`engine-trust.json` 无生产 writer —— 发布的 flow 重启后不自动跑**

```
$ grep -rn "engine-trust" apps/desktop/src --include=*.ts --include=*.tsx
registry.ts:421  readFileSync(join(dataDir, "engine-trust.json"), "utf8")   ← 只有读
（全仓无 writeFileSync / atomicWrite 到该文件；只有三套 smoke 自己写）
```

`registry.ts:109`：`const safeMode = process.env.MCODE_ENGINE_TRUSTED !== "1";` → 生产每次启动
**默认 safeMode**；`node-red-e2e-smoke` 的 A10 段证明"写了标记才自动执行"。

**后果**：用户在原生编辑器里拖一条 `inject → debug`、点部署、看着它跑——**重启 Mcode 后再也不跑**。
编辑器里图还在（`GET /flows` 读得到），但 inject 定时/http-in 全 404。
`tasks/README.md:295` 已把这条记为「✅ 仍成立」，**本轮复核确认**（T14 也记过）。这是
**发布级缺陷**，不是"以后接审批"——`registry.ts:57` 注释写「把标记的写入接到 Mcode 的
`workflow.approve`」，但 `approveWorkflowRevision`（`workflowTrust.ts:89`）写的是
**SQL `workflow.review.v1.*`**，两条账本至今互不引用。

#### ④ 红线：不保留两套运行器 / 双触发

**明确回答：结构上「不双跑同一张图」= 是；「只有一套运行器」= 否。**

**「同一张图会不会被两条路径各跑一次」——不会。** 三层独立防线，本轮逐条复跑：

| 防线 | 位置 | 覆盖它的套件（本轮实跑） |
|---|---|---|
| 调度器入口 | `assertWorkflowExecutor(doc, "mcode")`（`runner.ts:947`、`scheduler.ts:2342`） | `workflow-engine-selection-smoke` **16/16** |
| 触发安装 | `legacyTriggerOwnerOf`（`automationRunner.ts:519`）——node-red 图一个监听都不装 | `t3-engine-trigger-gate-smoke` **54/54** |
| 运行期 owner 租约 | `sharedExecutorOwnership.acquireExecution / claim`（`executorOwnership.ts:243,:178`），落盘 `executor-ownership.json` + 跨进程 lease | `executor-ownership-smoke` **17/17**、`executor-gate-d-smoke` **85/85** |
| 原生部署前 | `onDeployMessage`（`registry.ts:583`）在 `POST /flows` **之前**抢 owner，冲突 423 | `node-red-e2e-smoke` **106/106** |

**但「不保留两套运行器」不成立**：`ExecutionEngine`（mcode 图）与 Node-RED runtime（node-red 图）
是**两套运行器**，只是**互斥地**各跑各的图。路线图原文是「唯一流程内核」——现状是
**两个内核 + 一张互斥表**。这不是"违背红线"（红线是**双跑**），但它是**路线图 §2 明确要收敛的东西**，
而且收敛的真正障碍是：**mcode 图与 node-red 图能力不等价**（见 §3）——现在还不能删掉任何一个。

**红线判断**：

> **「同一张图被两条路径各跑一次」= 否（结构上不可能，有 4 层防线 + 4 套套件）。
> 「只保留一套运行器」= 否（两套都在，靠 owner 表互斥）。**
> 结论：**红线（禁止双跑）满足；目标（唯一内核）未达成。** 这是**有意的迁移期状态**，
> 不是缺陷——但它必须记在"还没做完"那一栏。

**另有一处双写风险（不是双跑，但同族）**：`workflowEngine.load` 会 `runtime.stop()` → 写
`flows.json` → `runtime.start()`。若此刻引擎里有**未部署的编辑**，它们**没有持久化**
（Node-RED 只在 Deploy 时落盘）——load 的确认文案（`nativeLibraryLoad.ts:225`）确实写了这一点，
`workflow-native-load-smoke` 18/18 覆盖了"确认/拒绝/回滚"，但这依然是"两个存储之间会丢东西"的
已知口子。

---

### 二、产品可用性：用户能不能从零搭一个工作流

#### ① 「从 palette 拖一个新节点」——**没有证据**

```
$ grep -c "palette\|drag" apps/desktop/scripts/t8-node-red-u1/journeys/node-red-canvas-load-edit-deploy-reopen.ts
0

$ grep -rn "RED.view.addNode\|palette.addNode\|core:add-node" apps/desktop/scripts/
（零命中）
```

- T8 的「编辑」是 `RED.editor.edit(node)`（**双击处理器**）+ 真键盘改名——**改已有节点**，不是新建；
- `mcode-node-pack-smoke` 断言的是 **palette 里注册了 7 个类型**（`GET /nodes` + HTML 模板计数），
  不是"拖进去了"；
- `x-mcode-roundtrip-smoke` 在 **vm + 真上游 `nodes.js`** 里走 export/import，**不是**编辑器手势；
- 上游 `palette.js` 的 `draggable({ revert: 'invalid' })` 需要**真 mousedown → mousemove → mouseup**
  （W1 卡已核实），现在的 `editor-flow.ts` 只有 `clickAt`（move→down→up），**没有 drag helper**。

**结论：没有证据。W1 的缺口描述准确。**

#### ② 「真的跑起来看到结果」——**无头层有，UI 层没有**

**有的（无头 E1/E2，本轮全部复跑通过）**：

| 套件 | 结果 | 它证明了什么 |
|---|---|---|
| `node-red-e2e-smoke` | **106/106 + `node-red-vendor runtime/editor verification: PASS`** | 真 spawn 引擎 → 真部署 → **HTTP-in 真 200**（含"可信标记后重启自动执行"） |
| `mcode-node-pack-smoke` | **393/393** | 迁移流整组启动（HTTP-in 200）；**5 个经 Host 端口的节点各执行一次**（trigger/conversation/agent/branch/module-capability） |
| `t96-probe` | **54/54** | **`mcode-agent` 的 execute 真跑了、真调到了 Host 端口**、结果回灌下游 |
| `node-red-deploy-reconciliation-smoke` | **75/75** | Deploy → 库镜像 + 看板事件（`@node-red-runboard:<docId>`） |

**没有的（真 Electron UI 层）**：T8 旅程里**没有**任何一步：点 inject、打开 debug 侧栏、看到 payload。
```
$ grep -n "debug\|sidebar\|inject" .../node-red-canvas-load-edit-deploy-reopen.ts
（只有第 6 行「凭据注入」，不是 inject 节点）
```
W2 的缺口描述准确。

**⚠️ 而且 T8 这条旅程现在本身是红的**（见下节）——**它不是"缺证据"，是"证据断了"**。

#### ③ 本轮实跑的 T8 U1：**当前是红的**（两次独立运行都没过 `rename-node-via-tray`）

```
$ cd apps/desktop && node scripts/t8-node-red-u1/run.mjs
...
→ node-red-canvas-load-edit-deploy-reopen: literal=FAIL expectation=unexpected-failure failedStep=rename-node-via-tray
U1 suite: 2 journeys — all-pass=0 expected-failure=1 unexpected-failure=1
T8: FAIL（期望 1；2 = 意外失败）
```

- **历史**：2026-10-23 有 13 次全绿（最近 `05-22-35-284Z`，20/20 步）
- **现在**：`2026-10-23T09-47-24-598Z` 与 `2026-10-24T10-17-36-085Z`（本轮）都红在同一处

**根因不是"改名 helper 写了新 bug"，也不是"页面改版"——是 T27 修好装载入口之后，旅程走到了一条
以前走不到的路**：

| 证据 | 通过那次（05-22） | 失败两次（09-47 / 10-17） |
|---|---|---|
| `production-load-entry` | `known-lossy-refusal`（被拒，画布空） | **`loaded`（真的装进去了）** |
| 首屏提示 | （无） | **「流程以安全模式停止」**（`safeMode`，因为 `engine-trust.json` 不存在） |
| `baseline-deploy` | PASS | **PASS，但截图里是「部署失败：服务器没有响应」** |
| `rename` 失败原因 | —— | `activeId: ""`（点名称框后焦点不在输入框），`inputRect y=170` 正是三条通知叠住的位置 |

**三个独立缺陷叠在一起，都值得单独记：**

1. **`rename-node-via-tray` 对"画布上有多条持久通知"没有防御**——通知条（`.red-ui-notification`）
   盖在 `y≈68..400`，正好压住编辑托盘顶部的名称框；`clickAt` 打到通知上，焦点丢了。
   旅程在**装载成功**之后必然遇到这三条通知（safeMode + 导入 + 部署失败）。
   **这是断言脆弱，不是产品缺陷**（真人会先关通知）。
2. **`baseline-deploy` 在"部署失败"时仍然 PASS**——它的判据是
   `deploy.clicked && baselineSha !== null && agent.name === "检查 README"`。而
   **`flows.json` 其实在更早的 `workflowEngine.load`（T59 装载）里就被宿主写进去了**，
   所以字节和名字都满足，**点部署有没有成功完全不影响这步**。
   截图里的「部署失败：服务器没有响应」是**真的**：宿主 `POST /flows` 的 ownership 握手
   （`registry.ts:284`，5 秒超时）没等到父进程回复。**这条断言测的是别人的职责**
   （CLAUDE.md 第十五条：提到 ≠ 守着）。
3. **`rename` 失败 → 后面 12 步（deploy 字节对比 / 重开 / owner 账本）全部没跑**——
   这条旅程的"Deploy 之后磁盘字节真的变了"这个核心判据，**最近两次运行都没验到**。

**诚实边界**：本轮**没有**在真 Electron 里手工确认"部署到底成不成功"——只凭证据目录里的
DOM 快照（`dom/failure-rename-node-via-tray-g1.html` 里 `red-ui-notification` 文本含
「部署失败: 服务器没有响应」）与 journey 结果。**部署失败的根因未查**（可能是 T27 之后
`loadWorkflowIntoNative` 重启引擎导致的 ownership 恢复时序，也可能是通知遮挡导致
`confirmDeployWarningIfPresent` 点不到——但 `deployWarningConfirmed:false` 说明它没弹）。

---

### 三、排序后的缺口清单

按「**用户可见程度 × 修复成本**」排序；每条带证据、影响、修法方向、规模。

#### G1（P0）**发布后重启，工作流不再执行** —— `engine-trust.json` 无生产 writer

- **证据**：`grep -rn "engine-trust" apps/desktop/src` 只有 `registry.ts:421` 的 `readFileSync`；
  `registry.ts:109` `safeMode = MCODE_ENGINE_TRUSTED !== "1"`；`node-red-e2e-smoke` A10 段
  （`main.ts:576`）证明"写了标记才自动执行"；`tasks/README.md:295` 记为「仍成立」。
- **影响**：用户在原生编辑器里搭好、部署、看着它跑的图——**关掉 Mcode 再打开就不跑了**。
  编辑器里图还在、看起来一切正常，inject 定时/http-in 全 404。**这是"工作流"这个产品名的底线**。
- **修法方向**：把"用户批准某张图 = 写 `engine-trust.json`"接到**已有的**审批入口
  （`workflow.approve` → `approveWorkflowRevision`），**不新造第二套授权**；写标记必须与
  owner/审批记录一致（`flowTrustGate.ts` 的 `canExecuteFlow` 已经把三态判据写好了，
  只缺"写"这一半）。**注意**：标记是**按引擎目录**（`<dataDir>`）一份，不是按 flow——
  要么改成按 flow（`flowRevision` 入标记），要么明确"批准一次 = 批准整份 flows.json 的当前版本"。
- **规模**：主进程 2–3 文件（`workflowTrust.ts` + 一个写标记的适配器 + `ipc/orchestration.ts` 接线），
  约 **80–150 行** + 1–2 套 smoke（改标记/坏标记/rev 不符三态）。

#### G2（P0）**库面板里点不到节点** —— 自研画布删了，替代交互没接上

- **证据**：`WorkflowLibraryView.tsx` 的 `selectedNodeId`（`:195`）只有 4 处写：初始化（`:296`）、
  节点被删时清空（`:562`）、删节点后清空（`:873`）、新建时选中触发器（`:687`）。**没有一处由点击驱动**；
  `NodeInspector`（`:1153`）拿到的 `selectedNodeId` 在普通工作流里**恒为 null** →
  右侧永远显示"工作流本体"，**节点参数表单不可达**。
  `workflow-view-smoke` 763 条全绿：它**直接构造** `NodeInspector` 并传 `selectedNodeId: "B"`（`:552`），
  **绕过了"用户怎么选中节点"这个真实问题**。
- **影响**：用户能看见图（原生编辑器），但**在 Mcode 里改不了任何一个节点的参数**。
  「工作流库」那一栏现在只剩：改名 / 改说明 / 改框架说明 / 导入导出 / 删——**图本身只能去原生编辑器改**。
  而原生编辑器里的 `mcode-agent` 表单（截图里可见：权限能力 / 输出变量 / Mcode 会话 ID）
  **不等于** Mcode 库里的全部参数（`x-mcode.params` 里还有 debounce、project、task 等）。
- **修法方向**：二选一——
  (a) **在原生编辑器里补齐**（Mcode 节点 HTML 的 `defaults` 声明全部参数，让它们真能编辑）；
  (b) **在库面板加一个"节点列表"**（`WorkflowLibraryView` 左侧或列表下方），点击 → `setSelectedNodeId`，
      让 `NodeInspector` 活过来。**(b) 更省**（已有组件全在，只缺一个列表 + 一个 `onSelect`）。
  **不要再写第三块画布。**
- **规模**：(b) 约 **1 文件 + 60–120 行**（`WorkflowLibraryView` 里一个节点列表块）+
  `workflow-view-smoke` 加"点列表项 → 检查器切到该节点"的断言。**(a) 要大一个量级**
  （`mcodeNodeTypes.ts` 六个类型的 HTML + `defaults` 映射，300+ 行）。

#### G3（P0）**模块级 `executionEngine` 永远缺 `node-red` 执行器** —— 预检说不能跑、实际能跑

- **证据**：`main/index.ts:46` 的 import 先于 `:86` 的 `setWorkflowEngineStatusPort`；
  `executionEngine.ts:280` 模块体 `createBuiltinExecutionEngine()` 在端口注入前求值。
  探针 `.tmp/w0/executor-registry-order-probe.ts`：单例 `kinds()` **永远**不含 `node-red`，
  运行期新建的引擎**含**。消费方：`ipc/orchestration.ts:396`、`scenePreflight.ts:75`。
- **影响**：**自动化预检**（`automation.preflight`，AI `app_api_call` 与界面同一 handler）对含
  `mcode.node-red` 节点的图报「缺执行器」；用户按提示去"装/启动引擎"，引擎明明在跑。
  **假失败，且指向错误方向**。
- **修法方向**：把 `executionEngine` 从"模块级单例"改成**惰性**（`getExecutionEngine()` 首次调用时建，
  或注册表支持运行时 `register`）；最简单的是让 `setWorkflowEngineStatusPort` **重建**单例
  （代价：已缓存的引用失效——所以更稳的是 `ExecutionEngine` 支持 `register` 后补注册）。
- **规模**：**1 文件、约 15–40 行** + `execution-engine-smoke` 加一条"单例在端口注入后能拿到 node-red"。

#### G4（P1）**T8 U1 旅程当前是红的，且 `baseline-deploy` 测的是别人的职责**

- **证据**：本轮 `node scripts/t8-node-red-u1/run.mjs` → `failedStep=rename-node-via-tray`；
  证据目录 `2026-10-24T10-17-36-085Z`；DOM 快照里三条 `red-ui-notification`；`baseline-deploy`
  的判据（`:230`）只看 `flows.json` 的字节与节点名，**与 `clickDeploy` 的结果无关**。
- **影响**：工作流主线**唯一**的真 Electron U1 证据**断了**；而且"部署成功没有"这条核心判据
  **从来没有在 T27 之后被真的验过**（通过那次的 `production-load-entry` 是 `known-lossy-refusal`，
  画布是空的——它测的是另一条路）。
- **修法方向**：① `renameNodeViaEditor` 点击前先关掉所有 `.red-ui-notification`（真用户手势：
  点通知上的 ×），或在 `clickAt` 前断言"该坐标上最顶层是输入框"；② `baseline-deploy` 改为
  断言 `clickDeploy` 之后**有一次成功的 `POST /flows`**（或 `flows.json` 的 mtime/sha **在点击之后**
  变化），而不是"文件里恰好有这个名字"；③ 部署失败要**显式红**（截图已经把证据留下了）。
- **规模**：**1–2 文件（都在 `scripts/t8-node-red-u1/`）、约 40–80 行**；**不碰产品代码**。

#### G5（P1）**「从零搭」+「看到结果」没有 UI 证据**（W1 / W2 原缺口，本轮确认无证据）

- **证据**：见 §2.① / §2.②（`grep -c "palette\|drag"` = 0；旅程里无 debug 侧栏 / inject 点击）。
- **影响**：用户"能不能用工作流"这个问题**只能靠无头证据回答**；真 Electron 里从零搭一张图、
  点一下就出结果——**没验过**。
- **修法方向**：W1 / W2 已写好（palette drag helper + debug 侧栏 payload 断言），**先修 G4**
  （否则 W1/W2 建在一条会红的旅程上）。
- **规模**：W1 约 2 文件 + 150–250 行；W2 约 2 文件 + 80–150 行（都不碰产品代码）。

#### G6（P2）**宿主不知道 node-red 图的触发器** —— "它什么时候会跑"无处可查

- **证据**：`automationRunner.ts:565` 对 node-red 图只写 `armed:false, detail:"由 Node-RED 引擎管理"`；
  引擎里的 inject 定时/http-in/mcode-trigger **不登记**到宿主任何表。
- **影响**：用户在「自动化」页看不到这张图有几个触发器、下次什么时候跑、上次跑成没有
  （原生 runboard 只有内存态，**无持久运行史**——`tasks/README.md:297` 仍成立）。
- **修法方向**：读 `GET /flows` 的 tab 元数据 + `mcode-trigger` 节点参数，在事实表里**只读镜像**
  一份（不参与调度，纯展示）；运行史接到 `workflow_runs`（与旧 runner 同一张表）。
- **规模**：**2–3 文件、约 120–200 行**（读 + 映射 + 界面一行）+ 1 套 smoke。

#### G7（P2）**两套存储之间没有事务** —— Deploy 成功但库镜像 pending 是常态

- **证据**：`nativeLibrarySync.ts` 文件头自陈「Not one transaction」；`node-red-e2e-smoke` 里
  三条 `[error] ... getDb() called before initDb() resolved`（套件的预期路径）。
- **影响**：用户原生编辑器里改完部署，**Mcode 库里还是旧版本**，直到下一次重试成功。
  界面有 `deploy-reconciliation` 状态可查，但**默认路径下用户不会去看**。
- **修法方向**：**不是**"加事务"（跨存储做不到），而是**把 pending 变成可见**：
  库列表那一行打「未同步」徽标 + 一键重试（`retryPending` 已有）。
- **规模**：**1–2 文件、约 60–120 行**（渲染端一个徽标 + 调用已有 RPC）。

#### G8（P3）**W1/W2 卡与索引里的过期数字**（不影响产品，会影响下一个执行者）

- 旅程"12 步"→ **20 步**；`editor-flow.ts` 的 `clickAt` 行号 `:66-68` → **`:64-69`**。
- **修法方向**：由**工作流总控**（不是执行会话）改 `tasks/workflow/README.md` 与 W1/W2 卡面。
  本卡边界明确写了"不写卡"，此处只列出。

---

### 四、我发现的卡上写错 / 需要纠正的地方（汇总）

1. **「旅程有 12 步」→ 20 步**（§零-1）。
2. **README 第 1 条「原生画布 已达成」→ 应为「有画布、缺库内编辑入口」**（§零-2 / G2）。
3. **README 第 2 条「运行时统一 = 一个调度器 + 多个执行器」→ 整机是两套运行器**（§零-3 / §1④）。
4. **「已知基线」第 3 条「`WorkflowCanvas.tsx` 由 T45 `351e4d9b` 删除」——确认准确**（685 行）。
5. **「`node-red-e2e-smoke` 通过」——确认准确**（106/106 + vendor PASS，本轮复跑）。
6. **W1 卡「`grep -c "palette\|drag"` = 0」——确认准确**（本轮复跑，仍是 0）。
7. **W1 卡引用的 `editor-flow.ts:66-68` 行号已漂**（实际 `:64-69`）。
8. **W2 卡说 `grep -n "debug\|sidebar\|注入"` 只有第 6 行「注入」**——实际**有 4 处 `inline`/`inject` 相关**
   （`NATIVE_AGENT_TYPE`、`fixtureNativeNodes` 等），但**没有一处是 debug 侧栏**。结论对，取证口径粗。

### 五、本轮跑过的套件（逐套单跑，全部 exit 0）

| 套件 | 结果 |
|---|---|
| `node-red-e2e-smoke` | **106/106 + vendor 5.0.8 PASS** |
| `mcode-node-pack-smoke` | **393/393** |
| `t96-probe` | **54/54** |
| `flow-migration-smoke` | **249/249** |
| `node-red-deploy-reconciliation-smoke` | **75/75** |
| `executor-gate-d-smoke` | **85/85** |
| `t27-load-entry-deadlock-smoke` | **40/40** |
| `t85-workflow-migration-preflight-smoke` | **34/34** |
| `workflow-engine-selection-smoke` | **16/16** |
| `workflow-engine-runtime-smoke` | **114/114** |
| `workflow-native-load-smoke` | **18/18** |
| `workflow-view-smoke` | **763/763** |
| `workflow-extension-seams-smoke` | **12/12** |
| `workflow-reload-async-smoke` | **6/6** |
| `t3-engine-trigger-gate-smoke` | **54/54** |
| `executor-ownership-smoke` | **17/17** |
| `x-mcode-roundtrip-smoke` | **73/73** |
| `node-red-theme-smoke` | **11/11 + MUTATION PASS** |
| `arc006-registry-guard-smoke` | **43/43** |
| `execution-engine-smoke` | **63 checks PASS** |
| **`t8-node-red-u1`** | **FAIL**（`rename-node-via-tray`，两次独立复现） |

**没跑**：全量（按卡边界）、`workflow-ui-smoke`（浏览器套件，与本轮判据无关）、
`t48/t51/t54`（Agent 发现类，本轮未涉）。

### 六、未做 / 我没试过的（如实）

- **没在真 Electron 里手工确认部署到底成不成功**——G4 的"部署失败"来自 DOM 快照里的通知文本，
  **根因未查**。
- **没验安装包形态**（E3）：vendor 能否在 electron-builder 产物里启动、`extraResources` 是否完整
  ——本轮全部跑的是仓库 vendor checkout。
- **没验 AI 建图**（W3 的题）：`workflow_guide` / `node_types_list` / `workflow_save` 的能力齐全，
  但"成功建过一张图"的端到端证据**没有**（`t54` 只验工具在清单里）。
- **没验 `t8` 的 `--mutation`**：正常跑已经红，变异跑无意义。
- **没查 `baseline-deploy` 那次 `POST /flows` 为什么没收到父进程回复**（5 秒超时）——
  需要读 `run-g1.log` 之外的子进程 stderr，现有证据目录里没有。
- **`NodeRedFlowStorage` 的 CAS 有没有真的被界面用上**：本轮只确认 `nativeLibraryLoad` 把它当
  **装载日志**（`JOURNAL_PROJECT_ID = null`），**没查**还有没有别的生产调用方（`grep` 只有这一处）。
- **`projectDataDirOf`（按项目隔离）在生产路径上没人调用**：`grep` 只有 `registry.ts:815` 定义 +
  `arc006-registry-guard-smoke` 调用；生产 `ipc/index.ts` 全用 `dataDirOf`（单例目录）。
  **按项目隔离的引擎目录 = 已实现、未接线**。

### 七、给下一张卡的输入（不写卡，只给判断）

- **W1 / W2 先等 G4**：旅程红着的时候往上叠新旅程，等于"在会红的地基上盖楼"。
- **G3 比 G1 便宜一个数量级**（15–40 行 vs 80–150 行），但 G1 的**用户可见程度高得多**
  （"重启后不跑了" vs "预检说缺执行器"）。**建议先 G3（顺手）再 G1（主菜）**。
- **G2 的 (b) 方案可能是整个清单里性价比最高的**：一个节点列表 + `onSelect`，就能让已经写好的
  `NodeInspector`（含参数表单、档案套用、依赖勾选）**全部活过来**。
- **红线不需要"修"**：双跑已经防住了。需要的是**把"两套运行器"记成迁移期债务**，
  并在 W3 之前先回答：**mcode 图的哪些能力 node-red 图给不了**（这才是收敛的唯一理由）。

