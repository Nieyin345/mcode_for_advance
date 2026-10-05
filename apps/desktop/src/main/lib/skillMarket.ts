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
import { existsSync, readFileSync, statSync } from "node:fs";
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

function recordsPath(): string {
  return path.join(skillMarketsRoot(), RECORDS_FILE);
}

function readRecords(): MarketRecord[] {
  try {
    const raw = JSON.parse(readFileSync(recordsPath(), "utf8")) as { markets?: unknown };
    if (!Array.isArray(raw.markets)) return [];
    return raw.markets.filter(
      (r): r is MarketRecord =>
        !!r &&
        typeof (r as MarketRecord).name === "string" &&
        SKILL_MARKET_NAME_RE.test((r as MarketRecord).name) &&
        !!(r as MarketRecord).source &&
        ((r as MarketRecord).source.kind === "git" || (r as MarketRecord).source.kind === "local") &&
        typeof (r as MarketRecord).source.ref === "string",
    );
  } catch {
    return [];
  }
}

async function writeRecords(records: MarketRecord[]): Promise<void> {
  await fs.mkdir(skillMarketsRoot(), { recursive: true });
  const tmp = `${recordsPath()}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, markets: records }, null, 2) + "\n", "utf8");
  await fs.rename(tmp, recordsPath());
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
    if (known.has(normalizeGitUrl(b.url)) || out.some((r) => r.name === b.name)) continue;
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
  const file = path.join(catalogDir(rec), GITHUB_INDEX_FILE);
  if (rec.source.kind !== "git" || !existsSync(file)) return null;
  const index = parseGithubSkillIndex(readFileSync(file, "utf8"));
  const source = githubSkillSource(rec.source.ref);
  if (source.owner.toLowerCase() !== index.source.owner.toLowerCase() || source.repo.toLowerCase() !== index.source.repo.toLowerCase() || source.ref !== index.source.ref) throw new Error("技能索引与来源不符，请刷新");
  return index;
}

/** Every directory holding a SKILL.md (not descending into a skill). */
async function findSkillDirs(dir: string, out: string[], depth = 0): Promise<void> {
  if (out.length >= MAX_ENTRIES || depth > 8) return;
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
  const subdirs = entries
    .filter((e) => e.isDirectory() && !SCAN_SKIP.has(e.name))
    // A catalog's own skill template is not a skill to install.
    .filter((e) => !(depth === 0 && /^templates?$/i.test(e.name)))
    .map((e) => e.name)
    .sort();
  for (const name of subdirs) await findSkillDirs(path.join(dir, name), out, depth + 1);
}

async function readHead(file: string): Promise<string> {
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

export async function listSkillMarkets(): Promise<SkillMarketState[]> {
  const libRoot = defaultSkillsRoot();
  const out: SkillMarketState[] = [];
  for (const rec of withBuiltins(readRecords())) {
    const dir = catalogDir(rec);
    let cloned = existsSync(dir);
    let scanned: ScannedSkill[] = [];
    if (cloned) { try { scanned = await scanCatalog(rec); } catch { cloned = false; } }
    const skills: SkillMarketEntry[] = cloned
      ? scanned.map((s) => ({
          market: rec.name,
          name: s.name,
          description: s.description,
          relPath: s.relPath,
          installed: existsSync(path.join(libRoot, s.name)),
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

/** Replace an index only after a complete successful metadata fetch. Legacy
 * checkout caches remain readable until the first successful refresh. */
async function fetchGitCatalog(rec: MarketRecord, progress?: MarketProgressSink): Promise<void> {
  let previous: GithubSkillIndex | null = null;
  try { previous = cachedGithubIndex(rec); } catch { /* refresh replaces a damaged index */ }
  const index = await fetchGithubSkillIndex(rec.source.ref, rec.name, progress, previous ?? undefined);
  const root = skillMarketsRoot();
  await fs.mkdir(root, { recursive: true });
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
}, progress?: MarketProgressSink): Promise<{ ok: boolean; error?: string; name?: string }> {
  try {
    const records = withBuiltins(readRecords());
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
      if (!existsSync(ref) || !statSync(ref).isDirectory()) return { ok: false, error: `目录不存在:${ref}` };
      if (records.some((r) => r.source.kind === "local" && path.resolve(r.source.ref) === ref)) {
        return { ok: false, error: `这个目录已经在市场里了:${ref}` };
      }
      defaultName = sanitizeName(path.basename(ref));
    }
    let name = input.name ?? sanitizeName(defaultName);
    if (!SKILL_MARKET_NAME_RE.test(name)) return { ok: false, error: `市场名称不合法:${name}` };
    if (records.some((r) => r.name === name)) {
      if (input.name) return { ok: false, error: `同名市场已存在:${name}` };
      let i = 2;
      while (records.some((r) => r.name === `${name}-${i}`)) i += 1;
      name = `${name}-${i}`;
    }
    const rec: MarketRecord = { name, source: { kind: input.kind, ref }, addedAt: new Date().toISOString() };
    if (rec.source.kind === "git") {
      await fetchGitCatalog(rec, progress);
      rec.fetchedAt = new Date().toISOString();
    }
    progress?.({ phase: "scan", message: "扫描技能目录 / Scanning skill catalog", elapsedMs: 0 });
    if ((await scanCatalog(rec)).length === 0) {
      if (rec.source.kind === "git") await fs.rm(catalogDir(rec), { recursive: true, force: true }).catch(() => {});
      return { ok: false, error: "里面没有找到任何 SKILL.md —— 它不是技能仓库" };
    }
    await writeRecords([...readRecords(), rec]);
    return { ok: true, name };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function removeSkillMarket(name: string): Promise<{ ok: boolean; error?: string }> {
  const rec = withBuiltins(readRecords()).find((r) => r.name === name);
  if (!rec) return { ok: false, error: `市场不存在:${name}` };
  if (rec.builtin) return { ok: false, error: "内置市场不能移除" };
  await writeRecords(readRecords().filter((r) => r.name !== name));
  if (rec.source.kind === "git") await fs.rm(catalogDir(rec), { recursive: true, force: true }).catch(() => {});
  return { ok: true };
}

export async function refreshSkillMarket(name: string, progress?: MarketProgressSink): Promise<{ ok: boolean; error?: string }> {
  const rec = withBuiltins(readRecords()).find((r) => r.name === name);
  if (!rec) return { ok: false, error: `市场不存在:${name}` };
  if (rec.source.kind === "local") {
    return existsSync(catalogDir(rec)) ? { ok: true } : { ok: false, error: `目录不存在:${rec.source.ref}` };
  }
  try {
    await fetchGitCatalog(rec, progress);
    const records = readRecords();
    const fetchedAt = new Date().toISOString();
    const idx = records.findIndex((r) => r.name === name);
    if (idx >= 0) records[idx] = { ...records[idx], fetchedAt };
    else records.push({ ...rec, addedAt: rec.addedAt || fetchedAt, fetchedAt });
    await writeRecords(records);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
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

export async function installSkillsFromMarket(
  market: string,
  names: readonly string[],
  progress?: MarketProgressSink,
): Promise<SkillsMarketInstallResult> {
  const rec = withBuiltins(readRecords()).find((r) => r.name === market);
  if (!rec) return { ok: false, error: `市场不存在:${market}`, imported: [], skipped: [], errors: [] };
  const remoteIndex = cachedGithubIndex(rec);
  const catalog = await scanCatalog(rec);
  const byName = new Map(catalog.map((s) => [s.name, s]));
  const libRoot = defaultSkillsRoot();
  await fs.mkdir(libRoot, { recursive: true });
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
    if (existsSync(dest)) {
      skipped.push(name);
      continue;
    }
    try {
      if (remoteIndex) {
        const staging = path.join(path.dirname(libRoot), `.skill-install-${randomUUID()}`);
        try {
          await downloadGithubSkill(remoteIndex, hit.relPath, staging, progress);
          if (existsSync(dest)) { skipped.push(name); continue; }
          await fs.rename(staging, dest);
        } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
      } else {
        await fs.cp(hit.dir, dest, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
      }
      imported.push(name);
    } catch (err) {
      errors.push({ name, error: (err as Error).message });
    }
  }
  return { ok: imported.length > 0 || skipped.length > 0, imported, skipped, errors };
}
