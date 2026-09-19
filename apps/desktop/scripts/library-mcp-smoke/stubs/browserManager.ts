/**
 * `@main/browser/BrowserManager.js` 的替身 —— 真的那个 import 了 `electron`
 * (`BrowserWindow`、`app`、`safeStorage` 一大串)。
 *
 * ## 为什么必须换它(而不是只换 window)
 *
 * 本套要验的是**资料库那两条新工具**(`library_convert` 与 `library_links*` 那一组),
 * 而 `library/mcp/libraryServer.ts` 为 `library_convert` 拉进了
 * `library/convert.ts` → `downloader.ts` → `BrowserManager.ts`。前面几层都是纯 node,
 * 到 BrowserManager 这一刀才碰到 electron。
 *
 * 被换掉的是**下载**那一路(内嵌浏览器带登录态去抓 PDF)。本套一次都不调它:
 * `library_convert` 只管"已经在本地的 PDF → Markdown",下载是 `library_download`
 * 的事,而那条路这次没动。所以这里的替身是**显式报错**,不是空实现 ——
 * 真被调到了要立刻显形,而不是安静地返回 undefined 让断言去猜。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`本套不该走到 BrowserManager.${name}(下载那一路没被测)`);
  };
}

export const downloadViaBrowser = notHere("downloadViaBrowser");
export const printUrlToPdf = notHere("printUrlToPdf");
export const resolvePdfCandidates = notHere("resolvePdfCandidates");
