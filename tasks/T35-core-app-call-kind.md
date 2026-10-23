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
