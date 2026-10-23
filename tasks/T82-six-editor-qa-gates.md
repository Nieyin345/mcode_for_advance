# T82｜六编辑器的 QA 门禁：它们真的会报问题吗

- Status: ready-for-agent
- Category: **产品主线验收（GenOffice）**
- Priority: **P0** —— 这是「AI 改文档又烂又丑」的另一半（PPT 那条已由 T65/T75 处理）
- Depends on: T43（`0a2aa805`，门禁接线）、T24（工具面）、T47（设计规范）
- Exclusive writable files: **只读 + `.tmp/` 探针**。不改任何产品文件。

## Required Skills
- `mcode-smoke`：无头探针。
- `code-review`：判断「门禁跑了」和「门禁能抓到问题」是两件事。

## 背景：门禁现在都有值了，但没人验过它们抓不抓得住东西

`documentToolSurface.ts:88-95`：

```ts
export const DOCUMENT_QA_GATES = Object.freeze({
  docs: ["check"],
  sheets: ["check"],
  slides: ["audit"],
  pdf: ["render-probe"],
  markdown: ["render-probe"],
  html: ["render-probe"],
});
```

**六个 app 都有门禁了** —— T43 修的。

但今天已经证明过好几次：**「有门禁」≠「门禁能抓到问题」**。

- T65 的留白判据：形式在、跑得动、22/22 全绿，**但它抓错了对象**；
- T73 的接线：`checkDeckPatterns` 被调用了，**但模型看不见**；
- T67 的 `|| true`：断言写了，**但恒真**。

**所以本卡问：这六道门禁，每一道真的会报问题吗？**

## 任务

### 第一步：先看每道门禁做什么

```bash
grep -n "DOCUMENT_QA_GATES\|runQaGate" apps/desktop/src/main/document/documentToolRuntime.ts
```

**逐 app 回答**：

| app | 门禁 | 它检查什么 | 报的是「内容质量」还是「能不能渲染」 |
|---|---|---|---|
| docs | `check` | ? | ? |
| sheets | `check` | ? | ? |
| slides | `audit` | 几何（出界/溢出/重叠/变形） | **只能验几何** |
| pdf | `render-probe` | 能不能排版 | **不是内容质量** |
| markdown | `render-probe` | 同上 | 同上 |
| html | `render-probe` | 同上 | 同上 |

**`DOCUMENT_QA_GATE_LABELS` 自己说得很清楚**：

> `render-probe`: "可渲染性检查（原厂渲染器试排一次；**检的是能否排版，不是内容质量**）"

**那么问题来了**：pdf / markdown / html 三个 app，**除了「能不能渲染」，没有任何内容检查**。

**这是缺陷还是设计？** 你要判断。

### 第二步：每道门禁造一个「该报」的输入

**关键：要造「真实会犯的错」，不是「为了让它报而造的错」。**

参考今天 E 在 T75 踩的坑：它造的「坏样本」其实是「卡片矮」，不是「空柱子」。**造出来的坏样本必须真的坏。**

逐 app 建议：

| app | 造什么 |
|---|---|
| **docs** | 一个 `.docx`，标题层级混乱（跳级 h1 → h3）、或者表格跨页断裂 |
| **sheets** | 一个 `.xlsx`，公式引用了不存在的 sheet、或者数字格式不一致 |
| **slides** | **已经有 T63 的溢出夹具** —— 直接复用，确认它报 |
| **pdf** | 一个内容溢出页面的 pdf（文本超出页面边界） |
| **markdown** | 一个表格列数不一致的 md（CLI 会报「表格退化」吗） |
| **html** | 一个没有闭合标签的 html |

**每一条都要有「正控（合规的不报）+ 负控（违规的报）」**。

### 第三步：记录真实结果

**如果某道门禁抓不到**：

- 写明它抓不到什么；
- 判断这是**门禁能力边界**（CLI 就没这个检查）还是**接线问题**（CLI 能报但没传上来）；
- **两者的修复成本差一个数量级**。

## 验收判据

1. **六个 app 的门禁能力表**：每道门禁**检查什么、不检查什么**。
2. **每道门禁的正控 + 负控实际运行结果**（不是「应该会报」）。
3. **抓不到的**：写清是「CLI 没这能力」还是「接线丢了」。
4. **对 pdf / markdown / html 三个 `render-probe` 的判断**：它们只有「能不能渲染」，这够不够。
5. **不改产品代码**（发现要改，报告给总控）。

## 边界

- **只读 + `.tmp/` 探针**；
- **不改产品文件、不改套件**；
- 不跑全量、**不起 Electron**；
- 用真 CLI（`genoffice/packages/cli/dist/genoffice.cjs`）造夹具。

## 遇到问题先检索

`genoffice guide <domain> <topic>` 是规范原文。**先读它，再判断「这算不算问题」**。

**不要用自己发明的标准判断「这是缺陷」** —— 上游规范说什么是问题，才算问题。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T82-six-editor-qa-gates.md` 末尾追加 `## 结果回写（2026-10-23）`：
能力表、每道门禁的正负控实际结果、抓不到的归类、render-probe 够不够的判断、提交 SHA。

## 结果回写（2026-10-23）

### 一、卡上的两条假设要**修正**（先核实前提的结果）

#### 假设 1：「pdf / markdown / html 除了能不能渲染，没有任何内容检查」——**属实，但不是 Mcode 的问题**

这是**上游 GenOffice 没有这三个域的 check 命令**：

```
genoffice <command> 只有 docs / sheet / slides 三家带 check/audit
pdf   子命令只有 read
```

**Mcode 侧 T43 已经查清并做了正确选择**，代码注释原文：

> 【T43】pdf/markdown/html 原本是空数组。查清上游后的事实：
> - **没有** `pdf check` / `markdown check` / `html check` 命令
> - 但 `render` 是**真的会失败**的：坏 HTML、超限字体、无法排版的文档都会 `conversion_failed` / `app_crashed`
>
> 所以这三个 app 的门禁是 `"render-probe"` —— 它跑真命令、真读返回值，检的是**可渲染性**，不是内容质量。`formatQaReport` 会把这一点写在给模型的正文里，**不冒充 `docs check`（那才是「假门禁」）**。

**所以这不是缺陷，是如实的能力边界标注。** 卡上问「这是缺陷还是设计？」——**答案：设计，而且判断正确。**

#### 假设 2：卡让我判断「门禁能不能抓到」——**能，而且比预期细**

### 二、六道门禁的能力表（从源码读出来的真实清单）

**`docs check` —— 10 项**（`packages/cli/src/formats/docx-check.ts:5`）：

```
field_not_evaluated  broken_ref  toc_stale  missing_image  chart_empty
empty_heading  heading_skip  placeholder_left  pending_revisions  unresolved_comments
```

**`sheet check` —— 8 项**（`packages/cli/src/formats/xlsx-check.ts:12`）：

```
formula_error  formula_not_evaluated  missing_sheet_ref  defined_name_broken
chart_ref  number_overflow  placeholder_left  rules_present
```

**`slides audit`** —— 几何：出界 / 文字溢出（宽/高）/ 重叠 / 变形，带 `setTransform` 修复建议

**`render-probe`**（pdf / markdown / html）—— 只答「能不能被原厂渲染器排成 PNG」。代码里把范围写死进 `scope` 字段原样带给模型。

**注意**：卡上猜的三个检查项**全都真实存在** —— `heading_skip`、`missing_sheet_ref`、出界/溢出都在清单里。

### 三、正控 / 负控实际运行结果（不是「应该会报」）

| app | 负控（造出来的真错） | 结果 | 正控（合规） | 结果 |
|---|---|---|---|---|
| **docs** | `h1 → h3` 跳级 | **`heading_skip`** `block[2]` `"heading level jumps from 1 to 3"` | 层级正常 | `no issues found (10 checks)` |
| **sheets** | `=NoSuchSheet!A1` | **3 个 error**：`formula_error` + **`missing_sheet_ref`** `"formula references a sheet that does not exist: NoSuchSheet"` | 正常公式 | `no issues found (8 checks)` |
| **slides** | 文字远超框高 | **`out_of_bounds`** `"14740px past the bottom edge"` + `text_overflow_width`，附 `setTransform` 建议 | 正常 deck | `no layout issues` |
| **markdown** | 表格列数不一致 | **渲染成功，不报** | — | — |
| **html** | 标签未闭合 | **渲染成功，不报** | — | — |
| **pdf** | （未造：pdf 是输出格式，不是输入） | — | — | — |

**markdown / html 那两条要如实说**：坏样本**真的坏**（表格列数确实不一致、标签确实没闭合），但 `render-probe` 不报。**这符合它的自我声明**——浏览器和 Markdown 渲染器本来就容忍这两种错。**不是判据失效，是判据的范围就那么大。**

### 四、抓不到的，是「CLI 没能力」还是「接线丢了」

| 现象 | 归类 | 依据 |
|---|---|---|
| markdown 表格列数不一致不报 | **CLI 没这能力** | 上游没有 `markdown check`；`render` 只验可渲染性 |
| html 标签未闭合不报 | **CLI 没这能力** | 同上；且 HTML 渲染器天然容忍未闭合标签 |
| pdf 无内容检查 | **CLI 没这能力** | 上游 `pdf` 只有 `read` |

**没有一例是「接线丢了」。** 这一点很重要：三处「没有检查」全部来自上游能力缺失，不是 Mcode 漏接。

### 五、对 `render-probe` 够不够的判断

**够，但前提是范围必须传给模型。**

- `render-probe` 在 pdf/md/html 上是**能做到的最好**（上游没有更好的）；
- **Mcode 做对了最关键的一件事**：`extractRenderProbeReport` 把范围写进 `scope` 字段：

```
只验证了「<app> 能被原厂渲染器排版成 PNG」（页数 N）；
**没有**检查内容正确性，也**没有**判断排版是否好看。
```

**所以模型不会把「出图成功」读成「内容正确」。** 这是 T43 的核心判断，是对的。

**若要补内容检查**，只能走「render + 模型看图」这条路（文档里也是这么建议的），那不是门禁，是 review。

### 六、一个意外发现：`create` 有更早的一道防线

造越界 slides 时，`genoffice create --type pptx --spec` **直接拒绝了**：

```
no valid pages (element 0: outside the 1280x720 canvas, dropped)
```

**构建期就挡了**，比 `audit` 更早。所以 `audit` 面对的是「已经构建成功但几何有问题」的 deck（例如用 `slides apply` 事后改出来的）。

### 七、一处需要你知道的细节：`docs check` 的严重度

`heading_skip` 报的是 **`level: "info"`**，`counts` 是 `{error:0, warning:0, info:1}`。

**但 Mcode 的 `extractQaReport` 不按 severity 过滤** —— 它把 `detail.issues` **原样全传**。所以 info 级的问题也会到模型那里。这一点是对的（门禁的价值在于让模型知道，不是在于分级）。

### 八、未做 / 边界

- **未跑全量**、**未起 Electron**、**未改任何产品文件或套件**；
- **pdf 的负控没造**：pdf 是输出格式，`render-probe` 对它的语义是「这份 pdf 能不能再排一次」，造一个有问题的 pdf 意义不大；
- 夹具都在 `.tmp/t82/`，未入库；
- 一个操作失误要记：我第一次用 `node -e` 写夹具，路径里带了 `/d/` 前缀导致 ENOENT —— 违反 CLAUDE.md「临时脚本先写文件再执行」，改用 `Write` 工具后正常。

### 九、提交

见 `git log`（只含本卡回写）。

## 追加：产品视角复核（2026-10-24，总控要求）

> 问题：**今天修的东西，用户能感觉到吗？**

### 一、反模式提示的时序：**build 之后才出现，且是整 deck 一次给**

| 环节 | 时机 |
|---|---|
| `readDeckPatterns` | `build_deck` **执行前**跑（读整个 specDir 的全部页面） |
| `withPatternFindings` | 挂到 CLI 返回的信封上 |
| `patternFindingsText` | `envelopeText` 渲染时输出 → **build 完成后**返回给模型 |

**所以模型拿到提示时，整个 .pptx 已经生成完毕。** 要改只能重新写 spec、重新 build 整个 deck。

**而 `genoffice guide slides design` 明文要求的是一页一页检查**：

```
| 3 pages | deck/pages/01.json, 02.json, … | genoffice slides check deck/pages/NN.json after writing each |
```

**Mcode 的工具面没有把这条流程暴露出来** —— `slides check` 在 `document_tools_list` 里没有路由（T73 回写已记录过这一点）。**模型只能走 `build_deck` 一把梭，然后拿到一份「事后总结」。**

### 二、实测：按提示改，deck 会变好吗？**不会，会更空**

用 T62 那类「三根空柱子」造了 BAD，跑判据，再按它给的提示（「考虑缩短卡片或补足卡内内容」）改一遍：

| | findings | 元素总面积占画布 |
|---|---|---|
| **改前**（三张 480 高的卡，文字贴顶） | `card-whitespace` × **3** | **63%** |
| **按提示缩短卡片到 60 高** | `card-whitespace` 清零，**但立刻出现 `layout.whitespace`** | **11%** |

**这是打地鼠**：照做 A 提示 → 触发 B 提示；照做 B → 又触发 A。**而且每修一次，页面更空。**

**根因**：两条判据的参考方向相反——
- `card-whitespace` 要求「卡片别高于内容」→ 卡片变矮；
- `layout.whitespace` 要求「内容铺满页面」→ 需要更多内容/更高元素。

**卡变矮之后页面当然更空。** 提示没说「同时补内容」，模型照做就成了「把卡片压扁」。

### 三、机器判据和人的判断一致吗？**不一致，而且方向反了**

三个 deck，同一套判据打分：

| deck | 人的判断 | 机器 findings |
|---|---|---|
| **BAD**（空柱子 + 三色卡片 + 顶部色条） | **最丑** | **3 条**（都是 card-whitespace） |
| **MID**（朴素但干净） | 中等 | 1 条 |
| **GOOD**（深色封面 + 柱状图 + 同色系阶梯） | **最好** | **2 条** |

**GOOD 被误报的两条，恰恰是「好设计」：**

**① `palette.rainbow`（error 级）报在数据页**

那三根柱子是 `#1F3A5F` / `#3E6E9E` / `#6FA3D2` —— **同一蓝色的深浅阶梯**，是数据可视化的标准做法。

判据源码（`deckPatternCheck.ts:171-183`）：

```ts
const colors = new Set<string>();
for (const e of page.elements ?? []) {
  if (e.type !== "shape") continue;
  const f = fillOf(e);
  if (!f || isNeutral(f) || isFullBleed(e)) continue;
  colors.add(f);          // ← 按色值字符串去重
}
if (colors.size <= 2) return [];
```

**`isNeutral` 只判「是否接近灰/极亮/极暗」，完全没有色相判断。** 同色相三个明度 = 三个"不同颜色" = 报 error。

**后果：一份做得好的数据可视化 deck，会被报成最高严重度的 error。**

**② `layout.whitespace` 报在封面页**

封面是深底 + 居中标题，本来就该留白。判据里**有** cover 豁免：

```ts
const type = page.type ?? "content";
const threshold = type === "cover" || type === "closing" ? loose : tight;
```

**但豁免只认 `page.type === "cover"`。** 模型写 spec 时如果没写 `type` 字段（`page()` 帮助函数默认不带），就按 `"content"` 走 tight 阈值 → 必报。

**豁免形同虚设**：它在等一个模型通常不会填的字段。

### 四、结论

**今天这些判据，在「抓空柱子」这件事上是对的**（BAD 抓到了 3 条，位置精确到 x 坐标）。

**但在「什么样的 deck 好看」这件事上，它们和人的判断方向不一致**：

1. **误报好设计**（同色系阶梯、封面留白）；
2. **照做会把 deck 改得更空**（打地鼠）；
3. **只在事后给提示**，而规范要求的是逐页检查。

**所以「用户能感觉到吗」的答案是：部分能（空柱子会被报出来），但用户如果按提示改，deck 不会变好看。**

### 五、建议（不改，报告）

| # | 问题 | 建议 |
|---|---|---|
| 1 | `palette.rainbow` 无色相判断 | 按**色相**聚类，同色相不同明度算一个色 |
| 2 | cover 豁免靠 `page.type` | 用**几何特征**判封面（全幅背景 + 元素少）或从 outline 的 `type` 取 |
| 3 | 打地鼠 | 两条判据的提示要**互斥或联动**：缩卡时提示「同时补内容」 |
| 4 | 只在 build 后给 | 把 `slides check` 路由进工具面，让模型能逐页查（guide 要求的流程） |

**未改任何产品代码。** 夹具在 `.tmp/t85/`，探针已删。

## 追加：漏报抽查（2026-10-24）

> 总控：**「你验过 `heading_skip` 和 `missing_sheet_ref` 能报，但没验另外 8 项 / 6 项会不会漏。」**

### 抽了三项（都是模型真实会犯的错）

| 判据 | 我造的坏样本 | 结果 |
|---|---|---|
| `empty_heading` | docx 里一个 `## `（二级标题但无文字） | **报**：`block[2]` `"heading level 2 has no text"` |
| `placeholder_left` | docx 正文含 `{{company_name}}` | **报**：`block[1]`，还带上下文 `#1 "这里应该写 {{company_name}} 的年度报告。"` |
| `number_overflow` | xlsx 一个 39 位数字在默认列宽 | **报**：`Sheet1!A:A` `A2 "1.00000E+11" needs about 74 px, the column is 59 px`，附 `suggest: set_col_width widthPx 81` |

**正控**：干净 docx `no issues found (10 checks)`、干净 xlsx `no issues found (8 checks)`。

### 一次真实的假阴性，和它为什么不是缺陷

`number_overflow` 第一次**没报**。我差点记成漏报。

查下来是**我的样本造错了**：

```bash
$ genoffice sheet read overflow.xlsx --where number --json
{"summary": "Sheet1!A1:B2: 0 number cells"}
```

**那个 39 位数字被 `create --from` 存成了文本**，而 `number_overflow` 的判据是：

```ts
const number = Number(c.value)
if (!Number.isFinite(number)) continue   // ← 文本直接跳过
```

改成 **JSON 数字字面量**后立刻报出来。

**这和 T82 里 markdown / html 那两条是同一类**：**判据没报，是因为它从来就不负责那个输入形态**，不是它失效了。

### 结论

**抽查的 3 项全部正常，没有发现漏报。** 但要注意：

- 这只覆盖了 **3/10 + 3/8** 项（`heading_skip`/`missing_sheet_ref` 之前验过，共 2+3=5 项）；
- **`field_not_evaluated` / `broken_ref` / `toc_stale` / `missing_image` / `chart_empty` / `pending_revisions` / `unresolved_comments`（docs 剩 7 项）与 `formula_not_evaluated` / `defined_name_broken` / `chart_ref` / `placeholder_left` / `rules_present`（sheet 剩 5 项）未验**；
- 剩余 12 项里有几项需要**真实带批注/修订/图表的文档**才能造，成本比今天这三项高一个量级。

**不能把「抽了 3 项都好」说成「10 项都好」** —— 这正是 T77 那条「3/19 不能推成 19/19」的同型。
