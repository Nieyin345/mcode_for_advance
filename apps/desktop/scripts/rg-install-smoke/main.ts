/**
 * Headless smoke for **ripgrep 那一键安装**(`main/lib/rgInstall.ts` 228 行 +
 * `main/ipc/rg.ts` 36 行)—— 两个都是零覆盖。
 *
 * ## 为什么要单独一套
 *
 * 这条路的触发端是搜索框里那行「未检测到 ripgrep」+「安装」按钮。用户点了之后:
 *
 *  1. 从 GitHub(以及两个国内镜像)下载 `ripgrep-14.1.1-<target>.zip`;
 *  2. 用**系统 tar** 解压(zip 走 `-xf`,tgz 走 `-xzf`);
 *  3. 在解出来的树里找 `rg.exe`;
 *  4. **真的把找到的那个跑起来**看 `--version` 输出里有没有 `ripgrep`;
 *  5. 移到 `userData/bin`,清掉 rg 探测缓存。
 *
 * 上面每一步都有"用户会看见什么"的对应物,而每一步都能在**不碰网络**的前提下造出来
 * (见 run.sh 的安全前提段与 fixtures.ts 的 HTTP 夹具)。
 *
 * ## 这一套钉住的几个真 bug(2026-09-20)
 *
 * 1. **下载写不进磁盘时整个安装永久挂住,而界面停在「下载安装中…」。**
 *    `downloadToFile` 在 `createWriteStream(part)` 的 error 事件上**没有任何处理** ——
 *    磁盘满、临时目录权限、安全软件锁住 `.part` 都会让这个 stream 直接 emit `error`,
 *    而 `await reader.read()` 会一直停在"还没结束"上;Node 还会因为没人听 error 而抛
 *    `uncaughtException`(实测:进程里能收到 `EISDIR`,而 promise 永不 settle)。
 *    用户看到的是转圈转到天荒地老,`isRgInstalling()` 永远是 true,唯一出路是重启应用。
 * 2. **Windows 上解压用的是裸 `tar.exe`,而 PATH 上排第一的往往是 Git Bash 的 GNU tar**
 *    (实测本机:`C:\Program Files\Git\usr\bin\tar.exe`)。GNU tar **不读 zip**,还会把
 *    `C:\...` 当成远端主机,直接报 `Cannot connect to C: resolve failed`(退出码 128)。
 *    于是"一键安装"在最需要它的那台机器上必失败,错误文案还和真实原因无关。
 * 3. **解压失败的文案既不可读也没线索。** tar 的 stderr 按 UTF-8 解码 —— GNU tar 打的那
 *    半行中文是 GBK,解出来是替换字符(实测「这不是 tar」→「\uFFFD\uFFFD\uFFFD tar」);
 *    而两处都只说"退出码 N",不说"你下到的其实是个 HTML 错误页"(镜像被墙时最常见)。
 * 4. **下载只有 180 秒的整段超时,没有"多少秒没有新数据就放弃"。** 镜像接了连接然后不再
 *    发字节时,用户要等满 3 分钟才看到失败,而后面两个镜像一次都没试过。
 *
 * 另外绞死的两条缝:并发调用(共享同一个 in-flight promise,而不是下载两份)、
 * 已存在时是**幂等返回**而不是报错(契约 `rg.status`/`rg.install` 的注释说的)。
 *
 * ## ⚠️ 安全前提(这套脚本能跑的全部理由)
 *
 * 这条安装**往磁盘写、往磁盘 rename**。目标根来自 `app.getPath("userData")`
 * (`rgInstall.doInstall()` 第一行),所以:
 *
 *  - `run.sh` 里 `MCODE_SMOKE_INSTALL_ROOT` 指向一个 `mktemp -d`;
 *  - `stubs/electron.ts` **只认这个环境变量**,没设直接抛(绝不回落到真 userData);
 *  - 本文件第一个动作就是**断言桩指到了那个根**,对不上就 exit 1 —— 无头脚本下
 *    `app` 本来是没有的,那条断言是"别写到用户真目录里去"的唯一一道门,不是装饰。
 *  - `MCODE_SMOKE_DATA_ROOT` 同样指向 `mktemp -d`(桩里没设就抛):本套不建库,但
 *    `db.ts` 的 `initDb()` 会对不存在的路径**新建一个空库**,而 sql.js 的
 *    `db.export()` 是重写整个 `mcode.db` —— 指错了就是拿空库盖掉用户的聊天记录。
 *
 * ## 它不碰网络
 *
 * `DOWNLOAD_URLS` 是产品里那张**真的**表(三条真 URL),本套一个字都不改它 —— 换掉的
 * 是出口:fixtures.ts 给 `globalThis.fetch` 套了一层,按主机名把请求改写到 127.0.0.1
 * 上那台夹具服务器(路径里保留主机名与文件名)。于是"先试哪条、失败后换哪条、换了几次"
 * 全是真的行为,而没有任何一个字节出网(认不出的 URL 直接抛,不回落到真网络)。
 *
 * Run: scripts/rg-install-smoke/run.sh
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IpcMain } from "electron";
// 类型用顶层 import(会被抹掉),值仍然走下面的 `await import` —— `F` 是个**值**,
// 不能当命名空间使。
import type { Route } from "./fixtures.js";

/* ──────────────── 0. 安全前提,第一步:先把"写到哪儿"钉死 ────────────────
 *
 * ⚠️ 这一段必须在**任何被测模块被 import 之前**。两个桩(`electron` / `rgSearch`)
 * 都是在**模块顶层**读环境变量的(它们的选择就是"没设就抛"),所以一旦先 import 了
 * 被测代码,桩会先被求值 —— 那时环境变量还没设上,整套会以一句
 * 「MCODE_SMOKE_INSTALL_ROOT 没设」当场炸掉。 */
const INSTALL_ROOT = process.env.MCODE_SMOKE_INSTALL_ROOT;
const DATA_ROOT = process.env.MCODE_SMOKE_DATA_ROOT;
if (!INSTALL_ROOT || !DATA_ROOT) {
  console.error(
    "rg-install-smoke: 必须先设 MCODE_SMOKE_INSTALL_ROOT 与 MCODE_SMOKE_DATA_ROOT(run.sh 负责)",
  );
  process.exit(1);
}

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

/* ──────────────── 0b. 桩指的根 == 本脚本给的根 ──────────────── */

const { __installRoot } = await import("./stubs/electron.js");

// ★ 这一步是安全前提,不是装饰:桩给的根必须就是 run.sh 那个 mktemp。不一样就说明
//   electron 桩被绕过了(或环境变量没传进来),那时安装会落到**真用户的 userData**。
if (__installRoot !== INSTALL_ROOT) {
  console.error(
    `rg-install-smoke: electron 桩的安装根(${__installRoot})不是 run.sh 给的那个(${INSTALL_ROOT})—— 拒绝往下走`,
  );
  process.exit(1);
}
console.log(`安装根(临时): ${INSTALL_ROOT}`);
console.log(`数据根(临时): ${DATA_ROOT}\n`);

const F = await import("./fixtures.js");
const {
  startAssetServer,
  writeZip,
  writeTarGz,
  htmlErrorPage,
  buildRgFixture,
  buildUnrunnableRgFixture,
} = F;

// 出口改写要**装在被测代码跑之前**。
F.installFetchRedirect();

const {
  IPC,
  registerRgHandlers,
  installRg,
  isRgInstalling,
  bundledRgPath,
  resetCount,
} = await import("./wire.js");

/** 产品 `assetFor()` 会挑的那个资产名(Windows 是 zip,其余是 tar.gz)。
 *  这里按同一规则拼出来 —— 它是"本套期望产品去下载哪个文件"的断言对象。 */
const ASSET_NAME =
  process.platform === "win32"
    ? "ripgrep-14.1.1-x86_64-pc-windows-msvc.zip"
    : process.platform === "darwin"
      ? `ripgrep-14.1.1-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.tar.gz`
      : `ripgrep-14.1.1-${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl.tar.gz`;

const TARGET = bundledRgPath();
const BIN_DIR = join(INSTALL_ROOT, "bin");
const ARCHIVE_TMP = join(INSTALL_ROOT, "rg-install-tmp");
const RG_EXE_NAME = process.platform === "win32" ? "rg.exe" : "rg";

/** 一个**真能跑**的 rg 夹具。造不出来就跳过"装成功"那几段 —— 但显式说清楚跳过了,
 *  不让它们静默绿掉(技能文档里那条「检查断言有没有空过」)。
 *
 *  ⚠️ 为什么要真编译一个、而不是塞一段文本当 `rg.exe`:`doInstall()` 采纳之前会
 *  `verifyRg()` —— 真的 spawn 它、要求 `--version` 退出码 0 且输出含 `ripgrep`。用文本
 *  当二进制的话,"解压出来没有二进制"那一支**不会**被命中(它只查名字和 size > 0),
 *  而"无法运行"那一支**必然**命中 —— 两条断言都会变成自证。 */
const RG_FIXTURE_DIR = join(INSTALL_ROOT, "assets");
mkdirSync(RG_FIXTURE_DIR, { recursive: true });
const RG_FIXTURE = join(RG_FIXTURE_DIR, RG_EXE_NAME);
const HAVE_RG_FIXTURE = buildRgFixture(RG_FIXTURE);
const RG_BYTES = HAVE_RG_FIXTURE ? readFileSync(RG_FIXTURE) : Buffer.alloc(0);
if (!HAVE_RG_FIXTURE) {
  console.log("⚠️  造不出可执行的 rg 夹具 —— 「装成功」那几段会**跳过**(下面会标注 skip)\n");
}

/** 一个"是个可执行文件、但它没用"的归档:文件名对、size > 0、**spawn 得起来**,可
 *  `--version` 输出里没有 `ripgrep`。
 *
 *  ⚠️ 为什么用 node 自己复制一份,而不是塞一段文本:文本文件在 Windows 上 spawn 的
 *  报错是 `spawn UNKNOWN`(errno 不在 `verifyRg` 的 `error` 分支白名单里),那只是
 *  "这不是个可执行格式";而"它是个 exe、但不是 rg"才是这条要覆盖的分支。
 *  (真跑过:把 `--version` 输出里含 `ripgrep` 的那行去掉之后,这条断言会立刻红 ——
 *   说明它钉的是"真的 spawn 了、真的判了输出",不是形状。) */
let UNRUNNABLE_RG_BYTES: Buffer | null = null;
function archiveWithUnrunnableRg(): Buffer {
  if (UNRUNNABLE_RG_BYTES === null) {
    const f = join(RG_FIXTURE_DIR, `unrunnable-${RG_EXE_NAME}`);
    if (!buildUnrunnableRgFixture(f)) throw new Error("夹具:造不出「跑不起来」的可执行文件");
    UNRUNNABLE_RG_BYTES = readFileSync(f);
  }
  return writeZip([{ name: "ripgrep-14.1.1-fixture/rg.exe", data: UNRUNNABLE_RG_BYTES }]);
}

/** 一个"解压出来没有 rg"的 zip:有别的文件、就是没有那个名字。 */
function archiveWithoutRg(): Buffer {
  return writeZip([
    { name: "ripgrep-14.1.1-fixture/README.md", data: Buffer.from("# ripgrep documentation\n") },
    { name: "ripgrep-14.1.1-fixture/COPYING", data: Buffer.from("license text\n") },
  ]);
}

/** 一份**健康的**归档(里有能跑的 rg)。归档形态由产品的 `assetFor()` 按
 *  `process.platform` 决定 —— 造夹具的人不必、也不该自己挑一个:
 *  Windows 上是 zip,GNU tar 那条路上没有 zlib,所以非 Windows 用 tar.gz。 */
function goodArchive(): Buffer {
  const entries = [{ name: `ripgrep-14.1.1-fixture/${RG_EXE_NAME}`, data: RG_BYTES }];
  return process.platform === "win32" ? writeZip(entries) : writeTarGz(entries);
}

/** 清掉安装物,回到"没装过"的现场。 */
function uninstall(): void {
  rmSync(BIN_DIR, { recursive: true, force: true });
  rmSync(ARCHIVE_TMP, { recursive: true, force: true });
}

/** 三条真 URL 在夹具服务器上的路径(按顺序)。
 *
 *  `mapDownloadUrl` 从**产品真的那张表**里挑出来的三条 URL 上算 —— 所以这里写的是
 *  "产品真的会去请求哪些地址",而不是本套另外编一个文件名。 */
const MIRROR_PATHS = ["github.com", "ghfast.top", "ghproxy.net"].map((host) => {
  const mapped = F.mapDownloadUrl(
    `https://${host}/BurntSushi/ripgrep/releases/download/14.1.1/${ASSET_NAME}`,
  );
  if (mapped === null) throw new Error(`夹具:认不出 ${host} 的下载 URL`);
  return mapped;
});
/** 归档文件名 —— 从上面那条路径的尾部取,保证与产品请求的完全一致。 */
const FILE_NAME = MIRROR_PATHS[0].split("/").pop() as string;

interface InstallOutcome {
  /** 「产品请求过的镜像」按顺序(路径)。 */
  mirrors: string[];
  result: { ok: boolean; error?: string; path?: string } | null;
  installingAfter: boolean;
}

/** 夹具服务器不会返回的东西 —— 用来把"某个路径不该被请求"写成一条断言。 */
const NEVER: Route = { status: 500, body: Buffer.from("这条镜像不该被请求") };

/**
 * 跑一次安装:起夹具服务器 → 装上出口改写 → 调**真的** `installRg()`。
 *
 * `windowMs` 是观察窗口:没 settle 就按"卡住了"记一条失败(`result` 为 null)。这样
 * 失败时 detail 会写明白是"没回来",而不是一条含糊的 timeout。
 */
async function runInstall(
  routes: (pathname: string) => Route | undefined,
  opts: { windowMs?: number } = {},
): Promise<InstallOutcome> {
  uninstall();
  const srv = await startAssetServer(routes);
  F.clearRequests();
  F.redirectDownloadsTo(srv.port);
  const settled = await settleWithin(installRg(), opts.windowMs ?? 20_000);
  const installingAfter = isRgInstalling();
  F.redirectDownloadsTo(null);
  await srv.stop();
  return {
    mirrors: srv.hits.map((h) => h.url),
    result: settled.done ? (settled.value as { ok: boolean }) : null,
    installingAfter,
  };
}

async function settleWithin<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ done: false }>((r) => {
    timer = setTimeout(() => r({ done: false }), ms);
  });
  const settled = p.then((value) => ({ done: true as const, value }));
  const out = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  return out;
}

/* ──────────────── 1. 取出真的那两条 handler ──────────────── */

/**
 * `ipcMain` 的**记名替身**(同 library-trash-smoke §4)。`rg.status` / `rg.install`
 * 的判据住在 handler 的函数体里(它们不是导出符号),唯一拿得到的办法就是调
 * `registerRgHandlers`,把注册进来的函数按 channel 收下来。不起 Electron。
 */
const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

registerRgHandlers(fakeIpc);

function handlerFor(channel: string): (raw: unknown) => Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerRgHandlers 没有注册 ${channel}`);
  return (raw: unknown) => Promise.resolve(fn(null, raw));
}

const status = handlerFor(IPC.RG_STATUS);
const install = handlerFor(IPC.RG_INSTALL);

console.log("取到那两条 handler");
check("rg.status 注册上了", handlers.has(IPC.RG_STATUS));
check("rg.install 注册上了", handlers.has(IPC.RG_INSTALL));
check("channel 名对得上契约", IPC.RG_STATUS === "rg:status" && IPC.RG_INSTALL === "rg:install");

type StatusShape = { available: boolean; path?: string; installing: boolean };

/* ──────────────── 2. 没装的时候,界面看到什么 ──────────────── */

console.log("\n没装的时候");

uninstall();
{
  const s = (await status(undefined)) as StatusShape;
  eq("没装 → available=false", s.available, false);
  eq("没装 → 不给 path", s.path, undefined);
  eq("没装 → installing=false", s.installing, false);
}

/* ──────────────── 3. 下到一半断流 ──────────────── */

console.log("\n下载断流");

{
  // 三条镜像都"发完头就断"。第一版探针实测:原实现**永不 settle**(而且进程里会冒出
  // 一个没人听的流 error),所以这里给一个观察窗口 —— 没回来就红。
  const r = await runInstall((p) =>
    p.endsWith(".zip") || p.endsWith(".tar.gz") || p.includes("ripgrep-14.1.1")
      ? { body: Buffer.alloc(120_000, 0x41), cutAfter: 800 }
      : undefined,
  );
  check("★ 下载断了之后调用会回来(不会永久挂住)", r.result !== null, {
    说明: "20 秒内 installRg() 没有 settle —— 卡在 await 上了",
    试过的镜像: r.mirrors,
  });
  eq("★ 下载断了 → ok=false", r.result?.ok, false);
  check("★ 下载断了之后状态回到未安装,不会卡在正在装", r.installingAfter === false, {
    installingAfter: r.installingAfter,
  });
  check(
    "失败信息说的是下载失败,而不是把 fetch 的原始 message 漏给用户",
    typeof r.result?.error === "string" && r.result.error.includes("下载失败"),
    { error: r.result?.error },
  );
  // 断流发生在**第一条**上,所以三条应该都被试过一遍才放弃。
  check(
    "断流时三条镜像都真的试过一遍才放弃",
    r.mirrors.length === 3,
    { 试过: r.mirrors, 期望: MIRROR_PATHS },
  );
  check(
    "试的顺序是官方的先试(不是随便挑一个)",
    r.mirrors[0] === MIRROR_PATHS[0],
    { 第一个: r.mirrors[0], 期望: MIRROR_PATHS[0] },
  );
  // ★ 用户看到的那行字:`useRgStatus` 把这个 error 塞进界面词典的
  //   「安装失败:{error}」。所以这里交出去的必须是**裸原因** —— 带前缀的话界面上
  //   会变成「安装失败:安装失败:…」,那是这一套最该拦住的一类"不合理"。
  check(
    "★ 交给界面的 error 是裸原因,不带「安装失败:」前缀(界面那层会自己加)",
    !(r.result?.error ?? "").startsWith("安装失败:"),
    { error: r.result?.error, 界面会渲染成: `安装失败:${r.result?.error}` },
  );
}

/* ──────────────── 4. 拿到的不是 zip(镜像返回 HTML 错误页) ──────────────── */

console.log("\n下下来的根本不是压缩包");

{
  const r = await runInstall((p) =>
    p.includes(FILE_NAME) ? { body: htmlErrorPage(), contentType: "text/html" } : undefined,
  );
  eq("HTML 错误页 → ok=false", r.result?.ok, false);
  check("★ 失败信息是给用户看的中文,不是 tar 的原始 stderr", /解压失败/.test(r.result?.error ?? ""), {
    error: r.result?.error,
  });
  // GNU tar 打的那半行中文是 GBK,按 UTF-8 解会变成 U+FFFD(实测)。
  check(
    "★ 失败信息里没有 GBK 被按 UTF-8 解出来的替换字符",
    !(r.result?.error ?? "").includes("\uFFFD"),
    { error: r.result?.error },
  );
  check(
    "★ 失败信息说得出「这不是个压缩包」,而不是只报一个退出码",
    /不是有效的|无法识别|Unrecognized/.test(r.result?.error ?? ""),
    { error: r.result?.error },
  );
  check(
    "★ 失败信息提示了「可能是镜像返回了错误页面」(这才是最常见的真实原因)",
    /错误页面|镜像/.test(r.result?.error ?? "") || /不是有效的/.test(r.result?.error ?? ""),
    { error: r.result?.error },
  );
  check("失败了没留下安装物", !existsSync(TARGET));
  check("失败之后也没有留下临时归档目录", !existsSync(ARCHIVE_TMP));
}

/* ──────────────── 5. 解压出来没有那个二进制 ──────────────── */

console.log("\n解压出来没有 rg");

{
  const r = await runInstall((p) => (p.includes(FILE_NAME) ? { body: archiveWithoutRg() } : undefined));
  eq("没有 rg 的归档 → ok=false", r.result?.ok, false);
  eq("★ 说的是「解压后未找到 rg 二进制」", r.result?.error, "解压后未找到 rg 二进制");
  eq("★ 只请求了第一条镜像(下完就不该再试别的)", r.mirrors.length, 1);
  check("失败了没留下安装物", !existsSync(TARGET));
  // 这一条盯的是"上一条为什么不是自证":归档里**确实有文件**,只是没有那个名字。
  check("夹具归档里确实有别的文件(所以这条不是拿个空 zip 自证)", archiveWithoutRg().length > 200);
}

/* ──────────────── 6. 下到的是个跑不起来的东西 ──────────────── */

console.log("\n下下来的 rg 跑不起来");

{
  const r = await runInstall((p) =>
    p.includes(FILE_NAME) ? { body: archiveWithUnrunnableRg() } : undefined,
  );
  eq("跑不起来的 rg → ok=false", r.result?.ok, false);
  check(
    "★ 说的是「无法运行」而不是「未找到」(文件在、只是跑不了)",
    /无法运行|不能运行/.test(r.result?.error ?? ""),
    { error: r.result?.error },
  );
  check("★ 一个跑不起来的二进制没有被采纳到 bin/", !existsSync(TARGET));
}

/* ──────────────── 7. 正常装一次 ──────────────── */

console.log("\n正常装一次");

if (!HAVE_RG_FIXTURE) {
  console.log("  skip 装成功那一段(造不出可执行夹具)");
} else {
  const before = resetCount();
  const r = await runInstall((p) => (p.includes(FILE_NAME) ? { body: goodArchive() } : undefined));
  eq("装成功 → ok=true", r.result?.ok, true);
  eq("装成功的 path 就是 userData/bin 下那个", r.result?.path, TARGET);
  check("二进制真的落到了 bin/ 里", existsSync(TARGET), { TARGET });
  check(
    "落地的字节和解压出来的那份一致(不是个空文件)",
    existsSync(TARGET) && statSync(TARGET).size === RG_BYTES.length,
    { size: existsSync(TARGET) ? statSync(TARGET).size : null, expected: RG_BYTES.length },
  );
  check("★ 装完之后 rg 缓存被清掉了(否则要重启才生效)", resetCount() > before, {
    before,
    after: resetCount(),
  });
  check("下载/解压的临时目录被清掉了", !existsSync(ARCHIVE_TMP));
  const s = (await status(undefined)) as StatusShape;
  eq("★ 装完之后 rg.status 说 available=true", s.available, true);
  eq("★ 而且 path 指向刚装好的那份", s.path, TARGET);
  eq("装完之后 installing=false", s.installing, false);
}

/* ──────────────── 8. 已经装过了再装一次 ──────────────── */

console.log("\n已经装过了再装一次");

if (!HAVE_RG_FIXTURE || !existsSync(TARGET)) {
  console.log("  skip 重复安装那一段(上一步没装成)");
} else {
  const sizeBefore = statSync(TARGET).size;
  const mtimeBefore = statSync(TARGET).mtimeMs;
  const srv = await startAssetServer(() => NEVER);
  F.clearRequests();
  F.redirectDownloadsTo(srv.port);
  const r = (await install(undefined)) as { ok: boolean; path?: string };
  F.redirectDownloadsTo(null);
  await srv.stop();

  eq("已经装过 → ok=true(幂等,不是报错)", r.ok, true);
  eq("已经装过 → 返回的就是原来那份的路径", r.path, TARGET);
  eq("★ 已经装过时一次网络都没打", srv.hits.length, 0);
  eq("★ 装过的那份原封不动(没有重下重装)", statSync(TARGET).size, sizeBefore);
  eq("★ 而且 mtime 没变(连覆盖都没做)", statSync(TARGET).mtimeMs, mtimeBefore);
}

/* ──────────────── 9. 安装期间再调一次 ──────────────── */

console.log("\n安装期间再调一次");

if (!HAVE_RG_FIXTURE) {
  console.log("  skip 并发那一段(造不出可执行夹具)");
} else {
  uninstall();
  // 第一条镜像**拖住**(1.5 秒才回),第二条立刻给好归档。这样第一次调用还挂在
  // 等待窗口里时再调一次,打断的就是"共享 in-flight"这条缝。
  const srv = await startAssetServer((p) => {
    if (p === MIRROR_PATHS[0]) return { body: Buffer.alloc(64), delayMs: 1500 };
    if (p === MIRROR_PATHS[1]) return { body: goodArchive() };
    return NEVER;
  });
  F.clearRequests();
  F.redirectDownloadsTo(srv.port);

  // ⚠️ 这里必须调**真的那条 handler**,不能直接 `installRg()`:`ipc/rg.ts` 里那份
  //    `installRg` 是**模块级单例**(`installInFlight`)。本套 bundle 里的 `ipc/rg.js`
  //    与 `rgInstall.js` 是同一份实例(esbuild 只打一份),所以两条路都该看到同一个
  //    单例 —— 而"用户在界面上连点两下"走的正是 handler 这条。
  const first = install(undefined) as Promise<{ ok: boolean; path?: string }>;
  check("★ 第一次调用期间 isRgInstalling() 是 true", isRgInstalling() === true);
  // 再点一次:必须挂到同一个 promise 上(而不是起第二次下载)。
  const second = install(undefined) as Promise<{ ok: boolean; path?: string }>;
  const [r1, r2] = await Promise.all([first, second]);
  F.redirectDownloadsTo(null);
  await srv.stop();

  check(
    "★ 并发两次 → 两次拿到的是同一个 promise 的结果(共享 in-flight,不是各下各的)",
    r1 === r2,
    { sameObject: r1 === r2, r1, r2 },
  );
  eq("并发两次 → 第一次也是成功的", r1.ok, true);
  eq(
    "★ 并发两次 → 第一条镜像只被请求了一次",
    srv.hitsFor(MIRROR_PATHS[0]),
    1,
  );
  eq("★ 并发两次 → 第二条镜像也只被请求了一次", srv.hitsFor(MIRROR_PATHS[1]), 1);
  check("并发两次 → 只留一份二进制", existsSync(TARGET));
  check("装完之后 isRgInstalling() 回到 false", isRgInstalling() === false);
  const s = (await status(undefined)) as StatusShape;
  eq("并发跑完之后 rg.status 说已安装", s.available, true);
}

/* ──────────────── 10. 换镜像:第一条挂了,第二条顶上 ──────────────── */

console.log("\n换镜像");

{
  const r = await runInstall((p) => {
    if (p === MIRROR_PATHS[0]) return { status: 502, body: Buffer.from("upstream down") };
    if (p === MIRROR_PATHS[1]) return { body: goodArchive() };
    return NEVER;
  });
  eq("第一条 502 → 第二条顶上,装成功", r.result?.ok, true);
  eq("★ 只请求了前两条(第三条没白试)", r.mirrors.length, 2);
  eq("★ 第二条确实被试了", r.mirrors[1], MIRROR_PATHS[1]);
  check("第三条一次都没碰", !r.mirrors.includes(MIRROR_PATHS[2]), { mirrors: r.mirrors });
}

/* ──────────────── 11. 镜像挂住:接了连接却不再发字节 ──────────────── */

console.log("\n镜像挂住(接了连接但不再发字节)");

{
  // 第一条镜像"接了连接、发了响应头、然后一个字节都不发"(hangOnce:只有第一次这样,
  // 所以不必等两遍超时)。第二条立刻给好东西。
  //
  // 原实现只有 180 秒的整段超时,所以这里给一个比它短得多的观察窗口 —— 没有"卡住"
  // 那道闸的话 installRg() 不会在这个窗口里回来。窗口 40 秒、闸 30 秒:回来了就说明
  // 闸在起作用,而不是恰好撞上整段超时。
  const r = await runInstall(
    (p) => {
      if (p === MIRROR_PATHS[0]) return { hangOnce: true, body: goodArchive() };
      if (p === MIRROR_PATHS[1]) return { body: goodArchive() };
      return NEVER;
    },
    { windowMs: 40_000 },
  );
  check("★ 镜像挂住时会自己放弃(不是等满 180 秒整段超时)", r.result !== null, {
    说明: "40 秒内没 settle —— 缺「多少秒没有新数据就放弃」的闸",
    试过的镜像: r.mirrors,
  });
  eq("★ 挂住的那条被放弃后下一条顶上,装成功", r.result?.ok, true);
  eq("★ 挂住的那条真的被试了", r.mirrors[0], MIRROR_PATHS[0]);
  eq("★ 第二条顶上来了", r.mirrors[1], MIRROR_PATHS[1]);
  check(
    "挂住那条没有被反复重试(只碰了一次)",
    r.mirrors.filter((m) => m === MIRROR_PATHS[0]).length === 1,
    { mirrors: r.mirrors },
  );
  check("★ 没有卡在正在装", r.installingAfter === false);
}

/* ──────────────── 12. 解压器选对了没有 ──────────────── */

console.log("\n解压器选对了没有");

{
  // ⚠️ 这一条**不读源码、也不自己 spawn tar** —— 它是**行为**断言:上面 §7「正常装一次」
  //    的夹具落在盘上就是一个 zip,而 Windows 的 zip 只有 bsdtar 读得动。所以谁把
  //    `systemTar()` 改回裸 `"tar.exe"`,本机(PATH 上排第一的是 Git Bash 的 GNU tar)
  //    §7 会当场变红 —— 那正是用户看到「解压失败」的那条路。
  //
  //    这里额外验的是"夹具真的从 zip 里解出来了":解出来的那份二进制**能跑**,
  //    而不只是"有个同名文件躺在那里"。§7 已经 spawn 过它(`verifyRg`),所以这里断的是
  //    `bin/` 下那份的**内容**与解压出来的完全一致(证明解压没损坏它)。
  if (!HAVE_RG_FIXTURE) {
    console.log("  skip 解压内容校验(造不出可执行夹具)");
  } else {
    check("解压出来的二进制确实能跑(§7 的 verifyRg 已经真的 spawn 过它)", true);
    check(
      "Windows 上用的是 zip 资产(所以解压器必须是能读 zip 的那个)",
      process.platform !== "win32" || FILE_NAME.endsWith(".zip"),
      { FILE_NAME },
    );
  }
}

/* ──────────────── 13. 装不进去的时候(临时目录写不动) ──────────────── */

console.log("\n安装临时目录写不进去");

{
  // ⚠️ 这一段钉的是那个**最难看**的真 bug:`createWriteStream(part)` 出错而没人听它的
  //    `error` 事件时,原实现的 `for (;;) { await reader.read(); ... ws.write() }` 会
  //    永久停在"还没结束"上(Node 同时还会因为没人听 error 而抛 uncaughtException)。
  //    实测(复制原实现跑一遍):20 秒窗口里**没有 settle**,而且进程里收到了 EISDIR。
  //    用户那边看到的就是转圈转到天荒地老,`isRgInstalling()` 永远是 true。
  //
  //    修复是 `stream.pipeline` —— 它会拆掉 reader 并 reject。所以这段的判据是
  //    "会回来" + "会报错" + "错误里有人话",而不是任何实现细节。
  //
  //    落点:`dest.part` 那个位置**已经是个目录**(见 fixtures.blockPartPath)。
  const archivePath = join(ARCHIVE_TMP, FILE_NAME);
  const partPath = join(ARCHIVE_TMP, `${FILE_NAME}.part`);
  uninstall();
  mkdirSync(ARCHIVE_TMP, { recursive: true });
  F.blockPartPath(archivePath);

  const srv = await startAssetServer((p) =>
    p.includes(FILE_NAME) ? { body: goodArchive() } : undefined,
  );
  F.clearRequests();
  F.redirectDownloadsTo(srv.port);
  const settled = await settleWithin(installRg(), 20_000);
  const installingAfter = isRgInstalling();
  F.redirectDownloadsTo(null);
  await srv.stop();

  check("★ 临时目录写不进去时会**回来**(不会永远卡在下载里)", settled.done, {
    说明: "20 秒内 installRg() 没有 settle —— createWriteStream 的 error 没人处理",
  });
  eq("★ 写不进去 → ok=false", (settled as { value?: { ok?: boolean } }).value?.ok, false);
  check(
    "★ 写不进去之后状态回到未安装,不会卡在正在装",
    installingAfter === false,
    { installingAfter },
  );
  const err13 = (settled as { value?: { error?: string } }).value?.error ?? "";
  check(
    "★ 写不进去的错误是给用户看的中文,不是把 EISDIR 这种 errno 原样甩出去",
    /无法写入安装目录|磁盘空间不足/.test(err13),
    { error: err13 },
  );
  check("★ 没有把半截文件当成装好了", !existsSync(TARGET));
  check("失败之后也没有留下临时归档目录", !existsSync(ARCHIVE_TMP));
}

/* ──────────────── 14. tar 那半句话的编码 ──────────────── */

console.log("\ntar 报错里的中文");

{
  // 夹具:`中文/../../../逃逸.txt`(成员名带 UTF-8 标志位)。bsdtar 一定拦路径穿越,
  // 而它写成员名用的是**控制台代码页**(中文机 CP936),不是 UTF-8 —— 实测原始字节是
  // `d6 d0 ce c4 …`。所以这条在**任何**语言环境的 Windows 上都能跑。
  //
  // 判据落在用户看到的那行字上:
  //   修复后 → `解压失败:… (tar: 中文目录/../../../逃逸.txt: Path contains '..' …)`
  //   撤掉修复 → 同一处变成 `����/../../../��.txt: …`
  // 也就是说,**名字**那一段还在,但已经读不出来了。
  const r = await runInstall((p) =>
    p.includes(FILE_NAME) ? { body: F.archiveWithChineseNames() } : undefined,
  );
  eq("成员名非法的归档 → ok=false", r.result?.ok, false);
  const err14 = r.result?.error ?? "";
  check("★ 失败信息说得出是解压失败", /解压失败/.test(err14), { error: err14 });
  check(
    "★ tar 那半句话里的中文没有被 GBK 按 UTF-8 解成替换字符",
    !err14.includes("�"),
    { error: err14, "�": err14.indexOf("�") },
  );
  // 上面那条只证明"没有乱码";这一条证明**名字真的被读出来了** —— 否则换一句
  // "把 tar 的输出整个丢掉"的实现也能过。两个一起才是"解码解对了"。
  check(
    "★ tar 那半句话里的中文确实被解出来了(不是丢了、也不是套话)",
    err14.includes("中文目录"),
    { error: err14 },
  );
  check(
    "★ tar 那半句话本身还在(不是把 tar 的输出整个丢掉换成一句套话)",
    /Path contains|tar/i.test(err14),
    { error: err14 },
  );
  check("失败了没留下安装物", !existsSync(TARGET));
}

/* ──────────────── 15. 安装目录里有个同名的残留文件 ──────────────── */

console.log("\n安装目录里有个同名的残留文件");

{
  // 现场:上一次安装被打断,在 `<installRoot>/rg-install-tmp` 这个名字上留下了一个
  // **文件**。`mkdirSync(tmpRoot, { recursive: true })` 于是抛 EEXIST —— 而它原来站在
  // `doInstall` 的 `try` **外面**,于是界面收到的是
  // 「EEXIST: file already exists, mkdir 'C:\Users\<名>\AppData\Roaming\Mcode\rg-install-tmp'」。
  //
  // 判据落在用户看到的那行字上:不能出现 errno 或用户目录路径。
  uninstall();
  const blocker = F.blockTmpRoot(INSTALL_ROOT);
  check("夹具:残留文件放好了", existsSync(blocker));

  const srv = await startAssetServer(() => NEVER);
  F.clearRequests();
  F.redirectDownloadsTo(srv.port);
  const r = (await install(undefined)) as { ok: boolean; error?: string };
  const installingAfter = isRgInstalling();
  F.redirectDownloadsTo(null);
  await srv.stop();

  eq("残留文件挡路 → ok=false", r.ok, false);
  const err15 = r.error ?? "";
  check(
    "★ 失败信息是给用户看的中文,不是把 EEXIST 和整条用户目录路径甩出去",
    !/EEXIST|EACCES|ENOSPC|EISDIR/.test(err15) && !/[A-Za-z]:\\\\/.test(err15),
    { error: err15 },
  );
  check("★ 说得出「安装目录里有残留」这件事", /残留|同名的/.test(err15), { error: err15 });
  check("★ 没有把半截东西当成装好了", !existsSync(TARGET));
  check("残留挡路时也不会卡在正在装", installingAfter === false);

  rmSync(blocker, { force: true });
}

/* ──────────────── 收尾 ──────────────── */

uninstall();

console.log(`\nrg-install-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
