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
