/** Query the text-bearing parts of the unified library, never the entire
 * data root. Search hits are returned only for registered LibraryItem paths:
 * orphaned files, temp files, and arbitrary data-root contents cannot appear.
 *
 * Non-text binaries (PDF, Office, images) need their own conversion/indexer.
 * A linked file outside the data root is intentionally not traversed here:
 * blindly grepping its parent would search unrelated user documents.
 */
import { existsSync, lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { pathWithin } from "@main/lib/realPathWithin.js";
import type { LibraryItem, FullTextMatch } from "@contracts/library";
import { rgGrep } from "@main/lib/rgSearch.js";

export const LIBRARY_PLAIN_TEXT_EXTS = [
  "md", "markdown", "mdown", "txt", "text", "csv", "tsv", "json", "jsonl",
  "yaml", "yml", "toml", "xml", "html", "htm", "css", "js", "jsx", "ts",
  "tsx", "py", "go", "rs", "java", "c", "h", "cpp", "hpp", "sh", "sql",
  "log", "ini", "conf",
] as const;
const roots = [
  { folder: "markdown", extensions: ["md"] },
  { folder: "notes", extensions: ["md"] },
  { folder: "files", extensions: [...LIBRARY_PLAIN_TEXT_EXTS] },
] as const;

function safeLibraryTextPath(value: string, folder: string, extensions: readonly string[]): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized.startsWith(folder + "/") || normalized.includes("\0")) return null;
  const rest = normalized.slice(folder.length + 1);
  if (!rest || rest.startsWith("/") || rest.split("/").some((part) => part === ".." || part === "." || part === "")) {
    return null;
  }
  const ext = posix.extname(rest).slice(1).toLowerCase();
  return extensions.includes(ext) ? normalized : null;
}

/** A single path can be referenced by more than one item (legacy records).
 * Keep all owners; never quietly lose a valid second record. */
export function libraryTextPathOwners(items: readonly LibraryItem[]): Map<string, LibraryItem[]> {
  const paths = new Map<string, LibraryItem[]>();
  const put = (raw: string | undefined, folder: string, exts: readonly string[], item: LibraryItem) => {
    if (!raw) return;
    const path = safeLibraryTextPath(raw, folder, exts);
    if (!path) return;
    const owners = paths.get(path) ?? [];
    if (!owners.some((owner) => owner.id === item.id)) owners.push(item);
    paths.set(path, owners);
  };
  for (const item of items) {
    put(item.mdPath, "markdown", ["md"], item);
    put(item.mdPath, "notes", ["md"], item);
    if (item.entryMode === "attached") put(item.filePath, "files", LIBRARY_PLAIN_TEXT_EXTS, item);
  }
  return paths;
}


/** Slow-path only: an unavailable rg must not make a healthy library look
 * empty. Restrict reads to recorded files under the current data root.
 * Linked external paths / symlinks, binary data, and files above 2 MiB are
 * deliberately excluded (no unbounded scanning on Electron's main process).
 * TextDecoder rejects invalid UTF-8, rather than misreporting binary bytes.
 */
const FALLBACK_MAX_BYTES = 2 * 1024 * 1024;

async function scanRegisteredTextFallback(
  root: string,
  folder: string,
  owners: ReadonlyMap<string, readonly LibraryItem[]>,
  query: string,
  limit: number,
  collectionAllows: (itemId: string) => boolean,
  isCurrent: () => boolean,
): Promise<FullTextMatch[]> {
  const out: FullTextMatch[] = [];
  const dir = join(root, folder);
  const needle = query.toLowerCase();
  const extList: readonly string[] = folder === "files" ? LIBRARY_PLAIN_TEXT_EXTS : ["md"];
  for (const [rel, items] of owners) {
    if (!isCurrent() || out.length >= limit) break;
    if (!safeLibraryTextPath(rel, folder, extList)) continue;
    const target = join(root, rel);
    // Physical containment prevents symlinks/junctions in the library tree
    // from turning an index hit into a read of an arbitrary user file.
    if (!pathWithin(dir, target)) continue;
    let buffer: Buffer;
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FALLBACK_MAX_BYTES) continue;
      buffer = await readFile(target);
      if (buffer.length > FALLBACK_MAX_BYTES) continue;
    } catch {
      continue; // File may have been moved since it was added to the library.
    }
    const isUtf16le = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
    // Decode only a real text stream. NUL without a UTF-16 BOM means binary.
    if (!isUtf16le && buffer.includes(0)) continue;
    let text: string;
    try {
      text = new TextDecoder(isUtf16le ? "utf-16le" : "utf-8", { fatal: true })
        .decode(isUtf16le ? buffer.subarray(2) : buffer);
    } catch {
      continue;
    }
    let perFile = 0;
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      if (!isCurrent() || out.length >= limit || perFile >= 5) break;
      if (!line.toLowerCase().includes(needle)) continue;
      perFile++;
      for (const item of items) {
        if (!collectionAllows(item.id)) continue;
        out.push({
          itemId: item.id,
          title: item.title,
          relativePath: rel,
          lineNumber: i + 1,
          lineText: line,
        });
        if (out.length >= limit) break;
      }
    }
  }
  return isCurrent() ? out : [];
}

/** Uses existing bounded rgGrep (fixed-string, max-size, timeout) and preserves
 * the IPC FullTextMatch shape. Capped globally after database-ownership check.
 * Other callers can pass a collection filter without changing search syntax.
 */
export async function searchRegisteredLibraryText(
  root: string,
  items: readonly LibraryItem[],
  query: string,
  limit: number,
  collectionAllows: (itemId: string) => boolean = () => true,
  isCurrent: () => boolean = () => true,
): Promise<FullTextMatch[]> {
  const owners = libraryTextPathOwners(items);
  const out: FullTextMatch[] = [];
  const seen = new Set<string>();
  if (!query || limit <= 0 || owners.size === 0) return out;
  for (const { folder, extensions } of roots) {
    if (!isCurrent() || out.length >= limit) return out;
    const dir = join(root, folder);
    if (!existsSync(dir)) continue;
    const scan = await rgGrep(dir, query, {
      caseSensitive: false, limit, maxPerFile: 5, includeExts: [...extensions],
    }, []);
    if (!isCurrent()) return [];
    if (!scan) {
      // ripgrep may be missing on a newly installed computer. Fall back to
      // exact registered files only, using a strict per-file byte limit and
      // the physical path guard instead of recursively reading a directory.
      const remaining = limit - out.length;
      out.push(...await scanRegisteredTextFallback(root, folder, owners, query, remaining, collectionAllows, isCurrent));
      if (!isCurrent()) return [];
      continue;
    }
    for (const match of scan.matches) {
      const rel = safeLibraryTextPath(folder + "/" + match.relativePath, folder, extensions);
      if (!rel) continue;
      for (const item of owners.get(rel) ?? []) {
        if (!collectionAllows(item.id)) continue;
        const key = item.id + "\0" + rel + "\0" + match.lineNumber;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          itemId: item.id,
          title: item.title,
          relativePath: rel,
          lineNumber: match.lineNumber,
          lineText: match.lineText,
        });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
