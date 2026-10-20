/**
 * 【ARC-007】**受控文档视图宿主**（`main/document/documentViewHost.ts` +
 * `main/ipc/documentView.ts` + `contracts/ipc/documentView.ts`）的无头回归网。
 *
 * ## 为什么可以在纯 node 里验
 *
 * 宿主的视图构造器是**注入**的（`DocumentViewHostPorts.createView`），所以这一套给一个
 * 假 `WebContentsView`：它记录每次 `setBounds` / `loadURL` / `close` / `focus` /
 * `setWindowOpenHandler` 的参数与顺序，于是"一个 docId 一张视图、隐藏保活、关闭才销毁"
 * 这些**状态机承诺**全都能断言。宿主模块本身不顶层 import electron（默认构造器是惰性
 * require），因此 bundle 起来不需要 electron 替身。
 *
 * ## 它钉什么（与任务书逐条对应）
 *
 *  1. **同 docId 复用**：open 两次 → 只有一个 view，bounds 更新、不重复创建；
 *  2. **URL fail-closed**：`https://example.com` / `data:` / `javascript:` /
 *     `file://远程主机` / `localhost.evil.com` 一律拒，且**拒绝路径上没有任何视图
 *     被创建**；`file://` 与 `http(s)://127.0.0.1|localhost|[::1]` 通过；
 *  3. **webPreferences 三项**逐项为真（`contextIsolation` / `nodeIntegration` /
 *     `sandbox`），且所有视图拿到的都一样；
 *  4. **隐藏保活**：hide 后视图仍在、webContents 没被 close、bounds 移到屏幕外且
 *     宽高保留；show 恢复可见坐标；close 才销毁；
 *  5. **窗口级清理**：主窗口 `closed` 事件触发全部销毁；`dispose()` 同样销毁全部，
 *     且之后 open 被拒（不复活视图）；
 *  6. **IPC 层**：七条 `documentView:*` 通道都注册；每条 handler 都进了
 *     `recordRpcHandler`（`app_api_call` 看得见）；zod 拒绝非法 bounds（负数/小数/
 *     超上限/缺字段）且**宿主一次都没被调**；`documentView.list` 返回 `{views:[...]}`。
 *  7. **保存冲突检测（宿主侧乐观锁，第 11 段）**：打开后外改文件 → 保存必须
 *     `reason:"conflict"` 且盘上保留外部内容；没改 → 保存成功且不误报；
 *     冲突经内部 IPC 通道时带页面认识的 `error`。变异验证：撤掉 sha256 比较
 *     （`current !== expected` 恒假）→ 第 11 段 9 条变红，逐字节还原后回到 200/200。
 *  8. **保存的租约互斥（第 12/13 段，TOCTOU 收窄）**：版本比较与写入在同一份
 *     宿主级跨进程租约内（`@main/lib/osFileLease`，与 `ipc/files.ts` 同一实现）。
 *     第 12 段用注入的 `beforeAtomicReplace` 把胜者持锁窗口拉长，**确定性地**
 *     制造"后到者已在等锁"的时序：两个并发保存只有一个成功、另一个 conflict，
 *     盘上是胜者内容，后到者一次都没进临界区；第 13 段用**独立 node 子进程**
 *     证明租约是跨进程事实：子进程持锁时保存必须**等**（不是无视锁直接写），
 *     本进程持锁时子进程 probe 报 busy、释放后能抢到（正反两向）。
 *  9. **打开会话表（第 14 段，DocumentSessionRegistry）**：一条物理路径在任一时刻
 *     只有一个权威会话（归一化走 `physicalPath`：大小写 / `..` / junction 别名
 *     命中同一条）；第二个 docId 打开同一路径被**显式拒绝**并点名持有者；
 *     close/closeAll 摘会话；发送失败回滚登记；保存先过持有者校验、expected 读
 *     会话表里的权威 revision。变异：`physicalPath(filePath)` → 裸字符串 /
 *     `path.resolve` 两次都让 14c 的三条归一化断言真红，cmp 还原后复绿。
 *
 * ## 变异自检（判据承重验证）
 *
 * `checkDocumentViewUrl` 的拒绝分支是这套里最容易"写绿了但没测到"的地方 —— 它一旦被
 * 撤掉，第 2 段的拒绝断言必须变红。这一点靠**手工变异验证**（备份 + python str.replace
 * + 跑套件 + cmp 还原）确认，结果记在任务报告里；套件里不内置自动变异（那会把"测试
 * 自己改自己的源码"变成常态，风险大于收益）。
 *
 * Run: bash scripts/document-view-host-smoke/run.sh
 */
// @smoke-covers src/main/document/documentViewHost.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IpcMain } from "electron";
import {
  IPC,
  DOCUMENT_VIEW_OPEN_CHANNEL,
  DOCUMENT_VIEW_BOUNDS_CHANNEL,
  DOCUMENT_VIEW_SHOW_CHANNEL,
  DOCUMENT_VIEW_HIDE_CHANNEL,
  DOCUMENT_VIEW_FOCUS_CHANNEL,
  DOCUMENT_VIEW_CLOSE_CHANNEL,
  DOCUMENT_VIEW_LIST_CHANNEL,
  DOCUMENT_VIEW_OPEN_PATH_CHANNEL,
  type DocViewResult,
} from "@contracts/ipc";
import {
  DocumentViewHost,
  checkDocumentViewUrl,
  type DocumentViewHostWindow,
  type DocumentViewLike,
  type DocumentViewWebPreferences,
} from "@main/document/documentViewHost.js";
import { registerDocumentViewHandlers, isApprovedDocumentViewOpen } from "@main/ipc/documentView.js";
import {
  DocumentViewCredentialBroker,
  EDITOR_CREDENTIAL_TTL_MS,
  type EditorCredentialRequestDetails,
  type EditorCredentialSessionLike,
} from "@main/document/documentViewCredentialBroker.js";
import { physicalPath } from "@main/lib/realPathWithin.js";
import {
  clearRpcHandlers,
  registeredRpcChannels,
} from "@main/appControl/registry.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
function section(t: string): void {
  console.log("\n" + t);
}

/* ────────────────────── 假视图 / 假窗口 ────────────────────── */

interface FakeViewLog {
  prefs: DocumentViewWebPreferences;
  bounds: Array<{ x: number; y: number; width: number; height: number }>;
  loads: string[];
  focused: number;
  closed: boolean;
  windowOpenHandlerInstalled: boolean;
  /** 【ARC-007】宿主注册的失败监听(诊断钩子)。 */
  failureListeners: Partial<Record<"did-fail-load" | "render-process-gone", (...args: unknown[]) => void>>;
  navigationListeners: Partial<Record<"will-navigate" | "will-redirect", (...args: unknown[]) => void>>;
  /** 宿主经 `webContents.send` 发给页面的所有消息。 */
  sends: Array<{ channel: string; args: unknown[] }>;
  /** 【ARC-006 Gate A 缺口】这个假视图的 webContents id（凭据绑定按它收窄）。 */
  webContentsId: number;
}

/** 按创建顺序记录每个假视图 —— 断言读它。 */
const created: FakeViewLog[] = [];
let nextFakeWebContentsId = 1000;

function makeFakeView(prefs: DocumentViewWebPreferences): DocumentViewLike {
  const log: FakeViewLog = {
    prefs,
    bounds: [],
    loads: [],
    focused: 0,
    closed: false,
    windowOpenHandlerInstalled: false,
    failureListeners: {},
    navigationListeners: {},
    sends: [],
    webContentsId: nextFakeWebContentsId++,
  };
  created.push(log);
  const view: DocumentViewLike = {
    webContents: {
      // 【ARC-006 Gate A 缺口】真实 webContents 恒有 id；凭据注入按它绑定。
      id: log.webContentsId,
      loadURL(url: string) {
        log.loads.push(url);
        return Promise.resolve();
      },
      focus() {
        log.focused += 1;
      },
      close() {
        log.closed = true;
      },
      isDestroyed: () => log.closed,
      setWindowOpenHandler() {
        log.windowOpenHandlerInstalled = true;
      },
      send(channel: string, ...args: unknown[]) {
        log.sends.push({ channel, args });
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "did-fail-load" || event === "render-process-gone") {
          log.failureListeners[event] = listener;
        }
        if (event === "will-navigate" || event === "will-redirect") {
          log.navigationListeners[event] = listener;
        }
        return this;
      },
    },
    setBounds(b) {
      log.bounds.push({ ...b });
    },
  };
  return view;
}

/** 一个能装 child view 的假主窗口：记录 attach/detach，并能手动发 `closed`。 */
interface FakeWindow extends DocumentViewHostWindow {
  attached: unknown[];
  closedListeners: Array<() => void>;
  fireClosed(): void;
}

function makeFakeWindow(): FakeWindow {
  const attached: unknown[] = [];
  const closedListeners: Array<() => void> = [];
  const win: FakeWindow = {
    attached,
    closedListeners,
    isDestroyed: () => false,
    contentView: {
      addChildView(view: unknown) {
        if (!attached.includes(view)) attached.push(view);
      },
      removeChildView(view: unknown) {
        const i = attached.indexOf(view);
        if (i >= 0) attached.splice(i, 1);
      },
    },
    on(event: "closed", listener: () => void) {
      if (event === "closed") closedListeners.push(listener);
      return win;
    },
    removeListener(event: "closed", listener: () => void) {
      const i = closedListeners.indexOf(listener);
      if (event === "closed" && i >= 0) closedListeners.splice(i, 1);
      return win;
    },
    fireClosed() {
      for (const l of [...closedListeners]) l();
    },
  };
  return win;
}

const BOUNDS = { x: 10, y: 20, width: 800, height: 600 };

/**
 * 【ARC-007 P0】打开会话的完整前置：`openPath` 只准备，页面回执
 * (`settlePendingOpen(true)`) 才登记会话。测试里的“打开成功”都用它。
 */
function openAndCommit(
  host: DocumentViewHost,
  docId: string,
  filePath: string,
  within: (p: string) => boolean = () => true,
): DocViewResult {
  const prepared = host.openPath(docId, filePath, within);
  if (!prepared.ok) return prepared;
  return host.settlePendingOpen(docId, true, within);
}
const FILE_URL = "file:///D:/destop/work_space/work_for_reseach/mcode/genoffice/apps/docs/dist/index.html";

/* ══════════════════ 1. open 复用与 bounds 更新 ══════════════════ */

section("1. 同 docId 复用：一个 docId 一张视图，bounds 更新而不重建");
{
  created.length = 0;
  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });

  const r1 = host.open({ docId: "doc-a", url: FILE_URL, bounds: BOUNDS, visible: true });
  eq("第一次 open 成功", r1, { ok: true });
  eq("只创建了一个视图", created.length, 1);
  eq("视图拿到 file:// 导航", created[0].loads, [FILE_URL]);
  eq("可见视图的第一组 bounds 就是入参", created[0].bounds, [BOUNDS]);

  const NEW_BOUNDS = { x: 30, y: 40, width: 640, height: 480 };
  const r2 = host.open({ docId: "doc-a", url: FILE_URL, bounds: NEW_BOUNDS, visible: true });
  eq("第二次 open 同一 docId 成功", r2, { ok: true });
  eq("★ 仍然只有一个视图（复用，不重建）", created.length, 1);
  eq("★ bounds 已更新到视图", created[0].bounds.at(-1), NEW_BOUNDS);
  eq("URL 没变时不重复导航", created[0].loads, [FILE_URL]);

  const snap = host.list();
  eq("list 返回一个 docId 的完整快照", snap.length, 1);
  eq("快照 bounds 是最近一次", snap[0]?.bounds, NEW_BOUNDS);
  eq("快照 visible 为 true", snap[0]?.visible, true);

  // URL 变了才重新导航（复用同一个 view）。
  const r3 = host.open({ docId: "doc-a", url: "http://127.0.0.1:5173/editor", bounds: NEW_BOUNDS, visible: true });
  eq("换 URL 的 open 成功", r3, { ok: true });
  eq("★ 换 URL 仍然复用同一个视图", created.length, 1);
  eq("★ 换 URL 才重新导航", created[0].loads, [FILE_URL, "http://127.0.0.1:5173/editor"]);
  host.dispose();
}

/* ══════════════════ 2. URL fail-closed ══════════════════ */

section("2. URL 闸：只放行 file:// 与本机回环，其余一律拒且不建视图");
{
  created.length = 0;
  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });

  const rejected = [
    "https://example.com/editor.html",
    "http://evil.test/page",
    "https://localhost.evil.com/x", // 伪装后缀：hostname 不是 localhost
    "http://127.0.0.1.evil.com/x",
    "data:text/html,<h1>x</h1>",
    "javascript:alert(1)",
    "file://fileserver.example/share/editor.html", // file: 指向远程主机（UNC）
    "about:blank",
    // FULL-1: WHATWG URL silently strips these bytes, but this is a
    // privileged DocumentHost WebContentsView with a host-only preload.
    // The raw request must be unambiguous before any native view is created.
    "  file:///C:/tmp/editor.html",
    "file:///C:/tmp/ed\titor.html",
    "http://127.0.0.1:5173/ab\nc",
    "http://127.0.0.1:5173/ab\rc",
    // Node-RED editor auth is injected by the Host credential broker, not
    // embedded in a URL that can escape into history/access logs.
    "http://user:password@127.0.0.1:5173/editor",
    "not a url at all",
  ];
  for (const url of rejected) {
    const res = host.open({ docId: "doc-r", url, bounds: BOUNDS, visible: true });
    check(
      `★ 拒绝远程/非白名单 URL：${url}`,
      res.ok === false && typeof res.reason === "string" && res.reason.length > 0,
      res,
    );
  }
  eq("★ 被拒的 open 一个视图都没创建（先拒后建）", created.length, 0);
  eq("拒绝后 list 为空", host.list(), []);

  const allowed = [
    FILE_URL,
    "file:///C:/tmp/editor.html",
    "http://127.0.0.1:5173/",
    "http://localhost:8080/editor",
    "https://127.0.0.1:8443/editor",
    "http://[::1]:3000/",
  ];
  for (const url of allowed) {
    const res = host.open({ docId: `doc-ok-${created.length}`, url, bounds: BOUNDS, visible: false });
    eq(`白名单 URL 通过：${url}`, res, { ok: true });
  }
  eq("★ 通过的白名单 URL 各建且仅建一个视图", created.length, allowed.length);
  host.dispose();
}

// FULL-1: an initially trusted editor page can subsequently try to navigate
// or HTTP-redirect its privileged webContents to an untrusted document.
// The Host must guard the ENTIRE navigation lifecycle, not only open().
{
  created.length = 0;
  const host = new DocumentViewHost({ getMainWindow: makeFakeWindow, createView: makeFakeView });
  eq("导航守卫前置：文档打开成功",
    host.open({ docId: "nav-file", url: FILE_URL, bounds: BOUNDS, visible: true }), { ok: true });
  const fileView = created.at(-1)!;
  const navigateFile = (phase: "will-navigate" | "will-redirect", target: string): boolean => {
    let blocked = false;
    fileView.navigationListeners[phase]?.(
      { preventDefault: () => { blocked = true; } },
      { url: target },
    );
    return blocked;
  };
  eq("★ 文件编辑器禁止导航到远程网页（不能借文档 preload 越权）",
    navigateFile("will-navigate", "https://fake-remote.test/editor"), true);
  eq("★ 文件编辑器禁止导航到另一个本地文件",
    navigateFile("will-navigate", "file:///C:/private/doc.html"), true);
  eq("★ 文件编辑器阻断服务端/页面重定向到不同源",
    navigateFile("will-redirect", "http://127.0.0.1:34567/foreign"), true);
  eq("同一编辑页 hash 导航仍允许",
    navigateFile("will-navigate", FILE_URL + "#selection"), false);
  eq("同一编辑页 query 导航仍允许",
    navigateFile("will-navigate", FILE_URL + "?mode=selection"), false);
  host.dispose();

  created.length = 0;
  const httpHost = new DocumentViewHost({ getMainWindow: makeFakeWindow, createView: makeFakeView });
  eq("引擎编辑器回环初始打开",
    httpHost.open({ docId: "nav-http", url: "http://127.0.0.1:3527/editor", bounds: BOUNDS, visible: false }),
    { ok: true });
  const httpView = created.at(-1)!;
  const navigateHttp = (phase: "will-navigate" | "will-redirect", target: string): boolean => {
    let blocked = false;
    httpView.navigationListeners[phase]?.(
      { preventDefault: () => { blocked = true; } }, { url: target },
    );
    return blocked;
  };
  eq("★ 不能从本机编辑器跳转到其它本机服务端口",
    navigateHttp("will-navigate", "http://127.0.0.1:4189/"), true);
  eq("★ 本机端口相同但主机身份不同仍拒绝",
    navigateHttp("will-redirect", "http://localhost:3527/"), true);
  eq("同源编辑器子路由允许（Node-RED Auth 页面等）",
    navigateHttp("will-redirect", "http://127.0.0.1:3527/auth/login"), false);
  eq("宿主显式切换页时可以更新可信 origin",
    httpHost.open({ docId: "nav-http", url: "http://localhost:3527/editor",
      bounds: BOUNDS, visible: false }), { ok: true });
  eq("旧 origin 在新页面切换后不再可信",
    navigateHttp("will-navigate", "http://127.0.0.1:3527/editor"), true);
  eq("新 origin 的合法本地路由仍然可用",
    navigateHttp("will-redirect", "http://localhost:3527/auth/login"), false);
  httpHost.dispose();
}

// 纯函数级断言：闸本身（不经状态机），把判定锥体钉在原因文案上而不是"某处拒绝"。
{
  eq("file: 普通路径通过", checkDocumentViewUrl("file:///C:/x/y.html").ok, true);
  // 【ARC-006 WF-INT】第三方工作流引擎编辑器地址也是回环 http —— 与文档视图
  // 共用同一条围栏，不需要第二条放行规则（也不需要为它开任何口子）。
  eq("★ 引擎编辑器地址(回环 http)通过同一条围栏",
    checkDocumentViewUrl("http://127.0.0.1:3527/").ok, true);
  eq("localhost 通过", checkDocumentViewUrl("http://localhost:1/").ok, true);
  eq("127.0.0.1 通过", checkDocumentViewUrl("https://127.0.0.1/").ok, true);
  eq("[::1] 通过", checkDocumentViewUrl("http://[::1]:9/").ok, true);
  const remote = checkDocumentViewUrl("https://example.com/");
  check(
    "★ 远程 https 拒绝且原因点名主机",
    remote.ok === false && remote.reason.includes("example.com"),
    remote,
  );
  const scheme = checkDocumentViewUrl("javascript:alert(1)");
  check(
    "javascript: 拒绝且原因点名协议",
    scheme.ok === false && scheme.reason.includes("javascript:"),
    scheme,
  );
  const unc = checkDocumentViewUrl("file://fileserver/share/x.html");
  check("file:// 远程主机拒绝", unc.ok === false && unc.reason.includes("fileserver"), unc);
  const malformed = checkDocumentViewUrl("::::");
  check("解析不了的串拒绝", malformed.ok === false, malformed);
}

/* ══════════════════ 3. webPreferences 三项安全开关 ══════════════════ */

section("3. webPreferences：contextIsolation / nodeIntegration / sandbox 逐项钉死");
{
  created.length = 0;
  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
  host.open({ docId: "doc-p1", url: FILE_URL, bounds: BOUNDS, visible: true });
  host.open({ docId: "doc-p2", url: "http://localhost:5173/", bounds: BOUNDS, visible: false });

  eq("建了两个视图", created.length, 2);
  for (const [i, log] of created.entries()) {
    eq(`视图 ${i}：contextIsolation === true`, log.prefs.contextIsolation, true);
    eq(`视图 ${i}：nodeIntegration === false`, log.prefs.nodeIntegration, false);
    eq(`视图 ${i}：sandbox === true`, log.prefs.sandbox, true);
    eq(`视图 ${i}：装了 window.open 拒绝器`, log.windowOpenHandlerInstalled, true);
  }
  // 逐项写而不是整对象比较：失败时能指出是**哪一项**开关丢了。
  eq("两个视图拿到同一组安全开关", created[0].prefs, created[1].prefs);
  host.dispose();
}

/* ══════════════════ 4. hide 保活 / close 才销毁 ══════════════════ */

section("4. hide 只移出屏幕不销毁；show 恢复；close 才销毁");
{
  created.length = 0;
  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
  host.open({ docId: "doc-h", url: FILE_URL, bounds: BOUNDS, visible: true });
  const log = created[0];

  eq("open 可见时视图挂在窗口上", win.attached.length, 1);

  const hid = host.hide("doc-h");
  eq("hide 成功", hid, { ok: true });
  eq("★ hide 后 webContents 没被销毁（保活）", log.closed, false);
  eq("hide 后 list 里仍有这个 docId（视图在）", host.list().length, 1);
  eq("hide 后 visible=false", host.list()[0]?.visible, false);
  {
    const last = log.bounds.at(-1);
    check(
      "★ hide 把视图移到屏幕外且宽高保留",
      last !== undefined && last.x === -9999 && last.y === -9999 && last.width === BOUNDS.width && last.height === BOUNDS.height,
      last,
    );
  }

  // 隐藏期间 setBounds：记住但**不**应用到视图（隐藏视图停在屏幕外）。
  const HIDDEN_UPDATE = { x: 50, y: 60, width: 700, height: 500 };
  host.setBounds("doc-h", HIDDEN_UPDATE);
  {
    const last = log.bounds.at(-1);
    check(
      "隐藏时 setBounds 不把视图拉回屏幕",
      last !== undefined && last.x === -9999,
      last,
    );
  }
  eq("隐藏时的新几何记进了快照", host.list()[0]?.bounds, HIDDEN_UPDATE);

  const shown = host.show("doc-h");
  eq("show 成功", shown, { ok: true });
  eq("★ show 恢复最近几何", log.bounds.at(-1), HIDDEN_UPDATE);
  eq("show 后 visible=true", host.list()[0]?.visible, true);
  eq("show 不新建视图", created.length, 1);

  // 幂等：重复 show 不再 setBounds（否则原生面重挂会闪白）。
  const beforeRepeat = log.bounds.length;
  host.show("doc-h");
  eq("重复 show 是幂等 no-op", log.bounds.length, beforeRepeat);

  eq("focus 成功", host.focus("doc-h"), { ok: true });
  eq("focus 到达 webContents", log.focused, 1);

  const closed = host.close("doc-h");
  eq("close 成功", closed, { ok: true });
  eq("★ close 才真正销毁 webContents", log.closed, true);
  eq("close 后从窗口摘下", win.attached.length, 0);
  eq("close 后 list 为空", host.list(), []);
  eq("重复 close 幂等成功", host.close("doc-h"), { ok: true });

  // 不存在的 docId：操作应有明确失败（close 除外，它是幂等）。
  check("show 不存在的 docId → ok:false", host.show("nope").ok === false);
  check("hide 不存在的 docId → ok:false", host.hide("nope").ok === false);
  check("focus 不存在的 docId → ok:false", host.focus("nope").ok === false);
  check("setBounds 不存在的 docId → ok:false", host.setBounds("nope", BOUNDS).ok === false);
  host.dispose();
}

/* ══════════════════ 5. 窗口 closed / dispose 清理 ══════════════════ */

section("5. 窗口级清理：closed 事件与 dispose() 都销毁全部");
{
  created.length = 0;
  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
  host.open({ docId: "doc-w1", url: FILE_URL, bounds: BOUNDS, visible: true });
  host.open({ docId: "doc-w2", url: "http://localhost:5173/", bounds: BOUNDS, visible: true });
  eq("两个视图都建好", created.length, 2);
  eq("窗口 closed 钩子已装", win.closedListeners.length, 1);

  win.fireClosed();
  eq("★ 主窗口 closed → 全部视图销毁", created.map((c) => c.closed), [true, true]);
  eq("窗口 attached 清空", win.attached.length, 0);
  eq("closed 之后 list 为空", host.list(), []);
  host.dispose();
}
{
  created.length = 0;
  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
  host.open({ docId: "doc-d1", url: FILE_URL, bounds: BOUNDS, visible: true });
  host.open({ docId: "doc-d2", url: FILE_URL, bounds: BOUNDS, visible: false });

  // closeAll：只销毁、宿主仍可用（与 dispose 的区别）。
  host.closeAll();
  eq("★ closeAll 销毁全部", created.map((c) => c.closed), [true, true]);
  eq("closeAll 后 list 为空", host.list(), []);
  const reopen = host.open({ docId: "doc-d3", url: FILE_URL, bounds: BOUNDS, visible: true });
  eq("closeAll 之后还能再 open（宿主没死）", reopen, { ok: true });

  host.dispose();
  eq("★ dispose 销毁剩余全部", created.map((c) => c.closed), [true, true, true]);
  eq("dispose 摘掉窗口 closed 钩子", win.closedListeners.length, 0);
  const afterDispose = host.open({ docId: "doc-d4", url: FILE_URL, bounds: BOUNDS, visible: true });
  check("★ dispose 之后 open 被拒（不复活视图）", afterDispose.ok === false, afterDispose);
  eq("dispose 之后没有新视图", created.length, 3);
  eq("dispose 幂等", (() => { host.dispose(); return host.list().length; })(), 0);
}
{
  // 主窗口未就绪：open 必须给出可读原因而不是抛。
  created.length = 0;
  const host = new DocumentViewHost({ getMainWindow: () => null, createView: makeFakeView });
  const res = host.open({ docId: "doc-m", url: FILE_URL, bounds: BOUNDS, visible: true });
  check("主窗口未就绪 → ok:false 且带原因", res.ok === false && res.reason.includes("主窗口"), res);
  eq("主窗口未就绪时不创建视图", created.length, 0);
  host.dispose();
}

/* ══════════════════ 6. IPC 层：注册 + zod + recordRpcHandler ══════════════════ */

section("6. IPC：七条通道注册齐全、入 zod、登记进 registry");
{
  created.length = 0;
  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
  clearRpcHandlers();

  const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const fakeIpc = {
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      // 与真 Electron 一致：重复注册立刻炸。
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;

  registerDocumentViewHandlers(fakeIpc, host, () => true, undefined, () => true);

  const channels = [
    DOCUMENT_VIEW_OPEN_CHANNEL,
    DOCUMENT_VIEW_BOUNDS_CHANNEL,
    DOCUMENT_VIEW_SHOW_CHANNEL,
    DOCUMENT_VIEW_HIDE_CHANNEL,
    DOCUMENT_VIEW_FOCUS_CHANNEL,
    DOCUMENT_VIEW_CLOSE_CHANNEL,
    DOCUMENT_VIEW_LIST_CHANNEL,
    DOCUMENT_VIEW_OPEN_PATH_CHANNEL,
  ];
  eq("★ 八条 documentView:* 通道全注册上了", channels.filter((c) => !handlers.has(c)), []);
  // 另有一条**内部通道**（视图 preload 的 open-path）：它不挂成 RPC，
  // 但主进程必须注册 —— 页面打开文档靠它。
  // 【ARC-007】内部通道：打开链（P0）、保存、slides 编辑两条、dirty/替换守卫。
  const internalChannels = [
    "mcode:document-view:open-path",
    "mcode:document-view:read-opened",
    "mcode:document-view:open-committed",
    "mcode:document-view:confirm-replace",
    "mcode:document-view:close-check-result",
    "mcode:document-view:save",
    "mcode:document-view:slides-add-slide",
    "mcode:document-view:slides-edit-text",
    // 【ARC-007 P1/GA1】slides 打开/保存链：页面拉取 `OpenResult`；保存写回打开的
    // 那份文件（页面不传路径/字节）。
    "mcode:document-view:slides-read-opened",
    "mcode:document-view:slides-save",
  ];
  for (const ch of internalChannels) check(`内部通道已注册：${ch}`, handlers.has(ch));
  check("注册的通道就是这八条 + 八条内部通道（不多不漏）",
    JSON.stringify([...handlers.keys()].sort()) ===
      JSON.stringify([...channels, ...internalChannels].sort()),
    {
      actual: [...handlers.keys()].sort(),
      expected: [...channels, ...internalChannels].sort(),
    });

  const rpc = new Set(registeredRpcChannels());
  eq("★ 八条通道全登记进 recordRpcHandler（app_api_call 看得见）", channels.filter((c) => !rpc.has(c)), []);
  // 内部通道**不该**出现在 RPC 表里 —— 那是给页面的，不是给 Agent 的。
  const leakedInternal = internalChannels.filter((c) => rpc.has(c));
  eq("★ 所有内部通道都不在 RPC 表（不扩大 Agent 能力面）", leakedInternal, []);
  eq("IPC 表里的常量与契约字符串一致", IPC.DOCUMENT_VIEW_OPEN, "documentView:open");

  const call = async (channel: string, raw?: unknown): Promise<{ ok?: boolean; reason?: string }> => {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`没有注册 ${channel}`);
    return (await fn(null, raw)) as { ok?: boolean; reason?: string };
  };

  // 正常路径（经 handler 转一手到宿主的假视图）。
  const opened = await call(DOCUMENT_VIEW_OPEN_CHANNEL, { docId: "ipc-1", url: FILE_URL, bounds: BOUNDS, visible: true });
  eq("handler open 成功", opened, { ok: true });
  eq("handler 真的调到了宿主（视图建出来了）", created.length, 1);
  const listed = (await (handlers.get(DOCUMENT_VIEW_LIST_CHANNEL)!(null, undefined))) as {
    views?: Array<{ docId: string }>;
  };
  eq("★ list handler 返回 {views:[…]}", listed.views?.map((v) => v.docId), ["ipc-1"]);

  // zod 拒绝非法 bounds —— 每条都必须 ok:false、带人话原因、且**不建视图**。
  const invalidBounds: Array<[string, Record<string, unknown>]> = [
    ["负数 x", { x: -1, y: 0, width: 100, height: 100 }],
    ["小数 width", { x: 0, y: 0, width: 100.5, height: 100 }],
    ["超大 width", { x: 0, y: 0, width: 999999, height: 100 }],
    ["零宽", { x: 0, y: 0, width: 0, height: 100 }],
    ["缺高度", { x: 0, y: 0, width: 100 }],
  ];
  const createdBefore = created.length;
  for (const [label, bounds] of invalidBounds) {
    const res = await call(DOCUMENT_VIEW_OPEN_CHANNEL, { docId: "ipc-bad", url: FILE_URL, bounds, visible: true });
    check(`★ zod 拒绝非法 bounds（${label}）`, res.ok === false && typeof res.reason === "string", res);
  }
  eq("★ 非法 bounds 一个视图都没建（校验先于宿主）", created.length, createdBefore);
  {
    const res = await call(DOCUMENT_VIEW_BOUNDS_CHANNEL, { docId: "ipc-1", bounds: { x: 0, y: 0, width: -5, height: 10 } });
    check("bounds 通道同样拒绝负数宽度", res.ok === false, res);
    const missing = await call(DOCUMENT_VIEW_OPEN_CHANNEL, { url: FILE_URL, bounds: BOUNDS, visible: true });
    check("open 缺 docId 被拒", missing.ok === false, missing);
    const noReason = await call(DOCUMENT_VIEW_OPEN_CHANNEL, { docId: "x" });
    check("open 几乎空对象被拒", noReason.ok === false, noReason);
    const remote = await call(DOCUMENT_VIEW_OPEN_CHANNEL, { docId: "ipc-r", url: "https://example.com/", bounds: BOUNDS, visible: true });
    check("★ 经 handler 的远程 URL 同样被拒（闸在宿主，不只 schema）", remote.ok === false, remote);
  }

  // show/hide/focus/close 正常走到宿主。
  eq("handler hide 成功", await call(DOCUMENT_VIEW_HIDE_CHANNEL, { docId: "ipc-1" }), { ok: true });
  eq("handler show 成功", await call(DOCUMENT_VIEW_SHOW_CHANNEL, { docId: "ipc-1" }), { ok: true });
  eq("handler focus 成功", await call(DOCUMENT_VIEW_FOCUS_CHANNEL, { docId: "ipc-1" }), { ok: true });
  eq("handler close 成功", await call(DOCUMENT_VIEW_CLOSE_CHANNEL, { docId: "ipc-1" }), { ok: true });
  eq("close 后视图销毁", created[0].closed, true);
  check("show 不存在的 docId 经 handler 返回 ok:false", (await call(DOCUMENT_VIEW_SHOW_CHANNEL, { docId: "ghost" })).ok === false);
  host.dispose();
}

/* ══════════════════ 7. 接线（源码级，三层契约一致性） ══════════════════ */

section("6b. 非受信 URL 不得打开带文档 preload 的原生视图");
{
  created.length = 0;
  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
  const handlers = new Map<string, (evt: unknown, input: unknown) => unknown>();
  const ipc = { handle: (ch: string, cb: (evt: unknown, input: unknown) => unknown) =>
    { handlers.set(ch, cb); } } as unknown as IpcMain;
  // A host policy rejecting all pages must be enforced *before* allocating a
  // privileged native view. Old onOpen ignored this fifth authorization port.
  registerDocumentViewHandlers(ipc, host, () => true, undefined, () => false);
  const open = async (url: string, engine?: string) =>
    await handlers.get(DOCUMENT_VIEW_OPEN_CHANNEL)!(null, {
      docId: "untrusted-" + created.length, url, bounds: BOUNDS, visible: true,
      ...(engine ? { workflowEngineId: engine } : {}),
    }) as {ok: boolean; reason?: string};
  for (const url of [
    "file:///C:/Users/User/Downloads/untrusted.html",
    "file:///C:/tmp/genoffice/apps/docs/out/renderer/index.html?mode=tab",
    "http://127.0.0.1:8080/untrusted",
    "http://localhost:3527/editor",
  ]) {
    const result = await open(url);
    check("★ refused privileged view for unknown editor page " + url,
      result.ok === false, result);
  }
  eq("★ every rejected origin leaves no native webContents allocation",created.length,0);
  host.dispose();
}

// FULL-1: the positive native pages and negative lookalikes must use exactly
// the same production helper installed by ipc/index.ts; a scheme-only filter
// would also reject these cases but destroy useful GenOffice functionality.
section("6c. 唯一真实 GenOffice 资源来源 + Node-RED 引擎绑定");
{
  const {resolve: resolvePath, join: joinPath} = await import("node:path");
  const {pathToFileURL} = await import("node:url");
  const root = resolvePath(process.cwd(), "../..");
  const vendor = joinPath(root, "genoffice");
  const cli = joinPath(vendor, "packages", "cli", "dist", "genoffice.cjs");
  const docsUrl = pathToFileURL(joinPath(vendor, "apps", "docs", "out", "renderer", "index.html")).href + "?mode=tab";
  const slidesUrl = pathToFileURL(joinPath(vendor, "apps", "slides", "out", "renderer", "index.html")).href + "?mode=tab";
  const params = (url: string, extras: Record<string, unknown> = {}) =>
    ({docId:"auth-p",url,visible:true,bounds:BOUNDS,...extras});
  const isAllowed = (url: string, extras: Record<string, unknown> = {}, cliPath: string | null = cli): boolean =>
    isApprovedDocumentViewOpen(params(url,extras) as Parameters<typeof isApprovedDocumentViewOpen>[0],cliPath);
  check("★ native docs original renderer is admitted from host CLI provenance",isAllowed(docsUrl));
  check("★ native slides original renderer is admitted only with slides adapter",isAllowed(slidesUrl,{editor:"slides"}));
  check("★ downloaded lookalike with identical GenOffice subpath is NOT native source",
    !isAllowed("file:///C:/tmp/genoffice/apps/docs/out/renderer/index.html?mode=tab"));
  check("★ spoofed docs URL with editor=slides cannot acquire slides privileges",
    !isAllowed(docsUrl,{editor:"slides"}));
  check("★ spoofed slides HTML cannot acquire docs privileges",
    !isAllowed(slidesUrl));
  check("★ native files are unavailable when no installed CLI exists",
    !isAllowed(docsUrl,{},null));
  check("★ native source with injected fragment cannot gain privilege",
    !isAllowed(docsUrl+"#evil"));
  check("★ query cannot smuggle an alternate renderer mode",
    !isAllowed(docsUrl+"&origin=other"));
  check("★ same-prefix but untrusted HTML remains rejected",
    !isAllowed(docsUrl.replace("index.html", "private.html")));
  check("★ arbitrary loopback service without engine identity rejected",
    !isAllowed("http://127.0.0.1:3527/editor"));
  check("★ real Node-RED editor URL with identity reaches live credential broker",
    isAllowed("http://127.0.0.1:3527/editor",{workflowEngineId:"node-red-1"},null));
  check("★ workflow editor cannot attach Node-RED credentials to a file URL",
    !isAllowed(docsUrl,{workflowEngineId:"node-red-1"}));
  check("★ workflow engine editor cannot masquerade as native Slides",
    !isAllowed("http://127.0.0.1:3527/editor",{editor:"slides",workflowEngineId:"node-red-1"}));
  check("★ malformed CLI location cannot be elevated to native page",
    !isAllowed(docsUrl,{},joinPath(root,"wrong","genoffice.cjs")));
  const installedRoot = joinPath(root, "staged-app", "resources", "genoffice");
  const installedCli = joinPath(installedRoot, "cli", "genoffice.cjs");
  const installedDocs = pathToFileURL(joinPath(installedRoot, "apps", "docs", "out", "renderer", "index.html")).href + "?mode=tab";
  const installedSlides = pathToFileURL(joinPath(installedRoot, "apps", "slides", "out", "renderer", "index.html")).href + "?mode=tab";
  check("★ packaged GenOffice docs original renderer is accepted from native install path",
    isAllowed(installedDocs,{},installedCli));
  check("★ packaged GenOffice slides original renderer remains available",
    isAllowed(installedSlides,{editor:"slides"},installedCli));
  check("★ dev source renderer cannot masquerade as packaged native release",
    !isAllowed(docsUrl,{},installedCli));

  created.length = 0;
  const host = new DocumentViewHost({getMainWindow: makeFakeWindow,createView: makeFakeView});
  const handlers = new Map<string,(evt:unknown,raw:unknown)=>unknown>();
  const ipc = {handle:(ch:string,fn:(evt:unknown,raw:unknown)=>unknown)=>{
    handlers.set(ch,fn);
  }} as unknown as IpcMain;
  registerDocumentViewHandlers(ipc,host,()=>true,undefined,(x)=>isApprovedDocumentViewOpen(x,cli));
  const open = async (url:string,extras:Record<string,unknown>={}) =>
    await handlers.get(DOCUMENT_VIEW_OPEN_CHANNEL)!(null,params(url,extras)) as {ok:boolean};
  check("★ actual IPC refuses a foreign local HTML before allocating native view",
    (await open("file:///C:/tmp/untrusted.html")).ok===false && created.length===0);
  check("★ actual IPC opens only the original native docs renderer",
    (await open(docsUrl)).ok===true && created.length===1);
  check("★ no workflow engine ID means localhost service cannot open",
    (await open("http://localhost:3527/editor")).ok===false && created.length===1);
  host.dispose();
}

section("7. 三层接线：preload / rpcMap / main 注册");
{
  const appDir = process.cwd();
  if (!/apps[\\/]desktop$/.test(appDir)) {
    console.log(`FAIL 基准目录不是 apps/desktop:${appDir}（run.sh 应先 cd 到这里）`);
    failures++;
  } else {
    const repoRoot = appDir.replace(/apps[\\/]desktop$/, "");
    const preload = readFileSync(join(appDir, "src/preload/index.ts"), "utf8");
    const rpcMap = readFileSync(join(repoRoot, "packages/contracts/src/ipc/rpcMap.ts"), "utf8");
    const contract = readFileSync(join(repoRoot, "packages/contracts/src/ipc/documentView.ts"), "utf8");
    const index = readFileSync(join(appDir, "src/main/ipc/index.ts"), "utf8");

    eq("preload 暴露 documentView 命名空间", /documentView:\s*\{/.test(preload), true);
    for (const key of ["open", "bounds", "show", "hide", "focus", "close", "list"]) {
      check(`preload 有 documentView.${key}`, new RegExp(`RpcMap\\["documentView\\.${key}"\\]`).test(preload));
    }
    // 通道字符串本体在契约域文件里(rpcMap 只引用常量,不写第二份字面量)。
    for (const channel of ["documentView:open", "documentView:bounds", "documentView:show", "documentView:hide", "documentView:focus", "documentView:close", "documentView:list"]) {
      check(`契约域文件钉着 ${channel}`, contract.includes(`"${channel}"`));
    }
    for (const key of ["open", "bounds", "show", "hide", "focus", "close", "list"]) {
      check(`RpcMap 声明了 documentView.${key}`, rpcMap.includes(`"documentView.${key}"`));
    }
    check("ipc/index.ts 装配真实 URL 来源与路径围栏", /registerDocumentViewHandlers\(\s*ipc,\s*documentViewHost,/.test(index) && index.includes("isApprovedDocumentViewOpen(input, resolveGenofficeCliPath(documentRepoRoot()))"));
    check("退出路径 dispose 文档视图宿主", readFileSync(join(appDir, "src/main/index.ts"), "utf8").includes("documentViewHost.dispose()"));
  }
}

/* ────────────────────── 收尾 ────────────────────── */

/* ══════════ 8.【ARC-007】加载失败是可诊断的 ══════════
 * vendor 编辑器页依赖 preload 桥(window.desktop.*),而本宿主刻意不给 preload。
 * 没有失败钩子时外层只看到空白,分不清"没加载"与"加载了但崩了"。 */
{
  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
  const okOpen = host.open({
    docId: "diag-1", url: "file:///D:/repo/genoffice/apps/docs/out/renderer/index.html",
    bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true,
  });
  check("前置:视图打开成功", okOpen.ok, okOpen);
  // ⚠️ 用**最后创建**的那个视图:created 是全局累积的,前几段测试已经往里塞过。
  const diagView = created[created.length - 1]!;
  check("前置:本段确实新建了一个视图", diagView !== undefined);
  eq("★ 宿主在 webContents 上装了 did-fail-load 钩子",
    typeof diagView.failureListeners["did-fail-load"], "function");
  eq("★ 宿主在 webContents 上装了 render-process-gone 钩子",
    typeof diagView.failureListeners["render-process-gone"], "function");
  diagView.failureListeners["did-fail-load"]?.({}, -105, "NAME_NOT_RESOLVED", "file:///x", true);
  const snap = host.list().find((v) => v.docId === "diag-1");
  eq("★ 加载失败被记进快照(外层能知道为什么白屏)", snap?.lastFailure?.kind, "load");
  check("★ 失败原因带错误码与描述",
    (snap?.lastFailure?.reason ?? "").includes("-105") && (snap?.lastFailure?.reason ?? "").includes("NAME_NOT_RESOLVED"),
    snap?.lastFailure?.reason);
  diagView.failureListeners["did-fail-load"]?.({}, -3, "ERR_ABORTED", "file:///y", true);
  check("★ ERR_ABORTED(-3) 不算失败(不误报)",
    host.list().find((v) => v.docId === "diag-1")?.lastFailure?.reason?.includes("-105") === true,
    host.list().find((v) => v.docId === "diag-1")?.lastFailure);
  diagView.failureListeners["render-process-gone"]?.({}, { reason: "crashed" });
  eq("★ 渲染进程退出被记成 render-gone",
    host.list().find((v) => v.docId === "diag-1")?.lastFailure?.kind, "render-gone");
  host.closeAll();
}


/* ══════════ 9.【ARC-007】openPath：页面请求打开文档 ══════════ */
{
  const win = makeFakeWindow();
  const sends: Array<{ channel: string; args: unknown[] }> = [];
  const host = new DocumentViewHost({
    getMainWindow: () => win,
    createView: (prefs) => {
      const v = makeFakeView(prefs);
      (v.webContents as { send?: (c: string, ...a: unknown[]) => void }).send = (c, ...a) => { sends.push({ channel: c, args: a }); };
      return v;
    },
  });
  host.open({ docId: "open-1", url: FILE_URL, bounds: BOUNDS, visible: true });

  const ok = host.openPath("open-1", "D:/workspace/doc.docx", () => true);
  check("工作区内路径 → ok", ok.ok, ok);
  // 【ARC-007 P0】打开链 = 宿主**一次** menu:command 通知 + 页面 readOpened
  // 拉取 + open-committed 回执。回环（台账 E1 的 rpcCalls=2）的判据是
  // **preload 不再 invoke open-path**（源码级断言在下面），而不是"不发通知"。
  eq("★ openPath 恰好发一次 menu:command 通知（不是零、也不是回环）", sends.length, 1);
  eq("★ 通知形状是 vendor 认识的 (menu:command, open-path, path)",
    [sends[0]?.channel, sends[0]?.args[0], sends[0]?.args[1]],
    ["menu:command", "open-path", "D:/workspace/doc.docx"]);
  eq("★ openPath 只登记待打开请求", host.pendingOpenFor("open-1")?.filePath, "D:/workspace/doc.docx");

  const before = sends.length;
  const denied = host.openPath("open-1", "C:/Windows/system32/config", () => false);
  check("★ 工作区外路径被拒", denied.ok === false, denied);
  eq("★ 被拒时没有向页面发任何消息（围栏在发之前）", sends.length, before);

  check("不存在的 docId → 拒", host.openPath("nope", "D:/workspace/x.docx", () => true).ok === false);
  check("空路径 → 拒", host.openPath("open-1", "   ", () => true).ok === false);

  // 【ARC-007】**推送与接收必须对得上**：宿主发的 (channel, command) 必须与
  // preload 里订阅的那一对逐字相同。改一边不改另一边 = 静默断链（真发生过）。
  {
    const preloadSrc = readFileSync(join(process.cwd(), "src/main/document/documentViewPreload.ts"), "utf8");
    const hostSrc = readFileSync(join(process.cwd(), "src/main/document/documentViewHost.ts"), "utf8");
    const menuMatch = /MENU_COMMAND_CHANNEL\s*=\s*"([^"]+)"/.exec(preloadSrc);
    const cmdMatch = /OPEN_PATH_COMMAND\s*=\s*"([^"]+)"/.exec(preloadSrc);
    check("preload 声明了 menu:command 订阅", menuMatch !== null, menuMatch?.[1]);
    check("preload 声明了 open-path 命令", cmdMatch !== null, cmdMatch?.[1]);
    eq("★ preload 与宿主用同一个通道名", menuMatch?.[1], "menu:command");
    eq("★ preload 与宿主用同一个命令名", cmdMatch?.[1], "open-path");
    check("★ preload 真的订阅了 menu:command", /ipcRenderer\.on\(MENU_COMMAND_CHANNEL/.test(preloadSrc));
    // 【ARC-007 P0】回环消除的源码级判据：preload 的 openDocxPath **不再 invoke
    // open-path**（改为 read-opened 拉取）。宿主仍发一次通知（单向）。
    check(
      "★ preload 的 openDocxPath 不再 invoke open-path（消除回环）",
      !/openDocxPath[\s\S]{0,300}ipcRenderer\.invoke\(OPEN_DOCUMENT_CHANNEL/.test(preloadSrc) &&
        /openDocxPath[\s\S]{0,300}ipcRenderer\.invoke\(READ_OPENED_CHANNEL/.test(preloadSrc),
    );
    check(
      "★ 宿主仍发一次 menu:command 通知（单向）",
      hostSrc.includes("webContents.send?.(VENDOR_MENU_COMMAND_CHANNEL, VENDOR_OPEN_PATH_COMMAND, filePath)"),
    );
  }

  const live = (host as unknown as { views: Map<string, { view: { webContents: unknown } }> }).views.get("open-1");
  eq("★ docIdForSender 能反查真实视图", host.docIdForSender(live?.view.webContents), "open-1");
  eq("★ 陌生 sender 反查为 null（页面伪造不了身份）", host.docIdForSender({}), null);
  host.closeAll();
}


/* ══════════ 10.【ARC-007】saveOpenedFile：只写回本视图打开过的那份文件 ══════════ */
{
  // 真实临时目录（这一条要验磁盘事实：原子写真的落到打开的那份文件上）。
  const { mkdtempSync, writeFileSync, readFileSync: readFileSync2, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const workspace = mkdtempSync(joinPath(tmpdir(), "mcode-dv-save-"));
  const opened = joinPath(workspace, "opened.docx");
  const other = joinPath(workspace, "other.docx");
  writeFileSync(opened, "original", "utf8");
  writeFileSync(other, "untouched", "utf8");

  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
  host.open({ docId: "save-1", url: FILE_URL, bounds: BOUNDS, visible: true });

  const deniedNoDoc = await host.saveOpenedFile("save-1", new Uint8Array([1, 2, 3]), () => true);
  check("★ 视图还没打开任何文档时，保存被拒", deniedNoDoc.ok === false, deniedNoDoc);

  eq("openPath 记下这份文档", openAndCommit(host, "save-1", opened), { ok: true });
  const saved = await host.saveOpenedFile("save-1", new TextEncoder().encode("edited-bytes"), () => true);
  check("★ 保存成功并回报字节数", saved.ok === true && saved.bytes === "edited-bytes".length, saved);
  eq("★ 盘上内容真的变了", readFileSync2(opened, "utf8"), "edited-bytes");
  eq("★ 只写了打开的那份，工作区里别的文件不动", readFileSync2(other, "utf8"), "untouched");

  const empty = await host.saveOpenedFile("save-1", new Uint8Array(), () => true);
  check("★ 空内容被拒（不能把文档清空）", empty.ok === false, empty);

  const notBytes = await host.saveOpenedFile("save-1", "a string" as unknown as Uint8Array, () => true);
  check("★ 非字节内容被拒", notBytes.ok === false, notBytes);

  // 工作区集合变了（项目被移除）→ 保存也要拒，即使文件还在这里。
  const movedOut = await host.saveOpenedFile("save-1", new TextEncoder().encode("x"), () => false);
  check("★ 文档已不在工作区时拒绝保存", movedOut.ok === false, movedOut);
  eq("被拒时盘上仍是上一次成功的内容", readFileSync2(opened, "utf8"), "edited-bytes");

  // 页面无法指定目标：宿主只认 openedFilePath（openPath 到 other 之后才改目标）。
  eq("改打开另一份之后目标随之改变", openAndCommit(host, "save-1", other), { ok: true });
  const saved2 = await host.saveOpenedFile("save-1", new TextEncoder().encode("second"), () => true);
  check("第二份保存成功", saved2.ok === true, saved2);
  eq("第二份内容落盘", readFileSync2(other, "utf8"), "second");
  eq("第一份不再被改动", readFileSync2(opened, "utf8"), "edited-bytes");

  const missing = await host.saveOpenedFile("nope", new Uint8Array([1]), () => true);
  check("不存在的 docId → 拒", missing.ok === false, missing);

  check("前提：临时目录仍在（不是假路径）", existsSync(workspace));
  host.closeAll();
  await (await import("node:fs/promises")).rm(workspace, { recursive: true, force: true });
}


/* ══════════ 11.【ARC-007】保存冲突检测：宿主侧乐观锁（expectedRevision） ══════════
 * vendor 的保存链路 `saveDocx(path, data, auto)` 不携带版本（页面不知道自己读的是
 * 哪个版本），所以 expected 由宿主在 openPath 时记下。判据：打开后文件被别处改过
 * → 保存必须报 conflict 且**一个字节都不写盘**；没人动过 → 保存成功且不误报。 */
{
  const { mkdtempSync, writeFileSync, readFileSync: readSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { rm } = await import("node:fs/promises");
  const workspace11 = mkdtempSync(joinPath(tmpdir(), "mcode-dv-conflict-"));
  const doc = joinPath(workspace11, "thesis.docx");
  writeFileSync(doc, "opened-content", "utf8");
  const sha = (s: string): string => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
  host.open({ docId: "conf-1", url: FILE_URL, bounds: BOUNDS, visible: true });
  eq("openPath 成功（记下打开时版本）", openAndCommit(host, "conf-1", doc), { ok: true });

  // ── 情形 A：打开后没人动过 → 保存成功，且回传新 revision ──
  const cleanSave = await host.saveOpenedFile("conf-1", new TextEncoder().encode("clean-edit"), () => true);
  check("★ 没人动过文件时保存成功（乐观锁不误报）", cleanSave.ok === true, cleanSave);
  check("★ 成功保存回传写后内容的 revision（供页面下次携带）",
    cleanSave.ok === true && cleanSave.revision === sha("clean-edit"), cleanSave);
  eq("★ 成功保存的内容真的落盘", readSync(doc, "utf8"), "clean-edit");
  // 自己上一次保存要把打开时版本推进 —— 连续第二次保存不该被自己的上一版判冲突。
  const secondSave = await host.saveOpenedFile("conf-1", new TextEncoder().encode("clean-edit-2"), () => true);
  check("★ 基于自己上一次保存的连续保存不被误判冲突", secondSave.ok === true, secondSave);

  // ── 情形 B：外面改文件 → 页面保存必须 conflict 且盘上保留外部内容 ──
  writeFileSync(doc, "outside-agent-edit", "utf8");
  const conflicted = await host.saveOpenedFile("conf-1", new TextEncoder().encode("page-save-should-not-land"), () => true);
  check("★ 外部改动后保存被拒且 reason 恰为 conflict",
    conflicted.ok === false && conflicted.reason === "conflict", conflicted);
  check("★ 冲突回包带盘上当前 revision（与外部内容的 sha256 一致）",
    conflicted.ok === false && conflicted.currentRevision === sha("outside-agent-edit"), conflicted);
  check("★ 冲突回包带人话说明（页面能原样显示）",
    conflicted.ok === false && typeof conflicted.message === "string" && conflicted.message.length > 0, conflicted);
  eq("★★ 冲突时盘上是外部内容，页面字节一个都没写进去", readSync(doc, "utf8"), "outside-agent-edit");
  {
    const snap = host.list().find((v) => v.docId === "conf-1");
    check("★ 冲突记进 list 快照 lastSaveConflict（面板有第二条可见路径）",
      snap?.lastSaveConflict?.currentRevision === sha("outside-agent-edit"), snap?.lastSaveConflict);
  }

  // ── 情形 C：显式 expectedRevision（将来页面携带版本的入口） ──
  const explicitBad = await host.saveOpenedFile("conf-1", new TextEncoder().encode("x"), () => true, sha("some-old-version"));
  check("★ 显式 expectedRevision 不匹配时同样 conflict", explicitBad.ok === false && explicitBad.reason === "conflict", explicitBad);
  const explicitGood = await host.saveOpenedFile("conf-1", new TextEncoder().encode("explicit-ok"), () => true, sha("outside-agent-edit"));
  check("★ 显式 expectedRevision 与盘上一致时保存通过", explicitGood.ok === true, explicitGood);
  eq("★ 显式路径写入落盘", readSync(doc, "utf8"), "explicit-ok");
  {
    const snap = host.list().find((v) => v.docId === "conf-1");
    eq("★ 成功保存后 lastSaveConflict 被清空", snap?.lastSaveConflict, undefined);
  }

  // ── 情形 D：冲突经内部 IPC 通道到页面时带 `error`（vendor 读 error 显示失败） ──
  {
    writeFileSync(doc, "outside-again", "utf8");
    const handlers11 = new Map<string, (event: unknown, raw: unknown) => unknown>();
    const fakeIpc11 = {
      handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
        handlers11.set(channel, listener);
      },
    } as unknown as IpcMain;
    registerDocumentViewHandlers(fakeIpc11, host, () => true, undefined, () => true);
    const sender = (host as unknown as { views: Map<string, { view: { webContents: unknown } }> })
      .views.get("conf-1")?.view.webContents;
    const reply = (await handlers11.get("mcode:document-view:save")!(
      { sender },
      { bytes: new TextEncoder().encode("page-bytes") },
    )) as { ok?: boolean; reason?: string; error?: string; currentRevision?: string | null };
    check("★ 内部保存通道把冲突翻成页面认识的 reason/error",
      reply.ok === false && reply.reason === "conflict" && typeof reply.error === "string" && reply.error.length > 0,
      reply);
    check("★ 内部通道冲突回包同样带 currentRevision", reply.currentRevision === sha("outside-again"), reply);
    eq("★ 经内部通道的冲突同样不写盘", readSync(doc, "utf8"), "outside-again");
    // 陌生 sender：照旧拒绝（身份不因新字段而放宽）。
    const stranger = (await handlers11.get("mcode:document-view:save")!(null, { bytes: new Uint8Array([1]) })) as { ok?: boolean };
    check("★ 陌生 sender 的保存请求仍被拒", stranger.ok === false, stranger);
  }

  host.closeAll();
  await rm(workspace11, { recursive: true, force: true });
}

/* ══════════ 12.【ARC-007】保存的租约互斥：比较 + 写入是一个临界区 ══════════
 *
 * 背景：`saveOpenedFile` 从前是"重算 sha256 → 比较 → atomicReplaceFile"三步，
 * 比较与写入之间存在 TOCTOU 窗口：两个保存（另一个窗口 / 另一个 Mcode 进程）可以
 * 都读到旧版本、都通过比较、再先后 rename —— 后者静默覆盖前者。修复把整段包进
 * `withOsFileLease`（宿主级跨进程租约，与 ipc/files.ts 同一份）。
 *
 * 判据怎么做到**确定性**：`beforeAtomicReplace` 是宿主构造参数里的诊断/测试接缝，
 * 只在"锁内、比较通过、替换之前"调用。这里让**第一次**进入临界区的保存在此挂起，
 * 等确定第二个保存已经发出并卡在锁上（轮到它就必须等第一个释放）再放行。于是：
 *   - 修复在：第二个保存的 expected 快照是打开时版本（在取锁之前拍下），第一个
 *     落盘后它进锁重算必然看到新版本 → conflict；盘上是第一个的内容；它一次都没
 *     走到 `beforeAtomicReplace`（没进临界区）。
 *   - 撤掉租约包裹：第二个保存的"重算 → 比较 → 写"与第一个完全交错，两个都成功，
 *     盘上变成第二个的内容 —— 下面 5 条红。
 */
{
  const { mkdtempSync, writeFileSync, readFileSync: readSync12 } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { rm } = await import("node:fs/promises");
  const ws12 = mkdtempSync(joinPath(tmpdir(), "mcode-dv-lease-"));
  const doc12 = joinPath(ws12, "lease.docx");
  writeFileSync(doc12, "lease-open", "utf8");
  const sha12 = (s: string): string => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

  // 胜者在临界区里的挂起点：第一次进入就挂住，直到测试显式放行。
  let enteredCritical = 0;
  let releaseWinner!: () => void;
  const winnerGate = new Promise<void>((resolve) => { releaseWinner = resolve; });
  const win = makeFakeWindow();
  const host = new DocumentViewHost({
    getMainWindow: () => win,
    createView: makeFakeView,
    beforeAtomicReplace: async () => {
      enteredCritical += 1;
      if (enteredCritical === 1) await winnerGate;
    },
  });
  host.open({ docId: "lease-1", url: FILE_URL, bounds: BOUNDS, visible: true });
  eq("前置：openPath 成功并记下打开时版本", openAndCommit(host, "lease-1", doc12), { ok: true });

  // 两个保存几乎同时发出：A 先拿到租约并挂在接缝上；B 发出后必然卡在租约上。
  const saveA = host.saveOpenedFile("lease-1", new TextEncoder().encode("winner-A"), () => true);
  // 等到 A 真正进入临界区（挂起在接缝上 = 租约已被 A 持有），再发 B。
  // **有界等待**：若修复被撤掉（如会话持有者校验先拒了保存），临界区永远进不去 ——
  // 无界自旋会让整套挂死而不是报红。超时后照常走完，断言在下面如实变红。
  {
    const deadline = Date.now() + 3000;
    while (enteredCritical === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  }
  check("前置：胜者已进入保存临界区", enteredCritical > 0, { enteredCritical });
  const saveB = host.saveOpenedFile("lease-1", new TextEncoder().encode("loser-B"), () => true);
  // 给 B 足够时间走到"等锁"（修复时）或"完成整个保存"（变异时）。
  await new Promise((r) => setTimeout(r, 300));
  releaseWinner();
  const [resA, resB] = await Promise.all([saveA, saveB]);

  const okCount = [resA, resB].filter((r) => r.ok).length;
  const conflictCount = [resA, resB].filter((r) => !r.ok && r.reason === "conflict").length;
  check("★ 两个并发保存只有一个成功、另一个 conflict（不静默双写）",
    okCount === 1 && conflictCount === 1, { resA, resB });
  check("★ 先拿到租约的一方胜出（A 成功）", resA.ok === true, resA);
  check("★ 落败者的 conflict 回包带盘上当前版本（胜者内容的 sha256）",
    resB.ok === false && resB.reason === "conflict" && resB.currentRevision === sha12("winner-A"), resB);
  eq("★★ 盘上是胜者的内容（落败者一个字节都没写进去）", readSync12(doc12, "utf8"), "winner-A");
  eq("★ 落败者一次都没进入临界区（租约把它挡在比较之前）", enteredCritical, 1);
  {
    const snap = host.list().find((v) => v.docId === "lease-1");
    eq("冲突记进快照 lastSaveConflict（面板可见）", snap?.lastSaveConflict?.currentRevision, sha12("winner-A"));
  }

  // 后续保存基于胜者版本，不被上一轮并发误伤（成功路径会清冲突并推进打开时版本）。
  const after = await host.saveOpenedFile("lease-1", new TextEncoder().encode("after-A"), () => true);
  check("★ 并发之后的下一次保存正常成功（打开时版本已推进到胜者内容）", after.ok === true, after);
  eq("after 内容落盘", readSync12(doc12, "utf8"), "after-A");

  // 租约释放后锁文件不该残留（否则下一次别的进程会被一把死锁挡住 60 秒）。
  const { existsSync: exists12 } = await import("node:fs");
  eq("★ 租约释放后没有残留锁文件", exists12(`${doc12}.mcode-lock`), false);

  host.closeAll();
  await rm(ws12, { recursive: true, force: true });
}


/* ══════════ 13.【ARC-007】租约是跨进程事实：独立 node 子进程持锁 ══════════
 *
 * 第 12 段只能证明"同一进程内两个 async 保存被串行"。这里的判据必须是**另一个
 * OS 进程**：run.sh 把同一份 `osFileLease.ts` 内联给子进程（leaseChild.mjs），
 * 子进程用 `hold` 抢住 `<file>.mcode-lock` 并在 stdout 报 `held`；此时宿主保存：
 *   a) 必须**等**着 —— 子进程持锁 2.5 秒期间保存不能落盘、也不能报成功；
 *   b) 若这段时间里盘上内容被改成了新版本（测试在子进程持锁期间直接写盘，模拟
 *      "另一进程已写入"的最坏情况），宿主拿到锁后必须**重算**并报 conflict，
 *      而不是拿发请求时的旧结论盲写；
 *   c) 反向：宿主持锁时子进程 `probe` 报 busy，宿主释放后 probe 能抢到 —— 证明
 *      两边锁的是同一个磁盘事实（不是各自进程内的 Map）。
 */
{
  const { mkdtempSync, writeFileSync, readFileSync: readSync13 } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { rm } = await import("node:fs/promises");
  const { existsSync: exists13 } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const ws13 = mkdtempSync(joinPath(tmpdir(), "mcode-dv-xproc-"));
  const doc13 = joinPath(ws13, "xproc.docx");
  writeFileSync(doc13, "xproc-open", "utf8");
  const sha13 = (s: string): string => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
  const childEntry = process.env.MCODE_DV_LEASE_CHILD ?? "";

  if (!exists13(childEntry)) {
    check(`跨进程租约段需要 leaseChild 入口（run.sh 应设置 MCODE_DV_LEASE_CHILD，当前：${childEntry || "(空)"}）`, false);
  } else {
    const runChild = (args: string[]): { child: import("node:child_process").ChildProcess; done: Promise<string> } => {
      const child = spawn(process.execPath, [childEntry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      const done = new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout!.on("data", (d: Buffer) => { out += d.toString("utf8"); });
        child.once("error", reject);
        child.once("close", () => resolve(out));
      });
      return { child, done };
    };

    // ── a/b：子进程持锁 2.5s，宿主保存必须等它释放 ──
    {
      const win = makeFakeWindow();
      const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
      host.open({ docId: "xproc-1", url: FILE_URL, bounds: BOUNDS, visible: true });
      eq("前置：openPath 成功", openAndCommit(host, "xproc-1", doc13), { ok: true });

      const { child, done } = runChild(["hold", doc13, "2500"]);
      // 等子进程报 `held`（它已持有磁盘锁）再发起保存。
      await new Promise<void>((resolve) => {
        child.stdout!.on("data", (d: Buffer) => {
          if (d.toString("utf8").includes("held")) resolve();
        });
      });

      const t0 = Date.now();
      const saving = host.saveOpenedFile("xproc-1", new TextEncoder().encode("host-bytes"), () => true);
      // 子进程仍在持锁期间：保存不得落盘、不得报成功（它要么在等，要么已经错误地无视锁写完）。
      await new Promise((r) => setTimeout(r, 700));
      eq("★ 子进程持锁期间：宿主保存没有落盘", readSync13(doc13, "utf8"), "xproc-open");
      const result = await saving;
      const settledEarly = Date.now() - t0 < 1500;
      const childOut = await done;
      check("★ 子进程确实持满并释放了锁（stderr 无异常）", childOut.includes("released"), childOut);
      check("★ 宿主保存等到锁释放之后才拿到结论（不是立刻写）", settledEarly === false, { settledEarly });
      // 子进程没改文件内容，但宿主 openPath 时记的 expected 仍是 "xproc-open"，
      // 所以锁释放后保存应**成功**（盘上版本没变）—— 关键判据是它等过锁。
      check("★ 锁释放后保存成功（盘上版本未被改动）", result.ok === true, result);
      eq("★ 保存内容落盘", readSync13(doc13, "utf8"), "host-bytes");
      eq("★ 子进程释放后不再有锁文件残留", exists13(`${doc13}.mcode-lock`), false);
      host.closeAll();
    }

    // ── b2：子进程在持锁期间**改掉文件内容**，宿主保存必须 conflict（不是等待后盲写） ──
    {
      const docB = joinPath(ws13, "xproc-b.docx");
      writeFileSync(docB, "b-open", "utf8");
      const win = makeFakeWindow();
      const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
      host.open({ docId: "xproc-b", url: FILE_URL, bounds: BOUNDS, visible: true });
      eq("前置：openPath 成功（b）", openAndCommit(host, "xproc-b", docB), { ok: true });
      // 让宿主的"打开时版本"先算完（否则保存会在取锁前 await 它，语义仍对，只是时序不好看）。
      await new Promise((r) => setTimeout(r, 50));

      const { child, done } = runChild(["hold", docB, "1500"]);
      await new Promise<void>((resolve) => {
        child.stdout!.on("data", (d: Buffer) => {
          if (d.toString("utf8").includes("held")) resolve();
        });
      });
      // 子进程持锁期间，由测试直接改盘（模拟"另一进程在锁内写入了新版本"的最坏情况）。
      writeFileSync(docB, "written-by-other-process", "utf8");
      const result = await host.saveOpenedFile("xproc-b", new TextEncoder().encode("page-bytes"), () => true);
      await done;
      check("★ 另一进程改过盘后，宿主保存报 conflict（等锁后重算，不盲写）",
        result.ok === false && result.reason === "conflict", result);
      check("★ conflict 回包带盘上当前版本", result.ok === false && result.currentRevision === sha13("written-by-other-process"), result);
      eq("★★ 盘上是另一进程的内容（宿主字节一个都没写进去）", readSync13(docB, "utf8"), "written-by-other-process");
      host.closeAll();
    }

    // ── c：宿主持锁时子进程 probe 报 busy；释放后 probe 抢到 ──
    {
      const docC = joinPath(ws13, "xproc-c.docx");
      writeFileSync(docC, "c-open", "utf8");
      const { acquireOsFileLease } = await import("@main/lib/osFileLease.js");
      const release = await acquireOsFileLease(`${docC}.mcode-lock`);
      try {
        const { done } = runChild(["probe", docC, "250"]);
        const out = await done;
        check("★ 宿主持锁时独立进程 probe 报 busy（锁是跨进程的）", out.trim() === "busy", out.trim());
      } finally {
        await release();
      }
      const { done: done2 } = runChild(["probe", docC, "250"]);
      const out2 = await done2;
      check("★ 宿主释放后独立进程 probe 能抢到（正控：不是 probe 永远 busy）", out2.trim() === "acquired", out2.trim());
    }
  }

  await rm(ws13, { recursive: true, force: true });
}

/* ══════════ 14.【ARC-007 DocumentSessionRegistry】打开会话表：一条物理路径一个持有者 ══════════
 *
 * 判据（见 `documentViewHost.ts` 文件头「打开会话表」）：
 *  - 同一路径第二次 openPath（另一个 docId）→ 显式拒绝并点名持有者；
 *  - 不同路径 → 各自独立的 docId / 会话，互不影响；
 *  - close 之后同一路径可重开，且会话 revision 是**当下**盘上的版本；
 *  - 路径归一化：大小写、`..`、混合分隔符、经 junction 的别名命中同一条会话。
 *
 * （切片原本作为第 12 段交付；合入时租约切片的第 12/13 段已在 HEAD，故顺延为第 14 段，
 *  两节的断言都保留。）
 *
 * 变异验证（手工）：把 `claimOpenedPath` 的 `physicalPath(filePath)` 改成
 * `filePath`（纯字符串比较）→ 本节 14c 的归一化断言真红。
 */
{
  const { mkdtempSync, writeFileSync, readFileSync: readSync14, rmSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath14, dirname, basename } = await import("node:path");
  const { createHash: createHash14 } = await import("node:crypto");
  const sha14 = (s: string): string => createHash14("sha256").update(Buffer.from(s, "utf8")).digest("hex");

  const ws14 = mkdtempSync(joinPath14(tmpdir(), "mcode-dv-sessions-"));
  const a = joinPath14(ws14, "alpha.docx");
  const b = joinPath14(ws14, "beta.docx");
  writeFileSync(a, "alpha-v1", "utf8");
  writeFileSync(b, "beta-v1", "utf8");

  const win14 = makeFakeWindow();
  /** true 时新视图**接受** send；false 时 send 抛（验证回滚）。 */
  let sendWorks = true;
  /** 假视图 → 它收到的 send 记录（makeFakeView 的内部 log 不对外暴露，这里另记一份）。 */
  const sendLogs = new Map<object, Array<{ channel: string; args: unknown[] }>>();
  const host14 = new DocumentViewHost({
    getMainWindow: () => win14,
    createView: (prefs) => {
      const v = makeFakeView(prefs);
      const log: Array<{ channel: string; args: unknown[] }> = [];
      sendLogs.set(v, log);
      (v.webContents as { send?: (c: string, ...args: unknown[]) => void }).send = (c, ...args) => {
        if (!sendWorks) throw new Error("send failed (test injection)");
        log.push({ channel: c, args });
      };
      return v;
    },
  });
  const menuSendsOf = (docId: string): Array<{ channel: string; args: unknown[] }> => {
    const v = (host14 as unknown as { views: Map<string, { view: DocumentViewLike }> }).views.get(docId)?.view;
    if (v === undefined) return [];
    return (sendLogs.get(v as object) ?? []).filter((m) => m.channel === "menu:command");
  };
  const openView = (docId: string): void => {
    const r = host14.open({ docId, url: FILE_URL, bounds: BOUNDS, visible: true });
    if (!r.ok) throw new Error(`test setup: open ${docId} failed: ${r.reason}`);
  };

  openView("s-a");
  openView("s-b");

  // ── 14a. 同一路径两个 docId → 第二个被显式拒绝，且点名持有者 ──
  eq("第一个 docId 打开 alpha 成功", openAndCommit(host14, "s-a", a), { ok: true });
  // 【ARC-007 P0】打开请求改由页面拉取（readOpened），不再有 menu:command 推送；
  // 回执提交后待打开请求清空 —— 「只有一条打开请求」= 没有回环、没有残留。
  eq("提交后没有残留的待打开请求", host14.pendingOpenFor("s-a"), null);
  eq("★ 打开请求恰好一条 menu:command 通知（无回环）", menuSendsOf("s-a").length, 1);
  const second = (() => { const prep = host14.openPath("s-b", a, () => true); return prep.ok ? host14.settlePendingOpen("s-b", true, () => true) : prep; })();
  check(
    "★ 同一路径第二次 openPath（另一个 docId）被显式拒绝",
    second.ok === false && second.reason.includes("已在另一个视图打开"),
    second,
  );
  check("★ 拒绝文案点名持有者 docId", second.ok === false && second.reason.includes("s-a"), second);
  eq("★ 被拒的 docId 没有登记会话", host14.sessionFor("s-b"), null);
  eq("★ 被拒时没有向它的页面发打开请求", menuSendsOf("s-b").length, 0);
  check(
    "★ 被拒的视图不能保存 alpha（打开记录没有落到它头上）",
    (await host14.saveOpenedFile("s-b", new TextEncoder().encode("hijack"), () => true)).ok === false,
  );
  eq("★ alpha 仍是原内容（被拒路径一个字节都没写）", readSync14(a, "utf8"), "alpha-v1");

  // ── 14b. 两个不同路径 → 两个 docId 互不影响 ──
  eq("另一个 docId 打开 beta 成功", openAndCommit(host14, "s-b", b), { ok: true });
  eq("alpha 仍由 s-a 持有", host14.sessionFor("s-a")?.filePath, a);
  eq("beta 由 s-b 持有", host14.sessionFor("s-b")?.filePath, b);
  check(
    "★ 两个会话的归一化键不同（不同文件不互相阻塞）",
    host14.sessionFor("s-a")!.key !== host14.sessionFor("s-b")!.key,
  );
  const saveA14 = await host14.saveOpenedFile("s-a", new TextEncoder().encode("alpha-v2"), () => true);
  const saveB14 = await host14.saveOpenedFile("s-b", new TextEncoder().encode("beta-v2"), () => true);
  check("★ 两份文件各自保存成功", saveA14.ok === true && saveB14.ok === true, { saveA14, saveB14 });
  eq("alpha 落盘", readSync14(a, "utf8"), "alpha-v2");
  eq("beta 落盘", readSync14(b, "utf8"), "beta-v2");

  // ── 14c. 路径归一化：大小写 / `..` / 混合分隔符 / junction 别名 ──
  eq("关闭 s-a", host14.close("s-a"), { ok: true });
  eq("关闭后会话被摘掉", host14.sessionFor("s-a"), null);
  openView("s-a2");
  {
    // Windows：大写盘符/目录 + 反斜杠 + `..` 段；POSIX：多余的 `.` 段。
    const caseVariant =
      process.platform === "win32"
        ? `${ws14.toUpperCase()}\\..\\${basename(ws14)}\\alpha.docx`
        : `${dirname(ws14)}/${basename(ws14)}/./alpha.docx`;
    const reopened = openAndCommit(host14, "s-a2", caseVariant);
    check(`★ 大小写/.. 的另一种写法能打开（${caseVariant}）`, reopened.ok === true, reopened);
    eq(
      "★★ 不同写法命中同一条会话键（归一化后与 physicalPath 一致）",
      host14.sessionFor("s-a2")?.key,
      physicalPath(a),
    );
  }
  // 用原路径再开一次：已被 s-a2 持有 → 拒绝（证明两种写法确实并成了一条）。
  openView("s-a3");
  {
    const again = openAndCommit(host14, "s-a3", a);
    check(
      "★ 归一化后的原路径再开被拒（同一文件的不同写法互相可见）",
      again.ok === false && again.reason.includes("已在另一个视图打开"),
      again,
    );
  }
  // junction / symlink 别名：`physicalPath` 跟真实目的地。创建失败时显式跳过。
  {
    const aliasDir = joinPath14(ws14, "alias-dir");
    let aliasReady = false;
    try {
      symlinkSync(ws14, aliasDir, process.platform === "win32" ? "junction" : "dir");
      aliasReady = true;
    } catch (err) {
      console.log(`  skip 别名断言（无法创建 junction/symlink）：${(err as Error).message}`);
    }
    if (aliasReady) {
      openView("s-a4");
      const res = openAndCommit(host14, "s-a4", joinPath14(aliasDir, "alpha.docx"));
      check(
        "★ 经 junction/symlink 的别名打开同一文件被拒（物理路径归一）",
        res.ok === false && res.reason.includes("已在另一个视图打开"),
        res,
      );
    }
  }

  // ── 14d. 关闭后同一路径可重新打开且 revision 是新的 ──
  eq("关闭 s-a2", host14.close("s-a2"), { ok: true });
  writeFileSync(a, "alpha-v3", "utf8");
  openView("s-a5");
  eq("关闭后同一路径可重新打开", openAndCommit(host14, "s-a5", a), { ok: true });
  eq(
    "★★ 重开后的会话 revision 是当下盘上的版本（不是关闭前记的那个）",
    await host14.sessionFor("s-a5")!.revision,
    sha14("alpha-v3"),
  );
  // 保存走的是会话表里的权威 revision：重开后的保存不应被关闭前的旧版本误判为冲突。
  check(
    "★ 重开后的保存成功（权威 revision 是重开时算的）",
    (await host14.saveOpenedFile("s-a5", new TextEncoder().encode("alpha-v4"), () => true)).ok === true,
  );
  eq("alpha-v4 落盘", readSync14(a, "utf8"), "alpha-v4");

  // ── 14e. 发送失败必须回滚登记（否则路径被一个没打开文档的视图占住） ──
  openView("s-a6");
  {
    // 【ARC-007 P0】准备阶段做只读预检：路径已被别的视图持有时**连通知都不发**，
    // 更不会登记。回执阶段的持有者校验在 `claimOpenedPath` 里仍然保留（双保险）。
    const prepared = host14.openPath("s-a6", b, () => true);
    check("★ 准备阶段对已被持有的路径直接拒绝（不发通知、不占会话）",
      prepared.ok === false && prepared.reason.includes("已在另一个视图打开"), prepared);
    eq("被拒后 s-a6 不持有任何会话", host14.sessionFor("s-a6"), null);
    eq("被拒的路径没有待打开请求", host14.pendingOpenFor("s-a6"), null);
  }

  // ── 14f. 同一 docId 换文件：已被别人持有的路径 → 拒绝且不产生状态 ──
  {
    const swap = openAndCommit(host14, "s-a6", b);
    check(
      "★ 换到一条已被别人持有的路径被拒（持有者不受影响）",
      swap.ok === false && swap.reason.includes("已在另一个视图打开"),
      swap,
    );
    eq("s-a6 仍未持有任何会话（拒绝不产生状态）", host14.sessionFor("s-a6"), null);
    eq("beta 的持有者仍是 s-b", host14.sessionFor("s-b")?.filePath, b);
  }

  // ── 14g. close 之后会话表干净：所有会话都被摘掉，reopen 不再被旧状态阻塞 ──
  for (const id of ["s-b", "s-a3", "s-a4", "s-a5", "s-a6"]) eq(`关闭 ${id}`, host14.close(id), { ok: true });
  eq("关闭全部后 alpha 的会话没了", host14.sessionFor("s-a5"), null);
  eq("关闭全部后 beta 的会话没了", host14.sessionFor("s-b"), null);
  openView("s-c");
  eq("全部关闭后重新打开 alpha 成功", openAndCommit(host14, "s-c", a), { ok: true });
  host14.closeAll();
  eq("closeAll 把会话表也清空", host14.sessionFor("s-c"), null);

  host14.dispose();
  rmSync(ws14, { recursive: true, force: true });
}

/* ══════════════════ 15.【ARC-006 Gate A 缺口】编辑器页凭据注入 ══════════════════
 *
 * 判据（文件头 `documentViewCredentialBroker.ts` 逐条对应）：
 *   - 令牌**不进** URL / 快照 / 状态视图 —— 打开引擎编辑器页后，`list()` 的序列化
 *     结果与 open 的回包里都搜不到令牌；
 *   - 只给「这个 webContents + 这个引擎回环 origin」注入（XHR 与 WebSocket 握手都算），
 *     别的 webContents / 别的端口 / 别的协议一律不注入；
 *   - 端口必须等于引擎此刻的监听端口（渲染端指一个别的本机服务 → 拒绝建视图）；
 *   - 宿主没装注入器时带 `workflowEngineId` 的 open 显式拒绝（fail-closed）；
 *   - close / closeAll 立即摘绑定；空闲超过 TTL → 停止注入（页面下一次 API 调用 401）。
 */
section("15. 引擎编辑器页凭据注入（令牌不出主进程，按 webContents + origin 绑定）");
{
  const TOKEN = "a".repeat(64);
  const ENGINE = "node-red";
  const ENGINE_PORT = 45231;
  const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}/`;

  /** 假 session：捕获监听器，让套件能直接喂请求给它（与真 webRequest 同形状）。 */
  function makeFakeSession(): {
    session: EditorCredentialSessionLike;
    installed: () => boolean;
    dispatch: (details: EditorCredentialRequestDetails) => Record<string, string>;
  } {
    let listener: ((details: EditorCredentialRequestDetails, callback: (r: { requestHeaders: Record<string, string> }) => void) => void) | null = null;
    return {
      session: {
        webRequest: {
          onBeforeSendHeaders(_filter, fn) {
            listener = fn;
          },
        },
      },
      installed: () => listener !== null,
      dispatch: (details) => {
        let headers: Record<string, string> = {};
        listener!(details, (r) => {
          headers = r.requestHeaders;
        });
        return headers;
      },
    };
  }

  let clock = 1_000_000;
  const portsFor = (
    over: { runningPort?: number | null; token?: string | null } = {},
  ): ConstructorParameters<typeof DocumentViewCredentialBroker>[0] => ({
    readToken: () => (over.token === undefined ? TOKEN : over.token),
    runningPort: () => (over.runningPort === undefined ? ENGINE_PORT : over.runningPort),
    getSession: () => fake.session,
    now: () => clock,
  });
  const fake = makeFakeSession();

  created.length = 0;
  const win = makeFakeWindow();
  const broker = new DocumentViewCredentialBroker(portsFor(), { ttlMs: EDITOR_CREDENTIAL_TTL_MS });
  const host = new DocumentViewHost({
    getMainWindow: () => win,
    createView: makeFakeView,
    editorCredentials: broker,
  });

  // ── 15a. 正常路径：建视图 + 绑定；list 快照与 open 回包都不含令牌 ──
  {
    const before = created.length;
    const opened = host.open({ docId: "eng-1", url: ENGINE_URL, bounds: BOUNDS, visible: true, workflowEngineId: ENGINE });
    eq("引擎编辑器视图打开成功", opened, { ok: true });
    const view = created[before]!;
    check("★ 引擎视图的导航地址里没有令牌（access_token / Bearer 都不出现）",
      view.loads.length > 0 && view.loads.every((u) => !u.includes(TOKEN) && !/access_token|authorization|token=/i.test(u)), view.loads);
    const listed = JSON.stringify(host.list());
    check("★ list() 的序列化结果里没有令牌", !listed.includes(TOKEN), listed.slice(0, 400));
    check("★ open 的回包里没有令牌", !JSON.stringify(opened).includes(TOKEN), opened);
    check("★ 引擎视图在 use 快照里仍只报原本的编辑器地址", listed.includes(ENGINE_URL), listed.slice(0, 400));
    eq("绑定只挂着一条（docId 维度）", broker.debugState().map((b) => b.docId), ["eng-1"]);
    eq("debugState 只报 hasToken，不报令牌本体", JSON.stringify(broker.debugState()).includes(TOKEN), false);

    const headers = fake.dispatch({
      url: `${ENGINE_URL}flows`,
      resourceType: "xhr",
      webContentsId: view.webContentsId,
      requestHeaders: { Accept: "application/json" },
    });
    eq("★ 这个视图打引擎 /flows：注入了宿主 Bearer", headers.Authorization, `Bearer ${TOKEN}`);
    eq("原有请求头保留", headers.Accept, "application/json");

    const ws = fake.dispatch({
      url: `ws://127.0.0.1:${ENGINE_PORT}/comms`,
      resourceType: "webSocket",
      webContentsId: view.webContentsId,
      requestHeaders: {},
    });
    eq("★ WebSocket 握手（ws:// 归一为 http 源）同样注入", ws.Authorization, `Bearer ${TOKEN}`);
  }

  // ── 15b. 收窄：别的 webContents / 别的端口 / 非 http(s) 一律不注入 ──
  {
    const viewId = created[created.length - 1]!.webContentsId;
    const otherView = fake.dispatch({
      url: `${ENGINE_URL}flows`, resourceType: "xhr", webContentsId: viewId + 1, requestHeaders: {},
    });
    eq("★ 同一个 session 里别的 webContents 不注入", otherView.Authorization, undefined);
    const otherPort = fake.dispatch({
      url: "http://127.0.0.1:49999/flows", resourceType: "xhr", webContentsId: viewId, requestHeaders: {},
    });
    eq("★ 同视图但换端口（别的本机服务）不注入", otherPort.Authorization, undefined);
    const remote = fake.dispatch({
      url: "https://example.com/flows", resourceType: "xhr", webContentsId: viewId, requestHeaders: {},
    });
    eq("★ 同视图打到远程地址不注入", remote.Authorization, undefined);
    const pageOwnAuth = fake.dispatch({
      url: `${ENGINE_URL}flows`, resourceType: "xhr", webContentsId: viewId, requestHeaders: { Authorization: "Bearer page-supplied" },
    });
    eq("★ 页面自带的 Authorization 被宿主身份替换（不能被页面协商）", pageOwnAuth.Authorization, `Bearer ${TOKEN}`);
  }

  // ── 15c. 端口不一致 → 连视图都不建（先拒后建） ──
  {
    const wrongPortBroker = new DocumentViewCredentialBroker(portsFor({ runningPort: 1 }));
    const wrongPortHost = new DocumentViewHost({
      getMainWindow: () => win,
      createView: makeFakeView,
      editorCredentials: wrongPortBroker,
    });
    const before = created.length;
    const rejected = wrongPortHost.open({
      docId: "eng-wrong-port", url: ENGINE_URL, bounds: BOUNDS, visible: true, workflowEngineId: ENGINE,
    });
    check("★ 渲染端指一个别的本机端口 → 拒绝注入", rejected.ok === false && rejected.reason.includes("端口"), rejected);
    eq("★ 拒绝路径上一个视图都没建", created.length, before);
    // 引擎没在跑（runningPort=null）同样拒绝。
    const stoppedBroker = new DocumentViewCredentialBroker(portsFor({ runningPort: null }));
    const stoppedHost = new DocumentViewHost({
      getMainWindow: () => win, createView: makeFakeView, editorCredentials: stoppedBroker,
    });
    const stopped = stoppedHost.open({ docId: "eng-stopped", url: ENGINE_URL, bounds: BOUNDS, visible: true, workflowEngineId: ENGINE });
    check("★ 引擎不在运行 → 拒绝（不猜端口）", stopped.ok === false && stopped.reason.includes("不在运行"), stopped);
    wrongPortHost.dispose();
    stoppedHost.dispose();
  }

  // ── 15d. 宿主没装注入器：带 workflowEngineId 的 open 显式拒绝（fail-closed） ──
  {
    const bare = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
    const before = created.length;
    const res = bare.open({ docId: "eng-bare", url: ENGINE_URL, bounds: BOUNDS, visible: true, workflowEngineId: ENGINE });
    check("★ 没有注入器时引擎视图被显式拒绝（不说谎地给一个 401 页面）",
      res.ok === false && res.reason.includes("凭据注入"), res);
    eq("拒绝路径上不建视图", created.length, before);
    // 普通文档视图不受影响。
    const doc = bare.open({ docId: "doc-bare", url: FILE_URL, bounds: BOUNDS, visible: true });
    eq("普通文档视图照常打开（不受引擎凭据影响）", doc, { ok: true });
    bare.dispose();
  }

  // ── 15e. 空闲租约：过期后停止注入（页面下一次 API 调用 401，如实） ──
  {
    clock += EDITOR_CREDENTIAL_TTL_MS + 1; // 越过空闲租约
    const viewId = created.find((c) => c.loads.includes(ENGINE_URL))!.webContentsId;
    const expired = fake.dispatch({ url: `${ENGINE_URL}flows`, resourceType: "xhr", webContentsId: viewId, requestHeaders: {} });
    eq("★ 空闲超过 TTL → 不再注入（页面会如实 401，不是静默降级）", expired.Authorization, undefined);
    eq("★ 过期后绑定被摘掉（状态不撒谎）", broker.debugState().map((b) => b.docId), []);
    // 重新 open = 新的使用意图 → 绑定恢复。
    const reopened = host.open({ docId: "eng-1", url: ENGINE_URL, bounds: BOUNDS, visible: true, workflowEngineId: ENGINE });
    eq("重新 open 成功", reopened, { ok: true });
    const fresh = fake.dispatch({ url: `${ENGINE_URL}settings`, resourceType: "xhr", webContentsId: viewId, requestHeaders: {} });
    eq("★ 重新 open 后凭据重新可用", fresh.Authorization, `Bearer ${TOKEN}`);
  }

  // ── 15f. close / closeAll 立即摘绑定 ──
  {
    const viewId = created.find((c) => c.loads.includes(ENGINE_URL))!.webContentsId;
    eq("close 前绑定在", broker.debugState().map((b) => b.docId), ["eng-1"]);
    host.close("eng-1");
    eq("★ close 之后绑定立刻摘掉", broker.debugState(), []);
    const after = fake.dispatch({ url: `${ENGINE_URL}flows`, resourceType: "xhr", webContentsId: viewId, requestHeaders: {} });
    eq("★ close 后即使 webContents id 还被喂进来也不注入", after.Authorization, undefined);

    // closeAll 路径：重开一个引擎视图，再走窗口级清理。
    const opened = host.open({ docId: "eng-2", url: ENGINE_URL, bounds: BOUNDS, visible: true, workflowEngineId: ENGINE });
    eq("重开成功", opened, { ok: true });
    eq("绑定又建了一条", broker.debugState().map((b) => b.docId), ["eng-2"]);
    host.closeAll();
    eq("★ closeAll 之后所有绑定摘掉", broker.debugState(), []);
  }

  // ── 15g. 端口判据的纯函数级收窄：file:// / 无显式端口 / 伪装回环一律拒绝 ──
  {
    const probe = new DocumentViewCredentialBroker(portsFor());
    eq("file:// 编辑器页拒绝注入", probe.prepare({ engineId: ENGINE, url: "file:///C:/editor/index.html" }).ok, false);
    eq("没有显式端口的回环地址拒绝（无法与端口核对）", probe.prepare({ engineId: ENGINE, url: "http://127.0.0.1/" }).ok, false);
    eq("伪装回环后缀拒绝", probe.prepare({ engineId: ENGINE, url: `http://localhost.evil.com:${ENGINE_PORT}/` }).ok, false);
    eq("端口对上的回环地址通过", probe.prepare({ engineId: ENGINE, url: ENGINE_URL }).ok, true);
  }

  // ── 15h. Agent 不可调：没有新 RPC 通道，且 documentView.open 本身是 blocked ──
  // 方案 B（宿主注入头）**刻意不新开** `workflowEngine.editorSession` 之类返回令牌的
  // RPC —— 令牌连渲染端都到不了，Agent 就没有"调用它"的入口。这条断言把"刻意没开"
  // 变成可检验的事实：多一条 editorSession/credential 通道就会红。
  {
    const { policyFor } = await import("@main/appControl/policy.js");
    const rpc = new Set(registeredRpcChannels());
    const tokenish = [...rpc].filter((c) => /editorSession|credential|secret|token/i.test(c));
    eq("★ 没有任何返回编辑器凭据的 RPC 通道（Agent 无入口可调）", tokenish, []);
    eq("★ documentView.open 对 Agent 是 blocked（注入能力藏在它后面）",
      policyFor("documentView.open").level, "blocked");
    // 宿主接口本身也不在 RPC 表里：注入器只由宿主构造，没有 IPC 通道暴露它。
    eq("凭据注入器没有出现在 RPC 表", [...rpc].filter((c) => c.includes("CredentialBroker")), []);
  }

  /* ══════════ 16.【ARC-007】slides 编辑桥（A 方案第一步） ══════════
   *
   * 两个内部通道（`mcode:document-view:slides-add-slide` / `slides-edit-text`）
   * 转发到注入的 `SlidesBridge`；未装配时 fail-closed。身份由 `event.sender`
   * 反查，页面声明的 docId 与反查不一致即拒。
   */
  {
    const { SlidesBridge, SLIDES_BRIDGE_UNAVAILABLE } = await import("@main/document/slidesBridge.js");
    const stubs: Array<{ calls: unknown[][] }> = [];
    const makeExecutor = (): {
      addBlankSlide(webContentsId: number, docId: string): Promise<{ slideCount: number; slides: unknown[]; index: number }>;
      openDeck(webContentsId: number, docId: string, filePath: string, fitWidthPx: number): Promise<{ openResult: unknown }>;
      editText(webContentsId: number, docId: string, slideIndex: number, elementId: string, text: string): Promise<{ text: string; renderedSlide: Record<string, unknown> }>;
      saveDeck(webContentsId: number, docId: string, filePath: string): Promise<{ bytes: number }>;
    } => ({
      async addBlankSlide(webContentsId, docId) {
        stubs.push({ calls: [["addBlankSlide", webContentsId, docId]] });
        return { slideCount: 2, index: 1, slides: [{ nodes: [] }, { nodes: [{ sourceId: "fake-text" }] }] };
      },
      async openDeck(webContentsId, docId, filePath, fitWidthPx) {
        stubs.push({ calls: [["openDeck", webContentsId, docId, filePath, fitWidthPx]] });
        return { openResult: { path: filePath, slides: [], size: { width: fitWidthPx, height: 720 } } };
      },
      async editText(webContentsId, docId, slideIndex, elementId, text) {
        stubs.push({ calls: [["editText", webContentsId, docId, slideIndex, elementId, text]] });
        return { text, renderedSlide: { nodes: [{ sourceId: elementId, text: { lines: [{ runs: [{ text }] }] } }] } };
      },
      async saveDeck(webContentsId, docId, filePath) {
        stubs.push({ calls: [["saveDeck", webContentsId, docId, filePath]] });
        return { bytes: 1024 };
      },
    });

    // 16a. 无执行器 → fail-closed，原因点名。
    {
      const bareBridge = new SlidesBridge(null);
      const noWin = makeFakeWindow();
      const noHost = new DocumentViewHost({ getMainWindow: () => noWin, createView: makeFakeView });
      const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
      const fakeIpc16 = {
        handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
          handlers.set(channel, listener);
        },
      } as unknown as IpcMain;
      registerDocumentViewHandlers(fakeIpc16, noHost, () => true, bareBridge, () => true);
      // 身份要先过：用真视图 + 真 sender，才落到"桥未装配"这一层。
      noHost.open({ docId: "bare-1", url: FILE_URL, bounds: BOUNDS, visible: true });
      const bareSender = (noHost as unknown as { views: Map<string, { view: { webContents: unknown } }> })
        .views.get("bare-1")!.view.webContents;
      const r = (await handlers.get("mcode:document-view:slides-add-slide")!(
        { sender: bareSender },
        { docId: "bare-1" },
      )) as { ok?: boolean; reason?: string };
      check(
        "★ 无 vendor 执行器：slidesAddSlide 返回 ok:false 且原因点名「vendor 主进程未装配」",
        r.ok === false && r.reason === SLIDES_BRIDGE_UNAVAILABLE,
        r,
      );
      const r2 = (await handlers.get("mcode:document-view:slides-edit-text")!(
        { sender: bareSender },
        { docId: "bare-1", slideIndex: 0, elementId: "e1", text: "x" },
      )) as { ok?: boolean; reason?: string };
      check(
        "★ 无 vendor 执行器：slidesEditText 同样 fail-closed",
        r2.ok === false && r2.reason === SLIDES_BRIDGE_UNAVAILABLE,
        r2,
      );
      noHost.dispose();
    }

    // 16b. 有执行器：参数原样转发、docId 身份由 sender 决定、页面伪造 docId 无效。
    {
      const exec = makeExecutor();
      const bridge = new SlidesBridge(exec);
      const win16 = makeFakeWindow();
      const host16 = new DocumentViewHost({ getMainWindow: () => win16, createView: makeFakeView });
      const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
      const fakeIpc16 = {
        handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
          if (handlers.has(channel)) throw new Error(`duplicate ${channel}`);
          handlers.set(channel, listener);
        },
      } as unknown as IpcMain;
      registerDocumentViewHandlers(fakeIpc16, host16, () => true, bridge, () => true);
      // 真视图 + 真 sender（与生产同一条身份反查路径）。
      host16.open({ docId: "slides-1", url: FILE_URL, bounds: BOUNDS, visible: true });
      const live = (host16 as unknown as { views: Map<string, { view: { webContents: unknown } }> })
        .views.get("slides-1")!;
      const sender = live.view.webContents;
      const wcId = (sender as { id: number }).id;

      const add = (await handlers.get("mcode:document-view:slides-add-slide")!(
        { sender },
        { docId: "slides-1" },
      )) as { ok?: boolean; slideCount?: number };
      check("★ 有执行器：加页返回 ok:true 且页数来自执行器", add.ok === true && add.slideCount === 2, add);
      check("★ Mcode preload 的 addBlankSlide 必须返回 vendor 要的 slides[] 与 index",
        Array.isArray((add as { slides?: unknown[] }).slides) && (add as { index?: number }).index === 1, add);
      eq(
        "★ 参数原样转发：执行器收到 webContentsId 与宿主反查的 docId",
        stubs.at(-1)?.calls,
        [["addBlankSlide", wcId, "slides-1"]],
      );

      const edit = (await handlers.get("mcode:document-view:slides-edit-text")!(
        { sender },
        { docId: "slides-1", slideIndex: 3, elementId: "el-9", text: "hello" },
      )) as { ok?: boolean; text?: string };
      check("★ 有执行器：改文字返回 ok:true 且回显文本", edit.ok === true && edit.text === "hello", edit);
      check("★ Mcode preload 的 editText 必须返回渲染树 nodes 供 vendor 更新画布",
        Array.isArray((edit as { nodes?: unknown[] }).nodes), edit);
      eq(
        "★ 改文字参数原样转发（slideIndex/elementId/text）",
        stubs.at(-1)?.calls,
        [["editText", wcId, "slides-1", 3, "el-9", "hello"]],
      );

      // 【ARC-007】真实生产 preload 的 ABI：addBlankSlide 发 {}，editText 只发
      // slideIndex/elementId/text，不带 docId。不能让两份携带 docId 的假调用
      // 通过就误认为用户可以真编辑；真实身份从 event.sender 的受信视图反查。
      const preloadAdd = (await handlers.get("mcode:document-view:slides-add-slide")!(
        { sender },
        {},
      )) as { ok?: boolean; slideCount?: number };
      check("★ 真 preload 加页入参 {} 不会被强制 docId schema 拒掉", preloadAdd.ok === true && preloadAdd.slideCount === 2, preloadAdd);
      eq("★ 无 docId 请求的执行对象仍来自可信 sender", stubs.at(-1)?.calls,
        [["addBlankSlide", wcId, "slides-1"]]);
      const preloadEdit = (await handlers.get("mcode:document-view:slides-edit-text")!(
        { sender },
        { slideIndex: 4, elementId: "el-preload", text: "preload payload" },
      )) as { ok?: boolean; text?: string };
      check("★ 真 preload 改文字入参无 docId 也能透传", preloadEdit.ok === true && preloadEdit.text === "preload payload", preloadEdit);
      eq("★ 无 docId 编辑仍绑定可信 sender 而非页面身份", stubs.at(-1)?.calls,
        [["editText", wcId, "slides-1", 4, "el-preload", "preload payload"]]);

      // 页面伪造 docId：sender 反查是 slides-1，页面声明 slides-2 → 拒，执行器不被调用。
      const before = stubs.length;
      const forged = (await handlers.get("mcode:document-view:slides-add-slide")!(
        { sender },
        { docId: "slides-2" },
      )) as { ok?: boolean; reason?: string };
      check(
        "★ 页面伪造 docId 无效：声明与 sender 不一致即拒，且执行器未被调用",
        forged.ok === false && typeof forged.reason === "string" && stubs.length === before,
        { forged, callsBefore: before, callsAfter: stubs.length },
      );
      // 陌生 sender：同样拒绝（身份不是页面给的）。
      const stranger = (await handlers.get("mcode:document-view:slides-add-slide")!(
        { sender: {} },
        { docId: "slides-1" },
      )) as { ok?: boolean; reason?: string };
      check("★ 陌生 sender 的编辑请求被拒", stranger.ok === false, stranger);
      const beforeStranger = stubs.length;
      const missingIdentity = (await handlers.get("mcode:document-view:slides-add-slide")!(
        { sender: {} }, {},
      )) as { ok?: boolean; reason?: string };
      check("★ 即使不声明 docId，陌生 sender 仍不得编辑", missingIdentity.ok === false && stubs.length === beforeStranger,
        { missingIdentity, beforeStranger, after: stubs.length });
      const forgedEdit = (await handlers.get("mcode:document-view:slides-edit-text")!(
        { sender }, { docId: "another-view", slideIndex: 0, elementId: "el-9", text: "wrong view" },
      )) as { ok?: boolean; reason?: string };
      check("★ 旧调用方改文字若伪造 docId 必拒绝", forgedEdit.ok === false && stubs.length === beforeStranger,
        { forgedEdit, beforeStranger, after: stubs.length });
      host16.dispose();
    }
  }

  host.dispose();
}

/* ══════════ 17.【ARC-007 P0】打开链：一次性字节响应 + 回执后置 + 替换守卫 ══════════
 *
 * 判据（对应台账 P0）：
 *  - `openPath` 只准备，`readOpened` 返回 vendor `OpenDocxResult` 形状
 *    （path/name/dataUrl/hash），dataUrl 一次性（取两次第二次必失败）；
 *  - sha256 与盘上字节一致；坏档/空档/跨路径在 issue 之前被拒；
 *  - 打开失败/未回执不占会话；回执后才提交（成功标记后置）；
 *  - `confirmDocumentReplace` 的真实来源是页面上报的 dirty；脏且无确认端口
 *    → fail-closed；脏且有端口 → 用端口结果；
 *  - 同一路径另一 docId 在准备阶段允许（不占），提交阶段拒绝。
 */
{
  const { mkdtempSync, writeFileSync, readFileSync: read17, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: join17 } = await import("node:path");
  const { createHash: hash17 } = await import("node:crypto");
  const ws = mkdtempSync(join17(tmpdir(), "mcode-dv-p0-"));
  const good = join17(ws, "good.docx");
  // 合法 docx 的开头（PK 魔数 + 任意 zip 载荷；本段只验宿主侧协议，不做页面解析）。
  const goodBytes = Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.alloc(256, 7)]);
  writeFileSync(good, goodBytes);
  const bad = join17(ws, "bad.docx");
  writeFileSync(bad, "not-a-zip", "utf8");
  const empty = join17(ws, "empty.docx");
  writeFileSync(empty, "", "utf8");
  const outside = join17(tmpdir(), `mcode-dv-p0-outside-${Date.now()}.docx`);
  writeFileSync(outside, "outside", "utf8");

  const win = makeFakeWindow();
  const host = new DocumentViewHost({ getMainWindow: () => win, createView: makeFakeView });
  host.open({ docId: "p0-1", url: FILE_URL, bounds: BOUNDS, visible: true });
  const within = (p: string): boolean => p.startsWith(ws) || p.startsWith(ws.replace(/\\/g, "/"));

  // 17a. 无待打开 → readOpened 显式拒绝。
  {
    const r = await host.readOpened("p0-1", within);
    check("★ 没有待打开请求时 readOpened 拒绝（fail-closed）", r.ok === false, r);
  }

  // 17b. 正常路径：准备 → 拉取 → 形状/哈希/一次性 → 回执前不占会话 → 回执后提交。
  {
    eq("openPath 准备成功", host.openPath("p0-1", good, within), { ok: true });
    const read = await host.readOpened("p0-1", within);
    const result = read.ok ? (read as { result?: { path?: unknown; name?: unknown; dataUrl?: unknown; hash?: unknown } }).result : undefined;
    check(
      "★ readOpened 返回 vendor OpenDocxResult 形状",
      result !== undefined &&
        typeof result.path === "string" &&
        typeof result.name === "string" &&
        typeof result.dataUrl === "string" &&
        typeof result.hash === "string",
      read,
    );
    if (result !== undefined) {
      eq("dataUrl 是 vendor CSP 放行的 handoff scheme", String(result.dataUrl).startsWith("genoffice-docx-media://handoff/"), true);
      eq("sha256 与盘上字节一致", result.hash, hash17("sha256").update(read17(good)).digest("hex"));
      eq("name 是 basename", result.name, "good.docx");
      // 一次性：同一 URL 第二次取必须 404（take 即焚）。
      const { takeDocumentHandoff } = await import("@main/document/documentViewHandoff.js");
      const first = takeDocumentHandoff(String(result.dataUrl));
      const second = takeDocumentHandoff(String(result.dataUrl));
      check("★ 一次性字节响应：第一次可取到、第二次为 null", first !== null && second === null, { first: first?.length ?? null, second: second?.length ?? null });
      eq("取到的字节与盘上一致", first === null ? "" : hash17("sha256").update(first).digest("hex"), result.hash);
    }
    eq("★ 回执前不占会话（成功标记后置）", host.sessionFor("p0-1"), null);
    eq("回执提交成功", host.settlePendingOpen("p0-1", true, within), { ok: true });
    eq("★ 回执后才登记会话", host.sessionFor("p0-1")?.filePath, good);
    eq("待打开请求已清空", host.pendingOpenFor("p0-1"), null);
  }

  // 17c. 坏档/空档/跨路径：issue 之前被拒，且不占会话。
  {
    host.close("p0-1");
    host.open({ docId: "p0-1", url: FILE_URL, bounds: BOUNDS, visible: true });
    host.openPath("p0-1", bad, within);
    const r = await host.readOpened("p0-1", within);
    check("★ 坏档（非 zip）在 issue 之前被拒", r.ok === false && r.reason.includes("不是可读的 docx"), r);
    host.openPath("p0-1", empty, within);
    const r2 = await host.readOpened("p0-1", within);
    check("★ 空档被拒", r2.ok === false, r2);
    host.openPath("p0-1", outside, () => true);
    const r3 = await host.readOpened("p0-1", within);
    check("★ 跨路径（读时围栏变化）被拒", r3.ok === false && r3.reason.includes("不在已知工作区内"), r3);
    eq("★ 失败路径都不占会话", host.sessionFor("p0-1"), null);
    host.settlePendingOpen("p0-1", false, within);
    eq("放弃回执清掉待打开请求", host.pendingOpenFor("p0-1"), null);
  }

  // 17d. 过期版本：准备后文件被改写 → readOpened 返回的 hash 是**当下**盘上的版本
  //      （宿主不做陈旧缓存）；若打开方基于旧版本保存，saveOpenedFile 的乐观锁会拦。
  {
    host.close("p0-1");
    host.open({ docId: "p0-1", url: FILE_URL, bounds: BOUNDS, visible: true });
    host.openPath("p0-1", good, within);
    const before = await host.readOpened("p0-1", within);
    const modified = Buffer.concat([goodBytes, Buffer.from("tampered")]);
    writeFileSync(good, modified);
    host.openPath("p0-1", good, within);
    const after = await host.readOpened("p0-1", within);
    const beforeHash = before.ok ? (before as { result?: { hash?: unknown } }).result?.hash : undefined;
    const afterHash = after.ok ? (after as { result?: { hash?: unknown } }).result?.hash : undefined;
    check(
      "★ 文件在两次打开之间被改写：hash 跟着变（无陈旧缓存）",
      typeof beforeHash === "string" && typeof afterHash === "string" && beforeHash !== afterHash,
      { before: beforeHash ?? null, after: afterHash ?? null },
    );
    eq("提交后记下的 revision 是改写后的版本", host.settlePendingOpen("p0-1", true, within), { ok: true });
    const stale = await host.saveOpenedFile("p0-1", new TextEncoder().encode("x"), within, typeof beforeHash === "string" ? beforeHash : null);
    check("★ 用旧 hash 保存被乐观锁拒绝（conflict）", stale.ok === false && stale.reason === "conflict", stale);
    writeFileSync(good, goodBytes);
  }

  // 17d2. Async readFile must not complete an old request after the
  // native view switched documents, was closed, or lost workspace access.
  // Otherwise the page can receive A's handoff bytes while settlePendingOpen
  // commits B's docId/file revision (a cross-file CAS/data-integrity break).
  {
    const other = join17(ws, "good-other.docx");
    const third = join17(ws, "good-third.docx");
    writeFileSync(other, Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.alloc(96, 3)]));
    writeFileSync(third, Buffer.concat([Buffer.from("PK\u0003\u0004", "latin1"), Buffer.alloc(96, 9)]));
    eq("race view created", host.open({docId:"p0-race",url:FILE_URL,bounds:BOUNDS,visible:false}), {ok:true});
    eq("prepare A", host.openPath("p0-race",third,within), {ok:true});
    const staleRead = host.readOpened("p0-race",within);
    eq("switch to B while A is still being read", host.openPath("p0-race",other,within), {ok:true});
    const staleResult = await staleRead;
    check("★ late readOpened A cannot return bytes under new pending B",
      !staleResult.ok, staleResult);
    const latest = await host.readOpened("p0-race",within);
    check("latest B can still be opened and returned",
      latest.ok && latest.result.path === other, latest);
    if (latest.ok) {
      const {takeDocumentHandoff} = await import("@main/document/documentViewHandoff.js");
      takeDocumentHandoff(latest.result.dataUrl);
    }
    eq("prepare A for close race", host.openPath("p0-race",third,within), {ok:true});
    const closedRead = host.readOpened("p0-race",within);
    eq("close view during read",host.close("p0-race"),{ok:true});
    const afterClose = await closedRead;
    check("★ close during async read does not create an orphan handoff",
      !afterClose.ok, afterClose);

    eq("reopen for permission race",host.open({docId:"p0-race",url:FILE_URL,bounds:BOUNDS,visible:false}),{ok:true});
    eq("prepare A before workspace revocation",host.openPath("p0-race",third,within),{ok:true});
    let stillAllowed = true;
    const dynamicPermission = (): boolean => stillAllowed;
    const revokedRead = host.readOpened("p0-race",dynamicPermission);
    stillAllowed = false;
    const afterRevocation = await revokedRead;
    check("★ workspace removal while bytes are being read must reject handoff",
      !afterRevocation.ok, afterRevocation);
    host.close("p0-race");
  }

  // 17e. confirmDocumentReplace：真实 dirty 来源 + fail-closed + 端口驱动。
  {
    eq("不脏 → 允许替换", await host.confirmDocumentReplace("p0-1"), true);
    host.reportPageDirty("p0-1", true);
    eq("★ 脏且没有确认端口 → fail-closed（拒绝替换）", await host.confirmDocumentReplace("p0-1"), false);
    const calls: Array<{ docId: string; filePath: string | null }> = [];
    host.setConfirmDirty(async (input) => {
      calls.push(input);
      return false;
    });
    eq("★ 脏且确认端口回绝 → 拒绝替换", await host.confirmDocumentReplace("p0-1"), false);
    eq("确认端口收到了 docId 与当前文件路径", calls.at(-1)?.docId, "p0-1");
    host.setConfirmDirty(async () => true);
    eq("★ 脏且真人同意 → 允许替换", await host.confirmDocumentReplace("p0-1"), true);
    host.reportPageDirty("p0-1", false);
    eq("恢复不脏后直接允许", await host.confirmDocumentReplace("p0-1"), true);
  }

  host.closeAll();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { force: true });
}

/* ========== 18. 【ARC-007 P1/GA1】slides 打开/保存链（宿主侧状态机） ==========
 *
 * 判据（对应台账 P1/GA1 的 slides 半边）：
 *  - 只有 `editor:"slides"` 的视图才接 slides 打开链（docs 视图不受影响）；
 *  - 准备阶段的围栏/持锁预检/路径空判与 docs 的 openPath 同一条；
 *  - 页面回执后才提交会话；回执里的 `OpenResult.path` 与待打开不一致即拒；
 *  - `slidesSaveTarget` 只认自己的打开会话，且每次保存重新过围栏；
 *  - `recordSlidesSave` 推进会话 revision（后续乐观锁以新版本为基准）。
 */
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ws18 = mkdtempSync(join(tmpdir(), "mcode-dv-slides-"));
  const deck = join(ws18, "talk.pptx");
  writeFileSync(deck, Buffer.from("PK\u0003\u0004fake-pptx", "latin1"));
  const outside18 = join(tmpdir(), `mcode-dv-slides-outside-${Date.now()}.pptx`);
  writeFileSync(outside18, "outside", "utf8");
  const within18 = (p: string): boolean =>
    p.replace(/\\/g, "/").toLowerCase().startsWith(ws18.replace(/\\/g, "/").toLowerCase());

  const win18 = makeFakeWindow();
  const host18 = new DocumentViewHost({ getMainWindow: () => win18, createView: makeFakeView });
  host18.open({ docId: "slides-18", url: FILE_URL, bounds: BOUNDS, visible: true, editor: "slides" });
  host18.open({ docId: "docs-18", url: FILE_URL, bounds: BOUNDS, visible: true });

  eq("editorOf 报告 slides 域", host18.editorOf("slides-18"), "slides");
  eq("docs 视图的 editorOf 为 null（未声明）", host18.editorOf("docs-18"), null);

  // 18a. docs 视图不得走 slides 打开链。
  {
    const r = host18.prepareSlidesOpen("docs-18", deck, within18);
    check(
      "★ docs 视图 prepareSlidesOpen 被拒（编辑器域不匹配）",
      r.ok === false && r.reason.includes("不是演示文稿编辑器"),
      r,
    );
  }

  // 18b. 围栏/空路径/持锁预检与 docs 同一条。
  {
    check(
      "★ 工作区外路径在准备阶段被拒",
      host18.prepareSlidesOpen("slides-18", outside18, within18).ok === false,
    );
    check(
      "空路径被拒",
      host18.prepareSlidesOpen("slides-18", "   ", within18).ok === false,
    );
    const prepared = host18.prepareSlidesOpen("slides-18", deck, within18);
    eq("围栏内路径准备成功", prepared.ok, true);
    eq("★ 准备阶段不占会话（成功标记后置）", host18.sessionFor("slides-18"), null);
    eq("待打开请求已登记", host18.pendingOpenFor("slides-18")?.filePath, deck);
  }

  // 18c. 回执路径与待打开不一致 → 拒（不把 A 文件的会话算到 B 头上）。
  {
    const wrong = host18.settleSlidesOpen("slides-18", { path: join(ws18, "other.pptx") }, true, within18);
    check(
      "★ 回执里的 OpenResult.path 与待打开不一致即拒",
      wrong.ok === false && wrong.reason.includes("不一致"),
      wrong,
    );
    eq("拒后不占会话", host18.sessionFor("slides-18"), null);
    eq("拒后待打开请求已清空", host18.pendingOpenFor("slides-18"), null);
  }

  // 18d. 正确回执：提交会话；保存目标只认自己的会话。
  {
    host18.prepareSlidesOpen("slides-18", deck, within18);
    const committed = host18.settleSlidesOpen("slides-18", { path: deck, slides: [] }, true, within18);
    eq("★ 回执后提交会话", committed, { ok: true });
    eq("会话路径是待打开路径", host18.sessionFor("slides-18")?.filePath, deck);
    eq("待打开请求清空", host18.pendingOpenFor("slides-18"), null);
    eq("slidesSaveTarget 返回会话路径", host18.slidesSaveTarget("slides-18", within18), { ok: true, filePath: deck });
    check(
      "★ 工作区已移除时保存目标被拒（每次保存重新过围栏）",
      host18.slidesSaveTarget("slides-18", () => false).ok === false,
    );
    check(
      "★ docs 视图没有 slides 保存目标",
      host18.slidesSaveTarget("docs-18", within18).ok === false,
    );
  }

  // 18e. 保存成功后推进 revision（后续乐观锁以新版本为基准）。
  {
    const before = host18.sessionFor("slides-18")?.revision;
    const beforeRev = before ? await before : null;
    writeFileSync(deck, Buffer.from("PK\u0003\u0004fake-pptx-v2", "latin1"));
    const recorded = await host18.recordSlidesSave("slides-18", within18);
    check("★ recordSlidesSave 成功并报告字节数", recorded.ok === true && recorded.bytes > 0, recorded);
    const afterRev = host18.sessionFor("slides-18")?.revision;
    const afterRevValue = afterRev ? await afterRev : null;
    check(
      "★ 保存后会话 revision 推进到盘上新版本",
      recorded.ok === true && recorded.revision === afterRevValue && afterRevValue !== beforeRev,
      { beforeRev, afterRevValue, recorded },
    );
  }

  // 18f. 失败回执只丢弃待打开、不改变既有会话。
  {
    host18.prepareSlidesOpen("slides-18", deck, within18);
    const rejected = host18.settleSlidesOpen("slides-18", null, false, within18);
    eq("回绝回执成功（只丢弃）", rejected, { ok: true });
    eq("★ 回绝不改变既有会话", host18.sessionFor("slides-18")?.filePath, deck);
    eq("回绝后待打开清空", host18.pendingOpenFor("slides-18"), null);
  }

  host18.closeAll();
  rmSync(ws18, { recursive: true, force: true });
  rmSync(outside18, { force: true });
}

/* ═════════════════ 19. FULL-1 原版 Docs saveDocxNew:no-clobber 物理并发 ═════════════════
 * GenOffice 的 saveDocxNew 是宿主受控路径适配，不自行发明第二编辑器。
 * uniquePathIn() 的 existsSync 仅是提示；另一进程可在检查后、提交前抢先建文件。
 * 旧 atomicReplaceFile(tmp→rename) 会覆盖这份刚创建的第三方文件。
 * 故障注入在生产已有 beforeAtomicReplace 接缝触发，所有 IO 仅用 mkdtemp。 */
{
  const fs19 = await import("node:fs");
  const { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } = fs19;
  const { tmpdir } = await import("node:os");
  const { join: join19, basename: base19 } = await import("node:path");
  const root19 = mkdtempSync(join19(tmpdir(), "mcode-genoffice-new-noclobber-"));
  const oldDoc = join19(root19, "existing.docx");
  writeFileSync(oldDoc, "OLD-PRESERVED");
  let race = true;
  let targeted = "";
  let hookCount = 0;
  const host19 = new DocumentViewHost({
    getMainWindow: () => makeFakeWindow(),
    createView: makeFakeView,
    beforeAtomicReplace: async (target) => {
      hookCount++;
      targeted = target;
      if (race) {
        // Only a third-party process would know the generated random name
        // after our initial existsSync. Deterministic phase injection.
        writeFileSync(target, "THIRD-PARTY-MUST-SURVIVE");
        race = false;
      }
    },
  });
  host19.open({docId:"new-doc-19",url:FILE_URL,bounds:BOUNDS,visible:true});
  const initial = openAndCommit(host19, "new-doc-19", oldDoc, () => true);
  check("FULL-1 前置：旧文档真实打开",initial.ok===true,initial);
  const payload = new TextEncoder().encode("PK-MCODE-NEW-DOCX-BYTES");
  const blocked=await host19.saveNewFile("new-doc-19",payload,()=>true,"draft.docx");
  check("★ 跨进程抢先创建随机新文档路径后 saveDocxNew 必须拒绝覆盖",
    blocked.ok===false,{blocked,targeted});
  check("★ 抢先创建者的全部字节保留，无 rename 静默覆盖",
    targeted!==""&&readFileSync(targeted,"utf8")==="THIRD-PARTY-MUST-SURVIVE",
    {targeted,bytes:targeted?readFileSync(targeted,"utf8"):null});
  check("★ 拒绝首次保存后原来打开的旧文档会话还在",
    host19.sessionFor("new-doc-19")?.filePath===oldDoc&&readFileSync(oldDoc,"utf8")==="OLD-PRESERVED",
    host19.sessionFor("new-doc-19"));
  check("★ 失败时不遗留 staging 文档临时文件",
    readdirSync(root19).every((entry)=>!entry.includes(".mcode-stage")&&!entry.includes(".mcode-tmp")),
    readdirSync(root19));
  const occupiedPath = targeted; // second save runs same probe hook with a new UUID
  const good=await host19.saveNewFile("new-doc-19",payload,()=>true,"draft.docx");
  check("★ 无并发时仍能首次创建完整的原生文档字节",
    good.ok===true&&readFileSync(good.ok?good.filePath:oldDoc).equals(Buffer.from(payload)),good);
  check("★ 成功后会话切换到宿主实际新建的目标路径",
    good.ok===true&&host19.sessionFor("new-doc-19")?.filePath===good.filePath&&
    base19(good.filePath).startsWith("draft-")&&hookCount===2,
    {good,owner:host19.sessionFor("new-doc-19"),hookCount});
  check("★ 先前并发抢先创建的文件没有在后续成功保存中被擦掉",
    occupiedPath!==""&&readFileSync(occupiedPath,"utf8")==="THIRD-PARTY-MUST-SURVIVE");
  host19.dispose();
  rmSync(root19,{recursive:true,force:true});
}

/* ═════════════ 20. 视图关闭后迟到的首次保存不可创建孤儿文件 ═════════════ */
{
  const {mkdtempSync,writeFileSync,existsSync,rmSync}=await import("node:fs");
  const {tmpdir}=await import("node:os");
  const {join:join20}=await import("node:path");
  const workspace20=mkdtempSync(join20(tmpdir(),"mcode-genoffice-closed-save-"));
  const original=join20(workspace20,"original.docx");
  writeFileSync(original,"ORIGINAL-BYTES");
  let announceReached:()=>void=()=>{};
  const reached=new Promise<void>(r=>{announceReached=r;});
  let proceed:()=>void=()=>{};
  const gate=new Promise<void>(r=>{proceed=r;});
  let candidate="";
  const host20=new DocumentViewHost({
    getMainWindow:()=>makeFakeWindow(),
    createView:makeFakeView,
    beforeAtomicReplace:async(target)=>{
      candidate=target;
      announceReached();
      await gate;
    },
  });
  host20.open({docId:"close-in-flight",url:FILE_URL,bounds:BOUNDS,visible:true});
  eq("关闭竞态前打开真实文档",openAndCommit(host20,"close-in-flight",original,()=>true),{ok:true});
  const saving=host20.saveNewFile("close-in-flight",
    new TextEncoder().encode("PK-DELAYED-NEW-DOCUMENT"),()=>true,"late.docx");
  await reached;
  check("★ 测试确实在首次保存落盘前截停",candidate!==""&&!existsSync(candidate),candidate);
  host20.close("close-in-flight");
  proceed();
  const late=await saving;
  check("★ 页面已关闭，迟到的新建文档请求必须失败",late.ok===false,late);
  check("★ 页面已经关闭不能在磁盘留下无主新文件",candidate!==""&&!existsSync(candidate),candidate);
  check("★ 页面关闭竞态保留原先的文档字节",existsSync(original));
  host20.dispose();
  rmSync(workspace20,{recursive:true,force:true});
}

/* ═════════════ 21. 登记失败回滚不能删除并发接手者的新内容 ═════════════
 * New-file publication and in-memory claim cannot be one OS transaction.
 * Simulate a later writer changing the new path before claim denies it:
 * blindly rmSync(target) would delete their now-current bytes.
 */
{
  const {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync}=await import("node:fs");
  const {tmpdir}=await import("node:os");
  const {join:join21}=await import("node:path");
  const root21=mkdtempSync(join21(tmpdir(),"mcode-genoffice-claim-race-"));
  const oldDoc=join21(root21,"opened.docx");
  writeFileSync(oldDoc,"ORIGINAL-SAFE");
  const host21=new DocumentViewHost({getMainWindow:()=>makeFakeWindow(),createView:makeFakeView});
  host21.open({docId:"claim-race",url:FILE_URL,bounds:BOUNDS,visible:true});
  eq("回滚竞态前打开真实原文档",openAndCommit(host21,"claim-race",oldDoc,()=>true),{ok:true});
  let published="";
  const mutable=host21 as unknown as {
    claimOpenedPath:(docId:string,target:string,sender:unknown)=>{ok:boolean;reason?:string}
  };
  const originalClaim=mutable.claimOpenedPath.bind(host21);
  mutable.claimOpenedPath=(docId,target,sender)=>{
    if(target===oldDoc)return originalClaim(docId,target,sender);
    published=target;
    writeFileSync(target,"THIRD-PARTY-POST-PUBLISH-VERSION");
    return {ok:false,reason:"SYNTHETIC_CONCURRENT_CLAIM_REJECT"};
  };
  const attempted=await host21.saveNewFile("claim-race",
    new TextEncoder().encode("PK-NEW-DOCX"),()=>true,"race.docx");
  check("★ 登记失败必须向调用方说明拒绝",attempted.ok===false,attempted);
  check("★ 登记失败时不可盲删被另一写者更新的已创建文档",
    published!==""&&existsSync(published)&&
    readFileSync(published,"utf8")==="THIRD-PARTY-POST-PUBLISH-VERSION",
    {published,attempted});
  check("★ 登记失败后仍保留原打开文档身份和内容",
    host21.sessionFor("claim-race")?.filePath===oldDoc&&readFileSync(oldDoc,"utf8")==="ORIGINAL-SAFE");
  check("★ 无主文件必须在错误中披露留存位置，交由人处置",
    attempted.ok===false&&published!==""&&attempted.reason.includes(published),
    attempted);
  host21.dispose();
  rmSync(root21,{recursive:true,force:true});
}

/* ═════════════ 22. FULL-1 文档保存 await 时会话撤销/切换 ═════════════
 * A GenOffice tab may be closed or rebound while a cross-process OS lease
 * and the save's beforeAtomicReplace hook are pending. The stale old editor
 * must not write bytes after its host ownership has been revoked.
 */
{
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: join22 } = await import("node:path");
  const root22 = mkdtempSync(join22(tmpdir(), "mcode-genoffice-save-revoke-"));
  const original = join22(root22, "first.docx");
  const replacement = join22(root22, "second.docx");
  writeFileSync(original, "FIRST-ORIGINAL", "utf8");
  writeFileSync(replacement, "SECOND-ORIGINAL", "utf8");

  for (const reason of ["close", "switch", "workspace-revoke"] as const) {
    writeFileSync(original, "FIRST-ORIGINAL", "utf8");
    let unblock: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { unblock = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const host22 = new DocumentViewHost({
      getMainWindow: () => makeFakeWindow(),
      createView: makeFakeView,
      beforeAtomicReplace: async () => { entered?.(); await held; },
    });
    const docId = "live-save-" + reason;
    eq("FULL-1 打开基线文档", host22.open({ docId, url: FILE_URL, bounds: BOUNDS, visible: true }), { ok: true });
    eq("FULL-1 登记当前会话", openAndCommit(host22, docId, original), { ok: true });
    let permitted = true;
    const pending = host22.saveOpenedFile(docId,
      new TextEncoder().encode("STALE-SAVE-SHOULD-NOT-COMMIT"), () => permitted);
    await started;
    if (reason === "close") host22.close(docId);
    if (reason === "switch") {
      const moved = openAndCommit(host22, docId, replacement);
      check("★ 等待中的旧保存让位后可以绑定新文档", moved.ok === true, moved);
    }
    if (reason === "workspace-revoke") permitted = false;
    unblock?.();
    const result = await pending;
    check("★ 执行前所有权失效不可发布陈旧文档保存：" + reason,
      result.ok === false, result);
    eq("★ 上一份真实文档字节在撤销后保持原样：" + reason,
      readFileSync(original, "utf8"), "FIRST-ORIGINAL");
    if (reason === "switch") {
      eq("★ 新文档没有被旧请求写入", readFileSync(replacement, "utf8"), "SECOND-ORIGINAL");
      eq("★ 等待旧请求返回后仍保持新会话身份", host22.sessionFor(docId)?.filePath, replacement);
    }
    host22.dispose();
  }
  rmSync(root22, { recursive: true, force: true });
}

/* ═════════════ 23. Slides 保存后的异步回执不许复活/污染新会话 ═════════════
 * The vendor is still the only PPTX writer. This Host helper merely advances
 * the Mcode revision; it must not attribute an old save to a newly reopened
 * view or update another document's revision after an awaited stat/hash.
 */
{
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: join23 } = await import("node:path");
  const root23=mkdtempSync(join23(tmpdir(),"mcode-slides-save-session-"));
  const a=join23(root23,"deck-old.pptx");
  const b=join23(root23,"deck-new.pptx");
  writeFileSync(a,"DECK-A-ORIGINAL");
  writeFileSync(b,"DECK-B-ORIGINAL");
  for(const reason of ["closed","switched","workspace-revoked"] as const) {
    const docId="slides-late-"+reason;
    let within=true;
    const host=new DocumentViewHost({getMainWindow:()=>makeFakeWindow(),createView:makeFakeView});
    eq("slides 异步场景准备视图",host.open({docId,url:FILE_URL,bounds:BOUNDS,visible:true,editor:"slides"}),{ok:true});
    eq("slides 绑定原始 deck",openAndCommit(host,docId,a),{ok:true});
    const save=host.recordSlidesSave(docId,()=>within);
    if(reason==="closed") host.close(docId);
    if(reason==="switched") {
      const newOpen=openAndCommit(host,docId,b);
      check("★ slides 延迟回执期间可以由独立新文档接管视图",newOpen.ok===true,newOpen);
    }
    if(reason==="workspace-revoked")within=false;
    let result:Awaited<ReturnType<typeof host.recordSlidesSave>>|undefined;
    let thrown:unknown;
    try { result=await save; } catch(err) { thrown=err; }
    check("★ 旧 slides 回执必须安全拒绝且不产生未捕获错误："+reason,
      thrown===undefined && result?.ok===false,
      {result,thrown:String(thrown)});
    if(reason==="switched") {
      eq("★ 旧 slides 回执不修改新文档会话路径",host.sessionFor(docId)?.filePath,b);
      const {createHash}=await import("node:crypto");
      eq("★ 旧 slides 回执不修改新文档 revision",
        await host.sessionFor(docId)?.revision,
        createHash("sha256").update("DECK-B-ORIGINAL").digest("hex"));
    }
    host.dispose();
  }
  rmSync(root23,{recursive:true,force:true});
}

/* ═════════════ 24. FULL-1 异步真人替换确认代次不可复用 ═════════════
 * The user can continue typing, close, or switch tabs while a dirty-document
 * confirmation dialog is pending. An old consent cannot authorize discarding
 * edits made AFTER the consent request or in a different document.
 */
{
  const { mkdtempSync,writeFileSync,rmSync }=await import("node:fs");
  const { tmpdir }=await import("node:os");
  const { join: join24 }=await import("node:path");
  const root24=mkdtempSync(join24(tmpdir(),"mcode-dirty-approval-"));
  const a=join24(root24,"before.docx");
  const b=join24(root24,"after.docx");
  writeFileSync(a,"DOCUMENT-A");
  writeFileSync(b,"DOCUMENT-B");
  for(const scenario of ["close","switch","new-edit"] as const) {
    const host=new DocumentViewHost({getMainWindow:()=>makeFakeWindow(),createView:makeFakeView});
    const docId="approval-"+scenario;
    eq("等待确认前视图打开",host.open({docId,url:FILE_URL,bounds:BOUNDS,visible:true}),{ok:true});
    eq("等待确认前绑定文档A",openAndCommit(host,docId,a),{ok:true});
    host.reportPageDirty(docId,true);
    let resolveDecision!: (allowed:boolean)=>void;
    const decision=new Promise<boolean>((resolve)=>{resolveDecision=resolve;});
    host.setConfirmDirty(async()=>decision);
    const pending=host.confirmDocumentReplace(docId);
    if(scenario==="close") host.close(docId);
    if(scenario==="switch") {
      const swapped=openAndCommit(host,docId,b);
      check("★ 同docId可在弹窗等待时切换到文档B",swapped.ok===true,swapped);
    }
    if(scenario==="new-edit") host.reportPageDirty(docId,true);
    resolveDecision(true);
    eq("★ 等待期间视图/文档/未保存编辑代次已改变，旧同意不可再次授权："+scenario,
      await pending,false);
    host.dispose();
  }
  rmSync(root24,{recursive:true,force:true});
}

console.log(`\ndocument-view-host-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
