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
