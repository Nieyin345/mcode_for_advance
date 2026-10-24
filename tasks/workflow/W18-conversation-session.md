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


## 结果回写（2026-10-25：实现完成，定向回归通过；真实用户部署 U1 未验）

### 旧会话语义与方案

- 源码依据：`apps/desktop/src/main/orchestration/nodeTypes.ts` 里的 `mcode.main`（约 631 行）与 `mcode.conversation`（约 699 行）均为 `runner.kind = "conversation"`，其 usage 写明运行在**用户发起流程的主对话**，不是工作流本身持久绑定的聊天 ID。旧 `WorkflowDoc` 不包含可安全猜出的发起会话标识。
- 选择本任务卡的**方案 B（原生 Node-RED 编辑器显式选择/填写 ID）**：只有用户明确填写的现有可见会话才可作为执行对象；不拿 `x-mcode.docId` 冒充 chat ID，不把“当前活动聊天”静默带进可分享工作流。工作流转发/导入后，用户须核对节点的目标会话再部署。Host 仍以 `SessionRepo` 校验目标必须是存在的 `chat`，并保留原 provider / 授权 / 工作目录防线。
- 未绑定时保持**缺省为空**，迁移报告明确说必须绑定；原生表单 `mcode-conversation.sessionId` 声明 `required: true`，在编辑器部署阶段暴露必填条件；生产 Host 的 `conversation.run` 缺失或无效 ID 返回可操作的中文错误。旧 `agent.run` / `branch.decide` 的既有错误契约不改变。

### 产品修改

1. `flowMigration.ts`：`prompt/conversation` 将原文档中明确设置的 `sessionId` 写入 Node-RED 原生可编辑顶层字段；反向迁移使用表单当前值覆盖 sidecar，用户清空不得从旧 `x-mcode.params` 复活；对话节点缺绑定的 `needsHumanDecision` 报告讲清处理方法。
2. `mcodeNodeTypes.ts`：复用既有 `htmlFor`，只为 `mcode-conversation` 的会话字段声明 `required: true`，不让无关节点获得新的必填约束。
3. `nodePackProductionPorts.ts`：只对 `conversation.run` 的缺失/无效会话使用中文拒绝信息，保留其他节点原有拒绝字符串和安全语义。
4. 新建 `apps/desktop/scripts/mcode-conversation-session-smoke/` 三个文件：迁移与原生节点 `registerType → input → fake Host port` 的真调用路径；加一份读取真实 SQL（隔离临时 `mcode.db`）的生产端口缺参/不存在会话拒绝测试。没有写用户原始数据库。

### 测试与证据

- `node apps/desktop/scripts/run-smokes.mjs mcode-conversation-session-smoke flow-migration-smoke mcode-node-pack-smoke mcode-node-pack-ports-smoke`：**4 PASS / 0 FAIL**；日志 `apps/desktop/.tmp/smoke-runs/1792871193485-3784-dJCXcC/`。
- 新套件 **20/20** 迁移与执行路径断言 + **4/4** 生产端口错误契约断言；包括 `sessionId` 原生字段、显式选择优先、清空不复活、旧 sidecar-only 格式、真实 Node-RED 输入处理器投递假 Host。
- 项目实际 `resources/presets/workflows.json` 共 7 份：**4 份图形工作流**（`search`、`write`、`wf_auto_download`、`wf_auto_convert`）迁移无未知节点；另 **3 份是无节点的 prompt-only 预设**，不能按“Node-RED 图可执行”计。四份图中只有 **2 份含 `mcode.main`**（`search`、`write`），不是原卡所写 3 份。两份主会话节点在显式填写测试会话后均走过实际 Node-RED `input` 注册处理器 → 假 Host 端口。
- `cd apps/desktop && node_modules/.bin/tsc.cmd --noEmit --pretty false`：EXIT=0；`git diff --check`：PASS。
- 双向变异（每次修改后**立即恢复正确代码**）：将 `config.sessionId` 恒置空，新套件由 11/11 降至 **8/11**，原生值、回读和真实端口接收项都红；将其硬编码为其他会话，降至 **7/11**，明确绑定优先与“不伪造身份”均红。变异前后的失败详情分别在 `apps/desktop/.tmp/smoke-runs/1792870939469-22608-7F7f5R/`、`1792870951845-17904-zxQrb1/`。恢复后新套件升级到含真实预设的 20/20 再通过。

### 已知验收边界

- **尚未执行真 Electron U1 的“缺会话 → 编辑器阻止 Deploy”手势**；只验证真实生成的 Node-RED 节点 HTML `required:true`、迁移链和生产 Host 拒绝，不把源代码检查伪装成真 UI。
- 真实 LLM/provider 的长会话轮次没有跑（fake Host port），只证明绑定身份经生产注册路径到达端口和生产入口的缺参拒绝。4 份图中非会话节点的**整图运行语义**不是本卡已验内容。
- 旧卡“7/7 都含可执行图、3 张含 main”是过时断言，本轮按实际内容订正为 4 张图、其中 2 张含 main，3 张纯提示词。
- 未放宽权限、未启用自动当前会话绑定；工作流重启自动执行的 `engine-trust.json` 授权闭环仍属另一项任务，不能从本卡绿灯推断已修。
