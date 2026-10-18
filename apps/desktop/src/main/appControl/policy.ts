/**
 * **mcode-app 的权限表** —— 每个 Mcode 功能(RPC 方法)归到五档之一。
 *
 *   - `read`   只读:自动放行。
 *   - `ui`     只动界面(切会话、开面板、弹提示):自动放行 —— 不改任何数据。
 *   - `write`  有副作用:弹审批卡;用户可勾「始终允许」(按**方法**记,不是整组)。
 *              权限模式为「完全访问」(bypassPermissions)时不问。
 *   - `danger` 高风险(装插件/MCP/钩子、删项目、改密钥/模型地址、迁数据目录、
 *              改权限、开公网……):**每次都弹**,卡片上不给「始终允许」,
 *              「完全访问」也照问。用户在 2026-10-02 明确选的就是这一档。
 *   - `blocked` 不开放:替用户回答审批/提问(自己批自己)、读 API Key、
 *               依赖麦克风/系统对话框/编辑器内部状态、会直接改写聊天记录底层存储的,
 *               以及**返回体里带凭据本体**的方法(见 {@link CREDENTIAL_BEARING})。
 *
 * 判定顺序:显式表(BLOCKED → 凭据本体 → DANGER → WRITE/READ/UI 例外)→ 按动词猜 → 兜底 `write`。
 * **兜底是 write 而不是 read** —— 新加的 RPC 没人来归类时,宁可多问一次。
 */

export type AppPolicyLevel = "read" | "ui" | "write" | "danger" | "blocked";

/**
 * 【MC-014】**副作用档位** —— 与「谁有权调用」分开的**另一个维度**。
 *
 * 台账第十五轮复核点名的根因:把授权级别当副作用档位用 —— `scene.apply` /
 * `scene.resume` / `unattended.run` 因为**不给 Agent**(`blocked`)而被幂等账本判成
 * "无副作用",于是原生桌面用户重试同一个 `__operationId` 会**重复执行**真实写操作。
 *
 * 两件事本来就正交:
 *   - `level` 回答"谁能调"(blocked = 谁都不能 / danger = 每次问 / write = 问一次 …);
 *   - `effect` 回答"调用有没有副作用"(决定**要不要进幂等账本**、抛错算不算 UNCERTAIN)。
 *
 * 默认由 `level` 推导(write/danger → mutating,其余 → readonly);**被 blocked 但确有
 * 副作用的**通道在 {@link BLOCKED_MUTATING} 里显式列出 —— 它们只有桌面渲染端够得到,
 * 而桌面用户同样会重试。判据只有这一份,三通道(桌面 IPC / 面板 / 手机)与
 * `sideEffectClassOf` 共用。
 */
export interface AppPolicy {
  level: AppPolicyLevel;
  /** blocked / danger 的原因(给模型和审批卡看)。 */
  reason?: string;
  /** 【MC-014】副作用档位;缺省按 `level` 推导(见 {@link sideEffectOfLevel})。 */
  effect?: "readonly" | "mutating";
}

const BLOCKED: Record<string, string> = {
  "claude.approve": "不能替用户批准工具调用(那等于自己批自己)",
  "claude.respondQuestion": "不能替用户回答提问卡",
  "claude.respondPlanApproval": "不能替用户批准计划",
  "workflow.approve": "自动化/导入工作流的执行授权只能由用户本人给",
  // 【MC-061】主机 hook 授权(插件 hook 的执行授权)的签发 / 撤销 = 「用户点头」这件事的
  // 落点 —— 与 `workflow.approve` 同一条纪律。agent **任何理由都不该**签出 / 撤销它(签了
  // 就等于自己给自己授权去跑不受信命令),故直接 **blocked**(不是"每次弹卡"),让
  // `app_api_call` 与自定义面板的 `mcode.api.call` 都够不到;真正够得到的只有桌面渲染端。
  "hooks.issueHostHookGrant": "插件 hook 的执行授权只能由用户本人在插件面板签发",
  "hooks.revokeHostHookGrant": "插件 hook 授权只能由用户本人撤销",
  // 【MC-036】用户模块的**工作流运行授权**(自动运行权)的签发 / 撤销 = 同一件「用户点头」
  // 的事:agent 任何理由都不该把"这个模块菜单能调"自行升成"这个模块可以自动跑",故
  // 与 hostHookGrant / workflow.approve 一样钉 **blocked**(不是"每次弹卡"),让
  // `app_api_call` 与 `mcp.api.call` 都够不到;真正够得到的只有桌面设置页。
  "modules.issueWorkflowGrant": "用户模块的工作流运行授权只能由用户在模块设置里授权",
  "modules.revokeWorkflowGrant": "用户模块的工作流运行授权只能由用户本人撤销",
  "customModel.getToken": "API Key / 令牌不给模型",
  "piModels.getApiKey": "API Key 不给模型",
  "codexModels.getApiKey": "API Key 不给模型",
  // 【MC-004】`relay.getConfig` / `onlyoffice.getConfig` / `onlyoffice.detectLocal` /
  // `webBridge.*` / `publicMcp.*` 这一批**凭据本体方法**从前逐条列在这里或散在
  // `DANGER` / `EXPLICIT` 里 —— 判据不统一、按名追漏正是漏掉 `relay.getConfig` 的原因。
  // 现已收成下面唯一一张表 {@link CREDENTIAL_BEARING}，`policyFor` 里先于动词兜底执行。
  // 加新方法请加**那张表**，不要再往这里加。
  "voice.start": "需要麦克风音频流,只能在界面上用",
  "voice.feed": "需要麦克风音频流,只能在界面上用",
  "voice.stop": "需要麦克风音频流,只能在界面上用",
  "voice.cancel": "需要麦克风音频流,只能在界面上用",
  "browser.setBounds": "界面布局内部接口;操作网页请用 mcode-browser 工具",
  "browser.setPickMode": "界面内部接口;操作网页请用 mcode-browser 工具",
  "browser.captureFrame": "界面内部接口;截图请用 browser_screenshot",
  "browser.show": "界面内部接口;打开浏览器面板请用 app_ui",
  "browser.hide": "界面内部接口;关闭浏览器面板请用 app_ui",
  "browser.authRespond": "网站登录凭据只能由用户本人填写",
  // 【ARC-007】文档视图是界面布局内部接口(与 browser.show/hide/setBounds 同档):
  // 视图的开关/几何/焦点由渲染端按用户操作驱动。文档**内容**操作走 document.* ——
  // 那是受围栏的 CLI 能力;视图本身不给 agent 摆布(否则它能弹出/隐藏用户的面板)。
  "documentView.open": "界面布局内部接口;读写文档内容请用 document.read / document.edit",
  "documentView.bounds": "界面布局内部接口;读写文档内容请用 document.read / document.edit",
  "documentView.show": "界面布局内部接口;文档视图由用户打开",
  "documentView.hide": "界面布局内部接口;文档视图由用户关闭",
  "documentView.focus": "界面布局内部接口;文档视图由用户操作",
  "documentView.close": "界面布局内部接口;文档视图由用户关闭",
  "lsp.openDocument": "编辑器内部接口",
  "lsp.closeDocument": "编辑器内部接口",
  "lsp.didChange": "编辑器内部接口",
  "lsp.didSave": "编辑器内部接口",
  "lsp.request": "编辑器内部接口",
  "terminal.resize": "界面内部接口",
  "session.saveMessages": "会直接改写聊天记录的底层存储;发消息请用 app_session_send",
  "session.upsertMessages": "会直接改写聊天记录的底层存储",
  "session.truncateAndInsertMessages": "会直接改写聊天记录的底层存储",
  "dialog.pickFolder": "会弹系统对话框等用户操作;直接传路径给对应功能即可",
  "dialog.pickFiles": "会弹系统对话框等用户操作;直接传路径给对应功能即可",
  "file.pickImages": "会弹系统对话框等用户操作",
  "setting.exportToFile": "会弹系统保存框等用户操作;导出设置请让用户在 设置 → 通用 里点「导出设置」",
  "setting.importFromFile": "会弹系统打开框并整批改写设置;只能由用户本人在设置页操作",
  // 【MC-026】Agent 可编排的等价入口(**不弹对话框**)。两条都是 danger:导入会整批改写
  // 设置、导出会把整套偏好写到指定路径 —— 每次都要用户在审批卡上本人点头;清洗与
  // 备份走与界面完全相同的那一份服务(`exportSettingsToPath` / `importSettingsFromText`)。
  // (这两条不放进 BLOCKED:blocked 是"谁都够不到",而这里要的是"够得到但每次都批"。)
  "customUi.stagePanel": "自定义面板的界面内部接口;要建面板请改设置 customUi.config.v1",
  "customUi.panelAsk": "自定义面板内部接口;要问模型请直接发消息",
  // ⚠️ **绝不能开给 agent。** 这条是面板的通用调用口,它带一个 `approved` 位 —— 面板
  // 脚本自己发不出它(要经渲染端的桥,由用户点头后补),但 agent 经 `app_api_call`
  // 就能传 `{approved:true}` 把面板那层确认**整个绕过**、直接执行写/高风险操作。
  // 面板要用它走的是渲染端 IPC(不经 `app_api_call`),所以这里拦掉不影响面板。
  "customUi.panelApiCall": "自定义面板内部接口;要调功能请直接用 app_api_call(它自己会走审批)",
  // 【MC-058】场景部署的两条**写**通道 —— 与 `workflow.approve` / `hooks.issueHostHookGrant`
  // 同一条纪律:批准一份会在本机建工作流 / 装钩子 / 写 MCP 配置的**计划**,是「用户点头」
  // 这件事本身。agent 任何理由都不该自己批自己的计划(批了就等于自己给自己授权去建资源),
  // 故直接 **blocked**,让 `app_api_call` 够不到;真正够得到的只有桌面渲染端。
  // ⚠️ 这两条**没进 `API_CATALOG`**(是渲染端专用通道),若不在 BLOCKED 表里,`policyFor`
  // 的动词兜底会按 `approve` / `apply` 猜 —— `apply` 会落到兜底 `write`(弹卡),`approve`
  // 同样落到 `write`。那意味着 agent 能弹出审批卡去批准一个计划 —— 这正是要堵的死角。
  "scene.approve": "场景部署的计划级授权只能由用户在预览页本人批准",
  "scene.apply": "场景部署只能由用户在预览页批准后执行",
  // 【MC-002】续跑与 apply 同一条纪律:它同样是**执行**一条会在本机建资源的计划
  // (只是跳过已 done 的步骤),授权判定与 apply 逐字同源 —— agent 侧一律够不到。
  "scene.resume": "场景续跑只能由用户在预览页批准后执行",
  // 【MC-002】只读列表也不给 agent:它带整条部署记录(步骤/资源 uid/错误),是"用户看"
  // 的面,且与 approve/apply/resume 同一族(agent 拿到也做不了任何事,只会误以为能自行续跑)。
  "scene.listDeployments": "场景部署记录只在桌面预览页展示",
  // 【ARC-007】文档能力:读走只读档;编辑/转换写盘 —— 走 write 档(弹审批),
  // 与其它写功能同一条纪律。capabilities 是只读诊断。
  "document.read": "read",
  "document.capabilities": "read",
  // 【MC-059】无人值守任务计划的两条**写**通道 —— 与 `scene.approve` / `scene.apply` 完全
  // 同一条纪律:批准一份会**真的建会话 / 发首条消息**的计划,是「用户点头」这件事本身。
  // agent 任何理由都不该自己批自己的计划(批了就等于自己给自己授权去建会话),故直接
  // **blocked**,让 `app_api_call` 够不到;真正够得到的只有桌面渲染端。
  // ⚠️ 这两条的动词(`approve` / `run`)不在 `EXPLICIT` 表里 —— 若不显式钉 blocked,
  // `policyFor` 的动词兜底会把它们猜成 `write`(弹卡),那意味着 agent 能弹审批卡去批准一个
  // 计划 —— 这正是要堵的死角。
  "unattended.approve": "无人值守任务计划的授权只能由用户在计划预览页本人批准",
  "unattended.run": "无人值守任务计划只能由用户批准后执行",
  // 【MC-059 残余 ④】无人值守计划的**跨重启**面(列出等待中 / 续跑 / 放弃)—— 与上面两条同一条
  // 纪律:**续跑**会在本机真的建会话 / 发首条,是「用户点头」的执行那半,agent 不该自己续自己
  // 批过的计划;`list` 虽是只读,但它读的是「哪些计划在等用户批准」这类**治理事实**,也不开给
  // agent(与 `agentSsh.list` 同取向)。三条一律 blocked。
  "unattendedPlans.list": "无人值守计划的等待列表是用户的治理视图,agent 不必读",
  "unattendedPlans.resume": "续跑无人值守计划会在本机建会话,只能由用户本人发起",
  "unattendedPlans.abandon": "放弃计划是用户的治理动作,只能由用户本人发起"
};

const DANGER: Record<string, string> = {
  // 扩展能力:装上就能在用户机器上跑代码 / 改 agent 的指令
  "plugins.installLocal": "安装插件(插件可带钩子、MCP 服务器和技能)",
  "plugins.installGit": "从 Git 安装插件",
  "plugins.installMarketplace": "从市场安装插件",
  "plugins.remove": "卸载插件",
  "plugins.setEnabled": "启用/停用插件",
  "plugins.enginesSet": "改插件对各引擎的投递",
  "plugins.projectSet": "改项目里的插件启用/投递",
  "plugins.marketplaceAdd": "添加插件市场源",
  "plugins.marketplaceRemove": "移除插件市场源",
  "plugins.marketplaceRefresh": "刷新插件市场(会联网拉取)",
  "mcp.save": "新增/修改 MCP 服务器(会在本机启动进程或连外部服务)",
  // 【ARC-007】GenOffice 安装入口 = 往真相层写一条会在本机拉起 `genoffice mcp`
  // 进程的 stdio 条目(围栏是此刻的工作区根快照)。与 `mcp.save` 同档 ——
  // 用户点的那一下与「新增 MCP server」是同一件事,只是配置由 Mcode 自己生成。
  "mcp.genofficeInstall": "安装 GenOffice 文档工具 MCP 服务器(会在本机启动进程)",
  "mcp.remove": "删除 MCP 服务器",
  "mcp.toggle": "启用/停用 MCP 服务器",
  "mcp.enginesSet": "改 MCP 服务器对各引擎的可见性",
  "mcp.projectSave": "新增/修改项目 MCP 服务器(写 <项目>/.mcp.json,会在本机启动进程或连外部服务)",
  "mcp.projectRemove": "删除项目 MCP 服务器",
  "mcp.projectTrust": "信任/取消信任项目 MCP 服务器(信任后会被引擎启动)",
  // 【MC-026】Agent 可编排的设置迁移:导入会**整批改写**设置(审批必须每次本人点头),
  // 导出会把整套偏好写到调用方指定的路径(含公开元数据,密钥已由清洗核排除)。
  "setting.exportToPath": "把整套设置(已脱敏)写到指定路径",
  "setting.importFromText": "整批改写设置(导入前自动备份,可回退)",
  "mcp.projectCopy": "把总库 MCP 服务器复制进项目文件(连同其中的环境变量/请求头)",
  "mcp.authorize": "MCP 服务器 OAuth 授权",
  "mcp.unauthorize": "撤销 MCP 服务器授权",
  "mcp.import": "导入 MCP 服务器",
  "mcp.scanImport": "扫描其他工具的 MCP 配置(可能含凭据)",
  "hooks.save": "新增/修改钩子(会在事件发生时自动执行命令)",
  "hooks.remove": "删除钩子",
  "hooks.test": "试跑钩子命令",
  "skills.save": "新增/修改技能(会改变 agent 的行为指令)",
  "skills.import": "导入技能",
  "skills.importGithub": "从 GitHub 导入技能",
  "skills.delete": "删除技能",
  "skills.marketAdd": "添加技能市场源(会联网拉取仓库)",
  "skills.marketRemove": "移除技能市场源",
  "skills.marketRefresh": "刷新技能市场(会联网拉取)",
  "skills.marketInstall": "从市场安装技能(会改变 agent 的行为指令)",
  "mcp.marketSourceAdd": "添加 MCP 市场源(注册中心地址)",
  "mcp.marketSourceRemove": "移除 MCP 市场源",
  "modules.install": "安装扩展模块(可执行代码)",
  "modules.remove": "卸载扩展模块",
  "claude.saveSubagents": "改子代理定义(会改变 agent 的行为指令)",
  "context.save": "改全局指令(写入各引擎的 CLAUDE.md / AGENTS.md)",
  // 不可恢复 / 大范围
  "project.delete": "彻底删除项目及其全部对话(不可恢复)",
  "session.delete": "彻底删除对话(不可恢复)",
  "file.delete": "删除文件",
  // 【ARC-007】文档编辑/转换会**直接改写用户文档** —— 与删除同档(每次问、不可撤销)。
  "document.edit": "编辑并保存文档(会改写原文件)",
  "document.convert": "格式转换并写出新文件",
  "library.deleteItems": "从资料库删除条目(可选连文件一起删)",
  "library.deleteCollection": "删除资料库分类",
  "app.moveDataRoot": "迁移整个数据目录并重启应用",
  "app.quitAndInstall": "退出并安装更新",
  "runtimes.remove": "删除引擎运行时",
  "runtimes.install": "下载安装引擎运行时(可执行文件)",
  "runtimes.installLocal": "从本地安装引擎运行时(可执行文件)",
  "toolchain.install": "下载安装外部工具(可执行文件)",
  "toolchain.remove": "删除外部工具",
  "lsp.install": "下载安装语言服务器(可执行文件)",
  "lsp.installFromFile": "从文件安装语言服务器(可执行文件)",
  "lsp.uninstall": "卸载语言服务器",
  "lsp.setPath": "改语言服务器可执行文件路径",
  "rg.install": "下载安装 ripgrep(可执行文件)",
  "git.push": "推送到远程仓库",
  "git.discard": "丢弃未提交的修改(不可恢复)",
  "git.deleteBranch": "删除分支",
  "git.worktreeRemove": "删除工作树",
  "git.worktreeMergeBack": "把工作树合并回主分支",
  "git.merge": "合并分支",
  // 凭据 / 模型地址:改了就能把对话和密钥引到别处
  "customModel.save": "新增/修改自定义模型(含 API 地址与密钥)",
  "customModel.delete": "删除自定义模型",
  "customModel.test": "用给定密钥向给定地址发请求",
  "piModels.save": "新增/修改 Pi 模型提供方(含密钥)",
  "piModels.delete": "删除 Pi 模型提供方",
  "codexModels.save": "新增/修改 Codex 模型提供方(含密钥)",
  "codexModels.delete": "删除 Codex 模型提供方",
  // 【MC-004】`onlyoffice.setConfig` 已收进 {@link CREDENTIAL_BEARING}(它的返回体带 jwtSecret 原文)
  // —— 不再在这里留一条永不可达的死条目。
  // 远程访问:开了就是把这台机器交给别人。
  // 【MC-004】`webBridge.regenerateToken` / `publicMcp.*` 这一族返回体里都带凭据本体,
  // 已统一收进 {@link CREDENTIAL_BEARING}(blocked) —— 别再往这里加它们的同族方法。
  // SSH 主机信任审批:批准一台陌生主机的指纹 = 把凭据发给它。这条**本身就是"用户点头"的
  // 唯一落点**,绝不能由 agent 自批。虽然 `app_api_call` 只面向本机三个引擎(公网/浏览器桥
  // 不挂它),仍把所有 agent 可达路径钉在 danger(每次弹卡、不给始终允许、"完全访问"也照问),
  // 让"模型想自己批准一台主机"这件事在**每一道闸**上都被挡住。
  "agentSsh.approveHost": "批准 SSH 主机信任(把凭据发给这台主机);只能由用户在设置里本人操作",
  "agentSsh.revokeHost": "撤销 SSH 主机信任",
  // 【MC-004】`mobile.startPairing`(返回配对码 + nonce)收进了 {@link CREDENTIAL_BEARING}。
  "mobile.revokeDevice": "撤销已配对手机",
  "mobile.setLogin": "设置手机远程登录的账号密码",
  "mobile.clearLogin": "关闭手机远程的账号密码登录",
  "mobile.setTunnel": "改手机自有域名的隧道配置",
  "mobile.startTunnel": "启动手机自有域名的隧道(手机网页上公网)",
  "mobile.stopTunnel": "停止手机自有域名的隧道",
  "relay.saveConfig": "改中继服务器配置",
  "relay.connect": "连接中继服务器",
  "relay.disconnect": "断开中继服务器",
  // 权限 / 任意设置:可以借此放宽审批
  "setting.set": "直接改设置项(可能涉及权限、工具规则等)",
  "session.updateSettings": "改对话的模型 / 权限模式",
  "notification.setPrefs": "改通知偏好",
  "workflow.choose": "替用户在工作流岔路口选择",
  "automation.watchTemplatesSave": "改守望模板",
};

/** 动词猜不准、需要钉死的几条。 */
const EXPLICIT: Record<string, AppPolicyLevel> = {
  // ⚠️ **动词前缀的陷阱(2026-10-08)。** `policyFor` 的兜底是拿**动词前缀**正则
  // (`^history`、`^check`…)猜"只读",于是**名字像只读、实际会写**的方法会被静默放行:
  //   - `browser.historyClear` / `browser.historyRemove` —— 以 `history` 开头,但**清空 /
  //     删除**地址栏历史(写设置键);
  //   - `git.checkout` —— 以 `check` 开头,但会**切分支、改工作区文件**。
  // 这几条必须显式钉在 write 档,否则 agent 能不经审批跑它们。`app-control-smoke` 里
  // 有一条系统性断言盯着"同类新方法"不再落进这个坑。
  "browser.historyClear": "write",
  "browser.historyRemove": "write",
  "git.checkout": "write",
  "notification.focusSession": "ui",
  "shell.showItemInFolder": "ui",
  "library.revealFile": "ui",
  "library.openFile": "ui",
  "shell.openFile": "write",
  "shell.openPath": "write",
  "app.checkForUpdates": "read",
  "toolchain.check": "read",
  "lsp.healthCheck": "read",
  "lsp.prewarm": "read",
  "provider.healthCheck": "read",
  "provider.commands": "read",
  "library.itemManifest": "read",
  "library.manifest": "read",
  "library.entryPath": "read",
  "library.deletePreview": "read",
  "library.fullTextSearch": "read",
  "library.conversionStats": "read",
  "library.conversionReport": "read",
  "library.linksOf": "read",
  "library.linkCounts": "read",
  "memory.review": "read",
  "memory.categories": "read",
  "workflow.nodeTypes": "read",
  "workflow.agentProfiles": "read",
  // 【MC-007】出厂预置列表只读(列出装包带了哪些可导入内容)。
  "workflow.listPresets": "read",
  // 导入 = 往库里新增一行工作流,与 `workflow.import` 同一档(写,每次审批)。
  "workflow.importPreset": "write",
  "session.messages": "read",
  "session.hasNodes": "read",
  "tools.usage": "read",
  "usage.stats": "read",
  "mobile.getActiveCount": "read",
  "skills.bundles": "read",
  "skills.scanSources": "read",
  "skills.projectOverview": "read",
  "git.diff": "read",
  "git.log": "read",
  "git.fileBlob": "read",
  "git.showCommit": "read",
  "git.showFile": "read",
  "git.mergePreview": "read",
  "git.discoverRepos": "read",
  "rg.status": "read",
  "automation.runs": "read",
  "automation.sessions": "read",
  "automation.statusAll": "read",
  "automation.watchStatus": "read",
  "automation.watchTemplates": "read",
  "runs.history": "read",
  "monitoring.overview": "read",
  "monitoring.runs": "read",
  "hooks.runs": "read",
  // 【MC-061】列出主机 hook 授权是只读(设置 → 插件 → 钩子授权);签 / 撤在上面 BLOCKED 档。
  "hooks.listHostHookGrants": "read",
  "projectInit.preview": "read",
  // 【MC-006】出厂初始化预设列表只读;导入=往库里新增一条模板,按写处理(每次审批)。
  "projectInit.listPresets": "read",
  "projectInit.importPreset": "write",
  "outputStyle.list": "read",
  // 【MC-004】`onlyoffice.detectLocal` 从前钉在这里 —— 它返回体里带 jwtSecret,已收进
  // {@link CREDENTIAL_BEARING}(blocked)。要看状态用 `onlyoffice.status`(连通性,不含密钥)。
  "onlyoffice.sessionState": "read",
  "theme.get": "read",
  "voice.modelList": "read",
  "voice.getModelDir": "read",
  "mcp.projectList": "read",
  "plugins.projectList": "read",
  "skills.marketList": "read",
  "mcp.marketSources": "read",
  "mcp.marketSearch": "read",
  // SSH 主机信任审批的列表是只读(候选指纹 + 已信任主机);批准/撤销在上面 DANGER 档。
  "agentSsh.list": "read",
  // memory.manage 的 list/preview 是只读,但 import 会写 —— 整体按写处理
  "memory.manage": "write",
  "memory.assistant": "write",
};

const READ_VERB = /^(list|get|read|status|search|info|stats|overview|catalog|history|runs|sessions|tasks|task|has|show|preview|check|describe|count)/;

/**
 * 【MC-004】**凭据本体方法** —— 返回体里带明文密钥 / 令牌的方法,一律不开放给
 * `app_api_call`(agent)与 `panelApiCall`(自定义面板)。值是每个方法的**引导语**,
 * 会出现在拒绝理由与 `app_api_describe` 里,告诉模型"要看状态该走哪条路"。
 *
 * ## 为什么是一张独立的表,而不是继续往 `BLOCKED` 里逐条加
 *
 * 加进 `BLOCKED` 是**逐条追漏**:`relay.getConfig` 当初就是因为名字里没有 `*Token`/`*ApiKey`
 * 而漏在按名兜底之外、单独补进去的(见上面那条注释)。同一天还有几个同类方法走的是
 * `policyFor` 的**动词兜底** —— `getConfig` / `status` 都以读动词开头 → 判 `read` →
 * **自动放行**,只靠 `redactValue` 的**字段名正则**打码。而打码本身按仓库自己的注释就是
 * 脆的(「打码靠键名、换个字段名就漏」)。于是同一件事有三种判据:relay 钉 blocked、
 * 同族靠动词兜底 + 键名打码、setting 键靠 `isSecretSettingKey`。违反 README 硬规矩 5。
 *
 * 这张表把「返回体含凭据本体」收成**一处**,在 `policyFor` 里**先于**动词兜底执行。
 * 判据是「这个方法返回**密钥本身**」,不是「名字里带密钥词」—— 按名猜正是漏掉
 * `relay.getConfig` 的原因。
 * ⚠️ **同族要全收**:`publicMcp` 的 `setEnabled` / `startTunnel` 这类**写**方法返回的也是
 * 同一份 `publicMcpStatus()`(含主密钥),只收 `status` 等于把同一条泄漏留在隔壁方法上。
 * 判断标准一句话:**返回体里有没有可以直接拿去用的凭据** —— 有就收进来,写方法也一样。
 *
 * ⚠️ **加新方法之前先问**:它返回的字段里有没有**可直接拿去用的**凭据?
 * 若是「有没有配 / 连没连上 / 地址是什么」这类**摘要**,不要加进来 —— 那是该给模型看的
 * (`relay.status` / `onlyoffice.status` / `mobile.getStatus` / `git.status` 就是不收的先例)。
 * 真需要状态,请给那个域加一个**不含密钥的摘要方法**。
 */
const CREDENTIAL_BEARING = new Map<string, string>([
  // 中继配置含明文 SSH 密码(`RelayVpsConfig.password`)。要看状态用 relay.status。
  ["relay.getConfig", "中继配置含明文 SSH 密码;要看状态用 relay.status(不含凭据)"],
  // ONLYOFFICE 配置含文档服务器的 JWT 密钥(`jwtSecret`,签发/伪造回调令牌用)。
  // 要看状态用 onlyoffice.status(连通性)或 onlyoffice.sessionState(会话)。
  ["onlyoffice.getConfig", "只读配置里有 JWT 密钥;要看状态用 onlyoffice.status"],
  // 本机探测结果里带着同一个 jwtSecret(见 localInstall 的 detectLocal)。
  ["onlyoffice.detectLocal", "本机探测结果里带 JWT 密钥;要看状态用 onlyoffice.status"],
  // 【MC-004 复核补漏】写入口**返回的也是同一份 `OnlyOfficeConfig`**(含 `jwtSecret` 原文,
  // 见 `setOnlyOfficeConfig` 的返回)。从前它只走 DANGER(每次弹卡),模型点一次卡就能拿到
  // 密钥 —— 与 `getConfig` 同一条洞。设置页经 `window.api` 直接调,不走这里,不受影响。
  ["onlyoffice.setConfig", "写入返回体里带 JWT 密钥;配置请在 设置 → 文档工具链 里改"],
  // 扩展桥状态里带 `token`(浏览器扩展的配对令牌,拿到即可冒充扩展)。
  ["webBridge.status", "状态里带浏览器扩展配对令牌,拿到即可冒充扩展"],
  ["webBridge.regenerateToken", "返回新的扩展配对令牌(已连的扩展会被断开)"],
  // 公网 MCP:**这个域的每个方法**返回体都是同一份 `publicMcpStatus()` —— 含 `secret`
  // (公网端点的主密钥)与 `projectLinks[].secret`(每条项目链接的明文路径密钥)。拿到
  // 就等于拿到免审批通道,所以整个域一律不开放。设置页走自己的 `window.api`,不受影响。
  ["publicMcp.status", "状态里带公网主密钥与各项目链接密钥;请在设置 → 公网 MCP 里查看"],
  ["publicMcp.setEnabled", "返回体带公网主密钥;开关公网 MCP 请用户在设置里操作"],
  ["publicMcp.regenerateSecret", "返回新的公网主密钥"],
  ["publicMcp.startTunnel", "返回体带公网主密钥;启动隧道请用户在设置里操作"],
  ["publicMcp.stopTunnel", "返回体带公网主密钥;停止隧道请用户在设置里操作"],
  ["publicMcp.setProject", "返回体带公网主密钥;改沙箱项目请用户在设置里操作"],
  ["publicMcp.setTunnelConfig", "返回体带公网主密钥;改隧道配置请用户在设置里操作"],
  ["publicMcp.addProjectLink", "返回体带新链接密钥与公网主密钥;加项目链接请用户在设置里操作"],
  ["publicMcp.removeProjectLink", "返回体带公网主密钥;删项目链接请用户在设置里操作"],
  ["publicMcp.regenerateProjectLinkSecret", "返回新的项目链接密钥"],
  // 配对返回里有 `nonce` + 6 位配对码 —— 拿到就能换一台设备令牌(手机端全功能面)。
  ["mobile.startPairing", "返回配对码与 nonce,拿到即可换设备令牌;配对请用户在设置里发起"],
]);

/** 这个方法是不是「返回体含凭据本体」的(见 {@link CREDENTIAL_BEARING})。 */
export function isCredentialBearingMethod(method: string): boolean {
  return CREDENTIAL_BEARING.has(method);
}

/** 某个方法的权限档。未知方法按 `write` 处理(宁可多问)。 */
/**
 * 【MC-014】被 blocked 但**一定会产生副作用**的方法 —— 幂等账本必须照看它们。
 *
 * 为什么要单列:这些方法对 Agent 是 blocked(审批/执行权只属于用户本人),只有桌面
 * 渲染端会调;但"用户自己重试"和"Agent 重试"在幂等上是同一件事 —— 同一个
 * `__operationId` 第二次到达时必须回放/拒绝,而不是再执行一遍。把它们标成只读会让
 * `dbGuardedIpc` / `panelApiCall` 直接跳过账本(第十五轮复核的实测反例)。
 *
 * 只收**真正会改东西**的;`scene.listDeployments` / `unattendedPlans.list` 这类只读
 * 治理视图虽然也 blocked,但重试没有副作用,留在默认只读档(不给一次整库 fsync)。
 */
const BLOCKED_MUTATING: ReadonlySet<string> = new Set([
  "claude.approve",
  "claude.respondQuestion",
  "claude.respondPlanApproval",
  "workflow.approve",
  "hooks.issueHostHookGrant",
  "hooks.revokeHostHookGrant",
  "modules.issueWorkflowGrant",
  "modules.revokeWorkflowGrant",
  "scene.approve",
  "scene.apply",
  "scene.resume",
  "unattended.approve",
  "unattended.run",
  "unattendedPlans.resume",
  "unattendedPlans.abandon",
]);

export function policyFor(method: string): AppPolicy {
  if (method in BLOCKED) {
    return {
      level: "blocked",
      reason: BLOCKED[method],
      // 【MC-014】副作用与「谁能调」正交 —— 见 BLOCKED_MUTATING 的注释。
      ...(BLOCKED_MUTATING.has(method) ? { effect: "mutating" as const } : {}),
    };
  }
  // 【MC-004】凭据本体方法**先于**动词兜底判掉 —— 否则 `getConfig` / `status` 会被
  // `READ_VERB` 判成 `read` 自动放行。与 BLOCKED 同一档:不给模型,也不给「始终允许」。
  const credential = CREDENTIAL_BEARING.get(method);
  if (credential !== undefined) return { level: "blocked", reason: credential };
  if (method in DANGER) return { level: "danger", reason: DANGER[method] };
  const explicit = EXPLICIT[method];
  if (explicit) return { level: explicit };
  const verb = method.slice(method.lastIndexOf(".") + 1);
  if (READ_VERB.test(verb)) return { level: "read" };
  return { level: "write" };
}

/** 各功能域的一句话说明(`app_api_list` 不带参数时给模型看的目录)。 */
export const DOMAIN_LABELS: Record<string, string> = {
  project: "项目:新建、列出、重命名、归档、分组、置顶、删除",
  session: "对话:列出、搜索、读消息、重命名、归档、置顶、分叉、删除、书签",
  claude: "对话运行:新建对话、发送、中断、插话、回退一轮、子代理",
  setting: "设置键值:读/写任意设置项",
  provider: "引擎:列出可用引擎与模型、健康检查、斜杠命令",
  customModel: "自定义模型(API 地址/密钥)",
  piModels: "Pi 模型提供方",
  codexModels: "Codex 模型提供方",
  theme: "主题",
  library: "资料库:条目、分类、笔记、导入、转 Markdown、关联、清单、挂到对话",
  memory: "长期记忆:列出、读、存、删、审阅、整理助手",
  workflow: "工作流:列出、读、保存、删除、导入导出、节点类型、代理档案、岔路选择、失败重试",
  automation: "自动化:立即运行、运行记录、守望",
  customUi: "自定义 UI:运行绑定的自动化",
  runs: "工作流运行历史",
  monitoring: "监控总览",
  projectInit: "项目初始化模板:列出、读、存、删、预览、应用",
  scene: "场景:校验候选声明、编译变更计划、部署前能力预检(只读,不执行)",
  // 【ARC-007】文档能力(GenOffice CLI 适配层):结构化读、按 ops 编辑、格式转换、能力诊断。
  document: "文档:读取结构(Word/PPT/Excel)、按操作编辑保存、格式转换、本机能力诊断",
  // 【ARC-007】受控文档视图宿主(界面层,与 browser 面板同档):视图的开关/几何/焦点。
  documentView: "文档视图宿主(界面层):打开/定位/显示/隐藏/聚焦/关闭编辑器视图、状态诊断",
  // 【MC-059】无人值守计划:用户签发计划级授权 + 有界执行(appServices/unattendedTaskPlan)。
  // 两条都在 BLOCKED 档(agent 够不到,见上),这里只给 `app_api_list` 一个域标签。
  unattended: "无人值守任务计划:用户签发计划级授权、有界执行(建会话)",
  // 【MC-059 残余 ④】计划跨重启面:列出等待中 / 续跑 / 放弃(同样全在 BLOCKED 档)。
  unattendedPlans: "无人值守计划跨重启:列出等待批准 / 待执行的计划、续跑、放弃",
  skills: "技能:列出、读、存、删、导入、复制到项目、预设、引擎可见性",
  plugins: "插件:列出、安装、卸载、启停、市场",
  mcp: "外部 MCP 服务器:列出、新增、删除、启停、授权、导入",
  agentSsh: "Agent SSH 主机信任:列出待批准候选指纹与已信任主机;批准/撤销由用户在设置里操作",
  hooks: "钩子:列出、运行记录、保存、删除、试跑",
  modules: "扩展模块",
  context: "全局指令(CLAUDE.md / AGENTS.md)",
  outputStyle: "输出风格",
  tools: "工具用量",
  usage: "用量统计",
  file: "项目文件:读、写、列目录、搜索、grep、新建目录、重命名、复制、删除",
  rg: "ripgrep 状态/安装",
  git: "Git:状态、暂存、提交、推送、拉取、diff、日志、分支、合并、工作树",
  terminal: "底部终端面板:新建、写入、结束、列出",
  shell: "用系统程序打开文件/目录",
  clipboard: "剪贴板",
  browser: "内置浏览器(界面层):书签、设备模拟、缓存、历史、下载",
  lsp: "语言服务器",
  onlyoffice: "OnlyOffice 文档编辑",
  notification: "系统通知偏好、聚焦对话",
  voice: "语音输入模型",
  app: "应用:版本信息、数据目录、检查更新",
  runtimes: "引擎运行时(Claude / Codex / Pi 可执行文件)",
  toolchain: "外部工具链(Pandoc / Python / LaTeX 等)",
  webBridge: "浏览器扩展桥",
  publicMcp: "公网 MCP",
  mobile: "手机配对",
  relay: "中继服务器",
  dialog: "系统对话框",
  // 这两个域有方法却没标签 —— `app_api_list` 按域列目录时它们会显示成无名域
  // (agent 看到「- engineTools(2):」后面空着)。补上,和别的域一条规矩。
  engineTools: "引擎内置工具的禁用清单(按引擎勾选/手填要砍掉哪些 SDK 自带工具)",
  extensionStore: "扩展专用数据区(某个扩展自己的键值存储,与项目/核心数据分开)",
};

/**
 * 【MC-039】**任务词别名** —— 用户/模型说人话(「创建自动化」)时的检索入口。
 *
 * `app_api_list({query})` 从前只做 `method.includes(q) || doc.includes(q)`:agent 拿
 * 用户原话「创建自动化」查 0 条,必须先知道内部术语 `automation.*` 才找得到。
 * 域标签({@link DOMAIN_LABELS})是**说明**不是检索词 —— 这里补一层"任务词 → 域",
 * 让查询按**意图**命中,精确方法名调用不受影响。
 *
 * 口径:
 *   - 键是**域**(与 `method` 第一个点号前的前缀同一套,别引进第二套分类);
 *   - 每条给中英任务词(词,不是句子);短词要挑不易误伤的(如 `自动化`)——
 *     命中面大一点没关系(返回的是候选列表,`app_api_describe` 再看细节);
 *   - **新增域时顺手想一句"用户会怎么找它"**;缺别名只是少一条检索路,不影响正确性。
 */
export const DOMAIN_TASK_ALIASES: Record<string, readonly string[]> = {
  project: ["项目", "工程", "创建项目", "新建项目", "project", "workspace"],
  session: ["对话", "会话", "聊天", "会话记录", "chat", "conversation", "history"],
  claude: ["跑对话", "发送消息", "中断", "插话", "回退", "子代理", "dispatch", "interrupt"],
  setting: ["设置", "配置", "偏好", "settings", "preference", "config"],
  provider: ["引擎", "模型", "切换模型", "健康检查", "provider", "model", "engine"],
  customModel: ["自定义模型", "网关", "api 地址", "密钥", "gateway", "api key"],
  piModels: ["pi 模型", "pi 提供方"],
  codexModels: ["codex 模型"],
  theme: ["主题", "外观", "深色", "浅色", "theme", "appearance"],
  library: ["资料库", "文献", "论文", "导入文献", "笔记", "library", "paper", "zotero"],
  memory: ["记忆", "长期记忆", "记住", "memory", "recall"],
  workflow: ["工作流", "流程", "编排", "节点", "workflow", "graph", "pipeline"],
  automation: ["自动化", "自动跑", "定时", "触发", "守望", "automation", "trigger", "watch"],
  customUi: ["自定义界面", "自定义面板", "面板", "扩展界面", "custom ui", "panel"],
  runs: ["运行记录", "执行历史", "runs", "execution history"],
  monitoring: ["监控", "总览", "monitoring", "overview"],
  projectInit: ["项目模板", "初始化模板", "脚手架", "template", "scaffold"],
  scene: ["场景", "部署", "预检", "scene", "deploy", "preflight"],
  document: ["文档", "编辑文档", "word", "docx", "ppt", "pptx", "excel", "xlsx", "pdf", "转换格式", "document", "convert"],
  documentView: ["文档视图", "编辑器视图", "文档窗口", "document view", "editor view"],
  unattended: ["无人值守", "计划授权", "自动执行计划"],
  unattendedPlans: ["未完成的计划", "续跑", "计划恢复"],
  skills: ["技能", "skill", "技能库"],
  plugins: ["插件", "扩展", "plugin", "extension"],
  mcp: ["外部工具", "mcp 服务器", "mcp server"],
  agentSsh: ["ssh 信任", "主机指纹", "ssh host"],
  hooks: ["钩子", "hook", "钩子脚本"],
  modules: ["模块", "module"],
  context: ["全局指令", "claude.md", "agents.md", "instructions"],
  outputStyle: ["输出风格", "output style"],
  tools: ["工具用量", "工具统计", "tool usage"],
  usage: ["用量", "花费", "统计", "usage", "cost", "tokens"],
  file: ["文件", "读写文件", "目录", "搜索文件", "file", "directory", "grep"],
  rg: ["ripgrep", "全文搜索"],
  git: ["git", "提交", "分支", "合并", "代码版本", "commit", "branch", "merge"],
  terminal: ["终端", "命令行", "terminal", "shell 面板"],
  shell: ["打开文件", "打开目录", "系统打开", "open", "explorer"],
  clipboard: ["剪贴板", "复制", "clipboard", "copy"],
  browser: ["浏览器", "内嵌浏览器", "网页", "browser", "web page"],
  lsp: ["语言服务器", "lsp", "language server"],
  onlyoffice: ["office", "文档编辑", "docx", "xlsx"],
  notification: ["通知", "notification", "提醒"],
  voice: ["语音输入", "语音模型", "voice"],
  app: ["应用信息", "版本", "更新", "version", "update"],
  runtimes: ["运行时", "引擎可执行文件", "runtime"],
  toolchain: ["工具链", "pandoc", "python", "latex", "toolchain"],
  webBridge: ["浏览器扩展桥", "网页模型", "extension bridge"],
  publicMcp: ["公网 mcp", "外网访问", "public mcp", "tunnel"],
  mobile: ["手机", "配对", "mobile", "pairing"],
  relay: ["中继", "relay", "服务器中转"],
  dialog: ["系统对话框", "选目录", "选文件", "dialog", "file picker"],
  engineTools: ["引擎工具禁用", "禁用工具", "disallowed tools"],
  extensionStore: ["扩展数据", "扩展存储", "extension store"],
};

/** 【MC-039】查一个查询词命中的域集合(大小写不敏感的子串匹配;域标签与任务别名都算)。
 *
 * 两个方向:
 *   - 正向:别名/标签**包含**查询(「自动化」→ alias「自动化」);
 *   - 反向:查询**包含**别名(整句「帮我创建自动化」→ alias「创建自动化」)——
 *     但这条只在查询**不像方法名**时启用:方法名里天然带着域词
 *     (`plugins.installGit` 含 "git"),反向匹配会把精确方法查询炸成一大片。
 *     判据:`/^[a-z_][a-z0-9_]*\.[a-z]/i` 形如 `域.方法` = 方法查询,不做反向。 */
export function domainsMatchingTaskWord(query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const out = new Set<string>();
  if (!q) return out;
  const looksLikeMethod = /^[a-z_][a-z0-9_]*\.[a-z0-9_]/i.test(query.trim());
  for (const [domain, label] of Object.entries(DOMAIN_LABELS)) {
    if (domain.toLowerCase().includes(q) || label.toLowerCase().includes(q)) out.add(domain);
  }
  for (const [domain, aliases] of Object.entries(DOMAIN_TASK_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase().includes(q) || (!looksLikeMethod && queryContainsAlias(q, a.toLowerCase())))) out.add(domain);
  }
  return out;
}

/** 反向匹配(`查询包含别名`)的判据 —— 【MC-039 复核补漏】裸 `q.includes(alias)` 会让
 *  短 ASCII 别名在**词内部**误伤:`"digital signature"` 含 `git`、`"happy path"` 类
 *  查询被拉进无关域。返回的是候选列表,但"列出一大片无关域"与"找不到"一样糟 ——
 *  用户会以为这就是全部相关操作。
 *
 *  规则:
 *   - **中文别名**没有词边界,按子串(整句「帮我创建自动化」要能命中「创建自动化」);
 *   - **ASCII 别名**要求前后不紧邻 ASCII 字母/数字(词边界),`git commit` 命中 `git`,
 *     `digital` 不命中;含空格的短语(如 `api key`)同样按两端边界判;
 *   - **短别名(<3 字符)不做反向** —— `pi`/`ai` 这类在任何英文句子里都会撞上,
 *     正向匹配(查询是别名的子串)仍保留。 */
function queryContainsAlias(q: string, alias: string): boolean {
  if (alias.length === 0) return false;
  // 中文/符号开头:无词边界概念,按子串(「扩展」两字也要能命中「创建扩展」)。
  if (!/^[a-z0-9]/.test(alias)) return q.includes(alias);
  // 短 ASCII 别名才禁用反向匹配(`pi`/`ai` 在任何英文句子里都会撞上)。
  if (alias.length < 3) return false;
  for (let from = 0; ; ) {
    const i = q.indexOf(alias, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : q[i - 1]!;
    const after = q[i + alias.length] ?? "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = i + 1;
  }
}
