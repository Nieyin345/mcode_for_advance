# F037｜选区与输入时格式化接入 Mcode 原生 Monaco

- Status: **E1 实现并完成真实 Theia 子进程验证；Electron U1、发布构建未验**
- Depends: F036。Required Skills: `mcode-smoke`、`codebase-design`、`code-review`。
- 独占写入：`apps/desktop/src/main/modules/theiaHost/{host,installedRegistry}.ts`、`apps/desktop/src/main/ipc/theiaInstalled.ts`、`apps/desktop/src/renderer/lib/theiaLanguageProviders.ts`、`packages/contracts/src/ipc/modules.ts`、3 套相关 smoke/夹具、`tasks/F/` 台账。其他对话工作区不动。

## 本轮实现

1. **真实 VS Code 选区格式化**：Theia `LANGUAGES_MAIN.$registerRangeFormattingSupport` → `LANGUAGES_EXT.$provideDocumentRangeFormattingEdits` → Mcode 原生 `registerDocumentRangeFormattingEditProvider`，转发 0-based range、tabSize/insertSpaces。由 Monaco 持有编辑模型、撤销与最终修改，不允许 Provider 直接覆盖磁盘。
2. **真实输入时格式化**：`$registerOnTypeFormattingProvider` → `$provideOnTypeFormattingEdits` → 原生 `registerOnTypeFormattingEditProvider`，准确传递用户输入的字符和光标位置。只有 Provider 注册的单字符触发器可调用；坏字符或空字符拒绝。多个同语言同类 Provider 的触发器合并，避免最后一次注册遮蔽前一个 Provider。
3. **统一协议与安全**：严格 TheiaInstalledInputSchema 有界 range/formatContext，不新增旁路 IPC。复用原有 owner/session 与当前 Monaco 快照/version/cancellation 检查、1.8s 查询超时。复用 `languageResults.formattingEdits` 过滤异常 TextEdit、超长结果与重叠编辑，并对多个 Provider 的合并结果再执行一次全局去重/限额；停止会话后查询结果不再交给主 UI。
4. **功能优先与轻量路径**：无新 Electron 窗口、无第二编辑器、无后台轮询、无额外常驻 Node 进程；Theia 仍按现有扩展会话管理。

## 可核验验收

- `node apps/desktop/scripts/run-smokes.mjs theia-installed-smoke theia-palette-smoke theia-host-boot-smoke`：**3 PASS/0 FAIL**；真实 Theia VSIX 子进程 smoke **138/138 PASS**，Monaco 原生适配/参数校验 smoke **76/76 PASS**。最终日志：`apps/desktop/.tmp/smoke-runs/1792951382330-49972-TgJx19/`。
- `pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json` 与 `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`：**PASS**。
- 12 套扩展/宿主/权限/IPC 联合回归：**11 PASS / 1 FAIL**。仅 `ipc-wiring-smoke` 因已有文档线 `mcode:document-view:write-recovery` handler 有而 preload 不存在而失败；不属于 F 独占文件，本卡没有更改它。日志：`apps/desktop/.tmp/smoke-runs/1792951122900-50616-cT7mgP/`。
- 变异验证：临时将真实选区格式化 Provider 返回文本改为 `broken-selection`，`theia-installed-smoke` **136/137 FAIL**，复原后绿。复原时原夹具哈希与修改前一致（`7848532c5e4202f2f633c8608773b79c67bdfa0f2be45ba11c859439af1231c2`）；之后额外加入第二个同类 Provider 的真实兼容性测试。
- `git diff --check`：通过。扩展专属代码提交 `1d218541`（8 文件，+165/-19）；没有提交并行任务的已暂存内容。

## 未达成及非目标

- **Electron U1 尚未完成**：未通过真实窗口 Ctrl+K Ctrl+F 选区格式化、自动缩进/输入事件/光标与撤销视觉体验、不同主题/聚焦状态验证；E1 不能冒充 U1。
- **联合 12 套未全部 PASS**：外部文档路由 preload 问题需其独占 owner 处理，不能为绿改动安全判据。
- Rename/Code Actions/Inlay Hints/Semantic Tokens、Webview URI、Debugger/Tasks、完整扩展 API 兼容、正式 Theia 资源打包与 OS 沙箱均未验收。
- 扩展本身仍是没有进程沙箱的 Node 代码；安装前告知不等于运行时隔离。性能没有实测 p50/p95/RSS，不宣称发布品质和全面丝滑。

## 下一步主线建议

继续补齐 VS Code 高级语言编辑操作（Rename/Code Actions）并做真实扩展回归，然后安排 Electron U1/打包评估；任何跨 UI 总控文件改动须先确认独占边界。
