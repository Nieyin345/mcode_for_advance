# O0｜六格式复杂样本保真：编辑无关内容后，未触碰的复杂部件必须还在

- Status: **done**（2026-10-24，六格式基线全绿 + 32 变异体全部按预期变红）
- Category: **Office / E2E-3 否决型判据**
- Priority: **P0 —— 现有 U1 只证明「简单内容能读写」，而静默损坏是最致命的失败形态**
- Depends on: `t7-genoffice-u1`（六格式 U1 骨架已全绿，本卡在它上面加复杂样本）
- 独占写入边界：
  - `apps/desktop/scripts/t7-genoffice-u1/journeys/**`（**只加新 journey，不改现有六条**）
  - `apps/desktop/scripts/t7-genoffice-u1/fixtures.ts`（只追加复杂样本的构造）
  - `apps/desktop/scripts/o0-format-fidelity-smoke/**`（新建，若要独立套件）
  - **不得改** `apps/desktop/src/main/**`。本卡是**取证**卡：先证明坏，再决定修不修。

## Required Skills

- `mcode-smoke`：这套 U1 的写法（真 Electron + CDP + 三层断言）必须先读明白
- `systematic-debugging`：若某格式真的损坏，要能定位到是哪一层（vendor / 桥 / 我们）

## 一、为什么是这张卡

用户的原话是「AI 改 Word/PPT **又烂又丑**」，而更糟的形态是**不报错的损坏**：

> 用户让 AI 改一句话，保存成功，重开发现公式变成了图片、批注全没了、动画消失了、嵌套表错位。
> **整个过程零报错。**

`t7` 现在的六条 journey 验的是「打开→改→存→重开，内容在」。它**不验**「我改 A，B 有没有被弄坏」。
E2E-3 的原文要求是：

> 公式、版式、图片、批注、动画、未知部件**不得静默损坏**。

## 二、判据（必须可执行，不接受「验保真」这种愿望）

### 2.1 六格式各一份复杂样本

样本要**简单到能手工核对**，但**覆盖该格式最有代表性的复杂部件**：

| 格式 | 必须包含 | 为什么是这些 |
|---|---|---|
| DOCX | 嵌套表格、编号列表、页眉页脚、脚注、**东亚字体**（中文） | 中文无 `w:eastAsia` 是已知根因（`memory/doc-ugly-root-causes`） |
| XLSX | 公式（跨 sheet 引用）、条件格式、合并单元格、图表 | 公式重算走 Rust sidecar，最容易静默丢 |
| PPTX | 多页、母版占位符、动画、备注、图片 | 动画/备注是已知「preload 回空」的区域 |
| PDF | 文本层、书签、批注（若有） | PDF 写回有已知并发缺口 |
| Markdown | 表格、代码块、图片引用、嵌套列表 | |
| HTML | 样式表、内联 SVG、脚本标签 | |

### 2.2 每份样本跑三步

```
1. 打开 → 记录「基线指纹」
2. 只改一处**与复杂部件无关**的内容（例如正文第一段的一个词）
3. 保存 → 关闭 → 重开 → 逐项比对复杂部件
```

**「基线指纹」怎么取**（这是本卡的核心方法，别自己发明）：

- **必须用能读出语义的手段，不是渲染截图**。截图像素比对会因为字体渲染差异误报。
- 每个格式用**自己的原厂读取器**（就是产品里用的那个），不要另写一个解析器——
  另写一个会变成「用我的解析器验我的解析器」。
- DOCX/XLSX/PPTX 走 OOXML：解压 `word/document.xml` / `xl/worksheets/*.xml` / `ppt/slides/*.xml`，
  **按 path 和文本节点比对**，忽略 `docProps/*` 里必然变化的时间戳。
- 已知会变的：`dcterms:modified`、`lastModifiedBy`、`revision`、ZIP 内文件顺序。**这些要从比对里排除，并写明排除了什么。**

### 2.3 通过/失败怎么判

| 结果 | 判定 |
|---|---|
| 复杂部件**逐项仍在且语义等价** | PASS |
| 有任何一项**消失或改变语义** | **FAIL，并记录是哪一项、哪个格式、哪个 XML path** |
| 部件还在但**位置/样式变了** | 也算 FAIL（「语义等价」包含结构位置） |

**FAIL 不是这张卡的失败** —— 这正是本卡要产出的东西：**一张「哪个格式的哪个部件会坏」的清单**。

## 三、★ 旧红 → 新绿要求

**这张卡的第一交付物是一份红绿表，不是代码。**

1. 先跑出**基线红绿表**（六格式 × 各自的复杂部件）；
2. 对每条 FAIL，判断：
   - **是 vendor 的行为**（GenOffice 原版就这样）→ 记录，标注「上游限制」，不改；
   - **是我们的桥丢了** → 记录，**另开卡修**（本卡不改产品代码）；
3. 交付时必须能给出一句话结论：**「用户现在用 Office 编辑，哪些东西会悄悄坏掉」**。

**没有这份表，这张卡等于没做。** 全绿也要给出表（那就是「当前无静默损坏」）。

## 四、变异要求

对**每一条 PASS 断言**，做一次变异证明它真的会红：

- 做法：手工把样本里的那个复杂部件删掉（或改坏），重跑，**该条必须红**；
- **并且**：把部件以**另一个位置**放回去（例如公式挪到别的单元格），**该条也应当红**（证明它比的是语义不是存在性）；
- 恢复后 `cmp` 逐字节核对样本未被污染。

**只验「删掉会红」不够** —— 那只能证明「存在性」，证明不了「语义等价」。

## 五、不要做的事

- **不要改产品代码**。本卡是取证。发现缺陷另开卡。
- **不要修改 `t7` 现有六条 journey**。它们是 E2E-3 的基线，不能为了新样本改旧判据。
  新样本**新开 journey 或新套件**。
- **不要用截图比对**代替语义比对（理由见 2.2）。
- **不要跳过任何格式**。六格式是验收下限，少一个就不能说 E2E-3 完成。

## 六、如何运行

```bash
# ⚠️ 必须用 pnpm 入口。直接 bash run.sh 会因脚本内部 cd 而找不到 ../lib/esbuild-path.sh
pnpm test:smoke <你的套件名>

# 六格式 U1（基线，必须先确认它是绿的）
cd apps/desktop && node scripts/t7-genoffice-u1/run.mjs
```

## 七、结果回写区

> 执行会话：Office / O0 独立执行会话（2026-10-24）
> 套件：`apps/desktop/scripts/o0-format-fidelity-smoke/`（新建）
> 运行：`pnpm test:smoke o0-format-fidelity-smoke`（= `run.mjs` 六条旅程 +
> `mutate.mjs` 判据变异；两段都过才算绿）
> 生产代码：**零改动**（`apps/desktop/src/main/**` 没碰；t7 六条旅程与其构建输入没碰）

### 7.1 一句话结论（卡 §3 要求）

**当前用 Office 编辑（六格式各改一处与复杂部件无关的内容 → 保存 → 重开），
本套件抽查的 49 项复杂部件/语义全部原样保留 —— 在这张样本集的覆盖范围内，
没有发现静默损坏。**

这句结论的边界（很重要，别读成「六格式绝对安全」）：

- 它证明的是**这六份样本 × 这六类编辑**；不是「任意文档任意编辑」；
- 有 **1 处 vendor 语义变化**被如实放过（PPTX 被编辑文本框的 autofit 高度，
  见 7.3），**1 处探测手法受限**（PDF 旋转如何作用在页面上，见 7.4）；
- 变异验证（7.5）证明这张绿表不是「判据从不报」造出来的。

### 7.2 基线红绿表（六格式 × 复杂部件）

取样：每格式一份复杂样本（`fixtures/build.ts` 的 `O0` 常量），
打开 → 取语义基线指纹 → **只改一处与复杂部件无关的内容** → 保存 → 关闭 →
**真 OS 重开** → 逐项比对。证据在每次运行的
`.tmp/electron-u1/<时间戳>/<format>-fidelity/o0/<format>-compare.json`。

| 格式 | 复杂部件 | 指纹项 | 结果 |
|---|---|---|---|
| DOCX | 嵌套表格（外层结构） | `docx.nested-table.outer` | PASS |
| DOCX | 嵌套表格（内层表 + 所在单元格） | `docx.nested-table.inner` | PASS |
| DOCX | 编号列表（numId/层级/文本/body 位置） | `docx.numbered-list` | PASS |
| DOCX | 页眉/页脚引用（sectPr 的 header/footerReference） | `docx.header-footer-refs` | PASS |
| DOCX | 页眉部件本体 | `docx.hf-part:word/header1.xml` | PASS |
| DOCX | 页脚部件本体 | `docx.hf-part:word/footer1.xml` | PASS |
| DOCX | 脚注引用标记（正文 w:footnoteReference + 锚段文本） | `docx.footnote-refs` | PASS |
| DOCX | 脚注部件本体（footnotes.xml 的正文） | `docx.footnote-parts` | PASS |
| DOCX | 东亚字体（`w:rFonts/@w:eastAsia` + 所在 run 文本） | `docx.eastAsia-runs` | PASS |
| XLSX | 公式单元格（跨 sheet `=SUM(Data!D2:D4)` 等，ref/value/formula） | `xlsx.formula-cells` | PASS |
| XLSX | 每个 sheet 的 features（条件格式数、合并、图表锚点…） | `xlsx.features` | PASS |
| XLSX | 工作簿 sheet 表（名字/sheetId/关系 id） | `xlsx.workbook-sheets` | PASS |
| XLSX | 条件格式规则（含 sqref 范围） | `xlsx.conditional-formats:*` / `-any` | PASS |
| XLSX | 合并单元格 | `xlsx.merges:*` / `-any` | PASS |
| XLSX | 图表部件本体（标题/系列/数据引用） | `xlsx.chart:xl/charts/chart1.xml` | PASS |
| XLSX | 图表锚点（drawing XML 的 from/to） | `xlsx.drawing:xl/drawings/drawing1.xml` | PASS |
| PPTX | presentation（页序 + 画布尺寸） | `pptx.presentation` | PASS |
| PPTX | 页数 | `pptx.slide-count` | PASS |
| PPTX | 每页元素清单（类型/名字/占位符/几何） | `pptx.elements:ppt/slides/slide{1,2,3}.xml` | PASS |
| PPTX | 动画（`<p:timing>` 结构） | `pptx.animations:slide{1,2,3}` / `-any` | PASS |
| PPTX | 母版/layout 占位符清单 | `pptx.{layout,master}-placeholders:*` / `-any` | PASS |
| PPTX | 备注（notesSlide 正文） | `pptx.notes:ppt/notesSlides/notesSlide1.xml` | PASS |
| PPTX | 图片（media 字节哈希） | `pptx.media:ppt/media/image1.png` | PASS |
| PDF | 页数 | `pdf.page-count` | PASS |
| PDF | 文本层（每页 pdf.js `getTextContent`） | `pdf.text-layer` | PASS |
| PDF | 书签（标题 + 层级 + **目的地**） | `pdf.outline` | PASS |
| PDF | 批注（Subtype + Contents + Rect，排除 Link/Widget） | `pdf.annotations` | PASS |
| Markdown | 表格块（表头 + 数据行） | `md.tables` | PASS |
| Markdown | 围栏代码块（语言 + 正文） | `md.code-blocks` | PASS |
| Markdown | 图片引用（alt + src） | `md.image-refs` | PASS |
| Markdown | 嵌套列表（depth + 标记 + 文本） | `md.nested-list` | PASS |
| Markdown | 部件先后顺序 | `md.part-order` | PASS |
| HTML | 内联 `<style>` 内容（CSS 规范化后） | `html.style-blocks` | PASS |
| HTML | 内联 `<script>` 内容（JS 规范化后） | `html.script-blocks` | PASS |
| HTML | 内联 `<svg>`（标签 + 属性 + 文本） | `html.inline-svg` | PASS |
| HTML | 正文元素的 class 属性（样式表挂钩点） | `html.body-classes` | PASS |
| HTML | `<img>` 的 src | `html.image-refs` | PASS |
| HTML | 内联部件先后顺序 | `html.part-order` | PASS |

合计 49 个指纹项（DOCX 9 / XLSX 11 / PPTX 14 / PDF 4 / MD 5 / HTML 6），**全部 same**。

每条旅程另有「这一次编辑真的落盘」的独立断言（不经页面，直接读盘或走原厂
CLI）——否则保真比对只证明「两份没编辑过的文件一致」：

| 格式 | 编辑动作 | 落盘证据 |
|---|---|---|
| DOCX | 正文第一段替换一个词（真 ProseMirror transaction） | `docs read` 读到编辑文本 |
| XLSX | 数据区下方 A6 写一句话（名称框 + 真键入） | `sheet read` 的 A6 = `O0-XL-EDIT-MARK` |
| PPTX | 第二页文本框改写（页面 `slidesApi.editText`） | `slides read` 第二页含编辑文本；**备注仍在** |
| PDF | 第 1 页向右旋转（真 UI：页面 tab → 向右旋转） | 保存后字节里有 `/Rotate 90` |
| Markdown | Ctrl+H 面板 replaceAll 改正文一句 | .md 文件里含编辑文本 |
| HTML | 源码模式 Ctrl+H replaceAll 改正文一句 | 保存后文件里含编辑文本（比对本身读盘） |

**排除项**（卡 §2.2 要求写明；逐格式列在 `fingerprint.ts` 每个 `excluded`
数组里，并写进基线 JSON）：

- 全格式：ZIP 条目顺序、XML 属性顺序/引号/自闭合写法、XML 注释；
- DOCX/XLSX/PPTX：`docProps/*` 的 `dcterms:modified` / `cp:revision` /
  `cp:lastModifiedBy`；
- XLSX：`xl/calcChain.xml`（重算缓存顺序表，不是语义）；
- PPTX：`a16:creationId`（新元素出生时铸的 GUID）；
- PDF：对象顺序与交叉引用表布局、Info 字典的 ModDate/Producer；
- **被编辑的那一处内容本身**（本案各格式的正文一句 / A6 格 / 第二页文本框正文 /
  PDF 的 `/Rotate`）：它不是复杂部件，把它入账会让「编辑成功」本身被判成 FAIL；
  它的落盘由上面那张表单独证明。**代价**已在 `FingerprintOptions` 与各
  journey 注释里写明。

### 7.3 每个 FAIL 的归因

**基线表里没有 FAIL。** 但比对过程中出现过 **1 条被判成「vendor 行为、
允许放宽」的变化**，如实记录在这里：

- **PPTX：被编辑文本框的高度变了**（`ppt/slides/slide2.xml` 的 `TextBox 2`：
  `cy 1200000 → 365760`）。归因：**vendor 行为** —— `slides:edit-text` 在
  vendor 主进程里跑 `applyAutofitResize`（`apps/slides/src/main/slides-main.ts`
  的 handler），`spAutoFit` 文本框改文字后按新内容高度收缩。它不是部件损坏，
  是「编辑那个文本框」的必然副作用。处理：`FingerprintOptions.pptxAutofitBox`
  **只**放开这一个 (slidePath, name) 的 box，其余（存在性/名字/类型/所在页）
  照常比对。**代价**：若 bug 把那个文本框的尺寸改成 0，本指纹不红 —— 所以
  旅程另加 `pp-disk-has-edit-and-notes` 独立断言。

另有一处**不是 FAIL、但属于「未验证」**，见 7.4。

### 7.4 未验证 / 我觉得不对但没改的

1. **PDF 旋转在页面上「看起来」怎样，没验。** 本卡只验「旋转写出了磁盘
   （`/Rotate 90`）+ 文本层/书签/批注都没坏」。旋转是否真的让页面**显示**
   转了 90°，需要看渲染；那属于另外的视觉判据（t7 的 pdf 旅程有
   `assertScreenshotChanged`，本卡不重复）。
2. **PPTX「母版占位符」是人工补的。** vendor 的 blank 模板布局是
   `type="blank"`、不带任何 `p:ph`；为让这条判据有对象，`fixtures/build.ts`
   往 master/layout 的 spTree 里插了 title/body 占位符、并给 slide1 插了一个
   **继承 layout 几何**的 title 占位符。这是**样本构造**，不是产品行为；
   产品对真实模板 deck 的占位符继承只由 `pptx.elements` 的 `placeholder`
   字段间接覆盖。若要更真，应另开卡用一份真实模板 deck 做样本。
3. **「批注」按卡 §2.1 在 PDF 上验的是 sticky note；PDF 的 markup（高亮/划线）
   没单独验**（同一 `/Annots` 通道、同一 `getAnnotations` 路径，风险低）。
4. **HTML 的「脚本标签」验的是内联 `<script>` 的**文本**，不验它的执行结果**。
   指纹是文本级（`normalizeJs`），与「页面里脚本真的跑起来」是两回事。
5. **被编辑内容的落盘**：见 7.2 的分界与 7.3 的代价说明。这是本卡故意让渡的
   一格判据（「改 A 不坏 B」要求 A 允许变），不是漏做。

### 7.5 变异记录（卡 §4：删掉要红、换个位置也要红）

**做法**：`mutate.mjs` 读第 1 段落盘的基线（`<format>-baseline.bin` + `.json`），
在 `.tmp/o0-mutations/` 的副本上**逐格式构造变异体**（不经任何编辑器，直接改
OOXML/文本/PDF 对象），再用与旅程**同一份** esbuild 产出的指纹实现比对。

**两道自检**（都是踩过坑后加的）：

- **变异体本身必须能被原厂读取器打开**（`assertMutantReadable`，xlsx/docx/pptx
  走 `sheet/docs/slides read`）——否则「红」只证明解析器报错。实测抓到过一次：
  xlsx 的公式变异早期把 `<c>` 插到了 `<row>` 外面，引擎报 XML Error，全部项
  「红」，那是假红。
- **基线拷贝的 sha256 在变异前后必须一致** —— 变异不得污染基线
 （防「变异失效形态 #5：状态污染」）。

**结果**：**32 个变异体全部按预期变红，且命中的是预期项**（不是「随便红一条」）。
逐条（`hit` 为实际变红的指纹项）：

| 格式 | 变异 | 形态 | 命中项 |
|---|---|---|---|
| DOCX | 删内层嵌套表 | delete | `docx.nested-table.inner`（+ outer） |
| DOCX | 内层表挪到 B2 格 | **relocate** | `docx.nested-table.inner` |
| DOCX | 编号列表段落挪到文末 | **relocate** | `docx.numbered-list` |
| DOCX | 页眉文本改一个词 | content | `docx.hf-part:word/header1.xml` |
| DOCX | 脚注文本改一个词 | content | `docx.footnote-parts` |
| DOCX | `w:eastAsia` SimSun→KaiTi | content | `docx.eastAsia-runs` |
| DOCX | 列表段丢掉 `w:numPr` | content | `docx.numbered-list` |
| XLSX | 删条件格式 | delete | `xlsx.conditional-formats-any`（+ features） |
| XLSX | 删合并单元格 | delete | `xlsx.merges-any`（+ features） |
| XLSX | 公式 D2→E2（同一行） | **relocate** | `xlsx.formula-cells` |
| XLSX | 图表锚点挪到 (col 8,row 25) | **relocate** | `xlsx.drawing:…drawing1.xml` |
| XLSX | 跨 sheet 公式改引用范围 | content | `xlsx.formula-cells` |
| PPTX | 删 `p:timing` | delete | `pptx.animations-any`（+ 该页） |
| PPTX | 清空备注正文 | delete-form | `pptx.notes:…notesSlide1.xml` |
| PPTX | 删 `<p:pic>` | delete | `pptx.elements:…slide1.xml` |
| PPTX | 动画时长 700→1500ms | content | `pptx.animations:slide1` / `-any` |
| PPTX | 图片字节换成另一份 PNG | content | `pptx.media:…image1.png` |
| PDF | 删 `/Outlines` | delete | `pdf.outline` |
| PDF | 书签目的地第 1 页→第 2 页 | **relocate** | `pdf.outline` |
| PDF | 清空 `/Annots` | delete | `pdf.annotations` |
| PDF | 批注内容改一个词 | content | `pdf.annotations` |
| PDF | 书签标题改一个词 | content | `pdf.outline` |
| Markdown | 删围栏代码块 | delete | `md.code-blocks`（+ part-order） |
| Markdown | 图片引用挪到文末 | **relocate** | `md.part-order` |
| Markdown | 表格单元格改一个词 | content | `md.tables` |
| Markdown | 嵌套列表缩进抹平 | content | `md.nested-list` |
| HTML | 删 `<svg>` | delete | `html.inline-svg`（+ part-order） |
| HTML | `<svg>` 挪到 `<script>` 之后 | **relocate** | `html.part-order` |
| HTML | 删 `<style>` | delete | `html.style-blocks`（+ part-order） |
| HTML | CSS 声明改值 | content | `html.style-blocks` |
| HTML | 脚本内容改一处 | content | `html.script-blocks` |
| HTML | SVG 圆半径 18→9 | content | `html.inline-svg` |

**未覆盖的变异形态**（如实记）：

- **PPTX 备注「换页」**：真正的 relocate 需要新建 notesSlide + rels +
  content-types（手写 OOXML 会引入比判据更多的手工结构），本卡退化为「清空
  备注正文」，验证的是「判据盯着这一页的备注，不是一个全局字符串」。表里
  标注为 `delete-form`。
- **DOCX header/footer 部件整体删除**没单独做变异（header 文本改词已证明
  `hf-part` 读的是内容）；同理 PDF 的 markup 类批注未做（见 7.4）。
- 每个变异体只做**一次**变异；没有做「两个部件同时坏」的组合变异。

### 7.6 本套件怎么跑

```bash
# 六条旅程 + 判据变异（两段都过才绿）
pnpm test:smoke o0-format-fidelity-smoke

# 只跑旅程 / 只跑某格式的变异（调试用）
cd apps/desktop && node scripts/o0-format-fidelity-smoke/run.mjs --only=docx-fidelity
cd apps/desktop && node scripts/o0-format-fidelity-smoke/mutate.mjs --only=pdf
```

- 证据：`.tmp/electron-u1/<时间戳>/<format>-fidelity/`（基线/比对 JSON + 截图 +
  每代进程的 log）；变异报告：`.tmp/o0-mutations/mutation-report.json`。
- 套件自己造夹具（`fixtures/build.ts`）：DOCX/XLSX/PPTX 用 vendor 引擎与 CLI
  造，PDF 用 pdf-lib 造、pdf.js 读（生成与读取是两份独立实现）；**不搬用
  t7 的极简夹具、不改 t7 的任何旅程**。

### 7.7 套件结果（本次交付）

```
pnpm test:smoke o0-format-fidelity-smoke   → PASS
U1 suite: 6 journeys — all-pass=6 expected-failure=0 unexpected-failure=0
O0 mutate: 32 个变异体，全部按预期变红
npx tsc --noEmit -p apps/desktop/tsconfig.json → 0 error
node scripts/t7-genoffice-u1/run.mjs（基线，未改）→ 六格式 all-pass，exit 0
git status apps/desktop/scripts/t7-genoffice-u1/ → 无改动
```

### 7.8 提交

见提交 SHA（交付回报里给；本卡文件与 `o0-format-fidelity-smoke/**` 同一次提交）。


---

## 2026-10-25｜主线补充 U1：原厂 Slides 备注、切换、章节、批注、撤销/重做、PPTX 重开

**归属：现有 O0 / ARC-007（不新建重复业务迁移任务）**。本次在复核 `documentViewPreload.ts` 的历史假空值后，沿**当前生产入口**确认：原生 Slides 视图实际由 `genofficeNativeVendor.createNativeView('slides')` → `createSlidesView(path)` → 原厂 `apps/slides/src/preload/index.ts` + 原厂 `registerSlidesIpc` 服务。Mcode 的旧公共 `documentViewPreload.ts` 内部 `getNotes:'', getTransition:'none', getAnimations:[], getSections:[]` 并非该原生 Slides 生产路径的源头。不能误把旧兼容 fallback 的空值当作现行原生 Slides 的全部功能缺失，也不应该在 Mcode 自己重写一套动画/备注数据模型。

**新增可复跑真 Electron 旅程**：`apps/desktop/scripts/office-perf-u1/journeys/slides-native-semantics.ts`，`node apps/desktop/scripts/office-perf-u1/run.mjs --only=slides-native-semantics`。沿用 T7 的 `editorSetup('slides')` / 受信工作区 / 原生 preload / 原厂 main handler / 两个独立 Electron OS 进程与隔离样本，不修改用户原文件，不 mock 原厂编辑业务，也不依赖不可捕获的显示器截图。判据包括：

1. 真原厂 preload 返回文档第一页的 notes / animations / sections / transition，且 Mcode Host 已承认唯一 opened session。
2. 原厂 `setNotes(0,text)` 写入独一无二备注，再 `getNotes` 回读；`setTransition({slideIndex:0,kind:'fade'})`；`addSection({atSlideIndex:0,name})`；`addComment({slideIndex:0,text})`，每项立即用各自原厂读取接口确认。
3. 原厂 `undo()` 必须把刚添加的批注撤销，`redo()` 必须使批注恢复。这里测试的是原厂唯一 session/history，而不是自行维护一个 DeckSession。
4. 原厂 `slidesApi.save()` 必须真正改变磁盘 PPTX SHA256，`DocumentViewHost.close` 清除会话。
5. 启动**第二个操作系统进程**重新打开保存后的 PPTX，备注、fade 切换、章节名称、批注内容都必须真实存在；animations 必须返回结构化原厂数组（当前样本本身没有动画，所以**没有声称动画写回已验**）。

**实际执行**：四轮逐步扩展的真 Electron `1/1 PASS`，最终记录 `.tmp/electron-u1/2026-10-25T08-06-01-389Z/slides-native-semantics/journey-result.json`（重启两次不同 OS 进程）。类型检查 `npx tsc --noEmit -p apps/desktop/tsconfig.json` 与 `npx tsc --noEmit -p packages/contracts/tsconfig.json` 均 PASS。联合 `run-smokes.mjs genoffice-native-view-smoke slides-edit-smoke slides-preload-abi-smoke o0-format-fidelity-smoke` **未运行**：执行前因其他对话重型测试锁 PID 30632 被拒（日志 `apps/desktop/.tmp/smoke-runs/1792915630245-36032-MoAjKw`），未抢锁；不可写成 PASS。

**未完成与真实阻断**：这次没有完成真实 GUI 的评论/章节/动画控件手势（直接走**同一生产 preload 接口**），没有构造带动画的 PPTX 并进行 setAnimations/undo 的重开保真，也未验证 Word/WPS 打开该改后 PPTX。Docs 原厂二进制崩溃恢复在 Mcode 受限 preload `writeRecoveryCopy` 仍显式 `{ok:false}`：原厂实现涉及密码保护、版本竞态、用户丢弃稿后的恢复副本清理，不能直接启用原厂全局 userData 写入或拿 UTF-8 FileSnapshot 冒充 DOCX 原生恢复；需以原厂算法 + Mcode 受信路径/同版本清理/授权的单一数据存储接入，**本次未修复**。ARC-007 整包开发/独立复核仍不应打勾。

**补充重跑**：其他对话重型测试锁释放后，`node apps/desktop/scripts/run-smokes.mjs slides-edit-smoke slides-preload-abi-smoke genoffice-native-view-smoke` 已 **3/3 PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792915736202-22704-HqAZ0Z`。原先四套套件的联合尝试仍是因测试锁未执行，不能以这次三套结果冒充原始第四套也已跑。
