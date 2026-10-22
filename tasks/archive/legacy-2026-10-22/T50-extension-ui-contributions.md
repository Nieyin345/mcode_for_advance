# T50｜扩展 UI 贡献点：从「只有文件右键」到「到处都能挂」

| 项目 | 值 |
|---|---|
| 编号 | T50 |
| 类型 | 扩展系统主线（用户：尽可能自定义，像 vscode 一样几乎无所不能） |
| 优先级 | 高 |
| 建议并发 | 改 `packages/contracts/src/modules.ts` + 渲染端；**先完成 T48** |
| 预计规模 | 大 |

---

## 现状：只有一个贡献点

```ts
// packages/contracts/src/modules.ts:116
contributions: z.array(z.object({
  id: LocalId,
  slot: z.literal("files.context"),   // ← 只有这一个
  title: LocalizedTextSchema,
  extensions: ...,
  capability: Id,
  view: { title, fields },
})).min(1).max(12),
```

**扩展能挂的 UI 位置：文件右键菜单。**

而且它渲染的 `view` 是**声明式的**（一组 `{key, title}` 字段），
不是真正的 UI —— 宿主负责把它画成一个信息面板。

---

## 目标：像 VS Code 一样能挂各处

VS Code 的贡献点（`contributes`）有几十个，最常用的是这九个：

| VS Code 贡献点 | Mcode 对应 | 价值 |
|---|---|---|
| `commands` | 命令面板 | **高** —— 用户能主动触发扩展 |
| `menus` | 右键菜单 / 工具栏 | 高 —— 已有一个 `files.context` |
| `views` / `viewsContainers` | 侧栏面板 | **高** —— 扩展能常驻 |
| `statusBar` | 状态栏项 | 中 |
| `configuration` | 设置项 | 高 —— 扩展能加自己的设置 |
| `keybindings` | 快捷键 | 中 |
| `languages` / `grammars` | 语法高亮 | 中 |
| `themes` | 主题 | 低（纯资源） |
| `webview` | 自定义 HTML 面板 | **最高** —— 但也是最有风险 |

**注意最后一行**：`webview` 等于「扩展能在宿主里跑任意 HTML/JS」。
Mcode 已经有这个能力了 —— **自定义面板**（`customUi`，`mcode-panel://` 沙箱 iframe，
400 KB HTML 上限）。它是另一套系统，不是扩展贡献点。

---

## 关键判断：不要重造自定义面板

Mcode 已有：
- `customUi`（自定义面板）：用户写 HTML，跑在沙箱 iframe，能调 `mcode.api.call`
- `extensionStore`：扩展的私有存储
- `panelBridge`：面板 → 主进程的桥

**所以 `webview` 这个贡献点不需要新造**，只需要让**扩展能注册一个面板**：

```json
{
  "contributions": [{
    "id": "my-panel",
    "slot": "panel",
    "capability": "module.my-panel",
    "panel": { "html": "panel.html" }   // 从扩展包里读
  }]
}
```

Mcode 已有的 `customUi` 基础设施直接复用。

---

## 本卡的范围

**只做三个贡献点**（价值最高、风险最低）：

| 贡献点 | 为什么先做它 |
|---|---|
| **`commands`** | 扩展能被用户主动触发，是一切的基础 |
| **`views`（侧栏面板）** | 扩展能常驻，不用每次右键 |
| **`configuration`（设置项）** | 扩展能加自己的设置，不用硬编码 |

`statusBar` / `keybindings` / `languages` / `themes` 各开后续卡。
`webview` 复用 `customUi`，另开卡。

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `packages/contracts/src/modules.ts` 的 `ModuleManifestSchema.contributions`。
3. `apps/desktop/src/renderer/components/modules/` —— 现有的模块 UI 怎么渲染贡献。
4. `apps/desktop/src/main/modules/ModuleHost.ts` 的 `invoke` —— 贡献怎么被执行。
5. `packages/contracts/src/customUi.ts` 与 `customUiPanel.ts` ——
   面板的形状，本卡的 `views` 要参考它。
6. `apps/desktop/src/renderer/components/settings/SettingsPage.tsx` ——
   设置页的导航结构（`configuration` 贡献点要挂进去）。
7. `apps/desktop/src/renderer/components/layout/RightPanel.tsx` ——
   右栏的 tab 结构（`views` 要挂进去）。
8. `apps/desktop/src/renderer/lib/i18n/` —— 贡献点的标题要本地化。

---

## 执行内容

### 1. `commands` 贡献点

清单：

```json
{
  "contributions": [{
    "id": "hello",
    "slot": "command",
    "title": { "zh": "打招呼", "en": "Say hello" },
    "capability": "module.hello",
    "command": "myext.hello",
    "icon": "sparkles"
  }]
}
```

- `command` 必须符合 `^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9.-]{1,80}$`（`publisher.name` 形状）
- 命令出现在**命令面板**（`Ctrl/Cmd+K` 或现有的命令入口）
- 执行时 → `ModuleHost.invoke(contributionId)`
- **图标**：只允许从 Mcode 已有的图标集里选（`lib/icons.ts`），不接受任意 SVG/URL

### 2. `views` 贡献点（侧栏面板）

```json
{
  "contributions": [{
    "id": "stats",
    "slot": "view",
    "title": { "zh": "统计", "en": "Statistics" },
    "capability": "module.stats",
    "location": "right",          // right | left | bottom
    "icon": "chart",
    "view": { "kind": "fields", "fields": [...] }   // 与现有 files.context 同形状
  }]
}
```

**先只支持声明式 `view`**（一组字段），不支持任意 HTML。
任意 HTML 走 `customUi` 那条路（另开卡）。

- 面板出现在指定位置
- 打开时调用一次能力拿数据
- 有一个刷新按钮（再调一次）
- 内容按字段渲染（复用现有的 `ModuleSurface` 渲染逻辑）

### 3. `configuration` 贡献点（设置项）

```json
{
  "contributions": [{
    "id": "settings",
    "slot": "settings",
    "title": { "zh": "MyExt 设置", "en": "MyExt settings" },
    "capability": "module.settings",
    "properties": [{
      "key": "apiEndpoint",
      "title": { "zh": "接口地址", "en": "API endpoint" },
      "type": "string",
      "default": "",
      "description": { ... }
    }]
  }]
}
```

- 出现在设置页的「扩展」分组下
- 值存在 `extensionStore`（扩展的私有存储），**不污染 Mcode 的设置表**
- 扩展通过 `mcode.api.call("extensionStore.get", { key })` 读，或经 `resource` 传入

**`type` 只支持**：`string` / `number` / `boolean` / `enum`（带 `enum` 值列表）
—— 与 VS Code 的 `configuration` 子集对齐。

### 4. 契约与校验

- `ModuleManifestSchema.contributions` 的 `slot` 从 `z.literal("files.context")`
  扩成 `z.enum(["files.context", "command", "view", "settings"])`
- 每个 slot 有自己的必填字段（用 zod 的 `discriminatedUnion`）
- **校验要严**：未知字段拒绝、图标只允许白名单、命令名符合正则

### 5. UI 接线

| 贡献点 | 挂在哪 |
|---|---|
| `command` | 命令面板 / 现有的命令入口 |
| `view` | `RightPanel` / `ThreePaneLayout` 的对应位置 |
| `settings` | `SettingsPage` 的「扩展」分组 |

**这一条最花时间**：三个位置都是现有的组件，要读懂它们的结构再插进去。

---

## 边界（不要碰）

- **不做 `webview`**（任意 HTML），那是另一张卡，复用 `customUi`。
- 不做 `languages` / `themes` / `keybindings` / `statusBar`。
- 不改 `customUi` 的既有行为。
- 不改 `ModuleHost` 的权限判定（T48 负责）。
- 不改文档 / 工作流 / Node-RED 相关代码。

---

## 验收判据

1. 一个声明 `command` 的扩展，命令出现在命令面板，执行能调通能力（有断言）。
2. 一个声明 `view` 的扩展，面板出现在指定位置，能显示字段数据（有断言）。
3. 一个声明 `settings` 的扩展，设置项出现在设置页，值存进 `extensionStore`
   而不是 Mcode 的设置表（有断言）。
4. 非法清单被拒：未知 slot、非法命令名、不在白名单的图标（各一条断言）。
5. 现有 `module-*` 套件全绿。
6. 双包 tsc 干净。
7. **变异验证**：撤掉 `slot` 的 discriminatedUnion → 判据 4 红；
   把 `settings` 的值改成写进 `setting.set` → 判据 3 红。

---

## 回写区要回答

- 三个贡献点里哪个花的时间最多？为什么？
- `view` 的声明式字段够用吗？有没有需要任意 HTML 的场景？
- 命令面板现在长什么样？扩展命令和内置命令怎么区分？
- 设置页的「扩展」分组会不会太长？多个扩展的设置怎么组织？
- 图标白名单要包含哪些？现有 `lib/icons.ts` 有多少个可选？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->

### 2026-10-21 T50 执行回写

- **三个贡献点**：`command`、`view`（right/left/bottom）、`settings` 均通过 `ModuleContributionSchema` 的严格 `discriminatedUnion("slot")` 解析；保留既有 `files.context`。未知属性拒绝，命令 ID 必须满足任务书正则；图标复用 `@contracts/customUi` 的 `CUSTOM_UI_ICONS`，实际开放 23 个宿主已知图标，无 SVG/URL 自注入。
- **耗时主要在 UI 接线**：命令须合进既有 Cmd/Ctrl+K 的统一命令组，并在名称附模块标题/命令 ID 与内置命令区分；视图分散于 `RightPanel`、工作区左栏及 `ThreePaneLayout` 底部，分别保留原页面生命周期。三个位置的声明字段适合轻量状态/统计/信息查看，复杂可交互布局或任意 HTML 应复用既有 `customUi` 沙箱（不在本卡引入）。
- **视图执行**：打开时以宿主 `ModuleHost.invoke` 执行，刷新按钮重试；`task` 类型轮询宿主 task 快照，不构造 HTML。继续遵守既有权限边界：宿主要求已打开工作区内真实普通文件，因此无活动文件时只显示提示，不伪造资源或改授权。
- **扩展设置**：统一 `设置 → 扩展 → 扩展设置` 入口，按扩展/贡献组装四种控件（string、number、boolean、enum），在滚动列表中逐组展示；值通过 `extensionStore.get/set`，以实际 moduleId 隔离，不写核心 `setting.set`。扩展多时列表可能较长，折叠/搜索留给独立优化卡。
- **验收证据**：`node apps/desktop/scripts/module-contributions-smoke/build.mjs` 10/10 PASS（严格契约、真实宿主命令/视图调用、存储目标与界面接线）；`node apps/desktop/scripts/module-contributions-smoke/ui-build.mjs` 5/5 PASS（真实浏览器命令面板执行、三个位置渲染/刷新、设置真实写入扩展存储）；`--mutate-slot` 与 `--mutate-settings` 均返回非零、命中要求的红例。已有 `module-ui-smoke`、`module-workflow-smoke`、`module-catalog-ui-smoke` 等回归通过。
- **仍未满足**：判据 5：完整 `module-*` 复跑最终尚余 `module-phase2-e2e-smoke` 失败；其 `native-window.log` 是工作流原生界面等待 `[role=button][title="File inspection"]` 超时，其他阶段均通过。判据 6：`contracts tsc` 通过，`desktop tsc` 当前报另一并发任务新文件 `apps/desktop/scripts/extension-authoring-smoke/main.ts:57` 的 `string | undefined` 类型错误；本卡触及的类型错误已排除。上述两项不擅自跨卡修改。
