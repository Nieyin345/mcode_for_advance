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
