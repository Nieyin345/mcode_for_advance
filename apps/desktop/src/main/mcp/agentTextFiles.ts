import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import { withOsFileLease } from "@main/lib/osFileLease.js";
import { writeConflictCopy } from "@main/lib/conflictCopy.js";

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

/**
 * 【MC-024】Agent 文本文件的**宿主级**读-改-写租约 —— 「跨进程租约 + 进程内串行」两级。
 *
 * ## 它补的是哪条洞
 *
 * `withTextFileLock` 只是本进程的一张 `Map`:两个 Mcode 实例(或一个 Mcode + 一个外部
 * 编辑器)各自从同一版本读取、各自通过自己进程内的锁、再分别替换整个文件 —— **丢更新**。
 * 「读旧哈希 → 校验 → rename」两步之间没有跨进程互斥,第二个提交者的校验同样通过
 * (它读到的还是旧哈希),于是 A 的修改被 B 静默覆盖。
 *
 * ## 修法:与 `ipc/files.ts` 的 FILE_WRITE 和 Excel/PDF/DOCX **共用同一份**宿主级原语
 *
 * `lib/osFileLease.ts` 的磁盘独占锁(台账要求的「跨写入口统一」——这是第 3 个接入点,
 * 不是新锁)。进程内 `Map` 保留在内层:同进程的 async 并发先用它排队,免得两个协程
 * 互相抢磁盘锁浪费抖动;跨进程那层由 `withOsFileLease` 兜。
 *
 * 遵守锁的进程之间保证串行 + 校验冲突可见;不遵守锁的第三方编辑器仍只能靠
 * `expected_sha256` 的乐观校验兜(该边界与原实现一致,见 `replaceTextFile` 注释)。
 */
export async function withAgentTextFileLease<T>(file: string, action: (real: string) => Promise<T>): Promise<T> {
  return withOsFileLease(file, (real) => withTextFileLock(real, action));
}

/**
 * 【MC-069】二进制文档写入(Excel/DOCX/PDF)**共用同一把**按真实物理路径的进程内串行锁。
 *
 * 复用文本编辑那一份,而不是另起一张 Map —— 否则同一条路径上,`agent_edit_file`(文本)
 * 与 `agent_edit_excel_range`(二进制)会各排各的队、照样互相覆盖。见 `agentDocumentOps.ts`
 * 里 `editExcelRange` / `editDocxXml` / `writePdf` 的用法。
 */
export const withDocFileLock = withTextFileLock;

/** Optimistic external-edit check, not an OS-wide transaction with arbitrary editors.
 *
 * 【MC-024】**CAS 拒绝不丢本次正文**：与桌面 `file.writeFile` 同一判据 —— 校验失败时
 * 把 `content`（本次原本要提交的完整新内容）另存为同目录冲突副本（共享
 * `@main/lib/conflictCopy.ts` 那一份），并把副本路径写进错误消息（工具回包原样转给
 * 模型）。原文件保持盘上（别人的）内容不动。副本写失败不改变冲突结论 —— 仍报版本
 * 冲突，只是消息里没有路径（**不谎报**）。 */
export async function replaceTextFile(file: string, content: string, original: Buffer): Promise<void> {
  const stat = await fs.stat(file);
  const temp = `${file}.mcode-edit-${randomUUID()}`;
  try {
    await fs.writeFile(temp, content, { encoding: "utf8", flag: "wx", mode: stat.mode });
    if (textFileHash(await fs.readFile(file)) !== textFileHash(original)) {
      const conflictPath = await writeConflictCopy(file, content).catch(() => null);
      const saved = conflictPath
        ? `；本次要写入的内容已另存为冲突副本:${conflictPath} / This attempt was saved to a conflict copy`
        : "";
      throw new Error(`文件已被其他操作修改；本次未覆盖，请重新读取后重试 / File changed; reread before retrying${saved}`);
    }
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => undefined); }
}

export interface TextEdit {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** 把一组精确替换应用到 `content` 上（LF/CRLF 自动适配，逐条顺序应用）。
 *
 * 【MC-024】抽成纯函数是为了让**冲突副本**与正常提交用同一份「本次要写入的内容」
 * 计算：`agent_edit_file` 的 `expected_sha256` 校验失败时，要把模型这次的编辑应用到
 * 当前磁盘内容上生成副本 —— 与正常路径各写一份替换逻辑必然漂移。
 *
 * 任何一处对不上就**整次抛错**（调用方据此不写入任何改动），错误文案带上第几处
 * edit 与"这次没有写入任何改动"。
 */
export function applyTextEdits(
  content: string,
  edits: TextEdit[],
): { content: string; touched: number[]; replaced: number } {
  const crlf = content.includes("\r\n");
  const touched: number[] = [];
  let replaced = 0;
  edits.forEach((edit, k) => {
    const which = edits.length > 1 ? `第 ${k + 1} 处 edit:` : "";
    let oldStr = edit.old_string;
    let newStr = edit.new_string;
    // Normalize replacement line endings even when old_string is a single line.
    const newline = crlf ? "\r\n" : "\n";
    if (!content.includes(oldStr)) oldStr = oldStr.replace(/\r?\n/g, newline);
    newStr = newStr.replace(/\r?\n/g, newline);
    const first = content.indexOf(oldStr);
    if (first < 0) {
      throw new Error(`${which}没找到 old_string —— 内容必须逐字一致(含空格缩进),先用 agent_read_file 确认原文;这次没有写入任何改动`);
    }
    const count = content.split(oldStr).length - 1;
    if (count > 1 && !edit.replace_all) {
      throw new Error(
        `${which}old_string 在文件里出现 ${count} 次;请扩大上下文让匹配唯一,或传 replace_all=true;这次没有写入任何改动`,
      );
    }
    touched.push(content.slice(0, first).split("\n").length);
    content = edit.replace_all
      ? content.split(oldStr).join(newStr)
      : content.slice(0, first) + newStr + content.slice(first + oldStr.length);
    replaced += edit.replace_all ? count : 1;
  });
  return { content, touched, replaced };
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
