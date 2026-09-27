# UI-MODULES-P2 / 任务 01：契约与接口冻结

## 状态

**READY_FOR_INTEGRATION — 01 收尾已完成，阶段最终验收由 06/07 继续。**

2026-09-27 用户授权本对话接手 01/07，另确认 06 的剩余测试移交。当前承接者：Arena Agent / UI-MODULES-P2 / P2-01-07-transfer-20260927。

- 收尾开始 HEAD：`95d6a99f1a2507aeefbe21df78c93626aed72633`，这是用户授权的模块平台 75 文件检查点，未推送。
- 本阶段仅在 01 所有文件中补共享严格保存/导入校验、生产 runnable 门禁及对应测试/冻结稿；保留既有冻结公共字段。
- 已收到并核对 05 的 P2-01-REQ-01 / REQ-02 回应及 P2-05-REQ-01；先重现红灯，再实现，不把测试 fixture-open 当成生产激活。
- 以下为前承接者的历史交接与证据；收尾的新结论将单独记录，不把历史待接线状态当成当前结果。

## 2026-09-27 移交后的收尾结果

- 冻结版本仍是 **P2-01 / 1.0.0**，没有破坏公共字段、旧 v1 或权限边界。
- `validateNodeParams` 对模块 runner 调用已有 strict schema，保存/导入/预检共享拒绝非法参数；其他 runner 和模板语义不变。
- 在收到 05 双生产入口、共同注册工厂、缺执行器不走模型的证据后，激活生产 runnable；不是 fixture-open。
- 仅追加/调整 01 的契约测试与接口注记；`main.ts` 现在收集所有失败，正常 **106/106**。

| 本阶段证据 | 结果 | `.tmp/` 产物 |
|---|---|---|
| 修复前契约红灯 | 92 pass / 14 fail，exit 1；已加载真实契约 | `module-contract-VunAFw` |
| 修复前共享保存/导入 sentinel | 0/3，exit 1 | `module-workflow-ixWRFD` |
| 修复后契约 | 106/106，exit 0 | `smoke-runs/1790485245302-50120-yhRS5j/module-contract-smoke.log` |
| 原生工作流接线 | native-open 25/25；strict sentinel 3/3，exit 0 | 同目录 `module-workflow-smoke.log` |
| 既有保存/导入验证 | PASS，exit 0 | 同目录 `workflow-validation-smoke.log` |
| 01 修复后双包 tsc / owned diff | 各 exit 0 | `module-workflow-verify-ckgJde` |

四套定向运行整体仍 exit 1：原 06 探针明确返回 9 PASS / 0 FAIL / 1 BLOCKED（exit 2），因为完整 Electron/持久化验收尚未补齐；没有将它写成全阶段绿灯。06 新增原生测试的开发与最终候选复验由其报告单独记录，不能用本节旧 tsc 代替后续新增测试的检查。

`nodeType.ts` 此时 SHA-256：`61c5152016563320fe2e6261ae74ff2f4fc84d7158725022b003cb670c804d27`。当前严格参数规则及激活说明见 interface-v2.md。后续新增测试/正式交付只以 07 的冻结候选为最终证据。

以下所有“未激活 / 未取得 05 回复 / 早期 desktop 类型失败”均为**前承接者的历史状态**，不是当前 01 结论；保留供审计追溯。

### 前承接者的已交付记录（历史）

- 承接对话标识：Arena / UI 模块平台原实现对话 / P2-01。
- 开始 HEAD：`4e25a77fa0b95a97baf2f9423d399e442b98aab4`。
- 收尾核对 HEAD：`4e25a77`（共享工作区存在其他对话持续改动）。
- 接口冻结版本：**P2-01 / 1.0.0，FROZEN**，见 `interface-v2.md`。
- 02/03/04 的早期报告中“尚未发布接口”的描述已过时：冻结稿现在已落盘，可按它继续接入。本任务未代改他们的报告。
- 05/07 在本次核对时尚无报告；执行尝试落地确认与 runnable 激活请求保留为跨任务事项，没有伪称已获得确认。

## 已完成

1. 新增兼容的能力目录描述、元数据、可选 workflowTargets，以及目录引用一致性校验。
2. 新增有字节、深度、节点和容器预算的展示型 JSON Schema 子集；拒绝不安全/非 JSON 数据与不允许的引用，不执行 schema。
3. 将用户节点参数与宿主执行输入分开：参数只有 moduleId/contributionId/path；执行输入必须另有宿主 requestId。
4. NodeRunnerSchema 识别严格的 `module-capability`；NodeRunInput 增加可选的强类型 moduleCall。
5. 保留旧 v1 清单、旧目录和七条 RPC 的兼容性；缺 metadata/targets 不自动授予权限。
6. 明确 query/task → NodeOutcome、进度单位、取消竞态、丢失任务和执行尝试身份语义。
7. 核对真实 fallback 风险，保留生产 runnable 启用门禁，避免仅新增类型就误触发模型调用。

## 实际改动文件（仅任务 01 范围）

### 契约

- **新增** `packages/contracts/src/moduleCapability.ts`：全部新 schema、类型、常量与有限 JSON Schema 数据校验。
- **修改** `packages/contracts/src/modules.ts`：类型导入、capabilities 元素兼容增强、可选 workflowTargets。
- **修改** `packages/contracts/src/nodeType.ts`：导入严格新 runner schema，并说明暂不启用的原因；原 runnable 列表不放开。
- **修改** `packages/contracts/src/runtime.ts`：仅新增类型导入与 NodeRunInput.moduleCall；保留其他对话的事件/移动同步变更。

### 独立测试

新增 `apps/desktop/scripts/module-contract-smoke/`：

- `baseline.ts`：针对既有生产 runner schema 的有效红灯。
- `main.ts`：91 项运行时契约断言。
- `types.ts`：新旧类型兼容与 `@ts-expect-error` 反例。
- `typecheck.json`：单独检查本套件的类型，不依赖全桌面检查绿灯。
- `build.mjs`：使用已安装 esbuild；记录独立日志；支持仅测试 bundle 的深度 mutation。
- `run.sh`：供统一 smoke runner 发现的正常入口，不开启 mutation。

### 文档

- **新增** `docs/parallel-ui-modules/interface-v2.md`：FROZEN 接口与跨任务接入说明。
- **新增** 本报告 `docs/parallel-ui-modules/task-01.md`。

没有修改 IPC/preload、SDK、主进程能力实现、执行器、调度器、前端、翻译或其他任务测试。

## 测试证据

### 有效红灯

1. **实施前 runner 行为红灯**
   - 命令：`node apps/desktop/scripts/module-contract-smoke/build.mjs --baseline`
   - 退出码：1。
   - 断言：`P2-01: contracts must recognize the module-capability runner`，实际 false，期望 true。
   - esbuild 成功、真实生产契约被加载；不是缺文件/缺依赖错误。
   - 日志：`apps/desktop/.tmp/module-contract-hbUDP4/{output.log,result.json}`。

2. **安全断言 mutation 红灯**
   - 命令：`node apps/desktop/scripts/module-contract-smoke/build.mjs --mutation-depth`
   - 退出码：1（预期失败）。
   - 只从临时 esbuild bundle 删除 `depth > MODULE_SCHEMA_MAX_DEPTH` 限制；生产源文件未撤销保护。
   - 深层 properties 子 schema 被错误接受后，深度断言触发 `true !== false`。
   - 日志：`apps/desktop/.tmp/module-contract-vjX5RZ/{output.log,result.json}`。

### 绿灯

| 检查 | 命令 / 结果 |
|---|---|
| 新契约运行时专项 | `node apps/desktop/scripts/module-contract-smoke/build.mjs`：**91/91，退出码 0** |
| 类型正例/反例 | `node apps/desktop/node_modules/typescript/bin/tsc --noEmit -p apps/desktop/scripts/module-contract-smoke/typecheck.json`：**退出码 0** |
| contracts 包 | `node packages/contracts/node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json`：**退出码 0** |
| 原后端 / IPC / SDK 专项 | module-platform-smoke：**33/33** |
| 原真实浏览器专项 | module-ui-smoke：**8/8** |
| 工作流验证专项 | workflow-validation-smoke：**70/70** |
| 上述兼容性三套统一入口 | **3 pass / 0 fail，退出码 0** |
| 本任务已有契约文件 diff --check | **退出码 0** |

兼容性命令：

```sh
node apps/desktop/scripts/run-smokes.mjs module-platform-smoke module-ui-smoke workflow-validation-smoke
```

日志：

- 新契约：`apps/desktop/.tmp/module-contract-YeFtq7/{output.log,result.json}`。
- 兼容性三套：`apps/desktop/.tmp/smoke-runs/1790477015464-16744-6QkIwM/`。
- 浏览器产物：`apps/desktop/.tmp/module-ui-1W4B4E/`。
- 类型命令在 MCP 中实跑，终态分别为 fixture/types 0、contracts 0、desktop 2；desktop 诊断摘录见下一节。没有使用缓存绿灯代替执行。

浏览器日志另有自身隔离 profile 的 `EBUSY / cleanup deferred` 警告；8 项行为断言通过。不进行系统范围浏览器清理，也不据此声称所有临时文件已删除。

本次是并行工作区的定向验证，没有冻结整库快照。没有执行全量；全量归 07，不能用本报告替代全阶段门禁。

## Desktop 类型检查：未通过，交给对应所有者

命令：`node apps/desktop/node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json`。

实跑退出码 **2**，本次观察到以下 6 项诊断：

| 位置 | 诊断 | 归属 / 处理 |
|---|---|---|
| `renderer/components/settings/workflows/WorkflowNodeCard.tsx:117` | TS2741：`Record<NodeRunnerKind, NodeLook>` 缺 `module-capability` | **任务 04** 补新 runner 的外观映射；这是本次联合类型扩展的已知消费者适配 |
| `scripts/memory-smoke/main.ts:744` | TS2345：memory import 入参缺必填 `category` | 记忆模块并行改动，不属于 01 |
| 同文件 `:747` | 同上 | 不越界修复 |
| 同文件 `:749` | 同上 | 不越界修复 |
| 同文件 `:757` | 同上 | 不越界修复 |
| 同文件 `:758` | 同上 | 不越界修复 |

这些是该次运行的观察结果；其他对话可能随后修复，07 应在集成快照重新检查。**没有宣称 desktop typecheck 已通过。**

## 跨任务请求与回应

### P2-01-REQ-01 → 05 / 07：执行尝试身份与输入构造

- 已核对并认可 03 提出的 `rounds` 问题：它只在成功时追加；失败后重跑不能据此获得新身份。choiceAttempts 仅用于分支询问，也不适用。
- 冻结稿采用“每次新派发由宿主产生 nonce，再和 sessionId/runId/nodeId 哈希”的方案。同次尝试重试复用，新派发更换，不依赖失败结果更新计数。
- 03 建议的持久 dispatchSeq 并非本轮必需；当前宿主任务本来不跨重启恢复。本轮不为此扩大 RunSnapshot/持久任务范围。丢失旧任务显式失败，不能自动重做未知执行。
- 05 需确认在真实输入构造/运行边界如何生成并传入完整 requestId；不是把生成职责下放给 UI 或执行器轮询。
- 真实扩展点 `main/orchestration/nodeInputBuilders.ts` 未在原分工表分配写入所有权。若必须修改其 scope/注册，先由 07 明确分配；01 不越界，05 也不应偷偷改未分配文件。

### P2-01-REQ-02 → 05 / 07，后续由 01 激活：生产 runnable 门禁

- 新 kind 的类型与参数现在已可使用，但 `isNodeRunnable` 仍返回 false。
- 05 先覆盖 executionEngine.ts 与 runner.ts 两个注册路径，并证明缺执行器时不会落到模型 fallback；随后反馈 01/07。
- 01 再在自己拥有的 nodeType.ts 增加 implemented kind，调整“未接线不启用”断言；07 在激活后的冻结候选执行最终回归。
- 这是有意的安全启动关口，不是遗漏；不能为了消除“节点跑不了”提示先放开。

### 回应 03

- 所需三个输入字段、宿主 requestId、结果映射、进度转换及取消语义已冻结。03 可以继续实现独立执行器和定向测试，不必等待生产 runnable 激活。
- 不要读取用户原始 params 来绕过 moduleCall；真实宿主测试接 02 的 invokeForWorkflow。
- 03 预告中的 `{host: getModuleHost()}` 需注意：getModuleHost 返回 Promise，且不应在模块导入时触发真实数据根初始化。优先注入惰性 `getHost: () => Promise<WorkflowModuleHostPort>`，或在获准的执行路径 await 后构造；不能把 Promise 当作同步宿主实例。

### 回应 02 / 04

- 接口已发布，旧报告中的“尚未 FROZEN”依赖可重新核对并解除。
- 02 使用真实 builtin 集合授权，目录 schema 不能替代授权。
- 04 补 WorkflowNodeCard 映射，metadata/workflowTargets 缺失时保留明确不可用状态，不推断授权。

## 未实现 / 未验证

- 本任务没有实现宿主目录、invokeForWorkflow、工作流执行器、生产接线或 UI。
- 尚未收到 05 的生产身份构造确认；请求已写入冻结稿，不伪称已协调完成。
- 尚未启用 module-capability 的生产 runnable 状态。
- 没有全量 smoke 结论，没有冻结整库的 desktop 类型绿灯，没有 Electron 实机验收。
- JSON Schema 子集不是完整元 schema 引擎，也不是第三方代码隔离设施。

## 并行文件保护与 Git

- 初次提交补丁时 runtime.ts 版本校验阻止了过期写入。
- 重新读取后确认另一对话新增了 desktopAttached、SettingChangedEvent、ProjectsChangedEvent 及联合成员；保留这些变化，只在独立位置加入本任务的类型导入和 moduleCall。
- 此后仅在任务 01 允许的文件中落地代码/测试/文档；测试生成物使用各套件自己的临时目录。
- **未提交、未推送、未 git add，未运行 reset/checkout/stash 或全库格式化。**
- 工作树里其他任务的源码、测试、国际化和报告均未覆盖或清理。
