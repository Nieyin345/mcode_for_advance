# T18｜扩展安装时的权限卡片（同意一次 / 始终同意）

- Status: ready-for-agent
- Category: feature
- Priority: P0 product requirement
- Depends on: none
- Exclusive writable files: 扩展安装 IPC 契约与其 handler、安装确认 UI 组件、权限决策存储，以及新建回归套件。逐个确认后写进回写区。**不改** `workflowEngines/`、`orchestration/automationRunner.ts`、`appControl/apiCatalog.generated.ts`、`ipc/settingsTransfer.ts`、`lib/worktreeOps.ts`、`renderer/components/chat/ApprovalPrompt.tsx`、`McpToolDecisionCard.tsx`、`arc005-visual-baseline/`。

## Required Skills
- `security-best-practices`: 权限卡片是安全边界，必须论证「拒绝」「超时」「未知权限」都 fail-closed。
- `mcode-smoke`: 用 fakeIpc / fake renderer 建确定性的安装流回归。
- `code-review`: 确认新加的权限路径没有绕过既有 ModuleHost 授权。

Read before work: `CLAUDE.md`、`audit-ledgers/README.md`、`docs/planning/extension-vscode-compat.md`、`docs/planning/mcode-product-roadmap.md`、`packages/contracts/src/appPermission.ts`、`packages/contracts/src/modules.ts`、`packages/contracts/src/moduleCapability.ts`、`apps/desktop/src/main/modules/service.ts`、`apps/desktop/src/main/modules/builtinCapabilityCatalogue.ts`。

## 产品要求（用户原话）

> 「不是分级，就是装的时候会弹出来的卡片，要的权限，然后用户同意，比如同意一次，比如始终同意，就像是手机的软件一样」

## 总控核实过的现状

- 权限枚举**已有 36 个值**（`packages/contracts/src/appPermission.ts` 的 `MODULE_PERMISSION_NAMES`），覆盖 `files.read` / `files.write` / `document.edit` / `git.write` / `terminal.run` / `network` / `ui.control` / `modules.install` 等。**不需要新建权限模型。**
- `ModuleHost.install/restore/remove`、`register/validate/prepareCapability`、`invoke` 的授权检查**都已存在**。
- `permissionedProcessRunner`、`isolatedActionRunner` 也在。
- **缺的是安装那一刻的用户确认 UI 与决策持久化**：现在 `grep installConfirm` 在 `apps/desktop/src` 与 `packages/contracts/src` 里**零命中**（只有 LSP 卸载确认是另外的东西）。
- 已有 `apps/desktop/scripts/gen-module-permission-map.mjs` 与 `module-permissions-smoke` 可参考，但那是权限映射，不是安装确认。

## 目标

在**不重新设计权限模型**的前提下，补上「安装时的权限卡片」这一环。

### 必须实现

1. **清单声明 → 权限需求**：从 `ModuleManifest` 推导出这个扩展需要的权限集（来自 capabilities/resources），形成「安装时要展示的权限列表」。
2. **安装确认 IPC**：安装流在落盘前必须经过一次用户确认，返回三种结果之一：
   - 允许一次（本次安装 + 本次运行）
   - 始终允许（写入持久决策）
   - 拒绝（安装中止，不写盘）
3. **持久决策存储**：按「扩展身份 + 权限集指纹」记录。**扩展升级导致权限集变化时必须重新询问**——这是安全关键点，不能用旧决策放行新权限。
4. **UI 卡片**：渲染端组件，展示扩展名、来源、逐条权限的人类可读说明；必须支持键盘操作（Enter 不意外授权、Esc 取消），且与既有 `ApprovalPrompt` 的安全语义一致。
5. **未知权限 fail-closed**：清单里出现不在 `MODULE_PERMISSION_NAMES` 里的权限 → 拒绝安装，明确报错。

### 安全硬要求（本卡关键）

- **拒绝 = 不写盘**，不是「先装了再禁用」。
- **超时/丢消息 = 拒绝**，不是「默认允许」。
- **权限集变化 = 重新询问**，不是沿用旧决策。
- **不能绕过 ModuleHost**：安装确认之后，每次 `invoke` 的授权检查仍然照常执行。安装确认**不能**被当成永久授权。
- 持久决策文件必须与 `executor-ownership.json` 同级安全（普通文件、非符号链接、损坏时 fail-closed）。

## 验收判据

1. 安装一个需要 `files.write` + `network` 的假扩展 → 弹出卡片，列出这两条。
2. 选「拒绝」→ **磁盘无任何写入**，安装状态不变，有明确错误回传给调用方。
3. 选「允许一次」→ 本次安装成功；**重启后同一扩展再次激活仍会询问**。
4. 选「始终允许」→ 安装成功且重启后不再询问；**但把清单里加一条新权限后必须重新询问**。
5. 清单含未知权限 → 拒绝安装并报错。
6. 决策文件损坏 → fail-closed（拒绝自动放行）。
7. 键盘：Esc 取消安装，Enter 不直接授权（需要显式聚焦到授权按钮）。
8. 变异验证：把「拒绝=不写盘」改成「拒绝但仍写盘」→ 对应断言必须变红；逐字节还原（`cmp`）。
9. 双包 typecheck 通过。

## 边界

- **不改现有 36 个权限名**。若发现确实缺一个权限，在回写里提出，不在本卡加。
- **不做扩展市场、不做签名验证**——那是后续卡。
- **不改 `docs/planning/extension-vscode-compat.md` 的 L1/L2/L3 分级**。

## 结果回写（2026-10-23）

（执行者在此追加：权限需求推导方式、IPC 契约、决策存储格式与安全属性、UI 交互、测试与变异证据、提交 SHA、未覆盖项）
