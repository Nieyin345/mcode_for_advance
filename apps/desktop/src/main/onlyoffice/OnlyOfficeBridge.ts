/**
 * OnlyOffice Document Server 桥 —— 主进程这一半。
 *
 * 职责只有三件（契约见 `@contracts/ipc` 的 `onlyoffice.ts` 文件头）：
 *
 *  1. **起一个本机 HTTP 服务**（随机端口，监听 `0.0.0.0` —— Docker 里的 DS 要从
 *     宿主机 IP 打进来，绑 127.0.0.1 它够不着）。每个编辑会话一枚 32 字节随机令牌，
 *     URL 里只出现令牌，不出现路径。令牌随会话关闭而失效。
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
 * 文件变了。所以 key 由 `路径 + mtime + size` 哈希而来 —— 我们每写回一次 mtime 就变，
 * 下次打开自然是新 key；Agent 在外面改了文件也一样。
 *
 * ## 路径闸门
 *
 * 与 `file:readFile` 同一道：`findContainingWorkspaceRoot`（项目根 ∪ 会话 worktree ∪
 * 文献库/模版库）。令牌只是"这条 URL 对应哪个文件"的索引，不是权限。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_ONLYOFFICE_CONFIG,
  ONLYOFFICE_CONFIG_SETTING_KEY,
  ONLYOFFICE_EDITABLE,
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
  state: OnlyOfficeSessionState;
  /** 同一会话的两次回调可能并发（2 之后紧跟 6）—— 写回串行化。 */
  writing: Promise<void>;
}

const sessionsByKey = new Map<string, EditSession>();
const sessionsByToken = new Map<string, EditSession>();

/* ───────────────────────── HTTP 桥 ───────────────────────── */

let server: Server | null = null;
let port = 0;

function ensureServer(): Promise<number> {
  if (server && port) return Promise.resolve(port);
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      void handleRequest(req, res).catch((err) => {
        log.error(`[onlyoffice] request failed: ${(err as Error).message}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    srv.on("error", (err) => {
      log.error(`[onlyoffice] bridge server error: ${err.message}`);
      if (!port) reject(err);
    });
    srv.listen(0, "0.0.0.0", () => {
      server = srv;
      port = (srv.address() as AddressInfo).port;
      log.info(`[onlyoffice] bridge listening on 0.0.0.0:${port}`);
      resolve(port);
    });
  });
}

/** 应用退出时收掉。不 await —— 退出路径上没人等它。 */
export function shutdownOnlyOfficeBridge(): void {
  server?.close();
  server = null;
  port = 0;
  sessionsByKey.clear();
  sessionsByToken.clear();
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
  /** DS 用 JWT 时把整个 body 放在 payload 里 */
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
  const raw = await readBody(req);
  let body: CallbackBody;
  try {
    body = JSON.parse(raw) as CallbackBody;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: 1, message: "invalid json" }));
    return;
  }
  const secret = getOnlyOfficeConfig().jwtSecret;
  if (secret) {
    // DS 把 token 放 body.token，或 Authorization: Bearer <jwt>（header 里的 payload 含 body）
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const tok = body.token ?? bearer;
    const payload = tok ? verifyJwt(tok, secret) : null;
    if (!payload) {
      session.state.lastError = "callback JWT invalid";
      log.warn(`[onlyoffice] rejected callback for ${session.filePath}: bad JWT`);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 1, message: "invalid token" }));
      return;
    }
    // body.token 时 payload 就是 body；Authorization 时 payload.payload 才是
    const inner = (payload.payload as CallbackBody | undefined) ?? (payload as CallbackBody);
    if (inner.status != null) body = { ...body, ...inner };
  }
  const status = body.status ?? -1;
  session.state.lastStatus = status;

  if ((status === 2 || status === 6) && body.url) {
    const url = body.url;
    session.writing = session.writing.then(() => writeBack(session, url)).catch(() => undefined);
    await session.writing;
  } else if (status === 3 || status === 7) {
    session.state.lastError = `Document Server reported save error (status ${status})`;
    log.error(`[onlyoffice] DS save error status=${status} file=${session.filePath}`);
  } else if (status === 4) {
    // 关闭且无改动 —— 会话结束，令牌可以收了（渲染端 close 也会再收一次，幂等）
    closeSession(session.key);
  }
  // ⚠️ 一律回 error:0 —— 我们自己的写回失败已记在 state 里给界面看；回非 0 只会让
  //    DS 一直重试同一个 url 并把编辑器锁成"保存失败"。
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: 0 }));
}

/** 下载 DS 给的新版本，临时文件 + rename 原子替换原文件。 */
async function writeBack(session: EditSession, url: string): Promise<void> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download ${resp.status}`);
    const bytes = Buffer.from(await resp.arrayBuffer());
    if (bytes.length === 0) throw new Error("download empty");
    const dir = dirname(session.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${basename(session.filePath)}.onlyoffice-${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(tmp, bytes);
    try {
      await rename(tmp, session.filePath);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    session.state.lastSavedAt = Date.now();
    session.state.lastError = null;
    log.info(`[onlyoffice] saved ${session.filePath} (${bytes.length} bytes)`);
  } catch (err) {
    session.state.lastError = (err as Error).message;
    log.error(`[onlyoffice] write-back failed for ${session.filePath}: ${(err as Error).message}`);
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
  opts: { lang: string; dark: boolean; userName: string },
): Promise<OnlyOfficeOpenResult> {
  const cfg = getOnlyOfficeConfig();
  if (!cfg.serverUrl) return { ok: false, notConfigured: true, error: "OnlyOffice Document Server not configured" };
  if (!findContainingWorkspaceRoot(filePath)) {
    return { ok: false, error: `path outside every workspace root: ${filePath}` };
  }
  const ext = extname(filePath).slice(1).toLowerCase();
  const documentType = ONLYOFFICE_EDITABLE[ext];
  if (!documentType) return { ok: false, error: `unsupported file type: .${ext}` };
  const st = await stat(filePath).catch(() => null);
  if (!st || !st.isFile()) return { ok: false, error: `file not found: ${filePath}` };

  const bridgePort = await ensureServer();
  // key：路径 + mtime + size（见文件头）。DS 限制 [0-9a-zA-Z.=_-]、≤128 字符。
  const key = createHash("sha1")
    .update(`${filePath}|${st.mtimeMs}|${st.size}`)
    .digest("hex")
    .slice(0, 40);
  // 同一份文件已经开着一个会话（比如两个标签）→ 复用，别再发一枚令牌
  let session = sessionsByKey.get(key);
  if (!session) {
    session = {
      key,
      token: randomBytes(32).toString("base64url"),
      filePath,
      ext,
      state: { alive: true, lastSavedAt: null, lastError: null, lastStatus: null },
      writing: Promise.resolve(),
    };
    sessionsByKey.set(key, session);
    sessionsByToken.set(session.token, session);
  }

  const host = resolveCallbackHost(cfg);
  const base = `http://${host}:${bridgePort}/onlyoffice`;
  const config: Record<string, unknown> = {
    type: "desktop",
    width: "100%",
    height: "100%",
    documentType,
    document: {
      fileType: ext,
      key,
      title: basename(filePath),
      url: `${base}/file/${session.token}`,
      permissions: {
        edit: true,
        download: true,
        print: true,
        comment: true,
        review: true,
        fillForms: true,
        copy: true,
      },
    },
    editorConfig: {
      mode: "edit",
      lang: opts.lang,
      callbackUrl: `${base}/callback/${session.token}`,
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
  };
}

export function getOnlyOfficeSessionState(key: string): OnlyOfficeSessionState {
  const s = sessionsByKey.get(key);
  return s ? { ...s.state } : { alive: false, lastSavedAt: null, lastError: null, lastStatus: null };
}

export function closeSession(key: string): boolean {
  const s = sessionsByKey.get(key);
  if (!s) return false;
  s.state.alive = false;
  sessionsByKey.delete(key);
  sessionsByToken.delete(s.token);
  return true;
}

/**
 * Command Service `forcesave`：让 DS 立刻回调一次（status 6）。
 * 返回 DS 的 error 码：0 成功 / 4 文档没改动 / 其余见官方文档。
 */
export async function forceSave(key: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = getOnlyOfficeConfig();
  if (!cfg.serverUrl) return { ok: false, error: "not configured" };
  if (!sessionsByKey.has(key)) return { ok: false, error: "session not found" };
  const payload: Record<string, unknown> = { c: "forcesave", key };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.jwtSecret) {
    payload.token = signJwt({ c: "forcesave", key }, cfg.jwtSecret);
    headers.Authorization = `Bearer ${signJwt({ payload: { c: "forcesave", key } }, cfg.jwtSecret)}`;
  }
  try {
    const resp = await fetch(`${cfg.serverUrl}/coauthoring/CommandService.ashx`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const data = (await resp.json()) as { error?: number };
    // 4 = "no changes" —— 对用户来说就是"已经是最新的"，不算失败
    if (data.error === 0 || data.error === 4) return { ok: true };
    return { ok: false, error: `Command Service error ${data.error}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
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
