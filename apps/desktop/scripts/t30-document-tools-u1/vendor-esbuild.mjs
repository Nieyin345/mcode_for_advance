/**
 * T30 —— 传给 `electron-u1/build.mjs --esbuild=` 的附加 esbuild 选项。
 *
 * 本套件的旅程 import 三条外部源码：
 *   1. `@main/...`（产品主进程）—— tsconfig 的 paths 已覆盖，esbuild 不认 tsconfig
 *      paths，所以这里逐条 aliase；
 *   2. `t7-genoffice-u1/*`（复用 T7 的 harness / editor-flow，不复制）—— 它们自己
 *      import vendor 主进程（`@genoffice/*`、`?raw`、wasm…）；
 *   3. `genoffice/apps/docs/src/main/mcode-ai.ts`（T98 的注册器原件）。
 *
 * 第 2 条决定本文件基本等同 T7 的 `vendor-esbuild.mjs`：**直接 import 它**，只追加
 * 本套件新增的别名。为什么不复制：T7 那份会随 vendor 解析规则变化，复制必漂。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const t7 = await import(pathToFileURL(resolve("scripts/t7-genoffice-u1/vendor-esbuild.mjs")).href);

export const options = {
  ...t7.options,
  alias: {
    ...t7.options.alias,
    // `@main/window.js`：T7 的探针窗口替身缺 `updateTitleBarOverlay` / `createMainWindow`
    //（本套件的 import 链经 `lib/theme.ts` 会碰到它们）。用本套件自己的一份，
    // 语义与 T7 完全一致（只是把窗口交给生产单例），并补上那两个导出。
    "@main/window.js": resolve("scripts/t30-document-tools-u1/window-holder.ts"),
    // 本套件旅程直接用生产 `@main/*` 模块（T7 的 journeys 用相对路径 import 产品
    // 源码；我们在 lib.ts 里用别名，保持与产品代码同一写法）。
    "@main/document/documentToolRendererBinding.js": resolve("src/main/document/documentToolRendererBinding.ts"),
    "@main/document/docsAiPorts.js": resolve("src/main/document/docsAiPorts.ts"),
    "@main/ipc/document.js": resolve("src/main/ipc/document.ts"),
  },
};
