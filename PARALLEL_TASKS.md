# UI 模块平台第二阶段：并行任务分工

- 计划编号：**UI-MODULES-P2**
- 编写日期：2026-09-27
- 核对基线：`4e25a77`（第一阶段已提交；编写本计划时工作区干净）
- 本文件在项目中的固定位置：**`mcode/PARALLEL_TASKS.md`**
- 总体设计：`docs/ui-module-platform-design.md`
- 第一阶段说明：`docs/ui-module-platform.md`
- **本文件是任务分配方案，不表示第二阶段已经实现。所有任务初始均为未开始。**

## 给用户：怎样分配给其他对话

复制下面任意一句即可，不需要把整份设计再讲一遍：

```text
阅读 mcode/PARALLEL_TASKS.md，执行 UI-MODULES-P2 第 01 号任务，只修改该任务拥有的文件，并按要求写交接报告。不要自动提交或推送。
```

将 `01` 换成 `02`～`07` 即可。若对话的工作区根目录已经是 mcode，就让它读取根目录下的 `PARALLEL_TASKS.md`。

如果该对话已经读过本计划，后面可以直接说：**“继续第 03 号任务。”** 编号在本轮固定，不随进度重新排序。

### 推荐分配

| 编号 | 任务 | 对话主要能力 | 何时可以开始 |
|---|---|---|---|
| **01** | 冻结能力目录与工作流调用契约 | TypeScript / schema / 兼容性 | 立即，优先完成 |
| **02** | 后端能力目录与只读工作流入口 | Node / 后端 / 权限 | 立即准备；01 冻结后接正式接口 |
| **03** | 能力调用执行器 | 工作流运行时 / 取消与幂等 | 立即准备；01 冻结后接正式接口 |
| **04** | 原生能力浏览器与节点配置 UI | React / UI / 国际化 | 立即做组件和测试；01 冻结后接正式接口 |
| **05** | 生产接线与内置工作流节点 | Electron IPC / 调度器 / 集成 | 立即审查接线点；01、02、03 就绪后正式接线 |
| **06** | 独立安全与端到端回归 | 测试 / 安全边界 | 立即设计断言；相关实现就绪后执行 |
| **07** | 集成协调、最终验收与交付 | 全局审查 / 回归 / 文档 | 可立即协调；01～06 完成后收尾 |

**不要让两个对话同时承接同一个编号。** 02、03、04、06 可以并行准备，但不能各自发明一套不兼容的契约；本轮有接口冻结和最终集成两道必要的串行关口。

---

## A. 本轮共同目标与范围

### A.1 唯一主目标

完成：**可发现的能力目录 + 既有工作流引擎的受控能力调用节点**。

最终应能验证：

1. 原来的文件右键检查继续正常工作。
2. 用户在原生「UI 扩展」窗口查看能力用途、权限、输入输出结构和资源限制。
3. 工作流增加一个「模块能力调用」节点，选择内置文件能力及工作区内的文件。
4. 菜单与工作流都经过同一个 `ModuleHost` 和同一份文件能力实现。
5. 工作流节点正确输出结果，取消、超时、失败、越界和重试都不绕过宿主规则。

### A.2 明确不做

本轮不开放自由 React/HTML 页面、DOM 注入、任意 npm/pip 安装、外部 Python/Node 模块执行、写入/action 能力、通用应用数据库、任务跨应用重启恢复、移动端模块执行。

不改造现有 code/command 节点，不重写调度器，不新增第二套能力宿主，不新增“万能 RPC”。专业外部库仍是后续阶段目标，本轮不能用一个不受控 shell 执行器冒充已完成外部库平台。

### A.3 特别重要：自动化权限不能偷换

第一阶段用户导入模块的授权文案是“处理我主动选择的文件”。这不等于同意无人值守自动化运行。

因此第二阶段先限定：

- **工作流只允许调用宿主实际注册的内置模块贡献，且能力必须是只读 query/task。**
- `user.*` 导入模块继续可以从原来的文件菜单调用，但默认不能从工作流调用。
- 不能仅靠 ID 以 `core.` 开头判定可信；要检查宿主真实的内置模块登记。
- 不增加 `trusted: true`、`source: workflow` 等由调用者自行声明的授权参数。
- 不把新增的宿主内部工作流调用入口暴露为 renderer/mobile RPC。
- 保持现有工作流保存、审批与启用规则；导入一个工作流不应自动启用执行。

用户模块的自动化授权需要另外设计持久授权、撤销和更新确认，本轮不偷偷放开。

---

## B. 所有对话必须遵守的协作规则

### B.1 开始前

1. 阅读项目 `AGENTS.md`、`CLAUDE.md`（若存在）及 `docs/testing.md`；本计划不能覆盖项目规则。
2. 记录当前 HEAD、`git status --short`，核对实际代码，不能假定其他对话尚未做任何修改。
3. 阅读本文对应任务、共同接口约定和已有任务报告；工具若分页返回，继续读完所需部分，不能只看前一页。
4. 创建自己的报告 `docs/parallel-ui-modules/task-XX.md`，写明 `IN_PROGRESS`、承接对话标识、开始 HEAD、文件范围及依赖状态。
5. 如果该编号已经有人承接，停止重复实施，先协调，不抢占报告。

### B.2 文件边界

- **文件所有权是硬边界。** 默认只有表中所有者可以写该文件，包括格式化、补类型、补翻译、修测试。
- 可以读其他任务的代码，但不能顺手修改；需要改动时在自己的报告中列 `跨任务请求`，交给所有者处理。
- 不运行全库格式化、`git add .`、全工作区提交、reset/checkout/stash 清理。
- 不覆盖、删除或回滚其他对话的成果；Git 工作区中“不是我写的”不代表可以清理。
- 本计划没有自动 commit/push 授权。需要提交时由用户另行指示，由 07 协调 own-only 提交。
- 一次任务不因为发现别处问题就自行扩大成“全项目修复”。

### B.3 接口冻结与依赖等待

- 01 独占维护 `docs/parallel-ui-modules/interface-v2.md`，写入最终类型、导出符号、字段语义、示例与错误/取消映射，声明 `FROZEN` 后供其他任务接入。
- 冻结前，其他任务可以写测试设计、局部组件及测试适配器，但不能把临时约定散落进生产代码。
- 不复制一份 contracts 类型来绕过尚未完成的依赖；测试替身须在测试目录，并且在集成时连接真实实现。
- 01 如需改变本文已约定的名字或语义，应先列出影响并由 07 协调相关任务。冻结后不得单方面破坏性改接口。
- 依赖未完成时报告 `BLOCKED` 或 `READY_FOR_INTEGRATION`，不能写“通过”冒充端到端完成。

### B.4 测试与运行安全

- 按项目规则先补测试，取得真正触及目标行为的红灯，再实现并取得绿灯。
- 不将缺依赖、脚本语法错误或测试根本没加载记成有效红灯。
- 不安装新依赖；先使用仓库已有依赖。确需新增时列理由、替代方案、许可证/安全影响并等待批准。
- 不调用真实模型、不操作真实用户数据库和真实数据根。文件测试仅用临时目录；数据库相关验收只用副本或隔离 fixture。
- 浏览器使用独立 profile，只结束自己创建的进程。
- 各任务先跑自己的定向套件。全量由 07 统一跑，避免多个对话重复争抢进程、端口与机器资源。
- 新 smoke 套件带 `run.sh`，可以由现有 `run-smokes.mjs --all` 发现，不重写测试调度器。
- renderer 新增读取使用 `useRpc`，mutation 显式等待；zh/en 同步更新；错误必须在当前对话框/面板可见。

---

## C. 共同接口约定（01 必须落实的设计基准）

这里定义预期接口，不代表这些接口已经存在。01 冻结稿负责补齐严格 schema、类型细节和现有类型的适配。

### C.1 保持第一阶段兼容

- 保留清单 `apiVersion: 1`、现有 `modules.*` 七条 RPC 和原有文件菜单调用。
- 保留 `ModuleInvoke` 的 `moduleId / contributionId / resource / requestId` 语义。
- 保留 task/query 两种返回结构和现有任务状态，不另造一套异步状态机。
- 增强 `modules.catalog` 的响应，不为目录再新开第二套 RPC。
- 旧清单、旧能力目录 fixture 和现有 33 项后端、8 项浏览器专项不能因展示元数据缺失而失效。

### C.2 能力目录形状

建议新增 `packages/contracts/src/moduleCapability.ts`，将目录元数据与 v1 清单分开。

```ts
// 示意结构；01 负责最终严格 schema 和类型导出。
interface ModuleCapabilityDescriptor {
  id: string;
  kind: "query" | "action" | "task"; // action 仍不开放调用
  metadata?: {
    schemaVersion: 1;
    version: string;
    title: LocalizedText;
    description: LocalizedText;
    permissions: Array<"resource.read">;
    inputSchema: JsonSchemaDocument;
    outputSchema: JsonSchemaDocument;
    supportsCancellation: boolean;
    limits?: {
      maxFileBytes?: number;
      taskTimeoutMs?: number;
    };
  };
}

interface ModuleWorkflowTarget {
  moduleId: string;
  contributionId: string;
  capabilityId: string;
}

// 在原 ModuleCatalog 上兼容增加：
// capabilities: ModuleCapabilityDescriptor[];
// workflowTargets?: ModuleWorkflowTarget[];
```

约束：

- `metadata` 可选，用于兼容旧目录；生产的两个内置文件能力必须提供真实元数据。
- `workflowTargets` 由宿主根据真实内置登记和只读能力生成，不从用户清单接受该字段。不提供该字段的旧目录按“暂无可选工作流目标”处理。
- 展示缺失元数据时给出明确的未知/不可用状态，不能捏造权限或限制。
- JSON Schema 仅用于发现与展示。实际调用仍经过运行时 Zod 校验和真实资源授权。
- schema 必须可安全序列化、限制大小/深度；不允许网络 `$ref`、执行表达式或函数。
- 可以使用仓库已有 `zod-to-json-schema`；不得因生成 schema 而引入任意执行机制。
- 32 MiB 上限属于文件检查，不应错误宣传为所有 query 的统一上限；现有 30 秒任务超时也不是 query 已有超时保证。

### C.3 宿主内部工作流入口

02 增加：

```ts
ModuleHost.invokeForWorkflow(input: ModuleInvoke): Promise<ModuleReply>
```

该入口必须先验证真实内置模块登记、贡献可用性和 query/task 类别，再复用正常 `invoke` 路径，不能直接调用 capability.run。

其他方法仍使用 `task`、`cancel` 等现有宿主接口。`getModuleHost()` 保持懒加载，不因导入一个测试文件就打开真实数据根。

内置演示约定：

- 沿用 `core.file-report` 模块和现有 `inspect` 贡献。
- 02 可为该内置模块增加 `info` 贡献，对应 `core.file.info`。
- 不向工作流展示用户导入模块作为可执行目标。

### C.4 工作流节点与执行输入

固定名字：

- 新 runner kind：**`module-capability`**。
- 新内置节点类型 ID：**`mcode.module-capability`**。
- 参数：`moduleId`、`contributionId`、`path`。
- 不允许节点参数直接传入 `projectPath`、`trusted`、`capabilityId` 绕过贡献查找。

01 定义严格的 `ModuleWorkflowCall`（上述三个参数）及 `NodeRunInput.moduleCall`。执行输入可增加宿主产生的 `requestId`，但它不是用户可填写的节点参数。

执行规则：

1. 05 使用现有参数/变量解析机制，从节点参数构建已校验的执行输入；不使用 eval。
2. 03 从可信 `ExecutionContext.cwd` 确定工作区，相对路径相对此目录解析，随后交宿主做真实路径与已登记根校验。
3. requestId 由宿主使用工作流运行、节点及执行尝试身份产生，长度遵守现有 100 字符限制；推荐对身份元组哈希。
4. 同一次执行的传输重试保持相同 requestId；用户明确重跑、循环下一轮或新的执行尝试必须获得不同 requestId。
5. 不能只用 `runId + nodeId`，因为续跑和循环可能复用这些 ID。01 与 05 必须在冻结稿里写明现有运行态中“执行尝试”的真实来源。
6. NodeOutcome 沿用现有 `outputs`、状态与取消语义，不添加本任务私有状态。01 冻结具体映射，03 实现。

---

## 第 01 号任务：能力目录与工作流契约

**目标：** 让其他任务使用同一套可编译、可校验且兼容 v1 的公共接口。

### 文件所有权

可修改：

- 新增 `packages/contracts/src/moduleCapability.ts`。
- `packages/contracts/src/modules.ts`。
- `packages/contracts/src/nodeType.ts`。
- `packages/contracts/src/runtime.ts`。
- 新增 `apps/desktop/scripts/module-contract-smoke/`。
- `docs/parallel-ui-modules/interface-v2.md`。
- 自己的 `docs/parallel-ui-modules/task-01.md`。

其他文件只读。尤其不要修改 `ipc/rpcMap.ts`、preload、主进程模块实现或前端类型映射；需要的消费者调整交给对应任务。

### 工作内容

1. 实现 C 节的目录 schema、工作流参数 schema 及相关类型；未知字段和危险 schema 明确拒绝。
2. 兼容增强 `ModuleCatalog`；不把 v1 外部模块清单扩成任意代码包。
3. 给 NodeRunnerSchema 增加 `module-capability` 执行原语，补 `NodeRunInput.moduleCall`。
4. 检查 nodeType 中 runnable 判断、渲染说明等关联导出；在自己拥有的文件中保持一致。
5. 冻结 query/task 到 NodeOutcome 的结果、错误和取消映射；协调 05 确认执行尝试身份来源。
6. 交付 `interface-v2.md`，包含确切导出名字、字段、示例和兼容行为，明确标记 `FROZEN`。

### 验收

- 旧 v1 清单和旧目录可读，未知执行字段、非法 runner 参数被拒绝。
- 缺失 metadata 的旧 fixture 有确定的兼容行为。
- 新目录 schema 可安全序列化，错误类型、大小/深度超限及不允许的 `$ref` 有测试。
- contracts 类型检查通过；新增联合类型导致的其他任务文件报错逐项列明，不擅自越界修复，也不宣称 desktop 已通过。
- 交接报告列出所有消费者需要改的分支/映射。

**依赖：** 无生产代码依赖；执行尝试语义需与 05 协调。完成后优先通知 02、03、04、05、06。

---

## 第 02 号任务：后端目录与工作流授权入口

**目标：** 宿主提供真实能力元数据，且工作流不能绕过现有资源和模块权限。

### 文件所有权

可修改：

- `apps/desktop/src/main/modules/ModuleHost.ts`。
- `apps/desktop/src/main/modules/fileCapabilities.ts`。
- `apps/desktop/src/main/modules/service.ts`。
- 需要时在 `apps/desktop/src/main/modules/` 新增本任务内部辅助文件。
- `apps/desktop/scripts/module-platform-smoke/`。
- 新增 `apps/desktop/scripts/module-catalog-smoke/`。
- 自己的 `docs/parallel-ui-modules/task-02.md`。

不得修改 contracts、IPC/preload、调度器或 UI。

### 工作内容

1. 注册时保留并校验元数据，catalog 返回脱离内部引用的安全快照。
2. 给 `core.file.inspect` 和 `core.file.info` 提供真实版本、说明、schema、权限和限制；输入/输出校验不因为文档化而放宽。
3. 实现 C.3 的 `invokeForWorkflow`；检查实际内置登记，拒绝用户模块、伪造内置 ID、action、未知或失效贡献。
4. 生成可信 `workflowTargets`；增加内置 `info` 贡献，与 inspect 共用现有调用链。
5. 不改变清单原子保存、损坏配置报错、任务限额、取消和幂等保证。
6. 如发现工作流与 UI 共用宿主后有并发问题，在自己的宿主文件及测试中修复，不建立另一份 job 表。

### 验收

- 正常菜单与内部工作流入口对相同文件使用同一能力实现。
- user.* 菜单仍可运行，但工作流调用被拒绝。
- 未知根、路径穿越、symlink/junction 越界、非普通文件仍被拒绝。
- 查询立即返回，任务返回句柄；元数据与实际行为相符。
- 修改 catalog 返回值不能改宿主内部状态；重复能力不能替换实现。
- 原有 33 项专项继续通过，新增目录/工作流授权专项先红后绿。

**依赖：** 01 的冻结契约。对 03/05 交付真实宿主方法，不要求他们导入用户数据库。

---

## 第 03 号任务：模块能力工作流执行器

**目标：** 把宿主结果映射为现有工作流节点结果，正确处理取消、轮询、失败和执行身份。

### 文件所有权

可新增：

- `apps/desktop/src/main/orchestration/moduleCapabilityExecutor.ts`。
- 必要时 `apps/desktop/src/main/orchestration/moduleCapabilityAdapter.ts`。
- `apps/desktop/scripts/module-executor-smoke/`。
- 自己的 `docs/parallel-ui-modules/task-03.md`。

只读参考：`executorRegistry.ts`、`executionContext.ts`、`codeExecutor.ts`、ModuleHost 与冻结契约。

**不能修改** `runner.ts`、`scheduler.ts`、`executionEngine.ts`、现有 executor 注册表或 contracts；生产接线交给 05。

### 工作内容

1. 实现 `ModuleCapabilityExecutor`，遵守现有 `NodeExecutor`，kind 为 `module-capability`。
2. 通过依赖注入取得宿主；测试可传替身，生产由 05 注入 `getModuleHost`。
3. 只读取经过 05 规范化的 `input.moduleCall`，不重新解析 WorkflowNode.params。
4. 使用 `invokeForWorkflow`；query 直接映射 outputs，task 等待宿主终态并映射进度。核对宿主 0～1 进度与现有 ExecutionProgress.percent 的量纲，显式转换并测试，不能直接照抄数值。
5. 传播 AbortSignal；等待期间可取消，只取消自己的任务。轮询有上限且会清理计时器/监听器。
6. 处理“调用前已取消”和“调用期间取消、句柄稍后返回”的竞态，避免留下无人管理的活动任务。
7. 复用既有 requestId，不在每次轮询或网络重试时重新生成。
8. 应用重启后找不到内存任务时显式失败；不承诺任务恢复，不静默重跑。

### 验收

- query/task 两条路径都有真实宿主测试，不能全靠预制结果。
- 输出键及类型准确，失败/超时不会被标成成功。
- 取消、迟到完成、任务丢失、跨工作区路径和未知贡献均覆盖。
- 新执行尝试可重新执行；相同尝试不会重复启动任务。
- 执行器本身不调用真实模型、不启动 Python/Node 子进程、不拥有第二套资源授权逻辑。

**依赖：** 01；真实集成测试依赖 02。向 05 提交构造参数和注入示例，不自行接注册入口。

---

## 第 04 号任务：能力目录 UI 与工作流节点配置

**目标：** 用户能找到能力、理解其权限，并在现有节点编辑器里配置新的调用节点。

### 文件所有权

可修改/新增：

- `apps/desktop/src/renderer/components/modules/ModuleSurface.tsx`。
- 该目录下新的 `CapabilityCatalogPanel.tsx` 等展示组件。
- 新增 `apps/desktop/src/renderer/components/settings/workflows/ModuleCapabilityFields.tsx`。
- `apps/desktop/src/renderer/components/settings/workflows/NodeInspector.tsx`。
- `apps/desktop/src/renderer/components/settings/workflows/WorkflowNodeCard.tsx`。
- `apps/desktop/src/renderer/lib/i18n/zh/ide.ts` 与 `en/ide.ts`。
- `apps/desktop/src/renderer/lib/i18n/zh/settings.ts` 与 `en/settings.ts`。
- `apps/desktop/scripts/module-ui-smoke/`。
- 新增 `apps/desktop/scripts/module-catalog-ui-smoke/`。
- 自己的 `docs/parallel-ui-modules/task-04.md`。

不得修改 API 传输、主进程、contracts、FileTree/FilesPanel 挂载位置、其他设置页面或全局布局。

### 工作内容

1. 在现有「UI 扩展」管理窗口中加入能力目录，不另开一套管理系统。
2. 展示用途、类别、只读权限、版本、输入输出结构、限制及能否用于当前工作流；schema 按安全文本/字段展示。
3. 无 metadata、无 workflowTargets、加载失败和空目录都有明确状态与重试入口。
4. 为 `module-capability` 节点提供模块贡献选择和文件路径配置。只从宿主 `workflowTargets` 选取，不依据 ID 前缀自行授权。
5. 节点选择保存 moduleId/contributionId/path；不得允许用户填写 projectPath/requestId/trusted。
6. 沿用现有变量插入机制；如果路径是变量表达式，不把它错误当成已解析的本地文件执行。
7. 处理新 runner 的卡片外观/联合类型映射，不破坏旧节点；目录变化后旧选项失效应可见，不静默切换其他能力。
8. 保留原有导入、显式授权、移除、任务历史及结果对话框行为。

### 验收

- 原有 8 项浏览器检查继续通过。
- 新界面覆盖加载、空、失败重试、缺失元数据、非法配置、选择失效及中英文。
- 错误在操作所在窗口可见；键盘与焦点不退化。
- 配置可保存并再次打开；工作流实际执行由 05/06 联调验收，不能仅以 UI 能点击宣称端到端完成。

**依赖：** 01；真实目录依赖 02；新节点出现在生产编辑器依赖 05。前期可以用明确标注的测试 fixture 开发，不放入生产。

---

## 第 05 号任务：生产接线与内置能力节点

**目标：** 把已完成的契约、宿主和执行器接入现有生产链，消除“单元测试通过但实际 UI 不可用”。

### 文件所有权

本任务独占以下共享接线文件：

- `packages/contracts/src/ipc.ts`、`packages/contracts/src/ipc/rpcMap.ts`。
- `packages/contracts/src/ipc/modules.ts`、`packages/contracts/src/moduleClient.ts`（仅确有兼容适配需要时）。
- `apps/desktop/src/main/ipc/modules.ts`、`apps/desktop/src/main/ipc/index.ts`。
- `apps/desktop/src/preload/index.ts`。
- `apps/desktop/src/renderer/lib/webApi.ts`。
- `apps/desktop/src/main/orchestration/executionEngine.ts`、`runner.ts`、`scheduler.ts`、`nodeTypes.ts`。
- `apps/desktop/src/main/workflows/assets.ts`。
- 新增 `apps/desktop/scripts/module-workflow-smoke/`。
- 新增 `examples/workflows/module-file-inspect.json`（必须符合仓库真实工作流格式）。
- 自己的 `docs/parallel-ui-modules/task-05.md`。

这不是要求全部修改；**按最小必要改动接线**。不修改 01 的 schema、02 的业务实现、03 的执行器或 04 的 UI。

### 已核对的关键位置

- `executionEngine.ts` 和 `runner.ts` 都有 `new CodeExecutor()` 注册路径，不能只改其中一个就宣称完成。
- runner kind 是 contracts 的封闭联合；内置节点清单来自既有节点类型机制。
- `modules.catalog` 已存在；尽量原通道增强，不增加重复目录 RPC。
- 自动化输入应从现有参数与变量解析路径构建，执行器不直接理解图结构。

### 工作内容

1. 与 01 明确 NodeRunInput/moduleCall、NodeOutcome 和执行尝试身份的冻结语义。
2. 注册 03 的执行器，补齐相关生产入口；不要在调度器里重新实现能力业务。
3. 注册内置 `mcode.module-capability` 节点类型，参数与 04 配置控件一致。
4. 构建已校验的 moduleCall，从可信运行上下文产生 requestId；保留现有循环、续跑和失败重试语义。
5. 检查目录增强在主进程、IPC、preload、renderer 的真实传输；不向手机端或 renderer 开放 invokeForWorkflow。
6. 提供最小的合法工作流示例；用户明确运行后检查临时文件，并产生可供下游节点读取的 outputs。
7. 保存/导入配置时尽早发现非法参数；执行时仍再次校验宿主实际可用性，不能只依赖 UI 的下拉选项。

### 验收

- 从内置节点目录能找到新节点，保存后重开配置不丢失。
- 经过真实注册/调度/宿主路径得到 bytes、sha256 或 modifiedAt，不通过直接调用 run 来伪装集成。
- 循环下一轮和明确重跑获得新尝试身份；同次尝试的重复调用不重复任务。
- 两个已发现的 executor 注册路径均有覆盖，未知 kind/旧节点行为不退化。
- 既有 IPC wiring/parity 检查通过，移动端仍明确拒绝模块执行。

**依赖：** 01、02、03；最终界面验收还依赖 04。可先阅读与写接线测试，不在依赖不完整时硬接生产入口。

---

## 第 06 号任务：独立安全与端到端回归

**目标：** 独立验证跨任务边界，不替其他任务“自己证明自己正确”。

### 文件所有权

可新增：

- `apps/desktop/scripts/module-phase2-security-smoke/`。
- `apps/desktop/scripts/module-phase2-e2e-smoke/`。
- `docs/parallel-ui-modules/security-findings.md`。
- 自己的 `docs/parallel-ui-modules/task-06.md`。

不得修改生产代码或其他任务测试。问题交给文件所有者修复，06 保留能复现的红灯，再验证修复转绿。

### 必测矩阵

| 类别 | 必测行为 |
|---|---|
| 兼容 | 原菜单、旧清单、旧目录 fixture、已安装模块仍可用 |
| 调用授权 | 用户模块不能通过工作流运行；伪造 core ID/额外 trusted 字段不能提权 |
| 资源 | 未知根、绝对越界、相对穿越、symlink/junction、目录与超限文件 |
| 数据 | 可序列化目录、超大/过深 schema、远程 ref、污染字段、返回值不可修改宿主 |
| 身份 | 同次尝试重试去重；新尝试与循环不误复用旧结果 |
| 生命周期 | 预取消、调用中取消、迟到完成、宿主超时、任务已被淘汰、应用重启后的不可恢复状态 |
| 生产集成 | 真实 registry/参数映射/执行器/宿主/文件能力链，不只测试 fake transport |
| UI | 目录错误可见、无可选目标、失效选择、配置保存、取消与结果显示 |

### 验收

- 对安全关键边界至少取得一个有效红灯，例如仅在临时测试 bundle 中去掉工作流授权后，越权用例必须失败。
- 不在生产文件中临时关闭授权，不访问真实数据来证明漏洞。
- 每个发现写出编号 `P2-SEC-001` 等、复现、影响、归属任务、阻断程度、复验结果。
- 区分自动化 fixture、真实浏览器与 Electron 实机验收；未覆盖的层不能写成通过。
- 只报告实测结论，不把测试工具启动失败算作产品失败，不用重试次数掩盖偶发失败。

**依赖：** 可立即设计；完整执行依赖 01～05。没有需要修复的发现也要明确记录检查范围。

---

## 第 07 号任务：集成协调与最终验收

**目标：** 管理跨任务边界、汇总真实结果，确保可交付，不接管所有人的文件。

### 文件所有权

可修改/新增：

- `docs/parallel-ui-modules/integration.md`。
- `docs/ui-module-platform-phase2.md`。
- `docs/ui-module-platform.md`（完成后更新使用与边界）。
- `docs/ui-module-platform-design.md`（只将确已实现的内容更新为完成）。
- 自己的 `docs/parallel-ui-modules/task-07.md`。

本任务默认**不修改生产源码**。需要修复时退回所属任务；跨文件紧急修复必须先明确暂停原所有者并取得协调确认，不能靠“我是集成任务”覆盖并行编辑。

### 工作内容

1. 汇总各任务状态、接口冻结版本、文件归属、阻塞与安全发现；不要让所有对话编辑同一张进度表。
2. 确认 01 的冻结稿与 02～05 实现一致；对偏离本计划的提议作明确记录，必要时询问用户。
3. 各任务进入 `READY_FOR_INTEGRATION` 后，安排短暂停写窗口或构建冻结候选快照；记录 HEAD、候选树/文件版本。
4. 运行定向套件、全量 smoke、desktop/contracts 类型检查及 git diff --check。
5. 总输出与退出状态落盘，不能只有当前 MCP command ID；连接中断后先恢复日志，不立即重复全量。
6. 在隔离数据环境或用户明确确认的方式下完成 Electron 实机检查；不能擅自重启用户主应用或访问真实数据库。
7. 更新真实使用路径、示例、限制和验证结果；与用户确认是否提交、提交范围和是否推送。

### 最终验收清单

- [ ] 原第一阶段功能不退化。
- [ ] 能力目录和工作流目标来自真实宿主，而非写死的 UI 列表。
- [ ] 菜单与工作流复用同一后端能力。
- [ ] 只读内置能力可运行，用户模块自动化调用被拒绝。
- [ ] 参数、工作区、取消、重试、循环与结果映射语义一致。
- [ ] 01～06 的报告及关键安全发现均已关闭或明确阻断。
- [ ] 新旧相关测试、全量 smoke 和双包类型检查通过。
- [ ] 全量记录注明是否冻结快照；套件数量取实际发现值，不硬编码“106”。
- [ ] 文档与真实界面一致；Electron 未做的部分明确写“未验收”。
- [ ] 没有引入真实模型调用、真实数据修改、任意依赖安装或未授权外部代码。
- [ ] 未夹带其他任务或其他对话的无关变更，未擅自推送。

**依赖：** 最终验收依赖 01～06；协调工作可以提前进行。

---

## D. 文件归属速查与冲突处理

| 区域 | 唯一写入所有者 |
|---|---|
| 能力 schema、modules 类型、nodeType/runtime 契约、接口冻结稿 | **01** |
| ModuleHost / fileCapabilities / service 及原后端 module-platform-smoke | **02** |
| 新模块能力执行器和适配器 | **03** |
| ModuleSurface、能力展示、NodeInspector、WorkflowNodeCard、相关中英词典及原 module-ui-smoke | **04** |
| IPC 门面/RpcMap/preload/webApi/SDK、scheduler/runner/engine、内置节点 assets | **05** |
| 独立 phase2 安全/E2E 套件及安全问题清单 | **06** |
| 最终集成记录与正式用户文档更新 | **07** |
| 每个 task-XX.md | **对应 XX 任务** |
| 本任务分配文件 `PARALLEL_TASKS.md` | 默认只读；调整分工由用户或其指定协调者统一处理 |

未列出的已有文件默认只读。若实现确实需要修改，先在报告中写明原因，由 07 明确分配所有者再动手。

### 发生冲突时

1. 停止写入该文件，读取最新版本并保存自己的差异说明。
2. 在自己的报告中列出冲突的任务、文件、接口和建议，不写入他人的报告。
3. 由对应所有者或 07 协调解决；不把别人的变化覆盖成自己的完整副本。
4. 涉及接口的变化回到 01 更新冻结稿并通知消费者；无法兼容时先阻塞，不偷偷换协议。

---

## E. 每个任务的统一交接格式

各任务只写自己的 `docs/parallel-ui-modules/task-XX.md`。推荐使用以下模板：

```md
# UI-MODULES-P2 / 任务 XX

## 状态
IN_PROGRESS / BLOCKED / READY_FOR_INTEGRATION / VERIFIED
承接对话标识：不填密钥、MCP URL 或其他凭据
开始 HEAD：
当前核对 HEAD：
使用的 interface-v2 冻结版本：

## 已完成
- 用户可见或接口可验证的结果

## 实际改动文件
- 路径及用途，区分新增与修改

## 测试证据
- 有效红灯：命令、断言、退出码和日志路径
- 绿灯：命令、结果、退出码和日志路径
- 使用真实实现还是替身；是否用了冻结快照

## 跨任务请求 / 阻塞
- 请求哪个编号处理哪个文件、原因及最小接口变化

## 未实现 / 未验证
- 明确限制，不用“基本完成”掩盖尚未接线

## 给下一任务的接入说明
- 导出、输入输出、构造方式、示例与注意事项

## Git
- 是否提交；如获明确授权才填写提交 ID
- 没有擅自推送、覆盖或清理其他内容
```

状态含义：

- `IN_PROGRESS`：本任务正在实施。
- `BLOCKED`：缺接口、缺依赖或存在必须协调的问题，尚不能完成。
- `READY_FOR_INTEGRATION`：本任务定向验证通过，但不代表整个功能端到端通过。
- `VERIFIED`：集成验收覆盖本任务后，由本任务根据 07 的记录更新。

---

## F. 推荐推进顺序

```text
01：接口冻结 ──────────────┬──────────────┐
                         ↓              ↓
                 02：能力宿主       04：原生 UI
                         ↓              │
                 03：执行器             │
                         └──────┬───────┘
                                ↓
                         05：生产接线
                                ↓
                         06：独立复验
                                ↓
                         07：最终验收
```

上图表达正式接入依赖，不是要求所有工作串行：

- 01 开始时，02/03/04/06 可以同步读代码、写断言和准备各自独立部分。
- 01 冻结后，02/03/04 可并行实现；03 用明确测试适配器开发，随后接 02 真宿主。
- 05 可以提前核对接线点和执行尝试语义，02/03 就绪后接入生产；与 04 联调配置。
- 06 持续复验已就绪部分，最后覆盖端到端；07 全程协调，最后跑一次受控全量。

**本计划优先保证同一套契约、清晰的文件所有权和可验证的集成结果，不以“同时开了多少个对话”代替实际完成度。**
