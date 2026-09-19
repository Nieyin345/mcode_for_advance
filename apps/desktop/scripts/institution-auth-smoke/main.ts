/**
 * Headless smoke for **`main/ipc/institutionAuth.ts`** —— 「机构认证」那条 IPC。
 *
 * ## 为什么单独一套
 *
 * 这个模块零覆盖,而它是**登录态那条路**:cookie 在这里被读、被删,`domains` 在这里
 * 从用户输入一路走到 Electron 的 cookie 存储。这条路上的 bug 后果都是"用户以为发生了
 * 一件事、实际发生了另一件",而两种都很难看出来:
 *
 *  - **清太多**:多删一个域的登录态 = 用户第二天来发现另一个站也要重新登录;
 *  - **清太少**:界面说"已清除",cookie 一条没少;
 *  - **把失败当成功**:删的时候异常被吞,用户看着"已清除"却还在已登录状态;
 *  - **把内部错误原样甩给用户**:界面弹一条 zod / 堆栈。
 *
 * ## §4/§5 走的是**真的那条 handler**,不是复述
 *
 * ⚠️ 判据立在**用户看到的那个返回值**上:`handler(user 看到的那份输入)` 的结果。
 * 这里没有一句在复述 handler 内部的写法,所以谁改坏了 handler,红的会立刻红 ——
 * 这正是 CLAUDE.md 里那句「套件跑绿但**根本没覆盖到**被改的文件」要防的事。
 *
 * ## 它不碰用户真正的库,也不连网
 *
 * 数据根是 run.sh 用 `mktemp -d` 建的目录(`stubs/dataRoot.ts` 里"没设就抛")。
 * 外面那一层(浏览器 cookie / 网络)整个换成了 `stubs/browserManager.ts` 的假存储 ——
 * 没有 Electron、没有网络、没有真 cookie。
 *
 * Run: scripts/institution-auth-smoke/run.sh
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组/对象比较 —— `Object.is` 对内容相同的两个数组是 false。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-institution-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

/* ──────────────── 0. 把真 handler 取出来 ──────────────── */

/**
 * `ipcMain` 的**记名替身**。判据整个住在 handler 的函数体里,而它从来不是导出符号 ——
 * 唯一拿得到的办法就是调 `registerInstitutionAuthHandlers`,把那批函数按 channel
 * 收下来。不起 Electron,也没有真的 preload。
 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC } = await import("@contracts/ipc");
const { registerInstitutionAuthHandlers } = await import("@main/ipc/institutionAuth.js");
const browser = await import("./stubs/browserManager.js");

registerInstitutionAuthHandlers(fakeIpc);

const { initDb } = await import("@main/store/db.js");

await initDb();

/** 把一条 IPC 当成渲染端那样调:`invoke(channel, input)` → handler(null, input)。 */
function invoke(channel: string, raw?: unknown): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerInstitutionAuthHandlers 没有注册 ${channel}`);
  return Promise.resolve(fn(null, raw));
}

for (const [label, channel] of Object.entries({
  list: IPC.INSTITUTION_LIST,
  save: IPC.INSTITUTION_SAVE,
  delete: IPC.INSTITUTION_DELETE,
  authStatus: IPC.INSTITUTION_AUTH_STATUS,
  clearCookies: IPC.INSTITUTION_CLEAR_COOKIES,
})) {
  check(`注册了 institution.${label}`, handlers.has(channel), [...handlers.keys()]);
}

/* ──────────────── 1. 入口档案:增 / 改 / 删 ──────────────── */

console.log("\n入口档案");

const saved = (await invoke(IPC.INSTITUTION_SAVE, {
  name: "学校图书馆",
  loginUrl: "https://lib.example.edu/login",
  // 逗号分隔的输入在渲染端拆好;这里给的是拆好的形状。顺带一个带点的域。
  domains: ["example.edu", ".cnki.net"],
  notes: "续订到 2027",
})) as { profiles: Array<Record<string, unknown>> };

eq("保存之后返回一条档案", saved.profiles.length, 1);
const instId = saved.profiles[0]!.id as string;
eq("档案名对得上", saved.profiles[0]!.name, "学校图书馆");
same("域名原样存下来(前导点没被吃掉)", saved.profiles[0]!.domains, ["example.edu", ".cnki.net"]);

const listed = (await invoke(IPC.INSTITUTION_LIST)) as { profiles: Array<Record<string, unknown>> };
eq("list 读得回来", listed.profiles.length, 1);
eq("就是刚存的那条", listed.profiles[0]!.id, instId);

// 改:带上 id 就是更新,不是新增。
const updated = (await invoke(IPC.INSTITUTION_SAVE, {
  id: instId,
  name: "改过名的图书馆",
  domains: ["example.edu"],
})) as { profiles: Array<Record<string, unknown>> };
eq("带 id 的保存是更新,没多出一行", updated.profiles.length, 1);
eq("名字改了", updated.profiles[0]!.name, "改过名的图书馆");
same("域名跟着改了", updated.profiles[0]!.domains, ["example.edu"]);
check("删掉的域名没留在库里", !JSON.stringify(updated.profiles[0]).includes("cnki.net"));

// 用户会往输入框里粘空串 / 多打逗号 —— 渲染端会先 trim 掉空项,这里钉一条空串
// 也是"没有域名"而不是"域名是空字符串"(后者会被当成 `endsWith(".")` 一类的东西)。
const blankDomains = (await invoke(IPC.INSTITUTION_SAVE, {
  name: "没有域名的入口",
  domains: [],
})) as { profiles: Array<Record<string, unknown>> };
eq("没有域名的档案存得下", blankDomains.profiles.length, 2);
same("domains 是空数组,不是 [\"\"]", blankDomains.profiles[1]!.domains, []);

/* ──────────────── 2. 档案里不许有凭据 ──────────────── */

console.log("\n档案不是凭据容器");

// 契约里写死了「机构认证档案 ⚠️ 不含任何凭据」。这条是白纸黑字的规矩,值得钉住 ——
// 它管的是"以后有人顺手往档案表里加个 password 字段"那种事故。
{
  // 故意把像凭据的东西塞进**能塞的**字段里,看它会不会泄露到别的通道去。
  const sentinel = "SENTINEL-PASSWORD-cnki-9f3a";
  await invoke(IPC.INSTITUTION_SAVE, {
    id: instId,
    name: "学校图书馆",
    loginUrl: "https://lib.example.edu/login",
    domains: ["example.edu"],
    // 用户把密码误粘进备注 —— 那也只是备注,该原样存、原样回,不做神奇处理
    notes: sentinel,
  });
  const after = (await invoke(IPC.INSTITUTION_LIST)) as { profiles: Array<Record<string, unknown>> };
  const profile = after.profiles.find((p) => p.id === instId)!;
  eq("用户写在备注里的东西原样还回来", profile.notes, sentinel);
  check(
    "档案上没有多出任何凭据类字段",
    !Object.keys(profile).some((k) => /pass|secret|token|credential/i.test(k)),
    Object.keys(profile),
  );
}

/* ──────────────── 3. 从 cookie 反推已登录站点 ──────────────── */

const NOW = Math.floor(Date.now() / 1000);
/** 一条只该出现在 cookie 存储里、绝不该出现在 IPC 返回体里的哨兵。 */
const SECRET_COOKIE_VALUE = "SENTINEL-COOKIE-VALUE-4b81";

console.log("\n已登录站点");

browser.resetBrowser();
browser.setCookies([
  // 知网的父域 cookie,带前导点 —— 面板上显示成 `cnki.net`
  { name: "Ecp_Login", value: SECRET_COOKIE_VALUE, domain: ".cnki.net", path: "/", secure: true, expirationDate: NOW + 3600 },
  // 同一域的第二条,过期更晚 —— 界面显示的"有效期至"该取最晚那条
  { name: "Ecp_Session", value: "x", domain: ".cnki.net", path: "/", secure: true, expirationDate: NOW + 7200 },
  // 学校代理:两个不同的子域
  { name: "ezproxy", value: "y", domain: ".example.edu", path: "/", secure: true },
  { name: "hostonly", value: "z", domain: "lib.example.edu" },
  // 会话 cookie(没有 expirationDate)
  { name: "sid", value: "s", domain: "publisher.org" },
  // 没有 domain 的条目 —— 聚合粒度是域,这条不该凭空造出一个站点
  { name: "nodomain", value: "n" },
]);

{
  const res = (await invoke(IPC.INSTITUTION_AUTH_STATUS, {})) as {
    sites: Array<{ domain: string; cookieCount: number; expiresAt?: number; matchedProfileIds: string[] }>;
  };
  const domains = res.sites.map((s) => s.domain).sort();
  same("按域聚合,前导点被去掉", domains, ["cnki.net", "example.edu", "lib.example.edu", "publisher.org"]);
  check("没有 domain 的 cookie 没造出一个站点", !domains.includes("undefined"), domains);

  const cnki = res.sites.find((s) => s.domain === "cnki.net")!;
  eq("同一域的两条合成一条", cnki.cookieCount, 2);
  eq("有效期取最晚的那条", cnki.expiresAt, NOW + 7200);

  const publisher = res.sites.find((s) => s.domain === "publisher.org")!;
  eq("全是会话 cookie → 没有 expiresAt(界面显示'会话级')", publisher.expiresAt, undefined);

  // `example.edu` 挂着档案(`example.edu`),子域 `lib.example.edu` 也该归到同一个入口
  const edu = res.sites.find((s) => s.domain === "example.edu")!;
  same("命中档案的域被归到那个入口名下", edu.matchedProfileIds, [instId]);
  const lib = res.sites.find((s) => s.domain === "lib.example.edu")!;
  same("子域也归到同一个入口名下", lib.matchedProfileIds, [instId]);
  const cnkiSite = res.sites.find((s) => s.domain === "cnki.net")!;
  same("没配档案的域就是空的", cnkiSite.matchedProfileIds, []);

  // ★ 这一整套最关键的一条:cookie 的**值**是凭据,绝不跨 IPC。
  check(
    "★ 读状态只给出域/条数/有效期,明文 cookie 值一条都没漏",
    !JSON.stringify(res).includes(SECRET_COOKIE_VALUE),
    JSON.stringify(res).slice(0, 300),
  );
  check(
    "★ 返回体里没有任何 cookie 名字/值字段",
    !res.sites.some((s) => "cookies" in s || "value" in s || "name" in s),
    Object.keys(res.sites[0]!),
  );

  // 排序:配了档案的排前面,其次按域名。
  same("配了档案的域排在最前", res.sites.slice(0, 2).map((s) => s.domain), ["example.edu", "lib.example.edu"]);
}

// 带域名过滤的查询:只看那几个域(界面「重载」时若带上过滤走这条)。
{
  const filtered = (await invoke(IPC.INSTITUTION_AUTH_STATUS, { domains: ["cnki.net"] })) as {
    sites: Array<{ domain: string }>;
  };
  same("按域名过滤只回那一项", filtered.sites.map((s) => s.domain), ["cnki.net"]);
}

// 过滤一个没有任何 cookie 的域 → 空列表(界面显示"还没有登录任何站点")
{
  const none = (await invoke(IPC.INSTITUTION_AUTH_STATUS, { domains: ["nowhere.test"] })) as {
    sites: unknown[];
  };
  same("过滤不存在的域 → 空", none.sites, []);
}

// 过滤多个域(面板里两个站点一起看)
{
  const two = (await invoke(IPC.INSTITUTION_AUTH_STATUS, { domains: ["cnki.net", "publisher.org"] })) as {
    sites: Array<{ domain: string }>;
  };
  same("过滤两个域 → 两项", two.sites.map((s) => s.domain).sort(), ["cnki.net", "publisher.org"]);
}

/* ──────────────── 4. 清除某个域名的登录态(面板上的垃圾桶)──────────────── */

console.log("\n清除某个域名");

const SECRET_CNKI = "SENTINEL-CNKI-COOKIE-7c2d";
const SECRET_EDU = "SENTINEL-EDU-COOKIE-1a55";

{
  browser.resetBrowser();
  browser.setCookies([
    { name: "a", value: SECRET_CNKI, domain: ".cnki.net", path: "/", secure: true, expirationDate: NOW + 3600 },
    { name: "b", value: SECRET_EDU, domain: ".example.edu", path: "/", secure: true },
    { name: "c", value: "keep", domain: "lib.example.edu" },
    { name: "d", value: "keep2", domain: "publisher.org" },
  ]);

  // ⚠️ 用户看到的域名是**去掉前导点**的(`cnki.net`)—— 面板把 `s.domain` 原样传回来。
  // 这条走的正是那个形状。
  const res = (await invoke(IPC.INSTITUTION_CLEAR_COOKIES, { domains: ["cnki.net"] })) as {
    sites: Array<{ domain: string }>;
  };

  same("真的去清了那一个域", browser.clearedBatches(), [["cnki.net"]]);
  const alive = browser.liveCookies().map((c) => c.domain);
  check("知网的 cookie 没了", !alive.includes(".cnki.net"), alive);
  check("别的域一条没动", alive.includes(".example.edu") && alive.includes("publisher.org"), alive);

  const domains = res.sites.map((s) => s.domain).sort();
  same("返回的是清完之后的新状态", domains, ["example.edu", "lib.example.edu", "publisher.org"]);
  check("★ 清完之后返回体里也没有明文 cookie 值", !JSON.stringify(res).includes(SECRET_CNKI) && !JSON.stringify(res).includes(SECRET_EDU));
  check("★ 清完之后返回体里没有 cookie 名字/值字段", !JSON.stringify(res).includes('"value"'), JSON.stringify(res).slice(0, 200));
}

// 清一个域:契约说"清除指定域名的登录态",界面上显示的域就是那个域的**全部** cookie。
// 只清一条、留下同域别的 cookie,用户第二天来还是登录着的。
{
  browser.resetBrowser();
  browser.setCookies([
    { name: "a", value: "1", domain: ".cnki.net", secure: true },
    { name: "b", value: "2", domain: ".cnki.net", secure: true },
    { name: "c", value: "3", domain: "www.cnki.net" },
  ]);
  await invoke(IPC.INSTITUTION_CLEAR_COOKIES, { domains: ["cnki.net"] });
  eq("★ 同域的所有 cookie 一起清掉(留着一条就等于没清)", browser.liveCookies().length, 0);
}

// 一次清多个域(用户在多选)
{
  browser.resetBrowser();
  browser.setCookies([
    { name: "a", value: "1", domain: ".cnki.net" },
    { name: "b", value: "2", domain: ".example.edu" },
    { name: "c", value: "3", domain: "publisher.org" },
  ]);
  await invoke(IPC.INSTITUTION_CLEAR_COOKIES, { domains: ["cnki.net", "example.edu"] });
  same("两个域一起提交,两个域一起清", browser.liveCookies().map((c) => c.domain), ["publisher.org"]);
}

/* ──────────────── 5. 清全部(危险那条,UI 必须二次确认)──────────────── */

console.log("\n清全部登录态");

{
  browser.resetBrowser();
  browser.setCookies([
    { name: "a", value: "1", domain: ".cnki.net" },
    { name: "b", value: "2", domain: "lib.example.edu" },
    { name: "c", value: "3", domain: ".example.edu" },
    { name: "d", value: "4" }, // 没有 domain 的条目,不该让它把这次清空搞崩
  ]);
  const res = (await invoke(IPC.INSTITUTION_CLEAR_COOKIES, {})) as { sites: unknown[] };
  // ⚠️ 有一条 cookie **没有 domain**(file:// 那种),而"清全部"的域名列表是从
  // `c.domain` 推出来的、推不出就不提交它 —— 所以它清不掉。这不是 bug,是那条 cookie
  // 本身无法用 url 表达(真 `clearBrowserCookiesForDomains` 的注释里写了同一件事)。
  // 这里断的是"有 domain 的那三条全没了",不是"一条不剩"。
  eq("有三条被清掉,只剩下推不出域的那一条", browser.liveCookies().length, 1);
  eq("剩下的正是没有 domain 的那条", browser.liveCookies()[0]!.name, "d");
  same("清完之后没有已登录站点", res.sites, []);
  // 提交的域名列表:去重、且没有 undefined 混进去(真的 `clear` 会拿它去查)
  const batch = browser.clearedBatches();
  eq("只清了一次", batch.length, 1);
  check("提交的域名列表里没有 undefined", !batch[0]!.includes(undefined as unknown as string), batch[0]);
  check("提交的域名列表去过重", new Set(batch[0]!).size === batch[0]!.length, batch[0]);

  // ★ 清全部之后,那个"读状态"的返回值里同样不许有任何 cookie 的明文
  check("★ 清完返回体里没有明文 cookie 值", !JSON.stringify(res).includes("SENTINEL"));
}

// ★ `domains: []` **不能**落进「清空整个分区」那条分支。
//
// 契约里那句是「**省略**则清空整个浏览器分区(危险,UI 需二次确认)」—— 判据是"有没有
// 给这个字段",而原来的代码判的是 `input.domains?.length`,于是空数组和省略走了同一条路:
// 调用方给了一个明确的空列表(意思可能是"没有要清的"),收到的是"全清"。一个字符之差
// 触发全量登出,而两种结果在返回值上**长得一模一样**(都是空列表)。
//
// 这条是本套最主要的一条断言:它红着的时候,下面那行的 `liveCookies()` 会直接告诉你
// 用户的 `publisher.org` 被顺手登出了。
{
  browser.resetBrowser();
  browser.setCookies([
    { name: "a", value: "1", domain: ".cnki.net" },
    { name: "b", value: "2", domain: "publisher.org" },
  ]);
  const res = (await invoke(IPC.INSTITUTION_CLEAR_COOKIES, { domains: [] })) as {
    sites: Array<{ domain: string }>;
  };
  same("★ domains: [] 不是'清全部'(没给域名 ≠ 给了个空列表)", browser.liveCookies().map((c) => c.domain).sort(), [
    ".cnki.net",
    "publisher.org",
  ]);
  eq("★ domains: [] 也不该去碰 cookie 存储", browser.clearedBatches().length, 0);
  same("状态照旧", res.sites.map((s) => s.domain).sort(), ["cnki.net", "publisher.org"]);
}

// 反之:**省略** domains 才是"清全部"(契约明写的危险那条),这条不能被上面那条改坏。
{
  browser.resetBrowser();
  browser.setCookies([
    { name: "a", value: "1", domain: ".cnki.net" },
    { name: "b", value: "2", domain: "publisher.org" },
  ]);
  await invoke(IPC.INSTITUTION_CLEAR_COOKIES, {});
  eq("★ 省略 domains 仍然是清全部", browser.liveCookies().length, 0);
}

/* ──────────────── 6. 失败要有动静 ──────────────── */

console.log("\n失败不静默");

{
  browser.resetBrowser();
  browser.setCookies([{ name: "a", value: "1", domain: ".cnki.net" }]);
  browser.failNextClear("cookie store is locked (fake)");

  let threw: unknown = null;
  try {
    await invoke(IPC.INSTITUTION_CLEAR_COOKIES, { domains: ["cnki.net"] });
  } catch (err) {
    threw = err;
  }
  check("cookie 存储报错时,这条 IPC 会失败而不是回报成功", threw !== null, threw);
  const message = threw instanceof Error ? threw.message : String(threw);
  eq("失败时透出来的是那条真消息", message, "cookie store is locked (fake)");

  // 失败之后**再读一次状态**:不能正好在这时候把 cookie 报成"没了"
  browser.resetBrowser();
  browser.setCookies([{ name: "a", value: "1", domain: ".cnki.net" }]);
  const res = (await invoke(IPC.INSTITUTION_AUTH_STATUS, {})) as { sites: Array<{ domain: string }> };
  same("失败之后状态照旧(没有假装清干净了)", res.sites.map((s) => s.domain), ["cnki.net"]);
}

// 输入不合法:契约是 zod,拒绝就行 —— 但**错误里不能带内部形状**。
//
// ⚠️ 这条不是假想的:`zod` 的 `ZodError.message` 是**一整段 JSON 数组文本**,而这条
// IPC 的 reject 没有别的兜底(设置面板里 saveDraft 只有 `finally { setLoading(false) }`,
// 没有 catch)—— 原样抛出去,用户看到的就是一屏 JSON。本仓库另有三个文件
// (`ipc/terminal.ts` / `ipc/runtimes.ts` / `ipc/toolchain.ts`)为同一个坑写了自己的
// `errText`,理由一模一样。
const ZOD_JSON = /\[[\s\S]*"code"[\s\S]*\]/;

{
  let message = "";
  try {
    await invoke(IPC.INSTITUTION_SAVE, { name: "" });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  check("名字为空被拒绝", message.length > 0, message);
  check("★ 说的是'入参不合法(字段: 那句话)',不是一整段 zod JSON", message.startsWith("入参不合法"), message);
  check("★ 错误里没有 zod 的 JSON 形状", !ZOD_JSON.test(message), message);
  check("★ 错误里点出了是哪个字段", message.includes("name"), message);
  check("★ 错误里没有堆栈", !message.includes("\n"), message);
}

// 删档案:不存在的 id 是**幂等**的(删了又删不该报错),但空 id 该被拒绝。
{
  let message = "";
  try {
    await invoke(IPC.INSTITUTION_DELETE, { id: "" });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  check("★ 删空的 id 被拒绝,且理由是人话", message.startsWith("入参不合法"), message);
  check("★ 删空 id 的错误里没有 zod JSON", !ZOD_JSON.test(message), message);
}

// 清 cookie 的域名列表里混进非字符串 —— 拒绝,别让它走到 cookie 存储那层。
{
  let message = "";
  let reached = false;
  browser.resetBrowser();
  try {
    await invoke(IPC.INSTITUTION_CLEAR_COOKIES, { domains: ["cnki.net", 42] });
    reached = true;
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  eq("★ 域名列表里有非字符串时被拒绝,没走到 cookie 存储", reached, false);
  eq("★ 拒绝时一个域名都没提交给 cookie 存储", browser.clearedBatches().length, 0);
  check("★ 拒绝理由是人话", message.startsWith("入参不合法"), message);
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\ninstitution-auth-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
