# W17｜`condition` 迁到 Node-RED 后永远走 else —— 没有人生成 `msg.mcode.condition`

- Status: delivered（2026-10-24；结果回写见文末；未 commit）
- Category: **产品缺陷（迁移路径静默错）**
- Priority: **P0 —— 迁移后的条件图有一半路径是静默错的，而套件全绿**
- Depends on: W8（§2 实测）
- 来源：W8 的 `§0` / `§2` / `§4 第 1 条`

## Required Skills
- `mcode-smoke`：无头主进程套件的写法（本仓库标准的 esbuild + stubs）。
- `systematic-debugging`：先证明「谁该写这个字段」，再动手。

## 缺陷（W8 实测，我复核过）

`flowMigration.ts:808-820` 把旧 `condition` 节点迁成一个原生 `switch`：

```ts
...(kind === "condition"
  ? {
      property: "mcode.condition",
      ...
```

`switch` 读的是 **`msg.mcode.condition`**。

**而全仓没有任何地方写这个字段。** 我复核过：

```bash
$ grep -rn "mcode\.condition" apps/desktop/src/ packages/contracts/src/ --include=*.ts
flowMigration.ts:818:  property: "mcode.condition",     ← 唯一一处，是**读**（switch 的 property）
flowMigration.ts:853:  "...规则暂为「msg.mcode.condition 为 true → 口 0，否则口 1」"   ← 注释
```

**没有生产者。**

### 后果（W8 的探针实测，用真上游 `10-switch.js`）

```
A1 msg.mcode 不存在              → 走 else 口
A2 msg.mcode = {}                → 走 else 口
B1 msg.mcode.condition = true    → 走 true 口
B2 msg.mcode.condition = false   → 走 else 口
B3 msg.mcode.condition = 'true'  → 走 else 口   ← 字符串不认（=== true）
```

**所以迁移后的条件节点永远走 else 口。** 出厂预设 `wf_auto_download` 就含 `mcode.condition`。

### 为什么没人发现

`mcode-node-pack-smoke` 有 **393 条断言全绿**，其中 condition 的断言只验了「迁移产物形状对」
（`wires.length=2`、`rules=[{t:"true"},{t:"else"}]`、`checkall:"false"`）。
**没有一条验「真值从哪来」** —— 这正是 CLAUDE.md 第十三条「套件全绿但指错了地方」。

## 任务

### 一、确认「谁该写这个字段」（先读，不要先写代码）

旧侧求值的实现在 `scheduler.ts:1208-1230` 的 `conditionOutcome`（W8 指出）。
读它，回答：

1. 它怎么解析 `{{上游.字段}}`？
2. `and` / `or` 怎么组合？
3. `exists` / `equal` / `contains` 三个谓词的确切语义（尤其是「引用不存在」和「值不存在」的区别 —— 旧侧 `nodeTypes.ts` 的 usage 写着「没有值时 exists 为 false，但引用不存在/不在上游会失败」）。
4. **结果写到哪个字段**（旧侧是写到下游节点的输入，不是 msg）。

**你写的东西要能让另一个没读过 `scheduler.ts` 的人照着理解。**

### 二、把它接到 native 侧

**只有一条路是对的**：在 `mcode-condition` 之前放一个能求值的节点，或者……

**先想清楚这三件事再选方案：**

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 写 `mcode-condition` 节点** | 一个真正的节点：入 → 求值 → `send([msg],[msg])` 两口 | **和「用上游 switch」的原意冲突**（路线图说能复用上游就不造）。但它能精确复刻旧语义 |
| **B. 给 `switch` 前面加一个求值节点** | 写一个极小的 `mcode-condition-eval`，只负责写 `msg.mcode.condition`，后面接上游 `switch` | 两个节点，但 `switch` 的规则/分流仍然是上游的 |
| **C. 用上游 `switch` 的 JSONata** | 把条件表达式翻译成 JSONata，直接放进 `switch` 的规则 | **最省**，但要验证 JSONata 能表达 `{{}}` + `and`/`or` + 三个谓词；且**旧语义里「引用不存在会失败」JSONata 未必能复刻** |

**我倾向 C 先试，试不通再 B。A 是最后手段** —— 但要你论证，不是我替你定。

**判断标准（照抄）**：如果 C 能让**旧 `conditionOutcome` 的每一个分支**都有等价物，就用 C。
有一个分支表达不了（我怀疑是「引用不存在 → 失败」这条），就退 B。

### 三、不管选哪个方案，这三条必须成立

1. **三种输入都要有正确结果**：`exists` 命中 / 不命中 / 引用不存在（后者必须**失败**，不是走 else）；
2. **`and` / `or` 都要验**（不是只验 and）；
3. **`checkall: "false"`** —— 上游默认 `"true"` 会让一条消息走多个出口（`10-switch.js:264`）。
   迁移器已经写了 `false`（W8 实测），**你要有一条断言守住它**，否则将来有人「对齐上游默认值」就破了。

### 四、变异验证（这条最重要）

**先写预期红几条，正控与负控分开列。**

| # | 变异 | 预期 |
|---|---|---|
| M1 | 删掉写出 `msg.mcode.condition` 的那一步 | **「true 分支走到 true 口」必须红** |
| M2 | 把它改成恒 `true` | **「不命中走 else」必须红** |
| M3 | 把 `checkall: "false"` 改成 `"true"`，并且造一个**两条规则同时命中**的输入 | **「只走一口」必须红** |

**M3 是专门为「上游默认值」设的** —— 不做它，你不知道 `checkall` 那条断言有没有在验。

### 五、套件放哪

**不要改 `mcode-node-pack-smoke`**（它 393/393 是别人维护的大套件，你动它会撞车）。
新建 `apps/desktop/scripts/mcode-condition-bridge-smoke/`。

**但要在回写里说明**：新套件和 `mcode-node-pack-smoke` 的覆盖关系 ——
**后者那 393 条里，是否有一条会因为你的改动而不再为真？** 如果是，先告诉我。

## 验收判据

1. **先有一份「旧 `conditionOutcome` 语义」的书面描述**（带文件行号），能被没读过那段代码的人理解；
2. **方案选择有论证**（为什么 C 行/不行，或为什么退到 B）；
3. **三种输入 + `and`/`or` + `checkall` 都有断言**；
4. **M1/M2/M3 三个变异，红的原因是你想证明的那个**（不是「构造就崩了」）；
5. **正控与负控分开列预期红数**，实际对得上；
6. `npx tsc --noEmit -p apps/desktop/tsconfig.json` **EXIT=0**（取退出码的命令行里不许有 `|`）；
7. **不跑全量**；
8. **不改 `mcode-node-pack-smoke`**。

## 边界

**可以改：**

- `apps/desktop/src/main/workflowEngines/flowMigration.ts`（若方案需要改迁移产物）
- `apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts`（若方案 B：加求值节点）
- `apps/desktop/src/main/workflowEngines/nodePackProductionPorts.ts`（若需要新的 port）
- 新建 `apps/desktop/scripts/mcode-condition-bridge-smoke/`

**⚠️ 独占写入冲突：** `mcodeNodeTypes.ts` / `nodePackBundle.generated.ts` 是
**W18 / W19 也会碰的地方**。开工前先 `git status` 看一眼，**发现别人在改同一个文件就停下来告诉我**。

**不许碰：**

- `apps/desktop/src/main/orchestration/scheduler.ts`（旧执行器，W8 结论是不能删也不能动）
- `apps/desktop/scripts/mcode-node-pack-smoke/`
- `apps/desktop/src/renderer/**`（W15 在改）
- `tasks/T*.md`、`tasks/README.md`

## 回写

`tasks/workflow/W17-condition-bridge.md` 末尾追加 `## 结果回写`：

1. 旧 `conditionOutcome` 的语义描述（带行号）；
2. 方案选择与论证；
3. 三种输入 + `and`/`or` 的实测结果；
4. **三个变异各红在哪一条**，以及红的原因对不对；
5. **预期红数 vs 实际红数**；
6. **你和 `mcode-node-pack-smoke` 的覆盖关系**；
7. **你没能验证的东西**；
8. **W8 / 这张卡上写错的地方**。

## 一条提醒

**这条缺陷最坏的地方不是「条件判断错了」，是「它错了而没人知道」。**

W8 的探针证明了 `switch` 确实按 `msg.mcode.condition` 分流 —— 判据本身是对的。
**错的是「谁该写这个字段」这一环根本不存在。**
**一个不存在的生产者，和「生产者返回了 null」，在套件里看起来一样。**

---

# 结果回写

> 执行时间：2026-10-24 21:50–23:10。工作区基线：`1c2fbf08` + 多会话在途改动（见 §7）。
> **未 commit，不跑全量。** 跑过的套件与结果见 §6 / §9。

## 1. 旧 `conditionOutcome` 的语义（带行号）

抄写自 `apps/desktop/src/main/orchestration/scheduler.ts:1208-1230`（**只读，未改**）：

```ts
conditionOutcome = (node) => {
  const parsed = parseConditionExpression(node.params[NODE_CONDITION_EXPRESSION_KEY]);
  if (!parsed.ok) return { status: "failed", ... };                    // ① 表达式不合法 → 失败
  const evaluated = evaluateConditionExpression(parsed.expression, this.templateScopeOf(node));
  if (!evaluated.ok) return { status: "failed", ... };                 // ② 引用解不出 → 失败
  const yes = edges.filter(e => e.label?.trim() === "true");
  const no  = edges.filter(e => e.label?.trim() === "false");
  if (edges.length !== 2 || yes.length !== 1 || no.length !== 1) ...   // ③ 出边必须恰好 true/false 各一
  const label = evaluated.matched ? "true" : "false";
  ...                                                                  // ④ 选中那条边 = 这次的结果
};
```

**四个问题的答案**：

1. **怎么解析 `{{上游.字段}}`**：不在调度器里 —— 委托 `@contracts/condition` 的
   `evaluateConditionExpression`，逐条规则调 `@contracts/nodeTemplate` 的
   `readConditionRef(ref, scope)`。引用名可以写 **id 或标题**（`scope.upstream` 里两者都有）；
   `{{user}}` 是内置；`{{trigger.x}}` 是另一个名字空间；短写法 `{{A.某变量}}` 等价于
   `{{A.outputs.某变量}}`，取上游的**产出变量**。
2. **`and` / `or` 怎么组合**：`answers.every(Boolean)` / `answers.some(Boolean)`，
   **不做短路**（`evaluateConditionExpression` 的注释原文：哪怕前一条已决定真假，后面的
   坏引用仍必须显式报错）。
3. **三个谓词的确切语义**（`condition.ts:45-73` + `nodeTemplate.ts:435-485`）：
   - `exists`：`read.found` —— **`false` / `0` / 空串 / 空数组都算存在**；只有
     值缺失（`undefined`）或 `null` 才算不存在。
   - `equal`：`textOf(value) === rule.value`，`textOf` 对 string/boolean/有限 number
     做**JS `String()`**，其余（对象、数组）返回 `undefined` → false。
   - `contains`：字符串按**子串**；**数组按「任一项转文本后是该子串」**（2026-09-28 改过，
     注释写着从前是逐项全等、导致 `{{trigger.input.files}} 包含 .pdf` 恒为 false）。
   - **「引用不存在」≠「值不存在」**：节点不存在 / 不在上游 / 标题歧义 → `readConditionRef`
     返回 `{ ok:false, error }`，**整条求值失败**；节点在、字段缺失 → `{ found:false }`，
     `exists` 为假、其余谓词为假。前者失败、后者 false —— 这个区分是这次实现里
     最容易被抹平的一条（见 §3 的「显式失败」）。
4. **结果写到哪**：**不写字段**。旧调度器把「命中与否」变成**选了哪条出边**
   （`this.chosen` / `lastPick`），节点结局是
   `outputs: { result: matched, branch: label }`、`summary` 是透传的上游文本。

## 2. 方案：**B**（`mcode-condition-eval` 适配节点 + 上游 `switch`），为什么不是 C

| | 方案 | 结论 |
|---|---|---|
| **C. 表达式翻译成 JSONata 塞进 switch 规则** | **不可用**，两条实测出局的理由：① **比较语义漂** —— 旧 `equal` 用 JS `String()`，JSONata `$string` 不是它（`$string(1.2345678901234567e-8)` = `"1.23456789012346e-8"`，截到 15 位有效数字；JS 给 `"1.2345678901234567e-8"`）；② **作用域拿不到** —— switch 的 JSONata 只能看 `msg`，而旧求值要读**任意上游**的 `summary`/`outputs`/`status`/`params`。要给 JSONata 拼 scope 就得先有另一个生产者 —— 那已经是 B。**卡上怀疑「引用不存在→失败 JSONata 表达不了」这条不成立**：实测 `$error()` 会让 switch 调 `node.error` 且一口都不发，正好是旧语义。 |
| **B. 求值节点 + switch** | **采用**。求值在 **Host** 做，直接 `import` 旧的 `evaluateConditionExpression` —— 硬规矩 2 要求的「共享实现只有一份」；switch 仍只负责按布尔分流（复用上游的初衷保住）。 |
| A. 自己写 `mcode-condition` 两口节点 | 不用。B 已经把求值那一步接管；再造一个做分流等于替换掉上游 switch，与「能复用就不造」冲突。 |

**新增/修改的形状**（每一样都只有一处定义）：

- `packages/contracts/src/conditionBridge.ts`（新）：`MCODE_CONDITION_EVAL_NODE_TYPE`、
  `CONDITION_SWITCH_PROPERTY`、`CONDITION_SWITCH_RULES`、`CONDITION_SWITCH_CHECKALL`、
  `conditionSwitchShape()`、`CONDITION_EVAL_BRIDGE_KEY`（`bridgesNodeId`）、
  `conditionEvalTargetOf()`（反向折叠的唯一判据）、`classifyConditionRef()`
  （「native 侧有没有数据源」的唯一判据）。
- `apps/desktop/src/main/workflowEngines/conditionHost.ts`（新）：`evaluateConditionForHost()`
  ——拼 `NodeTemplateScope`（**上游闭包用 `buildForwardAdjacency` + `upstreamClosure`，
  与旧调度器同一份算法**）、`sanitizeConditionResults()`（不可信 results 的过滤）、
  以及对三类「Host 拿不到」的显式拒绝。
- `apps/desktop/src/main/workflowEngines/conditionHostPorts.ts`（新）：生产 `condition.evaluate`，
  `withConditionEvaluation(base, deps)` 给既有 `NodePackHostServices` 包一层。
- `mcodeNodeTypes.ts`：`runConditionEvalNode()` + `McodeConditionEvalPort` +
  `MCODE_INTERNAL_NODE_TYPES` / `MCODE_REGISTERED_NODE_TYPES` + `conditionEvalNodeHtml()`；
  `outputMsg()` 追加 `msg.mcode.results`（见 §3 第 3 条）。
- `flowMigration.ts`：插入适配节点、入边改接、`edgeMeta` 重定向、反向折叠
  （`flowToWorkflowDoc` 开头把适配节点折回）、`lossy` 文案改成「边界」而不是
  「求值由 Host 侧承担（MERGE-3 接）」。
- `nodePackManifest.ts` + `registry.ts` + `nodePackHost.ts` + `nodePackChildRuntime.ts`：
  安装/注册/IPC 动作 `condition.evaluate` 的接线。

## 3. 三种输入 + `and`/`or` 的实测结果

套件 `apps/desktop/scripts/mcode-condition-bridge-smoke/`（**新建，未碰
`mcode-node-pack-smoke`**），**47/47 通过，其中负控 9 条**。核心几条：

| 输入 | 结果 |
|---|---|
| `exists` 命中（上游这次交过结果） | `true` |
| `exists` 不命中（上游这次没交） | `false` |
| 引用**图上不存在**的节点 | **失败**（不是 false） |
| 引用**在图上但不是上游** | **失败** |
| `and`：一条假 | `false` |
| `or`：一条真 | `true` |
| `or`：两条都假 | `false` |
| `equal` 引用**产出变量** | **失败**（native 执行记录不保留产出变量 —— 不落成 false） |
| `contains` 对字符串 | 子串命中 |
| `{{trigger.*}}` | **失败**（原生触发载荷不离开引擎进程） |
| 原生节点（`function` 等）的 `status` | **失败**（结局只有引擎自己知道） |
| 正控：原生节点的 `title`（配置，不是结局） | 算得了 |

**真上游 `10-switch.js`**（进程内加载原文 + 真 `@node-red/util`）：
`condition=true` → 只走口 0；`false` / 字段缺席 → 只走口 1。上游 `node.send` 会截掉
尾部全 null 的口（实测数组长度 1 vs 2），套件先归一化到两个口再断言。

**往返**：`migrate → flowToWorkflowDoc` 后节点数/边数不变、`params.expression` 原样、
无残留适配节点；**无 `links` sidecar**（真编辑器读回形态）也折回。

## 4. 三个变异各红在哪一条，红的原因对不对

预登记见 `.tmp/w17/mutation-plan.md`；执行器 `.tmp/w17/mutate.py`（每次 apply 断言
`count==1`，还原后 `sha256` 逐字节核对 —— 全部 `OK`）。

| # | 变异（撤的是**证据源**） | 预期 | 实际 | 红在哪 & 原因对不对 |
|---|---|---|---|---|
| **M1** | 删掉适配节点写 `msg.mcode.condition` 那一行 | 2 | **2** | 「把 true 写进…」+「把 false 写进…」。**对**：两处都是「消息上根本没有这个字段」。 |
| **M1b** | 把它改成恒 `true`（写错值，不是删） | 1 | **1** | 「把 false 写进…」。**对**：观察到的 `mcode.condition:true` 而期望 false。 |
| **M2** | 迁移器那一步改成 `if (false && parsed.ok)`（永不插） | 4-6 | **4** | 第 1 节 4 条（适配节点不存在、bridgesNodeId、上游 wire 指向它、它连 switch）。**对**：全是「插入没发生」的直接可观测形态。⚠️ 见下方「M2 的边界」。 |
| **M3** | `CONDITION_SWITCH_CHECKALL` 改成 `"true"`（上游默认） | 1-2 | **2** | 形状断言 + **真 switch 行为对照**（`[["MSG","MSG"]]` 双发）。**对**：后者正是卡里要求的「造一个两条规则同时命中的输入」。 |
| **M4** | 分类层对 `{{trigger.*}}` 从拒绝改成放行 | 1 | **0（第一版）→ 1（修后）** | **第一版没有红**，原因是**第二道防线兜住了**：`readConditionRef` 自己也会拒 `{{trigger.*}}`（scope 里没有 `trigger`）。只断言「失败了」分不清是哪道门拒的 —— 改成断言分类层**特有措辞**（`在 Node-RED 侧算不了`）之后红。**这条是本次最值得记的一次。** |
| **M5** | 删掉「原生节点 status 显式失败」那一支 | 1 | **1** | 「原生节点的 status 被分类层拒绝」。**对**：删掉之后它落到 `readConditionRef` 的 `found:false`，观测到 `{ok:true, matched:false}` —— 正是本卡要修的那种「安静地为假」。 |

**M2 的边界（如实说）**：第 5 节往返在 M2 下**保持绿**——没插东西就没有东西要折，
那两条只在「确实插了」时才有区分力。它们不是 M2 的判据，所以没记进上表预期。

## 5. 预期红数 vs 实际红数

| 变异 | 预期（正控） | 实际 | 负控（该绿） |
|---|---|---|---|
| M1 | 2 | 2 | 9 条负控全绿 |
| M1b | 1 | 1 | 同上 |
| M2 | 4-6 | 4 | 同上 |
| M3 | 1-2 | 2 | 同上 |
| M4 | 1 | **0 → 1**（修断言后） | 同上 |
| M5 | 1 | 1 | 同上 |

M4 的 0 是**判据不够尖**（不是被测对象对）：断言只写了「失败了」，没写「被哪一道拒的」。
修法是把断言钉到分类层特有的那句话上。

## 6. 与 `mcode-node-pack-smoke` 的覆盖关系（**卡上的前提有一半是错的**）

卡说「新套件上线后，393 条里会有断言不再为真」。**实测：393/393 仍然全绿**
（`.tmp/smoke-runs/1792852665311-43932-3KhJ87`，真引擎段实跑未 SKIP）。原因：

- 它的条件夹具是 `{logic:"and",rules:[]}`（**schema 非法**），我的迁移器「表达式不合法
  → 不插适配节点」，所以那条流的形状**一个字节都没变**；
- 它从未断言「`msg.mcode.condition` 有生产者」—— 正是本卡指出的覆盖假象。

**所以「393 条全绿」这件事本身不能说明修复有效**：它对这条缺陷是**盲的**。新套件
（`mcode-condition-bridge-smoke`）才是判据。

**我和它的交集**：`MCODE_NODE_PACK_TYPES` 仍是 6（palette），内部求值适配节点在
`MCODE_INTERNAL_NODE_TYPES`，安装清单取 `MCODE_REGISTERED_NODE_TYPES`（7）。
`allNodeHtml()` 仍只含 6 份 —— 它的「HTML 覆盖全部 6 类型」与 paletteChecks 的
逐类型字节比对都**不需要改**。

**两个可写套件里我改了断言（都是「写死了 6/26」的计数，不是放宽判据）**：

- `t42-node-pack-smoke`：三处 `=== 6` / `=== 26` 改成按 `MCODE_REGISTERED_NODE_TYPES` 推导
  （并**多验了**「每个类型都有 js/html/locale 对」）；
- `x-mcode-roundtrip-smoke`：`package.json` 的 `node-red.nodes === 6` 改成
  `=== MCODE_REGISTERED_NODE_TYPES.length`。
- `flow-migration-smoke`（249/249）、`flow-native-param-smoke`、`flow-migration-identity-smoke`
  **无需改**（上一行的空规则夹具使迁移产物不变）。

## 7. 我没能验证的东西

1. **真 Electron / 真 Node-RED 引擎进程跑这张图**。`t8-node-red-u1` 跑了：**locale 崩溃
   （我自己引入的、总控抓到的）已修**，引擎能起来；但
   `node-red-canvas-load-edit-deploy-reopen` 在 `baseline-deploy` 红，根因是
   **页面端口 ≠ 引擎端口**（装载重启引擎换了端口，页面停在旧端口）。**这不是 W17 造成的**：
   我把自己 8 个文件 + `registry.ts` `git stash` 后单跑同一旅程，**以完全相同的 detail 红**
   （`.tmp/electron-u1/2026-10-24T14-27-33-452Z`），复原后逐字节核对。那条属于另一个
   在途改动（W23 的 reopen-view-after-load）。
2. **`{{trigger.*}}` / 产出变量的「成功」路径**：native 侧没有数据源，本实现只保证
   **显式失败**。`wf_auto_download` 的 `{{trigger.input.doi}}` 迁过去会**失败**，
   而不是像旧图那样工作 —— 这不是「修好了」，是「把静默错换成了响错」。见 §8。
3. **`edgeMeta` 在真编辑器导出/导入后是否仍然指向条件 switch**：我只在
   「无 links sidecar + edgeMeta」的**纯函数**形态里验了折叠；真 editor-client 的
   export 是否会改写 `x-mcode.edgeMeta` 里的 `targetNativeId` 没跑过。
4. **多会话并行下再跑一遍全部相关套件**：§9 的单套结果是在这次会话的工作区状态里跑的；
   `nodePackProductionPorts.ts` 在我期间被 W21 改过（见 §8 第 3 条），我没有重跑
   `mcode-node-pack-smoke` 以外的、依赖它的套件。

## 8. W8 / 这张卡上写错的地方（以及我自己差点写错的）

1. **卡（和 W8）的 M3 前提不成立**：`[可比较规则, else]` 这个形状下 `checkall` 的两种取值
   **行为完全一样** —— `elseflag` 让 `else` 只在前面没人命中时才发。所以「把
   `checkall:"false"` 改成 `"true"` 让套件红」**在迁移器自己产出的形状上做不到**。
   行为对照必须**另造一个两条规则同时命中的输入**（我照卡的要求做了）。卡里那句
   「上游默认 `"true"` 会让一条消息走多个出口」是对的，但它只在**规则形状不是
   [X,else]** 时才可观测。
2. **卡怀疑「C 表达不了引用不存在→失败」—— 不成立**（实测 `$error` 能让 switch
   一口不发）。C 真正出局的是**比较语义漂**与**作用域拿不到**。
3. **`nodePackProductionPorts.ts` 是 W21 的在途文件**，卡把它列在「可以改」里是对的，
   但实际上**现在不能碰**。我一度删掉了 `chooseBranch` 里的一行（`const params = ...`），
   立刻发现并还原；`git diff` 复核确认**我的痕迹零残留**。W17 的接线因此改在
   **新文件 `conditionHostPorts.ts` + `registry.ts` 的包一层**，而不是那个函数内部。
4. **我自己差点写错、被实测抓住的两处**：
   - **`classifyConditionRef` 把 `{{A.summary}}` 判成「产出变量、算不了」**。`summary`
     是清单声明的产出键，但**住在 `outcome.summary`（执行记录外层）**，Host 拿得到。
     不看这一条，出厂预设里最常见的 `{{上游.summary}}` 会让整张条件图**失败** ——
     比原本的「永远走 else」还坏。套件的 9 条正控当场抓住了它。
   - **反向折叠把「上游→适配节点」改成了过滤**，等于把用户那条边删掉（往返边数 4→3）。
     套件「往返后边数不变」抓住。改成**改指**（`target = evalTarget.get(target) ?? target`）。
5. **locale 崩溃**（总控抓到）：加了节点类型却没补 `nodePackManifest.ts` 的 `help`
   词条，`localeText` 抛 `Missing Node-RED node locale`，**三条 U1 旅程全部起不来**，
   而我的新套件不经过 `expectedNodePackFiles`，**全绿**。已补 `en-US`/`zh-CN` 两份，
   并跑过 `t8-node-red-u1` 确认「不是 locale 了」。
6. **`MCODE_NODE_PACK_TYPES` 一改，`McodeNodePorts` 就多了必填的 `conditionEval`** ——
   任何注入假 port 的调用点都得补。我补了 `nodePackChildRuntime.ts`；`mcode-node-pack-smoke`
   的假 port 走的是子进程注册路径而不是这个对象，所以它没有红。

## 9. 跑过的套件（可复核）

| 套件 | 结果 |
|---|---|
| `mcode-condition-bridge-smoke`（新） | **47/47**（负控 9） |
| `mcode-node-pack-smoke` | **393/393**（真引擎段实跑） |
| `flow-migration-smoke` | **249/249** |
| `flow-native-param-smoke` / `flow-migration-identity-smoke` | 通过 |
| `x-mcode-roundtrip-smoke` | **73/73**（改了一处计数断言） |
| `t42-node-pack-smoke` | 通过（改了三处计数断言） |
| `condition-smoke` | **24/24** |
| `node-red-e2e-smoke` | **106/106** |
| `workflow-engine-selection-smoke` / `workflow-native-load-smoke` / `t27-load-entry-deadlock-smoke` | 16/16 / 18/18 / 40/40 |
| `workflow-engine-runtime-smoke` / `workflow-executor-registry-order-smoke` | 114/114 / 17/17 |
| `t85-workflow-migration-preflight-smoke` | 通过 |
| `t8-node-red-u1` | **红**，但**不是 W17**：`baseline-deploy` 页面端口≠引擎端口；stash 复现（§7） |
| `npx tsc --noEmit -p apps/desktop` / `-p packages/contracts` | **EXIT=0 / EXIT=0** |

`nodePackBundle.generated.ts` 已重新生成（`apps/desktop` 下跑 `build/build-node-pack.cjs`）。
与「别人 18:28 的 4 处路径前缀差异」相比：**我这次生成的 bundle 只有我的功能改动**
（逐行比对：新增 63 行全部是 W17 的代码；路径前缀与当前工作区一致）。

## 总控验收（2026-10-24，工作流总控）

**结论：通过。这是这批卡里设计最完整、边界说得最清的一张。**

### 我独立验了什么

| # | 项目 | 我的验证 |
|---|---|---|
| 1 | 新套件 | 我自己跑：`mcode-condition-bridge-smoke` **PASS**，EXIT=0 |
| 2 | **迁移产物里真的插了求值节点** | 我自己写探针跑 `migrateWorkflowDoc`（见下） |
| 3 | `mcode-node-pack-smoke` 真的对这条缺陷是盲的 | 读了它的夹具：`rules: []`（空规则表）—— 迁移器对非法表达式不插节点，所以那份夹具一个字节没变，393 条自然全绿 |
| 4 | locale 崩溃 | 这次我抓到的那个 `Missing Node-RED node locale: en-US/mcode-condition-eval`，en-US / zh-CN 两套都在（`nodePackManifest.ts:181`、`:218`） |

### 我的探针（第一次写错了，记下来）

我写了个探针调 `migrateWorkflowDoc`，第一次传的是 `{ nodeTypes: ... }` —— **返回 `mcode-unknown`**。
读签名才发现字段名叫 **`types`**（`flowMigration.ts:686`）。改对之后：

```
nodes: ["tab","mcode-unknown","switch","mcode-condition-eval","mcode-unknown","mcode-unknown"]
has condition-eval: true
eval node.wires = [["n_c1"]]          ← eval → switch，顺序对
eval node.x-mcode.bridgesNodeId = "c1"  ← 记录它替代的是哪个旧节点
```

**第一次那个 `mcode-unknown` 如果我没追问，就会得出「没插节点」的错误结论。**
这正是「探针自身要有对照」——我的对照是「换一个已知合法的输入，看输出变不变」。

### 它做得比我卡里要求的好的三处

1. **零语义漂移**：Host 侧直接 `import` 旧的 `evaluateConditionExpression`，**没有重写一份**。
   我卡里只说了「要能 import 真身」，它连「上游闭包复用 `buildForwardAdjacency` + `upstreamClosure`」也照做了。
2. **反向迁移折叠适配节点**：往返节点数/边数不变，**预检不会因此 REJECT**。
   这条我卡里完全没想到 —— 不折叠的话，迁移一次再迁回来会多出节点，预检会拒。
3. **内部节点用单独的表**（`MCODE_INTERNAL_NODE_TYPES` vs `MCODE_NODE_PACK_TYPES`），
   理由写在注释里：「那张表是『用户可以拖进画布的节点』的清单，混进内部节点会让
   调色板、文档与覆盖断言三处都说不清」。**这是对的，而且是我没要求的。**

### M4 那条变异，是整批卡里最值得记的一次

> M4 分类层放行 `{{trigger.*}}` → **第一版 0 红**！第二道防线（`readConditionRef`）兜住了。
> 断言改成钉分类层特有措辞后红 1。

**这是「被拒了 ≠ 被你的防线拒了」的教科书实例**（CLAUDE.md 新增的那条）。
**如果它没做这个变异，那条断言会一直绿着，而你以为它在验分类层。**

### 三条更正，我核过，都对

1. **M3 前提不成立**：`[规则, else]` 形状下 `checkall` 两种取值行为完全相同（`elseflag`）。
   我的卡说「M3 必须造两条规则同时命中」——**是对的**，但它指出的是「我原来以为 `[规则, else]` 就够」。
2. **我怀疑「方案 C 表达不了引用不存在→失败」不成立**。真因是 `$string` 与 JS `String()` **精度不同**
   （`equal` 语义漂）+ scope 拿不到。**我的怀疑方向错了，结论（不做 C）碰巧对。**
3. **393 全绿但盲** —— 见上，我核实了。

### 它明确说「没修好」的那条，我接受这个判断

> `{{trigger.*}}` 与结构化产出变量在 native 侧**没有数据源**：本实现让它**显式失败**。
> `wf_auto_download` 的 `{{trigger.input.doi}}` 迁过去会失败 ——
> 这是「静默错换成响错」，不是修好了。

**我核了它的迁移报告**（用 `{{trigger.input.doi}}` 跑探针）：`lossy` 里点名写着
「引用它们会让条件节点**显式失败**（而不是安静地走 false）」。

**这是正确的中间态**：**沉默的错误换成响亮的错误**，而且写在迁移报告里让用户看得到。
真要支持得给 trigger 载荷接一条 Host 通道 —— **另开卡（W25）**。

### `t8-node-red-u1` 的红，我确认与它无关

它说把全部改动 stash 后单跑同一旅程、**同一 detail 复现**。我自己跑全量包装器时看到的
是 locale 崩溃（W17 引入，已修）；修完后红在 `baseline-deploy`（页面端口 ≠ 引擎端口）——
**那正是 W23 要修的**。两件事分开，都对。
