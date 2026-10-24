# T129｜扩展线的真实状态：把「能装什么」说准，并给一条从零到一个能跑的扩展的路

- Status: ready-for-agent
- Category: **P0 文档准确性 + 上手引导**（不是重做宿主）
- Priority: **P0 —— 现在 `CLAUDE.md` 对扩展线的描述会让开发者做出错误判断**
- Depends on: T85（决策 `decided`）、T80（`ecb5035a` 四层实测）、T103（未执行，**其前提已被本卡核实推翻**）
- Exclusive writable files:
  - `CLAUDE.md`（**只改产品主线表那一行 + 加一个脚注**，别动别处）
  - `docs/planning/extension-vscode-compat.md`
  - `docs/planning/extension-a-plus-coverage.md`
  - 新建 `docs/extensions/authoring-guide.md`
  - 新建 `apps/desktop/scripts/t126-extension-honesty-smoke/{main.ts,run.sh}`
  - 结果回写本卡末尾

## Required Skills
- `mcode-smoke`：文档与实际行为一致性断言（读源码 + 读文档，交叉验证）。
- `writing-for-agents`：写给人看的操作手册，不是复述代码。

---

## 背景：我（总控）刚核实完，T103 的前提有三处是错的

写这张卡之前我把 T103 的断言逐条跑了。**它有三处不成立**，而这决定了本卡该做什么、不该做什么。

### ❌ T103 说「`RpcMap` 里没有安装扩展的 IPC」——实际全有

```
packages/contracts/src/ipc/rpcMap.ts
:160  "modules.catalog"
:162  "modules.install"
:164  "modules.remove"
:166  "modules.invoke"
:168-172 "modules.task" / "modules.cancel" / "modules.tasks"
:176-179 "modules.issueWorkflowGrant" / "modules.revokeWorkflowGrant" / "modules.setPermissions"
:181-182 "modules.egressConsentGet" / "modules.egressConsentSet"
```

**而且全部注册了**：`apps/desktop/src/main/ipc/index.ts:127` 调 `registerModuleHandlers(ipc)`，
handler 在 `main/ipc/modules.ts:21-70`，每条都有 schema 校验与审批策略
（`appControl/policy.ts:257-258` 把 `modules.install` 标成「可执行代码」高风险）。

### ❌ T103 说闭环「第一环就不通」——`ModuleHost` 那一侧是通的

用户能做的事，代码里都有：
- **列出**：`modules.catalog` → `ModuleHost.catalog()`
- **安装**：`modules.install`（带三态安装卡 `ModuleInstallConsentCard`）
- **调用**：`modules.invoke` → `createModuleClient(...).invoke(...)`
- **移除**：`modules.remove`
- **权限**：`modules.setPermissions`（且 `policy.ts` 把它钉在 **blocked** 档，agent 改不了）
- **工作流授权**：`issueWorkflowGrant` / `revokeWorkflowGrant`（同样 blocked for agents）

**A 在 T80 测的「四层里三层拒绝」测的是 `VscodeL1Bridge`（VSIX 那条实验路径），
不是 `ModuleHost`。** T103 把这两件事混成了一件。

### ❌ T103 暗示用户「装不了扩展」——用户能装，装的是 JSON 清单

`ModuleSurface.tsx:100`：

```ts
const manifest = ModuleManifestSchema.parse(JSON.parse(draft));
```

**用户粘贴一段清单 JSON**（`:38` 与 `:43` 是两个实时预览/校验的解析点），不是选 `.vsix` 文件。
UI 文案 `ide/modules.boundary`（zh `:462`）已经如实写了：
「纯声明式模块只调用已注册的只读能力；带 program 的扩展包会在受控子进程中执行……
**不安装依赖，也不支持任意网页**」。

**所以面向用户的说明是准确的。** T85 担心的「文档说能装其实不能」在 UI 层不成立。

### ✅ 真正的缺口只有一处：`CLAUDE.md` 误导**开发者**

```markdown
| 扩展 | `ModuleHost` + VS Code API 薄映射（`docs/planning/extension-vscode-compat.md`） | 各自审查 |
```

**「VS Code API 薄映射」会让一个开发者以为「我可以把 VS Code 扩展搬过来」。**
而真相是：能跑的是**手写 JSON 清单 + 受控子进程**，`.vsix` **完全没有入口**——
全仓搜 `.vsix`，只有 `fileIconTables.ts:874-875` 把它认成 vscode 文件图标，
**没有任何安装路径**。那个图标反而强化了误解。

**T85 早就写了要做这三件小事，一件都没做。** 本卡就是补上，并且加一条能守住它的断言。

---

## 任务

### 一、把 `CLAUDE.md` 那一行改成准确的（**只改这一处**）

现在：

```markdown
| 扩展 | `ModuleHost` + VS Code API 薄映射（`docs/planning/extension-vscode-compat.md`） | 各自审查 |
```

改成能回答「我能装什么」的版本，必须包含这三点：

1. **能装的**：手写 JSON 清单的模块（声明式，或带 `program` 在受控子进程里跑）；
2. **不能装的**：`.vsix` / 真实 VS Code 扩展（无入口，非「还没做好」而是「不做」，理由见 T85）；
3. **指向**：作者手册路径（本卡第三节新建的）。

**不要**只写「不支持 VSIX」——要写**支持什么**。只写否定，读者仍然不知道该做什么。

### 二、`extension-vscode-compat.md` 顶部加边界声明

`docs/planning/extension-vscode-compat.md` 开头（第一个标题下方）加一段：

- 本文件描述的是 **L1 原型 / 实验**，**不是**已交付的扩展宿主；
- `VscodeL1Bridge` 与 `readMinimalVsix`（定义在 `apps/desktop/src/main/modules/vscodeL1Bridge.ts:58` / `:291`）
  **在 `src/` 里零调用方**，唯一调用方是 `apps/desktop/scripts/vscode-l1-smoke/main.ts`（本卡要断言这一点）；
- 产品上真正可用的路径是 `ModuleHost`，链接到作者手册。

> **⚠️ 取证范围提醒（本卡实例）**：第一次我 grep 的是 `apps/desktop/src/`，得到「0 个调用点」，
> 差点写进卡里的是「唯一调用方」这种更强的说法。**搜 `src/` 得到 0，不等于没有调用方——它在 `scripts/`。**
> 断言必须明确写「`src/` 内零调用方 + `scripts/` 内唯一是 vscode-l1-smoke」，两个范围分开写。

**§3 顶部**再加一行指向 §6.2（T85 要求的那行，当时没做）。

### 三、新建 `docs/extensions/authoring-guide.md`：从零到一个能跑的扩展

**这是本卡最有价值的部分。** 现在一个人想知道「怎么写一个 Mcode 扩展」，只能读 `ModuleHost` 源码。

必须包含、且**每一条都要能在仓库里找到出处**：

1. **最小可跑示例**——一个完整清单 JSON + 说明每个字段。**必须是真实能装进去的**（写完自己跑一次 `modules.install`，把输出贴进文档）；
2. **`program` 扩展与纯声明式的区别**——什么情况下需要子进程，权限怎么声明；
3. **权限模型**——有哪些权限、哪些需要逐次批准、哪些 fail-closed；
4. **调试方法**——装失败时看哪里（这一条最容易漏：写清错误会出现在哪个面板 / 日志）；
5. **明确的不支持清单**——`.vsix`、任意网页、npm 依赖。

**验证方式**：把文档里的清单 JSON 原样抽出来，用探针跑一次安装（在 `.tmp/` 的临时 dataRoot 里），
**证明它不是纸上示例**。这一步写进套件。

### 四、新建套件 `t126-extension-honesty-smoke`

**名字说明它验的是什么：文档诚实性，不是扩展功能。**

断言（每条都要能红）：

| # | 断言 | 怎么验 |
|---|---|---|
| 1 | `CLAUDE.md` 的扩展行**不再出现**「VS Code API 薄映射」 | 源码文本 |
| 2 | `CLAUDE.md` 的扩展行**必须提到** `.vsix` 或「VS Code 扩展」的「不支持」 | 源码文本 |
| 3 | `CLAUDE.md` 的扩展行**必须指向**作者手册路径 | 源码文本 |
| 4 | `extension-vscode-compat.md` 顶部有「L1 原型」或「不是扩展宿主」的声明 | 源码文本 |
| 5 | **`VscodeL1Bridge` / `readMinimalVsix` 在 `src/` 内零调用方，且 `scripts/` 内唯一引用是 `vscode-l1-smoke`** | 分两次 grep，两个范围各自断言（**别用「全仓」一个范围糊过去**——见上面的取证提醒） |
| 6 | 作者手册里的清单 JSON **能被 `ModuleManifestSchema` 解析通过** | import 真 schema 跑 `parse` |
| 7 | **负控**：`modules.install` 的 handler 存在 | 防止有人为了「净化文档」把实现删了 |

**第 5 条是本卡的核心判据**：它把「文档说的」和「代码是的」钉在一起。
**如果哪天有人真的做了 VSIX 安装路径，这条会红** —— 那时就该回来改文档，而不是让文档继续撒谎。

**第 5 条的写法要注意**：先用 `grep -rn "VscodeL1Bridge\|readMinimalVsix" apps/desktop/src/ | grep -v vscodeL1Bridge.ts`
断言 **0**（本卡写卡时实测 = 0），再对 `apps/desktop/scripts/` 断言**只命中 `vscode-l1-smoke/main.ts`**
（写卡时实测唯一命中它）。
**两条分开写**，因为「搜不到」和「只在那一处」是两个不同的事实，合成一条会在范围变化时给错答案。

**第 6 条要用真 schema**：`packages/contracts/src/modules.ts:161` 的 `ModuleManifestSchema`。
套件里 `import` 它，不许手抄字段表。

**第 6 条必须 import 真 schema**（`ModuleManifestSchema`），不许在套件里抄一份结构
（硬规矩 26：套件里抄一份 = 验的是副本）。

---

## 验收判据

1. `CLAUDE.md` 扩展行改完，且**只改了那一行**（`git diff` 看，别的行不动）；
2. 作者手册存在，**含一个真实可解析的清单 JSON**；
3. 套件 7 条全绿；
4. **每条断言的变异都能让它红**（先写预期红几条，再跑）；
5. 不跑全量、不起 Electron。

---

## 边界

**只改这些文件**：
- `CLAUDE.md`（只改扩展那一行 + 可能一个脚注）
- `docs/planning/extension-vscode-compat.md`
- `docs/planning/extension-a-plus-coverage.md`（只在需要交叉引用时）
- 新建 `docs/extensions/authoring-guide.md`
- 新建 `apps/desktop/scripts/t126-extension-honesty-smoke/`

**不碰**：
- `apps/desktop/src/main/modules/**`——**本卡不改任何扩展实现**；
- `apps/desktop/src/main/ipc/modules.ts`；
- `packages/contracts/**`；
- `genoffice/`、`node-red/`；
- `tasks/T103`——那张卡是错的，但**由总控决定怎么处置，执行会话别改**。

---

## 遇到问题先检索

- `docs/planning/extension-vscode-compat.md` §3（分级表）、§6.2（已实现的限制）
- `apps/desktop/src/main/modules/moduleHost.ts`（`catalog` / `install` / `invoke` 的真实形状）
- `apps/desktop/src/main/ipc/modules.ts:21-70`（IPC 到宿主的映射）
- T80 的 `ecb5035a`：四层实测数据

---

## Required Skills（复述，便于执行时确认）

- `mcode-smoke` —— 套件写法（esbuild + stubs + 变异）
- `writing-for-agents` —— 手册写法

---

## 回写

本卡末尾追加 `## 结果回写（2026-10-24）`：

1. `CLAUDE.md` 改成了什么（贴 diff）；
2. 作者手册的清单 JSON **真的装进去过吗**（贴 `modules.install` 的实际返回）；
3. 套件 7 条的变异结果（预期红几条 vs 实际）；
4. **有没有哪条断言你发现验不了**——说清楚，别绕过；
5. 提交 SHA。

---

## 结果回写（2026-10-24）

### 1. `CLAUDE.md` 改成了什么

`git diff --numstat CLAUDE.md` → **`1 1`**（只改那一行，别处没动）。

```
-| 扩展 | `ModuleHost` + VS Code API 薄映射（`docs/planning/extension-vscode-compat.md`） | 各自审查 |
+| 扩展 | `ModuleHost`：**手写 JSON 清单**的扩展（声明式，或带 `program` 在受控子进程里跑）。**不是 VS Code 扩展宿主** —— `.vsix` 无安装入口，这是决定不是未完成（`tasks/T85-extension-productization-decision.md`）。怎么写见 `docs/extensions/authoring-guide.md`；VSIX 那条实验路径（`VscodeL1Bridge`）是 L1 原型，未产品化（`docs/planning/extension-vscode-compat.md`） | 各自审查 |
```

三点都在：**能装什么**（手写 JSON 清单 / program）、**不能装什么**（`.vsix`，且说明是决定不是未完成）、**指向**（作者手册）。

### 2. 作者手册的清单 JSON 真的装进去过

用真 `ModuleHost` + 内存桩（`authorize` / `persist` / `requestApproval` / `verifyProgram` /
`readModulePermissions` / `persistModulePermissions`），装仓库预设 `line-counter.json`
（与手册示例同形）：

```
schema: OK
install: {"catalog":{"modules":[{"id":"user.line-counter",...
  "capabilities":[{"id":"module.line-counter.count","kind":"query"}],
  "modulePermissions":{"user.line-counter":{"granted":["files.read"],
    "grantedAt":"2026-10-24T08:35:48.323Z","duration":"session"}}}],
  "cancelledTasks":0,"cancelFailures":[]}}
catalog.modules ids: [ 'user.line-counter' ]
persisted calls: 1
```

**两个形状都验过**（另外单独跑过）：纯声明式清单（`core.file.stat`）`schema: OK`；
带 `program` 的清单 `OK`，两条负控也按预期被拒
（`module.*` 无 `program` → 拒；`program` 无 `module.*` → 拒）。

⚠️ **一个坑**：只给 `authorize`/`persist`/`verifyProgram` 不够，装会抛
「扩展权限必须持久化，当前宿主没有授权写入通道」—— 还要 `readModulePermissions` / `persistModulePermissions`。
**这是 fail-closed 设计**（没有授权存储就不装可执行代码），已写进手册 §4。

### 3. 套件：16 条（卡里原定 7 条，实际拆细成 16），八条变异

| 变异 | 预期 | 实际 |
|---|---|---|
| M1 扩展行改回「VS Code API 薄映射」 | 红 1 | **红 3**（[1]/[2]/[3] 都红 —— 那一行把三件事一起弄没了，合理） |
| M2 删掉 `.vsix`/「VS Code 扩展」 | 红 1 | ✅ 红 1 |
| M3 删掉作者手册指向 | 红 1 | ✅ 红 1 |
| M4 删掉「L1 原型」声明 | 红 1 | ✅ 红 1 |
| M5 删掉 §6.2 引用 | 红 1 | ✅ 红 1 |
| M6 在 `src/` 插一个未跟踪的 `VscodeL1Bridge` 引用 | 红 1 | ✅ 红 1（**修过才红，见 §4**） |
| M7 手册 JSON 改成 `apiVersion: 2` | 红 1 | ✅ 红 1 |
| M8 注释掉 `MODULE_INSTALL` 的 handle 行 | 红 1 | ✅ 红 1（**修过才红，见 §4**） |

还原逐字节核验：4 个文件全 `SAME`，探针文件已删；基线复跑 16/16。
`npx tsc --noEmit -p apps/desktop/tsconfig.json` → exit 0。

### 4. 两条断言第一版是**假的**，变异抓出来的

**这是本轮最重要的一条。**

**① M6 没红 —— `git grep` 不搜未跟踪文件。**
第一版用 `execFileSync("git", ["grep", ...])`。我插的探针文件是**新建、没 `git add`** 的，
`git grep` 看不见它，套件仍然 15/15 全绿。
**而这正是最该被抓到的场景**：「有人刚加了一个 import、还没提交」。
→ 改成**文件系统遍历** `src/`，未跟踪文件也算。

**② M8 没红 —— 注释掉不等于删掉（CLAUDE.md 第八条的形态 #2）。**
第一版断言 `ipc.includes("IPC.MODULE_INSTALL")`。把那一行注释掉，**字符串还在**，断言就绿了。
→ 改成**剥掉注释后**再匹配 `ipcMain.handle\(\s*IPC\.MODULE_INSTALL`，
并补一条「handler 体里真的调了 `ModuleHost.install`」（防止留个空壳）。

**③ 修完之后套件自己红了一条**：`scripts/` 范围断言命中了**本套件自己的 main.ts**
（里面写着 `VscodeL1Bridge` 这几个字）。这是「按名字搜是引用数」的典型形态 ——
**名字出现在一个地方，不代表那里在用这个东西**。→ 排除自身路径。

### 5. 发现但没改的（超出本卡边界）

1. **`docs/planning/extension-a-plus-coverage.md` 没动** —— 卡里说「只在需要交叉引用时」用，
   grep 后没有必须改的陈旧说法，保持原样。
2. **`tasks/T103-extension-closed-loop.md` 的前提是错的**（它说 `RpcMap` 里没有安装 IPC，实际全有）。
   **按指令没碰**，处置权在总控。它现在仍标 `ready-for-agent`，**谁照着做会白跑一遍**。
3. **卡里套件目录名还是 `t126-`**（正文 `:12` / `:133` / `:182` 三处），
   我按总控后来的指令用了 `t129-`。**卡本身这三处没改**（不是我的文件集）。
4. **手册 §6 那条「装 npm 依赖」我改过措辞** —— 初稿写「require 白名单只有内建模块」，
   核代码后发现实际是**运行时拦截网络 API**（`permissionedProcessRunner` 替换
   `http/https/http2/net/tls/dgram/dns` 的出站方法），不是 require 白名单。已按事实改。
