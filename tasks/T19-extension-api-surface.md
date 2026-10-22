# T19｜扩展 API 面：让扩展能调到 Mcode 的全部能力

- Status: ready-for-agent
- Category: feature
- Priority: P1
- Depends on **T18**（安装时权限卡片必须先到位，否则开放 API 面等于无授权放行）
- Exclusive writable files: `apps/desktop/src/renderer/components/customUi/panelBridge.ts` 及其主进程对应 handler、扩展宿主侧 API 桥、新建回归套件。逐个确认后写进回写区。**不改** T18 的文件、`workflowEngines/`、`orchestration/automationRunner.ts`、`appControl/apiCatalog.generated.ts`、`ipc/settingsTransfer.ts`、`lib/worktreeOps.ts`、`arc005-visual-baseline/`。

## Required Skills
- `security-best-practices`: 把 446 个 RPC 开放给第三方代码是最高风险的改动，逐类论证授权边界。
- `codebase-design`: 判断 API 面应该是「透传全部 RPC」还是「显式白名单」，以及接口该多窄。
- `mcode-smoke`: 建恶意扩展回归（越权调用、伪造身份、绕过审批）。
- `code-review`: 确认没有开出第二条绕过 ModuleHost 的通路。

Read before work: `CLAUDE.md`、`audit-ledgers/README.md`、`docs/planning/extension-vscode-compat.md`、`docs/planning/mcode-product-roadmap.md`、`packages/contracts/src/appPermission.ts`、`packages/contracts/src/ipc/rpcMap.ts`、`apps/desktop/src/main/appControl/policy.ts`、`apps/desktop/src/renderer/components/customUi/panelBridge.ts`。

## 总控核实过的现状

- `packages/contracts/src/ipc/rpcMap.ts` 共 **446 条** RPC，跨 32 个契约模块。
- `apps/desktop/src/main/appControl/policy.ts` 有五档判定（`read` / `ui` / `write` / `danger` / `blocked`），带 `BLOCKED` / `DANGER` / `CREDENTIAL_BEARING` 三张表。
- **扩展已经能调任意 RPC**，但入口很窄：`apps/desktop/src/renderer/components/customUi/panelBridge.ts:216` 的 `api.call`，**只对有面板 UI 的扩展开放**。
- 主进程侧走的是与 agent `app_api_call` 同一套 `panelApiCall`，两次审批（首次 + 复核）。

## 目标

让扩展（不限于有面板 UI 的）能用**同一套授权语义**调用 Mcode 的能力，同时不放宽任何一条现有边界。

### 必须做到

1. **统一的扩展 → RPC 入口**：把现在绑定在 `panelBridge` 上的 `api.call` 抽成独立的扩展 API 面，供有/无面板的扩展共用。**不要复制一份 `panelApiCall`** —— 复用同一份。
2. **能力发现**：扩展能查询「我能调什么」。复用现有 `app_api_list → describe → call` 目录，而不是另造一份能力清单。
3. **授权分层**（不新增权限名，映射到 T18 已确认的权限集）：
   - `read` 档：按 T18 的安装决策放行
   - `write` 档：每次调用要审批（或按 T18 的「始终允许」在**该权限**上放行）
   - `danger` / `blocked`：**永不**对扩展开放，无论安装时同意了什么
4. **身份不可伪造**：主进程必须从已验证的调用上下文取扩展身份，不能信渲染端传来的模块 ID。
5. **审计**：每次扩展发起的 RPC 调用要留下可追溯记录（谁、什么时候、调了什么、结果）。

### 明确不做

- **不开放 `blocked` 表里的任何方法**。若发现某条本该 blocked 却在白名单里，**报告而不是修**（那属于安全缺陷，要单独开卡）。
- **不做 VS Code API 映射**——那是 `extension-vscode-compat.md` 的 L1/L2 范畴，属于后续卡。
- **不允许扩展绕过审批**：安装时同意 ≠ 永久授权 danger 类操作。

## 验收判据

1. 一个**无面板**的扩展能成功调用一个 `read` 档 RPC。
2. 同一扩展调用 `write` 档 RPC → 触发审批；拒绝则调用失败且无副作用。
3. 同一扩展调用 `danger` 档 RPC → **直接被拒**，不弹审批（连机会都不给）。
4. 同一扩展调用 `blocked` 表里的方法 → 拒绝，且错误信息不泄露方法存在性。
5. 伪造模块 ID（渲染端传别人的 ID）→ 主进程按真实身份判定，拒绝。
6. 有面板扩展的既有 `api.call` 行为**不回归**（跑 `module-permissions-smoke` 与相关套件）。
7. 变异验证：把 `danger` 档判定改成放行 → 第 3 条必须变红；逐字节还原（`cmp`）。
8. 双包 typecheck 通过。

## 结果回写（2026-10-23）

（执行者在此追加：API 面设计取舍、复用点、五档映射表、恶意扩展测试结果、变异证据、提交 SHA、发现的既有安全问题候选）
