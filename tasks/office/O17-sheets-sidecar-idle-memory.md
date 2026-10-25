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


## 2026-10-25 O17 性能验收补充：同一 OS 进程的共享/退休/再启动实测

**本次仅新增真实 Electron 性能验收，不修改原厂代码或 UI。** 为避免给每日 T7 六格式回归额外增加 65+ 秒等待，新建独立 opt-in 注册表 `apps/desktop/scripts/office-perf-u1/`。它复用 T7 **同一份** `editorSetup('sheets')`、Mcode DocumentViewHost、GenOffice 原厂主进程+preload+Univer renderer、受信 workspace、既有 Electron U1 runner 与生产 esbuild 别名；采用独立测试目录和用户数据库，不读取真实用户文件。

运行命令：

```cmd
node apps/desktop/scripts/office-perf-u1/run.mjs
```

- 用 Windows CIM 查询 `ParentProcessId = 当前隔离测试 Electron PID AND Name = 'xlsx-sidecar.exe'`，只读查询子进程 PID、`WorkingSetSize`，**不会匹配、终止或修改其他对话的 Excel sidecar**；无查询能力时 fail-closed，不用假值。
- 从实际 Mcode 表格开始，打开第二份**独立复制的工作簿**作为另一标签，真正加载第二个 Univer canvas（第一个标签只隐藏，不销毁），确认两个 Mcode 视图**共享一个**原厂 Rust PID；关闭第一个后第二个仍存活且 PID 不变。
- 关闭最后一个表格后，**8 秒时必须仍存活**；超过 60s 时通过轮询确认子进程已消失（有足够时间容忍会话异步清理和轮询间隔）；随后在**同一 Electron OS 进程**重新打开表格，断言新的 worker PID 与可用画布。
- 两次运行均 **U1 PASS**：`.tmp/electron-u1/2026-10-25T04-55-52-186Z`、`.tmp/electron-u1/2026-10-25T04-59-32-994Z`，每次 **1 journey、1 OS 进程、7 steps PASS**，有逐步 JSON 结果 `sheets-shared-worker-idle-restart/journey-result.json`。

**第二次采样的实际数值**：

| 样本/阶段 | 证据 |
|---|---|
| Electron 宿主 PID | `41936` |
| 仅第一份工作簿时 Rust PID / 工作集 | `22184` / `6,324,224 B` |
| 两份工作簿同时打开（第二份已有 Canvas） | 仍是 `22184`，工作集 `6,365,184 B` |
| 关闭第一份，只剩第二份 | 仍是 `22184` |
| 最后一个视图关闭 8 秒后 | 仍是 `22184`，工作集 `6,397,952 B` |
| 最后一个视图关闭后回收 | 约 `62,715 ms`，子进程查询为空 |
| 重新打开同一 Mcode，Rust worker | 新 PID `22912`，Canvas 成功 |
| 重新打开到 Canvas | `3,762 ms` |
| 第一次的完整空闲回收实测 | `65,330 ms`，后续再开新 PID `44368` |

**数值边界**：这里记录的是单独 Rust sidecar 的 OS working set（当时约 6.0–6.1 MiB），不是 Mcode/Electron 全进程组的总 RAM，也不是多轮 P50/P95；`startToGridMs` 还含 T7 fixture/setup 时间，不能未经严格对照就称为冷启动本体耗时。这里的性能验收只能证明该子进程在安全空闲阶段真的退出、重新启动后编辑器仍正常。未加载大工作簿，也未验证同一机器不同负载下的峰值 RSS 或 CPU/启动尾延迟。

**日志**：关闭 webContents 后偶有已发出的 `workbook:read-range` IPC 到达宿主并遭 `Mcode 安全围栏：未授权的文档视图不能调用原厂 IPC` 拒绝。由于 sender 已不在有效的 DocumentViewHost 会话中，拒绝是安全策略的预期结果；这条**噪声**未造成测试进程退出或第二份/重开的失败，但后续仍可单列异步卸载期间的请求取消诊断，不应为消除日志放松 sender 授权。

**接下来**：若需对用户承诺 P50/P95、CPU 占用或可量化的总内存收益，必须进一步测同时驻留 Docs/Sheets/Slides/PDF/Markdown/HTML 的整机多进程指标和大型工作簿；本项暂不声称六种编辑器已合成单 JS/单渲染进程。

**收尾回归补充**：`node apps/desktop/scripts/run-smokes.mjs office-perf-smoke genoffice-native-view-smoke genoffice-source-smoke` → 3/3 PASS（`apps/desktop/.tmp/smoke-runs/1792904623434-5608-QrGSHP`）；`npx tsc --noEmit -p packages/contracts/tsconfig.json` PASS。第一次跑 Desktop tsc 遇到正在并行更新的聊天 UI `TagPopover.tsx` nullable 诊断（与本次 Office 性能文件无关），不擅自编辑他人 UI；稍后同一命令重新执行，**Desktop tsc 已恢复 PASS**。
