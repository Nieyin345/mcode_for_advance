# T19｜扩展 API 面：92 条 danger RPC 对已装扩展敞开，收窄它

- Status: ready-for-agent
- Category: **bug（授权放宽）**
- Priority: **P0 安全**
- Depends on: T18（已交付三态权限 `e6515e45`）
- Exclusive writable files: `packages/contracts/src/appPermission.ts`、`apps/desktop/src/main/modules/ModuleHost.ts` 的授权分支、新建回归套件。逐个确认后写进回写区。

## Required Skills
- `security-best-practices`: 这是权限边界改动，必须论证每个降级路径。
- `mcode-smoke`: 建恶意扩展回归（越权、伪造身份、绕过审批）。
- `code-review`: 确认没有开出第二条绕过 ModuleHost 的通路。

Read before work: `CLAUDE.md`、`tasks/T18-extension-install-permission-card.md`、`docs/planning/product-roadmap/T15-agent-host-baseline.md` **N1 段**、`packages/contracts/src/appPermission.ts`、`apps/desktop/src/main/appControl/policy.ts`、`apps/desktop/src/main/modules/ModuleHost.ts`。

## 我原卡的前提是错的（必须纠正）

我在 T19 卡里写的是「**让扩展能调到 Mcode 的全部能力**」，把它当成一个**开放**任务。

**T15 基线证明这是反的**：

> 无面板扩展已能经 `core.app.call` 调任意已授权 RPC；其「danger 直接拒」验收与现状 **91 条可委托**冲突，**落地将是行为收紧，需迁移已装扩展授权**。

## 已核实的真实数字（我用脚本数的）

```
APP_METHOD_PERMISSIONS 总条目：443
  其中 null（不可委托）：77
  其中数组（可委托）：   366

policy.ts 的 DANGER 表：  92 条
policy.ts 的 BLOCKED 表： 59 条
```

**关键机制**：`assertAppMethodPermission` 只做两件事——

```ts
const required = permissionsForAppMethod(method);
if (required === null) throw Error("不可委托给扩展");        // BLOCKED 已拦
if (required === undefined) throw Error("未知方法");
for (const p of required) if (!granted.includes(p)) throw;   // 只看权限，不看档位
```

**`required` 是数组的 366 条方法里，凡是落在 `DANGER` 表（92 条）的，只要扩展在安装时拿到对应权限，`invoke` 就直接放行——不逐次审批。**

这就是 `git.push` / `project.delete` / `modules.install` 这类操作对已装扩展敞开的原因。

## 目标

让 `danger` 档在扩展调用时**逐次审批**，而不是靠安装时的权限一次性放行。

### 必须做到

1. **建立档位到扩展的映射**：`assertAppMethodPermission` 或它的调用方要能知道某个方法是 `danger` 档。
   - 注意：`policy.ts` 在 `apps/desktop/src/main/`，而 `appPermission.ts` 在 `packages/contracts/`。**契约层不能依赖主进程**。
   - 要么把档位信息下沉到契约层，要么在 ModuleHost 侧做判定。**必须论证选择。**
2. **danger 档的扩展调用要触发审批**，不能只看 `granted`。
3. **`blocked` 档保持现状**（已经 `null`，永远拒）。
4. **不给扩展任何「始终允许 danger」的路径**——即使安装时授予了权限，每次调用都要问。

### 迁移（这是本卡最难的部分）

现在可能有已装扩展依赖「安装授权即放行」的行为。收窄会打断它们。

**必须做到**：
- 列出收窄后哪些现有路径会变严
- 给出**可观测的拒绝理由**（不是静默失败）
- 如果某扩展确实需要反复执行 danger 操作，**它应该走工作流授权（`issueWorkflowGrant`），不是靠安装权限**

## 验收判据

1. 一个持有 `git.write` 权限的扩展调用 `git.push` → **触发审批**，不是直接放行。
2. 同一扩展调用 `BLOCKED` 表里的方法 → **直接拒**，不弹审批。
3. 同一扩展调用 `read` 档方法 → **不触发审批**（保持现状）。
4. 伪造模块 ID（渲染端传别人的 ID）→ 主进程按真实身份判定，拒绝。
5. 有面板扩展的既有 `api.call` 行为**不回归**（跑 `module-permissions-smoke` 等）。
6. 迁移：收窄后哪些路径变严，逐条列出，并验证每条给出可读的拒绝理由。
7. 变异验证：把 danger 档判定改成放行 → 第 1 条必须变红；逐字节还原（`cmp`）。
8. 双包 typecheck 通过。

## 边界

- **不新增权限名**（36 个不动）。
- **不开放 `BLOCKED` 表里的任何方法**。
- **不做 VS Code API 映射**——那是另一条线。
- **不碰** `workflowEngines/`、`orchestration/`、`document/`、`appControl/apiCatalog.generated.ts`、`ipc/settingsTransfer.ts`、`renderer/`。
- 若发现 `policy.ts` 与 `appPermission.ts` 的档位判定已经不一致，**报告而不是单方面统一**。

## 结果回写（2026-10-23）

（执行者在此追加：档位下沉或宿主侧判定的选择与论证、92 条 danger 里哪些现在会被拦、迁移影响面、恶意扩展测试结果、变异证据、提交 SHA、发现的既有安全问题候选）
