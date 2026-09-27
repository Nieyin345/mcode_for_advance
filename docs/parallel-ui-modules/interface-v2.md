# UI-MODULES-P2：第 01 号任务接口冻结稿

- 状态：**FROZEN（类型、schema 与调用语义）；生产 runnable 已按 01/05 的验证结果激活，最终验收见 07。**
- 冻结版本：**P2-01 / 1.0.0**，2026-09-27。
- 基线：`4e25a77`；共享工作区可能有其他对话的并行修改。
- 所有者：任务 01。其他任务不得自行改写本文件或复制另一份 contracts。
- 文件名中的 v2 表示“平台第二阶段”，**不是清单 apiVersion 升级**。清单 apiVersion 仍为 1，新增 metadata.schemaVersion 为 1。

## 0. 先看接入边界

本稿冻结的是契约，不表示能力宿主、工作流执行器、UI 或生产接线已经完成。

**启动门禁历史与当前状态（2026-09-27 收尾）：** 冻结初期仅识别 `module-capability`，没有加入 `IMPLEMENTED_RUNNER_KINDS`，以防未注册 kind 落入模型 fallback。用户移交 01/07 后，01 核对了 05 的双生产注册、宿主身份绑定和缺执行器 fail-closed 证据，再在自己拥有的 `nodeType.ts` 中加入该 kind；现在 `isRunnerImplemented` / `isNodeRunnable` 返回 true。

`executionEngine.ts` 的共同生产工厂供默认引擎与真实 runner 使用。缺少模块执行器必须失败，保留其他既有 prompt fallback。未改 02/03/04 文件，没有把测试的 fixture-open 当作生产激活。**P2-01-REQ-02 已响应**；该状态变化不修改冻结字段，也不等于 07 的全量/Electron 验收已经完成。

共享 `validateNodeParams` 对该 runner 先使用冻结的 `ModuleWorkflowCallSchema.safeParse`，再执行既有参数规则。保存、导入与运行预检因此拒绝额外字段、NUL、超长或错误类型的调用参数；其他 runner 继续原规则。模板文本在这里保留，路径授权仍在执行时由宿主完成。契约专项现有 106 个断言；红/绿证据见 task-01.md。

## 1. 公共导出

### `@contracts/moduleCapability`

| 导出 | 说明 |
|---|---|
| `ModuleJsonValue` | 严格 JSON 数据类型，不含函数、undefined、非有限数 |
| `JsonSchemaDocument` / `JsonSchemaDocumentSchema` | 有限、可序列化的展示型 schema 文档；根必须是对象 |
| `ModuleCapabilityMetadata` / `ModuleCapabilityMetadataSchema` | 版本、说明、权限、schema 与限制 |
| `ModuleCapabilityDescriptor` / `ModuleCapabilityDescriptorSchema` | 兼容原 `{id,kind}` 的目录元素 |
| `ModuleWorkflowTarget` / `ModuleWorkflowTargetSchema` | 可选工作流目标的三个标识字段 |
| `ModuleCatalogSchema` | 完整目录的结构与引用一致性验证 |
| `ModuleWorkflowCall` / `ModuleWorkflowCallSchema` | 用户可编辑/变量解析后的三个节点参数 |
| `ModuleWorkflowExecutionInput` / `ModuleWorkflowExecutionInputSchema` | 增加宿主 requestId 的执行输入 |
| `ModuleCapabilityRunnerSchema` | 严格 `{kind:"module-capability"}` |
| `MODULE_CAPABILITY_RUNNER_KIND` | 字面量 `module-capability` |
| `MODULE_CAPABILITY_NODE_TYPE_ID` | 字面量 `mcode.module-capability` |
| `MODULE_SCHEMA_MAX_BYTES` | 32768，每个输入或输出 schema 的 UTF-8 JSON 字节上限 |
| `MODULE_SCHEMA_MAX_DEPTH` | 12，根深度为 0，包含数组和映射容器的实际结构深度 |
| `MODULE_SCHEMA_MAX_NODES` | 2048，每份 schema 的值节点预算 |
| `MODULE_SCHEMA_MAX_ENTRIES` | 128，每个对象属性数、数组长度上限 |

### 其他既有文件

- `@contracts/modules` 继续导出 `ModuleCatalog`；其 capabilities 元素改为 `ModuleCapabilityDescriptor`，并增加可选 `workflowTargets`。
- `@contracts/nodeType` 的 `NodeRunnerSchema` / `NodeRunner` / `NodeRunnerKind` 识别新 kind，生产 runnable 已在双入口/fail-closed 验证后激活。
- `@contracts/runtime` 的 `NodeRunInput` 增加可选 `moduleCall?: ModuleWorkflowExecutionInput`。
- 原 ModuleInvoke、ModuleReply、ModuleTask、v1 清单及七条 RPC 不改名、不新增调用主体字段。
- 新模块仅依赖 Zod 和其他契约，不导入 Electron、文件系统、crypto、用户数据库或主进程服务。

## 2. 目录与元数据

```ts
interface ModuleCapabilityDescriptor {
  id: string;
  kind: "query" | "action" | "task";
  metadata?: ModuleCapabilityMetadata;
}

interface ModuleCapabilityMetadata {
  schemaVersion: 1;
  version: string; // 与 v1 一致的三段数字版本；不是完整 semver 引擎
  title: { zh: string; en: string }; // 各 1～120 字符
  description: { zh: string; en: string }; // 各 1～2000 字符
  permissions: Array<"resource.read">; // 最多一项，不允许重复
  inputSchema: JsonSchemaDocument;
  outputSchema: JsonSchemaDocument;
  supportsCancellation: boolean;
  limits?: {
    maxFileBytes?: number; // 安全整数，非负
    taskTimeoutMs?: number; // 安全整数，正数
  };
}

interface ModuleWorkflowTarget {
  moduleId: string;
  contributionId: string;
  capabilityId: string;
}
```

所有上述对象 schema 都拒绝未知字段。metadata 的 missing 不会被补成一份默认权限/版本/限制；旧目录不会被自动补出 workflowTargets。

`ModuleCatalogSchema` 接受最多 32 个模块、128 个能力、384 个工作流目标，拒绝重复模块 ID、能力 ID、重复 moduleId/contributionId 目标。目标必须对应目录中真实存在且指向同一 capability 的贡献，能力不能是 action，模块标识必须属于 core 命名空间。

**这些只是返回值一致性检查，不是授权。** 宿主还必须验证真实的 builtin 登记；一个 core 前缀不能证明其身份。独立 `ModuleWorkflowTargetSchema` 只验证三字段形状，不能单独用它决定是否允许执行。

任务 02 应给两个生产内置文件能力提供完整且真实的 metadata。不要将文件检查的 32 MiB 限制写到没有这个限制的查询上；不要将 task 的超时保障宣传成 query 也已经具备。

## 3. JSON Schema 的受支持子集

这是**展示与发现文档**，不是 JSON Schema 校验引擎，更不是代码沙箱。运行时输入输出依然由能力自己的 Zod schema 校验，文件授权仍由宿主实现。

支持：

- `$schema`：仅 draft-07 的 http/https 标准 URI；只作为标识，绝不下载。
- `type`：object/array/string/number/integer/boolean/null，或其非空无重复数组。
- `title`、`description`、`format`、`pattern`：字符串，仅描述，不编译/执行。
- `minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`：有限数。
- `multipleOf`：有限正数。
- `minLength/maxLength`、`minItems/maxItems`、`minProperties/maxProperties`：非负安全整数。
- `required`：无重复字符串数组。
- `uniqueItems/readOnly/writeOnly/deprecated`：布尔值。
- `properties/patternProperties/definitions/$defs`：子 schema 映射。
- `additionalProperties/additionalItems/propertyNames/contains/not/if/then/else`：子 schema；允许布尔 schema。
- `items`：子 schema 或 tuple 数组；`allOf/anyOf/oneOf`：非空 schema 数组。
- `enum`：非空 JSON 值数组；`examples`：JSON 值数组；`default/const`：JSON 值。
- `$ref`：只允许 `#` 或指向本文档内 schema 节点的 JSON Pointer，支持 `~0/~1` 转义。仅校验引用位置，不递归解引用。

明确拒绝：

- 未知关键字（包括 script/execute）、`$id`、`$dynamicRef`、外部/文件/相对文档引用、命名锚点、URI 百分号编码片段、悬空指针或指向 default/examples 字面数据的指针。
- 环状 JS 对象、函数、undefined、BigInt、Symbol、NaN/Infinity、日期/类实例、稀疏/带额外属性数组、访问器、不可枚举数据属性、symbol 键。
- 任意位置的 `__proto__`、`constructor`、`prototype` 数据键。
- 字节数、结构深度、节点数、容器元素数越界。

schema 解析返回独立数据副本，不能通过修改结果来修改注册输入。语法上可接受本地递归 `$ref`，但 UI **不得无界展开引用**。建议先安全显示 JSON/字段，不能引入网络解析器或 eval。

限制是对 JSON/纯数据契约的校验；不得据此声称可以安全执行任意第三方 JS 对象或代码。此子集也不声称完成完整 JSON Schema 元语义验证（例如所有约束之间的可满足性）。

已用仓库现有 `zod-to-json-schema` 对真实 ResourceSchema 及标量结果结构生成物验证，无新增依赖。

## 4. 用户参数与宿主执行输入必须分开

```ts
const params = ModuleWorkflowCallSchema.parse({
  moduleId: "core.file-report",
  contributionId: "inspect",
  path: "README.md",
});

const execution = ModuleWorkflowExecutionInputSchema.parse({
  ...params,
  requestId: hostGeneratedRequestId,
});
```

- 参数只能有 moduleId、contributionId、path。
- 执行输入必须额外包含 requestId，1～100 字符，不能全空白或含 NUL。
- 用户参数里加入 requestId、projectPath、capabilityId、trusted、source、script 均失败；执行输入也不允许 projectPath/trusted。
- path 为 1～4096 字符，不能全空白或含 NUL；不 trim 有意义的文件名，不在 schema 中解析路径或求值表达式。
- `{{...}}` 可作为字符串进入参数，05 必须通过已有变量解析机制处理，再对解析后的参数严格校验。
- moduleId/contributionId 使用既有 ModuleInvoke 的标识规则。`user.*` 可以通过语法校验，**不意味着允许工作流执行**；真实拒绝由 02 的宿主入口负责。
- `resource.projectPath` 由 03 从可信 ExecutionContext.cwd 取得；绝对/相对路径仍须经过宿主 realpath、已登记工作区和普通文件校验。

## 5. 执行尝试身份：真实来源与 05 接线请求

### 已核对的现状（不是假设）

1. `WorkflowExecutionMetadata` 只有 sessionId/runId/nodeId，没有通用 execution-attempt ID。
2. `scheduler.ts` 的 executeOne 调用 `buildNodeInput(...)`，随后进入 `ports.execute(node, manifest, input)`；这是一次实际执行分派边界。
3. `RunState.rounds` 只在成功结果的 appendStep 中递增；失败结果不会增加该值。因此它不是通用执行尝试计数，更不是现成的“执行开始即分配”身份。
4. `runner.ts` 的 choiceAttempts 只表示分支被询问的次数，不能拿来标识普通能力执行。
5. 续跑沿用 runId；同一节点循环时也沿用 nodeId。只拼 runId/nodeId 会复用旧任务。
6. node.started 的 inFlight 持久化屏障已有，不能被新执行器绕过。

### 冻结的身份语义

- 每一次**实际的新分派**由宿主分配新的 dispatch nonce；该分派使用的 NodeRunInput/moduleCall 保存最终 requestId。
- 推荐最终格式：`"wf:" + sha256(JSON.stringify([sessionId, runId, nodeId, dispatchNonce]))`，长度 67。
- 输入构造与 run-scoped 宿主边界必须协调：输入交给执行器前，ModuleWorkflowExecutionInputSchema 必须校验通过，不能先传一个缺 requestId 的对象给执行器再“以后补”。
- 如果输入 builder 早于 run-scoped 调用点，05 应提供绑定本次运行身份的宿主工厂/上下文，不读取用户参数里的身份，不用类型断言伪造已经完整的执行输入。
- 同一次调用的 transport 重试沿用已经生成的 requestId；轮询不重新 invoke、不生成新 ID。
- 用户明确重跑、循环下一轮、新一次运行分配新 nonce。不得只在每个 nodeId 上永久缓存一个 requestId。
- 应用重启或任务被淘汰后找不到旧任务，返回失败。不要为“恢复”自动生成新 ID 重做未知结果的旧调用；明确重跑才属于新尝试。
- 不承诺跨应用重启 exactly-once。此契约没有新增持久化任务或分派表。

### P2-01-REQ-01（给 05 / 07）

初次冻结时尚无 05 报告；现已核对其正式回应，**P2-01-REQ-01 已响应**。实际实现位于 `executionEngine.ts` 的 `createWorkflowInputBuilder({sessionId,runId})`：复用既有输入 registry/变量构造，每次分派生成宿主 nonce，再采用上文 67 字符 SHA-256 格式。已构造输入的重复 transport 调用沿用身份；循环、新运行、失败后的重新分派换新身份。既有 inFlight 屏障保留。定向测试覆盖同次重试、显式重跑、循环和失败续跑；最终快照证据见 07。

另外发现真实输入构造扩展点在 `main/orchestration/nodeInputBuilders.ts`（导出 NodeInputBuilderRegistry / nodeInputBuilderRegistry）；该文件没有被原任务表分配写入所有权。如果接线必须修改其作用域接口或内置注册，由 07 先明确分配给 05。01 不越权修改，也不建议在调度器里复制一套输入构造逻辑。可复用现有可注册扩展点的方案优先。

已复核任务 03 报告的身份缺陷，同意不能使用 rounds/choiceAttempts。03 提出的持久 dispatchSeq 是一种更重的替代方案；本轮采用每次新派发的宿主 nonce，避免扩展 RunSnapshot/任务持久化范围。若 05/07 要改用持久序号，应先协调存储所有权与恢复语义，不得悄悄扩大本阶段范围。

接口字段与身份语义继续冻结；分派工厂归 05，契约校验与 runnable 激活归 01。两条落地请求现已响应，不扩大任务持久化或跨重启 exactly-once 承诺。

## 6. 宿主调用、结果、错误与取消映射

02 提供宿主内部方法：`invokeForWorkflow(input: ModuleInvoke): Promise<ModuleReply>`。

必须检查实际 builtin 登记及只读 query/task，再进入原 invoke。不能直接运行 capability.run；不能通过 IPC/preload/mobile 暴露该方法。task/cancel 沿用原宿主方法。

03 的 NodeOutcome 映射：

| 宿主/执行状态 | NodeOutcome |
|---|---|
| query 返回 result | success，outputs 为完整 ModuleResult |
| task running | 尚未定案，继续有界等待；不返回 success |
| task completed 且有有效 result | success，outputs 为完整 result |
| task failed，包括宿主超时 | failed，error 保留原因，summary 为空；不伪装成 cancelled |
| task cancelled | cancelled，不发布成功 outputs |
| 调用/轮询失败、任务已丢失、completed 却没有有效结果 | failed，明确原因，不自动重做 invoke |
| 调用前 signal 已取消 | cancelled，不启动宿主调用 |

成功的 summary 可使用 `JSON.stringify(result).slice(0, 2000)`；outputs 不因摘要截断而截断。不得虚构 artifacts；execution 计时仍由现有 ExecutionEngine 填写。

取消规则：

- 等待时观察到 signal 取消，尝试取消且只取消自己持有的任务，节点返回 cancelled；不要把取消异常隐藏成成功。
- invoke 尚未返回时发生取消，必须在句柄迟到返回后清理该任务，避免遗留无人管理的执行。
- 返回成功之前已经观察到取消时，不再发布成功 outputs。宿主已经完成的任务不能“撤回”，不得宣称取消能够回滚副作用。
- 清理计时器、AbortSignal listener 和待处理 promise，防止未处理 rejection。
- 宿主任务 progress 是 0～1，ExecutionProgress.percent 是 0～100；仅接受有限数并限幅转换，不发送 NaN/Infinity。

此表不新增 running/completed 等工作流终态。沿用现有 success/failed/cancelled；skipped/unselected 的图传播职责仍属于调度器。

## 7. 各任务接入清单

- **02**：能力注册 metadata、catalog/可信 workflowTargets、invokeForWorkflow、内置 info 贡献；用自己的真实 builtin 集合做授权。
- **03**：读取完整 input.moduleCall；使用冻结结果映射、取消语义、requestId；不读原始 WorkflowNode.params，不生成第二套 job。
- **04**：读取可选 metadata/workflowTargets，缺失时明确不可用；处理新 NodeRunnerKind 的穷尽映射。目录一致性不等于 UI 具有授权权力。
- **05**：回复 REQ-01；注册 executionEngine.ts 与 runner.ts 的两条生产路径；补输入构造与缺执行器拒绝路径；提交 REQ-02 激活证据，不擅自改 01 文件。
- **06**：验证 schema 边界与实际宿主授权是两层；测跨尝试、循环及取消竞态；不得把类型可解析当成执行已接好。
- **07**：协调未分配的 nodeInputBuilders.ts 所有权与 runnable 激活；激活后再做冻结候选全量验收。

## 8. 契约验证入口

```sh
node apps/desktop/scripts/module-contract-smoke/build.mjs
node apps/desktop/scripts/module-contract-smoke/build.mjs --baseline
node apps/desktop/node_modules/typescript/bin/tsc --noEmit -p apps/desktop/scripts/module-contract-smoke/typecheck.json
node packages/contracts/node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json
```

`--mutation-depth` 只在临时测试 bundle 删除深度限制，预期触发断言失败；不修改生产源码。标准 run.sh 不启用 mutation。

具体红绿结果、消费者诊断与日志位置见 `task-01.md`。全量回归归 07，本任务不会拿并行工作区的一次类型检查冒充整阶段验收。
