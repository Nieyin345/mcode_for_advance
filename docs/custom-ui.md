# 自定义 UI 入口系统（customUi）

> 这一页是**索引**：全景图在这里，权威细节在 `packages/contracts/src/customUi.ts` 的
> 头注释与各 schema 的注释里（本仓库的注释即文档）。与「UI 模块平台」的关系见文末。
> 回归网：`scripts/custom-ui-smoke`（纯函数直测，bundle 即跑）。

## 一句话

主界面只放**入口**（右键菜单的一项、右栏的一个页签、工具栏的一颗按钮），点下去做什么、
显示什么，全部在 设置 → 自定义 UI 里定义（`CustomUiPanel.tsx`）。没有脚本、没有 HTML——
要写逻辑去自动化/工作流，那边有审阅、运行记录与权限边界。

## 全景表

**7 个挂载位 × 3 类条目 × 6 种动作**（动作按挂载位白名单，见 `ACTIONS_BY_SLOT`）：

| 挂载位 | 目标 | 允许的动作 |
|---|---|---|
| `library.item` 条目右键 | item | view / prompt / copy / automation |
| `library.collection` 分类右键 | collection | 同上 |
| `library.subcategory` 小类右键 | collection | 同上 |
| `library.group` 大类右键 | group | 同上 |
| `files.context` 文件右键 | file | 同上 |
| `rightPanel.tab` 右栏页签 | workspace | view / file（常驻显示区，只有「显示什么」有意义） |
| `toolbar` 竖向工具栏 | workspace | view / prompt / copy / automation / file / openTab |

条目三类：`builtin:`（内置项，只管显隐排序）、`custom:`（用户建的：名字+图标+条件+动作）、
`module:`（v1 JSON 模块清单的文件右键贡献，仅 `files.context`）。
**管理项**（重命名/移动/删除/新建…）不进本系统：固定、不可藏、不可排。

## 不变量（改代码前先读）

1. **配置是用户数据**：读取逐条宽容（坏一条丢一条，见 `coerceCustomUiConfig`）；渲染端
   一切查白名单（图标表、动作×挂载位、模板变量表 `TEMPLATE_VARS_BY_SLOT`）。
2. **图标白名单只能往后加、不能改名/重排**——名字存在用户配置里（冒烟已钉前 16 项）。
3. **新东西默认出现**：布局 `order` 没列到的条目接在后面显示；残留的已删条目跳过。
4. 模板 `{{变量}}` 认不出的**运行时渲染为空串**（原样留给模型会被当成要填的槽）；
   设置页保存前用 `unknownTemplateVars` 点名打错的变量（宽容运行、严格提示，不拦保存）。
5. **批量跑自动化**：分类/大类先 dryRun 数数 → 用户确认 → 再跑；上限
   `CUSTOM_UI_MAX_BATCH`（200）；展开/回收站过滤/文件在项目内校验全部在主进程
   （`main/customUi/runAutomation.ts`），载荷与事件触发同形。
6. `file` 动作两条路的边界**不同**：页签读内容走「读文件 RPC」（项目根白名单）；工具栏
   「在 IDE 里打开」不经过该白名单（等价于用户本机自己打开文件）。别互相假设。

## 与「UI 模块平台」的关系

两层正交：模块平台（`modules.ts` + `ModuleHost`，见 `ui-module-platform*.md`）管**能力**
（清单、只读能力宿主、任务、工作流节点）；customUi 管**入口的编排**（显示、排序、条件、
参数化模板）。两层只在 `files.context` 汇合——模块贡献以 `module:<模块>:<贡献>` 键参与
customUi 的排序/隐藏，授权仍归模块平台。

## 文件地图

- 契约与纯函数：`packages/contracts/src/customUi.ts`（schema/解析/排序/模板/条件）
- 设置页：`renderer/components/settings/CustomUiPanel.tsx`
- 挂载点组件：`renderer/components/customUi/`（registry=内置项元数据表、
  CustomUiMenuItems、CustomUiToolbar、CustomTabView、runCustomItem=动作执行）
- 主进程：`main/customUi/{runAutomation,targets}.ts`（批量展开那一半）
- 回归网：`apps/desktop/scripts/custom-ui-smoke/`

