/**
 * 技能发现 / 编辑 / 外部工具导入 + 输出风格列表。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";
import type { ProviderCapabilities } from "../provider.js";

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

