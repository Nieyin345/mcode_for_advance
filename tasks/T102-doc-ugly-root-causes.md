# T102｜🔴 「又烂又丑」的三个可量化根因：中文无字体 / 表格超宽 / 模型不知道传什么

- Status: ready-for-agent
- Category: **P0 产品缺陷**（用户抱怨的直接原因）
- Priority: **P0 —— 这是「AI 改 Word 很烂」最具体的一次定位**
- Depends on: T97（A 的 `e74f644f`，产出了精确数值）
- Exclusive writable files: 见「边界」（**分三处，可能分三次提交**）

## Required Skills
- `mcode-smoke`：给三处各补断言。
- **改 `genoffice/` 要先确认是「Mcode 侧传参」还是「改上游」**（见边界）。

## 背景：A 的 T97 把「又烂又丑」拆成了三个可量化的问题

### ① 中文没有字体（`w:eastAsia` 缺失）

```ts
// genoffice/packages/docx-engine/src/blank.ts:511-546
eastAsiaFont?: string
...
zip.file('word/styles.xml', stylesXml(options?.eastAsiaFont))
```

**`eastAsiaFont` 不传就不写 `w:eastAsia`**，产物里只有：

```xml
<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>
```

**后果**：中文靠 Word 按脚本回退，和 Calibri 混排时**字形、字重、行高都不一致**。

**这是「看起来不像在 Word 里排的」最直接的原因。**

### ② 表格比正文区宽 334 twips

```ts
// genoffice/packages/docx-engine/src/generate.ts:2497
const totalWidth = 9360 // 6.5in content width on US Letter
```

**总控核实**：

```
A4 width:        11906 twips (210mm)
minus margins:    9026 twips (左右各 1440)
table width:      9360 twips
overflow:          334 twips (0.23 inch / 16.7pt)
```

**`9360` 正好是 US Letter 的可用宽（`12240 - 2880`）。用 Letter 算的宽配了 A4 的页面。**

### ③ 模型不知道 `create_document` 要传什么

```ts
// documentToolRuntime.ts:341-345
// 只对 cliOp === "apply" 取 guideOps 的 op 参数表
// create_document 的 cliOp 是 "create"，落进 else if
// → 取整个 docs 域 guide 前 4000 字（那是 apply 的语法）
```

**实测**：`describe({tool:"create_document"})` 返回 4264 字，**没有 `input.source`、没有「docx 要受限 HTML」、没有「Markdown 会被拒」**，4000 字全是 apply 的 ops 语法。

**更糟**：`doc` 字段在 `documentToolCatalog.generated.ts:57` 被截到 160 字，**恰好切在关键句之前**：

- 上游原文：「type 'docx' (default) and 'pdf' take the same restricted HTML as insert_content in **content**」
- 模型拿到：「…Use when the user asks to put content i…」

**后果**：模型按正常理解传 `input.source = report.md` → 被拒。**围栏是对的**（Markdown 图片路径会被上游解析），**错的是模型无法从工具面知道**。

## 任务

### 第 1 件：`document_tool_describe` 对 `create` 路线返回正确的参数

**最小修法**：`create` 分支改取 `guideOps(domain, "create_document")`，或把 `input.source` 的约束写进 `schemaText`。

**要求**：

1. `describe({tool:"create_document", app:"docs"})` 必须包含 `input.source`；
2. 必须说明「docx/pdf 要受限 HTML fragment」；
3. 必须说明「Markdown 会被拒」；
4. **正控**：`describe({tool:"insert_content"})` 仍然返回 apply 的 ops 语法（没回归）。

### 第 2 件：`w:eastAsia` 在 Mcode 侧传参

**先判断**：

```bash
grep -rn "eastAsiaFont" apps/desktop/src/ genoffice/packages/cli/src/ 2>/dev/null | head
```

**如果 CLI 有对应选项**（`--east-asia-font` 之类）→ **Mcode 侧传参**，不改上游；
**如果 CLI 没有** → **这是上游能力，要么等上游，要么在 Mcode 侧 fork**（后者成本高，**停下报告**）。

**要求**：

1. 生成的 docx 里 `styles.xml` 有 `w:eastAsia="..."`；
2. **中文串「宋体」或「Microsoft YaHei」** —— 你论证选哪个（要看跨平台：macOS 上没有宋体）；
3. **正控**：纯英文内容仍然能生成（不能因为加了字体而坏）；
4. **如果 CLI 没有对应选项，停下报告，不要改 `genoffice/`**。

### 第 3 件：表格宽度

**`9360` 是 US Letter 的可用宽。判断**：

- **能不能从页面尺寸算出来**（A4 → 9026）？如果 `generate.ts` 有这个信息，那这是**上游 bug**，应该报给上游；
- **Mcode 侧能覆盖吗**（比如 spec 里指定表格宽度）？

**要求**：

1. 先查 `generate.ts` 有没有拿到页面尺寸（`pageSize` / `width` 之类）；
2. **如果能算而没算 → 那是上游 bug，写进回写区报告，不要改 `genoffice/`**；
3. **如果 spec 能指定 → Mcode 侧或 guide 里加说明**。

## 验收判据

1. **三件各有一个判断**（改哪里、为什么、成本）。
2. **第 1 件必须修**（工具描述缺参数是模型猜错的直接原因）。
3. **第 2、3 件如果涉及改 `genoffice/`，停下报告**。
4. **每件都有正控 + 负控**。
5. 不跑全量、不起 Electron。

## 边界

- **可以改**：`apps/desktop/src/main/document/documentToolRuntime.ts`（第 1 件）；
- **可以改**：`apps/desktop/src/main/document/documentToolCatalog.generated.ts` 的**截断长度**（但要重新生成）；
- **不要改 `genoffice/`**（那是 vendor 快照）—— **除非你论证「这是 Mcode 侧传参」**；
- 不改其他文件。

## 遇到问题先检索

`genoffice guide docs create_document` 是上游的规范原文，**先读它**。
`genoffice/packages/cli/` 的命令行选项先 `--help` 确认。

## 回写

`tasks/T102-doc-ugly-root-causes.md` 末尾追加 `## 结果回写（2026-10-24）`：
三件的判断、第 1 件的实现、第 2/3 件如果是上游 bug 的证据、正负控、提交 SHA。

## 结果回写（2026-10-24）

> 执行会话（F）。**第 1 件已修并提交**；第 2、3 件只做判断，**未改 `genoffice/`**。
> 结论：第 1 件是 Mcode 侧缺陷，改在 `documentToolRuntime.ts`；第 2 件**有 Mcode 侧的可行路径**
> （`setFont` 能写 `w:eastAsia`），但**不是免费修**，要先决定字体策略；第 3 件是**上游 bug**。

### 第 1 件 ✅ 已修：`describe` 对 `create` 路线返回正确的参数

#### 为什么卡上的「最小修法」不可行

卡上写「`create` 分支改取 `guideOps(domain, "create_document")`」。**这条路物理上不存在**：

```bash
$ node genoffice/packages/cli/dist/genoffice.cjs guide docs create_document
genoffice: unknown group or op: create_document
  hint: run `genoffice guide docs` for the groups and ops
  {"groups":["block","content"]}
```

`guideOps` 只是把 op 名拼进 `["guide", domain, "<op>"]`（`genofficeCli.ts:430-436`），
而上游 guide 只认 `block` / `content` 两个**组**。`create_document` 从来不是 apply op，
上游没有它的 guide 条目 —— 上游对 create 的说明只在 `create --help` 和工具表里，
**两条都不经 guide 出口**。所以这一条只能**手写**。

#### 改了什么

`documentToolRuntime.ts` 新增 `createRouteHelp(app, tool)`，describe 的 create 分支调它：

```ts
} else if (cliOp === "create" && domain !== null) {
  parts.push("", createRouteHelp(entry.app, entry.name));
}
```

**每个 app 的文案对着围栏的真实实现写**，不是凭印象：

| app | 文案里的源文件格式 | 对着哪段代码 |
|---|---|---|
| docs | 只收 `.html/.htm`；**`.md` 会被拒** | `genofficeCli.ts:900` `createFromFile` |
| sheets | 只收 `.csv/.json` | `genofficeCli.ts:903` |
| pdf | **接受 `.md`**（与 docs 相反）+ `.html/.htm/.docx/.xlsx/.pptx` | `genofficeCli.ts:1086` `createPdfFromFile` |
| slides `build_deck` | `input.specDir` / `input.outline`，不是单文件 | `documentToolRuntime.ts` `buildDeck` |

另加 `appControl/tools.ts` 顶层描述：原来只说「docx 接受受限 HTML fragment」，
现在补上「**`.md` 会被拒，先转成 HTML；pdf 才接受 `.md`**」。

#### 断言（`t24-document-tool-surface-smoke`，新增第 4b 组，7 条）

```text
★ describe(create_document/docs) 提到 input.source
★ describe(create_document/docs) 说明 docx 只收受限 HTML fragment
★ describe(create_document/docs) 明写 Markdown 会被拒
★ 负控：create 的 describe 不再混进 apply 的 ops 语法
★ describe(create_document/pdf) 说明 pdf 接受 .md（与 docs 相反）
  describe(create_document/sheets) 说明只收 .csv/.json
★ 正控：insert_content 仍返回 apply 的 guide 原文（create 分支没吞掉 apply）
```

**套件 67/67 通过**（原 60 条 + 新 7 条）。

#### 变异验证

变异点：把 create 分支整段撤掉（退回原来的兜底分支）—— 撤的是**证据源**，不是改断言表达式。

```text
变异后套件退出码 1，红 6 条：
  ★ describe(create_document/docs) 提到 input.source
  ★ describe(create_document/docs) 说明 docx 只收受限 HTML fragment
  ★ describe(create_document/docs) 明写 Markdown 会被拒
  ★ 负控：create 的 describe 不再混进 apply 的 ops 语法
  ★ describe(create_document/pdf) 说明 pdf 接受 .md
  describe(create_document/sheets) 说明只收 .csv/.json
insert_content 的正控仍然绿  ← 证明红的是 create 分支，不是整个 describe 崩了
```

还原后 `cmp` 逐字节一致（脚本显式检查 `sha256` 相等）。

**变异脚本第一版有两个错，都已修正并在脚本里留了注释**：
1. 按 `\n` 匹配 CRLF 文件 → `count=0` 直接退出（CLAUDE.md 第八条形态 1），改为 bytes 匹配；
2. Python `subprocess` 走 PATH 命中了 **WSL 的 bash**（`/mnt/d/...`，没有 node）→ 套件 `rc=127`，
   那是「命令找不到」不是「断言红」。改为显式 `C:\Program Files\Git\bin\bash.exe`。

### 第 2 件 ⚠️ 判断：有 Mcode 侧路径，但要先定字体策略

#### 事实

```bash
$ node genoffice/packages/cli/dist/genoffice.cjs create --help | grep -i font
（无任何字体选项）
$ grep -rn "eastAsiaFont" apps/desktop/src/ genoffice/packages/cli/src/
（零命中）
```

**`create` 没有字体选项**，所以「Mcode 侧传参」在 create 这条路上没有参数可传。

**但有一条**实测可用的路径：`docs apply` 的 `setFont` 带 `fontFamily`，
对中文块会写进 **`w:eastAsia` 槽**（run 级）：

```json
[{"op":"setFont","target":{"blockIndexes":[0,1]},"fontFamily":"Microsoft YaHei"}]
```

产物：

```xml
<w:rFonts w:eastAsia="Microsoft YaHei"/>
```

**这是 run 级，不是 docDefaults 级** —— 每个中文 run 都会被写一遍，
而 `styles.xml` 的 docDefaults 仍然是空的。能用，但不是「设一次全局默认」。

#### 为什么我没有直接改

**字体选哪个是个跨平台决策，不是我可以单方面定的**：

| 候选 | Windows | macOS | Linux |
|---|---|---|---|
| `宋体` / `SimSun` | ✅ | ❌ 没有 | ❌ |
| `Microsoft YaHei` | ✅ | ❌ 没有 | ❌ |
| `PingFang SC` | ❌ | ✅ | ❌ |
| `Noto Sans CJK SC` | 部分 | 部分 | ✅ |

**Word 对缺失字体的行为是回退到系统默认**，所以写死任何一个名字，
都会在另外两个平台变成「一个不存在的字体名 + Word 回退」——**可能比不写更乱**。

而且这一层修在 **`document_tool_call` 的调用侧**（Mcode 要额外发一次 `setFont`，
并且要知道哪些 block 是中文），**不是在 create 时一行搞定**。

#### 建议（需要总控裁决）

1. **最小可行**：接受「不写 `w:eastAsia`」这个上游默认，因为 Word 会按脚本回退到系统默认中文字体
   —— **视觉上不完美，但不是错误**；
2. **若要修**：Mcode 侧在 create 之后追加一次 `setFont`，字体名按**运行平台**选
   （Windows → `Microsoft YaHei`，macOS → `PingFang SC`，Linux → `Noto Sans CJK SC`），
   并只对含 CJK 的 block 发。**这会给每次创建多一次 CLI 调用**，且在 Mac 上产出的 docx
   拿到 Windows 打开时字体名仍然不存在。
3. **最稳**：等上游给 `create` 加 `--east-asia-font`，由它写 docDefaults（全局生效、一次写对）。

### 第 3 件 🐛 判断：**上游 bug**，证据如下

#### 它算得出来却没算

```ts
// genoffice/packages/docx-engine/src/generate.ts:2496-2497
export function generateTableXml(rows: number, cols: number, opts: TableGenOptions = {}): string {
  const totalWidth = 9360 // 6.5in content width on US Letter
```

```ts
// genoffice/packages/docx-engine/src/generate.ts:1972-1979
export interface TableGenOptions {
  headerRow?: boolean
}
```

**`generateTableXml` 的签名里没有任何页面尺寸**，唯一的选项是 `headerRow`。
而页面尺寸在上游是**已知的**：`set_page_setup` op 支持 `paper (A3/A4/A5/B5/Letter/...)`
与 `margins`，`docs read --sections` 能读出来。`parse-drawing-geometry.ts:373` 就已经在算
`pageW - marL - marR` 了 —— **同一份代码库里，画图几何知道怎么算正文宽，表格不知道。**

**结论：能算而没算，是上游 bug。** 按卡的要求，**没有改 `genoffice/`**。

#### 同一常量在上游还有第二处

`genoffice/apps/docs/src/renderer/ai/table-ops.ts:62`：

```ts
/** Word's default body width (Letter, 1in margins); only used for tables without any width */
const DEFAULT_BODY_TWIPS = 9360
```

注释比 docx-engine 那处诚实（写明了 "Letter, 1in margins"），但**默认值仍是 Letter**，
而 `buildBlankDocx` 的默认纸张是 **A4**（`blank.ts:500` 的 `A4: { w: 11906, h: 16838 }`）。
**两处默认值互相矛盾，这就是 334 twips 的来源。**

#### Mcode 侧能否覆盖

**不能。** `guide docs content` 的表格相关 op（`insert_content` / `replace_blocks`）
只收 HTML，**没有宽度参数**；`table-ops` 的 `parseTableLength` 虽然存在，
但只在「表格已经存在、要改它」时用，create 路径用不到。

所以第 3 件**必须等上游**，或者接受现状。建议报给上游时附上这两个文件行号。

### 验收判据对照

| 判据 | 结果 |
|---|---|
| 三件各有一个判断 | ✅ 见上 |
| 第 1 件必须修 | ✅ 已修，67/67 |
| 第 2/3 件涉及改 `genoffice/` 要停下报告 | ✅ 一处未改 |
| 每件都有正控 + 负控 | ✅ 第 1 件 7 条含正负控；第 2/3 件在判断里给了证据与反例 |
| 不跑全量、不起 Electron | ✅ 只跑 `t24` 一套 |

### 未做 / 需要裁决

1. **第 2 件的字体策略**：见我上面的三个选项，需要你选一个。我倾向①（接受上游默认），
   因为写死平台字体名会在跨平台流转时变成「不存在的字体」。
2. **第 1 件的 `doc` 字段截断**（160 字）**没动**。卡上允许改，但改它要重新生成整个目录
   （`.tmp/t24/gen/make-catalog-ts.mjs` 依赖 `composed-tables.json`），
   而 `describe` 现在会补上 missing 的信息，**截断本身不再是「模型必错」的原因**。
   要不要为可读性放宽，你定。
3. **没验真模型会不会读 describe**。T97 已经写明这个限制：描述修好了，
   模型仍可能不读、或读了不用。**那是另一个问题，需要不同的验证方式。**
