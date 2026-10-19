/**
 * PDF 高亮的**读、写、写回文件**（走 pdf.js 那条路）。
 *
 * ## 一条高亮存在两处，各有各的用
 *
 *  - **文件旁边的 `.<名字>.mcode-highlights.json`** —— 跟着文件走。文件被移动、
 *    复制、同步到别的机器，批注还在。这是"事实来源"。
 *  - **写回 PDF 本身**（真 `/Highlight` 批注）—— 拿出去用（发给别人、Acrobat
 *    里看）时带着。
 *
 * ## 为什么不用数据库
 *
 * `library_items` 加个 `highlights` 列要一次 schema 迁移，而且高亮会**跟着条目走、
 * 不跟着文件走** —— 用户把 PDF 移出资料库（或者项目文件里那些根本不在库里的 PDF）
 * 就丢了。存旁边没这个问题，也**不需要迁移**。
 *
 * ## 为什么写回用 pdf.js 的 `saveDocument()`
 *
 * 它自己就是 Firefox 那个 PDF 阅读器的批注实现，写出来的是**真批注**
 * （`/Subtype /Highlight` + `/Annots`）；而 `react-pdf-highlighter-plus` 的
 * `exportPdf()` 是把黄条**画进页面内容流**（`/Annots` 是空的）—— 在 Acrobat 的
 * 批注面板里看不到。用户要的是前者。而且 pdfjs-dist 已经装着，**零新依赖**。
 *
 * ⚠️ **坐标换算与批注组装不在这里** —— 在 `@contracts/pdfHighlight`。原因：渲染端
 * 也要用同一套（它不许 import 主进程），而"共享实现只有一份"是这个仓库的硬规矩。
 * 这里只管**盘上的事**（读文件、写文件）。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, linkSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PdfHighlight } from "@contracts/library";
import { validatePdfHighlight } from "@contracts/pdfHighlight";
import { fileContentVersion } from "@main/lib/fileVersion.js";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";
import { withOsFileLease } from "@main/lib/osFileLease.js";
import { readPdfFileBounded } from "./pdfRead.js";

/** 高亮索引文件的后缀。点开头 + 原文件名，排序时自然挨着。 */
const SIDECAR_SUFFIX = ".mcode-highlights.json";

export function highlightsPathFor(pdfPath: string): string {
  return join(dirname(pdfPath), `.${basename(pdfPath)}${SIDECAR_SUFFIX}`);
}

/**
 * **干净底稿**的路径 —— 第一次"烤进 PDF"之前，先把当时的 PDF 原样存一份在这儿。
 *
 * ## 为什么非有它不可
 *
 * 用户要的是"标注**烤进 PDF 文件**"。而烘烤是**画上去**（`exportPdf` 把黄条画进页面），
 * 不是 PDF 批注对象 —— **没法原地更新或擦掉**。
 *
 * 于是"改个颜色再烤一次"就会变成**烤两遍**（旧的黄条还在，新色叠上去）。撤销、删除
 * 标注同理 —— 烤进去的东西删不掉。
 *
 * 所以：**每次都从这份干净底稿重新烤**（底稿 + 全部标注 → 覆盖那个 PDF）。
 * 底稿只在第一次烘烤前存一次，之后不动。
 */
export function originalPathFor(pdfPath: string): string {
  return join(dirname(pdfPath), `.${basename(pdfPath)}.mcode-original.pdf`);
}

/** 有没有存过干净底稿。 */
export function hasOriginal(pdfPath: string): boolean {
  return existsSync(originalPathFor(pdfPath));
}

/**
 * 存一份干净底稿（**只在还没有的时候存**，绝不覆盖）。
 *
 * 覆盖的话，第二次烘烤就会把"已经烤过的"存成底稿 —— 从此底稿也带着旧标注，
 * 越烤越糊且再也回不去。
 */
export function ensureOriginal(pdfPath: string, bytes: Uint8Array): void {
  const target = originalPathFor(pdfPath);
  if (existsSync(target)) return;
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, bytes, { flag: "wx" });
    // Check-then-rename is not atomic: between existsSync and rename,
    // another process can create the pristine baseline. rename would then
    // overwrite that first owner's ONLY clean copy. A hard link is atomic
    // create-if-absent on the same volume and fails with EEXIST instead.
    try {
      linkSync(tmp, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  } finally {
    // No loser may leave a temporary baseline as if it were authoritative.
    try { rmSync(tmp, { force: true }); } catch { /* cleanup only */ }
  }
}

/** Full read result keeps corruption observable for UI and Agent callers.
 * No index file is legitimately empty; an existing corrupt one is NOT.
 * The legacy array API delegates here, so parsing rules have one owner. */
export interface PdfHighlightsReadResult {
  highlights: PdfHighlight[];
  error?: string;
  omittedCount?: number;
}

export function readHighlightsDetailed(pdfPath: string): PdfHighlightsReadResult {
  const path = highlightsPathFor(pdfPath);
  if (!existsSync(path)) return { highlights: [] };

  // The index is another independent file beside the authorized PDF.
  // Its sibling name is not proof that its contents are authorized; reuse
  // the existing bounded FD read with single-link/inode checks.
  const bytes = readPdfFileBounded(path, { rejectHardlinks: true });
  if (!bytes.ok || !bytes.bytes) {
    return { highlights: [], error: `批注索引无法安全读取：${bytes.error ?? "磁盘读取失败"}；已保留原文件` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.bytes));
  } catch {
    return { highlights: [], error: "批注索引 JSON 损坏或编码无效，已保留原文件，请备份后修复" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { highlights: [], error: "批注索引结构无效，已保留原文件" };
  }
  const record = parsed as { version?: unknown; highlights?: unknown };
  if ((record.version !== undefined && record.version !== 1) || !Array.isArray(record.highlights)) {
    return { highlights: [], error: "批注索引版本或列表格式无效，已保留原文件" };
  }

  const highlights: PdfHighlight[] = [];
  let omittedCount = 0;
  for (const row of record.highlights) {
    try {
      if (validatePdfHighlight(row as PdfHighlight) === null) {
        highlights.push(row as PdfHighlight);
        continue;
      }
    } catch {
      // A malformed JSON object must not crash the whole read pipeline.
    }
    omittedCount++;
  }
  return omittedCount ? { highlights, omittedCount } : { highlights };
}

/** Legacy callers keep the same filtered array, backed by the single
 * parser above. Use readHighlightsDetailed at user/Agent IPC boundaries to
 * disclose unreadable archives and skipped invalid entries. */
export function readHighlights(pdfPath: string): PdfHighlight[] {
  return readHighlightsDetailed(pdfPath).highlights;
}

/**
 * 全量覆盖写索引文件。原子替换（临时文件 + rename）—— 中途崩了原文件一个字节不动。
 * 旧索引若读不出/含坏记录，先留一份不覆盖的备份，避免下一次保存抹掉可恢复内容。
 */
export function writeHighlights(pdfPath: string, highlights: PdfHighlight[]): void {
  // The IPC schema accepts unknown[] for compatibility. Validate *before*
  // touching the filesystem: a partial/bad batch must not claim success
  // only for the reader to hide some of those records on the next open.
  for (const [index, highlight] of highlights.entries()) {
    let invalid: string | null;
    try {
      invalid = validatePdfHighlight(highlight);
    } catch {
      invalid = "结构无效";
    }
    if (invalid !== null) {
      throw new Error(`批注索引第 ${index + 1} 条无效：${invalid}；原文件未覆盖`);
    }
  }

  const target = highlightsPathFor(pdfPath);
  // Millisecond-only temp names collide across processes. Distinct writers
  // must never commandeer each other's in-flight JSON.
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    let targetExists = false;
    try {
      const previous = lstatSync(target);
      if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1) {
        // Never copy unrelated hardlink/symlink content into .corrupt-UUID
        // and never replace a path that is not our own plain index file.
        throw new Error("批注索引目标不是安全的独占普通文件，拒绝覆盖或备份");
      }
      targetExists = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (targetExists) {
      let valid = false;
      try {
        const old = JSON.parse(readFileSync(target, "utf8")) as
          | { version?: number; highlights?: PdfHighlight[] }
          | null;
        valid = old?.version === 1 && Array.isArray(old.highlights) &&
          old.highlights.every((h) => validatePdfHighlight(h) === null);
      } catch {
        // 读不到或 JSON 不完整也算坏；备份失败时直接报错，绝不先覆盖原件。
      }
      if (!valid) {
        copyFileSync(target, `${target}.corrupt-${randomUUID()}`, constants.COPYFILE_EXCL);
      }
    }
    writeFileSync(
      tmp,
      JSON.stringify({ version: 1, pdf: basename(pdfPath), highlights }, null, 2),
      { encoding: "utf8", flag: "wx" },
    );
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 尽力而为 */
    }
    throw err;
  }
}

/** Validate with the same upstream pdf.js parser that opens the document in
 * the desktop reader. Magic bytes alone accept even the five-byte "%PDF-"
 * string; an invalid result must never replace a user's original PDF.
 * Use a separate copy since pdf.js may transfer/detach the provided buffer.
 */
async function validateWrittenPdf(bytes: Uint8Array): Promise<void> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 32 ||
      bytes.byteLength > 200 * 1024 * 1024 ||
      !Buffer.from(bytes.subarray(0, 1024)).includes("%PDF-")) {
    throw new Error("PDF 写回结果无效或超过解析上限，已拒绝覆盖原文件");
  }
  // pdf.js deliberately repairs some truncated documents. A generated
  // saveDocument() result must not need that repair: reject missing EOF even
  // if its partial page tree happens to be salvageable.
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 2048))).toString("latin1");
  if (!/%%EOF[\x00\x09-\x0d\x20]*$/.test(tail)) {
    throw new Error("PDF 写回结果缺少完整的 EOF 结尾，已拒绝覆盖原文件");
  }

  let task: ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs")["getDocument"]> | undefined;
  let doc: { numPages: number; getPage(page: number): Promise<unknown>; destroy(): Promise<void> } | undefined;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    });
    doc = await task.promise;
    if (!Number.isSafeInteger(doc.numPages) || doc.numPages < 1) {
      throw new Error("PDF 没有可读取的页面");
    }
    await doc.getPage(1);
  } catch (err) {
    throw new Error(`PDF 写回结果无法被阅读器解析，已拒绝覆盖原文件：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (doc) {
      try { await doc.destroy(); } catch { /* cleanup only */ }
    } else if (task) {
      try { await task.destroy(); } catch { /* cleanup only */ }
    }
  }
}

/** 写回结果，给界面报"写了几条、跳过几条"。 */
export interface WriteBackResult {
  written: number;
  skipped: Array<{ id: string; reason: string }>;
  bytes?: number;
  /** PDF bytes committed, but sidecar index could not be written. Callers
   * must report partial success rather than falsely acknowledging both. */
  indexError?: string;
}

/**
 * 把高亮写回 PDF 文件本身。**原子替换**：先写同目录临时文件再 rename —— pdf.js
 * 是**整个文件重写**，中途崩了不能毁掉用户那篇论文。
 *
 * `save` 由调用方给（渲染端是 `pdfDoc.saveDocument()`），这样这个模块不必知道
 * pdf.js 的存在，无头测试也能塞一个假的进去。
 */
export async function writeBackToFile(
  pdfPath: string,
  highlights: PdfHighlight[],
  save: (usable: PdfHighlight[]) => Promise<Uint8Array>,
  expectedRevision?: string,
  persistSidecar = false,
): Promise<WriteBackResult> {
  const skipped: Array<{ id: string; reason: string }> = [];
  const usable: PdfHighlight[] = [];
  for (const h of highlights) {
    const bad = validatePdfHighlight(h);
    if (bad) skipped.push({ id: h?.id ?? "(无 id)", reason: bad });
    else usable.push(h);
  }

  // L2 Host integration: share ONE revision algorithm, ONE OS-level
  // per-path lease and ONE audited atomic replacement with the existing
  // document editor, file.writeFile and Agent document tools. This blocks
  // competing Mcode processes from both accepting the same stale version.
  return withOsFileLease(pdfPath, async (real) => {
    const before = await fileContentVersion(real);
    if (before === null) throw new Error("PDF 文件不在了，不能保存批注");
    if (expectedRevision !== undefined && before !== expectedRevision) {
      throw new Error("PDF 已被其他写入者改动（版本冲突），请重新打开后再保存；原文件已保留");
    }

    const out = await save(usable);
    // saveDocument() is untrusted; an accepted callback does not imply a PDF.
    await validateWrittenPdf(out);

    // External editors do not participate in Mcode's OS file lease. Recheck
    // the actual disk bytes after every async save/parse operation before
    // replacement; an updated file must be preserved and flagged as conflict.
    const latest = await fileContentVersion(real);
    if (latest !== before) {
      throw new Error("PDF 已被其他写入者改动（版本冲突），请重新打开后再保存；原文件已保留");
    }

    // The original backup belongs to the SAME durable save transaction.
    // The UI/Agent IPC must not create it independently before validation.
    // Verify the bytes we copy are exactly the revision being replaced.
    if (!hasOriginal(real)) {
      const originalBytes = readFileSync(real);
      const snapshotRevision = createHash("sha256").update(originalBytes).digest("hex");
      if (snapshotRevision !== before) {
        throw new Error("PDF 在准备原始备份时已发生版本冲突，拒绝覆盖");
      }
      ensureOriginal(real, originalBytes);
    }

    // UUID, exclusive wx, fsync, file-mode and hardlink checks live in the
    // shared Host primitive. Never revive a separate PDF-specific temp path.
    await atomicReplaceFile(real, out);
    // Keep the PDF+sidecar sequence inside the SAME Host OS lease, so a
    // second cooperating editor cannot commit a newer PDF in between our
    // PDF commit and this sidecar update. Two files are not one filesystem
    // transaction; if the index fails, report partial completion explicitly.
    let indexError: string | undefined;
    if (persistSidecar) {
      try {
        writeHighlights(real, usable);
      } catch (err) {
        indexError = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      written: usable.length,
      skipped,
      bytes: statSync(real).size,
      ...(indexError !== undefined ? { indexError } : {}),
    };
  });
}
