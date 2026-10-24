# T148 — `apiCatalog.generated.ts` 过期：三个提交改了契约，没人重跑生成脚本

**Status**：`ready-for-agent`（**档位问题已由扩展线实测澄清，见 §四**）
**Category**：生成物 / 安全门禁
**发现者**：T145 的执行会话（它在跑 283 套实跑时撞到 `app-control-smoke` 红）
**写卡时间**：2026-10-24 21:35。**§四 已于 21:40 由扩展线实测更正。**

## 一、症状

`app-control-smoke` 在 T145 之前就是红的：

```
✗ ★ 功能清单与 RpcMap 逐条对齐（差一条 agent 就看不见它的说明）
  — {"missing":["modules.installVsix"],"extra":[],"hint":"跑一次 node scripts/gen-app-api-catalog.mjs"}
581/582 通过
```

**而它给了一行可执行的修法**。我跑了：

```bash
cd apps/desktop && node scripts/gen-app-api-catalog.mjs
# → wrote 459 entries
```

**门禁变绿：582/582，EXIT=0。**

## 二、但 diff 不是「只有一条」

```
apps/desktop/src/main/appControl/apiCatalog.generated.ts | 120 +++++-----
1 file changed, 64 insertions(+), 56 deletions(-)
```

**里面是四个独立的契约变化，全部是「代码已改、生成物没跟」：**

| 变化 | 来源提交 | 性质 |
|---|---|---|
| `modules.installVsix` 新增 | 扩展线（最近） | **新增方法** |
| `task.*` 的 approval output 加 `unrestorable` | **T125**（`9821e69c`） | 加字段 |
| `genoffice.describe` 的 route 加 `'editor-only'` | **T43**（`0a2aa805`） | 加枚举值 |
| `documentView.create` 的 editor 加 `'sheets'` | — | 加枚举值 |

**生成物最后一次更新是 `a6f9e1a6`（T109）。之后的三个提交都没重跑。**

## 三、⚠️ 这不只是「agent 的说明过期」

`apiCatalog.generated.ts` 有两个消费者：

### 1. `guide.ts` —— 给 agent 看的域清单（文档性质）

### 2. `channelIdempotency.ts:113` —— **运行时**

```ts
export function methodForChannel(channel: string): string | null {
  for (const e of API_CATALOG) {
    if (e.channel === channel) return e.method;
  }
  return null;   // ← 找不到 = 「视为无副作用，幂等守卫不介入」
}
```

**注释原文**：

> 找不到（渲染端专用通道 / 新加未生成）→ **视为无副作用，幂等守卫不介入**
> —— 误把只读当写会让每次重试都 fsync 整库。

**所以 `modules:installVsix` 在生成物更新之前，幂等守卫对它是不生效的。** 重试会重复安装扩展。

**这不是文档问题，是运行时缺口。**

## 四、⚠️ 我判错了：`installVsix` **已经是 `danger` 档**（扩展线实测更正）

### 我原来写的（错）

```
1. BLOCKED 表？     → 否
2. CREDENTIAL_BEARING？→ 否
3. DANGER 表？      → 否     ← ★ 这一步错了
...
6. → 兜底 "write"
```

**我据此在卡上和给用户的消息里写了「`installVsix` 是 `write` 档」。**

### 扩展线实测的结果

它把 `policy.ts` 用 tsc 转译后**直接调 `policyFor`**：

```
modules.installVsix      {"level":"danger","reason":"从 .vsix 安装 VS Code 扩展(可执行代码)"}
modules.install          {"level":"danger","reason":"安装扩展模块(可执行代码)"}
modules.setPermissions   {"level":"blocked",...}
```

### 根因：我读到了 `installVsix`，但没看它在哪张表里

```bash
$ grep -n "installVsix" apps/desktop/src/main/appControl/policy.ts
257:  "modules.install": "安装扩展模块(可执行代码)",
258:  // 【F006】从 .vsix 装真实 VS Code 扩展 —— 与 `modules.install` **同档**：
261:  "modules.installVsix": "从 .vsix 安装 VS Code 扩展(可执行代码)",
```

**而 `DANGER` 表从 `:204` 到 `:342`。`257` 和 `261` 都在里面。**

**我 grep 到 `installVsix` 有定义，就跳过了「它在哪个表的范围内」这一步。**

**这正是 CLAUDE.md 第二十九条「表存在 ≠ 表是这个用途」** —— 而我当天已经在写那条规矩了。
**同一个形态，第三次。**

### 所以：**不需要改 `policy.ts`**

档位维持 `danger`（每次都要用户本人批，受限授权不能替代）。**这一条从本卡划掉。**

### 但那条「没有幂等守卫」是真的，而且比我说的更深

**扩展线补的一点（我没查到）：**

```ts
// VsixInstallSection.tsx:41
await api.modules.installVsix({ path, confirmReadAccess: true,
  confirmExecutableCode: true, installConsent: "allow-once" })
```

**没有 `operationId`。** 而 `dbGuardedIpc.ts:144` 是 `if (operationId !== null)` 才进幂等分支。

**所以真正的位置是：渲染端根本没传幂等键，`methodForChannel` 修不修都不影响这条路径。**

**现状**：UI 的 `disabled={busy}` 挡住了连点，**但「一次网络/超时失败后用户重试」没兜住 —— 那是真的再装一次。**

### 根因在 `smokes-for.sh`，不在生成物

**扩展线查的，我没想到：**

```bash
$ bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/ipc/rpcMap.ts
⚠️ 没有套件覆盖它 —— 改这里没有回归网。

$ bash apps/desktop/scripts/smokes-for.sh src/main/appControl/apiCatalog.generated.ts
必跑（1–2 跳，14 套）
```

**改「症状文件」有 14 套守着，改「根因文件」得到一句放行。**
**而加 RPC 的人动的一定是 `rpcMap.ts`。**

机制：`app-control-smoke/main.ts:774` 用 `readFileSync` 读 `rpcMap.ts` 的**文本**，不是 `import` 它。
`smokes-for.py` 的依赖图只走 import，**所以这条依赖它看不见**。

### 附带：`smokes-for.sh` 对 `packages/contracts` 的路径会崩

```bash
$ bash apps/desktop/scripts/smokes-for.sh packages/contracts/src/modules.ts
# → Python traceback（smokes-for.py:417 的 p.relative_to(DESKTOP)）
```

**现在这个工具对 `packages/contracts` 的答复是「要么没有覆盖，要么直接崩」—— 都不能用。**
→ 已开 `tasks/T150`。

## 五、我做了什么

**只做了一件事**：跑生成脚本，提交生成物。

- **没有改 `policy.ts`**
- **没有改 `rpcMap.ts`**
- **没有改 `channelIdempotency.ts`**

**生成物本身是必然要更新的** —— 它是过期了，不是设计如此。

## 六、需要决定的两件事

### 1. `modules.installVsix` 应该是什么档位？

| 选项 | 含义 | 影响 |
|---|---|---|
| **保持 `write`** | agent 能调，要用户批准 | 现状 |
| **改成 `blocked`** | agent 完全够不到，只能用户手动装 | 和 `modules.setPermissions` 一致 |
| **改成 `danger`** | agent 能调，**每次都批**（不能用「始终允许」授权覆盖） | 中间档 |

**我倾向 `danger`**：安装扩展是有持久效果的动作，但不该完全禁止 agent 协助（用户可能想让 agent 帮他装一个）。**`danger` 保证每次都要本人点头。**

**但这是扩展线的判断。**

### 2. 生成物要不要加一条「不能过期」的门禁？

现在只有 `app-control-smoke` 一条断言在守它，而那条断言的名字是
「功能清单与 RpcMap 逐条对齐」—— **听起来像文档检查，实际守的是运行时幂等映射。**

**建议**（另开卡，不在本卡）：

- 把那条断言的名字改成说清它同时守运行时；
- 或者在 `channelIdempotency.ts` 加一条启动期断言（dev only）：catalog 里缺任何 `RpcMap` 方法就 warn。

## 七、边界

**本卡不执行任何代码改动。** 它要的是：

1. 扩展线确认 `installVsix` 的档位（`write` / `danger` / `blocked`）；
2. 决定要不要加「生成物不能过期」的门禁。

## 八、回写

1. `installVsix` 最终定成什么档，为什么
2. 有没有加门禁
3. 你觉得不对但没改的

---

## 附：我核实的事实

| # | 事实 | 怎么核 |
|---|---|---|
| 1 | 生成物最后更新 `a6f9e1a6`（T109） | `git log -3 -- apiCatalog.generated.ts` |
| 2 | HEAD 版本里 `unrestorable` / `editor-only` 都是 0 | `git show HEAD:... \| grep -c` |
| 3 | `unrestorable` 来自 T125（`9821e69c`） | `git log -S` |
| 4 | `editor-only` 来自 T43（`0a2aa805`） | `git log -S` |
| 5 | 重跑后 459 条，门禁 582/582 | 实跑 |
| 6 | `methodForChannel` 找不到就返回 null（幂等不介入） | 读 `channelIdempotency.ts:113` |
| 7 | `installVsix` 落 `write` 档 | 读 `policyFor` 全链 |
| 8 | `modules.*` 其余敏感方法都是 `blocked` | 读 `policy.ts:70-85` |
