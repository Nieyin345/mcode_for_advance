/** Unified, persistent and nonblocking text index for PDF/Office library assets.
 *
 * Extraction is delegated to the EXISTING GenOffice native CLI adapter. It
 * runs in its own process (not Electron's renderer or synchronous JS loops).
 * Search queries read bounded, atomic JSON snapshots while a single-flight
 * queue refreshes stale/missing documents. A missing CLI or unsupported type
 * is observable as "unavailable", not an empty successful index.
 *
 * Existing LibraryRepo records are the sole discovery source. This module
 * neither creates database rows nor traverses folders to discover documents.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathWithin } from "@main/lib/realPathWithin.js";
import type { LibraryItem, FullTextMatch } from "@contracts/library";

export type IndexedKind = "pdf" | "docx" | "pptx" | "xlsx";
export interface IndexLocation {
  page?: number;
  slide?: number;
  sheet?: string;
  row?: number;
  block?: number;
}
export interface IndexSection { text: string; location: IndexLocation }
export interface IndexDocument {
  version: 1;
  id: string;
  source: string;
  size: number;
  mtimeMs: number;
  kind: IndexedKind;
  coverage: "complete" | "partial";
  sections: IndexSection[];
  indexedAt: number;
}
export interface IndexInput {
  item: LibraryItem;
  path: string;
  kind: IndexedKind;
}
export type IndexReader = (input: IndexInput) => Promise<{ sections: IndexSection[]; coverage: "complete" | "partial" }>;

const MAX_SECTIONS = 3000;
const MAX_CHARS = 256 * 1024;
const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;
const MAX_CONCURRENT = 1;
const MAX_QUEUED = 512;
const INDEX_FORMAT = 1;
const supported = new Set<IndexedKind>(["pdf", "docx", "pptx", "xlsx"]);
export function documentIndexKind(file: string): IndexedKind | null {
  const ext = extname(file).slice(1).toLowerCase();
  return supported.has(ext as IndexedKind) ? ext as IndexedKind : null;
}
export function flattenDocumentBlocks(
  blocks: readonly { type?: unknown; text?: unknown; index?: unknown }[],
  kind: IndexedKind,
  detail: unknown,
): { sections: IndexSection[]; coverage: "complete" | "partial" } {
  const sections: IndexSection[] = [];
  let budget = MAX_CHARS;
  // 覆盖判定必须来自**真实账目**，不是一个按格式写死的常量。
  // 从前这里是 `partial = kind === "xlsx"` —— 那是「旧读取器只读活动表」的
  // 代理指标：无论读到了几张表，xlsx 永远报 partial，于是「真的全读了」和
  // 「只读到一张」在输出上长得一模一样。现在读取器给出 `sheetLedger`，
  // 判据换成「账目说还有没读的表 / 被截断的表」。
  let partial = false;
  const meta = detail && typeof detail === "object" ? detail as Record<string, unknown> : {};
  if (meta.truncated === true) partial = true;
  const ledger = xlsxSheetLedgerOf(meta.sheetLedger);
  if (kind === "xlsx") {
    // 没有账目就不能声称完整：旧缓存快照/旧读取器产出的 detail 里没有
    // `sheetLedger`，那时我们**不知道**覆盖多少 —— 如实报 partial。
    if (ledger === null) partial = true;
    else if (ledger.unreadSheets.length > 0 || ledger.truncatedSheets.length > 0) partial = true;
  }
  const sheetByBlock = ledger === null ? null : xlsxSheetNamesByBlock(blocks, ledger);
  for (const block of blocks) {
    if (sections.length >= MAX_SECTIONS || budget <= 0) { partial = true; break; }
    if (typeof block.text !== "string" || !block.text.trim()) continue;
    let text = block.text;
    if (text.length > budget) { text = text.slice(0,budget); partial = true; }
    const n = typeof block.index === "number" ? block.index : sections.length;
    const location: IndexLocation = { block: n };
    const page = /^\[page\s+(\d+)\]/i.exec(text);
    const slide = /^\[slide\s+(\d+)\]/i.exec(text);
    if (kind === "pdf" && page) location.page = Number(page[1]);
    if (kind === "pptx" && slide) location.slide = Number(slide[1]);
    if (kind === "xlsx") {
      location.row = n + 1;
      // 表名优先取块自带的 `[sheet X]` 前缀（工作簿级读取给每行都盖上表名），
      // 退回旧信封的 `sheetDetail.sheet`（单表读取那一代的形状）。
      const fromBlock = sheetByBlock?.get(n);
      const legacy = (meta.sheetDetail as { sheet?: unknown } | undefined)?.sheet;
      const sheet = fromBlock ?? (typeof legacy === "string" ? legacy : undefined);
      if (typeof sheet === "string") location.sheet = sheet;
    }
    sections.push({ text, location });
    budget -= text.length;
  }
  return { sections, coverage: partial ? "partial" : "complete" };
}

/** 工作簿读取账目的**结构校验** —— 形状不对就当作"没有账目"，
 *  绝不用半截数据冒充覆盖事实。 */
function xlsxSheetLedgerOf(raw: unknown): {
  sheets: string[];
  readSheets: string[];
  unreadSheets: string[];
  truncatedSheets: string[];
} | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const strings = (input: unknown): string[] | null =>
    Array.isArray(input) && input.every((entry) => typeof entry === "string") ? input as string[] : null;
  const sheets = strings(value.sheets);
  const readSheets = strings(value.readSheets);
  const unreadSheets = strings(value.unreadSheets);
  const truncatedSheets = strings(value.truncatedSheets);
  if (sheets === null || readSheets === null || unreadSheets === null || truncatedSheets === null) return null;
  return { sheets, readSheets, unreadSheets, truncatedSheets };
}

/** 块 index → 表名。只认块文本开头的 `[sheet <name>] **，且该名字在账目里
 *  真的读过 —— 一个页面里碰巧写了 `[sheet foo]` 不会被当成表名归因。 */
function xlsxSheetNamesByBlock(
  blocks: readonly { text?: unknown; index?: unknown }[],
  ledger: { readSheets: string[] },
): Map<number, string> {
  const known = new Set(ledger.readSheets);
  const out = new Map<number, string>();
  blocks.forEach((block, position) => {
    if (typeof block.text !== "string") return;
    const match = /^\[sheet\s+([^\]]+)\]/i.exec(block.text);
    if (match === null) return;
    const name = match[1]!.trim();
    if (!known.has(name)) return;
    const index = typeof block.index === "number" ? block.index : position;
    out.set(index, name);
  });
  return out;
}

function cacheFile(root: string, id: string): string {
  return join(root, "search-index", createHash("sha256").update(id).digest("hex") + ".json");
}
function safeSnapshot(value: unknown, input: IndexInput, stat: { size: number; mtimeMs: number }): value is IndexDocument {
  if (!value || typeof value !== "object") return false;
  const x = value as Partial<IndexDocument>;
  return x.version === INDEX_FORMAT && x.id === input.item.id && x.source === input.path
    && x.size === stat.size && x.mtimeMs === stat.mtimeMs
    && x.kind === input.kind && Array.isArray(x.sections)
    && x.sections.length <= MAX_SECTIONS && (x.coverage === "partial" || x.coverage === "complete");
}
export class LibraryDocumentIndex {
  private queued = new Map<string, IndexInput>();
  private running = new Set<string>();
  private scheduled = false;
  private cache = new Map<string, IndexDocument>();
  private errors = new Map<string, string>();
  private failedAt = new Map<string, number>();
  constructor(private root: string, private reader: IndexReader) {}
  getStatus() { return { pending: this.queued.size + this.running.size, errors: this.errors.size }; }
  private async current(input: IndexInput): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const st = await fs.lstat(input.path);
      return st.isFile() && !st.isSymbolicLink() && st.size <= MAX_DOCUMENT_BYTES
        ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    } catch { return null; }
  }
  /** Lookup is purely async; never parses a binary document during a search. */
  async cached(input: IndexInput): Promise<IndexDocument | null> {
    const stat = await this.current(input);
    if (!stat) return null;
    const memory = this.cache.get(input.item.id);
    if (safeSnapshot(memory,input,stat)) return memory;
    this.cache.delete(input.item.id);
    try {
      const file=cacheFile(this.root,input.item.id);
      const st=await fs.lstat(file);
      if (!st.isFile() || st.isSymbolicLink() || !pathWithin(this.root,file)) return null;
      const raw = await fs.readFile(file,"utf8");
      if (raw.length > MAX_CHARS * 5) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!safeSnapshot(parsed,input,stat)) return null;
      this.cache.set(input.item.id,parsed);
      return parsed;
    } catch { return null; }
  }
  enqueue(input: IndexInput): boolean {
    const key = input.item.id;
    if (this.running.has(key) || this.queued.has(key)) return false;
    if (Date.now() - (this.failedAt.get(key) ?? 0) < 30_000) return false;
    if (this.queued.size >= MAX_QUEUED) return false;
    this.queued.set(key,input);
    this.kick();
    return true;
  }
  private kick() {
    if (this.scheduled) return;
    this.scheduled = true;
    // The queue starts after the request returns to the event loop.
    setImmediate(() => { this.scheduled = false; void this.drain(); });
  }
  private async drain(): Promise<void> {
    if (this.running.size >= MAX_CONCURRENT) return;
    const next = this.queued.entries().next().value as [string,IndexInput] | undefined;
    if (!next) return;
    const [key,input] = next;
    this.queued.delete(key);
    this.running.add(key);
    try { await this.refresh(input); }
    catch (err) {
      this.errors.set(key, err instanceof Error ? err.message : String(err));
      this.failedAt.set(key,Date.now());
    }
    finally { this.running.delete(key); if (this.queued.size) this.kick(); }
  }
  private async refresh(input: IndexInput): Promise<void> {
    if (await this.cached(input)) return;
    const before = await this.current(input);
    if (!before) {
      this.errors.set(input.item.id,"file missing, unsafe, or exceeds index limit");
      this.failedAt.set(input.item.id,Date.now()); return;
    }
    const extracted = await this.reader(input);
    const after = await this.current(input);
    if (!after || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      this.errors.set(input.item.id,"file changed during extraction");
      this.failedAt.set(input.item.id,Date.now()); return;
    }
    let remaining=MAX_CHARS;
    let clipped=false;
    const sections: IndexSection[]=[];
    for (const s of extracted.sections) {
      if (sections.length >= MAX_SECTIONS || remaining<=0) { clipped=true; break; }
      const text=s.text.slice(0,remaining);
      if (text.length !== s.text.length) clipped=true;
      if (text.trim()) sections.push({text,location:s.location});
      remaining-=text.length;
    }
    const output: IndexDocument = {
      version:1, id:input.item.id, source:input.path, size:after.size,
      mtimeMs:after.mtimeMs, kind:input.kind,
      coverage: extracted.coverage === "partial" || clipped ? "partial" : "complete",
      sections, indexedAt:Date.now(),
    };
    const dest=cacheFile(this.root,input.item.id);
    const cacheDir=join(this.root,"search-index");
    await fs.mkdir(cacheDir,{recursive:true});
    if (!pathWithin(this.root,cacheDir)) throw new Error("unsafe document index directory");
    const temp=dest+"."+process.pid+"."+createHash("sha256").update(String(Date.now())+input.item.id).digest("hex").slice(0,8)+".tmp";
    try { await fs.writeFile(temp,JSON.stringify(output),"utf8"); await fs.rename(temp,dest); }
    finally { await fs.rm(temp,{force:true}).catch(()=>undefined); }
    this.cache.set(input.item.id,output);
    this.errors.delete(input.item.id);
    this.failedAt.delete(input.item.id);
  }
  async search(
    inputs: readonly IndexInput[], query: string, limit: number,
    allowed: (itemId:string)=>boolean,
    isCurrent:()=>boolean,
  ): Promise<{ matches: FullTextMatch[]; pending: number; errors: number }> {
    const matches:FullTextMatch[]=[];
    if (!query.trim() || limit<=0) return {matches,...this.getStatus()};
    const needle=query.toLocaleLowerCase();
    for (const input of inputs) {
      if (!isCurrent()) return {matches:[],...this.getStatus()};
      if (!allowed(input.item.id)) continue;
      const cached=await this.cached(input);
      if (!cached) { this.enqueue(input); continue; }
      for (const section of cached.sections) {
        const lines=section.text.split(/\r?\n/);
        let count=0;
        for (const [n,line] of lines.entries()) {
          if (!line.toLocaleLowerCase().includes(needle)) continue;
          matches.push({
            itemId:input.item.id,title:input.item.title,
            relativePath:"indexed/" + input.item.id,
            lineNumber:n+1,lineText:line.slice(0,1200),
            location:{...section.location,line:n+1}, coverage:cached.coverage,
          });
          if (++count>=5 || matches.length>=limit) break;
        }
        if (matches.length>=limit) break;
      }
      if (matches.length>=limit) break;
    }
    return {matches:isCurrent()?matches:[],...this.getStatus()};
  }
}
