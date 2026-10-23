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

**修法（B 的方案，总控复核成立）**：这三家**上游确实没有 `check` 命令**——`genoffice guide --help` 也只有 `slides|docs|sheets` 三个域，没有 markdown/html 的 guide。

所以不能造假门禁。**但 `render` 可以当真门禁用**，因为上游自己的 help 原文就是这么说的：

> `One PNG per page of a document, as the GenOffice renderer lays it out: the picture an agent looks at to check a Word document, a workbook or a page it just made.`

**「the picture an agent looks at to check」——上游自己把 `render` 定义成检查手段。** 所以这三家的门禁应该是 `render-probe`：真跑 render、真读返回值（页数/尺寸/PNG 非空）。

**但措辞必须诚实**：`render-probe` 检的是**可渲染性**，不是内容质量。回写区要逐条说明为什么这是真检查而不是假门禁。

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

直接把 `type` 放宽会绕过 T74 的整个安全模型。

#### 但上游已经把整条流水线做成了一个命令（总控实测 `create --help`）

```bash
genoffice create --type pptx --spec <file|dir|-> [--outline <file>] --out <path> \
                 [--render <dir>] [--audit] [--force]
```

原文：

- `--spec <file>`: *"a deck spec (pages of px-positioned text, shapes and images on a 1280x720 canvas) built into one slide per page, **or a directory of one-page spec files taken in name order**"*
- `--outline <file>`: *"pptx --spec <dir>: the deck outline the pages were written from (default: outline.json in or beside the directory); **every page file is checked against its entry and the build refuses to run until every outline page has its file**"*
- `--render <dir>`: *"after writing, render one PNG per slide into <dir> ... starts a hidden GenOffice process for a few seconds"*
- `--audit`: *"run the geometry audit on the written deck and report it under detail.audit"*

**一条命令 = 设计校验 + 构建 + 出图 + 几何审计。** 这不是「我们拼出来的流水线」，是上游产品自带的。

**所以方案 B 的价值比我原先估计的高得多**：把 spec 目录快照进受控临时目录，一次调用就能拿到完整成果（deck + PNG + audit），模型拿 PNG 一看就知道丑不丑、audit 一跑就知道有没有出界重叠。

**这是用户「又烂又丑」这条抱怨最直接的解法。**

#### 三个方案（任选，要论证）

- **(A) 目录级围栏**：`--spec <dir>` 时，先把整个目录递归过 `requireWorkspacePath`，逐文件确认都在工作区内，并且**只允许 `.md` / `.json` / 图片**。
- **(B) 快照到受控临时目录**（**推荐**）：把 spec 目录复制进 `renderTempRoot()` 下的新目录，再对副本调 `create`。源目录只读。
  - **同时解决** `--from` 注释里提到的「Markdown 图片相对路径」问题——副本可以带着图片一起进受控目录。
- **(C) 如果 (A)/(B) 都证明不了安全**，**如实不做**，并在工具描述里写清「Mcode 目前不支持新建 PPT，只能编辑已有 PPT」。**不许假装支持。**

#### 缺口五：`document_md_read` 只能读 docx —— 这是「读文件也不全面」的直接原因

```ts
// documentToolRuntime.ts:465
export async function documentMarkdownRead(ports, args) {
  const read = await docsRead(ports, args.filePath, { full: true, ... });   // ← 只走 docs read
```

`docsRead` 在 `genofficeCli.ts:261`，它构造的是 `["docs", "read", file, "--json"]`。**`docs read` 是 Word 专属命令。**

也就是说：

| 文件类型 | `document_md_read` 能读吗 |
|---|---|
| `.docx` | ✅ |
| `.md` | ❌ |
| `.html` | ❌ |
| `.txt` / `.csv` / 源码 | ❌ |
| `.xlsx` | ❌ |
| `.pptx` | ❌ |
| `.pdf` | ❌ |

**而 CLI 明明有对应命令**：`convert --to md`（任意格式 → Markdown）、`pdf read`、`sheet read`、`slides read`、`docs read`。

并且 `document_apps` 的描述里写着「工具总数 139」「CLI 能承载的工具名」——模型会以为读文件是通的。

**这是用户「读文件也不全面」的直接落点。** 修法：`documentMarkdownRead` 按扩展名分派，**但不是走 `convert`**（见下）。

#### ⚠️ 缺口五的修法更正（B 实测，总控复核成立）

我原来在卡里写「按扩展名分派到 `convert --to md`」，**这是错的**。真跑 `genoffice convert --help`：

```
--to <format>   target format: pdf→docx/pptx/xlsx/md/html, csv→xlsx/pdf, xls→xlsx/pdf,
                xlsb→xlsx, ods→xlsx, ots→xlsx, odt→docx, ott→docx, odp→pptx, otp→pptx,
                md→docx/html/pdf, markdown→docx/html/pdf, docx→md/pdf/html, xlsx→csv/pdf,
                xlsm→csv/pdf, pptx→pdf, html→pdf/docx, htm→pdf/docx
```

**没有 `md→md`，也没有 `html→md`。** 所以：

| 输入 | 正确的读法 |
|---|---|
| `.docx` | `docs read` |
| `.xlsx` | `sheet read` |
| `.pptx` | `slides read` |
| `.pdf` | `pdf read` |
| `.md` / `.html` / `.txt` / 源码 | **直接读文件**（不走 convert，它明确不支持） |

**这就是 B 已经实现的 `readAnyDocument`。** 我那条「一律 convert」是错的，已作废。

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
7. **`document_md_read` 支持全部六种格式**：`.docx` / `.xlsx` / `.pptx` / `.pdf` / `.md` / `.html`（外加纯文本与源码原样返回）。按扩展名分派到 `docs read` / `sheet read` / `slides read` / `pdf read` / `convert --to md`。**这是用户「读文件也不全面」的直接验收点。**
8. 目录里**不存在**「有名字、无路由、无实现」的工具——或者它们被显式标成 `route: "editor-only"` 且描述里说清。
9. 变异验证：撤掉关键接线 → 断言变红 → `cmp` 还原。
10. T24 的套件不回归；双包 typecheck 通过。

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

## 结果回写（2026-10-23）

### 0. 一句话结论

**五条缺口全部处理，全部有真 CLI 证据。** PPT 设计流水线接上了（带快照围栏），
六格式读取接通，三个空门禁换成了有上游依据的 `render-probe`，`create_document`
与 `build_deck` 经 `document_tool_call` 真能造出文件，目录里再没有「有名字、
无路由、无实现」的工具。

**提交**：`0a2aa805`。

**归属如实说明**：本卡第一步（`genofficeCli.ts` 的 `readAnyDocument` /
`renderProbeCheck` / `slidesCheck` / `slidesReplace` / `snapshotDeckSpec` /
`createDeckFromSpec` 与 `documentToolSurface.ts` 的 `render-probe` 门禁）**没有
自己的提交** —— 它被总控一次未带路径的 `git commit` 卷进了 `51e14637`
（`docs(T42,T43): ...`）。代码经核实完好（`git show 51e14637:<file>` 里六个
函数都在，工作区与该提交一致）。本卡自己的提交从第二步起（`0a2aa805`）。
**台账如实记录，不遮掩。**

### 1. 现状复核表（用产品 API 实测，不是正则猜的）

`node .tmp/t43-routes.mjs` 把 `documentCatalog()` / `cliRouteFor()` /
`editorOnlyReason()` 打出来，得到**最终三态 route 分布**（140 个工具）：

| app | 总数 | cli | editor-only | editor（需渲染端绑定） |
|---|---|---|---|---|
| docs | 40 | 12 | 10 | 18 |
| sheets | 18 | 8 | 8 | 2 |
| slides | **19** | 5 | 12 | 2 |
| pdf | 45 | 3 | 2 | 40 |
| markdown | 10 | 0 | 10 | 0 |
| html | 8 | 0 | 7 | 1 |
| **合计** | **140** | 28 | 49 | 63 |

> 140 = vendor 139 + Mcode 自有 1（`slides.build_deck`）。

**三不管 = 0**：每个工具都落进 `cli` / `editor-only` / `editor` 三栏之一。
`editor` 那 63 个是「有受信渲染端绑定就能执行」的真能力（T0/T98 通道），
不是缺口 —— 缺的是 T40 那条线没接上（另一张卡）。

**改动前**（同一入口在 HEAD~1 上的结果）：

| app | cli | editor-only | 空门禁 |
|---|---|---|---|
| docs | 11 | 0（这一态不存在） | — |
| sheets | 7 | 0 | — |
| slides | 4 | 0 | — |
| pdf | 2 | 0 | **空** |
| markdown | 0 | 0 | **空** |
| html | 0 | 0 | **空** |

**关键差异**：
- `slides.build_deck` 是**新增**的（原目录里没有；只有 `plan_deck` / `generate_deck`
  这两个编辑器内工具）；
- `docs`/`sheets` 的 `create_document` 从「无路由」变成 `cli`；
- 旧审计脚本把 `slides` 的 `apply_ops` / `edit_chart` / `load_guide` 漏算了
  （它的正则被单行 `pdf: { ... }` 形态打乱）。**以上表是产品 API 实测，以它为准。**

### 2. 五条缺口逐条

#### 缺口一：三个空门禁 → `render-probe`（有上游依据，不是我们发明的）

**先查清上游有没有对应命令**（卡要求）：
- `genoffice <command>` 列表：`info / convert / create / slides / sheet / docs /
  merge / pdf / render / guide / search / image / media / open / selection /
  capabilities / install-cli / mcp / skill` —— **没有 markdown / html 命令**；
- `guide --json` 只认 `slides / docs / sheets` 三个域；
- `pdf --help` 只有 `read`，**没有 pdf check**。

所以**没有** `pdf check` / `markdown check` / `html check`。但**不是**写个假门禁：
`render --help` 原文是

> `One PNG per page of a document, as the GenOffice renderer lays it out: the
> picture an agent looks at to check a Word document, a workbook or a page it
> just made.`

—— **上游自己把 `render` 定义成检查手段**。所以门禁叫 `render-probe`：真跑
`render --page 1`，真读返回值，**排版不了就失败**（坏 HTML、超限字体、
`conversion_failed` 都会红）。

**措辞三处都守住了边界**：
1. `DOCUMENT_QA_GATE_LABELS["render-probe"]` = 「可渲染性检查（原厂渲染器试排一次；
   检的是能否排版，不是内容质量）」；
2. `extractRenderProbeReport` 的 `scope` 原文进给模型的正文：
   「只验证了「X 能被原厂渲染器排版成 PNG」（页数 N）；**没有**检查内容正确性，
   也**没有**判断排版是否好看」；
3. 套件断言 `formatQaReport` 的正文**不出现**「没有发现问题」（那句是 check 的）。

#### 缺口二 / 五 / 六：`create` 接进工具面

| 工具 | 路线 | 实现 |
|---|---|---|
| `docs.create_document` | `create --type docx --from <fragment.html>` | `createFromFile`（T74 已有，**未改**） |
| `sheets.create_document` | `create --type xlsx --from <csv/json>` | 同上 |
| `pdf.create_document` | `create --type pdf --from <md/html/docx/xlsx/pptx>` | 新增 `createPdfFromFile`（单独壳：需要原厂渲染器） |
| `slides.build_deck` | `create --type pptx --spec <snapshot>` | 新增 `createDeckFromSpec` + `snapshotDeckSpec` |

**HTML 入口**（用户洞察「AI 写 HTML 很强」）：`docs.create_document` 的
`input.source` 接受 `.html/.htm`，走的就是 `create --type docx --from fragment.html`。
套件第 4 节真造了一个 docx 并读回内容。

#### 缺口三 / 四：PPT 设计流水线 + 围栏

**为什么不能直接放开类型**：T74 的注释写得对，而且**实测验证了**：

```
把 spec 里的 ./assets/pic.png 挪走  → create 信封里出现
  "imageFailures":[{"page":1,"url":"./assets/pic.png","file":"02.json"}]
把图补回去                          → "imageFailures":[]
```

CLI **真的会按相对路径读 spec 目录里的图片**。所以 `--spec <dir>` 是多文件读取，
`--from` 的单文件围栏覆盖不了它。放开 `"pptx"` 等于让一次工具调用带任意多个
未过围栏的路径进 CLI。

**方案 B（快照）落地** —— `snapshotDeckSpec(ports, sourceDir, targetDir)`：
1. 递归列源目录（**不跟符号链接** —— 链接直接拒绝）；
2. 每个文件过 `requireWorkspacePath`（含 realpath；界外/链接一律拒）；
3. 扩展名白名单：`.json` / `.md` / `.markdown` / `.png/.jpg/.jpeg/.gif/.webp/.svg`；
   其余**一律拒绝并点名**（不是静默跳过）；
4. 单文件 ≤8 MiB、总 ≤64 MiB、≤400 个文件、层级 ≤6；
5. 必须有页面文件（`pages/NN.json`，或目录本身就是 pages）；
6. **逐文件拷贝**（不是整目录 cp —— 那会带走未审的东西）进调用方受控目录；
7. `createDeckFromSpec` 对**副本**调 `create --spec`，可带 `--render` / `--audit`；
8. `finally` 里删快照目录。

源目录**一个字节都没动**（套件断言副本与源逐字节相同、源内容不变）。

**`build_deck` 的可达性**：`documentToolCall({tool:"build_deck", app:"slides"})`
经真 CLI 造出 `.pptx`，再读回页面文本 —— 断言能读到 `T43 BUILT DECK`。
**这条修过一次真缺陷**：第一版把它接在函数末尾的通用 `create` 块，而那时 `app`
已被上面的 `if (app === "slides")` 收窄，**那段是死代码**（`tsc` TS2367 暴露；
运行期它会静默落进 `slidesApply`）。现在它在 `app === "slides"` 分支内。

#### 缺口五：`documentMarkdownRead` 六格式

改成走 `readAnyDocument`，按扩展名分派：

| 扩展名 | 命令 | structured |
|---|---|---|
| `.docx` | `docs read --full` | **true**（有块索引） |
| `.xlsx` | `sheet read` | false（每个非空行一块） |
| `.pptx` | `slides read --full` | false（每页一块） |
| `.pdf` | `pdf read --full` | false（每页一块） |
| `.md/.txt/.csv/源码` | **直接读文件** | false |
| `.html/.htm` | **直接读文件** | false |

**为什么 md/html 不走 `convert`**：实测 `convert` 不支持 `md→md` / `html→md`
（`{"error":"unsupported","message":"cannot convert .md to .md"}`）。卡里原来的
「`convert --to md`」因此作废，已由总控更正。

**两个真缺陷（总控发现，已修）**：
1. **先全读再截断**：原代码 `readFileSync(file).subarray(0, 2MB)` —— 1 GB 的日志
   会先吃掉 1 GB 内存。改成 `openSync` + `readSync` **只读前 2 MiB**。
2. **UTF-8 切半**：截断点落在多字节字符中间会产生 `�`。`trimIncompleteUtf8Tail`
   处理三种形态：
   - `[lead]` 直接到末尾 → 退掉；
   - `[lead][续]` 到末尾 → 退掉；
   - **`[lead][续][ASCII]`**（最容易被漏的一种：ASCII 在末尾，但前面有断 lead）
     → 只退 lead + 续字节，**保留** ASCII。

**套件第 2 节**（8 条断言）把截断点强行放进字符中间：
- 汉字前 2 字节 + ASCII；
- emoji 前 2 字节 + ASCII；
- **完整汉字 + ASCII**（必须**不误删**那个汉字，防过度修剪）。

⚠️ **写这几条时踩过一个假绿的坑**：第一版夹具让文件总长**正好等于** 2 MiB，
于是 `truncated === false`、trim 根本没跑 —— 测的是「没截断」而不是「截断」。
改成「文件总长 > LIMIT，且断字符占满前 LIMIT 字节」后才真的覆盖到。

### 3. 目录一致性（判据 7）

**三不管 = 0**。每个工具落进三态之一：
- `cli`（28）：文件没开也能用；
- `editor-only`（49）：**确认**编辑器是唯一途径，`note` 写明原因与替代做法；
- `editor`（63）：需要受信渲染端绑定（T0/T98 通道；接线在 T40）。

`build_deck` 的目录条目**追加在** `documentToolSurface.ts` 的
`MCCODE_OWNED_TOOLS`，**没有手改** `documentToolCatalog.generated.ts`
（生成文件，手改会在下次重新生成时被冲掉）。

### 4. 证据

**新套件 `t43-document-ai-design-pipeline-smoke`：53/53**（真 CLI、真子进程、真文件）
- 七种输入读取（docx/xlsx/pptx/pdf/md/txt/html）；
- 大文件 8 条（三种截断位置 + 不误删完整字符）；
- 门禁 5 条（三家非空 / 都是 render-probe / 措辞不冒充 check）；
- 创建 4 条（HTML→docx、读回、不覆盖、CSV→xlsx）；
- 围栏 9 条（正常通过、逐字节相同、源不变、未知扩展名、不留半成品、界外、空目录、无页面）；
- `build_deck` 可达性 5 条（真造出 pptx、读回内容、缺 specDir 显式拒绝）；
- 目录一致性 4 条。

**`pdf` 那条曾经是假 skip（已修正，见 §8）**：初版套件报告「本机 create --type pdf
不可用」，但那是**套件自己的解析 bug**（`JSON.parse` 整段输出，而被 pdf 导出前的
`starting GenOffice for pdf export` 一行打断），不是环境限制。修正后 pdf 真读通。

**变异验证（两次，都逐字节还原）**：

| 变异 | 结果 | 还原 |
|---|---|---|
| `snapshotDeckSpec` 跳过扩展名白名单 | **51/53**（"未知扩展名被拒" + "不留半成品" 两条红） | `cmp` 一致 |
| 移除 `build_deck` 分支（模拟死代码） | **49/52**（三条红；失败原因是 `file not found` —— 正是落进 slidesApply 的表现） | `cmp` 一致 |

**回归（提交后复跑）**：
- `t24-document-tool-surface-smoke` **59/59**（把硬编码的 139 改成 vendor 139 + 1）；
- `t0-genoffice-native-tool-roundtrip-smoke`、`genoffice-cli-smoke`、
  `document-read-smoke`、`app-control-smoke` 全 PASS；
- 双包 typecheck 通过（`apps/desktop` 里他人正在改的 `RightPanel.tsx` / `i18n` /
  `moduleCatalogShape` 的报错与本卡无关，已逐条确认）。

### 5. 契约变更（必需，追加式）

`packages/contracts/src/ipc/document.ts` 追加取值，**没有删改任何现有成员**：
- `DocumentToolsListEntry.route`: `"cli" | "editor"` → `+ "editor-only"`，新增可选 `note?`；
- `DocumentToolDescribeResult.route`: 同样加 `"editor-only"`；
- `DocumentQaReportWire.gate`: `"check" | "audit"` → `+ "render-probe"`。

不追加这三处，三态标注与 `render-probe` 报告无法过线。

### 6. 明确没做的（如实）

1. **`plan_deck` / `generate_deck` 仍未接 CLI** —— 它们读编辑器里的实时 deck 状态，
   上游 CLI 没有等价命令。按卡的要求标成 `route:"editor-only"`，`note` 指向替代路径
   （`build_deck` 的设计流水线）。**这是「如实标注」，不是「假装支持」。**
2. **`pdf` 的 40 个编辑器工具仍未接 CLI** —— 上游 `pdf` 只有 `read` 一个命令。
3. **`render-probe` 不是内容检查** —— 它只证明「能排版」。要检查内容正确性，
   仍要 `document_render` 出图让模型看，或该格式自己的 check（若存在）。
   **它需要原厂渲染器**：`render` 走的是 `genoffice --headless-export`。没有原厂应用
   的机器上，门禁会以 `app_unavailable` 失败（**不是**静默跳过），所以「形同虚设」
   不会发生 —— 它会明确报错。
4. **未跑真 Electron** —— 本卡是 CLI/无头能力，真窗口链路归 T7/T30。

### 7. 复现

```bash
cd apps/desktop
bash scripts/t43-document-ai-design-pipeline-smoke/run.sh                      # 53/53
bash scripts/t43-document-ai-design-pipeline-smoke/run.sh --mutate=no-fence    # 变异，期望非零
bash scripts/t24-document-tool-surface-smoke/run.sh                            # 59/59 回归
npx tsc --noEmit -p tsconfig.json                                              # 门禁
```

### 8. 追补：pdf 断言曾经自己跳过自己

初版套件第 1 节的 `runCli` 助手写成：

```ts
try { envelope = JSON.parse(raw.trim()) } catch { /* 非 JSON */ }
```

而 `create --type pdf` 的输出前面有一行 **`starting GenOffice for pdf export`**
（原厂应用启动提示），整段因此不是 JSON → `envelope` 为 `null` → 断言走进
`skip` 分支，报告「本机不可用」。

**这不只是少了一条测试，是报告了一个错误的结论**：它把「我的解析器写错了」
说成了「这台机器缺原厂应用」。生产代码 `genofficeCli.invoke` 从来是正确的
（按行筛 `{` 开头的行，多于一条就拒绝猜），**只有套件抄错了**。

修正后：
- `runCli` 照抄生产判据（按行筛 JSON，多行则按失败处理）；
- `pdf` 真读回内容（`via=pdf read`）；
- 另加**门禁真跑**三条：对 markdown 跑 `render-probe`，断言真的落了一个
  非空 PNG 在盘上。

**结果：57/57**（原 53 + pdf 1 + 门禁真跑 3）。

**变异**：把 `renderProbeCheck` 改成恒返回成功（不真渲染）→
「真的落了一个 PNG 在盘上」变红（55/56），`cmp` 逐字节还原。

提交：`a48066a9`。
