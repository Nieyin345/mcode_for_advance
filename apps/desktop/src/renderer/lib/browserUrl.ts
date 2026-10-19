/** Convert a local filesystem path into a `file://` URL that Electron's
 *  `webContents.loadURL` can open natively. Handles Windows drive paths
 *  (`C:\\…` / `C:/…`) and Unix absolute paths (`/…`). Backslashes are
 *  normalised to forward slashes and non-URL-safe characters (spaces, CJK,
 *  etc.) are percent-encoded so paths with spaces or Chinese characters load
 *  correctly.
 *
 *  Caller is expected to have already determined the input is a local path
 *  (e.g. starts with a drive letter or `/`); this helper does the encoding. */
export function localPathToFileUrl(p: string): string {
  // Never trim: spaces before/after a filename are real filesystem bytes.
  const norm = p.replace(/\\/g, "/");
  // These are filename characters, not URL query/fragment delimiters.
  // encodeURI preserves them, so escape them after its normal path encoding.
  const encoded = encodeURI(norm).replace(/[?#]/g, (char) => encodeURIComponent(char));
  // UNC //server/share/file → file://server/share/file. Four slashes
  // describe a *local* path instead and lose the remote file-server host.
  if (norm.startsWith("//")) return `file:${encoded}`;
  // Windows drive path → file:///C:/…
  if (/^[a-z]:\//i.test(norm)) return `file:///${encoded}`;
  // Unix absolute path → file:///foo (file:// + /foo)
  return `file://${encoded}`;
}
