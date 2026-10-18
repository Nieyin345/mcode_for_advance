/**
 * 【ARC-007】真 Electron：**真实 vendor 编辑器页 + 生产最小 preload** 的挂载探针。
 *
 * ## 为什么需要这一套（与 document-view-electron-smoke 的分工）
 *
 * 那套用自造最小页验宿主 ⇄ 页面的通道；它明说「不加载 genoffice 真实编辑器」。
 * 于是「真实编辑器页在最小 preload 下到底能不能挂」一直是推断。实测定论：
 * 缺任何一个首帧方法，vendor `App.tsx` 的挂载 effect 抛 `TypeError`，React 19
 * 没有错误边界，`#root` 整树清空（白屏）。本套件把「补齐后能挂载」变成回归网。
 *
 * 同一份 harness 依次跑 **docs 与 slides 两个真实页面**（两次独立窗口）：
 *  - docs 读 `window.desktop`（`apps/docs/src/preload/index.ts`）；
 *  - slides 读 `window.slidesApi`（`apps/slides/src/preload/index.ts:485`）——
 *    两个命名空间不同，缺任一都会白屏。
 *
 * ## 断言（checks.json）
 *
 * 每个页面各 5 条：
 *   1. ★ 真实页 `#root` 非空（React 真挂载，没有整树卸载）；
 *   2. ★ 可见文本长度 > 0；
 *   3. ★ 出现编辑器特征（docs: `.app`/`.ribbon`/`.ProseMirror`/`.doc-page`；
 *      slides: `.app`/`.ribbon`/`canvas`/`.konvajs-content`/缩略图任一）；
 *   4. ★ 首帧零未捕获异常（CDP `Runtime.exceptionThrown` + 页面 error 钩子都为空）；
 *   5. ★ preload 仍未暴露 ipcRenderer / 文件对话框（源码级，防补桩越界）。
 *
 * ## 已知边界（如实）
 *
 *  - CDP 的 `Runtime.enable` 在本环境偶尔 8 秒超时（探针历史可见），但
 *    `Runtime.exceptionThrown` 事件照常到达；页面内的 error/unhandledrejection
 *    钩子经 `executeJavaScript` 在 dom-ready 后注入，作为第二证据源。
 *  - 页面完全离屏（隐藏窗口 + `backgroundThrottling:false`），只验挂载与首帧
 *    异常，不验像素级布局（截图仍落盘供人工看）。
 *  - slides 的 `newBlank` 桩返回**诚实空 deck**（一页 16:9 空白，与 vendor
 *    `createBlankPptx()` 同尺寸）；套件认「画布/缩略图出现」而非「有用户内容」。
 *  - 不联网：页面是本地 `file://` 产物。
 */
import { BrowserWindow, ipcMain } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  error?: string;
  detail?: unknown;
}

interface PageConfig {
  pagePath: string;
  preloadPath: string;
  waitMs: number;
  urlSuffix: string;
}

interface Config {
  pages: PageConfig[];
}

type PageKind = "docs" | "slides";

/** 按页面文件路径判断是哪一家（`genoffice/apps/{docs,slides}`）。 */
function kindOf(pagePath: string): PageKind {
  return /[\\/]slides[\\/]/.test(pagePath) ? "slides" : "docs";
}

const MARKERS: Record<PageKind, Record<string, string>> = {
  docs: {
    app: ".app",
    ribbon: ".ribbon",
    proseMirror: ".ProseMirror",
    docPage: ".doc-page",
  },
  slides: {
    app: ".app",
    ribbon: ".ribbon",
    canvas: "canvas",
    konva: ".konvajs-content",
    thumbnails: ".thumbnails, .thumb-pane, .slide-thumbs, [class*=\"thumb\"]",
  },
};

export async function runVendorPageProbe(dir: string): Promise<void> {
  const rawConfig = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as
    | Config
    | PageConfig;
  // 兼容单页配置（旧形态）与多页配置。
  const pages: PageConfig[] = "pages" in rawConfig ? rawConfig.pages : [rawConfig];
  const checksPath = join(dir, "checks.json");
  const checks: Check[] = [];

  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
      console.log("PASS VENDOR-PAGE " + name);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: String(error) });
      console.error("FAIL VENDOR-PAGE " + name + " :: " + String(error));
    } finally {
      await writeFile(checksPath, JSON.stringify(checks, null, 2));
    }
  }
  const assert = (cond: unknown, message: string): void => {
    if (!cond) throw new Error(message);
  };

  // 宿主对视图注册的内部通道（ipc/documentView.ts）。本探针不起宿主，但保留
  // 同名 handler，复刻「preload 的 invoke 有对端」这一层。
  ipcMain.handle("mcode:document-view:open-path", () => ({ ok: false, error: "probe: 不打开文件" }));
  ipcMain.handle("mcode:document-view:save", () => ({ ok: false, error: "probe: 不保存" }));

  const pageEvidence: Array<Record<string, unknown>> = [];

  try {
    for (const config of pages) {
      const kind = kindOf(config.pagePath);
      const label = kind === "slides" ? "slides" : "docs";
      const exceptions: string[] = [];
      const pageErrors: Array<{ type: string; message: string }> = [];
      const url = pathToFileURL(config.pagePath).toString() + config.urlSuffix;

      const win = new BrowserWindow({
        width: 1280,
        height: 900,
        show: false,
        webPreferences: {
          // 与 documentViewHost.ts 的视图三项安全开关逐字一致 + preload 只挂最小桥。
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
          preload: config.preloadPath,
        },
      });
      const wc = win.webContents;
      wc.setWindowOpenHandler?.(() => ({ action: "deny" }));

      let debuggerAttached = false;
      try {
        wc.debugger.attach("1.3");
        debuggerAttached = true;
      } catch {
        /* 没有 CDP 时靠页面内钩子（下面会注入） */
      }
      if (debuggerAttached) {
        wc.debugger.on("message", (_event, method, params) => {
          if (method !== "Runtime.exceptionThrown") return;
          const p = params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
          const text =
            p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "unknown exception";
          exceptions.push(text.split("\n")[0]);
        });
        // 每条命令独立、非致命：实测 Runtime.enable 偶尔挂到超时，但异常事件照常到达。
        void Promise.allSettled([
          wc.debugger.sendCommand("Runtime.enable"),
          wc.debugger.sendCommand("Page.enable"),
        ]);
      }

      // 页面内第二证据源：模块脚本执行后立刻注册；dom-ready 后再补一次。
      const hookSource = `
        if (!window.__gvpErrHook) {
          window.__gvpErrHook = true;
          window.__gvpErr = [];
          window.addEventListener('error', (e) => {
            window.__gvpErr.push({ type: 'error', message: String(e.message || (e.error && e.error.message) || '') });
          });
          window.addEventListener('unhandledrejection', (e) => {
            const r = e.reason;
            window.__gvpErr.push({ type: 'unhandledrejection', message: String((r && r.message) || r || '') });
          });
        }
      `;
      wc.once("dom-ready", () => {
        void wc.executeJavaScript(hookSource, true).catch(() => {});
      });

      const markerChecks = MARKERS[kind];
      const markerExpr = Object.entries(markerChecks)
        .map(([key, selector]) => `${key}: !!q(${JSON.stringify(selector)})`)
        .join(",\n            ");

      try {
        await wc.loadURL(url);
        await delay(config.waitMs);
        try {
          await wc.executeJavaScript(hookSource, true);
        } catch {
          /* 页面已销毁等；沿用 CDP 证据 */
        }
        const summary = (await wc.executeJavaScript(
          `(() => {
            const root = document.getElementById('root');
            const q = (s) => document.querySelector(s);
            return {
              readyState: document.readyState,
              bodyTextLen: document.body ? document.body.innerText.length : -1,
              bodyTextSample: document.body ? document.body.innerText.slice(0, 300) : '',
              rootExists: !!root,
              rootChildCount: root ? root.childElementCount : -1,
              markers: {
                ${markerExpr}
              },
              desktopKeys: Object.keys(window.desktop ?? {}),
              slidesApiKeys: window.slidesApi ? Object.keys(window.slidesApi) : [],
              pageErrors: Array.isArray(window.__gvpErr) ? window.__gvpErr.slice(0, 20) : [],
            };
          })()`,
          true,
        )) as {
          readyState: string;
          bodyTextLen: number;
          bodyTextSample: string;
          rootExists: boolean;
          rootChildCount: number;
          markers: Record<string, boolean>;
          desktopKeys: string[];
          slidesApiKeys: string[];
          pageErrors: Array<{ type: string; message: string }>;
        };
        pageErrors.push(...summary.pageErrors);
        pageEvidence.push({ kind, url, ...summary, exceptions: exceptions.slice(), debuggerAttached });

        const markerNames = Object.keys(markerChecks).join("/");
        await check(`${label}: 真实页 #root 非空（React 真挂载，没有整树卸载）`, () => {
          assert(summary.rootExists, "#root 不存在");
          assert(summary.rootChildCount > 0, `#root 子节点为 ${summary.rootChildCount}`);
        });
        await check(`${label}: 可见文本长度 > 0`, () => {
          assert(summary.bodyTextLen > 0, `body.innerText 长度 ${summary.bodyTextLen}`);
        });
        await check(`${label}: 出现编辑器特征（${markerNames} 任一）`, () => {
          const hit = Object.entries(summary.markers).filter(([, v]) => v).map(([k]) => k);
          assert(hit.length > 0, `编辑器特征一个都没有: ${JSON.stringify(summary.markers)}`);
          checks[checks.length - 1].detail = { markers: summary.markers, bodyTextSample: summary.bodyTextSample };
        });
        await check(`${label}: 首帧零未捕获异常（CDP + 页面钩子）`, () => {
          assert(
            exceptions.length === 0 && pageErrors.length === 0,
            `CDP 异常 ${exceptions.length} 条 / 页面钩子 ${pageErrors.length} 条: ${JSON.stringify([
              ...exceptions.slice(0, 3),
              ...pageErrors.slice(0, 3),
            ])}`,
          );
        });
      } finally {
        if (debuggerAttached) {
          try {
            wc.debugger.detach();
          } catch {
            /* 已分离 */
          }
        }
        if (!win.isDestroyed()) win.destroy();
      }
    }
  } finally {
    ipcMain.removeHandler("mcode:document-view:open-path");
    ipcMain.removeHandler("mcode:document-view:save");
    await writeFile(
      join(dir, "evidence.json"),
      JSON.stringify({ pages: pageEvidence, checks }, null, 2),
    );
  }

  // 源码级安全断言：补桩不得越界。放在窗口销毁之后 —— 它不需要页面。
  await check("★ preload 仍未暴露 ipcRenderer / 文件对话框（源码级，docs 与 slides 两个命名空间）", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(join(process.cwd(), "src/main/document/documentViewPreload.ts"), "utf8");
    // 去注释后再查 —— 文件头会**点名**这些能力来说明"不提供"，不能把说明当实现。
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    // 只允许两个 invoke 通道（打开/保存），不暴露任意 IPC。
    const invokeCount = (src.match(/ipcRenderer\.invoke\(/g) ?? []).length;
    assert(invokeCount === 2, `ipcRenderer.invoke 出现 ${invokeCount} 次（应恰好打开/保存两条）`);
    assert(!/exposeInMainWorld\(\s*["'](ipcRenderer|require|process)["']/.test(src), "禁止暴露 ipcRenderer/require/process");
    // 对象字面量里的属性键（`name:` 或 `name(`，行首缩进）—— 注释已剥掉，命中即真实暴露。
    const propertyNames = ["openDocx", "openDocxDecrypt", "setDocPassword", "pickAttachments", "pickImage", "kbList", "aiStream", "setAiSettings", "ipcRenderer", "openPptx", "pickPictureFile", "fontInstallLocal", "fontDownload"];
    for (const name of propertyNames) {
      const re = new RegExp(`^\\s*${name}\\s*[:(]`, "m");
      assert(!re.test(src), `preload 不得提供 ${name}`);
    }
    // 打开/保存之外不得再出现第三个 ipcRenderer 用法（on 只允许 menu:command 订阅）。
    const onCount = (src.match(/ipcRenderer\.on\(/g) ?? []).length;
    assert(onCount === 1, `ipcRenderer.on 出现 ${onCount} 次（只允许 menu:command 一条）`);
    // 两个命名空间都必须暴露（docs 读 desktop、slides 读 slidesApi）。
    assert(/exposeInMainWorld\(\s*"desktop"/.test(src), "缺少 window.desktop 暴露");
    assert(/exposeInMainWorld\(\s*"slidesApi"/.test(src), "缺少 window.slidesApi 暴露（slides 页会白屏）");
  });
}
