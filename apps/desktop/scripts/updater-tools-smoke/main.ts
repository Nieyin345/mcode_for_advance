/**
 * 无头回归网:`env/toolInstall.ts`(文档工具链的装 / 卸)+ `ipc/updater.ts`(更新器
 * 的三个 IPC 出口)。
 *
 * ## 为什么要有这一套
 *
 * `toolInstall.ts` 是**真的会往用户磁盘上写**的那种代码:它下载(pandoc 约 40 MB,
 * TinyTeX 165 MB)、解包、把整棵树 `rename` 进 `<userData>/tools/<工具>/<版本>/`,
 * 装完还往用户的解释器里跑 pip。而它原先**零测试覆盖** —— 上面每一条边界(下到
 * 一半断了、解出来是空的、同名版本重装、删的边界)都只在用户机器上第一次发作。
 *
 * ## 这一套不下载任何东西,也不装任何东西
 *
 * 三条路把网络与真安装全堵死:
 *
 *   1. **`fetch` 换成桩**(见下面的 `installFetch`)。所有出口只有两条:那份
 *      「版本 + 资产 + sha256」的发行信息,和资产下载地址。本套按调用点分别给
 *      答案,假的包体在内存里现造。没登记的 URL 一律抛,所以出网就当场炸。
 *   2. **子进程按命令名路由**(`stubs/childProcess.ts`)。`tar` 那条**故意不登记**
 *      —— 让它去跑本机真的 System32\bsdtar 解一个本套现造的真 zip。「解包」这一
 *      步因此是真验的。`pip` / 自解压 exe / `tlmgr` 全部登记成桩。
 *   3. **落点全部指向 `mktemp` 出来的目录**。`app.getPath("userData")` 那个桩
 *      **没设 `MCODE_SMOKE_USER_DATA` 就抛**,工具根由本文件显式 `setToolRoot()`
 *      指过去,而且**先断言钉上了再往下走**。
 *
 * ⚠️ 这条最要紧:`toolInstall` 的落点是 `getToolRoot()`,而那个在无头脚本下本来
 * 是 `null` —— 那时它会落到 `app.getPath("userData")`,也就是用户真实的
 * `%APPDATA%\@mcode\desktop`。所以每一段动磁盘的断言之前都先钉一次根。
 *
 * ## 不碰数据库
 *
 * 这两个被测模块都不 import `db` / `repositories`,所以这里没有
 * `MCODE_SMOKE_DATA_ROOT`。更新器那一边的持久化在 `updater.ts` 里(归另一套验),
 * 本套把整个 `@main/updater.js` 换成了记名桩。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { setToolRoot, getToolRoot } from "@main/env/managedToolRoots.js";
import { installTool, removeTool, isToolInstalling, lastToolError } from "@main/env/toolInstall.js";
import { registerUpdaterHandlers } from "@main/ipc/updater.js";

import * as cp from "./stubs/childProcess.js";
import * as win from "./stubs/window.js";
import * as tc from "./stubs/toolchain.js";
import * as ae from "./stubs/agentEnv.js";
import * as fsStub from "./stubs/fs.js";
import * as up from "./stubs/updater.js";
import { slot, resetCounts } from "./stubs/shared.js";

/* ─────────────────────────── 断言助手 ─────────────────────────── */

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
function section(title: string): void {
  console.log(`\n${title}`);
}

/* ─────────────────────────── 沙盒 ─────────────────────────── */

/** 本套的 `<userData>` —— 从环境变量来,没设就抛(见 run.sh 的安全前提段落)。 */
const USER_DATA = process.env.MCODE_SMOKE_USER_DATA;
if (!USER_DATA) throw new Error("MCODE_SMOKE_USER_DATA 没设 —— run.sh 必须先 export 它");

/** 自管工具的根(`<userData>/tools`)。 */
const TOOL_ROOT = join(USER_DATA, "tools");

/* ─────────────────────────── fetch 桩 ─────────────────────────── */

interface FakeResponse {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  json?: unknown;
  /** 抛出来的错(模拟连接被拒 / 超时)。 */
  throw?: string;
}

type Handler = (url: string) => FakeResponse;

let fetchHandler: Handler | null = null;
const fetchLog: string[] = [];

function installFetch(handler: Handler | null): void {
  fetchHandler = handler;
  fetchLog.length = 0;
}

function assetHits(): string[] {
  return fetchLog.filter((u) => !u.includes("api.github.com"));
}

(globalThis as { fetch?: unknown }).fetch = async (input: unknown): Promise<unknown> => {
  const url = String(input);
  fetchLog.push(url);
  if (!fetchHandler) throw new Error(`本套没装 fetch 桩,却有请求打到 ${url}`);
  const r = fetchHandler(url);
  if (r.throw) throw new Error(r.throw);
  const bytes =
    r.body === undefined ? new Uint8Array(0) : typeof r.body === "string" ? Buffer.from(r.body, "utf8") : r.body;
  return {
    ok: r.ok ?? true,
    status: r.status ?? 200,
    headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
    json: async () => r.json,
    // ⚠️ 必须是一个**真的** `ReadableStream`:`downloadVerified` 把它交给
    // `Readable.fromWeb()`,而那个函数是 node 内建、不认鸭子类型 —— 喂一个
    // 「有 getReader 的对象」它会报 `The "readableStream" argument must be an
    // instance of ReadableStream. Received an instance of Object`。第一版就是这么
    // 红的(而且是**两条通道都红**,看起来像"下载坏了而不是桩坏了")。
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.length > 0) controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
};

/* ─────────────────────────── 现造 zip ─────────────────────────── */

/** 造一个 zip(**store 存法,不压缩**)。
 *
 *  为什么不用 deflate:解压这一步交给本机真的 bsdtar,而 store 法的 zip 只有
 *  「本地文件头 + 原样数据 + 中央目录」三块,除了 CRC 不需要任何算法 —— 手写
 *  四十行就够,不依赖任何压缩库。本套要验的是「解出来的东西有没有被正确搬到
 *  位」,不是「解压器的压缩率」。 */
function makeZip(entries: Array<{ name: string; data: string }>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const dataBuf = Buffer.from(e.data, "utf8");
    const crc = crc32(dataBuf);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 名字按 UTF-8
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, dataBuf);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + dataBuf.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, cdBuf, end]));
}

function sha256Hex(bytes: Uint8Array): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/** pandoc 的假包:单顶层目录里放一个 `pandoc.exe`(真实布局就是这样)。 */
function pandocZip(version: string): Uint8Array {
  return makeZip([
    { name: `pandoc-${version}/pandoc.exe`, data: `MZ fake pandoc ${version}` },
    { name: `pandoc-${version}/README.txt`, data: "fake" },
  ]);
}

const PANDOC_TAG = "3.11";
const PANDOC_VERSION = PANDOC_TAG;
const PANDOC_ASSET = `pandoc-${PANDOC_TAG}-windows-x86_64.zip`;
const PANDOC_URL = `https://github.com/jgm/pandoc/releases/download/${PANDOC_TAG}/${PANDOC_ASSET}`;

/** GitHub API 那份发行信息的假答案。域名只是让断言读起来像真的 ——
 *  真正兜住「不出网」的是上面那个 fetch 桩。 */
function pandocReleaseJson(bytesLen: number, sha: string, digestOverride?: unknown): unknown {
  const asset: Record<string, unknown> = {
    name: PANDOC_ASSET,
    size: bytesLen,
    digest: `sha256:${sha}`,
    browser_download_url: PANDOC_URL,
  };
  if (digestOverride !== undefined) asset.digest = digestOverride;
  return { tag_name: `v${PANDOC_TAG}`, assets: [asset] };
}

/** 一个「官方发行信息 + 资产能下」的正常答案。`failOfficial` 时官方站那条通道抛。 */
function happyPandoc(bytes: Uint8Array, sha: string, opts: { failOfficial?: boolean } = {}): void {
  installFetch((url) => {
    if (url.includes("api.github.com")) return { json: pandocReleaseJson(bytes.length, sha) };
    if (url.includes("ghfast.top")) return { headers: { "content-length": String(bytes.length) }, body: bytes };
    if (url.includes("github.com")) {
      if (opts.failOfficial) return { throw: "官方站连接超时" };
      return { headers: { "content-length": String(bytes.length) }, body: bytes };
    }
    throw new Error(`没登记的 URL:${url}`);
  });
}

/* ─────────────────────────── 环境准备 ─────────────────────────── */

function freshToolRoot(): string {
  rmSync(TOOL_ROOT, { recursive: true, force: true });
  mkdirSync(TOOL_ROOT, { recursive: true });
  setToolRoot(TOOL_ROOT);
  // 先断言钉上了再往下走 —— 没钉上时它落到 app.getPath("userData"),那是用户
  // 真实的目录,这一段的每一条断言都会变成「在用户机器上动土」。
  if (getToolRoot() !== TOOL_ROOT) throw new Error("工具根没钉上 —— 后面的断言会在用户真实目录上跑,拒绝继续");
  return TOOL_ROOT;
}

/** 设定「本机选中的解释器」——`toolchain.ts` 的桩会把它回给 `installPythonDeps`。
 *  默认是 `null`(结构上不可能真的跑 pip,见那个桩的文件头)。 */
function setPythonForInstall(exe: string | null): void {
  slot.counts.pythonForInstall = exe;
}

function listDir(p: string): string[] {
  try {
    return readdirSync(p).sort();
  } catch {
    return [];
  }
}

/** 列出工具根下所有文件的相对路径 —— 「有没有留下垃圾」用。 */
function fileTree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full.slice(root.length + 1).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** tmp 里以某前缀开头的残留 —— 半截状态的观测点。 */
function tmpLeftovers(prefix: string): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(prefix));
}

/* ─────────────────────────── 开场 ─────────────────────────── */

console.log("updater-tools-smoke");

/* ══════════════════════════════════════════════════════════════
 * 甲、子进程桩自己忠不忠实
 *
 * 这一段必须**最先**跑:下面所有关于 `execFileSync` 返回值的断言都建立在这个桩
 * 照 Node 的真实行为办事上。桩要是不忠实,那些断言会绿得毫无意义。
 * ══════════════════════════════════════════════════════════════ */

section("甲、子进程桩的忠实度(下面所有断言的立足点)");

{
  const r = cp.assertStubFaithful();
  check("execFileSync 在 stdio[1] 是 ignore 时返回 null、是 pipe 时返回 stdout(照 Node 的真实行为)", r.ok, r.detail);
}

/* ══════════════════════════════════════════════════════════════
 * 乙、pandoc 安装:正常路径
 * ══════════════════════════════════════════════════════════════ */

section("乙、pandoc 安装:装上、搬对地方、把路径接回环境");

{
  const root = freshToolRoot();
  const bytes = pandocZip(PANDOC_VERSION);
  happyPandoc(bytes, sha256Hex(bytes));
  win.resetFrames();
  resetCounts();
  resetCounts();

  const res = await installTool("pandoc");

  check("装上成功", res.ok, res);
  eq("版本目录就是上游的版本号", JSON.stringify(listDir(join(root, "pandoc"))), JSON.stringify([PANDOC_VERSION]));
  check(
    "可执行文件落在版本目录根下(不是套着 zip 里那个目录名)",
    existsSync(join(root, "pandoc", PANDOC_VERSION, "pandoc.exe")),
    listDir(join(root, "pandoc", PANDOC_VERSION)),
  );

  const frames = win.toolchainEvents();
  const done = frames.filter((f) => f.phase === "done");
  eq("收尾推了一帧 done", done.length, 1);
  eq("done 那帧的 tool 是 pandoc", done[0]?.tool, "pandoc");
  eq("done 那帧的 progress 是 1", done[0]?.progress, 1);
  check(
    "每一帧都带 channel —— preload 是按 channel 分发的,channel 写错界面一帧都收不到",
    win.frames.length > 0 && win.frames.every((f) => f.channel === "toolchain:event"),
    win.frames.map((f) => f.channel),
  );

  eq("装完把检测缓存失效了一次", slot.counts.invalidate, 1);
  eq("装完把 agent 环境重算了一遍(漏掉它 = 面板说装好了、agent 那边 command not found)", slot.counts.applyEnv, 1);

  const tree = fileTree(root);
  check(
    "工具根下只多了那一份 pandoc,没有暂存目录 / 临时文件 / 半截文件",
    tree.length === 2 && tree.every((p) => p.startsWith(`pandoc/${PANDOC_VERSION}/`)),
    tree,
  );
  check("下载用的临时压缩包没落在工具根里", !tree.some((p) => /\.zip$|\.download$|stage-/.test(p)), tree);
}

/* ══════════════════════════════════════════════════════════════
 * 丙、「解包」这一步是真的
 *
 * 上一段之所以能搬对,是因为 `tar` **没有**被登记 —— 它跑的是本机 System32 的
 * bsdtar,把本套现造的那个 zip 真解开了。这一段把这个前提本身钉住:谁要是顺手
 * 把 `tar` 也登记成桩,上一段就变成「在验桩」了。
 * ══════════════════════════════════════════════════════════════ */

section("丙、解包走的是真的 bsdtar(不是桩)");

{
  freshToolRoot();
  const bytes = pandocZip(PANDOC_VERSION);
  happyPandoc(bytes, sha256Hex(bytes));
  cp.resetCalls();

  await installTool("pandoc");

  const tarCalls = cp.callsOf("tar.exe");
  check("确实起过一次 tar.exe", tarCalls.length >= 1, tarCalls.map((c) => c.args));
  check("那次 tar 没被登记成桩(跑的是真进程)", tarCalls.every((c) => !c.stubbed), tarCalls.map((c) => c.stubbed));
  check(
    "而且没裸着调 tar —— Windows 上 Git Bash 的 GNU tar 排在 System32 之前,而 GNU tar 不认 zip",
    cp.callsOf("tar").length === 0,
    cp.callsOf("tar").map((c) => c.cmd),
  );
  const used = (tarCalls[0]?.cmd ?? "").replace(/\//g, "\\");
  const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  check(
    "用的是 System32 那个绝对路径(或这台机器没有它、退回裸名)",
    /system32\\tar\.exe$/i.test(used) || !existsSync(systemTar),
    used,
  );
}

/* ══════════════════════════════════════════════════════════════
 * 丁、校验值不对 → 拒绝安装,而且磁盘上不留任何东西
 *
 * 「半截状态」最要紧的一条:sha256 对不上时那个下好的临时文件必须被删掉,工具根
 * 必须一个字节都没动过。上游换了包、或者有人中间改了东西,用户看到的应该是一句
 * 「没装上」,不是「装上了但跑不起来」。
 * ══════════════════════════════════════════════════════════════ */

section("丁、sha256 对不上 → 一个字节都不落地");

{
  const root = freshToolRoot();
  const bytes = pandocZip(PANDOC_VERSION);
  happyPandoc(bytes, "0".repeat(64));
  win.resetFrames();

  const res = await installTool("pandoc");

  eq("装失败", res.ok, false);
  check("错误里点名是校验值不对", /sha256/.test(res.error ?? ""), res.error);
  eq("工具根里连 pandoc 这一层都没建", listDir(join(root, "pandoc")).length, 0);
  eq("工具根下空无一物", fileTree(root).length, 0);

  const errs = win.toolchainEvents().filter((f) => f.phase === "error");
  eq("推了一帧 error", errs.length, 1);
  check("error 那帧带上了原因(界面要显示它)", typeof errs[0]?.error === "string" && errs[0]!.error!.length > 0, errs[0]);
  eq("error 那帧 progress 是 -1", errs[0]?.progress, -1);
  eq("失败时不推 done", win.toolchainEvents().filter((f) => f.phase === "done").length, 0);
  eq("下载用的临时文件也被删了(没在 tmp 里留一份几十 MB 的垃圾)", tmpLeftovers("mcode-tool-pandoc-").length, 0);
}

/* ══════════════════════════════════════════════════════════════
 * 戊、「已装过」的判据 —— 目录在 ≠ 装过
 *
 * 这一段对着仓库刚修过的那个 `.staging-*` 形状问一遍:半截状态会不会让「已装」
 * 的判据误判?(那个 bug 是「崩溃残留的半截目录被当成已安装版本」。)
 * ══════════════════════════════════════════════════════════════ */

section("戊、已装过认的是里面那个可执行文件在不在,不是目录在不在");

{
  const root = freshToolRoot();
  // 手工造一个「崩溃残留」的版本目录:有目录、没文件。
  mkdirSync(join(root, "pandoc", PANDOC_VERSION), { recursive: true });
  const bytes = pandocZip(PANDOC_VERSION);
  happyPandoc(bytes, sha256Hex(bytes));

  const res = await installTool("pandoc");
  check("空的版本目录不会让安装短路", res.ok, res);
  check(
    "重装之后可执行文件确实在里面",
    existsSync(join(root, "pandoc", PANDOC_VERSION, "pandoc.exe")),
    listDir(join(root, "pandoc", PANDOC_VERSION)),
  );

  // 另一个版本号下的空目录:不该被当成「已经有了一份」
  freshToolRoot();
  mkdirSync(join(root, "pandoc", "0.0.0-empty"), { recursive: true });
  const res2 = await installTool("pandoc");
  check("版本目录在、里头空空,也不会被当成已安装", res2.ok, res2);
  eq(
    "新版本照样装进来,那个空目录留着不动(它不属于这次操作)",
    JSON.stringify(listDir(join(root, "pandoc"))),
    JSON.stringify(["0.0.0-empty", PANDOC_VERSION].sort()),
  );
}

/* ══════════════════════════════════════════════════════════════
 * 己、上游没给校验值 → 拒绝安装
 *
 * 这是这个模块最要紧的一条设计:宁可失败并告诉用户自己装,也不降低校验标准。
 * 断言要立在**用户看到的那句话**上,不是立在机制上。
 * ══════════════════════════════════════════════════════════════ */

section("己、上游没给 sha256 → 不装,并把话说清楚");

{
  const root = freshToolRoot();
  const bytes = pandocZip(PANDOC_VERSION);
  installFetch((url) => {
    if (url.includes("api.github.com")) return { json: pandocReleaseJson(bytes.length, "", undefined) };
    throw new Error(`不该有人去下东西 —— 校验值都没有:${url}`);
  });
  win.resetFrames();

  const res = await installTool("pandoc");

  eq("装失败", res.ok, false);
  check("那句话告诉用户为什么不装(不是一句没法行动的技术报错)", /校验/.test(res.error ?? ""), res.error);
  eq("一个字节的资产都没下", assetHits().length, 0);
  eq("工具根没建", listDir(join(root, "pandoc")).length, 0);

  // digest 字段有、但不是 sha256: 开头(上游换了摘要算法)—— 同样得拒
  freshToolRoot();
  installFetch((url) => {
    if (url.includes("api.github.com")) return { json: pandocReleaseJson(bytes.length, "abc", "sha512:abc") };
    throw new Error("不该去下");
  });
  const res2 = await installTool("pandoc");
  eq("换了个摘要算法也一样拒(只认 sha256:)", res2.ok, false);
  eq("同样一个字节都没下", assetHits().length, 0);
}

/* ══════════════════════════════════════════════════════════════
 * 庚、下载通道:官方失败 → 镜像顶上;全失败 → 把每条通道的原因都报出来
 * ══════════════════════════════════════════════════════════════ */

section("庚、多通道:换源,以及全失败时把原因一起报出来");

{
  freshToolRoot();
  const bytes = pandocZip(PANDOC_VERSION);
  happyPandoc(bytes, sha256Hex(bytes), { failOfficial: true });

  const res = await installTool("pandoc");
  check("官方站挂了、镜像顶上,依然装上", res.ok, res);
  check("确实先试了官方站", fetchLog.some((u) => u.includes("github.com/jgm")), fetchLog);
  check("再试了镜像", fetchLog.some((u) => u.includes("ghfast.top")), fetchLog);

  // 全失败:错误里要能同时看到两条通道,而不是只有最后一条
  freshToolRoot();
  const bytes2 = pandocZip(PANDOC_VERSION);
  installFetch((url) => {
    if (url.includes("api.github.com")) return { json: pandocReleaseJson(bytes2.length, sha256Hex(bytes2)) };
    throw new Error("这条路也不通");
  });
  const res2 = await installTool("pandoc");
  eq("全失败 → 装失败", res2.ok, false);
  check(
    "两条通道各报一份(只报最后一条会让人以为是同一个错误反复发生)",
    /github\.com/.test(res2.error ?? "") && /ghfast\.top/.test(res2.error ?? ""),
    res2.error,
  );
}

/* ══════════════════════════════════════════════════════════════
 * 辛、并发 / 重复安装
 * ══════════════════════════════════════════════════════════════ */

section("辛、同一个工具同时来两次:第二次被挡回去,不会下两遍");

{
  freshToolRoot();
  const bytes = pandocZip(PANDOC_VERSION);
  happyPandoc(bytes, sha256Hex(bytes));
  cp.resetCalls();
  resetCounts();

  const p1 = installTool("pandoc");
  check("第一次进来时这一项确实被标成「正在装」", isToolInstalling("pandoc"), true);
  const r2 = await installTool("pandoc");
  eq("第二次当场被挡回去", r2.ok, false);
  check("挡回去时给的是人能看懂的一句", /正在安装中/.test(r2.error ?? ""), r2.error);
  const r1 = await p1;
  check("第一次照常装完", r1.ok, r1);
  eq("检测缓存只失效了一次(第二次根本没走到那一步)", slot.counts.invalidate, 1);
  eq("tar 也只起了一次", cp.callsOf("tar.exe").length, 1);

  // 装完之后锁要松开,不然这一项就永久锁死了
  eq("装完之后锁是松开的", isToolInstalling("pandoc"), false);
  const r3 = await installTool("pandoc");
  check("锁松开之后再点一次仍然能装", r3.ok, r3);
}

/* ══════════════════════════════════════════════════════════════
 * 壬、删除的边界
 * ══════════════════════════════════════════════════════════════ */

section("壬、卸载:只删自己那一份,别的东西一个都不碰");

{
  const root = freshToolRoot();
  mkdirSync(join(root, "pandoc", PANDOC_VERSION), { recursive: true });
  writeFileSync(join(root, "pandoc", PANDOC_VERSION, "pandoc.exe"), "x");
  mkdirSync(join(root, "latex", "2026.09"), { recursive: true });
  // 用户手放在工具根下的东西 —— 卸载绝不该顺手带走
  mkdirSync(join(root, "我的东西"), { recursive: true });
  writeFileSync(join(root, "我的东西", "readme.txt"), "user's own");

  const res = await removeTool("pandoc");
  check("卸载成功", res.ok, res);
  check("pandoc 那一棵被删干净了", !existsSync(join(root, "pandoc")), listDir(root));
  check("latex 没被顺手删掉(卸的是「这一项」)", existsSync(join(root, "latex")), listDir(root));
  check("工具根下用户自己放的东西也没被带走", existsSync(join(root, "我的东西", "readme.txt")), listDir(root));

  // 不在自管清单里的项:一律不卸
  const r2 = await removeTool("python-deps");
  eq("python-deps 不给卸(包在用户自己的解释器里,卸错比不卸糟)", r2.ok, false);
  check("而且说的是人话", /应用不会去卸它|不是应用装的/.test(r2.error ?? ""), r2.error);
  const r3 = await removeTool("soffice");
  eq("soffice 同样不给卸", r3.ok, false);
  check("理由一样是「不是应用装的」", /应用不会去卸它|不是应用装的/.test(r3.error ?? ""), r3.error);

  // 卸完之后环境要重算(自管工具的 PATH 少了一条)
  resetCounts();
  await removeTool("latex");
  eq("卸载之后把 agent 环境重算了一遍(不然 PATH 上留着一条已经不存在的目录)", slot.counts.applyEnv, 1);
}

section("壬.2、工具根没注册时:拒绝动手,而不是落到 userData");

{
  setToolRoot(null as unknown as string);
  eq("先把根置空(模拟启动流程没走完)", getToolRoot(), null);
  const before = listDir(USER_DATA);
  const netBefore = fetchLog.length;

  const r = await removeTool("pandoc");
  eq("卸载被拒绝", r.ok, false);
  check("理由说的是根还没注册", /根目录/.test(r.error ?? ""), r.error);

  const r2 = await installTool("pandoc");
  eq("安装同样被拒绝", r2.ok, false);
  check("理由说的是根还没注册", /根目录/.test(r2.error ?? ""), r2.error);
  // ★ 这一条是本段最要紧的:拒绝如果发生在**下载之后**,用户就是白等了几百 MB 才
  //   拿到一句"根目录没注册"。`installPandoc` 里**后面**那句根检查在
  //   `downloadVerified` 之后,所以要靠它**开头**那一句先挡(见那段注释)。
  eq("还没开始下东西就拒了(不是下完几百 MB 才说根没注册)", fetchLog.length - netBefore, 0);
  // ★ latex 走的是**另一个函数**(`installLatex`),它自己也得有这一句 —— 只验 pandoc
  //   的话,latex 那边撤掉提前拒绝不会有任何断言变红(变异验证实测:120/120 全绿)。
  //   而 latex 的包比 pandoc 大得多,白等的代价更高。
  const r2b = await installTool("latex");
  eq("latex 同样被拒绝", r2b.ok, false);
  eq("latex 也是一个字节都没下就拒了", fetchLog.length - netBefore, 0);
  // ⚠️ 这里是**数组**,必须 `JSON.stringify` —— `eq` 用的是 `Object.is`,两个内容
  // 相同的数组永远是「不等」。踩过一次:读数 `{"actual":["tools"],"expected":["tools"]}`
  // 看着像成功(两边一模一样),实际是**恒红**,而恒红的断言会被当成"环境问题"跳过,
  // 于是那一条真正想守的「没落到用户真实目录」根本没人守。
  eq(
    "userData 下没有多出任何东西(没落到用户真实目录)",
    JSON.stringify(listDir(USER_DATA)),
    JSON.stringify(before),
  );

  // ★ 那道提前拒绝**必须只管得住"要往工具根里搬树"的那两项**。写歪了就成了另一种
  //   bug:python-deps 根本不碰工具根(包装进用户自己的解释器里),要是被连坐,用户
  //   会看到一句和实际原因毫无关系的"工具根目录还没注册";要管理员权限的那几项同理
  //   —— 它们该说的是"应用不代劳"。这两条是"修复不能矫枉过正"的守卫。
  setPythonForInstall("C:\\fake\\python.exe");
  const r3 = await installTool("python-deps");
  check(
    "根没注册不该连坐 python-deps(它不往工具根里放东西)",
    r3.error !== "工具根目录还没注册(应用启动流程没走完?)",
    r3,
  );
  const r4 = await installTool("zip-tools");
  eq("要管理员权限的那项照旧给的是「应用不代劳」", r4.error, "这个工具要管理员权限才能装,应用不代劳 —— 见面板上的安装指引");
  setPythonForInstall(null);

  freshToolRoot();
}

/* ══════════════════════════════════════════════════════════════
 * 壬.3、跨卷 rename:暂存盘与安装盘不是一个卷时会发生什么
 *
 * `installPandoc` / `installLatex` 那段结构是:
 *
 *     rmSync(destDir, recursive);       ← 先清掉同版本的旧的
 *     mkdirSync(root/tool);
 *     await rename(contentDir, destDir) ← 再搬进去
 *
 * 暂存在 `os.tmpdir()`(通常是 C:),落点 `getToolRoot()` 在 `<userData>` 下 ——
 * **用户完全可以把数据根配在另一个盘上**。那一刻 rename 会抛 `EXDEV`,而磁盘上
 * 的状态是:旧的已经删了、新的还没搬进来,也就是这一项彻底没了;报出来的是
 * `EXDEV: cross-device link not permitted`,用户看不懂。
 *
 * 这一段用一个开关把那个场景**明确地**造出来(而不是「看用户的盘怎么分,碰运气」)。
 * ══════════════════════════════════════════════════════════════ */

section("壬.3、暂存盘与安装盘不同卷(rename 抛 EXDEV)时会怎样");

{
  const root = freshToolRoot();
  const bytes = pandocZip(PANDOC_VERSION);
  happyPandoc(bytes, sha256Hex(bytes));
  fsStub.resetRenameCalls();
  fsStub.setForceExdev(true);
  win.resetFrames();

  const res = await installTool("pandoc");

  fsStub.setForceExdev(false);

  check("确实走到了跨目录 rename 那一步(否则这一段什么都没验到)", fsStub.renameCalls.length > 0, fsStub.renameCalls);
  check("EXDEV 时安装报失败(没有静默地当成装好了)", res.ok === false, res);
  check(
    "★ 报出来的那句话里带上了「跨盘」这个原因 —— 只丢一句 EXDEV: cross-device link 用户没法行动",
    /EXDEV|cross-device|跨/.test(res.error ?? ""),
    res.error,
  );
  check(
    "★ 而且没有留下一个「看着装过、其实空的」版本目录",
    listDir(join(root, "pandoc", PANDOC_VERSION)).length === 0,
    listDir(join(root, "pandoc", PANDOC_VERSION)),
  );
  check(
    "错误那帧推给界面了(用户得知道失败了)",
    win.toolchainEvents().some((f) => f.phase === "error"),
    win.toolchainEvents().map((f) => f.phase),
  );
  eq("暂存目录清了", tmpLeftovers("mcode-tool-pandoc-stage-").length, 0);

  // 打开开关之前的那两次 rename(如果实现了 fallback 的话)不该被算进来 —— 这里
  // 顺带把「已经打开开关了」这件事钉一下,免得这一段变成空过。
  const callsWhileOn = fsStub.renameCalls.length;
  fsStub.setForceExdev(true);
  const res2 = await installTool("pandoc");
  fsStub.setForceExdev(false);
  check("开关是可复现的(第二次同样失败)", res2.ok === false, res2);
  check("第二次也真的调了 rename", fsStub.renameCalls.length > callsWhileOn, fsStub.renameCalls.length);
}

/* ══════════════════════════════════════════════════════════════
 * 癸、latex:Windows 走自解压包;解出来必须找得到 TinyTeX 那一层
 * ══════════════════════════════════════════════════════════════ */

const TINYTEX_TAG = "v2026.09";
const TINYTEX_VERSION = "2026.09";
const TINYTEX_ASSET = `TinyTeX-windows-${TINYTEX_TAG}.exe`;
const TINYTEX_BYTES = new Uint8Array(Buffer.from("MZ fake self-extractor"));

function tinytexFetch(): void {
  installFetch((url) => {
    if (url.includes("api.github.com")) {
      return {
        json: {
          tag_name: TINYTEX_TAG,
          assets: [
            {
              name: TINYTEX_ASSET,
              size: TINYTEX_BYTES.length,
              digest: `sha256:${sha256Hex(TINYTEX_BYTES)}`,
              browser_download_url: `https://github.com/rstudio/tinytex-releases/releases/download/${TINYTEX_TAG}/${TINYTEX_ASSET}`,
            },
          ],
        },
      };
    }
    return { headers: { "content-length": String(TINYTEX_BYTES.length) }, body: TINYTEX_BYTES };
  });
}

section("癸、latex:Windows 走自解压包,TinyTeX 那一层要被剥掉");

/** `downloadVerified` 给 latex 造的临时文件名。自解压包起的就是它 —— 见癸里的说明。
 *
 *  ⚠️ 抽成常量是**必须的**,不是风格:鬼 2(`癸.2`)要拿「什么都不解」的那一支
 *  **覆盖**这一支,而 `registerPattern` 的覆盖是**按 `re.source` 认的**。两处各写
 *  一个字面量(哪怕语义一样)就是两条不同的正则 → 追加 → `routeFor` 取第一条命中
 *  → 「后面登记的那条永远轮不到」。第一版 癸.2 正是这么写的,于是它的三条断言
 *  全部绿在一个错误的形状上(还在解 TinyTeX/),而清单里那句"没找到 TinyTeX 目录"
 *  根本没被验过。 */
const LATEX_TMP_RE = /^mcode-tool-latex-.*\.download$/;

{
  const root = freshToolRoot();
  // 自解压包:在 cwd(暂存目录)里造出 TinyTeX/ 那一层 —— 官方那个 `.exe -y` 就是
  // 这么干的。这里只能模拟:真跑它 = 往用户机器上落一棵约 1GB 的真 TeX 树。
  //
  // 匹配的是**形状**不是名字:上游资产叫 `TinyTeX-windows-v<版本>.exe`,但起的
  // **不是它** —— `downloadVerified` 先把它下到
  // `mcode-tool-latex-<时间戳>.download`(自己造的临时文件,**没有 .exe 后缀**),
  // `runSelfExtractor` 起的是后者。所以只有 `.download` 这一条会被命中;
  // 另立一条 `^tinytex-windows-.*\.exe$` 是**死夹具**(登记了永远不会有人调),
  // 那会让收尾的死夹具守卫变红 —— 那条守卫是对的,别为了让它变绿而编一条假断言。
  const extractor = (args: string[], opts: unknown): cp.CmdOutcome => {
    const cwd = (opts as { cwd?: string } | undefined)?.cwd;
    if (cwd) {
      mkdirSync(join(cwd, "TinyTeX", "bin", "windows"), { recursive: true });
      writeFileSync(join(cwd, "TinyTeX", "bin", "windows", "xelatex.exe"), "x");
    }
    return { code: 0 };
  };
  cp.registerPattern(LATEX_TMP_RE, extractor);
  // tlmgr 那两条命令(补中文宏包 / 期刊文档类)。**真跑就是几百 MB 的下载**,
  // 而且它经 cmd.exe(Windows 上 tlmgr 是 .bat)。
  cp.register("cmd.exe", { code: 0, stdout: "" });
  tinytexFetch();
  win.resetFrames();
  resetCounts();

  const res = await installTool("latex");

  check("装上", res.ok, res);
  eq("版本目录用的是不带 v 的 tag", JSON.stringify(listDir(join(root, "latex"))), JSON.stringify([TINYTEX_VERSION]));
  check(
    "TinyTeX/ 那一层被剥掉了(引擎在 bin/<平台>/ 下,不是 TinyTeX/bin/...)",
    existsSync(join(root, "latex", TINYTEX_VERSION, "bin", "windows", "xelatex.exe")),
    listDir(join(root, "latex", TINYTEX_VERSION)),
  );

  // 那个临时文件叫 `mcode-tool-latex-<时间戳>.download` —— **没有 .exe 后缀**,
  // 所以只能按形状认(它也正是「上游给的是个 .exe、但我们下下来的临时文件不带后缀」
  // 这个容易看漏的地方)。
  const extractorCalls = cp.calls.filter((c) => /\.download$/.test(c.cmd) && c.stubbed);
  eq("起了自解压包(一次,not 两次)", extractorCalls.length, 1);
  eq("带的是 -y(官方脚本就是这么用的:直接解,别问)", extractorCalls[0]?.args[0], "-y");
  eq("装完把 agent 环境重算了一遍", slot.counts.applyEnv, 1);

  // 中文链那一步是**尽力而为** —— tlmgr 挂了不能把整个安装判成失败
  cp.register("cmd.exe", { code: 1, stdout: "tlmgr: 装不上" });
  const res2 = await installTool("latex");
  check("tlmgr 挂了不影响「装好了」这个结论(树在,英文文档照样能编)", res2.ok, res2);
  eq("但那一项的状态仍然如实反映「缺 ctex」由检测模块负责,不由这里伪装", res2.ok, true);
}

/** 工具根里不该出现的「过程残留」—— 下载的压缩包、自解压包、暂存目录。
 *
 *  ⚠️ **判据不能收 `.exe`**:latex 装好之后那一树里本来就有 `xelatex.exe`,收进去
 *  会恒红。要盯的是**根目录那一层**(压缩包与暂存目录都直接落在 `<userData>/tools`
 *  的兄弟位置或者工具根下),不是树里的每一个文件。 */
function noStagingLeftovers(root: string): boolean {
  return !fileTree(root).some((p) => /\.zip$|\.xz$|\.download$|stage-/.test(p));
}

section("癸.2、解出来没有 TinyTeX 那一层 → 拒绝,并把暂存删掉");

{
  const root = freshToolRoot();
  // 自解压包**什么都没解出来** —— 上游打包方式变了的样子。
  // 同一个正则**覆盖**癸那一支(见 `LATEX_TMP_RE` 的说明);`cmd.exe`(tlmgr)
  // 沿用癸里登记的那个:这条路上它不该被调到,真被调到了下面的断言会先炸。
  cp.registerPattern(LATEX_TMP_RE, () => ({ code: 0 }));
  tinytexFetch();
  win.resetFrames();

  const res = await installTool("latex");

  eq("装失败", res.ok, false);
  check("说的是「没找到 TinyTeX 目录」这类能行动的话", /TinyTeX/.test(res.error ?? ""), res.error);
  eq("工具根里没留下半棵树", listDir(join(root, "latex")).length, 0);
  eq("暂存目录也清了", tmpLeftovers("mcode-tool-latex-stage-").length, 0);
  eq("下载的临时文件也清了", tmpLeftovers("mcode-tool-latex-").length, 0);
}

/* ══════════════════════════════════════════════════════════════
 * 子、python-deps:往用户解释器里装 —— 只验「选了谁、传了哪条命令」
 * ══════════════════════════════════════════════════════════════ */

section("子、python-deps:调的是选定解释器的 pip,包名清单原样传下去");

{
  freshToolRoot();
  setPythonForInstall("C:\\fake\\python.exe");
  const pipCalls: string[][] = [];
  cp.register("python.exe", (args) => {
    pipCalls.push(args);
    return { code: 0, stdout: "Successfully installed" };
  });
  win.resetFrames();

  const res = await installTool("python-deps");
  check("装成功", res.ok, res);
  eq("只调了一次 pip", pipCalls.length, 1);
  check("走的是 -m pip install", pipCalls[0]?.[0] === "-m" && pipCalls[0]?.[1] === "pip", pipCalls[0]);
  check("包名清单原样传下去了(没漏、没自作主张加)", tc.PIP_PACKAGES.every((p) => pipCalls[0]!.includes(p)), pipCalls[0]);
  eq("选解释器只问了一次", slot.counts.pickPython, 1);
  eq("装完把环境重算了一遍(python 的路径也可能变)", slot.counts.applyEnv > 0, true);

  // 找不到 python:要报一句能让用户行动的话,而不是静默
  freshToolRoot();
  setPythonForInstall(null);
  const res2 = await installTool("python-deps");
  eq("找不到 python → 失败", res2.ok, false);
  check("而且告诉用户先去装一个", /python/i.test(res2.error ?? ""), res2.error);

  // pip 非零退出:错误里要带上 stderr 的尾巴(最有用的是尾巴不是头)
  freshToolRoot();
  setPythonForInstall("C:\\fake\\python.exe");
  cp.register("python.exe", { code: 1, stdout: "", stderr: "ERROR: No matching distribution found for markitdown" });
  const res3 = await installTool("python-deps");
  eq("pip 挂了 → 失败", res3.ok, false);
  check("错误里带上了 pip 自己那句话", /No matching distribution/.test(res3.error ?? ""), res3.error);
  cp.register("python.exe", { code: 0, stdout: "ok" });
}

/* ══════════════════════════════════════════════════════════════
 * 丑、不该装的东西
 * ══════════════════════════════════════════════════════════════ */

section("丑、要管理员权限的那几项:应用不代劳,给一句话");

{
  freshToolRoot();
  for (const id of ["zip-tools", "soffice", "pdftoppm"] as const) {
    const res = await installTool(id);
    eq(`${id} 不给装`, res.ok, false);
    check(`${id} 的拒绝理由指向面板上的指引`, /管理员权限|指引/.test(res.error ?? ""), res.error);
  }
}

/* ══════════════════════════════════════════════════════════════
 * 寅、失败之后:lastError 记下了、inFlight 松开了、重试能成
 * ══════════════════════════════════════════════════════════════ */

section("寅、失败之后状态要干净:报错留着、锁松开、重试能成");

{
  freshToolRoot();
  const bytes = pandocZip(PANDOC_VERSION);
  installFetch((url) => {
    if (url.includes("api.github.com")) return { json: pandocReleaseJson(bytes.length, sha256Hex(bytes)) };
    throw new Error("断网了");
  });

  const res = await installTool("pandoc");
  eq("先失败一次", res.ok, false);
  check("lastToolError 记下了那次的原因(面板要显示它)", lastToolError("pandoc").length > 0, lastToolError("pandoc"));
  eq("锁松开了(失败不能把这一项永久锁死)", isToolInstalling("pandoc"), false);

  const bytes2 = pandocZip(PANDOC_VERSION);
  happyPandoc(bytes2, sha256Hex(bytes2));
  const res2 = await installTool("pandoc");
  check("同一次会话里重试能装成", res2.ok, res2);
  eq("装成之后上一次的错误被清掉了(面板不该还挂着旧的红字)", lastToolError("pandoc"), "");
}

/* ══════════════════════════════════════════════════════════════
 * 卯、ipc/updater.ts:三个出口各接对了吗
 *
 * 这三个 handler 干的**唯一**一件事就是把调用转下去 —— 所以断言就立在这个「转对
 * 了没有」上:契约名对不对、参数透不透传、`await` 有没有丢、失败有没有被吞掉
 * (吞掉的话渲染端会以为成功了)。
 * ══════════════════════════════════════════════════════════════ */

section("卯、ipc/updater.ts:三个 handler 的出口");

{
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const fakeIpc = { handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never;
  registerUpdaterHandlers(fakeIpc);
  const call = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);

  eq("登记了三个 handler", handlers.size, 3);
  check(
    "注册的 channel 名就是契约里那三个",
    handlers.has("app:checkForUpdates") && handlers.has("app:downloadUpdate") && handlers.has("app:quitAndInstall"),
    [...handlers.keys()],
  );

  up.reset();
  up.record.checkResult = { status: "available", version: "9.9.9", manualInstallRequired: false };
  const out = await call("app:checkForUpdates");
  eq("checkForUpdates 被叫了一次", up.record.check.length, 1);
  eq("handler 把底层的结果原样交回去(没吞、没包一层)", JSON.stringify(out), JSON.stringify(up.record.checkResult));

  up.reset();
  await call("app:downloadUpdate");
  eq("downloadUpdate 被叫了一次", up.record.download.length, 1);

  up.reset();
  await call("app:quitAndInstall");
  eq("quitAndInstall 被叫了一次", up.record.quit.length, 1);

  // 失败必须**冒出去**:吞掉的话渲染端会以为成功了,按钮就卡在「正在下载」
  up.reset();
  up.record.downloadShouldFail = true;
  let threw = false;
  try {
    await call("app:downloadUpdate");
  } catch {
    threw = true;
  }
  check("底层抛错时 handler 不吞(吞掉 = 渲染端以为成功了,进度条永远停在 0%)", threw);

  up.reset();
  up.record.quitShouldFail = true;
  let threw2 = false;
  try {
    await call("app:quitAndInstall");
  } catch {
    threw2 = true;
  }
  check("quitAndInstall 的失败同样不吞", threw2);
  up.reset();
}

/* ══════════════════════════════════════════════════════════════
 * 辰、`checkForUpdates` 那个 source 形参:有没有人真的传过它
 * ══════════════════════════════════════════════════════════════ */

section("辰、checkForUpdates 的 source 参数");

{
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const fakeIpc = { handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never;
  registerUpdaterHandlers(fakeIpc);
  up.reset();

  await handlers.get("app:checkForUpdates")!(null);

  const args = up.record.check[0]?.args ?? [];
  check(
    "★ handler 传了 source —— 不传的话「后台发现」和「用户点的」在界面这侧永远分不开",
    args.length === 1 && args[0] === "manual",
    args,
  );
  check(
    "传的是 manual(这条入口是面板按钮,不是开机/定时的后台检查)—— 传错会让通知卡片该弹的不弹",
    args[0] === "manual",
    args,
  );
}

/* ══════════════════════════════════════════════════════════════
 * 收尾
 * ══════════════════════════════════════════════════════════════ */

section("收尾");

{
  const dead = cp.unfiredRoutes();
  check("没有「登记了却一次没被命中」的死夹具(那些断言会全绿而什么都没验)", dead.length === 0, dead);
  check("整场跑完都没人往用户真实目录写过东西", !existsSync(join(USER_DATA, "bin")), listDir(USER_DATA));
}

console.log(`\nupdater-tools-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
