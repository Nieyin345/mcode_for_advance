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
