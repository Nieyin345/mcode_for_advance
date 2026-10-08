/**
 * One-click ripgrep install for machines where `rg` isn't on PATH.
 *
 * The file/grep IPC handlers prefer ripgrep and silently degrade to the
 * in-process scanners when it's missing — fine functionally, but slow on big
 * repos. The search dialog surfaces that gap via `rg.status` and offers this
 * install: we download the official release binary (pinned version, with a
 * couple of China-friendly GitHub mirrors tried in order) into
 * `userData/bin`, extract it, verify it runs, and reset the rg resolution
 * cache so subsequent searches pick it up immediately.
 *
 * Extraction uses the system `tar` (System32's bsdtar on Windows/macOS handles
 * zip and tar.gz; GNU tar on Linux handles tar.gz) — the same approach the Java
 * LSP installer uses, so no new decompression dependency.
 *
 * ⚠️ Windows: the tar must be pinned to `System32\bsdtar`. PATH very often
 * surfaces a Git Bash / MSYS **GNU** tar first, and GNU tar can't read zip at
 * all (no zlib) — it also reads `C:\...` as a remote `host:file` target and
 * dies with "Cannot connect to C: resolve failed". Spawning a bare `tar.exe`
 * is therefore a coin flip, and losing that flip is what the user sees as
 * 「解压失败」on the one platform where the zip asset is the only asset.
 * Same pin as `lib/…/toolInstall.ts` and `plugins/pluginManager.ts`.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  createWriteStream,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app } from "electron";
import { join } from "node:path";
import { bundledRgPath, resetRgCache } from "@main/lib/rgSearch.js";
import { OutBuf } from "@main/lib/outBuf.js";
import { log } from "@main/lib/logger.js";
import { isTarRemoteHostFailure } from "@main/lib/tarHostWorkaround.js";

/** Pinned ripgrep release. Kept exact (no ranges) so the download URL stays
 *  deterministic; bump here to update. 14.1.1 is the latest stable. */
const RG_VERSION = "14.1.1";
const RG_RELEASE_BASE = "https://github.com/BurntSushi/ripgrep/releases/download";

interface RgAsset {
  fileName: string;
  kind: "zip" | "tgz";
}

function assetFor(): RgAsset {
  if (process.platform === "win32") {
    return { fileName: `ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`, kind: "zip" };
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? { fileName: `ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`, kind: "tgz" }
      : { fileName: `ripgrep-${RG_VERSION}-x86_64-apple-darwin.tar.gz`, kind: "tgz" };
  }
  return process.arch === "arm64"
    ? { fileName: `ripgrep-${RG_VERSION}-aarch64-unknown-linux-musl.tar.gz`, kind: "tgz" }
    : { fileName: `ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`, kind: "tgz" };
}

/** Download URL chain: GitHub official first, then common China mirrors
 *  (GitHub releases are frequently slow/blocked from CN networks). The first
 *  URL that yields a complete download wins. */
const DOWNLOAD_URLS: Array<(fileName: string) => string> = [
  (f) => `${RG_RELEASE_BASE}/${RG_VERSION}/${f}`,
  (f) => `https://ghfast.top/${RG_RELEASE_BASE}/${RG_VERSION}/${f}`,
  (f) => `https://ghproxy.net/${RG_RELEASE_BASE}/${RG_VERSION}/${f}`,
];

/** Per-download wall-clock cap, well above any healthy transfer. */
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** Stall guard: give up when no NEW byte has arrived for this long. The mirrors
 *  in `DOWNLOAD_URLS` sometimes accept the connection and then stop sending —
 *  without this, the user waits out the full wall-clock cap (three minutes)
 *  before we even try the next URL. Mirrors the toolchain installer's guard. */
const STALL_TIMEOUT_MS = 30_000;

export interface RgInstallResult {
  ok: boolean;
  error?: string;
  path?: string;
}

let installInFlight: Promise<RgInstallResult> | null = null;

/** True while an install is running (mirrored to the renderer via rg.status). */
export function isRgInstalling(): boolean {
  return installInFlight !== null;
}

/** Kick off a one-click install. Concurrent calls share the same in-flight
 *  promise instead of downloading twice. */
export function installRg(): Promise<RgInstallResult> {
  if (!installInFlight) {
    installInFlight = doInstall().finally(() => {
      installInFlight = null;
    });
  }
  return installInFlight;
}

async function doInstall(): Promise<RgInstallResult> {
  const binDir = app.getPath("userData");
  const target = bundledRgPath();
  if (existsSync(target)) {
    return { ok: true, path: target }; // already installed (e.g. race)
  }
  const asset = assetFor();
  const tmpRoot = join(binDir, "rg-install-tmp");
  const archivePath = join(tmpRoot, asset.fileName);
  const extractDir = join(tmpRoot, "x");
  try {
    // ⚠️ 建临时目录这一步必须在 `try` **里面**。它站在外面时,`mkdirSync` 的 errno 会
    // 原样冒到界面 —— 用户看到的是
    // 「EEXIST: file already exists, mkdir 'C:\Users\<名>\AppData\Roaming\Mcode\rg-install-tmp'」,
    // 而真实原因是"上一次安装被打断,在那个名字上留下了一个文件"。`finally` 里的清理
    // 已经能处理"什么都没建出来"的情况,所以挪进来没有副作用。
    mkdirSync(tmpRoot, { recursive: true });
    rmSync(extractDir, { recursive: true, force: true });
    await downloadArchive(archivePath, asset.fileName, DOWNLOAD_URLS);
    mkdirSync(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir, asset.kind);

    const found = await findBinary(extractDir, process.platform === "win32" ? "rg.exe" : "rg");
    if (!found) {
      return { ok: false, error: "解压后未找到 rg 二进制" };
    }

    // Verify the extracted binary actually runs before adopting it.
    const why = await verifyRg(found);
    if (why) {
      return { ok: false, error: why };
    }

    mkdirSync(join(binDir, "bin"), { recursive: true });
    renameSync(found, target);
    if (process.platform !== "win32") {
      try {
        chmodSync(target, 0o755);
      } catch {
        // chmod failure is cosmetic on most setups — keep going.
      }
    }
    resetRgCache();
    log.info(`rg installed: ${target}`);
    return { ok: true, path: target };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`rg install failed: ${msg}`);
    // ⚠️ The message goes through UNCHANGED. The two callers both wrap it in
    // their own 「安装失败:{error}」 copy (`useRgStatus` → the search dialog's
    // banner, and `ipc/rg.ts` for the thrown case), so prefixing it here would
    // render as 「安装失败:安装失败:…」. What this layer owes them is a message
    // that READS well once wrapped — hence `describeDownloadErr` /
    // `describeExtractErr` above, not a prefix.
    //
    // The download already comes back described (`downloadArchive` wraps its own
    // failure); everything else here is a native fs error whose default text is
    // an errno heap, so it goes through `describePrepErr` on the way out.
    const friendly = /^(下载失败|解压失败)/.test(msg)
      ? msg
      : describePrepErr(err instanceof Error ? err : new Error(msg));
    return { ok: false, error: friendly };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/** Try each mirror in order, keeping the FIRST failure's description. Later
 *  mirrors (the CN proxies) usually fail with a less informative error than the
 *  official URL, so reporting the last one would explain the download by its
 *  least useful symptom. */
async function downloadArchive(dest: string, fileName: string, urls: Array<(f: string) => string>): Promise<void> {
  // ⚠️ The idle guard's AbortController must live here, not inside
  // `downloadToFile`: a controller that timed out on mirror #1 stays aborted
  // forever, so a fresh one per attempt is what makes "try the next mirror"
  // actually work (its own watchdog only starts once headers arrive).
  const firstErr: Array<Error | null> = [];
  for (const build of urls) {
    const stall = new AbortController();
    try {
      await downloadToFile(build(fileName), dest, stall);
      return;
    } catch (err) {
      firstErr.push(err instanceof Error ? err : new Error(String(err)));
      rmSync(dest, { force: true });
    }
  }
  throw new Error(`下载失败:${describeDownloadErr(firstErr[0] ?? null)}`);
}

/** Turn a failure from preparing the install area into one user-facing line.
 *
 *  These are plain native fs errors (no `cause` wrapper), and their default text
 *  is an errno heap with a full user path in it — unreadable in a one-line
 *  banner. `describeDownloadErr` already knows the interesting codes; the only
 *  thing this adds is the EEXIST case, which cannot arise during a download
 *  (a `.part` collision is EISDIR) but is the common one for "上一次安装留下了
 *  半截东西". */
function describePrepErr(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EEXIST") return "安装目录里有一个同名的残留文件,删掉后重试";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return `无法写入安装目录(${code})`;
  }
  if (code === "ENOSPC") return "磁盘空间不足,写不下安装文件";
  return describeDownloadErr(err);
}

/** Turn a fetch/write failure into one user-facing line.
 *
 *  `fetch` reports almost everything as `TypeError: fetch failed` (or the bare
 *  `terminated` for a cut connection); the actionable part lives in `cause`.
 *  Handing the user the raw message is the difference between 「下载失败:fetch
 *  failed」 and something they can act on. None of these strings carry a URL —
 *  the three mirrors are an implementation detail and dumping them into a
 *  one-line notice is unreadable. */
function describeDownloadErr(err: Error | null): string {
  if (!err) return "未知错误";
  if (err.name === "TimeoutError" || err.name === "AbortError") {
    return `下载超时(${Math.round(DOWNLOAD_TIMEOUT_MS / 1000)} 秒)`;
  }
  // Native fs errors (`EISDIR` / `ENOSPC` / `EACCES` …) reach here straight from
  // the write stream — no `cause` wrapper — so check the error itself too.
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOSPC") return "磁盘空间不足,写不下安装文件";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "EISDIR") {
    return `无法写入安装目录(${code})`;
  }
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (cause) {
    if (cause.code === "ENOTFOUND" || cause.code === "EAI_AGAIN") return "连不上下载服务器(域名解析失败)";
    // A mirror that accepts the connection and then drops it mid-body surfaces as
    // `terminated` / `other side closed` — the most common failure of all.
    if (cause.code === "ECONNREFUSED" || cause.code === "ECONNRESET" || cause.code === "UND_ERR_SOCKET") {
      return cause.code === "ECONNREFUSED" ? "下载服务器拒绝连接" : "下载连接被中断";
    }
    if (cause.code === "UND_ERR_CONNECT_TIMEOUT") return "连不上下载服务器(连接超时)";
    if (cause.code === "UND_ERR_HEADERS_TIMEOUT" || cause.code === "UND_ERR_BODY_TIMEOUT") {
      return "下载服务器一直没有回应";
    }
    if (cause.code === "ERR_SSL_WRONG_VERSION_NUMBER" || cause.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
      return "下载连接不安全(证书校验失败),可能是网络被劫持";
    }
    // ⚠️ **不要把 `cause.message` 原样交出去。** 它是 undici 的内部短语
    // (`Connect Timeout Error` / `Headers Timeout Error` / `other side closed`),
    // 而这条字符串最终会长成
    // 「安装失败:下载失败:Connect Timeout Error」—— 中文界面里夹一句英文 jargon,
    // 正是这个仓库那类「不合理、不专业」的 bug。上面没认出来的码一律落到下面那句
    // 人话;真要查细节,`log.warn` 里那条原始 message 还在。
  }
  // `fetch` 没有 cause 时只给一句 `fetch failed`(同样是英文)。它在中文界面里
  // 等于什么都没说,所以也换掉 —— 兜底那句至少告诉用户"是网络,不是软件坏了"。
  if (/^fetch failed$/i.test(err.message)) return "连不上下载服务器(网络请求失败)";
  return err.message || err.name;
}

/** Stream `url` into `dest` (written via a `.part` sibling then renamed).
 *  Uses global fetch + AbortSignal.timeout; follows redirects automatically
 *  (GitHub release URLs 302 to the CDN).
 *
 *  ⚠️ The write goes through `stream.pipeline`. Doing it by hand (`reader.read()`
 *  + `ws.write()`) has a nasty failure mode: `createWriteStream` fires its own
 *  `error` event when the file can't be written (disk full, read-only or
 *  AV-locked temp dir), and with no `error` listener Node both **crashes the
 *  process** and leaves the loop waiting on a `drain` that never comes — the
 *  install then hangs forever while `isRgInstalling()` stays true, so the dialog
 *  shows 「下载安装中…」until the app is restarted. `pipeline` tears the reader
 *  down and rejects, which is what the per-mirror retry above is written for. */
async function downloadToFile(url: string, dest: string, stall: AbortController): Promise<void> {
  const part = `${dest}.part`;
  // Idle guard: fetch's own signal only bounds the WHOLE transfer, so a mirror
  // that connects and then goes silent would hold the install for three minutes
  // (and the two remaining mirrors would never even be tried). Count **bytes**
  // instead of time so a slow-but-alive mirror is fine. `AbortSignal.any`
  // (Node 20+) lets both the wall-clock cap and the idle guard share one signal,
  // so the transfer itself is torn down — not just our reader loop.
  let stallTimer: NodeJS.Timeout | undefined;
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => stall.abort(new Error("下载卡住")),
      STALL_TIMEOUT_MS,
    );
  };
  // Armed BEFORE the request: "no new byte for 30s" has to cover the case where
  // the mirror accepts the connection and then never sends anything at all —
  // that is exactly the shape the CN proxies fail in, and it is the one where
  // the user stares at 「下载安装中…」 the longest.
  armStall();
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), stall.signal]),
    });
  } catch (err) {
    if (stall.signal.aborted) throw new Error(`下载卡住(${Math.round(STALL_TIMEOUT_MS / 1000)} 秒没有新数据)`);
    throw err;
  }
  if (!res.ok || !res.body) {
    throw new Error(`下载服务器返回了 HTTP ${res.status}(文件可能不存在,或镜像被限制)`);
  }
  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          armStall();
          yield chunk;
        }
      },
      createWriteStream(part),
      { signal: stall.signal },
    );
  } catch (err) {
    // 卡住时 pipeline 报的是那个 abort 的 reason;把它包成一句人话。
    if (stall.signal.aborted) throw new Error(`下载卡住(${Math.round(STALL_TIMEOUT_MS / 1000)} 秒没有新数据)`);
    throw err;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
  renameSync(part, dest);
}

/** Which tar to drive. Windows is pinned to the system bsdtar on purpose — see
 *  the file header. macOS ships bsdtar at /usr/bin/tar (handles both kinds);
 *  Linux distro tars vary, so PATH is right there. */
function systemTar(): string {
  if (process.platform === "win32") {
    const p = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
    return existsSync(p) ? p : "tar.exe";
  }
  return "tar";
}

/** Extract with the system tar: bsdtar (Windows/macOS) handles zip AND
 *  tar.gz; GNU tar (Linux) handles tar.gz. */
function extractArchive(archivePath: string, destDir: string, kind: "zip" | "tgz"): Promise<void> {
  return runTar(archivePath, destDir, kind).then(
    () => undefined,
    (err: Error) => {
      // A PATH tar that is GNU tar rejects the Windows path before it even looks
      // at the archive. `--force-local` is GNU's own opt-in for colon paths (a
      // healthy bsdtar never needs it), so retry once before giving up.
      // 判据是共享的(见 tarHostWorkaround.ts,pluginManager 那条解压路也用它)。
      if (!isTarRemoteHostFailure(err.message)) throw err;
      return runTar(archivePath, destDir, kind, true).then(() => undefined);
    },
  );
}

/** 解压的上限。ripgrep 的包只有几 MB,正常一两秒完事 —— 两分钟只为兜住
 *  "卡死"这一种情形,不是给慢机器留余量。 */
const TAR_TIMEOUT_MS = 120_000;

/** 「跑一下 --version 看它是不是真能用」的上限。 */
const VERIFY_TIMEOUT_MS = 15_000;

function runTar(archivePath: string, destDir: string, kind: "zip" | "tgz", forceLocal = false): Promise<void> {
  const args = kind === "zip" ? ["-xf", archivePath, "-C", destDir] : ["-xzf", archivePath, "-C", destDir];
  if (forceLocal) args.unshift("--force-local");
  return new Promise((resolveP, rejectP) => {
    const p = spawn(systemTar(), args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // ⚠️ tar's own stderr is NOT UTF-8 on a Chinese Windows: GNU tar (the one on
    // PATH under Git Bash) prints its half-line of Chinese in the console code
    // page (GBK), so decoding it as UTF-8 yields 「\uFFFD\uFFFD\uFFFD tar」 — a
    // line with no information in it at all. That is what `OutBuf` is for — it
    // runs every chunk through the repo's one correct decoder (strict UTF-8
    // first, GBK as the fallback), see `lib/outBuf.ts`.
    const errBuf = new OutBuf(8 * 1024);
    p.stderr?.on("data", (c: Buffer) => errBuf.push(c));
    // ⏱ **没有超时的话,tar 卡住就是永远卡住** —— 这个 promise 是安装流程唯一的
    // 出口,不 settle 的表现是对话框停在「安装中」,既不报错也不让重试,用户只能
    // 杀掉整个应用。同文件里 execFile 那几处一律带 timeout,这里是漏的。
    const timer = setTimeout(() => {
      p.kill();
      rejectP(new Error(`解压超时(超过 ${Math.round(TAR_TIMEOUT_MS / 1000)} 秒),压缩包可能损坏;请重试或手动安装`));
    }, TAR_TIMEOUT_MS);
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    p.on("error", (err) => settle(() => rejectP(err)));
    p.on("exit", (code) => settle(() => {
      if (code === 0) {
        resolveP();
        return;
      }
      rejectP(new Error(describeExtractErr(archivePath, code, errBuf.text())));
    }));
  });
}

/** Turn a failed tar run into a line the user can act on. tar's own output is
 *  the tail (it is where the reason lives) but on its own it says nothing about
 *  WHAT was being extracted — and the single most common cause here is a mirror
 *  answering with an HTML error page, which tar reports as the useless
 *  「This does not look like a tar archive」.
 *
 *  The hint is keyed on the archive's **size**, not on a magic-byte sniff:
 *  the real release archives are several MB, and every failure mode that lands
 *  here (HTML error page, JSON rate-limit body, an empty 302 body) is tiny. */
function describeExtractErr(archivePath: string, code: number | null, rawErr: string): string {
  const tail = rawErr.replace(/\s+/g, " ").trim().slice(0, 200);
  let hint = "";
  try {
    if (statSync(archivePath).size < 64 * 1024) {
      hint = "(下载到的文件不是一个有效的压缩包,可能是镜像返回了错误页面)";
    }
  } catch {
    hint = "(下载到的文件已不存在)";
  }
  const kindWord = archivePath.endsWith(".zip") ? "不是有效的 zip" : "不是有效的 tar.gz";
  return `解压失败:下载到的文件${kindWord}${hint}${tail ? `(tar: ${tail})` : `(tar 退出码 ${code})`}`;
}

/** Walk the extracted tree for a file named exactly `name` (the release
 *  archives nest the binary under a `ripgrep-<version>-<target>/` dir). */
async function findBinary(dir: string, name: string): Promise<string | null> {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await findBinary(full, name);
      if (hit) return hit;
    } else if (e.name === name && statSync(full).size > 0) {
      return full;
    }
  }
  return null;
}

/** Run the freshly extracted binary once to make sure it actually works before
 *  adopting it. Returns a reason string on failure, null when it is good.
 *
 *  ⚠️ This reports back through `doInstall`'s error field, and that field is
 *  rendered verbatim in the dialog (「安装失败:{error}」), so it must be a
 *  sentence a user can read — not an errno heap. */
function verifyRg(bin: string): Promise<string | null> {
  return new Promise((resolveP) => {
    const p = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const out = new OutBuf(4 * 1024);
    p.stdout?.on("data", (c: Buffer) => out.push(c));
    // 同上:一个卡住的 rg 会让"校验"这一步永远不返回。这里连失败都是**一句人话**
    // (它会被原样显示在「安装失败:…」里),超时也照这个口径。
    const timer = setTimeout(() => {
      p.kill();
      resolveP("下载的 ripgrep 没有响应,请重试或手动安装");
    }, VERIFY_TIMEOUT_MS);
    p.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "EACCES" || err.code === "EPERM") {
        resolveP("下载的 ripgrep 没有可执行权限,请手动安装");
        return;
      }
      resolveP(`下载的 ripgrep 无法运行(${err.code ?? err.name})`);
    });
    p.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && /ripgrep/i.test(out.text())) {
        resolveP(null);
        return;
      }
      resolveP("下载的 ripgrep 无法运行,请重试或手动安装");
    });
  });
}