/**
 * O4 —— 传给 `electron-u1/build.mjs --esbuild=` 的附加选项。
 *
 * 与 T7 的 `vendor-esbuild.mjs` **同一组 vendor 别名**（直接 import 它，不复制）：
 * 本套的 setup 需要 vendor 的 docs 主进程注册器（`mcode-ipc.ts`）、
 * `@genoffice/font-metrics`、夹具引擎（`genoffice:docx-engine` / `genoffice:jszip`）。
 *
 * 为什么不在本文件再写一份别名表：T7 的文件头已经把顺序（子路径在包根前）与
 * 理由写清楚了；抄一份 = 两份会漂。这里 import 它的 `options` 原样复用。
 * `@main/window.js` 的替身（`t7-genoffice-u1/window-holder.ts`）也在那份里 ——
 * 本套 setup 注入窗口用的就是同一个替身模块。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { options as t7Options } from "../t7-genoffice-u1/vendor-esbuild.mjs";

export const options = { ...t7Options };

/** vendor 快照是否就绪（run.mjs 用它决定「如实失败」还是真跑）。返回缺失清单。 */
export function missingVendorArtifacts(repoRoot) {
  return [
    "genoffice/apps/docs/out/renderer/index.html",
    "genoffice/apps/docs/out/preload/index.js",
    "genoffice/packages/cli/dist/genoffice.cjs",
  ].filter((rel) => !existsSync(resolve(repoRoot, rel)));
}
