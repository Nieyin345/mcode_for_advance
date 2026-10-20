# T14｜扩展系统二开（复用 ModuleHost + Theia plugin-ext-vscode）

| 项目 | 值 |
|---|---|
| 编号 | T14 |
| 类型 | ARC-006 扩展线（**复用调查 + 接线，不重写插件运行时**） |
| 优先级 | 中 |
| 建议并发 | 可与 T02 / T13 并行（文件边界不重叠） |
| 预计规模 | 中大 |

---

## 台账怎么说（**派活前必读**）

台账 2026-10-19 强制实施指令**第 4 条**原文：

> **扩展/插件也遵守「能抄/能接就不从零写」**：优先复用 Mcode 现有 `ModuleHost` /
> 原生 Extension SDK、已有插件/Skills/MCP 生命周期和**可复用的成熟 VS Code API
> 兼容层思路（如经过许可/依赖审查可拆用的 Eclipse Theia `plugin-ext-vscode`）**，
> 按需接 Open VSX/VSIX；Node-RED 扩展仍以原版 Node 包/API 为主。**只写清单、API/RPC、
> 权限、贡献点 UI 映射和安装升级适配；不自己开发另一套完整插件运行时或假 `vscode.d.ts`
> 冒充兼容。** 上游扩展代码不是本仓已有 fork 时，**先锁定版本/许可/来源并实测，
> 再引入**。

**这条是本卡的唯一判据。** 任何"我们自己写一个 VS Code API 实现"的方案都**不合格**。

---

## 现状（已核实）

| 已有 | 位置 | 能力 |
|---|---|---|
| `ModuleHost` | `src/main/modules/ModuleHost.ts` | 权限、模块/能力注册、执行、撤权 —— **唯一事实源** |
| `permissionedProcessRunner` | 同目录 | 独立子进程 + 文件权限 + 网络守卫（T06/T11 刚加固） |
| `vscodeL1Bridge.ts` | 同目录 | **只有 L1**：单个 `contributes.commands` + 一个状态栏项 |
| `docs/planning/extension-vscode-compat.md` | — | 分级文档（L1/L2/L3），已记录 Theia 的许可与依赖 |
| 17 套 `module-*` smoke | `scripts/` | 生命周期、协议完整性、安装审批、撤权 |

**缺的是 L2**：`workspace.fs`、配置、通知、编辑器命令、LSP/Diagnostics。

---

## 开工前必读

1. **台账第 4 条**（上面已抄）—— 这是硬约束。
2. `docs/planning/extension-vscode-compat.md` **全文** —— 它已经把 Theia 的许可
   （EPL-2.0 OR GPL-2.0-only WITH Classpath-exception）与依赖面查清了。
3. `apps/desktop/src/main/modules/vscodeL1Bridge.ts`（约 200 行）——
   现有 L1 边界，本卡在它上面扩，不另起。
4. `apps/desktop/src/main/modules/ModuleHost.ts` 的 `invoke` / `authorize` /
   `requestApproval` 三段 —— 新 API 必须走同一条。
5. `apps/desktop/scripts/module-*` 至少读 `module-extension-lifecycle-smoke` 与
   `module-protocol-integrity-smoke` —— 它们是你的回归底线。

---

## 执行内容

### 第 0 步：先把 Theia 的复用可行性查清（**不做完这步不要写代码**）

台账要求「先锁定版本/许可/来源并实测，再引入」。要回答：

1. `@theia/plugin-ext-vscode` 的**最小可拆用边界**：能不能只取
   `plugin-vscode-init.ts` 那层 API 映射，而不拖入 Theia 的 core/editor/monaco？
2. 它的**依赖树**有多大？会与我们已有的 Monaco / React 19 / Electron 44 冲突吗？
3. **许可证**：EPL-2.0 / GPL-2.0 + Classpath exception 对我们的分发意味着什么？
   需不需要 NOTICE？能不能只链接不分发？
4. 有没有**更轻的替代**（例如 `@vscode/test-electron` 的 API 定义、
   或直接复用 VS Code 的 `vscode.d.ts` 做类型 + 自己写薄映射）？

**产出一张表**：方案 / 依赖数 / 许可 / 与现有栈冲突 / 可拆用程度 / 结论。
如果结论是"Theia 拆不动"，**如实写**，然后降级到"复用 `vscode.d.ts` 类型 + 薄映射"。

### 第 1 步：L2 API 清单与映射

按台账「只写清单、API/RPC、权限、贡献点 UI 映射」，逐个列出：

| VS Code API | Mcode 对应 | 走哪条既有通路 | 需要新权限吗 |
|---|---|---|---|
| `workspace.fs.readFile/writeFile` | `api.file.*` + 路径围栏 | 现有 IPC | 写要 |
| `workspace.getConfiguration` | `SettingRepo` | 现有 | 否 |
| `window.showInformationMessage` | `Toaster` | 新 RPC？还是复用 | 否 |
| `commands.executeCommand` | 已有 L1 | 现有 | 否 |
| `languages.createDiagnosticCollection` | LSP 面板 | 现有 lsp 模块 | 否 |
| `window.createStatusBarItem` | 已有 L1 | 现有 | 否 |

**原则**：能映射到 Mcode 既有能力的，就写一行 adapter；**不许在 bridge 里实现业务逻辑**。

### 第 2 步：接线（不是重写）

- 在 `vscodeL1Bridge.ts` 基础上扩到 L2，**保持它现有的严格 schema 校验风格**。
- 每个新 API 的调用都必须经过 `ModuleHost.invoke` 的 `authorize` + `requestApproval`。
- **不许**新开一条绕过 ModuleHost 的直连通道。

### 第 3 步：测试

- 在现有 `module-*` 套件里补断言，**不新建平行套件**。
- 每条新 API 都要有：正常路径 + 未授权拒绝 + 越界拒绝。
- **变异验证**：撤掉某个 API 的授权检查 → 对应断言必红。

---

## 边界（不要碰）

- **不要**自己写一套 `vscode.d.ts` 冒充兼容（台账明令禁止）。
- **不要**新造插件运行时或第二条权限通道。
- 不要碰 renderer（除必要性最小的贡献点 UI 映射，且要在回写区说明）。
- 不要碰 document / workflowEngines / mobile。
- 不要碰 `vscodeL1Bridge.ts` 已有的 L1 行为（只许扩，不许改）。
- **不要联网下载任何 VSIX 或 Theia 包**（调查阶段只读文档与 npm 元数据）。

---

## 验收判据

1. 第 0 步的方案表完成，**Theia 能不能拆用有明确结论 + 证据**。
2. 第 1 步的 API 表覆盖 L2 五类，每类标注「复用哪条既有通路」。
3. 新 API **全部经 ModuleHost**，有源码断言证明没有旁路。
4. 每条 API 有「正常 + 未授权 + 越界」三类断言。
5. 现有 17 套 `module-*` smoke 全绿。
6. 双包 tsc 干净。
7. **变异验证**：撤掉授权检查 → 断言必红；撤掉路径围栏 → 越界断言必红。

---

## 你要在回写区回答的问题

- Theia 的 `plugin-ext-vscode` 到底能不能拆？依赖多大？许可有没有障碍？
- 如果不能拆，我们的降级方案是什么？它还算「复用」吗？
- L2 的五个 API 里，有几个是"映射到既有能力"、有几个需要新写胶水？
- 有没有出现第二条权限通道？（台账明令禁止）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
