# UI-MODULES-P2 / 任务 06：独立安全与端到端回归

## 状态
**VERIFIED**（2026-09-27，依据 integration.md 候选 B：`module-phase2-e2e-smoke` 10/10、0 BLOCKED，`module-phase2-security-smoke` 20/20，全量 139/139）。原状态与移交记录保留如下：

**IN_PROGRESS — 用户确认将剩余 E2E 测试移交本对话。**

- 当前承接者：Arena Agent / UI-MODULES-P2 / P2-01-07-transfer-20260927。
- 用户于 2026-09-27 明确选择“确认移交，完成剩余测试”；原 06 对话停止写入。保留全部既有独立安全断言和历史红灯，不删除末尾 BLOCKED 来制造绿灯。
- 收尾开始 HEAD：`95d6a99f1a2507aeefbe21df78c93626aed72633`。本任务只改自己的测试目录、安全清单及本报告；不会据此改 02/03/04 生产代码。
- 07 的最终验收等待新增真实持久化/UI/调度链和隔离 Electron 证据。
- 以下为原承接者的历史交付记录；原先的生产缺注册与门禁状态需在当前候选复验，不直接照搬。

## 移交后的实现与定向证据（最终候选复验待完成）

保留原 9 个片段/生命周期/生产注册/缺执行器断言。末尾不再无条件 BLOCKED，但**只有同轮真实 native、生产工作流、共享保存与目录浏览器的完整回执都通过才允许通过**；单独运行片段而没有回执仍 exit 2。

新增 `native-build.mjs`、`electron-host.cjs`、`native-main.ts`、`native-ports.ts`、`native-renderer.jsx`、`verify-native-mutations.mjs`；更新本套 `build.mjs/main.ts/README.md`。原独立安全 suite 的断言未删改。未修改 02/03/04 的源码或测试。

| 定向执行 | 结果与证据（均在 `apps/desktop/.tmp/`） |
|---|---|
| 隔离真实 Electron 功能窗口 | `p2-06-native-eLglkj`：create 12 PASS、另起进程 reopen 7 PASS，exit 0；实走真实 SQLite、preload/IPC、UI 配置、AutomationRunner/runner/scheduler、宿主和文件 |
| 共享严格保存 mutation | `p2-06-native-EQ53Ur`：只删临时 bundle 的共享 guard；真实 native save 错收伪造字段，指定断言失败，exit 1 |
| 提前退出 mutation | `p2-06-native-xTEp98`：Electron 子进程故意 exit 0、没有断言回执；父 gate 正确 exit 1 |
| 两个负向控制的校验器 | `p2-06-native-controls-z8Bne1`：2/2 达到指定失败而非任意构建错误，校验器 exit 0 |
| 首轮组合 E2E | `p2-06-e2e-2qrXPv`：native 19 项、生产工作流 25 项、共享 sentinel 3 项通过；浏览器目录套件第 4 项后 CDP Runtime.evaluate 超时，组合最终 9 PASS / 1 FAIL，exit 1。保留失败，不记作完整通过 |
| 新增测试后的活动树 tsc | `module-workflow-verify-86p7Cm`：contracts 0；desktop 180 秒 ETIMEDOUT / SIGTERM，日志无 TS 诊断，不算通过；diff 0 |

上述组合/类型执行曾与两个 native 控制并行。后续冻结候选内按串行运行、独立记录时限；这改变执行条件，不抹去前次失败。仍不能仅凭超时确定产品有错或无错。

### Harness 开发失败的明确分类

- `p2-06-native-7wGUMH` / `eW2rXJ`：测试种子漏了 `trigger: manual`，触发既有主节点校验；不是产品回归，修正测试种子。
- `p2-06-native-esy5Tp`：发现关闭最后一个窗口会使 Electron 隐式 exit 0，**实际断言未通过，旧 result.json 不能用作验收**。现拦截 window-all-closed，并要求完整回执；提前退出 mutation 专门证明此门禁。
- `BIvyFi`：控件选择器误选 Select 的隐藏 input；现在只选路径的 `input[type=text]`，保存按钮也精确匹配文案。
- `d2zNpm`：测试直接改自动化 session.workflowId，被真实来源链守卫拒绝；改为走真实 automation.run，由生产代码创建自己的会话/来源链。没有放宽生产守卫。

### 冻结候选 A 与后续小修

A 的隔离串行定向已全部通过：11/11、E2E 综合门禁 10/10（native 19、生产 workflow 25、save sentinel 3、目录 UI 21）；双包类型检查均 exit 0。A 的全量未完成，按 07 决定中止后重新冻结，不记作通过。

用户随后明确授权**仅一个原分工外测试适配**：`scripts/projects-ipc-smoke/stubs/window.ts`，由 07 分配当前 06 接续补 hasLiveRendererWindow() 返回 false，保留 getMainWindow() 为 null 的真实无窗口语义。未改任何断言或生产代码。这是上述“仅两个专项目录”的明确单文件例外，不是开放其他目录。

截图辅助证据已加强：先 warm capture，再等双动画帧/绘制，另存同帧 DOM 文本，避免拿过渡帧当最终截图。`p2-06-native-7Km4Oy` 的 create 12 + reopen 7 再次通过；已核看真实 bytes/hash/下游结果及取消终态。该测试代码修订会进入下一个冻结候选。

### 替身与未验证范围

真实业务路径包括数据库/仓库、配置 library/trust、实际生产目录、完整 AutomationRunner/runner/scheduler、模块执行器、service、ModuleHost、文件与资源授权。仅 agent/provider 与主应用窗口启动/事件桥、辅助项目列表引导端口隔离；模型调用会抛错并计数。UI 取消使用明确标注的只在测试宿主登记的计时 fixture，真实文件 IO 与取消竞态另由安全/生命周期断言覆盖。页面网络被拒绝。

这是无显示但真实渲染的隔离 BrowserWindow 自动验收，不是正式安装包、主应用所有服务/面板、实际 FileTree/FilesPanel、原生 BrowserView 遮挡、真实模型或手机验收。任务历史仍仅内存；重开的持久化证明指工作流配置/运行结果及安装清单，不是 task 句柄恢复。

### 历史交付（原状态 BLOCKED）

- 承接对话标识：Arena / P2-06 / independent-regression。
- 开始 HEAD：`fe62fe35831ab3bec97b6bcc06673c761ea5a91e`。
- 重连核对 HEAD：`fe62fe35831ab3bec97b6bcc06673c761ea5a91e`。
- 使用冻结版本：**P2-01 / 1.0.0 / FROZEN**。
- 共享活动树，未使用冻结候选快照；已核对 git status，其他任务与资料库等无关修改全部保留。
- 开工时任务 06 报告不存在。本次恢复后仍是本对话的初始报告，10 个测试文件逐一重读，与上次写入内容一致，无接替或冲突迹象。
- 依赖：01～04 已有交付；恢复时 05 已移交至 P2-05-transfer-20260927，仍为 IN_PROGRESS。生产接线与 runnable 激活分别由 05、01/07 处理。

## 已完成
1. 新增独立安全套件：真实 ModuleHost、fileCapabilities、service、contracts；仅数据根与已登记工作区查找使用隔离 fixture。覆盖真实清单持久化/恢复、文件、Windows junction、超限文件，不访问用户数据库。
2. 取得有效授权红灯：仅在临时 bundle 删除工作流授权门禁，用户模块工作流调用不再拒绝，独立断言失败；未改动生产源码。
3. 正常安全回归 **20 PASS / 0 FAIL**，包括真实约 30 秒宿主超时与 abort。
4. 新增独立集成探针：手工组合真实 registry/engine/executor/service/host/file 的片段，以及真实宿主任務的取消和丢失场景。首轮 **7 PASS / 2 FAIL / 1 BLOCKED**，不能冒充生产调度全链。
5. 保留两个可执行红灯并交给 05：缺能力执行器时进入模型 fallback；生产导出引擎未注册能力 kind。详见 security-findings.md。
6. 两套均提供 run.sh，由现有动态 smoke runner 发现，不改调度器。
7. 重连后补跑两套定向 TypeScript 检查，均 **exit 0**。

## 实际改动文件
仅写本任务拥有的文件，未修改生产代码、其他任务测试或报告。

新增：
- `apps/desktop/scripts/module-phase2-security-smoke/{main.ts,build.mjs,run.sh,tsconfig.json}`
- `apps/desktop/scripts/module-phase2-security-smoke/stubs/environment.ts`
- `apps/desktop/scripts/module-phase2-e2e-smoke/{main.ts,build.mjs,run.sh,tsconfig.json,README.md}`
- `docs/parallel-ui-modules/security-findings.md`
- `docs/parallel-ui-modules/task-06.md`（本报告，初始登记后更新为交接版）

## 测试证据
命令均在 mcode 根执行。下列证据目录包含 output.log、result.json、checks.json、inputs.json（打包输入 SHA-256）、临时 bundle 和隔离 fixture。活动树打包和哈希不是协调后的冻结快照。

| 验证 | 命令 | 结果 | 相对 mcode 的证据目录 |
|---|---|---|---|
| 有效授权突变红灯 | `node apps/desktop/scripts/module-phase2-security-smoke/build.mjs --mutation-workflow-auth` | exit 1；0 pass / 1 fail；Missing expected rejection | `apps/desktop/.tmp/p2-06-security-5ZaN7Z/` |
| 正常安全回归 | `node apps/desktop/scripts/module-phase2-security-smoke/build.mjs` | exit 0；20 pass / 0 fail | `apps/desktop/.tmp/p2-06-security-L6gzvg/` |
| 独立集成探针首轮 | `node apps/desktop/scripts/module-phase2-e2e-smoke/build.mjs` | exit 1；7 pass / 2 fail / 1 blocked | `apps/desktop/.tmp/p2-06-e2e-eyrGWL/` |

重连定向类型检查（不是全桌面/双包检查）：
- `node apps/desktop/node_modules/typescript/bin/tsc --noEmit -p apps/desktop/scripts/module-phase2-security-smoke/tsconfig.json --pretty false`：exit 0，无 TS 诊断；MCP 命令 `cmd_3ba53a7ba4b1702553692786b7a2bcf2fb82f972eecfbe06`。
- 同命令将目录换为 `module-phase2-e2e-smoke`：exit 0，无 TS 诊断；MCP 命令 `cmd_613d646ec0a5247e05edc8d780c113cdb0098b3b355d7db0`。
- scoped `git diff --check`：exit 0。新增文件尚未跟踪，另对重读后内容逐文件检查行尾空白/冲突标记，10 个文件均无异常；不把 git diff 对未跟踪文件的空输出当完整检查。

### 安全覆盖
- 用户模块菜单可用、工作流拒绝；真实保存及恢复后仍仅菜单授权；旧 v1 清单、旧目录兼容。
- 伪造 core ID、未知贡献、action 登记、额外 trusted/source/projectPath/capabilityId/requestId/script 拒绝。
- 未知根、绝对越界、dot-dot 越界、Windows junction、目录拒绝；inspect 超过 32 MiB 失败，info 不冒充有同样限制。
- 目录可序列化、返回值修改隔离；危险/过大/过深 schema、远程/file ref、污染字段、执行字段、访问器拒绝且 getter 未调用；重复注册不可替换能力。
- 同次并发 requestId 去重，新 ID 新任务，同 ID 不同输入拒绝，真实 SHA-256；取消后迟到完成不覆盖终态，真实 30 秒超时，淘汰/新宿主查询旧句柄明确失败。

### 集成片段覆盖
- 手工组合的真实引擎/注册表至真实文件 query/task，返回 bytes、modifiedAt、sha256；与 service 同一宿主任务表。
- 同 ID 去重、新 ID 新任务；用户模块和实际相对路径穿越拒绝。
- 预取消零宿主调用；迟到句柄取消且不取消无关任务；轮询时取消；新宿主丢失任务时失败且不重复 invoke。
- **测试生成 ID 与手工构造执行输入不等于生产 nonce/参数构建已通过。**

## 重连后的 smoke runner 复验
命令：`node apps/desktop/scripts/run-smokes.mjs module-phase2-security-smoke module-phase2-e2e-smoke module-ui-smoke module-catalog-ui-smoke`。

- 日志目录：`apps/desktop/.tmp/smoke-runs/1790483335266-39552-qkpRrO/`，每套单独 .log。
- `module-phase2-security-smoke`：exit 0；20 PASS / 0 FAIL，产物 `apps/desktop/.tmp/p2-06-security-jaokt5/`。
- `module-phase2-e2e-smoke`：exit 1；再次 7 PASS / 2 FAIL / 1 BLOCKED，产物 `apps/desktop/.tmp/p2-06-e2e-mTA6qq/`。
- 原 `module-ui-smoke`：exit 1，浏览器 harness 读取独立 profile 的 DevToolsActivePort 时 EBUSY；未取得 8 项 UI 行为验收结论。产物 `apps/desktop/.tmp/module-ui-YgziSM/`。不把工具启动失败作为产品失败，不靠自动重试掩盖偶发问题，不修改 04 的测试。
- `module-catalog-ui-smoke`：exit 0；**21/21 浏览器检查通过**，产物 `apps/desktop/.tmp/module-catalog-ui-lkM1fQ/`。覆盖加载/失败重试/旧目录/未知元数据/安全文本展示/目标选择/失效选择/序列化重开/中英文等；真实浏览器内含测试 transport 与内存 fixture，不能等同生产持久化和调度 E2E。
- runner 最终 **exit 1，2 pass / 2 fail（4 suites）**：失败分别是未完成生产接线的行为红灯、原菜单 UI 的 harness 文件锁，性质不同，不混写成四套通过。

## 跨任务请求 / 阻塞
- **P2-SEC-001 → 05 / 01 / 07**：缺 module-capability 执行器时进入模型 fallback。当前 runnable 门禁未激活，未证明正式 UI 已可触发；仍须在激活前 fail-closed。
- **P2-SEC-002 → 05**：生产导出引擎缺注册，需两条注册路径、真实参数与变量构建、派发 nonce、循环/失败重试/续跑证据。
- **P2-SEC-003 → 06 / 07**：完整生产/UI 验收待上述依赖就绪。不能删除测试末尾 BLOCKED 项以制造全绿。
- **→ 04 / 07**：原菜单 UI 的 DevToolsActivePort 读取 EBUSY 请由对应测试/共享 harness 所有者排查；06 未修他人测试，也未重试掩盖。
- 之前断连的 502/530 是连接失败，不是产品失败；恢复后的实测单独记录，不把当时无结果的命令当作通过。

## 未实现 / 未验证
- 真实 scheduler/runner 参数映射、生产 nonce 的循环/失败重试/续跑；配置持久化重开、工作流导入不自动启用；生产 UI 到真实调度链。
- IPC/preload/mobile 内部入口不可暴露的独立复验仍待联调。
- Electron 实机未验收；全量 smoke、双包类型检查由 07 统一协调。
- 不宣称 TOCTOU 穷举、任意第三方代码沙箱或跨重启 exactly-once。
- 未安装依赖、调用真实模型、操作真实数据根或重启用户应用。

## 给下一任务的接入说明
1. 查看 security-findings.md 的红灯和归属，05 修复后用原独立断言复验，不在 06 越权修改生产。
2. 安全 build 标准命令应绿；`--mutation-workflow-auth` 应红且是授权断言 Missing expected rejection。突变点不唯一是 harness 错误，不算有效红灯。
3. E2E 使用安全套件目录中的隔离环境 stub；两个目录均属 06。
4. E2E README 列出了完整生产接入清单。仅当这些行为真正接入测试并实测后才替换末尾 BLOCKED；若断言全绿但仍有该项，suite 退出 2，不能当全量通过。
5. 05 在并行实施，报告结论只对应所列证据版本，不猜测其后续修改已完成。07 先协调候选冻结再做最终验收。

## Git
**未提交、未推送、未暂存。** 未运行 reset/checkout/stash、全库格式化或清理他人改动。本轮仅完成第 06 号自有测试与文档交付。
