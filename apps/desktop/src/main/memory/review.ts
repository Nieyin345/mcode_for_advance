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

/** 真实库入口：先列六类文件，再读取需要比较的条目；不调任何写操作。
 *
 * 【MC-092】`visible` 是宿主(带 agent 作用域时)传进来的「当前可见集合」判据:给了谓词就在
 * **进入扫描之前**把不可见的条目滤掉 —— 这样 `staleTotal` / `totalFiles` / duplicates 的配对
 * 与最终列出的条目**同出一份可见集合**,不会出现"计数里带着别项目、列表里却没有"的错位。
 * `undefined` = 桌面用户(扫全部)。
 *
 * 【MC-031 同族】`visible` 只判**文件**地址(调用方给的是 `visibleMemory`)。诊断清单里
 * 还有**目录**(`listMemoryFiles` 的 onUnreadable 会报类目/项目目录被链接替换、整目录
 * 读不动)—— 拿文件版谓词滤目录会把它们整批丢掉,agent 于是看不到"这一整类没扫到"。
 * `visibleDiagnostic` 是同一作用域派生的**诊断版**谓词(文件仍走 `visibleMemory`,目录走
 * `visibleMemoryDir`);只用于诊断清单,扫描过滤仍只用 `visible` 那一份。 */
export function reviewMemoryFiles(
  visible?: (path: string) => boolean,
  visibleDiagnostic?: (path: string) => boolean,
): MemoryReviewResult {
  const omitted: string[] = [];
  const all = listMemoryFiles({ onUnreadable: (path) => omitted.push(path) });
  const metas = visible === undefined ? all : all.filter((meta) => visible(meta.path));
  const report = buildMemoryReview(metas, readMemoryFileWithRaw);
  // 【MC-092】诊断清单也必须过**同一份**可见谓词。⚠️ `omitted` 是在**整棵树**上收集的
  // (listMemoryFiles 的 onUnreadable 遍历到每个类目、每个 `projects/<id>/…`),里面可能有
  // `projects/<别项目>/…` 的不可读路径 —— 直接并进 `unreadable` 就等于把**不可见项目的存在与
  // 名字**漏给 agent(它能读到的清单里没有该项目,诊断里却点名了它的路径)。`report.unreadable`
  // 已出自过滤后的 metas,但整条清单统一走谓词才是「一份判据」;桌面用户(无谓词)照旧看全部。
  const diagnostics = [...new Set([...omitted, ...report.unreadable])];
  const unreadable = visible === undefined
    ? diagnostics
    : diagnostics.filter((path) => visible(path) || (visibleDiagnostic?.(path) ?? false));
  return { ...report, unreadable };
}

/** 单条显式删除；主进程同步重读并核对完整指纹，变动/消失即拒绝。
 *
 * 【MC-092】`visible` 同 {@link reviewMemoryFiles}:agent 作用域下,不属于本项目/全局的路径
 * 一律拒(走 `{ok:false,error}` 契约形状,与 `memory:delete` 同一道闸);桌面用户不设限。 */
export function deleteReviewedMemory(input: MemoryReviewDeleteInput, visible?: (path: string) => boolean): { ok: boolean; error?: string } {
  try {
    if (visible && !visible(input.path)) return { ok: false, error: "记忆不属于本项目或显式全局范围;agent 只能整理当前项目的记忆。" };
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
