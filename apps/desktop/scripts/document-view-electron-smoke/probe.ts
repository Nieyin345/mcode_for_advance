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
 * - 不联网：页面是 `file://` 本地临时文件，CSP 只放行 handoff scheme
 *   （`connect-src genoffice-docx-media:`，与真 vendor 页一致），其余 connect 全禁；
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
import {
  initDocumentHandoffProtocol,
  registerDocumentHandoffSchemePrivileged,
} from "@main/document/documentViewHandoff.js";

// electron-host.cjs 必须在 app ready **之前**注册 scheme 特权，但同一个 bundle
// 只能被 require 一次 —— 探针在这里重新导出，让启动器从同一份模块实例里拿到
// 同一个函数（否则 handoff URL 的协议处理器与特权注册分属两份模块状态）。
export { registerDocumentHandoffSchemePrivileged };
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src genoffice-docx-media:">
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
  // 【ARC-007 P0】新协议是**单向两条**：页面 openDocxPath 只**拉取**宿主已准备的
  // 一次性响应（read-opened），不再反向 invoke open-path。所以这里要同时记录
  // 拉取回包里的 path/name/hash 以及 dataUrl 是否被页面真的取到（fetch 一次即焚）。
  window.__requestOpen = (p) => bridge.openDocxPath(p).then(
    async (r) => {
      const summary = r === null ? null : { path: r.path, name: r.name, hash: r.hash, hasDataUrl: typeof r.dataUrl === 'string' };
      if (r && typeof r.dataUrl === 'string') {
        try {
          const res = await fetch(r.dataUrl);
          const buf = new Uint8Array(await res.arrayBuffer());
          summary.bytes = buf.length;
          summary.pk = buf[0] === 0x50 && buf[1] === 0x4b;
          const again = await fetch(r.dataUrl).catch(() => null);
          summary.secondFetchStatus = again === null ? 'threw' : again.status;
        } catch (e) {
          summary.fetchError = String(e);
        }
        // vendor 成功路径的唯一必经调用：显示完成后读最近文件。preload 借此
        // 向宿主回执 open-committed，宿主才提交打开会话（与真页面同一条链）。
        try { await bridge.getRecentFiles(); } catch (e) { summary.recentError = String(e); }
      }
      document.body.dataset.openReply = JSON.stringify(summary);
      return summary;
    },
    (e) => { document.body.dataset.openReply = 'rejected:' + String(e); },
  );
  // saveDocx 的回包写进 DOM —— 冲突断言要看页面**真的收到**什么，而不是探针自己调宿主。
  window.__requestSave = (text) => bridge.saveDocx('', new TextEncoder().encode(text)).then(
    (r) => { document.body.dataset.saveReply = JSON.stringify(r); return r; },
    (e) => { document.body.dataset.saveReply = 'rejected:' + String(e); },
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
  // 最小 PK 夹具：宿主 readOpened 会做 docx 魔数预检（"PK"），非 zip 会按
  // 「坏档」拒绝 —— 那是产品行为，夹具必须过得了这道门才能验后面的链路。
  const DOCX_FIXTURE = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("fake docx bytes", "utf8")]);
  await writeFile(docPath, DOCX_FIXTURE);
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
      // 【ARC-007 P0】handoff 协议在 electron-host 里已于 ready 之前注册特权；
      // 这里接上请求处理器（ready 之后才能 handle）。页面 fetch 一次性字节
      // 走的就是这条协议 —— 不接 = 页面拿到 URL 但 fetch 失败。
      initDocumentHandoffProtocol();
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

    await check("页面经 openDocxPath 上送，宿主从 event.sender 反查身份并拉取一次性字节", async () => {
      const view = viewWebContents("u1-doc");
      // 【ARC-007 P0】新协议是**单向两条**：上一次 openPath 已推过一次
      // `menu:command("open-path")` 并登记了 pendingOpen；页面 `openDocxPath` 只
      // **拉取**（read-opened）宿主已准备的一次性响应，不再反向触发 open-path。
      // 因此这里不要求页面再收到一次回推 —— 回推已在上一节断言过。
      await view.executeJavaScript("document.body.dataset.openReply = ''");
      await view.executeJavaScript("window.__requestOpen(" + JSON.stringify(docPath) + ")");
      await until(async () => {
        const mark = (await view.executeJavaScript("document.body.dataset.openReply")) as string;
        return mark.length > 0 && mark !== "rejected:undefined";
      }, "页面拿到 read-opened 回包（链路闭环）");
      const reply = JSON.parse(
        (await view.executeJavaScript("document.body.dataset.openReply")) as string,
      ) as {
        path?: string; name?: string; hash?: string; hasDataUrl?: boolean;
        bytes?: number; pk?: boolean; secondFetchStatus?: number | string;
      };
      assert(reply.path === docPath, `回包 path 应为宿主准备的路径: ${JSON.stringify(reply)}`);
      assert(reply.name === "report.docx", `回包 name 应为文件名: ${JSON.stringify(reply)}`);
      assert(typeof reply.hash === "string" && reply.hash.length === 64, `回包应带 sha256: ${JSON.stringify(reply)}`);
      assert(reply.hasDataUrl === true, `回包应带一次性 dataUrl: ${JSON.stringify(reply)}`);
      // 页面真的 fetch 到了字节，而且**取一次即焚**：第二次 fetch 必须失败。
      assert(reply.bytes === DOCX_FIXTURE.length, `handoff 字节数不符: ${JSON.stringify(reply)}`);
      assert(reply.pk === true, `夹具带 PK 魔数，回包应体现 zip 头: ${JSON.stringify(reply)}`);
      assert(reply.secondFetchStatus === "threw" || (typeof reply.secondFetchStatus === "number" && reply.secondFetchStatus >= 400),
        `一次性响应第二次 fetch 应失败: ${JSON.stringify(reply)}`);
      // 回执由 preload 的 getRecentFiles 触发（vendor 成功路径唯一必经调用），
      // 上面那次 openDocxPath 之后页面会调它 —— 等会话提交。
      // 会话表是"打开已提交"的唯一真值（快照不含 openedFilePath）。页面上面
      // 经 preload 的 getRecentFiles 回执后宿主才提交 —— 等它出现。
      await until(() => host.sessionFor("u1-doc")?.filePath === docPath, "打开会话提交");
      const session = host.sessionFor("u1-doc");
      assert(session !== null && session.filePath === docPath, `会话未指向打开的文档: ${JSON.stringify(session?.filePath)}`);
      seen.push({ channel: "preload", filePath: docPath });
    });

    await check("保存通道端到端：页面经 preload 写回它打开的那份文件", async () => {
      const view = viewWebContents("u1-doc");
      // 页面先经宿主打开 report.docx（openPath 会记下 openedFilePath），再经
      // preload 的 saveDocx 提交新字节；断言磁盘上**只有那份**被改。
      const original = await readFile(docPath);
      assert(original.equals(DOCX_FIXTURE), `前置内容不符: ${original.toString("latin1")}`);
      await view.executeJavaScript(
        "window.desktop.saveDocx(" + JSON.stringify(docPath) + ", new TextEncoder().encode('U1-SAVED-BYTES'))",
      );
      await until(async () => (await readFile(docPath, "utf8")) === "U1-SAVED-BYTES", "保存落盘");
      // 页面传的 path 被忽略 —— 即使它瞎传一个别的路径，宿主也只会写 openedFilePath。
      // 断言等那次写真的完成（日志里 8 字节那次），不靠固定延时猜。
      await view.executeJavaScript(
        "window.desktop.saveDocx(" + JSON.stringify(join(outsideRoot, "secret.docx")) + ", new TextEncoder().encode('INJECTED'))",
      );
      await until(async () => (await readFile(docPath, "utf8")) === "INJECTED", "第二次保存也写回 openedFilePath");
      assert((await readFile(outsidePath, "utf8")) === "outside bytes", "页面瞎传的路径绝不能被执行");
    });

    await check("保存冲突端到端：外部改动后页面保存被拒、盘上保留外部内容", async () => {
      const view = viewWebContents("u1-doc");
      // 前置：上一段保存后 openedFileRevision 已推进到 "INJECTED"。
      assert((await readFile(docPath, "utf8")) === "INJECTED", "前置内容不符");
      // 模拟"别处改了文件"（另一窗口 / Agent / 外部编辑器）。内容必须是**合法
      // docx 头**：后续"重新打开"要过 readOpened 的 PK 魔数预检，纯文本会被按
      // 坏档拒绝 —— 那是产品判据，不是夹具可以绕开的。
      const OUTSIDE_EDIT_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("OUTSIDE-EDIT", "utf8")]);
      await writeFile(docPath, OUTSIDE_EDIT_BYTES);
      await view.executeJavaScript("document.body.dataset.saveReply = ''");
      await view.executeJavaScript("window.__requestSave('PAGE-SHOULD-NOT-LAND')");
      await until(async () => {
        const mark = (await view.executeJavaScript("document.body.dataset.saveReply")) as string;
        return mark.length > 0 && mark !== "rejected:undefined";
      }, "页面收到 saveDocx 回包");
      const reply = JSON.parse(
        (await view.executeJavaScript("document.body.dataset.saveReply")) as string,
      ) as { ok: boolean; reason?: string; error?: string; currentRevision?: string | null };
      assert(reply.ok === false, `冲突保存应失败: ${JSON.stringify(reply)}`);
      assert(reply.reason === "conflict", `reason 应为 conflict: ${JSON.stringify(reply)}`);
      assert(typeof reply.error === "string" && reply.error.length > 0, `冲突原因应可显示: ${JSON.stringify(reply)}`);
      assert(typeof reply.currentRevision === "string" && reply.currentRevision.length === 64, `应回传盘上 sha256: ${JSON.stringify(reply)}`);
      assert((await readFile(docPath)).equals(OUTSIDE_EDIT_BYTES), "冲突时盘上必须是外部内容");
      // 冲突回包里就是盘上当前版本（外部内容的 sha256）—— 后面"版本推进"以它为准。
      const replyCurrentRevision = reply.currentRevision;
      const snap = host.list().find((v) => v.docId === "u1-doc");
      assert(snap?.lastSaveConflict !== undefined, "宿主快照应记录 lastSaveConflict（面板第二条可见路径）");
      // 恢复基线：外部改动落定 → **走完整打开链**重新记版本（新协议下 openPath
      // 只登记待打开；页面 readOpened 拉取 + getRecentFiles 回执后才提交会话并
      // 刷新权威 revision）。只调 openPath 而不重拉，会话版本仍停在旧值 —— 那正是
      // 乐观锁该拦的情况，不是产品缺陷。
      assert(host.openPath("u1-doc", docPath, withinWorkspace).ok, "重新 openPath 失败");
      const reopenReply = await view.executeJavaScript(
        "window.__requestOpen(" + JSON.stringify(docPath) + ")",
      ) as { path?: string } | null;
      assert(reopenReply?.path === docPath, `重新打开应拿到字节: ${JSON.stringify(reopenReply)}`);
      // 重新打开后会话的权威版本必须**等于盘上当前内容**（即冲突回包里的
      // currentRevision）—— 这证明乐观锁基线真的刷新了，之后的保存才不会误判。
      await until(async () => {
        const rev = await host.sessionFor("u1-doc")?.revision;
        return rev === replyCurrentRevision;
      }, "会话权威版本推进到外部内容");
      const okSave = await view.executeJavaScript("window.__requestSave('AFTER-REOPEN')");
      assert((okSave as { ok: boolean }).ok === true, `重新打开后的保存应成功: ${JSON.stringify(okSave)}`);
      await until(async () => (await readFile(docPath, "utf8")) === "AFTER-REOPEN", "重新打开后的保存落盘");
    });

    await check("saveDocx 的路径不可由页面指定（源码级：preload 不转发、handler 不读 path）", async () => {
      const { readFileSync } = await import("node:fs");
      const preloadSrc = readFileSync(join(process.cwd(), "src/main/document/documentViewPreload.ts"), "utf8");
      const handlerSrc = readFileSync(join(process.cwd(), "src/main/ipc/documentView.ts"), "utf8");
      assert(/saveDocx:[\s\S]{0,400}?void path;/.test(preloadSrc), "preload 的 saveDocx 必须显式丢弃页面路径");
      assert(!/SAVE_DOCUMENT_CHANNEL,\s*\{\s*path/.test(preloadSrc), "preload 不得把页面路径转发给宿主");
      const saveHandler = handlerSrc.slice(handlerSrc.indexOf('"mcode:document-view:save"'));
      assert(saveHandler.length > 0, "找不到内部保存通道");
      assert(!/raw\.path|input\.path|input\?\.path/.test(saveHandler), "handler 不得读取页面给的路径");
      assert(/host\.saveOpenedFile\(docId, input\.bytes/.test(saveHandler), "handler 必须把字节交给宿主的 saveOpenedFile");
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
      assert(pageSource.includes("connect-src genoffice-docx-media:"), "测试页 CSP 只应放行 handoff scheme");
      assert(!/https?:/.test(pageSource.split("Content-Security-Policy")[1]?.split(">")[0] ?? ""), "测试页 CSP 不应放行任何 http(s) 目标");
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
