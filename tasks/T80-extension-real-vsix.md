# T80｜扩展线：拿真实 VSIX 走一遍 L1-P 桥，而不是只跑自己造的夹具

- Status: ready-for-agent
- Category: **产品主线验收（扩展线）**
- Priority: **P0** —— 扩展是四条主线之一，但这块从未用真实扩展验过
- Depends on: ARC-006 设计文档、`vscodeL1Bridge.ts`、`vscode-l1-smoke`
- Exclusive writable files: **只读 + `.tmp/` 探针**。**不改 `vscodeL1Bridge.ts`、不改 `vscode-l1-smoke`。**

## Required Skills
- `mcode-smoke`：无头验证。
- `code-review`：判断「这个夹具验的是不是真实场景」。

## 背景：一个从未被打破的自我循环

`docs/planning/extension-vscode-compat.md` §4 写着：

> **文件**：`apps/desktop/src/main/modules/vscodeL1Bridge.ts`，专项无头测试 `apps/desktop/scripts/vscode-l1-smoke/`。
> 本地虚构 VSIX (ZIP STORE 两文件，extension/package.json + extension/extension.js)

**「本地虚构 VSIX」** —— 这个套件验的是**自己造的扩展**。

### 这意味着什么

`vscode-l1-smoke` 全绿证明的是：**「我们造的扩展能在我们的桥上跑」**。

它**不证明**：

- 真实的 VSIX 包结构能不能被解析（真实包有 `[Content_Types].xml`、目录层级更深、可能用 DEFLATE 压缩）；
- 真实的 `package.json` 贡献点写法能不能被接受（真实扩展可能声明多个 `contributes.commands`）；
- 真实的扩展代码写法能不能跑（真实扩展用 `require("vscode")` 的完整对象，可能立刻用 `context.subscriptions.push(...)`、`workspace.getConfiguration()` 等）。

**这是「判据在自己的目标上工作，但目标不是真实用户会遇到的」的又一例** —— 和今天 T65 的留白判据同型。

## 任务

### 第一步：先核实「文档说的和代码实际写的」是否一致

> **⚠️ 2026-10-23 更正（F 在读卡时指出，总控核实）**：本节原来的前提是错的。
>
> 我写卡时说「文档标 L2 未接入、但代码里有实现，所以要么文档过期要么实现是假的」。
>
> **F 读了 §6.2（第 122-128 行）那另一张表，发现我漏了它。** 那张表逐条列了每项实现的**限制**：
>
> | API | §6.2 写的限制 | 代码实证 |
> |---|---|---|
> | `workspace.fs.readFile/writeFile` | 单文件 `Uri.file`、最大 1 MiB；无目录遍历、无其他 schema、无 CAS | `:163` 超 1 MiB 抛；`:145-148` fsPath 不等就抛；`:167` 无 `resource.write` 抛 |
> | `getConfiguration` | 只认 `publisher.name` 命名空间；无实时监听、无写回 | 收快照参数，非实时 |
> | `showInformationMessage` | 只支持纯文本无交互；没端口明确报错 | `l2Notify` 限额 256 字符、最多 4 条 |
> | `registerTextEditorCommand` | 只选当前文件；`editor.edit` **明确抛 unsupported** | `:201` 确实是 `throw Error(...)` |
> | `createDiagnosticCollection` | 仅本次调用快照、不持久订阅 | 无订阅 API |
>
> **所以：§2 是产品级承诺（不是完整 L2），§6.2 是技术调查（有受限原型）。两张表各自成立，不矛盾。**
>
> **真实问题不是事实错误，是文档结构**：两节没有互相引用，读 §2 的人会以为「完全没有」，读 §6.2 的人才知道「有受限版」。
>
> **F 的结论**：「没有一条是『只处理夹具形状』。围栏比文档说的还严（要求 fsPath 完全等于唯一授权资源）。」
>
> 而且 `vscode-l1-smoke` 里有一组**逃逸测试**（`escape-read` / `escape-write` / `escape-config` / 诊断越界 / 编辑器越界读）——**它不只在验「能跑」，还在验「跑不出去」。**
>
> **所以本卡的核心问题收窄了**（F 的原话）：
>
> > **真实 VSIX 装进来之后，`vscode-l1-smoke` 造的那个「两文件 ZIP STORE」夹具没覆盖的东西，会不会让扩展挂掉？**
>
> 三类具体风险：
>
> 1. **包结构**：DEFLATE / `[Content_Types].xml` / 目录层级深；
> 2. **清单**：多个 `contributes.commands`、未知字段；
> 3. **扩展代码写法**：`context.subscriptions.push(...)` 一上来 push 十几项、`require("vscode")` 后立刻用 `workspace.getConfiguration()`。**F 判断第 3 类最可能炸**，因为桥的 API 面是白名单式的。

### 第二步：拿一个真实 VSIX 试

**不要从网上下载**（不允许网络下载扩展，这是 §1 的边界）。

**从本机已有的 VS Code / Cursor / Windsurf 安装目录里找一个**：

```bash
ls ~/.vscode/extensions/ 2>/dev/null | head -5
ls ~/AppData/Roaming/Code/User/globalStorage 2>/dev/null | head -3
```

**如果本机没有任何 VSIX/扩展目录**，那就造一个**尽量接近真实**的：

- 用 **DEFLATE 压缩**（不是 STORE）—— 真实 VSIX 是 ZIP DEFLATE；
- 包含 `[Content_Types].xml`（真实 VSIX 必有）；
- `package.json` 里 **`contributes.commands` 有多个条目**（真实扩展常见）；
- `extension.js` 里**真的 `require("vscode")` 并用多个 API**（不只 `commands.registerCommand`）。

### 第三步：记录它在哪里失败

**每一次失败都是一个具体结论**。分类：

| 失败类型 | 含义 |
|---|---|
| **包结构**（ZIP 压缩方式 / `[Content_Types].xml`） | 桥的解析器只认自己造的形状 |
| **清单**（多个 contributes / 未知字段） | 校验过严或过松 |
| **API 面**（扩展用了桥没实现的 API） | 文档的 L2/L3 分级是否准确 |
| **权限**（扩展要读工作区外的文件） | 围栏是否真的拦住了 |

### 第四步：验收结论

**回答一个问题**：**这个桥现在能不能装一个真实的、别人写的扩展？**

- 能 → 附带条件（哪些 API 可用、哪些会立刻失败）；
- 不能 → **缺的最关键的是什么**（按「真实扩展最常用」排序）。

## 验收判据

1. **文档结构问题记一笔就够了**（§2 与 §6.2 没互相引用，导致读者以为「完全没有」）—— **不用再逐条核对实现**，F 已经核过了，把结论引用即可。
2. **真实/接近真实的 VSIX 的实际运行结果**（不是「我觉得应该能跑」）。
3. **失败分类表**（包结构 / 清单 / API / 权限）。
4. **明确结论**：能不能装真实扩展，缺什么。
5. **不改产品代码**（发现要改，报告给总控，另开卡）。

## 边界

- **只读 + `.tmp/` 探针**；
- **不下载任何网络扩展**（§1 的硬边界）；
- **不改 `vscodeL1Bridge.ts`、不改 `vscode-l1-smoke`**；
- 不跑全量、不起 Electron；
- 如果本机有真实扩展目录，**只读它，不要改动**（先 `cp` 到 `.tmp/` 再试）。

## 遇到问题先检索

VSIX 的包结构规范先查官方文档（`vsce` 的打包规则）。**不要凭猜造包**——造错了测不到真实问题。

## 提交

`git add <明确路径>` + `git commit -m "<信息>" -- <明确路径>`。**`-m` 在 `--` 前面。**
末尾加 `Co-Authored-By: Claude Fable 5.0 <noreply@anthropic.com>`。

## 回写

`tasks/T80-extension-real-vsix.md` 末尾追加 `## 结果回写（2026-10-23）`：
文档 vs 代码逐条对比、VSIX 来源与构造方式、实际运行结果、失败分类、能不能装真实扩展的结论、提交 SHA。

## 结果回写（2026-10-23）

> 执行会话（F）。**只读产品代码 + `.tmp/t80/` 探针**，未改 `vscodeL1Bridge.ts`、未改 `vscode-l1-smoke`。
> 结论先行：**这个桥现在装不了任何真实的、别人写的扩展。** 它在**四层里每一层**都会拒绝，
> 而且第一层（包结构）就挡掉了几乎所有市场 VSIX。缺的不是某个 API，是「扩展宿主」这件事本身没做。

### 0. 一个比卡上更根本的事实：这个桥没有生产调用方

卡上默认它是「已接好的能力，只是没拿真扩展验过」。实测不是：

```bash
grep -rn "vscodeL1Bridge" apps packages --include=*.ts --include=*.tsx --include=*.mjs | grep -v 自身 | grep -v vscode-l1-smoke
# → 无输出
grep -rn "vsix\|VSIX" packages/contracts/src/ipc/     # → 无输出
```

`VscodeL1Bridge.install()` 与 `readMinimalVsix()` **只有 `vscode-l1-smoke` 一个调用方**，
`RpcMap` 里没有任何安装扩展的 IPC。所以「能不能装真实扩展」目前不是产品缺陷，
而是**这个实验离产品化有多远**的问题。下面按这个口径回答。

### 1. 文档 vs 代码：卡上说的「自相矛盾」不成立，真实问题是文档结构

卡上第一步要求核实文档与代码是否一致。**F 上一轮已核过，本轮复核后同意，并补一条更准确的定位：**

- **§3（第 27-53 行）是产品级承诺表**，把 `workspace.fs.writeFile`、`showInformationMessage`、
  `registerTextEditorCommand`、`getConfiguration`、`DiagnosticCollection` 都标成 **L2（待补）**，
  并在第 53 行写「L2 与 L3 可随真实宿主接线/上游复用重新评估；在此之前 manifest/API 发现必须显式报"不可用"」。
- **§6.2（第 120-128 行）是技术调查表**，逐条写了这六项**已经有了受限实现**及其围栏
  （单文件 `Uri.file`、最大 1 MiB；只认 `publisher.name` 命名空间；`editor.edit` 明确抛 unsupported）。

**两张表各自都对，但读者会得出相反结论** —— 只读 §3 的人以为「完全没有，会明确报不可用」，
只读 §6.2 的人以为「有受限版」。**§3 没有指向 §6.2 的链接。** 这是文档结构问题，不是事实错误。

**代码侧复核（本轮新增，可验证）**：六项 L2 全部真实存在，且围栏比文档写的更严：

| API | §6.2 声称 | 本轮实测 |
|---|---|---|
| `workspace.getConfiguration` | 只认 `publisher.name` 命名空间 | C2L2 装配端口后通过；C2 不装配 → `Cannot read properties of undefined` |
| `showInformationMessage` | 无端口明确报错 | C3 通过（端口装配时） |
| `workspace.fs.writeFile` | 每次 `requestApproval` | C4 无 fileWrite → `L2 resource.write permission required`；C5 有 fileWrite 但缺审批端口 → `approval_unavailable`（**我的 harness 缺端口，不是产品限制**，补 `requestApproval` 后通过） |
| `registerTextEditorCommand` | `editor.edit` 明确抛 unsupported | C8 → `L2 editor edit transactions unsupported` |
| `createDiagnosticCollection` | 无端口明确报错 | C6 → `L2 diagnostics host port unavailable`；C7 端口齐全 → 通过 |
| `workspace.fs.readFile` | 单文件、路径围栏 | D1 读未授权路径 → `L2 scope denied: URI differs from authorized resource` |

**结论：§6.2 的「有受限实现且如实标注限制」是可信的。代码没有骗人。**
（卡上「文档标 L2 未接入、但代码里有实现」的最初怀疑，F 上一轮已撤回，本轮独立复现一致。）

### 2. 真实扩展从哪来

**没有联网下载**（§1 硬边界）。用的是本机已装的真扩展：

```
~/.vscode/extensions/mechatroner.rainbow-csv-3.24.1   （Rainbow CSV，真·市场扩展）
  58 个文件 / 3.0 MB / extension.js 136,516 bytes / package.json 13,495 bytes
  contributes 9 类 / commands 24 条 / activationEvents 11 条 / dependencies 0
  extension.js 顶层 require: vscode, path, os, fs, child_process + 4 个同包模块
```

只读原目录，产物写在 `.tmp/t80/`。用它的**真实 `package.json` 和真实 `extension.js`** 逐个特征
重构 VSIX（`.tmp/t80/make.py`、`ladder2.ts`），再用**完整安装路径**
（`VscodeL1Bridge.install` + `executeCommand`，走真实 `ModuleHost` + 受控子进程）跑，
而不是只调 `readMinimalVsix` —— 否则量不到 API 面和权限层。

### 3. 四层实测结果（21 级阶梯，通过 5 级）

探针：`.tmp/t80/ladder2.ts`（结果 `.tmp/t80/ladder2.json`）、`.tmp/t80/manifest.ts`、
`.tmp/t80/size.ts`、`.tmp/t80/builtin.ts`。

#### 第一层：包结构 —— 真实 VSIX 在这一层就全军覆没

| 形态 | 结果 |
|---|---|
| A0 真实 VSIX 形态（DEFLATE + `[Content_Types].xml` + 真文件） | `VSIX requires exactly two plain ZIP entries` |
| A1 只留两个 allowlist entry，仍是真实文件 | `VSIX size out of L1 bounds` |
| A2 两个 entry + DEFLATE | `Unsupported VSIX ZIP entry`（`method !== 0`） |
| 尺寸上限精确边界（`size.ts`） | manifest **4096 过 / 4097 红**；entry **24576 过 / 24577 红** |
| 真实扩展归档体积 | 3.0 MB，**上限 128 KiB，差 24 倍** |

**三重硬约束**：① 恰好 2 个 ZIP entry（真实包至少 3 个：`[Content_Types].xml` +
`extension.vsixmanifest` + `extension/` 下一个文件）；② 只认 STORE（vsce 用 yazl，
默认 `compress: true`，即 **DEFLATE**）；③ 128 KiB 总包 + 4 KiB 清单 + 24 KiB 入口。

> 官方依据（卡上要求先检索）：vsce 的 `package.ts` 会用 yazl 写入
> `{ path: '[Content_Types].xml', contents: ... }` 并把扩展内容放进 `extension/` 目录；
> yazl 默认 `compress: true`。**DEFLATE + `[Content_Types].xml` + `extension/` 前缀是市场
> VSIX 的常态，不是特例。**（来源：microsoft/vscode-vsce `src/package.ts`、yazl README。）

#### 第二层：清单 —— 真实扩展的每条常规写法都被拒

全部用超小体积夹具，排除尺寸干扰：

| 真实扩展的写法 | 结果 |
|---|---|
| 基准：完全符合 schema 的最小清单 | 通过 |
| `main: "./extension"`（Rainbow CSV 的真实值；VS Code 惯例，省略 `.js`） | `invalid_literal, expected "./extension.js"` |
| 命令 id 用真实值 `rainbow-csv.CSVLint`（VS Code 惯例 `<name>.<cmd>`，不带 publisher） | `VSIX command must use its publisher/name prefix` |
| 顶层多一个 `description`（真实清单都有） | `unrecognized_keys: description`（`.strict()`） |
| 命令条目多一个 `category`（真实清单常见） | `unrecognized_keys: category` |
| **两个命令条目**（真实扩展几乎都有） | `Array must contain at most 1 element(s)`（`z.tuple` 长度 1） |
| `activationEvents: []`（VS Code 1.74+ 的默认写法） | `Only the declared onCommand activation is supported` |
| `activationEvents` 两条 | `maximum: 1` |
| `contributes.configuration`（真实扩展都有） | `unrecognized_keys: configuration` |

**Rainbow CSV 自己的 24 条命令 / 9 类 contributes / 11 条 activationEvents，一条都对不上。**
清单层不是「过严导致少量边缘扩展被拒」，是**只接受为这个桥手写的单命令清单**。

#### 第三层：API 面 —— 桥的 shim 是一个白名单小对象

`extension.js` 运行在 `new Function` 里，`require` 被替换成 `requireCompat`：**只有 `"vscode"` 能过**。

| API | 结果 |
|---|---|
| C1 `commands.registerCommand` + 返回字符串 | 通过 |
| C9 一个 `createStatusBarItem` | 通过 |
| C10 两个 statusBar | `L1 permits one status bar item` |
| C2 `workspace.getConfiguration`（未装 L2） | `Cannot read properties of undefined`（`workspace` 整个不存在，不是一个「未实现」的报错） |
| C11 `require('./csv_utils')`（同包模块） | `Unsupported VS Code extension import: ./csv_utils` |
| C12 `require('papaparse')`（第三方依赖） | `Unsupported VS Code extension import: papaparse` |
| `require('fs' / 'path' / 'os' / 'child_process' / 'node:fs')` | 全部 `Unsupported VS Code extension import` |
| C8 `registerTextEditorCommand` + `editor.edit` | `L2 editor edit transactions unsupported` |

**真实的 Rainbow CSV 用到 53 个不同的 `vscode.*` 命名空间/成员**（`commands.registerCommand` 25 次、
`Range` 19、`window.showTextDocument` 7、`workspace.openTextDocument` 7、`createStatusBarItem` 6、
`showErrorMessage` 5、`registerDocumentRangeSemanticTokensProvider` 4、`createWebviewPanel` 2 ……）。
桥实现了其中 **0 个完整语义**；能跑通的只有 `registerCommand`（1 个）+ 1 个 statusBar 快照。
`require('fs')` 都被拒，意味着**连「不用 vscode API、直接读文件」这条逃生路都没有**。

#### 第四层：权限 —— 围栏是真的，而且比文档严

| 场景 | 结果 |
|---|---|
| 读未授权路径 | `L2 scope denied: URI differs from authorized resource` —— 拦住了 |
| 写未授权 + 无 fileWrite | `L2 resource.write permission required` —— 拦住 |
| 写 + fileWrite + 缺审批端口 | `approval_unavailable` —— 失败关闭 |
| 写 + fileWrite + 有审批端口 | 通过（每调用一次审批一次） |

**权限层是本切片做得最好的部分**：默认拒绝、缺端口失败关闭、围栏要求 `fsPath`
**完全等于**唯一授权资源。这一层没有发现漏洞。

### 4. 失败分级表

| 层 | 挡掉的东西 | 严重度 | 是否「设计如此」 |
|---|---|---|---|
| **包结构** | 所有真实市场 VSIX（DEFLATE / 多 entry / >128 KiB） | **致命** | 是（§4 已承认「绝大多数真实 VSIX 当前会被拒」） |
| **清单** | 所有多命令、带 `description`/`category`/`configuration`、`main` 省略 `.js` 的清单 | **致命** | 半是（单命令是 L1 设计，但 `main` 字面量、禁止 `description` 是无必要的严） |
| **API 面** | 任何用超过 `registerCommand` + 1 个 statusBar 的扩展；任何 `require` 非 `vscode` 的模块 | **致命** | 是（L1 白名单设计） |
| **权限** | 越界读写 | — | 是，且实现正确 |

### 5. 结论：能不能装真实扩展？

**不能。不是「能装但有部分 API 不可用」，是连解析都过不去 —— 四层里前两层就足以拒掉本机任何一个真实扩展。**

按「真实扩展最常用」排序，缺的关键能力：

1. **能读真实 VSIX 包**（DEFLATE 解压 + 任意 entry 数 + 几百 KB～几 MB）。这是**前提条件**，
   其余全部排它后面 —— 没有这一条，后面的 API 实现再多也装不进去。
2. **通用模块加载**（同包 `require('./x')` + `node_modules`），以及 VS Code 扩展事实上的标准做法：
   用 esbuild/webpack 打成单文件（很多扩展已经这么做了，但 Rainbow CSV 没有）。
3. **清单校验放开到 VS Code 规范**（多命令、`description`/`category`/`configuration` 等常规字段、
   `main` 允许省略 `.js`、命令 id 允许不带 publisher 前缀）。
4. **真正的编辑器 API**（`TextDocument`/`Range`/`Selection`/`editor.edit`/`showTextDocument`）——
   这是「扩展能干活」和「扩展只是个按钮」的分界线。
5. **webview**（Rainbow CSV 的 SQL 界面、LaTeX Workshop 的 PDF 预览都靠它）。

**和产品主线的对照**：`CLAUDE.md` 写的扩展线是「`ModuleHost` + VS Code API 薄映射」。
本卡实测说明：**当前的「薄映射」映射的是一个手写单命令模块，不是 VS Code 扩展。**
要走到「能装真实扩展」，需要的是**完整 VS Code 扩展宿主**（Theia / code-server 那条路），
而非继续加 API —— §6.1 已经否决了整包 Theia（19 个直接依赖、EPL/GPL），
那条否决意见在「要装真实扩展」这个目标下**需要重新评估**，因为自建宿主的工作量远大于接 Theia。

### 6. 建议（需要总控裁决，本卡不动产品代码）

- **短期（不改代码）**：在 `extension-vscode-compat.md` §3 第 53 行加一句指向 §6.2 的链接，
  并把「L2（待补）」改成「L2 受限原型（见 §6.2）」。这是文档结构修复，成本一行。
- **中期**：把「能不能装真实扩展」写成产品决策，而不是默认能力 —— 当前桥**没有生产调用方**，
  也没有安装 IPC，所以现在没有用户在期待它。
- **若确定要做真实扩展**：核心问题从「补哪些 API」变成「自建宿主 vs 接 Theia」，
  应在 §6.1 的表里以「装真实扩展」为目标重新算一次账。

### 7. 未做 / 存疑

- **没测 `.vsixmanifest` 和签名**：桥在 ZIP 层就拒了真实包，签名校验根本没机会执行。
- **没测 Windows 特有的 `egress_isolation_unavailable`**：`vscode-l1-smoke` 已覆盖（JS-only 降级需显式同意），
  本轮夹具复用了同样的临时 consent，没有重复验。
- **C5 第一次失败是我的 harness 缺 `requestApproval` 端口，不是产品限制** —— 补端口后通过，
  已在第 3 节写明，避免后人把它当成缺陷。
- **Rainbow CSV 的 `extension.js` 是 136 KB 且 require 了 `fs`/`child_process`**，即使放宽所有限制，
  它的 CodeLens / webview / semanticTokens 也一个都跑不了。**它在本桥上是 0% 可用，不是 10%。**
- 本卡只读 + `.tmp/`，**未提交任何产品代码改动**。
