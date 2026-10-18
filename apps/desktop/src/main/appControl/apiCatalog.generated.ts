// ⚠️ 生成文件,别手改。来源:packages/contracts/src/ipc/rpcMap.ts + src/preload/index.ts
// 重新生成:在 apps/desktop 下 `node scripts/gen-app-api-catalog.mjs`
export interface ApiCatalogEntry {
  method: string;
  channel: string;
  doc: string;
  /** 浅展开(给每回合常驻的 app_api_list 输出;嵌套对象留 {…})。 */
  input: string;
  /** 【MC-040】深展开(给 app_api_describe({detail:"full"}) 按需返回;嵌套到 2 层)。 */
  inputFull: string;
  output: string;
}

export const API_CATALOG: readonly ApiCatalogEntry[] = [
 {
  "method": "agentSsh.approveHost",
  "channel": "agentSsh:approveHost",
  "doc": "批准某 `host:port` 的某指纹(宿主签发 `approvalSource:\"user\"` 授权,写盘 + 回读确认)。",
  "input": "{ hostPort: string; fingerprint: string }",
  "inputFull": "{ hostPort: string; fingerprint: string }",
  "output": "{ ok: boolean; error?: string | undefined; grant?: { hostPort: string; fingerprint: string; approvedAt: number; grantId: string; } | undefined }"
 },
 {
  "method": "agentSsh.list",
  "channel": "agentSsh:list",
  "doc": "列出待用户批准(候选指纹)与已信任的 SSH 主机。",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ pending: AgentSshPendingHost[]; trusted: AgentSshTrustedHost[]; storeInvalid: boolean // known-hosts / 授权表存储损坏 —— 界面据此显示\"信任表损坏\",而不是静默假装空。 }"
 },
 {
  "method": "agentSsh.revokeHost",
  "channel": "agentSsh:revokeHost",
  "doc": "撤销某 `host:port` 的授权(用户撤回批准)。",
  "input": "{ hostPort: string }",
  "inputFull": "{ hostPort: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "app.checkForUpdates",
  "channel": "app:checkForUpdates",
  "doc": "Check for updates on the GitHub Releases channel. Returns the current version when up-to-date, the new version when available, or an error. In dev this short-circuits to \"up-to-date\" (updater only runs in prod).",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ status: 'up-to-date'; version: string } | { status: 'available'; version: string; manualInstallRequired: boolean } | { status: 'error'; error: string }"
 },
 {
  "method": "app.downloadUpdate",
  "channel": "app:downloadUpdate",
  "doc": "Start downloading the pending update (autoDownload is off, so the user opts in via this call). Resolves once the download begins; the `update:downloaded` push event fires when it's ready to install.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "void"
 },
 {
  "method": "app.getDataRoot",
  "channel": "app:getDataRoot",
  "doc": "当前数据根,以及它下面两样东西的**实际路径**(设置页展示用)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ root: string; dbPath: string; libraryPath: string }"
 },
 {
  "method": "app.info",
  "channel": "app:info",
  "doc": "App version + runtime info for the About panel.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ appVersion: string // App version string (e.g.; electron: string // Electron version.; node: string // Bundled Node.js version.; chromium: string // Bundled Chromium version.; platform: string // OS platform: \"win32\" | \"darwin\" | \"linux\".; arch: string // C…"
 },
 {
  "method": "app.moveDataRoot",
  "channel": "app:moveDataRoot",
  "doc": "把整个数据根迁到新位置,**迁完自动重启应用**(数据库没法原地搬家)。 `ok:false` + `error` 时不重启,设置也不改。",
  "input": "{ path: string }",
  "inputFull": "{ path: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "app.quitAndInstall",
  "channel": "app:quitAndInstall",
  "doc": "Quit the app and install the downloaded update (called after `update:downloaded`).",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "void"
 },
 {
  "method": "automation.preflight",
  "channel": "automation:preflight",
  "doc": "**触发前只读预检**:回答「它会跑哪条工作流、缺什么执行器、要不要先审查、参数坏没坏」。 **不产生任何副作用**(不建会话、不写运行记录、不派发)。`ok` 只表示预检没发现问题, 不是执行授权。返回形状见 `AutomationPreflightResult`。",
  "input": "{ workflowId: string; triggerNodeId: string }",
  "inputFull": "{ workflowId: string; triggerNodeId: string }",
  "output": "{ ok: boolean; workflowId: string; triggerKey: string; problem?: AutomationPreflightProblem | undefined; problems: AutomationPreflightProblem[]; capabilities: { required: string[]; available: string[]; } }"
 },
 {
  "method": "automation.rebuildWatchTemplates",
  "channel": "automation:rebuildWatchTemplates",
  "doc": "【MC-054】显式「备份损坏原值 → 校验 → 重建」—— 唯一能吃下损坏状态的操作。",
  "input": "{ templates?: { id: string; name: string; command: string; }[] | undefined }",
  "inputFull": "{ templates?: { id: string; name: string; command: string; }[] | undefined }",
  "output": "{ ok: boolean; error?: string | undefined; backupKey?: string | undefined; kept?: number | undefined }"
 },
 {
  "method": "automation.run",
  "channel": "automation:run",
  "doc": "**立刻跑一次**。走的就是那条自动化的 manual 那条路(见 `automationRunner.runNow`), 所以试出来的结果和它定时跑起来是同一样东西。 `ok: false` 时 `error` 是**给人看的句子**(比如\"这个触发器不在一条已保存的自动化里\"), 不是异常 —— 用户点了一个还没存过的触发器,该得到一句解释而不是一个错误框。",
  "input": "{ workflowId: string; triggerNodeId: string // 用**哪个触发器**起这一次 —— 一条自动化可以有多个触发器,它们的工作目录和请求 都可能不一样,所以这里必须指名道姓。 }",
  "inputFull": "{ workflowId: string; triggerNodeId: string // 用**哪个触发器**起这一次 —— 一条自动化可以有多个触发器,它们的工作目录和请求 都可能不一样,所以这里必须指名道姓。 }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "automation.runs",
  "channel": "automation:runs",
  "doc": "运行历史(新的在前)。**从存档折出来**,不是另存的一份 —— 见 `AutomationRunEntry`。",
  "input": "{ workflowId: string; limit?: number | undefined // 最多几条(新的在前)。不给就用主进程的默认值。 }",
  "inputFull": "{ workflowId: string; limit?: number | undefined // 最多几条(新的在前)。不给就用主进程的默认值。 }",
  "output": "{ runs: AutomationRunEntry[] }"
 },
 {
  "method": "automation.sessions",
  "channel": "automation:sessions",
  "doc": "后台会话：sessionId 优先为活跃会话，否则最近使用；没跑过为 null。 sessionIds 列出全部项目的会话供历史汇总；可选以兼容旧版响应。",
  "input": "{ workflowId: string }",
  "inputFull": "{ workflowId: string }",
  "output": "{ sessionId: string | null; sessionIds?: string[] | undefined }"
 },
 {
  "method": "automation.statusAll",
  "channel": "automation:statusAll",
  "doc": "全部触发器的**事实状态**(挂没挂上 / 为什么 / 最近一次跑,见 `AutomationTriggerFacts`)。**无参 handler**,同 `workflow.agentProfiles`。 返回项额外带**判定后的诊断**(`activeFailure` / `missedNotice`,见 `diagnoseTriggerFacts`)—— Agent 不必自己重判旧账。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ length: number // Gets or sets the length of the array.; toString: () => string // Returns a string representation of an array.; toLocaleString: { (): string; (locales: string | string[], options?: Intl.NumberFormatOptions & Intl.DateTimeFormatOptions): str…"
 },
 {
  "method": "automation.watch",
  "channel": "automation:watch",
  "doc": "以某条会话为发起会话起一次守望。`ok: false` 时 `error` 是给人看的句子(不在跑、 发起会话没了、模板被改坏……),不是异常 —— 点按钮的人该得到解释而不是错误框。",
  "input": "{ sessionId: string; message?: string | undefined; command?: string | undefined }",
  "inputFull": "{ sessionId: string; message?: string | undefined; command?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "automation.watchStatus",
  "channel": "automation:watchStatus",
  "doc": "这条会话上有没有正在跑的守望(面板提示\"上一次还在跑\"用)。",
  "input": "{ sessionId: string }",
  "inputFull": "{ sessionId: string }",
  "output": "{ active: boolean }"
 },
 {
  "method": "automation.watchTemplates",
  "channel": "automation:watchTemplates",
  "doc": "全部命令模板(守望面板的下拉)。**无参 handler**,同 `workflow.agentProfiles`。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ templates: { id: string; name: string; command: string; }[]; health: 'valid' | 'absent' | 'corrupt' | 'partial' | 'read_error' // 【MC-054】设置的完整性:absent=没配过 / valid / partial=有条目读不出(problems 列出) / corrupt=整份坏 / read_erro…; problems: string[]; revision?: stri…"
 },
 {
  "method": "automation.watchTemplatesSave",
  "channel": "automation:watchTemplatesSave",
  "doc": "存整份命令模板列表。整份给过来 —— 理由同 `workflow.saveAgentProfile`。 【MC-054】带 `expectedRevision` 时做原值版本检查:盘上已被别处改动 → `ok:false` 并说明,不覆盖对方刚保存的内容(两端并发编辑不再静默丢更新)。",
  "input": "{ templates: { id: string; name: string; command: string; }[]; expectedRevision?: string | null | undefined // 【MC-054】保存方上次读到的 revision。 }",
  "inputFull": "{ templates: { id: string; name: string; command: string; }[]; expectedRevision?: string | null | undefined // 【MC-054】保存方上次读到的 revision。 }",
  "output": "{ ok: boolean; error?: string | undefined; conflict?: boolean | undefined; currentRevision?: string | undefined }"
 },
 {
  "method": "browser.authRespond",
  "channel": "browser:authRespond",
  "doc": "Answer a pending HTTP Basic Auth prompt (see \"authRequest\" push event). Returns a discriminated receipt (accepted / cancelled / expired / failed) so the dialog can distinguish a delivered answer from one the challenge never received (timed out or already cons…",
  "input": "{ requestId: string; username: string // Empty username+password cancels the auth prompt.; password: string }",
  "inputFull": "{ requestId: string; username: string // Empty username+password cancels the auth prompt.; password: string }",
  "output": "{ status: BrowserAuthRespondStatus; requestId: string }"
 },
 {
  "method": "browser.bookmarkAdd",
  "channel": "browser:bookmarkAdd",
  "doc": "Bookmark a page (dedupe by URL, move to front).",
  "input": "{ title: string; url: string }",
  "inputFull": "{ title: string; url: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.bookmarkRemove",
  "channel": "browser:bookmarkRemove",
  "doc": "Remove one bookmark by URL.",
  "input": "{ url: string }",
  "inputFull": "{ url: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.captureFrame",
  "channel": "browser:captureFrame",
  "doc": "Capture one frame of the current page (visibility untouched) for the renderer's frozen-frame placeholder.",
  "input": "{ browserId: string }",
  "inputFull": "{ browserId: string }",
  "output": "{ ok: boolean; data?: string | undefined; mimeType?: 'image/png' | undefined; error?: string | undefined }"
 },
 {
  "method": "browser.clearCache",
  "channel": "browser:clearCache",
  "doc": "Clear the embedded browser's HTTP cache + temporary site storage (localStorage / IndexedDB / service workers / etc.). Cookies and login data are preserved, so the user stays signed in.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.clearCookies",
  "channel": "browser:clearCookies",
  "doc": "Clear ALL cookies from the shared browser session (sign-out everywhere) AND wipe the persisted cookie vault, so sign-ins cannot resurrect on restart via restoreCookieVault.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.close",
  "channel": "browser:close",
  "doc": "Destroy the view and drop it from the manager.",
  "input": "{ browserId: string }",
  "inputFull": "{ browserId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.create",
  "channel": "browser:create",
  "doc": "Create a browser view bound to a project root. Returns an opaque id.",
  "input": "{ projectPath: string; initialDevice?: 'custom' | 'desktop' | 'iphone' | 'iphone-se' | 'android' | 'galaxy-s23' | 'ipad-mini' | undefined // Optional initial device-emulation preset applied once the view's renderer is ready (dom-r… }",
  "inputFull": "{ projectPath: string; initialDevice?: 'custom' | 'desktop' | 'iphone' | 'iphone-se' | 'android' | 'galaxy-s23' | 'ipad-mini' | undefined // Optional initial device-emulation preset applied once the view's renderer is ready (dom-r… }",
  "output": "{ ok: true; browserId: string } | { ok: false; error: string }"
 },
 {
  "method": "browser.downloadAction",
  "channel": "browser:downloadAction",
  "doc": "Open a tracked download's file with the OS default app (\"open\", only allowed once the download completed) or select it in the containing folder (\"reveal\"). The path is resolved main-side from the download registry — see BrowserDownloadActionSchema.",
  "input": "{ action: 'open' | 'reveal'; downloadId: string }",
  "inputFull": "{ action: 'open' | 'reveal'; downloadId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.goBack",
  "channel": "browser:goBack",
  "doc": "History back.",
  "input": "{ browserId: string }",
  "inputFull": "{ browserId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.goForward",
  "channel": "browser:goForward",
  "doc": "History forward.",
  "input": "{ browserId: string }",
  "inputFull": "{ browserId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.hide",
  "channel": "browser:hide",
  "doc": "Hide the view (move offscreen without destroying the session).",
  "input": "{ browserId: string }",
  "inputFull": "{ browserId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.historyClear",
  "channel": "browser:historyClear",
  "doc": "Clear the whole address-bar history.",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.historyRemove",
  "channel": "browser:historyRemove",
  "doc": "Remove one entry from the address-bar history.",
  "input": "{ url: string }",
  "inputFull": "{ url: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.loadUrl",
  "channel": "browser:loadUrl",
  "doc": "Navigate the view to a URL.",
  "input": "{ url: string; browserId: string }",
  "inputFull": "{ url: string; browserId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.reload",
  "channel": "browser:reload",
  "doc": "Reload the current page.",
  "input": "{ browserId: string }",
  "inputFull": "{ browserId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.setBounds",
  "channel": "browser:setBounds",
  "doc": "Reposition/resize the view over the renderer's placeholder.",
  "input": "{ browserId: string; x: number; y: number; width: number; height: number }",
  "inputFull": "{ browserId: string; x: number; y: number; width: number; height: number }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.setDevice",
  "channel": "browser:setDevice",
  "doc": "Set the device emulation preset (desktop / iphone / android).",
  "input": "{ browserId: string; device: 'custom' | 'desktop' | 'iphone' | 'iphone-se' | 'android' | 'galaxy-s23' | 'ipad-mini'; width?: number | undefined // Custom viewport width (required when device === \"custom\").; height?: number | undefined // Custom viewport height (required when device === \"custom\").; orientation?: 'portrait' | 'landscape' | undefined // Screen orientation; \"landscape\" swaps width/height.; viewportWidth?: number | undefined // Effective emulated viewport size (CSS px) to apply.; viewportHeight?: number | undefined }",
  "inputFull": "{ browserId: string; device: 'custom' | 'desktop' | 'iphone' | 'iphone-se' | 'android' | 'galaxy-s23' | 'ipad-mini'; width?: number | undefined // Custom viewport width (required when device === \"custom\").; height?: number | undefined // Custom viewport height (required when device === \"custom\").; orientation?: 'portrait' | 'landscape' | undefined // Screen orientation; \"landscape\" swaps width/height.; viewportWidth?: number | undefined // Effective emulated viewport size (CSS px) to apply.; viewportHeight?: number | undefined }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.setPickMode",
  "channel": "browser:setPickMode",
  "doc": "Inject/remove the DOM element picker into the page's main world.",
  "input": "{ browserId: string; enabled: boolean }",
  "inputFull": "{ browserId: string; enabled: boolean }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.show",
  "channel": "browser:show",
  "doc": "Show the view (attach + restore bounds).",
  "input": "{ browserId: string }",
  "inputFull": "{ browserId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "browser.vaultStatus",
  "channel": "browser:vaultStatus",
  "doc": "【MC-023】Cookie 保管库健康态:加密是否可用、持久化是否在保存、已保存多少条、 是否擦过旧明文、最近一次保存被拒/恢复失败的原因。设置界面据此显示\"加密不可用、 已停用持久化(原因)\"与\"这次启动登录态没恢复(原因)\" —— 不再有静默的明文降级, 也不再让「解不开密文」与「没有 Cookie」同形。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ encryptionAvailable: boolean // safeStorage(系统钥匙串/DPAPI)现在是否可用 —— 不可用时不保存 Cookie。; persistLogin: boolean // 用户是否开着「记住网站登录状态」。; savedCount: number // 上次成功保存的 Cookie 条数(-1 = 本进程还没保存过)。; plaintextErased: boolean // 本次进程是否擦除过旧版本留下的明文保管库字段。; lastError: string | …"
 },
 {
  "method": "claude.approve",
  "channel": "claude:approve",
  "doc": "回应一条待审批的工具调用（`requestId` 对上 `approval.request` 事件）。**认不出这个 id 只记一条 warn、不抛** —— 用户点了过期的审批卡是正常会发生的事。",
  "input": "{ requestId: string; sessionId: string; granted: boolean; always?: boolean | undefined }",
  "inputFull": "{ requestId: string; sessionId: string; granted: boolean; always?: boolean | undefined }",
  "output": "{ status: ApprovalReceiptStatus; requestId: string }"
 },
 {
  "method": "claude.inject",
  "channel": "claude:inject",
  "doc": "往正在跑的那一轮里塞一句话。返回 `{ delivered }` —— **\"收下了没有\",不是\"发出去了 没有\"**:这一轮刚好收尾、或者引擎不支持,都是 `false`,渲染端据此**兜回普通的发送** (见 `sessionStore.injectPrompt`)。用户打了字而什么都没发生,是最糟的一种结果。",
  "input": "{ sessionId: string; text: string }",
  "inputFull": "{ sessionId: string; text: string }",
  "output": "{ delivered: boolean }"
 },
 {
  "method": "claude.interrupt",
  "channel": "claude:interrupt",
  "doc": "打断当前这一轮。**图型工作流没有\"会话自己的回合\"可断**——这一下停的是整张图(停派发 + 逐个 interrupt 在飞节点),随后会话标成 `interrupted`。",
  "input": "{ sessionId: string }",
  "inputFull": "{ sessionId: string }",
  "output": "void"
 },
 {
  "method": "claude.listSideChats",
  "channel": "claude:listSideChats",
  "doc": "List a main session's side chats (kind=\"side\"), newest first.",
  "input": "{ parentSessionId: string }",
  "inputFull": "{ parentSessionId: string }",
  "output": "{ sessions: Session[] }"
 },
 {
  "method": "claude.readTaskOutput",
  "channel": "claude:readTaskOutput",
  "doc": "读一个 bash 任务的输出（`task_notification.output_file`）。 `truncated` 表示读到的只是尾部 —— 那个文件可能很大，而主进程有窗口上限 （同 `COMMAND_OUTPUT_TAIL_CHARS` 的取舍：错误栈与结果都在尾部）。",
  "input": "{ taskId: string; sessionId: string }",
  "inputFull": "{ taskId: string; sessionId: string }",
  "output": "{ text: string; truncated: boolean }"
 },
 {
  "method": "claude.respondPlanApproval",
  "channel": "claude:respondPlanApproval",
  "doc": "Submit the user's approve/reject decision on a pending ExitPlanMode plan.",
  "input": "{ requestId: string; sessionId: string; approved: boolean; reason?: string | undefined; editedPlan?: string | undefined; feedback?: string | undefined }",
  "inputFull": "{ requestId: string; sessionId: string; approved: boolean; reason?: string | undefined; editedPlan?: string | undefined; feedback?: string | undefined }",
  "output": "{ status: ApprovalReceiptStatus; requestId: string }"
 },
 {
  "method": "claude.respondQuestion",
  "channel": "claude:respondQuestion",
  "doc": "Submit the user's answers to a pending AskUserQuestion.",
  "input": "{ sessionId: string; requestId: string; answers: UserInputAnswers; dismissed?: boolean | undefined }",
  "inputFull": "{ sessionId: string; requestId: string; answers: UserInputAnswers; dismissed?: boolean | undefined }",
  "output": "void"
 },
 {
  "method": "claude.rewindTurn",
  "channel": "claude:rewindTurn",
  "doc": "Rewind a turn: restore the given files to their pre-turn state. Works for the latest turn, any historical turn, or a session reopened after restart (the renderer passes the explicit entries). Returns the paths that were actually restored AND the ones that wer…",
  "input": "{ sessionId: string; files: { kind: 'modified' | 'created'; filePath: string; adds: number; dels: number; before: string; }[]; targetFiles: string[] }",
  "inputFull": "{ sessionId: string; files: { kind: 'modified' | 'created'; filePath: string; adds: number; dels: number; before: string; }[]; targetFiles: string[] }",
  "output": "{ restored: string[]; failed: string[]; conflicts: string[] }"
 },
 {
  "method": "claude.saveSubagents",
  "channel": "claude:saveSubagents",
  "doc": "Save the whole custom-subagent list (Settings → 子代理). Main validates each definition and persists to `claude.subagents`; returns the saved list so the editor can snap to what actually landed.",
  "input": "{ subagents: SubagentDefinition[] }",
  "inputFull": "{ subagents: SubagentDefinition[] }",
  "output": "{ subagents: SubagentDefinition[] }"
 },
 {
  "method": "claude.sendTurn",
  "channel": "claude:sendTurn",
  "doc": "Returns the (possibly retitled) session so the renderer can refresh.",
  "input": "{ sessionId: string; prompt: string; providerId?: string | undefined // Per-turn provider override.; model?: string | undefined // Override session-scoped settings for this turn (reflects current UI state).; effort?: string | undefined; permissionMode?: string | undefined; customModelId?: string | null | undefined // Override the session's bound custom model for this turn.; attachments?: string[] | undefined; images?: { data: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; }[] | undefined // User-attached images inlined into the provider request as base64 content blocks (NOT path…; workflowId?: string | undefined // 这一轮用的工作流。**刻意不折进 `prompt`** —— 会话标题是从 `prompt` 派生的, 折进去会让标题变成流程正文。见 main/orchestration/pr…; composerMode?: string | undefined // 旧字段名,**接受一个版本**。手机端可能还开着改版前加载的页面,而 zod 对没声明 的键是**静默丢掉**的 —— 那会表现成\"模式突然不生效了\",不报错、也不易查。; skills?: string[] | undefined //…",
  "inputFull": "{ sessionId: string; prompt: string; providerId?: string | undefined // Per-turn provider override.; model?: string | undefined // Override session-scoped settings for this turn (reflects current UI state).; effort?: string | undefined; permissionMode?: string | undefined; customModelId?: string | null | undefined // Override the session's bound custom model for this turn.; attachments?: string[] | undefined; images?: { data: string; mimeType: \"image/jpeg\" | \"image/png\" | \"image/gif\" | \"image/webp\"; }[] | undefined // User-attached images inlined into the provider request as base64 content blocks (NOT path…; workflowId?: string | undefined // 这一轮用的工作流。**刻意不折进 `prompt`** —— 会话标题是从 `prompt` 派生的, 折进去会让标题变成流程正文。见 main/orchestration/pr…; composerMode?: string | undefined // 旧字段名,**接受一个版本**。手机端可能还开着改版前加载的页面,而 zod 对没声明 的键是**静默丢掉**的 —— 那会表现成\"模式突然不生效了\",不报错、也不易查。; skills?: string[] | undefined // Skill names picked via composer skill pills this turn (no leading \"/\").; userMessage?: { id: string; createdAt: number; blocks: unknown[]; editedMessageId?: string | undefined; } | undefined // The sender's local user message (id / createdAt / display blocks). }",
  "output": "{ session: Session }"
 },
 {
  "method": "claude.startSession",
  "channel": "claude:startSession",
  "doc": "建会话(或**复用同项目里那份还\"新鲜\"的\"新对话\"行**——同一处空行连着开两次不会留下两条空会话,见 `createOrReuseSession`)。",
  "input": "{ kind: 'chat' | 'side' // Session role: \"chat\" (default, normal left-bar session) or \"side\" (side-chat Q&A session …; projectId: string; effort: string; permissionMode: string; title?: string | undefined; providerId?: string | undefined // Provider id — which AI backend to use.; model?: string | undefined; customModelId?: string | null | undefined // Id of a custom-model config to bind to this session (omit/null = built-in).; parentSessionId?: string | undefined // For kind=\"side\": the main session this Q&A thread belongs to.; envMode?: 'local' | 'worktree' | undefined // Working-environment intent for the new session.; wtStyle?: 'detached' | 'branch' | undefined // Worktree FORM for envMode=\"worktree\": \"branch\" materializes on a generated `mcode/*` bran…; worktreePath?: string | undefined // BIND to an existing managed worktree directory instead of creating a fresh one: the new s…; ag…",
  "inputFull": "{ kind: \"chat\" | \"side\" // Session role: \"chat\" (default, normal left-bar session) or \"side\" (side-chat Q&A session …; projectId: string; effort: string; permissionMode: string; title?: string | undefined; providerId?: string | undefined // Provider id — which AI backend to use.; model?: string | undefined; customModelId?: string | null | undefined // Id of a custom-model config to bind to this session (omit/null = built-in).; parentSessionId?: string | undefined // For kind=\"side\": the main session this Q&A thread belongs to.; envMode?: \"local\" | \"worktree\" | undefined // Working-environment intent for the new session.; wtStyle?: \"detached\" | \"branch\" | undefined // Worktree FORM for envMode=\"worktree\": \"branch\" materializes on a generated `mcode/*` bran…; worktreePath?: string | undefined // BIND to an existing managed worktree directory instead of creating a fresh one: the new s…; agentProfileId?: string | undefined // kind=\"side\" + 一份代理档案:这个子对话**是谁**。; memory?: boolean | undefined // kind=\"side\" + 「档案+记忆」:建会话时把记忆库的一份快照挂进去(第一轮带上)。; expectedRevision?: string | undefined // **乐观并发修订号**(ARC-001 步③)—— 可选。要在「复用项目里那条还没发言的 『New session』空壳」上做并发保护时带上它:先从 `session.list*… }",
  "output": "{ session: Session }"
 },
 {
  "method": "claude.stopTask",
  "channel": "claude:stopTask",
  "doc": "停掉某一个正在跑的子任务（子代理）。返回 `{ stopped }` —— 同 `claude.inject` 的 口径：**\"停了没有\"，不是\"发出去了没有\"**。引擎不支持、taskId 认不出来、或者它刚好 已经跑完，都是 `false`，界面据实说一句，不当作错误。",
  "input": "{ taskId: string; sessionId: string }",
  "inputFull": "{ taskId: string; sessionId: string }",
  "output": "{ stopped: boolean }"
 },
 {
  "method": "clipboard.saveFile",
  "channel": "clipboard:saveFile",
  "doc": "Persist a clipboard-pasted external file to a temp path (composer paste).",
  "input": "{ name: string // Original file name (display + extension preservation).; bytes: string // base64-encoded file bytes (~52MB file ceiling). }",
  "inputFull": "{ name: string // Original file name (display + extension preservation).; bytes: string // base64-encoded file bytes (~52MB file ceiling). }",
  "output": "{ ok: boolean; path?: string | undefined // Absolute temp path (set when ok).; error?: string | undefined }"
 },
 {
  "method": "clipboard.writeImage",
  "channel": "clipboard:writeImage",
  "doc": "Copy an image data URL onto the OS clipboard (image lightbox 复制).",
  "input": "{ dataUrl: string // Full `data:image/<mime>;base64,...` URL of the image to copy. }",
  "inputFull": "{ dataUrl: string // Full `data:image/<mime>;base64,...` URL of the image to copy. }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "codexModels.delete",
  "channel": "codexModels:delete",
  "doc": "删一个 Codex provider —— 记录与加密 key 一起删,并重写 config.toml。返回删完后的脱敏清单。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ providers: CodexProviderPublic[] }"
 },
 {
  "method": "codexModels.getApiKey",
  "channel": "codexModels:getApiKey",
  "doc": "Settings UI eye-icon only — same security carve-out as customModel.getToken / piModels.getApiKey.",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ apiKey: string | null }"
 },
 {
  "method": "codexModels.list",
  "channel": "codexModels:list",
  "doc": "列全部 Codex provider(**脱敏**;明文 key 另走 `codexModels.getApiKey`)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ providers: CodexProviderPublic[] }"
 },
 {
  "method": "codexModels.listEndpointModels",
  "channel": "codexModels:listEndpointModels",
  "doc": "问端点要模型列表(填进 Codex 表单的下拉框)。拉不到时抛错,由界面回退到手输。",
  "input": "{ baseUrl: string; apiKey?: string | undefined; authMode?: 'bearer' | 'x-api-key' | undefined; headers?: Record<string, string> | undefined; anthropicVersion?: boolean | undefined }",
  "inputFull": "{ baseUrl: string; apiKey?: string | undefined; authMode?: 'bearer' | 'x-api-key' | undefined; headers?: Record<string, string> | undefined; anthropicVersion?: boolean | undefined }",
  "output": "{ models: string[] }"
 },
 {
  "method": "codexModels.save",
  "channel": "codexModels:save",
  "doc": "新建或更新一个 Codex provider(**upsert**,apiKey 空 + 已存在=保留旧 key)。会拒绝与他人**算出同一个环境变量名**的 id(否则两个供应商的 Key 会静默互相覆盖)并重写 config.toml。",
  "input": "{ id: string; name: string; models: { id: string; label?: string | undefined; hint?: string | undefined; contextWindow?: number | undefined; thinkingLevelMap?: { max?: { kind: 'passthrough'; } | …; baseUrl: string; apiKey?: string | undefined; headers?: Record<string, string> | undefined // 额外请求头，落到该 provider 的 config.toml `http_headers`。; imageGeneration?: boolean | undefined // Opt-in: unlock codex's image generation tool by injecting the `x-openai-actor-authorizati… }",
  "inputFull": "{ id: string; name: string; models: { id: string; label?: string | undefined; hint?: string | undefined; contextWindow?: number | undefined; thinkingLevelMap?: { max?: { kind: 'passthrough'; } | …; baseUrl: string; apiKey?: string | undefined; headers?: Record<string, string> | undefined // 额外请求头，落到该 provider 的 config.toml `http_headers`。; imageGeneration?: boolean | undefined // Opt-in: unlock codex's image generation tool by injecting the `x-openai-actor-authorizati… }",
  "output": "{ providers: CodexProviderPublic[] }"
 },
 {
  "method": "codexModels.test",
  "channel": "codexModels:test",
  "doc": "同 `piModels.test`，给 Codex 表单用。",
  "input": "{ model: string // 要探测哪个模型。; baseUrl: string; apiKey?: string | undefined; authMode?: 'bearer' | 'x-api-key' | undefined // 认证头形态。缺省 = bearer（多数第三方网关）。; headers?: Record<string, string> | undefined // 额外请求头（与保存进配置的那份一致，测试才代表真回合）。; anthropicVersion?: boolean | undefined // Anthropic 风格端点要 anthropic-version 头。 }",
  "inputFull": "{ model: string // 要探测哪个模型。; baseUrl: string; apiKey?: string | undefined; authMode?: 'bearer' | 'x-api-key' | undefined // 认证头形态。缺省 = bearer（多数第三方网关）。; headers?: Record<string, string> | undefined // 额外请求头（与保存进配置的那份一致，测试才代表真回合）。; anthropicVersion?: boolean | undefined // Anthropic 风格端点要 anthropic-version 头。 }",
  "output": "{ ok: boolean; detail?: string | undefined; error?: string | undefined }"
 },
 {
  "method": "context.get",
  "channel": "context:get",
  "doc": "Read the global instructions (single source of truth file). Empty string = never configured.",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ content: string }"
 },
 {
  "method": "context.save",
  "channel": "context:save",
  "doc": "Save the global instructions and materialize each engine's consume point (CLAUDE.md for claude; the codex/pi prompt chains read the same source). `warnings` carries per-target notes (e.g. an unmanaged hand-written file was left untouched).",
  "input": "{ content: string }",
  "inputFull": "{ content: string }",
  "output": "{ ok: boolean; error?: string | undefined; warnings?: string[] | undefined }"
 },
 {
  "method": "customModel.delete",
  "channel": "customModel:delete",
  "doc": "删一份自定义模型配置(连同加密 token 一起删)。id 不存在**不报错**、静默当成功(只按 id 过滤)。返回删完的脱敏清单。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ models: CustomModelPublic[] }"
 },
 {
  "method": "customModel.getToken",
  "channel": "customModel:getToken",
  "doc": "Settings UI eye-icon only — returns cleartext token for display.",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ token: string | null }"
 },
 {
  "method": "customModel.list",
  "channel": "customModel:list",
  "doc": "列全部自定义模型配置(**脱敏**版,不含 token;取明文另走 `customModel.getToken`)。 `storeInvalid`:加密密钥表(`customModelKeys`)读出过损坏内容。为真时**清单会显得 比实际少**(读不出来的一律当没有),设置页据此显示\"密钥表损坏\",而不是让用户以为 自己的配置凭空消失了。同 `agentSsh.list` 的 `storeInvalid` 一个路子。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ models: CustomModelPublic[]; storeInvalid: boolean }"
 },
 {
  "method": "customModel.listEndpointModels",
  "channel": "customModel:listEndpointModels",
  "doc": "问端点「你有哪些模型」(`GET /v1/models` 或 `/models`)。与 Pi/Codex 的同名 RPC 共用 `lib/modelEndpoint.listEndpointModels` —— 三个引擎表单的「从端点拉取模型」 按钮走**同一条**通道。拉不到就抛人话,界面回退手输,绝不静默返回空表。",
  "input": "{ baseUrl: string; apiKey?: string | undefined; authMode?: 'bearer' | 'x-api-key' | undefined; headers?: Record<string, string> | undefined; anthropicVersion?: boolean | undefined }",
  "inputFull": "{ baseUrl: string; apiKey?: string | undefined; authMode?: 'bearer' | 'x-api-key' | undefined; headers?: Record<string, string> | undefined; anthropicVersion?: boolean | undefined }",
  "output": "{ models: string[] }"
 },
 {
  "method": "customModel.save",
  "channel": "customModel:save",
  "doc": "新建或更新一份自定义模型配置(传 `id` 且存在即更新,**token 缺省时保留旧的**)。失败时抛的话是**给人看的中文**——设置页把它原样贴在红字里。",
  "input": "{ id?: string | undefined // Omit on create; present on update to target an existing record.; name: string; baseUrl: string; authMode?: AuthMode | undefined; protocol?: Protocol | undefined // Wire protocol.; webSiteId?: string | undefined // 仅 `protocol: \"web\"` 需要：驱动哪个网页版站点（站点适配器 id）。; authToken?: string | undefined // Cleartext.; models: CustomModelEntry[] // The flat model list (≥1 entry, enforced by the IPC schema).; subagentModel?: string | undefined // Task-subagent model to pin for this config.; disableNonEssentialTraffic?: boolean | undefined; timeoutMs?: number | undefined; customHeaders?: CustomHeaders | undefined // Extra request headers for the endpoint; an empty map clears them. }",
  "inputFull": "{ id?: string | undefined // Omit on create; present on update to target an existing record.; name: string; baseUrl: string; authMode?: AuthMode | undefined; protocol?: Protocol | undefined // Wire protocol.; webSiteId?: string | undefined // 仅 `protocol: \"web\"` 需要：驱动哪个网页版站点（站点适配器 id）。; authToken?: string | undefined // Cleartext.; models: CustomModelEntry[] // The flat model list (≥1 entry, enforced by the IPC schema).; subagentModel?: string | undefined // Task-subagent model to pin for this config.; disableNonEssentialTraffic?: boolean | undefined; timeoutMs?: number | undefined; customHeaders?: CustomHeaders | undefined // Extra request headers for the endpoint; an empty map clears them. }",
  "output": "{ models: CustomModelPublic[] }"
 },
 {
  "method": "customModel.test",
  "channel": "customModel:test",
  "doc": "连通性测试**单条**模型:走的是真实那一整条链路(binary + env builder),不是捷径 fetch —— \"测得过 = 保存后一定能用\"。",
  "input": "{ model: string // The single model id to probe in this request.; baseUrl: string; authToken: string; timeoutMs?: number | undefined; authMode?: 'auth_token' | 'api_key' | undefined; protocol?: 'anthropic' | 'openai' | 'web' | undefined; supports1m?: boolean | undefined // Whether to declare 1M context (adds the `[1m]` suffix) — mirrors the model row's toggle.; disableNonEssentialTraffic?: boolean | undefined; customHeaders?: Record<string, string> | undefined // Headers to probe with, so an endpoint that requires one (and would otherwise fail the tes… }",
  "inputFull": "{ model: string // The single model id to probe in this request.; baseUrl: string; authToken: string; timeoutMs?: number | undefined; authMode?: 'auth_token' | 'api_key' | undefined; protocol?: 'anthropic' | 'openai' | 'web' | undefined; supports1m?: boolean | undefined // Whether to declare 1M context (adds the `[1m]` suffix) — mirrors the model row's toggle.; disableNonEssentialTraffic?: boolean | undefined; customHeaders?: Record<string, string> | undefined // Headers to probe with, so an endpoint that requires one (and would otherwise fail the tes… }",
  "output": "{ ok: boolean; detail?: string | undefined // claude's version string or model echo, when available.; error?: string | undefined // Error message on failure (auth / network / timeout / bad model). }"
 },
 {
  "method": "customUi.panelApiCall",
  "channel": "customUi:panelApiCall",
  "doc": "自定义面板的 `mcode.api.call(method, input)`:调**任意** Mcode 主进程方法, 复用 agent `app_api_call` 的同一套权限分类(写要确认、高风险每次确认、密钥类拒绝)。 桌面专属(手机白名单不列即不暴露)。",
  "input": "{ method: string // 方法名,如 `library.saveNote` / `session.list`(点号形式,同 `app_api_call`)。; approved?: boolean | undefined // 用户在确认框上点了头之后由**渲染端的桥**补上(面板自己发不出这个位 —— 它只能经 `handlePanelCall`,而那一层是我们写的)。只对 write/danger …; input?: unknown // 该方法的入参;无参方法省略。; panelLabel?: string | undefined // 面板的显示名 —— 只用于确认框正文(哪个面板要调什么),不参与任何判据。; operationId?: string | undefined // 【MC-014】可选的幂等键 —— 与 Agent 的 `operation_id`、桌面 IPC 的 `__operationId`、手机 RPC 的 `operationId… }",
  "inputFull": "{ method: string // 方法名,如 `library.saveNote` / `session.list`(点号形式,同 `app_api_call`)。; approved?: boolean | undefined // 用户在确认框上点了头之后由**渲染端的桥**补上(面板自己发不出这个位 —— 它只能经 `handlePanelCall`,而那一层是我们写的)。只对 write/danger …; input?: unknown // 该方法的入参;无参方法省略。; panelLabel?: string | undefined // 面板的显示名 —— 只用于确认框正文(哪个面板要调什么),不参与任何判据。; operationId?: string | undefined // 【MC-014】可选的幂等键 —— 与 Agent 的 `operation_id`、桌面 IPC 的 `__operationId`、手机 RPC 的 `operationId… }",
  "output": "{ ok: boolean; result?: unknown // 成功时的返回值(已打码)。; error?: string | undefined; needsApproval?: boolean | undefined // 需要用户确认:渲染端的桥据它弹确认框,点头后带 `approved: true` 重调。; level?: 'write' | 'danger' | undefined // 需要的档位(write = 一次确认;danger = 每次确认、不记「总是允许」)。; descripti…"
 },
 {
  "method": "customUi.panelAsk",
  "channel": "customUi:panelAsk",
  "doc": "自定义面板的 `mcode.ask()`:一次性问模型(不带工具),返回纯文本。",
  "input": "{ prompt: string; model?: string | undefined; system?: string | undefined }",
  "inputFull": "{ prompt: string; model?: string | undefined; system?: string | undefined }",
  "output": "{ ok: boolean; text?: string | undefined; error?: string | undefined }"
 },
 {
  "method": "customUi.runAutomation",
  "channel": "customUi:runAutomation",
  "doc": "自定义项的「运行自动化」动作:用指定触发器**手动**起一次,右键的目标当载荷带进去 (条目 / 分类 / 大类 → 条目清单,文件 → 文件列表)。`dryRun` 只数条数不真跑。 桌面专属(手机白名单不列即不暴露)。",
  "input": "{ workflowId: string; triggerNodeId: string; target: { kind: 'item'; itemId: string; } | { kind: 'collection'; collectionId: string; } | { kind: 'group'; groupId: string; } | { path: string; kind: 'file'; }; skipWhen?: { extensions?: string[] | undefined; requires?: 'file' | 'pdf' | 'markdown' | undefined; groupIds?: string[] | undefined; } | undefined // 展开时的条目跳过条件(见 automation 动作的 skipWhen;主进程逐条目复核)。; targetMode?: 'scope' | 'context' | undefined // 目标怎么用(见 automation 动作的 targetMode)。缺省 = `scope`,与老行为一致。; input?: Record<string, string | string[]> | undefined // 运行前输入的值(键 = `inputs[].key`;files 是绝对路径数组)。; dryRun?: boolean | undefined // 只数一下这次会带多少条,不真跑 —— 批量跑之前给用户确认用。; expectCount?: number | undefined // 用户在确认框上**看到并点头的那个条数**(只有走过 `dryRun` 的批量那条路会带)。 }",
  "inputFull": "{ workflowId: string; triggerNodeId: string; target: { kind: 'item'; itemId: string; } | { kind: 'collection'; collectionId: string; } | { kind: 'group'; groupId: string; } | { path: string; kind: 'file'; }; skipWhen?: { extensions?: string[] | undefined; requires?: 'file' | 'pdf' | 'markdown' | undefined; groupIds?: string[] | undefined; } | undefined // 展开时的条目跳过条件(见 automation 动作的 skipWhen;主进程逐条目复核)。; targetMode?: 'scope' | 'context' | undefined // 目标怎么用(见 automation 动作的 targetMode)。缺省 = `scope`,与老行为一致。; input?: Record<string, string | string[]> | undefined // 运行前输入的值(键 = `inputs[].key`;files 是绝对路径数组)。; dryRun?: boolean | undefined // 只数一下这次会带多少条,不真跑 —— 批量跑之前给用户确认用。; expectCount?: number | undefined // 用户在确认框上**看到并点头的那个条数**(只有走过 `dryRun` 的批量那条路会带)。 }",
  "output": "{ ok: boolean; error?: string | undefined; count?: number | undefined; skipped?: number | undefined }"
 },
 {
  "method": "customUi.stagePanel",
  "channel": "customUi:stagePanel",
  "doc": "自定义面板(R41):把包好的面板文档交给主进程,换一个 `mcode-panel://` 地址给 iframe 用。",
  "input": "{ html: string; network?: boolean | undefined }",
  "inputFull": "{ html: string; network?: boolean | undefined }",
  "output": "{ url: string }"
 },
 {
  "method": "dialog.pickFiles",
  "channel": "dialog:pickFiles",
  "doc": "Native multi-file picker (project-external files allowed). Returns the selected absolute paths; empty array when the user cancels.",
  "input": "{ title?: string | undefined // Optional dialog title; defaults to a localized \"选择文件\" on the main side.; filters?: { extensions: string[]; name: string; }[] | undefined // 原生选择框的扩展名过滤,如 `[{ name: \"PDF\", extensions: [\"pdf\"] }]`。 }",
  "inputFull": "{ title?: string | undefined // Optional dialog title; defaults to a localized \"选择文件\" on the main side.; filters?: { extensions: string[]; name: string; }[] | undefined // 原生选择框的扩展名过滤,如 `[{ name: \"PDF\", extensions: [\"pdf\"] }]`。 }",
  "output": "{ paths: string[] }"
 },
 {
  "method": "dialog.pickFolder",
  "channel": "dialog:pickFolder",
  "doc": "原生单目录选择器(新建项目用)。桌面专有:手机端的 `webApi` 不提供。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ path: string | null }"
 },
 {
  "method": "document.capabilities",
  "channel": "document:capabilities",
  "doc": "【ARC-007】报告本机文档能力(CLI 在不在、哪些路由需要 headless 宿主/原生 sidecar)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ cli: { available: boolean; path: string | null; } // CLI bundle 是否可用。; local: string[] // 不需要额外宿主即可运行的路由。; needsApp: string[] // 需要 headless Electron（`GENOFFICE_APP_BIN`）的路由。; needsSidecar: string[] // 需要原生 sidecar（Rust xlsx）/ wasm 的路由。; note: string // 说明（…"
 },
 {
  "method": "document.convert",
  "channel": "document:convert",
  "doc": "【ARC-007】格式转换(输出路径同样过围栏)。",
  "input": "{ to: string; inputPath: string; outputPath: string // 输出路径；必须同样落在已知工作区内。; force?: boolean | undefined }",
  "inputFull": "{ to: string; inputPath: string; outputPath: string // 输出路径；必须同样落在已知工作区内。; force?: boolean | undefined }",
  "output": "{ ok: true; command: string; summary: string | null; detail: unknown; revision?: string | null | undefined } | { ok: false; kind: 'failed' | 'unavailable' | 'refused' | 'conflict'; reason: string; code?: string | number | undefined; currentRevision?: string |…"
 },
 {
  "method": "document.edit",
  "channel": "document:edit",
  "doc": "【ARC-007】按 GenOffice ops 编辑并保存。`dryRun` 只演练。路径同样过工作区围栏。",
  "input": "{ filePath: string; ops: unknown[] // GenOffice 的 ops 数组（形状由 CLI 校验）。; expectedRevision?: string | undefined // 【ARC-007】**原值版本检查** —— 与 `file.writeFile` 的 `expectedVersion` 同一算法 （原始字节的 sha256，见 `fileC…; dryRun?: boolean | undefined // 只演练不写盘。; track?: boolean | undefined // docx：把内容编辑记成修订。 }",
  "inputFull": "{ filePath: string; ops: unknown[] // GenOffice 的 ops 数组（形状由 CLI 校验）。; expectedRevision?: string | undefined // 【ARC-007】**原值版本检查** —— 与 `file.writeFile` 的 `expectedVersion` 同一算法 （原始字节的 sha256，见 `fileC…; dryRun?: boolean | undefined // 只演练不写盘。; track?: boolean | undefined // docx：把内容编辑记成修订。 }",
  "output": "{ ok: true; command: string; summary: string | null; detail: unknown; revision?: string | null | undefined } | { ok: false; kind: 'failed' | 'unavailable' | 'refused' | 'conflict'; reason: string; code?: string | number | undefined; currentRevision?: string |…"
 },
 {
  "method": "document.read",
  "channel": "document:read",
  "doc": "【ARC-007】读文档结构(docx 块 / pptx 页 / xlsx 表)。**只读**,路径必须落在已知工作区内。",
  "input": "{ filePath: string // 绝对路径；必须落在某个已知工作区根内（主进程复核，不采信调用方）。; full?: boolean | undefined // 仅 docx 有效：返回全文而非预览。; range?: string | undefined // 仅 docx 有效：块索引范围（CLI 语法 `a-b`）。 }",
  "inputFull": "{ filePath: string // 绝对路径；必须落在某个已知工作区根内（主进程复核，不采信调用方）。; full?: boolean | undefined // 仅 docx 有效：返回全文而非预览。; range?: string | undefined // 仅 docx 有效：块索引范围（CLI 语法 `a-b`）。 }",
  "output": "{ ok: true; command: string; summary: string | null; detail: unknown; revision?: string | null | undefined } | { ok: false; kind: 'failed' | 'unavailable' | 'refused' | 'conflict'; reason: string; code?: string | number | undefined; currentRevision?: string |…"
 },
 {
  "method": "documentView.bounds",
  "channel": "documentView:bounds",
  "doc": "【ARC-007】只改文档视图几何(窗口像素矩形)。视图隐藏时记住新几何,show 时恢复。",
  "input": "{ docId: string; bounds: { x: number; y: number; width: number; height: number; } }",
  "inputFull": "{ docId: string; bounds: { x: number; y: number; width: number; height: number; } }",
  "output": "{ ok: true } | { ok: false; reason: string }"
 },
 {
  "method": "documentView.close",
  "channel": "documentView:close",
  "doc": "【ARC-007】销毁文档视图。不存在时幂等成功。",
  "input": "{ docId: string }",
  "inputFull": "{ docId: string }",
  "output": "{ ok: true } | { ok: false; reason: string }"
 },
 {
  "method": "documentView.focus",
  "channel": "documentView:focus",
  "doc": "【ARC-007】把键盘焦点交给文档视图的页面。",
  "input": "{ docId: string }",
  "inputFull": "{ docId: string }",
  "output": "{ ok: true } | { ok: false; reason: string }"
 },
 {
  "method": "documentView.hide",
  "channel": "documentView:hide",
  "doc": "【ARC-007】隐藏文档视图(移出屏幕、**不销毁** —— 切标签保住编辑状态)。",
  "input": "{ docId: string }",
  "inputFull": "{ docId: string }",
  "output": "{ ok: true } | { ok: false; reason: string }"
 },
 {
  "method": "documentView.list",
  "channel": "documentView:list",
  "doc": "【ARC-007】文档视图状态快照(诊断用,只读;不含 webContents 句柄)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ views: DocViewSnapshot[] }"
 },
 {
  "method": "documentView.open",
  "channel": "documentView:open",
  "doc": "【ARC-007】受控文档视图宿主的打开/复用:一个 docId 一个 WebContentsView。URL 只放行 `file://` 与本机回环(主进程复核,fail-closed);同 docId 重复 open 复用视图并更新 url/bounds。",
  "input": "{ url: string // `file://`（GenOffice 快照的编辑器页）或本机回环 http(s)；主进程复核，见文件头。; docId: string; bounds: { x: number; y: number; width: number; height: number; }; visible: boolean; workflowEngineId?: string | undefined // 工作流引擎 id（`[a-z][a-z0-9-]*`，与 `workflowEngine.*` 同一套形状）。 }",
  "inputFull": "{ url: string // `file://`（GenOffice 快照的编辑器页）或本机回环 http(s)；主进程复核，见文件头。; docId: string; bounds: { x: number; y: number; width: number; height: number; }; visible: boolean; workflowEngineId?: string | undefined // 工作流引擎 id（`[a-z][a-z0-9-]*`，与 `workflowEngine.*` 同一套形状）。 }",
  "output": "{ ok: true } | { ok: false; reason: string }"
 },
 {
  "method": "documentView.openPath",
  "channel": "documentView:openPath",
  "doc": "【ARC-007】把某个文档载入已打开的视图（路径围栏在主进程）。",
  "input": "{ filePath: string; docId: string }",
  "inputFull": "{ filePath: string; docId: string }",
  "output": "{ ok: true } | { ok: false; reason: string }"
 },
 {
  "method": "documentView.show",
  "channel": "documentView:show",
  "doc": "【ARC-007】显示文档视图:重新挂到窗口并恢复最后几何。已可见时幂等。",
  "input": "{ docId: string }",
  "inputFull": "{ docId: string }",
  "output": "{ ok: true } | { ok: false; reason: string }"
 },
 {
  "method": "engineTools.get",
  "channel": "engineTools:get",
  "doc": "Per-engine **built-in tool** exclusion policy (设置 → 引擎工具). Returns the stored policy plus, per engine, whether that engine can actually drop a named built-in tool (Codex cannot — only sandbox/approval levels).",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ engines: Record<'claude' | 'codex' | 'pi', EngineToolEngineState>; status?: EngineToolsPolicyStatus | undefined // 【MC-071】策略文件读取状态;UI 据此显示「配置损坏」而非静默假装用户主动启用。; recovered?: boolean | undefined // 损坏时是否已从「最后一份确认过的策略」保守恢复。; warning?: string | undefined // 损坏原因…"
 },
 {
  "method": "engineTools.set",
  "channel": "engineTools:set",
  "doc": "Replace the exclusion list for one engine. Claude → `disallowedTools`, Pi → `excludeTools`; Codex accepts the write but reports `supported:false`. Takes effect on the next turn.",
  "input": "{ exclude: string[] // 工具名列表；空数组 = 该引擎不设限。非法名（非字符串/字符集不合法）**显式拒绝** 整个保存（MC-042：静默剔除会让用户以为禁用了、实际没有）。; engine: 'claude' | 'codex' | 'pi'; guidance?: string | undefined // 【MC-043】该引擎的工具使用说明（可选）。省略 = 不改变已存的说明；空串 = 清除。 }",
  "inputFull": "{ exclude: string[] // 工具名列表；空数组 = 该引擎不设限。非法名（非字符串/字符集不合法）**显式拒绝** 整个保存（MC-042：静默剔除会让用户以为禁用了、实际没有）。; engine: 'claude' | 'codex' | 'pi'; guidance?: string | undefined // 【MC-043】该引擎的工具使用说明（可选）。省略 = 不改变已存的说明；空串 = 清除。 }",
  "output": "{ ok: boolean; error?: string | undefined; snapshot?: EngineToolsSnapshot | undefined }"
 },
 {
  "method": "extensionStore.get",
  "channel": "extensionStore:get",
  "doc": "读一条扩展自己的键值。没有返回 `null`(同面板 `mcode.storage.get`)。",
  "input": "{ key: string; extensionId: string }",
  "inputFull": "{ key: string; extensionId: string }",
  "output": "{ value: unknown }"
 },
 {
  "method": "extensionStore.listFiles",
  "channel": "extensionStore:listFiles",
  "doc": "列该扩展自己目录下某个子目录的内容(不递归)。只读档。",
  "input": "{ extensionId: string; relPath?: string | undefined // 要列的相对目录;省略 / 空串 = 该扩展目录根。 }",
  "inputFull": "{ extensionId: string; relPath?: string | undefined // 要列的相对目录;省略 / 空串 = 该扩展目录根。 }",
  "output": "{ ok: true; entries: ExtensionStoreListEntry[] } | { ok: false; reason: ExtensionFileErrorReason }"
 },
 {
  "method": "extensionStore.readFile",
  "channel": "extensionStore:readFile",
  "doc": "读该扩展自己目录下的一份文件(报告附录 P)。空文件与\"不存在\"分得开(`ok:true,\"\"` vs `ok:false,\"notFound\"`)。只读档。",
  "input": "{ extensionId: string; relPath: string }",
  "inputFull": "{ extensionId: string; relPath: string }",
  "output": "{ ok: true; content: string } | { ok: false; reason: ExtensionFileErrorReason }"
 },
 {
  "method": "extensionStore.remove",
  "channel": "extensionStore:remove",
  "doc": "删一条。",
  "input": "{ key: string; extensionId: string }",
  "inputFull": "{ key: string; extensionId: string }",
  "output": "{ ok: true }"
 },
 {
  "method": "extensionStore.set",
  "channel": "extensionStore:set",
  "doc": "写一条。超配额回 `{ ok: false, reason: \"tooLarge\" }`。**写档**(经 `policyFor` 兜底)。",
  "input": "{ key: string; extensionId: string; value?: unknown }",
  "inputFull": "{ key: string; extensionId: string; value?: unknown }",
  "output": "{ ok: true } | { ok: false; reason: 'tooLarge'; limit: number }"
 },
 {
  "method": "extensionStore.writeFile",
  "channel": "extensionStore:writeFile",
  "doc": "写该扩展自己目录下的一份文件(建父目录)。超 4MB 整次拒绝。**写档**(经 `policyFor` 兜底)。",
  "input": "{ extensionId: string; relPath: string; content: string }",
  "inputFull": "{ extensionId: string; relPath: string; content: string }",
  "output": "{ ok: true; bytes: number } | { ok: false; reason: ExtensionFileErrorReason; limit?: number | undefined }"
 },
 {
  "method": "file.copy",
  "channel": "file:copy",
  "doc": "复制一个**普通文件**到一个目录(两端都要在已知项目根内;目录不在此列)。**从不覆盖**:名字被占就派生\"名 副本.ext\"\"名 副本 2.ext\"…(suffix 由渲染端给,已剥目录分量防越界)。",
  "input": "{ srcPath: string // Absolute path of the file to copy.; destDir: string // Absolute path of the directory to copy into.; suffix?: string | undefined // Locale word used when deriving a clash-free name (\"副本\" / \"copy\"). }",
  "inputFull": "{ srcPath: string // Absolute path of the file to copy.; destDir: string // Absolute path of the directory to copy into.; suffix?: string | undefined // Locale word used when deriving a clash-free name (\"副本\" / \"copy\"). }",
  "output": "{ ok: boolean }"
 },
 {
  "method": "file.delete",
  "channel": "file:delete",
  "doc": "Delete a file or directory (moves to system trash), scoped to a project root.",
  "input": "{ targetPath: string // Absolute path of the file or directory to trash. }",
  "inputFull": "{ targetPath: string // Absolute path of the file or directory to trash. }",
  "output": "{ ok: boolean }"
 },
 {
  "method": "file.grep",
  "channel": "file:grep",
  "doc": "Grep file contents under a project root (line-level matches).",
  "input": "{ projectPath: string // Absolute path of the project root.; query: string // Substring to search for inside file contents.; limit?: number | undefined // Max total matches to return.; includeExts?: string[] | undefined // Optional file-extension allow-list (no dots, lowercased).; maxResultsPerFile?: number | undefined // Max matches per single file.; caseSensitive?: boolean | undefined // Case-sensitive match. }",
  "inputFull": "{ projectPath: string // Absolute path of the project root.; query: string // Substring to search for inside file contents.; limit?: number | undefined // Max total matches to return.; includeExts?: string[] | undefined // Optional file-extension allow-list (no dots, lowercased).; maxResultsPerFile?: number | undefined // Max matches per single file.; caseSensitive?: boolean | undefined // Case-sensitive match. }",
  "output": "{ matches: FileGrepEntry[]; truncated: boolean // The match cap was reached — more matches likely exist.; incompleteScan: boolean // The tree walk hit its visit/depth budget before finishing. }"
 },
 {
  "method": "file.listDir",
  "channel": "file:listDir",
  "doc": "List one level of a directory (non-recursive), scoped to a project root.",
  "input": "{ projectPath: string // Absolute path of the project root the listing is scoped to.; dirPath: string // Directory to list, relative to projectPath. }",
  "inputFull": "{ projectPath: string // Absolute path of the project root the listing is scoped to.; dirPath: string // Directory to list, relative to projectPath. }",
  "output": "{ entries: FileTreeEntry[] }"
 },
 {
  "method": "file.mkdir",
  "channel": "file:mkdir",
  "doc": "Create a directory (recursive), scoped to a project root.",
  "input": "{ dirPath: string // Absolute path of the directory to create. }",
  "inputFull": "{ dirPath: string // Absolute path of the directory to create. }",
  "output": "{ ok: boolean }"
 },
 {
  "method": "file.pickImages",
  "channel": "file:pickImages",
  "doc": "OS dialog image picker → base64 images (composer 图片 button).",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ images: PickedImage[]; skipped: string[] }"
 },
 {
  "method": "file.readBinary",
  "channel": "file:readBinary",
  "doc": "Read a binary file as a base64 data URL (image preview). Same path guard.",
  "input": "{ filePath: string // Absolute path. }",
  "inputFull": "{ filePath: string // Absolute path. }",
  "output": "{ dataUrl: string }"
 },
 {
  "method": "file.readFile",
  "channel": "file:readFile",
  "doc": "【MC-097】回传 `version`(内容 sha256)—— 渲染端保存时带 `writeFile.expectedVersion` 做 CAS。",
  "input": "{ filePath: string // Absolute or cwd-relative path. }",
  "inputFull": "{ filePath: string // Absolute or cwd-relative path. }",
  "output": "{ content: string; version?: string | null | undefined }"
 },
 {
  "method": "file.rename",
  "channel": "file:rename",
  "doc": "Rename a file or directory in place, scoped to a project root.",
  "input": "{ oldPath: string // Absolute path of the entry to rename.; newPath: string // Absolute path of the new name. }",
  "inputFull": "{ oldPath: string // Absolute path of the entry to rename.; newPath: string // Absolute path of the new name. }",
  "output": "{ ok: boolean }"
 },
 {
  "method": "file.search",
  "channel": "file:search",
  "doc": "Recursive file search under a project root (composer @ / add-context).",
  "input": "{ projectPath: string // Absolute path of the project root.; query?: string | undefined // Optional case-insensitive filter over file name / relative path.; limit?: number | undefined // Max files to return.; includeExts?: string[] | undefined // Optional file-extension allow-list (no dots, lowercased). }",
  "inputFull": "{ projectPath: string // Absolute path of the project root.; query?: string | undefined // Optional case-insensitive filter over file name / relative path.; limit?: number | undefined // Max files to return.; includeExts?: string[] | undefined // Optional file-extension allow-list (no dots, lowercased). }",
  "output": "{ files: FileSearchEntry[]; truncated: boolean // More matches existed than the returned slice.; incompleteScan: boolean // The tree walk hit its visit/depth budget before finishing. }"
 },
 {
  "method": "file.writeFile",
  "channel": "file:writeFile",
  "doc": "【MC-097】`conflict:true` = 带 `expectedVersion` 的 CAS 冲突(磁盘已被改动,未写)。 【MC-024】冲突时本次 `content` **不丢**:另存为同目录 `<name>.conflict-<ISO 时间戳><ext>` 并把落盘路径回在 `conflictPath`(副本写入失败时缺省 —— 此时回包仍是冲突,只是没有副本)。",
  "input": "{ content: string; filePath: string // Absolute or cwd-relative path.; expectedVersion?: string | undefined // 【MC-097】可选**乐观并发条件**:调用方读到的那一版内容的哈希(见 `file:readFile` 回传的 `version`)。给了它,主进程在**最终提交点**重读当… }",
  "inputFull": "{ content: string; filePath: string // Absolute or cwd-relative path.; expectedVersion?: string | undefined // 【MC-097】可选**乐观并发条件**:调用方读到的那一版内容的哈希(见 `file:readFile` 回传的 `version`)。给了它,主进程在**最终提交点**重读当… }",
  "output": "{ ok: boolean; conflict?: boolean | undefined; conflictPath?: string | undefined }"
 },
 {
  "method": "git.cancelGenerateCommitMessage",
  "channel": "git:cancelGenerateCommitMessage",
  "doc": "中断一次正在跑的提交信息生成(按 `requestId` 找到那条 SDK 查询并 abort)。幂等 —— 没在跑的 id 也回 `ok:true`。",
  "input": "{ requestId: string }",
  "inputFull": "{ requestId: string }",
  "output": "{ ok: boolean }"
 },
 {
  "method": "git.checkout",
  "channel": "git:checkout",
  "doc": "Check out a branch / tag / ref. With `newBranch`, creates a new local branch from the target and checks it out (tracking branch or new branch).",
  "input": "{ branch: string; repoPath: string; newBranch?: string | undefined // When provided, create this new local branch from `branch` and check it out. }",
  "inputFull": "{ branch: string; repoPath: string; newBranch?: string | undefined // When provided, create this new local branch from `branch` and check it out. }",
  "output": "{ ok: boolean; error?: string | undefined // Error message when ok is false.; conflict?: boolean | undefined // Set by `git:pull` when the pull produced a merge conflict.; conflictedFiles?: string[] | undefined }"
 },
 {
  "method": "git.commit",
  "channel": "git:commit",
  "doc": "Commit staged changes with a message.",
  "input": "{ message: string; repoPath: string }",
  "inputFull": "{ message: string; repoPath: string }",
  "output": "{ ok: boolean; error?: string | undefined // Error message when ok is false.; conflict?: boolean | undefined // Set by `git:pull` when the pull produced a merge conflict.; conflictedFiles?: string[] | undefined }"
 },
 {
  "method": "git.deleteBranch",
  "channel": "git:deleteBranch",
  "doc": "Delete a local branch (`git branch -d`; `-D` with `force`).",
  "input": "{ branch: string; repoPath: string; force?: boolean | undefined // Force delete (`git branch -D`) — skips the fully-merged safety check. }",
  "inputFull": "{ branch: string; repoPath: string; force?: boolean | undefined // Force delete (`git branch -D`) — skips the fully-merged safety check. }",
  "output": "{ ok: boolean; error?: string | undefined // Error message when ok is false.; conflict?: boolean | undefined // Set by `git:pull` when the pull produced a merge conflict.; conflictedFiles?: string[] | undefined }"
 },
 {
  "method": "git.diff",
  "channel": "git:diff",
  "doc": "Get the unstaged diff patch for a single file.",
  "input": "{ filePath: string; repoPath: string; staged?: boolean | undefined // If true, show staged (cached) diff — index vs HEAD. }",
  "inputFull": "{ filePath: string; repoPath: string; staged?: boolean | undefined // If true, show staged (cached) diff — index vs HEAD. }",
  "output": "{ patch: string }"
 },
 {
  "method": "git.discard",
  "channel": "git:discard",
  "doc": "Discard local changes to specific files (checkout tracked / clean untracked).",
  "input": "{ repoPath: string; filePaths: string[] }",
  "inputFull": "{ repoPath: string; filePaths: string[] }",
  "output": "{ ok: boolean; error?: string | undefined // Error message when ok is false.; conflict?: boolean | undefined // Set by `git:pull` when the pull produced a merge conflict.; conflictedFiles?: string[] | undefined }"
 },
 {
  "method": "git.discoverRepos",
  "channel": "git:discoverRepos",
  "doc": "Discover all git repos under a project root (recursive, max depth 3).",
  "input": "{ projectPath: string; rootOnly?: boolean | undefined }",
  "inputFull": "{ projectPath: string; rootOnly?: boolean | undefined }",
  "output": "{ repos: GitRepo[] }"
 },
 {
  "method": "git.fileBlob",
  "channel": "git:fileBlob",
  "doc": "Full old-side blob for the Git panel's diff view (`git show rev:path`).",
  "input": "{ side: 'index' | 'HEAD'; filePath: string; repoPath: string }",
  "inputFull": "{ side: 'index' | 'HEAD'; filePath: string; repoPath: string }",
  "output": "{ content: string }"
 },
 {
  "method": "git.generateCommitMessage",
  "channel": "git:generateCommitMessage",
  "doc": "Generate a commit message from the staged diff via an LLM one-shot call.",
  "input": "{ customModelId: string | null // Custom-model config id (from CustomModelStore).; prompt: string // The user's prompt template.; repoPath: string; customModelRole: string | null // Which role binding within the config to use (e.g.; requestId?: string | undefined // Optional cancellation key: when present, the AbortController driving the SDK query is reg…; scope?: 'worktree' | 'staged' | undefined // Which diff feeds the generation: \"staged\" (default — index vs HEAD, the commit-box flow) … }",
  "inputFull": "{ customModelId: string | null // Custom-model config id (from CustomModelStore).; prompt: string // The user's prompt template.; repoPath: string; customModelRole: string | null // Which role binding within the config to use (e.g.; requestId?: string | undefined // Optional cancellation key: when present, the AbortController driving the SDK query is reg…; scope?: 'worktree' | 'staged' | undefined // Which diff feeds the generation: \"staged\" (default — index vs HEAD, the commit-box flow) … }",
  "output": "{ ok: boolean; message?: string | undefined; error?: string | undefined }"
 },
 {
  "method": "git.listBranches",
  "channel": "git:listBranches",
  "doc": "List local branches, remote branches and tags for a repo (grouped).",
  "input": "{ repoPath: string }",
  "inputFull": "{ repoPath: string }",
  "output": "{ branches: GitBranchListResult }"
 },
 {
  "method": "git.log",
  "channel": "git:log",
  "doc": "Paginated commit log for a repo (newest first).",
  "input": "{ repoPath: string; limit?: number | undefined // Max commits to return (default 50, max 200).; skip?: number | undefined // Number of commits to skip (for pagination).; ref?: string | undefined // Optional ref to start from (branch/tag/hash). }",
  "inputFull": "{ repoPath: string; limit?: number | undefined // Max commits to return (default 50, max 200).; skip?: number | undefined // Number of commits to skip (for pagination).; ref?: string | undefined // Optional ref to start from (branch/tag/hash). }",
  "output": "{ commits: GitCommitInfo[]; hasMore: boolean }"
 },
 {
  "method": "git.merge",
  "channel": "git:merge",
  "doc": "Merge `source` into the current branch. Conflicts are reported via `conflict` + `conflictedFiles` (same shape as git.pull).",
  "input": "{ source: string; repoPath: string }",
  "inputFull": "{ source: string; repoPath: string }",
  "output": "{ ok: boolean; error?: string | undefined; conflict?: boolean | undefined // Set when the merge stopped with conflicts.; conflictedFiles?: string[] | undefined; upToDate?: boolean | undefined // True when HEAD already contained everything (no merge was execut…"
 },
 {
  "method": "git.mergeAbort",
  "channel": "git:mergeAbort",
  "doc": "Abort an in-progress merge (`git merge --abort`). Fails when the repo is not in a merging state.",
  "input": "{ repoPath: string }",
  "inputFull": "{ repoPath: string }",
  "output": "{ ok: boolean; error?: string | undefined // Error message when ok is false.; conflict?: boolean | undefined // Set by `git:pull` when the pull produced a merge conflict.; conflictedFiles?: string[] | undefined }"
 },
 {
  "method": "git.mergePreview",
  "channel": "git:mergePreview",
  "doc": "Preview a merge of `source` into the current branch without touching the working tree (incoming commit count / fast-forward / up-to-date).",
  "input": "{ source: string; repoPath: string }",
  "inputFull": "{ source: string; repoPath: string }",
  "output": "{ ok: boolean; error?: string | undefined; upToDate: boolean // True when HEAD already contains every commit of `source` — nothing to do.; fastForward: boolean // True when the merge can fast-forward (HEAD has no commits `source` lacks).; incomingCommits: num…"
 },
 {
  "method": "git.pull",
  "channel": "git:pull",
  "doc": "Pull remote changes into the current branch.",
  "input": "{ repoPath: string }",
  "inputFull": "{ repoPath: string }",
  "output": "{ ok: boolean; error?: string | undefined // Error message when ok is false.; conflict?: boolean | undefined // Set by `git:pull` when the pull produced a merge conflict.; conflictedFiles?: string[] | undefined }"
 },
 {
  "method": "git.push",
  "channel": "git:push",
  "doc": "Push local commits to the upstream remote.",
  "input": "{ repoPath: string }",
  "inputFull": "{ repoPath: string }",
  "output": "{ ok: boolean; error?: string | undefined // Error message when ok is false.; conflict?: boolean | undefined // Set by `git:pull` when the pull produced a merge conflict.; conflictedFiles?: string[] | undefined }"
 },
 {
  "method": "git.showCommit",
  "channel": "git:showCommit",
  "doc": "Meta + changed files for one commit.",
  "input": "{ repoPath: string; commitHash: string }",
  "inputFull": "{ repoPath: string; commitHash: string }",
  "output": "null | { commit: GitCommitInfo; files: GitCommitFile[] }"
 },
 {
  "method": "git.showFile",
  "channel": "git:showFile",
  "doc": "Parent-vs-commit file contents for a single path (Monaco diff).",
  "input": "{ filePath: string // Path relative to the repo root (new path for renames).; repoPath: string; commitHash: string; oldPath?: string | undefined // Previous path when the file was renamed/copied in this commit. }",
  "inputFull": "{ filePath: string // Path relative to the repo root (new path for renames).; repoPath: string; commitHash: string; oldPath?: string | undefined // Previous path when the file was renamed/copied in this commit. }",
  "output": "{ before: string; after: string }"
 },
 {
  "method": "git.stage",
  "channel": "git:stage",
  "doc": "Stage (git add) specific files.",
  "input": "{ repoPath: string; filePaths: string[] }",
  "inputFull": "{ repoPath: string; filePaths: string[] }",
  "output": "{ ok: boolean; error?: string | undefined // Error message when ok is false.; conflict?: boolean | undefined // Set by `git:pull` when the pull produced a merge conflict.; conflictedFiles?: string[] | undefined }"
 },
 {
  "method": "git.status",
  "channel": "git:status",
  "doc": "Get the status of a single repo (branch / ahead / behind / files).",
  "input": "{ repoPath: string }",
  "inputFull": "{ repoPath: string }",
  "output": "{ status: GitStatusResult }"
 },
 {
  "method": "git.unstage",
  "channel": "git:unstage",
  "doc": "Unstage (git reset) specific files.",
  "input": "{ repoPath: string; filePaths: string[] }",
  "inputFull": "{ repoPath: string; filePaths: string[] }",
  "output": "{ ok: boolean; error?: string | undefined // Error message when ok is false.; conflict?: boolean | undefined // Set by `git:pull` when the pull produced a merge conflict.; conflictedFiles?: string[] | undefined }"
 },
 {
  "method": "git.worktreeList",
  "channel": "git:worktreeList",
  "doc": "List the repo's worktrees (linked + main) with lifecycle state.",
  "input": "{ repoPath: string // The repo to list worktrees of. }",
  "inputFull": "{ repoPath: string // The repo to list worktrees of. }",
  "output": "{ worktrees: GitWorktreeInfo[] }"
 },
 {
  "method": "git.worktreeMergeBack",
  "channel": "git:worktreeMergeBack",
  "doc": "Merge a worktree's HEAD back into the local current branch.",
  "input": "{ worktreePath: string; repoPath: string; message?: string | undefined // Commit message for the pre-merge auto-commit of uncommitted worktree changes. }",
  "inputFull": "{ worktreePath: string; repoPath: string; message?: string | undefined // Commit message for the pre-merge auto-commit of uncommitted worktree changes. }",
  "output": "{ ok: boolean; error?: string | undefined; committedChanges?: boolean | undefined // True when the worktree had uncommitted changes that were auto-committed on its detached H…; targetBranch?: string | undefined // The local branch the merge landed on (for the…"
 },
 {
  "method": "git.worktreeRemove",
  "channel": "git:worktreeRemove",
  "doc": "Remove a worktree (optionally force / with a patch export first).",
  "input": "{ worktreePath: string; repoPath: string; force?: boolean | undefined // Skip the uncommitted-changes check and pass --force.; exportPatch?: boolean | undefined // Before removing, persist the worktree's FULL unmerged work (commits since the merge-base … }",
  "inputFull": "{ worktreePath: string; repoPath: string; force?: boolean | undefined // Skip the uncommitted-changes check and pass --force.; exportPatch?: boolean | undefined // Before removing, persist the worktree's FULL unmerged work (commits since the merge-base … }",
  "output": "{ ok: boolean; error?: string | undefined; patchPath?: string | undefined // Absolute path of the exported patch, when exportPatch was requested and succeeded.; retainedBranch?: string | undefined // Set when the worktree ran on a generated `mcode/*` branch t…"
 },
 {
  "method": "git.worktreeStatus",
  "channel": "git:worktreeStatus",
  "doc": "Lifecycle state of ONE worktree (cheap probe for pollers).",
  "input": "{ worktreePath: string; repoPath: string }",
  "inputFull": "{ worktreePath: string; repoPath: string }",
  "output": "{ status: GitWorktreeInfo | null }"
 },
 {
  "method": "hooks.issueHostHookGrant",
  "channel": "hooks:issueHostHookGrant",
  "doc": "【MC-061】**用户真实操作**后签发一份主机 hook 授权(落盘)。`grantId` / 时间 / `revoked` 由主进程签发(schema `.strict()`;agent 经 `app_api_call` 够不到这条 —— blocked)。",
  "input": "{ pluginId: string // 贡献这条 hook 的插件名(manifest name)。; version?: string | undefined // 插件版本;省略 = 授权不限版本(升级后旧授权仍覆盖,较宽)。; command?: string | undefined // 命令**原文** —— 设置页那颗\"授权这条\"按钮把界面上印的那行命令递上来, 宿主用**唯一一份**摘要函数算 `commandDigest`(渲染端算不了 sha256,也不…; matcher?: string | undefined // matcher **原文**(同上,宿主算摘要);省略 = 不绑定 matcher。; events?: string[] | undefined // 该授权覆盖的原生事件名集合;省略/空 = 不限定事件。; commandDigest?: string | undefined // 命令内容摘要;省略/空 = 不绑定命令(按插件 + 事件放行,较宽)。; matcherDigest?: string | undefined // matcher 摘要;省略/空 = 不绑定 matcher。 }",
  "inputFull": "{ pluginId: string // 贡献这条 hook 的插件名(manifest name)。; version?: string | undefined // 插件版本;省略 = 授权不限版本(升级后旧授权仍覆盖,较宽)。; command?: string | undefined // 命令**原文** —— 设置页那颗\"授权这条\"按钮把界面上印的那行命令递上来, 宿主用**唯一一份**摘要函数算 `commandDigest`(渲染端算不了 sha256,也不…; matcher?: string | undefined // matcher **原文**(同上,宿主算摘要);省略 = 不绑定 matcher。; events?: string[] | undefined // 该授权覆盖的原生事件名集合;省略/空 = 不限定事件。; commandDigest?: string | undefined // 命令内容摘要;省略/空 = 不绑定命令(按插件 + 事件放行,较宽)。; matcherDigest?: string | undefined // matcher 摘要;省略/空 = 不绑定 matcher。 }",
  "output": "{ ok: boolean; error?: string | undefined; grant?: HostHookGrant | undefined }"
 },
 {
  "method": "hooks.list",
  "channel": "hooks:list",
  "doc": "全部钩子 + 读得见但用不了的条目。**坏条目不静默丢弃** —— 用户写的钩子不生效时, 这一页是唯一能解释为什么的地方。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ hooks: { id: string; name: string; enabled: boolean; command: string; event: 'error' | 'user.message' | 'tool.use' | 'tool.result' | 'approval.request' | 'request.res…; problems: { where: string; error: string; }[]; fileHealth: 'valid' | 'corrupt' | 'read_e…"
 },
 {
  "method": "hooks.listHostHookGrants",
  "channel": "hooks:listHostHookGrants",
  "doc": "【MC-061】列出当前全部**主机 hook 授权**(设置 → 插件 → 钩子授权)。只读 —— 只给 桌面渲染端;`app_api_call` 里这两条(issue/revoke)一律 blocked,故不走 agent。",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ grants: HostHookGrant[] }"
 },
 {
  "method": "hooks.rebuildCorrupt",
  "channel": "hooks:rebuildCorrupt",
  "doc": "【MC-051】显式「备份损坏原件 → 校验 sha256 → 重建」—— 唯一能吃下整份损坏 hooks.json 的操作。普通 save/remove 在损坏时**拒绝**(不覆盖原字节);这里 备份成功且校验通过才重建,返回备份路径。",
  "input": "{ hooks?: { id: string; name: string; enabled: boolean; command: string; event: 'error' | 'user.message' | 'tool.use' | 'tool.result' | 'approval.request' | 'request.res… }",
  "inputFull": "{ hooks?: { id: string; name: string; enabled: boolean; command: string; event: 'error' | 'user.message' | 'tool.use' | 'tool.result' | 'approval.request' | 'request.res… }",
  "output": "{ ok: boolean; error?: string | undefined; backupPath?: string | undefined }"
 },
 {
  "method": "hooks.remove",
  "channel": "hooks:remove",
  "doc": "删一条钩子(按 id)。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "hooks.revokeHostHookGrant",
  "channel": "hooks:revokeHostHookGrant",
  "doc": "【MC-061】撤销一份主机 hook 授权(按 grantId);撤销后该来源回到**默认拒绝**。",
  "input": "{ grantId: string }",
  "inputFull": "{ grantId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "hooks.runs",
  "channel": "hooks:runs",
  "doc": "最近的执行记录(新的在前)。**不进对话流** —— 一个挂在 `tool.use` 上的钩子一轮 会触发几十次,塞进消息流就是把对话刷屏;而节点会话是隐藏的,那些事件本来也不该 出现在父对话里。 【MC-061】另带一份**落盘审计**(`audit`):只有**插件 hook** 进那张表(带来源身份、 经授权执行),它跨重启活着、不会被 50 条环顶掉 —— 回答\"这份来源的这条钩子跑没跑、 被撤权 / 预算用尽挡下几次\"。`runs` 仍是内存环(含用户手写钩子),两栏语义不同、都给。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ runs: HookRun[]; audit: HookAuditEntry[]; auditError: string | null }"
 },
 {
  "method": "hooks.save",
  "channel": "hooks:save",
  "doc": "存一条钩子(**整份给过来**,不是\"改哪个字段\")—— 用户从头写的东西局部更新没意义,整份过来让校验只在一处发生。返回 `{ ok, error? }`。",
  "input": "{ hook: { id: string; name: string; enabled: boolean; command: string; event: 'error' | 'user.message' | 'tool.use' | 'tool.result' | 'approval.request' | 'request.res… }",
  "inputFull": "{ hook: { id: string; name: string; enabled: boolean; command: string; event: 'error' | 'user.message' | 'tool.use' | 'tool.result' | 'approval.request' | 'request.res… }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "hooks.test",
  "channel": "hooks:test",
  "doc": "拿一条**还没存下来**的配置试跑一次,把那一次的结果返回。",
  "input": "{ hook: { id: string; name: string; enabled: boolean; command: string; event: 'error' | 'user.message' | 'tool.use' | 'tool.result' | 'approval.request' | 'request.res… }",
  "inputFull": "{ hook: { id: string; name: string; enabled: boolean; command: string; event: 'error' | 'user.message' | 'tool.use' | 'tool.result' | 'approval.request' | 'request.res… }",
  "output": "{ run: HookRun }"
 },
 {
  "method": "library.addItems",
  "channel": "library:addItems",
  "doc": "入库(只建记录,不带文件)。返回新增的条目。",
  "input": "{ items: { title: string; url?: string | undefined; language?: string | undefined; collectionIds?: string[] | undefined; abstract?: string | undefined; }[] }",
  "inputFull": "{ items: { title: string; url?: string | undefined; language?: string | undefined; collectionIds?: string[] | undefined; abstract?: string | undefined; }[] }",
  "output": "{ items: LibraryItem[] }"
 },
 {
  "method": "library.adoptMarkdown",
  "channel": "library:adoptMarkdown",
  "doc": "直接把一份现成的 Markdown 挂到某条目上(不转录)。同级 `images/` 会一起搬。",
  "input": "{ path: string // 用户选中的 md 文件绝对路径。同级若有 `images/` 会一起搬。; id: string }",
  "inputFull": "{ path: string // 用户选中的 md 文件绝对路径。同级若有 `images/` 会一起搬。; id: string }",
  "output": "{ ok: boolean; error?: string | undefined; imageCount: number; missing: string[] // md 里引用了、源目录里找不到的图(按引用原样列出)。**如实报出来,不静默丢** —— 与 MCP 那条 `library_adopt_markdown` 同一口径(它会把这句… }"
 },
 {
  "method": "library.assignCollection",
  "channel": "library:assignCollection",
  "doc": "把文献加入/移出某集合(多对多,一篇可属多个集合)。",
  "input": "{ collectionId: string; itemIds: string[]; add: boolean // true = 加入,false = 移出。 }",
  "inputFull": "{ collectionId: string; itemIds: string[]; add: boolean // true = 加入,false = 移出。 }",
  "output": "{ collections: LibraryCollection[] }"
 },
 {
  "method": "library.attachToChat",
  "channel": "library:attachToChat",
  "doc": "把一条附件挂到指定会话的输入框上(左栏右键「添加到当前对话」)。 与 AI 的 `library_attach_to_chat` 共用同一份实现,所以效果一致。",
  "input": "{ key: string; sessionId: string }",
  "inputFull": "{ key: string; sessionId: string }",
  "output": "{ ok: boolean; name?: string | undefined; count?: number | undefined; error?: string | undefined }"
 },
 {
  "method": "library.conversionReport",
  "channel": "library:conversionReport",
  "doc": "逐篇的转换完整度(设置页的「转录检测」列表)。**完整 = md 有 + 它引用的图都在**。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ rows: LibraryConversionRow[]; total: number; complete: number; pending: number }"
 },
 {
  "method": "library.conversionStats",
  "channel": "library:conversionStats",
  "doc": "批量检测转换情况:共多少篇 / 已转 Markdown / 还没转。 设置页的「批量转换」用它 —— 比把全库拉进渲染端再数省得多。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ total: number; converted: number; pending: number }"
 },
 {
  "method": "library.convert",
  "channel": "library:convert",
  "doc": "兼容入口,**固定失败**:核心不转录、不上传、也不清理产物,只返回一句\"请走已配置的自动化在线转录\"的指引(见 `library/convert.ts` 的 `AUTOMATION_REQUIRED`)。`repair` 分支同样 fail-closed。",
  "input": "{ force?: boolean | undefined // 已经有 md 也重转。; collectionId?: string | undefined; ids?: string[] | undefined // 要转的条目;省略则转整个库(或某个集合)。; repair?: boolean | undefined // 按小类清理失联/多余产物并修复该小类；必须显式提供 collectionId。 }",
  "inputFull": "{ force?: boolean | undefined // 已经有 md 也重转。; collectionId?: string | undefined; ids?: string[] | undefined // 要转的条目;省略则转整个库(或某个集合)。; repair?: boolean | undefined // 按小类清理失联/多余产物并修复该小类；必须显式提供 collectionId。 }",
  "output": "{ converted: number; cleaned: number; failed: { id: string; error: string; }[] }"
 },
 {
  "method": "library.createCollection",
  "channel": "library:createCollection",
  "doc": "新建/改名/删除集合 —— 均返回**完整的新列表**,渲染端整体替换缓存(既定模式)。",
  "input": "{ name: string; prompt?: string | undefined // 这个分类的「给 AI 的说明」。省略 = 不写。; groupId?: string | undefined // 建在哪个大类下。省略 = 第一个大类。; parentId?: string | null | undefined }",
  "inputFull": "{ name: string; prompt?: string | undefined // 这个分类的「给 AI 的说明」。省略 = 不写。; groupId?: string | undefined // 建在哪个大类下。省略 = 第一个大类。; parentId?: string | null | undefined }",
  "output": "{ collections: LibraryCollection[] }"
 },
 {
  "method": "library.createNote",
  "channel": "library:createNote",
  "doc": "新建一篇空笔记(笔记库)。文件会先落一份 `# 标题` 骨架。",
  "input": "{ title: string; collectionIds?: string[] | undefined }",
  "inputFull": "{ title: string; collectionIds?: string[] | undefined }",
  "output": "{ item: LibraryItem | null }"
 },
 {
  "method": "library.deleteCollection",
  "channel": "library:deleteCollection",
  "doc": "删一个集合。**连整棵子树一起收** —— 子分类会随 CASCADE 消失,挂在子分类上的条目也会一并进回收站(不然会变成左栏找不回的僵尸)。返回最新完整列表。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ collections: LibraryCollection[] }"
 },
 {
  "method": "library.deleteItems",
  "channel": "library:deleteItems",
  "doc": "从库中移除。`deleteFiles` 决定是否连磁盘文件一起删。 **删不掉的会如实报在 `failed` 里,而且那几条记录留着**(见 `LibraryDeleteItemsResult`)。",
  "input": "{ ids: string[]; deleteFiles?: boolean | undefined // 是否连同磁盘上的 PDF/MD 一起删除。默认 false(只从库里移除记录)。; cascadeLinks?: string[] | undefined // 用户**勾了\"这个也一起删\"**的那些关联目标 —— 传 `library.deletePreview` 给出的 `targetItemId`。; keepTranscripts?: string[] | undefined // **保留转录产物**的条目名单(2026-09-28,用户:「删除不是把所有的链路上面的 文件都默认删除,弹出的窗口要可以选择的」)。名单里的条目删除时**跳过**它的 Mark… }",
  "inputFull": "{ ids: string[]; deleteFiles?: boolean | undefined // 是否连同磁盘上的 PDF/MD 一起删除。默认 false(只从库里移除记录)。; cascadeLinks?: string[] | undefined // 用户**勾了\"这个也一起删\"**的那些关联目标 —— 传 `library.deletePreview` 给出的 `targetItemId`。; keepTranscripts?: string[] | undefined // **保留转录产物**的条目名单(2026-09-28,用户:「删除不是把所有的链路上面的 文件都默认删除,弹出的窗口要可以选择的」)。名单里的条目删除时**跳过**它的 Mark… }",
  "output": "{ items: LibraryItem[] // 删完之后**完整**的列表 —— 与别的变更类 handler 同一条约定。; failed: LibraryDeleteFailure[] // 有哪几条的文件没删掉。全部成功时是空数组 —— **不是 undefined**,免得调用方写 `?.`。 }"
 },
 {
  "method": "library.deleteNote",
  "channel": "library:deleteNote",
  "doc": "删一条\"条目下的小笔记\"(不是笔记库条目)。返回**它所属条目**的最新笔记列表;删的是孤条(查不到归属)则回空数组。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ notes: LibraryNote[] }"
 },
 {
  "method": "library.deletePreview",
  "channel": "library:deletePreview",
  "doc": "删除**之前**看一眼会带走什么 —— 关联到的其他文献、以及这条自己的 Markdown 转录 产物(连同它的图床)。弹窗照着它画勾选框。 刻意是**只读查询**:渲染端不必为了画一个确认框去拉半张库。用户取消时也不会有 任何东西被动过。",
  "input": "{ ids: string[] }",
  "inputFull": "{ ids: string[] }",
  "output": "{ entries: LibraryDeletePreviewEntry[] }"
 },
 {
  "method": "library.entryPath",
  "channel": "library:entryPath",
  "doc": "**条目 → 磁盘绝对路径** —— 给中间栏那个 `FileEditor` 用的（它按路径读写）。 见 `LibraryEntryPathSchema` 头注：这不构成\"渲染端能读任意文件\"，路径是主进程 按库里的记录算的，而且还要过 `pathGuard` 那道围栏。",
  "input": "{ id: string; which?: 'pdf' | 'md' | undefined // 定位哪一个:PDF 还是转换出的 Markdown。默认 PDF。 }",
  "inputFull": "{ id: string; which?: 'pdf' | 'md' | undefined // 定位哪一个:PDF 还是转换出的 Markdown。默认 PDF。 }",
  "output": "{ path: string | null // 绝对路径；没有就是 null，此时 `error` 一定有话说。; error?: string | undefined; isDir?: boolean | undefined // 这一条**是不是目录** —— 目录在编辑器里打不开（它是\"往下翻\"那一层）， 调用方据此退回预览而不是把目录丢给 Monaco。 }"
 },
 {
  "method": "library.fullTextSearch",
  "channel": "library:fullTextSearch",
  "doc": "全文检索(ripgrep;sql.js 不含 FTS5)。",
  "input": "{ query: string; limit?: number | undefined; collectionIds?: string[] | undefined // 限定在哪些集合内搜;省略则全库。 }",
  "inputFull": "{ query: string; limit?: number | undefined; collectionIds?: string[] | undefined // 限定在哪些集合内搜;省略则全库。 }",
  "output": "{ matches: FullTextMatch[] }"
 },
 {
  "method": "library.get",
  "channel": "library:get",
  "doc": "单条详情。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ item: LibraryItem }"
 },
 {
  "method": "library.groupsGet",
  "channel": "library:groupsGet",
  "doc": "左栏大类:当前生效的分组(已过滤掉引用了已删类型的行)。",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ groups: LibraryGroupMeta[] }"
 },
 {
  "method": "library.groupsSave",
  "channel": "library:groupsSave",
  "doc": "整表替换大类。校验(一个类型只属一个组等)在主进程。",
  "input": "{ groups?: unknown }",
  "inputFull": "{ groups?: unknown }",
  "output": "{ ok: true } | { ok: false; error: string }"
 },
 {
  "method": "library.importFiles",
  "channel": "library:importFiles",
  "doc": "从**本地 PDF 文件**导入。 逐份:校验 → 按 sha256 去重 → 复制进库 → 入库(标题取文件名)→ 可选转 Markdown。",
  "input": "{ paths: string[] // 用户从文件选择框里挑出来的绝对路径。上限 200 —— 再多就该分批了。; mode?: 'files' | 'folder' | 'explode' | undefined // 导入模式：`\"files\"` = 逐个文件导入（默认）；`\"folder\"` = 把目录作为**一个** linked 条目收进来（不拆开，可展开浏览）；`\"explode\"` …; collectionIds?: string[] | undefined // 导入的文献归入哪些库(null/省略 = 只进总库)。; convert?: boolean | undefined }",
  "inputFull": "{ paths: string[] // 用户从文件选择框里挑出来的绝对路径。上限 200 —— 再多就该分批了。; mode?: 'files' | 'folder' | 'explode' | undefined // 导入模式：`\"files\"` = 逐个文件导入（默认）；`\"folder\"` = 把目录作为**一个** linked 条目收进来（不拆开，可展开浏览）；`\"explode\"` …; collectionIds?: string[] | undefined // 导入的文献归入哪些库(null/省略 = 只进总库)。; convert?: boolean | undefined }",
  "output": "{ items: LibraryItem[]; added: number; skipped: number; errors: { path: string; error: string; }[] // 失败原因(路径 + 人话);成功的不出现在这里。; converted: { ok: number; failed: number; } }"
 },
 {
  "method": "library.importGeneric",
  "channel": "library:importGeneric",
  "doc": "任意文件/目录导入为通用条目(linked = 引用原路径 / attached = 复制进库)。",
  "input": "{ paths: string[]; mode?: 'linked' | 'attached' | undefined; collectionIds?: string[] | undefined }",
  "inputFull": "{ paths: string[]; mode?: 'linked' | 'attached' | undefined; collectionIds?: string[] | undefined }",
  "output": "{ items: LibraryItem[]; added: number; skipped: number; errors: { path: string; error: string; }[] }"
 },
 {
  "method": "library.importNotes",
  "channel": "library:importNotes",
  "doc": "导入笔记(**Markdown 文件**,见 `LibraryImportNotesSchema`)。 与 importFiles 分开的理由:笔记入库即完成 —— 没有元数据要抓、没有 PDF 要下、 没有东西要转录。所以返回值里也没有 `converted`。",
  "input": "{ paths: string[]; collectionIds?: string[] | undefined }",
  "inputFull": "{ paths: string[]; collectionIds?: string[] | undefined }",
  "output": "{ items: LibraryItem[]; added: number; skipped: number; errors: { path: string; error: string; }[] }"
 },
 {
  "method": "library.itemManifest",
  "channel": "library:itemManifest",
  "doc": "给**单独一篇**生成清单 —— 「+」菜单里的选择器可以展开分类、只挑其中一篇。 与整库清单同一套机制:只放一行 `@清单路径`,正文由 agent 自己读。 `path` 为空串表示没挂上,`blockedReason` 说明是不是被用户自己设的屏蔽挡住了 (与 `library.attachToChat` 同一个判据)。**被挡住时要如实说**,不能静默地少挂 一个 —— 否则用户只会觉得\"点了没反应\"。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ path: string; count: number; blockedReason?: string | undefined // 有值 = 这条被屏蔽规则挡住了,值是挡住它的原因(给用户看的那句话)。 }"
 },
 {
  "method": "library.linkAdd",
  "channel": "library:linkAdd",
  "doc": "加一条关联。**幂等** —— 已有同一条就返回它,不产生第二行。",
  "input": "{ itemId: string; targetPath?: string | undefined; targetItemId?: string | undefined }",
  "inputFull": "{ itemId: string; targetPath?: string | undefined; targetItemId?: string | undefined }",
  "output": "{ link: LibraryItemLink }"
 },
 {
  "method": "library.linkCounts",
  "channel": "library:linkCounts",
  "doc": "一批条目**各自**的关联条数 —— 左栏行尾那个徽标。见契约里 `LibraryLinkCountsSchema`。",
  "input": "{ itemIds: string[] }",
  "inputFull": "{ itemIds: string[] }",
  "output": "{ counts: Record<string, number> // 条目 id → 条数。**没关联的不在里面**(调用方 `?? }"
 },
 {
  "method": "library.linkRemove",
  "channel": "library:linkRemove",
  "doc": "解除一条关联(按关联行自己的 id)。",
  "input": "{ linkId: string }",
  "inputFull": "{ linkId: string }",
  "output": "{ ok: boolean }"
 },
 {
  "method": "library.linksOf",
  "channel": "library:linksOf",
  "doc": "一条条目的关联,**双向都返回**(`direction` 区分)。界面上的「关联」区用它。 `target` 是目标那一条的摘要(**主进程一次查好**,渲染端不必再逐条拉)—— 库内条目给标题,库外路径给文件名。`suppressed` 是\"这条会被屏蔽规则挡住\"的 原因(没被挡就是 undefined):界面据此把它**显示成灰态并说明为什么**,而不是 干脆不显示 —— 用户得看得见\"它存在,只是被挡了\",否则会以为关联丢了。",
  "input": "{ itemId: string }",
  "inputFull": "{ itemId: string }",
  "output": "{ links: LibraryLinkView[] }"
 },
 {
  "method": "library.list",
  "channel": "library:list",
  "doc": "列出文献。`collectionId` 为 null/省略表示全部。",
  "input": "{ query?: string | undefined // 搜索关键词(标题/摘要/文件路径),大小写不敏感。; limit?: number | undefined; offset?: number | undefined; collectionId?: string | null | undefined; hasFile?: boolean | undefined // 只看有 / 没有文件的条目。 }",
  "inputFull": "{ query?: string | undefined // 搜索关键词(标题/摘要/文件路径),大小写不敏感。; limit?: number | undefined; offset?: number | undefined; collectionId?: string | null | undefined; hasFile?: boolean | undefined // 只看有 / 没有文件的条目。 }",
  "output": "{ items: LibraryItem[]; total: number }"
 },
 {
  "method": "library.listCollections",
  "channel": "library:listCollections",
  "doc": "列全部集合(树形;已摊成渲染端要的形状)。**返回值里含回收站**(`{ name:\"回收站\", isTrash:true }`)—— 调用方要自己按 `isTrash` 滤掉,别把它当成一个真分类(报告真机实测 NEW-4)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ collections: LibraryCollection[] }"
 },
 {
  "method": "library.listNotes",
  "channel": "library:listNotes",
  "doc": "条目下的小笔记(读文献时随手记的),**与「笔记库」是两件事** —— 笔记库的条目本身就是一篇 Markdown,这里的笔记依附于某篇论文/教材。",
  "input": "{ itemId: string }",
  "inputFull": "{ itemId: string }",
  "output": "{ notes: LibraryNote[] }"
 },
 {
  "method": "library.manifest",
  "channel": "library:manifest",
  "doc": "生成/刷新某个库的清单 Markdown,返回其绝对路径(count = 收录条数)。 清单是给 agent 读的 —— 对话里只放 `@该路径`,与文件附件的机制一致。",
  "input": "{ collectionId: string }",
  "inputFull": "{ collectionId: string }",
  "output": "{ path: string; count: number }"
 },
 {
  "method": "library.moveCollection",
  "channel": "library:moveCollection",
  "doc": "把集合移到别处(改父级 / 调同级次序)。 `ok: false` = **被拒**(重名,或者会形成环)—— 与 `renameCollection` 同一个口径: 如实把结果回给调用方提示,而不是静默不动。`collections` 无论如何都是**最新的 完整列表**,所以被拒时调用方也不需要再拉一次。",
  "input": "{ id: string; parentId?: string | null | undefined // 新的父集合。不传 = 父级不动;null = 移到最外层。 }",
  "inputFull": "{ id: string; parentId?: string | null | undefined // 新的父集合。不传 = 父级不动;null = 移到最外层。 }",
  "output": "{ collections: LibraryCollection[]; ok: boolean; error?: string | undefined // `ok: false` 的原因(重名 / 成环)。由主进程给,界面直接摆出来。 }"
 },
 {
  "method": "library.openFile",
  "channel": "library:openFile",
  "doc": "用系统默认程序打开库里的文件 —— 主要用途是看 md 的渲染效果(「打开 md 预览」)。 同样只收条目 id,路径在 main 里拼。",
  "input": "{ id: string; which?: 'pdf' | 'md' | undefined // 定位哪一个:PDF 还是转换出的 Markdown。默认 PDF。 }",
  "inputFull": "{ id: string; which?: 'pdf' | 'md' | undefined // 定位哪一个:PDF 还是转换出的 Markdown。默认 PDF。 }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "library.readAsset",
  "channel": "library:readAsset",
  "doc": "【MC-087】**按条目身份读一个子资源（图片）** —— 给 Markdown 预览里的本地图片用。 渲染端只请求\"某条目内的某相对路径\";主进程从可信 id 取 linked/attached 根、把子资源 限制在条目根内（`..`/symlink 都拒），读字节后包成 data URL 返回。**不放宽**通用 `file.readBinary` 的项目边界，也不把 linked 外部目录加进全局 workspace root。",
  "input": "{ id: string; relPath: string // 子资源相对**条目根**的路径（图片等）。`..`/绝对路径/库外链接一律拒。; which?: 'pdf' | 'md' | undefined // 同 readFile：看哪一份（省略 = 本体）。 }",
  "inputFull": "{ id: string; relPath: string // 子资源相对**条目根**的路径（图片等）。`..`/绝对路径/库外链接一律拒。; which?: 'pdf' | 'md' | undefined // 同 readFile：看哪一份（省略 = 本体）。 }",
  "output": "{ dataUrl: string; error?: string | undefined }"
 },
 {
  "method": "library.readFile",
  "channel": "library:readFile",
  "doc": "读通用文件条目的内容(文本 / 图片与二进制 base64 / 目录列表)。",
  "input": "{ id: string; relPath?: string | undefined // 目录条目内要读的文件(相对该目录)。省略 = 读条目本体 / 列目录。; which?: 'pdf' | 'md' | undefined // 读**哪一份**（2026-09-21）。 }",
  "inputFull": "{ id: string; relPath?: string | undefined // 目录条目内要读的文件(相对该目录)。省略 = 读条目本体 / 列目录。; which?: 'pdf' | 'md' | undefined // 读**哪一份**（2026-09-21）。 }",
  "output": "{ content: LibraryFileContent }"
 },
 {
  "method": "library.readHighlights",
  "channel": "library:readHighlights",
  "doc": "读某篇 PDF 的全部高亮。 高亮存在 PDF **旁边**的 `.<名字>.mcode-highlights.json`（见 `main/library/pdfHighlightsStore.ts`），所以这里按**路径**问 —— 项目目录里那些 根本不在资料库里的 PDF 也要能有高亮。",
  "input": "{ pdfPath: string // PDF 的绝对路径。必须落在已知工作区根内（pathGuard）。 }",
  "inputFull": "{ pdfPath: string // PDF 的绝对路径。必须落在已知工作区根内（pathGuard）。 }",
  "output": "{ highlights: PdfHighlight[] }"
 },
 {
  "method": "library.readMarkdown",
  "channel": "library:readMarkdown",
  "doc": "读一篇文献的 Markdown 正文,**在应用内预览**(不再跳外部编辑器)。 主进程同时把正文里引用到的图片解析成 data URL 一起返回 —— 渲染进程读不了本地 文件,而 md 里写的是 `images/xxx.jpg` 这种相对路径,只有主进程知道它相对于谁。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean; error?: string | undefined; markdown: string // 正文。ok 为 false 时是空串。; dir: string // md 所在目录的绝对路径(界面上显示用,让用户知道这是哪份文件)。; fileName: string // 文件名,如 `full.md` / `<sha256>.md`。; images: Record<string, string> // 相对引用 → data URL。键与 md 里的写法一致(如 `image…"
 },
 {
  "method": "library.readOriginalPdf",
  "channel": "library:readOriginalPdf",
  "doc": "读**干净底稿**的字节 —— 烘烤时从它出发（底稿 + 全部标注 → 覆盖那个 PDF）。 没有底稿时返回当前文件本身（那时它就是干净的）。走结构化克隆，不做 base64 （同 `library.readPdf`）—— 论文十几 MB，base64 要多涨三分之一。",
  "input": "{ pdfPath: string // PDF 的绝对路径。必须落在已知工作区根内（pathGuard）。 }",
  "inputFull": "{ pdfPath: string // PDF 的绝对路径。必须落在已知工作区根内（pathGuard）。 }",
  "output": "{ bytes: Uint8Array<ArrayBufferLike> | null }"
 },
 {
  "method": "library.readPdf",
  "channel": "library:readPdf",
  "doc": "读一篇 PDF 的原始字节给应用内 pdf.js 阅读器。**走结构化克隆、不做 base64**(文件十几 MB,base64 要多涨三分之一)。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean; error?: string | undefined; bytes: Uint8Array<ArrayBufferLike> | null // PDF 原始字节。`ok` 为 false 时是 null。走结构化克隆,不做 base64。 }"
 },
 {
  "method": "library.renameCollection",
  "channel": "library:renameCollection",
  "doc": "改名。`ok: false` 表示重名被拒(此时 collections 不变) —— 由调用方提示用户。",
  "input": "{ id: string; prompt?: string | undefined // 传空串 = 清空说明(清单里不再注入这一层)。; name?: string | undefined }",
  "inputFull": "{ id: string; prompt?: string | undefined // 传空串 = 清空说明(清单里不再注入这一层)。; name?: string | undefined }",
  "output": "{ collections: LibraryCollection[]; ok: boolean }"
 },
 {
  "method": "library.renameItem",
  "channel": "library:renameItem",
  "doc": "改条目的显示标题(三个库通用)。",
  "input": "{ id: string; title: string }",
  "inputFull": "{ id: string; title: string }",
  "output": "{ item: LibraryItem | null }"
 },
 {
  "method": "library.restoreItems",
  "channel": "library:restoreItems",
  "doc": "从回收站里**还原**这几条 —— 放回最后删除的那个分类。 与 `deleteItems` 是一对:那条(recycle bin 里)是真的删,这条是把它们捞回来。 单独一条 RPC 而不是让渲染端拼两次 `assignCollection`,理由见契约里的注释。",
  "input": "{ ids: string[] }",
  "inputFull": "{ ids: string[] }",
  "output": "{ items: LibraryItem[] }"
 },
 {
  "method": "library.revealFile",
  "channel": "library:revealFile",
  "doc": "在系统文件管理器里定位库里的文件(PDF 或转换出的 Markdown)。 **入参只有条目 id** —— 路径由主进程从库里取,渲染端无从指定任意路径。",
  "input": "{ id: string; which?: 'pdf' | 'md' | undefined // 定位哪一个:PDF 还是转换出的 Markdown。默认 PDF。 }",
  "inputFull": "{ id: string; which?: 'pdf' | 'md' | undefined // 定位哪一个:PDF 还是转换出的 Markdown。默认 PDF。 }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "library.saveHighlights",
  "channel": "library:saveHighlights",
  "doc": "**只写索引**（PDF 旁边那份 JSON）—— 划一笔就走这条，几毫秒，不动 PDF。",
  "input": "{ pdfPath: string; highlights: unknown[] }",
  "inputFull": "{ pdfPath: string; highlights: unknown[] }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "library.saveNote",
  "channel": "library:saveNote",
  "doc": "新建或修改一条笔记,返回该条目下的完整列表(与其它变更类接口同一约定)。",
  "input": "{ content: string; itemId: string; id?: string | undefined }",
  "inputFull": "{ content: string; itemId: string; id?: string | undefined }",
  "output": "{ notes: LibraryNote[] }"
 },
 {
  "method": "library.suppressGet",
  "channel": "library:suppressGet",
  "doc": "屏蔽规则:当前生效的(哪些资料不进上下文)。没存过 = 空规则(什么都不挡)。",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ rule: LibrarySuppressRule }"
 },
 {
  "method": "library.suppressSave",
  "channel": "library:suppressSave",
  "doc": "整表替换屏蔽规则。校验(前缀合法、扩展名规范化)在主进程过 `parseSuppressJson`。",
  "input": "{ rule?: unknown }",
  "inputFull": "{ rule?: unknown }",
  "output": "{ ok: true } | { ok: false; error: string }"
 },
 {
  "method": "library.writeHighlights",
  "channel": "library:writeHighlights",
  "doc": "把高亮**写回 PDF 文件本身**（真 `/Highlight` 批注）。 字节走 base64（`file:writeFile` 只收 utf-8，而 PDF 是二进制）。主进程收到后 **原子替换**，中途崩了原文件一个字节不动；顺带更新旁边的高亮索引。",
  "input": "{ pdfPath: string; bytesBase64: string // 改好的 PDF，base64（不带 `data:` 前缀）。; highlights?: unknown[] | undefined }",
  "inputFull": "{ pdfPath: string; bytesBase64: string // 改好的 PDF，base64（不带 `data:` 前缀）。; highlights?: unknown[] | undefined }",
  "output": "{ ok: boolean; error?: string | undefined; written?: number | undefined // 写进去几条。; skipped?: { id: string; reason: string; }[] | undefined // 被跳过的（附原因）。 }"
 },
 {
  "method": "library.writeNote",
  "channel": "library:writeNote",
  "doc": "把编辑器的内容写回笔记文件(仅笔记)。",
  "input": "{ id: string; text: string }",
  "inputFull": "{ id: string; text: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "lsp.closeDocument",
  "channel": "lsp:closeDocument",
  "doc": "Close a document (textDocument/didClose).",
  "input": "{ filePath: string; workspacePath: string }",
  "inputFull": "{ filePath: string; workspacePath: string }",
  "output": "void"
 },
 {
  "method": "lsp.didChange",
  "channel": "lsp:didChange",
  "doc": "Notify the server of a full-content change (textDocument/didChange).",
  "input": "{ version: number; text: string; filePath: string; workspacePath: string }",
  "inputFull": "{ version: number; text: string; filePath: string; workspacePath: string }",
  "output": "void"
 },
 {
  "method": "lsp.didSave",
  "channel": "lsp:didSave",
  "doc": "Notify the server of a save (textDocument/didSave).",
  "input": "{ text: string; filePath: string; workspacePath: string }",
  "inputFull": "{ text: string; filePath: string; workspacePath: string }",
  "output": "void"
 },
 {
  "method": "lsp.healthCheck",
  "channel": "lsp:healthCheck",
  "doc": "Verify the server binary runs (--version or --help probe).",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java' }",
  "inputFull": "{ language: 'typescript' | 'python' | 'go' | 'java' }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "lsp.install",
  "channel": "lsp:install",
  "doc": "Install a language server via its package manager (npm/pip/go/brew).",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java' }",
  "inputFull": "{ language: 'typescript' | 'python' | 'go' | 'java' }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "lsp.installFromFile",
  "channel": "lsp:installFromFile",
  "doc": "Install from a user-downloaded archive/binary (manual download fallback for when the package-manager install fails due to network issues).",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java'; archivePath: string // Absolute path to the user-selected file (archive or binary). }",
  "inputFull": "{ language: 'typescript' | 'python' | 'go' | 'java'; archivePath: string // Absolute path to the user-selected file (archive or binary). }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "lsp.list",
  "channel": "lsp:list",
  "doc": "List all language servers and their install/running state.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ languages: LspLanguageState[] }"
 },
 {
  "method": "lsp.openDocument",
  "channel": "lsp:openDocument",
  "doc": "Open a document in the server (textDocument/didOpen). Lazily starts the server for (workspacePath, language) on first call.",
  "input": "{ filePath: string; language: 'typescript' | 'python' | 'go' | 'java'; workspacePath: string }",
  "inputFull": "{ filePath: string; language: 'typescript' | 'python' | 'go' | 'java'; workspacePath: string }",
  "output": "void"
 },
 {
  "method": "lsp.prewarm",
  "channel": "lsp:prewarm",
  "doc": "预启动某工作区的 Java 语言服务器(**不等用户打开 .java 文件**),把那次性的 Maven/Gradle 工程导入提前到用户浏览时跑。火忘式、幂等(活着的不重启)。",
  "input": "{ workspacePath: string // Project root to pre-warm (must be a known project). }",
  "inputFull": "{ workspacePath: string // Project root to pre-warm (must be a known project). }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "lsp.request",
  "channel": "lsp:request",
  "doc": "Forward an arbitrary LSP request (definition/references/hover/...) to the server and await its response.",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java'; workspacePath: string; method: string // LSP method, e.g.; params?: unknown // LSP params object (passed through verbatim). }",
  "inputFull": "{ language: 'typescript' | 'python' | 'go' | 'java'; workspacePath: string; method: string // LSP method, e.g.; params?: unknown // LSP params object (passed through verbatim). }",
  "output": "{ result: unknown } | { error: { code: number; message: string; } }"
 },
 {
  "method": "lsp.restart",
  "channel": "lsp:restart",
  "doc": "Restart a language server for one workspace (stop + clear the crash-loop guard + immediately relaunch). Clicking a startup-failure notice calls this after the user fixes the environment.",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java'; workspacePath: string // Project root the server was started for (must be a known project). }",
  "inputFull": "{ language: 'typescript' | 'python' | 'go' | 'java'; workspacePath: string // Project root the server was started for (must be a known project). }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "lsp.setPath",
  "channel": "lsp:setPath",
  "doc": "Set a custom server path / args override. Returns the refreshed list.",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java'; args?: string[] | undefined; serverPath?: string | undefined; javaHome?: string | undefined // Java only: override the JDK used to run jdtls (JAVA_HOME). }",
  "inputFull": "{ language: 'typescript' | 'python' | 'go' | 'java'; args?: string[] | undefined; serverPath?: string | undefined; javaHome?: string | undefined // Java only: override the JDK used to run jdtls (JAVA_HOME). }",
  "output": "{ languages: LspLanguageState[] }"
 },
 {
  "method": "lsp.toggle",
  "channel": "lsp:toggle",
  "doc": "Enable/disable a language (disabling kills any running server). Returns the refreshed state list.",
  "input": "{ enabled: boolean; language: 'typescript' | 'python' | 'go' | 'java' }",
  "inputFull": "{ enabled: boolean; language: 'typescript' | 'python' | 'go' | 'java' }",
  "output": "{ languages: LspLanguageState[] }"
 },
 {
  "method": "lsp.uninstall",
  "channel": "lsp:uninstall",
  "doc": "Uninstall a language server.",
  "input": "{ language: 'typescript' | 'python' | 'go' | 'java' }",
  "inputFull": "{ language: 'typescript' | 'python' | 'go' | 'java' }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "mcp.authorize",
  "channel": "mcp:authorize",
  "doc": "Run the OAuth browser login for a remote MCP server (claude mcp login). Opens the system browser; resolves when the CLI reports the flow done.",
  "input": "{ kind: 'http' | 'sse'; name: string; url: string; scope?: 'user' | 'plugin' | 'builtin' | undefined // Source the clicked row came from. }",
  "inputFull": "{ kind: 'http' | 'sse'; name: string; url: string; scope?: 'user' | 'plugin' | 'builtin' | undefined // Source the clicked row came from. }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "mcp.enginesSet",
  "channel": "mcp:enginesSet",
  "doc": "Set an MCP server's per-engine visibility (claude/codex — pi has no MCP support). Takes the full boolean pair; both engine views re-materialize after the write, and the change lands on the next turn. Returns the resolved state as persisted (or ok:false + erro…",
  "input": "{ name: string; claude: boolean; codex: boolean }",
  "inputFull": "{ name: string; claude: boolean; codex: boolean }",
  "output": "{ ok: boolean; error?: string | undefined; perEngine?: McpEngineState | undefined }"
 },
 {
  "method": "mcp.genofficeInstall",
  "channel": "mcp:genofficeInstall",
  "doc": "Install the bundled GenOffice document tool as a user-scope stdio MCP server. The workspace-root fence (`GENOFFICE_ALLOWED_ROOTS`) is computed from every known root at call time; an empty root set is refused (unset fence = unrestricted). Re-run with `replace`…",
  "input": "{ replace?: boolean | undefined // Overwrite an existing entry of the same name — re-running the install is how the fence's … }",
  "inputFull": "{ replace?: boolean | undefined // Overwrite an existing entry of the same name — re-running the install is how the fence's … }",
  "output": "{ ok: true; name: string; roots: string[]; materialized: boolean } | { ok: false; reason: string }"
 },
 {
  "method": "mcp.import",
  "channel": "mcp:import",
  "doc": "Import selected servers into the user scope. Already-existing names are skipped. Returns per-server imported / skipped / error lists.",
  "input": "{ servers: ({ name: string; origin: { kind: 'global'; } | { path: string; kind: 'project'; }; } | { name: string; config: z.objectOutputType<{ type: z.ZodOptional<z.ZodLi… }",
  "inputFull": "{ servers: ({ name: string; origin: { kind: 'global'; } | { path: string; kind: 'project'; }; } | { name: string; config: z.objectOutputType<{ type: z.ZodOptional<z.ZodLi… }",
  "output": "{ imported: string[]; skipped: string[]; errors: { name: string; error: string; }[] }"
 },
 {
  "method": "mcp.list",
  "channel": "mcp:list",
  "doc": "List all MCP servers across the three sources (user config file, project .mcp.json, built-in mcode-browser) with their enabled state.",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ servers: McpServerEntry[] }"
 },
 {
  "method": "mcp.marketSearch",
  "channel": "mcp:marketSearch",
  "doc": "Search one registry (network); entries carry ready install options.",
  "input": "{ source: string; query?: string | undefined; cursor?: string | undefined }",
  "inputFull": "{ source: string; query?: string | undefined; cursor?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined; entries: McpMarketEntry[]; nextCursor?: string | undefined }"
 },
 {
  "method": "mcp.marketSourceAdd",
  "channel": "mcp:marketSourceAdd",
  "doc": "加一个 MCP 注册中心(市场源)。**先连通探一次**再落,连不上/已存在/非 http(s) 都回 `{ ok:false, error }`(不抛);成功回新分配的 `id`。 【MC-037】用户记录损坏时 `corrupt:true` + 拒绝写入(原设置行一个不动)。",
  "input": "{ url: string; label?: string | undefined }",
  "inputFull": "{ url: string; label?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined; id?: string | undefined; corrupt?: boolean | undefined }"
 },
 {
  "method": "mcp.marketSourceRemove",
  "channel": "mcp:marketSourceRemove",
  "doc": "删一个用户加的 MCP 注册中心(**内置那个删不掉**)。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean; error?: string | undefined; corrupt?: boolean | undefined }"
 },
 {
  "method": "mcp.marketSources",
  "channel": "mcp:marketSources",
  "doc": "MCP market: registry sources (built-in official registry + user added). 【MC-037】`corrupt` 有值 = 用户来源记录读不出来(列表只含官方,写入被拒)。",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ sources: McpMarketSource[]; corrupt?: { reason: string; } | undefined }"
 },
 {
  "method": "mcp.projectCopy",
  "channel": "mcp:projectCopy",
  "doc": "Copy user-scope servers into the project file (existing names skipped).",
  "input": "{ projectPath: string; names: string[] }",
  "inputFull": "{ projectPath: string; names: string[] }",
  "output": "{ copied: string[]; skipped: string[]; failed: { name: string; reason: string; }[] }"
 },
 {
  "method": "mcp.projectList",
  "channel": "mcp:projectList",
  "doc": "Project scope (`<project>/.mcp.json`): list with trust state.",
  "input": "{ projectPath: string }",
  "inputFull": "{ projectPath: string }",
  "output": "{ file: string // Absolute path of the project's .mcp.json.; exists: boolean; servers: McpProjectServer[]; invalid: string[] // Entry names present in the file whose config is not a valid server.; error?: string | undefined // File unreadable / not JSON — the…"
 },
 {
  "method": "mcp.projectRemove",
  "channel": "mcp:projectRemove",
  "doc": "Remove one project server from the project file.",
  "input": "{ projectPath: string; name: string }",
  "inputFull": "{ projectPath: string; name: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "mcp.projectSave",
  "channel": "mcp:projectSave",
  "doc": "Add / overwrite one project server (auto-trusted).",
  "input": "{ projectPath: string; name: string; config: z.objectOutputType<{ type: z.ZodOptional<z.ZodLiteral<'stdio'>>; command: z.ZodString; args: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>; env: z.ZodOptional…; replace?: boolean | undefined }",
  "inputFull": "{ projectPath: string; name: string; config: z.objectOutputType<{ type: z.ZodOptional<z.ZodLiteral<'stdio'>>; command: z.ZodString; args: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>; env: z.ZodOptional…; replace?: boolean | undefined }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "mcp.projectTrust",
  "channel": "mcp:projectTrust",
  "doc": "Trust / untrust one project server as currently written.",
  "input": "{ projectPath: string; name: string; trusted: boolean }",
  "inputFull": "{ projectPath: string; name: string; trusted: boolean }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "mcp.remove",
  "channel": "mcp:remove",
  "doc": "Remove a user-scope server (from both the config file and the stash).",
  "input": "{ name: string }",
  "inputFull": "{ name: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "mcp.save",
  "channel": "mcp:save",
  "doc": "Add a user-scope server (writes into ~/.mcode/.claude.json).",
  "input": "{ name: string; config: z.objectOutputType<{ type: z.ZodOptional<z.ZodLiteral<'stdio'>>; command: z.ZodString; args: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>; env: z.ZodOptional…; replace?: boolean | undefined // Edit mode: overwrite the existing entry (truth layer or stash) instead of rejecting a dup… }",
  "inputFull": "{ name: string; config: z.objectOutputType<{ type: z.ZodOptional<z.ZodLiteral<'stdio'>>; command: z.ZodString; args: z.ZodOptional<z.ZodArray<z.ZodString, 'many'>>; env: z.ZodOptional…; replace?: boolean | undefined // Edit mode: overwrite the existing entry (truth layer or stash) instead of rejecting a dup… }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "mcp.scanImport",
  "channel": "mcp:scanImport",
  "doc": "Scan the local Claude CLI config (~/.claude.json) for servers available for import (global + per-project entries). Read-only.",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ sources: McpImportSource[] }"
 },
 {
  "method": "mcp.toggle",
  "channel": "mcp:toggle",
  "doc": "Enable/disable a server. User scope moves the config between the config file and the management stash; project/builtin update the management state. Takes effect on the next turn.",
  "input": "{ name: string; scope: 'user' | 'plugin' | 'builtin'; enabled: boolean }",
  "inputFull": "{ name: string; scope: 'user' | 'plugin' | 'builtin'; enabled: boolean }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "mcp.unauthorize",
  "channel": "mcp:unauthorize",
  "doc": "Clear a remote MCP server's stored OAuth token (claude mcp logout).",
  "input": "{ kind: 'http' | 'sse'; name: string; url: string; scope?: 'user' | 'plugin' | 'builtin' | undefined // Source the clicked row came from. }",
  "inputFull": "{ kind: 'http' | 'sse'; name: string; url: string; scope?: 'user' | 'plugin' | 'builtin' | undefined // Source the clicked row came from. }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "memory.assistant",
  "channel": "memory:assistant",
  "doc": "记忆助手:一次 `op`(list/start/cancel/discard/deliver)驱动在**隐藏工作会话**里跑的记忆作业(capture/checkpoint/health)。返回作业列表,并视 op 带上 incoming 作业 / 目标会话 / 注入回执。",
  "input": "{ sessionId: string; op: 'list' } | { kind: 'capture' | 'checkpoint' | 'health'; sessionId: string; op: 'start' } | { sessionId: string; op: 'cancel'; jobId: string } | { sessionId: string; op: 'discard'; jobId: string } | { sessionId: string; op: 'deliver'; …",
  "inputFull": "{ sessionId: string; op: 'list' } | { kind: 'capture' | 'checkpoint' | 'health'; sessionId: string; op: 'start' } | { sessionId: string; op: 'cancel'; jobId: string } | { sessionId: string; op: 'discard'; jobId: string } | { sessionId: string; op: 'deliver'; …",
  "output": "{ jobs: { status: 'running' | 'failed' | 'cancelled' | 'ready' | 'expired' | 'queued' | 'consumed'; id: string; kind: 'capture' | 'checkpoint' | 'health'; result: stri…; incoming?: { status: 'running' | 'failed' | 'cancelled' | 'ready' | 'expired' | 'queued' …"
 },
 {
  "method": "memory.categories",
  "channel": "memory:categories",
  "doc": "类目清单(固定六类)。**无参 handler**。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ length: number // Gets or sets the length of the array.; toString: () => string // Returns a string representation of an array.; toLocaleString: { (): string; (locales: string | string[], options?: Intl.NumberFormatOptions & Intl.DateTimeFormatOptions): str…"
 },
 {
  "method": "memory.delete",
  "channel": "memory:delete",
  "doc": "删一条记忆。`ok: false` 时 `error` 是给人看的句子,不是异常。",
  "input": "{ path: string; expectedRevision?: string | undefined }",
  "inputFull": "{ path: string; expectedRevision?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined; code?: 'conflict' | undefined }"
 },
 {
  "method": "memory.list",
  "channel": "memory:list",
  "doc": "列记忆文件(可选按类目过滤),行形状见 `../memory.ts` 的 `MemoryFileMeta`。",
  "input": "{ category?: string | undefined }",
  "inputFull": "{ category?: string | undefined }",
  "output": "{ files: MemoryFileMeta[] }"
 },
 {
  "method": "memory.manage",
  "channel": "memory:manage",
  "doc": "记忆维护(桌面专用,模型拿不到):按 `action`(list/preview/import/history/restore)操作原生记忆来源。`import`/`restore` 要带 digest + `confirmed:true`。",
  "input": "{ action: 'list' } | { source: string; action: 'preview' } | { source: string; action: 'import'; global: boolean; category: 'project' | 'rules' | 'preferences' | 'experiences' | 'failures' | 'decisions'; digest: string; confirmed: true; projectId?: string | u…",
  "inputFull": "{ action: 'list' } | { source: string; action: 'preview' } | { source: string; action: 'import'; global: boolean; category: 'project' | 'rules' | 'preferences' | 'experiences' | 'failures' | 'decisions'; digest: string; confirmed: true; projectId?: string | u…",
  "output": "{ ok: boolean; error?: string | undefined; content?: string | undefined; digest?: string | undefined; path?: string | undefined; sources?: { id: string; label: string; }[] | undefined; projects?: { id: string; name: string; }[] | undefined; history?: { id: st…"
 },
 {
  "method": "memory.read",
  "channel": "memory:read",
  "doc": "读一条记忆的正文(不含 frontmatter)。",
  "input": "{ path: string }",
  "inputFull": "{ path: string }",
  "output": "{ content: string; revision: string }"
 },
 {
  "method": "memory.review",
  "channel": "memory:review",
  "doc": "只扫描建议，不改任何文件；截断/读失败必须在结果里显式说明。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ stale: MemoryReviewEntry[]; staleTotal: number; staleTruncated: boolean; duplicates: MemoryReviewPair[]; duplicatePairTotal: number; pairTruncated: boolean; scannedForDuplicates: number; duplicateTruncated: boolean; tooLong: string[] // 正文超长，未纳入相似度比较（可仍因过期而…"
 },
 {
  "method": "memory.reviewDelete",
  "channel": "memory:reviewDelete",
  "doc": "整理中人工勾选并确认后的逐条删除；主进程核对完整内容指纹。",
  "input": "{ path: string; digest: string }",
  "inputFull": "{ path: string; digest: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "memory.save",
  "channel": "memory:save",
  "doc": "存正文(frontmatter 由主进程维护)。",
  "input": "{ path: string; content: string; title?: string | undefined; expectedRevision?: string | null | undefined; pinned?: boolean | undefined }",
  "inputFull": "{ path: string; content: string; title?: string | undefined; expectedRevision?: string | null | undefined; pinned?: boolean | undefined }",
  "output": "{ ok: boolean; revision?: string | undefined; error?: string | undefined; code?: 'conflict' | undefined }"
 },
 {
  "method": "mobile.cancelPairing",
  "channel": "mobile:cancelPairing",
  "doc": "Cancel the active pairing (clears the nonce).",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ ok: true }"
 },
 {
  "method": "mobile.clearLogin",
  "channel": "mobile:clearLogin",
  "doc": "关闭账号密码登录(清掉凭据;已登录的设备保留,需要的话单独撤销)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ enabled: boolean; username: string }"
 },
 {
  "method": "mobile.getActiveCount",
  "channel": "mobile:getActiveCount",
  "doc": "Count of paired devices that are currently \"active\" (made a request within {@link MOBILE_ACTIVE_WINDOW_MS }).",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ count: number }"
 },
 {
  "method": "mobile.getLogin",
  "channel": "mobile:getLogin",
  "doc": "账号密码登录的状态(只有账号名 + 开没开,哈希永不出主进程)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ enabled: boolean; username: string }"
 },
 {
  "method": "mobile.getStatus",
  "channel": "mobile:getStatus",
  "doc": "Server status (running, port, endpoint, candidate LAN IPs) for the dialog.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ running: boolean; port: number; endpoint: string; lanIp: string | null; lanIps: string[] }"
 },
 {
  "method": "mobile.getTunnel",
  "channel": "mobile:getTunnel",
  "doc": "手机自有域名的隧道状态(和「远程控制」/ 公网 MCP 无关,单独一份)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ mode: MobileTunnelMode; hostname: string; tokenHint: string // 已存 Tunnel Token 的尾 4 位(`****abcd`);没存过为空串。; phase: 'failed' | 'stopped' | 'starting' | 'ready' | 'reconnecting' // named:cloudflared 进程的状态;external:对 `https://域名/api/health` 的探测结论;off:stopped。; …"
 },
 {
  "method": "mobile.listDevices",
  "channel": "mobile:listDevices",
  "doc": "List paired devices (token stripped).",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ devices: PairedDevice[] }"
 },
 {
  "method": "mobile.revokeDevice",
  "channel": "mobile:revokeDevice",
  "doc": "Revoke a paired device; its token stops working immediately.",
  "input": "{ deviceId: string }",
  "inputFull": "{ deviceId: string }",
  "output": "{ ok: true }"
 },
 {
  "method": "mobile.setLogin",
  "channel": "mobile:setLogin",
  "doc": "设置/修改手机端登录的账号密码(密码至少 8 位)。改密码不会踢掉已登录的设备 —— 要踢就在设备列表里撤销。",
  "input": "{ username: string; password: string }",
  "inputFull": "{ username: string; password: string }",
  "output": "{ enabled: boolean; username: string }"
 },
 {
  "method": "mobile.setTunnel",
  "channel": "mobile:setTunnel",
  "doc": "存手机隧道配置(token 留空 = 沿用)。隧道在跑且配置变了会按新配置重起。",
  "input": "{ mode: 'named' | 'external' | 'off'; hostname: string; token?: string | undefined // 留空 = 沿用已存的那串。; clearToken?: boolean | undefined // 显式删掉已存的 token。 }",
  "inputFull": "{ mode: 'named' | 'external' | 'off'; hostname: string; token?: string | undefined // 留空 = 沿用已存的那串。; clearToken?: boolean | undefined // 显式删掉已存的 token。 }",
  "output": "{ mode: MobileTunnelMode; hostname: string; tokenHint: string // 已存 Tunnel Token 的尾 4 位(`****abcd`);没存过为空串。; phase: 'failed' | 'stopped' | 'starting' | 'ready' | 'reconnecting' // named:cloudflared 进程的状态;external:对 `https://域名/api/health` 的探测结论;off:stopped。; …"
 },
 {
  "method": "mobile.startPairing",
  "channel": "mobile:startPairing",
  "doc": "Begin a pairing session: returns QR URL + 6-digit code + endpoint. Optional `host` overrides auto-detected LAN IP (for multi-NIC machines where the phone can only reach one interface).",
  "input": "undefined | { host?: string | undefined; mode?: 'lan' | 'remote' | undefined; endpoint?: string | undefined; force?: boolean | undefined // Void the pending pairing (if any) and generate a fresh nonce + code. }",
  "inputFull": "undefined | { host?: string | undefined; mode?: 'lan' | 'remote' | undefined; endpoint?: string | undefined; force?: boolean | undefined // Void the pending pairing (if any) and generate a fresh nonce + code. }",
  "output": "{ pairing: PairingStartResult }"
 },
 {
  "method": "mobile.startTunnel",
  "channel": "mobile:startTunnel",
  "doc": "启动手机隧道(named 模式起 cloudflared;并记住下次启动自动开)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ mode: MobileTunnelMode; hostname: string; tokenHint: string // 已存 Tunnel Token 的尾 4 位(`****abcd`);没存过为空串。; phase: 'failed' | 'stopped' | 'starting' | 'ready' | 'reconnecting' // named:cloudflared 进程的状态;external:对 `https://域名/api/health` 的探测结论;off:stopped。; …"
 },
 {
  "method": "mobile.stopTunnel",
  "channel": "mobile:stopTunnel",
  "doc": "停止手机隧道(并取消自动开启)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ mode: MobileTunnelMode; hostname: string; tokenHint: string // 已存 Tunnel Token 的尾 4 位(`****abcd`);没存过为空串。; phase: 'failed' | 'stopped' | 'starting' | 'ready' | 'reconnecting' // named:cloudflared 进程的状态;external:对 `https://域名/api/health` 的探测结论;off:stopped。; …"
 },
 {
  "method": "modules.cancel",
  "channel": "modules:cancel",
  "doc": "取消一个在跑的模块任务(abort 那个 job 并标成 `cancelled`)。返回取消后的快照。",
  "input": "{ moduleId: string; taskId: string }",
  "inputFull": "{ moduleId: string; taskId: string }",
  "output": "{ id: string; moduleId: string; contributionId: string; resource: { path: string; projectPath: string; }; view: { title: { zh: string; en: string; }; fields: { title: { zh: string; en: string; }; key: string; }[]; }; status: 'running' | 'completed' | 'failed'…"
 },
 {
  "method": "modules.catalog",
  "channel": "modules:catalog",
  "doc": "全部模块(**内置 + 已装**)的清单:各自的贡献项、宿主能力表、以及内置只读模块能当工作流目标的那几项。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ modules: { apiVersion: 1; id: string; version: string; title: { zh: string; en: string; }; permissions: ('resource.read' | 'resource.write' | 'network')[]; contribution…; capabilities: { id: string; kind: 'query' | 'action' | 'task'; metadata?: { version: s…"
 },
 {
  "method": "modules.install",
  "channel": "modules:install",
  "doc": "安装一份外部模块清单(id 必须以 `user.` 开头)。**只收声明式 manifest,不是 JS 沙箱**;模块总数上限 32。返回装完后的新清单,以及这次变更取消掉的运行中任务数/失败原因(升级换执行体时为非零)。",
  "input": "{ manifest: { apiVersion: 1; id: string; version: string; title: { zh: string; en: string; }; permissions: ('resource.read' | 'resource.write' | 'network')[]; contribution…; confirmReadAccess: true; confirmExecutableCode?: true | undefined // 【MC-035】带 `program` 的扩展包**额外**要求一次针对\"会执行代码\"的确认 —— 与只读声明分开:同意\"读我选中的文件\"不等于同意\"在我机器上跑一段程序\"。 }",
  "inputFull": "{ manifest: { apiVersion: 1; id: string; version: string; title: { zh: string; en: string; }; permissions: ('resource.read' | 'resource.write' | 'network')[]; contribution…; confirmReadAccess: true; confirmExecutableCode?: true | undefined // 【MC-035】带 `program` 的扩展包**额外**要求一次针对\"会执行代码\"的确认 —— 与只读声明分开:同意\"读我选中的文件\"不等于同意\"在我机器上跑一段程序\"。 }",
  "output": "{ catalog: ModuleCatalog; cancelledTasks: number; cancelFailures: { taskId: string; reason: string; }[] }"
 },
 {
  "method": "modules.invoke",
  "channel": "modules:invoke",
  "doc": "触发模块的一个贡献项。按能力 `kind` 分流:非 task 的直接跑出结果,是 task 的立刻返回 `{type:\"task\"}` 句柄(进度靠 `modules.task` 拉)。",
  "input": "{ moduleId: string; contributionId: string; resource: { path: string; projectPath: string; }; requestId: string }",
  "inputFull": "{ moduleId: string; contributionId: string; resource: { path: string; projectPath: string; }; requestId: string }",
  "output": "{ type: 'result'; value: Record<string, string | number | boolean | null>; view: { title: { zh: string; en: string; }; fields: { title: { zh: string; en: string; }; key: string; }[]; } } | { type: 'task'; task: ModuleTask }"
 },
 {
  "method": "modules.issueWorkflowGrant",
  "channel": "modules:issueWorkflowGrant",
  "doc": "【MC-036】给一个已安装的用户模块的只读贡献**签发**工作流运行授权(绑定模块 id/版本/ 贡献/能力/工作区)。由设置页里用户本人的点击发起;Agent 侧钉 blocked(见 `appControl/policy.ts`)—— 自动运行权不能由模型自己给自己升。返回签发后的目录。",
  "input": "{ moduleId: string; contributionId: string; projectPath: string; capabilityId: string; moduleVersion: string }",
  "inputFull": "{ moduleId: string; contributionId: string; projectPath: string; capabilityId: string; moduleVersion: string }",
  "output": "{ modules: { apiVersion: 1; id: string; version: string; title: { zh: string; en: string; }; permissions: ('resource.read' | 'resource.write' | 'network')[]; contribution…; capabilities: { id: string; kind: 'query' | 'action' | 'task'; metadata?: { version: s…"
 },
 {
  "method": "modules.remove",
  "channel": "modules:remove",
  "doc": "卸载一个模块(内置的删不掉,会抛)。顺带 cancel 它还在 running 的任务;返回删完后的新清单与取消诊断。",
  "input": "{ moduleId: string }",
  "inputFull": "{ moduleId: string }",
  "output": "{ catalog: ModuleCatalog; cancelledTasks: number; cancelFailures: { taskId: string; reason: string; }[] }"
 },
 {
  "method": "modules.revokeWorkflowGrant",
  "channel": "modules:revokeWorkflowGrant",
  "doc": "【MC-036】撤销一条工作流运行授权(同一 (模块,版本,贡献,能力,工作区) 幂等键)。",
  "input": "{ moduleId: string; contributionId: string; projectPath: string; capabilityId: string; moduleVersion: string }",
  "inputFull": "{ moduleId: string; contributionId: string; projectPath: string; capabilityId: string; moduleVersion: string }",
  "output": "{ modules: { apiVersion: 1; id: string; version: string; title: { zh: string; en: string; }; permissions: ('resource.read' | 'resource.write' | 'network')[]; contribution…; capabilities: { id: string; kind: 'query' | 'action' | 'task'; metadata?: { version: s…"
 },
 {
  "method": "modules.task",
  "channel": "modules:task",
  "doc": "取一个模块任务的当前快照(状态 / 进度 / 结果)。",
  "input": "{ moduleId: string; taskId: string }",
  "inputFull": "{ moduleId: string; taskId: string }",
  "output": "{ id: string; moduleId: string; contributionId: string; resource: { path: string; projectPath: string; }; view: { title: { zh: string; en: string; }; fields: { title: { zh: string; en: string; }; key: string; }[]; }; status: 'running' | 'completed' | 'failed'…"
 },
 {
  "method": "modules.tasks",
  "channel": "modules:tasks",
  "doc": "列某个项目下**仍在内存里**的模块任务(进程重启后为空,不落库)。",
  "input": "{ projectPath: string }",
  "inputFull": "{ projectPath: string }",
  "output": "{ length: number // Gets or sets the length of the array.; toString: () => string // Returns a string representation of an array.; toLocaleString: { (): string; (locales: string | string[], options?: Intl.NumberFormatOptions & Intl.DateTimeFormatOptions): str…"
 },
 {
  "method": "monitoring.overview",
  "channel": "monitoring:overview",
  "doc": "监控总览的一次快照:正在跑几个、触发器挂得怎么样。**无参 handler**。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ totalRuns: number // 已收口的运行总数(不含重启前丢掉的进行中运行 —— 活跃登记不落盘)。; succeeded: number // 收成 `success` 的次数。; failed: number // 收成 `failed` 的次数。; avgDurationMs: number // 平均耗时(毫秒)。拿不到耗时的运行不进平均;一条都没有时是 0。; lastErrorAt?: number | undefined // 最近一次失败发生的时刻(该运行收口的那一刻)。没有失败就…"
 },
 {
  "method": "monitoring.runs",
  "channel": "monitoring:runs",
  "doc": "最近的运行摘要(新的在前),监控列表用 —— 见 `MonitoringRunSummary`。",
  "input": "{ limit?: number | undefined }",
  "inputFull": "{ limit?: number | undefined }",
  "output": "{ length: number // Gets or sets the length of the array.; toString: () => string // Returns a string representation of an array.; toLocaleString: { (): string; (locales: string | string[], options?: Intl.NumberFormatOptions & Intl.DateTimeFormatOptions): str…"
 },
 {
  "method": "notification.focusSession",
  "channel": "notification:focusSession",
  "doc": "Focus a session after an OS notification click. Main shows + focuses the window, then pushes `notification:focusSession` so the renderer navigates.",
  "input": "{ sessionId: string }",
  "inputFull": "{ sessionId: string }",
  "output": "void"
 },
 {
  "method": "notification.getPrefs",
  "channel": "notification:getPrefs",
  "doc": "Get the user's notification preferences (typed wrapper over settings).",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ prefs: NotificationPrefs }"
 },
 {
  "method": "notification.setPrefs",
  "channel": "notification:setPrefs",
  "doc": "Set (persist) the user's notification preferences.",
  "input": "{ osEnabled: boolean // Master switch for OS-level notifications.; turnComplete: boolean // Notify on turn completion (non-active session).; errors: boolean // Notify on errors (non-active session).; blocking: boolean // Notify on blocking events (approval request / question / plan approval).; backgroundTasks: boolean // Notify when a backgrounded subagent finishes.; sound: boolean // 系统通知带提示音(Electron `silent: !sound`)。Default true(老行为)。; inAppToasts: boolean // 窗口在前台时,后台会话的动静弹应用内提示(Toast)。关掉 = 前台时什么都不弹, 只留角标。Default true(老行为)。; alsoWhenFocused: boolean // 窗口在前台时也发系统通知(默认只在失焦 / 最小化时发)。Default false(老行为)。; mutedProjectIds: string[] // 按项目静音:这些项目里的会话不发系统通知、也不弹应用内提示(角标照旧)。; quietHours: { enabled: boolean; start: string; end: string; } // 免打扰时段(本地时间 HH:MM,可跨午夜)。时段内不发系统通知、不弹提示。 }",
  "inputFull": "{ osEnabled: boolean // Master switch for OS-level notifications.; turnComplete: boolean // Notify on turn completion (non-active session).; errors: boolean // Notify on errors (non-active session).; blocking: boolean // Notify on blocking events (approval request / question / plan approval).; backgroundTasks: boolean // Notify when a backgrounded subagent finishes.; sound: boolean // 系统通知带提示音(Electron `silent: !sound`)。Default true(老行为)。; inAppToasts: boolean // 窗口在前台时,后台会话的动静弹应用内提示(Toast)。关掉 = 前台时什么都不弹, 只留角标。Default true(老行为)。; alsoWhenFocused: boolean // 窗口在前台时也发系统通知(默认只在失焦 / 最小化时发)。Default false(老行为)。; mutedProjectIds: string[] // 按项目静音:这些项目里的会话不发系统通知、也不弹应用内提示(角标照旧)。; quietHours: { enabled: boolean; start: string; end: string; } // 免打扰时段(本地时间 HH:MM,可跨午夜)。时段内不发系统通知、不弹提示。 }",
  "output": "{ prefs: NotificationPrefs }"
 },
 {
  "method": "onlyoffice.close",
  "channel": "onlyoffice:close",
  "doc": "关掉会话(清掉主进程里那份记录)。",
  "input": "{ sessionKey: string }",
  "inputFull": "{ sessionKey: string }",
  "output": "{ ok: boolean }"
 },
 {
  "method": "onlyoffice.detectLocal",
  "channel": "onlyoffice:detectLocal",
  "doc": "本机装没装 Document Server、跑没跑、密钥是什么。 设置页用它做**自动填写**:检测到本机那一份就把地址与密钥直接写进配置,用户 不用手抄 `local.json`。主进程里 `detectLocal()` 早就有了(安装流程与工具链 检测都在用),这里只是把它开给渲染端 —— 不然「自动帮我配好」这件事在 UI 侧 无从谈起。只读,不需要管理员权限。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ supported: boolean // 只有 Windows 有官方安装包；其他平台一律 false（面板隐藏\"一键安装\"）。; installed: boolean; installDir: string | null; version: string | null; serviceState: 'unknown' | 'running' | 'stopped'; port: number | null // healthcheck 探通的端口；服务没跑 / 探不到 = null。; jwtSecret…"
 },
 {
  "method": "onlyoffice.forceSave",
  "channel": "onlyoffice:forceSave",
  "doc": "让 DS 立刻回调保存(用户点「保存」/ 关标签前)。",
  "input": "{ sessionKey: string }",
  "inputFull": "{ sessionKey: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "onlyoffice.getConfig",
  "channel": "onlyoffice:getConfig",
  "doc": "读当前的 OnlyOffice 配置(serverUrl / jwtSecret / callbackHost;带内存缓存)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ serverUrl: string // Document Server 地址，如 `http://127.0.0.1:8080`。空 = 未配置（Office 文件只能只读预览）。; jwtSecret: string // JWT 密钥。DS 7.2+ 默认开启 JWT，必须与它 `services.CoAuthoring.secret` 一致；留空表示 DS 关了 JWT。; callbackHost: string // DS 回连 Mcode 时用的主机名/IP。空 = 自动：serverUrl 是…"
 },
 {
  "method": "onlyoffice.open",
  "channel": "onlyoffice:open",
  "doc": "为一个文件开一次编辑会话:返回 DS 的 api.js 地址与直接交给 `DocsAPI.DocEditor` 的配置。",
  "input": "{ filePath: string // 绝对路径。必须落在某个已知工作区根内（与 `file:readFile` 同一道闸）。; mode?: 'view' | 'edit' | undefined // `view` 用于资料库/通用文件查看器；默认 `edit`。; deviceType?: 'desktop' | 'mobile' | undefined // 移动端查看器使用 OnlyOffice 的 mobile 布局。 }",
  "inputFull": "{ filePath: string // 绝对路径。必须落在某个已知工作区根内（与 `file:readFile` 同一道闸）。; mode?: 'view' | 'edit' | undefined // `view` 用于资料库/通用文件查看器；默认 `edit`。; deviceType?: 'desktop' | 'mobile' | undefined // 移动端查看器使用 OnlyOffice 的 mobile 布局。 }",
  "output": "{ ok: boolean; error?: string | undefined // 失败原因（未配置 / 路径越界 / 不支持的类型 / 桥起不来）。; notConfigured?: boolean | undefined // 未配置 DS 时为 true —— 渲染端据此画\"去设置\"而不是\"出错了\"。; apiScriptUrl?: string | undefined // `<serverUrl>/web-apps/apps/api/documents/api.js`; sessionKey?: …"
 },
 {
  "method": "onlyoffice.sessionState",
  "channel": "onlyoffice:sessionState",
  "doc": "某次会话的保存状态(最近保存时间 / 最近错误 / DS 状态码)。",
  "input": "{ sessionKey: string }",
  "inputFull": "{ sessionKey: string }",
  "output": "{ alive: boolean // 会话还在（关掉后主进程会把它清掉）。; lastSavedAt: number | null // 最近一次成功写回磁盘的时间（ms）。null = 这次会话还没存过。; lastError: string | null // 最近一次回调 / 写回失败的原因。成功一次就清掉。; lastStatus: number | null // DS 最近一次回调的 status 码（1 编辑中 / 2 待保存 / 4 无改动关闭 / 6 强制保存…）。; freeMemMB: n…"
 },
 {
  "method": "onlyoffice.setConfig",
  "channel": "onlyoffice:setConfig",
  "doc": "存 OnlyOffice 配置到 settings 表并刷新内存缓存。`serverUrl` 会归一(去尾斜杠、补协议)。",
  "input": "{ serverUrl: string // Document Server 地址，如 `http://127.0.0.1:8080`。空 = 未配置（Office 文件只能只读预览）。; jwtSecret: string // JWT 密钥。DS 7.2+ 默认开启 JWT，必须与它 `services.CoAuthoring.secret` 一致；留空表示 DS 关了 JWT。; callbackHost: string // DS 回连 Mcode 时用的主机名/IP。空 = 自动：serverUrl 是本机地址就用 `127.0.0.1`， 否则取第一块非内部 IPv4 网卡地址。Docker De… }",
  "inputFull": "{ serverUrl: string // Document Server 地址，如 `http://127.0.0.1:8080`。空 = 未配置（Office 文件只能只读预览）。; jwtSecret: string // JWT 密钥。DS 7.2+ 默认开启 JWT，必须与它 `services.CoAuthoring.secret` 一致；留空表示 DS 关了 JWT。; callbackHost: string // DS 回连 Mcode 时用的主机名/IP。空 = 自动：serverUrl 是本机地址就用 `127.0.0.1`， 否则取第一块非内部 IPv4 网卡地址。Docker De… }",
  "output": "{ serverUrl: string // Document Server 地址，如 `http://127.0.0.1:8080`。空 = 未配置（Office 文件只能只读预览）。; jwtSecret: string // JWT 密钥。DS 7.2+ 默认开启 JWT，必须与它 `services.CoAuthoring.secret` 一致；留空表示 DS 关了 JWT。; callbackHost: string // DS 回连 Mcode 时用的主机名/IP。空 = 自动：serverUrl 是…"
 },
 {
  "method": "onlyoffice.status",
  "channel": "onlyoffice:status",
  "doc": "是否配置了 DS、以及它现在能不能连上(`/healthcheck`)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ configured: boolean; reachable: boolean // 能否 GET 到 `<serverUrl>/healthcheck`（DS 返回字面量 `true`）。; error?: string | undefined; serverUrl: string }"
 },
 {
  "method": "outputStyle.list",
  "channel": "outputStyle:list",
  "doc": "Output styles (settings panel): list built-in + user styles. The selection itself is persisted via the generic setting.get/set channels under AGENT_OUTPUT_STYLE_SETTING_KEY.",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ styles: OutputStyleEntry[] }"
 },
 {
  "method": "piModels.delete",
  "channel": "piModels:delete",
  "doc": "删一个 Pi provider —— **models.json 条目与加密 key 一起删**。返回删完后的脱敏清单。",
  "input": "{ name: string }",
  "inputFull": "{ name: string }",
  "output": "{ providers: Record<string, PiProviderPublic> }"
 },
 {
  "method": "piModels.getApiKey",
  "channel": "piModels:getApiKey",
  "doc": "Returns cleartext apiKey. Used two ways: (1) main-process turn-time injection into the pi authStorage; (2) the settings UI's eye-icon view (same security carve-out as customModel.getToken).",
  "input": "{ name: string }",
  "inputFull": "{ name: string }",
  "output": "{ apiKey: string | null }"
 },
 {
  "method": "piModels.list",
  "channel": "piModels:list",
  "doc": "列全部 Pi provider(**脱敏**;明文 key 另走 `piModels.getApiKey`)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ providers: Record<string, PiProviderPublic> }"
 },
 {
  "method": "piModels.listAvailable",
  "channel": "piModels:listAvailable",
  "doc": "List models the SDK can authenticate with the current configured keys. Builds a fresh ModelRuntime with all encrypted apiKeys injected, then returns getAvailable() projected into BuiltinModelOption[] shape for the composer's model picker.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ models: BuiltinModelOption[] }"
 },
 {
  "method": "piModels.listEndpointModels",
  "channel": "piModels:listEndpointModels",
  "doc": "问端点要模型列表（填进设置页的下拉框）。拉不到时抛错，由界面回退到手输。",
  "input": "{ baseUrl: string; apiKey?: string | undefined; authMode?: 'bearer' | 'x-api-key' | undefined; headers?: Record<string, string> | undefined; anthropicVersion?: boolean | undefined }",
  "inputFull": "{ baseUrl: string; apiKey?: string | undefined; authMode?: 'bearer' | 'x-api-key' | undefined; headers?: Record<string, string> | undefined; anthropicVersion?: boolean | undefined }",
  "output": "{ models: string[] }"
 },
 {
  "method": "piModels.save",
  "channel": "piModels:save",
  "doc": "新建或更新一个 Pi provider(upsert)。apiKey 非空则加密存;空 + 已存在=**保留旧 key**;空 + 新建=抛错。models.json 里按模型 id **合并保留**既有字段。",
  "input": "{ name: string; config: Record<string, unknown>; apiKey?: string | undefined }",
  "inputFull": "{ name: string; config: Record<string, unknown>; apiKey?: string | undefined }",
  "output": "{ providers: Record<string, PiProviderPublic> }"
 },
 {
  "method": "piModels.test",
  "channel": "piModels:test",
  "doc": "兼容性/连通性探测：向用户填的地址发一次最小请求，确认地址+密钥+模型名能用。 三个引擎共用同一形状（Claude 那条是 `customModel.test`，Pi/Codex 走这条）。",
  "input": "{ model: string // 要探测哪个模型。; baseUrl: string; apiKey?: string | undefined; authMode?: 'bearer' | 'x-api-key' | undefined // 认证头形态。缺省 = bearer（多数第三方网关）。; headers?: Record<string, string> | undefined // 额外请求头（与保存进配置的那份一致，测试才代表真回合）。; anthropicVersion?: boolean | undefined // Anthropic 风格端点要 anthropic-version 头。 }",
  "inputFull": "{ model: string // 要探测哪个模型。; baseUrl: string; apiKey?: string | undefined; authMode?: 'bearer' | 'x-api-key' | undefined // 认证头形态。缺省 = bearer（多数第三方网关）。; headers?: Record<string, string> | undefined // 额外请求头（与保存进配置的那份一致，测试才代表真回合）。; anthropicVersion?: boolean | undefined // Anthropic 风格端点要 anthropic-version 头。 }",
  "output": "{ ok: boolean; detail?: string | undefined; error?: string | undefined }"
 },
 {
  "method": "plugins.enginesSet",
  "channel": "plugins:enginesSet",
  "doc": "Per-engine switches of one plugin (Claude / Codex / Pi), like the skill matrix. Omitted engines keep their value; lands on the next turn.",
  "input": "{ name: string; claude?: boolean | undefined; codex?: boolean | undefined; pi?: boolean | undefined }",
  "inputFull": "{ name: string; claude?: boolean | undefined; codex?: boolean | undefined; pi?: boolean | undefined }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "plugins.installGit",
  "channel": "plugins:installGit",
  "doc": "Install by shallow-cloning a git repository. Same review flow.",
  "input": "{ url: string; ref?: string | undefined }",
  "inputFull": "{ url: string; ref?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined; plugin?: PluginState | undefined }"
 },
 {
  "method": "plugins.installLocal",
  "channel": "plugins:installLocal",
  "doc": "Install from a local plugin directory or .zip. Lands DISABLED; the renderer shows the component-review dialog and calls setEnabled.",
  "input": "{ localPath: string }",
  "inputFull": "{ localPath: string }",
  "output": "{ ok: boolean; error?: string | undefined; plugin?: PluginState | undefined }"
 },
 {
  "method": "plugins.installMarketplace",
  "channel": "plugins:installMarketplace",
  "doc": "Install one entry of a user-added marketplace. Same review flow.",
  "input": "{ name: string; marketplace: string }",
  "inputFull": "{ name: string; marketplace: string }",
  "output": "{ ok: boolean; error?: string | undefined; plugin?: PluginState | undefined }"
 },
 {
  "method": "plugins.list",
  "channel": "plugins:list",
  "doc": "List installed plugins (manifest + component summaries + enable state). Enabled plugins are delivered to providers at the next turn start.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ plugins: PluginState[] }"
 },
 {
  "method": "plugins.marketplaceAdd",
  "channel": "plugins:marketplaceAdd",
  "doc": "Add a marketplace (git URL or local directory).",
  "input": "{ kind: 'local' | 'git'; ref: string // git URL, or absolute local directory path.; requestId?: string | undefined; name?: string | undefined }",
  "inputFull": "{ kind: 'local' | 'git'; ref: string // git URL, or absolute local directory path.; requestId?: string | undefined; name?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "plugins.marketplaceList",
  "channel": "plugins:marketplaceList",
  "doc": "List user-added marketplaces with their parsed entries. 【MC-037】`corrupt` 有值 = 用户记录读不出来(列表只含出厂市场,写入被拒)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ marketplaces: PluginMarketplaceState[]; corrupt?: { reason: string; } | undefined }"
 },
 {
  "method": "plugins.marketplaceRefresh",
  "channel": "plugins:marketplaceRefresh",
  "doc": "Re-fetch a marketplace's tree.",
  "input": "{ name: string; requestId?: string | undefined }",
  "inputFull": "{ name: string; requestId?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "plugins.marketplaceRemove",
  "channel": "plugins:marketplaceRemove",
  "doc": "Remove a marketplace (cloned tree deleted; installed plugins stay).",
  "input": "{ name: string }",
  "inputFull": "{ name: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "plugins.projectList",
  "channel": "plugins:projectList",
  "doc": "Installed plugins as seen from one project (override ∘ global).",
  "input": "{ projectPath: string }",
  "inputFull": "{ projectPath: string }",
  "output": "{ plugins: PluginProjectRow[] }"
 },
 {
  "method": "plugins.projectSet",
  "channel": "plugins:projectSet",
  "doc": "Set / clear one plugin's per-project override.",
  "input": "{ projectPath: string; name: string; enabled?: boolean | null | undefined; engines?: { claude?: boolean | undefined; codex?: boolean | undefined; pi?: boolean | undefined; } | null | undefined }",
  "inputFull": "{ projectPath: string; name: string; enabled?: boolean | null | undefined; engines?: { claude?: boolean | undefined; codex?: boolean | undefined; pi?: boolean | undefined; } | null | undefined }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "plugins.remove",
  "channel": "plugins:remove",
  "doc": "Uninstall every installed version of a plugin. Rejected while any turn is running.",
  "input": "{ name: string }",
  "inputFull": "{ name: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "plugins.setEnabled",
  "channel": "plugins:setEnabled",
  "doc": "Enable/disable a plugin for subsequent turns.",
  "input": "{ name: string; enabled: boolean }",
  "inputFull": "{ name: string; enabled: boolean }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "project.archive",
  "channel": "project:archive",
  "doc": "Set a project's archived flag (soft-delete; restorable).",
  "input": "{ id: string; archived: boolean }",
  "inputFull": "{ id: string; archived: boolean }",
  "output": "{ project: Project }"
 },
 {
  "method": "project.create",
  "channel": "project:create",
  "doc": "新建项目(记一条记录,不建磁盘目录)。建完读回权威行(含真正的 sort_order)并广播 `projects.changed`。",
  "input": "{ path: string; name: string }",
  "inputFull": "{ path: string; name: string }",
  "output": "{ project: Project }"
 },
 {
  "method": "project.delete",
  "channel": "project:delete",
  "doc": "Hard-delete a project; its sessions + messages cascade-delete (DB FK).",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "void"
 },
 {
  "method": "project.list",
  "channel": "project:list",
  "doc": "列未归档的项目(左栏项目树用)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ projects: Project[] }"
 },
 {
  "method": "project.pin",
  "channel": "project:pin",
  "doc": "Pin/unpin a project (top-of-left-bar pinned section). Returns the updated row.",
  "input": "{ id: string; pinned: boolean }",
  "inputFull": "{ id: string; pinned: boolean }",
  "output": "{ project: Project }"
 },
 {
  "method": "project.rename",
  "channel": "project:rename",
  "doc": "Rename a project (display-only). Returns the updated row.",
  "input": "{ id: string; name: string }",
  "inputFull": "{ id: string; name: string }",
  "output": "{ project: Project }"
 },
 {
  "method": "project.reorder",
  "channel": "project:reorder",
  "doc": "Persist a drag-to-reorder: writes sort_order = index for each id.",
  "input": "{ orderedIds: string[] }",
  "inputFull": "{ orderedIds: string[] }",
  "output": "void"
 },
 {
  "method": "project.sessions",
  "channel": "project:sessions",
  "doc": "某项目下的对话,分页。**默认页大小 5**(归档箱不传 limit = 全部);`worktree` 会同时收窄列表与计数 —— 两边必须同口径,否则 `hasMore` 会数进列表从不返回的行。",
  "input": "{ projectId: string; worktree?: 'exclude' | 'only' | undefined; limit?: number | undefined; offset?: number | undefined; archived?: boolean | undefined }",
  "inputFull": "{ projectId: string; worktree?: 'exclude' | 'only' | undefined; limit?: number | undefined; offset?: number | undefined; archived?: boolean | undefined }",
  "output": "{ sessions: Session[]; hasMore: boolean; total: number }"
 },
 {
  "method": "project.setGroup",
  "channel": "project:setGroup",
  "doc": "Assign a project to a group (left-bar \"grouped\" view); null removes it.",
  "input": "{ id: string; group: string | null }",
  "inputFull": "{ id: string; group: string | null }",
  "output": "{ project: Project }"
 },
 {
  "method": "projectInit.apply",
  "channel": "projectInit:apply",
  "doc": "执行一次初始化(确定性落盘:**从不覆盖**已有文件/记忆、不执行代码、不发模型轮)。逐项报成败、**不回滚**已建成的;需要 AI 生成说明文件时把提示词交回渲染端,由它作普通一轮发出。",
  "input": "{ sessionId: string; command: string; digest: string }",
  "inputFull": "{ sessionId: string; command: string; digest: string }",
  "output": "{ projectId: string; root: string; actions: ProjectInitAction[]; agentPrompt?: string | undefined // 有 AI 生成步骤时:要发给引擎的提示词,由渲染端作为普通一轮对话发出。; agentFilename?: 'AGENTS.md' | 'CLAUDE.md' | undefined }"
 },
 {
  "method": "projectInit.delete",
  "channel": "projectInit:delete",
  "doc": "删一份模板。同样要带 `expectedRevision` 复核(防手滑删了别人刚改的)。",
  "input": "{ id: string; expectedRevision: string }",
  "inputFull": "{ id: string; expectedRevision: string }",
  "output": "{ ok: true }"
 },
 {
  "method": "projectInit.get",
  "channel": "projectInit:get",
  "doc": "按 id 取一份项目初始化模板全文(带 `revision`)。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ id: string; revision: string; description: string; files: { path: string; content: string; }[]; name: string; directories: string[]; memories: { title: string; content: string; pinned: boolean; category: 'project' | 'rules' | 'preferences' | 'experiences' |…"
 },
 {
  "method": "projectInit.importPreset",
  "channel": "projectInit:importPreset",
  "doc": "【MC-006】按预设 id 导入一份。**永远新建**;重名自动加 `-N` 后缀(名字是命令的一部分, 只能用 `INIT_NAME_RE` 允许的字符)。校验/落库走与界面保存同一个 `saveProjectInitializer`。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean; id?: string | undefined; name?: string | undefined; error?: string | undefined }"
 },
 {
  "method": "projectInit.list",
  "channel": "projectInit:list",
  "doc": "列**项目初始化模板**(`{templates, defaultId}`)。⚠️ 从前这里挂着上面那句记忆 文件的说明 —— 一段 JSDoc 误抄,把调用方引到 `memory.*` 上去找\"记忆文件\",而它 返回的其实是模板表(报告附录 E 的新-E1)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ templates: ProjectInitSummary[]; defaultId: string | null }"
 },
 {
  "method": "projectInit.listPresets",
  "channel": "projectInit:listPresets",
  "doc": "【MC-006】列**出厂初始化预设**(装包 `resources/presets/project-init.json`,开发读仓库)。 与 `workflow.listPresets` 同一套分发与三态;不带草稿正文,只有摘要。无参 handler。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ health: 'absent' | 'corrupt' | 'ok' // `absent` = 这个安装没带出厂预设;`corrupt` = 带了但坏了。两者必须分开说,否则都表现成空列表。; reason?: string | undefined; path: string; presets: ProjectInitPresetSummary[]; problems: string[] }"
 },
 {
  "method": "projectInit.preview",
  "channel": "projectInit:preview",
  "doc": "**只看不写**:对当前会话/项目算出模板会建/会跳哪些目录、文件、记忆(逐个查现有内容、拒符号链接),并给出 AI 生成说明文件的计划。返回里带 `digest` 供 apply 复核。",
  "input": "{ sessionId: string; command: string }",
  "inputFull": "{ sessionId: string; command: string }",
  "output": "{ templateId: string; name: string; revision: string; sessionId: string; projectId: string; projectName: string; root: string; digest: string; actions: ProjectInitAction[]; agentFile?: ProjectInitAgentPlan | undefined // 模板启用了 AI 生成说明文件时才有。 }"
 },
 {
  "method": "projectInit.save",
  "channel": "projectInit:save",
  "doc": "新建或更新一份模板。带 `id` 时**必须**同时带上原 `expectedRevision`,对不上就抛\"已改动\"(避免并发覆盖);新建受 200 份上限约束。返回存完的模板。",
  "input": "{ draft: { description: string; files: { path: string; content: string; }[]; name: string; directories: string[]; memories: { title: string; content: string; pinned: bo…; id?: string | undefined; expectedRevision?: string | undefined }",
  "inputFull": "{ draft: { description: string; files: { path: string; content: string; }[]; name: string; directories: string[]; memories: { title: string; content: string; pinned: bo…; id?: string | undefined; expectedRevision?: string | undefined }",
  "output": "{ id: string; revision: string; description: string; files: { path: string; content: string; }[]; name: string; directories: string[]; memories: { title: string; content: string; pinned: boolean; category: 'project' | 'rules' | 'preferences' | 'experiences' |…"
 },
 {
  "method": "projectInit.setDefault",
  "channel": "projectInit:setDefault",
  "doc": "设定裸 `/init` 预选的场景;`null` 清除。",
  "input": "{ id: string | null }",
  "inputFull": "{ id: string | null }",
  "output": "{ ok: true }"
 },
 {
  "method": "provider.commands",
  "channel": "provider:commands",
  "doc": "问引擎要**它自己的斜杠命令清单**（2026-09-21）。 ## 为什么不能只靠事件 清单的**权威来源**是引擎在每轮 `system/init` 里推的 `slash_commands` （见 `@contracts/runtime` 的 `CommandsAvailableEvent`）。但那条路有个致命的时机问题： init 只在**开跑一轮**时才来。而用户想打开 `/` 菜单看有哪些命令，恰恰是在 **还没发过消息**的时候 —— 也就是清单还空着的时候。 所以这一条把清单的获取**提前到会话建立…",
  "input": "{ providerId: string; cwd?: string | undefined }",
  "inputFull": "{ providerId: string; cwd?: string | undefined }",
  "output": "{ supported: boolean; commands: ProviderCommandEntry[] }"
 },
 {
  "method": "provider.healthCheck",
  "channel": "provider:healthCheck",
  "doc": "Probe the selected registered provider through its own health check.",
  "input": "{ providerId: string; force?: boolean | undefined // Bypass a completed cached result; an in-flight probe is still shared. }",
  "inputFull": "{ providerId: string; force?: boolean | undefined // Bypass a completed cached result; an in-flight probe is still shared. }",
  "output": "{ providerId: string; ok: boolean; code: ProviderHealthStatusCode; checkedAt: number; version?: string | undefined; error?: string | undefined }"
 },
 {
  "method": "provider.list",
  "channel": "provider:list",
  "doc": "列已注册的引擎后端(id / 显示名 / 能力描述符)。能力描述符驱动界面渲染哪些 composer 芯片与下拉项(声明式能力协商)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ providers: ProviderInfo[] }"
 },
 {
  "method": "publicMcp.addProjectLink",
  "channel": "publicMcp:addProjectLink",
  "doc": "给一个项目单独发一条公网链接(自己的密钥 + 自己的合成会话 + 沙箱 = 该项目目录)。 已经有了就原样返回。几条链接可同时被不同的 ChatGPT 对话使用,互不干扰。",
  "input": "{ projectId: string }",
  "inputFull": "{ projectId: string }",
  "output": "{ enabled: boolean // 总开关是否打开。关着时服务根本没起（`port` 为 0）。; port: number // 本机监听的端口；服务未起时为 0。真正的公网入口是用户自己那条隧道。; secret: string // 路径里那把密钥（`/mcp/<secret>`）。未生成时为空串。; sessionId: string | null // 「ChatGPT 直连」合成会话的 id；还没建时为 null。; tunnelUrl: string | null // 公网隧道的域名（形如…"
 },
 {
  "method": "publicMcp.regenerateProjectLinkSecret",
  "channel": "publicMcp:regenerateProjectLinkSecret",
  "doc": "换某个项目链接的密钥(旧链接立刻失效)。",
  "input": "{ projectId: string }",
  "inputFull": "{ projectId: string }",
  "output": "{ enabled: boolean // 总开关是否打开。关着时服务根本没起（`port` 为 0）。; port: number // 本机监听的端口；服务未起时为 0。真正的公网入口是用户自己那条隧道。; secret: string // 路径里那把密钥（`/mcp/<secret>`）。未生成时为空串。; sessionId: string | null // 「ChatGPT 直连」合成会话的 id；还没建时为 null。; tunnelUrl: string | null // 公网隧道的域名（形如…"
 },
 {
  "method": "publicMcp.regenerateSecret",
  "channel": "publicMcp:regenerateSecret",
  "doc": "换一把路径密钥（旧链接立刻失效）。这是用户唯一的\"拉闸\"手段。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ enabled: boolean // 总开关是否打开。关着时服务根本没起（`port` 为 0）。; port: number // 本机监听的端口；服务未起时为 0。真正的公网入口是用户自己那条隧道。; secret: string // 路径里那把密钥（`/mcp/<secret>`）。未生成时为空串。; sessionId: string | null // 「ChatGPT 直连」合成会话的 id；还没建时为 null。; tunnelUrl: string | null // 公网隧道的域名（形如…"
 },
 {
  "method": "publicMcp.removeProjectLink",
  "channel": "publicMcp:removeProjectLink",
  "doc": "删掉某个项目的公网链接(链接立刻失效;合成会话留着,记录不丢)。",
  "input": "{ projectId: string }",
  "inputFull": "{ projectId: string }",
  "output": "{ enabled: boolean // 总开关是否打开。关着时服务根本没起（`port` 为 0）。; port: number // 本机监听的端口；服务未起时为 0。真正的公网入口是用户自己那条隧道。; secret: string // 路径里那把密钥（`/mcp/<secret>`）。未生成时为空串。; sessionId: string | null // 「ChatGPT 直连」合成会话的 id；还没建时为 null。; tunnelUrl: string | null // 公网隧道的域名（形如…"
 },
 {
  "method": "publicMcp.setEnabled",
  "channel": "publicMcp:setEnabled",
  "doc": "开关这条公网通路。打开时现建「ChatGPT 直连」合成会话并起监听；关闭时停服务。 ⚠️ 打开 = 拿到链接的人拥有本机完全操作权（无审批闸门，见 publicMcpServer.ts）。",
  "input": "{ enabled: boolean }",
  "inputFull": "{ enabled: boolean }",
  "output": "{ enabled: boolean // 总开关是否打开。关着时服务根本没起（`port` 为 0）。; port: number // 本机监听的端口；服务未起时为 0。真正的公网入口是用户自己那条隧道。; secret: string // 路径里那把密钥（`/mcp/<secret>`）。未生成时为空串。; sessionId: string | null // 「ChatGPT 直连」合成会话的 id；还没建时为 null。; tunnelUrl: string | null // 公网隧道的域名（形如…"
 },
 {
  "method": "publicMcp.setProject",
  "channel": "publicMcp:setProject",
  "doc": "改沙箱目录 —— 公网进来的文件工具能碰哪个项目。传 null 取消选择。",
  "input": "{ projectId: string | null }",
  "inputFull": "{ projectId: string | null }",
  "output": "{ enabled: boolean // 总开关是否打开。关着时服务根本没起（`port` 为 0）。; port: number // 本机监听的端口；服务未起时为 0。真正的公网入口是用户自己那条隧道。; secret: string // 路径里那把密钥（`/mcp/<secret>`）。未生成时为空串。; sessionId: string | null // 「ChatGPT 直连」合成会话的 id；还没建时为 null。; tunnelUrl: string | null // 公网隧道的域名（形如…"
 },
 {
  "method": "publicMcp.setTunnelConfig",
  "channel": "publicMcp:setTunnelConfig",
  "doc": "存隧道配置(模式 / 自有域名 / Tunnel Token / 固定端口)。 token 留空 = 沿用已存的那串;返回的状态里**只带尾 4 位**。",
  "input": "{ mode: 'quick' | 'named' | 'external'; token?: string | undefined // named 必填。空串 = 不改动已存的那串(界面上留空表示\"沿用\")。; hostname?: string | undefined // named / external 必填:MCP 端点的公网域名,不带协议。; mobileHostname?: string | undefined // 可选:手机伴侣的公网域名。空 = 不暴露手机。; fixedPort?: number | undefined // 公网 MCP 服务的固定本机端口;0 = 随机。随机只适合 quick —— named / external 的 ingress 写死了端口,所以那两种模式下存 0 会被换成默…; clearToken?: boolean | undefined // 清掉已存的 Tunnel Token(`token` 留空只表示\"沿用\",没法表达\"删掉\")。; agentDelegate?: boolean | undefined }",
  "inputFull": "{ mode: 'quick' | 'named' | 'external'; token?: string | undefined // named 必填。空串 = 不改动已存的那串(界面上留空表示\"沿用\")。; hostname?: string | undefined // named / external 必填:MCP 端点的公网域名,不带协议。; mobileHostname?: string | undefined // 可选:手机伴侣的公网域名。空 = 不暴露手机。; fixedPort?: number | undefined // 公网 MCP 服务的固定本机端口;0 = 随机。随机只适合 quick —— named / external 的 ingress 写死了端口,所以那两种模式下存 0 会被换成默…; clearToken?: boolean | undefined // 清掉已存的 Tunnel Token(`token` 留空只表示\"沿用\",没法表达\"删掉\")。; agentDelegate?: boolean | undefined }",
  "output": "{ enabled: boolean // 总开关是否打开。关着时服务根本没起（`port` 为 0）。; port: number // 本机监听的端口；服务未起时为 0。真正的公网入口是用户自己那条隧道。; secret: string // 路径里那把密钥（`/mcp/<secret>`）。未生成时为空串。; sessionId: string | null // 「ChatGPT 直连」合成会话的 id；还没建时为 null。; tunnelUrl: string | null // 公网隧道的域名（形如…"
 },
 {
  "method": "publicMcp.startTunnel",
  "channel": "publicMcp:startTunnel",
  "doc": "起公网隧道（Mcode 自己 spawn cloudflared），成功后 `tunnelUrl` 带上域名。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ enabled: boolean // 总开关是否打开。关着时服务根本没起（`port` 为 0）。; port: number // 本机监听的端口；服务未起时为 0。真正的公网入口是用户自己那条隧道。; secret: string // 路径里那把密钥（`/mcp/<secret>`）。未生成时为空串。; sessionId: string | null // 「ChatGPT 直连」合成会话的 id；还没建时为 null。; tunnelUrl: string | null // 公网隧道的域名（形如…"
 },
 {
  "method": "publicMcp.status",
  "channel": "publicMcp:status",
  "doc": "公网 MCP 端点：把 mcode 的工具表暴露给互联网上的 MCP 客户端（ChatGPT 的 Connector）。只读快照，含路径密钥（明文，要显示给用户复制）。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ enabled: boolean // 总开关是否打开。关着时服务根本没起（`port` 为 0）。; port: number // 本机监听的端口；服务未起时为 0。真正的公网入口是用户自己那条隧道。; secret: string // 路径里那把密钥（`/mcp/<secret>`）。未生成时为空串。; sessionId: string | null // 「ChatGPT 直连」合成会话的 id；还没建时为 null。; tunnelUrl: string | null // 公网隧道的域名（形如…"
 },
 {
  "method": "publicMcp.stopTunnel",
  "channel": "publicMcp:stopTunnel",
  "doc": "停公网隧道（开关仍开着，只是不再对外暴露）。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ enabled: boolean // 总开关是否打开。关着时服务根本没起（`port` 为 0）。; port: number // 本机监听的端口；服务未起时为 0。真正的公网入口是用户自己那条隧道。; secret: string // 路径里那把密钥（`/mcp/<secret>`）。未生成时为空串。; sessionId: string | null // 「ChatGPT 直连」合成会话的 id；还没建时为 null。; tunnelUrl: string | null // 公网隧道的域名（形如…"
 },
 {
  "method": "relay.connect",
  "channel": "relay:connect",
  "doc": "Connect to the VPS: SSH + deploy forwarder + reverse tunnel.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "relay.disconnect",
  "channel": "relay:disconnect",
  "doc": "Disconnect from the VPS (forwarder keeps running on the VPS).",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ ok: true }"
 },
 {
  "method": "relay.getConfig",
  "channel": "relay:getConfig",
  "doc": "Read the saved VPS config (passwords included — main→renderer only).",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ config: RelayVpsConfig | null }"
 },
 {
  "method": "relay.saveConfig",
  "channel": "relay:saveConfig",
  "doc": "Save VPS connection config to settings (persisted across restarts).",
  "input": "{ username: string; password: string; host: string; sshPort: number; hostKeyFingerprint: string; publicPort: number; forwarder: 'auto' | 'socat' | 'python3'; privateKeyPath?: string | undefined }",
  "inputFull": "{ username: string; password: string; host: string; sshPort: number; hostKeyFingerprint: string; publicPort: number; forwarder: 'auto' | 'socat' | 'python3'; privateKeyPath?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "relay.status",
  "channel": "relay:status",
  "doc": "Read the current relay status.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ state: RelayState; endpoint: string | null // The public HTTP endpoint the phone should open (only when `connected`).; vpsHost: string | null // The VPS host (for UI display).; publicPort: number // The public port on the VPS.; error: string | null // Human…"
 },
 {
  "method": "rg.install",
  "channel": "rg:install",
  "doc": "Download + install the ripgrep binary into userData/bin (one-click).",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ ok: boolean; error?: string | undefined; path?: string | undefined // Path of the installed binary on success. }"
 },
 {
  "method": "rg.status",
  "channel": "rg:status",
  "doc": "ripgrep availability snapshot (drives the search-dialog install banner).",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ available: boolean // An `rg` binary is resolvable (bundled userData/bin checked first, then PATH).; path?: string | undefined // Resolved binary path when available.; installing: boolean // An install has been requested and is still running. }"
 },
 {
  "method": "runs.history",
  "channel": "runs:history",
  "doc": "某个对话的图运行历史(新的在前)。**从存档折出来**,只给轻量摘要 —— 见 `PersistedWorkflowRunLite`(整份快照不为一行列表过 IPC)。",
  "input": "{ sessionId: string; limit?: number | undefined // 最多几条。不给就用主进程的默认值。 }",
  "inputFull": "{ sessionId: string; limit?: number | undefined // 最多几条。不给就用主进程的默认值。 }",
  "output": "{ length: number // Gets or sets the length of the array.; toString: () => string // Returns a string representation of an array.; toLocaleString: { (): string; (locales: string | string[], options?: Intl.NumberFormatOptions & Intl.DateTimeFormatOptions): str…"
 },
 {
  "method": "runtimes.install",
  "channel": "runtimes:install",
  "doc": "Download + install (or update/reinstall) a runtime into userData/runtimes. Resolves when the install fully finished.",
  "input": "{ agent: 'claude' | 'codex' | 'pi' }",
  "inputFull": "{ agent: 'claude' | 'codex' | 'pi' }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "runtimes.installLocal",
  "channel": "runtimes:installLocal",
  "doc": "Install a runtime from a user-picked local path (install directory, binary, or .tgz). The version is taken from the package.json when available, else the expected version.",
  "input": "{ agent: 'claude' | 'codex' | 'pi'; localPath: string // Absolute local path (directory, binary, or .tgz). }",
  "inputFull": "{ agent: 'claude' | 'codex' | 'pi'; localPath: string // Absolute local path (directory, binary, or .tgz). }",
  "output": "{ ok: boolean; error?: string | undefined; version?: string | undefined }"
 },
 {
  "method": "runtimes.list",
  "channel": "runtimes:list",
  "doc": "List the claude/codex/pi runtimes: expected vs installed vs latest version, install state and disk footprint. `latestVersion` is fetched from the registry on each call (best-effort, null when offline).",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ runtimes: RuntimeAgentState[] }"
 },
 {
  "method": "runtimes.remove",
  "channel": "runtimes:remove",
  "doc": "Delete an installed runtime from disk. Rejected while any turn is running.",
  "input": "{ agent: 'claude' | 'codex' | 'pi' }",
  "inputFull": "{ agent: 'claude' | 'codex' | 'pi' }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "scene.apply",
  "channel": "scene:apply",
  "doc": "【ARC-002 / MC-058】**执行一次场景部署** —— 建部署记录 → 按计划拓扑序逐步派发到既有服务 → 逐步落盘 → 独立回读真实资源 → 验收。授权**不给内容、只给 id**,由宿主从 `GrantStore` 取回原始授权(含失效态)交 `policyEngine.evaluate` 判:非用户签发 / 已撤销 / 已过期 / 绑的是另一份计划 / 不在允许动作表 → 拒绝执行,连记录都不建。",
  "input": "{ deploymentId: string; grantId: string // 上一次 `scene.approve` 签出的授权 id。; actorKind: 'user' | 'system' | 'agent' // 谁发起的(结构化身份;渲染端只能声明「这是桌面用户点的」,宿主不复核它,判定看的是 grant)。; actorId: string; spec?: unknown; compensateOnFailure?: boolean | undefined // 某步失败时是否补偿(缺省由主进程定 = true)。 }",
  "inputFull": "{ deploymentId: string; grantId: string // 上一次 `scene.approve` 签出的授权 id。; actorKind: 'user' | 'system' | 'agent' // 谁发起的(结构化身份;渲染端只能声明「这是桌面用户点的」,宿主不复核它,判定看的是 grant)。; actorId: string; spec?: unknown; compensateOnFailure?: boolean | undefined // 某步失败时是否补偿(缺省由主进程定 = true)。 }",
  "output": "{ ok: false; kind: 'invalid'; problems: { path: string; message: string; }[] } | { ok: false; kind: 'refused'; code: string; reason: string } | { ok: true; kind: 'applied'; deployment: SceneDeploymentWire; readback: SceneReadbackWire }"
 },
 {
  "method": "scene.approve",
  "channel": "scene:approve",
  "doc": "【ARC-002 / MC-058】**用户签发计划级授权** —— 用户在渲染端看过 dry-run 之后点「批准」的落点。宿主重编译拿到真实计划 digest,与调用方递进来的 `planDigest` **对账**(不一致 = 批准的那份与要跑的那份不是同一份 → 拒签),再用 `GrantStore.issueGrant` 签一枚绑定该计划 digest 的授权。**只有桌面渲染端够得到它** —— agent 侧 null 掉(批准主体必须是用户本人)。",
  "input": "{ deploymentId: string // 一次部署的稳定 id(重试是同一 id 的覆盖,不是新部署)。; planDigest: string // 用户在预览里看到的**计划摘要**。宿主会拿它与重编译结果对账 —— 不一致 = 「批准的那份」 与「要跑的那份」不是同一份,拒绝签发(不静默按新计划发一份授权,那是偷换审批对象…; ttlMs: number // 授权有效期的毫秒数(调用方给;`issueGrant` 只拒非正数,具体上限由宿主策略定)。; spec?: unknown // 一份**候选** SceneSpec(与 `scene.plan` 收到的是同一份;执行前会重新校验重编译)。 }",
  "inputFull": "{ deploymentId: string // 一次部署的稳定 id(重试是同一 id 的覆盖,不是新部署)。; planDigest: string // 用户在预览里看到的**计划摘要**。宿主会拿它与重编译结果对账 —— 不一致 = 「批准的那份」 与「要跑的那份」不是同一份,拒绝签发(不静默按新计划发一份授权,那是偷换审批对象…; ttlMs: number // 授权有效期的毫秒数(调用方给;`issueGrant` 只拒非正数,具体上限由宿主策略定)。; spec?: unknown // 一份**候选** SceneSpec(与 `scene.plan` 收到的是同一份;执行前会重新校验重编译)。 }",
  "output": "{ ok: true; kind: 'granted'; grantId: string; expiresAt: number } | { ok: false; kind: 'refused'; reason: string } | { ok: false; kind: 'invalid'; problems: { path: string; message: string; }[] }"
 },
 {
  "method": "scene.listDeployments",
  "channel": "scene:listDeployments",
  "doc": "【MC-002】**列出某个场景已落盘的部署记录**(重启后发现未完成部署的唯一读通道)。**只读**,不执行任何步骤。`deploymentId` 只活在渲染端内存里,重启后没有这条通道用户就永远看不到盘上那份 `partial/failed`。`resumable` 只是\"状态上还能接着跑\"的只读推导,**不是授权** —— 真正续跑仍要用户重新预览 + 批准(`scene.approve`),旧 grant 可能已过期。**只有桌面渲染端够得到它**(agent 侧 blocked,手机端 unsuppor…",
  "input": "{ limit?: number | undefined // 最多列多少条(宿主有上限;默认 20)。; sceneId?: string | undefined // 【MC-002】**省略 = 跨场景列最近的部署**。; resumableOnly?: boolean | undefined // 只看还能续跑的(状态 partial/failed 且存档读得回来)。默认 false。 }",
  "inputFull": "{ limit?: number | undefined // 最多列多少条(宿主有上限;默认 20)。; sceneId?: string | undefined // 【MC-002】**省略 = 跨场景列最近的部署**。; resumableOnly?: boolean | undefined // 只看还能续跑的(状态 partial/failed 且存档读得回来)。默认 false。 }",
  "output": "{ ok: true; deployments: SceneDeploymentListEntryWire[] } | { ok: false; reason: string }"
 },
 {
  "method": "scene.plan",
  "channel": "scene:plan",
  "doc": "【ARC-002 / MC-058】**只读**的场景规划:给一份候选 SceneSpec,校验(一次报全)通过则编译出有序变更计划(拓扑排序 + 稳定 digest)。**不建任何资源、不申请授权** —— 模型提出计划 ≠ 获得执行权限;真正的部署是另一条命令且需独立计划级授权。",
  "input": "{ spec?: unknown }",
  "inputFull": "{ spec?: unknown }",
  "output": "{ ok: false; problems: { path: string; message: string; }[] } | { ok: true; plan: ScenePlanWire }"
 },
 {
  "method": "scene.preflight",
  "channel": "scene:preflight",
  "doc": "【ARC-002 / MC-058】**只读**的场景预检:校验(一次报全)+ 编译 + **能力预检**(声明的能力在本机在不在、对这个引擎适不适用)。必需能力缺了 `preflight.ok=false`(部署该被挡住);可选能力缺了进 `gaps` 但不挡。不建资源、不装插件、不申请授权。",
  "input": "{ spec?: unknown }",
  "inputFull": "{ spec?: unknown }",
  "output": "{ ok: false; problems: { path: string; message: string; }[] } | { ok: true; plan: ScenePlanWire; preflight: ScenePreflightWire }"
 },
 {
  "method": "scene.resume",
  "channel": "scene:resume",
  "doc": "【MC-002】**续跑一次中断的场景部署** —— 与 `scene.apply` 同形(同一份 spec、同一枚计划级授权、同一条执行核 `runPlanSteps`),语义是**跳过盘上记录里已 done 的步骤、从断点接着跑**。判定核不因「是 resume」放宽(与 apply 逐字同源)。盘上读不到那条 `deploymentId` 的部分执行记录 → 明确拒绝(绝不静默当成新部署去建资源)。**只有桌面渲染端够得到它** —— agent 侧 `policyFor` 判 blocked(与 appl…",
  "input": "{ deploymentId: string; grantId: string // 上一次 `scene.approve` 签出的授权 id。; actorKind: 'user' | 'system' | 'agent' // 谁发起的(结构化身份;渲染端只能声明「这是桌面用户点的」,宿主不复核它,判定看的是 grant)。; actorId: string; spec?: unknown; compensateOnFailure?: boolean | undefined // 某步失败时是否补偿(缺省由主进程定 = true)。 }",
  "inputFull": "{ deploymentId: string; grantId: string // 上一次 `scene.approve` 签出的授权 id。; actorKind: 'user' | 'system' | 'agent' // 谁发起的(结构化身份;渲染端只能声明「这是桌面用户点的」,宿主不复核它,判定看的是 grant)。; actorId: string; spec?: unknown; compensateOnFailure?: boolean | undefined // 某步失败时是否补偿(缺省由主进程定 = true)。 }",
  "output": "{ ok: false; kind: 'invalid'; problems: { path: string; message: string; }[] } | { ok: false; kind: 'refused'; code: string; reason: string } | { ok: true; kind: 'applied'; deployment: SceneDeploymentWire; readback: SceneReadbackWire }"
 },
 {
  "method": "session.archive",
  "channel": "session:archive",
  "doc": "Set a session's archived flag (soft-delete; restorable).",
  "input": "{ id: string; archived: boolean }",
  "inputFull": "{ id: string; archived: boolean }",
  "output": "{ session: Session }"
 },
 {
  "method": "session.delete",
  "channel": "session:delete",
  "doc": "Hard-delete a session; its messages cascade-delete (DB FK).",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "void"
 },
 {
  "method": "session.fork",
  "channel": "session:fork",
  "doc": "把一段对话复制成新的一段:上下文原样带过去,两边之后各走各的。",
  "input": "{ id: string; title: string }",
  "inputFull": "{ id: string; title: string }",
  "output": "{ session: Session }"
 },
 {
  "method": "session.hasNodes",
  "channel": "session:hasNodes",
  "doc": "这个对话里**有没有一格留下过会话** —— 看板据它决定摆不摆\"接着说\"那个入口(当一个是非题问,免了列整行节点会话)。",
  "input": "{ sessionId: string }",
  "inputFull": "{ sessionId: string }",
  "output": "{ has: boolean }"
 },
 {
  "method": "session.listAll",
  "channel": "session:listAll",
  "doc": "Cross-project non-archived sessions, newest-first (stream sidebar) — 跨项目、排除已归档、排除置顶。**给 agent 时**:每行是完整 `Session`(含 `turnFiles` / `usageHistory` / `subagents` 等\"整份内容\"级字段),`app_api_call` 会把它们摘成计数,别拿这条去逐条读内容;要挑对话用 `mcode-* session_list`(只标题/id/时间,按项目分组)。",
  "input": "{ limit?: number | undefined; offset?: number | undefined; projectIds?: string[] | undefined // Project scope: only rows whose project_id is in this list.; worktreeKey?: string | undefined // Worktree-checkout scope: only sessions bound to that isolated checkout, as a normalized p… }",
  "inputFull": "{ limit?: number | undefined; offset?: number | undefined; projectIds?: string[] | undefined // Project scope: only rows whose project_id is in this list.; worktreeKey?: string | undefined // Worktree-checkout scope: only sessions bound to that isolated checkout, as a normalized p… }",
  "output": "{ sessions: Session[]; hasMore: boolean; total: number }"
 },
 {
  "method": "session.listNodes",
  "channel": "session:listNodes",
  "doc": "The workflow-node sessions of ONE conversation — \"which step has a session, and what is it called\". Read-only, and the only way a node session is ever listed: every other query pins `kind = 'chat'`. Why it exists: a node session is where a step's history live…",
  "input": "{ sessionId: string // The conversation whose graph spawned them (they hang off it as `parentSessionId`). }",
  "inputFull": "{ sessionId: string // The conversation whose graph spawned them (they hang off it as `parentSessionId`). }",
  "output": "{ sessions: Session[] }"
 },
 {
  "method": "session.listPinned",
  "channel": "session:listPinned",
  "doc": "All pinned non-archived sessions across projects (most recent pin first) — powers the left bar's global pinned section above the project tree.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ sessions: Session[] }"
 },
 {
  "method": "session.messages",
  "channel": "session:messages",
  "doc": "读一段对话的消息,`(createdAt,id)` 游标分页(翻页传最旧一条的 time+id)。**省略 limit 走旧的\"全量、升序\"路**(`hasMore` 恒 false)。",
  "input": "{ sessionId: string; limit?: number | undefined // Page size.; beforeCreatedAt?: number | undefined // Cursor: fetch the page strictly older than this (createdAt, id) pair.; beforeId?: string | undefined }",
  "inputFull": "{ sessionId: string; limit?: number | undefined // Page size.; beforeCreatedAt?: number | undefined // Cursor: fetch the page strictly older than this (createdAt, id) pair.; beforeId?: string | undefined }",
  "output": "{ messages: MessageRecord[]; hasMore: boolean }"
 },
 {
  "method": "session.pin",
  "channel": "session:pin",
  "doc": "Pin/unpin a session (project-scoped). Returns the updated row.",
  "input": "{ id: string; pinned: boolean }",
  "inputFull": "{ id: string; pinned: boolean }",
  "output": "{ session: Session }"
 },
 {
  "method": "session.rename",
  "channel": "session:rename",
  "doc": "Rename a session (persist a user-edited title). Returns the updated row.",
  "input": "{ id: string; title: string }",
  "inputFull": "{ id: string; title: string }",
  "output": "{ session: Session }"
 },
 {
  "method": "session.saveMessages",
  "channel": "session:saveMessages",
  "doc": "**直接改写聊天记录的底层存储**:用这份全量快照**整体替换**该会话的消息(先 DELETE 再 INSERT,一个事务)。渲染端在一轮结束/出错时发的是\"当前完整视图\"。",
  "input": "{ sessionId: string; messages: MessageRecord[] }",
  "inputFull": "{ sessionId: string; messages: MessageRecord[] }",
  "output": "void"
 },
 {
  "method": "session.search",
  "channel": "session:search",
  "doc": "Cross-project session search by title substring (Ctrl+K unified search).",
  "input": "{ query: string; limit?: number | undefined }",
  "inputFull": "{ query: string; limit?: number | undefined }",
  "output": "{ sessions: Session[] }"
 },
 {
  "method": "session.searchBookmarks",
  "channel": "session:searchBookmarks",
  "doc": "Cross-session bookmark search (Ctrl+K unified search).",
  "input": "{ query: string; limit?: number | undefined }",
  "inputFull": "{ query: string; limit?: number | undefined }",
  "output": "{ results: BookmarkSearchResult[] }"
 },
 {
  "method": "session.truncateAndInsertMessages",
  "channel": "session:truncateAndInsertMessages",
  "doc": "编辑重发:删掉游标 `(cursorCreatedAt,cursorId)` **及其之后**的全部消息,再插入替换行(一个事务)。分页安全 —— 渲染端内存里没加载的更老的行不会被抹掉。",
  "input": "{ sessionId: string; cursorCreatedAt: number; cursorId: string; messages: MessageRecord[] }",
  "inputFull": "{ sessionId: string; cursorCreatedAt: number; cursorId: string; messages: MessageRecord[] }",
  "output": "void"
 },
 {
  "method": "session.updateBookmarks",
  "channel": "session:updateBookmarks",
  "doc": "Replace a session's bookmark list (full-array write). Returns the updated row.",
  "input": "{ id: string; bookmarks: { id: string; createdAt: number; messageId: string; excerpt: string; role: 'user' | 'assistant'; title?: string | null | undefined; }[] }",
  "inputFull": "{ id: string; bookmarks: { id: string; createdAt: number; messageId: string; excerpt: string; role: 'user' | 'assistant'; title?: string | null | undefined; }[] }",
  "output": "{ session: Session }"
 },
 {
  "method": "session.updateSettings",
  "channel": "session:updateSettings",
  "doc": "Update the active session's model / effort / permissionMode / customModelId in-place.",
  "input": "{ sessionId: string; projectId?: string | undefined // Directory re-aim (new-session panel's directory switcher): move a FRESH local session to …; providerId?: string | undefined // Provider id (e.g.; model?: string | undefined; effort?: string | undefined; permissionMode?: string | undefined; customModelId?: string | null | undefined; envMode?: 'local' | 'worktree' | undefined // Working-environment intent flip (composer chip).; wtStyle?: 'detached' | 'branch' | null | undefined // Worktree FORM flip (composer chip) — same un-materialized-only contract as envMode.; workflowId?: string | undefined; composerMode?: string | undefined // 旧字段名,接受一个版本 —— 理由见上面 SendTurnSchema 那段。 }",
  "inputFull": "{ sessionId: string; projectId?: string | undefined // Directory re-aim (new-session panel's directory switcher): move a FRESH local session to …; providerId?: string | undefined // Provider id (e.g.; model?: string | undefined; effort?: string | undefined; permissionMode?: string | undefined; customModelId?: string | null | undefined; envMode?: 'local' | 'worktree' | undefined // Working-environment intent flip (composer chip).; wtStyle?: 'detached' | 'branch' | null | undefined // Worktree FORM flip (composer chip) — same un-materialized-only contract as envMode.; workflowId?: string | undefined; composerMode?: string | undefined // 旧字段名,接受一个版本 —— 理由见上面 SendTurnSchema 那段。 }",
  "output": "void"
 },
 {
  "method": "session.upsertMessages",
  "channel": "session:upsertMessages",
  "doc": "按 id **upsert 增量**落库,会话的其他行不动。零星改动用它,别用 `saveMessages` 那种 O(N) 的全量替换。",
  "input": "{ sessionId: string; messages: MessageRecord[] }",
  "inputFull": "{ sessionId: string; messages: MessageRecord[] }",
  "output": "void"
 },
 {
  "method": "setting.exportToFile",
  "channel": "setting:exportToFile",
  "doc": "导出设置到 JSON 文件(主进程弹保存框;不含密钥与本机状态)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ ok: true; path: string; count: number; skipped: number; scrubbed: number } | { ok: false; canceled?: boolean | undefined; error?: string | undefined }"
 },
 {
  "method": "setting.exportToPath",
  "channel": "setting:exportToPath",
  "doc": "【MC-026】导出到**显式路径**(Agent 可编排;不弹系统保存框)。清洗与界面导出同一份; 审批走宿主的 danger 卡。",
  "input": "{ path: string // 绝对路径。必须是 .json;父目录必须存在(不替调用方递归建目录 —— 打错路径要显式报)。 }",
  "inputFull": "{ path: string // 绝对路径。必须是 .json;父目录必须存在(不替调用方递归建目录 —— 打错路径要显式报)。 }",
  "output": "{ ok: true; path: string; count: number; skipped: number; scrubbed: number } | { ok: false; canceled?: boolean | undefined; error?: string | undefined }"
 },
 {
  "method": "setting.get",
  "channel": "setting:get",
  "doc": "读一个设置键,**没有返回 `null`**(不是空串)。注意:`mcp.management` 等密钥设置键本体不许经这条直读,会被 appControl 的 `secretSettingRefusal` 拦。",
  "input": "{ key: string }",
  "inputFull": "{ key: string }",
  "output": "{ value: string | null }"
 },
 {
  "method": "setting.getMany",
  "channel": "setting:getMany",
  "doc": "一次读多个键,**一趟 IPC 顶 N 次 `setting.get`**;缺的键各自映成 `null`。",
  "input": "{ keys: string[] }",
  "inputFull": "{ keys: string[] }",
  "output": "GetManySettingsResult"
 },
 {
  "method": "setting.importFromFile",
  "channel": "setting:importFromFile",
  "doc": "从 JSON 文件导入设置(主进程弹打开框;先备份当前设置)。",
  "input": "undefined | { mode?: 'merge' | 'restore' | undefined }",
  "inputFull": "undefined | { mode?: 'merge' | 'restore' | undefined }",
  "output": "{ ok: true; count: number; skipped: number; deleted?: number | undefined; backupPath?: string | undefined } | { ok: false; canceled?: boolean | undefined; error?: string | undefined }"
 },
 {
  "method": "setting.importFromText",
  "channel": "setting:importFromText",
  "doc": "【MC-026】从**JSON 文本**导入(Agent 可编排;不弹系统打开框)。解析/清洗/导入前备份/ 整批事务与界面导入同一份。",
  "input": "{ text: string // 导出档的 JSON 文本(与 `setting.exportToPath` 写出的格式相同)。; mode?: 'merge' | 'restore' | undefined // 与界面导入相同的两种模式(见上)。 }",
  "inputFull": "{ text: string // 导出档的 JSON 文本(与 `setting.exportToPath` 写出的格式相同)。; mode?: 'merge' | 'restore' | undefined // 与界面导入相同的两种模式(见上)。 }",
  "output": "{ ok: true; count: number; skipped: number; deleted?: number | undefined; backupPath?: string | undefined } | { ok: false; canceled?: boolean | undefined; error?: string | undefined }"
 },
 {
  "method": "setting.set",
  "channel": "setting:set",
  "doc": "**持久化**写一个设置键(upsert 进 settings 表并落盘)。写完对\"跟着人走\"的键(语言、强调色…)**广播给已配对的手机**当场生效;主题样式键还会顺手刷新原生标题栏。",
  "input": "{ value: string; key: string }",
  "inputFull": "{ value: string; key: string }",
  "output": "void"
 },
 {
  "method": "shell.openFile",
  "channel": "shell:openFile",
  "doc": "Open a file with the OS's default associated application. Accepts any path that resolves inside a known project root (not just the root).",
  "input": "{ path: string }",
  "inputFull": "{ path: string }",
  "output": "{ ok: boolean; error?: string | undefined // 失败原因(用户可读中文);成功时不带。 }"
 },
 {
  "method": "shell.openPath",
  "channel": "shell:openPath",
  "doc": "Open a path in the OS file manager. Main refuses any path that isn't a known project root, so this can't be used to open arbitrary locations.",
  "input": "{ path: string }",
  "inputFull": "{ path: string }",
  "output": "{ ok: boolean; error?: string | undefined // 失败原因(用户可读中文);成功时不带。 }"
 },
 {
  "method": "shell.showItemInFolder",
  "channel": "shell:showItemInFolder",
  "doc": "Reveal a file or directory in the OS file manager, selecting it. Accepts any path that resolves inside a known project root (not just the root).",
  "input": "{ path: string }",
  "inputFull": "{ path: string }",
  "output": "{ ok: boolean; error?: string | undefined // 失败原因(用户可读中文);成功时不带。 }"
 },
 {
  "method": "skills.bundles",
  "channel": "skills:bundles",
  "doc": "Read the bundle manifest (import groups of the universal library). Missing manifest → empty list; a corrupt one still lists empty but carries `corrupt` (and import/market-install refuse to rewrite it, MC-053 family).",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ bundles: SkillBundle[]; corrupt?: { reason: string; } | undefined }"
 },
 {
  "method": "skills.copyToProject",
  "channel": "skills:copyToProject",
  "doc": "**把技能从通用库复制到项目**（`<项目>/.claude/skills/`）。批量，逐条回报 结果 —— 单个失败（重名 / 读不到源）不影响其余的。",
  "input": "{ projectPath: string // 项目根目录（绝对路径）。没有它就没有\"项目\"可言。; names: string[] // 要复制的逻辑技能名（由宿主解析实际目录）。 }",
  "inputFull": "{ projectPath: string // 项目根目录（绝对路径）。没有它就没有\"项目\"可言。; names: string[] // 要复制的逻辑技能名（由宿主解析实际目录）。 }",
  "output": "{ copied: string[] // 真的复制过去的技能名。; skipped: { name: string; reason: string; }[] // 目标已有同名目录、按\"不覆盖\"处理而跳过的。; failed: { name: string; reason: string; }[] // 失败的（读不到源、写不进去）。 }"
 },
 {
  "method": "skills.delete",
  "channel": "skills:delete",
  "doc": "Delete a skill directory (symlink → unlink link only; real dir → recursive remove). Returns ok:false + error on any IO failure.",
  "input": "{ source: 'global' | 'project'; name: string; projectPath?: string | undefined }",
  "inputFull": "{ source: 'global' | 'project'; name: string; projectPath?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "skills.engines.set",
  "channel": "skills:enginesSet",
  "doc": "Set one universal skill's per-engine availability (claude/codex/pi). Returns the resolved state as persisted (or ok:false + error).",
  "input": "{ name: string; claude: boolean; codex: boolean; pi: boolean }",
  "inputFull": "{ name: string; claude: boolean; codex: boolean; pi: boolean }",
  "output": "{ ok: boolean; error?: string | undefined; perEngine?: SkillEngineState | undefined }"
 },
 {
  "method": "skills.enginesSetBulk",
  "channel": "skills:enginesSetBulk",
  "doc": "Set the per-engine availability for many skills at once (group-level switch). Returns per-name resolved state (or ok:false + error).",
  "input": "{ names: string[]; claude: boolean; codex: boolean; pi: boolean }",
  "inputFull": "{ names: string[]; claude: boolean; codex: boolean; pi: boolean }",
  "output": "{ ok: boolean; error?: string | undefined; perEngine?: Record<string, SkillEngineState> | undefined }"
 },
 {
  "method": "skills.import",
  "channel": "skills:import",
  "doc": "Import (copy) selected skills from external tool directories into ~/.mcode/skills. Already-existing skills are skipped. Returns per-skill imported / skipped / error lists.",
  "input": "{ skills: { name: string; sourcePath: string; }[] }",
  "inputFull": "{ skills: { name: string; sourcePath: string; }[] }",
  "output": "{ imported: string[]; skipped: string[]; errors: { name: string; error: string; }[] }"
 },
 {
  "method": "skills.importGithub",
  "channel": "skills:importGithub",
  "doc": "Import a whole skill package from a GitHub repo URL — shallow-clone, discover every SKILL.md, copy each skill in, and group them all under one bundle. Returns the bundle + per-skill lists.",
  "input": "{ url: string // GitHub repository URL. }",
  "inputFull": "{ url: string // GitHub repository URL. }",
  "output": "{ ok: boolean; error?: string | undefined // Human-readable failure reason when ok is false (URL parse, clone failure, no SKILL.md fou…; imported: string[]; skipped: string[]; errors: { name: string; error: string; }[]; bundleId?: string | undefined // The bu…"
 },
 {
  "method": "skills.list",
  "channel": "skills:list",
  "doc": "Discover skills for the composer `/` menu. Scans the user-global `~/.mcode/skills/` universal library and parses each SKILL.md's frontmatter. Always resolves (degrades to an empty list on any IO error). `projectPath` is accepted but ignored (single-scope sinc…",
  "input": "{ projectPath?: string | undefined }",
  "inputFull": "{ projectPath?: string | undefined }",
  "output": "{ skills: SkillInfo[]; enginesMatrixStatus?: EnginesMatrixStatus | undefined }"
 },
 {
  "method": "skills.marketAdd",
  "channel": "skills:marketAdd",
  "doc": "Add a skill market (git URL / owner/repo / local directory) — fetches it.",
  "input": "{ kind: 'local' | 'git'; ref: string // GitHub `owner/repo`, any git URL, or an absolute local directory.; requestId?: string | undefined; name?: string | undefined }",
  "inputFull": "{ kind: 'local' | 'git'; ref: string // GitHub `owner/repo`, any git URL, or an absolute local directory.; requestId?: string | undefined; name?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined; name?: string | undefined; corrupt?: boolean | undefined }"
 },
 {
  "method": "skills.marketInstall",
  "channel": "skills:marketInstall",
  "doc": "Copy market skills into the universal library (existing names skipped). 【MC-053 同族】导入包清单损坏时安装照常成功，但结果带 `corrupt` —— 清单未被改写。",
  "input": "{ names: string[]; market: string; requestId?: string | undefined }",
  "inputFull": "{ names: string[]; market: string; requestId?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined; imported: string[]; skipped: string[]; errors: { name: string; error: string; }[]; corrupt?: string | undefined // 【MC-053 同族】导入包清单读不懂时的原因。有值 = 安装照常成功,但这次**没有** 改写清单(否则会把用户历史导入包整份抹掉)。 }"
 },
 {
  "method": "skills.marketList",
  "channel": "skills:marketList",
  "doc": "Skill market: catalogs (built-in + user added) with their entries. 【MC-037】`corrupt` 有值 = 用户记录读不出来(列表只含内置市场,写入被拒)—— 界面必须把\"没有自定义来源\"与\"记录损坏\"分开说。",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ markets: SkillMarketState[]; corrupt?: { reason: string; } | undefined }"
 },
 {
  "method": "skills.marketRefresh",
  "channel": "skills:marketRefresh",
  "doc": "Re-fetch one market's catalog (network).",
  "input": "{ name: string; requestId?: string | undefined }",
  "inputFull": "{ name: string; requestId?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined; corrupt?: boolean | undefined }"
 },
 {
  "method": "skills.marketRemove",
  "channel": "skills:marketRemove",
  "doc": "Remove a user-added skill market (built-ins cannot be removed).",
  "input": "{ name: string; requestId?: string | undefined }",
  "inputFull": "{ name: string; requestId?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined; corrupt?: boolean | undefined }"
 },
 {
  "method": "skills.presetsDelete",
  "channel": "skills:presetsDelete",
  "doc": "删一套预设。清单损坏 → `ok:false` + `corrupt:true`，原文件不动。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean; error?: string | undefined; corrupt?: boolean | undefined }"
 },
 {
  "method": "skills.presetsList",
  "channel": "skills:presetsList",
  "doc": "**一套技能预设** —— \"这类项目默认装这几个\"。改整个数组（整份给过来， 局部更新在这里没有意义，同 `workflow.agentProfiles` 的取舍）。 【MC-053 同族】清单文件损坏时仍给空表（页面可打开），但带 `corrupt` 诊断 —— 保存/删除在损坏时被拒（不会拿空表当写回基准抹掉已有预设）。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ presets: SkillPreset[]; corrupt?: { reason: string; } | undefined }"
 },
 {
  "method": "skills.presetsSave",
  "channel": "skills:presetsSave",
  "doc": "存一套预设（新建或覆盖同 id 的）。清单损坏 → `ok:false` + `corrupt:true`，原文件不动。",
  "input": "{ preset: { id: string; skills: string[]; name: string; description?: string | undefined; } }",
  "inputFull": "{ preset: { id: string; skills: string[]; name: string; description?: string | undefined; } }",
  "output": "{ ok: boolean; error?: string | undefined; corrupt?: boolean | undefined }"
 },
 {
  "method": "skills.projectOverview",
  "channel": "skills:projectOverview",
  "doc": "**跨项目总览** —— 每个项目各装了哪些技能。`projectIds` 省略 = 全部项目。",
  "input": "{ projectIds?: string[] | undefined }",
  "inputFull": "{ projectIds?: string[] | undefined }",
  "output": "{ rows: ProjectSkillRow[]; problems: { projectId: string; projectName: string; error: string; }[] // 扫不动的那几个（目录没权限、路径没了），单独回报而不是静默跳过。 }"
 },
 {
  "method": "skills.read",
  "channel": "skills:read",
  "doc": "Read one skill's full SKILL.md source (no truncation). Missing file → empty content.",
  "input": "{ source: 'global' | 'project' | 'plugin' | 'builtin' // Which skills root to read from.; name: string // Discovered logical name (frontmatter name or directory fallback).; projectPath?: string | undefined }",
  "inputFull": "{ source: 'global' | 'project' | 'plugin' | 'builtin' // Which skills root to read from.; name: string // Discovered logical name (frontmatter name or directory fallback).; projectPath?: string | undefined }",
  "output": "{ content: string }"
 },
 {
  "method": "skills.save",
  "channel": "skills:save",
  "doc": "Create or overwrite a skill's SKILL.md (full content write; creates the skill directory if absent). Returns ok:false + error on any IO failure.",
  "input": "{ source: 'global' | 'project'; content: string // Full SKILL.md text (frontmatter + body).; name: string; projectPath?: string | undefined; newName?: string | undefined }",
  "inputFull": "{ source: 'global' | 'project'; content: string // Full SKILL.md text (frontmatter + body).; name: string; projectPath?: string | undefined; newName?: string | undefined }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "skills.scanSources",
  "channel": "skills:scanSources",
  "doc": "Scan external tools (Claude Code / Codex / Zcode) for skills available for import into Mcode's own ~/.mcode/skills. Returns the full list of discoverable skills with their source paths.",
  "input": "{ localDir?: string | undefined // Optional: a user-picked local directory to scan in addition to the fixed external tool di…; localFile?: string | undefined // Optional: a user-picked single skill file (.md/.markdown) to import as a one-file skill. }",
  "inputFull": "{ localDir?: string | undefined // Optional: a user-picked local directory to scan in addition to the fixed external tool di…; localFile?: string | undefined // Optional: a user-picked single skill file (.md/.markdown) to import as a one-file skill. }",
  "output": "{ sources: ExternalSkillInfo[] }"
 },
 {
  "method": "terminal.create",
  "channel": "terminal:create",
  "doc": "Spawn a PTY in the project cwd (or a subdir).",
  "input": "{ projectPath: string; cwd?: string | undefined // Optional working directory; must resolve inside projectPath.; cols?: number | undefined; rows?: number | undefined; shell?: string | undefined // Optional shell override for this session only.; origin?: { kind: 'user'; } | { kind: 'session'; sessionId: string; title?: string | undefined; nodeSessionId?: string | undefined; } | undefined // 谁开的。**可选** —— 不传 = 用户手点的(`{ kind: \"user\" }`),所以既有的 调用方一行都不用改,而界面上那一条照样说得出来历。 }",
  "inputFull": "{ projectPath: string; cwd?: string | undefined // Optional working directory; must resolve inside projectPath.; cols?: number | undefined; rows?: number | undefined; shell?: string | undefined // Optional shell override for this session only.; origin?: { kind: 'user'; } | { kind: 'session'; sessionId: string; title?: string | undefined; nodeSessionId?: string | undefined; } | undefined // 谁开的。**可选** —— 不传 = 用户手点的(`{ kind: \"user\" }`),所以既有的 调用方一行都不用改,而界面上那一条照样说得出来历。 }",
  "output": "{ ok: true; terminalId: string; pid: number; cwd: string; shell: string } | { ok: false; error: string }"
 },
 {
  "method": "terminal.kill",
  "channel": "terminal:kill",
  "doc": "Kill a PTY process and drop it from the manager.",
  "input": "{ terminalId: string }",
  "inputFull": "{ terminalId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "terminal.list",
  "channel": "terminal:list",
  "doc": "List live terminals, optionally filtered by project.",
  "input": "{ projectPath?: string | undefined // When set, only terminals bound to this project root are returned.; bufferFor?: string | undefined // 要**顺带把输出尾巴带回来**的那一条终端 id(见 {@link TerminalInfo.buffer})。 }",
  "inputFull": "{ projectPath?: string | undefined // When set, only terminals bound to this project root are returned.; bufferFor?: string | undefined // 要**顺带把输出尾巴带回来**的那一条终端 id(见 {@link TerminalInfo.buffer})。 }",
  "output": "{ terminals: TerminalInfo[] }"
 },
 {
  "method": "terminal.resize",
  "channel": "terminal:resize",
  "doc": "Notify the PTY of a cols/rows change (after xterm fit).",
  "input": "{ cols: number; rows: number; terminalId: string }",
  "inputFull": "{ cols: number; rows: number; terminalId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "terminal.write",
  "channel": "terminal:write",
  "doc": "Write raw input bytes/text to a live PTY.",
  "input": "{ data: string; terminalId: string }",
  "inputFull": "{ data: string; terminalId: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "theme.get",
  "channel": "theme:get",
  "doc": "返回**存下的偏好** `theme` 与**当前实际生效**的 `effective`(跟随系统时两者可能不同)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ theme: ThemeName; effective: EffectiveTheme }"
 },
 {
  "method": "theme.set",
  "channel": "theme:set",
  "doc": "持久化主题偏好并**立刻应用**(驱动 Electron nativeTheme → Chromium 的 prefers-color-scheme)。",
  "input": "{ theme: 'dark' | 'light' | 'system' }",
  "inputFull": "{ theme: 'dark' | 'light' | 'system' }",
  "output": "{ theme: ThemeName; effective: EffectiveTheme }"
 },
 {
  "method": "toolchain.check",
  "channel": "toolchain:check",
  "doc": "检测本机工具链:pandoc / python 包 / TeX / zip 各自找到没有、什么版本、 在哪。安装或卸载后重新调它即可刷新面板。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ tools: ToolchainToolState[] }"
 },
 {
  "method": "toolchain.install",
  "channel": "toolchain:install",
  "doc": "安装一个应用能管的工具(pandoc 由应用下载;python-deps 走用户解释器的 pip)。进度走 `toolchain:event`。",
  "input": "{ tool: 'pandoc' | 'latex' | 'python-deps' | 'zip-tools' | 'soffice' | 'pdftoppm' | 'onlyoffice' }",
  "inputFull": "{ tool: 'pandoc' | 'latex' | 'python-deps' | 'zip-tools' | 'soffice' | 'pdftoppm' | 'onlyoffice' }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "toolchain.remove",
  "channel": "toolchain:remove",
  "doc": "删掉应用管理的那份(只对 managed 有效;用户自己装的 system 那份不动)。",
  "input": "{ tool: 'pandoc' | 'latex' | 'python-deps' | 'zip-tools' | 'soffice' | 'pdftoppm' | 'onlyoffice' }",
  "inputFull": "{ tool: 'pandoc' | 'latex' | 'python-deps' | 'zip-tools' | 'soffice' | 'pdftoppm' | 'onlyoffice' }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "tools.usage",
  "channel": "tools:usage",
  "doc": "Static per-tool context-usage estimate for one engine.",
  "input": "{ engine: 'claude' | 'codex' | 'pi' }",
  "inputFull": "{ engine: 'claude' | 'codex' | 'pi' }",
  "output": "{ engine: 'claude' | 'codex' | 'pi'; groups: ToolUsageGroup[]; totalEstTokens: number }"
 },
 {
  "method": "unattended.approve",
  "channel": "unattended:approve",
  "doc": "【MC-059】**用户签发无人值守任务计划的计划级授权** —— 用户在无人值守计划预览页点「批准」的落点。宿主把一份有界操作序列(`session.create`)铸成一枚绑定目标项目权威路径、签发主体(**写死为 user**)、有效期、次数上限的计划级授权。**只有桌面渲染端够得到它** —— agent 侧 `policyFor` 判 blocked(批准主体必须是用户本人);手机端 `webApi.ts` 显式 unsupported。",
  "input": "{ projectId: string // 这些操作跑在**哪个项目**里(权威路径由签发口从项目行解析,不采信调用方给的路径)。; ttlMs: number // 授权有效期的毫秒数(签发口只拒非正数;具体上限由签发口策略定)。; planId: string // 一次批准 / 执行的稳定 id(重试是同一 id 的覆盖,不是新计划)。; operations: { operationId: string; title?: string | undefined; expectedRevision?: string | undefined; prompt?: string | undefined; }[] // 有界的操作序列(至少一条)。; maxCount: number // 次数量上限(签发口要求 ≥ 操作条数)。 }",
  "inputFull": "{ projectId: string // 这些操作跑在**哪个项目**里(权威路径由签发口从项目行解析,不采信调用方给的路径)。; ttlMs: number // 授权有效期的毫秒数(签发口只拒非正数;具体上限由签发口策略定)。; planId: string // 一次批准 / 执行的稳定 id(重试是同一 id 的覆盖,不是新计划)。; operations: { operationId: string; title?: string | undefined; expectedRevision?: string | undefined; prompt?: string | undefined; }[] // 有界的操作序列(至少一条)。; maxCount: number // 次数量上限(签发口要求 ≥ 操作条数)。 }",
  "output": "{ ok: true; kind: 'granted'; planId: string; grantId: string; projectId: string; scopedProjectPath: string // 授权钉住的权威资源路径(= 目标项目规范化后的 `projectPath`)。; maxCount: number; operationCount: number; expiresAt: number } | { ok: false; kind: 'refused'; code: string; …"
 },
 {
  "method": "unattended.run",
  "channel": "unattended:run",
  "doc": "【MC-059】**执行一份已批准的无人值守计划** —— 授权**不给内容、只给 `grantId`**,由宿主从 `GrantStore` 取回(含失效态);取不到(不存在 / 已撤销 / 已过期)→ 拒绝执行、一步不建。逐条操作交给**唯一业务命令** `createSessionAndSend`(跑在计划授权之下),任一条被拒即**就地停住**(绝不静默重试或假装跑完)。",
  "input": "{ projectId: string; grantId: string // 上一次 `unattended.approve` 签出的授权 id。; planId: string; operations: { operationId: string; title?: string | undefined; expectedRevision?: string | undefined; prompt?: string | undefined; }[]; maxCount: number; initiatorSessionId?: string | undefined // **发起者坐标**(MC-059 残余 ②)—— 渲染端坐在哪条会话里点的「执行」。它**不是**发起者 身份本身,只是一枚宿主**能核实**的坐标:宿主拿它去 `Session… }",
  "inputFull": "{ projectId: string; grantId: string // 上一次 `unattended.approve` 签出的授权 id。; planId: string; operations: { operationId: string; title?: string | undefined; expectedRevision?: string | undefined; prompt?: string | undefined; }[]; maxCount: number; initiatorSessionId?: string | undefined // **发起者坐标**(MC-059 残余 ②)—— 渲染端坐在哪条会话里点的「执行」。它**不是**发起者 身份本身,只是一枚宿主**能核实**的坐标:宿主拿它去 `Session… }",
  "output": "{ ok: false; kind: 'refused'; code: string; reason: string } | { ok: true; kind: 'ran'; report: UnattendedExecutionReportWire }"
 },
 {
  "method": "unattendedPlans.abandon",
  "channel": "unattendedPlans:abandon",
  "doc": "【MC-059 残余 ④】**明确放弃**一份等待中的计划(不再列出、不再可续跑)。幂等。**只有桌面渲染端够得到它**(agent 侧 blocked、手机端 unsupported)。",
  "input": "{ planId: string }",
  "inputFull": "{ planId: string }",
  "output": "{ planId: string; abandoned: boolean // 这次调用是否真的把一条**未放弃**的计划标记为放弃(`false` = 记录不存在或已放弃)。 }"
 },
 {
  "method": "unattendedPlans.health",
  "channel": "unattendedPlans:health",
  "doc": "【MC-029 剩余项】**只读**存档健康度(query 档、Agent 可读):回答无人值守计划存档是 `ok` / `corrupt`(内容读不懂)/ `unreadable`(文件在但读不了),带可读原因与恢复提示。 只回诊断,不列计划、不执行任何一步。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ archiveHealth: UnattendedArchiveHealth }"
 },
 {
  "method": "unattendedPlans.list",
  "channel": "unattendedPlans:list",
  "doc": "【MC-059 残余 ④】**列出等待批准 / 待执行**的无人值守计划(跨重启)—— 重启后从计划存档 + `GrantStore` 现取现算,每条给三态(`waiting_approval` / `resumable` / `completed`)。**只读**,一步不执行。与 `unattended.*` 同一条纪律:**只有桌面渲染端够得到它**(agent 侧 blocked、手机端 unsupported)。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ plans: PendingUnattendedPlanWire[]; archiveHealth: UnattendedArchiveHealth // 【MC-029 剩余项】存档健康度。`list` 在坏档时**仍然拒绝**(抛 `archive_corrupt`, 因为它是 blocked 的治理视图、且空列表在这里是一句谎… }"
 },
 {
  "method": "unattendedPlans.resume",
  "channel": "unattendedPlans:resume",
  "doc": "【MC-059 残余 ④】**续跑**一份等待中的计划 —— 只给 `planId`,正文与授权 id 由宿主从存档 + `GrantStore` 取回(**取不到即拒、一步不建**)。已建成的操作**跳过**(不重复外部副作用)。**只有桌面渲染端够得到它**(agent 侧 blocked、手机端 unsupported)。",
  "input": "{ planId: string // 要续跑的计划 id(存档里的键)。; initiatorSessionId?: string | undefined // **发起者坐标**(与 `unattended.run` 的 `initiatorSessionId` 同义、同一条纪律)—— 渲染端 坐在哪条会话里点的「续跑」。只是一枚宿主*… }",
  "inputFull": "{ planId: string // 要续跑的计划 id(存档里的键)。; initiatorSessionId?: string | undefined // **发起者坐标**(与 `unattended.run` 的 `initiatorSessionId` 同义、同一条纪律)—— 渲染端 坐在哪条会话里点的「续跑」。只是一枚宿主*… }",
  "output": "{ ok: false; kind: 'refused'; code: string; reason: string } | { ok: true; kind: 'ran'; report: UnattendedExecutionReportWire }"
 },
 {
  "method": "usage.stats",
  "channel": "usage:stats",
  "doc": "Aggregate the persisted per-turn usage history into summary / per-model / per-day views for the requested time range. Read-only.",
  "input": "{ preset: 'today' | '7d' | '30d' | 'all' }",
  "inputFull": "{ preset: 'today' | '7d' | '30d' | 'all' }",
  "output": "{ summary: UsageSummaryStat; models: UsageModelStat[]; daily: UsageDayStat[] }"
 },
 {
  "method": "voice.cancel",
  "channel": "voice:cancel",
  "doc": "丢弃一次听写会话 —— **不出最终结果、丢掉所有 partial**(用户主动取消时说这条,不是 `stop`)。",
  "input": "{ sessionId: string }",
  "inputFull": "{ sessionId: string }",
  "output": "void"
 },
 {
  "method": "voice.cancelModelDownload",
  "channel": "voice:cancelModelDownload",
  "doc": "Cancel an in-flight model download (no-op if none).",
  "input": "{ modelId: string }",
  "inputFull": "{ modelId: string }",
  "output": "void"
 },
 {
  "method": "voice.downloadModel",
  "channel": "voice:downloadModel",
  "doc": "Begin downloading a catalog model. Returns immediately; progress arrives on the `voice:downloadProgress` push.",
  "input": "{ modelId: string }",
  "inputFull": "{ modelId: string }",
  "output": "void"
 },
 {
  "method": "voice.feed",
  "channel": "voice:feed",
  "doc": "往活动会话喂一块 16kHz 单声道 PCM(听写热路径,约 4 次/秒)。实时结果走 `voice:result` 推送回来。",
  "input": "{ sessionId: string; pcm: Float32Array<ArrayBuffer> | number[] }",
  "inputFull": "{ sessionId: string; pcm: Float32Array<ArrayBuffer> | number[] }",
  "output": "void"
 },
 {
  "method": "voice.getModelDir",
  "channel": "voice:getModelDir",
  "doc": "Read the current effective voice model root (custom or default).",
  "input": "{}",
  "inputFull": "{}",
  "output": "{ modelDir: string // The active root (never empty — resolves the default).; isCustom: boolean // True when the user has customized the path. }"
 },
 {
  "method": "voice.modelList",
  "channel": "voice:modelList",
  "doc": "List the model catalog + downloaded models + active selection.",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ models: VoiceModelInfo[]; downloaded: string[]; selected: string | null; modelDir: string // Active model root (after the user's customization, if any).; isCustom: boolean // True when the user has set a custom model root. }"
 },
 {
  "method": "voice.removeModel",
  "channel": "voice:removeModel",
  "doc": "Delete a downloaded model's local files (the active selection is re-pointed at another downloaded model, or cleared).",
  "input": "{ modelId: string }",
  "inputFull": "{ modelId: string }",
  "output": "void"
 },
 {
  "method": "voice.selectModel",
  "channel": "voice:selectModel",
  "doc": "Persist the active voice model selection for the composer mic button.",
  "input": "{ modelId: string }",
  "inputFull": "{ modelId: string }",
  "output": "void"
 },
 {
  "method": "voice.setModelDir",
  "channel": "voice:setModelDir",
  "doc": "Change the voice model root directory. Empty string = default. The new path is scanned; already-present catalog models appear as \"downloaded\" in the returned list, no re-download required.",
  "input": "{ modelDir: string // Absolute path, or \"\" to reset to the default. }",
  "inputFull": "{ modelDir: string // Absolute path, or \"\" to reset to the default. }",
  "output": "{ downloaded: string[] // Catalog models found under the new root.; modelDir: string; isCustom: boolean }"
 },
 {
  "method": "voice.start",
  "channel": "voice:start",
  "doc": "起一次语音识别会话:`sessionId` 是**渲染端自个儿的一次听写令牌**(不是聊天会话 id),引擎会按 `lang` 建解码器、按需懒惰下模型。",
  "input": "{ sessionId: string // Opaque per-listen token chosen by the renderer (e.g.; lang: string // Speech language tag, e.g.; engine: 'zipformer' | 'parakeet' // Desired engine: \"zipformer\" (streaming, interim results) | \"parakeet\" (offline, higher ac… }",
  "inputFull": "{ sessionId: string // Opaque per-listen token chosen by the renderer (e.g.; lang: string // Speech language tag, e.g.; engine: 'zipformer' | 'parakeet' // Desired engine: \"zipformer\" (streaming, interim results) | \"parakeet\" (offline, higher ac… }",
  "output": "void"
 },
 {
  "method": "voice.stop",
  "channel": "voice:stop",
  "doc": "结束会话并返回**最终**(可信度最高的)转写文本(没识别到就是空串)。",
  "input": "{ sessionId: string }",
  "inputFull": "{ sessionId: string }",
  "output": "{ text: string }"
 },
 {
  "method": "webBridge.regenerateToken",
  "channel": "webBridge:regenerateToken",
  "doc": "换一个配对令牌（旧令牌立刻失效，已连上的扩展会被断开重连）。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ url: string // 扩展要连的地址，如 `http://127.0.0.1:53124`。服务未起时为空串。; token: string // 配对令牌。; paired: boolean // 扩展此刻是否挂着 SSE 连接。; pairedAt: number | null // 本次配对建立的时间戳（ms）；未配对为 null。 }"
 },
 {
  "method": "webBridge.status",
  "channel": "webBridge:status",
  "doc": "设置页只读快照：扩展桥地址 / 令牌 / 是否已配对。会顺带把服务拉起来。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ url: string // 扩展要连的地址，如 `http://127.0.0.1:53124`。服务未起时为空串。; token: string // 配对令牌。; paired: boolean // 扩展此刻是否挂着 SSE 连接。; pairedAt: number | null // 本次配对建立的时间戳（ms）；未配对为 null。 }"
 },
 {
  "method": "workflow.agentProfiles",
  "channel": "workflow:agentProfiles",
  "doc": "代理档案:一份存下来的**子 agent 配置**(指令 / 技能 / 模型 / 引擎……)。建节点的 时候直接套一份,不用从空白开始填。 它是**值**不是类型 —— 删掉一份档案不会让任何已有的图跑不起来(节点身上已经有参数 了)。见 `@contracts/agentProfile` 的文件头。 ⚠️ 无参 handler,同 `workflow.list`。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ profiles: { params: Record<string, unknown>; type: string; id: string; version: 1; createdAt: number; name: string; updatedAt: number; description?: string | undefined; …; problems: { file: string; error: string; }[] }"
 },
 {
  "method": "workflow.applyShippedUpdate",
  "channel": "workflow:applyShippedUpdate",
  "doc": "自带工作流的出厂版有更新时:用出厂版覆盖这一行(用户关掉的触发器保持关闭)。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "workflow.approve",
  "channel": "workflow:approve",
  "doc": "Separate approval for the saved revision; saving/importing is not consent to execute an automation or to inject an imported workflow prompt.",
  "input": "{ id: string; revision: string }",
  "inputFull": "{ id: string; revision: string }",
  "output": "{ ok: boolean; review?: WorkflowReviewInfo | undefined; error?: string | undefined }"
 },
 {
  "method": "workflow.choose",
  "channel": "workflow:choose",
  "doc": "在**岔路口**上选一条路(`mcode.branch` 那个节点正停在那儿等着)。 它唤醒的是一个**还活着的运行**,不是开一次新的 —— 图从那个节点接着往下跑, 不重跑整张图。见 `@contracts/runtime` 的 `WorkflowNodeChoiceEvent`。 `ok: false` = 没有这样的等待;若图已更改或旧存档无版本, `error` 说明为何不能续跑。普通旧卡片不弹错误框。",
  "input": "{ sessionId: string; runId: string; nodeId: string; edgeId: string // 选中的那条**边**的 id。**不是节点 id** —— 两条出路可以通向同一步。; comment?: string | undefined // 用户顺手写的一句话(可以不写)。会拼进下一步的提示词。 }",
  "inputFull": "{ sessionId: string; runId: string; nodeId: string; edgeId: string // 选中的那条**边**的 id。**不是节点 id** —— 两条出路可以通向同一步。; comment?: string | undefined // 用户顺手写的一句话(可以不写)。会拼进下一步的提示词。 }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "workflow.dismissShippedUpdate",
  "channel": "workflow:dismissShippedUpdate",
  "doc": "忽略这次出厂更新(内容不动;出厂内容再变时重新提示)。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "workflow.export",
  "channel": "workflow:export",
  "doc": "把**磁盘上那一份**导出成 JSON 文本,走系统「另存为」框落盘。用户取消时 `canceled: true`,界面不该报错(取消不是失败)。路径**由主进程拿**,渲染端 始终没有\"写任意路径\"的能力(同 `library.revealFile`)。",
  "input": "{ id: string; suggestedName?: string | undefined // 保存框的默认文件名(不带扩展名)。渲染端**按用户当前的语言**给,因为主进程不知道 他此刻的界面语言(同 `dialog.pickFiles` 的 `title`:文案由调用方… }",
  "inputFull": "{ id: string; suggestedName?: string | undefined // 保存框的默认文件名(不带扩展名)。渲染端**按用户当前的语言**给,因为主进程不知道 他此刻的界面语言(同 `dialog.pickFiles` 的 `title`:文案由调用方… }",
  "output": "{ ok: boolean; canceled?: boolean | undefined; path?: string | undefined // 真写下去了才有。写成功后界面可以在它旁边说一句\"存哪儿了\"。; error?: string | undefined }"
 },
 {
  "method": "workflow.get",
  "channel": "workflow:get",
  "doc": "取一份完整工作流。找不到返回 null(比如列表之后被别处删了)。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ workflow: { id: string; name: string; builtin: boolean; updatedAt: number; nodes: { params: Record<string, unknown>; type: string; id: string; title: string; position: {…; revision: string | null; review: WorkflowReviewInfo | null }"
 },
 {
  "method": "workflow.import",
  "channel": "workflow:import",
  "doc": "收下一份导出的 JSON。**`id` 给了就是覆盖那一份**(必须已存在),不给就是新建 (id 现生成、重名自动加后缀)。",
  "input": "{ text: string // 文件的 JSON 正文(渲染端读好了给过来)。; id?: string | undefined // 覆盖哪一份。不给就是新建。 }",
  "inputFull": "{ text: string // 文件的 JSON 正文(渲染端读好了给过来)。; id?: string | undefined // 覆盖哪一份。不给就是新建。 }",
  "output": "{ ok: boolean; id?: string | undefined // 存下来的那一份的 id —— 界面据此打开它。; name?: string | undefined; errors?: string[] | undefined // 原样带回来的校验报告(错误逐条 + 警告)。**整份拒绝**:过不了闸门的图不写库, 所以 `ok: false` 时库里什么都没变。**成功时也可能非空**(【MC-006】:…; warnings?: string[] | undefined; error?:…"
 },
 {
  "method": "workflow.importFromFile",
  "channel": "workflow:importFromFile",
  "doc": "从**文件**导入 —— 主进程自己弹选择框并读文件。 为什么要这一条而不是让界面先 `file.readFile`:那条 RPC 被项目根闸门挡着,而用户 手上那份工作流多半存在项目外(下载目录、桌面)。选择框由用户亲手点,信任级别与 `dialog.pickFiles` 相同。`id` 同 `workflow.import`:给了就是覆盖。 ⚠️ 与 `workflow.import` 是**两条入口、同一段落库逻辑** —— 用户在文件管理器里 双击 `.json` 那条路(未来)只需要后者。",
  "input": "{ id?: string | undefined }",
  "inputFull": "{ id?: string | undefined }",
  "output": "{ ok: boolean; canceled?: boolean | undefined; id?: string | undefined; name?: string | undefined; errors?: string[] | undefined; warnings?: string[] | undefined; error?: string | undefined }"
 },
 {
  "method": "workflow.importPreset",
  "channel": "workflow:importPreset",
  "doc": "【MC-007】按出厂预置导入一份。**永远新建**(名字重了自动加后缀);要覆盖用 `workflow.import`。解析/校验/落库走与文本导入**同一个** `importWorkflowInto`。",
  "input": "{ id: string // 出厂预设的 id(`workflow.listPresets` 里那一条的 `id`)。 }",
  "inputFull": "{ id: string // 出厂预设的 id(`workflow.listPresets` 里那一条的 `id`)。 }",
  "output": "{ ok: boolean; id?: string | undefined; name?: string | undefined; errors?: string[] | undefined; warnings?: string[] | undefined; error?: string | undefined }"
 },
 {
  "method": "workflow.list",
  "channel": "workflow:list",
  "doc": "全部工作流:内置打底 + 用户覆盖 + 自建。**不含 nodes / edges**,画布打开某一项 时才走 `workflow.get` 取完整文档。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ workflows: { id: string; kind: 'prompt' | 'graph'; name: string; builtin: boolean; edited: boolean; updatedAt: number; description?: string | undefined; pinned?: boolean … }"
 },
 {
  "method": "workflow.listPresets",
  "channel": "workflow:listPresets",
  "doc": "【MC-007】列出**出厂预置工作流**(装包里 `resources/presets/workflows.json`, 开发时读仓库那份)。这是用户/Agent 发现\"这个版本带了哪些可导入内容\"的唯一入口。 返回摘要,**不含图本体**。`health` 三态必须原样带到调用方:`absent`(这个安装没带) 与 `corrupt`(带了但坏了)要能分开说,否则都表现成\"空列表\"。 ⚠️ 无参 handler,同 `workflow.list`。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ health: 'absent' | 'corrupt' | 'ok'; reason?: string | undefined // `health !== \"ok\"` 时的原因(给人和 Agent 看)。; path: string // 命中的文件路径(诊断用;`absent` 时是尝试过的位置)。; presets: { id: string; kind: 'prompt' | 'graph'; name: string; nodeCount: number; sameNameExists: bool…"
 },
 {
  "method": "workflow.nodeTypes",
  "channel": "workflow:nodeTypes",
  "doc": "当前可用的**节点类型**(内置 + 已启用插件 + 用户自写),以及读不进来的清单文件 和它们的错误。画布的\"添加节点\"菜单用前者;后者必须一起返回,否则用户写错一个 清单,界面上只会看到自己的类型凭空消失。 ⚠️ 无参 handler,同 `workflow.list`:不接 raw、不 parse。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ entries: NodeTypeEntry[]; problems: { file: string; error: string; }[] }"
 },
 {
  "method": "workflow.pinDefault",
  "channel": "workflow:pinDefault",
  "doc": "把内置工作流**当前生效的版本**钉成「默认」—— 之后 `workflow.remove`(恢复默认) 回到钉住的这一版(覆盖之前的默认,包括应用自带那份的地位)。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "workflow.remove",
  "channel": "workflow:remove",
  "doc": "删一份。删掉对内置工作流的覆盖 = 「恢复默认」;`wasBuiltin` 让界面能说对话 (「已恢复默认」而不是「已删除」)。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean; wasBuiltin: boolean }"
 },
 {
  "method": "workflow.removeAgentProfile",
  "channel": "workflow:removeAgentProfile",
  "doc": "删一份代理档案。**只按 id 拼路径** —— 格式坏、读不出来的档案(不进 `profiles`)照样删得掉,而那正是最该能删的一种。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean }"
 },
 {
  "method": "workflow.restoreDefault",
  "channel": "workflow:restoreDefault",
  "doc": "把钉住的快照写回(「恢复默认」)。没钉过 → 失败并说清。",
  "input": "{ id: string }",
  "inputFull": "{ id: string }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "workflow.retry",
  "channel": "workflow:retry",
  "doc": "**从失败那一步接着往下跑。** 用户在失败卡片上点了「再试一次」,顺手写了句 「上次哪里不对」。重跑的是那一步**连同它的全部下游**(见 `WorkflowRetrySchema`)。 `ok: false` 有四种原因,全都**不是错误**(界面上是一句\"这张卡不适用了\"): 找不到那次运行 / 它已经不是 `failed` / 存档读不回来 / 这个对话正有运行在跑。 最后那种要如实回 false —— `startWorkflowRun` 在运行中会静静地不做事。",
  "input": "{ sessionId: string; runId: string; nodeId: string // 从哪一步开始重跑。; note?: string | undefined // 用户写的一句话:「上次哪里不对」。**只给这一步看**(可以不写)。 }",
  "inputFull": "{ sessionId: string; runId: string; nodeId: string // 从哪一步开始重跑。; note?: string | undefined // 用户写的一句话:「上次哪里不对」。**只给这一步看**(可以不写)。 }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "workflow.save",
  "channel": "workflow:save",
  "doc": "存一份。**存盘前过 DAG 校验 + 每个节点的参数校验**,有环/悬空边/参数不合法 直接拒绝 —— 有环的图会让调度器永远等不到就绪节点,那不是报错是静默卡死。",
  "input": "{ workflow: { id: string; name: string; builtin: boolean; updatedAt: number; nodes: { params: Record<string, unknown>; type: string; id: string; title: string; position: {…; expectedRevision?: string | null | undefined // Hash returned by workflow.get, or null only when creating a new id. }",
  "inputFull": "{ workflow: { id: string; name: string // 名称**不能为空** —— 库里一行没有名字,列表、选择器、确认框里都会显示成一片空白。; builtin: boolean // true = 随应用发布的内置工作流(默认版在代码里,用户的修改存表里覆盖它)。; updatedAt: number; nodes: Array<{ params: Record<string, unknown> // 这个类型的参数。**这里只当袋子** —— 值的合法性由该类型的清单校验 (`validateNodeParams`),因为只有清单知道哪些键必填、各自该是什么类型。; type: string // 节点类型的 id,形如 `mcode.agent`。见 `nodeType.ts` 的 `NODE_TYPE_ID_RE`。; id: string // `\"n_\"` 前缀 + 随机。图内唯一。; title: string // 卡片标题。用户可改;留空则显示类型名。; position: { x: number; y: number }; capability?: \"read\" | \"write\" | \"exec\" | \"net\" | undefined // 覆盖类型的默认能力。省略 = 用清单声明的默认值。 }>; edges: Array<{ id: string; from: string; to: string; label?: string | undefined // 分支节点的选项名。留空 = 用目标节点的标题。; note?: string | undefined // 选了这一项之后给下一步的一句说明(会拼进它的提示词)。 }>; schemaVersion?: string | undefined // 文档的**读写版本**(WF-05)。导出时写上,导入时按兼容规则核对:缺失或等于现值 (见 `workflowValidation.ts` 的 `WORKFLOW_SCHEMA…; description?: string | undefined; inputSchema?: Record<string, unknown> | undefined // 这张图对**输入**的声明(WF-05,宽松形状) —— 描述\"起一次运行该给什么\":参数名、 类型、是否必填之类,JSON-Schema 风格的自由对象。; outputSchema?: Record<string, unknown> | undefined // 同 {@link WorkflowDocSchema.inputSchema },声明的是**产出**端:整张图跑完交什么。; prompt?: string | undefined // 提示词型工作流的正文 —— 就是原来 `COMPOSER_MODE_PROMPTS` 里那段流程文字。; icon?: string | undefined // 图标键,渲染端映射成具体图标。; trigger?: \"manual\" | \"schedule\" | \"file\" | \"event\" | \"webhook\" | undefined // 触发方式。**有它就是一条自动化,没有它就是一张工作流。** 用**一个字段的有没有**来区分两者,而不是再加一个 `purpose: \"workflow\" | \"automat…; frameworkNote?: string | undefined // 工作流级的**追加框架说明**(可选)。拼进这张图每个节点提示词的「整条流程」 框架段之后、其余各节之前(见 `main/orchestration/schedulerPromp… }; … }",
  "output": "{ ok: boolean; error?: string | undefined; warnings?: string[] | undefined }"
 },
 {
  "method": "workflow.saveAgentProfile",
  "channel": "workflow:saveAgentProfile",
  "doc": "存一份(按 id 覆盖)。整份给过来 —— 理由同 `hooks.save`。",
  "input": "{ profile: { params: Record<string, unknown>; type: string; id: string; version: 1; createdAt: number; name: string; updatedAt: number; description?: string | undefined; } }",
  "inputFull": "{ profile: { params: Record<string, unknown>; type: string; id: string; version: 1; createdAt: number; name: string; updatedAt: number; description?: string | undefined; } }",
  "output": "{ ok: boolean; error?: string | undefined }"
 },
 {
  "method": "workflowEngine.list",
  "channel": "workflowEngine:list",
  "doc": "【ARC-006 WF-INT】列出所有已知引擎的状态。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ engines: WorkflowEngineStatusView[] }"
 },
 {
  "method": "workflowEngine.nodeInstall",
  "channel": "workflowEngine:nodeInstall",
  "doc": "【ARC-006 Gate E】安装一个节点包（本地目录）。审批是**硬前置**：主进程向渲染端 推送审批卡并等待应答，超时/无渲染端一律拒绝。**输入里没有 `approvedByUser`**。",
  "input": "{ sourceDir: string // 本地目录（已下载/解包后的节点包）。; meta: { version: string; source: string; name: string; sha256: string; license: string; capabilities: string[]; } }",
  "inputFull": "{ sourceDir: string // 本地目录（已下载/解包后的节点包）。; meta: { version: string; source: string; name: string; sha256: string; license: string; capabilities: string[]; } }",
  "output": "{ ok: true; node: WorkflowEngineNodeView } | { ok: false; reason: string; code: 'invalid' | 'approval_denied' | 'approval_unavailable' | 'duplicate' | 'install_failed' }"
 },
 {
  "method": "workflowEngine.nodesList",
  "channel": "workflowEngine:nodesList",
  "doc": "【ARC-006 Gate E】列出已安装的第三方节点包（只读）。清单损坏时 `corrupt` 带原因， `nodes` 为空 —— 不把\"读不懂\"伪装成\"没装”。",
  "input": "(无参数)",
  "inputFull": "(无参数)",
  "output": "{ corrupt: string | null // 清单损坏时的显式诊断（`null` = 清单可读）。; nodes: WorkflowEngineNodeView[] }"
 },
 {
  "method": "workflowEngine.respondNodeInstallApproval",
  "channel": "workflowEngine:respondNodeInstallApproval",
  "doc": "【ARC-006 Gate E】渲染端对安装审批请求的应答（只回答那一次 `requestId`）。",
  "input": "{ requestId: string; approved: boolean // 用户是否批准**这一次**安装。 }",
  "inputFull": "{ requestId: string; approved: boolean // 用户是否批准**这一次**安装。 }",
  "output": "{ ok: boolean }"
 },
 {
  "method": "workflowEngine.start",
  "channel": "workflowEngine:start",
  "doc": "【ARC-006 WF-INT】启动一个第三方工作流引擎(独立子进程,只绑 127.0.0.1;数据目录与端口由宿主给)。",
  "input": "{ engineId: string }",
  "inputFull": "{ engineId: string }",
  "output": "{ ok: true; status: WorkflowEngineStatusView } | { ok: false; reason: string; status: WorkflowEngineStatusView | null }"
 },
 {
  "method": "workflowEngine.status",
  "channel": "workflowEngine:status",
  "doc": "【ARC-006 WF-INT】查询单个引擎的运行状态(含编辑器地址;不含命令/凭据)。",
  "input": "{ engineId: string }",
  "inputFull": "{ engineId: string }",
  "output": "{ ok: true; status: WorkflowEngineStatusView } | { ok: false; reason: string; status: WorkflowEngineStatusView | null }"
 },
 {
  "method": "workflowEngine.stop",
  "channel": "workflowEngine:stop",
  "doc": "【ARC-006 WF-INT】停止引擎(SIGTERM → 宽限 → SIGKILL;幂等)。",
  "input": "{ engineId: string }",
  "inputFull": "{ engineId: string }",
  "output": "{ ok: true; status: WorkflowEngineStatusView } | { ok: false; reason: string; status: WorkflowEngineStatusView | null }"
 }
];
