/** Faults affect only this smoke's temporary database; never a user path.
 * Import bare `fs` so the esbuild alias for `node:fs` cannot alias itself. */
import * as fs from "fs";
import { basename, dirname, resolve } from "node:path";
export * from "fs";

type Fault = "write" | "rename" | "sync";
let armed: { target: string; kind: Fault } | null = null;
const descriptors = new Map<number, string>();
export let faultHits = 0;
export function armFault(target: string, kind: Fault): void {
  armed = { target: resolve(target), kind };
  faultHits = 0;
}
export function clearFault(): void { armed = null; }
function isDatabasePath(path: fs.PathLike | number): boolean {
  const name = typeof path === "number" ? descriptors.get(path) : String(path);
  if (!name || !armed) return false;
  const full = resolve(name);
  return dirname(full) === dirname(armed.target) && basename(full).startsWith(basename(armed.target));
}
function fail(kind: Fault): never {
  faultHits++;
  throw Object.assign(new Error(`injected ${kind} failure (isolated smoke)`), {
    code: kind === "write" ? "ENOSPC" : "EACCES",
  });
}
export const openSync: typeof fs.openSync = (path, flags, mode) => {
  const fd = fs.openSync(path, flags, mode);
  descriptors.set(fd, String(path));
  return fd;
};
export const closeSync: typeof fs.closeSync = (fd) => {
  try { fs.closeSync(fd); } finally { descriptors.delete(fd); }
};
export const writeFileSync: typeof fs.writeFileSync = (file, data, options) => {
  if (armed?.kind === "write" && isDatabasePath(file)) {
    // A real partial write, not a throw before opening: direct target writes
    // really corrupt the old bytes, while staging keeps the old file intact.
    fs.writeFileSync(file, "INTERRUPTED_WRITE");
    fail("write");
  }
  fs.writeFileSync(file, data, options);
};
export const renameSync: typeof fs.renameSync = (from, to) => {
  if (armed?.kind === "rename" && isDatabasePath(to)) fail("rename");
  fs.renameSync(from, to);
};
export const fsyncSync: typeof fs.fsyncSync = (fd) => {
  if (armed?.kind === "sync" && isDatabasePath(fd)) fail("sync");
  fs.fsyncSync(fd);
};
