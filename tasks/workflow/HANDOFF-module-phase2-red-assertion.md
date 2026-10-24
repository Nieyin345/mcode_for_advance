# 交接给扩展主线：`module-phase2-e2e-smoke` 有一条恒红断言

> ## ✅ 已修（2026-10-24，扩展总控 `062e951a`）
>
> 修法与建议一致（改成禁令式 + 允许集合）。`create` 从 `exitCode 1 / 5 checks`
> 变成 **`exitCode 0 / 14 checks`**，`reopen` 8 checks。
>
> **它另外验出并记下了一条我没想到的**：如果只变异 `invokeForWorkflow`，
> **红的是更上面那条 `typeof === "undefined"`，不是新加的禁令**（窄 vs 宽，不是重复）。
> 用 `invokeAsAgent` 才验到禁令独立生效。**这个顺序写进了代码注释。**
>
> ---
>
> ## ⚠️ 本文件第二节曾写错，已更正
>
> 我原文转述 W4 的话：「`module-phase2-e2e-smoke` 从不注册 `workflowEngine` handler」。
> **这会让读者去产品代码里找一个不存在的 bug。**
>
> 扩展总控核清后的准确说法：
>
> ```
> apps/desktop/src/main/ipc/workflowEngine.ts:172
>   ipc.handle(IPC.WORKFLOW_ENGINE_LIST, onList);      ← 产品里有
> ```
>
> **是那个套件的 harness 只注册了 `registerModuleHandlers` + `registerWorkflowHandlers`
> （`native-main.ts:97-98`），没注册 workflowEngine 那一组。** 报错
> `No handler registered for 'workflowEngine:list'` 是 `AutomationRunner` 启动时打的，
> **不导致套件红**（修复后 exitCode 0），只是在日志里刷了几次。
>
> **这是「套件 harness 比产品少」，不是产品缺陷。** 我不修，但如果日志噪音值得治，
> 在那个 harness 里补注册即可 —— **别当成产品 bug 修。**
>
> **这条本身的教训**：我转述 W4 的观察时**没有自己核**就写进了交接文件。
> 「转述别人的发现时附上取证来源」是 CLAUDE.md 第十四条，我这次只附了「W4 说」，
> **没问「W4 是在什么范围取的证」**。

- **不属于工作流主线。** 记在这里是因为我的执行会话撞上了它，而**它会误伤每一个后来的人**。
- 发现者：W4 的执行会话（做实单文件回滚对照证明与它无关）；总控复核。
- 日期：2026-10-24 20:00

## 现象

```
module-phase2-e2e-smoke → 红，恒红
```

**不是偶发** —— 撤掉任何人的改动它都红在同一条上。

## 根因（我复核过）

`apps/desktop/scripts/module-phase2-e2e-smoke/native-main.ts:125`：

```ts
assert.deepEqual(
  await js("Object.keys(window.api.modules).sort()"),
  ["cancel", "catalog", "egressConsentGet", "egressConsentSet",
   "install", "invoke", "issueWorkflowGrant", "remove",
   "revokeWorkflowGrant", "setPermissions", "task", "tasks"]
);
```

**这份清单是写死的。** 而 F006（`901e58ee`）给 `window.api.modules` 加了 `installVsix`，
**没有更新这个数组**。于是 `Object.keys` 多一项，`deepEqual` 恒假。

## 为什么这条特别需要修

**它红的原因和它的名字说的东西无关。**

这条断言的标题是「real preload carries live catalog and exposes no workflow-only invocation」——
**它想验的是「`invokeForWorkflow` 不该出现在 preload 上」和「catalog 是真的」**。
`Object.keys` 那一行是顺手加的、防「多暴露了东西」。

**但它现在是恒红的，于是：**

1. **真正想验的两条（catalog 有内容、没有 `invokeForWorkflow`）被掩盖了**；
2. 每个跑到这里的会话都要花时间做单文件回滚对照，才能确认「不是我的」；
3. **下一个人会学会「这个套件红了不用管」** —— 那正是本仓库最怕的「假红教人忽略红」。

## 建议的修法（不是唯一解）

**两个方向，选一个：**

| 方向 | 做法 | 代价 |
|---|---|---|
| **A. 更新清单** | 把 `"installVsix"` 加进那个数组 | 一分钟后又会有人加新方法，同样恒红 |
| **B. 换判据** | 不再写死清单，改成**禁令式**：断言 `invokeForWorkflow` 不在里面，且每个 key 都在一份**允许集合**里（超集检查） | 一次改对 |

**我倾向 B，理由是它符合这条断言原本的意图** —— 它想防的是「多暴露了不该暴露的东西」，
不是「暴露的正好是这 12 个」。**用「不允许的」表达「不允许」，比用「正好等于」表达更耐久。**

**但这是扩展主线的判断，我不替你们定。**

## 还有一条（W4 顺带发现，我没核）

> `module-phase2-e2e-smoke` 从不注册 `workflowEngine` handler。

**如果你核实了这条，可能是同一个套件的第二个缺口。** 我没验过，只转述。

## 边界说明

**工作流主线不会改这个套件。** 它不在我们任何一张卡的写入边界里。
写这份交接是因为「有人撞上了、得说一声」，不是「我们要修」。

如果你们决定不修（比如认为它本来就该红），**请在那条断言旁边写一句为什么** ——
否则下一个人还要再花二十分钟做一次回滚对照。
