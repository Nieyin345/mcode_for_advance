# Claude Code 参考矩阵（逐屏 × 浅色/深色/窄窗）—— Mcode ARC-005 V0

> **这份文档是什么**：ARC-005「V0 基准冻结」的交付物之一。它把要对照的屏幕/状态、
> 每屏在浅色/深色/窄窗三种条件下的 Mcode 实现证据（组件文件:行）、token 对照和待测项
> 一次列清。台账要求「无法从合法样本确认的值标『待测』，不得猜写成官方值」。
>
> **它不是什么**：写完本矩阵**不等于 ARC-005 完成**。真实截图逐屏对照（V4）尚未做；
> ARC-005 的「开发完成 / 独立复核」仍双空。
>
> **Claude 侧参考来源**：**用户安装版本截图待采集**（唯一最终基准）。本文件**不写**
> 任何 Claude 侧的具体色值/字号/间距，除非有可复核的字节证据（仅 §三/§四/§五 标注
> 为「上游 E1」的 `open-claude-ui` 令牌，且它是 REA 逆向结论，**不等于**用户本机
> Claude Desktop 的实测值）。
>
> **行号口径**：Mcode 侧文件:行按 2026-10-18 HEAD `586cff17` 核对。

## 〇、来源分级与判定词

| 档位 | 含义 | 当前有哪些 |
|---|---|---|
| **E1 取证** | 有可复核的字节/代码依据 | CDS 色阶与几何（`open-claude-ui/code-examples/cds-theme.css`，MIT，REA 逆向产物，**目录被 `.gitignore:72` 排除、需本地检出**）；Mcode 生成物 `tokens.cds.css` 由 `gen-cds-tokens.mjs --check` 钉住（`apps/desktop/scripts/gen-cds-tokens.mjs`） |
| **E2 推导** | 从取证值或平台事实推导 | 语义层映射（`--surface` → `--m-gray-*`）；圆角/阴影别名；动效时长档位 |
| **D 设计决策** | 用户明确要求或产品取舍 | 「会话优先」壳的目标形态；品牌色是否换陶土橙 |
| **待测** | 没有合法样本可核 | Claude 实际安装版本的字体族/字重、精确行高、窗口顶栏高度、设置页布局、窄窗断点、动效曲线在实际版本中的观感 |

**矩阵判定词**（每格第一行）：

- `已实现` —— Mcode 侧有对应实现且能在源码定位；**与 Claude 参考是否一致仍待 V4 截图**，`已实现` 不表示「像」。
- `未实现` —— 源码可证明缺口（附差距）。
- `待测` —— 无法从源码确认（多为 Claude 侧行为/阈值未知），必须真机对照；写明需要什么证据。

## 一、逐屏参考矩阵（13 行 × 浅色/深色/窄窗）

> 参考列（Claude 侧）一律「用户安装版本截图待采集」。本表回答的是 **Mcode 侧现在有什么、
> 缺什么、哪一格只能靠真机**。「窄窗」列指窗口/面板变窄时的行为，不是主题。

| 屏幕/状态 | 浅色 | 深色 | 窄窗 |
|---|---|---|---|
| **初始空会话** | 已实现 — `chat/EmptyThreadWelcome.tsx:68`（四块起点：接着聊/工作流/资料/自动化，空的块不画）+ `chat/ChatPane.tsx:3156-3158`（空态贴底、`max-w-4xl`）；全走语义 token，无硬编码色 | 已实现 — 同一组件读 `--content-*`/`--surface` 语义层（`styles.css:111-119,238-243`）；深色对比度观感待截图 | 已实现 — 起点卡片 `grid auto-fit` 窄栏自动一列、高度 ≤640px 整块隐藏（`EmptyThreadWelcome.tsx:136-139`）；Claude 窄窗阈值待测 |
| **已有消息** | 已实现 — `chat/MessageTimeline.tsx:115`、`chat/MessageRow.tsx:150`；正文阅读宽 `--chat-max-w` 默认 64rem（`ChatPane.tsx:2627`，`lib/uiPrefs.ts:35-40` 四档），用户气泡 `max-w-[85%]`（`MessageRow.tsx:299`） | 已实现 — 用户气泡 fill 按主题换 alpha（`styles.css:816-818`；alpha 0.9/0.55 见 `:205,282`）；深色正文基准字重 500（`:274`） | 已实现 — 侧沟按聊天面板自身宽度走 container query：<28rem 20px、28–44rem 48px、44–64rem 80px、≥64rem 128px（`styles.css:1459-1499`）；Claude 侧正文宽度规则待测 |
| **工具运行中/完成/失败** | 已实现 — `chat/MessageBlocks.tsx:579`（`StatusIcon`：运行中旋转弧→完成对勾交叉淡入，历史回合不画勾，仅 error 常驻红叉）、`:394` 聚合状态；`chat/CurrentOpTicker.tsx:69`、`chat/ActivityCluster.tsx:48`、`chat/ActivityConsole.tsx:704` | 已实现 — 状态色走 `--danger`/`--accent` 语义 token，无主题分叉；运行中扫光/对勾的观感待截图 | 待测 — 活动簇文字横条上限 280px（`styles.css:1348-1366`），无窄窗专用重排；Claude 窄栏折叠规则未知（需截图） |
| **权限审批** | 已实现 — `chat/ApprovalPrompt.tsx:44`（`role="alertdialog"`、自动聚焦「允许」、队列位置）；就地渲染在输入框上方（`ChatPane.tsx:3196`），计划审批 `:3165`，AskUserQuestion `:3223`。**差距**：允许键 auto-focus + Enter 即确认，未做「初始 disabled 防回车」输入保护（逆向报告 §4.2 建议项） | 已实现 — 卡片 `bg-surface`/`border-edge-input`/`shadow-2xl` 语义 token；深色对比观感待截图 | 待测 — 卡片无宽度断点；Claude 审批卡在窄窗的形态待截图 |
| **代码/文件 Diff** | 已实现 — 消息内 `chat/DiffView.tsx:16`（双行号 + `+`/`−`）；编辑器 Monaco side-by-side（`ide/FileEditor.tsx:2447`）；全屏 `ide/GitDiffDialog.tsx:44`。**差距**：增删色是硬编码 Tailwind（`DiffView.tsx:49-53`：`bg-red-500/15 text-red-600 dark:text-red-400` / green 同构），**无 `--diff-*` token** | 已实现（硬编码深色变体）— `dark:text-red-400`/`dark:text-green-400` 写死，不随主题 token 体系走；与参考观感对照待截图 | 待测 — Monaco 强制 side-by-side（`FileEditor.tsx:2452` `useInlineViewWhenSpaceIsLimited:false`），窄栏下双栏会挤；Claude 窄栏是否转 inline 未知 |
| **侧聊** | 已实现 — `chat/SideChatPanel.tsx:39`；挂载在右栏「工作流运行」面板下半部（`chat/WorkflowBoardPanel.tsx:461`）；入口 `openSideChatPanel` → 右栏 `flow` 标签（`stores/sessionStore.ts:6384-6392`） | 已实现 — 面板读语义 token；深色观感待截图 | 待测 — 右栏最小宽 240px（`stores/sessionStoreHelpers.ts:541`）；Claude 侧聊在窄窗的呈现待截图 |
| **终端** | 已实现 — `layout/BottomTerminalBar.tsx:18`（keep-alive：塌高不卸载，PTY/scrollback 保活）+ `ide/TerminalPanel.tsx:79`（按项目 path 分桶，切项目不杀 PTY）+ `ide/TerminalView.tsx:125`（xterm） | 已实现（**主题未迁移**）— `buildTheme()`（`TerminalView.tsx:36`）是两套硬编码 hex 调色板，不读 `styles.css` 语义 token（44 处色值）；「顶栏与边框视觉未迁移」的差距在此坐实 | 待测 — 终端铺满中栏宽度；Claude 终端在窄窗的行为待截图 |
| **文件编辑** | 已实现 — `ide/FileEditor.tsx:91`（Monaco）+ `ide/OpenTabsBar.tsx:85`（标签）+ `ide/FileTree.tsx:493`（树）；编辑器主题预设 `lib/editorThemes.ts` | 已实现 — 跟随 `<html>.dark`（`FileEditor.tsx:1354` 注释；`editorThemes.ts` 每模式一套预设） | 待测 — 编辑器分栏宽度 clamp 20–80%（`sessionStoreHelpers.ts:550-551`）；Claude 窄窗编辑器行为待截图 |
| **预览** | 已实现（**HTML 未实现**）— PDF `FileEditor.tsx:1877`（`PdfPreviewPane`→`library/PdfPreviewImpl.tsx`）、图片 `:1940`、Markdown `:1779`；**`.html` 没有内嵌预览**，只在文件树右键「在浏览器中打开」（`FileTree.tsx:1425-1426`） | 已实现 — PDF/图片/Markdown pane 读语义 token；HTML 预览走主进程 WebContentsView（无主题概念）。深色观感待截图 | 待测 — PDF 按容器宽 `page-width`；Claude 预览面板窄窗布局待截图 |
| **并行会话侧栏** | 已实现 — 两种侧栏：树形 `layout/LeftBar.tsx:103,1300`、流式 `layout/StreamSidebar.tsx:966`（状态 working/input/failed/done，`:127-135`，切换在 `LeftBarModeSwitch` `:89`）；会话标签 `layout/SessionTabs.tsx:47` / `layout/UnifiedTabsBar.tsx:56`（按 `displayMode` 二选一，`shell/ClassicShell.tsx:166-173`） | 已实现 — 行/卡片读语义 token；深色观感待截图 | 未实现 — 左栏宽度 clamp 12–40%（`sessionStoreHelpers.ts:538-539`），**无视口宽度驱动的自动折叠**；Claude 折叠阈值待截图 |
| **项目切换** | 已实现 — 「项目」段折叠开关（`LeftBar.tsx:133`）+ 项目行展开（`:290,567`）；会话目录 chip（`chat/SessionDirectoryChip.tsx:33`）与项目菜单（`layout/ProjectManageMenu.tsx:47`） | 已实现 — 读语义 token | 待测 — 无项目切换专用窄窗形态；Claude 在窄窗的入口位置待截图 |
| **设置菜单** | 已实现 — `settings/SettingsPage.tsx:276`（5 组导航 `:189-260`）；全窗覆盖层 `App.tsx:68-104`；标题栏 settings 模式 `layout/Titlebar.tsx:64`；导航宽 240px（`SettingsPage.tsx:187`）；入口在左栏底部（`LeftBar.tsx:1018`）；命令面板 `layout/CommandPalette.tsx:158`（挂载 `App.tsx:296`） | 已实现 — 设置区专用 muted/subtle 提亮（`styles.css:315-318`） | 待测 — 导航固定 240px、无折叠；Claude 设置页信息架构与窄窗行为待截图（台账要求按「常用/引擎/文档/扩展/系统」重组，未做） |
| **窗口缩窄** | 未实现（该状态按宽度定义，与主题无关）— 外壳无视口断点；最小窗 1024×640（`apps/desktop/src/main/window.ts:137-138`） | 未实现（同上）— 无主题相关行为 | 未实现 — `components/shell`、`components/layout` 内 0 处 `sm:`/`md:`/`lg:` 视口断点（2026-10-18 grep；全渲染端仅 7 处，散见于设置/监控/记忆面板，不影响外壳）；仅聊天侧沟有 container query（`styles.css:1459-1499`）与空态高度规则；Claude 断点阈值待截图 |

**矩阵覆盖**：13 行 × 3 列 = 39 格，全部有判定与证据/差距。`已实现` 只代表 Mcode 有实现，
不代表与参考一致——一致性全部留待 V4 真机截图。

## 二、token 对照表（Mcode `styles.css`/生成物 vs 逆向报告）

> 「报告值」优先取 `docs/design/claude-desktop-ui-细节逆向.md`（REA 对 Claude 2.31226.1.0
> 的静态读数）；报告未逐项给出的，取报告所引「上游 E1」`open-claude-ui/code-examples/cds-theme.css`
> 并明确标注。**两者都不等于用户本机实测。**

| 家族 | Mcode 现状（文件:行） | 逆向报告/上游 E1 值 | 判定 |
|---|---|---|---|
| `--surface-*` | `--surface`=gray-10 `#fcfcfb`、`--surface-muted`=gray-20 `#f9f9f7`、`--surface-hover`=gray-50 `#f0efec`（`styles.css:111-113`）；暗色 `gray-850 #151515` / `gray-800 #20201f` / `gray-750 #2c2c2a`（`:238-240`） | 报告 §1.1 只给亮色：surface-0 `#f9f9f7`、surface-1 `#fcfcfb`、surface-2 `#fff`；暗色只说「指向灰阶另一端」未给值。上游 E1 暗色：surface-0 `#0b0b0b`、surface-1 `#151515`、surface-2 `#1a1a19`、surface-3 `#20201f` | 亮色对齐（muted↔0、surface↔1）；**缺** surface-2/3/popover 角色档；暗色**不一致（Mcode 侧栏 `--surface-muted`=`#20201f`，上游 surface-0=`#0b0b0b`）**；`--surface-hover` 为实色，上游为 alpha-1 合成（近似，结构不同） |
| `--text-*` | **家族名缺**（Mcode 等价实现是 `--content` / `--content-muted` / `--content-subtle`，`styles.css:117-119,241-243`） | 报告正文未给 text 色值；上游 E1 亮色 primary `#151515` / secondary `#525252` / muted `#8a8a8a`，暗色 `#f5f5f5` / `#a3a3a3` / `#666666` | 亮色 primary 一致；**不一致（Mcode content-muted=`#52514e`, 上游=`#525252`；content-subtle=`#6d6b67`, 上游=`#8a8a8a`）**；暗色 **不一致（Mcode `#f9f9f7`/`#b4b3a8`/`#97958d`, 上游 `#f5f5f5`/`#a3a3a3`/`#666666`）**（Mcode 为 AA 刻意加深，见 `styles.css:114-119`） |
| `--border-*` | **家族名缺**；等价 `--edge`=`gray-200 #c3c2b7` 实色、`--panel-edge`=`gray-150`、`--input-edge`=`gray-250`（`styles.css:124-135`） | 报告/上游：`--cds-border`=alpha-2 = `hsla(0,0%,8%,.10)`（亮）/ `hsla(0,0%,100%,.09)`（暗） | **不一致（Mcode `--edge`=`#c3c2b7` 实色，上游=10% alpha；合成到 `#fcfcfb` 上约 `#e5e4e4`）**；Mcode 刻意加深一档以让分隔线可读（`styles.css:120-129` 注释） |
| `--accent-*` | `--accent: 5 150 105`（emerald-600）、`--accent-strong: 4 120 87`；暗色 strong `16 185 129`（`styles.css:147-148,247`）；备选 `--brand-clay`=`#eb6834`（`--m-orange-350`，`:145-146`） | 报告/上游：`--cds-clay: #d97757`，`--cds-text-accent: var(--cds-clay)`、`--cds-fill-brand` | **不一致（Mcode=emerald `rgb(5 150 105)`, 报告=clay `#d97757`）** —— 产品决策 D：换 clay 会让 350 处 `text-accent`（331 处 `text-accent` + 19 处 `text-accent-strong`，2026-10-18 统计）跌破 AA |
| `--diff-*` | **缺** —— 无 `--diff-*` token；增删行硬编码 `DiffView.tsx:49-53`（red/green-600 + 暗色 400） | 报告未给出 diff 色值 | **缺 + 待测**（需用户安装版本真机取色：增删行背景/前景/行号栏） |
| `--radius-*` | `--radius-panel`=10px、`--composer-radius`=20px、`--radius-control`=`--radius-sm`=.25rem/4px、`--radius-bubble`=`calc(8px + .25rem×1)`≈12px（`styles.css:879-897`；`tokens.cds.css:83-87,102`） | 报告正文未给完整阶梯；上游 E1：panel 10px、composer 20px、message-bubble `calc(8px + .25rem × var(--cds-rem-scale))`、radius-sm 4px、radius-md 6px、radius-lg 8px、radius-xl 12px、btn-xs 6px、btn-md 8px、dialog 16px、code 12px；`--cds-rem-scale` 上游示例为 `16/17`，报告 §1.4 称真实 app 中该变量**运行时写入、文档里不声明** | panel/composer/control 一致；**不一致（Mcode 气泡=`12px`, 上游≈`11.76px`）** —— 生成器把 `--cds-rem-scale` 钉为 1（`gen-cds-tokens.mjs` 的 `VAR_MAP`）；**缺** btn-xs/btn-md/dialog/code/card 档（`GEOMETRY_KEYS` 未收）；Mcode 按钮实际用 Tailwind `rounded`=4px（`components/ui/button.tsx:21`），与上游按钮档 6/8px 不一致 |
| `--space-*` | **缺** —— 无 `--space-*` token；间距走 Tailwind 刻度 + 局部 `--chat-gutter`（`styles.css:1459-1499`）、`--chat-row-gap-*`（`:1559-1580`） | 报告 §1.3 只给机制（`--cds-pad-xs…xl` 随 `data-size` 翻转、`data-text-size` 同时改字号与行高），未给完整刻度 | **缺**；完整刻度**待测**（需真机量取；上游文档标 4/8/12/16/24px，仅作参考） |
| `--font-*` | **缺** —— 无 `--font-*` token；字体族是系统栈（`styles.css:536-542`：`-apple-system, "Segoe UI", …, "PingFang SC", "Microsoft YaHei"`）；等宽走 Tailwind `fontMono`=JetBrains Mono Variable（`tailwind.config.js:9-20`）；`--chat-font-size` 默认 14px、`--chat-fs-*` 派生（`styles.css:434-437`）；行高 `--chat-md-leading` 按密度 1.6/1.5/1.75（`:1558-1586`） | 报告 §1.3/§1.4 给字号派生公式（`--cds-font-size-body = .8125rem × scale`、`data-text-size` 档位同时改 leading），**未给字体族**；上游 E1 有 `--font-anthropic-*` 与 CJK 回退链，`--chat-leading: 1.42857` | **缺**（家族名）；字体族**待测**（专有字体合法分发未确认）；行高**不一致（Mcode 1.5–1.75 密度档, 上游 1.42857）**——来源不同，需真机校准 |
| `--dur-*` | `--dur-fast:60ms` / `snap:120ms` / `base:200ms` / `sheet:300ms` / `slow:450ms`（`styles.css:853-857`） | 报告 §2 逐项给出同一组值（60ms/.12s/.2s/.3s/.45s） | **一致** |
| `--ease-*` | `--ease-out=cubic-bezier(0,0,.2,1)`、`--ease-snap=(.32,.72,0,1)`、`--ease-overshoot=(.34,1.3,.64,1)`（`styles.css:861-863`）；另有 swift/expand/enter/pop/pulse/rise/fall 七条（`:865-871`）；真弹簧 `--spring-btn`（`:873`） | 报告 §2 给出前三条（与 Mcode **逐值一致**）与弹簧 16 采样点（与 Mcode 逐点一致） | **一致**（报告覆盖的三条 + 弹簧）；另七条报告正文未列，来源为上游 E1；**来源冲突记录**：上游 `cds-theme.css` 的 `--cds-ease-out` 是 `cubic-bezier(.165,.84,.44,1)`，与报告正文 `(0,0,.2,1)` 不同，Mcode 采用报告值 |
| 焦点环（附） | 三层 `--focus-ring`/`--focus-ring-danger`（`styles.css:902-927`）：inset 1px 背景色 + 1px accent + 6px `rgb(var(--accent)/0.18)` 光晕 | 报告 §3.6：inset 1px 页面底色 + 1px fill-accent 环 + 6px 光晕（光晕色引用 `--cds-bg-accent`，报告未给透明度；上游 E1 样本用 clay 环 1.5px + clay 25% 光晕） | 层数/形状一致；**不一致（Mcode 环=1px emerald、光晕=emerald 18%；参考环色与光晕透明度均不同）** —— 随品牌色决策联动；精确值待真机取样 |

**缺失清单（`缺`）**：`--diff-*`、`--space-*`、`--font-*`、`--text-*`（家族名）、`--border-*`（家族名）、
surface-2/3/popover 角色档、radius 的 btn-xs/btn-md/dialog/code/card 档。
**不一致清单**：surface 暗色侧栏档、content-muted/content-subtle、edge 实色 vs alpha、accent（emerald vs clay）、
气泡圆角（12px vs ≈11.76px）、按钮圆角（4px vs 6/8px）、行高（1.5–1.75 vs 1.42857）、焦点环光晕色。

## 三、色板（E1，2026-10-18 核对）

| 语义 | 亮色 | 暗色 | 来源 |
|---|---|---|---|
| 底层画布 | `--m-gray-10` (`252 252 251`) | `--m-gray-850` | CDS surface 阶梯 |
| 侧栏 / 轨道 | `--surface-muted` → `--m-gray-20` | `--m-gray-800` | 上游 Surface 0–3（暗色侧栏档见 §二「不一致」） |
| 主内容 | `--surface` → `--m-gray-10` | `--m-gray-850` | 同上 |
| 正文 | `--content` → `--m-gray-850` | `--m-gray-20` | 对比度取 AA |
| 发丝边 | `--edge` → gray ramp（**R G B 三元组**） | 同左 | 见下方「三元组约束」 |
| 品牌强调 | `--accent: 5 150 105`（emerald，**未改**） | 同左 | D：换 clay 会让 **350 处** `text-accent`（331 + 19 accent-strong）不达 AA，待用户决定（2026-10-18 核对：原记 311 处） |
| 备选品牌 | `--brand-clay` = `var(--m-orange-350)` = `#eb6834` | 同左 | E1，已暴露但未接管 `--accent`（2026-10-18 核对：原记 `#d97757`，那是上游 `--cds-clay`，Mcode 实际取 orange-350） |
| 用户气泡 | `--m-orange-100`（alpha 0.9） | `--m-orange-850`（alpha 0.55） | E1 + 可读性调整 |

**三元组约束（踩过的坑）**：Mcode 的 `--edge` 等 token 存的是 `"R G B"`（生成器头注释与
`styles.css` 的口径是「840 处 alpha 类」；2026-10-18 按 `(bg|text|border|…)-(语义名)/α`
重新统计为 **857 处**，两种口径都说明同一件事）。把它裸写进 `box-shadow` 会在计算值阶段展开成
`195 194 183`，整条声明**静默失效** —— 必须包 `rgb(...)`。生成器的 `VAR_MAP`
已据此修正。

## 四、几何（E1，2026-10-18 核对）

| 维度 | 值 | 来源 |
|---|---|---|
| 面板圆角 | `--radius-panel` = 10px | CDS panel-radius |
| 输入框圆角 | `--composer-radius` = 20px | CDS radius-composer |
| 气泡圆角 | `--radius-bubble` = `calc(8px + .25rem×1)` ≈ **12px**（上游 ≈11.76px） | CDS message-bubble-radius（2026-10-18 核对：原记 18px，与生成物不符） |
| 按钮圆角 | 上游三档：btn-xs 6px / btn-md 8px / panel 10px；**Mcode 生成物未收按钮档**，`ui/button.tsx:21` 现用 Tailwind `rounded`=4px | CDS radius-btn-xs/md（2026-10-18 核对：原记「6/8/10px 三档 = radius-sm/md/lg」有误，上游 radius-sm/md/lg 实为 4/6/8px） |
| 侧栏最小宽度（workspace 变体） | 240px（`shell/ClassicShell.tsx:101`） | D：会话标题可读性下限 |
| 经典壳侧栏圆角 | 24px（`rounded-tl-3xl`，`layout/ThreePaneLayout.tsx:108`） | 现状，保持不变 |
| 会话优先壳侧栏圆角 | 10px（`ClassicShell.tsx:101` `rounded-tl-[10px]`） | E1（CDS 面板圆角） |

## 五、动效（E1 + E2）

| Token | 值 | 来源 |
|---|---|---|
| `--dur-fast` / `--dur-snap` / `--dur-base` / `--dur-sheet` / `--dur-slow` | 5 档（60/120/200/300/450ms） | E1，报告 §2 逐值一致 |
| `--ease-out` / `--ease-snap` / `--ease-overshoot` | 3 条 | E1，报告 §2 逐值一致（上游 `--cds-ease-out` 与报告冲突，见 §二） |
| `--ease-swift` / `--ease-expand` / `--ease-enter` / `--ease-pop` / `--ease-pulse` / `--ease-rise` / `--ease-fall` | 7 条 | E1，上游取证曲线（报告正文未列） |
| `--spring-btn` | `linear(0, 0.2459, …)` | E1：真弹簧采样，与报告 §2 的 16 点逐点一致 |
| 减弱动效 | `html[data-reduce-motion="true"]` 属性总闸（`styles.css:929-957`，写入在 `lib/appearanceAttrs.ts:26-31`）+ 9 个 `prefers-reduced-motion` 媒体块（均在 `styles.css`）+ 2 个 TSX 的 `matchMedia` 调用（`BookmarkFly.tsx:39`、`CurrentOpTicker.tsx:96`） | E2 |

## 六、功能交互面现状（横向补充）

| 交互面 | Mcode 现状 | 与参考的差距 |
|---|---|---|
| 项目/会话侧栏 | 有（LeftBar / StreamSidebar 两视图，含 pinned/运行状态） | 分组/过滤的**视觉**仍是旧样式；窄窗无自动折叠 |
| 新建会话 / 切换 / 恢复 | 有 | 快捷键与焦点顺序未逐项对照 |
| 聊天流 / 流式输出 / 工具卡 | 有（MessageBlocks / ActivityCluster / CurrentOpTicker） | 工具卡折叠层级与阅读宽度未按 CDS 重排 |
| 输入框 | 外框圆角/阴影已接 CDS token（`ChatPane.tsx:3248-3255`，V2 切片） | 附件/命令菜单/模型选择器的**视觉**未迁移 |
| 拖拽面板 / 分屏 | 有（Divider + 三栏，宽度 clamp：左右栏 12–40%/240px、编辑器 20–80%、右栏占比 ≤80%） | 吸附/浮动窗口未做 |
| 内置终端 | 有（PTY 按项目保活） | 主题两套硬编码 hex，未接语义 token（`TerminalView.tsx:36`） |
| 文件编辑 / Diff | 有（Monaco / Milkdown / OnlyOffice / GenOffice 面板） | 文件卡视觉未迁移；diff 无 `--diff-*` token |
| 预览（HTML/PDF） | PDF/图片/Markdown 有；**HTML 无内嵌预览**（只跳浏览器） | 同上 |
| 侧聊 / 并行任务 | 有（SideChatPanel 嵌在右栏 workbench 流面板；子代理会话有独立任务列表） | 交互未对齐 |
| 审批 / 改审阅 | 有（计划审批 / 权限卡 / AskUserQuestion） | 卡片视觉未迁移；无「初始 disabled」输入保护 |
| 设置页 | 有（101 个文件：84 tsx + 17 ts，5 组导航） | 信息架构按「常用/引擎/文档/扩展/系统」重组未做（2026-10-18 核对：原记 94 个文件） |

## 七、陈旧引用核对（2026-10-18）

**`docs/design/claude-desktop-ui-细节逆向.md`（原 → 新）**：

1. §3.2（原 248-249 行）：`` `index.html` `` 的相对链接 `../apps/desktop/src/renderer/index.html` 少一层
   `../`（从 `docs/design/` 解析成 `docs/apps/…`，目标不存在）→
   [`lib/theme.ts`](../../apps/desktop/src/renderer/lib/theme.ts)；`initFoucGuard()` 实际位于
   `lib/theme.ts`、由 `main.tsx:40` 调用（`index.html` 里只有一段指向它的注释），原句「index.html 的
   `initFoucGuard()`」一并更正。
2. §3.8（原 366 行）：「mcode 的 `styles.css` 里一处都没有」→ 现有 1 个
   `@media (forced-colors: active)` 适配块（`styles.css:2571`），§5.1 计数已同步。
3. §4.1（原 392 行）：「`components/` 下的图标集」→ `lib/icons.tsx`（Tabler 图标封装；
   `components/` 下没有 Icons.tsx），`brand-logo.png` 链接改为
   [`brand-logo.png`](../../apps/desktop/src/renderer/brand-logo.png)。
4. §4.2（原 433 行）：`confirm-dialog.tsx` 的相对链接同样补一层 `../` →
   [`confirm-dialog.tsx`](../../apps/desktop/src/renderer/components/ui/confirm-dialog.tsx)。
5. §5.1 现状表（原 455-472 行）按当前源码更新，并逐行标注「2026-10-18 核对」：设计 token
   1 层 → 3 层；动效 token 无 → 5 时长 + 10 曲线 + 弹簧；`data-reduce-motion` 0 处 → 属性总闸已接；
   焦点环散装 → 统一 token；`mask-image` 0 → 1；`forced-colors` 0 → 1 块。

**本文件旧版（V0 首稿）**：`--brand-clay` 记 `#d97757` → 实际 `#eb6834`；`text-accent` 311 处 →
350 处（331 + 19）；气泡圆角 18px → ≈12px；按钮圆角「6/8/10 = radius-sm/md/lg」→ btn-xs 6 /
btn-md 8 / panel 10（上游 radius-sm/md/lg 实为 4/6/8px）；设置页 94 个文件 → 101 个。

## 八、下一步清单

### 能立即做（5 项，不需新证据）

1. **Diff 色 token 化**：把 `DiffView.tsx:49-53` 的硬编码收成 `--diff-add-* / --diff-del-*`
   四值（亮/暗各一组），先与现硬编码等价，真机取色后再校准。
2. **终端主题接语义 token**：`TerminalView.tsx:36` 的 44 处 hex 改读 `--surface/--content/--accent` 等。
3. **生成器补收圆角档**：`gen-cds-tokens.mjs` 的 `GEOMETRY_KEYS` 增加
   `--cds-radius-btn-xs/btn-md/dialog/code/card`（上游有值，纯增量）。
4. **HTML 预览入口对齐**：文件树已有「在浏览器中打开」，把同一动作暴露到文件卡/预览空态，
   或在编辑器内提供只读预览 pane（选型是产品决策）。
5. **审批卡输入保护**：评估给「允许」加初始 disabled（时长可配），对齐逆向报告 §4.2；
   当前 auto-focus + Enter 即确认。

### 需要真机截图（6 项）

1. 本矩阵 13 屏 × 浅/深 × 正常/窄窗的截图集。
2. 字体族、字号阶梯、行高、字重、CJK fallback 与长消息阅读宽度。
3. 窗口顶栏高度、Windows 窗口控件/macOS 交通灯占位。
4. 窄窗断点与侧栏折叠阈值（当前 Mcode 无视口断点）。
5. 动效实际时长/曲线观感（现用报告 + 上游 E1 值）。
6. Diff/终端/编辑器/侧聊的实际配色取样（补 `--diff-*` 等缺失 token）。

### 需要用户提供版本（4 项）

1. 用户实际安装的 Claude Desktop 版本号与安装包（版本对齐；报告基于 `Claude 2.31226.1.0`）。
2. 主题与 DPI 设置（Windows 100/125/150%）。
3. 专有字体（anthropic-sans/mono 等）的合法样本，或确认可用替代字体的度量。
4. 授权采集的截图集（含并行会话、拖拽 pane、侧聊等新版能力）。

## 九、状态声明

本矩阵是 **V0 的部分交付**：令牌与几何按上游 E1 冻结、13 屏现状按当前源码盘点完毕；
Claude 侧一致性全部**待测**。ARC-005 的「开发完成 / 独立复核」**仍双空** —— V4 真机对照
是台账写明的通过门槛，本文件不改变该结论。
