/**
 * 用 pdf.js 从 PDF 里取**文本**与**内嵌元数据**。
 *
 * 两个用途:
 *
 *   1. **元数据探针** —— 读 XMP/Info + 首页文本,找 DOI / arXiv 号。离线、不花
 *      MinerU 的额度,是分层采集的第一道。
 *   2. **Markdown 兜底** —— 没配 MinerU(或它失败)时,至少把正文抽出来写进
 *      `md_path`,让全文检索能用。
 *
 * ## 两个必须记住的坑
 *
 * **必须设 `cMapUrl`。** PDF 里 Identity-H 这类字体,内容流里存的是**字形索引**
 * 而不是字符;真正的 Unicode 映射在字体的 ToUnicode CMap 里。不设 `cMapUrl`,
 * 预定义的 CJK CMap 就取不到 —— 中文会**静默变成乱码**:不报错、不抛异常,只是
 * DOI 正则匹配不到、全文检索搜不出东西。中文文献是主力,这条不能省。
 *
 * **必须跑在主进程。** pdf.js 判断「是不是 Node」看的是 `process.type` —— 在主进程
 * 里是 `"browser"`,它当成 Node 走**假 worker**(同线程执行);在渲染进程里会被判成
 * 浏览器,转而要求一个真 worker。所以这个模块只该从 main 引。
 *
 * ## 失败一律分类返回,不抛
 *
 * 加密、扫描件(没有文本层)、超大小、字节不是 PDF —— 都要让调用方能够
 * 「转换失败但 PDF 照样入库」,而不是把整个导入流程打断。
 *
 * ## 代价
 *
 * 假 worker 意味着解析是**同线程 CPU 密集**的。所以这里一律限制页数(默认首页、
 * 探针只读 3 页),让常见情况在一秒内结束。真要整篇转 300 页,那应该挪到
 * utilityProcess —— 目前不做,先靠页数上限兜住。
 */
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** 超过这个大小直接拒 —— MinerU 的 200MB 上限之外,本地解析也不该吃这么多内存。 */
const MAX_BYTES = 200 * 1024 * 1024;
/** 首页文本少于这个字数就认为「没有文本层」(扫描件)。 */
const TEXT_LAYER_MIN_CHARS = 80;

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * 懒加载 pdf.js。放成动态 import 而不是顶层 import:它连同 worker 有好几 MB,
 * 而绝大多数启动根本用不到 —— 不该让每次开应用都付这个代价。
 */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
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
  /** 首页有足够的字符 = 有文本层。扫描件是 false。 */
  hasTextLayer: boolean;
  /** 需要密码且空密码打不开。 */
  encrypted?: boolean;
  error?: string;
}

/** 读出字节。非 PDF 魔数直接拒 —— 比 pdf.js 抛 InvalidPDFException 好定位得多。 */
function readPdfBytes(absPath: string): { ok: true; data: Uint8Array } | { ok: false; error: string } {
  try {
    const st = statSync(absPath);
    if (st.size > MAX_BYTES) {
      return { ok: false, error: `文件 ${(st.size / 1024 / 1024).toFixed(0)}MB 超过 200MB 上限` };
    }
    const buf = readFileSync(absPath);
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
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
  const pdfjs = await loadPdfjs();
  const base = {
    data: bytes.data,
    // Node 里没有真 worker;这几项关掉它去 fetch 字体/执行 eval 的尝试
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    // CJK 能不能认对全靠它 —— 见文件头
    cMapUrl: cMapUrl(),
    cMapPacked: true,
    // 少往 stderr 喷 pdf.js 的告警(缺 canvas 之类),那些对本用途无意义
    verbosity: 0,
  };
  try {
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

/** 抽前 N 页的纯文本。 */
async function textOfPages(doc: MinimalDoc, maxPages: number): Promise<string> {
  const out: string[] = [];
  const last = Math.min(doc.numPages, maxPages);
  for (let n = 1; n <= last; n += 1) {
    try {
      const page = (await doc.getPage(n)) as {
        getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
      };
      const content = await page.getTextContent();
      out.push(content.items.map((i) => i.str ?? "").join(" "));
    } catch {
      // 单页坏掉不该让整篇失败 —— 跳过它,其余照抽
    }
  }
  return out.join("\n\n").replace(/[ \t]+/g, " ").trim();
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

    const text = await textOfPages(doc, maxPages);
    const hasTextLayer = text.length >= TEXT_LAYER_MIN_CHARS;
    return { ok: true, meta, text, pageCount: doc.numPages, hasTextLayer };
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

/** 抽正文(兜底 Markdown)。`maxPages` 默认不限,但调用方应当给个上限。 */
export async function extractPdfText(
  absPath: string,
  maxPages = 500,
): Promise<{ ok: true; text: string; pageCount: number } | { ok: false; error: string; encrypted?: boolean }> {
  const opened = await openDocument(absPath);
  if (!opened.ok) return opened;
  try {
    const text = await textOfPages(opened.doc, maxPages);
    return { ok: true, text, pageCount: opened.doc.numPages };
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
