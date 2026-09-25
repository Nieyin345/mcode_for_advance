/**
 * 通用导入分派 —— 按扩展名把一批路径送进对应的管线（kind 退役后的入口）。
 *
 * 三条管线，判据是**文件是什么**而不是"它属于哪个库"：
 *   - `.pdf`                    → 文献管线（校验 + 元数据 + 可选转录）
 *   - `.md` / `.markdown` / `.txt` → 笔记管线（入库即完成）
 *   - 其余                       → 通用文件管线（attached 收库）
 *
 * 两种目录模式（schema 的 `mode`）：
 *   - `"folder"`  目录作为**一个** linked 条目收进（不拆开，可展开浏览）
 *   - `"explode"` 目录里的文件拆开，逐个走上面的分派（批量导入）
 *   - 路径本身是文件时两种模式都当 `"files"` 处理。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { importPdfFiles } from "./pdfImport.js";
import { importNoteFiles } from "./notesImport.js";
import { importGenericFiles } from "./fileImport.js";

const NOTE_EXTS = new Set([".md", ".markdown", ".mdown", ".txt"]);

export interface ImportMode {
  mode?: "files" | "folder" | "explode";
  collectionIds?: string[];
  convert?: boolean;
}

export interface AnyImportResult {
  items: import("@contracts/library").LibraryItem[];
  added: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
  converted: { ok: number; failed: number };
}

/** 列出目录第一层的**文件**（子目录递归收进爆炸/条目本身由调用方决定）。 */
function listFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .map((n) => `${dir.replace(/[\\/]+$/, "")}/${n}`)
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

export async function importAnyFiles(paths: string[], opts: ImportMode = {}): Promise<AnyImportResult> {
  const out: AnyImportResult = { items: [], added: 0, skipped: 0, errors: [], converted: { ok: 0, failed: 0 } };

  const expand = (p: string): { path: string; isDir: boolean }[] => {
    if (!existsSync(p)) return [{ path: p, isDir: false }];
    const isDir = statSync(p).isDirectory();
    if (!isDir) return [{ path: p, isDir: false }];
    if (opts.mode === "folder") return [{ path: p, isDir: true }];
    if (opts.mode === "explode") {
      // 批量：第一层文件逐个导；子目录整体作为 linked 条目收进（不递归爆开）
      const entries = readdirSync(p)
        .map((n) => `${p.replace(/[\\/]+$/, "")}/${n}`)
        .filter((e) => {
          try {
            return statSync(e).isFile();
          } catch {
            return false;
          }
        });
      return entries.map((e) => ({ path: e, isDir: false }));
    }
    // files 模式下给目录？整体作为 linked 条目（与 folder 同义）
    return [{ path: p, isDir: true }];
  };

  const pdfs: string[] = [];
  const notes: string[] = [];
  const generic: { path: string; isDir: boolean }[] = [];

  for (const raw of paths) {
    for (const { path: p, isDir } of expand(raw)) {
      if (isDir) {
        generic.push({ path: p, isDir: true });
        continue;
      }
      const dot = p.lastIndexOf(".");
      const ext = dot >= 0 ? p.slice(dot).toLowerCase() : "";
      if (ext === ".pdf") pdfs.push(p);
      else if (NOTE_EXTS.has(ext)) notes.push(p);
      else generic.push({ path: p, isDir: false });
    }
  }

  // 文献管线（PDF）
  if (pdfs.length > 0) {
    const res = await importPdfFiles({ paths: pdfs, collectionIds: opts.collectionIds });
    for (const r of res) {
      if (r.error) out.errors.push({ path: r.path, error: r.error });
      else if (r.alreadyPresent) out.skipped += 1;
      else if (r.item) {
        out.items.push(r.item);
        out.added += 1;
        if (opts.convert !== false) {
          const { convertItemToMarkdown } = await import("./convert.js");
          const c = await convertItemToMarkdown(r.item);
          if (c.ok) out.converted.ok += 1;
          else out.converted.failed += 1;
        }
      }
    }
  }

  // 笔记管线（md/txt）
  if (notes.length > 0) {
    const res = importNoteFiles(notes, opts.collectionIds);
    out.items.push(...res.items);
    out.added += res.added;
    out.skipped += res.skipped;
    out.errors.push(...res.errors);
  }

  // 通用管线（其余文件 + 目录条目）
  if (generic.length > 0) {
    const dirs = generic.filter((g) => g.isDir).map((g) => g.path);
    const files = generic.filter((g) => !g.isDir).map((g) => g.path);
    if (dirs.length > 0) {
      const res = importGenericFiles({ paths: dirs, mode: "linked", collectionIds: opts.collectionIds });
      out.items.push(...res.items);
      out.added += res.added;
      out.skipped += res.skipped;
      out.errors.push(...res.errors);
    }
    if (files.length > 0) {
      const res = importGenericFiles({ paths: files, mode: "attached", collectionIds: opts.collectionIds });
      out.items.push(...res.items);
      out.added += res.added;
      out.skipped += res.skipped;
      out.errors.push(...res.errors);
    }
  }

  return out;
}

/** 给 handler 的防未用警告（listFiles 目前只服务 explode 的第一层展开）。 */
void listFiles;
