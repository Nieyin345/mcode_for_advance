/**
 * `@main/browser/BrowserManager.js` 的替身 —— 真的那个 `import { app, BrowserWindow,
 * safeStorage, shell, session, WebContentsView, debugger } from "electron"`,无头脚本
 * 一行都给不出来。
 *
 * ## 它替的是"被委托方",不是被测的逻辑
 *
 * `ipc/browser.ts` 里 20 条 handler 的职责只有三件:校验入参 → 委托 → 把结果/错误
 * 包成 `{ok, error?}`。中间那一步才是这个文件替掉的东西。所以这里的替身做两件事:
 *
 *  1. **记下每一次调用**(`recorded`),让断言能看"handler 到底把什么转交给了它"
 *     —— 尤其是"入参不合法时它**一次都不该**被调到";
 *  2. **让返回结果可以被指定**(`override`),让断言能看"它说不行时,handler 有没有
 *     把那句话原样交回渲染端"。
 *
 * ⚠️ **默认返回不是空实现**。每个方法都有个"诚实"的默认值(多数是 `{ok:true}`),
 * 因为它们本来就是 `BrowserOpResult`;只有那些**本套完全没覆盖到**的方法才显式抛,
 * 免得"没走到"看起来像"走过了"。
 *
 * ## 和被测代码共享同一份实例
 *
 * `--alias:@main/browser/BrowserManager.js=…` 之后,`ipc/browser.ts` 的
 * `import { BrowserManager }` 与本文件的导出解析到**同一个模块**(同一个 specifier
 * → esbuild 只打一份),所以 `recorded` 里记的就是真 handler 调的那一份。
 */
import type { BrowserOpResult, BrowserCreateResult, BrowserAuthRespondStatus } from "@contracts/ipc";

export interface RecordedCall {
  fn: string;
  args: unknown[];
}

const calls: RecordedCall[] = [];
/** 每一次进入替身的调用,按发生顺序。断言只读它。 */
export const recorded: RecordedCall[] = calls;

export function resetRecorded(): void {
  calls.length = 0;
}

export function callsTo(fn: string): RecordedCall[] {
  return calls.filter((c) => c.fn === fn);
}

export function lastCall(fn: string): RecordedCall | undefined {
  const list = callsTo(fn);
  return list[list.length - 1];
}

const overrides = new Map<string, unknown>();

/** 让某个方法下次返回指定的东西(断言"被委托方的原话有没有原样回去"用)。 */
export function override(fn: string, value: unknown): void {
  overrides.set(fn, value);
}

export function clearOverrides(): void {
  overrides.clear();
}

/* ──────────────── MC-043 跨项目隔离:可配置的活视图清单 ────────────────
 *
 * §2(书签 / IPC)根本不碰 list/snapshot/click,所以这些方法在这里是**给
 * §5(跨项目隔离)用的**。测试用 `setViews([...])` 摆两个项目各一个视图,再调
 * agentBrowserTools.ts 的真函数,看它们会不会串到别的项目。每个视图的正文
 * (`body`)就是那句 sentinel —— 断言"B 看不到 A"时看的就是它有没有漏出来。
 *
 * 每次进 `list()` / `snapshot()` / `click()` 都记为一次调用,断言据此判
 * "该不该落到某个视图上"。 */

export interface FakeView {
  browserId: string;
  projectPath: string;
  url: string;
  title: string;
  /** 快照正文的 sentinel —— 用于判"B 读到的是不是 A 的内容"。 */
  body: string;
}

let fakeViews: FakeView[] = [];
export function setViews(v: FakeView[]): void {
  fakeViews = v;
}
export function viewById(id: string): FakeView | undefined {
  return fakeViews.find((v) => v.browserId === id);
}

function rec<T>(fn: string, args: unknown[], fallback: T): T {
  calls.push({ fn, args });
  return (overrides.has(fn) ? overrides.get(fn) : fallback) as T;
}

export const BrowserManager = {
  create(projectPath: string, initialDevice?: string): BrowserCreateResult {
    return rec("create", [projectPath, initialDevice], {
      ok: true as const,
      browserId: "bw_default",
    });
  },

  list(): Array<{ browserId: string; projectPath: string; url: string; title: string }> {
    return rec(
      "list",
      [],
      fakeViews.map((v) => ({ browserId: v.browserId, projectPath: v.projectPath, url: v.url, title: v.title })),
    );
  },

  notifyAgentOpened(id: string, opts?: unknown): void {
    rec("notifyAgentOpened", [id, opts], undefined);
  },

  async snapshot(id: string): Promise<unknown> {
    const v = viewById(id);
    return rec(
      "snapshot",
      [id],
      v
        ? {
            ok: true,
            data: {
              url: v.url,
              title: v.title,
              readyState: "complete",
              html: `<body>${v.body}</body>`,
              bodyText: v.body,
              interactive: [],
            },
          }
        : { ok: false, error: `no view ${id}` },
    );
  },

  async click(id: string, selector: string): Promise<unknown> {
    const v = viewById(id);
    return rec("click", [id, selector], v ? { ok: true, url: v.url, title: v.title } : { ok: false, error: `no view ${id}` });
  },

  async clickAt(id: string, x: number, y: number): Promise<unknown> {
    const v = viewById(id);
    return rec("clickAt", [id, x, y], v ? { ok: true, url: v.url, title: v.title } : { ok: false, error: `no view ${id}` });
  },

  async type(id: string, selector: string, text: string, clear = true): Promise<unknown> {
    const v = viewById(id);
    return rec("type", [id, selector, text, clear], v ? { ok: true, url: v.url, title: v.title } : { ok: false, error: `no view ${id}` });
  },

  async sendKeys(id: string, keys: string): Promise<unknown> {
    const v = viewById(id);
    return rec("sendKeys", [id, keys], v ? { ok: true, url: v.url, title: v.title } : { ok: false, error: `no view ${id}` });
  },
  loadUrl(id: string, url: string): BrowserOpResult {
    return rec("loadUrl", [id, url], { ok: true });
  },

  goBack(id: string): BrowserOpResult {
    return rec("goBack", [id], { ok: true });
  },

  goForward(id: string): BrowserOpResult {
    return rec("goForward", [id], { ok: true });
  },

  reload(id: string): BrowserOpResult {
    return rec("reload", [id], { ok: true });
  },

  setBounds(id: string, bounds: unknown): BrowserOpResult {
    return rec("setBounds", [id, bounds], { ok: true });
  },

  async setPickMode(id: string, enabled: boolean): Promise<BrowserOpResult> {
    return rec("setPickMode", [id, enabled], { ok: true });
  },

  show(id: string): BrowserOpResult {
    return rec("show", [id], { ok: true });
  },

  hide(id: string): BrowserOpResult {
    return rec("hide", [id], { ok: true });
  },

  close(id: string): BrowserOpResult {
    return rec("close", [id], { ok: true });
  },

  async captureFrame(id: string): Promise<unknown> {
    return rec("captureFrame", [id], { ok: true, data: "cG5n", mimeType: "image/png" });
  },

  setDevice(id: string, device: string, opts: unknown): BrowserOpResult {
    return rec("setDevice", [id, device, opts], { ok: true });
  },

  async clearBrowserCache(): Promise<BrowserOpResult> {
    return rec("clearBrowserCache", [], { ok: true });
  },

  async clearBrowserCookies(): Promise<BrowserOpResult> {
    return rec("clearBrowserCookies", [], { ok: true });
  },

  vaultStatus(): unknown {
    return rec("vaultStatus", [], {
      encryptionAvailable: false,
      persistLogin: true,
      savedCount: 0,
      plaintextErased: false,
      lastError: null,
    });
  },

  respondAuth(requestId: string, username: string, password: string): BrowserAuthRespondStatus {
    return rec("respondAuth", [requestId, username, password], "accepted");
  },

  downloadAction(downloadId: string, action: string): BrowserOpResult {
    return rec("downloadAction", [downloadId, action], { ok: true });
  },
};
