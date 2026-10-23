# T85｜扩展线要不要产品化：不是「修哪些 API」，是「要不要做 VS Code 扩展宿主」

- Status: **ready-for-human**（这是产品决策，不是执行任务）
- Category: **产品定位决策**
- Priority: **P0 —— 它决定扩展线接下来投不投人、投多少**
- Depends on: T80（`ecb5035a`，四层实测）、`docs/planning/extension-vscode-compat.md` §3 / §6
- Exclusive writable files: 本文档

## Required Skills
- 无（这是决策，不是实现）。

## 背景：T80 的实测改变了一个前提

`CLAUDE.md` 写着扩展线是：

> **扩展** | `ModuleHost` + VS Code API 薄映射 | 各自审查

**A 在 T80 里用真实的 `mechatroner.rainbow-csv-3.24.1`（本机 VS Code 已装扩展，未联网下载）逐层测了。**

结论：**四层里三层拒绝，只有权限层守住了。**

| 层 | 实测结果 |
|---|---|
| **包结构** | 要求恰好 2 个 ZIP entry / 只认 STORE / 总包 ≤128 KiB。**真实扩展 3.0 MB，差 24 倍** |
| **清单** | `main` 必须字面量 `./extension.js`；命令 id 必须带 publisher 前缀；`.strict()` 拒 `description`/`category`；`z.tuple` 只收 1 条命令（真实扩展有 **24** 条） |
| **API 面** | `require` 白名单只有 `"vscode"`；真实扩展用 **53 个** `vscode.*` 成员，桥实现 0 个完整语义 |
| **权限** | ✅ **唯一守住的**：越界读写拦住、缺审批端口失败关闭、围栏要求 fsPath 完全等于唯一授权资源 |

### 而这条线现在还不是「产品」

**A 的第 0 条发现，比三层拒绝更根本**：

```bash
$ grep -rn "VscodeL1Bridge\|readMinimalVsix" apps/desktop/src/ | grep -v vscodeL1Bridge.ts:
（零）
```

**`VscodeL1Bridge.install` 和 `readMinimalVsix` 全仓只有 `vscode-l1-smoke` 一个调用方，`RpcMap` 里没有任何安装扩展的 IPC。**

> **所以「能不能装真实扩展」目前不是产品缺陷，是「实验离产品化多远」的问题。**

## 要决定的是什么

**不是「修哪些 API」，是下面这个问题：**

> **Mcode 要不要成为一个能跑真实 VS Code 扩展的宿主？**

### 三个选项（成本与后果差一个数量级）

| 选项 | 含义 | 成本 | 后果 |
|---|---|---|---|
| **A. 不产品化** | 保持现状：一个受限的、单命令的模块宿主，明确标注「不是 VS Code 扩展宿主」 | **0** | 扩展线不做社区生态；自有扩展用 `ModuleHost` 原生机制 |
| **B. 收窄目标** | 明确支持**一小类扩展**（比如「只读、单命令、小体积」），并把限制写进 `CLAUDE.md` 和文档 | **小**（改文档 + 可能放宽 2-3 个限制） | 用户知道什么能装什么不能；**但绝大多数市场扩展仍装不了** |
| **C. 真做 VS Code 宿主** | 读真实 VSIX（DEFLATE / 多 entry / 几 MB）、通用模块加载、清单放开到 VS Code 规范、真编辑器 API、webview | **大**（不是补 API，是**自建宿主 vs 接 Theia**） | 真正的扩展生态；**但要重算 §6.1 否决 Theia 的账** |

### 选项 C 的真正问题

`docs/planning/extension-vscode-compat.md` §6.1 否决了 Theia，理由是 EPL-2.0、多包依赖、体量。

**A 的判断**：

> 要装真实扩展，问题会从「补哪些 API」变成「自建宿主 vs 接 Theia」——**§6.1 否决 Theia 的账在「装真实扩展」这个目标下需要重算。**

**因为**：Theia 的 `plugin-ext` 已经做完了「读真实 VSIX + 通用模块加载 + VS Code API 面」这三件事，正是当前缺的三层。**否决它的理由（依赖体量）在「自己实现这三层」的成本面前要重新比较。**

### 决策还缺一个输入

**用户会不会真的写/装扩展？**

- 如果目标用户是「技术型个人用户与小团队」（`CLAUDE.md` 的产品定位），**他们更可能装现成扩展，而不是写新扩展** —— 那 C 才有价值；
- 如果他们要的是「让 AI 调用更多能力」，`ModuleHost` 原生机制 + `app_api_*` 已经够了 —— 那 A 或 B 就够。

**这个输入我没有。需要用户回答。**

## 我（总控）的建议

**选 B，但先问一个问题。**

**理由**：

1. **选 C 的前提没成立**——连安装 IPC 都没有，「装真实扩展」不是当前路径上的事；
2. **选 A 浪费已有的东西**——权限层做得对（唯一守住的那层），`documentViewHost` 也复用了。**完全不做是丢掉了已验证的部分**；
3. **B 的代价最小，而且它解决真正的问题**：现在最危险的不是「装不了」，是**没人知道它装不了**——文档说「VS Code API 薄映射」，听起来像能装。

**B 的具体做法**（如果选它）：

- 在 `CLAUDE.md` 的产品主线表里，把「VS Code API 薄映射」改成准确的描述；
- 在 `docs/planning/extension-vscode-compat.md` §3 顶部加一行指向 §6.2 的链接（**A 已给出这行修复**）；
- 在 `document_tools_list` 或扩展安装入口（如果有）里明确说明限制。

## 需要用户回答的问题

**你的用户会不会真的写或装第三方 VS Code 扩展？**

- **会装现成的** → 那 C 有价值，但要接受「自建宿主 vs 接 Theia」的重算；
- **会写自己的** → `ModuleHost` 原生机制可能更合适，不需要 VS Code 兼容；
- **都不太会** → A 或 B，把力气投到别处（Node-RED / Genoffice / UI 工作台）。

## 验收判据

**这不是执行卡，验收标准是「用户给出决定」**：

1. 用户选择 A / B / C；
2. 如果选 B 或 C，再开施工卡；
3. 如果选 A，在 `CLAUDE.md` 里把扩展线的描述改准确。

## 边界

- **本卡只记录决策所需的证据与选项**；
- **不做任何代码改动**；
- **不改 `CLAUDE.md` 或文档**（那是决定之后的事）。

## 回写

`tasks/T85-extension-productization-decision.md` 末尾追加 `## 结果回写`：
用户的选择、理由、后续动作（开哪张卡 / 改哪份文档）。
