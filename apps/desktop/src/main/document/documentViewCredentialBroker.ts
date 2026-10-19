/**
 * 【ARC-006 Gate A 遗留缺口】**工作流引擎编辑器页的凭据注入**（主进程内，令牌不出主进程）。
 *
 * ## 缺口是什么
 *
 * Gate A 给 Node-RED 的 Admin API 配了 `adminAuth`：没有
 * `Authorization: Bearer <MCODE_ENGINE_ADMIN_TOKEN>` 的请求一律 401。编辑器页被嵌进
 * `DocumentViewHost` 的 `WebContentsView` 后，页面自己不会带这个头 —— `/flows`、
 * `/settings`、deploy、comms WebSocket 全部 401，编辑器打不开。
 *
 * ## 为什么不在 URL 里放令牌，也不新开 `editorSession` RPC
 *
 * Node-RED 官方支持 `/?access_token=<token>`（编辑器把令牌写进 localStorage）。但
 * `editorUrl` 会进 `workflowEngine.list/status` —— 那是 **Agent 经 `app_api_call` 可读**
 * 的快照，令牌放进去等于把控制面交给模型。另开一条「返回一次性令牌」的 RPC 同样
 * 要把令牌交到渲染端，而渲染端能经 `webContents.executeJavaScript` 被 Agent 驱动
 * （`appControl/uiBridge.ts`）—— 令牌一旦过渲染端就不再是「仅桌面用户」。
 *
 * 所以凭据**从不离开主进程**：渲染端只说「这个视图加载的是 node-red 的编辑器页」
 * （`DocViewOpenInput.workflowEngineId`），宿主从引擎数据目录读控制面令牌，并在
 * `session.webRequest.onBeforeSendHeaders` 里**只给这个视图、只给这个引擎回环源**
 * 附加 `Authorization`。令牌不进 URL、不进快照、不进 `status/list`、不落日志。
 *
 * ## 绑定判据（逐条，全部 fail-closed）
 *
 *   - **webContentsId**：只有打开时那个 `WebContentsView` 的请求会被加头。主窗口、
 *     浏览器面板、别的文档视图都拿不到；
 *   - **精确 origin**（scheme + host + port）：请求 URL 先按 ws→http / wss→https
 *     归一，再与打开时的编辑器地址逐字比较。页面就算跳到另一个本机端口，也收不到；
 *   - **端口必须是该引擎此刻的监听端口**：`runningPort(engineId)` 由生产注册表的
 *     `statusOf().port` 给。渲染端递一个别的回环地址（比如本机另一个服务）会被
 *     拒绝 —— 否则等于把令牌送给任意本机进程；
 *   - **短期租约**：绑定带 `expiresAt`，**每次成功注入都滑动续期**（活跃使用不会
 *     中途掉线）；空闲超过 TTL 后监听器不再加头，页面 API 调用**如实 401**（不是
 *     静默降级）。视图 close / closeAll / dispose 时立即摘除绑定。
 *
 * ## 为什么令牌本身是引擎的静态令牌（如实）
 *
 * Node-RED 的 `adminAuth.tokens` 校验函数由引导脚本注入，只认启动时 env 里那一个
 * 值；签发短期令牌需要改引导脚本的校验逻辑（Gate A 刚落地、有并发改动），本切片
 * 不碰它。这里短期化的是**注入租约**，不是令牌字节：令牌只存在于主进程内存与
 * 引擎数据目录（`.engine-admin-token`，0600），从不交给页面/渲染端/Agent。
 *
 * ## 可测性
 *
 * `readToken` / `runningPort` / `getSession` / `now` 都是注入端口：无头套件用假
 * session 捕获监听器、用假时钟推进过期；生产装配在 `ipc/index.ts`。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 编辑器凭据注入的**空闲**租约。活跃请求会滑动续期；空闲超过它 → 停止注入（页面 401）。 */
export const EDITOR_CREDENTIAL_TTL_MS = 30 * 60_000;

/** 回环主机白名单 —— 与 `documentViewHost.checkDocumentViewUrl` 同一套（不另写第二份判据）。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Electron `session.webRequest.onBeforeSendHeaders` 的最小面（套件可注入假实现）。 */
export interface EditorCredentialSessionLike {
  webRequest: {
    onBeforeSendHeaders(
      filter: { urls: string[] },
      listener: (
        details: EditorCredentialRequestDetails,
        callback: (response: { requestHeaders: Record<string, string> }) => void,
      ) => void,
    ): void;
  };
}

/** 监听器收到的详情（只声明本模块用到的字段）。 */
export interface EditorCredentialRequestDetails {
  url: string;
  /** Electron 里恒有；类型上可缺省，缺省按「不是我们的视图」处理。 */
  webContentsId?: number;
  resourceType?: string;
  requestHeaders?: Record<string, string>;
}

/** 绑定判据的注入端口（生产见 `main/ipc/index.ts`；套件用假实现 + 假时钟）。 */
export interface EditorCredentialPorts {
  /** 引擎控制面令牌（只读；不存在返回 null，**不创建**）。 */
  readToken(engineId: string): string | null;
  /** 引擎此刻的监听端口（未运行返回 null）。 */
  runningPort(engineId: string): number | null;
  /** 该 session 的 webRequest（生产 `session.defaultSession`；懒取，构造时可能还没有）。 */
  getSession(): EditorCredentialSessionLike | null;
  /** 时钟（测试可加速）。 */
  now?(): number;
}

/** 宿主（`DocumentViewHost`）使用的凭据注入面 —— 只有 host 会调它。 */
export interface EditorCredentialPort {
  /** 打开前的**只读预检**：令牌/端口/地址任一不合格就不创建视图（fail-closed）。 */
  prepare(input: { engineId: string; url: string }): { ok: true } | { ok: false; reason: string };
  /** 打开后绑定：把「这个 webContents + 这个 origin」记进监听器。 */
  bind(input: {
    docId: string;
    engineId: string;
    url: string;
    webContentsId: number;
  }): { ok: true } | { ok: false; reason: string };
  /** 摘除某个 docId 的绑定（close / closeAll / dispose / 视图改作他用）。 */
  release(docId: string): void;
}

interface Binding {
  docId: string;
  engineId: string;
  /** 归一化 origin：`http(s)://host:port`（请求侧的 ws/wss 会先归一再比较）。 */
  origin: string;
  token: string;
  /** Listener port at bind time. Recheck live identity on every request. */
  port: number;
  webContentsId: number;
  /** 空闲租约到期时间（每次成功注入滑动续期）。 */
  expiresAt: number;
}

/** 从引擎数据目录读控制面令牌（只读；缺失/空 → null）。不创建、不写盘、不记日志。 */
export function readEngineAdminToken(dataDir: string): string | null {
  try {
    const value = readFileSync(join(dataDir, ".engine-admin-token"), "utf8").trim();
    return value !== "" ? value : null;
  } catch {
    return null;
  }
}

/**
 * 把编辑器地址拆成「可注入的 origin + 端口」。
 *
 * 只收本机回环 http(s)：文件页、远程地址、伪装回环后缀（`localhost.evil.com`）
 * 一律拒绝 —— 与宿主 URL 闸同一条口径；这里再判一次是因为**这条路径会带令牌**，
 * 不能只依赖上游校验。
 */
function editorOrigin(rawUrl: string):
  | { ok: true; origin: string; port: number }
  | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `编辑器地址不是合法 URL：${rawUrl.slice(0, 200)}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "编辑器凭据只注入到本机回环 http(s) 页面" };
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { ok: false, reason: `编辑器凭据只注入到本机回环地址，拒绝远程主机：${parsed.hostname || "(空)"}` };
  }
  const port = parsed.port === "" ? 0 : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) {
    return { ok: false, reason: "编辑器地址没有显式端口，无法与会话的监听端口核对" };
  }
  return { ok: true, origin: `${parsed.protocol}//${parsed.host}`, port };
}

/**
 * 请求 URL → 与绑定比较的 origin。WebSocket 握手在 Chromium 里是独立资源类型，
 * URL 是 `ws://…`/`wss://…`；编辑器页的 HTTP 源等价于 `http://…`/`https://…`。
 * 不是这两种协议的（data:、blob:、devtools: …）返回 null = 不注入。
 */
function requestOrigin(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const scheme =
    parsed.protocol === "ws:" ? "http:"
      : parsed.protocol === "wss:" ? "https:"
        : parsed.protocol;
  if (scheme !== "http:" && scheme !== "https:") return null;
  return `${scheme}//${parsed.host}`;
}

export class DocumentViewCredentialBroker implements EditorCredentialPort {
  private readonly ports: EditorCredentialPorts;
  private readonly ttlMs: number;
  private readonly byDocId = new Map<string, Binding>();
  private readonly byWebContents = new Map<number, Binding>();
  private installed = false;

  constructor(ports: EditorCredentialPorts, options: { ttlMs?: number } = {}) {
    this.ports = ports;
    this.ttlMs = options.ttlMs ?? EDITOR_CREDENTIAL_TTL_MS;
  }

  prepare(input: { engineId: string; url: string }): { ok: true } | { ok: false; reason: string } {
    const resolved = this.resolve(input.engineId, input.url);
    return resolved.ok ? { ok: true } : resolved;
  }

  bind(input: {
    docId: string;
    engineId: string;
    url: string;
    webContentsId: number;
  }): { ok: true } | { ok: false; reason: string } {
    if (!Number.isInteger(input.webContentsId) || input.webContentsId <= 0) {
      return { ok: false, reason: "当前视图没有可绑定的 webContents id，无法注入编辑器凭据" };
    }
    const resolved = this.resolve(input.engineId, input.url);
    if (!resolved.ok) return resolved;
    if (!this.ensureInstalled()) {
      return { ok: false, reason: "拿不到 Electron session，无法安装编辑器凭据注入（主窗口尚未就绪）" };
    }
    // 同一 docId 旧绑定（换引擎/换地址）或同一 webContents 的旧绑定先摘掉 ——
    // 一张视图在任一时刻只持有一条凭据绑定。
    this.release(input.docId);
    const previous = this.byWebContents.get(input.webContentsId);
    if (previous !== undefined) this.release(previous.docId);

    const binding: Binding = {
      docId: input.docId,
      engineId: input.engineId,
      origin: resolved.origin,
      token: resolved.token,
      port: resolved.port,
      webContentsId: input.webContentsId,
      expiresAt: this.now() + this.ttlMs,
    };
    this.byDocId.set(binding.docId, binding);
    this.byWebContents.set(binding.webContentsId, binding);
    return { ok: true };
  }

  release(docId: string): void {
    const binding = this.byDocId.get(docId);
    if (binding === undefined) return;
    this.byDocId.delete(docId);
    if (this.byWebContents.get(binding.webContentsId) === binding) {
      this.byWebContents.delete(binding.webContentsId);
    }
  }

  /** 诊断（**不含令牌**）：套件断言绑定生命周期、序列化泄漏用。 */
  debugState(): Array<{
    docId: string;
    engineId: string;
    origin: string;
    webContentsId: number;
    expiresAt: number;
    hasToken: boolean;
  }> {
    return [...this.byDocId.values()].map((b) => ({
      docId: b.docId,
      engineId: b.engineId,
      origin: b.origin,
      webContentsId: b.webContentsId,
      expiresAt: b.expiresAt,
      hasToken: b.token !== "",
    }));
  }

  /** 判定单条请求该带什么头 —— 导出给套件直接钉判据（不经假 session）。 */
  headersForRequest(details: EditorCredentialRequestDetails): Record<string, string> {
    const original = details.requestHeaders ?? {};
    try {
      if (typeof details.webContentsId !== "number") return original;
      const binding = this.byWebContents.get(details.webContentsId);
      if (binding === undefined) return original;
      if (requestOrigin(details.url) !== binding.origin) return original;
      // A window may remain open when Node-RED stops, rebinds its port, or
      // rotates its admin token. A lease is NOT authority to hand that old
      // token to another process which has since claimed the same port.
      // Revalidate the live engine identity before each privileged request.
      if (this.ports.runningPort(binding.engineId) !== binding.port ||
          this.ports.readToken(binding.engineId) !== binding.token) {
        this.release(binding.docId);
        return original;
      }
      const now = this.now();
      if (!(now < binding.expiresAt)) {
        // 空闲到期：如实停发（页面下一次 API 调用会 401）。绑定本身摘掉，状态不撒谎。
        this.release(binding.docId);
        return original;
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(original)) {
        // 页面自己带的 Authorization 一律让位：注入的是宿主身份，不能与页面协商。
        if (key.toLowerCase() !== "authorization") headers[key] = value;
      }
      headers.Authorization = `Bearer ${binding.token}`;
      binding.expiresAt = now + this.ttlMs; // 活跃请求滑动续期
      return headers;
    } catch {
      // 监听器里抛错会让请求挂起 —— 任何意外都退回原始头（不注入、不阻断）。
      return original;
    }
  }

  private resolve(
    engineId: string,
    url: string,
  ):
    | { ok: true; origin: string; token: string; port: number }
    | { ok: false; reason: string } {
    const port = this.ports.runningPort(engineId);
    if (port === null) {
      return { ok: false, reason: `工作流引擎 ${engineId} 不在运行，没有可绑定的编辑器端口` };
    }
    const parsed = editorOrigin(url);
    if (!parsed.ok) return parsed;
    if (parsed.port !== port) {
      return {
        ok: false,
        reason: `编辑器地址端口 ${parsed.port} 与引擎 ${engineId} 的监听端口 ${port} 不一致，拒绝注入控制面凭据`,
      };
    }
    const token = this.ports.readToken(engineId);
    if (token === null || token === "") {
      return { ok: false, reason: `工作流引擎 ${engineId} 还没有控制面令牌（先在面板里启动一次引擎）` };
    }
    return { ok: true, origin: parsed.origin, token, port };
  }

  private ensureInstalled(): boolean {
    if (this.installed) return true;
    let session: EditorCredentialSessionLike | null;
    try {
      session = this.ports.getSession();
    } catch {
      return false;
    }
    if (session === null) return false;
    try {
      // 全 URL 过滤 + 监听器内部按 webContentsId/origin 收窄：Electron 的匹配模式
      // 对端口与 ws: 支持因版本而异，收窄判据放在代码里才是唯一一份。
      session.webRequest.onBeforeSendHeaders({ urls: ["<all_urls>"] }, (details, callback) => {
        callback({ requestHeaders: this.headersForRequest(details) });
      });
      this.installed = true;
      return true;
    } catch {
      return false;
    }
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }
}
