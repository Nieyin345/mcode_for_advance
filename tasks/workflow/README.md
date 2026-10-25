# 工作流主线：任务卡索引

> 本目录是 **Node-RED 工作流/自动化主线** 的执行卡。编号从 `W0` 开始，与仓库根 `tasks/T*.md` 的全局编号**互不占用**。
> 维护者：工作流总控。执行：子代理（每卡独占文件边界）。

## ⚠️ 方向（2026-10-24 用户明确指示）

> **「我们的这个工作流不要之前自己写的工作流了，全面用现在的 node red，进行二开，保留我们之前的工作流的一些功能，很多功能是可以集成到现在的 node red 里面的，所以要二开」**

**这改变了本目录的终局判断**：不再是「迁移期并存」，而是**以 Node-RED 为唯一内核，
旧能力作为二开增量搬过去，然后删掉旧执行器**。

### ⛔ 2026-10-24 总控自己的重大更正：二开已经做完了，我不知道

我原先按「只有 `mcode-agent` 一个节点类型迁过去了」写 W7/W8/W12。**这个前提是错的，
而且错得比我想的更彻底 —— 不只是节点包，连迁移器都有了。**

#### 一、六个节点齐全，而且 Host 端口全部接上了

`apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts:54-68` 实测六个类型：

```
mcode-agent  mcode-conversation  mcode-branch
mcode-trigger  mcode-module-capability  mcode-node-red-call
```

全部 `registerType` 了（`:344-480`），`nodePackManifest.ts:226` 为每个类型生成 `<type>.js`。

**每个节点的 Host 端口也不是空壳**（`nodePackProductionPorts.ts`，201 行）：

| 节点 | 生产实现 | 证据 |
|---|---|---|
| `mcode-agent` / `mcode-conversation` | `runSelectedSession` | `:131-133`，两节点共用，按类型区分 |
| **`mcode-branch`** | `chooseBranch` | `:134`。`decider: "user"` → **`dialog.showMessageBox` 真弹窗等真人点选**（`:114-124`）；`decider: "model"` → **跑一轮取数字端口**，非数字/越界都抛错（`:100-107`） |
| `mcode-trigger` | `runtimeManager.subscribe` | `:195-199`，接的是 Mcode 事件流，**注释明确写「no second executor is started」** |
| `mcode-module-capability` | `getModuleHost().invoke` | `:135-143`，**要求 `projectPath` 绑定 Host 授权**，缺了直接抛 |
| `mcode-node-red-call` | 受控 `fetch` | `:145-183`，路径围栏（不许 `..` / `?` / `#`）、非 GET 只许 `POST /flows` 且**弹窗批准** |

接线点在 `registry.ts:723` `new NodePackHost(this.nodeServices ?? productionNodePackServices(...))`。

#### 二、旧图迁移器也已经有了

`apps/desktop/scripts/flow-migration-smoke/main.ts` 的文件头（`【ARC-006 Gate C 第一片】`）：

> **`WorkflowDoc → Node-RED flow 迁移器`**的无头回归网 …… **7 种 runner.kind 全映射**；
> **未知字段无损**（文档级/节点级/边级/position 的 `x-custom*` 往返后逐字节仍在）；
> **已知会丢的语义显式列出**（`needsHumanDecision` + `lossy`，不静默丢）；
> **备份逐字节等于原文**；**round-trip 已知字段完全一致**。

**所以 W13（写迁移器）已经做完了。**

#### 三、这意味着 W9–W14 里大部分是空卡

| 原计划卡 | 现在的判断 |
|---|---|
| W9 迁 `mcode-command` | **旧 `command` 没有对应 `mcode-*`** —— 但上游 `exec` 可用，问题变成「审批门和工作目录围栏怎么补」 |
| W10 迁 `mcode-conversation` | **已经迁完**（`mcode-conversation` + `runSelectedSession`） |
| W11 迁 `mcode-code` | 仍缺（上游 `function` 跑在引擎进程里，无隔离） |
| W12 `switch` 映射验证 | `condition` 用 `switch` 够（但**默认 `checkall:"true"` 会让一条消息走多个出口**，必须显式 `"false"`）；`branch` 有 `mcode-branch` |
| W13 旧图迁移器 | **已经做完**（`flow-migration-smoke`） |
| W14 删 `ExecutionEngine` 图执行路径 | **仍然有效**，但前提变成「迁移器已经在生产上接上了吗」 |

#### 四、我为什么会错，以及这条教训

我 `grep -rn "MCODE_AGENT_NODE_TYPE"` 看到命中就下了结论。
**按一个名字搜是引用数，不是出口数** —— 这句话本来就写在本 README 原来的条目里，我自己又踩了一次。

**正确的查法**：搜 `MCODE_NODE_PACK_TYPES` 这个**全集符号**，或者直接读文件头。
**所有后续卡在写之前，先按全集查一遍，不要按单个类型名。**

**现在的真问题已经不是「搬什么」，而是「这六个节点和迁移器在生产上真的被用户用到了吗」**
—— W8 正在查这个，任务已按新事实改写。

**为此新增规划卡 [W7](W7-node-red-second-dev-roadmap.md)（二开路线图）** ——
七个旧能力（`conversation` / `command` / `code` / `branch` / `condition` / `prompt` / `trigger`）
目前只迁了 `agent` 一个。

**W8 是它的决策前提**（哪些搬 / 哪些用上游 / 哪些不搬）。

## 路线图要求（`docs/planning/mcode-product-roadmap.md` §2）

> **Node-RED 工作流/自动化** —— 原生画布、运行时、存储、触发权与 Mcode Agent/Host/权限统一
> **唯一流程内核、唯一触发/存储事实源；不长期保留两套运行器或双触发**

四条拆解（验收时逐条对照）。**下表是 W0 实测后的版本**（原文写于写卡时，有两条被 W0 纠正）：

| # | 要求 | 当前判断（W0 实测） | 依据 |
|---|---|---|---|
| 1 | **原生画布** | **有画布，缺库内编辑入口**。手写 `WorkflowCanvas.tsx` 已于 T45（`351e4d9b`）删除，`grep -rn "WorkflowCanvas" apps/desktop/src/` = **0**；UI 挂的是原生 `WebContentsView` 里的原厂编辑器。**但 `setSelectedNodeId` 的 4 处写入全是初始化/清空，无一处由点击驱动** —— 用户点不到节点、看不到它的参数（缺口 G2） | W0 §1①、§G2 |
| 2 | **运行时统一** | **对「旧 runner」成立，对「整机」不成立**。调用链只有一条（`manifest.runner.kind` → `runner.ts` → `ExecutionEngine` → `nodeRedExecutor`），但**模块级 `executionEngine` 单例永远不注册 `node-red` 执行器**（装配顺序：`index.ts:46` 的 import 早于 `:86` 的端口注入），实际存在两个执行面 | W0 §2.2 探针 |
| 3 | **存储、触发权统一** | **两份存储**：SQL `workflows` 表与 `<engineDir>/flows.json`。`NodeRedFlowStorage` 只是装载日志（`JOURNAL_PROJECT_ID = null`），**不是真相源**。触发分流由 `legacyTriggerOwnerOf` 执行且 fail-closed，`t3-engine-trigger-gate-smoke` 54/54 | W0 §1③ |
| 4 | **不长期保留两套运行器/双触发** | **双跑 = 否**（四层防线全过）；**只保留一套 = 否**（两套都在，靠 owner 表互斥）。**红线满足，目标未达成**，属迁移期状态 | W0 §1④ |

**W0 纠正的三处卡面错误**（已订正，原始判断留在这里以免有人复述旧话）：

- 旅程是 **20 步**，不是 12 步；
- README 原第 1 条「原生画布已达成」→ 应为「有画布、缺库内编辑入口」；
- README 原第 2 条「运行时统一」→ 只对旧 runner 成立。

## 卡列表

| 卡 | 标题 | 状态 |
|---|---|---|
| [W0](W0-workflow-baseline-and-gaps.md) | 工作流主线基线核实与缺口清单 | ✅ **已交付**（`5c139948`，523 行回写，纠正了我三处错误） |
| [W1](W1-palette-drag-from-scratch.md) | 从 palette 拖节点：把「从零搭」变成可验收旅程 | ✅ **已交付**（`bf45f426`，6/6 步 + 5 组变异） |
| [W2](W2-run-and-see-result.md) | 在 UI 里点一下，看到执行结果 | ✅ **已交付**（`d31f065e`，3/3 步 + 3 组变异） |
| [W3](W3-node-select-wiring.md) | 画布删了，但「点节点看参数」没接上 | ✅ **已交付**（`workflow-node-select-smoke` 13/13，变异预期 6 红实测 6 红；真 CDP 鼠标） |
| [W4](W4-executor-registry-order.md) | 自动化预检说「缺执行器」，而流其实能跑 | ✅ **已交付**（17/17，变异预期 6 红实测 6 红 + 反向变异 3 红；tsc 干净） |
| [W5](W5-baseline-deploy-assertion.md) | `baseline-deploy` 测的不是部署 | ✅ **已交付**（三层信号探针；**发现部署失败的真因是旅程自己停在死端口**，不是产品缺陷） |
| [W6](W6-trust-notice.md) | 发布了的工作流重启后不跑，而没人告诉用户 | 排队 |

**⚠️ 独占文件表（派活前先对一遍）：**

| 卡 | 独占写入 |
|---|---|
| W3 | `WorkflowLibraryView.tsx`、`NodeInspector.tsx`、`workflow-view-smoke/main.ts`、`workflow-node-select-smoke/` |
| W4 | `executionEngine.ts`、`workflow-executor-registry-order-smoke/` |
| W15 | `WorkflowsPanel.tsx`、`EngineRuntimePanel.tsx`、i18n `settings.ts`（只追加）、`workflow-engine-view-owner-smoke/` |
| W6 | `EngineRuntimePanel.tsx` ← **与 W15 冲突，必须等 W15 交付后再派** |
| [W7](W7-node-red-second-dev-roadmap.md) | **二开路线图**（用户方向） | 规划卡（总控用） |
| [W8](W8-migration-decisions.md) | **七个旧能力：搬 / 用上游 / 不搬** | 已派，进行中 |
| [W15](W15-default-to-canvas.md) | **打开「工作流」默认就是画布** + 同一 docId 两个宿主互关 | ✅ **已交付+验收**（新套件 50/50；5 次变异两方向；我改了一条过期断言并复验 50/50 + tsc） |
| [W12](W12-switch-vs-branch-decision.md) | **`switch` 能不能代替 `branch`** —— 总控预判（**不派**） | 预判卡，等 W8 对照 |
| [W16](W16-real-inventory.md) | **真实盘点：用户到底能做到什么**（总控亲自核） | 盘点卡，不派 —— **先读这张** |
| [W17](W17-condition-bridge.md) | **`condition` 迁移后永远走 else**：`msg.mcode.condition` 无生产者 | ✅ **已交付+验收**（47/47；六变异全对；我探针确认迁移产物真插了求值节点） |
| [W18](W18-conversation-session.md) | **迁移图跑不了**：`mcode-conversation` 要 `sessionId`，迁移器不写 | 排队（**等 W17 释放 `flowMigration.ts`**） |
| [W19](W19-production-ports-smoke.md) | **393 条验的是桩**：六个节点的生产实现零覆盖 | ✅ **已交付**（170/170，三个变异精确对上；**产品代码零改动**，判据全走公开入口） |
| [W20](W20-dead-code.md) | 画布删了，`WorkflowNodeCard` 等死代码还在骗人 | 排队（**等 W3 / W15 都落定**，都要碰 `WorkflowLibraryView.tsx`） |
| [W21](W21-agent-capability.md) | `capability: "read"` 在 Node-RED 路径上不生效 | ✅ **已交付+验收**（46/46；变异 A 精确 13、C 证明「验闸门不是传参」；我复跑 PASS） |
| [W22](W22-run-wrapper-false-pass.md) | **`run.mjs` 把构建失败读成 PASS** | ✅ **已交付+验收**（我独立复现：同一份坏代码旧包装器 `0`+`PASS`、新的 `4`+`BUILD FAILED`） |
| [W23](W23-reopen-view-after-load.md) | U1 旅程装载后没重开视图，停在死端口测部署 | 排队（**等 W17 交付**，它现在正在途） |
| [W24](W24-other-suites-false-pass.md) | 另外 7 套同样的假门禁（`o2` 已修，可作参考） | 排队 |
| [W25](W25-trigger-payload.md) | `{{trigger.*}}` 迁过去会显式失败（`wf_auto_download` 就是它） | 排队 |

### W5 推翻了我一个重要假设（记下来）

我原以为「部署失败：服务器没有响应」可能是**产品缺陷**。W5 查清了：

**是旅程自己的问题。** `production-load-entry` 调 `loadWorkflowIntoNative`，
它会**停旧引擎、换端口重启**（实测 `9029 → stopped → 8477`）；而旅程没有生产渲染端
`EngineRuntimePanel` 那层「`status.editorUrl` 变了就重新 open」的 effect，
编辑器页停在死端口 → `POST flows` 拿到 `status 0 / responseText ""` →
上游 `deploy.js:684` 走 `deploy.errors.noResponse` → 正是那句通知。

**所以产品是对的，是「测试环境的模拟不完整」。** 断言改成「如实红」是对的，
但旅程要不要在装载后重新打开视图，是另一张卡（W5 建议开）。

**这条的教训**：我把「测试里看到的失败」当成了「产品失败」。
**证据是「一条通知」，而通知的来源有三层可能（网络/事件/DOM），我只看了最外层。**

### 独占文件串行表（**派活前先对一遍**）

| 卡 | 独占写入 | 与谁冲突 |
|---|---|---|
| **W3** | `WorkflowLibraryView.tsx`、`NodeInspector.tsx`、`workflow-view-smoke/main.ts` | W18（若 W18 需要改 NodeInspector） |
| **W4** | `executionEngine.ts` | — |
| **W15** | `WorkflowsPanel.tsx`、`EngineRuntimePanel.tsx`、i18n `settings.ts`（只追加） | W6 |
| **W5** | `t8-node-red-u1/` | W6（若 W6 加 U1 断言） |
| **W17** | `flowMigration.ts`、`mcodeNodeTypes.ts`、`nodePackProductionPorts.ts` | **W18 / W19** |
| **W18** | 同上 + `resources/presets/workflows.json` | **W17 / W19** |
| **W19** | `nodePackProductionPorts.ts` + 新建套件 | W17/W18（**已在派活时约定：W19 只抽函数不改行为，若冲突只改套件目录**） |

**W17 → W18 必须串行**（都改 `flowMigration.ts` 与 `mcodeNodeTypes.ts`）。W19 与它们并行，边界已约定。

### 这次「默认落在画布」到底改成了什么（用户能看见的）

| | 之前 | 现在 |
|---|---|---|
| 打开 设置 → 工作流 | 落在**工作流库列表** | 落在 **Node-RED 原厂画布** |
| 打开 设置 → 自动化 | 落在库 | **保持库**（W15 判断：自动化那页回答的是「我有哪些自动化」，引擎页不是它的下一步） |
| 从技能/插件页点「节点」反查进来 | 落在库并选中那份 | **仍然落在库并选中**（反查优先） |
| 有流停靠在右侧面板时，打开设置 | **一块空白**（没人画也不说为什么） | 「编辑器已在右侧」+ 一个把它收回来的按钮 |
| 关掉设置页 | 可能把右侧正在显示的画布**一起销毁** | 只有**最后一个持有者**才关；没登记过的调用方永远不能关别人的视图 |

**最后两行是 G7/G8**，W15 修的就是它们。

### 两张 P0 缺陷卡的共同点（值得记）

**W17 与 W18 是同一个形状**：

| | W17 `condition` | W18 `conversation` |
|---|---|---|
| 现象 | 迁移后的条件图**永远走 else** | 迁移后的对话图**执行时报错** |
| 根因 | `msg.mcode.condition` **没有生产者** | `params.sessionId` **迁移器不写** |
| 为什么没人发现 | `switch` 本身行为正确，套件只验了规则形状 | 节点外壳能跑，套件用的是假 port |
| 共同点 | **「谁该提供这个值」这一环根本不存在，而所有断言都在验「消费端」** | |

**这比「功能没做」难发现得多** —— 因为消费端的代码是对的、套件是绿的、报错的地方离原因很远。


> **W9–W14 编号留给 W7 路线图里的实现卡**（迁 `mcode-command` / `mcode-conversation` / `mcode-code` /
> `switch` 映射验证 / 旧图迁移器 / 删旧执行器）。**W15 是插进来的产品缺陷卡，不占那条序列** ——
> 它来自 UI 总控转交的 T136，用户原话「默认就是 node-red 的编辑页面，不要之前自己写的编辑页面了」。
>
> **W12 现在还不是任务卡**。我读了两边源码，发现「`branch`/`condition` → `switch`，够」这个初判
> **半对半错**：`condition` 真够；**`branch` 不够**（`switch` 没有「停下来等真人点选」和
> 「让模型按判据挑」两种形态，而且默认 `checkall:"true"` 会让一条消息走多个出口）。
> **W8 回来先用它对照**，再决定 W12 是「验证映射」还是「补一个 `mcode-branch`」。

### W0 交付的缺口清单（后续卡的来源）

| 序号 | 缺口 | 严重度 | 对应卡 |
|---|---|---|---|
| **G1** | 从 palette 拖节点一次没验过（`grep palette\|drag` = 0） | 高 | W1 |
| **G2** | **点不到节点、看不到参数**（`setSelectedNodeId` 无点击驱动） | **高（用户每天撞）** | W3 |
| **G3** | **模块单例永不注册 node-red 执行器** → 预检假失败 | **中高（假失败，指向错方向）** | W4 |
| G4 | T8 U1 现在红在 `rename-node-via-tray`（通知遮挡），且 `baseline-deploy` 只断言文件里有节点名 —— **测别人职责**。另：截图里「部署失败：服务器没有响应」是真的，但没人查根因 | **中高** | **W5**（部署断言）+ W6（待写：`rename-node-via-tray` 的通知遮挡） |
| G5 | `engine-trust.json` **无生产 writer** → 发布的 flow 重启后不自动执行，inject 定时/http-in 全 404 | **高（功能实际不可用）** | 待写 |
| G6 | `projectDataDirOf`（按项目隔离）**已实现、没人调用** —— 所有项目共用一份 `flows.json`，多项目会串数据。实现质量高（非法 id 抛错、不回退成默认目录），只是没接线 | 中（单项目用户不受影响） | 待写（**W15 不做**） |
| **G9** | **生产端口从不 `bindSession`**（`nodePackProductionPorts.ts` 文件头称有意 fail-closed）。会话基本都已被 `sessionStart.ts` / `claude.ts:312` 绑过，所以是窄路；未绑时报 "session busy"，**不静默** | 低（不是安全洞，但「为什么可以不 bind」需要有人知道） | 记录即可（W21 报） |
| **G10** | **每次 `setPermissionMode` 会清掉该会话的「始终允许」**（`ApprovalBridge` 的设计）。方向安全（更保守），但用户会觉得「刚点过的始终允许又忘了」 | 低（产品体验，不是缺陷） | 记录即可（W21 报）。改之前要论证「保留 always-allow 是否安全」 |
| **G11** | **迁移损失报告用户看不到**：`flowMigration.ts` 产出 `lossy` / `needsHumanDecision`（标点哪些语义没搬过去），但 `grep -rn "lossy\|needsHumanDecision" apps/desktop/src/renderer/` **只有一行无关注释**（`RuntimePolicyPanel.tsx:11` 的 `lossy debounce`）。**迁移报告写得很细，而用户读不到** | **中高** —— 这正是「写下来了没人读」 | **W25**（至少 `{{trigger.*}}` 那条） |
| **G7** | **同一 `docId` 有两个 `EngineRuntimePanel` 宿主**（设置页 `WorkflowsPanel.tsx:263` 与右侧停靠位 `RightPanel.tsx:360`），各自的卸载 effect 无条件 `close(docId)` → **一个把另一个正在显示的视图销毁**，后者下次 `bounds`/`sync` 拿到「文档视图不存在或已关闭」。**这很可能就是截图里那个报错的真因**（不是 T136 猜的 remount —— 页签只换 `hidden` 类，从不卸载） | **高** | **W15 第二节** |
| **G8** | 有流停靠在右侧时 `flowDocked` 恒真（`WorkflowsPanel.tsx:91` 只看 `placements` 有没有 flow，**不看右侧面板是否真的打开**）→ 设置页那个实例 `active` 永远 false、effect 早退，但占位 div 照常渲染 → **一块什么都不画的空白区，连错误都没有** | 中高（用户以为是卡死） | **W15 第三节** |

### 队列里还没写的

> **⚠️ 这张表 2026-10-24 订正过。** 旧版把 W3 写成「Agent 建图有没有证据」、W4 写成
> 「两条触发路径」——那是**写索引时的草稿判断，从未成为这两张卡的内容**。实际派出的是
> 下表的题目。留这段是为了说明「索引里的描述也会过期」，别反过来按旧描述去验收。

| 下一张 | 要解决什么 | 为什么还没写 |
|---|---|---|
| **W9–W14** | **二开实现卡**：迁 `mcode-command` / `mcode-conversation` / `mcode-code`、`branch`+`condition` → `switch` 映射验证、旧图迁移器、删 `ExecutionEngine` 图执行路径 | **全部等 W8 的决策表**。W8 说「用上游」的不写卡，说「要搬」的才写 |
| **W16**（待写） | `rename-node-via-tray` 的通知遮挡（G4 后半） | 需要真 Electron U1 边界，且 W5 正要改同一套件 |
| **W17**（待写） | `projectDataDirOf` 接线（G6，多项目隔离） | 单项目用户不受影响，排在用户可见的缺口之后 |
| **W18**（待写） | `workflow.approve` 授权入口（G5 的后半）—— **W6 只做「告诉用户」，写信任标记是另一张卡** | 这是授权设计问题（谁批准、批准什么、怎么撤销），要先有方案 |


## 已完成（不在本目录）

历史卡在 `tasks/`：T2（部署对账）、T3（触发 owner 守卫）、T4（跨进程 CAS）、T8（Node-RED U1）、
T10（许可集成）、T13/T19（vendor 集成地图）、T45（删手写画布）、T48/T51/T54（Agent 发现与 guide）、
T81（四步链路）、T84（journey 陈旧断言）、T89（fixup 崩溃）、T95（产品可用性核查）。

**本目录只放从今天起的增量工作**，不复述历史。

---

## ⚠️ 用户当面指出的验收缺口（2026-10-25）

> **「工作流都在验证什么呀，集成到设置页面了吗，现在的测试我看还是独立的页面」**

### 我核实后的答案：代码集成了，但**没有一条真 Electron 旅程证明用户点得到**

`WorkflowsPanel` 确实挂在 `SettingsPage.tsx:437-438`。**但验证它的证据分三层，只有最外层是真的：**

| 层 | 套件 | 跑的是什么 | 能证明「用户点得到」吗 |
|---|---|---|---|
| **SSR** | `workflow-engine-view-owner-smoke`（W15）、`workflow-view-smoke` | `react-dom/server` 渲成 HTML 字符串 | ❌ **effect 完全不跑** |
| **真浏览器 + 真组件** | `workflow-ui-smoke` | 起 Chromium，`render(<SettingsPage />)` —— **真组件、假外壳** | ⚠️ 半个 |
| **真 Electron + 真 App** | `t8-node-red-u1` | 打包真 `App.tsx` | ⚠️ **但它不走设置页** |

**`t8` 的三条旅程用的是 `harness.openEngineEditor()`（`harness.ts:240`）——
直接在宿主层 `host.open()` 开一个 `WebContentsView`，从来没经过设置页。**

**所以「引擎能起、画布能拖能连能部署」证明了，而「用户从设置页进得去」没证明。**

### 尤其是这一条

`EngineRuntimePanel` 的核心是 `api.documentView.open(...)` ——
**SSR 里连 `api` 都不存在**（`prelude.ts` 装的是桩），**effect 一行都不跑**。

**所以 W15 那条「默认落在画布」的断言，证明的是「组件初始状态对」，
不是「用户点进去看到画布」。**

### 对应卡：**W26**

要求走真 Electron + 真点击：开设置 → 点工作流 → 确认默认在画布页签 →
**确认 `documentView` 里那个视图真的存在且可见**（不是 DOM 里有个 div，
那个 div 是占位，原生视图不在 DOM 里）→ 确认编辑器 URL 端口 == 引擎端口。

**核心变异**：注释掉 `EngineRuntimePanel` 的 `open` 那一步 → 第 5 步必须红。
**它证明的是「视图真的开了」，不是「组件渲染了」。**

## 2026-10-25：产品面「只有一套工作流」与首屏性能修复（阶段交付）

- **统一产品入口**：SettingsPage 只展示一个「工作流」导航项。工作流与自动化是同一 WorkflowLibraryView 的两个筛选分类，而非两个设置页、两套编辑器。旧 `settingsSection=automation` 深链保留并直接落到统一库的自动化分类；其他来源跳入特定工作流后消耗一次性 focus 不会把用户弹回画布。
- **唯一画布**：默认进入原生 Node-RED 画布；页签从「第三方引擎」更名为「工作流画布」/「Workflow canvas」。既有 EngineRuntimePanel + shared documentView docId 保留，复用原生 WebContentsView 与安全的凭据绑定，不新增自研画布或第二个 Electron 视图。
- **启动与切页成本**：从默认画布进入不再挂载隐藏的 WorkflowLibraryView/NodeTypesView/AgentProfilesView，也不会先读取 workflow.list/nodeTypes/agentProfiles；三个较重 UI 模块用 React.lazy 按首次使用拆分，切页后保留已挂载树与草稿，避免重新解析/重建。引擎列表仍照常读取以驱动画布。
- **实证**：真实 Chromium SettingsPage 浏览器旅程核对单导航、初始画布、初始 RPC 数量、第一次访问库后的查询、工作流/自动化分类切换与草稿保留、旧深链和焦点行为；故意把 nodeTypes RPC 重新设为无条件读取后 workflow-ui-smoke EXIT=1，恢复后 PASS。7 套设置与工作流回归通过，Desktop/Contracts tsc --noEmit 通过。具体日志按最终提交回写。
- **架构上尚未完成**：本次是 UI/首屏资源加载合一，后台历史 ExecutionEngine 仍受 owner 互斥保护存在，SQL WorkflowDoc 与 Node-RED flows.json 尚需完成统一存储/迁移验收；不得将导航合并冒充后台已删除第二执行器。真实 Electron U1 仍需检查视图复用与内存/CPU（RSS、startup latency、可见/隐藏切页耗时），不从减少 IPC 数量推测已下降多少 MB。并行 W26 Electron 设置旅程文件未触碰。

### 2026-10-25 二次补强：首帧与切页缓存实证
- 三个重型界面模块（WorkflowLibraryView / NodeTypesView / AgentProfilesView）通过 React.lazy+Suspense 首次访问才下载，初始 Node-RED canvas 不提前加载隐藏 JS 和业务 DOM。
- 已访问 catalog/profiles 的 enabled 标志保持为 true，返回 canvas 再回库不触发 useRpc false→true 的重复 IPC 查询；显式刷新与保存后 refetch 仍有效。
- workflow-ui-smoke Chromium 浏览器使用真实 SettingsPage 和计数 API 桩，证实首帧 workflow.list/nodeTypes/agentProfiles 都为 0，首次访问库各 1 次、离开后回来仍保持各 1 次。恢复无条件首帧 nodeTypes 会红；恢复按 view 切换 enabled 会红。变异均已恢复。
- focusWorkflowId 是一次性意图：库消费并清空后不能退回画布；新增浏览器断言。旧 automation 深链首帧直接进入同一工作流库的自动化分类，无中间引擎画布闪现。
- 量化 RSS / CPU / Electron startup / 可见视图数仍需要后续真实进程 U1；不宣称目前已经证明内存下降具体数值。

### 2026-10-25 最终代码提交与回归
- 源码及 Chromium 验收提交：`275122b8`（9 文件，213 insertions / 97 deletions），精准提交，没有包含并行 UI/Office/资料库对话的修改。
- `node apps/desktop/scripts/run-smokes.mjs workflow-engine-view-owner-smoke workflow-view-smoke workflow-ui-smoke settings-lazy-smoke renderer-pure-smoke scene-deploy-view-smoke settings-tokens-smoke`：7 PASS / 0 FAIL；日志 `apps/desktop/.tmp/smoke-runs/1792913805336-7872-w6oNaU/`。
- Desktop、Contracts `tsc --noEmit` EXIT=0，定向 `git diff --check` EXIT=0。两组真实性变异（首帧无条件 catalog 查询、切页时反复 enabled 切换）均令 workflow-ui-smoke FAIL，恢复后 PASS。
- 保留未验：真 Electron 应用的冷启动到可交互画布耗时、Node-RED/Electron 子进程 RSS、编辑器可见/隐藏切换耗时、旧执行器彻底下线与库/flows 单一真相源。未测值不得标为已改善的量化成果。

## 2026-10-25 单一 Node-RED 运行时重入/热复用性能修复（后端+编辑器）

- **根因**：`loadWorkflowIntoNative` 即使工作流库文件、磁盘 `flows.json` 与按 docId 的装载 journal 完全相同、Node-RED 仍 running，也继续走确认、`runtime.stop()`、写盘、`runtime.start()`；`WorkflowNativeEditorEntry` 每次成功均发 `mcode:native-canvas-loaded`，`WorkflowsPanel` 强制增加 nativeCanvasEpoch，导致原生 WebContentsView 宿主不必要重建/重载。`WORKFLOW_ENGINE_START` IPC 对 running 引擎每次仍做 `launchSpec()`，包括 bootstrap/节点包/令牌磁盘操作。
- **修复**：先执行既有 REJECT/UNREADABLE 迁移预检，再比对当前磁盘原生图、迁移后的库图和按 docId 记录的上次装载图；三份 JSON 语义相同、journal 完整且引擎 `running` 时返回 `{ok:true, unchanged:true}`，无 journal 写入、无 stop/start/备份/部署、无副作用。变更文档、外部原生 Deploy、损坏 journal、引擎 stopped/failed、迁移拒绝一律保留原确认/回滚安全路径。
- **前端贯通**：`WorkflowEngineLoadResult` 增添可选 `unchanged`；`WorkflowNativeEditorEntry` 仅在真正替换画布时广播 native-canvas-loaded，并把 reloaded 传给 `WorkflowsPanel`；无变化只切到已有 Node-RED 画布，不增加 `nativeCanvasEpoch`，继续保持同一 WebContentsView 和节点选中状态。IPC `onStart` 在宿主权威状态已经 running 时直接返回状态，不重读 launch spec，不新增子进程；starting 仍走既有单飞。
- **实证**：`workflow-native-load-smoke` 在隔离目录/假引擎计数 start/stop 和磁盘画布，证明 A/B 相同文档重入不启停，不改 journal/画布；文档修改、真实 flows.json 外部编辑、failed 引擎的同图重入不得绕过确认。`workflow-ui-smoke` 真 Chromium 模拟 `{ok:true,unchanged:true}`，证实不广播重新载入事件。`workflow-engine-runtime-smoke` 记录 launchSpec 调用和子进程 spawn 数，证明重复 Start 各仅一次。
- **变异负控**：关闭原生同图复用使 workflow-native-load-smoke EXIT=1；删除 running Start 快速返回使 workflow-engine-runtime-smoke EXIT=1；强制广播即使 unchanged 也重载使 workflow-ui-smoke EXIT=1；三个变异全部原位恢复。
- **最终回归**：`node apps/desktop/scripts/run-smokes.mjs workflow-native-load-smoke workflow-engine-runtime-smoke workflow-ui-smoke workflow-view-smoke workflow-engine-view-owner-smoke node-red-deploy-reconciliation-smoke flow-migration-smoke` 7/7 PASS，日志 `apps/desktop/.tmp/smoke-runs/1792917524876-1796-pYTKLI/`；Desktop + Contracts `tsc --noEmit` EXIT=0，定向 `git diff --check` EXIT=0。
- **仍开放**：未做真 Electron 的 RSS/CPU/冷启动延迟量化，未将 SQL 与 flows.json 收敛为唯一写入事实源，旧 ExecutionEngine 尚受 owner 排他保护，不能宣告后台彻底只剩一个执行器。没有修改/清理任何实际用户 flows.json、并行工作区。
