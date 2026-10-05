/** GitHub skill markets are metadata indexes, never repository checkouts.
 * All reads/installations are pinned to the indexed commit. No Git, archive
 * fallback, credential discovery, submodule or symlink traversal. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SKILL_NAME_RE } from "@contracts/ipc";
import { parseSkillFrontmatter } from "@main/lib/skillEngines.js";
import type { MarketProgressSink } from "@main/lib/marketClone.js";

export const GITHUB_INDEX_FILE = ".github-skill-index.json";
export interface GithubSource { owner: string; repo: string; ref?: string }
interface RemoteFile { path: string; sha: string; size: number; mode: string; type: string }
export interface GithubSkillIndex {
  version: 1;
  source: GithubSource;
  commit: string;
  skills: Array<{ name: string; description: string; relPath: string }>;
  files: RemoteFile[];
}
const SHA = /^[a-f0-9]{40}$/;
const slug = (s: string) => typeof s === "string" && /^[\w.-]+$/.test(s) && s !== "." && s !== "..";

export function githubSkillSource(input: string): GithubSource {
  let value = input.trim();
  if (/^git@github\.com:/i.test(value)) value = "https://github.com/" + value.slice(value.indexOf(":") + 1);
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) value = "https://github.com/" + value;
  let u: URL;
  try { u = new URL(value); } catch { throw new Error("请填写 GitHub owner/repo 或仓库根网址 / Use a GitHub repository URL"); }
  if (!["http:", "https:", "ssh:"].includes(u.protocol) || !["github.com", "www.github.com"].includes(u.hostname.toLowerCase()) || u.port || u.password || (u.username && !(u.protocol === "ssh:" && u.username === "git"))) {
    throw new Error("在线技能市场仅支持公开 GitHub 仓库；其他 Git/私有仓库请使用本地文件夹，不会自动克隆整仓 / Use a local folder for other Git hosts or private repositories");
  }
  const parts = u.pathname.split("/").filter(Boolean).map(s => decodeURIComponent(s));
  const [owner, rawRepo] = parts, repo = rawRepo?.replace(/\.git$/i, "");
  if (!owner || !repo || !slug(owner) || !slug(repo) || (parts.length !== 2 && !(parts.length === 4 && parts[2] === "tree" && parts[3]))) {
    throw new Error("请使用仓库根地址，或 /tree/分支；带斜杠的分支请编码为 %2F，不接受模糊的子目录地址");
  }
  return { owner, repo, ...(parts[3] ? { ref: parts[3] } : {}) };
}

/** Reject unsafe/ambiguous file names on every OS, including Windows aliases. */
function safePath(value: string): boolean {
  return !!value && value.length <= 2048 && value.split("/").every(s => !!s && s !== "." && s !== ".." && !/[\\\x00-\x1f\x7f:<>"|?*]/.test(s) && !/[. ]$/.test(s) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s) && s.toLowerCase() !== ".git");
}
const below = (file: string, dir: string) => dir === "." || file.startsWith(dir + "/");
const rawUrl = (source: GithubSource, commit: string, file: string) => `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${commit}/${file.split("/").map(encodeURIComponent).join("/")}`;

/** Desktop requests use Chromium's OS certificate/proxy configuration, not
 * Node's independent bundled CA store. No certificate bypass or cookies. */
async function githubFetch(url: string, init: RequestInit): Promise<Response> {
  if (process.versions.electron) {
    const { net } = await import("electron");
    return net.fetch(url, { ...init, credentials: "omit" });
  }
  return fetch(url, init);
}

async function bytes(url: string, limit: number, signal: AbortSignal, prefix = false, accept?: string): Promise<Buffer> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let response: Response;
  try { response = await githubFetch(url, { signal: requestSignal, headers: { Accept: accept ?? (url.startsWith("https://api.github.com/") ? "application/vnd.github+json" : "application/octet-stream"), "User-Agent": "Mcode-Skill-Market", ...(prefix ? { Range: `bytes=0-${limit - 1}` } : {}) }, redirect: "error" }); }
  catch (error) {
    const cause = (error as { cause?: Error })?.cause?.message;
    throw new Error(`GitHub 读取失败 (${new URL(url).hostname}): ${requestSignal.aborted ? "请求超时或已中止 / Request timed out or aborted" : `${error instanceof Error ? error.message : String(error)}${cause ? ` ← ${cause}` : ""}`}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 403 || response.status === 429 ? "访问被限流或拒绝，请稍后重试；不会回退整仓下载 / Rate limited or forbidden"
      : response.status === 404 ? "仓库/分支/文件不存在或非公开；私有仓库请使用本地目录 / Not found or private repository" : "请稍后重试 / Retry later";
    throw new Error(`GitHub HTTP ${response.status}: ${hint}`);
  }
  if (!prefix && Number(response.headers.get("content-length") || 0) > limit) { await response.body?.cancel(); throw new Error("响应超出下载上限 / Download limit exceeded"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub 返回空响应 / Missing response body");
  const parts: Buffer[] = []; let count = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (count + value.byteLength > limit && !prefix) throw new Error("响应超出下载上限 / Download limit exceeded");
      const part = Buffer.from(value.subarray(0, limit - count)); parts.push(part); count += part.length;
      if (prefix && count >= limit) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts, count);
}

async function operation<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60_000);
  try { return await fn(controller.signal); }
  catch (error) { if (controller.signal.aborted) throw new Error("GitHub 操作超过 5 分钟，请稍后重试 / GitHub operation timed out after 5 minutes"); throw error; }
  finally { clearTimeout(timer); controller.abort(); }
}
async function pool<T>(items: T[], action: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0, failed: unknown;
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => {
    while (!failed && cursor < items.length) {
      const item = items[cursor++];
      try { await action(item); } catch (error) { failed ??= error; }
    }
  }));
  if (failed) throw failed;
}

export async function fetchGithubSkillIndex(input: string, marketName: string, progress?: MarketProgressSink, previous?: GithubSkillIndex): Promise<GithubSkillIndex> {
  const source = githubSkillSource(input), started = Date.now();
  const emit = (message: string) => progress?.({ phase: "scan", message, elapsedMs: Date.now() - started });
  return operation(async signal => {
    emit("读取 GitHub 目录索引，不下载技能内容 / Reading repository index, not skill files");
    const api = `https://api.github.com/repos/${source.owner}/${source.repo}`;
    // SHA media type avoids downloading commit diffs for unselected files.
    const commit = (await bytes(`${api}/commits/${encodeURIComponent(source.ref ?? "HEAD")}`, 128, signal, false, "application/vnd.github.sha")).toString("utf8").trim();
    if (!SHA.test(commit)) throw new Error("GitHub commit 格式无效");
    if (previous?.commit === commit && previous.source.owner.toLowerCase() === source.owner.toLowerCase() && previous.source.repo.toLowerCase() === source.repo.toLowerCase() && previous.source.ref === source.ref) {
      emit("远程版本未变化，复用技能索引 / Commit unchanged; using cached index");
      return previous;
    }
    // GitHub's trees API accepts a commit SHA and resolves its immutable tree.
    const tree = JSON.parse((await bytes(`${api}/git/trees/${commit}?recursive=1`, 12 * 1024 * 1024, signal)).toString("utf8"));
    if (tree.truncated === true) throw new Error("仓库目录索引被截断，未加载不完整市场；请使用本地目录 / GitHub tree truncated; no clone fallback");
    if (!Array.isArray(tree.tree) || tree.tree.length > 100_000) throw new Error("GitHub 目录格式无效或超出索引上限");
    const files: RemoteFile[] = tree.tree.filter((f: any) => f.type !== "tree").map((f: any) => {
      if (typeof f.path !== "string" || typeof f.sha !== "string" || !SHA.test(f.sha) || typeof f.mode !== "string" || typeof f.type !== "string" || (f.type === "blob" && (!Number.isSafeInteger(f.size) || f.size < 0))) throw new Error("GitHub 文件条目无效");
      return { path: f.path, sha: f.sha, mode: f.mode, type: f.type, size: f.size ?? 0 };
    });
    const dirs: string[] = [];
    for (const file of [...files].sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))) {
      if (file.type !== "blob" || !["100644", "100755"].includes(file.mode) || path.posix.basename(file.path) !== "SKILL.md" || !safePath(file.path)) continue;
      const dir = path.posix.dirname(file.path), components = dir === "." ? [] : dir.split("/");
      if (components.length > 8 || components.some(c => [".github", "node_modules", ".git"].includes(c)) || /^templates?$/i.test(components[0] ?? "")) continue;
      if (!dirs.some(parent => dir === parent || below(dir, parent))) dirs.push(dir);
    }
    dirs.sort((a, b) => a.localeCompare(b)); // Parent skills suppress nested examples before display ordering.
    if (dirs.length === 0) throw new Error("未找到可识别的 SKILL.md / No skills found");
    if (dirs.length > 2000) throw new Error("技能条目超出 2000 上限，未保存不完整索引");
    const discovered = new Map<string, { name: string; description: string; relPath: string }>();
    let done = 0;
    await pool(dirs, async dir => {
      const file = dir === "." ? "SKILL.md" : `${dir}/SKILL.md`;
      const head = (await bytes(rawUrl(source, commit, file), 8192, signal, true)).toString("utf8");
      const front = parseSkillFrontmatter(head);
      const name = dir === "." ? (front.name && SKILL_NAME_RE.test(front.name) ? front.name : marketName) : path.posix.basename(dir);
      if (SKILL_NAME_RE.test(name) && safePath(name)) discovered.set(dir, { name, description: (front.description ?? "").trim(), relPath: dir });
      emit(`读取技能简介 ${++done}/${dirs.length}（仅 SKILL.md 头部） / Reading skill metadata`);
    });
    const seen = new Set<string>();
    const skills = dirs.map(dir => discovered.get(dir)).filter((s): s is NonNullable<typeof s> => !!s).filter(s => { if (seen.has(s.name)) return false; seen.add(s.name); return true; }).sort((a,b) => a.name.localeCompare(b.name));
    if (!skills.length) throw new Error("没有有效的技能名称 / No valid skill names");
    return { version: 1, source, commit, skills, files: files.filter(f => skills.some(s => below(f.path, s.relPath))) };
  });
}

export function parseGithubSkillIndex(text: string): GithubSkillIndex {
  const index = JSON.parse(text) as GithubSkillIndex;
  if (index?.version !== 1 || !index.source || !slug(index.source.owner) || !slug(index.source.repo) || !SHA.test(index.commit) || !Array.isArray(index.skills) || !Array.isArray(index.files) || index.skills.length > 2000 || index.files.length > 100_000) throw new Error("技能索引缓存无效，请刷新 / Invalid skill index; refresh required");
  for (const s of index.skills) if (!s || typeof s.name !== "string" || (!SKILL_NAME_RE.test(s.name) || !safePath(s.name)) || typeof s.description !== "string" || (s.relPath !== "." && !safePath(s.relPath))) throw new Error("Invalid cached skill");
  for (const f of index.files) if (!f || typeof f.path !== "string" || !SHA.test(f.sha) || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.mode !== "string" || typeof f.type !== "string") throw new Error("Invalid cached file");
  return index;
}

/** Destination must not exist. Only this skill's subtree is ever requested. */
export async function downloadGithubSkill(index: GithubSkillIndex, relPath: string, destination: string, progress?: MarketProgressSink): Promise<void> {
  index = parseGithubSkillIndex(JSON.stringify(index));
  if (!index.skills.some(s => s.relPath === relPath)) throw new Error("技能不在索引中，请刷新");
  const files = index.files.filter(f => below(f.path, relPath));
  if (!files.length || files.length > 2000 || files.reduce((n,f) => n + f.size, 0) > 128 * 1024 * 1024) throw new Error("所选技能超出 2000 文件 / 128 MiB 上限，请使用本地目录");
  const paths = new Set<string>();
  const prefixes = new Map<string, { spelling: string; file: boolean }>();
  for (const file of files) {
    const local = relPath === "." ? file.path : file.path.slice(relPath.length + 1), key = local.normalize("NFC").toLowerCase();
    if (!safePath(local) || paths.has(key)) throw new Error("所选技能含不安全或大小写冲突的路径，未安装 / Unsafe or conflicting path");
    paths.add(key);
    const parts = local.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const spelling = parts.slice(0, i).join("/"), normalized = spelling.normalize("NFC").toLowerCase(), isFile = i === parts.length;
      const prior = prefixes.get(normalized);
      if (prior && (prior.spelling !== spelling || prior.file !== isFile)) throw new Error("所选技能包含冲突的文件/目录路径，未安装 / Conflicting file or directory paths");
      prefixes.set(normalized, { spelling, file: isFile });
    }
    if (file.type !== "blob" || !["100644", "100755"].includes(file.mode)) throw new Error("所选技能含符号链接或 submodule，请使用本地目录 / Symlink or submodule not supported");
    if (file.size > 32 * 1024 * 1024) throw new Error("所选技能单文件超过 32 MiB，请使用本地目录");
  }
  if (!paths.has("skill.md")) throw new Error("所选技能缺少 SKILL.md");
  const started = Date.now(); let done = 0;
  await fs.mkdir(destination);
  try {
    await operation(signal => pool(files, async file => {
      const content = await bytes(rawUrl(index.source, index.commit, file.path), 32 * 1024 * 1024, signal);
      if (content.length !== file.size || createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex") !== file.sha) throw new Error("技能文件校验失败，请刷新后重试 / Git blob integrity mismatch");
      if (content.subarray(0, 128).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) throw new Error("所选技能包含 Git LFS 文件，请使用已拉取 LFS 的本地目录");
      const local = relPath === "." ? file.path : file.path.slice(relPath.length + 1), target = path.join(destination, local);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 });
      progress?.({ phase: "scan", message: `下载所选技能 ${++done}/${files.length} / Downloading selected skill files`, elapsedMs: Date.now() - started });
    }));
  } catch (error) { await fs.rm(destination, { recursive: true, force: true }); throw error; }
}
