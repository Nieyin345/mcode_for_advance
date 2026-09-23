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
 * ## 为什么是**快速隧道**(`--url`)而不是命名隧道
 *
 * 命名隧道要域名 + Cloudflare 账号 + `cloudflared tunnel login`,那是"部署"的量级。
 * 快速隧道不上账号、随机域名、用完即弃 —— 与"这个开关开着我就能用,关了就没了"正好
 * 对上。代价是域名每次变(UI 因此必须每次显示当前域名,而不是让人记住一个)。
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

/** 域名扫描:**只认 trycloudflare 的快速隧道域名**。 */
const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/** 等域名出现的上限。预检一般十几秒;给到 60 秒是为了容忍慢网络,又不至于让用户干等。 */
const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** 失败时随状态带出去的最后几行日志,让用户/我们能看出卡在哪。 */
const TAIL_LINES = 8;

/**
 * 找 cloudflared 可执行文件。真实实现见 {@link configureTunnelDeps};smoke 里能换掉。
 * 返回 null = 没装(状态会说明去哪儿装,而不是一句"启动失败")。
 */
export type FindCloudflared = () => string | null;

/** 起进程。注入是为了 smoke 能不联网。 */
export type SpawnTunnel = (exe: string, args: string[]) => ChildProcess;

let findCloudflared: FindCloudflared = defaultFindCloudflared;
let spawnTunnel: SpawnTunnel = (exe, args) =>
  nodeSpawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
  spawnTunnel = (exe, args) =>
    nodeSpawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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

/* ────────────────────────────── 单例状态 ────────────────────────────── */

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
export function tunnelStatus(): TunnelStatus {
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

/** 起隧道。已就绪/正在起时是幂等的(不会起第二条)。 */
export function startTunnel(localPort: number): TunnelStatus {
  // 幂等:已经在起/已经好/正在重连,都不再起第二条。
  if (status.phase === "starting" || status.phase === "ready" || status.phase === "reconnecting") {
    return tunnelStatus();
  }
  // 记下"这条隧道该活着" + 这次是用户主动开的(重试计数归零)。
  livePort = localPort;
  reconnectAttempt = 0;
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
  const args = ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"];
  log.info(`tunnel: starting ${exe} tunnel --url http://127.0.0.1:${localPort}`);

  let proc: ChildProcess;
  try {
    proc = spawnTunnel(exe, args);
  } catch (err) {
    status = { phase: "failed", url: null, error: `启动 cloudflared 失败:${(err as Error).message}` };
    return tunnelStatus();
  }
  child = proc;

  const onLine = (raw: string): void => {
    const line = raw.trim();
    if (!line) return;
    pushTail(line);
    if (status.phase !== "starting") return;
    const found = QUICK_TUNNEL_RE.exec(line);
    if (!found) return;
    clearTimer();
    status = { phase: "ready", url: found[0], error: null };
    // **连上了就把重试计数归零** —— 否则"连上→掉→连上→掉"跑几轮之后,退避会一路
    // 涨到 30 秒,而每一次其实都只是短暂抖动。归零让每次新断开都从 1 秒重新开始。
    reconnectAttempt = 0;
    log.info(`tunnel: ready at ${found[0]}`);
  };

  proc.stdout?.on("data", (chunk: Buffer) => chunk.toString("utf-8").split(/\r?\n/).forEach(onLine));
  proc.stderr?.on("data", (chunk: Buffer) => chunk.toString("utf-8").split(/\r?\n/).forEach(onLine));
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
  log.warn(`tunnel: disconnected (exit=${exitCode ?? "null"}); reconnecting in ${delay}ms (#${reconnectAttempt})`);
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // 这一拍里用户可能已经停掉/换端口了 —— 那就别再拉起来。
    if (livePort !== port) return;
    // `status` 此刻是 reconnecting,`startTunnel` 的幂等闸门认这个状态,所以先松开它,
    // 否则下面那一下会被"已经在重连"的判定直接弹回来、永远连不上。
    status = { phase: "stopped", url: null, error: null };
    startTunnel(port);
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
  log.info("tunnel: stopped");
}

/** 停隧道。幂等。 */
export function stopTunnel(): TunnelStatus {
  // **先把"它该活着"的标志清掉,再杀。** 反过来的话,杀出来的那个 close 事件到达时
  // `livePort` 还在,会被当成"隧道掉了"而触发重连 —— 用户点了停止,它自己又起来了。
  livePort = null;
  reconnectAttempt = 0;
  clearReconnectTimer();
  killChild();
  if (status.phase !== "stopped") status = { phase: "stopped", url: null, error: null };
  return tunnelStatus();
}

/** 随 app 退出收摊。 */
export function disposeTunnel(): void {
  stopTunnel();
}
