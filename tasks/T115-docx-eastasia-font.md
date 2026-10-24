# T115｜中文 docx 没有 `w:eastAsia`：上游有能力，CLI 没传

- Status: ready-for-agent
- Category: **P0 产品缺陷 —— T102 第 2 件的「接受上游默认」这个决定被推翻**
- Priority: **P0 —— 这是用户说「AI 改 Word 又烂又丑」的第一条原因**
- Depends on: T102（A 的诊断 + F 的实测）、`483eb29e`（同一条链上的另一处）
- Exclusive writable files:
  - `apps/desktop/src/main/document/genofficeCli.ts`（如果走 Mcode 侧）
  - 新建套件 `apps/desktop/scripts/t115-docx-eastasia-font-smoke/`

## Required Skills
- `mcode-smoke`：docx 产物字节级断言 + 变异。
- **必须先判断「改哪一侧」**（见任务一）。

## 背景：T102 当时的判断是「接受」

T102 第 2 件的回写写着：

> **第 2 件 ⚠️ 判断：有 Mcode 侧路径，但要先定字体策略**
> **`create` 没有字体选项**，所以「Mcode 侧传参」在 create 这条路上没有参数可传。
> **建议①：接受「不写 `w:eastAsia`」这个上游默认**，因为 Word 会按脚本回退到系统默认中文字体 —— **视觉上不完美，但不是错误**。

**这个判断的推理前提是「CLI 没有对应选项」。但那条前提只查了 `create --help`。**

## 实测：上游**有**这个能力，CLI 没传

**`genoffice/packages/docx-engine/src/blank.ts:500-520`**：

```ts
export interface BlankDocxOptions {
  /**
   * docDefaults East Asian font (w:eastAsia); pick per UI language so e.g.
   * Japanese/Korean users don't start with a Simplified-Chinese face.
   * When omitted no w:eastAsia is written — like an en-US Word document,
   * Word/our renderer then substitute per script when CJK text appears.
   */
  eastAsiaFont?: string
  paperSize?: BlankPaperSize
}

export async function buildBlankDocx(options?: BlankDocxOptions): Promise<Uint8Array> {
```

**而 `stylesXml(eastAsiaFont)` 会写进 docDefaults**（`blank.ts:120-124`）：

```ts
const stylesXml = (eastAsiaFont?: string): string =>
  ...`<w:rFonts w:ascii="Calibri"${eastAsiaFont ? ` w:eastAsia="${eastAsiaFont}"` : ''} w:hAnsi="Calibri"/>`...
```

**调用方（`genoffice/packages/cli/src/formats/docx.ts:207-209`）**：

```ts
export async function blankDocument(): Promise<OpenDocument> {
  return openDocument(await buildBlankDocx());   // ← 不传 options
}
```

**所以：能力在 `docx-engine` 里有，CLI 的 `blankDocument()` 没用它，Word 产物就永远没有 `w:eastAsia`。**

**这是「能修而没修」，不是「上游缺能力」。**

## 任务

### 一、先判断改哪一侧（**这一步决定卡能不能做下去**）

**三条路**：

| 路 | 做法 | 代价 |
|---|---|---|
| **A. Mcode 侧：create 之后追加一次 `apply_ops` 的 `setFont`** | 走现有 CLI 接口，不改 vendor | **多一次 CLI 调用**；且 `setFont` 写的是 **run 级**，不是 docDefaults 级 |
| **B. 改 CLI 让 `blankDocument()` 传 `eastAsiaFont`** | 一行改动，docDefaults 级，一次写对 | **改 `genoffice/`（vendor 快照）** |
| **C. 等上游** | 什么都不做 | 用户继续看到「又烂又丑」 |

**优先 A。** 理由：

- **`genoffice/` 是 vendor 快照**，改它要过「这是 Mcode 侧传参还是改上游」的判定（T102 卡上的边界就是这么写的）；
- **A 走的是现有 CLI 接口**，不需要动 vendor。

**⚠️ 但如果 A 有一个致命问题，那就要认真考虑 B：**

**`setFont` 写 run 级意味着「每个中文 run 都要写一遍」，而 `styles.xml` 的 docDefaults 仍然是空的。** 如果**上游后续的 op（比如 `insert_content` 插入新段落）会重建 run**，那先前写的 `w:eastAsia` 会丢 —— **A 只在「最后一次操作是 setFont」时有效。**

**你要实测这一点**：
1. `create --from <html>` 产出 docx；
2. `apply_ops` 一次 `setFont`（含中文的 block）；
3. **再 `insert_content` 插一段中文**；
4. **看第 3 步插入的段落有没有 `w:eastAsia`**。

**如果丢了 → A 不可行，走 B。**（那 `blankDocument()` 那一行改动要论证「这是 Mcode 需要的能力，不是上游 bug」，写进回写。）

### 二、字体选哪个（**跨平台决策，必须有依据**）

**T102 当时的顾虑是对的**：

| 候选 | Windows | macOS | Linux |
|---|---|---|---|
| `宋体` / `SimSun` | ✅ | ❌ | ❌ |
| `Microsoft YaHei` | ✅ | ❌ | ❌ |
| `PingFang SC` | ❌ | ✅ | ❌ |
| `Noto Sans CJK SC` | 部分 | 部分 | ✅ |

**我的判断**：**按运行平台选**（Mcode 是桌面应用，能拿到 `process.platform`）。

**要求**：
1. **Windows → `Microsoft YaHei`**（不是宋体：雅黑是 Windows 上的现代默认，宋体是旧式衬线）；
2. **macOS → `PingFang SC`**；
3. **Linux → `Noto Sans CJK SC`**；
4. **写进 `styles.xml` 后，产物在别的平台打开会因为缺字体而回退 —— 这是可接受的**，因为**回退到系统默认 > 混排 Calibri**。**这条要写进注释**（`CLAUDE.md` 第二十条：写条件不写方案）。

**⚠️ 但你要论证**：**「按平台选」意味着同一个 Mcode 在 Windows 和 macOS 上产出的 docx 字节不同。** 这会影响**可复现性**吗？如果套件断言「产物字节一致」，那会红。

### 三、断言

**必须验的是「产物里真的有 `w:eastAsia`」，不是「函数被调了」**：

```bash
# 解开 docx，看 styles.xml
unzip -p out.docx word/styles.xml | grep -o 'w:eastAsia="[^"]*"'
```

| 用例 | 期望 |
|---|---|
| 纯中文 HTML → docx | `styles.xml` 的 docDefaults 有 `w:eastAsia` |
| **纯英文 HTML → docx** | **仍然能生成**（正控：不能因为加字体而坏） |
| 中文 run 级（如果走 A） | 每个含中文的 run 有 `w:eastAsia` |
| **A 路径：`setFont` 后再 `insert_content`** | **新插入的中文段落也有 `w:eastAsia`**（这条决定 A 能不能用） |

### 四、⚠️ 这条不是「看起来更好」

**「Word 会按脚本回退」这句话是真的，但回退的结果是**：

- 中文字形来自系统默认（通常是宋体），**而西文来自 Calibri**；
- **行高按西文字体的度量算，中文字符会撑破行距**；
- **字重不一致** —— 用户看到的是「两种字体混在一段里」。

**这就是「又烂又丑」的第一条。** 而 T102 当时判定「视觉上不完美，但不是错误」—— **那个判断低估了它**。

## 验收判据

1. **改哪一侧有论证**（A 优先，但要实测 A 是否可靠）。
2. **产物里真的有 `w:eastAsia`**（字节级断言，不是「函数被调了」）。
3. **纯英文仍然能生成**（正控）。
4. **如果走 A：`setFont` 之后再 `insert_content` 的中文段落也有 `w:eastAsia`**。
5. **平台选择的理由写进注释**（条件不是方案）。
6. 变异：把传参删掉 → 断言红。
7. 不跑全量、不起 Electron。

## 边界

- **可以改** `apps/desktop/src/main/document/genofficeCli.ts`；
- **如果走 B**：可以改 `genoffice/packages/cli/src/formats/docx.ts` 的**那一处调用**（`blankDocument`），**但要在回写区论证「这是 Mcode 需要的能力」**，并且**不要改 `docx-engine` 本身**；
- **不碰** `deckPatternCheck.ts` / `documentToolRuntime.ts` / `policy.ts` / `TaskCenterPanel.tsx` / `store/`。

## 遇到问题先检索

```bash
sed -n '495,525p' genoffice/packages/docx-engine/src/blank.ts
sed -n '115,130p' genoffice/packages/docx-engine/src/blank.ts
sed -n '200,215p' genoffice/packages/cli/src/formats/docx.ts
grep -rn "eastAsia" genoffice/packages/cli/src/ | head
```

**先读 `tasks/T102-doc-ugly-root-causes.md` 第 2 件那一节** —— 它是这个判断的来源，而本卡要推翻它的前提。

## 回写

`tasks/T115-docx-eastasia-font.md` 末尾追加 `## 结果回写（2026-10-24）`：
改哪一侧 + 论证、A 路径的实测结果（`setFont` 后 `insert_content` 是否丢）、字体选择依据、字节级断言、变异、提交 SHA。
