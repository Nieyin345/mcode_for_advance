/**
 * T8 —— 旅程注册表 + 宿主生命周期钩子。
 *
 * ## ⚠️ 这个模块被两种进程加载
 *
 *  1. `build.mjs`（普通 Node）在 spawn Electron 之前读旅程名列表；
 *  2. `electron-host.cjs`（真 Electron）在 ready 前 require 它执行 `beforeReady()`，
 *     ready 后读 `journeys`。
 *
 * 因此**顶层不 import 任何会 `import "electron"` 的模块** —— 旅程与装配全部惰性
 * `require()`（esbuild 的 CJS 产物保留成运行期 require）。本套件没有特权 scheme
 * 需要注册（Node-RED 编辑器是普通回环 http 页面），所以 `beforeReady` 不需要
 * （省略；`electron-host.cjs` 只在它存在时调用）。
 */
interface LazyJourney {
  readonly name: string;
  readonly launch: unknown;
  readonly steps: unknown[];
  readonly expect: "pass" | "fail";
  /** 故意失败旅程必须带这一项（T16 的 `classifyJourney` 只认它判「失败形态是否符合预期」）。 */
  readonly failBecause?: (evidence: Array<{ status: string; step: string }>) => boolean;
}

const loaders: Record<string, () => { default: unknown }> = {
  "node-red-canvas-load-edit-deploy-reopen": () => require("./node-red-canvas-load-edit-deploy-reopen.js") as { default: unknown },
  "node-red-deliberate-failure": () => require("./node-red-deliberate-failure.js") as { default: unknown },
};

/** 旅程名列表（不触发任何模块加载）。 */
export const journeyNames = Object.keys(loaders);

export const journeys: LazyJourney[] = journeyNames.map((name) => {
  let materialized: LazyJourney | null = null;
  const materialize = (): LazyJourney => {
    if (materialized === null) {
      const mod = loaders[name]!();
      const exported = (mod as { [k: string]: unknown }).default ?? Object.values(mod)[0];
      if (!exported || typeof exported !== "object") throw new Error(`T8: ${name} 没有导出旅程对象`);
      materialized = exported as LazyJourney;
      if (materialized.name !== name) throw new Error(`T8: ${name} 模块导出的旅程名是 ${materialized.name}（不一致）`);
    }
    return materialized;
  };
  return {
    get name() { return name; },
    get launch() { return materialize().launch; },
    get steps() { return materialize().steps; },
    get expect() { return materialize().expect; },
    // 惰性壳必须把 `failBecause` 一起透出：`classifyJourney` 读的是 journey 对象本身，
    // 只给 name/steps/launch 会让「故意失败」被判成「缺少 failBecause」。
    get failBecause() { return materialize().failBecause; },
  } as LazyJourney;
});
