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
 *              依赖麦克风/系统对话框/编辑器内部状态、会直接改写聊天记录底层存储的。
 *
 * 判定顺序:显式表(BLOCKED → DANGER → WRITE/READ/UI 例外)→ 按动词猜 → 兜底 `write`。
 * **兜底是 write 而不是 read** —— 新加的 RPC 没人来归类时,宁可多问一次。
 */

export type AppPolicyLevel = "read" | "ui" | "write" | "danger" | "blocked";

export interface AppPolicy {
  level: AppPolicyLevel;
  /** blocked / danger 的原因(给模型和审批卡看)。 */
  reason?: string;
}

const BLOCKED: Record<string, string> = {
  "claude.approve": "不能替用户批准工具调用(那等于自己批自己)",
  "claude.respondQuestion": "不能替用户回答提问卡",
  "claude.respondPlanApproval": "不能替用户批准计划",
  "workflow.approve": "自动化/导入工作流的执行授权只能由用户本人给",
  "customModel.getToken": "API Key / 令牌不给模型",
  "piModels.getApiKey": "API Key 不给模型",
  "codexModels.getApiKey": "API Key 不给模型",
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
};

const DANGER: Record<string, string> = {
  // 扩展能力:装上就能在用户机器上跑代码 / 改 agent 的指令
  "plugins.installLocal": "安装插件(插件可带钩子、MCP 服务器和技能)",
  "plugins.installGit": "从 Git 安装插件",
  "plugins.installMarketplace": "从市场安装插件",
  "plugins.remove": "卸载插件",
  "plugins.setEnabled": "启用/停用插件",
  "plugins.marketplaceAdd": "添加插件市场源",
  "plugins.marketplaceRemove": "移除插件市场源",
  "plugins.marketplaceRefresh": "刷新插件市场(会联网拉取)",
  "mcp.save": "新增/修改 MCP 服务器(会在本机启动进程或连外部服务)",
  "mcp.remove": "删除 MCP 服务器",
  "mcp.toggle": "启用/停用 MCP 服务器",
  "mcp.enginesSet": "改 MCP 服务器对各引擎的可见性",
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
  "modules.install": "安装扩展模块(可执行代码)",
  "modules.remove": "卸载扩展模块",
  "claude.saveSubagents": "改子代理定义(会改变 agent 的行为指令)",
  "context.save": "改全局指令(写入各引擎的 CLAUDE.md / AGENTS.md)",
  // 不可恢复 / 大范围
  "project.delete": "彻底删除项目及其全部对话(不可恢复)",
  "session.delete": "彻底删除对话(不可恢复)",
  "file.delete": "删除文件",
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
  "institution.save": "保存机构登录配置",
  "institution.delete": "删除机构登录配置",
  "institution.clearCookies": "清除网站登录状态",
  "onlyoffice.setConfig": "改 OnlyOffice 服务地址与 JWT 密钥",
  // 远程访问:开了就是把这台机器交给别人
  "webBridge.regenerateToken": "重置浏览器扩展令牌(已连的扩展会断开)",
  "publicMcp.setEnabled": "开关公网 MCP(开启后持有链接的人可免审批操作本机)",
  "publicMcp.regenerateSecret": "重置公网 MCP 密钥",
  "publicMcp.startTunnel": "启动公网隧道",
  "publicMcp.stopTunnel": "停止公网隧道",
  "publicMcp.setProject": "改公网 MCP 可写项目",
  "publicMcp.setTunnelConfig": "改公网隧道配置",
  "publicMcp.addProjectLink": "给项目新开一条公网 MCP 链接(持有链接的人可免审批操作该项目)",
  "publicMcp.removeProjectLink": "删除项目的公网 MCP 链接",
  "publicMcp.regenerateProjectLinkSecret": "重置项目公网 MCP 链接的密钥",
  "mobile.startPairing": "开始手机配对",
  "mobile.revokeDevice": "撤销已配对手机",
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
  "projectInit.preview": "read",
  "outputStyle.list": "read",
  "onlyoffice.sessionState": "read",
  "onlyoffice.detectLocal": "read",
  "theme.get": "read",
  "voice.modelList": "read",
  "voice.getModelDir": "read",
  // memory.manage 的 list/preview 是只读,但 import 会写 —— 整体按写处理
  "memory.manage": "write",
  "memory.assistant": "write",
};

const READ_VERB = /^(list|get|read|status|search|info|stats|overview|catalog|history|runs|sessions|tasks|task|has|show|preview|check|describe|count)/;

/** 某个方法的权限档。未知方法按 `write` 处理(宁可多问)。 */
export function policyFor(method: string): AppPolicy {
  if (method in BLOCKED) return { level: "blocked", reason: BLOCKED[method] };
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
  institution: "机构登录(知网/图书馆等)",
  memory: "长期记忆:列出、读、存、删、审阅、整理助手",
  workflow: "工作流:列出、读、保存、删除、导入导出、节点类型、代理档案、岔路选择、失败重试",
  automation: "自动化:立即运行、运行记录、守望",
  customUi: "自定义 UI:运行绑定的自动化",
  runs: "工作流运行历史",
  monitoring: "监控总览",
  projectInit: "项目初始化模板:列出、读、存、删、预览、应用",
  skills: "技能:列出、读、存、删、导入、复制到项目、预设、引擎可见性",
  plugins: "插件:列出、安装、卸载、启停、市场",
  mcp: "外部 MCP 服务器:列出、新增、删除、启停、授权、导入",
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
};
