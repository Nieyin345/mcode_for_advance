/** Query the text-bearing parts of the unified library, never the entire
 * data root. Search hits are returned only for registered LibraryItem paths:
 * orphaned files, temp files, and arbitrary data-root contents cannot appear.
 *
 * Non-text binaries (PDF, Office, images) need their own conversion/indexer.
 * Only explicitly registered linked text FILES may be read: never traverse
 * the parent directory of an external reference.
 */
import { existsSync, lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, posix } from "node:path";
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
  // Colons are forbidden inside Windows filenames (alternate data streams).
  if (!normalized.startsWith(folder + "/") || normalized.includes("\0") || normalized.includes(":")) return null;
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
    const lines = await boundedTextLines(target);
    if (!lines) continue;
    let perFile = 0;
    for (const [i, line] of lines.entries()) {
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


/** Scan exactly the external text files referenced by linked records, not
 * directories containing them. The underlying selection was explicit, but
 * the search must still be bounded and avoid symlink indirection. */
async function searchLinkedLibraryTexts(
  items: readonly LibraryItem[],
  query: string,
  limit: number,
  collectionAllows: (itemId: string) => boolean,
  isCurrent: () => boolean,
): Promise<FullTextMatch[]> {
  const results: FullTextMatch[] = [];
  if (limit <= 0) return results;
  const visited = new Map<string, Array<{ lineNumber: number; lineText: string }>>();
  const needle = query.toLowerCase();
  const textExts: ReadonlySet<string> = new Set(LIBRARY_PLAIN_TEXT_EXTS);
  for (const item of items) {
    if (!isCurrent() || results.length >= limit) break;
    if (item.entryMode !== "linked" || !item.filePath || !collectionAllows(item.id)) continue;
    const target = item.filePath;
    if (!isAbsolute(target) || !textExts.has(extname(target).slice(1).toLowerCase())) continue;
    let hits = visited.get(target);
    if (!hits) {
      hits = [];
      const content = await boundedTextLines(target);
      if (!isCurrent()) return [];
      if (content) {
        for (const [index, line] of content.entries()) {
          if (!line.toLowerCase().includes(needle)) continue;
          hits.push({ lineNumber: index + 1, lineText: line });
          if (hits.length >= 5) break;
        }
      }
      visited.set(target, hits);
    }
    for (const hit of hits) {
      results.push({
        itemId: item.id, title: item.title,
        relativePath: "linked/" + item.id + "/" + basename(target),
        lineNumber: hit.lineNumber, lineText: hit.lineText,
      });
      if (results.length >= limit) break;
    }
  }
  return isCurrent() ? results : [];
}

/** Exact-file read used by both registered fallbacks and linked references.
 * A stale linked path, a directory or a symlink is not a licence to descend
 * into arbitrary subfolders. */
async function boundedTextLines(target: string): Promise<string[] | null> {
  let buffer: Buffer;
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FALLBACK_MAX_BYTES) return null;
    buffer = await readFile(target);
    if (buffer.length > FALLBACK_MAX_BYTES) return null;
  } catch { return null; }
  const isUtf16le = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  if (!isUtf16le && buffer.includes(0)) return null;
  try {
    const content = new TextDecoder(isUtf16le ? "utf-16le" : "utf-8", { fatal: true })
      .decode(isUtf16le ? buffer.subarray(2) : buffer);
    return content.split(/\r?\n/);
  } catch { return null; }
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
  if (!query || limit <= 0) return out;
  for (const { folder, extensions } of roots) {
    if (!isCurrent() || out.length >= limit) return out;
    const dir = join(root, folder);
    if (!existsSync(dir)) continue;
    // Explicitly enumerate ONLY registered paths before invoking rg: orphan
    // matches cannot consume rg's global cap and hide legitimate results.
    // Keep command lines bounded on Windows, which has a short argv limit.
    const eligibleOwners = new Map<string, LibraryItem[]>();
    for (const [rel, records] of owners) {
      if (!safeLibraryTextPath(rel, folder, extensions)) continue;
      // Collection filtering MUST precede ripgrep: otherwise hits belonging
      // to other collections exhaust the per-query cap and hide valid ones.
      const allowed = records.filter((item) => collectionAllows(item.id));
      if (!allowed.length) continue;
      const target = join(root, rel);
      try {
        const stat = lstatSync(target);
        if (stat.isFile() && !stat.isSymbolicLink() && pathWithin(dir, target)) {
          eligibleOwners.set(rel, allowed);
        }
      } catch { /* Removed or inaccessible files are not searchable. */ }
    }
    const paths = [...eligibleOwners.keys()];
    for (let i = 0; i < paths.length && out.length < limit; i += 64) {
      if (!isCurrent()) return [];
      const batch = paths.slice(i, i + 64);
      const selected = new Map<string, LibraryItem[]>(batch.map((rel) => [rel, eligibleOwners.get(rel)!] as const));
      const scan = await rgGrep(dir, query, {
        caseSensitive: false, limit: limit - out.length, maxPerFile: 5,
        includeExts: [...extensions],
        files: batch.map((rel) => rel.slice(folder.length + 1)),
      }, []);
      if (!isCurrent()) return [];
      if (!scan) {
        const remaining = limit - out.length;
        out.push(...await scanRegisteredTextFallback(root, folder, selected, query, remaining, collectionAllows, isCurrent));
        if (!isCurrent()) return [];
        continue;
      }
      for (const match of scan.matches) {
        const rel = safeLibraryTextPath(folder + "/" + match.relativePath, folder, extensions);
        if (!rel) continue;
        for (const item of selected.get(rel) ?? []) {
          if (!collectionAllows(item.id)) continue;
          const key = item.id + "\0" + rel + "\0" + match.lineNumber;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            itemId: item.id, title: item.title, relativePath: rel,
            lineNumber: match.lineNumber, lineText: match.lineText,
          });
          if (out.length >= limit) return out;
        }
      }
    }
  }
  if (!isCurrent()) return [];
  // External linked references are explicitly selected by the user and
  // persisted as exact absolute file paths. Never grep their parent folder.
  out.push(...await searchLinkedLibraryTexts(items, query, limit - out.length, collectionAllows, isCurrent));
  return isCurrent() ? out : [];
}
