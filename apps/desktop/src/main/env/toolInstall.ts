/**
 * 文档工具链的**安装 / 卸载** —— 「设置 → 内核」那块新面板的右半边。
 *
 * ## pandoc:应用自己下载一份
 *
 * pandoc 的每个 release 都是一个自包含的压缩包,解开就是单个可执行文件。所以
 * 这一项可以完全由应用负责:下到 `<userData>/tools/pandoc/<版本>/`,加进 PATH,
 * 卸载应用即消失。不要管理员权限、不碰系统目录、不改注册表。
 *
 * 下载源是 GitHub release(不是 npm —— `pandoc-bin` 那个包停在 0.2.0,是上古
 * 版本,不能当分发源)。`latex` 同理走 TinyTeX 的 GitHub release,理由与它那个
 * 自解压 `.exe` 的说明见下面 `installLatex` 一节。
 *
 * ## python-deps:装进**用户自己的**解释器
 *
 * 这一项正相反 —— 包必须装进用户已有的 python,不能搬一个解释器过来(那会和
 * 他的 anaconda / venv / 系统 python 打架,而且几十 MB 起)。所以它是"调他的
 * pip"。也因为这个理由,卸载**不提供**:我们无法保证 pip uninstall 只卸掉我们
 * 装的那些(用户可能本来就有其中几个),卸错东西比不卸糟得多。
 *
 * ## 解包为什么不用 `--strip-components`
 *
 * pandoc 的包里是一个顶层目录(`pandoc-3.11/`),要把它剥掉。各家 tar 的
 * strip 旗标拼写与位置不完全一致,所以这里改成"解到暂存目录 → 找出唯一的顶层
 * 子目录 → 整个搬过去",行为不依赖旗标。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { IPC } from "@contracts/ipc";
import type { OnlyOfficeInstallProgress, ToolchainProgressPayload, ToolchainToolId } from "@contracts/ipc";
import {
  configureLocalDocumentServer,
  detectLocal,
  installLocalDocumentServer,
} from "@main/onlyoffice/localInstall.js";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { getToolRoot, MANAGED_TOOLS } from "./managedToolRoots.js";
import { invalidateToolchainCache, pickPythonForInstall, PIP_PACKAGES } from "./toolchain.js";
import { applyAgentEnvironment } from "./agentEnv.js";

/** 网络与解包的边界。pandoc 的包约 40 MB,给足但别无限等。 */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** 多久没有新字节就判这条通道卡住。见 downloadVerified 的说明。 */
const STALL_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 3 * 60_000;
const PIP_TIMEOUT_MS = 20 * 60_000;
/** tlmgr 补包。实测清华源装 ctex + fandol 用了 172 秒 —— 给足但不无限等。 */
const TLMGR_TIMEOUT_MS = 15 * 60_000;

/** GitHub 原站的镜像兜底。**按顺序试,原站永远排第一。**
 *
 * 为什么需要:`github.com` 在国内经常连不上(实测同一时刻 `api.github.com`
 * 返回 200 而 `github.com` 连接超时,连 curl 也超时;半小时前 winget 却下成功过
 * —— 是时通时断)。只认原站的话,这台机器上这个功能一半时间是坏的。
 *
 * 为什么敢走第三方:**校验值不是从镜像拿的**,而是从 api.github.com 的发行信息
 * 里拿(见 fetchPandocRelease),下完先比对 sha256,对不上直接丢。所以镜像只是
 * 一条通道,换掉它不改变"装到手的是什么"—— 恶意镜像最多让我们装不上,装不成
 * 别的东西。
 *
 * 这份清单是**实测**出来的(各拉 3MB 测吞吐):
 *   ghfast.top   750 KB/s  首包 1.4s  全量约 54s   ← 留它
 *   ghproxy.net  连上后挂死,45s 无数据             ← 去掉
 *   ghproxy.cc   证书过期 / gh-proxy.com 403 / gh.llkk.cc 超时 / hub.gitmirror.com 不解析
 *   github.com   连接超时
 * 网络会变,这份清单也就需要跟着变 —— 加一条只要往数组里加个函数,失败原因会
 * 在面板上原样报出来(每条通道单独一行)。
 */
const GITHUB_MIRRORS: ReadonlyArray<(url: string) => string> = [
  (url) => `https://ghfast.top/${url}`,
];

/** 一个 release 资产的全部事实 —— 地址、大小、以及**我们自己校验用的 sha256**。 */
interface ReleaseAsset {
  version: string;
  /** 资产文件名(如 pandoc-3.11-windows-x86_64.zip)。 */
  name: string;
  /** 官方下载地址。镜像由 {@link GITHUB_MIRRORS} 现算。 */
  url: string;
  bytes: number;
  /** 小写十六进制 sha256,来自 GitHub API 的 digest 字段。 */
  sha256: string;
}

const inFlight = new Set<ToolchainToolId>();
const lastError = new Map<ToolchainToolId, string>();

export function isToolInstalling(tool: ToolchainToolId): boolean {
  return inFlight.has(tool);
}

export function lastToolError(tool: ToolchainToolId): string {
  return lastError.get(tool) ?? "";
}

function emit(tool: ToolchainToolId, phase: ToolchainProgressPayload["phase"], progress: number, error?: string): void {
  const payload: ToolchainProgressPayload = { tool, phase, progress, ...(error ? { error } : {}) };
  try {
    sendToRenderer(IPC.TOOLCHAIN_EVENT, { channel: IPC.TOOLCHAIN_EVENT, payload });
  } catch {
    /* 没有窗口在听 —— 不是错误 */
  }
}

/** 平台对应的 pandoc release 资产名。拿不到对应平台就返回 null(而不是瞎猜
 *  一个,那会下到一个跑不起来的二进制)。 */
function pandocAssetName(version: string): string | null {
  const v = version;
  const { platform, arch } = process;
  if (platform === "win32") {
    // pandoc 只发 x86_64 的 Windows 包;arm64 上靠系统的 x64 模拟跑
    return `pandoc-${v}-windows-x86_64.zip`;
  }
  if (platform === "darwin") {
    return arch === "arm64" ? `pandoc-${v}-arm64-macOS.zip` : `pandoc-${v}-x86_64-macOS.zip`;
  }
  if (platform === "linux") {
    return arch === "arm64" ? `pandoc-${v}-linux-arm64.tar.gz` : `pandoc-${v}-linux-amd64.tar.gz`;
  }
  return null;
}

/**
 * 问 GitHub 要最新版本 + 我们这个平台那个资产的地址、大小与 **sha256**。
 *
 * 拿不到就**拒绝安装**,不退到"写死一个版本硬下" —— 那样等于在没有校验值的
 * 情况下从任意地址装一个可执行文件。pandoc 是单文件、手工也好装,所以这里
 * 宁可失败并告诉用户自己装,也不降低校验标准。
 */
async function fetchPandocRelease(): Promise<ReleaseAsset> {
  const res = await fetch("https://api.github.com/repos/jgm/pandoc/releases/latest", {
    headers: {
      accept: "application/vnd.github+json",
      // GitHub API 不带 UA 会被拒(403)
      "user-agent": "Mcode",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`取发行信息失败:HTTP ${res.status}`);

  const body = (await res.json()) as {
    tag_name?: unknown;
    assets?: Array<{ name?: unknown; size?: unknown; digest?: unknown; browser_download_url?: unknown }>;
  };
  // tag 形如 "3.11"(历史上也出现过 "pandoc-3.1")
  const tag = typeof body.tag_name === "string" ? body.tag_name : "";
  const version = tag.match(/([0-9][0-9A-Za-z.\-+]*)$/)?.[1];
  if (!version) throw new Error(`看不懂上游的版本号:“${tag}”`);

  const name = pandocAssetName(version);
  if (!name) throw new Error(`这个平台(${process.platform}/${process.arch})没有现成的 pandoc 包`);

  const asset = (body.assets ?? []).find((a) => a.name === name);
  if (!asset) throw new Error(`这个 release 里没有 ${name}`);

  const digest = typeof asset.digest === "string" ? asset.digest : "";
  const sha256 = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : "";
  if (!sha256) throw new Error("上游没给这个资产的校验值 —— 不装无法校验的二进制");
  if (typeof asset.browser_download_url !== "string") throw new Error("上游没给下载地址");

  return {
    version,
    name,
    url: asset.browser_download_url,
    bytes: typeof asset.size === "number" ? asset.size : 0,
    sha256,
  };
}

/**
 * 下载到临时文件,**边下边算 sha256**,下完比对;不符就删掉并报错。
 *
 * 大小也顺手核一遍:Content-Length 与 API 给的对不上说明这中间被换了东西
 * (或者断流了),不必等哈希算完。
 *
 * ## 为什么需要一个"卡住"看门狗
 *
 * 光有总超时是不够的,这是实测踩出来的:某条 GitHub 代理**连上了、然后一直不给
 * 数据**——不报错也不断开。只有总超时的话,用户要盯着十分钟的进度条才轮到下一条
 * 通道。所以这里另设一个停滞计时器:**若干秒没有新字节就判这条通道失败**,立刻
 * 换下一条。总超时仍然保留 —— 那是给"很慢但在动"的通道用的。
 */
async function downloadVerified(
  url: string,
  asset: ReleaseAsset,
  tool: ToolchainToolId,
): Promise<string> {
  const controller = new AbortController();
  let stalled = false;
  let stallTimer: NodeJS.Timeout | null = null;
  /** 每收到一块就重置;超时即中止。**在 fetch 之前就先支起来** —— 对方接受连接
   *  但连响应头都不发的情况同样要能兜住。 */
  const rearmStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };
  const overallTimer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    rearmStall();
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (asset.bytes > 0 && declared > 0 && declared !== asset.bytes) {
      throw new Error(`大小不符:应得 ${asset.bytes} 字节,对方说 ${declared}`);
    }

    const tmpFile = join(tmpdir(), `mcode-tool-${tool}-${Date.now()}.download`);
    const hash = createHash("sha256");
    let received = 0;
    let lastEmit = 0;
    try {
      await pipeline(
        Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
        async function* (source: AsyncIterable<Uint8Array>) {
          for await (const chunk of source) {
            rearmStall();
            hash.update(chunk);
            received += chunk.byteLength;
            const now = Date.now();
            if (asset.bytes > 0 && now - lastEmit > 150) {
              lastEmit = now;
              emit(tool, "downloading", Math.min(received / asset.bytes, 1));
            }
            yield chunk;
          }
        },
        createWriteStream(tmpFile),
      );
    } catch (err) {
      rmSync(tmpFile, { force: true });
      throw err;
    }

    const got = hash.digest("hex");
    if (got !== asset.sha256) {
      rmSync(tmpFile, { force: true });
      throw new Error(`sha256 不符(下到的不是那份文件)`);
    }
    if (asset.bytes > 0 && received !== asset.bytes) {
      rmSync(tmpFile, { force: true });
      throw new Error(`下载不完整:收到 ${received} / 应得 ${asset.bytes} 字节`);
    }
    return tmpFile;
  } catch (err) {
    if (stalled) {
      throw new Error(`下载卡住(${Math.round(STALL_TIMEOUT_MS / 1000)} 秒没有新数据)`);
    }
    throw err;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    clearTimeout(overallTimer);
  }
}

/** 系统 tar 的绝对路径。
 *
 *  **必须绝对**:Windows 上 Git Bash 的 GNU tar 排在 System32 的 bsdtar 前面是
 *  很常见的情况,而 GNU tar **不认 zip** —— 直接 spawn `tar` 会看运气。这里钉死
 *  到每个平台自带的那个:Windows 10 1803+ 的 System32\bsdtar(能读 zip)、
 *  macOS 的 /usr/bin/bsdtar。Linux 上发行版各有各的,交给 PATH。 */
function systemTar(): string {
  if (process.platform === "win32") {
    const p = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    return existsSync(p) ? p : "tar";
  }
  if (process.platform === "darwin") return "/usr/bin/tar";
  return "tar";
}

function runTar(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      systemTar(),
      ["-xf", archive, "-C", dest],
      { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`解包失败:${(stderr || err.message).trim().slice(0, 300)}`));
        else resolve();
      },
    );
  });
}

/** 把解出来的内容归位。
 *
 *  pandoc 的包里套着一个 `pandoc-<版本>/`(单顶层目录,剥掉即可);
 *  TinyTeX 的包里固定是 `TinyTeX/` —— Windows 那个自解压 `.exe` 解出来的也是
 *  它,所以两条路在这里合流。 */
async function contentRoot(stagingDir: string): Promise<string> {
  const tinytex = join(stagingDir, "TinyTeX");
  if (existsSync(tinytex)) return tinytex;
  const entries = await readdir(stagingDir);
  const dirs: string[] = [];
  for (const entry of entries) {
    try {
      if (statSync(join(stagingDir, entry)).isDirectory()) dirs.push(entry);
    } catch {
      /* 读不动就当它不是目录 */
    }
  }
  if (dirs.length === 1) return join(stagingDir, dirs[0]);
  return stagingDir;
}

/* ── TinyTeX ──
 *
 * ## 为什么是 TinyTeX 而不是 TeX Live 官方安装包
 *
 * 官方 Windows 安装包要管理员权限、写注册表;TinyTeX 是 TeX Live 的轻量发行版,
 * **整个树就是一个目录**,落在哪儿自己说了算 —— 所以它能像 pandoc 一样被应用
 * 下载、挂 PATH、删掉。macOS/Linux 上是 `.tar.xz`,解开就能用。
 *
 * ## Windows 那个 `.exe` 是自解压包,不是安装程序
 *
 * 它的后缀容易让人误会。官方安装脚本(`install-bin-windows.ps1`)是这么用它的:
 *   & ".\TinyTeX-1-windows-v2026.09.exe" -y
 * 注释写的是 "unbundle" —— 只把 `TinyTeX/` 解到**当前目录**,不写注册表、不改
 * 系统 PATH、不要管理员。所以这里把它当成"另一种解压器":在暂存目录里执行,
 * 然后像 tar 解出来的一样搬到自管目录。搬运完暂存目录整个删掉。
 *
 * ## 版本号就用 release 的 tag
 *
 * 解出来的树里没有地方写"我是哪一版",而 tag(`v2026.09`)就是版本的唯一记录 ——
 * 它也被用在资产名里,所以对不上就说明取错了东西。
 */

/** TinyTeX 发行版。用**完整版**(`TinyTeX`)而不是小巧版(`TinyTeX-1`)。
 *
 * 这是实测出来的,不是拍脑袋:把小巧版装出来清点了一遍,15 个论文常用宏包里只有
 * 7 个,缺的包括 **ctex(中文排版 —— 缺了中文论文根本编不过)**、biblatex + biber、
 * 以及 IEEEtran / elsarticle / revtex 这些期刊模板类。对一个面向中文论文的工具,
 * 那是错的默认值:用户第一次拿模版编译就会失败。
 *
 * 代价是下载 165 MB、解开约 1 GB —— 大,但换来的是"装完就能编译",不需要再跟
 * tlmgr 与 CTAN 镜像较劲(那在国内又是另一堆连通性问题)。 */
const TINYTEX_FLAVOR = "TinyTeX";

/** 平台对应的 TinyTeX 资产名。拿不到就返回 null(而不是瞎猜一个)。 */
function tinytexAssetName(tag: string): string | null {
  const { platform, arch } = process;
  if (platform === "win32") return `${TINYTEX_FLAVOR}-windows-${tag}.exe`;
  if (platform === "darwin") return `${TINYTEX_FLAVOR}-darwin-${tag}.tar.xz`;
  if (platform === "linux") {
    // 刻意不认 musl:从 Node 里判断当前是不是 musl libc 没有可靠办法,而选错
    // 会得到一个跑不起来的树。Alpine 之类请自己装。
    const a = arch === "arm64" ? "arm64" : "x86_64";
    return `${TINYTEX_FLAVOR}-linux-${a}-${tag}.tar.xz`;
  }
  return null;
}

async function fetchTinytexRelease(): Promise<ReleaseAsset> {
  const res = await fetch("https://api.github.com/repos/rstudio/tinytex-releases/releases/latest", {
    headers: { accept: "application/vnd.github+json", "user-agent": "Mcode" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`取发行信息失败:HTTP ${res.status}`);

  const body = (await res.json()) as {
    tag_name?: unknown;
    assets?: Array<{ name?: unknown; size?: unknown; digest?: unknown; browser_download_url?: unknown }>;
  };
  const tag = typeof body.tag_name === "string" ? body.tag_name : "";
  const name = tinytexAssetName(tag);
  if (!name) throw new Error(`这个平台(${process.platform}/${process.arch})没有现成的 TinyTeX 包`);
  const asset = (body.assets ?? []).find((a) => a.name === name);
  if (!asset) throw new Error(`这个 release 里没有 ${name}`);

  const digest = typeof asset.digest === "string" ? asset.digest : "";
  const sha256 = digest.startsWith("sha256:") ? digest.slice("sha256:".length) : "";
  if (!sha256) throw new Error("上游没给这个资产的校验值 —— 不装无法校验的二进制");
  if (typeof asset.browser_download_url !== "string") throw new Error("上游没给下载地址");

  return {
    // tag 形如 "v2026.09" —— 目录名用不带 v 的那个数,和其他工具一致
    version: tag.replace(/^v/, ""),
    name,
    url: asset.browser_download_url,
    bytes: typeof asset.size === "number" ? asset.size : 0,
    sha256,
  };
}

/** 在暂存目录里跑 Windows 的自解压包(`-y` = 直接解,别问)。 */
function runSelfExtractor(exePath: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      exePath,
      ["-y"],
      { cwd, timeout: EXTRACT_TIMEOUT_MS, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`自解压失败:${(stderr || err.message).trim().slice(0, 300)}`));
        else resolve();
      },
    );
  });
}

/**
 * 装/更新自管的 LaTeX(TinyTeX)。
 *
 * 下载和 pandoc 走同一套:先原站、再镜像,每条都独立校验 sha256。区别只在
 * "解包"那一步 —— Windows 是执行官方自解压包,其余平台是 tar。
 */
async function installLatex(): Promise<void> {
  // 同 `installPandoc`:根没注册就当场拒,别等下载完再说(见那一段的注释)。
  const destRoot = getToolRoot();
  if (!destRoot) throw new Error("工具根目录还没注册(应用启动流程没走完?)");
  emit("latex", "downloading", -1);
  const asset = await fetchTinytexRelease();
  const sources = [asset.url, ...GITHUB_MIRRORS.map((to) => to(asset.url))];
  log.info(`toolchain: installing latex ${asset.version} (${asset.name})`);

  const failures: string[] = [];
  let archive: string | null = null;
  for (const [index, source] of sources.entries()) {
    const host = new URL(source).host;
    try {
      archive = await downloadVerified(source, asset, "latex");
      if (index > 0) log.info(`toolchain: latex 从镜像取回(${host})`);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${host}: ${message}`);
      log.warn(`toolchain: latex 下载通道失败 —— ${failures[failures.length - 1]}`);
    }
  }
  if (!archive) throw new Error(`下载失败 —— ${failures.join("；")}`);

  const staging = join(tmpdir(), `mcode-tool-latex-stage-${Date.now()}`);
  try {
    emit("latex", "extracting", -1);
    mkdirSync(staging, { recursive: true });
    if (process.platform === "win32") {
      await runSelfExtractor(archive, staging);
    } else {
      await runTar(archive, staging);
    }

    const contentDir = await contentRoot(staging);
    if (contentDir === staging) {
      throw new Error("解出来的内容里没有 TinyTeX 目录 —— 上游打包方式变了?");
    }

    const root = destRoot;
    const destDir = join(root, "latex", asset.version);
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(join(root, "latex"), { recursive: true });
    await rename(contentDir, destDir);

    // 装完立刻验一次:树在、但引擎跑不起来是最糟的失败模式(用户以为装好了)
    const engine = findLatexEngine(destDir);
    if (!engine) {
      rmSync(destDir, { recursive: true, force: true });
      throw new Error("装完了但找不到 xelatex —— TinyTeX 的目录结构变了?");
    }

    // 补中文链(ctex + 字体)。这一步要几分钟,所以先广播一个阶段让界面有反应。
    emit("latex", "installing", -1);
    await installTinytexPackages(dirname(engine));
  } finally {
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

/** 在装好的 TinyTeX 树里定位引擎可执行文件。bin 下的平台目录名各发行版不同,
 *  所以扫一层看哪个里面有 xelatex。 */
function findLatexEngine(versionDir: string): string | null {
  const binRoot = join(versionDir, "bin");
  let entries: string[];
  try {
    entries = readdirSync(binRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const exe = join(binRoot, entry, process.platform === "win32" ? "xelatex.exe" : "xelatex");
    if (existsSync(exe)) return exe;
  }
  return null;
}

/** 中文排版链 —— **必须**补上。实测两个 TinyTeX 发行版都不带 ctex,缺了它中文论文
 *  一行都编不过;`fandol` 是 ctex 默认用的那套开源中文字体,TeX Live 里单独一个包。 */
const TINYTEX_CHINESE_PACKAGES = ["ctex", "fandol"] as const;

/** 论文模版常 `\documentclass` 的那几个期刊文档类 —— 完整版 TinyTeX 也不带。
 *  包名逐个对过 TeX Live 的包数据库(`revtex4-2` **不是**包名,`revtex` 才是)。 */
const TINYTEX_TEMPLATE_PACKAGES = ["ieeetran", "elsarticle", "revtex", "algorithm2e"] as const;

/** CTAN 源。清华排第一:这台机器所在的网络到 CTAN 默认的 mirror redirect 很慢,
 *  实测清华 172 秒装完 ctex + fandol。留给默认源兜底,是因为这个应用不只在中国用。 */
const CTAN_MIRRORS = [
  "https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet",
  "https://mirror.ctan.org/systems/texlive/tlnet",
] as const;

/** 跑 tlmgr。
 *
 * **Windows 上要经 cmd**:TeX Live 的 tlmgr 是 `tlmgr.bat`(真逻辑在 runscript.exe
 * 里那个精简 Perl 里),而 Node 从 18.20 起拒绝在没有 shell 的情况下 spawn `.cmd`/
 * `.bat`。其余平台是带 shebang 的 Perl 脚本,直接起。 */
function runTlmgr(
  binDir: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const tlmgr = join(binDir, process.platform === "win32" ? "tlmgr.bat" : "tlmgr");
    const [file, argv] =
      process.platform === "win32" ? ["cmd.exe", ["/c", tlmgr, ...args]] : [tlmgr, args];
    execFile(
      file,
      argv,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, cwd: binDir },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: `${stdout}\n${stderr}` });
      },
    );
  });
}

/**
 * 装一组宏包,按镜像依次试。返回是否成功。
 *
 * 换源重试:CTAN 默认的 mirror redirect 在国内很慢,清华源实测 172 秒装完
 * ctex + fandol。先试清华,不行再回默认 —— 这个应用不只在中国用。
 */
async function tlmgrInstall(
  binDir: string,
  packages: readonly string[],
  label: string,
): Promise<boolean> {
  for (const mirror of CTAN_MIRRORS) {
    const setRepo = await runTlmgr(binDir, ["option", "repository", mirror], 120_000);
    if (!setRepo.ok) {
      log.warn(`toolchain: latex 换源失败（${mirror}）`);
      continue;
    }
    const res = await runTlmgr(binDir, ["install", ...packages], TLMGR_TIMEOUT_MS);
    if (res.ok) {
      log.info(`toolchain: latex ${label} 装好（${packages.join(", ")} @ ${mirror}）`);
      return true;
    }
    const tail = res.stdout.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 200);
    log.warn(`toolchain: latex ${label} 失败（${mirror}）—— ${tail}`);
  }
  return false;
}

/**
 * 补宏包。**尽力而为** —— 失败不让整个安装失败。
 *
 * 为什么不让它失败:树已经装好了,英文文档照样能编;把"整个安装失败"报给用户,
 * 反而让他以为白下了 165 MB。真正的反馈走检测里的 `ctex` 组件 —— 补包没成功时
 * 面板会如实显示「缺 ctex」,而不是假装一切正常。
 *
 * **分两次调用**是有意的:万一名单里有个包名上游改了,tlmgr 会整条命令非零退出。
 * 分成两条,后面那条失败就不会带崩前面已经验证过的中文链。
 */
async function installTinytexPackages(binDir: string): Promise<void> {
  const zh = await tlmgrInstall(binDir, TINYTEX_CHINESE_PACKAGES, "中文排版链");
  if (!zh) {
    log.warn("toolchain: latex 中文宏包没补上；可用 tlmgr install ctex fandol 自己装");
  }
  await tlmgrInstall(binDir, TINYTEX_TEMPLATE_PACKAGES, "期刊文档类");
}

/**
 * 装/更新自管的 pandoc。
 *
 * 下载会**依次试**官方地址与镜像,每一条都独立校验 sha256 —— 所以"哪条通道
 * 通了"只影响速度,不影响装到手的东西。全部失败时把所有通道的失败原因一起报
 * 出来(只报最后一条会让人以为是同一个错误反复发生)。
 */
async function installPandoc(): Promise<void> {
  // 工具根还没注册 = 应用启动流程没走完。**必须在下载之前挡住**:
  // 下面那句同样内容的检查在 `downloadVerified` **之后** —— 走到那儿用户已经等了
  // 半天(中间还有一次换源失败),最后拿到的却是一句"工具根目录还没注册",白等
  // 而且看不懂。它也不能直接退回 `app.getPath("userData")`:那是用户真实的目录。
  const destRoot = getToolRoot();
  if (!destRoot) throw new Error("工具根目录还没注册(应用启动流程没走完?)");
  emit("pandoc", "downloading", -1);
  const asset = await fetchPandocRelease();
  const sources = [asset.url, ...GITHUB_MIRRORS.map((to) => to(asset.url))];
  log.info(`toolchain: installing pandoc ${asset.version} (${asset.name})`);

  const failures: string[] = [];
  let tmpArchive: string | null = null;
  for (const [index, source] of sources.entries()) {
    const host = new URL(source).host;
    try {
      tmpArchive = await downloadVerified(source, asset, "pandoc");
      if (index > 0) log.info(`toolchain: pandoc 从镜像取回(${host})`);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${host}: ${message}`);
      log.warn(`toolchain: pandoc 下载通道失败 —— ${failures[failures.length - 1]}`);
    }
  }
  if (!tmpArchive) {
    throw new Error(`下载失败 —— ${failures.join("；")}`);
  }

  const staging = join(tmpdir(), `mcode-tool-pandoc-stage-${Date.now()}`);
  try {
    emit("pandoc", "extracting", -1);
    mkdirSync(staging, { recursive: true });
    await runTar(tmpArchive, staging);

    const contentDir = await contentRoot(staging);
    const exeName = process.platform === "win32" ? "pandoc.exe" : "pandoc";
    if (!existsSync(join(contentDir, exeName))) {
      throw new Error("解出来的包里没有 pandoc 可执行文件 —— 上游命名变了?");
    }

    const root = destRoot;
    const destDir = join(root, "pandoc", asset.version);
    // 同版本重装:先清掉旧的,免得留半个旧文件混在新的里面
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(join(root, "pandoc"), { recursive: true });
    await rename(contentDir, destDir);
  } finally {
    rmSync(tmpArchive, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

/** pip 装缺失的包,装进用户自己的解释器。 */
async function installPythonDeps(): Promise<void> {
  const python = await pickPythonForInstall();
  if (!python) throw new Error("没找到可用的 python —— 请先自己装一个,再回来点重试");
  emit("python-deps", "installing", -1);
  await new Promise<void>((resolve, reject) => {
    execFile(
      python,
      ["-m", "pip", "install", "--disable-pip-version-check", ...PIP_PACKAGES],
      { timeout: PIP_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve();
        // pip 的失败原因几乎都在 stderr 的末尾 —— 截尾比截头有用
        const tail = `${stderr}\n${stdout}`.trim().split(/\r?\n/).slice(-6).join(" | ");
        reject(new Error(`pip 安装失败:${tail.slice(-400) || err.message}`));
      },
    );
  });
}

/**
 * ONLYOFFICE Document Server。
 *
 * 和 pandoc / latex 那两项**不是一回事**:那两个是把一棵树解进 `<userData>/tools`,
 * 这个是跑官方安装器 —— 装到 Program Files、注册两个 Windows 服务、过一次 UAC。
 * 所以它也**卸不掉**(`removeTool` 只管自管目录),要卸得走 Windows 的卸载程序。
 *
 * 进度:下载阶段把字节数折成 0..1;提权安装与等服务起来这两段没有可测的进度,
 * 报 -1(面板按"进行中"画,同 pip 那一项)。
 */
async function installOnlyOffice(): Promise<void> {
  const onProgress = (p: OnlyOfficeInstallProgress): void => {
    if (p.phase === "downloading") {
      emit("onlyoffice", "downloading", p.totalBytes ? p.receivedBytes / p.totalBytes : -1);
    } else if (p.phase === "installing" || p.phase === "configuring" || p.phase === "waiting") {
      emit("onlyoffice", "installing", -1);
    }
  };
  try {
    // **已经装过就只修配置** —— 同一段提权脚本,跳过那 1 GB 的安装器。
    //
    // 用户点「安装」时多半是因为这一行显示不可用,而"装了但私网开关被关上"、
    // "服务停了"这两种远比"根本没装"常见;那种情况下重下一遍安装包纯属浪费
    // (而且用户会以为是卡住了)。这条分支也把老设置页里那个「修复配置」按钮
    // 的能力接了回来 —— 现在不用他自己判断该点哪个。
    const local = await detectLocal();
    if (local.installed) await configureLocalDocumentServer({ onProgress });
    else await installLocalDocumentServer({ onProgress });
  } catch (err) {
    throw new Error(onlyOfficeErrorText(err instanceof Error ? err.message : String(err)));
  }
}

/**
 * 把 localInstall 抛出的**错误码**翻成一句能照着做的话。
 *
 * 原先失败只会说"Document Server 一直没有响应,请到 services.msc 检查" ——
 * 那句话对用户没有任何可操作性:他打开 services.msc 之后该看什么、看到了又怎么办?
 * 现在 `waitHealthy` 把 `sc query` 的结果拼在错误码后面,这里按它分岔 ——
 * "服务没注册上"和"注册了起不来"是两种完全不同的处置。
 */
function onlyOfficeErrorText(raw: string): string {
  if (raw === "UAC_DENIED") return "安装要管理员权限,你在 UAC 弹窗里点了「否」——重试并选「是」";
  if (raw === "UNSUPPORTED_PLATFORM") return "只有 Windows 有官方静默安装包,这台机器装不了";
  if (raw === "ONLYOFFICE_INSTALL_BUSY") return "这一项正在装,别重复点";
  if (raw === "ONLYOFFICE_SECRET_UNREADABLE") {
    return "服务装好了,但读不出它的 JWT 密钥(%ProgramFiles%\\ONLYOFFICE\\DocumentServer\\config\\local.json 打不开或不是合法 JSON)。再点一次「安装」让应用重写一遍这个文件;还是不行就手动把 services.CoAuthoring.secret.inbox.string 的值填进下面的「JWT 密钥」";
  }
  if (raw.startsWith("DS_NOT_RESPONDING")) {
    const svc = raw.split(":")[1];
    if (svc === "missing") {
      return "安装器跑完了,但 DsDocServiceSvc / DsConverterSvc 两个服务没注册上 —— 多半是安装器中途失败了。再点一次安装(安装包已经下好,会直接复用);还是这样就看 %TEMP%\\mcode-onlyoffice 下那份安装日志";
    }
    if (svc === "stopped") {
      return "服务装上了但起不来 —— 常见原因是它要的端口被别的程序占了,或安装器自带的 PostgreSQL / RabbitMQ 没起来。在 services.msc 里手动启动 DsDocServiceSvc,它会把真正的原因写进事件日志";
    }
    return "服务在跑,但 healthcheck 一直不应答。首次启动有时要好几分钟,稍等一会儿点「重新检测」";
  }
  // ── 下面这些是 `onlyoffice/localInstall.ts` 直接抛的码/英文句。**必须都映射** ——
  //    末尾的 `return raw` 会让内部串原样画在工具链面板那一行上。onboarding 里那条
  //    "只修配置"的路(`applyLocal`)会抛前两个码,下载/提权/脚本失败则抛后几个。
  if (raw === "ONLYOFFICE_NOT_INSTALLED") return "这台机器上没找到 ONLYOFFICE Document Server —— 点「安装」装一个";
  if (raw === "ONLYOFFICE_NOT_RUNNING") return "Document Server 装了但没在跑 —— 去 services.msc 启动 DsDocServiceSvc,或用系统托盘里的 ONLYOFFICE 启动它";
  if (raw.startsWith("download failed")) return `安装包下载失败(${raw.replace(/^download failed:\s*/, "")})—— 检查网络/代理后重试`;
  if (raw === "download incomplete") return "安装包下载不完整(连接中断)—— 重试一次";
  if (raw.startsWith("install script failed")) return `安装脚本执行失败${raw.includes(":") ? `:${raw.slice(raw.indexOf(":"))}` : ""} —— 看 %TEMP%\\mcode-onlyoffice 下的安装日志`;
  if (raw.startsWith("elevation failed")) return `提权失败,安装没能开始(${raw.replace(/^elevation failed\s*/, "")})—— 确认你在 UAC 弹窗里点了「是」`;
  return raw;
}

/** 装(或重装)一个工具。 */
export async function installTool(tool: ToolchainToolId): Promise<{ ok: boolean; error?: string }> {
  if (inFlight.has(tool)) return { ok: false, error: "这个工具正在安装中" };
  inFlight.add(tool);
  lastError.delete(tool);
  emit(tool, "downloading", -1);
  try {
    if (tool === "pandoc") await installPandoc();
    else if (tool === "latex") await installLatex();
    else if (tool === "python-deps") await installPythonDeps();
    else if (tool === "onlyoffice") await installOnlyOffice();
    else throw new Error("这个工具要管理员权限才能装,应用不代劳 —— 见面板上的安装指引");
    invalidateToolchainCache();
    applyAgentEnvironment();
    emit(tool, "done", 1);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastError.set(tool, message);
    log.warn(`toolchain: install ${tool} failed: ${message}`);
    emit(tool, "error", -1, message);
    return { ok: false, error: message };
  } finally {
    inFlight.delete(tool);
  }
}

/**
 * 卸掉**应用自己装的那份**。
 *
 * 只对自管工具(pandoc / latex)有效 —— 它们的"安装"就是把一棵树放进自己的目录,
 * 所以"卸载"就是把那个目录删掉,不会有残留。python 的包装在用户的解释器里,我们
 * 没法保证 pip uninstall 只卸掉自己装的那几个(用户可能本来就有),卸错比不卸糟;
 * 用户系统里自己那份(source "system")也一律不动。
 */
export async function removeTool(tool: ToolchainToolId): Promise<{ ok: boolean; error?: string }> {
  if (inFlight.has(tool)) return { ok: false, error: "这个工具正在忙" };
  if (!MANAGED_TOOLS.includes(tool as (typeof MANAGED_TOOLS)[number])) {
    return { ok: false, error: "这一项不是应用装的,应用不会去卸它" };
  }
  const root = getToolRoot();
  if (!root) return { ok: false, error: "工具根目录还没注册" };
  try {
    rmSync(join(root, tool), { recursive: true, force: true });
    invalidateToolchainCache();
    applyAgentEnvironment();
    lastError.delete(tool);
    emit(tool, "done", 1);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastError.set(tool, message);
    return { ok: false, error: message };
  }
}
