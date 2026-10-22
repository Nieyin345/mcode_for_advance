# T24｜文档 AI 工具面重做：借鉴 docx-cli 的 Markdown-操作模型

- Status: ready-for-agent
- Category: feature
- Priority: **P0 产品核心**
- Depends on: T0（同轮往返已通，`6bd8289e`）
- Exclusive writable files: 新建的文档工具面模块、其 IPC 契约、新建回归套件。逐个确认后写进回写区。**不改** `genoffice/` 上游、`patches/`、`document/docsAiPorts.ts` 与 `nativeEditorToolTransport.ts`（T0 刚交付，需保持）。

## Required Skills
- `codebase-design`: 决定新的工具面该是「包一层 CLI」还是「重写工具定义」，接口要多窄。
- `mcode-smoke`: 建工具面回归，并做变异验证。
- `research`: 需要时可以对照 `genoffice/skills/genoffice/SKILL.md` 与 docx-cli 的公开文档，但**不得直接复制其代码**（许可虽 MIT，但引入运行时依赖要单独决策）。

Read before work: `CLAUDE.md`、`docs/planning/product-roadmap/T13-genoffice-baseline.md`、`genoffice/skills/genoffice/SKILL.md`（229 行，**上游自己写的 AI 操作方法论文档**）、`apps/desktop/src/main/document/genofficeCli.ts`（556 行，Mcode 已有 CLI 调用层）、`apps/desktop/src/main/document/docsAiPorts.ts`。

## 用户明确指出的问题（原话）

> 「ai 的修改，编辑工具不行，也不能预览页面效果，工具覆盖的不全面，读文件也不全面，让 ai 改 word，改 ppt 这种有格式要求的很烂，而且很丑，简直不能看」

> 「整体就是工具的问题……可以去找现有的比如 office cli 之类的借鉴或者是集成」

> 「我的想法是全面，基本 office 能够编辑的能力都要有……就是工具集，用查找来获取工具」

## 已查清的事实

### 事实一：GenOffice 的工具数量被低估了

| 编辑器 | 工具数 |
|---|---|
| PDF | **45** |
| Docs | **38** |
| Sheets | 18 |
| Slides | 18 |
| Markdown | 11 |
| HTML | 8 |
| **合计** | **138** |

T13 说的「PDF/MD/HTML 没有 AI 面板」不等于没有工具定义。

### 事实二：上游自己写了正确的方法论，但 Mcode 没用

`genoffice/skills/genoffice/SKILL.md`（229 行）里有：

- **`## Designing a deck`** —— 分阶段流水线：`style.md` → `outline.json` → 每页一个 `pages/NN.json` → `check` 校验 → `create` → **`render` 出 PNG 自己看** → `audit` 查几何 → 最多两轮修复。
- **`## Before you say "done"`** —— 每个产物三行检查：`audit`/`check` 看 `detail.issues`，`render` 出图**亲眼看**。
- **`## Pitfalls`** —— 14 条实操坑，含「0-based vs 1-based 索引」「EMU 不要自己乘 914400」「结构性编辑会重新编号」「`status:"partial"` 但 exit 0，必须查 status」。

**当前 Mcode 走的是「138 个工具直接注入渲染端」，绕过了这套带 QA 门禁的流水线。**

### 事实三：`docx-cli` 提供了更好的模型，可借鉴

`kklimuk/docx-cli`（MIT，228 star，2026-10-22 更新，TypeScript/Bun）。它的核心主张：

> **standardizing most operations as creating, updating, deleting, or replacing Markdown**
> CLIs like OfficeCLI often force them to compose smaller operations with JSON they often struggle to understand in context.

它的能力面：

| 命令族 | 用途 |
|---|---|
| `read FILE` | 输出**带定位注释的 Markdown**；`--ast` 输出无损 JSON 树 |
| `find FILE "phrase"` | 返回精确 span |
| `insert` / `edit` / `replace` / `delete` | 手术式编辑，只改被要求改的 |
| `track-changes` | 原生 Word tracked changes；`apply --accept rev1 --reject rev0` |
| `comments` | 批注增删改 |
| `tables` / `images` | 表格与图片操作 |
| `diff FILE --against ORIGINAL.docx` | 文本化列出改动 |
| `render` | 页面图（需 Word 或 LibreOffice） |
| `--dry-run` | 预览不保存 |
| `--batch FILE.jsonl` | 批量，定位符按读取时的文档定址 |

**稳定定位符**：`p3`（段落）、`p3:5-20`（段落内字符区间）、`t0:r1c2`（表格单元格）、`c0`（批注）、`rev1`（修订）。这解决了「模型自己数块索引数错」的问题。

### 事实四：Mcode 已有 CLI 调用层

`apps/desktop/src/main/document/genofficeCli.ts`（556 行）已经能调 `genoffice` CLI。`genoffice/packages/cli/bin/genoffice` 与 `dist/genoffice.cjs` 都在。

## 目标

把文档 AI 的工具面从「138 个 JSON 工具直注」改成**可发现 + Markdown 操作 + 带 QA 门禁**的三层模型。

### 必须实现

1. **工具发现（你明确要求的「用查找来获取工具」）**
   - 三级结构，与现有 `app_api_list → describe → call` 同构：
     - `document_apps()` —— 列出可用编辑器（docs/sheets/slides/pdf/markdown/html）
     - `document_tools_list({app, query?})` —— 列出该编辑器的工具
     - `document_tool_describe({tool})` —— 查参数与示例
     - `document_tool_call({tool, input})` —— 执行
   - **138 个工具不再一次性进上下文。**
   - 但**保留少量高频读工具常驻**（每个编辑器 ≤2 个），避免「读一段文字都要查三轮」。建议常驻：Docs `read_blocks`/`get_document_context`、Sheets `read_range`/`get_workbook_context`、Slides `read_slide`、PDF `pdf read`。

2. **操作载体改为 Markdown（借鉴 docx-cli）**
   - 至少对 Docs 实现：`read` 返回带定位符注释的 Markdown；`edit` 接受 Markdown 续写/替换。
   - 对比实验：同一任务用「JSON ops」与「Markdown 操作」各做一次，记录 token 数与成败。**这是本卡的核心证据。**

3. **QA 门禁接入（借鉴上游 SKILL.md 的 `## Before you say "done"`）**
   - 每次编辑后强制跑 `check`/`audit`，把 `detail.issues` 回给模型。
   - **`render` 出图并让模型看**——这是解决「丑」和「没有预览」的关键。
   - 不得跳过。跳过了就等于回到现在的状态。

4. **变更可视（你 Q8 同意的 (a)）**
   - 引入 tracked changes：AI 的每次修改都是可逐条接受/拒绝的修订。
   - `diff --against` 输出文本化改动清单，供 UI 呈现。

### 明确不做

- **不引入 `docx-cli` 作为运行时依赖**。本卡只借鉴其**模型与定位符设计**；若后续决定集成，另开卡评估 Bun 依赖、二进制分发、许可。
- **不改 GenOffice 上游**。通过 Mcode 侧适配层实现。
- **不做 PDF 文本层编辑**（用户 Q11 明确：正常 PDF 编辑能做就行，不用文本层）。

## 验收判据

1. `document_apps()` / `document_tools_list()` / `document_tool_describe()` / `document_tool_call()` 四个方法存在且可用，138 个工具可按 app 与关键词检索到。
2. **上下文体积对比**：改造前一次性注入的工具定义 token 数 vs 改造后（仅常驻工具 + 按需查找）的 token 数。必须显著下降。
3. **Markdown 操作 vs JSON ops 的 A/B**：同一编辑任务两种方式各做一次，记录 token、轮次、是否成功。
4. **QA 门禁**：编辑后 `check`/`audit` 的 `detail.issues` 真的回到模型上下文（有断言）。
5. **`render` 可用**：能出页面图，且模型能在下一轮看到（有断言）。
6. **tracked changes**：AI 的修改可被逐条接受/拒绝。
7. 变异验证：撤掉「编辑后跑 audit」→ 对应断言必须变红；逐字节还原（`cmp`）。
8. 双包 typecheck 通过。
9. **不得**宣称 T7（六编辑器 U1）完成。

## 边界与风险

- 138 个工具里有 40 个（Docs 的联合类型/深度超限）无法进入共享 JSON-Schema 子集，T0 已按 withheld 明示。改造时**不得把它们悄悄丢掉**——要么单独通道，要么明确列出。
- `document_tool_call` 是新开的一条执行通路，**必须复用 T0 的可信渲染端绑定**，不得绕过 sender/session/document/callId 校验。
- 若发现某编辑器的工具质量太差无法改造，**如实列出并建议重写，不要硬凑**。

## 结果回写（2026-10-23）

（执行者在此追加：工具发现 API 设计、138 个工具的分类结果、Markdown vs JSON 的 A/B 数据、QA 门禁接入点、上下文体积对比、变异证据、提交 SHA、哪些工具被判定为不可用）
