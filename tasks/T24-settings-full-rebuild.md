# T24｜设置页全面重构（63 个面板对齐 CDS）

| 项目 | 值 |
|---|---|
| 编号 | T24 |
| 类型 | ARC-005 UI（设置页整体） |
| 优先级 | **高** —— 这是 UI 重构里最大的一块没动的地方 |
| 建议并发 | 只改 `components/settings/`，可与其它 UI 任务并行 |
| 预计规模 | **大**（63 个文件 / 26,303 行） |

---

## 现状（实测，不是估计）

| 指标 | 现状 |
|---|---|
| 设置页组件 | **63 个 / 26,303 行** |
| 已用 CDS token | **3 / 63** |
| 仍硬编码 `rounded-xl` / `shadow-2xl` | 3 个 |
| 已复用 `ui/` 原语 | `Button` 44、`ErrorNote` 24、`Input` 18、`Switch` 16、`EmptyState` 8、`Field` 8、`Badge` 4、`Spinner` 4、**`Skeleton` 0** |

**最大的几个面板**（重构难度也是这几个）：
`CustomModelsPanel` 2028、`PluginsPanelParts` 1715、`SkillsPanel` 1474、
`SkillsPanelParts` 934、`McpPanel` 928、`HooksPanel` 920、
`CustomUiPanel` 784、`CustomUiPanelParts` 782、`CustomModelsPanelParts` 721。

**已经做过的**（不要重做）：导航分组重组成「常用 / 引擎 / 文档 / 扩展 / 系统」（`SettingsPage.tsx:189`）。

---

## 目标

**设置页的每一屏都变成 Claude 桌面端的形态**，并且**只保留一套实现**。

这不是"换个配色"，而是：

1. 每个面板的**布局骨架**改成 Claude 的形态
2. 所有**控件**复用 `ui/` 原语 + CDS token
3. **删掉每个面板自己的重复实现**（自绘的空状态、加载态、错误条、徽标、表单行）

---

## 开工前必读

1. `apps/desktop/src/renderer/components/settings/SettingsPage.tsx` **全文**（460 行）——
   外壳、导航、内容区。
2. `apps/desktop/src/renderer/components/ui/` 全部 17 个原语 ——
   这是你要用的积木。
3. `apps/desktop/src/renderer/components/ui/cds/` —— CDS 组件。
4. `apps/desktop/src/renderer/styles.css` 的 token 段（`--radius-*` /
   `--shadow-*` / `--chat-fs-*`）。
5. `open-claude-ui/AGENTS.md` 的 token 与几何规则。
6. `apps/desktop/scripts/settings-layout-smoke/` 与 `settings-panel-smoke/` ——
   现有防线，**不能破**。

---

## 执行方式：**分批，按面板组，每批单独提交**

**不要一次改 63 个文件。** 按下面的顺序，每批做完提交一次、跑一次回归：

### 第 1 批：外壳与导航（最基础）

- `SettingsPage.tsx` 的布局骨架
- 导航项、分组标题、内容区边距
- **先做这个**，因为其它面板都挂在它下面

### 第 2 批：小面板（12 个，每个 < 300 行）

一次做 3–4 个，验证套路后再往下：
`AboutPanel`、`DataRootPanel`、`UsagePanel`、`UpdatePanel`、
`LibraryTypesPanel`、`LspLanguagesPanel`、`MonitoringPanel`、
`RuntimePanel`、`AgentProfilesView`、`MarketView` 等。

### 第 3 批：中等面板（每个 300–700 行）

`GeneralPanel`、`AppearancePanel`、`RemoteControlPanel`、
`SceneDeployPanel`、`McpMarketView`、`PluginsPanel`、`CustomUiPanel`。

### 第 4 批：大面板（每个 > 700 行）

`CustomModelsPanel`、`PluginsPanelParts`、`SkillsPanel`、
`SkillsPanelParts`、`McpPanel`、`HooksPanel`、`CustomUiPanelParts`、
`CustomModelsPanelParts`。

**大面板拆分**：如果某个面板重构时发现单文件超过 2000 行，
按仓库硬规矩先拆（AST 定边界），再重构。

---

## 每个面板的重构套路

### 1. 先盘点这个面板有什么"自绘"

逐项标记，典型的有：

| 自绘的东西 | 应该换成 |
|---|---|
| `<div className="...animate-spin..." />` 加载 | `Spinner` / `Skeleton` |
| 自己写的空状态 div | `EmptyState` |
| 自己写的错误条 | `ErrorNote` |
| 自己写的状态徽标 | `Badge` |
| 自己写的表单行 | `Field` |
| 自己写的输入框 | `Input` |
| 自己写的开关 | `Switch` |
| 自己写的按钮 | `Button` |
| `rounded-xl` / `rounded-2xl` | `--radius-card` / `--radius-dialog` |
| `shadow-2xl` | `--shadow-popover` / `--shadow-lg` |

### 2. 再改布局骨架

Claude 设置页的形态（参考 `open-claude-ui` 与现有 `SettingsPage.tsx` 的分组）：
- 左侧导航（分组 + 图标 + 文字）
- 右侧内容区（标题 + 描述 + 分区卡片）
- 每个分区是一张 `Card`，不是裸 `div`

### 3. 删掉重复实现

**这一条最重要**：重构完的面板里，**不应该再有自己写的空状态/加载态/错误条**。
如果发现某个原语不够用，**先扩展原语**，不要在那个面板里另写一份。

### 4. 每批跑回归

```
node apps/desktop/scripts/run-smokes.mjs settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke
```

**全绿才算这批做完。**

---

## 边界（不要碰）

- 只改 `apps/desktop/src/renderer/components/settings/`。
- 可以扩展 `components/ui/` 的原语（**新增能力**），但不许改它们已有的行为。
- 不改主进程、contracts。
- 不改其它面板（chat / layout / ide）。
- **不改设置项的功能**（只改外观与结构）。如果发现某设置项有 bug，
  记录在回写区，不在这张卡里修。

---

## 验收判据

1. **所有 63 个面板**都用了 CDS token（`--radius-*` / `--shadow-*` / `--chat-fs-*`）。
2. 每个面板的空状态 / 加载态 / 错误条 / 徽标 / 表单行 / 输入 / 开关 / 按钮
   **都复用 `ui/` 原语**，没有自绘。
3. `settings-layout-smoke` / `settings-panel-smoke` /
   `settings-panels-electron-smoke` / `settings-focus-electron-smoke` 全绿。
4. 双包 tsc 干净。
5. **变异验证**：每批至少一条——撤掉某个原语替换，断言必红。
6. **不许丢功能**：每个设置项在重构前后行为一致（有断言或人工核对记录）。

---

## 回写区要回答（每批都写）

- 这批改了哪几个面板？
- 每个面板删掉了哪些自绘实现？换成了哪个原语？
- 有没有发现原语不够用？扩展了什么？
- 有没有发现设置项本身的功能 bug？（记录，不修）

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。每完成一批写一段。 -->

### 2026-10-21｜批次 1：设置外壳与导航

- 改动：`SettingsPage.tsx`。左侧导航统一 `ui/Button`，active 保留色条并增 `aria-current=page`；分组分隔、CDS 圆角/字体 token、内容区间距与层级调整；懒加载兜底从自绘 `IconLoader2` 换为 `ui/LoadingNote`。已有五组与全部深链/能力门控保留。
- 原语：Button、LoadingNote（均未扩展）；设置功能 bug：本批未发现。
- 回归：`node apps/desktop/scripts/run-smokes.mjs settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke`：5 pass/0 fail，日志 `apps/desktop/.tmp/smoke-runs/1792552547829-40684-YVvs9s`。
- 变异：`node apps/desktop/src/renderer/components/settings/t24-design-contract.cjs shell`：PASS；`set T24_MUTATION=shell&& node ... shell`：预期 ASSERTION FAILED（撤回导航 Button，断言变红）。属于结构断言；交互回归另由 Electron smoke 验证。
- 行为核对：settings-layout-smoke 覆盖分组导航、手动点击/深链、旧 data-root/office 等入口；settings-focus-electron-smoke 覆盖焦点与 Escape。无功能逻辑改动。
- 双包 tsc：`apps/desktop` 既有 `src/main/mcp/hostMcpStdio.ts:257/268/274` TS2349（不在 T24 边界内，未修改），故双包全绿判据尚未满足。

### 2026-10-21｜批次 2：较小面板（DataRoot / About / MarketView）

- 改动：`DataRootPanel` 的迁移重启提示自绘 spinner → `LoadingNote`，迁移错误红字 → `ErrorNote`，目录树容器 → `Card`，路径控件 → CDS 圆角 token；`AboutPanel` 的身份标识圆角 → CDS token、运行时信息表 → `Card`、更新中转圈 → `Spinner`、下载进度外壳 → `Card`、更新检查失败的自绘警告条 → `ErrorNote(tone=warning)`；`MarketView` 的源切换按钮 → `Button`、表单和目录卡 → `Card`、状态标签（源类别/内置/已安装）→ `Badge`、等待图标 → `Spinner`、形状 → CDS token。既有回调、禁用态、翻译键、更新状态机不改。
- 原语：均直接复用 `ui/`，本批无需扩展；功能 bug：本批未发现（更新等真实外部操作不做破坏性人工触发）。
- 回归：`node apps/desktop/scripts/run-smokes.mjs settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke`：5 pass/0 fail，日志 `apps/desktop/.tmp/smoke-runs/1792553046539-24040-iEMG0r`；`npx tsc --noEmit -p apps/desktop/tsconfig.json && npx tsc --noEmit -p packages/contracts/tsconfig.json`：双包 0 错。
- 变异：`node apps/desktop/src/renderer/components/settings/t24-design-contract.cjs small` PASS；`set T24_MUTATION=small&& node ... small` 人为将迁移错误的 `ErrorNote` 还原成自绘 div 后，按预期断言失败（exit=1）。断言是结构验证，功能仍由现有 smoke 负责。
- 功能核对：逐项核对 `DataRootPanel` 的读/重试/选择目录/迁移/重启、`AboutPanel` 的版本显示/复制/检查/下载/安装状态、`MarketView` 的搜索/来源切换/新增/安装/刷新/删除绑定未更动；Electron 面板与焦点烟测全绿。

### 2026-10-21｜批次 3：用量、通知、输出样式、治理页签

- 改动：`UsagePanel` 的加载占位与热力图等待状态改 `LoadingNote`、错误块改 `ErrorNote`；`NotificationsPanel` 项目空态改 `EmptyState`；`OutputStylePanel` 刷新按钮改 `Button` 并使用 CDS 控件圆角，读取错误改 `ErrorNote`、初载加入 `LoadingNote`；`GovernancePanel` 自绘双 tab 改 `cds/Segmented`（保留两个业务子视图），用共享键盘交互与磁吸 token。
- 原语：均复用现有控件；本批无需扩展；功能 bug：未发现。未触动用量拉取/重试序号、通知持久化/回滚、输出样式 selection RPC、治理渲染分支。
- 回归：`node apps/desktop/scripts/run-smokes.mjs settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke`：5/5 pass，日志 `apps/desktop/.tmp/smoke-runs/1792553465851-7760-srKpxF`；双包 `npx tsc --noEmit -p apps/desktop/tsconfig.json && npx tsc --noEmit -p packages/contracts/tsconfig.json`：0 错。
- 变异：`node apps/desktop/src/renderer/components/settings/t24-design-contract.cjs mid` PASS；`set T24_MUTATION=mid&& node ... mid`：恢复旧用量自绘错误块后 exit=1（预期红）。
- 行为核对：4 页控制分支、状态字段与传入回调不变；旧 Electron 面板与焦点回归均绿。真实通知/安装副作用未人工触发。

### 2026-10-21｜批次 4：外观、远程控制、MCP 市场

- 改动：`AppearancePanel` 两处自绘原生按钮切成 `Button`（原控制回调/视觉尺寸保留）；`RemoteControlPanel` 公网危险提示、沙箱失效提示、隧道错误改为 `ErrorNote`，状态标签→`Badge`，隧道/控制行容器→`Card`，手写转圈→`Spinner`；`McpMarketView` 搜索源错误/损坏数据/安装失败→`ErrorNote`，来源选项标签→`Badge`，加载/安装忙态→`Spinner`，选方式按钮→`Button`，安装名称字段→`Field` + `Input` 关联。
- 原语：复用 Button/Card/Badge/ErrorNote/Spinner/Field，不扩展。功能 bug：未发现；公网控制与 MCP 配置保存调用不改。
- 回归：`node apps/desktop/scripts/run-smokes.mjs settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke`：5/5 PASS，日志 `apps/desktop/.tmp/smoke-runs/1792553811002-14712-9LatL2`；双包 `npx tsc --noEmit -p apps/desktop/tsconfig.json && npx tsc --noEmit -p packages/contracts/tsconfig.json`：0 错。
- 变异：`node apps/desktop/src/renderer/components/settings/t24-design-contract.cjs wide` PASS；`set T24_MUTATION=wide&& node ... wide` 把隧道错误重新改为自绘元素后 exit=1（预期红）。
- 功能核对：远程控制警告仍在原来两条分支显示，沙箱缺失维持 fail-closed，隧道启停/重置配置与 MCP 来源/选择安装方式/安装校验回调不变；现有 Electron settings suites 全绿；实际公网启用/安装未进行破坏性人工试验。

### 2026-10-21｜批次 5：PluginsPanelParts 大型插件列表与市场卡

- 改动：`PluginsPanelParts.tsx` 的筛选/来源/添加按钮用 `Button`，源导航与添加动作替换 CDS 按钮/卡片圆角 token，已装列表、市场目录与源地址表单改 `Card`，来源类别/内置/已装状态改 `Badge`，市场刷新与安装中状态改 `Spinner`。保留过滤器 `aria-pressed`、展开态、批量操作、安装/删除/更新事件绑定。
- 原语：全为复用 `Button/Card/Badge/Spinner`，本批无需扩展；功能 bug：未发现。
- 回归：`node apps/desktop/scripts/run-smokes.mjs settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke plugins-ui-smoke`：6/6 PASS（含真实 Chromium 插件 UI）；日志 `apps/desktop/.tmp/smoke-runs/1792554175683-23488-QsBI9d`；双包 tsc：0 错。
- 变异：`node apps/desktop/src/renderer/components/settings/t24-design-contract.cjs plugins` PASS；`set T24_MUTATION=plugins&& node ... plugins` 将插件列表 `Card` 退回裸 div 后按预期 exit=1（红例）。
- 功能核对：插件筛选、市场切换、下载安装、刷新与批量操作的 onClick / disabled / 数据路径未变；`plugins-ui-smoke` 真实浏览器回归 PASS。

### 2026-10-21｜批次 6：跨面板统一多行输入原语（12 组件）

- 改动：新增 `ui/Textarea`（透传 React 原生 textarea 全部事件、组合输入、ref、aria 与原 className；统一 CDS 控件半径、边框、聚焦态），并在 `ui/index.ts` 导出。把 `AppearanceExtras`、`CustomUiPanelParts`、`EngineToolsPanel`、`HooksPanel`、`LibraryTypesPanel`、`McpPanelParts`、`SceneDeployPanel`、`SettingsGitPanel`、`SettingsTerminalPanel`、`SkillsPanelParts`、`TitleGenPanel`、`UnattendedPlanPanel` 共 12 个组件原生自绘 textarea 替换成共享原语（18 个开启标签）；保留草稿状态、输入校验、键盘与组合输入逻辑。
- 原语：旧 `ui/` 没有 Textarea，新增只拓展，不改任何现有控件行为；功能 bug：未发现。
- 回归：`node apps/desktop/scripts/run-smokes.mjs settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke`：5/5 PASS；日志 `apps/desktop/.tmp/smoke-runs/1792554406599-35604-YyT58Z`；双包 tsc：0 错。
- 变异：`node apps/desktop/src/renderer/components/settings/t24-design-contract.cjs textarea` PASS；`set T24_MUTATION=textarea&& node ... textarea` 把 `CustomUiPanelParts` 一个 Textarea 标签变回原生后 exit=1（预期红）。
- 功能核对：更换的标签仍是真实 HTML `<textarea>`，React 的 onChange/onKeyDown/value/ref/disabled/placeholder 等原属性原样透传；未改变任何业务 onChange 或持久化逻辑。对复杂持久化写操作只做旧烟测，不做破坏性手点。

### 2026-10-21｜批次 7：Skills 项目/节点/预设与字体步进器动作

- 改动：`SkillNodesView`、`SkillPresetsView`、`SkillProjectOverview`、`ProjectSkillsView`、`FontSizeStepper` 5 组件的原生自绘 `<button>` 全部改为共享 `Button variant=ghost size=null`（原 className、事件、键盘、title、disabled 与焦点接线透传；size=null 防止注入默认 h-6 干扰布局）。
- 原语：全部复用已有 Button；未扩展；设置功能 bug：本批未发现。
- 回归：`node apps/desktop/scripts/run-smokes.mjs settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke`：5/5 PASS，日志 `apps/desktop/.tmp/smoke-runs/1792554587057-32932-elfZjy`；双包 tsc：0 错。
- 变异：`node apps/desktop/src/renderer/components/settings/t24-design-contract.cjs skill-buttons` PASS；`set T24_MUTATION=skill-buttons&& node ... skill-buttons` 将预设动作复原为原生 button 后 exit=1（预期红）。
- 行为核对：各触发回调、启停/加载条件、展开关闭/新增删除/编辑与字体数值增减路径不变；焦点烟测未回归。

### 2026-10-21｜总控核对（不改变任务状态）

按用户规则「写回即完成」，批次 1–7 均视为完成。补充实测：

- 九个大面板的 `rounded-xl` / `rounded-2xl` / `shadow-2xl` 硬编码残留**全部为 0**
  （`CustomModelsPanel`、`CustomModelsPanelParts`、`PluginsPanelParts`、`SkillsPanel`、
  `SkillsPanelParts`、`McpPanel`、`HooksPanel`、`CustomUiPanel`、`CustomUiPanelParts`）。
- 共享原语使用量：`PluginsPanelParts` 76 处、`CustomModelsPanel` 32 处、`SkillsPanelParts` 29 处。
- 批次 8 正在飞（`EngineToolsPanel` / `RuntimesPanel` / `SettingsBrowserPanel` /
  `SettingsTerminalPanel` / `TitleGenPanel` 有未提交改动），
  并新增了两个 codemod（`t24-button-codemod.cjs` / `t24-textarea-codemod.cjs`）与 `t24-audit.cjs`。
- **未做**：`Skeleton` 用量仍为 0。这不是缺陷 —— 设置页的加载态是「有内容的局部刷新」，
  `LoadingNote`/`Spinner` 更合适；`Skeleton` 留给整屏首次渲染的场景。若后续要求补，
  另开卡，不在本卡内加码。

### 2026-10-21｜批次 8：浏览器、终端、Runtime、标题生成、工具权限设置

- 改动：`SettingsBrowserPanel`、`SettingsTerminalPanel`、`RuntimesPanel`、`TitleGenPanel`、`EngineToolsPanel` 的剩余原生动作按钮统一成 `ui/Button` 且保留旧 onClick/disabled/尺寸；`RuntimesPanel` 自绘加载提示→`LoadingNote`、安装失败提示→`ErrorNote`、下载中图标→`Spinner`、安装/更新/已装/未装状态胶囊→`Badge`；`SettingsBrowserPanel` 保管库加密告警→`ErrorNote(tone=warning)`、缓存清理结果→`Badge`/`ErrorNote`；`EngineToolsPanel` 无已知工具的自绘空态→`EmptyState`。
- 原语：均复用已有 ui，无额外扩展。功能 bug：未发现（保留保管库的加密不可用高可见警告）。
- 回归：`node apps/desktop/scripts/run-smokes.mjs settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke`：5/5 PASS，日志 `apps/desktop/.tmp/smoke-runs/1792554867352-14552-MNmFsV`；双包 tsc：0 错。
- 变异：`node apps/desktop/src/renderer/components/settings/t24-design-contract.cjs runtime` PASS；`set T24_MUTATION=runtime&& node ... runtime` 将运行时已安装 Badge 退化为 span 后 exit=1（预期红）。
- 行为核对：Runtime 安装、重新安装、更新、删除、路径复制/显示及进度事件流没变；Browser 安全警告、缓存清理、Terminal 控件/标题生成和 EngineTools 权限选择回调没变；Electron 焦点测试通过。

### 2026-10-21｜批次 9：语言服务、MCP、插件项目视图、资料库分类

- 改动：`LspLanguagesPanel`、`McpPanel`、`PluginsPanel`、`ProjectPluginsView`、`LibraryTypesPanel` 中的自绘动作按钮统一为 `Button`；LSP 状态胶囊统一 `Badge`，健康检查/服务端报错→`Badge`/`ErrorNote`，加载中图标→`Spinner`，3 个路径/参数输入和自绘 `Field` 改共享 `Field/Input`（id 以 language 做唯一关联，保留 click-to-focus）。MCP 搜索输入→`Input`，异常→`ErrorNote`，空总库→`EmptyState`，加载→`LoadingNote`，按钮转圈→`Spinner`；项目插件的搜索→`Input`、卡片→`Card`、初载/空态→`LoadingNote`/`EmptyState`、覆盖来源标签→`Badge`；资料库拓展名输入→`Input`，自绘转圈→`Spinner`。
- 原语：全复用现有 ui，未扩展；功能 bug：未发现。MCP/分类树选择中的原生 checkbox 保留当前 native 语义，后续单独迁移。
- 回归：`node apps/desktop/scripts/run-smokes.mjs settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke`：5/5 PASS，日志 `apps/desktop/.tmp/smoke-runs/1792555276125-31172-pzAp7p`；双包 tsc：0 错。
- 变异：`node apps/desktop/src/renderer/components/settings/t24-design-contract.cjs mcp-lsp` PASS；`set T24_MUTATION=mcp-lsp&& node ... mcp-lsp` 把 LSP 标签字段的 Field 撤回后 exit=1（预期红）。
- 行为核对：LSP 自定义路径/参数/JAVA_HOME 更改与保存的 onChange/onClick 透传，输入标签动态唯一 id；MCP OAuth/复制/导入/新增、插件启用/项目筛选、分类树和增删规则逻辑未改；相关 Electron 回归通过。

### 2026-10-21｜批次 10：原生语义控件与 MCP 对话框字段、项目权限卡

- 改动：`ui/native-controls.tsx` 新增 `Checkbox` / `NativeSelect` / `ColorInput`，原生表单交互、change/value/ref 透传，收敛 CDS `--radius-btn-xs`、焦点态/禁用态。`AppearancePanel` 色彩选择→`ColorInput`；`LibraryTypesPanel` 树勾选→`Checkbox`；`McpPanel` 勾选→`Checkbox`；`McpPanelParts` 4 个服务字段 `<input>`→`Input`、自绘字段→`Field`、导入勾选→`Checkbox`、加载/错误/现有标签→`LoadingNote`/`ErrorNote`/`Badge`；`ProjectMcpView` 项目列表/复制区→`Card`，空态/加载态→`EmptyState`/`LoadingNote`，可信度/协议标签→`Badge`，坏记录警告→`ErrorNote`，复制勾选→`Checkbox`。明确跳过不属于本任务的主进程改动。
- 原语：为保留 native 复选框与颜色板语义而扩展 ui，只增不改旧原语。`mcp-ui-smoke` 的固定 ui/index mock 不导出新 `Checkbox`，故 MCP 3 个使用方改从 `ui/native-controls.js` 直接导入；首次跑 mcp-ui-smoke 1 fail（mock 找不到导出），调整 import 后 6/6 全绿。
- 回归：`node apps/desktop/scripts/run-smokes.mjs mcp-ui-smoke settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke`：6/6 PASS，日志 `apps/desktop/.tmp/smoke-runs/1792563743443-30832-mnkIXz`。`node .../t24-design-contract.cjs native` PASS，`set T24_MUTATION=native&& node ... native` 预期 exit=1（撤回 MCP 导入 Checkbox 断言必红）。
- 功能核对：MCP 导入勾选及保存配置、信任、项目复制逻辑无修改，颜色选择仍为浏览器原生 input type=color、复选框仍为 input type=checkbox，aria/label、禁用与回调不变。外部并发工作造成全局双包 tsc 失败：`genofficeViewFactories.ts` 与 GenOffice slides 大量 API 缺失、`packages/contracts/src/modules.ts` 导出冲突、`moduleCapability.ts` Zod 类型等均不在 T24 范围；`tsc` 日志中过滤 `components/settings` / `components/ui/native-controls` 未出现本批新增类型错误。功能 bug：本批未发现。

### 2026-10-21｜批次 11：大面板原生动作按钮收敛

- 改动：`HooksPanel`、`CustomUiPanel`、`CustomUiPanelParts`、`SkillsPanel`、`SkillsPanelParts`、`PluginsPanelParts` 的原生 `<button>` 改为共享 `Button variant=ghost size=null`，保留原事件、disabled、role、aria 和局部尺寸；`MarketView` 的 `Badge` 改深路径导入以兼容 skills-management-ui-smoke 的静态 mock。
- 原语：复用已有 `Button`；无扩展。真实浏览器烟测首跑发现技能列表按钮改为 `inline-flex` 后双行内容横排，覆盖复选框命中区域，导致 5 条技能选择/复制用例失败；将 `SkillsPanel` 行动作加 `flex-col items-stretch justify-start`，保留原上下两行和左侧复选框命中。修复后技能专项 1/1 绿，完整回归 7/7 绿。该问题属于本批外观结构引入的交互回归，已当批修复。
- 回归：`node apps/desktop/scripts/run-smokes.mjs skills-management-ui-smoke plugins-ui-smoke settings-layout-smoke settings-panel-smoke settings-panels-electron-smoke settings-focus-electron-smoke frontend-smoke`：7/7 PASS，日志 `apps/desktop/.tmp/smoke-runs/1792564273613-19788-W9e38B`。双包 tsc 仍有与本批无关的并发 GenOffice / contracts 错误；本批 TypeScript 接口在既有 TSX/ESBuild smoke 中通过。
- 变异：`node apps/desktop/src/renderer/components/settings/t24-design-contract.cjs large-actions` PASS；`set T24_MUTATION=large-actions&& node ... large-actions` 撤回 SkillsPanel 一处共享 Button 后 exit=1（预期红）。
- 行为核对：技能列表行复选框命中、批量启停/删除、项目复制、工程选择、插件/技能市场互动在独立浏览器测试通过；所有替换继续透传业务回调、aria 与 disabled，未改业务数据流。新增功能 bug：无；结构回归已修复。
