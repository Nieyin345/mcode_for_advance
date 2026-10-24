/**
 * O0 —— 六条保真旅程的注册表 + 宿主生命周期钩子。
 *
 * 与 t7 / t30 的注册表同形：本模块被**两种进程**加载（build.mjs 的普通 Node
 * 与 electron-host.cjs 的 Electron），所以顶层不 import 任何会 `import
 * "electron"` 的模块；旅程一律惰性 `require()`。
 *
 * 六条旅程的名字就是红绿表的行名（`<format>-fidelity`）。
 */
interface LazyJourney {
  readonly name: string;
  readonly launch: unknown;
  readonly steps: unknown[];
  readonly expect: "pass";
}

const loaders: Record<string, () => { default: unknown }> = {
  "docx-fidelity": () => require("./docx-fidelity.js") as { default: unknown },
  "xlsx-fidelity": () => require("./xlsx-fidelity.js") as { default: unknown },
  "pptx-fidelity": () => require("./pptx-fidelity.js") as { default: unknown },
  "pdf-fidelity": () => require("./pdf-fidelity.js") as { default: unknown },
  "markdown-fidelity": () => require("./markdown-fidelity.js") as { default: unknown },
  "html-fidelity": () => require("./html-fidelity.js") as { default: unknown },
};

export const journeyNames = Object.keys(loaders);

export const journeys: LazyJourney[] = journeyNames.map((name) => {
  let materialized: LazyJourney | null = null;
  const materialize = (): LazyJourney => {
    if (materialized === null) {
      const mod = loaders[name]!();
      const exported = (mod as { [k: string]: unknown }).default ?? Object.values(mod)[0];
      if (!exported || typeof exported !== "object") throw new Error(`O0: ${name} 没有导出旅程对象`);
      materialized = exported as LazyJourney;
      if (materialized.name !== name) {
        throw new Error(`O0: ${name} 模块导出的旅程名是 ${materialized.name}（不一致）`);
      }
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
