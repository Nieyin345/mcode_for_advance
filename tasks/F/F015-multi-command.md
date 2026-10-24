# F015｜多命令：让 `commands[1..N]` 真的能跑（而不是只有第一条）

- Status: ready-for-agent
- Category: **P0 扩展主线**
- Depends on: F014（`86e74e65`，清单层全通过；`6b8dbe16`，module 路由计数修正）
- Exclusive writable files:
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`
  - `apps/desktop/scripts/vsix-multi-command-smoke/`（新建）
  - 本卡回写
- **不碰**：`packages/contracts/**`、`ipc/**`、`renderer/**`、`ModuleHost.ts`、`permissionedProcessRunner.ts`

> ⚠️ **编号说明**：总控说的「F007」在本仓库里**已经被占用** ——
> `tasks/F/F007-require-whitelist.md` 是 `require` 白名单的旧版卡（和 `F013` 同一件事，
> F013 已交付 `aa393597`）。F007 从未提交、Status 仍是 `ready-for-agent`，是被 F013 取代的废弃稿。
> 本卡用 **F015**（F008 也已用于命令前缀）。**不要改 F007 的状态，也不要在它上面写。**

## Required Skills
- `mcode-smoke`

---

## 现状：24 条命令只跑 1 条

`contributes.commands` 从 F004 起能收 64 条（`rainbow-csv` 24 条），但运行时只认第一条。
`commandId` 在今天有 **13 处**引用，其中三处是"只跑一条"的实现：

| 位置 | 代码 | 作用 |
|---|---|---|
| `:793` | `const commandId = pkg.contributes.commands[0]!.command` | **单数**：只取第一条 |
| `:639` | `if (id !== ${JSON.stringify(command)} ...)` | `registerCommand` 只接受那一个 id |
| `:719` | `handlers.get(${JSON.stringify(command)})` | 执行时只查那一个 id |
| `:975` | `if (commandId !== this.commandId) throw` | 外面再挡一次 |
| `:870` | `title: pkg.contributes.commands[0].title` | 清单里只有一条的标题 |

**用户看到的现象**：扩展装进来了、菜单里只有「CSV Lint」，其余 23 条点了报 `not activated`。

**F014 已经把「为什么不能跑」说清了**（`executeCommand` 现在点名能跑的是哪条）。
本卡要做的是**让它们真能跑**，而不只是说清楚。

### ⚠️ 顺带发现：`MAX_COMMANDS = 64` 会让 3 个真实扩展**装不进来**

写卡时数过：本机 **3 个真实扩展的命令数超过 64**——

| 命令数 | 扩展 |
|---|---|
| 74 | `ms-azuretools.vscode-azurefunctions` |
| **101** | `ms-azuretools.vscode-containers` |
| 71 | `ms-vscode-remote.remote-containers` |

它们现在在**清单层**就被拒（`contributes.commands` 超过 `MAX_COMMANDS`）。
**这和 F014 撤掉 `activationEvents` 校验是同一类问题**：阈值按想象定的，真实输入全撞上。

**本卡要处理它**：把 `MAX_COMMANDS` 提到能容纳实测最大值（`101` → 给它余量，比如 256），
**并加断言**：「101 条命令的清单能装」。上限本身要保留（无界数组仍是攻击面），
但**理由要写成"防内存"而不是"够用就行"** —— 64 那个数字没有依据。`

---

## 关键约束：不能"一命令一能力"

我先试过最自然的方案 —— 每条命令一个 capability（`module.<slug>.<cmd>`），
让 `host.invoke` 天然按命令分派。**这条路走不通，原因是契约层的硬形状**：

```ts
// packages/contracts/src/modules.ts:62
export const MODULE_CAPABILITY_SHORT_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
```

短名必须**单段小写 kebab**。而真实命令 id 是：

- `rainbow-csv.CSVLint` —— **大写**；
- `rainbow-csv.compose.down` —— **多段点**（`ms-azuretools.vscode-containers` 的真实形态）。

**都过不了那个正则。** 要支持它们就得改 `MODULE_CAPABILITY_SHORT_NAME`，
那是 `packages/contracts/**` —— 本卡边界之外，而且它是**全仓共享的命名空间规则**，
为一个 bridge 的需求放宽它，影响面远超本卡。

**所以：命令的分派必须在 bridge 内部完成，不能借 capability 路由。**

---

## 可以借的一条现成通路：`resource`

`ModuleInvoke` 的 `resource` 是 `{ projectPath, path }`，会**原样**穿过
`ModuleHost` → `runPermissionedProcess` 的 payload → 子进程的 `fn(p.resource)`：

```
bridge.executeCommand(cmd, resource, requestId)
  → host.invoke({ moduleId, contributionId: "run", resource, requestId })
    → definition.run(resource)            // ModuleHost.ts:1124
      → runPermissionedProcess({ resource: {...} })
        → payload = { proof, source, capability, resource }
          → fn(p.resource)                // 子进程
```

**但 `resource.path` 是已授权的真实文件路径**，`authorize(resource)` 会判它。
往里面塞命令 id 会让授权判定针对一个假路径 —— **那是安全边界，不能绕**。

**所以 `resource` 只能原样透传，不能拿来带命令。**

> **结论：本卡能给的是「多条命令都能注册、都能被调到」，但「哪条命令」这个信息
> 在**当前契约**下传不进子进程。**这是一个诚实的边界，必须写进回写区**，
> 不要用一个假通的实现把它盖住（F011 的判据：不许有没说过的不支持）。

---

## 任务

### 一、先判断「能跑」到底指什么 —— 三个层次，你要选并论证

| 层 | 含义 | 本卡能做到吗 |
|---|---|---|
| **L1 注册** | 扩展 `activate()` 里 `registerCommand` 任意已声明命令都不报错 | **能**。去掉 `id !== command` 那处硬比对，改成「必须在本清单的 commands 里」 |
| **L2 分派** | `executeCommand(cmd)` 能选中对应命令 | **部分能**。bridge 内部能按 cmd 选，但子进程只认一个 capability |
| **L3 端到端** | 子进程真的跑那条命令的 handler | **不能**，除非改契约 |

**必须论证**：只做 L1 会不会制造「注册成功但调用时还是只有第一条」的**新静默失效**？
（这正是 F011 与 F014 一路在防的东西。）

**如果你判断 L1 单独做会制造新的静默失效，那就要一起做 L2**，
并且 L2 的实现要在**扩展代码自己的 Map 里**分派 —— 子进程里
`handlers` 是扩展注册的 `Map`，**它是可以按 id 查的**，只是入口只查一个键。

### 二、不管选哪层，`contributes` 的标题必须跟着改

```ts
:870  title: { zh: pkg.contributes.commands[0].title, ... }
```

**只有一条命令的标题进清单**，其余 23 条在 UI 上不存在。
按总控的要求「每条命令的 `title` 都要进 `contributes`」。

> **⚠️ 但我先查了形状，这条路很可能走不通 —— 请你自己实测确认。**
>
> ```ts
> // packages/contracts/src/modules.ts:9
> const LocalId = z.string().min(1).max(60).regex(/^[a-z][a-z0-9-]*$/);
> // packages/contracts/src/modules.ts:120
> id: LocalId,          // ← ModuleManifest.contributions[].id
> ```
>
> `LocalId` 比能力短名**更窄**：**不许大写、不许点**。
> 而真实命令 id 是 `rainbow-csv.CSVLint`（大写）、`rainbow-csv.compose.down`（点）。
>
> **所以「每条命令一个 contribution」在当前契约下不可能** —— 除非改 `LocalId`，
> 而它是全仓共享的（`ModuleInvokeSchema` 的 `contributionId` 也用它）。
>
> **`contributes[]` 里能不能放"别的 id + 每条命令的 title"？** 那要新造一个字段
> （比如 `extensions: string[]` 表示「这个 contribution 覆盖哪几条命令」）——
> 那是改契约，本卡边界外。
>
> **实测（写卡时跑过，不是估的）**：本机所有扩展一共 **884 条命令，过 `LocalId` 的是 0 条（0.0%）**。
> 连 `rainbow-csv` 那**第 1 条**（`rainbow-csv.CSVLint`）都过不了 ——
> **现在它能有 title，是因为 `id` 被硬编码成 `"run"`，命令 id 根本没进那个字段。**
>
> **本卡的正确产物是：如实报「做不到」，并说清卡在哪一行。**
> **不要**为了过关把命令 id 截断/哈希塞进 `LocalId` —— 那会让 UI 显示一串
> 用户认不出的东西，比不做更坏。若你找到一条**不改契约**的路，先验证它能通过
> `ModuleManifest` 的 schema 再写。

### 三、执行时按命令 id 查表，未知命令要拒且说清

`executeCommand` 现在的错误信息（F014 写的）是：

```
VS Code command '<x>' is not activated in this host — only the first declared command ('<first>') is invokable
```

**如果本卡让多条能跑，这句话就变成假话了** —— 必须同步改，
而且**改的方向是「拒的只有真的不在清单里的」**：

- 在清单里、但本卡没能做到 L3 → 说清「这条已声明但当前无法执行」；
- **根本不在清单里** → 拒，并点名。

**三种情形要能分开**，别合并成一句。

---

## 验收判据

1. **多命令的清单能装**，且 `ignoredContributions` **不再因为多命令产生噪音标记**；
2. **`registerCommand` 对清单内任意命令不报错**（正控：24 条全注册成功）；
3. **负控：清单外的命令仍然被拒**，且错误点名（别把白名单拆了）；
4. **未知命令的拒绝与「已声明但跑不了」能分开**（三种情形，各一条断言）；
5. **`executeCommand` 的错误信息不再声称 "only the first"**（如果 L2 做了）；
6. **`contributes` 里每条命令的 title 都在**（做不到就写明为什么）；
7. **不跑全量、不起 Electron**；
8. **`rainbow-csv` 的 24 条命令现在是几条「能跑」** —— 给一个准确数字，不要含糊；
9. **101 条命令的清单能装**（`MAX_COMMANDS` 放宽后；负控：无上限仍要拒，比如 10000 条）。

---

## 变异表（**先写预期红几条，再跑**）

| 变异 | 预期 |
|---|---|
| `registerCommand` 的白名单整个去掉（任何 id 都收） | **2 条红**（负控「清单外的被拒」+ 错误点名） |
| `executeCommand` 的清单校验去掉（任何命令都往下走） | **1 条红**（负控） |
| 清单标题收集退回只取 `commands[0]` | **1 条红**（每条 title 都在） |
| `MAX_COMMANDS` 退回 64 | **1 条红**（101 条能装） |

**⚠️ 变异先自证**：改完先 `grep` 确认写进去了，再跑套件。
**⚠️ 备份名带完整路径**（F012 事故：两个 `modules.ts` 重名互相覆盖）。
**⚠️ `run.sh` 必须在 `apps/desktop` 下调用**（F014 踩过：`cd "$(dirname "$0")/../.."`
依赖调用者 cwd，从仓库根调用 → `lib/esbuild-path.sh` 找不到 → `rc=127` 而日志只有一行，
看起来像「跑了但没红」）。**取不到通过数要当硬错误。**

---

## 回写

1. 你选了 L1 / L2 / L3 的哪一层，**论证**（尤其 L1 单独做会不会制造新的静默失效）；
2. `LocalId` / 能力短名的形状限制，**实测结论**（能不能装下真实命令 id）；
3. 「命令」这个信息为什么（没）能传进子进程，**贴关键代码路径**；
4. **`rainbow-csv` 的 24 条命令现在几条能跑**（准确数字）；
5. 变异三条结果（预期 vs 实际）；
6. 提交 SHA。

---

## 背景事实（写卡时实测，`2026-10-24 19:0x`，每条都跑过命令）

- `rainbow-csv` 有 **24 条**命令，**24/24 有 title**，**22/24 有 category**；
- 命令 id 形如 `rainbow-csv.CSVLint`（大写）、`vscode-containers.compose.down`（多段点）；
- **本机全部扩展共 884 条命令，过 `LocalId` 的 0 条**；**过 `MODULE_CAPABILITY_SHORT_NAME` 的 0 条**；
- **27 个扩展是多命令**；单个扩展最多 **101 条**命令（远超 `MAX_COMMANDS = 64`）；
- `executeCommand` **没有任何生产调用方**（全仓 `apps/desktop/src/` 里只在本文件内）；
- `ModuleInvokeSchema` 是 `.strict()`，加字段要改 `packages/contracts/**`；
- `ModuleHost.prepareProgramBindings` 里 `extensionCapabilityShortName(contribution.capability)`
  只对 `module.<单段>` 形态返回短名，其余 `continue`（跳过注册）。
- `LocalId` 与 `MODULE_CAPABILITY_SHORT_NAME` 都定义在 `packages/contracts/src/modules.ts`
  （`:9` 和 `:62`），**两者都装不下任何一条真实命令 id**。
