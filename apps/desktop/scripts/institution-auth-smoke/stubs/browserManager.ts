/**
 * `@main/browser/BrowserManager.js` 的替身 —— **可控的 cookie 存储**,不是纯抛型。
 *
 * ## 为什么这一套必须换它
 *
 * `ipc/institutionAuth.ts` 唯一的"外部世界"就是这个 cookie 保管库:它读的时候要
 * 反推「已登录哪些站点」,清的时候要真的删。而真那个 `BrowserManager` 一上来就拽着
 * `BrowserWindow` / `session` / `safeStorage` 一大串 electron,无头脚本给不出来。
 *
 * 更关键的是**这一套要能喂**:`401`、存储报错、带前导点的父域 cookie、会话 cookie
 * (没有 `expirationDate`)、没有 `domain` 的条目 —— 这些形状真浏览器不是想造就能造。
 * 所以这里是"能喂、能记"的替身(同 dialog-shell-smoke 里 electron 桩的取舍),
 * 而不是 library-delete-smoke 那种**显式抛**的桩。
 *
 * ## 匹配规则是**实测抄来的**,不是我猜的
 *
 * `clearBrowserCookiesForDomains` 由 cookie 自己的 domain/path/secure **反推一个 url**
 * 再 `cookies.remove(url, name)`,而这里的 `get`/`clear` 都按**域**过滤 —— 两处规则
 * 只要和 Electron 不一致,断言红的就是桩而不是被测代码。所以开工前真起了一次
 * Electron(33.0.0,与本仓库依赖同版本)实测了这两条:
 *
 *   1. `ses.cookies.get({ domain })` 收**裸域名**,并且**认子域**:写完
 *      `.cnki.net` / `lib.example.edu` / `.example.edu` 三条之后,
 *      `get({domain:"cnki.net"})` 拿得到 `.cnki.net`;
 *      `get({domain:"example.edu"})` 拿得到 `.example.edu` **和** `lib.example.edu`;
 *      `get({domain:"lib.example.edu"})` 只拿得到 `lib.example.edu`。
 *   2. `remove("http://cnki.net/", name)`(即去掉前导点推出来的 url)真删得掉
 *      `.cnki.net` 那条父域 cookie。
 *
 * 结论:界面上显示的那些域名(去掉前导点的)**原样**传回去真能清掉 —— 这条正是
 * 「面板上点垃圾桶」那条路,`main.ts` §4 会把它整条走一遍。
 *
 * ## 明文 cookie 值
 *
 * 替身**完整保存** `value`,因为 `main.ts` 要拿一个哨兵值去查"它有没有跟着返回体
 * 溜出去"。要是这里把 value 丢掉,那条断言就成了**空过**。
 */

/** 一条假 cookie。字段名照 Electron 的 `Cookie`。 */
export interface FakeCookie {
  name: string;
  value: string;
  /** 没有 = 会话 cookie(真的那个对会话 cookie 不填 expirationDate)。 */
  domain?: string;
  path?: string;
  secure?: boolean;
  /** **秒级** Unix 时间戳 —— 界面 `new Date(expiresAt * 1000)` 靠它。 */
  expirationDate?: number;
}

let cookies: FakeCookie[] = [];
/** 每次 `clear` 收到的域名列表,按调用顺序。 */
let clearBatches: string[][] = [];
/** 每次 `get` 收到的 filter。 */
let getFilters: Array<{ domain?: string; url?: string }> = [];
/** 下一次 clear 要抛的话(消息非空 = 抛)。用来造「cookie 存储报错」。 */
let clearFailure: string | null = null;

/** 每段断言前调一次,免得前一段的余量影响这一段。 */
export function resetBrowser(): void {
  cookies = [];
  clearBatches = [];
  getFilters = [];
  clearFailure = null;
}

export function setCookies(next: FakeCookie[]): void {
  cookies = next.map((c) => ({ ...c }));
}

/** 现在**还活着**的 cookie(断言"清掉了没有"用)。 */
export function liveCookies(): FakeCookie[] {
  return cookies.map((c) => ({ ...c }));
}

/** 每次 clear 收到的域名列表(`[[...], [...]]`)。 */
export function clearedBatches(): string[][] {
  return clearBatches.map((b) => b.slice());
}

export function cookieGetFilters(): Array<{ domain?: string; url?: string }> {
  return getFilters.map((f) => ({ ...f }));
}

/** 让下一次 clear **抛**(消息原样透出去,套件据此断言没被吞掉)。 */
export function failNextClear(message: string): void {
  clearFailure = message;
}

/** 去前导点(真的那份 `BrowserManager` 与 Electron 都用这个形状)。 */
function bare(domain: string): string {
  return domain.startsWith(".") ? domain.slice(1) : domain;
}

/** 实测抄来的匹配:**域相等**,或这个 cookie 是那个域的**子域**。 */
function domainMatches(host: string, domain: string): boolean {
  const h = bare(host).toLowerCase();
  const d = bare(domain).toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

export async function getBrowserCookies(
  filter: { domain?: string; url?: string } = {},
): Promise<FakeCookie[]> {
  getFilters.push({ ...filter });
  if (!filter.domain) return cookies.map((c) => ({ ...c }));
  return cookies.filter((c) => !!c.domain && domainMatches(c.domain, filter.domain!)).map((c) => ({ ...c }));
}

export async function clearBrowserCookiesForDomains(domains: string[]): Promise<number> {
  clearBatches.push(domains.slice());
  if (clearFailure) {
    const message = clearFailure;
    // 只抛一次 —— 否则"失败之后下一次读状态"那条断言也跟着被搞坏。
    clearFailure = null;
    throw new Error(message);
  }
  const before = cookies.length;
  cookies = cookies.filter((c) => !domains.some((d) => !!c.domain && domainMatches(c.domain, d)));
  return before - cookies.length;
}

/**
 * 本套一次都不该碰到的其余导出面。
 *
 * ⚠️ 只有本套真的 import 到的那几个名字才需要存在(esbuild 对具名 export 严格匹配),
 * 但**"不该走到"的东西要显式抛**而不是安静返回 undefined —— 安静返回会让断言去猜,
 * 而"猜"出来的绿是最贵的那种绿。
 */
function notHere(name: string): () => never {
  return () => {
    throw new Error(`institution-auth-smoke 不该走到 BrowserManager.${name}(这套只验 cookie 那一层)`);
  };
}

export const downloadViaBrowser = notHere("downloadViaBrowser");
export const printUrlToPdf = notHere("printUrlToPdf");
export const resolvePdfCandidates = notHere("resolvePdfCandidates");
export const BrowserManager = {
  clearBrowserCookies: notHere("BrowserManager.clearBrowserCookies"),
  saveCookieVault: notHere("BrowserManager.saveCookieVault"),
};
