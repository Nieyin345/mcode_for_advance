# W18｜迁移出来的图跑不了：`mcode-conversation` 要 `sessionId`，迁移器不写

- Status: ready-for-agent
- Category: **产品缺陷（迁移路径静默不工作）**
- Priority: **P0 —— 7/7 出厂预设里有 3 张含 `mcode.main`，迁移后全部跑不了**
- Depends on: W8（§0 表 + §4 第 2 条）
- 来源：W8 的实测

## Required Skills
- `mcode-smoke`：无头主进程套件。
- `codebase-design`：判断「会话身份」该由谁决定。

## 缺陷（W8 实测，我复核过）

`nodePackProductionPorts.ts:35-40` 的 `runSelectedSession` **要求 `params.sessionId`**：

```ts
// 缺 sessionId 直接抛
throw Error("Mcode sessionId is required")
```

（行号以实际代码为准，W8 报的是 `:35-40`，你先读一遍确认。）

**而迁移器不写 `sessionId`。** 我复核过：

```bash
$ grep -n "sessionId" apps/desktop/src/main/workflowEngines/flowMigration.ts
（零命中）
```

W8 的探针实测：`sessionId(native)=null / sidecar=null`。

### 后果

**每一张迁移过来的、含 `mcode.main` 或 `mcode.conversation` 的图，执行时都会抛
`Mcode sessionId is required`。** 而 7/7 出厂预设里有 **3 张含 `mcode.main`**。

用户视角：把旧工作流切到 Node-RED → 点运行 → 报一句他看不懂的错。

### 还有一个语义差异（W8 §0）

| | 旧 `conversation` | 新 `mcode-conversation` |
|---|---|---|
| 在哪跑 | **这张图所属的那条会话** | **用户手填 id 的那条 chat 会话** |

**所以这不是「补一个字段」，是「会话身份从哪来」这个设计没定。**

## 任务

### 一、先回答：会话身份应该从哪来

**三个候选，你要论证选哪个（我不预设）：**

| 方案 | 做法 | 代价 / 风险 |
|---|---|---|
| **A. 迁移时按 `x-mcode.docId` 绑主会话** | 迁移器把旧图对应的会话 id 写进 `sessionId` | 旧图有没有「对应的会话」？**如果没有，A 不成立** —— 先查清 |
| **B. 编辑器里强制选** | 节点参数里加一个必填的会话选择器，没选就不让部署 | 用户每次都要选；但语义清楚 |
| **C. 运行时用「当前活动会话」** | 不填就用当前对话 | 最省，但**图是可分享的** —— 别人拿到你的图，跑在别人的会话里。这可能正是想要的，也可能不是 |

**判断这个问题的关键事实（先查，别猜）**：旧 `conversation` 节点在 `nodeTypes.ts` 里的 usage
说明了它的语义。**读它，然后告诉我「旧系统里那张图绑不绑会话」。**

### 二、不管选哪个，这三条必须成立

1. **迁移后的含 `mcode.main` / `mcode.conversation` 的图，执行时不许抛 `sessionId is required`**
   —— 要么它有值，要么缺值时给一句**用户看得懂**的话（不是英文异常）；
2. **显式填了 sessionId 时，用它**（不能被「当前会话」覆盖）；
3. **7/7 出厂预设都要能迁移 + 执行**（或明确报出「这张图缺 X」）。

### 三、警告要在用户看到的地方

如果最终选择「必须手填」，**那用户必须在部署前就看到**，而不是运行到一半炸。

**位置由你定，但必须满足**：部署/保存时能提前发现，不是在执行时抛异常。

## 验收判据

1. **「旧图绑不绑会话」有源码依据**（带文件行号），不是推断；
2. **方案选择有论证**，并说明「图可分享」这个维度你怎么处理的；
3. **迁移 → 执行 的端到端断言**：含 `mcode.main` 的图迁完之后**真的能跑一次**
   （用假 port 也行，但必须是迁移产物 → 真执行链路，不是只验字段存在）；
4. **显式 sessionId 优先**这条有正控；
5. **缺 sessionId 时的错误是用户能看懂的中文**（不是 `Mcode sessionId is required`）；
6. **变异验证**：
   - 把 `sessionId` 的来源改成恒 `null` → 第 3 条必须红；
   - 把它改成硬编码一个值 → 第 4 条必须红（显式填的被覆盖了）；
7. `tsc` EXIT=0；
8. 不跑全量。

## 边界

**可以改：**

- `apps/desktop/src/main/workflowEngines/flowMigration.ts`
- `apps/desktop/src/main/workflowEngines/nodePackProductionPorts.ts`
- `apps/desktop/src/main/workflowEngines/mcodeNodeTypes.ts`（若要在节点参数里加会话选择）
- `apps/desktop/src/renderer/components/settings/workflows/NodeInspector*`（**⚠️ 若需要** —— 但 W3 可能正在改，先 `git status` 确认）
- 新建 `apps/desktop/scripts/mcode-conversation-session-smoke/`
- `apps/desktop/resources/presets/workflows.json`（**只在不改内容语义的前提下**；改之前先说明）

**不许碰：**

- `apps/desktop/src/main/orchestration/**`（旧执行器）
- `apps/desktop/scripts/mcode-node-pack-smoke/`
- `tasks/T*.md`、`tasks/README.md`
- **`tasks/workflow/README.md`**

**⚠️ 与 W17 的冲突**：W17 也在改 `flowMigration.ts` / `mcodeNodeTypes.ts`。
**如果 W17 已经交付并提交，你可以改；如果还在跑，告诉我，我会让你等。**
**开工第一步：`git status --porcelain apps/desktop/src/main/workflowEngines/` 看一眼。**

## 回写

`tasks/workflow/W18-conversation-session.md` 末尾追加 `## 结果回写`：

1. 「旧图绑不绑会话」的源码依据；
2. 方案选择与论证（尤其「图可分享」怎么处理）；
3. 迁移 → 执行 的端到端实测；
4. 两个变异各红在哪一条；
5. **你没能验证的东西**；
6. **卡上写错的地方**（尤其行号 —— 我引的是 W8 报的，没自己核）。
