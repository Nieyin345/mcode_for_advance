/**
 * O2 —— 旅程注册表（`electron-u1/build.mjs --registry=`）。
 *
 * ## 两种进程都会加载本模块
 *
 *  1. `build.mjs`（普通 Node）在 spawn Electron **之前**只读 `journeyNames` 与
 *     `journeys[i].name` —— 所以顶层**不 import** 任何会拉进 `electron` 的模块；
 *  2. `electron-host.cjs`（真 Electron）在 `app.whenReady()` 之前 require 本模块
 *     执行 `beforeReady()`，ready 之后读 `journeys`。
 *
 * 旅程模块（`journeys.ts` → t7 `editor-flow` → harness → vendor 主进程）因此
 * **惰性** require。
 *
 * ## ⚠️ `beforeReady` 里的顺序就是判据
 *
 * `DocumentsViewHost` 单例的构造器里直接 `registerDocsIpc(...)`（它把 docs 的
 * vendor IPC 注册进 Electron）。而单例的构造发生在 `genofficeViewFactories`
 * 被 require 的那一刻（import 链 → `genofficeNativeVendor` → `documentViewHost`）。
 * 所以必须**先装保存通道记录器、后 require 工厂** —— 反过来，docs 的保存通道
 * 就不是通过记录器注册的，`4a` 的证据会从「主进程回包」退化成「页面看到了什么」。
 */

/** 六个格式的旅程名（与 `journeys.ts` 的 `o2Journeys` 一一对应；不触发加载）。 */
export const journeyNames = ["docs", "sheets", "slides", "pdf", "markdown", "html"].map(
  (kind) => `o2-conflict-${kind}`,
);

interface LazyJourney {
  readonly name: string;
  readonly launch: unknown;
  readonly steps: unknown[];
  readonly expect: "pass" | "fail";
  /** `expect:"fail"` 的旅程必须带它，否则 verdict 判成「缺少 failBecause」。
   *  惰性包装必须**转发**它 —— 第一版漏了，markdown 的真实预期红被读成
   *  「unexpected-failure: expect:"fail" 缺少 failBecause」。 */
  readonly failBecause?: (evidence: unknown[]) => boolean;
}

let materialized: Map<string, LazyJourney> | null = null;

function materialize(): Map<string, LazyJourney> {
  if (materialized === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../journeys.js") as { o2Journeys: Array<{ name: string; expect?: string }> };
    const table = new Map<string, LazyJourney>();
    for (const journey of mod.o2Journeys) {
      table.set(journey.name, journey as unknown as LazyJourney);
    }
    materialized = table;
  }
  return materialized;
}

/**
 * ⚠️ `expect` **不能**走 `materialize()`。
 *
 * `build.mjs`（**普通 Node**，不是 Electron）在 spawn 之前会读 `journey.expect`
 * 做日志/分类。若这个 getter 触发 `require("../journeys.js")`，整条 harness →
 * `genofficeViewFactories` → `documentViewHost` 会在普通 Node 里被加载 —— 那里
 * `require("electron")` 返回的是可执行文件路径字符串，宿主的构造器拿
 * `undefined.ipcMain` 注册 docs IPC，vendor sheets 的 Proxy 直接抛
 * `Cannot create proxy with a non-object as target`，套件在第一步就崩。
 *
 * （T7/T29 的注册表把 `expect` 写成常量正是因为这个；本次第一版踩了同一个坑。）
 *
 * 所以 `expect` 从**纯表**推导：`expectations.ts` 只 import 了一个类型，
 * 运行期不拉任何 electron 模块。
 */
function expectOf(name: string): "pass" | "fail" {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EXPECTATIONS } = require("../expectations.js") as typeof import("../expectations.js");
  const kind = name.replace("o2-conflict-", "") as keyof typeof EXPECTATIONS;
  return EXPECTATIONS[kind].expectConflict ? "pass" : "fail";
}

/**
 * ⚠️ `expect` **不能**走 `materialize()`。
 *
 * `build.mjs`（**普通 Node**，不是 Electron）在 spawn 之前会读 `journey.expect`
 * 做日志/分类。若这个 getter 触发 `require("../journeys.js")`，整条 harness →
 * `genofficeViewFactories` → `documentViewHost` 会在普通 Node 里被加载 —— 那里
 * `require("electron")` 返回的是可执行文件路径字符串，宿主的构造器拿
 * `undefined.ipcMain` 注册 docs IPC（日志里的 "native Docs IPC not installed"），
 * vendor sheets 的 Proxy 直接抛 `Cannot create proxy with a non-object as target`，
 * 套件在第一步就崩（本次第一版实测）。
 *
 * 所以 `expect` 在**模块加载时**从 `expectations.ts` 一次算好写成常量 ——
 * `expectations.ts` 只 import 一个类型，运行期不拉任何 electron 模块。
 * T7/T29 的注册表把 `expect` 写成字面常量，理由与此相同。
 */
const EXPECT_BY_NAME: Record<string, "pass" | "fail"> = (() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EXPECTATIONS } = require("../expectations.js") as typeof import("../expectations.js");
  const table: Record<string, "pass" | "fail"> = {};
  for (const name of journeyNames) {
    const kind = name.replace("o2-conflict-", "") as keyof typeof EXPECTATIONS;
    table[name] = EXPECTATIONS[kind].expectConflict ? "pass" : "fail";
  }
  return table;
})();

export const journeys: LazyJourney[] = journeyNames.map((name) => ({
  get name() { return name; },
  get launch() { return materialize().get(name)!.launch; },
  get steps() { return materialize().get(name)!.steps; },
  get expect() { return EXPECT_BY_NAME[name]!; },
  get failBecause() { return materialize().get(name)!.failBecause; },
}));

/**
 * ready 之前：
 *  1. 装保存通道记录器（必须早于任何 handler 注册，见文件头）；
 *  2. 与生产 `main/index.ts` 同一处调用的特权 scheme 注册。
 */
export function beforeReady(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const recorder = require("../ipc-recorder.js") as typeof import("../ipc-recorder.js");
  recorder.installIpcRecorder();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factories = require("../../../src/main/document/genofficeViewFactories.js") as typeof import("../../../src/main/document/genofficeViewFactories.js");
  factories.registerGenofficeNativeScheme();
}

/** ready 之后：`genoffice-app://` 的请求处理器（与生产同一条）。 */
export function afterReady(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factories = require("../../../src/main/document/genofficeViewFactories.js") as typeof import("../../../src/main/document/genofficeViewFactories.js");
  factories.installGenofficeNativeProtocol();
}
