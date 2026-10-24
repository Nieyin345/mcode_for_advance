# F005｜闭环验收：真实扩展从装进去到跑出结果，端到端一条链

- Status: ready-for-agent
- Category: **P0 扩展主线**（闭环验收，不是新功能）
- Depends on: F001–F004
- Exclusive writable files:
  - 新建 `apps/desktop/scripts/vsix-end-to-end-smoke/`（**只有这一个目录**）
  - `tasks/F/F005-end-to-end-closure.md` 回写

## Required Skills
- `mcode-smoke`

---

## ⚠️ 这是并行卡，只允许碰一个新建目录

**另一张卡（F004）正在改 `apps/desktop/src/main/modules/vscodeL1Bridge.ts`。**

**你一个字都不许动那个文件。** 发现它有问题（缺导出、签名不对、行为不符）：
**在回写区写下来，等你这一轮跑完再一起说，不要顺手改。**

**你的可写范围只有**：
- `apps/desktop/scripts/vsix-end-to-end-smoke/**`（新建）
- `tasks/F/F005-end-to-end-closure.md`（回写）

---

## 要证明的事

**闭环五环，用真实扩展走一遍，每环都要有断言**：

| # | 环 | 断言什么 |
|---|---|---|
| 1 | **装** | `VscodeL1Bridge.install` 接受真实 `rainbow-csv` 的 DEFLATE VSIX，返回一个 bridge 实例 |
| 2 | **出现在列表** | `host.catalog().modules` 里有 `user.mechatroner.rainbow-csv` |
| 3 | **命令能调用** | `bridge.executeCommand(commandId, resource, requestId)` 走通，返回 `reply.type === "result"` |
| 4 | **结果正确** | 返回的 `value` 里有扩展真实产出的字段（不是空壳） |
| 5 | **能卸载** | `host.remove(moduleId)` 之后 catalog 里没有它，且 `bridge.executeCommand` 拒绝执行（`isCurrent()` 返回 false） |

**第 5 环特别重要**：`isCurrent()` 那道防线（「removed or replaced」）如果没有断言，**卸载后旧 bridge 还能调用**这种 bug 会静默存在。

---

## 关键约束

### 一、不要用真 dataRoot

**`ModuleHost` 会写盘。** 按仓库既有做法：用 `.tmp/` 下的临时目录，或者看 `vscode-l1-smoke` 怎么隔离的（**它有 27 条断言且已经在跑，照它的隔离方式做**）。

**照抄它的隔离方式，不要发明新的。**

### 二、真实扩展的源码是 136 KB，超 24 KiB

**这是现实**：`rainbow-csv` 的 `extension.js` 是 136 516 B，`SOURCE_LIMIT` 是 24 KiB。
**所以第 1 环现在会失败** —— 那正是本卡要证明的事实。

**处理方式**：
- **先断言它被拒，且错误信息说清是源码超限**（这就是「现状的真实边界」）；
- **再构造一个「同结构但源码 < 24 KiB」的扩展**，用它走完五环。

**两个都要有**：
- 真实扩展 + 真实拒绝 = 现状证据；
- 缩小版 + 五环全通 = 闭环能力证据。

**⚠️ 缩小版必须是「同结构」的**：同样的 `publisher.name` 前缀、同样的 `activationEvents`、同样走 DEFLATE。**不是随手造个最小包** ——
一个和真实扩展结构不同的包走通了，只证明「我们的格式能跑」，不证明「真实扩展的格式能跑」。

### 三、第 4 环「结果正确」别糊弄

**空字符串 / `undefined` / 只检查「有 value 字段」都不算。**

要断言**扩展代码真实产出的内容**。比如让扩展读它被授权的那个文件、把行数写进 `message`——
**断言那个数字对**（用你造的文件，你知道它有几行）。

---

## 验收判据

1. 五环各有断言，**全绿**；
2. **真实 `rainbow-csv` 被拒，错误信息点名「源码超限」**（不是笼统失败）；
3. 缩小版五环全通，**第 4 环断言的是真实算出来的值**；
4. **卸载后旧 bridge 拒绝执行**（第 5 环的负控）；
5. 不跑全量、不起 Electron、不碰真 dataRoot；
6. **没改 `vscodeL1Bridge.ts` 一个字节**（提交前 `git diff --stat` 自查）。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| 把第 4 环的期望值改成错的 | 1 条红（证明断言真的在验值） |
| 卸载后不检查 `isCurrent()`（直接返回成功） | 1 条红（第 5 环负控） |
| 断言 `catalog` 里"至少有东西"而不是具体 moduleId | 1 条红（证明它验的是那个扩展） |
| **改 `vscodeL1Bridge.ts`** | **不许做** —— 那是并行卡的文件 |

---

## 回写

1. **五环各自的结果**（贴关键输出）；
2. 真实扩展被拒的**错误原文**；
3. 缩小版扩展的**结构**（publisher/name/命令数/源码大小），证明它和真实的同构；
4. 第 4 环断言的**具体值**是什么，怎么来的；
5. 变异四条结果；
6. **你有没有发现 `vscodeL1Bridge.ts` 有问题**（发现了就写，别改）；
7. 提交 SHA。

---

## 回写（2026-10-24）

### 一、五环结果

套件 `apps/desktop/scripts/vsix-end-to-end-smoke/`，**10/10 通过**。

| 环 | 断言 | 结果 |
|---|---|---|
| **0-A** | 真实 rainbow-csv 被拒，错误**点名源码限额** | ✅ `/main entry exceeds 24576 B/` |
| **0-B** | 真实清单被**贡献点检查**拒（第二道墙） | ✅ 9 个贡献点 |
| **0-C** | 真实扩展第一条命令**没有 publisher.name 前缀**（第三道墙） | ✅ `rainbow-csv.CSVLint` |
| **1 装** | 同构缩小版（DEFLATE）装进去，返回 bridge 实例 | ✅ |
| **2 列出** | catalog 里有 `user.mechatroner.rainbow-csv-fixture` + 对应 capability | ✅ |
| **3 调用** | `executeCommand` 返回 `type === "result"` | ✅ |
| **4 结果正确** | 扩展读文件数行 = **5**；换 3 行文件后 = **3** | ✅ |
| **5 卸载** | catalog 里消失，且旧 bridge 抛 `/removed or replaced/` | ✅ |
| **5-B** | 旧 bridge 也不许报成功（对照：移除前它能跑） | ✅ |
| **正控** | STORE 打包的同构包同样走完五环 | ✅ |

### 二、真实扩展被拒的错误原文

**第一道墙（源码限额）**：

```
VSIX DEFLATE main entry exceeds 24576 B (header declares 136516)
```

**第二道墙**：真实 `package.json` 的 9 个贡献点 —— `colors` / `configuration` /
`submenus` / `menus` / `languages` / `commands` / `semanticTokenScopes` /
`configurationDefaults` / `grammars`。宿主只支持 `commands`。

**第三道墙（本卡新发现，**卡里没预料到**）**：

```js
第一条命令 = "rainbow-csv.CSVLint"
前缀要求   = "mechatroner.rainbow-csv."
满足前缀?  = false
```

**真实扩展的命令名不带 publisher 前缀**，而宿主强制要求 `publisher.name.` 开头。

### 三、缩小版的结构（证明与真实同构）

| 项 | 真实 rainbow-csv | 缩小版 |
|---|---|---|
| publisher.name | `mechatroner.rainbow-csv` | `mechatroner.rainbow-csv-fixture` |
| `main` | `./extension`（无 .js） | `./extension.js`（schema 要求的字面量） |
| 命令数 | 24 | 1 |
| 贡献点 | 9 | 1（`commands`） |
| activationEvents | 多条含 `onLanguage:*` | `["onLanguage:csv", "onCommand:<第一条>"]` |
| 打包方式 | DEFLATE | **DEFLATE** |
| 源码大小 | 136 516 B | < 24 KiB |

**同构的部分**：前缀形态、`activationEvents` 混合形式（含非 onCommand 的事件）、
两文件布局、DEFLATE 压缩。
**不同的部分**：源码大小、命令数、贡献点数 —— 这三样正是当前能力边界所在，
不是「结构不同」。

### 四、第 4 环的具体值

- 写了 `data.csv`，内容 `a,b\nc,d\ne,f\ng,h\ni,j` → **5 行**
- 断言 `reply.value.message === "lines=5"`
- **反向对照**：再写 `three.csv`（`x\ny\nz`，3 行）→ 断言 `=== "lines=3"`

**为什么这不是抄实现**：行数来自我写进临时目录的内容，扩展要真读文件才能算对。
如果扩展返回常量，第二条（3 行）会红。

**顺带发现的第六道墙**：`require("node:fs")` 被拒 ——

```
Unsupported VS Code extension import: node:fs
```

子进程只放行 `require("vscode")`。**所以缩小版必须用 `vscode.workspace.fs`**
（需要传 L2 ports 的 `{ fileWrite: false }`）。这也说明：**真实扩展用 `node:fs`
的一律跑不起来**，这是运行时层的限制，不是包格式。

### 五、变异结果（预期 vs 实际）

| 变异 | 预期 | 实际 | 说明 |
|---|---|---|---|
| **M1** 第 4 环期望改成 `lines=99` | 1 红 | **1 红** ✅ | 只打中第 4 环 |
| **M2-精确** 第 2 环期望 id 改成不存在的 | 1 红 | **1 红** ✅ | 只打中第 2 环 |
| **M2-宽** 断言改成 `ids.length > 0` + 让 id 不符 | 0 红（证明变弱） | **3 红** ⚠️ | 见下 |
| **M3** 删掉「卸载后拒绝」那条断言 | 0 红 | **0 红** | 见下（重要） |
| **M3b** 把 `host.remove(...)` 注释掉 | 1 红 | **2 红** ✅ | 5 和 5-B 都红 |

**M2-宽 的 3 红不是好事**：改 publisher 常量会同时打中第 2 环、第 5 环、
以及 capability 断言 —— 说明**「改 publisher」不是隔离变异**，无法证明单条断言。
所以补了 **M2-精确**（只改期望字符串），它干净地只红 1 条。

**M3 的 0 红是本卡最有价值的教训**：

> **删掉一条断言，套件不会红 —— 它只是少了一条。**

所以「断言能红」不能用「删掉它」来证明，必须用「**破坏它验的东西**」（M3b 的做法）。
这和本仓库那条「删得干净才红 / 注释掉仍绿」是同一族，但更极端：
**删除断言连红的资格都没有**。

### 六、`vscodeL1Bridge.ts` 的问题（**发现了，没改**）

1. **三道墙是串联的**，真实扩展被哪一道拒取决于你先修哪一道 —— 排查时容易只看到第一道。
   建议：`install` 一次性收集**所有**不满足的条件再抛，而不是遇到第一个就停。
   （这会改变错误形态，需要单独一张卡。）
2. **命令前缀规则**（`publisher.name.`）与真实扩展生态不兼容 —— rainbow-csv 的
   `rainbow-csv.CSVLint` 就不满足。这条规则是 L1 原型期定的，**依据不明**（和 4096 同批）。
3. **`require` 白名单只有 `"vscode"`**，真实扩展用 `node:fs`/`node:path` 的全会失败。
   这是运行时层的最大墙，不是格式问题。

**我一个字都没改（`git diff` 自查过）。**

### 七、提交

（见下方提交记录）
