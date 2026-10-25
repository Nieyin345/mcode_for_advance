/**
 * Mcode-owned renderer asset resolver. GenOffice is bundled as an editor
 * engine, not a second app/server: Chromium's custom-scheme requests must not
 * synchronously block the Mcode main process on filesystem lookups.
 *
 * Resolve the configured root and the requested asset on every access: a
 * symlink/junction can change after startup, so caching a once-validated
 * canonical root/file would weaken the existing escape fence.
 */
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

export async function resolveSafeGenofficeAsset(
  stagedRendererRoot: string,
  encodedPathname: string,
): Promise<string | null> {
  let relative: string;
  try {
    relative = decodeURIComponent(encodedPathname).replace(/\\/g, "/").replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!relative || relative.length > 4096 || relative.includes("\0")) return null;

  const root = resolve(stagedRendererRoot);
  const target = resolve(root, relative);
  // Reject traversal before I/O, as well as symlink/junction traversal below.
  if (!target.startsWith(root + sep)) return null;

  try {
    const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
    return realTarget.startsWith(realRoot + sep) ? realTarget : null;
  } catch {
    // Missing, inaccessible or broken symlink: never guess a fallback path.
    return null;
  }
}
