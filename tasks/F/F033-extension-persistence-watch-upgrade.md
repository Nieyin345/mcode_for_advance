# F033｜扩展长期可用：状态持久化、文件监听、安全升级、原生诊断

- Status: **E1 实现完成，仍需 Electron U1 与更多真实第三方扩展验证**
- Depends: F032; Required Skills: mcode-smoke, codebase-design.
- Scope: Theia host / persistent registry, desktop IPC & preload, Mcode native renderer diagnostics, VSIX manager, contracts IPC declarations, isolated real-extension fixtures/tests, task ledger. No edits to other dialogues' dirty files.

## 本批完成

1. **真实扩展状态**：替换 Theia `STORAGE_MAIN` 空方法。读取和写入 `context.globalState`、`context.workspaceState`，按扩展安装目录保存至限定大小的原子 JSON 文件；workspaceState 按已解析的 Mcode 工作区真实路径区分，globalState 跨项目共享。宿主 `$init` 注入保存的状态，使用异步写入队列避免并发更新丢失。没有把密码当成 secrets API 实现。
2. **原生项目文件监听**：单宿主单条 `fs.watch({recursive:true,persistent:false})`，文件变化节流合并后通过 Theia 真正的 `ExtHostFileSystemEventService.$onFileEvent` 通知扩展；真实 VS Code `createFileSystemWatcher` 事件通过测试。同步注册显式 watch 需解析到当前 Mcode 工作区；不支持则明确拒绝，不伪造可用。宿主停止时释放监听器、timer 与待发事件。不后台轮询；Windows 已验证，其他平台支持受 Node fs.watch 能力约束。
3. **同身份 VSIX 原位升级**：现有安装的更高语义版本允许重新预检、展示版本变化、重新人工同意。扩展运行中禁止升级；旧安装先过完整完整性校验，升级后保留 installation ID、enabled、安装时间、配置和 state；旧版本先移至 staging 备份，替换与用户 storage 转移失败时尝试恢复，构造管理器时保守恢复遗留旧版备份。升级过程不自动执行扩展。该保护不等于已进行 OS 断电注入 U1。
4. **启动锁正确性**：工作区无效也落到 `finally`，不再导致扩展管理器卡在 starting 状态。
5. **原生诊断标记**：实现 `LANGUAGES_MAIN.$changeDiagnostics/$clearDiagnostics`，将扩展诊断按会话和 collection 转到 Mcode 根层；真实 Monaco 模型以独立 owner 调用 `setModelMarkers`，保留已有 Mcode LSP 标记，关闭/停止会话清理自身标记。无新的 Theia 工作台。高阶语言服务 providers 仍未接线。

## 已核验 E1 证据

- `theia-installed-smoke` **106/106 PASS**：真实 Theia 子进程、状态写入与重启恢复、另一个项目工作区隔离、外部项目文件事件进入 `createFileSystemWatcher`、升级 1.0.0→1.1.0 保留 ID 与用户存储、新版执行验证、重复版本/降级/运行中拒绝、不同窗口票据拒绝、模拟备份恢复、无效工作区后恢复启动、真实诊断 IPC。
- `theia-palette-smoke` **53/53 PASS**：含注入 Mcode Monaco 替身后，诊断 owner markers 设置及停止清除。
- 联合回归 **11/12 suites PASS**：`apps/desktop/.tmp/smoke-runs/1792921750190-17820-Wxz4Fc/`。唯一 FAIL：并行 Document View 工作的 `mcode:document-view:write-recovery` 主进程新增 IPC 尚未在其 preload 对齐，属于其他任务范围，不改其文件或判据。
- `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` PASS；Desktop 全包 TS 仍受并行 `apps/desktop/src/main/workflowEngines/nativeLibrarySync.ts:647` TS2367 报错阻塞（当前一处，未改）。
- `git diff --check` PASS；`vendor/theia` 无修改。未重置/清理任何其他执行对话修改。

## 明确未完成

- 真 Electron 窗口 U1（Monaco / 编辑器标记、升级 UI、提示、插件资源占用和交互）仍未跑；无可发布产品断言。
- Webview/WebviewView、Debugger、Terminal/Tasks、Language providers (hover/completion/references 等)、复杂配置和多根工作区、文件搜索完全 glob 语义、依赖解析、自动激活事件与 Extension Host 合并、多扩展统一 ModuleHost 管理、Theia 打包、真正 OS 级沙箱未完成。
- 文件系统监听依赖平台能力，可能遇到事件重复/平台丢事件；限额与 65 ms 合并缓解开销，不宣称可靠性等同 VS Code。
- VSIX 状态文件按 Mcode 数据根存储，**不是秘密安全存储**。Node 扩展运行时仍无沙箱，不代表其 Node 原生 `fs` 访问被工作区隔离。
- Backups 尽量保守恢复，但没有做真实断电中断测试；异常备份保留供手工恢复，不自动销毁。
- Code SHA: `79ee2a72`（17 个扩展专属源码及测试文件精准提交；其他并行会话未提交文件保持原样）；Ledger SHA 另提交。
