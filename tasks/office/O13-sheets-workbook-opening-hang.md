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

---

## 2026-10-25 有界实现与验收记录（本轮）

**版本**：GenOffice `f6d8e8a3c0e99e9328dc6fa7dd76ca559518545e`，父提交 `ec21271a1b502154c6be6568c43ba8c4b0ae30e2`。新树 `34b48057f108cc762da580911a5d912aeacc6cce`。第 25 条原厂补丁 `patches/genoffice/0025-fix-sheets-hidden-frame-hydration.patch`，6096 bytes、SHA256 `c13afa894bc417f038b1dd75d3b858ad9f1a019d0c01ad20403236c456bb584f`；两个版本锁文件已前移，来源验证输出 25 patches 且退出 0。

**定位证据**：原始 U1 红例确定为主界面存在但 `openingWorkbook` 始终为真。临时在 `openSelectedWorkbook` 的 prepare/sidecar open 及前端 selected/fonts/skeleton/RAF/initial-range 处放诊断标记；带探针重复运行的三个 `o2-conflict-sheets` 单旅程全部 PASS，主进程日志明确显示 `prepare`、sidecar `open` 完成和最后的保存冲突拒写。**该情况说明时序敏感，并未证明历史超时一定发生在某一具体阶段**。诊断标记现已全部清除，未提交进产品。

**针对已识别的真实风险**：`openLazyWorkbook` 的首轮 hydration 原先**完全依赖单次 `requestAnimationFrame`**。Electron 视图在创建、预热和驻留期间可被隐藏或遮挡，首帧可能迟迟不到。现抽出 `initial-hydration-frame.ts`，保留 rAF 优先，同时用 250 ms 定时触发**同一份 hydration**，一次性互斥；若会话已切换，则旧回调不处理数据。这不是伪造加载完成，也不是直接去掉遮罩。`apps/sheets/tests/initial-hydration-frame.test.ts` 3/3 PASS：rAF 长期不来、rAF+定时器先后抵达不会执行两次、取消不再执行旧回调。移除 fallback 的变异使「无首帧」判据 **1 fail / 2 pass**；恢复后 **3/3 PASS**。 `@genoffice/sheets` typecheck PASS。

**尚未达到验收标准**：修复后的真 Electron `o2-conflict-sheets` 复跑连续两次被其他对话正在运行的 `heavy-test-lease` 合法拒绝启动（分别是 PID 44968、24524）；这些是**测试未执行**，绝不能按失败或通过计入 Sheets 功能质量。最终 U1 验证、真实显示/隐藏切换重开及高负载稳定性仍未完成。O13 维持 `PARTIAL / U1 BLOCKED`，不能标记完成。应在 Electron 测试独占锁空闲时复跑同一旅程，并在能看到红例时进一步缩小到主进程还是前端回调；不能说已证明彻底根治。

**来源 smoke 调用纠正**：一度在同一个 cmd 中先 `set MCODE_INCLUDE_GENOFFICE_BUNDLE=1` 运行上游锁校验，再运行 `genoffice-source-smoke`，使套件的“默认 opt-out”负控错误继承启用标志，失败在缺失的空锁文件；这**不是源码锁失败**。改为全新命令行独立执行 `node apps/desktop/scripts/run-smokes.mjs genoffice-source-smoke` 后 **1/1 PASS**；源锁 opt-in 校验单独 **25 patches PASS**。
