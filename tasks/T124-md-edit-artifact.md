# T124｜`document_md_edit` 的产物同样不进任务中心

- Status: ready-for-agent
- Category: **P0 核心闭环（T123 的同病）**
- Priority: **P1** —— 影响面比 T123 小（md 文件通常也走 `Write`），但同一种缺陷
- Depends on: T123（`e3fc94bc`）
- Exclusive writable files:
  - `apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts`（只改 `CREATE_DOCUMENT_TOOLS` 与相关分支）
  - `apps/desktop/scripts/t123-office-artifact-smoke/main.ts`（延伸，不要新建套件）
- **不新建卡目录**：延伸 T123 的套件。

## Required Skills
- `mcode-smoke`：变异验证。

---

## 零、开工前先核：这个洞还在吗

```bash
git status --porcelain apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts
grep -n "CREATE_DOCUMENT_TOOLS" apps/desktop/src/main/providers/claude-sdk/SdkMessageAdapter.ts
grep -rn "document_md_edit" apps/desktop/src/main/document/*.ts | head -5
```

**写卡时（2026-10-24 15:25，基于 H 的报告）**：T123 已落地，`document_md_edit` **未**处理。

> ⚠️ **这条结论来自 H 的报告，我没有独立核实 `document_md_edit` 的具体行为。** 执行前先自己跑一遍下面第二节的探针，**别信这张卡的描述**。

---

## 一、缺陷

`document_md_edit` 写 Markdown 文件，不走 `Write`/`Edit`，因此：

- 不在 `FILE_MUTATING_TOOLS`（正确 —— 理由与 T123 相同）；
- **也不在 T123 新加的 `CREATE_DOCUMENT_TOOLS` 里**，所以它写出的 `.md` 不进 `turn.files`；
- `classifyTurn` 看到空 artifacts → 「这一轮没有产出文件，是问答不是任务」。

**后果**：用户说「帮我改一下 README 的安装步骤」，Agent 真的改了，任务中心看不到。

## 二、先量：这个洞比 T123 大还是小

**`document_md_edit` 有两种可能的实现**，决定修法完全不同：

| 实现 | 判断方法 | 后果 |
|---|---|---|
| **A. 它接受一个「目标文件」路径并写盘** | 探针调用后检查磁盘变化 | 和 T123 一样，`filePath` 是输出 |
| **B. 它只接受「已存在的文件」并原地改** | 同上 | **`filePath` 是输入也是输出**，快照会记录一次「相对 turn 前」的修改 —— 这是**正确的**，因为 rewind 需要它 |

**所以第一件事是写探针判断它是 A 还是 B。** 用真 `FileSnapshot` + 真 `documentToolCall`：

```js
// .tmp/t124-probe.mjs 的思路
// 1. 造一个临时工作区 + 一个 README.md
// 2. snapshot.recordPre(cwd, readmePath)   // 模拟 turn 前
// 3. 调 documentToolCall({ tool: "document_md_edit", filePath: readmePath, input: {...} })
// 4. snapshot.freeze() → 看 kind / adds / dels 是否合理
```

**判据**：`kind` 应该是 `"modified"`（不是 `"created"`），`adds`/`dels` 反映真实改动量。

**如果 `before` 是空串而实际文件非空** —— 说明 `recordPre` 没读到，或者路径对不上。

## 三、修法

**只在探针证明它是 A 或 B 之后决定。** 两种可能：

**如果是 B（原地改已存在的文件）**：

```ts
// SdkMessageAdapter.ts 的 recordPre 分支
if (FILE_MUTATING_TOOLS.has(b.name) || CREATE_DOCUMENT_TOOLS.has(b.name)) { ... }
```
**加进同一个 `if`** —— 因为语义相同（`filePath` 既是输入也是输出）。

**如果是 A（写新文件）**：

**同样加进 `CREATE_DOCUMENT_TOOLS`**，但要注意 T123 那条约束：

> 只记录 create 路线的工具：它们的 `filePath` 是输出路径。apply/read 工具携带的是用户已打开的文档，快照会报告一次从未发生的写入。

**所以关键是「它到底写不写盘」，不是「它叫什么」。**

## 四、验收判据

1. **探针证明它是 A 还是 B**（结论 + 证据写进回写）。
2. **`turn.files` 非空**，且 `kind` 与 §二 的结论一致（B → `modified`，A → `created`）。
3. **`classifyTurn` 从 `create:false` 变 `create:true`**（两段输出都贴）。
4. **`Write` / `document_tool_call` 的既有行为零变化** —— `t123-office-artifact-smoke` 13/13、`t100` 106/106、`auto-create` 38/38 全绿。
5. **不把 `document_md_edit` 加进 `FILE_MUTATING_TOOLS`** —— 理由同 T123（路径围栏 + rewind 假设 + 多文件）。

## 五、变异（先写预期，**正控与负控分开列**）

> **这一节的形式来自 T123 的教训**：H 把负控算进了正控的预期数，导致「预期 5 实际 4」看起来像判据弱。

| 变异 | 正控（该红） | 负控（该绿） |
|---|---|---|
| 去掉 `document_md_edit` 的记录 | 2（①②④ 里相关的） | 1 |
| 把它加进 `FILE_MUTATING_TOOLS` | **1**（「不在那个集合里」那条） | — |
| 只记录 `document_md_edit` 但用错字段名（`file_path` 而非 `filePath`） | 2 | — |

**第三行是这张卡的判据核心** —— 它模拟 H 第一版那个真实错误（`b.name` 恒不等，条件恒假）。

## 六、顺带：给 `CREATE_DOCUMENT_TOOLS` 补一句注释

H 报了一条已知的账：

> `CREATE_DOCUMENT_TOOLS` 与 `CLI_TOOL_MAP` 两处真相。provider 层不 import document 层是我刻意保持的边界，代价是手工同步。套件能抓「漏了导致不进任务中心」，**抓不住「上游新增了一个 create 工具」**。

**在这张卡里补上**（H 可能已经补了，先看）：

```ts
/** ⚠️ 这份清单与 document 层的 CLI_TOOL_MAP 手工同步 —— provider 层不 import
 *  document 层是刻意的边界。上游新增 create 工具时这里不会自动知道，
 *  而症状是「该工具的产物不进任务中心」，不是报错。见 T123 / T124。 */
```

## 七、回写

`tasks/T124-md-edit-artifact.md` 末尾追加：

1. **探针结论**（A 还是 B）+ 证据
2. 修完前后的 `classifyTurn` 输出（两段）
3. 套件数字、**变异（正控/负控分开）**、提交 SHA
4. **你觉得不对但没改的地方**

---

## 结果回写（2026-10-24）

> 执行会话 **H**。**本卡没有改任何产品代码。**
>
> 探针结论推翻了三处卡面前提，而剩下的一处让「照卡修」变成一件**会引入更严重缺陷**的事。
> 卡上第零节写了「如果它根本不存在、或者它的行为与描述无关，卡的前提就废了，回写里写清即可 ——
> 那也算合格交付」。**这一节就是那个交付。**

### 一、★ 探针结论：`document_md_edit` 不是编辑 `.md`，是**用 Markdown 编辑 Word**

卡、以及我上一轮 T97 的表述「Markdown 编辑的产物」，都暗示它改的是 `.md` 文件。
**实测不是。** 工具描述原文（`appControl/tools.ts:1458`）：

> 「用 Markdown 编辑 Word：insert（在 afterBlock 之后插入，-1 = 文首）、append（文末续写）、
> replace（替换块区间）、delete（删除块区间）。Markdown 片段经 CLI 转 restricted HTML
> 后交给 docs apply；默认记成 Word 修订（可逐条接受/拒绝）。」

实现也是 `docsApply(ports, args.filePath, ops, …)`（`documentToolRuntime.ts:1293`）——
**它的目标是 `.docx`，走 docs apply 原地改。**

**第一次探针我用 `.md` 当目标，报 `zip: end of central directory not found`** ——
那个错误本身就是证据：它要的是 zip（docx），不是纯文本。

### 二、★ 三个堵点，逐个实测（这才是「修不了」的实际理由）

**堵点 1：已存在的 `.docx` 进不了 `originals`。**

```
$ node .tmp/t124/blockers.mjs
═══ 堵点 1 ═══
FileSnapshot: skip …\existing.docx (not valid UTF-8, cannot restore losslessly)
  originals: 0  unrestorable: 1
  → 已存在的二进制 .docx: ❌ 进不去
  freeze 结果: 0 条
```

`capturePre` 的 `STRICT_UTF8.decode` 抛错 → 记进 `unrestorable` 并**主动跳过**。
**这是刻意的**，`fileSnapshot.ts:145` 的注释写着：

> A lossy decode would put U+FFFD into `before`, and rewinding would then write that mangled
> text over the user's file — **the undo itself would corrupt it.**

**也就是说：总控在卡上警告的那个风险（`before` 拿错 → rewind 毁文件），代码已经在防它了。**
`document_md_edit` 是「原地改已存在的二进制」，正好落在这条防线的**拒绝侧**。

**堵点 2：绕过它（强行塞进 `originals`）会得到 `before: ""`。**

```
═══ 堵点 2（强制塞进去，模拟绕过）═══
[{"kind":"modified","adds":1,"dels":0,"before":""}]
```

而 `restoreFiles` 对 `kind: "modified"` 执行的是 `atomicReplaceFile(path, entry.before)`
（`fileSnapshot.ts:487`）。**`before: ""` 会把用户的 docx 清空成 0 字节。**
我逐行读了 `restoreFiles:355-400` 的校验，**没有**「`before` 为空但 kind 是 modified」这条防线 ——
`typeof entry.before !== "string"` 只挡类型，挡不住空串。

**堵点 3：即使前两条都解决，`artifactsOf` 仍会把它滤掉。**

`autoCreate.ts:99`：

```ts
const grew = f.kind === "modified" && f.adds - f.dels > 0;
if (!isNew && !grew) continue;
```

而二进制文件的 `adds`/`dels` 来自 `countLineDiff(before, after)`，`before` 是空串时
得到 `adds=1, dels=0`（堵点 2 的输出），**这次能过**；但若 `before` 与 `after` 都是
解不出的二进制，两边都退化成 `""`，得到 `0/0` → 被滤掉。实测：

```
modified, adds=0 dels=0（二进制）  → create=false  (这一轮没有产出文件，是问答不是任务)
```

**三层叠在一起：`document_md_edit` 改的是一份已存在的二进制文件，而整条
「产物 → 任务」的管道是围绕**文本可还原**设计的。**

### 三、为什么我没有按卡上的第三节修

卡上说「两种都要记」，并给出两种写法。**两种都过不了堵点 1** —— 无论用
`CREATE_DOCUMENT_TOOLS` 还是并进 `FILE_MUTATING_TOOLS` 的 `if`，最终都落到
`snapshots.recordPre(...)`，而它对该文件是**主动跳过**。

**唯一能绕过的写法是「不走 `recordPre`，直接往 `originals` 里塞一条 `before: ""`」** ——
那正是堵点 2，**它会让 rewind 清空用户的 Word 文件**。

**所以「照卡修」在这里 = 用「任务中心看不见产物」（P1）换「撤销会毁文件」（P0）。** 我不做这个交换。

### 四、我也不打算只修一半（只让产物进 turn.files、不让它进 rewind）

技术上可行：给 `recordPre` 加一个「记录但不入还原集」的旁路，让 `freeze()` 里
`kind: "modified"` + `before: ""` 的条目**在 rewind 时被明确排除**而不是被当作空文件写回。

**但那要改 `fileSnapshot.ts`，而卡上和 T123 都明令「不许碰它」。**
而且它需要一个新的契约字段（比如 `restorable: false`），`TurnFileEntry` 要改，
渲染端的「撤销本轮」按钮也要跟着变 —— **那是另一张卡，不是本卡的边界。**

### 五、我建议的正确形状（供总控裁）

**根因不是「少记了一个工具」，是「产物管道只认文本」。**

| 方案 | 做法 | 代价 |
|---|---|---|
| **a. 只覆盖新建的 Office 产物**（现状） | T123 已做：`create_document` / `build_deck` 的**新建** `.docx` 能进任务中心 | 已交付 |
| **b. 给 `TurnFileEntry` 加 `restorable`** | 二进制产物进 turn.files 与任务中心，但 rewind 明确跳过 | 改契约 + 渲染端 + `fileSnapshot.ts`，一张独立卡 |
| **c. `document_md_edit` 自己报产物** | 工具返回里带上「我改了哪个文件、多少字节」，由 `autoCreate` 认这条来源 | 绕开 `FileSnapshot`，但要在 `autoCreate` 加第二个产物来源 |

**我倾向 b**（它同时解决「二进制产物看不见」和「二进制文件不该被 rewind」两个真问题），
**但它必须是一张有 `fileSnapshot.ts` 写权限的卡。**

### 六、有没有改产品代码

**没有。** `git status` 里 `SdkMessageAdapter.ts` 的改动全部来自 T123 的两个提交
（`e3fc94bc` / `6a5a5aa9`），本卡一个字没动。探针全在 `.tmp/t124/`。

### 七、这条对「同病同修」的修正

**T123 和 T124 不是同一个病。** 我上一轮报「`document_md_edit` 有同一个病」时，
依据是「它也不写 `FILE_MUTATING_TOOLS`」—— **那个依据是对的，但结论错了**：

- `create_document` 的问题是**路径没被记**（修法：记上）；
- `document_md_edit` 的问题是**它改的文件不可无损还原**（修法：不是记不记，是能不能记）。

**「症状相同、根因不同」—— 这正是「按名字搜是引用数」那一族。我只比了一个属性
（在不在那个集合里），就判定两个东西同病。**

---

### 八、★ 顺带测出来的：T123 也只覆盖了「新建」，没覆盖「修改」

验完堵点之后我想确认一件事：`document_md_edit` 并不是唯一改已存在 docx 的路径 ——
`document_tool_call` + `apply_ops` 也是。**实测它同样漏：**

```
$ node .tmp/t124/t123gap.mjs
document_tool_call + apply_ops 改已存在 docx:
  turn.files = 0 条
  classifyTurn = {"create":false,"failed":false,"why":"这一轮没有产出文件，是问答不是任务"}
```

**原因是同一个：** T123 只把 `create_document` / `build_deck` 放进了
`CREATE_DOCUMENT_TOOLS`，而 **`apply_ops` 不在里面**（`apply` 类工具的 `filePath`
是用户当前打开的文档，我刻意排除了它 —— 见 T123 §二的注释）。

**那个排除的决定在 T123 的语境下是对的**（记 read 类会把没发生的写报成产物），
**但它把 `apply` 类一起排掉了，而 `apply` 是真写盘。**

**所以「Office 产物能进任务中心」这个说法，当前只对「新建」成立。**
用户说「改一下这份报告」时，`apply_ops` 真的改了那份 .docx，任务中心看不见 ——
**而这正是 334 twips 表格那条问题最常出现的地方（改一份已有的文档）。**

**这不是本卡引入的，是 T123 的覆盖边界，我把它如实报上来。**

修它同样撞堵点 1（已存在的 .docx 是非 UTF-8 → `recordPre` 跳过），
**所以和 §二 是同一个根因，需要同一个解法（方案 b）。**
