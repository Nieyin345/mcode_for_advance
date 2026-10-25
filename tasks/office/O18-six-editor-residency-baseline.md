# O18｜Mcode 内建 Office：六编辑器真实驻留与进程开销基线

- Status: **2026-10-25 有界交付：真实 Electron U1 两次 PASS；六编辑器分别驻留、切回原视图成功，尚未做跨机器 P95 / 大文件 / 真实长期编辑负载**。
- 归属：ARC-007 GenOffice 原生深度集成；承接 O16 的主进程异步资源与 native 布局去重、O17 的 Sheets idle worker 回收。**本项仅新增可重复性能验收，未修改原厂引擎、UI 或安全/保存路径。**

## 测量方法

独立 opt-in 旅程 `apps/desktop/scripts/office-perf-u1/journeys/six-editor-residency.ts`；执行：

```cmd
node apps/desktop/scripts/office-perf-u1/run.mjs --only=six-editor-residency
```

它复用 T7 的**生产** `DocumentViewHost`、`genofficeViewFactories`、六家 vendor main/preload/renderer，以及同一份真实 `editorSetup('sheets')` 和隔离的测试 SQLite/项目夹具。初始打开 Sheets，随后按 Slides→PDF→Markdown→HTML→Docs 打开每个独立文档视图，前一份仅 `hide` 而不 `close`。对每个新视图等其 editor DOM 标记挂载；Docs 额外走生产 `documentView:openPath` 与受信打开会话的 commit。

取证用主进程里的 `app.getAppMetrics()`（Electron 每进程工作集单位 KiB、CPU 采样）和每个 `webContents.getOSProcessId()`，不靠 OS 进程名猜哪一个窗口属于 Mcode；`BrowserWindow.getAllWindows()` 必须维持为一个窗口。六个视图全存在后，切回初始已隐藏 Sheets，断言原 `webContents.id` 和原 OS PID 未变、网格 canvas 仍可用；等待 3 秒后再取 Electron 工作集与 CPU 第二次采样，六个 renderer PID 必须保持不变。最后关闭全部六个 `DocumentViewHost` 视图，断言没有残留文档会话窗口。**纯引擎初始化、编辑器首帧/Docs 打开会话**，不冒充这六份文档都执行过编辑+保存的完整 T7 旅程（后者已有独立 6/6 证据）。

测试命令使用了已经存在的 Heavy Test Lease，不关、不杀、不触碰其他对话的运行环境。证据仅位于已有 `.tmp/electron-u1/` 下。

## 真实结果（单台 Windows 机器，两次 PASS）

- 首次通过：`.tmp/electron-u1/2026-10-25T06-37-29-212Z/six-editor-residency/journey-result.json`：六个 renderer 全部成功挂载，只有一个 BrowserWindow，初始 Sheets 切回同一 webContents，全部关闭后 DocumentViewHost 的 view 数为零。
- 第二次通过：`.tmp/electron-u1/2026-10-25T06-40-34-849Z/six-editor-residency/journey-result.json`：**1 journey，9 个断言/步骤 PASS，1 OS Electron 宿主进程**。第二次加了 3 秒驻留观测，两个时刻 Electron 总进程数均为 11，六个编辑器 OS PID 均未变化。

第二次测得的 **编辑器渲染进程工作集**（不能把它们简单相加当整个 Mcode RAM）：

| 编辑器 | renderer PID | 工作集（KiB） | 当前空白/夹具下到初步挂载的时间 |
|---|---:|---:|---:|
| Sheets | 25372 | 259156 | 1343 ms（包括 U1 夹具/Host setup） |
| Slides | 22948 | 182604 | 355 ms |
| PDF | 37140 | 115176 | 163 ms |
| Markdown | 35288 | 136400 | 227 ms |
| HTML | 34612 | 126692 | 405 ms |
| Docs | 29752 | 186664 | 863 ms（包括受信 docx openPath commit） |

**Electron 进程组总工作集采样**：六编辑器刚挂载约 **1,786,636 KiB（1.70 GiB）**；静置 3 秒前后 **1,782,148 → 1,784,724 KiB**。Mcode 主进程 Node RSS 约 381 MB（另一个测量口径，不能再与 Electron 总工作集重复相加）。静置 3 秒后的采样中，Sheets renderer `percentCPUUsage` ≈ 0.59%，Slides/Docs ≈ 0.012–0.013%，其他 Office renderer 在该瞬时采样更低；**仅一次、短窗口、不代表长期 CPU 占用或稳定 P95**。该环境下另外有一个 Mcode 宿主的 app renderer，GPU/Utility 等总计 11 个 Electron 进程。

### 解读及技术边界

1. **证实是内建宿主**：6 个 document views、1 个 Mcode BrowserWindow、同一宿主、安全文件会话与 vendor 生产接口；无第二款 Office 桌面进程，但各家编辑器仍有自己的 Chromium renderer/V8/JS 内存。不能把「只有一个主窗口」说成「只有一个 renderer」。
2. 六家同时驻留的内存压力主要来自编辑器渲染进程而不是可空闲退休的 XLSX Rust worker。不能未经保存状态/恢复协议就强制释放后台渲染器，尤其不能对有未保存数据的文档这样做。
3. 后续真正的性能优化要对准根因：工作簿/幻灯片加载阶段的按需资源解析，跨 app 可共享的静态资源与可延迟加载的图表/编辑特性，统一的安全休眠与 dirty 文档恢复。需要和本测试在相同硬件/相同夹具下成对对比，记录 P50/P95、CPU 和峰值 RSS 才能对用户声明速度提升。
4. 上一轮 O17 在关闭页面后看到迟到 `workbook:read-range` 被 Mcode IPC 围栏拒绝。本轮六格式逐一关闭未发生授权放行、误切会话或遗留视图。拒绝关闭 sender 的 IPC 是当前的 **fail-closed 安全行为**，不得为抑制日志而放松 `sessionFor(event)` / sender 验证。后续若要减少噪声，应从渲染器生命周期中取消排队读取，但需专项复现与端到端复测。

## 补充回归

- `node apps/desktop/scripts/office-perf-u1/run.mjs --only=six-editor-residency` **两次真实 Electron PASS**。
- Desktop TypeScript 曾在并行工作流测试更新期间临时出现 `apps/desktop/scripts/node-red-e2e-smoke/main.ts` 内 `manualDeploy` 变量重定义错误；未改动他人文件，稍后复跑 **Desktop 与 Contracts 两包 tsc 都已 PASS**。
- `node apps/desktop/scripts/run-smokes.mjs office-perf-smoke genoffice-native-view-smoke genoffice-source-smoke` → **3/3 PASS**；日志 `apps/desktop/.tmp/smoke-runs/1792910670402-40784-9EH3li`。
- GenOffice fork `b643536` 无改动，无新补丁。仍保留 O17 worker 真回收 2× PASS 证据。
