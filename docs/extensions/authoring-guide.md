# 写一个 Mcode 扩展

> **这份文档回答一个问题：怎么写一个能被 Mcode 装上并跑起来的扩展。**

Mcode 只有**一套**扩展系统：**VS Code 扩展协议**。装的是标准 `.vsix`，
写的是标准 `vscode.*` API，跑在真的 Theia plugin host 子进程里。
Mcode 自己的功能通过 `mcode.*` 命令暴露给扩展，不另开一套 SDK。

> **2026-10-27 起，旧的「Mcode 原生扩展」（手写 JSON 清单 + `ModuleHost`）已整体下线。**
> 它曾经是本文档 §1–§5 的主体。现在没有第二条路 —— 如果你在别处读到
> 「原生扩展 / 模块清单 / `ModuleManifestSchema`」，那是**过期信息**。
> 为什么删：用户裁决「只要一个扩展系统」，且手写清单能做的事，VS Code 扩展协议都能做，
> 而后者能直接吃现成生态。

---

## 0. 先说清楚边界（读这一节能省你半小时）

| 你想做的 | 支持吗 | 怎么做 |
|---|---|---|
| 把一个现成的 VS Code 扩展搬过来 | ✅ **能**，多数只需小改 | §2 |
| 用 `vscode.*` 的常用面（命令 / 语言能力 / Webview / 自定义编辑器 / 终端） | ✅ **支持** | §4 |
| 扩展调 Mcode 的功能（工作流 / 资料库 / 记忆 …） | ✅ **支持** | `executeCommand("mcode.<方法>")`，见 §5 |
| 起子进程 / `child_process` / 加载 npm 依赖 | ✅ **允许** | §3 |
| 用调试器 / 任务系统 / SCM / Notebook / `languageModel` | ❌ **未实现** | §7 |
| 写一个「Mcode 原生」的 JSON 清单扩展 | ❌ **这条路没有了** | 写成 VS Code 扩展 |

⚠️ **「能装」不等于「能跑」。** 一个装进来的 VSIX 可能激活时崩掉。
**判定标准是「它能不能跑起来」，不是「它出现在列表里」。**
`theia-installed-smoke` 的 145 条断言验的就是「真的跑起来」那一侧。

---

## 1. 怎么装

**入口**：设置 → **UI 扩展**（`ide.modules.title`）→ 从 `.vsix` 安装。

**装之前会看一张卡片**：它会告诉你这个扩展**会不会起子进程、会不会联网**
（静态下限扫描，见 §3），然后问你要不要装。**拒绝 = 磁盘上没有任何写入**。

面板支持的操作（`op`）：`install` / `list` / `inspect` / `setEnabled` / `start` /
`stop` / `remove` / `cancel`，加上 `configList` / `configSet`（改扩展的配置项）、
`webviewViewOpen`、`customEditorOpen`。

**扩展不会自动启动。** 你点「启动」它才跑；离开设置页面**不会**停掉它 ——
已经启动的命令留在 Mcode 里可用。

---

## 2. 把一个现成的 VS Code 扩展搬过来

这是主要用法，**不需要从零写**。典型流程：

1. 从 VS Code 市场拿到 `.vsix`（或自己打包）；
2. 装进去，看它能不能激活（§6 的错误表）；
3. 如果它用了 Mcode 没实现的 API，把那一小块改掉（§4 的覆盖表）；
4. 如果它想调 Mcode 的功能，加几行 `mcode.*`（§5）。

**大多数扩展不用改**：命令、状态栏、语言能力、Webview、终端、工作区文件、
配置读写这些面 Mcode 都实现了。真正会卡住的通常集中在 §7 那几块。

### 一个最小可跑的扩展清单

从零写的话，`package.json` 至少要有这些（`main` 是相对包根的路径，可以多层）：

```json
{
  "name": "hello-mcode",
  "publisher": "your-name",
  "version": "1.0.0",
  "engines": { "vscode": "^1.80.0" },
  "main": "./extension.js",
  "contributes": {
    "commands": [{ "command": "hello.sayHi", "title": "Say hi from Mcode" }]
  }
}
```

`extension.js` 就是标准 VS Code 写法：

```js
const vscode = require("vscode");

exports.activate = function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("hello.sayHi", async () => {
      await vscode.window.showInformationMessage("来自扩展的问候");
    }),
  );
};
```

打成 `.vsix`（用 `vsce package` 或任何能产出标准 VSIX 的工具），装进去，
在命令面板里就能看到 `Say hi from Mcode`。

> **这条链是真的跑通过**：`apps/desktop/scripts/ext-mcode-e2e-smoke/` 用同样形状的
> 扩展（真 ZIP → 真解压 → 真 `TheiaHost` 子进程）验了「扩展注册命令 → 执行 → 返回值」。
> 它不是纸上示例。

---

## 3. 能跑什么、有什么限制

### 硬限额

实测值（`theiaHost/installedRegistry.ts`、`theiaVsixPreview.ts`）：

| 限制 | 现值 | 说明 |
|---|---|---|
| 整包大小 | **64 MiB** | 压缩包本身 |
| 解压总量 | **150 MiB** | 防 zip bomb |
| 单条文件 | **32 MiB** | |
| 包内文件数 | **3000** | |
| `package.json` | **256 KiB** | |
| `main` 写法 | **任意相对路径** | 可多层目录，禁 `..` 逃逸 |
| `require` | **Node 原生解析** | **没有白名单** —— 相对路径、`node:*`、npm 依赖都能加载 |

### 不做运行时隔离 —— 这是明写设计

`child_process` **允许**，`require` **没有白名单**。
扩展就是一个真的 Node 程序，跑在独立子进程里（`theiaHost/host.ts:35`、`:38` 写明）。

**所以安全边界不是「沙箱」，是「安装时知情同意」**：
装之前那张卡片会扫一遍扩展代码，告诉你会不会起进程、会不会联网，
以及依据在哪一行（`文件:行号`）。它自己声明这是**静态下限** ——
「扫到的是确定有的，没扫到的不等于没有」。

**如果你要装一个来路不明的扩展，先读那张卡片。**

---

## 4. `vscode.*` 覆盖到哪

**已实现**（`theiaHost/host.ts` + 渲染端 provider 桥）：

- 命令（`commands.registerCommand` / `executeCommand`）
- 状态栏、快捷输入（Quick Pick / Input Box）、通知
- 诊断（`languages.createDiagnosticCollection`）
- Webview（受限 iframe，见下）
- 自定义编辑器（`CustomTextEditor`）
- 终端（复用 Mcode 原生 PTY，不另装 node-pty）
- 工作区文件、配置读写
- **13 种语言能力**：hover / completion / definition / references / implementation /
  typeDefinition / documentSymbols / formatting / rangeFormatting / onTypeFormatting /
  signatureHelp / rename / codeActions

**未实现**：调试器、任务系统、SCM、Notebook、聊天 / `languageModel`、
测试控制器、`authentication` / `SecretStorage`。用到这些的扩展通常**能激活、功能不全**，
在调用点失败。

### Webview 的沙箱

Webview 挂在 Mcode 根布局的**受限 iframe** 里，不是注入宿主 DOM：

- `sandbox` 只给 `allow-scripts`（**不给 `allow-same-origin`** —— 不透明源）；
- 全局 CSP 是 `default-src 'none'`，`frame-src 'none'`，`base-uri 'none'`，`form-action 'none'`；
- 网络出口 `connect-src` **只放行该扩展自己的资源源**（`resourceOrigin`），不是全开；
- 消息必须来自**当前拥有的那个 iframe**（`?.contentWindow===event.source`），
  并通过受控 IPC 转发。

---

## 5. 扩展怎么调 Mcode 的功能

除了 `vscode.*`，扩展还能调 Mcode 自己的方法：

```js
// 只读：直接执行，立刻拿到结果
const hits = await vscode.commands.executeCommand("mcode.library.search", { query: "论文" });

// 写 / 高风险：会弹原生确认框，用户点头才执行
await vscode.commands.executeCommand("mcode.project.delete", { path: "/tmp/x" });

// 幂等键（重试同一件写操作时原样带回，避免重复执行）
await vscode.commands.executeCommand("mcode.library.saveNote", { title, body },
  { operationId: "op-1" });
```

**方法名就是 `app_api_list` 里列的那些**，前面加 `mcode.`。返回值是一个普通对象：

```js
{ ok: true,  result: ... }                          // 成功
{ ok: false, error: "..." }                         // 失败（原因原样给出）
{ ok: false, needsApproval: true, error: "..." }    // 被用户或环境挡了
```

**权限与 agent 的 `app_api_call`、自定义面板的 `mcode.api.call` 完全同源**
（同一条 `panelApiCall` 管线）：只读直接跑；写和 danger 档每次都问用户；
`customModel.getToken` 这类密钥方法扩展**够不到**（blocked 档）。

**扩展不能自己批准。** 桥**不接受**扩展传任何「已批准」标志 —— 那等于自批准。
写操作要么走宿主注入的审批端口问用户，要么 fail-closed 直接拒绝。

**Mcode 内置命令**（不走 RPC 表，就地执行，只读）：`mcode.file.inspect`（字节数 + SHA-256）、
`mcode.file.info`（字节数 + 修改时间）。它们**优先于** RPC 表解析，
所以扩展注册一个同名命令**劫持不了**它们。

**加一条新能力不用改扩展侧代码** —— Mcode 那边加一条 RPC、重跑生成器，
扩展立刻就能调，桥本身一行不用改。

> **`mcode.` 这个前缀是保留的。** 扩展自己注册命令请不要用 `mcode.` 开头，
> 否则会被当成对 Mcode 能力的调用。

---

## 6. 装失败时怎么读错误

| 症状 | 含义 | 你能做什么 |
|---|---|---|
| 超过 64 MiB / 3000 条 / 150 MiB | 包太大或太碎 | 找更小的版本 |
| CRC 错 / `package.json` 非法 | 包坏了 | 重新下载 |
| 「依赖的 Theia 运行时缺失」 | `vendor/theia` 没构建 | 按 `vendor/README.md` 跑一次 `npm ci` + `tsc --build` |
| 装了但没反应 | 可能激活失败 | 看主进程日志；用 `theiaInstalled({op:"inspect"})` 看它报什么 |
| 扩展命令报 `Command: xxx does not exist.` | 命令没注册 | 它没激活成功，或命令 id 拼错了 |

> **注意**：`executeCommand` 对**不存在的命令会报错**，不是静默返回 `undefined`。
> 真机实测（Theia 1.76 `plugin-ext/lib/plugin/command-registry.js:84`）抛的是
> `Command: <id> does not exist.`。所以命令名写错时你会**看到错误**，
> 不会被「看起来成功了」骗过去。

---

## 7. 明确不支持

| 不支持 | 为什么 |
|---|---|
| 调试器 / 任务系统 / SCM / Notebook / `languageModel` | Theia 宿主没实现这些面 |
| 没有任何运行时隔离 | 明写设计：扩展是真 Node 程序。安全边界是**安装时知情同意**，不是沙箱 |
| 手写 JSON 清单的「Mcode 原生扩展」 | 已下线（2026-10-27）。写 VS Code 扩展 |

---

## 8. 想改这份文档？

改之前先跑这两套 —— 它们验的是「文档说的和代码做的是不是一回事」：

```bash
bash apps/desktop/scripts/extension-honesty-smoke/run.sh
bash apps/desktop/scripts/theia-palette-smoke/run.sh
```

`extension-honesty-smoke` 会读本文档、检查它是否还在讲已经不存在的东西；
`theia-palette-smoke` 会检查本文档描述的 UI / Webview / 权限线是否还连着。

**改了行为就回头改这一节。** 一份说「没有 X」的文档比一份什么都不说的文档更坏，
因为读者会据此放弃 —— 本文档 §1–§5 就曾经整节在讲一条已经删掉的路。
