# UI-MODULES-P2 / 任务 05：生产接线与内置能力节点

## 当前状态（01/06/07 收尾更新）

**VERIFIED**（2026-09-27，依据 integration.md 候选 B：全量 139/139、双包 tsc 0、diff 0；05 的 `mcode-admin-smoke` 参数 help 缺口已确认关闭）。原 READY_FOR_INTEGRATION 说明保留如下。

**READY_FOR_INTEGRATION**。用户后续移交 01/07 和 06 后，原两项跨任务阻塞已解决：共享严格保存/导入校验已补齐，生产 runnable 已在双入口/fail-closed 证据后激活。冻结契约仍是 P2-01 / 1.0.0。

- 生产 native-open 工作流专项 25/25、strict save/import sentinel 3/3 已通过。
- 新增 06 的隔离 Electron 功能窗口已实际经过 AutomationRunner、完整 runner、scheduler、原变量构造器、同一 service/host 和文件能力；首次 12/12、另起进程重开 7/7。证据 `apps/desktop/.tmp/p2-06-native-eLglkj/`。
- 这不是完整安装包或实际 FileTree/BrowserView 场景验收；最终冻结候选、全量与类型检查归 07，当前不借定向通过宣称全阶段完成。
- 先前“不自动提交”后来仅获一次明确例外：模块平台检查点 `95d6a99` 已提交，未推送。后续收尾不自动再提交。
- 以下保留原交付历史。其 BLOCKED / gate closed / 未提交，是当时状态，不是当前结论。

### 全量发现的短说明缺口（收尾修复）

候选 A 的 mcode-admin-smoke 真正加载生产内置清单后 **246/248**：moduleId/contributionId 缺 help，path 的 help 为 121 字、超过通用 80 字限制。这是本任务清单问题，不删除或改宽旧测试。

已在自己拥有的 nodeTypes.ts 中为三个参数提供非空、≤80 字的 help，并在 module-workflow-smoke 的清单检查中增加同样的断言；不改参数键、权限、输出或执行逻辑。旧失败日志保留在 `.tmp/p2-07-candidate-TC76Xw/repo/apps/desktop/.tmp/smoke-runs/1790487540009-5836-aYGqyy/mcode-admin-smoke.log`，新候选将复验。

### 原交付状态（历史）

**BLOCKED — 本任务拥有文件内的接线和定向验证已完成，但整项验收尚未完成。**

阻塞为两个跨任务关口：**01 的严格保存/导入参数校验尚缺失**，以及 **01/07 尚未激活生产 runnable 门禁**。没有把测试 bundle 的门禁激活当成生产可用，也没有把仍然失败的完整专项写成通过。

- 当前承接对话标识：Arena Agent / UI-MODULES-P2 / P2-05-transfer-20260927。
- 移交记录：原承接者为 Arena Agent / P2-05（与 P2-04 同一对话）；原报告称仅审查接线点、未修改生产文件。2026-09-27 用户通过明确选项确认原承接对话已停止写入，并正式移交本对话；既有成果保留。
- 本对话开始 HEAD：`fe62fe35831ab3bec97b6bcc06673c761ea5a91e`。
- 收尾核对 HEAD：`36014a182208f28ff72e7f12a79edd3e1b0ebd66`。执行期间共享仓库 HEAD 发生变化，**不是本对话执行提交造成**；本任务改动仍在工作区。
- 冻结接口：**P2-01 / 1.0.0，FROZEN**。已读取 01、02、03、04 报告，均为 READY_FOR_INTEGRATION。
- 已读 `PARALLEL_TASKS.md` 的共同约定、任务 05、文件边界、交接格式，以及项目规则和 `docs/testing.md`。开工和收尾均记录 `git status --short`；工作区一直有其他对话的并行改动。
- 没有冻结整库快照。测试结果仅对当时活动树负责；新专项的 `result.json` 记录关键源码 SHA-256。

## 已完成

1. **两条生产注册路径共用同一工厂**：新增 `createBuiltinExecutionEngine()`，供共享 `executionEngine` 与 `runner.ts` 的 run-scoped 引擎调用。保留 command/code；runner 仍追加 conversation 和既有模型 fallback。能力预检清单从真实 `runEngine.kinds()` 取得，不再另写一份易遗漏的新 kind 列表。
2. **缺少 module 执行器时 fail-closed**：显式返回 failed 和 `No executor registered`，绝不转成模型回合。其余既有 fallback 语义不改。
3. **惰性接入同一个 ModuleHost**：实际 03 的 host 工厂为同步端口，而 02 的 `getModuleHost()` 返回 Promise。05 在 engine 的异步 start 钩子中等待服务，再向未修改的执行器提供真实宿主。仅 import / 构造引擎不会打开数据根；预取消也不初始化宿主。没有把 Promise 强转为宿主，没有第二套授权或任务表。
4. **规范化输入与尝试身份**：通过既有 `NodeInputBuilderRegistry` 注册 module builder。runner 用 `createWorkflowInputBuilder({ sessionId, runId })` 绑定可信运行身份，scheduler 的 `ports.buildInput` 仍调用原有参数/变量解算链。只在专用 builder 中使用冻结的两个 Zod schema；不读调用者提供的身份或工作区字段。
5. **每次实际派发的新 nonce**：`wf:` 加 `[sessionId, runId, nodeId, randomUUID()]` 的 SHA-256，长度 67。完整 requestId 保存在本次 `input.moduleCall` 中；同次传输重试复用该输入，新派发、循环下一轮和明确失败重投获得新值。未拿成功才递增的 rounds 或 choiceAttempts 冒充尝试计数。
6. **真实内置节点清单**：注册 `mcode.module-capability`，参数只有 moduleId/contributionId/path，与 04 配置控件一致。目录声明 bytes、仅 inspect 的 sha256、仅 info 的 modifiedAt；不伪称每种贡献都有全部字段。
7. **目录传输与边界验证**：真实主进程模块 IPC、真实 preload 经结构化克隆替身传输增强目录；原 SDK 调用仍可用。未新增任何 RPC，未向 renderer/mobile 暴露 invokeForWorkflow；webApi 的 modules 七方法仍明确拒绝且不发网络请求，因此 IPC/preload/webApi/SDK 无需改动。
8. **合法最小示例**：新增 `examples/workflows/module-file-inspect.json`，真实 schemaVersion 为字符串 `"1"`，使用手动触发器 → inspect，enabled=false、没有定时/文件监听。运行前需在所选工作区准备 `module-inspect-demo.txt`，选择项目、审查并明确手动运行。示例不自动创建用户文件、不自动启用执行。
9. **原有屏障保留**：未改 node.started 的在飞持久化屏障或既有 review/replay 守卫；中断时仍在飞的模块节点不会被自动重放。任务恢复、跨重启 exactly-once 不在本轮承诺内。

## 实际改动文件

全部属于任务 05，没有修改其他任务拥有的文件。

| 路径（相对 mcode） | 类型 | 用途 |
|---|---|---|
| `apps/desktop/src/main/orchestration/executionEngine.ts` | 修改 | 共享注册工厂、异步惰性宿主适配、专用输入 builder/身份作用域、fail-closed |
| `apps/desktop/src/main/orchestration/runner.ts` | 修改 | 使用共享工厂、绑定运行身份、从真实引擎取得 executorKinds |
| `apps/desktop/src/main/orchestration/scheduler.ts` | 修改 | 一个可选的 host-bound 输入构造端口及调用，不复制参数解析或能力业务 |
| `apps/desktop/src/main/orchestration/nodeTypes.ts` | 修改 | 新内置节点的正式清单 |
| `examples/workflows/module-file-inspect.json` | 新增 | 禁用自动触发的手动文件检查示例 |
| `apps/desktop/scripts/module-workflow-smoke/` | 新增 | 定向测试、红灯哨兵、隔离适配和日志入口，详见下表 |
| `docs/parallel-ui-modules/task-05.md` | 更新既有报告 | 保留移交事实，记录真实证据与阻塞 |

新专项包含 14 个文件：

- `baseline.ts`、`main.ts`、`save-guard.ts`、`runnerPath.ts`。
- `build.mjs`、`verify.mjs`、`run.sh`、`README.md`。
- `stubs/dataRoot.ts`、`pathGuard.ts`、`catalogSources.ts`、`spawnRun.ts`、`electron.ts`、`repositories.ts`。

生产源码只有上述 4 个文件发生本任务修改；收尾 `git diff --stat` 为 **118 insertions / 13 deletions**。未修改清单所有权之外的 `nodeInputBuilders.ts`，也未修改 01 的 schema/门禁、02 的宿主、03 的执行器、04 的 UI。`workflows/assets.ts` 开工时已有并行修改，本任务最终没有触碰它。

## 测试证据

以下命令均从 mcode 根目录执行。日志均落盘，不以当前 MCP command ID 作为唯一凭据。

### 有效红灯 → 绿灯

| 检查 | 结果与证据 |
|---|---|
| 实施前 `build.mjs --baseline` | **0/3，exit 1**；真实 engine 未注册、缺执行器误走 fallback、真实内置清单缺节点。打包与测试均成功加载。日志：`apps/desktop/.tmp/module-workflow-7ZfvRX/{output.log,result.json}` |
| 实施后同一基线 | **3/3，exit 0**。日志：`apps/desktop/.tmp/module-workflow-Y2sogE/{output.log,result.json}` |
| `build.mjs --mutation-fallback` | **exit 1（预期红灯）**；只在临时 bundle 恢复 module 的模型 fallback，真实断言拿到 success 而不是 failed。两阶段各恰有此项失败。日志：`apps/desktop/.tmp/module-workflow-kGOb3b/{output.log,result.json}` |
| `build.mjs --mutation-identity` | **exit 1（预期红灯）**；只在临时 bundle 把 nonce 固定，连续新分派 requestId 相同、新派发未增加宿主任务等断言失败。日志：`apps/desktop/.tmp/module-workflow-8HzHY0/{output.log,result.json}` |

没有为制造红灯修改生产授权或撤销其他人的成果。综合测试首轮有一次夹具错误：手动触发器使用了不支持的 `trigger.files`，真实保存校验将其拒绝；已改用既有 `trigger.kind`。这不计作产品有效红灯，也没有放宽变量规则来迁就测试。

### 本任务接线专项（独立于保存校验哨兵）

```sh
node apps/desktop/scripts/module-workflow-smoke/build.mjs
```

- **native-closed：21/21 通过**，验证生产门禁仍拒绝调度。
- **fixture-open：25/25 通过**，只在临时 esbuild bundle 中打开 runnable 门禁，再跑真实 scheduler → 注册表 → 输入构造 → 执行器 → 服务 → ModuleHost → 文件能力链。
- 两阶段有重复的基础断言，不能宣传成 46 项互不重复的独立测试。
- 直接运行证据：`apps/desktop/.tmp/module-workflow-R4yWuI/{output.log,result.json}`，exit 0。
- 最终统一入口中的同一部分再次通过：`apps/desktop/.tmp/module-workflow-s19dOv/{output.log,result.json}`，exit 0。

覆盖：真实 query 的 bytes/modifiedAt、真实 task 的 bytes/SHA-256、上游 outputs 经既有变量进入下游路径、未解析变量/非法参数零执行、路径越界/未知工作区、user.* 菜单兼容与工作流拒绝、未知贡献、同次请求去重、新执行身份、真实循环、失败且 rounds 未增长时的明确重投、已定案节点续跑不重做、预取消/执行中取消、目录/IPC/preload/SDK、移动端显式拒绝、示例导入导出配置保持、review/replay 守卫。

### 既有定向回归

```sh
node apps/desktop/scripts/run-smokes.mjs execution-engine-smoke scheduler-smoke node-session-smoke workflow-validation-smoke ipc-wiring-smoke ipc-parity-smoke module-platform-smoke module-executor-smoke
```

**8 套通过 / 0 失败，exit 0。**

日志：`apps/desktop/.tmp/smoke-runs/1790483756293-40000-91RNVN/`，各套有独立 `.log`。没有运行全量。

### 类型与差异检查

```sh
node apps/desktop/scripts/module-workflow-smoke/verify.mjs
```

- contracts `tsc --noEmit`：**exit 0**。
- desktop `tsc --noEmit`（含 scripts）：**exit 0**。
- 限定本任务路径的 `git diff --check`：**exit 0**；Git 对未跟踪文件的检查范围不等同于已跟踪文件。
- 各项完整命令、退出码和日志：`apps/desktop/.tmp/module-workflow-verify-H6xNhJ/` 的 `result.json`、`contracts-typecheck.log`、`desktop-typecheck.log`、`owned-diff-check.log`。

### 当前仍失败的集成门禁：不能写成通过

```sh
node apps/desktop/scripts/module-workflow-smoke/build.mjs --save-guard
node apps/desktop/scripts/run-smokes.mjs module-workflow-smoke
```

- 严格保存/导入哨兵：**0/3，exit 1**。三组输入分别为多余 trusted/requestId、NUL path、超过 4096 字符的 path；真实 save 共同校验器和 import 校验器都返回了 true，预期均为 false。
- 最终直接哨兵日志：`apps/desktop/.tmp/module-workflow-IExik6/{output.log,result.json}`。
- 完整专项统一入口：**0 pass / 1 fail，exit 1**，原因就是上述 3 项，并非加载失败；前面的接线两阶段已经通过。
- 统一日志：`apps/desktop/.tmp/smoke-runs/1790483905132-25536-WYVKn1/module-workflow-smoke.log`。
- `run.sh` 明确执行该哨兵；未来 `run-smokes.mjs --all` 不会把这个未解决缺口悄悄隐藏。

### 真实实现与替身的边界

真实部分：生产清单、输入 builder/变量解析、调度器、引擎/注册、执行器、服务/宿主/文件能力、IPC handler、preload、webApi、纯导入导出/审批与重放守卫。runner 的注册表达式、输入绑定和预检清单由 TypeScript AST 从真实源码提取后执行，不手抄注册链。

替身仅隔离数据根与已登记项目查找、无关插件/资料库目录源、review marker 的内存设置、Electron 结构化克隆传输；外部进程执行为 fail-closed 桩。runner 的会话/数据库 bootstrap 没有启动。所有文件测试仅在本套唯一 `.tmp` 目录中进行，没有触碰真实用户库、真实数据根或用户项目文件。

## 跨任务请求 / 阻塞

### P2-01-REQ-01 回复：执行尝试身份已落地

- 具体位置：`executionEngine.ts` 的 `createWorkflowInputBuilder` 和专用 builder；`runner.ts` 的 `ports.buildInput`；`scheduler.ts` 的输入构造调用点。
- 使用 AsyncLocalStorage 绑定同步输入构造期间的 sessionId/runId/nodeId，再产生派发 nonce；不同运行不会共用可变全局身份。
- 同次重试复用完整输入；新分派才调用 builder。真实宿主去重、循环、失败重投和续跑断言均有证据。
- 没有为该扩展修改未分配的 `nodeInputBuilders.ts` 或持久化 schema。

### P2-05-REQ-01 → 01 / 07：严格保存/导入参数校验（阻断完成）

真实 `workflowValidation.validateWorkflowDoc` / `importWorkflowDoc` 共用 `@contracts/nodeType.validateNodeParams`，后者目前只遍历参数 spec，不拒绝额外执行字段和冻结 schema 的路径边界。

**最小请求：由 01 在其拥有的 `packages/contracts/src/nodeType.ts` 中，对 module-capability runner 复用 `ModuleWorkflowCallSchema.safeParse(params)`；其他 runner 保持兼容。** 这样保存、导入、运行前检查共用一处规则，不要在多个 IPC 入口复制校验。路径变量模板应继续按冻结 schema 保留，真正求值仍由调度器负责。

05 已在运行时 builder 严格拒绝这些值，不能靠它们获得执行权限；缺口是第 05 节要求的“保存/导入时尽早发现非法参数”。05 不修改 01 文件，也不越界修改 workflowValidation/library。修复后先跑 `--save-guard`，应为 3/3，再跑完整 `run.sh`。

### P2-01-REQ-02 回复 → 01 / 07：生产 runnable 激活（阻断真实可用）

两条注册路径、可信输入、缺执行器拒绝与原模型 fallback 兼容的证据已提供；移除 fail-closed 的测试 bundle 突变确实红灯。

**生产门禁未激活。** 收尾读取 `IMPLEMENTED_RUNNER_KINDS` 仍不含 module-capability。请 01/07 在处理上述保存校验缺口并复核接线证据后，由 01 激活其拥有的 `nodeType.ts` 并更新契约门禁测试。05 没有擅自改动。

激活后本套 build.mjs 自动切换成 native-open，直接验证原生源码上的调度链；此后才可进入 06/07 的独立复验与全量候选验收。

### 给 03 的兼容说明

报告中 `host: () => getModuleHost()` 示例与实际同步工厂类型不一致。05 用异步 start 钩子适配了真实 Promise 服务，03 实现保持未改；没有依赖未经校验的类型断言。

## 给下一任务的接入说明

```ts
import { createBuiltinExecutionEngine, createWorkflowInputBuilder } from "./executionEngine.js";

const engine = createBuiltinExecutionEngine();
const buildInput = createWorkflowInputBuilder({ sessionId, runId }); // 仅可信运行态
```

- 不再自行复制 command/code/module 注册清单；run-scoped conversation/fallback 仍由 runner 追加。
- `RunPorts.buildInput` 形状与原 `buildNodeInput` 相同；它接收既有变量解析后的 params。未绑定身份的 module 输入构造会明确失败。
- 不在 UI 中填写 requestId/projectPath/trusted，不直接调用 capability.run；工作区只来自 ExecutionContext.cwd，真正授权仍由 ModuleHost 承担。
- 06 可复用本套 `--mutation-fallback` / `--mutation-identity`，但必须区分原生门禁与 fixture-open。
- 示例使用前：准备临时演示文件、选择实际项目，检查导入审查状态，明确手动运行；不会自动执行真实文件任务。

## 未实现 / 未验证

- 保存/导入的三组严格校验仍未通过，等待 01；本任务不能标为 READY_FOR_INTEGRATION 或 VERIFIED。
- 生产 runnable 门禁仍关闭；新节点虽在真实目录中，但实际 UI 执行尚不可用。
- 未跑全量 smoke，未冻结整库，未做 Electron 实机/真实窗口交互、真实数据库保存与重开、手机实机验收。
- 无跨应用重启任务恢复或 exactly-once 承诺；无用户模块自动化授权、写能力或任意外部库执行。
- 原有 04 浏览器报告不当作本轮实测；本报告不替代 06/07 的最终验收。

## Git 与并行保护

- **未提交、未推送、未暂存。** 未执行 git add、commit、push、reset、checkout、stash 或全库格式化。
- 开工/收尾均保留共享工作区中模块、UI、library、plugins、maintenance 等他人改动；没有覆盖、删除或回滚。
- 所有远端源码/测试/报告写入都使用工作区相对路径和版本校验补丁，已有文件先读后改。
- 收尾四个生产源码版本与最终测试 manifest 一致；未修改的 nodeInputBuilders、任务 03 执行器及任务 01 门禁版本也已核对。
