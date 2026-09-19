/**
 * `@main/browser/BrowserManager.js` 的替身 —— 真的那个 import 了 `electron`
 * (`BrowserWindow`、`app`、`safeStorage` 一大串)。
 *
 * ## 为什么必须换它(而不是只换 window)
 *
 * `ipc/library.ts` 拉进 `library/downloader.ts`,而它 → `BrowserManager.ts`。
 * 前面几层都是纯 node,到这一刀才碰到 electron。整条 BrowserManager 的依赖面很宽
 * (`@main/window.js`、`@main/lib/theme.js`、`pickerScript` / `snapshotScript` 那几坨
 * 注入脚本),换桩比逐个补桩便宜得多,而且本套一次都不走浏览器那条路。
 *
 * 被换掉的是**下载**那一路。本套一次都不调它:删除条目会同时删掉它的下载任务行,
 * 但那一步**不经过**这里(见 ipc/library.ts 里 `LibraryRepo.delete` 的注释)。
 * 所以这里的替身是**显式报错**,不是空实现 —— 真被调到了要立刻显形。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`本套不该走到 BrowserManager.${name}(下载那一路没被测)`);
  };
}

export const downloadViaBrowser = notHere("downloadViaBrowser");
export const printUrlToPdf = notHere("printUrlToPdf");
export const resolvePdfCandidates = notHere("resolvePdfCandidates");
