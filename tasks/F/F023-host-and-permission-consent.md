# F023｜让扩展真跑起来：宿主接进 Mcode + 装时说清它有多大权限

- Status: done
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

---

## 总控复核（2026-10-25，回写之后补）

**我自己跑了两遍，不是只看报告：**

```bash
bash apps/desktop/scripts/theia-host-boot-smoke/run.sh
# → 35/35，但 `skip 真实扩展（THEIA_SMOKE_REAL_EXT 未设置）`

THEIA_SMOKE_REAL_EXT="$USERPROFILE/.vscode/extensions/james-yu.latex-workshop-10.20.0" \
  bash apps/desktop/scripts/theia-host-boot-smoke/run.sh
# → 34/34；`info 真实扩展 james-yu.latex-workshop：注册 71 条命令，激活错误 0 条`
```

**「71 条命令」这一行我亲自跑出来了。**

### 一个我认可的设计判断

**真实扩展那段标 `info`（不算失败）是对的** —— 我一度担心「宿主坏了套件还是绿」，
核了之后不成立：**合成夹具（含 `child_process` 的 `spawn-ext`）走的是硬断言路径**，
宿主坏掉会在那里红。真实扩展是**额外的**验证，不是唯一的。

### 一个我没改的洞，下一张卡要修

**缺构建产物时，套件 `return` 了，exit code 是 0，输出是 `0/0 通过`。**

```ts
if (!existsSync(hostJs) || !existsSync(vscodeInit)) {
  skip("宿主构建产物存在", ...);
  console.log(`theia-host-boot-smoke: 0/0 通过（跳过：vendor/theia 未构建）`);
  return;                                    // ← exit 0
}
```

**这是仓库记过的那个形态**：「取不到通过数要当硬错误」。
它现在**明确说了跳过**（比静默好），但**退出码仍然是 0** ——
一个只看 CI 绿灯的人，会以为「这套验过了」。

**换机器 / CI 上尤其危险**，因为 `vendor/theia` 是 gitignore 的嵌套 checkout，
新环境里默认没有构建产物。**它应该是 exit 2 或专门的跳过码，由 run-smokes 识别。**

**还有一条执行会话报告的、需要跟进的事实**：
`F022` 的构建步骤只写了 `tsc --build packages/plugin-ext`，
**但宿主还要求 `packages/plugin-ext-vscode/lib/node/plugin-vscode-init.js`**。
新环境必须两个都建，否则上面那个跳过分支会被走到。

**这两条记在 `tasks/F/F024-*` 一起修，不单独开卡**（同一个套件的同一个前置）。
## 结果回写（2026-10-25）

### 结论先说

**宿主在 Windows 上起来了，而且是完整握手 —— 不是「活了 6 秒」。**
F017 留下的最大未知（`stdio[4]` 在 Windows 成不成立、MessagePack 握手能不能走完）
**答案是「成立、能走完」**，并且一个真实扩展（`james-yu.latex-workshop`）被加载、
激活、注册 **71 条命令**、命令从中枢侧调用并拿到返回值。

`theia-host-boot-smoke` **35/35**，`theia-vendor-smoke` 仍 **34/34**，
双包 typecheck 干净，六条变异各自红了预期的条数（见 §5）。

---

### 1. 宿主在本机起没起来 / `stdio[4]` 在 Windows 成不成立（本卡最大的未知）

**起来了。** 分三步实测：

| 步骤 | 做法 | 结果 |
|---|---|---|
| 1. 纯管道探针 | `fork(..., stdio: ['pipe','pipe','pipe','ipc','overlapped'])` + 子进程 `net.Socket({fd:4})`，手写 `<MessageStart>`+uint32 帧双向收发 | **双向 round-trip 通过**（`pong:hello-from-parent`） |
| 2. 真宿主 `$init` | 用 Theia 自己的 `IPCChannel` + `RPCProtocolImpl` fork `plugin-host.js` | **`$init` 返回**（宿主报告 OS=Windows） |
| 3. 真宿主 `$start` + 激活 | 加载 latex-workshop，`$activateByEvent('onCommand:…')` | **71 条命令注册成功** |

**所以 `net.Socket({fd: 4})` 在 Windows 11 / Node 22 上成立**，
前提是父进程 fork 时第 5 条 stdio 写 **`'overlapped'`** —— 这正是
`vendor/theia/.../hosted-plugin-process.js:130` 注释里说的那句
「5th element MUST be `'overlapped'` for it to work properly on Windows」。
**本卡不改上游源码，只是照着它的形状起进程。**

**一个必须记下来的坑**：父进程也必须注册与宿主相同的 msgpack 扩展
（`registerMsgPackExtensions()`，由 `@theia/plugin-ext/lib/common/index.js` 在加载时执行）。
**只 require `rpc-protocol.js` 不会触发它**，症状是「第一次收到含 vscode URI 的载荷就抛
`Unknown extension 4`」—— 一个完全指错方向的错误。实现里两处都写了注释。

---

### 2. 真实扩展端到端：五步的实际结果

选的是卡推荐的 **`james-yu.latex-workshop-10.20.0`**（入口 `./out/src/main.js`，
**不是** `out/src/extension.js` —— 卡里那句提醒是对的）。

**套件里的五步断言跑的是合成夹具**（`fixtures/spawn-ext`，不依赖本机装了什么扩展），
下面括号里是**真实 latex-workshop** 的实测值：

| 步骤 | 判据 | 结果 |
|---|---|---|
| 1. 宿主读到清单 | `id === publisher.name` | ✅（`james-yu.latex-workshop`） |
| 2. `activate()` 跑完 | 没有 error 级日志 | ✅（真实扩展 0 error；3 条 **warn** 是它自己重复注册 BibTeX 诊断集合，不是宿主问题） |
| 3. 命令进命令表 | 表里查得到具体命令 | ✅（真实扩展 **71 条**） |
| 4. 从 Mcode 侧调 → 扩展执行 | 扩展里 `execSync` 的 stdout 回到父进程 | ✅（夹具返回 `echo: "pong"`） |
| 5. 返回值回到 Mcode 侧 | 对象字段完整 | ✅（`appName: "Mcode"`、清单默认值 `hello-from-manifest-default`） |

**第 4 步是核心，也是踩坑最深的一处。** 实现过程中有三条「看起来像激活失败」的假象，
每一条都记进了源码注释：

1. **`CommandRegistryExt` 没有 `$getCommands`。** 第一版向宿主「要命令表」，
   宿主侧 `handler[method]` 拿到 `undefined` 抛 `TypeError`，这个抛错**沿着
   `activate()` 的调用栈冒出来**。命令表只能从**单向通知**里读。
2. **声明过的命令不发 `$registerCommand`。** 宿主侧 `commandIsDeclaredInPackage`
   分支让清单里声明过的命令直接走 `$registerHandler`。实测 latex-workshop 的 46 条
   声明命令**一条 `$registerCommand` 都没有** —— 只数后者会得出「注册了 25 条」而
   `wordcount` 永远查不到。**两条通知都要收。**
3. **扩展调 `executeCommand('setContext', …)` 时不能抛。** latex-workshop 的
   `activate()` 第一句就是它；`setContext` 是工作台内置命令，我们没实现。
   第一版把它原样转给宿主 → reject → 顺着 activate 冒出来。现在**未实现的命令
   返回 `undefined` 并记一条 debug**（VS Code 对未知命令也是宽容的）。

**顺带发现的一条宿主职责**：配置**默认值**必须从清单送进宿主。
latex-workshop 在**模块加载期**就调
`workspace.getConfiguration('latex-workshop').get('intellisense.package.exclude').includes(...)`，
而清单里声明了 `default: []`。没有人送默认值 → `get` 返回 `undefined` → `TypeError`。
Theia 自己靠 `PreferenceProvider` + schema 注入；Mcode 没有那套服务，
所以在 `collectConfigurationDefaults()` 里显式合成（`PreferenceScope.Default`）。

**`activate()` 什么时候跑**：`$start` 只登记，不激活。真正的激活要发
`onCommand:<第一个声明命令>`（VS Code 的惰性激活语义）。**不发就是 0 条命令** ——
第一版就撞过这个，症状和「扩展坏了」一模一样。

---

### 3. `activeTextEditor` 怎么映射到 Monaco / `FileEditor.tsx` 那段注释说了什么

**映射方式**：把编辑器状态以 **`EDITORS_AND_DOCUMENTS_EXT.$acceptEditorsAndDocumentsDelta`**
推给宿主 —— 这是 Theia 的真实协议，不是自造的。宿主侧
`EditorsAndDocumentsExtImpl` 收到 delta 才会让 `window.activeTextEditor` 有值。

- 文档：`{ uri, versionId, lines, languageId, modeId, EOL, isDirty, encoding }`
- 编辑器：`{ id, documentUri, selections, options, visibleRanges, editorPosition }`
- **`newActiveEditor: null` 才表示「没有编辑器」**；`undefined` 是「没变化」。
  写成 `undefined` 会得到一个关不掉的幽灵编辑器 —— 这是第 3 组负控要抓的变异（M3）。

**`FileEditor.tsx` 那段注释（卡里说行号是 838，不是 810）说的是**：
扩展读选区只能走 Monaco 自己的 `editor.getSelection()` + `model.getValueInRange(...)`，
**不能用 `window.getSelection()`** —— Monaco 是 canvas 自绘的，DOM 选区那层拿不到
（或错位）。**本卡的映射遵守了这条**：选区来自 Mcode 侧真实编辑器的状态
（`setActive({ selection })`），**不读 `window.getSelection()`**；
推进宿主时按 Theia 的 1-based 字段编码，宿主侧 `toSelection` 减 1 回到 vscode 的 0-based。

**套件实测**：无编辑器 → `null`（不是 `{}`、不是抛错）；有编辑器 → 文本逐字节一致、
选区 0-based 对齐；**并且从扩展侧 `vscode.window.activeTextEditor` 读到了同一份内容**
（证明不是我们自己的缓存，而是宿主里那份文档）。

---

### 4. 权限报告能推出几项、漏了几项

**latex-workshop 实测：4 项全部判 true（readsFiles / writesFiles / spawnsProcesses / network）。**
拿人工清点对照过了 —— 遍历它的 require 闭包（**116 个文件，全部扫到，未触发 256 上限**），
外部模块是：`cross-spawn, fs, glob, http, iconv-lite, latex-utensils, micromatch, os,
path, perf_hooks, tmp, vscode, vsls/vscode, workerpool, ws, zlib`。
**报告没有误报，也没有漏掉这四类中的任何一类。**

**但它会漏，而且我量了漏多少**：一个把 `require("child_process")` 写成
`require(["child","process"].join("_"))` 的扩展，报告返回**四项全 false、evidence 为空**。
这正是 `confidence` 恒为 `static-lower-bound`、`limits` 必须随报告一起显示的理由。
**「只列了 3 项」和「只有 3 项」是两件事** —— 卡里这句被实测坐实了。

实现上的两条取舍（都写进了 `limits`，不是只写在代码里）：

- **`require("fs")` 只记「读」**，写必须由写调用点证明 —— 否则每个 fs 用户都被标成「能改你的文件」，标记恒亮、用户学会忽略。
- **`glob` / `tmp` 这类泛用包刻意不计文件访问** —— 同上，代价是漏报，写进 `limits`。
- **`cross-spawn` / `node-pty` / `axios` 这类包名白名单计入** —— 不认这一层，就会对 latex-workshop 说「不起子进程」，那不是保守，是错的。

**剥注释**：`// require("child_process")` 不算命中（套件里有专门负控）。

**安装同意**：`installConsent.ts` 是纯函数（不 import electron），
`buildInstallConsentPrompt` → 用户看 → `decideInstall` → `install` / `decline`；
**没有报告时是 `needs-report`（fail-closed，不装）**，不是「没报告就当没问题」。
提示里必须同时出现「这是下限」和「这不是沙箱」两句。

---

### 5. 六条变异的实际红数 vs 预期

**每条先写预期，再跑；每条都先确认「find 恰好出现 1 次」「写后字节确实变了」
「还原后 `cmp` 逐字节一致」，跑完再确认基线回到 0 红。**

| # | 变异 | 预期红 | 实际红 | 红在哪 |
|---|---|---|---|---|
| M1 | 权限报告恒 `true` | 3 | **3** ✅ | 两条负控（clean-ext、注释掉的 require）+ 「干净扩展的提示不含起进程能力」 |
| M2 | 权限报告恒 `false` | 4 | **4** ✅ | 正控 + 「提示列出了起进程能力」+「headline 明说下限」+「提示带 evidence」 |
| M3 | `activeTextEditor` 无编辑器时返回 `{}` | 2 | **2** ✅ | 「没有编辑器时返回 null」+「关闭后回到 null」 |
| M4 | 命令登记后立刻从表里删掉 | 2 | **2** ✅ | 「步骤 3 命令进了表」+「步骤 4b 能调用的命令也在表里」 |
| M5 | 宿主错误被 `try/catch` 吞掉 | 1 | **1** ✅ | 「扩展目录不存在时抛出带 code 的错误」 |
| M6 | 没有报告也照装 | 1 | **1** ✅ | 「没有报告 → needs-report」 |

**前两条（M1/M2）是成对做的**，两个都红才证明报告在**区分**，而不是一个恒定的报警器。

**两处预期被我改过，而且改得对**（先说清原因，不是事后凑数）：

- **M1/M2 第一次只写 1 条** —— 实际多红的几条是**用户看到的那层**（安装提示）
  也跟着变。那不是判据太松，是**同一属性被两条独立断言守着**。改成 3 / 4。
- **M4 第一次写 2 条，其中一条是「命令表非空」** —— 实际只红 1 条。
  查下来是**我的预期错了，而且暴露了判据弱**：`length > 0` 在「只注册了一条
  无关命令」时也成立。已把判据钉到**具体命令**上，并加了 `步骤 4b`。
  **M4 的第 4 步本身不红是对的** —— 只删父进程镜像时，宿主侧 handler 还在，
  调用真的能跑。**「能调用 ≠ 在表里」**，只有两条一起断言才抓得住。

**变异 M4 顺带证明了一件事**：如果只写「调用成功」这一条，一个**假装注册成功**
的宿主会全绿。这和 F015 的「注册 24/24、调用 1/24」是同一族，方向相反。

---

### 6. 有没有「必须接产品才能继续」的发现

**有两条，都不是阻塞，但都应该在 F024/F025 立项时先看一眼：**

1. **宿主能起，但「谁来调用它」还没接产品。** 本卡的 `TheiaHost` 是一个**可独立
   驱动**的类（套件直接 `new` 它），**没有接进 IPC / 渲染端 / 安装流程**。
   要让用户真的用上，还需要：一条 IPC（起宿主 / 装扩展）、一个安装入口把
   `buildExtensionPermissionReport` + `installConsent` 接进现有的
   `ModuleHost.install` 那条流程、以及宿主生命周期的归属（跟窗口还是跟应用）。
   **这不是本卡的范围**（卡的 Exclusive writable files 里没有 `ipc/`），
   但它决定了「用户什么时候能看见」。
2. **`vendor/theia` 的 `plugin-ext-vscode` 构建产物是本机 `tsc --build` 出来的。**
   `lib` 在 vendor 的 `.gitignore` 里，所以 **vendor git 树干净**（`git status` 空），
   但**换一台机器 / CI 必须先把 `packages/plugin-ext-vscode` 建出来**，
   否则套件走 skip 分支（打印原因、退出 0）。`vendor/README.md` 与
   `F022` 的构建步骤里目前只写了 `plugin-ext`，**建议补上 `plugin-ext-vscode`**。
   套件里用 `vscode-init-missing` 这个独立错误码把它和「宿主没建」分开，
   不会静默。

**还有一条信息性的**：真实 latex-workshop 能激活并注册 71 条命令，
但**它注册的语言/编辑器类能力（补全、悬浮、格式化）在本宿主里没有消费方** ——
那些是 `LanguagesMain` / `TextEditorsMain` 的方法，本卡只做了「记录 + 安全默认值」。
`NOT-COVERED` 那三行说的就是这个边界。**这是 F025+ 的范围，不是本卡的缺陷。**

---

### 7. 提交 SHA

**`46117686`** — `feat(F023): boot the real Theia host, and say what an extension can touch before it installs`
（12 个文件，`git show --numstat` 逐条核对过，没有卷入其它会话的在途改动）。改动文件：

```
packages/contracts/src/extensionPermissionReport.ts          （新建，契约）
packages/contracts/src/index.ts                              （+1 行导出）
apps/desktop/src/main/modules/theiaPermissionReport.ts       （新建）
apps/desktop/src/main/modules/theiaHost/host.ts              （新建）
apps/desktop/src/main/modules/theiaHost/installConsent.ts    （新建）
apps/desktop/scripts/theia-host-boot-smoke/**                （新建：main.ts / run.sh / fixtures）
```

**没有碰**：`vendor/theia/**`（vendor `git status` 空）、`vscodeL1Bridge.ts`、
`packages/vscode-compat/**`、`apps/desktop/scripts/theia-vendor-smoke/**`。

### 8. 套件输出里的边界（每次运行都打）

```
NOT-COVERED: TextEditor.edit / 撤销栈（F024）
NOT-COVERED: workspace 与 window 的大部分 API（F025+）
NOT-COVERED: 运行时沙箱 —— 用户选择了安装时告知，不是隔离
```

**最后一条尤其重要**：一个看日志的人会把「装时说清楚」读成「有保护」。
它不是保护，是知情同意。
