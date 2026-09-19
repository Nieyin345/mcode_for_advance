/**
 * Headless smoke for **`main/updater.ts`** —— 自动更新那一个模块(370 行,零覆盖)。
 *
 * ## 为什么单开一套
 *
 * 它在 `smokes-for.sh --uncovered` 名单上,而它管的是**用户对"我是不是最新版"
 * 的信任**:
 *
 *  - 「检查更新」点下去,面板那句结论对不对("已是最新版本" / "发现新版本" / "失败"),
 *    尤其是**失败时那行字**;
 *  - 那几个状态之间怎么流转,`update.state` 落盘的那条快照在什么时刻被清掉
 *    (清了的话重新打开面板能恢复,没清的话用户永远看着一条僵尸进度条);
 *  - 下载失败有没有把失败**抛回发起方**(不抛的话面板停在 0% 的死进度条上)。
 *
 * ## 走的是**真的那个模块**,不是复述
 *
 * 不换 `@main/updater.js`(那由 `updater-tools-smoke` 做,它验的是 IPC 那一层)。
 * 本套把**网络那一层**换掉:`electron-updater` 的 `autoUpdater` 换成
 * `stubs/electron-updater/` 里那个记账的 EventEmitter(真那个在无头 node 里
 * `require` 出来就抛,见那个桩的头注)。于是本套能精确喂进
 * `update-available` / `download-progress` / `update-downloaded` / `error`,
 * 再断言这个模块的反应。
 *
 * ⚠️ **`--alias:` 只认包名**,而这里那条 import 是**运行期**的
 * `requireFromHere("electron-updater")` —— alias 根本管不到它。所以桩是**真的躺在
 * bundle 旁边的 `node_modules/electron-updater/` 里**(见 run.sh)。同
 * `terminal-smoke` 换 node-pty 的办法。
 *
 * ## 这一趟验什么(另外两趟见各自文件头)
 *
 *  - **main.ts**(本文件):Windows/非 darwin 那条路 + 整个状态机 + 落盘。
 *  - **darwin.ts**:macOS 的签名判断(缓存是模块级的,一个进程只能定一次 —— 所以
 *    它单开一趟,由 `run.sh` 跑两遍、摆不同的 codesign 输出)。
 *  - **noDb.ts**:库写不进去时更新流程不许炸(`initDb` 是记忆化的,进程里关不掉,
 *    所以那件事也只能单开一趟)。
 *
 * ## 它不碰用户真正的库
 *
 * `MCODE_SMOKE_DATA_ROOT` 指到 `mktemp -d`(共用桩**没设就抛**)。本套真的建库:
 * `update.state` 的落盘/清除正是要验的东西之一,而 sql.js 的 persist 是**重写整个
 * `mcode.db`** —— 指错地方就是拿空库盖掉用户的聊天记录。
 *
 * Run: scripts/updater-smoke/run.sh
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckForUpdatesResult, PersistedUpdateState } from "@contracts/ipc";

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

/** 带标题的小节。 */
function section(title: string): void {
  console.log(`\n${"─".repeat(70)}\n${title}\n${"─".repeat(70)}`);
}

/* ──────────────── 0. 数据根先钉死,再 import 被测模块 ──────────────── */

const DATA = mkdtempSync(join(tmpdir(), "mcode-updater-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const { IPC, UPDATE_STATE_SETTING_KEY } = await import("@contracts/ipc");
const updater = await import("@main/updater.js");
const { initDb } = await import("@main/store/db.js");
const { SettingRepo } = await import("@main/store/repositories.js");

/** 那个记账的桩 —— 脚本这边 `require` 到**同一个**模块实例(CJS 按解析后的文件名
 *  缓存),于是 `fire()` 派发的事件一定落到被测模块挂的监听器上。 */
const { createRequire } = await import("node:module");
const requireFromHere = createRequire(import.meta.url);
const fake = requireFromHere("electron-updater").autoUpdater as FakeUpdater;

interface FakeUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  nextCheck: Record<string, unknown>;
  nextDownload: Record<string, unknown>;
  calls: string[];
  quitAndInstallArgs: unknown[] | null;
  listenerCount(event: string): number;
  fire(event: string, payload?: unknown): void;
  resetCalls(): void;
}

/** `window` 的桩:每一条推送都记下来 —— 断言直接读它。 */
const windowStub = (await import("@main/window.js")) as unknown as {
  sent: Array<{ channel: string; args: unknown[] }>;
  resetSent(): void;
  sentOf(channel: string): Array<Record<string, unknown>>;
};

/** `node:child_process` 的桩 —— 这一趟(win32)里它**一次都不该被调到**。 */
const childStub = (await import("node:child_process")) as unknown as {
  calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }>;
};

await initDb();

const APP_VERSION = "9.9.9-smoke";
/** 读回落盘的那条快照。`null` = 没落 / 已清。 */
const persisted = (): PersistedUpdateState | null => updater.getPersistedUpdateState();

/* ──────────────── 1. dev:每条入口都是空转 ──────────────── */

section("§1 dev 下每条入口都是空转(不落盘、不推、不去网络)");

// ⚠️ 这一段必须在 boot 之前跑 —— `initialized` 一置真就回不去了(模块私有,没有 reset)。
//    这段用的正是"还没 boot 过"的那个窗口。
{
  // `ELECTRON_RENDERER_URL` 有值 = dev(`lib/utils.ts` 的 `is.dev` 就是这么判的)。
  process.env["ELECTRON_RENDERER_URL"] = "http://localhost:5173";
  windowStub.resetSent();

  const res = (await updater.checkForUpdates()) as CheckForUpdatesResult;
  eq("dev 下检查更新报「已是最新版本」", res.status, "up-to-date");
  eq("而那个版本号是 app.getVersion()", (res as { version: string }).version, APP_VERSION);

  await updater.downloadUpdate();
  await updater.quitAndInstall();
  check("dev 下什么都没去调 autoUpdater", fake.calls.length === 0, { calls: fake.calls });
  eq("dev 下什么都没推给界面", windowStub.sent.length, 0);
  eq("dev 下什么都没落盘", SettingRepo.get(UPDATE_STATE_SETTING_KEY), null);
}

/* ──────────────── 2. prod 但更新器没起来:不许说「已是最新」 ──────────────── */

section("§2 prod 但更新器没起来:不许再说「已是最新版本」");

// ★ 这是本轮修掉的第一条。原来那句是 `if (!is.prod || !initialized)`,把"dev 下没有
// 更新器"和"prod 更新器起不来"合成了同一个答案 ——「已是最新版本 vX」。后者是在**骗
// 用户**:一个字节都没问过网络,他却以为自己在最新版(文件头那段注释警告过这个形状)。
{
  delete process.env["ELECTRON_RENDERER_URL"]; // prod
  // 这一趟里 `initUpdater()` 还没跑过,`initialized` 是假 —— 正是那个现场。
  const res = (await updater.checkForUpdates()) as CheckForUpdatesResult;
  eq("★ 没初始化时不再谎称「已是最新版本」", res.status, "error");
  check(
    "★ 而是给出了一句能看懂的失败原因",
    typeof (res as { error?: string }).error === "string" &&
      (res as { error: string }).error.length > 0,
    res,
  );
  eq("★ 那句话是单行的(没把内部形状漏出去)", /[\r\n]/.test((res as { error?: string }).error ?? ""), false);
}

/* ──────────────── 3. 起来:prod + initialized ──────────────── */

section("§3 起更新器:装配那几个开关,并把三条监听挂上");

{
  await updater.initUpdater();
  check(
    "autoDownload 被关掉(等用户从面板点「下载」)",
    fake.autoDownload === false,
    { autoDownload: fake.autoDownload },
  );
  eq("autoInstallOnAppQuit 被打开(退出时装已下载的那个)", fake.autoInstallOnAppQuit, true);
  eq(
    "五个事件都有监听器(available / not-available / downloaded / error / progress)",
    ["update-available", "update-not-available", "update-downloaded", "error", "download-progress"].filter(
      (e) => fake.listenerCount(e) > 0,
    ).length,
    5,
  );
}

/* ──────────────── 4. 发现新版本 ──────────────── */

section("§4 发现新版本:推给界面的那几个字段 + 结论");

{
  windowStub.resetSent();
  fake.nextCheck = { ok: true, availableVersion: "1.2.3", infoVersion: "1.2.3" };

  const res = (await updater.checkForUpdates("manual")) as CheckForUpdatesResult;
  eq("报成 available", res.status, "available");
  eq("版本号是发现的那个", (res as { version: string }).version, "1.2.3");
  eq("这一趟不是 macOS,manualInstallRequired 是 false", (res as { manualInstallRequired: boolean }).manualInstallRequired, false);

  const pushes = windowStub.sentOf(IPC.UPDATE_AVAILABLE);
  eq("推了一条 update:available", pushes.length, 1);
  eq("推送的 version 是发现的那个", pushes[0]?.["version"], "1.2.3");
  eq("推送的 channel 字段和渠道一致", pushes[0]?.["channel"], IPC.UPDATE_AVAILABLE);
  eq("用户点的那次检查标成 manual", pushes[0]?.["source"], "manual");

  // 后台那一条要标 auto —— 角落那张卡只对 auto 弹出(见 UpdateNotification.tsx)。
  windowStub.resetSent();
  await updater.checkForUpdates("auto");
  eq("后台检查推的 source 标成 auto", windowStub.sentOf(IPC.UPDATE_AVAILABLE)[0]?.["source"], "auto");

  // 发现新版本**不该**动那条落盘的快照(它只管下载/下载完两态)。
  eq("发现新版本时没往库里写东西", SettingRepo.get(UPDATE_STATE_SETTING_KEY), null);
}

/* ──────────────── 5. 已是最新:清掉僵尸快照 ──────────────── */

section("§5 已是最新版本:顺手清掉那条陈旧的下载快照");

{
  // 先手工摆一条"上一轮留下的正在下载",模拟重启后库里还挂着的东西。
  SettingRepo.set(
    UPDATE_STATE_SETTING_KEY,
    JSON.stringify({
      status: "downloading",
      version: "0.0.1-old",
      percent: 3,
      transferred: 30,
      total: 1000,
      updatedAt: new Date().toISOString(),
    }),
  );
  eq("前提:那条陈旧快照读得回来", persisted()?.version, "0.0.1-old");

  fake.nextCheck = { ok: true, infoVersion: "1.0.0" }; // 没有 update-available
  windowStub.resetSent();
  const res = (await updater.checkForUpdates("manual")) as CheckForUpdatesResult;
  eq("没有新版本时报 up-to-date", res.status, "up-to-date");
  eq("版本号取的是 updateInfo 里那个", (res as { version: string }).version, "1.0.0");
  eq("★ 那条陈旧快照被清掉了(否则面板永远挂着一条僵尸进度条)", persisted(), null);
  eq("清快照没有推任何东西给界面", windowStub.sent.length, 0);

  // update-not-available 那条事件单独喂一次也要清 —— 后台检查走的就是它。
  SettingRepo.set(
    UPDATE_STATE_SETTING_KEY,
    JSON.stringify({ status: "downloading", version: "0.0.2", percent: 1, transferred: 1, total: 100, updatedAt: "x" }),
  );
  fake.fire("update-not-available", { version: APP_VERSION });
  eq("update-not-available 事件也会清掉快照", persisted(), null);

  // 连版本号都没有时退回 app.getVersion()。
  fake.nextCheck = { ok: true };
  const res2 = (await updater.checkForUpdates("manual")) as CheckForUpdatesResult;
  eq("连 updateInfo 都没有时退回 app.getVersion()", (res2 as { version: string }).version, APP_VERSION);
}

/* ──────────────── 6. 检查失败:那行字要给用户看 ──────────────── */

section("§6 检查失败:交给用户的那句话必须是给人看的(不是一整段原始响应)");

// ★ 这是本轮修掉的第二条。`electron-updater` / `builder-util-runtime` 的
// `HttpError.message` 是**多行**的(实测):状态码 + 请求描述 + 原始响应体 + headers。
// 它被渲染端**原样**填进 About 面板那句「更新检查失败:{message}」——
// 用户为一次网络不通看到的是十几行原始响应和一串 headers。
{
  windowStub.resetSent();
  const httpError = Object.assign(
    new Error(
      [
        "404 Not Found",
        '"method: GET url: https://api.github.com/repos/x/y/releases\\n\\nPlease double check that your authentication token is correct."',
        "Headers: {",
        '  "content-type": "application/json"',
        "}",
      ].join("\n"),
    ),
    { name: "HttpError", statusCode: 404 },
  );
  fake.nextCheck = { ok: false, error: httpError };

  const res = (await updater.checkForUpdates("manual")) as CheckForUpdatesResult;
  eq("失败报成 error", res.status, "error");
  const msg = (res as { error: string }).error;

  eq("★ 交给用户的那句话只有一行", /[\r\n]/.test(msg), false);
  eq("★ 那句话就是「404 Not Found」(不是整段 JSON)", msg, "404 Not Found");
  check("★ 没有把 Headers 漏出去", !msg.includes("Headers"), { msg });
  check("★ 没有把原始响应体漏出去", !msg.includes("content-type"), { msg });
  check("★ 长度是给人看的量级(不超过 200 字)", msg.length <= 200, { len: msg.length, msg });

  // 面板那句是 t("settings.about.checkFailed", { message }) →「更新检查失败:{message}」。
  const userSees = `更新检查失败:${msg}`;
  check("★ 用户在面板上看到的就是一句干净的失败", !userSees.includes("\n"), { userSees });

  // 单行的错误(那些 message 本来就是人写的)要**原样**留着,别被收口改坏。
  fake.nextCheck = { ok: false, error: new Error("net::ERR_INTERNET_DISCONNECTED") };
  const res2 = (await updater.checkForUpdates("manual")) as CheckForUpdatesResult;
  eq("单行的人写的错误原样保留", (res2 as { error: string }).error, "net::ERR_INTERNET_DISCONNECTED");

  // 抛的要不是 Error(比如一个字符串)—— 也得给出一句人话,不许是 "undefined"。
  fake.nextCheck = { ok: false, error: "某个不是 Error 的东西" };
  const res3 = (await updater.checkForUpdates("manual")) as CheckForUpdatesResult;
  eq("抛的不是 Error 时也交回那句话", (res3 as { error: string }).error, "某个不是 Error 的东西");
}

/* ──────────────── 7. 非 macOS 不做签名判断 ──────────────── */

section("§7 非 macOS 上不去问 codesign(Windows 用 NSIS,不验签名链)");

{
  const before = childStub.calls.length;
  windowStub.resetSent();
  fake.nextCheck = { ok: true, availableVersion: "7.0.0", infoVersion: "7.0.0" };
  await updater.checkForUpdates("manual");
  eq("Windows 上发现新版本时没去调 codesign", childStub.calls.length, before);
  eq(
    "而 manualInstallRequired 是 false(没人被赶去手动下载)",
    windowStub.sentOf(IPC.UPDATE_AVAILABLE)[0]?.["manualInstallRequired"],
    false,
  );
}

/* ──────────────── 8. 下载进度 ──────────────── */

section("§8 下载进度:推给界面的字段 + 落盘的快照");

{
  SettingRepo.set(UPDATE_STATE_SETTING_KEY, "");
  fake.nextCheck = { ok: true, availableVersion: "3.1.4", infoVersion: "3.1.4" };
  await updater.checkForUpdates("manual");

  windowStub.resetSent();
  fake.nextDownload = { ok: true };
  await updater.downloadUpdate();
  eq("真的去调了 autoUpdater.downloadUpdate", fake.calls.includes("downloadUpdate"), true);

  // 下载刚开始、还没收到第一块进度 —— 落盘里该已经有一条"正在下载"(那样重开面板
  // 不会掉回 idle)。
  const seeded = persisted();
  check("★ 一开始下载就落了盘(重开面板不会掉回 idle)", seeded !== null, { seeded });
  eq("落盘的状态是 downloading", seeded?.status, "downloading");
  eq("落盘的版本是待下载的那个", seeded?.version, "3.1.4");
  eq("这条种子快照的百分比是 0", seeded?.percent, 0);

  // 喂一块进度
  fake.fire("download-progress", {
    percent: 42.5,
    transferred: 425_000,
    total: 1_000_000,
    bytesPerSecond: 99_000,
  });

  const prog = windowStub.sentOf(IPC.UPDATE_DOWNLOAD_PROGRESS);
  eq("推了一条下载进度", prog.length, 1);
  eq("进度里的 percent 原样透传(没四舍五入)", prog[0]?.["percent"], 42.5);
  eq("带上 transferred", prog[0]?.["transferred"], 425_000);
  eq("带上 total", prog[0]?.["total"], 1_000_000);
  eq("带上 bytesPerSecond", prog[0]?.["bytesPerSecond"], 99_000);
  eq("标了版本号(界面用来写「正在下载 vX」)", prog[0]?.["version"], "3.1.4");
  eq("channel 字段和渠道一致", prog[0]?.["channel"], IPC.UPDATE_DOWNLOAD_PROGRESS);

  const snap = persisted();
  eq("快照跟着刷新到最新百分比", snap?.percent, 42.5);
  eq("快照里的 transferred 也刷新了", snap?.transferred, 425_000);
  eq("快照里的 status 还是 downloading", snap?.status, "downloading");
  eq("快照里的 version 还是那个", snap?.version, "3.1.4");

  // 第二个进度块要覆盖第一个(累加、或者丢掉都是错的)。
  fake.fire("download-progress", {
    percent: 80,
    transferred: 800_000,
    total: 1_000_000,
    bytesPerSecond: 100_000,
  });
  eq("再来一块进度会覆盖前一块", persisted()?.percent, 80);
  eq("推送也累计到两条", windowStub.sentOf(IPC.UPDATE_DOWNLOAD_PROGRESS).length, 2);

  // 进度里缺字段(真实现某些分支会给 0 / undefined)不许炸。
  windowStub.resetSent();
  let threw: unknown = null;
  try {
    fake.fire("download-progress", {});
  } catch (err) {
    threw = err;
  }
  eq("进度载荷全是空的时候不抛", threw, null);
  eq("而 percent 兜成 0", windowStub.sentOf(IPC.UPDATE_DOWNLOAD_PROGRESS)[0]?.["percent"], 0);
  eq("版本号仍然标得出来(取的是正在下载的那个)", windowStub.sentOf(IPC.UPDATE_DOWNLOAD_PROGRESS)[0]?.["version"], "3.1.4");
}

/* ──────────────── 9. 下载完成 ──────────────── */

section("§9 下载完成:推一件事、落一条可恢复的快照");

{
  windowStub.resetSent();
  const before = fake.calls.slice();
  fake.fire("update-downloaded", { version: "3.1.4", releaseNotes: "# 修了什么" });

  const dl = windowStub.sentOf(IPC.UPDATE_DOWNLOADED);
  eq("推了一条 update:downloaded", dl.length, 1);
  eq("版本号是完成下载的那个", dl[0]?.["version"], "3.1.4");
  eq("releaseNotes 原样带过去了", dl[0]?.["releaseNotes"], "# 修了什么");
  eq("channel 字段和渠道一致", dl[0]?.["channel"], IPC.UPDATE_DOWNLOADED);
  eq("非 macOS 上 manualInstallRequired 是 false", dl[0]?.["manualInstallRequired"], false);

  const snap = persisted();
  eq("落盘的状态变成 downloaded", snap?.status, "downloaded");
  eq("落盘的版本是那个", snap?.version, "3.1.4");
  eq("downloaded 快照里的百分比归零(它不是「下到 80% 就绪」)", snap?.percent, 0);
  eq("transferred 也归零", snap?.transferred, 0);
  eq("total 也归零", snap?.total, 0);
  // 非 macOS 上这个字段是 `false`(不是缺省)—— 界面那句 `?? false` 两种都吃,
  // 但落盘的形状本身值得钉一下:它决定重启后横幅给「重启安装」还是「前往下载」。
  eq("downloaded 快照里 manualInstallRequired 是 false(非 ad-hoc)", snap?.manualInstallRequired, false);

  const round = updater.getPersistedUpdateState();
  eq("读回来的 status 还是 downloaded", round?.status, "downloaded");
  check(
    "读回来的快照字段齐(含 updatedAt)",
    round !== null && typeof round.updatedAt === "string" && round.updatedAt.length > 0,
    round,
  );

  check(
    "下载完成这次没去调 autoUpdater(它只是收事件)",
    JSON.stringify(fake.calls) === JSON.stringify(before),
    { before, after: fake.calls },
  );
}

/* ──────────────── 10. 下载失败 ──────────────── */

section("§10 下载失败:清掉快照,而且要把失败抛回给发起方");

{
  // 把上一条测试留下的「已下载」快照清掉,好在下面验"下载失败会把它清掉"这件事。
  SettingRepo.set(UPDATE_STATE_SETTING_KEY, "");
  fake.nextCheck = { ok: true, availableVersion: "4.0.0", infoVersion: "4.0.0" };
  await updater.checkForUpdates("manual");
  eq("前提:发现新版本本身不落盘(快照还是空的)", persisted(), null);

  fake.nextDownload = { ok: true };
  await updater.downloadUpdate();
  eq("前提:下载起来之后有一条 downloading 快照", persisted()?.status, "downloading");

  fake.nextDownload = { ok: false, error: new Error("net::ERR_CONNECTION_RESET") };

  let threw: unknown = null;
  try {
    await updater.downloadUpdate();
  } catch (err) {
    threw = err;
  }
  // 不抛的话 About 面板会一直停在 0% 的进度条上(它那句注释写的就是这件事)。
  check("★ 下载失败会抛(发起方能收回去恢复界面)", threw !== null, { threw: String(threw) });
  eq("抛出去的是那句话本身(单行的)", (threw as Error)?.message, "net::ERR_CONNECTION_RESET");
  check("抛出去的是 Error(渲染端那句 err.message 拿得到)", threw instanceof Error, { threw: String(threw) });
  eq("★ 失败之后那条「正在下载」的快照被清了", persisted(), null);

  // 多行的下载错误同样只留首行。
  fake.nextDownload = {
    ok: false,
    error: new Error("502 Bad Gateway\nHeaders: {\n  \"x-served-by\": \"abc\"\n}"),
  };
  let threw2: unknown = null;
  try {
    await updater.downloadUpdate();
  } catch (err) {
    threw2 = err;
  }
  eq("多行的下载错误也只剩一行", /[\r\n]/.test((threw2 as Error)?.message ?? ""), false);
  check("而且没有把 Headers 漏出去", !((threw2 as Error)?.message ?? "").includes("Headers"));
}

/* ──────────────── 11. 重启安装 ──────────────── */

section("§11 「重启安装」:关掉之前先把快照清了");

{
  fake.nextCheck = { ok: true, availableVersion: "5.0.0", infoVersion: "5.0.0" };
  await updater.checkForUpdates("manual");
  fake.fire("update-downloaded", { version: "5.0.0" });
  eq("前提:这时快照是 downloaded", persisted()?.status, "downloaded");

  fake.resetCalls();
  await updater.quitAndInstall();
  eq("调了 autoUpdater.quitAndInstall", fake.calls.includes("quitAndInstall"), true);
  eq(
    "★ 快照在重启之前就清了(否则新版本启动后还挂着旧横幅)",
    SettingRepo.get(UPDATE_STATE_SETTING_KEY),
    "",
  );
  eq("这时读出来是 null", updater.getPersistedUpdateState(), null);
}

/* ──────────────── 12. 读快照:坏数据不许把面板带崩 ──────────────── */

section("§12 读快照:坏数据读成 null,好数据读得回来");

{
  SettingRepo.set(UPDATE_STATE_SETTING_KEY, "");
  eq("空串读出来是 null(已经清过)", updater.getPersistedUpdateState(), null);

  SettingRepo.set(UPDATE_STATE_SETTING_KEY, "这不是 json{{{");
  eq("坏 JSON 读出来是 null(不抛)", updater.getPersistedUpdateState(), null);

  SettingRepo.set(
    UPDATE_STATE_SETTING_KEY,
    JSON.stringify({ status: "checking", version: "1.0.0", percent: 0, transferred: 0, total: 0 }),
  );
  eq("status 不认识时读出来是 null(不原样交给面板)", updater.getPersistedUpdateState(), null);

  SettingRepo.set(UPDATE_STATE_SETTING_KEY, JSON.stringify({ version: "1.0.0" }));
  eq("连 status 都没有时也是 null", updater.getPersistedUpdateState(), null);

  // ★ 对照组 —— 没有它,上面那四条"读出来是 null"可能只是因为函数永远返回 null。
  SettingRepo.set(
    UPDATE_STATE_SETTING_KEY,
    JSON.stringify({
      status: "downloading",
      version: "1.0.0",
      percent: 5,
      transferred: 50,
      total: 1000,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  const ok = updater.getPersistedUpdateState();
  eq("★ 对照组:一份正常的 downloading 快照读得回来", ok?.status, "downloading");
  eq("对照组:percent 也读得回来", ok?.percent, 5);

  SettingRepo.set(
    UPDATE_STATE_SETTING_KEY,
    JSON.stringify({
      status: "downloaded",
      version: "2.0.0",
      percent: 0,
      transferred: 0,
      total: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
      manualInstallRequired: true,
    }),
  );
  const done = updater.getPersistedUpdateState();
  eq("对照组:downloaded 也读得回来", done?.status, "downloaded");
  eq("对照组:manualInstallRequired 带得回来(重启后横幅要恢复成「前往下载」)", done?.manualInstallRequired, true);
}

rmSync(DATA, { recursive: true, force: true });

console.log();
console.log(`updater-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
