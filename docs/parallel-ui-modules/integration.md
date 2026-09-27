# UI-MODULES-P2 集成记录

## 状态

**自动化验收通过（候选 B，2026-09-27）。** 冻结候选 B 上串行完成 runner 自测 10/10、contracts/desktop 双包 `tsc --noEmit` 均 0、`git diff --check` 0、动态全量 **139 套 139 通过 0 失败（exit 0）**，含组合 E2E `module-phase2-e2e-smoke` 10/10 与 `module-phase2-security-smoke` 20/20。候选 A 暴露的两处缺口（05 内置参数 help、共用无窗口测试桩缺 `hasLiveRendererWindow`）在 B 中通过 `mcode-admin-smoke`、`memory-codex-smoke` 确认已关闭。

验收级别按下列区分，**不互相替代**：自动化（本记录，已通过）；隔离 Electron 功能窗口（06 已通过，见下"原生验收边界"）；用户主应用实机 / 正式安装包（**未验收**）。未提交、未推送；提交范围待用户明确授权。

## 责任与版本

- 接续标识：Arena Agent / UI-MODULES-P2 / P2-01-07-transfer-20260927（候选 A）；2026-09-27 用户确认其停止后由 **Arena/MAINT-REVERIFY-9ec50b** 接手完成候选 B 与本记录。
- 用户授权接手 01/07，并另明确移交 06 的剩余 E2E；05 原先已属本对话。02/03/04 源码与测试只读。
- 冻结契约仍是 P2-01 / 1.0.0；schema/权限/身份语义无不兼容改变。
- 用户授权的前置提交：`95d6a99f1a2507aeefbe21df78c93626aed72633`（75 文件，5336+/27−）。仅模块平台检查点，未推送；后续收尾未获再次自动提交授权。
- 最近观察 HEAD `39015a476c805f02a877c5115348809165a4d5cc`；其他会话继续提交维护代码。最终候选会固定基线 HEAD 和精确 overlay，不把共享活动树当冻结状态。

## 当前验收证据

| 项目 | 当前结论 |
|---|---|
| 严格参数、兼容契约 | 106/106；保存/导入 sentinel 3/3 |
| 双引擎接线、变量/nonce/循环/重试 | native-open 25/25；原独立 fallback/registry 断言通过 |
| 原生持久化、审批、UI→完整 runner→文件→下游 | 隔离 Electron create 12/12、另起进程 reopen 7/7 |
| 负向控制 | 原生共享 save guard 被移除时指定断言失败；提前 exit 0 缺回执仍失败，2/2 |
| 组合 E2E 的首轮活动树执行（历史） | **失败**：目录浏览器 CDP 超时；其余 native/生产 workflow/save 阶段通过 |
| 新增测试后的活动树双包检查（历史） | contracts 0；desktop 180 秒超时，无诊断，**不是通过** |
| 组合 E2E（候选 B） | `module-phase2-e2e-smoke` 10/10，含 `FULL native persistence/UI plus real scheduler and browser negative states`；证据 `apps/desktop/.tmp/p2-06-e2e-gPeLQ8`；安全套件 20/20，证据 `p2-06-security-jngkup` |
| 双包类型检查（候选 B） | contracts 0、desktop 0；日志 `p2-07-candidate-B-20260927143258/tsc-*.log` |
| 动态全量（候选 B） | 139/139 通过，exit 0；日志 `p2-07-candidate-B-20260927143258/full-smoke.log`，逐套日志 `apps/desktop/.tmp/smoke-runs/1790490900122-14524-VX7vIK/`（139 个） |

历史日志、失败分类和各边界详见 task-01.md、task-05.md、task-06.md 及 security-findings.md。最终套件数量以候选的动态发现结果为准，不固定写 106。

## 冻结策略

从固定的已提交 HEAD 创建独立本地候选，仅叠加本次 01/05/06/07 的明确收尾文件；不复制资料库、维护等其他会话的未提交改动，包括混合归属的 workflows/assets.ts。安装依赖仅以目录链接复用，不安装/升级。候选有自己的 Git index，记录树及 overlay SHA-256；不修改主仓库 index、HEAD 或历史，不创建新提交。

在候选中串行执行定向、动态全量、类型检查和差异/源码不变检查。日志与退出码落盘，失败不以自动重试覆盖。

## 首个冻结候选的真实结果

A：`.tmp/p2-07-candidate-TC76Xw/`；HEAD `30b7df94b33b1cee94b7743a6668ed299cba92f8`，tree `94375fe1eaa9ba8ebdd4ee26f313e888da440282`，动态发现 129 套。10 项 runner 自测、双包类型、11 套定向均通过；完整 E2E 回执有效。全量尚未完成，主动中断，**不是全量绿灯**。

全量已发现并进入修订：05 的内置参数 help 缺失/过长；共用无窗口测试桩缺新增导出（用户明确授权只补该测试文件）。截图辅助工具也补绘制等待，避免旧帧。具体授权、失败及中断日志见 task-07.md。下一候选使用同一提交基线，保留原失败，不将重跑当作抹除记录。

## 第二个冻结候选（B）的真实结果

- 目录 `apps/desktop/.tmp/p2-07-candidate-B-20260927143258/`；HEAD `e1d06d0faa52526b001d733871ae7633a5f364c1`（含 MAINT A 组全部提交）。`manifest.json` 记录冻结时刻工作树 56 个未提交文件/目录内文件的 SHA-256（`status.txt` 为 `git status --short` 原样）。
- 冻结方式与 A 不同：用户确认 P2 其他对话均已停止，因此直接在活动树上冻结并串行运行，不再复制候选树；以 manifest 哈希对照代替独立 index。脚本 `p2-07-freeze.ps1` / `p2-07-verify.ps1` / `p2-07-diffcheck.ps1` 同在 `.tmp/`。
- 执行顺序与结果：runner 自测 10/10（`runner-selftest.log`）→ contracts tsc 0 → desktop tsc 0 → `git diff --check` 0 → `run-smokes.mjs --all` 动态发现 **139** 套（A 时 129，差额为新增 maint 套件），139 通过 / 0 失败，耗时约 24 分钟，exit 0。全部日志与退出码已落盘，未重跑、未重试。
- 运行结束后复核 manifest：HEAD 不变；**5 个 overlay 在运行期间被改动**——`src/main/library/fileImport.ts`、`renderer/components/library/ItemList.tsx`、`i18n/{en,zh}/library.ts`、`docs/parallel-maintenance/PLAN.md`，另新增 10 个脏文件与 `maint-m33/34/35-smoke`。它们来自用户同期放行的 MAINT C 组（M33–M35，资料库域），**不属于 P2 模块平台范围**；P2 范围文件（`module-*`、`orchestration/nodeTypes.ts`、`contracts/nodeType.ts`、`projects-ipc-smoke/stubs/window.ts`、`module-phase2-e2e-smoke/*`、本组文档）哈希前后一致。因此本全量对 P2 范围有效；对资料库域及最终合并树的全量以 MAINT M38 的冻结候选为准，本记录不替它宣称。

## 最终验收清单核对

- 原第一阶段功能不退化：`module-platform-smoke`、`module-ui-smoke`、`module-catalog(-ui)-smoke`、`module-workflow-smoke` 全部通过（全量内）。
- 能力目录/工作流目标来自真实宿主：06 独立断言与 E2E `PRODUCTION exported engine must register module-capability` 通过。
- 菜单与工作流复用同一后端能力、只读内置能力可运行、用户模块自动化调用被拒绝、参数/工作区/取消/重试/循环/结果映射语义一致：`module-phase2-e2e-smoke` 10/10、`module-phase2-security-smoke` 20/20、`module-contract-smoke`、`module-executor-smoke` 通过。
- 01～06 报告与安全发现：01 FROZEN、02/03/04 READY_FOR_INTEGRATION（02 的"候选复验"与 04 的旧菜单 harness EBUSY 均已被候选 B 全量覆盖，未复现）、05/06 由本对话按本记录更新为 VERIFIED；`security-findings.md` 无未关闭的阻断项。
- 新旧测试、全量 smoke、双包类型检查：通过（见上）。全量已注明冻结方式；套件数取实际发现值 139。
- 文档与真实界面一致、Electron 未做部分明确"未验收"：见"原生验收边界"及 `docs/ui-module-platform-phase2.md`。
- 无真实模型调用、真实数据修改、依赖安装或外部代码；未夹带其他任务变更（C 组变动已如实列出并排除在 P2 范围外），未提交、未推送。

## 原生验收边界

已验证：真正的 Electron BrowserWindow、实际 preload/native IPC、SQLite/工作流存储、生产模块目录、实际 AutomationRunner/runner/scheduler/builder、同一惰性 service/ModuleHost/文件能力，以及另起进程重开。

隔离端口：禁止调用的 agent/provider 桥、应用窗口 bootstrap/event 桥、读取真实 ProjectRepo 的引导接口；UI 取消另用明确标注的宿主计时 fixture。没有预制文件结果或虚假保存确认。

**未验收：** 正式安装包完整启动/升级、用户主应用所有面板与服务组合、实际 FileTree/FilesPanel 与 WebContentsView 遮挡、真实模型和手机。功能窗口通过不代表这些场景通过。任务句柄不跨重启恢复；没有引入任意外部代码或新依赖。
