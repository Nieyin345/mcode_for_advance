# UI-MODULES-P2 / 任务 04：能力目录 UI 与工作流节点配置

## 状态
**READY_FOR_INTEGRATION**：本任务的定向验证已通过。这不代表工作流端到端已经可用。新节点要出现在生产编辑器并能执行，还取决于 05 的接线，以及 01 在 REQ-02 后打开 runnable 门禁。

- 承接对话标识：Arena Agent / UI-MODULES-P2 / P2-04
- 开始 HEAD：`4e25a77fa0b95a97baf2f9423d399e442b98aab4`
- 当前核对 HEAD：`fe62fe3`（期间其他对话提交了 `a561189`、`fe62fe3`，均不涉及本任务文件；本任务改动仍未提交）
- 使用的 interface-v2 冻结版本：**P2-01 / 1.0.0（FROZEN）**

## 已完成
1. **能力目录进入原有「UI 扩展」窗口**，没有另开管理系统。新组件 `CapabilityCatalogPanel` 位于模块列表和清单导入之间。原来窗口内的目录加载提示和错误提示改由该面板统一显示，避免同一个错误出现两次。
2. **每个能力显示的内容**：标题、ID、类别（查询 / 任务 / 写入操作）及说明、版本、描述、权限（`resource.read` 显示为“只读，读取调用时指定的工作区文件”）、是否支持取消、资源限制（`maxFileBytes` 和 `taskTimeoutMs`，只显示实际声明的项）、输入/输出结构、使用该能力的扩展，以及能否用于工作流。
   - JSON Schema 只以文本显示：顶层字段、类型、是否必填、描述，外加可折叠的原始 JSON（最多 6000 字符）。不编译、不求值、不下载。本地 `$ref` 只显示指针文本，不展开。
   - metadata 里的 HTML 标记以纯文本显示（测试证明不会生成 `<img>`，也不会执行 onerror）。
3. **各种状态都有明确提示**：
   - 加载中；
   - 加载失败：在弹窗内显示错误并提供重试，键盘可操作；
   - 空目录；
   - 缺少 metadata：显示“未提供说明元数据”，不编造权限、限制或 schema；
   - 没有 workflowTargets（字段不存在或为空数组）：显示“暂无可用于工作流的目标”。
4. **能否用于工作流完全取自宿主的 `workflowTargets`**。不按 `core.` 前缀判断可信，使用同一能力的用户导入模块也不会被列为工作流目标（有测试覆盖）。
5. **新增 `ModuleCapabilityFields`**（module-capability 节点的配置控件）：
   - 目标下拉只列宿主发布的 `workflowTargets`。选择后只写入 `moduleId` 和 `contributionId`，不写 `capabilityId`。
   - 选中后显示对应能力的 ID 和描述；缺少 metadata 时明确提示。
   - 路径复用检查器现有的 `ParamField` 和「插入变量」机制。路径含 `{{...}}` 时原样保存为模板，并提示“运行时解析后再由宿主校验”，不当作已确定的本地文件。
   - 已保存的选择如果已不在目录中，显示“已失效：moduleId / contributionId”，**保留原值**，不自动换成别的能力。
   - 参数里如果出现 `projectPath`、`requestId`、`capabilityId`、`trusted`、`source`、`script`，给出警告和“移除这些字段”按钮，不会悄悄删除或保留。
   - 用冻结的 `ModuleWorkflowCallSchema` 做形状检查，错误在检查器内显示。
   - 目录加载中、失败重试、没有目标（下拉禁用）都有对应状态。
6. **NodeInspector**：对 `runner.kind === MODULE_CAPABILITY_RUNNER_KIND` 的节点显示上面的控件。通用参数表跳过 `moduleId`、`contributionId`、`path` 三个键，不提供第二个编辑入口；同时不显示“无参数”提示。其他节点的行为没有变化。门禁未打开时，原有的“执行方式未实现”警告照常显示。
7. **WorkflowNodeCard**：给 `KIND_LOOK` 补上 `module-capability`（info 色，拼图图标），解决 01 报告里的 TS2741。门禁打开前，`isNodeRunnable` 为 false，卡片仍按原规则显示“跑不了”的样式。
8. **中英文词条同步**：`ide.ts` 新增 34 条 `ide.modules.*`，`settings.ts` 新增 14 条 `settings.workflows.module*`，中英文各一份。
9. 导入、显式授权、移除、任务历史、结果对话框的行为保持不变（原有 8 项浏览器检查全部通过）。

## 实际改动文件
新增：
- `apps/desktop/src/renderer/components/modules/CapabilityCatalogPanel.tsx`：目录面板，并导出 `workflowTargetLabel` 和 `formatBytes`
- `apps/desktop/src/renderer/components/modules/CapabilitySchemaView.tsx`：只读的 schema 文本视图
- `apps/desktop/src/renderer/components/settings/workflows/ModuleCapabilityFields.tsx`：节点配置控件，并导出 `MODULE_CALL_PARAM_KEYS`
- `apps/desktop/scripts/module-catalog-ui-smoke/{run.sh,build.mjs,main.jsx,verify.ts}`：新的浏览器专项

修改：
- `apps/desktop/src/renderer/components/modules/ModuleSurface.tsx`：挂载目录面板，去掉重复的目录加载/错误提示
- `apps/desktop/src/renderer/components/settings/workflows/NodeInspector.tsx`：加入 module-capability 分支
- `apps/desktop/src/renderer/components/settings/workflows/WorkflowNodeCard.tsx`：补 `KIND_LOOK` 映射
- `apps/desktop/src/renderer/lib/i18n/{zh,en}/ide.ts`、`{zh,en}/settings.ts`：只追加词条
- `apps/desktop/scripts/module-ui-smoke/build.mjs`：UI 桶替身补导出 `empty-state` 和 `badge`，因为面板用到了这两个组件
- 本报告

## 测试证据
所有套件都通过 `node apps/desktop/scripts/run-smokes.mjs <suite>` 运行，日志在 `apps/desktop/.tmp/smoke-runs/<目录>/`。

**有效红灯**（每次都是先写测试，在实现落地前运行。页面加载正常、没有异常，失败点都在目标行为上）：
1. `1790476869677-21996-QGpJYJ`，exit 1：`[data-testid=capability-catalog-loading]` 等待超时，即目录面板尚不存在。
2. `1790477979975-17200-IYaeCF`，exit 1：前 5 项通过，第 6 项 metadata 标题断言得到空字符串，即尚未展示 metadata。
3. `1790478146453-38900-eJvkI8`，exit 1：目录 10 项通过；检查器页 `[data-testid=module-capability-fields]` 等待超时，即节点控件尚未接入。

**绿灯**：
- `module-catalog-ui-smoke`：`1790478534423-32212-FaEUcm`，**21/21 通过，exit 0**。日志记为 `.tmp/p2-04-green2.log`，产物（截图、results.json）在 `apps/desktop/.tmp/module-catalog-ui-*`。
- 原有 `module-ui-smoke`：`1790478731041-48400-TruM8S`，**8/8 通过，exit 0**。
- Desktop 类型检查：`node apps/desktop/node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json`，**EXIT=0**（日志 `.tmp/p2-04-tsc.log`）。这是在共享工作区某一时刻的结果，不是冻结快照。
- `git diff --check`（仅限本任务文件）：exit 0。
- `workflow-ui-smoke`：本任务改了 NodeInspector 和 WorkflowNodeCard，按规则应当跑。重连后重跑：日志 `apps/desktop/.tmp/smoke-runs/1790480293718-24692-upB3Zt`，**60/60 PASS**（passed 60, failed 0, harnessErrors 0），exit 0，HEAD `fe62fe3`。

**哪些是真实实现，哪些是替身**：
- 目录部分使用真实的 `ModuleHost` 和 `fileCapabilities`（`real` 模式）。另有两份标明为测试夹具的数据：`legacy` 是第一阶段形状，没有 metadata 和 workflowTargets；`rich` 经过冻结版 `ModuleCatalogSchema.parse` 校验。之所以需要夹具，是因为 02 的真实 metadata 仍在变动，而 UI 需要确定、稳定的断言对象。
- 检查器部分用的 `mcode.module-capability` 节点清单是**测试夹具**（放在测试目录，经真实 `NodeTypeManifestSchema` 校验）。生产清单由 05 注册。
- 除 `@renderer/lib/api.js` 和 `useSuppressBrowserView` 外，React 组件、真实 i18n 词典和 store、contracts 均为原样打包。
- 浏览器使用独立 profile。日志里有该 profile 的 `EBUSY / cleanup deferred` 警告，属于测试自身清理问题，不影响断言结论。

## 跨任务请求 / 阻塞
- **05**：
  - 注册内置 `mcode.module-capability` 节点类型时，参数键请保持 `moduleId`、`contributionId`、`path`。检查器按这三个键接管，通用表单会跳过它们；如果另加参数，会按通用控件显示。
  - 请在 `webApi.ts` 的共享组件路径上确认 `modules.catalog` 在手机端被明确拒绝（现状已如此）。当前检查器只在桌面设置页使用。如果今后手机端也会渲染 NodeInspector，拒绝会以目录错误的形式显示在控件里，不会导致整棵组件树卸载。
  - 保存和导入时请在主进程再做一次参数校验。UI 的下拉只是配置入口，不承担授权。
- **01**：激活 runnable 门禁（REQ-02）后，卡片会自动切换到本任务新增的外观，UI 这边不需要再改。
- **07 / 其他对话（提示）**：本轮 `zh/settings.ts`、`en/settings.ts` 里另有一个无关对话的一行修改（手机端显示模式提示），本任务没有碰它，只在 `settings.workflows.nodeTypeNoParams` 之后追加了词条，每次写入都带版本号校验。另外 `WorkflowNodeCard.tsx` 在工作区中是 CRLF 行尾，git 会提示“CRLF will be replaced by LF”，但 `git diff --numstat` 显示实际只多了 5 行，没有整文件改写。

## 未实现 / 未验证
- **没有做工作流端到端验收**：新节点尚未出现在生产节点目录里（依赖 05），门禁也还关着（依赖 01 REQ-02）。实际执行、输出和取消由 05/06 联调验收。
- 路径输入框没有“浏览”按钮。原因是工作流运行时的项目目录由可信上下文决定，本地文件选择器给出的绝对路径不一定在那个工作区内。用户可以手填路径或插入变量，宿主在执行时校验。
- 下拉的键盘路径（ArrowDown 打开、Enter 选择）和鼠标备选路径都写进了测试。本次运行中哪一条实际生效没有单独记录。
- 没有做 Electron 实机验收，也没有全量 smoke（全量归 07）。

## 给下一任务的接入说明
- `CapabilityCatalogPanel({catalog, loading, error, onRetry})`：数据来自 `useRpc(api.modules.catalog)`。
- `ModuleCapabilityFields({params, onChange, insertables?})`：自己通过 `useRpc` 读取 `modules.catalog`，`onChange` 回传的是完整的新 params 对象。
- `MODULE_CALL_PARAM_KEYS = ["moduleId","contributionId","path"]`。
- `workflowTargetLabel(catalog, target, locale)`：返回“模块标题 · 贡献标题”，如果目录里查不到，则返回原始 ID。
- 测试钩子（`data-testid`）：`capability-catalog(-loading|-error|-empty)`、`capability-entry[data-capability-id]`、`capability-{kind,title,version,description,permissions,cancellation,limits,input-schema,output-schema,used-by,workflow,metadata-missing}`、`capability-workflow-none`、`module-capability-fields`、`module-target-{trigger,option,summary,stale,none,error,loading}`、`module-path-variable`、`module-call-invalid`、`module-forbidden-params`。06 可以直接复用。

## Git
- 未提交、未推送、未 `git add`。没有运行 reset、checkout、stash 或全库格式化。
- 没有覆盖或清理其他对话的修改。开工时已存在的 library、mobile、runtime 等并行修改，以及 01、02、03 的文件，全部保持原样。
