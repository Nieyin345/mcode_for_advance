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
