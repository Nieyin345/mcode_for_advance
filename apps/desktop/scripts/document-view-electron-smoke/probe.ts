/**
 * 【ARC-007】真 Electron 下的文档视图宿主 U1 探针。
 *
 * ## 它验的是无头套件**证明不了**的那一半
 *
 * `document-view-host-smoke` 用假 `WebContentsView` 验状态机；这一套起真 Electron、
 * 建真 `WebContentsView`、加载真 `file://` 编辑器页（套件自己造一个最小 HTML 页面，
 * 不依赖 genoffice 构建产物），从而回答三件事：
 *
 *  1. **真的挂得上**：`win.contentView.addChildView` + `setBounds` 在真窗口上不抛；
 *  2. **preload 桥真的在页面里**：页面里的 `window.desktop.onMenuCommand` 是函数，
 *     且 `typeof window.desktop.openDocxPath === "function"` —— 这是 vendor 页面
 *     首帧就会读的两个符号（缺一个整页就崩）；
 *  3. **打开请求真的到达页面**（端到端闭环）：`host.openPath(...)` → 真 webContents
 *     的 `menu:command` → 页面里注册的 `onMenuCommand` 回调 → 页面把收到的
 *     (command, payload) 写回 `<body data-…>`，探针从主进程读回来断言。**这一步
 *     是上一次真断链的回归**：宿主发自定义通道时页面收不到，openPath 返回 ok
 *     而文档永远不打开。
 *  4. **身份反查**：页面侧用 `openDocxPath` 上送时，主进程从 `event.sender`
 *     反查 docId；探针用真实 IPC 往返验它。
 *
 * ## 安全边界（与套件外一致）
 *
 * - 不联网：页面是 `file://` 本地临时文件，CSP 里 `connect-src 'none'`；
 * - 不碰用户数据根：electron-host.cjs 把 app 的所有路径重指到 `MCODE_DV_DIR`；
 * - 不加载 genoffice 真实编辑器（那会引入它自己的 preload 依赖与 AI 面板）——
 *   本套验的是**宿主 ⇄ 页面**这一层；编辑器页本身由 `document-view-renderer-smoke`
 *   与构建产物断言覆盖。
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DocumentViewHost } from "@main/document/documentViewHost.js";
import { registerDocumentViewHandlers } from "@main/ipc/documentView.js";
import { IPC } from "@contracts/ipc";

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  error?: string;
}

/** 套件自造的"最小编辑器页"：它只做三件事 ——
 *  记下 bridge 是否存在、订阅 menu:command、把收到的命令写进 DOM 供探针读回。 */
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'">
<title>document view u1 page</title></head>
<body data-bridge="unknown">
<script>
  const bridge = window.desktop;
  document.body.dataset.bridge = typeof bridge === 'object' && bridge !== null ? 'object' : String(bridge);
  document.body.dataset.openDocxPath = typeof bridge?.openDocxPath;
  document.body.dataset.onMenuCommand = typeof bridge?.onMenuCommand;
  document.body.dataset.menu = '';
  try {
    bridge.onMenuCommand((command, payload) => {
      document.body.dataset.menu = command + '|' + String(payload);
    });
  } catch (err) {
    document.body.dataset.menu = 'subscribe-failed:' + String(err);
  }
  // 页面侧上送一个"请打开这条路"的请求（身份由宿主从 event.sender 反查）。
  window.__requestOpen = (p) => bridge.openDocxPath(p).then(
    (r) => { document.body.dataset.openReply = JSON.stringify(r); return r; },
    (e) => { document.body.dataset.openReply = 'rejected:' + String(e); },
  );
</script>
</body></html>`;

const checks: Check[] = [];
/** 探针级单例：`viewWebContents` / `senderOf` 需要它，生产里这些句柄由 Electron 给。 */
let host: DocumentViewHost;

export async function runDocumentViewProbe(dir: string): Promise<void> {
  const evidence = join(dir, "checks.json");
  let win: BrowserWindow | undefined;
  const viewsRoot = join(dir, "workspace");
  const outsideRoot = join(dir, "outside");
  const pagePath = join(viewsRoot, "editor.html");
  const docPath = join(viewsRoot, "report.docx");
  const outsidePath = join(outsideRoot, "secret.docx");
  await mkdir(viewsRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(pagePath, PAGE_HTML, "utf8");
  await writeFile(docPath, "fake docx bytes", "utf8");
  await writeFile(outsidePath, "outside bytes", "utf8");

  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
      console.log("PASS DOCVIEW " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      throw error;
    } finally {
      await writeFile(evidence, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };
  async function until(predicate: () => Promise<boolean> | boolean, label: string, timeout = 15000): Promise<void> {
    const start = Date.now();
    while (!(await predicate())) {
      if (Date.now() - start > timeout) throw new Error("Timed out: " + label);
      await delay(40);
    }
  }
  const js = async <T = unknown>(expression: string): Promise<T> =>
    (await (win as BrowserWindow).webContents.executeJavaScript(expression, true)) as T;

  host = new DocumentViewHost({ getMainWindow: () => win as unknown as never });
  const seen: Array<{ channel: string; filePath: string }> = [];
  /** 生产装配的围栏判据在套件里换成本地"只认 workspace 目录"。 */
  const withinWorkspace = (p: string): boolean => p.startsWith(viewsRoot) || p.startsWith(viewsRoot.replace(/\\/g, "/"));

  win = new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  await win.loadURL("data:text/html,<title>host</title>");

  // 真 IPC 面：八条 RPC + 内部 open-path 必须注册到**真 ipcMain** —— 页面里的
  // `ipcRenderer.invoke` 只认它；用假对象会让 preload 的 openDocxPath 静默失败
  // （真发生过：日志里 `No handler registered`，断言却绿）。
  registerDocumentViewHandlers(ipcMain, host, withinWorkspace);


  try {
    await check("真 Electron 窗口就绪", () => {
      assert(win !== undefined && !win.isDestroyed(), "窗口不存在");
    });

    await check("URL 围栏在真 Electron 下仍然先拒后建", () => {
      const rejected = host.open({
        docId: "u1-rejected",
        url: "https://example.com/editor",
        bounds: { x: 0, y: 0, width: 400, height: 300 },
        visible: true,
      });
      assert(rejected.ok === false, "远程 URL 应被拒");
      assert(host.list().length === 0, "被拒时不应有视图");
    });

    await check("真 WebContentsView 挂载、bounds 生效、页面加载成功", async () => {
      const opened = host.open({
        docId: "u1-doc",
        url: pathToFileURL(pagePath).toString(),
        bounds: { x: 20, y: 30, width: 500, height: 400 },
        visible: true,
      });
      assert(opened.ok, `open 失败: ${JSON.stringify(opened)}`);
      const snap = host.list();
      assert(snap.length === 1, `快照条数 ${snap.length}`);
      assert(snap[0].visible === true, "视图应可见");
      assert(JSON.stringify(snap[0].bounds) === JSON.stringify({ x: 20, y: 30, width: 500, height: 400 }), `bounds ${JSON.stringify(snap[0].bounds)}`);
      // 等到页面真的加载完（body 有我们写的标记）。
      const view = viewWebContents("u1-doc");
      await until(async () => (await view.executeJavaScript("document.readyState")) === "complete", "页面 DOM 完成");
      assert(snap[0].lastFailure === undefined, `加载失败: ${JSON.stringify(snap[0].lastFailure)}`);
    });

    await check("preload 桥真的注入页面：onMenuCommand / openDocxPath 都是函数", async () => {
      const view = viewWebContents("u1-doc");
      const probe = (await view.executeJavaScript(
        "({bridge: document.body.dataset.bridge, open: document.body.dataset.openDocxPath, menu: document.body.dataset.onMenuCommand})",
      )) as { bridge: string; open: string; menu: string };
      assert(probe.bridge === "object", `window.desktop 不是对象: ${probe.bridge}`);
      assert(probe.open === "function", `openDocxPath 不可用: ${probe.open}`);
      assert(probe.menu === "function", `onMenuCommand 不可用: ${probe.menu}（页面会整页崩）`);
    });

    await check("openPath 端到端：宿主发 menu:command，页面真的收到 open-path", async () => {
      const result = host.openPath("u1-doc", docPath, withinWorkspace);
      assert(result.ok, `openPath 被拒: ${JSON.stringify(result)}`);
      const view = viewWebContents("u1-doc");
      await until(async () => {
        const menu = (await view.executeJavaScript("document.body.dataset.menu")) as string;
        return menu.startsWith("open-path|");
      }, "页面收到 menu:command");
      const menu = (await view.executeJavaScript("document.body.dataset.menu")) as string;
      assert(menu === `open-path|${docPath}`, `页面收到的命令/路径不符: ${menu}`);
    });

    await check("openPath 围栏：工作区外路径被拒且页面收不到任何新命令", async () => {
      const view = viewWebContents("u1-doc");
      const before = (await view.executeJavaScript("document.body.dataset.menu")) as string;
      const denied = host.openPath("u1-doc", outsidePath, withinWorkspace);
      assert(denied.ok === false, "工作区外路径应被拒");
      await delay(150);
      const after = (await view.executeJavaScript("document.body.dataset.menu")) as string;
      assert(after === before, `被拒后页面仍收到命令: ${after}`);
    });

    await check("hide 保活：真视图仍在、**视图**移到屏幕外、页面状态未销毁", async () => {
      const hidden = host.hide("u1-doc");
      assert(hidden.ok, `hide 失败: ${JSON.stringify(hidden)}`);
      const snap = host.list()[0];
      assert(snap.visible === false, "快照应标为不可见");
      // 快照里的 bounds 是**逻辑几何**（show 时要恢复的那一份）；真正 apply 到
      // 原生视图上的才是屏幕外坐标 —— 两件事别混（与 BrowserManager 同）。
      assert(snap.bounds.x === 20 && snap.bounds.y === 30, `快照应保留逻辑几何: ${JSON.stringify(snap.bounds)}`);
      const applied = appliedBounds("u1-doc");
      assert(applied.x === -9999 && applied.y === -9999, `视图未移出屏幕: ${JSON.stringify(applied)}`);
      assert(applied.width === 500 && applied.height === 400, `隐藏应保留宽高: ${JSON.stringify(applied)}`);
      const view = viewWebContents("u1-doc");
      assert(!view.isDestroyed(), "hide 不应销毁 webContents");
      const menu = (await view.executeJavaScript("document.body.dataset.menu")) as string;
      assert(menu.startsWith("open-path|"), "hide 后页面状态应保留");
    });

    await check("show 恢复几何（不重建视图）", async () => {
      const shown = host.show("u1-doc");
      assert(shown.ok, `show 失败: ${JSON.stringify(shown)}`);
      const snap = host.list()[0];
      assert(snap.visible === true, "show 后应可见");
      assert(snap.bounds.x !== -9999, `show 后坐标未恢复: ${JSON.stringify(snap.bounds)}`);
    });

    await check("页面经 openDocxPath 上送，宿主从 event.sender 反查身份并转发", async () => {
      const view = viewWebContents("u1-doc");
      // 清掉上一次标记，让页面自己经 preload 的 openDocxPath → 真 IPC → 真 handler
      // → host.docIdForSender(event.sender) → openPath → menu:command 回到页面。
      // 这是**完整的用户路径**：没有任何一步是探针替它走的。
      await view.executeJavaScript("document.body.dataset.menu = ''; document.body.dataset.openReply = ''");
      await view.executeJavaScript("window.__requestOpen(" + JSON.stringify(docPath) + ")");
      await until(async () => {
        const mark = (await view.executeJavaScript("document.body.dataset.menu")) as string;
        return mark === `open-path|${docPath}`;
      }, "页面上送后收到回推（链路闭环）");
      const reply = (await view.executeJavaScript("document.body.dataset.openReply")) as string;
      assert(reply.includes('"ok":true'), `openDocxPath 的回包不是 ok: ${reply}`);
      seen.push({ channel: "preload", filePath: docPath });
    });

    await check("close 销毁真 webContents 并摘下窗口", async () => {
      const view = viewWebContents("u1-doc");
      const closed = host.close("u1-doc");
      assert(closed.ok, `close 失败: ${JSON.stringify(closed)}`);
      await until(() => view.isDestroyed(), "webContents 销毁");
      assert(host.list().length === 0, "close 后快照应为空");
    });

    await check("dispose 后 open 被拒（不复活视图）", () => {
      host.dispose();
      const after = host.open({
        docId: "u1-after-dispose",
        url: pathToFileURL(pagePath).toString(),
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        visible: true,
      });
      assert(after.ok === false, "dispose 后 open 应被拒");
      assert(host.list().length === 0, "dispose 后不应有视图");
    });

    await check("全程没有页面未捕获异常、没有远程请求", async () => {
      assert(host.list().length === 0, "收尾时仍有视图");
      const pageSource = await readFile(pagePath, "utf8");
      assert(pageSource.includes("connect-src 'none'"), "测试页 CSP 应禁网");
    });
  } finally {
    try { host.dispose(); } catch { /* 已释放 */ }
    if (win && !win.isDestroyed()) win.destroy();
    await writeFile(evidence, JSON.stringify(checks, null, 2));
  }
}

/** 取视图的 webContents（宿主提供只读句柄，见 `DocumentViewHost.webContentsOf`）。 */
function viewWebContents(docId: string): import("electron").WebContents {
  const wc = host.webContentsOf(docId);
  if (wc === null) throw new Error(`没有 docId=${docId} 的视图`);
  return wc as unknown as import("electron").WebContents;
}

/** 原生视图上**实际**应用的矩形（`WebContentsView.getBounds()`），与快照里的
 *  逻辑几何分开读 —— hide 只把前者移到屏幕外。 */
function appliedBounds(docId: string): { x: number; y: number; width: number; height: number } {
  const wc = host.webContentsOf(docId);
  if (wc === null) throw new Error(`没有 docId=${docId} 的视图`);
  return (host as unknown as { views: Map<string, { view: { getBounds(): { x: number; y: number; width: number; height: number } } }> })
    .views.get(docId)!.view.getBounds();
}
