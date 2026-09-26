/**
 * MEM-03：把纯的过期/疑似重复判据接到真实记忆库，**只出建议**。
 *
 * 每份建议携带原始 markdown（含手写 frontmatter）的 SHA-256 指纹；人工勾选、确认后重新核对，
 * 才允许删一条。扫描无写操作；遇到读取失败/数量上限必须显式报告而不是假装全覆盖。
 * 引擎 CLI 的项目 MEMORY.md 与六类 Mcode 记忆不在同一个根下，绝不纳入整理。
 */
import { createHash } from "node:crypto";
import type { MemoryFileMeta, MemoryReviewDeleteInput, MemoryReviewEntry, MemoryReviewResult } from "@contracts/memory";
import { findStale, suggestDedup } from "./maintenance.js";
import { deleteMemoryFile, listMemoryFiles, readMemoryFileWithRaw } from "./store.js";

const MAX_STALE = 100;
const MAX_DEDUP = 200;
const MAX_PAIRS = 100;
const MAX_DEDUP_BODY = 8_000;
const PREVIEW_CHARS = 160;

/** 只把摘要/指纹给 UI；可用时按**完整原文**算（含人工编辑的未知 frontmatter 字段）。 */
function digest(meta: MemoryFileMeta, content: string, raw?: string): string {
  return createHash("sha256")
    .update(JSON.stringify([meta.path, meta.title, meta.updatedAt, raw ?? content]))
    .digest("hex");
}

/** 注入读取函数与时间方便无头测限额/读失败；这里本身不会删除或改写任何文件。 */
export function buildMemoryReview(
  metas: readonly MemoryFileMeta[],
  read: (path: string) => { content: string; raw?: string },
  now: number = Date.now(),
): MemoryReviewResult {
  const staleMetas = findStale(metas, now).sort(
    (a, b) => a.updatedAt - b.updatedAt || a.path.localeCompare(b.path),
  );
  const recent = [...metas].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path),
  ).slice(0, MAX_DEDUP);
  const unreadable: string[] = [];
  const tooLong: string[] = [];
  const loaded = new Map<string, { entry: MemoryReviewEntry; content: string } | null>();
  const get = (meta: MemoryFileMeta): { entry: MemoryReviewEntry; content: string } | null => {
    if (loaded.has(meta.path)) return loaded.get(meta.path) ?? null;
    try {
      const { content, raw } = read(meta.path);
      const entry: MemoryReviewEntry = {
        ...meta,
        preview: content.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS),
        digest: digest(meta, content, raw),
      };
      const result = { entry, content };
      loaded.set(meta.path, result);
      return result;
    } catch {
      unreadable.push(meta.path);
      loaded.set(meta.path, null);
      return null;
    }
  };

  const stale = staleMetas.slice(0, MAX_STALE)
    .map((meta) => get(meta)?.entry)
    .filter((entry): entry is MemoryReviewEntry => entry !== undefined);
  const dedupSources = recent.flatMap((meta) => {
    const item = get(meta);
    if (!item) return [];
    if (item.content.length > MAX_DEDUP_BODY) {
      tooLong.push(meta.path); // 截断正文拿去比较会制造误报，不比较且明确告诉用户。
      return [];
    }
    return [{ path: meta.path, title: meta.title, content: item.content }];
  });
  const pairs = suggestDedup(dedupSources);
  return {
    stale,
    staleTotal: staleMetas.length,
    staleTruncated: staleMetas.length > MAX_STALE,
    duplicates: pairs.slice(0, MAX_PAIRS).flatMap((pair) => {
      const a = loaded.get(pair.a)?.entry;
      const b = loaded.get(pair.b)?.entry;
      return a && b ? [{ a, b, score: pair.score }] : [];
    }),
    duplicatePairTotal: pairs.length,
    pairTruncated: pairs.length > MAX_PAIRS,
    scannedForDuplicates: dedupSources.length,
    duplicateTruncated: metas.length > MAX_DEDUP,
    tooLong,
    unreadable,
    totalFiles: metas.length,
  };
}

/** 真实库入口：先列六类文件，再读取需要比较的条目；不调任何写操作。 */
export function reviewMemoryFiles(): MemoryReviewResult {
  const omitted: string[] = [];
  const metas = listMemoryFiles({ onUnreadable: (path) => omitted.push(path) });
  const report = buildMemoryReview(metas, readMemoryFileWithRaw);
  return { ...report, unreadable: [...new Set([...omitted, ...report.unreadable])] };
}

/** 单条显式删除；主进程同步重读并核对完整指纹，变动/消失即拒绝。 */
export function deleteReviewedMemory(input: MemoryReviewDeleteInput): { ok: boolean; error?: string } {
  try {
    const meta = listMemoryFiles().find((item) => item.path === input.path);
    if (!meta) return { ok: false, error: "记忆不存在或不可读，请重新整理后再选择。" };
    const { content, raw, revision } = readMemoryFileWithRaw(input.path);
    if (digest(meta, content, raw) !== input.digest) {
      return { ok: false, error: "记忆已发生改动，请重新整理、查看并再次选择，未删除。" };
    }
    deleteMemoryFile(input.path, revision);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
