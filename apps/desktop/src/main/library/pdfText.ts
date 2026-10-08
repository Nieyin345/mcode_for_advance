/**
 * Low-level PDF text / embedded-metadata reading. This is NOT an automatic
 * library transcription or OCR fallback: no Markdown is written or adopted here.
 * Text extraction can be partial; callers must surface failed pages and limits.
 * Loading, resource and parsing errors return classified results.
 */
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { hasPdfMagic } from "@main/library/pdfFile.js";

/** 超过这个大小直接拒 —— 本地解析不该为一份超大 PDF 吃掉这么多内存。 */
const MAX_BYTES = 200 * 1024 * 1024;
/** A heuristic for useful extracted text, not proof that a document is scanned. */
const TEXT_LAYER_MIN_CHARS = 80;

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * 懒加载 pdf.js。放成动态 import 而不是顶层 import:它连同 worker 有好几 MB,
 * 而绝大多数启动根本用不到 —— 不该让每次开应用都付这个代价。
 */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((error: unknown) => { pdfjsPromise = null; throw error; });
  return pdfjsPromise;
}

/** `pdfjs-dist/cmaps/` 的绝对路径。打包后它在 asar 里,pdf.js 自己用 fs 读
 *  (Electron 对 asar 的 fs 做了透明处理),所以这里给真实路径即可。 */
function cMapUrl(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("pdfjs-dist/package.json");
  return join(dirname(pkgJson), "cmaps") + "/";
}

export interface PdfProbe {
  ok: boolean;
  /** 内嵌元数据(XMP / Info)里捞到的字段。 */
  meta: {
    title?: string;
    author?: string;
    subject?: string;
    doi?: string;
    /** 原始 id 串,便于诊断为什么没认出来。 */
    rawIdentifier?: string;
  };
  /** 前几页拼起来的纯文本 —— 给标识符正则和标题猜测用。 */
  text: string;
  pageCount?: number;
  /** True when sampled text is sufficient; false can also mean sparse text or page errors. */
  hasTextLayer: boolean;
  /** 需要密码且空密码打不开。 */
  encrypted?: boolean;
  error?: string;
  pagesRead?: number;
  failedPages?: number[];
  truncated?: boolean;
}

/** 读出字节。非 PDF 魔数直接拒 —— 比 pdf.js 抛 InvalidPDFException 好定位得多。 */
function readPdfBytes(absPath: string): { ok: true; data: Uint8Array } | { ok: false; error: string } {
  try {
    const st = statSync(absPath);
    if (st.size > MAX_BYTES) {
      return { ok: false, error: `文件 ${(st.size / 1024 / 1024).toFixed(0)}MB 超过 200MB 上限` };
    }
    const buf = readFileSync(absPath);
    // ⚠️ 用 `hasPdfMagic`(与导入关卡 `pdfFile.verifyPdf` **同一份**判据),不是"第 0 字节
    // 等于 `%PDF-`"。导入那边允许正文前带 BOM / 空白,这里若要求偏移 0 处严格相等,
    // 就会出现"关卡放行的文件,读取时被自己判成不是 PDF"的漂移 —— 一份带 BOM 的论文导入
    // 成功、点开却报"缺少 %PDF- 魔数"。pdf.js 实际能解开这种(实测),所以放宽的是这一侧。
    if (!hasPdfMagic(buf.subarray(0, 1024).toString("latin1"))) {
      return { ok: false, error: "不是 PDF(缺少 %PDF- 魔数)" };
    }
    return { ok: true, data: new Uint8Array(buf) };
  } catch (err) {
    return { ok: false, error: `读文件失败:${(err as Error).message}` };
  }
}

/**
 * 我们实际用到的那几个成员。**不引 pdf.js 的内部类型** —— 它那几个 d.ts 的
 * 导出路径在各版本间会变,而我们只用这三种能力,结构类型更稳也更易读。
 */
interface MinimalDoc {
  numPages: number;
  getPage: (n: number) => Promise<unknown>;
  getMetadata: () => Promise<unknown>;
  destroy: () => Promise<void>;
}

/**
 * 打开一个 PDF 文档。加密的先试空密码 —— 很多出版商 PDF 只有属主密码
 * (限制编辑/复制),用户密码是空的,空密码就能解开,抽文本完全够用。
 */
async function openDocument(
  absPath: string,
): Promise<{ ok: true; doc: MinimalDoc } | { ok: false; error: string; encrypted?: boolean }> {
  const bytes = readPdfBytes(absPath);
  if (!bytes.ok) return bytes;
  try {
    const pdfjs = await loadPdfjs();
    const base = {
      data: bytes.data,
      // Node 里没有真 worker;这几项关掉它去 fetch 字体/执行 eval 的尝试
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      // CJK text extraction requires the packaged character maps
      cMapUrl: cMapUrl(),
      cMapPacked: true,
      // 少往 stderr 喷 pdf.js 的告警(缺 canvas 之类),那些对本用途无意义
      verbosity: 0,
    };
    const doc = (await pdfjs.getDocument({ ...base, password: "" }).promise) as unknown as MinimalDoc;
    return { ok: true, doc };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "PasswordException") {
      return { ok: false, encrypted: true, error: "PDF 有密码保护,打不开" };
    }
    return { ok: false, error: `解析 PDF 失败:${(err as Error).message}` };
  }
}

/** Failed pages are distinct from successfully parsed pages with no text. */
interface PageText {
  text: string;
  pagesAttempted: number;
  pagesRead: number;
  failedPages: number[];
  truncated: boolean;
}
function pageLimitError(maxPages: number): string | null {
  return Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= 500
    ? null : "maxPages 必须是 1 到 500 的整数";
}
async function textOfPages(doc: MinimalDoc, maxPages: number): Promise<PageText> {
  const out: string[] = [];
  const failedPages: number[] = [];
  const last = Math.min(doc.numPages, maxPages);
  let pagesRead = 0;
  for (let n = 1; n <= last; n += 1) {
    try {
      const page = (await doc.getPage(n)) as { getTextContent: () => Promise<{ items: Array<{ str?: string }> }> };
      const content = await page.getTextContent();
      out.push(content.items.map((i) => i.str ?? "").join(" "));
      pagesRead++;
    } catch {
      failedPages.push(n);
    }
  }
  return { text: out.join("\n\n").replace(/[ \t]+/g, " ").trim(), pagesAttempted: last, pagesRead, failedPages, truncated: last < doc.numPages };
}

/** XMP 里挑出来的字段。`rawIdentifier` 保留原始串,便于诊断「为什么没认出 DOI」。 */
interface XmpPicked {
  title?: string;
  author?: string;
  subject?: string;
  doi?: string;
  rawIdentifier?: string;
}

/** 从 XMP 词典里挑出我们要的字段。键名大小写与命名空间在各家 PDF 里不一致,
 *  所以用模式匹配而不是精确查找。 */
function pickFromXmp(all: Record<string, unknown>): XmpPicked {
  const out: XmpPicked = {};
  const str = (v: unknown): string | undefined => {
    if (typeof v === "string") return v.trim() || undefined;
    if (Array.isArray(v) && typeof v[0] === "string") return v.join("; ");
    return undefined;
  };
  for (const [k, v] of Object.entries(all)) {
    const key = k.toLowerCase();
    if (!out.doi && (key.includes("doi") || key.includes("identifier"))) {
      const s = str(v);
      if (s) {
        // `doi:10.xxxx/yyy` 与裸 DOI 都要认
        const m = s.match(/10\.\d{4,9}\/[^\s,;]+/);
        if (m) out.doi = m[0].replace(/[.,;]+$/, "");
        else out.rawIdentifier = out.rawIdentifier ?? s;
      }
    }
    if (!out.title && key.includes("title")) out.title = str(v);
    if (!out.author && (key.includes("creator") || key.includes("author"))) out.author = str(v);
    if (!out.subject && key.includes("description")) out.subject = str(v);
  }
  return out;
}

/** 探针:元数据 + 前几页文本。给分层采集用。 */
export async function probePdf(absPath: string, maxPages = 3): Promise<PdfProbe> {
  const invalid = pageLimitError(maxPages);
  if (invalid) return { ok: false, meta: {}, text: "", hasTextLayer: false, error: invalid };
  const opened = await openDocument(absPath);
  if (!opened.ok) {
    return { ok: false, meta: {}, text: "", hasTextLayer: false, encrypted: opened.encrypted, error: opened.error };
  }
  const doc = opened.doc;
  try {
    const meta: PdfProbe["meta"] = {};
    try {
      const md = (await doc.getMetadata()) as {
        info?: Record<string, unknown>;
        metadata?: { getAll?: () => Record<string, unknown> } | null;
      };
      const info = md.info ?? {};
      // XMP 先行(它有 prism:doi / dc:identifier,信息量比 Info 大),Info 补空
      const fromXmp = md.metadata?.getAll ? pickFromXmp(md.metadata.getAll()) : {};
      meta.doi = fromXmp.doi;
      meta.rawIdentifier = fromXmp.rawIdentifier;
      const title = fromXmp.title ?? (typeof info.Title === "string" ? info.Title.trim() : undefined);
      const author = fromXmp.author ?? (typeof info.Author === "string" ? info.Author.trim() : undefined);
      const subject = fromXmp.subject ?? (typeof info.Subject === "string" ? info.Subject.trim() : undefined);
      if (title) meta.title = title;
      if (author) meta.author = author;
      if (subject) meta.subject = subject;
    } catch {
      // 元数据读不到不算失败 —— 正文还能拿来猜
    }

    const pages = await textOfPages(doc, maxPages);
    const hasTextLayer = pages.text.length >= TEXT_LAYER_MIN_CHARS;
    // Embedded metadata can remain useful even if some/all page content fails.
    return { ok: true, meta, text: pages.text, pageCount: doc.numPages, hasTextLayer,
      pagesRead: pages.pagesRead, failedPages: pages.failedPages, truncated: pages.truncated,
      ...(pages.failedPages.length ? { error: `页面解析失败: ${pages.failedPages.join(", ")}; 不应据此认定为扫描件` } : {}) };

  } catch (err) {
    return { ok: false, meta: {}, text: "", hasTextLayer: false, error: (err as Error).message };
  } finally {
    try {
      await doc.destroy();
    } catch {
      /* 关不掉不影响结果 */
    }
  }
}

/** Bounded text reading only (1–500 pages), not OCR or Markdown transcription. */
export async function extractPdfText(
  absPath: string,
  maxPages = 500,
): Promise<({ ok: true; pageCount: number } & PageText) | { ok: false; error: string; encrypted?: boolean }> {
  const invalid = pageLimitError(maxPages);
  if (invalid) return { ok: false, error: invalid };
  const opened = await openDocument(absPath);
  if (!opened.ok) return opened;
  try {
    const pages = await textOfPages(opened.doc, maxPages);
    if (pages.pagesAttempted > 0 && pages.pagesRead === 0) {
      return { ok: false, error: `尝试读取的 ${pages.pagesAttempted} 页全部解析失败; 不能当作没有文本层或已完成 OCR` };
    }
    return { ok: true, ...pages, pageCount: opened.doc.numPages };
  } catch (err) {
    return { ok: false, error: `抽取文本失败:${(err as Error).message}` };
  } finally {
    try {
      await opened.doc.destroy();
    } catch {
      /* 同上 */
    }
  }
}
