/**
 * 技能市场 —— 设置 → Skills 的「市场」tab(与插件市场同一个模型)。
 *
 * 一个市场 = 一个装着技能的 git 仓库(或本地目录):里面每个含 SKILL.md 的目录是一条。
 *  - GitHub 市场只缓存目录与 SKILL.md 头部简介；安装时才下载所选技能目录;
 *  - 本地市场就地读,不复制(刷新 = 重新扫描);
 *  - 内置两个:anthropics/skills、openai/skills。第一次打开那个 tab 时才去拉;
 *  - 安装 = 把技能目录整体复制进通用库 `~/.mcode/skills`(重名跳过),由调用方记进
 *    bundle(GitHub 来源用 `<owner>--<repo>`,和「从 GitHub 导入」同一组)。
 *
 * 记录存成文件(`markets.json`),不进数据库 —— 技能本来就全是文件,便于 smoke 隔离。
 */
import { promoteMarketCatalog, type MarketProgressSink } from "@main/lib/marketClone.js";
import { classifyMarketRegistry, marketRegistryCorruptMessage, recheckMarketRegistryBeforeWrite, type MarketRegistryRead } from "@main/lib/marketRegistry.js";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { fetchGithubSkillIndex, downloadGithubSkill, parseGithubSkillIndex, githubSkillSource, GITHUB_INDEX_FILE, type GithubSkillIndex } from "@main/lib/githubSkillCatalog.js";
import { homedir } from "node:os";
import path from "node:path";
import {
  SKILL_MARKET_NAME_RE,
  SKILL_NAME_RE,
  type SkillMarketEntry,
  type SkillMarketState,
  type SkillsMarketInstallResult,
} from "@contracts/ipc";
import { defaultSkillsRoot, parseSkillFrontmatter } from "@main/lib/skillEngines.js";

/** Root for catalogs + the records file. Overridable for smokes. */
export function skillMarketsRoot(): string {
  return process.env.MCODE_SKILL_MARKETS_DIR || path.join(homedir(), ".mcode", "skill-markets");
}

interface MarketRecord {
  name: string;
  source: { kind: "git" | "local"; ref: string };
  addedAt: string;
  builtin?: boolean;
  fetchedAt?: string;
}

export const BUILTIN_SKILL_MARKETS: ReadonlyArray<{ name: string; url: string }> = [
  { name: "anthropic-skills", url: "https://github.com/anthropics/skills" },
  { name: "openai-skills", url: "https://github.com/openai/skills" },
];

const RECORDS_FILE = "markets.json";
const SCAN_SKIP = new Set([".git", "node_modules", ".github"]);
/** Upper bound on entries per catalog — a mis-added monorepo must not hang the panel. */
const MAX_ENTRIES = 2000;
/** Local catalogs may contain arbitrarily many folders without SKILL.md;
 * limiting found skills alone does not constrain main-process disk traversal. */
const MAX_SCAN_DIRECTORIES = 2000;
/** Even a single local folder can contain millions of non-skill entries. */
const MAX_SCAN_ITEMS = 8192;
/** Cached GitHub indexes are untrusted local JSON and read synchronously. */
const MAX_GITHUB_INDEX_BYTES = 8 * 1024 * 1024;

function recordsPath(): string {
  return path.join(skillMarketsRoot(), RECORDS_FILE);
}

/** A malformed persisted source cannot be silently dropped before a later write. */
function parseRecordList(value: unknown): MarketRecord[] | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { markets?: unknown };
  if (!Array.isArray(raw.markets)) return null;
  // This is the user-approved source registry, not disposable search results.
  // Filtering malformed rows means remove/add/refresh would rewrite a shorter
  // array and permanently destroy bytes the user might need to recover.
  if (!raw.markets.every(
    (r): r is MarketRecord =>
      !!r &&
      typeof (r as MarketRecord).name === "string" &&
      SKILL_MARKET_NAME_RE.test((r as MarketRecord).name) &&
      !!(r as MarketRecord).source &&
      ((r as MarketRecord).source.kind === "git" || (r as MarketRecord).source.kind === "local") &&
      typeof (r as MarketRecord).source.ref === "string" &&
      (r as MarketRecord).source.ref.trim().length > 0 &&
      typeof (r as MarketRecord).addedAt === "string" &&
      ((r as MarketRecord).fetchedAt === undefined || typeof (r as MarketRecord).fetchedAt === "string") &&
      ((r as MarketRecord).builtin === undefined || typeof (r as MarketRecord).builtin === "boolean"),
  )) return null;
  const seenNames = new Set<string>();
  const seenSources = new Set<string>();
  for (const rec of raw.markets as MarketRecord[]) {
    // Builtin market identity belongs to the application, not to arbitrary
    // bytes in markets.json. A persisted local/foreign source must never
    // hide an official market by stealing its reserved name, nor make a
    // custom source undeletable by setting builtin:true.
    const reserved = BUILTIN_SKILL_MARKETS.find((b) => marketNamesEqual(b.name, rec.name));
    const officialBySource = rec.source.kind === "git"
      ? BUILTIN_SKILL_MARKETS.find((b) =>
        normalizeGitUrl(b.url) === normalizeGitUrl(rec.source.ref))
      : undefined;
    if ((reserved && (!officialBySource || !marketNamesEqual(reserved.name, officialBySource.name)))
      || (officialBySource && !marketNamesEqual(rec.name, officialBySource.name))
      || (rec.builtin === true && !reserved)) return null;
    const name = process.platform === "win32" ? rec.name.toLowerCase() : rec.name;
    const source = rec.source.kind === "git"
      ? normalizeGitUrl(rec.source.ref)
      : path.resolve(rec.source.ref);
    const location = process.platform === "win32" ? source.toLowerCase() : source;
    const key = `${rec.source.kind}:${location}`;
    // A duplicate name makes remove-by-name erase both entries. A duplicate
    // source under two aliases makes later refresh/cache ownership ambiguous.
    // Do not deduplicate silently: callers need the original bytes to repair.
    if (seenNames.has(name) || seenSources.has(key)) return null;
    seenNames.add(name);
    seenSources.add(key);
  }
  return raw.markets as MarketRecord[];
}

/**
 * 【MC-037】市场记录分三态(**读列表/写回前都先问它**)。
 *
 * 从前这里 `catch { return [] }` —— `markets.json` 被截断/手改坏之后,列表把
 * "损坏" 谎报成 "从未添加过";用户再加一个市场,`addSkillMarket` 拿这个空数组
 * 当旧清单整表写回,历史来源**静默消失**。分类核与 MCP/插件市场共用
 * (见 `lib/marketRegistry.ts`)。
 */
function readRecordsState(): MarketRegistryRead<MarketRecord> {
  let raw: string | null = null;
  try {
    // A market file hard-linked to an unrelated path exposes external bytes
    // as supposedly user-approved local sources. Refuse both that alias and
    // file symlinks before reading; a regular records file has exactly one
    // directory entry and is not a link.
    assertPlainDirectoryAncestorsSync(path.dirname(recordsPath()), "技能市场记录路径");
    const meta = lstatSync(recordsPath());
    if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1) {
      return { kind: "corrupt", reason: "市场记录文件不是独立普通文件（链接/硬链接或特殊类型）" };
    }
    // A corrupted or hostile persisted list must not consume unbounded memory
    // in the Electron main process merely because the market panel opened.
    // 4 MiB is far above a normal set of user-approved catalog identities.
    if (meta.size > 4 * 1024 * 1024) {
      return { kind: "corrupt", reason: "技能市场记录文件超过 4 MiB 安全上限" };
    }
    raw = readFileSync(recordsPath(), "utf8");
  } catch (err) {
    // 文件不存在 = absent(合法初始态);别的读失败(EACCES 等)= corrupt ——
    // 读不出来时绝不能假装"没有来源",否则下一次写入会覆盖读不到的旧数据。
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "corrupt", reason: `读取失败(${code ?? (err as Error).message})` };
  }
  return classifyMarketRegistry(raw, parseRecordList, "技能市场");
}

/** 读侧降级出口:损坏 → 空表(供列表继续展示**内置**市场),但写侧必须走 readRecordsState 拒绝。 */
function readRecords(): MarketRecord[] {
  const state = readRecordsState();
  return state.kind === "ok" ? state.records : [];
}

/**
 * 写回时刻的 fresh 基准(【MC-037】时序变体)。`add` 里在 fetch/scan 的 await
 * 窗口**之前**读过一次,但窗口内记录可能被并发改写或砸坏;从前这里用
 * `readRecords()`(损坏时降级成 `[]`)当基准 —— 坏档照样会被一次成功添加覆盖。
 * 修复:写回前重读三态,corrupt → 拒绝且原字节不动;ok → 以 fresh 为基准。
 */
function freshRecordsForWrite(): { ok: true; records: MarketRecord[] } | { ok: false; error: string; corrupt: true } {
  const fresh = recheckMarketRegistryBeforeWrite(readRecordsState(), "技能市场");
  return fresh.ok ? { ok: true, records: fresh.base } : fresh;
}

/** The read path has no async entry point. Use the same no-link ancestor
 * invariant before adopting records/index data supplied through configured
 * directories, including a Windows Junction at a parent of the JSON file. */
function assertPlainDirectoryAncestorsSync(location: string, label: string): void {
  let dir = path.resolve(location);
  for (;;) {
    try {
      const info = lstatSync(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`${label}包含链接 / Junction 或非常规目录：${dir}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/** A perfectly normal leaf directory can still be reached through an
 * ancestor Junction. Inspect every existing path component with lstat, not
 * stat/realpath, before filesystem writes or adopting a local skill tree.
 * This is a static guard, not a kernel-level defense against live swaps. */
async function assertPlainDirectoryAncestors(location: string, label: string): Promise<void> {
  let dir = path.resolve(location);
  for (;;) {
    try {
      const info = await fs.lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`${label}包含链接 / Junction 或非常规目录：${dir}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

/** Market records must never be written through a symlink in any ancestor. */
async function assertWritableMarketRoot(root: string): Promise<void> {
  await assertPlainDirectoryAncestors(root, "技能市场数据路径");
  await fs.mkdir(root, { recursive: true });
  await assertPlainDirectoryAncestors(root, "技能市场数据路径");
}

/** The final fresh-read / merge / publish must be one transaction across Node processes. */
async function withRecordsTransaction<T>(task: () => Promise<T>): Promise<T> {
  const root = skillMarketsRoot();
  await assertWritableMarketRoot(root);
  const lockPath = path.join(root, ".markets-write.lock");
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error("技能市场记录被其他进程占用或旧锁未核对：" + lockPath);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    }
  }
  try {
    return await task();
  } finally {
    // Never reclaim stale or somebody else's lock. Only remove our empty directory.
    await fs.rmdir(lockPath);
  }
}

async function writeRecords(records: MarketRecord[]): Promise<void> {
  await assertWritableMarketRoot(skillMarketsRoot());
  // A fixed PID suffix collides when two async writers share the process.
  const tmp = `${recordsPath()}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify({ version: 1, markets: records }, null, 2) + "\n",
      { encoding: "utf8", flag: "wx" });
    await fs.rename(tmp, recordsPath());
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

function marketNamesEqual(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function normalizeGitUrl(url: string): string {
  try { const s = githubSkillSource(url); return `${s.owner}/${s.repo}`.toLowerCase() + (s.ref ? `#${s.ref}` : ""); }
  catch { return url.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase(); }
}

/** Built-ins merged in (missing ones appended; never written until something
 *  else changes — listing stays read-only). */
function withBuiltins(records: MarketRecord[]): MarketRecord[] {
  const known = new Set(records.filter((r) => r.source.kind === "git").map((r) => normalizeGitUrl(r.source.ref)));
  const out = records.map((r) =>
    r.source.kind === "git" && BUILTIN_SKILL_MARKETS.some((b) => normalizeGitUrl(b.url) === normalizeGitUrl(r.source.ref))
      ? { ...r, builtin: true }
      : r,
  );
  for (const b of BUILTIN_SKILL_MARKETS) {
    if (known.has(normalizeGitUrl(b.url)) || out.some((r) => marketNamesEqual(r.name, b.name))) continue;
    out.push({ name: b.name, source: { kind: "git", ref: b.url }, addedAt: "", builtin: true });
  }
  return out;
}

/** `owner/repo`, GitHub web URLs (incl. `/tree/<branch>`) and plain git URLs →
 *  clone URL + optional branch. Null for anything that is not a URL. */
export function parseSkillMarketGitRef(input: string): { url: string; branch?: string; owner?: string; repo?: string } | null {
  const s = input.trim();
  try { const ref = githubSkillSource(s); return { url: `https://github.com/${ref.owner}/${ref.repo}.git`, owner: ref.owner, repo: ref.repo, branch: ref.ref }; }
  catch { if (/github\.com/i.test(s) || /^[\w.-]+\/[\w.-]+$/.test(s)) return null; }
  if (/^git@[\w.-]+:[\w./-]+$/.test(s)) return { url: s };
  try { const u = new URL(s); return ["https:", "http:"].includes(u.protocol) ? { url: s } : null; }
  catch { return null; }
}

function sanitizeName(raw: string): string {
  const s = raw
    .replace(/\.git$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return s || "market";
}


function catalogDir(rec: MarketRecord): string {
  return rec.source.kind === "local" ? path.resolve(rec.source.ref) : path.join(skillMarketsRoot(), rec.name);
}

function cachedGithubIndex(rec: MarketRecord): GithubSkillIndex | null {
  if (rec.source.kind !== "git") return null;
  const root = catalogDir(rec);
  assertPlainDirectoryAncestorsSync(root, "技能市场 Git 索引路径");
  const file = path.join(root, GITHUB_INDEX_FILE);
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(file); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error("技能市场索引不是独立普通文件，拒绝符号链接/硬链接，请刷新");
  }
  if (info.size > MAX_GITHUB_INDEX_BYTES) {
    throw new Error("技能市场缓存索引大小超出 8 MiB 安全上限，请刷新");
  }
  const index = parseGithubSkillIndex(readFileSync(file, "utf8"));
  const source = githubSkillSource(rec.source.ref);
  if (source.owner.toLowerCase() !== index.source.owner.toLowerCase() || source.repo.toLowerCase() !== index.source.repo.toLowerCase() || source.ref !== index.source.ref) throw new Error("技能索引与来源不符，请刷新");
  return index;
}

/** Every directory holding a SKILL.md (not descending into a skill). */
async function findSkillDirs(
  dir: string, out: string[], depth = 0, budget = { visited: 0, items: 0 },
): Promise<void> {
  if (depth > 8) return;
  // Count ALL visited directories, including empty folders and node trees
  // with no SKILL.md, instead of only the successfully discovered skills.
  budget.visited += 1;
  if (budget.visited > MAX_SCAN_DIRECTORIES) {
    throw new Error(`技能市场目录扫描超过 ${MAX_SCAN_DIRECTORIES} 个目录上限，请选择更小的技能仓库`);
  }
  if (out.length >= MAX_ENTRIES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Directory IO errors during enumeration mean this is not a complete
    // catalog. A partial list can silently hide approved skills and then be
    // published as though it described the entire source.
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(`技能市场目录扫描失败(${code ?? "unknown"})：${dir}`);
  }
  budget.items += entries.length;
  if (budget.items > MAX_SCAN_ITEMS) {
    throw new Error(`技能市场目录扫描条目超过 ${MAX_SCAN_ITEMS} 个条目上限，请选择更小的技能仓库`);
  }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    out.push(dir);
    return;
  }
  const subdirs = entries
    .filter((e) => e.isDirectory() && !SCAN_SKIP.has(e.name))
    // A catalog's own skill template is not a skill to install.
    .filter((e) => !(depth === 0 && /^templates?$/i.test(e.name)))
    .map((e) => e.name)
    .sort();
  for (const name of subdirs) await findSkillDirs(path.join(dir, name), out, depth + 1, budget);
}

async function readHead(file: string): Promise<string> {
  let meta: Awaited<ReturnType<typeof fs.lstat>>;
  try { meta = await fs.lstat(file); }
  catch { return ""; }
  // SKILL.md itself is user-visible/AI-consumed input. The directory may be
  // perfectly ordinary yet that file can be a hardlink to outside content.
  if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1) {
    throw new Error("SKILL.md 不是独立普通文件（链接或硬链接），拒绝读取外部内容：" + file);
  }
  try {
    const fh = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}

interface ScannedSkill {
  name: string;
  description: string;
  dir: string;
  relPath: string;
}

/** Scan one catalog tree; duplicate names keep the first (sorted) path. */
async function scanCatalog(rec: MarketRecord): Promise<ScannedSkill[]> {
  const root = catalogDir(rec);
  const index = cachedGithubIndex(rec);
  if (index) return index.skills.map(s => ({ ...s, dir: "" }));
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  await findSkillDirs(root, dirs);
  const seen = new Set<string>();
  const out: ScannedSkill[] = [];
  for (const dir of dirs) {
    const front = parseSkillFrontmatter(await readHead(path.join(dir, "SKILL.md")));
    const name = dir === root ? (front.name && SKILL_NAME_RE.test(front.name) ? front.name : rec.name) : path.basename(dir);
    if (!SKILL_NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: (front.description ?? "").trim(),
      dir,
      relPath: path.relative(root, dir).split(path.sep).join("/") || ".",
    });
  }
  // Display order = name (openai/skills mixes .curated / .system folders).
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 给 `skills.marketList` 附的损坏诊断(【MC-037】):有值时列表照常给内置市场,
 *  但界面/Agent 可据此把"没有自定义来源"与"记录读不出来"分开。 */
export function skillMarketsCorrupt(): { reason: string } | null {
  const state = readRecordsState();
  return state.kind === "corrupt" ? { reason: state.reason } : null;
}

export async function listSkillMarkets(): Promise<SkillMarketState[]> {
  const libRoot = defaultSkillsRoot();
  // Listing is read-only, but must not report external files as installed if
  // any SDK library ancestor is a symlink/Windows junction.
  let trustedSkillsRoot = true;
  try { await assertPlainDirectoryAncestors(libRoot, "技能安装目标路径"); }
  catch { trustedSkillsRoot = false; }
  const out: SkillMarketState[] = [];
  for (const rec of withBuiltins(readRecords())) {
    const dir = catalogDir(rec);
    let cloned = existsSync(dir);
    let scanned: ScannedSkill[] = [];
    if (cloned) {
      try {
        await assertPlainDirectoryAncestors(dir, "技能市场来源路径");
        scanned = await scanCatalog(rec);
      } catch { cloned = false; }
    }
    const skills: SkillMarketEntry[] = cloned
      ? scanned.map((s) => ({
          market: rec.name,
          name: s.name,
          description: s.description,
          relPath: s.relPath,
          installed: trustedSkillsRoot && installedSkillState(path.join(libRoot, s.name)) === "installed",
        }))
      : [];
    out.push({
      name: rec.name,
      sourceKind: rec.source.kind,
      sourceRef: rec.source.ref,
      builtin: rec.builtin === true,
      cloned,
      ...(rec.fetchedAt ? { fetchedAt: rec.fetchedAt } : {}),
      skills,
    });
  }
  return out;
}

/** Corrupted persisted sources may still be on disk while a network request
 * is in flight. A cached index must not be published from that failed request. */
class MarketChangedDuringFetchError extends Error {
  constructor(message: string, readonly corrupt: boolean) { super(message); }
}

/** Refresh may heal malformed JSON, but must not replace a cache entry
 * that is a hardlink/symlink to someone else's file. */
async function assertIndependentCachedIndex(rec: MarketRecord): Promise<void> {
  const file = path.join(catalogDir(rec), GITHUB_INDEX_FILE);
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error("技能索引缓存不是独立普通文件，拒绝覆盖链接或硬链接");
    }
    if (info.size > MAX_GITHUB_INDEX_BYTES) {
      throw new Error("技能索引缓存超过 8 MiB 安全上限，拒绝用刷新掩盖异常文件");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Replace an index only after a complete successful metadata fetch. Legacy
 * checkout caches remain readable until the first successful refresh. */
async function fetchGitCatalog(
  rec: MarketRecord,
  progress?: MarketProgressSink,
  beforePromote?: () => void,
): Promise<void> {
  // The index cache path itself might have been swapped to a Junction since
  // the market was approved. Never even fetch metadata for an external cache
  // root, and recheck after network await before promoting a staged index.
  await assertPlainDirectoryAncestors(catalogDir(rec), "技能市场 Git 缓存路径");
  await assertIndependentCachedIndex(rec);
  let previous: GithubSkillIndex | null = null;
  try { previous = cachedGithubIndex(rec); } catch { /* refresh replaces a damaged index */ }
  const index = await fetchGithubSkillIndex(rec.source.ref, rec.name, progress, previous ?? undefined);
  await assertPlainDirectoryAncestors(catalogDir(rec), "技能市场 Git 缓存路径");
  await assertIndependentCachedIndex(rec);
  // 刷新网络请求可能耗时很久；调用方在缓存目录被替换之前可再次验证
  // 来源是否仍属于这次刷新，避免已删除/同名换源者的旧索引覆盖新缓存。
  beforePromote?.();
  const root = skillMarketsRoot();
  await assertWritableMarketRoot(root);
  const staging = path.join(root, `.index-${randomUUID()}`);
  try {
    await fs.mkdir(staging);
    await fs.writeFile(path.join(staging, GITHUB_INDEX_FILE), JSON.stringify(index), "utf8");
    await promoteMarketCatalog(staging, path.join(root, rec.name));
  } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
}

export async function addSkillMarket(input: {
  kind: "git" | "local";
  ref: string;
  name?: string;
}, progress?: MarketProgressSink): Promise<{ ok: boolean; error?: string; name?: string; corrupt?: boolean }> {
  try {
    // 【MC-037】写回前先问健康度:损坏记录**拒绝进入修改事务**(原字节一个不动)。
    // 从前拿"读不出来 → []"当旧清单,`writeRecords([...[], rec])` 会把历史来源抹掉。
    const state = readRecordsState();
    if (state.kind === "corrupt") {
      return { ok: false, error: marketRegistryCorruptMessage("技能市场", state.reason), corrupt: true };
    }
    const records = withBuiltins(state.kind === "ok" ? state.records : []);
    let ref = input.ref.trim();
    let defaultName: string;
    if (input.kind === "git") {
      githubSkillSource(ref); // Fail explicitly for unsupported hosts, never clone as fallback.
      const parsed = parseSkillMarketGitRef(ref);
      if (!parsed) return { ok: false, error: "不是可识别的仓库地址(支持 owner/repo、GitHub 链接或 git 地址)" };
      if (records.some((r) => r.source.kind === "git" && normalizeGitUrl(r.source.ref) === normalizeGitUrl(ref))) {
        return { ok: false, error: `这个仓库已经在市场里了:${ref}` };
      }
      defaultName = parsed.repo ? `${parsed.owner}-${parsed.repo}` : sanitizeName(path.basename(parsed.url));
    } else {
      ref = path.resolve(ref);
      // Reject a source that is only reachable through an ancestor Junction
      // before registering it as an approved executable-skills catalog.
      await assertPlainDirectoryAncestors(ref, "技能市场本地来源路径");
      if (!existsSync(ref) || !statSync(ref).isDirectory()) return { ok: false, error: `目录不存在:${ref}` };
      if (records.some((r) => r.source.kind === "local" && path.resolve(r.source.ref) === ref)) {
        return { ok: false, error: `这个目录已经在市场里了:${ref}` };
      }
      defaultName = sanitizeName(path.basename(ref));
    }
    let name = input.name ?? sanitizeName(defaultName);
    if (!SKILL_MARKET_NAME_RE.test(name)) return { ok: false, error: `市场名称不合法:${name}` };
    if (records.some((r) => marketNamesEqual(r.name, name))) {
      if (input.name) return { ok: false, error: `同名市场已存在:${name}` };
      let i = 2;
      while (records.some((r) => marketNamesEqual(r.name, `${name}-${i}`))) i += 1;
      name = `${name}-${i}`;
    }
    const rec: MarketRecord = { name, source: { kind: input.kind, ref }, addedAt: new Date().toISOString() };
    if (rec.source.kind === "git") {
      await fetchGitCatalog(rec, progress, () => {
        // 网络请求结束但缓存尚未提升时，检查是否有另一窗口抢先注册了同名源。
        // 不能先覆盖对方缓存，再在记录冲突分支把这个同名目录删掉。
        const current = readRecordsState();
        if (current.kind === "corrupt") {
          throw new MarketChangedDuringFetchError(
            marketRegistryCorruptMessage("技能市场", current.reason), true);
        }
        if (state.kind === "ok" && current.kind === "absent") {
          throw new MarketChangedDuringFetchError("技能市场记录在下载期间消失，请检查并重试", false);
        }
        if (current.kind === "ok") {
          if (current.records.some((r) => marketNamesEqual(r.name, name))) {
            throw new Error(`同名市场已存在:${name}(添加期间由其他窗口创建)`);
          }
          // Another window can register the same Git repository under a
          // different market name during the fetch. Reject before publishing
          // any cache; the later ledger duplicate check alone leaves a stale
          // orphan catalog for a transaction that did not receive approval.
          if (current.records.some((r) => r.source.kind === "git"
            && normalizeGitUrl(r.source.ref) === normalizeGitUrl(rec.source.ref))) {
            throw new Error(`该 Git 市场来源在下载期间已由其他窗口登记：${rec.source.ref}`);
          }
        }
      });
      rec.fetchedAt = new Date().toISOString();
    }
    progress?.({ phase: "scan", message: "扫描技能目录 / Scanning skill catalog", elapsedMs: 0 });
    if ((await scanCatalog(rec)).length === 0) {
      // 放弃添加时不按公开 name 盲删缓存：并行窗口可能已经将同名目录归属给
      // 新来源。少量孤立缓存留待带身份校验的垃圾回收，优先保护别人的字节。
      return { ok: false, error: "里面没有找到任何 SKILL.md —— 它不是技能仓库" };
    }
    // 【MC-037】写回前**重读**记录:fetch/scan 的 await 窗口内记录可能被并发
    // 改写或砸坏。从前这里用 `readRecords()`(损坏时 = [])当旧清单,坏档会被
    // 这次成功添加整表覆盖;现在损坏 → 拒绝,健康 → 以 fresh 为准合并。
    return await withRecordsTransaction(async () => {
      const fresh = freshRecordsForWrite();
      if (!fresh.ok) return fresh;
      if (fresh.records.some((r) => marketNamesEqual(r.name, name))) {
        return { ok: false, error: `同名市场已存在:${name}(记录在添加期间被其他操作更新)` };
      }
      // 如果并行窗口中别人用另一个别名注册了同一份来源，也只能
      // 保留一份记录；入口处的去重快照已过期，必须在提交锁内重复检查。
      const duplicateSource = fresh.records.some((r) =>
        r.source.kind === rec.source.kind && (
          r.source.kind === "git"
            ? normalizeGitUrl(r.source.ref) === normalizeGitUrl(rec.source.ref)
            : path.resolve(r.source.ref) === path.resolve(rec.source.ref)
        ));
      if (duplicateSource) {
        return { ok: false, error: `该市场来源在添加期间已由其他窗口登记：${rec.source.ref}` };
      }
      // 同一锁内重读最新 records 并完整落盘，两个成功添加不能相互覆盖。
      await writeRecords([...fresh.records, rec]);
      return { ok: true, name };
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message,
      ...(err instanceof MarketChangedDuringFetchError && err.corrupt ? { corrupt: true } : {}) };
  }
}

/** Only cache indexes we can positively attribute to the same approved Git
 * source are Mcode-owned scratch data. Old checkout directories, mismatched
 * indexes and extra user files must survive source deregistration. */
async function removeOwnedGitMarketCache(rec: MarketRecord): Promise<void> {
  if (rec.source.kind !== "git") return;
  const cache = catalogDir(rec);
  try {
    await assertPlainDirectoryAncestors(cache, "技能市场缓存删除路径");
    const names = await fs.readdir(cache);
    // Modern GitHub catalog cache contains only our signed-off index. A
    // checkout or cache with extra files might belong to a user/legacy tool.
    if (names.length !== 1 || names[0] !== GITHUB_INDEX_FILE) return;
    const meta = await fs.lstat(path.join(cache, GITHUB_INDEX_FILE));
    if (!meta.isFile() || meta.isSymbolicLink()) return;
    if (!cachedGithubIndex(rec)) return;
    await fs.rm(cache, { recursive: true, force: true });
  } catch {
    // Removing an approved source must not become destructive when its cache
    // is missing, replaced, damaged or inaccessible.
  }
}

export async function removeSkillMarket(name: string): Promise<{ ok: boolean; error?: string; corrupt?: boolean }> {
  try {
    return await withRecordsTransaction(async () => {
      // Read/check/write in the same transaction as concurrent add/refresh.
      const state = readRecordsState();
      if (state.kind === "corrupt") {
        return { ok: false, error: marketRegistryCorruptMessage("技能市场", state.reason), corrupt: true };
      }
      const rec = withBuiltins(state.kind === "ok" ? state.records : []).find((r) => r.name === name);
      if (!rec) return { ok: false, error: `市场不存在:${name}` };
      if (rec.builtin) return { ok: false, error: "内置市场不能移除" };
      await writeRecords((state.kind === "ok" ? state.records : []).filter((r) => r.name !== name));
      // A market name alone does not establish ownership over all files at
      // its cached path. Only delete verified Mcode index-only Git caches.
      await removeOwnedGitMarketCache(rec);
      return { ok: true };
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function refreshSkillMarket(name: string, progress?: MarketProgressSink): Promise<{ ok: boolean; error?: string; corrupt?: boolean }> {
  // 【MC-037】刷新末尾要写 fetchedAt —— 坏表同样拒绝(否则刷新会顺手重建 records)。
  const state = readRecordsState();
  if (state.kind === "corrupt") {
    return { ok: false, error: marketRegistryCorruptMessage("技能市场", state.reason), corrupt: true };
  }
  const rec = withBuiltins(state.kind === "ok" ? state.records : []).find((r) => r.name === name);
  if (!rec) return { ok: false, error: `市场不存在:${name}` };
  if (rec.source.kind === "local") {
    try {
      await assertPlainDirectoryAncestors(catalogDir(rec), "技能市场本地来源路径");
      return existsSync(catalogDir(rec)) ? { ok: true } : { ok: false, error: `目录不存在:${rec.source.ref}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  try {
    await fetchGitCatalog(rec, progress, () => {
      const current = readRecordsState();
      // A damaged registry must stop BEFORE cached index promotion. Returning
      // here would overwrite a healthy old cache even though fresh write later
      // rejects the corrupt ledger.
      if (current.kind === "corrupt") {
        throw new MarketChangedDuringFetchError(
          marketRegistryCorruptMessage("技能市场", current.reason), true);
      }
      const sameName = current.kind === "ok" ? current.records.find((r) => r.name === rec.name) : undefined;
      if (!sameName && !rec.builtin) throw new Error(`市场 ${name} 在刷新期间已被移除，请重新打开市场列表`);
      if (sameName && (
        sameName.source.kind !== rec.source.kind || sameName.source.ref !== rec.source.ref || sameName.addedAt !== rec.addedAt
      )) throw new Error(`市场 ${name} 在刷新期间已被替换，请重新打开市场列表`);
    });
    // 【MC-037】写回前重读:刷新是长操作,窗口内记录可能被改写/砸坏。
    // 从前这里用 `readRecords()`(损坏时 = [])当基准,坏档会被 fetchedAt 回写覆盖。
    return await withRecordsTransaction(async () => {
      const fresh = freshRecordsForWrite();
      if (!fresh.ok) return fresh;
      const records = fresh.records;
      const fetchedAt = new Date().toISOString();
      const idx = records.findIndex((r) => r.name === name);
      if (idx < 0) {
        if (!rec.builtin) {
          return { ok: false, error: `市场 ${name} 在刷新期间已被移除，请重新打开市场列表` };
        }
        records.push({ ...rec, addedAt: rec.addedAt || fetchedAt, fetchedAt });
      } else {
        const current = records[idx];
        if (
          current.source.kind !== rec.source.kind ||
          current.source.ref !== rec.source.ref ||
          current.addedAt !== rec.addedAt
        ) {
          return { ok: false, error: `市场 ${name} 在刷新期间已被替换，请重新打开市场列表` };
        }
        records[idx] = { ...current, fetchedAt };
      }
      await writeRecords(records);
      return { ok: true };
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message,
      ...(err instanceof MarketChangedDuringFetchError && err.corrupt ? { corrupt: true } : {}) };
  }
}

/** Bundle the installed skills belong to (GitHub catalogs share the id used by
 *  「从 GitHub 导入」, so the two land in one group). */
export function skillMarketBundle(market: string): { id: string; label: string; source: string } | null {
  const rec = withBuiltins(readRecords()).find((r) => r.name === market);
  if (!rec) return null;
  const parsed = rec.source.kind === "git" ? parseSkillMarketGitRef(rec.source.ref) : null;
  if (parsed?.owner && parsed.repo) {
    return { id: `${parsed.owner}--${parsed.repo}`, label: `${parsed.owner}/${parsed.repo}`, source: `https://github.com/${parsed.owner}/${parsed.repo}` };
  }
  return { id: `market--${rec.name}`, label: rec.name, source: rec.source.ref };
}

/** The target is an executable SDK skills library, never follow a junction into
 * an unrelated folder just because the config root happens to point there. */
/** Only a real directory with a real SKILL.md counts as installed.
 * A junction, dangling symlink, or incomplete directory must not make the UI
 * claim success or cause a silent "already installed" skip. */
function installedSkillState(dest: string): "absent" | "installed" | "conflict" {
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(dest); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return "conflict";
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return "conflict";
  try {
    const skill = lstatSync(path.join(dest, "SKILL.md"));
    return skill.isFile() && !skill.isSymbolicLink() ? "installed" : "conflict";
  } catch { return "conflict"; }
}

async function assertWritableSkillsRoot(libRoot: string): Promise<void> {
  await assertPlainDirectoryAncestors(libRoot, "技能安装目标路径");
  await fs.mkdir(libRoot, { recursive: true });
  await assertPlainDirectoryAncestors(libRoot, "技能安装目标路径");
}

/** Local catalogs and downloaded archives are untrusted. An installed skill
 * must not carry an absolute symlink/junction that reads outside its own tree.
 * Always inspect both the original and a staged copy before publication. */
async function assertSkillTreeHasNoLinks(root: string): Promise<void> {
  await assertPlainDirectoryAncestors(root, "技能源路径");
  const info = await fs.lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("技能来源包含链接或非普通目录：" + root);
  }
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop() as string;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const item of entries) {
      const full = path.join(dir, item.name);
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) {
        throw new Error("技能目录包含外部链接或特殊文件：" + full);
      }
      if (item.isDirectory()) pending.push(full);
      if (item.isFile()) {
        const fileInfo = await fs.lstat(full);
        if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1) {
          throw new Error("技能包含链接到外部数据的文件，拒绝安装：" + full);
        }
      }
    }
  }
}

export async function installSkillsFromMarket(
  market: string,
  names: readonly string[],
  progress?: MarketProgressSink,
): Promise<SkillsMarketInstallResult> {
  const rec = withBuiltins(readRecords()).find((r) => r.name === market);
  if (!rec) return { ok: false, error: `市场不存在:${market}`, imported: [], skipped: [], errors: [] };
  // cachedGithubIndex 在缓存索引与来源不符时会**抛**(仓库改名/记录被改/索引来自别的源)。
  // 列表路径(listSkillMarkets)已 try/catch,安装路径过去没有 —— 于是点"安装"会以异常
  // 结束 IPC,而不是像其它写操作一样返回 {ok:false, error} 让界面显示"刷新市场"指引。
  let remoteIndex: ReturnType<typeof cachedGithubIndex>;
  try {
    // Do this before even scanning SKILL.md: catalog metadata can itself
    // contain private data outside a previously approved local source if the
    // directory was replaced by a Junction between registration and install.
    await assertPlainDirectoryAncestors(catalogDir(rec), "技能市场安装来源路径");
    if (rec.source.kind === "local") {
      const info = await fs.lstat(catalogDir(rec));
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("本地技能市场来源不是独立普通目录");
      }
    }
    remoteIndex = cachedGithubIndex(rec);
  } catch (err) {
    return { ok: false, error: (err as Error).message, imported: [], skipped: [], errors: [] };
  }
  // Cached/local index reads can fail independently of the source root
  // preflight. Keep IPC responses structured rather than throwing into the
  // renderer when a SKILL.md hardlink/unsafe catalog appears.
  let catalog: ScannedSkill[];
  try { catalog = await scanCatalog(rec); }
  catch (err) {
    return { ok: false, error: (err as Error).message, imported: [], skipped: [], errors: [] };
  }
  const byName = new Map(catalog.map((s) => [s.name, s]));
  const libRoot = defaultSkillsRoot();
  try {
    await assertWritableSkillsRoot(libRoot);
  } catch (err) {
    return { ok: false, error: (err as Error).message, imported: [], skipped: [], errors: [] };
  }
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];
  for (const name of new Set(names)) {
    const hit = byName.get(name);
    if (!hit) {
      errors.push({ name, error: "市场里没有这个技能(先刷新市场)" });
      continue;
    }
    const dest = path.join(libRoot, name);
    const initial = installedSkillState(dest);
    if (initial === "installed") {
      skipped.push(name);
      continue;
    }
    if (initial === "conflict") {
      errors.push({ name, error: "技能目录已存在但不是完整普通技能（可能是 Junction/链接或半安装），请人工检查" });
      continue;
    }
    try {
      // Download and local copy both publish by one same-filesystem rename:
      // never make a half-copied skill visible at its final SDK path.
      const staging = path.join(libRoot, `.skill-install-${randomUUID()}`);
      try {
        if (remoteIndex) {
          await downloadGithubSkill(remoteIndex, hit.relPath, staging, progress);
        } else {
          await assertSkillTreeHasNoLinks(hit.dir);
          await fs.cp(hit.dir, staging, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
        }
        await assertSkillTreeHasNoLinks(staging);
        await assertWritableSkillsRoot(libRoot);
        const current = installedSkillState(dest);
        if (current === "installed") { skipped.push(name); continue; }
        if (current === "conflict") {
          throw new Error("目标技能目录存在不安全链接或不完整目录，拒绝覆盖");
        }
        try {
          await fs.rename(staging, dest);
          imported.push(name);
        } catch (err) {
          // Another window may have published the same skill while our copy
          // was staged. Do not merge/overwrite the winner's files.
          const raced = installedSkillState(dest);
          if (raced === "installed") skipped.push(name);
          else throw err;
        }
      } finally {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      errors.push({ name, error: (err as Error).message });
    }
  }
  return { ok: imported.length > 0 || skipped.length > 0, imported, skipped, errors };
}
