# ARC-006 / MC-035/036 — VS Code extension API compatibility (scoped L1)

> 2026-10-20 · **设计 D + 源码核对 E2 + 本地隔离 E1**，不是 ARC-006 完成声明。
> 首要规则：**ModuleHost 是唯一的权限、模块/能力注册、执行和撤权事实源**。Open VSX 仅为未来元数据与 VSIX 来源；本切片无网络下载、无自造完整插件运行时。

## ⚠️ 本文件是 L1 原型记录，不是已交付的扩展宿主

**读这一节再往下读。** 后来者最容易误判的一件事是「这个仓库有 VS Code 扩展兼容层，所以能装 VS Code 扩展」。

**事实是：**

1. **`VscodeL1Bridge` 与 `readMinimalVsix`**（定义在 `apps/desktop/src/main/modules/vscodeL1Bridge.ts:291` / `:58`）
   **在 `apps/desktop/src/` 内零调用方**；唯一引用是 `apps/desktop/scripts/vscode-l1-smoke/main.ts`（一套实验套件）。
   —— 取证时**两个范围要分开看**：搜 `src/` 得 0 不等于「全仓没有调用方」。
2. **产品上真正可用的是 `ModuleHost`**（手写 JSON 清单的扩展），不是本文件的 VSIX 路径。
   **怎么写一个装得进去的扩展：`docs/extensions/authoring-guide.md`。**
3. **`.vsix` 没有安装入口，这是产品决定不是未完成** —— 见 `tasks/T85-extension-productization-decision.md`。
   真要做需要重算「自建宿主 vs 接 Theia」，那不在近期范围。

**所以本文件应该被读成**：一份「L1 能走多远」的实验记录 + 未来若重开这个决策时的可行性底稿。

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

> **⚠️ 本节的「L1-P 已实现」指的是原型路径，不等于产品可用。**
> 产品上真正能装的是 `ModuleHost` 的手写 JSON 清单扩展（`docs/extensions/authoring-guide.md`）。
> 本节各条实现所依附的 `VscodeL1Bridge` 在 `src/` 内零调用方 —— **已实现的限制清单见 §6.2**。

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
本地虚构 VSIX (ZIP 两文件，STORE 或 DEFLATE，extension/package.json + extension/extension.js)
   → ZIP 目录/CRC/长度/路径白名单 + VS Code manifest schema
   → 双重安装确认 (confirmReadAccess + confirmExecutableCode)
   → ModuleHost.install(program + module.run / files.context contribution)
   → verifyPermissionedProgram（安装期受限子进程）
   → VscodeL1Bridge.executeCommand(commandId, resource, requestId)
   → ModuleHost.invoke → authorize / module identity / permissioned child
   → child 中 require("vscode") 微型 API 只支持 registerCommand + 1 statusBarItem
   → 安全结果解析 → Host DTO statusBarItem()
```

这是**对一个最小本地伪造 VSIX 的兼容实验**：没有 Open VSX 网络、无通用 CJS/ESM loader、无 VSIX signature/供应链校验、无 renderer 绘制/Agent 对外 RPC、无长期扩展状态，遇到不允许的 ZIP/清单/API 立即失败。测试的 ZIP 是**真实二进制 ZIP**，只接受 *恰好两项*；**压缩方法 STORE(0) 与 DEFLATE(8) 都支持**（F002 补齐，用 `node:zlib` 的 `inflateRawSync`）。含更多资源的一般市场 VSIX 仍会被拒。

### 4.1 两个单文件限额：**原来没有依据，F003 补上理由**

| 限额 | 值 | 依据 |
|---|---|---|
| 总包 | **128 KiB** | 未查到书面依据（L1 原型期定的）。当前保留。 |
| `extension/package.json` | **64 KiB**（原 4096 B） | **F003 放宽。** 实测最大真实值 17 021 B（`mechatroner.rainbow-csv-3.24.1`），旧限超 4.2 倍。它是**声明不是代码**，变大只多命令/配置项/activationEvents，不引入新能力。 |
| `extension/extension.js` | **24 KiB**（**未放宽**） | **F003 明确保留。** 见下。 |
| entry 数 | **恰好 2** | 未查到书面依据。当前保留。 |

**为什么 `extension.js` 的 24 KiB 不能放宽：**

放开它等于承诺一个**跑不起来的运行时**。`require` 白名单目前只有 `"vscode"`，53 个 `vscode.*` 成员没有一个是完整实现。真实扩展（rainbow-csv 的 `extension.js` 是 **136 516 B**，超限 5.6 倍）一旦能进，用户就会期望它能跑 —— 而结果是**装进去了、能列出、一调用就崩**，这比「装不进来」更坏。

**要让真实扩展能跑，得先做运行时**（或明确接受「装得进但跑不了」并如实告知）。在那之前，这道限额是一句诚实的「这里还不行」。

**查证记录**（`tasks/F/F003`）：`68a7121c`（限制最初引入）的提交信息为空；§4 从未写过理由；`tasks/archive/` 无相关记录。**结论：4096 / 24576 都是 L1 原型阶段随手定的，不是推导出来的。** 所以放宽 `package.json` 不是「违反设计」，是「补上一个从未有过的决定」。

**局限与缺口**：`require("vscode")` 在受控执行进程里只有这一小部分 API，激活仅按本次调用重做，`ExtensionContext.subscriptions` 没有长驻 disposal 管理；`statusBarItem()` 是本轮命令完成的快照，并非真正 VS Code API 对象的持续生命期。用户文件只经一次 `ModuleResource` 授权；用户安装/逐次审批取决于实际业务装配（本测试为可信宿主注入测试端口），不是对任意插件免审批的入口。

## 5. 测试证据与 remaining

- 专项：`node apps/desktop/scripts/run-smokes.mjs vscode-l1-smoke`，隔离真实子进程、伪造实际 ZIP 文件字节，覆盖安装双确认、非法 contribution 拒绝、合法授权调用与结果/status 快照、无授权拒绝、未注册命令失败、子进程 exit(37) 不带走宿主、卸载撤权。
- `bash apps/desktop/scripts/smokes-for.sh src/main/modules/ModuleHost.ts`（Windows 必须选择可用 Git Bash，而非 WSL 的 `C:\Windows\System32\bash.exe`）；双包 `tsc`、新增断言变异红→绿作为本切片验收。
- **2026-10-20 E1 记录**：`node apps/desktop/scripts/run-smokes.mjs vscode-l1-smoke module-contract-smoke module-catalog-smoke module-extension-lifecycle-smoke module-protocol-integrity-smoke module-executor-smoke module-phase2-security-smoke module-phase2-e2e-smoke module-platform-smoke module-grant-revoke-safety-smoke module-workflow-smoke` **11/11 suites PASS**；Desktop + Contracts `tsc --noEmit` exit 0/0；`smokes-for.sh src/main/modules/ModuleHost.ts` 映射包含 `vscode-l1-smoke`。变异：把 `contributes` 的 `.strict()` 临时改成 `.passthrough()`，`vscode-l1-smoke` **9/10 红**，唯一红例是“非法 keybindings 贡献未被拒”；恢复原源文件后 **10/10 绿**。仅 E1 隔离回归，不是实机 U1。
- **remaining**：真实 StatusBar/CommandPalette UI + Agent `app_api_*` 发布；权限审批 UI 的真人 U1；完整 VSIX/DEFLATE/签名与可信发布者审核；跨会话 activation/deactivation、command 订阅与事件、额外 APIs；上游 Theia 固定 Git commit/可拆用法律评审；真实 Electron + 三 SDK + Win/macOS/Linux OS sandbox/网络 egress 验证。**MC-035/036 历史状态及 ARC-006 整包不能因本片声称关闭**。

## 6. T14 · L2 复用调查与受限接线（2026-10-21）

### 6.1 第 0 步：依赖/许可/拆分方案表（E2 + npm 元数据，只读）

复核命令（**只读取元数据，未下载 VSIX 或 Theia 安装包**）：

```text
npm view @theia/plugin-ext-vscode@1.76.0 version license dependencies --json
npm view @types/vscode@1.95.0 version license dependencies --json
```

Theia 1.76.0 的 `dependencies` 字段有 **19 个直接依赖**（其中
`@theia/plugin-ext`、`@theia/core`、`@theia/editor`、
`@theia/monaco`、`@theia/monaco-editor-core`、`@theia/plugin`）。
**19 ≠ 传递依赖总数**；未安装完整 Theia，不报告虚构的传递树数字。
Theia 官方 [Plugin API 说明](https://eclipse-theia.github.io/theia/docs/next/documents/Plugin-API.html)
明确：`plugin-vscode-init.ts` 是将已经由 `plugin-ext` 提供的 Theia API
转给 `vscode` 模块，再覆盖少数差异；真实 API/进程/RPC 并不在 init 文件里。
因此**单拆 init 文件无法获得可工作的 VS Code L2 执行 API**；拿来替换
Mcode 子进程桥反而重新引入 Theia 宿主/Monaco/editor。此结论是源码架构可拆性判断
（E2/D），**不是**声称做过完整 Theia 运行时兼容性测试。

| 方案 | 明确的依赖数 | 许可 | 与当前 Electron/React/Monaco 冲突 | 可拆用程度 | 决定 |
|---|---:|---|---|---|---|
| 整包 `@theia/plugin-ext-vscode@1.76.0` | 19 个直接依赖，传递未知 | EPL-2.0 **OR** GPL-2.0-only WITH Classpath-exception-2.0 | 绑定 Theia core/editor/monaco/plugin-ext；与 Mcode 现有 Monaco/React/Electron 的集成冲突风险，**尚未安装实测** | 低（非轻量依赖） | **本片不引入** |
| 单取 `plugin-vscode-init.ts` | 自身依赖 `plugin-ext` 的 API 宿主，无法视为 0 | 继承上游许可及通知义务 | 无原生 Theia API/RPC 时不能单独执行；移植需重建大量宿主 | 低 | **不可按单文件直接拆用** |
| `@types/vscode@1.95.0` + Mcode 现有 ModuleHost 单资源映射 | 0 个直接运行时依赖（类型包元数据依赖为空） | MIT（类型包） | 不引入 Theia/Monaco；接口语义未实现的部分必须明确报不支持 | 中（只复用 API 形状与成熟宿主） | **本片选用的降级思路**，当前未安装该类型包 |
| 保持仅 L1 | 0 个新增依赖 | 仅本仓许可 | 无新增 | 高，但没有 L2 | 安全回退方案 |

**许可证边界**：本次没有复制、链接、分发 Theia 源码/二进制，
因此暂不向本仓添加 Theia LICENSE/NOTICE。若未来实际引入/改动/分发，
必须锁定上游 commit/包版本，随分发保留适用许可证、版权告知和项目
NOTICE（若有），履行所选 EPL 或 GPL+Classpath exception 的相应源码/修改义务，
并审计所有传递依赖许可证；**只改成动态链接并不能自动免除分发义务**。
最终法律合规由发行方复核，不把设计判断当法律意见。
Open VSX 只是来源，不是宿主；`@vscode/test-electron` 是测试工具，
不是能向 Mcode 提供 VS Code API 的运行时。

### 6.2 第 1–2 步：API 映射（仅已明确支持的单资源边界）

| VS Code API (L2 类别) | Mcode 既有通路/映射 | 需要新权限 | 实际状态 |
|---|---|---|---|
| `workspace.fs.readFile` / `writeFile` | `VscodeL1Bridge.executeCommand → ModuleHost.invoke → authorize → resolveResource → permissionedProcessRunner`；子进程在已准许的**唯一** `ModuleResource.path` 上读写 | read 已有 `resource.read`；write 必须在清单显式声明 `resource.write` 并经 `requestApproval` **每次批准** | 单文件 `Uri.file`、最大 1 MiB；没有目录遍历、其他 URI schema、CAS/撤销编辑；不冒充完整 `workspace.fs` |
| `workspace.getConfiguration` | 可信宿主从 SettingRepo 提供该扩展**非敏感**配置投影，安装时固化到子进程只读快照；`getConfiguration(section).get(key)` | 无额外权限，但只认 `publisher.name` 命名空间 | 无实时监听、设置写回；调用方须注入快照，不能让扩展直接读宿主数据库 |
| `window.showInformationMessage` / `showWarningMessage` | 子进程限额 DTO → 同一 `ModuleHost.invoke` 结果 → 可信 `notify` 回调；回调应接现有 Toaster/通知服务 | 不增扩展权限 | 若没有通知端口**明确报错**；不直接弹系统窗口；只支持纯文本无交互按钮 |
| `commands.executeCommand` / `registerTextEditorCommand` | L1 单命令经 `ModuleHost.invoke`；可改用 L2 `registerTextEditorCommand` 为只读选择文档上下文（只选当前文件） | 读已有；编辑**不**支持 | 没有编辑器版本/选择区/撤销事务的端到端接口；`editor.edit` 明确抛 unsupported |
| `languages.createDiagnosticCollection` | 受限诊断 DTO → 同一 `ModuleHost.invoke` 结果 → 可信 `publishDiagnostics` 端口；由调用方映到既有 LSP/Monaco 诊断流 | 无额外权限（仅所选文档） | 仅本次调用快照、不持久订阅；没端口明确报错，不声称真 LSP UI 已接入 |
| `window.createStatusBarItem` | 保持已有 L1 快照，不做新 UI | 无 | L1 行为不变 |

**复用五类 / 新业务实现零套**：文件/命令复用既有
`ModuleHost` 与受控子进程；配置、通知、诊断以宿主输入/输出 DTO 胶水接口承接。
**没有创建第二条授权或执行通道**。扩展源只通过 `require("vscode")` 访问上述
狭义 API，超界操作抛错；没有自造 `vscode.d.ts`。
源码：`apps/desktop/src/main/modules/vscodeL1Bridge.ts`。
回归：**只追加到现有** `apps/desktop/scripts/vscode-l1-smoke/main.ts`。

### 6.3 证据、未覆盖与诚实边界

- 新增正常、未授权、越界、撤权/审批拒绝和缺宿主 UI 端口的动态断言；
  各 API 都通过实际 `ModuleHost.invoke`，不是直接调用裸 shim。
- 本片**仍不是完整 L2 / Theia VS Code 兼容宿主**：未实现真实编辑器写入事务、
  跨调用配置变化监听、持久诊断集合/文档版本、通知按钮，以及真实 renderer/LSP
  服务消费者；`writeFile` 仍缺 CAS 和原子替换。即使 E1 通过，
  不可替代真实 VSIX/Electron/跨平台 U1。
- Node `--permission` 的原有 OS/网络约束与风险不因本切片提升等级；本片未引入
  Theia 核心、Open VSX 下载或通用第三方插件运行时。

**2026-10-21 验证回写**：当前工作树 `apps/desktop/scripts/module-*-smoke/run.sh`
只存在 **13 套**，不是卡片背景描述的 17 套；13 套全部实测通过。
`node apps/desktop/scripts/run-smokes.mjs` 同时跑这 13 套与
`vscode-l1-smoke`，**14/14 PASS**。
`vscode-l1-smoke` **25/25 PASS**（包括编辑器命令越界拒绝）。
`npx tsc --noEmit -p apps/desktop/tsconfig.json` +
`npx tsc --noEmit -p packages/contracts/tsconfig.json` 均 exit 0。
变异验证在项目内临时脚本 `.tmp/t14-mutation.cjs` 执行，
撤掉 L2 `resource.write` 显式检查 → **24/25 红**；
撤掉 L2 文件路径唯一资源围栏 → **22/25 红**；恢复原文件的
SHA-256 为 `f6117bc18bc6a12017621281e3f0d2f7821338b526b00ece29537e4ef94bb900`，
无永久源码变异。变异为 E1 隔离验证，不代表 U1。
