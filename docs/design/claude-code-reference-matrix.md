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
| `--border-*` | **家族名缺**；等价 `--edge`=**亮 `217 217 216` `#d9d9d8`（14% 黑合成）/ 暗 `63 63 63` `#3f3f3f`（18% 白合成）**、`--panel-edge`=亮 `227 227 226` / 暗 `--m-gray-750`、`--input-edge`=亮 `--m-gray-250` / 暗 `72 72 72`（`styles.css:181,196,202,410,419,424`） | 报告/上游：`--cds-border`=alpha-2 = `hsla(0,0%,8%,.10)`（亮）/ `hsla(0,0%,100%,.09)`（暗） | **不一致（Mcode `--edge` 实色，上游=10% alpha；合成到 `#fcfcfb` 上约 `#e3e3e2`）**；Mcode 刻意加深一档（亮 1.38:1 / 暗 1.73:1）以让分隔线可读，**且必须与 `--surface-hover` 分得开**（10% alpha 对 hover 填充只有 1.12:1，边框落在悬停行上会消失）——见 `styles.css:168-180` 注释与 `tasks/T121`（`b736c814`，2026-10-24 14:58 重定此档） |
| `--accent-*` | **已切换为陶土橙（`370f1799`，2026-10-20）**：亮色 `--accent: 194 81 36` =`#c25124`（4.55:1）、`--accent-strong: 174 70 28`=`#ae461c`（5.54:1）；暗色 `--accent: 236 131 90`=`#ec835a`；sketch 纸面 `#9a4e26`、牛皮纸 `#e2966e`。**不再是 emerald**（那 `5 150 105` 是 2026-10-18 之前的旧值，本行曾据此登记）。`--brand-clay`=`#eb6834` 仍暴露给装饰面 | 报告/上游：`--cds-clay: #d97757`，`--cds-text-accent: var(--cds-clay)`、`--cds-fill-brand` | **刻意偏离，理由已复核成立**：上游 `#d97757` 在亮色底仅 **3.04:1**，而 `text-accent` 有 **342 处**。取同一 orange 色阶里过 AA 的两档（4.55 / 5.54:1），**观感仍是陶土橙**。`design-tokens-smoke` 的守卫已从「保持 emerald」改成「亮/暗各自是过 AA 的 orange 档，且不得直接用 3.04:1 的 #d97757」 |
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

## 十、2026-10-19 ARC-005 当前实装差距复核（E1/E2，取代上方早期“待办”的现状判断）

**参考目标**：Claude Code Desktop 2026-04-14 公开新版 Code 工作区（https://claude.com/blog/claude-code-desktop-redesign）及 https://code.claude.com/docs/en/desktop。官方公开内容确认“并行会话侧栏 + 任意位置拖放 pane + 终端/文件编辑/可视 Diff + 侧聊”。**没有用户本机 Code 页的同分辨率截图**，所以下表只是源码/可运行功能对照，**不是像素或视觉相似度百分比**。更不能复制 Anthropic 专属图标、字体文件或源码。

| Claude Desktop Code 参照维度 | Mcode 本轮实际源码状态 | 差距/验收 |
|---|---|---|
| 默认首屏 | App.tsx 始终使用 ClassicShell；DEFAULT_SHELL_PREF 仍为 classic，workspace 需在设置主动开启；共享 sessionStore/PTY/Monaco 保活 | **未完成**：用户新进入时仍看到 Mcode 老壳，不能宣称 Code UI 已默认完成。禁止仅把 default 改成 workspace 当完工 |
| 左侧项目/会话/并行 | LeftBar/StreamSidebar 已有项目树、置顶、会话状态、命令搜索与新建；WorkspaceShell 仍复用同一内容和大号品牌入口 | **未达到 Claude Code 的信息密度和层级**：分组/筛选/Recent/Pinned/环境/运行状态逐屏 UI 尚未按参考重排 |
| 主列与侧栏几何 | V2 旧版只有侧栏 240px 下限与 10px 圆角，主列一直是 24px。**本轮修正**：ThreePaneLayout 接 variant；workspace 主列左上/左下 10px，classic 保留 24px；Divider 的 hideLine 改为仅 workspace 隐藏，classic 仍有可见线；只切 class，同 main/PTY 子树保活 | **部分完成**：组件几何更一致，但真实 Windows/浅暗/DPI 的 Claude↔Mcode 截图边界测量仍缺 |
| 聊天/工具/审批 | ChatPane/MessageBlocks 等成熟可用，composer radius/shadow 动效来自 CDS 语义令牌；已存在权限卡、流式工具事件、三引擎 | **未完成**：消息/工具折叠、审批/错误卡、按钮/hover/focus、输入控件布局仍未逐屏与 Claude Code 对齐 |
| 主题/字体/颜色 | tokens.cds.css 由 MIT 参考生成，diff 行色已在 styles.css 使用 --diff-*，按钮有 --radius-btn-*；但 --accent 仍 emerald，字体/CJK/边框角色仍与参考存在待测差异 | **未完成**：不能把逆向令牌视为用户 Claude 版屏幕取样；不得擅自全局替换强调色造成低对比度 |
| 分屏/拖放 | ThreePaneLayout 支持左右/底部 Divider、右栏和终端折叠；文件标签可拖动排序 | **关键缺项**：并非 Claude Code 的任意 pane 布局、拖拽停靠/弹出窗口/恢复工作区；当前仅固定三列/底部终端，且关闭部分面板有卸载风险 |
| 终端/编辑/Diff/预览 | 真实 PTY、Monaco、Git Diff、侧聊已有；本地 AI 刚加入 HTML 预览（html-preview-electron-smoke 通过，2026-10-19） | 功能入口存在但共享 pane 样式/布局持久化与多窗口互操作、App/GenOffice 文档一体化仍缺 |
| Mcode 独有能力 | 资料库、自动化、工作流、GenOffice、MCP/Skills/Hook/插件等均有入口 | **必须保留**；后续纳入 Code 风格 Views/功能中心，不得为外观相似度删功能或创建平行业务状态机 |

**新写的可变异旧输入**：本轮 workspace-shell-smoke 先加入五条几何/生命周期断言，修复前 48/52（4 红），修复后 52/52；发现 Divider 原来对 classic/workspace 都无条件 hideLine，又先加断言修复前 52/53（1 红），改成 hideLine={isWorkspace} 后通过。最终六套相关 smoke 全部 PASS：workspace-shell、design-tokens、settings-layout、leftbar-render、terminal-panel-worktree、html-preview-electron。**这是 E1/E2，不是参考图视觉 U1**。测试过程中，另一个并发分支的 desktop TypeScript 暂时因 document-view-host-smoke 的 SlidesEditExecutor fixture 缺 openDeck 而红（属于 ARC-007 测试夹具，非本轮 UI 布局变更）；ui-interaction 另报 model-form-labels 场景 reloadCustomModels 缺桩，待另行核根因。

**下一轮最优先改造建议（ARC-005 内继续，不重复开新架构编号）**：
1. **V1/V2 会话首屏**：工作区变体沿用同一组件实例，先重排左侧顶部的 New session / 搜索 / Pinned / Recents / 项目分组与运行徽标，再改顶栏按钮和输入区视觉密度。不要默认启动大 IDE 布局，主聊天自然占宽。
2. **Pane 模型**：以独立的布局树 + 内容实例保活层实现 Code/Diff/Terminal/Browser/File/Side chat 的拖放停靠，布局保存/恢复；防止拖动卸载 PTY 和脏 Monaco 文档。不用在 ThreePaneLayout 上堆彼此冲突的百分比。
3. **视觉 token 与功能统一**：对照官方与用户安装版的浅/深截图量字体、CJK 行高、暗色背景、边框、按钮尺寸和状态卡；逐页改 React UI primitives，保留高对比度；和 ARC-007 GenOffice 的 WebContentsView 几何/焦点合同共用。
4. **V4 验收矩阵**：同 DPI/主题/窗口尺寸下采 13 类参照画面，测量元素 bounds/像素颜色 + 键鼠动作；优先“空会话→多任务→工具失败→批准→Diff→侧聊→终端→文件保存→重启恢复”；没有这些证据 **ARC-005 仍 [ ]/[ ]**。

本节源码修改仅限 ThreePaneLayout.tsx、ClassicShell.tsx 和 workspace-shell-smoke/main.ts；无业务重写、无本机 Claude 私有源码访问或字体复制。已有上方“Diff 尚无 token/HTML 无内嵌预览/按钮仍 4px”的旧状态属于更早版本，不再作为当前事实。

## 十一、2026-10-19 直接复用仓内 Claude Desktop v2 逆向的密度实现（E1 + E2；非视觉 U1）

**输入证据**：`open-claude-ui/docs/v2/03-架构重构与对比分析.md`（2026-10-15，声称 v2.37337.1）第 3.1、3.3 节，及 `open-claude-ui/code-examples/DraggableSessionList.tsx`、`CdsButton.tsx`、`ClaudeDesktopHeader.tsx`；对照仓内 `docs/design/claude-desktop-ui-细节逆向.md`（v1.0 旧版本静态记录）。这批是**第三方逆向分析/参考实现**，未经用户本机实际 Claude Code 逐屏取样，不能把每个数值写成已经验真的官方像素尺寸。此处只转移通用设计参数与交互语义，不复制私有安装包代码、字库或品牌资产。

| v2 逆向特征 | 此次 Mcode 落地 | 未复制的边界 |
| --- | --- | --- |
| Composer v1 20px → v2 compact 12px / comfortable 14px | 仅 `[data-ui-shell-variant="workspace"]` 下 `--composer-radius: 14px`；旧 classic 仍由生成器的 v1 20px token 提供。busy sweep 也随同一 `--composer-radius` 变化 | 尚无用户 Code 实机尺寸/字体对照；全局主题和其它 Office 画布不变 |
| 侧栏 28px 单行高密度、分级任务状态 | tree 模式 28px 最小行高、4px 垂直内距；stream 保留项目/标题/branch 三行数据但缩小 padding/gap；激活高亮、键盘、未读、执行状态、工作树/置顶/归档均保持现有业务事实 | 不强行将 3 行 stream 隐藏成 1 行，不隐藏未读/审批或 PR 信息；PR 尚无统一真后端不伪造 |
| 高频控件 24–32px、弹簧和作用域隔离 | workspace 新建会话 32px minHeight、搜索 28px、8px 角色圆角，读现有语义色；原始 Claude 的按钮弹簧示例只作参考，不强行改全 app | 移动 UI/设置/经典壳/弹窗继续原尺寸，扩展控件不能因全局改 CSS 被误伤 |

代码：`ClassicShell.tsx` 在**同一** WorkspaceInertShell DOM 根增加 variant 属性（不重挂 PTY/Monaco/Tiptap）；`SidebarQuickActions.tsx`、`StreamSidebar.tsx`、`LeftBarParts.tsx` 给真实操作/会话行添加稳定 data 选择器；所有变体声明收敛到 `styles.css`；`workspace-shell-smoke` 对生产组件与作用域的静态联线断言先红 53/58、修后绿，后续 tree 子项补旧输入红 59/60、修后绿。`design-tokens-smoke` 的原全局字面量否定扫描改为先精确剔除 workspace 覆写块，**依旧严格禁止全局别名漂移**。

运行性反证：`ui-interaction-smoke` 使用真 Chromium + 真实编译 Tailwind CSS 的隔离 fixture，读取 `getComputedStyle`：classic Composer 20px、workspace Composer 14px、workspace New session ≥32px，stream padding 缩小、tree 行 ≥28px、tree 垂直 padding 4px，**同一个 textarea 节点及 KEEP DRAFT 文本在 classic→workspace→classic 往返保持**。这证明 CSS 作用域可计算与不卸载的样式层，不证明真实生产大应用下的全部 PTY/Monaco / Code 参考视觉 U1。

最终验证：`node scripts/run-smokes.mjs workspace-shell-smoke design-tokens-smoke ui-interaction-smoke leftbar-render-smoke settings-layout-smoke terminal-panel-worktree-smoke` → **6/6 PASS**，本次末次 `apps/desktop pnpm exec tsc --noEmit` **PASS**（过程中其它 AI 并发改动过文档 mock 导致临时红，但末次已通过）。暂未跑全量 smoke/真 Electron 主窗口截图。高相似度剩余关键点仍是侧栏导航信息架构、真正自由 pane 拖放/弹出与布局恢复、顶栏/消息/审批/文件 UI 全状态 + 本机 Claude Code 参考图的 DPI/主题/中英文逐屏验收。ARC-005 开发、复核双空不变。

## 十二、2026-10-20 ARC-005 V4 Electron 真机实测

> 证据等级 U1（隔离环境中真 Electron + 真 App，未覆盖上游 Claude 安装版）。
> **保留 §一原有“已实现/未实现/待测”判定词不变**。本节只增量记录实际截图与计算样式。
> 复跑：`bash apps/desktop/scripts/arc005-visual-baseline/run.sh`；所有源数据存放于未提交的 `.tmp/arc005-visual/`。

| 原矩阵行 | 浅色 1280×800 | 深色 1280×800 | 窄窗 1024×640 |
|---|---|---|---|
| 初始空会话 | 已实测：已知差异（Mcode 真实截图；与上游的既有 token 差异见 §二；Claude 安装版未采） | 已实测：已知差异（T141 后 0 未登记；旧登记值已随 T121 的 --edge 重定一并更新） | 已实测：已知差异（Mcode 真实截图；与上游的既有 token 差异见 §二；Claude 安装版未采） |
| 已有消息 | 已实测：已知差异（Mcode 真实截图；与上游的既有 token 差异见 §二；Claude 安装版未采） | 已实测：已知差异（T141 后 0 未登记；旧登记值已随 T121 的 --edge 重定一并更新） | 已实测：已知差异（Mcode 真实截图；与上游的既有 token 差异见 §二；Claude 安装版未采） |
| 工具运行中/完成/失败 | 已实测：已知差异（Mcode 真实截图；与上游的既有 token 差异见 §二；Claude 安装版未采） | 已实测：已知差异（T141 后 0 未登记；旧登记值已随 T121 的 --edge 重定一并更新） | 已实测：已知差异（Mcode 真实截图；与上游的既有 token 差异见 §二；Claude 安装版未采） |
| 权限审批 | 已实测：已知差异（Mcode 真实截图；与上游的既有 token 差异见 §二；Claude 安装版未采） | 已实测：已知差异（T141 后 0 未登记；旧登记值已随 T121 的 --edge 重定一并更新） | 已实测：已知差异（Mcode 真实截图；与上游的既有 token 差异见 §二；Claude 安装版未采） |
| 代码/文件 Diff | 未实测：data-missing（无带旧版本的真实文件 Diff 夹具：不伪造 Monaco diff） | 未实测：data-missing（无带旧版本的真实文件 Diff 夹具：不伪造 Monaco diff） | 未实测：data-missing（无带旧版本的真实文件 Diff 夹具：不伪造 Monaco diff） |
| 侧聊 | 未实测：data-missing（右侧聊依赖独立 WorkflowBoard IPC；复用脚手架下真实面板会卸载，缺端到端夹具） | 未实测：data-missing（右侧聊依赖独立 WorkflowBoard IPC；复用脚手架下真实面板会卸载，缺端到端夹具） | 未实测：data-missing（右侧聊依赖独立 WorkflowBoard IPC；复用脚手架下真实面板会卸载，缺端到端夹具） |
| 终端 | 未实测：data-missing（无独立 PTY 宿主：直接打开会触发原生终端创建，超出本隔离截图夹具范围） | 未实测：data-missing（无独立 PTY 宿主：直接打开会触发原生终端创建，超出本隔离截图夹具范围） | 未实测：data-missing（无独立 PTY 宿主：直接打开会触发原生终端创建，超出本隔离截图夹具范围） |
| 文件编辑 | 未实测：data-missing（无可安全读取的已打开编辑器文件：不伪造内容） | 未实测：data-missing（无可安全读取的已打开编辑器文件：不伪造内容） | 未实测：data-missing（无可安全读取的已打开编辑器文件：不伪造内容） |
| 预览 | 未实测：data-missing（无真实可预览文件夹具：不伪造 PDF/图片/Markdown） | 未实测：data-missing（无真实可预览文件夹具：不伪造 PDF/图片/Markdown） | 未实测：data-missing（无真实可预览文件夹具：不伪造 PDF/图片/Markdown） |
| 并行会话侧栏 | 未实测：data-missing（StreamSidebar 是原有 Electron 焦点脚手架替身；不能当成真正并行会话侧栏截图） | 未实测：data-missing（StreamSidebar 是原有 Electron 焦点脚手架替身；不能当成真正并行会话侧栏截图） | 未实测：data-missing（StreamSidebar 是原有 Electron 焦点脚手架替身；不能当成真正并行会话侧栏截图） |
| 项目切换 | 未实测：data-missing（LeftBar 为上游现成脚手架替身，项目列表不可见；需真实 LeftBar 的独立 Electron 环境） | 未实测：data-missing（LeftBar 为上游现成脚手架替身，项目列表不可见；需真实 LeftBar 的独立 Electron 环境） | 未实测：data-missing（LeftBar 为上游现成脚手架替身，项目列表不可见；需真实 LeftBar 的独立 Electron 环境） |
| 设置菜单 | 已实测：已知差异（Mcode 真实截图；与上游的既有 token 差异见 §二；Claude 安装版未采） | 已实测：已知差异（T141 后 0 未登记；旧登记值已随 T121 的 --edge 重定一并更新） | 已实测：已知差异（Mcode 真实截图；与上游的既有 token 差异见 §二；Claude 安装版未采） |
| 窗口缩窄 | 未实测：data-missing（窗口未缩至 1024px） | 未实测：data-missing（窗口未缩至 1024px） | 已实测：已知差异（Mcode 真实截图；与上游的既有 token 差异见 §二；Claude 安装版未采） |

本轮 39 格有 **16 张有效真实截图**、23 格 `data-missing`，不存在拿旧 PNG 或替身面板充数的情况。每格至少一个 JSON 存有 `snapshot.tokens` + 15 个目标元素的 `getComputedStyle`（不存在的目标 `present:false`），及 Electron 原生 DPI/窗口配置。由于复用的既有 Electron 脚手架故意替代了 LeftBar/StreamSidebar、且无 PTY/真实文件/WorkflowBoard 宿主，相关状态尚缺真用户旅程；不能将全部 ARC-005 判为完成。

### 参考矩阵原先“待测”的 3 个窄窗格：实际采样

| 原先待测的格子 | 真 Electron 计算样式原始实测值 | 能得出的结论 |
|---|---|---|
| 工具运行中/完成/失败 / 窄窗 | message: font-size=16px；line-height=24px；background-color=rgba(0, 0, 0, 0)；border-radius=0px；padding=0px；bounds=583.0×31.5；viewport=1024×614 | 已实测 Mcode DOM 与布局；**Claude 对应形态仍待用户安装版截图** |
| 权限审批 / 窄窗 | approval: font-size=12px；line-height=16px；background-color=rgb(252, 252, 251)；border-radius=16px；padding=12px 16px；bounds=583.0×156.9；viewport=1024×614 | 已实测 Mcode DOM 与布局；**Claude 对应形态仍待用户安装版截图** |
| 设置菜单 / 窄窗 | settings: font-size=16px；line-height=24px；background-color=rgb(249, 249, 247)；border-radius=0px；padding=0px；bounds=1024.0×614.3；viewport=1024×614 | 已实测 Mcode DOM 与布局；**Claude 对应形态仍待用户安装版截图** |

### CSS 令牌比对与现场环境

- 比对详情 `.tmp/arc005-visual/diff.md`：每条含 `Mcode token 原始值 / 上游解析值 / 矩阵原判定 / 实测 / 结论`，可以按同名 JSON 复核。**截至 2026-10-24 21:10（T141 修完格数门禁后的首次完整运行）：51 格，一致 833 / 已知差异 340 / 未登记差异 0。** 此前的「13 条暗色 `--edge` 未登记」已在 T141 一并结清 —— 那不是回归，是 T121（`b736c814`）按对比度重定 `--edge` 之后，矩阵 §二与本比较器的登记值都没跟着改。
- 既有 surface/text/edge 实色-vs-alpha、按钮/气泡圆角、动画曲线的差异仍按照 §二原判定如实记录；上游样本只是第三方逆向 CSS，不能冒充 Claude 官方真实屏幕。
- `environment.json` 与 51 份 JSON：Electron 44.4.5；Windows 内核版本 10.0.22000；devicePixelRatio=1.75（175%）；正常条件请求 1280×800、窄窗请求 1024×640，DOM viewport 窄窗实为 1024×614（含窗口框架差）。**⚠️ 这个分母以前写的是 39，而场景早已是 51 —— 与 T141 修掉的是同一个过期数字。**
- 本机取证未获取用户安装的 Claude Code/Desktop 对照图。参考矩阵原“待测”是**参考侧待测**，本轮仅增加 Mcode 侧实测值，不擅自关闭 ARC-005。

### 2026-10-21 T12 补拍：原 23 个缺格

本轮将 `LeftBar` / `StreamSidebar` 从原焦点脚手架占位恢复为真实组件，针对其余面板在真 App 上叠加**逐张标明来源的隔离视觉夹具**。现可获得 **39/39 张真实 Electron capturePage PNG + 39/39 份 JSON**（较 T01 新增 **23 张**），缺格为 0；**“照片由 Electron 真拍”不等于“内容没有桩”**。

| T01 缺失屏 | 浅/深/窄窗补拍结果 | 本轮覆盖的可验证内容 |
|---|---|---|
| Diff | 3/3，`real-lineDiff-DiffView` | `.tmp` 内两份真实虚构文本经生产 `lineDiff` + `DiffView` 出图，未起 Monaco |
| 侧聊 | 3/3，`sidechat-partial` | 真实 `WorkflowBoardPanel` 的隔离展示/错误边界；无真实运行与订阅 IPC |
| 终端 | 3/3，`static-terminal` | 静态终端框架、字号、token 背景/前景；**非** PTY 证据 |
| 文件编辑 | 3/3，`stub-editor` | 虚构源码只读展示；**非** Monaco 编辑器功能证据 |
| 预览 | 3/3，`real-markdown-renderer` | 生产 Markdown 组件渲染；不含 PDF、图片 |
| 并行会话侧栏 | 3/3，`real-StreamSidebar` | 真实流式组件 + 3 条虚构会话 |
| 项目切换 | 3/3，`real-LeftBar` | 真实树形组件 + 2 个虚构项目 |
| 窗口缩窄浅/深 | 2/2，`stub-editor+real-layout` | 实际 BrowserWindow 1024×640，左右栏展开 + 只读编辑器桩，文件名中的 1280 只表示所属主题条件 |

所有新增 PNG 的同名 JSON 都有顶层 `fixture`；无未注明来源的面板替身。复核 `.tmp/arc005-visual/manifest.json`、`environment.json`、`diff.md`：**T141 之后（2026-10-24 21:10）的实测是 51 格 / 833 一致 / 340 已知差异 / 0 未登记差异**，`run.sh` 退出码 0。上面的 **637 一致 / 247 已知差异 / 13 未登记差异** 是 T136 扩到 51 格之前、且在格数门禁坏掉期间取的旧数据，保留作追溯。恶意改写 `empty-light-1280.json` 的 `--surface` 为 `255 0 255` 后未登记差异会增加，逐字节还原后回到基线，证据在 `.tmp/arc005-visual/mutation-t12.json`。仍**不能**宣称上游 Claude 安装版逐屏相符或侧聊/PTY/Monaco/PDF 等完整用户旅程通过，§一和旧 V4 数据保留原样。
