# T47｜Node-RED 编辑器主题：让它的风格与 Mcode 一致

| 项目 | 值 |
|---|---|
| 编号 | T47 |
| 类型 | **ARC-006**（用户：node red 的风格可能不对，需要调整） |
| 优先级 | **高** —— 用户点名要的视觉调整 |
| 建议并发 | 改 `resources/` + `registry.ts` 的 BOOTSTRAP；**与 T45 改同一批 UI，建议串行** |
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

## 前置条件（不满足就不要开工）

- **必须等 T42 提交**。两者都改 `workflowEngines/registry.ts` 的 `BOOTSTRAP`
  字符串常量；同时做会互相覆盖。
- 开工前先 `git log --oneline -3 -- apps/desktop/src/main/workflowEngines/registry.ts`，
  确认 T42 的 `nodesDir` 已经在里面。不在就**停**，在回写区写「阻塞：等待 T42」。

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

### 2026-10-21 T47 实施与验收记录

**范围与证据**：开工 HEAD 67157d5d5edd028618e7180bc803724d0317dde5；执行期间其它任务的提交持续推进 HEAD，本轮只提交 T47 文件。未改 node-red 原厂源码、原生节点色、画布网格、document 或 WorkflowBoardPanel。

**来源与变量（E1/E2）**：读取 apps/desktop/src/renderer/styles.css 和 CDS 原始色阶。原厂 colors.scss 有 238 个 SCSS 声明；有直接或同视觉角色映射的为 20 个，剩下 218 个沿用原厂对应浅色设置或原厂 dark-colors.scss 暗色对应值。亮/暗色值以下表为准。宿主目前没有任务卡所列的 --surface-raised、--text-primary/secondary/tertiary 或 --edge-panel 独立 token，分别用实际存在的 --surface/--surface-muted、--content/--content-muted/--content-subtle 和 --panel-edge 对齐，不虚构宿主 token。

| Node-RED SCSS | Mcode token / 映射依据 |
|---|---|
| $primary-background | --surface：#fcfcfb / #151515 |
| $secondary-background | 高层表面，亮 #ffffff / 暗 #20201f（--surface-muted 近似；无 --surface-raised） |
| $secondary-background-selected | --surface-hover：#f0efec / #2c2c2a |
| $secondary-background-hover | --surface-hover：#f0efec / #2c2c2a |
| $tertiary-background | --surface-muted：#f9f9f7 / #20201f |
| $primary-text-color | --content：#151515 / #f9f9f7 |
| $secondary-text-color | --content-muted：#52514e / #b4b3a8 |
| $tertiary-text-color | --content-subtle：#6d6b67 / #97958d |
| $header-text-color | --content：#151515 / #f9f9f7 |
| $text-color-error | --danger：#dc2626 / #f87171 |
| $text-color-warning | --warning：#b45309 / #fbbf24 |
| $text-color-success | --success：#047857 / #10b981 |
| $text-color-link | --accent：#c25124 / #ec835a |
| $shadow | --shadow-popover 语义近似：rgba(0,0,0,.12) / rgba(0,0,0,.35)，不是复制完整多层 box-shadow |
| $primary-border-color | --edge：#c3c2b7 / #2c2c2a |
| $secondary-border-color | --panel-edge：#d2d1c7 / #2c2c2a |
| $tertiary-border-color | --input-edge：#b4b3a8 / #383835 |
| $form-input-focus-color | --accent：#c25124 / #ec835a |
| $primary-font | 与 styles.css 一致：-apple-system, BlinkMacSystemFont, Segoe UI, system-ui, PingFang SC, Microsoft YaHei UI, Microsoft YaHei, sans-serif |
| $primary-font-size | --chat-font-size 默认 14px；Node-RED 独立页面不动态继承用户在宿主所设的字号 |

**不映射的 218 项（E2）**：原厂 Node-RED 独有的节点分类色/节点状态、画布网格、节点连线和分组、调试/差异语义、语法高亮、用户头像及第三方品牌色在自身浅暗原厂定义中继续保留；不把其含义强行改成 Mcode token。明暗主题专项断言比较原厂与拷贝的 $palette-*、$node-*、$view-grid-color、$github-*，均通过。

**主题生成与大小（E1）**：通过 node apps/desktop/resources/node-red/build-theme.mjs 调用官方 build-custom-theme.js 生成、去掉不确定时间戳以可复现。浅色 mcode-theme-light.css：10,759 B；深色 mcode-theme-dark.css：10,900 B；媒体查询合并 mcode-theme-auto.css：21,878 B（十进制字节）。源 SCSS 和三个 CSS 均在 apps/desktop/resources/node-red 进仓。

**注入与切换（E2 + 静态 E1）**：registry.ts BOOTSTRAP 在 RED.init 中只增加 editorTheme.page.css，值读 MCODE_ENGINE_THEME_CSS；启动规格通过宿主注入固定的主题资源绝对路径，缺失时报错而不默默使用默认主题。bootstrapManifest.ts 版本 1→2；electron-builder.yml 通过 extraResources 把 CSS 放到 resources/node-red/mcode-theme。仅注入一份 mcode-theme-auto.css，其 :root 和 @media (prefers-color-scheme: dark) 定义亮/暗 CSS 变量；Electron 的 nativeTheme.themeSource 变化会让 Chromium 媒体查询动态重新计算，理论上切色无需重启 Node-RED 引擎，flow 不被中断。真实 Electron 页面运行时换色的 U1 截图未获得，不能声称已完成该视觉旅程。

**字体/视觉边界（E2/E3）**：Node-RED 原厂界面使用 --red-ui-* 色彩变量，因此画布背景、调色板、侧栏及文本能适用本主题；常见按钮圆角 6px、菜单/侧栏容器圆角 8px。节点自身颜色、SVG 画布网格及第三方内联或独立 CSS 不应强制覆盖。字体族已一致，但窄面板是否因字体替换造成溢出/换行仍缺真实 Electron 截图证据。

**实测（E1）**：
- node apps/desktop/scripts/run-smokes.mjs node-red-theme-smoke engine-bootstrap-integrity-smoke ：2 PASS / 0 FAIL。
- node-red-theme-smoke 覆盖亮暗 token、20 项映射、238 变量声明、原厂节点/网格不变、媒体查询、主题路径注入、版本与安装配置；在单独复制文件中去掉 editorTheme.page.css，该套特定视觉接线断言变红；正常源码恢复绿，未更改共享业务源码。
- node-red-e2e-smoke 第一轮真引擎 103/104，唯一 FAIL 为旧测试的 spawn 环境白名单不认识 MCODE_ENGINE_THEME_CSS；已修订预期并追加真 CSS URL 断言。第二轮并行工作树的新增原生 sherpa-onnx-*.node 引起 esbuild 无 loader；临时外置原生插件仍被并行改动的 genofficeSheetsEntry / genofficeSlidesEntry 无法解析与 html2docx 构建错误拦住，因此**修订后的真引擎套件仍未绿**。
- workflow-engine-runtime-smoke 第一轮绿，后因相同并行构建错误重跑未绿。其它 bootstrap-* 关联套件未穷举完成，不能称既有套件全部通过。
- npx tsc --noEmit -p packages/contracts/tsconfig.json 及 -p apps/desktop/tsconfig.json 运行时均在 TypeScript 5.7.2 内部 getModifierFlagsWorker 崩溃：Cannot read properties of undefined (reading 'kind')。双包 tsc 未通过。

**逐条验收结论**：1 CSS 变量断言通过（无 U1 截图）；2 深色变量断言通过（无 U1 截图）；3 20 项明晰映射通过；4 节点/网格原厂保留断言通过；5 理论和静态媒体断言完成，**真实换色未动态验证**；6 **未达成**（现有 e2e/runtime 及所有 bootstrap-* 未全绿）；7 **未达成**（两包 tsc 崩溃）；8 变异红绿通过。
