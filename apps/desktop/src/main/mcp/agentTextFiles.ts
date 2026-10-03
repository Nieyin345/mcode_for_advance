import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";

/** Shared across tool hosts: concurrent edits to one real path must not lose updates. */
const writes = new Map<string, Promise<unknown>>();
export async function withTextFileLock<T>(file: string, action: (real: string) => Promise<T>): Promise<T> {
  const real = await fs.realpath(file).catch(() => path.resolve(file));
  const key = process.platform === "win32" ? real.toLowerCase() : real;
  const previous = writes.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(() => action(real));
  writes.set(key, task);
  try { return await task; }
  finally { if (writes.get(key) === task) writes.delete(key); }
}
export const textFileHash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Optimistic external-edit check, not an OS-wide transaction with arbitrary editors. */
export async function replaceTextFile(file: string, content: string, original: Buffer): Promise<void> {
  const stat = await fs.stat(file);
  const temp = `${file}.mcode-edit-${randomUUID()}`;
  try {
    await fs.writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: stat.mode });
    if (textFileHash(await fs.readFile(file)) !== textFileHash(original)) {
      throw new Error("文件已被其他操作修改；本次未覆盖，请重新读取后重试 / File changed; reread before retrying");
    }
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => undefined); }
}

export interface TextPageOptions {
  offset?: number;
  limit?: number;
  column_offset?: number;
  max_chars?: number;
  expected_sha256?: string;
}
export interface TextPage {
  path: string;
  content: string;
  sha256: string;
  total_lines: number;
  size_bytes: number;
  returned_chars: number;
  has_more: boolean;
  truncated: boolean;
  next_offset: number;
  next_column_offset: number;
}

/** Bounded, lossless UTF-8 content pages; columns count UTF-16 code units (like JS strings).
 * Scan/hash the same open descriptor, retaining at most max_chars of decoded text.
 * The checksum protects continuation against changes between requests.
 */
export async function readTextPage(file: string, opts: TextPageOptions = {}): Promise<TextPage> {
  const offset = opts.offset ?? 1, limit = opts.limit ?? 2000, column = opts.column_offset ?? 0;
  const budget = Math.max(1, Math.min(opts.max_chars ?? 30000, 60000));
  const handle = await fs.open(file, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("不是普通文本文件 / Not a regular text file");
    const hash = createHash("sha256"), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const pieces: string[] = [];
    let line = 1, col = 0, used = 0, nextLine = offset, nextCol = column;
    let stopped = false, more = false, started = false;
    const consume = (chunk: string): void => {
      for (const ch of chunk) {
        if (line === offset && col < column && ch === "\n") throw new Error("column_offset 超出该行 / Column past end of line");
        const selected = line > offset || (line === offset && col >= column);
        if (selected) {
          if (!started && line === offset && col !== column) throw new Error("column_offset 不能位于 Unicode 字符中间 / Invalid Unicode boundary");
          started = true;
          if (stopped || line >= offset + limit || used + ch.length > budget) { stopped = true; more = true; }
          else {
            pieces.push(ch); used += ch.length;
            nextLine = ch === "\n" ? line + 1 : line;
            nextCol = ch === "\n" ? 0 : col + ch.length;
          }
        }
        if (ch === "\n") { line++; col = 0; } else col += ch.length;
      }
    };
    const buffer = Buffer.alloc(64 * 1024);
    let first = true;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (first && chunk.subarray(0, 8192).includes(0)) throw new Error("看起来是二进制文件 / Binary file; use the document or image tool");
      first = false; hash.update(chunk); consume(decoder.decode(chunk, { stream: true }));
    }
    consume(decoder.decode());
    if (line === offset && column > col) throw new Error("column_offset 超出该行 / Column past end of line");
    const after = await handle.stat(), current = await fs.stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || current.ino !== after.ino || current.mtimeMs !== after.mtimeMs) {
      throw new Error("读取期间文件发生变化，请重试 / File changed during read");
    }
    const sha256 = hash.digest("hex");
    if (opts.expected_sha256 && opts.expected_sha256.toLowerCase() !== sha256) throw new Error("文件版本已变化，请从头重新读取 / File version changed");
    return { path: file, content: pieces.join(""), sha256, total_lines: line, size_bytes: before.size, returned_chars: used,
      has_more: more, truncated: more, next_offset: nextLine, next_column_offset: nextCol };
  } finally { await handle.close(); }
}

export function formatTextPage(page: TextPage, offset = 1, column = 0): string {
  const rows = page.content.split(/\r?\n/);
  if (page.content.endsWith("\n")) rows.pop();
  const numbered = rows.map((row, i) => `${offset + i}${i === 0 && column ? `:${column + 1}` : ""}\t${row}`);
  return `[${page.path} 共 ${page.total_lines} 行; ${page.size_bytes > 2 * 1024 * 1024 ? "大文件流式读取" : "流式读取"}; sha256=${page.sha256}]\n${numbered.join("\n")}` +
    (page.has_more ? `\n…(未读完；用 offset=${page.next_offset}, column_offset=${page.next_column_offset}, expected_sha256=${page.sha256} 继续)` : "");
}

/** Show the match, not an unrelated prefix of a long line. */
export function grepMatchPreview(line: string, index: number, matchLength: number, budget = 300): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(line.length, Math.max(start + budget, index + Math.min(matchLength, budget)));
  return `${start ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}
