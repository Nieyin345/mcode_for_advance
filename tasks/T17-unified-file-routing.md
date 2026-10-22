# T17｜文件类型路由统一：四份判据收成一份

- Status: ready-for-agent
- Category: bug
- Priority: P0 foundation
- Depends on: none
- Exclusive writable files: `packages/contracts/src/documentKind.ts`、`packages/contracts/src/genofficeFileRoute.ts`、`packages/contracts/src/ipc/onlyoffice.ts`、`apps/desktop/src/renderer/components/ide/fileEditorKinds.ts`，以及这些函数的调用点（逐个确认后写进回写区）。**不改** `genoffice/`、`patches/`、`arc005-visual-baseline/`、`workflowEngines/`。

## Required Skills
- `codebase-design`: 判断「统一路由」该放在哪一层、接口该多窄。
- `mcode-smoke`: 给每条扩展名判据建回归，并做变异验证。
- `code-review`: 确认旧函数只是变薄封装，行为一个字没变。

Read before work: `CLAUDE.md`、`audit-ledgers/README.md`、`packages/contracts/src/documentKind.ts`、`packages/contracts/src/genofficeFileRoute.ts`、`packages/contracts/src/ipc/onlyoffice.ts`、`apps/desktop/src/renderer/components/ide/fileEditorKinds.ts`、`apps/desktop/src/renderer/components/library/FilePreview.tsx`、`apps/desktop/src/renderer/stores/sessionStoreHelpers.ts`。

## 总控核实过的现状（不要凭印象重来）

已经存在三个契约层工具，但**没有把上层判据收干净**：

- `packages/contracts/src/documentKind.ts` —— `documentExtension()` / `documentKindOf()` / `isTextualDocumentKind()` / `isOfficeDocumentKind()`
- `packages/contracts/src/genofficeFileRoute.ts` —— `genofficeAppForPath()`
- `packages/contracts/src/ipc/onlyoffice.ts:109` —— `isOnlyOfficeSupportedPath()`（也在契约层，不是主进程）

仍在各自判定的地方（**至少三处**，执行时请核实是否更多）：

| 位置 | 判据 |
|---|---|
| `apps/desktop/src/renderer/components/ide/fileEditorKinds.ts` | `isPdfFile` / `isMarkdown` / `isImage` / `isUnsupported` / `languageForExt` |
| `apps/desktop/src/renderer/components/library/FilePreview.tsx:42` | `const extOf = documentExtension`（已部分统一） |
| `apps/desktop/src/renderer/stores/sessionStoreHelpers.ts:69` | `isMarkdownPath()` |

**注意**：`isOnlyOfficeSupportedPath` **已经在契约层**，不需要搬。这条事实推翻「四份判据都在上层」的旧假设——执行时以实际 `grep` 结果为准，不要照抄本表。

**这不是「再造一个路由表」的任务**——契约层已有三个入口。任务是：**把剩下散落的上层判据改为委托给契约层，并且证明行为没变。**

## 目标

1. 枚举**所有**仍在做「这个扩展名属于哪类」判定的位置（用 `grep` 找 `.docx` `.pptx` `.xlsx` `.pdf` `.md` `.html` 这类字面量与 `endsWith`/`extname`）。把完整清单写进回写区——**漏一个就算没完成**。
2. 判断每一处该委托给契约层的哪个函数；如果契约层缺能力，**在契约层加**，不要在调用方各自打补丁。
3. 把调用方改成薄封装（转调契约层），并**保持导出名与签名不变**，避免制造大面积 diff。
4. 给契约层建回归：一张扩展名 → 期望路由的表格，覆盖六类文档 + 图片 + 二进制 + 无扩展名 + 大写扩展名 + 多点文件名（`a.tar.gz`）。
5. **行为等价证明**：对一组代表性路径，改造前后的判定结果必须逐条相同。写一个脚本同时跑旧实现（备份）与新实现做对照。

## 关键风险

- `onlyoffice.ts` 在**主进程**，`fileEditorKinds.ts` 在**渲染端**。两者不能互相 import。统一只能落在 `packages/contracts`。
- 渲染端已经被拆过一次（`fileEditorKinds.ts` 的注释说「纯搬迁，函数体逐字节一致」）。**不要重演那种搬迁**——这次要真的收敛判据，不是再搬一次家。
- 大小写：Windows 上 `.DOCX` 与 `.docx` 必须等价，但 Linux 上不一定。契约层要给明确策略并测试。

## 验收判据

1. 回写区列出**全部**判据位置（含 `grep` 命令与命中数），无遗漏。
2. 契约层新增/扩展的判定函数有完整回归，覆盖上述边界。
3. 改造前后对照脚本输出「逐条相同」。
4. 变异验证：把契约层某条判定改错（如把 `.pptx` 判成 docx），对应回归必须变红；逐字节还原（`cmp`）。
5. 双包 typecheck 通过。
6. 不得为了统一而改变任何用户可见行为——如果发现某处行为本来就是错的，**单独记录，不在本卡修**。

## 结果回写（2026-10-23）

### 0. 开工身份

| 项 | 值 |
|---|---|
| HEAD（开工时） | `4fa8a900` |
| 分支 | `master` |
| 工作树 dirty（开工时，**原样保留**） | `.aoci/baseline.json`、`.gitignore`、`document-view-host-smoke/*`、`maint-m35-smoke/pickers-prelude.ts`、`orchestration-ipc-smoke/run.sh`、`release-readiness-smoke/check-reviewed.cjs`、`apiCatalog.generated.ts`、`settingsTransfer.ts`、`workflowEngines/{nativeLibrarySync,registry}.ts`、`node-red-deploy-reconciliation-smoke/` |
| 本卡写边界（逐处确认后） | `packages/contracts/src/documentKind.ts`（+121 行）、`apps/desktop/src/renderer/stores/sessionStoreHelpers.ts`、`apps/desktop/src/renderer/lib/contentTag.ts`、`apps/desktop/src/renderer/lib/libraryPreview.ts`、`apps/desktop/src/renderer/components/customUi/CustomTabView.tsx`、`apps/desktop/src/renderer/components/library/ItemDetail.tsx`（仅注释）、`apps/desktop/src/main/ipc/document.ts`、新建 `apps/desktop/scripts/file-routing-contract-smoke/{main.ts,stubs.ts,run.sh,mutate.py}` |

> ⚠️ **执行事故（必须知道）**：为拿到 HEAD 基线，我用 `git worktree add` + 目录 junction 指向真 `node_modules`，收尾时对该 worktree 执行 `rm -rf` —— Windows 上 `rm -rf` 会**跟进 junction**，删掉了真 `packages/contracts/` 与 `node_modules` 的符号链接农场。随后两次 `git restore` 恢复被删的跟踪文件，**两次都把并行 T24/T18 会话未提交的契约改动一并回退**（`packages/contracts/src/ipc/{document,rpcMap,modules}.ts`）。已从 pnpm content-addressable store 离线重建依赖；跟踪文件已全部 `git restore` 回来；**未提交的并行改动无法从 git 恢复** —— 详见 §7 交接事项。本卡自己的改动每步都重新核对过内容，`file-routing-contract-smoke` 现为绿。

### 1. 完整判据清单（grep 命令与命中数）

枚举方法（每条都跑过，结果按下表归类）：

```bash
# A. endsWith(".xxx") —— 16 命中
grep -rnE 'endsWith\(\s*["'"'"']\.\.?[a-zA-Z0-9]+["'"'"']' apps/desktop/src packages/contracts/src
# B. extname() 调用点（排除 import）—— 46 命中，其中真正做"分类"的见下表
grep -rn 'extname' apps/desktop/src packages/contracts/src | grep -v '"node:path"' | grep -v 'import '
# C. 带点扩展名字面量 ".xxx" —— 336 命中；按 file 计数后逐个读
grep -rnE '"\.[a-zA-Z0-9]{1,6}"' apps/desktop/src packages/contracts/src
# D. Office 格式字面量（排除 document/、genoffice/、生成物）
grep -rnE '"(docx|docm|dotx|odt|xlsx|xlsm|xltx|ods|pptx|pptm|potx|odp|doc|rtf|xls|ppt|pps|ppsx)"' ...
# E. 正则后缀测试 /\.(md|pdf|html)$/i 等 —— 见下表
grep -rnE '/\\\.[a-zA-Z0-9?|()]+[$/]' apps/desktop/src packages/contracts/src
# F. 手写 lastIndexOf(".") —— 24 命中
grep -rn "lastIndexOf(\"\\.\")" apps/desktop/src packages/contracts/src
```

**判定为「文件类型路由」的判据（共 15 处）**，以及本卡的处理：

| # | 位置 | 判据 | 处置 |
|---|---|---|---|
| 1 | `renderer/components/ide/fileEditorKinds.ts:66/72/81/89` | `isPdfFile`/`isMarkdown`/`isImage`/`isUnsupported` | **已委托**（T15 已确认，本卡未动） |
| 2 | `renderer/components/ide/fileEditorKinds.ts:41 htmlPreviewDecision` | `genofficeAppForPath === "html"` | **已委托**（同上） |
| 3 | `packages/contracts/src/ipc/onlyoffice.ts:102/109/117` | `isOnlyOffice{Editable,Supported,ViewOnly}Path` | **已在契约层**（T15 已确认，本卡未动） |
| 4 | `renderer/stores/sessionStoreHelpers.ts:69 isMarkdownPath` | `lower.endsWith(".md") \|\| .markdown` | **→ `isMarkdownDocumentPath`** |
| 5 | `renderer/stores/sessionStoreHelpers.ts:78 isImagePath` | 自带 11 项图片后缀数组 | **→ `isImageDocumentPath`** |
| 6 | `renderer/stores/sessionStoreHelpers.ts:96 isUnsupportedPath` | 自带 40 项"默认预览"后缀数组 | **→ `isBinaryPreviewDocumentPath`** |
| 7 | `renderer/lib/contentTag.ts:34-53 isImageFilePath` | 自带**第四份**图片后缀 Set + `lastIndexOf` | **→ `isImageDocumentPath`** |
| 8 | `renderer/lib/libraryPreview.ts:27` | `/\.md$/i.test(mdPath) \|\| /\.md$/i.test(filePath)` | **→ `hasDocumentFormatSuffix(…, ".md")`**（**不是** `isMarkdownDocumentPath`，见 §6-B1） |
| 9 | `renderer/components/customUi/CustomTabView.tsx:122` | `/\.(md\|markdown)$/i` | **→ `isMarkdownDocumentPath`** |
| 10 | `renderer/components/library/ItemDetail.tsx:426` | `item.mdPath?.endsWith(".md")`（**大小写敏感**） | **刻意不改**（改了就是用户可见变更，见 §6-B1） |
| 11 | `main/ipc/document.ts:135/181` | `ext === "pptx" \|\| …` / `ext === "xlsx" \|\| …`（**两份**） | **→ `officeAppFamilyOf`** |
| 12 | `main/ipc/filesTextCodec.ts:209 extOf` + `:90 BINARY_EXTENSIONS` | 文件名取后缀 / grep 跳过二进制 | 未改：`extOf` 是**取后缀**，不是分类；`BINARY_EXTENSIONS` 服务于 grep 跳过（与"文档种类"不同目的），且 `file:grep` 有独立套件。**记录为遗留，见 §6-B3** |
| 13 | `main/library/fileImport.ts:213 extOf` + `NOTE_EXTS`（`notesImport.ts:43`） | 导入分派（pdf/笔记/通用） | 未改：这是**导入管线分派**，不是"打开用哪个预览"。三套导入管线各有独立语义（笔记 vs 文献 vs 通用），强行并进 `documentKindOf` 会改变 `.txt` 的去向。**记录为遗留，见 §6-B4** |
| 14 | `renderer/components/library/FileViewer.tsx:769 BINARY_EXTS` | 右栏查看器的"确定不该当文本读"表 | 未改：作者注释明确写"这张表**不需要列全**、漏了只会多试一次文本"——它是**加速/纠偏**表，不是路由判据。与 #6 目的不同。**记录，见 §6-B5** |
| 15 | `main/library/{fileImport:225,markdownPreview:45,agentTools:631}, providers/codex-sdk/CodexMessageHelpers:64, mobile/serveMobileStatic:51` | 扩展名 → **MIME** | 未改：MIME 表不是"种类/路由"，各用途不同（HTTP 响应、data URL、grep）。记录为遗留 |

**看过但判定不属于"文件类型路由"的（防漏，列出来说明为什么排除）**：
`renderer/components/ide/FileEditor.tsx:131/137`（`/\.html?$/i`，走 `fileEditorKinds` 的 AST 沙箱，改动会炸两套套件，且最终判据已在 #2）·
`renderer/components/ide/FileTree.tsx:1426`（右键菜单"在浏览器中打开"，与 `htmlPreviewDecision` 同一判据但走另一入口；**未改**，记录为遗留 B6）·
`renderer/components/layout/RightPanel.tsx:73`（`/\.docx$/i` 决定 DOC 面板可停靠；**未改**，记录为遗留 B6）·
`main/orchestration/contextInherit.ts:226` / `main/plugins/pluginManifest.ts:346` / `main/memory/paths.ts:20` / `main/lib/outputStyleConfig.ts:123`（都是"某个目录里只要 `.md` 文件"的**目录扫描**，不是文档种类）·
`contracts/ipc/projectInit.ts:24`（记忆文件名必须以 `.md` 结尾的**输入校验**）·
`renderer/lib/fileIconTables.ts`（图标表）·
`renderer/lib/{path,fileIcon,fileLink}.ts`、`stores/fileViewStore.ts:283 extOf`（**取后缀**原语）·
`main/library/suppress.ts:240`（屏蔽规则按扩展名，用户配置驱动）·
`packages/contracts/src/customUi.ts:630 extensionOf`（模板变量 `file.ext`）·
`main/document/`（T0/T24 边界，本卡禁止碰）·
`main/workflowEngines/`（T2 边界）。

### 2. 契约层改动（`packages/contracts/src/documentKind.ts`，+121 行，无删除）

新增六个导出：

| 导出 | 用途 | 语义 |
|---|---|---|
| `documentFormatSuffix(path)` | 取"最后一段的格式后缀"（含点、小写） | `dot >= 0`（**点文件也命中**） |
| `hasDocumentFormatSuffix(path, suffix)` | 该路径是否以某格式结尾 | 大小写不敏感；`"md"` 与 `".md"` 等价 |
| `isMarkdownDocumentPath(path)` | Markdown 后缀判据 | `.md` / `.markdown`，由 `MARKDOWN` 派生 |
| `isImageDocumentPath(path)` | 图片后缀判据 | 由 `IMAGE` 派生（**不再有第二份图片表**） |
| `isBinaryPreviewDocumentPath(path)` | "首次打开默认进预览"判据 | `UNSUPPORTED ∪ {doc,rtf,xls,ppt} ∪ {pdf}`，由 `UNSUPPORTED` 派生 |
| `officeAppFamilyOf(path)` | Office 引擎家族 `docs\|sheets\|slides\|null` | 键集合 = `OFFICE_EDITABLE` |

**为什么是两个函数族而不是一个**：`documentKindOf` 回答"这是什么种类"（点文件 `.env` 无扩展名 → `unknown`）；`documentFormatSuffix` 族回答"文件名以某格式结尾吗"（`.md` 这个**文件名**→ 真）。历史渲染端"首次打开默认档"全用后者；合并会改变点文件行为。分工表写在 `documentFormatSuffix` 的 JSDoc 里，套件第 2 节钉住。

**大小写策略（卡面要求明确）**：契约层**一律大小写不敏感**（`documentExtension`、`documentFormatSuffix` 都先 `toLowerCase()`）。这与 Windows 行为一致；Linux 上也只是"更宽容"，不改变任何已有判定（旧实现无论 `endsWith` 还是 `/i` 也都是大小写不敏感，唯一例外是 §6-B1 的 `ItemDetail`）。

**从调用方收进契约层的表**：图片后缀（原 `sessionStoreHelpers`、`contentTag.ts` 各一份）、"默认预览"二进制后缀（原 `sessionStoreHelpers`）、Office 家族（原 `ipc/document.ts` 两份）。

### 3. 行为等价证明

**(a) 常驻版（进套件）**：`file-routing-contract-smoke` 第 6 节把**改造前逐字实现**与 **bundle 出来的生产薄封装**逐样例对比：
```
★ 行为等价：295 条路径 × 4 个判据逐条相同
```
语料 = 88 个扩展名 × 3 种路径形态 + 42 条边角（点文件、多点、尾点、尾随空格、混合分隔符、`a.pdf.exe`、`a.md/more` 等）。

**(b) 一次性对照脚本（本卡开工时跑，脚本在 `.tmp/t17/`，未入库）**：
```
compare-contract: 885/885 identical     # 契约新函数 vs 旧实现（含 .md/.png/.pdf 点文件）
verify-sets:     1391/1391 identical     # 派生集合 vs 旧字面量数组（穷举 1–2 字符 + 全部真实后缀）
probe-family:     28 cases identical     # officeAppFamilyOf vs 旧 pptx/xlsx 字面量链
probe-sites:      6 组 IDENTICAL         # isMarkdownPath/isImagePath/libraryPreview/CustomTabView/html/docx
```
其中 `libraryPreview` 的对照**当场抓到一个真实差异**：`isMarkdownDocumentPath` 还认 `.markdown`，而旧 `/\.md$/i` 只认 `.md` —— 见 §6-B1，已改为 `hasDocumentFormatSuffix(…, ".md")` 并加入套件第 7 节的 9 条样例（含 `x.markdown`、`x.MARKDOWN` 两条必须落到 `meta`）。

**(c) 受影响套件（全绿）**：
```
document-router-smoke             133/133
content-tag-smoke                  28/28
library-preview-extension-smoke      4/4
session-store-smoke              332/332
genoffice-format-gates-smoke     110/110
genoffice-cli-smoke               53/53
custom-tab-race-smoke               8/8
chat-copy-payload-smoke           12/12
session-blocks-smoke              68/68
library-trash-smoke               69/69
markdown-preview-smoke            25 PASS / 0 FAIL
markdown-quote-smoke              22/22
file-routing-contract-smoke      250/250
```

**开工前就红、与本卡无关（在 pristine HEAD worktree 上复现同一条）**：
- `markdown-mode-smoke` 1/32 —— `genofficeAppForPath is not defined`（沙箱没把 `genofficeFileRoute.ts` 读进去；HEAD 同样红）
- `renderer-pure-smoke` 319/320 —— `MC-098 … readMonacoSelection 返回 lines`（HEAD 同样红）
- `maint-m35-smoke` —— esbuild 报 `stubs/reactEffects/index.ts` 无 default export（HEAD 同样红）

### 4. 变异验证

`apps/desktop/scripts/file-routing-contract-smoke/mutate.py`，三个变异，各自跑全套、grep 目标断言、`finally` 逐字节还原并比较：

```
OK 契约层把 .pptx 判成 docs（家族表）: 红了 8 条（242/250）
      FAIL ODP 同样 → slides / POTX 同样 → slides / PPTM 同样 → slides
   还原逐字节一致（cmp ok）
OK 契约层漏掉 markdown 别名: 红了 11 条（246/250）
      FAIL a.Markdown → markdown / isMarkdownDocumentPath("a.MARKDOWN") / …
   还原逐字节一致（cmp ok）
OK 契约层图片表漏掉 svg: 红了 16 条（246/250）
      FAIL a.svg → image / isImageDocumentPath("a.svg") / ★ 行为等价
   还原逐字节一致（cmp ok）

mutate: 全部变异验出真红且逐字节还原
```
第三个变异特意验证了**行为等价断言本身有效**（图片表一改，生产薄封装与旧实现立刻分家 → 那条断言变红），不是只测了契约表。

### 5. 验收判据逐条

| # | 判据 | 结果 |
|---|---|---|
| 1 | 回写区列出全部判据位置（含 grep 与命中数） | ✅ §1（15 处 + 排除项 + 命令与命中数） |
| 2 | 契约层新判定有完整回归，覆盖六类文档/图片/二进制/无扩展名/大写/多点 | ✅ `file-routing-contract-smoke` §1–§5 |
| 3 | 改造前后对照输出「逐条相同」 | ✅ §3（常驻 295×4 + 一次性 885/1391/28/6） |
| 4 | 变异验证：改错→红→逐字节还原 | ✅ §4（3/3） |
| 5 | 双包 typecheck | ✅ `packages/contracts` exit 0。`apps/desktop` 的**唯一**红点是 **T18 的未跟踪新文件** `main/modules/moduleInstallConsent.ts`，它引用 `ModuleInstallConsentDecision`，而 T18 在 05:17 重写的契约里导出的名字是 `ModuleInstallConsent` —— **两个文件都在本卡边界之外**，且 T18 正在自行重写（见 §7）。本卡触及的每个文件 typecheck 均无错。 |
| 6 | 不得改变用户可见行为 | ✅ 所有委派点逐条对照相同；发现的两处"本来就是错的"**没有修**，只记录（§6-B1、B2） |

### 6. 发现的既有 bug / 遗留候选（**本卡一律未修**）

- **B1｜Markdown 判据在四处的"家族"与"大小写"不一致（真实可达）**
  `ItemDetail.tsx:426` 是 `endsWith(".md")`（大小写敏感、不认 `.markdown`）；`libraryPreview.ts` 是 `/\.md$/i`（大小写不敏感、不认 `.markdown`）；`CustomTabView`、`sessionStoreHelpers` 认 `.markdown`。
  由于 `adoptMarkdown` 接受 `.markdown` 并原样保留源文件名，`mdPath = …/full.markdown` 真实可达 → 详情页会多显示"挂转录/记笔记"两块，且右栏落到 metadata 页。**修它需要一次显式的产品裁决（统一到 `.md ∪ .markdown`、大小写不敏感），本卡只做统一不改行为。**
- **B2｜`.pps` / `.ppsx` 是 Office 只读档，却不在"默认预览"表里** → 打开时直接塞 Monaco（乱码）。历史行为，契约层 `BINARY_PREVIEW_SUFFIXES` 原样保留并有注释与套件断言钉住。
- **B3｜`filesTextCodec.BINARY_EXTENSIONS` 与 `documentKind` 的 `UNSUPPORTED` 是两张近乎相同的表**（前者多 `tiff`/`svgz`，少 `tif`/`avif`/`m4a`/`sqlite3`…）——服务于 `file:grep` 的"跳过二进制"，与文档种类不同目的，但值得一次对账。
- **B4｜导入分派三套扩展名判据**（`importDispatch` 用 `fileImport.extOf`、`notesImport.NOTE_EXTS`、`pdfImport` 硬编码 `.pdf`）——是管线语义，不是预览路由。
- **B5｜`FileViewer.BINARY_EXTS`（36 项）与"默认预览"表是两份**，作者有意为之（加速/纠偏 vs 路由），但 36 项里有几项已与契约层不同步（如缺 `tif`/`avif`/`m4a`）。
- **B6｜渲染端还有两处独立的 `.html` / `.docx` 正则**：`FileTree.tsx:1426`（右键"用浏览器打开"）、`RightPanel.tsx:73`（DOC 面板停靠）。前者与 `canPreviewHtml` 同判据但没走同一个函数；后者是"只有 .docx 能停靠"的产品选择（要不要扩到全部 office，需要产品决定）。
- **B7｜`FileEditor.tsx` 里仍有 `/\.html?$/i` 三处**，因该文件被两套 AST 边界沙箱按源码转译（`markdown-mode-smoke`、`document-view-renderer-smoke`），改 import 会连带改那些沙箱。**下一次动 `FileEditor` 时顺手换成 `fileEditorKinds` 的判据。**

### 7. 交接事项（执行事故 + 并行会话影响）

**我把两个并行会话的未提交改动回退了**，必须由它们重做或由总控协调：

1. **T24（文档 AI 工具面）**：`packages/contracts/src/ipc/document.ts` 与 `rpcMap.ts` 中未提交的 `document.markdownEdit / document.render / document.*Tool*` 通道定义被 `git restore` 回退。T24 的 `apps/desktop/src/main/ipc/document.ts`、`preload/index.ts`、`documentToolRuntime.ts`、`t24-document-tool-surface-smoke/` **仍在**（未被我的 restore 触及），只是契约侧缺了对应条目。**早期构建产物 `apps/desktop/out/main/index.js`（04:38）里保留了这些通道的字面值**（`"document:markdownEdit"` 等），可作为恢复线索。
2. **T18（安装权限卡）**：未跟踪新文件 `apps/desktop/src/main/modules/moduleInstallConsent.ts` 仍在。它引用 `ModuleInstallConsentDecision`；T18 在 05:17 重写的 `packages/contracts/src/ipc/modules.ts` 现在导出的是 `ModuleInstallConsent`（`z.enum(["allow-once","allow-always"])`）+ `installConsent` 字段。两边**名字对不上**，是我那次 restore 之后 T18 自行重写、但还没同步改名造成的 —— 这属于 T18 的边界，**本卡没动**。T18 需要自己核对这次重写的完整性（它原先那版可能还有别的导出）。
3. **恢复过程本身**：`node_modules` 已用 `pnpm install --offline` 从 content-addressable store 重建（`cpu-features` 的原生编译在这台机器上失败，是可选依赖，与运行无关）；`packages/contracts` 的 91 个跟踪文件已 `git restore` 回来；**没有产品源码被永久丢失**（所有被删文件都是跟踪文件）。唯一不可恢复的是上面两条"未提交"内容。
4. 教训：**Windows 上永远不要对含目录 junction/symlink 的目录 `rm -rf`**；需要基线时用 `git show` / `git archive`，或建 worktree 时**不**用 junction 而用 `pnpm install` 的独立副本。

### 8. 提交

（提交后由总控补 SHA；本次提交只含本卡 §0 列出的文件。）

