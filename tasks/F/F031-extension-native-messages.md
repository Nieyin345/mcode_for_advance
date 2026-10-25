# F031｜扩展运行时消息与用户操作接入 Mcode 原生 UI

- Status: done E1（运行时消息与用户选择往返通过；真实 Electron U1 未覆盖）
- Depends on: F029, F030
- Required Skills: mcode-smoke, codebase-design
- Exclusive files: `apps/desktop/src/main/modules/theiaHost/host.ts`, `apps/desktop/src/main/modules/theiaHost/installedRegistry.ts`, `apps/desktop/src/main/modules/theiaHost/runtimeMessageBroker.ts` (new), `apps/desktop/src/main/ipc/theiaInstalled.ts`, `packages/contracts/src/ipc/modules.ts`, `packages/contracts/src/ipc/events.ts`, `packages/contracts/src/ipc/rpcMap.ts`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/lib/webApi.ts`, `apps/desktop/src/renderer/App.tsx`, `apps/desktop/src/renderer/components/modules/TheiaRuntimeMessageHost.tsx` (new), `apps/desktop/scripts/theia-host-boot-smoke/fixtures/spawn-ext/extension.js`, `apps/desktop/scripts/theia-installed-smoke/main.ts`, `apps/desktop/scripts/theia-palette-smoke/main.ts` (if necessary), this card and F/README.
- Preserve other dialogue's UI, workflow, Office and unrelated uncommitted changes. No reset/clean/bulk staging.
- Goal: `vscode.window.showInformationMessage/showWarningMessage/showErrorMessage` no longer silently swallowed. Non-interactive notifications flow into Mcode's existing toast store; action choices/modals render in a globally mounted lightweight Mcode UI surface and return precise choice to Theia.
- Acceptance: authentic Theia child RPC exercised, correct typed severity/action handle, same-sender reply required, no cross-session replay, user dismissal/timeout/window close/host stop fail closed, bound pending records, no background poll, no Electron U1 claim. F030 multi-extension coexistence unchanged.
- Remaining runtime limitations: status bar, quick pick/input, workspace/filesystem, webviews, debugger, terminal, menu/contribution points, packaged Theia, sandbox, Electron U1.

## Implementation and verification

- `TheiaHost` 的 `P.MESSAGE_REGISTRY_MAIN.$showMessage` 不再静默返回 `undefined`。真正从 Theia 收到 Info/Warning/Error、`options.modal/detail` 和操作数组，并调用注入的原生通知回调；不用再启动任何 UI 子进程。
- `TheiaRuntimeMessageBroker` 使用单窗口 sender + 已分配 session + 一次性 requestId，并设最多 16 个待处理操作/30 秒失效、可按窗口/会话取消。非法跨 sender、跨 session、越界 choice、重放均拒绝；普通无选项通知无需挂起扩展。
- 扩展 `start` 在激活前分配 sessionId，因而激活期的交互请求也可绑定会话。主进程只向对应 `sender.send(IPC.MODULE_THEIA_RUNTIME_MESSAGE)` 发消息；响应必须经过正式 `modules.theiaInstalled({op:"messageRespond"})` IPC。窗口销毁与显式 Stop 会清理等待队列。
- `TheiaRuntimeMessageHost` 在 App 根部订阅（不依赖扩展设置页是否打开）：纯通知进入原有 `useToastStore`，交互请求按用户实际点击的选项下发句柄；模态请求重用 Mcode `useFocusTrap` 保障键盘交互，限时自动取消且不后台轮询。
- 使用真实 Theia 子进程加载 `spawn-ext`，执行 `mcodeSmoke.askChoice` 与 `mcodeSmoke.notifyWarning`；断言真正得到二号选项 `"Ignore"`，并收到 warning UI 消息。安装测试 **71/71 PASS**。消息安全/面板专项 **40/40 PASS**。
- 联合 E1 **12/12 suites PASS**：`apps/desktop/.tmp/smoke-runs/1792915756140-35612-l06pov/`。双包 `pnpm exec tsc --noEmit` **PASS**。vendor/theia 未修改。
- 真实 Electron U1 操作 UI 尚未运行，不能声称焦点、动画、操作回执的真窗口验收完成。VS Code 未实现的其他 `Main` 服务仍需要继续二开。
- Code commit SHA: `4805a5f4`（14 个本对话独占源码/专项测试文件，保留其他并行对话未提交修改）；台账提交另行记录。
