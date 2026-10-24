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
