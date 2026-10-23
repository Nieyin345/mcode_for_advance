# 规划票：`error` 是否该影响「谁来看」，而不是「能不能 build」

> 状态：**建议不做（现在不做）**
> 作者：F 会话 · 2026-10-24
> 起因：总控在 T106 之后提出的第三条路 —— `error` 不影响 build，但影响任务中心里的「需要复核」标记。

---

## 一、结论

**我建议现在不做这条路。** 不是因为它方向错，而是因为**支撑它的数据链根本不存在**，而补那条链的成本被严重低估了。

三条理由，按强度排序：

1. **`build_deck` 的 findings 到不了任务记录。** 中间没有桥，而造这座桥要改的是「回合 → 任务」的建卡判据。
2. **`TaskStatus` 已经是一条「谁有权说话」的边界**，往里塞机器意见会破坏它。
3. **`acceptance` 的语义被写死了是「用户拍板」**，机器意见不能进那个字段。

下面逐条给证据。

---

## 二、数据链现状（这是最关键的一条）

### `build_deck` 的 findings 在哪

```
documentToolCall("build_deck") → DocumentToolCallResult { ok, text, ... }
                                   ↓
                         model 读到 text（T106 的分组正文）
                                   ↓
                              回合结束
```

**findings 只活在 `documentToolCall` 的返回值里。** 它被渲染成给模型看的一段文字，然后就没了 —— 没有被写进任何结构化存储。

### 任务是怎么被建出来的

`apps/desktop/src/main/tasks/autoCreate.ts`：

```ts
// 订阅 turn.done，从 turn.files 提炼产物
const artifacts = artifactsOf(args.files);
const verdict = classifyTurn({ sessionKind: session.kind, reason: args.reason, artifacts });
```

```ts
function artifactsOf(files: TurnFileEntry[]): TaskArtifact[] {
  for (const f of files) {
    const isNew = f.kind === "created";
    const grew = f.kind === "modified" && f.adds - f.dels > 0;
    if (!isNew && !grew) continue;
    out.push({ path: f.filePath, description: ..., createdAt: now });
  }
}
```

**任务记录的输入是 `turn.files` —— 「这一轮改了哪些文件」的文件快照。** `TaskArtifact` 只有三个字段：

```ts
export const TaskArtifactSchema = z.object({
  path: z.string().min(1).max(4096),
  description: z.string().min(1).max(500),
  createdAt: z.number().int().nonnegative(),
}).strict();
```

**没有 `findings`、没有 `severity`、没有 `qa`。**

### 两条链之间没有桥

`build_deck` 的 findings 在 **工具调用** 这一层；任务的产物在 **回合结束的文件快照** 那一层。

**从 `turn.files` 看不出「这个 .pptx 是 build_deck 造的、它带了 3 个 error」** —— 它只知道「这个文件被创建了」。

### 造这座桥要改什么

最小可行方案是：**在 `build_deck` 的调用点把 findings 挂到某个进程级的地方，让 `turn.done` 时能读到**。这意味着：

- 要么给 `TurnFileEntry` 加字段（**改 `@contracts/runtime`，跨三个 provider**）；
- 要么在 `documentToolRuntime` 里维护一份「本回合的 QA 结果」暂存，再由 `autoCreate` 读（**新引入一个跨模块的时序耦合**）；
- 要么给 `TaskArtifact` 加 `qa` 字段（**改任务契约 + 迁移**）。

**三条都要动契约层。** 而 `TaskArtifact` 加字段会牵动 `TaskSchema`、`TaskRepo`、任务中心 UI、以及已有的套件。

**这不是「标记一下」的成本，是「造一条新的跨层数据通道」的成本。**

---

## 三、`TaskStatus` 已经是一条边界，不该塞机器意见

`packages/contracts/src/ipc/task.ts:78-86`：

```ts
/**
 * **执行方可以写的状态** —— 不含 `accepted` / `rejected`。
 *
 * 这不是文档，是一个**可被断言的集合**：`task.transition` 会拒绝不在这个集合里的
 * 目标状态，于是「AI 自己把任务标成已验收」在代码层就走不通。
 */
export const TASK_EXECUTOR_STATUSES: readonly TaskStatus[] = [
  "pending", "running", "blocked", "done", "failed",
] as const;
```

**这条边界的存在理由，和总控提的「机器认为有问题」在同一个位置。**

「`error` 计数影响任务状态」有两种可能：

| 做法 | 后果 |
|---|---|
| 新增状态 `needs_review` | 破坏七态设计；且**机器写状态**，与 `TASK_EXECUTOR_STATUSES` 的禁令同型 |
| 让 `done` 变得有歧义（带 error 的 done） | `done` 不再是「执行方说完成了」，而是「执行方完成了但机器不同意」—— 一个状态两个含义 |

**而 `TaskCenterPanel.tsx:60` 明确写着：**

> `done` 与 `accepted` 的文案**必须能一眼分开** —— 这是 T99 在数据模型上刻意保留的区别，界面如果都写成「完成」，那层区分就白做了。

**加一个机器意见进去，等于把那层区分弄浑。**

---

## 四、`acceptance` 不能装机器意见

```ts
export const TaskAcceptanceSchema = z.object({
  round: z.number().int().positive(),
  decidedAt: z.number().int().nonnegative(),
  /** 判定的理由 —— 用户写的话，或系统给出的证据摘要。**必填**，不许空着说「通过」。 */
  evidence: z.string().min(1).max(4000),
}).strict();
```

**注释里那句「用户写的话，或系统给出的证据摘要」是有歧义的** —— 「系统给出的证据摘要」听起来像机器也能填。

**但整个字段在 UI 上的用途是「用户验收」（`ACCEPTABLE = ["done"]` + 验收按钮）。** 机器写进去就等于「机器替用户拍了板」，而 `TASK_EXECUTOR_STATUSES` 的注释说得很清楚：**AI 自己把任务标成已验收，在代码层就走不通。**

---

## 五、**如果**要做，正确的做法是什么

如果不是「标记任务」，而是「**让用户在验收时看得见 QA 结论**」，那么落点不是 `TaskStatus`，是 **`TaskArtifact.description`**：

```ts
out.push({
  path: f.filePath,
  description: isNew ? `新建文件（+${f.adds} 行）` : `扩充内容（+${f.adds} / −${f.dels} 行）`,
  createdAt: now,
});
```

`description` 是**人话说明**，字符串，可以写「这个 .pptx 有 3 项设计规范问题」。**零契约改动。**

**但它仍然需要那座桥** —— 得知道「这个文件是 build_deck 造的、它带几个 error」。所以这条路省掉的是契约改动，省不掉数据通道。

---

## 六、我认为**现在不该做**的真正理由

不是成本。是**顺序**。

1. **今天一天里，7 条判据中 3 条出过问题。** 在判据本身还不够可信的时候，把它的结论**升级成用户可见的标记**，等于把不可靠的信号放大到产品面上。
2. **`error` 现在只有 `palette.rainbow` 一条**（`deckPatternCheck.ts` 里 `level: "error"` 只出现在那里）。**用一条判据的结论驱动整个任务的复核标记，样本量是一。**
3. **用户目前根本看不到「这个 deck 有设计问题」这件事。** 加标记的前提是用户会看、会据此行动 —— 而这件事**没有任何证据**。T106 的回写里那句：「用户的实际观感我依然验不了」。

**先让判据可信（多几条像 `palette.rainbow` 那样有实测依据的），再考虑让它的结论影响流程。反过来做，是在用不可靠的信号改变用户看到的东西。**

---

## 七、如果总控坚持要做，最小落地路径

按风险和成本排序，建议先做最左：

| # | 做法 | 契约改动 | 数据通道 | 我的评估 |
|---|---|---|---|---|
| 1 | **什么都不做，先观察** | 无 | 无 | **推荐** |
| 2 | 把 findings 写进 `TaskArtifact.description` | 无（字符串） | **要造** | 次优，但前提是桥存在 |
| 3 | 给 `TaskArtifact` 加 `qa` 结构化字段 | 要 | 要造 | 成本最高，收益不明 |
| 4 | 新增 `needs_review` 状态 | 要 | 要造 | **不建议**，破坏七态与执行方边界 |

**无论选哪条（除 1），第一件事都是造那座桥** —— 而桥的成本被低估了。

---

## 八、我可能错在哪（已查证，结论不变）

**我一开始担心「可能有别的建任务路径本来就带着工具调用的上下文」。查过了，没有。**

全仓只有 **两条** 写 `tasks` 表的路径：

| 路径 | 位置 | 它知道什么 |
|---|---|---|
| **自动创建**（回合结束） | `tasks/autoCreate.ts:169` `TaskRepo.create(...)` | 只知道 `turn.files` 的文件快照 |
| **用户显式建**（IPC） | `ipc/task.ts:146` `TaskRepo.create(...)` | 只知道 `goal` / `origin` / `dependsOn` |

第二条的注释写得很明确：

```ts
/** 建任务 —— 只给主进程内部用（谁发起、发起时用哪个 id 由宿主决定）。 */
ipc.handle(IPC.TASK_CREATE, (_evt, raw) => { ... })
```

**两条都不经过工具调用栈。** 所以第二节的结论成立：**桥确实不存在，而且不存在「现成的桥」。**

唯一还能推翻我的情况是：**将来某条新路径（Agent 认领任务 / 工作流建任务）从工具上下文出发** —— 那时桥是天然的，这条路会变得便宜。但那不是现在的状态。

---

# 附录（2026-10-24）：`level` 的分级到底有没有人分过

> 总控追问：**「`level: "error"` 全仓只出现一次」是真的只有一条判据够格，还是别的判据本该是 error 却被写成了 warning？**
> 如果后者，「样本量是一」就不是「判据少」，是「分级没人用」。

## 结论：**分过，而且标准一致。是我的「样本量是一」这个说法误导了。**

## 一、全仓分布

```
accent-bar.vertical   warning
accent-bar.top        warning
palette.rainbow       error     ← 唯一一条
layout.card-whitespace warning
layout.whitespace     warning
layout.repeated       warning
cover.flat            warning
header.bar            warning
```

7 条判据，1 条 error。

## 二、分级标准是明确写下来的

`accent-bar.vertical` 的注释（这段是整套判级的总纲）：

```ts
// ⚠️ warning 不是 error：判据本身（w<24 且 h≥64）能命中真实色条，但**阈值是拍的** ——
// 规范原文只说「thin vertical accent bar on the left of every card / a colored bar on
// top of cards / a small bar left of titles」，没给像素。7 条判据里只有
// `palette.rainbow` 有规范原文（"Never more than the two accents"），其余全是经验阈值。
// 拍的阈值不该以 error 身份打断模型。
level: "warning",
```

`cover.flat` 的注释把它说得更直白：

```ts
// ⚠️ warning：判据（面积 ≥12% 的锚点）是经验值，规范只说「give it a visual anchor」，
// 没定义多大算锚点。只有 `palette.rainbow` 有规范原文，保持 error。
```

**分级判准：规范原文有没有给出具体数值。**

| 判据 | 规范原文给了数值吗 | level |
|---|---|---|
| `palette.rainbow` | **有**（"Never more than the two accents" → 2） | **error** |
| `accent-bar.*` | 无（只说 "thin"） | warning |
| `cover.flat` | 无（只说 "a visual anchor"） | warning |
| `layout.*` | 无（参考线） | warning |
| `header.bar` | 无 | warning |

**7 条全部符合这个判准，没有一条是「本该 error 却写成 warning」。**

## 三、但这里有一个真问题：**两套概念用了近似的中文词**

注释里同时出现两种说法：

| 说法 | 它实际描述的是 |
|---|---|
| 「**强判据** / **弱判据**」 | **判据本身可不可靠**（形状特征确定不确定） |
| `level: "error"` / `"warning"` | **阈值有没有规范依据** |

于是会出现读起来自相矛盾的段落：

```ts
/**
 * 【判据 5】…
 * **强判据。** 「视觉锚点」= 面积 ≥ 画布 12% 的元素…
 */
...
// ⚠️ warning：判据（面积 ≥12% 的锚点）是经验值…
level: "warning",
```

**「强判据」+ `warning` 并列** —— 两个词各自都对，但读者会以为矛盾。

实测量化（注释文本 vs 实际 level）：

| 判据 | 注释声明 | 实际 level |
|---|---|---|
| `accent-bar.vertical` | 强判据 | warning |
| `palette.rainbow` | 强判据 | error |
| `layout.repeated` | 弱判据 | warning |
| `cover.flat` | 强判据 | warning |
| `header.bar` | 强判据 | warning |

**5 条声明了强度的判断里，3 条是「强判据 → warning」。** 每一个都有理由，但**术语撞车让它们看起来像错误**。

## 四、这对「样本量是一」的修正

我原先说「error 只有一条，样本量是一」。**准确的说法是**：

- **只有一条判据的阈值来自规范原文**，所以只有一条配得上 `error`；
- **不是没人分过级**，是**能被规范原文背书的判据只有一条**。

**这个区别很重要**：前者暗示「分级机制空转」，后者说明「分级机制正常工作，只是证据充足的就一条」。

**所以那条规划票的结论要按新表述修**：不是「样本量是一」让人不敢传信号，是**「有规范原文背书的判据只有一条」—— 而这一条的结论，确实不足以驱动整个任务的复核标记。**

## 五、建议（不改代码）

**把「强/弱判据」这个说法改掉，或者把 `level` 的判准写进文件头。**

现在 `level` 的判准散落在 `accent-bar.vertical` 和 `cover.flat` 的注释里 —— **只读第 5 条判据的人看不到「只有有规范原文才是 error」这条总纲。**

**最小改法**：在文件头的类型注释（`PatternFinding` 的 `level` 字段）上加三行，把「只有规范原文给出数值才够 error」写死在那里。**零行为改动，只改文档位置。**

**不建议**把 `accent-bar` / `cover.flat` 提升成 `error` —— 它们的理由（阈值是拍的）成立，提升反而让「error」失去含义。

## 六、我可能错在哪

**我只看了 `deckPatternCheck.ts`。** 六编辑器门禁那边（`docs check` / `sheet check`）的 `level` 来自上游 CLI，分级标准不在我们手里 —— 那一边的 `error` / `warning` 分布是另一回事，**我没有查**。

如果总控关心的是「整个判据体系的 error 比例」，那要把上游那 18 项也算进来。
