/**
 * T7 —— 六编辑器 U1 旅程注册表 + 宿主生命周期钩子。
 *
 * ## ⚠️ 这个模块会被**两种进程**加载
 *
 *  1. `build.mjs`（普通 Node）在 spawn Electron **之前**要读旅程名列表；
 *  2. `electron-host.cjs`（真 Electron）在 `app.whenReady()` 之前 require 本模块
 *     以执行 `beforeReady()`，ready 之后读 `journeys`。
 *
 * 因此本模块**顶层不 import 任何会 `import "electron"` 的模块**：
 *  - 旅程定义（会 import `../editor-flow.js` → harness → vendor 主进程）一律**惰性**
 *    （`require()` 在 getter 里，且 esbuild 的 CJS 产物会保留成运行期 require）；
 *  - `beforeReady` / `afterReady` 也**惰性** require 两个协议模块 ——
 *    `genofficeViewFactories.ts` 顶层 `import { net, protocol } from "electron"`，
 *    在普通 Node 里直接加载会炸。
 *
 * `build.mjs` 只读 `journeyNames` 与 `journeys[i].name`（不触发任何 getter）；
 * `runner` 在真 Electron 主进程里读 `steps`/`launch`，此时 electron 可用。
 */

/** 一个惰性旅程槽：读它的属性时才 require 真正的旅程模块。 */
interface LazyJourney {
  readonly name: string;
  readonly launch: unknown;
  readonly steps: unknown[];
  readonly expect: "pass";
}

const loaders: Record<string, () => { default: unknown }> = {
  "docs-open-edit-save-reopen": () => require("./docs-open-edit-save-reopen.js") as { default: unknown },
  "sheets-open-edit-save-reopen": () => require("./sheets-open-edit-save-reopen.js") as { default: unknown },
  "slides-open-edit-save-reopen": () => require("./slides-open-edit-save-reopen.js") as { default: unknown },
  "pdf-open-edit-save-reopen": () => require("./pdf-open-edit-save-reopen.js") as { default: unknown },
  "markdown-open-edit-save-reopen": () => require("./markdown-open-edit-save-reopen.js") as { default: unknown },
  "html-open-edit-save-reopen": () => require("./html-open-edit-save-reopen.js") as { default: unknown },
};

/** 旅程名列表（**不触发**任何模块加载）。`build.mjs` 用它枚举。 */
export const journeyNames = Object.keys(loaders);

/**
 * 惰性旅程表。`journeys[i].name` 可读（常量），读 `steps`/`launch` 才加载模块。
 * runner 在真 Electron 里读，所以 electron 可用。
 */
export const journeys: LazyJourney[] = journeyNames.map((name) => {
  let materialized: LazyJourney | null = null;
  const materialize = (): LazyJourney => {
    if (materialized === null) {
      const mod = loaders[name]!();
      const exported = (mod as { [k: string]: unknown }).default ?? Object.values(mod)[0];
      if (!exported || typeof exported !== "object") throw new Error(`T7: ${name} 没有导出旅程对象`);
      materialized = exported as LazyJourney;
      if (materialized.name !== name) {
        throw new Error(`T7: ${name} 模块导出的旅程名是 ${materialized.name}（不一致）`);
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

/**
 * ready 之前的特权注册：与生产 `main/index.ts` 顶层**同一个函数、同一处调用**。
 * 生产只调 `registerGenofficeNativeScheme()`（`main/index.ts:72`），它一次注册
 * 三个 scheme（mcode-panel / genoffice-docx-media / genoffice-app，全部
 * `standard+secure`）。**不要再补第二次 `registerSchemesAsPrivileged`**：
 * vendor `renderer-protocol.ts:10` 写明「a process may call
 * registerSchemesAsPrivileged only once」—— 第二次调用不会追加，只会被丢弃，
 * 而且会掩盖第一次是否真的生效。**惰性 require**：本模块也会被普通 Node
 * （`build.mjs`）加载，那时 electron 不存在。
 */
export function beforeReady(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factories = require("../../../src/main/document/genofficeViewFactories.js") as typeof import("../../../src/main/document/genofficeViewFactories.js");
  factories.registerGenofficeNativeScheme();
}

/** ready 之后：`genoffice-app://` 的请求处理器（惰性 require，同 beforeReady）。 */
export function afterReady(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const factories = require("../../../src/main/document/genofficeViewFactories.js") as typeof import("../../../src/main/document/genofficeViewFactories.js");
  factories.installGenofficeNativeProtocol();
}
