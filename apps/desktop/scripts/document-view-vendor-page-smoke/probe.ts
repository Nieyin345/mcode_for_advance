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
  // 【ARC-007 P0】挂载期页面会调 `getRecentFiles()`（preload 借它回执
  // `open-committed`），以及打开流程里的 read-opened/confirm-replace。
  // 本探针不起宿主，但必须给 invoke 一个对端，否则 unhandled rejection 会被
  // 「首帧零未捕获异常」如实抓住。
  ipcMain.handle("mcode:document-view:read-opened", () => ({ ok: false, reason: "probe: 不打开文件" }));
  ipcMain.handle("mcode:document-view:open-committed", () => ({ ok: true }));
  ipcMain.handle("mcode:document-view:confirm-replace", () => false);

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
    ipcMain.removeHandler("mcode:document-view:read-opened");
    ipcMain.removeHandler("mcode:document-view:open-committed");
    ipcMain.removeHandler("mcode:document-view:confirm-replace");
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

    /**
     * 【ARC-007 复审】IPC 白名单，不是写死的条数。
     *
     * 从前这里断言「`ipcRenderer.invoke` 恰好出现 2 次」—— 合法的第三条
     * `saveDocxNew` 一进来就红，而它并不是"页面拿到了裸 ipcRenderer"。复审要求：
     *
     *   1. 实际 invoke 用到的 **channel 标识符集合 ⊆ 白名单**（新增不在名单里的
     *      调用 = 红）；
     *   2. 白名单**每条都必须至少出现一次**（删掉一条实现 = 红，防空过）；
     *   3. channel 标识符必须**先声明成字符串常量**（下面解析它的值），所以
     *      "绕过常量直接 invoke 页面给的字符串" 会因为不是标识符而红。
     *
     * 白名单的语义（不是"允许任意 IPC"）：
     *  - 两条**页面 → 宿主**的写入/读请求：`open-path`、`save`；
     *  - 两条 slides 编辑（A 方案第一步）：`slides-add-slide`、`slides-edit-text`。
     *  四条都是**内部通道**：只能被本 preload 调用，不进 `RpcMap` 的 renderer 面，
     *  页面拿不到 `ipcRenderer` 本身。白名单是**通道级**授权，不是数量授权。
     */
    const ALLOWED_INVOKE_CHANNELS = new Set([
      // `mcode:document-view:open-path` **不在**白名单里：P0 起页面不再向它
      // invoke（那是回环的根源），打开只经 read-opened 拉取 + open-committed 回执。
      "mcode:document-view:save",
      "mcode:document-view:slides-add-slide",
      "mcode:document-view:slides-edit-text",
      // 【ARC-007 P1/GA1】slides 打开/保存链：页面拉取 OpenResult（openPptxPath/
      // consumePendingOpen）与保存（save()）都只经这两条内部通道。
      "mcode:document-view:slides-read-opened",
      "mcode:document-view:slides-save",
      // 【ARC-007 P0】打开链：页面只**拉取**宿主已准备的响应；回执与替换守卫
      // 是两条独立内部通道（不再反向触发 open-path）。
      "mcode:document-view:read-opened",
      "mcode:document-view:open-committed",
      "mcode:document-view:confirm-replace",
    ]);

    // 解析本文件里的字符串常量声明：`const NAME = "...";`（含 `as const` 后缀）。
    const constants = new Map<string, string>();
    for (const m of src.matchAll(/(?:^|\n)\s*const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g)) {
      constants.set(m[1], m[2]);
    }

    // 每一条 `ipcRenderer.invoke(<第一个实参>` 的实参。
    const invokeArgs = [...src.matchAll(/ipcRenderer\.invoke\(\s*([^,)]+)/g)].map((m) => m[1].trim());
    const usedChannels: string[] = [];
    const unresolved: string[] = [];
    for (const arg of invokeArgs) {
      if (/^[A-Z][A-Z0-9_]*$/.test(arg)) {
        const value = constants.get(arg);
        if (value !== undefined) usedChannels.push(value);
        else unresolved.push(arg);
      } else {
        // 字面量 / 表达式 / 页面变量一律不接受：通道必须来自本文件常量。
        unresolved.push(arg);
      }
    }
    assert(
      unresolved.length === 0,
      `invoke 的 channel 必须来自本文件的字符串常量（找不到：${JSON.stringify(unresolved)}）`,
    );
    const outsideWhitelist = usedChannels.filter((c) => !ALLOWED_INVOKE_CHANNELS.has(c));
    assert(
      outsideWhitelist.length === 0,
      `invoke 了白名单之外的通道：${JSON.stringify(outsideWhitelist)}（白名单：${JSON.stringify([...ALLOWED_INVOKE_CHANNELS])}）`,
    );
    const unusedWhitelist = [...ALLOWED_INVOKE_CHANNELS].filter((c) => !usedChannels.includes(c));
    assert(
      unusedWhitelist.length === 0,
      `白名单里这些通道在 preload 里不存在（删实现或常量漏了）：${JSON.stringify(unusedWhitelist)}`,
    );

    assert(!/exposeInMainWorld\(\s*["'](ipcRenderer|require|process)["']/.test(src), "禁止暴露 ipcRenderer/require/process");
    // 对象字面量里的属性键（`name:` 或 `name(`，行首缩进）—— 注释已剥掉，命中即真实暴露。
    const propertyNames = ["openDocx", "openDocxDecrypt", "setDocPassword", "pickAttachments", "pickImage", "kbList", "aiStream", "setAiSettings", "ipcRenderer", "openPptx", "pickPictureFile", "fontInstallLocal", "fontDownload"];
    for (const name of propertyNames) {
      const re = new RegExp(`^\\s*${name}\\s*[:(]`, "m");
      assert(!re.test(src), `preload 不得提供 ${name}`);
    }
    // 订阅口白名单：menu:command（宿主推送）+ close-check（P0 的 dirty 查询，
    // 页面经 reportCloseCheck 回答）。任何其它 on 都是新增能力面。
    const ALLOWED_ON_CHANNELS = new Set(["menu:command", "mcode:document-view:close-check", "slides:opened"]);
    const onArgs = [...src.matchAll(/ipcRenderer\.on\(\s*([^,)]+)/g)].map((m) => m[1].trim());
    const onResolved = onArgs.map((a) => {
      const literal = /^"([^"]+)"$/.exec(a);
      return literal ? literal[1] : (constants.get(a) ?? a);
    });
    assert(
      onResolved.every((c) => ALLOWED_ON_CHANNELS.has(c)) &&
        [...ALLOWED_ON_CHANNELS].every((c) => onResolved.includes(c)),
      `ipcRenderer.on 只允许 ${JSON.stringify([...ALLOWED_ON_CHANNELS])}，实际：${JSON.stringify(onResolved)}`,
    );
    // 两个命名空间都必须暴露（docs 读 desktop、slides 读 slidesApi）。
    assert(/exposeInMainWorld\(\s*"desktop"/.test(src), "缺少 window.desktop 暴露");
    assert(/exposeInMainWorld\(\s*"slidesApi"/.test(src), "缺少 window.slidesApi 暴露（slides 页会白屏）");
  });
}
