/**
 * `node:child_process` 的替身 —— **本套唯一一处在"没有第二个出口"的地方换桩**。
 *
 * ## 为什么非得换它
 *
 * `metadata.ts` 里有**两套**取数实现:
 *
 *   - `fetchJson` —— 从 `./http.js` 导入,这一条已经被 `http.ts` 那个桩接管了;
 *   - `fetchText` —— **它自己在本文件里又抄了一遍 curl 策略**(`metadata.ts:276`),
 *     唯一的外部动作是 `spawn("curl", …)`。
 *
 * 于是 `fetchByArxivId` / `searchArxiv`(arXiv 只有 Atom,走的就是 `fetchText`)
 * 完全不经过 `http.js`:套件里登记的路由压根看不见,它会**真去连 export.arxiv.org**。
 * 这不是"绿着骗人",是更坏的一种 —— 断言会拿**真网上此刻那篇论文**去比对夹具,
 * 于是既不确定、又可能在别人的网络下反向变成红的。实测撞到过:
 * 套件以为在验夹具里的 "Deep Learning for Metasurface Inverse Design",
 * 实际拿到的是线上此刻的 "A neural operator-based surrogate solver …"。
 *
 * ## 为什么可以放心换掉整个 `node:child_process`
 *
 * 本条 import 说明符在本 bundle 里**只有两处**用它(`grep` 过):
 *
 *   - `library/http.ts` —— 已被 `--alias:@main/library/http.js=` 整份换掉,不进产物;
 *   - `library/metadata.ts` —— 就是这里要拦的;
 *
 * 而本 bundle 的 import 图是
 * `citationExport / metadata / journalRank / oaResolvers → repositories → broadcast(已换桩)`,
 * `store/` 与 `lib/` 下没有任何别的 `child_process` 使用者。所以"spawn 掉到这个桩"
 * 就等价于"只有 metadata.ts 的 curl 被掉了"。
 *
 * ## 它比真 curl 更严
 *
 * - **没登记过的 URL 直接抛**,与 `http.ts` 的桩同一个口径:真 curl 失败会返回
 *   `ok:false`,而 `metadata.ts` 里 `if (!text) return null` / `r.ok ? … : []` 恰恰
 *   把这种情况咽了下去 —— 断言会因此"绿着",但其实什么都没验到。
 * - **`code` 可为非 0**,用来造"curl 取回了内容但退出非 0"这种真 curl 也会有的形状。
 *
 * URL 表是运行期填的(`registerCurl`),所以 `http.ts` 的 `resetStubbedHttp()`
 * 会连它一起清。
 */
import { EventEmitter } from "node:events";

interface CurlOutcome {
  /** 进程退出码。0 才算成功(与真 curl 的 `--fail-with-body` 语义一致)。 */
  code?: number;
  /** stdout。 */
  out?: string;
  /** stderr。真 curl 连不上时写在这里,`fetchText` 用它判"要不要剥代理重试"。 */
  err?: string;
}

const ROUTE_MARK = "https://";

const routes: Array<{ key: string; match: (url: string) => boolean; reply: CurlOutcome; hits: number }> = [];

/** 每次 `fetchText` 实际打出去的原样 URL(按调用顺序)—— 「打的是哪个接口」这类断言用。 */
export const curlCalls: string[] = [];

/** 登记一条 curl 路由(`registerCurl("/x?y=1", {out: "<feed/>"})`);`url` 用 includes 匹配。 */
export function registerCurl(
  url: string | RegExp,
  reply: CurlOutcome | ((u: string) => CurlOutcome),
): void {
  routes.push({
    key: typeof url === "string" ? url : String(url),
    match: typeof url === "string" ? (u) => u.includes(url) : (u) => url.test(u),
    reply: reply as CurlOutcome,
    hits: 0,
  });
}

/** 某个 host 上的路由一共被打了几次。 */
export function curlHitsOf(host: string): number {
  return routes.filter((r) => r.match(`${ROUTE_MARK}${host}/`)).reduce((n, r) => n + r.hits, 0);
}

/** 与 `http.ts` 的 `resetStubbedHttp()` 成对调用 —— 两个桩要一起清才不串味。 */
export function resetStubbedCurl(): void {
  routes.length = 0;
  curlCalls.length = 0;
}

/** 登记了但一次都没命中的路由(URL 原样)— 见 `http.ts` 的 `unfiredRoutes`。 */
export function unfiredCurlRoutes(): string[] {
  return routes.filter((r) => r.hits === 0).map((r) => r.key);
}

/**
 * `spawn()` 的最小替身。
 *
 * 只实现 `fetchText` 用到的那几样:`stdout` / `stderr` 的 `"data"` 与 `"close"`
 * 事件、`on("error")`、`kill()`。**不实现 `exit` 之类的别的形状** —— 哪天
 * `metadata.ts` 改了用法,这里会直接报"没有这个成员",而不是安静地少触发一件事。
 */
export function spawn(command: string, args: string[] = []): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
} {
  const url = args[args.length - 1] ?? "";
  curlCalls.push(url);

  const route = routes.find((r) => r.match(url));
  if (!route) {
    throw new Error(
      `[curl stub] 没登记的 spawn(curl) 地址:${url}\n` +
        "  `metadata.ts` 的 fetchText 走的是这条路 —— 要么补夹具,要么它就是被测代码的问题。",
    );
  }
  route.hits += 1;
  const result = typeof route.reply === "function" ? (route.reply as (u: string) => CurlOutcome)(url) : route.reply;

  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };

  // 事件在下一个 tick 发,不跟真进程的时序抢跑;`close` 的码是真 curl 语义的核心。
  setImmediate(() => {
    const out = result.out ?? "";
    const err = result.err ?? "";
    if (out) child.stdout.emit("data", Buffer.from(out, "utf8"));
    if (err) child.stderr.emit("data", Buffer.from(err, "utf8"));
    child.emit("close", result.code ?? (err && !out ? 7 : 0));
  });

  void command;
  return child;
}

/** 其它 `child_process` 成员 —— 本 bundle 里不该有第二处使用者,走到就显形。 */
export function execFile(): never {
  throw new Error("本套不该走到 child_process.execFile");
}
export function exec(): never {
  throw new Error("本套不该走到 child_process.exec");
}
export function fork(): never {
  throw new Error("本套不该走到 child_process.fork");
}
