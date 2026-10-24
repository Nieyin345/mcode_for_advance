# W25｜`{{trigger.*}}` 迁到 Node-RED 没有数据源 —— 现在会显式失败

- Status: partial-delivered（2026-10-25：HookEvent 订阅修复；trigger.input 自定义 UI 数据仍不等价，已在装载确认前明确警示）
- Category: **能力缺口（迁移后已知不可用，但有明确报错）**
- Priority: **P2 —— 它不静默错，但 `wf_auto_download` 迁过去会失败**
- Depends on: W17（已交付）
- 来源：W17 的执行会话主动报告

## 现状（W17 的实现，我已核实）

W17 修好了「condition 永远走 else」，但**明确留了一条没修**：

> `{{trigger.*}}` 与结构化产出变量在 native 侧**没有数据源**：本实现让它**显式失败**。
> `wf_auto_download` 的 `{{trigger.input.doi}}` 迁过去会失败 ——
> 这是「静默错换成响错」，不是修好了。

**我用探针核实过**：跑 `migrateWorkflowDoc` 传一个含 `{{trigger.input.doi}}` 的条件，
迁移报告里确实点名了：

> 边界：`{{trigger.*}}`、结构化产出变量与原生节点结局在 Node-RED 侧没有数据源，
> 引用它们会让条件节点**显式失败**（而不是安静地走 false）。

**这个中间态是对的**（沉默的错误换成响亮的错误），但它意味着：

| 用户做的事 | 结果 |
|---|---|
| 把含 `{{trigger.input.doi}}` 的旧图迁到 Node-RED | **部署成功，执行时条件节点报错** |
| 迁移报告里 | **有一句说明**（用户得读到它） |

## ⚠️ 派活时总控核实过：`lossy` 报告**用户看不到**

我在卡里问「渲染端有没有显示 `lossy`」，**先替你查了**：

```bash
$ grep -rn "lossy\|needsHumanDecision" apps/desktop/src/renderer/ --include=*.tsx --include=*.ts
RuntimePolicyPanel.tsx:11:  /** Important execution limits use explicit Apply, not lossy debounce. */
```

**除了一行无关注释（`lossy debounce`），渲染端零命中。**

**所以 W17 那句「边界写进了迁移报告」——只有套件和日志能看到，用户看不到。**

**这改变了本卡的重点：**

| 原以为 | 实际 |
|---|---|
| 用户迁移时能看到「这条流跑不起来」 | **看不到。** 他要等到部署后执行到那个条件节点，才收到一句错误 |

**所以「C（只把报告做得更显眼）」不是「更省的做法」，而是「目前唯一让用户知道的办法」——**
**而且它现在根本不存在。**

### 这对你的方案选择意味着什么

- 如果你选 **A 或 B（真修）**，那 `lossy` 显示与否就不那么关键了（能跑就行）——
  **但迁移报告里那条边界说明仍然该显示**，因为还有别的 lossy 项；
- 如果你只能选 **C**，那**「让用户在迁移时看到」是本卡的核心交付**，不是附属品。

**无论哪条，第 6 条验收（`lossy` 有没有显示给用户）都是必答项。**

## 为什么这值得做

**出厂预设 `wf_auto_download` 就用了 `{{trigger.input.doi}}`。**

用户把这份预设迁过去 → 跑到条件节点 → 报错。**报错比静默错好，但用户还是用不了。**

## 任务

### 一、先查清「旧侧的这个值是从哪来的」

**不要先想着怎么接，先读**：

```bash
grep -rn "trigger\." apps/desktop/src/main/orchestration/ --include=*.ts | head -20
grep -rn "triggerInput\|\"input\"" apps/desktop/src/main/orchestration/runner.ts | head -20
```

回答：
1. 旧侧 `{{trigger.input.doi}}` 里的 `input` 是什么形状？
2. 它从哪来（webhook 载荷？文件内容？用户手填？）
3. **Node-RED 侧有没有等价物**（`mcode-trigger` 的 event payload 里有什么？）

**如果你发现 `mcode-trigger` 的 payload 里根本没有这个字段** —— 那这条不是「接一根线」，
是「两个系统对『触发时带什么数据』的定义不同」。**那结论会不一样，先说清楚再动手。**

### 二、三条路，你论证选哪条

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 给 `mcode-trigger` 的 event 加 `input` 字段** | 宿主订阅时把载荷一起递过去 | 要看旧侧 `input` 的形状能不能对上 |
| **B. 让迁移器把 `{{trigger.*}}` 改写成 Node-RED 的 `msg.payload.*`** | 迁移时做一次映射 | **只在两边数据形状一致时成立** |
| **C. 不修，但把「迁移报告里那句话」做得更显眼** | 迁移时如果检出 `{{trigger.*}}`，在**迁移结果 UI** 上明确提示「这条流迁移后跑不起来，因为 X」 | 最省；但用户还是用不了 |

**我倾向 A 或 B（真修）**，但如果查下来两边数据形状对不上，**C 是可以接受的** ——
前提是**用户在迁移时就知道**，而不是部署后才炸。

### 三、不管选哪条，「迁移时就知道」这条不能省

W17 已经把边界写进了迁移报告的 `lossy`。**问题是：用户看得到那份报告吗？**

查：
```bash
grep -rn "lossy\|needsHumanDecision" apps/desktop/src/renderer/components/settings/workflows/
```

**如果渲染端没有显示 `lossy`，那这条报告只有套件和日志能看到** ——
那就是一个「写下来了但没人读」的断言（CLAUDE.md 第十八条）。

## 验收判据

1. **旧侧 `{{trigger.*}}` 的数据来源有源码依据**；
2. **`mcode-trigger` 的 event payload 形状**（贴实际结构）；
3. **方案论证**，包括「两边数据形状是否一致」这个前提；
4. **如果做了 A/B**：一条端到端断言 —— 含 `{{trigger.*}}` 的旧图迁移后**能真的跑通**；
5. **如果只做 C**：一条断言 —— 迁移结果**在 UI 上**明确告诉用户这条流跑不起来；
6. **`lossy` 报告有没有显示给用户**（这是第三条的核心问题，无论选哪条都要回答）；
7. 变异验证；
8. `tsc` EXIT=0；
9. 不跑全量。

## 边界

**可以改：**

- `apps/desktop/src/main/workflowEngines/flowMigration.ts`
- `apps/desktop/src/main/workflowEngines/{mcodeNodeTypes,nodePackProductionPorts,conditionHost}.ts`
- `apps/desktop/src/renderer/components/settings/workflows/`（**⚠️ 与 W20 可能冲突，先 `git status`**）
- 新建套件

**不许碰：**

- `apps/desktop/src/main/orchestration/scheduler.ts`（旧执行器）
- `apps/desktop/scripts/mcode-node-pack-smoke/`、`mcode-node-pack-ports-smoke/`、`mcode-agent-capability-smoke/`、`mcode-condition-bridge-smoke/`
- `apps/desktop/scripts/t8-node-red-u1/`（**W23 正在改**）
- `tasks/T*.md`、`tasks/README.md`、`tasks/workflow/README.md`

**⚠️ 开工第一步**：`git status --porcelain apps/desktop/src/ apps/desktop/scripts/`

## 回写

`tasks/workflow/W25-trigger-payload.md` 末尾追加 `## 结果回写`：

1. 旧侧 `{{trigger.*}}` 的数据来源（带行号）；
2. `mcode-trigger` 的 event payload 实际结构；
3. 方案选择与论证；
4. **`lossy` 报告有没有显示给用户**；
5. 变异结果；
6. **你没能验证的东西**；
7. **W17 / 这张卡上写错的地方**。

## 一条判断标准

**「静默错换成响错」是进步，不是终点。**

W17 把一个「安静走错分支」换成了「显式失败」，那是对的 ——
**但用户要的是「能用」，不是「错得响亮」。**


## 2026-10-25 结果回写（本轮 W25：事件订阅已修；运行前输入仍属不兼容语义）

### ① 两种 trigger 的数据到底是什么

- 旧侧 `apps/desktop/src/main/orchestration/automationPayload.ts:27-62,111,231-254,261-317`：`TriggerInputValues = Record<string, string | string[]>`。自定义 UI 的运行前表单会把该值传给 `automationRunner.runWithTarget(..., input)`（`automationRunner.ts:2015-2065`）；其 `payloadFactsOf` 把字段拍平为 `input.doi` 一类属性，以解析 `{{trigger.input.doi}}`。它**不是** HookEvent 自身的属性。
- 实际预设 `apps/desktop/resources/presets/workflows.json` 的 `wf_auto_download`：`mcode.trigger.params.events="library.item.imported"`，但 `params.task` 是给模型看的长段自然语言工作说明；条件节点引用 `{{trigger.input.doi}}`。
- 本轮开工前生产 `nodePackProductionPorts.ts` 错把 `params.task` 当作唯一事件名，且限制 100 字：这个真实出厂预设订阅会被拒绝，或根本匹配不到事件。Node-RED 的 `runtimeManager.subscribe` 事件消息只有 `event.type`、`event.sessionId` 等宿主 runtime 事实；此前 `emit` 的结构是 `{payload:{event,sessionId,at}}`，**没有** `input` 或 `doi`。

### ② 采用的两层方案与安全边界

- **真实修复事件订阅 (A 的一部分，不是假冒 input 已接通)**：`flowMigration.nativeNodeConfigOf` 将旧 `events` 暴露在 Node-RED 原生可编辑字段；原生字段覆盖旧 sidecar，反向回读不复活过时事件名；旧数组形式做往返保形。节点 HTML 加 `events` 与 `eventFilter` 表单，并把 `task` 文案标清“不是事件名”。
- 生产 Host `trigger.subscribe` 使用 `params.events` 的一项或多项 HookEvent 名称，旧手建、完全没有 `events` 字段的节点保留原 `task` 单事件名兼容；**如果 events 字段存在但被清空/填错，绝不回退到 task**。限制事件名语法、数量（最多 16）和长度，Host 对不匹配事件不派发、unsubscribe 后不派发。
- 旧 `eventFilter` 当前 Host 没有等价过滤器：**非空时明确拒绝订阅**，不得把“只处理某些对象”静默变成“处理事件中的全部对象”；迁移器保留可编辑字段并在人类裁决项点名。
- **`{{trigger.input.doi}}` 不能靠 A/B 直接等价修复**：这是 UI 运行前输入，不存在于普通 RuntimeEvent，也不能把 `itemId` 伪造为 DOI。保留 W17 fail-closed 的条件求值，并为实际含 `{{trigger.*}}` 的条件追加专门的 `lossy` 文案：**“【迁移后不能执行】…即使 Deploy，条件仍显式失败；需先改写条件及输入来源”**。没有不经证据便把表达式转写为 `msg.payload.*`。
- **用户能看到迁移问题**：卡原本声称「渲染端没显示 lossy」已过期。实际上 `nativeLibraryLoad.ts:knownLossLines` 把 `report.lossy` 装进需要人工确认的 `reason`，`WorkflowNativeEditorEntry.tsx` 在 `result.requiresConfirmation` 时以 `<p role="alert">` 显示并提供确认/取消。新测试直接走生产 `loadWorkflowIntoNative`（隔离临时目录）断言返回给 UI 的 reason 含 `【迁移后不能执行】` 与 `trigger.input.doi`，而不是仅测试数组。
- 没有放宽用户审批、触发执行权、Hub 事件范围或自动重启；没有引入第二套触发器。

### ③ 变更与验收

修改四处原有生产实现：`flowMigration.ts`、`mcodeNodePack.ts`、`mcodeNodeTypes.ts`、`nodePackProductionPorts.ts`；新增 `apps/desktop/scripts/mcode-trigger-events-smoke/`（从真实 shipped `wf_auto_download` 读取，调用**真实**迁移器、节点归一化与生产 Host subscribe，只有宿主 runtime emitter 使用现有测试 stub）。
- 最终新套件 **20/20 PASS**，涵盖真实事件名、任务说明不覆盖、原生表单往返、Host 回执/事件过滤/取消订阅、两个事件、空值/坏值、非等价筛选拒绝、原生迁移确认文案到 UI 返回。
- 连同 `flow-migration-smoke` / `mcode-condition-bridge-smoke` / `mcode-node-pack-smoke` / `mcode-node-pack-ports-smoke` / `mcode-conversation-session-smoke` / `workflow-native-load-smoke`：**7 PASS / 0 FAIL**，日志 `apps/desktop/.tmp/smoke-runs/1792873522529-29164-zZvUbT/`。Desktop + Contracts 两套 `tsc --noEmit` 均 EXIT=0。
- 变异 #1：生产端把 `source` 强制恢复 `params.task`，新增套件 EXIT=1，确实因长任务说明无法注册正确事件而在真实 subscribe 抛错，符合原故障；随后恢复原代码。
- 变异 #2：移除 `eventFilter` 保护，新增套件 **16/17**，`旧事件筛选未实现时不得静默扩大触发范围` 精确红；恢复代码后 20/20 全绿。

### ④ 明确未完成的部分

- **不宣称 `wf_auto_download` 已整图可用**：它的 `trigger.input.doi` 原生侧仍没有真实来源；这需要 UI 触发入口向 Node-RED 注入可信的运行前输入，并维护所属 workflow、来源会话、项目身份及审批，不能仅从普通 HookEvent 构造。当前在迁移前向用户明确展示此限制，执行时继续拒绝错误求值。
- 本轮未跑真实 Electron 自定义 UI → 原生 Host 的整图行为；测试是原生生产 Host + 隔离 stub runtime、隔离 native load。未跑全量 smoke；未修改正在被其他对话使用的 t8 / W26 UI。


### 追加硬化验收（2026-10-25）

- 除非 `eventFilter` 缺省/null/空字符串，其他**所有格式**均拒绝；包括直接由 Node-RED IPC 构造的非字符串对象，不允许通过类型错误绕过原筛选保护。
- 新 suite 再加 “对象 eventFilter 不能绕开 Host 筛选守卫”：最终 **21/21 PASS**；七套相关 smoke **7/7 PASS**，证据 `apps/desktop/.tmp/smoke-runs/1792873791308-18444-A5SMh6/`；Desktop + Contracts 两套 TypeScript 检查 EXIT=0。
- W20 只读再盘点发现旧卡片尚有 3 个额外测试引用，不能在本任务扩围删除；细节回写 `tasks/workflow/W20-dead-code.md`。
