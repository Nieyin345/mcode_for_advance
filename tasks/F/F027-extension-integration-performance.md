# F027｜深度集成架构与扩展启动性能第一阶段

- Status: done / stage 1 only（性能热点修复并经 9 套件回归；整体深度集成明确未完成）
- Owner: F 扩展线（不得动 UI 总控的 chat / styles / workflow 工作）
- Depends on: F026
- Required skills: mcode-smoke, codebase-design
- Scope for this change: `apps/desktop/src/main/modules/theiaHost/installedRegistry.ts`, `apps/desktop/scripts/theia-installed-smoke/main.ts`, `packages/contracts/src/ipc/modules.ts`, `apps/desktop/src/renderer/components/modules/TheiaInstalledPanel.tsx`, 本卡和 `tasks/F/README.md`.
- Preserve all unrelated dirty state. No reset / clean / git add . / heavyweight Electron test.

## 用户目标与架构裁决

**深度集成不是再做一个插件管理页面。** Mcode 的模块/权限/配置/命令/编辑器/贡献点必须最终统一由 ModuleHost（或其统一 extension domain）托管；Theia 仅提供 VS Code extension host 兼容执行器，不能产生第二套产品行为和第二套用户权限模型。旧 L1、临时预览、持久 Theia 目前仍是平行路径，F027 首先把问题据实记录并对准性能热点。

## 已识别成本

- F026 `list()` 每次读取 UI 列表都同步递归访问和 SHA-256 所有扩展文件，开面板就可能长时间阻塞 Electron 主线程。
- F026 `start()` 在 spawn Theia 之前也同步读取全部文件；启动期间窗口会卡顿。
- `parseTheiaVsix()` 将归档整体读入并解压到内存，最大 64 MiB 压缩 / 150 MiB 解压；这是安装低频操作，也应后续离线工作线程化。
- Theia 仍是每次启动创建一个新子进程，未做到复用 / 批量激活 / 激活条件调度，不能声称启动性能已经优化。

## 本卡第一阶段的验收

1. 常规 `list()` 只读取短的持久安装记录，不扫描/哈希每一个扩展内容；列表明确标注「未经内容校验」，不谎报安全。损坏记录仍标红。
2. 真正启动前以可让出 event loop 的 I/O 流式检验完整目录和所有 SHA-256。重叠文件、路径跳转、哈希不一致、额外文件等 fail closed；禁用/启用时不宣称运行时验证通过。
3. 真正的异步校验需要有可证伪的 smoke（文件篡改拒绝启动、长文件运行时 main loop 可前进、列表没有触碰大 payload）。
4. 保留 F026 真实 Theia 命令、安装、卸载的 44+ 条正反验证；独立度量列表开销与启动耗时。性能目标需要先有基线，不能伪造百分比。
5. 联合跑：theia-installed、theia-vsix-preview、theia-host-boot、module-platform、module-permissions、module-workflow、app-control、ipc-wiring、extension-honesty、双包 typecheck。

## 本轮完成与可核验证据

- `installedRegistry.list()` 不再遍历 / SHA-256 扩展的所有文件；只读取每项有大小上限的安装记录。`TheiaInstalledEntry.integrity` 明确返回 `not-checked`，不声称列表已经通过内容校验；损坏安装记录返回 `corrupt`。
- `start()` 在派生扩展子进程前改用 `fs/promises` 的非阻塞目录读取以及 128 KiB 分块的 `createReadStream` + SHA-256 校验。新增、缺失、软链接、硬链接、变更内容均必须拒绝启动；校验期间允许 Electron 主线程事件循环继续处理消息。启用/禁用仅写元数据，不假装进行完整校验。
- 人工可复验夹具：`theia-installed-smoke` **48/48 PASS**；包含在受控临时目录生成 24 MiB 扩展文件、40 次列表查询的计时、文件不见时列表保持 unverified、启动篡改拒绝、校验让出 event loop，以及损坏安装记录的 UI 标记。
- 同机本轮运行指标：**40 次 list = 3.4 ms**；**24 MiB 内容完整 SHA-256 10 次 = 960.5 ms**。这两个操作不同，不是严格的旧版/新版 A/B；证据仅说明列表不应重复做重型内容校验。完整日志 `apps/desktop/.tmp/smoke-runs/1792902893592-24504-HLxalM/theia-installed-smoke.log`。
- **联合回归 9/9 PASS**：theia-installed、theia-vsix-preview、theia-host-boot、module-platform、module-permissions、module-workflow、app-control、ipc-wiring、extension-honesty。桌面与 contracts TypeScript typecheck 全 PASS，`vendor/theia` 未修改。
- 未取得的数据：完整 Electron 冷启动 p50/p95、Theia host spawn / activate 分解耗时、多扩展 10/30 个场景的 RSS / CPU 与 IPC 吞吐。不得凭这次小夹具宣称“整体启动速度已优化”。
- 代码提交 SHA：`0d2b147f`（4 个精确暂存文件，不含 UI / workflow 其他人的修改）；台账提交另行记录。

## 仍未完成

- 统一 ModuleHost 扩展生命周期和 UI，迁移旧 L1 与 F025 临时宿主到同一运行时；共享 Theia worker，按 VS Code 激活事件延迟激活；Mcode Monaco 文档/撤销/保存原生 bridge；打包与真 Electron U1；端到端启动/驻留内存指标。以上不应凭第一阶段 smoke 宣告完成。
