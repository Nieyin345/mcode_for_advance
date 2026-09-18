/**
 * 持久化偏好键 + 通用 setting.get/set/getMany 的 RPC schema。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。这里的键都是「设置表里的一个知名键」:
 * 渲染端首屏 getMany 批量取、各面板写回。新增一个偏好键 → 改这一个文件。
 */

import { z } from "zod";

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
 * Setting key persisting the per-turn BUDGET CAPS, as a JSON object
 * `{ maxTurns?: number; maxUsd?: number; maxTotalTokens?: number }`. Absent,
 * empty object, or malformed JSON = caps off (default). Read fresh by
 * RuntimeManager at every sendTurn, so a settings change applies from the
 * NEXT turn on; a turn already in flight keeps the caps it started with.
 * When a cap is crossed mid-turn the host emits `turn.notice`
 * (kind="budget_limit") and interrupts via the normal stop path.
 */
export const TURN_BUDGET_SETTING_KEY = "runtime.turnBudget";

/**
 * Setting key persisting the FAILURE FALLBACK CHAIN, as a JSON array of model
 * ids (same shape as `session.model`, e.g. "provider/model" or a built-in id).
 * When a turn ends with reason="error", RuntimeManager retries it on the next
 * model in the chain (chat sessions only — workflow nodes are excluded to
 * avoid holdTurnEnd / scheduler entanglement). Absent, malformed, or empty =
 * no fallback (default). Read fresh at every sendTurn, so a settings change
 * applies from the NEXT turn on; the remaining chain drains across retries
 * within one turn's failure episode.
 */
export const RUNTIME_FALLBACK_MODELS_SETTING_KEY = "runtime.fallbackModels";

/**
 * Setting key persisting CUSTOM SUBAGENT definitions for the Claude provider,
 * as a JSON array of `{ name; description; prompt; tools?; model? }` objects
 * (see SubagentDefinition in main/claude/subagentStore.ts). Read fresh at
 * every claude-sdk startTurn and forwarded as the SDK's `Options.agents`.
 * Only the Claude provider consumes this key — the Settings page shows the
 * editor only for providers whose capabilities declare
 * `supportsCustomSubagents`.
 */
export const CLAUDE_SUBAGENTS_SETTING_KEY = "claude.subagents";

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
 *  —— 文献库是被左栏点击唤起的,不该在启动时自己占住右栏。
 *
 *  ⚠️ **"flow" 加在这里,hydrate 那里也要加一行**(`sessionStore` 里那个
 *  `if (tabRaw === ...)` 白名单)。只在 schema 上加的话,用户选了它、重启之后右栏
 *  悄悄回到 files —— 而没有任何地方说为什么。 */
export const RightPanelTabSchema = z.enum(["files", "git", "browser", "turns", "sidechat", "library", "templates", "flow"]);
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
 * **在线检索的每源默认条数** —— `library_search_online` 工具没收到 `limit` 参数时
 * 用的兜底值(见 `main/mcp/libraryServer.ts`)。检索条件(含每源条数)的正式定义
 * 已经搬进主对话节点的「固定条件」参数(`@contracts/nodeType`),随运行提示词进
 * 模型;这里只剩工具层的最后一级兜底。
 */
export const SEARCH_LIMIT_SETTING_KEY = "search.perSourceLimit";

/**
 * **工作流固定条件的选中值** —— 键是**前缀 + workflowId**,值是 JSON
 * `{ [条件名]: 选中值 }`(条件表定义在主对话节点的 `NODE_CRITERIA_PARAM_KEY`
 * 参数上,见 `@contracts/nodeType`)。
 *
 * 固定条件是"一贯的习惯",**那次对话的第一轮**随运行提示词注入一次(拼法见
 * `main/lib/searchPrefs.ts` 的 `nodeCriteriaPrompt`),之后它已经在上下文里,不再
 * 重复注入;值为"不限"(或空串)的条件跳过不注。按 workflowId 分键,换流程
 * 互不串扰。曾经并存的工作流输入选项选中项键(`workflow.nodeOption.`)已随那套
 * 机制一起删掉(2026-09-19);残留在设置表里的旧键没人再读,无害。
 */
export const WORKFLOW_NODE_PREFS_SETTING_PREFIX = "workflow.nodePrefs.";

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

