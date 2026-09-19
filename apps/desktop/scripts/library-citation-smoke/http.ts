/**
 * `@main/library/http.js` 的替身 —— 本套要验的四条链路里,三条最终都会走到
 * `fetchJson` 这个出口。
 *
 * ## 只有 `fetchJson` 一条出口,`fetchText` 在这份替身里是**空的**
 *
 * 真的 `http.ts` 里 `fetchJson` / `fetchText` 是并排的两个函数,但**被测代码里
 * 只有 `fetchJson` 走这一条路** —— arXiv 的 Atom 用的是 `metadata.ts` 自己另抄的
 * curl(`fetchText`,见 `stubs/curl.ts`),`oaResolvers.ts` 全走 `fetchJson`。
 * 所以这里留一个 `fetchText` 只为保持模块形状一致(它的路由表永远空,真被调到
 * 会立刻抛"没登记"),arXiv 那一路请登记到 `stubs/curl.ts`。
 *
 * ## 为什么必须换它(而不是让它真联网)
 *
 * 一是**确定性**:上游(Crossref / OpenAlex / Europe PMC)返回什么不由我们决定,
 * 用真网写断言的套件会在别人的网络下飘成红的;二是**验得到边界**:真实上游几乎不会
 * 给你一个「有 issued 没有 published-print」「标题里带 `&` `%` `$`」的样本,而那些恰恰
 * 是用户会遇到、我们又必须答对的形状。
 *
 * ## 这个替身比真货更严,不是更松
 *
 * - **路由按 URL 匹配,没登记过的地址直接抛**。真 `fetchJson` 对任何 URL 都返回
 *   `{ok:false}`,而"返回失败"恰恰是被测代码**吞掉**的那种情况(每个源都是
 *   `if (!res.ok) return []`)—— 静默失败会让这个套件绿着骗人。宁可炸:哪条 URL 没
 *   登记,就说明被测链路走到了一条夹具没准备的路。
 *
 * ## 这个文件怎么进到 bundle 里(以及为什么它不叫 `stubs/http.ts`)
 *
 * `metadata.ts` / `oaResolvers.ts` 里的 `from "./http.js"` 是**相对**说明符,而
 * esbuild 的 `--alias` 只收包名式名字 —— 给相对名(哪怕就是 `./http.js`)直接
 * `Invalid alias name` 报错。实测 `--alias:http.js=…` 也不生效(alias 根本匹配不上
 * 相对说明符)。所以这一条走的是**另一条机制**:
 *
 *   1. `main.ts` 里 `import … from "./http.js"`(与它并排);
 *   2. `run.sh` 用 `--external:./http.js` 把 `metadata.ts` 那条 import 原样留在产物里;
 *   3. bundler 把本文件输出成 `$OUT/http.js`。
 *
 * 于是 `main.ts` 与 `metadata.ts` 在运行期拿到的是**同一个模块实例** —— 这很关键:
 * 如果两边各拿到一份,`main.ts` 登记的路由在被测代码里根本看不见,而这个套件会用
 * 一个"没登记的地址"把这件事喊出来(而不是静默绿着)。
 *
 * 代价是**不能放在 `stubs/` 子目录里**:从 `$OUT/stubs/http.js` 里写 `../http.js`,
 * Node 在 ESM 下不会像 CJS 那样补 `.js` 后缀去解析,会 `ERR_MODULE_NOT_FOUND`。
 * 与产物同级就没有这个问题。
 */

import { createRequire } from "node:module";

// 仅为让上面那条 import 在「被打成 http.js」时不被 esbuild 摇掉/报错。
void createRequire;

interface HttpJsonResult<T> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

/** 某条路由的返回。给函数可以按请求变(比如 404 与 200 两种)。 */
type Reply = Outcome | ((url: string) => Outcome);

interface Outcome {
  ok: boolean;
  status?: number;
  data?: unknown;
  text?: string;
  error?: string;
}

export const LIBRARY_MAILTO = "mcode-library@localhost";
export const LIBRARY_UA = `McodeLibrary/0.1 (mailto:${LIBRARY_MAILTO})`;

interface Route {
  match: (url: string) => boolean;
  reply: Reply;
  hits: number;
  /** 登记时给的名字,命中不了时能说清"本该是哪一条"。 */
  key: string;
}

type Method = "fetchJson" | "fetchText";

const routes: Record<Method, Route[]> = { fetchJson: [], fetchText: [] };
/** 每次调用的原样 URL(按方法分),供「打的是哪个接口」这类断言用。 */
export const calls: Record<Method, string[]> = { fetchJson: [], fetchText: [] };

/** 登记一条 JSON 路由。`key` 只用于排查时说得清是哪一条。 */
export function record(key: string, match: string | RegExp, reply: Reply): void {
  routes.fetchJson.push({
    match: typeof match === "string" ? (u) => u.includes(match) : (u) => match.test(u),
    reply,
    hits: 0,
    key,
  });
}

/** 本套的 `fetchText` 路由表永远是空的 —— 真被调到就说明有人把 arXiv 那一路
 *  登记到这儿了。请登记到 `stubs/curl.ts`(那条路不经过本模块)。 */
export async function fetchText(url: string): Promise<string | null> {
  throw new Error(
    `[http stub] fetchText 不该被走到:${url}\n` +
      "  `metadata.ts` 的 fetchText 走的是它自己另抄的 curl —— 登记到 stubs/curl.ts。",
  );
}

/** 某个 host 上的 JSON 请求一共打了几次 —— 「没配邮箱时不该打 Unpaywall」这类断言用。
 *
 *  **从调用流水里数,不是拿路由表反推**。反推的写法(`routes.filter(r => r.match(url))`)
 *  有一个静默的坑:README 里那些 `?` 结尾的 match 串(`"api.openalex.org/works?"`)
 *  撞上 `"https://api.openalex.org/"` 会 `includes` 不上,于是**恒返回 0** —— 而
 *  `hitsOf(...) === 0` 恰恰是"不该打它"那类断言,恒 0 就等于那类断言全部空过。
 *  实测踩到过:`hitsOf("api.openalex.org")` 在被测代码明明打了 OpenAlex 的情况下返回 0。
 *  数真实调用流水没有这个问题,而且语义更直白。 */
export function hitsOf(host: string): number {
  return calls.fetchJson.filter((u) => u.includes(`//${host}/`)).length;
}

export function resetStubbedHttp(): void {
  for (const m of ["fetchJson", "fetchText"] as const) {
    routes[m] = [];
    calls[m] = [];
  }
}

/** 登记了但一次都没命中的路由(名字)—「夹具 URL 形状已经对不上被测代码」的守卫用。 */
export function unfiredRoutes(): string[] {
  return routes.fetchJson.filter((r) => r.hits === 0).map((r) => r.key);
}

function resolve(method: Method, url: string): Outcome {
  calls[method].push(url);
  const route = routes[method].find((r) => r.match(url));
  if (!route) {
    const near = routes[method].map((r) => r.key).join(" / ") || "(一条都没有)";
    throw new Error(
      `[http stub] 没登记的 ${method} 地址:${url}\n` +
        `  已登记的是:${near}\n` +
        "  这条链路走到了一条夹具没准备的路 —— 要么补夹具,要么它就是被测代码的问题。",
    );
  }
  route.hits += 1;
  return typeof route.reply === "function" ? route.reply(url) : route.reply;
}

export async function fetchJson<T>(
  url: string,
  _opts: { headers?: Record<string, string>; timeoutMs?: number; accept?: string } = {},
): Promise<HttpJsonResult<T>> {
  const r = resolve("fetchJson", url);
  if (!r.ok) return { ok: false, status: r.status, error: r.error ?? "stub: 这个源不可用" };
  return { ok: true, data: r.data as T };
}

