# F004｜清单层：从「只收 1 条命令」到能收下真实扩展

- Status: **done**（`a0ac9217` + `25072e3b`）
- Category: **P0 扩展主线**（VSIX 兼容第三步）
- Depends on: F002（DEFLATE）、F003（`package.json` 限额 64 KiB，真实清单已能读进来）
- Exclusive writable files:
  - `apps/desktop/src/main/modules/vscodeL1Bridge.ts`
  - `apps/desktop/scripts/vsix-manifest-schema-smoke/`（新建）
  - 本卡回写

## Required Skills
- `mcode-smoke`：schema 断言 + 变异。

---

## 现状：包能读进来了，但清单过不了

F003 之后 `rainbow-csv` 的 `package.json`（17 021 B、**24 条命令**）能**读出来**，但过不了清单校验：

```ts
// vscodeL1Bridge.ts:20-28
engines: z.object({ vscode: z.string().min(1).max(40) }).strict(),
activationEvents: z.array(z.string()).max(1).optional(),        // ← 只收 1 条
contributes: z.object({
  commands: z.tuple([z.object({ ... }).strict()]),              // ← 只收 1 条
}).strict(),                                                     // ← 拒一切多余字段
}).strict();
```

**三个 `.strict()` + `max(1)` + `z.tuple`** —— 真实扩展的清单几乎一定会撞上其中一个。

---

## 任务

### 一、`contributes.commands`：`z.tuple([...])` → 数组

**这是本卡的核心。** `z.tuple` 只接受**恰好 1 个**元素。改成 `z.array(...)`。

**但必须定一个大小的上限**（参考 F003 的做法：先查依据）。

**先查**：`git log -S "commands: z.tuple" --oneline`、`compat.md` §4、`tasks/archive/` 里 ARC-006 / MC-035。
**如果找不到依据，就明说「没有依据」并给一个基于实测的值**（rainbow-csv 是 24 条，给 64 条留余量）。

**不要静默地不设上限** —— 那是无界的攻击面（一个声称有 100 万条命令的清单会撑爆内存）。

### 二、`activationEvents`：`max(1)` → 放开

真实扩展声明多条 activationEvents（`onCommand:xxx`、`onLanguage:csv`、`workspaceContains:**/*.csv`）。

**但注意**：`activationEvents` 放开**不等于支持这些事件**。当前只支持 `onCommand:`（见文件里那段校验）。
**所以你只是让清单能过，运行时的激活仍需单独一张卡。**

**这一点必须写进注释** —— 否则下一个人会以为「清单过了 = 激活支持了」。

### 三、三个 `.strict()` 要分类处理，不能一刀切

| 位置 | 现状 | 建议 |
|---|---|---|
| 顶层 `.strict()` | 拒一切未声明字段 | **保留**。顶层未知字段是明确的错误信号 |
| `engines` `.strict()` | 只允许 `vscode` | **保留**。多出来的引擎声明我们不支持，静默忽略更糟 |
| `contributes` `.strict()` | 拒一切未声明贡献点 | **要动**。真实扩展有 `menus` / `configuration` / `languages` / `keybindings`… |

**`contributes` 的处理必须显式**：不认识的贡献点要么拒绝并**列出是哪个**，要么**接受但明确记录「未实现」**。

**不许静默丢弃** —— 用户装了个扩展，它的菜单项不见了，而他不知道为什么，那是最坏的一种。
**硬规矩 3：坏东西显式报出来，不静默跳过。**

### 四、错误信息要能区分「哪一条字段不行」

现在 zod 的默认报错会给出路径，但**要确认它带着字段名**。
如果被你的自定义校验吃掉，补上 —— F003 已经证明「说不清被哪道拒的」会让变异无法断言。

---

## 验收判据

1. **`rainbow-csv` 的清单能通过 schema 校验**（真实文件，24 条命令）；
2. **单命令的旧清单仍然能过**（正控：不能只为多命令而弄坏单命令）；
3. **空 `commands` 数组被拒**（负控：0 条命令的扩展是无效的）；
4. **超过上限的 `commands` 被拒，且错误信息说清上限是多少**（负控）；
5. **未知贡献点被显式处理**（拒绝并点名，或接受并记录）—— **有断言**；
6. 不跑全量、不起 Electron。

---

## 变异表（先写预期红几条，再跑）

| 变异 | 预期 |
|---|---|
| `commands` 改回 `z.tuple` | **1 条红**（rainbow-csv 过不了） |
| 去掉 `commands` 非空校验 | **1 条红**（空数组负控） |
| `contributes` 的未知字段改成静默丢弃 | **1 条红**（显式性那条） |
| 上限改成 `Number.MAX_SAFE_INTEGER` | **1 条红**（无界负控） |

---

## 边界

**只改**：
- `apps/desktop/src/main/modules/vscodeL1Bridge.ts`
- 新建 `apps/desktop/scripts/vsix-manifest-schema-smoke/`
- 本卡回写

**不碰**：
- `ModuleHost`；
- `packages/contracts/**`；
- `tasks/` 主目录与 `tasks/README.md`；
- **已完成的三张 F 卡**（F001/F002/F003）。

---

## 回写

1. `commands` 上限**有没有依据**，你定了多少、为什么；
2. `contributes` 未知字段你怎么处理的（拒绝点名 vs 接受记录），**为什么选那个**；
3. rainbow-csv 的 24 条命令**全部通过了吗**，贴一条实际解析结果；
4. 变异四条结果（预期 vs 实际）；
5. 提交 SHA。

---

## 结果回写

### 1. `commands` 上限：**没有依据**，定为 64

`git log -S "commands: z.tuple"` → **`68a7121c`**，和 4096 / 24576 是同一个提交，
**同样没依据**（那个提交信息是空的，见 F003 的查证记录）。

**定为 64**：实测最大真实值是 `rainbow-csv` 的 **24 条**，64 给它约 2.7 倍余量。
必须有上限 —— 一个声称 100 万条命令的清单会在解析时撑爆内存。

`activationEvents` 同样是 `68a7121c` 的 `max(1)`，一并放开到 **64**
（rainbow-csv 是 11 条）。

### 2. `contributes` 未知字段：**拒绝并点名**，不静默丢弃

**选拒绝的理由**：「接受但记录未实现」的体验更坏 —— 用户装成功了，右键菜单 /
补全 / 语法高亮全都不工作，而他不知道为什么。**拒绝时用户看到的是可行动的信息。**

错误信息同时说清**两件事**：

```
VSIX contributes unsupported section(s): menus, languages, grammars, keybindings.
This host supports only: commands.
```

（zod 原生的 `Unrecognized key(s) in object: 'keybindings'` 只说前者。）

**三个 `.strict()` 的分类处理**：

| 位置 | 处理 | 理由 |
|---|---|---|
| 顶层 | **保留** | 未知顶层字段是明确的错误信号 |
| `engines` | **保留** | 多声明 `node: ">=18"` 我们不支持，静默忽略会让用户以为按那个跑 |
| `contributes` | **改**（passthrough + 点名） | 真实扩展开有 9 个贡献点，只支持 commands |
| 命令项内 | **部分放宽** | `category` 接受（纯显示前缀），`icon`/`enablement` 仍拒 |

### 3. rainbow-csv 的 24 条命令**全部通过了吗**

**过了，但过程中发现一处我自己的判断失误。**

第一次跑 [7] 组，报 **22 条 issue 指向 commands** —— 查下去：真实扩展的 24 条命令里
**22 条带 `category` 字段**（`{"command": "...", "category": "Rainbow CSV", "title": "..."}`），
2 条不带。而我第一版的命令项 `.strict()` **拒绝了 `category`**。

**我上一处注释写着「命令项的 .strict() 刻意保留」，但没核实真实扩展上真的有额外字段。**
改成接受 `category`（它是显示前缀，VSIX 渲染成「Rainbow CSV: CSV Lint」，不新增能力），
`icon` / `enablement` 仍拒（那些不是纯显示，接受不实现会给错觉）。

改完的实测结果：

```
ok   ★ rainbow-csv 的清单**没有一条 issue 指向 commands**（24 条收下了）
ok   ★ 它有一条 issue 指向 main 路径 —— 那是另一个已知边界
     实际拒绝理由：[{"received":"./extension","code":"invalid_literal",
                    "expected":"./extension.js","path":["main"],...}]
```

**所以：24 条命令全部通过 schema，唯一的拒绝理由是 `main` 路径**
（`./extension` vs 要求的 `./extension.js`）—— 那是**另一张卡**的事，不在本卡范围。

### 4. 变异四条：预期 vs 实际

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 `commands` 改回 `z.tuple` | 红 2 条 | **红 4 条** |
| M2 去掉 `commands` 的 `.min(1)` | 红 1 条 | **红 0 条** → 修后 **红 1 条**（见 §5） |
| M3 `contributes` 未知字段改静默丢弃 | 红 3 条 | **红 4 条** |
| M4 上限改成 `Number.MAX_SAFE_INTEGER` | 红 1 条 | **红 2 条** |

### 5. ⚠️ M2 第一版 **0 条红** —— 断言测的「被拒」其实是崩溃

去掉 `.min(1)` 之后空数组**仍然被拒**，所以「空 commands 被拒」那条绿着。查下去：

```
A 被拒: TypeError: Cannot read properties of undefined (reading 'command')
```

**拒它的是 `pkg.contributes.commands[0]!.command` 的 TypeError，不是 schema 的校验。**
那是**崩溃**，不是「说清原因的拒绝」—— 而我的断言只验了「抛错」。

**改成**：要求错误信息点名 commands，**且不是 TypeError**：

```ts
!empty.ok
  && !/TypeError|Cannot read properties/.test(empty.error ?? "")
  && /commands/i.test(empty.error ?? "")
```

改完 M2 红 1 条，且红的是这条新断言。

（这是本仓库反复出现的形态：**「拒绝发生了」和「拒绝说清了原因」是两件事**。）

### 6. ⚠️ 另一处：`superRefine` 替换 `.strict()` 会**整个丢掉**未知键检查

第一版我把 `contributes` 的 `.strict()` 换成了 `.superRefine(...)`。
**`.superRefine` 返回 `ZodEffects`，加不上 `.strict()`** —— 于是未知键检查整个消失，
`keybindings` 被静默接受。

**`vscode-l1-smoke` 里那条「不支持的贡献点必须被拒」当场变红**（26/27），才发现的 ——
**那套老测试救了我一次。** 改成 `.passthrough().superRefine(...)`：passthrough 让未知键
保留在结果里（`.strict()` 会先剥掉，那时 superRefine 看不到），再由 superRefine 逐一点名。

### 7. 提交

`a0ac9217`（4 文件，+451/−8）。`tsc` exit 0。
四条变异全部红在正确位置，还原逐字节 `SAME (c6c747f4...)`。

**相关套件全绿**：`vsix-manifest-schema-smoke 17/17`、`vsix-deflate-smoke 24/24`、
`vsix-size-limits-smoke 21/21`、`vscode-l1-smoke 27/27`。

### 8. 给 F007（多命令支持）的现场数据

**`pkg.contributes.commands` 现在能被 schema 收下 1–64 条**（`MAX_COMMANDS = 64`），
每条含 `command` / `title` / 可选 `category`。

**`commandId` 被当成单值用的地方（`grep` 结果，共 6 处）**：

| 行 | 用法 |
|---|---|
| `:469` | `readonly commandId: string`（构造参数，类型是单值） |
| `:481` | `pkg.contributes.commands[0]!.command` —— **只取第一条** |
| `:483` | `commandId.startsWith(prefix)` 前缀校验 |
| `:488` | `activationEvents.includes("onCommand:" + commandId)` |
| `:515` | `program: { source: childProgram(source, commandId, ...) }` —— 传给子进程 |
| `:532` | **`if (commandId !== this.commandId) throw Error("Undeclared VS Code command")`** ← 硬编码单命令 |
| `:553` | `command === this.commandId ? command : null`（状态栏快照） |

**`:532` 是 F007 的核心** —— 那条 `!==` 就是「只支持一条命令」的机器表达。
要支持 24 条，得把它变成 `Set` 成员检查，并且 `:481` 取 `[0]` 的地方要改成遍历。

**另外提醒 F007 一件事**：`title` 现在只用了第一条（`:425` 附近），
多命令时**每条命令的 title 都要进 contributes**，否则菜单里只会显示一条 ——
这一点我在 `:481` 的注释里写了，但那是 schema 层，不是渲染层。

### 9. 觉得不对但没改的

1. **`main` 路径 `./extension` vs `./extension.js`** 是下一道墙（rainbow-csv 卡在这）。
   它不是本卡范围，但**它和多命令支持一样，都是「清单能过 ≠ 装得进」的一半**。
2. **`category` 我接受了但运行时没用它** —— 它只是显示前缀，而当前渲染层只显示 title。
   这不算「接受不实现」（因为不加它扩展根本过不了），但**用户不会看到那个前缀**。
3. **`extension-honesty-smoke` 现在有一条红**，原因是 `vsix-end-to-end-smoke/`（F005 的会话
   17:37 在写）被它的硬编码白名单判为「不该存在的套件」。**不是我的改动造成的**，
   也不在我的边界内。我跑它时是 15/16，那一条就是它。
