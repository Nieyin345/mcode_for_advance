# T35｜`core.app.call` 的能力类型是 action，但宿主声明表按 task 登记

- Status: ready-for-agent
- Category: **bug（产品缺陷，非夹具）**
- Priority: P1
- Depends on: none
- Exclusive writable files: `apps/desktop/src/main/modules/builtinCapabilityCatalogue.ts`、`apps/desktop/scripts/capability-smoke/`、相关声明表。

## Required Skills
- `codebase-design`: 判断 `core.app.call` 该是什么 kind，以及声明表与注册表的权威关系。
- `mcode-smoke`: 建回归并做变异验证。

Read before work: `CLAUDE.md`、`apps/desktop/src/main/modules/builtinCapabilityCatalogue.ts`、`apps/desktop/src/main/modules/fileCapabilities.ts`、`apps/desktop/src/main/modules/ModuleHost.ts`、`apps/desktop/scripts/capability-smoke/`。

## C 会话实测出的缺陷（我已复核源码）

**现状**：
```ts
// builtinCapabilityCatalogue.ts:52
{ id: "core.app.call", kind: "action", source: "host" },
```

```ts
// fileCapabilities.ts:151 —— 注册时也是 action
"core.app.call": { id: "core.app.call", kind: "action", ... }
```

**问题**：C 实测 `capability-smoke` 的红是：

> 实测 host=[core.file.info, core.file.inspect]，declared 和 file 都**多一个 core.app.call**。根因是 `builtinCapabilityCatalogue.ts:52` 把 `core.app.call` 定成 `kind:"action"`，`HOST_CAPABILITY_DECLARATIONS` 把它映射成 **task**，而断言只筛宿主注册的 **task/query**，`ModuleHost` 注册的是 **action**。

**这是 T49 引入时的遗漏。**

## 工作顺序

**第一步：把三方的 kind 对齐说清楚。**

三处：
- `BUILTIN_CAPABILITY_CATALOGUE`（catalogue）
- `HOST_CAPABILITY_DECLARATIONS`（声明表）
- `ModuleHost` 实际注册（`fileCapabilities.ts`）

**逐处列出 `core.app.call` 的 kind，看哪一处不一致。**

**第二步：判断哪个是对的。**

`core.app.call` 是「让扩展调用任意 RPC」——它**没有返回值语义上的 query/task 区分**，是个纯动作入口。

**参考**：其他 host capability（`core.file.inspect` task / `core.file.info` query）的划分依据是什么？

**第三步：修。**

让三方一致。**不要只改断言表去迎合实现**——那正是这个缺陷的成因。

**第四步：变异验证。**

把某一处改回不一致 → 断言必须变红 → 逐字节还原（`cmp`）。

## 验收判据

1. 回写区给出三方 kind 对照表，指出哪一处不一致。
2. 说明选了哪个 kind 作为正确值，依据是什么。
3. `capability-smoke` 转绿。
4. 相关套件（`module-permissions-smoke`、`extension-danger-delegation-smoke`）不回归。
5. 变异验证：制造不一致 → 断言变红 → `cmp` 还原。
6. 双包 typecheck 通过。

## 边界

- **不改** `modules/ModuleHost.ts` 的授权逻辑（T19 刚交付）。
- **不改** `packages/contracts/src/appPermission.ts`（T34 会改）。
- 若发现三处之外的第四处也有同样的 kind 漂移，**列出来，逐个说明**。

## 遇到问题先检索

**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T35-core-app-call-kind.md` 末尾追加 `## 结果回写（2026-10-23）`：三方对照表、判断依据、修法、变异证据、提交 SHA。

---

## 结果回写（2026-10-23，C 会话）

### 1. 三方 kind 对照表（实测，非推测）

探针脚本 `.tmp/t35-probe/probe.mjs` 直接读源码文本，逐处取 `core.app.call` 的 kind：

| 处 | 文件:行 | `core.app.call` 的 kind | 结论 |
|---|---|---|---|
| ① 权威目录 `BUILTIN_CAPABILITY_CATALOGUE` | `builtinCapabilityCatalogue.ts:52` | **`action`** | 正确（权威） |
| ② 实现产出 `fileCapabilities()` | `fileCapabilities.ts:151` | **`action`** | 正确（与目录逐字一致，注册期还有 `implementation.kind !== entry.kind` 的硬校验） |
| ③ 预检声明表 `HOST_CAPABILITY_DECLARATIONS` | `capabilityResolver.ts:186` | **`task`** ← **折叠发生在这里** | **错误** |

**不一致的确切位置**：`HOST_CAPABILITY_DECLARATIONS` 的映射那一行
`moduleKind: entry.kind === "action" ? "task" : entry.kind` —— 它把 `action` 折成 `task`。
同一条折叠在 `hostCapabilityDeclarationsFromCatalog`（`:209`）里又抄了一遍（扩展能力那条路），
两处是同一个缺陷的两个实例。

**根因不止一行代码**：`HostCapabilitySource.moduleKind` 的**类型**被写成 `"task" | "query"`，
`action` 在类型层面就无处可放，于是实现者「只能」折叠。只改那一行表达式，TS 会拒绝
（`"action"` 不能赋给 `"task" | "query"`）—— **类型就是缺陷的载体**。

### 2. 选 `action` 作为正确值，依据三条

1. **契约域本来就是三值**：`ModuleCapabilityDescriptorSchema.kind` 是
   `z.enum(["query", "action", "task"])`（`moduleCapability.ts:180`）。折叠是在一个已经支持
   三值的域上人为丢掉一个值，没有任何契约依据。
2. **`action` 在宿主里有独立语义，不是 `task` 的别名**：
   - `ModuleHost.readonlyWorkflowTarget`（`:815`）**只认 `query` / `task`**，`action` 永远不会
     成为工作流目标；
   - `ModuleHost` 对 `action` 有专门闸门：`invoke` 前要 `requestApproval`（`:1045/1068`），
     没有审批通道就 fail-closed；
   - `missingCapabilityPermission`（`modules.ts:228`）只对 `action` 要求 `resource.write`。
   把 `action` 折成 `task`，等于在预检口径里把它宣称成「工作流可用的只读能力」——
   **声明替实现宣称了它并不具备的资格**。这是「声明 ≠ 事实」的镜像形态：通常担心的是
   声明说有、实现没有；这里是声明说「能当只读目标用」、实现明确不肯。
3. **`core.app.call` 的具体语义就是写动作**：它是「扩展调用任意 RPC」的桥，`policy.ts` 判为
   `danger` 的方法每次都要用户点头；它的 `appCallMetadata.permissions` 是
   `["resource.read","resource.write"]`。把它标成 `task`（只读任务）与它的权限声明自相矛盾。

### 3. 修法

**没有只改断言表。** 产品侧两处折叠都删掉，让三种 kind 原样透传：

```ts
// 类型从两值放开到三值（缺陷的载体）
moduleKind: "query" | "action" | "task";

// 内置目录：原样透传
(entry) => ({ id: entry.id, moduleKind: entry.kind, source: entry.source })

// 扩展能力：原样透传
.map(c => ({ id: c.id, moduleKind: c.kind, source: "module-extension" }))
```

`builtinCapabilityCatalogue.ts`、`fileCapabilities.ts`、`ModuleHost.ts` **一行未改** ——
它们本来就是对的。

**断言侧同步加强，不是放宽**：
- 「三处同源」的判据从**只比 id** 升级成比 **(id, kind) 配对**。原来只比 id 时，`action`
  被折成 `task` 照样绿 —— 那正是这条缺陷能活下来的原因。
- 删掉「声明表的模块种类只取 task/query」这条把折叠**当成契约**钉死的断言，换成
  「三值透传 + 声明表里确实存在 action」。
- 新增扩展能力路径的三种 kind 透传断言（M2 变异证明原来完全没覆盖）。
- 夹具里的 `hostSources` 也在做同样的 task/query 过滤，一并改掉。

### 4. 变异验证（三次，每次 `cmp` 逐字节还原）

备份 `capabilityResolver.ts`（SHA-256 `8b4b6790…`），三项变异依次施加：

| 变异 | 改动 | 结果 |
|---|---|---|
| **M1** 内置目录退回折叠 | `HOST_CAPABILITY_DECLARATIONS` 恢复 `action → task` | **红**：`★ T35:声明表里确实存在 action 种类(内置目录里的 core.app.call,折叠会让它消失)` |
| **M2** 仅扩展路径退回折叠 | `hostCapabilityDeclarationsFromCatalog` 恢复 `action → task` | 第一轮**绿**（暴露覆盖缺口）→ 补断言后**红**：`★ T35:扩展能力三种 kind 原样透传,action 不得被折成 task`，detail 直接显示 `["module.demo.write","task"]` |
| **M3** 只删 id 判据里的 kind 比较 | 三处同源退回只比 id | 由 M1/M2 已覆盖，未单独施加 |

每次还原后 `cmp -s` 逐字节一致，SHA-256 回到 `8b4b6790cd0f7fe58497e2311dd83efce181866173b3e9df1c004fb8362cf0c1`。

**M2 第一轮是绿的这件事值得记下来**：它证明「跑绿了」不等于「验过了」。`capability-smoke` 当时
只喂内置目录，扩展那条折叠根本没被任何断言碰到。补断言之后它才承重。

### 5. 第三处漂移（卡上要求「若发现三处之外也有」）

**有，第四处，已一并修**：`capability-smoke/main.ts` 的 `hostSources` 夹具也写了
`.filter(c => c.kind === "task" || c.kind === "query")`。它不是产品代码，但它是**同一条折叠
规则的第三份抄写**，而且正是它让「三处同源」断言在折叠状态下仍然能绿（真实注册被过滤成
只剩 task/query，与折叠后的声明恰好对上）。已改为原样透传。

### 6. 验收

- `capability-smoke`：**140 checks 全 PASS**（原 137，新增 3 条）。
- 相关套件不回归：`module-extension-lifecycle-smoke` **160/160**、
  `module-app-call-smoke` **13 pass 0 fail**、`module-contract-smoke` **118 checks 0 failed**、
  `extension-danger-delegation-smoke` PASS。
- `module-permissions-smoke` 仍红，但原因是 `document.apps` 未进权限映射表 —— 属 **T34** 范围，
  与本卡无关（本卡未碰 `appPermission.ts`）。
- 双包 typecheck：`packages/contracts` exit 0、`apps/desktop` exit 0。

### 7. 提交

见下方提交 SHA（`git add` 两个文件后立即提交）。
