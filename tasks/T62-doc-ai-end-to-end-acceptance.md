# T62｜文档 AI 链路端到端验收 —— 产出的 PPT 真的好看吗

- Status: ready-for-agent
- Category: **验收（P0 产品能力）**
- Priority: **P0 —— 这条决定用户「AI 改 PPT 又烂又丑」的抱怨是否真的解决**
- Depends on: T43（`0a2aa805` + `a48066a9`，工具面）、T47（`0bf8a957`，设计规范）
- Exclusive writable files: **只读 + `.tmp/` 下的探针**。不改任何产品文件。

## Required Skills
- `mcode-smoke`: 理解这套 CLI 的调用方式。
- 无前端/Electron 需求。

Read before work: `CLAUDE.md`、`tasks/T43-document-ai-design-pipeline.md` 回写区、`tasks/T47-model-cannot-reach-design-guide.md` 回写区、`genoffice/skills/genoffice/SKILL.md` 的 `## Designing a deck` 全节。

## 背景：今天修了这条链，但没人验过产出

| 修了什么 | 卡 | 证据 |
|---|---|---|
| `document_md_read` 只能读 docx → 六格式分派 | T43 | 57/57 |
| `build_deck` 接在死分支上 → 挪进 slides 分支 | T43 | TS2367 抓到 |
| PPT 设计流水线 → 快照围栏 + `create --spec --render --audit` | T43 | 57/57 |
| 模型拿不到 `guide slides design` → `document_guide` | T47 | 27/27 |

**但这四张卡验的都是「工具在不在、路由对不对」，没有一张验「产出的东西好不好看」。**

## 目标

**亲手走一遍模型会走的设计流水线，判断产出质量。**

### 第一步：确认工具都在（只读）

```bash
cd "D:/副桌面/文件夹/work_space/work_for_reseach/mcode"
grep -n "document_guide\|document_render\|document_tool_call" apps/desktop/src/main/appControl/tools.ts | head -5
grep -n "build_deck" apps/desktop/src/main/document/documentToolSurface.ts | head -3
```

### 第二步：按模型的方式走一遍完整流程

**① 拿设计规范**（这是 T47 修的那一步）：

```bash
node genoffice/packages/cli/dist/genoffice.cjs guide slides design --json | head -60
```

**② 按规范写一个最小 deck**（3 页）：

```
.tmp/t62-deck/
  style.md          ← 按规范写的设计系统
  outline.json      ← 3 页大纲
  pages/01.json     ← 封面
  pages/02.json     ← 内容页
  pages/03.json     ← 收尾
```

**规范里明确要求的东西必须用上**：
- style sheet 有背景色、颜色（至多两个强调色）、字体、布局库；
- 布局名从规范的 18 种里选（`cover_typography_hero` / `three_column_cards` / `hero_big_number` …）；
- 排版数值：CJK 字符约 `sizePt × 1.35` px 宽、标题间距 ≥ 20px 等。

**③ 逐页 check**：

```bash
node genoffice/packages/cli/dist/genoffice.cjs slides check .tmp/t62-deck/pages/01.json --json
```

**④ 出图 + 审计**：

```bash
node genoffice/packages/cli/dist/genoffice.cjs create --type pptx \
  --spec .tmp/t62-deck/pages --outline .tmp/t62-deck/outline.json \
  --out .tmp/t62-deck/deck.pptx --render .tmp/t62-deck/shots --audit --json
```

### 第三步：亲眼看产出

**读那几张 PNG**（`Read` 工具能看图片），逐张判断：

1. **有没有规范明列的反模式**？
   - 「每张卡片左侧的细竖条」
   - 「彩虹卡片：每项一个强调色」
   - 「装饰性角落方块」
   - 「每页都是形状 + 粗副标题 + 描述」
   - 「封面是平的标题加副标题」
   - 「用 emoji」
2. **排版有没有问题**？溢出、重叠、压边、大片空白。
3. **配色是不是只有一两个强调色**？

### 第四步：读 `detail.audit`

`create` 的返回里有 `detail.audit`（几何审计：出界/溢出/重叠/变形）。

## 验收判据

1. **回写区先回答：整条流程能不能走通？** 哪一步卡住，卡在哪。
2. **产出的真实质量判断**（你亲眼看的，不是读代码推的）。
3. **规范有没有被用上？** 具体到：用了哪个 layout、字号是多少、间距对不对。
4. **`detail.audit` 报了什么？**
5. **最该改的地方是什么？**（按严重程度列）
6. **如果哪一步失败了，停下报告，不要绕过。**

## 边界

- **只读 + `.tmp/` 下的探针**；
- **不起 Electron**；
- **不跑全量**；
- **不改任何产品文件**（这是验收，不是修复）。

## 遇到问题先检索

**报错、API 用法先看 `genoffice guide slides design` / `guide slides spec` 的原文，不要凭猜。**

## 结果回写（2026-10-23，E 会话）

### 1. 整条流程能不能走通？—— **能，全通**

| 步骤 | 结果 |
|---|---|
| `guide slides design --json` | ✅ 返回完整规范（style/outline/pages/build/QC 五阶段 + 反模式清单） |
| `capabilities --json` | ✅ 正确报告：搜索/图搜/生图**全部未配置**，只有 `app` 可用 |
| `slides check outline.json` | ✅ 4 页，零 findings |
| 逐页 `slides check pages/NN.json` | ✅ 四页最终都 `page builds clean` |
| `create --spec --render --audit` | ✅ 4 张 PPTX + 4 张 PNG |

**没有一步卡住。** 工具链是通的 —— T43/T47 修的那条路确实接上了。

### 2. 产出的真实质量（我逐张看的图）

**封面**：深色底 + 右侧整条蓝色块，标题 44pt 白字左对齐，副标题 18pt 灰，底部 13pt 脚注。**干净，有视觉锚点**，不是「平标题 + 副标题」。✅

**内容页（三条护城河）**：三张白色圆角卡，标题 22pt 加粗，正文 14pt。**但有明显问题**：卡片被我加高到 452px 后，**每张卡内部下半截是空的**（文字只占卡片上部约 1/3）。视觉上像「三根空柱子」。

**数据页（KPI）**：四个数字 452/138/94/74，64pt，主数字用蓝色。同上问题：**数字偏上，卡片下半空**。

**收尾页**：深色底 + 顶部蓝色细条 + 40pt 主句。**干净。** ✅

**反模式检查**：
- ❌ 「每张卡片左侧的细竖条」——**没有**，✓
- ❌ 「彩虹卡片」——**没有**，只有一个蓝色强调，✓
- ❌ 「装饰性角落方块」——**没有**，✓
- ❌ 「每页都是形状+粗副标题+描述」——**部分中招**：内容页和数据页都是「标题 + 卡片阵列」，两页构图相似
- ❌ 「封面是平的标题加副标题」——**没有**，有蓝色块做锚点，✓
- ❌ 「emoji」——**没有**，✓

### 3. 规范有没有被用上？—— **用上了，而且是逐条被 CLI 强制执行的**

这不是「参考了规范」，是**规范被写进了检查器**：

- **layout 名**：`cover_dark_minimal` / `three_column_cards` / `kpi_cards_row` / `closing_cta`，全部来自规范那 18 种；
- **字号**：标题 36–44pt、正文 13–15pt、KPI 64pt —— 都在规范的 type scale 里；
- **配色**：写 `#A8B0BC` / `#6C7684` 两个灰色时，`offPalette` **当场报出来**，逼我补进 style.md；
- **标题一致性**：页面文字里没出现 outline 的标题，`outline.findings` **报出来**；
- **几何**：标题框压到副标题，`audit` 报 `Overlap ... intersect by 700×21px`；正文超宽，报 `Text overflow ... exceeds by 18px`。

**这是这次验收最有价值的发现**：规范不是文档，是**可执行的检查**。我写错的每一处都被抓住了。

### 4. `detail.audit` 报了什么？

**最终：`{"error": 0, "warning": 0}`，四张 slide 全空。**

过程中报过、被我修掉的三条（都很准）：
1. 页 1：标题框与副标题 `Overlap ... 700×21px`；
2. 页 2：第三张卡正文 `Text overflow (width) ... exceeds by 18px`；
3. `offPalette`：`#A8B0BC` / `#6C7684` 未在 style.md 登记（两次）。

### 5. 最该改的地方（按严重程度）

**① 检查器抓不到「留白过度」——这是最大的缺口。**

`audit` 能抓出界、溢出、重叠，**但抓不到「卡片下半截空着」**。我那三根「空柱子」在所有检查里都是零问题。而规范第 3 节明写「Fill the page: 内容铺满整个画布；不要把内容挤在上半部分，下面留一块空白」——**这条规范没有被实现成检查**。

后果：模型按规范写 deck，仍可能产出大量留白的页面，而所有检查都绿。**这正是用户抱怨的「又烂又丑」里最常见的一种。**

**② 反模式清单里只有一半可检查。**

规范第 4 节列了 7 条反模式，但 `slides check` 只实现了其中几条（palette、layout 重复、placeholder）。**「每张卡片左侧的细竖条」「装饰性角落方块」这类，检查器完全不知道**——它们只能靠模型自觉。

**③ 内容页与数据页构图雷同。**

我的两页都是「大标题 + 一排卡片」。规范要求「Vary the composition」，但没有任何检查能发现这件事。

### 6. 未做的事 / 边界遵守

- **没改任何产品文件**：全部在 `.tmp/t62-deck/` 下；
- **没起 Electron**（纯 CLI）；
- **没跑全量**；
- 只做了**一轮**修正（规范允许两轮），改的都是客观缺陷（重叠、溢出、调色板外颜色、缺单位），没有重新设计页面。

### 7. 复现方式

```bash
cd "D:/副桌面/文件夹/work_space/work_for_reseach/mcode"
node genoffice/packages/cli/dist/genoffice.cjs create --type pptx \
  --spec .tmp/t62-deck/pages --outline .tmp/t62-deck/outline.json \
  --out .tmp/t62-deck/deck.pptx --render .tmp/t62-deck/shots --audit --json --force
```

产物：`.tmp/t62-deck/deck.pptx` + `shots/deck-01..04.png`。
