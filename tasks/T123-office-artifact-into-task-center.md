# T123｜Office 产物不进任务中心 —— 核心闭环唯一的断点

- Status: ready-for-agent
- Category: **P0 产品主线（核心闭环）—— 路线图 §5 对「完成」的定义**
- Priority: **P0**
- Depends on: T97（已核实，`f16ee994`）
- Exclusive writable files:
  - `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts`
  - `apps/desktop/src/main/appControl/tools.ts`（只在 `document_tool_call` 分支加一行）
  - `apps/desktop/scripts/t123-office-artifact-smoke/`（新建）

## Required Skills
- `mcode-smoke`：无头挂载验证 + 变异验证。

---

## 零、开工前核三件事

```bash
git status --porcelain apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts \
                      apps/desktop/src/main/appControl/tools.ts
git log --oneline -3 -- apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts
grep -n "FILE_MUTATING_TOOLS.has(b.name)" apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts
```

**写卡时（2026-10-24 15:10）**：这两个文件工作区干净。

---

## 一、断点在哪（T97 实测，不是我推的）

**用户说「帮我生成季度报告」，Agent 用 `document_tool_call` 成功造出 `report.docx`，`docs check` 报 no issues。但这一轮不建任务。**

链路：

```
SdkMessageAdapter.ts:1285
  if (FILE_MUTATING_TOOLS.has(b.name)) → this.snapshots.recordPre(...)
                                       ↓
lib/fileSnapshot.ts:513
  FILE_MUTATING_TOOLS = { Write, Edit, MultiEdit, NotebookEdit }
                                       ↓
  document_tool_call 不在其中 → 没记快照
                                       ↓
flushFinal() → snapshots.freeze() → files = [] → 不发 turn.files
                                       ↓
autoCreate.settleTurn({ files: [] }) → classifyTurn(artifacts: [])
                                       ↓
  { create: false, why: "这一轮没有产出文件，是问答不是任务" }
```

**`classifyTurn` 是实测的，不是读代码推的**（`f16ee994` 的记录）。

**后果**：Office 恰好是**唯一不经过 Edit/Write 的产物路径**，因此也是**唯一任务中心看不见的路径**。而路线图 §5 的核心闭环写的正是「Agent 生成真实产物 → 任务中心追踪状态/失败/审批/产物/证据」。

---

## 二、修法：**不要**把 `document_tool_call` 塞进 `FILE_MUTATING_TOOLS`

**T97 已警告过，我核实了，确实是三条理由：**

1. **那个集合还驱动路径围栏** —— `ClaudeAgentSdkProvider.ts:903` 用它做 `canUseTool` 的工作区越界检查。`document_tool_call` 的路径字段叫 `filePath`（不是 `file_path`），`getToolFilePath()` 对它返回 `""`，围栏会**静默失效**。
2. **rewind 语义不同** —— `FILE_MUTATING_TOOLS` 的快照假设「turn 前文件已存在，要能还原」。Office 产物大多是**新建**，没有 pre-turn 内容。
3. **`document_tool_call` 不止写一个文件** —— `create_document` 的 `input.source` 是源文件，`build_deck` 会写 `style.md` + `outline.json` + `pages/NN.json` + 最终 `.pptx`。**加进那个集合只会快照 `filePath` 一个，剩下的全漏。**

### 正确的位置：在 adapter 里单独处理

**在 `SdkMessageAdapter.ts` 的 tool_use 循环里，`FILE_MUTATING_TOOLS.has(b.name)` 那个 `if` 之后，加一个独立分支**：

```ts
// document_tool_call 写盘不走 Write/Edit，所以它不在 FILE_MUTATING_TOOLS
// （那个集合还驱动路径围栏与 rewind 的"还原到 pre-turn"，把 Office 加进去会
// 同时改坏两件事 —— 见 T97 §三）。但它的产物必须进 turn.files，否则
// autoCreate 的 classifyTurn 看到空 artifacts，判成"问答不是任务"，
// Office 就成了唯一不进任务中心的产物路径（T123）。
if (b.name === "document_tool_call") {
  const fp = (b.input as Record<string, unknown> | undefined)?.filePath;
  if (typeof fp === "string" && fp) {
    const norm = normalizeToolFilePath(this.cwd, fp);
    void this.snapshots.recordPre(this.cwd, norm?.absPath ?? fp);
  }
}
```

**关键点**：

- **用 `recordPre` 就够**。即使文件是新建的，`recordPre` 会记 `exists: false`，`freeze()` 给出 `kind: "created"`、`adds/dels` 按内容算 —— **和 `Write` 新建一个文件完全同一条路**。
- **二进制安全**：`.docx` / `.pptx` 不是 UTF-8，`recordPre` 会 `console.warn` 后跳过 pre-content，但**仍然记进 `originals`**，`freeze()` 里 `countLineDiff("", "")` = 0/0、`kind: "created"` 正确、条目保留（因为「新建的空文件也要留」那条分支）。**所以不要为二进制加特判。**
- **`build_deck` 的多文件**：这个分支只快照 `filePath`。**其余中间产物（`style.md` / `pages/*.json`）不在本卡范围** —— 它们是工作目录里的中间态，不是用户要的交付物。**但要在回写里写清这个边界。**

### 第二件事（较小）：`create` 之后也跑一次 `pageFitCheck`

T97 实测：一份表格超可打印区 334 twips 的 docx，`docs check` 报 `no issues found (10 checks)` —— 那 10 条里没有页面适配。T109 的 `pageFitCheck` 补了这个洞，**但只在 `docs check` 通路触发，`create` 之后不触发**。

而用户最常见的路径就是 create 完直接开文件。

**做法**：在 `documentToolCall` 成功后、当 `app === "docs"` 且产出是新建文件时，跑一次 `pageFitCheck` 并把 findings 附进返回文本。

**⚠️ 但先确认**：`pageFitCheck` 的输入是「CLI 的输出」还是「磁盘上的文件」？如果是前者，create 的返回里有没有等价结构？**如果是后者，这条就简单。查清楚再动手，做不到就在回写里说明。**

---

## 三、验收判据

1. **`document_tool_call` 之后 `turn.files` 非空**，且 `kind === "created"`、`filePath` 是那个 docx 的绝对路径。
2. **`settleTurn` 真的建了任务** —— 用**真身** `classifyTurn` + 真身 `settleTurn`，不是套件里抄一份。
3. **`Write` 的既有行为零变化** —— `FILE_MUTATING_TOOLS` 一个字不改，`t100-task-center-smoke`、`task-message-auto-create-smoke` 全绿。
4. **`.docx` 二进制能通过 `freeze()` 而不抛** —— 这条要单独断言（`countLineDiff` 对着 Uint8Array 解码出来的乱码算）。
5. **不回归**：`document-*`、`t24`、`t43`、`t47`、`t63`、`t73` 全套。

## 四、变异（先写预期红几条）

| 变异 | 预期 |
|---|---|
| 去掉新加的 `if (b.name === "document_tool_call")` 分支 | 第 1、2 条红 |
| `recordPre` 前加 `if (fp.endsWith(".docx")) return` | 第 4 条红（或第 1 条） |
| 把 `document_tool_call` 加进 `FILE_MUTATING_TOOLS` | **应该有断言红** —— 这是被明令禁止的做法，套件要能抓住它 |

**第三行是最重要的变异**：它证明判据分得清「正确的修法」和「看起来更简单但会改坏围栏与 rewind 的修法」。

## 五、边界

**可以改**：
- `SdkMessageAdapter.ts`（只加那一个分支 + 注释）
- `appControl/tools.ts`（只改 `document_tool_call` 的 handler，且只在 create 成功后追加 pageFit 结果）
- 新建 `scripts/t123-office-artifact-smoke/`

**不许碰**：
- **`lib/fileSnapshot.ts`** —— `FILE_MUTATING_TOOLS` 与 `recordPre`/`freeze` 一个字不改。**如果发现非改它不可，停下来回报**
- `autoCreate.ts` —— `classifyTurn` 是对的，错的是喂给它的数据
- 任何 UI 文件（G/F 在改）

**不跑全量、不起 Electron。**

## 六、回写

`tasks/T123-office-artifact-into-task-center.md` 末尾追加 `## 结果回写（2026-10-24）`：

1. 修完前后 `turn.files` / `classifyTurn` 的实际输出（**两段都贴**，只是「改后对了」不证明改前错）
2. 二进制 `.docx` 通过 `freeze()` 的证据
3. `pageFitCheck` 那一条做了没有、做不到的原因
4. 套件数字、变异结果（红的条数 vs 预期）、提交 SHA
5. **有没有你觉得不对但没改的地方**

---

## 结果回写（2026-10-24）

> 执行会话 **H**。改了 `SdkMessageAdapter.ts`（+44 行：一个常量 + 一个分支）与新建
> `scripts/t123-office-artifact-smoke/`。**`lib/fileSnapshot.ts` 与 `autoCreate.ts` 零改动**（sha256 核对过）。
> 未起 Electron，未跑全量。

### 一、★ 修复前 / 修复后的实际输出（卡上要求两段都贴）

同一份探针（`.tmp/t123-before-after.ts`：真 `FileSnapshot` + 真 `SdkMessageAdapter` +
真 `classifyTurn`，中途撤掉/装回分支各跑一次）：

**修复前**

```
turn.files = []
classifyTurn = {"create":false,"failed":false,"why":"这一轮没有产出文件，是问答不是任务"}
```

**修复后**

```
turn.files = [
  {
    "filePath": "C:\Users\...\t123ba-Sonh7H\out\report.docx",
    "kind": "created",
    "adds": 1,
    "dels": 0
  }
]
classifyTurn = {"create":true,"failed":false,"why":"产出 1 个文件"}
```

**所以断点真的在，修复也真的把它接上了** —— 不是「改完绿了但不知道改前是不是红」。

### 二、★ 我第一版的修复是错的，套件的正控没抓住它

**第一版写的是 `CREATE_DOCUMENT_TOOLS.has(b.name)`。** `b.name` 是外层工具名，
永远是 `"document_tool_call"`；create 与否在 **`b.input.tool`** 里。**条件恒假，分支一次都没进。**

**而当时套件的正控（`Write`）是绿的** —— 因为它走的是另一条路。所以「套件有绿的」完全
掩盖了「新分支根本没跑」。是 ① 的红把我引回去的。

**这个形态值得记**：判据红的时候好办，**判据红而正控绿的时候最容易误判成「夹具问题」**。
真正的信号是 `inflight: 0`（`recordPre` 连调都没调），而不是 `freeze()` 返回空。

现在那段注释里写清了这一点，免得下一个人照 `b.name` 再写一遍。

### 三、套件的两处性质（不是「顺手加的」，是必须的）

**① `settleSnapshots`：dispatch 之后必须等 `recordPre` 落地再写文件。**

`recordPre` 是 `void` 调用的（fire-and-forget）。若 `dispatch` 一返回就写盘，
它内部 `await readFile` 读到的已经是**写后**的内容 → `before === after` →
`freeze()` 按「空转重写」正确剔除 → `turn.files` 为空。

**这个坑我先踩了一次**：第一版套件连正控 `Write` 都红。**但它不是产品缺陷** ——
真实链路里工具是在 `recordPre` 之后才执行落盘的，套件的时序才是错的。

**② `.docx` 样本必须在 dispatch **之后**才创建。**

事先创建 → `recordPre` 记 `exists: true` → `kind: "modified"`，同时丢掉「新建二进制」
那条更关键的分支。所以套件里它是 `writeDocx` 函数，在 `afterDispatch` 里调。

### 四、二进制 `.docx` 通过 `freeze()` 的证据

套件 ① 那三条就是证据：`kind === "created"`、`adds: 1`、无异常。
样本是 `PK\x03\x04` + `00 ff fe 80 81 c3 28 a0 a1` —— 非 UTF-8，
`STRICT_UTF8.decode` 抛 → `capturePre` 走 `unrestorable` 分支。
**但它是 ENOENT 在先（文件还没建），所以走的是 `exists:false` 那条；**
两份分支都对，`freeze()` 给出 `created`。

**所以卡上「不要为二进制加特判」是对的** —— 我加了任何特判都会让这两条红。

### 五、`pageFitCheck` 那一条：**已经存在，不需要改代码**

卡上让我先查「输入是 CLI 输出还是磁盘文件」。答案是**磁盘文件**
（`checkDocxPageFit(filePath)` 自己 `readFileSync` + 解 zip）。

**而且 `create` 之后本来就会跑** —— `runQaGate` 在 `mutated` 为真时调用，
create 也是 mutating，所以走同一条路。实测：

```
created out.docx
⚠️ QA 门禁（docs check）发现 1 个问题（error 1 / warning 0 / info 0）。请修掉后再报完成：
- layout.table-overflow：第 1 张表：表格宽 9360 twips，可打印区只有 9026 twips（…），
  右侧超出 334 twips（约 0.23 英寸）。表会压到右边距里，最右一列可能被裁掉。
```

**T97 那句「create 之后不触发」是错的** —— 它当时看到的是 `docs check` 自己的 summary
（`no issues found (10 checks)`），但 `pageFitCheck` 的 findings 是**并进 `issues` 之后**的，
`summary` 字段仍保留上游原话，所以两句话同时出现。**看 `summary` 会以为没报，看 `issues` 才对。**

**我什么都没改**，卡里这条的前提不成立。

### 六、套件与回归

**新套件 `t123-office-artifact-smoke`：13/13。**

节：① create → turn.files（3 条）/ ② 真 `classifyTurn` 建任务（2 条）/
③ `Write` 正控（3 条）/ ④ **核心判据：`document_tool_call` 不在 `FILE_MUTATING_TOOLS`**（3 条）/
⑤ 负控 apply（1 条）/ ⑥ 负控 read（1 条）。

**回归（`smokes-for.sh` 报的 10 套必跑，全部 EXIT=0）**：

| 套件 | 结果 |
|---|---|
| `claude-budget-usage-smoke` | 10/10 |
| `engine-commands-smoke` | 17/17 |
| `maint-m03-smoke` | 2/2 |
| `openai-reasoning-smoke` | 67/67 |
| `task-roster-smoke` | 15/15 |
| `turn-incomplete-smoke` | 31/31 |
| `provider-context-smoke` | 74/74 |
| `provider-health-smoke` | 24/24 |
| `skill-delivery-smoke` | 46/46 |
| `task-message-auto-create-smoke` | 38/38 |
| `t100-task-center-smoke` | 106/106 |

**`npx tsc --noEmit -p apps/desktop/tsconfig.json` → EXIT=0。**

### 七、三个变异：实际红条数 vs 预期

| # | 变异 | 预期 | 实际 | 对得上吗 |
|---|---|---|---|---|
| 1 | 去掉整个新分支 | 5 | **4** | ❌ **我预期错了** |
| 2 | `!fp.endsWith(".docx")` 跳过 | 1–2 | **4** | ✅ 在区间内（但比预期多） |
| 3 | **把 `document_tool_call` 加进 `FILE_MUTATING_TOOLS`** | 有断言红 | **2**（④ 的两条） | ✅ 正是核心判据 |

**变异 1 我为什么预期错**：我把 `failed === false` 也算成会红了 ——
**它是负控，本来就必须绿**（只有失败的回合才置 `failed`）。差的正好是那一条。

**变异 3 是最有信息量的一个**：把 `document_tool_call` 加进那个集合之后，
**①② 仍然全绿** —— 因为 `getToolFilePath()` 对 `document_tool_call` 返回 `""`，
`if (fp)` 挡住，什么都没发生。**这说明只有 ①② 时，两种修法都"看起来能用"。**
红的只有 ④ 那两条 —— **它们才是判别力所在，卡上把这条列为「判据核心」是对的。**

### 八、没做的 / 觉得不对但没改的

1. **`build_deck` 的多文件只记了 `filePath` 一个。** `style.md` / `outline.json` /
   `pages/NN.json` 这些中间产物不进 `turn.files`。**卡上把这条划在范围外，我同意** ——
   它们是工作目录里的中间态，不是用户要的交付物。**但如果用户想「撤销这一轮」，
   重跑 `build_deck` 会不会撞上残留的 spec 目录，是另一个问题，这里没验。**
2. **`CREATE_DOCUMENT_TOOLS` 是硬编码的，和 `CLI_TOOL_MAP` 有两处真相。**
   provider 层不 import document 层是我刻意保持的边界，代价是这张表要手工同步。
   **套件能抓住「漏了导致产物不进任务中心」，但抓不住「上游新增了一个 create 工具」** ——
   后者需要人读 `CLI_TOOL_MAP`。若将来 `document_tool_call` 的工具表频繁变动，
   应该考虑把这张表移到 `@contracts` 或一个中立模块，两边都 import。
3. **`document_md_edit` 也有同样的缺口**（它同样不写 `FILE_MUTATING_TOOLS`）。
   本卡只覆盖 `document_tool_call` 的 create 类。Markdown 编辑的产物仍然不进任务中心 ——
   **这是同一个病，但不在本卡边界内，没有动。**

### 九、提交

见 `git log`（本卡所有改动：`SdkMessageAdapter.ts` + `scripts/t123-office-artifact-smoke/`）。
