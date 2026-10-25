/**
 * ARC-007: recoverable, Mcode-owned DOCX snapshots.
 *
 * This is NOT a competing document writer: it only writes a bounded, validated
 * recovery copy into Mcode's own dataRoot. The current workspace DOCX is never
 * modified until the normal DocumentViewHost.saveOpenedFile CAS transaction.
 * The vendor's renderer still serializes its original DOCX bytes.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";
import { fileContentVersion } from "@main/lib/fileVersion.js";
import { withOsFileLease } from "@main/lib/osFileLease.js";

const MAX_BYTES = 256 * 1024 * 1024;
interface Manifest { version: 1; baseRevision: string; snapshotSha256: string; savedAt: number }
const epochs = new Map<string, number>();
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const docxZip = (b: Uint8Array): boolean =>
  b.byteLength >= 4 && b[0] === 0x50 && b[1] === 0x4b &&
  ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6) || (b[2] === 7 && b[3] === 8));
function slot(root: string, canonicalPath: string): { file: string; meta: string; key: string; dir: string } {
  const key = sha(canonicalPath);
  const dir = join(root, "docs", "recovery");
  return { key, dir, file: join(dir, key + ".docx"), meta: join(dir, key + ".json") };
}
const epoch = (key: string): number => epochs.get(key) ?? 0;

/** Fail closed: only a real ZIP-formatted DOCX of the *opened* disk revision. */
export async function writeDocRecovery(input: {
  filePath: string; bytes: Uint8Array; baseRevision: string | null; dataRoot: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const { filePath, bytes, baseRevision, dataRoot } = input;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES || !docxZip(bytes))
    return { ok: false, reason: "DOCX 恢复副本必须是有效范围内的 ZIP 字节（加密 DOCX 不支持明文恢复）" };
  if (typeof baseRevision !== "string" || !/^[a-f0-9]{64}$/.test(baseRevision))
    return { ok: false, reason: "没有可信的打开版本，拒绝写恢复副本" };
  try {
    // Freeze the input before waiting for the shared file lease. The renderer
    // is free to mutate its ArrayBuffer immediately after invoking the IPC.
    const copy = Buffer.from(bytes);
    const { realpath } = await import("node:fs/promises");
    const originalReal = await realpath(filePath);
    const key = slot(dataRoot, originalReal).key;
    const entered = epoch(key);
    return await withOsFileLease(filePath, async (real) => {
      const p = slot(dataRoot, real);
      if (p.key !== key || entered !== epoch(key)) return { ok: false, reason: "等待租约期间恢复副本已被清除或文件身份改变" };
      if (await fileContentVersion(real) !== baseRevision) return { ok: false, reason: "文件已被外部修改，拒绝写恢复副本" };
      await mkdir(p.dir, { recursive: true });
      const manifest: Manifest = { version: 1, baseRevision, snapshotSha256: sha(copy), savedAt: Date.now() };
      await atomicReplaceFile(p.file, copy);
      if (entered !== epoch(p.key)) {
        await rm(p.file, { force: true });
        return { ok: false, reason: "保存或放弃修改已经使恢复副本失效" };
      }
      await atomicReplaceFile(p.meta, Buffer.from(JSON.stringify(manifest), "utf8"));
      if (entered !== epoch(p.key)) {
        await rm(p.meta, { force: true });
        await rm(p.file, { force: true });
        return { ok: false, reason: "恢复副本写入期间被清除" };
      }
      return { ok: true };
    });
  } catch (err) { return { ok: false, reason: err instanceof Error ? err.message : "写恢复副本失败" }; }
}

/** Does not mutate the original. Corrupt or stale partial manifests are never promoted. */
export async function inspectDocRecovery(
  filePath: string, dataRoot: string, currentRevision: string,
): Promise<{ bytes: Buffer; baseRevision: string; basedOnCurrent: boolean; savedAt: number } | null> {
  try {
    const { realpath } = await import("node:fs/promises");
    const real = await realpath(filePath);
    const p = slot(dataRoot, real);
    if (!existsSync(p.meta) || !existsSync(p.file)) return null;
    const info: unknown = JSON.parse(await readFile(p.meta, "utf8"));
    if (!info || typeof info !== "object") return null;
    const m = info as Partial<Manifest>;
    if (m.version !== 1 || typeof m.baseRevision !== "string" || !/^[a-f0-9]{64}$/.test(m.baseRevision) ||
      typeof m.snapshotSha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.snapshotSha256) ||
      typeof m.savedAt !== "number") return null;
    const { stat } = await import("node:fs/promises");
    const s = await stat(p.file);
    if (s.size <= 0 || s.size > MAX_BYTES) return null;
    const bytes = await readFile(p.file);
    if (!docxZip(bytes) || sha(bytes) !== m.snapshotSha256) return null;
    return { bytes, baseRevision: m.baseRevision, basedOnCurrent: m.baseRevision === currentRevision, savedAt: m.savedAt };
  } catch { return null; }
}

/** Call ONLY after a successful CAS save, or an explicitly confirmed discard. */
export async function clearDocRecovery(
  filePath: string, dataRoot: string, preserveBaseRevision?: string | null,
): Promise<void> {
  await withOsFileLease(filePath, async (real) => {
    const p = slot(dataRoot, real);
    // A new edit can create a recovery copy for the just-saved version while
    // cleanup waits for this OS lease. Never discard that newer snapshot.
    if (preserveBaseRevision) {
      try {
        const raw: unknown = JSON.parse(await readFile(p.meta, "utf8"));
        if (raw && typeof raw === "object" &&
            (raw as { baseRevision?: unknown }).baseRevision === preserveBaseRevision) return;
      } catch { /* absent/invalid copy is safe to clear */ }
    }
    epochs.set(p.key, epoch(p.key) + 1);
    await rm(p.meta, { force: true });
    await rm(p.file, { force: true });
  });
}
