# ARC-006 / MC-035/036 — VS Code extension API compatibility (scoped L1)

> 2026-10-20 · **设计 D + 源码核对 E2 + 本地隔离 E1**，不是 ARC-006 完成声明。
> 首要规则：**ModuleHost 是唯一的权限、模块/能力注册、执行和撤权事实源**。Open VSX 仅为未来元数据与 VSIX 来源；本切片无网络下载、无自造完整插件运行时。

## 1. 代码与权限基线

| 已存在的宿主资产 | 当前实际能力 / 严格边界 |
|---|---|
| `ModuleHost.register/validate/prepareCapability` | Zod 严格校验模块清单与能力引用；宿主分配 `module.<slug>.<short>` 以免扩展伪造跨模块能力；同一张 capability registry 供目录、调用和撤销使用 |
| `ModuleHost.install/restore/remove` | 序列化变更；可执行程序安装前受控进程验证，prepare-before-persist、写入失败保旧模块；恢复、升级、卸载和能力解绑；变化时协作式取消和旧结果丢弃；工作流授权升级/卸载失效、写盘失败回滚 |
| `ModuleHost.invoke` | 实际资源 `authorize` 检查、模块/贡献/扩展名匹配；action 每次 `requestApproval`，network 单独审批；缺端口拒绝，等待批准后复核模块和工作流授权；query/action/任务分别返回结构化状态 |
| `ModuleHost.invokeForWorkflow/issueWorkflowGrant/revokeWorkflowGrant` | 用户模块显式工作区/版本/贡献/能力授权；畸形授权整表拒绝；在执行前及发布结果时重新检验；运行中本宿主撤销使调用取消，跨宿主撤销拒发布迟到结果 |
| `permissionedProcessRunner` | **用户 JS** 使用独立 Node/Electron 子进程、文件级 `--permission`、无继承密钥环境、超时/取消/异常退出结果；默认 Node 网络 API 拦截，仅对显式 network + 每次审批放行 |
| `isolatedActionRunner` | 内置/宿主注册的 isolated action 用 worker 防崩/防卡；**不是安全沙箱**，不能代替第三方进程隔离 |
| `packages/contracts/src/modules.ts`、`moduleCapability.ts`、`ipc/modules.ts` | 清单、贡献点、权限、结果、用户工作流授权及 UI 安装双确认；**当前贡献 UI 仅 `files.context`** |

注意：Node `--permission` 不提供 OS 网络 egress 禁止；JS 层网络拦截也非强隔离。安装同意不意味着允许以后任何文件或任意网络访问。权限与能力仍须每次由 Mcode Host 复核。VSIX 未签名、没做来源可信链与依赖审查，**不可作为生产任意社区扩展安装器**。

## 2. 参照工程 / 来源许可（只读）

- **VS Code 官方规范**：[`contributes.commands`](https://code.visualstudio.com/api/references/contribution-points)、[`commands.registerCommand`](https://code.visualstudio.com/api/extension-guides/command)；注册与 manifest 声明是不同步骤，执行命令能触发 `onCommand` 激活。本切片只取一个命令、一次激活；不宣称 VS Code 等价。
- **Eclipse Theia**：[`doc/Plugin-API.md`](https://github.com/eclipse-theia/theia/blob/master/doc/Plugin-API.md) 说明完整路径经 `plugin-ext` 子进程宿主 / RPC，`plugin-ext-vscode/src/node/plugin-vscode-init.ts` 将 VS Code API 暴露给扩展进程；[`@theia/plugin-ext-vscode` 1.76.0](https://www.npmjs.com/package/@theia/plugin-ext-vscode) 许可 **EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0**，且依赖 core/editor/monaco/plugin-ext 等多包。**仅对照思想，没有复制、链接或安装该代码**。后续若要复用必须固定上游 commit、许可/NOTICE、依赖许可证和可分拆边界。
- **open-claude-ui**：台账提到“同级思路”，但在当前仓库未发现可定位的同名源码，公开检索也无法唯一确认所指 upstream/commit/许可。标为 **D/E3 待定位**，不凭项目名捏造该项目提供的 API；仅采纳“先查成熟宿主、尽量做薄映射”的设计方向。
- **Open VSX**：将来是 VSIX 的一种**分发来源**，不是插件执行 API 或沙箱；本轮不下载任何市场包。

## 3. VS Code API 兼容分级

这里 **L1/L2/L3 是 API 适配难度与当前支持声明**，不同于 FULL 路线中的源码复用 L1～L4。**L1 有子类：L1-P 已有本地原型、L1-C 仅可通过现有宿主做有限直映射，还未把 VS Code 语法接上**；L2 待补薄转接 / UI；L3 本方案明确不承诺。

| VS Code API / 贡献点 | 级别 | Mcode 对应路径 / 不支持说明 |
|---|---|---|
| `contributes.commands`（一个命令 title / ID） | **L1-P** | VSIX 清单受限读取 → `ModuleManifest.contributions[0]` 的 `files.context`；非法/未知贡献直接拒，不映成任意 UI |
| `commands.registerCommand(id, handler)` | **L1-P** | 子进程内只登记 manifest 白名单的一个 ID；回到 ModuleHost 分配的 `module.run` 执行，不把不可信 handler 放在主进程；每次调用重新激活（非长驻的 VS Code command registry） |
| `commands.executeCommand(id, ...args)` | **L1-P（受限）** | `VscodeL1Bridge.executeCommand(id, resource, requestId)` 由受信宿主调用 `ModuleHost.invoke`；**只允许唯一已声明 ID + 已授权 `ModuleResource`**，不支持可变参数、内建 VS Code 命令 |
| `window.createStatusBarItem() / text / tooltip / command / show / hide` | **L1-P（快照）** | 子进程执行后的单个状态栏项收敛为 `statusBarItem()` DTO；只允许 `command` 指向自身命令。**无 renderer 真实状态栏 UI；不跨调用保留对象/事件** |
| `ExtensionContext.subscriptions` / `Disposable.dispose` | **L1-P（受限）** | 只接收本次激活所注册的 disposable；子进程退出自然清理，不具备长期订阅生命周期 |
| `workspace.fs.readFile` / `Uri.file` | **L1-C** | `resource.read` + `fileCapabilities`/路径围栏已在宿主；VS Code URI/文件结果适配、版本/错误码尚未接入，不可用 `require("fs")` 绕开权限 |
| `workspace.fs.writeFile` | **L2** | 已有 write grant/action 逐次批准；需 URI→资源、文件版本/CAS 与真实写入能力映射，不可直接给扩展通用 fs |
| `window.showInformationMessage/showWarningMessage` | **L2** | 需受控通知/审批服务 + 展示时机映射；不能擅自弹 OS 模态框，不能以空返回伪装支持 |
| `commands.registerTextEditorCommand` | **L2** | 需编辑器选择/版本/撤销协议，不能把文本编辑器对象原样交第三方 |
| `workspace.getConfiguration/onDidChangeConfiguration` | **L2** | 需 per-extension 配置命名空间、监听与可信设置映射 |
| `env.clipboard` / `window.withProgress` | **L2** | 需权限/应用窗口/进度 RPC 适配；ModuleHost task 有进度与取消，但未接 VS Code 对象模型 |
| `languages.registerCompletionItemProvider`、`registerHoverProvider` | **L2** | 要接现有 LSP/编辑器路由、文档版本/隔离、provider 生命周期 |
| `languages.registerDiagnostics` / DiagnosticCollection | **L2** | 需 editor/LSP 诊断 DTO 与 scope/revoke；无可直接显示的状态栏/诊断控制 |
| `window.createWebviewPanel`、webview views | **L3** | 任意 Webview 脚本/CSP、消息与资源加载隔离未建立；不支持 |
| `window.registerTreeDataProvider`、`viewsContainers` | **L3** | 没有通用树视图容器/持久 UI 插槽，本切片明确拒绝 |
| `contributes.menus/keybindings/themes/grammars` | **L3** | 未做菜单/快捷键上下文/Monaco 语法资源映射；清单有这些字段直接拒绝 |
| `debug` / `tasks` / `terminal` 完整 API | **L3** | 调试适配器、PTY、多进程权限、终端 profile 的 VS Code 语义不存在；不把 Node 子进程 runner 说成这些功能 |
| `authentication`, `SecretStorage`, `extensions.getExtension` | **L3** | 密钥/身份、跨扩展加载信任与依赖隔离未建立；明确不支持 |
| `notebooks`, `customEditors`, `SCM`, `chat/languageModel`、测试控制器 | **L3** | 各需独立原生宿主与 UI/协议；不可通过“空实现”假兼容 |

L2 与 L3 可随真实宿主接线/上游复用重新评估；在此之前 manifest/API 发现必须显式报“不可用”。不写一整份冒牌 `vscode.d.ts`。

## 4. L1 本地实际实现 / 使用限制

**文件**：`apps/desktop/src/main/modules/vscodeL1Bridge.ts`，专项无头测试 `apps/desktop/scripts/vscode-l1-smoke/`。不改 ModuleHost 主体或现有 renderer。执行流：

```text
本地虚构 VSIX (ZIP STORE 两文件，extension/package.json + extension/extension.js)
   → ZIP 目录/CRC/长度/路径白名单 + VS Code manifest schema
   → 双重安装确认 (confirmReadAccess + confirmExecutableCode)
   → ModuleHost.install(program + module.run / files.context contribution)
   → verifyPermissionedProgram（安装期受限子进程）
   → VscodeL1Bridge.executeCommand(commandId, resource, requestId)
   → ModuleHost.invoke → authorize / module identity / permissioned child
   → child 中 require("vscode") 微型 API 只支持 registerCommand + 1 statusBarItem
   → 安全结果解析 → Host DTO statusBarItem()
```

这是**对一个最小本地伪造 VSIX 的兼容实验**：没有 Open VSX 网络、无动态 ZIP 解压器、无通用 CJS/ESM loader、无 VSIX signature/供应链校验、无 renderer 绘制/Agent 对外 RPC、无长期扩展状态，遇到不允许的 ZIP/清单/API 立即失败。测试的 ZIP 是**真实二进制 ZIP**但严格只接受 *STORE + 精确两项*，一般市场 VSIX 往往是 DEFLATE、含更多资源，故绝大多数真实 VSIX **当前会被拒**。这比误声称“市场兼容”更安全。

**局限与缺口**：`require("vscode")` 在受控执行进程里只有这一小部分 API，激活仅按本次调用重做，`ExtensionContext.subscriptions` 没有长驻 disposal 管理；`statusBarItem()` 是本轮命令完成的快照，并非真正 VS Code API 对象的持续生命期。用户文件只经一次 `ModuleResource` 授权；用户安装/逐次审批取决于实际业务装配（本测试为可信宿主注入测试端口），不是对任意插件免审批的入口。

## 5. 测试证据与 remaining

- 专项：`node apps/desktop/scripts/run-smokes.mjs vscode-l1-smoke`，隔离真实子进程、伪造实际 ZIP 文件字节，覆盖安装双确认、非法 contribution 拒绝、合法授权调用与结果/status 快照、无授权拒绝、未注册命令失败、子进程 exit(37) 不带走宿主、卸载撤权。
- `bash apps/desktop/scripts/smokes-for.sh src/main/modules/ModuleHost.ts`（Windows 必须选择可用 Git Bash，而非 WSL 的 `C:\Windows\System32\bash.exe`）；双包 `tsc`、新增断言变异红→绿作为本切片验收。
- **2026-10-20 E1 记录**：`node apps/desktop/scripts/run-smokes.mjs vscode-l1-smoke module-contract-smoke module-catalog-smoke module-extension-lifecycle-smoke module-protocol-integrity-smoke module-executor-smoke module-phase2-security-smoke module-phase2-e2e-smoke module-platform-smoke module-grant-revoke-safety-smoke module-workflow-smoke` **11/11 suites PASS**；Desktop + Contracts `tsc --noEmit` exit 0/0；`smokes-for.sh src/main/modules/ModuleHost.ts` 映射包含 `vscode-l1-smoke`。变异：把 `contributes` 的 `.strict()` 临时改成 `.passthrough()`，`vscode-l1-smoke` **9/10 红**，唯一红例是“非法 keybindings 贡献未被拒”；恢复原源文件后 **10/10 绿**。仅 E1 隔离回归，不是实机 U1。
- **remaining**：真实 StatusBar/CommandPalette UI + Agent `app_api_*` 发布；权限审批 UI 的真人 U1；完整 VSIX/DEFLATE/签名与可信发布者审核；跨会话 activation/deactivation、command 订阅与事件、额外 APIs；上游 Theia 固定 Git commit/可拆用法律评审；真实 Electron + 三 SDK + Win/macOS/Linux OS sandbox/网络 egress 验证。**MC-035/036 历史状态及 ARC-006 整包不能因本片声称关闭**。
