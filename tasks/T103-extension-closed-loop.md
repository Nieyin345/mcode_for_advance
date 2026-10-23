# T103｜扩展线闭环：从「装一个扩展」到「它能被调用」

- Status: ready-for-agent
- Category: **P0 产品主线（扩展生态闭环）**
- Priority: **P0 —— 路线图 §2 的长期项目，用户明确要求闭环**
- Depends on: T80（`ecb5035a`，四层实测）、T85（我判过「不做」，**现在推翻**）
- Exclusive writable files: 见「边界」

## Required Skills
- `codebase-design`：判断哪一层该补。
- `mcode-smoke`：端到端回归。

## 背景：我之前的判断是错的

**T85 我写了**：

> **决定：不做**（选项 A + B 的混合）
> **理由 ①**：选项 C 的真实成本被低估了一个数量级……**既然 §6.1 因为依赖体量否决了 Theia，那么自建同样这三层的成本必须拿来和 Theia 比。**
> **理由 ②**：用户当前的痛点和扩展生态无关。

**用户现在明确说：扩展也是闭环之一。**

**而我的理由 ② 是错的** —— 「当前痛点」不代表「不需要闭环」。

## A 的 T80 实测（`ecb5035a`）：四层里三层拒绝

| 层 | 现状 | 真实扩展需要 |
|---|---|---|
| **包结构** | 恰好 2 个 ZIP entry / 只认 STORE / ≤128 KiB | **DEFLATE + `[Content_Types].xml` + 几 MB** |
| **清单** | `main` 必须字面量 `./extension.js`；命令 id 必须带 publisher 前缀；`.strict()` 拒 `description`；`z.tuple` 只收 1 条命令 | 真实扩展有 24 条命令 |
| **API 面** | `require` 白名单只有 `"vscode"`；实现 0 个完整语义 | 真实扩展用 **53 个** `vscode.*` 成员 |
| **权限** | ✅ **唯一守住的** | — |

**而 `install()` 全仓只有一个调用方（`vscode-l1-smoke`），`RpcMap` 里没有安装扩展的 IPC。**

## 闭环是什么

**用户能：装一个扩展 → 它出现在列表里 → 它的命令能被调用 → 结果正确 → 能禁用/卸载。**

**现在第一环就不通。**

## 任务：先定「闭环」的边界

**不是「支持所有 VS Code 扩展」（那是 Theia 的量级），是「支持一类真实扩展」。**

### 第一步：定支持范围

**从市场里选 3 个「小、常见、单命令」的扩展**（本机 `~/.vscode/extensions/` 里有什么就用什么），逐个看它们需要什么。

**产出**：一张表（扩展 / 包结构 / 清单复杂度 / 用到的 API）。

**然后定**：**支持哪一类？** 三选一：

| 方案 | 范围 | 成本 |
|---|---|---|
| **A. 只读、单命令、小体积** | 最窄 | 小 |
| **B. 任意单语言扩展**（语法高亮 / 命令） | 中 | 中 |
| **C. 通用宿主** | 全 | **Theia 量级** |

**我倾向 B**，但要你论证。

### 第二步：把三层的缺口补到「能装一个」

**按你定的范围，补对应的层**：

1. **包结构**：读 DEFLATE + 允许 `[Content_Types].xml`；
2. **清单**：放宽 `main` 路径、允许多命令、允许 `description`；
3. **API 面**：按选定的扩展补对应的 `vscode.*` 成员。

**⚠️ 每补一条都要有「真实扩展能过」的证据**，不是「放宽了就完事」。

### 第三步：闭环的最后三环

**装完之后**：

1. **扩展出现在列表里**（`extension.list` 之类）；
2. **它的命令能被调用**（这是 `ModuleHost.invoke` 那条路）；
3. **能禁用 / 卸载**（`ModuleHost.remove` 已有）。

**先查这三环现在有没有：**

```bash
grep -rn "extension.list\|extension.install\|extension.remove" packages/contracts/src/ipc/ | head
```

## 验收判据

1. **支持范围定了**（三选一 + 论证 + 三个真实扩展的分析表）。
2. **至少一个真实扩展能装进去**（真跑，不是读代码）。
3. **它能出现在列表里**。
4. **它的命令能被调用**（`ModuleHost.invoke` 那条路）。
5. **能卸载**。
6. **每一环有正控 + 负控**。
7. 不跑全量、不起 Electron。

## 边界

- **只读 + `.tmp/` 探针**先定范围（第一步）；
- 第二步开始可以改：
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`
  - `packages/contracts/src/ipc/modules.ts`（契约）
  - `apps/desktop/src/main/ipc/modules.ts`（handler）
- **不改 `genoffice/`、不改 `node-red/`**；
- 不改 `deckPatternCheck.ts`（F 在做）。

## 遇到问题先检索

`docs/planning/extension-vscode-compat.md` §3 是分级表，§6.2 是已实现的限制。
**先读这两节，再定范围。**

## 回写

`tasks/T103-extension-closed-loop.md` 末尾追加 `## 结果回写（2026-10-24）`：
支持范围论证、三个真实扩展分析、补了哪几层、闭环五环的结果、正负控、提交 SHA。
