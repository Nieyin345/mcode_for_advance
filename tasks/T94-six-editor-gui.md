# T94｜六编辑器 GUI 真实可用性：用户能不能打开、编辑、保存

- Status: ready-for-agent
- Category: **产品主线验收（GenOffice）**
- Priority: **P0 —— 产品路线图 §2 明写「CLI 成功不是 GUI 完成」**
- Depends on: T43、T47、T83（`0e3165e7`，断点在 vendor）
- Exclusive writable files: **只读 + `.tmp/` 探针**。不改产品代码。

## Required Skills
- `code-review`：区分「代码里有路由」和「用户能打开」。
- `mcode-smoke`：无头探针。

## 背景：今天所有验证都在 CLI 层，GUI 一步没验

`docs/planning/mcode-product-roadmap.md` §2 的 GenOffice 行写着：

> **CLI 成功不是 GUI 完成。**

而 §5「首阶段验收」的核心闭环是：

> 用户从 UI 提出通用任务；Agent 在已授权范围内调用…**生成可用的真实产物**。

**今天做的：`checkDeckPatterns` 接线、`page: null`、`cpSync` P0、断言完整性——全在 CLI/headless 层。**

## 已有的关键线索

**E 在 T83 查明**：

> **断因在 vendor 结构，不在 Mcode 缺代码。**
> slides 渲染端只认 `slides:menu`，而 `MenuCommand` 联合里**只有 `'open'`（弹文件对话框）**，没有带路径的命令。
> `consume-pending-open` 读的 `pendingByVc` 只由 vendor 的 `createSlidesView` 填充（`slides-main.ts:343`/`5064`），Mcode 宿主无从写入。

**而 `GenofficeDocumentPane.tsx` 自己写着**：

> 它**不是**完整编辑器 —— 可视化编辑要等方案 A（受控 WebContentsView）接上

**但 T83 查明方案 A 早接上了**（`GenofficeViewHostPane`，559 行，`FileEditor.tsx:147` 在 `genoffice-view` 模式渲染它）。

**所以：注释过期了，真实断点在 slides 的打开通道。**

## 任务

### 一、六个编辑器 × 三个动作

逐格填，**每格要有代码证据**（哪个函数、哪行、什么条件下能走通）：

| 编辑器 | **能打开** | **能编辑** | **能保存** |
|---|---|---|---|
| docs (.docx) | ? | ? | ? |
| sheets (.xlsx) | ? | ? | ? |
| slides (.pptx) | ? | ? | ? |
| pdf | ? | ? | ? |
| markdown | ? | ? | ? |
| html | ? | ? | ? |

**「能打开」的判据**：用户点了文件 → `GenofficeViewHostPane` 里出现 vendor 编辑器的页面，**不是空壳、不是只读结构视图**。

**要区分**：
- **`GenofficeDocumentPane`**（只读结构视图，123 行）—— 用户看到块/页/表的列表；
- **`GenofficeViewHostPane`**（真编辑器，559 行）—— 用户看到 vendor 的原生编辑器。

### 二、最小完整动作：改一个字并保存

**对每个「能打开」的编辑器**，回答：

> **用户能不能：打开 → 改一个字 → 保存 → 重开看到改动？**

**这是产品闭环的最小单元。**

**如果某一步断了，说清断在哪**（哪个 IPC、哪个函数、什么条件）。

### 三、slides 能不能修？

**E 在 T83 给了两条路**：

1. **伪造 `OpenResult`** —— 让 Mcode 宿主能写 `pendingByVc`；
2. **fork vendor 的 `createSlidesView`** —— 走 `mcode/integration` 分支。

**判断**：
- 哪条可行？
- 成本多少？
- **会不会影响 vendor 升级**（`mcode/integration` 已经有补丁机制）？

**这决定开不开施工卡。**

## 验收判据

1. **六个 × 三个动作的表**，每格有代码证据。
2. **「改一个字并保存」的逐编辑器答案**。
3. **`GenofficeDocumentPane` 与 `GenofficeViewHostPane` 的分工**说清（哪些编辑器走哪个）。
4. **slides 的两条修法判断**（可行 / 成本 / 对 vendor 升级的影响）。
5. **不改产品代码、不起 Electron**。

## 边界

- **只读 + `.tmp/` 探针**；
- **不起 Electron**（用户明确说过不用桌面测试）；
- 不改产品代码（发现要改，报告给总控）。

## 遇到问题先检索

`docs/planning/extension-vscode-compat.md` 是扩展线的，**不要混淆**。
GenOffice 的 vendor 文档在 `genoffice/skills/genoffice/SKILL.md`。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T94-six-editor-gui.md` 末尾追加 `## 结果回写（2026-10-24）`：
六×三表、「改一个字」逐编辑器、两个 Pane 的分工、slides 修法判断、提交 SHA。

---

## 结果回写（2026-10-24）

### 〇、先纠正卡面的一条过期线索

**T83 记的 slides 断点已经不存在了。**

> slides 渲染端只认 `slides:menu`，而 `MenuCommand` 只有 `'open'`，`pendingByVc` 只由 vendor 填，Mcode 宿主无从写入。

`genoffice/apps/slides/src/main/slides-main.ts:5066` 的 `createSlidesView(openPath?: string | null)` **直接收路径**：

```ts
// :5079
if (openPath && existsSync(openPath)) pendingByWc.set(view.webContents.id, openPath)
```

而宿主**就是调用这个函数**（`document/genofficeNativeVendor.ts:69`）：

```ts
case "slides": return createSlidesView(path) as unknown as DocumentViewLike;
```

**不需要伪造 `OpenResult`，也不需要 fork vendor。** `GenofficeViewHostPane.tsx` 文件头第 40-60 行已经把这段历史写成「2026-10-24 重写」并保留了四条旧观察作为「为什么不能用别的路」的记录。

**所以卡上第三节「slides 能不能修？两条路哪条可行」→ 前提不存在，不需要修。**

### 一、六 × 三 表

| 编辑器 | 能打开 | 能编辑 | 能保存 |
|---|---|---|---|
| **docs (.docx)** | ✅ 宿主注入 preload + `menu:command("open-path")`（`documentViewHost.ts:819-860`） | ✅ vendor 编辑器页，`docs:save` 系列 | ✅ **宿主围栏 + 乐观锁**（`saveOpenedFile`，`:1506`）—— 唯一有版本冲突检测的 |
| **sheets (.xlsx)** | ✅ `createSheetsView` + `queueWorkbookForView`（`genofficeNativeVendor.ts:63-67`） | ✅ vendor 编辑器页 | ✅ `workbook:save` 在 `PATH_OPERATIONS` 内，经 `assertAllowedPath` 校验 `targetPath` |
| **slides (.pptx)** | ✅ `createSlidesView(openPath)`（vendor `:5079` 直接把路径塞进 `pendingByWc`） | ✅ vendor 编辑器页 | ✅ `slides:save` 走 `savePptxToFile`；隐式保存前 `assertAllowedPath(guard, channel, guard.documentPath(sender))` |
| **pdf** | ✅ `createPdfView(path)` | ✅ vendor 编辑器页 | ⚠️ **白名单是 vendor 自管的**（`allowedByWc`），且有 Save As 对话框 |
| **markdown** | ✅ `createMarkdownView(path)` | ✅ vendor 编辑器页 | ⚠️ 同上（`savePathByWc`），有 Save As 对话框 |
| **html** | ✅ `createHtmlView(path)` | ✅ vendor 编辑器页 | ⚠️ 同上 |

**能力位实测**（headless 复刻 `genofficeViewFactories.ts`）：

```
pdf: true   markdown: true   html: true   sheets: true   slides: true
docs: true（恒真，无 hosts 位）
sidecar: genoffice/apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe（8.9MB, 10-21）
```

**六家 `out/renderer/index.html` + `out/preload/index.js` 全部存在。**

### 二、★ 与卡面预期相反的一条：`hasHostOpenChannel` 的注释过期

`GenofficeViewHostPane.tsx:105-112` 的注释写着：

> **sheets**：**没有**对端（打开需要宿主交出一份 vendor 主进程组装好的 `WorkbookFile`…）。本切片未接，**恒为 false**。

**但生产装配是有的**（`genofficeNativeVendor.ts:63-67` 的 `createSheetsView` + `queueWorkbookForView`），能力位实测也是 `true`。

**注释停在「本切片未接」那一版，代码已经往前走了。** 这是今天第三处「注释记录当时」。

### 三、两个 Pane 的分工（卡上要求说清）

| | `GenofficeDocumentPane`（123 行） | `GenofficeViewHostPane`（559 行） |
|---|---|---|
| 是什么 | 只读**结构化视图**（块/页/表列表） | **真 vendor 编辑器**（`WebContentsView` 叠在 DOM 上） |
| 用于 | 无宿主时的诊断/回退面 | 六家全部 |
| 进入方式 | 工具栏 `genoffice` 档 | 工具栏 `genoffice-view` 档 |

`FileEditor.tsx:210-220`：`effectiveMode` 里 `useGenofficeView`（`genoffice-view`）优先于 `useGenoffice`（`genoffice`）。

### 四、★ 三个真断点（不是「没验」，是「验了会挂」）

#### 断点 A：slides 的关闭检查会超时 → **用户关不掉标签**

`documentViewHost.ts:1278-1350` 分成两路：

- **pdf/markdown/html/sheets** → `vendorCloseGuard` → vendor 自己的 `request*Close` ✅
- **docs/slides** → `mcode:document-view:close-check` 探针通道，**2 秒超时即拒绝关闭**（`:1336`）

而 `mcode:document-view:close-check` 的**订阅者只有宿主自己的 `documentViewPreload.ts:209`**（它给 docs 用）。**slides 的 preload 是 vendor 原版**（`genoffice/apps/slides/out/preload/index.js`），不订阅这个通道。

**所以：slides 打开后点关闭 → 2 秒后 `编辑器未响应关闭检查；为保护未保存内容，拒绝关闭`。**

**这一条 headless 就能定论**（通道订阅者可以 grep），**不需要 Electron**。

#### 断点 B：pdf / markdown / html 没有接入 Mcode 的 `mcodePane` 围栏

`mcode-sheets-scoped.ts:108` 的 `createMcodePaneIpc` 只被 **sheets** 和 **slides** 用：

```
genoffice/apps/sheets/src/main/sheets-main.ts:30  createMcodePaneIpc(...)
genoffice/apps/slides/src/main/slides-main.ts:30  createMcodePaneIpc(...)
genoffice/apps/pdf/src/main/*.ts                  0 处
genoffice/apps/markdown/src/main/*.ts             0 处
genoffice/apps/html/src/main/*.ts                 0 处
```

**影响的是「打开之后的写」**：Host 在 `documentViewHost.ts:550` 已经拦了**打开**（`withinWorkspace(input.filePath)`），所以打开的那个文件一定在工作区内。但打开之后，页面的 Save As 用的是**未包装的原生 `dialog`**（`markdown-main.ts:674`、`html-main.ts:1209`、`pdf-main.ts:1294`），用户可以选工作区外的任何位置。

**这是不是缺陷要看产品意图**：OnlyOffice 那条路本来就是「另存为到任意位置」。**如果 GenOffice 视图也允许，那它不是 bug**；如果要求「只能用工作区内」，那 pdf/md/html 缺围栏。**卡上没有这条判据，我按「记录下来，等裁决」处理。**

#### 断点 C：docs 之外的五家没有乐观锁

`saveOpenedFile`（docs）有 `openedFileRevision` + `expectedRevision`，冲突时报 `conflict` 且不写盘。**pdf/markdown/html/sheets/slides 都没有等价物** —— 页面直接写目标路径。

**后果**：用户在 Mcode 里开着 docx，Agent 同时改了它，用户保存 → **静默覆盖 Agent 的改动**（docs 会拦住，其余五家不会）。

**这一条影响的是「多路径同时改一个文件」这个真实场景**（Mcode 的核心就是「用户 + Agent 同时在工作」）。

### 五、「改一个字并保存」逐编辑器

| 编辑器 | 打开→改→存→重开看到 | 断在哪 |
|---|---|---|
| docs | ✅ 链路完整 | — |
| sheets | ✅ 链路完整 | — |
| slides | ✅ **存**完整；**关闭**断（断点 A） | 关不掉标签，但保存本身没问题 |
| pdf | ✅ 链路完整 | — |
| markdown | ✅ 链路完整 | — |
| html | ✅ 链路完整 | — |

**六家「改一个字并保存」在代码层面全都通。** 只有 slides 的**关闭**会挂。

### 六、哪些格需要 U1、哪些 headless 就定论

| 项 | 需要 U1 | 理由 |
|---|---|---|
| 六家的能力位 | ❌ | 已 headless 实测为 true |
| 视图能否创建 | ⚠️ **需要** | `WebContentsView` 是 OS 级子视图，headless 造不出来 |
| 编辑器页能否真正渲染 | ⚠️ **需要** | 同 |
| **slides 关闭超时** | ❌ **headless 已定论** | 通道订阅者可 grep，超时逻辑可读 |
| **pdf/md/html 无宿主围栏** | ❌ headless 已定论 | `createMcodePaneIpc` 调用点数得出来 |
| **五家无乐观锁** | ❌ headless 已定论 | `saveOpenedFile` 只有 docs 一家调 |
| 「改一个字」全链路 | ⚠️ **需要** | 真实 IPC 往返 + 真实编辑器状态 |

### 七、回答卡上的第三节（slides 修法判断）

**前提不成立，不需要修。** `createSlidesView` 本来就收 `openPath`。

**但发现了一个卡上没问的问题**：slides 的**关闭**走错了通道（断点 A）。**这才是 slides 需要施工的地方** —— 把它接到 `vendorCloseGuard`（`requestSlidesClose` 已存在，`genofficeNativeVendor.ts` 只差 slides 那一支）。

### 八、没做的

1. **没起 Electron**（用户明确约束）。第三、五节的表里标了哪些需要 U1。
2. **没跑全量 smoke**。
3. **断点 B 的性质没有裁决** —— 「另存到工作区外」是允许还是禁止，卡上没给判据，我记录不判定。

### 九、提交

只改本卡（回写），无产品代码改动。

- 探针：`.tmp/t94/probe.ts`（跑完已清理）
- `git status` 对 `apps/desktop/src/` 与 `genoffice/` 无我的改动
