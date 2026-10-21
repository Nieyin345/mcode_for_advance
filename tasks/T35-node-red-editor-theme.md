# T35｜Node-RED 编辑器主题：让它的风格与 Mcode 一致

| 项目 | 值 |
|---|---|
| 编号 | T35 |
| 类型 | **ARC-006**（用户：node red 的风格可能不对，需要调整） |
| 优先级 | **高** —— 用户点名要的视觉调整 |
| 建议并发 | 改 `resources/` + `registry.ts` 的 BOOTSTRAP；**与 T33 改同一批 UI，建议串行** |
| 预计规模 | 中 |

---

## 用户要求

> 「node red 的风格可能不对，需要调整」

Node-RED 的编辑器是原厂的：灰色系、14px 字体、圆角小、间距密。
Mcode 是 Claude 桌面端风格：暖灰、圆角更大、间距更松。

**目标：让用户觉得「这是同一个应用」，不是「里面嵌了一个 Node-RED」。**

---

## 关键：Node-RED 官方支持定制主题

`node-red/scripts/build-custom-theme.js` 头部注释就是官方说明：

```
1. Create a copy of packages/node_modules/@node-red/editor-client/src/sass/colors.scss
   and change the values to the desired colours.
2. Run this script, providing the path to the custom file using the --in option
3. Save the output of the script to a file - either redirect its output,
   or use the --out option.
4. Edit your settings file to set the theme:
      editorTheme: { page: { css: '/path/to/file/generated/by/this/script' } }
5. Restart Node-RED
```

**所以改风格不需要动上游任何一行 SCSS。**

---

## 实读事实

| 项 | 数据 |
|---|---|
| `colors.scss` 变量数 | **238** |
| SCSS 文件总数 | 41 |
| 深色主题 | `dark-colors.scss` 单独一份 |
| 尺寸变量 | `sizes.scss` |
| 构建脚本 | `node-red/scripts/build-custom-theme.js`（约 100 行，用 sass 编译） |

`colors.scss` 的结构（实读前 60 行）：
- 字体：`$primary-font` / `$primary-font-size` / `$monospace-font`
- 背景：`$primary-background` / `$secondary-background`（+ selected/inactive/hover/disabled 变体）
- 文字：`$primary-text-color` / `$secondary-text-color`（+ 6 个状态变体）/ `$tertiary-text-color` / `$header-text-color`
- 语义：`$text-color-error` / `-warning` / `-success` / `-code` / `-link`
- `$shadow`

---

## 开工前必读

1. `audit-ledgers/README.md`。
2. `node-red/scripts/build-custom-theme.js` **全文**。
3. `node-red/packages/node_modules/@node-red/editor-client/src/sass/colors.scss`
   **全文 325 行** —— 这是要复制的模板。
4. `node-red/packages/node_modules/@node-red/editor-client/src/sass/dark-colors.scss`
   —— 深色版。
5. `node-red/packages/node_modules/@node-red/editor-client/src/sass/sizes.scss`。
6. `apps/desktop/src/renderer/styles.css` 的 token 定义段。
7. `open-claude-ui/code-examples/cds-theme.css` —— CDS 的 35 步灰阶 + orange 色阶。
8. `apps/desktop/src/main/workflowEngines/registry.ts:85-260` 的 `BOOTSTRAP`。
9. `apps/desktop/src/main/workflowEngines/bootstrapManifest.ts` —— 改 `BOOTSTRAP`
   必须 +1 version。

---

## 执行内容

### 第 1 步：提取 Mcode 的 token 值

从 `styles.css` 取实际值（不是估计）：

**背景层级**
- `--surface`（主背景）
- `--surface-muted`（次级）
- `--surface-hover`
- `--surface-raised`

**文字层级**
- `--text-primary`
- `--text-secondary`
- `--text-tertiary`

**边线与阴影**
- `--edge` / `--edge-panel`
- `--shadow-popover` / `--shadow-lg`

**语义色**
- `--danger` / `--warning` / `--success` / `--info`
- `--accent`

**字体与尺寸**
- 正文字体族与字号（`--chat-fs-*` 那几个）
- `--radius-*`

### 第 2 步：写 `mcode-colors.scss`

复制 `colors.scss`，**只改有对应关系的项**。

**必须映射的 12 个**（其余保留原厂）：

| Node-RED 变量 | Mcode token |
|---|---|
| `$primary-background` | `--surface` |
| `$secondary-background` | `--surface-raised` |
| `$secondary-background-selected` | `--surface-hover` |
| `$secondary-background-hover` | `--surface-hover` |
| `$tertiary-background` | `--surface-muted` |
| `$primary-text-color` | `--text-primary` |
| `$secondary-text-color` | `--text-secondary` |
| `$tertiary-text-color` | `--text-tertiary` |
| `$header-text-color` | `--text-primary` |
| `$text-color-error` | `--danger` |
| `$text-color-warning` | `--warning` |
| `$text-color-success` | `--success` |
| `$text-color-link` | `--accent`（或 `--info`） |
| `$shadow` | `--shadow-popover` 里的色值 |
| `$primary-font` | Mcode 的正文族 |
| `$primary-font-size` | Mcode 正文字号 |

**不要改**：
- 节点分类色（`$palette-*` 之类）—— 那是 Node-RED 的节点语义
- `$github-*` 等第三方品牌色
- 画布网格色（除非明显冲突）

**对不上的项**在回写区列表说明。

### 第 3 步：生成两份主题并入库

```bash
node node-red/scripts/build-custom-theme.js \
  --in apps/desktop/resources/node-red/mcode-colors-light.scss \
  --out apps/desktop/resources/node-red/mcode-theme-light.css

node node-red/scripts/build-custom-theme.js \
  --in apps/desktop/resources/node-red/mcode-colors-dark.scss \
  --out apps/desktop/resources/node-red/mcode-theme-dark.css
```

**SCSS 源与 CSS 产物都进仓库**（`apps/desktop/resources/node-red/`）——
产物可复现，源可审查。

### 第 4 步：挂进 BOOTSTRAP

```js
// registry.ts 的 BOOTSTRAP 里
RED.init(server, {
  // ... 现有
  editorTheme: {
    page: { css: process.env.MCODE_ENGINE_THEME_CSS || "" },
  },
});
```

**主题路径由宿主注入**（env），不硬编码 —— 照 `MCODE_ENGINE_ADMIN_TOKEN` 的做法。

**改动 `BOOTSTRAP` 必须 +1 `version`**（`bootstrapManifest.ts` 头注写死）。

`createEngineLaunchSpec` 里加这个 env。

### 第 5 步：深浅色切换

**要验证的关键问题**：切主题必须重启引擎吗？

- 如果**必须重启**：用户切深浅色时，正在跑的 flow 会中断。这是不可接受的。
  → 需要用 CSS 变量的方式，运行时切换（Node-RED 的 `editorTheme.page.css`
  是静态挂载的，可能做不到）。
- 如果**能运行时切**：找它怎么做的。

**这是本卡最需要实测的一点。** 如果必须重启，正确做法是：
- 只生成一份主题，用 CSS 媒体查询 `prefers-color-scheme` 内部分支；
- 或者接受「切主题需要重启引擎」，但**在启动时就按当前主题选好**，
  并告诉用户「切换主题后需要重启工作流引擎」。

### 第 6 步：视觉验收

**不要追求像素级一致。** Node-RED 的编辑器（画布、调色板、侧栏）有自己的
交互密度，强行对齐会破坏可用性。

判据是：
- 背景、文字、边线**没有明显色差**（不与 Mcode 其它面板对比出「另一个应用」的感觉）
- 字体族一致
- 圆角不要明显更小（Node-RED 默认是 2–3px，Mcode 是 6–8px）

---

## 边界（不要碰）

- **不改 `node-red/` 上游源码**。主题是外挂 CSS，不是改 SCSS 源。
- 不改节点分类色 / 画布网格色 / 第三方品牌色。
- 不改 `document/`（T28/T29）。
- 不改 `WorkflowBoardPanel`。
- **不改 `BOOTSTRAP` 里认证 / safeMode / 部署握手**（只加 `editorTheme`）。

---

## 验收判据

1. 编辑器背景、文字、边线与 Mcode 其它面板一致（截图或 CSS 变量断言）。
2. 深色模式正确。
3. 至少 12 个核心变量有明确映射（有对照表）。
4. 节点分类色、画布网格保持原厂（有断言或说明）。
5. 切换深浅色后编辑器外观正确（运行时切换或重启后切换，二选一，说清楚）。
6. 现有 `node-red-e2e-smoke` / `workflow-engine-runtime-smoke` / `bootstrap-*` 全绿。
7. 双包 tsc 干净。
8. **变异验证**：撤掉 `editorTheme.page.css` → 判据 1 红（回默认色）。

---

## 回写区要回答

- 238 个变量里，有多少个与 Mcode token 有明确对应？多少个对不上？取什么近似值？
- 主题切换要不要重启引擎？如果必须，用户怎么办？
- `build-custom-theme.js` 的产物有多大？
- 字体换了之后，Node-RED 编辑器的布局有没有溢出/换行问题？
- 有没有哪个区域（画布、调色板、侧栏）的样式改不动，为什么？

---

## 结果回写区

<!-- 执行对话：在下面追加，不要覆盖。 -->
