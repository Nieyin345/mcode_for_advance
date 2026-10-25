# F035｜VS Code 代码导航接入 Mcode 原生 Monaco

- Status: **E1 实现与真实 Theia RPC 专项验收完成；Desktop 全量 typecheck 被并行工作区修改阻塞；Electron U1 未验**
- Depends: F034
- Required Skills: `mcode-smoke`、`codebase-design`
- 范围：Theia 宿主语言 Provider 注册、扩展会话/IPC 契约、Mcode Monaco Provider、真实 Theia 扩展夹具与专项 smoke、F 线台账。禁止修改 `vendor/theia`，不得 stage 其他对话的工作区修改。

## 目标

将真实 VS Code 扩展的以下语言贡献接入 Mcode 当前的 Monaco 编辑器：

- `registerDefinitionProvider`（跳转定义）
- `registerReferenceProvider`（查找引用）
- `registerImplementationProvider`（查找实现）
- `registerTypeDefinitionProvider`（跳转类型定义）

不新建编辑器、不启动第二套 workbench；Theia 继续执行扩展 Provider，Mcode Monaco 是唯一 UI/编辑模型所有者。

## 执行与安全边界

1. 用共享的语言 Provider 类型贯穿注册描述符、严格 IPC schema 和查询分发，避免手工第二套映射。
2. 主进程将 Theia 返回的 `Location`/`LocationLink` 统一为文件 URI 与 0-based range，接受序列化的 `start/end` 及 `startLineNumber/startColumn` 两种范围形状；拒绝非 `file:` URI、无效/反向坐标和超过 100 个的位置结果。
3. 引用查询把 Monaco 的 `includeDeclaration` 传回真实 VS Code Provider。扩展查询保留会话 sender 所有权、1.8 秒超时与失败关闭行为。
4. Mcode Monaco Provider 复用当前 editor snapshot / editorSync；编辑版本变化、取消请求、会话停止或 Provider dispose 后不接受迟到结果。跨文件定义通过 Mcode `gotoLocation/openFileInIde` 打开；同文件结果重用当前 model URI，避免造第二份 model。
5. 用真实 Theia 子进程夹具验证四种 Provider 的注册与返回，另验证非文件 URI 被过滤。不能以源码静态断言代替真实 RPC 验收。

## 验收标准

- [x] 真实 Theia Host 注册并调用四类 Provider，主进程返回可解析的文件 URI 和正确的 0-based range。
- [x] References 的 `includeDeclaration=true/false` 语义保留。
- [x] 非文件 URI 被过滤；位置范围与数量均有主进程校验。
- [x] Mcode Monaco 注册/释放四类 Provider；跨文件导航走原生文件打开流程，同文件复用当前 model。
- [x] `theia-installed-smoke`、`theia-palette-smoke`、`theia-host-boot-smoke` 通过。
- [x] Contracts 类型检查、`git diff --check` 通过。
- [ ] Desktop 全量类型检查未通过：并行工作区修改 `WorkflowLibraryView.tsx` 报 `requiresConfirmation` 缺失，`webApi.ts` 报 `confirmMigration` 契约缺失；两文件不属于 F035，本卡不越界修改。
- [x] 代码提交已精准限定本卡源码/测试文件；代码 SHA 与未达成判据已回写。当前任务卡和 F 线索引随文档提交。

## 验收记录

- `theia-installed-smoke`: **128/128 PASS**。真实 Theia 子进程实际注册/调用四种 Provider；定义位置 URI/range 规范化；`includeDeclaration` 正反语义；非 `file:` 位置被过滤。日志：`apps/desktop/.tmp/smoke-runs/1792947993469-33096-tjyxoN/theia-installed-smoke.log`。
- `theia-palette-smoke`: **66/66 PASS**，覆盖四类 Monaco Provider 注册、同文件 model URI 重用、跨文件 `gotoLocation`、版本/取消检查和资源释放。日志：`apps/desktop/.tmp/smoke-runs/1792947993469-33096-tjyxoN/theia-palette-smoke.log`。
- `theia-host-boot-smoke`: PASS。
- 联合 12 套回归：**11 PASS / 1 FAIL**，日志目录 `apps/desktop/.tmp/smoke-runs/1792947820809-47032-SSBxEV/`。唯一失败是并行 Document View 的 `ipc-wiring-smoke`：主进程有 `mcode:document-view:write-recovery` handler，但 preload 未被识别；F035 未修改其文件。
- `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json`: PASS。
- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`: 被并行的 `WorkflowLibraryView.tsx` / `webApi.ts` 类型不一致阻塞（见验收标准）；F035 文件没有报告类型错误。
- `git diff --check`: PASS。
- 变异验证：临时把 Definition Provider 注册 kind 改为 `hover` 后，真实 Theia smoke 明确失败 2 条（Provider 描述符、Definition 返回）；恢复实现后重新通过 128/128。
- Code commit: `bf6e74f7`（8 个本卡源码/测试文件，258 行新增、29 行删除；未提交其他对话文件）。

## 明确不在本卡范围

重命名、代码动作、格式化、签名帮助、语义 token、多文件持续同步、Webview 资源协议、Debugger/Tasks、Electron U1、Theia 发布版打包。不得声称已实现完整 VS Code 语言服务。
