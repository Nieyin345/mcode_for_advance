/**
 * T16 / MC-035: desktop-user-only, persistent opt-in to the UNSAFE Windows
 * JS-only egress downgrade. Kept outside generic settings storage so
 * setting.set, settings import/export and app_api_call cannot grant it.
 *
 * Reads are deliberately uncached: revocation denies new launches at once.
 * Corrupt/symlink/hardlink/absent/non-regular files fail closed.
 * No Electron/DB dependencies: can be exercised in isolated headless smoke.
 */
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

let configuredPath: string | null = null;
export function configureEgressConsentStoragePath(path: string | null): void {
  configuredPath = path;
}
export function getJsOnlyEgressConsent(): boolean {
  if (!configuredPath) return false;
  try {
    const stat = lstatSync(configuredPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256) return false;
    const parsed: unknown = JSON.parse(readFileSync(configuredPath, "utf8"));
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).version === 1
      && (parsed as Record<string, unknown>).enabled === true
      && Object.keys(parsed).sort().join(",") === "enabled,version";
  } catch { return false; }
}
/** Setter must be invoked only by the desktop-only modules:egressConsentSet IPC. */
export async function setJsOnlyEgressConsent(enabled: boolean): Promise<void> {
  if (!configuredPath) throw Error("egress_isolation_unavailable: approval storage not initialized");
  const path = configuredPath;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, "js-egress-consent-" + randomUUID() + ".tmp");
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, enabled }), "utf8");
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
