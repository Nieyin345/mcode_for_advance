# O16｜Mcode 内建 Office：主进程资源加载与原生视图布局性能

- Status: **有界交付（2026-10-25）**。E1 新专项 34/34、关联四套回归 PASS，真实 Electron U1 因并行重型测试租约占用而未执行。
- Product goal: 六编辑器是 Mcode 工作台的内建编辑能力，Mcode 统一会话/AI、文件围栏、保存事务、资源供应与视图生命周期；不部署第二个 Office Web 服务、不增加第二套 AI 或文件写盘。
- Task scope: 主进程非 UI 的资源协议和 native WebContentsView 尺寸更新；不动 GenOffice fork、编辑器 React 皮肤、任务线程、其他并行对话持有的 dirty 文件。

## 实际瓶颈与代码修改

1. `apps/desktop/src/main/document/genofficeViewFactories.ts` 的 `genoffice-app://` 资源 handler 原先**每个资源请求同步**执行 `existsSync` + `realpathSync(root)` + `realpathSync(asset)`，阻塞 Mcode Electron 主进程，即可能拖慢聊天、工作流、其他编辑器。现改为 `async` handler，唯一叶子模块 `genofficeAssetPath.ts` 通过 `node:fs/promises.realpath` 并行校验 root/asset；之后仍用 Mcode 的 `net.fetch(file:)` 提供资源，未引入 GenOffice HTTP 服务器。每次重新校验 root 与目标的物理边界，**不缓存**一次已检的符号链接结果；非法/越界/不存在均拒绝。
2. `apps/desktop/src/main/document/documentViewHost.ts` 的 `setBounds` 与 `open` 复用路径，每次尺寸相同也向 OS `WebContentsView.setBounds` 发新调用。新增 `appliedBounds`（与渲染端期待的 `bounds` 分离），共用 `applyNativeBounds`：仅 OS 上次成功应用同一矩形时去重；实际尺寸变化仍更新；隐藏继续 park（不销毁、不丢 dirty state），恢复显示时用最新矩形；**失败的布局不能缓存为成功**，后续相同矩形会重试。
3. 以上均沿用 **一条** Mcode DocumentViewHost / native asset protocol，不建立副本服务。不盲目 LRU 强杀隐藏 WebContentsView：在可证明 dirty/恢复安全之前杀进程有数据丢失风险。

## E1 验证与红绿结果

- 新增 `apps/desktop/scripts/office-perf-smoke/`：运行时真正实例化 `DocumentViewHost`（fake WebContentsView），以及使用单独 Electron stub 的**生产** `installGenofficeNativeProtocol` 注册回调。所有 I/O 仅在 OS 临时目录中创建的假 renderer/preload/sidecar 与资源文件，完成后清理。
- 改动前红例：发送相同 `100` 次 view bounds 后，实际原生调用累计 **101** 次，专项脚本 `office-perf-smoke` 以多个布局断言失败；日志 `apps/desktop/.tmp/smoke-runs/1792901583756-38128-FzZOqA`。改后连续 100 次相同 bounds 累计仍仅 **1** 次，变更后再 100 次也只有一次额外调用；隐藏保活、后台尺寸变化后恢复、失败后重试也逐项通过。
- 新测试 **21/21**；生产协议 handler 的资源配置、合法文件返回、未知后缀/主机拒绝、encoded traversal、坏编码、外链 junction 逃逸、80 并发资源的隔离检查 **13/13**；合计 **34/34**。证据 `apps/desktop/.tmp/smoke-runs/1792902096714-39096-49Athj`。
- `node apps/desktop/scripts/run-smokes.mjs office-perf-smoke genoffice-native-view-smoke genoffice-file-routing-smoke document-view-host-smoke` → **4/4 PASS**。
- `npx tsc --noEmit -p apps/desktop/tsconfig.json`、`npx tsc --noEmit -p packages/contracts/tsconfig.json` → **PASS**；`git diff --check` PASS。
- `node apps/desktop/scripts/t7-genoffice-u1/run.mjs --only=pdf-open-edit-save-reopen` 两次请求均在重型测试启动前被**其他对话**的 `heavy-test-lease` 拒绝（PID 22244、36764），没有强制取消其他测试，**没有真实 Electron U1 PASS 证据**。
- 不应把 101→1 的**隔离 OS 布局调用数量**冒充为实测启动时间、真实 CPU/RAM 节省百分比。

## 下一步仍需的性能闭环

- 有重型测试时间窗时复跑至少 PDF、Sheets 与 Slides 真 Electron，真实页面渲染、打开编辑保存重开；记录相同硬件下改前/改后冷启动与二次打开时间，P50/P95 切换、Mcode 主进程事件循环延迟、Electron OS 子进程 RSS/CPU、Sheets sidecar 的生命周期、后台多标签切换及恢复。
- GenOffice 六编辑器在代码依赖层仍保留自己的渲染 bundle/原厂编辑引擎（Mcode 供给资源/身份/安全/会话）；不能声称已经合成一个 JS bundle 或六编辑器共享一个渲染进程。真完整合并需要在数据持久性、共享字体/运行时和惰性加载方面继续优化。
- 特别关注后台 WebContentsView 常驻内存：保持编辑状态与回收内存存在冲突，未经确证的 dirty 守卫、快照与恢复协议，不应强制淘汰后台标签。
