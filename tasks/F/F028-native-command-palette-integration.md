# F028｜Theia 扩展命令深度接入 Mcode 原生命令面板

- Status: done（原生命令面板 + UI 入口收敛，E1 回归通过；共享宿主 / Monaco / Electron U1 仍未完成）
- Owner: F 扩展线。依赖 F026、F027。
- Required Skills: mcode-smoke, codebase-design.
- Exclusive files: `apps/desktop/src/main/modules/theiaHost/installedRegistry.ts`, `apps/desktop/src/main/ipc/theiaInstalled.ts`, `packages/contracts/src/ipc/modules.ts`, `apps/desktop/src/renderer/components/layout/CommandPalette.tsx`（仅扩展命令收集段，先确认干净）, `apps/desktop/src/renderer/components/modules/VsixInstallSection.tsx`（扩展专属页面入口合并，已检查干净）,  新增 `apps/desktop/src/renderer/lib/theiaCommandBridge.ts`, `apps/desktop/scripts/theia-installed-smoke/main.ts`, 新建 `apps/desktop/scripts/theia-palette-smoke/`、本卡与 F/README。
- 其它工作区脏文件、GenOffice、工作流、聊天 UI、公共样式不可修改；不得 reset/clean/git add .。

## 用户要求 / 架构方向

深度集成到 Mcode 原生命令面板，不再出现 Theia 专属命令执行岛。命令的发现、选择、结果与原有 command palette 采用同一个 UX。Theia 只是 Node VS Code 兼容执行器，不是第二个 Mcode UI 工作台。

## 安全与性能约束

- 只给**拥有运行中 Theia 会话的同一桌面窗口**下发注册命令和一次性会话 ID；不同 sender / 已结束 / 未注册命令执行一律拒绝。
- 不扫描任何扩展文件、不创建子进程、不自动执行、不后台轮询；仅 **命令面板打开时**查询运行中扩展元数据。
- 面板查询失败不影响旧 Mcode 内置命令和 ModuleHost 命令；迟到回复不能污染已经关闭的面板。
- 统一命令定义结构，Theia 注册命令加入与 ModuleHost 相同 `command` 分组、搜索/反馈，并执行现有 `theiaInstalled.execute` 正式 IPC。
- 真实宿主测试（无头 E1）和 palette 集成回归；不宣称 Electron U1、跨多个扩展 host 复用或完整 VS Code API。

## 验收证据

- 源码实现：`TheiaInstalledRegistry.list(senderId)` 仅给拥有当前 live Theia 会话的 sender 返回 `activeSession{sessionId,commands}`；非 owner、普通无 sender 的读取不会泄露会话令牌；停用后命令清零。
- 新增纯 `collectTheiaPaletteCommands` adapter，将 Theia 注册命令映射成现有 `CommandDef`，从 Mcode `CommandPalette` 的同一分组/搜索/执行反馈路径调用 `modules.theiaInstalled.execute`；仅在命令面板 **打开时**发起一次安装元数据请求，不轮询、不自动启动扩展，不阻塞内置命令或 ModuleHost 命令。关闭时使迟到结果无效。
- 产品 UI 只保留持久 Theia 管理为默认入口。旧 L1 限制告知与安装保留在折叠兼容区；F025 临时预览仍保留后端/测试但不再把独立实验 UI 与用户默认安装并排。
- 安全回归：owner only、no sender、其他窗口、已停止命令、过长/重复 command ID、RPC 正式路径；原有 VSIX legacy IPC/ignored contribution 测试通过。
- 最终联合验证 **12/12 smoke PASS**。新增 `theia-palette-smoke` **18/18**，扩展安装实宿主 `theia-installed-smoke` **53/53**；日志 `apps/desktop/.tmp/smoke-runs/1792904789543-36380-6nJr7P/`。
- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` 与 `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json`：PASS。vendor/theia clean。
- **未完成**：不是完整统一 ModuleHost 权限/生命周期域，不具多扩展复用、原生 Monaco 数据/撤销闭环，不含真实 Electron U1/打包运行时/沙箱，也尚未测速多扩展驻留成本。
- F028 精准代码提交：`9d025c7e`（9 个独占文件），台账文档提交另行记录。
