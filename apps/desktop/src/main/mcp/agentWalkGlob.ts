/**
 * `agentTools` 的**目录遍历与 glob**（从 `agentTools.ts` 拆出）。
 *
 * `walkFiles` 是 `agent_glob` / `agent_grep` 共用的递归收集器；`globToRegExp` /
 * `splitGlobPrefix` / `globWantsHidden` / `escapeRegExp` 是它的模式匹配；
 * `WalkHit` / `WalkOptions` / `WalkResult` / `WalkSkips` 是这些函数的形状；
 * `createWalkSkips` / `walkSkipText` / `walkSkipFields` / `walkErrnoText` / `emptyWalk`
 * 是「没搜到的地方怎么如实报出来」（见 `walkFiles` 文档注释里那段 MC-027 说明）。
 * `appendDecoded` / `newDecoder` 在 `agentToolRuntime.ts`（子进程那条链共用）。
 *
 * **纯搬迁，函数体逐字节一致。**
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { SKIP_DIRS } from "./agentSearchSessions.js";

/* ────────────────────────────── 目录遍历 ────────────────────────────── */

/** 递归走目录时的深度与结果上限。 */
export const MAX_WALK_DEPTH = 15;
export const MAX_WALK_RESULTS = 800;
/** 一次遍历最多看多少个目录项 —— 结果上限管不住"走了很久一个都没命中"的情况。 */
export const MAX_WALK_VISITS = 200_000;
/** 【MC-027】一次遍历最多记这么多"没搜到的位置" —— 同 `agentSearchSessions.MAX_SKIPPED_PATHS`。 */
export const MAX_WALK_SKIPPED_PATHS = 50;

export interface WalkHit {
  abs: string;
  rel: string;
  isDir: boolean;
}

export interface WalkOptions {
  canRead?: (absolutePath: string) => boolean;
  /** 只收**文件名**匹配的(grep 的 `glob` 参数,如 `*.md`)。 */
  nameFilter?: RegExp | null;
  /** 只收**相对 root 的路径**(正斜杠)匹配的(agent_glob)。 */
  relFilter?: RegExp | null;
  /** 进不进 `.` 开头的目录/文件。默认不进(同 ripgrep)。 */
  includeHidden?: boolean;
  /** 命中多少个就停,默认 {@link MAX_WALK_RESULTS}。 */
  maxHits?: number;
  /** 【MC-027】外部漏搜登记器 —— grep 传进来,好把随后 readFile 失败也记进同一份。 */
  skips?: WalkSkips;
}

export interface WalkResult {
  hits: WalkHit[];
  /** 撞了命中/访问上限(`MAX_WALK_RESULTS` / `MAX_WALK_VISITS`) —— 是"够多了主动停",
   *  与"漏搜"分开。 */
  truncated: boolean;
  /**
   * 【MC-027】**这次遍历有没有漏搜到地方**(某目录 readdir 失败,或撞了深度上限)。
   * `false` 才是「完整无命中」;`true` 表示结果可能不全,模型不能据此断言目标不存在。
   */
  partial: boolean;
  /** 没能搜到的位置(相对 root,正斜杠),最多 {@link MAX_WALK_SKIPPED_PATHS} 条。 */
  skippedPaths: string[];
  /** 没能搜到的位置总数(不限 {@link MAX_WALK_SKIPPED_PATHS})。 */
  skippedCount: number;
}

export interface WalkSkips {
  record: (abs: string, reason: string) => void;
  snapshot: () => { partial: boolean; skippedPaths: string[]; skippedCount: number };
}

/** 【MC-027】walkFiles 里"没能搜到的位置"的登记器 —— 语义同 `agentSearchSessions.recordSkip`:
 *  置 `partial`、`skippedCount` 记全量、`skippedPaths` 去重并限 {@link MAX_WALK_SKIPPED_PATHS} 条。
 *  导出式累加器,好让 `agent_grep` 把"遍历漏搜"与"随后 readFile 失败"记进同一份。 */
export function createWalkSkips(root: string): WalkSkips {
  let partial = false;
  let skippedCount = 0;
  const skippedPaths: string[] = [];
  return {
    record(abs, reason) {
      partial = true;
      skippedCount += 1;
      const rel = path.relative(root, abs).replace(/\\/g, "/") || ".";
      if (skippedPaths.length >= MAX_WALK_SKIPPED_PATHS) return;
      const entry = reason ? `${rel} (${reason})` : rel;
      if (!skippedPaths.includes(entry)) skippedPaths.push(entry);
    },
    snapshot() {
      return { partial, skippedPaths: skippedPaths.slice(), skippedCount };
    },
  };
}

/** 【MC-027】把常见 OS 读错误翻成一句人话 —— 与 `agentSearchSessions.errnoText` 同一口径。 */
export function walkErrnoText(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return "没有读取权限";
  if (code === "ENOENT") return "已被删除";
  return code ?? (err instanceof Error ? err.message : String(err));
}

/** 【MC-027】遍历漏搜的**结构化字段** —— `agent_grep`/`agent_glob` 两个读口共用一份形状。 */
export function walkSkipFields(w: WalkResult): { partial: boolean; skipped_count: number; skipped_paths: string[] } {
  return { partial: w.partial, skipped_count: w.skippedCount, skipped_paths: w.skippedPaths };
}

/** 【MC-027】遍历漏搜的**人话警告** —— 与 `formatSearchResult` 那条同口径。 */
export function walkSkipText(w: WalkResult, empty: boolean): string {
  if (!w.partial) return "";
  return (
    `\n⚠️ 本次搜索**不完整**:有 ${w.skippedCount} 个位置(目录或文件)没能搜到,结果可能不全;` +
    (empty ? "「没有结果」不能当作「不存在」。" : "请勿据此断言目标不存在。")
  );
}

/** 一个没有任何命中、也没有任何漏搜的遍历结果。 */
export function emptyWalk(): WalkResult {
  return { hits: [], truncated: false, partial: false, skippedPaths: [], skippedCount: 0 };
}

/**
 * 从 `root` 往下递归收集文件,跳过 {@link SKIP_DIRS}、隐藏项(除非 includeHidden)与超深分支。
 *
 * ⚠️ **过滤必须在遍历里做,上限只数命中的。** 从前是先收前 800 个文件、再在外面按模式
 * 过滤 —— 项目根下随便一个缓存目录就把 800 个名额占满,`**\/foo.ts` 明明存在也回
 * "没有匹配",grep 也只扫了前 800 个文件就说没找到(而且都不说自己没搜完)。
 * 现在命中数和访问数各有上限,撞上了就如实报 `truncated`。
 *
 * 【MC-027】`truncated` **只**反映上面那两种上限(主动停);目录 readdir 失败、深度上限
 * 这类**被动漏搜**另记 `partial`/`skippedPaths`/`skippedCount` —— 从前 readdir 失败是
 * `catch { return; }` 静默跳过,坏掉的子树被当成"空",`agent_grep`/`agent_glob` 就把
 * 部分结果报成了完整。
 */
export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const hits: WalkHit[] = [];
  const maxHits = opts.maxHits ?? MAX_WALK_RESULTS;
  const skips = opts.skips ?? createWalkSkips(root);
  let visited = 0;
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    // 【MC-027】深度上限:这一层往下不再走,如实记成"没搜到的地方",不当成"不存在"。
    if (depth > MAX_WALK_DEPTH) {
      skips.record(dir, "超出遍历深度上限");
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // 【MC-027】readdir 失败(无权限 / 已被删…)。从前静默 `return`、子树被当成"空",
      // 结果里少了文件却仍标"完整" —— 假完整。现在**显式登记这棵子树没搜到**,但不抛:
      // 一个好目录搜不了不该瘫痪其余正常子树。
      skips.record(dir, walkErrnoText(err));
      return;
    }
    for (const entry of entries) {
      if (hits.length >= maxHits || visited >= MAX_WALK_VISITS) {
        truncated = true;
        return;
      }
      visited += 1;
      if (!opts.includeHidden && entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (opts.canRead && !opts.canRead(abs)) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(abs, depth + 1);
        if (truncated) return;
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (opts.nameFilter && !opts.nameFilter.test(entry.name)) continue;
      const rel = path.relative(root, abs);
      if (opts.relFilter && !opts.relFilter.test(rel.replace(/\\/g, "/"))) continue;
      hits.push({ abs, rel, isDir: false });
    }
  };
  await walk(root, 0);
  return { hits, truncated, ...skips.snapshot() };
}

/** glob 里不带通配符的前导目录段(`src/main/*.ts` → `src/main`),用来把遍历起点挪进去。 */
export function splitGlobPrefix(pattern: string): { prefix: string; rest: string } {
  const segs = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  let i = 0;
  while (i < segs.length - 1 && segs[i] !== "" && !/[*?[\]{}]/.test(segs[i]!)) i += 1;
  return { prefix: segs.slice(0, i).join("/"), rest: segs.slice(i).join("/") };
}

/** 模式里明确写了 `.` 开头的段(`.github/**`、`.env`)就说明要看隐藏项。 */
export function globWantsHidden(pattern: string): boolean {
  return pattern
    .replace(/\\/g, "/")
    .split("/")
    .some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..");
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 一个够用的 glob → RegExp:支持 `**`(跨段)、`*`/`?`(段内),`/` 统一成正斜杠。
 * 不追求完整 glob 语义 —— 模型用的是"找某个名字的文件"这类粗模式,这里覆盖的就是它。
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/\\/g, "/");
  let re = "";
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        // `**/` 或段内 `**` 都按"跨任意层级"处理
        i += 2;
        if (normalized[i] === "/") i += 1;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${re}$`, "i");
}
