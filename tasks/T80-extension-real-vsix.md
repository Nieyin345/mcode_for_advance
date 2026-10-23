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

文档把 `workspace.fs.readFile` 标 **L1-C（未接入）**、`writeFile` 标 **L2（待补）**、`showInformationMessage` 标 L2、`getConfiguration` 标 L2、`registerTextEditorCommand` 标 L2、`createDiagnosticCollection` 标 L2。

**但我读 `vscodeL1Bridge.ts:150-215`，这些全都有实现。**

**先判断：是文档过期了，还是这些实现是「假的」（比如只处理了自己造的夹具能命中的形状）？**

这才是本卡的核心问题。**做一次性全量判断，写进回写区。**

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

1. **文档 vs 代码的一致性判断**（哪些 API 文档说没做、实际做了；哪些反过来）—— **逐条列表**。
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
