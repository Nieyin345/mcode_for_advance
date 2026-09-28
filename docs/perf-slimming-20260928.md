# 性能 / 瘦身体检（2026-09-28）

目标：让软件更轻、不卡，同时**所有功能完整保留**。本轮方式为“报告 + 低风险优化”：只做收益明确、风险低的改动，每项都有测量或 smoke 验证；其余列为待办，按收益和风险排序。

## 1. 测量方法（可复现，全部在 `apps/desktop/.tmp/` 下，不碰 `out/` 和用户数据）
- **真实 Vite 构建**：只构建渲染端，React Compiler 与别名配置和 `electron.vite.config.ts` 一致，输出到 `.tmp`。然后从 `index.html` 出发，计算桌面端 App 首屏前必须下载并解析的 JS，即 entry 加上 App 各自的静态 import 闭包。
- **esbuild metafile**：做模块级归因，并求出“为什么某个库会被静态拉进来”的最短 import 链。
- **新增守卫 `perf-startup-smoke`**：用同样的方法，把结论固化为回归测试（见 §3）。

## 2. 结论与已做的优化

### 2.1 首屏 JS：App 冷启动闭包 10.8MB → 2.8MB（−74%）
这里的首屏 JS 指 App 界面出现前必须解析的 JS，数据来自真实 Vite 构建（minified）：

| | entry | App 静态闭包（entry 之外） | 首屏 CSS |
|---|---|---|---|
| 优化前 | 746KB | **10,766KB**（`monacoSetup` 3.9MB + `App` 3.9MB + 共享块 3.0MB） | index 313KB + App 87KB + **monaco 159KB** |
| 优化后 | 750KB | **2,765KB**（共享块 2.1MB + `App` 667KB） | index 313KB（monaco 和编辑器的 CSS 改为按需加载） |

全部 JS 的总量不变（35.7MB → 35.7MB）：功能一个没删，只是从“启动就解析”改为“用到才加载”。

**根因**：代码作者本来就把 `FileEditor`、`GitDiffDialog`、`PlanViewer` 做成了懒加载，目的就是让 Monaco 离开首屏。但后来有别的静态 import 链把它们又拉了回来，Vite 构建日志里也一直有 `FileEditor.tsx is dynamically imported … but also statically imported` 的告警：
- `App → SettingsPage → MemoryExplorerPanel → @monaco-editor/react + FileEditor → MarkdownEditorPane → Milkdown(+CodeMirror + Vue 运行时)`
- `App → FileViewer / RightPanel → PreviewPanel → FilePreview → PdfPreview → EmbedPDF(1.1MB)`
- `App → BottomTerminalBar → TerminalPanel → TerminalView → xterm(340KB + CSS)`
- `App → OpenTabsBar → fileIcon → material-icon-theme/icons.json(832KB, 整套 1175 个图标)`

**改动**（5 个文件，都是懒加载边界，不改任何行为逻辑）：
| 文件 | 改动 |
|---|---|
| `renderer/App.tsx` | `SettingsPage`、`FileViewer` 改为 `lazy()`，外面包一层 `<Suspense fallback={null}>`。设置层原有的底色 div 保留，加载的一瞬间看到的是底色，不会闪白。 |
| `components/library/FilePreview.tsx`、`FileViewer.tsx` | `PdfPreview` 改为 `lazy()`，打开 PDF 时才加载 EmbedPDF。没有多包 DOM 元素，原注释里强调的“不多包 div”滚动布局保持不变。 |
| `components/ide/TerminalPanel.tsx` | `TerminalView` 改为 `lazy()`，类型改用 `import type`。有终端标签时才加载 xterm。PTY 本来就是异步起来的，`onReady` 和 `onStatusChange` 只是晚几毫秒触发，排队命令的回放逻辑不变。 |
| `lib/fileIcon.tsx` | 图标集 JSON 改为模块加载后异步 `import()`，再 `addCollection`。`FileTypeIcon` 通过 `useSyncExternalStore` 订阅“已就绪”状态：就绪前渲染同尺寸的空白占位，不会造成布局抖动，也不会让 Iconify 在图标尚未注册时去请求在线 API。 |

### 2.2 其它排查（结论：已经做得较好，本轮不改）
- **主进程启动**：`whenReady` 后数据库不阻塞建窗（`awaitDb()` 延后），已有 `logStartup` 打点。Pi/Babel 等大依赖（7.7MB）已经是动态 chunk。
- **计时器**：全局 1s 时钟 `useNow` 按订阅者启停；侧栏计时只在有会话运行时才 tick；各面板的轮询都挂在“打开时”。没有发现常驻的空转。
- **长对话**：消息列表已用 `@legendapp/list` 虚拟化，有旧消息分页，并开启了 React Compiler。

## 3. 验证
- **新增 `perf-startup-smoke`**（24 项）：
  - 11 类重库（Monaco、@monaco-editor/react、Milkdown、CodeMirror、Vue、EmbedPDF、xterm、material 图标集、docx-preview、pptx-preview、@js-preview/excel）都**不在** App 的静态 import 图中；
  - 同时它们**仍在**构建产物中（功能延后加载，而不是被删掉）；
  - App 静态闭包不超过 4MB 预算（当前约 3.2MB，这是 esbuild 口径，数值与 Vite 口径不同）。
- **红灯依据**：优化前用同一 esbuild 方法求 import 链，Monaco、EmbedPDF、xterm、图标集、Milkdown 都能从 App 静态到达（链路见 §2.1）；优化前的 Vite 构建日志也有 FileEditor 静态/动态冲突告警。优化后该告警消失。
- **回归**（`smoke-runs/1790573029990-38688-Rr1c3O`）：`perf-startup-smoke`、`frontend-smoke`、`ui-interaction-smoke`、`terminal-smoke`、`pdf-annotation-smoke`、`settings-panel-smoke`、`engine-regressions-smoke`、`maint-m17-smoke`、`maint-m22-smoke` 共 9 套，**9 pass / 0 fail**。
- 桌面端 `tsc --noEmit` 通过；改动路径上 `git diff --check` 退出 0。
- **未做**：没有在真实 Electron 窗口里实测启动毫秒数（需要本地启动应用）。建议本地打开一次，分别点设置、打开 PDF、新建终端，确认首次加载只有瞬间的空白。

## 4. 待办清单（按收益/风险排序）

### 4.0 第二轮进度（同日）

| # | 状态 | 结果 |
|---|---|---|
| 1 | ✅ 已做 | 新增 `scripts/file-icon-subset/gen.mjs`：从 `lib/fileIcon.tsx` 的 `EXT_ICON` / `NAME_ICON` / 默认图标里抽出被引用的图标，生成 `lib/fileIconCollection.json`（1175 → 536 个图标，851KB → 446KB）。`fileIcon.tsx` 改为异步导入这个子集，加载方式不变。`gen.mjs --check` 校验子集与映射表一致；perf-startup-smoke 里调用它，并断言完整图标集不再被打包。改映射表后要重跑 `node scripts/file-icon-subset/gen.mjs`。真实 Vite 构建：总 JS 35.75MB → 35.34MB。 |
| 3 | ✅ 已做 | `components/chat/Markdown.tsx`：`remark-math` 与 `rehype-katex` 改为动态导入。remark-math 只识别 `$`，所以不含 `$` 的消息无论有没有这两个插件，输出都一样；含 `$` 的消息会等插件加载完再按原来的方式渲染。应用空闲时（`requestIdleCallback`，最迟 8 秒）会预取插件，所以第一条公式消息基本看不到纯文本那一帧。加载失败时允许重试。KaTeX 的 CSS 仍然在 `main.tsx` 里静态引入（体积小，字体本来就是按需加载）。真实 Vite 构建：App 首屏闭包（entry 之外）2765KB → 2494KB。perf-startup-smoke 新增 rehype-katex / remark-math 的静态闭包断言。 |
| 2 | ✅ 已做 | 从 `apps/desktop/package.json` 删除三个无引用的依赖：`react-pdf-highlighter-plus`、`@shikijs/rehype`、`react-compiler-runtime`（React Compiler 以 React 19 为目标时用的是 `react/compiler-runtime`）。 |
| 8 | ✅ 已做（新发现） | **只给渲染进程用的依赖原先放在 `dependencies` 里，electron-builder 会把它们原样复制进 app.asar**，而 Vite 早已把它们打包进 `out/renderer`。已把 38 个这样的包移到 `devDependencies`，包括 monaco-editor 93MB、react-icons 84MB、@tabler/icons-react 63MB、lxgw-wenkai-webfont 28.5MB、@base-ui/react 8.9MB、@xterm/xterm 5.6MB、katex、milkdown、tiptap、shiki、docx/pptx/excel 预览等。按直接依赖估算，asar 未压缩体积减少 300MB 以上。主进程用到的依赖保持不动，`dependencies` 只剩 14 个：claude-agent-sdk、contracts、electron-updater、node-pty、pdfjs-dist、sherpa-onnx-node/-win-x64、simple-git、sql.js、ssh2、tar、typebox、zod、zod-to-json-schema。main/preload 走 `externalizeDepsPlugin`，只外置 `dependencies` 里的包；移走的这些 main 本来就不引用，所以主进程产物不受影响。perf-startup-smoke 新增守卫：每个 production 依赖都必须被 main/preload/contracts 引用（白名单只有 `@mcode/contracts` 和 `sherpa-onnx-win-x64`）。 |
| 2/8 附带 | ℹ️ | 用 `pnpm install --lockfile-only --offline` 刷新了 lockfile，再用 `pnpm install --offline --frozen-lockfile` 验证通过：+89 −20 个包，全部来自本地 store，没有下载任何东西。**顺带修掉了一个已有问题**：HEAD 的 `pnpm-lock.yaml` 里本来就没有 `@milkdown/*`（以及 codemirror、katex@0.18.9 等传递依赖），和 package.json 对不上，CI 的 `pnpm install --frozen-lockfile` 在这个状态下会失败。现在 lockfile 和已安装的依赖树一致（milkdown 7.22.2）。 |
| 5 | ✅ 已做 | 去掉 `electron.vite.config.ts` 里的 `precompressAssets` 插件，构建不再生成 `.gz` / `.br` 副本（安装包约 −26MB）。`main/mobile/serveMobileStatic.ts` 改为首次请求时按需压缩：br q9 / gzip 9，与原插件参数相同；从磁盘上的最终文件压缩，字节和桌面端加载的完全一致。结果放进有上限的内存 LRU（48MB），键包含 size 和 mtime，dev 原地重建也不会返回旧内容。并发的首次请求共用同一次压缩。实测每 600KB JS 约 40ms。HTML、小于 256B 的文件、图片、`Accept-Encoding: *` 仍然返回原文件，和原来的策略一样。如果目录里已经有预压缩副本（比如旧的 `MCODE_WEB_DIST`），仍然优先用它。新增 `mobile-static-compress-smoke`（26 项检查）。 |
| 4 / 6 / 7 | ⏭ 按用户决定本轮跳过 | 涉及其他会话正在修改的文件（ChatPane、i18n 字典），或改动风险高（拆分 sessionStore/ChatPane）。等那些会话提交后再做。 |

### 4.1 原始清单
| # | 项目 | 预期收益 | 风险 | 说明 |
|---|---|---|---|---|
| 1 | material 图标集**构建期子集化** | 包体 −600KB 左右；异步加载更快 | 低 | `EXT_ICON` / `NAME_ICON` 只用到一部分文件图标，文件夹图标完全不用。可以在构建时只抽取被引用的图标，生成小 JSON。 |
| 2 | 删除无引用依赖 `react-pdf-highlighter-plus`、`@shikijs/rehype` | 安装包和依赖树瘦身 | 低 | 源码里只剩注释提到它们。需要改 `package.json` 和 lockfile，并重新 `pnpm install`，本轮按规定不联网安装。`react-compiler-runtime` 在 React 19 下也可以评估去掉。 |
| 3 | KaTeX 按需加载 | 首屏 −260KB | 中 | 只有消息中出现 `$` 公式时才加载 `rehype-katex`。需要处理流式渲染和 markdown 缓存的一致性。 |
| 4 | i18n 只加载当前语言 | entry −约 260KB | 中 | 目前中英两套字典（524KB）都打进了 entry，而 `translate` 是同步调用，需要在启动时先加载当前语言，切换语言时再异步加载另一套。 |
| 5 | 安装包中的 `.gz` / `.br` 预压缩副本 | 安装包 −约 26MB | 中 | 这些副本只供手机端 HTTP 服务使用，桌面端不需要。可以只压缩手机端会访问的资源，或改为首次访问时在运行时生成缓存。 |
| 6 | ChatPane 流式期间的全量扫描 | 长会话流式输出时降低 CPU | 中 | `beforeMap`、`planBlocks` 等 `useMemo` 依赖整个 `messages`，每次 delta flush 都会遍历全部历史块。可以改为按消息对象增量计算，或只对最后一条重算。 |
| 7 | 拆分超大源文件 | 编译、HMR、Compiler 效果 | 中高 | `sessionStore.ts` 超过 500KB（Babel 已提示 deoptimised），`ChatPane.tsx` 约 5000 行。属于可维护性和编译性能问题，需要分批做。 |

## 5. 协作说明
- 本轮开始时，`App.tsx` 已经有**其他会话尚未提交的改动**（WorkspaceSidebar / 设置层渲染隔离）。我的 4 处改动与这些改动互不重叠，但提交时要注意：用 `git commit -- App.tsx` 会把对方的改动一起带进提交，需要只暂存我的 hunk，或者等对方先提交。其余 4 个文件在改动前是干净的。
- 测量期间，另一个会话的在途文件 `settings/OnlyOfficeConfigCard.tsx` 一度无法解析（其中混入了 patch 残留的 `+` 行）。临时测量脚本对它做了打桩，**没有修改它**；`perf-startup-smoke` 本身不打桩。

## 6. 改动清单
- 修改：`apps/desktop/src/renderer/App.tsx`（仅本轮新增的 4 处 hunk）、`lib/fileIcon.tsx`、`components/ide/TerminalPanel.tsx`、`components/library/{FilePreview,FileViewer}.tsx`
- 新增：`apps/desktop/scripts/perf-startup-smoke/{run.sh,main.mjs}`、本报告
- 尚未提交、未推送。
