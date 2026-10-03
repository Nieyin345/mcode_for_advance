/**
 * 技能发现 / 编辑 / 外部工具导入 + 输出风格列表。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";
import type { ProviderCapabilities } from "../provider.js";

/* ── Skill discovery (composer slash-command menu) ──
 *  The composer's `/` menu lists skills discovered by scanning the local
 *  filesystem (`~/.mcode/skills/` — the one universal library all three
 *  engines consume — plus plugin contributions). Each skill's SKILL.md
 *  frontmatter supplies the name + description; we don't depend on a running
 *  SDK session for the listing, so the menu is instant. Selecting a skill
 *  inserts `/name` into the textarea and the user sends it as a normal turn
 *  (the engine recognizes and runs the skill).
 *
 *  项目级根（<cwd>/.claude/skills）已随上下文统一托管移除：外部工作区目录
 *  一律不再继承，Mcode 不往用户项目目录读写任何 skill 文件。 */

/** Where a composer skill was discovered. "plugin" = contributed by an
 *  ENABLED plugin (read-only inventory: the composer menu lists it and the
 *  engine loads it per-turn, but it has no user-editable file root — the
 *  skills read/save/delete handlers reject this source). "builtin" = shipped
 *  inside the app itself — **RETIRED 2026-09-20**: the four document skills were
 *  removed (the user imports skill packs from GitHub instead). The constant is
 *  kept so previously-written matrix keys and stale rows still parse; nothing
 *  produces it any more. "project" = the **current project's** own skills dir
 *  (`<项目>/.claude/skills/`) — writable, see {@link SKILL_WRITE_SOURCES}. */
export const SKILL_READ_SOURCES = ["global", "project", "plugin", "builtin"] as const;
export type SkillSource = (typeof SKILL_READ_SOURCES)[number];

/**
 * The sources a skill can be WRITTEN to.
 *
 *  - **`global`** — 通用库（`~/.mcode/skills`），三个引擎共用的那一份。
 *  - **`project`** — **当前项目目录**下的 `<项目>/.claude/skills/`。
 *
 * ## 为什么项目级又回来了（2026-09-20）
 *
 * 这里从前**只有 `global`**，而 `skills.list` 收到的 `projectPath` 是被**刻意忽略**
 * 的 —— 当时的取舍是"Mcode 不往用户项目目录读写任何 skill 文件"。用户 2026-09-20
 * 推翻了它：他要的正是"skill 能跟着项目走、能分享给同事"，那只有落在项目目录里才成立。
 *
 * 路径选 `<项目>/.claude/skills/` 而不是 `.mcode/skills/`：这是 Claude Code 的既定
 * 约定，三个引擎的加载路径本来就认它；放在自己起的目录名下等于让同事的别的工具读不到。
 *
 * ⚠️ **这意味着 Mcode 会往用户的项目目录写文件。** 所以写操作必须带 `projectPath`
 * （没有它就没有"项目"可言），主进程侧一律做逃逸校验（见 `main/ipc/skills.ts` 的
 * `projectSkillsRoot`）。
 *
 * Contributed skills are replaced by a plugin update or an app upgrade, never by
 * this editor, so save/delete reject them at the schema level (not just in the
 * handler), and the UI hides the buttons.
 */
export const SKILL_WRITE_SOURCES = ["global", "project"] as const;

/** The sources that have no user-editable file root. Kept as one exported
 *  alias so the renderer's editor type and the main-side read/save/delete
 *  guard can never drift apart on which sources are read-only.
 *
 *  ⚠️ 判据是"在不在 `SKILL_WRITE_SOURCES` 里",不是这里这个联合写死了哪几个 ——
 *  所以加 `project` 之后它自动变成只读集的反面,不用改。 */
export type ReadOnlySkillSource = Exclude<SkillSource, (typeof SKILL_WRITE_SOURCES)[number]>;

/** The three engines the universal skill library can be gated per. Mirrors
 *  main's skillEngines matrix (contracts can't import app code — keep the
 *  two lists in sync). */
export const SKILL_ENGINE_IDS = ["claude", "codex", "pi"] as const;
export type SkillEngineId = (typeof SKILL_ENGINE_IDS)[number];

/** Resolved per-engine state for one skill — always complete (the main side
 *  fills defaults), so the UI never needs to know the "missing = enabled"
 *  rule of the underlying matrix file. */
export interface SkillEngineState {
  claude: boolean;
  codex: boolean;
  pi: boolean;
}

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
 *  fields the engine's own `SlashCommand` exposes (name / description /
 *  argumentHint) plus a `source` discriminator so the UI can show where a
 *  skill came from. */
export interface SkillInfo {
  /** Skill name without the leading slash (e.g. "pdf"). Used as the slash
   *  command the user sends, and as the dedupe key. */
  name: string;
  /** Short description from SKILL.md frontmatter (may be empty when absent). */
  description: string;
  /** Hint for skill arguments (e.g. "<file>"), when present in frontmatter. */
  argumentHint?: string;
  /** Where the skill was discovered: the universal library or a plugin. */
  source: SkillSource;
  /** Per-engine availability — set for `source: "global"` AND `source:
   *  "plugin"` rows (both kinds of contributions are matrix-managed so an
   *  engine only sees what was assigned to it; plugin rows stay read-only
   *  apart from these switches). Builtin rows omit it (always offered).
   *  Absent flags mean enabled (missing = enabled). */
  perEngine?: SkillEngineState;
  /** Plugin rows only: the plugin that contributes this skill. */
  pluginName?: string;
  /** Plugin rows only: the plugin-level engine switches (Plugins panel). An
   *  engine switched off there never receives the skill, whatever
   *  `perEngine` says — the panel greys that switch. */
  pluginEngines?: SkillEngineState;
}

/** List discovered skills. With projectPath, the selected project's skills
 *  override same-name global entries (composer semantics). The global library
 *  editor omits projectPath so its independent global copies remain visible.
 *  Hidden containers and folders without a readable SKILL.md are not skills. */
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

/** Set one universal skill's per-engine availability (「移动到引擎内部 /
 *  移回通用」= editing this matrix; skill files never move). All three
 *  booleans are sent every time — the desired end state, not a delta. */
export const SkillsEnginesSetSchema = z.object({
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
  claude: z.boolean(),
  codex: z.boolean(),
  pi: z.boolean(),
});
export type SkillsEnginesSetInput = z.infer<typeof SkillsEnginesSetSchema>;

/** One import bundle — the group a skill arrived with. The bundle manifest
 *  (.bundles.json in the universal library root) records which source
 *  directory each skill was imported from, so the settings panel can group
 *  them by origin ("这是哪个包的") and toggle a whole group per engine in
 *  ONE call. Skills created in Mcode itself are absent from the manifest —
 *  the panel shows those under their own group. */
export interface SkillBundle {
  /** Stable id, e.g. "scientific-agent-skills". Order in the manifest is
   *  the display order. GitHub imports use `<owner>--<repo>`. */
  id: string;
  /** Human-readable label shown as the group title — for GitHub imports the
   *  `owner/repo` pair, for pre-existing bundles the package's own name. */
  label: string;
  /** Skill names (directories under the universal library) in this bundle. */
  skills: string[];
  /** Origin URL when the bundle arrived via GitHub import. Purely
   *  informational (tooltip / provenance display). */
  source?: string;
}

/** Read the bundle manifest. Always resolves; a missing or unparsable
 *  manifest degrades to an empty list — bundling is a display concern and
 *  must never hard-fail the panel. */
export const SkillsBundlesSchema = z.object({});
export type SkillsBundlesInput = z.infer<typeof SkillsBundlesSchema>;

/** Set the per-engine availability for MANY skills in one call — the
 *  settings panel's group-level switches write a whole bundle at once
 *  (looping 166 single-skill IPCs would thrash the matrix file). Same
 *  semantics as enginesSet, applied to every name; names that don't exist
 *  on disk are silently skipped (the manifest may lag deletions). */
export const SkillsEnginesSetBulkSchema = z.object({
  names: z.array(z.string().regex(SKILL_NAME_RE, "invalid skill name")).min(1),
  claude: z.boolean(),
  codex: z.boolean(),
  pi: z.boolean(),
});
export type SkillsEnginesSetBulkInput = z.infer<typeof SkillsEnginesSetBulkSchema>;

/** Read the complete SKILL.md source without truncation. Project reads require
 *  an absolute projectPath. The logical name is resolved through discovery,
 *  not assumed to equal a folder name. Missing/unreadable files reject; only
 *  an actual empty file returns empty content. New skills use skills.save. */
export const SkillsReadSchema = z.object({
  projectPath: z.string().optional(),
  /** Which skills root to read from. Wider than the write schemas below:
   *  contributed skills (enabled plugins + the built-in plugin) have no
   *  writable root but ARE readable — the settings panel shows a built-in
   *  skill's SKILL.md read-only. */
  source: z.enum(SKILL_READ_SOURCES),
  /** Discovered logical name (frontmatter name or directory fallback). */
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
});
export type SkillsReadInput = z.infer<typeof SkillsReadSchema>;

/** Write (create or overwrite) a skill's SKILL.md. Creates the skill directory
 *  if absent; always writes the full file content (complete overwrite).
 *  `newName` is reserved for future rename support (when set and differs from
 *  `name`, the skill directory is moved first); v1 UI leaves it unset. */
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
 *  directory the whole skill folder is removed recursively. */
export const SkillsDeleteSchema = z.object({
  projectPath: z.string().optional(),
  source: z.enum(SKILL_WRITE_SOURCES),
  name: z.string().regex(SKILL_NAME_RE, "invalid skill name"),
});
export type SkillsDeleteInput = z.infer<typeof SkillsDeleteSchema>;

/**
 * **把技能复制到项目**（通用库 → `<项目>/.claude/skills/`）。
 *
 * ## 为什么是"复制"而不是"移动"或"引用"
 *
 *  - **不移动**：通用库是三个引擎共用的那一份，搬走就等于把它从所有别的项目里
 *    抽走了。
 *  - **不引用**：引用的表现是"总库里改了、项目里跟着变"，而用户要项目技能的
 *    理由恰恰是**项目要有自己的一份**（跟着 git 走、能改成本项目专用的版本、
 *    能分享给同事）。引用做不到这三件事里的任何一件。
 *
 * 代价是**复制之后两边脱钩** —— 这是刻意的，不是缺陷。界面上要把这件事说出来
 * （"已复制"），别让用户以为它还在跟着总库走。
 *
 * ## 批量
 *
 * `names` 是列表，因为面板支持勾选多个一起复制。**单个失败不影响其余的** ——
 * 重名、非法名各自进 `failed`，成功的照常复制（与 `skills.import` 同一个口径：
 * 一条坏的不该让整批停摆）。
 */
export const SkillsCopyToProjectSchema = z.object({
  /** 项目根目录（绝对路径）。没有它就没有"项目"可言。 */
  projectPath: z.string().min(1),
  /** 要复制的逻辑技能名（由宿主解析实际目录）。 */
  names: z.array(z.string().regex(SKILL_NAME_RE, "invalid skill name")).min(1),
});
export type SkillsCopyToProjectInput = z.infer<typeof SkillsCopyToProjectSchema>;

/** 复制的结果。刻意**逐条**回报，不是一句 ok —— 批量复制里"哪几个成了、
 *  哪几个重名跳过了"是用户真正要看的东西。 */
/* ────────────────────── 技能预设（"一套技能"） ────────────────────── */

/**
 * **一套技能预设。** 给"我这类项目默认装这几个技能"用 —— 用户的原话是
 * 「之后会有很多的项目」。
 *
 * ## 为什么不是"项目列表"，而是一套一套的预设
 *
 * 项目一多，真正会重复发生的动作是**"给新项目配上那几个"**，而不是"盯着二十个
 * 项目比对差异"。后者只能让你看见重复，前者能直接消掉重复。
 *
 * ## 它只是一张清单，不是一份拷贝
 *
 * 预设里存的是**技能名**，不存文件内容。复制那一刻才去通用库取 —— 所以改了通用
 * 库里的技能，下次用这套预设复制过去的就是新的。这一条是刻意的：预设是"要哪几个"，
 * 不是"那几个长什么样"。
 */
export interface SkillPreset {
  /** 稳定 id，`sp_` 前缀 + 随机。 */
  id: string;
  /** 显示名，用户自己起（"论文项目"、"代码项目"）。 */
  name: string;
  /** 这套要装哪几个技能（通用库里的目录名）。 */
  skills: string[];
  /** 一句话说明，可空。 */
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export const SkillsPresetSaveSchema = z.object({
  preset: z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(60),
    skills: z.array(z.string().regex(SKILL_NAME_RE, "invalid skill name")),
    description: z.string().max(200).optional(),
  }),
});
export type SkillsPresetSaveInput = z.infer<typeof SkillsPresetSaveSchema>;

export const SkillsPresetDeleteSchema = z.object({
  id: z.string().min(1),
});
export type SkillsPresetDeleteInput = z.infer<typeof SkillsPresetDeleteSchema>;

/* ────────────────────── 跨项目总览 ────────────────────── */

/** 一个项目、它装了哪些技能。 */
export interface ProjectSkillRow {
  projectId: string;
  projectName: string;
  /** 项目根路径（绝对）。 */
  path: string;
  /** 这个项目 `<项目>/.claude/skills/` 下的技能名。 */
  skills: string[];
  /** 目录不存在（这个项目还没放过技能）—— 与"有目录但是空的"分开报，
   *  因为前者是绝大多数项目的常态，界面不该把它画成异常。 */
  missing: boolean;
}

/** 跨项目总览的入参。`projectIds` 省略 = 全部项目。 */
export const SkillsProjectOverviewSchema = z.object({
  projectIds: z.array(z.string()).optional(),
});
export type SkillsProjectOverviewInput = z.infer<typeof SkillsProjectOverviewSchema>;

export interface SkillsProjectOverviewResult {
  rows: ProjectSkillRow[];
  /** 扫不动的那几个（目录没权限、路径没了），单独回报而不是静默跳过。 */
  problems: Array<{ projectId: string; projectName: string; error: string }>;
}

export interface SkillsCopyToProjectResult {
  /** 真的复制过去的技能名。 */
  copied: string[];
  /** 目标已有同名目录、按"不覆盖"处理而跳过的。 */
  skipped: Array<{ name: string; reason: string }>;
  /** 失败的（读不到源、写不进去）。 */
  failed: Array<{ name: string; reason: string }>;
}

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

/** Import a WHOLE skill package from a GitHub repository URL in one call —
 *  "贴一个链接进来,导出来就是一类". The repo is shallow-cloned, every
 *  SKILL.md inside it is discovered (nested layouts welcome — one repo
 *  usually packages many sub-skills), and each skill directory is copied
 *  into the universal library. All imported skills land in ONE bundle
 *  (`<owner>--<repo>`), so the panel manages the package as a group. */
export const SkillsImportGithubSchema = z.object({
  /** GitHub repository URL. Accepted shapes: full https URL
   *  (github.com/<owner>/<repo>[.git][/tree/<branch>]), or the bare
   *  "<owner>/<repo>" shorthand (defaults to the default branch). */
  url: z.string().min(1),
});
export type SkillsImportGithubInput = z.infer<typeof SkillsImportGithubSchema>;

/** Result of a GitHub package import — mirrors the local import's
 *  per-skill lists plus the bundle the skills landed in. */
export interface SkillsImportGithubResult {
  ok: boolean;
  /** Human-readable failure reason when ok is false (URL parse, clone
   *  failure, no SKILL.md found anywhere in the repo, ...). */
  error?: string;
  imported: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
  /** The bundle id the imported skills were grouped under. */
  bundleId?: string;
  /** The bundle label (owner/repo). */
  bundleLabel?: string;
}

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


/* ── Skill market (settings panel, 「市场」tab) ──
 *  Same model as the plugin marketplaces: a market is a git repository (or a
 *  local directory) holding skills — every directory with a SKILL.md is one
 *  entry. Catalogs are cloned under ~/.mcode/skill-markets/<name>; installing
 *  copies the skill directory into the universal library (~/.mcode/skills)
 *  and files it under one bundle per market. Two catalogs ship built in
 *  (anthropics/skills, openai/skills); they are fetched the first time the
 *  user opens them. */

export interface SkillMarketEntry {
  market: string;
  /** Skill name (directory name / frontmatter name). */
  name: string;
  description: string;
  /** Path inside the catalog, for display ("skills/pdf"). */
  relPath: string;
  /** A skill with this name already exists in the universal library. */
  installed: boolean;
}

export interface SkillMarketState {
  name: string;
  sourceKind: "git" | "local";
  sourceRef: string;
  builtin: boolean;
  /** The catalog tree has been fetched at least once. */
  cloned: boolean;
  fetchedAt?: string;
  skills: SkillMarketEntry[];
}

export const SKILL_MARKET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const SkillsMarketListSchema = z.object({});
export type SkillsMarketListInput = z.infer<typeof SkillsMarketListSchema>;

export const SkillsMarketAddSchema = z.object({
  kind: z.enum(["git", "local"]),
  /** GitHub `owner/repo`, any git URL, or an absolute local directory. */
  ref: z.string().min(1).max(2000),
  name: z.string().regex(SKILL_MARKET_NAME_RE).optional(),
});
export type SkillsMarketAddInput = z.infer<typeof SkillsMarketAddSchema>;

export const SkillsMarketNameSchema = z.object({ name: z.string().regex(SKILL_MARKET_NAME_RE) });
export type SkillsMarketNameInput = z.infer<typeof SkillsMarketNameSchema>;

export const SkillsMarketInstallSchema = z.object({
  market: z.string().regex(SKILL_MARKET_NAME_RE),
  names: z.array(z.string().min(1)).min(1).max(500),
});
export type SkillsMarketInstallInput = z.infer<typeof SkillsMarketInstallSchema>;

export interface SkillsMarketInstallResult {
  ok: boolean;
  error?: string;
  imported: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}
