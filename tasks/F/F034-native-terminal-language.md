# F034｜原生 Terminal、VS Code 语言服务与受限 Webview 集成

- Status: **E1 功能实现和专项验收完成；Electron U1 与其余高级 VS Code API 未完成**
- Depends: F033. Required Skills: mcode-smoke、codebase-design。
- 本轮只修改 F 扩展线相关源文件、与主服务连接的干净 `main/ipc/terminal.ts`、专用 smoke 和此任务台账；所有其他并行未提交文件保留。

## 已实现的真实集成

1. **终端复用**：真实 `TERMINAL_MAIN` RPC → `McodeTheiaTerminalDriver` → 主进程现有 `TerminalManager`。由现有 terminal IPC 初始化时注册轻量 `nativePtyBinding`，不会在扩展层另行 import / 常驻第二份 node-pty；`TerminalManager` 仍是唯一 PTY owner。支持扩展 `createTerminal/sendText/dispose` 和实际 PID 回传；发还正确的 `TerminalServiceExt.$terminalCreated/$terminalOpened`。限制单会话 3 个、输入 16 KiB、禁止自定义 shell、限制真实工作区根（含 realpath 验证，拦截 `..` 和 symlink 越界）；原扩展会话结束只杀它创建的终端，不杀用户手动终端。完整终端 show/hide、环境变量、pseudoTerminal 和 UI 自动聚焦尚未覆盖。
2. **语言服务（首批）**：从真实 `LANGUAGES_MAIN` 收集 `registerHoverProvider` 与 `registerCompletionSupport`，扩展 host RPC 发到 `LANGUAGES_EXT.$provideHover/$provideCompletionItems`，结果限制数量和 1.8s 超时。Mcode 真正的 Monaco `registerHoverProvider/registerCompletionItemProvider` 消费结果，没有第二编辑器。仅使用当前 Mcode Monaco 快照，经原始 F029 文档桥同步；模型未变不重复传全文；相同版本并发请求合并，并在切换/编辑/停止时失效。扩展出错不中断原生编辑器。完整 definition/references/rename/code-actions/formatting/semantic tokens、跨文件多模型语言功能未完成。
3. **受限 Webview 基础能力**：真实 `WEBVIEWS_MAIN` 的 create/title/setHtml/postMessage/dispose 到 Mcode 根布局单一 `TheiaWebviewHost`；Webview 页通过 `iframe sandbox="allow-scripts"`、不启用 `allow-same-origin`，从 CSP 限制网络子资源、`file:`、表单/嵌套 frame，且不向 iframe 注入 Mcode Node/Electron 对象。用户界面 ↔ Theia `WEBVIEWS_EXT.$onMessage` 正反消息真实 roundtrip；消息校验精确窗口 sender、会话、实例句柄与 payload 上限，关闭后不可重放。异步 Webview 消息同时支持 iframe 加载前及加载后（队列 effect flush）。此项不保证 iframe 自身导航绝对隔离；正式产品还必须做 Electron navigation interception 与 CSP/U1 攻防验证。完整 `vscode-resource`、WebviewView、custom editor、localResourceRoots、持久化视图与任意网络依赖内容 **未实现**。未接入 UI 的会话显式拒绝 Webview 创建，不静默成功。
4. **与 Mcode 统一**：不额外启动 Webview/terminal 工作台进程；原生 Monaco、原生终端主服务、已有主 App UI。必要时按需请求 Theia 子进程。用户退出扩展后释放其终端/Provider/Webview 会话资源。

## 真实测试与验收

- `theia-installed-smoke` **123/123 PASS**：实际 Theia Node 子进程执行真实 VS Code 终端命令，核验 PID、send/dispose；真实 Hover/Completion 注册及返回文本；创建 HTML Webview、`webview.postMessage`、Mcode → extension `onDidReceiveMessage`、关闭和跨窗口/旧句柄安全边界。终端参数禁止目录逃逸、自定义 shell，停止回收。使用 **注入的 PTY driver 替身** 测 Theia RPC，不会在开发者真实项目中执行 shell，不能冒称真实 Mcode node-pty/Electron U1 验证。
- `theia-palette-smoke` **61/61 PASS**：Monaco 原生 Provider 注册和失效机制、Webview sandbox/CSP/句柄源验证、加载后队列转发源级断言，以及已有权限/命令/菜单/诊断逻辑。注意这是静态边界断言，**不是浏览器级攻击测试**。
- `theia-host-boot-smoke` PASS。
- 联合 `node apps/desktop/scripts/run-smokes.mjs theia-installed-smoke theia-palette-smoke theia-vsix-preview-smoke theia-host-boot-smoke module-platform-smoke module-permissions-smoke module-workflow-smoke app-control-smoke ipc-wiring-smoke extension-honesty-smoke vsix-install-ipc-smoke vsix-ignored-contributions-contract-smoke` → **11/12 suites PASS**，日志 `apps/desktop/.tmp/smoke-runs/1792941164548-26800-K4LNDq/`。唯一 FAIL：`ipc-wiring-smoke` 报 `mcode:document-view:write-recovery` 主进程有、preload 无；属并行 Document View 路由，不修改其归属代码。
- `pnpm exec tsc --noEmit -p apps/desktop/tsconfig.json`、`pnpm exec tsc --noEmit -p packages/contracts/tsconfig.json`：**PASS**。自有 `git diff --check` PASS，`vendor/theia` 没有修改。
- 真 Electron U1、发布构建、资源负载 p50/p95/RSS、工作区内启动真实 PTY 的产品 UI 尚未验；无依据声称全面丝滑。

## 仍需继续开发的功能

- VS Code 高级语言功能（跳转定义、引用、重命名、格式化、语义 token）、Webview 资源协议和复杂视图、`Terminal.show/hide`、Task/Debugger 完整系统、扩展依赖/自动事件激活、ModuleHost 统一权限/安装管理、正式 Theia 资源打包、真实 Electron 沙箱/导航限制和 U1。
- 被安装的扩展本身在 Theia 子进程运行，仍是**未沙箱化的 Node 扩展**；iframe 的受限来源**不限制**该扩展 Node 侧代码的本地文件或网络访问。
- Commit (code): `9bd56b9f`（18 个本对话所有扩展相关源码与专项测试，699 行新增、8 行删除；没有 stage 其他并行对话文件）。Ledger commit follows.
