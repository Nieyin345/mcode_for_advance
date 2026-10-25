/**
 * Mcode-owned DOCX crash recovery. It is a versioned, immutable snapshot
 * journal, NOT a second writer for the user's open DOCX.
 *
 * The original v1 used one fixed payload file plus a separate manifest. An
 * OS crash between their two atomic renames could corrupt the previously
 * valid recovery point. v2 writes a CONTENT-ADDRESSED immutable snapshot
 * first, then atomically publishes only the manifest pointer. Readers and
 * writes share the one existing cross-process DOCX lease.
 *
 * Legacy v1 snapshots remain readable; no data migration is required.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";
import { fileContentVersion } from "@main/lib/fileVersion.js";
import { withOsFileLease } from "@main/lib/osFileLease.js";

const MAX_BYTES = 256 * 1024 * 1024;
type Manifest = {
  version: 1 | 2; baseRevision: string; snapshotSha256: string; savedAt: number;
};
const epochs = new Map<string, number>();
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const docxZip = (b: Uint8Array): boolean =>
  b.byteLength >= 4 && b[0] === 0x50 && b[1] === 0x4b &&
  ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6) || (b[2] === 7 && b[3] === 8));
function slot(root: string, canonicalPath: string) {
  const key = sha(canonicalPath);
  const dir = join(root, "docs", "recovery");
  return { key, dir, legacyFile: join(dir, key + ".docx"), meta: join(dir, key + ".json") };
}
const epoch = (key: string): number => epochs.get(key) ?? 0;
function validManifest(input: unknown): input is Manifest {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const v = input as Partial<Manifest>;
  return (v.version === 1 || v.version === 2) &&
    typeof v.baseRevision === "string" && HASH.test(v.baseRevision) &&
    typeof v.snapshotSha256 === "string" && HASH.test(v.snapshotSha256) &&
    typeof v.savedAt === "number" && Number.isFinite(v.savedAt);
}
function snapshotFile(p: ReturnType<typeof slot>, digest: string): string {
  return join(p.dir, p.key + "." + digest + ".docx");
}
async function cleanupPayloads(p: ReturnType<typeof slot>, keepDigest?: string): Promise<void> {
  // Never remove another file's snapshots. Strict hash suffix and filename
  // allowlist, within Mcode's own private recovery directory only.
  const files = await readdir(p.dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [] as string[];
    throw err;
  });
  for (const name of files) {
    if (name === p.key + ".docx" || (
      name.startsWith(p.key + ".") &&
      /^[a-f0-9]{64}\.docx$/.test(name.slice(p.key.length + 1))
    )) {
      if (keepDigest && name === p.key + "." + keepDigest + ".docx") continue;
      await rm(join(p.dir, name), { force: true });
    }
  }
}

/** Write an immutable draft before switching the manifest pointer. */
export async function writeDocRecovery(input: {
  filePath: string; bytes: Uint8Array; baseRevision: string | null; dataRoot: string;
  /** Only used in isolated unit/crash testing; production never supplies it. */
  beforeManifestCommit?: () => Promise<void>;
}): Promise<{ ok: boolean; reason?: string }> {
  const { filePath, bytes, baseRevision, dataRoot } = input;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES || !docxZip(bytes))
    return { ok: false, reason: "DOCX 恢复副本必须是有效范围内的 ZIP 字节（加密 DOCX 不支持明文恢复）" };
  if (typeof baseRevision !== "string" || !HASH.test(baseRevision))
    return { ok: false, reason: "没有可信的打开版本，拒绝写恢复副本" };
  try {
    // Freeze caller-owned memory BEFORE awaiting the OS lease.
    const copy = Buffer.from(bytes);
    const { realpath } = await import("node:fs/promises");
    const originalReal = await realpath(filePath);
    const key = slot(dataRoot, originalReal).key;
    const entered = epoch(key);
    return await withOsFileLease(filePath, async (real) => {
      const p = slot(dataRoot, real);
      if (p.key !== key || entered !== epoch(key)) {
        return { ok: false, reason: "等待租约期间恢复副本已被清除或文件身份改变" };
      }
      if (await fileContentVersion(real) !== baseRevision) {
        return { ok: false, reason: "文件已被外部修改，拒绝写恢复副本" };
      }
      await mkdir(p.dir, { recursive: true });
      const digest = sha(copy);
      const manifest: Manifest = { version: 2, baseRevision, snapshotSha256: digest, savedAt: Date.now() };
      // Prior manifest still points to immutable old bytes throughout this
      // step. A crash here never destroys its valid recovery point.
      await atomicReplaceFile(snapshotFile(p, digest), copy);
      if (entered !== epoch(key)) return { ok: false, reason: "保存或放弃修改已经使恢复副本失效" };
      await input.beforeManifestCommit?.();
      if (entered !== epoch(key)) return { ok: false, reason: "恢复副本写入期间被清除" };
      // Single atomic commit point for a fully durable draft.
      await atomicReplaceFile(p.meta, Buffer.from(JSON.stringify(manifest), "utf8"));
      // Best-effort garbage collection: failed cleanup must NOT make an
      // already committed recovery draft look like a failed autosave.
      await cleanupPayloads(p, digest).catch(() => undefined);
      return { ok: true };
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "写恢复副本失败" };
  }
}

/**
 * If no committed manifest exists, there's no recoverable draft yet.
 * If a manifest DOES exist but is invalid, fail CLOSED: never silently
 * dismiss potentially unsaved document data as "nothing to restore".
 */
export async function inspectDocRecovery(
  filePath: string, dataRoot: string, currentRevision: string,
): Promise<{ bytes: Buffer; baseRevision: string; basedOnCurrent: boolean; savedAt: number } | null> {
  return withOsFileLease(filePath, async (real) => {
    const p = slot(dataRoot, real);
    if (!existsSync(p.meta)) return null;
    let raw: unknown;
    try { raw = JSON.parse(await readFile(p.meta, "utf8")); }
    catch { throw new Error("DOCX 恢复清单损坏或无法读取：保留副本并拒绝静默忽略"); }
    if (!validManifest(raw)) {
      throw new Error("DOCX 恢复清单格式无效：请检查恢复文件，拒绝静默打开旧稿");
    }
    const m = raw;
    const payload = m.version === 1 ? p.legacyFile : snapshotFile(p, m.snapshotSha256);
    try {
      const s = await stat(payload);
      if (!s.isFile() || s.size <= 0 || s.size > MAX_BYTES) throw new Error("invalid size");
      const bytes = await readFile(payload);
      if (!docxZip(bytes) || sha(bytes) !== m.snapshotSha256) throw new Error("checksum mismatch");
      return { bytes, baseRevision: m.baseRevision, basedOnCurrent: m.baseRevision === currentRevision, savedAt: m.savedAt };
    } catch {
      throw new Error("DOCX 恢复副本缺失或校验失败：已保留恢复清单，拒绝静默覆盖未保存内容");
    }
  });
}

/** Call ONLY after successful CAS save or explicitly confirmed discard. */
export async function clearDocRecovery(
  filePath: string, dataRoot: string, preserveBaseRevision?: string | null,
  expectedDiskRevision?: string,
): Promise<void> {
  await withOsFileLease(filePath, async (real) => {
    if (expectedDiskRevision && await fileContentVersion(real) !== expectedDiskRevision) {
      throw new Error("丢弃恢复副本期间磁盘文件版本变化，已保留副本供重新确认");
    }
    const p = slot(dataRoot, real);
    if (preserveBaseRevision) {
      try {
        const raw: unknown = JSON.parse(await readFile(p.meta, "utf8"));
        if (validManifest(raw) && raw.baseRevision === preserveBaseRevision) return;
      } catch { /* no valid pointer; may be cleared */ }
    }
    epochs.set(p.key, epoch(p.key) + 1);
    // First revoke the committed manifest pointer; then remove snapshots.
    await rm(p.meta, { force: true });
    await cleanupPayloads(p);
  });
}
