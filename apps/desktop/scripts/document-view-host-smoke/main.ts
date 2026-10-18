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
  /** 宿主经 `webContents.send` 发给页面的所有消息。 */
  sends: Array<{ channel: string; args: unknown[] }>;
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
    sends: [],
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
      send(channel: string, ...args: unknown[]) {
        log.sends.push({ channel, args });
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
  const internalSave = "mcode:document-view:save";
  check("视图 preload 的内部打开通道已注册", handlers.has(internal));
  check("视图 preload 的内部保存通道已注册", handlers.has(internalSave));
  check("注册的通道就是这八条 + 两条内部通道（不多不漏）",
    JSON.stringify([...handlers.keys()].sort()) === JSON.stringify([...channels, internal, internalSave].sort()),
    { actual: [...handlers.keys()].sort(), expected: [...channels, internal, internalSave].sort() });

  const rpc = new Set(registeredRpcChannels());
  eq("★ 八条通道全登记进 recordRpcHandler（app_api_call 看得见）", channels.filter((c) => !rpc.has(c)), []);
  // 内部通道**不该**出现在 RPC 表里 —— 那是给页面的，不是给 Agent 的。
  check("★ 内部 open-path 通道不在 RPC 表（不扩大 Agent 能力面）", !rpc.has(internal), [...rpc].filter((c) => c.includes("open-path")));
  check("★ 内部 save 通道同样不在 RPC 表", !rpc.has(internalSave), [...rpc].filter((c) => c.includes("save")));
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

  eq("openPath 记下这份文档", host.openPath("save-1", opened, () => true), { ok: true });
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
  eq("改打开另一份之后目标随之改变", host.openPath("save-1", other, () => true), { ok: true });
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
  eq("openPath 成功（记下打开时版本）", host.openPath("conf-1", doc, () => true), { ok: true });

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
    registerDocumentViewHandlers(fakeIpc11, host, () => true);
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
  eq("前置：openPath 成功并记下打开时版本", host.openPath("lease-1", doc12, () => true), { ok: true });

  // 两个保存几乎同时发出：A 先拿到租约并挂在接缝上；B 发出后必然卡在租约上。
  const saveA = host.saveOpenedFile("lease-1", new TextEncoder().encode("winner-A"), () => true);
  // 等到 A 真正进入临界区（挂起在接缝上 = 租约已被 A 持有），再发 B。
  while (enteredCritical === 0) await new Promise((r) => setTimeout(r, 5));
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
      eq("前置：openPath 成功", host.openPath("xproc-1", doc13, () => true), { ok: true });

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
      eq("前置：openPath 成功（b）", host.openPath("xproc-b", docB, () => true), { ok: true });
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

console.log(`\ndocument-view-host-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
