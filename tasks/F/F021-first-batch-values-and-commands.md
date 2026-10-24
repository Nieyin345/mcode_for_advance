# F021｜第一批实现：把 `vscode.*` 从「清单」变成「能跑的东西」

- Status: ready-for-agent
- Category: **P0 扩展主线（B 方案第一批实现）**
- Depends on: F018（骨架 + 闸门，`ae3cb73a`/`6152b274`/`d62de4a0`）、F019（需求普查，`512964ce`）
- Exclusive writable files:
  - `packages/vscode-compat/src/**`（**只增不改闸门的判定逻辑**）
  - `apps/desktop/scripts/vscode-compat-first-batch-smoke/`（新建）
  - 本卡回写
- **不碰**：`apps/desktop/src/**`（本卡不接产品）、`packages/contracts/**`、
  `apps/desktop/scripts/vscode-compat-gate-smoke/**`（F018 的套件，别改）、
  `docs/planning/vscode-api-census.md` 与普查脚本（那是数据，只读）

---

## 这批做什么，为什么是这些

F019 数出本机 29 个扩展用了 **429 个不同成员**。全部实现是年级的事。
但如果只要**划词翻译能跑**，需要的是 **13 个成员，最深的排第 72**。

**而排在最前面的 16 个成员里，有一大半不是「功能」，是「数据结构」：**

```
#1  Uri.file           27 个扩展        ← 值类型
#4  EventEmitter       24 个扩展        ← 值类型
#5  Uri.parse          24 个扩展        ← 值类型
#14 ProgressLocation   21 个扩展        ← 枚举
#18 ConfigurationTarget 19 个扩展       ← 枚举
#19 ThemeIcon          19 个扩展        ← 值类型
#24 FileType.Directory 18 个扩展        ← 枚举
#25 Range              18 个扩展        ← 值类型
```

**这些没有一个是「子系统」，全是「对象和常量」。** 而它们分布在 18–27 个扩展里 ——
**没有它们，那些扩展连模块加载都过不去**（`const uri = vscode.Uri.file(p)` 在顶层就会崩）。

**这就是第一批。** 不是按「重要性」挑的，是按「缺了它连测试夹具都写不出来」挑的。

---

## 第一批的确切范围（照着做，不要扩）

### 1. 值类型 / 枚举（**纯数据，无副作用，最容易做对**）

| 成员 | 依赖 |
|---|---|
| **`Uri` —— ⚠️ 用 `vscode-uri`，不要手写（见下方硬约束一）** | `vscode-uri@3.0.8` |
| `Position`、`Range`、`Selection`、`Location` | 无 |
| `EventEmitter`（`event`/`fire`/`dispose`） | `Disposable` |
| `Disposable`（`from`/`dispose`） | 无 |
| `ThemeIcon`、`ThemeColor` | 无 |
| `MarkdownString`（`appendText`/`appendCodeblock`/`value`/`isTrusted`） | 无 |
| `CancellationTokenSource`、`CancellationToken` | 无 |
| 枚举：`ProgressLocation`、`ConfigurationTarget`、`FileType`、`ViewColumn`、`StatusBarAlignment`、`EndOfLine`、`ExtensionMode`、`LogLevel`、`UIKind` | 无 |

**这些的行为是「可测的」** —— `Uri.file("a/b").fsPath` 在 Windows 上是什么、
`new Range(1,2,3,4)` 的 `contains` 逻辑，都有明确答案。

### 2. 三个不依赖编辑器的命名空间

| 命名空间 | 做什么 | 为什么现在做 |
|---|---|---|
| `l10n` | `t` / `bundle` / `uri` | **3 个成员，几乎直接映射**到现有 `lib/i18n` |
| `env` 的只读部分 | `appName`/`appRoot`/`language`/`machineId`/`sessionId`/`clipboard`/`openExternal` | **纯读 + 两个转发**，无 UI |
| `commands` | `registerCommand`/`executeCommand`/`getCommands`/`registerTextEditorCommand` | **4 个成员**，直接接 `ModuleHost` 的 handlers |

**`commands` 是全表最小的命名空间（4 个成员）** —— F018 已验证闸门对它是 1/4 缺口。
**本卡把它补到 4/4。**

> **`commands.executeCommand` 是全表第 2 名（26 个扩展）。** 它需要「命令注册表」这个概念
> —— 一个 `Map<string, handler>`，加上「未知命令要明确报错，不是静默 no-op」。

---

## ⚠️ 三条硬约束（都是从 F019 的数据推出来的，不是我的偏好）

### 一、`Uri` **不要手写 —— 用 `vscode-uri`，它是微软官方的实现**

**这是我写卡时差点犯的错。** 我本来打算让执行者手写 `Uri`，还写了一条
「`Uri.file("C:\\x\\y").toString()` → `file:///c%3A/x/y`」当作规格。
**我实测了 `vscode-uri@3.0.8`（微软官方包，MIT），发现我漏了三件会写错的事：**

```js
URI.file("C:\\x\\y")              fsPath → "c:\\x\\y"     ← 盘符被小写化！
                                  toString() → "file:///c%3A/x/y"
URI.file("\\\\server\\share\\f.txt") toString() → "file://server/share/f.txt"  ← 只有两斜杠
URI.file("/usr/home")             fsPath → "\\usr\\home"   ← Windows 上也转反斜杠
```

**`fsPath` 会小写盘符、UNC 路径的 `toString` 只有两个斜杠、Windows 上 POSIX 路径会被转** ——
**这三条我一条都不知道，而它们每一条都会让 27 个扩展里的某一个拿到错路径。**

**所以：**

1. 把 `vscode-uri`（`3.0.8`，MIT，**零依赖**，微软维护）加进 `packages/vscode-compat` 的
   `dependencies`；
2. `Uri` 直接 `export { URI as Uri } from "vscode-uri"` —— **一行，不手写**；
3. **仍然要测那三条**（盘符小写、UNC 双斜杠、Windows 上的 POSIX 路径），
   但测的是「我们接对了没有」，不是「我实现对了没有」。

**为什么必须用官方实现**：这个包同时被 Theia 和 VS Code 自己的扩展宿主用，
**它就是「VS Code 认为 `Uri` 该是什么样」的事实标准**。
自己写一份，等于拿 27 个扩展去赌我们的猜测。

**装完记得**：`git status --porcelain pnpm-lock.yaml` 先看有没有别人在改依赖；
**`pnpm install` 会顺带升级无关包**（F018 实测：`@iconify/react`、`on-finished` 被一起改了）——
装完核对 `git diff pnpm-lock.yaml`，**只有 `vscode-uri` 的条目才是你的**，别的要还原。

### 二、`EventEmitter` 的 `dispose` 必须真的断订阅

**24 个扩展用它。** 一个「收集 listener 但 dispose 后照旧 fire」的 `EventEmitter`，
会让扩展在卸载后仍然收到事件 —— 那是**内存泄漏 + 卸载后崩溃**，而且症状出现在很久以后。

**要求**：`dispose()` 之后再 `fire()`，**没有任何 listener 被调用**。这条要断言。

### 三、**不许**实现超出上表的东西

**这批里没有 `window.showInformationMessage`、没有 `workspace.getConfiguration`。**
它们排第 6、第 3，看起来更「该先做」—— **但它们是 UI 和配置系统，要接产品侧。**

**本卡不接产品**（`apps/desktop/src/**` 不许碰）。所以做它们只能做成空壳，
而空壳正是 F018 说的那句话：**「写成能编译通过的样子，就等于声称实现了 —— 那是撒谎」**。

**如果某条路必须接产品才能继续，停下来，在回写区写清「卡在哪」，不要造空壳。**

---

## 任务

### 一、把 `_gate.ts` 里已完成的命名空间补真

现在 `_gate.ts` 的 16 行**全部故意红**（那是 F018 的设计）。
本卡做完后，**`commands` / `l10n` 两行应该变成绿的** —— 因为它们真实现了。

**做法**：把 `_gate.ts` 拆成两层：

```
_gate.ts               ← 保留：全部 16 行仍然红（缺口清单）
_gate_implemented.ts   ← 新建：只含已实现的命名空间，必须绿
```

**`_gate_implemented.ts` 也要 `exclude` 出包 tsconfig**（它由套件单独编译）。
**这样「已实现」和「未实现」是两个可分别验证的事实**，不会因为补了一批就把整包改成编译不过。

### 二、值类型放哪

`packages/vscode-compat/src/values/` 下按类分文件：
`uri.ts` / `position.ts` / `range.ts` / `selection.ts` / `eventEmitter.ts` /
`disposable.ts` / `themeIcon.ts` / `markdownString.ts` / `cancellationToken.ts` /
`enums.ts`。

**每个文件都要导出「VS Code 类型要求的那个形状」** —— 用 `satisfies` 或类型标注钉住，
**不要靠 `as`**（理由见 F018 卡：`as` 判的是相似度，不是完整性）。

### 三、套件里必须有的断言

`vscode-compat-first-batch-smoke`：

1. **`Uri` 的三条实测行为**（盘符小写、UNC 双斜杠、Windows 上的 POSIX 路径）——
   **这些是 `vscode-uri` 的既有行为，断言的作用是「证明我们接对了、没有二次转换」**。
   至少 5 个真实路径：含中文、含空格、盘符、UNC、POSIX；
2. **`EventEmitter.dispose` 之后 listener 不再被调用** —— 正控 + 负控都要有
   （dispose 前确实被调用 = 正控；dispose 后不再被调用 = 负控）；
3. **`commands.executeCommand("不存在的命令")` 要抛错**，不是静默返回 `undefined`
   —— 这条是「坏东西显式报出来」那条硬规矩；
4. **`_gate_implemented.ts` 编译通过**（exit 0），**`_gate.ts` 仍然全部红**；
5. **`commands` 的 4 个成员逐个点名**：`registerCommand` / `executeCommand` /
   `getCommands` / `registerTextEditorCommand` —— 任一缺失，`_gate_implemented.ts` 必须红。

**每条先写预期红几条，再跑。** 记进回写区。

> **第 1 条的判据要写对。** 它**不是**在验 `vscode-uri` 对不对（那是微软的事），
> 是在验**我们有没有在中间加一层会改变结果的转换**。
> 所以断言要直接打「`Uri.file(p).fsPath` 的实际值」，**不要**写成
> 「`fsPath` 里含反斜杠」这种宽松形式 —— 那样盘符小写化就测不出来。

### 四、变异（必须做）

| 变异 | 预期 |
|---|---|
| `Uri` 导出时套一层 `{ ...URI, file: (p) => URI.file(p.replace(/\\\\/g, "/")) }` | 第 1 条红（证明断言真在打 fsPath 的实际值） |
| `EventEmitter.dispose` 改成空函数 | 「dispose 后不再被调用」红 |
| `executeCommand` 未知命令返回 `undefined` 而不抛 | 第 3 条红 |
| `_gate_implemented.ts` 删 `commands` 一行 | 第 4/5 条红 |

**⚠️ 变异之前先问「还有没有别的条件在兜底」**（仓库记过 9 种失效形态）。
比如 `fsPath` 那条：如果断言只查 `includes("\\")`，那「全部正斜杠」的变异可能被别的断言先抓到，
**红的就不是你要证明的那条**。

---

## 验收判据

1. **值类型全部有实现**，且 `_gate_implemented.ts` 对它们编译通过；
2. **`Uri` 往返一致**在 Windows 路径、中文路径、空格、UNC 上都有断言；
3. **`EventEmitter.dispose` 断言有正控和负控**；
4. **`commands.executeCommand` 未知命令抛错**；
5. **`_gate.ts` 仍然全部红**（本卡没把缺口清单改成假绿）；
6. **四条变异各自红了预期的那些条**，实际红数记进回写区；
7. **不碰 `apps/desktop/src/**`**、不改 `_gate.ts` 的 16 行缺口；
8. 不跑全量、不起 Electron。

---

## 回写

1. 实现了多少个成员（**数出来的**）；
2. **`Uri` 三条实测值**（盘符小写 / UNC 双斜杠 / Windows 上的 POSIX）——
   附你跑出来的实际字符串，不是「符合预期」；
3. `EventEmitter` 的负控怎么写的（**怎么证明「dispose 后真的没被调用」而不是「本来就没注册」**）；
4. 四条变异的实际红数与预期红数，对不上要解释；
5. **`_gate_implemented.ts` 从几个命名空间开始，到几个结束**；
6. **`pnpm-lock.yaml` 的 diff 里，除了 `vscode-uri` 还有没有别的包被顺带升级**
   （F018 踩过，见上文硬约束一）；
7. 有没有你做到一半发现「必须接产品才能继续」的（那是最有价值的信息）；
8. 提交 SHA。
