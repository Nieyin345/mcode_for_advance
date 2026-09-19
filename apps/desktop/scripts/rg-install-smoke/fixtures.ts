/**
 * 本套用的夹具:一个只会在期望 url 上应答、而且**写一次就用掉**的 HTTP 服务器,
 * 外加三种"下下来到底是什么"的字节。
 *
 * ## 为什么不是通用 web 服务器
 *
 * 被测的 `downloadArchive` 会**按顺序**试三条 URL(GitHub 官方 + 两个国内镜像),
 * 第一条失败才换下一条 —— 这是这个模块的核心行为之一,而**只有第一条真的失败**才能
 * 观察到它。所以服务器需要能分别控制"某个 url 返回什么"。这里用**每套场景一张
 * 路由表**:`routeFor()` 给不出答案的路径一律 404(而不是默默给一个健康响应),
 * 外加一个 `hits` 计数 —— "第一条到底被请求过几次"是可断言的。
 *
 * 服务器**串行处理**(一次只应一个请求),这样"一个场景=一个一次性响应"没有竞态。
 */
import { createServer, type Server } from "node:http";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";

export interface Route {
  status?: number;
  body?: Buffer;
  contentType?: string;
  /** 写多少字节之后**掐断连接**(模拟下到一半断流)。不设就写完。 */
  cutAfter?: number;
  /** 掐断前的等待(毫秒)—— 给"下载超时"那类场景留出观察窗口。 */
  delayMs?: number;
  /** 连响应头都不发,直接挂着(模拟"接了连接就再也不出声")。 */
  hang?: boolean;
  /** 只在**第一次**命中时 `hang`,之后每次都正常回 `body` —— 用来造"第一条镜像挂住、
   *  第二条顶上"的现场,而不必等两遍超时。 */
  hangOnce?: boolean;
}

export interface HitRecord {
  url: string;
  /** 服务器实际吐出去的字节数(response 的 content-length 另算,这里按真实写入算)。 */
  sent: number;
  cut: boolean;
}

/** 一份**成员名是中文、而且解压必然失败**的 zip —— 用来把 tar 那半句话按它真实的
 *  编码(ANSI/GBK)逼出来。
 *
 *  ## 为什么需要它
 *
 *  `runTar` 里那句「tar 的 stderr 不能按 UTF-8 解」是这套的一个真修复,但要**证明**它,
 *  就得让 tar 吐出一段非 UTF-8 的字节。造了两条路都不行:
 *
 *   - **中文安装根 / 中文目标目录**:本机实测根本不产生错误(bsdtar 是从 UTF-16 的
 *     `-C` 参数顺顺利利建出中文目录的),那条路只会在别的机器上才红;
 *   - **`Cannot connect to C: resolve failed`**(GNU tar 把路径当远端主机):那行是纯
 *     ASCII —— 它连中文都没打出来。
 *
 *  能完全由夹具控制、而且**确实**会吐非 UTF-8 的那一半是**成员名**:bsdtar 把成员名按
 *  控制台代码页(中文机 = CP936/GBK)写进 stderr。实测:`中文/../../../逃逸.txt` 这一条
 *  在 `Path contains '..'` 上失败,而名字那一段的原始字节就是 `d6 d0 ce c4 …`(GBK)。
 *  所以"解压必然失败"用路径穿越(bsdtar 故意拦它),而不是靠一个坏归档 —— 后者在
 *  Windows 上永远打英文。
 *
 *  ⚠️ 名字要带 UTF-8 标志位(`utf8: true`):不带时 bsdtar 会先按某个代码页转一道,
 *  出来的字节连 GBK 也解不回来,就没有"正确解码"可言了(实测过)。
 */
export function archiveWithChineseNames(): Buffer {
  return writeZip([
    {
      name: "中文目录/../../../逃逸.txt",
      data: Buffer.from("x".repeat(20)),
      utf8: true,
    },
  ]);
}

/** 一个"安装临时目录**建不出来**"的现场:在 `<installRoot>/rg-install-tmp` 那个位置
 *  先放一个**文件**。
 *
 *  现实版本:上一次安装被打断(或被杀进程)之后留下的半截东西,恰好在那个名字上。
 *  这时 `mkdirSync(tmpRoot, { recursive: true })` 抛 `EEXIST`,而它在 `doInstall` 里
 *  站在 `try` **外面** —— 于是那句话会原样冒到界面:「EEXIST: file already exists,
 *  mkdir 'C:\Users\<用户名>\AppData\Roaming\Mcode\rg-install-tmp'」。 */
export function blockTmpRoot(installRoot: string): string {
  const p = join(installRoot, "rg-install-tmp");
  rmSync(p, { recursive: true, force: true });
  writeFileSync(p, "上一次安装留下的半截文件\n");
  return p;
}

/** 一个"下下来是完整的字节、但落点写不进去"的现场:让 `dest.part` 那个位置**已经是个
 *  目录**。
 *
 *  ⚠️ 为什么不是把临时目录设成只读(更自然的"磁盘写不进去"):实测 `icacls` 只改 ACL 对
 *  **管理员**账户无效(管理员绕过目录的写保护),那是环境差异,不是被测行为。而
 *  "`.part` 位置上已经是个目录"是 `createWriteStream` **必然**拿 `EISDIR` 的落点,与
 *  本机是谁在跑无关。用户侧的现实版本是:上一次安装被打断留下了半截目录,或者同步盘 /
 *  安全软件在里面占了个同名目录。
 */
export function blockPartPath(archivePath: string): string {
  const part = `${archivePath}.part`;
  rmSync(part, { recursive: true, force: true });
  mkdirSync(part, { recursive: true });
  return part;
}

/**
 * 起一个只在 127.0.0.1 上听的夹具服务器。
 *
 * `resolve(url)` 返回 `undefined` 表示"这个路径我不认识" → 404。返回一个 `Route`
 * 就照它应答,并且**记录一次命中**。同一个 path 只应答一次:
 */
export async function startAssetServer(
  resolve: (pathname: string) => Route | undefined,
): Promise<{
  port: number;
  hits: HitRecord[];
  hitsFor: (pathname: string) => number;
  stop: () => Promise<void>;
}> {
  const hits: HitRecord[] = [];
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const route = resolve(pathname);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    if (route.hang) {
      hits.push({ url: pathname, sent: 0, cut: true });
      return; // 永不响应
    }
    if (route.hangOnce && hits.filter((h) => h.url === pathname).length === 0) {
      hits.push({ url: pathname, sent: 0, cut: true });
      return; // 第一次挂住,后面照常应答
    }
    const body = route.body ?? Buffer.alloc(0);
    res.writeHead(route.status ?? 200, {
      "content-type": route.contentType ?? "application/octet-stream",
      // content-length 按**完整**长度声明:断流场景下 undici 会因为少读而报错,
      // 这正是"下到一半断了"在客户端的样子。
      "content-length": String(body.length),
    });
    const record: HitRecord = { url: pathname, sent: 0, cut: false };
    hits.push(record);
    const finish = (): void => {
      if (res.writableEnded) return;
      res.end();
    };
    if (route.cutAfter !== undefined) {
      const write = Math.min(route.cutAfter, body.length);
      res.write(body.subarray(0, write));
      record.sent = write;
      record.cut = true;
      const kill = (): void => {
        res.socket?.destroy();
      };
      if (route.delayMs) setTimeout(kill, route.delayMs);
      else kill();
      return;
    }
    if (route.delayMs) {
      setTimeout(() => {
        record.sent = body.length;
        finish();
      }, route.delayMs);
      return;
    }
    record.sent = body.length;
    res.end(body);
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("夹具服务器没拿到端口");
  return {
    port: addr.port,
    hits,
    hitsFor: (pathname) => hits.filter((h) => h.url === pathname).length,
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** 一个"服务器说 200、内容是 HTML"的字节串 —— 国内镜像被墙时常见的就是这个。 */
export function htmlErrorPage(): Buffer {
  return Buffer.from(
    "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head>" +
      "<body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>\n",
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 *  把三条**真的**下载 URL 接到夹具服务器上
 *
 *  被测的 `DOWNLOAD_URLS` 是产品里那张真的表(GitHub 官方 + ghfast.top +
 *  ghproxy.net),本套不动它 —— 换掉的是**出口**:这里给 `globalThis.fetch` 套一层,
 *  按**主机名**把请求改写到 127.0.0.1 上那台夹具服务器,路径里保留主机名与文件名。
 *
 *  这样"先试哪条、失败后换哪条、换了几次"全是真的行为,而没有任何一个字节出网。
 *  (等价于改 hosts 文件,只是不用管理员权限。)
 *
 *  ⚠️ 认不出来的 github URL **直接抛**,不回落到真网络:哪天有人把产品里那条下载换成
 *  了别的 transport,这套要当场显形,而不是安静地去真的下载 ripgrep。
 * ══════════════════════════════════════════════════════════════════════════ */

let redirectTo: { port: number } | null = null;
/** 按顺序记下每一次**产品发起的**(改写前)下载 URL —— 用它断"哪条镜像被试过"。 */
const requested: string[] = [];

/** 开始把下载请求接到 `port` 上。传 null 关掉(关掉后任何下载都会抛)。 */
export function redirectDownloadsTo(port: number | null): void {
  redirectTo = port === null ? null : { port };
}

export function clearRequests(): void {
  requested.length = 0;
}

/** 产品请求过的原始 URL(改写前),按顺序。 */
export function requestedUrls(): string[] {
  return requested.slice();
}

/** 把一条真 URL 映射到夹具服务器的路径。`null` = 认不出来(要显式抛)。 */
export function mapDownloadUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const fileName = u.pathname.split("/").filter(Boolean).pop() ?? "";
  const host = u.hostname.toLowerCase();
  if (host === "github.com") return `/github/${fileName}`;
  if (host === "ghfast.top") return `/ghfast/${fileName}`;
  if (host === "ghproxy.net") return `/ghproxy/${fileName}`;
  return null;
}

/** 装上改写层。**只装一次**,装在 main.ts 的最前面。 */
export function installFetchRedirect(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    const raw = typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    requested.push(raw);
    if (redirectTo === null) {
      throw new Error(`rg-install-smoke: 没有开夹具服务器就去下载了(${raw})—— 本套绝不出网`);
    }
    const mapped = mapDownloadUrl(raw);
    if (mapped === null) {
      throw new Error(`rg-install-smoke: 认不出的下载 URL(${raw})—— 本套绝不出网`);
    }
    const local = `http://127.0.0.1:${redirectTo.port}${mapped}`;
    return realFetch(local, init as never);
  }) as typeof fetch;
}

/* ══════════════════════════════════════════════════════════════════════════
 *  最小的 zip / tar.gz 写出器
 *
 *  ⚠️ 为什么自己写,而不用系统 zip:Windows 上**没有** zip(不是 tar),
 *  而 GNU tar 更不认 zip(它没有 zlib)。这套要跑在 Windows 上,夹具就得自带。
 *  zip 只在无压缩(stored)下写,几十行就够,也不需要任何依赖。
 * ══════════════════════════════════════════════════════════════════════════ */

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

const DOS_DATE = 0x0021; // 1980-01-01,任定

export function writeZip(entries: Array<{ name: string; data: Buffer; utf8?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    // bit 11 = "名字是 UTF-8"。**只有名字里真有非 ASCII 时才该置**,而 bsdtar 对置了位
    // 与没置位的处理**不一样**(实测:没置位时它先按某个代码页转一道,出来的字节连 GBK
    // 也解不回来)。夹具里造中文成员名时靠它拿到干净的 GBK 字节,见
    // `archiveWithChineseNames`。
    const flags = e.utf8 ? 0x0800 : 0;
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(flags, 6); // flags
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt16LE(DOS_DATE, 10);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, e.data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_DATE, 12);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const TAR_BLOCK = 512;

function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(TAR_BLOCK);
  const put = (s: string, off: number, len: number): void => {
    h.write(s.slice(0, len), off, len, "utf8");
  };
  put(name, 0, 100);
  put("000644 \0", 100, 8); // mode
  put("000000 \0", 108, 8); // uid
  put("000000 \0", 116, 8); // gid
  put(`${size.toString(8).padStart(11, "0")} `, 124, 12); // size(八进制)
  put(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")} `, 136, 12);
  put("        ", 148, 8); // checksum 占位(先填空格)
  h.write("0", 156, 1); // typeflag: regular file
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

/** 造一个**未压缩**的 tar(uctypeflag 之外的写全)。tgz 那一支要再用 gzip 压它。 */
export function writeTar(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(tarHeader(e.name, e.data.length), e.data);
    const pad = (TAR_BLOCK - (e.data.length % TAR_BLOCK)) % TAR_BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(TAR_BLOCK * 2)); // 结尾两个全零块
  return Buffer.concat(parts);
}

/** 把 tar 压成 tar.gz。用 node 自带的 zlib,同样不需要外部依赖。 */
export function writeTarGz(entries: Array<{ name: string; data: Buffer }>): Buffer {
  return gzipSync(writeTar(entries));
}

/* ══════════════════════════════════════════════════════════════════════════
 *  "真的跑得起来"的 rg 替身
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 造一个**存在、但不产 `--version` 输出**的可执行夹具 —— 走"下载的 ripgrep 无法
 * 运行"那一条。
 *
 * 为什么要复制 node 自己、而不是塞一段文本当 `rg.exe`:文本文件在 Windows 上 spawn
 * 的报错是 `spawn UNKNOWN`(errno 不在 `verifyRg` 的 `error` 分支白名单里),那只是
 * "这不是个可执行格式",和"它是个 exe 但不是我"是两回事 —— 后者才是这条要覆盖的。
 * node 的 `--version` 输出里**没有** `ripgrep`,于是 `verifyRg` 判它不可用,而 spawn
 * 本身是成功的。
 */
export function buildUnrunnableRgFixture(outFile: string): boolean {
  try {
    copyFileSync(process.execPath, outFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * 编译一个最小但**真的可执行**的 `rg.exe` 夹具。
 *
 * ## 为什么必须真的编译一个,而不是塞一个假文件
 *
 * `doInstall()` 在采纳下载物之前会 `verifyRg()` —— 真的 spawn 它、要求 `--version`
 * 退出码 0 且输出里有 `ripgrep`。所以:
 *
 *  - 用一段文本当 `rg.exe`:文件**存在**,于是"解压后没找到二进制"那一支**不会**被
 *    命中(它只查文件名和 size > 0)—— 那条断言会变成自证;
 *  - 而"下载的 ripgrep 无法运行"这一支**必会**命中,于是"装成功"那条路根本走不到。
 *
 * 所以"装成功"和"解压出来没有二进制"这两条要分开验:前者需要一个真能跑的可执行文件,
 * 后者用一份**故意不含**该文件名(但含别的文件)的归档。
 *
 * Windows 上用 .NET Framework 自带的 csc.exe 编译(凡装过 .NET 4.x 的机器都有,
 * Windows 10/11 自带);没有 csc 时回退到**把 node 自己复制一份** —— node 的可执行
 * 文件当然能跑,而且它的 `--version` 输出里刚好**不含** `ripgrep`(于是它自然充当
 * "能跑但不是 ripgrep"的负夹具,见 `verifyRg` 那两条)。
 *
 * 非 Windows 上不编译,直接返回 null:本套的 zip 夹具是 Windows 版资产,而在
 * Linux/macOS 上被测代码走的是 tgz 那一条(`assetFor()` 按 `process.platform` 分支)。
 */
export function buildRgFixture(outFile: string): boolean {
  if (process.platform !== "win32") return false;
  const csc = [
    `${process.env.SystemRoot ?? "C:\\Windows"}\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe`,
    `${process.env.SystemRoot ?? "C:\\Windows"}\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe`,
  ].find((p) => existsSync(p));
  if (csc) {
    const src = `${outFile}.cs`;
    writeFileSync(
      src,
      'public class RgFixture {\n' +
        '  public static int Main(string[] args) {\n' +
        '    System.Console.Out.Write("ripgrep 14.1.1 (smoke fixture)\\n");\n' +
        "    return 0;\n" +
        "  }\n" +
        "}\n",
      "utf8",
    );
    const r = spawnSync(csc, ["-nologo", `-out:${outFile}`, src], { windowsHide: true });
    if (r.status === 0 && existsSync(outFile)) return true;
    // 编译不出来就往下走 node 那条路 —— 别让"夹具造不出来"变成"套件红"。
  }
  try {
    copyFileSync(process.execPath, outFile);
    return true;
  } catch {
    return false;
  }
}
