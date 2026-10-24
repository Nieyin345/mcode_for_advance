# W25｜`{{trigger.*}}` 迁到 Node-RED 没有数据源 —— 现在会显式失败

- Status: ready-for-agent
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
