import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { spawnRun, type SpawnRunOptions, type SpawnRunResult } from "@main/lib/spawnRun.js";
import type { MarketProgress } from "@contracts/ipc";

export type MarketProgressSink = (progress: Omit<MarketProgress, "requestId">) => void;
export const MARKET_CLONE_TIMEOUT_MS = 15 * 60_000;
export const MARKET_CLONE_IDLE_MS = 3 * 60_000;
const PROXY_REFUSED = /Failed to connect to (?:127\.0\.0\.1|localhost|\[?::1\]?)\s*port/i;

export function safeGitMessage(text: string): string {
  return text.replace(/https?:\/\/[^\s'"<>]+/gi, value => {
    try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; }
    catch { return "[URL]"; }
  }).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** Streaming output, bounded tail, tree cancellation and decoding reuse the
 * existing process runner. No shell interpolation or credential discovery. */
export async function cloneMarketRepository(url: string, destination: string, branch?: string, progress?: MarketProgressSink,
  test: { run?: (opts: SpawnRunOptions) => Promise<SpawnRunResult>; timeoutMs?: number; idleMs?: number } = {},
): Promise<void> {
  const timeoutMs = test.timeoutMs ?? MARKET_CLONE_TIMEOUT_MS;
  const idleMs = test.idleMs ?? MARKET_CLONE_IDLE_MS;
  const started = Date.now();
  const emit = (message: string) => { try { progress?.({ phase: "clone", message: safeGitMessage(message).slice(-500), elapsedMs: Date.now() - started, timeoutMs }); } catch { /* closed renderer */ } };
  async function attempt(noProxy: boolean): Promise<{ result: SpawnRunResult; idle: boolean }> {
    const controller = new AbortController();
    let lastOutput = Date.now(), idle = false, message = noProxy ? "本机代理连接被拒绝，正在尝试直连 / Retrying without unavailable local proxy" : "连接仓库 / Connecting to repository";
    const decoder = new StringDecoder("utf8");
    let tail = "";
    const chunk = (bytes: Buffer) => {
      lastOutput = Date.now();
      tail = (tail + decoder.write(bytes)).slice(-4000);
      message = tail.split(/[\r\n]/).filter(Boolean).at(-1) ?? message;
    };
    emit(message);
    const heartbeat = setInterval(() => {
      emit(message);
      if (!idle && Date.now() - lastOutput >= idleMs) { idle = true; controller.abort(); }
    }, Math.min(1000, Math.max(10, idleMs / 2)));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" };
      if (noProxy) for (const key of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(key)) delete env[key];
      const result = await (test.run ?? spawnRun)({ command: "git", args: [
        ...(noProxy ? ["-c", "http.proxy=", "-c", "https.proxy="] : []),
        "clone", "--depth", "1", "--progress", ...(branch ? ["--branch", branch] : []), "--", url, destination,
      ], env, timeoutMs, signal: controller.signal, rawOutput: true, limitBytes: 16_384, onStderrChunk: chunk, onStdoutChunk: () => { lastOutput = Date.now(); } });
      emit(message);
      return { result, idle };
    } finally { clearInterval(heartbeat); }
  }
  let attemptResult = await attempt(false);
  const failed = (r: SpawnRunResult) => r.code !== 0 || !!r.spawnError || r.killedBy.timeout || r.killedBy.abort;
  if (failed(attemptResult.result) && !attemptResult.idle && !attemptResult.result.killedBy.timeout && PROXY_REFUSED.test(attemptResult.result.stderr)) {
    // Only explicit refusal of a local proxy permits the existing fallback.
    await fs.rm(destination, { recursive: true, force: true });
    attemptResult = await attempt(true);
  }
  const { result, idle } = attemptResult;
  if (!failed(result)) return;
  const tail = safeGitMessage(result.stderr || result.stdout || "").trim().slice(-1200);
  const elapsed = Math.round((Date.now() - started) / 1000);
  const reason = idle ? `连续 ${Math.round(idleMs / 1000)} 秒没有传输输出 / no progress timeout`
    : result.killedBy.timeout ? `达到 ${Math.round(timeoutMs / 60_000)} 分钟总时限 / total timeout`
    : (result.spawnError as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "找不到 Git，请先安装 Git / Git not found"
    : result.spawnError ? safeGitMessage(result.spawnError.message)
    : `退出码 ${result.code ?? "无"}，信号 ${result.signal ?? "无"} / process failed`;
  throw new Error(`克隆失败：${reason}；已用 ${elapsed}s。${tail ? `\n${tail}` : " Git 未提供错误输出。"}`);
}

/** Promote a validated staging tree. Rename failure must not destroy the old
 * catalog; neither a network failure nor a bad manifest empties the market. */
export async function promoteMarketCatalog(staging: string, destination: string): Promise<void> {
  const backup = `${destination}.old-${randomUUID()}`;
  let backedUp = false;
  try { await fs.rename(destination, backup); backedUp = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { await fs.rename(staging, destination); }
  catch (error) { if (backedUp) await fs.rename(backup, destination); throw error; }
  if (backedUp) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
}
