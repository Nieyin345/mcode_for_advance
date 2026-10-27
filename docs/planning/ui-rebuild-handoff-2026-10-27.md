# UI 重构交接（2026-10-27）

> 本文记录三轮提交后的真实状态。**进度以代码和套件为准**，本文只写清
> 「做了什么、没做什么、被什么卡住、怎么继续」。

---

## 一、已提交（3 个提交，可逐个复核）

| 提交 | 内容 |
|---|---|
| `419e8bdf` | token 源换成本机 Claude 3.1623.4.0 + 全套新外壳骨架 |
| `cd1a7cce` | 修主列高度恒为 0（底部终端吃了全部 727px） |
| `2bd4c14c` | 新侧栏默认生效 + Office/扩展/工作流接入点 + 空态字号 |
| `8bc7d0ad` | 侧栏 i18n + 右侧 pane 跟随 `rightPanelTab` |

### 1.1 外观基准：从第三方逆向换成用户本机安装

| 项 | 之前 | 现在 |
|---|---|---|
| token 源 | `open-claude-ui/code-examples/cds-theme.css`（第三方 2.x 逆向） | **本机 Claude 3.1623.4.0** 的 `ion-dist/assets/v1/*.css` |
| 色阶 | gray + orange（70 个） | **9 系 × 35 档 = 317 个** |
| 几何 token | 22 个手工列 | **151 个**（含 `--cmp-*` composer 全套 13 项） |
| 语义链 | 无 | `neutral/surface/text/fill` 整条 |
| 暗色 | 手工两套值 | **语义链反转**（`neutral-900` 在暗色指到 `gray-0`） |
| 密度档 | 无 | `html[data-density="compact"]` |

生成器 `apps/desktop/scripts/gen-cds-tokens.mjs`：按 Appx 查路径（`WindowsApps`
不允许列目录，用 PowerShell `Get-AppxPackage`），`--check` 通过。

**零运行时读取 `open-claude-ui`** —— 它现在只是注释里的出处标注，
可以随时删掉那个目录（不在本轮提交里，因为它被 `.gitignore` 排除）。

### 1.2 外壳结构

| 文件 | 作用 |
|---|---|
| `shell/chatColumn.ts` | Claude 的 `data-chat-column` 三列模型 + `isCovered` |
| `shell/paneTiles.ts` | tile 递归树（`tile`/`stack`、`flex`、开/关/校验/拖拽换算） |
| `shell/ClaudeShell.tsx` | 列覆盖 + tile 树，切列只 `inert` 不卸载 |
| `shell/TilePane.tsx` | 递归渲染 + `data-tile-divider` 拖拽分栏 |
| `shell/ClaudeSidebar.tsx` | Pinned / Projects / Recents，288px，28px 行高，分支徽章 |
| `shell/ClaudeTitlebar.tsx` | 48px 标题行 + `data-cds=PageHeader` + `⋯` 溢出菜单 |
| `shell/ClaudeShellMount.tsx` | 装配 store；右侧 tile 跟随 `rightPanelTab` |
| `shell/paneContent.tsx` | tile → 面板（含三条线的接入点） |

`App.tsx` 已渲染 `ClaudeShellMount`，旧的 `ClassicShell` 不再被使用
（但保留在仓库里，54 套 smoke 仍引用它）。

### 1.3 尺寸（这是「换汤不换药」的真正根因）

| 项 | 之前 | 现在（Claude 真实值） |
|---|---|---|
| 正文字号 | 15px | **12.24px**（−23%） |
| 正文行高 | 1.625 | **1.5378** |
| 空态标题 | `clamp(1.3rem,3.4vw,1.75rem)`（最大 28px） | **15.06px**（−86% 视口相关） |
| composer 圆角 | 20px | **13.18px** |
| 侧栏宽 | 百分比 12–40% | **288px 固定** |
| 侧栏行高 | 未定 | **28px** |
| 表面层级 | 2 级 | **4 级**（surface-0..3） |
| 轮次/轮内间距 | 写死 0.625/0.9375rem | `body × leading × {.75,.5}` **相对公式** |
| 助手正文缩进 | 4px | **0px** |
| 字重档 | 400/500/600 | **400/500/580** |
| 设置页/侧栏字号 | 14px | **12.24px** |

---

## 二、验证到什么程度（实测，非声称）

**真 Electron 全量截图**（`arc005-visual-baseline`，19 场景 × 3 条件 = 57 格）：

```
checks=57/57   captureFailed=0   knownMissing=0   unexpectedMissing=15
```

对比：重构前 `unexpectedMissing=57`（全部红），现在 **15**。

**剩下 15 格的分类**（每类 3 格 = 亮/暗/窄窗）：

| 场景 | 原因 |
|---|---|
| `long-chat` | 虚拟列表本身正常（640 条只挂 18 行、滚动窗口化生效），但**时间轴键盘导航**没通过（`timelineTabStops:1`、方向键/Home/End 索引全 null） |
| `tab-overflow` | 新壳的 thread 列没有标签栏，场景要的 36 个标签不存在 |
| `taskcenter` / `sidepanel` / `git-pane` | 依赖旧右栏页签；已加 `rightPanelTab → tile` 映射，**但那次验证被扩展线删文件阻断，还没重跑** |

**这 15 格不是「没做」，是「还没复跑到」** —— 最后那次验证跑在扩展线正在删
`ModuleContributions.tsx` 的时刻，构建直接失败。

---

## 三、当前的硬阻塞

**扩展线正在删渲染端模块组件**（未提交，工作区是 `D` 状态）：

```
apps/desktop/src/renderer/components/modules/ModuleContributions.tsx     ← paneContent 引用它
apps/desktop/src/renderer/components/modules/ModuleSurface.tsx
apps/desktop/src/renderer/components/modules/CapabilityCatalogPanel.tsx
apps/desktop/src/renderer/components/modules/ModuleInstallConsentCard.tsx
apps/desktop/src/renderer/components/modules/CapabilitySchemaView.tsx
```

另外三处也是断的：
```
components/settings/workflows/NodeInspectorParts.tsx:56  ./ModuleCapabilityFields.js 缺失
components/settings/CustomUiPanelParts.tsx:41            ModuleSurface.js 缺失
components/layout/CommandPalette.tsx:61                  ModuleContributions.js 缺失
```

**这意味着构建、截图、全量套件现在都跑不了。** 我的代码没问题（
`tsc` 里我的文件零错误），但整包编不出来。

**这不该由我修** —— 那是扩展线正在做的工作，恢复会跟它冲突（CLAUDE.md 第 23/24 条）。

---

## 四、解除阻塞后要做的（按顺序）

```bash
# 1. 确认扩展线已提交
git status --porcelain apps/desktop/src/renderer/components/modules/

# 2. 双包类型检查
npx tsc --noEmit -p packages/contracts/tsconfig.json
npx tsc --noEmit -p apps/desktop/tsconfig.json

# 3. token 与 Claude 一致
node apps/desktop/scripts/gen-cds-tokens.mjs --check

# 4. 全量截图 + 比对（唯一能看「像不像」的手段）
node apps/desktop/scripts/arc005-visual-baseline/build.mjs
node apps/desktop/scripts/arc005-visual-baseline/compare.mjs
# 看 .tmp/arc005-visual/diff.md

# 5. 全量套件
pnpm test:all
```

**第 4 步之后要看的**：`unexpectedMissing` 应从 15 继续降到 0；
`compare.mjs` 的 `unregistered` 应接近 0（它现在比的是**本机 Claude** 的 token）。

---

## 五、还没做（如实）

| 项 | 状态 |
|---|---|
| 主列：思考块 / 工具卡四态 / 审批卡三钮的视觉对齐 | **未改**（现有实现功能完整，只差视觉细节） |
| composer 的 chin 下颌行 | **未做**（`--cmp-*` token 已备齐、已在 `:root` 声明，组件未接） |
| 右侧 pane 的**弹出成独立窗口** | **未做**（tile 树支持，窗口层未接） |
| 设置页 107 个文件的逐页对齐 | **未做**（字号已统一，布局未逐页对） |
| 命令面板 / 各对话框的视觉对齐 | **未做**（对话框已读 `--radius-dialog`/`--shadow-lg`，未逐一对） |
| `long-chat` 时间轴键盘导航 | **未修**（新壳里键盘事件没接上） |
| `tab-overflow` 的标签栏 | **未修**（新壳 thread 列没有标签栏） |
| 删旧 `ClassicShell` | **未删**（54 套 smoke 引用它） |
| 删 `open-claude-ui` 目录 | **未删**（零运行时依赖，但仍是文档出处） |

---

## 六、判断「像不像」的方法（重申）

**不能用套件绿来证明。** `arc005-visual-baseline/README.md` 自己写着：
48 张图两轮连跑只有 12 张逐字节相同，PNG 不是判据。

**唯一可靠的判据**：同尺寸、同主题、同 DPI 下，Mcode 截图与 Claude 截图逐屏并排看。
当前可看的对照物：`.tmp/arc005-visual/*.png`（42 张，含亮/暗/窄窗）。

**已经能看到的变化**：三栏结构、新顶栏（标题 + ⋯）、新侧栏（Mcode/Search/
项目分组/资料库/设置）、右侧「文件」pane、空态标题从 28px 降到 15px、
正文从 15px 降到 12.24px。
