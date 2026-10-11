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

/**
 * 【MC-077】fail-closed 哨兵。挂在映射对象上的一个 **symbol 键**:
 * `JSON.stringify` / `Object.keys` / `for...in` / `getEntries` 都看不到它,所以
 * 「映射形状」不变(stringify 仍是 `{}`),但 {@link engineEnabled} /
 * {@link engineRestricted} 见到它就把该引擎判为**全拒绝**。只有当矩阵文件损坏且
 * **没有可信 last-good 可恢复**时,{@link readEnginesMapDetailed} 才发这个哨兵 ——
 * 一个坏文件绝不能解释成「用户重新选择了全部允许」(那正是 44.2 的 fail-open 反例)。
 * 消费端(IPC 面板、Claude/Codex/Pi 投递、MCP 列表)无需逐个改,拿到带哨兵的 map
 * 自动切到空 allowlist。用普通赋值(而非 defineProperty 隐藏),这样即便有人
 * `{...map}` 克隆也**保留**哨兵 —— 克隆只会朝更安全的一侧走。
 */
export const ENGINES_DENY_ALL: unique symbol = Symbol("enginesDenyAll");

/** 内部:带哨兵的映射。符号键不参与 JSON / Object.keys 枚举。 */
type EnginesDenyAllMap = SkillEnginesMap & { [ENGINES_DENY_ALL]?: true };

/** 【MC-077】造一份 fail-closed 映射(损坏且无备份时的唯一合法决议)。 */
function denyAllEnginesMap(): SkillEnginesMap {
  const map: EnginesDenyAllMap = {};
  map[ENGINES_DENY_ALL] = true;
  return map;
}

/** 【MC-077】该映射是不是 fail-closed 决议? */
function isEnginesDenyAll(map: Record<string, SkillEngineEntry>): boolean {
  return (map as Record<PropertyKey, unknown> | null | undefined)?.[ENGINES_DENY_ALL] === true;
}

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
 * wrapper is {@link readEnginesMap}).
 *
 * ⚠️ 【MC-077】这是**低层**读法,分不清「从没设过」与「损坏」—— 两者都返回 `{}`。需要区分
 * 并对损坏配置做保守恢复时用 {@link readEnginesMapDetailed}(与 MC-071/083 同一条取舍):
 * 一个坏了的矩阵文件**不应**被解释成「用户重新选择了全部允许」。
 *
 * 返回值**可能是带 {@link ENGINES_DENY_ALL} 哨兵的 fail-closed 映射**(主文件损坏且无
 * last-good 时)—— 它长得像空 map,但 {@link engineEnabled} 对每一项都返回 false。所以
 * 消费端**一律**经 {@link engineEnabled}/{@link engineRestricted} 判断,绝不自己 `Object.keys`
 * 当「全允许」用。
 */
export function readEnginesMapFile(file: string): SkillEnginesMap {
  return readEnginesMapDetailed(file).map;
}

/** 【MC-077】矩阵读取的三种事实。 */
export type EnginesMapStatus = "VALID" | "MISSING" | "INVALID";

export interface EnginesMapRead {
  status: EnginesMapStatus;
  /** 实际应生效的映射。INVALID 时尽量回退到「最后一份确认过的映射」。 */
  map: SkillEnginesMap;
  /** INVALID 且成功从 last-good 恢复出非空映射时为 true。 */
  recovered: boolean;
  error?: string;
}

/** 与矩阵文件同目录的「最后一份确认过的映射」备份路径。 */
export function lastGoodEnginesMapPath(file: string): string {
  return `${file}.last-good`;
}

function parseEnginesMapText(raw: string): { ok: true; map: SkillEnginesMap } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false };
  const out: SkillEnginesMap = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const entry = minimizeEntry(value as SkillEngineEntry);
    if (entry) out[name] = entry;
  }
  return { ok: true, map: out };
}

/** 从 last-good 备份读出一份**有效**(可为空)映射;读不出/损坏则 null。
 *  空映射("用户明确全允许")也算有效的最近提交(与 MC-071 残余同一条)。 */
function readLastGoodEnginesMap(file: string): { map: SkillEnginesMap } | null {
  let raw: string;
  try {
    raw = readFileSync(lastGoodEnginesMapPath(file), "utf-8");
  } catch {
    return null;
  }
  const parsed = parseEnginesMapText(raw);
  return parsed.ok ? { map: parsed.map } : null;
}

/**
 * 【MC-077】读矩阵并**明确区分** VALID / MISSING / INVALID:
 *   - **MISSING**(文件不存在):全新用户,不设限 —— 与旧行为一致;
 *   - **VALID**:照常;
 *   - **INVALID**(存在但损坏):**不静默 failure-open**。若 last-good 备份有效(含"用户明确
 *     全允许"那份空映射)就据它恢复(`recovered=true`);**无备份时 fail-closed** —— map 带
 *     {@link ENGINES_DENY_ALL} 哨兵,消费端据此把所有受管能力判为**拒绝**,绝不返回一个
 *     看似合法的空 map(那会被 `engineEnabled` 默认当成"全允许",正是 44.2 的反例)。
 */
export function readEnginesMapDetailed(file: string): EnginesMapRead {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "MISSING", map: {}, recovered: false };
    const recovered = readLastGoodEnginesMap(file);
    if (recovered) return { status: "INVALID", map: recovered.map, recovered: true, error: `引擎矩阵文件不可读:${err instanceof Error ? err.message : String(err)}` };
    return {
      status: "INVALID",
      map: denyAllEnginesMap(),
      recovered: false,
      error: `引擎矩阵文件不可读且无可用备份,已拒绝加载受限制能力:${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = parseEnginesMapText(raw);
  if (parsed.ok) return { status: "VALID", map: parsed.map, recovered: false };
  const recovered = readLastGoodEnginesMap(file);
  if (recovered) return { status: "INVALID", map: recovered.map, recovered: true, error: "引擎矩阵文件损坏(JSON 解析失败或不是对象),已从 last-good 恢复" };
  return {
    status: "INVALID",
    map: denyAllEnginesMap(),
    recovered: false,
    error: "引擎矩阵文件损坏(JSON 解析失败或不是对象)且无可用备份,已拒绝加载受限制能力",
  };
}

/** Read the mapping under a skills root. See {@link readEnginesMapFile}. */
export function readEnginesMap(skillsRoot: string): SkillEnginesMap {
  return readEnginesMapDetailed(enginesMapPath(skillsRoot)).map;
}

/** 写映射到显式路径（pretty-printed）。**每次都刷新 last-good 备份**(含空映射 —— 用户明确
 *  全允许那次也是合法提交)。见 {@link writeEnginesMap} 的 skills-root 包装。 */
export function writeEnginesMapFile(file: string, map: SkillEnginesMap): void {
  atomicWrite(file, JSON.stringify(map, null, 2) + "\n");
  // 【MC-077】与 MC-071 残余同一条:空映射("用户明确全允许")也必须成为新的 last-good,
  // 否则「先有限制 → 用户明确全允许 → 文件损坏」会从更旧的限制错误恢复。
  atomicWrite(lastGoodEnginesMapPath(file), JSON.stringify(map, null, 2) + "\n");
}

/** Write the mapping (pretty-printed). Creates the skills root if absent. */
export function writeEnginesMap(skillsRoot: string, map: SkillEnginesMap): void {
  writeEnginesMapFile(enginesMapPath(skillsRoot), map);
}

/** Is `name` enabled for `engine`? Entry absent / key absent → true. Accepts
 *  a string so the same function serves skill (claude/codex/pi) and MCP
 *  (claude/codex) matrices without callers each casting a literal union.
 *
 *  【MC-077】带 {@link ENGINES_DENY_ALL} 哨兵的映射(损坏且无备份)→ 一律 false:
 *  配置状态不明时,受管能力必须 fail-closed,而不是被空 map 默认放行。 */
export function engineEnabled(
  map: Record<string, SkillEngineEntry>,
  name: string,
  engine: string,
): boolean {
  if (isEnginesDenyAll(map)) return false;
  return map[name]?.[engine as SkillEngine] !== false;
}

/** True when at least one skill disables `engine` — the signal for providers
 *  to switch from "discover everything" to an explicit allowlist.
 *
 *  【MC-077】fail-closed 映射恒为 true:Provider 于是切成显式 allowlist,而
 *  {@link engineEnabled} 对每一项都返回 false,合成的 allowlist 就是空的。 */
export function engineRestricted(map: SkillEnginesMap, engine: SkillEngine): boolean {
  if (isEnginesDenyAll(map)) return true;
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
  for (let i = 0; i < fm.length; i++) {
    const raw = fm[i];
    // Only top-level keys: indented lines belong to a block value.
    if (/^\s/.test(raw)) continue;
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    // Strip surrounding quotes (single/double) and trailing whitespace.
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else if (/^[>|][+-]?\d*$/.test(val)) {
      // YAML block scalar (`description: >` + indented lines) — common in
      // published skills (anthropics/skills). Folded `>` joins with spaces,
      // literal `|` keeps the line breaks.
      const block: string[] = [];
      while (i + 1 < fm.length && (/^\s/.test(fm[i + 1]) || fm[i + 1].trim() === "")) {
        block.push(fm[i + 1].trim());
        i += 1;
      }
      val = val.startsWith(">")
        ? block.join(" ").replace(/\s+/g, " ").trim()
        : block.join("\n").trim();
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
