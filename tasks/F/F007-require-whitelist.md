# F007｜运行时第一道门：`require` 白名单从 `"vscode"` 到能跑真实扩展

- Status: **superseded**（被 F013 取代（同一件事的旧稿，从未提交））
- Category: **P0 扩展主线**（运行时层，最大的墙）
- Depends on: F005（`9d49aa39`，实测出三道串联的墙）
- Exclusive writable files:
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`（`childProgram` 那一段）
  - `apps/desktop/scripts/vsix-require-policy-smoke/`（新建）
  - 本卡回写

## Required Skills
- `mcode-smoke`

---

## ⚠️ 并行边界

- `apps/desktop/src/main/ipc/*`、`packages/contracts/**`、`renderer/components/modules/**` —— **F006 正在改**，你不碰；
- `apps/desktop/scripts/vsix-end-to-end-smoke/` —— F005 已交付，不碰；
- **你只改 `vscodeL1Bridge.ts` 的 `childProgram` 段**（约 `:395-455`）。

---

## F005 实测出的现状

```
require("node:fs")  →  Unsupported VS Code extension import: node:fs
```

**子进程只放行 `require("vscode")`。** 真实扩展凡用 node 内置模块的全跑不起来——
`rainbow-csv` 就用 `fs`、`path`。

**这不是格式问题，是运行时问题。** 而且它是**最后一道墙**：前两道（源码限额、贡献点）放宽了，
这道过不去照样装不上。

---

## 任务

### 一、先判断：白名单该放什么，不该放什么

**别一次性放开 `node:*`。** 这个宿主的安全模型是「扩展在受控子进程里跑，
只能读写用户本次选中的那一个文件」（见 `ide.modules.boundary` 的用户文案）。

**做一张表**，每个模块给出「放 / 不放 / 有条件放」和理由：

| 模块 | 判断 | 理由 |
|---|---|---|
| `path` | ? | 纯字符串运算，无 I/O |
| `fs` | ? | **真实扩展最常用，但它是逃逸围栏的直接途径** |
| `os` | ? | 泄露环境信息 |
| `util` | ? | 纯函数居多 |
| `crypto` | ? | 看是随机数还是文件哈希 |
| `child_process` | **不放** | 执行任意进程 |
| `net` / `http` / `https` | ? | 越权网络（`permissionedProcessRunner` 已经把 egress 当独立权限） |

**`fs` 是这张卡的核心矛盾**：
- 不放 → `rainbow-csv` 这类扩展永远跑不起来；
- 放了 → 扩展能读**任意**路径，直接绕过「只能读写选中那一个文件」的围栏。

**所以 `fs` 必须是有条件放**：注入一个**受限的 `fs` 替身**，所有路径先过既有的授权检查
（`ModuleResource` 的 `resource.path` + `assertAllowed` 那套，**看 `childL2Snippet` 里
`l2Path` 怎么做的，照它的模式**）。

**`childL2Snippet` 已经有 `l2Fs` 的先例** —— 那是 L2 路径上「受限 fs 替身」的现成实现。
**先读它，再决定是复用还是抽公共。**

### 二、`require` 白名单要显式表，不要前缀匹配

**`id.startsWith("node:")` 这种写法是错的** —— 它会放行 `node:child_process`。
必须是一张**枚举表**。

### 三、错误信息必须说清「哪个模块被拒、为什么」

现在：`Unsupported VS Code extension import: node:fs` —— **只说被拒，不说为什么**。

改成能区分：
- 完全不支持的模块（`child_process`）→ 「本宿主不支持执行任意进程」；
- 支持但越权的用法（`fs` 读未授权路径）→ 「fs 只能访问本次授权的资源」。

**F003 已经证明过：说不清被哪道拒的，变异就无法断言。**

---

## 验收判据

1. **`path` 等纯计算模块能 `require` 到**；
2. **`child_process` 仍被拒，且错误说明理由**；
3. **受限 `fs` 能读授权文件、读未授权路径被拒**（两条断言，一正一负）；
4. **白名单是枚举表**（变异：把表改成 `startsWith("node:")`，`child_process` 那条必须红）；
5. **真实扩展的 `require` 语句能被解析**（不需要它跑通整个扩展，但 `require("fs")`、`require("path")` 不能是被拒的原因）；
6. 不跑全量、不起 Electron。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| 白名单改成 `id.startsWith("node:")` | 1 条红（`child_process` 负控） |
| 受限 `fs` 去掉路径检查 | 1 条红（越权读负控） |
| 把 `path` 也拒掉 | 1 条红（纯计算模块正控） |
| **删掉一条断言** | **不许用这个方式验变异**（见下） |

**最后一行是本卡要你记住的**：F005 实测发现 **删掉一条断言，套件不会红——它只是少了一条**。
所以「这条断言能红」不能用「删掉它」证明，**必须破坏它验的东西**。

---

## 回写

1. **那张「放 / 不放 / 有条件放」的表**，每个模块的理由；
2. `fs` 你是怎么受限的（贴关键代码），**复用 `childL2Snippet` 的 `l2Fs` 还是新写，为什么**；
3. 真实扩展的 `require` 语句现在还能不能是被拒的原因；
4. 变异四条结果（预期 vs 实际）；
5. **还剩哪些墙**（F005 说的两道：贡献点、命令前缀，加上你没解决的）；
6. 提交 SHA。
