# T148 — `apiCatalog.generated.ts` 过期：三个提交改了契约，没人重跑生成脚本

**Status**：`ready-for-human`（**需要扩展线判断 installVsix 的档位**）
**Category**：生成物 / 安全门禁
**发现者**：T145 的执行会话（它在跑 283 套实跑时撞到 `app-control-smoke` 红）
**写卡时间**：2026-10-24 21:35。**下面前提都是这一刻实测的。**

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

## 四、⚠️ 另一件要扩展线判断的事：`installVsix` 的 policy 档位

`policyFor("modules.installVsix")` 的判定链（`policy.ts:564`）：

```
1. BLOCKED 表？     → 否
2. CREDENTIAL_BEARING？→ 否
3. DANGER 表？      → 否
4. EXPLICIT 表？    → 否
5. 动词匹配 READ_VERB？→ 否（"installVsix" 不是 read/list/get）
6. → 兜底 "write"
```

**结果：`write` 档。**

`write` 档的含义（`policyEngine.ts:138`）：

> ⑤ write：必须在**有效的**授权范围内，否则重新批准。

**所以 agent 能调 `modules.installVsix`，只是要用户批准。不是无审批放行。**

**但对比同域的兄弟方法：**

```ts
"modules.setPermissions": "扩展安装权限只能由用户在扩展设置页本人授权或撤销",  // blocked
"modules.issueWorkflowGrant": "...",  // blocked
"modules.revokeWorkflowGrant": "...", // blocked
"modules.egressConsentSet": "...",    // blocked
```

**`modules.*` 里除了 `installVsix`，其余敏感方法全是 `blocked`。**

**「安装一个 VSIX」和「改扩展权限」哪个更敏感？** 这是产品决策，不是我能定的。

**⚠️ 我没有改 `policy.ts`。** 那会把扩展线的行为变掉。

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
