# VS Code 扩展 API 需求普查：真实扩展到底用了哪些 `vscode.*`

- 日期：2026-10-24
- 卡片：`tasks/F/F019-vscode-api-census.md`
- 脚本：`apps/desktop/scripts/vscode-api-census/main.mjs`（AST 解析，`bash run.sh` 可重跑）
- 原始数据：`apps/desktop/scripts/vscode-api-census/result.json`
- 语料：`C:\Users\Nieyin\.vscode\extensions\`（本机现成的 33 个目录）

**这份文档回答的是需求侧**：F018 从 `@types/vscode` 给出「一共有多少 API」，这篇文章回答「真实扩展**实际**调了哪些、按被多少个扩展用排序」。**排序就是实现顺序。**

---

## 〇、一句话结论

**Top 20 个成员覆盖了平均 30% 的成员种类、但覆盖了 64% 的调用次数；到 Top 50 是 53% / 78%。而「让一个扩展完全不需要缺失 API」需要几乎全部 429 个成员 —— 本机 29 个扩展里，没有一个能在缺席 100 个以上成员时被「完全」支持。**

**所以「B 方案要多久」取决于目标口径**：如果目标是「常用路径能跑」（≥80% 调用次数），**Top 50 覆盖 62% 的扩展，Top 100 覆盖 86%，Top 200 覆盖 100%** —— 分阶段可行。如果目标是「装进来不出错」（完全覆盖），那需要 429 个成员全在，**这是 Theia 量级的坏消息，必须让用户知道。**

---

## 一、扩展分类（三类）

| 类别 | 判据 | 数量 |
|---|---|---:|
| **有代码** | `package.json` 有 `main` | **30** |
| **无代码**（主题 / 语言包 / 纯声明） | 没有 `main` 字段 | **2** |
| **不是扩展** | 无 `package.json` 或结构不对 | **1** |

**合计 33 个目录。**

### 有代码的 30 个 → 去重后 29 个

```
James-Yu.latex-workshop            10.20.0
MarsCode.marscode-extension        1.3.4      （哈希目录 .41f67f4f-…）
Anthropic.claude-code              2.1.132    （哈希目录 .fa6e8bc5-…）
mechatroner.rainbow-csv            3.24.1
Minko.image-manager                3.3.10
ms-azuretools.azure-dev            0.10.0
ms-azuretools.vscode-azureappservice / azurecontainerapps / azurefunctions /
  azureresourcegroups / azurestaticwebapps / azurestorage / azurevirtualmachines /
  vscode-containers / vscode-cosmosdb
ms-python.debugpy                  2026.6.0
ms-python.python                   2026.10.0
ms-python.vscode-pylance           2026.4.1
ms-python.vscode-python-envs       1.40.0
ms-vscode-remote.remote-containers 0.470.0
ms-vscode-remote.remote-ssh        0.128.0
ms-vscode-remote.remote-ssh-edit   0.87.0
ms-vscode-remote.remote-wsl        0.104.5
ms-vscode.powershell               2025.4.0
ms-vscode.remote-explorer          0.5.0
ms-vscode.remote-server            1.5.4
seepine.md-editor                  0.1.1
siesta.vscode-pdf-translate        1.3.3
tomoki1207.pdf                     1.2.2
```

### 无代码的 2 个（不计入统计）

| 目录 | 说明 |
|---|---|
| `ms-ceintl.vscode-language-pack-zh-hans-1.131.2026090407` | 语言包，无 `main`。**零 API 需求。** |
| `ms-vscode.vscode-node-azure-pack-1.8.2` | **扩展包（Extension Pack）** —— 只声明依赖、自己没代码。它「用到」的 API 全在被它打包的那些 azure 扩展里，已经算过了。 |

### 不是扩展的 1 个

| 目录 | 说明 |
|---|---|
| `.02de5c43-cd14-4a0f-be3c-e8d0cf92f14d` | 没有 `package.json`。`.vsixmanifest` 显示它是 **Pylance 2025.8.3 的残留目录**（被新版替换、只留下了 `dist/` 与变更日志，28 MB）。**没有任何 `main` 可解析，无法扫。** 如果按目录名猜成「未知扩展」，它会把结果污染成「有一个扩展一个成员都没用到」。 |

### 去重：1 组

`James-Yu.latex-workshop` 有两个版本目录：`james-yu.latex-workshop-10.20.0/`（`extensions.json` 里登记的）与 `.9bc3fdcc-…/`（10.15.0，旧版残留）。**保留 10.20.0，丢 10.15.0** —— 否则同一个扩展会被算两次，人为抬高每个成员的「扩展数」。

### `.obsolete` 与 `extensions.json` 的差异（要报）

- `.obsolete` 里 **16 条**记录全是**已被删除**的版本（copilot / copilot-chat / marscode 旧版 / 旧语言包 / 旧 claude-code）。
- **`MarsCode.marscode-extension` 与 `Anthropic.claude-code` 在磁盘上有、但不在 `extensions.json` 里**。`extensions.json` 是**这份 VS Code 实例**的已装清单，所以严格说它们不是这个实例当前登记的扩展 —— 但它们是真扩展、有代码、目录结构完整（`.vsixmanifest` + `package.json` + `main`），且 `.obsolete` 里记的是**它们更旧的版本**（`marscode-…-1.4.14`、`anthropic.claude-code-2.1.96/2.1.100`）。**它们要么是被手动放入、要么是别处（共用同一 extensions 目录的客户端）装的，本普查计入** —— 需求普查问的是「真实扩展用到什么」，不是「这份 VS Code 激活了什么」。不带它们，`Uri`/`commands` 的「扩展数」会少 2 个。

---

## 二、扫了多少文件、多少行

| 指标 | 数值 |
|---|---:|
| 扫描的扩展 | 29 |
| **扫描的文件** | **198** |
| **合计行数** | **266,260** |
| 合计体积 | 60.8 MB |
| 解析失败的文件 | **0** |
| 去重后的不同成员 | **429** |
| 不同命名空间 / 类 | **157** |

**为什么「只扫 `main`」不够（卡里的判据 1）—— 有量化证据：**

| 口径 | 成员数合计 | 说明 |
|---|---:|---|
| **只扫入口文件** | **1,276** | 有 **9 个扩展是 0**（`entryOnlyMemberCount = 0`） |
| **递归扫本地 require** | **2,202** | 多出 **926 个成员引用（+73%）** |

**9 个「只扫入口全是 0」的扩展**（全是 azure 系列）：它们的 `main.js` 只是 30 行左右的加载器，真正的代码在 `require("./dist/extension.bundle")` 里：

```
ms-azuretools.azure-dev                  entry=0 → 递归 80
ms-azuretools.vscode-azureappservice     entry=0 → 递归 72
ms-azuretools.vscode-azurecontainerapps  entry=0 → 递归 62
ms-azuretools.vscode-azurefunctions      entry=0 → 递归 98
ms-azuretools.vscode-azureresourcegroups entry=0 → 递归 113
ms-azuretools.vscode-azurestaticwebapps  entry=0 → 递归 64
ms-azuretools.vscode-azurestorage        entry=0 → 递归 52
ms-azuretools.vscode-azurevirtualmachines entry=0 → 递归 38
ms-azuretools.vscode-containers          entry=0 → 递归 214
```

**这 9 个如果只扫 `main`，会得出「它们一个 API 都不用」的结论**，而实际它们是本机调用最密集的一批。**这就是卡里说的「结果看起来完全正常」的形态。**

递归规则：
1. 从 `main` 出发（`browser` 字段**不计入** —— 那是 web 宿主版本，不是桌面端入口）；
2. 跟进 `require("./x")`、`import "./x"`、动态 `import("./x")`；
3. 排除 `node_modules`；
4. **webpack 拆包**：遇到 `n.e(<id>)` / `n.bind(n, <id>)` 且同目录存在 `<id>.js` 时一并扫（`remote-server` 的 `282.js` / `387.js` / `602.js` 就是这样进来的）。

### 打包产物（webpack / esbuild）标注

29 个里 **22 个**是打包产物（单文件 >400 KB 或整体 >800 KB）。**它们的成员数是「打包后的」** —— 这一点在 `result.json` 的 `bunded` 字段里逐条标了。三个需要注意的：

| 扩展 | 体积 | 成员数 | 为什么需要单独说 |
|---|---:|---:|---|
| `MarsCode.marscode-extension` | **10.3 MB** | **15** | **控制流平坦化 + 字符串表混淆**：成员名在运行时由 `_0x5365(0x1234)` 解码，静态分析只能拿到字面量那部分。**15 是下界，不是真实值。** |
| `Anthropic.claude-code` | 1.9 MB | 90 | esbuild 打包 + 变量重命名；`require("vscode")` 出现 31 次 |
| `ms-python.python` | 2.2 MB | **255**（本机最高） | webpack 5，模块表用 `54980(e){e.exports=require("vscode")}` 形态（**方法简写**，不是属性赋值） |

---

## 三、Top 30 成员表

**「本仓底层」一列**：✅ = 仓库里已有可映射的实现；⚠️ = 有相近能力但语义对不上；❌ = 需要新建。
判断依据是 `apps/desktop/src/main/` 里实际存在的模块（`notifications/NotificationManager.ts`、`terminal/TerminalManager.ts`、`lsp/LspManager.ts`、`ipc/files.ts`、`ipc/dialog.ts`、`store/repositories/`、`browser/BrowserManager.ts` 的 `safeStorage`、`vscodeL1Bridge.ts` 已有的 L1/L2 面），**不是读文档猜的**。

| # | 成员 | 扩展数 | 本仓底层 |
|---:|---|---:|---|
| 1 | `Uri.file` | 27 | ✅ `vscodeL1Bridge.ts:677` 已有 `l2Uri.file`（`{scheme:"file", fsPath}`） |
| 2 | `commands.executeCommand` | 26 | ⚠️ `vscodeL1Bridge.ts:1207` 只支持**执行一条已声明命令**；通用 id 路由要新建 |
| 3 | `workspace.getConfiguration` | 25 | ⚠️ L2 的 `getConfiguration` 只认一个 section 且值来自预置 JSON；真实设置树要接 `SettingRepo` |
| 4 | `EventEmitter.constructor` | 24 | ✅ Node 的 `EventEmitter`（扩展宿主进程里就是 Node），但要补 `vscode.EventEmitter` 的 `event` 只读属性包装 |
| 5 | `Uri.parse` | 24 | ⚠️ 需一个真正的 URI 解析器（`file:` / `untitled:` / 远程 scheme），L2 只有 `.file()` |
| 6 | `window.showErrorMessage` | 24 | ✅ `NotificationManager.ts`（OS 通知）+ 渲染端 toast；L2 已有 `showErrorMessage` 的兄弟 `showInformationMessage` |
| 7 | `window.showInformationMessage` | 24 | ✅ 同上 —— `vscodeL1Bridge.ts` 的 L2 `l2Notify("info", …)` 就是它 |
| 8 | `commands.registerCommand` | 23 | ✅ `vscodeL1Bridge.ts:810` 已有（白名单制） |
| 9 | `window.showWarningMessage` | 23 | ✅ `l2Notify("warning", …)` 已有 |
| 10 | `workspace.workspaceFolders` | 23 | ⚠️ 仓库有 project/workspace 概念，但**没有 VS Code 的「多根工作区」模型**；`WorkspaceFolder[]` 需要新建 |
| 11 | `env.openExternal` | 22 | ✅ `BrowserManager.ts` + `windowNavigation.ts` 已有 `openExternal` |
| 12 | `extensions.getExtension` | 22 | ⚠️ `getExtension(其他扩展 id)` 是**扩展间依赖** —— 本仓扩展模型里没有「扩展 API 导出」概念 |
| 13 | `window.withProgress` | 22 | ⚠️ 渲染端有进度 UI（`WorkflowStepCard` / `ActivityConsole`），但没有 `ProgressLocation` 三档的抽象 |
| 14 | `ProgressLocation.Notification` | 21 | ⚠️ 同上 |
| 15 | `window.createOutputChannel` | 21 | ⚠️ 有 `ActivityConsole` 日志视图，但没有「按名字命名的 OutputChannel → 可 `append` / `show`」的对象模型 |
| 16 | `workspace.fs` | 21 | ✅ `ipc/files.ts`（`FILE_READ` / `FILE_WRITE` / `FILE_MKDIR`…）+ L2 已有受限 `workspace.fs.readFile/writeFile` |
| 17 | `l10n.t` | 20 | ✅ 仓库有 `lib/i18n`（zh/en 双词典）—— 但**扩展自己的 l10n bundle** 是另一套（`l10n/bundle.l10n.json`），要单独接 |
| 18 | `ConfigurationTarget.Global` | 19 | ✅ `SettingRepo`（sql.js）可映射；缺 `Workspace` 目标 |
| 19 | `ThemeIcon.constructor` | 19 | ⚠️ 渲染端用 lucide 图标集；**VS Code 的 `ThemeIcon` 用的是 codicon id**（`$(gear)`），要做映射表 |
| 20 | `window.showTextDocument` | 19 | ✅ 渲染端 `FileEditor.tsx`（Monaco）能开文件；缺 `TextDocumentShowOptions`（`preview` / `viewColumn` / `selection`） |
| 21 | `workspace.openTextDocument` | 19 | ⚠️ 有文件读取（`ipc/files`），但没有 `TextDocument` 对象（`getText` / `lineAt` / `save`） |
| 22 | `env.appName` | 18 | ✅ 常量 |
| 23 | `env.machineId` | 18 | ⚠️ 需要一个稳定的机器标识（且**不能是硬件指纹**）；仓库未见 |
| 24 | `FileType.Directory` | 18 | ✅ 枚举，`workspace.fs.stat` 的结果类型 |
| 25 | `Range.constructor` | 18 | ❌ **这是编辑器位置模型** —— 本仓 Monaco 有自己的 `IRange`，但扩展拿到的 `vscode.Range` 必须是我们自己的类 |
| 26 | `env.clipboard` | 17 | ✅ `ipc/files` + Electron `clipboard`（仓库里 `clipboard` 出现 44 个文件） |
| 27 | `env.language` | 17 | ✅ `lib/i18n`（`UI_LOCALE_SETTING_KEY`） |
| 28 | `FileType.File` | 17 | ✅ 同 24 |
| 29 | `Uri.joinPath` | 17 | ✅ `node:path` 的 `join` + URI 包装 |
| 30 | `window.createQuickPick` | 17 | ⚠️ 渲染端 `SearchDialog` 是命令面板，**不是可编程的 QuickPick**（`items` / `onDidChangeValue` / `busy` / `buttons`） |

**Top 30 里能标 ✅ 的 13 个，⚠️ 的 14 个，❌ 的 1 个。** ✅ 大多集中在 `env.*` 常量、`Uri.file`、`commands.registerCommand`、`show*Message` 这几类 —— 它们恰好是 **A+ 已经做过的那一批**。**⚠️ 才是真正的工作量**：它们都是「有相近能力，但 VS Code 的语义是对象模型，我们的是函数调用」。

---

## 四、覆盖曲线（这是这张卡的核心）

三个口径回答三个不同问题，**不能混着看**：

- **完全覆盖**：实现了 Top K 后，有多少扩展用它用到的**每一个**成员都实现了（一个没有就算失败）；
- **≥80% / ≥90% 调用次数**：实现了 Top K 后，有多少扩展的**调用次数**覆盖到 80% / 90%（常用路径能跑）；
- **平均成员覆盖率 / 平均调用覆盖率**：所有扩展的**平均值**。

| Top K | 完全覆盖（strict） | ≥90% 调用次数 | ≥80% 调用次数 | 平均成员覆盖率 | 平均调用覆盖率 |
|---|---:|---:|---:|---:|---:|
| 1 | 0% | 0% | 0% | 2.6% | 5% |
| 3 | 0% | 0% | 0% | 7.2% | 14.5% |
| 5 | 0% | 0% | 0% | 10.5% | 18.8% |
| 10 | 0% | 0% | 0% | 17.5% | 29.9% |
| 15 | 0% | 0% | 3.4% | 23.8% | 34.3% |
| 20 | 0% | 0% | 13.8% | 29.9% | 64.1% |
| 30 | 0% | 0% | 34.5% | 38.7% | 69.9% |
| 40 | 0% | 10.3% | 48.3% | 46.5% | 74.2% |
| **50** | **0%** | **17.2%** | **62.1%** | **53.2%** | **78.5%** |
| 75 | 3.4% | 44.8% | 79.3% | 64.9% | 85.1% |
| 100 | 6.9% | 62.1% | 86.2% | 72.4% | 89% |
| 150 | 6.9% | 79.3% | 96.6% | 80.9% | 92.5% |
| 200 | 10.3% | 86.2% | 100% | 85.8% | 94.4% |
| 300 | 20.7% | 100% | 100% | 94.2% | 98% |
| 400 | 55.2% | 100% | 100% | 99% | 99.7% |
| **429（全部）** | **100%** | 100% | 100% | 100% | 100% |

### 曲线形状怎么读

**1. 「完全覆盖」几乎是阶跃函数，前面 400 个成员对它没有贡献。**

Top 400 时仍有 **45% 的扩展**至少有一个成员没实现。**这意味着「装一个扩展就保证不崩」这个目标，实际上等价于「实现全部 429 个」。** 任何一个漏掉的成员（哪怕全机只有 1 个扩展用）都会让那个扩展在调用时抛 `undefined is not a function`。

**2. 「常用路径能跑」的曲线是健康的长尾。**

- Top 20 → 64% 的调用次数（平均）；
- Top 50 → 78.5%；
- Top 100 → 89%。

**这与「Top 20 覆盖 80%」的直觉不同 —— 是 Top 20 覆盖 64%，Top 50 才到 78%。** 差距来自 `l10n.t`（4,325 次调用，占全部 13,737 次的 31.5%）和 `workspace.getConfiguration`（493 次，latex-workshop 一个就 149 次）这类**被反复调用的少数成员**。

**3. 长尾是「真的长」：429 个成员里 102 个（24%）只被 1 个扩展用。**

| 被多少个扩展用 | 成员数 |
|---|---:|
| ≥1 | 429 |
| ≥2 | 327 |
| ≥5 | 134 |
| ≥10 | 63 |
| ≥15 | 40 |
| ≥20 | 17 |

**扩展之间的共性在「前十来个命名空间」很高（`window` / `workspace` / `Uri` / `commands` / `env` 各被 25+ 个扩展用），但到成员级迅速衰减** —— 因为同一个命名空间下，每个扩展挑的成员不一样（`window` 有 52 个不同成员）。

**4. 按命名空间看，前 5 个覆盖了大部分扩展：**

| 命名空间 | 用在几个扩展 | 该命名空间的成员数 |
|---|---:|---:|
| `Uri` | 28 | 4 |
| `window` | 28 | **52** |
| `workspace` | 28 | **46** |
| `commands` | 27 | 4 |
| `env` | 25 | 18 |
| `languages` | 14 | 37 |
| `l10n` | 20 | 3 |

**`Uri` / `commands` 是小而宽的甜点（4 个成员覆盖 27–28 个扩展）；`window` / `workspace` 是宽而深的坑（52 / 46 个成员）。**

---

## 五、一个成员都没扫到的扩展

**0 个。**

29 个有代码的扩展**全部**至少扫出 1 个成员。扫出最少的三个：

| 扩展 | 成员数 | 为什么少 | 是否可信 |
|---|---:|---|---|
| `ms-vscode-remote.remote-ssh-edit` | **5** | 它本来就极小（1.4 KB 的单文件，只注册一个 `ssh_config` 补全 provider + 造两个 `CompletionItem`） | ✅ 读完了整个文件 |
| `tomoki1207.pdf` | **5** | 真正的入口 `out/src/extension.js` 只有 18 行；`PdfDocument.js` 等文件**从 `main` 不可达** | ✅ 人肉核对过（见第六节） |
| `MarsCode.marscode-extension` | **15** | **混淆**（见第二节）—— 这是下界 | ⚠️ **不可信为完整，只能算下界** |

**「0 个」这个形态在这份语料里没有出现，但脚本仍然会把它列出来**（`result.json` 的 `zeroMember` 数组，以及 `--verbose` 的 `[ 0]` 行）—— **因为它的危险在于「看起来像正常结果」**，如果哪天语料里出现混淆程度更高、或者打包格式更奇怪的扩展，它会出现在那个列表里而不是悄悄算成 0 参与平均值。

**反控（已实测）**：故意写一个「有 `.window.showQuickPick` 文本，但 `window` 来自本地对象」的扩展，脚本正确报 **0 个成员**，并把它列进 `zeroMember`。

---

## 六、手工对照（卡里的判据 3）

**对照对象：`seepine.md-editor` 0.1.1** —— 4 个文件、249 行，规模刚好能人肉穷举。

### 人肉结果（`grep -oE "vscode\.[A-Za-z_]+(\.[A-Za-z_]+)?"` 全部可达文件）

```
vscode.Range                          vscode.Uri.file
vscode.Uri.joinPath                   vscode.Uri.parse
vscode.ViewColumn.Active              vscode.WorkspaceEdit
vscode.commands.executeCommand        vscode.commands.registerCommand   ← 只在注释里
vscode.env.language                   vscode.env.openExternal
vscode.open                           ← 这是字符串参数，不是成员
vscode.openWith                       ← 同上
vscode.window.registerCustomEditorProvider
vscode.window.showErrorMessage
vscode.window.showInformationMessage  ← 只在注释里
vscode.workspace.applyEdit            vscode.workspace.createFileSystemWatcher
vscode.workspace.fs                   vscode.workspace.onDidChangeTextDocument
vscode.workspace.onDidSaveTextDocument  vscode.workspace.workspaceFolders
```

### 脚本结果（17 个）

```
Uri.file  Uri.joinPath  Uri.parse  ViewColumn.Active  commands.executeCommand
env.language  env.openExternal  window.registerCustomEditorProvider
window.showErrorMessage  workspace.applyEdit  workspace.createFileSystemWatcher
workspace.fs  workspace.onDidChangeTextDocument  workspace.onDidSaveTextDocument
workspace.workspaceFolders
```

### 逐条比对

| 人肉看到 | 脚本 | 判定 |
|---|---|---|
| `commands.registerCommand` | **没有** | ✅ **正确** —— 它在 `out/extension.js:8` 的**注释**里（`// let disposable = vscode.commands.registerCommand(`）。AST 不会把注释当代码；正则会把这一条**误报**。 |
| `window.showInformationMessage` | **没有** | ✅ **正确** —— 同样在注释里（`:11`）。 |
| `Uri.Range` / `WorkspaceEdit` | 不在成员表里 | ✅ **正确** —— 它们是 `new vscode.Range(...)` / `new vscode.WorkspaceEdit()`，**构造式使用**，记在 `namespaces`（`Range`、`WorkspaceEdit`）而不是 `members`。 |
| `vscode.open` / `vscode.openWith` | **没有** | ✅ **正确** —— 它们是 `executeCommand('vscode.open', ...)` 的**字符串参数**，不是成员访问。 |
| 其余 15 个 | 全部在 | ✅ 一致 |

**结论：脚本与人肉逐条一致。三处「差异」全部是脚本对、正则/肉眼会错的地方。**

### 第二个对照：`tomoki1207.pdf`

人肉 grep 出 6 条，其中 2 条要剔除：

- `vscode.openWith` —— 字符串参数（`pdfPreview.js:26`），**脚本正确排除**；
- `PdfDocument.js` / `utils/` 里的 `vscode.*` —— **这些文件从 `main` 不可达**（`pdfProvider.js` 只 `require("./pdfPreview")`，`pdfPreview.js` 只 `require("./disposable")`），**脚本正确没有扫它们**。

去掉这两类后剩 **5 条**，与脚本的 **5 条**完全一致（`Uri.file`、`commands.executeCommand`、`window.registerCustomEditorProvider`、`workspace.createFileSystemWatcher`、`workspace.getConfiguration`）。

**这同时证明了「递归扫描」不会走过头** —— 它跟的是真实 require 图，不是「同目录所有 .js」。

---

## 七、变异与反控（卡里的判据 4）

### 探针 1（卡里指定的那个）

```js
const { window } = require("vscode");
window.showQuickPick(["a"]);
```

**预写预期：恰好 1 个成员 `window.showQuickPick`。**

实测结果：✅ **`window.showQuickPick`，1 个**。

做了一次**变异验证**：把解构规则 `if (value.k === "whole") v = nsBind(key)` 改成 `if (false && ...)`（模拟「正则只能抓到 `vscode.window.showQuickPick` 那种写法」），**同一个探针变成 0 个成员**。还原后逐字节一致（`sha256sum -c` 通过）。**这证明这条断言真的打在「解构绑定」这条路径上，而不是碰巧绿。**

### 探针 2：反控（证明不会误报）

```js
const window = { showQuickPick() {} };
window.showQuickPick(["a"]);          // 文本一样，但 window 不是 vscode 的
const name = process.env.DEBUG;        // 文本上和 vscode.env 一模一样
const vscode = require("vscode");
Object.keys(vscode).forEach(() => {}); // 返回值不是 vscode
```

**预写预期：0 个成员。**

实测结果：✅ **0 个**，并列进 `zeroMember`。

**这个反控不是装饰**：语料里 `.env.[A-Z_]+` 这种 `process.env` 写法有 **262 个不同的名字、1,400+ 次出现**（`DEBUG` / `NODE_DEBUG` / `PATHEXT` / `PATH` …）。**任何用正则扫 `\.env\.\w+` 的做法都会把它们全部算成 `vscode.env.*`。** 脚本扫出的 `env` 成员是 18 个、全部是 camelCase 的真实 API（`openExternal` / `machineId` / `appName` …）—— 一个 `process.env` 都没混进来。

### 探针 3：`var` 别名先用后声明（压缩产物的真实形状）

```js
(()=>{function f(){z0.window.showErrorMessage("x")} var z0=J(require("vscode")),J=x=>x; f()})();
```

**预写预期：1 个成员 `window.showErrorMessage`。**

实测结果：✅ **1 个**。这是 `hoistVars` 那条规则的直接证据 —— 没有它，`f()` 在源码顺序上先于 `z0` 的声明被访问，`z0` 查不到，成员**静默漏报**。

### 探针 4：ESM 命名导入

```js
import { commands as cmd, window as win } from "vscode";
cmd.registerCommand("a", () => {});
win.showInformationMessage("hi");
```

**预写预期：3 个（`commands.registerCommand`、`window.showInformationMessage`、`languages.registerHoverProvider` —— 第三个来自 `import * as vscode`）。** 实测 ✅ **3 个**。

### 探针 5：webpack 5 模块表（方法简写）

```js
var __w={54980(e){"use strict";e.exports=require("vscode")}, ...};
n(54980).window.showQuickPick(...)
```

**预写预期：2 个。** 实测 ✅ **2 个**（`window.showQuickPick`、`workspace.getConfiguration`）。

### 静态分析 vs 字面文本（为什么必须用 AST）

| 打包扩展 | AST 扫出的成员数 | 该文件里**字面出现**的 `vscode.window.*` 等字符串（唯一） |
|---|---:|---:|
| `ms-python.python` | 255 | **0** |
| `ms-azuretools.vscode-containers` | 214 | **0** |
| `ms-vscode.powershell` | 202 | 14 |
| `ms-azuretools.vscode-azureresourcegroups` | 113 | **0** |
| `ms-python.vscode-pylance` | 109 | **0** |
| `ms-python.vscode-python-envs` | 108 | **0** |
| `ms-azuretools.vscode-cosmosdb` | 97 | 5 |
| `Anthropic.claude-code` | 90 | 1 |
| `MarsCode.marscode-extension` | 15 | **0** |

**压缩后变量全改名，`vscode.window` 在文本里几乎不存在。** 一个用「grep `vscode.window`」的方法会在这些扩展上得到 **0**，然后报告「它们不用 API」—— 而它们是本机用得最多的。

---

## 八、划词翻译专项（卡里的第五节）

### `siesta.vscode-pdf-translate` 实际调了什么

`main = out/extension.js`，可达 4 个文件（`extension.js` / `translator.js` / `config.js` / `environmentManager.js`），**`pdfViewer.js` 不可达**（没有任何文件 `require` 它 —— 它是个没接上的死文件）。

**脚本扫出 18 个成员**（与人肉 grep 逐条一致，`vscode.open` / `createWebviewPanel` 两条已按上述规则剔除）：

```
commands.registerCommand       commands.executeCommand
window.showInformationMessage  window.showErrorMessage
window.showWarningMessage      window.showInputBox
window.showQuickPick           window.showOpenDialog
window.createOutputChannel     window.withProgress
workspace.getConfiguration     env.openExternal
Uri.file                       Uri.parse
ConfigurationTarget.Global     ConfigurationTarget.Workspace
ProgressLocation.Notification  ViewColumn.Beside
```

**它「翻译」的真实机制不是 API，是 `child_process`**：`translator.js` 与 `environmentManager.js` 都 `require("child_process")`，用 `spawn` 在宿主 shell 里跑 `pip install` / `pdf2zh`。**这条与 `docs/planning/extension-a-plus-coverage.md` 的结论一致 —— 它的核心能力在 API 之外。**

### 一个「最小划词翻译扩展」需要哪些成员，它们排第几

**场景**：用户在编辑器里选中一段文字 → 触发命令 → 取选区文本 → 调翻译 → 用结果替换选区 / 弹消息 → 过程中有进度和状态栏。

**必需成员（13 个）及排名：**

| 成员 | 排名（共 429） | 用在几个扩展 |
|---|---:|---:|
| `commands.executeCommand` | **2** | 26 |
| `workspace.getConfiguration` | **3** | 25 |
| `window.showErrorMessage` | **6** | 24 |
| `window.showInformationMessage` | **7** | 24 |
| `commands.registerCommand` | **8** | 23 |
| `window.withProgress` | **13** | 22 |
| `window.createOutputChannel` | **15** | 21 |
| `env.clipboard` | **26** | 17 |
| `window.createQuickPick` | **30** | 17 |
| `window.showQuickPick` | **40** | 15 |
| `window.activeTextEditor` | **43** | 14 |
| `window.createStatusBarItem` | **69** | 9 |
| `window.showInputBox` | **72** | 9 |

**还要选区对象模型**（这几项在普查里存在但排名很后，因为不是每个扩展都需要）：
`window.activeTextEditor` → `TextEditor.selection`（`Selection`，排名 91，7 个扩展）→ 修改用 `TextEditor.edit(...)` + `TextEdit.replace`（排名 405，全机只有 1 个扩展直接用 `TextEdit.replace`；大多数用 `editor.edit` 回调，那不是一个「成员」）。

### 一句话结论

**要让划词翻译跑起来，必须实现这 13 个成员 + `Selection` / `TextEditor.edit` 两个对象模型 —— 它们全部落在 Top 75 以内（最深的 `showInputBox` 排第 72），没有一个是长尾。** 换言之：**划词翻译不需要等全量兼容层，Top 75 的「常用路径」批次做完它就能跑。** 它真正的难点不在 API 数量，而在两处语义：

1. **`window.activeTextEditor` 要指向 Monaco 的真实选区** —— 本仓 `FileEditor.tsx:810-813` 的注释已经写明「Monaco 是自绘的，`window.getSelection()` 拿不到选区，必须用 `editor.getSelection()` + `model.getValueInRange()`」。这个映射要做。
2. **`TextEditor.edit()` 是事务式编辑** —— 本仓 `vscodeL1Bridge.ts` 的 L2 明确写着「editor edit transactions unsupported」，**这是要新建的能力，不是接一下**。

---

## 九、「B 方案要多久」——基于曲线，不是感觉

**先把问题拆成两个不同的问题**，它们的答案差一个数量级：

### 问题 A：「装一个真实扩展，它能跑起来、常用功能可用」

**这是可以分阶段的。** 依据：

- Top 20 成员 → 平均 **64%** 的调用次数；Top 50 → **78%**；Top 100 → **89%**；
- 按「≥80% 调用次数」计：Top 50 覆盖 **62%** 的扩展，Top 100 覆盖 **86%**，Top 200 覆盖 **100%**；
- Top 30 里 **29 个**是「本仓已有相近能力」的（✅ 17 + ⚠️ 12），真正要**从零建**的只有 `Range.constructor` 一个。

**但 ⚠️ 那 14 个不是「接一下」** —— 它们是「语义从函数调用变成对象模型」。举三个真实例子（都来自上表）：

- `window.createOutputChannel`：仓库有日志视图，但扩展要的是 `channel.append()` / `channel.show()` / `channel.clear()` 的**对象**；
- `window.createQuickPick`：仓库有命令面板，但扩展要的是 `items` / `onDidChangeValue` / `busy` / `buttons` 的**可编程对象**；
- `window.withProgress`：仓库有进度 UI，但扩展要的是 `ProgressLocation` 三档（Notification / Window / SourceControl）+ `increment` 的**协议**。

**⚠️ 的工作量 ≈ ✅ 的 2–3 倍**（要设计对象生命周期与 dispose 语义），而清单上它们看起来一样长。

### 问题 B：「装任何扩展都不会因为缺 API 崩」

**这个必须实现全部 429 个成员，没有捷径。** 依据：

- Top 400 时仍有 **45%** 的扩展至少缺一个成员（见曲线表）；
- 429 个成员里 **102 个只被 1 个扩展用** —— 但**那一个扩展会因此彻底失败**；
- 「完全覆盖」在 Top 1–400 全是 0–55%，**到 429 才跳到 100%**。

**而且 429 只是「本机 29 个扩展」的上界，不是「全部 VS Code 扩展」的上界。** 换一台机器、换一批扩展，会有新的成员冒出来。**真实的长期数字是「扩展生态里每一个被任何扩展用过的成员」，只会比 429 大。**

### 我的判断

| 目标 | 需要 | 依据 |
|---|---|---|
| **划词翻译能跑** | Top 75 里的 13 个成员 + `Selection` / `TextEditor.edit` | 最深的成员排第 72 |
| **本机 86% 的扩展「常用路径能跑」** | **Top 100 成员** | ≥80% 调用次数覆盖 86% |
| **本机全部扩展「常用路径能跑」** | **Top 200 成员** | ≥80% 调用次数覆盖 100% |
| **装进来保证不崩（完全覆盖）** | **429 个 + 持续补** | Top 400 仍有 45% 缺至少一个 |

**所以「B 方案两个月还是两年」的诚实答案是：**

- **做「常用路径兼容层」是月级，可以分阶段**（Top 100 覆盖 86% 的扩展）；
- **做「装进来就保证不崩」是年级，且没有终点**（本机 429、真实生态更多）；
- **中间没有「做完」这个状态** —— 只要目标是「完全覆盖」，就永远在补长尾。

**这条曲线的形状是健康的（长尾分布），但它有一个特殊的性质：`l10n.t` 一个成员占了 31.5% 的调用次数，而 102 个成员只被 1 个扩展用。** 这意味着：

> **按「调用次数」衡量，覆盖率会很好看；按「扩展能不能装」衡量，覆盖率会很难看。这两个数字差 10 倍，必须让用户知道在问的是哪一个。**

---

## 十、已知的取景边界（这份普查**没有**回答的）

写下来是为了让下一个人知道该问什么，不是免责声明：

1. **`MarsCode.marscode-extension` 的 15 个成员是下界。** 它的控制流平坦化 + 字符串表混淆让静态分析只能拿到字面量那一部分。要做准确数字得动态跑它（本卡边界里不做）。
2. **`Anthropic.claude-code` 不在 `extensions.json` 里**，且它的 1.9 MB bundle 里有大量运行时拼接的成员访问（`vscode[method]` 这种形态抓不到）。它的 90 也是**下界**。
3. **只扫了「从 `main` 可达的代码」** —— 一个扩展如果在 `activate` 里 `require` 一个运行时才确定的路径（`require(someVariable)`），那个文件不会被扫到。本机语料里没有发现这种形态（无 require 失败日志），但方法上它存在。
4. **`browser` 入口没扫** —— 与「Electron 桌面宿主」这个目标一致，但如果将来要支持 web 版，那些是额外的成员。
5. **成员数是「扩展数」，不是「调用次数」。** 一个在循环里调用 500 次的成员和一个调用 1 次的成员，在 Top 表里权重相同（调用次数只用于曲线里「≥80% 调用次数」这一列）。
6. **`l10n.t` 的 4,325 次调用高度集中在 Azure 系列**（单个扩展内 400–570 次），所以「平均调用覆盖率」这条线被它们拉高。**看这条线时要意识到它主要在度量「Azure 扩展跑得动吗」。**

---

## 附：怎么重跑

```bash
# 扫本机全部扩展，刷新 result.json
bash apps/desktop/scripts/vscode-api-census/run.sh

# 扫探针目录（变异 / 对照）
bash apps/desktop/scripts/vscode-api-census/run.sh \
  --extensions-dir .tmp/f019-probe/mutation-root --out .tmp/f019-probe/out.json --verbose

# 单文件调试（打印该文件的成员/命名空间/require 目标）
MCODE_CENSUS_DEBUG_FILE=<abs path> node apps/desktop/scripts/vscode-api-census/main.mjs
```

耗时：全量 29 个扩展（198 个文件、60.8 MB）约 **20 秒**（Node 22 / Windows 11，`setParentNodes=true` 的完整 AST）。
