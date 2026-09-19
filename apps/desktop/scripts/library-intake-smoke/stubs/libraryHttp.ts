/**
 * `@main/library/http.js` 的替身 —— 真的那个 spawn 一个 `curl` 子进程去公开元数据
 * API(Crossref / OpenAlex / Unpaywall / Semantic Scholar / Europe PMC / arXiv)
 * 取 JSON。
 *
 * ## 为什么非换不可
 *
 * `enqueueDownloads` 尾巴上是 `void processDownloadQueue()` —— **入库一次,真下载器
 * 就跑一次**。而选候选地址那一环(`downloader.pdfCandidates` → `oaResolvers`)会连着
 * 打四五个真实站点。不换的话:本套要联网、要几十秒、还依赖别人家的 API 是否限流
 * (`crossrefRecord` / `openalexRecord` / `unpaywallRecord` / `s2Record` /
 * `epmcCandidates` 一人一次)。文献库那一条链本来是最该在无头里常跑的东西,联网会让
 * 它变成"有时红有时绿"的那种测试 —— 那是比没有测试更坏的状态。
 *
 * ## 为什么是抛,而不是返回一个空结果
 *
 * 返回空等于**假装解析成功了、只是没找到候选** —— 那和真实的"这篇真没有开放获取
 * 版本"长得一模一样,断言就分不出"桩在挡"和"代码走对了"。抛出去之后调用方会走它
 * 自己那条 catch,并且**留下痕迹**(`downloader.ts:300` 的 `pdfCandidates` 把异常
 * 记成一条 warn 日志),任务状态也就落在确定的 `not_found` 上 —— 见 main.ts 第 6 节。
 *
 * ⚠️ 顺带把这个模块的**全部导出**都补上。`metadata.ts` / `oaResolvers.ts` 一共用到
 * 三个名字(`fetchJson` / `LIBRARY_UA` / `LIBRARY_MAILTO`),而 `LIBRARY_UA` 是由
 * `LIBRARY_MAILTO` 拼出来的 —— 少了它,打包时就报 `No matching export`,报在那个
 * **被换掉的模块**上,看起来像桩写错了,其实是漏了一个导出。
 */
import type { HttpJsonResult } from "@main/library/http.js";

export const LIBRARY_MAILTO = "mcode-library@localhost";
export const LIBRARY_UA = `McodeLibrary/0.1 (mailto:${LIBRARY_MAILTO})`;

/** 记下"谁想上网" —— 断言可以据此证明本套一次网都没发。 */
export const httpCalls: string[] = [];

export function resetHttpCalls(): void {
  httpCalls.length = 0;
}

export async function fetchJson<T>(url: string): Promise<HttpJsonResult<T>> {
  httpCalls.push(url);
  throw new Error(`[stub] fetchJson 不该在冒烟里被调用(url=${url})`);
}
