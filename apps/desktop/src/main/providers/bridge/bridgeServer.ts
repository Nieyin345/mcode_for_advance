/**
 * Local HTTP server that impersonates an Anthropic `/v1/messages` endpoint.
 *
 * The Claude binary is pointed at this server via `ANTHROPIC_BASE_URL`. It
 * receives Anthropic-formatted POST bodies, translates each to OpenAI's
 * `/v1/chat/completions` format, forwards to the real upstream, and streams
 * the OpenAI SSE response back re-translated into Anthropic SSE.
 *
 * ## Lifecycle
 *
 * Created lazily per upstream config and owned by {@link BridgeRegistry}
 * (which reference-counts so multiple sessions on the same config share one
 * server). `close()` stops listening and frees the port; outstanding requests
 * are left to finish or time out on their own (the registry only closes on
 * config release or app shutdown).
 *
 * ## Why a fresh port per server
 *
 * `listen(0)` lets the OS hand back a free ephemeral port, so we never clash
 * with anything the user is running, and never need a config knob. "Free" is
 * not the same as "usable", though — see `lib/loopbackPort.ts` for why the
 * bind is retried until the draw is one clients will actually dial.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { log } from "@main/lib/logger.js";
import { isBlockedPort, listenOnDialablePort } from "@main/lib/loopbackPort.js";
import {
  hasHeader,
  requiresSessionHeader,
  resolveUpstreamHeaders,
  SESSION_HEADER,
} from "@main/providers/upstreamHeaders.js";
import { anthropicToOpenAI } from "./requestTranslator.js";
import { OpenAiToAnthropicSse } from "./responseTranslator.js";
// 纯函数（只认一个请求头），静态 import 是安全的 —— 它不拉 electron，理由同 webUpstream
// 那条动态 import 的注释。
import { sessionIdOf } from "./mcpEndpoint.js";
import type {
  AnthropicRequest,
  AnthropicSseEvent,
  OpenAIChunk,
  OpenAIRequest,
  UpstreamConfig,
} from "./types.js";

/** Transient upstream-transport status, surfaced to subscribers via
 *  {@link BridgeHandle.onStatus} so the UI can show "上游连接异常,正在重试…"
 *  instead of an unexplained spinner. */
export interface BridgeStatus {
  kind: "retry" | "ok";
  /** Readable transport cause (see describeFetchError); empty for "ok". */
  cause: string;
  attempt: number;
  attempts: number;
}

/** A handle to a running bridge server. */
export interface BridgeHandle {
  /** The local URL the Claude binary should use as ANTHROPIC_BASE_URL. */
  readonly localUrl: string;
  /** An opaque token the binary sends back; the server accepts any value —
   *  this exists only so the env-var contract (`ANTHROPIC_AUTH_TOKEN`) is
   *  satisfied. The real upstream credential is held inside the server. */
  readonly routeToken: string;
  /** Subscribe to transient upstream-transport status (retry loop). The
   *  returned function unsubscribes. Statuses are informational only — the
   *  bridge proceeds identically with or without subscribers. */
  onStatus(cb: (s: BridgeStatus) => void): () => void;
  /** Stop listening. Idempotent. */
  close(): void;
}

/** Whether an upstream base URL looks like an Azure OpenAI deployment.
 *  Azure uses a different path shape and the `api-key` header (not Bearer). */
function looksLikeAzure(baseUrl: string): boolean {
  return /azure\.com/i.test(baseUrl);
}

/** Pull a readable cause out of a Node/undici fetch failure.
 *
 * `fetch()` rejects with a `TypeError` whose `.message` is always the opaque
 * string `"fetch failed"` — useless for diagnosis. The real reason lives on
 * `.cause` as `{ code, message }` (e.g. `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`,
 * `ECONNRESET`). This unwraps it so logs and the error sent back to the user
 * name the actual failure instead of "fetch failed".
 *
 * Also collapses AbortController aborts (client disconnect or our timeout) into
 * a clear "aborted" string rather than surfacing undici's "aborted" / "The user
 * aborted a request" verbatim. */
function describeFetchError(err: unknown): string {
  const e = err as {
    name?: string;
    message?: string;
    cause?: { code?: string; name?: string; message?: string };
  };
  // AbortError surfaces directly (not nested under .cause) when the signal fires.
  if (e?.name === "AbortError" || /abort/i.test(e?.message ?? "")) {
    return "aborted (client disconnect or request timeout)";
  }
  const cause = e?.cause;
  const code = cause?.code || cause?.name;
  if (code) return `${code}: ${cause?.message ?? e?.message ?? "unknown"}`;
  return e?.message || String(err);
}

/** Transport-layer error codes worth a single retry. These are transient by
 *  nature — the connection died mid-flight or a public-IP route flapped — so one
 *  short retry can self-heal without masking a real outage. HTTP status errors
 *  (4xx/5xx) are NOT retried: they carry endpoint semantics (auth, model, quota)
 *  and live on a different code path. */
const RETRYABLE_FETCH_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

function isRetryableFetchError(err: unknown): boolean {
  const code = (err as { cause?: { code?: string; name?: string } })?.cause?.code;
  if (code && RETRYABLE_FETCH_CODES.has(code)) return true;
  // Fall back to a string match on the readable cause — covers variants that
  // only populate .name or surface the code in the message.
  return /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|CONNECT_TIMEOUT|SOCKET|UND_ERR_CLOSED/i.test(
    describeFetchError(err),
  );
}

/** Fetch the upstream with one bounded retry on transient transport failures.
 *
 * Waits {@link backoffMs} before the second attempt; honors `signal` so a client
 * disconnect or timeout aborts immediately rather than sleeping pointlessly.
 * Returns the first successful Response, or throws the last error. Transport
 * retries are reported through `onStatus` (informational — the loop runs the
 * same with or without a subscriber) so the UI can explain a mid-turn stall. */
async function fetchUpstreamWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  onStatus?: (s: BridgeStatus) => void,
  attempts = 2,
  backoffMs = 500,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal.aborted) throw new Error("aborted before fetch");
    try {
      const res = await fetch(url, { ...init, signal });
      // A request that needed retries finally went through — tell
      // subscribers the stall is over (they clear the retry hint).
      if (attempt > 1) onStatus?.({ kind: "ok", cause: "", attempt, attempts });
      return res;
    } catch (err) {
      lastErr = err;
      const cause = describeFetchError(err);
      if (attempt < attempts && isRetryableFetchError(err)) {
        log.warn(`bridge: upstream fetch attempt ${attempt}/${attempts} failed (${cause}); retrying in ${backoffMs}ms`);
        onStatus?.({ kind: "retry", cause, attempt, attempts });
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, backoffMs);
          // If the client disconnects mid-backoff, stop waiting immediately.
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Read and JSON-parse an incoming request body, with a size guard. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const LIMIT = 32 * 1024 * 1024; // 32 MB guard against runaway bodies
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Build the upstream request headers (auth differs between OpenAI & Azure),
 *  then layer the endpoint's own headers on top — the same set the direct
 *  (anthropic-protocol) path puts on `ANTHROPIC_CUSTOM_HEADERS`, so both paths
 *  are byte-identical from the gateway's point of view. See
 *  {@link ../../upstreamHeaders.ts} for the shared policy (sanitizing, and the
 *  auto session id for gateways that reject requests without one).
 *
 *  User headers are applied LAST and may therefore override the derived
 *  Content-Type / Authorization — deliberate: a gateway that wants a custom
 *  auth scheme is exactly the case this field exists for.
 *
 *  NOTE: we deliberately do NOT set `Content-Length`. When the body passed to
 *  `fetch()` is a string (or Buffer/TypedArray), undici computes it itself.
 *  Setting it manually triggers `UND_ERR_INVALID_ARG: invalid content-length
 *  header` on the undici 6.x bundled with Electron 33 (Node 20) — undici
 *  validates a user-supplied Content-Length against its own derivation and
 *  rejects the mismatch. Omitting it lets undici own the value, which is both
 *  correct and what every other caller does. */
function upstreamHeaders(upstream: UpstreamConfig, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (looksLikeAzure(upstream.baseUrl)) {
    // Azure OpenAI: `api-key` header, and api-version comes as a query param
    // (added in buildUpstreamUrl).
    headers["api-key"] = upstream.authToken;
  } else {
    // Standard OpenAI / OpenAI-compatible: Bearer token. Both authMode values
    // (auth_token / api_key) map to Bearer here — the distinction only mattered
    // for the Anthropic env vars; on the OpenAI wire it's always Bearer.
    headers["Authorization"] = `Bearer ${upstream.authToken}`;
  }
  return { ...headers, ...resolveUpstreamHeaders(upstream.customHeaders, upstream.baseUrl, sessionId) };
}

/** Build the full upstream URL, normalizing the path and adding Azure's
 *  api-version query param when applicable. */
function buildUpstreamUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (looksLikeAzure(baseUrl)) {
    // Azure deployments are addressed as {base}/openai/deployments/{deployment}
    // and require `?api-version=`. We assume the user's baseUrl already points
    // at a chat completions path (or the deployment root); we just ensure the
    // version is present and the path ends in /chat/completions.
    const sep = trimmed.includes("?") ? "&" : "?";
    const withVersion = trimmed.includes("api-version=")
      ? trimmed
      : `${trimmed}${sep}api-version=2024-10-21`;
    return withVersion.replace(/\/?$/, "/chat/completions");
  }
  // OpenAI-compatible: ensure it ends at /v1/chat/completions. If the user
  // already included the full path, leave it; if they stopped at /v1, append
  // the rest; otherwise add the whole /v1/chat/completions suffix.
  if (/\/v1\/chat\/completions\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  if (/\/v1\/?$/i.test(trimmed)) {
    return `${trimmed.replace(/\/+$/, "")}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

/** Write one Anthropic SSE event to the response, framed as
 *  `event: <type>\ndata: <json>\n\n`. */
function writeSseEvent(res: ServerResponse, ev: AnthropicSseEvent): void {
  res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

/** Send a minimal Anthropic-shaped error back to the binary. We use a 400 with
 *  an `error` JSON body so the SDK surfaces a readable message. */
function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    if (!res.destroyed) writeSseEvent(res, { type: "error", error: { type: "api_error", message } });
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      type: "error",
      error: { type: "bridge_error", message },
    }),
  );
}

/** Handle a single `/v1/messages` POST: translate → forward → stream back.
 *
 *  `sessionId` names the upstream's required session header when it wants one
 *  (see {@link startBridge} for why it is the bridge's id and not a session's). */
async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: UpstreamConfig,
  sessionId: string,
  onStatus?: (s: BridgeStatus) => void,
): Promise<void> {
  let body: AnthropicRequest;
  try {
    const parsed = (await readJsonBody(req)) as AnthropicRequest;
    body = parsed;
  } catch (err) {
    sendError(res, 400, `invalid request body: ${(err as Error).message}`);
    return;
  }

  // 网页版上游走一条完全不同的路：不转发 HTTP，而是把消息交给用户浏览器里的扩展
  // （webUpstream → extensionBridge）。在这里就分出去 —— 下面的 OpenAI 转换与上游
  // fetch 对它都没有意义。
  if (upstream.protocol === "web") {
    // **动态加载**：网页这条路只有配了网页端配置的会话才走到，没必要让每次启动都
    // 把它那一串（契约 + 日志 + 本地服务）拉进常驻依赖图。它现在不含 electron 依赖，
    // 但这个习惯留着 —— 上一版的网页上游正是靠它才没把无头 smoke 炸掉。
    const { handleWebMessages } = await import("./webUpstream.js");
    // 会话 id 是 CLI 那边通过 `MCODE_SESSION_HEADER` 带进来的（见 customEnv.ts）。
    // 只有网页这条路需要它 —— 扩展得知道"这次工具调用属于哪次对话"才能回头走审批闸门。
    // 上面那条 OpenAI 转发不吃它：`upstreamHeaders` 是重新拼的，请求头不会漏到上游。
    await handleWebMessages(req, res, body, upstream, sessionIdOf(req));
    return;
  }

  const openaiReq: OpenAIRequest = anthropicToOpenAI(body);
  // Per-request size diagnostics: the CLI→bridge body is the ground truth for
  // "what did we actually ask the gateway to count". When the gateway's
  // reported input_tokens for consecutive turns diverges wildly from the
  // growth of this body (e.g. "你好" turn 1 = 54k, turn 2 = 80k with a
  // ~2k-token delta of real conversation), this line decides whether the CLI
  // really sent more (body grew) or the gateway over-counted (body stable).
  // system/tools chars also expose prefix-cache breakage: if tools/system
  // bytes differ between turns, the upstream's implicit prefix cache (proven
  // to work on sensenova: 2nd request with identical prefix got
  // cache_read=25600) can never hit — which is exactly what the real
  // sessions show (cache_read=0 every turn).
  {
    const sysLen = typeof body.system === "string"
      ? body.system.length
      : Array.isArray(body.system)
        ? body.system.reduce((n, b) => n + (b.text?.length ?? 0), 0)
        : 0;
    const toolsLen = body.tools ? JSON.stringify(body.tools).length : 0;
    const msgsLen = JSON.stringify(body.messages).length;
    log.info(
      `bridge: req msgs=${body.messages.length}(${msgsLen}c) system=${sysLen}c tools=${body.tools?.length ?? 0}(${toolsLen}c) model=${body.model}`,
    );
  }
  // Observability for image turns: count the image_url parts we forward so a
  // gateway that silently drops them (non-vision model behind an OpenAI-
  // protocol endpoint) is diagnosable from main.log — the app-side chain is
  // proven complete when this line shows a non-zero count.
  const imageParts = openaiReq.messages.reduce(
    (n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").length : 0),
    0,
  );
  if (imageParts > 0) {
    log.info(`bridge: forwarding ${imageParts} image part(s) to upstream (${buildUpstreamUrl(upstream.baseUrl)})`);
  }
  // Always stream upstream and re-frame on our side — even non-streaming
  // Anthropic requests can be served from a streaming OpenAI response (we'd
  // just collect the deltas). For the POC we forward stream as-is.
  openaiReq.stream = true;
  // OpenAI only includes `usage` in the final streaming chunk when explicitly
  // asked; without it the bridge never sees token counts, so the context ring
  // in the composer stays empty. Most OpenAI-compatible endpoints honor this
  // flag; those that don't simply omit usage and the ring degrades to its
  // (empty) fallback — same as before.
  openaiReq.stream_options = { include_usage: true };

  const upstreamUrl = buildUpstreamUrl(upstream.baseUrl);
  const jsonBody = JSON.stringify(openaiReq);
  const ac = new AbortController();
  const timer = upstream.timeoutMs
    ? setTimeout(() => ac.abort(), upstream.timeoutMs).unref() : undefined;
  // IncomingMessage.close is request-body completion, not response disconnect.
  const onClose = (): void => { if (!res.writableEnded) ac.abort(); };
  res.once("close", onClose);
  const cleanup = (): void => { clearTimeout(timer); res.off("close", onClose); };

  let upstreamRes: Response;
  try {
    upstreamRes = await fetchUpstreamWithRetry(
      upstreamUrl,
      {
        method: "POST",
        headers: upstreamHeaders(upstream, sessionId),
        body: jsonBody,
      },
      ac.signal,
      onStatus,
    );
  } catch (err) {
    // Use describeFetchError so the real cause (ECONNREFUSED / connect timeout
    // / etc.) surfaces in both the log and the message the user sees — the raw
    // `err.message` is always the opaque "fetch failed".
    const cause = describeFetchError(err);
    log.error(`bridge: upstream fetch failed: ${cause}`);
    cleanup();
    sendError(res, 502, `upstream unreachable: ${cause}`);
    return;
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    // Surface the upstream error text so the user sees auth/model failures.
    const errText = await upstreamRes.text().catch(() => "");
    log.warn(`bridge: upstream ${upstreamRes.status}: ${errText.slice(0, 500)}`);
    cleanup();
    sendError(res, upstreamRes.status || 502, errText.slice(0, 1000) || `upstream ${upstreamRes.status}`);
    return;
  }

  // Stream headers — Anthropic SSE.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const translator = new OpenAiToAnthropicSse();
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let sawDone = false;
  /** 上一块以 \r 结尾:可能是被拆开的 \r\n,先扣着,等下一块再定。 */
  let pendingCR = false;
  /** SSE 允许 \r\n / \r / \n 三种换行(规范如此)。一部分中转/代理用 \r\n ——
   *  只认 "\n\n" 的话一帧都切不出来,流结束后整段又被当成一帧、JSON 解析失败丢掉:
   *  用户等半天,回复是空的。统一成 \n 再切。 */
  const normalizeNewlines = (text: string): string => {
    if (pendingCR) { text = "\r" + text; pendingCR = false; }
    if (text.endsWith("\r")) { pendingCR = true; text = text.slice(0, -1); }
    return text.replace(/\r\n?/g, "\n");
  };

  /** Parse one SSE frame (the text between two blank-line separators) and
   *  feed its data chunk to the translator. Returns how many chunks were
   *  fed (0 for [DONE] / comments). Malformed or error frames must fail the
   *  stream: dropping them can silently discard reasoning/tool fragments. */
  const processFrame = (frame: string): number => {
    if (sawDone) return 0;
    // Each frame is one or more `data: ...` lines. OpenAI sends a single
    // data line per frame; we parse anything that starts with "data:".
    const dataLines = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    const dataStr = dataLines.join("\n");
    if (!dataStr || dataStr === "[DONE]") {
      if (dataStr === "[DONE]") sawDone = true;
      return 0;
    }
    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(dataStr) as OpenAIChunk;
    } catch {
      throw new Error("上游 SSE 数据格式错误，响应未完成（未记录原始内容）。");
    }
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      throw new Error("上游 SSE 数据不是有效的响应对象，响应未完成。");
    }
    if (("error" in chunk && chunk.error != null) || frame.split("\n").some((line) => /^event:\s*error\s*$/.test(line))) {
      throw new Error("上游返回 SSE 错误，响应未完成；请检查服务端错误记录。");
    }
    for (const ev of translator.feed(chunk)) {
      writeSseEvent(res, ev);
    }
    return 1;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += normalizeNewlines(decoder.decode(value, { stream: true }));

      // OpenAI SSE frames are separated by blank lines. Process whole frames,
      // keeping any partial tail in the buffer for the next chunk.
      let sep: number;
      while ((sep = sseBuffer.indexOf("\n\n")) >= 0) {
        const frame = sseBuffer.slice(0, sep);
        sseBuffer = sseBuffer.slice(sep + 2);
        processFrame(frame);
      }
      if (sawDone) break;
    }
    // Flush the decoder (a multi-byte char can straddle the last read), then
    // process whatever is left in the buffer as a final frame. Some upstreams
    // close the socket right after the last `data:` line without the trailing
    // blank line — and that frame typically carries the tool_call fragments
    // + finish_reason. Until 2026-09-02 the residue was dropped silently,
    // which produced exactly the "text streamed fine, the announced tool call
    // never arrived" truncation shape; recovering it (or at least logging it
    // as malformed) makes the next occurrence attributable.
    sseBuffer += normalizeNewlines(decoder.decode());
    if (pendingCR) sseBuffer += "\n";
    const tail = sseBuffer.trim();
    if (tail && processFrame(tail) > 0) {
      log.info(`bridge: recovered tail SSE frame after stream end (${tail.length} bytes) — upstream omitted the trailing blank line`);
    }
    // A bare EOF/[DONE] is not a successful model finish. Keep partial
    // output, but emit an Anthropic error rather than inventing end_turn.
    const reason = translator.finishReason;
    const summary = translator.contentSummary;
    log.info(`bridge: stream summary reasoningChars=${summary.reasoningChars} textChars=${summary.textChars} tools=${translator.toolBlockCount} terminal=${["stop", "length", "tool_calls", "function_call", "content_filter"].includes(reason ?? "") ? reason : "missing-or-unknown"}`);
    if (!["stop", "length", "tool_calls", "function_call", "content_filter"].includes(reason ?? "")) {
      throw new Error("上游流在缺少有效 finish_reason 时结束，响应可能被截断，不能标记为完成。");
    }
    if (reason === "stop" && summary.reasoningChars > 0 && !summary.visibleText && translator.toolBlockCount === 0) {
      throw new Error("上游只返回了思考内容，没有最终回答或工具调用，响应未完成。");
    }
    if ((reason === "tool_calls" || reason === "function_call") && translator.toolBlockCount === 0) {
      throw new Error("上游声明了工具调用，但没有返回工具调用内容，响应未完成。");
    }
    for (const ev of translator.finish()) {
      writeSseEvent(res, ev);
    }
  } catch (err) {
    // Error events are understood by the Anthropic SDK. Previously this path
    // only logged and closed HTTP 200, leaving the UI looking successful.
    const message = ac.signal.aborted
      ? "上游流请求超时或连接中断，响应未完成。"
      : `上游流读取失败，响应未完成：${(err as Error).message}`;
    log.error(`bridge: ${message}`);
    sendError(res, 502, message);
  } finally {
    cleanup();
    await reader.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
}

/** Start a bridge server bound to a random local port. Resolves once listening. */
/** Host 头是否指向回环地址(见 startBridge 里的 DNS 重绑定说明)。没有 Host 头
 *  (HTTP/1.0)放行 —— 浏览器总会带 Host,这条路上没有重绑定。 */
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host?.trim().toLowerCase();
  if (!host) return true;
  const port = req.socket.localPort;
  return ["127.0.0.1", "localhost", "[::1]"].some((name) => host === name || host === `${name}:${port}`);
}

export async function startBridge(upstream: UpstreamConfig): Promise<BridgeHandle> {
  // Status subscribers (RuntimeManager fans these out as `upstream.issue`
  // RuntimeEvents per session using this bridge). Listener errors are
  // swallowed — status is best-effort observability, never control flow.
  const statusListeners = new Set<(s: BridgeStatus) => void>();
  const notifyStatus = (s: BridgeStatus) => {
    for (const cb of statusListeners) {
      try {
        cb(s);
      } catch {
        // ignore — a broken subscriber must not break the bridge
      }
    }
  };
  // Session id for gateways that require one (see upstreamHeaders). The bridge
  // is shared per config across sessions, and by the time it is built the
  // config's baseUrl has already been rewritten to this local URL — so the
  // live-turn env builder can't supply a per-session id to this path. One
  // stable id per bridge it is: the gateway still sees a single, unchanging
  // conversation for this endpoint rather than a new one per request, which is
  // all its routing/prompt-cache contract asks for.
  const bridgeSessionId = `mcode-${randomBytes(6).toString("hex")}`;
  if (requiresSessionHeader(upstream.baseUrl)) {
    log.info(
      hasHeader(upstream.customHeaders ?? {}, SESSION_HEADER)
        ? `bridge: upstream requires ${SESSION_HEADER}; using the configured value`
        : `bridge: upstream requires ${SESSION_HEADER}; injecting a stable id for this bridge (${bridgeSessionId})`,
    );
  }
  const server: Server = createServer((req, res) => {
    // The Claude binary POSTs to {baseUrl}/v1/messages. Accept either
    // /v1/messages or a bare /messages for robustness.
    //
    // IMPORTANT: strip the query string before matching. The binary appends
    // `?beta=true` to the path when ANTHROPIC_MODEL is a non-first-party name
    // (it negotiates the anthropic-beta capability via query instead of a
    // header on third-party routes). A bare `endsWith("/v1/messages")` fails
    // to match `/v1/messages?beta=true`, so the request fell through to the
    // 404 branch and the binary interpreted that 404 as "selected model may
    // not exist" - which is exactly the failure users saw with OpenAI-format
    // gateways (e.g. MiniMax-M3). Matching on the path alone fixes it.
    // 防 DNS 重绑定:网页把自己的域名解析到 127.0.0.1 后就成了「同源」,能直接调这个
    // 不验凭证的转发口、借用户的上游 key 跑模型并读到结果。Claude 二进制拨的是
    // `http://127.0.0.1:<port>`,Host 头必然是回环地址;别的 Host 一律拒。
    if (!isLoopbackHost(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { message: "forbidden host" } }));
      return;
    }
    const rawUrl = req.url ?? "";
    const path = rawUrl.split("?", 2)[0];
    if (req.method === "POST" && (path.endsWith("/v1/messages") || path.endsWith("/messages"))) {
      handleMessages(req, res, upstream, bridgeSessionId, notifyStatus).catch((err) => {
        log.error(`bridge: handler threw: ${(err as Error).message}`);
        sendError(res, 500, "internal bridge error");
      });
      return;
    }
    // Anything else (health probes, GET) → 404. The binary only POSTs messages.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: "not found" } }));
  });

  // The Claude binary dials this with Node's fetch, so the port must survive
  // the fetch spec's bad-port blocklist — see lib/loopbackPort.ts. Log the
  // blocked draws: otherwise the only trace of this is a rebind that looks
  // arbitrary.
  const port = await listenOnDialablePort(server, (p) => {
    if (isBlockedPort(p)) log.info(`bridge: OS handed out blocked port ${p}; rebinding`);
  });

  const routeToken = randomBytes(12).toString("hex");
  log.info(`bridge: listening on 127.0.0.1:${port} → ${upstream.baseUrl}`);

  return {
    localUrl: `http://127.0.0.1:${port}`,
    routeToken,
    onStatus: (cb: (s: BridgeStatus) => void) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    close: () => {
      server.close(() => log.info(`bridge: closed 127.0.0.1:${port}`));
    },
  };
}
