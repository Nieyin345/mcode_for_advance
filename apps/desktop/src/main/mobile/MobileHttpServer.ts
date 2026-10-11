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
 * `before-quit`. **Only listens when explicitly enabled** — the master switch
 * `mobile.enabled` must be `"1"` (see {@link readEnabled}); there is no
 * serve-by-default, because this server puts passwords and bearer tokens on
 * plaintext HTTP bound to `0.0.0.0`. Once enabled it binds `0.0.0.0:<port>` so
 * other devices on the LAN can reach it — a deliberate widening of the threat
 * boundary, guarded only by the pairing flow: every request past `/api/pair/*`
 * requires a valid device token.
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
  MOBILE_LOGIN_SETTING_KEY,
  SSE_HEARTBEAT_INTERVAL_MS,
  PairingVerifyInputSchema,
  MobileLoginInputSchema,
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
import {
  beginLoginAttempt,
  isMobileLoginEnabled,
  loginClientKey,
  recordLoginResult,
  verifyMobileLogin,
} from "./mobileLogin.js";
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

/** Is the LAN HTTP server explicitly enabled?
 *
 *  ⚠️ **安全默认值 = 关。** 这台服务把配对/登录/账号密码/RPC/SSE 全放在**明文 HTTP**上,
 *  绑的是 `0.0.0.0`(LAN 上每台设备都能打)。从前这里是「没显式写 `0` 就当开」——
 *  于是一次全新安装、用户从没做过任何选择,就已经把 `0.0.0.0:<port>` 敞在局域网上,
 *  连同 Bearer 令牌与登录口令一起走明文。默认值改成一个**安全**的:只有显式存了
 *  `"1"` 才开;`"0"`、空、缺键一律不开。这是一处**产品默认值变更**,刻意做成保守且可逆:
 *  用户显式开启后,行为与今天完全一致(同一个端口、同一套配对/登录/撤销)。
 *
 *  (开机自动启动这条路由 `startMobileServer` 决定;真正的"启用"是用户在设置里写
 *  `mobile.enabled=1`,或未来接一条"首次连接手机时询问"的流程。) */
export async function readEnabled(): Promise<boolean> {
  await awaitDb();
  try {
    const raw = SettingRepo.get(MOBILE_ENABLED_SETTING_KEY);
    if (raw === "1") return true;
  } catch {
    // ignore — treat as not enabled (fail-closed)
  }
  return false;
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
function readJsonBody(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const LIMIT = limit;
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
const LAN_UNREADABLE_SETTING_KEYS = new Set<string>([MOBILE_PAIRED_DEVICES_SETTING_KEY, MOBILE_LOGIN_SETTING_KEY]);

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

/** SSE 慢客户端的**缓冲上限**。`res.write()` 在客户端读得慢时会把未冲刷的字节堆在
 *  socket 里(`res.writableLength` 随之增长);不设上限的话,一台卡住的手机(或一个
 *  只连不读的流)能让主进程为它无限缓冲 `text.delta`,直到 OOM —— 而且拖慢别的设备。
 *
 *  两级:
 *   - **软阈值** {@link SSE_SOFT_BUFFER_BYTES}:超了给一个宽限期,期间冲刷回阈值以下
 *     就不断(正常突发不该误伤);
 *   - **硬上限** {@link SSE_HARD_BUFFER_BYTES}:超了**立即**断 —— 即便在宽限期内,峰值
 *     内存也被钉在这个量级,不会无限涨。
 *  断开的是**这一台**,它重连后先拿一帧 `runningSnapshot` 恢复(见
 *  {@link handleEvents});别的订阅者各自的连接照常收。 */
const SSE_SOFT_BUFFER_BYTES = 256 * 1024;
const SSE_HARD_BUFFER_BYTES = 2 * 1024 * 1024;
/** 达到软阈值后,最多等这么久让队列冲刷 —— 期间回压落回阈值以下就不必断。 */
const SSE_DRAIN_GRACE_MS = 30_000;

/** SSE event-stream handler. Subscribes to the bus, writes each RuntimeEvent
 *  framed as `event: message\ndata: <json>\n\n`, and emits heartbeats.
 *
 *  ⚠️ **背压保护**:每条帧写出去之后检查 `res.writableLength`;超
 *  {@link SSE_MAX_BUFFERED_BYTES} 就把这台设备标成"慢客户端",起一个宽限计时器,
 *  到期仍未冲刷完就 `close()` 掉它(重连拿快照)。断掉的是**这一台**,别的订阅者
 *  通过各自的连接照常收 —— 见 MobileEventBus 对每个 subscriber 的隔离。 */
function handleEvents(req: IncomingMessage, res: ServerResponse, device: PairedDevice): void {
  if (req.destroyed || res.destroyed) return;
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseDevice: (() => void) | null = null;
  const clearDrainTimer = (): void => {
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = undefined; }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    releaseDevice?.();
    if (heartbeat) clearInterval(heartbeat);
    clearDrainTimer();
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
  /** 写一帧并施加背压。超软阈值给宽限期;超硬上限立即断(峰值内存有界)。 */
  const writeFrame = (chunk: string): void => {
    if (closed) return;
    try {
      res.write(chunk);
    } catch {
      close();
      return;
    }
    if (res.writableLength > SSE_HARD_BUFFER_BYTES) {
      log.warn(`mobile: dropping slow SSE client ${device.deviceId} (buffered ${res.writableLength}B over hard cap) — it will reconnect for a snapshot`);
      close();
      return;
    }
    if (res.writableLength > SSE_SOFT_BUFFER_BYTES) {
      if (!drainTimer) {
        log.warn(
          `mobile: SSE client ${device.deviceId} is slow (buffered ${res.writableLength}B) — will disconnect if it does not drain`,
        );
        drainTimer = setTimeout(() => {
          drainTimer = undefined;
          if (!closed && res.writableLength > SSE_SOFT_BUFFER_BYTES) {
            log.warn(`mobile: dropping slow SSE client ${device.deviceId} (buffered ${res.writableLength}B) — it will reconnect for a snapshot`);
            close();
          }
        }, SSE_DRAIN_GRACE_MS);
        drainTimer.unref?.();
      }
    } else {
      // 落回阈值以下 —— 撤掉宽限计时器,别把已经跟上的客户端误断。
      clearDrainTimer();
    }
  };
  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    // The bus is unbuffered: reconnecting clients first restore running state.
    writeFrame(`data: ${JSON.stringify({
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
      writeFrame(`data: ${JSON.stringify({ sessionId: event.sessionId, event })}\n\n`);
    });
    heartbeat = setInterval(() => {
      if (!closed) writeFrame(": ping\n\n");
    }, SSE_HEARTBEAT_INTERVAL_MS);
  } catch (error) {
    close();
    throw error;
  }
}

/** Body cap for the **unauthenticated** pairing endpoint. A valid request is
 *  `{nonce ≤64, code ≤8, deviceName ≤64}` — well under 1 KB. Reusing the 32 MB
 *  RPC cap here let anyone who can reach the port (LAN, or the internet via the
 *  relay) make the desktop buffer 32 MB per request without any credential. */
const PAIR_VERIFY_BODY_LIMIT = 16 * 1024;

/** POST /api/pair/verify — complete pairing. No auth required (nonce + code). */
async function handlePairVerify(req: IncomingMessage, res: ServerResponse, endpoint: string): Promise<void> {
  let body: PairingVerifyInput;
  try {
    body = PairingVerifyInputSchema.parse(await readJsonBody(req, PAIR_VERIFY_BODY_LIMIT)) as PairingVerifyInput;
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

/** POST /api/auth/login — 账号密码登录(未开启时一律 401)。成功发一张和配对一样的
 *  设备令牌。失败按来源节流,见 `mobileLogin.ts`。
 *
 *  ⚠️ **限流配额在进 scrypt 之前原子预留。** 从前先 `loginLockRemaining`、再 await
 *  读体 + await scrypt、最后才 `recordLoginResult` —— 一批并发请求会在**任何一次
 *  scrypt 出结果前**全部通过锁定检测,单来源锁形同虚设,还能迅速触达全局锁连累合法
 *  用户。现在 {@link beginLoginAttempt} 把"在途尝试"也算进来源预算与全局在途上限,
 *  超出的当场 429,不进 scrypt。 */
async function handlePasswordLogin(req: IncomingMessage, res: ServerResponse, endpoint: string): Promise<void> {
  await awaitDb();
  const client = loginClientKey(req);
  // 原子预留:锁定 / 预算 / 并发额度任一不满足就当场拒,不读体、不算 scrypt。
  const reservation = beginLoginAttempt(client);
  if (!reservation.allowed) {
    const sec = Math.max(1, Math.ceil(reservation.retryAfterMs / 1000));
    res.setHeader("Retry-After", String(sec));
    const error = reservation.reason === "busy"
      ? "登录请求过多，请稍后再试"
      : `尝试次数过多，请 ${sec} 秒后再试`;
    sendJson(res, 429, { error, retryAfter: sec });
    return;
  }
  let body: { username: string; password: string; deviceName?: string };
  try {
    body = MobileLoginInputSchema.parse(await readJsonBody(req, PAIR_VERIFY_BODY_LIMIT));
  } catch {
    // 预留的配额也要释放 —— 否则一次坏的请求体会永久占掉一个在途槽。
    recordLoginResult(client, false);
    sendJson(res, 400, { error: "请输入账号和密码" });
    return;
  }
  const ok = await verifyMobileLogin(body.username, body.password);
  recordLoginResult(client, ok);
  if (!ok) {
    log.warn(`mobile: password login failed (from ${client})`);
    sendJson(res, 401, {
      error: isMobileLoginEnabled() ? "账号或密码错误" : "电脑端未开启账号密码登录",
    });
    return;
  }
  const name = body.deviceName?.trim() || "密码登录设备";
  const result = pairingManager.issueDevice(name, endpoint);
  log.info(`mobile: device logged in with password (${result.deviceId}, name=${name}, from ${client})`);
  sendJson(res, 200, result);
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
      // ⚠️ `getDb()` 在库还没初始化(或已拆掉)时会**抛**,而这段跑在 Node 的
      // `request` 监听器里 —— 同步抛出去没有任何 catch 接住,能把主进程带崩。健康检查
      // 是手机端轮询最频繁的一条,不该有这种可能。与下面 `/api/auth/methods` 同一道守卫。
      let dbReady = false;
      try { dbReady = !!getDb(); } catch { dbReady = false; }
      sendJson(res, 200, { ok: true, endpoint, dbReady });
      return;
    }
    if (path === "/api/pair/verify" && req.method === "POST") {
      handlePairVerify(req, res, endpoint).catch((err) => {
        log.error(`mobile: pair/verify failed: ${(err as Error).message}`);
        sendJson(res, 500, { error: "internal error" });
      });
      return;
    }

    // 登录页据此决定显不显示账号密码表单(只说开没开,不泄露账号名)。
    if (path === "/api/auth/methods" && req.method === "GET") {
      let password = false;
      try { password = !!getDb() && isMobileLoginEnabled(); }
      catch { password = false; }
      sendJson(res, 200, { password });
      return;
    }
    if (path === "/api/auth/login" && req.method === "POST") {
      handlePasswordLogin(req, res, endpoint).catch((err) => {
        log.error(`mobile: auth/login failed: ${(err as Error).message}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
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
      //
      // ⚠️ `authPromise` 在上面**已经启动**了(RPC / SSE 两条路各自接住了它)。
      // 这条落空的路由从不消费它 —— 于是当 `authorize()` 自己 reject(唯一场景:
      // 库被拆掉时 `validateToken` 里的 `getDb()` 抛;`/api/health` 那条就是为这个
      // 窗口补的守卫)而请求又带了 `Authorization` 头时,这就是一个**没人接的
      // rejected promise** —— Node 默认 `--unhandled-rejections=throw` 会把它升级成
      // 未捕获异常,直接把主进程带崩,而它跑在 request 监听器里、没有任何 catch。
      // 显式观察它:404 照常发,异常只记一行日志。
      authPromise.catch((error) => log.warn(`mobile: authorization failed on unknown route: ${String(error)}`));
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
    // 默认值 = 关(见 readEnabled):没有显式的 mobile.enabled=1 就不监听,不向 LAN 暴露。
    log.info("mobile: LAN server not explicitly enabled (mobile.enabled!=1); server not started");
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
