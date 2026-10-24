# F024｜Theia 编辑事务桥与构建闸门（批量实施）

- Status: done (headless E1 only; not Electron U1)
- Category: P0 扩展二开
- Depends on: F022 / F023
- Required Skills: `mcode-smoke`（已阅读并采用小范围无头回归）
- Exclusive writable files:
  - `apps/desktop/src/main/modules/theiaHost/host.ts`
  - `apps/desktop/src/main/modules/theiaHost/editorTransactions.ts`（新增）
  - `apps/desktop/scripts/theia-host-boot-smoke/main.ts`
  - `apps/desktop/scripts/theia-host-boot-smoke/fixtures/spawn-ext/extension.js`
  - `vendor/README.md`
  - `tasks/F/README.md`、本卡

## 目标与实际实现

1. 原生 Theia `TextEditor.edit()` → `TEXT_EDITORS_MAIN.$tryApplyEdits` → Mcode editor-owner 事务回调。Mcode owner 有权确认或拒绝，并负责实际写盘/Monaco undo；没有 owner 明确 false，不做任何文件写入。
2. 用 1-based Monaco range 解析、UTF-16 偏移、倒序原子替换与重叠防护；拒绝非法范围、未适配的 `setEndOfLine`、未确认的写入；对写后文档递增版本并通知 Theia `DOCUMENTS_EXT.$acceptModelChanged`。
3. 现有 Theia 宿主测试缺构建产物时 `exit=2`（`BUILD_REQUIRED`），不再 `0/0` 退出成功。
4. 上游重建指南补全 `plugin-ext-vscode` 构建步骤。

## 测试与真实边界

- `node apps/desktop/scripts/run-smokes.mjs theia-host-boot-smoke`: PASS（后续附最终证据）。
- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`: PASS。
- 故意指定不存在的 `MCODE_SMOKE_THEIA_ROOT`：套件 **FAIL exit=2**，打印 `BUILD_REQUIRED`（预期负控）。
- 真实编辑事务通过 *测试 editor owner* 验证：用户编辑器收到变更并提供单步历史；通过原生 Theia 宿主 RPC 测得编辑后文档同步。此处没有直接连接正在改造的 React/Monaco UI。
- **NOT-COVERED**：真实 Electron/Monaco undo/redo；全量 VS Code API；用户安装 UI → Theia Host 的产品 IPC；运行时沙箱。不要将本卡表述为这些功能完成。

## 合并与保护

保留现有所有未提交修改，不执行 reset / clean；只 stage 本卡独占文件。THEIA checkout 保持干净，`patchSeries` 仍为空，因为本卡是 Mcode 宿主适配而非改动上游。

## 结果回写

- 代码提交：`eb840278`（5 文件，精确暂存，无其他会话文件）。
- `theia-host-boot-smoke`：**50/50 PASS**（包含编辑事务及真实 `james-yu.latex-workshop` 信息性验证：71 条命令、0 条激活错误），日志：`apps/desktop/.tmp/smoke-runs/1792870465054-36228-0QlY0N/theia-host-boot-smoke.log`。
- `theia-vendor-smoke`：**34/34 PASS**，日志：`apps/desktop/.tmp/smoke-runs/1792870473017-25712-32UQeT/theia-vendor-smoke.log`。
- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`：**PASS**。
- 缺构建产物的独立负控：**预期 FAIL(exit=2，`BUILD_REQUIRED`)**，日志：`apps/desktop/.tmp/smoke-runs/1792870392997-37256-9IWSkR/theia-host-boot-smoke.log`。这不是产品测试失败，而是确认 fail-closed。
- `git diff --cached --check`：**PASS**；`vendor/theia` 工作树保持干净。
- 仍未达成：真实 Monaco UI / undo 的 U1、产品安装 IPC → 新宿主闭环、完整 API 兼容与扩展运行时隔离。
