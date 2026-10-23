# T8｜Node-RED 原生画布真实 Electron U1 验收

- Status: done（2026-10-23 核查：四项验证全 PASS，真 Node-RED；提交 (见回写)）
- Category: bug
- Priority: P1
- Depends on: T2, T3, T4 stable; must run serially and exclusively with T7
- Exclusive writable files: acceptance scripts/reports only; product fixes need separate bounded cards.
## Required Skills
  - `mcode-smoke`: distinguish isolated E1 from real Electron U1.
  - `code-review`: keep defects and acceptance evidence separate.
- Read before work: `CLAUDE.md`, `audit-ledgers/README.md`, archived T77/T93/T94/T97 and current dependency results.
- Acceptance: real Electron verifies load/edit/deploy/reopen, Library reconciliation, trigger single ownership, and failure recovery. No fake renderer or component-only test counts as U1.
- Execute: acquire exclusive Electron slot only after dependencies are accepted.
- Result writeback: step-by-step PASS/FAIL/BLOCKED evidence, commit/build SHA, remaining defects in separate cards.

## 结果回写（2026-10-23）

### 0. 一句话结论

**四项验证全部 PASS**（加载 / 编辑 / Deploy / 重开），**三项额外验证也全部 PASS**
（T2 对账 / T3 触发归属 / T4 跨进程 owner）。旅程跑在**真 Electron 44.4.5 + 真
Node-RED 5.0.8**（仓库 `node-red/` vendor checkout）上，重开是**真 OS 进程**
（两代 PID）。命令：

```bash
cd apps/desktop
node scripts/t8-node-red-u1/run.mjs              # 正常跑，期望 run.mjs 退出码 0
node scripts/t8-node-red-u1/run.mjs --mutation   # 变异跑，期望 0（故意失败由红变绿）
bash scripts/t8-node-red-u1/negative-control.sh  # 负控，期望 PASS
```

> 直接调 `electron-u1/build.mjs` 的正常跑退出码是 **1**（注册表里有 `expect:"fail"`
> 的骨架自检旅程，T16 三档语义），`run.mjs` 把它翻译成 PASS；负控/变异各自核对目标码。

**提交**：`d58a0b1e`（`d58a0b1ee67d6514b6bd34b553b2a0fc50d586bf`）。提交后在同一提交
状态复跑：正式旅程 20/20 PASS、2 代 PID（`20640 → 36740`）。

### 1. 环境与构建

| 项 | 值 |
|---|---|
| 仓库 HEAD（提交前） | `77fdd012` |
| 实现提交 | `d58a0b1e` |
| Electron | 44.4.5（仓库已装，零新依赖，内嵌 Node 24） |
| Node-RED | **5.0.8 vendor**：`node-red/` checkout，`git -C node-red log -1` = `935b8d3`（= tag 5.0.8）；经生产 `resolveNodeRedPackage` 解析（探针把 `resourcesPath` 指向含 junction 的临时 resources 根），**不手拼 NODE_PATH** |
| 装配 | 生产 `ProductionWorkflowEngineRegistry` / `DocumentViewHost` 单例 / `DocumentViewCredentialBroker` / `loadWorkflowIntoNative` / `automationRunner` / `FileExecutorOwnershipStore` |
| 构建期替换 | 仅 `@main/window.js`→`window-holder.ts`（避开语音原生模块）、GenOffice vendor→仓库自带 fail-closed stub（本卡判据不涉及 GenOffice） |
| 数据根 | 启动器 mktemp；`MCODE_SMOKE_DATA_ROOT` 式隔离（真 `mcode.db` 副本，不碰用户数据） |
| 提交后复跑证据 | `.tmp/electron-u1/2026-10-23T05-19-51-115Z/` |

### 2. 四项验证（正式旅程 `node-red-canvas-load-edit-deploy-reopen`，20 步）

| # | 判据 | 结论 | 证据（步骤名 / 观测） |
|---|---|---|---|
| 1 | **加载** | **PASS** | `engine-running`（引擎 `running`，真端口）→ `canvas-editor-ready`（编辑器 5.0.8 就绪；关掉首次启动的**更新通知同意框**与**欢迎导览**——它们真的挡住画布输入）→ `canvas-import-fixture`（编辑器自己的「导入」对话框：真点 textarea + 真 `Ctrl+V`，粘贴 1741 字符）→ `canvas-renders-fixture`：**真实画布**上 tab `T8 Node-RED 夹具自动化` + 3 节点（`inject`=入口 / `mcode-agent`=检查 README / `mcode-agent`=汇总）。截图 `shots/canvas-loaded.png` |
| 2 | **编辑** | **PASS** | `rename-node-via-tray`：节点编辑托盘（`RED.editor.edit`，即双击处理器）打开 → 真点名称框（焦点 `node-input-name`，输入框完整在视口内）→ `Ctrl+A` → `insertText` → 真点「完成」；`typedValue=committedValue=T8-已改名-DEPLOYED`；`canvas-label-shows-rename` PASS。截图 `shots/canvas-edited.png` |
| 3 | **Deploy** | **PASS** | `baseline-deploy`（先部署一次，磁盘成为**改名之前**的版本，节点名仍 `检查 README`）→ `deploy-wrote-native-flows`：真点部署按钮；**字节对比** `before=ea83375e…` → `after=5c694445…`；新字节里节点 `name=T8-已改名-DEPLOYED`、`instruction` 原样 |
| 4 | **重开** | **PASS** | `relaunch-after-deploy` → 新 OS 进程（PID `20640 → 36740`）；`reopen-canvas-shows-rename`（画布 labels 含新名字）+ `reopen-dom-label` + `reopen-flows-bytes-unchanged`（`flows.json` sha `5c694445…` 与 Deploy 后**逐字节一致**）+ `reopen-ownership-and-ledger`。截图 `shots/canvas-reopened-final.png` |

### 3. 三项额外验证（T2/T3/T4）

| # | 判据 | 结论 | 观测 |
|---|---|---|---|
| 5 | **库镜像对账**（T2） | **PASS** | `library-mirror-reconciliation`：`deploy-reconciliation.json` = `{pending:[], applied:{}}`、`lastError` 无、`libraryMirrorState().pending=0`；SQL 文档每步标题保持原值（未被镜像改写）；owner 只有 node-red。**如实说明**：本夹具经编辑器「导入」进入画布，而导入会剥掉 `x-mcode`（见 §5 缺陷 2），载荷里**没有** Mcode 自有 tab → 账本必须为空（断言的就是「不伪造 pending」）。带 `x-mcode` 的镜像路径由 T2 的 E1 套件（75/75）覆盖，本卡不重复造数据。 |
| 6 | **触发器单一归属**（T3） | **PASS** | `trigger-single-ownership`：启动生产旧 `automationRunner` 后，本图的 manual 触发器事实为 `armed:false`、`detail="由 Node-RED 引擎管理：旧自动化执行器不安装 cron / 文件监听 / 事件订阅（触发在引擎侧）"`；owner 账本里**没有任何 `mcode` 记录** |
| 7 | **跨进程 owner**（T4） | **PASS** | `cross-process-owner-cas`：引擎运行中另起**真 OS 子进程**（electron-as-node）跑生产 `FileExecutorOwnershipStore`。结果 `{"sameFlowClaim":false,"freshClaim":true,"freshReleased":true}`：抢引擎已持有的 flowId **被拒**；抢新 id 成功并自行释放；父进程复核盘上无残留 `t8-fresh-*`。证据 `cross-process-owner.json` |

### 4. 断言真的在判（负控 + 变异）

- **负控（实做）**：`T8_U1_NEGATIVE_CONTROL=1` 把 Deploy 后「节点名应等于 X」的期望
  换成画布/磁盘都不可能的哨兵名（改名仍写成 `T8-已改名-DEPLOYED`）。结果：
  `deploy-wrote-native-flows` **变红**（`before=a2d2e1f3…`、`after=a4297747…` 字节确实变了、
  磁盘名 `T8-已改名-DEPLOYED`、期望 `T8-负控-不存在的名字`），`run.mjs` 退出码 2，
  `negative-control.sh` 核对**红的步骤正是这一条**后判 PASS。证据：
  `.tmp/electron-u1/2026-10-23T05-18-27-434Z/`。脚本不改源码，无需还原。
- **变异跑**：`--mutation` 把 driver 的 `assertionStatus` 换成无条件 PASS。结果：
  正式旅程仍全绿、故意失败旅程 `literal` 由 **FAIL 翻成 PASS**、T16 自检
  「变异验证成立」，退出码 0。证据：`.tmp/electron-u1/2026-10-23T05-16-…`（末次
  `05-16-55` 那批）。
- **骨架回归**：`bash scripts/electron-u1/run.sh` → **31/31**（T16 未被改坏）。

### 5. 发现的缺陷（均**不在本卡修**，单开卡；本卡只交付验收脚本）

1. **【P0，产品缺陷】生产 T59 装载入口 `loadWorkflowIntoNative` 拒绝一切可保存的
   Node-RED 图。** 迁移器对 `mcode.trigger` 必报 lossy、对 `mcode.main`/`mcode.conversation`
   必报 needs-human-decision、对 `mcode.agent` 必报产出契约 lossy；而 `saveWorkflow`
   的闸门又要求自动化必须有 `mcode.trigger`、普通图必须有 `mcode.main`。两者叠加 ⇒
   **没有任何库文档能通过「库 → 原生画布」的装载入口**。旅程把这条作为事实证据
   （`production-load-entry` = `known-lossy-refusal`），画布放入改用用户真实可用的
   编辑器 Import 手势。建议修复方向：装载入口对「Mcode 自有语义 + 已知损失」要求人工
   确认而不是拒绝（与 `confirmReplace` 合并成一次确认），或给迁移器补无损映射。
2. **【P0，架构缺陷】经编辑器「导入」进入画布的图会**丢失全部 `x-mcode` 身份**。**
   上游 Node-RED 5.0.8 的 `RED.nodes.createCompleteNodeSet` → `convertNode`/
   `convertWorkspace` 只导出 `_def.defaults` 里声明的键；Mcode 节点包（`mcode-agent` 等）
   没有在 `defaults` 声明 `x-mcode`，tab 的 `x-mcode` 也没被导出。落盘后 `tab` 无
   `docId`，引擎按 `@node-red-native:<tabId>` 认领，Deploy 后的库镜像对账**无对象可镜像**
   （T2 账本如实为空）。这意味着「用户在原生编辑器里手工导入 Mcode 图」这条路径
   **结构性不可用**。建议修复方向：节点包 `defaults` 声明 `x-mcode`（并把 tab 元数据
   改挂在能被导出的字段上），或在导入前由 Host 侧注入。
3. **【P2，UX/诊断】首次打开编辑器会被两层模态挡住**（更新通知同意框
   `red-ui-shade` z-index 2000、欢迎导览 `red-ui-tourGuide-shade`），真用户不点掉就
   无法操作画布。这是上游行为，本卡只如实记录（旅程按真手势处理并留证）。
4. **【P2，诊断】引擎侧「库镜像状态」的可读性与本轮一致**：本夹具下
   `libraryMirrorState().report` 是空报告（无对象可镜像），不是错误 —— 与缺陷 2 同源。

### 6. 交付物与文件边界

新增（独占目录，**未改产品源码、未改 `workflowEngines/`、`orchestration/`、
`document/`、`renderer/`**）：

```
apps/desktop/scripts/t8-node-red-u1/
  harness.ts                 生产注册表/宿主/broker/装载入口/automationRunner 装配
  editor-flow.ts             Node-RED 页真手势（导入/切页签/托盘改名/部署/关模态）
  fixtures.ts                engine=node-red 的 SQL 夹具 + 迁移器产物
  window-holder.ts           @main/window.js 替身（同 T7）
  main-esbuild.mjs           构建期 alias（window / GenOffice stub）+ external
  prebuild.mjs               生产 documentViewPreload + 跨进程 child-owner 产物
  child-owner.ts             真 OS 子进程入口（生产 FileExecutorOwnershipStore）
  journeys/index.ts          注册表（惰性 require，透出 expect/failBecause）
  journeys/node-red-canvas-load-edit-deploy-reopen.ts   正式旅程（20 步）
  journeys/node-red-deliberate-failure.ts               骨架自检/变异翻转点
  run.mjs / negative-control.sh / README.md
```

T16 骨架（`scripts/electron-u1/`）**一行未改**；其 31/31 回归通过。

### 7. 复现命令与证据路径

```bash
cd apps/desktop
node scripts/t8-node-red-u1/run.mjs                # 正式旅程（约 1–2 分钟）
node scripts/t8-node-red-u1/run.mjs --mutation     # 变异跑
bash scripts/t8-node-red-u1/negative-control.sh    # 负控
bash scripts/electron-u1/run.sh                    # T16 骨架回归（31/31）
```

- **提交后复跑（本次回写引用的主证据）**：`.tmp/electron-u1/2026-10-23T05-19-51-115Z/`
  （`journey-result.json`、`suite-summary.json`、`run-g1.log` / `run-g2.log`、`shots/`、`dom/`、
  `engine-state.json`、`cross-process-owner.json`）
- 负控：`.tmp/electron-u1/2026-10-23T05-18-27-434Z/`
- 变异：`.tmp/electron-u1/2026-10-23T05-16-11-426Z/`（suite-summary 的 `mutation` =
  `unconditional-pass`、counts all-pass=2、expected-failure=0；`node-red-deliberate-failure`
  literal 由 FAIL 翻成 PASS）
- T16 回归：`.tmp/electron-u1/2026-10-23T05-17-29-355Z/`（正常）与 `…05-17-49-251Z/`（变异）

### 8. 明确未做 / 不宣称

- **不宣称 ARC-006 完成**；本卡只交付 U1 验收证据。
- 不是安装包形态（跑的是本仓构建产物 + 真 vendor 源码树 + 生产 preload 源码）。
- 画布「双击」用手势边界代替：`sendInputEvent` 的 `clickCount:2` 不满足 Node-RED
  的 `dblClickPrimed`（两次真实 mousedown < 650ms 且同节点），所以进入编辑调节点双击
  处理器里的同一个 `RED.editor.edit(node)`；托盘内的改名/完成仍是真鼠标真键盘，
  截图与 DOM 证明托盘真的开着。要「画布手势」级证据需另有窗口输入注入路径（建议并入
  单开卡，与 T7 §4.1 的 Slides 边界同因）。
- 未验证多 Tab / 原生 runboard 持久史 / 安装包升级回退（T14 §7 的其余 U1 缺口）。

