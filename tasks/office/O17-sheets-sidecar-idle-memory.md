# O17｜Mcode 内建 Sheets：共享 Rust sidecar 安全空闲回收

- Status: **2026-10-25 有界交付；单页真实 Electron 打开→编辑→保存→重开 PASS；实际 60s RSS 降幅仍待测**
- 归属：ARC-007 GenOffice 深度集成，承接 O16 主进程资源异步加载与原生 WebContentsView 布局去重；**本项不做 UI**。
- 原则：Mcode 内置一个共享 Sheets 文件/计算服务，原厂 XLSX sidecar 是该服务的计算子进程，不是第二个完整桌面应用；必须保留多标签共同使用、编辑保活、文件保存/冲突和 Mcode AI 工具单入口。

## 代码变化

旧实现 `genoffice/apps/sheets/src/main/sheets-main.ts` 在首个 Sheets view 创建时 `sidecar ?? new XlsxSidecarClient(...)` 和 `client.start()`；当最后一个 Sheets view 销毁，只执行 `closeAllSessions`，sidecar 进程直到整个宿主 `before-quit` 才被 `stopSheetsSidecar` 关闭。这会在用户关闭全部表格、转回 Mcode 聊天/工作流之后仍保留 Rust 进程占用。

**修复**：

- 新增原厂叶子模块 `apps/sheets/src/main/sidecar-idle-retirement.ts`，共享进程空闲回收定时器（**60 秒**宽限期、Node timer `unref`）。
- 真正销毁最后一个 Sheets `webContents` 才进入候选状态，且必须先 `await closeAllSessions(entry)`；此流程将原有的 sidecar `close(sessionId)` 与 temp snapshot 清理全部 settle，然后才开始计时。
- 在定时器触发时**再次**检查 `sheetsTabs.size === 0`、`sidecar` 仍存在和 `XlsxSidecarClient.hasPendingRequests() === false`。如果正有晚到的 workbook:open、save/archive 或读取任务，则整轮继续等待下一段宽限期，**不能杀在运行的文件操作**。
- 新开 Sheets 会话立即取消退休计划，仍保留既有共享 worker 供复用。无表格页时回收只杀 sidecar 子进程，不销毁 Mcode 聊天、内核服务或用户打开的其他 Office 编辑器。将 `sidecar = null` 后调用已有 `client.stop()`；下次打开又按原有 `createSheetsView` 走自动 prewarm，无第二套 Rust 实现。
- 全局 `stopSheetsSidecar()`（程序退出）同时清理空闲 timer，避免退出和闲置释放路径产生重复动作。

## 失败注入与验证

- 新测试 `apps/sheets/tests/sidecar-idle-retirement.test.ts` **7/7 PASS**：有活跃页时不退、宽限期、不重复关闭、重开取消、仍有进行中命令时延迟退、tab 临界区检验、进程已经为空时不重复退。
- 故意**删除 pending guard 的负控变异**：**6/7 PASS、1 FAIL**（`pending save or late open must complete before worker can be retired`），保留日志；逐字还原 busy guard 后恢复 7/7。不是只凭虚假的全绿判断安全。
- `npx vitest run apps/sheets/tests/sidecar-idle-retirement.test.ts apps/sheets/tests/sidecar-session-recovery.test.ts apps/sheets/tests/temp-files.test.ts apps/sheets/tests/close-guard.test.ts` → **33/33 PASS**。
- `npm run typecheck -w @genoffice/sheets`、Mcode Desktop/Contracts `npx tsc --noEmit` → **PASS**。
- 新增 GenOffice fork 变更与**第 28 条可重放补丁**；`set MCODE_INCLUDE_GENOFFICE_BUNDLE=1&& node apps/desktop/build/verify-genoffice-upstream.cjs` → **28 patches PASS**；`genoffice-source-smoke` / `genoffice-editors-release-smoke` / `genoffice-native-view-smoke` → **3/3 PASS**。
- 真 Electron `node apps/desktop/scripts/t7-genoffice-u1/run.mjs --only=sheets-open-edit-save-reopen` → **1/1 journey PASS（2 OS 进程）**。确实以受信 `Mcode DocumentViewHost` 加载 XLSX 编辑器，保存文件后重启 Mcode 模拟宿主再开仍成功。证据 `.tmp/electron-u1/2026-10-25T04-36-02-290Z`。

## 边界 / 下一步

- 上述是真 Electron 基本功能成功，并不等于**同一 OS 会话开、关、60 秒后 Rust 进程退出、再次打开**的整套内存 U1 已经跑通；单元测试是真逻辑且具备受控虚拟时钟，尚未捕获真实 sidecar RSS/CPU 降幅和再启动延迟。
- 未保存修改的标签页不在回收对象范围。用户将其隐藏到后台时仍然保留实时 `webContents` 与 sidecar，**绝不能为省内存提前杀掉 dirty 编辑器**。
- GenOffice 仍保留六种独立 renderer bundle，不应将原生嵌入误称为六编辑器单 JS runtime。Mcode 已统一提供窗口、工作区、文件围栏、保存守卫、AI 接口和资源协议，但下一阶段仍需优化多标签隔离/生命周期、性能仪表和深层功能完整性。
