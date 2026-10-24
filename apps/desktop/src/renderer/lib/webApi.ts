/**
 * webApi — the HTTP/SSE transport shim that replaces `window.api` when the
 * shared renderer bundle runs in a plain browser (the phone).
 *
 * The desktop renderer gets `window.api` injected by the preload bridge; in a
 * phone browser there is no preload, so `main.tsx` detects the absence and
 * installs the object created here instead. Everything else — sessionStore,
 * components, all the PC-side optimizations — is the same code.
 *
 * Transport:
 *  - RPC: `POST /api/rpc { method, input }` with `Authorization: Bearer
 *    <deviceToken>`. Only the whitelisted method set (see main/mobile/mobileRpc)
 *    is served; anything else 404s.
 *  - Events: one SSE stream (`/api/events?token=…`) carrying the same
 *    `RuntimeEvent` union the desktop receives over `claude:event`. The bus
 *    deliberately keeps no buffer: a missed delta is recovered on the next
 *    message hydration (the store re-fetches the session snapshot), same as
 *    the desktop reconnect path.
 *
 * Auth: the device token is issued once at pairing (QR + 6-digit code, see
 * {@link pairWithCode}) and lives in localStorage. A 401 anywhere clears it so
 * the pairing gate re-appears instead of looping on dead credentials.
 *
 * Desktop-only surface (terminal / browser / shell / dialogs / app updates /
 * secrets management) is intentionally unsupported: it is either answered by
 * `webUnsupported` (an explicit, localised error) or — for namespaces the
 * mobile shell never mounts — absent, in which case the proxy fallback turns
 * any call into the same clear "not available in web mode" error. Namespaces
 * that ARE reachable from the shared component tree (see the `automation` …
 * `usage` block below) are spelled out method-by-method on purpose: the
 * proxy only catches *unlisted names*, so one missing method inside a listed
 * object would surface as a bare `undefined is not a function` — and React 19
 * unmounts the whole tree when a shared effect hits that.
 */
import type { Api } from "../../preload/index.js";
import { IPC } from "@contracts/ipc";
import type { Locale, PickedImage, TerminalInfo } from "@contracts/ipc";
import type { RuntimeEvent } from "@contracts/runtime";
import { isDeviceLocalSettingKey } from "@contracts/ipc/settingsSync";
import type { ThemeState } from "./theme.js";
import type {
  MobileRpcResponse,
  PairingVerifyInput,
  PairingVerifyResult,
} from "@contracts/mobile";
import { translate } from "@renderer/lib/i18n/core.js";

const TOKEN_KEY = "mcode-web-token";
const ENDPOINT_KEY = "mcode-web-endpoint";
const THEME_KEY = "mcode-web-theme";

/** Current UI language for error messages. This module must NOT import
 *  sessionStore: lib/api.ts constructs `createWebApi()` during module
 *  evaluation, and the store imports api.ts — a store import here would form
 *  a module-evaluation cycle that crashes phone boot in TDZ. The store keeps
 *  `<html lang>` in sync with the locale at hydrate and on every switch
 *  (defaulting to zh when unset), which is exactly what we need at error
 *  time — long after boot. */
function uiLocale(): Locale {
  return document.documentElement.lang === "en" ? "en" : "zh";
}

/** Cap for user-picked images (mirrors the desktop picker's main-side cap and
 *  the SendTurnImageSchema 6M-char ceiling). */
const PICK_IMAGE_MAX_CHARS = 6_000_000;

/* ────────────────────────── auth / pairing ────────────────────────── */

function readAuth(): { token: string | null; endpoint: string | null } {
  try {
    return {
      token: localStorage.getItem(TOKEN_KEY),
      endpoint: localStorage.getItem(ENDPOINT_KEY),
    };
  } catch {
    return { token: null, endpoint: null };
  }
}

function writeAuth(token: string, endpoint: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ENDPOINT_KEY, endpoint);
  } catch {
    // private mode etc. — the pairing gate will just re-appear on reload
  }
}

/** True when this browser holds a device token (pairing completed). */
export function isPaired(): boolean {
  return !!readAuth().token;
}

/** Subscribers notified whenever the device token is dropped — a 401 in `rpc`
 *  (the PC removed the device, or restarted with a fresh DB) or an explicit
 *  logout in settings. The phone shell subscribes so it falls back to the
 *  pairing screen instead of looping on dead credentials. */
const authLostSubs = new Set<() => void>();

/** Subscribe to device-auth loss. Returns an unsubscribe. */
export function onAuthLost(cb: () => void): () => void {
  authLostSubs.add(cb);
  return () => {
    authLostSubs.delete(cb);
  };
}

/** Drop the local device token — back to the pairing gate. Notifies
 *  `onAuthLost` subscribers so the shell can re-show the pairing screen. */
export function clearAuth(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    // ignore
  }
  for (const fn of authLostSubs) {
    try {
      fn();
    } catch {
      // a subscriber throwing must not block the others
    }
  }
}

/** The LAN endpoint the server reported at pairing time (diagnostics only —
 *  all API calls are same-origin relative paths). */
export function getPairEndpoint(): string | null {
  return readAuth().endpoint;
}

/** Complete pairing: exchange the nonce + 6-digit code for a device token.
 *  The nonce came from the QR URL (`?nonce=…`); the code is typed on the
 *  phone and displayed on the PC. */
export async function pairWithCode(input: PairingVerifyInput): Promise<PairingVerifyResult> {
  const res = await fetch("/api/pair/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      body.error ?? translate(uiLocale(), "lib.web.pairFailed", { status: res.status }),
    );
  }
  const result = (await res.json()) as PairingVerifyResult;
  writeAuth(result.deviceToken, result.endpoint);
  return result;
}

/** 电脑端开没开「账号密码登录」(无需令牌)。拿不到就当没开。 */
export async function fetchAuthMethods(): Promise<{ password: boolean }> {
  try {
    const res = await fetch("/api/auth/methods");
    if (!res.ok) return { password: false };
    const body = (await res.json().catch(() => null)) as { password?: unknown } | null;
    return { password: body?.password === true };
  } catch {
    return { password: false };
  }
}

/** 账号密码登录:换一张和配对一样的设备令牌(不需要电脑端的二维码 / 验证码)。 */
export async function loginWithPassword(input: {
  username: string;
  password: string;
  deviceName: string;
}): Promise<PairingVerifyResult> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      body.error ?? translate(uiLocale(), "lib.web.pairFailed", { status: res.status }),
    );
  }
  const result = (await res.json()) as PairingVerifyResult;
  writeAuth(result.deviceToken, result.endpoint);
  return result;
}

/** Lightweight connectivity probe — no auth required. */
export async function webHealth(): Promise<boolean> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return !!body?.ok;
  } catch {
    return false;
  }
}

/* ────────────────────────── RPC core ────────────────────────── */

/** Per-method client-side deadlines (ms). Without one, a request stalled by a
 * restarting PC or a LAN hiccup leaves the Promise pending forever — and any
 * loading spinner bound to it spinning with no error to surface. */
const RPC_TIMEOUT_MS: Record<string, number> = {
  // Drives a 60s-abort SDK query server-side (commit-message generation) —
  // budget the client slightly above that so the server's own error (which
  // carries the real cause) wins the race over the generic timeout.
  "git:generateCommitMessage": 75_000,
};
const RPC_DEFAULT_TIMEOUT_MS = 30_000;

async function rpc<T = unknown>(method: string, input?: unknown): Promise<T> {
  const { token } = readAuth();
  if (!token)
    throw new Error(translate(uiLocale(), "lib.web.notPaired"));
  const timeoutMs = RPC_TIMEOUT_MS[method] ?? RPC_DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const ac = new AbortController();
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  try {
    const res = await fetch("/api/rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ method, input }),
      signal: ac.signal,
    });
    if (res.status === 401) {
      // Token revoked on the PC side — clear local auth so the pairing screen
      // reappears instead of silently looping on bad credentials.
      clearAuth();
      throw new Error(translate(uiLocale(), "lib.web.deviceRevoked"));
    }
    const envelope = (await res.json().catch(() => null)) as MobileRpcResponse | null;
    if (!envelope || !envelope.ok) {
      throw new Error(
        envelope && !envelope.ok
          ? envelope.error
          : translate(uiLocale(), "lib.web.rpcFailed", { status: res.status }),
      );
    }
    return envelope.result as T;
  } catch (err) {
    // Distinguish our deadline from any other abort/network failure so the
    // user gets an actionable message instead of an opaque "AbortError".
    if (timedOut) {
      throw new Error(
        translate(uiLocale(), "lib.web.timeout", {
          sec: Math.round(timeoutMs / 1000),
        }),
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Desktop-only stub: throws a clear error. Used for whitelisted-group
 *  members that exist on the desktop Api shape but have no web meaning. */
/** 手机端"这个命名空间不存在"的**标记** —— 调用方据此把"平台不支持"与"真失败"
 *  分开(后者要显式报错/重试,前者不该打扰用户)。`webUnsupported` 抛的 Error 带它。 */
export const WEB_UNSUPPORTED_MARKER = "mcode.webUnsupported";

export function isWebUnsupportedError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === WEB_UNSUPPORTED_MARKER;
}

function webUnsupported(name: string): never {
  const e = new Error(translate(uiLocale(), "lib.web.unavailable", { name })) as Error & { code?: string };
  e.code = WEB_UNSUPPORTED_MARKER;
  throw e;
}

/** Callable proxy standing in for an absent desktop-only namespace
 *  (`api.lsp`, `api.terminal`, …). It is itself callable, and every property
 *  access yields another such proxy, so the shared code's
 *  `api.<ns>.<method>()` shape surfaces one diagnosable error
 *  ("api.<ns>.<method> 在移动端不可用") instead of an opaque
 *  `TypeError: ... is not a function` (a bare function has no `.<method>`). */
function unsupportedNamespace(path: string): unknown {
  const callable = (): never => webUnsupported(path);
  return new Proxy(callable, {
    get: (_t, prop) =>
      typeof prop === "string" ? unsupportedNamespace(`${path}.${prop}`) : undefined,
  });
}

/* ────────────────────────── SSE event bus ────────────────────────── */

type RuntimeSubscriber = (e: RuntimeEvent) => void;
const runtimeSubscribers = new Set<RuntimeSubscriber>();
let sse: EventSource | null = null;

/**
 * 断线补齐。事件总线**不缓存**:断开期间推出去的事件(回合正文、会话 / 项目
 * 列表变动、设置变动)手机一条都收不到。服务端每次 (重)连上都先发一帧
 * `session.runningSnapshot`,它只救得回「哪些会话在跑」—— 缺掉的正文要重新从库里
 * 拉。所以:**第二帧及以后的快照** = 这是一次重连,通知订阅者去补
 * (`AppMobile` → `sessionStore.resyncAfterReconnect`)。
 */
let snapshotsSeen = 0;
const resyncSubs = new Set<() => void>();

/** 订阅「SSE 断过又连上了,该补数据了」。返回退订函数。 */
export function onSseResync(cb: () => void): () => void {
  resyncSubs.add(cb);
  return () => {
    resyncSubs.delete(cb);
  };
}

/** 页面在后台待了这么久,回到前台时不再相信那条连接,直接重建。iOS / 安卓会把
 *  后台页的连接悄悄挂起,回来时 `readyState` 还是 OPEN,但服务端那头早断了
 *  —— 不重建的话要等下一次心跳超时才发现,这期间什么都收不到。 */
const SSE_STALE_AFTER_HIDDEN_MS = 20_000;
/** EventSource 自己放弃(CLOSED)之后,我们重建的退避:1s 起,翻倍,封顶 30s。 */
const SSE_RETRY_MIN_MS = 1_000;
const SSE_RETRY_MAX_MS = 30_000;
let sseRetryMs = SSE_RETRY_MIN_MS;
let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
let sseHiddenAt: number | null = null;
let sseVisibilityHooked = false;

function restartSse(): void {
  if (sse) sse.close();
  sse = null;
  if (runtimeSubscribers.size > 0) ensureSse();
}

function scheduleSseRestart(): void {
  if (sseRetryTimer) return;
  const delay = sseRetryMs;
  sseRetryMs = Math.min(sseRetryMs * 2, SSE_RETRY_MAX_MS);
  sseRetryTimer = setTimeout(() => {
    sseRetryTimer = null;
    // 等待期间可能已经被别的路径(回到前台)重建好了。
    if (sse && sse.readyState !== EventSource.CLOSED) return;
    restartSse();
  }, delay);
}

function hookSseVisibility(): void {
  if (sseVisibilityHooked || typeof document === "undefined") return;
  sseVisibilityHooked = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      sseHiddenAt = Date.now();
      return;
    }
    const away = sseHiddenAt != null ? Date.now() - sseHiddenAt : 0;
    sseHiddenAt = null;
    if (!sse) return;
    if (sse.readyState === EventSource.CLOSED || away > SSE_STALE_AFTER_HIDDEN_MS) restartSse();
  });
}

function ensureSse(): void {
  if (sse) return;
  const { token } = readAuth();
  if (!token) return;
  hookSseVisibility();
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  sse = es;
  es.onmessage = (ev) => {
    let event: RuntimeEvent;
    try {
      event = (JSON.parse(ev.data as string) as { sessionId: string; event: RuntimeEvent }).event;
    } catch {
      return; // malformed frame — ignore
    }
    for (const fn of runtimeSubscribers) fn(event);
    if (event.type === "session.runningSnapshot") {
      sseRetryMs = SSE_RETRY_MIN_MS; // 连上了,退避归零
      snapshotsSeen += 1;
      // 快照已经先交给 store 套用(running 集合是新的),再通知补数据。
      if (snapshotsSeen > 1) {
        for (const fn of resyncSubs) {
          try {
            fn();
          } catch {
            // 一个订阅者抛错不能挡住别的
          }
        }
      }
    }
  };
  // 短暂断线(Wi-Fi 抖一下)EventSource 自己会重连(readyState 回到 CONNECTING),
  // 不用管。只有它**放弃了**(CLOSED:服务端回了非 200,例如中继隧道断掉时的
  // 502)才需要我们退避重建 —— 否则这条流就永远停了,页面却看不出来。被撤销的
  // 设备(401)在下一次 RPC 时清掉令牌回到配对页,那之后 ensureSse 因为没令牌不再重建。
  es.onerror = () => {
    if (es !== sse) return;
    if (es.readyState === EventSource.CLOSED) scheduleSseRestart();
  };
}

function subscribeRuntime(fn: RuntimeSubscriber): () => void {
  runtimeSubscribers.add(fn);
  ensureSse();
  return () => {
    runtimeSubscribers.delete(fn);
  };
}

/* ────────────────────────── local (no-server) impls ────────────────────────── */

function themeGet(): Promise<ThemeState> {
  // ⚠️ **与 `themeSet` / `readAuth` 同款守卫。** `localStorage` 读时也会抛
  // (`SecurityError`:存储被禁 / 嵌入式上下文),而这条在手机端 boot 的 hydrate 路上被调
  // —— 抛出去会把整个手机壳卡住。同文件的 `themeSet` 早就 try 了,这一条漏了。
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    /* 存储不可用 —— 退回默认 system */
  }
  const theme: ThemeState["theme"] =
    stored === "dark" || stored === "light" || stored === "system" ? stored : "system";
  const effective: ThemeState["effective"] =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  return Promise.resolve({ theme, effective });
}

function themeSet(input: { theme: string }): Promise<ThemeState> {
  try {
    if (input.theme === "dark" || input.theme === "light" || input.theme === "system") {
      localStorage.setItem(THEME_KEY, input.theme);
    }
  } catch {
    // ignore
  }
  // Mirror the desktop handler: return the freshly-resolved state so callers
  // can apply it immediately without a second get.
  return themeGet();
}

/** Web stand-in for the OS image picker: a plain `<input type=file>`. Files
 *  are read locally (FileReader) into base64 — no server round-trip; the
 *  send-time normalization (imageResize.ts) applies downstream like desktop. */
function pickImagesWeb(): Promise<{ images: PickedImage[]; skipped: string[] }> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/jpeg,image/png,image/gif,image/webp";
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      const images: PickedImage[] = [];
      const skipped: string[] = [];
      void Promise.all(
        files.map(async (f) => {
          const mime = f.type.toLowerCase();
          if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) {
            skipped.push(f.name);
            return;
          }
          try {
            const buf = new Uint8Array(await f.arrayBuffer());
            let binary = "";
            const chunk = 0x8000;
            for (let i = 0; i < buf.length; i += chunk) {
              binary += String.fromCharCode(...buf.subarray(i, i + chunk));
            }
            const data = btoa(binary);
            if (data.length > PICK_IMAGE_MAX_CHARS) {
              skipped.push(f.name);
              return;
            }
            images.push({
              name: f.name,
              data,
              mimeType: mime as PickedImage["mimeType"],
            });
          } catch {
            skipped.push(f.name);
          }
        }),
      ).then(() => resolve({ images, skipped }));
    };
    input.oncancel = () => resolve({ images: [], skipped: [] });
    input.onerror = () =>
      reject(new Error(translate(uiLocale(), "lib.web.pickerFailed")));
    input.click();
  });
}

/** Copy an image data URL onto the clipboard via navigator.clipboard (the
 *  desktop goes through main because contextIsolation blocks this). */
async function writeImageWeb(input: { dataUrl: string }): Promise<{ ok: boolean; error?: string }> {
  try {
    const blob = await (await fetch(input.dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* ────────────────────────── group implementations ────────────────────────── */

const claude: Api["claude"] = {
  startSession: (input) => rpc("claude:startSession", input),
  // 侧聊列表要读电脑端那一轮运行的内存状态;手机端没有侧聊面板(`SideChatPanel`
  // 只挂在桌面工作流看板上),服务端的白名单也没有这条 handler → 显式不可用,
  // 而不是发一条注定 404 的 RPC。调用方(sessionStore.hydrateSideChats)有 try/catch。
  listSideChats: () => webUnsupported("claude.listSideChats"),
  sendTurn: (input) => rpc("claude:sendTurn", input),
  interrupt: (input) => rpc("claude:interrupt", input),
  // 手机上不支持插话(那一轮跑在桌面端,手机这边没有"正在跑的那一轮"这个概念),
  // 服务端白名单同样没有这条 handler。显式不可用 —— 调用方(sessionStore.injectPrompt)
  // 按那条规矩包了 try/catch,失败会退回普通的发送。
  inject: () => webUnsupported("claude.inject"),
  // 同理：停一个子代理要靠"正在跑的那一轮"的句柄，手机上够不到，白名单也没有这条。
  // 任务列表页在手机端也能打开，那一行只是停不了(调用方 catch 后会 toast)。
  stopTask: () => webUnsupported("claude.stopTask"),
  // 同理：bash 任务的输出文件在**桌面端那台机器**上，手机读不到，白名单也没有这条。
  readTaskOutput: () => webUnsupported("claude.readTaskOutput"),
  approve: (input) => rpc("claude:approve", input),
  respondQuestion: (input) => rpc("claude:respondQuestion", input),
  respondPlanApproval: (input) => rpc("claude:respondPlanApproval", input),
  rewindTurn: (input) => rpc("claude:rewindTurn", input),
  // 手机端没有设置页的子代理编辑器，服务端白名单也没有这条 —— 显式不可用。
  saveSubagents: () => webUnsupported("claude.saveSubagents"),
};

const project: Api["project"] = {
  create: () => webUnsupported("project.create"),
  list: () => rpc("project:list"),
  sessions: (input) => rpc("project:sessions", input),
  delete: (input) => rpc("project:delete", input),
  archive: (input) => rpc("project:archive", input),
  setGroup: (input) => rpc("project:setGroup", input),
  reorder: (input) => rpc("project:reorder", input),
  setPinned: (input) => rpc("project:pin", input),
  rename: (input) => rpc("project:rename", input),
};

const session: Api["session"] = {
  search: (input) => rpc("session:search", input),
  searchBookmarks: (input) => rpc("session:searchBookmarks", input),
  messages: (input) => rpc("session:messages", input),
  saveMessages: (input) => rpc("session:saveMessages", input),
  upsertMessages: (input) => rpc("session:upsertMessages", input),
  truncateAndInsertMessages: (input) => rpc("session:truncateAndInsertMessages", input),
  updateSettings: (input) => rpc("session:updateSettings", input),
  delete: (input) => rpc("session:delete", input),
  archive: (input) => rpc("session:archive", input),
  rename: (input) => rpc("session:rename", input),
  // 手机端**没有**分叉这个入口(AppMobile 的会话列表里不放它),服务端白名单也没有
  // `session:fork` —— 显式不可用(而不是发一条注定 "unknown method" 的 RPC)。
  // 调用方(sessionStore.forkSession)把 RPC 包在 try/catch 里并 toast 原因。
  fork: () => webUnsupported("session.fork"),
  pin: (input) => rpc("session:pin", input),
  updateBookmarks: (input) => rpc("session:updateBookmarks", input),
  listPinned: () => rpc("session:listPinned"),
  // `listAll` 是桌面「流式侧栏」(StreamSidebar)的分页源,手机壳不挂它,服务端白名单
  // 也没有这条 —— 显式不可用。手机侧的会话列表走 project:sessions / session:search。
  listAll: () => webUnsupported("session.listAll"),
  listNodes: (input) => rpc("session:listNodes", input),
  hasNodes: (input) => rpc("session:hasNodes", input),
};

const provider: Api["provider"] = {
  list: () => rpc("provider:list"),
  healthCheck: (input) => rpc("provider:healthCheck", input),
  // 引擎命令清单。手机端走同一条 RPC —— 命令清单属于"这个引擎能干什么"，
  // 与在不在电脑前无关（Claude 的那一份是本机 CLI 报的，所以手机上看到的是**电脑上**
  // 的清单；这台电脑没登录/没装，它就会抛，调用方按 memory 里那条规矩包 try/catch）。
  commands: (input) => rpc("provider:commands", input),
};

const customModel: Api["customModel"] = {
  list: () => rpc("customModel:list"),
  // 端点探测走主进程外连,手机端不做(同 piModels.listEndpointModels)。
  listEndpointModels: () => webUnsupported("customModel.listEndpointModels"),
  save: () => webUnsupported("customModel.save"),
  delete: () => webUnsupported("customModel.delete"),
  test: () => webUnsupported("customModel.test"),
  getToken: () => webUnsupported("customModel.getToken"),
};

/** 扩展桥:配对发生在 PC 上的浏览器里,手机端看不到也不该改 —— 但**必须显式列出**
 *  整个命名空间(见上面 workflow 那段注释里的规矩)。 */
const webBridge: Api["webBridge"] = {
  status: () => webUnsupported("webBridge.status"),
  regenerateToken: () => webUnsupported("webBridge.regenerateToken"),
};

/** 公网 MCP 端点:开关与密钥是 PC 上那个进程的事,手机端够不着也不该够着 ——
 *  同 webBridge,只显式列出、不实现(见上面那段规矩)。 */
const publicMcp: Api["publicMcp"] = {
  status: () => webUnsupported("publicMcp.status"),
  setEnabled: () => webUnsupported("publicMcp.setEnabled"),
  regenerateSecret: () => webUnsupported("publicMcp.regenerateSecret"),
  startTunnel: () => webUnsupported("publicMcp.startTunnel"),
  stopTunnel: () => webUnsupported("publicMcp.stopTunnel"),
  setProject: () => webUnsupported("publicMcp.setProject"),
  setTunnelConfig: () => webUnsupported("publicMcp.setTunnelConfig"),
  addProjectLink: () => webUnsupported("publicMcp.addProjectLink"),
  removeProjectLink: () => webUnsupported("publicMcp.removeProjectLink"),
  regenerateProjectLinkSecret: () => webUnsupported("publicMcp.regenerateProjectLinkSecret"),
};

/** Agent SSH 主机信任审批:宿主受信入口,只在桌面端设置页里(手机端不挂 SettingsPage,
 *  也没有"批准一台 SSH 主机"的界面)。只显式列出、不实现 —— 同 publicMcp 上面那段规矩。 */
const agentSsh: Api["agentSsh"] = {
  list: () => webUnsupported("agentSsh.list"),
  approveHost: () => webUnsupported("agentSsh.approveHost"),
  revokeHost: () => webUnsupported("agentSsh.revokeHost"),
};

/** MCP 管理整面都是桌面端的事(它改的是 PC 上那个进程的 ~/.mcode 配置与引擎视图;
 *  手机端也没有「设置 → MCP」面板)。从前这个命名空间**整个不列**,靠 proxy 兜底;
 *  现在显式列出所有方法 —— 新增的「安装 GenOffice 文档工具」尤其不能悄悄在手机上
 *  可用:它会在那台电脑上写一条会拉起本地进程的 MCP 条目。
 *  ⚠️ 少列一个方法 = 一次 `undefined is not a function`(见文件头那条 React 19 规矩)。 */
const mcp: Api["mcp"] = {
  list: () => webUnsupported("mcp.list"),
  toggle: () => webUnsupported("mcp.toggle"),
  enginesSet: () => webUnsupported("mcp.enginesSet"),
  authorize: () => webUnsupported("mcp.authorize"),
  unauthorize: () => webUnsupported("mcp.unauthorize"),
  save: () => webUnsupported("mcp.save"),
  genofficeInstall: () => webUnsupported("mcp.genofficeInstall"),
  remove: () => webUnsupported("mcp.remove"),
  scanImport: () => webUnsupported("mcp.scanImport"),
  import: () => webUnsupported("mcp.import"),
  projectList: () => webUnsupported("mcp.projectList"),
  projectSave: () => webUnsupported("mcp.projectSave"),
  projectRemove: () => webUnsupported("mcp.projectRemove"),
  projectTrust: () => webUnsupported("mcp.projectTrust"),
  projectCopy: () => webUnsupported("mcp.projectCopy"),
  marketSources: () => webUnsupported("mcp.marketSources"),
  marketSourceAdd: () => webUnsupported("mcp.marketSourceAdd"),
  marketSourceRemove: () => webUnsupported("mcp.marketSourceRemove"),
  marketSearch: () => webUnsupported("mcp.marketSearch"),
};

const piModels: Api["piModels"] = {
  list: () => webUnsupported("piModels.list"),
  save: () => webUnsupported("piModels.save"),
  delete: () => webUnsupported("piModels.delete"),
  listAvailable: () => rpc("piModels:listAvailable"),
  // 端点探测走主进程外连，手机端不做（设置页在手机上不可达；同类桩的清单见
  // `scripts/ipc-wiring-smoke/main.ts` 的 DESKTOP_ONLY_STUBS）。
  test: () => webUnsupported("piModels.test"),
  listEndpointModels: () => webUnsupported("piModels.listEndpointModels"),
  getApiKey: () => webUnsupported("piModels.getApiKey"),
};

/** 工作流:手机端**只读** —— 输入框上那个下拉要能列出桌面端建的工作流(选了哪个
 *  跟着会话走,存在 `sessions.composer_mode` 里)。编辑是桌面端的事:画布拖拽、
 *  参数表单里的文件选择器都不是为触摸屏写的,所以除 `list` 之外一律 `webUnsupported`。
 *
 *  ⚠️ 这里**必须显式列出整个命名空间**。proxy 只对"没列出的名字"兜底报错,而已列出的
 *  对象里少一个方法就是一次 `undefined is not a function` —— 共用的
 *  `WorkflowDropdown` 在 effect 里调它,那会让 React 19 整棵卸载(见文件头)。 */
const workflow: Api["workflow"] = {
  list: () => rpc("workflow:list"),
  get: () => webUnsupported("workflow.get"),
  approve: () => webUnsupported("workflow.approve"),
  nodeTypes: () => webUnsupported("workflow.nodeTypes"),
  save: () => webUnsupported("workflow.save"),
  remove: () => webUnsupported("workflow.remove"),
  // 「设为默认」是桌面设置页的事(与 save/remove 同一立场)—— 但**必须列出来**,
  // 理由见文件头:proxy 只对没列出的名字兜底,少一个方法就是 undefined is not a function。
  pinDefault: () => webUnsupported("workflow.pinDefault"),
  restoreDefault: () => webUnsupported("workflow.restoreDefault"),
  applyShippedUpdate: () => webUnsupported("workflow.applyShippedUpdate"),
  dismissShippedUpdate: () => webUnsupported("workflow.dismissShippedUpdate"),
  // 导出 / 导入(WF-08)。**桌面端的事**:两条路都要一个 OS 原生文件对话框(保存框 /
  // 打开框),手机上既没有那一层也可能是沙箱目录 —— 导出来的文件用户拿不到。所以
  // 三条一律挡在这儿,界面那边据此把它们画成不可点(见 `WorkflowLibraryView`)。
  export: () => webUnsupported("workflow.export"),
  import: () => webUnsupported("workflow.import"),
  importFromFile: () => webUnsupported("workflow.importFromFile"),
  // 出厂预置:文件在主进程那一侧(桌面安装包里),手机端没有那条通道 → 显式不可用。
  listPresets: () => webUnsupported("workflow.listPresets"),
  importPreset: () => webUnsupported("workflow.importPreset"),
  // 代理档案也是桌面端的事(它是画布/检查器那一套的一部分)。**照样要列出来** ——
  // 共用的 `WorkflowLibraryView` 在 effect 里拉它,少一个方法就是一次
  // `undefined is not a function`,那会让 React 19 整棵卸载(见文件头)。
  agentProfiles: () => webUnsupported("workflow.agentProfiles"),
  saveAgentProfile: () => webUnsupported("workflow.saveAgentProfile"),
  removeAgentProfile: () => webUnsupported("workflow.removeAgentProfile"),
  // ⚠️ **这一条是 `rpc` 而不是 `webUnsupported`** —— 上面那几条"编辑动作"确实是桌面端
  // 的事(画布拖拽、文件选择器),但**在岔路口上拍板不是编辑**:图正停在那个节点上等人,
  // 而用户很可能就拿着手机。手机端实现了这条 RPC(见 `main/mobile/mobileRpc.ts`)。
  choose: (input) => rpc("workflow:choose", input),
  // 同理:失败卡片上的「再试一次」也**必须是手机能按的**。图卡在一个炸掉的节点上,
  // 而用户多半不在电脑前面 —— 那正是最需要有人拍板的时刻。
  retry: (input) => rpc("workflow:retry", input),
};

const skills: Api["skills"] = {
  list: (input) => rpc("skills:list", input),
  read: (input) => rpc("skills:read", input),
  save: () => webUnsupported("skills.save"),
  delete: () => webUnsupported("skills.delete"),
  // 复制到项目也是桌面设置页的功能：它要选"复制到哪个项目目录"，而手机端没有
  // 那个上下文（与 save/delete 同一立场）。
  copyToProject: () => webUnsupported("skills.copyToProject"),
  // 预设与跨项目总览同样是桌面设置页的功能(要选项目目录 / 扫别的项目)。
  presetsList: () => webUnsupported("skills.presetsList"),
  presetsSave: () => webUnsupported("skills.presetsSave"),
  presetsDelete: () => webUnsupported("skills.presetsDelete"),
  projectOverview: () => webUnsupported("skills.projectOverview"),
  // 矩阵编辑是桌面设置页的功能；手机端只读展示（与 save/delete 同一立场）。
  // bundles 只读、随 list 一起展示；批量矩阵编辑同样是桌面端的事。
  bundles: () => webUnsupported("skills.bundles"),
  enginesSet: () => webUnsupported("skills.engines.set"),
  enginesSetBulk: () => webUnsupported("skills.enginesSetBulk"),
  scanSources: () => webUnsupported("skills.scanSources"),
  import: () => webUnsupported("skills.import"),
  importGithub: () => webUnsupported("skills.importGithub"),
  // 技能市场同属桌面设置页(拉仓库、写总库)。
  marketList: () => webUnsupported("skills.marketList"),
  marketAdd: () => webUnsupported("skills.marketAdd"),
  marketRemove: () => webUnsupported("skills.marketRemove"),
  marketRefresh: () => webUnsupported("skills.marketRefresh"),
  marketInstall: () => webUnsupported("skills.marketInstall"),
};

const file: Api["file"] = {
  readFile: (input) => rpc("file:readFile", input),
  readBinary: (input) => rpc("file:readBinary", input),
  pickImages: () => pickImagesWeb(),
  listDir: (input) => rpc("file:listDir", input),
  search: (input) => rpc("file:search", input),
  grep: () => webUnsupported("file.grep"),
  writeFile: () => webUnsupported("file.writeFile"),
  mkdir: () => webUnsupported("file.mkdir"),
  delete: () => webUnsupported("file.delete"),
  rename: () => webUnsupported("file.rename"),
  copy: () => webUnsupported("file.copy"),
};

const git: Api["git"] = {
  discoverRepos: (input) => rpc("git:discoverRepos", input),
  status: (input) => rpc("git:status", input),
  stage: (input) => rpc("git:stage", input),
  unstage: (input) => rpc("git:unstage", input),
  commit: (input) => rpc("git:commit", input),
  push: (input) => rpc("git:push", input),
  pull: (input) => rpc("git:pull", input),
  diff: (input) => rpc("git:diff", input),
  // 手机端白名单没有 `git:fileBlob`(桌面 GitRepoCard 用它拼整文件 diff;手机 Git 屏
  // 只走 `git:diff` 的 patch)。显式不可用 —— 唯一调用方在打开整文件 diff 失败时会
  // 回退成普通编辑器打开,不会静默装成"文件没有改动"。
  fileBlob: () => webUnsupported("git.fileBlob"),
  discard: () => webUnsupported("git.discard"),
  generateCommitMessage: (input) => rpc("git:generateCommitMessage", input),
  cancelGenerateCommitMessage: (input) => rpc("git:cancelGenerateCommitMessage", input),
  log: () => webUnsupported("git.log"),
  showCommit: () => webUnsupported("git.showCommit"),
  showFile: () => webUnsupported("git.showFile"),
  listBranches: (input) => rpc("git:listBranches", input),
  checkout: (input) => rpc("git:checkout", input),
  deleteBranch: () => webUnsupported("git.deleteBranch"),
  mergePreview: () => webUnsupported("git.mergePreview"),
  merge: () => webUnsupported("git.merge"),
  mergeAbort: () => webUnsupported("git.mergeAbort"),
  worktreeList: () => webUnsupported("git.worktreeList"),
  worktreeStatus: () => webUnsupported("git.worktreeStatus"),
  worktreeMergeBack: () => webUnsupported("git.worktreeMergeBack"),
  worktreeRemove: () => webUnsupported("git.worktreeRemove"),
};

/**
 * 「跟着屏幕走」的设置(显示模式、字号、布局、上次打开的会话……,键表见
 * `@contracts/ipc/settingsSync`)存在**这台手机浏览器**的 localStorage 里,不发给
 * 桌面 —— 否则手机上换个字号、点开一个对话,桌面下次启动就跟着变。其余键照旧走
 * RPC 读写桌面那份设置表(服务端还有一道白名单,见 `main/mobile/mobileRpc.ts`)。
 */
const LOCAL_SETTING_PREFIX = "mcode-web-setting:";

function readLocalSetting(key: string): string | null {
  try {
    return localStorage.getItem(LOCAL_SETTING_PREFIX + key);
  } catch {
    return null;
  }
}

function writeLocalSetting(key: string, value: string): void {
  try {
    localStorage.setItem(LOCAL_SETTING_PREFIX + key, value);
  } catch {
    // 隐私模式等 —— 这次会话里的选择仍然生效(store 里有),只是不记住
  }
}

const setting: Api["setting"] = {
  get: async (input) => {
    if (isDeviceLocalSettingKey(input.key)) return { value: readLocalSetting(input.key) };
    return rpc("setting:get", input);
  },
  set: async (input) => {
    if (isDeviceLocalSettingKey(input.key)) {
      writeLocalSetting(input.key, input.value);
      return;
    }
    return rpc("setting:set", input);
  },
  getMany: async (input) => {
    const remoteKeys = input.keys.filter((k) => !isDeviceLocalSettingKey(k));
    const out: Record<string, string | null> =
      remoteKeys.length > 0 ? { ...(await rpc<Record<string, string | null>>("setting:getMany", { keys: remoteKeys })) } : {};
    for (const k of input.keys) {
      if (isDeviceLocalSettingKey(k)) out[k] = readLocalSetting(k);
    }
    return out;
  },
  // 设置导入 / 导出要弹电脑上的文件对话框,手机端不提供(设置页里那张卡片也不显示)。
  exportToFile: () => Promise.resolve({ ok: false as const, error: translate(uiLocale(), "lib.web.unavailable", { name: "setting.exportToFile" }) }),
  importFromFile: () => Promise.resolve({ ok: false as const, error: translate(uiLocale(), "lib.web.unavailable", { name: "setting.importFromFile" }) }),
  // 【MC-026】这两条是 Agent 经 app_api_call 走的;手机端没有 preload 的 rpc 主进程通道,
  // 按同一惯例显式不可用(不是静默失败)。
  exportToPath: () => Promise.resolve({ ok: false as const, error: translate(uiLocale(), "lib.web.unavailable", { name: "setting.exportToPath" }) }),
  importFromText: () => Promise.resolve({ ok: false as const, error: translate(uiLocale(), "lib.web.unavailable", { name: "setting.importFromText" }) }),
};

/** Voice input requires the desktop main-process ASR engine; the mobile/web
 *  shell has no microphone capture bridge, so every call is unsupported. */
const voice: Api["voice"] = {
  start: () => webUnsupported("voice.start"),
  feed: () => webUnsupported("voice.feed"),
  stop: () => webUnsupported("voice.stop"),
  cancel: () => webUnsupported("voice.cancel"),
  modelList: () => webUnsupported("voice.modelList"),
  downloadModel: () => webUnsupported("voice.downloadModel"),
  cancelModelDownload: () => webUnsupported("voice.cancelModelDownload"),
  selectModel: () => webUnsupported("voice.selectModel"),
  removeModel: () => webUnsupported("voice.removeModel"),
  getModelDir: () => webUnsupported("voice.getModelDir"),
  setModelDir: () => webUnsupported("voice.setModelDir"),
};

const theme: Api["theme"] = {
  get: () => themeGet(),
  set: (input) => themeSet(input),
};

/** 【ARC-007】受控文档视图宿主:视图是**那台电脑主窗口**的原生子视图,手机端既
 *  没有窗口也没有 WebContentsView。显式列出整个命名空间(与 publicMcp 同一规矩):
 *  少列一个方法 = `api.documentView.close` 在手机上变成 undefined 调用,共用组件在
 *  effect 里调用会让 React 19 整棵卸载。 */
const documentView: Api["documentView"] = {
  open: () => webUnsupported("documentView.open"),
  openPath: () => webUnsupported("documentView.openPath"),
  bounds: () => webUnsupported("documentView.bounds"),
  show: () => webUnsupported("documentView.show"),
  hide: () => webUnsupported("documentView.hide"),
  focus: () => webUnsupported("documentView.focus"),
  close: () => webUnsupported("documentView.close"),
  list: () => webUnsupported("documentView.list"),
};

/**
 * 【T100】任务（`task.*`）—— 手机端没有那条桥。
 *
 * 任务是**桌面端 sql.js 里的记录**，手机端 `AppMobile` 走的是无 preload 的 HTTP
 * 桥，没有这条数据源。显式列出整个命名空间（与 `documentView` 同一条规矩）：
 * 少列一个方法 = `api.task.accept` 在手机上变成 undefined 调用，共用组件在
 * effect/handler 里调用会让 React 19 整棵卸载（`AppMobile.tsx` + `webApi.ts` 是
 * **独立组件树**，这条坑仓库里记着）。
 *
 * ⚠️ 任务中心面板**不要挂进手机端**：它的读路径在这里就是一条 `webUnsupported`，
 * 挂上去只会给手机用户一张错误卡。真要做手机端任务列表，得先有一条能读任务的服务端。
 */
const task: Api["task"] = {
  list: () => webUnsupported("task.list"),
  get: () => webUnsupported("task.get"),
  accept: () => webUnsupported("task.accept"),
  reject: () => webUnsupported("task.reject"),
};

/**
 * 【T109】审批历史 —— 同 `task`：手机端没有那条桥。
 *
 * ⚠️ 任务中心不挂手机端，所以审批历史目前**没有任何 UI 消费者**。
 * 这一项存在是为了让「共用组件里调用 `api.approval.list`」不会整棵卸载
 * （`webApi.ts` 的规矩：少列一个方法 = undefined 调用 = React 19 整棵卸载）。
 */
const approval: Api["approval"] = {
  list: () => webUnsupported("approval.list"),
};

/** 【ARC-006 NR2】第三方工作流引擎也是**那台桌面机器上的独立进程**:手机端
 *  既没有本机进程可起停,也没有 WebContentsView 可嵌。显式列出整个命名空间 ——
 *  与 `documentView` 同一条规矩(漏列的方法在共用组件里会变成 undefined 调用,
 *  React 19 下整棵卸载)。 */
const workflowEngine: Api["workflowEngine"] = {
  start: () => webUnsupported("workflowEngine.start"),
  stop: () => webUnsupported("workflowEngine.stop"),
  status: () => webUnsupported("workflowEngine.status"),
  list: () => webUnsupported("workflowEngine.list"),
  load: () => webUnsupported("workflowEngine.load"),
  // 【ARC-006 Gate E】节点包安装是**桌面机器上的可执行代码**,手机端不做(与整个
  // workflowEngine 命名空间同一取舍);审批卡也只画在桌面设置页。
  nodesList: () => webUnsupported("workflowEngine.nodesList"),
  nodeInstall: () => webUnsupported("workflowEngine.nodeInstall"),
  respondNodeInstallApproval: () => webUnsupported("workflowEngine.respondNodeInstallApproval"),
};

/* ─────────── namespaces reachable from the shared tree but desktop-only ───────────
 *
 * 下面这几个命名空间**会被手机壳实际加载的共用组件调到**(消息列表的「⋯」菜单、
 * 输入框的「+」菜单、`useRefOptions`、`notifPrefsCache`、`EmptyThreadWelcome` 等),
 * 而从前它们整个不在 `base` 里 —— 访问落在 Proxy 兜底上。Proxy 是**同步抛**:
 * 对 `await api.x.y()` 风格(调用方包了 try/catch)没问题,但对
 * `api.x.y().then(...).catch(...)` 风格**接不住** —— `.catch` 还没挂上,异常已经
 * 从 effect / 事件处理器里逃出去(LibraryPicker 的 `loadItems` 就是这种写法,
 * React 19 下会卸掉整棵树)。所以这里一律用 **async 桩**:返回 rejected Promise,
 * `.catch` 与 `await` 两种风格都能接住;错误仍带
 * `WEB_UNSUPPORTED_MARKER` + 本地化原因,调用方能把"平台不支持"与"真失败"分开。
 * **少列一个方法就是一次 `undefined is not a function`**(见文件头那条规矩)。
 *
 * 取舍:手机壳不挂它们的面板(文献库 / 记忆 / 插件 / 计划任务 / 监控),主进程
 * 手机 RPC 白名单也**没有**这些 handler —— 所以全部是桩,不是"还没接"。 */

/** 自动化(触发器跑一次 / 运行史 / 会话 / 守望)。`watch` 那一组是输入框守望面板的,
 *  桌面专属(`ComposerToolbar` 用 `isElectron` 门控);`runAutomation` 的宿主
 *  (自定义 UI 右键项)也在桌面。手机端没有 "automation:*" 白名单 handler。 */
const automation: Api["automation"] = {
  run: () => webUnsupported("automation.run"),
  preflight: () => webUnsupported("automation.preflight"),
  runs: () => webUnsupported("automation.runs"),
  sessions: () => webUnsupported("automation.sessions"),
  watch: () => webUnsupported("automation.watch"),
  watchStatus: () => webUnsupported("automation.watchStatus"),
  watchTemplates: () => webUnsupported("automation.watchTemplates"),
  saveWatchTemplates: () => webUnsupported("automation.saveWatchTemplates"),
  rebuildWatchTemplates: () => webUnsupported("automation.rebuildWatchTemplates"),
  statusAll: () => webUnsupported("automation.statusAll"),
};

/** Codex 自定义端点模型。设置页专属(手机不挂设置页),白名单也没有 —— 桩。
 *  注意 **不能**用空列表假装"没有模型":模型下拉会据此把 codex 的候选清空。 */
const codexModels: Api["codexModels"] = {
  list: () => webUnsupported("codexModels.list"),
  save: () => webUnsupported("codexModels.save"),
  delete: () => webUnsupported("codexModels.delete"),
  test: () => webUnsupported("codexModels.test"),
  listEndpointModels: () => webUnsupported("codexModels.listEndpointModels"),
  getApiKey: () => webUnsupported("codexModels.getApiKey"),
};

/** 自定义 UI 的宿主入口。手机壳不挂自定义面板 / 自定义右键项,白名单没有 —— 桩。 */
const customUi: Api["customUi"] = {
  runAutomation: () => webUnsupported("customUi.runAutomation"),
  stagePanel: () => webUnsupported("customUi.stagePanel"),
  panelAsk: () => webUnsupported("customUi.panelAsk"),
  panelApiCall: () => webUnsupported("customUi.panelApiCall"),
};

/** 文献库。手机壳的输入框「+」菜单里有「文献库」入口(`LibraryPicker` / `attachToChat`
 *  是共用组件),但主进程手机 RPC 白名单**没有** `library:*`。从前它整个落 Proxy:
 *  `LibraryPicker.loadItems` 那种 `api.library.list(...).then(...).catch(...)` 会在
 *  `.catch` 挂上之前同步抛出、逃进 effect。这里改成 **async 桩**(rejected Promise),
 *  选中一篇只会得到一条说得清的"移动端不可用",不会带崩整棵树。
 *  `on.libraryChanged` 仍是空实现(手机没有库面板要刷新)。 */
const library: Api["library"] = {
  groupsGet: async () => webUnsupported("library.groupsGet"),
  groupsSave: async () => webUnsupported("library.groupsSave"),
  suppressGet: async () => webUnsupported("library.suppressGet"),
  suppressSave: async () => webUnsupported("library.suppressSave"),
  linksOf: async () => webUnsupported("library.linksOf"),
  linkCounts: async () => webUnsupported("library.linkCounts"),
  linkAdd: async () => webUnsupported("library.linkAdd"),
  linkRemove: async () => webUnsupported("library.linkRemove"),
  importGeneric: async () => webUnsupported("library.importGeneric"),
  readFile: async () => webUnsupported("library.readFile"),
  list: async () => webUnsupported("library.list"),
  get: async () => webUnsupported("library.get"),
  addItems: async () => webUnsupported("library.addItems"),
  deleteItems: async () => webUnsupported("library.deleteItems"),
  restoreItems: async () => webUnsupported("library.restoreItems"),
  deletePreview: async () => webUnsupported("library.deletePreview"),
  importFiles: async () => webUnsupported("library.importFiles"),
  convert: async () => webUnsupported("library.convert"),
  revealFile: async () => webUnsupported("library.revealFile"),
  openFile: async () => webUnsupported("library.openFile"),
  entryPath: async () => webUnsupported("library.entryPath"),
  readAsset: async () => webUnsupported("library.readAsset"),
  readHighlights: async () => webUnsupported("library.readHighlights"),
  saveHighlights: async () => webUnsupported("library.saveHighlights"),
  writeHighlights: async () => webUnsupported("library.writeHighlights"),
  readOriginalPdf: async () => webUnsupported("library.readOriginalPdf"),
  readMarkdown: async () => webUnsupported("library.readMarkdown"),
  readPdf: async () => webUnsupported("library.readPdf"),
  renameItem: async () => webUnsupported("library.renameItem"),
  listNotes: async () => webUnsupported("library.listNotes"),
  saveNote: async () => webUnsupported("library.saveNote"),
  deleteNote: async () => webUnsupported("library.deleteNote"),
  createNote: async () => webUnsupported("library.createNote"),
  writeNote: async () => webUnsupported("library.writeNote"),
  adoptMarkdown: async () => webUnsupported("library.adoptMarkdown"),
  importNotes: async () => webUnsupported("library.importNotes"),
  conversionStats: async () => webUnsupported("library.conversionStats"),
  conversionReport: async () => webUnsupported("library.conversionReport"),
  fullTextSearch: async () => webUnsupported("library.fullTextSearch"),
  itemManifest: async () => webUnsupported("library.itemManifest"),
  manifest: async () => webUnsupported("library.manifest"),
  attachToChat: async () => webUnsupported("library.attachToChat"),
  listCollections: async () => webUnsupported("library.listCollections"),
  createCollection: async () => webUnsupported("library.createCollection"),
  renameCollection: async () => webUnsupported("library.renameCollection"),
  deleteCollection: async () => webUnsupported("library.deleteCollection"),
  moveCollection: async () => webUnsupported("library.moveCollection"),
  assignCollection: async () => webUnsupported("library.assignCollection"),
};

/** 语言服务器。手机没有编辑器 / Monaco,sessionStore.initDeferred 已按
 *  `isElectron` 跳过读取;仍然显式列出(共用 store 的其他分支可能碰到)。 */
const lsp: Api["lsp"] = {
  list: () => webUnsupported("lsp.list"),
  install: () => webUnsupported("lsp.install"),
  installFromFile: () => webUnsupported("lsp.installFromFile"),
  uninstall: () => webUnsupported("lsp.uninstall"),
  toggle: () => webUnsupported("lsp.toggle"),
  setPath: () => webUnsupported("lsp.setPath"),
  healthCheck: () => webUnsupported("lsp.healthCheck"),
  prewarm: () => webUnsupported("lsp.prewarm"),
  restart: () => webUnsupported("lsp.restart"),
  openDocument: () => webUnsupported("lsp.openDocument"),
  closeDocument: () => webUnsupported("lsp.closeDocument"),
  didChange: () => webUnsupported("lsp.didChange"),
  didSave: () => webUnsupported("lsp.didSave"),
  request: () => webUnsupported("lsp.request"),
};

/** 记忆助手按钮。`ComposerToolbar` 用 `isElectron` 门控,手机不挂;白名单没有 —— 桩。 */
const memory: Api["memory"] = {
  assistant: () => webUnsupported("memory.assistant"),
  manage: () => webUnsupported("memory.manage"),
  list: () => webUnsupported("memory.list"),
  read: () => webUnsupported("memory.read"),
  save: () => webUnsupported("memory.save"),
  delete: () => webUnsupported("memory.delete"),
  categories: () => webUnsupported("memory.categories"),
  review: () => webUnsupported("memory.review"),
  reviewDelete: () => webUnsupported("memory.reviewDelete"),
};

/** 系统通知偏好。**这一条不是空实现能糊过去的**:`notifPrefsCache` 在
 *  `inAppToastAllowed()` 里首次调用时拉一次,失败就退回默认(照常弹提示)。
 *  主进程白名单没有 `notification:*`(那是那台电脑的系统通知),所以显式不可用,
 *  调用方 catch 后按默认走。`on.notificationFocusSession` 仍是空实现。
 *  形状用 async:`prime()` 是 `getPrefs().then(...)` 的写法,同步抛会让它外层的
 *  try 以外什么都接不住。 */
const notification: Api["notification"] = {
  getPrefs: async () => webUnsupported("notification.getPrefs"),
  setPrefs: async () => webUnsupported("notification.setPrefs"),
  focusSession: async () => webUnsupported("notification.focusSession"),
};

/** 插件(设置页)。`useRefOptions` 的 `plugins` 候选来源会读它(NOT mounted in the
 *  mobile shell's visible tree, but reachable via the shared hook);白名单没有 —— 桩。 */
const plugins: Api["plugins"] = {
  list: () => webUnsupported("plugins.list"),
  installLocal: () => webUnsupported("plugins.installLocal"),
  installGit: () => webUnsupported("plugins.installGit"),
  installMarketplace: () => webUnsupported("plugins.installMarketplace"),
  setEnabled: () => webUnsupported("plugins.setEnabled"),
  enginesSet: () => webUnsupported("plugins.enginesSet"),
  projectList: () => webUnsupported("plugins.projectList"),
  projectSet: () => webUnsupported("plugins.projectSet"),
  remove: () => webUnsupported("plugins.remove"),
  marketplaceList: () => webUnsupported("plugins.marketplaceList"),
  marketplaceAdd: () => webUnsupported("plugins.marketplaceAdd"),
  marketplaceRemove: () => webUnsupported("plugins.marketplaceRemove"),
  marketplaceRefresh: () => webUnsupported("plugins.marketplaceRefresh"),
};

/** Agent runtime 安装。手机不安装 runtime;`initDeferred` 已按 `isElectron` 跳过。 */
const runtimes: Api["runtimes"] = {
  list: () => webUnsupported("runtimes.list"),
  install: () => webUnsupported("runtimes.install"),
  installLocal: () => webUnsupported("runtimes.installLocal"),
  remove: () => webUnsupported("runtimes.remove"),
};

/** 用量统计。`EmptyThreadWelcome` 的「今日用量」用 `useRpc(..., DESKTOP_QUIET)` ——
 *  `enabled: isElectron` 在手机上是 false,不会真调;这里仍显式列出,堵住其他分支。 */
const usage: Api["usage"] = {
  stats: () => webUnsupported("usage.stats"),
};

const shell: Api["shell"] = {
  // No OS shell surface in a phone browser — resolve as no-ops so any
  // "open folder"-style call from shared UI degrades silently.
  // 【UI-011】现在返回 `ShellOpenResult`;手机端没有 OS shell,如实报"不支持"而不是
  // 假装成功(共享 UI 消费结果后会显示`error`,不会解除 busy 却什么都没发生)。
  openPath: () => Promise.resolve({ ok: false, error: "手机上不支持用系统程序打开" }),
  showItemInFolder: () => Promise.resolve({ ok: false, error: "手机上不支持在文件管理器中定位" }),
  openFile: () => Promise.resolve({ ok: false, error: "手机上不支持用系统程序打开" }),
};

/** 集成终端。手机端**不再整块缺失**,但只开了一条:
 *
 *  - `list` 走真的 HTTP 路(`terminal:list` 在主进程白名单里,见 mobileRpc.ts)——
 *    终端列表面板是**共用组件**,手机上也挂得起来,列出来的是同一台电脑上的同一份
 *    事实。它是只读的观察窗:看到"我的代理/会话开着哪些终端",但打不进去字。
 *  - 其余(create / write / resize / kill)照旧返回 `{ok:false}` 而不是抛 —— 见
 *    文件头那条:`TerminalView` 那类共用组件在挂载时会调 create,同步抛会让
 *    React 19 把整棵树卸掉。返回一个带 error 的结果,调用方本来就把它写进终端
 *    首行(`result.ok === false` → `term.writeln(...)`),用户看到的是一句说得清的
 *    话,而不是一片空白或白屏。 */
const terminal: Api["terminal"] = {
  // ⚠️ 走 `translate(uiLocale(), …)` 而不是硬编码中文 —— 与这个文件里别的 web 错误
  // (pairFailed / notPaired / …)同一条规矩。硬编码的话,英文界面的手机用户打开终端
  // 面板,首行是一句中文。
  create: () => Promise.resolve({ ok: false as const, error: translate(uiLocale(), "lib.web.terminalUnsupported") }),
  write: () => Promise.resolve({ ok: false, error: translate(uiLocale(), "lib.web.terminalUnsupported") }),
  resize: () => Promise.resolve({ ok: false, error: translate(uiLocale(), "lib.web.terminalUnsupported") }),
  kill: () => Promise.resolve({ ok: false, error: translate(uiLocale(), "lib.web.terminalUnsupported") }),
  list: (input) => rpc<{ terminals: TerminalInfo[] }>("terminal:list", input),
};

const clipboardFile: Api["clipboardFile"] = {
  save: async () => ({
    ok: false as const,
    error: translate(uiLocale(), "lib.web.pasteUnsupported"),
  }),
  writeImage: (input) => writeImageWeb(input),
};

/** Push-event surface. `claudeEvent` rides the SSE stream; every other
 *  channel is desktop-only and subscribes to nothing (the mobile shell hides
 *  the UI that would consume them — theme is localStorage-managed, window
 *  focus is covered by visibilitychange in the hook itself). */
const on: Api["on"] = {
  claudeEvent: (handler) =>
    subscribeRuntime((e) =>
      handler({ channel: IPC.CLAUDE_EVENT, sessionId: e.sessionId, event: e }),
    ),
  sessionTitleUpdated: () => () => {},
  terminalData: () => () => {},
  terminalExit: () => () => {},
  lspEvent: () => () => {},
  // Runtimes progress is desktop-only (the phone never installs runtimes).
  runtimesEvent: () => () => {},
  // 文档工具链同理:它是「设置 → 内核」里那一块,手机端根本不挂载那个面板。
  // **必须留这个空实现** —— `on` 是显式带类型的对象,少一个键连类型检查都过不去;
  // 而共用组件在 effect 里碰到会同步抛的 Proxy 会让 React 19 整棵卸载(见文件头)。
  toolchainEvent: () => () => {},
  marketProgress: () => () => {}, // Desktop-only progress, like toolchain events.
  browserEvent: () => () => {},
  themeChanged: () => () => {},
  updateAvailable: () => () => {},
  updateDownloadProgress: () => () => {},
  updateDownloaded: () => () => {},
  windowFocusChanged: () => () => {},
  notificationFocusSession: () => () => {},
  // Relay events are desktop-only (the phone doesn't manage SSH).
  relayEvent: () => () => {},
  // Voice ASR is desktop-only; the web shell never emits results.
  voiceResult: () => () => {},
  voiceDownloadProgress: () => () => {},
  // 库变更广播与 AI 挂附件都是桌面端专属 —— 手机端没有那个资料库面板,
  // 也没有输入框的标签区(若日后要在手机上看库,除了这里补实现,还要在 `base` 里加
  // library 命名空间)。**必须有这两个空实现**:手机端拿到的是 Proxy,访问未列出的
  // 名字会**同步抛错**,而共用组件在 effect 里调用它会让 React 19 整棵卸载(见本文件顶部)。
  libraryChanged: () => () => {},
  // 工作流那一摊同理:设置 → 工作流是桌面端专属的面板。
  workflowsChanged: () => () => {},
  // 【MC-061 残余】插件 hook 授权变更推送同理:设置 → 插件是桌面端专属面板,手机端没有它。
  hostHookGrantsChanged: () => () => {},
  composerAttach: () => () => {},
  // 【ARC-006 Gate E】节点安装审批卡只在桌面设置页出现；手机端不订阅。
  nodeInstallApproval: () => () => {},
};

/* ────────────────────────── assembly ────────────────────────── */

/** Build the web `window.api` replacement. Desktop-only groups are absent
 *  from the base object; the proxy turns any access to them (or to anything
 *  else missing) into a clear error instead of an opaque undefined-call. */
export function createWebApi(): Api {
  const base = {
    projectInit: {
      list: async () => webUnsupported("projectInit.list"),
      get: async () => webUnsupported("projectInit.get"),
      save: async () => webUnsupported("projectInit.save"),
      delete: async () => webUnsupported("projectInit.delete"),
      preview: async () => webUnsupported("projectInit.preview"),
      apply: async () => webUnsupported("projectInit.apply"),
      setDefault: async () => webUnsupported("projectInit.setDefault"),
      // 【MC-006】出厂预设文件在桌面安装包里 —— 手机端没有那条通道,显式不可用。
      listPresets: async () => webUnsupported("projectInit.listPresets"),
      importPreset: async () => webUnsupported("projectInit.importPreset"),
    } satisfies Api["projectInit"],
    // Scene planning/preflight is desktop-only in v1 (SceneSpec compilation and the
    // host capability inventory live in the main process). Reject explicitly.
    // 【ARC-007】文档能力在手机上**故意不做**:文档编辑是坐在那台机器前的动作,
    // 且需要本机 GenOffice CLI。明确 unsupported(与 scene.* 同一取舍)。
    document: {
      read: async () => webUnsupported("document.read"),
      edit: async () => webUnsupported("document.edit"),
      convert: async () => webUnsupported("document.convert"),
      capabilities: async () => webUnsupported("document.capabilities"),
      // 【T24】文档 AI 工具面同样只属于桌面(CLI + 受控临时目录);手机端显式不可用。
      apps: async () => webUnsupported("document.apps"),
      toolsList: async () => webUnsupported("document.toolsList"),
      toolDescribe: async () => webUnsupported("document.toolDescribe"),
      toolCall: async () => webUnsupported("document.toolCall"),
      markdownRead: async () => webUnsupported("document.markdownRead"),
      markdownEdit: async () => webUnsupported("document.markdownEdit"),
      render: async () => webUnsupported("document.render"),
    } satisfies Api["document"],
    scene: {
      plan: async () => webUnsupported("scene.plan"),
      preflight: async () => webUnsupported("scene.preflight"),
      // 部署(用户签发 + 执行)在手机上**故意不做**:批准一台机器上会真的建资源的计划,是
      // 坐在那台机器前的动作。明确 unsupported,不是忘了接(与 modules 同一取舍)。
      approve: async () => webUnsupported("scene.approve"),
      apply: async () => webUnsupported("scene.apply"),
      resume: async () => webUnsupported("scene.resume"),
      listDeployments: async () => webUnsupported("scene.listDeployments"),
    } satisfies Api["scene"],
    // 无人值守任务计划(用户签发 + 执行)在手机上**故意不做**:批准一份会真的建会话 / 发首条
    // 消息的计划,是坐在那台机器前的动作。明确 unsupported,不是忘了接(与 scene.* 同一取舍)。
    unattended: {
      approve: async () => webUnsupported("unattended.approve"),
      run: async () => webUnsupported("unattended.run"),
    } satisfies Api["unattended"],
    // Framework wording edits are local-desktop settings: mobile may show the
    // shared general panel, so return an explicit rejection instead of throwing
    // synchronously via the unknown-namespace proxy (which unmounts React).
    framework: {
      list: async () => webUnsupported("framework.list"),
      save: async () => webUnsupported("framework.save"),
      reset: async () => webUnsupported("framework.reset"),
    } satisfies Api["framework"],
    // Module installation/execution is desktop-only in v1. Reject explicitly;
    // no new mobile whitelist or paired-device capability is implied.
    modules: {
      catalog: async () => webUnsupported("modules.catalog"),
      install: async () => webUnsupported("modules.install"),
      remove: async () => webUnsupported("modules.remove"),
      invoke: async () => webUnsupported("modules.invoke"),
      task: async () => webUnsupported("modules.task"),
      cancel: async () => webUnsupported("modules.cancel"),
      tasks: async () => webUnsupported("modules.tasks"),
      // 【MC-036】授权签发 / 撤销是**坐在那台机器前的真人**的动作(只经桌面设置页),
      // 网页壳明确 unsupported,不是忘了接(与整个 modules 面同一取舍)。
      issueWorkflowGrant: async () => webUnsupported("modules.issueWorkflowGrant"),
      revokeWorkflowGrant: async () => webUnsupported("modules.revokeWorkflowGrant"),
      setPermissions: async () => webUnsupported("modules.setPermissions"),
      // 【F006】从 .vsix 装扩展同样是桌面专属动作:它要选本机文件、并让用户对
      // 「在本机跑一段程序」当面确认。网页壳明确 unsupported,不是忘了接
      // (与整个 modules 面同一取舍)。
      installVsix: async () => webUnsupported("modules.installVsix"),
      // Desktop-only user risk acknowledgment: never expose it through mobile/web.
      egressConsentGet: async () => webUnsupported("modules.egressConsentGet"),
      egressConsentSet: async () => webUnsupported("modules.egressConsentSet"),
    } satisfies Api["modules"],
    project,
    session,
    documentView,
    // 【T100】任务中心不在手机端（见上面 `task` 常量的注释）。
    task,
    approval,
    workflowEngine,
    provider,
    customModel,
    webBridge,
    publicMcp,
    agentSsh,
    mcp,
    piModels,
    workflow,
    skills,
    automation,
    codexModels,
    customUi,
    library,
    lsp,
    memory,
    notification,
    plugins,
    runtimes,
    usage,
    file,
    git,
    claude,
    setting,
    voice,
    theme,
    shell,
    terminal,
    clipboardFile,
    /** 手机端没有本地文件系统,也就没有拖放 —— 返回空串,调用方按"拿不到路径"处理。 */
    getPathForFile: (): string => "",
    // 原生目录 / 文件对话框是**那台电脑上的 OS 窗口**,手机浏览器没有这一层。
    // 两个都是共用组件的入口(`+ → 添加项目外的文件` 的 `FileMentionPicker`,
    // sessionStore.addProjectFromFolder),所以显式桩(而不是靠 Proxy 兜底):
    // async 形状让 `await` / `.catch` 两种写法都接得住,原因文本可读。
    pickFolder: async () => {
      webUnsupported("pickFolder");
    },
    pickFiles: async () => {
      webUnsupported("pickFiles");
    },
    on,
  };

  return new Proxy(base as unknown as Api, {
    get(target, prop, receiver) {
      const existing = Reflect.get(target, prop, receiver);
      if (existing !== undefined) return existing;
      if (typeof prop !== "string") return existing;
      // Unknown surface (terminal/browser/lsp/dialog/app/... on web). Shared
      // code accesses these as `api.<namespace>.<method>(...)`, so return a
      // deep callable proxy: both `api.lsp()` and `api.lsp.list()` throw a
      // clean `webUnsupported` instead of an opaque "is not a function".
      return unsupportedNamespace(String(prop));
    },
  });
}
