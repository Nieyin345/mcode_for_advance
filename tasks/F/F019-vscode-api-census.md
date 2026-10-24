# F019｜真实扩展的 API 需求普查：26,961 行里我们到底需要多少

- Status: **done**
- Category: **P0 扩展主线（B 方案的需求侧）**
- Depends on: F017（Theia PoC 结论）；用户裁决「自己做，要做完整的」
- Exclusive writable files:
  - 新建 `apps/desktop/scripts/vscode-api-census/`（普查脚本 + 输出）
  - 新建 `docs/planning/vscode-api-census.md`（结果报告）
  - 本卡回写
- **不碰**：`packages/vscode-compat/**`（F018 在写）、`apps/desktop/src/**`、**根 `package.json` / `pnpm-workspace.yaml`**（F018 要改，别撞）

## Required Skills
- 无特殊。需要会读 `package.json`、会写 AST 或正则扫描、会做变异验证。

---

## 为什么要做这件事

F018 会给出 `@types/vscode` 的**全部**命名空间和方法数。Theia 的 `plugin-ext` 是
**26,961 行**。

**但「全都有」不等于「全都要」。** 如果真实扩展只用到其中 30%，那我们照着
100% 去做，会把工期乘三倍，而且做完之后没人用那 70%。

**这张卡回答的是需求侧**：本机能拿到的真实 VS Code 扩展，**实际调用了哪些
`vscode.*` 成员**，按被调用的扩展数排序。

**这个排序就是实现顺序。** 排第一的十来个成员，决定了「划词翻译能不能跑」。

---

## 数据源（本机现成，不下载任何东西）

```
C:\Users\Nieyin\.vscode\extensions\     ← 30 个目录（含 1 个 extensions.json）
```

**注意**：不是所有目录都是扩展（有 `extensions.json`），也有 `*-win32-x64` 这种
带平台后缀的。**先按 `package.json` 里的 `publisher` + `name` + `main` 三段判断它是不是
一个带代码的扩展**，并把判定结果列出来——哪些是纯语言包/主题（无 `main`），
哪些有代码。**纯主题扩展没有 API 需求，不计入统计，但要报出数量。**

---

## 任务

### 一、枚举扩展，分类

对每个目录读 `package.json`，分三类：

| 类别 | 判据 | 数量 |
|---|---|---|
| **无代码**（主题/语言包/纯声明） | 没有 `main` 字段 | ? |
| **有代码** | 有 `main` | ? |
| **不是扩展** | 无 `package.json` 或结构不对 | ? |

### 二、提取每个扩展的 `vscode.*` 调用

**这是核心技术工作。** 对每个有代码的扩展，扫描它的 JS（`main` 指向的文件
**以及它 require 的其他本地文件**，递归）。

**要提取两样东西：**

1. **命名空间级** —— `vscode.commands`、`vscode.window`、`vscode.workspace`……
2. **成员级** —— `vscode.commands.registerCommand`、`vscode.window.showInformationMessage`……

**提取方法要求**：用**真解析**，不是正则。

- JS 用 `acorn`（仓库的 `apps/desktop/node_modules` 里可能已有；没有就用 esbuild 的
  transform 走一遍 AST，或者用 TypeScript 自带的 parser —— **`typescript` 一定装了**）。
- 为什么不用正则：`vscode.commands.registerCommand` 可能写成
  `const { commands } = vscode; commands.registerCommand(...)`，
  正则抓不到，**会漏报**。而漏报正是这张卡最不能犯的错（见下方判据）。

**如果某些扩展是 webpack 打包过的单文件**（几 MB），照样扫，但要标注
「这是打包产物，成员数是打包后的」。

### 三、按「被多少个扩展调用」排序

产出一张表：

| 成员 | 用到它的扩展数 | 哪些扩展 | 本仓底层 |
|---|---:|---|---|
| `window.showInformationMessage` | ? | a, b, c | 通知服务 |
| `commands.registerCommand` | ? | … | ModuleHost |
| … | | | |

**「本仓底层」这列**：Mcode 已有 Monaco、终端（`terminal/`）、LSP（`lsp/`）、
文件系统、通知。**能直接映射的标 ✅，需要新建的标 ❌，语义对不上的标 ⚠️ 并写一句为什么。**

### 四、算出「够用线」

**回答这个问题**：要覆盖 X% 的有代码扩展，需要实现多少个成员？

```
Top 10 个成员覆盖 ___% 的扩展
Top 30 个成员覆盖 ___% 的扩展
Top 50 个成员覆盖 ___% 的扩展
```

**这条曲线的形状决定了 B 方案是「两个月」还是「两年」。** 如果 Top 20 就覆盖 80%，
那分阶段推进是可行的；如果 Top 50 才覆盖 50%，那说明扩展之间共性低，值得重新考虑
「接 Theia」这个被否掉的选项。

### 五、对「划词翻译」这个具体用例做一次专项核对

用户明确提过要**划词翻译**。本机有 `siesta.vscode-pdf-translate`，但那需要 PDF 编辑器。
**所以另外找一个最小可行形状**：

- `siesta.vscode-pdf-translate` 的 `main` 里调了哪些 API？**逐条列出**；
- 一个典型划词翻译扩展需要什么：`window.activeTextEditor` / `selection` /
  `replace` / `showInformationMessage` / `statusBarItem`…… **这些在普查里排第几？**

**结论要写成一句话**：「要让划词翻译跑起来，必须实现这 N 个成员，它们目前排在第几名。」

---

## 判据（这张卡最容易被做假的地方）

**1. 必须报「扫了几个文件、合计多少行」。**
如果只扫了 `main` 没扫它 require 的子文件，**成员数会显著偏少**，而结果看起来完全正常。

**2. 必须列出「一个成员都没扫到的扩展」。**
一个成员都没有？大概率是扫描失败，不是它真的不用 API。**这种情况要单独报，不能算进 0。**

**3. 必须做一次对照：手工核一个扩展，和脚本结果比对。**
挑一个你可能 20 行左右的扩展，人肉 `grep` 出它用的成员，和脚本输出对一下。
**对不上就是脚本错了，不是「脚本更全」。**

**4. 变异：故意用一个非正则能抓的形状测脚本。**
往 `.tmp/` 丢一个 `.js`：

```js
const { window } = require("vscode");
window.showQuickPick(["a"]);
```

**脚本必须能报出 `window.showQuickPick`。** 报不出来就是正则假装成 AST 了。

**预写预期**：先写「这个探针我预期报出 1 个成员」，再跑。

---

## 边界

- **不安装任何新依赖到根 `package.json`**（F018 在改它）；
- 需要 `acorn` 之类的话，装到 `apps/desktop` 或用已装的 `typescript`；
- **不读用户 `.vscode` 目录以外的任何东西**；
- 不跑全量、不起 Electron。

---

## 回写

1. **三类扩展的数量**（无代码 / 有代码 / 不是扩展）；
2. **扫了多少文件、多少行**；
3. **Top 30 成员表**（含「本仓底层」列）；
4. **覆盖曲线**（Top 10 / 30 / 50 各覆盖多少 % 的有代码扩展）；
5. **一个成员都没扫到的扩展清单**；
6. **手工对照那一个扩展的结果比对**（脚本 vs 人肉）；
7. **划词翻译用例专项结论**（一句 + 成员清单）；
8. **你对「B 方案要多久」的判断**——基于这条曲线，不是感觉；
9. 提交 SHA。

---

## 结果回写

**完整报告：`docs/planning/vscode-api-census.md`。** 下面只记结论与证据摘要。

### 1. 三类扩展的数量

| 类别 | 数量 | 明细 |
|---|---:|---|
| **有代码**（有 `main`） | **30** → 去重后 **29** | 1 组重复：latex-workshop 10.20.0（保留，`extensions.json` 登记）vs 10.15.0（哈希目录残留） |
| **无代码**（无 `main`） | **2** | 中文语言包；`vscode-node-azure-pack`（Extension Pack，只声明依赖，零自有代码） |
| **不是扩展** | **1** | `.02de5c43-…`：无 `package.json`，`.vsixmanifest` 是 **Pylance 2025.8.3 的残留目录**（28 MB，被新版替换后只留 `dist/`） |

**另有两条要报**：
- `MarsCode.marscode-extension` 与 `Anthropic.claude-code` **在磁盘上有、不在 `extensions.json` 里**（`.obsolete` 记的是它们更旧的版本）。是真扩展、有代码，计入；
- `*-win32-x64` 目录（debugpy / python / python-envs）**是正常扩展**，已计入。

### 2. 扫了多少文件、多少行

| | |
|---|---:|
| 扩展 | **29** |
| **文件** | **198** |
| **行** | **266,260** |
| 体积 | 60.8 MB |
| **解析失败** | **0** |
| 不同成员 | **429** |
| 不同命名空间/类 | **157** |

**「只扫 `main`」 vs 「递归 require」** —— 卡里判据 1 的量化证据：

| 口径 | 成员数合计 |
|---|---:|
| 只扫入口 | **1,276** |
| 递归 require | **2,202**（+73%） |

**9 个 azure 扩展的 `main.js` 只扫入口时是 0**（30 行加载器，正文零 `vscode.` 引用，真代码在 `require("./dist/extension.bundle")`）。只扫 `main` 会得出「它们不用 API」而实际它们是本机最密集的一批。

### 3. Top 30 成员表

完整表（含「本仓底层」逐条理由）见 `docs/planning/vscode-api-census.md` 第三节。摘要：

| # | 成员 | 扩展数 | 本仓底层 |
|---:|---|---:|---|
| 1 | `Uri.file` | 27 | ✅ L2 已有 |
| 2 | `commands.executeCommand` | 26 | ⚠️ 只支持一条已声明命令 |
| 3 | `workspace.getConfiguration` | 25 | ⚠️ L2 只认单 section + 预置 JSON |
| 4 | `EventEmitter.constructor` | 24 | ✅ Node EventEmitter + 包装 |
| 5 | `Uri.parse` | 24 | ⚠️ 需真 URI 解析器 |
| 6 | `window.showErrorMessage` | 24 | ✅ NotificationManager |
| 7 | `window.showInformationMessage` | 24 | ✅ L2 `l2Notify` |
| 8 | `commands.registerCommand` | 23 | ✅ L1 已有 |
| 9 | `window.showWarningMessage` | 23 | ✅ L2 已有 |
| 10 | `workspace.workspaceFolders` | 23 | ⚠️ 无多根工作区模型 |
| 11–30 | `env.openExternal` / `extensions.getExtension` / `window.withProgress` / `ProgressLocation.Notification` / `window.createOutputChannel` / `workspace.fs` / `l10n.t` / `ConfigurationTarget.Global` / `ThemeIcon.constructor` / `window.showTextDocument` / `workspace.openTextDocument` / `env.appName` / `env.machineId` / `FileType.Directory` / `Range.constructor` / `env.clipboard` / `env.language` / `FileType.File` / `Uri.joinPath` / `window.createQuickPick` | 17–22 | ✅ 11 / ⚠️ 8 / ❌ 1（Top 30 总账 ✅ 17 / ⚠️ 12 / ❌ 1） |

**Top 30 里 ✅ 17 个、⚠️ 12 个、❌ 1 个。** ✅ 集中在 `env.*` 常量、`Uri.file`、`commands.registerCommand`、`show*Message` —— 正好是 A+ 做过的那批。**⚠️ 才是真工作量**（语义从函数调用变成对象模型，≈ ✅ 的 2–3 倍）。

### 4. 覆盖曲线

| Top K | 完全覆盖 | ≥90% 调用次数 | ≥80% 调用次数 | 平均成员覆盖率 | 平均调用覆盖率 |
|---|---:|---:|---:|---:|---:|
| **10** | 0% | 0% | 0% | 17.5% | 29.9% |
| **20** | 0% | 0% | 13.8% | 29.9% | 64.1% |
| **30** | 0% | 0% | 34.5% | 38.7% | 69.9% |
| **50** | 0% | 17.2% | **62.1%** | **53.2%** | **78.5%** |
| **100** | 6.9% | 62.1% | 86.2% | 72.4% | 89% |
| **200** | 10.3% | 86.2% | **100%** | 85.8% | 94.4% |
| 429（全部） | **100%** | 100% | 100% | 100% | 100% |

三个口径回答三个问题，**不能混**：strict = 一个成员都不缺；≥N% 调用 = 常用路径能跑；平均 = 全体平均。

**`l10n.t` 一个成员占 31.5% 的调用次数（4,325 / 13,737），且高度集中在 Azure 系列** —— 「平均调用覆盖率」这条线主要在度量「Azure 扩展跑得动吗」。

### 5. 一个成员都没扫到的扩展

**0 个。** 29 个全部至少扫出 1 个成员。最少的是 `remote-ssh-edit`（5）与 `tomoki1207.pdf`（5，读完源码确认）。

`zeroMember` 列表仍然会产出（`result.json` + `--verbose` 的 `[ 0]` 行）—— **反控已实测**：故意写一个「有 `.window.showQuickPick` 文本但 `window` 来自本地对象」的扩展，正确报 0 并列入 `zeroMember`。

**`MarsCode` 的 15 是下界**（控制流平坦化 + 字符串表混淆，成员名运行时解码），报告里已标注。

### 6. 手工对照：`seepine.md-editor`（脚本 vs 人肉）

人肉 grep 全部 4 个可达文件，逐条比对：**一致，三处「差异」全部是脚本对、肉眼/正则错**：

| 人肉看到 | 脚本 | 判定 |
|---|---|---|
| `commands.registerCommand` | 没有 | ✅ 在**注释**里（`out/extension.js:8`）—— 正则会把注释当代码 |
| `window.showInformationMessage` | 没有 | ✅ 同上（`:11`） |
| `Uri.Range` / `WorkspaceEdit` | 不在 members | ✅ 构造式 `new vscode.X()`，记在 namespaces |
| `vscode.open` / `vscode.openWith` | 没有 | ✅ 是 `executeCommand("vscode.open", …)` 的**字符串参数** |

**第二个对照 `tomoki1207.pdf`**：人肉 6 条，剔除「字符串参数 1 条 + 从 main 不可达的文件里的 1 条」后剩 5 条，与脚本完全一致 —— 同时证明递归扫描跟的是真实 require 图，**不是「同目录所有 .js」**。

### 7. 划词翻译专项结论

**siesta 的 `main` 可达 4 个文件、18 个成员**（`pdfViewer.js` 是死文件，无人 require）。**它「翻译」的真实机制是 `child_process.spawn` 跑 `pdf2zh`，不是 API** —— 与原 A+ 报告的结论一致。

**最小划词翻译需要 13 个成员 + `Selection` / `TextEditor.edit` 两个对象模型**：

```
commands.executeCommand(2)  workspace.getConfiguration(3)  showErrorMessage(6)
showInformationMessage(7)   commands.registerCommand(8)    window.withProgress(13)
createOutputChannel(15)     env.clipboard(26)              window.createQuickPick(30)
window.showQuickPick(40)    window.activeTextEditor(43)    createStatusBarItem(69)
window.showInputBox(72)     + Selection(91) + TextEditor.edit
```

**一句话结论：要让划词翻译跑起来，必须实现这 13 个成员 —— 它们全部在 Top 75 以内（最深的 `showInputBox` 排第 72），没有一个是长尾。** 不需要等全量兼容层。真正的难点是两处语义：
1. `window.activeTextEditor` 要指向 Monaco 的真实选区（`FileEditor.tsx:810-813` 已写明 Monaco 自绘、`window.getSelection()` 拿不到）；
2. `TextEditor.edit()` 是事务式编辑，`vscodeL1Bridge` 的 L2 已明确写「editor edit transactions unsupported」—— **要新建，不是接一下**。

### 8. 「B 方案要多久」——基于曲线

**先拆成两个问题，答案差一个数量级：**

| 目标 | 需要 | 依据 |
|---|---|---|
| **划词翻译能跑** | Top 75 里的 13 个 + 2 个对象模型 | 最深排第 72 |
| **86% 扩展「常用路径能跑」** | **Top 100 成员** | ≥80% 调用覆盖 86% 扩展 |
| **全部扩展「常用路径能跑」** | **Top 200 成员** | ≥80% 调用覆盖 100% |
| **装进来保证不崩（完全覆盖）** | **429 个 + 持续补** | Top 400 仍有 45% 缺至少一个 |

**诚实结论**：
- **「常用路径兼容层」是月级、可分期**（Top 100 → 86%）；
- **「装进来就保证不崩」是年级、且没有终点** —— 本机 429 只是上界不是上界，真实生态只会更多；任何漏掉的成员（哪怕全机只有 1 个扩展用）都会让那个扩展抛 `undefined is not a function`；
- **中间没有「做完」这个状态。**
- **曲线形状是健康的长尾，但「按调用次数」和「按能不能装」差 10 倍** —— 这两个数字必须让用户知道问的是哪一个。

### 9. 未做 / 已知边界

- `MarsCode` 的 15 是下界（混淆），`Anthropic.claude-code` 的 90 也是下界（`vscode[method]` 动态访问抓不到）；
- `browser` 入口未扫（与 Electron 桌面宿主目标一致）；
- 运行时拼接的 `require` 不可见（本机未发现，方法上存在）；
- `l10n.t` 的调用次数高度集中于 Azure 系列（报告 §10 已写明）。

### 10. 提交 SHA

见本卡最后一行（`docs(F019)` 提交）。
