/**
 * T30 —— 旅程注册表 + 宿主生命周期钩子。
 *
 * 与 T7 的注册表同一形态：本模块会被**两种进程**加载（build.mjs 的普通 Node 与
 * electron-host.cjs 的 Electron），所以顶层**不 import 任何会 `import "electron"`
 * 的模块**；旅程一律惰性 `require()`，beforeReady/afterReady 也惰性。
 */
interface LazyJourney {
  readonly name: string;
  readonly launch: unknown;
  readonly steps: unknown[];
  readonly expect: "pass" | "fail";
  /** `expect:"fail"` 的旅程必须透出它，否则 verdict 判成「缺少 failBecause」。
   *  【W24 2026-10-25】惰性壳此前只给 name/launch/steps/expect，`deliberate-failure`
   *  的 `failBecause` 被吞掉 —— 它红在**指定步骤**上却被判 `unexpected-failure`。
   *  这个缺陷一直被假门禁盖着（旧包装器对构建失败也打印 PASS），构建修好后第一次跑
   *  才露出来。t8 / o2 的注册表都透出了这一项，同一形态（见那两处注释）。 */
  readonly failBecause?: (evidence: unknown[]) => boolean;
}

const loaders: Record<string, () => { default: unknown }> = {
  "docs-tool-roundtrip-production": () => require("./docs-tool-roundtrip-production.js") as { default: unknown },
  "docs-tool-roundtrip-wired": () => require("./docs-tool-roundtrip-wired.js") as { default: unknown },
  "sheets-tool-call": () => require("./sheets-tool-call.js") as { default: unknown },
  // 变异自检：故意失败的一条。它不是产品旅程，只是「断言判定是否真的在判」的探针。
  "deliberate-failure": () => require("./deliberate-failure.js") as { default: unknown },
};

export const journeyNames = Object.keys(loaders);

export const journeys: LazyJourney[] = journeyNames.map((name) => {
  let materialized: LazyJourney | null = null;
  const materialize = (): LazyJourney => {
    if (materialized === null) {
      const mod = loaders[name]!();
      const exported = (mod as { [k: string]: unknown }).default ?? Object.values(mod)[0];
      if (!exported || typeof exported !== "object") throw new Error(`T30: ${name} 没有导出旅程对象`);
      materialized = exported as LazyJourney;
      if (materialized.name !== name) throw new Error(`T30: ${name} 模块导出的旅程名是 ${materialized.name}`);
    }
    return materialized;
  };
  return {
    get name() { return name; },
    get launch() { return materialize().launch; },
    get steps() { return materialize().steps; },
    get expect() { return materialize().expect; },
    // 惰性壳必须把 `failBecause` 一起透出：`classifyJourney`（driver/verdict.ts）读的
    // 是 journey 对象本身，只给 name/steps/launch/expect 会让「故意失败」被判成
    // 「缺少 failBecause」→ unexpected-failure（W24 实测）。
    get failBecause() { return materialize().failBecause; },
  };
});

/** 与生产 `main/index.ts` 同一处调用（特权 scheme 注册必须在 ready 前）。 */
export function beforeReady(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factories = require("../../../src/main/document/genofficeViewFactories.js") as typeof import("../../../src/main/document/genofficeViewFactories.js");
  factories.registerGenofficeNativeScheme();
}

/** ready 之后：`genoffice-app://` 的请求处理器。 */
export function afterReady(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factories = require("../../../src/main/document/genofficeViewFactories.js") as typeof import("../../../src/main/document/genofficeViewFactories.js");
  factories.installGenofficeNativeProtocol();
}
