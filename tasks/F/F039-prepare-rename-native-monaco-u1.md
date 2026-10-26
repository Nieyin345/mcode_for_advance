# F039｜prepareRename 与真实 Electron Monaco 重命名/快速修复交互

- Status: **真实扩展 E1 + 隔离 Monaco/Electron U1 已完成；产品完整 Electron U1、打包及性能仍未验**。
- Depends: F038. Required Skills: `mcode-smoke`, `desktop-testing-electron`, `codebase-design`。
- 独占范围：Theia host 的 `host.ts`、`installedRegistry.ts`、`languageResults.ts`；Monaco `theiaLanguageProviders.ts`；`packages/contracts/src/ipc/modules.ts`；Theia 两套 smoke；新增 `apps/desktop/scripts/theia-native-u1/`；`tasks/F/` 任务台账。任何其他主线、UI 组件、vendor 改动均保留且不提交。

## 功能

1. **prepareRename 正确范围**：Theia 原始 `LANGUAGES_MAIN.$registerRenameProvider(handle,...,supportsResolveLocation)` 的布尔元数据经宿主目录进入原生 Monaco；`resolveRenameLocation` 调用真实 `LANGUAGES_EXT.$resolveRenameLocation`，返回合法 0-based range 和 placeholder，F2 不再只能猜测 Monaco 默认单词。无准备能力的插件不提供此可选回调；同语言多个 Rename Provider 中优先选用有 prepare 能力的 Provider，保持准备和提交选中同一个 Provider。
2. **严格运行边界**：重命名前范围必须在当前文件文本有效行列内、placeholder 有界；`editContext.prepare` 必须是布尔且不得夹带任意危险字段，正常 Rename 仍必须有 `newName`。沿用会话、模型版本、取消、超时与 IPC 的单次校验。
3. **WorkspaceEdit 整单拒绝改进**：当前文件 TextEdit 额外拒绝同坐标重复零宽插入、带 query/fragment 的 `file:` URI、非法 snippet 属性；合法相邻编辑仍允许，所有跨文件、文件操作、重叠/越界仍 fail-closed，不做部分应用。
4. **不重复造编辑器/测试体系**：新增 U1 旅程复用 `apps/desktop/scripts/electron-u1/build.mjs` 的隔离 Electron runner，打包原生 `monaco-editor` 与产品 `registerTheiaLanguageProviders`，在真窗口执行 F2、名称输入、Enter、Ctrl+Z、Ctrl+.、Code Action 确认/撤销，以及拒绝 Rename 不得更改文本；只替换扩展 `api` IPC transport 为确定性夹具。没有改 FileEditor 或现有并行 UI owner 文件。

## 验收证据

- `node apps/desktop/scripts/run-smokes.mjs theia-installed-smoke theia-palette-smoke theia-host-boot-smoke`：**3/3 PASS**，真实 Theia 子进程 **145/145**，原生 smoke **86/86**；日志 `apps/desktop/.tmp/smoke-runs/1792994902020-25072-XIbsmW/`。
- 双包 `pnpm exec tsc --noEmit`：**PASS**；`git diff --check`：**PASS**。
- **真正 Electron 44 + Monaco 编辑器 U1：1/1 PASS**，证据 `.tmp/electron-u1/2026-10-26T06-05-54-853Z/`。真实输入/按键驱动，检查重命名范围、改文、撤销、快速修复菜单、应用、撤销以及扩展拒绝时无修改；`prebuild` 用项目现有 esbuild，不新增 npm 依赖。
- U1 变异 1：故意把 Code Action 编辑结果 `fixed-text` 改为 `broken-fix`，旅程按预期红于 `fix-changed-real-monaco`，证据 `.tmp/electron-u1/2026-10-26T05-57-40-369Z/`。
- U1 变异 2：故意把 prepareRename placeholder `native-text` 改为 `broken-prep`，旅程按预期红于 `provider-prepare-rename-placeholder`，证据 `.tmp/electron-u1/2026-10-26T06-05-11-252Z/`；变异后已逐字节恢复夹具 SHA `7a146dd3423453a2ef5dbe41fd70ccaf82917de5e0c019af235c93817ffbaf1f`，再次 U1 PASS。
- 12 套联合回归：**11 PASS / 1 FAIL**，日志 `apps/desktop/.tmp/smoke-runs/1792994780067-38348-w6reST/`；仅外部 `ipc-wiring-smoke`（文档 `mcode:document-view:write-recovery` preload 缺口）失败；不属于扩展线，无越界修复。
- 代码提交：`feca10cb`，11 个 F 线文件；保留并行修改。

## 限制与后续

- **U1 的范围是实际 Electron + 实际 Monaco + 产品语言 Provider 适配器 + 测试 IPC 夹具**；不是产品原版 App.tsx/原版 preload + 真实 VSIX 完整链的 U1。真实 Theia 后端另由 E1 子进程 smoke 核验，不可合并冒充全链路 U1。
- 隔离 U1 出现 `Could not create web worker(s)`（测试页面使用 file:// 单文件 Monaco bundle，worker 主线程 fallback）警告；因此不据此宣称性能、线程隔离或发布级流畅度。
- 跨文件 Rename/Code Action、命令型操作、延迟解析、应用前用户审批/原子回滚尚未实现；真实产品窗口 U1、发布打包、p50/p95/RSS 与系统沙箱均未验。
- **下一阶段**：验证真正 App/preload/VSIX 的安装→运行→原生编辑器全过程，补齐 Monaco Worker 打包与整条路径的安全/性能证据；没有全工作区事务/用户授权前不放开跨文件修改。
