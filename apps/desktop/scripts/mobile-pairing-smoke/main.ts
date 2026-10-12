/**
 * Headless smoke for **手机端那道门**(`main/mobile/` 的配对 / 令牌 / HTTP 服务)。
 *
 * ## 为什么单独一套 —— 以及为什么它比别的套件更像"安全套件"
 *
 * 手机端是**独立组件树**,走的是**没有 preload 的 HTTP 桥**:主进程的一部分能力因此
 * 被暴露在**局域网上**(服务器 `listen(port, "0.0.0.0")`)。这道门的后面是用户的聊天
 * 记录、会话内容,以及 `IntegrationStore.resolve()` 能解出来的**明文密钥**。
 * 这三个文件此前**零覆盖**,而这类东西出错的样子不是报错,是**一声不响地漏**。
 *
 * 本套钉的是**门守没守住**,不是给每个函数配一条测试:
 *
 *  1. 配对怎么成立(一次性码 + nonce,5 次机会,绑定 PC 侧 pending);
 *  2. 令牌的**边界**(空串 / 超长 / 特殊字符 / 改一个字符);
 *  3. **每一条**路由过不过闸门 —— 尤其"看起来无害"的那几条(静态文件、health、404);
 *  4. 撤销之后旧令牌**立刻**失效;
 *  5. 响应里**不含令牌原文**、日志里也不含。
 *
 * ## 它**真的**起了一个 HTTP 服务来打
 *
 * 路由表在 `startMobileServer` 里,而那个函数 `listen(port, "0.0.0.0")` —— 直接调它
 * 就等于**把跑测试的这台机器挂到局域网上**。所以路由表被逐字提取成
 * `createMobileRequestHandler(endpoint)`(见 MainHttpServer 里那段注释),本套拿它在
 * **`127.0.0.1:0`**(回环 + 随机端口)上起服务,`node:http` 自己派端口,不打外网、
 * 不碰局域网别的机器。跑完自己关掉。
 *
 * ## 不验的(写清楚,免得被当已验)
 *
 *  - **令牌生命周期:签发之后不过期。** `validateToken` 只比字符串,没有 `expiresAt`,
 *    也没有"换了密钥旧的就不认"这回事 —— 设备令牌**没有过期时间,只能靠撤销**
 *    (`revokeDevice`)。这不是本套漏测,是被测代码就没有这个功能;见报告。
 *  - **`0.0.0.0` 那一步本身。** 本套绑回环;`listen(port, "0.0.0.0")` 那一行是**没被
 *    执行到**的(真要验它就得真绑到局域网上,那正是本套刻意不做的事)。
 *  - **`claude:*` / `file:*` / `session:*` 那些 RPC 的**行为**。本套只发
 *    `setting:get` / `setting:set` —— 那两条是令牌明文**唯一**能被读出来的那条路
 *    (数据根下那个 `mobile.pairedDevices` 键)。别的 RPC 走的是 `dispatchMobileRpc`
 *    的白名单,黑名单与"够不够危险"不在本套范围内。
 *  - **浏览器端的 `localStorage`**:手机把令牌存在 `localStorage`,那是渲染端的事。
 *  - **暴力猜 nonce / code 的节流**:code 有 5 次上限;nonce 是 24 hex,**没有**节流
 *    (见报告)。
 *
 * Run: scripts/mobile-pairing-smoke/run.sh
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 深比较(数组/对象)—— `eq` 的 `Object.is` 对数组永远为 false。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ───────────────────────── 环境 ─────────────────────────
 *
 * 数据根:本套**真的**建一个 sqlite 库(令牌住在 settings 表里),所以这里指向
 * mktemp 出来的临时目录 —— `stubs/dataRoot.ts` 那个替身**没设就抛**,指错地方等于
 * 拿一个空库盖掉用户的聊天记录(仓库里记过这个坑:sql.js 整份重写文件)。
 */
const DATA = mkdtempSync(join(tmpdir(), "mcode-mobile-pairing-data-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

/**
 * 静态 bundle 的哨兵:写两个**真文件**到一个临时目录,再用 `MCODE_WEB_DIST` 把它挂成
 * `serveMobileStatic` 的**第一顺位**候选根。
 *
 * ⚠️ 为什么不能靠"产物目录旁边的 renderer/"那一条:`candidateRoots()` 里第二顺位是
 * `cwd/out/renderer`,而这台机器上如果**跑过 `pnpm dev`**,那一份是真 bundle,会**先**
 * 命中 —— 于是哨兵断言红在一个与门无关的原因上(这正是仓库里记过的"绿着但没测到")。
 * 第一顺位是确定的,所以用它。
 */
const WEB_DIST = mkdtempSync(join(tmpdir(), "mcode-mobile-pairing-web-"));
const INDEX_SENTINEL = "SENTINEL_INDEX_BUNDLE";
const PAIR_SENTINEL = "SENTINEL_PAIR_PAGE";
writeFileSync(join(WEB_DIST, "index.html"), `<!doctype html><html><body>${INDEX_SENTINEL}</body></html>`);
writeFileSync(join(WEB_DIST, "pair.html"), `<!doctype html><html><body>${PAIR_SENTINEL}</body></html>`);
process.env.MCODE_WEB_DIST = WEB_DIST;

/* ─────────────── 被测模块(桩已就位) ───────────────
 *
 * ⚠️ **真的建一个 sqlite 库。** 令牌住在 settings 表里(`mobile.pairedDevices`),
 * 而那正是"撤销之后旧令牌立刻失效"这条断言的**存放层** —— 换成内存版就没验到它。
 * 数据根由 stubs/dataRoot.ts 钉到 mktemp(那个桩**没设就抛**,指错地方等于拿空库盖掉
 * 用户的聊天记录)。
 */
const { initDb, getDb, closeDb } = await import("@main/store/db.js");
process.once("exit", () => {
  try { closeDb(); }
  finally {
    rmSync(DATA, { recursive: true, force: true });
    rmSync(WEB_DIST, { recursive: true, force: true });
  }
});
await initDb();
check("库真的建起来了(不是空壳桩)", !!getDb());
check(
  "库文件落在临时数据根下",
  existsSync(join(DATA, "mcode.db")),
  { data: DATA },
);

const { pairingManager } = await import("@main/mobile/PairingManager.js");
const { mobileEventBus } = await import("@main/mobile/MobileEventBus.js");
const { createMobileRequestHandler } = await import("@main/mobile/MobileHttpServer.js");
const { safeEqualString } = await import("@main/mobile/mobileTokens.js");
const { SettingRepo } = await import("@main/store/repositories.js");

/**
 * `__setRunning` 只存在于**桩**里(真 RuntimeManager 没有这个成员)—— 所以不能走
 * 静态 import:tsc 看的是**真模块**,会报 `Property '__setRunning' does not exist`。
 * 用一层动态取属性的转换把它拿进来,类型上诚实、打包时照样走桩。
 */
const runtimeStub = (await import("@main/claude/RuntimeManager.js")) as unknown as {
  __setRunning(ids: string[]): void;
};
const __setRunning = runtimeStub.__setRunning;

/** 直接读 settings 表里那个键 —— 用来核对令牌以什么形式落盘。 */
function rawDevicesSetting(): string | null {
  return SettingRepo.get("mobile.pairedDevices");
}

/* ───────────────────────── 起服务 ─────────────────────────
 *
 * 回环 + 随机端口。`endpoint` 只是被回显进 /api/health 与配对结果,不参与路由。
 */
const ENDPOINT = "http://127.0.0.1:0";
const server: Server = createServer(createMobileRequestHandler(ENDPOINT));
await new Promise<void>((resolve, reject) => {
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const addr = server.address();
if (!addr || typeof addr === "string") throw new Error("拿不到端口");
const BASE = `http://127.0.0.1:${addr.port}`;
console.log(`\n服务在 ${BASE}(回环,随机端口)\n`);

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** 连接在拿到 HTTP 响应之前就断了(超长头被 `node:http` 直接掐掉那一类)。 */
  transportError?: string;
}

/**
 * 所有响应,按顺序留着 —— 收尾那条"响应里不许出现任何令牌原文"就是扫它。
 *
 * 记下**路径**:`/api/pair/verify` 成功那一发**按设计**就是把令牌交给刚配上的那台设备
 * (它要存进 localStorage),那不是泄露。别的任何一条都不许回显。
 *
 * ⚠️ 逐条断言"这个响应里没有令牌"是不够的:漏出去的那条**未必**是你正在看的那条。
 */
const allResponses: Array<{ path: string; text: string }> = [];

/** 所有签发出去的令牌 / 验证码原文 —— 收尾那条全局泄露扫描就是拿它们去扫响应体。 */
const issuedSecrets: string[] = [];

async function req(
  path: string,
  opts: { method?: string; token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  let payload: string | undefined;
  if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  // ⚠️ **`fetch` 与 `res.text()` 都要包在这一个 try 里。** 闸门被拆掉时,SSE 那一发给
  // 200 之后**永远读不完** —— 超时会在 `r.text()` 上炸,而它在 `fetch` 的 try 之外。
  // 让它冒泡 = 整套崩在半路,后面的断言一条都跑不到,也就谈不上"红在哪"。
  try {
    // ⚠️ **必须带超时。** SSE 那条路成功时是**永不结束**的流 —— 一个没有超时的
    // `res.text()` 会永远挂着。正常情况下它挂不上(没令牌就 401 立刻结束),但把闸门
    // 拆掉验"断言能不能红"时,它会变成一条真的流,于是整套**卡死**而不是变红 ——
    // 而"卡死"看起来和"测试写坏了"一模一样,验不了任何东西。
    const r = await fetch(`${BASE}${path}`, {
      method: opts.method ?? (payload ? "POST" : "GET"),
      headers,
      body: payload,
      signal: AbortSignal.timeout(3000),
    });
    const text = await r.text();
    allResponses.push({ path, text });
    return { status: r.status, headers: r.headers as never, text };
  } catch (err) {
    // ⚠️ **不要把连接层失败(含超时)当成异常抛出去。** 超长(64k)的 Authorization
    // 头会被 `node:http` 在**解析阶段**直接掐掉(默认 `maxHeaderSize` 16KB),客户端
    // 看到的是 `ECONNRESET`;而一条读不完的流看到的是超时。两者都是"没拿到东西",
    // 都是**好的**结果 —— 断言按"status !== 200"来判即可。
    const text = `<transport error: ${(err as Error).message}>`;
    allResponses.push({ path, text });
    return { status: 0, headers: {}, text, transportError: (err as Error).message };
  }
}

/* ───────────────────── 1. 网关:每一条路由 ─────────────────────
 *
 * 判据立在**用户看到的那个状态码**上,不立在机制上:不管内部怎么走,路径与响应里
 * 都**不能**出现令牌原文。
 */

console.log("闸门 · 每一条路由");

/**
 * 每一条路由:发一个**形状完全合法**的请求,不给令牌,看它给什么状态码。
 *
 * ⚠️ **必须发合法请求。** 空 body 的 `/api/rpc` 在闸门被拆掉时也会回 400
 * (`missing method`),于是"被拒"这条会以**错误的理由**绿 —— 那正是仓库里记过的
 * "测试绿着而问题还在"。发一个真能跑通的方法(`setting:get`),闸门在不在就变成
 * 200 与 401 的区别,一条断言才真的钉在门上。
 */
const RPC_OK_BODY = { method: "setting:get", input: { key: "smoke.gate" } };

const GATE_PROBES: Array<[string, string, unknown, number, string]> = [
  ["POST", "/api/rpc", RPC_OK_BODY, 401, "RPC"],
  ["GET", "/api/events", undefined, 401, "SSE"],
  ["GET", "/api/health", undefined, 200, "health(设计成不鉴权)"],
  ["GET", "/api/nonexistent", undefined, 404, "未知 /api"],
  ["POST", "/api/nonexistent", RPC_OK_BODY, 404, "未知 /api(POST)"],
  ["GET", "/api/pair/verify", undefined, 404, "配对页(方法不对)"],
];

for (const [method, path, body, expected, label] of GATE_PROBES) {
  const r = await req(path, { method, body });
  eq(`无令牌 ${label} → ${expected}`, r.status, expected);
  check(`无令牌 ${label} 没吐出数据`, !r.text.includes('"ok":true') || expected === 200, {
    status: r.status,
    body: r.text.slice(0, 120),
  });
}

// 静态文件:手机端**刻意**不鉴权(配对前要先能打开配对页)。这不是漏 —— 但必须
// 明确地钉住"它发的是静态资源,不是数据",否则哪天有人把 app bundle 后面挂上
// 一个不需要令牌的接口,没人会发现。
for (const [path, sentinel, label] of [
  ["/", INDEX_SENTINEL, "根路径 → index.html"],
  ["/?nonce=deadbeefdeadbeef", PAIR_SENTINEL, "带 nonce → pair.html"],
  ["/pair", PAIR_SENTINEL, "/pair → pair.html"],
] as const) {
  const r = await req(path);
  eq(`无令牌 ${label} → 200(静态,刻意不鉴权)`, r.status, 200);
  check(`无令牌 ${label} 发的是真文件(哨兵在)`, r.text.includes(sentinel), { body: r.text.slice(0, 200) });
}

/* ───────────────────── 2. 令牌边界 ───────────────────── */

console.log("\n令牌边界");

const BAD_TOKENS: Array<[string, string]> = [
  ["空串", ""],
  ["只有空格", " "],
  ["超长(64k)", "a".repeat(65536)],
  ["64 个 hex(长度对了但不是真的)", "f".repeat(64)],
  ["含特殊字符", "!!@#$%^&*()_+{}|:<>?~`"],
  ["换行注入", "abc\ndef"],
  ["上一个令牌改一个字符", "0".repeat(64)],
];

for (const [label, token] of BAD_TOKENS) {
  const r = await req("/api/rpc", { method: "POST", token, body: { method: "setting:get", input: { key: "x" } } });
  // 超长头在 `node:http` **解析阶段**就被拦下:服务端先回 431 再断开。客户端读没读到
  // 那个 431 是**时序**问题 —— Windows 上常常先看到连接被掐(`status === 0`),Linux CI
  // 上稳定读到 431(2026-09-30 CI 红过)。两种都是拒,而且比 401 更早;判据只认
  // "拒了",不认"用哪种方式拒"。
  check(`坏令牌(${label})被拒`, r.status === 401 || r.status === 0 || r.status === 431, {
    status: r.status,
    body: r.text.slice(0, 120),
  });
}

// 认证头本身的形状:GOD 的令牌前缀不合法、大小写、前后空格。
const authHeaderShapes: Array<[string, string]> = [
  ["没有 Bearer 前缀", "abcdef"],
  ["空 Bearer", "Bearer "],
];
for (const [label, header] of authHeaderShapes) {
  const r = await req("/api/rpc", {
    method: "POST",
    headers: { Authorization: header },
    body: { method: "setting:get", input: { key: "x" } },
  });
  check(`Authorization 形状不对(${label})被拒`, r.status === 401, { status: r.status });
}

/* ───────────────────── 3. 配对 ───────────────────── */

console.log("\n配对");

eq("还没发起时,PC 侧没有待配对的码", pairingManager.getPending(), null);

const start = pairingManager.startPairing(ENDPOINT);
issuedSecrets.push(start.code);
check("QR URL 带 nonce", start.qrUrl.includes(`nonce=${start.nonce}`), start.qrUrl);
check("验证码是 6 位数字", /^\d{6}$/.test(start.code), start.code);
check("TTL 是 5 分钟", start.expiresAt > Date.now() + 4 * 60_000, { expiresAt: start.expiresAt - Date.now() });

// 幂等复用:同一个 TTL 内再 start 一次,码不该变(否则已经打开的页面会"链接失效")。
const again = pairingManager.startPairing(ENDPOINT);
eq("TTL 内重复 start 复用同一个 nonce", again.nonce, start.nonce);
eq("TTL 内重复 start 复用同一个 code", again.code, start.code);
check("force 会换新码", pairingManager.startPairing(ENDPOINT, { force: true }).nonce !== start.nonce);

// 从**这一步**起,下面都以 fresh 这一对为准。
const fresh = pairingManager.startPairing(ENDPOINT, { force: true });
issuedSecrets.push(fresh.code);

const pairBody = (over: Record<string, unknown> = {}) => ({
  nonce: fresh.nonce,
  code: fresh.code,
  deviceName: "测试手机",
  ...over,
});

// —— 配对请求本身的形状 ——
for (const [label, body] of [
  ["空 body", {}],
  ["nonce 空串", { nonce: "", code: "123456", deviceName: "x" }],
  ["code 不是数字", { nonce: fresh.nonce, code: "abcdef", deviceName: "x" }],
  ["code 太短", { nonce: fresh.nonce, code: "12", deviceName: "x" }],
  ["deviceName 空", { nonce: fresh.nonce, code: fresh.code, deviceName: "" }],
  ["unknown", { nonce: 123, code: "123456", deviceName: "x" }],
] as const) {
  const r = await req("/api/pair/verify", { method: "POST", body });
  check(`配对输入不合法(${label})→ 400`, r.status === 400, { status: r.status, body: r.text });
}

// —— 别人的 nonce / 错的码 ——
{
  const r = await req("/api/pair/verify", { method: "POST", body: pairBody({ nonce: "0".repeat(24) }) });
  eq("别人的 nonce → 401", r.status, 401);
  check("理由里说明了链接失效", r.text.includes("失效") || r.text.includes("nonce"), r.text);
}
{
  const wrong = fresh.code === "000000" ? "000001" : "000000";
  const r = await req("/api/pair/verify", { method: "POST", body: pairBody({ code: wrong }) });
  eq("错的码 → 401", r.status, 401);
  check("还剩 4 次机会", r.text.includes("4"), r.text);
}

// —— 正确配对 ——
const paired = await req("/api/pair/verify", { method: "POST", body: pairBody({ deviceName: "我的手机" }) });
eq("正确的 nonce+code → 200", paired.status, 200);
const pairResult = JSON.parse(paired.text) as { deviceId: string; deviceToken: string; endpoint: string };
issuedSecrets.push(pairResult.deviceToken);
check("发回了 deviceToken", typeof pairResult.deviceToken === "string" && pairResult.deviceToken.length >= 32);
eq("deviceToken 是 64 位 hex(256bit)", /^[0-9a-f]{64}$/.test(pairResult.deviceToken), true);
eq("发回了 deviceId", typeof pairResult.deviceId, "string");

// —— 用过的 nonce 不能再用 ——
{
  const r = await req("/api/pair/verify", { method: "POST", body: pairBody() });
  eq("同一个 nonce+code 再用一次 → 401(一次性的)", r.status, 401);
}
{
  // 码已经消费掉了,再发一个新 nonce 但用**旧的** code 也不行。
  const s2 = pairingManager.startPairing(ENDPOINT, { force: true });
  const r = await req("/api/pair/verify", { method: "POST", body: { nonce: s2.nonce, code: fresh.code, deviceName: "x" } });
  eq("新 nonce + 旧 code → 401", r.status, 401);
  pairingManager.cancelPairing();
}

// —— 5 次上限 ——
{
  const s3 = pairingManager.startPairing(ENDPOINT, { force: true });
  const wrong = s3.code === "000000" ? "000001" : "000000";
  let last = 0;
  for (let i = 0; i < 6; i += 1) {
    const r = await req("/api/pair/verify", { method: "POST", body: { nonce: s3.nonce, code: wrong, deviceName: "x" } });
    last = r.status;
  }
  eq("连错 6 次都是 401", last, 401);
  eq("5 次之后 pending 被作废", pairingManager.getPending(), null);
  // 作废之后**连正确的码也不认**了 —— 这才是"作废"的意思。
  const r = await req("/api/pair/verify", { method: "POST", body: { nonce: s3.nonce, code: s3.code, deviceName: "x" } });
  eq("作废后正确码也进不来", r.status, 401);
}

// —— 配对请求不绑定发起方 ——
// 这是被测代码的**现状**:`verify` 只看 nonce+code,不看来源 IP/端口。
// 钉成断言是为了让它**显式**:哪天要在局域网里防"同网段的人抢在机主前面
// 用偷看到的 code 配对",这条会先红。
{
  const s4 = pairingManager.startPairing(ENDPOINT, { force: true });
  const r = await req("/api/pair/verify", {
    method: "POST",
    body: { nonce: s4.nonce, code: s4.code, deviceName: "同网段的另一台机器" },
  });
  eq("配对请求不校验发起方(现状:同一个 nonce+code 谁先发谁成)", r.status, 200);
}

/* ───────────────────── 4. 令牌能用 / 撤销 / 轮换 ───────────────────── */

console.log("\n令牌");

const T = pairResult.deviceToken;

{
  const r = await req("/api/rpc", { method: "POST", token: T, body: { method: "setting:get", input: { key: "no.such.key" } } });
  eq("真令牌能过闸门", r.status, 200);
  check("返回的是 RPC 信封", r.text.includes('"ok":true'), r.text);
}
{
  const r = await req("/api/rpc", {
    method: "POST",
    token: T.slice(0, -1) + (T.endsWith("a") ? "b" : "a"),
    body: { method: "setting:get", input: { key: "no.such.key" } },
  });
  eq("改一个字符的令牌被拒", r.status, 401);
}
{
  const r = await req("/api/rpc", { method: "POST", token: T.toUpperCase(), body: { method: "setting:get", input: { key: "k" } } });
  eq("大写形式的令牌被拒(hex 区分大小写)", r.status, 401);
}

// —— 每个配对拿到的是**不同的**令牌 ——
{
  const s = pairingManager.startPairing(ENDPOINT, { force: true });
  const r = await req("/api/pair/verify", { method: "POST", body: { nonce: s.nonce, code: s.code, deviceName: "第二台" } });
  const second = JSON.parse(r.text) as { deviceId: string; deviceToken: string };
  issuedSecrets.push(second.deviceToken);
  check("第二台设备拿到不同的 deviceId", second.deviceId !== pairResult.deviceId);
  check("第二台设备拿到不同的 token", second.deviceToken !== T);
  // 用了别人的令牌 = 就是"别人的令牌"那条用例。
  const r2 = await req("/api/rpc", {
    method: "POST",
    token: second.deviceToken.slice(0, 32) + T.slice(32),
    body: { method: "setting:get", input: { key: "k" } },
  });
  eq("把别人的令牌接在自己的后面 → 401", r2.status, 401);
}

// —— 撤销:旧令牌必须**立刻**失效 ——
{
  const before = await req("/api/rpc", { method: "POST", token: T, body: { method: "setting:get", input: { key: "k" } } });
  eq("撤销前令牌可用", before.status, 200);
  await pairingManager.revokeDevice(pairResult.deviceId);
  const after = await req("/api/rpc", { method: "POST", token: T, body: { method: "setting:get", input: { key: "k" } } });
  eq("撤销后同一个令牌立刻 401", after.status, 401);
  const list = await pairingManager.listDevices();
  check("撤销后设备清单里没有它", !list.some((d) => d.deviceId === pairResult.deviceId));
}

// —— 全部设备被撤销 = 谁也进不来(而且第二条令牌不受影响,只掉被撤的那条)——
{
  const list = await pairingManager.listDevices();
  for (const d of list) await pairingManager.revokeDevice(d.deviceId);
  eq("清空后没有设备", (await pairingManager.listDevices()).length, 0);
}

/* ───────────────────── 5. 令牌原文不许外泄 ───────────────────── */

console.log("\n泄露面");

// 5a. **数据根下那个键里躺的就是明文** —— 这是设计如此(见文件头),但必须显式钉住:
//     一旦有人把它换成了哈希/密文,这条会红,而那条路会让"撤销之后旧令牌立刻失效"
//     的语义变掉,需要重新想一遍。
//
// ⚠️ **顺序要紧。** 这条必须铺在**还有设备活着**的地方:上一段最后把设备全撤了,
//    撤完读出来的是 `"[]"` —— 那时它红的理由是"表空了",不是"存放形式变了"。
{
  const s = pairingManager.startPairing(ENDPOINT, { force: true });
  const r0 = await req("/api/pair/verify", { method: "POST", body: { nonce: s.nonce, code: s.code, deviceName: "明文核对" } });
  const token = (JSON.parse(r0.text) as { deviceToken: string }).deviceToken;
  const raw = rawDevicesSetting();
  check(
    "配对令牌以明文存在 mobile.pairedDevices 里(设计如此)",
    raw !== null && raw.includes("deviceToken") && raw.includes(token),
    raw?.slice(0, 80),
  );
}

// 5b. **设备表本身不许被 HTTP 桥读到** —— 这是修掉的那条:`setting:get` 在手机端
//     白名单里(手机应用要读设置),而设备表里躺的是**每台设备的明文令牌**。一个已配对的
//     手机只要问这个键,就拿到了**别的手机**的令牌 —— 那等于把整道门交出去。
//     现在 HTTP 桥上一律 403(桌面渲染端不受影响:它是本机,信任层不一样)。
{
  const s = pairingManager.startPairing(ENDPOINT, { force: true });
  const r0 = await req("/api/pair/verify", { method: "POST", body: { nonce: s.nonce, code: s.code, deviceName: "内鬼" } });
  const pair3 = JSON.parse(r0.text) as { deviceToken: string };
  issuedSecrets.push(pair3.deviceToken);
  const r = await req("/api/rpc", {
    method: "POST",
    token: pair3.deviceToken,
    body: { method: "setting:get", input: { key: "mobile.pairedDevices" } },
  });
  eq("setting:get 读设备表 → 403", r.status, 403);
  check("响应里没有令牌原文", !r.text.includes("deviceToken") && !r.text.includes(pair3.deviceToken), {
    body: r.text.slice(0, 200),
  });

  // 同一个洞的三条旁路:一次读多个键、写这个键(可以清空设备表 = 让所有人掉线,
  // 也可以塞一条自己造的记录)、以及大小写/空白变形。
  const byPass = await req("/api/rpc", {
    method: "POST",
    token: pair3.deviceToken,
    body: { method: "setting:getMany", input: { keys: ["theme", "mobile.pairedDevices"] } },
  });
  eq("setting:getMany 夹带同一个键 → 403", byPass.status, 403);
  const byWrite = await req("/api/rpc", {
    method: "POST",
    token: pair3.deviceToken,
    body: { method: "setting:set", input: { key: "mobile.pairedDevices", value: "[]" } },
  });
  eq("setting:set 写这个键 → 403", byWrite.status, 403);
  eq("而且真的没写进去(设备表还在)", (await pairingManager.listDevices()).length > 0, true);
  const byCase = await req("/api/rpc", {
    method: "POST",
    token: pair3.deviceToken,
    body: { method: "setting:get", input: { key: "MOBILE.PAIREDDEVICES" } },
  });
  // 键是**大小写敏感**的,变形读的是另一个键(读不到东西)—— 这里钉的是"变形也不会
  // 意外命中真的那个",所以只要不是"拿着内容回来"就算过。
  check("键名变形读不到设备表", !byCase.text.includes("deviceToken"), { body: byCase.text.slice(0, 200) });
}

// 5c. 响应体里不能出现"发起这次请求所用的那个令牌" —— 除了它自己存在客户端,服务端
//     没有任何理由把它回显出来。
{
  const s = pairingManager.startPairing(ENDPOINT, { force: true });
  const r0 = await req("/api/pair/verify", { method: "POST", body: { nonce: s.nonce, code: s.code, deviceName: "回显检查" } });
  const pair4 = JSON.parse(r0.text) as { deviceToken: string };
  for (const [method, path, body] of [
    ["POST", "/api/rpc", { method: "setting:get", input: { key: "no.such.key" } }],
    ["GET", "/api/health", undefined],
    ["GET", "/", undefined],
    ["GET", "/api/nonexistent", undefined],
  ] as const) {
    const r = await req(path, { method, token: pair4.deviceToken, body });
    check(`${method} ${path} 的响应不回显令牌`, !r.text.includes(pair4.deviceToken), { body: r.text.slice(0, 200) });
  }
}

// 5d. 撤销掉所有设备,回到干净状态 —— 顺带验一次"撤销后**所有**旧令牌都失效"。
{
  const list = await pairingManager.listDevices();
  for (const d of list) await pairingManager.revokeDevice(d.deviceId);
  const s = pairingManager.startPairing(ENDPOINT, { force: true });
  const r0 = await req("/api/pair/verify", { method: "POST", body: { nonce: s.nonce, code: s.code, deviceName: "唯一" } });
  const t = (JSON.parse(r0.text) as { deviceToken: string }).deviceToken;
  const dev = (await pairingManager.listDevices())[0];
  await pairingManager.revokeDevice(dev.deviceId);
  const r = await req("/api/rpc", { method: "POST", token: t, body: { method: "setting:get", input: { key: "k" } } });
  eq("撤销唯一设备后它的令牌 401", r.status, 401);
}

/* ───────────────────── 6. 定时安全比较 ───────────────────── */

console.log("\n比较函数");

eq("等长相同 → true", safeEqualString("abcdef", "abcdef"), true);
eq("等长不同 → false", safeEqualString("abcdef", "abcdeg"), false);
eq("长度不同 → false", safeEqualString("abc", "abcd"), false);
eq("空 vs 空 → true", safeEqualString("", ""), true);
eq("空 vs 非空 → false", safeEqualString("", "a"), false);
// 非 ASCII:两个字符串的 UTF-8 字节数不同但**字符**数一样,不能因为长度按字符算而崩。
eq("多字节字符等长可比", safeEqualString("密码", "密码"), true);
eq("多字节字符不等 → false", safeEqualString("密码", "秘密"), false);

/* ───────────────────── 7. SSE ───────────────────── */

console.log("\nSSE");

{
  const s = pairingManager.startPairing(ENDPOINT, { force: true });
  const r0 = await req("/api/pair/verify", { method: "POST", body: { nonce: s.nonce, code: s.code, deviceName: "SSE" } });
  const t = (JSON.parse(r0.text) as { deviceToken: string }).deviceToken;
  __setRunning(["s_running_1", "s_running_2"]);

  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/events?token=${encodeURIComponent(t)}`, { signal: ctrl.signal });
  eq("带令牌的 SSE → 200", res.status, 200);
  eq("Content-Type 是 event-stream", res.headers.get("content-type"), "text/event-stream");

  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !buf.includes("runningSnapshot")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  check("首个数据帧是 runningSnapshot", buf.includes("runningSnapshot"), buf.slice(0, 300));
  check("快照里带的正是运行中的会话", buf.includes("s_running_1") && buf.includes("s_running_2"), buf.slice(0, 300));
  check("SSE 帧里不回显令牌", !buf.includes(t));

  // 广播一条事件,确认它真的流出去。
  mobileEventBus.broadcast({ type: "session.title", sessionId: "s_running_1", title: "冒烟" } as never);
  let buf2 = buf;
  const deadline2 = Date.now() + 5000;
  while (Date.now() < deadline2 && !buf2.includes("session.title")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf2 += dec.decode(value, { stream: true });
  }
  check("广播的事件流到了客户端", buf2.includes("session.title"), buf2.slice(-300));

  ctrl.abort();
  await new Promise((r) => setTimeout(r, 50));
}

// A revocation must close ALREADY-OPEN streams, not merely reject the next
// HTTP request. Exercise two connections for A and an unaffected device B.
{
  async function pairForStream(name: string): Promise<{ deviceId: string; deviceToken: string }> {
    const pairing = pairingManager.startPairing(ENDPOINT, { force: true });
    const response = await req("/api/pair/verify", {
      method: "POST", body: { nonce: pairing.nonce, code: pairing.code, deviceName: name },
    });
    const device = JSON.parse(response.text) as { deviceId: string; deviceToken: string };
    issuedSecrets.push(device.deviceToken);
    return device;
  }
  const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
    return predicate();
  };
  async function openStream(token: string, bearer = false) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${BASE}/api/events${bearer ? "" : `?token=${encodeURIComponent(token)}`}`, {
      headers: bearer ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
    eq("live revocation: stream starts authenticated", response.status, 200);
    const observation = { text: "", endedByServer: false };
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const done = (async () => {
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) { observation.endedByServer = !controller.signal.aborted; break; }
          observation.text += decoder.decode(chunk.value, { stream: true });
        }
      } catch {
        // A server-side destroy is a valid revoke; our own abort/timeout is NOT.
        observation.endedByServer = !controller.signal.aborted;
      } finally { clearTimeout(timeout); }
    })();
    check("live revocation: initial snapshot arrived", await waitFor(() => observation.text.includes("runningSnapshot")));
    return { observation, done, abort: () => controller.abort() };
  }
  const baseline = mobileEventBus.size;
  const a = await pairForStream("revoke-stream-A");
  const b = await pairForStream("keep-stream-B");
  const streams = [] as Awaited<ReturnType<typeof openStream>>[];
  try {
    const a1 = await openStream(a.deviceToken);
    streams.push(a1);
    const a2 = await openStream(a.deviceToken, true);
    streams.push(a2);
    const b1 = await openStream(b.deviceToken);
    streams.push(b1);
    eq("live revocation: all three subscribers registered", mobileEventBus.size, baseline + 3);
    await pairingManager.revokeDevice(a.deviceId);
    check("revocation closes every existing connection of A", await waitFor(() => a1.observation.endedByServer && a2.observation.endedByServer));
    check("revoking A does not close B", !b1.observation.endedByServer);
    mobileEventBus.broadcast({ type: "text.delta", sessionId: "revocation-smoke", messageId: "message-smoke", text: "AFTER_REVOKE_SENTINEL" });
    check("B still receives events after A is revoked", await waitFor(() => b1.observation.text.includes("AFTER_REVOKE_SENTINEL")));
    check("revoked streams receive no subsequent events", !a1.observation.text.includes("AFTER_REVOKE_SENTINEL") && !a2.observation.text.includes("AFTER_REVOKE_SENTINEL"));
    eq("revocation removes A's subscriptions immediately", mobileEventBus.size, baseline + 1);
    await pairingManager.revokeDevice(a.deviceId);
    eq("repeated revocation leaves B subscribed", mobileEventBus.size, baseline + 1);
    eq("revoked device cannot reconnect", (await req(`/api/events?token=${encodeURIComponent(a.deviceToken)}`)).status, 401);
  } finally {
    for (const stream of streams) stream.abort();
    await Promise.all(streams.map((stream) => stream.done));
    check("disconnect releases all stream subscriptions", await waitFor(() => mobileEventBus.size === baseline));
  }

  // Deliberately pause at the authorize -> subscribe boundary: a token that
  // WAS valid must not create a fresh stream after its device was revoked.
  const racing = await pairForStream("revoked-during-authorize");
  const validate = pairingManager.validateToken;
  const controller = new AbortController();
  try {
    pairingManager.validateToken = async (token: string) => {
      const device = await validate.call(pairingManager, token);
      if (token === racing.deviceToken && device) await pairingManager.revokeDevice(device.deviceId);
      return device;
    };
    const response = await fetch(`${BASE}/api/events?token=${encodeURIComponent(racing.deviceToken)}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
    });
    eq("revocation between authorize and subscribe cannot reopen SSE", response.status, 401);
  } finally {
    pairingManager.validateToken = validate;
    controller.abort();
    check("authorization race leaves no subscriber behind", await waitFor(() => mobileEventBus.size === baseline));
  }
}

// SSE 的令牌走 query param(EventSource 不能设 header)—— 这条豁免**只给 SSE**。
// /api/rpc 上是修掉的那条:令牌进 URL 就等于进 Referer / 反代 access log / 浏览器
// 历史,而那是一条能读聊天记录的完整通行证。
{
  const s = pairingManager.startPairing(ENDPOINT, { force: true });
  const r0 = await req("/api/pair/verify", { method: "POST", body: { nonce: s.nonce, code: s.code, deviceName: "query" } });
  const t = (JSON.parse(r0.text) as { deviceToken: string }).deviceToken;
  issuedSecrets.push(t);

  const viaRpc = await req(`/api/rpc?token=${encodeURIComponent(t)}`, {
    method: "POST",
    body: { method: "setting:get", input: { key: "k" } },
  });
  eq("query 里的令牌**不能**过 /api/rpc(只走 header)", viaRpc.status, 401);

  // API 名下的其它路由也一样 —— 豁免是按**路由**给的,不是按"有 query 就行"。
  for (const p of ["/api/health", "/api/nonexistent", "/api/pair/verify"]) {
    const r = await req(`${p}?token=${encodeURIComponent(t)}`);
    check(`${p} 也不认 query 令牌`, !r.text.includes(t), { body: r.text.slice(0, 120) });
  }

  // 静态那一路本来就无鉴权(手机要先能打开页面配对),这里只钉"它不会因为带着
  // 令牌就吐出点什么不一样的"。
  const page = await req(`/?token=${encodeURIComponent(t)}`);
  eq("静态页带令牌与否不影响它(仍是公开静态资源)", page.status, 200);

  // 而 SSE **必须**仍然认它 —— 这是那条豁免存在的唯一理由,改坏了手机就连不上。
  const ctrl = new AbortController();
  const ev = await fetch(`${BASE}/api/events?token=${encodeURIComponent(t)}`, { signal: ctrl.signal });
  eq("SSE 仍然认 query 令牌(EventSource 只能这么带)", ev.status, 200);
  ctrl.abort();
  await new Promise((r) => setTimeout(r, 50));
}

/* ───────────────────── 7b. 设置:白名单 + 跨端同步 ─────────────────────
 *
 * 手机的 `setting:*` 只放行白名单(`isMobileAccessibleSettingKey`):设置表里除了
 * 设备表,还有中继 VPS 配置、公网 MCP 密钥、终端 shell、工作流安全审查记录……
 * 放行的「跟着人走」的键写完要推给桌面和别的手机,但**不回推给发起的那台**。
 */

console.log("\n设置白名单 / 同步");

{
  const windowStub = (await import("@main/window.js")) as unknown as {
    sent: Array<{ channel: string; args: unknown[] }>;
    resetSent: () => void;
    __setDesktopAttached: (v: boolean) => void;
  };
  const pairDevice = async (name: string): Promise<string> => {
    const st = pairingManager.startPairing(ENDPOINT, { force: true });
    const r = await req("/api/pair/verify", { method: "POST", body: { nonce: st.nonce, code: st.code, deviceName: name } });
    const tok = (JSON.parse(r.text) as { deviceToken: string }).deviceToken;
    issuedSecrets.push(tok);
    return tok;
  };
  const rpcAs = (tok: string, method: string, input: unknown) =>
    req("/api/rpc", { method: "POST", token: tok, body: { method, input } });

  const tA = await pairDevice("同步-甲");
  const tB = await pairDevice("同步-乙");

  // ── 读:不放行的键一律当"没有" ──
  SettingRepo.set("relay.vpsConfig", "SECRET_VPS");
  SettingRepo.set("ui.locale", "en");
  {
    const r = await rpcAs(tA, "setting:get", { key: "relay.vpsConfig" });
    eq("setting:get 中继配置 → 200", r.status, 200);
    check("但读不到内容(null)", !r.text.includes("SECRET_VPS") && r.text.includes("null"), r.text.slice(0, 200));
    const many = await rpcAs(tA, "setting:getMany", { keys: ["ui.locale", "relay.vpsConfig"] });
    eq("setting:getMany 混着要 → 200", many.status, 200);
    const result = (JSON.parse(many.text) as { result: Record<string, string | null> }).result;
    eq("放行的键照常拿到", result["ui.locale"], "en");
    eq("不放行的键是 null", result["relay.vpsConfig"], null);
  }

  // ── 写:不放行的键 403,且真的没写进去 ──
  SettingRepo.set("terminal.shell", "bash");
  {
    const r = await rpcAs(tA, "setting:set", { key: "terminal.shell", value: "evil.exe" });
    eq("setting:set terminal.shell → 403", r.status, 403);
    eq("终端 shell 没被改", SettingRepo.get("terminal.shell"), "bash");
    const rv = await rpcAs(tA, "setting:set", { key: "workflow.review.v1.wf_x", value: "{}" });
    eq("setting:set 工作流审查记录 → 403(workflow. 前缀不整体放行)", rv.status, 403);
    eq("审查记录没被伪造", SettingRepo.get("workflow.review.v1.wf_x"), null);
    const np = await rpcAs(tA, "setting:set", { key: "workflow.nodePrefs.wf_x", value: "{}" });
    eq("setting:set workflow.nodePrefs.<id> → 200", np.status, 200);
    const dl = await rpcAs(tA, "setting:set", { key: "ui.displayMode", value: "tabs" });
    eq("设备本地键(网页壳本不该发来)→ 403", dl.status, 403);
  }

  // ── 同步:甲写强调色 → 桌面和乙收到,甲收不到自己的回声 ──
  windowStub.__setDesktopAttached(true);
  const open = async (tok: string) => {
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/api/events?token=${encodeURIComponent(tok)}`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const state = { buf: "" };
    const until = async (needle: string, ms = 3000): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !state.buf.includes(needle)) {
        const r = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now())),
          ),
        ]);
        if (r.done) break;
        state.buf += dec.decode(r.value, { stream: true });
      }
      return state.buf.includes(needle);
    };
    return { ctrl, state, until };
  };
  const sa = await open(tA);
  const sb = await open(tB);
  check("甲的快照到了", await sa.until("runningSnapshot"));
  check("乙的快照到了", await sb.until("runningSnapshot"));
  check("快照带 desktopAttached:true(桌面窗口在)", sa.state.buf.includes('"desktopAttached":true'), sa.state.buf.slice(0, 300));

  windowStub.resetSent();
  const w = await rpcAs(tA, "setting:set", { key: "ui.accentColor", value: "10 20 30" });
  eq("甲写强调色 → 200", w.status, 200);
  check("乙收到 setting.changed", await sb.until('"setting.changed"'), sb.state.buf.slice(-300));
  check("乙收到的是那个值", sb.state.buf.includes("10 20 30"));
  const toDesktop = windowStub.sent.filter((x) => JSON.stringify(x.args).includes('"setting.changed"'));
  eq("桌面渲染端也收到一条", toDesktop.length, 1);
  // 甲:发一条探针事件,读到探针为止 —— 探针之前不许出现 setting.changed。
  mobileEventBus.broadcast({ type: "session.title", sessionId: "probe", title: "探针" } as never);
  check("甲读到了探针", await sa.until("探针"));
  check("甲没收到自己的回声", !sa.state.buf.includes('"setting.changed"'), sa.state.buf.slice(-300));

  // 非同步键(共享但不实时推)不广播。
  windowStub.resetSent();
  await rpcAs(tA, "setting:set", { key: "ui.composerModel", value: "{}" });
  mobileEventBus.broadcast({ type: "session.title", sessionId: "probe2", title: "探针二" } as never);
  check("乙读到探针二", await sb.until("探针二"));
  check("ui.composerModel 不广播", (sb.state.buf.match(/"setting\.changed"/g) ?? []).length === 1);

  // ── 项目行变动广播 projects.changed;系统项目删不掉 ──
  const reorder = await rpcAs(tA, "project:reorder", { orderedIds: [] });
  eq("project:reorder → 200", reorder.status, 200);
  check("乙收到 projects.changed", await sb.until('"projects.changed"'), sb.state.buf.slice(-300));
  const { SYSTEM_AUTOMATION_PROJECT_ID } = await import("@main/store/repositories.js");
  const del = await rpcAs(tA, "project:delete", { id: SYSTEM_AUTOMATION_PROJECT_ID });
  eq("手机删系统项目 → 403(与桌面同一道守卫)", del.status, 403);

  sa.ctrl.abort();
  sb.ctrl.abort();
  windowStub.__setDesktopAttached(false);
  await new Promise((r) => setTimeout(r, 50));
}

/* ────────────── 7c. 手机 RPC 必须转发桌面 handler 的每一个字段 ──────────────
 *
 * 手机 RPC 与桌面 IPC 是**两条独立实现**。桌面那条 handler 支持的每个字段,手机这条
 * 漏掉一个,表现就是「界面上改成功了、库里没变」—— 因为手机端是**乐观更新**(先改缓存
 * 再等回执),而这条路径连拒绝都不给。共享的 `ChatPane` 在手机上也挂
 * `WorktreeModeChip` / `SessionDirectoryChip`,那两个控件调的正是这些字段。
 */
console.log("\n设置转发:updateSettings 的 envMode / wtStyle / projectId");

/** 配一台新设备并返回它的令牌 —— 上面那段里的 `pairDevice` 是块级作用域。 */
async function pairFresh(name: string): Promise<string> {
  const st = pairingManager.startPairing(ENDPOINT, { force: true });
  const r = await req("/api/pair/verify", { method: "POST", body: { nonce: st.nonce, code: st.code, deviceName: name } });
  const tok = (JSON.parse(r.text) as { deviceToken: string }).deviceToken;
  issuedSecrets.push(tok);
  return tok;
}
const rpcTok = (tok: string, method: string, input: unknown) =>
  req("/api/rpc", { method: "POST", token: tok, body: { method, input } });
const tA = await pairFresh("转发断言");

{
  const { ProjectRepo, SessionRepo } = await import("@main/store/repositories.js");

  const mkProj = (id: string, path: string): void => {
    const now = Date.now();
    ProjectRepo.create({ id, name: id, path, archived: false, pinnedAt: null, sortOrder: 0, createdAt: now, updatedAt: now } as never);
  };
  const mkSess = (id: string, projectId: string, over: Record<string, unknown> = {}): void => {
    const now = Date.now();
    SessionRepo.create({
      id, projectId, providerId: "claude-sdk", claudeSessionId: null, kind: "chat",
      parentSessionId: null, nodeId: null, title: "New session", status: "idle",
      model: "default", effort: "default", permissionMode: "default", workflowId: "default",
      customModelId: null, envMode: "local", worktreePath: null, archived: false, pinnedAt: null,
      contextSnapshot: null, todos: null, subagents: null, planDraft: null, turnFiles: null,
      usageHistory: null, bookmarks: null, subagentTranscripts: null, createdAt: now, updatedAt: now,
      ...over,
    } as never);
  };

  const pathA = mkdtempSync(join(tmpdir(), "mcode-mobile-rpc-proj-a-"));
  const pathB = mkdtempSync(join(tmpdir(), "mcode-mobile-rpc-proj-b-"));
  mkProj("mp_a", pathA);
  mkProj("mp_b", pathB);
  mkSess("ms_env", "mp_a");
  mkSess("ms_move", "mp_a");

  // 环境意图(WorktreeModeChip 的 setEnvChoice)——这是手机端也渲染的共用控件。
  const envRes = await rpcTok(tA, "session:updateSettings", { sessionId: "ms_env", envMode: "worktree", wtStyle: "branch" });
  eq("手机 updateSettings(envMode/wtStyle) → 200", envRes.status, 200);
  const afterEnv = SessionRepo.get("ms_env");
  eq("envMode 真的落库了(不是只改了前端缓存)", afterEnv?.envMode, "worktree");
  eq("wtStyle 真的落库了", afterEnv?.wtStyle, "branch");

  // 目录再瞄准(SessionDirectoryChip 的 moveSession)。
  const moveRes = await rpcTok(tA, "session:updateSettings", { sessionId: "ms_move", projectId: "mp_b" });
  eq("手机 updateSettings(projectId) → 200", moveRes.status, 200);
  eq("会话真的挪到目标项目了", SessionRepo.get("ms_move")?.projectId, "mp_b");

  // 已经物化在 worktree 里的会话不许再改环境(与桌面同一条守卫)。
  mkSess("ms_locked", "mp_a", { envMode: "worktree", worktreePath: pathA });
  const locked = await rpcTok(tA, "session:updateSettings", { sessionId: "ms_locked", envMode: "local" });
  eq("已物化的会话改 envMode 被拒(整条拒,不是悄悄忽略)", locked.status === 200, false);

  rmSync(pathA, { recursive: true, force: true });
  rmSync(pathB, { recursive: true, force: true });
}

/* ────────────── 7d. sentinel 回答必须落在会话自己的工作树里 ──────────────
 *
 * 兜底路径(native AskUserQuestion 不可用时)的答案会作为**新一轮提示词**发出去。
 * 桌面 handler 用的是 `session.worktreePath ?? project.path`;手机这条如果写成
 * `project.path`,那么一条跑在隔离工作树里的会话、从手机上回答那个问题,这一轮会被
 * 送进**用户的主检出** —— agent 的编辑落错地方,而没有任何提示。
 */
console.log("\nsentinel 回答的工作目录");

{
  const { ProjectRepo, SessionRepo } = await import("@main/store/repositories.js");
  const { turnCwds } = (await import("@main/claude/RuntimeManager.js")) as unknown as {
    turnCwds: Array<{ sessionId: string; cwd: string }>;
  };
  const pathW = mkdtempSync(join(tmpdir(), "mcode-mobile-sentinel-proj-"));
  const wtDir = mkdtempSync(join(tmpdir(), "mcode-mobile-sentinel-wt-"));
  const now = Date.now();
  ProjectRepo.create({ id: "sp_p", name: "sp_p", path: pathW, archived: false, pinnedAt: null, sortOrder: 0, createdAt: now, updatedAt: now } as never);
  SessionRepo.create({
    id: "sp_s", projectId: "sp_p", providerId: "claude-sdk", claudeSessionId: null, kind: "chat",
    parentSessionId: null, nodeId: null, title: "工作树会话", status: "idle",
    model: "default", effort: "default", permissionMode: "default", workflowId: "default",
    customModelId: null, envMode: "worktree", worktreePath: wtDir, archived: false, pinnedAt: null,
    contextSnapshot: null, todos: null, subagents: null, planDraft: null, turnFiles: null,
    usageHistory: null, bookmarks: null, subagentTranscripts: null, createdAt: now, updatedAt: now,
  } as never);

  turnCwds.length = 0;
  const ans = await rpcTok(tA, "claude:respondQuestion", {
    sessionId: "sp_s",
    requestId: "sentinel_smoke_1",
    answers: { "要不要继续?": "继续" },
  });
  eq("sentinel 回答 → 200", ans.status, 200);
  const sent = turnCwds.find((c) => c.sessionId === "sp_s");
  check("sentinel 回答这一轮跑在工作树里,不是主检出", sent?.cwd === wtDir, sent);

  rmSync(pathW, { recursive: true, force: true });
  rmSync(wtDir, { recursive: true, force: true });
}

/* ────────────── 7e. discoverRepos 的 rootOnly 必须转发 ──────────────
 *
 * 桌面 `git:discoverRepos` 认 `rootOnly`(工作树选择器要的是"项目根自己是不是仓库",
 * 因为工作树只能在根上物化)。手机这条漏掉它,共用控件 `WorktreeModeChip` 就会把
 * "某个子目录是仓库"误当成"项目根是仓库",点出来一个**注定退化成本地**的选项。
 */
console.log("\ndiscoverRepos:rootOnly");

{
  // git:* handlers are normally registered when the server starts
  // (`startMobileServer` → registerMobileGitRpc). This suite builds its own
  // handler, so register them here.
  const { registerMobileGitRpc } = await import("@main/mobile/mobileGitRpc.js");
  registerMobileGitRpc();

  const { ProjectRepo } = await import("@main/store/repositories.js");
  const rootNoRepo = mkdtempSync(join(tmpdir(), "mcode-mobile-norepo-"));
  mkdirSync(join(rootNoRepo, "nested", ".git"), { recursive: true });
  const now = Date.now();
  ProjectRepo.create({ id: "nr_p", name: "nr_p", path: rootNoRepo, archived: false, pinnedAt: null, sortOrder: 0, createdAt: now, updatedAt: now } as never);

  const recursive = await rpcTok(tA, "git:discoverRepos", { projectPath: rootNoRepo });
  const recursiveRepos = (JSON.parse(recursive.text) as { result: { repos: unknown[] } }).result.repos;
  check("递归扫描找得到子目录里的仓库(前提成立)", recursiveRepos.length === 1, recursiveRepos);

  const rootOnly = await rpcTok(tA, "git:discoverRepos", { projectPath: rootNoRepo, rootOnly: true });
  const rootOnlyRepos = (JSON.parse(rootOnly.text) as { result: { repos: unknown[] } }).result.repos;
  eq("rootOnly 时项目根不是仓库 → 返回空(与桌面一致)", rootOnlyRepos.length, 0);

  rmSync(rootNoRepo, { recursive: true, force: true });
}

/* ────────────── 7f. generateCommitMessage 的 scope 必须转发 ──────────────
 *
 * 桌面 `git:generateCommitMessage`(`ipc/git.ts`)把 `scope` 转给共享核心
 * `generateCommitMessageForRepo`;手机这条一开始漏了它。`scope: "worktree"` 走的是
 * `git diff HEAD`(未暂存 + 已暂存全都要),默认 `staged` 走 `git diff --cached`(只看
 * 索引)。共享对话框 `WorktreeMergeBack` 正是拿整个工作树去生成 —— 手机这条漏掉 scope
 * 就会退化成 `--cached`,而工作树里 agent 的改动**常常还没 `git add`**,于是"生成提交
 * 信息"直接回"没有已暂存的更改"。
 *
 * 判别法:在**干净**仓库上两条路的错误串不同 —— worktree 说"没有未提交的更改",
 * staged 说"没有已暂存的更改"。断言错误串就等价于断言 scope 到没到。全程不调模型
 * (diff 为空时提前返回)。
 */
console.log("\ngenerateCommitMessage:scope 转发");

{
  const { registerMobileGitRpc } = await import("@main/mobile/mobileGitRpc.js");
  const { ProjectRepo } = await import("@main/store/repositories.js");
  const repo = mkdtempSync(join(tmpdir(), "mcode-mobile-genmsg-"));
  // pathGuard 通过 ProjectRepo 认这个仓库,所以先登记成项目。
  const now = Date.now();
  ProjectRepo.create({ id: "gm_p", name: "gm_p", path: repo, archived: false, pinnedAt: null, sortOrder: 0, createdAt: now, updatedAt: now } as never);
  const g = (...args: string[]) => execFileSync("git", args, {
    cwd: repo, encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "s@smoke", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "s@smoke" },
  });
  g("init", "-q", "-b", "main");
  g("commit", "--allow-empty", "-qm", "init"); // 需要 HEAD 才谈得上 worktree 那路 diff
  registerMobileGitRpc();

  const base = { repoPath: repo, customModelId: null, customModelRole: null, prompt: "x" };
  const worktree = JSON.parse((await rpcTok(tA, "git:generateCommitMessage", { ...base, scope: "worktree" })).text) as { result: { ok: boolean; error?: string } };
  eq("干净仓库 + scope:worktree → ok:false", worktree.result.ok, false);
  check("scope:worktree 走的是 worktree 那路(错误串为『未提交』)", /未提交/.test(worktree.result.error ?? ""), worktree.result);

  const staged = JSON.parse((await rpcTok(tA, "git:generateCommitMessage", { ...base })).text) as { result: { ok: boolean; error?: string } };
  eq("干净仓库 + 默认 scope → ok:false", staged.result.ok, false);
  check("默认 scope 走 staged 那路(错误串为『已暂存』)", /已暂存/.test(staged.result.error ?? ""), staged.result);

  rmSync(repo, { recursive: true, force: true });
}

/* ────────────── 7g. 本轮工作流的覆盖值必须先落进 updated ──────────────
 *
 * 输入框把 `workflowId` 经 `session.updateSettings` 落库是 **fire-and-forget**,
 * 与 `claude:sendTurn` 抢跑。桌面 handler(`ipc/claude.ts`)因此把 `input.workflowId`
 * 在**内存里**打进 `updated`,再交给 `graphRunIntent`;手机这条一开始漏了这一句 ——
 * 行还没落地时读到的是旧的 `"default"`,用户选好的工作流**静默退化成普通回合**。
 *
 * 判别法:库里的行存 `default`,这一轮传 `read`(提示词型、非图,走普通回合那条路)。
 * 桩记下 `sendTurn` 收到的 `session.workflowId` —— 覆盖值没打进去就是 `default`。
 */
console.log("\n本轮工作流覆盖值");

{
  const { ProjectRepo, SessionRepo } = await import("@main/store/repositories.js");
  const { turnCwds } = (await import("@main/claude/RuntimeManager.js")) as unknown as {
    turnCwds: Array<{ sessionId: string; cwd: string; workflowId: string }>;
  };
  const pathT = mkdtempSync(join(tmpdir(), "mcode-mobile-wf-proj-"));
  const now = Date.now();
  ProjectRepo.create({ id: "wf_p", name: "wf_p", path: pathT, archived: false, pinnedAt: null, sortOrder: 0, createdAt: now, updatedAt: now } as never);
  SessionRepo.create({
    id: "wf_s", projectId: "wf_p", providerId: "claude-sdk", claudeSessionId: null, kind: "chat",
    parentSessionId: null, nodeId: null, title: "New session", status: "idle",
    model: "default", effort: "default", permissionMode: "default",
    // ★ 库里的行是旧的 `default` —— 模拟"落库那条 RPC 还没到"。
    workflowId: "default",
    customModelId: null, envMode: "local", worktreePath: null, archived: false, pinnedAt: null,
    contextSnapshot: null, todos: null, subagents: null, planDraft: null, turnFiles: null,
    usageHistory: null, bookmarks: null, subagentTranscripts: null, createdAt: now, updatedAt: now,
  } as never);

  turnCwds.length = 0;
  const sent = await rpcTok(tA, "claude:sendTurn", { sessionId: "wf_s", prompt: "读一下这篇", workflowId: "read" });
  eq("带 workflowId 的 sendTurn → 200", sent.status, 200);
  const rec = turnCwds.find((c) => c.sessionId === "wf_s");
  eq(
    "★ 本轮选的工作流打进这一轮了(不是库里的旧 default)",
    rec?.workflowId,
    "read",
  );

  rmSync(pathT, { recursive: true, force: true });
}

/* ────────────── 7h. 回滚的返回形状:三个数组必须平铺 ──────────────
 *
 * `RuntimeManager.rewindTurn` 返回 `{ restored, failed, conflicts }`(MC-002 加了
 * `conflicts`)。桌面 `ipc/claude.ts` 正确平铺返回,而手机 handler 从前写成
 * `const restored = await rewindTurn(...); return { restored };` —— 实际发出去的是
 * `{restored:{restored:[...],failed:[...],conflicts:[...]}}`。手机 webApi 再转一手,
 * 渲染端 `TurnFilesCard` 解构 `failed` / `conflicts` 得到 `undefined`,`undefined.length`
 * 直接 TypeError —— **手机回滚后卡片不报冲突/失败,静默画成"已撤销"**。
 *
 * 判据立在"客户端拿到的 JSON 形状"上:三个数组必须各自平铺在顶层。
 */
console.log("\n回滚返回形状");

{
  const res = await rpcTok(tA, "claude:rewindTurn", {
    sessionId: "rw_s",
    files: [
      { filePath: "a.ts", kind: "modified", adds: 3, dels: 1, before: "原内容" },
    ],
    targetFiles: ["a.ts", "REW_B"],
  });
  eq("手机 rewindTurn → 200", res.status, 200);
  const result = (JSON.parse(res.text) as { result: { restored?: unknown; failed?: unknown; conflicts?: unknown } }).result;
  same("restored 平铺在顶层(不是把整个对象套进 restored)", result.restored, ["REW_A", "REW_B"]);
  same("★ failed 平铺在顶层(缺了就是 undefined.length 崩溃)", result.failed, ["REW_FAIL"]);
  same("★ conflicts 平铺在顶层(缺了就是 undefined.length 崩溃)", result.conflicts, ["REW_CONFLICT"]);
}

/* ────────────── 7i. 更新不存在的会话必须报错,不能假成功 ──────────────
 *
 * MC-048:只提供普通字段(model / permissionMode…)时,更新路径从前**不确认 sessionId
 * 存在**。`updateSettings` 直接 `UPDATE … WHERE id=?`,打不中任何行也静默成功;手机
 * handler 无值时 `return {ok:true}`。于是一条**已经删掉的**会话从手机上"改"设置会回
 * 一个假 `ok:true`,界面以为改成功了。现在 `SessionRepo.updateSettings` 用
 * affectedRows 判存在性,不存在就抛 → 手机 RPC 回 `ok:false`。
 *
 * 判据立在"用户看到的那个回执"上:不存在 → ok:false;真实存在 → ok:true 且落库。
 */
console.log("\n更新不存在的会话");

{
  const { ProjectRepo, SessionRepo } = await import("@main/store/repositories.js");
  const pathU = mkdtempSync(join(tmpdir(), "mcode-mobile-us-proj-"));
  const now = Date.now();
  ProjectRepo.create({ id: "us_p", name: "us_p", path: pathU, archived: false, pinnedAt: null, sortOrder: 0, createdAt: now, updatedAt: now } as never);
  SessionRepo.create({
    id: "us_s", projectId: "us_p", providerId: "claude-sdk", claudeSessionId: null, kind: "chat",
    parentSessionId: null, nodeId: null, title: "New session", status: "idle",
    model: "default", effort: "default", permissionMode: "default", workflowId: "default",
    customModelId: null, envMode: "local", worktreePath: null, archived: false, pinnedAt: null,
    contextSnapshot: null, todos: null, subagents: null, planDraft: null, turnFiles: null,
    usageHistory: null, bookmarks: null, subagentTranscripts: null, createdAt: now, updatedAt: now,
  } as never);

  // 删掉它,再从手机上"改"设置 —— 必须回 ok:false,不是假 ok:true。
  SessionRepo.delete("us_s");
  const gone = await rpcTok(tA, "session:updateSettings", { sessionId: "us_s", model: "新模型" });
  const goneEnv = JSON.parse(gone.text) as { ok: boolean; error?: string };
  eq("★ 改一条已删除的会话:回执是 ok:false(不是假 ok:true)", goneEnv.ok, false);
  check("★ 拒绝理由点明了会话没了", (goneEnv.error ?? "").includes("unknown session"), goneEnv.error);
  eq("★ 而且它是个 4xx/5xx(不是 200)", gone.status === 200, false);

  // 顺带:permissionMode 那条普通字段也一样(它走的是同一个 handler)。
  const gonePerm = await rpcTok(tA, "session:updateSettings", { sessionId: "us_s", permissionMode: "acceptEdits" });
  eq("★ permissionMode 同样拒绝已删除会话", (JSON.parse(gonePerm.text) as { ok: boolean }).ok, false);

  // 反面:真实存在的会话照常更新并落库(不能被存在性检查误伤)。
  // 上面那条已删,重建一条存在的来验落库。
  SessionRepo.create({
    id: "us_s2", projectId: "us_p", providerId: "claude-sdk", claudeSessionId: null, kind: "chat",
    parentSessionId: null, nodeId: null, title: "New session", status: "idle",
    model: "default", effort: "default", permissionMode: "default", workflowId: "default",
    customModelId: null, envMode: "local", worktreePath: null, archived: false, pinnedAt: null,
    contextSnapshot: null, todos: null, subagents: null, planDraft: null, turnFiles: null,
    usageHistory: null, bookmarks: null, subagentTranscripts: null, createdAt: now, updatedAt: now,
  } as never);
  const live = await rpcTok(tA, "session:updateSettings", { sessionId: "us_s2", model: "落库的模型" });
  eq("存在的会话更新 → 200", live.status, 200);
  eq("存在的会话真的落库了", SessionRepo.get("us_s2")?.model, "落库的模型");

  rmSync(pathU, { recursive: true, force: true });
}

/* ───────────────────── 8. 出厂状态 ───────────────────── */

console.log("\n收尾");

/* ───────────────────── 8. 账号密码登录 ─────────────────────
 *
 * 第二种进门方式:电脑端设好账号密码,手机打开地址直接登录,拿到和配对**一样**的
 * 设备令牌。钉住:未开启时进不来;库里不存明文;错了不发令牌;连错会锁(且不因为
 * 密码对了就放行);手机读不到凭据键;关掉之后新登录进不来、已登录的不受影响。
 */

console.log("\n账号密码登录");

{
  const login = await import("@main/mobile/mobileLogin.js");
  const PW = "correct horse 9";
  const loginReq = (body: unknown, headers?: Record<string, string>) =>
    req("/api/auth/login", { method: "POST", body, headers });
  login.resetLoginThrottle();

  const m0 = await req("/api/auth/methods");
  eq("未设置时 methods.password = false", (JSON.parse(m0.text) as { password: boolean }).password, false);
  eq("未设置时登录 → 401", (await loginReq({ username: "alice", password: PW })).status, 401);

  await login.setMobileLogin("alice", PW);
  const raw = SettingRepo.get("mobile.passwordLogin") ?? "";
  check("库里只有哈希,没有明文密码", raw.includes('"hash"') && !raw.includes(PW), raw.slice(0, 80));
  const m1 = await req("/api/auth/methods");
  eq("设置后 methods.password = true", (JSON.parse(m1.text) as { password: boolean }).password, true);
  check("methods 不泄露账号名", !m1.text.includes("alice"), m1.text);

  eq("密码错 → 401", (await loginReq({ username: "alice", password: "wrong-password" })).status, 401);
  eq("账号错 → 401", (await loginReq({ username: "bob", password: PW })).status, 401);
  eq("缺密码 → 400", (await loginReq({ username: "alice" })).status, 400);

  login.resetLoginThrottle();
  const ok = await loginReq({ username: "alice", password: PW, deviceName: "密码手机" });
  eq("账号密码正确 → 200", ok.status, 200);
  const tok = (JSON.parse(ok.text) as { deviceToken: string }).deviceToken;
  issuedSecrets.push(tok);
  check("登录的手机进了设备列表", (await pairingManager.listDevices()).some((d) => d.name === "密码手机"));
  eq("登录拿到的令牌能过 RPC", (await req("/api/rpc", { method: "POST", token: tok, body: RPC_OK_BODY })).status, 200);
  const peek = await req("/api/rpc", {
    method: "POST",
    token: tok,
    body: { method: "setting:get", input: { key: "mobile.passwordLogin" } },
  });
  eq("手机读不到登录凭据键 → 403", peek.status, 403);
  const poke = await req("/api/rpc", {
    method: "POST",
    token: tok,
    body: { method: "setting:set", input: { key: "mobile.passwordLogin", value: "{}" } },
  });
  eq("手机改不了登录凭据键 → 403", poke.status, 403);

  login.resetLoginThrottle();
  for (let i = 0; i < 5; i += 1) await loginReq({ username: "alice", password: `wrong-${i}-xxxx` });
  const locked = await loginReq({ username: "alice", password: PW });
  eq("连错 5 次后锁定:密码对了也 429", locked.status, 429);
  check("锁定时不发令牌", !locked.text.includes("deviceToken"), locked.text.slice(0, 120));

  // ── MC-016:直连时伪造来源头换不掉身份 ──────────────────────────────────
  // 未配置可信代理(默认空)时,`cf-connecting-ip` / `x-forwarded-for` 一律被忽略,来源
  // 就是**套接字地址**。于是伪造一串 CF 头轮换 key 也绕不开同一把来源锁 —— 这一发密码
  // 是对的,仍必须被这台来源的锁挡下。(旧代码无条件认 CF 头 → 换 key → 放行 200。)
  const forged = await loginReq({ username: "alice", password: PW, deviceName: "伪造头" }, { "cf-connecting-ip": "6.6.6.6" });
  eq("★ 直连伪造 CF 头换不掉身份,仍被本来源的锁挡下 → 429", forged.status, 429);
  check("★ 伪造头也没换来令牌", !forged.text.includes("deviceToken"), forged.text.slice(0, 120));

  // ── MC-016:并发失败不能全数绕过前置限流(配额原子预留) ──────────────────
  // 旧代码只在 scrypt **之后**记录,一批并发请求会在任何一次 scrypt 出结果前全部通过
  // 锁定检测。现在配额在进 scrypt **之前**原子预留,超出免费额度的当场 429。
  login.resetLoginThrottle();
  const burst = await Promise.all(
    Array.from({ length: 20 }, (_, i) => loginReq({ username: "alice", password: `burst-${i}-wrong` })),
  );
  const burst429 = burst.filter((r) => r.status === 429).length;
  const burst401 = burst.filter((r) => r.status === 401).length;
  eq("★ 并发 20 次失败认证:响应合计 20", burst429 + burst401, 20);
  check("★ 有一批在进 scrypt 之前就被限流挡下(429)", burst429 >= 1, { burst429, burst401 });
  check("★ 不是 20 次全部跑到 scrypt(旧行为是 20)", burst401 <= 8, { burst401 });

  // ── MC-016:可信代理配置下,转发头才被采信 ──────────────────────────────
  // 只有当直连来源本身写进可信代理白名单,才读转发头 —— 这时不同的 XFF 才是不同来源。
  SettingRepo.set("mobile.login.trustedProxy", "127.0.0.1");
  login.resetLoginThrottle();
  for (let i = 0; i < 5; i += 1) await loginReq({ username: "alice", password: `tp-${i}-wrong` }, { "x-forwarded-for": "10.1.1.1" });
  eq("★ 可信代理下:来源 A 连错 5 次后密码对了也 429", (await loginReq({ username: "alice", password: PW }, { "x-forwarded-for": "10.1.1.1" })).status, 429);
  const otherOrigin = await loginReq({ username: "alice", password: PW, deviceName: "另一来源" }, { "x-forwarded-for": "10.1.1.2" });
  eq("★ 可信代理下:来源 B 不受 A 的锁影响 → 200", otherOrigin.status, 200);
  if (otherOrigin.status === 200) issuedSecrets.push((JSON.parse(otherOrigin.text) as { deviceToken: string }).deviceToken);
  SettingRepo.set("mobile.login.trustedProxy", "");

  login.resetLoginThrottle();
  login.clearMobileLogin();
  eq("关闭后 methods.password = false", (JSON.parse((await req("/api/auth/methods")).text) as { password: boolean }).password, false);
  eq("关闭后登录 → 401", (await loginReq({ username: "alice", password: PW })).status, 401);
  eq("关闭后已登录的令牌仍可用(要踢走撤销)", (await req("/api/rpc", { method: "POST", token: tok, body: RPC_OK_BODY })).status, 200);
}

// 全部撤销,把库清干净(数据根是临时目录,整个删掉;这里只是让收尾状态可读)。
{
  const list = await pairingManager.listDevices();
  for (const d of list) await pairingManager.revokeDevice(d.deviceId);
}
eq("收尾:设备清单空了", (await pairingManager.listDevices()).length, 0);

// —— 渲染端:断开设备失败必须报出来(源码不变量,组件在无头下跑不出来)——
// `MobileConnectDialog.handleRevoke` 从前只 `console.error`,而 `mobile.revokeDevice`
// 会抛(zod 失败 / 主进程 IO 失败)—— 用户点了「断开该设备」,那台手机还连着、屏幕上一个
// 字都没有,而这是个安全动作(他以为踢掉了)。判据钉在源码上:失败分支必须把错报出来。
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src/renderer/components/layout/MobileConnectDialog.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // handleRevoke 体内必须有一段 `catch (...) { ... useToastStore...push(...) }`
  const revoke = code.slice(code.indexOf("handleRevoke"));
  const body = revoke.slice(0, revoke.indexOf("\n  );"));
  check(
    "★ 断开设备失败会报出来(不是只 console.error)",
    /catch[^)]*\)\s*\{[\s\S]*?useToastStore[\s\S]*?push\(/.test(body) && body.includes("layout.revokeDeviceFailed"),
    body.slice(0, 300),
  );
}

// —— 渲染端:远程面板两处静默 catch 也要报出来(同一类,同一套判据)——
// `RemoteConnectPanel` 里两处 `catch` 从前只有 `console.error`:
//   1. `generatePairing` —— 失败时面板停在「已连接」、二维码那格永远"生成中…",
//      用户对着一台连上了却拿不到码的机器毫无线索;
//   2. `handleAutoStartChange` —— 开关**乐观翻转**,写库失败却静默:开关停在用户
//      拨过去的位置,下次启动才发现没生效。
// 两处都在没有别处展示错误的位置,所以必须走 toast。判据同样钉在源码上。
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src/renderer/components/mobile/RemoteConnectPanel.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [fn, key] of [
    ["generatePairing", "mobile.relay.pairingFailed"],
    ["handleAutoStartChange", "mobile.relay.autoStartFailed"],
  ] as const) {
    const at = code.indexOf(fn);
    const body = code.slice(at, code.indexOf("\n  },", at));
    check(
      `★ ${fn} 的失败会报出来(不是只 console.error)`,
      at >= 0 && /catch[^)]*\)\s*\{[\s\S]*?useToastStore[\s\S]*?push\(/.test(body) && body.includes(key),
      body.slice(0, 300),
    );
  }
  // 乐观翻转的后半句:写失败要把开关拨回去,否则 UI 与落库状态不一致。
  {
    const at = code.indexOf("handleAutoStartChange");
    const body = code.slice(at, code.indexOf("\n  },", at));
    check("★ autoStart 写失败会把开关拨回原值", /setAutoStart\(!checked\)/.test(body), body.slice(0, 300));
  }
  // 两个页签的「复制链接」都只把成功当成功 —— 失败静默 = 用户以为拷到了。
  {
    const at = code.indexOf("const copyLink");
    const body = code.slice(at, code.indexOf("\n  },", at));
    check(
      "★ 远程页签复制链接失败会报出来",
      at >= 0 && /else[\s\S]*?useToastStore[\s\S]*?push\(/.test(body) && body.includes("layout.image.copyFailed"),
      body.slice(0, 300),
    );
  }
}

// —— 局域网页签(默认页签)的同一处:生成失败 / 复制失败都要报出来 ——
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src/renderer/components/layout/MobileConnectDialog.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  {
    const at = code.indexOf("const beginPairing");
    const body = code.slice(at, code.indexOf("\n  },", at));
    check(
      "★ 局域网页签生成配对码失败会报出来(不是只 console.error)",
      at >= 0 && /catch[^)]*\)\s*\{[\s\S]*?useToastStore[\s\S]*?push\(/.test(body) && body.includes("layout.pairingFailed"),
      body.slice(0, 300),
    );
  }
  {
    const at = code.indexOf("const copyPairingLink");
    const body = code.slice(at, code.indexOf("\n  },", at));
    check(
      "★ 局域网页签复制链接失败会报出来",
      at >= 0 && /else[\s\S]*?useToastStore[\s\S]*?push\(/.test(body) && body.includes("layout.image.copyFailed"),
      body.slice(0, 300),
    );
  }
}

// —— 渲染端:手机抽屉的行操作失败必须报出来(源码不变量,组件无头跑不出来) ——
// `MobileSessionDrawer` 里每一处行操作(置顶/改名/归档/删除,会话与项目)、新建会话、
// 跨项目点会话、加载更多,从前都是裸 `void setSessionPinned(...)` 之类 —— 而这些 RPC
// **会抛**(zod 失败 / 那行已不在 / 主进程 IO 失败),手机壳又**没有**全局
// unhandledrejection 监听:抛出去只落进 unhandled rejection,用户点了「删除」、那一行
// 还在,屏幕上一个字都没有。抽屉是手机上这些操作的**唯一**入口,没有别处能画这个错。
// 判据钉源码:每一处用户动作都必须接到同一个 `reportActionFailure`(它走 toast)。
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src/renderer/components/mobile/MobileSessionDrawer.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // 出口本体:push 到 toast,且用抽屉自己的键(不能在手机上弹一句空白)。
  check(
    "★ 手机抽屉有共享失败出口(reportActionFailure 走 toast)",
    /const reportActionFailure = useCallback\(\s*\(err[^)]*\) => \{[\s\S]*?useToastStore\.getState\(\)\.push\([\s\S]*?mobile\.drawer\.actionFailed/.test(code),
    code.match(/reportActionFailure[^\n]*/g),
  );
  // 每一处用户动作都要接到它。10 处:`pickSession` / `startSession` / `loadMoreSessions`
  // / pin / archive(true) / archive(false) / deleteSession / archiveProject(false)
  // / deleteProject / renameSession。少接一处就是一个静默的"点了没反应"。
  const wired = (code.match(/\.catch\(reportActionFailure\)/g) ?? []).length;
  check(
    "★ 手机抽屉全部 10 处行操作都接了失败出口(少一处就是一次静默)",
    wired === 10,
    { wired },
  );
}

// —— 渲染端:手机文件查看器空文件要说出来(与桌面孪生同一条判据) ——
// `file.readFile` 对空文件与二进制退回的都是空串(见 `readFileGuarded`),`MobileFileViewer`
// 从前一律渲染成一片白 —— 与"预览坏了"长得一模一样。桌面两个孪生
// (`library/FileViewer` / `library/FilePreview`)早就用 `templates.preview.emptyFile`
// 说出来,只有手机这处没守。判据钉源码。
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src/renderer/components/mobile/MobileFileViewer.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check(
    "★ 手机文件查看器空文件会说「是空的」(不是一片白,与桌面孪生一致)",
    /content\.trim\(\)\.length === 0/.test(code) && code.includes("templates.preview.emptyFile"),
    code.match(/emptyFile[^\n]*/g),
  );
}

// —— 手机设置卡换主题:落盘失败要说出来(与桌面同一条规矩) ——
// `pickTheme` 先 `setTheme(next)` 乐观改了卡片外观,再 `api.theme.set` 落盘。落盘那步
// 从前只 `.then(applyThemeClass)` —— 写盘失败时用户以为换好了,下次打开又弹回旧主题。
// 桌面端 `uiPrefs.persist` / `sessionStore` 那批外观 setter 早走同一个 toast 出口,手机这处漏了。
// 判据钉源码(组件挂在手机壳的独立树上,无头跑不出这次点击)。
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src/renderer/components/mobile/MobileSettingsSheet.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const at = code.indexOf("const pickTheme = (");
  const body = code.slice(at, code.indexOf("\n  };", at));
  check(
    "★ 手机设置卡换主题落盘失败走 toast(不再静默弹回)",
    at >= 0 && /\.catch\(/.test(body) && /useToastStore\.getState\(\)\.push\(/.test(body) && body.includes("mobile.settings.themeChangeFailed"),
    body.slice(0, 320),
  );
}

// —— 手机隧道面板的 4s 轮询:慢回包不许盖掉新一轮 ——
// `MobileDomainPanel` 每 4 秒 `getTunnel` 一次;没有序号守卫的话,弱网/主进程卡一下时
// 先发后回的那次会把新状态盖成旧的(隧道已连上却显示"未连接")。仓库里同类轮询都补了
// *Seq 守卫(GitPanel.scanSeqRef / TaskListPanel.refreshSeqRef),这里补齐同一份。
// 判据钉源码(组件挂在手机壳的独立树上,无头跑不出这次轮询)。
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src/renderer/components/mobile/MobileDomainPanel.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const at = code.indexOf("const load = async (first");
  const body = code.slice(at, code.indexOf("void load(true)", at));
  check(
    "★ 隧道面板轮询起手自增序号",
    at >= 0 && /\+\+seq/.test(body),
    body.slice(0, 300),
  );
  check(
    "★ 回包比对序号(先发后回的轮询结果不许盖掉新的)",
    /mySeq !== seq/.test(body),
    body.slice(0, 300),
  );
}

// —— 全局泄露扫描:除"配对成功那一发"之外,**一个**令牌原文都不许出现 ——
// 只逐条看"这个响应"是不够的:令牌登记在这次会话里,漏出去的那条未必是正在看的那条。
// 所以扫的是 `req()` 攒下来的**全部**响应。
{
  const leaked: Array<{ secret: string; path: string; snippet: string }> = [];
  for (const secret of issuedSecrets) {
    const hit = allResponses.find(
      (r) => r.path !== "/api/pair/verify" && r.path !== "/api/auth/login" && r.text.includes(secret),
    );
    if (hit) leaked.push({ secret: `${secret.slice(0, 8)}…`, path: hit.path, snippet: hit.text.slice(0, 160) });
  }
  check(
    `扫过 ${allResponses.length} 个响应体(配对成功那一发按设计除外),没有一条含令牌原文`,
    leaked.length === 0,
    leaked,
  );
}

/* ────────────── 9. 健康检查在库没就绪时不能崩主进程 ──────────────
 *
 * `/api/health` 是**不鉴权**、手机端轮询最频繁的一条。它从前直接 `!!getDb()`,
 * 而 `getDb()` 在库未初始化/已拆掉时**抛** —— 同步抛在 Node 的 `request` 监听器里
 * 没有 catch 接住,能把主进程带崩。暴露窗口窄(正常生命周期里库在服务在听期间是就绪的),
 * 但与兄弟路由 `/api/auth/methods` 的守卫不一致,值得钉住。
 *
 * 判别法:真的把库关掉,再打一次 `/api/health` —— 必须照常 200,而不是让请求处理器抛出。
 * 跑完立刻重新 `initDb()` 收尾(后续没有别的断言依赖库,但保持进程状态干净)。
 */
console.log("\n健康检查:库未就绪时也不崩");

{
  const { closeDb, initDb } = await import("@main/store/db.js");
  closeDb();
  let healthStatus = 0;
  let healthText = "";
  try {
    const r = await req("/api/health");
    healthStatus = r.status;
    healthText = r.text;
  } catch (err) {
    healthText = `threw: ${(err as Error).message}`;
  }
  eq("库已关闭时 /api/health 仍照常 200(不把主进程带崩)", healthStatus, 200);
  check("且如实报 dbReady:false", /"dbReady":false/.test(healthText), healthText);

  // ★ 同一个窗口的另一条路:未知 /api 路由。请求处理器在**任何** /api/* 上都会
  //   调 `authorize()` 并把结果存进 `authPromise`,而这条落空的路由从前从不消费它。
  //   带 `Authorization` 头时 `authorize → validateToken → getDb()` 在库已拆时**抛**
  //   → 那个 `authPromise` 变成**没人接的 rejected promise** → Node 默认升级成未捕获
  //   异常,能把主进程带崩(与上面 /api/health 同一道守卫要防的东西)。
  //   用临时 `unhandledRejection` 监听器观察它 —— 监听器只是**观察**,有它在 Node 才
  //   不会当场 throw;修复在时它一条都不来(断言绿),撤掉修复它必来(断言红)。
  {
    const rejections: unknown[] = [];
    const onRejection = (r: unknown): void => { rejections.push(r); };
    process.on("unhandledRejection", onRejection);
    const probe = await req("/api/nonexistent", { token: "deadbeef" });
    await new Promise((r) => setTimeout(r, 80));
    process.off("unhandledRejection", onRejection);
    eq("库已关闭时,未知 /api 路由仍照常 404", probe.status, 404);
    const leaks = rejections.filter((r) => /getDb\(\) called before initDb/.test(String(r)));
    check(
      "★ 库已关闭时,未鉴权未知路由不会漏出没人接的 authorize() rejection",
      leaks.length === 0,
      { leaks: leaks.map(String), all: rejections.map(String) },
    );
  }

  await initDb();
}

/* ────────────── 10. 安全默认值:未显式开启就不开 LAN 服务(MC-004) ──────────────
 *
 * 从前 `readEnabled()` 是「没显式写 0 就当开」—— 全新安装、用户没做过任何选择,就已经
 * 把 `0.0.0.0` 敞在局域网上(明文 HTTP 传口令与 Bearer)。安全默认值改成**关**:只有
 * 显式存了 `mobile.enabled=1` 才开。这里直接测那个闸(不起真服务 —— 起真服务要么绑
 * 0.0.0.0 要么绑 127,前者会把跑测试的机器挂到 LAN 上,本套刻意不做)。
 */
console.log("\n安全默认值:LAN 服务默认不启用(MC-004)");

{
  const { readEnabled } = await import("@main/mobile/MobileHttpServer.js");
  SettingRepo.delete("mobile.enabled");
  eq("★ 没设 mobile.enabled → 不启用(安全默认)", await readEnabled(), false);
  SettingRepo.set("mobile.enabled", "0");
  eq("★ mobile.enabled=0 → 不启用", await readEnabled(), false);
  SettingRepo.set("mobile.enabled", "1");
  eq("★ mobile.enabled=1(显式开启)→ 启用", await readEnabled(), true);
  SettingRepo.delete("mobile.enabled");
}

/* ────────────── 11. SSE 背压:慢客户端被断开、别的设备不受影响(MC-007) ──────────
 *
 * 从前 `handleEvents` 的每一条 `res.write` 都不检查回压:一台只连不读的手机能让主进程
 * 为它无限缓冲 `text.delta`,直到 OOM,而且拖慢别的设备。现在超软阈值给宽限期、超硬
 * 上限立即断;断开的是**这一台**,别的订阅者各自的连接照常收。
 *
 * 判别法:开两条流,让慢的那条"从不读"(socket 暂停),向它猛灌事件直到它越过硬上限被
 * 服务端断开;同时快的那条持续读、必须一直收到事件、不被误断。
 */
console.log("\nSSE 背压(MC-007)");

{
  // 独立的短超时 client:慢客户端要能"连上但不读",fetch/AbortSignal.timeout 都带读超时,
  // 不适合。这里用原生 socket 手读 HTTP 响应头,之后**暂停**不再消费。
  const net = await import("node:net");
  const slowToken = await (async () => {
    const s = pairingManager.startPairing(ENDPOINT, { force: true });
    const r = await req("/api/pair/verify", { method: "POST", body: { nonce: s.nonce, code: s.code, deviceName: "慢手机" } });
    const t = (JSON.parse(r.text) as { deviceToken: string }).deviceToken;
    issuedSecrets.push(t);
    return t;
  })();

  const baseline = mobileEventBus.size;
  // ⚠️ 把 socket 放进一个**数组**持着:无论断言结果如何,收尾都**必须** destroy 它 ——
  // 否则当被验的修复不在时(慢客户端永不被服务端断开),这个 socket 会一直挂着,后面
  // `server.close()` 会等它到天荒地老,整套 suite **卡死**(看起来像"测试写坏了"),而不是
  // 给出干净的 FAIL。(用数组而不是 `let sock = null`,是因为赋值发生在 Promise 回调里,
  // TS 不会把那里的赋值反映到外层收窄,`let null` 会被收窄成 `never`。)
  const slowHold: Array<{ destroy(): void }> = [];
  const slowClosed = await new Promise<boolean>((resolve) => {
    let done = false;
    const settle = (v: boolean): void => { if (!done) { done = true; resolve(v); } };
    const sock = net.connect(addr.port, "127.0.0.1", () => {
      sock.write(
        `GET /api/events?token=${encodeURIComponent(slowToken)} HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\nAuthorization: Bearer ${slowToken}\r\nAccept: text/event-stream\r\n\r\n`,
      );
    });
    slowHold.push(sock);
    // 读到头之后**暂停**socket —— 不再把数据从内核搬走,内核窗口填满 → 服务端的
    // `res.write` 开始在自己的可写缓冲里堆积 → `res.writableLength` 增长。这才是
    // "卡住的手机"。只注册 data 处理而不 pause 等于一直在读,根本不会有回压。
    sock.once("data", () => sock.pause());
    // ⚠️ 暂停的 socket **不会**处理 end/close(要 resume 才派发),所以不能只等 close。
    // 主信号用**订阅数落回 baseline** —— 服务端断开会 unsubscribe + releaseDevice。
    sock.on("close", () => settle(true));
    sock.on("end", () => settle(true));
    sock.on("error", () => settle(true));
    const pump = async (): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (mobileEventBus.size <= baseline && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      const big = "x".repeat(16 * 1024);
      for (let i = 0; i < 400 && !done; i += 1) {
        mobileEventBus.broadcast({ type: "text.delta", sessionId: "s_slow", messageId: i, text: big } as never);
        await new Promise((r) => setTimeout(r, 0));
      }
      // 断开后 resume 一次,让内核里积压的 FIN/RST 派发出来(close/end/error 任一都算)。
      try { sock.resume(); } catch { /* already destroyed */ }
      const until = Date.now() + 2000;
      while (Date.now() < until && !done && mobileEventBus.size > baseline) await new Promise((r) => setTimeout(r, 20));
      settle(mobileEventBus.size <= baseline);
    };
    void pump();
  });
  check("★ 慢客户端(从不读)被服务端断开,而不是无限缓冲", slowClosed, { slowClosed, size: mobileEventBus.size, baseline });
  // 收尾:无论如何都销毁慢 socket(断开已被断言,别让它拖住 server.close)。
  for (const s of slowHold) { try { s.destroy(); } catch { /* already gone */ } }
  // 等服务端把这条连接的订阅释放掉,免得影响后面"收尾:服务已关"。
  {
    const until = Date.now() + 1000;
    while (Date.now() < until && mobileEventBus.size > baseline) await new Promise((r) => setTimeout(r, 10));
  }

  // 快客户端(正常读)不被误断:另开一条流、持续读,广播一条哨兵必须能收到。
  {
    const s = pairingManager.startPairing(ENDPOINT, { force: true });
    const r0 = await req("/api/pair/verify", { method: "POST", body: { nonce: s.nonce, code: s.code, deviceName: "快手机" } });
    const fastToken = (JSON.parse(r0.text) as { deviceToken: string }).deviceToken;
    issuedSecrets.push(fastToken);
    const ctrl = new AbortController();
    const res = await fetch(`${BASE}/api/events?token=${encodeURIComponent(fastToken)}`, { signal: ctrl.signal });
    eq("快客户端 SSE → 200", res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const state = { buf: "" };
    const reading = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          state.buf += dec.decode(value, { stream: true });
        }
      } catch { /* aborted by us */ }
    })();
    mobileEventBus.broadcast({ type: "session.title", sessionId: "s_fast", title: "FAST_SENTINEL" } as never);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !state.buf.includes("FAST_SENTINEL")) await new Promise((r) => setTimeout(r, 10));
    check("★ 慢客户端被断的同时,快客户端照样收到事件(没被拖累)", state.buf.includes("FAST_SENTINEL"), state.buf.slice(-200));
    ctrl.abort();
    await reading;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/* ────────────── 12. 监听地址可收敛(bind 地址解析)—— MC-004 残余第二半 ──────────────
 *
 * §10 的安全默认值只堵住「全新安装默认敞在 LAN」。第二半:显式开启后 `MobileHttpServer`
 * 仍以**明文 HTTP** 绑 `0.0.0.0`,长期令牌 / 口令在可信 LAN 之外的网络可被观察。本切片
 * 提供**可收敛的监听地址**:默认仍 `0.0.0.0`(LAN 场景需要手机跨网段连),但可显式收到
 * `127.0.0.1`(仅本机)或某块网卡 IP。⚠️ 传输仍是明文 HTTP(本服务不终结 TLS)——
 * 收敛绑定地址只**缩小谁能连**,不是加密;TLS/可信隧道未做(见台账 remaining)。
 *
 * 判据立在两处**真实行为**上:
 *   1. 纯函数 `resolveBindAddressValue` 的三态(缺省 → `0.0.0.0`;显式回环 → `127.0.0.1`;
 *      显式 IP → 那个 IP),外加畸形值 fail-closed(收窄到本机,不回落全部网卡);
 *   2. `server.listen(port, addr)` 真的听在所选地址上 —— 解析出的地址就是
 *      `server.address().address`;绑 `127.0.0.1` 时本机 LAN 地址**连不进来**。
 */
console.log("\n监听地址可收敛(MC-004)");

{
  const { resolveBindAddressValue, endpointHostForBind, decidePlaintextCredential, isLoopbackPeer } = await import("@main/mobile/MobileHttpServer.js");
  const net = await import("node:net");

  // ── 纯函数:三态 + 畸形 fail-closed ──
  eq("缺省(未配置)→ 0.0.0.0(LAN 默认)", resolveBindAddressValue(null), "0.0.0.0");
  eq("空串 → 0.0.0.0", resolveBindAddressValue(""), "0.0.0.0");
  eq("纯空白 → 0.0.0.0", resolveBindAddressValue("   "), "0.0.0.0");
  eq("显式回环 127.0.0.1 → 127.0.0.1", resolveBindAddressValue("127.0.0.1"), "127.0.0.1");
  eq("localhost → 归一成 127.0.0.1", resolveBindAddressValue("localhost"), "127.0.0.1");
  eq("IPv6 回环 ::1 → ::1(原样)", resolveBindAddressValue("::1"), "::1");
  eq("显式网卡 IP 192.168.1.5 → 那个 IP", resolveBindAddressValue("192.168.1.5"), "192.168.1.5");
  eq("显式 IP 带空白 → trim 后采用", resolveBindAddressValue("  10.0.0.7 "), "10.0.0.7");
  eq("★ 畸形值(IP 少一段)→ fail-closed 127.0.0.1(不回落 0.0.0.0)", resolveBindAddressValue("192.168.1"), "127.0.0.1");
  eq("★ 畸形值(带端口)→ fail-closed 127.0.0.1", resolveBindAddressValue("0.0.0.0:7331"), "127.0.0.1");
  eq("★ 畸形值(带协议)→ fail-closed 127.0.0.1", resolveBindAddressValue("http://0.0.0.0"), "127.0.0.1");

  // ── 【MC-004 / §50.6】非回环明文凭据闸 ──
  // 本服务明文 HTTP;非回环对端的账号口令 / Bearer 令牌默认拒绝,除非用户显式 opt-in。
  eq("回环对端 → 放行(loopback)", decidePlaintextCredential(true, false), "loopback");
  eq("回环对端即使没 opt-in 也放行", decidePlaintextCredential(true, true), "loopback");
  eq("★ 非回环 + 未 opt-in → 拒绝(refused,fail-closed)", decidePlaintextCredential(false, false), "refused");
  eq("非回环 + 显式 opt-in → 放行(opted-in)", decidePlaintextCredential(false, true), "opted-in");
  // 对端地址判定:回环的各种写法。
  check("127.0.0.1 判回环", isLoopbackPeer("127.0.0.1"));
  check("::1 判回环", isLoopbackPeer("::1"));
  check("IPv4-mapped ::ffff:127.0.0.1 判回环", isLoopbackPeer("::ffff:127.0.0.1"));
  check("127.0.0.5(整个 /8)判回环", isLoopbackPeer("127.0.0.5"));
  check("★ 192.168.1.9(LAN)不判回环", !isLoopbackPeer("192.168.1.9"));
  check("★ 公网 8.8.8.8 不判回环", !isLoopbackPeer("8.8.8.8"));
  check("空 / null 不判回环(保守)", !isLoopbackPeer(null) && !isLoopbackPeer(undefined));

  // ── 回显 host 跟着绑定地址走(收敛后二维码不再指向没在听的 LAN IP)──
  eq("绑通配 → 回显探测到的 LAN IP", endpointHostForBind("0.0.0.0", "192.168.1.9"), "192.168.1.9");
  eq("绑通配 + 探不到 IP → localhost", endpointHostForBind("0.0.0.0", null), "localhost");
  eq("绑回环 → 回显 127.0.0.1(不看探测 IP)", endpointHostForBind("127.0.0.1", "192.168.1.9"), "127.0.0.1");
  eq("绑某网卡 IP → 回显那个 IP", endpointHostForBind("192.168.1.5", "10.0.0.1"), "192.168.1.5");
  eq("绑 IPv6 字面量 → URL 里加方括号", endpointHostForBind("fe80::1", null), "[fe80::1]");

  // ── 真起一个监听器:listen(port, addr) 真的听在所选地址上 ──
  // ⚠️ **只绑回环。** 本套的底线是「不把跑的这台机器挂到局域网上」(见 run.sh 头)。
  //    `0.0.0.0` 那一发解析由上面的纯函数 + 下面的源码不变量覆盖,这里不真绑它 ——
  //    绑它就是把自己敞给 LAN,哪怕只是一个回 "ok" 的短路监听器。
  const listenBoundAddress = async (addr: string): Promise<string> => {
    const s = createServer((_req, res) => { res.end("ok"); });
    await new Promise<void>((resolve, reject) => {
      s.on("error", reject);
      s.listen(0, addr, () => resolve());
    });
    const bound = s.address();
    const external = bound && typeof bound === "object" ? bound.address : "";
    await new Promise<void>((resolve) => s.close(() => resolve()));
    return external;
  };
  eq("listen(0, \"127.0.0.1\") 真的绑在 127.0.0.1", await listenBoundAddress("127.0.0.1"), "127.0.0.1");

  // ★ 最强判据:绑 127.0.0.1 时,同一台机器的 LAN 网卡 IP **连不进来**(只有绑 0.0.0.0
  //   才连得进)。`detectLanIp()` 在完全离线的机器上返回 null —— 那时这条前提不成立,
  //   如实报红(与 §"库真的建起来了"同款:前提本身也是一条要守的断言)。
  const lanIp = (await import("@main/mobile/PairingManager.js")).detectLanIp();
  check("前提:本机有可探测的 LAN IP(否则 LAN 拒连那条无从谈起)", lanIp !== null, { lanIp });
  if (lanIp) {
    const probeConnect = (addr: string, port: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const sock = net.connect({ host: addr, port }, () => { sock.destroy(); resolve(true); });
        sock.setTimeout(800);
        sock.on("timeout", () => { sock.destroy(); resolve(false); });
        sock.on("error", () => resolve(false));
      });
    const bound = createServer((_req, res) => { res.end("ok"); });
    await new Promise<void>((resolve, reject) => {
      bound.on("error", reject);
      bound.listen(0, "127.0.0.1", () => resolve());
    });
    const p = (bound.address() as { port: number }).port;
    eq("★ 绑 127.0.0.1 时本机 LAN IP 连不进来(收敛真的生效)", await probeConnect(lanIp, p), false);
    eq("同一监听器从回环仍连得进(前提成立,不是它没在听)", await probeConnect("127.0.0.1", p), true);
    await new Promise<void>((resolve) => bound.close(() => resolve()));
  }

  // ── 源码不变量:startMobileServer 真的把**解析出的**地址交给 listen ──
  // 本套不直接调 `startMobileServer`(它会把跑的这台机器绑到 LAN 上,正是本套刻意
  // 不做的);所以钉源码:`server.listen(port, bindAddress, …)` 必须传解析值,不能把
  // 字面量 "0.0.0.0" 写死回去 —— 否则 resolveBindAddress 再对也没接进监听。
  {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/main/mobile/MobileHttpServer.ts"), "utf8");
    const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    check(
      "★ startMobileServer 把解析出的 bindAddress 交给 server.listen(不是写死 0.0.0.0)",
      /server\.listen\(port,\s*bindAddress\b/.test(code) && !/server\.listen\(port,\s*"0\.0\.0\.0"/.test(code),
      { listenLines: code.match(/server\.listen\([^)]*/g) },
    );
  }

  /* ── §50.6 端到端:非回环对端的账号密码登录被**真的**拒绝 ───────────────────
   *
   * 上面那批是纯函数断言;这里直接拿生产 request handler,把 `req.socket.remoteAddress`
   * 伪造成 LAN 地址(192.168.1.9),真实走一遍 `/api/auth/login` —— 断言**真的** 403、
   * 且没有落到口令校验。回环对端(真实 fetch 那批)仍正常,证明没误伤。 */
  {
    const handler = createMobileRequestHandler(ENDPOINT);
    const driveLogin = (remoteAddress: string): Promise<{ status: number; error?: string }> =>
      new Promise<{ status: number; error?: string }>((resolve) => {
        const chunks: Buffer[] = [];
        const body = Buffer.from(JSON.stringify({ username: "u", password: "p" }));
        const req = {
          url: "/api/auth/login",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": String(body.length) },
          socket: { remoteAddress },
          on: (ev: string, cb: (arg?: unknown) => void) => {
            if (ev === "data") cb(body);
            if (ev === "end") cb();
          },
        } as unknown as import("node:http").IncomingMessage;
        const res = {
          statusCode: 0,
          headersSent: false,
          setHeader() {},
          writeHead(code: number) {
            this.statusCode = code;
            this.headersSent = true;
          },
          end(payload?: string) {
            if (payload) chunks.push(Buffer.from(payload));
            let parsed: { error?: string } = {};
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
            resolve({ status: res.statusCode, error: parsed.error });
          },
        };
        handler(req, res as unknown as import("node:http").ServerResponse);
      });
    // 非回环 + 未 opt-in(本套没设 opt-in 键)→ 403 明确拒绝。
    const lan = await driveLogin("192.168.1.9");
    eq("★ 非回环明文登录被拒(403)", lan.status, 403);
    check("★ 拒因写明是明文凭据(不是账号密码错)", typeof lan.error === "string" && lan.error.includes("明文"), lan.error);
    // 回环对端放行(到口令校验那一步 —— 账号不存在会 401/400,但**不是** 403)。
    const loop = await driveLogin("127.0.0.1");
    check("回环对端不被明文闸拦(不是 403)", loop.status !== 403, loop.status);
  }
}

await new Promise<void>((resolve) => server.close(() => resolve()));
console.log("\n服务已关");

console.log(`\n${checks} 条断言,${failures} 条红`);
if (failures > 0) process.exit(1);
process.exit(0);
