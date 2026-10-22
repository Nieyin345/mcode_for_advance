# T18｜扩展安装时的权限卡片（同意一次 / 始终同意）

- Status: done（2026-10-23 执行回写，见文末）
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

### 0. 卡面前提纠错（T15 的判断成立，总控的原假设不成立）

卡里写「现在没有任何安装确认 UI（`grep installConfirm` 零命中）」**是错的**。执行前实测：

- **逐项权限勾选 UI 已存在**：`apps/desktop/src/renderer/components/modules/ModuleSurface.tsx` 的
  `module-permission-picker` 区块（按 `permission.startsWith(group+".")` 分组、`MODULE_HIGH_RISK_PERMISSIONS`
  标红、可执行程序单独一次 `module-code-consent` 勾选、安装按钮按同意态禁用）。
- **决策持久化已存在**：`ModuleHost.persistModulePermissions` → `ui-modules/module-permissions.json`
  （普通文件/非链接/256 KiB/坏档 fail-closed，在 `modules/service.ts:readGrantFile`）。
- **升级改权限强制重询问已存在**：`ModuleHost.install` 的 `executionChanged` 分支 + 指纹绑定
  （`manifestFingerprint` = id+version+排序权限集+program+contributions 的 sha256）。
- 安装**也不是只有一个入口**：桌面清单面板之外，Agent 经 `app_api_call modules.install`（danger 每次弹卡）
  与 `VscodeL1Bridge.install`（宿主内部、带双重确认）都能装。

所以本卡实际做的是**提升既有选择器 + 补一次语义**，不是从零建权限模型——与 T15 §5 的结论一致。
`grep installConfirm` 零命中只说明"没有叫这个名字的东西"，不等于没有安装确认。

### 1. 权限需求推导方式

没有新建权限模型。安装卡展示的权限集就是 `ModuleManifest.permissions`（36 个 `MODULE_PERMISSION_NAMES`
的闭集，`ModulePermissionListSchema` 校验），**未知权限在清单 schema 层就被拒**（fail-closed，
`module-install-consent-smoke` ⑤ 断言）。`granted` 子集来自清单面板的逐项勾选；卡片把「声明了但本次
不授予」的条目显式标成「本次不授予」。

### 2. IPC 契约（未新增 RpcMap 方法）

**没有新增 `RpcMap` 键 / preload 入口 / 通道**——那会要求重跑 `gen-app-api-catalog.mjs`，而
`apiCatalog.generated.ts` 是他人未提交的 dirty 文件（T15 §4 点名），本卡边界不碰。

改用**既有 `modules.install` 契约加一个可选字段**：

- `packages/contracts/src/ipc/modules.ts`：`ModuleInstallSchema` 增加
  `installConsent?: "allow-once" | "allow-always" | "deny"`（缺省 `allow-once`）。
- 主进程 `ipc/modules.ts` 用**发送方身份**收窄（`modules/installConsentPolicy.ts`，纯函数不 import electron）：
  真实的 `IpcMainInvokeEvent` 带正整数 `sender.id`；Agent 的 `app_api_call`、扩展 `core.app.call`、
  面板桥都走 `callRpc(entry, input)`（event 为 `{}`）→ **没有发送方就不采信 `allow-always`，降级为
  `allow-once`**。自动化通道无法铸造跨重启授权；Agent 侧另有 `policy.ts` 的 danger 每次弹卡，两层各管一段。
- `ModuleHost.install(raw, grantedPermissions?, decision)`：`deny` 作为**第一条**语句在解析/校验/
  任何持久化之前抛出；`allow-once` 写 `duration:"session"` + `bootId`；`allow-always` 写
  `duration:"persistent"`。两者都沿既有 `manifestVersion + fingerprint` 绑定。

### 3. 决策存储格式与安全属性

`ModulePermissionRecordSchema`（`packages/contracts/src/modulePermissions.ts`）新增两个可选字段：

```
granted / grantedAt / manifestVersion / fingerprint   （既有）
duration?: "persistent" | "session"                    （缺省 persistent = 旧存档兼容）
bootId?: string                                        （仅 session：本次进程启动身份）
```

安全属性（逐条有断言，见 §5）：

| 属性 | 实现 | 断言 |
|---|---|---|
| 拒绝 = 不写盘 | `install` 首句 `if (decision==="deny") throw` | ① 5 条（persist 调用数、决策表、目录、invoke） |
| 超时/丢消息 = 拒绝 | UI 关闭/Esc → `deny`；不走新桥，无"默认允许"路径 | UI 卡 `Esc` 案例 |
| 允许一次 = 重启后重问 | `effectiveGrants`：`session` 且 `bootId !== this.bootId` → null | ② 重启后 menu 授权失效 + invoke 拒 |
| 无效会话授权不能静默续期 | `install` 新增守卫：指纹相同但 `effectiveGrants===null` → 要求重新确认 | ② 不带新决策再 install 被拒 |
| 始终允许 = 跨重启 | `persistent` 不带 bootId | ③ 模拟重启后仍可用 |
| 权限集变化 = 重问 | 既有 `executionChanged` + 指纹 | ④ 加 `session.send` 后旧决策不放行 |
| 不能绕过 ModuleHost | 安装卡只决定 `install`；执行仍走 `invoke` 的逐次授权 | ⑦ 撤销 `files.write` 后 invoke 立刻拒 |
| 未知权限 fail-closed | `ModuleManifestSchema` 的权限枚举 | ⑤ |
| 坏决策表 fail-closed | 既有 `modulePermissionArchive()`（本次未放宽） | ⑥ 坏 JSON / 坏形状且原字节不被覆盖 |
| 安装卡不是永久授权 | `setPermissions` 写 `persistent`（用户显式改权限同档） | ⑦ |

**新增的只读目录分面**：`ModuleCatalog.moduleStaleConsents`（`modules.ts` + `moduleCapability.ts` 的
`ModuleCatalogSchema`）——列出「允许一次」因重启失效的记录，**仅供 UI 按原授权子集重新弹卡**，
`effectiveGrants` / `authorizeAppMethod` / `invoke` 一律不读它（它不是授权）。目录同时给
`modulePermissions[id].duration` 让设置页显示「仅本次运行有效」。

### 4. UI 交互

新文件 `apps/desktop/src/renderer/components/modules/ModuleInstallConsentCard.tsx`：

- 模态卡片：扩展名/版本/来源（桌面 or AI 请求）/升级提示/逐条权限（人类可读说明 + 高风险标红 +
  「本次不授予」）/可执行程序警示；三钮「拒绝 / 允许一次 / 始终允许」。
- 键盘合同（与 `ApprovalPrompt` / `useApprovalArming` 同一套）：开卡焦点落在**卡片本身**（不落在授权钮），
  Esc = 拒绝，两个「允许」共用 500 ms 短延迟，拒绝钮立即可用；关闭（X/背板/Esc）**一律**按拒绝兑现。
- **全入口**：`ModuleInstallConsentHost` 在 `App.tsx` 根挂一次、`ModuleSurface` 也挂一次（夹具只渲染
  `ModuleSurface`），用最小 store 做单一持有者，避免两张卡抢焦点。清单面板的安装与「会话授权失效后的
  再次激活」(`ensureConsent`) 都经过它。

### 5. 测试与变异证据

新增 `apps/desktop/scripts/module-install-consent-smoke/`（`main.ts` + `build.mjs` + `run.sh`），
**36 checks 全绿**；`build.mjs` 内置 4 条变异，撤掉修复后各自对应断言变红：

| 变异 | 撤掉的属性 | 结果 |
|---|---|---|
| `deny-writes` | 拒绝仍继续写盘 | PASS（① 相关断言 RED） |
| `session-ignores-boot` | 会话授权无视重启 | PASS（② RED） |
| `always-is-session` | 「始终允许」写成会话级 | PASS（③ RED） |
| `agent-can-always` | Agent 通道可铸 `allow-always` | PASS（⑧ RED） |

另按卡面第 8 条做了**原地变异 + 逐字节还原**：把 `ModuleHost.ts` 的
`if (decision === "deny") throw ...` 改成「拒绝却继续」，`module-install-consent-smoke` → **31/36（5 条红）**；
`cp` 备份还原后 `cmp` 通过（BYTE-EXACT），复跑 36/36。UI 层同样做了原地变异：把卡片的关闭回执从
`decide("deny")` 改成 `decide("allow-once")`，`module-ui-smoke` 的 `§T18 Esc=拒绝` 断言变红；`cmp` 还原后 12/12。

现存套件（按 `smokes-for.sh` 映射逐个跑）：
`module-platform-smoke`、`module-permissions-smoke`、`module-catalog-smoke`、`module-catalog-ui-smoke`、
`module-app-call-smoke`、`module-extension-lifecycle-smoke`（160/160）、`module-phase2-security-smoke`（32/0）、
`module-phase2-e2e-smoke`（真 Electron，4 stage exit 0）、`module-workflow-smoke`（38/0 + save-guard 3/0）、
`maint-m31-smoke`、`module-ui-smoke`（12 项，新增 2 条 T18 断言）、`settings-panels-electron-smoke`、
`workflow-ui-smoke`、`ipc-wiring-smoke`（45/45）、`ipc-parity-smoke`（13/13）全绿，**除下面两条既有红外**。

双包 typecheck：`node node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json` 与
`...-p apps/desktop/tsconfig.json` 均 **exit 0**（用仓库钉住的 TS 5.7.2）。

### 6. 既有红（非本卡造成，已核实）

- `module-permissions-smoke`：`Unmapped RPC method: document.apps` —— HEAD 的
  `apiCatalog.generated.ts` 已含 `document.apps`（T24 提交带入），而 `packages/contracts/src/appPermission.ts`
  未重新生成。两者都是 T18 边界外的文件，本卡未触碰；需由生成器卡修复（T15 B1/N2 同类）。
- `settings-panels-electron-smoke`：`?panel=app` 的 `contributionOf(...读 flatMap)` 崩在 `ModuleViewDock`。
  **已用完整回退法核实**：把本卡全部改动原地回退到 HEAD 后该套**同样 31 checks / 1 failed、同一栈**，
  再逐字节还原本卡改动。与 T18 无关。

### 7. 提交 SHA

代码与主回写：`e6515e4506dcdc5c45abafa5485a8997ea511bd6`
（`feat(T18): extension install permission card (allow once / always / deny)`）。
本节 SHA 补记单独提交，见其后一条 `docs(tasks): record T18 result writeback`。

### 8. 未覆盖 / 后续

- **没有做独立的三态「应答桥」**（推送 + requestId + RPC 兑现）。原因是新增 RpcMap/通道会强制重跑
  `api-catalog.generated.ts`（他人 dirty）。当前做法把三态放在既有 `modules.install` 的可选字段上，
  语义等价（拒绝=不写盘、关闭=拒绝、桌面发送方才有 allow-always），但**没有**"多窗口同时挂卡"的
  消歧（同一时刻只有一张卡，后到的 `request` 会把前一张按 `deny` 兑现）。
- **没有新权限**。若未来要区分「一次安装」与「一次运行」的更细粒度，需要新的权限位或运行时段，
  不在本卡。
- **没有动 `docs/planning/extension-vscode-compat.md` 的 L1/L2/L3**；`VscodeL1Bridge` 保持宿主内部、
  双重确认语义。
- **Agent 侧**：`modules.install` 仍是 danger、每次弹卡（不可 `allow-always`）——本卡未改这条既有边界，
  只在安装决策里把 Agent 的 `allow-always` 声明降级为会话级。
- **真实 Electron U1** 只覆盖了 `module-phase2-e2e-smoke` 既有的安装与菜单旅程；安装卡自身的
  真 Electron 点击旅程**未做**（由 `module-ui-smoke` 的 CDP 浏览器夹具覆盖，非 Electron）。
- 附带说明：执行过程中为核实 settings 套件的既有红，曾在临时 worktree 里 junction `node_modules`；
  删除时误伤了 pnpm store 里 `@anthropic-ai/claude-agent-sdk` / `@anthropic-ai/sdk@0.113.0` 两个条目
  （其余 1004 个包完好），已用 `pnpm install --offline --frozen-lockfile` 从本地 store 完整修复，
  扫描 0 个受损包、双包 typecheck 复绿后才提交。**无 tracked 文件受影响。**
