// ⚠️ 生成文件,别手改。来源:packages/contracts/src/ipc/rpcMap.ts + src/preload/index.ts
// 重新生成:在 apps/desktop 下 `node scripts/gen-app-api-catalog.mjs`
export interface ApiCatalogEntry {
  method: string;
  channel: string;
  doc: string;
  input: string;
  output: string;
}

export const API_CATALOG: readonly ApiCatalogEntry[] = [
 {
  "method": "app.checkForUpdates",
  "channel": "app:checkForUpdates",
  "doc": "Check for updates on the GitHub Releases channel. Returns the current version when up-to-date, the new version when available, or an error. In dev this short-circuits to \"up-to-date\" (updater only runs in prod).",
  "input": "(无参数)",
  "output": "CheckForUpdatesResult"
 },
 {
  "method": "app.downloadUpdate",
  "channel": "app:downloadUpdate",
  "doc": "Start downloading the pending update (autoDownload is off, so the user opts in via this call). Resolves once the download begins; the `update:downloaded` push event fires when it's ready to install.",
  "input": "(无参数)",
  "output": "void"
 },
 {
  "method": "app.getDataRoot",
  "channel": "app:getDataRoot",
  "doc": "当前数据根,以及它下面两样东西的**实际路径**(设置页展示用)。",
  "input": "(无参数)",
  "output": "{ root: string; dbPath: string; libraryPath: string; }"
 },
 {
  "method": "app.info",
  "channel": "app:info",
  "doc": "App version + runtime info for the About panel.",
  "input": "(无参数)",
  "output": "AppInfoResult"
 },
 {
  "method": "app.moveDataRoot",
  "channel": "app:moveDataRoot",
  "doc": "把整个数据根迁到新位置,**迁完自动重启应用**(数据库没法原地搬家)。 `ok:false` + `error` 时不重启,设置也不改。",
  "input": "{ path: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "app.quitAndInstall",
  "channel": "app:quitAndInstall",
  "doc": "Quit the app and install the downloaded update (called after `update:downloaded`).",
  "input": "(无参数)",
  "output": "void"
 },
 {
  "method": "automation.run",
  "channel": "automation:run",
  "doc": "**立刻跑一次**。走的就是那条自动化的 manual 那条路(见 `automationRunner.runNow`), 所以试出来的结果和它定时跑起来是同一样东西。 `ok: false` 时 `error` 是**给人看的句子**(比如\"这个触发器不在一条已保存的自动化里\"), 不是异常 —— 用户点了一个还没存过的触发器,该得到一句解释而不是一个错误框。",
  "input": "{ workflowId: string; triggerNodeId: string // 用**哪个触发器**起这一次 —— 一条自动化可以有多个触发器,它们的工作目录和请求 都可能不一样,所以这里必须指名道姓。 }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "automation.runs",
  "channel": "automation:runs",
  "doc": "运行历史(新的在前)。**从存档折出来**,不是另存的一份 —— 见 `AutomationRunEntry`。",
  "input": "{ workflowId: string; limit?: number | undefined // 最多几条(新的在前)。不给就用主进程的默认值。 }",
  "output": "{ runs: AutomationRunEntry[]; }"
 },
 {
  "method": "automation.sessions",
  "channel": "automation:sessions",
  "doc": "后台会话：sessionId 优先为活跃会话，否则最近使用；没跑过为 null。 sessionIds 列出全部项目的会话供历史汇总；可选以兼容旧版响应。",
  "input": "{ workflowId: string }",
  "output": "{ sessionId: string | null; sessionIds?: string[]; }"
 },
 {
  "method": "automation.statusAll",
  "channel": "automation:statusAll",
  "doc": "全部触发器的**事实状态**(挂没挂上 / 为什么 / 最近一次跑,见 `AutomationTriggerFacts`)。**无参 handler**,同 `workflow.agentProfiles`。",
  "input": "(无参数)",
  "output": "AutomationTriggerFacts[]"
 },
 {
  "method": "automation.watch",
  "channel": "automation:watch",
  "doc": "以某条会话为发起会话起一次守望。`ok: false` 时 `error` 是给人看的句子(不在跑、 发起会话没了、模板被改坏……),不是异常 —— 点按钮的人该得到解释而不是错误框。",
  "input": "{ sessionId: string; message?: string | undefined; command?: string | undefined }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "automation.watchStatus",
  "channel": "automation:watchStatus",
  "doc": "这条会话上有没有正在跑的守望(面板提示\"上一次还在跑\"用)。",
  "input": "{ sessionId: string }",
  "output": "{ active: boolean; }"
 },
 {
  "method": "automation.watchTemplates",
  "channel": "automation:watchTemplates",
  "doc": "全部命令模板(守望面板的下拉)。**无参 handler**,同 `workflow.agentProfiles`。",
  "input": "(无参数)",
  "output": "{ templates: WatchCommandTemplate[]; }"
 },
 {
  "method": "automation.watchTemplatesSave",
  "channel": "automation:watchTemplatesSave",
  "doc": "存整份命令模板列表。整份给过来 —— 理由同 `workflow.saveAgentProfile`。",
  "input": "{ templates: { id: string; name: string; command: string; }[] }",
  "output": "{ ok: boolean; }"
 },
 {
  "method": "browser.authRespond",
  "channel": "browser:authRespond",
  "doc": "Answer a pending HTTP Basic Auth prompt (see \"authRequest\" push event).",
  "input": "{ requestId: string; username: string // Empty username+password cancels the auth prompt.; password: string }",
  "output": "void"
 },
 {
  "method": "browser.bookmarkAdd",
  "channel": "browser:bookmarkAdd",
  "doc": "Bookmark a page (dedupe by URL, move to front).",
  "input": "{ title: string; url: string }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.bookmarkRemove",
  "channel": "browser:bookmarkRemove",
  "doc": "Remove one bookmark by URL.",
  "input": "{ url: string }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.captureFrame",
  "channel": "browser:captureFrame",
  "doc": "Capture one frame of the current page (visibility untouched) for the renderer's frozen-frame placeholder.",
  "input": "{ browserId: string }",
  "output": "BrowserCaptureFrameResult"
 },
 {
  "method": "browser.clearCache",
  "channel": "browser:clearCache",
  "doc": "Clear the embedded browser's HTTP cache + temporary site storage (localStorage / IndexedDB / service workers / etc.). Cookies and login data are preserved, so the user stays signed in.",
  "input": "(无参数)",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.clearCookies",
  "channel": "browser:clearCookies",
  "doc": "Clear ALL cookies from the shared browser session (sign-out everywhere) AND wipe the persisted cookie vault, so sign-ins cannot resurrect on restart via restoreCookieVault.",
  "input": "(无参数)",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.close",
  "channel": "browser:close",
  "doc": "Destroy the view and drop it from the manager.",
  "input": "{ browserId: string }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.create",
  "channel": "browser:create",
  "doc": "Create a browser view bound to a project root. Returns an opaque id.",
  "input": "{ projectPath: string; initialDevice?: 'custom' | 'desktop' | 'iphone' | 'iphone-se' | 'android' | 'galaxy-s23' | 'ipad-mini' | undefined // Optional initial device-emulation preset applied once the view's renderer is ready (dom-r… }",
  "output": "BrowserCreateResult"
 },
 {
  "method": "browser.downloadAction",
  "channel": "browser:downloadAction",
  "doc": "Open a tracked download's file with the OS default app (\"open\", only allowed once the download completed) or select it in the containing folder (\"reveal\"). The path is resolved main-side from the download registry — see BrowserDownloadActionSchema.",
  "input": "{ downloadId: string; action: 'open' | 'reveal' }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.goBack",
  "channel": "browser:goBack",
  "doc": "History back.",
  "input": "{ browserId: string }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.goForward",
  "channel": "browser:goForward",
  "doc": "History forward.",
  "input": "{ browserId: string }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.hide",
  "channel": "browser:hide",
  "doc": "Hide the view (move offscreen without destroying the session).",
  "input": "{ browserId: string }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.historyClear",
  "channel": "browser:historyClear",
  "doc": "Clear the whole address-bar history.",
  "input": "{}",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.historyRemove",
  "channel": "browser:historyRemove",
  "doc": "Remove one entry from the address-bar history.",
  "input": "{ url: string }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.loadUrl",
  "channel": "browser:loadUrl",
  "doc": "Navigate the view to a URL.",
  "input": "{ url: string; browserId: string }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.reload",
  "channel": "browser:reload",
  "doc": "Reload the current page.",
  "input": "{ browserId: string }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.setBounds",
  "channel": "browser:setBounds",
  "doc": "Reposition/resize the view over the renderer's placeholder.",
  "input": "{ browserId: string; x: number; y: number; width: number; height: number }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.setDevice",
  "channel": "browser:setDevice",
  "doc": "Set the device emulation preset (desktop / iphone / android).",
  "input": "{ browserId: string; device: 'custom' | 'desktop' | 'iphone' | 'iphone-se' | 'android' | 'galaxy-s23' | 'ipad-mini'; width?: number | undefined // Custom viewport width (required when device === \"custom\").; height?: number | undefined // Custom viewport height (required when device === \"custom\").; orientation?: 'portrait' | 'landscape' | undefined // Screen orientation; \"landscape\" swaps width/height.; viewportWidth?: number | undefined // Effective emulated viewport size (CSS px) to apply.; viewportHeight?: number | undefined }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.setPickMode",
  "channel": "browser:setPickMode",
  "doc": "Inject/remove the DOM element picker into the page's main world.",
  "input": "{ browserId: string; enabled: boolean }",
  "output": "BrowserOpResult"
 },
 {
  "method": "browser.show",
  "channel": "browser:show",
  "doc": "Show the view (attach + restore bounds).",
  "input": "{ browserId: string }",
  "output": "BrowserOpResult"
 },
 {
  "method": "claude.approve",
  "channel": "claude:approve",
  "doc": "",
  "input": "{ requestId: string; sessionId: string; granted: boolean; always?: boolean | undefined }",
  "output": "void"
 },
 {
  "method": "claude.inject",
  "channel": "claude:inject",
  "doc": "往正在跑的那一轮里塞一句话。返回 `{ delivered }` —— **\"收下了没有\",不是\"发出去了 没有\"**:这一轮刚好收尾、或者引擎不支持,都是 `false`,渲染端据此**兜回普通的发送** (见 `sessionStore.injectPrompt`)。用户打了字而什么都没发生,是最糟的一种结果。",
  "input": "{ sessionId: string; text: string }",
  "output": "{ delivered: boolean; }"
 },
 {
  "method": "claude.interrupt",
  "channel": "claude:interrupt",
  "doc": "",
  "input": "{ sessionId: string }",
  "output": "void"
 },
 {
  "method": "claude.listSideChats",
  "channel": "claude:listSideChats",
  "doc": "List a main session's side chats (kind=\"side\"), newest first.",
  "input": "{ parentSessionId: string }",
  "output": "{ sessions: Session[]; }"
 },
 {
  "method": "claude.respondPlanApproval",
  "channel": "claude:respondPlanApproval",
  "doc": "Submit the user's approve/reject decision on a pending ExitPlanMode plan.",
  "input": "{ requestId: string; sessionId: string; approved: boolean; editedPlan?: string | undefined; reason?: string | undefined; feedback?: string | undefined }",
  "output": "void"
 },
 {
  "method": "claude.respondQuestion",
  "channel": "claude:respondQuestion",
  "doc": "Submit the user's answers to a pending AskUserQuestion.",
  "input": "{ sessionId: string; requestId: string; answers: UserInputAnswers; dismissed?: boolean | undefined }",
  "output": "void"
 },
 {
  "method": "claude.rewindTurn",
  "channel": "claude:rewindTurn",
  "doc": "Rewind a turn: restore the given files to their pre-turn state. Works for the latest turn, any historical turn, or a session reopened after restart (the renderer passes the explicit entries). Returns the list of paths that were actually restored (failed paths…",
  "input": "{ sessionId: string; files: { kind: 'modified' | 'created'; filePath: string; adds: number; dels: number; before: string; }[]; targetFiles: string[] }",
  "output": "{ restored: string[]; }"
 },
 {
  "method": "claude.saveSubagents",
  "channel": "claude:saveSubagents",
  "doc": "Save the whole custom-subagent list (Settings → 子代理). Main validates each definition and persists to `claude.subagents`; returns the saved list so the editor can snap to what actually landed.",
  "input": "{ subagents: SubagentDefinition[] }",
  "output": "{ subagents: SubagentDefinition[]; }"
 },
 {
  "method": "claude.sendTurn",
  "channel": "claude:sendTurn",
  "doc": "Returns the (possibly retitled) session so the renderer can refresh.",
  "input": "{ sessionId: string; prompt: string; providerId?: string | undefined // Per-turn provider override.; model?: string | undefined // Override session-scoped settings for this turn (reflects current UI state).; effort?: string | undefined; permissionMode?: string | undefined; customModelId?: string | null | undefined // Override the session's bound custom model for this turn.; attachments?: string[] | undefined; images?: { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; }[] | undefined // User-attached images inlined into the provider request as base64 content blocks (NOT path…; workflowId?: string | undefined // 这一轮用的工作流。**刻意不折进 `prompt`** —— 会话标题是从 `prompt` 派生的, 折进去会让标题变成流程正文。见 main/orchestration/pr…; composerMode?: string | undefined // 旧字段名,**接受一个版本**。手机端可能还开着改版前加载的页面,而 zod 对没声明 的键是**静默丢掉**的 —— 那会表现成\"模式突然不生效了\",不报错、也不易查。; skills?: string[] | undefined //…",
  "output": "{ session: Session; }"
 },
 {
  "method": "claude.startSession",
  "channel": "claude:startSession",
  "doc": "",
  "input": "{ projectId: string; effort: string; permissionMode: string; kind: 'chat' | 'side' // Session role: \"chat\" (default, normal left-bar session) or \"side\" (side-chat Q&A session …; title?: string | undefined; providerId?: string | undefined // Provider id — which AI backend to use.; model?: string | undefined; customModelId?: string | null | undefined // Id of a custom-model config to bind to this session (omit/null = built-in).; parentSessionId?: string | undefined // For kind=\"side\": the main session this Q&A thread belongs to.; envMode?: 'local' | 'worktree' | undefined // Working-environment intent for the new session.; wtStyle?: 'detached' | 'branch' | undefined // Worktree FORM for envMode=\"worktree\": \"branch\" materializes on a generated `mcode/*` bran…; worktreePath?: string | undefined // BIND to an existing managed worktree directory instead of creating a fresh one: the new s…; ag…",
  "output": "{ session: Session; }"
 },
 {
  "method": "clipboard.saveFile",
  "channel": "clipboard:saveFile",
  "doc": "Persist a clipboard-pasted external file to a temp path (composer paste).",
  "input": "{ name: string // Original file name (display + extension preservation).; bytes: string // base64-encoded file bytes (~52MB file ceiling). }",
  "output": "{ ok: boolean; path?: string | undefined; error?: string | undefined; }"
 },
 {
  "method": "clipboard.writeImage",
  "channel": "clipboard:writeImage",
  "doc": "Copy an image data URL onto the OS clipboard (image lightbox 复制).",
  "input": "{ dataUrl: string // Full `data:image/<mime>;base64,...` URL of the image to copy. }",
  "output": "{ ok: boolean; error?: string | undefined; }"
 },
 {
  "method": "codexModels.delete",
  "channel": "codexModels:delete",
  "doc": "",
  "input": "{ id: string }",
  "output": "{ providers: CodexProviderPublic[]; }"
 },
 {
  "method": "codexModels.getApiKey",
  "channel": "codexModels:getApiKey",
  "doc": "Settings UI eye-icon only — same security carve-out as customModel.getToken / piModels.getApiKey.",
  "input": "{ id: string }",
  "output": "{ apiKey: string | null; }"
 },
 {
  "method": "codexModels.list",
  "channel": "codexModels:list",
  "doc": "",
  "input": "(无参数)",
  "output": "{ providers: CodexProviderPublic[]; }"
 },
 {
  "method": "codexModels.save",
  "channel": "codexModels:save",
  "doc": "",
  "input": "{ id: string; name: string; models: { id: string; label?: string | undefined; hint?: string | undefined; contextWindow?: number | undefined; }[]; baseUrl: string; apiKey?: string | undefined; imageGeneration?: boolean | undefined // Opt-in: unlock codex's image generation tool by injecting the `x-openai-actor-authorizati… }",
  "output": "{ providers: CodexProviderPublic[]; }"
 },
 {
  "method": "context.get",
  "channel": "context:get",
  "doc": "Read the global instructions (single source of truth file). Empty string = never configured.",
  "input": "{}",
  "output": "{ content: string; }"
 },
 {
  "method": "context.save",
  "channel": "context:save",
  "doc": "Save the global instructions and materialize each engine's consume point (CLAUDE.md for claude; the codex/pi prompt chains read the same source). `warnings` carries per-target notes (e.g. an unmanaged hand-written file was left untouched).",
  "input": "{ content: string }",
  "output": "{ ok: boolean; error?: string; warnings?: string[]; }"
 },
 {
  "method": "customModel.delete",
  "channel": "customModel:delete",
  "doc": "",
  "input": "{ id: string }",
  "output": "{ models: CustomModelPublic[]; }"
 },
 {
  "method": "customModel.getToken",
  "channel": "customModel:getToken",
  "doc": "Settings UI eye-icon only — returns cleartext token for display.",
  "input": "{ id: string }",
  "output": "{ token: string | null; }"
 },
 {
  "method": "customModel.list",
  "channel": "customModel:list",
  "doc": "",
  "input": "(无参数)",
  "output": "{ models: CustomModelPublic[]; }"
 },
 {
  "method": "customModel.save",
  "channel": "customModel:save",
  "doc": "",
  "input": "{ id?: string | undefined // Omit on create; present on update to target an existing record.; name: string; baseUrl: string; authMode?: AuthMode | undefined; protocol?: Protocol | undefined // Wire protocol.; webSiteId?: string | undefined // 仅 `protocol: \"web\"` 需要：驱动哪个网页版站点（站点适配器 id）。; authToken?: string | undefined // Cleartext.; models: CustomModelEntry[] // The flat model list (≥1 entry, enforced by the IPC schema).; subagentModel?: string | undefined // Task-subagent model to pin for this config.; disableNonEssentialTraffic?: boolean | undefined; timeoutMs?: number | undefined; customHeaders?: CustomHeaders | undefined // Extra request headers for the endpoint; an empty map clears them. }",
  "output": "{ models: CustomModelPublic[]; }"
 },
 {
  "method": "customModel.test",
  "channel": "customModel:test",
  "doc": "",
  "input": "{ model: string // The single model id to probe in this request.; baseUrl: string; authToken: string; authMode?: 'auth_token' | 'api_key' | undefined; protocol?: 'anthropic' | 'openai' | 'web' | undefined; supports1m?: boolean | undefined // Whether to declare 1M context (adds the `[1m]` suffix) — mirrors the model row's toggle.; disableNonEssentialTraffic?: boolean | undefined; timeoutMs?: number | undefined; customHeaders?: Record<string, string> | undefined // Headers to probe with, so an endpoint that requires one (and would otherwise fail the tes… }",
  "output": "TestCustomModelResult"
 },
 {
  "method": "customUi.panelAsk",
  "channel": "customUi:panelAsk",
  "doc": "自定义面板的 `mcode.ask()`:一次性问模型(不带工具),返回纯文本。",
  "input": "{ prompt: string; model?: string | undefined; system?: string | undefined }",
  "output": "CustomUiPanelAskResult"
 },
 {
  "method": "customUi.runAutomation",
  "channel": "customUi:runAutomation",
  "doc": "自定义项的「运行自动化」动作:用指定触发器**手动**起一次,右键的目标当载荷带进去 (条目 / 分类 / 大类 → 条目清单,文件 → 文件列表)。`dryRun` 只数条数不真跑。 桌面专属(手机白名单不列即不暴露)。",
  "input": "{ workflowId: string; triggerNodeId: string; target: { kind: 'item'; itemId: string; } | { kind: 'collection'; collectionId: string; } | { kind: 'group'; groupId: string; } | { path: string; kind: 'file'; }; skipWhen?: { extensions?: string[] | undefined; requires?: 'file' | 'pdf' | 'markdown' | undefined; groupIds?: string[] | undefined; } | undefined // 展开时的条目跳过条件(见 automation 动作的 skipWhen;主进程逐条目复核)。; targetMode?: 'scope' | 'context' | undefined // 目标怎么用(见 automation 动作的 targetMode)。缺省 = `scope`,与老行为一致。; input?: Record<string, string | string[]> | undefined // 运行前输入的值(键 = `inputs[].key`;files 是绝对路径数组)。; dryRun?: boolean | undefined // 只数一下这次会带多少条,不真跑 —— 批量跑之前给用户确认用。; expectCount?: number | undefined // 用户在确认框上**看到并点头的那个条数**(只有走过 `dryRun` 的批量那条路会带)。 }",
  "output": "CustomUiRunAutomationResult"
 },
 {
  "method": "customUi.stagePanel",
  "channel": "customUi:stagePanel",
  "doc": "自定义面板(R41):把包好的面板文档交给主进程,换一个 `mcode-panel://` 地址给 iframe 用。",
  "input": "{ html: string; network?: boolean | undefined }",
  "output": "CustomUiStagePanelResult"
 },
 {
  "method": "dialog.pickFiles",
  "channel": "dialog:pickFiles",
  "doc": "Native multi-file picker (project-external files allowed). Returns the selected absolute paths; empty array when the user cancels.",
  "input": "{ title?: string | undefined // Optional dialog title; defaults to a localized \"选择文件\" on the main side.; filters?: { extensions: string[]; name: string; }[] | undefined // 原生选择框的扩展名过滤,如 `[{ name: \"PDF\", extensions: [\"pdf\"] }]`。 }",
  "output": "{ paths: string[]; }"
 },
 {
  "method": "dialog.pickFolder",
  "channel": "dialog:pickFolder",
  "doc": "原生单目录选择器(新建项目用)。桌面专有:手机端的 `webApi` 不提供。",
  "input": "(无参数)",
  "output": "{ path: string | null; }"
 },
 {
  "method": "file.copy",
  "channel": "file:copy",
  "doc": "",
  "input": "{ srcPath: string // Absolute path of the file to copy.; destDir: string // Absolute path of the directory to copy into.; suffix?: string | undefined // Locale word used when deriving a clash-free name (\"副本\" / \"copy\"). }",
  "output": "{ ok: boolean; }"
 },
 {
  "method": "file.delete",
  "channel": "file:delete",
  "doc": "Delete a file or directory (moves to system trash), scoped to a project root.",
  "input": "{ targetPath: string // Absolute path of the file or directory to trash. }",
  "output": "{ ok: boolean; }"
 },
 {
  "method": "file.grep",
  "channel": "file:grep",
  "doc": "Grep file contents under a project root (line-level matches).",
  "input": "{ projectPath: string // Absolute path of the project root.; query: string // Substring to search for inside file contents.; limit?: number | undefined // Max total matches to return.; includeExts?: string[] | undefined // Optional file-extension allow-list (no dots, lowercased).; maxResultsPerFile?: number | undefined // Max matches per single file.; caseSensitive?: boolean | undefined // Case-sensitive match. }",
  "output": "FileGrepResult"
 },
 {
  "method": "file.listDir",
  "channel": "file:listDir",
  "doc": "List one level of a directory (non-recursive), scoped to a project root.",
  "input": "{ projectPath: string // Absolute path of the project root the listing is scoped to.; dirPath: string // Directory to list, relative to projectPath. }",
  "output": "{ entries: FileTreeEntry[]; }"
 },
 {
  "method": "file.mkdir",
  "channel": "file:mkdir",
  "doc": "Create a directory (recursive), scoped to a project root.",
  "input": "{ dirPath: string // Absolute path of the directory to create. }",
  "output": "{ ok: boolean; }"
 },
 {
  "method": "file.pickImages",
  "channel": "file:pickImages",
  "doc": "OS dialog image picker → base64 images (composer 图片 button).",
  "input": "{}",
  "output": "{ images: PickedImage[]; skipped: string[]; }"
 },
 {
  "method": "file.readBinary",
  "channel": "file:readBinary",
  "doc": "Read a binary file as a base64 data URL (image preview). Same path guard.",
  "input": "{ filePath: string // Absolute path. }",
  "output": "{ dataUrl: string; }"
 },
 {
  "method": "file.readFile",
  "channel": "file:readFile",
  "doc": "",
  "input": "{ filePath: string // Absolute or cwd-relative path. }",
  "output": "{ content: string; }"
 },
 {
  "method": "file.rename",
  "channel": "file:rename",
  "doc": "Rename a file or directory in place, scoped to a project root.",
  "input": "{ oldPath: string // Absolute path of the entry to rename.; newPath: string // Absolute path of the new name. }",
  "output": "{ ok: boolean; }"
 },
 {
  "method": "file.search",
  "channel": "file:search",
  "doc": "Recursive file search under a project root (composer @ / add-context).",
  "input": "{ projectPath: string // Absolute path of the project root.; limit?: number | undefined // Max files to return.; query?: string | undefined // Optional case-insensitive filter over file name / relative path.; includeExts?: string[] | undefined // Optional file-extension allow-list (no dots, lowercased). }",
  "output": "FileSearchResult"
 },
 {
  "method": "file.writeFile",
  "channel": "file:writeFile",
  "doc": "Write content to a file (creates parents), scoped to a project root.",
  "input": "{ filePath: string // Absolute or cwd-relative path.; content: string }",
  "output": "{ ok: boolean; }"
 },
 {
  "method": "git.cancelGenerateCommitMessage",
  "channel": "git:cancelGenerateCommitMessage",
  "doc": "",
  "input": "{ requestId: string }",
  "output": "{ ok: boolean; }"
 },
 {
  "method": "git.checkout",
  "channel": "git:checkout",
  "doc": "Check out a branch / tag / ref. With `newBranch`, creates a new local branch from the target and checks it out (tracking branch or new branch).",
  "input": "{ branch: string; repoPath: string; newBranch?: string | undefined // When provided, create this new local branch from `branch` and check it out. }",
  "output": "GitOpResult"
 },
 {
  "method": "git.commit",
  "channel": "git:commit",
  "doc": "Commit staged changes with a message.",
  "input": "{ message: string; repoPath: string }",
  "output": "GitOpResult"
 },
 {
  "method": "git.deleteBranch",
  "channel": "git:deleteBranch",
  "doc": "Delete a local branch (`git branch -d`; `-D` with `force`).",
  "input": "{ branch: string; repoPath: string; force?: boolean | undefined // Force delete (`git branch -D`) — skips the fully-merged safety check. }",
  "output": "GitOpResult"
 },
 {
  "method": "git.diff",
  "channel": "git:diff",
  "doc": "Get the unstaged diff patch for a single file.",
  "input": "{ filePath: string; repoPath: string; staged?: boolean | undefined // If true, show staged (cached) diff — index vs HEAD. }",
  "output": "{ patch: string; }"
 },
 {
  "method": "git.discard",
  "channel": "git:discard",
  "doc": "Discard local changes to specific files (checkout tracked / clean untracked).",
  "input": "{ repoPath: string; filePaths: string[] }",
  "output": "GitOpResult"
 },
 {
  "method": "git.discoverRepos",
  "channel": "git:discoverRepos",
  "doc": "Discover all git repos under a project root (recursive, max depth 3).",
  "input": "{ projectPath: string; rootOnly?: boolean | undefined }",
  "output": "{ repos: GitRepo[]; }"
 },
 {
  "method": "git.fileBlob",
  "channel": "git:fileBlob",
  "doc": "Full old-side blob for the Git panel's diff view (`git show rev:path`).",
  "input": "{ side: 'index' | 'HEAD'; filePath: string; repoPath: string }",
  "output": "{ content: string; }"
 },
 {
  "method": "git.generateCommitMessage",
  "channel": "git:generateCommitMessage",
  "doc": "Generate a commit message from the staged diff via an LLM one-shot call.",
  "input": "{ customModelId: string | null // Custom-model config id (from CustomModelStore).; prompt: string // The user's prompt template.; repoPath: string; customModelRole: string | null // Which role binding within the config to use (e.g.; requestId?: string | undefined // Optional cancellation key: when present, the AbortController driving the SDK query is reg…; scope?: 'worktree' | 'staged' | undefined // Which diff feeds the generation: \"staged\" (default — index vs HEAD, the commit-box flow) … }",
  "output": "{ ok: boolean; message?: string; error?: string; }"
 },
 {
  "method": "git.listBranches",
  "channel": "git:listBranches",
  "doc": "List local branches, remote branches and tags for a repo (grouped).",
  "input": "{ repoPath: string }",
  "output": "{ branches: GitBranchListResult; }"
 },
 {
  "method": "git.log",
  "channel": "git:log",
  "doc": "Paginated commit log for a repo (newest first).",
  "input": "{ repoPath: string; limit?: number | undefined // Max commits to return (default 50, max 200).; skip?: number | undefined // Number of commits to skip (for pagination).; ref?: string | undefined // Optional ref to start from (branch/tag/hash). }",
  "output": "{ commits: GitCommitInfo[]; hasMore: boolean; }"
 },
 {
  "method": "git.merge",
  "channel": "git:merge",
  "doc": "Merge `source` into the current branch. Conflicts are reported via `conflict` + `conflictedFiles` (same shape as git.pull).",
  "input": "{ repoPath: string; source: string }",
  "output": "GitMergeResult"
 },
 {
  "method": "git.mergeAbort",
  "channel": "git:mergeAbort",
  "doc": "Abort an in-progress merge (`git merge --abort`). Fails when the repo is not in a merging state.",
  "input": "{ repoPath: string }",
  "output": "GitOpResult"
 },
 {
  "method": "git.mergePreview",
  "channel": "git:mergePreview",
  "doc": "Preview a merge of `source` into the current branch without touching the working tree (incoming commit count / fast-forward / up-to-date).",
  "input": "{ repoPath: string; source: string }",
  "output": "GitMergePreviewResult"
 },
 {
  "method": "git.pull",
  "channel": "git:pull",
  "doc": "Pull remote changes into the current branch.",
  "input": "{ repoPath: string }",
  "output": "GitOpResult"
 },
 {
  "method": "git.push",
  "channel": "git:push",
  "doc": "Push local commits to the upstream remote.",
  "input": "{ repoPath: string }",
  "output": "GitOpResult"
 },
 {
  "method": "git.showCommit",
  "channel": "git:showCommit",
  "doc": "Meta + changed files for one commit.",
  "input": "{ repoPath: string; commitHash: string }",
  "output": "GitCommitDetail | null"
 },
 {
  "method": "git.showFile",
  "channel": "git:showFile",
  "doc": "Parent-vs-commit file contents for a single path (Monaco diff).",
  "input": "{ filePath: string // Path relative to the repo root (new path for renames).; repoPath: string; commitHash: string; oldPath?: string | undefined // Previous path when the file was renamed/copied in this commit. }",
  "output": "{ before: string; after: string; }"
 },
 {
  "method": "git.stage",
  "channel": "git:stage",
  "doc": "Stage (git add) specific files.",
  "input": "{ repoPath: string; filePaths: string[] }",
  "output": "GitOpResult"
 },
 {
  "method": "git.status",
  "channel": "git:status",
  "doc": "Get the status of a single repo (branch / ahead / behind / files).",
  "input": "{ repoPath: string }",
  "output": "{ status: GitStatusResult; }"
 },
 {
  "method": "git.unstage",
  "channel": "git:unstage",
  "doc": "Unstage (git reset) specific files.",
  "input": "{ repoPath: string; filePaths: string[] }",
  "output": "GitOpResult"
 },
 {
  "method": "git.worktreeList",
  "channel": "git:worktreeList",
  "doc": "List the repo's worktrees (linked + main) with lifecycle state.",
  "input": "{ repoPath: string // The repo to list worktrees of. }",
  "output": "{ worktrees: GitWorktreeInfo[]; }"
 },
 {
  "method": "git.worktreeMergeBack",
  "channel": "git:worktreeMergeBack",
  "doc": "Merge a worktree's HEAD back into the local current branch.",
  "input": "{ worktreePath: string; repoPath: string; message?: string | undefined // Commit message for the pre-merge auto-commit of uncommitted worktree changes. }",
  "output": "GitWorktreeMergeBackResult"
 },
 {
  "method": "git.worktreeRemove",
  "channel": "git:worktreeRemove",
  "doc": "Remove a worktree (optionally force / with a patch export first).",
  "input": "{ worktreePath: string; repoPath: string; force?: boolean | undefined // Skip the uncommitted-changes check and pass --force.; exportPatch?: boolean | undefined // Before removing, persist the worktree's FULL unmerged work (commits since the merge-base … }",
  "output": "GitWorktreeRemoveResult"
 },
 {
  "method": "git.worktreeStatus",
  "channel": "git:worktreeStatus",
  "doc": "Lifecycle state of ONE worktree (cheap probe for pollers).",
  "input": "{ worktreePath: string; repoPath: string }",
  "output": "{ status: GitWorktreeInfo | null; }"
 },
 {
  "method": "hooks.list",
  "channel": "hooks:list",
  "doc": "全部钩子 + 读得见但用不了的条目。**坏条目不静默丢弃** —— 用户写的钩子不生效时, 这一页是唯一能解释为什么的地方。",
  "input": "(无参数)",
  "output": "{ hooks: HookSpec[]; problems: Array<{ where: string; error: string; }>; }"
 },
 {
  "method": "hooks.remove",
  "channel": "hooks:remove",
  "doc": "",
  "input": "{ id: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "hooks.runs",
  "channel": "hooks:runs",
  "doc": "最近的执行记录(新的在前)。**不进对话流** —— 一个挂在 `tool.use` 上的钩子一轮 会触发几十次,塞进消息流就是把对话刷屏;而节点会话是隐藏的,那些事件本来也不该 出现在父对话里。",
  "input": "(无参数)",
  "output": "{ runs: HookRun[]; }"
 },
 {
  "method": "hooks.save",
  "channel": "hooks:save",
  "doc": "",
  "input": "{ hook: { id: string; name: string; enabled: boolean; command: string; event: 'error' | 'user.message' | 'tool.use' | 'tool.result' | 'approval.request' | 'request.res… }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "hooks.test",
  "channel": "hooks:test",
  "doc": "拿一条**还没存下来**的配置试跑一次,把那一次的结果返回。",
  "input": "{ hook: { id: string; name: string; enabled: boolean; command: string; event: 'error' | 'user.message' | 'tool.use' | 'tool.result' | 'approval.request' | 'request.res… }",
  "output": "{ run: HookRun; }"
 },
 {
  "method": "institution.authStatus",
  "channel": "institution:authStatus",
  "doc": "从浏览器分区的 cookie 反推「已登录哪些站点」。",
  "input": "{ domains?: string[] | undefined // 只看这些域名;省略则返回全部有 cookie 的域名。 }",
  "output": "{ sites: AuthSiteStatus[]; }"
 },
 {
  "method": "institution.clearCookies",
  "channel": "institution:clearCookies",
  "doc": "清除指定域名(或全部)的登录态。",
  "input": "{ domains?: string[] | undefined // 要清除的域名。省略则清空整个浏览器分区(危险,UI 需二次确认)。 }",
  "output": "{ sites: AuthSiteStatus[]; }"
 },
 {
  "method": "institution.delete",
  "channel": "institution:delete",
  "doc": "",
  "input": "{ id: string }",
  "output": "{ profiles: InstitutionProfile[]; }"
 },
 {
  "method": "institution.list",
  "channel": "institution:list",
  "doc": "已保存的机构入口档案。注意:档案不含凭据,登录态在浏览器分区里。",
  "input": "(无参数)",
  "output": "{ profiles: InstitutionProfile[]; }"
 },
 {
  "method": "institution.save",
  "channel": "institution:save",
  "doc": "",
  "input": "{ name: string; id?: string | undefined; loginUrl?: string | undefined; domains?: string[] | undefined; proxyPrefix?: string | undefined; notes?: string | undefined }",
  "output": "{ profiles: InstitutionProfile[]; }"
 },
 {
  "method": "library.addItems",
  "channel": "library:addItems",
  "doc": "入库(只建记录,不带文件)。返回新增的条目。",
  "input": "{ items: { title: string; url?: string | undefined; language?: string | undefined; collectionIds?: string[] | undefined; abstract?: string | undefined; }[] }",
  "output": "{ items: LibraryItem[]; }"
 },
 {
  "method": "library.adoptMarkdown",
  "channel": "library:adoptMarkdown",
  "doc": "直接把一份现成的 Markdown 挂到某条目上(不转录)。同级 `images/` 会一起搬。",
  "input": "{ path: string // 用户选中的 md 文件绝对路径。同级若有 `images/` 会一起搬。; id: string }",
  "output": "{ ok: boolean; error?: string; imageCount: number; }"
 },
 {
  "method": "library.assignCollection",
  "channel": "library:assignCollection",
  "doc": "把文献加入/移出某集合(多对多,一篇可属多个集合)。",
  "input": "{ collectionId: string; itemIds: string[]; add: boolean // true = 加入,false = 移出。 }",
  "output": "{ collections: LibraryCollection[]; }"
 },
 {
  "method": "library.attachToChat",
  "channel": "library:attachToChat",
  "doc": "把一条附件挂到指定会话的输入框上(左栏右键「添加到当前对话」)。 与 AI 的 `library_attach_to_chat` 共用同一份实现,所以效果一致。",
  "input": "{ key: string; sessionId: string }",
  "output": "{ ok: boolean; name?: string; count?: number; error?: string; }"
 },
 {
  "method": "library.conversionReport",
  "channel": "library:conversionReport",
  "doc": "逐篇的转换完整度(设置页的「转录检测」列表)。**完整 = md 有 + 它引用的图都在**。",
  "input": "(无参数)",
  "output": "{ rows: LibraryConversionRow[]; total: number; complete: number; pending: number; }"
 },
 {
  "method": "library.conversionStats",
  "channel": "library:conversionStats",
  "doc": "批量检测转换情况:共多少篇 / 已转 Markdown / 还没转。 设置页的「批量转换」用它 —— 比把全库拉进渲染端再数省得多。",
  "input": "(无参数)",
  "output": "{ total: number; converted: number; pending: number; }"
 },
 {
  "method": "library.convert",
  "channel": "library:convert",
  "doc": "",
  "input": "{ force?: boolean | undefined // 已经有 md 也重转。; collectionId?: string | undefined; ids?: string[] | undefined // 要转的条目;省略则转整个库(或某个集合)。; repair?: boolean | undefined // 按小类清理失联/多余产物并修复该小类；必须显式提供 collectionId。 }",
  "output": "{ converted: number; cleaned: number; failed: Array<{ id: string; error: string; }>; }"
 },
 {
  "method": "library.createCollection",
  "channel": "library:createCollection",
  "doc": "新建/改名/删除集合 —— 均返回**完整的新列表**,渲染端整体替换缓存(既定模式)。",
  "input": "{ name: string; prompt?: string | undefined // 这个分类的「给 AI 的说明」。省略 = 不写。; groupId?: string | undefined // 建在哪个大类下。省略 = 第一个大类。; parentId?: string | null | undefined }",
  "output": "{ collections: LibraryCollection[]; }"
 },
 {
  "method": "library.createNote",
  "channel": "library:createNote",
  "doc": "新建一篇空笔记(笔记库)。文件会先落一份 `# 标题` 骨架。",
  "input": "{ title: string; collectionIds?: string[] | undefined }",
  "output": "{ item: LibraryItem | null; }"
 },
 {
  "method": "library.deleteCollection",
  "channel": "library:deleteCollection",
  "doc": "",
  "input": "{ id: string }",
  "output": "{ collections: LibraryCollection[]; }"
 },
 {
  "method": "library.deleteItems",
  "channel": "library:deleteItems",
  "doc": "从库中移除。`deleteFiles` 决定是否连磁盘文件一起删。 **删不掉的会如实报在 `failed` 里,而且那几条记录留着**(见 `LibraryDeleteItemsResult`)。",
  "input": "{ ids: string[]; deleteFiles?: boolean | undefined // 是否连同磁盘上的 PDF/MD 一起删除。默认 false(只从库里移除记录)。; cascadeLinks?: string[] | undefined // 用户**勾了\"这个也一起删\"**的那些关联目标 —— 传 `library.deletePreview` 给出的 `targetItemId`。; keepTranscripts?: string[] | undefined // **保留转录产物**的条目名单(2026-09-28,用户:「删除不是把所有的链路上面的 文件都默认删除,弹出的窗口要可以选择的」)。名单里的条目删除时**跳过**它的 Mark… }",
  "output": "LibraryDeleteItemsResult"
 },
 {
  "method": "library.deleteNote",
  "channel": "library:deleteNote",
  "doc": "",
  "input": "{ id: string }",
  "output": "{ notes: LibraryNote[]; }"
 },
 {
  "method": "library.deletePreview",
  "channel": "library:deletePreview",
  "doc": "删除**之前**看一眼会带走什么 —— 关联到的其他文献、以及这条自己的 Markdown 转录 产物(连同它的图床)。弹窗照着它画勾选框。 刻意是**只读查询**:渲染端不必为了画一个确认框去拉半张库。用户取消时也不会有 任何东西被动过。",
  "input": "{ ids: string[] }",
  "output": "LibraryDeletePreviewResult"
 },
 {
  "method": "library.entryPath",
  "channel": "library:entryPath",
  "doc": "**条目 → 磁盘绝对路径** —— 给中间栏那个 `FileEditor` 用的（它按路径读写）。 见 `LibraryEntryPathSchema` 头注：这不构成\"渲染端能读任意文件\"，路径是主进程 按库里的记录算的，而且还要过 `pathGuard` 那道围栏。",
  "input": "{ id: string; which?: 'pdf' | 'md' | undefined // 定位哪一个:PDF 还是转换出的 Markdown。默认 PDF。 }",
  "output": "LibraryEntryPathResult"
 },
 {
  "method": "library.fullTextSearch",
  "channel": "library:fullTextSearch",
  "doc": "全文检索(ripgrep;sql.js 不含 FTS5)。",
  "input": "{ query: string; limit?: number | undefined; collectionIds?: string[] | undefined // 限定在哪些集合内搜;省略则全库。 }",
  "output": "{ matches: FullTextMatch[]; }"
 },
 {
  "method": "library.get",
  "channel": "library:get",
  "doc": "单条详情。",
  "input": "{ id: string }",
  "output": "{ item: LibraryItem; }"
 },
 {
  "method": "library.groupsGet",
  "channel": "library:groupsGet",
  "doc": "左栏大类:当前生效的分组(已过滤掉引用了已删类型的行)。",
  "input": "{}",
  "output": "{ groups: LibraryGroupMeta[]; }"
 },
 {
  "method": "library.groupsSave",
  "channel": "library:groupsSave",
  "doc": "整表替换大类。校验(一个类型只属一个组等)在主进程。",
  "input": "{ groups?: unknown }",
  "output": "{ ok: true; } | { ok: false; error: string; }"
 },
 {
  "method": "library.importFiles",
  "channel": "library:importFiles",
  "doc": "从**本地 PDF 文件**导入。 逐份:校验 → 按 sha256 去重 → 复制进库 → 入库(标题取文件名)→ 可选转 Markdown。",
  "input": "{ paths: string[] // 用户从文件选择框里挑出来的绝对路径。上限 200 —— 再多就该分批了。; mode?: 'files' | 'folder' | 'explode' | undefined // 导入模式：`\"files\"` = 逐个文件导入（默认）；`\"folder\"` = 把目录作为**一个** linked 条目收进来（不拆开，可展开浏览）；`\"explode\"` …; collectionIds?: string[] | undefined // 导入的文献归入哪些库(null/省略 = 只进总库)。; convert?: boolean | undefined }",
  "output": "{ items: LibraryItem[]; added: number; skipped: number; errors: Array<{ path: string; error: string; }>; converted: { ok: number; failed: number; }; }"
 },
 {
  "method": "library.importGeneric",
  "channel": "library:importGeneric",
  "doc": "任意文件/目录导入为通用条目(linked = 引用原路径 / attached = 复制进库)。",
  "input": "{ paths: string[]; mode?: 'linked' | 'attached' | undefined; collectionIds?: string[] | undefined }",
  "output": "{ items: LibraryItem[]; added: number; skipped: number; errors: Array<{ path: string; error: string; }>; }"
 },
 {
  "method": "library.importNotes",
  "channel": "library:importNotes",
  "doc": "导入笔记(**Markdown 文件**,见 `LibraryImportNotesSchema`)。 与 importFiles 分开的理由:笔记入库即完成 —— 没有元数据要抓、没有 PDF 要下、 没有东西要转录。所以返回值里也没有 `converted`。",
  "input": "{ paths: string[]; collectionIds?: string[] | undefined }",
  "output": "{ items: LibraryItem[]; added: number; skipped: number; errors: Array<{ path: string; error: string; }>; }"
 },
 {
  "method": "library.itemManifest",
  "channel": "library:itemManifest",
  "doc": "给**单独一篇**生成清单 —— 「+」菜单里的选择器可以展开分类、只挑其中一篇。 与整库清单同一套机制:只放一行 `@清单路径`,正文由 agent 自己读。 `path` 为空串表示没挂上,`blockedReason` 说明是不是被用户自己设的屏蔽挡住了 (与 `library.attachToChat` 同一个判据)。**被挡住时要如实说**,不能静默地少挂 一个 —— 否则用户只会觉得\"点了没反应\"。",
  "input": "{ id: string }",
  "output": "{ path: string; count: number; blockedReason?: string; }"
 },
 {
  "method": "library.linkAdd",
  "channel": "library:linkAdd",
  "doc": "加一条关联。**幂等** —— 已有同一条就返回它,不产生第二行。",
  "input": "{ itemId: string; targetPath?: string | undefined; targetItemId?: string | undefined }",
  "output": "{ link: LibraryItemLink; }"
 },
 {
  "method": "library.linkCounts",
  "channel": "library:linkCounts",
  "doc": "一批条目**各自**的关联条数 —— 左栏行尾那个徽标。见契约里 `LibraryLinkCountsSchema`。",
  "input": "{ itemIds: string[] }",
  "output": "{ counts: Record<string, number>; }"
 },
 {
  "method": "library.linkRemove",
  "channel": "library:linkRemove",
  "doc": "解除一条关联(按关联行自己的 id)。",
  "input": "{ linkId: string }",
  "output": "{ ok: boolean; }"
 },
 {
  "method": "library.linksOf",
  "channel": "library:linksOf",
  "doc": "一条条目的关联,**双向都返回**(`direction` 区分)。界面上的「关联」区用它。 `target` 是目标那一条的摘要(**主进程一次查好**,渲染端不必再逐条拉)—— 库内条目给标题,库外路径给文件名。`suppressed` 是\"这条会被屏蔽规则挡住\"的 原因(没被挡就是 undefined):界面据此把它**显示成灰态并说明为什么**,而不是 干脆不显示 —— 用户得看得见\"它存在,只是被挡了\",否则会以为关联丢了。",
  "input": "{ itemId: string }",
  "output": "{ links: LibraryLinkView[]; }"
 },
 {
  "method": "library.list",
  "channel": "library:list",
  "doc": "列出文献。`collectionId` 为 null/省略表示全部。",
  "input": "{ limit?: number | undefined; offset?: number | undefined; query?: string | undefined // 搜索关键词(标题/摘要/文件路径),大小写不敏感。; collectionId?: string | null | undefined; hasFile?: boolean | undefined // 只看有 / 没有文件的条目。 }",
  "output": "{ items: LibraryItem[]; total: number; }"
 },
 {
  "method": "library.listCollections",
  "channel": "library:listCollections",
  "doc": "",
  "input": "(无参数)",
  "output": "{ collections: LibraryCollection[]; }"
 },
 {
  "method": "library.listNotes",
  "channel": "library:listNotes",
  "doc": "条目下的小笔记(读文献时随手记的),**与「笔记库」是两件事** —— 笔记库的条目本身就是一篇 Markdown,这里的笔记依附于某篇论文/教材。",
  "input": "{ itemId: string }",
  "output": "{ notes: LibraryNote[]; }"
 },
 {
  "method": "library.manifest",
  "channel": "library:manifest",
  "doc": "生成/刷新某个库的清单 Markdown,返回其绝对路径(count = 收录条数)。 清单是给 agent 读的 —— 对话里只放 `@该路径`,与文件附件的机制一致。",
  "input": "{ collectionId: string }",
  "output": "{ path: string; count: number; }"
 },
 {
  "method": "library.moveCollection",
  "channel": "library:moveCollection",
  "doc": "把集合移到别处(改父级 / 调同级次序)。 `ok: false` = **被拒**(重名,或者会形成环)—— 与 `renameCollection` 同一个口径: 如实把结果回给调用方提示,而不是静默不动。`collections` 无论如何都是**最新的 完整列表**,所以被拒时调用方也不需要再拉一次。",
  "input": "{ id: string; parentId?: string | null | undefined // 新的父集合。不传 = 父级不动;null = 移到最外层。 }",
  "output": "{ collections: LibraryCollection[]; ok: boolean; error?: string; }"
 },
 {
  "method": "library.openFile",
  "channel": "library:openFile",
  "doc": "用系统默认程序打开库里的文件 —— 主要用途是看 md 的渲染效果(「打开 md 预览」)。 同样只收条目 id,路径在 main 里拼。",
  "input": "{ id: string; which?: 'pdf' | 'md' | undefined // 定位哪一个:PDF 还是转换出的 Markdown。默认 PDF。 }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "library.readFile",
  "channel": "library:readFile",
  "doc": "读通用文件条目的内容(文本 / 图片与二进制 base64 / 目录列表)。",
  "input": "{ id: string; relPath?: string | undefined // 目录条目内要读的文件(相对该目录)。省略 = 读条目本体 / 列目录。; which?: 'pdf' | 'md' | undefined // 读**哪一份**（2026-09-21）。 }",
  "output": "{ content: LibraryFileContent; }"
 },
 {
  "method": "library.readHighlights",
  "channel": "library:readHighlights",
  "doc": "读某篇 PDF 的全部高亮。 高亮存在 PDF **旁边**的 `.<名字>.mcode-highlights.json`（见 `main/library/pdfHighlightsStore.ts`），所以这里按**路径**问 —— 项目目录里那些 根本不在资料库里的 PDF 也要能有高亮。",
  "input": "{ pdfPath: string // PDF 的绝对路径。必须落在已知工作区根内（pathGuard）。 }",
  "output": "{ highlights: PdfHighlight[]; }"
 },
 {
  "method": "library.readMarkdown",
  "channel": "library:readMarkdown",
  "doc": "读一篇文献的 Markdown 正文,**在应用内预览**(不再跳外部编辑器)。 主进程同时把正文里引用到的图片解析成 data URL 一起返回 —— 渲染进程读不了本地 文件,而 md 里写的是 `images/xxx.jpg` 这种相对路径,只有主进程知道它相对于谁。",
  "input": "{ id: string }",
  "output": "{ ok: boolean; error?: string; markdown: string; dir: string; fileName: string; images: Record<string, string>; skipped: string[]; }"
 },
 {
  "method": "library.readOriginalPdf",
  "channel": "library:readOriginalPdf",
  "doc": "读**干净底稿**的字节 —— 烘烤时从它出发（底稿 + 全部标注 → 覆盖那个 PDF）。 没有底稿时返回当前文件本身（那时它就是干净的）。走结构化克隆，不做 base64 （同 `library.readPdf`）—— 论文十几 MB，base64 要多涨三分之一。",
  "input": "{ pdfPath: string // PDF 的绝对路径。必须落在已知工作区根内（pathGuard）。 }",
  "output": "{ bytes: Uint8Array | null; }"
 },
 {
  "method": "library.readPdf",
  "channel": "library:readPdf",
  "doc": "",
  "input": "{ id: string }",
  "output": "{ ok: boolean; error?: string; bytes: Uint8Array | null; }"
 },
 {
  "method": "library.renameCollection",
  "channel": "library:renameCollection",
  "doc": "改名。`ok: false` 表示重名被拒(此时 collections 不变) —— 由调用方提示用户。",
  "input": "{ id: string; prompt?: string | undefined // 传空串 = 清空说明(清单里不再注入这一层)。; name?: string | undefined }",
  "output": "{ collections: LibraryCollection[]; ok: boolean; }"
 },
 {
  "method": "library.renameItem",
  "channel": "library:renameItem",
  "doc": "改条目的显示标题(三个库通用)。",
  "input": "{ id: string; title: string }",
  "output": "{ item: LibraryItem | null; }"
 },
 {
  "method": "library.restoreItems",
  "channel": "library:restoreItems",
  "doc": "从回收站里**还原**这几条 —— 放回最后删除的那个分类。 与 `deleteItems` 是一对:那条(recycle bin 里)是真的删,这条是把它们捞回来。 单独一条 RPC 而不是让渲染端拼两次 `assignCollection`,理由见契约里的注释。",
  "input": "{ ids: string[] }",
  "output": "{ items: LibraryItem[]; }"
 },
 {
  "method": "library.revealFile",
  "channel": "library:revealFile",
  "doc": "在系统文件管理器里定位库里的文件(PDF 或转换出的 Markdown)。 **入参只有条目 id** —— 路径由主进程从库里取,渲染端无从指定任意路径。",
  "input": "{ id: string; which?: 'pdf' | 'md' | undefined // 定位哪一个:PDF 还是转换出的 Markdown。默认 PDF。 }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "library.saveHighlights",
  "channel": "library:saveHighlights",
  "doc": "**只写索引**（PDF 旁边那份 JSON）—— 划一笔就走这条，几毫秒，不动 PDF。",
  "input": "{ pdfPath: string; highlights: unknown[] }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "library.saveNote",
  "channel": "library:saveNote",
  "doc": "新建或修改一条笔记,返回该条目下的完整列表(与其它变更类接口同一约定)。",
  "input": "{ content: string; itemId: string; id?: string | undefined }",
  "output": "{ notes: LibraryNote[]; }"
 },
 {
  "method": "library.suppressGet",
  "channel": "library:suppressGet",
  "doc": "屏蔽规则:当前生效的(哪些资料不进上下文)。没存过 = 空规则(什么都不挡)。",
  "input": "{}",
  "output": "{ rule: LibrarySuppressRule; }"
 },
 {
  "method": "library.suppressSave",
  "channel": "library:suppressSave",
  "doc": "整表替换屏蔽规则。校验(前缀合法、扩展名规范化)在主进程过 `parseSuppressJson`。",
  "input": "{ rule?: unknown }",
  "output": "{ ok: true; } | { ok: false; error: string; }"
 },
 {
  "method": "library.writeHighlights",
  "channel": "library:writeHighlights",
  "doc": "把高亮**写回 PDF 文件本身**（真 `/Highlight` 批注）。 字节走 base64（`file:writeFile` 只收 utf-8，而 PDF 是二进制）。主进程收到后 **原子替换**，中途崩了原文件一个字节不动；顺带更新旁边的高亮索引。",
  "input": "{ pdfPath: string; bytesBase64: string // 改好的 PDF，base64（不带 `data:` 前缀）。; highlights?: unknown[] | undefined }",
  "output": "PdfHighlightsWriteResult"
 },
 {
  "method": "library.writeNote",
  "channel": "library:writeNote",
  "doc": "把编辑器的内容写回笔记文件(仅笔记)。",
  "input": "{ id: string; text: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "lsp.closeDocument",
  "channel": "lsp:closeDocument",
  "doc": "Close a document (textDocument/didClose).",
  "input": "{ filePath: string; workspacePath: string }",
  "output": "void"
 },
 {
  "method": "lsp.didChange",
  "channel": "lsp:didChange",
  "doc": "Notify the server of a full-content change (textDocument/didChange).",
  "input": "{ version: number; text: string; filePath: string; workspacePath: string }",
  "output": "void"
 },
 {
  "method": "lsp.didSave",
  "channel": "lsp:didSave",
  "doc": "Notify the server of a save (textDocument/didSave).",
  "input": "{ text: string; filePath: string; workspacePath: string }",
  "output": "void"
 },
 {
  "method": "lsp.healthCheck",
  "channel": "lsp:healthCheck",
  "doc": "Verify the server binary runs (--version or --help probe).",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java' }",
  "output": "LspOpResult"
 },
 {
  "method": "lsp.install",
  "channel": "lsp:install",
  "doc": "Install a language server via its package manager (npm/pip/go/brew).",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java' }",
  "output": "LspOpResult"
 },
 {
  "method": "lsp.installFromFile",
  "channel": "lsp:installFromFile",
  "doc": "Install from a user-downloaded archive/binary (manual download fallback for when the package-manager install fails due to network issues).",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java'; archivePath: string // Absolute path to the user-selected file (archive or binary). }",
  "output": "LspOpResult"
 },
 {
  "method": "lsp.list",
  "channel": "lsp:list",
  "doc": "List all language servers and their install/running state.",
  "input": "(无参数)",
  "output": "{ languages: LspLanguageState[]; }"
 },
 {
  "method": "lsp.openDocument",
  "channel": "lsp:openDocument",
  "doc": "Open a document in the server (textDocument/didOpen). Lazily starts the server for (workspacePath, language) on first call.",
  "input": "{ filePath: string; language: 'typescript' | 'python' | 'go' | 'java'; workspacePath: string }",
  "output": "void"
 },
 {
  "method": "lsp.prewarm",
  "channel": "lsp:prewarm",
  "doc": "",
  "input": "{ workspacePath: string // Project root to pre-warm (must be a known project). }",
  "output": "LspOpResult"
 },
 {
  "method": "lsp.request",
  "channel": "lsp:request",
  "doc": "Forward an arbitrary LSP request (definition/references/hover/...) to the server and await its response.",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java'; workspacePath: string; method: string // LSP method, e.g.; params?: unknown // LSP params object (passed through verbatim). }",
  "output": "LspRequestResult"
 },
 {
  "method": "lsp.restart",
  "channel": "lsp:restart",
  "doc": "Restart a language server for one workspace (stop + clear the crash-loop guard + immediately relaunch). Clicking a startup-failure notice calls this after the user fixes the environment.",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java'; workspacePath: string // Project root the server was started for (must be a known project). }",
  "output": "LspOpResult"
 },
 {
  "method": "lsp.setPath",
  "channel": "lsp:setPath",
  "doc": "Set a custom server path / args override. Returns the refreshed list.",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java'; args?: string[] | undefined; serverPath?: string | undefined; javaHome?: string | undefined // Java only: override the JDK used to run jdtls (JAVA_HOME). }",
  "output": "{ languages: LspLanguageState[]; }"
 },
 {
  "method": "lsp.toggle",
  "channel": "lsp:toggle",
  "doc": "Enable/disable a language (disabling kills any running server). Returns the refreshed state list.",
  "input": "{ enabled: boolean; language: 'typescript' | 'python' | 'go' | 'java' }",
  "output": "{ languages: LspLanguageState[]; }"
 },
 {
  "method": "lsp.uninstall",
  "channel": "lsp:uninstall",
  "doc": "Uninstall a language server.",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java' }",
  "output": "LspOpResult"
 },
 {
  "method": "mcp.authorize",
  "channel": "mcp:authorize",
  "doc": "Run the OAuth browser login for a remote MCP server (claude mcp login). Opens the system browser; resolves when the CLI reports the flow done.",
  "input": "{ kind: 'http' | 'sse'; name: string; url: string; scope?: 'user' | 'plugin' | 'builtin' | undefined // Source the clicked row came from. }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "mcp.enginesSet",
  "channel": "mcp:enginesSet",
  "doc": "Set an MCP server's per-engine visibility (claude/codex — pi has no MCP support). Takes the full boolean pair; both engine views re-materialize after the write, and the change lands on the next turn. Returns the resolved state as persisted (or ok:false + erro…",
  "input": "{ name: string; claude: boolean; codex: boolean }",
  "output": "{ ok: boolean; error?: string; perEngine?: McpEngineState; }"
 },
 {
  "method": "mcp.import",
  "channel": "mcp:import",
  "doc": "Import selected servers into the user scope. Already-existing names are skipped. Returns per-server imported / skipped / error lists.",
  "input": "{ servers: ({ name: string; origin: { kind: 'global'; } | { path: string; kind: 'project'; }; } | { name: string; config: z.objectOutputType<{ type: z.ZodOptional<z.ZodLi… }",
  "output": "{ imported: string[]; skipped: string[]; errors: Array<{ name: string; error: string; }>; }"
 },
 {
  "method": "mcp.list",
  "channel": "mcp:list",
  "doc": "List all MCP servers across the three sources (user config file, project .mcp.json, built-in mcode-browser) with their enabled state.",
  "input": "{}",
  "output": "{ servers: McpServerEntry[]; }"
 },
 {
  "method": "mcp.marketSearch",
  "channel": "mcp:marketSearch",
  "doc": "Search one registry (network); entries carry ready install options.",
  "input": "{ source: string; query?: string | undefined; cursor?: string | undefined }",
  "output": "McpMarketSearchResult"
 },
 {
  "method": "mcp.marketSourceAdd",
  "channel": "mcp:marketSourceAdd",
  "doc": "",
  "input": "{ url: string; label?: string | undefined }",
  "output": "{ ok: boolean; error?: string; id?: string; }"
 },
 {
  "method": "mcp.marketSourceRemove",
  "channel": "mcp:marketSourceRemove",
  "doc": "",
  "input": "{ id: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "mcp.marketSources",
  "channel": "mcp:marketSources",
  "doc": "MCP market: registry sources (built-in official registry + user added).",
  "input": "{}",
  "output": "{ sources: McpMarketSource[]; }"
 },
 {
  "method": "mcp.projectCopy",
  "channel": "mcp:projectCopy",
  "doc": "Copy user-scope servers into the project file (existing names skipped).",
  "input": "{ projectPath: string; names: string[] }",
  "output": "McpProjectCopyResult"
 },
 {
  "method": "mcp.projectList",
  "channel": "mcp:projectList",
  "doc": "Project scope (`<project>/.mcp.json`): list with trust state.",
  "input": "{ projectPath: string }",
  "output": "McpProjectListResult"
 },
 {
  "method": "mcp.projectRemove",
  "channel": "mcp:projectRemove",
  "doc": "Remove one project server from the project file.",
  "input": "{ projectPath: string; name: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "mcp.projectSave",
  "channel": "mcp:projectSave",
  "doc": "Add / overwrite one project server (auto-trusted).",
  "input": "{ projectPath: string; name: string; config: z.objectOutputType<{ type: z.ZodOptional<z.ZodLiteral<'stdio'>>; command: z.ZodString; args: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>; env: z.ZodOptional…; replace?: boolean | undefined }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "mcp.projectTrust",
  "channel": "mcp:projectTrust",
  "doc": "Trust / untrust one project server as currently written.",
  "input": "{ projectPath: string; name: string; trusted: boolean }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "mcp.remove",
  "channel": "mcp:remove",
  "doc": "Remove a user-scope server (from both the config file and the stash).",
  "input": "{ name: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "mcp.save",
  "channel": "mcp:save",
  "doc": "Add a user-scope server (writes into ~/.mcode/.claude.json).",
  "input": "{ name: string; config: z.objectOutputType<{ type: z.ZodOptional<z.ZodLiteral<'stdio'>>; command: z.ZodString; args: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>; env: z.ZodOptional…; replace?: boolean | undefined // Edit mode: overwrite the existing entry (truth layer or stash) instead of rejecting a dup… }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "mcp.scanImport",
  "channel": "mcp:scanImport",
  "doc": "Scan the local Claude CLI config (~/.claude.json) for servers available for import (global + per-project entries). Read-only.",
  "input": "{}",
  "output": "{ sources: McpImportSource[]; }"
 },
 {
  "method": "mcp.toggle",
  "channel": "mcp:toggle",
  "doc": "Enable/disable a server. User scope moves the config between the config file and the management stash; project/builtin update the management state. Takes effect on the next turn.",
  "input": "{ name: string; scope: 'user' | 'plugin' | 'builtin'; enabled: boolean }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "mcp.unauthorize",
  "channel": "mcp:unauthorize",
  "doc": "Clear a remote MCP server's stored OAuth token (claude mcp logout).",
  "input": "{ kind: 'http' | 'sse'; name: string; url: string; scope?: 'user' | 'plugin' | 'builtin' | undefined // Source the clicked row came from. }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "memory.assistant",
  "channel": "memory:assistant",
  "doc": "",
  "input": "{ sessionId: string; op: 'list'; } | { kind: 'capture' | 'checkpoint' | 'health'; sessionId: string; op: 'start'; } | { sessionId: string; op: 'cancel'; jobId: string; } | { sessionId: string; op: 'discard'; jobId: string; } | { sessionId: string; op: 'deliver'; jobId: string; targetSessionId?: string | undefined; }",
  "output": "MemoryAssistantResult"
 },
 {
  "method": "memory.categories",
  "channel": "memory:categories",
  "doc": "类目清单(固定六类)。**无参 handler**。",
  "input": "(无参数)",
  "output": "string[]"
 },
 {
  "method": "memory.delete",
  "channel": "memory:delete",
  "doc": "删一条记忆。`ok: false` 时 `error` 是给人看的句子,不是异常。",
  "input": "{ path: string; expectedRevision?: string | undefined }",
  "output": "{ ok: boolean; error?: string; code?: 'conflict'; }"
 },
 {
  "method": "memory.list",
  "channel": "memory:list",
  "doc": "",
  "input": "{ category?: string | undefined }",
  "output": "{ files: MemoryFileMeta[]; }"
 },
 {
  "method": "memory.manage",
  "channel": "memory:manage",
  "doc": "",
  "input": "{ action: 'list'; } | { source: string; action: 'preview'; } | { source: string; action: 'import'; global: boolean; category: 'project' | 'rules' | 'preferences' | 'experiences' | 'failures' | 'decisions'; digest: string; confirmed: true; projectId?: string | undefined; } | { id: string; action: 'history'; } | { id: string; action: 'restore'; digest: string; confirmed: true; }",
  "output": "MemoryManageResult"
 },
 {
  "method": "memory.read",
  "channel": "memory:read",
  "doc": "读一条记忆的正文(不含 frontmatter)。",
  "input": "{ path: string }",
  "output": "{ content: string; revision: string; }"
 },
 {
  "method": "memory.review",
  "channel": "memory:review",
  "doc": "只扫描建议，不改任何文件；截断/读失败必须在结果里显式说明。",
  "input": "(无参数)",
  "output": "MemoryReviewResult"
 },
 {
  "method": "memory.reviewDelete",
  "channel": "memory:reviewDelete",
  "doc": "整理中人工勾选并确认后的逐条删除；主进程核对完整内容指纹。",
  "input": "{ path: string; digest: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "memory.save",
  "channel": "memory:save",
  "doc": "存正文(frontmatter 由主进程维护)。",
  "input": "{ path: string; content: string; title?: string | undefined; pinned?: boolean | undefined; expectedRevision?: string | null | undefined }",
  "output": "{ ok: boolean; revision?: string; error?: string; code?: 'conflict'; }"
 },
 {
  "method": "mobile.cancelPairing",
  "channel": "mobile:cancelPairing",
  "doc": "Cancel the active pairing (clears the nonce).",
  "input": "(无参数)",
  "output": "{ ok: true; }"
 },
 {
  "method": "mobile.clearLogin",
  "channel": "mobile:clearLogin",
  "doc": "关闭账号密码登录(清掉凭据;已登录的设备保留,需要的话单独撤销)。",
  "input": "(无参数)",
  "output": "MobileLoginStatus"
 },
 {
  "method": "mobile.getActiveCount",
  "channel": "mobile:getActiveCount",
  "doc": "Count of paired devices that are currently \"active\" (made a request within {@link MOBILE_ACTIVE_WINDOW_MS }).",
  "input": "(无参数)",
  "output": "{ count: number; }"
 },
 {
  "method": "mobile.getLogin",
  "channel": "mobile:getLogin",
  "doc": "账号密码登录的状态(只有账号名 + 开没开,哈希永不出主进程)。",
  "input": "(无参数)",
  "output": "MobileLoginStatus"
 },
 {
  "method": "mobile.getStatus",
  "channel": "mobile:getStatus",
  "doc": "Server status (running, port, endpoint, candidate LAN IPs) for the dialog.",
  "input": "(无参数)",
  "output": "{ running: boolean; port: number; endpoint: string; lanIp: string | null; lanIps: string[]; }"
 },
 {
  "method": "mobile.getTunnel",
  "channel": "mobile:getTunnel",
  "doc": "手机自有域名的隧道状态(和「远程控制」/ 公网 MCP 无关,单独一份)。",
  "input": "(无参数)",
  "output": "MobileTunnelStatus"
 },
 {
  "method": "mobile.listDevices",
  "channel": "mobile:listDevices",
  "doc": "List paired devices (token stripped).",
  "input": "(无参数)",
  "output": "{ devices: PairedDevice[]; }"
 },
 {
  "method": "mobile.revokeDevice",
  "channel": "mobile:revokeDevice",
  "doc": "Revoke a paired device; its token stops working immediately.",
  "input": "{ deviceId: string }",
  "output": "{ ok: true; }"
 },
 {
  "method": "mobile.setLogin",
  "channel": "mobile:setLogin",
  "doc": "设置/修改手机端登录的账号密码(密码至少 8 位)。改密码不会踢掉已登录的设备 —— 要踢就在设备列表里撤销。",
  "input": "{ username: string; password: string }",
  "output": "MobileLoginStatus"
 },
 {
  "method": "mobile.setTunnel",
  "channel": "mobile:setTunnel",
  "doc": "存手机隧道配置(token 留空 = 沿用)。隧道在跑且配置变了会按新配置重起。",
  "input": "{ mode: 'named' | 'external' | 'off'; hostname: string; token?: string | undefined // 留空 = 沿用已存的那串。; clearToken?: boolean | undefined // 显式删掉已存的 token。 }",
  "output": "MobileTunnelStatus"
 },
 {
  "method": "mobile.startPairing",
  "channel": "mobile:startPairing",
  "doc": "Begin a pairing session: returns QR URL + 6-digit code + endpoint. Optional `host` overrides auto-detected LAN IP (for multi-NIC machines where the phone can only reach one interface).",
  "input": "{ host?: string; mode?: 'lan' | 'remote'; endpoint?: string; force?: boolean; } | undefined",
  "output": "{ pairing: PairingStartResult; }"
 },
 {
  "method": "mobile.startTunnel",
  "channel": "mobile:startTunnel",
  "doc": "启动手机隧道(named 模式起 cloudflared;并记住下次启动自动开)。",
  "input": "(无参数)",
  "output": "MobileTunnelStatus"
 },
 {
  "method": "mobile.stopTunnel",
  "channel": "mobile:stopTunnel",
  "doc": "停止手机隧道(并取消自动开启)。",
  "input": "(无参数)",
  "output": "MobileTunnelStatus"
 },
 {
  "method": "modules.cancel",
  "channel": "modules:cancel",
  "doc": "",
  "input": "{ moduleId: string; taskId: string }",
  "output": "ModuleTask"
 },
 {
  "method": "modules.catalog",
  "channel": "modules:catalog",
  "doc": "",
  "input": "(无参数)",
  "output": "ModuleCatalog"
 },
 {
  "method": "modules.install",
  "channel": "modules:install",
  "doc": "",
  "input": "{ manifest: { apiVersion: 1; id: string; version: string; title: { zh: string; en: string; }; permissions: 'resource.read'[]; contributions: { id: string; title: { zh: str…; confirmReadAccess: true }",
  "output": "ModuleCatalog"
 },
 {
  "method": "modules.invoke",
  "channel": "modules:invoke",
  "doc": "",
  "input": "{ moduleId: string; contributionId: string; resource: { path: string; projectPath: string; }; requestId: string }",
  "output": "ModuleReply"
 },
 {
  "method": "modules.remove",
  "channel": "modules:remove",
  "doc": "",
  "input": "{ moduleId: string }",
  "output": "ModuleCatalog"
 },
 {
  "method": "modules.task",
  "channel": "modules:task",
  "doc": "",
  "input": "{ moduleId: string; taskId: string }",
  "output": "ModuleTask"
 },
 {
  "method": "modules.tasks",
  "channel": "modules:tasks",
  "doc": "",
  "input": "{ projectPath: string }",
  "output": "ModuleTask[]"
 },
 {
  "method": "monitoring.overview",
  "channel": "monitoring:overview",
  "doc": "监控总览的一次快照:正在跑几个、触发器挂得怎么样。**无参 handler**。",
  "input": "(无参数)",
  "output": "MonitoringOverview"
 },
 {
  "method": "monitoring.runs",
  "channel": "monitoring:runs",
  "doc": "最近的运行摘要(新的在前),监控列表用 —— 见 `MonitoringRunSummary`。",
  "input": "{ limit?: number | undefined }",
  "output": "MonitoringRunSummary[]"
 },
 {
  "method": "notification.focusSession",
  "channel": "notification:focusSession",
  "doc": "Focus a session after an OS notification click. Main shows + focuses the window, then pushes `notification:focusSession` so the renderer navigates.",
  "input": "{ sessionId: string }",
  "output": "void"
 },
 {
  "method": "notification.getPrefs",
  "channel": "notification:getPrefs",
  "doc": "Get the user's notification preferences (typed wrapper over settings).",
  "input": "(无参数)",
  "output": "{ prefs: NotificationPrefs; }"
 },
 {
  "method": "notification.setPrefs",
  "channel": "notification:setPrefs",
  "doc": "Set (persist) the user's notification preferences.",
  "input": "{ osEnabled: boolean // Master switch for OS-level notifications.; turnComplete: boolean // Notify on turn completion (non-active session).; errors: boolean // Notify on errors (non-active session).; blocking: boolean // Notify on blocking events (approval request / question / plan approval).; backgroundTasks: boolean // Notify when a backgrounded subagent finishes.; sound: boolean // 系统通知带提示音(Electron `silent: !sound`)。Default true(老行为)。; inAppToasts: boolean // 窗口在前台时,后台会话的动静弹应用内提示(Toast)。关掉 = 前台时什么都不弹, 只留角标。Default true(老行为)。; alsoWhenFocused: boolean // 窗口在前台时也发系统通知(默认只在失焦 / 最小化时发)。Default false(老行为)。; mutedProjectIds: string[] // 按项目静音:这些项目里的会话不发系统通知、也不弹应用内提示(角标照旧)。; quietHours: { enabled: boolean; start: string; end: string; } // 免打扰时段(本地时间 HH:MM,可跨午夜)。时段内不发系统通知、不弹提示。 }",
  "output": "{ prefs: NotificationPrefs; }"
 },
 {
  "method": "onlyoffice.close",
  "channel": "onlyoffice:close",
  "doc": "关掉会话(清掉主进程里那份记录)。",
  "input": "{ sessionKey: string }",
  "output": "{ ok: boolean; }"
 },
 {
  "method": "onlyoffice.detectLocal",
  "channel": "onlyoffice:detectLocal",
  "doc": "本机装没装 Document Server、跑没跑、密钥是什么。 设置页用它做**自动填写**:检测到本机那一份就把地址与密钥直接写进配置,用户 不用手抄 `local.json`。主进程里 `detectLocal()` 早就有了(安装流程与工具链 检测都在用),这里只是把它开给渲染端 —— 不然「自动帮我配好」这件事在 UI 侧 无从谈起。只读,不需要管理员权限。",
  "input": "(无参数)",
  "output": "OnlyOfficeLocalDetectResult"
 },
 {
  "method": "onlyoffice.forceSave",
  "channel": "onlyoffice:forceSave",
  "doc": "让 DS 立刻回调保存(用户点「保存」/ 关标签前)。",
  "input": "{ sessionKey: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "onlyoffice.getConfig",
  "channel": "onlyoffice:getConfig",
  "doc": "",
  "input": "(无参数)",
  "output": "{ serverUrl: string; jwtSecret: string; callbackHost: string; }"
 },
 {
  "method": "onlyoffice.open",
  "channel": "onlyoffice:open",
  "doc": "为一个文件开一次编辑会话:返回 DS 的 api.js 地址与直接交给 `DocsAPI.DocEditor` 的配置。",
  "input": "{ filePath: string // 绝对路径。必须落在某个已知工作区根内（与 `file:readFile` 同一道闸）。; mode?: 'view' | 'edit' | undefined // `view` 用于资料库/通用文件查看器；默认 `edit`。; deviceType?: 'desktop' | 'mobile' | undefined // 移动端查看器使用 OnlyOffice 的 mobile 布局。 }",
  "output": "OnlyOfficeOpenResult"
 },
 {
  "method": "onlyoffice.sessionState",
  "channel": "onlyoffice:sessionState",
  "doc": "某次会话的保存状态(最近保存时间 / 最近错误 / DS 状态码)。",
  "input": "{ sessionKey: string }",
  "output": "OnlyOfficeSessionState"
 },
 {
  "method": "onlyoffice.setConfig",
  "channel": "onlyoffice:setConfig",
  "doc": "",
  "input": "{ serverUrl: string // Document Server 地址，如 `http://127.0.0.1:8080`。空 = 未配置（Office 文件只能只读预览）。; jwtSecret: string // JWT 密钥。DS 7.2+ 默认开启 JWT，必须与它 `services.CoAuthoring.secret` 一致；留空表示 DS 关了 JWT。; callbackHost: string // DS 回连 Mcode 时用的主机名/IP。空 = 自动：serverUrl 是本机地址就用 `127.0.0.1`， 否则取第一块非内部 IPv4 网卡地址。Docker De… }",
  "output": "{ serverUrl: string; jwtSecret: string; callbackHost: string; }"
 },
 {
  "method": "onlyoffice.status",
  "channel": "onlyoffice:status",
  "doc": "是否配置了 DS、以及它现在能不能连上(`/healthcheck`)。",
  "input": "(无参数)",
  "output": "OnlyOfficeStatusResult"
 },
 {
  "method": "outputStyle.list",
  "channel": "outputStyle:list",
  "doc": "Output styles (settings panel): list built-in + user styles. The selection itself is persisted via the generic setting.get/set channels under AGENT_OUTPUT_STYLE_SETTING_KEY.",
  "input": "{}",
  "output": "{ styles: OutputStyleEntry[]; }"
 },
 {
  "method": "piModels.delete",
  "channel": "piModels:delete",
  "doc": "",
  "input": "{ name: string }",
  "output": "{ providers: Record<string, PiProviderPublic>; }"
 },
 {
  "method": "piModels.getApiKey",
  "channel": "piModels:getApiKey",
  "doc": "Returns cleartext apiKey. Used two ways: (1) main-process turn-time injection into the pi authStorage; (2) the settings UI's eye-icon view (same security carve-out as customModel.getToken).",
  "input": "{ name: string }",
  "output": "{ apiKey: string | null; }"
 },
 {
  "method": "piModels.list",
  "channel": "piModels:list",
  "doc": "",
  "input": "(无参数)",
  "output": "{ providers: Record<string, PiProviderPublic>; }"
 },
 {
  "method": "piModels.listAvailable",
  "channel": "piModels:listAvailable",
  "doc": "List models the SDK can authenticate with the current configured keys. Builds a fresh ModelRuntime with all encrypted apiKeys injected, then returns getAvailable() projected into BuiltinModelOption[] shape for the composer's model picker.",
  "input": "(无参数)",
  "output": "{ models: BuiltinModelOption[]; }"
 },
 {
  "method": "piModels.save",
  "channel": "piModels:save",
  "doc": "",
  "input": "{ name: string; config: Record<string, unknown>; apiKey?: string | undefined }",
  "output": "{ providers: Record<string, PiProviderPublic>; }"
 },
 {
  "method": "plugins.enginesSet",
  "channel": "plugins:enginesSet",
  "doc": "Per-engine switches of one plugin (Claude / Codex / Pi), like the skill matrix. Omitted engines keep their value; lands on the next turn.",
  "input": "{ name: string; claude?: boolean | undefined; codex?: boolean | undefined; pi?: boolean | undefined }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "plugins.installGit",
  "channel": "plugins:installGit",
  "doc": "Install by shallow-cloning a git repository. Same review flow.",
  "input": "{ url: string; ref?: string | undefined }",
  "output": "{ ok: boolean; error?: string; plugin?: PluginState; }"
 },
 {
  "method": "plugins.installLocal",
  "channel": "plugins:installLocal",
  "doc": "Install from a local plugin directory or .zip. Lands DISABLED; the renderer shows the component-review dialog and calls setEnabled.",
  "input": "{ localPath: string }",
  "output": "{ ok: boolean; error?: string; plugin?: PluginState; }"
 },
 {
  "method": "plugins.installMarketplace",
  "channel": "plugins:installMarketplace",
  "doc": "Install one entry of a user-added marketplace. Same review flow.",
  "input": "{ name: string; marketplace: string }",
  "output": "{ ok: boolean; error?: string; plugin?: PluginState; }"
 },
 {
  "method": "plugins.list",
  "channel": "plugins:list",
  "doc": "List installed plugins (manifest + component summaries + enable state). Enabled plugins are delivered to providers at the next turn start.",
  "input": "(无参数)",
  "output": "{ plugins: PluginState[]; }"
 },
 {
  "method": "plugins.marketplaceAdd",
  "channel": "plugins:marketplaceAdd",
  "doc": "Add a marketplace (git URL or local directory).",
  "input": "{ kind: 'local' | 'git'; ref: string // git URL, or absolute local directory path.; name?: string | undefined }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "plugins.marketplaceList",
  "channel": "plugins:marketplaceList",
  "doc": "List user-added marketplaces with their parsed entries.",
  "input": "(无参数)",
  "output": "{ marketplaces: PluginMarketplaceState[]; }"
 },
 {
  "method": "plugins.marketplaceRefresh",
  "channel": "plugins:marketplaceRefresh",
  "doc": "Re-fetch a marketplace's tree.",
  "input": "{ name: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "plugins.marketplaceRemove",
  "channel": "plugins:marketplaceRemove",
  "doc": "Remove a marketplace (cloned tree deleted; installed plugins stay).",
  "input": "{ name: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "plugins.projectList",
  "channel": "plugins:projectList",
  "doc": "Installed plugins as seen from one project (override ∘ global).",
  "input": "{ projectPath: string }",
  "output": "{ plugins: PluginProjectRow[]; }"
 },
 {
  "method": "plugins.projectSet",
  "channel": "plugins:projectSet",
  "doc": "Set / clear one plugin's per-project override.",
  "input": "{ projectPath: string; name: string; enabled?: boolean | null | undefined; engines?: { claude?: boolean | undefined; codex?: boolean | undefined; pi?: boolean | undefined; } | null | undefined }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "plugins.remove",
  "channel": "plugins:remove",
  "doc": "Uninstall every installed version of a plugin. Rejected while any turn is running.",
  "input": "{ name: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "plugins.setEnabled",
  "channel": "plugins:setEnabled",
  "doc": "Enable/disable a plugin for subsequent turns.",
  "input": "{ name: string; enabled: boolean }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "project.archive",
  "channel": "project:archive",
  "doc": "Set a project's archived flag (soft-delete; restorable).",
  "input": "{ id: string; archived: boolean }",
  "output": "{ project: Project; }"
 },
 {
  "method": "project.create",
  "channel": "project:create",
  "doc": "",
  "input": "{ path: string; name: string }",
  "output": "{ project: Project; }"
 },
 {
  "method": "project.delete",
  "channel": "project:delete",
  "doc": "Hard-delete a project; its sessions + messages cascade-delete (DB FK).",
  "input": "{ id: string }",
  "output": "void"
 },
 {
  "method": "project.list",
  "channel": "project:list",
  "doc": "",
  "input": "(无参数)",
  "output": "{ projects: Project[]; }"
 },
 {
  "method": "project.pin",
  "channel": "project:pin",
  "doc": "Pin/unpin a project (top-of-left-bar pinned section). Returns the updated row.",
  "input": "{ id: string; pinned: boolean }",
  "output": "{ project: Project; }"
 },
 {
  "method": "project.rename",
  "channel": "project:rename",
  "doc": "Rename a project (display-only). Returns the updated row.",
  "input": "{ id: string; name: string }",
  "output": "{ project: Project; }"
 },
 {
  "method": "project.reorder",
  "channel": "project:reorder",
  "doc": "Persist a drag-to-reorder: writes sort_order = index for each id.",
  "input": "{ orderedIds: string[] }",
  "output": "void"
 },
 {
  "method": "project.sessions",
  "channel": "project:sessions",
  "doc": "",
  "input": "{ projectId: string; worktree?: 'exclude' | 'only' | undefined; limit?: number | undefined; offset?: number | undefined; archived?: boolean | undefined }",
  "output": "{ sessions: Session[]; hasMore: boolean; total: number; }"
 },
 {
  "method": "project.setGroup",
  "channel": "project:setGroup",
  "doc": "Assign a project to a group (left-bar \"grouped\" view); null removes it.",
  "input": "{ id: string; group: string | null }",
  "output": "{ project: Project; }"
 },
 {
  "method": "projectInit.apply",
  "channel": "projectInit:apply",
  "doc": "",
  "input": "{ sessionId: string; command: string; digest: string }",
  "output": "ProjectInitResult"
 },
 {
  "method": "projectInit.delete",
  "channel": "projectInit:delete",
  "doc": "",
  "input": "{ id: string; expectedRevision: string }",
  "output": "{ ok: true; }"
 },
 {
  "method": "projectInit.get",
  "channel": "projectInit:get",
  "doc": "",
  "input": "{ id: string }",
  "output": "ProjectInitTemplate"
 },
 {
  "method": "projectInit.list",
  "channel": "projectInit:list",
  "doc": "列记忆文件(可选按类目过滤),行形状见 `../memory.ts` 的 `MemoryFileMeta`。",
  "input": "(无参数)",
  "output": "ProjectInitList"
 },
 {
  "method": "projectInit.preview",
  "channel": "projectInit:preview",
  "doc": "",
  "input": "{ sessionId: string; command: string }",
  "output": "ProjectInitPreview"
 },
 {
  "method": "projectInit.save",
  "channel": "projectInit:save",
  "doc": "",
  "input": "{ draft: { files: { path: string; content: string; }[]; name: string; description: string; directories: string[]; memories: { title: string; pinned: boolean; content: s…; id?: string | undefined; expectedRevision?: string | undefined }",
  "output": "ProjectInitTemplate"
 },
 {
  "method": "projectInit.setDefault",
  "channel": "projectInit:setDefault",
  "doc": "设定裸 `/init` 预选的场景;`null` 清除。",
  "input": "{ id: string | null }",
  "output": "{ ok: true; }"
 },
 {
  "method": "provider.commands",
  "channel": "provider:commands",
  "doc": "问引擎要**它自己的斜杠命令清单**（2026-09-21）。 ## 为什么不能只靠事件 清单的**权威来源**是引擎在每轮 `system/init` 里推的 `slash_commands` （见 `@contracts/runtime` 的 `CommandsAvailableEvent`）。但那条路有个致命的时机问题： init 只在**开跑一轮**时才来。而用户想打开 `/` 菜单看有哪些命令，恰恰是在 **还没发过消息**的时候 —— 也就是清单还空着的时候。 所以这一条把清单的获取**提前到会话建立…",
  "input": "{ providerId: string; cwd?: string | undefined }",
  "output": "ProviderCommandsResult"
 },
 {
  "method": "provider.healthCheck",
  "channel": "provider:healthCheck",
  "doc": "Probe the selected registered provider through its own health check.",
  "input": "{ providerId: string; force?: boolean | undefined // Bypass a completed cached result; an in-flight probe is still shared. }",
  "output": "ProviderHealthCheckResult"
 },
 {
  "method": "provider.list",
  "channel": "provider:list",
  "doc": "",
  "input": "(无参数)",
  "output": "{ providers: ProviderInfo[]; }"
 },
 {
  "method": "publicMcp.addProjectLink",
  "channel": "publicMcp:addProjectLink",
  "doc": "给一个项目单独发一条公网链接(自己的密钥 + 自己的合成会话 + 沙箱 = 该项目目录)。 已经有了就原样返回。几条链接可同时被不同的 ChatGPT 对话使用,互不干扰。",
  "input": "{ projectId: string }",
  "output": "PublicMcpStatus"
 },
 {
  "method": "publicMcp.regenerateProjectLinkSecret",
  "channel": "publicMcp:regenerateProjectLinkSecret",
  "doc": "换某个项目链接的密钥(旧链接立刻失效)。",
  "input": "{ projectId: string }",
  "output": "PublicMcpStatus"
 },
 {
  "method": "publicMcp.regenerateSecret",
  "channel": "publicMcp:regenerateSecret",
  "doc": "换一把路径密钥（旧链接立刻失效）。这是用户唯一的\"拉闸\"手段。",
  "input": "(无参数)",
  "output": "PublicMcpStatus"
 },
 {
  "method": "publicMcp.removeProjectLink",
  "channel": "publicMcp:removeProjectLink",
  "doc": "删掉某个项目的公网链接(链接立刻失效;合成会话留着,记录不丢)。",
  "input": "{ projectId: string }",
  "output": "PublicMcpStatus"
 },
 {
  "method": "publicMcp.setEnabled",
  "channel": "publicMcp:setEnabled",
  "doc": "开关这条公网通路。打开时现建「ChatGPT 直连」合成会话并起监听；关闭时停服务。 ⚠️ 打开 = 拿到链接的人拥有本机完全操作权（无审批闸门，见 publicMcpServer.ts）。",
  "input": "{ enabled: boolean }",
  "output": "PublicMcpStatus"
 },
 {
  "method": "publicMcp.setProject",
  "channel": "publicMcp:setProject",
  "doc": "改沙箱目录 —— 公网进来的文件工具能碰哪个项目。传 null 取消选择。",
  "input": "{ projectId: string | null }",
  "output": "PublicMcpStatus"
 },
 {
  "method": "publicMcp.setTunnelConfig",
  "channel": "publicMcp:setTunnelConfig",
  "doc": "存隧道配置(模式 / 自有域名 / Tunnel Token / 固定端口)。 token 留空 = 沿用已存的那串;返回的状态里**只带尾 4 位**。",
  "input": "{ mode: 'quick' | 'named' | 'external'; token?: string | undefined // named 必填。空串 = 不改动已存的那串(界面上留空表示\"沿用\")。; hostname?: string | undefined // named / external 必填:MCP 端点的公网域名,不带协议。; mobileHostname?: string | undefined // 可选:手机伴侣的公网域名。空 = 不暴露手机。; fixedPort?: number | undefined // 公网 MCP 服务的固定本机端口;0 = 随机。随机只适合 quick —— named / external 的 ingress 写死了端口,所以那两种模式下存 0 会被换成默…; clearToken?: boolean | undefined // 清掉已存的 Tunnel Token(`token` 留空只表示\"沿用\",没法表达\"删掉\")。; agentDelegate?: boolean | undefined // 把 mcode agent 本身交给外面的 AI 支使。缺席 = 不改动。默认关,见设置键上那段警告。 }",
  "output": "PublicMcpStatus"
 },
 {
  "method": "publicMcp.startTunnel",
  "channel": "publicMcp:startTunnel",
  "doc": "起公网隧道（Mcode 自己 spawn cloudflared），成功后 `tunnelUrl` 带上域名。",
  "input": "(无参数)",
  "output": "PublicMcpStatus"
 },
 {
  "method": "publicMcp.status",
  "channel": "publicMcp:status",
  "doc": "公网 MCP 端点：把 mcode 的工具表暴露给互联网上的 MCP 客户端（ChatGPT 的 Connector）。只读快照，含路径密钥（明文，要显示给用户复制）。",
  "input": "(无参数)",
  "output": "PublicMcpStatus"
 },
 {
  "method": "publicMcp.stopTunnel",
  "channel": "publicMcp:stopTunnel",
  "doc": "停公网隧道（开关仍开着，只是不再对外暴露）。",
  "input": "(无参数)",
  "output": "PublicMcpStatus"
 },
 {
  "method": "relay.connect",
  "channel": "relay:connect",
  "doc": "Connect to the VPS: SSH + deploy forwarder + reverse tunnel.",
  "input": "(无参数)",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "relay.disconnect",
  "channel": "relay:disconnect",
  "doc": "Disconnect from the VPS (forwarder keeps running on the VPS).",
  "input": "(无参数)",
  "output": "{ ok: true; }"
 },
 {
  "method": "relay.getConfig",
  "channel": "relay:getConfig",
  "doc": "Read the saved VPS config (passwords included — main→renderer only).",
  "input": "(无参数)",
  "output": "{ config: RelayVpsConfig | null; }"
 },
 {
  "method": "relay.saveConfig",
  "channel": "relay:saveConfig",
  "doc": "Save VPS connection config to settings (persisted across restarts).",
  "input": "{ username: string; password: string; host: string; sshPort: number; hostKeyFingerprint: string; publicPort: number; forwarder: 'auto' | 'socat' | 'python3'; privateKeyPath?: string | undefined }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "relay.status",
  "channel": "relay:status",
  "doc": "Read the current relay status.",
  "input": "(无参数)",
  "output": "RelayStatus"
 },
 {
  "method": "rg.install",
  "channel": "rg:install",
  "doc": "Download + install the ripgrep binary into userData/bin (one-click).",
  "input": "{}",
  "output": "RgInstallResult"
 },
 {
  "method": "rg.status",
  "channel": "rg:status",
  "doc": "ripgrep availability snapshot (drives the search-dialog install banner).",
  "input": "(无参数)",
  "output": "RgStatusResult"
 },
 {
  "method": "runs.history",
  "channel": "runs:history",
  "doc": "某个对话的图运行历史(新的在前)。**从存档折出来**,只给轻量摘要 —— 见 `PersistedWorkflowRunLite`(整份快照不为一行列表过 IPC)。",
  "input": "{ sessionId: string; limit?: number | undefined // 最多几条。不给就用主进程的默认值。 }",
  "output": "PersistedWorkflowRunLite[]"
 },
 {
  "method": "runtimes.install",
  "channel": "runtimes:install",
  "doc": "Download + install (or update/reinstall) a runtime into userData/runtimes. Resolves when the install fully finished.",
  "input": "{ agent: 'claude' | 'codex' | 'pi' }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "runtimes.installLocal",
  "channel": "runtimes:installLocal",
  "doc": "Install a runtime from a user-picked local path (install directory, binary, or .tgz). The version is taken from the package.json when available, else the expected version.",
  "input": "{ agent: 'claude' | 'codex' | 'pi'; localPath: string // Absolute local path (directory, binary, or .tgz). }",
  "output": "{ ok: boolean; error?: string; version?: string; }"
 },
 {
  "method": "runtimes.list",
  "channel": "runtimes:list",
  "doc": "List the claude/codex/pi runtimes: expected vs installed vs latest version, install state and disk footprint. `latestVersion` is fetched from the registry on each call (best-effort, null when offline).",
  "input": "(无参数)",
  "output": "{ runtimes: RuntimeAgentState[]; }"
 },
 {
  "method": "runtimes.remove",
  "channel": "runtimes:remove",
  "doc": "Delete an installed runtime from disk. Rejected while any turn is running.",
  "input": "{ agent: 'claude' | 'codex' | 'pi' }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "session.archive",
  "channel": "session:archive",
  "doc": "Set a session's archived flag (soft-delete; restorable).",
  "input": "{ id: string; archived: boolean }",
  "output": "{ session: Session; }"
 },
 {
  "method": "session.delete",
  "channel": "session:delete",
  "doc": "Hard-delete a session; its messages cascade-delete (DB FK).",
  "input": "{ id: string }",
  "output": "void"
 },
 {
  "method": "session.fork",
  "channel": "session:fork",
  "doc": "把一段对话复制成新的一段:上下文原样带过去,两边之后各走各的。",
  "input": "{ id: string; title: string }",
  "output": "{ session: Session; }"
 },
 {
  "method": "session.hasNodes",
  "channel": "session:hasNodes",
  "doc": "",
  "input": "{ sessionId: string }",
  "output": "{ has: boolean; }"
 },
 {
  "method": "session.listAll",
  "channel": "session:listAll",
  "doc": "Cross-project non-archived sessions, newest-first (stream sidebar).",
  "input": "{ limit?: number | undefined; offset?: number | undefined; projectIds?: string[] | undefined // Project scope: only rows whose project_id is in this list.; worktreeKey?: string | undefined // Worktree-checkout scope: only sessions bound to that isolated checkout, as a normalized p… }",
  "output": "{ sessions: Session[]; hasMore: boolean; total: number; }"
 },
 {
  "method": "session.listNodes",
  "channel": "session:listNodes",
  "doc": "The workflow-node sessions of ONE conversation — \"which step has a session, and what is it called\". Read-only, and the only way a node session is ever listed: every other query pins `kind = 'chat'`. Why it exists: a node session is where a step's history live…",
  "input": "{ sessionId: string // The conversation whose graph spawned them (they hang off it as `parentSessionId`). }",
  "output": "{ sessions: Session[]; }"
 },
 {
  "method": "session.listPinned",
  "channel": "session:listPinned",
  "doc": "All pinned non-archived sessions across projects (most recent pin first) — powers the left bar's global pinned section above the project tree.",
  "input": "(无参数)",
  "output": "{ sessions: Session[]; }"
 },
 {
  "method": "session.messages",
  "channel": "session:messages",
  "doc": "",
  "input": "{ sessionId: string; limit?: number | undefined // Page size.; beforeCreatedAt?: number | undefined // Cursor: fetch the page strictly older than this (createdAt, id) pair.; beforeId?: string | undefined }",
  "output": "{ messages: MessageRecord[]; hasMore: boolean; }"
 },
 {
  "method": "session.pin",
  "channel": "session:pin",
  "doc": "Pin/unpin a session (project-scoped). Returns the updated row.",
  "input": "{ id: string; pinned: boolean }",
  "output": "{ session: Session; }"
 },
 {
  "method": "session.rename",
  "channel": "session:rename",
  "doc": "Rename a session (persist a user-edited title). Returns the updated row.",
  "input": "{ id: string; title: string }",
  "output": "{ session: Session; }"
 },
 {
  "method": "session.saveMessages",
  "channel": "session:saveMessages",
  "doc": "",
  "input": "{ sessionId: string; messages: MessageRecord[] }",
  "output": "void"
 },
 {
  "method": "session.search",
  "channel": "session:search",
  "doc": "Cross-project session search by title substring (Ctrl+K unified search).",
  "input": "{ query: string; limit?: number | undefined }",
  "output": "{ sessions: Session[]; }"
 },
 {
  "method": "session.searchBookmarks",
  "channel": "session:searchBookmarks",
  "doc": "Cross-session bookmark search (Ctrl+K unified search).",
  "input": "{ query: string; limit?: number | undefined }",
  "output": "{ results: BookmarkSearchResult[]; }"
 },
 {
  "method": "session.truncateAndInsertMessages",
  "channel": "session:truncateAndInsertMessages",
  "doc": "",
  "input": "{ sessionId: string; cursorCreatedAt: number; cursorId: string; messages: MessageRecord[] }",
  "output": "void"
 },
 {
  "method": "session.updateBookmarks",
  "channel": "session:updateBookmarks",
  "doc": "Replace a session's bookmark list (full-array write). Returns the updated row.",
  "input": "{ id: string; bookmarks: { id: string; createdAt: number; messageId: string; excerpt: string; role: 'user' | 'assistant'; title?: string | null | undefined; }[] }",
  "output": "{ session: Session; }"
 },
 {
  "method": "session.updateSettings",
  "channel": "session:updateSettings",
  "doc": "Update the active session's model / effort / permissionMode / customModelId in-place.",
  "input": "{ sessionId: string; projectId?: string | undefined // Directory re-aim (new-session panel's directory switcher): move a FRESH local session to …; providerId?: string | undefined // Provider id (e.g.; model?: string | undefined; effort?: string | undefined; permissionMode?: string | undefined; customModelId?: string | null | undefined; envMode?: 'local' | 'worktree' | undefined // Working-environment intent flip (composer chip).; wtStyle?: 'detached' | 'branch' | null | undefined // Worktree FORM flip (composer chip) — same un-materialized-only contract as envMode.; workflowId?: string | undefined; composerMode?: string | undefined // 旧字段名,接受一个版本 —— 理由见上面 SendTurnSchema 那段。 }",
  "output": "void"
 },
 {
  "method": "session.upsertMessages",
  "channel": "session:upsertMessages",
  "doc": "",
  "input": "{ sessionId: string; messages: MessageRecord[] }",
  "output": "void"
 },
 {
  "method": "setting.exportToFile",
  "channel": "setting:exportToFile",
  "doc": "导出设置到 JSON 文件(主进程弹保存框;不含密钥与本机状态)。",
  "input": "(无参数)",
  "output": "SettingExportFileResult"
 },
 {
  "method": "setting.get",
  "channel": "setting:get",
  "doc": "",
  "input": "{ key: string }",
  "output": "{ value: string | null; }"
 },
 {
  "method": "setting.getMany",
  "channel": "setting:getMany",
  "doc": "",
  "input": "{ keys: string[] }",
  "output": "GetManySettingsResult"
 },
 {
  "method": "setting.importFromFile",
  "channel": "setting:importFromFile",
  "doc": "从 JSON 文件导入设置(主进程弹打开框;先备份当前设置)。",
  "input": "(无参数)",
  "output": "SettingImportFileResult"
 },
 {
  "method": "setting.set",
  "channel": "setting:set",
  "doc": "",
  "input": "{ value: string; key: string }",
  "output": "void"
 },
 {
  "method": "shell.openFile",
  "channel": "shell:openFile",
  "doc": "Open a file with the OS's default associated application. Accepts any path that resolves inside a known project root (not just the root).",
  "input": "{ path: string }",
  "output": "void"
 },
 {
  "method": "shell.openPath",
  "channel": "shell:openPath",
  "doc": "Open a path in the OS file manager. Main refuses any path that isn't a known project root, so this can't be used to open arbitrary locations.",
  "input": "{ path: string }",
  "output": "void"
 },
 {
  "method": "shell.showItemInFolder",
  "channel": "shell:showItemInFolder",
  "doc": "Reveal a file or directory in the OS file manager, selecting it. Accepts any path that resolves inside a known project root (not just the root).",
  "input": "{ path: string }",
  "output": "void"
 },
 {
  "method": "skills.bundles",
  "channel": "skills:bundles",
  "doc": "Read the bundle manifest (import groups of the universal library). Missing / unparsable manifest → empty list.",
  "input": "{}",
  "output": "{ bundles: SkillBundle[]; }"
 },
 {
  "method": "skills.copyToProject",
  "channel": "skills:copyToProject",
  "doc": "**把技能从通用库复制到项目**（`<项目>/.claude/skills/`）。批量，逐条回报 结果 —— 单个失败（重名 / 读不到源）不影响其余的。",
  "input": "{ projectPath: string // 项目根目录（绝对路径）。没有它就没有\"项目\"可言。; names: string[] // 要复制的逻辑技能名（由宿主解析实际目录）。 }",
  "output": "SkillsCopyToProjectResult"
 },
 {
  "method": "skills.delete",
  "channel": "skills:delete",
  "doc": "Delete a skill directory (symlink → unlink link only; real dir → recursive remove). Returns ok:false + error on any IO failure.",
  "input": "{ name: string; source: 'global' | 'project'; projectPath?: string | undefined }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "skills.engines.set",
  "channel": "skills:enginesSet",
  "doc": "Set one universal skill's per-engine availability (claude/codex/pi). Returns the resolved state as persisted (or ok:false + error).",
  "input": "{ name: string; claude: boolean; codex: boolean; pi: boolean }",
  "output": "{ ok: boolean; error?: string; perEngine?: SkillEngineState; }"
 },
 {
  "method": "skills.enginesSetBulk",
  "channel": "skills:enginesSetBulk",
  "doc": "Set the per-engine availability for many skills at once (group-level switch). Returns per-name resolved state (or ok:false + error).",
  "input": "{ names: string[]; claude: boolean; codex: boolean; pi: boolean }",
  "output": "{ ok: boolean; error?: string; perEngine?: Record<string, SkillEngineState>; }"
 },
 {
  "method": "skills.import",
  "channel": "skills:import",
  "doc": "Import (copy) selected skills from external tool directories into ~/.mcode/skills. Already-existing skills are skipped. Returns per-skill imported / skipped / error lists.",
  "input": "{ skills: { name: string; sourcePath: string; }[] }",
  "output": "{ imported: string[]; skipped: string[]; errors: Array<{ name: string; error: string; }>; }"
 },
 {
  "method": "skills.importGithub",
  "channel": "skills:importGithub",
  "doc": "Import a whole skill package from a GitHub repo URL — shallow-clone, discover every SKILL.md, copy each skill in, and group them all under one bundle. Returns the bundle + per-skill lists.",
  "input": "{ url: string // GitHub repository URL. }",
  "output": "SkillsImportGithubResult"
 },
 {
  "method": "skills.list",
  "channel": "skills:list",
  "doc": "Discover skills for the composer `/` menu. Scans the user-global `~/.mcode/skills/` universal library and parses each SKILL.md's frontmatter. Always resolves (degrades to an empty list on any IO error). `projectPath` is accepted but ignored (single-scope sinc…",
  "input": "{ projectPath?: string | undefined }",
  "output": "{ skills: SkillInfo[]; }"
 },
 {
  "method": "skills.marketAdd",
  "channel": "skills:marketAdd",
  "doc": "Add a skill market (git URL / owner/repo / local directory) — fetches it.",
  "input": "{ kind: 'local' | 'git'; ref: string // GitHub `owner/repo`, any git URL, or an absolute local directory.; name?: string | undefined }",
  "output": "{ ok: boolean; error?: string; name?: string; }"
 },
 {
  "method": "skills.marketInstall",
  "channel": "skills:marketInstall",
  "doc": "Copy market skills into the universal library (existing names skipped).",
  "input": "{ names: string[]; market: string }",
  "output": "SkillsMarketInstallResult"
 },
 {
  "method": "skills.marketList",
  "channel": "skills:marketList",
  "doc": "Skill market: catalogs (built-in + user added) with their entries.",
  "input": "{}",
  "output": "{ markets: SkillMarketState[]; }"
 },
 {
  "method": "skills.marketRefresh",
  "channel": "skills:marketRefresh",
  "doc": "Re-fetch one market's catalog (network).",
  "input": "{ name: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "skills.marketRemove",
  "channel": "skills:marketRemove",
  "doc": "Remove a user-added skill market (built-ins cannot be removed).",
  "input": "{ name: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "skills.presetsDelete",
  "channel": "skills:presetsDelete",
  "doc": "删一套预设。",
  "input": "{ id: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "skills.presetsList",
  "channel": "skills:presetsList",
  "doc": "**一套技能预设** —— \"这类项目默认装这几个\"。改整个数组（整份给过来， 局部更新在这里没有意义，同 `workflow.agentProfiles` 的取舍）。",
  "input": "(无参数)",
  "output": "{ presets: SkillPreset[]; }"
 },
 {
  "method": "skills.presetsSave",
  "channel": "skills:presetsSave",
  "doc": "存一套预设（新建或覆盖同 id 的）。",
  "input": "{ preset: { id: string; skills: string[]; name: string; description?: string | undefined; } }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "skills.projectOverview",
  "channel": "skills:projectOverview",
  "doc": "**跨项目总览** —— 每个项目各装了哪些技能。`projectIds` 省略 = 全部项目。",
  "input": "{ projectIds?: string[] | undefined }",
  "output": "SkillsProjectOverviewResult"
 },
 {
  "method": "skills.read",
  "channel": "skills:read",
  "doc": "Read one skill's full SKILL.md source (no truncation). Missing file → empty content.",
  "input": "{ name: string // Discovered logical name (frontmatter name or directory fallback).; source: 'global' | 'project' | 'plugin' | 'builtin' // Which skills root to read from.; projectPath?: string | undefined }",
  "output": "{ content: string; }"
 },
 {
  "method": "skills.save",
  "channel": "skills:save",
  "doc": "Create or overwrite a skill's SKILL.md (full content write; creates the skill directory if absent). Returns ok:false + error on any IO failure.",
  "input": "{ name: string; content: string // Full SKILL.md text (frontmatter + body).; source: 'global' | 'project'; projectPath?: string | undefined; newName?: string | undefined }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "skills.scanSources",
  "channel": "skills:scanSources",
  "doc": "Scan external tools (Claude Code / Codex / Zcode) for skills available for import into Mcode's own ~/.mcode/skills. Returns the full list of discoverable skills with their source paths.",
  "input": "{ localDir?: string | undefined // Optional: a user-picked local directory to scan in addition to the fixed external tool di…; localFile?: string | undefined // Optional: a user-picked single skill file (.md/.markdown) to import as a one-file skill. }",
  "output": "{ sources: ExternalSkillInfo[]; }"
 },
 {
  "method": "terminal.create",
  "channel": "terminal:create",
  "doc": "Spawn a PTY in the project cwd (or a subdir).",
  "input": "{ projectPath: string; cwd?: string | undefined // Optional working directory; must resolve inside projectPath.; cols?: number | undefined; rows?: number | undefined; shell?: string | undefined // Optional shell override for this session only.; origin?: { kind: 'user'; } | { kind: 'session'; sessionId: string; title?: string | undefined; nodeSessionId?: string | undefined; } | undefined // 谁开的。**可选** —— 不传 = 用户手点的(`{ kind: \"user\" }`),所以既有的 调用方一行都不用改,而界面上那一条照样说得出来历。 }",
  "output": "TerminalCreateResult"
 },
 {
  "method": "terminal.kill",
  "channel": "terminal:kill",
  "doc": "Kill a PTY process and drop it from the manager.",
  "input": "{ terminalId: string }",
  "output": "TerminalOpResult"
 },
 {
  "method": "terminal.list",
  "channel": "terminal:list",
  "doc": "List live terminals, optionally filtered by project.",
  "input": "{ projectPath?: string | undefined // When set, only terminals bound to this project root are returned.; bufferFor?: string | undefined // 要**顺带把输出尾巴带回来**的那一条终端 id(见 {@link TerminalInfo.buffer})。 }",
  "output": "{ terminals: TerminalInfo[]; }"
 },
 {
  "method": "terminal.resize",
  "channel": "terminal:resize",
  "doc": "Notify the PTY of a cols/rows change (after xterm fit).",
  "input": "{ cols: number; rows: number; terminalId: string }",
  "output": "TerminalOpResult"
 },
 {
  "method": "terminal.write",
  "channel": "terminal:write",
  "doc": "Write raw input bytes/text to a live PTY.",
  "input": "{ data: string; terminalId: string }",
  "output": "TerminalOpResult"
 },
 {
  "method": "theme.get",
  "channel": "theme:get",
  "doc": "",
  "input": "(无参数)",
  "output": "GetThemeResult"
 },
 {
  "method": "theme.set",
  "channel": "theme:set",
  "doc": "",
  "input": "{ theme: 'dark' | 'light' | 'system' }",
  "output": "GetThemeResult"
 },
 {
  "method": "toolchain.check",
  "channel": "toolchain:check",
  "doc": "检测本机工具链:pandoc / python 包 / TeX / zip 各自找到没有、什么版本、 在哪。安装或卸载后重新调它即可刷新面板。",
  "input": "(无参数)",
  "output": "{ tools: ToolchainToolState[]; }"
 },
 {
  "method": "toolchain.install",
  "channel": "toolchain:install",
  "doc": "安装一个应用能管的工具(pandoc 由应用下载;python-deps 走用户解释器的 pip)。进度走 `toolchain:event`。",
  "input": "{ tool: 'pandoc' | 'latex' | 'python-deps' | 'zip-tools' | 'soffice' | 'pdftoppm' | 'onlyoffice' }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "toolchain.remove",
  "channel": "toolchain:remove",
  "doc": "删掉应用管理的那份(只对 managed 有效;用户自己装的 system 那份不动)。",
  "input": "{ tool: 'pandoc' | 'latex' | 'python-deps' | 'zip-tools' | 'soffice' | 'pdftoppm' | 'onlyoffice' }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "tools.usage",
  "channel": "tools:usage",
  "doc": "Static per-tool context-usage estimate for one engine.",
  "input": "{ engine: 'claude' | 'codex' | 'pi' }",
  "output": "ToolsUsageResult"
 },
 {
  "method": "usage.stats",
  "channel": "usage:stats",
  "doc": "Aggregate the persisted per-turn usage history into summary / per-model / per-day views for the requested time range. Read-only.",
  "input": "{ preset: 'today' | '7d' | '30d' | 'all' }",
  "output": "UsageStatsResult"
 },
 {
  "method": "voice.cancel",
  "channel": "voice:cancel",
  "doc": "",
  "input": "{ sessionId: string }",
  "output": "void"
 },
 {
  "method": "voice.cancelModelDownload",
  "channel": "voice:cancelModelDownload",
  "doc": "Cancel an in-flight model download (no-op if none).",
  "input": "{ modelId: string }",
  "output": "void"
 },
 {
  "method": "voice.downloadModel",
  "channel": "voice:downloadModel",
  "doc": "Begin downloading a catalog model. Returns immediately; progress arrives on the `voice:downloadProgress` push.",
  "input": "{ modelId: string }",
  "output": "void"
 },
 {
  "method": "voice.feed",
  "channel": "voice:feed",
  "doc": "",
  "input": "{ sessionId: string; pcm: Float32Array<ArrayBuffer> | number[] }",
  "output": "void"
 },
 {
  "method": "voice.getModelDir",
  "channel": "voice:getModelDir",
  "doc": "Read the current effective voice model root (custom or default).",
  "input": "{}",
  "output": "{ modelDir: string; isCustom: boolean; }"
 },
 {
  "method": "voice.modelList",
  "channel": "voice:modelList",
  "doc": "List the model catalog + downloaded models + active selection.",
  "input": "(无参数)",
  "output": "{ models: VoiceModelInfo[]; downloaded: string[]; selected: string | null; modelDir: string; isCustom: boolean; }"
 },
 {
  "method": "voice.removeModel",
  "channel": "voice:removeModel",
  "doc": "Delete a downloaded model's local files (the active selection is re-pointed at another downloaded model, or cleared).",
  "input": "{ modelId: string }",
  "output": "void"
 },
 {
  "method": "voice.selectModel",
  "channel": "voice:selectModel",
  "doc": "Persist the active voice model selection for the composer mic button.",
  "input": "{ modelId: string }",
  "output": "void"
 },
 {
  "method": "voice.setModelDir",
  "channel": "voice:setModelDir",
  "doc": "Change the voice model root directory. Empty string = default. The new path is scanned; already-present catalog models appear as \"downloaded\" in the returned list, no re-download required.",
  "input": "{ modelDir: string // Absolute path, or \"\" to reset to the default. }",
  "output": "{ downloaded: string[]; modelDir: string; isCustom: boolean; }"
 },
 {
  "method": "voice.start",
  "channel": "voice:start",
  "doc": "",
  "input": "{ sessionId: string // Opaque per-listen token chosen by the renderer (e.g.; lang: string // Speech language tag, e.g.; engine: 'zipformer' | 'parakeet' // Desired engine: \"zipformer\" (streaming, interim results) | \"parakeet\" (offline, higher ac… }",
  "output": "void"
 },
 {
  "method": "voice.stop",
  "channel": "voice:stop",
  "doc": "",
  "input": "{ sessionId: string }",
  "output": "{ text: string; }"
 },
 {
  "method": "webBridge.regenerateToken",
  "channel": "webBridge:regenerateToken",
  "doc": "换一个配对令牌（旧令牌立刻失效，已连上的扩展会被断开重连）。",
  "input": "(无参数)",
  "output": "ExtensionBridgeStatus"
 },
 {
  "method": "webBridge.status",
  "channel": "webBridge:status",
  "doc": "设置页只读快照：扩展桥地址 / 令牌 / 是否已配对。会顺带把服务拉起来。",
  "input": "(无参数)",
  "output": "ExtensionBridgeStatus"
 },
 {
  "method": "workflow.agentProfiles",
  "channel": "workflow:agentProfiles",
  "doc": "代理档案:一份存下来的**子 agent 配置**(指令 / 技能 / 模型 / 引擎……)。建节点的 时候直接套一份,不用从空白开始填。 它是**值**不是类型 —— 删掉一份档案不会让任何已有的图跑不起来(节点身上已经有参数 了)。见 `@contracts/agentProfile` 的文件头。 ⚠️ 无参 handler,同 `workflow.list`。",
  "input": "(无参数)",
  "output": "AgentProfileCatalog"
 },
 {
  "method": "workflow.applyShippedUpdate",
  "channel": "workflow:applyShippedUpdate",
  "doc": "自带工作流的出厂版有更新时:用出厂版覆盖这一行(用户关掉的触发器保持关闭)。",
  "input": "{ id: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "workflow.approve",
  "channel": "workflow:approve",
  "doc": "Separate approval for the saved revision; saving/importing is not consent to execute an automation or to inject an imported workflow prompt.",
  "input": "{ id: string; revision: string }",
  "output": "{ ok: boolean; review?: WorkflowReviewInfo; error?: string; }"
 },
 {
  "method": "workflow.choose",
  "channel": "workflow:choose",
  "doc": "在**岔路口**上选一条路(`mcode.branch` 那个节点正停在那儿等着)。 它唤醒的是一个**还活着的运行**,不是开一次新的 —— 图从那个节点接着往下跑, 不重跑整张图。见 `@contracts/runtime` 的 `WorkflowNodeChoiceEvent`。 `ok: false` = 没有这样的等待;若图已更改或旧存档无版本, `error` 说明为何不能续跑。普通旧卡片不弹错误框。",
  "input": "{ sessionId: string; runId: string; nodeId: string; edgeId: string // 选中的那条**边**的 id。**不是节点 id** —— 两条出路可以通向同一步。; comment?: string | undefined // 用户顺手写的一句话(可以不写)。会拼进下一步的提示词。 }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "workflow.dismissShippedUpdate",
  "channel": "workflow:dismissShippedUpdate",
  "doc": "忽略这次出厂更新(内容不动;出厂内容再变时重新提示)。",
  "input": "{ id: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "workflow.export",
  "channel": "workflow:export",
  "doc": "把**磁盘上那一份**导出成 JSON 文本,走系统「另存为」框落盘。用户取消时 `canceled: true`,界面不该报错(取消不是失败)。路径**由主进程拿**,渲染端 始终没有\"写任意路径\"的能力(同 `library.revealFile`)。",
  "input": "{ id: string; suggestedName?: string | undefined // 保存框的默认文件名(不带扩展名)。渲染端**按用户当前的语言**给,因为主进程不知道 他此刻的界面语言(同 `dialog.pickFiles` 的 `title`:文案由调用方… }",
  "output": "{ ok: boolean; canceled?: boolean; path?: string; error?: string; }"
 },
 {
  "method": "workflow.get",
  "channel": "workflow:get",
  "doc": "取一份完整工作流。找不到返回 null(比如列表之后被别处删了)。",
  "input": "{ id: string }",
  "output": "{ workflow: WorkflowDoc | null; revision: string | null; review: WorkflowReviewInfo | null; }"
 },
 {
  "method": "workflow.import",
  "channel": "workflow:import",
  "doc": "收下一份导出的 JSON。**`id` 给了就是覆盖那一份**(必须已存在),不给就是新建 (id 现生成、重名自动加后缀)。",
  "input": "{ text: string // 文件的 JSON 正文(渲染端读好了给过来)。; id?: string | undefined // 覆盖哪一份。不给就是新建。 }",
  "output": "{ ok: boolean; id?: string; name?: string; errors?: string[]; warnings?: string[]; error?: string; }"
 },
 {
  "method": "workflow.importFromFile",
  "channel": "workflow:importFromFile",
  "doc": "从**文件**导入 —— 主进程自己弹选择框并读文件。 为什么要这一条而不是让界面先 `file.readFile`:那条 RPC 被项目根闸门挡着,而用户 手上那份工作流多半存在项目外(下载目录、桌面)。选择框由用户亲手点,信任级别与 `dialog.pickFiles` 相同。`id` 同 `workflow.import`:给了就是覆盖。 ⚠️ 与 `workflow.import` 是**两条入口、同一段落库逻辑** —— 用户在文件管理器里 双击 `.json` 那条路(未来)只需要后者。",
  "input": "{ id?: string | undefined }",
  "output": "{ ok: boolean; canceled?: boolean; id?: string; name?: string; errors?: string[]; warnings?: string[]; error?: string; }"
 },
 {
  "method": "workflow.list",
  "channel": "workflow:list",
  "doc": "全部工作流:内置打底 + 用户覆盖 + 自建。**不含 nodes / edges**,画布打开某一项 时才走 `workflow.get` 取完整文档。",
  "input": "(无参数)",
  "output": "{ workflows: WorkflowListEntry[]; }"
 },
 {
  "method": "workflow.nodeTypes",
  "channel": "workflow:nodeTypes",
  "doc": "当前可用的**节点类型**(内置 + 已启用插件 + 用户自写),以及读不进来的清单文件 和它们的错误。画布的\"添加节点\"菜单用前者;后者必须一起返回,否则用户写错一个 清单,界面上只会看到自己的类型凭空消失。 ⚠️ 无参 handler,同 `workflow.list`:不接 raw、不 parse。",
  "input": "(无参数)",
  "output": "NodeTypeCatalog"
 },
 {
  "method": "workflow.pinDefault",
  "channel": "workflow:pinDefault",
  "doc": "把内置工作流**当前生效的版本**钉成「默认」—— 之后 `workflow.remove`(恢复默认) 回到钉住的这一版(覆盖之前的默认,包括应用自带那份的地位)。",
  "input": "{ id: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "workflow.remove",
  "channel": "workflow:remove",
  "doc": "删一份。删掉对内置工作流的覆盖 = 「恢复默认」;`wasBuiltin` 让界面能说对话 (「已恢复默认」而不是「已删除」)。",
  "input": "{ id: string }",
  "output": "{ ok: boolean; wasBuiltin: boolean; }"
 },
 {
  "method": "workflow.removeAgentProfile",
  "channel": "workflow:removeAgentProfile",
  "doc": "",
  "input": "{ id: string }",
  "output": "{ ok: boolean; }"
 },
 {
  "method": "workflow.restoreDefault",
  "channel": "workflow:restoreDefault",
  "doc": "把钉住的快照写回(「恢复默认」)。没钉过 → 失败并说清。",
  "input": "{ id: string }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "workflow.retry",
  "channel": "workflow:retry",
  "doc": "**从失败那一步接着往下跑。** 用户在失败卡片上点了「再试一次」,顺手写了句 「上次哪里不对」。重跑的是那一步**连同它的全部下游**(见 `WorkflowRetrySchema`)。 `ok: false` 有四种原因,全都**不是错误**(界面上是一句\"这张卡不适用了\"): 找不到那次运行 / 它已经不是 `failed` / 存档读不回来 / 这个对话正有运行在跑。 最后那种要如实回 false —— `startWorkflowRun` 在运行中会静静地不做事。",
  "input": "{ sessionId: string; runId: string; nodeId: string // 从哪一步开始重跑。; note?: string | undefined // 用户写的一句话:「上次哪里不对」。**只给这一步看**(可以不写)。 }",
  "output": "{ ok: boolean; error?: string; }"
 },
 {
  "method": "workflow.save",
  "channel": "workflow:save",
  "doc": "存一份。**存盘前过 DAG 校验 + 每个节点的参数校验**,有环/悬空边/参数不合法 直接拒绝 —— 有环的图会让调度器永远等不到就绪节点,那不是报错是静默卡死。",
  "input": "{ workflow: { id: string; name: string; builtin: boolean; updatedAt: number; nodes: { params: Record<string, unknown>; type: string; id: string; title: string; position: {…; expectedRevision?: string | null | undefined // Hash returned by workflow.get, or null only when creating a new id. }",
  "output": "{ ok: boolean; error?: string; warnings?: string[]; }"
 },
 {
  "method": "workflow.saveAgentProfile",
  "channel": "workflow:saveAgentProfile",
  "doc": "存一份(按 id 覆盖)。整份给过来 —— 理由同 `hooks.save`。",
  "input": "{ profile: { params: Record<string, unknown>; type: string; id: string; version: 1; createdAt: number; name: string; updatedAt: number; description?: string | undefined; } }",
  "output": "{ ok: boolean; error?: string; }"
 }
];
