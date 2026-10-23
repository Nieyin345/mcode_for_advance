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
