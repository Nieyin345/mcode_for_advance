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
 * Desktop-only surface (terminal / browser / lsp / shell / dialogs / app
 * updates / secrets management) is intentionally ABSENT: the proxy fallback
 * turns any such call into a clear "not available in web mode" error, and the
 * mobile shell hides the UI that would call it.
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
function webUnsupported(name: string): never {
  throw new Error(translate(uiLocale(), "lib.web.unavailable", { name }));
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
  const stored = localStorage.getItem(THEME_KEY);
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
  listSideChats: (input) => rpc("claude:listSideChats", input),
  sendTurn: (input) => rpc("claude:sendTurn", input),
  interrupt: (input) => rpc("claude:interrupt", input),
  // 手机上不支持插话(那一轮跑在桌面端,手机这边没有"正在跑的那一轮"这个概念)。
  // 留着它是为了满足 `Api["claude"]` 的完整性 —— 调用方按 memory 里那条规矩包了
  // try/catch,失败会退回普通的发送。
  inject: (input) => rpc("claude:inject", input),
  approve: (input) => rpc("claude:approve", input),
  respondQuestion: (input) => rpc("claude:respondQuestion", input),
  respondPlanApproval: (input) => rpc("claude:respondPlanApproval", input),
  rewindTurn: (input) => rpc("claude:rewindTurn", input),
  // 手机端没有设置页的子代理编辑器 —— 与 rewindTurn 同理,仅为满足类型完整性。
  saveSubagents: (input) => rpc("claude:saveSubagents", input),
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
  // 手机端**没有**分叉这个入口(AppMobile 的会话列表里不放它),所以这条在手机上
  // 只会以"服务端不认识这个方法"失败。留着它是为了满足 `Api["session"]` 的完整性 ——
  // 调用方仍然必须按 memory 里那条规矩把 RPC 包在 try/catch 里(抛出去会让 React 19
  // 把整棵树卸掉)。
  fork: (input) => rpc("session:fork", input),
  pin: (input) => rpc("session:pin", input),
  updateBookmarks: (input) => rpc("session:updateBookmarks", input),
  listPinned: () => rpc("session:listPinned"),
  listAll: (input) => rpc("session:listAll", input),
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
};

const piModels: Api["piModels"] = {
  list: () => webUnsupported("piModels.list"),
  save: () => webUnsupported("piModels.save"),
  delete: () => webUnsupported("piModels.delete"),
  listAvailable: () => rpc("piModels:listAvailable"),
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
  // 导出 / 导入(WF-08)。**桌面端的事**:两条路都要一个 OS 原生文件对话框(保存框 /
  // 打开框),手机上既没有那一层也可能是沙箱目录 —— 导出来的文件用户拿不到。所以
  // 三条一律挡在这儿,界面那边据此把它们画成不可点(见 `WorkflowLibraryView`)。
  export: () => webUnsupported("workflow.export"),
  import: () => webUnsupported("workflow.import"),
  importFromFile: () => webUnsupported("workflow.importFromFile"),
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
  fileBlob: (input) => rpc("git:fileBlob", input),
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

const shell: Api["shell"] = {
  // No OS shell surface in a phone browser — resolve as no-ops so any
  // "open folder"-style call from shared UI degrades silently.
  openPath: () => Promise.resolve(),
  showItemInFolder: () => Promise.resolve(),
  openFile: () => Promise.resolve(),
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
const TERMINAL_WEB_UNSUPPORTED = "终端只能在电脑端操作";

const terminal: Api["terminal"] = {
  create: () => Promise.resolve({ ok: false as const, error: TERMINAL_WEB_UNSUPPORTED }),
  write: () => Promise.resolve({ ok: false, error: TERMINAL_WEB_UNSUPPORTED }),
  resize: () => Promise.resolve({ ok: false, error: TERMINAL_WEB_UNSUPPORTED }),
  kill: () => Promise.resolve({ ok: false, error: TERMINAL_WEB_UNSUPPORTED }),
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
  composerAttach: () => () => {},
};

/* ────────────────────────── assembly ────────────────────────── */

/** Build the web `window.api` replacement. Desktop-only groups are absent
 *  from the base object; the proxy turns any access to them (or to anything
 *  else missing) into a clear error instead of an opaque undefined-call. */
export function createWebApi(): Api {
  const base = {
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
    } satisfies Api["modules"],
    project,
    session,
    provider,
    customModel,
    webBridge,
    publicMcp,
    piModels,
    workflow,
    skills,
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
