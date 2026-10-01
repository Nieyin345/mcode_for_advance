/**
 * **一键公网隧道** —— Mcode 自己起 cloudflared，把公网域名交出来。
 *
 * ## 它替用户省掉的那几步
 *
 * 公网 MCP 端点(MCP 只绑 127.0.0.1)要能被 ChatGPT 够着,必须有一条公网隧道指过来。
 * 手工那条路是三步:复制端口 → 去终端跑 `cloudflared tunnel --url ...` → 从它滚动的
 * 日志里找出域名。而快速隧道的域名**每次重启都变**,所以每次启动都得重做一遍。
 *
 * 这个模块把那三步收成一个动作:起进程、从输出里抠出域名、把状态交给 UI 轮询。
 *
 * ## 两种模式:快速隧道与**命名隧道**
 *
 * **`quick`(默认,原有行为)**:`cloudflared tunnel --url http://127.0.0.1:<端口>`。
 * 不上账号、随机域名、用完即弃 —— 与"这个开关开着我就能用,关了就没了"正好对上。
 * 代价是域名每次变(UI 因此必须每次显示当前域名,而不是让人记住一个),每次都要去
 * ChatGPT 里重填一遍地址。
 *
 * **`named`(新增)**:用户在 Cloudflare 建好一条命名隧道、配好 public hostname,
 * 把 **Tunnel Token** 交给我们,这里只负责 `cloudflared tunnel run`。换来的是
 * **域名固定**:填一次就不用再动,还能在 Cloudflare 侧叠 Access / WAF 策略。
 *
 * 两者**并存**,不是替换:quick 那条路一行没动,默认仍是它。
 *
 * ### named 模式的三处不一样
 *
 * 1. **域名不来自日志。** 命名隧道的域名是用户在 Cloudflare 配的,cloudflared 的输出里
 *    压根不会出现它 —— 所以 {@link QUICK_TUNNEL_RE} 那条正则在这个模式下永远匹配不上。
 *    就绪判定改成认**连接注册**那行(`Registered tunnel connection`),域名直接用配置值。
 * 2. **token 走环境变量,不走命令行。** `--token <值>` 会把它暴露在进程列表里
 *    (任务管理器 / `ps` / 其它用户都看得到),而那串 token 等于这条隧道的控制权。
 *    cloudflared 认 `TUNNEL_TOKEN` 环境变量,所以走它。日志里也只打码后几位。
 * 3. **token 不对不重连。** 鉴权失败重试 6 次没有任何意义,只会把真正的原因埋进
 *    "重连中…"里。认出这一类就**当场判死**并直说"token 不对"。
 *
 * ## 抠域名:为什么盯着 stderr
 *
 * `cloudflared` 的日志走 **stderr**,而且开头是一大段连通性预检(几十行)。域名出现
 * 在预检之后,形如:
 *
 *     INF |  https://xxxx-yyyy.trycloudflare.com    |
 *
 * 所以是**逐行扫、不假设位置**,配一个总超时兜住"一直不出现"。不去解析预检那些
 * 行的话,把整段输出留着只做正则匹配也可以 —— 但那样超时路上就没法告诉用户
 * "它卡在哪一步了"。逐行 + 保留最后几行,失败时能说清。
 *
 * ## 这个文件是**纯**的
 *
 * 不 import electron、不 import db。找不找得到 cloudflared、往哪儿找,都可以注入
 * (`configureTunnelDeps`),这样无头 smoke 能塞一个假的 spawn、喂一段**仿真日志**,
 * 把"抠域名"这条最容易写错的路断言一遍 —— 不用真的联网起隧道。
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { log } from "@main/lib/logger.js";
import { killTree } from "@main/lib/spawnRun.js";

/** 隧道的生命周期状态。`failed` 带 `error`;`ready` 带 `url`。 */
export type TunnelPhase = "stopped" | "starting" | "ready" | "reconnecting" | "failed";

export interface TunnelStatus {
  phase: TunnelPhase;
  /** 公网域名(形如 `https://xxx.trycloudflare.com`);没就绪时为 null。**不含路径** ——
   *  拼 `/mcp/<密钥>` 是 UI 那侧的事。 */
  url: string | null;
  /** 失败原因(人话);非 failed 时为 null。 */
  error: string | null;
}

/** 隧道模式。`quick` = 随机 trycloudflare 域名;`named` = 用户自己的域名 + Tunnel Token。 */
export type TunnelMode = "quick" | "named";

/** 起隧道要的配置。`quick` 只用 mode;`named` 两项都必填。 */
export interface TunnelConfig {
  mode: TunnelMode;
  /** Cloudflare 的 Tunnel Token(named 必填)。**不进命令行、不进日志。** */
  token?: string;
  /** 用户在 Cloudflare 配的 public hostname,如 `mcp.example.com`(named 必填,**不带协议**)。 */
  hostname?: string;
}

/** 域名扫描:**只认 trycloudflare 的快速隧道域名**(仅 quick 模式用得上)。 */
const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/**
 * named 模式的就绪信号:cloudflared 每与一个边缘节点建好连接就打一行
 * `Registered tunnel connection connIndex=0 …`。第一条出现就说明**这条隧道通了**。
 * 不同版本的措辞略有出入,所以认得宽一点(两个词都在即可)。
 */
const NAMED_READY_RE = /registered tunnel connection|connection .* registered/i;

/**
 * named 模式的**致命**信号:token 不对。重试多少次都一样,所以认出来就当场判死。
 * cloudflared 对坏 token 的说法有好几种,这里把见得到的都收进来。
 */
const NAMED_AUTH_FAIL_RE =
  /tunnel token is not valid|provided token is not valid|invalid tunnel (token|credentials|secret)|failed to parse (the )?token|token is invalid/i;
/**
 * 「Unauthorized」只在**报错行**里才算(token 被吊销 / 隧道被删时 cloudflared 打的是
 * `ERR Register tunnel error from server side error="Unauthorized: …"`)。
 *
 * ⚠️ 这里原先还有一个裸的 `401` —— 而 cloudflared 的每行日志都带十六进制的
 * tunnelID / connection UUID,里面出现 "401" 的概率并不小(一条 UUID 约 0.7%),
 * 一旦撞上就会把**正常**的隧道当成坏 token 当场杀掉,而且不重连。
 * 另外 cloudflared 对坏 token 的真实原话是 `Provided Tunnel token is not valid.`
 * (中间有个 Tunnel),原先那条 `provided token is not valid` 匹配不上它。
 */
const NAMED_UNAUTHORIZED_RE = /\bunauthorized\b/i;
const ERROR_LINE_RE = /\bERR\b|error=/;

/** hostname 打头的协议/斜杠去掉 —— 用户十有八九会把 `https://` 一起粘进来。 */
function normalizeHostname(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** token 只在日志里露尾 4 位,其余打码。 */
function maskToken(token: string): string {
  return token.length <= 4 ? "****" : `****${token.slice(-4)}`;
}

/** 等域名出现的上限。预检一般十几秒;给到 60 秒是为了容忍慢网络,又不至于让用户干等。 */
const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** 失败时随状态带出去的最后几行日志,让用户/我们能看出卡在哪。 */
const TAIL_LINES = 8;

/**
 * 找 cloudflared 可执行文件。真实实现见 {@link configureTunnelDeps};smoke 里能换掉。
 * 返回 null = 没装(状态会说明去哪儿装,而不是一句"启动失败")。
 */
export type FindCloudflared = () => string | null;

/** 起进程。注入是为了 smoke 能不联网。`env` 是 named 模式用来递 `TUNNEL_TOKEN` 的。 */
export type SpawnTunnel = (exe: string, args: string[], env?: NodeJS.ProcessEnv) => ChildProcess;

/** 生产用的 spawn。named 模式会带 `env`(里面有 TUNNEL_TOKEN),quick 模式不带。 */
function defaultSpawnTunnel(exe: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  return nodeSpawn(exe, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
  });
}

let findCloudflared: FindCloudflared = defaultFindCloudflared;
let spawnTunnel: SpawnTunnel = defaultSpawnTunnel;
/** 等域名的上限。可注入 —— smoke 要能把它调成一瞬间来测超时那条分支。 */
let readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS;

/** 装配 —— 只由测试用。生产走下面两个默认实现。 */
export function configureTunnelDeps(deps: {
  findCloudflared?: FindCloudflared;
  spawnTunnel?: SpawnTunnel;
  readyTimeoutMs?: number;
}): void {
  if (deps.findCloudflared) findCloudflared = deps.findCloudflared;
  if (deps.spawnTunnel) spawnTunnel = deps.spawnTunnel;
  if (deps.readyTimeoutMs !== undefined) readyTimeoutMs = deps.readyTimeoutMs;
}

/** 还原成生产实现(测试收尾)。 */
export function resetTunnelDeps(): void {
  findCloudflared = defaultFindCloudflared;
  spawnTunnel = defaultSpawnTunnel;
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS;
}

/**
 * 默认的查找:先看 PATH 上有没有(`cloudflared` / Windows 的 `.exe`),再退到
 * **已知的安装位置**。
 *
 * 为什么要有第二步:Windows 上 `winget install cloudflared` 装到 `Program Files`,
 * 但不一定进 PATH —— 用户机器上就是这么装的(见会话记录)。只认 PATH 的话,明明装了
 * 却报"没找到",而用户看不出该动哪儿。
 */
function defaultFindCloudflared(): string | null {
  const exeNames = process.platform === "win32" ? ["cloudflared.exe", "cloudflared"] : ["cloudflared"];
  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const name of exeNames) {
      const candidate = `${dir.replace(/[\\/]+$/, "")}${process.platform === "win32" ? "\\" : "/"}${name}`;
      if (existsSync(candidate)) return candidate;
    }
  }
  const known =
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
          "C:\\Program Files\\cloudflared\\cloudflared.exe",
        ]
      : ["/usr/local/bin/cloudflared", "/opt/homebrew/bin/cloudflared", "/usr/bin/cloudflared"];
  return known.find((p) => existsSync(p)) ?? null;
}

/* ────────────────────────────── 实例 ────────────────────────────── */

/** 一条隧道的操作面。{@link createTunnelManager} 造一份,彼此**完全独立**(各有各的进程、
 *  状态、重连计数)。 */
export interface TunnelManager {
  start: (localPort: number, isReconnect?: boolean, config?: TunnelConfig) => TunnelStatus;
  stop: () => TunnelStatus;
  status: () => TunnelStatus;
  dispose: () => void;
}

/**
 * 造一条独立的隧道。
 *
 * 原先整个文件就是**一个**单例 —— 公网 MCP 用它。手机伴侣的自有域名要能**不依赖**
 * 「开放远程控制」单独跑(那是两样东西:一个是给 ChatGPT 的 MCP,一个是手机远程),
 * 所以把单例状态收进工厂里:默认那份({@link startTunnel} 等导出)照旧给 MCP,
 * 手机那边另造一份(`main/mobile/mobileTunnel.ts`)。两份共用 {@link configureTunnelDeps}
 * 注入的查找 / spawn / 超时。`label` 只用于日志前缀。
 */
export function createTunnelManager(label = "tunnel"): TunnelManager {


  let child: ChildProcess | null = null;
  let readyTimer: NodeJS.Timeout | null = null;
  let status: TunnelStatus = { phase: "stopped", url: null, error: null };
  let tail: string[] = [];

  /**
   * 重连用:当前这条隧道是要连到哪个端口,以及已经重试了几次。
   *
   * `port` 是**"这条隧道该活着"的标志** —— 它非 null 就说明用户开着开关。`stopTunnel()`
   * 把它清成 null,于是"用户主动停"和"隧道自己掉"在重连逻辑里能分开(前者绝不重连)。
   */
  let livePort: number | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;

  /**
   * 当前这条隧道**用的是哪套配置**。重连要照原样再起一次,所以必须记住 ——
   * 只靠 `livePort` 的话,named 模式重连时会退化成 quick(端口对了、模式丢了)。
   *
   * 与 `livePort` 同生共死:`stopTunnel()` 把它复位成 quick。
   */
  let liveConfig: TunnelConfig = { mode: "quick" };

  /** 重连退避:1s → 2s → 4s … 封顶 30s。**不无限重试** —— 见 {@link MAX_RECONNECT_ATTEMPTS}。 */
  const RECONNECT_BASE_MS = 1_000;
  const RECONNECT_MAX_MS = 30_000;
  /**
   * 最多连着重试几次就放弃(把状态标成 failed)。
   *
   * 为什么要有上限:cloudflared 起不来通常是**环境问题**(没装、网络被墙、端口被占),
   * 一直重试只会刷日志、还让 UI 一直显示"重连中"给人虚假的希望。到点就明确报失败,
   * 用户能看到原因、能自己处理。
   */
  const MAX_RECONNECT_ATTEMPTS = 6;

  /** 当前状态快照。UI 轮询它。 */
  function tunnelStatus(): TunnelStatus {
    return { ...status };
  }

  function pushTail(line: string): void {
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
  }

  function clearTimer(): void {
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  }

  /** 起隧道。已就绪/正在起时是幂等的(不会起第二条)。
   *
   *  `isReconnect` 是**重连回调内部用的** —— 见下面 `reconnectAttempt` 那段:
   *  用户主动开才把重试计数归零,重连进来必须保留,否则上限永远到不了。 */
  function startTunnel(localPort: number, isReconnect = false, config?: TunnelConfig): TunnelStatus {
    // 幂等:已经在起/已经好/正在重连,都不再起第二条。
    if (status.phase === "starting" || status.phase === "ready" || status.phase === "reconnecting") {
      return tunnelStatus();
    }
    // 配置只在**用户主动开**那次采纳;重连沿用 `liveConfig`(见它的注释)。
    if (!isReconnect) liveConfig = config ?? { mode: "quick" };
    const cfg = liveConfig;

    // named 的两项必填**在起进程之前**查掉 —— 少一项就起不来,让 cloudflared 用一段
    // 看不懂的错去报它,等于把一个一眼能说清的配置问题变成玄学。
    if (cfg.mode === "named") {
      const token = (cfg.token ?? "").trim();
      const host = normalizeHostname(cfg.hostname ?? "");
      if (!token) {
        status = { phase: "failed", url: null, error: "命名隧道缺 Tunnel Token:到 Cloudflare Zero Trust → Networks → Tunnels 里复制那串 token 填进来。" };
        return tunnelStatus();
      }
      if (!host) {
        status = { phase: "failed", url: null, error: "命名隧道缺公网域名:填你在 Cloudflare 那条隧道的 Public Hostname(如 mcp.example.com)。" };
        return tunnelStatus();
      }
    }

    // 记下"这条隧道该活着"。
    livePort = localPort;
    // ⚠️ **只有"用户主动开"才把重试计数归零。**
    //
    // 这里原先无条件 `reconnectAttempt = 0` —— 而重连回调最后也是调 `startTunnel`,
    // 于是每一轮重连**都把自己刚加的那一次计数抹掉**,`> MAX_RECONNECT_ATTEMPTS`
    // 永远不成立 = **无限重试**(而注释还写着"不无限重试",是句谎话)。
    // (2026-09-24 自查发现;tunnel-manager-smoke 原来只测了一次重连,测不到上限。)
    if (!isReconnect) reconnectAttempt = 0;
    clearReconnectTimer();

    const exe = findCloudflared();
    if (!exe) {
      status = {
        phase: "failed",
        url: null,
        error:
          "没找到 cloudflared。请先安装它(Windows: winget install --id Cloudflare.cloudflared 或去 " +
          "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 下载),装好后重试。",
      };
      return tunnelStatus();
    }

    tail = [];
    status = { phase: "starting", url: null, error: null };

    const named = cfg.mode === "named";
    const namedHost = named ? normalizeHostname(cfg.hostname ?? "") : "";
    // named:`tunnel run`,token 走环境变量(见文件头第 2 点,别放进 argv)。
    // quick:原样不动。
    const args = named
      ? ["--no-autoupdate", "tunnel", "run"]
      : ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"];
    const env = named ? { ...process.env, TUNNEL_TOKEN: (cfg.token ?? "").trim() } : undefined;
    log.info(
      named
        ? `${label}: starting ${exe} tunnel run (named, host=${namedHost}, token=${maskToken((cfg.token ?? "").trim())})`
        : `${label}: starting ${exe} tunnel --url http://127.0.0.1:${localPort}`,
    );

    let proc: ChildProcess;
    try {
      proc = spawnTunnel(exe, args, env);
    } catch (err) {
      status = { phase: "failed", url: null, error: `启动 cloudflared 失败:${(err as Error).message}` };
      return tunnelStatus();
    }
    child = proc;

    const markReadyFrom = (text: string): void => {
      if (status.phase !== "starting") return;
      // named:域名不在日志里(文件头第 1 点),认"连接注册"那行,域名用配置值。
      // quick:老样子,从日志里抠 trycloudflare 域名。
      const url = named
        ? (NAMED_READY_RE.test(text) ? `https://${namedHost}` : null)
        : (QUICK_TUNNEL_RE.exec(text)?.[0] ?? null);
      if (url === null) return;
      clearTimer();
      status = { phase: "ready", url, error: null };
      // **连上了就把重试计数归零** —— 否则"连上→掉→连上→掉"跑几轮之后,退避会一路
      // 涨到 30 秒,而每一次其实都只是短暂抖动。归零让每次新断开都从 1 秒重新开始。
      reconnectAttempt = 0;
      log.info(`${label}: ready at ${url}`);
    };
    /** token 不对 → 当场判死(文件头第 3 点),不进重连。 */
    const failFatalIfAuth = (text: string): boolean => {
      if (!named || status.phase === "failed") return false;
      const fatal = NAMED_AUTH_FAIL_RE.test(text) || (NAMED_UNAUTHORIZED_RE.test(text) && ERROR_LINE_RE.test(text));
      if (!fatal) return false;
      const reason =
        "Cloudflare 拒绝了这串 Tunnel Token(鉴权失败)。重连多少次都一样,所以直接停了。" +
        "\n到 Zero Trust → Networks → Tunnels 里重新复制一遍 token —— 注意要复制**整串**,它很长。" +
        tailNote();
      // 顺序同超时那条:**先收进程、清掉"该活着"的标志,再写状态**,否则会被
      // close 处理器的重连分支或 stopTunnel 的复位盖掉。
      livePort = null;
      liveConfig = { mode: "quick" };
      clearReconnectTimer();
      killChild();
      status = { phase: "failed", url: null, error: reason };
      return true;
    };
    const onLine = (raw: string): void => {
      const line = raw.trim();
      if (!line) return;
      pushTail(line);
      if (failFatalIfAuth(line)) return;
      markReadyFrom(line);
    };
    // 一个 data 块不一定以换行结尾:域名正好被切在两块之间时,逐块 split 会把它拆成两半,
    // 谁都匹配不上 —— 白等 readyTimeoutMs 再重连(快速隧道还会换个域名)。所以除了逐行
    // 处理,再拿「上一块末尾一截 + 这一块」找一次域名(正则不跨空白/换行,拼接不会误配)。
    const chunkReader = (): ((chunk: Buffer | string) => void) => {
      let carry = "";
      return (chunk) => {
        const text = chunk.toString();
        text.split(/\r?\n/).forEach(onLine);
        markReadyFrom(carry + text);
        carry = text.slice(-256);
      };
    };
    proc.stdout?.on("data", chunkReader());
    proc.stderr?.on("data", chunkReader());
    proc.on("error", (err) => {
      if (child !== proc) return; // 同上:迟到的事件不属于当前隧道
      clearTimer();
      child = null;
      // **进程出错也走重连**(同 close 那条):一次 spawn 失败往往是一时的(句柄没释放、
      // 杀软拦了一下),不该直接判死。只有用户主动停(livePort 为 null)才落 failed。
      if (livePort !== null) {
        scheduleReconnect(livePort, null, `cloudflared 进程出错:${err.message}`);
        return;
      }
      status = { phase: "failed", url: null, error: `cloudflared 进程出错:${err.message}` };
    });
    proc.on("close", (code) => {
      // ⚠️ **先认这是不是当前那个进程。** 用户"停 → 立刻重开"时,旧进程的 close
      // 会**迟到**(killTree 发信号到真正退出有时间差),那时全局 status 说的已经是
      // **新隧道**的事 —— 不看这一眼就会把刚起来的新隧道误判成 failed。
      if (child !== proc) return;
      clearTimer();
      child = null;

      // **隧道掉了要自己连回来**(2026-09-24,源码审查第 3 条)。
      //
      // 原先这里只把状态标成 failed 就完了 —— 用户得回设置页手动再点一次"开启隧道",
      // 而快速隧道的域名**每次都会变**,于是他还得把新地址重填进 ChatGPT。断了不重连
      // 等于"这条通路随时会静默失效"。
      //
      // `livePort` 非 null 才是"用户还开着它" —— `stopTunnel()` 会把它清掉,所以
      // 用户主动停的那次**不会**触发重连(close 到达时 livePort 已经是 null 了)。
      if (livePort !== null) {
        scheduleReconnect(livePort, code);
        return;
      }

      if (status.phase === "ready") {
        status = { phase: "failed", url: null, error: "隧道已断开(cloudflared 退出)。" + tailNote() };
      } else if (status.phase === "starting") {
        status = {
          phase: "failed",
          url: null,
          error: `cloudflared 启动后退出(exit=${code ?? "null"})。` + tailNote(),
        };
      }
    });

    readyTimer = setTimeout(() => {
      if (status.phase !== "starting") return;
      const reason = `等了 ${readyTimeoutMs / 1000} 秒还没拿到公网域名。` + tailNote();
      // ⚠️ 顺序要紧:**先把进程收掉,再改状态**。反过来会被 `stopTunnel()` 里那句
      // "重置成 stopped" 覆盖 —— 用户就只看到 stopped,永远看不到"为什么超时"。
      // (这个坑是 tunnel-manager-smoke 的超时断言抓出来的。)
      killChild();
      // **超时也排重连**:起得来(进程没报错)却拿不到域名,多半是 Cloudflare 那边一时
      // 抽风或有残余连接 —— 重试几轮是对的,比直接判死更符合用户的期待。
      // 只有 `livePort` 还在(用户没停)才重连;`killChild` 之后 close 事件会晚一点到,
      // 那一次因为 `child` 已经不是它了,会被 close 处理器开头的守卫挡掉,不会重复排队。
      if (livePort !== null) {
        scheduleReconnect(livePort, null, reason);
        return;
      }
      status = { phase: "failed", url: null, error: reason };
    }, readyTimeoutMs);

    return tunnelStatus();
  }

  /** 失败时把最后几行日志附上,好让用户看出卡在哪一步(预检?鉴权?)。 */
  function tailNote(): string {
    if (tail.length === 0) return "";
    return `\n最后几行输出:\n${tail.slice(-3).join("\n")}`;
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * 排一次重连(指数退避)。超过 {@link MAX_RECONNECT_ATTEMPTS} 就放弃、标 failed。
   *
   * ⚠️ **只在 `livePort` 还是那个端口时才连** —— 用户在这段等待里点了"停止"或"重开
   * 到别的端口",这个待发的重连就该作废(否则会把刚停掉的隧道又拉起来)。
   */
  function scheduleReconnect(port: number, exitCode: number | null, reasonPrefix?: string): void {
    reconnectAttempt += 1;
    if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      status = {
        phase: "failed",
        url: null,
        error:
          (reasonPrefix ?? `隧道断开(exit=${exitCode ?? "null"})`) +
          `\n重连了 ${MAX_RECONNECT_ATTEMPTS} 次都没成功 —— 多半是环境问题` +
          `(cloudflared 没装 / 网络不通 / 端口被占)。修好后重新点「开启隧道」。` +
          tailNote(),
      };
      livePort = null; // 别再重试了,等用户手动来
      return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_MS);
    status = {
      phase: "reconnecting",
      url: null,
      // **把断开原因带上**(含 cloudflared 最后几行)—— 重连的信息不该比 failed 少:
      // 用户要判断"这是网络抖了一下,还是它压根起不来",看的正是这几行。
      error:
        (reasonPrefix ?? `隧道断开(exit=${exitCode ?? "null"})`) +
        `,${Math.round(delay / 1000)} 秒后重连(第 ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} 次)…` +
        tailNote(),
    };
    log.warn(`${label}: disconnected (exit=${exitCode ?? "null"}); reconnecting in ${delay}ms (#${reconnectAttempt})`);
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // 这一拍里用户可能已经停掉/换端口了 —— 那就别再拉起来。
      if (livePort !== port) return;
      // `status` 此刻是 reconnecting,`startTunnel` 的幂等闸门认这个状态,所以先松开它,
      // 否则下面那一下会被"已经在重连"的判定直接弹回来、永远连不上。
      status = { phase: "stopped", url: null, error: null };
      // `isReconnect = true` —— 保住这次重试的计数,否则上限永远到不了(见 startTunnel)。
      startTunnel(port, true);
    }, delay);
    reconnectTimer.unref();
  }

  /** 只杀进程、不动状态。`stopTunnel`(重置状态)与超时分支(要保住错误)都用它。 */
  function killChild(): void {
    clearTimer();
    const proc = child;
    child = null;
    if (!proc) return;
    // 复用 spawnRun 那套进程树杀法:Windows 上只 kill 父进程会留下孙进程。
    killTree(proc);
    log.info(`${label}: stopped`);
  }

  /** 停隧道。幂等。 */
  function stopTunnel(): TunnelStatus {
    // **先把"它该活着"的标志清掉,再杀。** 反过来的话,杀出来的那个 close 事件到达时
    // `livePort` 还在,会被当成"隧道掉了"而触发重连 —— 用户点了停止,它自己又起来了。
    livePort = null;
    // 配置跟着复位:下一次"开"必须自己带配置进来,不吃上一轮的残留
    // (否则关掉命名隧道、再点一次快速隧道,会悄悄还用着上次那串 token)。
    liveConfig = { mode: "quick" };
    reconnectAttempt = 0;
    clearReconnectTimer();
    killChild();
    if (status.phase !== "stopped") status = { phase: "stopped", url: null, error: null };
    return tunnelStatus();
  }

  /** 随 app 退出收摊。 */
  function disposeTunnel(): void {
    stopTunnel();
  }

  return {
    start: startTunnel,
    stop: stopTunnel,
    status: tunnelStatus,
    dispose: disposeTunnel,
  };
}

/* ─────────────── 默认那一份(公网 MCP 用;导出面与原先一致) ─────────────── */

const defaultTunnel = createTunnelManager("tunnel");

/** 当前状态快照。UI 轮询它。 */
export function tunnelStatus(): TunnelStatus {
  return defaultTunnel.status();
}

/** 起隧道。已就绪/正在起时是幂等的(不会起第二条)。 */
export function startTunnel(localPort: number, isReconnect = false, config?: TunnelConfig): TunnelStatus {
  return defaultTunnel.start(localPort, isReconnect, config);
}

/** 停隧道。幂等。 */
export function stopTunnel(): TunnelStatus {
  return defaultTunnel.stop();
}

/** 随 app 退出收摊。 */
export function disposeTunnel(): void {
  defaultTunnel.dispose();
}
