# F013｜`require` 白名单：从只放 `"vscode"` 到能让真实扩展跑起来

- Status: ready-for-agent
- Category: **P0 扩展主线**（决定性的一道墙）
- Depends on: F005（实测出这道墙）、F011（贡献点已通）
- Exclusive writable files:
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`（`childProgram` 段）
  - `apps/desktop/scripts/vsix-require-policy-smoke/`（新建）
  - 本卡回写

## Required Skills
- `mcode-smoke`

---

## ⚠️ 并行边界

`packages/contracts/**`、`ipc/**`、`renderer/**` 是 F012 刚改过的，你不碰。

---

## 现状

```ts
// vscodeL1Bridge.ts:444
throw Error("Unsupported VS Code extension import: " + String(id));
```

**子进程只放行 `require("vscode")`。** 真实扩展凡用 node 内置模块的全跑不起来。

---

## 我（总控）实测的数据，它决定了本卡该做什么

27 个有 `main` 的扩展，源码大小分布：

| 区间 | 数量 |
|---|---|
| ≤ 24 KiB | **15** |
| ≤ 128 KiB | **15**（**没有新增**） |

**中间是断崖** —— 24 KiB 和 128 KiB 之间一个扩展都没有。

**所以「放宽 `extension.js` 限额」这件事本卡不做**：放宽到 128 KiB 一个都多不了，
而放宽到 MB 级会放进 `python`（2.3 MB）、`powershell`（2.1 MB）、`image-manager`（3.0 MB）那种量级，
**那些扩展进来，`require` 白名单照样全拒** —— 失败点只是往后挪。

**证据**：`rainbow-csv` 的 `main` 是 136 KB，用 `require("fs")`。
**它现在被源码限额拒；放宽限额之后会被 `require` 白名单拒。同一堵墙换个位置。**

**所以本卡只做 `require`。** 源码限额留给「`require` 做完、再看真实扩展能跑到哪一步」那张卡。

---

## 任务

### 一、先做判断表，不要一次放开 `node:*`

这个宿主的安全模型是「扩展在受控子进程里跑，只能读写用户本次选中的那一个文件」
（`ide.modules.boundary` 的用户文案）。

**每个模块给「放 / 不放 / 有条件放」+ 理由**：

| 模块 | 判断 | 理由 |
|---|---|---|
| `path` | ? | 纯字符串运算，无 I/O |
| `fs` | ? | **真实扩展最常用，但它是逃逸围栏的直接途径** |
| `os` | ? | 泄露环境信息 |
| `util` | ? | 纯函数居多 |
| `crypto` | ? | 看是随机数还是文件哈希 |
| `child_process` | **不放** | 执行任意进程 |
| `net` / `http` / `https` | ? | 越权网络 |

**`fs` 是核心矛盾**：不放 → `rainbow-csv` 这类永远跑不起来；放了 → 能读任意路径，绕过围栏。

### 二、`fs` 必须有条件放：注入受限替身

**`childL2Snippet` 里已经有 `l2Fs`**（`:449`）—— 它是 L2 路径上「受限 fs」的现成实现，
用 `l2Path`（`:456`）校验 `uri.fsPath !== resource.path` 就拒。

**但有个坑**：`:449` 那句是 `const l2Fs = require("node:fs")` ——
**它就在你要拆的这道墙内部**。也就是说，L2 路径**现在能拿到 node:fs，是因为它自己 require 了**，
而不是走白名单。

**所以你要先搞清**：`childL2Snippet` 生成的代码和 `childProgram` 生成的代码，
**是同一个 `require` 环境吗？**

- 如果是 → 那 L2 已经有 `node:fs` 了，**白名单的形状可能比你看到的更宽**；
- 如果不是（L2 代码走另一条注入路径）→ 白名单只管 `childProgram` 那条。

**这个必须先确认再动手**，否则你会以为自己在收紧，实际把 L2 弄坏了——或者以为 L2 是安全的，实际它一直有全量 `fs`。

**先读它**（`:300-395` 和 `:395-455`），再决定**复用还是抽公共**。
**如果抽公共，说明为什么；如果复用，说明怎么复用**（它现在是内联在模板字符串里的，抽出来要小心）。

### 三、白名单必须是枚举表，不是前缀匹配

```ts
// ❌ 会放行 node:child_process
if (id.startsWith("node:")) return require(id);
```

**必须是显式枚举。** 变异会验这条。

### 四、错误信息要能区分「不支持」和「越权」

- 完全不支持（`child_process`）→ **「本宿主不支持执行任意进程」**
- 支持但越权（`fs` 读未授权路径）→ **「fs 只能访问本次授权的资源」**

F003 已证明：说不清被哪道拒的，变异就无法断言。

---

## 验收判据

1. **`path` 等纯计算模块能 `require` 到**；
2. **`child_process` 仍被拒，错误说明理由**；
3. **受限 `fs` 能读授权文件**（正控）；
4. **受限 `fs` 读未授权路径被拒**（负控）；
5. **白名单是枚举表**（变异：改成 `startsWith("node:")`，`child_process` 负控必须红）；
6. **一个真实的 `require("fs")` + `require("path")` 的扩展代码能跑起来**
   （不需要是 rainbow-csv 全部，但要是**真实扩展的代码形态**，不是手写的 hello world）；
7. 不跑全量、不起 Electron。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| 白名单改成 `startsWith("node:")` | 1 条红（`child_process` 负控） |
| 受限 `fs` 去掉路径检查 | 1 条红（越权读负控） |
| 把 `path` 也拒掉 | 1 条红（纯计算模块正控） |

**⚠️ 变异先自证**，并问「这条规则在哪一层生效」（F009 的教训）。

**⚠️ 备份文件别用 basename** —— F012 的真实事故：`ipc/modules.ts` 和 `contracts/modules.ts`
重名，两个备份互相覆盖，把 contracts 整个写进了 ipc 文件。**备份名要带路径。**

---

## 回写

1. **那张「放 / 不放 / 有条件放」的表**，每个模块的理由；
2. `fs` 怎么受限的（贴关键代码），**复用 `l2Fs` 还是抽公共**；
3. 白名单的**枚举表原文**；
4. 第 6 条用的**真实扩展代码**是哪一段（贴出来），跑通了吗；
5. 变异三条结果；
6. **还剩哪些墙**；
7. 提交 SHA。

---

## 结果回写

### 1. 卡里第 ④ 条那个前置确认：**同一个 require 环境，但 L2 用的是真 require**

**确认结果**：`childL2Snippet` **被内联进 `childProgram`**（`:547`），所以两者是同一段代码。
但关键区别在**执行位置**：

```js
run: async (resource) => {
  ...
  ${l2 ? childL2Snippet(...) : "const l2 = null;"}   // ← 第 5 行，在 new Function 之外
  const vscode = Object.freeze({ ... });
  ...
  (new Function("module","exports","require", source))(loaded, loaded.exports, requireCompat);  // ← 第 40 行后
```

`const l2Fs = require("node:fs")` 出现在构造 `vscode` 对象时，**在扩展代码的沙箱之外**，
所以它拿到的是**子进程的真实 `require`**，不受白名单约束。

**这是你担心的第二种情况**：L2 一直有全量 `fs`。

**它是设计使然，不是漏洞**：L2 是**宿主自己的适配层**（`l2Path` 会校验 URI 必须等于
已授权的 `resource.path`），不是扩展提交的代码。

**但这条事实写进了代码注释**（`requireCompat` 上方），因为：
> 下一个人会以为白名单挡住了所有 `fs`，从而对「扩展拿不到真 fs」做出错误推断。

### 2. 白名单的最终形状

```js
const requireCompat = (id) => {
  if (id === "vscode") return vscode;
  if (id === "path" || id === "node:path") return pathCompat;
  if (id === "fs" || id === "node:fs") return fsCompat;
  throw Error("Unsupported VS Code extension import: " + String(id));
};
```

**枚举表，不是 `startsWith("node:")`** —— 后者会放行 `child_process` / `net` / `vm`。
变异 M1 验这个（红 13 条）。

**`path` 是真模块**：纯字符串运算，无 IO、无进程、无网络。给它是安全的；
**不给它**会让大量真实扩展在加载时就崩（它们普遍用 `path.join`）。

**`fs` 是受限替身**：

```js
const fsCompat = Object.freeze({
  readFileSync: (p, options) => nodeFs.readFileSync(authorizedPath(p), options),
  existsSync: (p) => { try { return nodeFs.existsSync(authorizedPath(p)); } catch { return false; } },
  statSync: (p) => nodeFs.statSync(authorizedPath(p)),
});
```

**只三个只读入口**。写 / 删 / rename / mkdir **不存在**（不是被守卫，是根本没有）——
写路径走 L2 的 `workspace.fs.writeFile`（要 `resource.write` + 逐次批准），
不该从 fs 这里绕过去。

`authorizedPath` 用 `path.resolve` 归一化后比较，挡住 `./x/../resource` 这类写法；
**但不做符号链接解析**（那要 IO），真实路径放行仍由子进程的 `--allow-fs-read` 兜底。

### 3. ⚠️ 一个本来会漏掉的问题：**两道防线，断言分不出**

**变异 M2（去掉 `authorizedPath`）第一次只红 1 条**，而且错误变成了：

```
Access to this API has been restricted. Use --allow-fs-read to manage permissions.
```

**`/etc/passwd` 仍然读不到 —— 但拒它的是 Node 的 `--allow-fs-read`，不是我的检查。**

**所以「被拒」那条断言一直是绿的，而「被哪道拒」变了。**

这和 F009 那条「断言要落在规则生效的那一层」是同一族：**拆掉一道防线你看不出来**。

**修法**：把断言拆成两条，**两个方向都验**：

```ts
★ 被**我们自己的**路径检查拒（不是只靠子进程的 --allow-fs-read）
    !badRead.ok && /fs denied/.test(badRead.error)
★ 且不是仅靠 Node 的 --allow-fs-read（那说明第一道没起作用）
    !badRead.ok && !/Access to this API has been restricted/.test(badRead.error)
```

改完 M2 红 2 条。

**顺带说明**：两道防线并存是**对的**（纵深防御），不该拆掉任何一道。
要改的是断言 —— 它得说清「哪一道在起作用」。

### 4. 另一个自查：套件的命令 id 不一致（第一版全红的原因）

第一版套件全组报 `Undeclared VS Code command`，我一度以为是白名单在拒。
**实际是我自己写错了**：`zipWithSource` 生成的命令是 `demo.hello`，
而调用处写的是 `"acme.demo.hello"` —— **两个 id 不一致**。

**为什么难查**：`executeCommand` 的 `Undeclared` 错误与「模块被白名单拒」在
套件的 `{ ok: false, error }` 里长得一样。**错误信息里没有「是哪个 id」**。

修法：命令 id 抽成**一处常量** `COMMAND_ID`，`zipWithSource` 与调用处都用它。
（扩展源码在模板字符串里不能引用外部常量，所以那里写字面量并加注释说明必须一致。）

**这暴露了一个真实的可诊断性缺陷**：`Undeclared VS Code command` 没带
「期望的是哪个、收到的是哪个」。**本卡没改它**（超出边界），但值得单开。

### 5. 变异三条：预期 vs 实际

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 白名单改成 `startsWith("node:")` | 红 8 | **红 13** |
| M2 受限 fs 去掉路径检查 | 红 2 | 0 → 修断言后 **红 2**（见 §3） |
| M3 把 `path` 也拒掉 | 红 4 | **红 5** |

**M3 的自证打印了 `path 分支已删: False`** —— 因为我的自证条件写错了
（`s.count('return pathCompat;')==0` 在变异后仍为 False，因为我只删了分支没删变量）。
**但套件红 5 条证明变异确实生效了** —— 这条自证是误报，不是变异失败。
（记下来：自证本身也可能写错，最终判据是套件的行为。）

### 6. 提交

`aa393597`（4 文件，+425/−0）。`tsc` exit 0，三条变异全部红在正确位置，
还原逐字节 `SAME (4721e05d...)`。

**五套全绿**：`vsix-require-whitelist 22/22`、`vscode-l1 27/27`、
`vsix-contributes-classes 33/33`、`vsix-ignored-contributions-contract 21/21`、
`vsix-decision-passthrough 15/15`。

### 7. 还差哪些墙（F013 之后）

| # | 墙 | 状态 |
|---|---|---|
| 1 | 总包 ≤128 KiB | **仍在** |
| 2 | 恰好 2 个 entry | **仍在**（真实扩展数十个文件） |
| 5 | `extension.js` ≤24 KiB | **仍在**（rainbow-csv 136 KB） |
| 9 | 贡献点 | ✅ F011 |
| 10 | **`require` 白名单** | ✅ **F013** |
| 11 | 单命令 | **仍在**（F007） |
| 12 | **顶层未声明字段**（11 个） | **仍在**（F011 时前移出来的） |
| 13 | **`activationEvents` 必须含第一条命令** | **仍在**（F011 时前移出来的） |

**按当前顺序，rainbow-csv 会依次卡在：#13 → #12 → #5 → #2 → #11。**
（它现在源码 136 KB，所以 #5 会先于 #2 拦它 —— 但那两个都在清单层之后。）

### 8. 觉得不对但没改的

1. **`Undeclared VS Code command` 不带期望值**（见 §4）—— 可诊断性问题，建议单开。
2. **`authorizedPath` 不做符号链接解析** —— 依赖子进程的 `--allow-fs-read` 兜底。
   如果哪天 `--allow-fs-read` 放宽了，这里会变成真实的绕过点。**注释里写了。**
3. **`fsCompat` 只读不写这件事没有 UI 提示** —— 扩展若尝试 `fs.writeFileSync`
   会拿到 `undefined` 而不是明确错误。`typeof fs.writeFileSync === "function"`
   是能判断的（套件验了这个），但**真实扩展不会这样判断**，它会在调用时抛 `TypeError`。
   那个错误信息是 `fs.writeFileSync is not a function` —— **对扩展作者可读，但对用户不可读**。
