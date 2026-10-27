/**
 * W26 —— 旅程注册表。
 *
 * ## ⚠️ 这个模块被两种进程加载（与 T7/T8 同一约束）
 *
 *  1. `electron-u1/build.mjs`（普通 Node）在 spawn Electron 之前读 `journeys[i].name`；
 *  2. `electron-host.cjs`（真 Electron）在 `app.whenReady()` 之后读 `journeys`。
 *
 * 所以顶层**不 import 任何会 `import "electron"` 的模块** —— 旅程文件（它 import
 * `../harness.js` → 生产主进程模块）一律惰性 `require()`。
 *
 * ## ⚠️ 必须透出 `failBecause`（W24 在 `t30` 上修过的同一处坑）
 *
 * `driver/verdict.ts` 的 `classifyJourney` 读的是**旅程对象本身**的
 * `failBecause`。惰性壳如果只给 `name` / `steps` / `launch`，一条 `expect:"fail"`
 * 的旅程会被判成「缺少 failBecause」→ `unexpected-failure`。本套件当前没有
 * 故意失败旅程，但这个坑是**同一个文件形状**带来的：将来有人加一条时不加这一行
 * 就会踩（W24 的注释写在 `t8-node-red-u1/journeys/index.ts:53-55`）。
 */
interface LazyJourney {
  readonly name: string;
  readonly launch: unknown;
  readonly steps: unknown[];
  readonly expect: "pass" | "fail";
  /** 故意失败旅程必须带这一项（`classifyJourney` 只认它判「失败形态是否符合预期」）。 */
  readonly failBecause?: (evidence: Array<{ status: string; step: string }>) => boolean;
}

const loaders: Record<string, () => { default: unknown }> = {
  // 主旅程：「设置 → 工作流 → 默认页签 → 启动 → 画布真的显示」（W26 本卡）。
  "settings-workflow-canvas-visible": () => require("./settings-workflow-canvas-visible.js") as { default: unknown },
};

/** 旅程名列表（不触发任何模块加载）。 */
export const journeyNames = Object.keys(loaders);

/**
 * `electron-host.cjs` 在 `app.whenReady()` **之前**（模块顶层，`setPath` 与
 * `data-root.json` 写完之后）同步调用这里 —— 全部 IPC handler / 引擎注册表必须
 * 此时就位，否则渲染端首屏水合（`sessionStore.init()`）会打在空 handler 表上。
 * 理由见 `../harness.ts` 的 `prepareEnvironment` 文件头。
 *
 * 为什么是 `beforeReady` 而不是 `afterReady`：`build.mjs` 的 runner 在
 * `app.whenReady()` 之后**立刻** `createWindow`（页面开始加载），而 `afterReady`
 * 与 `runGeneration` 在同一个 tick 里串行 —— handler 注册的先后取决于 await 点，
 * 不可靠。`beforeReady` 在建窗口之前是**同步确定**的。
 *
 * 惰性 require：`harness.js` import 生产主进程模块，顶层加载会拖进 electron。
 */
export function beforeReady(): void {
  const { prepareEnvironment } = require("../harness.js") as typeof import("../harness.js");
  prepareEnvironment({ repoRoot: process.env.MCODE_U1_REPO ?? "" });
}

export const journeys: LazyJourney[] = journeyNames.map((name) => {
  let materialized: LazyJourney | null = null;
  const materialize = (): LazyJourney => {
    if (materialized === null) {
      const mod = loaders[name]!();
      const exported = (mod as { [k: string]: unknown }).default ?? Object.values(mod)[0];
      if (!exported || typeof exported !== "object") throw new Error(`W26: ${name} 没有导出旅程对象`);
      materialized = exported as LazyJourney;
      if (materialized.name !== name) throw new Error(`W26: ${name} 模块导出的旅程名是 ${materialized.name}（不一致）`);
    }
    return materialized;
  };
  return {
    get name() { return name; },
    get launch() { return materialize().launch; },
    get steps() { return materialize().steps; },
    get expect() { return materialize().expect; },
    // 惰性壳必须把 `failBecause` 一起透出（见文件头）。
    get failBecause() { return materialize().failBecause; },
  } as LazyJourney;
});
