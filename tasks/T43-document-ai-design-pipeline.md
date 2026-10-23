# T43｜文档 AI 的「丑」根因：设计流水线没接上，QA 门禁有三个 app 是空的

- Status: ready-for-agent
- Category: **bug（P0 产品能力）**
- Priority: **P0 —— 这是用户抱怨「AI 改 Word/PPT 又烂又丑」的根因**
- Depends on: T24（`ce2913f8`，工具面）、T40（渲染端绑定未接，P0 并行修）
- Exclusive writable files: `apps/desktop/src/main/document/documentToolSurface.ts`（`CLI_TOOL_MAP` / `DOCUMENT_QA_GATES`）、`apps/desktop/src/main/document/genofficeCli.ts`（新增创建/设计流水线）、`apps/desktop/src/main/appControl/tools.ts`（工具描述与门禁）、新建回归套件。

## Required Skills
- `codebase-design`: 判断哪些能力该走 CLI、哪些必须走渲染端。
- `mcode-smoke`: 无头回归 + 变异验证（真起 genoffice CLI 太慢时，断言打在命令构造与门禁判定上）。
- `research`: 上游 `genoffice/skills/genoffice/SKILL.md` 的流水线必须先读懂再动手，不要自己发明。

Read before work: `CLAUDE.md`、`genoffice/skills/genoffice/SKILL.md`（**全文，229 行，尤其是 `## Designing a deck` 与 `## Before you say "done"`**）、`apps/desktop/src/main/document/documentToolSurface.ts`、`apps/desktop/src/main/document/genofficeCli.ts`、`tasks/T24-document-tool-surface-redesign.md` 回写区。

## 用户的抱怨（原话，三个独立维度）

> 「ai 的修改，编辑工具不行，**也不能预览页面效果**，**工具覆盖的不全面**，**读文件也不全面**，让 ai 改 word，改 ppt 这种有格式要求的很烂，而且很丑，简直不能看」

> 「毫无审美可言，应该是本身 ai 就没有这方面的训练，ai 做 html 很出色因为这就是 ai 的训练数据」

## 我查清的现状（这是本卡的起点，不是猜测）

### ✅ 已经有的

| 能力 | 位置 | 状态 |
|---|---|---|
| 出图给模型看 | `tools.ts:1312` `document_render` | **有**，真把 PNG 作为 image 块塞回模型 |
| 编辑后门禁 | `documentToolRuntime.ts` 强制 `docs check` / `sheet check` / `slides audit` | **有** |
| 目录驱动发现 | 139 个工具，`document_apps → tools_list → describe → call` | **有** |
| Markdown 载体 | `document_md_read` / `document_md_edit`（带 `<!-- b3 -->` 锚点） | **有** |

### ❌ 致命缺口（本卡要修的）

#### 缺口一：`DOCUMENT_QA_GATES` 有三个 app 是空数组

```ts
// documentToolSurface.ts:75
export const DOCUMENT_QA_GATES: Readonly<Record<DocumentToolApp, readonly string[]>> = Object.freeze({
  docs: ["check"],
  sheets: ["check"],
  slides: ["audit"],
  pdf: [],        // ← 空
  markdown: [],   // ← 空
  html: [],       // ← 空
});
```

**改完 pdf/markdown/html 之后什么都不检查。** 而这三个 app，用户明确说了要。

#### 缺口二：`CLI_TOOL_MAP` 把「创建」整条路堵死了

```ts
// documentToolSurface.ts:290 附近
slides: {
  read_slide: "read", apply_ops: "apply", edit_chart: "apply", load_guide: "guide",
},
```

**slides 只有 `read` 和 `apply`。** 没有 `create`。

而上游 CLI 明明有：

```bash
genoffice create --type pptx --spec <dir|file> --out <path> [--render] [--audit]
genoffice create --type docx --from <text.md|fragment.html> --out <path>
genoffice create --type xlsx --from <data.csv|table.json> --out <path>
genoffice create --type pdf  --from <document> --out <path>
```

**模型现在没有任何办法通过工具面「新建一个 PPT」。** 只能改已有的。

#### 缺口三：PPT 的设计流水线完全没有接线

上游 SKILL.md 的 `## Designing a deck` 是**唯一能做出好看的 deck 的方法**：

```
guide slides design → style.md + outline.json
  → 每页写 NN.json
  → slides check 每页（exit 1 on errors）
  → create --type pptx --spec
  → render --grid（整份拼版看一眼）
  → slides audit（几何审计：出界/溢出/重叠/变形）
  → 最多两轮修
```

**Mcode 里 `plan_deck` / `generate_deck` 只在 `.generated.ts` 目录里有个名字，`cliRouteFor` 里没有、`CLI_TOOL_MAP` 里没有、`genofficeCli.ts` 里没有对应函数。** 也就是说模型看到目录里有 `plan_deck`，调 `document_tool_describe` 能看到它要什么参数，然后 `document_tool_call` 会回「只能在编辑器里执行」——而编辑器里它也不存在。

**这是最坏的一类：目录承诺了能力，调用时没有。**

#### 缺口四：`createFromFile` 的类型被故意收窄到 `docx | xlsx` —— **PPT 根本造不出来**

```ts
// genofficeCli.ts:532
export async function createFromFile(
  ports: GenofficePorts,
  type: "docx" | "xlsx",          // ← 没有 "pptx"
  ...
): Promise<GenofficeResult> {
  ...
  if (type !== "docx" && type !== "xlsx") return headlessRefused("该 create 类型未通过无头路径审核");
```

**而且这是 T74 有意为之，不是疏忽。** 它上面的注释说得很清楚：

> `Deliberately uses --from only: pptx ops/spec and Markdown images may reference further files that the caller's workspace gate has not approved.`

也就是说：**`--from` 只收单个文件，而 `pptx` 的设计流水线用的是 `--spec <dir>`（一页一个文件），涉及多文件读取，T74 没有为它建立围栏。**

**所以「新建一个好看的 PPT」在 Mcode 里不是「没接」，是「被安全策略挡住了」。** 本卡正是要解决它——**用围栏解决，不是用放开解决。**

### ⚠️ 这条必须做成围栏，不是把 `"pptx"` 加进联合类型

直接把 `type` 放宽会绕过 T74 的整个安全模型。正确做法（任选，要论证）：

- **(A) 目录级围栏**：`--spec <dir>` 时，先把整个目录递归过 `requireWorkspacePath`，逐文件确认都在工作区内，并且**只允许 `.md` / `.json`**（spec 不需要别的类型）。
- **(B) 快照到受控临时目录**：把 spec 目录复制进 `renderTempRoot()` 下的新目录，再对副本调 `create`。源目录只读。
- **(C) 如果 (A)/(B) 都证明不了安全**，就**如实不做**，并在工具描述里写清「Mcode 目前不支持新建 PPT，只能编辑已有 PPT」——**不许假装支持**。

**推荐 (B)**：它同时解决了「spec 里的图片相对路径」问题（`--from` 的注释提到的正是这个），因为副本可以带着图片一起进受控目录。

## 用户的洞察要落进设计里

> 「ai 做 html 很出色因为这就是 ai 的训练数据」

上游 SKILL.md 恰好印证了：**`create --type docx --from fragment.html`**、**`create --type pdf --from <document>`**。也就是说上游早就把「AI 擅长 HTML」这件事变成了入口——让模型写它最擅长的受限 HTML，再由渲染器转成 Office 格式。

**这条路径 Mcode 完全没接。**

## 目标

### 必须做到

1. **补齐三个空的 QA 门禁。** pdf / markdown / html 编辑后要有对应检查。
   - 先查清上游有没有对应的 `check` / `audit` 命令（`genoffice pdf --help`、`guide` 等）。
   - **没有就如实写「无门禁」并说明理由**，不要造一个假门禁——那比空数组更糟。

2. **把「创建」接进工具面。** 至少 `slides` / `docs` / `sheets` 要有 `create` 的 CLI 路由。
   - `create_document` 在目录里存在（docs/sheets/pdf 各有一个），但 `CLI_TOOL_MAP` 里没有它 → 现在调了会走「只能在编辑器里执行」。
   - 新建走 `genoffice create --type X`，这个 CLI 已经存在（`genofficeCli.ts:558` 有 `createFile`）。

3. **把 PPT 设计流水线接上。** 这是「好看」的关键。
   - 最小可行：让模型能 `guide slides design` → 拿到 style/outline 规范 → 写 spec 文件 → `create --type pptx --spec` → `render --grid` → `slides audit`。
   - **不要求**把 `plan_deck` / `generate_deck` 这两个编辑器内工具搬到 CLI（它们依赖编辑器状态）。
   - **要求**：`document_tools_list({app:"slides"})` 里那些**没有 CLI 路由、也不在编辑器里**的工具，要么接上，要么从目录里**标清楚 route**，不能让模型去试。

4. **HTML 入口暴露出来。** `create --type docx --from fragment.html` 与 `create --type pdf --from`。
   - 这是用户洞察「AI 写 HTML 很强」的直接落点。

### 明确不做

- **不改** `documentToolRuntime.ts` 的核心执行逻辑（T24 交付，T40 正在接线）。
- **不改** `documentToolRendererBinding.ts`（T40 的边界）。
- **不动** vendor（`genoffice/`），除非确认 CLI 缺命令——那要另开卡走补丁链。
- **不写新的渲染器**，一律复用 `genoffice` CLI。

## 验收判据

1. **回写区先给出现状复核表**：三个空门禁、缺的 CLI 路由、目录里有名字但没实现的所有工具。**逐条列全**，不要只修我挑出来的。
2. 三个 app 的门禁：要么接上真检查，要么如实标注并说明为什么无检查。
3. **PPT 创建**：`create --type pptx --spec <dir>` 走通，且**必须带围栏**（推荐方案 B：快照进受控临时目录）。**不许把 `"pptx"` 直接加进联合类型了事** —— 那会绕过 T74 的整个安全模型。
   - 如果最终判定做不了，**如实不做**并在工具描述里写清；那是可接受的交付，假装支持不是。
4. **PPT 设计流水线**：给出模型能走通的具体命令序列（写进工具描述或 guide），并有断言确认这条路可达。
5. **docx / xlsx 的创建**：`createFromFile` 已经支持但 `CLI_TOOL_MAP` 没接 —— 把它们接上，让 `document_tool_call({tool:"create_document"})` 真能造出新文件。
6. **HTML 入口**：`create --type docx --from fragment.html` 可达（用户洞察「AI 写 HTML 很强」的落点）。
7. 目录里**不存在**「有名字、无路由、无实现」的工具——或者它们被显式标成 `route: "editor-only"` 且描述里说清。
8. 变异验证：撤掉关键接线 → 断言变红 → `cmp` 还原。
9. T24 的套件不回归；双包 typecheck 通过。

## 边界

- **不碰** `ipc/index.ts`（A 的 T29 + T40 在这里）。
- **不碰** `ModuleContributions.tsx`（T41）。
- **不碰** `electron-u1/`、`t7-genoffice-u1/`（E 的 T42）。
- **不改** `genoffice/` 上游源码。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**
动手前**必须**先跑 `genoffice guide slides design` / `genoffice guide docs`，看真实命令与参数，不要照 SKILL.md 的散文猜。

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T43-document-ai-design-pipeline.md` 末尾追加 `## 结果回写（2026-10-23）`：现状复核表（全量）、每处修法、`create` 与设计流水线的可达性证据、目录一致性检查结果、变异证据、提交 SHA。
