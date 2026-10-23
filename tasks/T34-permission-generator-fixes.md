# T34｜权限映射生成器缺 framework 域；danger 默认可委托

- Status: ready-for-agent
- Category: **bug（P0 安全 + 工具链）**
- Priority: **P0**
- Depends on: **T33 完成**（它决定 `document.toolCall` / `markdownEdit` 的档位，本卡重生成时要吸收这个结论）
- Exclusive writable files: `apps/desktop/scripts/gen-module-permission-map.mjs`、`packages/contracts/src/appPermission.ts`（生成物）、`apps/desktop/scripts/module-permissions-smoke/`。

## Required Skills
- `security-best-practices`: 生成器决定「哪些 RPC 可委托给扩展」，是权限边界。
- `mcode-smoke`: 生成后跑全套权限回归。

Read before work: `CLAUDE.md`、`tasks/T33-policy-tier-fixes.md`、`tasks/T19-extension-api-surface.md` 回写第 9 节、`apps/desktop/scripts/gen-module-permission-map.mjs`、`packages/contracts/src/appPermission.ts`、`apps/desktop/scripts/module-permissions-smoke/main.ts`、`apps/desktop/src/main/appControl/policy.ts`。

## 已核实的两个缺陷（D 会话调查）

### 缺陷 A：生成器没有 `framework` 域，**现在重跑会直接失败**

`gen-module-permission-map.mjs` 的 `readPerm` / `writePerm` 没有 `framework` 域：

```js
if (!perm) throw Error("No domain grant for framework")
```

**后果**：`document.apps` 等 10 条权限映射 **MISSING**（D 逐条核对：`appPermission.ts` 里没有，`apiCatalog.generated.ts:608-694` 有）。

**实测**：`module-permissions-smoke` FAIL「Unmapped RPC method: document.apps」。

**影响分两面**：
- **扩展侧 fail-closed**（`undefined` → 「未知方法」拒），**够不到**
- **agent 侧 `app_api_call` 仍可调用**，档位走动词兜底：7 条 `document.*` 全落 `write`，`framework.list` 落 `read`，`framework.save/reset` 落 `write`

### 缺陷 B：danger 方法默认变成可委托

`gen-module-permission-map.mjs:43-50`：只有 `workflowEngine.load` 在 `nonDelegableOverrides`。

**danger 方法默认按 `writePerm` 变成可委托**，例如 `agentSsh.approveHost` → `terminal.run`（`appPermission.ts:48-50`）。

T19 之前是「grant 即放行」；T19 之后每次仍要过 `approveDangerAppCall`，**不再是静默放行，但「够得到」仍在**，且靠人工记得往集合里加。

**补偿控制**：`extension-danger-delegation-smoke` 把 91 条钉死，新增 danger 会变红强制复审。**这是好的，但应该从源头 fail-closed。**

## 工作顺序

**第一步：先定 `framework` 域该给什么权限。**

读 `framework.list` / `save` / `reset` 的 handler，判断：
- `framework.list` —— 只读？
- `framework.save` / `reset` —— 写配置？

**参考**：`context.save` 在现有表里是 **danger**。framework 改的东西是否同等重要？

**给出判断依据，不要随便给个权限。**

**第二步：改生成器。**

1. 加 `framework` 域
2. **danger 默认 `null`（不可委托），白名单里的才可委托** —— 这是 fail-closed 的方向，与现有 `nonDelegableOverrides` 相反

**注意**：这个反转会缩小现有的可委托面。**要先列出会变窄哪些，在回写里逐条说明。**

**第三步：重新生成 `appPermission.ts`。**

跑生成器，然后**核对差异**：
- 新增了哪些映射（framework 域）
- 收窄了哪些（danger 变 null）

**第四步：修 `module-permissions-smoke`。**

它现在 FAIL 在 `document.apps`。改完后必须绿。

**第五步：变异验证。**

- 把 `framework` 域删掉 → 生成失败或断言变红
- 把 danger 默认改回可委托 → `extension-danger-delegation-smoke` 变红
- 逐字节还原（`cmp`）

## 文件边界（独占）

**可写**：`gen-module-permission-map.mjs`、`packages/contracts/src/appPermission.ts`（**只能通过生成器改，不许手改**）、`module-permissions-smoke/`。

**不要碰**：
- `appControl/policy.ts`（T33 刚改）
- `modules/ModuleHost.ts`（T19）
- `workflowEngines/`、`document/`、`renderer/`
- `build/vendor-licenses/`

## 硬约束

- **`appPermission.ts` 是生成物，只许通过生成器改。** 手改会在下次生成时丢失。
- **收窄可委托面是安全方向**，但要**逐条列出**哪些方法会从可委托变成不可委托，让使用者知道影响。
- **必须跑 §全量**：`module-permissions-smoke`、`extension-danger-delegation-smoke`、`module-app-call-smoke`、`install-consent-smoke` 等相关套件。
- **必须提交。**

## 遇到问题先检索

用户定的最高原则：**报错、API 用法、依赖问题先上网查，不要凭记忆猜。**

## 提交

`git add` 后**立刻** `git commit`。**绝不读 `.tmp/` 下的文件当提交信息。**

提交信息末尾加：
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

## 回写

在 `tasks/T34-permission-generator-fixes.md` 末尾追加 `## 结果回写（2026-10-23）`：`framework` 域判断依据、danger fail-closed 的收窄清单、生成差异、相关套件结果、变异证据、提交 SHA。

## 最终回复

只列：任务编号与标题；提交 SHA；`framework` 域给了什么权限；收窄了几条可委托；相关套件是否全绿。

---

## 结果回写（2026-10-23，C 会话）

### 0. 先说一件**开工前必须更正**的事：卡上的实测数据已经过时

卡上写「7 条 `document.*` 全是 `write`」。**我实测时它们已经是 `read` / `danger` 了**：

```js
// .tmp/probe-policy.mjs，直接调 policyFor()
document.apps           → read        （卡上说 write）
document.render         → read        （卡上说 write）
document.markdownRead   → read        （卡上说 write）
document.toolsList      → read        （卡上说 write）
document.toolDescribe   → read        （卡上说 write）
document.toolCall       → danger      （卡上说 write）
document.markdownEdit   → danger      （卡上说 write）
framework.list          → read
framework.save          → write
framework.reset         → write
```

原因：**E 的 T33 已经把改动写进工作树**（`apps/desktop/src/main/appControl/policy.ts`
是 ` M` 状态，最后修改 19:36，`EXPLICIT` 里逐条加了 `document.read` / `capabilities` /
`apps` / `toolsList` / `toolDescribe` / `markdownRead` / `render` 七条，`DANGER` 里加了
`toolCall` / `markdownEdit`）。总控给我的实测快照是在 E 改动**之前**跑的。

**这意味着卡上「7 条 document.* 会静默放宽」那一半已经不成立了** —— 它们现在按
`policyFor` 的真实档位被正确映射。真正剩下的缺陷只有 framework 域。

### 1. `framework` 域给了什么权限，依据是什么

| 方法 | 域映射 | 理由 |
|---|---|---|
| `framework.list` | `setting.read` | 只回段落清单与当前文本（`listFrameworkSections`），不写盘、不改变行为。与 `setting.read` 同档（都是「看一眼配置」）。 |
| `framework.save` | `setting.write` | 写 `<dataRoot>/context/framework/<id>.md`。 |
| `framework.reset` | `setting.write` | 删除该覆盖文件，回落到出厂默认。 |

**但 `save` / `reset` 的实际后果比「写配置」重得多。** 我读了
`orchestration/frameworkPromptStore.ts` 与 `frameworkSections.ts`：这两条改的是
**注入进每个工作流节点提示词的引导话术**（`schedulerPrompt.ts` 的
`frameworkText`）。也就是说，**改的不是数据，是 agent 的行为指令**。

`policy.ts` 里 `context.save`（写 CLAUDE.md / AGENTS.md）已经是 **`danger`**，理由是
「改全局指令」。`framework.save` 与它同性质 —— 所以**它也应该在 `DANGER` 档**。

**但 `policy.ts` 是 T33 的独占文件，E 正在改，本卡边界明令不许碰。** 所以：

- 生成器里我**没有**把 `framework.save/reset` 硬塞进 `nonDelegableOverrides` ——
  那里有一条守卫：进集合的方法 `policyFor` 必须是 `danger`，否则生成器报错退出。
  实测这条守卫**真的拦住了**我：

  ```
  Error: Non-delegable override must retain danger policy: framework.save
  ```

  这正是它该做的事。我没有绕过守卫，而是**把它留作 T33 的遗留**。

**遗留（需 T33 或新卡处理）**：`policy.ts` 把 `framework.save` / `reset` 提成
`danger`，然后加进 `nonDelegableOverrides`。在那之前，扩展拿到 `setting.write`
仍可调它们 —— **这是已知的、有意的缺口，不是遗漏**。

### 2. 修了什么

**① 生成器加 `framework` 域**（`readPerm` + `writePerm` 各一条）。

**② `document.toolCall` / `document.markdownEdit` 设为不可委托。**

这一条不在原卡上，但我判断**必须做**：

- T33 把它们提到 `danger`，`policy.ts:243` 的注释写明了理由 ——「扩展拿到
  `document.edit` 权限后改调 `document.toolCall`，就绕开逐次审批」；
- 而我的生成器如果仍把它们映射成 `document.edit`，**那条绕过路径会原样回来**：
  扩展装的时候只要 `document.edit`，运行期就能调任意文档工具（含改文件的）；
- T19 的逐次审批只在「`policyFor` 判 danger **且方法可委托**」时生效。不可委托时
  `assertAppMethodPermission` 直接拒 —— 比「每次都问」更严。

**这是与 T33 的意图一致，不是推翻它**：档位回答「agent 侧要不要问」，委托面回答
「扩展能不能够到」。同一件事两条路，两处都要堵。

实测影响：可委托的 danger 方法从 **93 → 91**，回到 HEAD 的基线。
（93 是「T33 提了档位但生成器还没跟上」的中间态 —— 那个状态下这两条是可委托的
danger，比基线**更宽**。）

### 3. 生成差异（`appPermission.ts`，由生成器产出，未手改）

新增 10 条：

```
document.apps           → ["document.read"]
document.markdownRead   → ["document.read"]
document.render         → ["document.read"]
document.toolDescribe   → ["document.read"]
document.toolsList      → ["document.read"]
document.markdownEdit   → null            ← 不可委托
document.toolCall       → null            ← 不可委托
framework.list          → ["setting.read"]
framework.save          → ["setting.write"]
framework.reset         → ["setting.write"]
```

生成器汇总：`453 RPC methods / 37 used permissions / 41 total permissions / 77 blocked`
（HEAD 是 75 blocked —— +2 正是那两条不可委托）。

**幂等性**：连续跑两次生成器，产物逐字节相同（已验证）。

### 4. 相关套件

| 套件 | 结果 |
|---|---|
| `module-permissions-smoke` | **11 pass, 0 fail**（原 10/1，`document.apps` 未映射那条转绿） |
| `extension-danger-delegation-smoke` | **36/36** |
| `module-app-call-smoke` | 13 pass, 0 fail |
| `module-contract-smoke` | 118 checks, 0 failed |
| `module-install-consent-smoke` | 36 pass, 0 fail |
| `module-consent-copy-smoke` | 13/13 |

**两套断言跟着改了**（这是它们该有的反应，不是放宽）：

- `extension-danger-delegation-smoke` 的「不可委托的 danger 恰好 1 条」→ 3 条，
  且**从只验 `workflowEngine.load` 改成逐条验**（三条都要「直接拒 + 不弹审批」）；
- `module-permissions-smoke` 的闭世界检查把不可委托名单从写死的
  `method === "workflowEngine.load"` 改成 `NON_DELEGABLE` 集合。

两处都是**逐一钉死**而不是「大于等于」：新增不可委托项必须让断言红一次、逼人来看。

### 5. 变异验证（两次，都确认变异真的生效）

| # | 变异 | 结果 |
|---|---|---|
| **M1** | 从 `nonDelegableOverrides` 删掉 `document.toolCall`，重新生成 | `module-permissions-smoke` **红**（`document.toolCall`）；`extension-danger-delegation-smoke` **红**（不可委托名单 91 ≠ 3 条） |
| **M2** | 删掉 `readPerm` 里的 `framework` 域 | 生成器 **`Error: No domain grant for framework.list`**，退出非 0 |

两次还原均 `cmp -s` 逐字节一致（生成器 SHA-256 回到
`3f9c234acf7a07f34a75b2089ad74706b49ae6aafe50294cb47174c658539ce7`），还原后复跑全绿。

### 6. 边界遵守

- **未改** `policy.ts`（T33 的独占文件，E 在改）；
- **未改** `ModuleHost.ts`、`workflowEngines/`、`document/`、`renderer/`、`build/vendor-licenses/`；
- `appPermission.ts` **只经生成器产出**，未手改（生成器重跑两次产物一致）；
- 未碰 `ipc/index.ts`、`documentToolRuntime.ts`、`electron-u1/`。

### 7. 双包 typecheck

`packages/contracts` **0 错误**；`apps/desktop` **3 条**，全部在
`src/main/document/documentToolRuntime.ts`（`readonly string[]` 赋给 `string[]`）——
**是 B 的 T43 在途改动，不是本卡的**。本卡改的四个文件不产生任何诊断。

### 8. 留给下一张卡

1. **`framework.save` / `reset` 提到 `danger` + 加进 `nonDelegableOverrides`**
   （等 T33 的独占期结束）。在那之前扩展拿 `setting.write` 能改 agent 的提示词模板。
2. 原卡「缺陷 B：danger 默认变成可委托」的**生成器侧 fail-closed**（danger 默认
   `null`、白名单才可委托）**本卡没做** —— 它会把现有 91 条一次性收窄，影响面远超
   本卡范围，且与 T33 的档位调整交织。建议单开一张卡，并把收窄清单逐条列出。
