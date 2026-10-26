# F038｜真实 VS Code Rename / Code Actions 接入 Mcode Monaco

- Status: **E1 代码闭环已实现，Electron U1 / 正式发布未验**
- Depends: F037. Required Skills: `mcode-smoke`, `codebase-design`, `code-review`.
- 本轮 F 线写入边界：`apps/desktop/src/main/modules/theiaHost/{host,installedRegistry,languageResults}.ts`、`apps/desktop/src/main/ipc/theiaInstalled.ts`、`apps/desktop/src/renderer/lib/theiaLanguageProviders.ts`、`packages/contracts/src/ipc/modules.ts`、三套 Theia 专项 smoke 与真实扩展 fixture，以及 `tasks/F`。其他并行源码、暂存文件、vendor/theia 不修改。

## 本轮实现

1. **重命名（当前文档）**：`LANGUAGES_MAIN.$registerRenameProvider` → Theia 真实 `LANGUAGES_EXT.$provideRenameEdits` → Mcode Monaco `registerRenameProvider`。真正调用真实插件，使用当前 Monaco 模型/版本做 editorSync，然后返回 Monaco `WorkspaceEdit`；没有让扩展自行写盘。保留扩展返回的拒绝原因；无安全编辑时返回明确拒绝，不伪造成功。
2. **Code Actions / Quick Fix（当前文档纯编辑）**：`$registerQuickFixProvider` → `$provideCodeActions` → Monaco `registerCodeActionProvider`。携带 0-based 选区与 trigger；仅承载有具体纯 TextEdit 的操作。明确排除扩展命令、文件操作、外部文件、需要确认的更改以及需要延迟 `resolveCodeAction` 的操作；在主进程归还 Theia 缓存 ID，避免长期积累。
3. **统一 fail-closed 范围**：严格 `TheiaInstalledInputSchema` 的 `editContext`，新名字最多 256 字符、行列范围有界。 `localWorkspaceTextEdits` 必须确认 WorkspaceEdit 所有编辑都只指向当前文档，单次最多 80 条，拒绝空集、越界、重叠、snippet、文件编辑、跨文件、确认必需条目与文本过大；一条坏编辑即整单拒绝，不部分应用。
4. **与 Mcode 深度集成**：复用 Theia 扩展宿主、owner-scoped session、既有 1.8 秒限时语言 RPC、当前编辑器快照同步与 model 版本/cancellation；在 Monaco 侧仅返回 edits，实际应用/撤销由 Mcode 原生编辑器拥有。不增加第二编辑器、宿主或轮询。

## 真实证据

- 真实 Theia VSIX 子进程 `theia-installed-smoke`：**143/143 PASS**，包括 Rename 同文档编辑、跨文件重命名整单拒绝、Code Action 当前文档安全修复与命令/跨文件过滤、缺少新名/选区的拒绝。
- 原生 Mcode `theia-palette-smoke`：**81/81 PASS**，含严格 WorkspaceEdit 资源归属、安全拒绝、IPC schema、原生 Monaco provider 接线；`theia-host-boot-smoke` PASS。
- 专项最后复跑日志：`apps/desktop/.tmp/smoke-runs/1792986955142-36496-7XWQSN/`。
- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`、`pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json`：**PASS**。
- 联合 12 套：**11 PASS / 1 FAIL**，日志 `apps/desktop/.tmp/smoke-runs/1792986850802-56776-0IGMhl/`。唯一失败是并行文档线 `ipc-wiring-smoke`：`mcode:document-view:write-recovery` 主进程有 handler，但 preload 缺通路；不在本卡范围，没改变判据。
- 变异验证：故意将真实 VS Code Code Action 返回的 `safe-fixed` 变为 `deliberately-broken`，真实子进程套件 **142/143**，已恢复后变回 143/143。恢复夹具哈希：`585e2aca38b3c36fac27de4748739975f1880007a8a7e9d15645eb2526588d35`，与变异前一致。
- `git diff --check` PASS，代码提交 **`ffdfa09a`**，9 个扩展专属源/测试文件，+221/-16；工作区其他对话修改全部保留。

## 尚未完成

- **跨文件 Rename、跨文件 Code Action、Resolve Code Action、命令型 Fix、文件创建/删除**：当前**故意不支持**，不能声称完整 VS Code 兼容；未来需要 Mcode 全工作区事务、用户审批和一致性回滚支持。
- Monaco 真实 Electron U1、上下文菜单/重命名确认/撤销操作、打包资源、性能 p50/p95/RSS 尚未验证。本阶段为真实 Theia Node 子进程 E1，不是产品级验收。
- 全量联合回归不绿（文档 IPC 外部 owner 问题）；没有修其他对话所有权范围。
- 扩展 Node 运行时仍非沙箱。安装前披露不是运行时隔离；不得用编辑查询过滤规则声称限制扩展自身的 Node fs/网络访问。

## 下一步

优先验证真实 Monaco/Electron UI 中 Rename 和 Quick Fix 的交互、确认/撤销及焦点；后续是否开启跨文件事务，应先独立定义审批与回滚模型，再补命令型 Code Action。
