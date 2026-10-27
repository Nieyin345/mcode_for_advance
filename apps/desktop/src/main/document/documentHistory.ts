/**
 * **文件历史** —— 每个文档的版本列表与回滚（不依赖 git）。
 *
 * ## 与 `documentRecovery` 的分工（两者不要合并）
 *
 *   | | 崩溃恢复 | 文件历史 |
 *   |---|---|---|
 *   | 保留几份 | **只有最新一份**（覆盖即删旧的） | **多份**（按时间留档） |
 *   | 用途 | 崩溃后把没保存的草稿捞回来 | 用户主动回到以前的版本 |
 *   | 何时写 | 自动保存时 | 每次**成功保存**后 |
 *   | 用户看得到吗 | 不（只在异常路径出现） | 是（历史面板） |
 *
 * 把它们合成一个会带来一个错误的两难：要么崩溃恢复留一大堆没用的旧草稿，
 * 要么历史只留一份。**两种语义本来就是不同的。**
 *
 * ## 写盘顺序（照 recovery 那套，因为它是这个仓库验证过的）
 *
 *   1. 先写**内容寻址**的不可变快照 `<key>.<sha256>.<ext>`；
 *   2. 再原子替换索引 `<key>.history.json`；
 *   3. 最后尽力清理超出上限的旧快照。
 *
 * 任何一步崩溃都不会毁掉已发布的版本：索引始终指向**已经落盘**的字节。
 *
 * ## 不做什么
 *
 * - **不写用户文件**（除了显式回滚）：只读用户文件、只写自己数据根下的副本；
 * - **不接管保存**：保存仍是现有那条路（`documentSaveGuard`），本模块在
 *   保存**成功之后**被调用；
 * - **不做文本 diff**：二进制格式（docx/xlsx/pptx/pdf）没法可靠地算文本差异，
 *   索引里带字节数与来源，够用户认出"这是哪一版"。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { atomicReplaceFile } from "@main/lib/atomicFile.js";

/** 单份快照的字节上限 —— 与 recovery 取同一个量级（超大文件不进历史）。 */
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
/** 每个文件保留多少版。48 版 ≈ 一个工作日里每十分钟保存一次。 */
const MAX_VERSIONS = 48;
/** 索引文件的格式版本。改了索引形状要加一，旧索引按"读不出来就当作空"处理。 */
const INDEX_VERSION = 1;

const HASH = /^[a-f0-9]{64}$/;
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** 一个历史版本。 */
export interface DocumentVersion {
  /** 内容摘要（同一份字节永远同一个 id —— 重复保存同一内容不会长出新版本）。 */
  sha256: string;
  savedAt: number;
  /** 字节数（用户靠它认出"这一版是不是小很多"）。 */
  bytes: number;
  /** 这一版是怎么来的。 */
  source: "user" | "ai" | "restore";
}

interface HistoryIndex {
  version: typeof INDEX_VERSION;
  /** 解析后的绝对路径（仅诊断用，不作为身份）。 */
  filePath: string;
  /** 从旧到新。 */
  versions: DocumentVersion[];
}

interface Slot {
  key: string;
  dir: string;
  indexPath: string;
}

function slotOf(dataRoot: string, canonicalPath: string): Slot {
  const key = sha(canonicalPath);
  const dir = join(dataRoot, "docs", "history");
  return { key, dir, indexPath: join(dir, `${key}.history.json`) };
}

function snapshotPath(slot: Slot, digest: string, ext: string): string {
  // 扩展名留在文件名里：用户可能手动去翻这些文件，带扩展名的双击能打开。
  const safeExt = /^\.[a-z0-9]{1,12}$/i.test(ext) ? ext.toLowerCase() : ".bin";
  return join(slot.dir, `${slot.key}.${digest}${safeExt}`);
}

function parseIndex(raw: unknown, filePath: string): HistoryIndex | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Partial<HistoryIndex>;
  if (value.version !== INDEX_VERSION) return null;
  if (!Array.isArray(value.versions)) return null;
  const versions: DocumentVersion[] = [];
  for (const entry of value.versions) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as Partial<DocumentVersion>;
    if (typeof item.sha256 !== "string" || !HASH.test(item.sha256)) continue;
    if (typeof item.savedAt !== "number" || !Number.isFinite(item.savedAt)) continue;
    if (typeof item.bytes !== "number" || !Number.isFinite(item.bytes) || item.bytes < 0) continue;
    if (item.source !== "user" && item.source !== "ai" && item.source !== "restore") continue;
    versions.push({ sha256: item.sha256, savedAt: item.savedAt, bytes: item.bytes, source: item.source });
  }
  return { version: INDEX_VERSION, filePath, versions };
}

async function readIndex(slot: Slot, filePath: string): Promise<HistoryIndex> {
  if (!existsSync(slot.indexPath)) return { version: INDEX_VERSION, filePath, versions: [] };
  try {
    const text = await readFile(slot.indexPath, "utf8");
    return parseIndex(JSON.parse(text), filePath)
      ?? { version: INDEX_VERSION, filePath, versions: [] };
  } catch {
    // 索引坏了 → 当作空历史。**不抛**：历史是附属能力，不能因为它坏掉而让保存失败。
    return { version: INDEX_VERSION, filePath, versions: [] };
  }
}

/** 删掉不在 `keep` 里的本文件快照。**只碰自己 key 前缀的文件。** */
async function prune(slot: Slot, keep: ReadonlySet<string>): Promise<void> {
  const names = await readdir(slot.dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [] as string[];
    throw err;
  });
  for (const name of names) {
    if (!name.startsWith(`${slot.key}.`)) continue;
    if (name === `${slot.key}.history.json`) continue;
    // `<key>.<64hex><ext>`
    const rest = name.slice(slot.key.length + 1);
    const dot = rest.indexOf(".");
    const digest = dot < 0 ? rest : rest.slice(0, dot);
    if (!HASH.test(digest)) continue;
    if (keep.has(digest)) continue;
    await rm(join(slot.dir, name), { force: true }).catch(() => undefined);
  }
}

async function canonicalOf(filePath: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(filePath);
}

/**
 * 记录一个版本（在**保存成功之后**调用）。
 *
 * 同一份字节重复保存**不会**长出新版本（返回 `added: false`）——
 * 否则每按一次 Cmd-S 就多一条，历史列表很快就没法看。
 */
export async function recordDocumentVersion(input: {
  filePath: string;
  source: DocumentVersion["source"];
  dataRoot: string;
}): Promise<{ ok: true; added: boolean; version?: DocumentVersion } | { ok: false; reason: string }> {
  const { filePath, source, dataRoot } = input;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { ok: false, reason: "不是普通文件，无法记录历史" };
    if (info.size > MAX_SNAPSHOT_BYTES) {
      return { ok: false, reason: `文件超过 ${Math.round(MAX_SNAPSHOT_BYTES / 1024 / 1024)} MB，未记入历史` };
    }
    const canonical = await canonicalOf(filePath);
    const slot = slotOf(dataRoot, canonical);
    await mkdir(slot.dir, { recursive: true });

    const bytes = await readFile(canonical);
    const digest = sha(bytes);
    const index = await readIndex(slot, canonical);
    if (index.versions.at(-1)?.sha256 === digest) {
      return { ok: true, added: false };
    }

    // 1) 不可变快照先落盘
    const target = snapshotPath(slot, digest, extname(canonical));
    await atomicReplaceFile(target, bytes);

    // 2) 再原子发布索引
    const record: DocumentVersion = {
      sha256: digest,
      savedAt: Date.now(),
      bytes: bytes.byteLength,
      source,
    };
    const versions = [...index.versions, record].slice(-MAX_VERSIONS);
    await atomicReplaceFile(
      slot.indexPath,
      Buffer.from(JSON.stringify({ version: INDEX_VERSION, filePath: canonical, versions }), "utf8"),
    );

    // 3) 尽力清理（失败不影响这次记录）
    await prune(slot, new Set(versions.map((each) => each.sha256))).catch(() => undefined);
    return { ok: true, added: true, version: record };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "记录文件历史失败" };
  }
}

/** 列出某个文件的版本（**从旧到新**，与索引一致）。 */
export async function listDocumentVersions(input: {
  filePath: string;
  dataRoot: string;
}): Promise<{ ok: true; versions: DocumentVersion[] } | { ok: false; reason: string }> {
  try {
    const canonical = await canonicalOf(input.filePath).catch(() => input.filePath);
    const slot = slotOf(input.dataRoot, canonical);
    const index = await readIndex(slot, canonical);
    // 只返回**字节还在**的版本：索引写过但快照被外部删掉时，列表里不该留幽灵。
    const alive: DocumentVersion[] = [];
    for (const version of index.versions) {
      const path = snapshotPath(slot, version.sha256, extname(canonical));
      if (existsSync(path)) alive.push(version);
    }
    return { ok: true, versions: alive };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "读取文件历史失败" };
  }
}

/**
 * 把某个历史版本写回文件 —— **写之前先给当前内容记一版**。
 *
 * 这一步是「回滚也要能回滚」的唯一保障：没有它，用户从版本 3 回到版本 1
 * 就把版本 3 弄丢了。恢复出来的这一版标记为 `restore`，用户能看出来
 * "这条是我回滚时自动产生的"。
 */
export async function restoreDocumentVersion(input: {
  filePath: string;
  sha256: string;
  dataRoot: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { filePath, sha256: digest, dataRoot } = input;
  if (!HASH.test(digest)) return { ok: false, reason: "版本号格式不对" };
  try {
    const canonical = await canonicalOf(filePath);
    const slot = slotOf(dataRoot, canonical);
    const source = snapshotPath(slot, digest, extname(canonical));
    if (!existsSync(source)) return { ok: false, reason: "这一版的快照已经不在了" };

    // 先保住当前内容（失败就整个放弃回滚 —— 宁可不动，也不要丢掉用户现在的版本）
    const current = await readFile(canonical).catch(() => null);
    if (current !== null) {
      const index = await readIndex(slot, canonical);
      const currentDigest = sha(current);
      if (index.versions.at(-1)?.sha256 !== currentDigest) {
        const snapshot = snapshotPath(slot, currentDigest, extname(canonical));
        await atomicReplaceFile(snapshot, current);
        const versions = [...index.versions, {
          sha256: currentDigest, savedAt: Date.now(), bytes: current.byteLength,
          source: "restore" as const,
        }].slice(-MAX_VERSIONS);
        await atomicReplaceFile(
          slot.indexPath,
          Buffer.from(JSON.stringify({ version: INDEX_VERSION, filePath: canonical, versions }), "utf8"),
        );
        await prune(slot, new Set(versions.map((each) => each.sha256))).catch(() => undefined);
      }
    }

    // 再写回目标版本（原子替换，不半写）
    const bytes = await readFile(source);
    await atomicReplaceFile(canonical, bytes);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "回滚到历史版本失败" };
  }
}

/** 取某个历史版本的字节（预览/导出用，不写文件）。 */
export async function readDocumentVersionBytes(input: {
  filePath: string;
  sha256: string;
  dataRoot: string;
}): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
  try {
    const canonical = await canonicalOf(input.filePath).catch(() => input.filePath);
    const slot = slotOf(input.dataRoot, canonical);
    const path = snapshotPath(slot, input.sha256, extname(canonical));
    if (!existsSync(path)) return { ok: false, reason: "这一版的快照已经不在了" };
    return { ok: true, bytes: await readFile(path) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "读取历史版本失败" };
  }
}
