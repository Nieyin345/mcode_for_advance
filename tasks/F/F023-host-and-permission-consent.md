# F023｜让扩展真跑起来：宿主接进 Mcode + 装时说清它有多大权限

- Status: ready-for-agent
- Category: **P0 扩展主线（Theia 二开第二步，用户已裁决权限模型）**
- Depends on:
  - F022（Theia 源码已进仓、锁 `v1.76.0`、能构建、`theia-vendor-smoke` 34/34）
  - **用户裁决 2026-10-24**：「装时说清楚，之后不打断」
- Exclusive writable files:
  - `apps/desktop/src/main/modules/theiaHost/**`（新建，宿主装配与桥）
  - `apps/desktop/src/main/modules/theiaPermissionReport.ts`（新建，能力推断）
  - `apps/desktop/scripts/theia-host-boot-smoke/`（新建）
  - `packages/contracts/src/`（**只加这一个域的 schema**，见任务四）
  - 本卡回写
- **不碰**：`vendor/theia/**`（本卡不改上游源码）、`apps/desktop/scripts/theia-vendor-smoke/**`、
  `apps/desktop/src/main/modules/vscodeL1Bridge.ts`（旧通道保持原样，两条路并存到 F025）、
  `packages/vscode-compat/**`（自建路线已中止，留着不动）

---

## ⚠️ 读卡先确认三件事

```bash
git -C vendor/theia rev-parse HEAD     # 应是 d8106d7ffa62b3413ff1ca5b63a0e6c2fe0b0649
ls vendor/theia/packages/plugin-ext/lib/hosted/node/plugin-host.js   # 构建产物在不在
bash apps/desktop/scripts/theia-vendor-smoke/run.sh                  # 应 34/34
```

**任何一条不成立，先做 F022 的复现步骤，不要在坏地基上盖楼。**

---

## 这张卡要达成什么

**一句话**：让 Theia 的扩展宿主在 Mcode 里真的起来，能加载一个真实扩展、调它的命令；
**并且在装的那一刻，告诉用户这个扩展能碰什么。**

**这一张卡不追求「市场扩展全部能跑」。** 它追求的是：
**一个真实扩展端到端跑通，而且权限提示是真实的、不是装饰。**

---

## 任务一：把宿主进程拉起来

Theia 的宿主是一个被 fork 的子进程，**要求 `stdio[4]` 是一条专用管道**（F017 实测，
`@theia/core/lib/node/messaging/ipc-channel.js:54` 用 `net.Socket({fd:4})`）。

**要做**：

- 一个进程管理器：按那个形状 fork `hosted/node/plugin-host.js`；
- 父子之间的 MessagePack 握手跑通；
- **失败时明确报错**，不要静默重试。

**⚠️ 平台差异**：`stdio[4]` 这种做法在 Windows 上的行为，**F017 没有验证过**。
如果 Windows 上不成立，**这是必须立刻报出来的**（本机是 Windows，主战场也是）。

**产出**：一个能起来的宿主，以及「起来之后它是活的」的证据
（进程存活 + 握手完成 + 一次 ping/pong）。

---

## 任务二：接 `commands`，跑一个真实扩展

**选一个真实扩展。**

> ## ⚠️ 我写卡时的推荐是错的，实测推翻了
>
> 我本来写「推荐 `siesta.vscode-pdf-translate`（7 KB、只 require `vscode` + `path`）」。
> **实测它的 `out/` 下 5 个文件，require 的是：**
>
> ```
> require("child_process")  require("fs")  require("os")
> require("path")           require("util")  require("vscode")
> require("./config")  require("./environmentManager")
> require("./translator")  require("./pdfViewer")
> ```
>
> **`child_process` + 4 个相对路径模块 —— 正是 F013 当初明确拒绝放行的那一类。**
> 我抄的是 F017 卡里那句话，**而那句话说的是包大小，不是依赖。**
>
> **这反而是一个好的测试对象**：它同时测出「多文件加载」和「完整 Node 权限」两件事。
> **但前提是宿主已经能放开这些** —— 那是用户裁决定的，不是卡定的。

**建议这样选（我实测过，可以直接用）：**

**首选：`james-yu.latex-workshop-10.20.0`**

```
入口（package.json 的 main）: ./out/src/main.js   ← 不是 out/src/extension.js，别照名字猜
文件大小: 24 KB
require 的外部模块（实测）: require("path")  require("vscode")   ← 干净
```

**这正是「只 require `vscode` + `path`」的那种，适合先验证宿主端到端。**

**备选：`siesta.vscode-pdf-translate`，但它有 `child_process`。**
**那反而是一个好的第二个测试对象** —— 它同时测「多文件加载」和「完整 Node 权限」。
**但它要求宿主已经放开 `child_process`，那取决于用户裁决，不是卡能定的。**

**如果两个都不合用的某一步，就自己写一个 20 行的最小扩展**
（只 `require("vscode")`，注册一条命令，激活返回一个可辨识的值），
**放在 `.tmp/` 或套件的 fixtures 里，不进产品路径。**

**判据仍然按下面的五步走，扩展是哪个不重要 —— 重要的是「真的端到端」。**

**这个任务的判据是端到端，不是「宿主起来了」：**

1. 宿主能**读到**这个扩展的 `package.json`；
2. 它的 `activate()` 能跑完（不崩）；
3. 它注册的命令**出现在宿主的命令表里**；
4. **从 Mcode 侧调那个命令，扩展侧真的收到并执行**；
5. 返回值能回到 Mcode 侧。

**第 4 条是核心。** 「命令出现在列表里」不等于「能调」—— 这是 F015 已经踩过的
（注册 24/24、调用 1/24）。

---

## 任务三：接编辑器 —— 只接 `window.activeTextEditor` 一条

**划词翻译这类扩展的核心依赖是这个。** 而 F019 普查说它排第 43，
`Selection` 和 `TextEditor.edit` 紧随其后。

**本卡只做「读」这一半：**

- `window.activeTextEditor` 返回一个**真的指向 Monaco 当前编辑器**的对象；
- `document.getText()` / `selection` / `selections` 拿到**真实内容**；
- `window.visibleTextEditors` 至少包含当前那一个。

**不做** `TextEditor.edit()`（写回）。**那是 F024 的事**，因为它涉及事务式编辑和撤销栈，
是另一块。

**⚠️ 有一个已知的坑，而且仓库里已经写清楚了 —— 我核过了，行号是 `FileEditor.tsx:838`，不是 810。**

`apps/desktop/src/renderer/components/ide/FileEditor.tsx:838-852` 原文：

> **它们读的是 `window.getSelection()`。Monaco 是自绘的**：它的文字画在 canvas
> 上，DOM 里那层只是辅助，`window.getSelection()` 在里面拿不到选区（或拿到的是
> 错位的）。要从 Monaco 拿选区只能走它自己的 API：
> **`editor.getSelection()` + `model.getValueInRange(...)`**。
>
> **Monaco 的选区是常驻的** —— 点一下别处才取消。……用 `onDidChangeCursorSelection`
> （Monaco 自己会在拖选结束时发）……

**所以 `activeTextEditor.selection` 必须从 `editor.getSelection()` 转过来，
不能用 `window.getSelection()`。** 这条已经有前人在同一个文件里踩过并写下来了。

**如果发现映射不成立，如实报，不要造一个「看起来有选区」的空对象。**

---

## 任务四：装时说清权限（**用户裁决的核心，也是本卡最容易做成装饰的地方**）

### ⚠️ 先说一个已核实的事实：VS Code 的清单里没有权限声明

我查了 `vendor/theia/packages/plugin-ext/src/common/plugin-protocol.ts`：

```
grep -c "capabilities" plugin-protocol.ts  →  0
grep "permissions"                          →  无
```

**所以「列出这个扩展申请什么能力」这件事，没有现成的字段可读 —— 得我们从扩展的实际行为推出来。**

### 两种推断，**必须分开做，不能混**：

| 来源 | 能推出什么 | 可靠性 |
|---|---|---|
| **静态看代码**（`grep` / AST 它的 `extension.js`） | 它 `require` 了 `child_process` / `fs` / `net`；它有没有 `workspace.fs` 调用 | **下界**：混淆或动态 require 会漏 |
| **看清单** | `contributes.configuration` / `activationEvents` / 它声明要读写什么 | 声明，不一定等于实际 |

**判据要写成「下限」，不能写成「它只会这些」：**

```
这个扩展至少需要：读取文件、启动子进程
（这是静态扫描的结果；混淆过的代码可能有更多，我们看不见）
```

**「只列了 3 项」和「只有 3 项」是两件事** —— 这个仓库已经踩过很多次这个形态
（CLAUDE.md 第三十八、三十九条）。

### 要做的事

1. **`theiaPermissionReport.ts`**：输入一个扩展目录，输出一个 `PermissionReport`：
   ```ts
   {
     readsFiles: boolean;      // 静态看到 fs / workspace.fs
     spawnsProcesses: boolean; // 静态看到 child_process / node-pty
     network: boolean;         // 静态看到 net / http / fetch
     evidence: string[];       // 每条判断对应的源码位置，给用户和审计看
     confidence: "static-lower-bound";  // 明确这是下界
   }
   ```
2. **装的时候给用户看**，然后**用户点同意才装**；
3. **装完不再问。**

**`evidence` 那一列是重点。** 一条只说「能读文件」而没有出处的提示，
用户无法判断，也无法审计。**每条都要有 `文件:行号`。**

---

## 任务五：套件

`theia-host-boot-smoke`：

1. **宿主能起来**：进程存活、握手完成（**失败要有明确错误，不能只等超时**）；
2. **真实扩展端到端**：`activate()` 不崩 → 命令注册 → 从 Mcode 侧调用 → 收到返回值
   （任务二的五步，逐步断言）；
3. **`activeTextEditor` 指向真实编辑器**：
   - 正控：能读到一个**预先写死内容的文件**的文本；
   - **负控**：**没有打开任何编辑器时，返回 `undefined`**（不是抛错、不是空对象）；
4. **权限报告**：
   - 正控：一个 `require("child_process")` 的扩展 → `spawnsProcesses: true`；
   - **负控**：一个只 `require("vscode")` 的扩展 → `spawnsProcesses: false`
     （**没有这条，报告恒 true 也能全绿**）；
   - `evidence` 里真的有 `文件:行号`。

**每条先写预期红几条，再跑。**

---

## 变异（必须做，而且要写清是哪一种）

| 变异 | 预期 |
|---|---|
| 权限报告恒 `true`（不管什么扩展都说它能起进程） | 第 4 组负控红 |
| 权限报告恒 `false` | 第 4 组正控红 |
| `activeTextEditor` 在没有编辑器时返回 `{}` 而不是 `undefined` | 第 3 组负控红 |
| 命令注册后立刻从表里删掉（假装注册成功） | 第 2 组第 4 步红 |
| 宿主的错误被 `try/catch` 吞掉 | 第 1 组「失败要有明确错误」红 |

**⚠️ 前两条必须成对做。** 只做「恒 true」会让报告变成一个永远报警的东西；
只做「恒 false」会让它变成一个从不报警的东西。**两个都要红，才证明它在区分。**

---

## 判据边界（**本卡明确不解决什么**，要写进套件的输出）

**本卡不解决**：
- `TextEditor.edit()` 写回、撤销栈（F024）
- 大多数 `workspace` / `window` API（按需增量，F025+）
- 扩展之间的依赖、扩展市场的下载与校验
- **真正的沙箱** —— 用户选了「装时说清楚、之后不打断」，**所以不做运行时隔离**

**这几条要用固定前缀打进每次运行输出**（仓库规矩：边界要被读日志的人看见，不能只写在卡上）：

```
NOT-COVERED: TextEditor.edit / 撤销栈（F024）
NOT-COVERED: workspace 与 window 的大部分 API（F025+）
NOT-COVERED: 运行时沙箱 —— 用户选择了安装时告知，不是隔离
```

**⚠️ 最后一条尤其重要。** 一个看日志的人会以为「装时说清楚」=「有保护」。
**它不是保护，是知情同意。** 这句话必须出现在每次运行里。

---

## 验收判据

1. 宿主能在**本机（Windows）**起来，或者**明确报告起不来 + 为什么**；
2. 一个真实扩展的 `activate()` 跑通、命令能从 Mcode 侧调用并拿到返回值；
3. `window.activeTextEditor` 指向真实内容，且**没有编辑器时返回 `undefined`**；
4. 权限报告有 `evidence`，正控 + 负控都测过；
5. **五条变异各自红了预期的那些条**，实际红数记进回写区；
6. 套件输出里有 `NOT-COVERED:` 那三行；
7. 不碰 `vendor/theia/**`、不碰 `vscodeL1Bridge.ts`；
8. 不跑全量、不起 Electron（除非宿主必须起 Electron —— 那要单独说明）。

---

## 回写

1. **宿主在本机起没起来**，`stdio[4]` 在 Windows 上成不成立（**这是本卡最大的未知**）；
2. 选了哪个真实扩展，端到端五步各自的**实际结果**；
3. `activeTextEditor` 怎么映射到 Monaco 的，`FileEditor.tsx:810` 那段注释说了什么；
4. 权限报告能推出几项、**漏了几项**（拿一个你手工看过的扩展对照）；
5. 五条变异的实际红数与预期红数；
6. **有没有「必须接产品才能继续」的发现**；
7. 提交 SHA。

---

## 允许「做不到」

**如果任务一（宿主起来）在 Windows 上就过不去，立刻停下，写清卡在哪。**

那是一个**必须让用户知道的**结论 —— 因为整个 Theia 路线的前提就是「宿主能起」。
F017 的 PoC 是在 Windows 上验证过的（`probe-fork-host-v2.js`，6 秒无 stderr、进程存活），
**但那是裸 fork 一个 host，不是完整握手。** 差别可能很大。
