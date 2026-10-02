/**
 * OnlyOffice Document Server 桥 —— 主进程这一半。
 *
 * 职责只有三件（契约见 `@contracts/ipc` 的 `onlyoffice.ts` 文件头）：
 *
 *  1. **起一个本机 HTTP 服务**（随机端口，监听 `0.0.0.0` —— Docker 里的 DS 要从
 *     宿主机 IP 打进来，绑 127.0.0.1 它够不着）。每个编辑会话一枚 32 字节随机令牌，
 *     URL 里只出现令牌，不出现路径。令牌在最后一个面板关闭且 DS 最终保存/无改动回调完成后失效。
 *  2. **拼 DocEditor 的 config 并签 JWT**（HS256，用 `node:crypto`，不引第三方包）。
 *  3. **接回调**：DS 在用户停止编辑约 10s 后 / 关闭文档时 / 收到 forcesave 时 POST 过来，
 *     `status` 为 2 或 6 时 `url` 指向新版本 —— 下载、写临时文件、`rename` 原子替换原文件。
 *     回 `{"error":0}`，否则 DS 会一直重试并把文档标成"保存失败"。
 *
 * ## 为什么写回走"临时文件 + rename"
 *
 * 用户正在 Mcode 里编辑的往往就是 Agent 正在读的文件。半截写入被读到就是坏 zip。
 *
 * ## document.key
 *
 * DS 用它做协同编辑与缓存的标识：**同一个 key 永远拿到同一份缓存**，哪怕磁盘上的
 * 文件变了。所以 key 必须"内容变了就变、内容没变就别变"。
 *
 * 原先 key = `路径 + mtime + size`。mtime 满足前半句，却**不满足后半句**：我们每
 * 写回一次 mtime 就变，于是用户只是关掉标签再打开同一份没改过的文档，DS 那边的
 * 缓存（已经转换好的中间格式）也整份作废 —— 重下、重转，每次打开都像第一次。
 * 改成 `路径 + 内容 sha1`：内容没动就命中 DS 缓存，打开肉眼可见地快；内容一变
 * （我们写回、或 Agent 在外面改了）哈希自然变，正确性不受影响。
 *
 * 代价是每次打开要把文件读一遍算哈希。Office 文档通常几百 KB，毫秒级；超过
 * {@link KEY_HASH_MAX_BYTES} 的大文件退回 mtime + size，不为了省一次转换去读几十 MB。
 *
 * ## 路径闸门
 *
 * 与 `file:readFile` 同一道：`findContainingWorkspaceRoot`（项目根 ∪ 会话 worktree ∪
 * 文献库/模版库）。令牌只是"这条 URL 对应哪个文件"的索引，不是权限。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { freemem, networkInterfaces } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_ONLYOFFICE_CONFIG,
  ONLYOFFICE_CONFIG_SETTING_KEY,
  ONLYOFFICE_EDITABLE,
  ONLYOFFICE_VIEW_ONLY,
  OnlyOfficeConfigSchema,
  parseOnlyOfficeConfig,
  type OnlyOfficeConfig,
  type OnlyOfficeOpenResult,
  type OnlyOfficeSessionState,
  type OnlyOfficeStatusResult,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { log } from "@main/lib/logger.js";

/* ───────────────────────── 配置 ───────────────────────── */

/** 进程内缓存：CSP 头每个响应都要读它，不能每次查库。 */
let cachedConfig: OnlyOfficeConfig | null = null;

/** 超过这个大小就不为算 key 去读全文（见文件头 document.key 那一段）。 */
const KEY_HASH_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 这一份文件的 document.key。内容哈希优先,读不动(太大 / 读失败)再退回 mtime+size。
 * DS 限制 key 只能是 `[0-9a-zA-Z.=_-]` 且 ≤128 字符,所以取十六进制前 40 位。
 */
async function documentKey(filePath: string, mtimeMs: number, size: number): Promise<string> {
  if (size <= KEY_HASH_MAX_BYTES) {
    try {
      const hash = createHash("sha1");
      await pipeline(createReadStream(filePath), hash);
      return hash.digest("hex").slice(0, 40);
    } catch {
      /* 读不了就退回下面那条 —— 打不开文件的话后面 serveFile 也会报,不在这里失败 */
    }
  }
  return createHash("sha1").update(`${filePath}|${mtimeMs}|${size}`).digest("hex").slice(0, 40);
}

export function getOnlyOfficeConfig(): OnlyOfficeConfig {
  if (cachedConfig) return cachedConfig;
  try {
    cachedConfig = parseOnlyOfficeConfig(SettingRepo.get(ONLYOFFICE_CONFIG_SETTING_KEY));
  } catch {
    // 数据库还没就绪（启动极早期，CSP 回调先到了）—— 当作没配，下次再读。
    return { ...DEFAULT_ONLYOFFICE_CONFIG };
  }
  return cachedConfig;
}

export function setOnlyOfficeConfig(input: unknown): OnlyOfficeConfig {
  const parsed = OnlyOfficeConfigSchema.parse(input);
  const next: OnlyOfficeConfig = {
    serverUrl: normalizeServerUrl(parsed.serverUrl),
    jwtSecret: parsed.jwtSecret.trim(),
    callbackHost: parsed.callbackHost.trim(),
  };
  SettingRepo.set(ONLYOFFICE_CONFIG_SETTING_KEY, JSON.stringify(next));
  cachedConfig = next;
  return next;
}

/** 去掉尾部斜杠、补协议。用户常贴 `localhost:8080` 或 `http://host/`。 */
function normalizeServerUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s.replace(/\/+$/, "");
}

/**
 * DS 的源（`scheme://host:port`），给 CSP 用。未配置给 null —— 调用方那时不该往 CSP
 * 里塞任何东西。
 */
export function getOnlyOfficeOrigin(): string | null {
  const url = getOnlyOfficeConfig().serverUrl;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/* ───────────────────────── JWT（HS256） ───────────────────────── */

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

/** 验证 DS 发来的 token。签名对得上就返回 payload，否则 null。 */
function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* ───────────────────────── 会话 ───────────────────────── */

interface EditSession {
  key: string;
  token: string;
  filePath: string;
  ext: string;
  mode: "edit" | "view";
  /** `freeMemMB` 是每次查询现算的（本机可用内存），不属于会话自身的状态。 */
  state: Omit<OnlyOfficeSessionState, "freeMemMB">;
  references: number;
  serverSeen: boolean;
  finalized: boolean;
  /**
   * 我们**自己**最后一次见到的磁盘状态（开会话时、以及每次成功写回之后）。
   *
   * 用来回答一个问题：这份文件在会话开着的时候被别人动过吗？渲染端要靠它决定
   * 能不能复用缓存着的编辑器 —— 那里面是旧内容，盖回去就是数据丢失。
   */
  disk: { mtimeMs: number; size: number };
  /** 正在把 DS 的新版本落盘(rename 和更新 `disk` 之间磁盘会短暂"对不上")。 */
  inWriteBack: boolean;
  /** 外部修改后,这个会话后续的保存都落到这一份冲突副本里。 */
  conflictPath: string | null;
  writing: Promise<void>;
  forcing: Promise<void>;
  waiters: Map<string, (result: SaveResult) => void>;
}
type SaveResult = { ok: boolean; error?: string };

const sessionsByKey = new Map<string, EditSession>();
const sessionsByToken = new Map<string, EditSession>();

/* ───────────────────────── HTTP 桥 ───────────────────────── */

let server: Server | null = null;
let port = 0;
let serverStarting: Promise<number> | null = null;
let serverGeneration = 0;

function ensureServer(): Promise<number> {
  if (server && port) return Promise.resolve(port);
  if (serverStarting) return serverStarting;
  const generation = serverGeneration;
  const pending = new Promise<number>((resolve, reject) => {
    const srv = createServer((req, res) => {
      void handleRequest(req, res).catch((err) => {
        log.error(`[onlyoffice] request failed: ${(err as Error).message}`);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: 1 }));
      });
    });
    srv.on("error", (err) => {
      log.error(`[onlyoffice] bridge server error: ${err.message}`);
      reject(err);
    });
    srv.listen(0, "0.0.0.0", () => {
      if (generation !== serverGeneration) {
        srv.close(); reject(new Error("OnlyOffice bridge closed during startup")); return;
      }
      server = srv;
      port = (srv.address() as AddressInfo).port;
      log.info(`[onlyoffice] bridge listening on 0.0.0.0:${port}`);
      resolve(port);
    });
  });
  serverStarting = pending;
  const clear = () => { if (serverStarting === pending) serverStarting = null; };
  void pending.then(clear, clear);
  return pending;
}

/** 最终退出清理；必须先 await flushOnlyOfficeSessions，失败则不得退出。 */
export function shutdownOnlyOfficeBridge(): void {
  // The application must await flushOnlyOfficeSessions before this final teardown.
  serverGeneration++;
  server?.closeAllConnections();
  server?.close();
  server = null;
  port = 0;
  serverStarting = null;
  for (const session of sessionsByKey.values()) {
    settleSave(session, undefined, { ok: false, error: "OnlyOffice bridge closed" }, true);
  }
  sessionsByKey.clear();
  sessionsByToken.clear();
}

export function hasOnlyOfficeSessions(): boolean {
  return sessionsByKey.size > 0;
}

function retireSession(session: EditSession): void {
  session.state.alive = false;
  if (sessionsByKey.get(session.key) === session) sessionsByKey.delete(session.key);
  if (sessionsByToken.get(session.token) === session) sessionsByToken.delete(session.token);
}

function settleSave(session: EditSession, id: string | undefined, result: SaveResult, final = false): void {
  if (final) for (const done of [...session.waiters.values()]) done(result);
  else if (id !== undefined) session.waiters.get(id)?.(result);
}

function waitForSave(session: EditSession, id: string, timeoutMs: number) {
  let finish!: (result: SaveResult) => void;
  const promise = new Promise<SaveResult>((resolve) => {
    const timer = setTimeout(() => finish({ ok: false, error: "OnlyOffice save callback timed out" }), timeoutMs);
    finish = (result) => {
      clearTimeout(timer); session.waiters.delete(id); resolve(result);
    };
    session.waiters.set(id, finish);
  });
  return { promise, finish };
}

/** Save before shutdown, not after the HTTP callback bridge has been destroyed. */
export async function flushOnlyOfficeSessions(timeoutMs = 30_000): Promise<void> {
  const active = [...sessionsByKey.values()].filter((session) => session.serverSeen && session.mode === "edit");
  const results = await Promise.all(active.map(async (session): Promise<SaveResult> => {
    if (session.finalized) return { ok: session.state.lastError === null, error: session.state.lastError ?? undefined };
    // A destroyed editor produces its final callback after the DS save delay.
    // Do not replace that final save with an earlier, non-final force-save snapshot.
    if (session.references === 0) {
      const pending = waitForSave(session, `final-${randomBytes(16).toString("hex")}`, timeoutMs);
      return pending.promise;
    }
    return forceSave(session.key, timeoutMs);
  }));
  const failure = results.find((result) => !result.ok);
  if (failure) throw new Error(failure.error ?? "OnlyOffice save failed");
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const m = /^\/onlyoffice\/(file|callback)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (!m) {
    res.writeHead(404);
    res.end();
    return;
  }
  const [, kind, token] = m as unknown as [string, "file" | "callback", string];
  const session = sessionsByToken.get(token);
  if (!session) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (kind === "file") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    await serveFile(session, req, res);
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }
  await handleCallback(session, req, res);
}

async function serveFile(session: EditSession, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!findContainingWorkspaceRoot(session.filePath)) { res.writeHead(403); res.end(); return; }
  session.serverSeen = true;
  const st = await stat(session.filePath).catch(() => null);
  if (!st || !st.isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(st.size),
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(basename(session.filePath))}`,
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await new Promise<void>((resolve) => {
    const stream = createReadStream(session.filePath);
    stream.on("error", () => {
      res.destroy();
      resolve();
    });
    stream.on("end", resolve);
    stream.pipe(res);
  });
}

function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("callback body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface CallbackBody {
  key?: string;
  status?: number;
  url?: string;
  token?: string;
  userdata?: string;
  payload?: CallbackBody;
}

/**
 * DS 回调。状态码（官方文档）：
 *   0 没找到文档 / 1 正在编辑 / 2 已就绪待保存 / 3 保存出错 / 4 关闭且无改动 /
 *   6 正在编辑但收到强制保存 / 7 强制保存出错。
 *
 * 只有 2 和 6 带着可下载的 `url`。
 */
async function handleCallback(session: EditSession, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, error: number, message?: string) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error, ...(message ? { message } : {}) }));
  };
  let body: CallbackBody;
  try {
    const parsed: unknown = JSON.parse(await readBody(req));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid callback");
    body = parsed as CallbackBody;
  } catch {
    reply(400, 1, "invalid json"); return;
  }
  const secret = getOnlyOfficeConfig().jwtSecret;
  if (secret) {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const tok = typeof body.token === "string" ? body.token : bearer;
    const payload = tok ? verifyJwt(tok, secret) : null;
    if (!payload) { reply(403, 1, "invalid token"); return; }
    // Never merge an unsigned URL/status from the outer body with a valid token.
    const signed = payload.payload ?? payload;
    if (!signed || typeof signed !== "object" || Array.isArray(signed)) { reply(403, 1, "invalid signed body"); return; }
    body = signed as CallbackBody;
  }
  if (body.key !== session.key || typeof body.status !== "number"
    || ![1, 2, 3, 4, 6, 7].includes(body.status)) {
    reply(400, 1, "invalid document callback"); return;
  }
  if (session.mode === "view" && (body.status === 2 || body.status === 6)) {
    reply(403, 1, "read-only session cannot save"); return;
  }
  session.serverSeen = true;
  const status = body.status;
  const requestId = typeof body.userdata === "string" ? body.userdata : undefined;
  session.state.lastStatus = status;
  if (status === 1) session.finalized = false;
  if (status === 2 || status === 6) {
    if (typeof body.url !== "string" || !body.url) { reply(400, 1, "missing save URL"); return; }
    const url = body.url;
    const saved = session.writing.then(async () => {
      if (session.finalized) return true; // a delayed force-save cannot replace a final version
      const ok = await writeBack(session, url);
      if (ok && status === 2) {
        session.finalized = true;
        if (session.references === 0) retireSession(session);
      }
      return ok;
    });
    session.writing = saved.then(() => undefined, () => undefined);
    const ok = await saved;
    const result: SaveResult = { ok, ...(ok ? {} : { error: session.state.lastError ?? "write-back failed" }) };
    settleSave(session, requestId, result, status === 2);
    reply(ok ? 200 : 500, ok ? 0 : 1, result.error);
    return;
  }
  if (status === 3 || status === 7) {
    session.state.lastError = `Document Server reported save error (status ${status})`;
    settleSave(session, requestId, { ok: false, error: session.state.lastError }, status === 3);
    reply(500, 1, session.state.lastError); return;
  }
  if (status === 4) {
    await session.writing;
    if (session.state.lastError) { reply(500, 1, session.state.lastError); return; }
    session.finalized = true;
    settleSave(session, undefined, { ok: true }, true);
    if (session.references === 0) retireSession(session);
  }
  reply(200, 0);
}

function differsFromSession(session: EditSession, st: { mtimeMs: number; size: number }): boolean {
  return st.mtimeMs !== session.disk.mtimeMs || st.size !== session.disk.size;
}

/** `报告.docx` → `报告 (冲突副本 20261002-153012).docx`,和原文件放在一起。 */
function conflictCopyPath(filePath: string): string {
  const ext = extname(filePath);
  const stem = basename(filePath, ext);
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return join(dirname(filePath), `${stem} (冲突副本 ${stamp})${ext}`);
}

/** 下载 DS 给的新版本，临时文件 + rename 原子替换原文件。 */
async function writeBack(session: EditSession, url: string): Promise<boolean> {
  let ownedTemp: string | null = null;
  try {
    if (!findContainingWorkspaceRoot(session.filePath)) throw new Error("Document path is no longer in an authorized workspace");
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`download ${resp.status}`);
    const bytes = Buffer.from(await resp.arrayBuffer());
    if (bytes.length === 0) throw new Error("download empty");
    const dir = dirname(session.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${basename(session.filePath)}.onlyoffice-${randomBytes(16).toString("hex")}.tmp`);
    const file = await open(tmp, "wx", 0o600);
    ownedTemp = tmp;
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    // 编辑器打开(或我们上次落盘)之后,原文件被别人改过(多半是 AI 写了它)?
    // 那就**不能**用编辑器里这份整篇替换 —— 那是旧内容加用户的改动,一盖就把别人的
    // 修改冲掉了。改为另存一份冲突副本,原文件不动,界面提示用户。
    const now = await stat(session.filePath).catch(() => null);
    const externallyChanged = now !== null && differsFromSession(session, now);
    const target = externallyChanged
      ? (session.conflictPath ??= conflictCopyPath(session.filePath))
      : session.filePath;
    session.inWriteBack = true;
    try {
      await rename(tmp, target);
      ownedTemp = null;
      if (externallyChanged) {
        session.state.conflictCopyPath = target;
        log.warn(`[onlyoffice] ${session.filePath} changed on disk while open; saved to conflict copy ${target}`);
      } else {
        // 这一次落盘是**我们**干的：记下新的 mtime/size，免得它被当成"别人改的"。
        const after = await stat(session.filePath).catch(() => null);
        if (after) session.disk = { mtimeMs: after.mtimeMs, size: after.size };
      }
    } finally {
      session.inWriteBack = false;
    }
    session.state.lastSavedAt = Date.now();
    session.state.lastError = null;
    log.info(`[onlyoffice] saved ${target} (${bytes.length} bytes)`);
    return true;
  } catch (err) {
    session.state.lastError = (err as Error).message;
    log.error(`[onlyoffice] write-back failed for ${session.filePath}: ${(err as Error).message}`);
    return false;
  } finally {
    if (ownedTemp) await unlink(ownedTemp).catch(() => undefined);
  }
}

/* ───────────────────────── 对外 API ───────────────────────── */

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/** DS 回连时用的主机：见契约里 `callbackHost` 的说明。 */
function resolveCallbackHost(cfg: OnlyOfficeConfig): string {
  if (cfg.callbackHost) return cfg.callbackHost;
  try {
    if (isLoopbackHost(new URL(cfg.serverUrl).hostname)) return "127.0.0.1";
  } catch {
    /* 落到下面 */
  }
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "127.0.0.1";
}

export async function openOnlyOfficeSession(
  filePath: string,
  opts: {
    lang: string;
    dark: boolean;
    userName: string;
    mode?: "edit" | "view";
    deviceType?: "desktop" | "mobile";
  },
): Promise<OnlyOfficeOpenResult> {
  const mode = opts.mode ?? "edit";
  const deviceType = opts.deviceType ?? "desktop";
  const cfg = getOnlyOfficeConfig();
  if (!cfg.serverUrl) return { ok: false, notConfigured: true, error: "OnlyOffice Document Server not configured" };
  if (!findContainingWorkspaceRoot(filePath)) {
    return { ok: false, error: `path outside every workspace root: ${filePath}` };
  }
  const ext = extname(filePath).slice(1).toLowerCase();
  const documentType = ONLYOFFICE_EDITABLE[ext] ?? ONLYOFFICE_VIEW_ONLY[ext];
  if (!documentType) return { ok: false, error: `unsupported file type: .${ext}` };
  if (mode === "edit" && ext in ONLYOFFICE_VIEW_ONLY) {
    return { ok: false, error: `read-only Office format: .${ext}` };
  }
  const st = await stat(filePath).catch(() => null);
  if (!st || !st.isFile()) return { ok: false, error: `file not found: ${filePath}` };

  const bridgePort = await ensureServer();
  // 还活着的同文件会话:没结束的,或者**还有编辑器握着它**的(引用计数 > 0)。
  //
  // 后半句是给渲染端的编辑器池用的:文档存过一次(status 2)就 finalized,但只要
  // 那个 iframe 还留着,它就仍然是这份文档的主人 —— 这时必须把同一个 key 还给它,
  // 否则会凭空多出一个会话,而缓存的编辑器再也对不上号。
  const candidate = [...sessionsByKey.values()].find(
    (s) => s.filePath === filePath && s.mode === mode && (!s.finalized || s.references > 0),
  );
  // 复用的会话：它上次落盘之后，磁盘上的东西还是不是它写的那份。
  const externallyChanged = candidate
    ? !candidate.inWriteBack && differsFromSession(candidate, st)
    : false;
  // 被别人改过的就**不复用**:那个会话里(DS 按 key 缓存着)是旧内容。新开一个会话
  // (新内容 → 新 key)才能看到磁盘上的新版本;旧会话之后若还回调保存,会落到冲突
  // 副本里(见 writeBack),不会盖掉新内容。
  const existing = externallyChanged ? undefined : candidate;
  // key：路径 + 内容哈希（见文件头）。已经开着的会话沿用它自己的 key —— 那时
  // 磁盘上的内容可能正被 DS 改着，重算只会得到一个对不上的新 key。
  const contentKey = existing?.key ?? await documentKey(filePath, st.mtimeMs, st.size);
  const key = existing?.key ?? `${contentKey}.${mode}`;
  // 同一份文件已经开着一个会话（比如两个标签）→ 复用，别再发一枚令牌
  let session = existing ?? sessionsByKey.get(key);
  if (!session) {
    session = {
      key,
      token: randomBytes(32).toString("base64url"),
      filePath,
      ext,
      mode,
      state: { alive: true, lastSavedAt: null, lastError: null, lastStatus: null },
      references: 0,
      serverSeen: false,
      finalized: false,
      disk: { mtimeMs: st.mtimeMs, size: st.size },
      inWriteBack: false,
      conflictPath: null,
      writing: Promise.resolve(),
      forcing: Promise.resolve(),
      waiters: new Map(),
    };
    sessionsByKey.set(key, session);
    sessionsByToken.set(session.token, session);
  }
  session.references++;
  session.finalized = false;

  const host = resolveCallbackHost(cfg);
  const base = `http://${host}:${bridgePort}/onlyoffice`;
  const config: Record<string, unknown> = {
    type: deviceType,
    width: "100%",
    height: "100%",
    documentType,
    document: {
      fileType: ext,
      key,
      title: basename(filePath),
      url: `${base}/file/${session.token}`,
      permissions: {
        edit: mode === "edit",
        download: true,
        print: true,
        comment: mode === "edit",
        review: mode === "edit",
        fillForms: mode === "edit",
        copy: true,
      },
    },
    editorConfig: {
      mode,
      lang: opts.lang,
      ...(mode === "edit" ? { callbackUrl: `${base}/callback/${session.token}` } : {}),
      user: { id: "mcode-local", name: opts.userName },
      customization: {
        // 停止输入后自动存（DS 侧默认也是开的，显式写出来免得被服务端配置盖掉）
        autosave: true,
        // 允许 Command Service 的 forcesave（Ctrl+S / 我们的保存按钮）
        forcesave: true,
        compactHeader: true,
        compactToolbar: false,
        hideRightMenu: false,
        toolbarNoTabs: false,
        uiTheme: opts.dark ? "theme-dark" : "theme-light",
        plugins: false,
        macros: false,
        // 嵌在 Mcode 里，DS 自己那套"关于/反馈/去官网"没有意义
        about: false,
        feedback: false,
        help: false,
        // 编辑器内没有别的文件可打开，"打开位置"这类按钮指不到任何地方
        goback: false,
      },
    },
  };
  if (cfg.jwtSecret) config.token = signJwt(config, cfg.jwtSecret);

  return {
    ok: true,
    apiScriptUrl: `${cfg.serverUrl}/web-apps/apps/api/documents/api.js`,
    sessionKey: key,
    config,
    reusedSession: Boolean(existing),
    externallyChanged,
  };
}

/** 渲染端每 2 秒问一次,同步 stat 一下足够便宜。读不到(被删)不算"被改"。 */
function hasExternalChange(session: EditSession): boolean {
  if (session.inWriteBack) return false;
  try {
    return differsFromSession(session, statSync(session.filePath));
  } catch {
    return false;
  }
}

export function getOnlyOfficeSessionState(key: string): OnlyOfficeSessionState {
  const s = sessionsByKey.get(key);
  const freeMemMB = Math.round(freemem() / (1024 * 1024));
  return s
    ? { ...s.state, freeMemMB, externalChange: s.mode === "edit" && hasExternalChange(s) }
    : { alive: false, lastSavedAt: null, lastError: null, lastStatus: null, freeMemMB };
}

export function closeSession(key: string): boolean {
  const session = sessionsByKey.get(key);
  if (!session) return false;
  session.references = Math.max(0, session.references - 1);
  // DS sends its final status 2/4 after destroyEditor, not synchronously with it.
  // Preserve failed saves for retry; never expire the only usable callback token.
  if (session.references === 0 && (session.mode === "view" || session.finalized || !session.serverSeen)) retireSession(session);
  return true;
}

/**
 * Command Service `forcesave`：让 DS 立刻回调一次（status 6）。
 * 返回 DS 的 error 码：0 成功 / 4 文档没改动 / 其余见官方文档。
 */
export async function forceSave(key: string, timeoutMs = 30_000): Promise<SaveResult> {
  const session = sessionsByKey.get(key);
  if (!session) return { ok: false, error: "session not found" };
  if (session.mode === "view") return { ok: false, error: "read-only session" };
  const task = session.forcing.then(async (): Promise<SaveResult> => {
    if (session.finalized) return { ok: session.state.lastError === null, error: session.state.lastError ?? undefined };
    const cfg = getOnlyOfficeConfig();
    if (!cfg.serverUrl) return { ok: false, error: "not configured" };
    const id = randomBytes(16).toString("hex");
    const unsigned = { c: "forcesave", key, userdata: id };
    const payload: Record<string, unknown> = { ...unsigned };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.jwtSecret) {
      payload.token = signJwt(unsigned, cfg.jwtSecret);
      headers.Authorization = `Bearer ${signJwt({ payload: unsigned }, cfg.jwtSecret)}`;
    }
    // userdata is echoed by DS. A different/older save must not acknowledge this request.
    const saved = waitForSave(session, id, timeoutMs);
    try {
      const resp = await fetch(`${cfg.serverUrl}/coauthoring/CommandService.ashx`, {
        method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) throw new Error(`Command Service HTTP ${resp.status}`);
      const data = (await resp.json()) as { error?: number };
      if (data.error === 4) {
        await session.writing;
        saved.finish({ ok: session.state.lastError === null, error: session.state.lastError ?? undefined });
      } else if (data.error !== 0) {
        saved.finish({ ok: false, error: `Command Service error ${data.error}` });
      }
      // error=0 acknowledges the command only, not a completed local file save.
      return await saved.promise;
    } catch (err) {
      const result = { ok: false, error: (err as Error).message };
      saved.finish(result); return result;
    }
  });
  session.forcing = task.then(() => undefined, () => undefined);
  return task;
}

/** 设置页的连通性探测：DS 的 `/healthcheck` 返回字面量 `true`。 */
export async function probeOnlyOffice(): Promise<OnlyOfficeStatusResult> {
  const cfg = getOnlyOfficeConfig();
  if (!cfg.serverUrl) return { configured: false, reachable: false, serverUrl: "" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(`${cfg.serverUrl}/healthcheck`, { signal: ctrl.signal });
    clearTimeout(timer);
    const text = (await resp.text()).trim();
    if (resp.ok && text === "true") return { configured: true, reachable: true, serverUrl: cfg.serverUrl };
    return { configured: true, reachable: false, serverUrl: cfg.serverUrl, error: `healthcheck ${resp.status}: ${text.slice(0, 80)}` };
  } catch (err) {
    return { configured: true, reachable: false, serverUrl: cfg.serverUrl, error: (err as Error).message };
  }
}
