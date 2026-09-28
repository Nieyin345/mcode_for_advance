/**
 * Per-engine enablement matrix for the universal skill library.
 *
 * `~/.mcode/skills` is the ONE skill store shared by all three engines
 * (claude / codex / pi). The central mapping `<skillsRoot>/.mcode-engines.json`
 * says, per skill, which engines may see it:
 *
 *     { "my-skill": { "codex": false, "pi": false } }   // internal to claude
 *     { }                                               // (entry absent = all on)
 *
 * ## Semantics (deliberately "missing = enabled")
 *
 * - A skill with NO entry in the map is enabled everywhere — that is also the
 *   state of every newly created / imported skill, so the common case never
 *   touches this file at all.
 * - Within an entry, a MISSING engine key means enabled. When persisting, we
 *   keep only the `false` keys: "internal to claude" is `{codex:false,pi:false}`,
 *   and an entry that ends up with no `false` keys is deleted outright. The
 *   file therefore only ever carries the user's actual restrictions.
 *
 * 「引擎内部 skill」(the user's words) = an entry that enables exactly one
 * engine;「移动到引擎内部 / 移回通用」= editing that entry — skill files never
 * move on disk.
 *
 * ## Pure core
 *
 * No electron import; every path comes in as a parameter (or from
 * {@link defaultSkillsRoot}, which only uses `os.homedir`). Headless smokes
 * bundle this file directly. The SKILL.md frontmatter name parser lives here
 * too (`skillNamesInRoot`) because both the settings listing and the engine
 * providers need "which names does the library actually carry", and name
 * resolution must agree everywhere.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { atomicWrite } from "./appContext.js";
import { SKILL_NAME_RE } from "@contracts/ipc/skills";

export const SKILL_ENGINES = ["claude", "codex", "pi"] as const;
export type SkillEngine = (typeof SKILL_ENGINES)[number];

/** One skill's raw matrix entry — only `false` keys are ever persisted. */
export type SkillEngineEntry = Partial<Record<SkillEngine, boolean>>;

/** The whole mapping: skill name → entry. Absent name = enabled everywhere. */
export type SkillEnginesMap = Record<string, SkillEngineEntry>;

/** The universal library root (Mcode's CLAUDE_CONFIG_DIR skills dir). */
export function defaultSkillsRoot(): string {
  return path.join(homedir(), ".mcode", "skills");
}

/** Central mapping file: `<skillsRoot>/.mcode-engines.json`. */
export function enginesMapPath(skillsRoot: string): string {
  return path.join(skillsRoot, ".mcode-engines.json");
}

/** Drop everything but the `false` keys; `null` when nothing is disabled
 *  (the entry should be deleted rather than stored). */
export function minimizeEntry(entry: SkillEngineEntry): SkillEngineEntry | null {
  const out: SkillEngineEntry = {};
  for (const engine of SKILL_ENGINES) {
    if (entry[engine] === false) out[engine] = false;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Read the mapping from an explicit file path (the pure core; the skills-root
 * wrapper is {@link readEnginesMap}). Any IO/parse problem → empty map (every
 * skill enabled) — a broken matrix file must never take all skills offline.
 * Entries that don't validate (non-object / non-boolean engine values) are
 * dropped individually.
 */
export function readEnginesMapFile(file: string): SkillEnginesMap {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: SkillEnginesMap = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = minimizeEntry(value as SkillEngineEntry);
    if (entry) out[name] = entry;
  }
  return out;
}

/** Read the mapping under a skills root. See {@link readEnginesMapFile}. */
export function readEnginesMap(skillsRoot: string): SkillEnginesMap {
  return readEnginesMapFile(enginesMapPath(skillsRoot));
}

/** Write the mapping to an explicit file path (pretty-printed). See
 *  {@link writeEnginesMap} for the skills-root wrapper. */
export function writeEnginesMapFile(file: string, map: SkillEnginesMap): void {
  atomicWrite(file, JSON.stringify(map, null, 2) + "\n");
}

/** Write the mapping (pretty-printed). Creates the skills root if absent. */
export function writeEnginesMap(skillsRoot: string, map: SkillEnginesMap): void {
  writeEnginesMapFile(enginesMapPath(skillsRoot), map);
}

/** Is `name` enabled for `engine`? Entry absent / key absent → true. Accepts
 *  a string so the same function serves skill (claude/codex/pi) and MCP
 *  (claude/codex) matrices without callers each casting a literal union. */
export function engineEnabled(
  map: Record<string, SkillEngineEntry>,
  name: string,
  engine: string,
): boolean {
  return map[name]?.[engine as SkillEngine] !== false;
}

/** True when at least one skill disables `engine` — the signal for providers
 *  to switch from "discover everything" to an explicit allowlist. */
export function engineRestricted(map: SkillEnginesMap, engine: SkillEngine): boolean {
  return Object.values(map).some((entry) => entry[engine] === false);
}

/**
 * Set a skill's engine state (the full desired {claude,codex,pi} booleans —
 * the renderer sends all three). Persists the minimal entry: only `false`
 * keys; the entry is deleted entirely when nothing is disabled (back to the
 * "absent = all engines" default). Mutates and returns the same map.
 */
export function setEnginesEntry(
  map: SkillEnginesMap,
  name: string,
  wanted: Record<SkillEngine, boolean>,
): SkillEnginesMap {
  const entry = minimizeEntry(wanted);
  if (entry) map[name] = entry;
  else delete map[name];
  return map;
}

/**
 * Parse the YAML frontmatter of a SKILL.md for the fields the app needs
 * (`name`, `description`, optional `argument-hint`/`argumentHint`) — a hand-
 * rolled line scan, no yaml dependency. Returns {} for files without
 * frontmatter; callers fill in fallbacks (name ← directory name).
 */
export function parseSkillFrontmatter(md: string): {
  name?: string;
  description?: string;
  argumentHint?: string;
} {
  // Frontmatter must be the very first thing in the file: "---\n".
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return {};
  // Find the closing "---" on its own line. Split on newlines so the leading
  // "---" line isn't matched by the closing fence regex.
  const lines = md.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return {};
  const fm = lines.slice(1, end);

  const out: { name?: string; description?: string; argumentHint?: string } = {};
  for (const raw of fm) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    // Strip surrounding quotes (single/double) and trailing whitespace.
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === "name") out.name = val;
    else if (key === "description") out.description = val;
    else if (key === "argument-hint" || key === "argumenthint") out.argumentHint = val;
  }
  return out;
}

/**
 * Scan one skills root: skill name → directory. A skill is a direct child
 * directory carrying SKILL.md; the frontmatter `name` (or the directory name
 * as fallback) is the identity engines match on. Hidden containers, invalid
 * names and directories without a readable SKILL.md are excluded. Symlinks
 * are followed for reads; returned paths retain the link identity. First
 * occurrence wins on name collisions; never throws.
 */
export function skillNamesInRoot(rootDir: string): Map<string, string> {
  const byName = new Map<string, string>();
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return byName;
  }
  for (const entry of entries) {
    // Hidden containers such as Codex's .system are not individual skills.
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = path.join(rootDir, entry.name);
    try {
      // Follow links for discovery, but return the lexical directory below:
      // deleting a linked skill must unlink it, never delete the real target.
      if (!statSync(dir).isDirectory()) continue;
      const file = path.join(dir, "SKILL.md");
      if (!statSync(file).isFile()) continue;
      const md = readFileSync(file, "utf-8");
      const name = parseSkillFrontmatter(md).name?.trim() || entry.name;
      if (!SKILL_NAME_RE.test(name)) continue;
      if (!byName.has(name)) byName.set(name, dir);
    } catch {
      // A missing/unreadable SKILL.md is not an installed skill. In contrast,
      // a genuinely empty file is readable and falls back to its folder name.
    }
  }
  return byName;
}

/**
 * Names of the global skills `engine` may see, or `null` when the matrix puts
 * no restriction on that engine (providers then keep their native "discover
 * everything" behavior). An empty array means the user disabled every skill
 * for this engine — the allowlist is then genuinely empty.
 */
export function enabledSkillNames(skillsRoot: string, engine: SkillEngine): string[] | null {
  const map = readEnginesMap(skillsRoot);
  if (!engineRestricted(map, engine)) return null;
  return [...skillNamesInRoot(skillsRoot).keys()].filter((name) => engineEnabled(map, name, engine));
}

/**
 * Directories of the global skills `engine` may see, or `null` when the
 * matrix puts no restriction on it (the provider then hands over the whole
 * skills ROOT and lets the engine's own scanner do the walking). Used by the
 * codex bridge, whose only delivery mechanism is a list of root directories —
 * per-skill filtering there means passing the enabled skills' own directories.
 */
export function enabledSkillDirs(skillsRoot: string, engine: SkillEngine): string[] | null {
  const map = readEnginesMap(skillsRoot);
  if (!engineRestricted(map, engine)) return null;
  return [...skillNamesInRoot(skillsRoot).entries()]
    .filter(([name]) => engineEnabled(map, name, engine))
    .map(([, dir]) => dir)
    .sort();
}
