# F025｜Theia 真实 VSIX 临时试运行入口与安全闭环

- Status: done（E1 真实 Theia 宿主 / VSIX；Electron U1 尚未验收）
- Scope: P0 扩展二开；依赖 F022–F024
- Required Skills: mcode-smoke（测试）与 codebase-design（宿主边界）
- Exclusive writable files:
  - apps/desktop/src/main/modules/theiaHost/theiaVsixPreview.ts（新）
  - apps/desktop/src/main/ipc/theiaPreview.ts（新独立 IPC 注册器）、ipc/index.ts（仅接线）
  - apps/desktop/src/main/modules/theiaHost/host.ts（打包重命名，避免测试脚本 createRequire 变量撞名）
  - apps/desktop/src/main/appControl/policy.ts、appControl/apiCatalog.generated.ts（阻止 Agent 授权 + 使用现有生成器）
  - packages/contracts/src/appPermission.ts（由现有权限映射生成器生成，不可委托）
  - packages/contracts/src/ipc/modules.ts、packages/contracts/src/ipc/rpcMap.ts
  - apps/desktop/src/preload/index.ts
  - apps/desktop/src/renderer/lib/webApi.ts
  - apps/desktop/src/renderer/components/modules/VsixInstallSection.tsx（扩展专用 UI，现无 dirty；其他 UI 不碰）
  - apps/desktop/scripts/theia-vsix-preview-smoke/（新）
  - tasks/F/README.md、本卡
- Do not modify: apps/desktop/src/renderer/styles.css、其他 UI 线文件、ModuleHost.ts、vendor/theia、工作流代码。安全策略/生成文件仅追加此新方法所需的最小阻断，并遵循现有生成器。

## 目标

用户通过既有 VSIX 选择器选择真实市场 VSIX；新增明确标为「Theia 临时兼容试运行」的预检、静态能力告知、人工确认后在 Theia 子进程执行；能列出注册命令、手动执行已注册命令、停止并清理，不污染 Mcode ModuleHost 的正式安装目录。旧 L1 安装路径保持原样。

## 安全与验收

- ZIP 多文件结构：路径穿越、软链接、重复路径、加密、ZIP64、异常 size/CRC、解压炸弹、缺 manifest 或入口，拒绝；绝不释放到用户工作区。
- 仅桌面主 frame；缺少预检 ticket / 不同 sender / 未显式同意一律拒绝；token 只在有限生命周期中有效。
- 启动/激活失败及时停止子进程、清理临时内容；关闭后命令不可调用。
- 宿主仍没有运行时沙箱。能力扫描是静态下限，不承诺市场扩展完整兼容。
- 用真实 Theia 宿主 + 合成多文件 VSIX 端到端无头测试，另验证被拒负样本。E1 不代表 Electron U1。

## 验收与提交

- **最终回归 7/7 PASS**：`theia-vsix-preview-smoke` **42/42**、`theia-host-boot-smoke` **51/51**、`module-platform-smoke`、`module-permissions-smoke`、`module-workflow-smoke`、`app-control-smoke`、`ipc-wiring-smoke`。
- 合并日志：`apps/desktop/.tmp/smoke-runs/1792900458727-16392-bRb5nG/`。
- `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` 与 `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`：**PASS**。
- 命中真实 Theia fork + 多文件 ZIP + 静态能力报告 + 单次 ticket + 子框架/其他 sender 拒绝 + 扩展命令执行 + 停止与窗口关闭清理；并发预检、Windows 禁用文件名、目录穿越、CRC、解压大小上限均有负控。
- **隔离安全修复**：`policyFor("modules.theiaPreview")` 是 blocked/mutating；生成的 `APP_METHOD_PERMISSIONS["modules.theiaPreview"] = null`，即扩展与 Agent 均不得代理调用。
- **附加非归属红项**：单独 `t45-permission-map-drift-smoke` 之前为 26/29；对比的是 `CREDENTIAL_BEARING` 17 → 14、`EXPLICIT` 81 → 80，属于并行策略表调整，没有用伪造权限去抹平。不是 F025 新方法映射缺失，后者已由生成器与 `module-permissions-smoke` 覆盖。
- **未完成**：Electron 真窗口 U1；产品正式持久安装、跨重启恢复、完整 VS Code API/Monaco 工作区集成与扩展运行时沙箱。本卡只提供受信用户明确操作的临时试运行。
- F025 代码提交：`5cb7ac33`（14 个精准暂存文件；没有加入并行 UI / 工作流修改）。台账回写另单独提交。
