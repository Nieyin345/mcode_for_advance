# F036｜原生 Monaco 文档大纲、格式化、函数签名

- Status: **E1 实现并完成真实 Theia 子进程测试；Electron U1 / 发布构建尚未验**
- Depends: F035。Required Skills: `mcode-smoke`、`codebase-design`。
- F 扩展线独占范围：`apps/desktop/src/main/modules/theiaHost/{host,installedRegistry,languageResults}.ts`、`apps/desktop/src/main/ipc/theiaInstalled.ts`、`apps/desktop/src/renderer/lib/theiaLanguageProviders.ts`、`packages/contracts/src/ipc/modules.ts`、`theia-installed-smoke`、`theia-palette-smoke`、`theia-host-boot-smoke` 测试夹具、`tasks/F/` 台账。保留其他对话工作区及 index 暂存修改。

## 功能与集成行为

1. 真正的 VS Code `languages.registerDocumentSymbolProvider` 经 Theia `LANGUAGES_MAIN.$registerOutlineSupport`、`LANGUAGES_EXT.$provideDocumentSymbols` 接入 Mcode Monaco `registerDocumentSymbolProvider`，可在原生大纲/符号 UI 中使用，保留嵌套层级、符号种类与选区。
2. 真正的 `languages.registerDocumentFormattingEditProvider` 经 `$registerDocumentFormattingSupport` 与 `$provideDocumentFormattingEdits` 接入原生 Monaco `registerDocumentFormattingEditProvider`。格式化只返回编辑建议，由 Mcode 的 Monaco 模型执行编辑与撤销，不接受扩展直接写磁盘。传递 tabSize 和 insertSpaces。新增 `languageResults` 集中适配层，限制 200 个编辑/100 KiB 文本、拒绝异常范围与重叠编辑、单个编辑至多 8 KiB。
3. 真正的 `languages.registerSignatureHelpProvider` 经 Theia `$registerSignatureHelpProvider`、`$provideSignatureHelp` 接入 Monaco `registerSignatureHelpProvider`，保留触发/重触发字符、签名文本、参数和 active 索引。结果最大 16 签名、每签名 32 参数，处理字符串及 Markdown 说明，释放宿主的 signature cache ID。
4. 与 F034–F035 共享 owner-scoped `languageQuery`、短超时、当前 Monaco 内存模型同步与版本检查。新会话注册走贡献事件，不增加第二工作台、后台轮询或额外语言服务进程。新能力失效或取消时返回空结果，不阻断 Mcode 编辑器。
5. `TheiaInstalledResult` 仅扩展既有 `languageResult`，增加格式化/大纲/签名的有界 JSON 结构；`languageQuery` 增加格式选项和签名上下文（严格 schema）。不扩展未授权跨窗口访问。

## 验收证据

- 最新真实 Theia installed smoke **132/132 PASS**。包含真实扩展注册与调用上述三种 Provider，验证大纲位置、编辑格式选项、签名参数/触发字符，以及原有文件、终端、配置、Webview、导航和生命周期。日志：`apps/desktop/.tmp/smoke-runs/1792950040582-36624-pgCDis/theia-installed-smoke.log`。
- 原生 Mcode palette/adapter smoke **72/72 PASS**。包含主进程 untrusted 语言结果的异常坐标、重叠 TextEdit、超长返回、符号范围与签名索引检查，以及原生 Monaco provider 接线/事件驱动和旧能力断言。日志：`apps/desktop/.tmp/smoke-runs/1792950040582-36624-pgCDis/theia-palette-smoke.log`。
- `theia-host-boot-smoke` PASS。
- 桌面、契约 TypeScript：`pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json` 和 `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` **PASS**。
- 12 项联合回归 **11 PASS / 1 FAIL**，`apps/desktop/.tmp/smoke-runs/1792950040582-36624-pgCDis/`；唯一失败 `ipc-wiring-smoke` 由于并行 Document View 路由 `mcode:document-view:write-recovery` 仅主进程有 handler、preload 未识别。F036 不越界修改文档模块、preload 或测试断言。
- 仅源码与自动化集成测试，不等同真实 Electron U1 交互/性能测量；`vendor/theia` 无修改。

## 未达成/非目标

- **未达成：全部 12 联合套件 PASS**（前述外部文档 IPC 路由）。
- **未达成：真实 Electron UI U1**：未验证 Ctrl+Shift+O 大纲、格式化快捷键、函数参数浮层、主题/焦点视觉与真发布版。
- 未实现 Range Formatting、on-type Formatting、Rename、Code Actions、Inlay Hints、Semantic Tokens、Diagnostics 完整 LSP 合并；Debugger/Tasks/Webview 资源协议与全量 Theia 打包、OS 沙箱仍属下一批。
- 不声称真正跨操作系统兼容、完整 VS Code API 或延迟/RSS 达标。Node 扩展依旧依赖既有安装前风险告知，不是沙箱。

代码提交：`7749ce05`（9 个本卡源码/测试文件，新增 323 行、删除 18 行；仅指定路径提交，没有提交其他对话已暂存代码）。台账随索引单独提交。
