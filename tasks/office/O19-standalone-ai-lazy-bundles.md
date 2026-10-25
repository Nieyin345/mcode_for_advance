# O19｜Mcode 内建 Office：独立版 AI 运行时按需拆包

- Status: **2026-10-25 有界交付**。Docs/Slides 各自生产构建 PASS，T7 真 Electron 编辑保存重启重开各 1/1 PASS；六格式同宿主 U1 已验证主入口挂载且未观察到独立 AI chunk。**不是六家全部原生运行时共用，也不宣称 RSS 降低与入口字节一一对应。**
- 归属：ARC-007 / O14 Mcode AI 唯一入口 / O18 六编辑器 CPU/RAM 实测。**这是启动/解析性能和 AI 架构去重，不涉及 UI 重构、色彩、布局或图标。**

## 实际瓶颈

O18 同一 Mcode Electron OS 进程中 6 个内嵌编辑器占用约 1.70 GiB Electron 进程组工作集，Docs/Slides 是较大编辑器。复核 `genoffice/apps/docs/src/renderer/App.tsx` 和 `genoffice/apps/slides/src/renderer/App.tsx`，发现正常启动时**静态 import `AiPanel`**，尽管 Mcode 宿主以 `!isMcodeHostedUi()` 永远不挂载 GenOffice AI UI。两个原厂面板模块直接静态拉入原厂 `AgentLoop`、`@genoffice/ai-provider/browser`、技能与图片工具及相关 UI；这不是 Mcode 的 AI，引擎职责重复，并且普通 Office 首帧会解析不必要的 JS。

## 修复（原厂 fork + 唯一可重放补丁）

- Slides `App.tsx`：静态 `AiPanel` 改 `React.lazy(() => import('./ai/AiPanel'))`，原有 `!isMcodeHostedUi()` 保持，原厂独立版仍可按需加载 AI；用 `React.Suspense fallback={null}` 保留原来的面板折叠/运行时挂载生命周期。不移动文件写盘、Agent 审批，Mcode 自己的 AI 完全不改。
- Docs `App.tsx`：相同的 `lazy` / `Suspense` 拆包。原本从 AI 面板导入的纯常量 `AI_REVISION_AUTHOR` 下沉到新增 `ai/revision-author.ts`，以防正常文档的评论/修订代码因为**仅一个作者字符串**被迫加载整个 Agent UI。原 `AiPanel.tsx` 同时保留该常量的 re-export 以兼容既有导入。
- 不动 Sheets：它的 AI 逻辑与其 20MB+ Univer 初始化 bundle 耦合更深，未找到可按本轮同样安全地一次拆出的唯一模块；避免为了体积盲目更改网格与公式性能。

## 字节级可核验证据（生产 electron-vite build）

使用同一项目、同一 Node/Vite 配置。改前 entry 大小来自启动本轮时未修改的 `genoffice/apps/{docs,slides}/out/renderer/assets/index-*.js`；改后由 `npm run build -w @genoffice/slides` 和 `npm run build -w @genoffice/docs` 产出。

| 编辑器 | 改前首屏 entry JS | 改后首屏 entry JS | 原厂 AI 专属延迟 chunk | 入口减少 |
|---|---:|---:|---:|---:|
| Slides | 5,427,829 B | 4,661,999 B | `AiPanel-CessVu4r.js` 765,076 B | **765,830 B** |
| Docs | 8,065,186 B | 7,785,092 B | `AiPanel-CBSLXNSV.js` 282,120 B | **280,094 B** |
| 合计 | 13,493,015 B | 12,447,091 B | 按需 chunk | **1,045,924 B** |

这些是未压缩的编译后 JS 文件大小；不能直接称为网络压缩大小、真实首帧加速毫秒数、或 RSS 下降幅度。改后的普通入口不再强制静态打包这两组原厂 Agent UI，但静态仍包含各自主编辑器功能。

## 真实运行与回归

- `npm run typecheck -w @genoffice/slides`、`npm run typecheck -w @genoffice/docs` → **PASS**。
- 真实 Mcode Electron 宿主 T7：`node apps/desktop/scripts/t7-genoffice-u1/run.mjs --only=slides-open-edit-save-reopen` → **PASS 1/1，2 OS generations**（`.tmp/electron-u1/2026-10-25T06-54-16-653Z`）；Docs 同命令的 `--only=docs-open-edit-save-reopen` → **PASS 1/1，2 OS generations**（`.tmp/electron-u1/2026-10-25T06-54-40-031Z`）。两家都真正编辑、保存、退出新进程再打开，有 Mcode 文件会话/原子保存的原 T7 断言。
- 独立 `node apps/desktop/scripts/office-perf-u1/run.mjs --only=six-editor-residency` → **PASS**（`.tmp/electron-u1/2026-10-25T06-56-49-507Z`），六编辑器与同一 Mcode 主窗口均存活。新 U1 步骤在 Docs/Slides 检查 `navigator.userAgent` 表示 Mcode、各自主入口 `<script src=index-*.js>` 实际加载、未见 `AiPanel-*.js` 的 script/resource 记录。**局限：`performance.getEntriesByType('resource')` 对本地 Electron file/custom protocol 可能为 0，不能宣称抓到了完整网络加载轨迹；构建产物拆包 + runtime Mcode 执行分支 + 既有 T7 AI DOM 负断言是独立证据。** 原探针错误要求 ResourceTiming 必须包含 entry 而红，按实际浏览器行为改为读取真实 DOM `document.scripts`，不放松主入口和 AI chunk 检查；测试步骤改名避免超出证据范围。
- 原厂 Slides 的 `ai-edit-queue`、`ai-panel-run-lifecycle`、`ai-panel-collapse` → **17/17 PASS**；Docs 的 `ai-comment-tools` + `ai-track-revisions` → **23/23 PASS**。
- **非全绿项（如实记录）**：Docs `ai-panel-collapse.test.ts` 两例因测试环境直接 import `AiPanel`、不注入 `window.desktop`，在未改动的 `ai/transport.ts:10` `window.desktop.aiToolResult` 抛 TypeError（合并 23/25）。这两例不经本轮 `App.tsx` lazy 接缝，也没有真桌面 preload；不为通过测试改动安全/宿主授权或冒称 Standalone AI GUI 完整 E2E PASS。需要独立补它们的 mock/preload 证据。
- Mcode `node apps/desktop/scripts/run-smokes.mjs genoffice-source-smoke genoffice-editors-release-smoke genoffice-native-view-smoke office-perf-smoke` → **4/4 PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792911666834-3280-guOpQw`；Desktop 与 Contracts `tsc --noEmit` **PASS**。
- Vendor `mcode/integration` commit `6a5a5cbf23e2e0ba608055a3138ae4e2b8665b67`，parent `b6435363663f26050bf92742a01dedb65b03e46d`，tree `12a3eaf5586fbd48a371b212510ef63f999880b2`；第 29 条补丁 `patches/genoffice/0029-perf-office-defer-standalone-ai-bundles.patch`，5466 字节、SHA256 `4632af559844ab13214b2c2acfded75d88e7f10466875391c0876536600cd600`；`MCODE_INCLUDE_GENOFFICE_BUNDLE=1 node apps/desktop/build/verify-genoffice-upstream.cjs` → **29 patches PASS**。

## 后续非 UI 性能主线

- 对真正占用最大的 Sheets/Slides 编辑器，分析按需载入计算/图表模块、动态 import 时的 Vite Chunk graph 与静态依赖，**先做性能和可恢复性验证再重构**，不要省几 MB JS 却复制一套 AI/保存模块。
- 用 O18 六编辑器 U1 做成对前后基线，记录相同文件的实际首帧时长与每个 Chromium renderer 的 RSS/CPU（至少多次 P50/P95），防止把首包字节节省误称内存节省。
- 原厂单机 standalone AI GUI、Mcode 真在线模型在 Docs/Slides 编辑保存的 U1 仍分别待独立验收。本轮不触及 UI 美化。
