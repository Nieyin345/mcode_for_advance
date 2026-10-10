import type { MemoryWriteOrigin } from "@contracts/memory";
import { memoryAddress } from "./paths.js";
import { looksLikeSecret } from "./secretShape.js";
/**
 * 记忆库的存储层(MEM-01)—— `<数据根>/memory/<类目>/*.md`。
 *
 * ## 文件即事实源,markdown + frontmatter
 *
 * ```
 * ---
 * title: 引用规范
 * updatedAt: 1726699200000
 * ---
 * 引用一律用 APA。
 * ```
 *
 * **人可以直接用编辑器打开改** —— 这是硬要求。所以不发明二进制格式、不入数据库;
 * frontmatter 只有两行(title / updatedAt),`updatedAt` 丢了也有文件 mtime 兜底
 * (见 {@link parseFrontmatter})。主进程在每次 `save` 时重写 frontmatter 并盖章
 * `updatedAt = now`,人手改的正文不动。
 *
 * ## 路径是唯一寻址方式,也是唯一攻击面
 *
 * 外面传进来的 `path` 一律当**不可信输入**:`<类目>/<文件名>.md` 两段、类目必须在这
 * 六个白名单里、文件名不许带路径分隔符与点开头,先用 resolve 前缀比对做词法终审，
 * 再拒绝 memory 根 / 类目目录 / 目标文件上的 symlink 或 junction —— 防止路径字面上在库内、
 * 实际 I/O 却被重解析到库外。过不了就明确拒绝,不"尽量解释"。
 */
import { createHash, randomUUID } from "node:crypto";
import { linkSync, renameSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  MEMORY_CATEGORIES,
  type MemoryFileMeta,
  type MemoryListInput,
  type MemorySaveInput,
} from "@contracts/memory";
import { dataRoot } from "@main/lib/dataRoot.js";

/** 记忆库在数据根下的目录名。 */
const MEMORY_DIR = "memory";

/** 记忆库根:`<数据根>/memory`。 */
export function memoryRoot(): string {
  return join(dataRoot(), MEMORY_DIR);
}

/* ── 路径校验与解析 ── */

/**
 * memory 根下的相对路径 → 绝对路径。**不合法返回 null,调用方负责拒绝。**
 *
 * 四道词法闸,按顺序:
 *  1. 不是绝对路径、不含反斜杠与 NUL(反斜杠是 Windows 分隔符,放进来就是另一种写法
 *     的目录穿越);
 *  2. 恰好两段 `类目/文件名`,类目在白名单里(目录即类目,多了子目录就是另一套布局);
 *  3. 文件名以 `.md` 结尾、不超长、不以点开头(`.hidden` 与 `..` 一起挡掉);
 *  4. resolve 后必须仍落在该类目目录内 —— 前三道是词法检查,这一道是词法终审(同
 *     `fileImport.ts` 的 `startsWith(root + sep)` 写法)。
 * 真正 I/O 前还会再走 `resolveSafeMemoryRelPath`，拒绝 symlink / junction 重解析。
 */
function resolveMemoryRelPath(relPath: string): string | null {
  if (isAbsolute(relPath) || !memoryAddress(relPath)) return null;
  const root = resolve(memoryRoot());
  const target = resolve(root, relPath);
  return target.startsWith(root + sep) ? target : null;
}
function resolveSafeMemoryRelPath(relPath: string): string | null {
  const target = resolveMemoryRelPath(relPath);
  if (!target) return null;
  const parts = relPath.split("/");
  let current = memoryRoot();
  for (let i = 0; i <= parts.length; i++) {
    try { if (lstatSync(current).isSymbolicLink()) return null; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (i < parts.length) current = join(current, parts[i]!);
  }
  return target;
}

/* ── frontmatter ── */

interface MemoryFrontmatter {
  title: string;
  updatedAt: number;
  /** 去掉 frontmatter 之后的正文(原样,含换行)。 */
  body: string;
}

/** 解析文件头那段 `--- ... ---`。没有 frontmatter / 解不动 → title 空、updatedAt 0、全文当正文。 */
export function parseFrontmatter(raw: string): MemoryFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return { title: "", updatedAt: 0, body: raw };
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return {
    title: unquote(meta.title ?? ""),
    updatedAt: Number(meta.updatedAt) || 0,
    body: raw.slice(match[0].length),
  };
}

/** title 值支持 JSON 双引号(写入侧用 `JSON.stringify` 保证单行);裸串原样。 */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      /* 引号不成对就当字面量 */
    }
  }
  return value;
}

/** title 压成单行再 JSON 引起来 —— YAML 的双引号标量就是 JSON 字符串,解析侧通用。 */
function quoteTitle(title: string): string {
  return JSON.stringify(title.replace(/\r?\n/g, " ").trim());
}

/* ── CRUD ── */

/**
 * 列出全部记忆文件。类目按固定次序,类目内按 `updatedAt` 新的在前。
 * 空目录/不存在的目录返回空数组 —— "还没有记忆"是常态,不是错误。
 * 整理入口可传 onUnreadable：列目录阶段被跳过的异常 *.md / 非法链接也要明确告知人。
 */
export function listMemoryFiles(filter?: MemoryListInput & { onUnreadable?: (path: string) => void }): MemoryFileMeta[] {
  const out: MemoryFileMeta[] = [];
  const walk = (rel: string, depth: number): void => {
    const dir = join(memoryRoot(), rel);
    try {
      if (lstatSync(dir).isSymbolicLink()) { filter?.onUnreadable?.(rel || "memory/"); return; }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) { filter?.onUnreadable?.(path); continue; }
        if (memoryAddress(path) && !entry.isFile()) { filter?.onUnreadable?.(path); continue; }
        if (entry.isDirectory() && depth < 3) { walk(path, depth + 1); continue; }
        const address = memoryAddress(path);
        if (!entry.isFile() || !address || filter?.category && address.category !== filter.category) continue;
        try {
          const target = resolveSafeMemoryRelPath(path);
          if (!target) throw new Error("unsafe path");
          const raw = readFileSync(target, "utf8"), parsed = parseFrontmatter(raw);
          out.push({ path, category: address.category, title: parsed.title || address.file.slice(0, -3),
            updatedAt: parsed.updatedAt || Math.round(statSync(target).mtimeMs),
            scope: address.scope, ...(address.projectId ? { projectId: address.projectId } : {}),
            pinned: /^pinned: true$/m.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "") });
        } catch { filter?.onUnreadable?.(path); }
      }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") filter?.onUnreadable?.(rel || "memory/"); }
  };
  walk("", 0);
  return out.sort((a, b) => MEMORY_CATEGORIES.indexOf(a.category as typeof MEMORY_CATEGORIES[number]) -
    MEMORY_CATEGORIES.indexOf(b.category as typeof MEMORY_CATEGORIES[number]) || b.updatedAt - a.updatedAt);
}

/**
 * 把 Node 的文件系统错误翻成一句给人看的短语 —— **别让 `ENOENT: …, open 'C:\…'`
 * 这种原始英文 + 绝对路径漏到界面/模型手上**。
 *
 * 记忆的读通路有两条:面板(`ipc/memory.ts` 的 `memory:read`)与 MCP 工具
 * (`mcp/memoryServer.ts` 的 `memory_read`),两条都把 `message` 原样摆出来
 * (`t("memory.readFailed", { error })` / `fail(...)`)。而 `readFileSync` / `lstatSync`
 * 在读不到时抛的是 **OS 原文**,里面还带着**用户机器的绝对路径**(实测会漏出
 * `ENOENT: no such file or directory, open 'C:\Users\…\memory\rules\x.md'`)。
 * 与 `mcp/agentSearchSessions.ts` 的 `agent_search_read` 一条口径:常见 errno 翻成中文,
 * 其余保留原文(至少不吞)。
 */
function describeFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "文件不存在或已被移走";
  if (code === "EACCES" || code === "EPERM") return "没有访问权限";
  if (code === "EISDIR") return "不是一个文件";
  if (code === "ENOTDIR") return "所在的位置不是一个目录";
  if (code === "EEXIST") return "同名文件或目录已存在";
  if (code === "ENOSPC") return "磁盘空间不足";
  if (code === "EROFS") return "所在的位置是只读的";
  return err instanceof Error ? err.message : String(err);
}

/** 只有真正的 OS errno 错误(`err.code` 是字符串)才需要翻译;我们自己抛的中文错误、
 *  `MemoryConflictError` 等原样透出。 */
function translateFsError(err: unknown, what: string): never {
  if (err instanceof MemoryConflictError) throw err;
  if (err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string") {
    throw new Error(`${what}:${describeFsError(err)}`);
  }
  throw err;
}

/** 读一条记忆的**正文**(不含 frontmatter)。路径不合法或读不到 → 抛(话直接给用户)。 */
export function readMemoryFile(relPath: string): { content: string; revision: string } {
  const { content, revision } = readMemoryFileWithRaw(relPath);
  return { content, revision };
}

/** 与 read 共用安全路径闸；整理校验要比对原始 markdown，连手写 frontmatter 也不能漏。 */
export function readMemoryFileWithRaw(relPath: string): { content: string; raw: string; revision: string } {
  const target = resolveSafeMemoryRelPath(relPath);
  if (target === null) throw new Error(`不是合法的记忆路径:「${relPath}」(应为 <类目>/<文件名>.md,类目限定六类)`);
  try {
    const raw = readFileSync(target, "utf8");
    return { content: parseFrontmatter(raw).body, raw, revision: revisionOf(raw) };
  } catch (err) {
    throw new Error(`读不到记忆「${relPath}」:${describeFsError(err)}`);
  }
}

/**
 * 写一条记忆(存在则覆盖)。`content` 是**正文**;frontmatter 由这里生成:
 * title 缺省沿用旧标题,没有旧标题就用文件名;`updatedAt` 每次盖章为现在。
 * 返回写完的时间戳(渲染端刷新行用)。
 */
export class MemoryConflictError extends Error {
  readonly code = "conflict";
  constructor() {
    super("记忆已改变、已删除或同名文件已存在；未覆盖或删除。请重新读取最新内容并合并后重试。");
    this.name = "MemoryConflictError";
  }
}

function revisionOf(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Absence is different from unreadable: never turn EACCES/EISDIR into permission to overwrite. */
function currentRaw(target: string): string | null {
  try { return readFileSync(target, "utf8"); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // 读一个"本该是记忆文件"的位置失败(EISDIR —— 目录被命名成 `x.md` 那种半同步形态;
    // EACCES —— 权限),抛的是 **OS 原文**(`EISDIR: illegal operation on a directory, read`)。
    // 这句经 `saveMemoryFile`/`deleteMemoryFile` 的调用方原样摆进面板的 `{ ok:false, error }`
    // 与 MCP 工具的 `fail(...)` —— 别让英文 errno 漏给人看(与读通路同一句判据)。
    throw new Error(`记忆文件读不出来:${describeFsError(err)}`);
  }
}

function assertRevision(raw: string | null, expected: string | null | undefined): void {
  if (expected == null ? raw !== null : raw === null || revisionOf(raw) !== expected) {
    throw new MemoryConflictError();
  }
}

/** Synchronous compare + publish serializes callers in this host process.
 * External editors not participating in this protocol can still race the final
 * check/rename; this is NOT a distributed/filesystem compare-and-swap guarantee.
 * Never fall back to truncating the live file if rename fails. */
export function saveMemoryFile(input: MemorySaveInput, origin?: MemoryWriteOrigin): { updatedAt: number; revision: string } {
  const target = resolveSafeMemoryRelPath(input.path);
  if (target === null) throw new Error(`不是合法的记忆路径:「${input.path}」(应为 <类目>/<文件名>.md,类目限定六类)`);
  // 判据与「送进模型前遮蔽」共用同一份(见 `secretShape.ts`)—— 从前两处各写一遍,
  // PEM 那支已经漂了(闸门只要求 BEGIN,遮蔽要求完整 BEGIN…END)。
  if (looksLikeSecret(input.content)) {
    throw new Error("记忆包含疑似私钥或访问密钥，未保存；请仅记录凭据的管理位置，不记录值。");
  }
  const before = currentRaw(target);
  assertRevision(before, input.expectedRevision);
  const previous = parseFrontmatter(before ?? "");
  const name = input.path.split("/").at(-1) ?? "";
  const title = (input.title ?? "").trim() || previous.title || name.slice(0, -3);
  const updatedAt = Date.now();
  const extra = (/^---\r?\n([\s\S]*?)\r?\n---/.exec(before ?? "")?.[1] ?? "").split(/\r?\n/)
    .filter(line => line.trim() && !/^(?:title|updatedAt|pinned):/.test(line) && !(origin && /^mcodeLastWriter:/.test(line)));
  if (origin) extra.push(`mcodeLastWriter: ${JSON.stringify(origin)}`);
  const pinned = input.pinned ?? /^pinned: true$/m.test(/^---\r?\n([\s\S]*?)\r?\n---/.exec(before ?? "")?.[1] ?? "");
  const raw = [`---`, `title: ${quoteTitle(title)}`, `updatedAt: ${updatedAt}`, ...extra, ...(pinned ? ["pinned: true"] : []), `---`, "", input.content.replace(/\s+$/, ""), ""].join("\n");
  const tmp = `${target}.${randomUUID()}.mcode-tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (resolveSafeMemoryRelPath(input.path) !== target) throw new Error("记忆路径已改变，未保存");
    assertRevision(currentRaw(target), input.expectedRevision);
    if (before === null) {
      // Atomic no-clobber publication. An overlapping creator wins, never gets replaced.
      try { linkSync(tmp, target); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new MemoryConflictError();
        throw err;
      }
    } else {
      saveRevision(input.path, before, "before-update");
      renameSync(tmp, target);
    }
  } catch (err) {
    // `mkdirSync`/`writeFileSync`/`renameSync` 的 OS 原文(`EEXIST: file already exists,
    // mkdir 'C:\…'` 这种)带着绝对路径,会被面板摆成 `{ ok:false, error }` —— 翻成中文。
    translateFsError(err, `保存记忆「${input.path}」失败`);
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* Best-effort orphan cleanup; never mask the write result. */ }
  }
  return { updatedAt, revision: revisionOf(raw) };
}

/** Missing file is idempotent; an existing file always requires the reader's revision. */
export function deleteMemoryFile(relPath: string, expectedRevision?: string): { ok: true } {
  const target = resolveSafeMemoryRelPath(relPath);
  if (target === null) throw new Error(`不是合法的记忆路径:「${relPath}」(应为 <类目>/<文件名>.md,类目限定六类)`);
  const raw = currentRaw(target);
  if (raw === null) return { ok: true };
  if (expectedRevision === undefined) throw new MemoryConflictError();
  assertRevision(raw, expectedRevision);
  try {
    saveRevision(relPath, raw, "before-delete");
    rmSync(target, { force: true });
  } catch (err) {
    // 归档写不下 / 删不动时的 OS 原文同样带着绝对路径,别漏给用户。
    translateFsError(err, `删除记忆「${relPath}」失败`);
  }
  return { ok: true };
}

/** 固定六类(界面建文件时的类目下拉、校验白名单同一份)。 */
export function memoryCategories(): string[] {
  return [...MEMORY_CATEGORIES];
}

/** Revision snapshots are private, never included in retrieval. Archive first, mutate second. */
function archiveRoot(): string {
  const dir = join(memoryRoot(), ".history");
  for (const p of [memoryRoot(), dir]) {
    try { if (lstatSync(p).isSymbolicLink()) throw new Error("记忆历史目录不允许链接"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
  return dir;
}
function saveRevision(path: string, raw: string, reason: string): void {
  const dir = archiveRoot(); mkdirSync(dir, { recursive: true });
  const at = Date.now(), id = `${at}-${randomUUID()}`;
  writeFileSync(join(dir, id + ".json"), JSON.stringify({ version: 1, id, path, at, reason, raw }), { flag: "wx", mode: 0o600 });
}
export function memoryHistory(): { entries: Array<{ id: string; path: string; at: number; reason: string }>; truncated: number } {
  const dir = archiveRoot();
  let names: string[];
  try { names = readdirSync(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], truncated: 0 }; throw err; }
  // ⚠️ **截断要说出来。** 归档目录只增不减(见 `docs/memory-unification.md`:不自动清理旧归档),
  // 而「恢复记忆」的下拉框只吃这里的返回 —— 静默 `.slice(0, 200)` 会让用户以为更早的恢复点
  // 不存在。与 `manage.ts` 的 `nativeSources.truncatedSources` 同一口径:报出被挡掉的条数,
  // 界面据此提示。损坏条目仍旧逐条丢(`catch`),但那种丢不计数 —— 它不是"被上限挡的"。
  const all = names.filter(name => /^[0-9]+-[a-f0-9-]+\.json$/.test(name)).sort().reverse();
  const entries = all.slice(0, 200)
    .flatMap(name => { try { const v = readHistory(name.slice(0, -5)); return [{ id: v.id, path: v.path, at: v.at, reason: v.reason }]; } catch { return []; } });
  return { entries, truncated: Math.max(0, all.length - 200) };
}
export function readHistory(id: string): { id: string; path: string; at: number; reason: string; raw: string } {
  if (!/^[0-9]+-[a-f0-9-]+$/.test(id)) throw new Error("无效历史编号");
  const path = join(archiveRoot(), id + ".json");
  let text: string;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("历史文件不允许链接");
    text = readFileSync(path, "utf8");
  } catch (err) {
    // `lstatSync`/`readFileSync` 的 ENOENT 是**原始英文 OS 错误**,还带着数据根的
    // 绝对路径(实测 `ENOENT: no such file or directory, lstat 'C:\Users\…\.history\…'`)。
    // 这条经 `manage.ts` 的 `history`/`restore` 原样摆进设置面板的「读不出来:{error}」,
    // 会漏给用户看 —— 翻成中文(与 `readMemoryFileWithRaw` 同一句判据)。历史文件不允许
    // 链接那句是我们自己抛的中文,原样透出。
    if (err instanceof Error && err.message === "历史文件不允许链接") throw err;
    throw new Error(`恢复点不存在或已损坏:${describeFsError(err)}`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    // `JSON.parse` 抛的是英文 "Expected property name or '}' in JSON at position …"。
    throw new Error("恢复点已损坏(内容不是合法 JSON)");
  }
  if (!v || typeof v !== "object") throw new Error("历史记录损坏");
  const r = v as Record<string, unknown>;
  if (r.version !== 1 || r.id !== id || typeof r.path !== "string" || !memoryAddress(r.path) ||
      typeof r.raw !== "string" || typeof r.at !== "number" || typeof r.reason !== "string") throw new Error("历史记录损坏");
  return { id, path: r.path, at: r.at, reason: r.reason, raw: r.raw };
}
export function restoreMemory(id: string): { path: string; revision: string } {
  const saved = readHistory(id), target = resolveSafeMemoryRelPath(saved.path);
  if (!target) throw new Error("恢复路径不安全");
  assertRevision(currentRaw(target), null);
  const tmp = `${target}.${randomUUID()}.mcode-tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, saved.raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (resolveSafeMemoryRelPath(saved.path) !== target) throw new Error("恢复路径已改变");
    try { linkSync(tmp, target); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new MemoryConflictError();
      throw err;
    }
  } catch (err) {
    // 恢复点写回目标位置的 OS 原文(`EEXIST: …, mkdir 'C:\…'` 之类)带着绝对路径,
    // 会被设置面板的「读不出来:{error}」原样摆出 —— 翻成中文(与写通路同一句判据)。
    translateFsError(err, `恢复记忆「${saved.path}」失败`);
  } finally { try { rmSync(tmp, { force: true }); } catch { /* orphan only */ } }
  return { path: saved.path, revision: revisionOf(saved.raw) };
}
