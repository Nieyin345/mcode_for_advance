import { contextBridge, ipcRenderer, webUtils } from "electron";
import { IPC } from "@contracts/ipc";
import type { RpcMap } from "@contracts/ipc";
import type { MainToRendererMessage } from "@contracts/ipc";

/**
 * The typed API exposed to the renderer via contextBridge.
 * This is the ONLY bridge into Node — the renderer cannot require() anything.
 */
const api = {
  modules: {
    catalog: (() => ipcRenderer.invoke(IPC.MODULE_CATALOG)) as RpcMap["modules.catalog"],
    install: ((input) => ipcRenderer.invoke(IPC.MODULE_INSTALL,input)) as RpcMap["modules.install"],
    remove: ((input) => ipcRenderer.invoke(IPC.MODULE_REMOVE,input)) as RpcMap["modules.remove"],
    invoke: ((input) => ipcRenderer.invoke(IPC.MODULE_INVOKE,input)) as RpcMap["modules.invoke"],
    task: ((input) => ipcRenderer.invoke(IPC.MODULE_TASK,input)) as RpcMap["modules.task"],
    cancel: ((input) => ipcRenderer.invoke(IPC.MODULE_CANCEL,input)) as RpcMap["modules.cancel"],
    tasks: ((input) => ipcRenderer.invoke(IPC.MODULE_TASKS,input)) as RpcMap["modules.tasks"],
  },
  // ── RPC (renderer → main) ──
  claude: {
    startSession: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_START_SESSION, input)) as RpcMap["claude.startSession"],
    listSideChats: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_LIST_SIDE_CHATS, input)) as RpcMap["claude.listSideChats"],
    sendTurn: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_SEND_TURN, input)) as RpcMap["claude.sendTurn"],
    interrupt: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_INTERRUPT, input)) as RpcMap["claude.interrupt"],
    inject: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_INJECT, input)) as RpcMap["claude.inject"],
    approve: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_APPROVE, input)) as RpcMap["claude.approve"],
    respondQuestion: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_RESPOND_QUESTION, input)) as RpcMap["claude.respondQuestion"],
    respondPlanApproval: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_RESPOND_PLAN_APPROVAL, input)) as RpcMap["claude.respondPlanApproval"],
    rewindTurn: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_REWIND_TURN, input)) as RpcMap["claude.rewindTurn"],
    saveSubagents: ((input) =>
      ipcRenderer.invoke(IPC.CLAUDE_SUBAGENTS_SAVE, input)) as RpcMap["claude.saveSubagents"],
  },
  project: {
    create: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_CREATE, input)) as RpcMap["project.create"],
    list: (() => ipcRenderer.invoke(IPC.PROJECT_LIST)) as RpcMap["project.list"],
    sessions: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_SESSIONS, input)) as RpcMap["project.sessions"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_DELETE, input)) as RpcMap["project.delete"],
    archive: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_ARCHIVE, input)) as RpcMap["project.archive"],
    setGroup: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_SET_GROUP, input)) as RpcMap["project.setGroup"],
    reorder: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_REORDER, input)) as RpcMap["project.reorder"],
    setPinned: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_PIN, input)) as RpcMap["project.pin"],
    rename: ((input) =>
      ipcRenderer.invoke(IPC.PROJECT_RENAME, input)) as RpcMap["project.rename"],
  },
  session: {
    /** Cross-project session title search (Ctrl+K unified search). */
    search: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_SEARCH, input)) as RpcMap["session.search"],
    searchBookmarks: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_SEARCH_BOOKMARKS, input)) as RpcMap["session.searchBookmarks"],
    messages: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_MESSAGES, input)) as RpcMap["session.messages"],
    saveMessages: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_SAVE_MESSAGES, input)) as RpcMap["session.saveMessages"],
    upsertMessages: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_UPSERT_MESSAGES, input)) as RpcMap["session.upsertMessages"],
    truncateAndInsertMessages: ((input) =>
      ipcRenderer.invoke(
        IPC.SESSION_TRUNCATE_AND_INSERT_MESSAGES,
        input,
      )) as RpcMap["session.truncateAndInsertMessages"],
    updateSettings: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_UPDATE_SETTINGS, input)) as RpcMap["session.updateSettings"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_DELETE, input)) as RpcMap["session.delete"],
    archive: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_ARCHIVE, input)) as RpcMap["session.archive"],
    rename: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_RENAME, input)) as RpcMap["session.rename"],
    fork: ((input) => ipcRenderer.invoke(IPC.SESSION_FORK, input)) as RpcMap["session.fork"],
    pin: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_PIN, input)) as RpcMap["session.pin"],
    updateBookmarks: ((input) =>
      ipcRenderer.invoke(
        IPC.SESSION_UPDATE_BOOKMARKS,
        input,
      )) as RpcMap["session.updateBookmarks"],
    listPinned: (() =>
      ipcRenderer.invoke(IPC.SESSION_LIST_PINNED)) as RpcMap["session.listPinned"],
    listAll: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_LIST_ALL, input)) as RpcMap["session.listAll"],
    listNodes: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_LIST_NODES, input)) as RpcMap["session.listNodes"],
    hasNodes: ((input) =>
      ipcRenderer.invoke(IPC.SESSION_HAS_NODES, input)) as RpcMap["session.hasNodes"],
  },
  setting: {
    get: ((input) =>
      ipcRenderer.invoke(IPC.SETTING_GET, input)) as RpcMap["setting.get"],
    set: ((input) =>
      ipcRenderer.invoke(IPC.SETTING_SET, input)) as RpcMap["setting.set"],
    getMany: ((input) =>
      ipcRenderer.invoke(IPC.SETTING_GET_MANY, input)) as RpcMap["setting.getMany"],
  },
  /** Speech-to-text (voice input) — drives sherpa-onnx ASR in main. The
   *  renderer streams 16 kHz mono PCM via `feed`; live results arrive on
   *  `voiceResult`. */
  voice: {
    start: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_START, input)) as RpcMap["voice.start"],
    feed: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_FEED, input)) as RpcMap["voice.feed"],
    stop: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_STOP, input)) as RpcMap["voice.stop"],
    cancel: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_CANCEL, input)) as RpcMap["voice.cancel"],
    modelList: (() =>
      ipcRenderer.invoke(IPC.VOICE_MODEL_LIST)) as RpcMap["voice.modelList"],
    downloadModel: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_DOWNLOAD_MODEL, input)) as RpcMap["voice.downloadModel"],
    cancelModelDownload: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_CANCEL_MODEL_DOWNLOAD, input)) as RpcMap["voice.cancelModelDownload"],
    selectModel: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_SELECT_MODEL, input)) as RpcMap["voice.selectModel"],
    removeModel: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_REMOVE_MODEL, input)) as RpcMap["voice.removeModel"],
    getModelDir: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_GET_MODEL_DIR, input)) as RpcMap["voice.getModelDir"],
    setModelDir: ((input) =>
      ipcRenderer.invoke(IPC.VOICE_SET_MODEL_DIR, input)) as RpcMap["voice.setModelDir"],
  },

  /** Notification preferences + OS notification click handling. */
  notification: {
    getPrefs: (() =>
      ipcRenderer.invoke(IPC.NOTIFICATION_GET_PREFS)) as RpcMap["notification.getPrefs"],
    setPrefs: ((input) =>
      ipcRenderer.invoke(IPC.NOTIFICATION_SET_PREFS, input)) as RpcMap["notification.setPrefs"],
    focusSession: ((input) =>
      ipcRenderer.invoke(IPC.NOTIFICATION_FOCUS_SESSION, input)) as RpcMap["notification.focusSession"],
  },

  /** Provider list — returns all registered backends with capabilities. */
  provider: {
    list: (() => ipcRenderer.invoke(IPC.PROVIDER_LIST)) as RpcMap["provider.list"],
    healthCheck: ((input) =>
      ipcRenderer.invoke(IPC.PROVIDER_HEALTH_CHECK, input)) as RpcMap["provider.healthCheck"],
    /** 引擎自己的斜杠命令清单（见 rpcMap 里 `provider.commands` 的说明）。 */
    commands: ((input) =>
      ipcRenderer.invoke(IPC.PROVIDER_COMMANDS, input)) as RpcMap["provider.commands"],
  },

  /** Custom-model configs (user-defined Anthropic-compatible endpoints).
   *  Keys are encrypted at rest; the renderer only ever receives a masked form. */
  customModel: {
    list: (() => ipcRenderer.invoke(IPC.CUSTOM_MODEL_LIST)) as RpcMap["customModel.list"],
    save: ((input) =>
      ipcRenderer.invoke(IPC.CUSTOM_MODEL_SAVE, input)) as RpcMap["customModel.save"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.CUSTOM_MODEL_DELETE, input)) as RpcMap["customModel.delete"],
    test: ((input) =>
      ipcRenderer.invoke(IPC.CUSTOM_MODEL_TEST, input)) as RpcMap["customModel.test"],
    /** Settings UI eye-icon only — returns cleartext token for display. */
    getToken: ((input) =>
      ipcRenderer.invoke(IPC.CUSTOM_MODEL_GET_TOKEN, input)) as RpcMap["customModel.getToken"],
  },

  /** 扩展桥（网页端协议的传输层）：配对状态 + 换令牌。桥地址与令牌就在返回值里，
   *  设置页要显示给用户复制进浏览器扩展。 */
  webBridge: {
    status: (() => ipcRenderer.invoke(IPC.WEB_BRIDGE_STATUS)) as RpcMap["webBridge.status"],
    regenerateToken: (() =>
      ipcRenderer.invoke(
        IPC.WEB_BRIDGE_REGENERATE_TOKEN,
      )) as RpcMap["webBridge.regenerateToken"],
  },

  /** 公网 MCP 端点（给 ChatGPT 的 Connector 用）。与 webBridge 是两条独立通路：
   *  那条给浏览器扩展（回环 + 扩展来源），这条给互联网上的远程客户端（路径密钥）。
   *  ⚠️ 打开后拿到链接的人拥有本机完全操作权（无审批闸门）。 */
  publicMcp: {
    status: (() => ipcRenderer.invoke(IPC.PUBLIC_MCP_STATUS)) as RpcMap["publicMcp.status"],
    setEnabled: ((input) =>
      ipcRenderer.invoke(IPC.PUBLIC_MCP_SET_ENABLED, input)) as RpcMap["publicMcp.setEnabled"],
    regenerateSecret: (() =>
      ipcRenderer.invoke(
        IPC.PUBLIC_MCP_REGENERATE_SECRET,
      )) as RpcMap["publicMcp.regenerateSecret"],
    startTunnel: (() =>
      ipcRenderer.invoke(IPC.PUBLIC_MCP_START_TUNNEL)) as RpcMap["publicMcp.startTunnel"],
    stopTunnel: (() =>
      ipcRenderer.invoke(IPC.PUBLIC_MCP_STOP_TUNNEL)) as RpcMap["publicMcp.stopTunnel"],
    setProject: ((input) =>
      ipcRenderer.invoke(IPC.PUBLIC_MCP_SET_PROJECT, input)) as RpcMap["publicMcp.setProject"],
  },

  /** Pi models visual editor — reads/writes ~/.pi/agent/models.json.
   *  apiKey fields are $ENV_VAR references (never plaintext), so returning
   *  them to the renderer is safe. */
  piModels: {
    list: (() => ipcRenderer.invoke(IPC.PI_MODELS_LIST)) as RpcMap["piModels.list"],
    save: ((input) =>
      ipcRenderer.invoke(IPC.PI_MODELS_SAVE, input)) as RpcMap["piModels.save"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.PI_MODELS_DELETE, input)) as RpcMap["piModels.delete"],
    listAvailable: (() => ipcRenderer.invoke(IPC.PI_MODELS_LIST_AVAILABLE)) as RpcMap["piModels.listAvailable"],
    /** Settings UI eye-icon only — returns cleartext apiKey for display. */
    getApiKey: ((input) =>
      ipcRenderer.invoke(IPC.PI_MODELS_GET_API_KEY, input)) as RpcMap["piModels.getApiKey"],
  },

  /** Codex model providers — third-party Responses-API endpoints driving the
   *  Codex harness (materialized into <CODEX_HOME>/config.toml). Cleartext
   *  keys stay in the encrypted settings map; getApiKey is the settings-UI
   *  eye-icon carve-out only. */
  codexModels: {
    list: (() => ipcRenderer.invoke(IPC.CODEX_MODELS_LIST)) as RpcMap["codexModels.list"],
    save: ((input) =>
      ipcRenderer.invoke(IPC.CODEX_MODELS_SAVE, input)) as RpcMap["codexModels.save"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.CODEX_MODELS_DELETE, input)) as RpcMap["codexModels.delete"],
    getApiKey: ((input) =>
      ipcRenderer.invoke(IPC.CODEX_MODELS_GET_API_KEY, input)) as RpcMap["codexModels.getApiKey"],
  },

  /** Color scheme: get/set the preference; theme.changed fires when the
   *  effective theme changes (incl. OS-side changes in 'system' mode). */
  theme: {
    get: (() => ipcRenderer.invoke(IPC.THEME_GET)) as RpcMap["theme.get"],
    set: ((input) =>
      ipcRenderer.invoke(IPC.THEME_SET, input)) as RpcMap["theme.set"],
  },

  /** 文献库 —— 条目、集合、检索导入、全文检索、库位置。
   *  变更类方法一律返回新的完整列表,渲染端整体替换缓存。 */
  library: {
    groupsGet: (() =>
      ipcRenderer.invoke(IPC.LIBRARY_GROUPS_GET, {})) as RpcMap["library.groupsGet"],
    groupsSave: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_GROUPS_SAVE, input)) as RpcMap["library.groupsSave"],
    suppressGet: (() =>
      ipcRenderer.invoke(IPC.LIBRARY_SUPPRESS_GET, {})) as RpcMap["library.suppressGet"],
    suppressSave: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_SUPPRESS_SAVE, input)) as RpcMap["library.suppressSave"],
    linksOf: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_LINKS_OF, input)) as RpcMap["library.linksOf"],
    linkCounts: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_LINK_COUNTS, input)) as RpcMap["library.linkCounts"],
    linkAdd: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_LINK_ADD, input)) as RpcMap["library.linkAdd"],
    linkRemove: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_LINK_REMOVE, input)) as RpcMap["library.linkRemove"],
    importGeneric: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_IMPORT_GENERIC, input)) as RpcMap["library.importGeneric"],
    readFile: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_READ_FILE, input)) as RpcMap["library.readFile"],
    list: ((input) => ipcRenderer.invoke(IPC.LIBRARY_LIST, input)) as RpcMap["library.list"],
    get: ((input) => ipcRenderer.invoke(IPC.LIBRARY_GET, input)) as RpcMap["library.get"],
    addItems: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_ADD_ITEMS, input)) as RpcMap["library.addItems"],
    deleteItems: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_DELETE_ITEMS, input)) as RpcMap["library.deleteItems"],
    restoreItems: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_RESTORE_ITEMS, input)) as RpcMap["library.restoreItems"],
    deletePreview: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_DELETE_PREVIEW, input)) as RpcMap["library.deletePreview"],
    importFiles: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_IMPORT_FILES, input)) as RpcMap["library.importFiles"],
    convert: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_CONVERT, input)) as RpcMap["library.convert"],
    revealFile: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_REVEAL_FILE, input)) as RpcMap["library.revealFile"],
    openFile: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_OPEN_FILE, input)) as RpcMap["library.openFile"],
    entryPath: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_ENTRY_PATH, input)) as RpcMap["library.entryPath"],
    readHighlights: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_READ_HIGHLIGHTS, input)) as RpcMap["library.readHighlights"],
    saveHighlights: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_SAVE_HIGHLIGHTS, input)) as RpcMap["library.saveHighlights"],
    writeHighlights: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_WRITE_HIGHLIGHTS, input)) as RpcMap["library.writeHighlights"],
    readOriginalPdf: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_READ_ORIGINAL_PDF, input)) as RpcMap["library.readOriginalPdf"],
    readMarkdown: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_READ_MARKDOWN, input)) as RpcMap["library.readMarkdown"],
    readPdf: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_READ_PDF, input)) as RpcMap["library.readPdf"],
    renameItem: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_RENAME_ITEM, input)) as RpcMap["library.renameItem"],
    listNotes: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_LIST_NOTES, input)) as RpcMap["library.listNotes"],
    saveNote: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_SAVE_NOTE, input)) as RpcMap["library.saveNote"],
    deleteNote: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_DELETE_NOTE, input)) as RpcMap["library.deleteNote"],
    createNote: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_CREATE_NOTE, input)) as RpcMap["library.createNote"],
    writeNote: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_WRITE_NOTE, input)) as RpcMap["library.writeNote"],
    adoptMarkdown: ((input) =>
      ipcRenderer.invoke(
        IPC.LIBRARY_ADOPT_MARKDOWN,
        input,
      )) as RpcMap["library.adoptMarkdown"],
    importNotes: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_IMPORT_NOTES, input)) as RpcMap["library.importNotes"],
    conversionStats: (() =>
      ipcRenderer.invoke(IPC.LIBRARY_CONVERSION_STATS)) as RpcMap["library.conversionStats"],
    conversionReport: (() =>
      ipcRenderer.invoke(IPC.LIBRARY_CONVERSION_REPORT)) as RpcMap["library.conversionReport"],
    fullTextSearch: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_FULL_TEXT_SEARCH, input)) as RpcMap["library.fullTextSearch"],
    itemManifest: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_ITEM_MANIFEST, input)) as RpcMap["library.itemManifest"],
    manifest: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_MANIFEST, input)) as RpcMap["library.manifest"],
    attachToChat: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_ATTACH_TO_CHAT, input)) as RpcMap["library.attachToChat"],
    listCollections: (() =>
      ipcRenderer.invoke(IPC.LIBRARY_LIST_COLLECTIONS)) as RpcMap["library.listCollections"],
    createCollection: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_CREATE_COLLECTION, input)) as RpcMap["library.createCollection"],
    renameCollection: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_RENAME_COLLECTION, input)) as RpcMap["library.renameCollection"],
    deleteCollection: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_DELETE_COLLECTION, input)) as RpcMap["library.deleteCollection"],
    moveCollection: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_MOVE_COLLECTION, input)) as RpcMap["library.moveCollection"],
    assignCollection: ((input) =>
      ipcRenderer.invoke(IPC.LIBRARY_ASSIGN_COLLECTION, input)) as RpcMap["library.assignCollection"],
  },

  /** 机构认证入口。⚠️ 这里**没有凭据管理** —— 登录态在内嵌浏览器的共享分区里,
   *  这套 API 只维护「入口档案」并从 cookie 反推已登录站点。 */
  institution: {
    list: (() => ipcRenderer.invoke(IPC.INSTITUTION_LIST)) as RpcMap["institution.list"],
    save: ((input) => ipcRenderer.invoke(IPC.INSTITUTION_SAVE, input)) as RpcMap["institution.save"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.INSTITUTION_DELETE, input)) as RpcMap["institution.delete"],
    authStatus: ((input) =>
      ipcRenderer.invoke(IPC.INSTITUTION_AUTH_STATUS, input)) as RpcMap["institution.authStatus"],
    clearCookies: ((input) =>
      ipcRenderer.invoke(IPC.INSTITUTION_CLEAR_COOKIES, input)) as RpcMap["institution.clearCookies"],
  },

  /** App + runtime info (version, Electron/Node/Chromium, platform) for the
   *  About panel. Parameterless RPC. */
  app: {
    info: (() => ipcRenderer.invoke(IPC.APP_INFO)) as RpcMap["app.info"],
    /** 统一数据根:数据库、文献库、模版库都在它下面。 */
    getDataRoot: (() =>
      ipcRenderer.invoke(IPC.APP_GET_DATA_ROOT)) as RpcMap["app.getDataRoot"],
    /** 迁移整个数据根到新位置 —— **成功后会重启应用**。 */
    moveDataRoot: ((input) =>
      ipcRenderer.invoke(IPC.APP_MOVE_DATA_ROOT, input)) as RpcMap["app.moveDataRoot"],
    /** Check for updates on the GitHub Releases channel. */
    checkForUpdates: (() =>
      ipcRenderer.invoke(IPC.APP_CHECK_FOR_UPDATES)) as RpcMap["app.checkForUpdates"],
    /** Start downloading the pending update (user opted in). */
    downloadUpdate: (() =>
      ipcRenderer.invoke(IPC.APP_DOWNLOAD_UPDATE)) as RpcMap["app.downloadUpdate"],
    /** Quit and install a downloaded update. */
    quitAndInstall: (() =>
      ipcRenderer.invoke(IPC.APP_QUIT_AND_INSTALL)) as RpcMap["app.quitAndInstall"],
  },

  /** Open a project root in the OS file manager. Main refuses any path that
   *  isn't an exact match for a known project root, so only directories the
   *  user has added as projects can be opened. */
  shell: {
    openPath: ((input) =>
      ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, input)) as RpcMap["shell.openPath"],
    /** Reveal a file or directory inside a project root in the OS file
     *  manager, selecting it. Used by the file-tree context menu. */
    showItemInFolder: ((input) =>
      ipcRenderer.invoke(
        IPC.SHELL_SHOW_ITEM_IN_FOLDER,
        input,
      )) as RpcMap["shell.showItemInFolder"],
    /** Open a file inside a project root with the OS default application
     *  (e.g. .docx in Word, .pdf in Preview). Used by the editor's
     *  unsupported-file pane. */
    openFile: ((input) =>
      ipcRenderer.invoke(IPC.SHELL_OPEN_FILE, input)) as RpcMap["shell.openFile"],
  },

  /** Filesystem operations for the IDE right panel + diff rendering. Every
   *  path must resolve inside a known project root (main enforces this);
   *  read/list degrade to empty on refusal or failure, write returns ok:false. */
  file: {
    readFile: ((input) =>
      ipcRenderer.invoke(IPC.FILE_READ, input)) as RpcMap["file.readFile"],
    /** Read a binary file as a base64 data URL (image preview). */
    readBinary: ((input) =>
      ipcRenderer.invoke(IPC.FILE_READ_BINARY, input)) as RpcMap["file.readBinary"],
    /** OS dialog image picker → base64 images (composer 图片 button). */
    pickImages: ((input) =>
      ipcRenderer.invoke(IPC.FILE_PICK_IMAGES, input)) as RpcMap["file.pickImages"],
    /** List one level of a directory (non-recursive) for the file tree. */
    listDir: ((input) =>
      ipcRenderer.invoke(IPC.FILE_LIST_DIR, input)) as RpcMap["file.listDir"],
    /** Recursive file search under a project root (composer @ / add-context). */
    search: ((input) =>
      ipcRenderer.invoke(IPC.FILE_SEARCH, input)) as RpcMap["file.search"],
    /** Grep file contents under a project root (line-level matches). */
    grep: ((input) =>
      ipcRenderer.invoke(IPC.FILE_GREP, input)) as RpcMap["file.grep"],
    /** Write utf-8 content to a file (creates parent dirs). Returns ok. */
    writeFile: ((input) =>
      ipcRenderer.invoke(IPC.FILE_WRITE, input)) as RpcMap["file.writeFile"],
    /** Create a directory (recursive). Returns ok. */
    mkdir: ((input) =>
      ipcRenderer.invoke(IPC.FILE_MKDIR, input)) as RpcMap["file.mkdir"],
    /** Delete a file or directory (moves to system trash). Returns ok. */
    delete: ((input) =>
      ipcRenderer.invoke(IPC.FILE_DELETE, input)) as RpcMap["file.delete"],
    /** Rename a file or directory in place. Returns ok. */
    rename: ((input) =>
      ipcRenderer.invoke(IPC.FILE_RENAME, input)) as RpcMap["file.rename"],
    /** Copy a file into a directory (auto-renames on name clash). Returns ok. */
    copy: ((input) =>
      ipcRenderer.invoke(IPC.FILE_COPY, input)) as RpcMap["file.copy"],
  },

  /** ripgrep availability + one-click install (search dialog banner). */
  rg: {
    status: (() => ipcRenderer.invoke(IPC.RG_STATUS)) as RpcMap["rg.status"],
    install: (() => ipcRenderer.invoke(IPC.RG_INSTALL)) as RpcMap["rg.install"],
  },

  /** Clipboard-pasted external files (images / files copied from the OS) →
   *  materialized to a temp path the agent can read (composer paste). */
  clipboardFile: {
    save: ((input) =>
      ipcRenderer.invoke(IPC.CLIPBOARD_SAVE_FILE, input)) as RpcMap["clipboard.saveFile"],
    /** Copy an image data URL onto the OS clipboard (image lightbox 复制). */
    writeImage: ((input) =>
      ipcRenderer.invoke(
        IPC.CLIPBOARD_WRITE_IMAGE,
        input,
      )) as RpcMap["clipboard.writeImage"],
  },

  /** Git operations for the Git panel. All paths must resolve inside a known
   *  project root (main enforces this). Auth for push/pull is handled by the
   *  system's git configuration (SSH keys, credential helpers). */
  git: {
    discoverRepos: ((input) =>
      ipcRenderer.invoke(IPC.GIT_DISCOVER_REPOS, input)) as RpcMap["git.discoverRepos"],
    status: ((input) =>
      ipcRenderer.invoke(IPC.GIT_STATUS, input)) as RpcMap["git.status"],
    stage: ((input) =>
      ipcRenderer.invoke(IPC.GIT_STAGE, input)) as RpcMap["git.stage"],
    unstage: ((input) =>
      ipcRenderer.invoke(IPC.GIT_UNSTAGE, input)) as RpcMap["git.unstage"],
    commit: ((input) =>
      ipcRenderer.invoke(IPC.GIT_COMMIT, input)) as RpcMap["git.commit"],
    push: ((input) =>
      ipcRenderer.invoke(IPC.GIT_PUSH, input)) as RpcMap["git.push"],
    pull: ((input) =>
      ipcRenderer.invoke(IPC.GIT_PULL, input)) as RpcMap["git.pull"],
    diff: ((input) =>
      ipcRenderer.invoke(IPC.GIT_DIFF, input)) as RpcMap["git.diff"],
    fileBlob: ((input) =>
      ipcRenderer.invoke(IPC.GIT_FILE_BLOB, input)) as RpcMap["git.fileBlob"],
    discard: ((input) =>
      ipcRenderer.invoke(IPC.GIT_DISCARD, input)) as RpcMap["git.discard"],
    generateCommitMessage: ((input) =>
      ipcRenderer.invoke(IPC.GIT_GENERATE_COMMIT, input)) as RpcMap["git.generateCommitMessage"],
    cancelGenerateCommitMessage: ((input) =>
      ipcRenderer.invoke(IPC.GIT_CANCEL_GENERATE_COMMIT, input)) as RpcMap["git.cancelGenerateCommitMessage"],
    log: ((input) =>
      ipcRenderer.invoke(IPC.GIT_LOG, input)) as RpcMap["git.log"],
    showCommit: ((input) =>
      ipcRenderer.invoke(IPC.GIT_SHOW_COMMIT, input)) as RpcMap["git.showCommit"],
    showFile: ((input) =>
      ipcRenderer.invoke(IPC.GIT_SHOW_FILE, input)) as RpcMap["git.showFile"],
    listBranches: ((input) =>
      ipcRenderer.invoke(IPC.GIT_LIST_BRANCHES, input)) as RpcMap["git.listBranches"],
    checkout: ((input) =>
      ipcRenderer.invoke(IPC.GIT_CHECKOUT, input)) as RpcMap["git.checkout"],
    deleteBranch: ((input) =>
      ipcRenderer.invoke(IPC.GIT_DELETE_BRANCH, input)) as RpcMap["git.deleteBranch"],
    mergePreview: ((input) =>
      ipcRenderer.invoke(IPC.GIT_MERGE_PREVIEW, input)) as RpcMap["git.mergePreview"],
    merge: ((input) =>
      ipcRenderer.invoke(IPC.GIT_MERGE, input)) as RpcMap["git.merge"],
    mergeAbort: ((input) =>
      ipcRenderer.invoke(IPC.GIT_MERGE_ABORT, input)) as RpcMap["git.mergeAbort"],
    worktreeList: ((input) =>
      ipcRenderer.invoke(IPC.GIT_WORKTREE_LIST, input)) as RpcMap["git.worktreeList"],
    worktreeStatus: ((input) =>
      ipcRenderer.invoke(IPC.GIT_WORKTREE_STATUS, input)) as RpcMap["git.worktreeStatus"],
    worktreeMergeBack: ((input) =>
      ipcRenderer.invoke(IPC.GIT_WORKTREE_MERGE_BACK, input)) as RpcMap["git.worktreeMergeBack"],
    worktreeRemove: ((input) =>
      ipcRenderer.invoke(IPC.GIT_WORKTREE_REMOVE, input)) as RpcMap["git.worktreeRemove"],
  },

  /** Integrated terminal (xterm in renderer ↔ node-pty in main). Paths on
   *  create must resolve inside a known project root (main enforces this). */
  terminal: {
    create: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_CREATE, input)) as RpcMap["terminal.create"],
    write: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_WRITE, input)) as RpcMap["terminal.write"],
    resize: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_RESIZE, input)) as RpcMap["terminal.resize"],
    kill: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_KILL, input)) as RpcMap["terminal.kill"],
    list: ((input) =>
      ipcRenderer.invoke(IPC.TERMINAL_LIST, input)) as RpcMap["terminal.list"],
  },

  /** Embedded browser (WebContentsView in main ↔ browser panel in renderer).
   *  The view is an OS-level surface overlaid on the main window; the renderer
   *  measures a placeholder div and syncs pixel bounds via setBounds. Pick mode
   *  injects a script into the page's main world to capture clicked elements. */
  browser: {
    create: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_CREATE, input)) as RpcMap["browser.create"],
    loadUrl: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_LOAD_URL, input)) as RpcMap["browser.loadUrl"],
    goBack: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_GO_BACK, input)) as RpcMap["browser.goBack"],
    goForward: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_GO_FORWARD, input)) as RpcMap["browser.goForward"],
    reload: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_RELOAD, input)) as RpcMap["browser.reload"],
    setBounds: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_SET_BOUNDS, input)) as RpcMap["browser.setBounds"],
    setPickMode: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_SET_PICK_MODE, input)) as RpcMap["browser.setPickMode"],
    show: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_SHOW, input)) as RpcMap["browser.show"],
    hide: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_HIDE, input)) as RpcMap["browser.hide"],
    close: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_CLOSE, input)) as RpcMap["browser.close"],
    captureFrame: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_CAPTURE_FRAME, input)) as RpcMap["browser.captureFrame"],
    bookmarkAdd: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_BOOKMARK_ADD, input)) as RpcMap["browser.bookmarkAdd"],
    bookmarkRemove: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_BOOKMARK_REMOVE, input)) as RpcMap["browser.bookmarkRemove"],
    setDevice: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_SET_DEVICE, input)) as RpcMap["browser.setDevice"],
    clearCache: (() =>
      ipcRenderer.invoke(IPC.BROWSER_CLEAR_CACHE)) as RpcMap["browser.clearCache"],
    clearCookies: (() =>
      ipcRenderer.invoke(IPC.BROWSER_CLEAR_COOKIES)) as RpcMap["browser.clearCookies"],
    historyRemove: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_HISTORY_REMOVE, input)) as RpcMap["browser.historyRemove"],
    historyClear: (() =>
      ipcRenderer.invoke(IPC.BROWSER_HISTORY_CLEAR)) as RpcMap["browser.historyClear"],
    authRespond: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_AUTH_RESPOND, input)) as RpcMap["browser.authRespond"],
    downloadAction: ((input) =>
      ipcRenderer.invoke(IPC.BROWSER_DOWNLOAD_ACTION, input)) as RpcMap["browser.downloadAction"],
  },

  /** Language servers (LSP): install/enable per language, then sync documents
   *  and forward capability requests (definition/references/hover) to the
   *  server process running in main. All paths must resolve inside a known
   *  project root (main enforces this). */
  lsp: {
    list: (() => ipcRenderer.invoke(IPC.LSP_LIST)) as RpcMap["lsp.list"],
    install: ((input) =>
      ipcRenderer.invoke(IPC.LSP_INSTALL, input)) as RpcMap["lsp.install"],
    installFromFile: ((input) =>
      ipcRenderer.invoke(IPC.LSP_INSTALL_FROM_FILE, input)) as RpcMap["lsp.installFromFile"],
    uninstall: ((input) =>
      ipcRenderer.invoke(IPC.LSP_UNINSTALL, input)) as RpcMap["lsp.uninstall"],
    toggle: ((input) =>
      ipcRenderer.invoke(IPC.LSP_TOGGLE, input)) as RpcMap["lsp.toggle"],
    setPath: ((input) =>
      ipcRenderer.invoke(IPC.LSP_SET_PATH, input)) as RpcMap["lsp.setPath"],
    healthCheck: ((input) =>
      ipcRenderer.invoke(IPC.LSP_HEALTH_CHECK, input)) as RpcMap["lsp.healthCheck"],
    prewarm: ((input) =>
      ipcRenderer.invoke(IPC.LSP_PREWARM, input)) as RpcMap["lsp.prewarm"],
    restart: ((input) =>
      ipcRenderer.invoke(IPC.LSP_RESTART, input)) as RpcMap["lsp.restart"],
    openDocument: ((input) =>
      ipcRenderer.invoke(IPC.LSP_OPEN_DOC, input)) as RpcMap["lsp.openDocument"],
    closeDocument: ((input) =>
      ipcRenderer.invoke(IPC.LSP_CLOSE_DOC, input)) as RpcMap["lsp.closeDocument"],
    didChange: ((input) =>
      ipcRenderer.invoke(IPC.LSP_DID_CHANGE, input)) as RpcMap["lsp.didChange"],
    didSave: ((input) =>
      ipcRenderer.invoke(IPC.LSP_DID_SAVE, input)) as RpcMap["lsp.didSave"],
    request: ((input) =>
      ipcRenderer.invoke(IPC.LSP_REQUEST, input)) as RpcMap["lsp.request"],
  },

  // ── Main-only helpers ──
  /** Open a native folder picker; returns the chosen path or null. */
  pickFolder: (): Promise<{ path: string | null }> =>
    ipcRenderer.invoke("dialog:pickFolder"),
  /** Open a native multi-file picker (project-external files allowed).
   *  Returns the selected absolute paths; empty when the user cancels. */
  pickFiles: ((input) =>
    ipcRenderer.invoke(IPC.DIALOG_PICK_FILES, input)) as RpcMap["dialog.pickFiles"],

  /** Skill discovery + management. `list` scans the universal ~/.mcode/skills
   *  library; read/save/delete operate on a single skill. `enginesSet` edits
   *  the per-engine availability matrix. scanSources/import support importing
   *  skills from external tools. */
  skills: {
    list: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_LIST, input)) as RpcMap["skills.list"],
    read: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_READ, input)) as RpcMap["skills.read"],
    save: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_SAVE, input)) as RpcMap["skills.save"],
    delete: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_DELETE, input)) as RpcMap["skills.delete"],
    copyToProject: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_COPY_TO_PROJECT, input)) as RpcMap["skills.copyToProject"],
    presetsList: (() =>
      ipcRenderer.invoke(IPC.SKILLS_PRESETS_LIST)) as RpcMap["skills.presetsList"],
    presetsSave: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_PRESETS_SAVE, input)) as RpcMap["skills.presetsSave"],
    presetsDelete: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_PRESETS_DELETE, input)) as RpcMap["skills.presetsDelete"],
    projectOverview: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_PROJECT_OVERVIEW, input)) as RpcMap["skills.projectOverview"],
    enginesSet: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_ENGINES_SET, input)) as RpcMap["skills.engines.set"],
    bundles: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_BUNDLES, input)) as RpcMap["skills.bundles"],
    enginesSetBulk: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_ENGINES_SET_BULK, input)) as RpcMap["skills.enginesSetBulk"],
    scanSources: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_SCAN_SOURCES, input)) as RpcMap["skills.scanSources"],
    import: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_IMPORT, input)) as RpcMap["skills.import"],
    importGithub: ((input) =>
      ipcRenderer.invoke(IPC.SKILLS_IMPORT_GITHUB, input)) as RpcMap["skills.importGithub"],
  },

  /** MCP server management (settings panel): list the three server sources
   *  (user config file / project .mcp.json / built-in browser server), toggle
   *  them, add/remove user-scope servers, and import from the local Claude
   *  CLI config. Changes take effect on the next turn. */
  mcp: {
    list: ((input) =>
      ipcRenderer.invoke(IPC.MCP_LIST, input)) as RpcMap["mcp.list"],
    toggle: ((input) =>
      ipcRenderer.invoke(IPC.MCP_TOGGLE, input)) as RpcMap["mcp.toggle"],
    enginesSet: ((input) =>
      ipcRenderer.invoke(IPC.MCP_ENGINES_SET, input)) as RpcMap["mcp.enginesSet"],
    authorize: ((input) =>
      ipcRenderer.invoke(IPC.MCP_AUTHORIZE, input)) as RpcMap["mcp.authorize"],
    unauthorize: ((input) =>
      ipcRenderer.invoke(IPC.MCP_UNAUTHORIZE, input)) as RpcMap["mcp.unauthorize"],
    save: ((input) =>
      ipcRenderer.invoke(IPC.MCP_SAVE, input)) as RpcMap["mcp.save"],
    remove: ((input) =>
      ipcRenderer.invoke(IPC.MCP_REMOVE, input)) as RpcMap["mcp.remove"],
    scanImport: ((input) =>
      ipcRenderer.invoke(IPC.MCP_SCAN_IMPORT, input)) as RpcMap["mcp.scanImport"],
    import: ((input) =>
      ipcRenderer.invoke(IPC.MCP_IMPORT, input)) as RpcMap["mcp.import"],
  },

  /** Global instructions, materialized to each engine's consume point. */
  context: {
    get: ((input) =>
      ipcRenderer.invoke(IPC.CONTEXT_GET, input)) as RpcMap["context.get"],
    save: ((input) =>
      ipcRenderer.invoke(IPC.CONTEXT_SAVE, input)) as RpcMap["context.save"],
  },

  /** 工具上下文占用(设置面板):按引擎静态枚举 Mcode 可控的工具 schema 估算。 */
  tools: {
    usage: ((input) => ipcRenderer.invoke(IPC.TOOLS_USAGE, input)) as RpcMap["tools.usage"],
  },

  /** Output styles (settings panel): list built-in + user styles. The
   *  selection is persisted via the generic setting channels and applies to
   *  Claude sessions from the next turn. */
  /** 外部服务集成(自带 API Key)。密钥只经 setKey 出去一次,回来的一律是打码串。 */
  /** OnlyOffice Document Server：Office 文档（docx / xlsx / pptx…）可视化编辑。
   *  编辑器本体由 DS 的 api.js 在渲染端起；这里只管开会话 / 存 / 关 / 配置。 */
  onlyoffice: {
    open: ((input) =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_OPEN, input)) as RpcMap["onlyoffice.open"],
    forceSave: ((input) =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_FORCE_SAVE, input)) as RpcMap["onlyoffice.forceSave"],
    sessionState: ((input) =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_SESSION_STATE, input)) as RpcMap["onlyoffice.sessionState"],
    close: ((input) =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_CLOSE, input)) as RpcMap["onlyoffice.close"],
    status: (() => ipcRenderer.invoke(IPC.ONLYOFFICE_STATUS)) as RpcMap["onlyoffice.status"],
    getConfig: (() =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_GET_CONFIG)) as RpcMap["onlyoffice.getConfig"],
    setConfig: ((input) =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_SET_CONFIG, input)) as RpcMap["onlyoffice.setConfig"],
    detectLocal: (() =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_DETECT_LOCAL)) as RpcMap["onlyoffice.detectLocal"],
    installLocal: ((input) =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_INSTALL_LOCAL, input)) as RpcMap["onlyoffice.installLocal"],
    configureLocal: (() =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_CONFIGURE_LOCAL)) as RpcMap["onlyoffice.configureLocal"],
    installProgress: (() =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_INSTALL_PROGRESS)) as RpcMap["onlyoffice.installProgress"],
    cancelInstall: (() =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_CANCEL_INSTALL)) as RpcMap["onlyoffice.cancelInstall"],
    applyLocal: (() =>
      ipcRenderer.invoke(IPC.ONLYOFFICE_APPLY_LOCAL)) as RpcMap["onlyoffice.applyLocal"],
  },

  outputStyle: {
    list: ((input) =>
      ipcRenderer.invoke(IPC.OUTPUT_STYLE_LIST, input)) as RpcMap["outputStyle.list"],
  },

  /** Usage stats (settings panel): aggregated token/cost usage over the
   *  persisted per-turn history (summary + per-model + per-day heatmap). */
  usage: {
    stats: ((input) =>
      ipcRenderer.invoke(IPC.USAGE_STATS, input)) as RpcMap["usage.stats"],
  },

  /**
   * 把一个拖进来的 `File` 换成它在磁盘上的绝对路径。
   *
   * **Electron 32 起 `File.path` 被移除了** —— 从资源管理器往外拖文件(PDF 导入)
   * 只能走 `webUtils`。它必须在渲染上下文里调用,所以放在 preload 这层。
   */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Mobile companion (LAN pairing + device management) — drives the PC-side
   *  "connect phone" dialog. The mobile HTTP server + pairing handshake itself
   *  lives in main; this only exposes start/cancel/list/revoke/status. */
  mobile: {
    startPairing: ((input) =>
      ipcRenderer.invoke(IPC.MOBILE_START_PAIRING, input)) as RpcMap["mobile.startPairing"],
    cancelPairing: (() => ipcRenderer.invoke(IPC.MOBILE_CANCEL_PAIRING)) as RpcMap["mobile.cancelPairing"],
    listDevices: (() => ipcRenderer.invoke(IPC.MOBILE_LIST_DEVICES)) as RpcMap["mobile.listDevices"],
    revokeDevice: ((input) =>
      ipcRenderer.invoke(IPC.MOBILE_REVOKE_DEVICE, input)) as RpcMap["mobile.revokeDevice"],
    getStatus: (() => ipcRenderer.invoke(IPC.MOBILE_GET_STATUS)) as RpcMap["mobile.getStatus"],
    getActiveCount: (() => ipcRenderer.invoke(IPC.MOBILE_GET_ACTIVE_COUNT)) as RpcMap["mobile.getActiveCount"],
  },

  /** Relay (SSH-based remote access via user's own VPS) — drives the PC-side
   *  "remote access" panel. Save/read VPS config, connect/disconnect. */
  relay: {
    saveConfig: ((input) =>
      ipcRenderer.invoke(IPC.RELAY_SAVE_CONFIG, input)) as RpcMap["relay.saveConfig"],
    getConfig: (() => ipcRenderer.invoke(IPC.RELAY_GET_CONFIG)) as RpcMap["relay.getConfig"],
    connect: (() => ipcRenderer.invoke(IPC.RELAY_CONNECT)) as RpcMap["relay.connect"],
    disconnect: (() => ipcRenderer.invoke(IPC.RELAY_DISCONNECT)) as RpcMap["relay.disconnect"],
    status: (() => ipcRenderer.invoke(IPC.RELAY_STATUS)) as RpcMap["relay.status"],
  },

  /** Agent runtimes (settings panel): the download-on-demand claude/codex/pi
   *  payloads. install() resolves when the whole pipeline finished; live
   *  progress arrives over `on.runtimesEvent`. */
  runtimes: {
    list: (() => ipcRenderer.invoke(IPC.RUNTIMES_LIST)) as RpcMap["runtimes.list"],
    install: ((input) =>
      ipcRenderer.invoke(IPC.RUNTIMES_INSTALL, input)) as RpcMap["runtimes.install"],
    installLocal: ((input) =>
      ipcRenderer.invoke(IPC.RUNTIMES_INSTALL_LOCAL, input)) as RpcMap["runtimes.installLocal"],
    remove: ((input) =>
      ipcRenderer.invoke(IPC.RUNTIMES_REMOVE, input)) as RpcMap["runtimes.remove"],
  },

  /** 文档工具链(设置 → 内核):四个内置文档技能要用的外部工具。
   *  check() 探一遍本机,install/remove 只对应用能管的那几项有效
   *  (pandoc 由应用下载,python-deps 走用户解释器的 pip);进度走
   *  `on.toolchainEvent`。 */
  toolchain: {
    check: (() => ipcRenderer.invoke(IPC.TOOLCHAIN_CHECK)) as RpcMap["toolchain.check"],
    install: ((input) =>
      ipcRenderer.invoke(IPC.TOOLCHAIN_INSTALL, input)) as RpcMap["toolchain.install"],
    remove: ((input) =>
      ipcRenderer.invoke(IPC.TOOLCHAIN_REMOVE, input)) as RpcMap["toolchain.remove"],
  },

  /** 工作流(设置 → 工作流):用户画的流程图,取代原来写死的对话模式。 */
  workflow: {
    list: (() => ipcRenderer.invoke(IPC.WORKFLOW_LIST)) as RpcMap["workflow.list"],
    get: ((input) => ipcRenderer.invoke(IPC.WORKFLOW_GET, input)) as RpcMap["workflow.get"],
    approve: ((input) =>
      ipcRenderer.invoke(IPC.WORKFLOW_APPROVE, input)) as RpcMap["workflow.approve"],
    nodeTypes: (() =>
      ipcRenderer.invoke(IPC.WORKFLOW_NODE_TYPES)) as RpcMap["workflow.nodeTypes"],
    save: ((input) => ipcRenderer.invoke(IPC.WORKFLOW_SAVE, input)) as RpcMap["workflow.save"],
    remove: ((input) =>
      ipcRenderer.invoke(IPC.WORKFLOW_REMOVE, input)) as RpcMap["workflow.remove"],
    // 导出 / 导入(WF-08)。**两个文件对话框都在主进程**,渲染端只给 id 或文本 ——
    // 它读不了任意路径(`file.readFile` 被项目根闸门挡着),也没有保存框那一层 API。
    export: ((input) =>
      ipcRenderer.invoke(IPC.WORKFLOW_EXPORT, input)) as RpcMap["workflow.export"],
    import: ((input) =>
      ipcRenderer.invoke(IPC.WORKFLOW_IMPORT, input)) as RpcMap["workflow.import"],
    importFromFile: ((input) =>
      ipcRenderer.invoke(
        IPC.WORKFLOW_IMPORT_FROM_FILE,
        input,
      )) as RpcMap["workflow.importFromFile"],
    agentProfiles: (() =>
      ipcRenderer.invoke(IPC.WORKFLOW_AGENT_PROFILES)) as RpcMap["workflow.agentProfiles"],
    saveAgentProfile: ((input) =>
      ipcRenderer.invoke(
        IPC.WORKFLOW_SAVE_AGENT_PROFILE,
        input,
      )) as RpcMap["workflow.saveAgentProfile"],
    removeAgentProfile: ((input) =>
      ipcRenderer.invoke(
        IPC.WORKFLOW_REMOVE_AGENT_PROFILE,
        input,
      )) as RpcMap["workflow.removeAgentProfile"],
    // 岔路口上选一条路。**它不是"存一份工作流"那一类** —— 它回答的是一个**还活着的
    // 运行**(那张卡片点下去之前,图一直停在那个节点上等),所以它和对话那边的
    // `claude.respondPlanApproval` 是同一个形状,不是编辑动作。
    choose: ((input) =>
      ipcRenderer.invoke(IPC.WORKFLOW_CHOOSE, input)) as RpcMap["workflow.choose"],
    // 从失败那一步接着跑(失败卡片上的「再试一次」)。**与 `choose` 是同一类** ——
    // 它也是"回答一次已经停在那儿的运行",不是编辑工作流。
    retry: ((input) =>
      ipcRenderer.invoke(IPC.WORKFLOW_RETRY, input)) as RpcMap["workflow.retry"],
  },

  /** 自动化(设置 → 工作流 → 自动化那一栏):触发器节点在**后台**起一条运行,这一组
   *  是那一栏要的三件事 —— 立刻跑一次、看历史、找到那条后台会话。
   *
   *  **手机端不暴露这三个**(那个 RPC 表是手写白名单,见 `main/mobile/mobileRpc.ts`):
   *  手机上要解开的卡是"图停在岔路口等你点",而那件事走的是 `workflow.choose`。 */
  automation: {
    run: ((input) =>
      ipcRenderer.invoke(IPC.AUTOMATION_RUN, input)) as RpcMap["automation.run"],
    runs: ((input) =>
      ipcRenderer.invoke(IPC.AUTOMATION_RUNS, input)) as RpcMap["automation.runs"],
    sessions: ((input) =>
      ipcRenderer.invoke(IPC.AUTOMATION_SESSIONS, input)) as RpcMap["automation.sessions"],
    // 守望(会话输入区那颗按钮):起跑 / 活跃查询 / 命令模板两件。同上,桌面专属。
    watch: ((input) =>
      ipcRenderer.invoke(IPC.AUTOMATION_WATCH, input)) as RpcMap["automation.watch"],
    watchStatus: ((input) =>
      ipcRenderer.invoke(IPC.AUTOMATION_WATCH_STATUS, input)) as RpcMap["automation.watchStatus"],
    watchTemplates: (() =>
      ipcRenderer.invoke(
        IPC.AUTOMATION_WATCH_TEMPLATES,
      )) as RpcMap["automation.watchTemplates"],
    saveWatchTemplates: ((input) =>
      ipcRenderer.invoke(
        IPC.AUTOMATION_WATCH_TEMPLATES_SAVE,
        input,
      )) as RpcMap["automation.watchTemplatesSave"],
    // 全部触发器的事实状态(自动化管理页回答「它怎么没反应」的那份)。
    statusAll: (() =>
      ipcRenderer.invoke(IPC.AUTOMATION_STATUS_ALL)) as RpcMap["automation.statusAll"],
  },

  /** 运行史(某个对话的全部图运行,新的在前):从存档折出来的轻量摘要,
   *  监控/历史页用 —— 整份快照不为一行列表过 IPC(见 `PersistedWorkflowRunLite`)。 */
  runs: {
    history: ((input) =>
      ipcRenderer.invoke(IPC.RUNS_HISTORY, input)) as RpcMap["runs.history"],
  },

  /** 记忆(对话记忆的直读直写):数据根下 `memory/<类目>/*.md` 当普通文件管,
   *  全部按 memory 根下的**相对路径**寻址(契约见 `@contracts` 的 memory.ts)。 */
  memory: {
    assistant: ((input) => ipcRenderer.invoke(IPC.MEMORY_ASSISTANT, input)) as RpcMap["memory.assistant"],
    manage: ((input) => ipcRenderer.invoke(IPC.MEMORY_MANAGE, input)) as RpcMap["memory.manage"],
    list: ((input) => ipcRenderer.invoke(IPC.MEMORY_LIST, input)) as RpcMap["memory.list"],
    read: ((input) => ipcRenderer.invoke(IPC.MEMORY_READ, input)) as RpcMap["memory.read"],
    save: ((input) => ipcRenderer.invoke(IPC.MEMORY_SAVE, input)) as RpcMap["memory.save"],
    delete: ((input) => ipcRenderer.invoke(IPC.MEMORY_DELETE, input)) as RpcMap["memory.delete"],
    categories: (() =>
      ipcRenderer.invoke(IPC.MEMORY_CATEGORIES)) as RpcMap["memory.categories"],
    review: (() => ipcRenderer.invoke(IPC.MEMORY_REVIEW)) as RpcMap["memory.review"],
    reviewDelete: ((input) =>
      ipcRenderer.invoke(IPC.MEMORY_REVIEW_DELETE, input)) as RpcMap["memory.reviewDelete"],
  },

  /** 监控(总览):正在跑几个、触发器挂得怎么样、最近的运行。 */
  monitoring: {
    overview: (() =>
      ipcRenderer.invoke(IPC.MONITORING_OVERVIEW)) as RpcMap["monitoring.overview"],
    runs: ((input) =>
      ipcRenderer.invoke(IPC.MONITORING_RUNS, input)) as RpcMap["monitoring.runs"],
  },

  /** 钩子(设置 → 钩子):某件事发生的时候跑一条你自己的命令。**宿主侧执行**,
   *  所以对话、工作流节点、将来的自动化一视同仁(见 `contracts/hook.ts`)。 */
  hooks: {
    list: (() => ipcRenderer.invoke(IPC.HOOKS_LIST)) as RpcMap["hooks.list"],
    runs: (() => ipcRenderer.invoke(IPC.HOOKS_RUNS)) as RpcMap["hooks.runs"],
    save: ((input) => ipcRenderer.invoke(IPC.HOOKS_SAVE, input)) as RpcMap["hooks.save"],
    remove: ((input) => ipcRenderer.invoke(IPC.HOOKS_REMOVE, input)) as RpcMap["hooks.remove"],
    test: ((input) => ipcRenderer.invoke(IPC.HOOKS_TEST, input)) as RpcMap["hooks.test"],
  },

  /** Plugins (settings panel): install/enable/remove over ~/.mcode/plugins +
   *  marketplace management. Installs land disabled; the panel's review
   *  dialog calls setEnabled. All RPCs resolve when done (no push channel). */
  plugins: {
    list: (() => ipcRenderer.invoke(IPC.PLUGINS_LIST)) as RpcMap["plugins.list"],
    installLocal: ((input) =>
      ipcRenderer.invoke(IPC.PLUGINS_INSTALL_LOCAL, input)) as RpcMap["plugins.installLocal"],
    installGit: ((input) =>
      ipcRenderer.invoke(IPC.PLUGINS_INSTALL_GIT, input)) as RpcMap["plugins.installGit"],
    installMarketplace: ((input) =>
      ipcRenderer.invoke(
        IPC.PLUGINS_INSTALL_MARKETPLACE,
        input,
      )) as RpcMap["plugins.installMarketplace"],
    setEnabled: ((input) =>
      ipcRenderer.invoke(IPC.PLUGINS_SET_ENABLED, input)) as RpcMap["plugins.setEnabled"],
    remove: ((input) => ipcRenderer.invoke(IPC.PLUGINS_REMOVE, input)) as RpcMap["plugins.remove"],
    marketplaceList: (() =>
      ipcRenderer.invoke(IPC.PLUGINS_MARKETPLACE_LIST)) as RpcMap["plugins.marketplaceList"],
    marketplaceAdd: ((input) =>
      ipcRenderer.invoke(
        IPC.PLUGINS_MARKETPLACE_ADD,
        input,
      )) as RpcMap["plugins.marketplaceAdd"],
    marketplaceRemove: ((input) =>
      ipcRenderer.invoke(
        IPC.PLUGINS_MARKETPLACE_REMOVE,
        input,
      )) as RpcMap["plugins.marketplaceRemove"],
    marketplaceRefresh: ((input) =>
      ipcRenderer.invoke(
        IPC.PLUGINS_MARKETPLACE_REFRESH,
        input,
      )) as RpcMap["plugins.marketplaceRefresh"],
  },

  // ── Push events (main → renderer) ──
  on: {
    /** Runtimes push events: download/extract progress and done/error per
     *  agent. Filter by `msg.payload.agent` / `msg.payload.phase`. */
    runtimesEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "runtimes:event" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.RUNTIMES_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.RUNTIMES_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.RUNTIMES_EVENT, listener);
      };
    },
    /** 文档工具链的安装进度。按 `msg.payload.tool` / `phase` 过滤。 */
    toolchainEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "toolchain:event" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.TOOLCHAIN_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.TOOLCHAIN_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.TOOLCHAIN_EVENT, listener);
      };
    },
    /** Subscribe to claude:event push channel. Returns an unsubscribe fn. */
    claudeEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "claude:event" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.CLAUDE_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.CLAUDE_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.CLAUDE_EVENT, listener);
      };
    },
    /** Subscribe to session:titleUpdated push channel. Fired when the main
     *  process's background title-gen routine overwrites a session's title.
     *  The renderer patches its in-memory session lists from this; no IPC
     *  round-trip needed (the DB is already updated). */
    sessionTitleUpdated(handler: (msg: Extract<MainToRendererMessage, { channel: "session:titleUpdated" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.SESSION_TITLE_UPDATED) handler(msg);
      };
      ipcRenderer.on(IPC.SESSION_TITLE_UPDATED, listener);
      return () => {
        ipcRenderer.off(IPC.SESSION_TITLE_UPDATED, listener);
      };
    },
    terminalData(handler: (msg: Extract<MainToRendererMessage, { channel: "terminal:data" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.TERMINAL_DATA) handler(msg);
      };
      ipcRenderer.on(IPC.TERMINAL_DATA, listener);
      return () => {
        ipcRenderer.off(IPC.TERMINAL_DATA, listener);
      };
    },
    /** Fires when a PTY exits (shell `exit`, crash, or kill). */
    terminalExit(handler: (msg: Extract<MainToRendererMessage, { channel: "terminal:exit" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.TERMINAL_EXIT) handler(msg);
      };
      ipcRenderer.on(IPC.TERMINAL_EXIT, listener);
      return () => {
        ipcRenderer.off(IPC.TERMINAL_EXIT, listener);
      };
    },
    /** LSP push events: diagnostics, server log messages, and running-state
     *  changes. Filter by `msg.type` in the handler. */
    lspEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "lsp:event" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.LSP_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.LSP_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.LSP_EVENT, listener);
      };
    },
    /** Browser push events: navigation (URL/title/back/forward), loading state,
     *  pickResult (a clicked element's data), and crashed. Filter by `msg.type`
     *  and `msg.browserId` in the handler. */
    browserEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "browser:event" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.BROWSER_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.BROWSER_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.BROWSER_EVENT, listener);
      };
    },
    /** Fires when the effective theme changes (user picked one, or OS changed
     *  while in 'system' mode). */
    themeChanged(handler: (msg: Extract<MainToRendererMessage, { channel: "theme:changed" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.THEME_CHANGED) handler(msg);
      };
      ipcRenderer.on(IPC.THEME_CHANGED, listener);
      return () => {
        ipcRenderer.off(IPC.THEME_CHANGED, listener);
      };
    },
    /** 库的内容变了 —— **包括 AI 改的**。渲染端收到就重载分类树与条目列表:
     *  用户在界面上操作时缓存自己对,AI 操作时缓存不会自己知道(见契约里的注释)。 */
    libraryChanged(handler: (msg: Extract<MainToRendererMessage, { channel: "library:changed" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.LIBRARY_CHANGED) handler(msg);
      };
      ipcRenderer.on(IPC.LIBRARY_CHANGED, listener);
      return () => {
        ipcRenderer.off(IPC.LIBRARY_CHANGED, listener);
      };
    },
    /** 工作流那一摊变了(工作流 / 自动化 / 代理档案 / 节点类型)—— **包括 AI 改的**。
     *  设置里那份列表是渲染端自己缓存的,AI 走 MCP 改的是数据根里那份真相,缓存不会
     *  自己知道。收到就重拉列表 —— ⚠️ **不要顺手重载正在编辑的那一份文档**,理由写在
     *  `@contracts/ipc` 的 `WorkflowChangedMessage` 上。 */
    workflowsChanged(handler: (msg: Extract<MainToRendererMessage, { channel: "workflow:changed" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.WORKFLOW_CHANGED) handler(msg);
      };
      ipcRenderer.on(IPC.WORKFLOW_CHANGED, listener);
      return () => {
        ipcRenderer.off(IPC.WORKFLOW_CHANGED, listener);
      };
    },
    /** AI 往这次对话挂了一个附件 —— 渲染端把它加成输入框里的一个标签,效果与用户
     *  自己挂完全一致(能删、参与去重、随下一条消息发出去)。 */
    composerAttach(handler: (msg: Extract<MainToRendererMessage, { channel: "composer:attach" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.COMPOSER_ATTACH) handler(msg);
      };
      ipcRenderer.on(IPC.COMPOSER_ATTACH, listener);
      return () => {
        ipcRenderer.off(IPC.COMPOSER_ATTACH, listener);
      };
    },
    /** Fires when the updater finds a newer version on the release channel.
     *  autoDownload is off, so the renderer should prompt the user to download. */
    updateAvailable(handler: (msg: Extract<MainToRendererMessage, { channel: "update:available" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.UPDATE_AVAILABLE) handler(msg);
      };
      ipcRenderer.on(IPC.UPDATE_AVAILABLE, listener);
      return () => {
        ipcRenderer.off(IPC.UPDATE_AVAILABLE, listener);
      };
    },
    /** Fires repeatedly while an update downloads, carrying percent + byte
     *  counts so the About panel can render a progress bar. */
    updateDownloadProgress(handler: (msg: Extract<MainToRendererMessage, { channel: "update:downloadProgress" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.UPDATE_DOWNLOAD_PROGRESS) handler(msg);
      };
      ipcRenderer.on(IPC.UPDATE_DOWNLOAD_PROGRESS, listener);
      return () => {
        ipcRenderer.off(IPC.UPDATE_DOWNLOAD_PROGRESS, listener);
      };
    },
    /** Fires when a downloaded update is ready to install. */
    updateDownloaded(handler: (msg: Extract<MainToRendererMessage, { channel: "update:downloaded" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.UPDATE_DOWNLOADED) handler(msg);
      };
      ipcRenderer.on(IPC.UPDATE_DOWNLOADED, listener);
      return () => {
        ipcRenderer.off(IPC.UPDATE_DOWNLOADED, listener);
      };
    },
    /** Fires when the main window gains or loses focus (app switch, minimize,
     *  restore). The renderer uses this to decide whether background events
     *  warrant an OS notification or just an in-app badge. */
    windowFocusChanged(handler: (msg: Extract<MainToRendererMessage, { channel: "window:focusChanged" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.WINDOW_FOCUS_CHANGED) handler(msg);
      };
      ipcRenderer.on(IPC.WINDOW_FOCUS_CHANGED, listener);
      return () => {
        ipcRenderer.off(IPC.WINDOW_FOCUS_CHANGED, listener);
      };
    },
    /** Fires when the user clicks an OS notification. Main has already shown +
     *  focused the window; this event tells the renderer which session to
     *  navigate to. */
    notificationFocusSession(handler: (msg: Extract<MainToRendererMessage, { channel: "notification:focusSession" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.NOTIFICATION_FOCUS_SESSION) handler(msg);
      };
      ipcRenderer.on(IPC.NOTIFICATION_FOCUS_SESSION, listener);
      return () => {
        ipcRenderer.off(IPC.NOTIFICATION_FOCUS_SESSION, listener);
      };
    },
    /** Relay state changes (connecting, deployed, connected, error). */
    relayEvent(handler: (msg: Extract<MainToRendererMessage, { channel: "relay:event" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.RELAY_EVENT) handler(msg);
      };
      ipcRenderer.on(IPC.RELAY_EVENT, listener);
      return () => {
        ipcRenderer.off(IPC.RELAY_EVENT, listener);
      };
    },
    /** Live ASR results (partial/final) for an active voice-input session. */
    voiceResult(handler: (msg: Extract<MainToRendererMessage, { channel: "voice:result" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.VOICE_RESULT) handler(msg);
      };
      ipcRenderer.on(IPC.VOICE_RESULT, listener);
      return () => {
        ipcRenderer.off(IPC.VOICE_RESULT, listener);
      };
    },
    /** Voice-model download progress (Settings → 语音输入 → 下载语言模型). */
    voiceDownloadProgress(handler: (msg: Extract<MainToRendererMessage, { channel: "voice:downloadProgress" }>) => void): () => void {
      const listener = (_e: unknown, msg: MainToRendererMessage) => {
        if (msg.channel === IPC.VOICE_DOWNLOAD_PROGRESS) handler(msg);
      };
      ipcRenderer.on(IPC.VOICE_DOWNLOAD_PROGRESS, listener);
      return () => {
        ipcRenderer.off(IPC.VOICE_DOWNLOAD_PROGRESS, listener);
      };
    },
  },
} as const;

contextBridge.exposeInMainWorld("api", api);
// Explicit Electron marker — read by renderer/lib/platform.ts to pick the
// desktop vs. web shell. Deliberately NOT derived from UA: Electron-based
// third-party webviews (which have no preload) would otherwise be mis-classed
// as the desktop shell. Only a real Mcode window (with this preload) carries
// the marker, and it's set before any page script runs, so the check is
// immune to module-evaluation order.
contextBridge.exposeInMainWorld("mcodeElectron", true);

// Type declaration so the renderer sees `window.api`.
export type Api = typeof api;
