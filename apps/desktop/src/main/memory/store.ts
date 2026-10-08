import type { MemoryWriteOrigin } from "@contracts/memory";
import { memoryAddress } from "./paths.js";
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
    throw new Error(`读不到记忆「${relPath}」:${(err as Error).message}`);
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
    throw err;
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
  if (/(?:-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}|\bAKIA[A-Z0-9]{16}\b)/.test(input.content)) {
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
  saveRevision(relPath, raw, "before-delete");
  rmSync(target, { force: true });
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
export function memoryHistory(): Array<{ id: string; path: string; at: number; reason: string }> {
  const dir = archiveRoot();
  let names: string[];
  try { names = readdirSync(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
  return names.filter(name => /^[0-9]+-[a-f0-9-]+\.json$/.test(name)).sort().reverse().slice(0, 200)
    .flatMap(name => { try { const v = readHistory(name.slice(0, -5)); return [{ id: v.id, path: v.path, at: v.at, reason: v.reason }]; } catch { return []; } });
}
export function readHistory(id: string): { id: string; path: string; at: number; reason: string; raw: string } {
  if (!/^[0-9]+-[a-f0-9-]+$/.test(id)) throw new Error("无效历史编号");
  const path = join(archiveRoot(), id + ".json");
  if (lstatSync(path).isSymbolicLink()) throw new Error("历史文件不允许链接");
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
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
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${randomUUID()}.mcode-tmp`;
  try {
    writeFileSync(tmp, saved.raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (resolveSafeMemoryRelPath(saved.path) !== target) throw new Error("恢复路径已改变");
    try { linkSync(tmp, target); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new MemoryConflictError();
      throw err;
    }
  } finally { try { rmSync(tmp, { force: true }); } catch { /* orphan only */ } }
  return { path: saved.path, revision: revisionOf(saved.raw) };
}
