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

console.log("\n收藏:设置行坏掉时");

// 设置行是**用户可见数据的落点**,可能被手工改坏 / 被老版本写过。读的时候必须兜住 ——
// 判据是"再加一条不会炸、而且落地的是一个干净的数组",不是"库里那段原文被读出来了"。
// (`storedBookmarks()` 返回 null 就是"那段原文不是 JSON 数组",所以下面从这条看结果。)
SettingRepo.set(BROWSER_BOOKMARKS_SETTING_KEY, "{这不是 JSON");
Bookmarks.add("https://after-garbage.test", "坏行之后加的第一条");
eq(
  "设置行是坏 JSON(手工改坏了):再加一条不炸,库里只剩新的那条",
  storedUrls(),
  ["https://after-garbage.test"],
);

SettingRepo.set(BROWSER_BOOKMARKS_SETTING_KEY, '{"a":1}');
Bookmarks.add("https://after-object.test", "非数组之后再加");
eq(
  "设置行是个对象(不是数组):再加一条不炸,库里只剩新的那条",
  storedUrls(),
  ["https://after-object.test"],
);

SettingRepo.set(
  BROWSER_BOOKMARKS_SETTING_KEY,
  JSON.stringify([
    { url: "https://good.test", title: "好的", addedAt: 1 },
    { title: "没有 url 的", addedAt: 2 },
    null,
    { url: 123, title: "url 不是字符串", addedAt: 3 },
  ]),
);
// `read()` 过滤过一道(只留 url 是字符串的),所以好行还在、坏行读不出来。
// 判据立在**读出来的那些**上 —— 这正是渲染端菜单会渲染的那份。
eq(
  "混在里面的坏行读不出来,好行不受影响",
  storedUrls(),
  ["https://good.test"],
);

// 再写一次:坏行在 read() 那一步就没了,所以不会被带回去。
Bookmarks.add("https://another.test", "另一条");
eq(
  "写回去的时候坏行被清掉了,只剩两条好的",
  storedUrls().sort(),
  ["https://another.test", "https://good.test"],
);

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

const PROJECT = "D:\\destop\\work_space\\work_for_reseach\\mcode";
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
    // authRespond 的契约是 Promise<void> —— 它没有地方报错,判据只能是"没打下去"。
    check(`${row.name}: 没有把用户填的凭据交出去`, calls.length === 0, { calls });
  }
}

// 零参通道:preload 那边一个形参都不传,handler 也不收 raw。它们不该因为
// "raw 是 undefined" 就报错 —— 那是它们的正常形状。
console.log("\nIPC:零参通道(raw 就是 undefined)");
for (const [name, channel, fn] of [
  ["clearCache", IPC.BROWSER_CLEAR_CACHE, "clearBrowserCache"],
  ["clearCookies", IPC.BROWSER_CLEAR_COOKIES, "clearBrowserCookies"],
] as const) {
  const { out, calls } = await callAndRecord(channel, undefined);
  eq(`${name}: 不传任何入参也返回 ok`, (out as { ok: boolean }).ok, true);
  eq(`${name}: 走到了 ${fn}`, calls, [fn]);
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
  eq("authRespond: 契约是 Promise<void>,所以没有返回值", out, undefined);
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\nbrowser-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
