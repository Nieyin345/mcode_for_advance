# UI-MODULES-P2 / 任务 02：后端目录与工作流授权入口

## 状态
**READY_FOR_INTEGRATION** — 02 的后端实现、独立专项和既有 33 项后端烟测已完成；不代表 03/05 的工作流生产接线、UI 或本阶段全量验收完成。

- 承接对话标识：Arena / UI-MODULES-P2 / P2-02。
- 开始 HEAD：`4e25a77fa0b95a97baf2f9423d399e442b98aab4`；收尾核对 HEAD：`fe62fe35831ab3bec97b6bcc06673c761ea5a91e`（共享工作区有其他对话并行修改）。
- 接口依赖：任务 01 的 `docs/parallel-ui-modules/interface-v2.md` **P2-01 / 1.0.0，FROZEN**；任务 01 报告现为 `READY_FOR_INTEGRATION`。冻结前只写本任务测试，冻结后才接正式 contracts 导出。

## 文件范围与实际改动
仅修改/新增本任务拥有的文件：

1. `apps/desktop/src/main/modules/ModuleHost.ts`：登记时经 `ModuleCapabilityDescriptorSchema` 校验并复制 metadata；有 metadata 时必须如实声明 `resource.read`，query 不得虚报取消或 task 超时；捕获登记时的输入校验器与执行函数，防止调用方后来替换执行实现。目录返回独立快照，`workflowTargets` 只由真实 `builtinIds`、仍存在的贡献和只读 query/task 能力生成。内部 `invokeForWorkflow(input: ModuleInvoke): Promise<ModuleReply>` 先核验上述同一可信条件，再复用普通 `invoke`；没有新 job 表，也未开放新 RPC。
2. `apps/desktop/src/main/modules/fileCapabilities.ts`：为真实 `core.file.inspect` task 与 `core.file.info` query 添加双语版本、说明、输入/输出展示 schema、`resource.read` 及准确限制。仅 inspect 宣称 32 MiB、30 秒 task 超时与取消；info 不宣称这些限制。实际 `ResourceSchema`、`ResultSchema`、realpath/工作区校验和文件读取实现未放宽。
3. `apps/desktop/src/main/modules/service.ts`：原 `core.file-report.inspect` 保持，增加同一内置模块的 `info` 贡献，指向已有 `core.file.info`；保留 `getModuleHost()` 懒加载、清单原子保存及损坏配置处理。
4. **新增** `apps/desktop/scripts/module-catalog-smoke/`：`main.ts`、`build.mjs`、`run.sh`、`tsconfig.json`、`stubs/dataRoot.ts`、`stubs/pathGuard.ts`。运行真实宿主/文件能力，服务数据根和工作区仅用本套独占的 `.tmp` 夹具，不读写用户数据库。`run.sh` 可被现有 `run-smokes.mjs --all` 自动发现；原 `module-platform-smoke/` 未改。
5. 更新本报告。未修改 contracts、IPC/preload、调度器、UI 或其他任务的源码/测试/报告。

## 有效红灯与绿灯证据
以下命令均在 `apps/desktop` 执行；日志为本套唯一命名的 `.tmp` 目录，不覆盖其他对话的生成物：

- 首轮 **红灯**：`node scripts/module-catalog-smoke/build.mjs` 退出 1；成功打包并实际运行 14 项，1 通过、13 因缺少元数据、`workflowTargets`、`invokeForWorkflow` 和内置 info 等目标行为失败。日志：`apps/desktop/.tmp/module-catalog-7cAxwj/output.log`。拒绝断言明确排除把缺方法造成的 `TypeError` 当作授权通过。
- 首轮修复后 16 项通过。随后补更具体的加固断言，形成第二次 **有效红灯**：19 项中 17 通过、2 失败（调用方替换登记后的 run 得到 `-123` 而非真实字节数 `29`；空权限 metadata 未被拒绝），退出 1；日志：`apps/desktop/.tmp/module-catalog-Poc3IJ/output.log`。固定实现后 19 项通过，再补菜单/工作流共用四任务上限与取消释放槽位的回归断言。
- 最终 `node scripts/run-smokes.mjs module-catalog-smoke module-platform-smoke` **退出 0**、两套通过：**新专项 20 项，原后端专项 33 项**。运行日志：`apps/desktop/.tmp/smoke-runs/1790478332779-45104-VLzpBv/{module-catalog-smoke,module-platform-smoke}.log`；直接新专项绿灯日志：`apps/desktop/.tmp/module-catalog-t2c9kJ/output.log`（20 项）。
- `node node_modules/typescript/bin/tsc --noEmit -p scripts/module-catalog-smoke/tsconfig.json --pretty false` **退出 0**，覆盖新增 suite、三个真实宿主源码及其契约依赖。`git diff --check -- apps/desktop/src/main/modules/ModuleHost.ts apps/desktop/src/main/modules/fileCapabilities.ts apps/desktop/src/main/modules/service.ts` **退出 0**。

专项检查包含：目录与冻结 `ModuleCatalogSchema` 可序列化/可校验、登记元数据安全与快照隔离、真实内置贡献与 user.* 菜单隔离、伪造 core/action/未知贡献拒绝、严格调用输入、已登记工作区与 symlink/junction 越界/非文件拒绝、query 立即返回与 task 句柄/哈希、32 MiB 只适用于 inspect、同一宿主的请求去重、取消和四活动任务限额，以及服务懒加载。

## 给 03 / 04 / 05 / 07 的接入说明
- **03 / 05**：使用现有 `getModuleHost()` 获取同一宿主，内部调用 `host.invokeForWorkflow(input: ModuleInvoke)`；task 后续仍用 `host.task` / `host.cancel`。工作流调用前需由可信运行态产生 `resource.projectPath` 与 `requestId`；不能仅凭 ID、目录目标或调用者自报 `trusted/source` 绕过授权。切勿把内部入口新增为 renderer/mobile RPC 或直接执行 capability.run。
- **04**：`catalog().capabilities[*].metadata` 是可选的兼容字段，两个生产内置文件能力有值；`workflowTargets` 是宿主生成的发现列表，不是独立授权凭证。旧目录缺字段时不得猜测权限/限制。
- **05 / 07**：01 冻结稿保留 `module-capability` runnable 启用门禁，需在生产注册与缺执行器失败路径核实后按 01/07 的跨任务流程激活；02 不修改这些入口。07 负责最终全量回归和真实工作流集成验收。

## 范围外与尚未验证
- 未跑全项目 `test:all`、全桌面与双包 typecheck；按并行分工由 07 在其他任务就绪后统一验收。未宣称 UI、执行器、调度器已接线或真正端到端运行。任务仍为进程内，未承诺应用重启后的任务恢复。
- 没有启动真实模型、打开真实用户库/数据根、安装依赖或清理其他对话生成物。

## Git
- **未提交、未推送。** 所有并行工作树的其他未提交改动保持原样。
