/**
 * OnlyOffice Docs **本机安装**：检测 / 下载 / 静默安装 / 修配置（仅 Windows）。
 *
 * 用户不想装 Docker，所以走官方 Windows 安装包：
 *   https://download.onlyoffice.com/install/documentserver/windows/onlyoffice-documentserver.exe
 * （~1 GB，Community Edition，AGPL；安装器自己会把 PostgreSQL / RabbitMQ / Erlang 这些
 * 前置件一起装上，支持 `/SILENT /DS_PORT=<port>`；装完的 Windows 服务名是
 * `DsDocServiceSvc` / `DsConverterSvc`，目录 `%ProgramFiles%\ONLYOFFICE\DocumentServer`。）
 *
 * 流程（`startLocalInstall`）：
 *   downloading  → 主进程用 fetch 流式下到 `%TEMP%\mcode-onlyoffice\`，带字节进度
 *   installing   → 起一个**提权**的 PowerShell（UAC 弹一次）跑安装器 + 改 local.json
 *                  （`allowPrivateIPAddress` —— 否则 DS 回连不到 127.0.0.1 上的桥）+ 重启服务
 *   waiting      → 轮询 `/healthcheck` 直到 DS 起来（首启要 1–2 分钟）
 *   done         → `detectLocal()` 读出 JWT 密钥，直接写进 Mcode 配置，用户零手填
 *
 * 检测（`detectLocal`）不需要管理员：目录存在 + 读 `config\local.json`（密钥、私网开关）
 * + `sc query` 看服务 + 逐个候选端口探 healthcheck 定端口。
 *
 * 进度是主进程内一个单例状态，渲染端轮询 `onlyoffice:installProgress`（安装是分钟级、
 * 且要活过设置页开关，不做事件推送，轮询更省事也更稳）。
 */
import { app } from "electron";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  OnlyOfficeConfig,
  OnlyOfficeInstallPhase,
  OnlyOfficeInstallProgress,
  OnlyOfficeLocalDetectResult,
} from "@contracts/ipc";
import { log } from "@main/lib/logger.js";
import { getOnlyOfficeConfig, setOnlyOfficeConfig } from "./OnlyOfficeBridge.js";

export const ONLYOFFICE_WIN_INSTALLER_URL =
  "https://download.onlyoffice.com/install/documentserver/windows/onlyoffice-documentserver.exe";

const SERVICE_NAMES = ["DsDocServiceSvc", "DsConverterSvc"] as const;

/* ───────────────────────── 检测 ───────────────────────── */

function candidateInstallDirs(): string[] {
  const dirs: string[] = [];
  for (const env of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]) {
    const base = process.env[env];
    if (base) dirs.push(join(base, "ONLYOFFICE", "DocumentServer"));
  }
  return [...new Set(dirs)];
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function findInstallDir(): Promise<string | null> {
  for (const d of candidateInstallDirs()) {
    // 装好的目录里一定有编辑器前端 api.js；只看根目录会被残留空文件夹骗到
    if (await exists(join(d, "web-apps", "apps", "api", "documents", "api.js"))) return d;
  }
  return null;
}

interface LocalJsonFacts {
  jwtSecret: string | null;
  tokenEnabled: boolean | null;
  privateIpAllowed: boolean | null;
}

async function readLocalJson(dir: string): Promise<LocalJsonFacts> {
  const out: LocalJsonFacts = { jwtSecret: null, tokenEnabled: null, privateIpAllowed: null };
  try {
    const raw = await readFile(join(dir, "config", "local.json"), "utf8");
    // ⚠️ BOM 必须先剥掉。
    //
    // 我们自己那段提权脚本在 PowerShell 5.1 上写这个文件 —— 它的 `-Encoding UTF8`
    // **带 BOM**。`JSON.parse` 见到开头的 U+FEFF 直接抛,而这里原本一个 catch 把
    // 异常吞成"三个 null",于是:密钥读不出来 → `applyLocal()` 存了个**空密钥** →
    // DS 开着 browser token 校验 → 编辑器一开就是「文档安全令牌的格式不正确」
    // (error -20);同时 `privateIpAllowed` 也变 null,工具链那一行还显示绿色,
    // 整条链路对不上号却处处"看着正常"。
    //
    // 写入侧已经改成不带 BOM,但用户机器上**已经存在**的那一份仍是带 BOM 的,
    // 而且 DS 自己和别的工具写出来的文件也可能带 —— 读的这一侧必须自己扛住。
    const j = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const co = pick(pick(j, "services"), "CoAuthoring");
    const secret = pick(pick(pick(co, "secret"), "inbox"), "string");
    if (typeof secret === "string" && secret) out.jwtSecret = secret;
    const inbox = pick(pick(pick(pick(co, "token"), "enable"), "request"), "inbox");
    if (typeof inbox === "boolean") out.tokenEnabled = inbox;
    const allow = pick(pick(co, "request-filtering-agent"), "allowPrivateIPAddress");
    if (typeof allow === "boolean") out.privateIpAllowed = allow;
    else if (co) out.privateIpAllowed = false; // DS 8.x 默认 false
  } catch {
    /* 没有 local.json 或不是 JSON：一律 null */
  }
  return out;
}

function pick(o: unknown, k: string): unknown {
  return o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
}

async function readVersion(dir: string): Promise<string | null> {
  for (const rel of [["server", "package.json"], ["web-apps", "package.json"], ["package.json"]]) {
    try {
      const j = JSON.parse(await readFile(join(dir, ...rel), "utf8")) as { version?: string };
      if (j.version) return j.version;
    } catch {
      /* try next */
    }
  }
  return null;
}

function queryService(name: string): Promise<"running" | "stopped" | "missing"> {
  return new Promise((resolve) => {
    execFile("sc.exe", ["query", name], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve("missing");
      resolve(/\bRUNNING\b/.test(stdout) ? "running" : "stopped");
    });
  });
}

async function healthcheck(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp = await fetch(`${url}/healthcheck`, { signal: ctrl.signal });
    clearTimeout(timer);
    return resp.ok && (await resp.text()).trim() === "true";
  } catch {
    return false;
  }
}

/** 逐个候选端口探 healthcheck。先探当前配置的、再探安装时指定的、最后 8080 / 80。 */
async function findPort(preferred: number[]): Promise<number | null> {
  const seen = new Set<number>();
  for (const p of [...preferred, 8080, 80]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    if (await healthcheck(`http://127.0.0.1:${p}`)) return p;
  }
  return null;
}

function portOfConfigured(cfg: OnlyOfficeConfig): number | null {
  try {
    const u = new URL(cfg.serverUrl);
    if (!["127.0.0.1", "localhost"].includes(u.hostname)) return null;
    return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

export async function detectLocal(): Promise<OnlyOfficeLocalDetectResult> {
  const none: OnlyOfficeLocalDetectResult = {
    supported: process.platform === "win32",
    installed: false,
    installDir: null,
    version: null,
    serviceState: "unknown",
    port: null,
    jwtSecret: null,
    tokenEnabled: null,
    privateIpAllowed: null,
    suggestedServerUrl: null,
  };
  if (!none.supported) return none;
  const dir = await findInstallDir();
  if (!dir) return none;
  const [facts, version, svc] = await Promise.all([readLocalJson(dir), readVersion(dir), queryService("DsDocServiceSvc")]);
  const preferred = [portOfConfigured(getOnlyOfficeConfig()), progress.port].filter((x): x is number => !!x);
  const port = svc === "running" ? await findPort(preferred) : null;
  return {
    ...none,
    installed: true,
    installDir: dir,
    version,
    serviceState: svc === "missing" ? "unknown" : svc,
    port,
    jwtSecret: facts.jwtSecret,
    tokenEnabled: facts.tokenEnabled,
    privateIpAllowed: facts.privateIpAllowed,
    suggestedServerUrl: port ? `http://127.0.0.1:${port}` : null,
  };
}

/** 检测到的本机 DS 直接写进 Mcode 配置（地址 + 密钥）。没跑起来就报错，不写半截。
 *  模块内部用:装完 / 修完配置后自动落盘 —— 用户不需要、也没有入口手动触发它。 */
async function applyLocal(): Promise<OnlyOfficeConfig> {
  const d = await detectLocal();
  if (!d.installed) throw new Error("ONLYOFFICE_NOT_INSTALLED");
  if (!d.suggestedServerUrl) throw new Error("ONLYOFFICE_NOT_RUNNING");
  const prev = getOnlyOfficeConfig();
  // 密钥读不出来(local.json 打不开 / 不是合法 JSON)而 DS 又没明说关了 token 校验:
  // **不能存半截**。存下来的空密钥会让每一次打开文档都报 -20,而设置页一片绿 ——
  // 那种失败没人查得出来。宁可在这里响一声。
  if (d.jwtSecret === null && d.tokenEnabled !== false && !prev.jwtSecret) {
    throw new Error("ONLYOFFICE_SECRET_UNREADABLE");
  }
  return setOnlyOfficeConfig({
    serverUrl: d.suggestedServerUrl,
    // DS 关了 token 校验时密钥无所谓；开着就必须一致 —— 以 local.json 为准
    jwtSecret: d.tokenEnabled === false ? "" : (d.jwtSecret ?? prev.jwtSecret),
    callbackHost: "",
  });
}

/* ───────────────────────── 安装任务 ───────────────────────── */

interface InstallState extends OnlyOfficeInstallProgress {
  port: number | null;
  abort: AbortController | null;
}

const progress: InstallState = {
  phase: "idle",
  receivedBytes: 0,
  totalBytes: null,
  message: null,
  startedAt: null,
  port: null,
  abort: null,
};

function setPhase(phase: OnlyOfficeInstallPhase, message: string | null = null): void {
  progress.phase = phase;
  progress.message = message;
  log.info(`[onlyoffice-install] ${phase}${message ? `: ${message}` : ""}`);
}

export function getInstallProgress(): OnlyOfficeInstallProgress {
  const { phase, receivedBytes, totalBytes, message, startedAt } = progress;
  return { phase, receivedBytes, totalBytes, message, startedAt };
}


function isBusy(): boolean {
  return ["downloading", "installing", "configuring", "waiting"].includes(progress.phase);
}

function tempDir(): string {
  return join(app.getPath("temp"), "mcode-onlyoffice");
}

/** 安装器 `/DS_PORT` 的默认值。80 常被 IIS / 其他东西占着,所以默认挑 8080。 */
export const DEFAULT_DS_PORT = 8080;

/**
 * 下载 → 提权静默安装 → 改配置 → 等服务起来 → 写 Mcode 配置。
 * 「设置 → 内核 → 文档工具链」里 ONLYOFFICE 那一行的「安装」走这条。
 *
 * `onProgress` 每秒回调一次当前进度快照(下载字节数是流式累加的,没有天然的回调点)。
 */
export async function installLocalDocumentServer(opts: {
  port?: number;
  onProgress?: (p: OnlyOfficeInstallProgress) => void;
} = {}): Promise<void> {
  if (process.platform !== "win32") {
    setPhase("error", "UNSUPPORTED_PLATFORM");
    throw new Error("UNSUPPORTED_PLATFORM");
  }
  if (isBusy()) throw new Error("ONLYOFFICE_INSTALL_BUSY");
  const port = opts.port ?? DEFAULT_DS_PORT;
  progress.receivedBytes = 0;
  progress.totalBytes = null;
  progress.startedAt = Date.now();
  progress.port = port;
  progress.abort = new AbortController();
  const ticker = opts.onProgress
    ? setInterval(() => opts.onProgress?.(getInstallProgress()), 1_000)
    : null;
  try {
    await runInstall(port);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setPhase(msg === "CANCELLED" ? "cancelled" : "error", msg);
    throw err;
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

/**
 * **可等待**的「只修配置」—— 已经装好、但 `allowPrivateIPAddress` 被关掉(或服务停了)
 * 时走这条:同一段提权脚本,**跳过安装器**,所以不用再碰那 1 GB 的包,秒级完成。
 *
 * 原先这条路要用户去设置页点「修复配置」。那个页面已经没了 —— 现在由工具链那一行的
 * 「安装」自己判断:检测到已安装就只修配置,没装才走完整安装。
 */
export async function configureLocalDocumentServer(opts: {
  onProgress?: (p: OnlyOfficeInstallProgress) => void;
} = {}): Promise<void> {
  if (process.platform !== "win32") {
    setPhase("error", "UNSUPPORTED_PLATFORM");
    throw new Error("UNSUPPORTED_PLATFORM");
  }
  if (isBusy()) throw new Error("ONLYOFFICE_INSTALL_BUSY");
  progress.startedAt = Date.now();
  const ticker = opts.onProgress
    ? setInterval(() => opts.onProgress?.(getInstallProgress()), 1_000)
    : null;
  try {
    const dir = await findInstallDir();
    if (!dir) throw new Error("ONLYOFFICE_NOT_INSTALLED");
    setPhase("configuring");
    await runElevated({ installerPath: null, port: null, installDir: dir });
    await waitHealthy(progress.port ?? portOfConfigured(getOnlyOfficeConfig()) ?? 0);
    await applyLocal();
    setPhase("done");
  } catch (err) {
    setPhase("error", err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

/**
 * 轮询式包装:立刻返回,结果查 {@link getInstallProgress}。
 *
 * 留着是因为 `scripts/maint-m21-smoke` 用它驱动**提权那一步**的安全断言
 * (脚本不许落在用户可写目录、提权命令行不许按路径去加载 .ps1)。那套断言盯的是
 * 真的生产路径,不是为测试造的壳。
 */
export function startLocalConfigure(): OnlyOfficeInstallProgress {
  if (isBusy()) return getInstallProgress();
  void configureLocalDocumentServer().catch(() => {
    /* 失败原因已经记进 phase/message,轮询拿得到 */
  });
  return getInstallProgress();
}

async function runInstall(port: number): Promise<void> {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  const exe = join(dir, "onlyoffice-documentserver.exe");

  // ── 1. 下载（已经完整下过就复用；大小以服务器 Content-Length 为准）──
  setPhase("downloading");
  await download(exe, progress.abort!.signal);

  // ── 2. 提权安装 + 改配置 + 重启服务 ──
  setPhase("installing");
  const installDir = candidateInstallDirs()[0] ?? join(process.env.ProgramFiles ?? "C:\\Program Files", "ONLYOFFICE", "DocumentServer");
  await runElevated({ installerPath: exe, port, installDir });

  // ── 3. 等 DS 起来 ──
  setPhase("waiting");
  await waitHealthy(port);

  // ── 4. 写进 Mcode 配置 ──
  await applyLocal();
  setPhase("done");
}

async function download(dest: string, signal: AbortSignal): Promise<void> {
  const head = await fetch(ONLYOFFICE_WIN_INSTALLER_URL, { method: "HEAD", signal });
  const total = Number(head.headers.get("content-length")) || null;
  progress.totalBytes = total;
  try {
    const s = await stat(dest);
    if (total && s.size === total) {
      progress.receivedBytes = total;
      return; // 上次下完了没装成，直接复用
    }
  } catch {
    /* not there */
  }
  const resp = await fetch(ONLYOFFICE_WIN_INSTALLER_URL, { signal });
  if (!resp.ok || !resp.body) throw new Error(`download failed: HTTP ${resp.status}`);
  const src = Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream<Uint8Array>);
  src.on("data", (chunk: Buffer) => {
    progress.receivedBytes += chunk.length;
  });
  try {
    await pipeline(src, createWriteStream(dest), { signal });
  } catch (err) {
    await unlink(dest).catch(() => {});
    if (signal.aborted) throw new Error("CANCELLED");
    throw err;
  }
  if (total && progress.receivedBytes !== total) throw new Error("download incomplete");
}

/** PowerShell 单引号字符串字面量的转义。 */
const ps = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * 生成提权执行的 PowerShell 脚本文本。**独立导出是为了能被测到** —— 这段东西
 * 是以管理员身份跑的,它长什么样必须可断言。
 *
 * 两条安全约束刻在这里:
 *
 *  1. **安装器在跑之前必须验 Authenticode 签名**,且签名主体得是 ONLYOFFICE /
 *     Ascensio。安装包是从网上下到用户可写目录里的 ~1 GB 可执行文件,之后要以
 *     管理员身份执行 —— 只比对 Content-Length 不足以证明它还是官方那一个。
 *  2. 脚本本身**不落盘**(见 runElevated 的 `-EncodedCommand`),所以这里返回的是
 *     文本而不是路径。
 */
export function buildElevationCommand(o: {
  installerPath: string | null;
  port: number | null;
  installDir: string;
  markerPath?: string;
  logPath?: string;
}): string {
  const lines: string[] = ["$ErrorActionPreference = 'Stop'"];
  if (o.logPath) lines.push(`Start-Transcript -Path ${ps(o.logPath)} -Force | Out-Null`);
  lines.push("try {");
  if (o.installerPath) {
    lines.push(
      `  $exe = ${ps(o.installerPath)}`,
      "  $sig = Get-AuthenticodeSignature -FilePath $exe",
      "  if ($sig.Status -ne 'Valid') { throw \"installer signature is $($sig.Status), refusing to run it elevated\" }",
      "  $subject = $sig.SignerCertificate.Subject",
      "  if ($subject -notmatch 'Ascensio|ONLYOFFICE') { throw \"unexpected installer signer: $subject\" }",
      `  $p = Start-Process -FilePath $exe -ArgumentList @('/SILENT', '/DS_PORT=${String(Number(o.port) || 8080)}') -Wait -PassThru`,
      "  if ($p.ExitCode -ne 0) { throw \"installer exit code $($p.ExitCode)\" }",
    );
  }
  lines.push(
    `  $cfg = Join-Path ${ps(o.installDir)} 'config\\local.json'`,
    // ⚠️ 写这个文件**不能带 BOM**。PowerShell 5.1 的 `Set-Content -Encoding UTF8`
    // 带 BOM,而 local.json 要被 Node 侧 `JSON.parse` 读(见 readLocalJson 的注释)。
    // `UTF8Encoding($false)` 才是无 BOM 的 UTF-8。
    "  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)",
    "  if (-not (Test-Path $cfg)) { [System.IO.File]::WriteAllText($cfg, '{}', $utf8NoBom) }",
    "  $j = Get-Content -Path $cfg -Raw | ConvertFrom-Json",
    "  function Ensure($o, $n) { if ($null -eq $o.$n) { $o | Add-Member -NotePropertyName $n -NotePropertyValue ([pscustomobject]@{}) -Force }; return $o.$n }",
    "  $svc = Ensure $j 'services'",
    "  $co = Ensure $svc 'CoAuthoring'",
    "  $rf = Ensure $co 'request-filtering-agent'",
    "  $rf | Add-Member -NotePropertyName 'allowPrivateIPAddress' -NotePropertyValue $true -Force",
    "  $rf | Add-Member -NotePropertyName 'allowMetaIPAddress' -NotePropertyValue $true -Force",
    "  [System.IO.File]::WriteAllText($cfg, ($j | ConvertTo-Json -Depth 32), $utf8NoBom)",
    ...SERVICE_NAMES.map((s) => `  & sc.exe stop ${s} | Out-Null`),
    "  Start-Sleep -Seconds 3",
    ...[...SERVICE_NAMES].reverse().map((s) => `  & sc.exe start ${s} | Out-Null`),
    ...(o.markerPath ? [`  'OK' | Set-Content -Path ${ps(o.markerPath)}`] : []),
    o.logPath ? "} finally { Stop-Transcript | Out-Null }" : "} finally { }",
  );
  return lines.join("\r\n") + "\r\n";
}

/**
 * 提权 PowerShell：跑安装器（可选）→ 给 local.json 打开私网访问 → 重启两个服务。
 * 通过 `Start-Process -Verb RunAs -Wait` 弹一次 UAC；用户点「否」→ 抛错 → phase=error。
 * 成功与否看 marker 文件（提权进程的退出码拿不到）。
 */
async function runElevated(o: { installerPath: string | null; port: number | null; installDir: string }): Promise<void> {
  const dir = tempDir();
  await mkdir(dir, { recursive: true });
  // marker / 日志用一次性随机名：marker 是「脚本跑成功了吗」的唯一信号，固定名
  // 意味着用户态进程可以提前放一个假的进去骗过校验。
  const stamp = randomBytes(8).toString("hex");
  const marker = join(dir, `install-${stamp}.ok`);
  const logFile = join(dir, `install-${stamp}.log`);
  await unlink(marker).catch(() => {});

  const script = buildElevationCommand({ ...o, markerPath: marker, logPath: logFile });
  // 脚本**不落盘**。先写成 `install.ps1` 再用 `-File <路径>` 提权加载，等于把一份
  // 即将以管理员身份执行的文件放在**当前用户可写**的 `%TEMP%` 里：任何以该用户
  // 身份运行的进程（在 Mcode 里，这包括 Agent 自己跑出来的代码）都能在用户点下
  // 「本机安装」与 UAC 确认之间把它换掉 —— 一条从普通用户直通管理员的路。内联
  // `-EncodedCommand`（UTF-16LE base64）没有这个时间窗，顺带也解决了 PowerShell
  // 5.1 按 ANSI 读 .ps1 的编码问题（原先靠写 BOM 绕）。
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand','${encoded}')`,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(/canceled by the user|已取消/i.test(stderr) ? "UAC_DENIED" : `elevation failed (${code}): ${stderr.trim().slice(0, 200)}`));
    });
  });

  if (!(await exists(marker))) {
    let tail = "";
    try {
      tail = (await readFile(logFile, "utf8")).split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
    } catch {
      /* no log */
    }
    throw new Error(`install script failed${tail ? `: ${tail}` : ""}`);
  }
}

/**
 * 等 DS 起来。
 *
 * ## ⚠️ 每一轮都要把回落端口一起探,不能只盯 `/DS_PORT=` 请求的那一个
 *
 * 安装器**并不保证**用上我们请求的端口 —— 那个端口被占时它自己挪到 80 / 8080。
 * 于是会出现这样一种失败:DS 其实已经跑起来了,只是不在我们盯的那个端口上,
 * 我们白等满整个超时然后报「没有响应」;而用户点一下「重新检测」反倒立刻就好 ——
 * 因为 `detectLocal()` 走的 {@link findPort} 是**带回落的**。
 *
 * 两条路径对「端口在哪」的判断不一致,就是那个 bug 的现场。统一走 findPort 之后
 * 两边同源:以后再改候选顺序,改一处即可。
 *
 * ## 超时要带出服务的真实状态
 *
 * 「装完了但没响应」对用户没有任何可操作性。而「服务根本没注册」(安装器其实失败了)
 * 和「注册了但没在跑」(前置件没起来 / 端口冲突)是两种完全不同的处置 —— 把 `sc query`
 * 的结果拼进错误码,让上层能说人话。
 */
async function waitHealthy(port: number, timeoutMs = 360_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // 请求的端口优先,后面由 findPort 补上 8080 / 80 的回落。
  const preferred = [port, progress.port].filter((x): x is number => !!x);
  while (Date.now() < deadline) {
    const p = await findPort(preferred);
    if (p) {
      progress.port = p;
      return;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  // `missing` = 两个服务压根没注册上;`stopped` = 注册了但起不来。
  throw new Error(`DS_NOT_RESPONDING:${await queryService("DsDocServiceSvc")}`);
}
