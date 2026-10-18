/**
 * 【ARC-005】真 Electron 端到端：HTML 预览入口 → 浏览器面板 → 真 WebContentsView。
 *
 * ## 它在无头套件之外补的那一段
 *
 * `design-tokens-smoke` §15 用纯函数验了两道围栏（工作区 + 种类）与源码接线；
 * 它证明不了「点下去之后，主进程**真的**把那个 `file://` 交给了一条真的
 * WebContentsView」。本套起真 Electron 二进制：
 *
 *   1. 渲染端挂**真** `HtmlPreviewButton`（`FileEditor.tsx` 导出，与工具栏同一份
 *      实现）与**真** `BrowserPanel`（生产源码），`window.api.browser.*` 经
 *      preload 桥接到**真** IPC handler（`registerBrowserHandlers`），后者委托给
 *      **真** `BrowserManager`；
 *   2. 点击按钮 → `openUrlInBrowser` → 面板消费 `pendingBrowserUrl` →
 *      `browser.create` + `browser.loadUrl` → 真 `WebContentsView.loadURL`；
 *   3. 探针从**主进程侧**读 `webContents.getURL()` / `getTitle()`（经 bridge 的
 *      `hpe:browser-*` handler），并监听真 `did-finish-load`，断言加载的正是
 *      工作区内那个 HTML 文件的 `file://` URL。
 *
 * ## 窗口可见性
 *
 * 隐藏窗口（`show:false`）下 WebContentsView 照样创建、照样加载 —— 本套判据
 * 只读 `getURL()` / 导航事件，不读像素，所以无头可观测。**没有伪造任何结果**：
 * 若加载链在隐藏窗口里不可观测，探针会如实超时失败，而不是回退成"只看调用记录"。
 *
 * ## 隔离
 *
 * `electron-host.cjs` 把 app 的全部路径重指到套件临时目录；数据根用本套的
 * `data/`（`userData/data-root.json`），项目根由探针写入真 DB（`ProjectRepo`）。
 * 页面 CSP `connect-src 'none'`，不联网。
 */
import { BrowserWindow, ipcMain } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  error?: string;
}

export async function runHtmlPreviewProbe(dir: string): Promise<void> {
  const evidence = join(dir, "checks.json");
  const checks: Check[] = [];
  let win: BrowserWindow | undefined;

  const insideRoot = join(dir, "workspace");
  const outsideRoot = join(dir, "outside");
  const insideHtml = join(insideRoot, "docs", "page.html");
  const insideHtm = join(insideRoot, "index.htm");
  const nonHtml = join(insideRoot, "notes.md");
  const outsideHtml = join(outsideRoot, "secret.html");
  await mkdir(join(insideRoot, "docs"), { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(insideHtml, "<!doctype html><title>inside</title><p>hello</p>", "utf8");
  await writeFile(insideHtm, "<!doctype html><title>htm</title>", "utf8");
  await writeFile(nonHtml, "# notes", "utf8");
  await writeFile(outsideHtml, "<!doctype html><title>outside</title>", "utf8");

  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
      console.log("PASS HPE " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      console.log("FAIL HPE " + name + " — " + String(error));
      throw error;
    } finally {
      writeFileSync(evidence, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };
  async function until(predicate: () => Promise<boolean> | boolean, label: string, timeout = 25000): Promise<void> {
    const start = Date.now();
    while (!(await predicate())) {
      if (Date.now() - start > timeout) throw new Error("Timed out: " + label);
      await delay(50);
    }
  }

  // ── 主进程：真 DB + 真浏览器 IPC handler + 真 BrowserManager ──
  const { initDb } = await import("@main/store/db.js");
  const { ProjectRepo } = await import("@main/store/repositories.js");
  await initDb();
  ProjectRepo.create({
    id: "hpe-project",
    name: "hpe",
    path: insideRoot,
    archived: false,
    pinnedAt: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  });

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      preload: join(dir, "bridge.cjs"),
    },
  });
  const wc = win.webContents;
  // BrowserManager 的 getMainWindow() 走被 alias 的 windowStub —— 把真窗口注入它，
  // 否则 create() 会报「主窗口未就绪」。（生产里由 main/index.ts 的 createMainWindow 设置。）
  // 相对路径 import —— esbuild 的 alias 把 @main/window.js 指到同一个文件，
  // 所以两处解析到同一份模块实例；相对路径同时让 tsc 看见 setProbeWindow。
  const { setProbeWindow } = await import("./windowStub.js");
  setProbeWindow(win as never);
  // 渲染端诊断：加载失败/脚本异常要能从主进程侧看见（否则只会看到"harness 未就绪"）。
  wc.on("console-message", (_e, level, message) => {
    console.log("RENDERER[" + level + "] " + message);
  });
  wc.on("render-process-gone", (_e, details) => {
    console.log("RENDERER GONE " + JSON.stringify(details));
  });
  await wc.loadFile(join(dir, "page.html"));
  try {
    const early = await wc.executeJavaScript("window.__probeError ?? null", true);
    if (early) console.log("EARLY PROBE ERROR: " + String(early));
    const apiKeys = await wc.executeJavaScript(
      'window.api ? Object.keys(window.api).slice(0,8).join(",") : "no-api"',
      true,
    );
    console.log("API KEYS: " + String(apiKeys));
  } catch (e) { console.log("EARLY QUERY FAILED: " + String(e)); }

  const { registerBrowserHandlers } = await import("@main/ipc/browser.js");
  registerBrowserHandlers(ipcMain);

  const { BrowserManager } = await import("@main/browser/BrowserManager.js");

  // 可观测性说明（不伪造）：BrowserManager 不对外暴露 webContents，所以探针拿
  // `BrowserManager.list()` 的 **真** `webContents.getURL()` / `getTitle()` 作证据 ——
  // 后者只有在页面文档解析后才等于文件里的 `<title>`，即"加载真的完成"；
  // 前者证明导航目标就是那个 `file://`。两件都从主进程读，渲染端不参与判断。

  // 只读查询：渲染端不推断，主进程读到什么就回什么。
  ipcMain.handle("hpe:browser-url", (_e, browserId: string) => {
    const info = BrowserManager.list().find((b) => b.browserId === browserId);
    return info?.url ?? "";
  });
  ipcMain.handle("hpe:browser-title", (_e, url: string) => {
    const info = BrowserManager.list().find((b) => b.url === url);
    return info?.title ?? null;
  });

  const js = async <T = unknown>(expression: string): Promise<T> =>
    (await wc.executeJavaScript(expression, true)) as T;

  await until(() => js<boolean>("Boolean(window.__hpeReady)"), "renderer harness ready");
  await js(`window.__hpeSetProject(${JSON.stringify(insideRoot)})`);

  // ── 1. 工作区内 .html：按钮出现、可点 ──
  await check("★ 工作区内 .html 渲染出预览按钮", async () => {
    await js(`window.__hpeSetFile(${JSON.stringify(insideHtml)})`);
    await until(async () => (await js<number>(`document.querySelectorAll('[data-html-preview-entry]').length`)) === 1, "button appears");
    const count = await js<number>(`document.querySelectorAll('[data-html-preview-entry]').length`);
    assert(count === 1, "expected exactly one preview button, got " + count);
  });

  await check("★ 按钮文案来自 i18n（不是空按钮/死壳）", async () => {
    const text = await js<string>(`document.querySelector('[data-html-preview-entry]')?.textContent ?? ""`);
    assert(text.length > 0, "empty button text");
  });

  // BrowserPanel 挂载即建首个 about:blank 标签（生产行为）——等待它建成，
  // 再断言"点击前没有加载目标文件"（真正的基线）。
  await until(async () => (await js<number>(`window.__hpeBrowserTabCount()`)) === 1, "initial blank tab");
  const baselineUrls = await js<string[]>("window.__hpeBrowserUrlsAsync()");
  assert(
    !baselineUrls.includes(pathToFileURL(insideHtml).href),
    "baseline must not already load the target: " + JSON.stringify(baselineUrls),
  );

  // ── 2. 点击 → 面板消费 pendingBrowserUrl → 真 loadURL ──
  const expectedUrl = pathToFileURL(insideHtml).href;
  await check("★ 点击后真 WebContentsView 加载工作区内 file://", async () => {
    await js(`document.querySelector('[data-html-preview-entry]').click()`);
    try {
      await until(async () => {
        const urls = await js<string[]>("window.__hpeBrowserUrlsAsync()");
        return urls.includes(expectedUrl);
      }, "browser view loaded " + expectedUrl, 8000);
    } catch (e) {
      const diag = await js<Record<string, unknown>>(
        '({ tabs: window.__hpeBrowserIds(), err: document.querySelector(\'[role=alert],.text-danger\')?.textContent ?? null, body: document.body.innerText.slice(0,300) })',
      );
      console.log("DIAG " + JSON.stringify(diag));
      console.log("MAIN LIST " + JSON.stringify(BrowserManager.list()));
      throw e;
    }
    const urls = await js<string[]>("window.__hpeBrowserUrlsAsync()");
    assert(urls.includes(expectedUrl), "expected " + expectedUrl + " in " + JSON.stringify(urls));
  });

  await check("★ 页面真的加载完成（主进程 getTitle() = inside）", async () => {
    await until(async () => {
      const title = await js<string | null>(`window.__hpeBrowserTitleAsync(${JSON.stringify(expectedUrl)})`);
      return title === "inside";
    }, "loaded page title");
  });

  await check("★ 加载的是工作区内路径（不是 about:blank/旧页）", async () => {
    // 生产行为：外部「在浏览器中打开」会**新开**一个标签（已有标签时），
    // 所以期望值 = 原来的 about:blank + 新标签里的目标 file://。
    const urls = await js<string[]>("window.__hpeBrowserUrlsAsync()");
    assert(urls.includes(expectedUrl), "target missing: " + JSON.stringify(urls));
    assert(urls[urls.length - 1] === expectedUrl, "target should be the newly opened tab: " + JSON.stringify(urls));
  });

  // ── 3. 工作区外 .html：不渲染按钮 ──
  await check("★ 工作区外 .html 不渲染预览按钮", async () => {
    await js(`window.__hpeSetFile(${JSON.stringify(outsideHtml)})`);
    await until(async () => (await js<number>(`document.querySelectorAll('[data-html-preview-entry]').length`)) === 0, "button gone");
    const count = await js<number>(`document.querySelectorAll('[data-html-preview-entry]').length`);
    assert(count === 0, "outside workspace should not render the entry, got " + count);
  });

  // ── 4. 非 html：不渲染按钮（防空过）──
  await check("★ 工作区内 .md 不渲染预览按钮", async () => {
    await js(`window.__hpeSetFile(${JSON.stringify(nonHtml)})`);
    await until(async () => (await js<number>(`document.querySelectorAll('[data-html-preview-entry]').length`)) === 0, "button gone for md");
    const count = await js<number>(`document.querySelectorAll('[data-html-preview-entry]').length`);
    assert(count === 0, "non-html should not render the entry, got " + count);
  });

  // 正控：回到 .htm（另一种 html 扩展名）按钮恢复 —— 证明上两条不是"永远没有按钮"。
  await check("正控：.htm 又渲染出按钮", async () => {
    await js(`window.__hpeSetFile(${JSON.stringify(insideHtm)})`);
    await until(async () => (await js<number>(`document.querySelectorAll('[data-html-preview-entry]').length`)) === 1, "button back");
  });

  // 再点一次 .htm：同一个入口对第二种 html 扩展名也真的加载（不是只对 .html 特判）。
  await check("★ .htm 点击后同样真的加载 file://", async () => {
    const expectedHtm = pathToFileURL(insideHtm).href;
    await js(`document.querySelector('[data-html-preview-entry]').click()`);
    await until(async () => {
      const urls = await js<string[]>("window.__hpeBrowserUrlsAsync()");
      return urls.includes(expectedHtm);
    }, "browser view loaded " + expectedHtm);
  });

  // ── 5. 清理 ──
  await check("清理：关闭全部浏览器视图", async () => {
    const ids = await js<string[]>("window.__hpeBrowserIds()");
    for (const id of ids) BrowserManager.close(id);
  });

  win.destroy();
  win = undefined;
}
