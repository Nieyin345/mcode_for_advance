/**
 * IPC contract — validated messages crossing the Electron main↔renderer boundary.
 * Every channel is whitelisted in the preload and validated with zod before
 * the main process acts on it. This is the security boundary.
 */
import { z } from "zod";
import type { RuntimeEvent } from "./runtime.js";
import { WorkflowDocSchema, type WorkflowDoc, type WorkflowListEntry } from "./workflow.js";
import { HookSpecSchema, type HookRun, type HookSpec } from "./hook.js";
import { AgentProfileSchema, type AgentProfile, type AgentProfileCatalog } from "./agentProfile.js";
import type { NodeTypeCatalog } from "./nodeType.js";
import { INTEGRATION_IDS, type IntegrationId, type IntegrationPublic } from "./integrations.js";
import {
  TEMPLATE_KINDS,
  type TemplateEntry,
  type TemplateFileContent,
  type TemplateKind,
} from "./templates.js";
import type { Project, Session, MessageRecord, TurnInput, ApprovalDecision, SessionBookmark } from "./session.js";
import type { ProviderCapabilities, UserInputAnswers, BuiltinModelOption } from "./provider.js";
import type { CustomModelPublic, CustomModelInput, TestCustomModelResult } from "./customModel.js";
import type { PiProviderConfig, PiProviderPublic } from "./piModel.js";
import type { CodexProviderPublic } from "./codexModel.js";
import type { ThemeName, EffectiveTheme, ThemeChangedMessage } from "./theme.js";
import type { PairingStartResult, PairedDevice } from "./mobile.js";
import type { RelayStatus, RelayVpsConfig, RelayVpsConfigInput } from "./relay.js";
import type {
  LibraryItem,
  LibraryCollection,
  InstitutionProfile,
  DownloadJob,
  DownloadStatus,
  ExternalSearchResult,
  FullTextMatch,
  AuthSiteStatus,
  LibraryConversionRow,
  LibraryNote,
} from "./library.js";
import { LIBRARY_KINDS, type LibraryKind } from "./library.js";
import type {
  PluginState,
  PluginMarketplaceState,
  PluginsInstallLocalInput,
  PluginsInstallGitInput,
  PluginsInstallMarketplaceInput,
  PluginsSetEnabledInput,
  PluginsRemoveInput,
  PluginsMarketplaceAddInput,
  PluginsMarketplaceRemoveInput,
  PluginsMarketplaceRefreshInput,
} from "./plugin.js";

// Re-export the plugin contracts so consumers can import from "@contracts/ipc"
// (mirrors the relay.ts pattern).
export {
  BUILTIN_MARKETPLACES,
  PLUGINS_ENABLED_SETTING_KEY,
  PLUGINS_MARKETPLACES_SETTING_KEY,
  PLUGINS_MCP_DISABLED_SETTING_KEY,
  PLUGIN_MANIFEST_DIRS,
  PLUGIN_NAME_RE,
  PluginManifestSchema,
  PluginMarketEntrySourceSchema,
  PluginMarketEntrySchema,
  PluginMarketplaceManifestSchema,
  PluginsListSchema,
  PluginsInstallLocalSchema,
  PluginsInstallGitSchema,
  PluginsInstallMarketplaceSchema,
  PluginsSetEnabledSchema,
  PluginsRemoveSchema,
  PluginsMarketplaceListSchema,
  PluginsMarketplaceAddSchema,
  PluginsMarketplaceRemoveSchema,
  PluginsMarketplaceRefreshSchema,
} from "./plugin.js";
export type {
  PluginManifest,
  PluginMarketEntrySource,
  PluginMarketplaceManifest,
  PluginSkillSummary,
  PluginCommandSummary,
  PluginAgentSummary,
  PluginHookSummary,
  PluginMcpKind,
  PluginMcpServerSummary,
  PluginComponents,
  PluginSourceKind,
  PluginSourceInfo,
  PluginState,
  PluginMarketplaceRecord,
  PluginMarketEntry,
  PluginMarketplaceState,
  PluginsListInput,
  PluginsInstallLocalInput,
  PluginsInstallGitInput,
  PluginsInstallMarketplaceInput,
  PluginsSetEnabledInput,
  PluginsRemoveInput,
  PluginsMarketplaceListInput,
  PluginsMarketplaceAddInput,
  PluginsMarketplaceRemoveInput,
  PluginsMarketplaceRefreshInput,
} from "./plugin.js";

// Re-export relay types so consumers can import from "@contracts/ipc".
export type {
  RelayState,
  RelayStatus,
  RelayVpsConfig,
  RelayVpsConfigInput,
  RelayForwarderChoice,
} from "./relay.js";
export {
  RelayVpsConfigSchema,
  RELAY_CONFIG_SETTING_KEY,
  RELAY_DEFAULT_PUBLIC_PORT,
} from "./relay.js";

/**
 * Default provider id — used when no provider is explicitly specified for a
 * new session. Currently "claude-sdk" (Claude Agent SDK).
 */
export const DEFAULT_PROVIDER_ID = "claude-sdk";

/**
 * Setting key under which the user's color-scheme preference is persisted.
 * Value is one of {@link ThemeName}: "dark" | "light" | "system". Shared
 * between main (theme module + IPC handler) and renderer (settings panel +
 * inline FOUC script) so the string never drifts.
 */
export const THEME_SETTING_KEY = "theme";

/** zod schema for the theme preference (used by SetThemeSchema). */
export const ThemeNameSchema = z.enum(["dark", "light", "system"]);

/**
 * Setting key under which the UI theme STYLE preference is persisted
 * (prototypes/theme-sketch-redesign.html). Orthogonal to THEME_SETTING_KEY
 * (light/dark): the renderer mirrors the value as a `.sketch` class on <html>
 * next to `.dark`, and nativeTheme never sees it. Rides the generic
 * setting.get/set IPC like the other ui.* keys (first-paint getMany →
 * sessionStore.themeStyle).
 */
export const THEME_STYLE_SETTING_KEY = "ui.themeStyle";

/** zod schema for the theme-style preference (type lives in theme.ts). */
export const ThemeStyleSchema = z.enum(["classic", "sketch"]);

/**
 * Setting key under which the auto-update flow state is persisted, so reopening
 * the About panel (or restarting the app mid-download) restores the progress /
 * "ready to install" banner instead of dropping the user back to idle.
 *
 * Value is a JSON-encoded {@link PersistedUpdateState} string. The main process
 * writes it from the autoUpdater event callbacks; the renderer reads it on mount
 * via the generic `setting.get` IPC and clears it after install.
 */
export const UPDATE_STATE_SETTING_KEY = "update.state";

/**
 * Display mode for the center pane:
 *  - "single" (default): clicking a thread in the left bar replaces the
 *    center pane content (legacy behavior).
 *  - "tabs": threads accumulate as tabs along the top of the center pane.
 *    Closing a tab leaves any in-flight turn running in the background;
 *    re-opening the thread restores the live state.
 *
 * Persisted in the `settings` table under this key; the renderer reads it
 * at boot via the generic `setting.get` IPC and applies it to the
 * sessionStore's `displayMode` field.
 */
export const DISPLAY_MODE_SETTING_KEY = "ui.displayMode";

/**
 * Search-dialog file-type filter history. Persisted in the `settings` table
 * under this key as a JSON string array (most recent first, deduplicated,
 * capped) — the search dialog feeds it into a `<datalist>` so users can
 * re-pick file types they've typed before.
 */
export const SEARCH_FILE_TYPES_SETTING_KEY = "ui.search.fileTypes";

/** zod schema + TS union for the display-mode preference. */
export const DisplayModeSchema = z.enum(["single", "tabs"]);
export type DisplayMode = z.infer<typeof DisplayModeSchema>;

/**
 * Tab-bar layout preference: when "true", the center tab strips (unified
 * bar in `tabs` displayMode, plus the session strip / editor file strip in
 * `single` mode) wrap their tabs onto multiple rows instead of scrolling
 * one horizontal row (capped at ~3 rows, then vertical scroll). Toggled
 * from the tab bars' "⋯" overflow menu. Same hydration pattern as
 * `ui.displayMode` (first-paint getMany → sessionStore.tabBarMultiRow).
 */
export const TAB_BAR_MULTI_ROW_SETTING_KEY = "ui.tabBarMultiRow";

/**
 * Left-bar view preference:
 *  - "tree" (default): the classic project → session tree.
 *  - "stream": the session-first flat list (T3-style cards with a project
 *    scope filter).
 *
 * Persisted in the `settings` table under this key, same hydration pattern
 * as `ui.displayMode` (first-paint getMany → sessionStore.leftBarMode).
 */
export const LEFTBAR_MODE_SETTING_KEY = "ui.leftBarMode";
export const LeftBarModeSchema = z.enum(["tree", "stream"]);
export type LeftBarMode = z.infer<typeof LeftBarModeSchema>;

/**
 * UI language preference:
 *  - "zh" (default): Simplified Chinese — the project's original UI language.
 *  - "en": English.
 *
 * Persisted in the `settings` table under this key; the renderer reads it at
 * boot (first-paint `setting.getMany` batch) into the sessionStore's `locale`
 * field. All translated components subscribe to `locale` via `useI18n()` and
 * re-render immediately when it flips — no restart needed.
 */
export const UI_LOCALE_SETTING_KEY = "ui.locale";

/** zod schema + TS union for the UI language preference. */
export const LocaleSchema = z.enum(["zh", "en"]);
export type Locale = z.infer<typeof LocaleSchema>;

/**
 * Setting key under which the session auto-archive rules are persisted (JSON).
 *
 * A session is auto-archived when its `updated_at` (bumped by every activity)
 * is older than the project's effective threshold: `overrides[projectId]`
 * when present, otherwise `defaultDays`. A threshold of `0` means "never
 * archive". Pinned and running sessions are always excluded. The main-process
 * AutoArchiver reads this key fresh on every tick, so a settings change takes
 * effect on the next tick without any push sync.
 */
export const AUTO_ARCHIVE_SETTING_KEY = "session.autoArchive";

/**
 * Setting key persisting the composer's default working environment for NEW
 * sessions ("true" = isolated worktree, "false"/absent = local project root).
 * Read at first paint into sessionStore's `worktreeMode` slot; written by
 * setWorktreeMode whenever the default (not a session-specific intent) flips.
 */
export const SESSION_WORKTREE_DEFAULT_SETTING_KEY = "session.worktreeDefault";

/**
 * Setting key persisting the managed ROOT directory for isolated-session
 * worktrees (absolute path; empty/absent = the default
 * <userData>/worktrees). Read fresh on every worktree creation, so a change
 * only affects FUTURE worktrees — materialized sessions keep their recorded
 * path regardless.
 */
export const WORKTREE_ROOT_SETTING_KEY = "worktree.root";

/**
 * Setting key persisting left-bar DISPLAY NAMES for worktree directories, as
 * a JSON map of normalized worktree path → name. Purely cosmetic — a session
 * never reads its worktree name; missing entries fall back to the directory
 * basename. Written by the left bar's "rename worktree" dialog.
 */
export const WORKTREE_NAMES_SETTING_KEY = "worktree.names";

/** Settings key for per-project avatar color overrides ("project.colors") —
 *  a JSON map of projectId → hex. Purely cosmetic; missing entries fall back
 *  to the deterministic name-hash color (see the renderer's
 *  lib/projectAvatar.ts). Written by the new-session panel's project manage
 *  menu; keeping colors out of the projects table avoids a DB migration for
 *  what is a display-only concern (same trade as worktree.names). */
export const PROJECT_COLORS_SETTING_KEY = "project.colors";

/** zod schema for the auto-archive rules persisted under AUTO_ARCHIVE_SETTING_KEY. */
export const AutoArchiveConfigSchema = z.object({
  /** Master switch — when false, the AutoArchiver is a no-op. */
  enabled: z.boolean(),
  /** Global default inactivity threshold in days; applies to every project
   *  without an explicit override. */
  defaultDays: z.number().int().min(0),
  /** Per-project overrides: projectId -> threshold in days (`0` = never
   *  archive). Projects absent from this map inherit `defaultDays`. */
  overrides: z.record(z.string(), z.number().int().min(0)),
});
export type AutoArchiveConfig = z.infer<typeof AutoArchiveConfigSchema>;

export const DEFAULT_AUTO_ARCHIVE_CONFIG: AutoArchiveConfig = {
  enabled: false,
  defaultDays: 30,
  overrides: {},
};

/**
 * Parse the raw settings-table value into an AutoArchiveConfig. Any malformed
 * or missing value falls back to the disabled default — shared by the main
 * AutoArchiver and the renderer's settings hydration.
 */
export function parseAutoArchiveConfig(raw: string | null | undefined): AutoArchiveConfig {
  if (!raw) return { ...DEFAULT_AUTO_ARCHIVE_CONFIG, overrides: {} };
  try {
    const parsed = AutoArchiveConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to the default
  }
  return { ...DEFAULT_AUTO_ARCHIVE_CONFIG, overrides: {} };
}


/**
 * Setting key under which the chat message-stream density is persisted.
 *  - "compact"    : tighter vertical rhythm — denser, more messages per fold.
 *  - "comfortable" (default): the historical look (assistant `mt-3` / user
 *    `mt-5`, block gap `space-y-2`).
 *  - "cozy"       : more breathing room between rows and blocks.
 *
 * Drives two CSS custom properties written on <html> by lib/appearance.ts:
 *   --chat-row-gap-assistant / --chat-row-gap-user (top margin of each row)
 *   --chat-block-gap (gap between blocks inside a single message)
 * with static fallbacks in styles.css so the uncustomized state matches the
 * old hardcoded values. Mirrors the displayMode pipeline.
 */
export const UI_CHAT_DENSITY_SETTING_KEY = "ui.chatDensity";

/** zod schema + TS union for the chat density preference. */
export const ChatDensitySchema = z.enum(["compact", "comfortable", "cozy"]);
export type ChatDensity = z.infer<typeof ChatDensitySchema>;

/**
 * Setting key under which the user's preferred left-bar project view is
 * persisted. `"flat"` (default) renders projects as a flat list; `"grouped"`
 * clusters them under collapsible headers keyed by `Project.group`. Mirrors
 * the displayMode pipeline (hydrated in sessionStore.init, written on toggle).
 */
export const UI_PROJECT_VIEW_SETTING_KEY = "ui.projectView";

/** zod schema + TS union for the left-bar project view preference. */
export const ProjectViewSchema = z.enum(["flat", "grouped"]);
export type ProjectView = z.infer<typeof ProjectViewSchema>;

/**
 * Setting key under which per-group metadata (color + display order) is
 * persisted as a JSON object keyed by group name. Groups are not a first-class
 * DB entity — they're derived from `Project.group` — so their metadata lives
 * here alongside the projects that reference them.
 *
 * Value shape: `Record<groupName, { color?: "R G B"|null, order?: number }>`.
 * `color` follows the same "R G B" triplet convention as userMessageColor /
 * accentColor (null = default theme color). `order` is ascending; groups
 * missing from the blob fall back to first-appearance order. Stale entries
 * for dissolved groups are harmless (filtered out on read by active groups).
 */
export const UI_PROJECT_GROUPS_SETTING_KEY = "ui.projectGroups";

/** Setting key under which the last-activated project id is persisted, so
 *  `init()` can restore the user's previous landing project on the next
 *  launch instead of always falling back to the first project. Written
 *  alongside {@link UI_LAST_SESSION_SETTING_KEY} whenever a session is
 *  activated (selectSession / openTab). Fire-and-forget: a failed write just
 *  means the next launch falls back to the default first-project selection. */
export const UI_LAST_PROJECT_SETTING_KEY = "ui.lastProjectId";

/** Setting key under which the last-activated session id is persisted.
 *  Paired with {@link UI_LAST_PROJECT_SETTING_KEY}; restored by `init()` to
 *  re-open the exact thread the user was on before quitting. */
export const UI_LAST_SESSION_SETTING_KEY = "ui.lastSessionId";

/**
 * Setting key persisting the stream sidebar's project scope filter
 * ("ui.leftBarMode" = "stream") so re-entering the view — remount or relaunch
 * — restores the last selected project / group / worktree instead of
 * resetting to the unfiltered view. Encoded exactly like the component's
 * scope state: "" = 全部项目, "g:<name>" = a group, "wt:<normWorktreeKey>" =
 * a worktree checkout, otherwise a projectId. A stale id (project deleted or
 * archived since) is degraded to the unfiltered view by the sidebar's
 * validation at render time, not here.
 */
export const UI_STREAM_SCOPE_SETTING_KEY = "ui.streamScope";

/** Metadata for a single project group. */
export const ProjectGroupMetaSchema = z.object({
  color: z.string().nullable().optional(),
  order: z.number().optional(),
});
export type ProjectGroupMeta = z.infer<typeof ProjectGroupMetaSchema>;

/** Per-group metadata map (groupName → { color, order }). */
export const ProjectGroupsMetaSchema = z.record(z.string(), ProjectGroupMetaSchema);
export type ProjectGroupsMeta = z.infer<typeof ProjectGroupsMetaSchema>;

/**
 * Setting key under which the user's keyboard-shortcut overrides are persisted
 * as a JSON object: `{ commandId: Accelerator }`. Only user-changed bindings
 * are stored — commands absent from this map fall back to the compiled-in
 * `DEFAULT_SHORTCUTS` table, so a version bump that adds new defaults takes
 * effect automatically while preserving older overrides.
 *
 * The Accelerator is platform-neutral: `cmd: true` means "the primary
 * modifier" (⌘ on macOS, Ctrl elsewhere). The renderer resolves it for
 * display and matching. Mirrors the displayMode pipeline.
 */
export const UI_SHORTCUTS_SETTING_KEY = "ui.shortcuts";

/** zod schema for a single accelerator. All three modifiers are always
 *  present (default false); `key` is the normalized main key, lowercase
 *  for letters ("k"), or a named key ("f1", "space", "escape"). */
export const AcceleratorSchema = z.object({
  key: z.string(),
  cmd: z.boolean().default(false),
  shift: z.boolean().default(false),
  alt: z.boolean().default(false),
});
export type Accelerator = z.infer<typeof AcceleratorSchema>;

/** zod schema for the whole override map: commandId → Accelerator. */
export const ShortcutBindingsSchema = z.record(z.string(), AcceleratorSchema);
export type ShortcutBindings = z.infer<typeof ShortcutBindingsSchema>;

/**
 * Setting key under which the mouse-gesture settings are persisted as one
 * JSON blob: `{ enabled, trigger, overrides }`. `overrides` follows the same
 * overrides-only rule as `ui.shortcuts`: only user-rebound bindings are
 * stored (commandId → direction sequence); every other command falls back to
 * the compiled-in `DEFAULT_GESTURES` table (see lib/gestures.ts), so a version
 * bump that adds new default gestures takes effect automatically while
 * preserving older overrides.
 */
export const UI_GESTURES_SETTING_KEY = "ui.gestures";

/** One mouse-gesture direction, screen coordinates (y grows downward). */
export const GestureDirectionSchema = z.enum([
  "L", "R", "U", "D", "UL", "UR", "DL", "DR",
]);
export type GestureDirection = z.infer<typeof GestureDirectionSchema>;

/** A complete gesture stroke: 1–8 quantized direction segments (e.g. ["D","R"]). */
export const GestureSequenceSchema = z.array(GestureDirectionSchema).min(1).max(8);
export type GestureSequence = z.infer<typeof GestureSequenceSchema>;

/** Whole-blob schema for `ui.gestures`. */
export const GestureSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  trigger: z.enum(["right", "middle"]).default("right"),
  overrides: z.record(z.string(), GestureSequenceSchema).default({}),
});
export type GestureSettings = z.infer<typeof GestureSettingsSchema>;

/**
 * Setting key under which the user's preferred chat content font size (px)
 * is persisted. Value is a numeric string like "14". Validated/clamped in
 * the renderer store action (12–20 px). Mirrors the displayMode pipeline.
 */
export const UI_CHAT_FONT_SIZE_SETTING_KEY = "ui.chatFontSize";

/**
 * Setting key under which the user's preferred right-panel (files / git /
 * terminal) font size (px) is persisted. Value is a numeric string like
 * "14". Validated/clamped in the renderer store action (10–22 px). Drives
 * the `--right-panel-font-size` CSS var (and its `--rp-fs-*` derived
 * variants) plus the xterm terminal fontSize. Mirrors the chatFontSize
 * pipeline.
 */
export const UI_RIGHT_PANEL_FONT_SIZE_SETTING_KEY = "ui.rightPanelFontSize";

/**
 * Setting key under which the paste-to-card promotion threshold (character
 * count) is persisted. Value is a numeric string like "200". When a paste
 * exceeds this many characters (or spans more than the hardcoded line
 * threshold of 3), it's promoted to a content-tag chip above the composer
 * instead of being inserted inline. Validated/clamped in the renderer store
 * action (50–5000).
 */
export const UI_PASTE_TAG_THRESHOLD_CHARS_SETTING_KEY = "ui.pasteTagThresholdChars";

/**
 * Setting key under which the workflow node concurrency cap is persisted.
 * Value is a numeric string like "4".
 *
 * ## 为什么要有这个闸
 *
 * 一张图跑到某一步时,所有就绪的节点会**同时**起跑,而每个节点是一个独立的隐藏会话 +
 * 一个 CLI 子进程 + 一路模型请求。所以"图有多宽"直接等于"同时烧几路" —— 一张 20 个
 * 并列节点的图不限并发就是 20 路一起打出去,没有排队、没有确认。
 *
 * 到上限的节点**排队等,不是失败**(见 `scheduler.ts` 派发那一段)。
 *
 * 调度器**每次派发时现读**这个键(照 `AutoArchiver` 读 `AUTO_ARCHIVE_SETTING_KEY` 的
 * 做法),所以改了设置下一批就生效,不需要任何推送同步。
 *
 * 默认值在 `main/orchestration/runner.ts`(`WORKFLOW_MAX_PARALLEL_DEFAULT`);渲染端
 * 的设置界面用 {@link WORKFLOW_MAX_PARALLEL_MIN} / {@link WORKFLOW_MAX_PARALLEL_MAX}
 * 钳制。
 */
export const WORKFLOW_MAX_PARALLEL_SETTING_KEY = "workflow.maxParallel";

/**
 * 并发上限的合法范围。
 *
 * 下限是 1(串行)——**不给 0**:那是"一个节点都不许跑",而调度循环会因为"没有在飞的、
 * 也没有东西可动"直接退出,现象是"点了运行,什么都没发生"。真读到一个越界的值
 * (手改的设置文件、老版本写坏的),调度器那边退回"不限",不会卡死。
 *
 * 上限 16 是个务实的天花板:再宽就不该是一张图的事了(那更像"跑 20 个独立任务"),
 * 而且真按 20 路打出去,本机和额度两头都吃不消。
 */
export const WORKFLOW_MAX_PARALLEL_MIN = 1;
export const WORKFLOW_MAX_PARALLEL_MAX = 16;

/**
 * Setting key under which the default speech-recognition language is
 * persisted. Value is a BCP-47-ish tag like "zh-CN" or "en-US" (used to pick
 * the ASR model / decoder language). Hydrated into sessionStore.voiceLang.
 */
export const UI_VOICE_LANG_SETTING_KEY = "ui.voiceLang";

/**
 * Setting key under which the chosen voice engine is persisted: "zipformer"
 * (streaming Chinese Zipformer — live interim results) or "parakeet" (offline
 * NVIDIA Parakeet — higher accuracy, no interim). Falls back to "zipformer"
 * when the parakeet engine/model is unavailable. Hydrated into
 * sessionStore.voiceEngine.
 */
export const UI_VOICE_ENGINE_SETTING_KEY = "ui.voiceEngine";

/** zod schema + TS union for the voice ASR engine. */
export const VoiceEngineSchema = z.enum(["zipformer", "parakeet"]);
export type VoiceEngine = z.infer<typeof VoiceEngineSchema>;

/**
 * Setting key under which the user's mic permission grant is cached
 * ("granted" | "denied" | ""). The main window's permission handler lets the
 * renderer request the microphone; this caches the outcome so the composing
 * mic button can show a clear "grant access" state instead of silently
 * failing. Managed by the renderer voice store action.
 */
export const UI_VOICE_MIC_PERMISSION_SETTING_KEY = "ui.voiceMicPermission";

/**
 * Setting key under which the active voice model id is persisted (one of the
 * ids in {@link VOICE_MODEL_CATALOG}). Choosing a model in Settings →
 * 语音输入 → 下载模型 writes this, and the engine resolves the model's files
 * under the download dir at `voice.start`. Empty = no model selected.
 */
export const UI_VOICE_MODEL_SETTING_KEY = "ui.voiceModel";

/**
 * Setting key under which the list of downloaded voice models is persisted as
 * a JSON array of the model ids present on disk (from the catalog). Kept in
 * sync by main after each download completes/removes; the settings panel reads
 * it to render the "已下载" list.
 */
export const UI_VOICE_DOWNLOADED_MODELS_SETTING_KEY = "ui.voiceDownloadedModels";

/**
 * Setting key under the local directory that downloaded voice model files are
 * kept in (absolute path, or empty string for the default `userData/models/voice`).
 * Each catalog model lives in `<dir>/<model-id>/`. The engine validates the files
 * exist at `voice.start` time and surfaces a clear "模型未下载" error.
 */
export const UI_VOICE_MODEL_DIR_SETTING_KEY = "ui.voiceModelDir";

/** Get the current effective model root (the user-customized path when set,
 *  otherwise the default `userData/models/voice`). Returned to the settings
 *  panel so it can render the current value. */
export const GetVoiceModelDirSchema = z.object({});
export type GetVoiceModelDirInput = z.infer<typeof GetVoiceModelDirSchema>;
export const GetVoiceModelDirResultSchema = z.object({
  /** The active root (never empty — resolves the default). */
  modelDir: z.string(),
  /** True when the user has customized the path. */
  isCustom: z.boolean(),
});
export type GetVoiceModelDirResult = z.infer<typeof GetVoiceModelDirResultSchema>;

/** Change the model root directory. The new path must be an absolute, writable
 *  directory; the call validates and rejects bad input. An empty string resets
 *  to the default `userData/models/voice` root. The new root is then scanned
 *  for already-downloaded catalog models so the renderer can update the list
 *  in a single round-trip. */
export const SetVoiceModelDirSchema = z.object({
  /** Absolute path, or "" to reset to the default. */
  modelDir: z.string(),
});
export type SetVoiceModelDirInput = z.infer<typeof SetVoiceModelDirSchema>;
export const SetVoiceModelDirResultSchema = z.object({
  modelDir: z.string(),
  isCustom: z.boolean(),
  /** Catalog models found under the new root. */
  downloaded: z.array(z.string()),
});
export type SetVoiceModelDirResult = z.infer<typeof SetVoiceModelDirResultSchema>;

/**
 * Setting key under which the draggable panel widths are persisted as a JSON
 * object: `{ left, right, bottomTerminal, editor }`.
 *  - `left` / `right`: side-bar widths in px (clamped 180–500 / 240–640).
 *  - `bottomTerminal`: bottom terminal bar height in px (clamped 80–600).
 *  - `editor`: editor-column share of the center pane as a percentage 0–100
 *    (clamped 20–80); the chat column gets the remainder.
 * Hydrated + clamped in sessionStore.init(); written (debounced) on drag end.
 */
export const UI_PANE_WIDTHS_SETTING_KEY = "ui.paneWidths";

/**
 * Setting key under which the user's custom user-message background color
 * is persisted. Value is a space-separated "R G B" triplet (e.g.
 * "124 58 237") so it composes with Tailwind's <alpha-value> placeholder.
 * An empty string / null means "use the theme default" (the --user-bubble
 * CSS var defined in styles.css per :root/.dark).
 */
export const UI_USER_MSG_COLOR_SETTING_KEY = "ui.userMessageColor";

/**
 * Setting key under which the user's custom brand/accent color is persisted.
 * Value is a space-separated "R G B" triplet (e.g. "5 150 105") so it
 * composes with Tailwind's <alpha-value> placeholder via the `accent` color
 * token. An empty string / null means "use the theme default" (the --accent
 * CSS var defined in styles.css per :root/.dark — emerald-600 in light,
 * emerald-500 in dark). Unlike --user-bubble (chat-only), --accent is the
 * global emphasis color: buttons, links, selected states, focus rings, and
 * the accent highlights in the three prompt cards all follow it.
 */
export const UI_ACCENT_COLOR_SETTING_KEY = "ui.accentColor";

/**
 * Setting key under which the user's per-mode editor color-scheme choice is
 * persisted. Value is a JSON object `{ "dark": "<id>", "light": "<id>" }` with
 * one Monaco scheme id per app theme — the ids name themes registered by the
 * renderer's lib/editorThemes.ts (mcode-dark, mcode-one-dark, …), so the ids
 * are only meaningful renderer-side; the store validates them on hydrate and
 * falls back to the defaults on any unknown value. Missing/empty = defaults
 * (the "Mcode" pair: chrome mirroring the app tokens, stock token palettes).
 */
export const UI_EDITOR_THEME_SETTING_KEY = "ui.editorTheme";

/**
 * Setting key under which the active right-panel tab is persisted.
 * Value is one of "files" | "git" | "browser" | "turns". The right panel reads it
 * at boot and restores the last-used tab. "browser" re-enables the browser as an
 * embedded sidebar panel (mobile-first); on hydrate the store still falls back
 * to "files" so the browser doesn't auto-open at startup — the "browser" value
 * is only reached via an explicit user toggle during the session.
 * (Terminal used to live here as a tab but moved to the bottom bar; a persisted
 * "terminal" value is rejected by the schema and falls back to "files".)
 */
export const UI_RIGHT_PANEL_TAB_SETTING_KEY = "ui.rightPanelTab";

/** zod schema + TS union for the right-panel tab preference. "sidechat" (the
 *  side-chat Q&A tab) is session-only like "browser": hydrate ignores a
 *  persisted value so the ask tab never auto-opens at startup. "library" 同理
 *  —— 文献库是被左栏点击唤起的,不该在启动时自己占住右栏。 */
export const RightPanelTabSchema = z.enum(["files", "git", "browser", "turns", "sidechat", "library", "templates"]);
export type RightPanelTab = z.infer<typeof RightPanelTabSchema>;

/**
 * Setting key under which the IDE file editor's open-file list is persisted.
 * Value is a JSON-encoded `string[]` of absolute file paths (the tabs open in
 * the Monaco editor area). Empty/unset = no files open. Restored at boot so
 * the editor state survives restarts. Paths that no longer exist on disk are
 * dropped silently on first open.
 */
export const UI_IDE_OPEN_FILES_SETTING_KEY = "ui.ideOpenFiles";

/**
 * Setting key under which the IDE file editor's active file is persisted.
 * Value is an absolute file path, or empty/null for "none". Must be a member
 * of the open-files list to take effect.
 */
export const UI_IDE_ACTIVE_FILE_SETTING_KEY = "ui.ideActiveFile";

/**
 * Setting key under which the IDE file-tree's expanded directories are
 * persisted. Value is a JSON-encoded `string[]` of absolute directory paths.
 * Restored at boot so the tree re-opens to where the user left it.
 */
export const UI_IDE_EXPANDED_DIRS_SETTING_KEY = "ui.ideExpandedDirs";

/**
 * Setting key under which the IDE editor's open-mode preference is persisted.
 *  - "tabs"    (default): each opened file accumulates as a tab in the editor
 *               area; the user can have several files open and switch between
 *               them.
 *  - "replace": opening a file replaces whatever was previously open, so at
 *               most one file is ever shown (simpler, lower-clutter).
 * Persisted as one of the two literals; restored at boot.
 */
export const UI_IDE_EDITOR_MODE_SETTING_KEY = "ui.ideEditorMode";

/**
 * Setting key under which the composer's persisted provider/model choice is
 * stored — the "next session" defaults the user picked (SDK + model + custom
 * config). Value is a JSON-encoded `{ providerId, model, customModelId }`
 * object; hydrated at boot so the last pick is pre-selected, and validated
 * against the current model lists (a deleted model falls back to auto).
 */
export const UI_COMPOSER_MODEL_SETTING_KEY = "ui.composerModel";

/**
 * **文献检索的固定条件** —— 输入框下方的筛选条上选的,四组。
 *
 * ## 为什么是设置而不是让 AI 问
 *
 * 用户的原话:「不止是 2-4 个问题,需要比较详细的,包括时间范围,影响因子,论文层次
 * 等等这些,**但是一般这些都是固定的习惯**」。既然是固定习惯,就不该每轮都问一遍 ——
 * 问一次、存下来、每轮直接用。
 *
 * 所以分成两层:这几项(不变的习惯)由**界面**收集,放在输入框下方一眼看得见的地方;
 * 每轮真正要问的只剩**研究方向**那一件。主进程把它们读出来注入提示词,AI 照着执行。
 *
 * 取值一律是短字符串码,不是数字 —— 界面换了选项之后旧值仍然可读(退化成"不限"),
 * 不会因为解析失败把整条条件打没。
 */
export const SEARCH_YEAR_SPAN_SETTING_KEY = "search.yearSpan";
export const SEARCH_TIER_SETTING_KEY = "search.tier";
export const SEARCH_MIN_IF_SETTING_KEY = "search.minImpactFactor";
export const SEARCH_LIMIT_SETTING_KEY = "search.perSourceLimit";

/**
 * 期刊数据(jcr.db)的路径。
 *
 * 这是一个 **22MB 的离线 SQLite**(JCR 影响因子/分区 + 中科院分区 + CCF + 预警名单),
 * 由用户自己的 `模板库/期刊数据/fetch.py` 每年更新。**不随应用发布** —— 它是有版权的
 * 商业数据,也是用户自己维护的东西。
 *
 * 解析顺序(见 `main/library/journalRank.ts`):本设置 → `<数据根>/workflows/jcr.db`。
 * 两处都没有就**降级**:期刊层次/影响因子那两条筛选条件不生效,而且会**如实告诉用户
 * 不生效** —— 宁可说"我查不了",也不能让模型凭印象编一个影响因子出来。
 */
export const SEARCH_JOURNAL_DB_SETTING_KEY = "search.journalRankDb";

/** 时间跨度码 → 中文说法(注入提示词时用)。 */
export const SEARCH_YEAR_SPAN_LABELS: Record<string, string> = {
  any: "不限",
  "3": "近三年",
  "5": "近五年",
  "10": "近十年",
};

/** 期刊层次码 → 中文说法。与 `journal_rank.py` 的 T1/T2 分档对齐。 */
export const SEARCH_TIER_LABELS: Record<string, string> = {
  any: "不限",
  t1: "只要 T1(Q1 或中科院 1 区,或 Top)",
  t1t2: "T1 或 T2(Q1/Q2,或中科院 1/2 区)",
};

/** 影响因子下限码 → 中文说法。 */
export const SEARCH_MIN_IF_LABELS: Record<string, string> = {
  any: "不限",
  "3": "≥ 3",
  "5": "≥ 5",
  "10": "≥ 10",
};

/**
 * Setting key under which the custom-model id used for git-commit-message
 * generation is persisted. Value is a config id from CustomModelStore, or
 * empty/null for "use built-in model". Shared between main (the generator
 * handler resolves the config) and renderer (the settings panel reads/writes).
 */
export const UI_COMMIT_GEN_MODEL_SETTING_KEY = "ui.commitGenModel";

/**
 * Setting key under which the prompt template for commit-message generation
 * is persisted. Value is a string; the staged diff is appended after it.
 * Empty/unset → use a built-in default prompt.
 */
export const UI_COMMIT_GEN_PROMPT_SETTING_KEY = "ui.commitGenPrompt";

/**
 * Setting key under which the custom-model id used for AI git-conflict
 * resolution is persisted. Same shape as UI_COMMIT_GEN_MODEL_SETTING_KEY
 * (`"configId:roleKey"`); null/empty = use the built-in model. Shared
 * between main (the resolve handler resolves the config) and renderer
 * (the settings panel reads/writes).
 */
export const UI_CONFLICT_RESOLVE_MODEL_SETTING_KEY = "ui.conflictResolveModel";

/**
 * Setting key under which the auto thread-title generation toggle is
 * persisted. Value is `"on"` (enabled) or `"off"` (disabled, default).
 * When enabled, the main process fires a one-shot LLM call on the first
 * user message of a new session to generate a short Chinese title, then
 * overwrites the placeholder title. Shared between main (the title-gen
 * routine reads it) and renderer (the settings panel reads/writes).
 */
export const UI_TITLE_GEN_ENABLED_SETTING_KEY = "ui.titleGenEnabled";

/** zod schema + TS union for the title-gen enabled preference. */
export const TitleGenEnabledSchema = z.enum(["on", "off"]);
export type TitleGenEnabled = z.infer<typeof TitleGenEnabledSchema>;

/**
 * Setting key under which the custom-model id used for auto thread-title
 * generation is persisted. Same shape as UI_COMMIT_GEN_MODEL_SETTING_KEY
 * (`"configId:roleKey"`); null/empty = use the built-in model. Shared
 * between main (the title-gen routine resolves the config) and renderer
 * (the settings panel reads/writes).
 */
export const UI_TITLE_GEN_MODEL_SETTING_KEY = "ui.titleGenModel";

/**
 * Setting key for per-repo collapsed state in the Git panel. Value is a
 * JSON-encoded `Record<string, boolean>` mapping repo paths to collapsed
 * state. Persisted so the collapsed/expanded state survives restarts.
 */
export const UI_GIT_COLLAPSED_REPOS_SETTING_KEY = "ui.gitCollapsedRepos";

/**
 * Setting key under which the user's notification preferences are persisted as
 * a JSON-encoded {@link NotificationPrefs} object. Controls whether OS-level
 * notifications fire (window unfocused) and which event categories trigger
 * them. Hydrated by the main-process NotificationManager at boot.
 */
export const NOTIFICATION_PREFS_SETTING_KEY = "notifications.prefs";

/** User-controllable notification preferences. Persisted under
 *  {@link NOTIFICATION_PREFS_SETTING_KEY}. */
export interface NotificationPrefs {
  /** Master switch for OS-level notifications. When false, no OS
   *  notifications are shown (in-app badges + toasts still work). Default
   *  true. */
  osEnabled: boolean;
  /** Notify on turn completion (non-active session). Default true. */
  turnComplete: boolean;
  /** Notify on errors (non-active session). Default true. */
  errors: boolean;
  /** Notify on blocking events (approval request / question / plan approval).
   *  Default true - these are the highest-value notifications since the agent
   *  is stalled until the user responds. */
  blocking: boolean;
  /** Notify when a backgrounded subagent finishes. Default true. */
  backgroundTasks: boolean;
}

/** Default notification prefs: everything on. The user can dial back via the
 *  settings panel. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  osEnabled: true,
  turnComplete: true,
  errors: true,
  blocking: true,
  backgroundTasks: true,
};

/** zod schema for the notification prefs JSON blob. */
export const NotificationPrefsSchema = z.object({
  osEnabled: z.boolean().default(true),
  turnComplete: z.boolean().default(true),
  errors: z.boolean().default(true),
  blocking: z.boolean().default(true),
  backgroundTasks: z.boolean().default(true),
});

/**
 * Setting key under which the user's saved terminal quick-commands are
 * persisted. Value is a JSON-encoded `CustomCommand[]` (name + command + id).
 *
 * @deprecated Replaced by {@link UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY}.
 * Commands are now scoped per-project. This key is no longer read or written
 * by the app; any persisted value is ignored. Kept only to avoid breaking
 * imports - to be removed in a future cleanup.
 */
export const UI_CUSTOM_COMMANDS_SETTING_KEY = "ui.customCommands";

/**
 * Setting key under which per-project terminal quick-commands are persisted.
 * Value is a JSON-encoded `Record<string, CustomCommand[]>` keyed by
 * `projectId`. Mirrors the per-project IDE-state persistence pattern
 * (ui.ideOpenFiles etc.): one setting row holds all projects' command lists,
 * and the renderer re-hydrates the whole map at boot.
 */
export const UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY = "ui.customCommandsByProject";

/** One user-saved terminal quick-command. `id` is a stable client-side id
 *  (used as the React key and for edit/delete targeting); `name` is the menu
 *  label; `command` is the shell text written to the PTY (run verbatim). */
export interface CustomCommand {
  id: string;
  name: string;
  command: string;
}

/** zod schema + TS union for the IDE editor open-mode preference. */
export const IdeEditorModeSchema = z.enum(["tabs", "replace"]);
export type IdeEditorMode = z.infer<typeof IdeEditorModeSchema>;

/**
 * Setting key under which the user's preferred way of opening a file diff from
 * the Git panel is persisted.
 *  - "center" (default): the diff opens in the center-area Monaco editor (the
 *               existing behavior - replaces/accumulates as editor tabs).
 *  - "dialog": the diff opens in a floating modal dialog that supports multiple
 *               diff tabs at once. Closing the dialog keeps the tabs; a button
 *               in the Git panel toolbar re-opens it.
 * Persisted as one of the two literals; restored at boot.
 */
export const UI_GIT_DIFF_OPEN_MODE_SETTING_KEY = "ui.gitDiffOpenMode";

/** zod schema + TS union for the git-diff open-mode preference. */
export const GitDiffOpenModeSchema = z.enum(["center", "dialog"]);
export type GitDiffOpenMode = z.infer<typeof GitDiffOpenModeSchema>;

/** Per-file view mode for the center file editor.
 *  - "edit": editable Monaco instance
 *  - "diff": read-only Monaco DiffEditor (vs a before-snapshot)
 *  - "preview": rendered Markdown preview (read-only)
 *  Markdown files default to "preview" on first open; the user can toggle back
 *  to "edit". Pure renderer state - not validated over IPC. */
export type FileViewMode = "edit" | "diff" | "preview";

/**
 * Permission modes are now open strings (see `PermissionMode` in runtime.ts).
 * This constant is kept for backward compatibility and for the claude-sdk
 * provider's own validation. The IPC schemas below use `z.string()` so any
 * provider can declare its own mode set via `ProviderCapabilities`.
 */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
] as const;
/** Legacy schema - still validates claude's 6 modes. Used only where we need
 *  to constrain to claude's set (e.g. the claude-sdk provider internals). */
export const PermissionModeSchema = z.enum(PERMISSION_MODES);

/* ──────────────────────────  Renderer → Main (RPC)  ────────────────────────── */

export const StartSessionSchema = z.object({
  projectId: z.string(),
  title: z.string().optional(),
  /** Provider id — which AI backend to use. Defaults to "claude-sdk". */
  providerId: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().default("default"),
  permissionMode: z.string().default("default"),
  /** Id of a custom-model config to bind to this session (omit/null = built-in). */
  customModelId: z.string().nullable().optional(),
  /** Session role: "chat" (default, normal left-bar session) or "side"
   *  (side-chat Q&A session owned by the right-panel ask tab). Side sessions
   *  always create a fresh row — the createOrReuse fresh-row logic doesn't
   *  apply to them. */
  kind: z.enum(["chat", "side"]).default("chat"),
  /** For kind="side": the main session this Q&A thread belongs to. Enables
   *  traceability (one main session → many side chats). Ignored for chat. */
  parentSessionId: z.string().optional(),
  /** Working-environment intent for the new session. "worktree" records that
   *  the session's turns should run in an isolated checkout — the worktree
   *  itself is created when the FIRST turn is sent (intent-first,
   *  materialize-late), so unused sessions never leave empty worktrees
   *  behind. Only meaningful for kind="chat". */
  envMode: z.enum(["local", "worktree"]).optional(),
  /** Worktree FORM for envMode="worktree": "branch" materializes on a
   *  generated `mcode/*` branch (durable named commits — feature work),
   *  "detached" (default) keeps the classic detached checkout (experimental
   *  verification). Ignored for local sessions. */
  wtStyle: z.enum(["detached", "branch"]).optional(),
  /** BIND to an existing managed worktree directory instead of creating a
   *  fresh one: the new session shares the checkout (and its dependencies)
   *  of an already-materialized worktree session — "continue working in the
   *  same directory with a fresh thread". Must name a directory some OTHER
   *  session already references (main validates); ignored otherwise. Only
   *  meaningful together with envMode="worktree". */
  worktreePath: z.string().optional(),
});
export type StartSessionInput = z.infer<typeof StartSessionSchema>;

/** List a main session's side chats (kind="side", parent = the given id),
 *  newest first — hydrates the right-panel ask tab's list view. */
export const ListSideChatsSchema = z.object({ parentSessionId: z.string() });
export type ListSideChatsInput = z.infer<typeof ListSideChatsSchema>;

/** One user-attached image sent inline with the turn (base64, no data: prefix).
 *  Media types match the Anthropic image-block allowlist (jpeg/png/gif/webp) —
 *  the Pi provider accepts the same values. The 6M-char cap keeps the decoded
 *  bytes under Anthropic's ~5MB-per-image API limit. */
export const SendTurnImageSchema = z.object({
  /** Base64-encoded image bytes (no data: prefix). */
  data: z.string().min(1).max(6_000_000),
  mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
});
export type SendTurnImage = z.infer<typeof SendTurnImageSchema>;

/** 会话 / 这一轮选的工作流 id。
 *
 *  **开放字符串,不是枚举** —— 内置的那六个(`BUILTIN_WORKFLOW_IDS`)只是一个子集,
 *  用户还能自建(`wf_` 前缀)。校验只保证"非空";**认不认识这个 id 由 host 决定**:
 *  不认识就当作"没有流程",而不是报错。理由与节点类型同源 —— 一份别人分享来的工作流
 *  引用了他没装的类型时,不该让整个会话打不开。 */
export const WorkflowIdSchema = z.string().min(1);

/** 取工作流 id,兼容旧字段名 `composerMode`。
 *
 *  **为什么要留这个别名**:手机端可能还开着改版前加载的页面,而 zod 对**没声明的键
 *  是静默丢掉**的 —— 那会表现成"模式突然不生效了",不报错、也不易查。留着它,旧字段
 *  只是过时,不会失灵。 */
export function workflowIdFromInput(input: {
  workflowId?: string;
  composerMode?: string;
}): string | undefined {
  return input.workflowId ?? input.composerMode;
}

export const SendTurnSchema = z.object({
  sessionId: z.string(),
  prompt: z.string(),
  attachments: z.array(z.string()).optional(),
  /** User-attached images inlined into the provider request as base64 content
   *  blocks (NOT paths — the model server can't read the local filesystem).
   *  Sent alongside `prompt`; an image-only turn passes an empty prompt. */
  images: z.array(SendTurnImageSchema).max(20).optional(),
  /** Override session-scoped settings for this turn (reflects current UI state). */
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  /** 这一轮用的工作流。**刻意不折进 `prompt`** —— 会话标题是从 `prompt` 派生的,
   *  折进去会让标题变成流程正文。见 main/orchestration/prompt.ts。 */
  workflowId: WorkflowIdSchema.optional(),
  /** 旧字段名,**接受一个版本**。手机端可能还开着改版前加载的页面,而 zod 对没声明
   *  的键是**静默丢掉**的 —— 那会表现成"模式突然不生效了",不报错、也不易查。
   *  handler 里取 `input.workflowId ?? input.composerMode`。 */
  composerMode: WorkflowIdSchema.optional(),
  /** Override the session's bound custom model for this turn. null = clear
   *  (use built-in credential discovery); a string = bind to that config. */
  customModelId: z.string().nullable().optional(),
  /** Per-turn provider override. Normally the session's providerId is
   *  fixed at creation, but the UI can pass the active providerId here so
   *  the in-memory session is patched before RuntimeManager resolves the
   *  backend. Used as a per-turn override (NOT persisted — the session
   *  row's providerId stays as it was). */
  providerId: z.string().optional(),
  /** Skill names picked via composer skill pills this turn (no leading "/").
   *  Forwarded to the provider as the SDK `skills` allowlist so the model's
   *  Skill tool can reach them (stream-json input doesn't parse /name). */
  skills: z.array(z.string()).optional(),
  /** The sender's local user message (id / createdAt / display blocks).
   *  When present, the host echoes it to every client as a `user.message`
   *  RuntimeEvent so the prompt's bubble appears on the OTHER devices in
   *  real time (the sender dedupes by id — it already appended locally).
   *  Optional so older/foreign callers keep working (no echo, no dupes). */
  userMessage: z
    .object({
      id: z.string().min(1),
      createdAt: z.number(),
      blocks: z.array(z.unknown()),
      /** Set only when this send is an EDIT of an earlier user message
       *  (editAndResendMessage). Carries the id of the message being
       *  replaced so every OTHER client can truncate its own store at that
       *  message before appending the re-sent bubble — keeping their in-memory
       *  tail (and their turn.done persistence of it) consistent with the
       *  originator's truncation. Absent for a normal first send. */
      editedMessageId: z.string().optional(),
    })
    .optional(),
});
export type SendTurnInput = z.infer<typeof SendTurnSchema>;

export const InterruptSchema = z.object({ sessionId: z.string() });
export type InterruptInput = z.infer<typeof InterruptSchema>;

/**
 * 往**正在跑的那一轮**里塞一句话(生成过程中插话)。
 *
 * 只收文本:`max(2000)` 是一个**防手滑**的上界(这条路没有附件、没有图片,也没有
 * "太长就分成几条"的机制)。真要写长文,那本来就该是新开一轮,不是插话。
 */
export const InjectSchema = z.object({
  sessionId: z.string(),
  text: z.string().min(1).max(2000),
});
export type InjectInput = z.infer<typeof InjectSchema>;

export const ApproveSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  granted: z.boolean(),
  always: z.boolean().optional(),
});
export type ApproveInput = z.infer<typeof ApproveSchema>;

/* Answer to an AskUserQuestion. `requestId` matches the question.ask event.
 * Each value is one question's answer: option label (string), labels
 * (string[] for multi-select), or null (skipped). See UserInputAnswers.
 * `dismissed: true` means the user closed the question card without
 * answering — main resolves the provider's pending Deferred as dismissed so
 * the model's turn continues instead of blocking forever. */
export const RespondQuestionSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
  dismissed: z.boolean().optional(),
});
export type RespondQuestionInput = {
  sessionId: string;
  requestId: string;
  answers: UserInputAnswers;
  dismissed?: boolean;
};

/* User's decision on a pending ExitPlanMode plan-approval request. `requestId`
 * matches the plan.approval_request event. The decision fields (approved /
 * editedPlan / reason) mirror PlanApprovalDecision in provider.ts; we spell
 * them out here so zod's inferred type matches without a circular import. */
export const RespondPlanApprovalSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  approved: z.boolean(),
  editedPlan: z.string().optional(),
  reason: z.string().optional(),
  /* User's plan-adjustment feedback from the approval sheet. Attached to the
   * decision: on approve it's delivered to the model alongside the approval
   * (execution should incorporate it); on reject it doubles as the reason. */
  feedback: z.string().optional(),
});
export type RespondPlanApprovalInput = z.infer<typeof RespondPlanApprovalSchema>;

/* Rewind a turn: restore the given files to their `before` state. The
 * renderer passes the explicit TurnFileEntry[] (the card's own frozen
 * list), so this works for BOTH the latest turn (entries from the live
 * snapshot) and any historical turn (entries persisted on the message),
 * AND for a session reopened after restart (entries rehydrated from the
 * DB) — none of those cases depend on the in-memory FileSnapshot being
 * present. Main resolves each path against the session's cwd and refuses
 * any path that escapes it (path-traversal guard).
 *
 * `targetFiles`: the requested path set, forwarded onto the
 * `turn.rewound` event so the renderer can locate the exact card to
 * mark `rewound: true`. Always present — the card is never removed,
 * only marked, for both latest-turn and historical rewinds. */
export const RewindTurnSchema = z.object({
  sessionId: z.string(),
  files: z.array(
    z.object({
      filePath: z.string(),
      kind: z.enum(["modified", "created"]),
      adds: z.number(),
      dels: z.number(),
      before: z.string(),
    }),
  ),
  targetFiles: z.array(z.string()),
});
export type RewindTurnInput = z.infer<typeof RewindTurnSchema>;

/* Per-session settings update (model / effort / permissionMode / customModelId).
 * Only the fields present in the payload are persisted; omitted fields are
 * left as-is. */
export const UpdateSessionSettingsSchema = z.object({
  sessionId: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  workflowId: WorkflowIdSchema.optional(),
  /** 旧字段名,接受一个版本 —— 理由见上面 SendTurnSchema 那段。 */
  composerMode: WorkflowIdSchema.optional(),
  customModelId: z.string().nullable().optional(),
  /** Provider id (e.g. "claude-sdk"). Only honored while the session has no
   *  messages yet — once a turn has run the provider is fixed at creation, so
   *  the main handler rejects this field for non-empty sessions. */
  providerId: z.string().optional(),
  /** Working-environment intent flip (composer chip). Only meaningful while
   *  the session is un-materialized (no worktreePath yet) — the main-side
   *  updateSettings writes it, materialization later locks the environment. */
  envMode: z.enum(["local", "worktree"]).optional(),
  /** Worktree FORM flip (composer chip) — same un-materialized-only contract
   *  as envMode. null clears the intent back to the detached default (used
   *  when flipping the session to local so no stale intent lingers). */
  wtStyle: z.enum(["detached", "branch"]).nullable().optional(),
  /** Directory re-aim (new-session panel's directory switcher): move a FRESH
   *  local session to another project. The main handler honors it only while
   *  the session has no messages and no materialized worktree, and only onto
   *  an existing non-archived project — otherwise the whole call rejects and
   *  nothing changes. */
  projectId: z.string().optional(),
});
export type UpdateSessionSettingsInput = z.infer<typeof UpdateSessionSettingsSchema>;

export const CreateProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

/* Project / session lifecycle: archive (soft-delete, restorable) and delete
 * (hard, cascading — projects take their sessions+messages with them via the
 * DB's ON DELETE CASCADE). */
export const DeleteProjectSchema = z.object({ id: z.string() });
export const ArchiveProjectSchema = z.object({ id: z.string(), archived: z.boolean() });
/* Assign a project to a group (left-bar "grouped" view). `group` is null to
 * remove the project from any group. Group names are free-form strings; the
 * store trims and clamps the length before sending. */
export const SetProjectGroupSchema = z.object({
  id: z.string(),
  group: z.string().max(50).nullable(),
});
export type SetProjectGroupInput = z.infer<typeof SetProjectGroupSchema>;
/* Persist the user's drag-to-reorder. The renderer sends the full ordered
 * list of project ids as they should appear; the main process writes
 * sort_order = index for each row. Sending the whole list (rather than a
 * from/to pair) keeps the operation atomic and avoids drift when rows were
 * deleted (leaving gaps in sort_order). */
export const ReorderProjectsSchema = z.object({
  orderedIds: z.array(z.string()),
});
export type ReorderProjectsInput = z.infer<typeof ReorderProjectsSchema>;
/* Pin/unpin a project. Pinned projects float above the left bar's project
 * tree (and out of their group) in a dedicated section, most recent pin
 * first — the project-level counterpart of PinSessionSchema. */
export const PinProjectSchema = z.object({ id: z.string(), pinned: z.boolean() });
export type PinProjectInput = z.infer<typeof PinProjectSchema>;
/* Rename a project (user-edited display name). Display-only: the project's
 * path — the functional key used for cwd / path guards — is never touched.
 * Mirrors RenameSessionSchema's trim-and-clamp contract. */
export const RenameProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
});
export type RenameProjectInput = z.infer<typeof RenameProjectSchema>;
export const DeleteSessionSchema = z.object({ id: z.string() });
export const ArchiveSessionSchema = z.object({ id: z.string(), archived: z.boolean() });

/* Pin/unpin a session (project-scoped: pinned sessions sort to the top of
 * their project's list, most recent pin first). */
export const PinSessionSchema = z.object({ id: z.string(), pinned: z.boolean() });
export type PinSessionInput = z.infer<typeof PinSessionSchema>;

/* Replace a session's full bookmark list. The renderer owns the whole list
 * (single-digit cardinality) and sends the complete array on every add /
 * remove — an incremental protocol would be overkill. Excerpt is clamped in
 * the renderer before sending; the schema still bounds it to keep rows
 * defensive against hand-crafted payloads. */
export const SessionBookmarkSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().min(1),
  excerpt: z.string().max(400),
  // Optional (not just nullable) so bookmark lists persisted before the
  // rename feature existed parse unchanged.
  title: z.string().max(80).nullable().optional(),
  role: z.enum(["user", "assistant"]),
  createdAt: z.number().int().nonnegative(),
});
export const UpdateBookmarksSchema = z.object({
  id: z.string(),
  bookmarks: z.array(SessionBookmarkSchema),
});
export type UpdateBookmarksInput = z.infer<typeof UpdateBookmarksSchema>;

/* Rename a session (user-edited title). Title is clamped to a sane length;
 * empty/whitespace-only is rejected by the min(1) on the trimmed value (the
 * store trims before sending). */
export const RenameSessionSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
});
export type RenameSessionInput = z.infer<typeof RenameSessionSchema>;

/* Open a path in the OS file manager. The main handler refuses any path that
 * isn't an exact match for a known project root, so the renderer can't ask it
 * to open arbitrary locations. */
export const OpenPathSchema = z.object({ path: z.string() });
export type OpenPathInput = z.infer<typeof OpenPathSchema>;

/* Reveal a file or directory in the OS file manager (Finder / Explorer),
 * selecting it. Unlike `shell.openPath`, this accepts any path that resolves
 * inside a known project root (not just the root itself) - the main handler
 * enforces the same project-root containment check as the file handlers. Used
 * by the file-tree context menu's "Reveal in Explorer" action. */
export const ShowItemInFolderSchema = z.object({ path: z.string() });
export type ShowItemInFolderInput = z.infer<typeof ShowItemInFolderSchema>;

/** Open a file with the OS's default associated application (e.g. .docx in
 *  Word, .pdf in Preview). Accepts any path that resolves inside a known,
 *  non-archived project root - the same containment rule as
 *  `shell.showItemInFolder`. Used by the editor's "unsupported file" pane to
 *  let the user open binary files the editor can't preview. */
export const OpenFileSchema = z.object({ path: z.string() });
export type OpenFileInput = z.infer<typeof OpenFileSchema>;

/** List a project's sessions with optional pagination + archived filter.
 *  The left-bar tree loads the first `limit` (default 5) non-archived LOCAL
 *  threads and appends the next page on "load more"; the archived bin requests
 *  `archived: true` (unpaginated). `hasMore` / `total` let the UI decide
 *  whether to render the "load more" affordance. `worktree` narrows the query
 *  by worktree binding: "exclude" = local threads only (the tree's paginated
 *  list — worktree threads are fetched separately so they never eat into the
 *  5-row first page), "only" = worktree-bound threads only (the tree's
 *  worktree groups, fetched in full — a directory holds few threads). */
export const ProjectSessionsSchema = z.object({
  projectId: z.string(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  archived: z.boolean().optional(),
  worktree: z.enum(["exclude", "only"]).optional(),
});
export type ProjectSessionsInput = z.infer<typeof ProjectSessionsSchema>;

/** Cross-project aggregate of non-archived chat sessions, newest-first —
 *  the stream sidebar's flat "全部项目" list. Same paging contract as
 *  project.sessions (offset + hasMore/total), just without the projectId
 *  filter — unless an optional scope narrows it: the sidebar's scope switch
 *  must also re-scope `hasMore` / `total`, or the bottom "显示更多" button
 *  keeps counting the unfiltered aggregate after the user switches
 *  projects. */
export const SessionListAllSchema = z.object({
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  /** Project scope: only rows whose project_id is in this list. A plain
   *  project scope sends one id, a group scope its member ids. Absent =
   *  all projects. */
  projectIds: z.array(z.string()).optional(),
  /** Worktree-checkout scope: only sessions bound to that isolated
   *  checkout, as a normalized path key (renderer's normWorktreeKey form —
   *  main compares with its normPathKey twin, since stored paths and
   *  porcelain output differ in separators/casing surface). */
  worktreeKey: z.string().optional(),
});
export type SessionListAllInput = z.infer<typeof SessionListAllSchema>;

/** Cross-project session search by title substring. The unified Ctrl+K search
 *  palette uses this to list threads across the whole workspace (not just the
 *  active project's loaded page). Matches non-archived sessions only. */
export const SessionSearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
});
export type SessionSearchInput = z.infer<typeof SessionSearchSchema>;

/** One cross-session bookmark hit for the Ctrl+K palette. Carries the owning
 *  session's identity so the palette can open it, plus the bookmark itself
 *  (excerpt = the selected text at add time, title = the user rename). */
export interface BookmarkSearchResult {
  bookmark: SessionBookmark;
  sessionId: string;
  sessionTitle: string;
  projectId: string;
}

/** Cross-session bookmark search (title + excerpt substring). Scans the
 *  bookmarks JSON column of non-archived chat sessions — bookmark data is
 *  small (single-digit entries per session), so an in-memory filter over the
 *  non-null rows is fine at workspace scale. */
export const BookmarkSearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().positive().optional(),
});
export type BookmarkSearchInput = z.infer<typeof BookmarkSearchSchema>;

/* A persisted message: content is opaque JSON (text/thinking/tool_use blocks).
 * P2's renderer serializes its ChatMessage.blocks array here.
 * We use z.custom<unknown>() for content: zod treats z.unknown()/z.any() as
 * optional in its inferred type, which would mismatch MessageRecord.content
 * (required `unknown`). z.custom() preserves the exact type we give it. */
export const MessageRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.custom<unknown>((v) => v !== undefined, "content is required"),
  createdAt: z.number(),
});

export const SessionMessagesSchema = z.object({
  sessionId: z.string(),
  /** Page size. Omit for the legacy unpaginated path (all rows). */
  limit: z.number().int().positive().optional(),
  /** Cursor: fetch the page strictly older than this (createdAt, id) pair.
   *  Omit on the first page (most recent). */
  beforeCreatedAt: z.number().optional(),
  beforeId: z.string().optional(),
});
export type SessionMessagesInput = z.infer<typeof SessionMessagesSchema>;

/**
 * 把一段对话分叉成新的一段(右键左栏的对话 → 复制一份)。
 *
 * 只多一个 `title`,而且**由渲染端给**:新对话要叫什么是一句界面文案(中文「X 副本」/
 * 英文「X (copy)」),而主进程那一侧没有 i18n —— 那边写死一句中文,英文界面里就会冒出
 * 一句中文。会话标题本来就是用户数据(重命名那条路也是渲染端传下来的),这里同一条。
 */
export const ForkSessionSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
});
export type ForkSessionInput = z.infer<typeof ForkSessionSchema>;

export const SaveMessagesSchema = z.object({
  sessionId: z.string(),
  /** Full message snapshot for the session — replaces whatever is stored. */
  messages: z.array(MessageRecordSchema),
});
/**
 * We type `messages` against the domain MessageRecord rather than z.infer,
 * because zod renders z.unknown()/z.any() content as optional, which would
 * mismatch MessageRecord.content (required). The schema still validates shape
 * at runtime; the type is asserted to match the domain model.
 */
export type SaveMessagesInput = { sessionId: string; messages: MessageRecord[] };

/** Incremental message persist — upserts the given rows by id, leaving all
 *  other rows for the session untouched. Use for additive / localized changes
 *  (a turn's new messages, a turn-files card attached to a trailing message).
 *  Prefer this over {@link SaveMessagesSchema} when only a few rows changed —
 *  it avoids the O(N) DELETE+re-INSERT of a full snapshot. */
export const UpsertMessagesSchema = z.object({
  sessionId: z.string(),
  messages: z.array(MessageRecordSchema),
});
export type UpsertMessagesInput = { sessionId: string; messages: MessageRecord[] };

/** Edit-and-resend persist: delete every message at or after the cursor
 *  (createdAt, id) and insert the given replacement rows in one transaction.
 *  This is paginated-history-safe — older rows not loaded in renderer memory
 *  are preserved, whereas {@link SaveMessagesSchema} would wipe them. */
export const TruncateAndInsertMessagesSchema = z.object({
  sessionId: z.string(),
  cursorCreatedAt: z.number(),
  cursorId: z.string(),
  messages: z.array(MessageRecordSchema),
});
export type TruncateAndInsertMessagesInput = {
  sessionId: string;
  cursorCreatedAt: number;
  cursorId: string;
  messages: MessageRecord[];
};

/* ── Settings ── */
export const GetSettingSchema = z.object({ key: z.string() });
export type GetSettingInput = z.infer<typeof GetSettingSchema>;

export const SetSettingSchema = z.object({ key: z.string(), value: z.string() });
export type SetSettingInput = z.infer<typeof SetSettingSchema>;

/** Bulk read of setting keys — one IPC instead of N round-trips. Missing keys
 *  map to `null` in the result record. */
export const GetManySettingsSchema = z.object({ keys: z.array(z.string()) });
export type GetManySettingsInput = z.infer<typeof GetManySettingsSchema>;
export type GetManySettingsResult = Record<string, string | null>;

/* ── Voice input ── */

/**
 * Kick off an ASR session: ensure the model/engine is ready (downloading on
 * first use, lazily), create an online decoder for `lang`, and prepare to
 * receive PCM audio. `sessionId` lets the renderer run one live transcription
 * at a time per composer (a per-composer token); it is NOT the chat-session id.
 */
export const VoiceStartSchema = z.object({
  /** Opaque per-listen token chosen by the renderer (e.g. a random hex id). */
  sessionId: z.string().min(1),
  /** Speech language tag, e.g. "zh-CN" | "en-US". Picks the decoder language. */
  lang: z.string().min(1),
  /** Desired engine: "zipformer" (streaming, interim results) | "parakeet"
   *  (offline, higher accuracy). Falls back to zipformer when unavailable. */
  engine: VoiceEngineSchema,
});
export type VoiceStartInput = z.infer<typeof VoiceStartSchema>;

/** Feed a chunk of 16 kHz mono PCM samples to the active session's decoder.
 *  The Float32Array form is the preferred wire encoding (structured clone
 *  carries it at 4 bytes/sample and validation is a single instanceof check);
 *  the plain number[] form is still accepted for compatibility. */
export const VoiceFeedSchema = z.object({
  sessionId: z.string().min(1),
  pcm: z.union([z.instanceof(Float32Array), z.array(z.number()).max(65536 * 4)]),
});
export type VoiceFeedInput = z.infer<typeof VoiceFeedSchema>;

/** Stop the session and return the final (highest-confidence) transcript. */
export const VoiceStopSchema = z.object({ sessionId: z.string().min(1) });
export type VoiceStopInput = z.infer<typeof VoiceStopSchema>;

/** Cancel/discard a session (no final result emitted; drops partials). */
export const VoiceCancelSchema = z.object({ sessionId: z.string().min(1) });
export type VoiceCancelInput = z.infer<typeof VoiceCancelSchema>;

/** Result of voice.stop — the final recognized text ("" if nothing spoken). */
export const VoiceStopResultSchema = z.object({ text: z.string() });
export type VoiceStopResult = z.infer<typeof VoiceStopResultSchema>;

/** Main → renderer push: live recognition result for a voice session.
 *  `partial` = interim (streaming, possibly revised); `final` = committed
 *  segment for the current session. */
export const VoiceResultPayloadSchema = z.object({
  sessionId: z.string().min(1),
  kind: z.enum(["partial", "final"]),
  text: z.string(),
});
export type VoiceResultPayload = z.infer<typeof VoiceResultPayloadSchema>;

/* ── Voice model catalog + download ── */

/** One downloadable ASR model. `files` carry the exact filenames the engine
 *  requires (mirroring {@link STREAMING_ZIPFORMER_FILES} in the sherpa-onnx
 *  model zoo) plus per-file download URLs. `dir` is the local subdir name. */
export interface VoiceModelInfo {
  id: string;
  name: string;
  /** Human label for the primary language, e.g. "中文 (zh-CN)". */
  langLabel: string;
  /** Approximate expanded size, shown in the settings list. */
  sizeLabel: string;
  /** Subdirectory under the voice model dir that this model's files live in. */
  dir: string;
  files: { rel: string; url: string }[];
}

/**
 * The set of models the app can download. All are free / open (Apache-2.0)
 * and run fully on-device. Streaming Zipformer models give live interim
 * results (the "文字边听边出" UX). Hosted on HuggingFace under `csukuangfj`;
 * per-file URLs may move — keep them in sync with the sherpa-onnx model zoo.
 * @see https://k2-fsa.github.io/sherpa/onnx/
 */
export const VOICE_MODEL_CATALOG: VoiceModelInfo[] = [
  {
    id: "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23",
    name: "Streaming Zipformer 中文",
    langLabel: "中文 (zh-CN)",
    sizeLabel: "~67 MB",
    dir: "streaming-zipformer-zh",
    files: [
      {
        rel: "tokens.txt",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/tokens.txt",
      },
      {
        rel: "encoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/encoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "decoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/decoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "joiner-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/joiner-epoch-99-avg-1.int8.onnx",
      },
    ],
  },
  {
    id: "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
    name: "Streaming Zipformer 中英",
    langLabel: "中英双语 (zh + en)",
    sizeLabel: "~81 MB",
    dir: "streaming-zipformer-zh-en",
    files: [
      {
        rel: "tokens.txt",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/tokens.txt",
      },
      {
        rel: "encoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/encoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "decoder-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/decoder-epoch-99-avg-1.int8.onnx",
      },
      {
        rel: "joiner-epoch-99-avg-1.int8.onnx",
        url: "https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/main/joiner-epoch-99-avg-1.int8.onnx",
      },
    ],
  },
];

/** Start downloading a catalog model (`modelId`). Main streams files into the
 *  model dir and reports progress on `voice:downloadProgress`. */
export const VoiceDownloadModelSchema = z.object({
  modelId: z.string().min(1),
});
export type VoiceDownloadModelInput = z.infer<typeof VoiceDownloadModelSchema>;

/** List the catalog + which models are downloaded + the active selection. */
export const VoiceModelListSchema = z.object({});
export type VoiceModelListInput = z.infer<typeof VoiceModelListSchema>;
export const VoiceModelListResultSchema = z.object({
  models: z.array(z.custom<VoiceModelInfo>()),
  downloaded: z.array(z.string()),
  selected: z.string().nullable(),
  /** Active model root (after the user's customization, if any). */
  modelDir: z.string(),
  /** True when the user has set a custom model root. */
  isCustom: z.boolean(),
});
export type VoiceModelListResult = z.infer<typeof VoiceModelListResultSchema>;

/** Main → renderer push: download progress for a model. `percent` is 0–100
 *  across the whole model (byte-weighted when per-file sizes are known,
 *  file-count-weighted otherwise). */
export const VoiceDownloadProgressPayloadSchema = z.object({
  modelId: z.string().min(1),
  stage: z.enum(["downloading", "done", "error", "cancelled"]),
  /** Whole-model progress 0–100 (includes file index weighting). */
  percent: z.number().min(0).max(100),
  /** 0-based index of the file currently downloading. */
  fileIndex: z.number().min(0),
  fileCount: z.number().min(1),
  /** Bytes so far for the current file (for small-file UIs). */
  fileBytes: z.number().min(0),
  /** Total bytes of the current file when known (Content-Length); lets the
   *  UI render "12.3 / 50.6 MB" instead of a bare percentage. */
  fileTotalBytes: z.number().min(0).optional(),
  error: z.string().optional(),
});
export type VoiceDownloadProgressPayload = z.infer<
  typeof VoiceDownloadProgressPayloadSchema
>;

/* ── Notifications ── */

/** Input for getting/setting notification preferences. The prefs are persisted
 *  under {@link NOTIFICATION_PREFS_SETTING_KEY} as JSON; these RPCs provide a
 *  typed wrapper so the renderer doesn't hand-roll the JSON parse/stringify. */
export const GetNotificationPrefsSchema = z.object({});
export type GetNotificationPrefsInput = z.infer<typeof GetNotificationPrefsSchema>;

export const SetNotificationPrefsSchema = NotificationPrefsSchema;
export type SetNotificationPrefsInput = NotificationPrefs;

/** Input for focusing a session after an OS notification click. The main
 *  process brings the window to the front (show + focus), then pushes a
 *  `notification:focusSession` event so the renderer can navigate to the
 *  session (selectSession / openTab). */
export const FocusSessionSchema = z.object({ sessionId: z.string() });
export type FocusSessionInput = z.infer<typeof FocusSessionSchema>;

/* ── Custom model configs (user-defined Anthropic-compatible endpoints) ── */

/** One selectable model within a custom-model config. */
const CustomModelEntrySchema = z.object({
  id: z.string().min(1),
  supports1m: z.boolean().optional(),
});

const AuthModeSchema = z.enum(["auth_token", "api_key"]);

const ProtocolSchema = z.enum(["anthropic", "openai"]);

/** Extra request headers for a custom endpoint, keyed by header name. Shape
 *  only — names/values are validated in main (see
 *  `providers/upstreamHeaders.ts`), which owns the delivery rules and drops
 *  entries a gateway would reject instead of failing the whole save. */
const CustomHeadersSchema = z.record(z.string(), z.string());

/** Save (create or update) a custom-model config. On update, an omitted
 *  `authToken` keeps the existing stored token; on create, `authToken` is
 *  required. At least one model entry is required. */
export const SaveCustomModelSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  authMode: AuthModeSchema.optional(),
  protocol: ProtocolSchema.optional(),
  authToken: z.string().optional(),
  models: z.array(CustomModelEntrySchema).min(1),
  /** Task-subagent model pin (one of models[].id); the store drops a value
   *  not present in the list. Absent = follow the main session's model. */
  subagentModel: z.string().optional(),
  disableNonEssentialTraffic: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  customHeaders: CustomHeadersSchema.optional(),
});
export type SaveCustomModelInput = CustomModelInput;

export const DeleteCustomModelSchema = z.object({ id: z.string() });

/** Probe a custom endpoint using the supplied (not-yet-saved) values, so the
 *  user can verify auth/baseUrl/a-specific-model before committing. The probe
 *  tests ONE model at a time (the user picks which model in the UI). */
export const TestCustomModelSchema = z.object({
  baseUrl: z.string().min(1),
  authToken: z.string().min(1),
  authMode: AuthModeSchema.optional(),
  protocol: ProtocolSchema.optional(),
  /** The single model id to probe in this request. */
  model: z.string().min(1),
  /** Whether to declare 1M context (adds the `[1m]` suffix) — mirrors the
   *  model row's toggle. */
  supports1m: z.boolean().optional(),
  disableNonEssentialTraffic: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  /** Headers to probe with, so an endpoint that requires one (and would
   *  otherwise fail the test) can be verified before saving. */
  customHeaders: CustomHeadersSchema.optional(),
});
export type TestCustomModelInput = z.infer<typeof TestCustomModelSchema>;

/** Fetch the cleartext auth token for an already-saved custom-model config.
 *  This BREAKS the usual "cleartext never crosses IPC" rule on purpose: it
 *  exists solely so the settings UI can show the token when the user clicks
 *  the eye icon on an edit form. It MUST NOT be used by any background /
 *  turn-time path (those resolve the token in main via resolveApiConfig). */
export const GetCustomModelTokenSchema = z.object({ id: z.string().min(1) });
export type GetCustomModelTokenInput = z.infer<typeof GetCustomModelTokenSchema>;

/* ── Pi models (visual editor for ~/.pi/agent/models.json) ── */

/** Save a provider to models.json. `config` is the full provider object from
 *  the form; unknown fields are preserved by the store. `apiKey` is encrypted
 *  separately (safeStorage) and never written to models.json — empty string
 *  means "preserve the existing key" when updating; required when creating
 *  a new provider. */
export const SavePiProviderSchema = z.object({
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  apiKey: z.string().optional(),
});
export type SavePiProviderInput = z.infer<typeof SavePiProviderSchema>;

export const DeletePiProviderSchema = z.object({ name: z.string().min(1) });
export type DeletePiProviderInput = z.infer<typeof DeletePiProviderSchema>;

/** Get a provider's API key in cleartext. Main-process only — never
 *  exposed to the renderer. Used by PiAgentSdkProvider to inject the key
 *  into the pi authStorage at turn time. */
export const GetPiApiKeySchema = z.object({ name: z.string().min(1) });
export type GetPiApiKeyInput = z.infer<typeof GetPiApiKeySchema>;

/* ── Codex model providers (third-party Responses-API endpoints driving the
      Codex harness; materialized into <CODEX_HOME>/config.toml) ── */

/** Save (create/update) one Codex provider. `config` carries the metadata
 *  (name/baseUrl/models); `apiKey` is encrypted separately (safeStorage,
 *  `codexProviderKeys`) and never lands in config.toml — empty string means
 *  "preserve the existing key" when updating; required when creating. */
export const SaveCodexProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  models: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().optional(),
      hint: z.string().optional(),
      /** Optional context-window override (spawned as `-c
       *  model_context_window=<n>`, process-local). */
      contextWindow: z.number().int().positive().optional(),
    }),
  ).min(1),
  /** Opt-in: unlock codex's image generation tool by injecting the
   *  `x-openai-actor-authorization` http_header into the provider's TOML
   *  table (gateway must back /v1/images/generations with gpt-image-2). */
  imageGeneration: z.boolean().optional(),
  apiKey: z.string().optional(),
});
export type SaveCodexProviderInput = z.infer<typeof SaveCodexProviderSchema>;

export const DeleteCodexProviderSchema = z.object({ id: z.string().min(1) });
export type DeleteCodexProviderInput = z.infer<typeof DeleteCodexProviderSchema>;

/** Cleartext apiKey getter — same security carve-out as
 *  customModel.getToken / piModels.getApiKey: settings-UI eye icon only,
 *  never a turn-time path (turn-time resolution happens inside main). */
export const GetCodexApiKeySchema = z.object({ id: z.string().min(1) });
export type GetCodexApiKeyInput = z.infer<typeof GetCodexApiKeySchema>;

/* ── Theme / color scheme ── */

export const SetThemeSchema = z.object({ theme: ThemeNameSchema });
export type SetThemeInput = z.infer<typeof SetThemeSchema>;
export type GetThemeResult = { theme: ThemeName; effective: EffectiveTheme };

/* ── App / runtime info (About panel) ── */

/** Runtime info surfaced to the About panel. `appVersion` comes from
 *  Electron's `app.getVersion()` (reads the root package.json in dev, the
 *  built app's version in production); the rest come from `process.versions`
 *  and `process.platform` on the main side. No input - it's a parameterless
 *  RPC. */
export interface AppInfoResult {
  /** App version string (e.g. "0.0.0" in dev, the release version in prod). */
  appVersion: string;
  /** Electron version. */
  electron: string;
  /** Bundled Node.js version. */
  node: string;
  /** Bundled Chromium version. */
  chromium: string;
  /** OS platform: "win32" | "darwin" | "linux". */
  platform: string;
  /** CPU architecture (e.g. "x64", "arm64"). */
  arch: string;
}

/* ── Auto-update (electron-updater, GitHub Releases channel) ── */

/** Result of a manual/auto update check. */
export type CheckForUpdatesResult =
  | { status: "up-to-date"; version: string }
  | { status: "available"; version: string; manualInstallRequired: boolean }
  | { status: "error"; error: string };

/** Pushed when the updater finds a newer version on the release channel.
 *  Sent right after `update-available` fires in main; the renderer shows a
 *  download prompt. autoDownload is off, so the user opts in. */
export interface UpdateAvailableMessage {
  channel: "update:available";
  /** Version string of the pending update (e.g. "0.2.0"). */
  version: string;
  /** Release notes (markdown or plain) from the release, if any. */
  releaseNotes?: string;
  /** ISO date string of the release, if available. */
  releaseDate?: string;
  /** Where the check that discovered this update came from: "auto" = the
   *  boot/interval check initiated by main, "manual" = the user clicked
   *  "check for updates" in the About panel. The global update notification
   *  card only auto-shows for "auto" so a manual check never pops a redundant
   *  card over the panel the user is already looking at. */
  source?: "auto" | "manual";
  /** True when Squirrel.Mac can't auto-install updates (macOS ad-hoc
   *  signature). Surfaced at discovery time — before any bytes are downloaded
   *  — so the renderer can guide the user to the releases page immediately
   *  instead of wasting a ~100MB in-app download that ends in "manual install
   *  required". Always false on Windows. */
  manualInstallRequired?: boolean;
}

/** Pushed when a downloaded update is ready to install. The renderer offers a
 *  "restart & install" button that calls `app.quitAndInstall`.
 *
 *  On macOS with an ad-hoc signed app (no Apple Developer ID), Squirrel.Mac
 *  silently fails to apply the update — the button appears to do nothing.
 *  When `manualInstallRequired` is true the renderer should instead guide the
 *  user to manually download from the releases page. */
export interface UpdateDownloadedMessage {
  channel: "update:downloaded";
  /** Version string of the downloaded update. */
  version: string;
  /** Release notes (markdown or plain) from the release, if any. */
  releaseNotes?: string;
  /** True when Squirrel.Mac can't auto-install the update (e.g. macOS ad-hoc
   *  signature). The renderer should offer a "go to download" action instead
   *  of "restart & install". Always false on Windows. */
  manualInstallRequired?: boolean;
}

/** Pushed repeatedly while an update downloads, carrying live progress so the
 *  About panel can render a percentage + byte counter instead of a static
 *  spinner. `percent` is 0-100. */
export interface UpdateDownloadProgressMessage {
  channel: "update:downloadProgress";
  /** Version string of the update being downloaded. */
  version: string;
  /** Download progress, 0-100. */
  percent: number;
  /** Bytes transferred so far. */
  transferred: number;
  /** Total bytes to download (0 if unknown). */
  total: number;
  /** Current download speed in bytes/second. */
  bytesPerSecond: number;
}

/** Persisted snapshot of the update flow, stored under
 *  {@link UPDATE_STATE_SETTING_KEY} so the About panel can restore the banner
 *  after being unmounted/remounted or after an app restart. Only the states
 *  worth restoring are persisted - transient checks/errors stay in memory. */
export interface PersistedUpdateState {
  /** "downloading" = an update is mid-download (autoUpdater resumes on boot);
   *  "downloaded" = an update is ready to install on next restart. */
  status: "downloading" | "downloaded";
  /** Version string of the update. */
  version: string;
  /** Last seen download percent (0-100). Only meaningful for "downloading". */
  percent: number;
  /** Bytes transferred so far. Only meaningful for "downloading". */
  transferred: number;
  /** Total bytes (0 if unknown). Only meaningful for "downloading". */
  total: number;
  /** ISO timestamp of when this snapshot was written. */
  updatedAt: string;
  /** Mirrors {@link UpdateDownloadedMessage.manualInstallRequired} so the
   *  banner restores the correct action (manual download vs restart & install)
   *  after app restart. Only meaningful for "downloaded". */
  manualInstallRequired?: boolean;
}

/* ── File operations (read / list dir / write) ── */

/** Read a single file's current content as utf-8 text. The main handler
 *  resolves the path against the session's project cwd and refuses anything
 *  that escapes it (path-traversal guard) — the renderer (contextIsolation)
 *  has no filesystem access of its own. Used by the turn-files diff card to
 *  fetch the post-turn content to diff against the snapshotted `before`. */
export const FileReadSchema = z.object({
  /** Absolute or cwd-relative path. Must resolve inside a known project root. */
  filePath: z.string(),
});
export type FileReadInput = z.infer<typeof FileReadSchema>;

/** Read a file as base64-encoded binary, returned as a `data:` URL ready for an
 *  `<img src=...>`. Used by the editor's image preview pane. Same
 *  project-root path-traversal guard as `file:readFile`. The `mimeType` is
 *  derived from the extension on the main side so the renderer doesn't have to.
 *  On refusal / failure returns `{ dataUrl: "" }` so the renderer can show a
 *  friendly error instead of throwing. */
export const FileReadBinarySchema = z.object({
  /** Absolute path. Must resolve inside a known project root. */
  filePath: z.string(),
});
export type FileReadBinaryInput = z.infer<typeof FileReadBinarySchema>;

/** Open the OS file dialog for image selection and return the files as base64.
 *  Main reads the files itself (the renderer can't read arbitrary paths under
 *  contextIsolation). A user-driven dialog is explicit consent, so no
 *  project-root guard applies — same trust level as `clipboard.saveFile`.
 *  Individual files above PICK_IMAGE_MAX_BYTES (main-side) are skipped; the
 *  renderer additionally downsizes before sending (see imageResize.ts). */
export const PickImagesSchema = z.object({});
export type PickImagesInput = z.infer<typeof PickImagesSchema>;

/** One image read from the user's file dialog. `data` is base64 without the
 *  `data:` prefix; `mimeType` is the SendTurn allowlist (jpeg/png/gif/webp). */
export interface PickedImage {
  /** Original file name (display only). */
  name: string;
  data: string;
  mimeType: SendTurnImage["mimeType"];
}

/** Save a file pasted from the OS clipboard (external image/file — copied in
 *  Finder, a browser, or a screenshot) to a temp path the agent can read.
 *  Bytes travel as base64 (matches the existing binary patterns); main
 *  preserves the original extension so the agent's Read tool can sniff image
 *  types, and returns the absolute temp path. The renderer then attaches it
 *  exactly like an internally dragged file (a `@path` file tag). */
export const ClipboardSaveFileSchema = z.object({
  /** Original file name (display + extension preservation). */
  name: z.string().min(1).max(255),
  /** base64-encoded file bytes (~52MB file ceiling). */
  bytes: z.string().min(1).max(70_000_000),
});
export type ClipboardSaveFileInput = z.infer<typeof ClipboardSaveFileSchema>;

export const ClipboardSaveFileResultSchema = z.object({
  ok: z.boolean(),
  /** Absolute temp path (set when ok). */
  path: z.string().optional(),
  error: z.string().optional(),
});
export type ClipboardSaveFileResult = z.infer<typeof ClipboardSaveFileResultSchema>;

/** Copy an image (a `data:image/...` URL, e.g. from an agent screenshot) onto
 *  the OS clipboard. The renderer's `navigator.clipboard` can't reliably write
 *  images, so main decodes the data URL into a nativeImage and calls
 *  `clipboard.writeImage`. The data URL scheme is validated here — main only
 *  trusts `data:image/` payloads, never remote URLs. */
export const ClipboardWriteImageSchema = z.object({
  /** Full `data:image/<mime>;base64,...` URL of the image to copy. */
  dataUrl: z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,/i).max(80_000_000),
});
export type ClipboardWriteImageInput = z.infer<typeof ClipboardWriteImageSchema>;

export const ClipboardWriteImageResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type ClipboardWriteImageResult = z.infer<typeof ClipboardWriteImageResultSchema>;

/** One entry returned by `file.listDir`. `path` is the absolute filesystem
 *  path (already validated to sit inside a project root); `name` is the base
 *  name for display. `size` is only populated for files (bytes). */
export interface FileTreeEntry {
  name: string;
  /** Absolute path (cwd-resolved + validated by main). */
  path: string;
  isDir: boolean;
  /** File size in bytes (omitted for directories). */
  size?: number;
}

/** List a single level of a directory (non-recursive). `dirPath` is relative
 *  to `projectPath` (empty string = the project root itself). Main resolves
 *  it, refuses escapes, filters out ignored entries (node_modules, .git, …),
 *  and returns entries sorted directories-first then alphabetical. On any
 *  read failure the handler returns `{ entries: [] }` so the tree degrades
 *  gracefully rather than throwing into the renderer. */
export const FileListDirSchema = z.object({
  /** Absolute path of the project root the listing is scoped to. Must match a
   *  persisted Project.path — main cross-checks this against ProjectRepo. */
  projectPath: z.string(),
  /** Directory to list, relative to projectPath. "" or "." = root. */
  dirPath: z.string(),
});
export type FileListDirInput = z.infer<typeof FileListDirSchema>;

/**
 * One file hit from `file.search`. Paths are absolute and already validated
 * to sit inside the project root. `relativePath` uses forward slashes for
 * stable display across platforms.
 */
export interface FileSearchEntry {
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** Path relative to the project root (forward-slash separated). */
  relativePath: string;
}

/**
 * Recursive file search under a project root for composer @-mention and
 * "add context" pickers. Main walks the tree (skipping the same ignored
 * dirs as listDir), optionally filters by case-insensitive substring on
 * name/relativePath, and returns at most `limit` files. Directories are
 * never returned — only files. Empty query returns a truncated breadth-
 * first sample so the picker has something to show immediately.
 */
export const FileSearchSchema = z.object({
  /** Absolute path of the project root. Must match a persisted Project.path. */
  projectPath: z.string(),
  /** Optional case-insensitive filter over file name / relative path. */
  query: z.string().optional(),
  /** Optional file-extension allow-list (no dots, lowercased). Empty or
   *  absent means no filter; name search drops files outside the list. */
  includeExts: z.array(z.string().min(1).max(32)).max(50).optional(),
  /** Max files to return. Defaults to 80 on the main side. */
  limit: z.number().int().positive().max(2000).optional(),
});
export type FileSearchInput = z.infer<typeof FileSearchSchema>;

/**
 * Result of a `file.search` call. `files` are already ranked and sliced to
 * `limit`. `truncated` is true when more matches existed than the requested
 * `limit` (the caller showed a slice, not the full set). `incompleteScan` is
 * true when the walk itself was cut short by the traversal budget (visit /
 * depth caps) — some subtrees were never visited, so results may miss
 * matches regardless of ranking.
 */
export interface FileSearchResult {
  files: FileSearchEntry[];
  /** More matches existed than the returned slice. */
  truncated: boolean;
  /** The tree walk hit its visit/depth budget before finishing. */
  incompleteScan: boolean;
}

/** Write utf-8 content to a file, creating it (and parent dirs) if absent.
 *  Path must resolve inside a known project root (path-traversal guard,
 *  same as readFile). Returns `{ ok }`; on refusal or failure `ok` is false
 *  and the handler logs — the renderer surfaces a non-blocking error. */
export const FileWriteSchema = z.object({
  /** Absolute or cwd-relative path. Must resolve inside a known project root. */
  filePath: z.string(),
  content: z.string(),
});
export type FileWriteInput = z.infer<typeof FileWriteSchema>;

/** Create a directory (and any missing ancestors), scoped to a known project
 *  root. Used by the file-tree "新建文件夹" action. `recursive: true` means an
 *  already-existing dir is not an error. Returns `{ ok }`; on refusal or
 *  failure `ok` is false and the handler logs. */
export const FileMkdirSchema = z.object({
  /** Absolute path of the directory to create. Must resolve inside a known
   *  project root (path-traversal guard, same as writeFile). */
  dirPath: z.string(),
});
export type FileMkdirInput = z.infer<typeof FileMkdirSchema>;

/** Delete a file or directory by moving it to the system trash (recoverable).
 *  Used by the file-tree "删除" right-click action. The path must resolve
 *  inside a known project root; on refusal or failure `ok` is false and the
 *  handler logs — the renderer surfaces a non-blocking error. Returns `{ ok }`. */
export const FileDeleteSchema = z.object({
  /** Absolute path of the file or directory to trash. Must resolve inside a
   *  known project root (path-traversal guard, same as writeFile/mkdir). */
  targetPath: z.string(),
});
export type FileDeleteInput = z.infer<typeof FileDeleteSchema>;

/** Rename a file or directory in place (same parent directory). Both paths
 *  must resolve inside the same known project root and share the same parent
 *  directory — cross-directory moves are refused (that is a move, not a
 *  rename). Used by the file-tree "重命名" right-click action. On refusal or
 *  failure `ok` is false and the handler logs. Returns `{ ok }`. */
export const FileRenameSchema = z.object({
  /** Absolute path of the entry to rename. Must resolve inside a known project
   *  root. */
  oldPath: z.string(),
  /** Absolute path of the new name. Must be in the same project root and the
   *  same parent directory as `oldPath`. */
  newPath: z.string(),
});
export type FileRenameInput = z.infer<typeof FileRenameSchema>;

/** Copy a file into a target directory (file-tree "复制/粘贴" pair). Both the
 *  source file and the destination directory must resolve inside known project
 *  roots; directories cannot be copied through this channel. If the plain
 *  destination name already exists the handler derives a free name by appending
 *  `suffix` (locale word for "copy", e.g. "副本"/"copy") and a counter — paste
 *  never overwrites. On refusal or failure `ok` is false and the handler logs.
 *  Returns `{ ok }`. */
export const FileCopySchema = z.object({
  /** Absolute path of the file to copy. Must resolve inside a known project
   *  root and be a regular file (not a directory). */
  srcPath: z.string(),
  /** Absolute path of the directory to copy into. Must resolve inside a known
   *  project root. */
  destDir: z.string(),
  /** Locale word used when deriving a clash-free name ("副本" / "copy").
   *  Defaults to "copy" when omitted. */
  suffix: z.string().optional(),
});
export type FileCopyInput = z.infer<typeof FileCopySchema>;

/** Native multi-file picker (project-external files allowed). Used by the
 *  composer "添加上下文" button to attach files that live outside the active
 *  project root — unlike the project-scoped `file.search`, this surfaces any
 *  file on the user's machine via the OS open dialog. */
export const DialogPickFilesSchema = z.object({
  /** Optional dialog title; defaults to a localized "选择文件" on the main side. */
  title: z.string().optional(),
  /** 原生选择框的扩展名过滤,如 `[{ name: "PDF", extensions: ["pdf"] }]`。
   *  不给就列所有文件(既有行为不变)。 */
  filters: z
    .array(z.object({ name: z.string(), extensions: z.array(z.string()) }))
    .optional(),
});
export type DialogPickFilesInput = z.infer<typeof DialogPickFilesSchema>;

/**
 * One line-level match from `file.grep`. `lineNumber` is 1-based. `lineText`
 * is the raw matched line (untrimmed, so column offsets are meaningful).
 * `matches` are 0-based [start,end) column ranges for each occurrence of the
 * query on that line, for frontend highlighting.
 */
export interface FileGrepEntry {
  /** Absolute filesystem path. */
  path: string;
  /** Path relative to the project root (forward-slash separated). */
  relativePath: string;
  /** 1-based line number within the file. */
  lineNumber: number;
  /** Raw text of the matched line. */
  lineText: string;
  /** Column ranges of each query occurrence on this line (0-based [start,end)). */
  matches: Array<{ start: number; end: number }>;
}

/**
 * Grep file contents under a project root. Main walks the same ignored-dir-
 * filtered tree as `file.search`, skips binary files (null-byte sniff on the
 * first ~8KB + a binary-extension skip-list), and scans each text file's
 * lines for the query. Case-insensitive by default. Returns line-level
 * matches, capped at `limit` total and `maxResultsPerFile` per file.
 */
export const FileGrepSchema = z.object({
  /** Absolute path of the project root. Must match a persisted Project.path. */
  projectPath: z.string(),
  /** Substring to search for inside file contents. */
  query: z.string(),
  /** Optional file-extension allow-list (no dots, lowercased). Empty or
   *  absent means no filter; narrows rg's globs and the JS fallback. */
  includeExts: z.array(z.string().min(1).max(32)).max(50).optional(),
  /** Max total matches to return. Defaults to 200 on the main side. */
  limit: z.number().int().positive().max(500).optional(),
  /** Max matches per single file. Defaults to 10 on the main side. */
  maxResultsPerFile: z.number().int().positive().max(50).optional(),
  /** Case-sensitive match. Defaults to false. */
  caseSensitive: z.boolean().optional(),
});
export type FileGrepInput = z.infer<typeof FileGrepSchema>;

/**
 * Result of a `file.grep` call. `matches` are capped at `limit` total /
 * `maxResultsPerFile` per file. `truncated` is true when the match cap was
 * reached while more matches almost certainly exist in files scanned so far.
 * `incompleteScan` is true when the walk hit its visit/depth budget before
 * covering the whole tree — unseen subtrees may hold additional matches.
 */
export interface FileGrepResult {
  matches: FileGrepEntry[];
  /** The match cap was reached — more matches likely exist. */
  truncated: boolean;
  /** The tree walk hit its visit/depth budget before finishing. */
  incompleteScan: boolean;
}

/* ── ripgrep availability / one-click install ──
 *  `file.search` / `file.grep` prefer ripgrep when one is resolvable and
 *  degrade to the in-process scanners when not. These channels let the search
 *  dialog detect the missing binary and offer a one-click install (downloads
 *  the official release into `userData/bin`). */

/** Snapshot of ripgrep availability for the search dialog. `installing`
 *  mirrors the main-side in-flight guard so a reopen during an ongoing
 *  install shows the right state. */
export interface RgStatusResult {
  /** An `rg` binary is resolvable (bundled userData/bin checked first, then PATH). */
  available: boolean;
  /** Resolved binary path when available. */
  path?: string;
  /** An install has been requested and is still running. */
  installing: boolean;
}

export const RgInstallSchema = z.object({});
export type RgInstallInput = z.infer<typeof RgInstallSchema>;

/** Result of an `rg.install` request. On success the binary sits in
 *  `userData/bin` and subsequent searches pick it up. */
export interface RgInstallResult {
  ok: boolean;
  error?: string;
  /** Path of the installed binary on success. */
  path?: string;
}

/* ── Git operations (status / stage / commit / push / pull / diff) ──
 *  All git operations are scoped to a `repoPath` that must resolve inside a
 *  known project root. A single project folder may host MULTIPLE git repos
 *  (monorepo, submodules, nested projects) — `git.discoverRepos` finds them. */

/** A git repository discovered under a project folder. `path` is the absolute
 *  repo root (the directory containing `.git`). `name` is the relative path
 *  from the project root (or the basename for the root itself). */
export interface GitRepo {
  /** Absolute path to the repo root (contains `.git`). */
  path: string;
  /** Display name: path relative to the project root, or the folder name. */
  name: string;
  /** Always true — discriminator for future result unions. */
  isRepo: true;
}

/** Git status code for a single file, mirroring porcelain output. `index` is
 *  the staged (cached) status; `workingTree` is the unstaged status. Both use
 *  the same union of git status codes. */
export type GitStatusCode =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "ignored"
  | "untracked";

/** One file's status in a repo. `path` is relative to the repo root. */
export interface GitFileStatus {
  path: string;
  /** Staged status (what's in the index vs HEAD). */
  index: GitStatusCode;
  /** Working-tree status (what's on disk vs the index). */
  workingTree: GitStatusCode;
}

/** Full status of a single repo. */
export interface GitStatusResult {
  /** Current branch name (empty in detached HEAD). */
  branch: string;
  /** Commits ahead of upstream (0 if no upstream). */
  ahead: number;
  /** Commits behind upstream (0 if no upstream). */
  behind: number;
  /** All changed files (staged + unstaged + untracked). */
  files: GitFileStatus[];
}

/** Result of a git operation that may fail (push/pull/commit). `ok` is false
 *  on any error; `error` carries a human-readable message (e.g. auth failure,
 *  no upstream, merge conflict). */
export interface GitOpResult {
  ok: boolean;
  /** Error message when ok is false. */
  error?: string;
  /** Set by `git:pull` when the pull produced a merge conflict. The repo is
   *  now in a conflicted (unmerged) state; `conflictedFiles` lists the paths
   *  that need resolution before the merge can be committed. */
  conflict?: boolean;
  conflictedFiles?: string[];
}

/** Discover all git repos under a project root (recursive, max depth 3).
 *  `rootOnly: true` checks ONLY the root level itself (`.git` present there)
 *  — used by the worktree picker, whose materialization requires a repo at
 *  the project root; a repo nested in a subdirectory doesn't qualify. */
export const GitDiscoverReposSchema = z.object({
  projectPath: z.string(),
  rootOnly: z.boolean().optional(),
});
export type GitDiscoverReposInput = z.infer<typeof GitDiscoverReposSchema>;

/** Input for operations targeting a single repo. */
export const GitRepoPathSchema = z.object({
  repoPath: z.string(),
});
export type GitRepoPathInput = z.infer<typeof GitRepoPathSchema>;

/** Stage (git add) specific files. `filePaths` are relative to the repo root. */
export const GitStageSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitStageInput = z.infer<typeof GitStageSchema>;

/** Unstage (git reset) specific files. `filePaths` are relative to the repo root. */
export const GitUnstageSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitUnstageInput = z.infer<typeof GitUnstageSchema>;

/** Commit staged changes with a message. */
export const GitCommitSchema = z.object({
  repoPath: z.string(),
  message: z.string().min(1),
});
export type GitCommitInput = z.infer<typeof GitCommitSchema>;

/** Diff of a single file. `filePath` is relative to repo. When `staged` is
 *  true, diffs the index against HEAD (what will be committed); otherwise
 *  diffs the working tree against the index (unstaged changes). */
export const GitDiffSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
  /** If true, show staged (cached) diff — index vs HEAD. */
  staged: z.boolean().optional(),
});
export type GitDiffInput = z.infer<typeof GitDiffSchema>;

/** Full old-side blob for the working-tree diff view. `index` reads the
 *  staged snapshot (`git show :path`), `"HEAD"` reads the last commit
 *  (`git show HEAD:path`). A missing blob (untracked / newly added /
 *  staged deletion) yields "". */
export const GitFileBlobSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
  side: z.enum(["index", "HEAD"]),
});
export type GitFileBlobInput = z.infer<typeof GitFileBlobSchema>;

/** Discard (revert) local changes to specific files. For tracked files this
 *  runs `git checkout -- <files>` (restores to index/HEAD); for untracked files
 *  it runs `git clean -f -- <files>` (removes them). The handler decides per
 *  file based on its status. */
export const GitDiscardSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitDiscardInput = z.infer<typeof GitDiscardSchema>;

/** Generate a commit message from the staged diff using an LLM.
 *  `repoPath` scopes the diff; `customModelId` + `customModelRole` select the
 *  specific model (a config + its role binding); `prompt` is the user's
 *  configured prompt template. The handler collects the staged diff, feeds
 *  it to the model via a one-shot SDK query, and returns the generated text. */
export const GitGenerateCommitSchema = z.object({
  repoPath: z.string(),
  /** Custom-model config id (from CustomModelStore). null = use built-in. */
  customModelId: z.string().nullable(),
  /** Which role binding within the config to use (e.g. "sonnet"). Ignored
   *  when customModelId is null. */
  customModelRole: z.string().nullable(),
  /** The user's prompt template. The diff is appended after this. */
  prompt: z.string(),
  /** Optional cancellation key: when present, the AbortController driving the
   *  SDK query is registered under this id so git.cancelGenerateCommit can
   *  abort an in-flight generation. */
  requestId: z.string().optional(),
  /** Which diff feeds the generation: "staged" (default — index vs HEAD,
   *  the commit-box flow) or "worktree" (working tree vs HEAD, staged AND
   *  unstaged — the worktree merge-back flow, where agent changes are
   *  typically uncommitted). */
  scope: z.enum(["staged", "worktree"]).optional(),
});
export type GitGenerateCommitInput = z.infer<typeof GitGenerateCommitSchema>;

/** Cancel an in-flight git.generateCommitMessage call (matched by the
 *  requestId passed to it). No-op if that generation already finished. */
export const GitCancelGenerateCommitSchema = z.object({
  requestId: z.string(),
});
export type GitCancelGenerateCommitInput = z.infer<typeof GitCancelGenerateCommitSchema>;

/* ── Git history (log / show commit / show file at revision) ── */

/** One commit in a `git.log` / `git.showCommit` result. */
export interface GitCommitInfo {
  /** Full commit hash. */
  hash: string;
  /** Abbreviated hash (typically 7 chars). */
  shortHash: string;
  /** First line of the commit message. */
  subject: string;
  /** Remaining body after the subject (may be empty). */
  body?: string;
  /** Author display name. */
  author: string;
  /** Author date as ISO-8601 string. */
  authoredAt: string;
  /** Parent commit hashes (empty for root commits). Returned by git.log and
   *  showCommit alike — log's %P field feeds it (see parseLogOutput). */
  parents?: string[];
}

/** File change status inside a single commit (relative to its parent). */
export type GitCommitFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied";

/** One file changed by a commit. */
export interface GitCommitFile {
  /** Path relative to the repo root (new path for renames). */
  path: string;
  status: GitCommitFileStatus;
  /** Previous path when status is renamed/copied. */
  oldPath?: string;
  additions?: number;
  deletions?: number;
}

/** Full detail for one commit: meta + changed files. */
export interface GitCommitDetail {
  commit: GitCommitInfo;
  files: GitCommitFile[];
}

/** Paginated commit log. `limit` defaults to 50; `skip` defaults to 0. */
export const GitLogSchema = z.object({
  repoPath: z.string(),
  /** Max commits to return (default 50, max 200). */
  limit: z.number().int().min(1).max(200).optional(),
  /** Number of commits to skip (for pagination). */
  skip: z.number().int().min(0).optional(),
  /** Optional ref to start from (branch/tag/hash). Defaults to HEAD.
   *  Restricted to safe ref characters to avoid CLI injection. */
  ref: z
    .string()
    .regex(/^[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref")
    .optional(),
});
export type GitLogInput = z.infer<typeof GitLogSchema>;

/** Commit hashes are restricted to hex so callers cannot inject CLI args. */
const GitCommitHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{4,40}$/, "invalid commit hash");

/** Load meta + changed-file list for one commit. */
export const GitShowCommitSchema = z.object({
  repoPath: z.string(),
  commitHash: GitCommitHashSchema,
});
export type GitShowCommitInput = z.infer<typeof GitShowCommitSchema>;

/** Load parent-vs-commit file contents for Monaco diff. */
export const GitShowFileSchema = z.object({
  repoPath: z.string(),
  commitHash: GitCommitHashSchema,
  /** Path relative to the repo root (new path for renames). */
  filePath: z.string().min(1),
  /** Previous path when the file was renamed/copied in this commit. */
  oldPath: z.string().optional(),
});
export type GitShowFileInput = z.infer<typeof GitShowFileSchema>;

/* ── Git branch switching (list / checkout) ── */

/** Ref kind for `git.listBranches` entries. */
export type GitBranchType = "local" | "remote" | "tag";

/** One branch / tag entry in a `git.listBranches` result. */
export interface GitBranchInfo {
  /** Display name: short name for local (main), `origin/main` for remote,
   *  tag name for tags (v1.0.0). */
  name: string;
  /** True when this is the currently checked-out ref. */
  current: boolean;
  /** Short commit hash at this ref. */
  commit: string;
  /** Commit subject (first line of the message) at this ref. */
  label: string;
  /** Ref kind discriminator. */
  type: GitBranchType;
}

/** Grouped ref list returned by `git.listBranches`. */
export interface GitBranchListResult {
  /** Current branch name (empty string in detached HEAD). */
  current: string;
  /** True when the repo is in a detached HEAD state. */
  detached: boolean;
  /** Local branches (refs/heads). */
  local: GitBranchInfo[];
  /** Remote branches (refs/remotes), excluding the HEAD symref of each remote. */
  remote: GitBranchInfo[];
  /** Tags (refs/tags), annotated + lightweight. */
  tags: GitBranchInfo[];
}

/** Switch the working tree to another branch / tag / ref.
 *
 *  - `branch` is the target ref (local branch, remote branch, tag, or `HEAD`).
 *    Restricted to safe ref characters to avoid CLI injection (same charset as
 *    `GitLogSchema.ref`).
 *  - `newBranch`, when set, creates a new local branch from `branch` and checks
 *    it out (i.e. `git checkout -b <newBranch> <branch>`). Used both for
 *    creating a fresh branch from HEAD (`branch: "HEAD"`) and for tracking a
 *    remote branch (`branch: "origin/foo"`, `newBranch: "foo"`). */
export const GitCheckoutSchema = z.object({
  repoPath: z.string(),
  branch: z.string().regex(/^[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref"),
  /** When provided, create this new local branch from `branch` and check it out. */
  newBranch: z
    .string()
    .regex(/^[A-Za-z0-9._/\-]+$/, "invalid branch name")
    .optional(),
});
export type GitCheckoutInput = z.infer<typeof GitCheckoutSchema>;

/** Delete a LOCAL branch (`git branch -d` / `-D` with `force`). Remote and
 *  tag rows are not deletable from the picker (deleting a remote branch means
 *  pushing a ref deletion — out of scope here). `branch` reuses the checkout
 *  branch-name charset. */
export const GitDeleteBranchSchema = z.object({
  repoPath: z.string(),
  branch: z.string().regex(/^[A-Za-z0-9._/\-]+$/, "invalid branch name"),
  /** Force delete (`git branch -D`) — skips the fully-merged safety check. */
  force: z.boolean().optional(),
});
export type GitDeleteBranchInput = z.infer<typeof GitDeleteBranchSchema>;

/* ── Git branch merge ── */

/** Input for `git.mergePreview` / `git.merge`: merge `source` INTO the
 *  currently checked-out branch (HEAD). `source` may be a local branch, a
 *  remote-tracking ref (`origin/foo`) or any safe ref — same charset
 *  restriction as `GitCheckoutSchema.branch`. The merge direction is fixed
 *  (source → current branch) so the UI can always state it unambiguously. */
export const GitMergeSchema = z.object({
  repoPath: z.string(),
  source: z.string().regex(/^[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref"),
});
export type GitMergeInput = z.infer<typeof GitMergeSchema>;

/** Preview of a pending merge, computed WITHOUT touching the working tree
 *  (a single `git rev-list --left-right --count HEAD...source`). Feeds the
 *  confirm dialog: how many commits would come in, whether the merge would
 *  fast-forward, and whether it would be a no-op. */
export interface GitMergePreviewResult {
  ok: boolean;
  error?: string;
  /** True when HEAD already contains every commit of `source` — nothing to do. */
  upToDate: boolean;
  /** True when the merge can fast-forward (HEAD has no commits `source` lacks). */
  fastForward: boolean;
  /** Commits reachable from `source` but not from HEAD. */
  incomingCommits: number;
}

/** Result of `git.merge`. Mirrors `GitOpResult`'s conflict shape (pull parity)
 *  and adds merge-specific metadata for the UI's post-merge feedback. */
export interface GitMergeResult {
  ok: boolean;
  error?: string;
  /** Set when the merge stopped with conflicts. The repo is left in a merging
   *  state (MERGE_HEAD present); `git.mergeAbort` can unwind it to the
   *  pre-merge state. */
  conflict?: boolean;
  conflictedFiles?: string[];
  /** True when HEAD already contained everything (no merge was executed). */
  upToDate?: boolean;
  /** True when the merge fast-forwarded (no merge commit was created). */
  fastForward?: boolean;
}

/* ── Git worktrees (isolated agent sessions) ──
 *  Minimal single-direction lifecycle: a "worktree" session materializes a
 *  DETACHED checkout (no branch — git forbids one branch checked out in two
 *  worktrees, and branch naming is a user-level decision deferred to merge
 *  time), works in isolation, then merges its HEAD commit back into the
 *  local checkout's current branch and is removed. Worktrees live under a
 *  managed root (userData/worktrees/<repo>/<sessionId>) OUTSIDE every
 *  registered project root, so the project-scoped path guards never see
 *  them and the isolation boundary rides on the per-turn cwd alone. */

/** One linked checkout in a `git.worktreeList` result (main worktree
 *  included as the first entry, `main: true`, so the UI can state the
 *  merge-back target). */
export interface GitWorktreeInfo {
  /** Absolute path of the worktree directory. */
  path: string;
  /** Abbreviated HEAD commit hash (merge-back source; empty when missing). */
  head: string;
  /** Checked-out branch short name; "" for detached worktrees. Populated for
   *  branch-style worktrees (generated `mcode/*` refs). */
  branch: string;
  /** True for the repository's main worktree (the original checkout). */
  main: boolean;
  /** True when the worktree has uncommitted changes. */
  dirty: boolean;
  /** True when the directory no longer exists on disk (prunable). */
  missing: boolean;
  /** How many sessions reference this path as their worktreePath. Zero =
   *  orphan (its session was deleted) — safe to clean up. */
  referencedBy: number;
  /** True when NOTHING is left to merge: the worktree's HEAD is already
   *  contained in the MAIN worktree's HEAD AND the tree is clean. The
   *  ancestor probe alone is trivially true until someone commits inside
   *  the worktree (it detaches at the main HEAD; agents edit without
   *  committing), so a dirty tree must NOT read as merged — safe to clean
   *  up only when both hold. */
  merged: boolean;
}

export const GitWorktreeListSchema = z.object({
  /** The repo to list worktrees of. Any worktree of the repo works. */
  repoPath: z.string(),
});
export type GitWorktreeListInput = z.infer<typeof GitWorktreeListSchema>;

/** Single-worktree probe — the cheap variant `git.worktreeStatus` serves to
 *  pollers that only care about ONE tree (the Titlebar merge button): same
 *  enrichment semantics as the list, but one status probe instead of one
 *  per linked worktree. Null status = not a registered worktree. */
export const GitWorktreeStatusSchema = z.object({
  repoPath: z.string(),
  worktreePath: z.string(),
});
export type GitWorktreeStatusInput = z.infer<typeof GitWorktreeStatusSchema>;

/** Merge a worktree's work back into the local checkout's CURRENT branch.
 *  Orchestrated server-side: dirty worktree → auto-commit on its detached
 *  HEAD → `git merge --no-edit <worktree HEAD>` in the local repo. */
export const GitWorktreeMergeBackSchema = z.object({
  repoPath: z.string(),
  worktreePath: z.string(),
  /** Commit message for the pre-merge auto-commit of uncommitted worktree
   *  changes. Optional — blank/absent falls back to the built-in default
   *  ("worktree: auto-commit before merge back (<dir>)"). */
  message: z.string().optional(),
});
export type GitWorktreeMergeBackInput = z.infer<typeof GitWorktreeMergeBackSchema>;

export interface GitWorktreeMergeBackResult {
  ok: boolean;
  error?: string;
  /** True when the worktree had uncommitted changes that were auto-committed
   *  on its detached HEAD before merging. */
  committedChanges?: boolean;
  /** The local branch the merge landed on (for the UI's result message). */
  targetBranch?: string;
  /** True when the merge fast-forwarded (no merge commit). */
  fastForward?: boolean;
  /** Set when the merge stopped with conflicts — the local repo is left in a
   *  merging state; the existing conflict-resolution UI applies. */
  conflict?: boolean;
  conflictedFiles?: string[];
}

export const GitWorktreeRemoveSchema = z.object({
  repoPath: z.string(),
  worktreePath: z.string(),
  /** Skip the uncommitted-changes check and pass --force. */
  force: z.boolean().optional(),
  /** Before removing, persist the worktree's FULL unmerged work (commits
   *  since the merge-base with the main HEAD, plus uncommitted edits) as a
   *  binary patch under userData/worktree-snapshots/ (last-resort recovery
   *  for discarded work). `patchPath` in the result tells the user where it
   *  went. */
  exportPatch: z.boolean().optional(),
});
export type GitWorktreeRemoveInput = z.infer<typeof GitWorktreeRemoveSchema>;

export interface GitWorktreeRemoveResult {
  ok: boolean;
  error?: string;
  /** Absolute path of the exported patch, when exportPatch was requested
   *  and succeeded. */
  patchPath?: string;
  /** Set when the worktree ran on a generated `mcode/*` branch that could
   *  NOT be auto-deleted (typically a forced removal of an unmerged tree —
   *  `git branch -d` refuses, by design). The branch is RETAINED as the
   *  recovery path for the discarded commits; surface it to the user. */
  retainedBranch?: string;
}

/* ── Skill discovery (composer slash-command menu) ──
 *  The composer's `/` menu lists skills discovered by scanning the local
 *  filesystem (`~/.claude/skills/` global + `<project>/.claude/skills/`
 *  project-scoped). Each skill's SKILL.md frontmatter supplies the name +
 *  description; we don't depend on a running SDK session for the listing, so
 *  the menu is instant. Selecting a skill inserts `/name` into the textarea
 *  and the user sends it as a normal turn (SDK is started with
 *  `skills: "all"`, so the agent recognizes and runs the skill). */

/** Where a composer skill was discovered. "plugin" = contributed by an
 *  ENABLED plugin (read-only inventory: the composer menu lists it and the
 *  SDK loads it per-turn, but it has no user-editable file root — the skills
 *  read/save/delete handlers reject this source). "builtin" = shipped inside
 *  the app itself (the document skills; see main/plugins/builtinPlugins.ts) —
 *  same read-only posture as "plugin", but it survives with no plugins
 *  installed at all, so the UI labels it 「内置」 rather than by plugin name. */
export const SKILL_READ_SOURCES = ["global", "project", "plugin", "builtin"] as const;
export type SkillSource = (typeof SKILL_READ_SOURCES)[number];

/** Sources a skill can be WRITTEN to — the two the user owns. Contributed
 *  skills are replaced by a plugin update or an app upgrade, never by this
 *  editor, so save/delete reject them at the schema level (not just in the
 *  handler), and the UI hides the buttons. */
export const SKILL_WRITE_SOURCES = ["global", "project"] as const;

/** The sources that have no user-editable file root. Kept as one exported
 *  alias so the renderer's editor type and the main-side read/save/delete
 *  guard can never drift apart on which sources are read-only. */
export type ReadOnlySkillSource = Extract<SkillSource, "plugin" | "builtin">;

/** One registered AI backend surfaced to the renderer via `provider.list`.
 *  The capabilities descriptor drives which composer chips / dropdown entries
 *  the UI renders for a given provider (declarative capability negotiation). */
export interface ProviderInfo {
  /** Provider id, e.g. "claude-sdk" / "pi-sdk". Persisted in Session.providerId. */
  id: string;
  /** Human-readable name for the provider picker. */
  displayName: string;
  capabilities: ProviderCapabilities;
}

/** One discoverable skill surfaced in the composer `/` menu. Mirrors the
 *  fields the SDK's own `SlashCommand` exposes (name / description /
 *  argumentHint) plus a `source` discriminator so the UI can show whether a
 *  skill came from the user's global dir or the active project. */
export interface SkillInfo {
  /** Skill name without the leading slash (e.g. "pdf"). Used as the slash
   *  command the user sends, and as the dedupe key (project overrides global). */
  name: string;
  /** Short description from SKILL.md frontmatter (may be empty when absent). */
  description: string;
  /** Hint for skill arguments (e.g. "<file>"), when present in frontmatter. */
  argumentHint?: string;
  /** Where the skill was discovered: user-global vs the active project. */
  source: SkillSource;
}

/** List skills for a project root. `projectPath` must match a persisted
 * Project.path (main cross-checks, same containment guard as file ops); it is
 * optional — when omitted, only the user-global root (~/.mcode/skills) is
 * scanned (the settings panel's "no projects yet" state still lists global
 * skills). */
export const SkillsListSchema = z.object({
  projectPath: z.string().optional(),
});
export type SkillsListInput = z.infer<typeof SkillsListSchema>;

/** Skill name charset — kebab-case-ish identifiers only. Restricting here
 *  (and again in main with pathWithin) prevents path-traversal via `../` or
 *  absolute paths. Matches what the SDK / Claude Code itself accepts. */
/** Skill name charset — also enforced per-item by the import handler (main
 *  imports this), since SkillsImportItemSchema deliberately does NOT regex-check
 *  the name (a scan result may carry an arbitrary display name; a bad one must
 *  fail just that item, not the whole batch via a zod parse error). */
export const SKILL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Read one skill's full SKILL.md source. Returns the complete file text (no
 *  truncation — skills can be large). A missing file resolves to empty
 *  content so the editor opens cleanly for a not-yet-written skill.
 *  `projectPath` is only required for `source: "project"` (it must match a
 *  persisted Project.path); global skills resolve without it. */
export const SkillsReadSchema = z.object({
  /** Project root (must match a persisted Project.path). Only used to verify
   *  the caller's identity when source is "project"; the skill itself is
   *  resolved by `source` + `name`. */
  projectPath: z.string().optional(),
  /** Which skills root to read from. Wider than the write schemas below:
   *  contributed skills (enabled plugins + the built-in plugin) have no
   *  writable root but ARE readable — the settings panel shows a built-in
   *  skill's SKILL.md read-only. */
  source: z.enum(SKILL_READ_SOURCES),
  /** Skill name (= directory name under <root>/.claude/skills/). */
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
});
export type SkillsReadInput = z.infer<typeof SkillsReadSchema>;

/** Write (create or overwrite) a skill's SKILL.md. Creates the skill directory
 *  if absent; always writes the full file content (complete overwrite).
 *  `newName` is reserved for future rename support (when set and differs from
 *  `name`, the skill directory is moved first); v1 UI leaves it unset.
 *  `projectPath` is only required for `source: "project"`; a global skill can
 *  be created even when no project exists at all (settings panel's
 *  "no projects yet" state). */
export const SkillsSaveSchema = z.object({
  projectPath: z.string().optional(),
  source: z.enum(SKILL_WRITE_SOURCES),
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
  /** Full SKILL.md text (frontmatter + body). Written verbatim. */
  content: z.string(),
  newName: z.string().regex(SKILL_NAME_RE).optional(),
});
export type SkillsSaveInput = z.infer<typeof SkillsSaveSchema>;

/** Delete a skill directory. For a symlinked skill only the link is removed
 *  (the target - e.g. a gstack checkout - is left intact); for a real
 *  directory the whole skill folder is removed recursively. `projectPath` is
 *  only required for `source: "project"`. */
export const SkillsDeleteSchema = z.object({
  projectPath: z.string().optional(),
  source: z.enum(SKILL_WRITE_SOURCES),
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
});
export type SkillsDeleteInput = z.infer<typeof SkillsDeleteSchema>;

/* ── Skill import (settings panel) ──
 *  The settings panel's "Import" feature scans external skill directories
 *  (Claude Code ~/.claude/skills, Codex ~/.codex/skills, Zcode ~/.agents/skills
 *  + ~/.zcode/skills + plugin cache) and lets the user pick which skills to
 *  copy into Mcode's own global skills dir (~/.mcode/skills). This makes
 *  user-level skills available even under custom endpoints, where the SDK
 *  normally can't load them from ~/.claude/skills. */

/** Which external tool a scanned skill originated from. `"local"` covers skills
 *  discovered in an arbitrary user-picked local directory (the import dialog's
 *  "select folder" flow), as opposed to a known tool's install location. */
export type SkillTool = "claude-code" | "codex" | "zcode" | "local";

/** A skill discovered in an external tool's skill directory, available for
 *  import into Mcode's own ~/.mcode/skills. Carries the source directory's
 *  absolute path so the import handler can copy it without re-resolving. */
export interface ExternalSkillInfo {
  /** Skill name (from frontmatter, falling back to directory name). */
  name: string;
  /** Short description from SKILL.md frontmatter (may be empty). */
  description: string;
  /** Which external tool this skill was found in. */
  tool: SkillTool;
  /** Absolute path to the skill directory in the external tool's tree. */
  sourcePath: string;
}

/** Scan external tools' skill directories and return all discoverable skills.
 *  When `localDir` is provided, also scans that user-picked directory:
 *  if it directly contains a SKILL.md it is treated as a single skill,
 *  otherwise each SKILL.md-bearing subdirectory is treated as a skill (same
 *  rule as scanning a tool's skills root). When `localFile` is provided, that
 *  user-picked single markdown file is treated as one single-file skill (its
 *  frontmatter/`name` or file stem names the skill; importing materializes it
 *  as <name>/SKILL.md). Both picks are independent and may be combined.
 *  Always resolves (degrades to an empty list on any IO error). */
export const SkillsScanSourcesSchema = z.object({
  /** Optional: a user-picked local directory to scan in addition to the fixed
   *  external tool dirs. Used by the import dialog's "select folder" flow. */
  localDir: z.string().optional(),
  /** Optional: a user-picked single skill file (.md/.markdown) to import as a
   *  one-file skill. Used by the import dialog's "select file" flow. */
  localFile: z.string().optional(),
});
export type SkillsScanSourcesInput = z.infer<typeof SkillsScanSourcesSchema>;

/** A single skill to import: the source directory OR single file (from a scan
 *  result) and the name to use as the destination directory under
 *  ~/.mcode/skills. The name is validated per-item by the handler (regex),
 *  not here — one un-importable skill must not reject the whole batch. */
export const SkillsImportItemSchema = z.object({
  /** Absolute path to the source skill directory or file (from a scanSources
   *  result). */
  sourcePath: z.string(),
  /** Destination skill name (directory name under ~/.mcode/skills). */
  name: z.string().min(1),
});

/** Import (copy) selected skills from external tools into ~/.mcode/skills.
 *  Skills that already exist at the destination are skipped (not overwritten).
 *  Returns per-skill success/skip/error so the UI can report precisely. */
export const SkillsImportSchema = z.object({
  skills: z.array(SkillsImportItemSchema),
});
export type SkillsImportInput = z.infer<typeof SkillsImportSchema>;

/* ── Output style (settings panel) ──
 *  Claude sessions can run with a different "output style" — the CLI rewrites
 *  its system prompt to change HOW the model responds (default / Explanatory /
 *  Learning / Proactive / Concise, plus user-defined markdown styles). The SDK
 *  exposes this as `Settings.outputStyle` (NOT a top-level Options field) and
 *  offers no runtime switch control request, so the selection is persisted
 *  here and injected per-turn by the Claude provider. Changes therefore apply
 *  on the NEXT turn (same contract as the MCP panel). Pi sessions do not
 *  support output styles. */

/**
 * Setting key under which the selected output style name is persisted.
 * Value = the exact style name the CLI matches on: a built-in id
 * ("default" | "Explanatory" | "Learning" | "Proactive" | "Concise") or the
 * frontmatter `name` of a custom style in ~/.mcode/output-styles/*.md.
 * Empty/null = never configured → nothing injected (CLI default behavior).
 */
export const AGENT_OUTPUT_STYLE_SETTING_KEY = "agent.outputStyle";

/** Which source a listed output style comes from. */
export type OutputStyleSource = "builtin" | "user";

/** One row of the settings panel's output-style list. `id` is the value to
 *  persist under AGENT_OUTPUT_STYLE_SETTING_KEY. `description` is only set
 *  for user styles (verbatim frontmatter text — user content, not localized);
 *  built-in descriptions are i18n'd renderer-side by id. */
export interface OutputStyleEntry {
  id: string;
  source: OutputStyleSource;
  description?: string;
}

/** List selectable output styles (built-ins gated by the bundled CLI version
 *  + user styles scanned from ~/.mcode/output-styles). */
export const OutputStyleListSchema = z.object({});
export type OutputStyleListInput = z.infer<typeof OutputStyleListSchema>;

/* ── MCP management (settings panel) ──
 *  The settings panel's "MCP" section lists three MCP server sources and lets
 *  the user toggle, add, remove and import them:
 *   - user scope: the `mcpServers` object of ~/.mcode/.claude.json — Mcode's
 *     redirected Claude config root (CLAUDE_CONFIG_DIR). The claude binary
 *     loads these automatically (settingSources default includes "user"), so
 *     the file is the source of truth; disabling a server moves its config
 *     out of the file into the management-state stash below, which is what
 *     keeps the binary from loading it.
 *   - project scope: <projectRoot>/.mcp.json (read-only, never rewritten).
 *     The CLI's native first-use approval dialog can't surface through our
 *     onUserDialog bridge (unknown kinds get cancelled), so this panel
 *     replaces it: project servers default to OFF and are recorded here when
 *     explicitly enabled; the provider passes per-turn
 *     enabledMcpjsonServers / disabledMcpjsonServers accordingly.
 *   - builtin: the in-process "mcode-browser" server injected by the Claude
 *     provider each turn; toggling gates that injection. */

/** Setting key for the persisted MCP management state.
 *  Value = JSON.stringify(McpManagementState). */
export const MCP_MANAGEMENT_SETTING_KEY = "mcp.management";

/** Serializable MCP server config shapes, mirroring the Claude Agent SDK's
 *  McpStdioServerConfig / McpHttpServerConfig / McpSSEServerConfig. Transport
 *  fields only; exotic fields (timeout, tools, ...) survive import round-trips
 *  via passthrough. Absent `type` means stdio, same as the SDK. */
export const McpServerConfigSchema = z.union([
  z
    .object({
      type: z.literal("stdio").optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("http"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("sse"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/** Persisted MCP management state (MCP_MANAGEMENT_SETTING_KEY). */
export interface McpManagementState {
  /** Built-in mcode-browser server disabled. Absent/false = enabled. */
  browserDisabled?: boolean;
  /** User-scope servers the user turned OFF. Their full configs are stashed
   *  here (keyed by name) so re-enabling restores them exactly; the config
   *  file meanwhile stays free of them, which is what keeps the binary from
   *  loading them. */
  userDisabled?: Record<string, McpServerConfig>;
  /** Project .mcp.json servers the user explicitly turned ON. Project servers
   *  default to OFF (this panel replaces the CLI's first-use approval dialog),
   *  so an allowlist — not a denylist — is persisted. Matched against the
   *  turn's cwd at startTurn. */
  projectEnabled?: Array<{ projectPath: string; name: string }>;
}

/** Which source a listed MCP server comes from. "plugin" = contributed by an
 *  enabled plugin (namespaced `<plugin>__<server>`); toggling it flips the
 *  per-server entry on the plugins.mcpDisabled list without touching the
 *  plugin's own enable state. */
export type McpScope = "user" | "project" | "builtin" | "plugin";

/** Transport kind shown in the panel badges; "builtin" = in-process server. */
export type McpKind = "stdio" | "http" | "sse" | "builtin";

/** One row of the MCP panel's server list. `detail` is a secret-free summary
 *  ("node server.js --foo" / "https://example.com/mcp") — env and header
 *  values are never included. */
export interface McpServerEntry {
  name: string;
  scope: McpScope;
  kind: McpKind;
  detail: string;
  enabled: boolean;
  /** Remote (http/sse) server that requires an OAuth login and holds no
   *  usable token, so its tools stay unavailable until the user completes the
   *  browser login — surfaced as an amber badge + a 去授权 action.
   *
   *  Two sources: the CLI's mcp-needs-auth-cache.json (written on an actual
   *  401 while connecting) and a proactive probe of the endpoint, so the entry
   *  appears before the first turn stumbles into it. Beats `authorized`. */
  needsAuth?: boolean;
  /** Remote server holding a stored OAuth token (the CLI's credential store —
   *  `.credentials.json` on win/linux, the macOS Keychain on darwin). Shows an
   *  "authorized" badge + a sign-out action in the panel. Mutually exclusive
   *  with needsAuth, and loses to it: needsAuth is written on a real 401 while
   *  connecting, so a stored token the runtime can't use (wrong credential
   *  key, expired, revoked) must not mask an unauthenticated server. */
  authorized?: boolean;
}

/** List MCP servers for the settings panel. `projectPath` scopes the project
 *  .mcp.json group and must match a persisted Project.path when present; the
 *  group is simply omitted when absent. */
export const McpListSchema = z.object({
  projectPath: z.string().optional(),
});
export type McpListInput = z.infer<typeof McpListSchema>;

/** Toggle a server. `projectPath` is required for scope "project". Scope
 *  "plugin" toggles one plugin-contributed server (plugins.mcpDisabled). */
export const McpToggleSchema = z.object({
  name: z.string().min(1),
  scope: z.enum(["user", "project", "builtin", "plugin"]),
  projectPath: z.string().optional(),
  enabled: z.boolean(),
});
export type McpToggleInput = z.infer<typeof McpToggleSchema>;

/** Run the OAuth browser login for a remote (http/sse) MCP server via the
 *  Claude CLI (`claude mcp login`). The server is registered under exactly
 *  `name` (the namespaced `<plugin>__<server>` form for plugin servers) for
 *  the duration of the flow and restored afterwards; the token itself persists
 *  in the CLI's credential store.
 *
 *  `url`/`kind` are only a fallback identity. The CLI keys OAuth credentials by
 *  a hash of the server NAME plus its `{ type, url, headers }`, so the main
 *  process resolves the server's real config by name across every source
 *  (user file / disable stash / plugin / project .mcp.json) and re-registers it
 *  verbatim — headers included. Registering a stripped config would store the
 *  token under a key the per-turn injected server never looks up. */
export const McpAuthorizeSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  kind: z.enum(["http", "sse"]),
  /** Source the clicked row came from. Scopes the main-side config lookup so a
   *  name shared by two sources (a user and a project server both called
   *  "github") resolves to the config that row actually points at — picking the
   *  other one's url/headers would file the token under a key the server never
   *  looks up. */
  scope: z.enum(["user", "project", "builtin", "plugin"]).optional(),
  /** Project whose .mcp.json the row came from (scope "project"). */
  projectPath: z.string().optional(),
});
export type McpAuthorizeInput = z.infer<typeof McpAuthorizeSchema>;

/** Clear the stored OAuth token (`claude mcp logout`). Same identity shape as
 *  authorize — the CLI resolves the server from the config file and keys the
 *  credentials by name + url + headers, so the same real-config registration
 *  applies. */
export const McpUnauthorizeSchema = McpAuthorizeSchema;
export type McpUnauthorizeInput = McpAuthorizeInput;

/** MCP server name charset — same family as skill names (letters, digits,
 *  underscore, hyphen). The name becomes a JSON object key, not a path, but
 *  staying conservative costs nothing. */
const MCP_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Reserved server name — collides with the built-in in-process server. */
export const MCP_RESERVED_NAME = "mcode-browser";

/**
 * 应用自带的两个**骨干** MCP 服务器(库操作 / 工作流操作)的注册名。
 *
 * 它们的定义放在契约层而不是各自的主进程文件里,是因为**渲染端也要认这两个名字**:
 * 工作流节点的「MCP 服务器」参数要把它们从候选表里滤掉(见 `NODE_MCP_PARAM_KEY`)——
 * 它们不是用户装的东西,始终挂着,列出来只会让人以为自己关得掉。名字有两份定义就会
 * 漂移,而漂移的表现是"那个服务器又能被选了,选了却不生效"。
 *
 * `mcp/libraryServer.ts` 与 `mcp/mcodeServer.ts` 各自 export 一个同名常量指向这里,
 * 主进程那一侧的既有引用不必改。
 */
export const MCP_LIBRARY_SERVER = "mcode-library";
export const MCP_WORKFLOW_SERVER = "mcode-workflow";

/** 骨干服务器名的清单 —— 「始终挂着、不进候选表」的那一组。 */
export const MCP_ALWAYS_ON_SERVERS = [MCP_LIBRARY_SERVER, MCP_WORKFLOW_SERVER] as const;

/** Add a user-scope server. Rejected when the name already exists (enabled in
 *  the config file or stashed as disabled). The config is written into
 *  ~/.mcode/.claude.json. */
export const McpSaveSchema = z.object({
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
  config: McpServerConfigSchema,
});
export type McpSaveInput = z.infer<typeof McpSaveSchema>;

/** Remove a user-scope server — from both the config file and the disabled
 *  stash (whichever holds it). Project/builtin entries have no delete. */
export const McpRemoveSchema = z.object({
  name: z.string().regex(MCP_NAME_RE, "invalid MCP server name"),
});
export type McpRemoveInput = z.infer<typeof McpRemoveSchema>;

/** A server discovered in the local Claude CLI config (~/.claude.json),
 *  offered by the import dialog. `origin` labels where it came from: the
 *  global scope or the project path it was configured for. */
export interface McpImportSource {
  name: string;
  kind: McpKind;
  detail: string;
  origin: string;
  config: McpServerConfig;
}

/** Scan the local Claude CLI config for importable MCP servers. Read-only;
 *  never writes to ~/.claude.json. */
export const McpScanImportSchema = z.object({});
export type McpScanImportInput = z.infer<typeof McpScanImportSchema>;

/** A single server to import (name + full config, from a scanImport result). */
export const McpImportItemSchema = z.object({
  name: z.string().min(1),
  config: McpServerConfigSchema,
});

/** Import selected servers into the user scope (Mcode's own config file).
 *  Already-existing names are skipped. Returns per-server lists. */
export const McpImportSchema = z.object({
  servers: z.array(McpImportItemSchema),
});
export type McpImportInput = z.infer<typeof McpImportSchema>;

/* ── Usage stats (settings panel) ──
 *  Aggregates the per-turn usage history persisted on each session row
 *  (`sessions.usage_history`, one TurnUsageRecord per completed turn) into
 *  daily / per-model / summary views. Read-only. */

/** Time ranges offered by the usage panel. `today` starts at local midnight;
 *  `7d` / `30d` span N-1 midnights back from today (today inclusive);
 *  `all` covers everything. */
export const USAGE_STATS_PRESETS = ["today", "7d", "30d", "all"] as const;
export type UsageStatsPreset = (typeof USAGE_STATS_PRESETS)[number];

export const UsageStatsSchema = z.object({
  preset: z.enum(USAGE_STATS_PRESETS),
});
export type UsageStatsInput = z.infer<typeof UsageStatsSchema>;

/** Per-day aggregate. `date` is the LOCAL calendar day as YYYY-MM-DD —
 *  "today" must mean the user's today, not UTC's. */
export interface UsageDayStat {
  date: string;
  turns: number;
  totalTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Per-model aggregate over the selected range, keyed by (vendor, model):
 *  the same model name from different vendors (e.g. "deepseek-v4-flash" via
 *  the official API vs a gateway) must not be lumped together.
 *  `model: null` groups turns whose record carried no model id. */
export interface UsageModelStat {
  /** Vendor/endpoint label the turns ran under: "Anthropic" for the built-in
   *  Claude path, the custom-model config's user-chosen name for a gateway
   *  endpoint, "Pi" for Pi-agent sessions. null = unknown (e.g. the binding
   *  config was deleted). */
  vendor: string | null;
  model: string | null;
  turns: number;
  totalTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** Range totals over the selected range. */
export interface UsageSummaryStat {
  turns: number;
  /** Distinct sessions that contributed at least one turn in the range. */
  sessions: number;
  totalTokens: number;
  /** Tokens attributed to Task-tool subagents (main-loop tokens excluded —
   *  see TurnUsageRecord.subagentTokens). Not attributed per model. */
  subagentTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

/** `usage.stats` response. `summary` / `models` aggregate the selected range;
 *  `daily` always covers the last 183 days (26 weeks, today inclusive) so the
 *  heatmap can render a fixed half-year grid regardless of the preset. */
export interface UsageStatsResult {
  summary: UsageSummaryStat;
  models: UsageModelStat[];
  daily: UsageDayStat[];
}

/* ──────────────────────────  Main → Renderer (events)  ─────────────────────── */

/* ── Language servers (LSP) ──
 *  Each language has an installable, toggleable language server (TS/JS,
 *  Python, Go, Java). Servers run in the main process as stdio JSON-RPC
 *  children; the renderer talks to them via the `lsp.*` RPC namespace and
 *  receives diagnostics/logs/state changes over the `lsp:event` push channel.
 *  Monaco providers (definition/references/hover) in the renderer call
 *  `lsp.request` to forward LSP method calls; document sync goes through
 *  `lsp.openDocument` / `lsp.didChange` / `lsp.didSave` / `lsp.closeDocument`. */

/** Setting key for the persisted LSP server config list.
 *  Value = JSON.stringify(LspServerConfig[]). */
export const LSP_SERVERS_SETTING_KEY = "lsp.servers";

/** Languages with first-class LSP support. The enum is reused across every
 *  LSP schema so the renderer, preload, and main share one vocabulary. */
export const LspLanguageSchema = z.enum(["typescript", "python", "go", "java"]);
export type LspLanguageId = z.infer<typeof LspLanguageSchema>;

/** A single language's persisted configuration. Stored as a JSON array under
 *  LSP_SERVERS_SETTING_KEY. Missing entries default to { enabled: false }. */
export interface LspServerConfig {
  language: LspLanguageId;
  enabled: boolean;
  /** User override for the server executable. Empty/absent -> auto-detect via
   *  PATH lookup (which/where). */
  serverPath?: string;
  /** Extra CLI args appended after the server's stdio flag. Advanced. */
  args?: string[];
  /** Java only: path to a JDK 17+ home (JAVA_HOME) used to RUN jdtls. This is
   *  independent of the project's JDK -- jdtls needs Java 17+ to run even when
   *  the project itself targets Java 8. Empty/absent -> use system java. */
  javaHome?: string;
}

/** Generic success/failure result for install/stop/health operations. */
export interface LspOpResult {
  ok: boolean;
  error?: string;
}

/** Snapshot of one language's state, sent to the renderer by `lsp.list`. The
 *  renderer treats this as read-only display data. */
export interface LspLanguageState {
  language: LspLanguageId;
  enabled: boolean;
  /** Whether the server binary was found on disk (PATH or custom path). */
  installed: boolean;
  /** Resolved server path (or null if not found). */
  serverPath: string | null;
  /** Whether a server process is currently alive for this language (any
   *  workspace). */
  running: boolean;
  /** Whether an install/uninstall is currently in progress. */
  installing: boolean;
  /** Tail of the most recent install/uninstall output (truncated). */
  installLog: string;
  /** Last error from a failed server start (stderr summary). Empty when the
   *  server is running fine. Shown in the settings panel so the user knows
   *  WHY the server won't start (e.g. "jdtls requires at least Java 21"). */
  lastError: string;
}

/** `lsp:event` stateChanged payload: the language-server lifecycle for one
 *  (workspacePath, language). Emitted at every phase transition so the
 *  renderer can show startup progress in the editor toolbar. `stopped` after
 *  a failed start carries the reason in `error`. */
export interface LspStateChangedPayload {
  /** "starting" = spawned, initialize handshake in flight (can take minutes
   *  for Java); "running" = initialize done; "stopped" = exited/failed;
   *  "importing" = (Java) initialize done but jdtls is still importing the
   *  project — requests queue behind the import job, so the editor should
   *  explain the wait instead of showing a generic running state. */
  phase: "starting" | "running" | "stopped" | "importing";
  /** Boolean view of the phase (running === phase === "running"), kept for
   *  consumers that only care whether the server is usable. */
  running: boolean;
  /** Failure reason when the server couldn't start (phase "stopped"). */
  error?: string;
  /** Human-readable progress detail for the phase — jdtls reports live
   *  import progress ("24% · Importing project welfare-service") on every
   *  language/status update while importing. */
  detail?: string;
}

/** A diagnostic pushed from the server via publishDiagnostics. Mirrors LSP
 *  Diagnostic (0-based line/character). */
export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** 1=Error, 2=Warning, 3=Information, 4=Hint. */
  severity: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
}

// -- RPC input schemas --

export const LspListSchema = z.object({});
export type LspListInput = z.infer<typeof LspListSchema>;

export const LspInstallSchema = z.object({ language: LspLanguageSchema });
export type LspInstallInput = z.infer<typeof LspInstallSchema>;

/** Install from a user-downloaded archive (tar.gz/zip) or binary. Used when
 *  the package-manager install fails due to network issues -- the user
 *  downloads the file manually via the download-page button, then selects it
 *  here. For Java the archive is extracted into userData/lsp/java; for other
 *  languages the file/binary path is recorded as a custom serverPath. */
export const LspInstallFromFileSchema = z.object({
  language: LspLanguageSchema,
  /** Absolute path to the user-selected file (archive or binary). */
  archivePath: z.string().min(1),
});
export type LspInstallFromFileInput = z.infer<typeof LspInstallFromFileSchema>;

export const LspUninstallSchema = z.object({ language: LspLanguageSchema });
export type LspUninstallInput = z.infer<typeof LspUninstallSchema>;

export const LspToggleSchema = z.object({
  language: LspLanguageSchema,
  enabled: z.boolean(),
});
export type LspToggleInput = z.infer<typeof LspToggleSchema>;

export const LspSetPathSchema = z.object({
  language: LspLanguageSchema,
  serverPath: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** Java only: override the JDK used to run jdtls (JAVA_HOME). */
  javaHome: z.string().optional(),
});
export type LspSetPathInput = z.infer<typeof LspSetPathSchema>;

export const LspHealthCheckSchema = z.object({ language: LspLanguageSchema });
export type LspHealthCheckInput = z.infer<typeof LspHealthCheckSchema>;

/** Pre-warm a workspace's Java server: spawn it (and thus start the one-time
 *  Maven/Gradle project import) WITHOUT waiting for the user to open a Java
 *  file. Called when a project becomes active so the import runs while the
 *  user browses instead of blocking their first openDocument. Fire-and-forget
 *  semantics; idempotent (a live server is reused, never restarted). */
export const LspPrewarmSchema = z.object({
  /** Project root to pre-warm (must be a known project). */
  workspacePath: z.string(),
});
export type LspPrewarmInput = z.infer<typeof LspPrewarmSchema>;

/** Restart a language server for one workspace. Unlike a toggle-off/on this
 *  immediately relaunches (with the crash-loop guard cleared) so the editor's
 *  startup pill visibly goes starting → running/stopped. */
export const LspRestartSchema = z.object({
  /** Project root the server was started for (must be a known project). */
  workspacePath: z.string(),
  language: LspLanguageSchema,
});
export type LspRestartInput = z.infer<typeof LspRestartSchema>;

export const LspOpenDocSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  language: LspLanguageSchema,
});
export type LspOpenDocInput = z.infer<typeof LspOpenDocSchema>;

export const LspCloseDocSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
});
export type LspCloseDocInput = z.infer<typeof LspCloseDocSchema>;

export const LspDidChangeSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  text: z.string(),
  version: z.number().int(),
});
export type LspDidChangeInput = z.infer<typeof LspDidChangeSchema>;

export const LspDidSaveSchema = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  text: z.string(),
});
export type LspDidSaveInput = z.infer<typeof LspDidSaveSchema>;

export const LspRequestSchema = z.object({
  workspacePath: z.string(),
  language: LspLanguageSchema,
  /** LSP method, e.g. "textDocument/definition". */
  method: z.string(),
  /** LSP params object (passed through verbatim). */
  params: z.unknown(),
});
export type LspRequestInput = z.infer<typeof LspRequestSchema>;

/** `lsp.request` returns either the LSP result or an error object. */
export type LspRequestResult =
  | { result: unknown }
  | { error: { code: number; message: string } };

/* ── Agent runtimes (download-on-demand) ──
 *  The claude / codex binaries and the pi JS runtime are NOT bundled with the
 *  installer (~600MB per platform); they live under userData/runtimes and are
 *  downloaded on demand from the npm registry. The settings panel lists one
 *  card per agent via `runtimes.list`; install/remove go through
 *  `runtimes.install` / `runtimes.remove`; live download/extract progress is
 *  pushed over the `runtimes:event` channel. The pinned expected version comes
 *  from this app's own package.json (see runtimeInstaller.ts). */

export const RuntimeAgentSchema = z.enum(["claude", "codex", "pi"]);
export type RuntimeAgentId = z.infer<typeof RuntimeAgentSchema>;

/** Where the provider currently loads a runtime from. "managed" = the
 *  on-demand install under userData/runtimes (what this panel installs);
 *  "dev" = node_modules of a development checkout (devDependencies / the
 *  SDK's platform optionalDependency — absent in packaged builds);
 *  "bundled" = a legacy build that still ships the payload in
 *  app.asar.unpacked. null = not available anywhere → the provider errors
 *  on use and the panel should offer the install button. */
export type RuntimeAgentSource = "managed" | "dev" | "bundled";

/** Snapshot of one agent runtime for the settings panel. Read-only display
 *  data; mutations happen through install/remove and are reflected by
 *  re-listing plus `runtimes:event` pushes. */
export interface RuntimeAgentState {
  agent: RuntimeAgentId;
  /** Version this Mcode build expects (pinned in package.json). */
  expectedVersion: string;
  /** Version installed under userData/runtimes, or null when absent. Note:
   *  a runtime can be USABLE without being installed here (see `source`). */
  installedVersion: string | null;
  /** Where the runtime is currently loaded from (see RuntimeAgentSource). */
  source: RuntimeAgentSource | null;
  /** Version of the copy the provider actually loads (= installedVersion
   *  when source is "managed", else the dev/bundled fallback's version).
   *  Null when nothing is usable. */
  activeVersion: string | null;
  /** Absolute path of the payload the provider actually loads (binary /
   *  package.json). Null when nothing is usable. */
  activePath: string | null;
  /** Latest version advertised by the registry, or null when the check
   *  hasn't run yet / failed (offline). Populated lazily by `runtimes.list`. */
  latestVersion: string | null;
  /** Whether a managed copy exists under userData/runtimes. */
  installed: boolean;
  /** The ACTIVE copy (managed, else dev/bundled fallback) differs from the
   *  version this Mcode build expects. Happens after the app itself
   *  updated; the panel offers an update. */
  updateAvailable: boolean;
  installing: boolean;
  /** Tail of the last install/remove error. Empty when healthy. */
  lastError: string;
  /** On-disk footprint of the managed install (bytes; 0 when absent). */
  diskBytes: number;
  /** Managed install location of the active version (display only). */
  installPath: string | null;
}

/** `runtimes:event` payload — coarse phase + fraction for one agent. */
export interface RuntimeProgressPayload {
  agent: RuntimeAgentId;
  phase: "downloading" | "extracting" | "done" | "error";
  /** 0..1 during "downloading"; -1 when Content-Length is unknown. */
  progress: number;
  /** Populated when phase === "error". */
  error?: string;
}

export interface RuntimeEventMessage {
  channel: "runtimes:event";
  payload: RuntimeProgressPayload;
}

/* ── 文档工具链(外部依赖)──
 *
 * 四个内置文档技能(docx / pptx / xlsx / pdf)本身随应用发布,但它们**要用的
 * 工具**不在应用里:pandoc、python 的若干包、zip、LibreOffice、poppler 都是
 * 机器级的东西。换一台干净电脑,技能在那里、工具不在,一到要读 Word 就失败,
 * 而且失败得莫名其妙。
 *
 * 这一节就是「设置 → 内核」里新加的那一块:检测 + 按需安装,与 agent 内核
 * (claude / codex / pi)同一套思路。
 *
 * ## 哪些能由应用装,哪些只能指路
 *
 * `pandoc` 是**单个自包含可执行文件**,下下来塞进 `<userData>/tools/` 就能用 ——
 * 不要管理员权限、不写系统目录、卸载应用即消失。`latex` 走 **TinyTeX**(TeX Live
 * 的轻量发行版):同样落在应用自己的工具目录里,同样不需要管理员 —— 值得说明的
 * 是它的 Windows 包虽然后缀是 `.exe`,但那是**自解压包**(官方脚本用 `-y` 调它,
 * 注释写的是 "unbundle"),只把 `TinyTeX/` 解开到当前目录,不写注册表、不改 PATH。
 * `python-deps` 正相反:包必须装进用户**已有的**解释器里,所以那一项是"检测 +
 * 调他的 pip",不搬运解释器本身。zip / LibreOffice / poppler 都是要管理员权限的
 * 系统级安装,只检测、给指引 —— 装不装由用户决定,应用不替他动系统。
 */

/** 有检测/安装意义的外部工具 —— 就是四个技能实际会调的那些(数过脚本里的
 *  subprocess 与 SKILL.md 里的命令),不是拍脑袋列的。 */
export const TOOLCHAIN_TOOL_IDS = [
  "pandoc",
  "latex",
  "python-deps",
  "zip-tools",
  "soffice",
  "pdftoppm",
] as const;
export type ToolchainToolId = (typeof TOOLCHAIN_TOOL_IDS)[number];

/** 这个工具是从哪儿被找到的。 */
export type ToolchainSource =
  /** 应用自己下载并管理的副本(在 `<userData>/tools/` 下)。 */
  | "managed"
  /** 用户机器上本来就有的(系统 PATH 上的可执行文件 / 他的 python)。 */
  | "system"
  /** 没找到。 */
  | "missing";

export interface ToolchainToolState {
  id: ToolchainToolId;
  /** 可用 = 下面 components 里每一项都找到了。 */
  ok: boolean;
  source: ToolchainSource;
  /** 主程序版本(pandoc --version 之类),拿不到就 null。 */
  version: string | null;
  /** 主程序的绝对路径(可执行文件 / python 解释器),展示用。 */
  path: string | null;
  /** 能不能由应用安装。false = 只检测并给出指引(zip / LibreOffice / poppler
   *  都是要管理员权限的系统级安装,装不装由用户决定)。 */
  installable: boolean;
  installing: boolean;
  /** 最近一次装/卸失败的尾巴。空 = 正常。 */
  lastError: string;
  /** 组成这个工具的可执行文件 / 宏包 / python 包,以及各自找到没有。
   *
   *  **名字是机器名**(`pandoc` / `unzip` / `openpyxl` / `ctex`),不是文案 ——
   *  主进程不负责措辞,渲染端按 zh/en 自己拼("缺 openpyxl、markitdown")。 */
  components: Array<{ name: string; found: boolean }>;
}

/** `toolchain:event` 载荷 —— 与 runtimes:event 同构,面板用同一套渲染。 */
export interface ToolchainProgressPayload {
  tool: ToolchainToolId;
  phase: "downloading" | "extracting" | "installing" | "done" | "error";
  /** 0..1(下载中);-1 表示 Content-Length 未知 / 该阶段没有进度。 */
  progress: number;
  error?: string;
}

export interface ToolchainEventMessage {
  channel: "toolchain:event";
  payload: ToolchainProgressPayload;
}


// -- RPC input schemas --

export const RuntimesListSchema = z.object({});
export type RuntimesListInput = z.infer<typeof RuntimesListSchema>;

export const RuntimesInstallSchema = z.object({ agent: RuntimeAgentSchema });
export type RuntimesInstallInput = z.infer<typeof RuntimesInstallSchema>;

/** Install from a user-picked LOCAL PATH. Escape hatch when the registry path
 *  fails: @mcode/runtime-pi not published yet, stale mirror, offline.
 *  Accepted: the agent's install directory (claude platform package dir /
 *  codex vendored package dir / pi meta-package dir with node_modules/), the
 *  agent binary file itself (claude/codex), or an npm-shaped .tgz. Mirrors
 *  `lsp.installFromFile` but path-based. */
export const RuntimesInstallLocalSchema = z.object({
  agent: RuntimeAgentSchema,
  /** Absolute local path (directory, binary, or .tgz). */
  localPath: z.string().min(1),
});
export type RuntimesInstallLocalInput = z.infer<typeof RuntimesInstallLocalSchema>;

export const RuntimesRemoveSchema = z.object({ agent: RuntimeAgentSchema });
export type RuntimesRemoveInput = z.infer<typeof RuntimesRemoveSchema>;

/* ── 文档工具链 RPC 入参 ── */

/** 安装/卸载一个工具。只有应用真能装的那几项会被接受 —— 下面这个 enum 就是那道
 *  门,handler 里不必再判一次。 */
export const ToolchainToolSchema = z.enum(TOOLCHAIN_TOOL_IDS);
export const ToolchainInstallSchema = z.object({ tool: ToolchainToolSchema });
export type ToolchainInstallInput = z.infer<typeof ToolchainInstallSchema>;

export const ToolchainRemoveSchema = z.object({ tool: ToolchainToolSchema });
export type ToolchainRemoveInput = z.infer<typeof ToolchainRemoveSchema>;

// `toolchain.check` **没有入参 schema** —— 它检测的是这台机器,不针对某个项目。

/* ── 工作流 RPC 入参 ── */

/** 取一份完整工作流(含 nodes / edges)。画布编辑器打开某一项时才调。 */
export const WorkflowGetSchema = z.object({ id: z.string().min(1) });
export type WorkflowGetInput = z.infer<typeof WorkflowGetSchema>;

/** 存一份工作流。`workflow.id` 就是主键 —— 对内置 id 来说,存进去就是**覆盖它的
 *  默认版**(所以内置工作流可以直接改);「恢复默认」= 删掉那条覆盖。 */
export const WorkflowSaveSchema = z.object({ workflow: WorkflowDocSchema });
export type WorkflowSaveInput = z.infer<typeof WorkflowSaveSchema>;

/** 删一份工作流。对内置 id 来说**这就是「恢复默认」** —— 两种在存储层是同一个操作,
 *  所以只有一个删除动词,见 `main/orchestration/library.ts` 的文件头。 */
export const WorkflowRemoveSchema = z.object({ id: z.string().min(1) });
export type WorkflowRemoveInput = z.infer<typeof WorkflowRemoveSchema>;

/**
 * 用户在**岔路口**上选了一条路(`mcode.branch` 那个节点正停在那儿等人)。
 *
 * ## 它是"回答",不是"发消息"
 *
 * 那次运行**还活着** —— 它挂在一个 promise 上等这个回答,而这个调用把它唤醒之后,
 * 图从那儿接着往下跑,**不重跑整张图**。所以它和 `claude.send` 是两件事:后者开一次
 * 新的运行(`graphRunIntent` 在运行中会直接报 busy)。
 *
 * ## 为什么要 `runId`
 *
 * 同一个节点在同一张图里每一轮跑的 id 都一样。只按 `nodeId` 认的话,用户在**上一轮
 * 那张旧卡片**上点一下,会去唤醒这一轮的等待 —— 而这一轮问的根本不是同一件事。
 * `runId` 每次运行都是新的(见 `runner.ts` 的 `ActiveRun.runId`),带上它就分得开。
 */
export const WorkflowChooseSchema = z.object({
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  /** 选中的那条**边**的 id。**不是节点 id** —— 两条出路可以通向同一步。 */
  edgeId: z.string().min(1),
  /** 用户顺手写的一句话(可以不写)。会拼进下一步的提示词。 */
  comment: z.string().optional(),
});
export type WorkflowChooseInput = z.infer<typeof WorkflowChooseSchema>;

/** 存一份代理档案。**整份给过来**(而不是"改哪个字段")—— 理由同 `HooksSaveSchema`:
 *  档案是用户从头写的,局部更新在这里没有意义,而整份给过来能让校验只发生在一个地方
 *  (`validateAgentProfile`)。 */
export const AgentProfileSaveSchema = z.object({ profile: AgentProfileSchema });
export type AgentProfileSaveInput = z.infer<typeof AgentProfileSaveSchema>;

/** 删一份代理档案。**只按 id** —— 格式坏、读不出来的文件不在 `profiles` 里,但它照样
 *  删得掉(`removeAgentProfile` 直接按 id 拼路径),那正是最该能删的一种。 */
export const AgentProfileRemoveSchema = z.object({ id: z.string().regex(/^p_[a-z0-9_]+$/) });
export type AgentProfileRemoveInput = z.infer<typeof AgentProfileRemoveSchema>;

/** 存一条钩子。**整份给过来**(而不是"改哪个字段")—— 钩子是用户从头写的,
 *  局部更新在这里没有意义,而整份给过来能让校验只在一个地方发生(`validateHook`)。 */
export const HooksSaveSchema = z.object({ hook: HookSpecSchema });
export type HooksSaveInput = z.infer<typeof HooksSaveSchema>;

export const HooksRemoveSchema = z.object({ id: z.string().min(1) });
export type HooksRemoveInput = z.infer<typeof HooksRemoveSchema>;

/** 试跑。给的是**还没存下来**的那一份 —— 用户正是想在打开它之前看看会发生什么。 */
export const HooksTestSchema = z.object({ hook: HookSpecSchema });
export type HooksTestInput = z.infer<typeof HooksTestSchema>;

// `workflow.list` **没有入参 schema** —— 它列的是本机的工作流库,不针对某个项目。
// ⚠️ 与 `toolchain.check` 同一条纪律:无参 handler 里**不要 parse**,无参 invoke 时
// handler 收到的是 `undefined`,`z.object({}).parse(undefined)` 会直接 invalid_type。
// 与 `runtimes.list` 一致:无参 handler 不接 raw、也不 parse(不带参数 invoke 时
// raw 是 undefined,`z.object({})` 会把 `undefined` 判为 invalid_type)。

export interface ClaudeEventMessage {
  channel: "claude:event";
  sessionId: string;
  event: RuntimeEvent;
}

/**
 * Pushed from main to renderer when an auto-generated session title has been
 * written to the DB by the background title-gen routine. The renderer patches
 * its in-memory session lists so the sidebar / tabs reflect the new title
 * without a full reload. Mirrors the rename flow but is main-initiated.
 */
export interface SessionTitleUpdatedMessage {
  channel: "session:titleUpdated";
  sessionId: string;
  title: string;
}

export interface TerminalDataMessage {
  channel: "terminal:data";
  terminalId: string;
  data: string;
}

/** Fired when a PTY process exits (user typed `exit`, shell crashed, or kill). */
export interface TerminalExitMessage {
  channel: "terminal:exit";
  terminalId: string;
  /** Process exit code, or null if killed by signal / unknown. */
  exitCode: number | null;
}

/** Pushed from main -> renderer for LSP diagnostics, server logs, and running
 *  state changes. The `payload` shape depends on `type`:
 *  - "diagnostics":  { uri: string; diagnostics: LspDiagnostic[] }
 *  - "log":          { level: "info" | "warn" | "error"; message: string }
 *  - "stateChanged": { running: boolean }
 *  Kept as `unknown` here so the contract stays decoupled from the renderer's
 *  narrowing logic. */
export interface LspEventMessage {
  channel: "lsp:event";
  workspacePath: string;
  language: LspLanguageId;
  /** Type-specific shape: diagnostics → LspDiagnostic[], log →
   *  { level, message }, stateChanged → LspStateChangedPayload. */
  type: "diagnostics" | "log" | "stateChanged";
  payload: unknown;
}

/** A DOM element picked by the user from the embedded browser. This is the
 *  payload produced by the picker script injected into a page's main world,
 *  forwarded to the renderer where it becomes a `ContentTag` (kind="element")
 *  in the composer. */
export interface PickedElement {
  /** CSS selector path generated by the picker (id > class chain > nth-child). */
  selector: string;
  /** The element's outerHTML, truncated to a sane cap (≤ 2000 chars) so a huge
   *  subtree can't blow up the prompt. */
  outerHTML: string;
  /** The page URL the element was picked from. */
  url: string;
  /** Short single-line preview for the composer chip (e.g. `button.btn`). */
  preview: string;
}

/** Pushed from main -> renderer for the embedded browser panel. The payload
 *  shape depends on `type`:
 *  - "navigation": the active page changed (URL/title/back/forward state).
 *  - "loading":    the page started or stopped loading.
 *  - "pickResult": the user clicked an element in pick mode.
 *  - "crashed":    the renderer process died; the view needs recreating.
 *  - "agentOpened": an agent tool created/reused a browser view; the renderer
 *    should switch the right panel to the browser tab so the view is visible.
 *  - "tabOpened": a page opened a link in a new window (target=_blank /
 *    window.open); main created a fresh view for it and the renderer should
 *    adopt that browserId as a new panel tab (payload: BrowserTabOpened).
 *  - "authRequest": a page asked for HTTP Basic Auth; the payload is a
 *    BrowserAuthRequest and the renderer should show a login dialog, then
 *    answer via the browser.authRespond RPC.
 *  - "download": the embedded browser started/finished a file download
 *    (payload: BrowserDownloadProgress); the renderer currently only logs it —
 *    the agent reads state via the browser_downloads tool. */
export interface BrowserEventMessage {
  channel: "browser:event";
  browserId: string;
  type:
    | "navigation"
    | "loading"
    | "pickResult"
    | "crashed"
    | "agentOpened"
    | "tabOpened"
    | "authRequest"
    | "download";
  payload: unknown;
}

/** Payload of the "download" browser push event. Emitted when a download
 *  starts and again when it reaches a terminal state (completed / cancelled /
 *  interrupted); progress ticks are intentionally not pushed (the agent polls
 *  browser_downloads instead). `path` is where the file is being written. */
export interface BrowserDownloadProgress {
  downloadId: string;
  filename: string;
  path: string;
  url: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
}

/** Payload of the "tabOpened" browser push event. `background` is true when
 *  the link was opened behind the current tab (middle/ctrl-click); the
 *  renderer adds the tab without switching to it in that case. */
export interface BrowserTabOpened {
  url: string;
  title?: string;
  background?: boolean;
}

/** Payload of the "authRequest" browser push event. The requestId maps 1:1 to
 *  a pending Electron login callback held in main; answering (or cancelling)
 *  with browser.authRespond resolves it. */
export interface BrowserAuthRequest {
  requestId: string;
  /** Origin the credentials will be sent to (scheme://host[:port]). */
  origin: string;
  /** Host name only, for the dialog title. */
  host: string;
}

/**
 * Pushed from main -> renderer whenever the main window gains or loses focus.
 * The renderer uses this as the basis for notification decisions: when the
 * window is unfocused (minimized or another app is frontmost), background
 * session events warrant a stronger notification (OS notification); when
 * focused, only in-app toasts / badges are needed.
 */
export interface WindowFocusChangedMessage {
  channel: "window:focusChanged";
  /** True when the main window is focused (frontmost + not minimized). */
  focused: boolean;
}

/**
 * Pushed from main -> renderer when the user clicks an OS notification. The
 * main process has already shown + focused the window; this event tells the
 * renderer which session to navigate to (selectSession / openTab) so the user
 * lands directly on the thread that generated the notification.
 */
export interface NotificationFocusSessionMessage {
  channel: "notification:focusSession";
  sessionId: string;
}

/** Pushed from main → renderer on relay state changes (connecting, deployed,
 *  connected, error, disconnected). The renderer uses these to update the
 *  remote-access panel without polling. */
export interface RelayEventMessage {
  channel: "relay:event";
  status: RelayStatus;
}

/** Pushed from main → renderer with live ASR results for a voice-input
 *  session. `partial` = interim streaming text (may still change), `final` =
 *  a committed segment for the session. The renderer matches results to its
 *  composer via `sessionId` (the per-listen token it chose at voice.start). */
export interface VoiceResultMessage {
  channel: "voice:result";
  sessionId: string;
  kind: "partial" | "final";
  text: string;
}

/** Pushed from main → renderer while a voice model downloads. The settings
 *  panel renders a progress bar from this; `stage: "done"` means the model is
 *  ready to select. */
export interface VoiceDownloadProgressMessage {
  channel: "voice:downloadProgress";
  modelId: string;
  stage: "downloading" | "done" | "error" | "cancelled";
  percent: number;
  fileIndex: number;
  fileCount: number;
  fileBytes: number;
  error?: string;
}

export type MainToRendererMessage =
  | ClaudeEventMessage
  | SessionTitleUpdatedMessage
  | TerminalDataMessage
  | TerminalExitMessage
  | LspEventMessage
  | BrowserEventMessage
  | ThemeChangedMessage
  | UpdateAvailableMessage
  | UpdateDownloadProgressMessage
  | UpdateDownloadedMessage
  | WindowFocusChangedMessage
  | NotificationFocusSessionMessage
  | RelayEventMessage
  | VoiceResultMessage
  | VoiceDownloadProgressMessage
  | RuntimeEventMessage
  | ToolchainEventMessage
  | LibraryJobChangedMessage
  | LibraryChangedMessage
  | TemplatesChangedMessage
  | WorkflowChangedMessage
  | ComposerAttachMessage;

/* ── Integrated terminal (xterm.js + node-pty) ──
 *  PTY processes live in main. Renderer only sees opaque terminalIds and
 *  streams data over push channels. Every create is scoped to a known
 *  project root (cwd must resolve inside that root). */

/** Setting key for the user-preferred shell executable (absolute path or
 *  bare command name). Empty/absent → platform smart default. */
export const TERMINAL_SHELL_SETTING_KEY = "terminal.shell";

/** Setting key for the directory where agent browser screenshots are saved.
 *  Empty/absent → the system Pictures directory. Screenshots are organized as
 *  `<dir>/<sessionId>/turn-<N>/<timestamp>-<toolCallId>.png`. */
export const BROWSER_SCREENSHOT_DIR_SETTING_KEY = "browser.screenshotDir";

/** Setting key for the directory where the embedded browser's session data is
 *  stored (cookies, form/autofill data, localStorage, IndexedDB, etc.). The
 *  browser views run on a dedicated persistent partition
 *  ("persist:mcode-browser"); when this is set, the partition is pointed at
 *  that directory via session.fromPartition's `path` option. Empty/absent →
 *  Electron's default partition location under userData. NOTE: Electron caches
 *  Session objects by partition string, so changing this only takes effect
 *  after an app restart. */
export const BROWSER_DATA_DIR_SETTING_KEY = "browser.dataDir";

/** Setting key for "remember browser sign-in state" (default on). When
 *  enabled, BrowserManager snapshots ALL live cookies of the embedded browser
 *  into `browser.cookieVault` on a background timer and before quit, and
 *  re-injects them into the browser session before its first navigation —
 *  sign-in state (including session cookies from sites where "remember me"
 *  was unchecked) survives app restarts. Needed because Electron ≤ 40 never
 *  commits cookies to disk for persistent partitions; from Electron 41 the
 *  native store works and the vault merely shadows it. Stored as "0" to
 *  disable; missing = enabled. */
export const BROWSER_PERSIST_LOGIN_SETTING_KEY = "browser.persistLogin";

/** 文献库根目录。缺失 → 默认 `<userData>/library`。
 *  库内所有相对路径(pdfPath / mdPath)都相对它。用户可在界面上改位置 ——
 *  改完只改指向、不搬文件(搬文件由用户自己决定,避免大批量 IO 中途失败)。 */
export const LIBRARY_ROOT_SETTING_KEY = "library.root";

/** 下载并发上限。缺失 → 默认 2。走内嵌浏览器下载,并发过高会与用户的手动浏览
 *  抢同一个 WebContentsView,反而更慢。 */
export const LIBRARY_DOWNLOAD_CONCURRENCY_SETTING_KEY = "library.downloadConcurrency";

/** 外部集成的非密钥配置(JSON):`{ [id]: { baseUrl?, enabled, lastTest? } }`。
 *  密钥不放这里 —— 见 INTEGRATIONS_KEYS_SETTING_KEY。 */
export const INTEGRATIONS_SETTING_KEY = "integrations.config";

/** 外部集成的密钥(JSON):`{ [id]: base64Ciphertext }`,safeStorage 加密。
 *  与自定义模型那条路同一套做法,明文永不落盘。 */
export const INTEGRATIONS_KEYS_SETTING_KEY = "integrations.keys";

/** 模版库根目录。缺失 → 默认 `<userData>/templates`。 */
export const TEMPLATE_ROOT_SETTING_KEY = "templates.root";

/** 「回收站」那个集合的 id。
 *
 *  ⚠️ **按 id 记,不按名字找**:回收站是个**普通集合**(用户要求「只是一个叫回收站的
 *  collection」),所以他能给它改名、也能把它删掉。靠名字匹配的话,改个名字语义就废了。
 *  记 id 之后,名字随便改都不影响;集合被删了 id 就失效,下次要用时重建。 */
export const LIBRARY_TRASH_COLLECTION_SETTING_KEY = "library.trashCollectionId";

/**
 * 回收站的设置键 —— **每个库一个**(论文的回收站和笔记的回收站是两回事)。
 *
 * 不带库的旧键仍然保留:`library.trashCollectionId` 是老数据里那个全局回收站的
 * 位置(它建在论文库下),论文库会回退去读它,不然改完键就不认那个集合了。
 */
export function libraryTrashSettingKey(kind: LibraryKind): string {
  return `${LIBRARY_TRASH_COLLECTION_SETTING_KEY}.${kind}`;
}

/**
 * **统一数据根**。聊天记录(数据库)、文献库、模版库都放在它下面:
 *
 * ```
 * <数据根>/mcode.db  ·  <数据根>/library/  ·  <数据根>/templates/
 * ```
 *
 * 缺失 → 默认 `<用户主目录>/Mcode`。改它会触发**整体搬迁 + 重启应用** —— 数据库在
 * 运行期一直被主进程持有(sql.js 在内存里),没法原地换地基。
 */
export const DATA_ROOT_SETTING_KEY = "app.dataRoot";

/* ── 模版库 ── */

export const TemplateKindSchema = z.enum(TEMPLATE_KINDS);

/** 不传 kind = 列全部类目。 */
export const TemplateListSchema = z.object({ kind: TemplateKindSchema.optional() });
export type TemplateListInput = z.infer<typeof TemplateListSchema>;

export const TemplateAddSchema = z.object({
  kind: TemplateKindSchema,
  name: z.string().min(1),
  /** 要收进这个模版的文件 / 文件夹(绝对路径)。**文件夹会被整包复制** ——
   *  LaTeX 模版往往是 .cls + .tex + 图片的一整套。 */
  sourcePaths: z.array(z.string().min(1)).min(1).max(200),
});
export type TemplateAddInput = z.infer<typeof TemplateAddSchema>;

/** 指向某一条模版:类目 + 目录名(目录名就是显示名)。 */
export const TemplateEntryRefSchema = z.object({
  kind: TemplateKindSchema,
  dirName: z.string().min(1),
});
export type TemplateEntryRefInput = z.infer<typeof TemplateEntryRefSchema>;

/**
 * 给一条模版改名。
 *
 * 模版库是文件系统即事实源、目录名即显示名,所以"改名"就是**把那个目录改名** ——
 * 与文献库那边改一个分类的名字是同一件事的两个形态(那边改的是数据库里一行,
 * 这边改的是磁盘上一个目录)。渲染端只给新名字,净化与重名检查都在主进程做。
 */
export const TemplateRenameSchema = z.object({
  kind: TemplateKindSchema,
  /** 现在叫什么(定位用)。 */
  dirName: z.string().min(1),
  /** 要改成什么。会被 `sanitizeTemplateName` 净化,净化后为空则拒绝。 */
  name: z.string().min(1),
});
export type TemplateRenameInput = z.infer<typeof TemplateRenameSchema>;

/**
 * 把一条模版挂到某次对话的输入框上 —— 左栏右键「添加到当前对话」。
 *
 * `sessionId` 要显式给:消息要发给**指定会话**的输入框,而左栏与那个输入框不是同一棵
 * 组件树。主进程生成清单(每次重写)后用既有的 `composer:attach` 广播回去,那个会话
 * 的 ChatPane 自己认领 —— 与「+ → 模版」和文献库那条路是同一条,所以两边效果必然一致。
 */
export const TemplatesAttachToChatSchema = z.object({
  sessionId: z.string().min(1),
  kind: TemplateKindSchema,
  /** 省略 = 挂**整个类目**(「全部 LaTeX 模版」那一行),清单里列全这个类目的每一条。 */
  dirName: z.string().min(1).optional(),
});
export type TemplatesAttachToChatInput = z.infer<typeof TemplatesAttachToChatSchema>;

/**
 * 指向某一条模版里的**一个文件**:类目 + 目录名 + 相对条目目录的路径。
 *
 * `relPath` 的写法与 `TemplateFile.relPath` 逐字一致(正斜杠分隔,可能带子目录)——
 * 界面上的文件行拿到的就是它,原样传回来。**主进程必须把它当不可信输入**:解析出的
 * 绝对路径要落在条目目录内部,而且必须是扫描时列出来的那些文件之一,否则一段构造过的
 * 请求就能把机器上任意文件读成预览内容。
 */
export const TemplateFileRefSchema = z.object({
  kind: TemplateKindSchema,
  dirName: z.string().min(1),
  relPath: z.string().min(1),
});
export type TemplateFileRefInput = z.infer<typeof TemplateFileRefSchema>;

export const IntegrationIdSchema = z.enum(INTEGRATION_IDS);

export const IntegrationSetKeySchema = z.object({
  id: IntegrationIdSchema,
  /** 明文密钥。**只有这一条通道会带明文进来**,主进程收到即加密,之后只回打码串。 */
  key: z.string().min(1),
});
export type IntegrationSetKeyInput = z.infer<typeof IntegrationSetKeySchema>;

export const IntegrationClearKeySchema = z.object({ id: IntegrationIdSchema });
export type IntegrationClearKeyInput = z.infer<typeof IntegrationClearKeySchema>;

export const IntegrationSetConfigSchema = z.object({
  id: IntegrationIdSchema,
  /** 覆盖默认 API 根地址(自建反代/镜像)。主进程会去掉尾部斜杠。 */
  baseUrl: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});
export type IntegrationSetConfigInput = z.infer<typeof IntegrationSetConfigSchema>;

export const IntegrationTestSchema = z.object({ id: IntegrationIdSchema });
export type IntegrationTestInput = z.infer<typeof IntegrationTestSchema>;

/* ── 文献库:PDF 文件导入 + 转 Markdown ── */

/** 三个平级的库(值域与 `contracts/library.ts` 的 `LIBRARY_KINDS` 一致)。 */
export const LibraryKindSchema = z.enum(LIBRARY_KINDS);
export type LibraryKindInput = z.infer<typeof LibraryKindSchema>;

export const LibraryImportFilesSchema = z.object({
  /** 用户从文件选择框里挑出来的绝对路径。上限 200 —— 再多就该分批了。 */
  paths: z.array(z.string().min(1)).min(1).max(200),
  /** 导入的文献归入哪些库(null/省略 = 只进总库)。 */
  collectionIds: z.array(z.string()).optional(),
  /** 入库后是否接着转 Markdown(默认转 —— 用户要的就是「导入即可被 AI 读」)。 */
  convert: z.boolean().optional(),
  /** 导入到哪个库。省略 = 论文库。 */
  kind: LibraryKindSchema.optional(),
});
export type LibraryImportFilesInput = z.infer<typeof LibraryImportFilesSchema>;

/**
 * 导入笔记:直接收 **Markdown 文件**。
 *
 * 与 `importFiles`(PDF)分开是因为两件事的后续完全不同:PDF 要抓元数据、要排队下载、
 * 要转 Markdown;笔记本身就是 Markdown,入库即完成 —— 没有元数据可抓,也不需要转录。
 * 硬塞进一条 RPC 只会让两边都长出一串 `if (kind === "note")`。
 */
export const LibraryImportNotesSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(200),
  collectionIds: z.array(z.string()).optional(),
});
export type LibraryImportNotesInput = z.infer<typeof LibraryImportNotesSchema>;

export const LibraryConvertSchema = z.object({
  /** 要转的条目;省略则转整个库(或某个集合)。 */
  ids: z.array(z.string()).optional(),
  collectionId: z.string().optional(),
  /** 已经有 md 也重转。 */
  force: z.boolean().optional(),
});
export type LibraryConvertInput = z.infer<typeof LibraryConvertSchema>;

export const LibraryRevealFileSchema = z.object({
  id: z.string().min(1),
  /** 定位哪一个:PDF 还是转换出的 Markdown。默认 PDF。 */
  which: z.enum(["pdf", "md"]).optional(),
});
export type LibraryRevealFileInput = z.infer<typeof LibraryRevealFileSchema>;

/** 与 revealFile 同形:**入参只有条目 id**,路径由主进程从库里取。 */
export const LibraryOpenFileSchema = LibraryRevealFileSchema;
export type LibraryOpenFileInput = z.infer<typeof LibraryOpenFileSchema>;

/**
 * 读一篇文献的 Markdown 正文(应用内预览用)。
 *
 * 为什么必须走 IPC:渲染进程**读不了本地文件**(沙箱里没有 fs)。而且 md 里的图片是
 * 相对路径 `images/xxx.jpg`(MinerU 的产物),渲染端连它的父目录都不知道,只有主进程
 * 能把相对引用解析成真实字节。所以主进程一次把正文和**被引用到的图片**(base64
 * data URL)一起交出来,渲染端不需要二次往返。
 */
export const LibraryReadMarkdownSchema = z.object({ id: z.string().min(1) });
export type LibraryReadMarkdownInput = z.infer<typeof LibraryReadMarkdownSchema>;

/**
 * 读一篇文献的 PDF 字节(应用内 PDF 阅读器用)。
 *
 * 与 `readMarkdown` 同一个理由:渲染进程读不了本地文件。但这里**不走 base64** ——
 * Electron 的 IPC 用结构化克隆,`Uint8Array` 可以原样过去;base64 会让体积涨三分之一,
 * 而论文 PDF 常有十几 MB。pdf.js 的 `getDocument({ data })` 正好收 Uint8Array。
 */
/**
 * 采纳一份**用户手上的** Markdown 作为这篇的转录产物。
 *
 * 为什么不复用 convert:转录要花 MinerU 额度,而且用户手上那份可能本就更好 ——
 * 他要的是"挂上去",不是"再转一遍"(重转还会覆盖掉他更满意的那份)。
 */
/** 新建一篇笔记(笔记库里在应用内写的那种)。标题会写进正文的第一行。 */
export const LibraryCreateNoteSchema = z.object({
  title: z.string().min(1),
  collectionIds: z.array(z.string()).optional(),
});
export type LibraryCreateNoteInput = z.infer<typeof LibraryCreateNoteSchema>;

/**
 * 把编辑器的内容写回笔记文件。
 *
 * 只对**笔记**开放(主进程会校验 kind):论文/教材的 md 是转录产物,让应用内的
 * 编辑器直接覆盖它,"转录结果"和"用户改动"就再也分不清了。
 */
export const LibraryWriteNoteSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
});
export type LibraryWriteNoteInput = z.infer<typeof LibraryWriteNoteSchema>;

/** 列某个条目下的笔记。 */
/** 给**单独一篇**生成一份清单(标题/作者/该读哪个文件/我的笔记)。 */
/**
 * 整个库的清单(「全部文献」那一行)—— 只要 kind。
 *
 * 与 `library.manifest`(一个分类)是同一件事的两个粒度:分类是用户分出来的组,
 * 「全部<库>」是"这个库里的所有东西"。用户要求「和文档一样要有全部内容」,而那一行
 * 也得能挂进对话,否则它就是个只能看不能用的摆设。
 */
export const LibraryKindManifestSchema = z.object({ kind: LibraryKindSchema });
export type LibraryKindManifestInput = z.infer<typeof LibraryKindManifestSchema>;

/** 整个模版类目的清单(「全部 LaTeX 模版」那一行)。 */
export const TemplateKindManifestSchema = z.object({ kind: TemplateKindSchema });
export type TemplateKindManifestInput = z.infer<typeof TemplateKindManifestSchema>;

export const LibraryItemManifestSchema = z.object({ id: z.string().min(1) });
export type LibraryItemManifestInput = z.infer<typeof LibraryItemManifestSchema>;

export const LibraryNotesListSchema = z.object({ itemId: z.string().min(1) });
export type LibraryNotesListInput = z.infer<typeof LibraryNotesListSchema>;

/** 写一条笔记:带 id 是改,不带是新建。 */
export const LibraryNoteSaveSchema = z.object({
  id: z.string().min(1).optional(),
  itemId: z.string().min(1),
  content: z.string().min(1),
});
export type LibraryNoteSaveInput = z.infer<typeof LibraryNoteSaveSchema>;

/**
 * 改条目的显示标题。文献 / 教材 / 笔记都用它。
 *
 * **只改标题,不动磁盘上的文件**:文件名(尤其是笔记的)按条目 id 命名,跟着标题变
 * 会让库内所有引用一起漂。用户看到的名字变了就够了。
 */
export const LibraryRenameItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
});
export type LibraryRenameItemInput = z.infer<typeof LibraryRenameItemSchema>;

export const LibraryNoteDeleteSchema = z.object({ id: z.string().min(1) });
export type LibraryNoteDeleteInput = z.infer<typeof LibraryNoteDeleteSchema>;

export const LibraryAdoptMarkdownSchema = z.object({
  id: z.string().min(1),
  /** 用户选中的 md 文件绝对路径。同级若有 `images/` 会一起搬。 */
  path: z.string().min(1),
});
export type LibraryAdoptMarkdownInput = z.infer<typeof LibraryAdoptMarkdownSchema>;

export const LibraryReadPdfSchema = z.object({ id: z.string().min(1) });
export type LibraryReadPdfInput = z.infer<typeof LibraryReadPdfSchema>;

/** 导出的引用格式 —— 与 `citation.ts` 的 `CITATION_STYLES` 一一对应。 */
export const CitationStyleSchema = z.enum(["gb7714", "apa", "bibtex"]);

export const LibraryExportSchema = z.object({
  /** 只导出某个集合;省略则导出整个库。 */
  collectionId: z.string().optional(),
  style: CitationStyleSchema,
  /** 导出后顺便打开所在文件夹。**由主进程自己拼路径** —— 渲染端始终拿不到
   *  「打开任意路径」的能力(与 revealFile 同一条安全约定)。 */
  reveal: z.boolean().optional(),
});
export type LibraryExportInput = z.infer<typeof LibraryExportSchema>;

/** Setting key holding the browser cookie vault — a JSON array of
 *  `VaultCookie` snapshots written by BrowserManager (main only) and restored
 *  when a browser view's session is first created after a restart. Legacy
 *  (plaintext) location: new writes go to `browser.cookieVault.enc` via
 *  safeStorage; this key remains only as the restore fallback for vaults
 *  written before the encrypted key existed (and when OS-level encryption is
 *  unavailable, e.g. Linux without a keyring). */
export const BROWSER_COOKIE_VAULT_SETTING_KEY = "browser.cookieVault";

/** Setting key holding the safeStorage-encrypted cookie vault (base64
 *  ciphertext of the same `VaultCookie` JSON array). Preferred over
 *  `browser.cookieVault` on both save and restore; sign-in cookies are
 *  credentials, so they must not sit in the DB in plaintext where the OS
 *  supports encryption (DPAPI on Windows, Keychain on macOS, kwallet/gnome-
 *  keyring on Linux — with automatic plaintext fallback where it doesn't). */
export const BROWSER_COOKIE_VAULT_ENC_SETTING_KEY = "browser.cookieVault.enc";

/** Setting key for the address-bar history (JSON array of
 *  `BrowserHistoryEntry`, most-recent first, capped at 50). Written only by
 *  the main process (BrowserManager on did-navigate); the renderer reads it
 *  via setting.get and removes entries via the browser.historyRemove /
 *  browser.historyClear RPCs. */
export const BROWSER_ADDRESS_HISTORY_SETTING_KEY = "browser.addressHistory";

/** Setting key for the browser panel's page bookmarks (JSON array of
 *  `BrowserBookmarkEntry`, most-recent first, capped at 100). Single writer is
 *  the main process (browser.bookmarkAdd / bookmarkRemove RPCs); the renderer
 *  reads it via setting.get — the exact pattern of the address history. */
export const BROWSER_BOOKMARKS_SETTING_KEY = "browser.bookmarks";

/** One bookmarked page in the browser panel's "More" menu. */
export interface BrowserBookmarkEntry {
  url: string;
  /** Page title at bookmark time (may be empty). */
  title: string;
  /** Epoch ms of when the bookmark was added. */
  addedAt: number;
}

/** One address-bar history entry. */
export interface BrowserHistoryEntry {
  url: string;
  /** Page title at the time of navigation (may be empty for redirects). */
  title: string;
  /** Epoch ms of the last visit. */
  at: number;
}

/** Snapshot of a live (or just-exited) terminal session. */
export interface TerminalInfo {
  terminalId: string;
  /** Absolute cwd the PTY was spawned with. */
  cwd: string;
  /** Resolved shell executable path/name. */
  shell: string;
  /** OS process id while alive; 0 after exit. */
  pid: number;
  /** Project root this terminal is bound to. */
  projectPath: string;
}

/** Create a new PTY bound to a project. `cwd` defaults to `projectPath`. */
export const TerminalCreateSchema = z.object({
  projectPath: z.string().min(1),
  /** Optional working directory; must resolve inside projectPath. */
  cwd: z.string().min(1).optional(),
  cols: z.number().int().min(1).max(1000).optional(),
  rows: z.number().int().min(1).max(1000).optional(),
  /** Optional shell override for this session only. */
  shell: z.string().min(1).optional(),
});
export type TerminalCreateInput = z.infer<typeof TerminalCreateSchema>;

export const TerminalWriteSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
});
export type TerminalWriteInput = z.infer<typeof TerminalWriteSchema>;

export const TerminalResizeSchema = z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type TerminalResizeInput = z.infer<typeof TerminalResizeSchema>;

export const TerminalKillSchema = z.object({
  terminalId: z.string().min(1),
});
export type TerminalKillInput = z.infer<typeof TerminalKillSchema>;

export const TerminalListSchema = z.object({
  /** When set, only terminals bound to this project root are returned. */
  projectPath: z.string().min(1).optional(),
});
export type TerminalListInput = z.infer<typeof TerminalListSchema>;

/** Structured result for create — either success fields or ok:false + error. */
export type TerminalCreateResult =
  | {
      ok: true;
      terminalId: string;
      pid: number;
      cwd: string;
      shell: string;
    }
  | { ok: false; error: string };

export interface TerminalOpResult {
  ok: boolean;
  error?: string;
}

/* ── Embedded browser (WebContentsView + DOM element picker) ──
 *  The browser view lives in main (an OS-level WebContentsView overlaid on the
 *  main window). Renderer only sees an opaque browserId and drives it via RPC.
 *  The picker script is injected into the page's main world via executeJavaScript;
 *  picked elements come back as a push event (browser:event / pickResult). */

/** A pixel rect in window coordinates, used to position the WebContentsView
 *  over the renderer's browser-panel placeholder. Measured by the renderer via
 *  getBoundingClientRect() and forwarded on resize. */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const BrowserCreateSchema = z.object({
  projectPath: z.string().min(1),
  /** Optional initial device-emulation preset applied once the view's renderer
   *  is ready (dom-ready). Used by the sidebar container to start in mobile
   *  mode without calling setDevice too early (which can crash the GPU
   *  process before it's initialized). Omit = desktop (no emulation). */
  initialDevice: z
    .enum([
      "desktop",
      "iphone",
      "iphone-se",
      "android",
      "galaxy-s23",
      "ipad-mini",
      "custom",
    ])
    .optional(),
});
export type BrowserCreateInput = z.infer<typeof BrowserCreateSchema>;

export const BrowserLoadUrlSchema = z.object({
  browserId: z.string().min(1),
  url: z.string().min(1),
});
export type BrowserLoadUrlInput = z.infer<typeof BrowserLoadUrlSchema>;

export const BrowserGoBackSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserGoBackInput = z.infer<typeof BrowserGoBackSchema>;

export const BrowserGoForwardSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserGoForwardInput = z.infer<typeof BrowserGoForwardSchema>;

export const BrowserReloadSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserReloadInput = z.infer<typeof BrowserReloadSchema>;

export const BrowserSetBoundsSchema = z.object({
  browserId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});
export type BrowserSetBoundsInput = z.infer<typeof BrowserSetBoundsSchema>;

export const BrowserSetPickModeSchema = z.object({
  browserId: z.string().min(1),
  enabled: z.boolean(),
});
export type BrowserSetPickModeInput = z.infer<typeof BrowserSetPickModeSchema>;

export const BrowserShowSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserShowInput = z.infer<typeof BrowserShowSchema>;

export const BrowserHideSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserHideInput = z.infer<typeof BrowserHideSchema>;

export const BrowserCloseSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserCloseInput = z.infer<typeof BrowserCloseSchema>;

export const BrowserBookmarkAddSchema = z.object({
  url: z.string().min(1),
  title: z.string(),
});
export type BrowserBookmarkAddInput = z.infer<typeof BrowserBookmarkAddSchema>;

/** Act on a tracked browser download from the panel's download bar. The
 *  renderer passes only the downloadId — main resolves the path from its own
 *  download registry, so an arbitrary filesystem path never crosses IPC.
 *  "open" launches the file with the OS default app (only allowed once the
 *  download completed); "reveal" selects it in the containing folder. */
export const BrowserDownloadActionSchema = z.object({
  downloadId: z.string().min(1),
  action: z.enum(["open", "reveal"]),
});
export type BrowserDownloadActionInput = z.infer<typeof BrowserDownloadActionSchema>;

export const BrowserBookmarkRemoveSchema = z.object({
  url: z.string().min(1),
});
export type BrowserBookmarkRemoveInput = z.infer<typeof BrowserBookmarkRemoveSchema>;

export const BrowserCaptureFrameSchema = z.object({
  browserId: z.string().min(1),
});
export type BrowserCaptureFrameInput = z.infer<typeof BrowserCaptureFrameSchema>;

/** Result of browser.captureFrame: one PNG frame of the page for the
 *  renderer's frozen-frame placeholder (toolbar menus float over this
 *  snapshot while the real view parks offscreen). `data` is base64 PNG.
 *  ok:false = capture failed (compositor not ready, view gone) — the caller
 *  degrades to the plain hide. Purely in-memory: never persisted. */
export interface BrowserCaptureFrameResult {
  ok: boolean;
  data?: string;
  mimeType?: "image/png";
  error?: string;
}

/** Device presets for the browser panel's device emulation. "desktop" is the
 *  default (no emulation — the page viewport follows the panel's actual size,
 *  like a normal desktop browser window); the mobile presets set a viewport
 *  width/height + deviceScaleFactor + mobile screenPosition via
 *  enableDeviceEmulation. "custom" uses the width/height passed at set-device
 *  time instead of a fixed preset. */
export type BrowserDevicePreset =
  | "desktop"
  | "iphone"
  | "iphone-se"
  | "android"
  | "galaxy-s23"
  | "ipad-mini"
  | "custom";

/** Screen orientation for device emulation. "landscape" swaps the preset's
 *  width/height before applying emulation (e.g. 390×844 → 844×390). */
export type BrowserOrientation = "portrait" | "landscape";

/** One entry in the shared device preset catalog. `width`/`height` are the
 *  portrait-orientation logical (CSS) viewport dims; `scale` is the
 *  deviceScaleFactor passed to enableDeviceEmulation. Kept in contracts so
 *  main (BrowserManager.setDevice) and renderer (BrowserPanel bounds sync +
 *  BrowserToolbar labels) read the same numbers. */
export interface BrowserDeviceSpec {
  id: BrowserDevicePreset;
  label: string;
  width: number;
  height: number;
  scale: number;
}

/** Shared preset catalog — single source of truth for the device selector.
 *  "custom" is a menu entry (no fixed dims; width/height come from the input
 *  fields at set time).
 *
 *  "desktop" (no-emulation) is both the default device for new tabs and the
 *  selectable "桌面端" menu entry: the page viewport follows the panel's real
 *  size (responsive) instead of pinning a fixed emulated viewport. */
export const BROWSER_DEVICE_PRESETS: BrowserDeviceSpec[] = [
  { id: "desktop", label: "桌面端", width: 0, height: 0, scale: 1 },
  { id: "iphone", label: "iPhone 14", width: 390, height: 844, scale: 3 },
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667, scale: 2 },
  { id: "android", label: "Pixel 7", width: 412, height: 915, scale: 2.625 },
  { id: "galaxy-s23", label: "Galaxy S23", width: 360, height: 740, scale: 3 },
  { id: "ipad-mini", label: "iPad mini", width: 768, height: 1024, scale: 2 },
  { id: "custom", label: "自定义", width: 0, height: 0, scale: 3 },
];

/** Resolve a preset's portrait dims/scale, falling back to the given custom
 *  width/height (or the default preset) when the id is unknown. */
export function resolveBrowserDeviceSpec(
  device: BrowserDevicePreset,
  custom?: { width?: number; height?: number },
): BrowserDeviceSpec {
  const found = BROWSER_DEVICE_PRESETS.find((p) => p.id === device);
  if (device === "custom") {
    return {
      id: "custom",
      label: found?.label ?? "自定义",
      width: custom?.width ?? 390,
      height: custom?.height ?? 844,
      scale: found?.scale ?? 3,
    };
  }
  return (
    found ?? { id: "desktop", label: "桌面端", width: 0, height: 0, scale: 1 }
  );
}

export const BrowserSetDeviceSchema = z.object({
  browserId: z.string().min(1),
  device: z.enum([
    "desktop",
    "iphone",
    "iphone-se",
    "android",
    "galaxy-s23",
    "ipad-mini",
    "custom",
  ]),
  /** Custom viewport width (required when device === "custom"). */
  width: z.number().int().min(1).optional(),
  /** Custom viewport height (required when device === "custom"). */
  height: z.number().int().min(1).optional(),
  /** Screen orientation; "landscape" swaps width/height. Defaults to
   *  "portrait" when omitted (backward compatible with old callers). */
  orientation: z.enum(["portrait", "landscape"]).optional(),
  /** Effective emulated viewport size (CSS px) to apply. When set, overrides
   *  the preset/custom dims — used by the renderer to match the view's
   *  physical bounds exactly (e.g. a narrow sidebar column), which keeps
   *  capturePage() from returning black frames and pages from being clipped.
   *  Omit to use the preset/custom dims. */
  viewportWidth: z.number().int().min(1).optional(),
  viewportHeight: z.number().int().min(1).optional(),
});
export type BrowserSetDeviceInput = z.infer<typeof BrowserSetDeviceSchema>;

/** Current viewport configuration for a browser view (mirrors what was last
 *  passed to browser.setDevice). Custom dims are present only for "custom";
 *  orientation defaults to "portrait" when the field is absent. effWidth/
 *  effHeight are the EFFECTIVE emulated viewport size (CSS px) actually
 *  applied — equals the preset/custom dims (post-orientation) unless the
 *  renderer overrode them to match the view's physical bounds. */
export interface BrowserViewport {
  device: BrowserDevicePreset;
  width?: number;
  height?: number;
  orientation: BrowserOrientation;
  effWidth?: number;
  effHeight?: number;
}

/** Structured result for browser.create - either success with the id, or
 *  ok:false + error. */
export type BrowserCreateResult =
  | { ok: true; browserId: string }
  | { ok: false; error: string };

/** Generic ok/error result for browser navigation / view ops. */
export interface BrowserOpResult {
  ok: boolean;
  error?: string;
}

/* ── Address history ──
 *  History is written by main only (on did-navigate); these RPCs let the
 *  renderer remove entries without racing main's writes. */

export const BrowserHistoryRemoveSchema = z.object({
  url: z.string().min(1),
});
export type BrowserHistoryRemoveInput = z.infer<typeof BrowserHistoryRemoveSchema>;

export const BrowserHistoryClearSchema = z.object({});
export type BrowserHistoryClearInput = z.infer<typeof BrowserHistoryClearSchema>;

/** Renderer's answer to an "authRequest" push event. */
export const BrowserAuthRespondSchema = z.object({
  requestId: z.string().min(1),
  /** Empty username+password cancels the auth prompt. */
  username: z.string(),
  password: z.string(),
});
export type BrowserAuthRespondInput = z.infer<typeof BrowserAuthRespondSchema>;

/* ── 文献库(library) ────────────────────────────────────────────────────
   领域类型见 `library.ts`;这里只放跨 IPC 的校验 schema。
   约定与既有分区一致:每个 schema 同时导出 `...Input` 类型。 */

/** 作者。三选一:西文给 family/given,中日韩等给 literal(不做姓/名切分)。 */
export const LibraryAuthorSchema = z.object({
  family: z.string().optional(),
  given: z.string().optional(),
  literal: z.string().optional(),
});

export const LibraryItemTypeSchema = z.enum([
  "article",
  "inproceedings",
  "book",
  "thesis",
  "preprint",
  "report",
  "other",
]);

/** 入库一条文献。`id` 由主进程生成 —— 渲染端/AI 只给标识符与元数据。
 *  `doi`/`arxivId` 至少给一个,否则无法查重也无法定位 PDF。 */
export const LibraryItemInputSchema = z
  .object({
    doi: z.string().optional(),
    arxivId: z.string().optional(),
    title: z.string().optional(),
    authors: z.array(LibraryAuthorSchema).optional(),
    year: z.number().int().optional(),
    venue: z.string().optional(),
    /** 卷 / 期 / 页码 / 出版商 —— 引用格式(GB/T 7714、APA、BibTeX)要用,
     *  缺了就整段省略。全部按字符串收:页码有 `1234-1240`、`e0123456` 等形态。 */
    volume: z.string().optional(),
    issue: z.string().optional(),
    page: z.string().optional(),
    publisher: z.string().optional(),
    abstract: z.string().optional(),
    type: LibraryItemTypeSchema.optional(),
    language: z.string().optional(),
    url: z.string().optional(),
    source: z.string().optional(),
    license: z.string().optional(),
    /** 归到哪个库。省略 = 论文库。 */
    kind: LibraryKindSchema.optional(),
    /** 一并归入的集合;省略则不归任何集合。 */
    collectionIds: z.array(z.string()).optional(),
    /** 入库后是否立刻排入下载队列。默认 true。 */
    queueDownload: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.doi?.trim() || v.arxivId?.trim() || v.title?.trim()), {
    message: "至少需要 doi / arxivId / title 之一",
  });
export type LibraryItemInput = z.infer<typeof LibraryItemInputSchema>;

export const LibraryAddItemsSchema = z.object({
  items: z.array(LibraryItemInputSchema).min(1),
});
export type LibraryAddItemsInput = z.infer<typeof LibraryAddItemsSchema>;

/** 列表筛选。`collectionId` 为 null 表示全部;`collectionId` 为字符串时只列该集合。 */
export const LibraryListSchema = z.object({
  collectionId: z.string().nullable().optional(),
  /** 只看某个库。省略 = 不限库(全部)。 */
  kind: LibraryKindSchema.optional(),
  /** 搜索关键词(标题/作者/摘要/venue),大小写不敏感。 */
  query: z.string().optional(),
  /** 只列某种 PDF 状态(如 "none" 用于找缺 PDF 的)。 */
  pdfState: z.enum(["none", "queued", "downloading", "ready", "needs_login", "failed"]).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
});
export type LibraryListInput = z.infer<typeof LibraryListSchema>;

export const LibraryItemIdSchema = z.object({ id: z.string().min(1) });
export type LibraryItemIdInput = z.infer<typeof LibraryItemIdSchema>;

export const LibraryDeleteItemsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  /** 是否连同磁盘上的 PDF/MD 一起删除。默认 false(只从库里移除记录)。 */
  deleteFiles: z.boolean().optional(),
});
export type LibraryDeleteItemsInput = z.infer<typeof LibraryDeleteItemsSchema>;

/** 集合:新建。`parentId` 为 null 表示顶层。 */
export const CollectionCreateSchema = z.object({
  name: z.string().min(1),
  parentId: z.string().nullable().optional(),
  /** 建在哪个库里。省略 = 论文库。 */
  kind: LibraryKindSchema.optional(),
});
export type CollectionCreateInput = z.infer<typeof CollectionCreateSchema>;

export const CollectionRenameSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type CollectionRenameInput = z.infer<typeof CollectionRenameSchema>;

export const CollectionDeleteSchema = z.object({ id: z.string().min(1) });
export type CollectionDeleteInput = z.infer<typeof CollectionDeleteSchema>;

/** 把文献加入/移出集合。一次可操作多条。 */
export const CollectionAssignSchema = z.object({
  collectionId: z.string().min(1),
  itemIds: z.array(z.string().min(1)).min(1),
  /** true = 加入,false = 移出。 */
  add: z.boolean(),
});
export type CollectionAssignInput = z.infer<typeof CollectionAssignSchema>;

/** 机构认证档案。⚠️ 不含任何凭据 —— 登录态在浏览器分区里,见 library.ts 的说明。 */
export const InstitutionSaveSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  loginUrl: z.string().optional(),
  domains: z.array(z.string()).optional(),
  proxyPrefix: z.string().optional(),
  notes: z.string().optional(),
});
export type InstitutionSaveInput = z.infer<typeof InstitutionSaveSchema>;

export const InstitutionDeleteSchema = z.object({ id: z.string().min(1) });
export type InstitutionDeleteInput = z.infer<typeof InstitutionDeleteSchema>;

/** 查询已登录站点。按域名聚合当前浏览器分区里的 cookie。 */
export const InstitutionAuthStatusSchema = z.object({
  /** 只看这些域名;省略则返回全部有 cookie 的域名。 */
  domains: z.array(z.string()).optional(),
});
export type InstitutionAuthStatusInput = z.infer<typeof InstitutionAuthStatusSchema>;

export const InstitutionClearCookiesSchema = z.object({
  /** 要清除的域名。省略则清空整个浏览器分区(危险,UI 需二次确认)。 */
  domains: z.array(z.string()).optional(),
});
export type InstitutionClearCookiesInput = z.infer<typeof InstitutionClearCookiesSchema>;

/** 把文献排入下载队列。 */
export const LibraryDownloadSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  /** 已有 PDF 的是否强制重下。默认 false。 */
  force: z.boolean().optional(),
});
export type LibraryDownloadInput = z.infer<typeof LibraryDownloadSchema>;

/** 外部检索:AI 主导的关键词检索,走确定性 API。 */
export const LibrarySearchSchema = z.object({
  query: z.string().min(1),
  sources: z
    .array(z.enum(["arxiv", "crossref", "openalex", "europepmc"]))
    .optional(),
  limit: z.number().int().positive().max(100).optional(),
  yearFrom: z.number().int().optional(),
  yearTo: z.number().int().optional(),
});
export type LibrarySearchInput = z.infer<typeof LibrarySearchSchema>;

/** 导入通道:DOI / arXiv ID / BibTeX 文本,批量解析入库。不用 AI 也能走的确定路径。 */
export const LibraryImportSchema = z.object({
  /** 原始文本,每行一个 DOI / arXiv ID,或一整段 BibTeX。格式由主进程嗅探。 */
  text: z.string().min(1),
  collectionIds: z.array(z.string()).optional(),
  queueDownload: z.boolean().optional(),
});
export type LibraryImportInput = z.infer<typeof LibraryImportSchema>;

/** 设置库根目录(用户要求「UI 上可以设置文献的位置」)。 */
export const LibrarySetRootSchema = z.object({ path: z.string().min(1) });
export type LibrarySetRootInput = z.infer<typeof LibrarySetRootSchema>;

/**
 * 为一个文献库生成/刷新清单文件,返回其绝对路径。
 *
 * 为什么需要它:把库加进对话上下文的方式**刻意与「添加上下文文件」完全一致** ——
 * 提示词里只放一行 `@路径`,内容由 agent 用 Read 工具自己读,不预先内联。
 * 所以库需要一个可读的文件来承载"这个库里有哪些文献、各自的 PDF 在哪"。
 */
export const LibraryManifestSchema = z.object({ collectionId: z.string().min(1) });
export type LibraryManifestInput = z.infer<typeof LibraryManifestSchema>;

/** 把一条附件挂到某个会话的**输入框**上(左栏右键「添加到当前对话」)。
 *
 *  `key` 就是附件键,与「+」菜单选择器、以及 AI 的 `library_attach_to_chat`
 * 用的是**同一个**东西:
 *   `c:<分类 id>` —— 挂一个分类(整库清单)
 *   `i:<条目 id>` —— 挂单独一篇(单条清单)
 *
 *  为什么走主进程而不是渲染端直接改 store:消息要发给**指定会话**的输入框,而左栏
 *  与那个输入框不是同一棵组件树。主进程生成清单后再用既有的 `composer:attach`
 *  广播回去,该会话的 ChatPane 自己认领 —— 与 AI 挂库走的是同一条路,所以两边
 *  效果必然一致(用户的要求)。 */
export const LibraryAttachToChatSchema = z.object({
  sessionId: z.string().min(1),
  key: z.string().min(1),
});
export type LibraryAttachToChatInput = z.infer<typeof LibraryAttachToChatSchema>;

/** 全文检索(走 ripgrep,非 SQLite —— sql.js 不含 FTS5)。 */
export const LibraryFullTextSearchSchema = z.object({
  query: z.string().min(1),
  /** 限定在哪些集合内搜;省略则全库。 */
  collectionIds: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type LibraryFullTextSearchInput = z.infer<typeof LibraryFullTextSearchSchema>;

/** 主进程 → 渲染端:某条文献的下载任务状态变了。
 *  界面据此刷新进度条,并在变成 `needs_login` 时提示用户去重新登录。 */
export interface LibraryJobChangedMessage {
  channel: "library:jobChanged";
  itemId: string;
  status: DownloadStatus;
  error?: string;
}

/**
 * 库的内容变了(新建/改名/删除分类、条目进出、改标题、写笔记…)—— 由主进程在任何
 * 一处改动之后广播,渲染端收到就整体重载。
 *
 * ## 为什么非有不可
 *
 * 界面上的库是渲染端自己缓存的一份(`libraryStore`),不是每次渲染都去问主进程。
 * 以前只有**用户自己在界面上操作**会改这份数据,所以缓存永远是对的。现在 AI 也能
 * 改(见 `mcp/libraryServer.ts` 的那套工具)—— 它改的是主进程里那份真相,渲染端的
 * 缓存不会自己知道。少了这条广播,AI 建好的分类在左栏里根本不出现,用户会以为它
 * 没干活。
 *
 * 用户的要求原话:「他对文件系统的操作要和用户在 ui 的操作一样」。
 *
 * 故意做得很粗:只报"变了",不报"变了什么"。细粒度的增量同步要维护两边的状态机,
 * 而重载一次分类树加条目列表是毫秒级的 —— 这里不值得为性能引入出错的可能。
 */
export interface LibraryChangedMessage {
  channel: "library:changed";
  /** 变了什么。只用于日志与排查,渲染端一律整体重载。 */
  reason: string;
}

/**
 * 模版库变了(增 / 删)。
 *
 * 与 `library:changed` 同一个用途、同一个理由:模版有两个入口 —— 左栏那一段和
 * 设置 → 数据位置 → 模版库。用户在后一个入口里加了一条,前一个的缓存不会自己知道
 * (模版库是文件系统,没有 DB 层替它们对账)。少了这条广播,用户会觉得"加了没反应"。
 *
 * 同样故意做得很粗:只报"变了",渲染端整体重扫一遍。
 */
export interface TemplatesChangedMessage {
  channel: "templates:changed";
  /** 变了什么。只用于日志与排查,渲染端一律整体重载。 */
  reason: string;
}

/**
 * 工作流 / 自动化 / 代理档案 / 节点类型变了 —— 由主进程在任何一处改动之后广播,
 * 渲染端收到就重拉列表。
 *
 * 与 `library:changed` 同一个理由:设置里那个工作流库是渲染端自己缓存的一份列表,
 * 以前只有**用户自己在界面上操作**会改它,所以缓存永远是对的。现在 AI 也能改
 * (见 `mcp/mcodeServer.ts` 的那套工具)—— 它改的是数据根里那份真相,渲染端的缓存
 * 不会自己知道。少了这条广播,AI 建好的工作流要等用户关掉设置页再打开才出现,
 * 而用户的原话是「他对文件系统的操作要和用户在 ui 的操作一样」。
 *
 * ⚠️ **渲染端只重拉列表,不重载正在编辑的那一份文档。** 画布上的改动有它自己的保存
 * 时机(拖动后落盘、切走前 flush),被一条外部广播冲掉的话,用户刚拖的那一下会凭空
 * 回去。正在编辑的那份由 `workflow:get` 决定何时读 —— 那是用户的动作,不是广播的。
 */
export interface WorkflowChangedMessage {
  channel: "workflow:changed";
  /** 变了什么。只用于日志与排查,渲染端一律重拉列表。 */
  reason: string;
}

/**
 * 往某次对话的输入框里挂一个附件(文献库分类 / 单篇,或模版库的一条模版)。
 *
 * 两个发起方:AI(走 MCP 工具的 `library_attach_to_chat`)和**用户自己**(左栏
 * 右键「添加到当前对话」)。渲染端收到后按 `makeLibraryTag` / `makeTemplateTag`
 * 造一个同款的 chip 加进输入框的标签区 —— 效果要和用户自己点「+ → 添加到上下文」
 * **逐字一样**:同样能删、同样参与去重、同样随下一条消息作为 `@清单路径` 发出去。
 *
 * 为什么要绕这一圈,而不是让 AI 直接用工具读库:用户要看见。挂上来的东西必须和
 * 他自己挂的长得一样、摆在同一处,否则"AI 到底读了什么"就成了只有 AI 知道的事。
 */
export interface ComposerAttachMessage {
  channel: "composer:attach";
  /** 只挂到发起这次工具调用的那个会话上 —— 别的会话不该凭空多一个附件。 */
  sessionId: string;
  /** 这条附件是哪个库的。渲染端据此选 `appendUniqueLibraryTags` 还是
   *  `appendUniqueTemplateTags` 落成 chip —— 两种 chip 长得不一样、去重键也不同
   *  (文献库是 `c:`/`i:`/`k:` 前缀,模版是 `t:` 前缀),所以不能只靠 key 猜。 */
  kind: "library" | "template";
  /** 附件键,与用户自己挂的同一套:文献库 `c:<分类 id>` / `i:<条目 id>` /
   *  `k:<库>`(整个库),模版 `t:<类目>`(整个类目)/ `t:<类目>/<目录名>`。 */
  key: string;
  /** chip 上显示的短名。 */
  name: string;
  /** 主进程生成的清单绝对路径;渲染端把它包成 `@<路径>` 作为 tag 的 content。 */
  manifestPath: string;
}

/* ──────────────────────────  RPC method map  ───────────────────────────────── */

/** Revoke a paired mobile device. Input to `mobile.revokeDevice`. */
export const RevokeMobileDeviceSchema = z.object({ deviceId: z.string().min(1) });

/** A typed map of all renderer→main RPC invocations. The preload exposes a
 * typed `window.api` matching this shape; the renderer imports it for safety. */
export interface RpcMap {
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
  /** Update the active session's model / effort / permissionMode / customModelId in-place. */
  "session.updateSettings": (input: UpdateSessionSettingsInput) => Promise<void>;
  // Projects
  "project.create": (input: CreateProjectInput) => Promise<{ project: Project }>;
  "project.list": () => Promise<{ projects: Project[] }>;
  "project.sessions": (input: ProjectSessionsInput) => Promise<{ sessions: Session[]; hasMore: boolean; total: number }>;
  /** Cross-project non-archived sessions, newest-first (stream sidebar). */
  "session.listAll": (input: SessionListAllInput) => Promise<{ sessions: Session[]; hasMore: boolean; total: number }>;
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
  /** Discover skills for the composer `/` menu. Scans the user-global
   *  `~/.claude/skills/` plus the active project's `.claude/skills/` and
   *  parses each SKILL.md's frontmatter. Always resolves (degrades to an
   *  empty list on any IO error). */
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
  // MCP management (settings panel)
  /** List all MCP servers across the three sources (user config file, project
   *  .mcp.json, built-in mcode-browser) with their enabled state. */
  "mcp.list": (input: McpListInput) => Promise<{ servers: McpServerEntry[] }>;
  /** Enable/disable a server. User scope moves the config between the config
   *  file and the management stash; project/builtin update the management
   *  state. Takes effect on the next turn. */
  "mcp.toggle": (input: McpToggleInput) => Promise<{ ok: boolean; error?: string }>;
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
  "workflow.get": (input: WorkflowGetInput) => Promise<{ workflow: WorkflowDoc | null }>;
  /** 当前可用的**节点类型**(内置 + 已启用插件 + 用户自写),以及读不进来的清单文件
   *  和它们的错误。画布的"添加节点"菜单用前者;后者必须一起返回,否则用户写错一个
   *  清单,界面上只会看到自己的类型凭空消失。
   *
   *  ⚠️ 无参 handler,同 `workflow.list`:不接 raw、不 parse。 */
  "workflow.nodeTypes": () => Promise<NodeTypeCatalog>;
  /** 存一份。**存盘前过 DAG 校验 + 每个节点的参数校验**,有环/悬空边/参数不合法
   *  直接拒绝 —— 有环的图会让调度器永远等不到就绪节点,那不是报错是静默卡死。 */
  "workflow.save": (input: WorkflowSaveInput) => Promise<{ ok: boolean; error?: string }>;
  /** 删一份。删掉对内置工作流的覆盖 = 「恢复默认」;`wasBuiltin` 让界面能说对话
   *  (「已恢复默认」而不是「已删除」)。 */
  "workflow.remove": (input: WorkflowRemoveInput) => Promise<{ ok: boolean; wasBuiltin: boolean }>;
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
   *  `ok: false` = 没有这样的等待(那张卡片过期了:这次运行已经结束或者被取消)。
   *  **不报错**:点一张旧卡片是正常会发生的事,不该弹错误框。 */
  "workflow.choose": (input: WorkflowChooseInput) => Promise<{ ok: boolean }>;
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
  /** Read the current pending pairing (for the dialog to rehydrate after a
   *  close/reopen). Null when no pairing is active. */
  "mobile.getPairing": () => Promise<{ pairing: { code: string; expiresAt: number } | null }>;
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
  "relay.saveConfig": (input: RelayVpsConfigInput) => Promise<{ ok: true }>;
  /** Read the saved VPS config (passwords included — main→renderer only). */
  "relay.getConfig": () => Promise<{ config: RelayVpsConfig | null }>;
  /** Connect to the VPS: SSH + deploy forwarder + reverse tunnel. */
  "relay.connect": () => Promise<{ ok: boolean; error?: string }>;
  /** Disconnect from the VPS (forwarder keeps running on the VPS). */
  "relay.disconnect": () => Promise<{ ok: true }>;
  /** Read the current relay status. */
  "relay.status": () => Promise<RelayStatus>;

  // 文献库 —— 条目
  /** 列出文献。`collectionId` 为 null/省略表示全部。 */
  "library.list": (input: LibraryListInput) => Promise<{ items: LibraryItem[]; total: number }>;
  /** 单条详情,附带最新一条下载任务(用于推导 PDF 状态)。 */
  "library.get": (input: LibraryItemIdInput) => Promise<{ item: LibraryItem; job: DownloadJob | null }>;
  /** 入库。返回新增/更新后的条目;已存在的(同 doi/arxivId)按更新处理。 */
  "library.addItems": (input: LibraryAddItemsInput) => Promise<{ items: LibraryItem[] }>;
  /** 从库中移除。`deleteFiles` 决定是否连磁盘文件一起删。 */
  "library.deleteItems": (input: LibraryDeleteItemsInput) => Promise<{ items: LibraryItem[] }>;
  /** 排入下载队列。返回受影响的任务列表。 */
  "library.download": (input: LibraryDownloadInput) => Promise<{ jobs: DownloadJob[] }>;
  /** 当前全部下载任务。 */
  "library.jobs": () => Promise<{ jobs: DownloadJob[] }>;
  /** 外部检索(arXiv/Crossref/OpenAlex/Europe PMC),返回候选,不直接入库。 */
  "library.searchExternal": (input: LibrarySearchInput) => Promise<{ results: ExternalSearchResult[] }>;
  /** 导入通道:DOI / arXiv ID / BibTeX 文本。 */
  "library.import": (input: LibraryImportInput) => Promise<{ items: LibraryItem[] }>;
  /** 从**本地 PDF 文件**导入 —— 用户手上大量是下载好的 PDF,没有 DOI 文本可粘。
   *  逐份:校验 → 按 sha256 去重 → 复制进库 → 抽元数据 → 入库 → 可选转 Markdown。 */
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
  /** 把库里的 PDF 转成 Markdown(MinerU 优先,本地 pdf.js 兜底)。 */
  "library.convert": (input: LibraryConvertInput) => Promise<{
    converted: number;
    failed: Array<{ id: string; error: string }>;
  }>;
  /** 在系统文件管理器里定位库里的文件(PDF 或转换出的 Markdown)。
   *  **入参只有条目 id** —— 路径由主进程从库里取,渲染端无从指定任意路径。 */
  "library.revealFile": (input: LibraryRevealFileInput) => Promise<{ ok: boolean; error?: string }>;
  /** 用系统默认程序打开库里的文件 —— 主要用途是看 md 的渲染效果(「打开 md 预览」)。
   *  同样只收条目 id,路径在 main 里拼。 */
  "library.openFile": (input: LibraryOpenFileInput) => Promise<{ ok: boolean; error?: string }>;
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
  /**
   * 导出引用格式到库里的 `exports/` 目录,返回落盘路径。
   *
   * 为什么不弹「另存为」对话框:省一次交互,而且落在库根下和 PDF、Markdown 是
   * 同一个位置 —— 用户要备份/搬库时它跟着一起走。
   */
  "library.exportCitations": (input: LibraryExportInput) => Promise<{
    ok: boolean;
    /** `ok` 为 true 时若还有值,表示**导出成功但没能打开文件夹** —— 文件是好的,
     *  只是"顺手打开"那一步失败了,界面要分开说,不能让用户以为导出也失败了。 */
    error?: string;
    path: string;
    count: number;
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

  // ── 模版库(文件系统即事实源,见 contracts/src/templates.ts) ──
  /** 列模版。不传 kind 就是全部类目。 */
  "templates.list": (input: TemplateListInput) => Promise<{ entries: TemplateEntry[] }>;
  /** 新建一条模版:建目录 + 把 sourcePaths 里的文件/文件夹复制进去。
   *  返回该类目**新的完整列表**(与文献库一致的既定模式)。 */
  "templates.add": (input: TemplateAddInput) => Promise<{ entries: TemplateEntry[] }>;
  /** 给一条模版改名(目录名即显示名,所以改的是磁盘上那个目录)。
   *  `ok:false` 是正常结果(重名 / 已经在磁盘上被删),渲染端把 error 显示出来。 */
  "templates.rename": (input: TemplateRenameInput) => Promise<{
    ok: boolean;
    error?: string;
    entries: TemplateEntry[];
    /** 净化后的新目录名 —— 渲染端据此把"正在预览的那一条"的键也改掉。 */
    dirName?: string;
  }>;
  /** **移进回收站**(可逆)。界面上那个「删除」走的是它 —— 与文献库一样,先留退路,
   *  真正的删除只在回收站里做(`templates.purge`)。`entries` 是该类目的新列表,
   *  `trashed` 是回收站的新列表 —— 一次调用把两边的缓存都换掉。 */
  "templates.trash": (
    input: TemplateEntryRefInput,
  ) => Promise<{ entries: TemplateEntry[]; trashed: TemplateEntry[] }>;
  /** 回收站里的全部模版。`kind` 是它**原来**属于的类目 —— 还原要用。 */
  "templates.trashList": () => Promise<{ trashed: TemplateEntry[] }>;
  /** 从回收站还原回原来的类目。目标位置已被占用时返回 ok:false,不覆盖。 */
  "templates.restore": (
    input: TemplateEntryRefInput,
  ) => Promise<{ ok: boolean; error?: string; entries: TemplateEntry[]; trashed: TemplateEntry[] }>;
  /** 从回收站**彻底删除**(目录连文件一起消失,不可还原)。 */
  "templates.purge": (
    input: TemplateEntryRefInput,
  ) => Promise<{ ok: boolean; error?: string; entries: TemplateEntry[]; trashed: TemplateEntry[] }>;
  /** 读一条模版里的**一个文件**,给应用内预览用。
   *  文本/代码直接给正文,图片给 data URL,其余如实说明为什么看不了。 */
  "templates.readFile": (input: TemplateFileRefInput) => Promise<TemplateFileContent>;
  /** 用系统默认程序打开这个文件。Word / PPT / PDF 这类只能这么看。 */
  "templates.openFile": (input: TemplateFileRefInput) => Promise<{ ok: boolean; error?: string }>;
  /** 在系统文件管理器里定位这条模版的目录。路径由主进程拼,渲染端只给类目+目录名。 */
  "templates.reveal": (input: TemplateEntryRefInput) => Promise<{ ok: boolean; error?: string }>;
  /** 生成/刷新给 AI 读的模版清单,返回它的绝对路径(对话里只放 `@该路径`)。 */
  "templates.manifest": (input: TemplateEntryRefInput) => Promise<{ path: string; fileCount: number }>;
  /** 整个类目的清单(「全部 LaTeX 模版」那一行)。 */
  "templates.kindManifest": (
    input: TemplateKindManifestInput,
  ) => Promise<{ path: string; fileCount: number }>;
  /** 把一条模版挂到指定会话的输入框上(左栏右键「添加到当前对话」)。 */
  "templates.attachToChat": (
    input: TemplatesAttachToChatInput,
  ) => Promise<{ ok: boolean; name?: string; fileCount?: number; error?: string }>;
  "templates.getRoot": () => Promise<{ path: string }>;
  /** 改模版库位置(与文献库同一条规则:只改指向,不搬已有文件)。 */
  "templates.setRoot": (input: { path: string }) => Promise<{ path: string }>;

  // ── 统一数据根 ──
  /** 当前数据根,以及它下面三样东西的**实际路径**(设置页展示用)。 */
  "app.getDataRoot": () => Promise<{
    root: string;
    dbPath: string;
    libraryPath: string;
    templatesPath: string;
  }>;
  /** 把整个数据根迁到新位置,**迁完自动重启应用**(数据库没法原地搬家)。
   *  `ok:false` + `error` 时不重启,设置也不改。 */
  "app.moveDataRoot": (input: { path: string }) => Promise<{ ok: boolean; error?: string }>;
  /** 全文检索(ripgrep;sql.js 不含 FTS5)。 */
  "library.fullTextSearch": (input: LibraryFullTextSearchInput) => Promise<{ matches: FullTextMatch[] }>;
  /** 读当前库根目录。 */
  "library.getRoot": () => Promise<{ path: string }>;
  /** 改库根目录(用户要求「UI 上可以设置文献的位置」)。改完不搬文件,只改指向。 */
  "library.setRoot": (input: LibrarySetRootInput) => Promise<{ path: string }>;
  /** 生成/刷新某个库的清单 Markdown,返回其绝对路径(count = 收录条数)。
   *  清单是给 agent 读的 —— 对话里只放 `@该路径`,与文件附件的机制一致。 */
  "library.manifest": (input: LibraryManifestInput) => Promise<{ path: string; count: number }>;
  /**
   * 给**单独一篇**生成清单 —— 「+」菜单里的选择器可以展开分类、只挑其中一篇。
   * 与整库清单同一套机制:只放一行 `@清单路径`,正文由 agent 自己读。
   */
  "library.itemManifest": (input: LibraryItemManifestInput) => Promise<{
    path: string;
    count: number;
  }>;
  /** 整个库的清单(「全部文献」那一行)。与「一个分类」同一套机制,只是范围是整个库。 */
  "library.kindManifest": (input: LibraryKindManifestInput) => Promise<{
    path: string;
    count: number;
  }>;
  /** 把一条附件挂到指定会话的输入框上(左栏右键「添加到当前对话」)。
   *  与 AI 的 `library_attach_to_chat` 共用同一份实现,所以效果一致。 */
  "library.attachToChat": (
    input: LibraryAttachToChatInput,
  ) => Promise<{ ok: boolean; name?: string; count?: number; error?: string }>;

  // ── 外部服务集成(自带 API Key) ──
  /** 列出目录里每个集成的状态。**密钥明文永远不出现在返回值里**。 */
  "integrations.list": () => Promise<{ integrations: IntegrationPublic[] }>;
  /** 存/换密钥(明文只经这一条通道进来,存完即加密)。 */
  "integrations.setKey": (input: IntegrationSetKeyInput) => Promise<{ integrations: IntegrationPublic[] }>;
  "integrations.clearKey": (input: IntegrationClearKeyInput) => Promise<{ integrations: IntegrationPublic[] }>;
  /** 改非密钥配置(base url / 是否启用)。 */
  "integrations.setConfig": (input: IntegrationSetConfigInput) => Promise<{ integrations: IntegrationPublic[] }>;
  /** 连通性测试 —— 用一次最便宜的调用验证密钥真的能用。 */
  "integrations.test": (input: IntegrationTestInput) => Promise<{ integrations: IntegrationPublic[] }>;

  // 文献库 —— 集合
  "library.listCollections": () => Promise<{ collections: LibraryCollection[] }>;
  /** 新建/改名/删除集合 —— 均返回**完整的新列表**,渲染端整体替换缓存(既定模式)。 */
  "library.createCollection": (input: CollectionCreateInput) => Promise<{ collections: LibraryCollection[] }>;
  /** 改名。`ok: false` 表示重名被拒(此时 collections 不变) —— 由调用方提示用户。 */
  "library.renameCollection": (input: CollectionRenameInput) => Promise<{ collections: LibraryCollection[]; ok: boolean }>;
  "library.deleteCollection": (input: CollectionDeleteInput) => Promise<{ collections: LibraryCollection[] }>;
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
  SESSION_SEARCH: "session:search",
  SESSION_SEARCH_BOOKMARKS: "session:searchBookmarks",
  SESSION_MESSAGES: "session:messages",
  SESSION_SAVE_MESSAGES: "session:saveMessages",
  SESSION_UPSERT_MESSAGES: "session:upsertMessages",
  SESSION_TRUNCATE_AND_INSERT_MESSAGES: "session:truncateAndInsertMessages",
  SESSION_UPDATE_SETTINGS: "session:updateSettings",
  PROVIDER_LIST: "provider:list",
  // Settings
  SETTING_GET: "setting:get",
  SETTING_SET: "setting:set",
  SETTING_GET_MANY: "setting:getMany",
  // 文献库 —— 条目
  LIBRARY_LIST: "library:list",
  LIBRARY_GET: "library:get",
  LIBRARY_ADD_ITEMS: "library:addItems",
  LIBRARY_DELETE_ITEMS: "library:deleteItems",
  LIBRARY_DOWNLOAD: "library:download",
  LIBRARY_JOBS: "library:jobs",
  LIBRARY_SEARCH_EXTERNAL: "library:searchExternal",
  LIBRARY_IMPORT: "library:import",
  LIBRARY_FULL_TEXT_SEARCH: "library:fullTextSearch",
  LIBRARY_GET_ROOT: "library:getRoot",
  LIBRARY_SET_ROOT: "library:setRoot",
  // 外部服务集成(自带 API Key)
  INTEGRATIONS_LIST: "integrations:list",
  INTEGRATIONS_SET_KEY: "integrations:setKey",
  INTEGRATIONS_CLEAR_KEY: "integrations:clearKey",
  INTEGRATIONS_SET_CONFIG: "integrations:setConfig",
  INTEGRATIONS_TEST: "integrations:test",
  // 文献库:PDF 文件导入 / 转 Markdown
  LIBRARY_IMPORT_FILES: "library:importFiles",
  /** 导入 Markdown 笔记(笔记库)。 */
  LIBRARY_IMPORT_NOTES: "library:importNotes",
  LIBRARY_CONVERT: "library:convert",
  LIBRARY_REVEAL_FILE: "library:revealFile",
  LIBRARY_OPEN_FILE: "library:openFile",
  LIBRARY_CONVERSION_STATS: "library:conversionStats",
  LIBRARY_CONVERSION_REPORT: "library:conversionReport",
  // 统一数据根
  APP_GET_DATA_ROOT: "app:getDataRoot",
  APP_MOVE_DATA_ROOT: "app:moveDataRoot",
  // 模版库
  TEMPLATES_LIST: "templates:list",
  TEMPLATES_ADD: "templates:add",
  /** 给一条模版改名(把目录改名)。 */
  TEMPLATES_RENAME: "templates:rename",
  /** 移进回收站(可逆)。界面上那个「删除」走它。 */
  TEMPLATES_TRASH: "templates:trash",
  TEMPLATES_TRASH_LIST: "templates:trashList",
  /** 从回收站还原回原来的类目。 */
  TEMPLATES_RESTORE: "templates:restore",
  /** 从回收站彻底删除(不可还原)。 */
  TEMPLATES_PURGE: "templates:purge",
  /** 读一条模版里的一个文件(应用内预览)。 */
  TEMPLATES_READ_FILE: "templates:readFile",
  /** 用系统默认程序打开模版里的一个文件。 */
  TEMPLATES_OPEN_FILE: "templates:openFile",
  TEMPLATES_REVEAL: "templates:reveal",
  TEMPLATES_MANIFEST: "templates:manifest",
  /** 整个类目的清单(「全部<类目>」那一行)。 */
  TEMPLATES_KIND_MANIFEST: "templates:kindManifest",
  /** 把一条模版挂到指定会话的输入框上(左栏右键「添加到当前对话」)。 */
  TEMPLATES_ATTACH_TO_CHAT: "templates:attachToChat",
  /** 模版库变了(增 / 删)。与文献库那条广播同一个用途:设置页里加了一条模版之后,
   *  左栏那一段的缓存不会自己知道 —— 少了它,用户会觉得"加了没反应"。 */
  TEMPLATES_CHANGED: "templates:changed",
  TEMPLATES_GET_ROOT: "templates:getRoot",
  TEMPLATES_SET_ROOT: "templates:setRoot",
  LIBRARY_ITEM_MANIFEST: "library:itemManifest",
  /** 整个库的清单(「全部<库>」那一行)。 */
  LIBRARY_KIND_MANIFEST: "library:kindManifest",
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
  /** 导出引用格式(GB/T 7714 / APA / BibTeX)到库根的 `exports/`。 */
  LIBRARY_EXPORT_CITATIONS: "library:exportCitations",
  // 文献库 —— 集合
  LIBRARY_LIST_COLLECTIONS: "library:listCollections",
  LIBRARY_CREATE_COLLECTION: "library:createCollection",
  LIBRARY_RENAME_COLLECTION: "library:renameCollection",
  LIBRARY_DELETE_COLLECTION: "library:deleteCollection",
  LIBRARY_ASSIGN_COLLECTION: "library:assignCollection",
  // 机构认证
  INSTITUTION_LIST: "institution:list",
  INSTITUTION_SAVE: "institution:save",
  INSTITUTION_DELETE: "institution:delete",
  INSTITUTION_AUTH_STATUS: "institution:authStatus",
  INSTITUTION_CLEAR_COOKIES: "institution:clearCookies",
  /** Main → renderer push:下载任务状态变化(进度/失败/需要登录)。 */
  LIBRARY_JOB_CHANGED: "library:jobChanged",
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
  // Skill discovery for the composer `/` menu (scans ~/.claude/skills + project)
  SKILLS_LIST: "skills:list",
  // Skill management (settings panel): read / save / delete a single skill
  SKILLS_READ: "skills:read",
  SKILLS_SAVE: "skills:save",
  SKILLS_DELETE: "skills:delete",
  // Skill import (settings panel): scan external tools + copy into ~/.mcode/skills
  SKILLS_SCAN_SOURCES: "skills:scanSources",
  SKILLS_IMPORT: "skills:import",
  // MCP management (settings panel): list / toggle / add / remove / import
  MCP_LIST: "mcp:list",
  MCP_TOGGLE: "mcp:toggle",
  MCP_AUTHORIZE: "mcp:authorize",
  MCP_UNAUTHORIZE: "mcp:unauthorize",
  MCP_SAVE: "mcp:save",
  MCP_REMOVE: "mcp:remove",
  MCP_SCAN_IMPORT: "mcp:scanImport",
  MCP_IMPORT: "mcp:import",
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
  WORKFLOW_NODE_TYPES: "workflow:nodeTypes",
  WORKFLOW_SAVE: "workflow:save",
  WORKFLOW_REMOVE: "workflow:remove",
  // 代理档案:一份存下来的子 agent 配置,建节点时直接套用(见 contracts/agentProfile.ts)
  WORKFLOW_AGENT_PROFILES: "workflow:agentProfiles",
  WORKFLOW_SAVE_AGENT_PROFILE: "workflow:saveAgentProfile",
  WORKFLOW_REMOVE_AGENT_PROFILE: "workflow:removeAgentProfile",
  /** 在岔路口选一条路 —— **回答一个还活着的运行**,不是开一次新的。 */
  WORKFLOW_CHOOSE: "workflow:choose",
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
  MOBILE_GET_PAIRING: "mobile:getPairing",
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
