/**
 * Headless smoke for **收藏(页书签)** 那两半: `main/browser/bookmarks.ts` +
 * `main/ipc/browser.ts`。
 *
 * ## 为什么这两个文件归一套
 *
 * 它们是同一件事的两半:书签存不存得对住在 `bookmarks.ts`,而"渲染端点了收藏之后
 * 到底走没走到它、入参不合法时又交回了什么"住在 `ipc/browser.ts`。`smokes-for.sh`
 * 说这两个文件**一套都没有**(2026-09-20),而 `ipc/browser.ts` 里那 20 条
 * `BROWSER_*` 通道一条都没被跑过。
 *
 * ## §2 走的是**真的那条 handler**
 *
 * 按 `library-trash-smoke` §4 / `library-delete-smoke` 的办法:造一个 `ipcMain` 的
 * **记名替身**,把 `registerBrowserHandlers` 注册进去的真函数按 channel 收下来,
 * 再 `handlers.get(ch)!(null, raw)` 调它们。这样"校验失败时它返回了什么"验的是
 * 真代码,不是一份复述。
 *
 * 被委托的那一方(`BrowserManager`)换成了桩(`stubs/browserManager.ts`),它记下每次
 * 调用 —— 于是能断言两件只有真跑才看得见的事:
 *
 *   - 合法入参时,**转交过去的参数**长什么样(比如 setDevice 有没有把
 *     `viewportWidth` 丢在路上);
 *   - 入参不合法时,它**一次都没被调到**(校验真的挡住了,而不是"打下去再让它报错")。
 *
 * ## 它不碰用户真正的库
 *
 * 书签存在设置表里,而 `SettingRepo.set` 内部就是 `persist()` —— 一次点击就够
 * `sql.js` 把整个 `mcode.db` 重写一遍。所以数据根换成 `mktemp -d` 出来的目录
 * (见 `stubs/dataRoot.ts` 那句"没设就抛"),跑完就删。
 *
 * Run: scripts/browser-smoke/run.sh
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";
import { toolTextOf, type ToolResult } from "@main/mcp/sdk.js";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

/** `Object.is` 比不了数组和对象 —— 那两处断的是"内容一样",所以自己比。 */
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** 断"这段文字里没有内部错误对象的形状"。三个标记各自独立:zod 的 JSON 一定带
 *  `"code"`,一定以 `[` 起头,而且一定带 `path`。缺任何一个都说明这条不是 zod 漏出来的。 */
function hasZodShape(msg: unknown): boolean {
  return typeof msg === "string" && (msg.includes('"code"') || msg.trimStart().startsWith("[") || msg.includes('"path"'));
}

/* ──────────────── 0. 数据根 + 真 handler ──────────────── */

const DATA = mkdtempSync(join(tmpdir(), "mcode-browser-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

const { IPC, BROWSER_BOOKMARKS_SETTING_KEY } = await import("@contracts/ipc");
const { registerBrowserHandlers } = await import("@main/ipc/browser.js");
const { Bookmarks } = await import("@main/browser/bookmarks.js");
const { SettingRepo, ProjectRepo } = await import("@main/store/repositories.js");
const { initDb } = await import("@main/store/db.js");
const stub = await import("./stubs/browserManager.js");

await initDb();
registerBrowserHandlers(fakeIpc);

/** 「渲染端那次 `ipcRenderer.invoke`」—— 拿真注册进去的那个函数来调。 */
function handlerFor(channel: string): (raw?: unknown) => Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerBrowserHandlers 没有注册 ${channel}`);
  return (raw?: unknown) => Promise.resolve(fn(null, raw));
}

function call(channel: string, raw?: unknown): Promise<unknown> {
  return handlerFor(channel)(raw);
}

/** 一次调用之后,`BrowserManager` 那边记下了什么。 */
async function callAndRecord(
  channel: string,
  raw?: unknown,
): Promise<{ out: unknown; calls: string[] }> {
  stub.resetRecorded();
  const out = await call(channel, raw);
  return { out, calls: stub.recorded.map((c) => c.fn) };
}

function resetBookmarks(): void {
  SettingRepo.set(BROWSER_BOOKMARKS_SETTING_KEY, "[]");
}

/** 用户/渲染端看到的那份 —— 就是设置行里那段 JSON。解析不了(或者不是数组)返回
 *  null,而不是抛 —— 免得断言助手自己先炸(有的断言测的就是"原文坏掉时怎么办")。 */
function storedBookmarks(): Array<Record<string, unknown>> | null {
  const raw = SettingRepo.get(BROWSER_BOOKMARKS_SETTING_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 断言专用的窄口 —— 只在"库里确实是数组"的地方用,否则抛。 */
function bookmarkRows(): Array<Record<string, unknown>> {
  const parsed = storedBookmarks();
  if (!parsed) throw new Error(`库里不是 JSON 数组: ${SettingRepo.get(BROWSER_BOOKMARKS_SETTING_KEY)}`);
  return parsed;
}

/** 读出来的那些网址(只看 url 是字符串的行)。 */
function storedUrls(): string[] {
  return (storedBookmarks() ?? [])
    .map((r) => r?.url)
    .filter((u): u is string => typeof u === "string");
}

console.log("\n脚手架");

const BROWSER_CHANNELS = [
  IPC.BROWSER_CREATE,
  IPC.BROWSER_LOAD_URL,
  IPC.BROWSER_GO_BACK,
  IPC.BROWSER_GO_FORWARD,
  IPC.BROWSER_RELOAD,
  IPC.BROWSER_SET_BOUNDS,
  IPC.BROWSER_SET_PICK_MODE,
  IPC.BROWSER_SHOW,
  IPC.BROWSER_HIDE,
  IPC.BROWSER_CLOSE,
  IPC.BROWSER_CAPTURE_FRAME,
  IPC.BROWSER_SET_DEVICE,
  IPC.BROWSER_CLEAR_CACHE,
  IPC.BROWSER_HISTORY_REMOVE,
  IPC.BROWSER_HISTORY_CLEAR,
  IPC.BROWSER_BOOKMARK_ADD,
  IPC.BROWSER_BOOKMARK_REMOVE,
  IPC.BROWSER_AUTH_RESPOND,
  IPC.BROWSER_DOWNLOAD_ACTION,
  IPC.BROWSER_CLEAR_COOKIES,
];
check("20 条 BROWSER_* 通道全注册上了", BROWSER_CHANNELS.every((c) => handlers.has(c)), {
  missing: BROWSER_CHANNELS.filter((c) => !handlers.has(c)),
});

/* ──────────────── 1. 收藏本身(bookmarks.ts) ──────────────── */

console.log("\n收藏:存与读");

resetBookmarks();
eq("空库读出来是空的", storedBookmarks(), []);

Bookmarks.add("https://example.com/a", "甲页面");
{
  const rows = bookmarkRows();
  eq("加一条之后库里正好一行", rows.length, 1);
  eq("存的就是那个网址", rows[0]?.url, "https://example.com/a");
  eq("存的就是那个标题", rows[0]?.title, "甲页面");
  eq("addedAt 是数字(不是字符串)", typeof rows[0]?.addedAt, "number");
  eq("落盘的是 JSON 数组", SettingRepo.get(BROWSER_BOOKMARKS_SETTING_KEY)?.startsWith("["), true);
}

console.log("\n收藏:重复添加");

// ★ 这三条是"收藏"这个词最基本的承诺 —— 同一个网址不该在菜单里出现两行,
//   而再点一次"收藏此页"应当是把那条挪到最前、顺手把旧标题刷新掉。
Bookmarks.add("https://example.com/b", "乙页面");
Bookmarks.add("https://example.com/a", "甲页面(新标题)");
{
  const rows = bookmarkRows();
  eq("★ 同一个网址加两次不会变成两行", rows.length, 2);
  eq("★ 重复添加会把那条挪到最前面", rows[0]?.url, "https://example.com/a");
  eq("★ 重复添加会刷新标题", rows[0]?.title, "甲页面(新标题)");
  eq("另一条还在、没被顶掉", rows[1]?.url, "https://example.com/b");
}

console.log("\n收藏:顺序");

resetBookmarks();
Bookmarks.add("https://one.test", "1");
Bookmarks.add("https://two.test", "2");
Bookmarks.add("https://three.test", "3");
eq(
  "新加的排在最前(最近优先)",
  storedUrls(),
  ["https://three.test", "https://two.test", "https://one.test"],
);

console.log("\n收藏:删");

resetBookmarks();
Bookmarks.add("https://one.test", "1");
Bookmarks.add("https://two.test", "2");

Bookmarks.remove("https://两个都不在的.test");
eq(
  "删不存在的网址不会炸,也不动别的行",
  storedUrls(),
  ["https://two.test", "https://one.test"],
);

Bookmarks.remove("https://one.test");
eq("删掉的那条真的没了", storedUrls(), ["https://two.test"]);

Bookmarks.remove("https://two.test");
eq("删到空的时候库里就是空数组", storedBookmarks(), []);
Bookmarks.remove("https://two.test");
eq("空库上再删一次也不炸", storedBookmarks(), []);

console.log("\n收藏:什么网址算数");

resetBookmarks();
Bookmarks.add("about:blank", "空白页");
Bookmarks.add("data:text/html,<h1>x", "data 页");
Bookmarks.add("chrome-error://chromewebdata/", "错误页");
Bookmarks.add("javascript:alert(1)", "脚本伪协议");
Bookmarks.add("", "空串");
eq("about: / data: / chrome-error: / javascript: / 空串都不算收藏", storedBookmarks(), []);

Bookmarks.add("https://ok.test", "小写 https");
Bookmarks.add("http://plain.test", "http");
Bookmarks.add("file:///D:/tmp/a.html", "本地文件");
Bookmarks.add("HTTPS://UPPER.TEST", "大写协议");
eq(
  "http / https / file 收,而且协议大小写不敏感",
  storedUrls().sort(),
  ["HTTPS://UPPER.TEST", "http://plain.test", "https://ok.test", "file:///D:/tmp/a.html"].sort(),
);

resetBookmarks();
Bookmarks.add("https://no-title.test", "");
eq("标题是空串也存得下(菜单里靠 host 兜底显示)", bookmarkRows()[0]?.title, "");

console.log("\n收藏 / 历史:伪造协议和损坏网址不能污染持久导航记录");
const { AddressHistory: HistoryForUrlGuard } = await import("@main/browser/addressHistory.js");
const { BROWSER_ADDRESS_HISTORY_SETTING_KEY: HISTORY_KEY_FOR_URL_GUARD } = await import("@contracts/ipc");
resetBookmarks();
SettingRepo.set(HISTORY_KEY_FOR_URL_GUARD, "[]");
for (const malformed of [
  "http:javascript", "https:not-a-real-authority", "file:../../secret",
  "https://", "file://", "https://host.test/\nmalicious",
  " https://space.test", "https://space.test ",
  "http://host.test/\todd",
]) {
  Bookmarks.add(malformed, "Invalid");
  HistoryForUrlGuard.record(malformed, "Invalid");
}
eq("★★ 书签拒绝伪协议、缺失 host、控制符和首尾空白", storedBookmarks(), []);
eq("★★ 地址历史拒绝这些非可导航原文，不能污染历史",
  SettingRepo.get(HISTORY_KEY_FOR_URL_GUARD), "[]");
Bookmarks.add("https://good-after-invalid.test/path", "合法地址");
HistoryForUrlGuard.record("https://good-after-invalid.test/path", "合法地址");
eq("正常书签仍可加入", storedUrls(), ["https://good-after-invalid.test/path"]);
eq("正常历史仍可加入",
  JSON.parse(SettingRepo.get(HISTORY_KEY_FOR_URL_GUARD) ?? "[]").map((row: {url:string})=>row.url),
  ["https://good-after-invalid.test/path"]);

console.log("\n浏览器归档:凭据、旧脏地址与异常标题三条安全边界");
resetBookmarks();
SettingRepo.set(HISTORY_KEY_FOR_URL_GUARD, "[]");
const credentialUrl = "https://demo-user:secret-token@safe-host.test/private";
Bookmarks.add(credentialUrl, "Secret-bearing URL");
HistoryForUrlGuard.record(credentialUrl, "Secret-bearing URL");
eq("★★ 收藏不将 URL 内嵌账号密码明文落盘", storedBookmarks(), []);
eq("★★ 历史不将 URL 内嵌账号密码明文落盘",
  SettingRepo.get(HISTORY_KEY_FOR_URL_GUARD), "[]");

resetBookmarks();
const invalidOldBookmark = JSON.stringify([{ url:"javascript:alert(1)", title:"unsafe", addedAt:1 }]);
SettingRepo.set(BROWSER_BOOKMARKS_SETTING_KEY, invalidOldBookmark);
let rejectedOldBookmark = false;
try { Bookmarks.add("https://new.test", "new"); } catch { rejectedOldBookmark = true; }
eq("★★ 旧档含脚本地址时拒绝读改写", rejectedOldBookmark, true);
eq("★★ 旧档中的可疑地址字节原样保全", SettingRepo.get(BROWSER_BOOKMARKS_SETTING_KEY), invalidOldBookmark);

const invalidOldHistory = JSON.stringify([{ url:"file:../../private", title:"unsafe", at:1 }]);
SettingRepo.set(HISTORY_KEY_FOR_URL_GUARD, invalidOldHistory);
let rejectedOldHistory = false;
try { HistoryForUrlGuard.record("https://new.test", "new"); } catch { rejectedOldHistory = true; }
eq("★★ 旧历史的伪 file 地址不得在新增时被默许", rejectedOldHistory, true);
eq("★★ 旧历史可疑记录不被自动丢失", SettingRepo.get(HISTORY_KEY_FOR_URL_GUARD), invalidOldHistory);

resetBookmarks();
SettingRepo.set(HISTORY_KEY_FOR_URL_GUARD, "[]");
Bookmarks.add("https://valid-title.test", 42 as unknown as string);
HistoryForUrlGuard.record("https://valid-title.test", { corrupted: true } as unknown as string);
eq("异常外部网页标题不会污染收藏结构", bookmarkRows()[0]?.title, "");
eq("异常外部网页标题不会污染历史结构",
  JSON.parse(SettingRepo.get(HISTORY_KEY_FOR_URL_GUARD) ?? "[]")[0]?.title, "");
const excessiveTitle = "t".repeat(100_000);
Bookmarks.add("https://bounded-title.test", excessiveTitle);
HistoryForUrlGuard.record("https://bounded-title.test", excessiveTitle);
eq("超长收藏标题截断防止配置膨胀", bookmarkRows()[0]?.title && String(bookmarkRows()[0]?.title).length, 4096);
eq("超长历史标题也按同一上限截断",
  JSON.parse(SettingRepo.get(HISTORY_KEY_FOR_URL_GUARD) ?? "[]")[0]?.title.length, 4096);

console.log("\n收藏:上限");

// 「上限类逻辑要在追加时滚动截断」。这里 MAX_ENTRIES = 100:加第 101 条之后,
// 库里应当正好 100 行,而且**丢的是最早那条** —— 不是最新那条,也不是整批清掉。
resetBookmarks();
for (let i = 0; i < 101; i++) Bookmarks.add(`https://cap.test/${i}`, `第 ${i} 条`);
{
  const urls = bookmarkRows().map((r) => r.url);
  eq("加满 101 条之后库里只剩 100 行", urls.length, 100);
  eq("★ 最先加的那条被滚掉了", urls.includes("https://cap.test/0"), false);
  eq("★ 最后加的那条在最前面", urls[0], "https://cap.test/100");
  eq("★ 滚掉的是刚好超出上限那一条(第 1 条还在)", urls.includes("https://cap.test/1"), true);
  eq("剩下的正好是最近加的 100 条", urls[urls.length - 1], "https://cap.test/1");
}

// 满了之后再重复添加一条**已经在库里**的:那是"挪到最前 + 刷新标题",总行数不变,
// 因此**不该有人被挤出去**(先按 url 去掉旧的那条、再 unshift 一条,一进一出)。
{
  const before = bookmarkRows().map((r) => r.url);
  Bookmarks.add("https://cap.test/50", "重加一次");
  const after = bookmarkRows().map((r) => r.url);
  eq("满了之后重复添加:行数仍是 100", after.length, 100);
  eq("满了之后重复添加:那条挪到最前", after[0], "https://cap.test/50");
  eq("满了之后重复添加:标题被刷新", bookmarkRows()[0]?.title, "重加一次");
  eq(
    "满了之后重复添加:没有别人被挤出去",
    after.slice().sort(),
    before.slice().sort(),
  );
}

console.log("\n收藏 / 地址历史：损坏的持久设置不得假装空表并覆盖旧字节（ARC-005）");

const { BROWSER_ADDRESS_HISTORY_SETTING_KEY } = await import("@contracts/ipc");
const { AddressHistory } = await import("@main/browser/addressHistory.js");
for (const [kind, broken] of [
  ["截断 JSON", "{这不是 JSON"],
  ["错误顶层", '{"a":1}'],
  ["部分坏行", JSON.stringify([
    { url: "https://good.test", title: "好的", addedAt: 1 },
    { title: "没有 url", addedAt: 2 },
    null,
  ])],
  ["错误时间戳", JSON.stringify([{url:"https://x.test",title:"x",addedAt:"not-a-number"}])],
] as const) {
  SettingRepo.set(BROWSER_BOOKMARKS_SETTING_KEY, broken);
  let addError = "";
  try { Bookmarks.add("https://new.test", "测试"); } catch (err) { addError = String(err); }
  check(`书签 ${kind}：新增明确失败而非重建空表`, addError.includes("browser.bookmarks"), addError);
  eq(`书签 ${kind}：新增失败后原始字节不动`, SettingRepo.get(BROWSER_BOOKMARKS_SETTING_KEY), broken);

  let removeError = "";
  try { Bookmarks.remove("https://good.test"); } catch (err) { removeError = String(err); }
  check(`书签 ${kind}：删除明确失败`, removeError.includes("browser.bookmarks"), removeError);
  eq(`书签 ${kind}：删除失败后原始字节不动`, SettingRepo.get(BROWSER_BOOKMARKS_SETTING_KEY), broken);
}

for (const [kind, broken] of [
  ["截断 JSON", "{broken-json"],
  ["错误顶层", '{"entries":[]}'],
  ["部分坏行", JSON.stringify([
    { url: "https://good.test", title: "好的", at: 1 },
    { url: 123, title: "bad", at: 2 },
  ])],
  ["错误时间戳", JSON.stringify([{url:"https://x.test",title:"x",at:null}])],
] as const) {
  SettingRepo.set(BROWSER_ADDRESS_HISTORY_SETTING_KEY, broken);
  for (const [action, execute] of [
    ["记录", () => AddressHistory.record("https://new.test", "new")],
    ["删除", () => AddressHistory.remove("https://good.test")],
    ["清空", () => AddressHistory.clear()],
  ] as const) {
    let error = "";
    try { execute(); } catch (err) { error = String(err); }
    check(`地址历史 ${kind}：${action}拒写明确失败`, error.includes("browser.addressHistory"), error);
    eq(`地址历史 ${kind}：${action}不覆盖原始设置`, SettingRepo.get(BROWSER_ADDRESS_HISTORY_SETTING_KEY), broken);
  }
}

SettingRepo.set(BROWSER_BOOKMARKS_SETTING_KEY, "{partial");
{
  const result = await call(IPC.BROWSER_BOOKMARK_ADD, { url:"https://ipc.test", title:"hello" }) as {ok:boolean;error?:string};
  eq("书签坏档：真 IPC 不报假成功", result.ok, false);
  check("书签坏档：真 IPC 给出可读错误", typeof result.error === "string" && result.error.includes("browser.bookmarks"));
  eq("书签坏档：真 IPC 不改原字节", SettingRepo.get(BROWSER_BOOKMARKS_SETTING_KEY), "{partial");
}
SettingRepo.set(BROWSER_ADDRESS_HISTORY_SETTING_KEY, "{partial");
{
  const result = await call(IPC.BROWSER_HISTORY_CLEAR, undefined) as {ok:boolean;error?:string};
  eq("历史坏档：真 IPC 不报假清空", result.ok, false);
  check("历史坏档：真 IPC 给出可读错误", typeof result.error === "string" && result.error.includes("browser.addressHistory"));
  eq("历史坏档：真 IPC 不改原字节", SettingRepo.get(BROWSER_ADDRESS_HISTORY_SETTING_KEY), "{partial");
}
SettingRepo.set(BROWSER_ADDRESS_HISTORY_SETTING_KEY, "[]");
AddressHistory.record("https://healthy.test", "ok");
eq("地址历史健康数据：原单写者路径仍可记录", JSON.parse(SettingRepo.get(BROWSER_ADDRESS_HISTORY_SETTING_KEY) ?? "[]").map((e: {url:string}) => e.url), ["https://healthy.test"]);
AddressHistory.clear();
eq("地址历史健康数据：主动清空仍有效", SettingRepo.get(BROWSER_ADDRESS_HISTORY_SETTING_KEY), "[]");


console.log("\n收藏:走真的那条 IPC");

// 下面这一段**只做一个用户动作**:`await api.browser.bookmarkAdd(...)`。
// 所有断言都是它的结果 —— 这样哪天有人把 handler 里那句 `Bookmarks.add` 拆掉,
// 这几条会立刻红。
resetBookmarks();
{
  const added = await call(IPC.BROWSER_BOOKMARK_ADD, {
    url: "https://via-ipc.test/x",
    title: "从 IPC 进来的",
  });
  eq("bookmarkAdd 返回 ok", (added as { ok: boolean }).ok, true);
  eq(
    "IPC 加的那条,直接读 Bookmarks 那份也看得见(两半是同一份状态)",
    storedUrls(),
    ["https://via-ipc.test/x"],
  );

  // 反过来:直接写,IPC 那边读到的也应当是同一份(证明没有两份模块实例)。
  Bookmarks.add("https://direct.test/y", "直接写的");
  eq(
    "直接写的,IPC 库里的顺序也认(还是同一份)",
    storedUrls(),
    ["https://direct.test/y", "https://via-ipc.test/x"],
  );

  const removed = await call(IPC.BROWSER_BOOKMARK_REMOVE, { url: "https://via-ipc.test/x" });
  eq("bookmarkRemove 返回 ok", (removed as { ok: boolean }).ok, true);
  eq("IPC 删的那条真的没了", storedUrls(), ["https://direct.test/y"]);

  const dropped = await call(IPC.BROWSER_BOOKMARK_ADD, {
    url: "about:blank",
    title: "空白页",
  });
  eq("加一个 about: 页仍然报 ok(契约如此)", (dropped as { ok: boolean }).ok, true);
  eq("但它没进库", storedUrls(), ["https://direct.test/y"]);
}

/* ──────────────── 2. 每条通道:合法入参转交了什么 ──────────────── */

console.log("\nIPC:合法入参 → 委托给 BrowserManager 的参数");

// 本仓库根：**从运行时推**，不写死某台机器的路径。（2026-10-23 仓库搬家后，
// 原来的字面量指向一个已不存在的目录；套件仍然绿，因为包含判定是纯字符串比较、
// 不查盘 —— 也就是说只有那句「真实存在」的注释是错的，而它会把下一个读的人
// 引到一条不存在的路上。）
const PROJECT = process.cwd();
ProjectRepo.create({
  id: "p1",
  name: "本仓库",
  path: PROJECT,
  archived: false,
  sortOrder: 0,
  pinnedAt: null,
  createdAt: 1,
  updatedAt: 1,
});

/** 每条通道一条:名字 + channel + 入参 + 该被委托到的方法 + 期望参数。 */
const HAPPY: Array<{
  name: string;
  channel: string;
  raw: unknown;
  fn: string;
  args: unknown[];
}> = [
  { name: "create", channel: IPC.BROWSER_CREATE, raw: { projectPath: PROJECT }, fn: "create", args: [PROJECT, undefined] },
  { name: "loadUrl", channel: IPC.BROWSER_LOAD_URL, raw: { browserId: "b1", url: "https://a.test" }, fn: "loadUrl", args: ["b1", "https://a.test"] },
  { name: "goBack", channel: IPC.BROWSER_GO_BACK, raw: { browserId: "b1" }, fn: "goBack", args: ["b1"] },
  { name: "goForward", channel: IPC.BROWSER_GO_FORWARD, raw: { browserId: "b1" }, fn: "goForward", args: ["b1"] },
  { name: "reload", channel: IPC.BROWSER_RELOAD, raw: { browserId: "b1" }, fn: "reload", args: ["b1"] },
  {
    name: "setBounds",
    channel: IPC.BROWSER_SET_BOUNDS,
    raw: { browserId: "b1", x: 12, y: 34, width: 800, height: 600 },
    fn: "setBounds",
    args: ["b1", { x: 12, y: 34, width: 800, height: 600 }],
  },
  { name: "setPickMode", channel: IPC.BROWSER_SET_PICK_MODE, raw: { browserId: "b1", enabled: true }, fn: "setPickMode", args: ["b1", true] },
  { name: "show", channel: IPC.BROWSER_SHOW, raw: { browserId: "b1" }, fn: "show", args: ["b1"] },
  { name: "hide", channel: IPC.BROWSER_HIDE, raw: { browserId: "b1" }, fn: "hide", args: ["b1"] },
  { name: "close", channel: IPC.BROWSER_CLOSE, raw: { browserId: "b1" }, fn: "close", args: ["b1"] },
  { name: "captureFrame", channel: IPC.BROWSER_CAPTURE_FRAME, raw: { browserId: "b1" }, fn: "captureFrame", args: ["b1"] },
  {
    name: "setDevice",
    channel: IPC.BROWSER_SET_DEVICE,
    raw: {
      browserId: "b1",
      device: "custom",
      width: 500,
      height: 700,
      orientation: "landscape",
      viewportWidth: 500,
      viewportHeight: 700,
    },
    fn: "setDevice",
    args: [
      "b1",
      "custom",
      { width: 500, height: 700, orientation: "landscape", viewportWidth: 500, viewportHeight: 700 },
    ],
  },
  { name: "clearCache", channel: IPC.BROWSER_CLEAR_CACHE, raw: undefined, fn: "clearBrowserCache", args: [] },
  { name: "clearCookies", channel: IPC.BROWSER_CLEAR_COOKIES, raw: undefined, fn: "clearBrowserCookies", args: [] },
  { name: "historyRemove", channel: IPC.BROWSER_HISTORY_REMOVE, raw: { url: "https://h.test" }, fn: null as never, args: [] },
  { name: "downloadAction", channel: IPC.BROWSER_DOWNLOAD_ACTION, raw: { downloadId: "d1", action: "reveal" }, fn: "downloadAction", args: ["d1", "reveal"] },
];

for (const row of HAPPY) {
  if (row.fn === (null as never)) continue; // historyRemove 不进 BrowserManager,单独断
  const { out, calls } = await callAndRecord(row.channel, row.raw);
  eq(`${row.name}: 返回 ok`, (out as { ok: boolean }).ok, true);
  eq(`${row.name}: 委托给了 ${row.fn}`, calls, [row.fn]);
  eq(`${row.name}: 转交的参数没走样`, stub.lastCall(row.fn)?.args, row.args);
}

// historyRemove 只动设置行,不碰 BrowserManager。
{
  const { calls } = await callAndRecord(IPC.BROWSER_HISTORY_REMOVE, { url: "https://h.test" });
  eq("historyRemove: 不碰 BrowserManager(它只删设置行)", calls, []);
}

console.log("\nIPC:create 的项目路径闸门");

{
  const { out, calls } = await callAndRecord(IPC.BROWSER_CREATE, { projectPath: "D:\\不存在的项目\\xyz" });
  const res = out as { ok: boolean; error?: string };
  eq("未知项目路径 → ok:false", res.ok, false);
  check("未知项目路径: 根本没去建视图", calls.length === 0, { calls });
  check("未知项目路径: 那句话是给人看的(中文一句)", typeof res.error === "string" && res.error.length > 0, res.error);
  check("未知项目路径: 那句话里没有内部错误对象的形状", !hasZodShape(res.error), res.error);
}

console.log("\nIPC:委托方说不行时,原话原样回去");

// handler 的职责之一是"把被委托方的失败透出来",不能改写成别的话、也不能吞成 ok。
for (const fn of ["loadUrl", "show", "close", "downloadAction"]) {
  const channel = HAPPY.find((h) => h.fn === fn)!.channel;
  const raw = HAPPY.find((h) => h.fn === fn)!.raw;
  stub.override(fn, { ok: false, error: `${fn} 说不行了` });
  const out = (await call(channel, raw)) as { ok: boolean; error?: string };
  eq(`${fn}: 委托方说不行 → ok:false`, out.ok, false);
  eq(`${fn}: 委托方那句话原样回去`, out.error, `${fn} 说不行了`);
  stub.clearOverrides();
}

console.log("\nIPC:入参不合法时");

// ★ 这一段钉的是"校验真的挡住了,而且交回来的是人话"。
//   两条独立的东西,缺哪条都算漏:
//   ① 不合法就不该打下去(否则等于没校验,只是让下游报了个更难懂的错);
//   ② 交回来的 error 不该是 zod 的内部形状 —— 它会出现在浏览器面板中间那行字上
//      (`BrowserPanel.tsx` 的 `setError(res.error)`),用户看到的不该是一屏 JSON。
const INVALID: Array<{ name: string; channel: string; raw: unknown; fn?: string; field: string }> = [
  { name: "create 少了 projectPath", channel: IPC.BROWSER_CREATE, raw: {}, fn: "create", field: "projectPath" },
  { name: "create projectPath 是空串", channel: IPC.BROWSER_CREATE, raw: { projectPath: "" }, fn: "create", field: "projectPath" },
  { name: "loadUrl 少了 browserId", channel: IPC.BROWSER_LOAD_URL, raw: { url: "https://a.test" }, fn: "loadUrl", field: "browserId" },
  { name: "loadUrl 的 url 是空的", channel: IPC.BROWSER_LOAD_URL, raw: { browserId: "b1", url: "" }, fn: "loadUrl", field: "url" },
  { name: "show 少了 browserId", channel: IPC.BROWSER_SHOW, raw: {}, fn: "show", field: "browserId" },
  { name: "setBounds 宽度是 0", channel: IPC.BROWSER_SET_BOUNDS, raw: { browserId: "b1", x: 0, y: 0, width: 0, height: 600 }, fn: "setBounds", field: "width" },
  { name: "setBounds 宽度是负的(设备工具栏输入框能打出来)", channel: IPC.BROWSER_SET_BOUNDS, raw: { browserId: "b1", x: 0, y: 0, width: -5, height: 600 }, fn: "setBounds", field: "width" },
  { name: "setBounds 宽度是小数", channel: IPC.BROWSER_SET_BOUNDS, raw: { browserId: "b1", x: 0, y: 0, width: 1.5, height: 600 }, fn: "setBounds", field: "width" },
  { name: "setPickMode 的 enabled 不是布尔", channel: IPC.BROWSER_SET_PICK_MODE, raw: { browserId: "b1", enabled: "yes" }, fn: "setPickMode", field: "enabled" },
  { name: "setDevice 的设备名不认识", channel: IPC.BROWSER_SET_DEVICE, raw: { browserId: "b1", device: "nokia" }, fn: "setDevice", field: "device" },
  { name: "setDevice 自定义宽度是负的", channel: IPC.BROWSER_SET_DEVICE, raw: { browserId: "b1", device: "custom", width: -5 }, fn: "setDevice", field: "width" },
  { name: "bookmarkAdd 少了 title", channel: IPC.BROWSER_BOOKMARK_ADD, raw: { url: "https://a.test" }, field: "title" },
  { name: "bookmarkAdd 的 url 是空的", channel: IPC.BROWSER_BOOKMARK_ADD, raw: { url: "", title: "x" }, field: "url" },
  { name: "bookmarkRemove 的 url 是空的", channel: IPC.BROWSER_BOOKMARK_REMOVE, raw: { url: "" }, field: "url" },
  { name: "historyRemove 的 url 是空的", channel: IPC.BROWSER_HISTORY_REMOVE, raw: { url: "" }, field: "url" },
  { name: "downloadAction 的动作不认识", channel: IPC.BROWSER_DOWNLOAD_ACTION, raw: { downloadId: "d1", action: "launch" }, fn: "downloadAction", field: "action" },
  { name: "authRespond 的 requestId 是空的", channel: IPC.BROWSER_AUTH_RESPOND, raw: { requestId: "", username: "u", password: "p" }, fn: "respondAuth", field: "requestId" },
];

for (const row of INVALID) {
  const { out, calls } = await callAndRecord(row.channel, row.raw);
  const res = out as { ok?: boolean; error?: string } | undefined;

  if (row.fn) {
    eq(`${row.name}: 校验挡住了,没打给 BrowserManager`, calls, []);
  }
  if (res && typeof res === "object" && "ok" in res) {
    eq(`${row.name}: 报 ok:false`, res.ok, false);
    check(`${row.name}: 说的是人话(含字段名「${row.field}」)`, typeof res.error === "string" && res.error.includes(row.field), res.error);
    check(`★ ${row.name}: 交回来的不是 zod 的内部 JSON`, !hasZodShape(res.error), res.error);
  } else {
    // 【UI-015】authRespond 的契约现在是 Promise<BrowserAuthRespondResult> ——
    // 入参不合法时也**回一个 failed 回执**(不再是 void、也不 throw)。判据有两条:
    // ① 没把用户填的凭据交给 BrowserManager;② 明确回 failed(弹窗据此不关闭)。
    check(`${row.name}: 没有把用户填的凭据交出去`, calls.length === 0, { calls });
    eq(`${row.name}: 回 failed 回执(可判别,不是 void)`, (out as { status?: string } | undefined)?.status, "failed");
  }
}

// 零参通道:preload 那边一个形参都不传,handler 也不收 raw。它们不该因为
// "raw 是 undefined" 就报错 —— 那是它们的正常形状。
console.log("\nIPC:零参通道(raw 就是 undefined)");
for (const [name, channel, fn] of [
  ["clearCache", IPC.BROWSER_CLEAR_CACHE, "clearBrowserCache"],
  ["clearCookies", IPC.BROWSER_CLEAR_COOKIES, "clearBrowserCookies"],
  ["vaultStatus", IPC.BROWSER_VAULT_STATUS, "vaultStatus"],
] as const) {
  const { out, calls } = await callAndRecord(channel, undefined);
  if (name === "vaultStatus") {
    // 【MC-023】status 不是 {ok} 形状 —— 它要求"原样转发被委托方的健康态"。
    eq(`${name}: 走到了 ${fn}`, calls, [fn]);
    eq(
      `${name}: 原样交回保管库健康态(不吞字段)`,
      (out as { encryptionAvailable?: boolean }).encryptionAvailable,
      false,
    );
  } else {
    eq(`${name}: 不传任何入参也返回 ok`, (out as { ok: boolean }).ok, true);
    eq(`${name}: 走到了 ${fn}`, calls, [fn]);
  }
}

// historyClear 是唯一一条"契约声明了入参、preload 却不传"的通道(见 run.sh 里的
// ⚠️ 段)。它今天能работать 是因为 schema 是空对象;这条断言把"它确实清干净了"钉住,
// 而不是把断掉的形状钉住。
{
  SettingRepo.set("browser.addressHistory", JSON.stringify([{ url: "https://h.test", title: "x", at: 1 }]));
  const { out } = await callAndRecord(IPC.BROWSER_HISTORY_CLEAR, undefined);
  eq("historyClear: 返回 ok", (out as { ok: boolean }).ok, true);
  const left = SettingRepo.get("browser.addressHistory");
  eq("historyClear: 历史行真的被清空了", left, "[]");
}

console.log("\nIPC:authRespond 的合法入参");

{
  const { out, calls } = await callAndRecord(IPC.BROWSER_AUTH_RESPOND, {
    requestId: "r1",
    username: "u",
    password: "p",
  });
  eq("authRespond: 转交给了 BrowserManager.respondAuth", calls, ["respondAuth"]);
  eq("authRespond: 凭据原样带过去", stub.lastCall("respondAuth")?.args, ["r1", "u", "p"]);
  // 【UI-015】handler 把 BrowserManager 判定的状态原样包成回执交回渲染端 —— 从前
  // 这里断言的是 "Promise<void> 所以没返回值",于是"已投递"和"challenge 早就没了"
  // 在下游无法区分,弹窗一律关闭。
  eq("authRespond: 把 BrowserManager 的状态原样转成回执", (out as { status?: string } | undefined)?.status, "accepted");
  eq("authRespond: 回执带回同一个 requestId(便于渲染端确认是哪一次)", (out as { requestId?: string } | undefined)?.requestId, "r1");
}

// 【UI-015】三种"非已投递"状态必须如实回传,让弹窗能分辨"凭证送出去了"与
// "这次 challenge 已经没了/投递失败"。覆盖 cancelled / expired / failed 三态。
{
  for (const status of ["cancelled", "expired", "failed"] as const) {
    stub.override("respondAuth", status);
    const { out } = await callAndRecord(IPC.BROWSER_AUTH_RESPOND, {
      requestId: "r2",
      username: "u",
      password: "p",
    });
    eq(`authRespond(${status}): 状态原样回传`, (out as { status?: string } | undefined)?.status, status);
  }
  stub.clearOverrides();
}

/* ──────────────── 渲染端:清除缓存 / Cookie 的失败出口 ────────────────
 *
 * `browser.clearCache` / `browser.clearCookies` 回的是 `BrowserOpResult`(`{ok, error?}`),
 * 主进程两条 handler 的 catch 都如实回 `{ok:false, error}`(`BrowserManager.clearBrowser*`
 * 内部 catch 后 `return { ok:false, error: msg }`)。而渲染端两个入口从前**不看返回值**
 * —— `void api.browser.clearCache()` 一丢了事。清 Cookie 是**安全动作**(用户在确认框里
 * 点了"退出所有网站、重启不恢复"),静默失败会让用户以为已经退出,而会话里的登录令牌
 * 还活着。判据钉在源码上(组件无头跑不出来,本套没有渲染端 host)。 */
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(process.cwd(), "src/renderer/components/browser/BrowserPanel.tsx"), "utf8");
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [fn, key] of [
    ["handleClearCache", "browser.clearCacheFailed"],
    ["handleClearCookies", "browser.clearCookiesFailed"],
  ] as const) {
    const at = code.indexOf(fn);
    // 从函数声明起截到下一个 `}, [` —— 恰好是这个 useCallback 的结尾。
    const body = code.slice(at, code.indexOf("}, [", at));
    check(
      `★ ${fn} 检查 {ok:false} 并报出来(从前一丢了事)`,
      at >= 0 && /\.then\(/.test(body) && /reportBrowserOpFailure/.test(body) && body.includes(key),
      body.slice(0, 260),
    );
  }
  // 共用出口必须真的按 ok 判、并走 toast。(锚在**声明**上 —— `const
  // reportBrowserOpFailure = useCallback` —— 否则 indexOf 会先撞上某个调用点。)
  {
    const at = code.indexOf("const reportBrowserOpFailure");
    const body = code.slice(at, code.indexOf("}, [", at));
    check(
      "★ 浏览器操作失败出口按 ok 判并走 toast",
      at >= 0 && /if\s*\(res\.ok\)\s*return;/.test(body) && body.includes("useToastStore.getState().push("),
      body.slice(0, 300),
    );
  }
  // 【UI-014】导航 / 返回 / 前进 / 刷新 / 关标签页这五条从前是 `void api.browser.xxx(...)`,
  // 主进程 `{ok:false}`(视图崩了 / 已关闭)被丢掉:地址栏先改成新 URL、业务拒绝后不报错,
  // 看着就是点了没反应。现在必须消费结果(共享失败出口 + 地址栏 navError)。
  for (const [fn, key] of [
    ["handleNavigate", "browser.loadFailed"],
    ["handleBack", "browser.backFailed"],
    ["handleForward", "browser.forwardFailed"],
    ["handleReload", "browser.reloadFailed"],
    ["handleCloseTab", "browser.closeTabFailed"],
  ] as const) {
    // ⚠️ 用**原始**源码(不剥注释)锚:剥注释的 `/\*[\s\S]*?\*/` 会跨行吃掉 `const … =
    // useCallback(` 那一行(本文件里前面的块注释与后面的 `*/` 相隔很远),导致锚找不到。
    // 只看「声明处到该回调依赖数组结尾」这一段里有没有消费结果即可。
    const at = src.indexOf(`const ${fn} = useCallback`);
    const body = at >= 0 ? src.slice(at, src.indexOf("}, [", at)) : "";
    check(
      `★ ${fn} 消费 {ok:false}(不再 void 丢回包)`,
      at >= 0 && /\.then\(/.test(body) && /navError/.test(body) && body.includes(key),
      body.slice(0, 260),
    );
  }
  // 地址栏组件要真的把 navError 画出来(红边 + title),否则上面的标错用户看不见。
  {
    const { readFileSync: rf } = await import("node:fs");
    const { join: j } = await import("node:path");
    const tb = rf(j(process.cwd(), "src/renderer/components/browser/BrowserToolbar.tsx"), "utf8");
    check("★ 地址栏消费 navError(红边 + title,点失败看得见)", /navError/.test(tb) && /border-danger|title=\{navError/.test(tb), null);
  }
  // 下载栏两处(打开文件 / 在文件夹中显示)与清除那两条同一契约 —— 主进程会带原因拒。
  for (const [fn, key] of [
    ["handleDownloadOpen", "browser.downloadOpenFailed"],
    ["handleDownloadReveal", "browser.downloadRevealFailed"],
  ] as const) {
    const at = code.indexOf(fn);
    const body = code.slice(at, code.indexOf("}, [", at));
    check(
      `★ ${fn} 检查 {ok:false} 并报出来(从前一丢了事)`,
      at >= 0 && /\.then\(/.test(body) && /reportBrowserOpFailure/.test(body) && body.includes(key),
      body.slice(0, 260),
    );
  }
  // 收藏 / 历史那四条增删也是 `browser.*` 的 `{ok:false}` 契约,同一共用出口。
  // 主进程 `browser.bookmarkAdd/Remove`、`historyRemove/Clear` 一律回 `{ok:false,
  // error}`,从前渲染端这四处只 `.then(refresh…)`(或对 bookmark 干脆把回包丢了),
  // 于是点"取消收藏"那一行还在、点"清空历史"列表纹丝不动 —— 看着就是点了没反应。
  // ⚠️ 锚在**声明**上(`const handleX = useCallback`),否则 `indexOf` 会先撞上某个
  // 调用点(如 `handleRemoveBookmark` 也出现在 `handleMoreMenuOpenChange` 附近)。
  for (const [decl, key] of [
    ["const handleToggleBookmark = useCallback", "browser.bookmark"],
    ["const handleRemoveBookmark = useCallback", "browser.bookmarkRemoveFailed"],
    ["const handleRemoveHistoryEntry = useCallback", "browser.historyRemoveFailed"],
    ["const handleClearHistory = useCallback", "browser.historyClearFailed"],
  ] as const) {
    const at = code.indexOf(decl);
    const body = code.slice(at, code.indexOf("}, [", at));
    check(
      `★ ${decl.replace("const ", "").replace(" = useCallback", "")} 把 {ok:false} 交给共用失败出口`,
      at >= 0 &&
        /\.then\(/.test(body) &&
        /reportBrowserOpFailure/.test(body) &&
        body.includes(key),
      body.slice(0, 300),
    );
  }
  // 正控(防断言空过):这四处从前长什么样 —— 直接 `.then(refresh…)`,没有任何
  // `reportBrowserOpFailure`。这里要求**两者都在场且失败出口在前**,`indexOf` 的
  // -1 也算"在场"会让正控恒真。
  {
    const at = code.indexOf("const handleClearHistory = useCallback");
    const body = code.slice(at, code.indexOf("}, [", at));
    const report = body.indexOf("reportBrowserOpFailure");
    const refresh = body.indexOf("refreshHistory()");
    check(
      "…正控:清空历史**先报失败再刷新**(两者都在场,失败出口在前)",
      at >= 0 && report >= 0 && refresh >= 0 && report < refresh,
      body.slice(0, 300),
    );
  }
}

/* ──────────────── 渲染端:UI-015 HTTP Basic Auth 提交回执 ────────────────
 *
 * `AuthPromptDialog` 从前 `void api.browser.authRespond(...)` 之后**无条件 `onClose()`** ——
 * 而主进程可能因为 challenge 超时/已被消费而没有可投递的回调,应答被静默丢弃,弹窗照样消失,
 * 用户以为登录已提交。现在必须消费 `BrowserAuthRespondResult` 回执:只有
 * accepted/cancelled 才关闭,expired/failed 保持弹窗并显示原因。判据钉在源码上
 * (组件需要渲染 host,本套无头跑不出来)。 */
{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dlg = readFileSync(join(process.cwd(), "src/renderer/components/browser/AuthPromptDialog.tsx"), "utf8");
  const code = dlg.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // submit 函数体:从 `const submit = async` 锚到下一个顶层 `};`。
  const at = code.indexOf("const submit = async");
  const body = at >= 0 ? code.slice(at, code.indexOf("\n  };", at)) : "";
  check(
    "★ UI-015:authRespond 回执被 await(不再是 void 丢回包)",
    at >= 0 && /const\s+res\s*=\s*await\s+api\.browser\.authRespond/.test(body),
    body.slice(0, 260),
  );
  check(
    "★ UI-015:只在 accepted/cancelled 时关闭(expired/failed 不关闭)",
    /res\.status === "accepted"\s*\|\|\s*res\.status === "cancelled"/.test(body) && /onClose\(\)/.test(body),
    body.slice(0, 320),
  );
  check(
    "★ UI-015:非已投递状态落成可见错误(setSubmitError)",
    /setSubmitError\(/.test(body) && /"expired"/.test(body) && /"failed"/.test(body),
    body.slice(0, 320),
  );
  // 错误态必须在 UI 上画出来(否则 setSubmitError 只是死字段)。
  check(
    "★ UI-015:错误态渲染出提示(browser.authExpired / browser.authFailed)",
    /submitError/.test(dlg) && dlg.includes("browser.authExpired") && dlg.includes("browser.authFailed"),
    null,
  );
  // 提交途中禁用按钮 + 进行中指示(防重复提交)。
  check(
    "★ UI-015:提交途中禁用登录按钮并显示进行中",
    /disabled=\{[^}]*submitting[^}]*\}/.test(dlg) && /<Spinner/.test(dlg),
    null,
  );
}

/* ──────────────── 3. MC-043 跨项目目标隔离 ────────────────
 *
 * `agentTargeting.resolveBrowserTarget` 是"一次无 browserId 的 agent 调用该落到哪个
 * 视图"的纯逻辑。判据立在**会话 A 能不能隐式操作会话 B 打开的标签**上 —— 这正是
 * MC-043 要挡住的事。
 */

console.log("\nMC-043:agent 浏览器目标按项目隔离");

{
  const { resolveBrowserTarget } = await import("@main/browser/agentTargeting.js");
  const PA = "P:甲项目";
  const PB = "P:乙项目";
  const views = [
    { browserId: "a1", projectPath: PA },
    { browserId: "b1", projectPath: PB },
  ];

  // 甲项目会话:无 browserId,带上自己的 projectPath → 只在自己项目里挑。
  eq(
    "甲项目的会话解析到甲项目自己的活动视图",
    resolveBrowserTarget(views, { projectPath: PA, activeForProject: "a1" }),
    { ok: true, browserId: "a1" },
  );
  // ★ 核心:甲项目会话**永远**解析不到乙项目的视图 —— 哪怕甲还没有任何活动指针,
  //   也只能落到甲自己的第一个视图(这里没有 → 报 no-live-browser),而不是 a1/b1 串台。
  eq(
    "★ 甲项目的会话在没有自己视图时,不会落到乙项目的标签上(报 no-live-browser)",
    resolveBrowserTarget([{ browserId: "b1", projectPath: PB }], { projectPath: PA, activeForProject: null }),
    { ok: false, reason: "no-live-browser" },
  );
  // ★ 显式指定乙项目的 browserId,但调用方属于甲 → 拒绝(不许跨项目显式操作)。
  {
    const r = resolveBrowserTarget(views, { browserId: "b1", projectPath: PA });
    check("★ 甲项目显式要乙项目的 browserId → 拒绝(不许跨项目操作)", r.ok === false, r);
  }
  // 显式指定本项目自己的 browserId → 放行。
  eq(
    "甲项目显式要自己项目的 browserId → 放行",
    resolveBrowserTarget(views, { browserId: "a1", projectPath: PA }),
    { ok: true, browserId: "a1" },
  );
  // 活动指针指向一个已经不存在的 id(被关掉了)→ 落到本项目第一个,而不是串到乙项目。
  eq(
    "活动指针指向已关闭的视图 → 退回本项目第一个(不串项目)",
    resolveBrowserTarget([{ browserId: "a2", projectPath: PA }, views[1]!], {
      projectPath: PA,
      activeForProject: "a_dead",
    }),
    { ok: true, browserId: "a2" },
  );

  // 老调用方(不带 projectPath)行为与改造前逐字一致:全局活动指针 → 第一个活视图。
  eq(
    "不带 projectPath 的老调用方:沿用全局活动指针(行为不变)",
    resolveBrowserTarget(views, { activeGlobal: "b1" }),
    { ok: true, browserId: "b1" },
  );
  eq(
    "不带 projectPath 且没有全局指针:第一个活视图(行为不变)",
    resolveBrowserTarget(views, {}),
    { ok: true, browserId: "a1" },
  );
  eq(
    "没有任何活视图 → no-live-browser",
    resolveBrowserTarget([], { projectPath: PA }),
    { ok: false, reason: "no-live-browser" },
  );
}

/* ──────────────── 4. MC-044 file:// 工作区围栏 ──────────────── */

console.log("\nMC-044:browser_navigate 的 file:// 受项目根围栏约束");

{
  const { fileUrlWorkspaceError } = await import("@main/browser/agentTargeting.js");
  // PROJECT 已在上面 §2 注册进 ProjectRepo。它只作为**一条具体的根路径样本**参与
  // 下面的判定（`fileUrlWorkspaceError` 用纯字符串包含比较，不查盘），所以它的值
  // 取自运行时 cwd，而不是写死某台机器的路径。
  const fileUrl = (p: string): string => "file:///" + p.replace(/\\/g, "/").replace(/^\//, "");
  const insideUrl = fileUrl(join(PROJECT, "docs", "page.html"));
  const outsideUrl = process.platform === "win32" ? "file:///C:/Windows/system.ini" : "file:///etc/hostname";

  eq("★ 项目内的 file:// → 放行(null 表示无错)", fileUrlWorkspaceError(insideUrl), null);
  check(
    "★ 项目外的 file:// → 拒绝(不绕过 agent 文件工具的项目根护栏)",
    typeof fileUrlWorkspaceError(outsideUrl) === "string",
    { err: fileUrlWorkspaceError(outsideUrl) },
  );
  eq("http(s) URL 不受路径围栏约束 → 放行", fileUrlWorkspaceError("https://example.com/x"), null);
}

/* ──────────────── 5. MC-043 跨项目隔离:真工具函数 + 假视图清单 ────────────────
 *
 * §3 验的是**纯判定** `resolveBrowserTarget`(喂数组)。这里再往上走一层:直接调
 * `agentBrowserTools.ts` 的**真 `browser_*` 函数**,把 `BrowserManager` 换成桩
 * (文件头 §2 已说明 `--alias:@main/browser/BrowserManager.js=…` 是与主 bundle 共享
 * 同一份实例的那一刀),摆两个项目各一个视图,看 B 项目的 agent 会不会串到 A:
 *
 *   - B 调 `browser_list({projectPath:B})` 不得出现 A 的 browserId / URL / 标题;
 *   - B 的无 browserId 调用**即使全局活动指针指着 A**,也必须落到 B 自己的视图;
 *   - B 显式传 A 的 browserId → 拒绝,且**一次都不落到 A 上**;
 *   - 同项目调用照常工作(不误伤)。
 *
 * 判据立在**返回给 agent 的那段文字**(含 sentinel 正文)与**桩记下的目标 id**上 ——
 * 两样都是"用户/模型真能看到、真会作用到"的东西。
 */

console.log("\nMC-043:agent 浏览器工具的跨项目隔离(真工具函数 + 假视图)");

{
  const tools = await import("@main/browser/agentBrowserTools.js");
  const PA = "P:甲项目";
  const PB = "P:乙项目";
  const SENT_A = "SENTINEL-A-甲项目私密正文";
  const SENT_B = "SENTINEL-B-乙项目正文";

  // 取一个工具结果里的全部文字。【ARC-017】用权威合同导出的唯一一份提取器,不再本地
  // 手写"把 content 断言成 { type; text? }[]"—— SDK 加块时那种写法会与真实结构漂移。
  const toolText = (r: ToolResult): string => toolTextOf(r);

  stub.setViews([
    { browserId: "a1", projectPath: PA, url: "https://a.example/secret", title: "A 页", body: SENT_A },
    { browserId: "b1", projectPath: PB, url: "https://b.example/home", title: "B 页", body: SENT_B },
  ]);

  // 制造"全局活动指针指着 A"的处境:让 A 项目的会话 switch 到 a1(它会同时写全局兜底)。
  stub.resetRecorded();
  await tools.browserSwitchTab({ browserId: "a1", projectPath: PA });
  check(
    "前置:B 项目会话无 browserId 时,全局活动指针确实指着 A(制造串台处境)",
    stub.lastCall("notifyAgentOpened")?.args[0] === "a1",
    stub.lastCall("notifyAgentOpened")?.args,
  );

  // ── 1. B 的 browser_list 不得暴露 A 的任何东西 ──
  {
    stub.resetRecorded();
    const r = tools.browserList(PB);
    const t = toolText(r);
    check("★ B 的 browser_list 不出现 A 的 browserId", !t.includes("a1"), t.slice(0, 200));
    check("★ B 的 browser_list 不出现 A 的 URL", !t.includes("a.example"), t.slice(0, 200));
    check("★ B 的 browser_list 不出现 A 的标题", !t.includes("A 页"), t.slice(0, 200));
    check("B 的 browser_list 正常列出自己的 b1", t.includes("b1"), t.slice(0, 200));
  }

  // ── 2. B 无 browserId 的 snapshot:全局指针在 A,也必须落到 B ──
  {
    stub.resetRecorded();
    const r = await tools.browserSnapshot({ projectPath: PB });
    const t = toolText(r);
    check("★ B 无 browserId 的 snapshot 落到 B 自己的视图(不被全局指针带到 A)",
      stub.lastCall("snapshot")?.args[0] === "b1", stub.lastCall("snapshot")?.args);
    check("★ B 的 snapshot 正文是自己的 sentinel,读不到 A 的正文",
      t.includes(SENT_B) && !t.includes(SENT_A), t.slice(0, 200));
  }

  // ── 3. B 显式要 A 的 browserId → 拒绝,且不落到 A ──
  {
    stub.resetRecorded();
    const r = await tools.browserSnapshot({ browserId: "a1", projectPath: PB });
    const t = toolText(r);
    check("★ B 显式传 A 的 browserId 的 snapshot → 拒绝", /❌|拒绝|另一个项目/.test(t), t.slice(0, 200));
    check("★ 被拒绝的 snapshot 一次都没落到 A 上",
      stub.lastCall("snapshot") === undefined || stub.lastCall("snapshot")?.args[0] !== "a1",
      stub.lastCall("snapshot")?.args);
  }

  // ── 4. B 显式传自己项目的 browserId → 放行 ──
  {
    stub.resetRecorded();
    const r = await tools.browserSnapshot({ browserId: "b1", projectPath: PB });
    const t = toolText(r);
    check("B 显式传自己项目的 browserId → 放行且读到自己的正文",
      stub.lastCall("snapshot")?.args[0] === "b1" && t.includes(SENT_B) && !t.includes(SENT_A),
      { call: stub.lastCall("snapshot")?.args });
  }

  // ── 5. B 的 click 无 browserId → 落到 B,不点到 A ──
  {
    stub.resetRecorded();
    await tools.browserClick({ selector: "#btn", projectPath: PB });
    check("★ B 无 browserId 的 click 落到自己的视图(不点到 A)",
      stub.lastCall("click")?.args[0] === "b1", stub.lastCall("click")?.args);
  }

  // ── 6. B 显式要 A 的 browserId 的 click → 拒绝,不点到 A ──
  {
    stub.resetRecorded();
    const r = await tools.browserClick({ browserId: "a1", selector: "#btn", projectPath: PB });
    const t = toolText(r);
    check("★ B 显式传 A 的 browserId 的 click → 拒绝", /❌|拒绝|另一个项目/.test(t), t.slice(0, 200));
    check("★ 被拒绝的 click 一次都没点到 A",
      stub.lastCall("click") === undefined || stub.lastCall("click")?.args[0] !== "a1",
      stub.lastCall("click")?.args);
  }

  // ── 7. 同项目(A 自己)照常工作,不误伤 ──
  {
    stub.resetRecorded();
    const r = await tools.browserSnapshot({ projectPath: PA });
    const t = toolText(r);
    check("A 项目自己的无 browserId snapshot 照常落到 a1 并读到自己的正文",
      stub.lastCall("snapshot")?.args[0] === "a1" && t.includes(SENT_A) && !t.includes(SENT_B),
      { call: stub.lastCall("snapshot")?.args });
  }

  // ── 8. 老调用方(不带 projectPath)行为不变:沿用全局指针 ──
  {
    stub.resetRecorded();
    const r = await tools.browserSnapshot({});
    check("老调用方(无 projectPath)沿用全局活动指针 → 仍是 a1(行为不改坏)",
      stub.lastCall("snapshot")?.args[0] === "a1", stub.lastCall("snapshot")?.args);
    const list = toolText(tools.browserList());
    check("老调用方的 browser_list(无 projectPath)仍列出全部视图(兼容旧行为)",
      list.includes("a1") && list.includes("b1"), list.slice(0, 200));
  }
}

/* ──────────────── 5b. 项目根的不同拼写必须认作同一个项目(路径身份规范化) ────────────────
 *
 * MC-043 让每个 browser 工具按 `projectPath` 隔离,但比较用的是**裸 `===`**。
 * `ProjectRepo` 存的是用户登记时的**原样拼写**,而浏览器视图创建时经 `ipc/browser.ts` 的
 * `resolve()`、会话调用时经 provider 的 `req.cwd` / 闭包 `projectPath` 各落成一种拼写
 * —— 同一个目录可以给出不同形态(Windows 上大小写任意、`\` 与 `/` 混用、尾部斜杠有无)。
 * 裸 `===` 会把「本项目自己的视图」当成「别的项目」:browser_list 误报「本项目没有打开的
 * 浏览器视图」,无 browserId 的 snapshot/click 落到 no-live-browser。这正是 **MC-042** 已在
 * 终端层用 `normPathKey` 收口过的**同一类**错(MC-040 写锁键、MC-070 项目指令注入同口径)。
 *
 * 判据立在「换个等价拼写,仍应认作本项目」上 —— 走**真工具函数** + 假视图清单(同一套
 * `--alias:@main/browser/BrowserManager.js` 桩 §5 已在用),而不是复述。
 */

console.log("\n路径身份:browser 工具的项目根比较按规范化键,不按裸字符串");

{
  const tools = await import("@main/browser/agentBrowserTools.js");
  const { resolveBrowserTarget } = await import("@main/browser/agentTargeting.js");
  const toolText = (r: ToolResult): string => toolTextOf(r);
  const SENT = "SENTINEL-本项目正文";
  // 视图存的是 ProjectRepo 里那份原样拼写。下面几条断言只比较**同一路径的等价
  // 拼写**（分隔符/尾斜杠/大小写），与 PROJECT 具体指向哪里无关。
  const STORED = PROJECT;
  const sepVariant = STORED.replace(/\\/g, "/");
  const trailVariant = STORED + (STORED.includes("\\") ? "\\" : "/");
  const caseVariant = STORED.replace(/[a-z]/gi, (c) =>
    c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
  );

  // ── 纯判定层:等价拼写必须解析到同一视图 ──
  {
    const views = [{ browserId: "p1", projectPath: STORED }];
    if (sepVariant !== STORED) {
      eq(
        "★ resolveBrowserTarget:分隔符漂移(\\ vs /)仍解析到本项目视图",
        resolveBrowserTarget(views, { projectPath: sepVariant }),
        { ok: true, browserId: "p1" },
      );
    }
    eq(
      "★ resolveBrowserTarget:尾部分隔符漂移仍解析到本项目视图",
      resolveBrowserTarget(views, { projectPath: trailVariant }),
      { ok: true, browserId: "p1" },
    );
    if (process.platform === "win32" || process.platform === "darwin") {
      eq(
        "★ resolveBrowserTarget:大小写漂移仍解析到本项目视图",
        resolveBrowserTarget(views, { projectPath: caseVariant }),
        { ok: true, browserId: "p1" },
      );
    }
    // 反向:真正不同的项目仍不得被认作同一个(规范化不能把一切合并)。
    eq(
      "对照:完全不同的项目根仍解析不到本项目视图(no-live-browser)",
      resolveBrowserTarget(views, { projectPath: "D:\\某个完全不同的仓库\\xyz" }),
      { ok: false, reason: "no-live-browser" },
    );
  }

  // ── 真工具层:换个拼写,list 仍列出本项目视图、无 browserId 的 snapshot 仍落本项目 ──
  stub.setViews([{ browserId: "p1", projectPath: STORED, url: "https://p.example/x", title: "P 页", body: SENT }]);

  {
    stub.resetRecorded();
    const t = toolText(tools.browserList(sepVariant));
    check(
      "★ browser_list:分隔符漂移仍列出本项目视图(不误报『没有打开的浏览器视图』)",
      t.includes("p1"), t.slice(0, 200),
    );
  }
  {
    stub.resetRecorded();
    const r = await tools.browserSnapshot({ projectPath: sepVariant });
    check(
      "★ browser_snapshot:分隔符漂移(无 browserId)仍落到本项目视图,不报 no-live-browser",
      stub.lastCall("snapshot")?.args[0] === "p1",
      stub.lastCall("snapshot")?.args,
    );
    check(
      "★ 漂移拼写的 snapshot 读到的正是本项目正文",
      toolText(r).includes(SENT), toolText(r).slice(0, 200),
    );
  }
  {
    stub.resetRecorded();
    const r = await tools.browserSnapshot({ projectPath: trailVariant });
    check(
      "★ browser_snapshot:尾部分隔符漂移仍落到本项目视图",
      stub.lastCall("snapshot")?.args[0] === "p1",
      stub.lastCall("snapshot")?.args,
    );
  }
  if (process.platform === "win32" || process.platform === "darwin") {
    stub.resetRecorded();
    const r = await tools.browserSnapshot({ projectPath: caseVariant });
    check(
      "★ browser_snapshot:大小写漂移仍落到本项目视图",
      stub.lastCall("snapshot")?.args[0] === "p1",
      stub.lastCall("snapshot")?.args,
    );
  }
}

/* ──────────────── 6. 每个 provider 都把调用者项目身份接进每个浏览器工具 ────────────────
 *
 * §5 验的是**工具函数本身**真的按 projectPath 隔离。但把那条隔离接上,靠的是三个
 * provider 在注册每个 browser_* 工具时**记得把会话的项目身份(`projectPath` / `req.cwd`)
 * 传进去** —— 漏传一个,那个工具就又退回"全局活动指针"的旧路(台账 §19.2 的根因:
 * "一个函数的 scoped 单测绿了,调用点仍可以触发 permissive legacy 路径")。
 *
 * 这条**不跑代码、只在源码上扫**:每个 provider 的每次 `browserXxx(` 调用都必须带上
 * `projectPath`(Claude/Pi,来自闭包)或 `req.cwd`(Codex)。`browserNavigate` /
 * `browserUploadFile` 的位置参数版早已传了,不在扫描范围(它们第二参就是 projectPath)。
 * 换写法(动态拼参数)会让扫描器扫不到而以红的形式告诉你 —— 那正是要的。
 */

console.log("\nMC-043:三个 provider 都把自己的项目身份接进每个浏览器工具");

{
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  // 有位置参数 projectPath 的两个(早已接好),不计入本扫描。
  const POSITIONAL = new Set(["browserNavigate", "browserUploadFile"]);
  // 要扫的工具函数名(排除 browserToolsUsagePrompt 之类的非工具 helper)。
  // `browserDownloads` **不在内**:它列的是全局下载历史(`BrowserManager.listDownloads()`),
  // 与某个浏览器视图/项目无关,本就不该带 projectPath(要按项目隔离得改 BrowserManager,
  // 不在 MC-043 的范围)。
  const TOOL_FNS = new Set([
    "browserList", "browserSnapshot", "browserClick", "browserType", "browserKeys",
    "browserScroll", "browserWait", "browserHistory", "browserSelect", "browserFind",
    "browserSwitchTab", "browserCloseTab", "browserSavePdf", "browserEvaluate",
    "browserScreenshot",
  ]);
  // 一个调用片段里必须出现的"项目身份"记号:Claude/Pi 用闭包 `projectPath`,Codex 用 `req.cwd`。
  const IDENTITY_RE = /projectPath|req\.cwd/;

  const providers: Array<[string, string]> = [
    ["Claude", "src/main/providers/claude-sdk/ClaudeAgentSdkProvider.ts"],
    ["Codex", "src/main/providers/codex-sdk/CodexAgentSdkProvider.ts"],
    ["Pi", "src/main/providers/pi-sdk/mcodeExtension.ts"],
  ];

  for (const [name, rel] of providers) {
    // ⚠️ Claude / Pi / Codex 的浏览器注册已各自拆出 —— 扫**两文件拼接**。
    const extra = rel.endsWith("claude-sdk/ClaudeAgentSdkProvider.ts")
      ? "\n" + readFileSync(join(process.cwd(), "src/main/providers/claude-sdk/ClaudeBrowserMcpServer.ts"), "utf8")
      : rel.endsWith("codex-sdk/CodexAgentSdkProvider.ts")
        ? "\n" + readFileSync(join(process.cwd(), "src/main/providers/codex-sdk/CodexDynamicTools.ts"), "utf8")
        : rel.endsWith("mcodeExtension.ts")
          ? "\n" + readFileSync(join(process.cwd(), "src/main/providers/pi-sdk/mcodeExtensionBrowser.ts"), "utf8")
          : "";
    const src = readFileSync(join(process.cwd(), rel), "utf8") + extra;
    const misses: string[] = [];
    // 扫每次 `browserXxx(` 调用,取其**配平到参数表结束**的那段文本(含嵌套对象/数组),
    // 在这段里找项目身份记号。用括号配平而不是"抓一行",因为多参调用跨行。
    const callRe = /(browser[A-Z]\w*)\(/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src)) !== null) {
      const fn = m[1]!;
      if (POSITIONAL.has(fn) || !TOOL_FNS.has(fn)) continue;
      const open = m.index + m[0].length - 1; // 该 `(` 的下标
      let depth = 0;
      let end = -1;
      for (let j = open; j < src.length; j += 1) {
        if (src[j] === "(") depth += 1;
        else if (src[j] === ")") {
          depth -= 1;
          if (depth === 0) { end = j; break; }
        }
      }
      if (end < 0) continue;
      const seg = src.slice(open, end + 1);
      if (!IDENTITY_RE.test(seg)) misses.push(`${fn}${seg.slice(0, 90)}`);
    }
    // 防断言空过:至少扫到过一堆 browser 调用(否则 callRe 没匹配上,misses 恒空)。
    const scanned = [...src.matchAll(/browser[A-Z]\w*\(/g)].length;
    check(`对照:${name} 扫到浏览器工具调用(防空过)`, scanned >= 14, scanned);
    check(
      `★ ${name}:每个浏览器工具调用都带上调用者项目身份(projectPath / req.cwd)`,
      misses.length === 0,
      misses,
    );
  }
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\nbrowser-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
