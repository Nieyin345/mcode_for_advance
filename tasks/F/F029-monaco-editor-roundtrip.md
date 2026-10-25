# F029｜Theia TextEditor.edit → Mcode Monaco 真正事务闭环

- Status: done E1 roundtrip（真实扩展/真实 Theia IPC，经 Monaco owner adapter 模拟窗口完成；Electron U1 尚未执行）
- Depends on: F024, F028
- Scope: main registry + existing single `modules.theiaInstalled` IPC method, bounded editor callback push channel; real `EditPane` owner and native command adapter; focused E1 tests.
- Required skills: mcode-smoke, codebase-design
- Exclusive files: `apps/desktop/src/main/modules/theiaHost/installedRegistry.ts`, `apps/desktop/src/main/ipc/theiaInstalled.ts`, `apps/desktop/src/renderer/components/ide/FileEditor.tsx` (narrow hooks only, inspect before touching), `apps/desktop/src/renderer/lib/theiaMonacoOwner.ts` (new), `apps/desktop/src/renderer/lib/theiaCommandBridge.ts`, `apps/desktop/src/renderer/components/modules/TheiaInstalledPanel.tsx`, `apps/desktop/src/preload/index.ts`, `apps/desktop/src/renderer/lib/webApi.ts`, `packages/contracts/src/ipc/modules.ts`, `packages/contracts/src/ipc/rpcMap.ts`, `packages/contracts/src/ipc/events.ts`, existing IPC/policy generators if needed, focused smoke tests and this ledger.
- Preserve every other chat's dirty files; no reset/clean/recursive add; no heavy full suite.

## Acceptance
1. From native Mcode editor snapshot at command invocation (file path, language, actual text, selection), explicitly sync to currently running Theia host. No fabricated editor, no disk write, no auto-start. Limit IPC document to 2 MiB UTF-16 characters and only active same-sender session.
2. Theia `TextEditor.edit` -> actual Monaco owner via bounded main-to-renderer request/response. Owner compares active file and `beforeText`, applies validated Monaco edits with undo stack, verifies resulting `afterText`; any stale editor, model mismatch, timeout, window loss or session close fails closed. New permanent file write forbidden; Ctrl+S / Mcode save owns disk.
3. No listener leaks, no duplicate callbacks; explicit cleanup and tests. UI command path and panel manual execute share one wrapper; no idle polling.
4. Real Theia child smoke plus renderer adapter & IPC mock, dual TS, regression suites.
5. Honest limits: no full live document delta when editor changes between commands, no Electron U1, no multi-extension shared host, no sandbox.


## E1 实现与验收记录

- Mcode 的真实 `EditPane` 通过 `registerTheiaMonacoOwner()` 将其当前 Monaco 模型、文件 URI、选区和文档内容作为唯一 editor owner，模型切换时动态读取，卸载时按原有 `unmountCleanupsRef` 释放事件监听。不另建 Monaco 模型。
- 同一个 `executeTheiaWithMonaco` 同时供 Mcode `Ctrl/Cmd+K` 命令面板和扩展管理面板使用。每次用户主动执行命令前，在同一受验证桌面会话上调用 `editorSync`，最多同步 200 万 UTF-16 字符；没有打开编辑器则明确同步 `null`，防止幽灵选区。没有后台轮询或额外进程。
- 真扩展 `vscode.window.activeTextEditor.edit` 经现有 F024 Theia `TEXT_EDITORS_MAIN` RPC 与 `editorApplyBroker` 发送窗口定向事件 `modules:theiaEditorApply`。只有持有该模型的 Monaco owner 在校验 filePath、`beforeText`、readOnly、模型未切换后，才能 `executeEdits`（遵守 undoStopBefore/After，触发 Mcode LSP/dirty 原有观察者）并回复 `editorApplied`。主进程等待确认才通知 Theia 成功；无真实编辑器、超时、跨窗口或关闭会话均拒绝。
- `execute` 补严格限长的可选字符串参数 `args`，用于真实 `mcodeSmoke.editActive` 的替换文本，不接受任意 JSON 对象。
- Theia 宿主复用同一编辑器桥，不随每次 `editorSync` 创建新代理对象；同步/命令互斥，避免并发 RPC 写入。
- **真实 Theia 进程 E1：`theia-installed-smoke` 60/60 PASS。** 用隔离临时目录安装 VSIX，启动真实 Theia child，执行真实扩展的 `mcodeSmoke.editActive("EDITED")`，经主进程窗口消息返回到模拟 Monaco 的 `executeEdits`，核对正文和 undo stops。也测试重叠编辑、错误文件、卸载编辑器、停止会话。
- **命令面板/反向事务测试：`theia-palette-smoke` 25/25 PASS。** 包含跨窗口/跨会话 ACK 拒绝、重复确认、无编辑器超时默认拒绝、窗口关闭主动拒绝。
- **联合回归 12/12 suites PASS**，最终日志：`apps/desktop/.tmp/smoke-runs/1792911186423-8640-YnVLlz/`。桌面与 contracts 两包 `tsc --noEmit` PASS。
- 不涉及 `vendor/theia` 修改，其他并行对话的 dirty files 原样保留。
- **仍未通过**：Electron **真实窗口 U1**（上文的 Monaco owner 是无头模拟，不是实际窗口测试）；持续实时文档 delta（目前在用户执行命令前同步）；多扩展共享宿主；打包 Theia 运行时；OS 沙箱。不得把 E1 当作 U1。
- F029 代码提交 SHA：`19ec9819`（15 个精确文件，未包含其他对话的 dirty edits）；验收台账另行提交。
