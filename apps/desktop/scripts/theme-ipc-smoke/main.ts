/**
 * Headless smoke for **主题那一条链** —— `main/ipc/theme.ts`(20 行)+
 * `main/lib/theme.ts`(138 行,上面那个的全部逻辑都在这儿)+ `main/ipc/app.ts`
 * (About 面板 + 数据根搬家)。三个文件在本套之前**一套覆盖都没有**。
 *
 * ## 为什么值得单独一套
 *
 * 这一层薄,但薄的地方恰恰是最容易"看着对、其实没接上"的地方 —— 一个偏好存进去、
 * 另一个函数读出来,中间任何一处写错都不会 typecheck 报,而且**用户看到的是一句
 * 都没有的错**:
 *
 *  1. **库里存了个不认识的值。** `getThemePreference()` 是"库值 → 界面颜色"的唯一
 *     关口。原样吐出去的话,渲染端拿到一个它不认识的字符串,`.dark` 类不翻转、
 *     `prefers-color-scheme` 也不动 —— 用户看到的是"设置里选的是这个,界面是另一个
 *     样子",没有任何提示。
 *  2. **`initTheme()` 里 `osPrefersDark` 的抓取时机。** 它抓的必须是**改
 *     `themeSource` 之前**的 OS 值(内嵌浏览器把网页的 `prefers-color-scheme` 钉在
 *     这个值上,好让网页跟 OS 一致而不是跟应用主题一致)。抓反了,用户会看到
 *     "我在这个软件里开了深色,浏览器里的网页也跟着黑了" —— 而 OS 上一整套网页浅色。
 *  3. **搬数据根失败之后动了不该动的东西。** 源码注释写的是"失败就原样返回,**什么都
 *     不动**(连接还活着,应用不受影响)"。这半句是要验的:失败路径上一旦调了
 *     `setDataRoot` 或 `closeDb`,应用就带着一个**没搬过去的**新根把自己关了,
 *     用户下次打开一片空白。
 *
 * ## 它怎么做到不碰用户真东西
 *
 *  - **数据根**:`run.sh` 用 `mktemp -d` 建,经 `MCODE_SMOKE_DATA_ROOT` 传进来。
 *    ⚠️ 这个变量是**唯一**的来源 —— `stubs/electron.ts` 的 `app.getPath()` 没看见
 *    它就**抛**,绝不回落到 `%APPDATA%` / 用户主目录。`db.ts` 在不存在的路径上会
 *    **新建一个空库**,而 sql.js 的 `persist()` 是**重写整个 `mcode.db`** ——
 *    指错地方就是拿空库盖掉用户的聊天记录。§0 会先断言落点确实在临时目录里。
 *  - **`@main/lib/dataRoot.js` 用真的**(不换桩):`APP_MOVE_DATA_ROOT` 要验的正是它
 *    的拒绝口径(非空目录 / 相对路径 / 互相嵌套),换桩就变成验桩了。它 import 的
 *    `electron` 已经换掉,所以跑得起来。
 *  - **搬家的目标**一律是 `mkdtemp -d` 出来的临时目录,**绝不拿真路径试**。
 *  - **`nativeTheme`** 是 `stubs/electron.ts` 里那个可读写的假身:能切
 *    `shouldUseDarkColors`、能手动触发 `updated`、`themeSource` 可读写。
 *  - **`@main/window.js`** 换桩并**记下每一条推送** —— §5 直接读它。
 *
 * Run: scripts/theme-ipc-smoke/run.sh
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IpcMain } from "electron";

import { IPC } from "@contracts/ipc";
import { initDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
import { dataRoot } from "@main/lib/dataRoot.js";
import { registerThemeHandlers } from "@main/ipc/theme.js";
import { registerAppHandlers } from "@main/ipc/app.js";
import * as themeLib from "@main/lib/theme.js";

import { APP_VERSION, appCalls, resetAppCalls, resetThemeState, themeState, themeSourceWrites, updatedListenerCount, emitUpdated } from "./stubs/electron.js";
import { broadcasts, overlayCallCount, resetWindowRecords } from "./stubs/window.js";

/* ──────────────── 脚手架 ──────────────── */

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

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 数组/对象比较 —— `Object.is` 对两个内容相同的是 false。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/**
 * `ipcMain` 的**记名替身**。三个被测文件里,判据全住在 handler 的**函数体**里,
 * 而那些 handler 从来不是导出符号 —— 唯一拿得到的办法就是调 `register*Handlers`,
 * 把注册进来的那批函数按 channel 收下来(抄 `library-trash-smoke` / `dialog-shell-smoke`)。
 */
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (...a: unknown[]) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

/** 调一条**真的** handler。这一层所有 handler 都是同步的,返回的就是返回值本身。 */
function call<T = unknown>(channel: string, ...args: unknown[]): T {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`register*Handlers 没有注册 ${channel}`);
  return fn(null, ...args) as T;
}

/** 调一次并拿回错误消息(`""` = 没抛)。"被拒了"和"没炸"是两件事,都要能断言。 */
function catching(channel: string, ...args: unknown[]): string {
  try {
    call(channel, ...args);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

/* ──────────────── §0 安全前提 + 脚手架自己 ──────────────── */

console.log("\n§0 安全前提:脚下的数据根必须是临时目录");

/** 临时目录,**搬家的目标**也从这里出。绝不拿真路径试。 */
const SCRATCH = mkdtempSync(join(tmpdir(), "mcode-theme-scratch-"));

{
  // ① 环境变量在(不在的话 stubs/electron.ts 的 getPath 已经抛过了,轮不到这儿)。
  const fromEnv = process.env.MCODE_SMOKE_DATA_ROOT;
  check("MCODE_SMOKE_DATA_ROOT 设上了", typeof fromEnv === "string" && fromEnv.length > 0, fromEnv);

  // ② **落点确实在临时目录里**。这条比上面那条重要 —— 它是"这套脚本不会毁用户数据"
  //    这个前提本身。真数据根是 `<用户主目录>/Mcode`。
  const root = dataRoot();
  const realHome = join(homedir(), "Mcode");
  check(
    "数据根落在临时目录里(不是用户真数据根)",
    resolve(root).startsWith(resolve(String(fromEnv))) && resolve(root) !== resolve(realHome),
    { root, fromEnv, realHome },
  );
}

// 建库。**必须在调 handler 之前** —— handler 里 `SettingRepo.get/set` 走
// `getDb()`,而它没初始化时会抛。
await initDb();
registerThemeHandlers(fakeIpc);
registerAppHandlers(fakeIpc);

{
  // 通道名写错一个字,下面的断言会拿一个不存在的 IPC 名字一路空跑。
  const needed = [IPC.THEME_GET, IPC.THEME_SET, IPC.APP_INFO, IPC.APP_GET_DATA_ROOT, IPC.APP_MOVE_DATA_ROOT];
  const missing = needed.filter((c) => !handlers.has(c));
  eq("要验的通道全都注册上了", missing.length, 0);
  if (missing.length > 0) console.log(`     缺: ${JSON.stringify(missing)}`);
  eq("通道名不是编的(拿一条已知的跟契约对)", IPC.THEME_SET, "theme:set");
  eq("THEME_CHANGED 也对得上", IPC.THEME_CHANGED, "theme:changed");
}

/* ──────────────── §1 偏好存进去、读出来是同一个 ──────────────── */

console.log("\n§1 偏好存进去、读出来是同一个");

{
  // 三选一各自往返一圈 —— 只验一个值的话,把 dark / light 写反了照样绿。
  for (const pref of ["dark", "light", "system"] as const) {
    const res = call<{ theme: string; effective: string }>(IPC.THEME_SET, { theme: pref });
    eq(`存 ${pref} 之后返回值里的 theme 就是 ${pref}`, res.theme, pref);
    eq(`存 ${pref} 之后 nativeTheme.themeSource 也切成了 ${pref}`, themeState.themeSource, pref);
    eq(`再从库里读一遍还是 ${pref}`, themeLib.getThemePreference(), pref);
    eq(
      `THEME_GET 返回的 theme 还是 ${pref}`,
      call<{ theme: string }>(IPC.THEME_GET).theme,
      pref,
    );
  }

  same(
    "THEME_GET 返回的就是 { theme, effective } 两个字段",
    Object.keys(call<Record<string, unknown>>(IPC.THEME_GET)).sort(),
    ["effective", "theme"],
  );
  same(
    "THEME_SET 返回的也是那两个字段(不是空对象)",
    Object.keys(call<Record<string, unknown>>(IPC.THEME_SET, { theme: "dark" })).sort(),
    ["effective", "theme"],
  );

  // 库里真存了那个字符串(不是只改了内存里的 themeSource)。
  eq("偏好确实落进了 settings 表", SettingRepo.get("theme"), "dark");

  // 三选一的其余值要被挡住 —— 挡住才轮得到 §2 那条回落。
  check("存一个不认识的偏好被 schema 挡住", catching(IPC.THEME_SET, { theme: "blue" }) !== "");
  check("偏爱字段整个缺失也被挡住", catching(IPC.THEME_SET, {}) !== "");
  check("THEME_SET 不带参数 invoke 也被挡住(不是静默写个 undefined 进库)", catching(IPC.THEME_SET) !== "");
}

/* ──────────────── §2 库里存了个不认识的值 ──────────────── */

console.log("\n§2 库里存了个不认识的值 → 回落 system(不是原样吐出去)");

{
  /**
   * ⚠️ 这条是**用户看得见的那行字**类型的。库是可以被外面写坏的(旧版本的键、
   * 手工改过的库、将来某个版本换过枚举值)。`getThemePreference()` 一旦把
   * `"blue"` 原样交出去,渲染端就会拿它去比 `=== "dark"`,两边都不成立 ——
   * `.dark` 类不翻转、`prefers-color-scheme` 也不动。用户看到的是"设置里明明是
   * 自定义的,界面却是另一个样子",而且**一句报错都没有**。
   */
  SettingRepo.set("theme", "blue");
  eq("库里是 blue 时读出来回落成 system", themeLib.getThemePreference(), "system");
  eq("THEME_GET 也不能把 blue 吐给渲染端", call<{ theme: string }>(IPC.THEME_GET).theme, "system");

  SettingRepo.set("theme", "");
  eq("库里是空串时也回落成 system", themeLib.getThemePreference(), "system");

  SettingRepo.set("theme", "DARK");
  eq("大小写不同不算(dark 只认小写,别把 DARK 当 dark)", themeLib.getThemePreference(), "system");

  SettingRepo.set("theme", "dark ");
  eq("多一个空格也不算", themeLib.getThemePreference(), "system");

  // 库是空的时候(键从来没写过)也只能是 system,不能是 undefined ——
  // 渲染端拿到 undefined 会让 `<Select value>` 变成"没有选中任何一项"。
  SettingRepo.set("theme", "");
  eq("键在但值空 → system(不是 null / undefined)", themeLib.getThemePreference(), "system");

  // 回落之后**不许把回落值写回库** —— 那样用户哪天把库改回来就发现值被覆写了。
  SettingRepo.set("theme", "blue");
  themeLib.getThemePreference();
  eq("读一次不会把回落值写回库(库还是 blue)", SettingRepo.get("theme"), "blue");
}

/* ──────────────── §3 effective 跟着 nativeTheme 走 ──────────────── */

console.log("\n§3 effective 是「实际在渲染的那个」,跟着 nativeTheme 走");

{
  // `system` 模式:OS 说了算。
  themeState.themeSource = "system";
  themeState.osDark = true;
  eq("OS 是深色时 effective = dark", themeLib.getEffectiveTheme(), "dark");
  eq("THEME_GET 的 effective 也跟着变", call<{ effective: string }>(IPC.THEME_GET).effective, "dark");

  themeState.osDark = false;
  eq("OS 是浅色时 effective = light", themeLib.getEffectiveTheme(), "light");

  // 显式模式:OS 说什么都不算。
  const dark = call<{ theme: string; effective: string }>(IPC.THEME_SET, { theme: "dark" });
  eq("选了 dark 之后 effective = dark(哪怕 OS 是浅色)", dark.effective, "dark");
  eq("theme 记的是用户选的 dark(不是解析后的值)", dark.theme, "dark");

  const light = call<{ theme: string; effective: string }>(IPC.THEME_SET, { theme: "light" });
  eq("选了 light 之后 effective = light(哪怕 OS 是深色)", light.effective, "light");

  themeState.osDark = true;
  eq("OS 翻回深色,显式的 light 不受影响", themeLib.getEffectiveTheme(), "light");
}

/* ──────────────── §4 initTheme 的幂等与 osPrefersDark 的抓取时机 ──────────────── */

console.log("\n§4 initTheme:抓 OS 值的时机、跑两次只初始化一次");

{
  /**
   * ⚠️ **这一段是这一套最该守住的一条。**
   *
   * `osPrefersDark` 抓的必须是**改 `themeSource` 之前**那个值 —— 那时
   * `themeSource` 还是默认的 `"system"`,所以 `shouldUseDarkColors` 报的就是**OS 的**
   * 真实偏好。抓完之后 `initTheme` 才把 `themeSource` 改成用户选的偏好。
   *
   * 顺序写反了,抓到的就成了"用户选的那个主题":
   *
   *   | | 正确 | 抓反了 |
   *   |---|---|---|
   *   | OS 深色 + 用户选浅色 | `osPrefersDark = true` | `= false` |
   *   | 用户看到 | 应用是浅色,浏览器里的网页还是深色(跟 OS 一致)| 应用浅色,网页也变浅色 |
   *
   * 后者正是这条注释要避免的那件事:"网页跟着应用主题走而不是跟着 OS 走"。
   *
   * 这条断言**能红**,靠的是 `stubs/electron.ts` 里那个假 nativeTheme **照 Electron 的
   * 真实模型算** `shouldUseDarkColors`(`themeSource === "dark"` → true /
   * `"light"` → false / `"system"` → 看 OS)。如果它是个跟 `themeSource` 无关的常量,
   * 抓早了抓晚了读到的都是同一个数 —— 那样这条断言就是一条**空过的断言**。
   */
  resetThemeState();
  themeState.osDark = true; // OS 是深色
  themeState.themeSource = "system";
  SettingRepo.set("theme", "light"); // 而用户选的是**浅色**
  resetThemeState(); // 上面两句 setup 也记进了 themeSourceWrites,清掉
  themeState.osDark = true;
  themeState.themeSource = "system";
  resetWindowRecords();

  const listenersBefore = updatedListenerCount();
  await themeLib.initTheme();

  eq("初始化之后 themeSource 是用户选的 light", themeState.themeSource, "light");
  eq("★ osPrefersDark 抓的是 OS 的深色,不是用户选的 light", themeLib.getOsPrefersDark(), true);
  eq(
    "★ 而且它是在改 themeSource 之前抓的(只写了一次 themeSource,写的是 light)",
    themeSourceWrites.join(","),
    "light",
  );
  check(
    "initTheme 顺手把标题栏覆盖色同步了一次",
    overlayCallCount() >= 1,
    { calls: overlayCallCount() },
  );
  eq(
    "initTheme 装上了恰好一个 updated 监听器",
    updatedListenerCount() - listenersBefore,
    1,
  );

  // ── 再调一次:整个空转 ──
  const overlayBefore = overlayCallCount();
  const writesBefore = themeSourceWrites.length;
  const listenersNow = updatedListenerCount();
  themeState.osDark = false; // 就算 OS 这时候翻了…
  themeState.themeSource = "system"; // (setup 又记了一次写,下面数的是增量)
  const writesAfterSetup = themeSourceWrites.length;
  await themeLib.initTheme();

  eq(
    "initTheme 第二次调用不再覆盖 themeSource",
    themeState.themeSource,
    "system", // 保留 setup 设的值 —— 第二次调用一个字都没写
  );
  eq(
    "第二次调用一次 themeSource 都没写",
    themeSourceWrites.length,
    writesAfterSetup,
  );
  eq(
    "第二次调用也不会把 osPrefersDark 重抓成 false",
    themeLib.getOsPrefersDark(),
    true,
  );
  eq("第二次调用整个是空转(没有多余的标题栏同步)", overlayCallCount(), overlayBefore);
  eq("第二次调用没有再装一个监听器", updatedListenerCount(), listenersNow);
  // initTheme 装的那个监听器是**活的**(不只是被数了一下):按一下 `updated`
  // 就该有一条广播出来。`initTheme` 的返回值是 void,拿不到别的凭据。
  emitUpdated();
  eq("initTheme 装上的监听器真的会广播(不是装了个哑的)", broadcasts.length, 1);
}

/* ──────────────── §5 OS 主题变了 → 推给界面 ──────────────── */

console.log("\n§5 OS 主题变了 → 广播 theme:changed(载荷形状要对)");

{
  // 回到 system 模式:这时 OS 真的说了算,`updated` 才有意义。
  SettingRepo.set("theme", "system");
  themeState.themeSource = "system";
  themeState.osDark = true;
  resetWindowRecords();

  emitUpdated();

  eq("OS 主题变化触发了恰好一次广播", broadcasts.length, 1);
  const b = broadcasts[0];
  eq("广播的渠道是 theme:changed", b?.channel, IPC.THEME_CHANGED);
  // 载荷里的判别字段是**字面量**的一部分(契约里写死 `channel: "theme:changed"`),
  // 不是拿通道常量算出来的。所以它必须逐字等于合同里那串,而不是"等于 IPC.THEME_CHANGED"
  // —— 后者在常量本身被改掉时会一起骗过去。这条钉的是预加载那一侧真正拿去比的东西。
  eq("载荷里的 channel 判别字段逐字等于 theme:changed", b?.payload.channel, "theme:changed");
  eq("渠道本身也逐字等于 theme:changed", b?.channel, "theme:changed");
  eq("载荷里带上了用户的偏好(system)", b?.payload.theme, "system");
  eq("载荷里带上了解析后的 effective(dark)", b?.payload.effective, "dark");
  same(
    "载荷恰好是那三个字段,没有多带内部东西",
    Object.keys(b?.payload ?? {}).sort(),
    ["channel", "effective", "theme"],
  );

  // OS 翻面 → 载荷里的 effective 要跟着翻(否则界面上的"当前:深色"是死的)。
  themeState.osDark = false;
  emitUpdated();
  eq("OS 翻成浅色后又推了一次", broadcasts.length, 2);
  eq("第二次载荷的 effective 是 light", broadcasts[1]?.payload.effective, "light");
  eq("第二次载荷的 theme 还是 system", broadcasts[1]?.payload.theme, "system");

  // 显式模式下 OS 翻面照样会推(注释写了"cheap to re-broadcast"),但 effective
  // 必须还是用户选的那个 —— 不能因为 OS 翻了就把界面颜色改掉。
  SettingRepo.set("theme", "dark");
  themeState.themeSource = "dark";
  emits: {
    resetWindowRecords();
    emitUpdated();
    eq("显式 dark 时 OS 翻面照样推一条", broadcasts.length, 1);
    eq("但 effective 还是 dark(没被 OS 带跑)", broadcasts[0]?.payload.effective, "dark");
    eq("theme 是用户的偏好 dark", broadcasts[0]?.payload.theme, "dark");
  }

  check("每次 updated 都会顺手同步标题栏", overlayCallCount() >= 1, { calls: overlayCallCount() });
}

/* ──────────────── §6 无参 invoke 不许抛 ──────────────── */

console.log("\n§6 无参 invoke 不许抛(本仓库出过这一类)");

{
  /**
   * 不带参数 invoke 时 handler 收到的是 `undefined`。本仓库真出过一个
   * 「`z.object({})` 不接受 `undefined`,面板一打开就报 invalid_type」——
   * 面板一打开就红,而且报的是让人看不懂的 zod JSON。
   */
  for (const ch of [IPC.THEME_GET, IPC.APP_INFO, IPC.APP_GET_DATA_ROOT] as const) {
    eq(`${ch} 不带参数 invoke 不抛`, catching(ch), "");
  }
  // 多给一个没人要的参数也不该抛(渲染端某些封装会顺手塞 event 之类的)。
  eq("THEME_GET 多给一个参数也不抛", catching(IPC.THEME_GET, { junk: 1 }), "");
}

/* ──────────────── §7 APP_INFO 的形状 ──────────────── */

console.log("\n§7 APP_INFO:About 面板那六行");

{
  const info = call<Record<string, unknown>>(IPC.APP_INFO);
  eq("appVersion 来自 app.getVersion()", info.appVersion, APP_VERSION);
  eq("platform 来自 process.platform", info.platform, process.platform);
  eq("arch 来自 process.arch", info.arch, process.arch);
  eq("node 来自 process.versions.node", info.node, process.versions.node);
  check(
    "electron / chromium 是字符串或那个占位问号(不可能是 undefined)",
    (typeof info.electron === "string" && info.electron.length > 0) &&
      (typeof info.chromium === "string" && info.chromium.length > 0),
    { electron: info.electron, chromium: info.chromium },
  );
  same(
    "六个字段一个不多一个不少",
    Object.keys(info).sort(),
    ["appVersion", "arch", "chromium", "electron", "node", "platform"],
  );
  // About 面板写的是 `v${info.appVersion}` —— appVersion 是 undefined 的话界面上
  // 那行字会变成 "vundefined",而 typecheck 报不出来(它是运行时来的字符串)。
  check("appVersion 是个真字符串(不是 undefined)", typeof info.appVersion === "string" && info.appVersion.length > 0, info.appVersion);
}

/* ──────────────── §7b APP_GET_DATA_ROOT:设置页那棵目录树 ──────────────── */

console.log("\n§7b APP_GET_DATA_ROOT:四个路径,以及它们和 mcode.db 是不是一家");

{
  /**
   * 设置页那棵目录树直接把四个路径念给用户听。这里有一个**很容易写错、而写错了
   * 用户也只是"找不到文件"**的点:`dbPath` 用的是 `dataRoot()` + 文件名,而
   * `db.ts` 里真正打开的路径走的是 `dataRoot.dbPath()`(它多一条「老库还在
   * userData 就用老库」的安全网)。两者在正常情形下必须一致 —— 不一致时用户照着
   * 设置页去找,会发现那儿根本没有 `mcode.db`。
   */
  const root = call<{ root: string; dbPath: string; libraryPath: string; templatesPath: string }>(
    IPC.APP_GET_DATA_ROOT,
  );
  same(
    "返回的就是那四个路径",
    Object.keys(root).sort(),
    ["dbPath", "libraryPath", "root", "templatesPath"],
  );
  for (const [key, value] of Object.entries(root)) {
    check(`${key} 是个绝对路径(不是空串/undefined)`, typeof value === "string" && resolve(value) === value, { [key]: value });
  }
  eq("dbPath 就是数据根下的 mcode.db", root.dbPath, join(root.root, "mcode.db"));
  eq("libraryPath 就是数据根下的 library", root.libraryPath, join(root.root, "library"));
  eq("templatesPath 就是数据根下的 templates", root.templatesPath, join(root.root, "templates"));
  // 而且它确实**落在**数据根里面(不是别处拼出来的一个同名路径)。
  check("四个路径都在同一个数据根下", [root.dbPath, root.libraryPath, root.templatesPath].every((p) => resolve(p).startsWith(resolve(root.root))), root);
}

/* ──────────────── §8 数据根搬家:失败路径上什么都不许动 ──────────────── */

console.log("\n§8 搬数据根失败:原样返回,一个副作用都不许有");

{
  /**
   * `ipc/app.ts` 的文件头注释写了:"复制整棵树。失败就原样返回,**什么都不动**
   * (连接还活着,应用不受影响)。"
   *
   * "什么都不动"这半句是要验的 —— 失败路径上一旦调了 `setDataRoot`,应用下次就
   * 从新位置起,而那里**什么都没有**;一旦调了 `closeDb`,这一次会话剩下的时间里
   * 所有读库的 IPC 都会抛 `getDb() called before initDb() resolved`。
   */
  const rootBefore = dataRoot();
  resetAppCalls();

  /** 一次失败搬家之后的现场快照。 */
  function snapshot(): { root: string; relaunch: number; exits: number; dbAlive: boolean } {
    let dbAlive = true;
    try {
      SettingRepo.get("theme");
    } catch {
      dbAlive = false;
    }
    return { root: dataRoot(), relaunch: appCalls.relaunch, exits: appCalls.exitCodes.length, dbAlive };
  }

  const before = snapshot();

  /** 断一条"失败搬家什么都没动"。 */
  function assertUntouched(label: string): void {
    const after = snapshot();
    eq(`${label}:数据根没变`, after.root, before.root);
    eq(`${label}:没调 relaunch`, after.relaunch, before.relaunch);
    eq(`${label}:没调 exit`, after.exits, before.exits);
    eq(`${label}:数据库连接还活着(没 closeDb)`, after.dbAlive, true);
  }

  // ① 目标是一个**非空**目录 —— 界面上的提示牌写明的:"选一个空目录或新建一个"。
  const nonEmpty = mkdtempSync(join(SCRATCH, "nonempty-"));
  writeFileSync(join(nonEmpty, "占位.txt"), "x", "utf8");
  const r1 = call<{ ok: boolean; error?: string }>(IPC.APP_MOVE_DATA_ROOT, { path: nonEmpty });
  eq("搬到非空目录 → ok:false", r1.ok, false);
  check(
    "而且给了一句人话(不是空串,也不是一整段堆栈)",
    typeof r1.error === "string" && r1.error.length > 0 && !r1.error.includes("\n    at "),
    r1,
  );
  assertUntouched("搬到非空目录");

  // ② 目标是个**相对路径**。
  const r2 = call<{ ok: boolean; error?: string }>(IPC.APP_MOVE_DATA_ROOT, { path: "相对路径" });
  eq("相对路径 → ok:false", r2.ok, false);
  assertUntouched("搬到相对路径");

  // ③ 目标就是当前位置自己。
  const r3 = call<{ ok: boolean; error?: string }>(IPC.APP_MOVE_DATA_ROOT, { path: rootBefore });
  eq("搬到当前位置自己 → ok:false", r3.ok, false);
  assertUntouched("搬到当前位置自己");

  // ④ 目标在当前位置**内部**(互相嵌套会递归复制)。
  const r4 = call<{ ok: boolean; error?: string }>(IPC.APP_MOVE_DATA_ROOT, {
    path: join(rootBefore, "inner"),
  });
  eq("搬到当前位置的内部 → ok:false", r4.ok, false);
  assertUntouched("搬到当前位置的内部");

  // ⑤ 目标在当前位置的**上级**(同样是递归)。
  const r5 = call<{ ok: boolean; error?: string }>(IPC.APP_MOVE_DATA_ROOT, {
    path: resolve(rootBefore, ".."),
  });
  eq("搬到当前位置的上级 → ok:false", r5.ok, false);
  assertUntouched("搬到当前位置的上级");

  // ⑥ 目标是个**已经存在的文件**。真实路径:用户在选择器里点到桌面上的某个
  //    文件、或者手输了一个文件的路径。`cpSync` 会以
  //    `ERR_FS_CP_DIR_TO_NON_DIR` 拒绝,但**这一档没有自己的中文话**(它在
  //    dataRoot.ts 里落进了最后那个 catch),所以这句 error 就是用户在设置页
  //    读到的那行字 —— 值得单独钉住。
  const asFile = join(SCRATCH, "是个文件.txt");
  writeFileSync(asFile, "x", "utf8");
  const r6 = call<{ ok: boolean; error?: string }>(IPC.APP_MOVE_DATA_ROOT, { path: asFile });
  eq("搬到「一个已存在的文件」上 → ok:false", r6.ok, false);
  check(
    "★ 失败那句话里不许出现 Node 的长路径前缀 \\\\?\\ (用户不认得那个东西)",
    typeof r6.error === "string" && r6.error.length > 0 && !r6.error.includes("\\\\?\\"),
    r6,
  );
  check("★ 但话还得是有内容的(摘前缀不能把话摘没了)", (r6.error ?? "").includes("复制失败"), r6);
  assertUntouched("搬到已存在的文件上");

  // ⑦ 目标在**一个不存在的盘**上。同样是走到 `cpSync` 才失败,同样不该漏前缀。
  const r7 = call<{ ok: boolean; error?: string }>(IPC.APP_MOVE_DATA_ROOT, {
    path: "Z:\\theme-ipc-smoke-不存在的盘\\mcode",
  });
  eq("搬到不存在的盘上 → ok:false", r7.ok, false);
  check(
    "★ 这一档也不许漏长路径前缀",
    typeof r7.error === "string" && r7.error.length > 0 && !r7.error.includes("\\\\?\\"),
    r7,
  );
  assertUntouched("搬到不存在的盘上");

  // ⑧ 目标在当前位置内部、但**大小写不同**(`…/mcode/sub` 对 `…/Mcode`)。
  //    `copyDataRootTo` 的嵌套判断是**大小写敏感**的字符串前缀比较,挡不住它;
  //    挡住它的是 `cpSync` 自己(它认 Windows 的路径等价)。所以这一档**确实被
  //    拒**,只是拒的理由是复制失败而不是"目标不能在当前位置的内部"。这条钉的是
  //    "结论对"(拒了、没动任何东西),不钉"用哪句话拒的" —— 换个平台的
  //    `cpSync` 可能给出别的错,那是实现细节。
  const cased = join(resolve(rootBefore, ".."), "mcode", "case-sub");
  const r8 = call<{ ok: boolean; error?: string }>(IPC.APP_MOVE_DATA_ROOT, { path: cased });
  eq("搬运目标大小写不同也拒(路径是同一个地方)", r8.ok, false);
  check("而且没有真的在那边建出目录来", !existsSync(cased), { cased });
  assertUntouched("大小写不同的内部目标");

  // ⑨ 入参不合法:空串被 zod 挡住。抛得难不难看是另一回事,这里钉的是
  //    "不许静默成功" —— 静默成功会把数据根切到一个空串上。
  const emptyThrew = catching(IPC.APP_MOVE_DATA_ROOT, { path: "" }) !== "";
  eq("空路径被挡住(抛出来,不是 ok:true)", emptyThrew, true);
  assertUntouched("空路径");

  // ⑩ 整个字段缺失 / 整个入参缺失。渲染端封装偶尔会漏传,而这两种一旦放过去,
  //    `input.path` 就是 undefined —— 后面那句 `isAbsolute(undefined)` 会抛在
  //    复制之前,但那时的调用方已经以为"在搬了"。
  eq("缺 path 字段被挡住", catching(IPC.APP_MOVE_DATA_ROOT, {}) !== "", true);
  eq("整个入参都没有也被挡住", catching(IPC.APP_MOVE_DATA_ROOT) !== "", true);
  assertUntouched("入参缺失");

  // ⑪ 全是空白的路径。`min(1)` 放它过,`isAbsolute("   ")` 为假 → 落到
  //    "目标必须是绝对路径"那一档。钉的是**别静默通过**(空白路径不是路径)。
  const blank = call<{ ok: boolean; error?: string }>(IPC.APP_MOVE_DATA_ROOT, { path: "   " });
  eq("三个空格的路径 → ok:false", blank.ok, false);
  assertUntouched("空白的路径");

  eq("整段下来数据根还是原来那个", dataRoot(), rootBefore);
}

/* ──────────────── §9 数据根搬家:成功路径 ──────────────── */

console.log("\n§9 搬数据根成功:整树复制、旧根留着、重启是推迟的");

{
  /**
   * ⚠️ **这一段必须是最后一段**:成功路径会 `closeDb()`,之后任何读库的调用都会抛
   * (`getDb() called before initDb() resolved`)。
   *
   * 验三件事:
   *   1. 整棵树真的复制过去了(不是只写了指针);
   *   2. 旧根**没被删** —— 注释说"留一份副本,万一新位置有问题还能找回来";
   *   3. 重启是**推迟**的 —— handler 先返回 `ok:true`,`relaunch` 过一会儿才发生。
   *      注释写明理由:"让这个 IPC 的返回值先回到渲染端 —— 否则界面看到的是
   *      点了没反应"。这一条只有把"返回的那一刻"和"之后"分开看才验得了。
   */
  const oldRoot = dataRoot();
  // 造一份内容,好断言"真的复制过去了"。
  mkdirSync(join(oldRoot, "library", "papers"), { recursive: true });
  writeFileSync(join(oldRoot, "library", "papers", "标记.txt"), "搬过去了吗", "utf8");

  const target = mkdtempSync(join(SCRATCH, "dest-"));
  resetAppCalls();

  const res = call<{ ok: boolean; error?: string }>(IPC.APP_MOVE_DATA_ROOT, { path: target });
  eq("搬到空目录 → ok:true", res.ok, true);

  // ★ 返回的那一刻:restart 还没发生。这条就是"推迟重启"本身。
  eq("★ 返回的**那一刻**还没有 relaunch(界面先拿到 ok)", appCalls.relaunch, 0);
  eq("★ 那一刻也还没 exit", appCalls.exitCodes.length, 0);

  check("新位置真的有了那份内容", existsSync(join(target, "library", "papers", "标记.txt")), {
    entries: existsSync(target) ? readdirSync(target) : null,
  });
  check("旧根没被删掉(注释说「留一份副本」)", existsSync(join(oldRoot, "library", "papers", "标记.txt")));
  eq("数据根切到新位置了", dataRoot(), resolve(target));

  // 等过那道 600ms 的闸 —— 之后才真的重启。
  await new Promise<void>((r) => setTimeout(r, 900));
  eq("推迟之后 relaunch 调了一次", appCalls.relaunch, 1);
  same("exit 调了一次,退出码 0", appCalls.exitCodes, [0]);

  rmSync(target, { recursive: true, force: true });
}

rmSync(SCRATCH, { recursive: true, force: true });

console.log(`\ntheme-ipc-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
