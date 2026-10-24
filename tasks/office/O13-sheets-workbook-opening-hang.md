# O13｜Sheets“正在打开工作簿…”卡住（已复现，根因未定）

- Status: **BLOCKED：可复现真实 Electron 红例，待有界定位与修复**
- Priority: P0 可用性（界面有格子、工作簿未进入可编辑状态）
- 归属：ARC-007 / Office；**不得因为一个读写 smoke PASS 就伪报此项已关闭**。

## 已复现的具体问题

在 `apps/desktop` 目录运行：

`node scripts/o2-conflict-u1-smoke/run.mjs --only=o2-conflict-sheets --variant=expect-green`

实测 `o2-conflict-sheets` 在 `negative-edit` **unexpected-failure**，等待 120 秒仍显示 `正在打开工作簿…`；DOM 节点约 614，画布、名称框 A1、Sheet1 以及 Mcode 換壳 UI 全挂载，`workbook:select` 日志已通过 IPC 围栏。失败不是“截图空图”——截图 fallback 的报错与 DOM 数据态失败是两件事。真实证据：

- `.tmp/electron-u1/2026-10-24T18-56-36-683Z/o2-conflict-sheets/journey-result.json`（`negative-edit` 红例、`status`、`box`、DOM snapshot）
- `genoffice/apps/sheets/src/main/sheets-main.ts:2820-2892`：`openSelectedWorkbook` → `prepareWorkbookForOpen` → `openWorkbookSession` → sidecar `open`
- `genoffice/apps/sheets/src/renderer/App.tsx:4604-4634`：`handleInspectWorkbook` 只在 select/openLazy 失败或 `onInitialRangeLoaded` 被回调时解除 `openingWorkbook`。
- `App.tsx:4259-4568`：`openLazyWorkbook` 在 fonts、Univer 骨架和首轮 `loadVisibleRange` 之间具有多个异步阶段。必须找到哪一阶段没有 settle，不能凭 DOM 空壳猜测 sidecar 失败。

本次隔离测试 `userData` 下没有 `sheets-autosave` 恢复副本，因此“恢复提示在屏外等待”**暂无该红例证据**；此前 sidecar 直接 open 示例曾在 12ms 成功，但不等于本次主进程的 snapshot/sidecar/renderer 链真实全部成功。

## 下一步精准诊断门槛

1. 保持 O2 相同隔离样本和真实 Electron 环境，在不改生产工作簿的前提下记录 `workbook:select` 主进程 **进入/返回/拒绝/耗时**；对照 `snapshotWorkbook`、sidecar `open` 是否完成。
2. 若 main 已返回，则在 renderer 记录 `selectWorkbook` 返回、`untilCellFontsLoaded` 返回、`loadWorkbookSkeleton`、`requestAnimationFrame`、`loadVisibleRange` 首次成功/失败及 `onInitialRangeLoaded` 回调。只报告实际没有 settle 的阶段，先收集红例，再修根因。
3. 必须重新运行该同一 U1 旅程，证明从真实文件打开到 editable、保存冲突拒写、关闭、重开；补充异常路径/失败提示和负控。不得仅增加测试超时、无条件 `setOpeningWorkbook(false)` 或伪造空 `WorkbookFile`。与其他 Electron U1 并发时须独占测试窗口。
