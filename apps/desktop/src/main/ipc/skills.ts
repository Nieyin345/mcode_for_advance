/**
 * IPC handler for skill discovery. The composer's `/` menu lists skills the
 * user has installed; we discover them by scanning the universal library
 * `~/.mcode/skills/` and parsing each skill's SKILL.md frontmatter.
 *
 * We deliberately do NOT call the SDK's `Query.supportedCommands()` for the
 * listing: that method needs a running query handle, but this app spawns a
 * fresh query per turn, so there is no live handle to query between turns.
 * Scanning the disk is instant, runs without booting the claude binary, and
 * matches what the SDK itself scans when `skills: "all"` is passed (the
 * binary scans $CLAUDE_CONFIG_DIR/skills, which we point at ~/.mcode/skills).
 * Selecting a skill inserts `/name` into the textarea; the user sends it as a
 * normal turn and the engine recognizes and runs it.
 *
 * Additionally, the settings panel's "Import" feature scans external tools'
 * skill directories (Claude Code ~/.claude/skills, Codex ~/.codex/skills,
 * Zcode ~/.agents/skills + ~/.zcode/skills + plugin cache) and copies selected
 * skills into ~/.mcode/skills so they become available in Mcode. The user can
 * also point it at a local directory (a single skill or a collection) or a
 * single markdown file (imported as a one-file skill, materialized as
 * <name>/SKILL.md).
 *
 * ## Per-engine matrix
 *
 * The universal library is gated per engine by the central mapping
 * `.mcode-engines.json` (see lib/skillEngines.ts): the listing attaches the
 * resolved state to each global skill's `perEngine`, and SKILLS_ENGINES_SET
 * edits it — 「移动到引擎内部 / 移回通用」 is a matrix edit, skill files never
 * move. The three providers consume the same matrix at session start (claude:
 * Options.skills allowlist; pi: skillsOverride; codex: extraRoots).
 */
import { marketProgressFor } from "@main/lib/marketProgress.js";
import type { IpcMain } from "electron";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path, { sep } from "node:path";
import {
  IPC,
  SKILL_NAME_RE,
  SkillsListSchema,
  SkillsReadSchema,
  SkillsSaveSchema,
  SkillsDeleteSchema,
  SkillsEnginesSetSchema,
  SkillsBundlesSchema,
  SkillsEnginesSetBulkSchema,
  SkillsScanSourcesSchema,
  SkillsImportSchema,
  SkillsImportGithubSchema,
  SkillsCopyToProjectSchema,
  SkillsPresetSaveSchema,
  SkillsPresetDeleteSchema,
  SkillsProjectOverviewSchema,
  SkillsMarketListSchema,
  SkillsMarketAddSchema,
  SkillsMarketNameSchema,
  SkillsMarketInstallSchema,
} from "@contracts/ipc";
import type { SkillInfo, SkillSource, ExternalSkillInfo, SkillTool, ReadOnlySkillSource, SkillEngineState, SkillBundle, SkillsImportGithubResult, SkillsCopyToProjectResult, SkillPreset, ProjectSkillRow, SkillsProjectOverviewResult } from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import {
  addSkillMarket,
  installSkillsFromMarket,
  listSkillMarkets,
  refreshSkillMarket,
  removeSkillMarket,
  skillMarketBundle,
} from "@main/lib/skillMarket.js";
import { getPluginSkillSources } from "@main/plugins/pluginManager.js";
import {
  defaultSkillsRoot,
  parseSkillFrontmatter,
  readEnginesMap,
  writeEnginesMap,
  setEnginesEntry,
  engineEnabled,
  skillNamesInRoot,
} from "@main/lib/skillEngines.js";

/** True if `abs` is inside `root` (or equals it), after normalizing both.
 *  Containment check for write/delete ops — same logic as files.ts pathWithin.
 *  Separator-aware so "/foo/bar" doesn't match root "/foo/ba". */
function pathWithin(root: string, abs: string): boolean {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  if (a === r) return true;
  return a.startsWith(r + sep);
}

/** The universal skills root: ~/.mcode/skills (Mcode's own CLAUDE_CONFIG_DIR
 *  skills dir). This is the ONE shared store all three engines consume.
 *
 *  ⚠️ 这里从前还写着"the former project branch (<project>/.claude/skills) is gone
 *  with external workspace inheritance" —— **2026-09-20 那句话不成立了**: 项目级
 *  技能被用户要了回来,落在 `<项目>/.claude/skills/`(见下面的 `projectSkillsRoot`)。
 *  这里仍然只解析**通用库**那一个根,项目那个由 `projectSkillsRoot` 单独算 ——
 *  两者的作用域不同,不该混在一个函数里。
 *
 *  The global root moved from ~/.claude/skills to ~/.mcode/skills because
 *  CLAUDE_CONFIG_DIR is now always set to ~/.mcode - the SDK's bundled binary
 *  scans $CLAUDE_CONFIG_DIR/skills for user-level skills, so this is where
 *  imported skills must live to be discoverable (especially under custom
 *  endpoints, where ~/.claude/skills is no longer read). */
function resolveSkillRoot(): string {
  return defaultSkillsRoot();
}

/** 项目技能目录在项目下的相对位置（Claude Code 的既定约定）。 */
const PROJECT_SKILLS_REL = path.join(".claude", "skills");

/** 列表排序用的来源档次。项目最前（局部覆盖全局），内置垫底。 */
const SORT_SOURCE_RANK: Record<SkillSource, number> = {
  project: 0,
  global: 1,
  plugin: 2,
  builtin: 3,
};

/**
 * 某个项目的技能根：`<项目>/.claude/skills/`。**没有项目就返回 null。**
 *
 * ## 为什么是 `.claude/skills` 而不是 `.mcode/skills`
 *
 * 这是 Claude Code 的既定约定，三家引擎的加载路径本来就认它。放在自己起的目录名
 * 下，同事拿别的工具打开这个项目就读不到 —— 而"跟着项目走、能分享"正是用户要
 * 项目级技能的**全部理由**。
 *
 * ## 为什么只做词法校验，不做"这条路存在吗"
 *
 * 目录**不存在是正常的**（项目里还没放过技能）。返回路径、让 `scanSkillsRoot` 自己
 * 吃掉 ENOENT，比在这里先 stat 一次少一次读盘，而且调用方不用区分"没有目录"和
 * "目录是空"。
 *
 * ⚠️ **这里不接受相对路径。** 项目路径来自会话/项目记录，正常都是绝对的；给一个
 * 相对路径意味着"相对进程的工作目录"，那是随启动方式变的 —— 与其猜，不如拒绝。
 */
export function projectSkillsRoot(projectPath: string | undefined): string | null {
  if (!projectPath || !path.isAbsolute(projectPath)) return null;
  return path.join(projectPath, PROJECT_SKILLS_REL);
}

/** Resolves to an absolute path, following symlinks. Returns null on any
 *  error (missing / no access) so the caller can skip cleanly. */
async function safeRealPath(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/** Read up to `maxBytes` of a file as utf-8 text. Returns null on any error. */
async function readTextHead(filePath: string, maxBytes = 8192): Promise<string | null> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead).toString("utf-8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Scan one skills root dir and append its skills to `into`. Each direct child
 * directory must contain a readable SKILL.md; frontmatter supplies the name,
 * with the directory name as fallback. Hidden/system containers are not skills.
 * Linked skills remain supported. Any IO error is caught and skipped — this function
 * never throws. Frontmatter parsing lives in lib/skillEngines.ts (shared
 * with the engine providers' name scans).
 */
async function scanSkillsRoot(rootDir: string, source: SkillSource, into: Map<string, SkillInfo>): Promise<void> {
  // The engine scan is also the name-to-directory authority for read, save,
  // delete and copy. A frontmatter name is not necessarily a folder name.
  for (const [name, skillDir] of skillNamesInRoot(rootDir)) {
    // First occurrence wins: project > global > contributed. The settings
    // library requests no projectPath, so project overrides cannot hide the
    // independent global copy there; composer precedence remains unchanged.
    if (into.has(name)) continue;
    const md = await readTextHead(path.join(skillDir, "SKILL.md"));
    if (md === null) continue; // disappeared since discovery
    const fm = parseSkillFrontmatter(md);
    into.set(name, {
      name,
      description: fm.description?.trim() ?? "",
      argumentHint: fm.argumentHint?.trim() || undefined,
      source,
    });
  }
}

/** Scan a user-picked local directory for skills, with auto-detection of
 *  whether the directory itself is a single skill or a collection of skills:
 *  - If `<dir>/SKILL.md` exists → treat `dir` as ONE skill (folder name is the
 *    skill name fallback).
 *  - Otherwise → treat `dir` as a skills ROOT and scan each SKILL.md-bearing
 *    subdirectory (same logic as scanning a tool's install location).
 *  Appends results to `into` keyed by `local:${dir}:${name}` so the same
 *  folder scanned twice doesn't double-add. Never throws. */
async function scanLocalSkillDir(
  dir: string,
  into: Map<string, ExternalSkillInfo>,
): Promise<void> {
  const real = await safeRealPath(dir);
  if (!real) return;
  // Ensure it's a directory; silently skip otherwise (defensive — the picker
  // only returns directories, but realpath could resolve to something else).
  try {
    const st = await fs.stat(real);
    if (!st.isDirectory()) return;
  } catch {
    return;
  }
  // Case 1: the directory itself is a skill (contains SKILL.md directly).
  const ownMd = await readTextHead(path.join(real, "SKILL.md"));
  if (ownMd != null) {
    const fm = parseSkillFrontmatter(ownMd);
    const name = fm.name?.trim() || path.basename(real);
    into.set(`local:${real}:${name}`, {
      name,
      description: fm.description?.trim() ?? "",
      tool: "local",
      sourcePath: real,
    });
    return;
  }
  // Case 2: treat as a skills root — scan each subdirectory.
  const before = into.size;
  await scanExternalSkillsRoot(real, "local", into);
  if (into.size > before) return;
  // Case 3: nothing at the top level — look one level down at the conventional
  // nested roots. Cloned skill *collections* (K-Dense-AI/scientific-agent-skills
  // and friends) keep their ~150 skills under `skills/`, with README/docs/
  // scripts as siblings; scanning only the top level finds zero and the picker
  // silently reports "no skills", which reads as a broken import rather than a
  // layout we don't know.
  //
  // Deliberately narrow and first-hit-wins: we only descend one level, only
  // into these two conventional names, and we stop as soon as a root yields
  // anything — a repo that happens to carry an unrelated nested tree must not
  // have it enumerated. A directory that is itself a skill (Case 1) never
  // reaches here.
  for (const nested of ["skills", path.join(".claude", "skills")]) {
    await scanExternalSkillsRoot(path.join(real, nested), "local", into);
    if (into.size > before) return;
  }
}

/** Scan a user-picked single FILE as a one-file skill (the import dialog's
 *  "select file" flow). The file's markdown body IS the SKILL.md content;
 *  importing materializes it as <name>/SKILL.md under ~/.mcode/skills.
 *  - Only .md/.markdown files qualify (case-insensitive); anything else is
 *    skipped (the renderer pre-filters, this is the defensive backstop).
 *  - Name: frontmatter `name` → file stem; a file literally named SKILL.md
 *    falls back to its PARENT directory name ("SKILL" is never a useful name).
 *  Appends to `into` keyed like the dir flow. Never throws. */
async function scanLocalSkillFile(
  file: string,
  into: Map<string, ExternalSkillInfo>,
): Promise<void> {
  const real = await safeRealPath(file);
  if (!real) return;
  try {
    const st = await fs.stat(real);
    if (!st.isFile()) return;
  } catch {
    return;
  }
  const base = path.basename(real);
  const ext = path.extname(base).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") return;
  const md = await readTextHead(real);
  if (md == null) return;
  const fm = parseSkillFrontmatter(md);
  const isSkillMd = base.toLowerCase() === "skill.md";
  // Slice (not path.basename(real, ext)): ext is lowercased, so basename's
  // exact-suffix strip would miss "READ.MD" and keep the extension in the name.
  const stem = isSkillMd ? path.basename(path.dirname(real)) : base.slice(0, base.length - ext.length);
  const name = fm.name?.trim() || stem;
  into.set(`local:${real}:${name}`, {
    name,
    description: fm.description?.trim() ?? "",
    tool: "local",
    sourcePath: real,
  });
}

/**
 * Scan one external tool's skills root dir and append its skills to `into`.
 * Similar to {@link scanSkillsRoot} but records the source directory path and
 * tool origin so the import handler can copy the skill folder later. Dedupes
 * by name WITHIN a single tool (first occurrence wins); cross-tool dedup is
 * left to the UI so the user can see the same skill available from multiple
 * tools. Never throws - IO errors are caught and skipped.
 */
async function scanExternalSkillsRoot(
  rootDir: string,
  tool: SkillTool,
  into: Map<string, ExternalSkillInfo>,
): Promise<void> {
  const root = await safeRealPath(rootDir);
  if (!root) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // not present / unreadable - nothing to list
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    // Hidden containers, including Codex's .system, are not importable skills.
    if (entry.name.startsWith(".")) continue;
    const skillPath = path.join(root, entry.name);
    const real = await safeRealPath(skillPath);
    if (!real) continue;
    let isDir = true;
    try {
      const st = await fs.stat(real);
      isDir = st.isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;

    const md = await readTextHead(path.join(real, "SKILL.md"));
    if (md === null) continue;
    const fm = parseSkillFrontmatter(md);
    const name = fm.name?.trim() || entry.name;
    // Dedupe within this tool only: if the same name appeared in another tool,
    // we still add it (different sourcePath). But within one tool's tree,
    // first occurrence wins.
    if (into.has(`${tool}:${name}`)) continue;
    into.set(`${tool}:${name}`, {
      name,
      description: fm.description?.trim() ?? "",
      tool,
      sourcePath: real,
    });
  }
}

/** The fixed external skill directories scanned by the import feature, keyed
 *  by tool. Zcode has multiple roots (user skills + plugin cache). The plugin
 *  cache glob is resolved lazily because it may not exist. */
function getExternalSkillDirs(): Array<{ tool: SkillTool; dir: string }> {
  const home = homedir();
  const dirs: Array<{ tool: SkillTool; dir: string }> = [
    { tool: "claude-code", dir: path.join(home, ".claude", "skills") },
    { tool: "codex", dir: path.join(home, ".codex", "skills") },
    { tool: "zcode", dir: path.join(home, ".agents", "skills") },
    { tool: "zcode", dir: path.join(home, ".zcode", "skills") },
  ];
  // Zcode plugin cache: ~/.zcode/cli/plugins/cache/*/*/skills
  // Each entry is <marketplace>/<plugin>/<version>/skills - we glob two levels
  // deep under the cache dir and append any skills/ folders found.
  return dirs;
}

/** Scan the Zcode plugin cache for additional skill directories. The cache
 *  structure is ~/.zcode/cli/plugins/cache/<marketplace>/<plugin>/<version>/skills.
 *  Returns the list of `skills` directories found (may be empty). */
async function scanZcodePluginSkillDirs(): Promise<string[]> {
  const home = homedir();
  const cacheRoot = path.join(home, ".zcode", "cli", "plugins", "cache");
  const realRoot = await safeRealPath(cacheRoot);
  if (!realRoot) return [];
  const result: string[] = [];
  try {
    // Level 1: marketplaces
    for (const market of await fs.readdir(realRoot, { withFileTypes: true })) {
      if (!market.isDirectory()) continue;
      const marketPath = path.join(realRoot, market.name);
      // Level 2: plugins
      let plugins: import("node:fs").Dirent[];
      try {
        plugins = await fs.readdir(marketPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const plugin of plugins) {
        if (!plugin.isDirectory()) continue;
        const pluginPath = path.join(marketPath, plugin.name);
        // Level 3: versions
        let versions: import("node:fs").Dirent[];
        try {
          versions = await fs.readdir(pluginPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ver of versions) {
          if (!ver.isDirectory()) continue;
          const skillsDir = path.join(pluginPath, ver.name, "skills");
          const realSkills = await safeRealPath(skillsDir);
          if (realSkills) result.push(realSkills);
        }
      }
    }
  } catch {
    // Best-effort; swallow.
  }
  return result;
}

/**
 * Shared skills-list core — used by both the desktop IPC handler and the
 * mobile RPC whitelist.
 *
 * ## `projectPath` 现在**真的会用**（2026-09-20 改）
 *
 * 从前这个参数是**被忽略**的（签名注释写着"accepted for RPC signature
 * stability but IGNORED"）：当时的取舍是"Mcode 不往用户项目目录读写任何 skill
 * 文件"，所以清单和当前开的是哪个项目无关。
 *
 * 用户 2026-09-20 推翻了那个取舍 —— 项目级技能回来了，落在
 * `<项目>/.claude/skills/`（见 `@contracts/ipc` 的 `SKILL_WRITE_SOURCES`）。
 * 所以现在：
 *
 *  - **传了 `projectPath`** → 除了通用库与插件，还扫那个项目的技能目录，
 *    结果标成 `source: "project"`；
 *  - **没传**（手机端、或者还没有项目）→ 行为与从前**完全一样**，只有通用库
 *    与插件。这一点是刻意的：没有项目就没有"项目技能"可言，不该凭空报错。
 *
 * 项目技能**排在通用库之上**（见下面 `SOURCE_RANK`）—— 局部覆盖全局是用户
 * 期望的方向：项目里放一份同名技能，就是为了在这一项目里用它的版本。
 */
export async function listSkillsForProject(projectPath: string | undefined): Promise<SkillInfo[]> {
  // Per-engine availability for the universal library — resolved here once so
  // both the composer menu and the settings panel see the same state.
  const skillsRoot = resolveSkillRoot();
  const enginesMap = readEnginesMap(skillsRoot);
  const resolvedEngines = (name: string): SkillEngineState => ({
    claude: engineEnabled(enginesMap, name, "claude"),
    codex: engineEnabled(enginesMap, name, "codex"),
    pi: engineEnabled(enginesMap, name, "pi"),
  });

  const byName = new Map<string, SkillInfo>();
  // **项目技能最先扫。** `scanSkillsRoot` 对同名是"先到的留着"（`byName` 的
  // 语义），而后面的通用库/插件只在该名字还没被占时才补位 —— 所以先扫谁，
  // 谁的版本就赢。
  const projectRoot = projectSkillsRoot(projectPath);
  if (projectRoot) {
    try {
      await scanSkillsRoot(projectRoot, "project", byName);
    } catch (err) {
      log.warn(`project skills scan failed: ${(err as Error).message}`);
    }
  }
  try {
    await scanSkillsRoot(skillsRoot, "global", byName);
  } catch (err) {
    // Should be unreachable (scanSkillsRoot never throws), but be defensive:
    // a broken skills dir must never break the composer.
    log.warn(`skills.list scan failed: ${(err as Error).message}`);
  }
  // Contributed skills LAST — lowest precedence (global > plugin > builtin):
  // scanned into a side map so a contributed skill never overrides a
  // same-named user skill, it only fills the gaps. The engines load these the
  // same way they load user skills, so a `/name` pill works identically for
  // any source.
  //
  // 内置技能（随应用发布的那四个）标成 "builtin" 而不是 "plugin"，这样面板能把
  // 它们标成「内置」—— 而"一个插件都没装"的时候它们照样在，用 "plugin" 会让人
  // 以为是自己装过的哪个插件带来的。两者同样只读。
  try {
    const contributed = new Map<string, SkillInfo>();
    for (const source of await getPluginSkillSources()) {
      const before = new Set(contributed.keys());
      await scanSkillsRoot(source.rootDir, source.builtin ? "builtin" : "plugin", contributed);
      // Attribute the new rows to their plugin (+ its plugin-level switches),
      // so the panel can group by plugin and grey engines the plugin is off for.
      if (source.builtin) continue;
      for (const [skillName, info] of contributed) {
        if (before.has(skillName)) continue;
        if (source.name) info.pluginName = source.name;
        if (source.engines) info.pluginEngines = { ...source.engines };
      }
    }
    for (const [name, info] of contributed) {
      if (!byName.has(name)) byName.set(name, info);
    }
  } catch (err) {
    log.warn(`plugin skills scan failed: ${(err as Error).message}`);
  }
  // Attach the resolved matrix to universal-library AND plugin skills — both
  // are matrix-managed so an engine only sees what was assigned to it (plugin
  // rows stay read-only apart from the switches). 项目技能与内置行不挂：
  // 项目技能**属于那个项目**（跟着项目目录走，不参与全局矩阵），内置行随应用
  // 发布、永远对所有引擎开放。
  for (const [name, info] of byName) {
    if (info.source === "global" || info.source === "plugin") info.perEngine = resolvedEngines(name);
  }
  // Stable ordering: by source rank, then alphabetical within each — so the
  // menu doesn't reshuffle between renders.
  //
  // **项目排在最前**：局部覆盖全局是用户期望的方向（项目里放一份同名的，就是为了
  // 在这个项目里用它的版本），所以它在列表最上面，也最该被看见。内置垫底。
  return [...byName.values()].sort((a, b) => {
    const ra = SORT_SOURCE_RANK[a.source];
    const rb = SORT_SOURCE_RANK[b.source];
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

/** Read the complete source. Only an actual empty file yields ""; IO failures
 *  reject so users cannot accidentally save a failed read as an empty file. */
async function readSkillMd(skillDir: string): Promise<string> {
  // Do not turn ENOENT/EACCES/etc. into an editable empty buffer. The renderer
  // shows the error and disables saving until a successful read.
  return fs.readFile(path.join(skillDir, "SKILL.md"), "utf-8");
}

/** Locate a contributed ("plugin" / "builtin") skill's directory among the
 *  enabled plugins' skill roots + the built-in one.
 *
 *  Resolve the discovered logical name, not a guessed folder name. Several
 *  roots can carry the same name (two plugins each
 *  shipping a `pdf`); the first hit wins, mirroring the listing's gap-fill
 *  order. Containment-guarded so a name like "../x" can't escape the root. */
async function contributedSkillDir(
  source: ReadOnlySkillSource,
  name: string,
): Promise<string | null> {
  const wantBuiltin = source === "builtin";
  for (const { rootDir, builtin } of await getPluginSkillSources()) {
    if (builtin !== wantBuiltin) continue;
    const dir = skillNamesInRoot(rootDir).get(name);
    if (dir && pathWithin(rootDir, dir)) return dir;
  }
  return null;
}

/** Shared skills-read core — used by both the desktop IPC handler and the
 *  mobile RPC whitelist. Project reads require the selected absolute path.
 *  Missing/unreadable skills and invalid identities reject, never return a
 *  misleading empty document.
 *
 *  Contributed skills have no WRITABLE root (see `resolveSkillRootForRequest`)
 *  but they are readable — the settings panel shows a built-in skill's
 *  SKILL.md read-only, which is how a user finds out what the document skills
 *  actually do. */
export async function readSkillForProject(
  projectPath: string | undefined,
  source: SkillSource,
  name: string,
): Promise<string> {
  // This core is also called outside Electron IPC, so keep the same guard.
  // 下面这几句会经 `skills.read` 的拒绝路径直接画到设置面板的错误条上(以及手机的
  // 技能页)—— 与同文件其它用户可见报错(「无效的 skill 路径」「技能不存在或无法
  // 读取 SKILL.md」)同一口径,一律中文;从前它们是英文,与兄弟说法打架。
  if (!SKILL_NAME_RE.test(name)) throw new Error(`技能的「名字」不合法:${name}`);
  if (source === "plugin" || source === "builtin") {
    const dir = await contributedSkillDir(source, name);
    if (!dir) throw new Error(`没找到技能「${name}」,或者它没有可读的 SKILL.md`);
    return readSkillMd(dir);
  }
  const root = resolveSkillRootForRequest(source, projectPath);
  if (!root) throw new Error("读取项目技能需要绝对项目路径");
  const skillDir = skillNamesInRoot(root).get(name);
  if (!skillDir || !pathWithin(root, skillDir)) {
    throw new Error(`没找到技能「${name}」,或者它没有可读的 SKILL.md`);
  }
  return readSkillMd(skillDir);
}

/**
 * Resolve the skills root for a read/save/delete request, or null when the
 * request is invalid.
 *
 *  - **`global`** → 通用库（`~/.mcode/skills`），不需要 `projectPath`。
 *  - **`project`** → `<项目>/.claude/skills/`，**必须带 `projectPath`** ——
 *    没有它就没有"项目"可言。给不出就返回 null（调用方按"这个来源用不了"处理，
 *    而不是去猜一个项目）。
 *  - **`plugin` / `builtin`** → 恒 null：只读清单，没有可写的文件根（插件文件住在
 *    插件安装目录、卸载即消失；内置文件在应用自己的 resources 里、升级即替换）。
 */
function resolveSkillRootForRequest(source: SkillSource, projectPath?: string): string | null {
  if (source === "plugin" || source === "builtin") return null;
  if (source === "project") return projectSkillsRoot(projectPath);
  return resolveSkillRoot();
}

/** The bundle manifest lives next to the matrix file at the library root —
 *  dot-prefixed like `.mcode-engines.json` so skill scanning skips it. */
const BUNDLES_FILE = ".bundles.json";

/** Read the import-bundle manifest (`.bundles.json`): which source directory
 *  each skill was imported from. Purely a display/management concern — a
 *  missing file (nobody imported anything), a bad JSON or a wrong shape all
 *  degrade to an empty list, never an error. Individual entries that don't
 *  match the shape are dropped rather than failing the whole table. */
async function readBundlesManifest(root: string): Promise<SkillBundle[]> {
  try {
    const raw = await fs.readFile(path.join(root, BUNDLES_FILE), "utf8");
    const parsed = JSON.parse(raw) as { bundles?: unknown };
    if (!Array.isArray(parsed.bundles)) return [];
    return parsed.bundles.filter(
      (b): b is SkillBundle =>
        !!b &&
        typeof (b as SkillBundle).id === "string" &&
        typeof (b as SkillBundle).label === "string" &&
        Array.isArray((b as SkillBundle).skills),
    );
  } catch {
    return [];
  }
}

/* ── GitHub package import ──
 *  "贴一个链接进来,导出来就是一类" —— 一个仓库往往是一个技能包(很多子 skill
 *  组合而成)。浅克隆 → 递归找 SKILL.md → 每个技能目录整体拷入通用库 → 全部
 *  归进同一个 bundle(<owner>--<repo>),面板按包管理(整包开关/查看归属)。 */

/** execFile as a promise, stdout/stderr discarded (git progress noise). */
function execFileP(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

/** Parse the shapes the URL box accepts: `owner/repo`,
 *  `https://github.com/owner/repo[.git]`, with an optional `/tree/<branch>`
 *  suffix (the repo file browser's URL). Anything else → null (surfaced to
 *  the user as "不是 GitHub 仓库链接"). */
function parseGithubUrl(input: string): { owner: string; repo: string; branch?: string; httpsUrl: string } | null {
  const s = input.trim();
  const bare = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s);
  if (bare) {
    return { owner: bare[1], repo: bare[2], httpsUrl: `https://github.com/${bare[1]}/${bare[2]}` };
  }
  try {
    const u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length < 2) return null;
    const repo = seg[1].replace(/\.git$/, "");
    // github.com/<owner>/<repo>/tree/<branch>[/<deep path>] — the file browser
    // URL. Deep paths are ignored (whole repo is imported).
    const branch = seg[2] === "tree" && seg.length > 3 ? seg[3] : undefined;
    return { owner: seg[0], repo, branch, httpsUrl: `https://github.com/${seg[0]}/${repo}` };
  } catch {
    return null;
  }
}

/** Directories never descended into when hunting for SKILL.md files. */
const GITHUB_SCAN_SKIP = new Set([".git", "node_modules"]);

/** Collect directories containing a SKILL.md, breadth-agnostic recursion.
 *  Once a directory IS a skill (has SKILL.md) it is not descended into —
 *  files under it belong to that skill, not to separate sub-skills. */
async function findGithubSkillDirs(dir: string, out: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    out.push(dir);
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && !GITHUB_SCAN_SKIP.has(e.name)) {
      await findGithubSkillDirs(path.join(dir, e.name), out);
    }
  }
}

/** Merge the imported skills into the bundle manifest (create the bundle when
 *  first seen; merge names when re-importing an updated repo). Best-effort:
 *  a manifest write failure must not fail an otherwise successful import. */
async function upsertGithubBundle(
  root: string,
  bundleId: string,
  label: string,
  source: string,
  importedNames: string[],
): Promise<void> {
  try {
    const file = path.join(root, BUNDLES_FILE);
    let bundles: SkillBundle[] = [];
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { bundles?: SkillBundle[] };
      if (Array.isArray(parsed.bundles)) bundles = parsed.bundles;
    } catch {
      // no manifest yet — start a fresh one
    }
    let b = bundles.find((x) => x.id === bundleId);
    if (!b) {
      b = { id: bundleId, label, skills: [], source };
      bundles.push(b);
    } else {
      b.label = label;
      b.source = source;
    }
    const names = new Set(b.skills);
    for (const n of importedNames) names.add(n);
    b.skills = [...names].sort();
    await fs.writeFile(file, JSON.stringify({ version: 1, bundles }, null, 2) + "\n", "utf8");
  } catch (err) {
    log.warn(`bundle manifest update failed: ${(err as Error).message}`);
  }
}

/**
 * Import a whole skill package from a GitHub repository URL.
 *
 * Shallow-clones the repo into a temp dir, finds every SKILL.md (excluding
 * .git/node_modules; a SKILL.md at the repo root makes the WHOLE repo one
 * skill, named by its frontmatter `name` or the repo name), copies each
 * skill directory into the universal library (existing names are skipped),
 * and records everything under one `<owner>--<repo>` bundle. All failure
 * paths return a structured result — nothing throws to the IPC boundary.
 */
async function importGithubPackage(input: { url: string }): Promise<SkillsImportGithubResult> {
  const empty: Pick<SkillsImportGithubResult, "imported" | "skipped" | "errors"> = {
    imported: [],
    skipped: [],
    errors: [],
  };
  const parsed = parseGithubUrl(input.url);
  if (!parsed) {
    return { ok: false, error: "不是可识别的 GitHub 仓库链接(支持 owner/repo 或完整 https 链接)", ...empty };
  }
  const { owner, repo, branch, httpsUrl } = parsed;
  const root = resolveSkillRoot();
  const tmp = path.join(tmpdir(), `mcode-gh-${randomUUID()}`);
  try {
    try {
      await execFileP(
        "git",
        ["clone", "--depth", "1", "--single-branch", ...(branch ? ["--branch", branch] : []), `${httpsUrl}.git`, tmp],
        180_000,
      );
    } catch (err) {
      const msg = (err as Error).message;
      return {
        ok: false,
        error: /ENOENT|not recognized|不在路径|not found/i.test(msg)
          ? "本机没有可用的 git 命令,请先安装 Git"
          : `克隆失败:${msg.split("\n")[0]}`,
        ...empty,
      };
    }

    // Discover skill directories. A SKILL.md at the repo root means the whole
    // repo is ONE skill — name it by frontmatter (fallback: repo name).
    const skillDirs: string[] = [];
    await findGithubSkillDirs(tmp, skillDirs);
    if (skillDirs.length === 0) {
      return { ok: false, error: "仓库里没有找到任何 SKILL.md —— 它不是一个技能包", ...empty };
    }
    const rootIsSkill = skillDirs.includes(tmp);
    let rootName = repo;
    if (rootIsSkill) {
      const front = parseSkillFrontmatter(await readSkillMd(tmp));
      if (front?.name && SKILL_NAME_RE.test(front.name)) rootName = front.name;
    }

    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    for (const dir of skillDirs) {
      const name = dir === tmp ? rootName : path.basename(dir);
      if (!SKILL_NAME_RE.test(name)) {
        errors.push({ name, error: "名字含非法字符(只允许字母/数字/-/_)被跳过" });
        continue;
      }
      const dest = path.join(root, name);
      if (await fs.stat(dest).then(() => true, () => false)) {
        skipped.push(name);
        continue;
      }
      try {
        // 整个仓库就是一个技能时 `dir` 就是克隆目录 —— 别把 `.git`(几 MB 到几百 MB,
        // Windows 上 pack 文件还是只读的,之后删技能会卡住)一起抄进技能库。
        await fs.cp(dir, dest, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
        imported.push(name);
      } catch (err) {
        errors.push({ name, error: (err as Error).message });
      }
    }

    if (imported.length === 0 && skipped.length === 0) {
      return { ok: false, error: "仓库里的技能一个都没能导入(重名与非法名除外)", ...empty, errors };
    }

    const bundleId = `${owner}--${repo}`;
    const bundleLabel = `${owner}/${repo}`;
    await upsertGithubBundle(root, bundleId, bundleLabel, httpsUrl, imported);

    log.info(`[skills] GitHub import ${bundleLabel}: ${imported.length} imported, ${skipped.length} skipped`);
    return { ok: true, imported, skipped, errors, bundleId, bundleLabel };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export function registerSkillsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.SKILLS_LIST, async (_evt, raw) => {
    // `?? {}` 非有不可:无参 invoke / `app_api_call`(它**明确让人对无参方法省略
    // input**)时 handler 收到的是 `undefined`,而 `z.object({}).parse(undefined)`
    // 抛 "Required"。渲染端走 `api.skills.list(…)` 没事,AI 通路会收到一句 zod
    // 报错而不是清单。兄弟无参 handler 一律这个写法(见 `context.get` /`memory.list`)。
    const input = SkillsListSchema.parse(raw ?? {});
    const skills = await listSkillsForProject(input.projectPath);
    return { skills };
  });

  // ── Set one universal skill's per-engine availability ──
  // 「移动到引擎内部 / 移回通用」is a matrix edit in .mcode-engines.json — skill
  // files never move. The renderer sends the full desired {claude,codex,pi}
  // state; we persist the minimal entry (only `false` keys, deleted entirely
  // when nothing is disabled) and return the RESOLVED state so the UI can
  // render exactly what's on disk. Failures degrade to { ok:false } — the
  // matrix file being unwritable must not crash the panel.
  ipcMain.handle(IPC.SKILLS_ENGINES_SET, async (_evt, raw) => {
    const input = SkillsEnginesSetSchema.parse(raw);
    try {
      const root = resolveSkillRoot();
      const map = readEnginesMap(root);
      const wanted = { claude: input.claude, codex: input.codex, pi: input.pi };
      setEnginesEntry(map, input.name, wanted);
      writeEnginesMap(root, map);
      const updated = readEnginesMap(root);
      return {
        ok: true,
        perEngine: {
          claude: engineEnabled(updated, input.name, "claude"),
          codex: engineEnabled(updated, input.name, "codex"),
          pi: engineEnabled(updated, input.name, "pi"),
        } satisfies SkillEngineState,
      };
    } catch (err) {
      log.warn(`skills.enginesSet failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Read the bundle manifest (import groups) ──
  // Display-only data for the settings panel's bundle grouping; degrades to
  // an empty list on any IO/parse problem.
  ipcMain.handle(IPC.SKILLS_BUNDLES, async (_evt, raw) => {
    // 同 SKILLS_LIST:`app_api_call` 无参方法省略 input → `raw` 是 `undefined`,
    // `z.object({}).parse(undefined)` 会抛。
    SkillsBundlesSchema.parse(raw ?? {});
    return { bundles: await readBundlesManifest(resolveSkillRoot()) };
  });

  // ── Set the per-engine availability for MANY skills at once ──
  // The group-level switches in the bundle view write a whole import bundle
  // with ONE matrix read-modify-write (looping enginesSet per skill would
  // rewrite .mcode-engines.json N times). Same semantics as enginesSet,
  // applied to every name. Names are NOT checked against the library — the
  // manifest may lag deletions (a stale key in the sparse matrix is harmless:
  // missing = enabled, and the skill is gone anyway) and plugin-contributed
  // skills live in the same matrix without being directories of the root.
  // Returns each name's RESOLVED state so the UI renders what's on disk.
  ipcMain.handle(IPC.SKILLS_ENGINES_SET_BULK, async (_evt, raw) => {
    const input = SkillsEnginesSetBulkSchema.parse(raw);
    try {
      const root = resolveSkillRoot();
      const map = readEnginesMap(root);
      const wanted = { claude: input.claude, codex: input.codex, pi: input.pi };
      for (const name of input.names) setEnginesEntry(map, name, wanted);
      writeEnginesMap(root, map);
      const updated = readEnginesMap(root);
      const perEngine: Record<string, SkillEngineState> = {};
      for (const name of input.names) {
        perEngine[name] = {
          claude: engineEnabled(updated, name, "claude"),
          codex: engineEnabled(updated, name, "codex"),
          pi: engineEnabled(updated, name, "pi"),
        };
      }
      return { ok: true, perEngine };
    } catch (err) {
      log.warn(`skills.enginesSetBulk failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Read one skill's full SKILL.md source ──
  ipcMain.handle(IPC.SKILLS_READ, async (_evt, raw) => {
    const input = SkillsReadSchema.parse(raw);
    const content = await readSkillForProject(input.projectPath, input.source, input.name);
    return { content };
  });

  // ── Create or overwrite a skill's SKILL.md ──
  ipcMain.handle(IPC.SKILLS_SAVE, async (_evt, raw) => {
    const input = SkillsSaveSchema.parse(raw);
    const root = resolveSkillRootForRequest(input.source, input.projectPath);
    if (!root) return { ok: false, error: "项目路径无效（必须是绝对路径）" };
    const discovered = skillNamesInRoot(root);
    const existingDir = discovered.get(input.name);
    const skillDir = existingDir ?? path.join(root, input.name);
    if (!pathWithin(root, skillDir)) {
      return { ok: false, error: "无效的 skill 路径" };
    }
    try {
      if (!existingDir) {
        const occupied = await fs.lstat(skillDir).then(() => true, (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return false;
          throw err;
        });
        if (occupied) return { ok: false, error: "同名目录已存在，但不是这个技能；未覆盖任何文件" };
      }
      // Rename (move) the skill directory when a new name is requested and it
      // actually differs. Reserved for future rename UI; v1 leaves it unset.
      if (input.newName && input.newName !== input.name) {
        const newDir = path.join(root, input.newName);
        if (!pathWithin(root, newDir)) {
          return { ok: false, error: "无效的新 skill 名" };
        }
        const occupied = discovered.has(input.newName) || await fs.lstat(newDir).then(() => true, (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return false;
          throw err;
        });
        if (occupied) return { ok: false, error: "新的 skill 名已被占用；未覆盖任何文件" };
        await fs.rename(skillDir, newDir);
      }
      const targetDir = input.newName && input.newName !== input.name
        ? path.join(root, input.newName)
        : skillDir;
      // mkdir -p the skill dir (and the skills root if this is the first
      // skill). recursive:true is a no-op if it already exists.
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "SKILL.md"), input.content, "utf-8");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Delete a skill directory ──
  ipcMain.handle(IPC.SKILLS_DELETE, async (_evt, raw) => {
    const input = SkillsDeleteSchema.parse(raw);
    const root = resolveSkillRootForRequest(input.source, input.projectPath);
    if (!root) return { ok: false, error: "项目路径无效（必须是绝对路径）" };
    const skillDir = skillNamesInRoot(root).get(input.name);
    if (!skillDir) return { ok: false, error: "技能不存在或无法读取 SKILL.md；未删除任何文件" };
    if (!pathWithin(root, skillDir)) {
      return { ok: false, error: "无效的 skill 路径" };
    }
    try {
      // Distinguish symlink vs real directory: a symlinked skill (common when
      // users link a shared checkout like gstack) must only have the LINK
      // removed — unlinking the target would destroy the shared source. Real
      // directories are removed recursively.
      const stat = await fs.lstat(skillDir);
      if (stat.isSymbolicLink()) {
        await fs.unlink(skillDir);
      } else if (stat.isDirectory()) {
        await fs.rm(skillDir, { recursive: true, force: true });
      } else {
        // Not a dir and not a symlink — refuse rather than delete an unknown
        // file type (defensive; the lister only ever surfaces directories).
        return { ok: false, error: "目标不是 skill 目录" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── Copy skills from the universal library into the current project ──
  //
  // 「把技能放进这个项目」的入口。**复制而不是移动/引用**，理由见契约
  // (`SkillsCopyToProjectSchema`)：移动会把技能从所有别的项目里抽走；引用做不到
  // "项目有自己的那一份"（跟 git 走、能改成本项目专用、能分享）。代价是复制之后
  // 两边脱钩 —— 那是刻意的。
  ipcMain.handle(IPC.SKILLS_COPY_TO_PROJECT, async (_evt, raw) => {
    const input = SkillsCopyToProjectSchema.parse(raw);
    const result: SkillsCopyToProjectResult = { copied: [], skipped: [], failed: [] };

    const destRoot = projectSkillsRoot(input.projectPath);
    if (!destRoot) {
      // 项目路径不合法（空、或相对路径）—— 整批都做不了，逐条回同一个原因。
      for (const name of input.names) {
        result.failed.push({ name, reason: "项目路径无效（必须是绝对路径）" });
      }
      return result;
    }
    const srcRoot = resolveSkillRoot();
    const sourceSkills = skillNamesInRoot(srcRoot);
    const destinationSkills = skillNamesInRoot(destRoot);

    for (const name of input.names) {
      // 源端也要过一遍包含校验：`name` 虽然在 schema 层已经被正则挡了，但这是
      // 写盘操作，多一道 resolve 比对不算贵。
      const srcDir = sourceSkills.get(name);
      if (!srcDir) {
        result.failed.push({ name, reason: "通用库里没有这个技能" });
        continue;
      }
      if (!pathWithin(srcRoot, srcDir)) {
        result.failed.push({ name, reason: "无效的 skill 名" });
        continue;
      }
      const destDir = path.join(destRoot, name);
      if (!pathWithin(destRoot, destDir)) {
        result.failed.push({ name, reason: "无效的 skill 名" });
        continue;
      }
      try {
        const st = await fs.stat(srcDir).catch(() => null);
        if (!st?.isDirectory()) {
          result.failed.push({ name, reason: "通用库里没有这个技能" });
          continue;
        }
        // **不覆盖已有的。** 项目里那个可能是用户改过的版本，复制一次把它冲掉
        // 是不可逆的（而且用户多半只是想"再放一个进去"，没打算覆盖）。
        const exists = destinationSkills.has(name) || await fs.lstat(destDir).then(() => true, (err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT") return false;
          throw err;
        });
        if (exists) {
          result.skipped.push({ name, reason: "项目里已经有同名的了（没有覆盖）" });
          continue;
        }
        await fs.mkdir(destRoot, { recursive: true });
        await fs.cp(srcDir, destDir, { recursive: true, force: false, errorOnExist: true });
        destinationSkills.set(name, destDir);
        result.copied.push(name);
      } catch (err) {
        result.failed.push({ name, reason: (err as Error).message });
      }
    }

    log.info(
      `skills.copyToProject ${input.projectPath}: ${result.copied.length} copied, ` +
        `${result.skipped.length} skipped, ${result.failed.length} failed`,
    );
    return result;
  });

  /** 预设清单文件 —— dot-prefix,所以技能扫描会跳过它(同 `.bundles.json`)。 */
const PRESETS_FILE = ".skill-presets.json";

/** 读预设。**坏文件降级成空表,不抛** —— 同 `readBundlesManifest` 的取舍:
 *  预设是附加能力,它坏了不该让技能页打不开。 */
async function readPresets(root: string): Promise<SkillPreset[]> {
  try {
    const raw = await fs.readFile(path.join(root, PRESETS_FILE), "utf8");
    const parsed = JSON.parse(raw) as { presets?: unknown };
    if (!Array.isArray(parsed.presets)) return [];
    return parsed.presets.filter(
      (p): p is SkillPreset =>
        !!p &&
        typeof (p as SkillPreset).id === "string" &&
        typeof (p as SkillPreset).name === "string" &&
        Array.isArray((p as SkillPreset).skills),
    );
  } catch {
    return [];
  }
}

async function writePresets(root: string, presets: SkillPreset[]): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, PRESETS_FILE),
    JSON.stringify({ presets }, null, 2),
    "utf8",
  );
}

/**
 * 列出某个技能根下有 SKILL.md 的**逻辑技能名**（不一定等于目录名）。
 *
 * **目录不存在返回 `null`**，与"目录存在但是空的"（返回 `[]`）分开 —— 前者是
 * 绝大多数项目的常态（还没放过技能），界面不该把它画成异常。这个区分是跨项目总览
 * 那个 `missing` 字段的全部意义。
 *
 * 只列**直接**子目录、不递归：技能就是 `<root>/<名字>/SKILL.md` 这个形状，递归下去
 * 会先把技能内部的 `scripts/` `references/` 当成技能名报出来。
 */
async function listSkillDirNames(root: string): Promise<string[] | null> {
  try {
    await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null; // 不存在 / 读不动 —— 调用方按 missing 处理
  }
  // A project overview must count the same logical skills as the editor,
  // not .system/support folders or aliased directory names.
  return [...skillNamesInRoot(root).keys()].sort();
}

/* ── 技能预设（"一套技能"） ──
   *
   * 存在**通用库根**下的 `.skill-presets.json`（dot-prefix，所以技能扫描会跳过它，
   * 同 `.bundles.json` / `.mcode-engines.json`）。
   *
   * 为什么和通用库放一起：预设是**跨项目**的"要哪几个"，它属于用户的那份配置，
   * 不属于任何一个项目 —— 放项目里就变成"每个项目一套预设"，那正是要消除的重复。
   */
  ipcMain.handle(IPC.SKILLS_PRESETS_LIST, async () => {
    return { presets: await readPresets(resolveSkillRoot()) };
  });

  ipcMain.handle(IPC.SKILLS_PRESETS_SAVE, async (_evt, raw) => {
    const input = SkillsPresetSaveSchema.parse(raw);
    try {
      const root = resolveSkillRoot();
      const presets = await readPresets(root);
      const now = Date.now();
      const existing = presets.find((p) => p.id === input.preset.id);
      const next: SkillPreset = {
        id: input.preset.id,
        name: input.preset.name,
        skills: [...new Set(input.preset.skills)].sort(),
        ...(input.preset.description ? { description: input.preset.description } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const merged = existing
        ? presets.map((p) => (p.id === next.id ? next : p))
        : [...presets, next];
      await writePresets(root, merged);
      return { ok: true };
    } catch (err) {
      log.warn(`skills.presets.save failed: ${(err as Error).message}`);
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(IPC.SKILLS_PRESETS_DELETE, async (_evt, raw) => {
    const input = SkillsPresetDeleteSchema.parse(raw);
    try {
      const root = resolveSkillRoot();
      const presets = await readPresets(root);
      await writePresets(
        root,
        presets.filter((p) => p.id !== input.id),
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /* ── 跨项目总览 ──
   *
   * 「之后会有很多的项目」—— 一屏看到每个项目各装了什么。
   *
   * ⚠️ **这条会去读你没打开过的项目目录。** 只读、只列直接子目录、不递归、不写 ——
   * 但这仍然是这个页面里唯一"越过当前项目"的动作，所以：
   *
   *  - 单个项目读不动（没权限 / 路径没了）**只把那一个记进 `problems`**，不整批失败；
   *  - 目录不存在**不算问题**（绝大多数项目都没放过技能），标 `missing` 而已。
   */
  ipcMain.handle(IPC.SKILLS_PROJECT_OVERVIEW, async (_evt, raw) => {
    // `projectIds` 可省 = 全部项目;省略 input 时 `raw` 是 `undefined`,同 SKILLS_LIST。
    const input = SkillsProjectOverviewSchema.parse(raw ?? {});
    const rows: ProjectSkillRow[] = [];
    const problems: SkillsProjectOverviewResult["problems"] = [];

    let projects: Array<{ id: string; name: string; path: string }>;
    try {
      // 动态 import：`store/repositories` 拖着 sql.js，而这一整套 IPC 文件在
      // 冒烟里是单独 bundle 的（换桩越少越好）。放这里 import 让没调到这条
      // RPC 的场景完全不碰数据库。
      const { ProjectRepo } = await import("@main/store/repositories.js");
      projects = ProjectRepo.list()
        .filter((p) => (input.projectIds ? input.projectIds.includes(p.id) : true))
        .map((p) => ({ id: p.id, name: p.name, path: p.path }));
    } catch (err) {
      return {
        rows: [],
        problems: [{ projectId: "", projectName: "", error: (err as Error).message }],
      };
    }

    // **串行。** 本地目录列举，一次几十个的并发只会让磁盘抖，而这是个手动打开的
    // 总览页——慢一点无所谓，读到一半失败才麻烦。
    for (const p of projects) {
      const root = projectSkillsRoot(p.path);
      if (!root) {
        problems.push({ projectId: p.id, projectName: p.name, error: "项目路径无效" });
        continue;
      }
      try {
        const names = await listSkillDirNames(root);
        rows.push({
          projectId: p.id,
          projectName: p.name,
          path: p.path,
          // 目录不存在（`null`）→ 空清单 + missing 标记。两者分开是因为"这个项目
          // 还没放过技能"（常态）和"有目录但是空的"在界面上要说不同的话。
          skills: names ?? [],
          missing: names === null,
        });
      } catch (err) {
        problems.push({ projectId: p.id, projectName: p.name, error: (err as Error).message });
      }
    }

    log.info(`skills.projectOverview: ${rows.length} project(s), ${problems.length} problem(s)`);
    return { rows, problems };
  });

  // ── Scan external tools for skills available to import ──
  // Scans Claude Code (~/.claude/skills), Codex (~/.codex/skills), and Zcode
  // (~/.agents/skills + ~/.zcode/skills + plugin cache) for SKILL.md-bearing
  // directories. When the caller supplies a `localDir`, that user-picked
  // directory is scanned too (auto-detecting single-skill vs skills-collection).
  // Returns a flat list with the tool origin and source path for each, so the
  // UI can present them and the import handler can copy them.
  ipcMain.handle(IPC.SKILLS_SCAN_SOURCES, async (_evt, raw) => {
    // 两个可选字段都可省;省略 input 时 `raw` 是 `undefined`,同 SKILLS_LIST。
    const input = SkillsScanSourcesSchema.parse(raw ?? {});
    const byKey = new Map<string, ExternalSkillInfo>();
    try {
      const dirs = getExternalSkillDirs();
      for (const { tool, dir } of dirs) {
        await scanExternalSkillsRoot(dir, tool, byKey);
      }
      // Zcode plugin cache skills (discovered separately due to nested dir
      // structure).
      const pluginDirs = await scanZcodePluginSkillDirs();
      for (const dir of pluginDirs) {
        await scanExternalSkillsRoot(dir, "zcode", byKey);
      }
      // User-picked local directory (import dialog's "select folder" flow) and
      // single file (the "select file" flow). Independent picks; either may be
      // absent.
      if (input.localDir) {
        await scanLocalSkillDir(input.localDir, byKey);
      }
      if (input.localFile) {
        await scanLocalSkillFile(input.localFile, byKey);
      }
    } catch (err) {
      log.warn(`skills.scanSources failed: ${(err as Error).message}`);
    }
    // Sort by tool then name for stable display. Tool order is fixed so the
    // UI grouping is deterministic (localeCompare would put "local" after
    // "zcode", but we want it last as the "additional source" section).
    const toolOrder: SkillTool[] = ["claude-code", "codex", "zcode", "local"];
    const toolRank = (t: SkillTool) => toolOrder.indexOf(t);
    const sources = [...byKey.values()].sort((a, b) => {
      const ra = toolRank(a.tool);
      const rb = toolRank(b.tool);
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
    return { sources };
  });

  // ── Import (copy) selected skills into ~/.mcode/skills ──
  // Copies each selected skill (a source directory tree, or a single markdown
  // file from the "select file" flow) from its external source into the global
  // Mcode skills root. Directory sources copy wholesale (fs.cp recursive);
  // file sources become <name>/SKILL.md. Names are validated per-item — one
  // un-importable skill errors just that item instead of rejecting the batch.
  // Skills that already exist at the destination are skipped (not overwritten)
  // to protect user edits. Returns per-skill imported / skipped / error lists
  // so the UI can report precisely.
  ipcMain.handle(IPC.SKILLS_IMPORT, async (_evt, raw) => {
    const input = SkillsImportSchema.parse(raw);
    const globalRoot = resolveSkillRoot();
    const imported: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    for (const item of input.skills) {
      // Name charset check (moved here from the zod schema so an invalid name
      // — e.g. a CJK file stem — fails only this item, with a readable error).
      if (!SKILL_NAME_RE.test(item.name)) {
        errors.push({ name: item.name, error: "无效的 skill 名" });
        continue;
      }
      const destDir = path.join(globalRoot, item.name);
      // Containment guard: destination must stay inside the global skills root.
      if (!pathWithin(globalRoot, destDir)) {
        errors.push({ name: item.name, error: "无效的 skill 名" });
        continue;
      }
      // Source must exist (the scan guaranteed it, but the user may have
      // deleted it between scan and import).
      let srcStat: import("node:fs").Stats;
      try {
        srcStat = await fs.stat(item.sourcePath);
      } catch {
        errors.push({ name: item.name, error: "源路径不存在" });
        continue;
      }
      if (!srcStat.isDirectory() && !srcStat.isFile()) {
        errors.push({ name: item.name, error: "源路径不是目录或文件" });
        continue;
      }
      // Skip if the destination already exists (don't overwrite user edits).
      try {
        await fs.lstat(destDir);
        skipped.push(item.name);
        continue;
      } catch {
        // Good - destination doesn't exist, proceed with copy.
      }
      try {
        await fs.mkdir(globalRoot, { recursive: true });
        if (srcStat.isDirectory()) {
          // fs.cp with recursive:true copies the entire directory tree
          // (SKILL.md + references/ + assets/ + scripts/ etc.).
          await fs.cp(item.sourcePath, destDir, { recursive: true });
        } else {
          // Single-file skill: the picked markdown file IS the SKILL.md body.
          await fs.mkdir(destDir, { recursive: true });
          await fs.copyFile(item.sourcePath, path.join(destDir, "SKILL.md"));
        }
        imported.push(item.name);
      } catch (err) {
        errors.push({ name: item.name, error: (err as Error).message });
      }
    }
    return { imported, skipped, errors };
  });

  // ── Import a whole skill package from a GitHub repo URL ──
  // One repo = one bundle: shallow-clone → find every SKILL.md → copy each
  // skill in → record them all under `<owner>--<repo>` in the manifest.
  ipcMain.handle(IPC.SKILLS_IMPORT_GITHUB, async (_evt, raw) => {
    const input = SkillsImportGithubSchema.parse(raw);
    return importGithubPackage(input);
  });

  // ── Skill market (「市场」tab): catalog repos of skills, see lib/skillMarket.ts ──
  ipcMain.handle(IPC.SKILLS_MARKET_LIST, async (_evt, raw) => {
    SkillsMarketListSchema.parse(raw ?? {});
    return { markets: await listSkillMarkets() };
  });
  ipcMain.handle(IPC.SKILLS_MARKET_ADD, async (evt, raw) => {
    const input = SkillsMarketAddSchema.parse(raw);
    return addSkillMarket(input, marketProgressFor(evt, input.requestId));
  });
  ipcMain.handle(IPC.SKILLS_MARKET_REMOVE, async (_evt, raw) => removeSkillMarket(SkillsMarketNameSchema.parse(raw).name));
  ipcMain.handle(IPC.SKILLS_MARKET_REFRESH, async (evt, raw) => {
    const input = SkillsMarketNameSchema.parse(raw);
    return refreshSkillMarket(input.name, marketProgressFor(evt, input.requestId));
  });
  ipcMain.handle(IPC.SKILLS_MARKET_INSTALL, async (evt, raw) => {
    const input = SkillsMarketInstallSchema.parse(raw);
    const res = await installSkillsFromMarket(input.market, input.names, marketProgressFor(evt, input.requestId));
    const bundle = skillMarketBundle(input.market);
    if (bundle && res.imported.length > 0) {
      await upsertGithubBundle(resolveSkillRoot(), bundle.id, bundle.label, bundle.source, res.imported);
    }
    if (res.imported.length > 0) log.info(`[skills] market ${input.market}: ${res.imported.length} installed`);
    return res;
  });
}
