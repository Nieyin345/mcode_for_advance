/**
 * O4 —— 旅程注册表（`electron-u1/build.mjs --registry=`）。
 *
 * 与 T7 / T29 同一条惰性纪律：本模块会被**普通 Node**（`build.mjs` 读旅程名）与
 * **真 Electron**（`electron-host.cjs` 执行前 require）两种进程加载，所以顶层
 * 不 import 任何碰 electron / vendor 的模块 —— 旅程模块在 getter 里才 require。
 */
import type { U1Journey } from "../../electron-u1/driver/index.js";

export const journeyNames = ["o4-docs-close-production-path"] as const;

interface LazyJourney {
  readonly name: string;
  readonly launch: unknown;
  readonly steps: unknown[];
  readonly expect: "pass";
}

export const journeys: LazyJourney[] = journeyNames.map((name) => {
  let materialized: U1Journey | null = null;
  const materialize = (): U1Journey => {
    if (materialized === null) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./o4-docs-close.js") as { o4Journeys: U1Journey[] };
      const found = mod.o4Journeys.find((journey) => journey.name === name);
      if (!found) throw new Error(`O4: journeys 模块里没有 ${name}`);
      materialized = found;
    }
    return materialized;
  };
  return {
    get name() { return name; },
    get launch() { return materialize().launch; },
    get steps() { return materialize().steps; },
    get expect() { return "pass" as const; },
  };
});

/**
 * ready 之前的特权注册 —— 与生产 `main/index.ts` 顶层**同一个函数、同一处调用**
 * （`registerGenofficeNativeScheme()` 一次注册三个 scheme）。
 */
export function beforeReady(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factories = require("../../../src/main/document/genofficeViewFactories.js") as typeof import("../../../src/main/document/genofficeViewFactories.js");
  factories.registerGenofficeNativeScheme();
}

/** ready 之后：`genoffice-app://` 请求处理器（惰性 require，同 beforeReady）。 */
export function afterReady(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factories = require("../../../src/main/document/genofficeViewFactories.js") as typeof import("../../../src/main/document/genofficeViewFactories.js");
  factories.installGenofficeNativeProtocol();
}
