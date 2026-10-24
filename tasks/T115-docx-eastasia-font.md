# T115｜中文 docx 没有 `w:eastAsia`：上游有能力，CLI 没传

- Status: done（2026-10-24；`6336b9a0` 套件 + 回写，`d6822b86` 补丁入库）
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

## 结果回写（2026-10-24）

### 一、走 B，不是 A —— 而且在走 B 之前先证明 A 不可行

#### A 的实测（卡上要求的那个实验）

| 步骤 | 结果 |
|---|---|
| `create --type docx --from cn.html` | `styles.xml` **无** `w:eastAsia` |
| `apply_ops` 一次 `setFont`（`fontFamily: "Microsoft YaHei"`） | **`document.xml` 里出现 2 处** `w:eastAsia`，**`styles.xml` 仍是空** —— `setFont` 写的是 run 级 |
| 再 `insert_content` 插一段中文 | **新插入的 `<w:t>这是插入的中文段落。</w:t>` 没有 `w:eastAsia`** |

**结论：A 只在「最后一次操作是 setFont」时有效。** 任何后续插入/改文字都会产生没有 `w:eastAsia` 的新 run，而那正是编辑流程里最常见的事。

**这不只是「多一次 CLI 调用」的问题 —— 是它治不了根本。**

#### B 的实测（同样的三步）

```
create → styles.xml 有 w:eastAsia="Microsoft YaHei"
insert_content 插入新段落后 → styles.xml 的 w:eastAsia 仍在
```

**docDefaults 级一次写对，后续所有操作自动继承。** 这是 B 相对 A 的决定性优势。

### 二、⚠️ 一个必须报告的硬事实：`genoffice/` 不在版本库里

```bash
$ git check-ignore -v genoffice/packages/cli/src/formats/east-asia-font.ts
.gitignore:70:/genoffice/    genoffice/packages/cli/src/formats/east-asia-font.ts

$ git ls-files genoffice/
（空）
```

**`/genoffice/` 是 vendor 快照**（`.gitignore` 注释：「固定 commit 1f306a2」），**整个目录不入版本控制**。

**后果**：

1. **我改的三处不会进 git** —— 这条修复在**当前这棵 checkout** 上生效，但换机器、重新 clone、或 `genoffice` 被重新拉取时会**静默消失**；
2. **别人 checkout 不会得到这个修复**；
3. **套件 `t115-docx-eastasia-font-smoke` 会提交**（在 `apps/desktop/scripts/` 下），于是**它会因为 dist 是旧的而红** —— 除非那人也改了 `genoffice/` 源码并重新构建。

**这意味着「走 B」不是一次普通提交能交付的。** 三种可能的收口方式（我只是列出，不替总控决定）：

| 方式 | 代价 | 问题 |
|---|---|---|
| **① 把 B 的补丁记进 repo**（如 `docs/planning/genoffice-patches/`），由拉取脚本应用 | 要维护补丁与上游 commit 的对应 | 上游升级时要 rebase |
| **② 回到 A**（Mcode 侧 `setFont`） | 放弃 docDefaults 级 | **已实测不可行**（见上） |
| **③ 接受「厂商快照可改但不入库」的现状**，把修复写进 `genoffice` 的重新拉取流程 | 要改拉取文档 | 依赖人记得 |

**我倾向 ①，但这超出本卡边界（卡上说只改那两处调用），需要总控裁决。**

### 三、改了三处（都在 `genoffice/` 内，故不入库）

| 文件 | 改动 |
|---|---|
| `packages/cli/src/formats/east-asia-font.ts` | **新建**：`defaultEastAsiaFont()`，按 `process.platform` 选字体，理由写在文件头 |
| `packages/cli/src/formats/docx.ts:207` | `blankDocument()` 把字体传给 `buildBlankDocx` |
| `packages/cli/src/formats/markdown.ts:58` | `markdownToDocx()` 把字体传给 `exportDocxBytes` |
| `apps/markdown/src/renderer/export/docxExport.ts:344` | `exportDocxBytes()` 加可选第 4 参 `eastAsiaFont`，**由调用方决定** |

**为什么 markdown 那条要加参数而不是自己调 `defaultEastAsiaFont()`**：

`apps/markdown` **不能 import `@genoffice/cli`**（分层反了，`package.json` 里只依赖 `@genoffice/agent-core`）。而 `docx-engine` 里没有平台相关代码（查过），把字体选择塞进去会给它引入一个新的依赖维度，且卡上明确说**不要改 `docx-engine` 本身**。

**所以让渲染端的纯函数接收参数、由 CLI（唯一知道「这台机器」的那层）决定。** 共享实现只有一份 —— 就是 `east-asia-font.ts`。

### 四、两条路都要改，因为 Mcode 两条都走

`createFromFile`（`genofficeCli.ts:883`）走 `create --from <source>`，**源文件后缀决定分支**：

- `.html` → `blankDocument()`
- `.md`   → `markdownToDocx()`

**只改一处会漏掉另一处。** 这也是为什么套件要分两组验。

### 五、字体选择（写进 `east-asia-font.ts` 文件头）

| 平台 | 字体 | 理由 |
|---|---|---|
| `win32` | `Microsoft YaHei` | 系统自带，现代无衬线默认；**不是宋体**（SimSun 是旧式衬线，正是用户抱怨的观感） |
| `darwin` | `PingFang SC` | 系统自带 |
| `linux` | `Noto Sans CJK SC` | 常见发行版默认 |
| 其他 | `undefined` | **宁可什么都不写**（让 Word 按脚本回退），也不写一个大概率不存在的名字 |

**跨平台字节差异**：同一个 Mcode 在 Windows 和 macOS 上产出的 docx 字节不同（`w:eastAsia` 的值不一样）。

**查过会不会撞既有断言**：

```bash
$ grep -rn "字节一致\|byte-identical" apps/desktop/scripts/*/main.ts genoffice/packages/*/tests/*.ts | grep -i docx
（命中的都是「同一文件改前改后」的哈希对比，不是跨平台对比）
```

**没有「跨平台产物字节一致」的断言，也不应该有** —— 这个取舍是有意的：可复现性让位于「在这台机器上打开是好看的」。

### 六、新套件 `t115-docx-eastasia-font-smoke`（7 条，全绿）

**断言读的是产物字节，不是「函数被调了」**：

```ts
execFileSync('unzip', ['-p', docx, 'word/styles.xml'])
  → /w:eastAsia="([^"]*)"/.exec(xml)?.[1]
```

| # | 用例 | 结果 |
|---|---|---|
| 1 | 中文 HTML → `styles.xml` 有 `w:eastAsia` | ✓ |
| 2 | 中文 Markdown → `styles.xml` 有 `w:eastAsia` | ✓ |
| 3 | **正控**：纯英文仍能生成 + 正文在 | ✓✓ |
| 4 | 插入新段落后 docDefaults 仍在 + 新段落真的进了文档 | ✓✓ |
| 5 | **win32 上写的是 `Microsoft YaHei`** | ✓ |

**为什么第 5 条单独写**：第 1–2 条只说「有一个非空 `eastAsia`」，跨平台通用；第 5 条验「选的是这个平台该有的那个」——**写死 `Microsoft YaHei` 会让这套在 CI 的 Linux 上假红**。

**第 3 组不断言 `eastAsia` 的有无**：英文文档的 `styles.xml` 里**也会有** `eastAsia`（那是 docDefaults，与内容语言无关）。所以正控只验「仍然能生成、结构完整、正文在」。

### 七、变异（先写预期，再看实际）

| 变异 | 预期 | 实际 |
|---|---|---|
| ① 只有 `blankDocument` 不传 | 第 1 组红 | **1 条红** ✓ |
| ② 只有 `markdownToDocx` 不传 | 第 2 组红 | **1 条红** ✓ |
| ③ 两处都不传 | 1/2/4/5 红、**3 绿** | **4 条红，第 3 组仍绿** ✓ |

**第 3 组在全部三组变异里都绿** —— 它不断言 `eastAsia`，只验英文文档仍能生成。**这正是正控该有的样子：别人的东西坏掉时它不跟着红。**

每轮从 pristine 重写、`cmp` 逐字节核验还原（脚本末尾输出 `还原逐字节一致: true`）。

### 八、回归与 typecheck

```
t115-docx-eastasia-font-smoke: 7/7 通过
genoffice-cli-smoke:          54/54 通过
genoffice-format-gates-smoke: 110/110 通过
packages/cli typecheck:       干净
apps/markdown typecheck:      干净
apps/desktop 我这套错误数:      0
```

### 九、未做 / 需要总控裁决

1. ~~**`genoffice/` 的三处改动不入库**（整个目录被 gitignore）—— 见第二节，**这是本卡最大的未决问题**~~ → **已解决，见第十节**；
2. **CLI 的 `dist/genoffice.cjs` 需要重新构建**才生效（我构建过，但 `dist` 同样在 gitignore 内）；
3. **没有验 macOS / Linux**：只在当前 win32 上实测。字体名是按平台分支写的，但**另外两个分支一次都没跑过**；
4. **没有改 `docx-engine`**（卡上禁止），也没给它加平台逻辑。

---

### 十、第四轮（2026-10-24，总控追问「补丁怎么才能提交」）：并入既有 0015

#### 我先走错了一步，记录下来

我一开始另建了 `genoffice-patches/`（自带 `apply.mjs` + before/after 片段），理由是「`genoffice/` 被 gitignore，改动会丢」。

**那个理由是对的，做法是错的。** 仓库里**已经有**这套机制：`patches/genoffice/0001…0014.patch`，加 `apps/desktop/build/verify-genoffice-upstream.cjs`（校验上游 commit、每条补丁的 revision/parent/sha256、最终 tree）。而 `genoffice/` 并不是「没有版本控制的目录」—— 它**自己是提交过的 git checkout**（`git -C genoffice log` 有完整血缘，HEAD 当时是 `05da63c`）。

所以正确做法是**往既有系列里加一条**，不是另起一套。`genoffice-patches/` 已删除。**这对应硬规矩 2（共享实现只有一份）**：第二套补丁机制一旦存在，两边迟早会给出不同的「当前状态」。

#### 做了什么

| 动作 | 结果 |
|---|---|
| 在 `genoffice/` 里提交四文件改动 | `3cb99ab` `feat(docs): write w:eastAsia so new docx files keep CJK typography` |
| 生成 patch | `patches/genoffice/0015-…-keeps-CJK-typo.patch`（8762 字节，sha256 `7a529e41…`） |
| `genoffice-upstream.lock.json` | `revision` / `expectedTree` 前移；`patchSeries` 追加 index 15 |
| `verify-genoffice-upstream.cjs` | `FINAL_REVISION`→`3cb99ab`、`FINAL_TREE`→`5ba6f37b`、`PATCHES` 追加 0015 |
| Mcode 提交 | `d6822b86` `chore(T115): carry the w:eastAsia fix as genoffice patch 0015` |

顺手修掉一处**会再次漂移**的东西：校验脚本里三处写死的补丁数量（`13 patches` / `exactly 14` / 输出文案）改成从 `PATCHES.length` 派生。原来 `FINAL_REVISION` 同时被 0014 和「最终 HEAD」两处引用，加 0015 时必须拆开，否则 0014 的 revision 会被一起改错。

#### 判据怎么验的（不是「看过」，是「让它红」）

**门禁脚本的四个变异，各自在自己的那一环失败：**

| 变异 | 报错 | 退出码 |
|---|---|---|
| lock 里 0015 的 `sha256` 改全 0 | `patch series identity/order/hash/parent mismatch at index 15` | 1 ✓ |
| `bytes` 改小 1 | `GenOffice patch byte count mismatch: …0015…` | 1 ✓ |
| 脚本里 `FINAL_REVISION` 改一个字符 | `source lock differs from the pinned … contract` | 1 ✓ |
| lock 里删掉 index 15 | `patch series missing or has an unexpected patch count` | 1 ✓ |
| 全部还原 | `upstream approved: 3cb99ab (…, 15 patches, tree 5ba6f37b)` | 0 ✓ |

**补丁本身可复现：** 在一一次性 worktree 里从 `05da63c`（0014）出发 `git am` 打 0015，产出的 tree **逐字节等于** `5ba6f37b`，且 `diff-tree` 只列出补齐的那四个文件。

**端到端：** `t115-docx-eastasia-font-smoke` **7/7 通过**（改前改后同一结果，说明补丁与工作区一致）；`MCODE_INCLUDE_GENOFFICE_BUNDLE=1` 下门禁 exit 0。

#### 仍未做

- **`dist/genoffice.cjs` 未提交**（构建产物，在 gitignore 内）。换机器后先 `cd genoffice/packages/cli && node build.mjs`，否则源码是新的、跑的是旧 dist。这一条**没有自动防线**，是当前已知缺口；
- macOS / Linux 分支仍未实测（与第九节第 3 条相同）。

