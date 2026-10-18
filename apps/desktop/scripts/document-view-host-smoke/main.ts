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
} from "@contracts/ipc";
import {
  DocumentViewHost,
  checkDocumentViewUrl,
  type DocumentViewHostWindow,
  type DocumentViewLike,
  type DocumentViewWebPreferences,
} from "@main/document/documentViewHost.js";
import { registerDocumentViewHandlers } from "@main/ipc/documentView.js";
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
}

/** 按创建顺序记录每个假视图 —— 断言读它。 */
const created: FakeViewLog[] = [];

function makeFakeView(prefs: DocumentViewWebPreferences): DocumentViewLike {
  const log: FakeViewLog = {
    prefs,
    bounds: [],
    loads: [],
    focused: 0,
    closed: false,
    windowOpenHandlerInstalled: false,
    failureListeners: {},
  };
  created.push(log);
  const view: DocumentViewLike = {
    webContents: {
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
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "did-fail-load" || event === "render-process-gone") {
          log.failureListeners[event] = listener;
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

// 纯函数级断言：闸本身（不经状态机），把判定锥体钉在原因文案上而不是"某处拒绝"。
{
  eq("file: 普通路径通过", checkDocumentViewUrl("file:///C:/x/y.html").ok, true);
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

  registerDocumentViewHandlers(fakeIpc, host, () => true);

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
  const internal = "mcode:document-view:open-path";
  check("视图 preload 的内部打开通道已注册", handlers.has(internal));
  check("注册的通道就是这八条 + 一条内部通道（不多不漏）",
    JSON.stringify([...handlers.keys()].sort()) === JSON.stringify([...channels, internal].sort()),
    { actual: [...handlers.keys()].sort(), expected: [...channels, internal].sort() });

  const rpc = new Set(registeredRpcChannels());
  eq("★ 八条通道全登记进 recordRpcHandler（app_api_call 看得见）", channels.filter((c) => !rpc.has(c)), []);
  // 内部通道**不该**出现在 RPC 表里 —— 那是给页面的，不是给 Agent 的。
  check("★ 内部 open-path 通道不在 RPC 表（不扩大 Agent 能力面）", !rpc.has(internal), [...rpc].filter((c) => c.includes("open-path")));
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
    check("ipc/index.ts 调用了 registerDocumentViewHandlers（带路径围栏）", /registerDocumentViewHandlers\(ipc, documentViewHost,/.test(index));
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
  // 【ARC-007】通道形状由 vendor 页面决定：它只订阅 menu:command 并处理
  // "open-path"。发到自定义通道上 = 发了没人收（曾经就是这样）。
  eq("★ 发到了 vendor 页面订阅的 menu:command", sends.at(-1)?.channel, "menu:command");
  eq("★ 第一条参数是 vendor 认识的 open-path", sends.at(-1)?.args[0], "open-path");
  eq("★ 路径作为第二条参数原样交给页面", sends.at(-1)?.args[1], "D:/workspace/doc.docx");

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
    check("★ 宿主真的发到 menu:command", hostSrc.includes("wc.send(VENDOR_MENU_COMMAND_CHANNEL, VENDOR_OPEN_PATH_COMMAND, filePath)"));
    eq("★ 宿主发的通道名与 preload 订阅的一致", /VENDOR_MENU_COMMAND_CHANNEL\s*=\s*"([^"]+)"/.exec(hostSrc)?.[1], menuMatch?.[1]);
    eq("★ 宿主发的命令名与 preload 的一致", /VENDOR_OPEN_PATH_COMMAND\s*=\s*"([^"]+)"/.exec(hostSrc)?.[1], cmdMatch?.[1]);
  }

  const live = (host as unknown as { views: Map<string, { view: { webContents: unknown } }> }).views.get("open-1");
  eq("★ docIdForSender 能反查真实视图", host.docIdForSender(live?.view.webContents), "open-1");
  eq("★ 陌生 sender 反查为 null（页面伪造不了身份）", host.docIdForSender({}), null);
  host.closeAll();
}


console.log(`\ndocument-view-host-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
