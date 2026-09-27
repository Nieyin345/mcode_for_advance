# UI 模块平台第二阶段：能力目录与工作流调用

第二阶段在原有文件菜单、JSON 清单和 `ModuleHost` 之上，增加**原生能力目录与只读内置能力调用节点**。不是任意代码平台，也没有把所有内置功能迁移成模块。

- 公共接口冻结：**P2-01 / 1.0.0**；清单 `apiVersion` 仍为 **1**。
- 生产接线已实现，runnable 已激活；最终候选、回归结果和未验收范围统一记录在 [集成报告](parallel-ui-modules/integration.md)。
- 验证结果（2026-09-27 候选 B，HEAD `e1d06d0`）：动态全量 139 套全部通过，contracts/desktop 类型检查 0 错误，组合 E2E 与安全套件通过。**已验收范围**为自动化与隔离 Electron 功能窗口；正式安装包完整启动/升级、用户主应用全部面板组合、真实 FileTree/WebContentsView 遮挡与真实模型**未验收**。
- 总体规划：[设计方案](ui-module-platform-design.md)；原菜单/清单说明：[第一阶段](ui-module-platform.md)。

## 1. 查看能力

打开已登记的本地项目，在文件面板标题栏点击「UI 扩展」。能力目录显示宿主返回的名称、用途、版本、只读权限、输入/输出结构、限制和可取消性。

- 目录来自实际注册的宿主，不靠前端硬编码 ID 列表。
- 缺少 metadata 的旧能力仍可显示，标明描述信息未提供；不会补造权限或限制。
- schema 以有界文本/字段展示，不下载 `$ref`、不展开无限递归、不执行表达式。它是发现文档，**不是授权或可执行代码**。
- 加载失败会显示错误及重试入口，不把错误伪装成空目录。

| 能力 | 工作流目标 | 输出 | 实际限制 |
|---|---|---|---|
| `core.file.inspect`（task） | `core.file-report / inspect` | `bytes`、`sha256` | 普通文件 ≤32 MiB；任务超时 30 秒；可取消 |
| `core.file.info`（query） | `core.file-report / info` | `bytes`、`modifiedAt` | 普通文件；只查询文件信息，不读取内容；没有宣称 task 的大小、超时或取消保证 |

`modifiedAt` 为 Unix epoch 起的毫秒数。宿主最多同时运行 4 个 task，最多保留 64 条任务；任务保留是内存机制，不是跨重启任务服务。

## 2. 配置工作流节点

1. 在设置中打开「工作流」或「自动化」，打开相应流程图。
2. 点击「添加节点」，选择「模块能力调用」（`mcode.module-capability`）。
3. 在检查器的能力选择框中选择一个宿主提供的内置目标，例如「内置文件检查 · 检查文件（大小 / SHA-256）」。
4. 填写文件路径：可以是本次运行工作区内的相对路径，也可以是该工作区内的绝对路径。模板沿用既有工作流变量规则，例如手动触发时 `{{trigger.kind}}.txt` 对应 `manual.txt`。
5. 配好上游依赖并保存。普通工作流沿用其既有主节点规则；纯文件读取示例适合放在有手动触发器的「自动化」中。

节点只保存三个参数：

```json
{
  "moduleId": "core.file-report",
  "contributionId": "inspect",
  "path": "module-inspect-demo.txt"
}
```

不要添加 `projectPath`、`requestId`、`capabilityId`、`trusted`、`source` 或脚本。保存、导入和运行预检都会拒绝非法参数；资源范围和请求身份由宿主决定。

选择框为空表示没有可用 `workflowTargets`，不是可以手填任意 ID 执行。既有选择从目录消失时会显示失效状态，不会偷偷换成另一项。节点上的模板保留为模板，到运行时由既有变量构造器解析；缺失变量会失败，不会执行 JavaScript。

## 3. 运行仓库示例

示例文件：`examples/workflows/module-file-inspect.json`。

1. 在你选择的工作区内自行创建 `module-inspect-demo.txt`。示例**不会创建或修改文件**。
2. 将示例导入「自动化」。它包含手动触发器和文件检查节点，触发器默认 `enabled: false`，项目为空。
3. 为触发器选择已登记的项目，核对文件路径并保存。
4. 按现有工作流审查界面核对并批准**当前已保存版本**。导入文件不能自行授予审批；再次修改执行内容会令原审批失效。
5. 点击「立刻运行一次」。该按钮是一次明确的手动试跑，不要求打开自动触发开关；也不会用未保存草稿代替已保存版本。
6. 查看运行历史、节点结果卡及 `bytes` / `sha256`。下游节点可以用既有变量语法引用这些产出；文件信息节点另有 `modifiedAt`。

升级后，正在运行的旧开发主进程/preload 不会自动获得新接线。是否关闭并重新启动你的日常应用由你决定；自动测试不会替你重启它。

## 4. 菜单与工作流的共同边界

```text
文件菜单 → 原七条 modules RPC → 同一个懒加载 ModuleHost → 文件能力
工作流 → 原变量构造器 → scheduler → 共同 ExecutionEngine 工厂
       → ModuleCapabilityExecutor → 同一个 ModuleHost.invokeForWorkflow → 文件能力
```

- 菜单中已确认安装的 `user.*` 清单仍按第一阶段使用。
- 工作流只允许宿主**真实登记的内置模块贡献**，且必须是只读 query/task；`user.*` 自动化调用仍被拒绝。
- `core.` 前缀不是可信证明；工作流没有 `trusted: true` 之类自报授权开关。
- `invokeForWorkflow` 仅供主进程内部使用，没有新增 renderer/preload/mobile RPC。移动端七个模块方法明确不可用，不先发网络请求。
- 工作区来自运行的 `cwd`；后端再检查已登记工作区、真实路径、符号链接/junction 目标、普通文件和后缀条件。绝对路径不能借此逃出工作区。
- 缺模块执行器必须失败，不回退成模型调用；既有 prompt 等 runner 的 fallback 保持原行为。

## 5. 结果、取消、重试与恢复

- query 成功直接产生节点结果；task 返回句柄后有界轮询。失败、超时、取消和丢失句柄都不会伪装成成功。
- 取消传播到对应的宿主任务；句柄晚到也要清理。不会取消其他节点/请求的任务，也不会接受取消后的迟到成功结果。
- 关闭模块结果窗口不等于取消任务。已存在的任务可在本工作区任务历史中重开。
- 同一份已完成输入的传输重试沿用 requestId；轮询不重新 invoke。
- 真正的新分派、循环下一轮、明确重跑或失败后的重新分派生成新宿主 nonce。不能仅按 runId/nodeId 复用旧任务，也不靠成功轮次数为失败尝试编号。
- 工作流配置与工作流运行结果由既有存储保存；**模块宿主的 task 句柄/历史仍仅在内存中**。这两种持久化不能混为一谈。
- 应用重启或任务淘汰后，旧任务查询明确失败，不会自动补发未知结果的旧调用。调度器恢复运行继续受既有审查、版本及 inFlight/replay 规则约束。
- 不承诺跨应用重启 exactly-once，不新增任务持久化或分布式分派服务。

## 6. 验证入口与边界

无需安装新依赖；使用仓库已有 Node、依赖、Electron 和已安装浏览器：

```sh
node apps/desktop/scripts/run-smokes.mjs module-contract-smoke module-catalog-smoke module-executor-smoke module-workflow-smoke module-phase2-security-smoke module-phase2-e2e-smoke
node apps/desktop/scripts/module-phase2-e2e-smoke/verify-native-mutations.mjs
node apps/desktop/scripts/run-smokes.mjs --all
```

完整 E2E 入口组合并核对新鲜回执：保留原独立安全片段；复用生产 scheduler/变量/身份测试；运行目录 UI 的错误、无目标和失效状态测试；用真实 Electron 窗口、实际 preload/IPC、真实 sql.js 和文件能力验证配置保存、另起进程重开、审批、UI 发起调度和结果。

原生检查使用唯一的 home/userData/sessionData/数据根，禁止页面网络和真实模型调用。agent/provider 与主应用窗口启动桥是显式测试端口；UI 取消使用一个单独标注的宿主计时 fixture，以稳定复现取消窗口。实际文件 query、SHA-256、工作流执行、持久化和资源授权不是假成功。

**尚未验收：** 正式安装包的完整启动/升级、主应用全部面板组合、实际 FileTree/FilesPanel 与原生 WebContentsView 的遮挡场景、真实模型和真实手机。隔离功能窗口不等于这些场景全部通过。精确快照、套件数、退出码和截图位置见集成报告。

## 7. 仍未开放

自由 React/HTML/DOM 注入、外部 Python/Node 模块、任意 npm/pip 安装、写入/action、通用应用 CRUD、用户模块自动化授权、详情常驻标签、任务跨重启恢复，以及移动端模块执行均不在本阶段。
