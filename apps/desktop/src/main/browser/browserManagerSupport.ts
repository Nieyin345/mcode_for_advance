/**
 * Top-level support for the embedded browser manager —— 从 `BrowserManager.ts` 拆出
 * (那文件 2700+ 行;这一段 19 个自由变量全是 import 进来的,与 `BrowserManagerImpl`
 * 的视图状态毫无耦合,故可独立成篇)。
 *
 * 带来的是互不依赖的顶层件:
 *   - 只吃 Session / SettingRepo 的会话与 cookie 助手(browserSession /
 *     isPersistLoginEnabled / getBrowserCookies / clearBrowserCookiesForDomains);
 *   - 程序化下载那条路(DownloadIntent / downloadViaBrowser / printUrlToPdf 及意图
 *     登记表),资料库「下载走内嵌浏览器」的原则靠它;
 *   - cookie 保管库与移动 UA 两张表(VaultCookie / DeviceUaSpec / MOBILE_USER_AGENTS …);
 *   - 视图形状与默认落点(LiveBrowser / BrowserBounds / HIDDEN_BOUNDS /
 *     defaultOnscreenBounds)。
 *
 * `BrowserManager.ts` 用 import 拿回去,并把**对外公开的名字原样 re-export**,所以
 * `from "@main/browser/BrowserManager.js"` 的老调用点一行都不用改。
 *
 * 与拆分前唯一的有意差异:`ensureDownloadHandlerReady` 原是模块级可赋值变量,单例在
 * 加载时给它赋值以打破「downloadViaBrowser ↔ 单例」的环。跨模块后 import 绑定只读,
 * 改由 {@link setEnsureDownloadHandlerReady} 承接同一句赋值(行为一致)。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  app,
  BrowserWindow,
  session,
  WebContentsView,
  type Rectangle,
  type Session,
  type Cookie,
} from "electron";
import { withTimeout } from "./browserPure.js";
import {
  BROWSER_DATA_DIR_SETTING_KEY,
  BROWSER_PERSIST_LOGIN_SETTING_KEY,
} from "@contracts/ipc";
import type { BrowserDevicePreset, BrowserViewport } from "@contracts/ipc";
import { getMainWindow } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { SettingRepo } from "@main/store/repositories.js";

/** One tracked download of the shared browser session. Kept in main (recent
 *  50), pushed to the renderer as a "download" browser:event on start and at
 *  the terminal state, and listed for agents via the browser_downloads tool. */
export interface BrowserDownloadEntry {
  id: string;
  browserId: string;
  url: string;
  filename: string;
  /** Absolute path the file is being written to (pre-allocated, deduped). */
  path: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  endedAt?: number;
}

/** Result of a `printToPdf()` — `data` is the PDF bytes base64-encoded; the
 *  caller writes it to disk. */
export interface BrowserPdfResult {
  ok: boolean;
  error?: string;
  data?: string;
}

/** Where downloads land: a fixed subfolder of the OS downloads directory, so
 *  the agent (and the user) always knows where to look. Created lazily. */
export function browserDownloadsDir(): string {
  return join(app.getPath("downloads"), "mcode-browser");
}

/** Dedupe a download filename against existing files on disk AND against
 *  `reserved` (save paths of downloads still in flight): `a.pdf` → `a-1.pdf`,
 *  `a-2.pdf` … (before the extension). Keeps repeated downloads of the same
 *  report from silently overwriting each other.
 *
 *  Why the disk alone is not enough: Chromium streams into a `.crdownload`
 *  temp file and only renames onto the save path when the transfer completes.
 *  While the first `report.pdf` is still downloading, the path does not exist,
 *  so a second same-name download that starts meanwhile (two links clicked,
 *  two tabs, agent + user) used to get the identical save path — the later
 *  `done` then overwrote the earlier file without any error. */
/** Result of a `screenshot()` — `data` is a base64 PNG string. */
export interface BrowserScreenshotResult {
  ok: boolean;
  error?: string;
  data?: string;
  mimeType?: "image/png";
}

/** A pixel rect in window coordinates (the renderer measures + forwards this). */
export interface BrowserBounds extends Rectangle {}

export interface LiveBrowser {
  id: string;
  view: WebContentsView;
  /** Project root this browser is bound to (for consistency with terminal). */
  projectPath: string;
  /** Last applied bounds, so show() can restore after a hide(). */
  lastBounds: BrowserBounds;
  /** True while the view is attached + onscreen; false when hidden offscreen. */
  visible: boolean;
  /** Whether the picker is currently injected (avoids double-inject/remove). */
  pickMode: boolean;
  /** Current device emulation preset (desktop = no emulation). */
  device: BrowserDevicePreset;
  /** Current viewport config (custom dims + orientation). Mirrors what was
   *  last passed to setDevice so screenshots/reuse apply the same emulation. */
  viewport: BrowserViewport;
  /** Original UA captured at create() — restored when leaving a mobile preset
   *  (webContents.setUserAgent fallback path). */
  defaultUserAgent: string;
  /** True while THIS manager holds a CDP debugger session on the view (for the
   *  UA/client-hint override). Lets setDevice detach only its own session. */
  uaDebuggerAttached: boolean;
  /** True while a CDP debugger session pins the page's prefers-color-scheme to
   *  the OS preference (see pinColorScheme). Released before the mobile UA
   *  override takes the (single) debugger slot. */
  csDebuggerAttached: boolean;
  /** Resolves once the cookie vault has been restored into this view's
   *  session (or was skipped). Navigation must wait for it — see loadUrl. */
  ready: Promise<void>;
}

/** Offscreen parking rect used while hidden (keeps the view alive but unseen). */
export const HIDDEN_BOUNDS: Rectangle = { x: -9999, y: -9999, width: 1, height: 1 };

/** Default on-screen bounds for an agent-created view that the renderer hasn't
 *  measured yet. Sized to a reasonable right-panel region of the main window so
 *  the page is visible AND capturable (capturePage on a 1x1 offscreen view
 *  returns an empty image). The renderer's BrowserPanel will re-sync precise
 *  bounds once it mounts and measures its placeholder div. */
export function defaultOnscreenBounds(): Rectangle {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) {
    return { x: 80, y: 80, width: 800, height: 600 };
  }
  const [winW, winH] = win.getContentSize();
  // Right ~42% of the window, leaving room for the center pane. Min 480 wide.
  const panelW = Math.max(480, Math.round(winW * 0.42));
  return { x: Math.max(0, winW - panelW), y: 0, width: panelW, height: winH };
}

/** Fixed background for every browser view. Intentionally theme-independent:
 *  the page (and any blank/loading frame while it paints) keeps the same
 *  backdrop whether the app is in dark or light mode, so the embedded browser
 *  reads as an external window rather than a themed panel. White is Chromium's
 *  default page canvas. */
export const BROWSER_BACKGROUND = "#ffffff";

/** Persistent partition shared by ALL embedded browser views, so cookies /
 *  localStorage / login state is consistent across tabs (mirrors the old
 *  behavior of all views sharing session.defaultSession, but isolated from the
 *  app shell). Used when the user has NOT configured a custom data directory. */
const BROWSER_PARTITION = "persist:mcode-browser";

/** The shared Session for every embedded browser view. When the user has
 *  configured a data directory (browser.dataDir setting) it is created via
 *  `session.fromPath(dir)` — the browser's cookies, form/autofill data,
 *  localStorage, IndexedDB etc. are written straight into that directory.
 *  Empty/absent → Electron's default partition location under userData.
 *
 *  NOTE: Electron caches Session objects by path/partition string, so a
 *  browser.dataDir change only takes effect on the first session lookup of a
 *  run. Changing the setting therefore requires an app restart (the settings
 *  UI tells the user this). */
export function browserSession(): Session {
  const dir = SettingRepo.get(BROWSER_DATA_DIR_SETTING_KEY)?.trim();
  if (!dir) return session.fromPartition(BROWSER_PARTITION);
  // session.fromPath requires an absolute path; a relative value (e.g. typed
  // into the settings input) would be resolved unpredictably — fall back to
  // the default partition location instead.
  if (!isAbsolute(dir)) {
    log.warn(`browser data dir is not absolute, ignoring: ${dir}`);
    return session.fromPartition(BROWSER_PARTITION);
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`browser data dir mkdir failed (falling back to default): ${msg}`);
    return session.fromPartition(BROWSER_PARTITION);
  }
  return session.fromPath(dir);
}

/** Whether cookies should survive restarts via the vault
 *  (`browser.persistLogin`; missing = on, "0" = off). */
export function isPersistLoginEnabled(): boolean {
  return SettingRepo.get(BROWSER_PERSIST_LOGIN_SETTING_KEY) !== "0";
}

/**
 * 读取共享浏览器分区的 cookie —— 「机构认证」功能的唯一数据源。
 *
 * 为什么走这个函数而不是读 cookie 保管库(`browser.cookieVault.enc`):
 * 保管库每 5 分钟才刷新一次,用户刚登录完就查会读到过期快照。`ses.cookies.get()`
 * 拿的是**实时**值。
 *
 * 为什么不做成 BrowserManagerImpl 的方法:该方法只需要 Session,不需要任何视图
 * 状态;挂到类上会逼调用方先拿到 manager 实例,反而绕。也刻意**不动**
 * saveCookieVault / restoreCookieVault —— 那套承担着「重启后登录态不丢」的职责
 * (见其上方注释:Electron ≤40 不会为持久化分区自动落盘 cookie),任何改动都可能
 * 让用户静默登出。
 */
export async function getBrowserCookies(
  filter: { domain?: string; url?: string } = {},
): Promise<Cookie[]> {
  return browserSession().cookies.get(filter);
}

/**
 * 按域名清除登录态(cookie)。返回实际删除的条数。
 *
 * 逐条 remove 而不是 `clearStorageData({storages:["cookies"]})` —— 后者是整分区
 * 清空,会连带把用户在别的站点的登录一起干掉。`cookies.remove` 需要 url + name,
 * 所以这里由 cookie 自身的 domain/path/secure 反推一个能匹配它的 url。
 */
export async function clearBrowserCookiesForDomains(domains: string[]): Promise<number> {
  const ses = browserSession();
  let removed = 0;
  for (const domain of domains) {
    const cookies = await ses.cookies.get({ domain });
    for (const c of cookies) {
      // Cookie.domain 在 Electron 类型里是可选的;没有域的条目无法推导出可匹配的
      // url,remove 必然失败,直接跳过。
      if (!c.domain) continue;
      // 前导点表示父域匹配(.example.com),remove 的 url 不接受
      const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      const scheme = c.secure ? "https" : "http";
      const url = `${scheme}://${host}${c.path || "/"}`;
      try {
        await ses.cookies.remove(url, c.name);
        removed += 1;
      } catch (err) {
        // 单个 cookie 删不掉不该中断整批 —— 常见于域名与 url 推导不匹配
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`cookie remove failed (${c.domain} / ${c.name}): ${msg}`);
      }
    }
  }
  return removed;
}

/* ─────────────────── 程序化下载(资料库用) ─────────────────── */

/**
 * 「下载意图」—— 让程序化发起的下载存到指定路径,而不是默认下载目录。
 *
 * 为什么需要它:共享分区上的 `will-download` 钩子(见 installDownloadListener)
 * 会把**所有**下载都存到 `<downloads>/mcode-browser/` 并重命名去重。资料库需要
 * 精确控制落点(要按 sha256 命名、放进库目录),所以下载前先登记一个意图,
 * 钩子在 `setSavePath` 时优先采用它。
 *
 * 为什么走 `session.downloadURL()` 而不是新开一个 WebContentsView:
 * 前者不需要视图 —— cookie 来自共享分区,代理、UA、重定向全部由 Chromium 处理,
 * 且不会打断用户正在浏览的标签页。这正是「下载走内嵌浏览器」原则的最省事形态。
 */
interface DownloadIntent {
  /** 期望的原始 URL。重定向后可能对不上,故下面还有兜底认领逻辑。 */
  url: string;
  savePath: string;
  settled: boolean;
  resolve: (r: { ok: boolean; path?: string; error?: string }) => void;
}

const downloadIntents = new Set<DownloadIntent>();

/**
 * 让模块级的 {@link downloadViaBrowser} 能保证 `will-download` 的钩子已经装上。
 * 由下面的单例在模块加载时赋值 —— 见 `downloadViaBrowser` 里的说明。
 */
let ensureDownloadHandlerReady: (() => void) | null = null;

/**
 * 认领一个下载意图。
 *
 * 优先按 URL 精确匹配;匹配不到时,**若当前只有一个未认领的意图**则认领它 ——
 * 这是为重定向准备的(`item.getURL()` 拿到的是最终地址,可能与请求地址不同)。
 * 同时有多个意图且都不匹配 URL 时返回 null,宁可让这次下载走默认路径,
 * 也不能把文件塞给错误的请求。
 */
export function claimIntent(url: string): DownloadIntent | null {
  for (const intent of downloadIntents) {
    if (!intent.settled && intent.url === url) return intent;
  }
  const unclaimed = [...downloadIntents].filter((i) => !i.settled);
  return unclaimed.length === 1 ? unclaimed[0] : null;
}

/**
 * 用内嵌浏览器的会话来下载一个 URL,存到指定绝对路径。
 *
 * ⚠️ 这是**唯一**能在主进程拿到 cookie 的下载方式:裸 `fetch`(undici)既不带
 * 会话 cookie 也不读代理环境变量。任何绕过它的自建 HTTP 下载都会在需要登录的
 * 资源上失败。
 *
 * 调用方负责校验拿到的文件确实是要的东西(如 `%PDF` 魔数)—— 认证过期时
 * Chromium 会老老实实把一个登录页 HTML 存下来,不会报错。
 */
export function downloadViaBrowser(req: {
  url: string;
  savePath: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  const timeoutMs = req.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    let settled = false;
    const intent: DownloadIntent = {
      url: req.url,
      savePath: req.savePath,
      settled: false,
      resolve: (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        downloadIntents.delete(intent);
        resolve(r);
      },
    };
    const timer = setTimeout(() => {
      intent.settled = true;
      log.warn(`browser download timed out after ${timeoutMs}ms: ${req.url}`);
      intent.resolve({ ok: false, error: `下载超时(${Math.round(timeoutMs / 1000)} 秒)` });
    }, timeoutMs);

    downloadIntents.add(intent);
    try {
      /*
       * ⚠️ **先保证 `will-download` 的钩子已经装上**,再发起下载。
       *
       * 这个钩子原来只在**创建浏览器视图**时装(见 `createBrowser` →
       * `installDownloadListener`)。于是「点下载时还没打开过浏览器面板」—— 也就是
       * 资料库最常见的用法 —— 会掉进 Chromium 的**默认下载行为**:
       *
       *   ① 弹出系统「另存为」对话框(而这里根本没人能回答它);
       *   ② 把响应原样存到用户选的路径 —— 认证/反爬页返回的是 HTML,于是用户拿到
       *      一个 .pdf 结尾的网页;
       *   ③ 上面登记的 intent 永远等不到 `done` 回调,一直挂到超时,报「下载超时」。
       *
       * 三个症状是同一个原因。钩子本身是幂等的,这里调一次即可。
       */
      ensureDownloadHandlerReady?.();
      // 在同一分区上发起 —— 会触发 will-download,由上面的钩子接管落点
      void browserSession().downloadURL(req.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      intent.resolve({ ok: false, error: `发起下载失败:${msg}` });
    }
  });
}

/**
 * 把一页**打印成 PDF** —— 自动化用户自己那套手工流程。
 *
 * ## 为什么需要它
 *
 * 有一类文献(用户实测的 Nature / Wiley / ScienceDirect / TechRxiv 等)**既不是付费墙,
 * 也没有下载按钮**:点开就在浏览器里内联渲染出 PDF,人只能靠浏览器菜单的
 * 「打印 → 另存为 PDF」才存得下来。而这类站点普遍挂着 Cloudflare 之类的**人机检测**,
 * 程序化的 `session.downloadURL()` 要么挂到超时、要么被 0 字节中断 —— 这一层就是给
 * 这种情况兜底的。
 *
 * 做法:开一个**隐藏窗口**、挂**同一个会话**(所以带着用户已经通过验证的 cookie),
 * 打开那个地址,等 PDF 渲染出来,再走 Chromium 自己的打印管线导出。
 *
 * ## 代价,以及为什么只该当兜底
 *
 * 拿到的是**重新渲染**的 PDF,不是服务端的原始字节:批注、表单域、内嵌文件会丢,
 * 书签结构也会变。所以只在直连下载**全部失败之后**才用它 —— 能拿原件就别拿这个。
 */
export async function printUrlToPdf(req: {
  url: string;
  savePath: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const timeoutMs = req.timeoutMs ?? 45_000;
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: {
        // 同一个会话 = 同一批 cookie。用户在内嵌浏览器里过掉的人机检测,这里也算数。
        session: browserSession(),
        sandbox: true,
      },
    });
    await withTimeout(win.loadURL(req.url), timeoutMs, "打开页面超时");
    // PDF 查看器是**异步渲染**的:`loadURL` 解析完文档时还没画完,不等这一下,
    // printToPDF 很可能导出一页空白。
    await new Promise((r) => setTimeout(r, 2000));
    const pdf = await withTimeout(
      win.webContents.printToPDF({ printBackground: true }),
      timeoutMs,
      "导出 PDF 超时",
    );
    mkdirSync(dirname(req.savePath), { recursive: true });
    writeFileSync(req.savePath, pdf);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      win?.destroy();
    } catch {
      /* 窗口可能已经没了 */
    }
  }
}

/** 给一个 promise 套上超时。用于 loadURL / printToPDF 这类可能永远不返回的原生调用。 */
/** How often the cookie vault is refreshed in the background, so a force-kill
 *  (dev Ctrl+C, crash) loses at most one interval of sign-in state. */
export const PERSIST_LOGIN_INTERVAL_MS = 5 * 60 * 1000;

/** Upper bound on vaulted cookies. A panel browser accumulates far fewer;
 *  the cap just keeps the settings row bounded if something pathological
 *  (tracker explosion) happens. Newest wins is NOT applied — the array is
 *  the session's live cookie list, order is Chromium's. */
export const COOKIE_VAULT_MAX = 400;

/** Serializable snapshot of one cookie. `expirationDate` is omitted for
 *  session cookies, which therefore restore as session cookies — full
 *  fidelity, no expiry rewriting. */
export interface VaultCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: Cookie["sameSite"];
  expirationDate?: number;
}

/** User-Agent + platform metadata used while a mobile preset is active.
 *  enableDeviceEmulation only emulates the viewport — the page's requests
 *  would otherwise keep the desktop Electron UA, so backends still judge the
 *  device as PC. Keyed by preset id; unknown presets ("custom" when narrow)
 *  fall back to ANDROID_UA_SPEC. */
interface DeviceUaSpec {
  /** User-Agent string (HTTP header + navigator.userAgent). */
  ua: string;
  /** Value for CDP Emulation.setUserAgentOverride.platform → navigator.platform. */
  platform: string;
  /** Client-hint platform token (sec-ch-ua-platform / userAgentData.platform). */
  os: "android" | "ios";
  platformVersion: string;
  model: string;
}

export const ANDROID_UA_SPEC: DeviceUaSpec = {
  ua: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  platform: "Linux armv8l",
  os: "android",
  platformVersion: "14.0.0",
  model: "Pixel 7",
};

export const MOBILE_USER_AGENTS: Partial<Record<BrowserDevicePreset, DeviceUaSpec>> = {
  iphone: {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    os: "ios",
    platformVersion: "16.5.0",
    model: "iPhone 14",
  },
  "iphone-se": {
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 15_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    os: "ios",
    platformVersion: "15.5.0",
    model: "iPhone SE",
  },
  android: ANDROID_UA_SPEC,
  "galaxy-s23": {
    ua: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    os: "android",
    platformVersion: "14.0.0",
    model: "SM-S918B",
  },
  "ipad-mini": {
    ua: "Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
    platform: "iPad",
    os: "ios",
    platformVersion: "16.5.0",
    model: "iPad mini",
  },
};

/** Whether a device preset should present a mobile UA. Desktop (no emulation)
 *  is desktop; the phone/tablet presets always mobile; "custom" is mobile only
 *  while narrow enough to be a phone/tablet viewport (wide custom sizes behave
 *  like desktop pages). */
/** CDP UserAgentMetadata for the emulated device: drives the `sec-ch-ua*`
 *  client-hint headers and navigator.userAgentData. Without it a UA override
 *  leaves client hints reporting the real desktop Chrome — the exact "judged
 *  as PC" symptom. Best-effort: Chromium's brands are used even for iOS UAs;
 *  the `mobile: true` flag is what backends actually branch on. */
export function userAgentMetadataFor(spec: DeviceUaSpec) {
  return {
    brands: [
      { brand: "Chromium", version: "124" },
      { brand: "Google Chrome", version: "124" },
      { brand: "Not-A.Brand", version: "99" },
    ],
    fullVersion: "124.0.0.0",
    platform: spec.os === "android" ? "Android" : "iOS",
    platformVersion: spec.platformVersion,
    architecture: "",
    model: spec.model,
    mobile: true,
    bitness: "",
    wow64: false,
  };
}
/**
 * 让 `BrowserManager.ts` 里的单例在加载时把 `will-download` 钩子的安装能力交出来。
 * 不能直接 import 那个单例(会成环),故走这个 setter —— 与拆分前模块内
 * `ensureDownloadHandlerReady = …` 那句赋值等价。
 */
export function setEnsureDownloadHandlerReady(fn: () => void): void {
  ensureDownloadHandlerReady = fn;
}
