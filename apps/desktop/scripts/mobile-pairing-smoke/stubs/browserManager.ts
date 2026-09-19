/**
 * `@main/browser/BrowserManager.js` 的替身 —— 真的那个 import 了 electron 一大串
 * (`BrowserWindow`、`WebContentsView`、`session`、`safeStorage`、`clipboard`、
 * `nativeImage`、`shell`)。
 *
 * ## 本套为什么会被拖到它
 *
 * 与 library-delete-smoke 同一条边:`ipc/library.ts` → `library/downloader.ts` →
 * `BrowserManager.ts`(`mobileRpc.ts` 的 import 图会拉到 `ipc/library.ts`)。
 *
 * 本套一次都不下载 —— 那条路走的是"内嵌浏览器带登录态去抓 PDF",与配对/令牌/闸门
 * 一个字都不沾。所以这里是**显式报错**式的替身,不是空实现:真被调到了要立刻显形,
 * 而不是安静地返回 undefined 让断言去猜(与 library-mcp-smoke 同一取舍)。
 *
 * ⚠️ 导出面**照抄** library-delete-smoke 那份的形状(`BrowserManager` 那个对象本身),
 * 而不是自己发明一份更小的 —— esbuild 对**具名 export** 是严格匹配的,少一个名字就是
 * 一句 "No matching export",而那看起来和"被测代码坏了"一模一样。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`mobile-pairing-smoke 不该走到 BrowserManager.${name}(下载那一路没被测)`);
  };
}

export const downloadViaBrowser = notHere("downloadViaBrowser");
export const printUrlToPdf = notHere("printUrlToPdf");

export const BrowserManager = {
  getCookies: notHere("BrowserManager.getCookies"),
  clearCookiesForDomains: notHere("BrowserManager.clearCookiesForDomains"),
  download: notHere("BrowserManager.download"),
  printToPdf: notHere("BrowserManager.printToPdf"),
  getStatus: notHere("BrowserManager.getStatus"),
};
