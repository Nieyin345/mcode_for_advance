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
