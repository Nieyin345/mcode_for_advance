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
