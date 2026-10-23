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
