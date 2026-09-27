/**
 * MobileHttpServer — the LAN-facing HTTP server that serves the mobile web app
 * and bridges it to the same main-process logic the desktop renderer uses.
 *
 * Endpoints (all under one origin, so the mobile bundle calls same-origin
 * `/api/*` with no CORS):
 *
 *   GET  /                      → mobile bundle (SPA, static)
 *   GET  /api/health            → { ok } (no auth; for connectivity checks)
 *   POST /api/pair/verify       → complete pairing (no auth; nonce + code)
 *   POST /api/rpc               → whitelisted RPC (Authorization: Bearer)
 *   GET  /api/events            → SSE event stream (Authorization: Bearer)
 *
 * ## Lifecycle
 * Started from index.ts on `app.whenReady` (after DB init), stopped on
 * `before-quit`. Bound to `0.0.0.0` so other devices on the LAN can reach it.
 * This is a deliberate widening of the threat boundary: only the pairing flow
 * guards access — every request past `/api/pair/*` requires a valid device
 * token.
 *
 * The server builds on the same node:http pattern as the OpenAI bridge server
 * (`providers/bridge/bridgeServer.ts`) but is long-lived and multi-route.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { app } from "electron";
import { awaitDb, getDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
import {
  MOBILE_DEFAULT_PORT,
  MOBILE_PORT_SETTING_KEY,
  MOBILE_ENABLED_SETTING_KEY,
  MOBILE_PAIRED_DEVICES_SETTING_KEY,
  SSE_HEARTBEAT_INTERVAL_MS,
  PairingVerifyInputSchema,
  type MobileRpcRequest,
  type MobileRpcResponse,
  type PairingVerifyInput,
  type PairedDevice,
} from "@contracts/mobile";
import { pairingManager, detectLanIp } from "./PairingManager.js";
import { mobileEventBus } from "./MobileEventBus.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { hasLiveRendererWindow } from "@main/window.js";
import { dispatchMobileRpc, RpcError, type DeviceContext } from "./mobileRpc.js";
import { registerMobileGitRpc } from "./mobileGitRpc.js";
import { serveMobileAsset } from "./serveMobileStatic.js";
import { log } from "@main/lib/logger.js";

/** Read the configured port from settings (post-DB). Falls back to default. */
async function resolvePort(): Promise<number> {
  await awaitDb();
  try {
    const raw = SettingRepo.get(MOBILE_PORT_SETTING_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) return n;
    }
  } catch {
    // DB not ready yet — fall through to default.
  }
  return MOBILE_DEFAULT_PORT;
}

async function readEnabled(): Promise<boolean> {
  await awaitDb();
  try {
    const raw = SettingRepo.get(MOBILE_ENABLED_SETTING_KEY);
    if (raw === "0") return false;
  } catch {
    // ignore
  }
  return true;
}

export interface MobileServerHandle {
  /** Whether the server is currently listening. */
  readonly running: boolean;
  /** The bound port (0 if not running). */
  readonly port: number;
  /** The LAN endpoint base URL, e.g. `http://192.168.1.5:7331`. */
  readonly endpoint: string;
  /** Stop listening. Idempotent. */
  stop(): void;
}

let currentHandle: MobileServerHandle | null = null;

/** Read the request body as JSON, with a size guard. Mirrors bridgeServer. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const LIMIT = 32 * 1024 * 1024;
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

/** Extract + validate the device token. Prefers the `Authorization: Bearer`
 *  header; for GET `/api/events` only, falls back to a `?token=` query param —
 *  `EventSource` cannot set request headers, so the SSE stream has no other way
 *  to authenticate.
 *
 *  ⚠️ **The query-param fallback is restricted to the SSE route.** It used to
 *  apply to every route, which put the device token in the URL of ordinary RPC
 *  calls: URLs land in `Referer`, in proxy/access logs, and in browser history.
 *  A token in a URL is a token leaked to anything that can read a log line —
 *  and this token is a full pass to `/api/rpc` (chats, session content,
 *  settings). `EventSource` is the only client that needs it; nothing else
 *  may authenticate that way. */
async function authorize(req: IncomingMessage, allowQueryToken = false): Promise<PairedDevice | null> {
  let token: string | null = null;
  const header = req.headers["authorization"];
  if (header && typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) token = match[1];
  }
  if (!token && allowQueryToken) {
    // Query-param fallback for EventSource (no header support) — SSE only.
    const u = req.url ?? "";
    const q = u.split("?", 2)[1];
    if (q) {
      const params = new URLSearchParams(q);
      token = params.get("token");
    }
  }
  if (!token) return null;
  return pairingManager.validateToken(token);
}

/** Setting keys the **LAN-facing** surface must never read or write.
 *
 *  `mobile.pairedDevices` holds every paired device's token **in plaintext**
 *  (see {@link PairingManager}). `setting:get` / `setting:getMany` are on the
 *  mobile whitelist because the phone shell reads its own preferences — so
 *  without this guard any one paired phone could ask for that key and read
 *  **every other phone's token**, then use it. Symmetrically, `setting:set`
 *  would let a phone rewrite the list: wipe every device (denial of service) or
 *  inject a record with a token of its choosing.
 *
 *  This is scoped to the HTTP bridge on purpose. The desktop renderer keeps its
 *  read access to the same key — it is local, and the DB file it reads from is
 *  already the user's own trust boundary (see the note in PairingManager). The
 *  difference here is the **network**: the bridge is reachable by every device
 *  on the LAN, so it must not hand out other devices' credentials.
 *
 *  This is the belt; the braces are in `mobileRpc.ts`: the `setting:*`
 *  handlers only serve keys on an allowlist (`isMobileAccessibleSettingKey`),
 *  which keeps the rest of the table (relay VPS config, public-MCP secret,
 *  cookie vault, MCP / LSP / terminal-shell config, workflow review records)
 *  away from the phone as well. */
const LAN_UNREADABLE_SETTING_KEYS = new Set<string>([MOBILE_PAIRED_DEVICES_SETTING_KEY]);

/** True if this RPC request carries a setting key the LAN surface must not
 *  touch — checked for **every** method, not just the `setting:*` family, so a
 *  future handler that forwards a key can't reopen the hole by accident. */
function touchesBlockedSetting(body: MobileRpcRequest): boolean {
  const input = body.input as { key?: unknown; keys?: unknown } | null | undefined;
  if (!input || typeof input !== "object") return false;
  const keys: unknown[] = [input.key];
  if (Array.isArray(input.keys)) keys.push(...input.keys);
  return keys.some((k) => typeof k === "string" && LAN_UNREADABLE_SETTING_KEYS.has(k));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

/** Send a `MobileRpcResponse` envelope, mapping thrown errors to statuses. */
function sendRpcResult(res: ServerResponse, promise: Promise<unknown>): void {
  promise
    .then((result) => sendJson(res, 200, { ok: true, result } satisfies MobileRpcResponse))
    .catch((err: unknown) => {
      if (err instanceof RpcError) {
        sendJson(res, err.status, { ok: false, error: err.message, status: err.status } satisfies MobileRpcResponse);
      } else if (err instanceof Error) {
        // zod errors bubble up here too — treat as bad request for safety.
        sendJson(res, 400, { ok: false, error: err.message, status: 400 } satisfies MobileRpcResponse);
      } else {
        sendJson(res, 500, { ok: false, error: "internal error", status: 500 } satisfies MobileRpcResponse);
      }
    });
}

/** SSE event-stream handler. Subscribes to the bus, writes each RuntimeEvent
 *  framed as `event: message\ndata: <json>\n\n`, and emits heartbeats. */
function handleEvents(req: IncomingMessage, res: ServerResponse, device: PairedDevice): void {
  if (req.destroyed || res.destroyed) return;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let releaseDevice: (() => void) | null = null;
  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    releaseDevice?.();
    if (heartbeat) clearInterval(heartbeat);
    req.off("close", close);
    res.off("close", close);
    res.off("error", close);
    // Revocation must not wait for a slow client's queued output to drain.
    if (!res.destroyed) res.destroy();
  };
  releaseDevice = pairingManager.registerDeviceConnection(device.deviceId, close);
  if (!releaseDevice) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }
  req.once("close", close);
  res.once("close", close);
  res.once("error", close);
  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    // The bus is unbuffered: reconnecting clients first restore running state.
    res.write(`data: ${JSON.stringify({
      sessionId: "",
      event: {
        type: "session.runningSnapshot",
        sessionId: "",
        running: runtimeManager.runningSessionIds(),
        // 桌面窗口在不在 —— 决定回合消息谁来落库(见 contracts 里这个字段的注释)。
        desktopAttached: hasLiveRendererWindow(),
      },
    })}\n\n`);
    unsubscribe = mobileEventBus.subscribe((event) => {
      if (closed) return;
      // 这台自己写的设置不回推(连续输入时晚到的回声会把文本框拽回旧值)。
      if (event.type === "setting.changed" && event.originDeviceId === device.deviceId) return;
      res.write(`data: ${JSON.stringify({ sessionId: event.sessionId, event })}\n\n`);
    });
    heartbeat = setInterval(() => {
      if (!closed) res.write(": ping\n\n");
    }, SSE_HEARTBEAT_INTERVAL_MS);
  } catch (error) {
    close();
    throw error;
  }
}

/** POST /api/pair/verify — complete pairing. No auth required (nonce + code). */
async function handlePairVerify(req: IncomingMessage, res: ServerResponse, endpoint: string): Promise<void> {
  let body: PairingVerifyInput;
  try {
    body = PairingVerifyInputSchema.parse(await readJsonBody(req)) as PairingVerifyInput;
  } catch (err) {
    sendJson(res, 400, { error: `无效的配对请求: ${(err as Error).message}` });
    return;
  }
  const outcome = await pairingManager.verify(body, endpoint);
  if (!outcome.ok) {
    sendJson(res, 401, { error: outcome.reason });
    return;
  }
  sendJson(res, 200, outcome.result);
}

/** POST /api/rpc — dispatch a whitelisted RPC. Auth required. */
async function handleRpc(req: IncomingMessage, res: ServerResponse, device: PairedDevice): Promise<void> {
  let body: MobileRpcRequest;
  try {
    body = (await readJsonBody(req)) as MobileRpcRequest;
  } catch (err) {
    sendJson(res, 400, { ok: false, error: `invalid body: ${(err as Error).message}`, status: 400 });
    return;
  }
  if (!body || typeof body.method !== "string") {
    sendJson(res, 400, { ok: false, error: "missing method", status: 400 });
    return;
  }
  // One key is off-limits over the LAN (see LAN_UNREADABLE_SETTING_KEYS): it
  // holds every device's token in plaintext, so a single paired phone reading
  // it would own every other phone.
  if (touchesBlockedSetting(body)) {
    log.warn(`mobile: rpc ${body.method} refused — setting key is not reachable over the LAN bridge`);
    sendJson(res, 403, { ok: false, error: "forbidden setting key", status: 403 });
    return;
  }
  const ctx: DeviceContext = { device };
  // Entry/exit tracing. git:* calls are user-triggered slow ops (LLM rounds,
  // network) — always logged so a hung request is visible in main.log. Other
  // methods log only when slow or failing. Without this a request stuck
  // server-side leaves no trace at all: the handlers log only on completion,
  // and handler failures are swallowed into 4xx responses by sendRpcResult
  // (the outer route catch never fires for them).
  const started = Date.now();
  const slowOp = body.method.startsWith("git:");
  if (slowOp) log.info(`mobile: rpc ${body.method} start (${device.name})`);
  const traced = dispatchMobileRpc(body, ctx).then(
    (result) => {
      const ms = Date.now() - started;
      if (slowOp) log.info(`mobile: rpc ${body.method} ok in ${ms}ms`);
      else if (ms > 3000) log.warn(`mobile: rpc ${body.method} slow (${ms}ms)`);
      return result;
    },
    (err: unknown) => {
      const ms = Date.now() - started;
      log.warn(`mobile: rpc ${body.method} failed in ${ms}ms: ${(err as Error)?.message ?? err}`);
      throw err;
    },
  );
  sendRpcResult(res, traced);
}

/** The request router: routing table + the per-route auth gate.
 *
 *  Extracted from {@link startMobileServer} verbatim so the routing and — above
 *  all — the auth gate can be exercised without starting the process-wide
 *  listener (which binds `0.0.0.0` and would therefore expose the machine under
 *  test to the LAN). `scripts/mobile-pairing-smoke` builds its own
 *  `createServer(createMobileRequestHandler(...))` on `127.0.0.1:0` with it.
 *
 *  `endpoint` is only used for the URLs echoed back in `/api/health` and the
 *  pairing result — nothing in routing/auth depends on it. */
export function createMobileRequestHandler(
  endpoint: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // All API responses get a permissive CSP-free header set as needed. The
    // mobile bundle is served with its own meta CSP (Phase 4).
    const rawUrl = req.url ?? "/";
    const path = rawUrl.split("?", 2)[0];

    // CORS: same-origin in production; allow all origins so a dev Vite server
    // (different port) can call this API directly during mobile development.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Unauthenticated routes ──────────────────────────────────────────
    if (path === "/api/health") {
      sendJson(res, 200, { ok: true, endpoint, dbReady: !!getDb() });
      return;
    }
    if (path === "/api/pair/verify" && req.method === "POST") {
      handlePairVerify(req, res, endpoint).catch((err) => {
        log.error(`mobile: pair/verify failed: ${(err as Error).message}`);
        sendJson(res, 500, { error: "internal error" });
      });
      return;
    }

    // ── Authenticated routes ────────────────────────────────────────────
    if (path.startsWith("/api/")) {
      // Authorize first. The `?token=` fallback is SSE-only (EventSource cannot
      // set headers) — every other route must carry `Authorization: Bearer`.
      const authPromise = authorize(req, path === "/api/events");
      // SSE handler keeps the connection open, so handle it inline.
      if (path === "/api/events" && req.method === "GET") {
        authPromise.then((device) => {
          if (!device) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          handleEvents(req, res, device);
        }).catch((error) => {
          log.warn(`mobile: SSE authorization/setup failed: ${String(error)}`);
          if (!res.destroyed && !res.headersSent) sendJson(res, 500, { error: "internal error" });
          else if (!res.destroyed) res.destroy();
        });
        return;
      }
      if (path === "/api/rpc" && req.method === "POST") {
        authPromise
          .then((device) => {
            if (!device) {
              sendJson(res, 401, { ok: false, error: "unauthorized", status: 401 });
              return;
            }
            return handleRpc(req, res, device);
          })
          .catch((err) => {
            log.error(`mobile: rpc failed: ${(err as Error).message}`);
            sendJson(res, 500, { ok: false, error: "internal error", status: 500 });
          });
        return;
      }
      // Unknown /api route.
      sendJson(res, 404, { error: "not found" });
      return;
    }

    // ── Static mobile bundle (SPA) ──────────────────────────────────────
    serveMobileAsset(req, res);
  };
}

/** Start the mobile server. Resolves with a handle (running:false if disabled
 *  or DB unavailable). Safe to call once at app start. */
export async function startMobileServer(): Promise<MobileServerHandle> {
  if (currentHandle) return currentHandle;

  // Wait for DB so settings (enabled flag, port) are readable.
  try {
    await awaitDb();
  } catch (err) {
    log.error(`mobile: DB not ready, server not started: ${(err as Error).message}`);
    return makeIdleHandle();
  }

  const enabled = await readEnabled();
  if (!enabled) {
    log.info("mobile: disabled by setting (mobile.enabled=0); server not started");
    return makeIdleHandle();
  }

  // Register the git subset into the mobile RPC whitelist (idempotent — the
  // table absorbs the extra handlers). Done once per server start.
  try {
    registerMobileGitRpc();
  } catch (err) {
    log.warn(`mobile: git RPC registration failed: ${(err as Error).message}`);
  }

  const port = await resolvePort();
  const lanIp = detectLanIp();
  const endpoint = lanIp ? `http://${lanIp}:${port}` : `http://localhost:${port}`;

  const server: Server = createServer(createMobileRequestHandler(endpoint));

  try {
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(port, "0.0.0.0", () => resolve());
    });
  } catch (err) {
    log.error(`mobile: failed to listen on 0.0.0.0:${port}: ${(err as Error).message}`);
    return makeIdleHandle();
  }

  log.info(`mobile: server listening on 0.0.0.0:${port} (${endpoint})${lanIp ? "" : " [no LAN IP detected]"}`);

  currentHandle = {
    running: true,
    port,
    endpoint,
    stop: () => {
      server.close(() => log.info(`mobile: server stopped (${port})`));
      // close() alone waits forever for SSE. Stop active HTTP connections too;
      // each stream's close handler releases its bus subscription/device lease.
      server.closeAllConnections();
      currentHandle = null;
    },
  };
  return currentHandle;
}

/** Stop the running mobile server, if any. */
export function stopMobileServer(): void {
  currentHandle?.stop();
  currentHandle = null;
}

/** A non-running handle returned when the server is disabled or errored. */
function makeIdleHandle(): MobileServerHandle {
  return {
    running: false,
    port: 0,
    endpoint: "",
    stop: () => {
      /* nothing */
    },
  };
}

/** The currently-running server handle (or a non-running idle handle). */
export function getMobileServer(): MobileServerHandle {
  return currentHandle ?? makeIdleHandle();
}

/** True if the mobile feature is available (enabled + server reachable). Used
 *  by the PC UI to decide whether to show the "connect phone" button. */
export function isMobileServerRunning(): boolean {
  return !!currentHandle?.running;
}

/** Re-export so index.ts / RuntimeManager don't need a second import. */
export { mobileEventBus } from "./MobileEventBus.js";

/** Convenience for the PC UI: lazily read app path without importing electron
 *  in the index module twice. Currently unused but reserved for the dialog. */
export function _appRef(): Electron.App {
  return app;
}
