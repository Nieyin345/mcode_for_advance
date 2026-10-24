# T97｜核心闭环：从 UI 提任务到真实产物

- Status: ready-for-agent
- Category: **产品主线验收（核心闭环）**
- Priority: **P0 —— 这是路线图 §5 对「完成」的定义**
- Depends on: T43（文档工具）、T94（GUI）、T96（任务对象）
- Exclusive writable files: **只读 + `.tmp/` 探针**。不改产品代码。

## Required Skills
- `mcode-smoke`：真跑 CLI、真生成文件。
- `code-review`：模型视角，不是代码视角。

## 背景

`docs/planning/mcode-product-roadmap.md` §5：

> **核心产品闭环：** 用户从 UI 提出通用任务；Agent 在已授权范围内调用文件/Git/终端/Office/工作流，
> **生成可用的真实产物**；任务中心能追踪状态、失败、审批、产物与证据。

**这条从来没被端到端验过。**

## 任务

### 一、四步端到端（headless，不起 Electron）

1. **发一条消息给 Agent**（主进程层面，`orchestration/` 的入口）
2. **Agent 调用工具**（`document_tool_call` 创建 docx / 或 `file.write`）
3. **产物真的落盘**
4. **事后能查到这次任务**（ID、状态、产物路径）

**每一步用真实的函数调用，不是 mock。**

**哪一步断了，说清断在哪。**

### 二、模型视角：文档工具描述够不够

**这是用户最痛的那条（「AI 改 Word/PPT」）。**

```bash
grep -rn "document_tool_call" apps/desktop/src/main/appControl/tools.ts | head
```

**重点**：
- **模型拿到的工具描述**够不够它做对？还是它得猜？
- `document_guide` 的返回，模型真的会用吗？
- **如果模型做错了，是因为描述不清，还是因为它没读？**

**用 T80 的方法测这条**：**模型视角，不是代码视角**。

### 三、产物质量

**让一个 docx 真的生成出来，然后看**：
- 内容对吗？
- 格式对吗？
- **和用户在 Word 里手写的有区别吗？**

**这一条最重要** —— **用户抱怨的「又烂又丑」如果在这个层面还存在，那今天所有测试修复都没解决它。**

## 验收判据

1. **四步端到端的结果**（每步证据）。
2. **工具描述够不够**的判断（模型视角）。
3. **生成的 docx 实际长什么样**（描述出来，或截图路径）。
4. **「又烂又丑」是否仍存在** —— 如果有，说清是哪一层的问题。
5. **不改产品代码、不起 Electron**。

## 边界

- **可以写 `.tmp/` 探针，可以真跑 CLI，可以真生成文件**；
- **不起 Electron**；
- 不改产品代码。

## 回写

`tasks/T97-core-loop.md` 末尾追加 `## 结果回写（2026-10-24）`：
四步结果、工具描述判断、产物质量、「又烂又丑」是否仍存在、提交 SHA。

## 结果回写（2026-10-24）

> 执行会话（F）。**只读产品代码 + `.tmp/loop/` 探针**，未改任何产品文件，未起 Electron。
> 结论先行：**链路是通的 —— 工具调用 → 受控子进程 → 真 CLI → 文件落盘 → QA 门禁 → 读回，全走通。**
> 但**发消息给 Agent 那一步没能用真模型跑**（下面 §1.1 说明为什么），
> 而且**任务中心与对话之间没有接线**，所以路线图 §5 里「任务中心能追踪状态、失败、审批、产物与证据」
> 这一条**今天还不成立**。

### 0. 方法：用模型的唯一入口，不用内部函数

探针走 `invokeAppTool`（正是 `engineTools.ts` 把 `document_*` 交给引擎的那一层），
不是直接 import `documentToolRuntime`。这样量到的是**模型真正拿到的东西**。

- 模型视角探针：`.tmp/loop/a-toolview.ts` → 输出 `.tmp/loop/describe.json`
- 端到端探针：`.tmp/loop/b-generate.ts` → 输出 `.tmp/loop/b-out.txt`
- 产物拆解：`.tmp/loop/read_docx.mjs`（每个 docx 单独解包目录）

数据根指向 `.tmp/loop/data`（`MCODE_SMOKE_DATA_ROOT`），不碰真实 `mcode.db`。

### 1. 四步端到端

| # | 步骤 | 结果 | 证据 |
|---|---|---|---|
| 1 | 发消息给 Agent | **未用真模型跑**，见 §1.1 | — |
| 2 | Agent 调用 `document_tool_call` | ✅ | `create_document` 经 `invokeAppTool` 真执行 |
| 3 | 产物真的落盘 | ✅ | `report.docx` 3759 bytes，`existsSync` 为真 |
| 4 | 事后能查到这个任务 | **部分**，见 §1.2 | 文件查得到；任务中心查不到 |

#### 1.1 为什么没用真模型跑第一步

模型凭据在宿主 sql.js 库里，探针去读它等于把用户密钥取出来用；卡上也允许 headless。
所以我把**模型能看到的那一面原样取出来**，然后**按它的描述自己当模型走一遍**。
这一步能验的是「描述够不够」（§2），**不能**验「真模型会不会照做」—— 那一点要等真实的
U1 或至少一个注入过固定回复的 provider 夹具，**本卡没做**。

#### 1.2 事后能查到什么

**查得到的**：文件在盘上，`document_md_read` 能读回 8 个块，内容与输入一致。

**查不到的**：这次任务在任何「任务中心」里都没有记录。原因有两层，都是结构性的：

1. **`document_tool_call` 不写任何运行记录。** 全文件 `grep runStore|recordRun|appendRun` 零命中，
   `artifacts` 字段也没人写。它只返回一个 `ToolResult` 文本。
2. **任务表与对话没有接线。** `TaskRepo` / `ipc/task.ts` / `task.*` RPC 是**别人尚未提交的 T99**
   （`git log -- apps/desktop/src/main/ipc/task.ts` 为空，`git status` 显示 `??`）。
   即便它已存在，`grep -rn "task.transition|task.accept|task.reject" apps/...` 除 `ipc/task.ts`
   与 preload 之外**零调用点** —— 没有「发一条消息就建一条任务」的路径。

   顺带一个**名字陷阱**，值得记下来：右栏那个 `TaskListPanel` 不叫 `task.*`。
   它读的是 `terminal.list` + `subagentsBySession` + 工作流 `activeNodes`，
   文案自己写着「正在跑的 / 你开的终端、代理派出去的任务、工作流正在跑的那一步」。
   **它是「正在跑什么」，不是任务中心。** 我用 `grep "task.list"` 时曾把它里面的
   `ide.task.listMore` 文案误判成调用了 `task.list` —— 按名字搜是引用数（CLAUDE.md 第十五条），
   这次亲自踩了一遍。

### 2. 工具描述够不够：**不够，而且缺的正好是关键那一条**

`document_tool_describe({tool:"create_document", app:"docs"})` 返回 4264 字符，逐项核对：

| 模型需要知道的 | 返回里有没有 |
|---|---|
| 这个工具要什么参数（`input.source`） | ❌ 一次都没出现 |
| 源文件必须是受限 HTML fragment（docx） | ❌ 没有 |
| Markdown 会被围栏拒绝 | ❌ 没有 |
| `create --type docx --from X --out Y` 的 CLI 用法 | ❌ 没有 |
| Word 的 `apply` ops 语法（`setFont` / `setParagraphFormat` / …） | ✅ **有，占满 4000 字** |

**根因**：`documentToolRuntime.ts:341-345` 只对 `cliOp === "apply"` 分支取 `guideOps` 的
**op 参数表**；`create_document` 的 `cliOp` 是 `"create"`，落进 `else if` 分支，
于是取的是**整个 docs 域的 guide 前 4000 字** —— 那是 apply 的语法，不是 create 的参数。

**更糟的是 `doc` 字段本身被截断了。** 上游原文是：

> Create a NEW standalone file … **type 'docx' (default) and 'pdf' take the same restricted HTML as insert_content in content**; type 'md' takes Markdown source; …

而模型拿到的是：

> Create a NEW standalone file in the default save folder and open it in a new tab; the current document is not modified. Use when the user asks to put content i…

在 `documentToolCatalog.generated.ts:57` 就被切到 160 字，**恰好切在 `content` 之前**。
所以模型既看不到 `content`（上游真实参数名），也看不到「docx 要 HTML」。

**实测后果**：我按「正常理解」用 `input.source = report.md` 调，被拒：

```
docx create 仅开放原厂 HTML fragment；Markdown 图片路径尚未逐一围栏
```

这个围栏本身**是对的**（`genofficeCli.ts:898-901` 的注释：Markdown 里的图片路径会被上游解析，
可能指到工作区外）。错的是**模型没有任何办法从工具面知道这件事**。
模型唯一能走通的路是「自己把 md 转成 HTML fragment」，而描述里一个字都没提。

改写成 HTML 后一次通过。**所以这条不是「链路坏了」，是「模型得猜，而且猜错一次才知道」。**

### 3. 产物长什么样

同一份内容，两条路径各生成一份（都真跑 CLI）：

| 路径 | 命令 | 结果 |
|---|---|---|
| Markdown（本项目直接调 CLI） | `create --type docx --from report.md` | 3998 bytes，**表格保留** |
| 受限 HTML（Mcode 围栏放行的那条） | `create --type docx --from table.html` | 3994 bytes，**表格保留，表头加粗 + `F2F2F2` 底纹** |
| 受限 HTML（经 `document_tool_call`） | 同上，走 `ModuleHost` 受控子进程 | 3759 bytes，内容一致 |

拆开 `word/document.xml` 逐项看：

**做对的**：
- 标题层级正确：`Heading1` / `Heading2` 用的都是真样式，不是手搓粗体大字；
- 列表是 `ListParagraph` + 独立的 `numbering.xml`；
- 表格是**真表格**：3 列 × 3 行，`tblLayout=fixed`，六条边框齐全，表头有 `w:b`（粗体）
  与 `F2F2F2` 底纹 —— 和 Word 里手写一张表的默认样子基本一致；
- 页面是 A4（11906×16838 twips）+ 四边 1440 twips（1 英寸）边距，标准 Word 版式；
- `styles.xml` 定义了 30 个命名样式（Heading1-6 / Title / Quote / TOC1-9 …），是真的样式表；
- `docs check` 报 **no issues found (10 checks)**。

**做错的，两处，都是可量化的**：

1. **没有中文字体。** `styles.xml` 只有
   `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>`，**`w:eastAsia` 一个都没有**。
   上游 `docx-engine/src/blank.ts:511` 的 `eastAsiaFont` 选项默认不传，注释写着
   「When omitted no `w:eastAsia` is written — like an en-US Word document」。
   后果：中文靠 Word 按脚本回退，实际会落到系统默认中文字体（常见是宋体/等线），
   **和英文 Calibri 混排时字形、字重、行高都不一致**。这就是「看起来不像在 Word 里排的」
   最直接的一条原因。
2. **表格比正文区宽 334 twips（16.7 pt / 0.23 英寸）。** 三列各 3120，合计 9360；
   而 A4 减去左右各 1440 后可用宽是 9026。`generate.ts:2497` 写死了
   `const totalWidth = 9360 // 6.5in content width on US Letter` ——
   **按 US Letter 算的正文宽，却配了 A4 的页面**。表格右侧会顶到页边距里。

**「又烂又丑」还在不在？** 在这两份产物上，**内容和结构不丑**（层级、列表、表格都是真样式），
**丑的是排版细节**：中文没有字体设定、表格超出正文区。这两条都在**上游 CLI 的默认值**里，
不是 Mcode 的接线问题 —— 但也说明**「接上了」不等于「好看」**，用户抱怨的那条仍然成立，
只是现在能明确指出是哪两个数值。

### 4. 顺带纠正我自己的两处错误

- 探针第一版把所有 docx 解包到**同一个** `unzipped/` 目录，第二次读拿到的是上一次的 XML，
  一度让我以为「HTML 路径丢了表格」。实际上丢表格的是我自己写的 HTML —— **我根本没往里面放表**。
  修成每个 docx 独立目录后两份都正常。
- 一度把 `db.ts` 的 esbuild 报错当成产品缺陷，实际是**另一个会话正在写这个文件**
  （mtime 距今 16 秒，模板字符串里的反引号未闭合）。等它写完就正常了 ——
  CLAUDE.md 第九条（跑之前先看 `mtime`）这次救了场。

### 5. 结论

| 问题 | 答案 |
|---|---|
| 工具调用 → 真产物这条链通不通 | **通**。一次审批 → 一次 CLI → 文件落盘 → QA 通过 → 可读回 |
| 模型能不能从工具面知道怎么用 | **不能**。`create_document` 的描述里没有 `source`、没有 HTML 要求、没有 md 被拒的说明；160 字的 `doc` 恰好截断在关键句之前 |
| 产物能不能用 | **内容能用，排版不够**。中文无 `w:eastAsia`；表格比正文宽 334 twips |
| 任务中心能不能追踪 | **不能**。文档工具零运行记录；任务表与对话零接线（且 T99 尚未提交） |

**需要总控裁决的三件事**（本卡不改产品代码）：

1. `document_tool_describe` 对 `create` 路线应当返回什么？现在返回的是 apply 语法。
   最小修法：`create` 分支改取 `guideOps(domain, "create_document")` 或直接把
   `input.source` 的约束写进 `schemaText`。
2. `documentToolCatalog.generated.ts` 的 160 字截断要不要放宽？
   它把上游最关键的一句切掉了，而 `describe` 又没有补回来。
3. 中文 `w:eastAsia` 与 US-Letter 表格宽度是**上游默认值**，要不要在 Mcode 侧覆盖？
   如果要，属于「改上游行为」，得先确认不和原厂渲染器冲突。

---

## 结果回写二（2026-10-24，H）：复核 F 的结论，三条裁决已关闭，剩一个真断点

> 执行会话 **H**。只读 + `.tmp/t97-verify/` 探针。未改产品代码，未起 Electron，未跑全量。
> **F 的回写是 10-24 早些时候的快照，其中三条结论已经被后续的卡改掉了。**
> 本节按当前 HEAD 复核，并给出闭环**剩下唯一**的断点。

### 一、F 的三条裁决：已经全部关闭

| F 说 | 现在 | 证据 |
|---|---|---|
| ① `describe` 对 `create` 返回 apply 语法 | ✅ **已修** | `documentToolRuntime.ts:406` 有 `cliOp === "create"` 分支 → `createRouteHelp()`；提交 `a0363bd1`（T102） |
| ② 160 字截断切掉了关键句 | ✅ **已由 ① 补回** | `createRouteHelp()` 逐 app 写明扩展名与围栏理由（docs 只收 `.html/.htm`、md 被拒的原因） |
| ③ 中文无 `w:eastAsia` | ✅ **上游已自带** | CLI 里 `src/formats/east-asia-font.ts` 的 `defaultEastAsiaFont()`：win32 → `Microsoft YaHei`、darwin → `PingFang SC`、linux → `Noto Sans CJK SC`。**实测产物 `styles.xml` 里有 `w:eastAsia="Microsoft YaHei"`** |
| ③ 表格超宽 334 twips | ⚠️ **生成侧仍是 9360，但已被判定层抓住** | `pageFitCheck.ts`（T109，`9f91f6b1`）；实测报「表格宽 9360，可打印区 9026，超出 334」 |

**所以「又烂又丑」的两个根因现在只剩一个半**：
- 中文无字体 —— **不再成立**（上游按平台注入）；
- 表格超宽 —— **仍然生成**（上游 `generate.ts:2497` 写死 9360），但 Mcode 侧现在**能报出来**（T109）。

### 二、★ 闭环真正的断点：`document_tool_call` 的产物进不了任务

**这是这一节的全部价值。** F 写「任务表与对话零接线」，**那一条已经不成立** ——
`autoCreate.ts` 订阅了 `runtimeManager`，回合结束自动建任务。但那套接线**只认 Edit/Write**。

**链路实测**：

```
main/providers/claude-sdk/SdkMessageAdapter.ts:1288
  if (FILE_MUTATING_TOOLS.has(b.name)) { ... snapshots.recordPre ... }
        ↓
main/lib/fileSnapshot.ts:513
  FILE_MUTATING_TOOLS = { "Write", "Edit", "MultiEdit", "NotebookEdit" }
        ↓  （document_tool_call 不在里面）
turn.files 为空
        ↓
main/tasks/autoCreate.ts  classifyTurn({ artifacts: [] })
  → {"create":false,"why":"这一轮没有产出文件，是问答不是任务"}
```

**实测**（`.tmp/t97-verify/classify.ts`，真身 `classifyTurn`，非副本）：

```
空产物的成功回合 → {"create":false,"failed":false,"why":"这一轮没有产出文件，是问答不是任务"}
有产物的成功回合 → {"create":true,"failed":false,"why":"产出 1 个文件"}
```

**后果**：用户说「帮我生成一份季度报告」，Agent 用 `document_tool_call` **成功造出
`report.docx`**，`document_md_read` 能读回，`docs check` 报 no issues ——
**但这一轮不会被建成任务，docx 不出现在任务中心，也不在 `artifacts` 里。**

路线图 §5 的核心闭环是「用户从 UI 提任务 → Agent 调用 Office 生成真实产物 →
**任务中心能追踪**产物与证据」。**Office 恰好是唯一一条不经过 Edit/Write 的产物路径**，
于是它是唯一一条**任务中心看不见**的路径。

**这不是「文档工具坏了」**，它自己工作得很好。是**产物统计的口径只覆盖了文件编辑类工具**。

### 三、顺带核实的（都不需要改）

- **任务中心面板存在且可用**：`ide/TaskCenterPanel.tsx`，`task.list` / `task.accept` /
  `task.reject` 都在。`t100-task-center-smoke` **106/106 通过**。
- **自动建任务端到端通**：`task-message-auto-create-smoke` **38/38 通过**，含
  「turn.files 到了但还没建（要等 turn.done 收口）」「turn.done 之后任务真的建出来了」。
- **验收/返修状态机在**：`executor.ts:64` 的 `reopenTask`（`rejected → running` 返修），
  且 `accepted`/`rejected` 执行方写不进去（`TASK_EXECUTOR_STATUSES` 挡）。
- **`docs check` 是假门禁**（F 未提，我实测）：对一份表格超 334 twips 的 docx 报
  `no issues found (10 checks)` —— 那 10 条里没有页面适配。**T109 的 `pageFitCheck`
  补的就是这个洞，但它只在 `docs check` 通路触发，`create` 之后不触发。**

### 四、四步端到端（当前 HEAD 重测）

| # | 步骤 | 结果 | 证据 |
|---|---|---|---|
| 1 | 用户发消息 → Agent 收到 | **未用真模型跑**（同 F，无凭据前提） | — |
| 2 | Agent 调 `document_tool_call` | ✅ | 真 CLI `create --type docx` EXIT=0，`blocks: 7` |
| 3 | 产物落盘且可用 | ✅ | `out.docx`，`docs check` → **no issues found (10 checks)** |
| 4 | 任务中心能追踪 | ❌ **断在这里** | 见 §二：`classifyTurn` 判 `create:false` |

**「通」通到什么程度**：**headless 通到第 3 步。第 4 步在 Office 这条路上不通。**
真 UI（Electron U1）没有验，按路线图「E1/headless 只能证明覆盖路径，不等于真实 Electron U1」。

### 五、给下一张卡的两条建议（本卡不改代码）

1. **让 `document_tool_call` 的产物进 `turn.files`**（或让 `autoCreate` 认另一条来源）。
   最小形状：工具执行成功后把 `filePath` 记进本轮产物，走与 `Edit/Write` 同一条路。
   **不要**给 `FILE_MUTATING_TOOLS` 加 `document_tool_call` —— 那个集合还驱动
   **路径围栏**与 **rewind 快照**，`document_tool_call` 的 `filePath` 字段名不同、
   且它的产物是新建文件（没有 pre-turn 内容可快照），加进去会同时改坏两件事。
2. **让 `create` 之后也跑一次 `pageFitCheck`**。现在只有 `docs check` 通路会报超宽，
   而用户最常见的路径是 `create` 完之后就直接开文件 —— 那时表格已经顶到边距里了。

### 六、提交

**无。** 本卡只读，探针全在 `.tmp/t97-verify/`（`table.html` / `out.docx` / `fit.ts` / `classify.ts`）。
