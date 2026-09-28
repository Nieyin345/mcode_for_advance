# 文献功能迁出内置 → 自定义 UI（设计与实施记录）

> 背景（2026-09-28，用户决策）：Mcode 定位是**通用 agent 工作台**，文献只是一个用户的
> 需求，不是通用需求。文献信息 / MD 转录入口 / 文献导入这类内置功能应当退役，改由
> 自定义 UI + 自动化组合表达。**自动化里的下载与转录流程不动。**
>
> 原则：为此新增的每个机制都必须是**通用原语**（任何自动化/任何领域都用得上），
> 不允许出现 `libraryXxx` 这种领域动作类型。

## 原语 P1：`skipWhen` —— automation 动作的声明式条目过滤（✅ 已实施）

`automation` 动作新增可选 `skipWhen`（复用 `CustomUiWhenSchema`）：批量展开时,
**满足条件的条目被跳过**。检测逻辑只有一处（主进程展开时,`targets.shouldSkipItem`,
复用 `matchesWhen` 纯函数）；确认框与结果如实报告「带 N 条、跳过 M 条」。

- 手动转录（文件/条目右键）：automation 指向转录自动化 + `skipWhen: { requires: "markdown" }`
  ⟹ 已有转录的条目不重复转录；全部已转录时明确报告、不空跑。
- 分类/大类右键批量转录：同一条目,dryRun 先数「将带 N 条（另 M 条已跳过）」再确认。
- 载荷形状不变（与 library.item.* 事件同形）,自动化侧零改动。
- 编辑器 v1 只开放 `requires` 一档（跳过已有 转录/PDF/文件 的条目）；schema 支持完整
  CustomUiWhen（extensions/groupIds）,UI 需要时再开。

## 原语 P2：`inputs` —— automation 动作的运行前输入（✅ 已实施,2026-09-28）

`automation` 动作可声明输入项 `inputs: [{ key, label, kind: "text" | "files" }]`：
点击后弹原生小表单（文本框 / 文件选择器）,值以 `{{trigger.input.<key>}}` 进入自动化
变量。这是「文献导入」的通用化：

- DOI 下载：collection 右键「文献导入」= automation + `inputs:[{key:"doi",kind:"text"}]`,
  自动化里用 {{trigger.input.doi}} 走既有下载流程,目标分类来自右键目标。
- PDF 导入：同一入口或另一项,`kind:"files"` 弹系统文件选择器,路径进载荷。

涉及：contracts schema、渲染端输入浮层、`TriggerPayload` 增加可选 `input` 字典 +
变量构造器暴露 `trigger.input.*`（对既有自动化零行为变化,纯增量）。

**实施记录**：`TRIGGER_REF_RE` 本就允许键名带点、按字面查键 ⟹ 载荷侧把 input 拍平成
`input.<key>` 平面键后 `{{trigger.input.doi}}` 直接可解,**变量展开器零改动**。
改动:contracts(`CustomUiInputSchema`,automation.inputs ≤4 项,RunAutomation.input
值表)、`automationPayload.ts`(file/event 载荷带 input、facts 拍平、人话段带输入行)、
`runWithTarget` 第 4 参、`runCustomUiAutomation` 贯通、渲染端表单浮层
(`CustomUiHost.InputFormDialog`,files 走 `api.pickFiles` 原生对话框)、设置页行编辑器、
预置模板「文献导入」(collection/小类右键:选 PDF + DOI 文本,二选一填)。
v1 限制:工具栏挂载位不可用(runNow 无 input 通道,点击时如实提示)。
验证:custom-ui-smoke 116/116(先红后绿)、automation-smoke 10/10、contracts tsc 0 错、
desktop tsc 除共享工作区预存在的 OnlyOfficeConfigCard 半成品外零错误。
另修:`ImportPanel` 提示文字被压成竖排的布局 bug(hint 移出按钮行 + flex-wrap)。

## P3：内置项退役（✅ 已实施,2026-09-28;用户确认清单 = info + adoptMarkdown,通用导入保留）

- 已删:`BUILTINS["library.item"]` 的 `info`/`adoptMarkdown`、菜单两个 runtime、
  `onShowInfo`/`onAdoptMarkdown` props、`LibrarySection` 的 `adoptMarkdownFor`/`infoFor`/
  `ItemInfoDialog` 挂载。**核实结论**:adoptMarkdown 是「挂现成 MD(跳过转录)」的能力,
  不是转录实现 —— 能力保留在 `library.adoptMarkdown` RPC、MCP 工具、右栏详情页按钮;
  转录本身在自动化(不动)。`ItemInfoDialog` 组件本体暂保留(export,详情页可复用;
  确认无用后随 ItemDetail 清理批次删除)。
- **通用导入「导入到这里」保留不动**(用户决定:所有文件都从它导入)。
- 通用替代已就位:预置模板「条目信息卡」(view,8 个白名单变量拼卡);「手动转录」模板
  升级为自带 `skipWhen: markdown`(点开即是"带检测的兜漏转录")。
- 存量配置安全:`arrangeSlotEntries` 对消失的 `builtin:` 键自动跳过(冒烟已钉);
  用户手动排过序的布局里残留的 `builtin:info` 键会被静默跳过,不报错。
- 验证:custom-ui-smoke 116/116、contracts tsc 0、desktop tsc 除共享工作区预存在的
  OnlyOfficeConfigCard 半成品外零错误。

## 验证

## P4:首启自动预置(✅ 2026-09-28,"你来给我搭好")

用户从没配置过自定义 UI(items 为空)时,`customUiStore.load()` 自动按**现有自动化**
搭出文献菜单(`seedDefaults.buildDefaultLibraryItems`,纯函数,冒烟钉规则):

| 预置项 | 挂载位 | 绑定规则 |
|---|---|---|
| 条目信息 | 条目右键 | 零依赖(view 信息卡) |
| 手动转录(漏转补齐) | 条目右键 | kind=event 的触发器(优先名字含 转录/markdown/mineru),skipWhen: 已有转录跳过 |
| 批量转录(跳过已转录) | 分类 + 小类右键 | 同上 |
| 文献导入(PDF / DOI) | 分类 + 小类右键 | 名字含 下载/download/doi 的触发器;inputs = 选文件 + DOI 文本 |

绑定结果 toast 打印(绑了哪条自动化、缺了哪条如实说);绑不出的项不建、不瞎绑。
幂等:只在 items 为空时跑;预置后用户可在设置页随意改/删,不会被重新覆盖。

- `scripts/custom-ui-smoke`:P1 的 schema/过滤纯函数断言（先红后绿）。
- contracts typecheck 0 错;desktop typecheck 目前被共享工作区一个未跟踪半成品
  (`OnlyOfficeConfigCard.tsx`)挡住,与本改动无关。

