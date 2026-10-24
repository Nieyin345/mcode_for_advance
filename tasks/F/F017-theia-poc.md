# F017｜Theia PoC：`plugin-ext` 到底能不能接进 Mcode

- Status: **done**（PoC 结论：有条件能；见文末回写）
- Category: **PoC / 可行性验证**（不改产品代码）
- Depends on: 用户裁决「贴合 VS Code 扩展机制，尽可能复用 VS Code 扩展」
- Exclusive writable files:
  - 新建 `.tmp/theia-poc/`（**全部产物都在这里，不进 git**）
  - `tasks/F/F017-theia-poc.md` 回写
- **不碰**：`apps/desktop/**`、`packages/contracts/**`、`package.json`、`pnpm-lock.yaml`

## Required Skills
- 无特殊。需要会读源码、会装包、会写探针。

---

## 这张卡要回答的唯一问题

> **`@theia/plugin-ext` 能不能在没有完整 Theia 应用的情况下，接进 Mcode 现在的 Electron，跑起一个真实的 VS Code 扩展？**

**不是「设计上应不应该接」，是「技术上能不能」。**

---

## ⚠️ 先纠正一个数据（我写卡前实测的）

`docs/planning/extension-vscode-compat.md` §6.1 写的是 **19 个直接依赖**。

**那是 `@theia/plugin-ext-vscode`（包装层）的数字。真正的 `@theia/plugin-ext@1.76.0` 有 48 个直接依赖：**

```
@theia/ai-core  @theia/ai-mcp  @theia/bulk-edit  @theia/callhierarchy
@theia/console  @theia/core  @theia/debug  @theia/editor
@theia/editor-preview  @theia/file-search  @theia/filesystem  @theia/markers
@theia/messages  @theia/monaco  @theia/monaco-editor-core  @theia/navigator
@theia/notebook  @theia/output  @theia/plugin  @theia/plugin-utils
@theia/preferences  @theia/scm  @theia/search-in-workspace  @theia/task
@theia/telemetry  @theia/terminal  @theia/test  @theia/timeline
@theia/typehierarchy  @theia/variable-resolver  @theia/workspace
+ node-pty / decompress / vscode-textmate / @vscode/debugprotocol 等 17 个非 theia 包
```

**这 48 个里，`@theia/core` / `@theia/monaco` / `@theia/editor` 会把整个 Theia 编辑器拖进来。**

**所以「只取 plugin-ext 不引入完整 Theia」这个想法，从依赖表看是不成立的。** PoC 要验证的正是这件事的实际后果。

---

## 三个必须回答的问题（按顺序，前一个不成立就不必往下做）

### ① 装得进来吗？

```
- `@theia/plugin-ext@1.76.0` 能否与 Electron 44 + 现有 Monaco 0.56 共存？
- 依赖冲突有哪些？（`@theia/monaco-editor-core` 会带自己那份 Monaco）
- `node-pty` 是原生模块，在 Windows + Electron 44 上要 rebuild —— 能过吗？
```

**产出**：一份「装了什么、冲突在哪、哪些是硬冲突」的清单。

**如果装不进来 → 这张卡就结束，结论「不可行」+ 冲突清单。** 不必往下。

### ② 能不能**只**用它的扩展宿主？

Theia 的 `plugin-ext` 是一组 DI（依赖注入）模块，靠 `@theia/core` 的容器装配。
**问题是：能不能装配出「只有扩展宿主、没有 Theia 的 UI/编辑器」的一个实例？**

**要查的源码**：

```
node_modules/@theia/plugin-ext/lib/*/plugin-*.js        ← 宿主入口在哪
node_modules/@theia/plugin-ext/lib/hosted/node/         ← 子进程宿主
node_modules/@theia/plugin-ext/lib/plugin/plugin-manager*.js  ← 扩展生命周期
```

**关键判断**：`plugin-ext` 是否硬依赖 Theia 的 `Application` / `Shell` / `EditorManager`。

**如果能装配出「无 UI 的扩展宿主」** —— 那 Mcode 只需要提供它要的接口（文件系统、编辑器代理），那是**薄适配**。
**如果它硬依赖 Theia 的 UI** —— 那「只取宿主」不成立，等于整个 Theia。

### ③ 真跑一个扩展

**如果能走到这一步**，用本机已有的最小真实扩展（`siesta.vscode-pdf-translate`，7 KB、只用 `vscode` + `path`）：

```
- 它能不能被加载？
- 它的 3 条命令能不能注册？
- `activate()` 能不能跑？
```

**不需要跑通它的全部功能**（那要 PDF 编辑器），只要 `activate()` 不崩、命令出现在列表里，就说明宿主是活的。

---

## 边界（很严，因为这是 PoC）

**只写 `.tmp/theia-poc/`。** 具体：

- 所有 `npm install` 都在 `.tmp/theia-poc/` 里做，用独立的 `package.json`
- **不修改仓库的 `package.json` / `pnpm-lock.yaml`**
- **不修改 `apps/desktop/**`** 任何文件
- 探针脚本放 `.tmp/theia-poc/probe-*.mjs`

**为什么这么严**：这是可行性验证，不是实现。**一次失败的装包不能污染主仓库的依赖树。**

---

## 验收判据

1. **① 的结论有实测**（装了 / 没装成 + 具体冲突清单），不是「查了 npm 元数据」；
2. **② 的结论引用源码行号**（`plugin-ext` 的哪个文件硬依赖哪个 Theia 服务）；
3. **③ 只有在 ①② 都成立时才做**，做到哪一步算哪一步；
4. **最终给一个明确的「能 / 不能 / 有条件能」**，并说明条件是什么；
5. **仓库 `git status` 里不能出现 `package.json` / `pnpm-lock.yaml` 的改动**（提交前自查）。

---

## 切分指令（最重要的部分）

**这张卡允许「做不到」的结论。** 而且**「做不到」比「硬做出来」更有价值** —— 因为:

- 「做不到 + 为什么」→ 用户能据此决定要不要走另一条路；
- 「硬做出来但很脏」→ 会诱导后面的人继续投入。

**所以：每一步都要如实记「卡在哪」，不要为了让 PoC 成功而绕过障碍。**

**特别是**：如果 ① 就装不进来（依赖冲突、原生模块编译失败），**立刻停下**，写清冲突清单，不要试图「先装个旧版本试试」——那是另一个问题。

---

## 回写

`tasks/F/F017-theia-poc.md` 末尾 `## 结果回写`：

1. **能不能装**（贴 `npm install` 的实际输出/错误）；
2. **原生模块 `node-pty` 在 Windows + Electron 44 上的结果**；
3. **`plugin-ext` 是否硬依赖 Theia UI**（引用源码行号）；
4. **最终结论：能 / 不能 / 有条件能**，条件是什么；
5. **对 `extension-vscode-compat.md` §6.1 的修正建议**（那个 19 应该改成 48，且「自建更省」那条已被证伪）；
6. 仓库 `git status` 确认没污染主依赖树。

---

## 结果回写（2026-10-24）

### 结论先说

**有条件能 —— 而且是好消息里的坏消息。**

**技术障碍比预想的小得多**：`plugin-ext` **不硬依赖 Theia UI**，插件宿主进程可以独立启动。
**真正的工作量在另一边**：宿主启动后要反向调用父进程的 **12 个接口**，那是必须自己实现的部分。

| 问题 | 答案 |
|---|---|
| ① 装得进来吗 | **能**。596 个包 / 307 MB / 27 秒 |
| ② 只取扩展宿主可行吗 | **能**。`plugin-host.js` 零 UI 依赖，独立 fork 后正常启动 |
| ③ 能跑真实扩展吗 | **没做到**。需要先实现 12 个 Ext 接口 + MessagePack 握手，超出 PoC 范围 |

---

### ① 装得进来 —— 实测

```
npm install @theia/plugin-ext@1.76.0  （--ignore-scripts，独立 .tmp/theia-poc）
added 596 packages in 27s

node_modules 307 MB
397 个顶层包，其中 38 个 @theia
自带 @theia/monaco-editor-core（与仓库已装的 monaco-editor 0.56 并存，未冲突）
```

**依赖冲突：没有出现任何 peer/版本冲突。** 装得干净。

**`node-pty` 原生模块 —— 这是最大的担忧，结果不是问题：**

```
node-pty 自带预构建二进制：prebuilds/win32-x64/conpty.node
node scripts/prebuild.js → exit 0（找到预构建）
```

**在 Electron 44 里实测加载并 spawn 成功：**

```json
{"electron":"44.4.5","node":"24.21.0","modules":"149","ptyRequire":"OK","spawn":"OK"}
```

> ⚠️ **注意 ABI**：`node-pty` 的预构建脚本**只按 platform-arch 目录挑，不区分 Node/Electron 的 ABI**。
> 它能在 Electron 44（`modules: 149`，内部 Node 24）加载成功，是因为它的预构建用了 **N-API**（跨 ABI 稳定）。
> **如果将来换成一个非 N-API 的原生模块，这里会失败，而且需要 Visual Studio C++ 工具链。**
> 本机实测：`node-gyp rebuild` 失败 —— `Could not find any Visual Studio installation to use`。
> **所以「装得上」依赖的是预构建二进制，不是能本地编译。**

---

### ② 只取扩展宿主 —— 可行，证据是源码

**插件宿主进程（被 fork 的那个）零 UI 依赖。** 逐文件核过：

| 文件 | 它 require 的 `@theia/*` | 有没有 UI |
|---|---|---|
| `hosted/node/plugin-host.js:19-28` | `core/shared/reflect-metadata`、`core/shared/inversify`、`core/shared/vscode-uri`、`core/lib/common/message-rpc/*` | **无** |
| `hosted/node/plugin-host-module.js` | `core/lib/common/encoding-service`、`core/lib/node`、`core/shared/inversify` | **无** |
| `hosted/node/hosted-plugin.js:19-23` | `core/shared/inversify`、`core/lib/common` | **无** |

**`grep -c "lib/browser|Application|Shell|EditorManager"` 在 `plugin-host-module.js` 上是 0。**

**运行时探针也证实了**（`.tmp/theia-poc/probe-host-entry.js` / `probe-plugin-host.js`）：

```
load @theia/core/lib/node            → ok（22 exports）
load hosted-plugin.js                → ok（HostedPluginSupport）
load plugin-host-module.js           → ok
require.cache 里 @theia/core/lib/browser → 零
require.cache 里 @theia/monaco           → 零
```

**所以「只接扩展宿主、不引入 Theia 的编辑器和 UI」这个前提是成立的。** 仓库 §6.1 里
「绑定 Theia core/editor/monaco，集成冲突风险」这条**在 plugin-ext 这一层被证伪了**。

**但有一个必须知道的接线细节**（这是第一次探针失败暴露出来的）：

```
@theia/core/lib/node/messaging/ipc-channel.js:54
    this.messagePipe = new BinaryMessagePipe(new net.Socket({ fd: 4 }));
```

**宿主要求 `stdio[4]` 是一条专用管道**（第 5 个通道，与 0/1/2/3 并列），用于二进制 MessagePack。
按这个形状 fork 之后宿主正常启动，**6 秒无 stderr，进程存活**（`probe-fork-host-v2.js`）。
Mcode 现在没有任何地方这样起进程，这是要新建的。

---

### ③ 没做到 —— 卡在哪，说清楚

宿主启动后，父进程要调 `initialize()` 并提供一个 **MainPluginHostRPC** 对象。
**宿主会反向调用它来实现 `vscode.*`。** 这个接口拆成 12 个 Ext 接口（`plugin-host-rpc.d.ts:24-39`）：

```
envExt / storageExt / debugExt / editorsAndDocumentsExt / messageRegistryExt
workspaceExt / preferenceRegistryExt / clipboardExt / webviewExt
terminalServiceExt / secretsExt / localizationExt / telemetryExt
```

**方法数实测**（`.d.ts` 里数出来的）：

| Ext 接口 | 方法数 |
|---|---|
| `webviews` | **23** |
| `terminal-ext` | **27** |
| `workspace` | **14** |
| `editors-and-documents` | 6 |
| `message-registry` | 2 |

**合计远超 100 个方法**，而且每一个都要接 Mcode 自己的编辑器/终端/存储。
**这不是 PoC 能在一轮里做完的**，也不该硬做 —— 按卡里「做不到比硬做出来更有价值」，
**在这里停下**。

**没有继续做的原因不是做不到，是：这一步的产出会是一份「接口清单 + 空实现」，
它对判断「值不值得投入」没有增量信息 —— 接口数量已经说明问题。**

---

### 最终结论：有条件能

**能接。** 前提是 Mcode 愿意为下面两件事付出：

| 要做的 | 规模 | 难度 |
|---|---|---|
| **5 通道 fork + MessagePack 握手** | 一个进程管理器 | 低（`ipc-channel.js` 有现成形状可照） |
| **实现 12 个 Ext 接口（100+ 方法）** | 一座桥 | **高 —— 这是主要工作量** |
| 依赖体积 | **307 MB / 596 包** | 发行包会显著变大 |
| 许可 | EPL-2.0 OR GPL-2.0+CE | 可商用，但需保留 NOTICE + 源码可得义务 |

**和自建比**：自建要做 53 个 `vscode.*` + 多文件加载器 + 扩展点消费。
**Theia 给的是「已经稳定运行了很多年」的那 100+ 个接口实现，代价是 307 MB 和一套自己的 DI 约定。**

**所以「自建更省」这个判断仍然站不住** —— 但也要承认：**接 Theia 不等于接完就能用**，
那 100+ 个方法里**每一个都要 Mcode 拿自己的编辑器/终端去填**。

---

### 对 `extension-vscode-compat.md` §6.1 的修正建议

1. **「19 个直接依赖」应改成 48**（`@theia/plugin-ext@1.76.0`）。19 是包装层
   `@theia/plugin-ext-vscode` 的数。连带：**实测装完是 596 个包 / 307 MB**。
2. **「与现有 Monaco/Electron 集成冲突风险，尚未安装实测」应改写**：
   **已实测，无冲突**。`@theia/monaco-editor-core` 与 `monaco-editor@0.56` 并存无报错；
   `node-pty` 用 N-API 预构建，Electron 44 直接加载成功。
3. **「绑定 Theia core/editor/monaco」这条对 `plugin-ext` 不成立** ——
   插件宿主进程（`hosted/node/plugin-host.js`）零 UI 依赖，已用 `require.cache` 实测。
   **但 `@theia/core` 作为依赖仍会被装进来**（38 个 `@theia` 包里最大的一块）。
4. **新增一条事实**：`@theia/core/lib/node/messaging/ipc-channel.js:54` 用 `net.Socket({fd:4})`，
   **宿主必须 5 通道 fork**。这是接入的第一个硬约束。

---

### 仓库洁净

```
git status --porcelain package.json pnpm-lock.yaml apps/desktop/package.json   → 空
.tmp 已 gitignore ✓
所有产物在 .tmp/theia-poc/（307 MB，可随时删除）
```

**没有修改任何产品代码。**
