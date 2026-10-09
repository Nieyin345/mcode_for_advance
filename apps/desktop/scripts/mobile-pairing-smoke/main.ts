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
  const other = await loginReq({ username: "alice", password: PW, deviceName: "别处" }, { "x-forwarded-for": "10.9.9.9" });
  eq("别的来源不受这台的锁影响", other.status, 200);
  if (other.status === 200) issuedSecrets.push((JSON.parse(other.text) as { deviceToken: string }).deviceToken);

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

await new Promise<void>((resolve) => server.close(() => resolve()));
console.log("\n服务已关");

console.log(`\n${checks} 条断言,${failures} 条红`);
if (failures > 0) process.exit(1);
process.exit(0);
