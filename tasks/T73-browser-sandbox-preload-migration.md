# T73｜修复内嵌浏览器 sandbox:false：隔离 preload 并保持元素选取

| 项目 | 值 |
|---|---|
| 编号 | T73 |
| 工作包 | ARC-005 / T20 残余安全缺口；非新浏览器实现 |
| 级别 | P0，安全边界优先于皮肤 |
| 路线 | L1 Electron 官方 sandbox/preload 机制 + L2 受控 browserPicker preload |
| 可派 | **第一批补充并行**（不与其它 BrowserManager/preload 构建任务并行） |
| 独占可写 | `apps/desktop/src/main/browser/BrowserManager.ts`、`apps/desktop/src/preload/browserPicker.ts`、必要的 `apps/desktop/electron.vite.config.ts` 局部 preload 构建项、新建 `apps/desktop/scripts/t73-browser-sandbox-smoke/`、本任务卡 |
| 只读/禁止 | `main/modules/*`、`main/appControl/*`、`scripts/release-readiness-smoke/*`（当前 T49/他人未提交改动）、`main/document/*`、`renderer/components/ide/*`、`packages/contracts/*` |


## 已核实背景
T20 回写已定位：`BrowserManager.ts` 创建加载任意外部 URL 的 `WebContentsView` 时配置 `session:browserSession()`、`contextIsolation:true`、`nodeIntegration:false`，但 **`sandbox:false`**。当前原因是 `browserPicker.mjs` 独立 ESM preload，沙箱预加载脚本兼容性受限。已有 `src/preload/browserPicker.ts` 仅公开 `window.mcodeBridge.pickElement`；现状不等同于页面已有 Node 权限，风险是渲染进程缺少沙箱硬隔离。T20 的 Epitaxy iframe 组件没有生产接线，**不属于本卡**。

## 开工前必读
1. `audit-ledgers/README.md`、`tasks/T20-sandbox-and-mic-bars.md` 的未达成结论、现有 BrowserManager、browserPicker 全文。
2. `apps/desktop/electron.vite.config.ts` preload entry 与 `apps/desktop/scripts/release-readiness-smoke/check-unpacked.cjs` 中对 `browserPicker.mjs` 的打包断言（只读）。
3. `apps/desktop/scripts/browser-smoke/`、`browser-file-url-boundary-smoke/`、`browser-script-injection-smoke/`、`browser-tool-parity-smoke/` 和 `html-preview-electron-smoke/`。
4. 当前 Electron 版本的官方 sandbox/preload 支持规则与仓库两种构建态（开发、unpacked）；绝不以改后测试桩存在代替实际 preload 注入。

## 执行内容
1. **先立隔离红例**：记录当前 `sandbox:false` 的真实构造调用，确认 `preload` 与会话 partition、cookie vault、picker IPC 约定；用隔离 Browser view，不访问用户登录站点或真实 Cookie。
2. 仅在能保持现有 ElementPicker 工作时把 preload 改为 Electron 沙箱支持的兼容产物（必要时专用 CommonJS 预载），**不要**给页面注入 Node API、`allowRunningInsecureContent` 或新任意 IPC。
3. 产物文件名变化必须同步 Build 资源校验约定；由于 `release-readiness-smoke/check-reviewed.cjs` 当前有他人修改，若必须修改这个热区且无法无冲突完成，先独立回写阻塞，**不要**覆盖或偷交别人的差异。
4. 维持 `BrowserManager` URL/path fail-closed、浏览器账户/历史独立 session、关闭清理、元素选取手势及浏览器新窗口拒绝策略。
5. 新建专项测试验证配置真实加载、危险 preload 注入拒绝、picker IPC 身份绑定与负例、旧浏览器用例；必要的 Electron 动态测试要与其它 Electron 执行者串行，安全可重现的 Node 小套可先做。

## 验收判据
1. **加载不可信网页的实际 Browser view 已是 sandbox:true**，不仅是新建测试桩或注释文本；旧 `sandbox:false` 入口不能漏。
2. 页面看不到 Node/Electron 权限，唯一可信 picker 事件仍能通过真实预载和宿主身份验证，不凭页面伪造消息提权。
3. 浏览器新建、站点 session/登录隔离、元素点选、HTML 预览和正常导航行为不回归；若真实 Electron 无法运行，标 U1 未验，不能宣称达成全 GUI。
4. preload 开发/打包产物指向实际存在文件，安全资源清单仍 fail-closed；不通过“跳过检查”取得绿灯。
5. 相关 browser、picker、preview Smoke 与双包 TypeScript 通过；若跨域在飞错误则列出归属及实际红项。
6. 变异：回退 sandbox 选项 → 专项断言必红；切断 picker 正向通路 → 另一断言必红；均恢复后源哈希逐字节一致。
7. 不动 T49/T64/T65 在飞文件，精准提交；提交与未达 U1 回写本卡。

## 不做
不修 T20 的无生产调用的 Epitaxy 七 MIME 桥；不重写 BrowserManager、不迁移主窗口 preload、不动网络代理/扩展沙箱 MC-035。若沙箱 ESM 兼容问题需大范围换主构建架构，停工回写根因与最小后续边界，不以禁用 picker 功能换“安全绿”。

## 结果回写区

<!-- 只在下面追加：提交 SHA、旧红→新绿、原始命令/日志、变异/还原字节、剩余未验；不得覆盖本任务正文。 -->

### 2026-10-21｜T73 执行回写（代码提交 `c367216741c1b37befda34de3330ca21800aec9e`）

**源码与旧红→新绿（E1/E2）**：`BrowserManagerImpl.spawnView` 旧构造参数 `sandbox:false`、ESM `browserPicker.mjs`；新构造参数 `sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`、专用 `browserPicker.cjs`，仍使用原 `browserSession()`。浏览器新窗口仍复用 `spawnView`。不存在实际 preload 时 Electron 视图创建 fail-closed；仅未打包开发态允许在 Electron-Vite 项目工作目录下解析存在的 `out/preload/browserPicker.cjs`（隔离 HTML 预览探针所需），打包态不回退。IPC 限定登记的 `webContents`、启用的 pickMode 与顶层 `senderFrame`；预载隔离世界凭 `isTrusted` 同步 click + 命中该 DOM 元素的 selector 才放行 picker，并在预载内从 DOM 读取 HTML/URL/预览，拒绝页面自报字段、合成点击、重复调用。页面没有 Node/原始 IPC 桥。

**构建（E1）**：Electron-Vite 3.1.0 拒绝 preload 多输出格式（实测构建报 `The electron vite preload config does not support multiple outputs`）；改为单次 ESM preload build 的 `generateBundle` 钩子额外输出 `browserPicker.cjs`，原 `index.mjs` 与 `browserPicker.mjs` 保留，缺 picker chunk/缺 `require("electron")` 时构建失败。最终 `cd apps/desktop && node node_modules/electron-vite/bin/electron-vite.js build --logLevel error` **PASS（exit 0）**；实际 `out/preload/index.mjs`、`browserPicker.mjs`、`browserPicker.cjs` 均已生成。未修改在飞的 `scripts/release-readiness-smoke/check-reviewed.cjs` 或只读的 `check-unpacked.cjs`。

**专项、旧回归与真 Electron（E1）**：
- `node apps/desktop/scripts/t73-browser-sandbox-smoke/run.cjs` **5/5 PASS**（真实 `spawnView` 方法编译执行、preload 缺失拒绝、picker 主进程 sender/pickMode/frame 正反例、预载原 CJS 转译 IPC 正反例、配置产物契约）。
- `node apps/desktop/scripts/t73-browser-sandbox-smoke/native.cjs` **PASS**：Electron 44.4.5 隔离 `WebContentsView` 真实加载构建出的 CJS preload，网页 `typeof require/process` 为 `undefined`，伪造调用/合成点击无 IPC，真实鼠标点击后 `pickResult` 到达，`senderFrame === sender.mainFrame`。测试只用匿名 data: 页面和独立临时 session/目录，未触真实用户 Cookie 或账户。
- `node apps/desktop/scripts/run-smokes.mjs t73-browser-sandbox-smoke browser-smoke browser-file-url-boundary-smoke browser-script-injection-smoke browser-tool-parity-smoke html-preview-electron-smoke` **6 PASS / 0 FAIL**；日志 `apps/desktop/.tmp/smoke-runs/1792591520779-26140-Iygfyj`。额外 `browser-occluder-rect-smoke browser-pure-smoke browser-tabs-a11y-smoke browser-uuid-entropy-smoke t20-sandbox-mic-smoke ipc-wiring-smoke` **6 PASS / 0 FAIL**，日志 `apps/desktop/.tmp/smoke-runs/1792591330282-35756-XF7dvL`。
- `node apps/desktop/node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json`、`node apps/desktop/node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json` **均 PASS**。
- `node apps/desktop/scripts/t73-browser-sandbox-smoke/asar-fixture.cjs` **PASS**：隔离构造 ASAR 含旧 ESM 与新 CJS，新增 `verify-package.cjs` 严格验证 3 preload 与构建字节哈希；删 `browserPicker.cjs` 后 **RED**。这只是隔离打包资源校验，不是正式安装包验收。

**两项变异（E1）**：`node apps/desktop/scripts/t73-browser-sandbox-smoke/mutate.cjs`：`sandbox:true → false` 后专项断言 **RED / exit 1**；切断 `browserPicker.ts` 的正向 IPC 频道后 **RED / exit 1**；均 `finally` 写回备份并比较 SHA256 原始字节一致（运行时 `BrowserManager.ts` SHA `c40e6034d8028a8f0bc345b8593bf6bce6700c4a5be95092e65c1758063858d8`，`browserPicker.ts` SHA `713cd288ec64ab31bd6cd90fbf725ced93e55357237282dacc555ad6bb6717f2`；前者后续仅删掉一处行尾空格并精准提交，最终版本亦已过专项、编译和 smoke）。`git diff --check` PASS。

**验收界限 / remaining**：1、2、5、6 已有 E1 证据；3 已有真实 Electron 隔离点选和 HTML 预览 smoke，但**整个真实用户产品旅程 U1 仍未验**（例如正式发布应用的交互、真实登录站点行为）；4 开发产物存在、构建与隔离 ASAR 资源校验通过，但**没有实测 Windows win-unpacked 真发行包执行 `verify-package.cjs` / 全套发布资源门禁**，不能宣称真实打包 U1 全达成。7 已遵守文件独占与精准提交，未碰 T49/T64/T65 在飞文件；本回写仅追加本任务卡，等待后续独立复核。
