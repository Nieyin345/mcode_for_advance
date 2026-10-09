import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

export type AgentSearchType = "files" | "content";
export type AgentSearchStatus = "running" | "completed" | "stopped" | "error";

const MAX_SEARCH_SESSIONS_PER_OWNER = 12;
const MAX_STORED_RESULTS = 5_000;
const MAX_RESULT_LINE_CHARS = 500;
const COMPLETED_TTL_MS = 10 * 60_000;
/**
 * 遍历项目时**不往里走**的目录名 —— **唯一一份**。
 *
 * `agent_search_start`(本文件)与 `agent_grep`/`agent_glob`(`agentTools.walkFiles`)判的
 * 是同一件事("哪些目录不值得进去"),从前两处各写一份、**已经漂了**:`agentTools` 那份多了
 * `coverage`。于是同一个项目里 `agent_search` 会翻进 `coverage/lcov-report/` 报生成产物里的
 * 命中,而 `agent_grep` 不会 —— 同一件事两个答案,还可能把 `max_results`/扫描预算耗在产物上。
 * 导出这一份,`agentTools` 直接引用。
 */
export const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "out", "coverage"]);

interface SearchSession {
  id: string;
  ownerSessionId: string;
  type: AgentSearchType;
  pattern: string;
  root: string;
  status: AgentSearchStatus;
  results: string[];
  maxResults: number;
  scannedFiles: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  stopped: boolean;
}

export interface AgentSearchReadResult {
  searchId: string;
  status: AgentSearchStatus;
  results: string[];
  offset: number;
  nextOffset: number;
  totalResults: number;
  scannedFiles: number;
  error: string | null;
}

export interface AgentSearchListItem {
  searchId: string;
  status: AgentSearchStatus;
  type: AgentSearchType;
  pattern: string;
  root: string;
  totalResults: number;
  scannedFiles: number;
  startedAt: number;
}

export interface AgentSearchSessions {
  start(input: {
    ownerSessionId: string;
    type: AgentSearchType;
    pattern: string;
    root: string;
    literalSearch?: boolean;
    ignoreCase?: boolean;
    filePattern?: string;
    includeHidden?: boolean;
    canRead?: (absolutePath: string) => boolean;
    contextLines?: number;
    maxResults?: number;
    waitMs?: number;
    firstPageLength?: number;
  }): Promise<AgentSearchReadResult>;
  read(input: {
    ownerSessionId: string;
    searchId: string;
    offset?: number;
    length?: number;
    waitMs?: number;
  }): Promise<AgentSearchReadResult>;
  stop(ownerSessionId: string, searchId: string): AgentSearchReadResult;
  list(ownerSessionId: string): AgentSearchListItem[];
  /** The owning conversation is gone: stop its running searches and drop all
   *  of its entries now instead of waiting for a later start/list prune. */
  disposeOwner(ownerSessionId: string): void;
}

export function createAgentSearchSessions(): AgentSearchSessions {
  const sessions = new Map<string, SearchSession>();

  function prune(ownerSessionId: string): void {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.status !== "running" && s.finishedAt && now - s.finishedAt > COMPLETED_TTL_MS) sessions.delete(id);
    }
    const mine = [...sessions.values()]
      .filter((s) => s.ownerSessionId === ownerSessionId)
      .sort((a, b) => a.startedAt - b.startedAt);
    while (mine.length >= MAX_SEARCH_SESSIONS_PER_OWNER) {
      const old = mine.shift();
      if (!old) break;
      if (old.status === "running") old.stopped = true;
      sessions.delete(old.id);
    }
  }

  function owned(ownerSessionId: string, searchId: string): SearchSession {
    const s = sessions.get(searchId);
    if (!s) throw new Error(`没有这个搜索会话:${searchId}`);
    if (s.ownerSessionId !== ownerSessionId) throw new Error(`搜索会话 ${searchId} 不属于当前对话`);
    return s;
  }

  function page(s: SearchSession, offset = 0, length = 100): AgentSearchReadResult {
    const start = Math.max(0, offset);
    const size = Math.max(1, Math.min(length, 500));
    const results = s.results.slice(start, start + size);
    return {
      searchId: s.id,
      status: s.status,
      results,
      offset: start,
      nextOffset: start + results.length,
      totalResults: s.results.length,
      scannedFiles: s.scannedFiles,
      error: s.error,
    };
  }

  async function waitForProgress(s: SearchSession, baseline: number, waitMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, 5_000));
    while (Date.now() < deadline && s.status === "running" && s.results.length <= baseline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  return {
    async start(input) {
      prune(input.ownerSessionId);
      const matcher = buildMatcher(input.pattern, input.literalSearch ?? false, input.ignoreCase ?? true);
      const fileMatcher = input.filePattern ? globToRegExp(input.filePattern) : null;
      const state: SearchSession = {
        id: `search_${randomBytes(6).toString("hex")}`,
        ownerSessionId: input.ownerSessionId,
        type: input.type,
        pattern: input.pattern,
        root: input.root,
        status: "running",
        results: [],
        maxResults: Math.max(1, Math.min(input.maxResults ?? 1_000, MAX_STORED_RESULTS)),
        scannedFiles: 0,
        startedAt: Date.now(),
        finishedAt: null,
        error: null,
        stopped: false,
      };
      sessions.set(state.id, state);
      void runSearch(state, {
        matcher,
        fileMatcher,
        canRead: input.canRead,
        includeHidden: input.includeHidden ?? false,
        contextLines: Math.max(0, Math.min(input.contextLines ?? 0, 5)),
      });
      await waitForProgress(state, 0, input.waitMs ?? 250);
      return page(state, 0, input.firstPageLength ?? 50);
    },

    async read(input) {
      const s = owned(input.ownerSessionId, input.searchId);
      const offset = Math.max(0, input.offset ?? 0);
      await waitForProgress(s, offset, input.waitMs ?? 0);
      return page(s, offset, input.length ?? 100);
    },

    stop(ownerSessionId, searchId) {
      const s = owned(ownerSessionId, searchId);
      if (s.status === "running") {
        s.stopped = true;
        s.status = "stopped";
        s.finishedAt = Date.now();
      }
      return page(s, 0, 100);
    },

    list(ownerSessionId) {
      prune(ownerSessionId);
      return [...sessions.values()]
        .filter((s) => s.ownerSessionId === ownerSessionId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((s) => ({
          searchId: s.id,
          status: s.status,
          type: s.type,
          pattern: s.pattern,
          root: s.root,
          totalResults: s.results.length,
          scannedFiles: s.scannedFiles,
          startedAt: s.startedAt,
        }));
    },

    disposeOwner(ownerSessionId) {
      for (const [id, s] of [...sessions]) {
        if (s.ownerSessionId !== ownerSessionId) continue;
        if (s.status === "running") s.stopped = true;
        sessions.delete(id);
      }
    },
  };
}

async function runSearch(
  state: SearchSession,
  opts: {
    matcher: (value: string) => boolean;
    fileMatcher: RegExp | null;
    canRead?: (absolutePath: string) => boolean;
    includeHidden: boolean;
    contextLines: number;
  },
): Promise<void> {
  try {
    if (opts.canRead && !opts.canRead(state.root)) throw new Error("搜索起点不可读");
    const st = await fs.stat(state.root);
    if (st.isFile()) {
      await visitFile(state, state.root, path.basename(state.root), opts);
    } else if (st.isDirectory()) {
      await walkDir(state, state.root, state.root, opts, 0);
    } else {
      throw new Error(`搜索起点不是普通文件或目录:${state.root}`);
    }
    if (state.status === "running") state.status = state.stopped ? "stopped" : "completed";
  } catch (err) {
    if (state.status === "running") {
      state.status = "error";
      // **给模型看的句子要说人话。** 这条 `error` 经 `page()` 原样回到模型手上
      // (`agent_search_read` 的 `error` 字段)。`fs.stat` 在起点不存在/不可读时抛的是
      // 原始英文 OS 错误(`ENOENT: no such file or directory, stat '…'`),而孪生的
      // `agent_grep` 在同一个处境给的是「路径不存在:…」。翻译常见那几种,其余原样保留
      // (至少比吞掉强) —— 与 `agent_grep` 一条口径。
      const code = (err as NodeJS.ErrnoException)?.code;
      state.error =
        code === "ENOENT"
          ? `搜索起点不存在:${state.root}`
          : code === "EACCES" || code === "EPERM"
            ? `搜索起点没有读取权限:${state.root}`
            : code === "ENOTDIR"
              ? `搜索起点不是目录:${state.root}`
              : err instanceof Error
                ? err.message
                : String(err);
    }
  } finally {
    state.finishedAt = Date.now();
  }
}

async function walkDir(
  state: SearchSession,
  root: string,
  dir: string,
  opts: { canRead?: (absolutePath: string) => boolean; matcher: (value: string) => boolean; fileMatcher: RegExp | null; includeHidden: boolean; contextLines: number },
  depth: number,
): Promise<void> {
  if (state.stopped || state.results.length >= state.maxResults || depth > 30) return;
  if (opts.canRead && !opts.canRead(dir)) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (state.stopped || state.results.length >= state.maxResults) return;
    if (!opts.includeHidden && entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    if (opts.canRead && !opts.canRead(abs)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkDir(state, root, abs, opts, depth + 1);
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    await visitFile(state, abs, rel, opts);
  }
}

async function visitFile(
  state: SearchSession,
  abs: string,
  rel: string,
  opts: { canRead?: (absolutePath: string) => boolean; matcher: (value: string) => boolean; fileMatcher: RegExp | null; includeHidden: boolean; contextLines: number },
): Promise<void> {
  if (opts.canRead && !opts.canRead(abs)) return;
  if (opts.fileMatcher && !opts.fileMatcher.test(rel)) return;
  state.scannedFiles += 1;
  if (state.type === "files") {
    if (opts.matcher(path.basename(rel)) || opts.matcher(rel)) state.results.push(rel);
    return;
  }

  const fd = await fs.open(abs, "r").catch(() => null);
  if (!fd) return;
  try {
    const stat = await fd.stat();
    const head = Buffer.alloc(Math.min(stat.size, 8192));
    if (head.length > 0) await fd.read(head, 0, head.length, 0);
    if (head.includes(0)) return;
  } finally {
    await fd.close();
  }

  const before: Array<{ n: number; text: string }> = [];
  const pending: Array<{ n: number; lines: string[]; remaining: number }> = [];
  const rl = createInterface({ input: createReadStream(abs, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const raw of rl) {
    if (state.stopped || state.results.length + pending.length >= state.maxResults) break;
    lineNo += 1;
    const line = String(raw);

    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const p = pending[i]!;
      if (p.remaining <= 0) continue;
      p.lines.push(`${lineNo}: ${clip(line)}`);
      p.remaining -= 1;
      if (p.remaining === 0) {
        state.results.push(`${rel}:${p.n}\n${p.lines.join("\n")}`);
        pending.splice(i, 1);
      }
    }

    if (opts.matcher(line) && state.results.length + pending.length < state.maxResults) {
      const lines = [
        ...before.map((b) => `${b.n}: ${clip(b.text)}`),
        `${lineNo}: ${clip(line)}`,
      ];
      if (opts.contextLines === 0) state.results.push(`${rel}:${lineNo}: ${clip(line)}`);
      else pending.push({ n: lineNo, lines, remaining: opts.contextLines });
    }

    before.push({ n: lineNo, text: line });
    while (before.length > opts.contextLines) before.shift();
  }
  for (const p of pending) {
    if (state.results.length >= state.maxResults) break;
    state.results.push(`${rel}:${p.n}\n${p.lines.join("\n")}`);
  }
}

function buildMatcher(pattern: string, literal: boolean, ignoreCase: boolean): (value: string) => boolean {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (value) => (ignoreCase ? value.toLowerCase() : value).includes(needle);
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (err) {
    throw new Error(`pattern 不是合法正则:${err instanceof Error ? err.message : String(err)}`);
  }
  return (value) => re.test(value);
}

function clip(value: string): string {
  return value.length > MAX_RESULT_LINE_CHARS ? `${value.slice(0, MAX_RESULT_LINE_CHARS)}…` : value;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        i += 1;
        if (normalized[i + 1] === "/") i += 1;
        re += "(?:.*/)?";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}
