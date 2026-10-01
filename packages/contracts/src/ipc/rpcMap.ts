import type { ProjectInitTemplate, ProjectInitList, ProjectInitSaveInput, ProjectInitPreviewInput, ProjectInitApplyInput, ProjectInitPreview, ProjectInitResult } from "./projectInit.js";
import { MEMORY_ASSISTANT_CHANNEL, type MemoryAssistantInput, type MemoryAssistantResult } from "../memoryAssistant.js";
import { MEMORY_MANAGE_CHANNEL, type MemoryManageInput, type MemoryManageResult } from "../memory.js";
/**
 * `RpcMap` — 全部 renderer→main RPC 的类型化总表。preload 按它暴露
 * `window.api`,渲染端按它获得类型安全。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。它是所有域文件的**汇聚点**:加一个
 * RPC 通道 = 域文件加 schema + 这里加一行映射。
 */

import { z } from "zod";
import type { Project, Session, MessageRecord } from "../session.js";
import type { BuiltinModelOption } from "../provider.js";
import type {
  CustomModelPublic,
  ExtensionBridgeStatus,
  PublicMcpStatus,
  PublicMcpTunnelConfig,
  TestCustomModelResult,
} from "../customModel.js";
import type { PiProviderPublic } from "../piModel.js";
import type { CodexProviderPublic } from "../codexModel.js";
import type { NodeTypeCatalog } from "../nodeType.js";
import type { AgentProfileCatalog } from "../agentProfile.js";
import type { HookSpec, HookRun } from "../hook.js";
import type { WorkflowDoc, WorkflowListEntry, WorkflowReviewInfo } from "../workflow.js";
import type { PluginState, PluginMarketplaceState, PluginsInstallLocalInput, PluginsInstallGitInput, PluginsInstallMarketplaceInput, PluginsSetEnabledInput, PluginsRemoveInput, PluginsMarketplaceAddInput, PluginsMarketplaceRemoveInput, PluginsMarketplaceRefreshInput } from "../plugin.js";
import type { PairingStartResult, PairedDevice } from "../mobile.js";
import type { RelayStatus, RelayVpsConfig, RelayVpsConfigInput } from "../relay.js";
import type { LibraryItem, LibraryItemLink, LibraryLinkView, LibraryCollection, InstitutionProfile, FullTextMatch, AuthSiteStatus, LibraryConversionRow, LibraryNote, PdfHighlight } from "../library.js";
import type { LibraryGroupMeta, LibrarySuppressRule } from "../libraryTypes.js";
import type { GetSettingInput, SetSettingInput, GetManySettingsInput, GetManySettingsResult, GetVoiceModelDirInput, GetVoiceModelDirResult, SetVoiceModelDirInput, SetVoiceModelDirResult, NotificationPrefs } from "./settings.js";
import type { StartSessionInput, ListSideChatsInput, SendTurnInput, InterruptInput, InjectInput, ApproveInput, RespondQuestionInput, RespondPlanApprovalInput, RewindTurnInput, UpdateSessionSettingsInput, CreateProjectInput, ProjectSessionsInput, SessionListAllInput, SetProjectGroupInput, ReorderProjectsInput, PinProjectInput, RenameProjectInput, SessionSearchInput, BookmarkSearchInput, BookmarkSearchResult, SessionMessagesInput, SaveMessagesInput, UpsertMessagesInput, TruncateAndInsertMessagesInput, RenameSessionInput, ForkSessionInput, PinSessionInput, UpdateBookmarksInput, OpenPathInput, ShowItemInFolderInput, OpenFileInput, SessionListNodesInput, SessionHasNodesInput } from "./session.js";
import type { VoiceStartInput, VoiceFeedInput, VoiceStopInput, VoiceStopResult, VoiceCancelInput, VoiceModelListResult, VoiceDownloadModelInput } from "./voice.js";
import type { FocusSessionInput, SetNotificationPrefsInput } from "./notifications.js";
import type { SaveCustomModelInput, TestCustomModelInput, GetCustomModelTokenInput, SavePiProviderInput, DeletePiProviderInput, GetPiApiKeyInput, SaveCodexProviderInput, DeleteCodexProviderInput, GetCodexApiKeyInput, ProviderHealthCheckInput, ProviderHealthCheckResult, ProviderCommandsInput, ProviderCommandsResult } from "./providers.js";
import type { GetThemeResult, SetThemeInput, AppInfoResult, CheckForUpdatesResult } from "./app.js";
import type { FileReadInput, FileReadBinaryInput, PickImagesInput, PickedImage, ClipboardSaveFileInput, ClipboardSaveFileResult, ClipboardWriteImageInput, ClipboardWriteImageResult, FileListDirInput, FileTreeEntry, FileSearchInput, FileSearchResult, FileWriteInput, FileMkdirInput, FileDeleteInput, FileRenameInput, FileCopyInput, FileGrepInput, FileGrepResult, RgStatusResult, RgInstallInput, RgInstallResult, DialogPickFilesInput } from "./files.js";
import type { GitDiscoverReposInput, GitRepo, GitRepoPathInput, GitStatusResult, GitStageInput, GitOpResult, GitUnstageInput, GitCommitInput, GitDiffInput, GitFileBlobInput, GitDiscardInput, GitGenerateCommitInput, GitCancelGenerateCommitInput, GitLogInput, GitCommitInfo, GitShowCommitInput, GitCommitDetail, GitShowFileInput, GitBranchListResult, GitCheckoutInput, GitDeleteBranchInput, GitMergeInput, GitMergePreviewResult, GitMergeResult, GitWorktreeListInput, GitWorktreeInfo, GitWorktreeStatusInput, GitWorktreeMergeBackInput, GitWorktreeMergeBackResult, GitWorktreeRemoveInput, GitWorktreeRemoveResult } from "./git.js";
import type { TerminalCreateInput, TerminalCreateResult, TerminalWriteInput, TerminalOpResult, TerminalResizeInput, TerminalKillInput, TerminalListInput, TerminalInfo } from "./terminal.js";
import type { BrowserCreateInput, BrowserCreateResult, BrowserLoadUrlInput, BrowserOpResult, BrowserGoBackInput, BrowserGoForwardInput, BrowserReloadInput, BrowserSetBoundsInput, BrowserSetPickModeInput, BrowserShowInput, BrowserHideInput, BrowserCloseInput, BrowserCaptureFrameInput, BrowserCaptureFrameResult, BrowserBookmarkAddInput, BrowserBookmarkRemoveInput, BrowserSetDeviceInput, BrowserHistoryRemoveInput, BrowserHistoryClearInput, BrowserAuthRespondInput, BrowserDownloadActionInput } from "./browser.js";
import type { SkillsListInput, SkillInfo, SkillsReadInput, SkillsSaveInput, SkillsDeleteInput, SkillsEnginesSetInput, SkillEngineState, SkillBundle, SkillsBundlesInput, SkillsEnginesSetBulkInput, SkillsScanSourcesInput, ExternalSkillInfo, SkillsImportInput, SkillsImportGithubInput, SkillsImportGithubResult, SkillsCopyToProjectInput, SkillsCopyToProjectResult,
  SkillPreset, SkillsPresetSaveInput, SkillsPresetDeleteInput,
  SkillsProjectOverviewInput, SkillsProjectOverviewResult,
  ProviderInfo, OutputStyleListInput, OutputStyleEntry } from "./skills.js";
import type { McpListInput, McpServerEntry, McpToggleInput, McpAuthorizeInput, McpUnauthorizeInput, McpSaveInput, McpRemoveInput, McpScanImportInput, McpImportSource, McpImportInput, McpEnginesSetInput, McpEngineState } from "./mcp.js";
import type { ContextGetInput, ContextSaveInput, ToolsUsageGetInput, ToolsUsageResult } from "./context.js";
import type { UsageStatsInput, UsageStatsResult } from "./usage.js";
import type { LspLanguageState, LspInstallInput, LspOpResult, LspInstallFromFileInput, LspUninstallInput, LspToggleInput, LspSetPathInput, LspHealthCheckInput, LspPrewarmInput, LspRestartInput, LspOpenDocInput, LspCloseDocInput, LspDidChangeInput, LspDidSaveInput, LspRequestInput, LspRequestResult } from "./lsp.js";
import type { RuntimeAgentState, RuntimesInstallInput, RuntimesInstallLocalInput, RuntimesRemoveInput, ToolchainToolState, ToolchainInstallInput, ToolchainRemoveInput } from "./runtimes.js";
import type { WorkflowApproveInput, WorkflowPinDefaultInput, WorkflowRestoreDefaultInput, WorkflowShippedUpdateInput } from "./workflow.js";
import type { WorkflowGetInput, WorkflowSaveInput, WorkflowRemoveInput, WorkflowExportInput, WorkflowImportInput, AgentProfileSaveInput, AgentProfileRemoveInput, WorkflowChooseInput, WorkflowRetryInput, HooksSaveInput, HooksRemoveInput, HooksTestInput, AutomationRunInput, AutomationRunsInput, AutomationSessionsInput, AutomationRunEntry, WatchStartInput, WatchStatusInput, WatchTemplatesSaveInput, WatchCommandTemplate } from "./workflow.js";
import type { AutomationTriggerFacts, MonitoringOverview, MonitoringRunSummary, MonitoringRunsInput, PersistedWorkflowRunLite, RunsHistoryInput } from "./orchestration.js";
import { MEMORY_CATEGORIES_CHANNEL, MEMORY_DELETE_CHANNEL, MEMORY_LIST_CHANNEL, MEMORY_READ_CHANNEL, MEMORY_REVIEW_CHANNEL, MEMORY_REVIEW_DELETE_CHANNEL, MEMORY_SAVE_CHANNEL, type MemoryDeleteInput, type MemoryFileMeta, type MemoryListInput, type MemoryReadInput, type MemoryReviewDeleteInput, type MemoryReviewResult, type MemorySaveInput } from "../memory.js";
import type { LibraryGroupsGetInput, LibraryGroupsSaveInput, LibraryImportGenericInput, LibraryReadFileInput, LibraryFileContent, LibraryListInput, LibraryItemIdInput, LibraryAddItemsInput, LibraryDeleteItemsInput, LibraryDeleteItemsResult, LibraryRestoreItemsInput, LibraryDeletePreviewInput, LibraryDeletePreviewResult, LibraryImportFilesInput, LibraryImportNotesInput, LibraryConvertInput, LibraryRevealFileInput, LibraryOpenFileInput, LibraryEntryPathInput, LibraryEntryPathResult, PdfHighlightsReadInput, PdfHighlightsSaveInput, PdfHighlightsWriteBackInput, PdfHighlightsWriteResult, LibraryReadMarkdownInput, LibraryNotesListInput, LibraryNoteSaveInput, LibraryNoteDeleteInput, LibraryRenameItemInput, LibraryCreateNoteInput, LibraryWriteNoteInput, LibraryAdoptMarkdownInput, LibraryReadPdfInput, LibraryFullTextSearchInput, LibraryManifestInput, LibraryItemManifestInput, LibraryAttachToChatInput, LibrarySuppressGetInput, LibrarySuppressSaveInput, LibraryLinksOfInput, LibraryLinkCountsInput, LibraryLinkAddInput, LibraryLinkRemoveInput, CollectionCreateInput, CollectionRenameInput, CollectionDeleteInput, CollectionMoveInput, CollectionAssignInput, InstitutionSaveInput, InstitutionDeleteInput, InstitutionAuthStatusInput, InstitutionClearCookiesInput } from "./library.js";
import type { OnlyOfficeOpenInput, OnlyOfficeOpenResult, OnlyOfficeSessionInput, OnlyOfficeSessionState, OnlyOfficeStatusResult, OnlyOfficeConfig, OnlyOfficeSetConfigInput, OnlyOfficeLocalDetectResult } from "./onlyoffice.js";
import type { SubagentDefinition } from "../claudeSubagent.js";
import type { ClaudeSubagentsSaveInput } from "../claudeSubagent.js";
import type { CustomUiRunAutomationInput, CustomUiRunAutomationResult } from "../customUi.js";

/* ──────────────────────────  RPC method map  ───────────────────────────────── */

/** Revoke a paired mobile device. Input to `mobile.revokeDevice`. */
export const RevokeMobileDeviceSchema = z.object({ deviceId: z.string().min(1) });

/** Save the whole custom-subagent list (Settings → 子代理). Validated
 *  main-side by subagentStore.saveSubagents — the zod layer only guards the
 *  envelope; per-definition rules (name shape, non-empty prompts) live there
 *  so load/save/SDK-mapping share one source of truth. */
export const ClaudeSubagentsSaveSchema = z.object({ subagents: z.array(z.record(z.unknown())) });

/** A typed map of all renderer→main RPC invocations. The preload exposes a
 * typed `window.api` matching this shape; the renderer imports it for safety. */
export interface RpcMap {
  "modules.catalog": () => Promise<import("../modules.js").ModuleCatalog>;
  "modules.install": (input: import("./modules.js").ModuleInstallInput) => Promise<import("../modules.js").ModuleCatalog>;
  "modules.remove": (input: {moduleId:string}) => Promise<import("../modules.js").ModuleCatalog>;
  "modules.invoke": (input: import("../modules.js").ModuleInvoke) => Promise<import("../modules.js").ModuleReply>;
  "modules.task": (input: import("../modules.js").ModuleTaskRef) => Promise<import("../modules.js").ModuleTask>;
  "modules.cancel": (input: import("../modules.js").ModuleTaskRef) => Promise<import("../modules.js").ModuleTask>;
  "modules.tasks": (input: {projectPath:string}) => Promise<import("../modules.js").ModuleTask[]>;
  // Claude
  "claude.startSession": (input: StartSessionInput) => Promise<{ session: Session }>;
  /** List a main session's side chats (kind="side"), newest first. */
  "claude.listSideChats": (input: ListSideChatsInput) => Promise<{ sessions: Session[] }>;
  /** Returns the (possibly retitled) session so the renderer can refresh. */
  "claude.sendTurn": (input: SendTurnInput) => Promise<{ session: Session }>;
  "claude.interrupt": (input: InterruptInput) => Promise<void>;
  /**
   * 往正在跑的那一轮里塞一句话。返回 `{ delivered }` —— **"收下了没有",不是"发出去了
   * 没有"**:这一轮刚好收尾、或者引擎不支持,都是 `false`,渲染端据此**兜回普通的发送**
   * (见 `sessionStore.injectPrompt`)。用户打了字而什么都没发生,是最糟的一种结果。
   */
  "claude.inject": (input: InjectInput) => Promise<{ delivered: boolean }>;
  "claude.approve": (input: ApproveInput) => Promise<void>;
  /** Submit the user's answers to a pending AskUserQuestion. */
  "claude.respondQuestion": (input: RespondQuestionInput) => Promise<void>;
  /** Submit the user's approve/reject decision on a pending ExitPlanMode plan. */
  "claude.respondPlanApproval": (input: RespondPlanApprovalInput) => Promise<void>;
  /** Rewind a turn: restore the given files to their pre-turn state.
   *  Works for the latest turn, any historical turn, or a session
   *  reopened after restart (the renderer passes the explicit entries).
   *  Returns the list of paths that were actually restored (failed
   *  paths are silently logged in main). */
  "claude.rewindTurn": (input: RewindTurnInput) => Promise<{ restored: string[] }>;
  /** Save the whole custom-subagent list (Settings → 子代理). Main validates
   *  each definition and persists to `claude.subagents`; returns the saved
   *  list so the editor can snap to what actually landed. */
  "claude.saveSubagents": (input: ClaudeSubagentsSaveInput) => Promise<{ subagents: SubagentDefinition[] }>;
  /** Update the active session's model / effort / permissionMode / customModelId in-place. */
  "session.updateSettings": (input: UpdateSessionSettingsInput) => Promise<void>;
  // Projects
  "project.create": (input: CreateProjectInput) => Promise<{ project: Project }>;
  "project.list": () => Promise<{ projects: Project[] }>;
  "project.sessions": (input: ProjectSessionsInput) => Promise<{ sessions: Session[]; hasMore: boolean; total: number }>;
  /** Cross-project non-archived sessions, newest-first (stream sidebar). */
  "session.listAll": (input: SessionListAllInput) => Promise<{ sessions: Session[]; hasMore: boolean; total: number }>;
  /** The workflow-node sessions of ONE conversation — "which step has a session,
   *  and what is it called". Read-only, and the only way a node session is ever
   *  listed: every other query pins `kind = 'chat'`.
   *
   *  Why it exists: a node session is where a step's history lives, and after a
   *  restart the live board is empty — this is what lets the UI offer "keep
   *  talking to that step" for a run that already ended. */
  "session.listNodes": (input: SessionListNodesInput) => Promise<{ sessions: Session[] }>;
  "session.hasNodes": (input: SessionHasNodesInput) => Promise<{ has: boolean }>;
  /** Hard-delete a project; its sessions + messages cascade-delete (DB FK). */
  "project.delete": (input: { id: string }) => Promise<void>;
  /** Set a project's archived flag (soft-delete; restorable). */
  "project.archive": (input: { id: string; archived: boolean }) => Promise<{ project: Project }>;
  /** Assign a project to a group (left-bar "grouped" view); null removes it. */
  "project.setGroup": (input: SetProjectGroupInput) => Promise<{ project: Project }>;
  /** Persist a drag-to-reorder: writes sort_order = index for each id. */
  "project.reorder": (input: ReorderProjectsInput) => Promise<void>;
  /** Pin/unpin a project (top-of-left-bar pinned section). Returns the updated row. */
  "project.pin": (input: PinProjectInput) => Promise<{ project: Project }>;
  /** Rename a project (display-only). Returns the updated row. */
  "project.rename": (input: RenameProjectInput) => Promise<{ project: Project }>;
  // Sessions (P2 persistence)
  /** Cross-project session search by title substring (Ctrl+K unified search). */
  "session.search": (input: SessionSearchInput) => Promise<{ sessions: Session[] }>;
  /** Cross-session bookmark search (Ctrl+K unified search). */
  "session.searchBookmarks": (input: BookmarkSearchInput) => Promise<{ results: BookmarkSearchResult[] }>;
  /** All pinned non-archived sessions across projects (most recent pin
   *  first) — powers the left bar's global pinned section above the project
   *  tree. */
  "session.listPinned": () => Promise<{ sessions: Session[] }>;
  "session.messages": (
    input: SessionMessagesInput,
  ) => Promise<{ messages: MessageRecord[]; hasMore: boolean }>;
  "session.saveMessages": (input: SaveMessagesInput) => Promise<void>;
  "session.upsertMessages": (input: UpsertMessagesInput) => Promise<void>;
  "session.truncateAndInsertMessages": (
    input: TruncateAndInsertMessagesInput,
  ) => Promise<void>;
  /** Hard-delete a session; its messages cascade-delete (DB FK). */
  "session.delete": (input: { id: string }) => Promise<void>;
  /** Set a session's archived flag (soft-delete; restorable). */
  "session.archive": (input: { id: string; archived: boolean }) => Promise<{ session: Session }>;
  /** Rename a session (persist a user-edited title). Returns the updated row. */
  "session.rename": (input: RenameSessionInput) => Promise<{ session: Session }>;
  /** 把一段对话复制成新的一段:上下文原样带过去,两边之后各走各的。 */
  "session.fork": (input: ForkSessionInput) => Promise<{ session: Session }>;
  /** Pin/unpin a session (project-scoped). Returns the updated row. */
  "session.pin": (input: PinSessionInput) => Promise<{ session: Session }>;
  /** Replace a session's bookmark list (full-array write). Returns the updated row. */
  "session.updateBookmarks": (input: UpdateBookmarksInput) => Promise<{ session: Session }>;
  // Providers
  "provider.list": () => Promise<{ providers: ProviderInfo[] }>;
  /** Probe the selected registered provider through its own health check. */
  "provider.healthCheck": (input: ProviderHealthCheckInput) => Promise<ProviderHealthCheckResult>;
  /**
   * 问引擎要**它自己的斜杠命令清单**（2026-09-21）。
   *
   * ## 为什么不能只靠事件
   *
   * 清单的**权威来源**是引擎在每轮 `system/init` 里推的 `slash_commands`
   * （见 `@contracts/runtime` 的 `CommandsAvailableEvent`）。但那条路有个致命的时机问题：
   * init 只在**开跑一轮**时才来。而用户想打开 `/` 菜单看有哪些命令，恰恰是在
   * **还没发过消息**的时候 —— 也就是清单还空着的时候。
   *
   * 所以这一条把清单的获取**提前到会话建立时**（Claude 的 `supportedCommands()`
   * 不需要跑任何一轮就会答，且**带说明**）。事件那条路留着，因为它是唯一能反映
   * "引擎中途换了清单"（装了插件、动态发现技能）的来源。
   */
  "provider.commands": (input: ProviderCommandsInput) => Promise<ProviderCommandsResult>;
  // Settings
  "setting.get": (input: GetSettingInput) => Promise<{ value: string | null }>;
  "setting.set": (input: SetSettingInput) => Promise<void>;
  "setting.getMany": (input: GetManySettingsInput) => Promise<GetManySettingsResult>;
  // Voice input
  "voice.start": (input: VoiceStartInput) => Promise<void>;
  "voice.feed": (input: VoiceFeedInput) => Promise<void>;
  "voice.stop": (input: VoiceStopInput) => Promise<VoiceStopResult>;
  "voice.cancel": (input: VoiceCancelInput) => Promise<void>;
  /** List the model catalog + downloaded models + active selection. */
  "voice.modelList": () => Promise<VoiceModelListResult>;
  /** Begin downloading a catalog model. Returns immediately; progress arrives
   *  on the `voice:downloadProgress` push. */
  "voice.downloadModel": (input: VoiceDownloadModelInput) => Promise<void>;
  /** Cancel an in-flight model download (no-op if none). */
  "voice.cancelModelDownload": (input: VoiceDownloadModelInput) => Promise<void>;
  /** Persist the active voice model selection for the composer mic button. */
  "voice.selectModel": (input: VoiceDownloadModelInput) => Promise<void>;
  /** Delete a downloaded model's local files (the active selection is
   *  re-pointed at another downloaded model, or cleared). */
  "voice.removeModel": (input: VoiceDownloadModelInput) => Promise<void>;
  /** Read the current effective voice model root (custom or default). */
  "voice.getModelDir": (input: GetVoiceModelDirInput) => Promise<GetVoiceModelDirResult>;
  /** Change the voice model root directory. Empty string = default. The new
   *  path is scanned; already-present catalog models appear as "downloaded"
   *  in the returned list, no re-download required. */
  "voice.setModelDir": (input: SetVoiceModelDirInput) => Promise<SetVoiceModelDirResult>;
  // Notifications
  /** Get the user's notification preferences (typed wrapper over settings). */
  "notification.getPrefs": () => Promise<{ prefs: NotificationPrefs }>;
  /** Set (persist) the user's notification preferences. */
  "notification.setPrefs": (input: SetNotificationPrefsInput) => Promise<{ prefs: NotificationPrefs }>;
  /** Focus a session after an OS notification click. Main shows + focuses the
   *  window, then pushes `notification:focusSession` so the renderer navigates. */
  "notification.focusSession": (input: FocusSessionInput) => Promise<void>;
  // Custom models (user-defined Anthropic-compatible endpoints)
  "customModel.list": () => Promise<{ models: CustomModelPublic[] }>;
  "customModel.save": (input: SaveCustomModelInput) => Promise<{ models: CustomModelPublic[] }>;
  "customModel.delete": (input: { id: string }) => Promise<{ models: CustomModelPublic[] }>;
  "customModel.test": (input: TestCustomModelInput) => Promise<TestCustomModelResult>;
  /** Settings UI eye-icon only — returns cleartext token for display. */
  "customModel.getToken": (input: GetCustomModelTokenInput) => Promise<{ token: string | null }>;
  /** 设置页只读快照：扩展桥地址 / 令牌 / 是否已配对。会顺带把服务拉起来。 */
  "webBridge.status": () => Promise<ExtensionBridgeStatus>;
  /** 换一个配对令牌（旧令牌立刻失效，已连上的扩展会被断开重连）。 */
  "webBridge.regenerateToken": () => Promise<ExtensionBridgeStatus>;
  /** 公网 MCP 端点：把 mcode 的工具表暴露给互联网上的 MCP 客户端（ChatGPT 的
   *  Connector）。只读快照，含路径密钥（明文，要显示给用户复制）。 */
  "publicMcp.status": () => Promise<PublicMcpStatus>;
  /** 开关这条公网通路。打开时现建「ChatGPT 直连」合成会话并起监听；关闭时停服务。
   *  ⚠️ 打开 = 拿到链接的人拥有本机完全操作权（无审批闸门，见 publicMcpServer.ts）。 */
  "publicMcp.setEnabled": (input: { enabled: boolean }) => Promise<PublicMcpStatus>;
  /** 换一把路径密钥（旧链接立刻失效）。这是用户唯一的"拉闸"手段。 */
  "publicMcp.regenerateSecret": () => Promise<PublicMcpStatus>;
  /** 起公网隧道（Mcode 自己 spawn cloudflared），成功后 `tunnelUrl` 带上域名。 */
  "publicMcp.startTunnel": () => Promise<PublicMcpStatus>;
  /** 停公网隧道（开关仍开着，只是不再对外暴露）。 */
  "publicMcp.stopTunnel": () => Promise<PublicMcpStatus>;
  /** 改沙箱目录 —— 公网进来的文件工具能碰哪个项目。传 null 取消选择。 */
  "publicMcp.setProject": (input: { projectId: string | null }) => Promise<PublicMcpStatus>;
  /** 存隧道配置(模式 / 自有域名 / Tunnel Token / 固定端口)。
   *  token 留空 = 沿用已存的那串;返回的状态里**只带尾 4 位**。 */
  "publicMcp.setTunnelConfig": (input: PublicMcpTunnelConfig) => Promise<PublicMcpStatus>;
  // Pi models (visual editor for ~/.pi/agent/models.json)
  "piModels.list": () => Promise<{ providers: Record<string, PiProviderPublic> }>;
  "piModels.save": (input: SavePiProviderInput) => Promise<{ providers: Record<string, PiProviderPublic> }>;
  "piModels.delete": (input: DeletePiProviderInput) => Promise<{ providers: Record<string, PiProviderPublic> }>;
  /** Returns cleartext apiKey. Used two ways: (1) main-process turn-time
   *  injection into the pi authStorage; (2) the settings UI's eye-icon view
   *  (same security carve-out as customModel.getToken). */
  "piModels.getApiKey": (input: GetPiApiKeyInput) => Promise<{ apiKey: string | null }>;
  /** List models the SDK can authenticate with the current configured keys.
   *  Builds a fresh ModelRuntime with all encrypted apiKeys injected, then
   *  returns getAvailable() projected into BuiltinModelOption[] shape for
   *  the composer's model picker. */
  "piModels.listAvailable": () => Promise<{ models: BuiltinModelOption[] }>;
  // Codex model providers (visual editor for <CODEX_HOME>/config.toml's
  // [model_providers]; keys live in the encrypted settings map)
  "codexModels.list": () => Promise<{ providers: CodexProviderPublic[] }>;
  "codexModels.save": (input: SaveCodexProviderInput) => Promise<{ providers: CodexProviderPublic[] }>;
  "codexModels.delete": (input: DeleteCodexProviderInput) => Promise<{ providers: CodexProviderPublic[] }>;
  /** Settings UI eye-icon only — same security carve-out as
   *  customModel.getToken / piModels.getApiKey. */
  "codexModels.getApiKey": (input: GetCodexApiKeyInput) => Promise<{ apiKey: string | null }>;
  // Theme / color scheme
  "theme.get": () => Promise<GetThemeResult>;
  "theme.set": (input: SetThemeInput) => Promise<GetThemeResult>;
  // File read (on-demand diff rendering)
  "file.readFile": (input: FileReadInput) => Promise<{ content: string }>;
  /** Read a binary file as a base64 data URL (image preview). Same path guard. */
  "file.readBinary": (input: FileReadBinaryInput) => Promise<{ dataUrl: string }>;
  /** OS dialog image picker → base64 images (composer 图片 button). */
  "file.pickImages": (input: PickImagesInput) => Promise<{ images: PickedImage[]; skipped: string[] }>;
  /** Persist a clipboard-pasted external file to a temp path (composer paste). */
  "clipboard.saveFile": (input: ClipboardSaveFileInput) => Promise<ClipboardSaveFileResult>;
  /** Copy an image data URL onto the OS clipboard (image lightbox 复制). */
  "clipboard.writeImage": (input: ClipboardWriteImageInput) => Promise<ClipboardWriteImageResult>;
  /** List one level of a directory (non-recursive), scoped to a project root. */
  "file.listDir": (input: FileListDirInput) => Promise<{ entries: FileTreeEntry[] }>;
  /** Recursive file search under a project root (composer @ / add-context). */
  "file.search": (input: FileSearchInput) => Promise<FileSearchResult>;
  /** Write content to a file (creates parents), scoped to a project root. */
  "file.writeFile": (input: FileWriteInput) => Promise<{ ok: boolean }>;
  /** Create a directory (recursive), scoped to a project root. */
  "file.mkdir": (input: FileMkdirInput) => Promise<{ ok: boolean }>;
  /** Delete a file or directory (moves to system trash), scoped to a project root. */
  "file.delete": (input: FileDeleteInput) => Promise<{ ok: boolean }>;
  /** Rename a file or directory in place, scoped to a project root. */
  "file.rename": (input: FileRenameInput) => Promise<{ ok: boolean }>;
  "file.copy": (input: FileCopyInput) => Promise<{ ok: boolean }>;
  /** Grep file contents under a project root (line-level matches). */
  "file.grep": (input: FileGrepInput) => Promise<FileGrepResult>;
  /** ripgrep availability snapshot (drives the search-dialog install banner). */
  "rg.status": () => Promise<RgStatusResult>;
  /** Download + install the ripgrep binary into userData/bin (one-click). */
  "rg.install": (input: RgInstallInput) => Promise<RgInstallResult>;
  // Git operations (P4 Git panel)
  /** Discover all git repos under a project root (recursive, max depth 3). */
  "git.discoverRepos": (input: GitDiscoverReposInput) => Promise<{ repos: GitRepo[] }>;
  /** Get the status of a single repo (branch / ahead / behind / files). */
  "git.status": (input: GitRepoPathInput) => Promise<{ status: GitStatusResult }>;
  /** Stage (git add) specific files. */
  "git.stage": (input: GitStageInput) => Promise<GitOpResult>;
  /** Unstage (git reset) specific files. */
  "git.unstage": (input: GitUnstageInput) => Promise<GitOpResult>;
  /** Commit staged changes with a message. */
  "git.commit": (input: GitCommitInput) => Promise<GitOpResult>;
  /** Push local commits to the upstream remote. */
  "git.push": (input: GitRepoPathInput) => Promise<GitOpResult>;
  /** Pull remote changes into the current branch. */
  "git.pull": (input: GitRepoPathInput) => Promise<GitOpResult>;
  /** Get the unstaged diff patch for a single file. */
  "git.diff": (input: GitDiffInput) => Promise<{ patch: string }>;
  /** Full old-side blob for the Git panel's diff view (`git show rev:path`). */
  "git.fileBlob": (input: GitFileBlobInput) => Promise<{ content: string }>;
  /** Discard local changes to specific files (checkout tracked / clean untracked). */
  "git.discard": (input: GitDiscardInput) => Promise<GitOpResult>;
  /** Generate a commit message from the staged diff via an LLM one-shot call. */
  "git.generateCommitMessage": (input: GitGenerateCommitInput) => Promise<{ ok: boolean; message?: string; error?: string }>;
  "git.cancelGenerateCommitMessage": (input: GitCancelGenerateCommitInput) => Promise<{ ok: boolean }>;
  /** Paginated commit log for a repo (newest first). */
  "git.log": (input: GitLogInput) => Promise<{ commits: GitCommitInfo[]; hasMore: boolean }>;
  /** Meta + changed files for one commit. */
  "git.showCommit": (input: GitShowCommitInput) => Promise<GitCommitDetail | null>;
  /** Parent-vs-commit file contents for a single path (Monaco diff). */
  "git.showFile": (
    input: GitShowFileInput,
  ) => Promise<{ before: string; after: string }>;
  /** List local branches, remote branches and tags for a repo (grouped). */
  "git.listBranches": (input: GitRepoPathInput) => Promise<{ branches: GitBranchListResult }>;
  /** Check out a branch / tag / ref. With `newBranch`, creates a new local
   *  branch from the target and checks it out (tracking branch or new branch). */
  "git.checkout": (input: GitCheckoutInput) => Promise<GitOpResult>;
  /** Delete a local branch (`git branch -d`; `-D` with `force`). */
  "git.deleteBranch": (input: GitDeleteBranchInput) => Promise<GitOpResult>;
  /** Preview a merge of `source` into the current branch without touching the
   *  working tree (incoming commit count / fast-forward / up-to-date). */
  "git.mergePreview": (input: GitMergeInput) => Promise<GitMergePreviewResult>;
  /** Merge `source` into the current branch. Conflicts are reported via
   *  `conflict` + `conflictedFiles` (same shape as git.pull). */
  "git.merge": (input: GitMergeInput) => Promise<GitMergeResult>;
  /** Abort an in-progress merge (`git merge --abort`). Fails when the repo is
   *  not in a merging state. */
  "git.mergeAbort": (input: GitRepoPathInput) => Promise<GitOpResult>;
  /** List the repo's worktrees (linked + main) with lifecycle state. */
  "git.worktreeList": (input: GitWorktreeListInput) => Promise<{ worktrees: GitWorktreeInfo[] }>;
  /** Lifecycle state of ONE worktree (cheap probe for pollers). */
  "git.worktreeStatus": (
    input: GitWorktreeStatusInput,
  ) => Promise<{ status: GitWorktreeInfo | null }>;
  /** Merge a worktree's HEAD back into the local current branch. */
  "git.worktreeMergeBack": (input: GitWorktreeMergeBackInput) => Promise<GitWorktreeMergeBackResult>;
  /** Remove a worktree (optionally force / with a patch export first). */
  "git.worktreeRemove": (input: GitWorktreeRemoveInput) => Promise<GitWorktreeRemoveResult>;
  // Integrated terminal (P4 IDE right panel)
  /** Spawn a PTY in the project cwd (or a subdir). */
  "terminal.create": (input: TerminalCreateInput) => Promise<TerminalCreateResult>;
  /** Write raw input bytes/text to a live PTY. */
  "terminal.write": (input: TerminalWriteInput) => Promise<TerminalOpResult>;
  /** Notify the PTY of a cols/rows change (after xterm fit). */
  "terminal.resize": (input: TerminalResizeInput) => Promise<TerminalOpResult>;
  /** Kill a PTY process and drop it from the manager. */
  "terminal.kill": (input: TerminalKillInput) => Promise<TerminalOpResult>;
  /** List live terminals, optionally filtered by project. */
  "terminal.list": (input: TerminalListInput) => Promise<{ terminals: TerminalInfo[] }>;
  // Embedded browser (WebContentsView + DOM element picker)
  /** Create a browser view bound to a project root. Returns an opaque id. */
  "browser.create": (input: BrowserCreateInput) => Promise<BrowserCreateResult>;
  /** Navigate the view to a URL. */
  "browser.loadUrl": (input: BrowserLoadUrlInput) => Promise<BrowserOpResult>;
  /** History back. */
  "browser.goBack": (input: BrowserGoBackInput) => Promise<BrowserOpResult>;
  /** History forward. */
  "browser.goForward": (input: BrowserGoForwardInput) => Promise<BrowserOpResult>;
  /** Reload the current page. */
  "browser.reload": (input: BrowserReloadInput) => Promise<BrowserOpResult>;
  /** Reposition/resize the view over the renderer's placeholder. */
  "browser.setBounds": (input: BrowserSetBoundsInput) => Promise<BrowserOpResult>;
  /** Inject/remove the DOM element picker into the page's main world. */
  "browser.setPickMode": (input: BrowserSetPickModeInput) => Promise<BrowserOpResult>;
  /** Show the view (attach + restore bounds). */
  "browser.show": (input: BrowserShowInput) => Promise<BrowserOpResult>;
  /** Hide the view (move offscreen without destroying the session). */
  "browser.hide": (input: BrowserHideInput) => Promise<BrowserOpResult>;
  /** Destroy the view and drop it from the manager. */
  "browser.close": (input: BrowserCloseInput) => Promise<BrowserOpResult>;
  /** Capture one frame of the current page (visibility untouched) for the
   *  renderer's frozen-frame placeholder. */
  "browser.captureFrame": (input: BrowserCaptureFrameInput) => Promise<BrowserCaptureFrameResult>;
  /** Bookmark a page (dedupe by URL, move to front). */
  "browser.bookmarkAdd": (input: BrowserBookmarkAddInput) => Promise<BrowserOpResult>;
  /** Remove one bookmark by URL. */
  "browser.bookmarkRemove": (input: BrowserBookmarkRemoveInput) => Promise<BrowserOpResult>;
  /** Set the device emulation preset (desktop / iphone / android). */
  "browser.setDevice": (input: BrowserSetDeviceInput) => Promise<BrowserOpResult>;
  /** Clear the embedded browser's HTTP cache + temporary site storage
   *  (localStorage / IndexedDB / service workers / etc.). Cookies and login
   *  data are preserved, so the user stays signed in. */
  "browser.clearCache": () => Promise<BrowserOpResult>;
  /** Clear ALL cookies from the shared browser session (sign-out everywhere)
   *  AND wipe the persisted cookie vault, so sign-ins cannot resurrect on
   *  restart via restoreCookieVault. */
  "browser.clearCookies": () => Promise<BrowserOpResult>;
  /** Remove one entry from the address-bar history. */
  "browser.historyRemove": (input: BrowserHistoryRemoveInput) => Promise<BrowserOpResult>;
  /** Clear the whole address-bar history. */
  "browser.historyClear": (input: BrowserHistoryClearInput) => Promise<BrowserOpResult>;
  /** Answer a pending HTTP Basic Auth prompt (see "authRequest" push event). */
  "browser.authRespond": (input: BrowserAuthRespondInput) => Promise<void>;
  /** Open a tracked download's file with the OS default app ("open", only
   *  allowed once the download completed) or select it in the containing
   *  folder ("reveal"). The path is resolved main-side from the download
   *  registry — see BrowserDownloadActionSchema. */
  "browser.downloadAction": (input: BrowserDownloadActionInput) => Promise<BrowserOpResult>;
  /** App version + runtime info for the About panel. */
  "app.info": () => Promise<AppInfoResult>;
  /** Check for updates on the GitHub Releases channel. Returns the current
   *  version when up-to-date, the new version when available, or an error.
   *  In dev this short-circuits to "up-to-date" (updater only runs in prod). */
  "app.checkForUpdates": () => Promise<CheckForUpdatesResult>;
  /** Start downloading the pending update (autoDownload is off, so the user
   *  opts in via this call). Resolves once the download begins; the
   *  `update:downloaded` push event fires when it's ready to install. */
  "app.downloadUpdate": () => Promise<void>;
  /** Quit the app and install the downloaded update (called after
   *  `update:downloaded`). */
  "app.quitAndInstall": () => Promise<void>;
  /** Open a path in the OS file manager. Main refuses any path that isn't a
   *  known project root, so this can't be used to open arbitrary locations. */
  "shell.openPath": (input: OpenPathInput) => Promise<void>;
  /** Reveal a file or directory in the OS file manager, selecting it. Accepts
   *  any path that resolves inside a known project root (not just the root). */
  "shell.showItemInFolder": (input: ShowItemInFolderInput) => Promise<void>;
  /** Open a file with the OS's default associated application. Accepts any
   *  path that resolves inside a known project root (not just the root). */
  "shell.openFile": (input: OpenFileInput) => Promise<void>;
  /** Native multi-file picker (project-external files allowed). Returns the
   *  selected absolute paths; empty array when the user cancels. */
  "dialog.pickFiles": (input: DialogPickFilesInput) => Promise<{ paths: string[] }>;
  /** 原生单目录选择器(新建项目用)。桌面专有:手机端的 `webApi` 不提供。 */
  "dialog.pickFolder": () => Promise<{ path: string | null }>;
  /** Discover skills for the composer `/` menu. Scans the user-global
   *  `~/.mcode/skills/` universal library and parses each SKILL.md's
   *  frontmatter. Always resolves (degrades to an empty list on any IO
   *  error). `projectPath` is accepted but ignored (single-scope since the
   *  context-hosting rework). */
  "skills.list": (input: SkillsListInput) => Promise<{ skills: SkillInfo[] }>;
  /** Read one skill's full SKILL.md source (no truncation). Missing file →
   *  empty content. */
  "skills.read": (input: SkillsReadInput) => Promise<{ content: string }>;
  /** Create or overwrite a skill's SKILL.md (full content write; creates the
   *  skill directory if absent). Returns ok:false + error on any IO failure. */
  "skills.save": (input: SkillsSaveInput) => Promise<{ ok: boolean; error?: string }>;
  /** Delete a skill directory (symlink → unlink link only; real dir → recursive
   *  remove). Returns ok:false + error on any IO failure. */
  "skills.delete": (input: SkillsDeleteInput) => Promise<{ ok: boolean; error?: string }>;
  /** **把技能从通用库复制到项目**（`<项目>/.claude/skills/`）。批量，逐条回报
   *  结果 —— 单个失败（重名 / 读不到源）不影响其余的。 */
  "skills.copyToProject": (
    input: SkillsCopyToProjectInput,
  ) => Promise<SkillsCopyToProjectResult>;
  /** **一套技能预设** —— "这类项目默认装这几个"。改整个数组（整份给过来，
   *  局部更新在这里没有意义，同 `workflow.agentProfiles` 的取舍）。 */
  "skills.presetsList": () => Promise<{ presets: SkillPreset[] }>;
  /** 存一套预设（新建或覆盖同 id 的）。 */
  "skills.presetsSave": (
    input: SkillsPresetSaveInput,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** 删一套预设。 */
  "skills.presetsDelete": (
    input: SkillsPresetDeleteInput,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** **跨项目总览** —— 每个项目各装了哪些技能。`projectIds` 省略 = 全部项目。 */
  "skills.projectOverview": (
    input: SkillsProjectOverviewInput,
  ) => Promise<SkillsProjectOverviewResult>;
  /** Set one universal skill's per-engine availability (claude/codex/pi).
   *  Returns the resolved state as persisted (or ok:false + error). */
  "skills.engines.set": (
    input: SkillsEnginesSetInput,
  ) => Promise<{ ok: boolean; error?: string; perEngine?: SkillEngineState }>;
  /** Read the bundle manifest (import groups of the universal library).
   *  Missing / unparsable manifest → empty list. */
  "skills.bundles": (input: SkillsBundlesInput) => Promise<{ bundles: SkillBundle[] }>;
  /** Set the per-engine availability for many skills at once (group-level
   *  switch). Returns per-name resolved state (or ok:false + error). */
  "skills.enginesSetBulk": (
    input: SkillsEnginesSetBulkInput,
  ) => Promise<{
    ok: boolean;
    error?: string;
    perEngine?: Record<string, SkillEngineState>;
  }>;
  /** Scan external tools (Claude Code / Codex / Zcode) for skills available
   *  for import into Mcode's own ~/.mcode/skills. Returns the full list of
   *  discoverable skills with their source paths. */
  "skills.scanSources": (input: SkillsScanSourcesInput) => Promise<{ sources: ExternalSkillInfo[] }>;
  /** Import (copy) selected skills from external tool directories into
   *  ~/.mcode/skills. Already-existing skills are skipped. Returns per-skill
   *  imported / skipped / error lists. */
  "skills.import": (input: SkillsImportInput) => Promise<{
    imported: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
  }>;
  /** Import a whole skill package from a GitHub repo URL — shallow-clone,
   *  discover every SKILL.md, copy each skill in, and group them all under
   *  one bundle. Returns the bundle + per-skill lists. */
  "skills.importGithub": (
    input: SkillsImportGithubInput,
  ) => Promise<SkillsImportGithubResult>;
  // MCP management (settings panel)
  /** List all MCP servers across the three sources (user config file, project
   *  .mcp.json, built-in mcode-browser) with their enabled state. */
  "mcp.list": (input: McpListInput) => Promise<{ servers: McpServerEntry[] }>;
  /** Enable/disable a server. User scope moves the config between the config
   *  file and the management stash; project/builtin update the management
   *  state. Takes effect on the next turn. */
  "mcp.toggle": (input: McpToggleInput) => Promise<{ ok: boolean; error?: string }>;
  /** Set an MCP server's per-engine visibility (claude/codex — pi has no MCP
   *  support). Takes the full boolean pair; both engine views re-materialize
   *  after the write, and the change lands on the next turn. Returns the
   *  resolved state as persisted (or ok:false + error). */
  "mcp.enginesSet": (
    input: McpEnginesSetInput,
  ) => Promise<{ ok: boolean; error?: string; perEngine?: McpEngineState }>;
  /** Run the OAuth browser login for a remote MCP server (claude mcp login).
   *  Opens the system browser; resolves when the CLI reports the flow done. */
  "mcp.authorize": (input: McpAuthorizeInput) => Promise<{ ok: boolean; error?: string }>;
  /** Clear a remote MCP server's stored OAuth token (claude mcp logout). */
  "mcp.unauthorize": (input: McpUnauthorizeInput) => Promise<{ ok: boolean; error?: string }>;
  /** Add a user-scope server (writes into ~/.mcode/.claude.json). */
  "mcp.save": (input: McpSaveInput) => Promise<{ ok: boolean; error?: string }>;
  /** Remove a user-scope server (from both the config file and the stash). */
  "mcp.remove": (input: McpRemoveInput) => Promise<{ ok: boolean; error?: string }>;
  /** Scan the local Claude CLI config (~/.claude.json) for servers available
   *  for import (global + per-project entries). Read-only. */
  "mcp.scanImport": (input: McpScanImportInput) => Promise<{ sources: McpImportSource[] }>;
  /** Import selected servers into the user scope. Already-existing names are
   *  skipped. Returns per-server imported / skipped / error lists. */
  "mcp.import": (input: McpImportInput) => Promise<{
    imported: string[];
    skipped: string[];
    errors: Array<{ name: string; error: string }>;
  }>;
  // Context hosting (settings panel): global instructions + tool usage
  /** Read the global instructions (single source of truth file). Empty string
   *  = never configured. */
  "context.get": (input: ContextGetInput) => Promise<{ content: string }>;
  /** Save the global instructions and materialize each engine's consume point
   *  (CLAUDE.md for claude; the codex/pi prompt chains read the same source).
   *  `warnings` carries per-target notes (e.g. an unmanaged hand-written file
   *  was left untouched). */
  "context.save": (input: ContextSaveInput) => Promise<{ ok: boolean; error?: string; warnings?: string[] }>;
  /** Static per-tool context-usage estimate for one engine. */
  "tools.usage": (input: ToolsUsageGetInput) => Promise<ToolsUsageResult>;
  /** Output styles (settings panel): list built-in + user styles. The
   *  selection itself is persisted via the generic setting.get/set channels
   *  under AGENT_OUTPUT_STYLE_SETTING_KEY. */
  "outputStyle.list": (
    input: OutputStyleListInput,
  ) => Promise<{ styles: OutputStyleEntry[] }>;
  // Usage stats (settings panel)
  /** Aggregate the persisted per-turn usage history into summary / per-model /
   *  per-day views for the requested time range. Read-only. */
  "usage.stats": (input: UsageStatsInput) => Promise<UsageStatsResult>;
  // Language servers (LSP)
  /** List all language servers and their install/running state. */
  "lsp.list": () => Promise<{ languages: LspLanguageState[] }>;
  /** Install a language server via its package manager (npm/pip/go/brew). */
  "lsp.install": (input: LspInstallInput) => Promise<LspOpResult>;
  /** Install from a user-downloaded archive/binary (manual download fallback
   *  for when the package-manager install fails due to network issues). */
  "lsp.installFromFile": (input: LspInstallFromFileInput) => Promise<LspOpResult>;
  /** Uninstall a language server. */
  "lsp.uninstall": (input: LspUninstallInput) => Promise<LspOpResult>;
  /** Enable/disable a language (disabling kills any running server). Returns
   *  the refreshed state list. */
  "lsp.toggle": (input: LspToggleInput) => Promise<{ languages: LspLanguageState[] }>;
  /** Set a custom server path / args override. Returns the refreshed list. */
  "lsp.setPath": (input: LspSetPathInput) => Promise<{ languages: LspLanguageState[] }>;
  /** Verify the server binary runs (--version or --help probe). */
  "lsp.healthCheck": (input: LspHealthCheckInput) => Promise<LspOpResult>;
  "lsp.prewarm": (input: LspPrewarmInput) => Promise<LspOpResult>;
  /** Restart a language server for one workspace (stop + clear the crash-loop
   *  guard + immediately relaunch). Clicking a startup-failure notice calls
   *  this after the user fixes the environment. */
  "lsp.restart": (input: LspRestartInput) => Promise<LspOpResult>;
  /** Open a document in the server (textDocument/didOpen). Lazily starts the
   *  server for (workspacePath, language) on first call. */
  "lsp.openDocument": (input: LspOpenDocInput) => Promise<void>;
  /** Close a document (textDocument/didClose). */
  "lsp.closeDocument": (input: LspCloseDocInput) => Promise<void>;
  /** Notify the server of a full-content change (textDocument/didChange). */
  "lsp.didChange": (input: LspDidChangeInput) => Promise<void>;
  /** Notify the server of a save (textDocument/didSave). */
  "lsp.didSave": (input: LspDidSaveInput) => Promise<void>;
  /** Forward an arbitrary LSP request (definition/references/hover/...) to the
   *  server and await its response. */
  "lsp.request": (input: LspRequestInput) => Promise<LspRequestResult>;
  // Agent runtimes (download-on-demand, settings panel)
  /** List the claude/codex/pi runtimes: expected vs installed vs latest
   *  version, install state and disk footprint. `latestVersion` is fetched
   *  from the registry on each call (best-effort, null when offline). */
  "runtimes.list": () => Promise<{ runtimes: RuntimeAgentState[] }>;
  /** Download + install (or update/reinstall) a runtime into
   *  userData/runtimes. Resolves when the install fully finished. */
  "runtimes.install": (input: RuntimesInstallInput) => Promise<{ ok: boolean; error?: string }>;
  /** Install a runtime from a user-picked local path (install directory,
   *  binary, or .tgz). The version is taken from the package.json when
   *  available, else the expected version. */
  "runtimes.installLocal": (
    input: RuntimesInstallLocalInput,
  ) => Promise<{ ok: boolean; error?: string; version?: string }>;
  /** Delete an installed runtime from disk. Rejected while any turn is
   *  running. */
  "runtimes.remove": (input: RuntimesRemoveInput) => Promise<{ ok: boolean; error?: string }>;
  // 文档工具链(设置 → 内核):内置文档技能要用的外部工具
  /** 检测本机工具链:pandoc / python 包 / TeX / zip 各自找到没有、什么版本、
   *  在哪。安装或卸载后重新调它即可刷新面板。 */
  "toolchain.check": () => Promise<{ tools: ToolchainToolState[] }>;
  /** 安装一个应用能管的工具(pandoc 由应用下载;python-deps 走用户解释器的
   *  pip)。进度走 `toolchain:event`。 */
  "toolchain.install": (
    input: ToolchainInstallInput,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** 删掉应用管理的那份(只对 managed 有效;用户自己装的 system 那份不动)。 */
  "toolchain.remove": (input: ToolchainRemoveInput) => Promise<{ ok: boolean; error?: string }>;
  // 工作流(设置 → 工作流):一张有向无环图,取代原来写死在 systemPrompt.ts 的五个模式
  /** 全部工作流:内置打底 + 用户覆盖 + 自建。**不含 nodes / edges**,画布打开某一项
   *  时才走 `workflow.get` 取完整文档。 */
  "workflow.list": () => Promise<{ workflows: WorkflowListEntry[] }>;
  /** 取一份完整工作流。找不到返回 null(比如列表之后被别处删了)。 */
  "workflow.get": (input: WorkflowGetInput) => Promise<{
    workflow: WorkflowDoc | null;
    revision: string | null;
    review: WorkflowReviewInfo | null;
  }>;
  /** Separate approval for the saved revision; saving/importing is not consent
   * to execute an automation or to inject an imported workflow prompt. */
  "workflow.approve": (input: WorkflowApproveInput) => Promise<{
    ok: boolean;
    review?: WorkflowReviewInfo;
    error?: string;
  }>;
  /** 当前可用的**节点类型**(内置 + 已启用插件 + 用户自写),以及读不进来的清单文件
   *  和它们的错误。画布的"添加节点"菜单用前者;后者必须一起返回,否则用户写错一个
   *  清单,界面上只会看到自己的类型凭空消失。
   *
   *  ⚠️ 无参 handler,同 `workflow.list`:不接 raw、不 parse。 */
  "workflow.nodeTypes": () => Promise<NodeTypeCatalog>;
  /** 存一份。**存盘前过 DAG 校验 + 每个节点的参数校验**,有环/悬空边/参数不合法
   *  直接拒绝 —— 有环的图会让调度器永远等不到就绪节点,那不是报错是静默卡死。 */
  "workflow.save": (input: WorkflowSaveInput) => Promise<{ ok: boolean; error?: string; warnings?: string[] }>;
  /** 删一份。删掉对内置工作流的覆盖 = 「恢复默认」;`wasBuiltin` 让界面能说对话
   *  (「已恢复默认」而不是「已删除」)。 */
  "workflow.remove": (input: WorkflowRemoveInput) => Promise<{ ok: boolean; wasBuiltin: boolean }>;
  /** 把内置工作流**当前生效的版本**钉成「默认」—— 之后 `workflow.remove`(恢复默认)
   *  回到钉住的这一版(覆盖之前的默认,包括应用自带那份的地位)。 */
  "workflow.pinDefault": (input: WorkflowPinDefaultInput) => Promise<{ ok: boolean; error?: string }>;
  /** 把钉住的快照写回(「恢复默认」)。没钉过 → 失败并说清。 */
  "workflow.restoreDefault": (input: WorkflowRestoreDefaultInput) => Promise<{ ok: boolean; error?: string }>;
  /** 自带工作流的出厂版有更新时:用出厂版覆盖这一行(用户关掉的触发器保持关闭)。 */
  "workflow.applyShippedUpdate": (input: WorkflowShippedUpdateInput) => Promise<{ ok: boolean; error?: string }>;
  /** 忽略这次出厂更新(内容不动;出厂内容再变时重新提示)。 */
  "workflow.dismissShippedUpdate": (input: WorkflowShippedUpdateInput) => Promise<{ ok: boolean; error?: string }>;
  /** 把**磁盘上那一份**导出成 JSON 文本,走系统「另存为」框落盘。用户取消时
   *  `canceled: true`,界面不该报错(取消不是失败)。路径**由主进程拿**,渲染端
   *  始终没有"写任意路径"的能力(同 `library.revealFile`)。 */
  "workflow.export": (input: WorkflowExportInput) => Promise<{
    ok: boolean;
    canceled?: boolean;
    /** 真写下去了才有。写成功后界面可以在它旁边说一句"存哪儿了"。 */
    path?: string;
    error?: string;
  }>;
  /** 收下一份导出的 JSON。**`id` 给了就是覆盖那一份**(必须已存在),不给就是新建
   *  (id 现生成、重名自动加后缀)。 */
  "workflow.import": (input: WorkflowImportInput) => Promise<{
    ok: boolean;
    /** 存下来的那一份的 id —— 界面据此打开它。 */
    id?: string;
    name?: string;
    /** 原样带回来的校验报告(错误逐条 + 警告)。**整份拒绝**:过不了闸门的图不写库,
     *  所以 `ok: false` 时库里什么都没变。 */
    errors?: string[];
    warnings?: string[];
    error?: string;
  }>;
  /** 从**文件**导入 —— 主进程自己弹选择框并读文件。
   *
   *  为什么要这一条而不是让界面先 `file.readFile`:那条 RPC 被项目根闸门挡着,而用户
   *  手上那份工作流多半存在项目外(下载目录、桌面)。选择框由用户亲手点,信任级别与
   *  `dialog.pickFiles` 相同。`id` 同 `workflow.import`:给了就是覆盖。
   *
   *  ⚠️ 与 `workflow.import` 是**两条入口、同一段落库逻辑** —— 用户在文件管理器里
   *  双击 `.json` 那条路(未来)只需要后者。 */
  "workflow.importFromFile": (input: { id?: string }) => Promise<{
    ok: boolean;
    canceled?: boolean;
    id?: string;
    name?: string;
    errors?: string[];
    warnings?: string[];
    error?: string;
  }>;
  /** 代理档案:一份存下来的**子 agent 配置**(指令 / 技能 / 模型 / 引擎……)。建节点的
   *  时候直接套一份,不用从空白开始填。
   *
   *  它是**值**不是类型 —— 删掉一份档案不会让任何已有的图跑不起来(节点身上已经有参数
   *  了)。见 `@contracts/agentProfile` 的文件头。
   *
   *  ⚠️ 无参 handler,同 `workflow.list`。 */
  "workflow.agentProfiles": () => Promise<AgentProfileCatalog>;
  /** 存一份(按 id 覆盖)。整份给过来 —— 理由同 `hooks.save`。 */
  "workflow.saveAgentProfile": (
    input: AgentProfileSaveInput,
  ) => Promise<{ ok: boolean; error?: string }>;
  "workflow.removeAgentProfile": (input: AgentProfileRemoveInput) => Promise<{ ok: boolean }>;
  /** 在**岔路口**上选一条路(`mcode.branch` 那个节点正停在那儿等着)。
   *
   *  它唤醒的是一个**还活着的运行**,不是开一次新的 —— 图从那个节点接着往下跑,
   *  不重跑整张图。见 `@contracts/runtime` 的 `WorkflowNodeChoiceEvent`。
   *
   *  `ok: false` = 没有这样的等待;若图已更改或旧存档无版本,
   *  `error` 说明为何不能续跑。普通旧卡片不弹错误框。 */
  "workflow.choose": (input: WorkflowChooseInput) => Promise<{ ok: boolean; error?: string }>;
  /**
   * **从失败那一步接着往下跑。** 用户在失败卡片上点了「再试一次」,顺手写了句
   * 「上次哪里不对」。重跑的是那一步**连同它的全部下游**(见 `WorkflowRetrySchema`)。
   *
   * `ok: false` 有四种原因,全都**不是错误**(界面上是一句"这张卡不适用了"):
   * 找不到那次运行 / 它已经不是 `failed` / 存档读不回来 / 这个对话正有运行在跑。
   * 最后那种要如实回 false —— `startWorkflowRun` 在运行中会静静地不做事。
   */
  "workflow.retry": (input: WorkflowRetryInput) => Promise<{ ok: boolean; error?: string }>;
  // ── 自动化(设置 → 工作流 → 自动化那一栏)──
  //
  // 这三个是**桌面专属**:手机端(`main/mobile/mobileRpc.ts`)是手写白名单,不列即不暴露。
  // 手动触发一次 = 冒充一个 `manual` 触发器,不是"编辑工作流" —— 理由写在
  // `@contracts/ipc` 的 `AutomationRunSchema` 上。
  /** **立刻跑一次**。走的就是那条自动化的 manual 那条路(见 `automationRunner.runNow`),
   *  所以试出来的结果和它定时跑起来是同一样东西。
   *
   *  `ok: false` 时 `error` 是**给人看的句子**(比如"这个触发器不在一条已保存的自动化里"),
   *  不是异常 —— 用户点了一个还没存过的触发器,该得到一句解释而不是一个错误框。 */
  "automation.run": (input: AutomationRunInput) => Promise<{ ok: boolean; error?: string }>;
  /** 运行历史(新的在前)。**从存档折出来**,不是另存的一份 —— 见 `AutomationRunEntry`。 */
  "automation.runs": (
    input: AutomationRunsInput,
  ) => Promise<{ runs: AutomationRunEntry[] }>;
  /** 后台会话：sessionId 优先为活跃会话，否则最近使用；没跑过为 null。
   *  sessionIds 列出全部项目的会话供历史汇总；可选以兼容旧版响应。 */
  "automation.sessions": (input: AutomationSessionsInput) => Promise<{ sessionId: string | null; sessionIds?: string[] }>;
  // ── 守望(会话输入区那颗「守望」按钮,D3/D4)──
  //
  // 同样**桌面专属**(手机白名单不列即不暴露)。起跑有**可见的副作用**:command /
  // message 会被写进内置模板的节点参数(见 `automationRunner.startWatch` 的说明)。
  /** 以某条会话为发起会话起一次守望。`ok: false` 时 `error` 是给人看的句子(不在跑、
   *  发起会话没了、模板被改坏……),不是异常 —— 点按钮的人该得到解释而不是错误框。 */
  "automation.watch": (input: WatchStartInput) => Promise<{ ok: boolean; error?: string }>;
  /** 这条会话上有没有正在跑的守望(面板提示"上一次还在跑"用)。 */
  "automation.watchStatus": (input: WatchStatusInput) => Promise<{ active: boolean }>;
  /** 全部命令模板(守望面板的下拉)。**无参 handler**,同 `workflow.agentProfiles`。 */
  "automation.watchTemplates": () => Promise<{ templates: WatchCommandTemplate[] }>;
  /** 存整份命令模板列表。整份给过来 —— 理由同 `workflow.saveAgentProfile`。 */
  "automation.watchTemplatesSave": (input: WatchTemplatesSaveInput) => Promise<{ ok: boolean }>;
  /** 全部触发器的**事实状态**(挂没挂上 / 为什么 / 最近一次跑,见
   *  `AutomationTriggerFacts`)。**无参 handler**,同 `workflow.agentProfiles`。 */
  "automation.statusAll": () => Promise<AutomationTriggerFacts[]>;
  // ── 自定义 UI(见 `@contracts/customUi`)──
  /** 自定义项的「运行自动化」动作:用指定触发器**手动**起一次,右键的目标当载荷带进去
   *  (条目 / 分类 / 大类 → 条目清单,文件 → 文件列表)。`dryRun` 只数条数不真跑。
   *  桌面专属(手机白名单不列即不暴露)。 */
  "customUi.runAutomation": (input: CustomUiRunAutomationInput) => Promise<CustomUiRunAutomationResult>;
  // ── 运行史(某个对话的全部图运行)──
  /** 某个对话的图运行历史(新的在前)。**从存档折出来**,只给轻量摘要 ——
   *  见 `PersistedWorkflowRunLite`(整份快照不为一行列表过 IPC)。 */
  "runs.history": (input: RunsHistoryInput) => Promise<PersistedWorkflowRunLite[]>;
  // ── 记忆(对话记忆的直读直写)──
  // 契约与渠道字符串都在 `../memory.ts`(固定六类,目录即类目)。以下文件动作都是
  // **按 memory 根下的相对路径寻址**,主进程侧会校验路径不逃出 memory 根。
  /** 列记忆文件(可选按类目过滤),行形状见 `../memory.ts` 的 `MemoryFileMeta`。 */
  // Deterministic local scaffolds; deliberately excluded from mobile RPC.
  "projectInit.list": () => Promise<ProjectInitList>;
  "projectInit.get": (input: {id: string}) => Promise<ProjectInitTemplate>;
  "projectInit.save": (input: ProjectInitSaveInput) => Promise<ProjectInitTemplate>;
  "projectInit.delete": (input: {id: string; expectedRevision: string}) => Promise<{ok: true}>;
  "projectInit.preview": (input: ProjectInitPreviewInput) => Promise<ProjectInitPreview>;
  "projectInit.apply": (input: ProjectInitApplyInput) => Promise<ProjectInitResult>;
  /** 设定裸 `/init` 预选的场景;`null` 清除。 */
  "projectInit.setDefault": (input: {id: string | null}) => Promise<{ok: true}>;
  "memory.assistant": (input: MemoryAssistantInput) => Promise<MemoryAssistantResult>;
  "memory.manage": (input: MemoryManageInput) => Promise<MemoryManageResult>;
  "memory.list": (input: MemoryListInput) => Promise<{ files: MemoryFileMeta[] }>;
  /** 读一条记忆的正文(不含 frontmatter)。 */
  "memory.read": (input: MemoryReadInput) => Promise<{ content: string; revision: string }>;
  /** 存正文(frontmatter 由主进程维护)。 */
  "memory.save": (input: MemorySaveInput) => Promise<{ ok: boolean; revision?: string; error?: string; code?: "conflict" }>;
  /** 删一条记忆。`ok: false` 时 `error` 是给人看的句子,不是异常。 */
  "memory.delete": (input: MemoryDeleteInput) => Promise<{ ok: boolean; error?: string; code?: "conflict" }>;
  /** 类目清单(固定六类)。**无参 handler**。 */
  "memory.categories": () => Promise<string[]>;
  /** 只扫描建议，不改任何文件；截断/读失败必须在结果里显式说明。 */
  "memory.review": () => Promise<MemoryReviewResult>;
  /** 整理中人工勾选并确认后的逐条删除；主进程核对完整内容指纹。 */
  "memory.reviewDelete": (input: MemoryReviewDeleteInput) => Promise<{ ok: boolean; error?: string }>;
  // ── 监控(总览)──
  /** 监控总览的一次快照:正在跑几个、触发器挂得怎么样。**无参 handler**。 */
  "monitoring.overview": () => Promise<MonitoringOverview>;
  /** 最近的运行摘要(新的在前),监控列表用 —— 见 `MonitoringRunSummary`。 */
  "monitoring.runs": (input: MonitoringRunsInput) => Promise<MonitoringRunSummary[]>;
  // 钩子(设置 → 钩子):某件事发生的时候跑一条你自己的命令。它是**宿主侧**的能力
  // (理由见 `@contracts/hook`),所以对话、工作流节点、将来的自动化一视同仁。
  /** 全部钩子 + 读得见但用不了的条目。**坏条目不静默丢弃** —— 用户写的钩子不生效时,
   *  这一页是唯一能解释为什么的地方。 */
  "hooks.list": () => Promise<{ hooks: HookSpec[]; problems: Array<{ where: string; error: string }> }>;
  /** 最近的执行记录(新的在前)。**不进对话流** —— 一个挂在 `tool.use` 上的钩子一轮
   *  会触发几十次,塞进消息流就是把对话刷屏;而节点会话是隐藏的,那些事件本来也不该
   *  出现在父对话里。 */
  "hooks.runs": () => Promise<{ runs: HookRun[] }>;
  "hooks.save": (input: HooksSaveInput) => Promise<{ ok: boolean; error?: string }>;
  "hooks.remove": (input: HooksRemoveInput) => Promise<{ ok: boolean; error?: string }>;
  /** 拿一条**还没存下来**的配置试跑一次,把那一次的结果返回。 */
  "hooks.test": (input: HooksTestInput) => Promise<{ run: HookRun }>;
  // ── Plugins (settings panel; docs/plugin-feasibility.md v1) ──
  /** List installed plugins (manifest + component summaries + enable state).
   *  Enabled plugins are delivered to providers at the next turn start. */
  "plugins.list": () => Promise<{ plugins: PluginState[] }>;
  /** Install from a local plugin directory or .zip. Lands DISABLED; the
   *  renderer shows the component-review dialog and calls setEnabled. */
  "plugins.installLocal": (
    input: PluginsInstallLocalInput,
  ) => Promise<{ ok: boolean; error?: string; plugin?: PluginState }>;
  /** Install by shallow-cloning a git repository. Same review flow. */
  "plugins.installGit": (
    input: PluginsInstallGitInput,
  ) => Promise<{ ok: boolean; error?: string; plugin?: PluginState }>;
  /** Install one entry of a user-added marketplace. Same review flow. */
  "plugins.installMarketplace": (
    input: PluginsInstallMarketplaceInput,
  ) => Promise<{ ok: boolean; error?: string; plugin?: PluginState }>;
  /** Enable/disable a plugin for subsequent turns. */
  "plugins.setEnabled": (input: PluginsSetEnabledInput) => Promise<{ ok: boolean; error?: string }>;
  /** Uninstall every installed version of a plugin. Rejected while any turn
   *  is running. */
  "plugins.remove": (input: PluginsRemoveInput) => Promise<{ ok: boolean; error?: string }>;
  /** List user-added marketplaces with their parsed entries. */
  "plugins.marketplaceList": () => Promise<{ marketplaces: PluginMarketplaceState[] }>;
  /** Add a marketplace (git URL or local directory). */
  "plugins.marketplaceAdd": (
    input: PluginsMarketplaceAddInput,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Remove a marketplace (cloned tree deleted; installed plugins stay). */
  "plugins.marketplaceRemove": (
    input: PluginsMarketplaceRemoveInput,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Re-fetch a marketplace's tree. */
  "plugins.marketplaceRefresh": (
    input: PluginsMarketplaceRefreshInput,
  ) => Promise<{ ok: boolean; error?: string }>;
  // ── Mobile companion (LAN pairing + device management) ──
  /** Begin a pairing session: returns QR URL + 6-digit code + endpoint.
   *  Optional `host` overrides auto-detected LAN IP (for multi-NIC machines
   *  where the phone can only reach one interface). */
  "mobile.startPairing": (input?: {
    host?: string;
    mode?: "lan" | "remote";
    endpoint?: string;
    /** Void the pending pairing (if any) and generate a fresh nonce + code.
     *  Without this the call reuses the pending pairing within its TTL, which
     *  is what the manual "refresh QR" buttons need to bypass. */
    force?: boolean;
  }) => Promise<{ pairing: PairingStartResult }>;
  /** Cancel the active pairing (clears the nonce). */
  "mobile.cancelPairing": () => Promise<{ ok: true }>;
  /** List paired devices (token stripped). */
  "mobile.listDevices": () => Promise<{ devices: PairedDevice[] }>;
  /** Revoke a paired device; its token stops working immediately. */
  "mobile.revokeDevice": (input: { deviceId: string }) => Promise<{ ok: true }>;
  /** Server status (running, port, endpoint, candidate LAN IPs) for the dialog. */
  "mobile.getStatus": () => Promise<{
    running: boolean;
    port: number;
    endpoint: string;
    lanIp: string | null;
    lanIps: string[];
  }>;
  /** Count of paired devices that are currently "active" (made a request
   *  within {@link MOBILE_ACTIVE_WINDOW_MS}). */
  "mobile.getActiveCount": () => Promise<{ count: number }>;
  // ── Relay (SSH-based remote access) ──
  /** Save VPS connection config to settings (persisted across restarts). */
  "relay.saveConfig": (input: RelayVpsConfigInput) => Promise<{ ok: boolean; error?: string }>;
  /** Read the saved VPS config (passwords included — main→renderer only). */
  "relay.getConfig": () => Promise<{ config: RelayVpsConfig | null }>;
  /** Connect to the VPS: SSH + deploy forwarder + reverse tunnel. */
  "relay.connect": () => Promise<{ ok: boolean; error?: string }>;
  /** Disconnect from the VPS (forwarder keeps running on the VPS). */
  "relay.disconnect": () => Promise<{ ok: true }>;
  /** Read the current relay status. */
  "relay.status": () => Promise<RelayStatus>;

  // 文献库 —— 条目
  /** 左栏大类:当前生效的分组(已过滤掉引用了已删类型的行)。 */
  "library.groupsGet": (input: LibraryGroupsGetInput) => Promise<{ groups: LibraryGroupMeta[] }>;
  /** 整表替换大类。校验(一个类型只属一个组等)在主进程。 */
  "library.groupsSave": (input: LibraryGroupsSaveInput) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 屏蔽规则:当前生效的(哪些资料不进上下文)。没存过 = 空规则(什么都不挡)。 */
  "library.suppressGet": (input: LibrarySuppressGetInput) => Promise<{ rule: LibrarySuppressRule }>;
  /** 整表替换屏蔽规则。校验(前缀合法、扩展名规范化)在主进程过 `parseSuppressJson`。 */
  "library.suppressSave": (input: LibrarySuppressSaveInput) => Promise<{ ok: true } | { ok: false; error: string }>;

  // 文献库 —— 条目关联
  /** 一条条目的关联,**双向都返回**(`direction` 区分)。界面上的「关联」区用它。
   *
   *  `target` 是目标那一条的摘要(**主进程一次查好**,渲染端不必再逐条拉)——
   *  库内条目给标题,库外路径给文件名。`suppressed` 是"这条会被屏蔽规则挡住"的
   *  原因(没被挡就是 undefined):界面据此把它**显示成灰态并说明为什么**,而不是
   *  干脆不显示 —— 用户得看得见"它存在,只是被挡了",否则会以为关联丢了。 */
  "library.linksOf": (input: LibraryLinksOfInput) => Promise<{
    links: LibraryLinkView[];
  }>;
  /** 一批条目**各自**的关联条数 —— 左栏行尾那个徽标。见契约里 `LibraryLinkCountsSchema`。 */
  "library.linkCounts": (input: LibraryLinkCountsInput) => Promise<{
    /** 条目 id → 条数。**没关联的不在里面**(调用方 `?? 0`)。 */
    counts: Record<string, number>;
  }>;
  /** 加一条关联。**幂等** —— 已有同一条就返回它,不产生第二行。 */
  "library.linkAdd": (input: LibraryLinkAddInput) => Promise<{ link: LibraryItemLink }>;
  /** 解除一条关联(按关联行自己的 id)。 */
  "library.linkRemove": (input: LibraryLinkRemoveInput) => Promise<{ ok: boolean }>;
  /** 任意文件/目录导入为通用条目(linked = 引用原路径 / attached = 复制进库)。 */
  "library.importGeneric": (input: LibraryImportGenericInput) => Promise<{
    items: LibraryItem[];
    added: number;
    skipped: number;
    errors: Array<{ path: string; error: string }>;
  }>;
  /** 读通用文件条目的内容(文本 / 图片与二进制 base64 / 目录列表)。 */
  "library.readFile": (input: LibraryReadFileInput) => Promise<{ content: LibraryFileContent }>;
  /** 列出文献。`collectionId` 为 null/省略表示全部。 */
  "library.list": (input: LibraryListInput) => Promise<{ items: LibraryItem[]; total: number }>;
  /** 单条详情。 */
  "library.get": (input: LibraryItemIdInput) => Promise<{ item: LibraryItem }>;
  /** 入库(只建记录,不带文件)。返回新增的条目。 */
  "library.addItems": (input: LibraryAddItemsInput) => Promise<{ items: LibraryItem[] }>;
  /** 从库中移除。`deleteFiles` 决定是否连磁盘文件一起删。
   *  **删不掉的会如实报在 `failed` 里,而且那几条记录留着**(见 `LibraryDeleteItemsResult`)。 */
  "library.deleteItems": (input: LibraryDeleteItemsInput) => Promise<LibraryDeleteItemsResult>;
  /**
   * 从回收站里**还原**这几条 —— 放回最后删除的那个分类。
   *
   * 与 `deleteItems` 是一对:那条(recycle bin 里)是真的删,这条是把它们捞回来。
   * 单独一条 RPC 而不是让渲染端拼两次 `assignCollection`,理由见契约里的注释。
   */
  "library.restoreItems": (input: LibraryRestoreItemsInput) => Promise<{ items: LibraryItem[] }>;
  /**
   * 删除**之前**看一眼会带走什么 —— 关联到的其他文献、以及这条自己的 Markdown 转录
   * 产物(连同它的图床)。弹窗照着它画勾选框。
   *
   * 刻意是**只读查询**:渲染端不必为了画一个确认框去拉半张库。用户取消时也不会有
   * 任何东西被动过。
   */
  "library.deletePreview": (input: LibraryDeletePreviewInput) => Promise<LibraryDeletePreviewResult>;
  /** 从**本地 PDF 文件**导入。
   *  逐份:校验 → 按 sha256 去重 → 复制进库 → 入库(标题取文件名)→ 可选转 Markdown。 */
  "library.importFiles": (input: LibraryImportFilesInput) => Promise<{
    items: LibraryItem[];
    added: number;
    skipped: number;
    /** 失败原因(路径 + 人话);成功的不出现在这里。 */
    errors: Array<{ path: string; error: string }>;
    converted: { ok: number; failed: number };
  }>;
  /**
   * 导入笔记(**Markdown 文件**,见 `LibraryImportNotesSchema`)。
   *
   * 与 importFiles 分开的理由:笔记入库即完成 —— 没有元数据要抓、没有 PDF 要下、
   * 没有东西要转录。所以返回值里也没有 `converted`。
   */
  "library.importNotes": (input: LibraryImportNotesInput) => Promise<{
    items: LibraryItem[];
    added: number;
    skipped: number;
    errors: Array<{ path: string; error: string }>;
  }>;
  /** @deprecated 兼容入口，只返回自动化指引；不上传、转录或清理产物。 */
  "library.convert": (input: LibraryConvertInput) => Promise<{
    converted: number;
    cleaned: number;
    failed: Array<{ id: string; error: string }>;
  }>;
  /** 在系统文件管理器里定位库里的文件(PDF 或转换出的 Markdown)。
   *  **入参只有条目 id** —— 路径由主进程从库里取,渲染端无从指定任意路径。 */
  "library.revealFile": (input: LibraryRevealFileInput) => Promise<{ ok: boolean; error?: string }>;
  /** 用系统默认程序打开库里的文件 —— 主要用途是看 md 的渲染效果(「打开 md 预览」)。
   *  同样只收条目 id,路径在 main 里拼。 */
  "library.openFile": (input: LibraryOpenFileInput) => Promise<{ ok: boolean; error?: string }>;
  /** **条目 → 磁盘绝对路径** —— 给中间栏那个 `FileEditor` 用的（它按路径读写）。
   *  见 `LibraryEntryPathSchema` 头注：这不构成"渲染端能读任意文件"，路径是主进程
   *  按库里的记录算的，而且还要过 `pathGuard` 那道围栏。 */
  "library.entryPath": (input: LibraryEntryPathInput) => Promise<LibraryEntryPathResult>;
  /**
   * 读某篇 PDF 的全部高亮。
   *
   * 高亮存在 PDF **旁边**的 `.<名字>.mcode-highlights.json`（见
   * `main/library/pdfHighlightsStore.ts`），所以这里按**路径**问 —— 项目目录里那些
   * 根本不在资料库里的 PDF 也要能有高亮。
   */
  "library.readHighlights": (input: PdfHighlightsReadInput) => Promise<{ highlights: PdfHighlight[] }>;
  /** **只写索引**（PDF 旁边那份 JSON）—— 划一笔就走这条，几毫秒，不动 PDF。 */
  "library.saveHighlights": (input: PdfHighlightsSaveInput) => Promise<{ ok: boolean; error?: string }>;
  /**
   * 把高亮**写回 PDF 文件本身**（真 `/Highlight` 批注）。
   *
   * 字节走 base64（`file:writeFile` 只收 utf-8，而 PDF 是二进制）。主进程收到后
   * **原子替换**，中途崩了原文件一个字节不动；顺带更新旁边的高亮索引。
   */
  "library.writeHighlights": (
    input: PdfHighlightsWriteBackInput,
  ) => Promise<PdfHighlightsWriteResult>;
  /**
   * 读**干净底稿**的字节 —— 烘烤时从它出发（底稿 + 全部标注 → 覆盖那个 PDF）。
   *
   * 没有底稿时返回当前文件本身（那时它就是干净的）。走结构化克隆，不做 base64
   * （同 `library.readPdf`）—— 论文十几 MB，base64 要多涨三分之一。
   */
  "library.readOriginalPdf": (
    input: PdfHighlightsReadInput,
  ) => Promise<{ bytes: Uint8Array | null }>;
  /**
   * 读一篇文献的 Markdown 正文,**在应用内预览**(不再跳外部编辑器)。
   *
   * 主进程同时把正文里引用到的图片解析成 data URL 一起返回 —— 渲染进程读不了本地
   * 文件,而 md 里写的是 `images/xxx.jpg` 这种相对路径,只有主进程知道它相对于谁。
   */
  "library.readMarkdown": (input: LibraryReadMarkdownInput) => Promise<{
    ok: boolean;
    error?: string;
    /** 正文。ok 为 false 时是空串。 */
    markdown: string;
    /** md 所在目录的绝对路径(界面上显示用,让用户知道这是哪份文件)。 */
    dir: string;
    /** 文件名,如 `full.md` / `<sha256>.md`。 */
    fileName: string;
    /** 相对引用 → data URL。键与 md 里的写法一致(如 `images/1.jpg`)。 */
    images: Record<string, string>;
    /** 因为过大/过多而没被内联的**本地**引用(远程图不算 —— 它本来就不需要内联)。
     *  给出具体是哪些、而不是一个计数:界面上才能把它们就地标出来,而不是让用户
     *  对着一篇少了几张图的正文猜是哪几张。 */
    skipped: string[];
  }>;
  /**
   * 读一篇文献的 PDF 字节,**在应用内用 pdf.js 阅读器打开**(见 `PdfPreview.tsx`)。
   *
   * 为什么不交给系统默认程序:用户读文献是「在库里翻」的连续动作,弹一个外部窗口
   * 就断了;而且外部程序里拿不到我们库里的元数据/笔记。
   */
  /**
   * 条目下的小笔记(读文献时随手记的),**与「笔记库」是两件事** ——
   * 笔记库的条目本身就是一篇 Markdown,这里的笔记依附于某篇论文/教材。
   */
  "library.listNotes": (input: LibraryNotesListInput) => Promise<{ notes: LibraryNote[] }>;
  /** 新建或修改一条笔记,返回该条目下的完整列表(与其它变更类接口同一约定)。 */
  "library.saveNote": (input: LibraryNoteSaveInput) => Promise<{ notes: LibraryNote[] }>;
  "library.deleteNote": (input: LibraryNoteDeleteInput) => Promise<{ notes: LibraryNote[] }>;
  /** 改条目的显示标题(三个库通用)。 */
  "library.renameItem": (input: LibraryRenameItemInput) => Promise<{ item: LibraryItem | null }>;

  /** 新建一篇空笔记(笔记库)。文件会先落一份 `# 标题` 骨架。 */
  "library.createNote": (input: LibraryCreateNoteInput) => Promise<{ item: LibraryItem | null }>;
  /** 把编辑器的内容写回笔记文件(仅笔记)。 */
  "library.writeNote": (input: LibraryWriteNoteInput) => Promise<{ ok: boolean; error?: string }>;
  /**
   * 直接把一份现成的 Markdown 挂到某条目上(不转录)。同级 `images/` 会一起搬。
   */
  "library.adoptMarkdown": (input: LibraryAdoptMarkdownInput) => Promise<{
    ok: boolean;
    error?: string;
    imageCount: number;
  }>;
  "library.readPdf": (input: LibraryReadPdfInput) => Promise<{
    ok: boolean;
    error?: string;
    /** PDF 原始字节。`ok` 为 false 时是 null。走结构化克隆,不做 base64。 */
    bytes: Uint8Array | null;
  }>;
  /** 批量检测转换情况:共多少篇 / 已转 Markdown / 还没转。
   *  设置页的「批量转换」用它 —— 比把全库拉进渲染端再数省得多。 */
  "library.conversionStats": () => Promise<{ total: number; converted: number; pending: number }>;
  /** 逐篇的转换完整度(设置页的「转录检测」列表)。**完整 = md 有 + 它引用的图都在**。 */
  "library.conversionReport": () => Promise<{
    rows: LibraryConversionRow[];
    total: number;
    complete: number;
    pending: number;
  }>;

  // ── OnlyOffice Document Server(Office 文档可视化编辑,见 contracts/src/ipc/onlyoffice.ts)──
  /** 为一个文件开一次编辑会话:返回 DS 的 api.js 地址与直接交给 `DocsAPI.DocEditor` 的配置。 */
  "onlyoffice.open": (input: OnlyOfficeOpenInput) => Promise<OnlyOfficeOpenResult>;
  /** 让 DS 立刻回调保存(用户点「保存」/ 关标签前)。 */
  "onlyoffice.forceSave": (input: OnlyOfficeSessionInput) => Promise<{ ok: boolean; error?: string }>;
  /** 某次会话的保存状态(最近保存时间 / 最近错误 / DS 状态码)。 */
  "onlyoffice.sessionState": (input: OnlyOfficeSessionInput) => Promise<OnlyOfficeSessionState>;
  /** 关掉会话(清掉主进程里那份记录)。 */
  "onlyoffice.close": (input: OnlyOfficeSessionInput) => Promise<{ ok: boolean }>;
  /** 是否配置了 DS、以及它现在能不能连上(`/healthcheck`)。 */
  "onlyoffice.status": () => Promise<OnlyOfficeStatusResult>;
  "onlyoffice.getConfig": () => Promise<OnlyOfficeConfig>;
  "onlyoffice.setConfig": (input: OnlyOfficeSetConfigInput) => Promise<OnlyOfficeConfig>;
  /**
   * 本机装没装 Document Server、跑没跑、密钥是什么。
   *
   * 设置页用它做**自动填写**:检测到本机那一份就把地址与密钥直接写进配置,用户
   * 不用手抄 `local.json`。主进程里 `detectLocal()` 早就有了(安装流程与工具链
   * 检测都在用),这里只是把它开给渲染端 —— 不然「自动帮我配好」这件事在 UI 侧
   * 无从谈起。只读,不需要管理员权限。
   */
  "onlyoffice.detectLocal": () => Promise<OnlyOfficeLocalDetectResult>;
  // ── 统一数据根 ──
  /** 当前数据根,以及它下面两样东西的**实际路径**(设置页展示用)。 */
  "app.getDataRoot": () => Promise<{
    root: string;
    dbPath: string;
    libraryPath: string;
  }>;
  /** 把整个数据根迁到新位置,**迁完自动重启应用**(数据库没法原地搬家)。
   *  `ok:false` + `error` 时不重启,设置也不改。 */
  "app.moveDataRoot": (input: { path: string }) => Promise<{ ok: boolean; error?: string }>;
  /** 全文检索(ripgrep;sql.js 不含 FTS5)。 */
  "library.fullTextSearch": (input: LibraryFullTextSearchInput) => Promise<{ matches: FullTextMatch[] }>;
  /** 生成/刷新某个库的清单 Markdown,返回其绝对路径(count = 收录条数)。
   *  清单是给 agent 读的 —— 对话里只放 `@该路径`,与文件附件的机制一致。 */
  "library.manifest": (input: LibraryManifestInput) => Promise<{ path: string; count: number }>;
  /**
   * 给**单独一篇**生成清单 —— 「+」菜单里的选择器可以展开分类、只挑其中一篇。
   * 与整库清单同一套机制:只放一行 `@清单路径`,正文由 agent 自己读。
   *
   * `path` 为空串表示没挂上,`blockedReason` 说明是不是被用户自己设的屏蔽挡住了
   * (与 `library.attachToChat` 同一个判据)。**被挡住时要如实说**,不能静默地少挂
   * 一个 —— 否则用户只会觉得"点了没反应"。
   */
  "library.itemManifest": (input: LibraryItemManifestInput) => Promise<{
    path: string;
    count: number;
    /** 有值 = 这条被屏蔽规则挡住了,值是挡住它的原因(给用户看的那句话)。 */
    blockedReason?: string;
  }>;
  /** 把一条附件挂到指定会话的输入框上(左栏右键「添加到当前对话」)。
   *  与 AI 的 `library_attach_to_chat` 共用同一份实现,所以效果一致。 */
  "library.attachToChat": (
    input: LibraryAttachToChatInput,
  ) => Promise<{ ok: boolean; name?: string; count?: number; error?: string }>;

  // 文献库 —— 集合
  "library.listCollections": () => Promise<{ collections: LibraryCollection[] }>;
  /** 新建/改名/删除集合 —— 均返回**完整的新列表**,渲染端整体替换缓存(既定模式)。 */
  "library.createCollection": (input: CollectionCreateInput) => Promise<{ collections: LibraryCollection[] }>;
  /** 改名。`ok: false` 表示重名被拒(此时 collections 不变) —— 由调用方提示用户。 */
  "library.renameCollection": (input: CollectionRenameInput) => Promise<{ collections: LibraryCollection[]; ok: boolean }>;
  "library.deleteCollection": (input: CollectionDeleteInput) => Promise<{ collections: LibraryCollection[] }>;
  /**
   * 把集合移到别处(改父级 / 调同级次序)。
   *
   * `ok: false` = **被拒**(重名,或者会形成环)—— 与 `renameCollection` 同一个口径:
   * 如实把结果回给调用方提示,而不是静默不动。`collections` 无论如何都是**最新的
   * 完整列表**,所以被拒时调用方也不需要再拉一次。
   */
  "library.moveCollection": (input: CollectionMoveInput) => Promise<{
    collections: LibraryCollection[];
    ok: boolean;
    /** `ok: false` 的原因(重名 / 成环)。由主进程给,界面直接摆出来。 */
    error?: string;
  }>;
  /** 把文献加入/移出某集合(多对多,一篇可属多个集合)。 */
  "library.assignCollection": (input: CollectionAssignInput) => Promise<{ collections: LibraryCollection[] }>;

  // 机构认证
  /** 已保存的机构入口档案。注意:档案不含凭据,登录态在浏览器分区里。 */
  "institution.list": () => Promise<{ profiles: InstitutionProfile[] }>;
  "institution.save": (input: InstitutionSaveInput) => Promise<{ profiles: InstitutionProfile[] }>;
  "institution.delete": (input: InstitutionDeleteInput) => Promise<{ profiles: InstitutionProfile[] }>;
  /** 从浏览器分区的 cookie 反推「已登录哪些站点」。 */
  "institution.authStatus": (input: InstitutionAuthStatusInput) => Promise<{ sites: AuthSiteStatus[] }>;
  /** 清除指定域名(或全部)的登录态。 */
  "institution.clearCookies": (input: InstitutionClearCookiesInput) => Promise<{ sites: AuthSiteStatus[] }>;

}

/** The channel names used in invoke/handle and send/on. Keep these centralized
 * so the preload allowlist and the main handlers never drift. */
export const IPC = {
  MODULE_CATALOG: "modules:catalog",
  MODULE_INSTALL: "modules:install",
  MODULE_REMOVE: "modules:remove",
  MODULE_INVOKE: "modules:invoke",
  MODULE_TASK: "modules:task",
  MODULE_CANCEL: "modules:cancel",
  MODULE_TASKS: "modules:tasks",
  // invoke/handle (RPC)
  CLAUDE_START_SESSION: "claude:startSession",
  CLAUDE_LIST_SIDE_CHATS: "claude:listSideChats",
  CLAUDE_SEND_TURN: "claude:sendTurn",
  CLAUDE_INTERRUPT: "claude:interrupt",
  CLAUDE_INJECT: "claude:inject",
  CLAUDE_APPROVE: "claude:approve",
  CLAUDE_RESPOND_QUESTION: "claude:respondQuestion",
  CLAUDE_RESPOND_PLAN_APPROVAL: "claude:respondPlanApproval",
  CLAUDE_REWIND_TURN: "claude:rewindTurn",
  CLAUDE_SUBAGENTS_SAVE: "claude:saveSubagents",
  PROJECT_CREATE: "project:create",
  PROJECT_LIST: "project:list",
  PROJECT_SESSIONS: "project:sessions",
  PROJECT_DELETE: "project:delete",
  PROJECT_ARCHIVE: "project:archive",
  PROJECT_SET_GROUP: "project:setGroup",
  PROJECT_REORDER: "project:reorder",
  PROJECT_PIN: "project:pin",
  PROJECT_RENAME: "project:rename",
  SESSION_DELETE: "session:delete",
  SESSION_ARCHIVE: "session:archive",
  SESSION_RENAME: "session:rename",
  SESSION_FORK: "session:fork",
  SESSION_PIN: "session:pin",
  SESSION_UPDATE_BOOKMARKS: "session:updateBookmarks",
  SESSION_LIST_PINNED: "session:listPinned",
  SESSION_LIST_ALL: "session:listAll",
  SESSION_LIST_NODES: "session:listNodes",
  SESSION_HAS_NODES: "session:hasNodes",
  SESSION_SEARCH: "session:search",
  SESSION_SEARCH_BOOKMARKS: "session:searchBookmarks",
  SESSION_MESSAGES: "session:messages",
  SESSION_SAVE_MESSAGES: "session:saveMessages",
  SESSION_UPSERT_MESSAGES: "session:upsertMessages",
  SESSION_TRUNCATE_AND_INSERT_MESSAGES: "session:truncateAndInsertMessages",
  SESSION_UPDATE_SETTINGS: "session:updateSettings",
  PROVIDER_LIST: "provider:list",
  PROVIDER_HEALTH_CHECK: "provider:healthCheck",
  PROVIDER_COMMANDS: "provider:commands",
  // Settings
  SETTING_GET: "setting:get",
  SETTING_SET: "setting:set",
  SETTING_GET_MANY: "setting:getMany",
  // 文献库 —— 条目
  LIBRARY_LIST: "library:list",
  LIBRARY_GET: "library:get",
  LIBRARY_ADD_ITEMS: "library:addItems",
  LIBRARY_DELETE_ITEMS: "library:deleteItems",
  /** 从回收站还原(放回最后删除的那个分类)。 */
  LIBRARY_RESTORE_ITEMS: "library:restoreItems",
  /** 删除前的"会带走什么"预览(只读)。 */
  LIBRARY_DELETE_PREVIEW: "library:deletePreview",
  LIBRARY_FULL_TEXT_SEARCH: "library:fullTextSearch",
  // 文献库:PDF 文件导入 / 转 Markdown
  LIBRARY_IMPORT_FILES: "library:importFiles",
  /** 导入 Markdown 笔记(笔记库)。 */
  LIBRARY_IMPORT_NOTES: "library:importNotes",
  LIBRARY_CONVERT: "library:convert",
  LIBRARY_REVEAL_FILE: "library:revealFile",
  LIBRARY_OPEN_FILE: "library:openFile",
  LIBRARY_ENTRY_PATH: "library:entryPath",
  LIBRARY_READ_HIGHLIGHTS: "library:readHighlights",
  LIBRARY_SAVE_HIGHLIGHTS: "library:saveHighlights",
  LIBRARY_WRITE_HIGHLIGHTS: "library:writeHighlights",
  LIBRARY_READ_ORIGINAL_PDF: "library:readOriginalPdf",
  LIBRARY_CONVERSION_STATS: "library:conversionStats",
  LIBRARY_CONVERSION_REPORT: "library:conversionReport",
  // 统一数据根
  APP_GET_DATA_ROOT: "app:getDataRoot",
  APP_MOVE_DATA_ROOT: "app:moveDataRoot",
  // OnlyOffice Document Server
  ONLYOFFICE_OPEN: "onlyoffice:open",
  ONLYOFFICE_FORCE_SAVE: "onlyoffice:forceSave",
  ONLYOFFICE_SESSION_STATE: "onlyoffice:sessionState",
  ONLYOFFICE_CLOSE: "onlyoffice:close",
  ONLYOFFICE_STATUS: "onlyoffice:status",
  ONLYOFFICE_GET_CONFIG: "onlyoffice:getConfig",
  ONLYOFFICE_SET_CONFIG: "onlyoffice:setConfig",
  ONLYOFFICE_DETECT_LOCAL: "onlyoffice:detectLocal",
  LIBRARY_ITEM_MANIFEST: "library:itemManifest",
  /** 整个库的清单(「全部<库>」那一行)。 */
  /** 类型注册表:读(返回当前生效的全表,含内置)/ 写(整表替换,校验在主进程)。 */
  /** 左栏大类:读(合并校验后)/ 写(整表替换)。 */
  LIBRARY_GROUPS_GET: "library:groupsGet",
  LIBRARY_GROUPS_SAVE: "library:groupsSave",
  /** 屏蔽规则(哪些资料不进上下文):读 / 写(整表替换,校验在主进程)。 */
  LIBRARY_SUPPRESS_GET: "library:suppressGet",
  LIBRARY_SUPPRESS_SAVE: "library:suppressSave",
  /** 条目关联:查(双向)/ 加(幂等)/ 解除。 */
  LIBRARY_LINKS_OF: "library:linksOf",
  LIBRARY_LINK_COUNTS: "library:linkCounts",
  LIBRARY_LINK_ADD: "library:linkAdd",
  LIBRARY_LINK_REMOVE: "library:linkRemove",
  /** 通用文件条目:导入(linked/attached)与内容读取(文本/图片/二进制分型)。 */
  LIBRARY_IMPORT_GENERIC: "library:importGeneric",
  LIBRARY_READ_FILE: "library:readFile",
  LIBRARY_MANIFEST: "library:manifest",
  /** 把一条附件挂到指定会话的输入框上(左栏右键「添加到当前对话」)。 */
  LIBRARY_ATTACH_TO_CHAT: "library:attachToChat",
  /** 应用内 Markdown 预览:读正文 + 把相对引用的图片解析成 data URL。 */
  LIBRARY_READ_MARKDOWN: "library:readMarkdown",
  /** 应用内 PDF 阅读器:把 PDF 字节交给渲染端(结构化克隆,不做 base64)。 */
  LIBRARY_READ_PDF: "library:readPdf",
  /** 挂上一份现成的 Markdown(跳过转录)。 */
  LIBRARY_ADOPT_MARKDOWN: "library:adoptMarkdown",
  /** 新建笔记 / 写回笔记文件。 */
  LIBRARY_RENAME_ITEM: "library:renameItem",
  LIBRARY_LIST_NOTES: "library:listNotes",
  LIBRARY_SAVE_NOTE: "library:saveNote",
  LIBRARY_DELETE_NOTE: "library:deleteNote",
  LIBRARY_CREATE_NOTE: "library:createNote",
  LIBRARY_WRITE_NOTE: "library:writeNote",
  // 文献库 —— 集合
  LIBRARY_LIST_COLLECTIONS: "library:listCollections",
  LIBRARY_CREATE_COLLECTION: "library:createCollection",
  LIBRARY_RENAME_COLLECTION: "library:renameCollection",
  LIBRARY_DELETE_COLLECTION: "library:deleteCollection",
  LIBRARY_MOVE_COLLECTION: "library:moveCollection",
  LIBRARY_ASSIGN_COLLECTION: "library:assignCollection",
  // 机构认证
  INSTITUTION_LIST: "institution:list",
  INSTITUTION_SAVE: "institution:save",
  INSTITUTION_DELETE: "institution:delete",
  INSTITUTION_AUTH_STATUS: "institution:authStatus",
  INSTITUTION_CLEAR_COOKIES: "institution:clearCookies",
  /** Main → renderer push:库的内容变了(含 AI 改的)。渲染端据此整体重载。 */
  LIBRARY_CHANGED: "library:changed",
  /** Main → renderer push:AI 往这次对话挂了一个附件,渲染端加进输入框的标签区。 */
  COMPOSER_ATTACH: "composer:attach",
  // Voice input
  VOICE_START: "voice:start",
  VOICE_FEED: "voice:feed",
  VOICE_STOP: "voice:stop",
  VOICE_CANCEL: "voice:cancel",
  /** Main → renderer push for live ASR results. */
  VOICE_RESULT: "voice:result",
  /** List catalog + downloaded models + active selection. */
  VOICE_MODEL_LIST: "voice:modelList",
  /** Begin downloading a catalog model. */
  VOICE_DOWNLOAD_MODEL: "voice:downloadModel",
  /** Cancel an in-flight model download. */
  VOICE_CANCEL_MODEL_DOWNLOAD: "voice:cancelModelDownload",
  /** Select a downloaded model as the active voice model. */
  VOICE_SELECT_MODEL: "voice:selectModel",
  /** Delete a downloaded model's local files. */
  VOICE_REMOVE_MODEL: "voice:removeModel",
  /** Read the current voice model root directory. */
  VOICE_GET_MODEL_DIR: "voice:getModelDir",
  /** Change the voice model root directory (or reset to default). */
  VOICE_SET_MODEL_DIR: "voice:setModelDir",
  /** Main → renderer push for model download progress. */
  VOICE_DOWNLOAD_PROGRESS: "voice:downloadProgress",
  // Notifications
  NOTIFICATION_GET_PREFS: "notification:getPrefs",
  NOTIFICATION_SET_PREFS: "notification:setPrefs",
  NOTIFICATION_FOCUS_SESSION: "notification:focusSession",
  // Custom models (user-defined Anthropic-compatible endpoints)
  CUSTOM_MODEL_LIST: "customModel:list",
  CUSTOM_MODEL_SAVE: "customModel:save",
  CUSTOM_MODEL_DELETE: "customModel:delete",
  CUSTOM_MODEL_TEST: "customModel:test",
  CUSTOM_MODEL_GET_TOKEN: "customModel:getToken",
  // 扩展桥（网页端协议的传输层）：配对状态查询 + 换令牌
  WEB_BRIDGE_STATUS: "webBridge:status",
  WEB_BRIDGE_REGENERATE_TOKEN: "webBridge:regenerateToken",
  // 公网 MCP 端点（给 ChatGPT 的 Connector 用）
  PUBLIC_MCP_STATUS: "publicMcp:status",
  PUBLIC_MCP_SET_ENABLED: "publicMcp:setEnabled",
  PUBLIC_MCP_REGENERATE_SECRET: "publicMcp:regenerateSecret",
  PUBLIC_MCP_START_TUNNEL: "publicMcp:startTunnel",
  PUBLIC_MCP_STOP_TUNNEL: "publicMcp:stopTunnel",
  PUBLIC_MCP_SET_PROJECT: "publicMcp:setProject",
  PUBLIC_MCP_SET_TUNNEL_CONFIG: "publicMcp:setTunnelConfig",
  // Pi models (visual editor for ~/.pi/agent/models.json)
  PI_MODELS_LIST: "piModels:list",
  PI_MODELS_SAVE: "piModels:save",
  PI_MODELS_DELETE: "piModels:delete",
  PI_MODELS_GET_API_KEY: "piModels:getApiKey",
  PI_MODELS_LIST_AVAILABLE: "piModels:listAvailable",
  // Codex model providers (materialized into <CODEX_HOME>/config.toml)
  CODEX_MODELS_LIST: "codexModels:list",
  CODEX_MODELS_SAVE: "codexModels:save",
  CODEX_MODELS_DELETE: "codexModels:delete",
  CODEX_MODELS_GET_API_KEY: "codexModels:getApiKey",
  // Theme / color scheme
  THEME_GET: "theme:get",
  THEME_SET: "theme:set",
  // File read (on-demand diff rendering)
  FILE_READ: "file:readFile",
  // File read as base64 data URL (image preview)
  FILE_READ_BINARY: "file:readBinary",
  // OS dialog image picker → base64 images (composer 图片 button)
  FILE_PICK_IMAGES: "file:pickImages",
  // Clipboard-pasted external file → temp path (composer paste)
  CLIPBOARD_SAVE_FILE: "clipboard:saveFile",
  // Image data URL → OS clipboard (image lightbox 复制)
  CLIPBOARD_WRITE_IMAGE: "clipboard:writeImage",
  // File tree listing + writing (P4 IDE right panel)
  FILE_LIST_DIR: "file:listDir",
  FILE_SEARCH: "file:search",
  FILE_WRITE: "file:writeFile",
  // Create a directory (file-tree "新建文件夹")
  FILE_MKDIR: "file:mkdir",
  // Delete a file or directory (file-tree "删除" — moves to system trash)
  FILE_DELETE: "file:delete",
  // Rename a file or directory in place (file-tree "重命名")
  FILE_RENAME: "file:rename",
  // Copy a file into a directory (file-tree "复制" + "粘贴" pair)
  FILE_COPY: "file:copy",
  FILE_GREP: "file:grep",
  RG_STATUS: "rg:status",
  RG_INSTALL: "rg:install",
  // Git operations (P4 Git panel)
  GIT_DISCOVER_REPOS: "git:discoverRepos",
  GIT_STATUS: "git:status",
  GIT_STAGE: "git:stage",
  GIT_UNSTAGE: "git:unstage",
  GIT_COMMIT: "git:commit",
  GIT_PUSH: "git:push",
  GIT_PULL: "git:pull",
  GIT_DIFF: "git:diff",
  GIT_FILE_BLOB: "git:fileBlob",
  GIT_DISCARD: "git:discard",
  GIT_GENERATE_COMMIT: "git:generateCommitMessage",
  GIT_CANCEL_GENERATE_COMMIT: "git:cancelGenerateCommitMessage",
  GIT_LOG: "git:log",
  GIT_SHOW_COMMIT: "git:showCommit",
  GIT_SHOW_FILE: "git:showFile",
  GIT_LIST_BRANCHES: "git:listBranches",
  GIT_CHECKOUT: "git:checkout",
  GIT_DELETE_BRANCH: "git:deleteBranch",
  GIT_MERGE_PREVIEW: "git:mergePreview",
  GIT_MERGE: "git:merge",
  GIT_MERGE_ABORT: "git:mergeAbort",
  // Git worktrees (isolated agent sessions)
  GIT_WORKTREE_LIST: "git:worktreeList",
  GIT_WORKTREE_STATUS: "git:worktreeStatus",
  GIT_WORKTREE_MERGE_BACK: "git:worktreeMergeBack",
  GIT_WORKTREE_REMOVE: "git:worktreeRemove",
  // Integrated terminal (P4 IDE right panel)
  TERMINAL_CREATE: "terminal:create",
  TERMINAL_WRITE: "terminal:write",
  TERMINAL_RESIZE: "terminal:resize",
  TERMINAL_KILL: "terminal:kill",
  TERMINAL_LIST: "terminal:list",
  // Embedded browser (WebContentsView + DOM element picker)
  BROWSER_CREATE: "browser:create",
  BROWSER_LOAD_URL: "browser:loadUrl",
  BROWSER_GO_BACK: "browser:goBack",
  BROWSER_GO_FORWARD: "browser:goForward",
  BROWSER_RELOAD: "browser:reload",
  BROWSER_SET_BOUNDS: "browser:setBounds",
  BROWSER_SET_PICK_MODE: "browser:setPickMode",
  BROWSER_SHOW: "browser:show",
  BROWSER_HIDE: "browser:hide",
  BROWSER_CLOSE: "browser:close",
  BROWSER_CAPTURE_FRAME: "browser:captureFrame",
  BROWSER_BOOKMARK_ADD: "browser:bookmarkAdd",
  BROWSER_BOOKMARK_REMOVE: "browser:bookmarkRemove",
  BROWSER_SET_DEVICE: "browser:setDevice",
  BROWSER_CLEAR_CACHE: "browser:clearCache",
  // Clear sign-in state (cookies) of the embedded browser — separate from
  // clearCache, which deliberately keeps cookies so users stay signed in.
  BROWSER_CLEAR_COOKIES: "browser:clearCookies",
  // Address history + HTTP Basic Auth (embedded browser)
  BROWSER_HISTORY_REMOVE: "browser:historyRemove",
  BROWSER_HISTORY_CLEAR: "browser:historyClear",
  BROWSER_AUTH_RESPOND: "browser:authRespond",
  // Download bar (embedded browser): open file / reveal in folder
  BROWSER_DOWNLOAD_ACTION: "browser:downloadAction",
  // App / runtime info (About panel)
  APP_INFO: "app:info",
  // Auto-update (electron-updater)
  APP_CHECK_FOR_UPDATES: "app:checkForUpdates",
  APP_DOWNLOAD_UPDATE: "app:downloadUpdate",
  APP_QUIT_AND_INSTALL: "app:quitAndInstall",
  // Open a project root in the OS file manager (main refuses non-project paths)
  SHELL_OPEN_PATH: "shell:openPath",
  // Reveal a file/dir inside a project root in the OS file manager (selects it)
  SHELL_SHOW_ITEM_IN_FOLDER: "shell:showItemInFolder",
  // Open a file inside a project root with the OS default application
  SHELL_OPEN_FILE: "shell:openFile",
  // Native multi-file picker (project-external files allowed) for the composer
  DIALOG_PICK_FILES: "dialog:pickFiles",
  DIALOG_PICK_FOLDER: "dialog:pickFolder",
  // Skill discovery for the composer `/` menu (scans the universal ~/.mcode/skills)
  SKILLS_LIST: "skills:list",
  // Skill management (settings panel): read / save / delete a single skill
  SKILLS_READ: "skills:read",
  SKILLS_SAVE: "skills:save",
  SKILLS_DELETE: "skills:delete",
  // Copy skills from the universal library into the current project's dir
  SKILLS_COPY_TO_PROJECT: "skills:copyToProject",
  // 技能预设（"一套技能"）与跨项目总览
  SKILLS_PRESETS_LIST: "skills:presetsList",
  SKILLS_PRESETS_SAVE: "skills:presetsSave",
  SKILLS_PRESETS_DELETE: "skills:presetsDelete",
  SKILLS_PROJECT_OVERVIEW: "skills:projectOverview",
  // Per-engine availability matrix for the universal skill library
  SKILLS_ENGINES_SET: "skills:enginesSet",
  // Bundle manifest (import groups) for the universal skill library
  SKILLS_BUNDLES: "skills:bundles",
  // Per-engine availability for a WHOLE bundle of skills in one write
  SKILLS_ENGINES_SET_BULK: "skills:enginesSetBulk",
  // Skill import (settings panel): scan external tools + copy into ~/.mcode/skills
  SKILLS_SCAN_SOURCES: "skills:scanSources",
  SKILLS_IMPORT: "skills:import",
  // Import a whole skill package from a GitHub repo URL (one repo = one bundle)
  SKILLS_IMPORT_GITHUB: "skills:importGithub",
  // MCP management (settings panel): list / toggle / add / remove / import
  MCP_LIST: "mcp:list",
  MCP_TOGGLE: "mcp:toggle",
  // Per-engine visibility matrix for MCP servers (claude/codex; pi has no MCP)
  MCP_ENGINES_SET: "mcp:enginesSet",
  MCP_AUTHORIZE: "mcp:authorize",
  MCP_UNAUTHORIZE: "mcp:unauthorize",
  MCP_SAVE: "mcp:save",
  MCP_REMOVE: "mcp:remove",
  MCP_SCAN_IMPORT: "mcp:scanImport",
  MCP_IMPORT: "mcp:import",
  // Context hosting (settings panel): global instructions / tool usage
  CONTEXT_GET: "context:get",
  CONTEXT_SAVE: "context:save",
  TOOLS_USAGE: "tools:usage",
  // Output styles (settings panel): list built-in + user styles
  OUTPUT_STYLE_LIST: "outputStyle:list",
  // Usage stats (settings panel): aggregated token/cost usage over time ranges
  USAGE_STATS: "usage:stats",
  // Language servers (LSP): install/enable/sync/request
  LSP_LIST: "lsp:list",
  LSP_INSTALL: "lsp:install",
  LSP_INSTALL_FROM_FILE: "lsp:installFromFile",
  LSP_UNINSTALL: "lsp:uninstall",
  LSP_TOGGLE: "lsp:toggle",
  LSP_SET_PATH: "lsp:setPath",
  LSP_HEALTH_CHECK: "lsp:healthCheck",
  LSP_PREWARM: "lsp:prewarm",
  LSP_RESTART: "lsp:restart",
  LSP_OPEN_DOC: "lsp:openDocument",
  LSP_CLOSE_DOC: "lsp:closeDocument",
  LSP_DID_CHANGE: "lsp:didChange",
  LSP_DID_SAVE: "lsp:didSave",
  LSP_REQUEST: "lsp:request",
  // Agent runtimes (download-on-demand): list/install/remove + progress push
  RUNTIMES_LIST: "runtimes:list",
  RUNTIMES_INSTALL: "runtimes:install",
  RUNTIMES_INSTALL_LOCAL: "runtimes:installLocal",
  RUNTIMES_REMOVE: "runtimes:remove",
  RUNTIMES_EVENT: "runtimes:event",
  // 文档工具链(外部依赖):pandoc / python 包 / TeX / zip
  TOOLCHAIN_CHECK: "toolchain:check",
  TOOLCHAIN_INSTALL: "toolchain:install",
  TOOLCHAIN_REMOVE: "toolchain:remove",
  TOOLCHAIN_EVENT: "toolchain:event",
  // 工作流(设置 → 工作流):图形式的对话流程,取代原来写死的五个模式
  WORKFLOW_LIST: "workflow:list",
  WORKFLOW_GET: "workflow:get",
  WORKFLOW_APPROVE: "workflow:approve",
  WORKFLOW_NODE_TYPES: "workflow:nodeTypes",
  WORKFLOW_SAVE: "workflow:save",
  WORKFLOW_REMOVE: "workflow:remove",
  WORKFLOW_PIN_DEFAULT: "workflow:pinDefault",
  WORKFLOW_RESTORE_DEFAULT: "workflow:restoreDefault",
  WORKFLOW_APPLY_SHIPPED_UPDATE: "workflow:applyShippedUpdate",
  WORKFLOW_DISMISS_SHIPPED_UPDATE: "workflow:dismissShippedUpdate",
  WORKFLOW_EXPORT: "workflow:export",
  WORKFLOW_IMPORT: "workflow:import",
  WORKFLOW_IMPORT_FROM_FILE: "workflow:importFromFile",
  // 代理档案:一份存下来的子 agent 配置,建节点时直接套用(见 contracts/agentProfile.ts)
  WORKFLOW_AGENT_PROFILES: "workflow:agentProfiles",
  WORKFLOW_SAVE_AGENT_PROFILE: "workflow:saveAgentProfile",
  WORKFLOW_REMOVE_AGENT_PROFILE: "workflow:removeAgentProfile",
  /** 在岔路口选一条路 —— **回答一个还活着的运行**,不是开一次新的。 */
  WORKFLOW_CHOOSE: "workflow:choose",
  /** 从某一步接着往下跑(重跑那一步 + 它的全部下游)。**失败卡的「再试一次」和图上
   *  挑一步"从这儿往下走"走的是同一条**——区别只在要不要带 `note`。 */
  WORKFLOW_RETRY: "workflow:retry",
  // 自动化(设置 → 工作流 → 自动化那一栏):触发器节点在后**台**起一条运行。
  // 这三个只在桌面暴露(手机端那个 RPC 是手写白名单)。
  /** **立刻跑一次** —— 冒充一个 manual 触发器。 */
  AUTOMATION_RUN: "automation:run",
  /** 这条自动化的运行历史(从存档折出来)。 */
  AUTOMATION_RUNS: "automation:runs",
  /** 这条自动化的后台会话 id(没跑过时 null)。 */
  AUTOMATION_SESSIONS: "automation:sessions",
  // 守望(会话输入区那颗「守望」按钮)。同样只在桌面暴露。
  /** 以某条会话为发起会话,起一次内置模板「长任务守望」的运行。 */
  AUTOMATION_WATCH: "automation:watch",
  /** 这条会话上有没有正在跑的守望。 */
  AUTOMATION_WATCH_STATUS: "automation:watchStatus",
  /** 全部命令模板(守望面板的下拉)。 */
  AUTOMATION_WATCH_TEMPLATES: "automation:watchTemplates",
  /** 存整份命令模板列表。 */
  AUTOMATION_WATCH_TEMPLATES_SAVE: "automation:watchTemplatesSave",
  /** 全部触发器的事实状态(自动化管理页回答「它怎么没反应」的那份)。 */
  AUTOMATION_STATUS_ALL: "automation:statusAll",
  /** 自定义 UI:带着右键目标运行一条自动化。 */
  CUSTOM_UI_RUN_AUTOMATION: "customUi:runAutomation",
  /** 某个对话的图运行历史(从存档折出来的轻量摘要)。 */
  RUNS_HISTORY: "runs:history",
  // 记忆(main/memory/):渠道字符串本体钉在 `../memory.ts` 的那几个
  // MEMORY_*_CHANNEL 常量上 —— 这里只取值,不写第二份字符串。
  MEMORY_ASSISTANT: MEMORY_ASSISTANT_CHANNEL,
  MEMORY_MANAGE: MEMORY_MANAGE_CHANNEL,
  PROJECT_INIT_LIST: "projectInit:list",
  PROJECT_INIT_GET: "projectInit:get",
  PROJECT_INIT_SAVE: "projectInit:save",
  PROJECT_INIT_DELETE: "projectInit:delete",
  PROJECT_INIT_PREVIEW: "projectInit:preview",
  PROJECT_INIT_APPLY: "projectInit:apply",
  PROJECT_INIT_SET_DEFAULT: "projectInit:setDefault",
  MEMORY_LIST: MEMORY_LIST_CHANNEL,
  MEMORY_READ: MEMORY_READ_CHANNEL,
  MEMORY_SAVE: MEMORY_SAVE_CHANNEL,
  MEMORY_DELETE: MEMORY_DELETE_CHANNEL,
  MEMORY_CATEGORIES: MEMORY_CATEGORIES_CHANNEL,
  MEMORY_REVIEW: MEMORY_REVIEW_CHANNEL,
  MEMORY_REVIEW_DELETE: MEMORY_REVIEW_DELETE_CHANNEL,
  // 监控(main/monitoring/):总览快照 + 最近的运行摘要。
  MONITORING_OVERVIEW: "monitoring:overview",
  MONITORING_RUNS: "monitoring:runs",
  /** Main → renderer push:工作流 / 自动化 / 代理档案 / 节点类型变了(含 AI 改的)。
   *  渲染端据此重拉列表(见 `WorkflowChangedMessage` 那条 ⚠️)。 */
  WORKFLOW_CHANGED: "workflow:changed",
  // 钩子(设置 → 钩子):事件驱动的命令,宿主侧执行(见 contracts/hook.ts)
  HOOKS_LIST: "hooks:list",
  HOOKS_RUNS: "hooks:runs",
  HOOKS_SAVE: "hooks:save",
  HOOKS_REMOVE: "hooks:remove",
  HOOKS_TEST: "hooks:test",
  // Plugins (settings panel): list/install (local/git/marketplace)/enable/
  // remove + marketplace management. No push channel — every RPC resolves
  // when done and the panel re-lists.
  PLUGINS_LIST: "plugins:list",
  PLUGINS_INSTALL_LOCAL: "plugins:installLocal",
  PLUGINS_INSTALL_GIT: "plugins:installGit",
  PLUGINS_INSTALL_MARKETPLACE: "plugins:installMarketplace",
  PLUGINS_SET_ENABLED: "plugins:setEnabled",
  PLUGINS_REMOVE: "plugins:remove",
  PLUGINS_MARKETPLACE_LIST: "plugins:marketplaceList",
  PLUGINS_MARKETPLACE_ADD: "plugins:marketplaceAdd",
  PLUGINS_MARKETPLACE_REMOVE: "plugins:marketplaceRemove",
  PLUGINS_MARKETPLACE_REFRESH: "plugins:marketplaceRefresh",
  // Mobile companion (LAN pairing + device management) — invoke/handle (RPC).
  MOBILE_START_PAIRING: "mobile:startPairing",
  MOBILE_CANCEL_PAIRING: "mobile:cancelPairing",
  MOBILE_LIST_DEVICES: "mobile:listDevices",
  MOBILE_REVOKE_DEVICE: "mobile:revokeDevice",
  MOBILE_GET_STATUS: "mobile:getStatus",
  MOBILE_GET_ACTIVE_COUNT: "mobile:getActiveCount",
  // Relay (SSH-based remote access) — invoke/handle (RPC).
  RELAY_SAVE_CONFIG: "relay:saveConfig",
  RELAY_GET_CONFIG: "relay:getConfig",
  RELAY_CONNECT: "relay:connect",
  RELAY_DISCONNECT: "relay:disconnect",
  RELAY_STATUS: "relay:status",
  // Relay push events (main → renderer).
  RELAY_EVENT: "relay:event",
  // send/on (push events)
  CLAUDE_EVENT: "claude:event",
  SESSION_TITLE_UPDATED: "session:titleUpdated",
  TERMINAL_DATA: "terminal:data",
  TERMINAL_EXIT: "terminal:exit",
  LSP_EVENT: "lsp:event",
  BROWSER_EVENT: "browser:event",
  THEME_CHANGED: "theme:changed",
  UPDATE_AVAILABLE: "update:available",
  UPDATE_DOWNLOAD_PROGRESS: "update:downloadProgress",
  UPDATE_DOWNLOADED: "update:downloaded",
  WINDOW_FOCUS_CHANGED: "window:focusChanged",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

