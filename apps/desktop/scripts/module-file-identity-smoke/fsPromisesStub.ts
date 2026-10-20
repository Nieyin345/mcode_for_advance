/** Synthetic race injection for fileCapabilities: works only in a private mkdtemp tree. */
import { promises as realFs } from "node:fs";
import { linkSync, renameSync, symlinkSync, statSync, writeFileSync, utimesSync } from "node:fs";
type Hook = "open" | "stat" | null;
let hook: Hook = null;
let target = "";
let external = "";
let hit = 0;
let mode: "link" | "symlink" = "link";
let rewriteTarget = "";
let rewriteBytes = "";
let rewriteHits = 0;
export function armRewriteOnRead(path: string, contents: string): void {
  rewriteTarget = path; rewriteBytes = contents; rewriteHits = 0;
}
export function rewriteReadHits(): number {return rewriteHits;}
export function armSwap(kind: Exclude<Hook, null>, insidePath: string, outsidePath: string, swap: "link" | "symlink" = "link"): void {
  hook=kind;target=insidePath;external=outsidePath;hit=0;mode=swap;
}
export function clearSwap(): void {hook=null;target="";external="";hit=0;rewriteTarget="";rewriteBytes="";rewriteHits=0;}
export function swapHits(): number {return hit;}
function perhapsSwap(kind: Exclude<Hook, null>, path: unknown) {
  if (hook !== kind || String(path) !== target) return;
  hook=null;
  hit++;
  renameSync(target,target+".backup");
  if(mode==="link") linkSync(external,target);
  else symlinkSync(external,target,"file");
}
export async function open(...args: Parameters<typeof realFs.open>): ReturnType<typeof realFs.open> {
  perhapsSwap("open",args[0]);
  const handle = await realFs.open(...args);
  if (String(args[0]) === rewriteTarget) {
    const original = handle.read.bind(handle);
    // Patch only this private test handle, not process-wide fs or user files.
    (handle as unknown as {read: (...args: Parameters<typeof original>) => ReturnType<typeof original>}).read =
      (async (...readArgs: Parameters<typeof original>) => {
        const result = await original(...readArgs);
        if (rewriteTarget !== "" && result.bytesRead > 0) {
          const path = rewriteTarget;
          const data = rewriteBytes;
          rewriteTarget = "";
          // Give the OS ctime clock a distinct tick; restore mtime deliberately
          // so a guard that only compares size/mtime will miss the mutation.
          await new Promise(resolve => setTimeout(resolve, 30));
          const previous = statSync(path);
          writeFileSync(path, data);
          utimesSync(path, previous.atime, previous.mtime);
          rewriteHits++;
        }
        return result;
      }) as typeof original;
  }
  return handle;
}
export async function stat(...args: Parameters<typeof realFs.stat>): ReturnType<typeof realFs.stat> {
  perhapsSwap("stat",args[0]);
  return realFs.stat(...args);
}
export const realpath = realFs.realpath.bind(realFs);
