# MCode 修复计划 — 文档漂移与前端接线（2026-09-18）

> 本文是「全面排查 → 计划 → 批量执行」的产物。排查依据：三路并行代码审查
> （前端-后端差距 / IPC 健康度 / 技术债）+ 用户对产品语义的澄清。

---

## 0. 关键前提：产品语义澄清

**工作流是「模式」，自动化才是「触发器」。**（用户澄清，2026-09-18）

| | 工作流（模式） | 自动化（触发器） |
|---|---|---|
| 心智模型 | 像"文献精读 / 文献写作"一样，是一种**工作模式** | 像 cron / 文件监听一样，是**后台自动跑** |
| 入口 | **对话输入框左下角的药丸**（`WorkflowDropdown`） | 设置 → 自动化；或触发条件满足 |
| 怎么跑 | 选中模式 → **正常发一条消息** → 按图跑 | 触发器到点/条件满足 → 自动跑；也可手动「立刻运行一次」 |
| 需要"运行按钮"吗 | **不需要**。就像选"文献精读"不需要点"开始精读" | **需要**（`AutomationRunSection`，已实现） |

依据：`docs/工作模式.md:3`、`:32`、`:63-70`；`WorkflowDropdown.tsx:21`（「工作流**跟着会话走**（像模型选择）」）。

**这条澄清直接推翻了一项排查结论**：

- ~~「普通工作流没有运行入口」~~ → **不成立**。设置页没有运行按钮是**设计正确**
  （设置页是编辑图的地方，跑图在对话里）。原计划的 P2（新增 `workflow:run` + 运行按钮
  + D1/D2 两个设计决策）**全部作废** —— 加它反而会污染产品语义。

---

## 1. 排查结论摘要

| 层面 | 结论 |
|---|---|
| IPC 三层接线 | **健康**。243 个 RPC 方法，main handler 与 preload 暴露 100% 覆盖，**零断链** |
| 契约与实现一致性 | **有 2 处判据漂移**，导致能跑的节点被标成"跑不了"（P1） |
| 工作流运行路径 | **健康**（模式语义，入口在对话输入框） |
| 导入导出（WF-08） | 后端纯函数已实现，IPC / preload / UI **三层全缺**（P3） |
| 死接口 | 14 个（preload 暴露但渲染端无调用方）（P4） |
| 测试覆盖 | 33 套件覆盖核心模块；`browser/` 等模块零覆盖（P5） |
| 已知未闭环 | per-trigger 启停无持久化、RUNTIME-09、观察名单 3 项（P6/P7） |

---

## 2. 问题清单与优先级

### P1 — 文档/判据漂移：能跑的节点被标成「跑不了」【最高，本轮唯一必做】

**现象**：内置 `mcode.command` 能正常运行，但两处代码告诉模型/用户「它跑不了」。

**证据**：

1. `apps/desktop/src/main/orchestration/node-types-README.md:101`
   ```
   | `command` | `{ "kind": "command", "entry": "./x.py", ... }` | ❌ **形状定好了,执行还没实现** |
   ```
2. `apps/desktop/src/main/orchestration/node-types-README.md:105-106`
   ```
   > ⚠️ 现在写 `command` 类型的节点**能画、能存**,但**跑不了**
   ```
3. `packages/contracts/src/nodeType.ts:1491`
   ```ts
   if (!isRunnerImplemented(m.runner.kind)) {   // ← 只判 kind，没用 isNodeRunnable
     lines.push(`  ⚠️ 这个类型当前**跑不了**(执行方式 ${m.runner.kind} 尚未实现),只能画进图里。`);
   }
   ```

**真相**（已核实）：

- `isNodeRunnable`（`nodeType.ts:1063-1067`）是正确判据，两段判断：
  ```ts
  if (!isRunnerImplemented(manifest.runner.kind)) return false;
  if (manifest.runner.kind === "command" && manifest.runner.entry !== undefined) return false;
  return true;
  ```
  6 个 kind 都在 `IMPLEMENTED_RUNNER_KINDS`（`nodeType.ts:1050`）里，
  **唯一被降级的是 `command` + `entry !== undefined`**。
- 内置 `mcode.command`（`nodeTypes.ts:554-590`）的 `runner` 是 `{ kind: "command" }`，
  **没有 `entry`** → `isNodeRunnable` 返回 `true` → **能跑**。
  执行器 `commandRunner.ts` / `commandExecutor.ts` 完整，有 33 条 smoke 断言。
- 真正未实现的**只有**「自定义 `entry` 型 command」（第三方插件自带脚本），
  `scheduler.ts:1381-1390` 对它返回明确的 failed + 引导文案。

**影响（这是本轮的核心痛点）**：

- **主动误导模型**：AI 读节点清单后认为 command 不可用 → 建图时**避开命令节点**，
  该用命令的地方改用模型节点（更贵更慢），或直接告诉用户"这个跑不了"。
- **误导用户**：画布徽标与文档都说"跑不了"。
- 这是「让 AI 自己建工作流」这条路的**直接障碍**，且会持续影响每一次生成。

**修法**：

1. `nodeType.ts:1491` 改判据：用 `isNodeRunnable(m)` 替代 `isRunnerImplemented(m.runner.kind)`，
   文案区分"整体未实现"与"仅 entry 型未实现"两种。
2. `node-types-README.md:96-106`：表格拆成两行（`command` 参数型 ✅ / `command` entry 型 ❌），
   修正第 105-106 行的说明。

**风险**：低。纯文案与判据收口，不改执行语义。

**验收**：给模型看的节点清单里，内置 `mcode.command` **不再**被标"跑不了"。

---

### P3 — WF-08 导入导出三层全缺【中】

**现象**：`exportWorkflowDoc` / `importWorkflowDoc` 已实现，但**谁也没调它**。

**证据**：

- 实现：`workflowValidation.ts:379`（export）、`:400`（import）
- 唯一调用方：冒烟脚本 `scripts/workflow-validation-smoke/main.ts:199-218`
- IPC：`workflow.*` 只有 list/get/nodeTypes/save/remove/agentProfiles/... —— **无导入导出**
- preload：同样无
- renderer：无任何 UI

**修法**：按标准四层接线（contracts → main → preload → renderer 按钮，放在**设置页工作流编辑器**
的工具栏 —— 那是编辑图的地方，放导入导出是合适的）。

**注意**：导出/导入是**文档级操作**，与"运行"无关，因此不受 §0 语义澄清影响，仍然该做。

**说明**：这是「有实现、无接口、无入口」的纯未接完，工程量小。

---

### P4 — 14 个死接口【中，本轮登记不清理】

**现象**：preload 暴露了，但渲染端**无任何调用方**。

| # | 方法 | 说明 |
|---|---|---|
| 1 | `library.getRoot` / `setRoot` | 已被统一数据根 `app.getDataRoot/moveDataRoot` 架空 |
| 2 | `templates.getRoot` / `setRoot` | 同上 |
| 3 | `library.kindManifest` / `templates.kindManifest` | 界面改用 `manifest` |
| 4 | `library.conversionStats` | 界面改用 `library.conversionReport`（`IntegrationsPanel.tsx:71`） |
| 5 | `library.fullTextSearch` | 无调用 |
| 6 | `mobile.getPairing` / `cancelPairing` | 界面只用 startPairing/listDevices/revokeDevice/getStatus |
| 7 | `session.saveMessages` | 渲染端改用 `upsertMessages` / `truncateAndInsertMessages` |
| 8 | `automation.sessions` | 仅注释提及（`RunHistorySection.tsx:13`、`NodeInspector.tsx:256`） |
| 9 | `voice.getModelDir` | 仅 Web shim 占位 |
| 10 | `notification.focusSession` | invoke 方向无人调（push 方向有消费者） |

**处置**：**本轮不删**。这批多为「旧方案遗留、新方案已替代」，删除需确认无手机端/扩展依赖。
仅登记，标注「待确认后清理」。

---

### P5 — `browser/` 等模块零 smoke 覆盖【中，长期，本轮不做】

**零覆盖模块**：`main/browser/`（6 文件，`BrowserManager.ts` 2600+ 行）、`mobile/`（7）、
`relay/`（2）、`lsp/`（2）、`terminal/`（3）、`voice/`（2）、`integrations/`（2）、
`claude/` 部分（`ApprovalBridge` / `RuntimeManager` / `subagentStore`）。

**处置**：工程量远超其他项，且与当前阻塞无关。登记为后续任务。

---

### P6 — per-trigger 启停无持久化【中，本轮不做】

`automationStatus.ts` 是**内存态**，重启即丢（Roadmap `:1490`、§13 遗留第 4 条）。

**处置**：不阻塞当前目标，登记。

---

### P7 — 观察名单 3 项【低，复现再查】

1. `longtask-smoke` 偶发时序抖动 —— 本轮自测**未复现**
2. `mcp-endpoint-smoke` 连跑偶发 —— 本轮自测**未复现**
3. `upstream-headers-smoke` 端口竞态 —— 环境隔离**已修**（见 §4），端口竞态仍在观察

---

## 3. 产品硬约束（用户决策，2026-09-18）

### 决策记录

| # | 决策 | 结论 |
|---|---|---|
| D1 | 工作流的「主对话节点」指哪个？ | **`mcode.main`（主代理）** —— 它就是主对话，用户在这里对话，子代理节点在它下游干活。**工作流必须有且只有一个** |
| D2 | 自动化的触发器数量要求？ | **至少一个，允许多个**。多个触发器之间可**逻辑运算** |
| D3 | 逻辑运算节点的形态？ | **B — 通用条件节点**：对变量做布尔运算，决定下游走不走（非触发器专用聚合） |
| D4 | 节点变量输入输出的修复范围？ | **`mcode.code` 与 `mcode.command` 都补 `ioParams()`** |
| D5 | 执行方式？ | **分两批**：先修正现有缺陷，逻辑运算节点单独做 |

### 约束现状（已核实）

| 约束 | 现状 | 证据 |
|---|---|---|
| 工作流必须有且只有一个 `mcode.main` | **只有前端 UI 在拦**（插入菜单不列第二个、不可删）。**校验层 / 保存闸门 / 调度层 / 契约层零实现** | `WorkflowCanvas.tsx:602`、`workflowEdit.ts:110-120` |
| 自动化至少一个触发器 | **完全不存在**。0 个触发器时 `deriveTrigger` **静默把 `trigger` 字段删掉**，降级成普通工作流，不报错 | `library.ts:151-182` |
| 每个节点有变量输入输出 | **只在声明了 `outputVars` 参数的类型上成立**（`mcode.main` / `mcode.agent` / `mcode.conversation` 经 `ioParams()`）。`mcode.code` / `mcode.command` 的 `params` 硬写、**没有 `outputVars`** | `nodeTypes.ts:500`（conversation 有）vs `:600-605`（code 没有） |

**`mcode.code` 变量状况详表**（后端有产出、前端全无）：

| 维度 | 有无 | 证据 |
|---|---|---|
| 运行时产出 `exitCode`/`stdout`/`stderr` | **有** | `codeRunner.ts:116-121, 141` |
| `manifest.outputs` 声明 | 有，但**全库零消费方（死字段）** | `nodeTypes.ts:606`；`nodeType.ts:1084-1087` 注释自称"纯说明" |
| `outputVars` 参数（驱动一切的真机制） | **无** | `nodeTypes.ts:600-605` |
| 前端配置 UI | **无** | `NodeInspector.tsx:625-648` |
| 结果卡片逐项展示 | **无** | `WorkflowStepCard.tsx:124-126` |
| 下游菜单可选中 | **无** | `insertVariable.ts:146, 166` |
| 下游**手写** `{{节点.stdout}}` | **能通** | `nodeTemplate.ts:267-295` 直读 `outcome.outputs` |

根因：`outputVarsOf`（`outputConstraint.ts:91-106`）先过 `usesOutputRules` 闸门 ——
清单没声明 `outputVars` 参数就**恒返回 `[]`**，导致「配置 UI → 产出校验 → 卡片展示 → 下游候选」
整条链对 code/command 失效。

---

## 4. 本计划执行范围

### 第一批（本轮做）—— ✅ 已完成（2026-09-18）

| 序 | 项 | 层 | 结果 |
|---|---|---|---|
| 1 | **P1** 判据收口 + 文档修正 | `nodeType.ts` + `node-types-README.md` | ✅ `nodeType.ts:1491` 改用 `isNodeRunnable`，文案区分"整体未实现"与"仅 entry 型未实现"；README 表格拆成两行（参数型 ✅ / entry 型 ❌） |
| 2 | **C1** 工作流必须有且只有一个 `mcode.main` | 校验层 | ✅ 新增 `graph.no-main-node`、`graph.multiple-main-nodes`（error）。只查普通工作流（有 `trigger` 的自动化豁免） |
| 3 | **C2** 自动化至少一个触发器 | 校验层 | ✅ 新增 `graph.no-trigger-node`（error）。堵住从前 0 个触发器时 `deriveTrigger` **静默降级**的洞 |
| 4 | **V1** `code` + `command` 补产出变量 | `nodeTypes.ts` | ✅ 新增 `outputVarsParam()`，两个类型的 `params` 各加一张「产出变量」表 |
| 5 | **A1** 新建自动化自带触发器 | `workflowEdit.ts` + `WorkflowLibraryView.tsx` | ✅ 新增 `seedTrigger()`，与 `seedMainAgent()` 对称。预填触发方式/任务，项目取用户列表第一个 |
| 6 | smoke 断言 + 回归 | — | ✅ `mcode-admin-smoke` 189/189；**全量 33 套件 0 失败**；双包 typecheck 0 错误 |

**行为变更（用户可见）**：

1. 新建**自动化**时，画布上自带「触发器 + 主代理」两个节点（从前只有主代理）。
2. 保存一份**没有主节点**的工作流、或**没有触发器**的自动化，会被拒绝并给出人话原因。
3. Code / 命令节点在检查器里多出「产出变量」一格；填了的变量会出现在下游的「插入变量」菜单里。
4. 让 AI 建工作流时，它被告知命令节点**能跑**（从前被误导为"跑不了"，会绕开命令节点）。

### 第二批（重新定义，待设计）

原「通用条件节点（N1）」与用户新提出的「触发器/事件源高度自定义」合并为一个方向：

| 序 | 项 | 说明 |
|---|---|---|
| 7 | **触发器与事件源扩展** | 用户诉求：触发不该被"项目"绑死，且触发源要能扩展（监控终端、监控某种状态……）。已定方向：**走 `HOOK_EVENTS` 事件表扩展**，而非新增触发器枚举。设计见 §7 |
| 8 | **N1 通用条件节点** | 变量布尔运算，决定下游走不走。与 7 可并行设计，但实现上 7 优先 |

### 不做（登记待排）

- ~~P2 工作流运行入口~~ → **已作废**（见 §0：工作流是模式，入口在对话输入框）
- P3 导入导出接线 → 降级为待排（非当前阻塞）
- P4 死接口清理（需先确认外部依赖）
- P5 `browser/` 等测试覆盖（长期）
- P6 per-trigger 持久化（不阻塞）
- P7 观察名单（复现再查）

---

## 4. 已完成的前置修复（本计划之前）

### 4.1 smoke 夹具环境隔离（`upstream-headers-smoke`）

**问题**：`buildCustomEnv` 会读进程环境里继承的 `ANTHROPIC_CUSTOM_HEADERS` 并合并，
测试断言要求"恰好等于某值或 undefined"。进程若带该变量（如从 GUI 继承），断言必挂
—— **看着像产品回归，实为夹具未隔离**。

**修复**：`scripts/upstream-headers-smoke/main.ts:129-140` 在 path 1 前清掉继承值，
文件末尾（`:316-318`）恢复。

**验证**：注入脏值后从 `5 failed / 39 passed` → **`44 assertions passed`**，退出码 0。

### 4.2 防呆：自测任务书加环境隔离要求

`docs/self-test/TASK-self-test.md:30-45` 新增第 4 条，要求「判定失败前必须先做变量清理
复跑验证」，避免把环境问题误报成代码回归。

### 4.3 `customEnv.ts` 注释修正

`customEnv.ts:267-270` 补注：`else` 分支天然只可能是 `openai`/`web`（`protocol` 是二值
枚举，`anthropic` 已被上一支接走）。**注释错，代码没错**。

---

## 5. 验收标准

1. **P1**：`nodeType.ts:1491` 改用 `isNodeRunnable`；README 表格区分两种 command。
   → 节点清单里内置 `mcode.command` **不再**被标"跑不了"。
2. **P3**：能在设置 → 工作流里导出为文本、从文本导入。
3. **回归**：双包 typecheck 0 错误；`run-all-smokes.sh` **33 套件 0 失败**。
4. **新增覆盖**：P3 新能力必须有 smoke 断言（按仓库「smoke 先行」纪律）。

---

## 6. 风险与未决

| 风险 | 说明 | 处置 |
|---|---|---|
| 判据改动波及面 | `nodeType.ts:1491` 的输出是给模型看的清单 | 改后跑 `mcode-admin-smoke` 等断言清单内容的套件确认 |
| README 与实现同步 | `工作模式.md:7` 要求文档与代码同步 | 改 README 时不动 `工作模式.md`（后者讲的是六个内置模式，与此无关） |
| 死接口清理风险 | 可能有手机端/扩展依赖 | 本轮不删 |
| 契约改动波及 | 新增 IPC 需同步手机端白名单判断 | 与 `automation.run` 一致：不下发 |
