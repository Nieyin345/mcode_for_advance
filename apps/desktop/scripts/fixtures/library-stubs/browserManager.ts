/**
 * `@main/browser/BrowserManager.js` 的替身 —— 真的那个会开一个内嵌浏览器窗口、
 * 带 cookie 去请求真实的出版社站点。
 *
 * `ipc/library.ts` 的 import 图里有它(经 `library/downloader.ts`),而
 * `enqueueDownloads` 会**立刻**`void processDownloadQueue()` —— 也就是说本套每调一次
 * 入库,队列就真的跑一次。真下载器会联网、会往库根写 PDF、还会在失败时按分钟级重试。
 *
 * 所以这个桩不是"省事",是**本套能跑的前提**:下面两个函数一被调用就抛,把
 * "下载真的开跑了"这件事变成一声脆响,而不是几秒钟后屏幕上出现一堆看不懂的网络错。
 *
 * ## 为什么是抛而不是静默返回
 *
 * `processDownloadQueue` 内部对单个任务的失败是 catch 住的(一条下载失败不该中断整条
 * 队列),所以"抛"到不了本套的调用栈上 —— 它会被记成一条 `DownloadJob` 的失败,
 * 断言照样能看见(`status` 不是 `pending`)。**静默返回才是真的危险**:那样一个
 * "排了队但永远不会被处理"的假象会让 `pending` 断言永远为真,而它什么都没证明。
 */
/**
 * 参数照**真实现**的签名抄(`BrowserManager.ts:529-533` / `:600-604`),
 * 而不是从 `@contracts` 里找一个类型 —— 那两处用的就是匿名对象字面量,没有具名
 * 类型可 import。
 */
export async function downloadViaBrowser(req: {
  url: string;
  savePath: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; path?: string; error?: string }> {
  throw new Error(`[stub] downloadViaBrowser 不该在冒烟里被调用(url=${req.url})`);
}

export async function printUrlToPdf(req: {
  url: string;
  savePath: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  throw new Error(`[stub] printUrlToPdf 不该在冒烟里被调用(url=${req.url})`);
}
