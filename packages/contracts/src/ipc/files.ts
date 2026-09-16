/**
 * 文件读写 / 目录列表 / 剪贴板 / ripgrep 可用性与安装。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。一切按项目根约束的路径校验 schema 都在这里。
 */

import { z } from "zod";
import type { SendTurnImage } from "./session.js";

/* ── File operations (read / list dir / write) ── */

/** Read a single file's current content as utf-8 text. The main handler
 *  resolves the path against the session's project cwd and refuses anything
 *  that escapes it (path-traversal guard) — the renderer (contextIsolation)
 *  has no filesystem access of its own. Used by the turn-files diff card to
 *  fetch the post-turn content to diff against the snapshotted `before`. */
export const FileReadSchema = z.object({
  /** Absolute or cwd-relative path. Must resolve inside a known project root. */
  filePath: z.string(),
});
export type FileReadInput = z.infer<typeof FileReadSchema>;

/** Read a file as base64-encoded binary, returned as a `data:` URL ready for an
 *  `<img src=...>`. Used by the editor's image preview pane. Same
 *  project-root path-traversal guard as `file:readFile`. The `mimeType` is
 *  derived from the extension on the main side so the renderer doesn't have to.
 *  On refusal / failure returns `{ dataUrl: "" }` so the renderer can show a
 *  friendly error instead of throwing. */
export const FileReadBinarySchema = z.object({
  /** Absolute path. Must resolve inside a known project root. */
  filePath: z.string(),
});
export type FileReadBinaryInput = z.infer<typeof FileReadBinarySchema>;

/** Open the OS file dialog for image selection and return the files as base64.
 *  Main reads the files itself (the renderer can't read arbitrary paths under
 *  contextIsolation). A user-driven dialog is explicit consent, so no
 *  project-root guard applies — same trust level as `clipboard.saveFile`.
 *  Individual files above PICK_IMAGE_MAX_BYTES (main-side) are skipped; the
 *  renderer additionally downsizes before sending (see imageResize.ts). */
export const PickImagesSchema = z.object({});
export type PickImagesInput = z.infer<typeof PickImagesSchema>;

/** One image read from the user's file dialog. `data` is base64 without the
 *  `data:` prefix; `mimeType` is the SendTurn allowlist (jpeg/png/gif/webp). */
export interface PickedImage {
  /** Original file name (display only). */
  name: string;
  data: string;
  mimeType: SendTurnImage["mimeType"];
}

/** Save a file pasted from the OS clipboard (external image/file — copied in
 *  Finder, a browser, or a screenshot) to a temp path the agent can read.
 *  Bytes travel as base64 (matches the existing binary patterns); main
 *  preserves the original extension so the agent's Read tool can sniff image
 *  types, and returns the absolute temp path. The renderer then attaches it
 *  exactly like an internally dragged file (a `@path` file tag). */
export const ClipboardSaveFileSchema = z.object({
  /** Original file name (display + extension preservation). */
  name: z.string().min(1).max(255),
  /** base64-encoded file bytes (~52MB file ceiling). */
  bytes: z.string().min(1).max(70_000_000),
});
export type ClipboardSaveFileInput = z.infer<typeof ClipboardSaveFileSchema>;

export const ClipboardSaveFileResultSchema = z.object({
  ok: z.boolean(),
  /** Absolute temp path (set when ok). */
  path: z.string().optional(),
  error: z.string().optional(),
});
export type ClipboardSaveFileResult = z.infer<typeof ClipboardSaveFileResultSchema>;

/** Copy an image (a `data:image/...` URL, e.g. from an agent screenshot) onto
 *  the OS clipboard. The renderer's `navigator.clipboard` can't reliably write
 *  images, so main decodes the data URL into a nativeImage and calls
 *  `clipboard.writeImage`. The data URL scheme is validated here — main only
 *  trusts `data:image/` payloads, never remote URLs. */
export const ClipboardWriteImageSchema = z.object({
  /** Full `data:image/<mime>;base64,...` URL of the image to copy. */
  dataUrl: z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,/i).max(80_000_000),
});
export type ClipboardWriteImageInput = z.infer<typeof ClipboardWriteImageSchema>;

export const ClipboardWriteImageResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type ClipboardWriteImageResult = z.infer<typeof ClipboardWriteImageResultSchema>;

/** One entry returned by `file.listDir`. `path` is the absolute filesystem
 *  path (already validated to sit inside a project root); `name` is the base
 *  name for display. `size` is only populated for files (bytes). */
export interface FileTreeEntry {
  name: string;
  /** Absolute path (cwd-resolved + validated by main). */
  path: string;
  isDir: boolean;
  /** File size in bytes (omitted for directories). */
  size?: number;
}

/** List a single level of a directory (non-recursive). `dirPath` is relative
 *  to `projectPath` (empty string = the project root itself). Main resolves
 *  it, refuses escapes, filters out ignored entries (node_modules, .git, …),
 *  and returns entries sorted directories-first then alphabetical. On any
 *  read failure the handler returns `{ entries: [] }` so the tree degrades
 *  gracefully rather than throwing into the renderer. */
export const FileListDirSchema = z.object({
  /** Absolute path of the project root the listing is scoped to. Must match a
   *  persisted Project.path — main cross-checks this against ProjectRepo. */
  projectPath: z.string(),
  /** Directory to list, relative to projectPath. "" or "." = root. */
  dirPath: z.string(),
});
export type FileListDirInput = z.infer<typeof FileListDirSchema>;

/**
 * One file hit from `file.search`. Paths are absolute and already validated
 * to sit inside the project root. `relativePath` uses forward slashes for
 * stable display across platforms.
 */
export interface FileSearchEntry {
  name: string;
  /** Absolute filesystem path. */
  path: string;
  /** Path relative to the project root (forward-slash separated). */
  relativePath: string;
}

/**
 * Recursive file search under a project root for composer @-mention and
 * "add context" pickers. Main walks the tree (skipping the same ignored
 * dirs as listDir), optionally filters by case-insensitive substring on
 * name/relativePath, and returns at most `limit` files. Directories are
 * never returned — only files. Empty query returns a truncated breadth-
 * first sample so the picker has something to show immediately.
 */
export const FileSearchSchema = z.object({
  /** Absolute path of the project root. Must match a persisted Project.path. */
  projectPath: z.string(),
  /** Optional case-insensitive filter over file name / relative path. */
  query: z.string().optional(),
  /** Optional file-extension allow-list (no dots, lowercased). Empty or
   *  absent means no filter; name search drops files outside the list. */
  includeExts: z.array(z.string().min(1).max(32)).max(50).optional(),
  /** Max files to return. Defaults to 80 on the main side. */
  limit: z.number().int().positive().max(2000).optional(),
});
export type FileSearchInput = z.infer<typeof FileSearchSchema>;

/**
 * Result of a `file.search` call. `files` are already ranked and sliced to
 * `limit`. `truncated` is true when more matches existed than the requested
 * `limit` (the caller showed a slice, not the full set). `incompleteScan` is
 * true when the walk itself was cut short by the traversal budget (visit /
 * depth caps) — some subtrees were never visited, so results may miss
 * matches regardless of ranking.
 */
export interface FileSearchResult {
  files: FileSearchEntry[];
  /** More matches existed than the returned slice. */
  truncated: boolean;
  /** The tree walk hit its visit/depth budget before finishing. */
  incompleteScan: boolean;
}

/** Write utf-8 content to a file, creating it (and parent dirs) if absent.
 *  Path must resolve inside a known project root (path-traversal guard,
 *  same as readFile). Returns `{ ok }`; on refusal or failure `ok` is false
 *  and the handler logs — the renderer surfaces a non-blocking error. */
export const FileWriteSchema = z.object({
  /** Absolute or cwd-relative path. Must resolve inside a known project root. */
  filePath: z.string(),
  content: z.string(),
});
export type FileWriteInput = z.infer<typeof FileWriteSchema>;

/** Create a directory (and any missing ancestors), scoped to a known project
 *  root. Used by the file-tree "新建文件夹" action. `recursive: true` means an
 *  already-existing dir is not an error. Returns `{ ok }`; on refusal or
 *  failure `ok` is false and the handler logs. */
export const FileMkdirSchema = z.object({
  /** Absolute path of the directory to create. Must resolve inside a known
   *  project root (path-traversal guard, same as writeFile). */
  dirPath: z.string(),
});
export type FileMkdirInput = z.infer<typeof FileMkdirSchema>;

/** Delete a file or directory by moving it to the system trash (recoverable).
 *  Used by the file-tree "删除" right-click action. The path must resolve
 *  inside a known project root; on refusal or failure `ok` is false and the
 *  handler logs — the renderer surfaces a non-blocking error. Returns `{ ok }`. */
export const FileDeleteSchema = z.object({
  /** Absolute path of the file or directory to trash. Must resolve inside a
   *  known project root (path-traversal guard, same as writeFile/mkdir). */
  targetPath: z.string(),
});
export type FileDeleteInput = z.infer<typeof FileDeleteSchema>;

/** Rename a file or directory in place (same parent directory). Both paths
 *  must resolve inside the same known project root and share the same parent
 *  directory — cross-directory moves are refused (that is a move, not a
 *  rename). Used by the file-tree "重命名" right-click action. On refusal or
 *  failure `ok` is false and the handler logs. Returns `{ ok }`. */
export const FileRenameSchema = z.object({
  /** Absolute path of the entry to rename. Must resolve inside a known project
   *  root. */
  oldPath: z.string(),
  /** Absolute path of the new name. Must be in the same project root and the
   *  same parent directory as `oldPath`. */
  newPath: z.string(),
});
export type FileRenameInput = z.infer<typeof FileRenameSchema>;

/** Copy a file into a target directory (file-tree "复制/粘贴" pair). Both the
 *  source file and the destination directory must resolve inside known project
 *  roots; directories cannot be copied through this channel. If the plain
 *  destination name already exists the handler derives a free name by appending
 *  `suffix` (locale word for "copy", e.g. "副本"/"copy") and a counter — paste
 *  never overwrites. On refusal or failure `ok` is false and the handler logs.
 *  Returns `{ ok }`. */
export const FileCopySchema = z.object({
  /** Absolute path of the file to copy. Must resolve inside a known project
   *  root and be a regular file (not a directory). */
  srcPath: z.string(),
  /** Absolute path of the directory to copy into. Must resolve inside a known
   *  project root. */
  destDir: z.string(),
  /** Locale word used when deriving a clash-free name ("副本" / "copy").
   *  Defaults to "copy" when omitted. */
  suffix: z.string().optional(),
});
export type FileCopyInput = z.infer<typeof FileCopySchema>;

/** Native multi-file picker (project-external files allowed). Used by the
 *  composer "添加上下文" button to attach files that live outside the active
 *  project root — unlike the project-scoped `file.search`, this surfaces any
 *  file on the user's machine via the OS open dialog. */
export const DialogPickFilesSchema = z.object({
  /** Optional dialog title; defaults to a localized "选择文件" on the main side. */
  title: z.string().optional(),
  /** 原生选择框的扩展名过滤,如 `[{ name: "PDF", extensions: ["pdf"] }]`。
   *  不给就列所有文件(既有行为不变)。 */
  filters: z
    .array(z.object({ name: z.string(), extensions: z.array(z.string()) }))
    .optional(),
});
export type DialogPickFilesInput = z.infer<typeof DialogPickFilesSchema>;

/**
 * One line-level match from `file.grep`. `lineNumber` is 1-based. `lineText`
 * is the raw matched line (untrimmed, so column offsets are meaningful).
 * `matches` are 0-based [start,end) column ranges for each occurrence of the
 * query on that line, for frontend highlighting.
 */
export interface FileGrepEntry {
  /** Absolute filesystem path. */
  path: string;
  /** Path relative to the project root (forward-slash separated). */
  relativePath: string;
  /** 1-based line number within the file. */
  lineNumber: number;
  /** Raw text of the matched line. */
  lineText: string;
  /** Column ranges of each query occurrence on this line (0-based [start,end)). */
  matches: Array<{ start: number; end: number }>;
}

/**
 * Grep file contents under a project root. Main walks the same ignored-dir-
 * filtered tree as `file.search`, skips binary files (null-byte sniff on the
 * first ~8KB + a binary-extension skip-list), and scans each text file's
 * lines for the query. Case-insensitive by default. Returns line-level
 * matches, capped at `limit` total and `maxResultsPerFile` per file.
 */
export const FileGrepSchema = z.object({
  /** Absolute path of the project root. Must match a persisted Project.path. */
  projectPath: z.string(),
  /** Substring to search for inside file contents. */
  query: z.string(),
  /** Optional file-extension allow-list (no dots, lowercased). Empty or
   *  absent means no filter; narrows rg's globs and the JS fallback. */
  includeExts: z.array(z.string().min(1).max(32)).max(50).optional(),
  /** Max total matches to return. Defaults to 200 on the main side. */
  limit: z.number().int().positive().max(500).optional(),
  /** Max matches per single file. Defaults to 10 on the main side. */
  maxResultsPerFile: z.number().int().positive().max(50).optional(),
  /** Case-sensitive match. Defaults to false. */
  caseSensitive: z.boolean().optional(),
});
export type FileGrepInput = z.infer<typeof FileGrepSchema>;

/**
 * Result of a `file.grep` call. `matches` are capped at `limit` total /
 * `maxResultsPerFile` per file. `truncated` is true when the match cap was
 * reached while more matches almost certainly exist in files scanned so far.
 * `incompleteScan` is true when the walk hit its visit/depth budget before
 * covering the whole tree — unseen subtrees may hold additional matches.
 */
export interface FileGrepResult {
  matches: FileGrepEntry[];
  /** The match cap was reached — more matches likely exist. */
  truncated: boolean;
  /** The tree walk hit its visit/depth budget before finishing. */
  incompleteScan: boolean;
}

/* ── ripgrep availability / one-click install ──
 *  `file.search` / `file.grep` prefer ripgrep when one is resolvable and
 *  degrade to the in-process scanners when not. These channels let the search
 *  dialog detect the missing binary and offer a one-click install (downloads
 *  the official release into `userData/bin`). */

/** Snapshot of ripgrep availability for the search dialog. `installing`
 *  mirrors the main-side in-flight guard so a reopen during an ongoing
 *  install shows the right state. */
export interface RgStatusResult {
  /** An `rg` binary is resolvable (bundled userData/bin checked first, then PATH). */
  available: boolean;
  /** Resolved binary path when available. */
  path?: string;
  /** An install has been requested and is still running. */
  installing: boolean;
}

export const RgInstallSchema = z.object({});
export type RgInstallInput = z.infer<typeof RgInstallSchema>;

/** Result of an `rg.install` request. On success the binary sits in
 *  `userData/bin` and subsequent searches pick it up. */
export interface RgInstallResult {
  ok: boolean;
  error?: string;
  /** Path of the installed binary on success. */
  path?: string;
}

