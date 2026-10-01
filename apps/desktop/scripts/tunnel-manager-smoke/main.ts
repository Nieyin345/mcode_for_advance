/**
 * Headless smoke for `main/providers/bridge/tunnelManager.ts`.
 *
 * ## What this covers, and what it deliberately doesn't
 *
 * The tunnel's job is: spawn cloudflared → find the public domain in its log →
 * report it. The **one thing that's actually easy to get wrong** is the domain
 * extraction — cloudflared prints a long connectivity pre-check *before* the
 * domain, and the domain line has a specific shape. So this suite feeds a
 * **captured, realistic** chunk of cloudflared output (the pre-check block the
 * user pasted, verbatim in spirit) and asserts we pull the right thing out of it.
 *
 * Everything is injected: a fake `findCloudflared` and a fake `spawnTunnel` that
 * returns a controllable fake child. **No real process, no network.**
 *
 * Not covered (by design):
 *  - the real cloudflared binary / real trycloudflare. That's the end-to-end run.
 *  - `killTree` actually terminating a real process tree (that's `spawnRun`'s own
 *    territory; here `stopTunnel` is asserted by state, with a fake child).
 *
 * Run: scripts/tunnel-manager-smoke/run.sh
 */
import { EventEmitter } from "node:events";
import {
  configureTunnelDeps,
  createTunnelManager,
  resetTunnelDeps,
  startTunnel,
  stopTunnel,
  tunnelStatus,
} from "@main/providers/bridge/tunnelManager.js";

let checks = 0;
let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    passed++;
    return;
  }
  failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { expected, got: actual });
}

/* ── 假进程:能推 stdout/stderr、能触发 close ─────────────────────── */
class FakeProc extends EventEmitter {
  // ⚠️ **pid 必须是 undefined。** `killTree` 在 win32 上会拿 pid 去
  // `spawn("taskkill", ["/pid", <pid>, "/T", "/F"])` —— 给一个真数字(比如 4242)
  // 就等于让这个 smoke **真的去杀系统上那个 pid 的进程树**。undefined 走的是
  // `child.kill()` 那条安全分支。
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean {
    this.exitCode = 0;
    return true;
  }
  /** 往 stderr 推一段(cloudflared 的日志走 stderr)。 */
  emitLog(text: string): void {
    this.stderr.emit("data", Buffer.from(text, "utf8"));
  }
  close(code: number): void {
    this.exitCode = code;
    this.emit("close", code);
  }
}

let procs: FakeProc[] = [];
let spawnArgs: { exe: string; args: string[] }[] = [];

/* ── 场景 1:cloudflared 装在已知位置,日志里带域名 ─────────────────── */
procs = [];
spawnArgs = [];
configureTunnelDeps({
  findCloudflared: () => "C:\\fake\\cloudflared.exe",
  spawnTunnel: (exe, args) => {
    spawnArgs.push({ exe, args });
    const p = new FakeProc();
    procs.push(p);
    return p as unknown as import("node:child_process").ChildProcess;
  },
});

startTunnel(54321);
eq("起隧道后 phase=starting", tunnelStatus().phase, "starting");
eq("spawn 用的可执行文件是找到的那个", spawnArgs[0]?.exe, "C:\\fake\\cloudflared.exe");
eq("参数带 --url 指向本机端口", spawnArgs[0]?.args, [
  "tunnel",
  "--url",
  "http://127.0.0.1:54321",
  "--no-autoupdate",
]);

/* 先喂用户贴过的那种**预检块** —— 里面**不该**被误认成域名。 */
procs[0].emitLog(`2026-09-22T18:55:22Z INF +-------------------------------+
2026-09-22T18:55:22Z INF |  DNS Resolution    region1.v2.argotunnel.com  PASS    DNS Resolved successfully               |
2026-09-22T18:55:22Z INF |  UDP Connectivity  region2.v2.argotunnel.com  FAIL    QUIC connection failed                  |
2026-09-22T18:55:22Z INF |  Cloudflare API    api.cloudflare.com:443     PASS    API is reachable                        |
2026-09-22T18:55:22Z INF |  SUMMARY: Environment ready with degraded transport. cloudflared will proceed using 'http2'. |
`);
eq("预检块不产生域名(还没就绪)", tunnelStatus().phase, "starting");
eq("…url 仍为空", tunnelStatus().url, null);

/* 再喂真正的域名行 —— 这才是要抠的。 */
procs[0].emitLog(`2026-09-22T18:55:24Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-09-22T18:55:26Z INF +--------------------------------------------------------------------------------------------+
2026-09-22T18:55:26Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-09-22T18:55:26Z INF |  https://yrs-cingular-guy-condition.trycloudflare.com                                       |
2026-09-22T18:55:26Z INF +--------------------------------------------------------------------------------------------+
`);
eq("抠出域名后 phase=ready", tunnelStatus().phase, "ready");
eq("…url 是那个 trycloudflare 域名", tunnelStatus().url, "https://yrs-cingular-guy-condition.trycloudflare.com");
eq("…没有多余的错误", tunnelStatus().error, null);

/* 就绪后再起一次是幂等的(不会起第二条)。 */
const beforeCount = procs.length;
startTunnel(54321);
eq("已就绪时重复 start 不再 spawn", procs.length, beforeCount);

/* ── stop:真的 kill,状态回 stopped ─────────────────────────────── */
const stoppedProc = procs[0];
stopTunnel();
eq("stop 后 phase=stopped", tunnelStatus().phase, "stopped");
eq("…url 清空", tunnelStatus().url, null);

/* ⚠️ kill 之后 close 事件才到 —— 不许把状态改回 failed。
   这是真 race:killTree 与进程真正退出之间有时差,close 处理器如果只看
   "曾经 ready 过"就会把用户的主动 stop 误报成"隧道断了"。 */
stoppedProc.close(0);
eq("stop 之后迟到的 close 不改状态(仍是 stopped)", tunnelStatus().phase, "stopped");
eq("…也不会冒出错误信息", tunnelStatus().error, null);

/* ⚠️ **更隐蔽的那个 race:停 → 立刻重开,旧进程的 close 迟到。**
   这时全局 status 说的是**新隧道**的事,旧进程的 close 如果不管自己是谁,就会把
   刚起来的新隧道打成 failed。断言:重开后旧进程 close 到达,新隧道不受影响。 */
procs = [];
configureTunnelDeps({
  findCloudflared: () => "cloudflared",
  spawnTunnel: () => {
    const p = new FakeProc();
    procs.push(p);
    return p as unknown as import("node:child_process").ChildProcess;
  },
});
startTunnel(9);
const oldProc = procs[0];
oldProc.emitLog("https://first-tunnel.trycloudflare.com");
eq("(重开前)第一条隧道已就绪", tunnelStatus().url, "https://first-tunnel.trycloudflare.com");
stopTunnel();
startTunnel(9);
const newProc = procs[1];
newProc.emitLog("https://second-tunnel.trycloudflare.com");
eq("第二条隧道已就绪", tunnelStatus().url, "https://second-tunnel.trycloudflare.com");
oldProc.close(0); // 旧进程的 close **迟到**
eq("旧进程迟到的 close 不覆盖新隧道状态", tunnelStatus().phase, "ready");
eq("…新隧道域名还在", tunnelStatus().url, "https://second-tunnel.trycloudflare.com");
stopTunnel();

/* ── 场景 2:没装 cloudflared → 明确说清怎么办 ───────────────────── */
procs = [];
configureTunnelDeps({ findCloudflared: () => null, spawnTunnel: (exe, args) => {
  spawnArgs.push({ exe, args });
  const p = new FakeProc();
  procs.push(p);
  return p as unknown as import("node:child_process").ChildProcess;
} });
startTunnel(1);
eq("没找到 cloudflared → failed", tunnelStatus().phase, "failed");
check("…错误里点名 cloudflared", (tunnelStatus().error ?? "").includes("cloudflared"), tunnelStatus().error);
check("…并说了怎么装", (tunnelStatus().error ?? "").includes("winget") || (tunnelStatus().error ?? "").includes("http"), tunnelStatus().error);
eq("…没去 spawn", procs.length, 0);

/* ── 场景 3:进程在拿到域名前就退了 → 会排重连(带上尾部日志当原因) ─────
   起不来多半是环境问题,但退避重试几轮是合理的 —— 也可能是网络一时不通。
   (超过 MAX_RECONNECT_ATTEMPTS 才会落成 failed,那条在场景 5 之后的收尾里验不到,
   这里只验"它把断开原因记下来了"。) */
procs = [];
configureTunnelDeps({ findCloudflared: () => "cloudflared", spawnTunnel: (exe, args) => {
  const p = new FakeProc();
  procs.push(p);
  return p as unknown as import("node:child_process").ChildProcess;
} });
startTunnel(2);
procs[0].emitLog("ERR failed to connect to the edge");
procs[0].close(1);
eq("未就绪就退出 → 进重连(不是直接放弃)", tunnelStatus().phase, "reconnecting");
check("…错误里带上最后几行输出", (tunnelStatus().error ?? "").includes("failed to connect to the edge"), tunnelStatus().error);
// 收干净:取消待发的重连,免得它 1s 后拉一条出来干扰下面的场景。
stopTunnel();

/* ── 场景 4:超时 —— 把上限调到 150ms,喂一段**永远不给域名**的日志。
      超时也归到"掉了"那一类 → 会排重连(起得来但一时抽风,重连是对的);
      而因为退避第一档是 1s,这里 400ms 时还停在 reconnecting 上。 */
procs = [];
configureTunnelDeps({
  findCloudflared: () => "cloudflared",
  spawnTunnel: () => {
    const p = new FakeProc();
    procs.push(p);
    return p as unknown as import("node:child_process").ChildProcess;
  },
  readyTimeoutMs: 150,
});
startTunnel(3);
procs[0].emitLog("INF 只有预检,永远不给域名");
eq("(超时前)仍在 starting", tunnelStatus().phase, "starting");
await new Promise((r) => setTimeout(r, 400));
eq("超时 → 进 reconnecting(而不是干等 60 秒)", tunnelStatus().phase, "reconnecting");
check("…错误里带上了超时那几行输出", (tunnelStatus().error ?? "").includes("只有预检"), tunnelStatus().error);
// 这一支要收干净:把待发的重连取消掉,免得它 1s 后又拉一条出来干扰下面的场景。
stopTunnel();

/* ── 场景 5:隧道跑着跑着**掉了 → 自动重连** ─────────────────────────
   用户报的需求(源码审查第 3 条):隧道断了原先只标 failed,得回设置页手动再点一次,
   而快速隧道域名每次都变 —— 断了不重连等于"这条通路随时会静默失效"。 */
procs = [];
spawnArgs = [];
configureTunnelDeps({
  findCloudflared: () => "cloudflared",
  spawnTunnel: (exe, args) => {
    spawnArgs.push({ exe, args });
    const p = new FakeProc();
    procs.push(p);
    return p as unknown as import("node:child_process").ChildProcess;
  },
  // ⚠️ **显式给回正常超时** —— 场景 4 把它调成了 150ms,不重置的话重连起来的那条
  // 会在拿到域名之前就超时、再排一次重连,断言就永远看不到 ready(这坑真踩过)。
  readyTimeoutMs: 60_000,
});
startTunnel(11);
procs[0].emitLog("https://first-drops.trycloudflare.com");
eq("(重连前)已就绪", tunnelStatus().phase, "ready");
// **隧道掉了** —— 这是关键的模拟:close 到达时 livePort 还在(用户没停它)。
procs[0].close(1);
eq("掉了之后进 reconnecting(不是 failed)", tunnelStatus().phase, "reconnecting");
check("…状态里说了第几次重连", (tunnelStatus().error ?? "").includes("重连"), tunnelStatus().error);
// 退避第一档是 1s —— 等一下,它该自己把新隧道起起来。
await new Promise((r) => setTimeout(r, 1400));
eq("…重连真的又起了一条(第二次 spawn)", procs.length, 2);
procs[1]?.emitLog("https://second-after-reconnect.trycloudflare.com");
eq("…新隧道就绪,域名换了", tunnelStatus().url, "https://second-after-reconnect.trycloudflare.com");
stopTunnel();

/* ── ⚠️ **重连有上限,到点要真的放弃** ──────────────────────────────
   这条钉的是 2026-09-24 自查出来的一个真 bug:`startTunnel` 无条件把 `reconnectAttempt`
   归零,而重连回调最后也是调它 —— 于是每轮重连都把自己刚加的那次抹掉,上限**永远
   到不了** = 无限重试(而注释写着"不无限重试")。

   触发它只要**连着让隧道起来→掉**两次以上**:上限是 6,但那个 bug 下计数永远是 1。 */
procs = [];
configureTunnelDeps({
  findCloudflared: () => "cloudflared",
  spawnTunnel: () => {
    const p = new FakeProc();
    procs.push(p);
    return p as unknown as import("node:child_process").ChildProcess;
  },
  readyTimeoutMs: 60_000,
});
startTunnel(21);
// 反复"起来(拿到域名) → 掉" —— 每次重连前把计数往上涨。
procs[0]?.emitLog("https://cycle-1.trycloudflare.com");
eq("第 1 条起来", tunnelStatus().phase, "ready");
procs[0]?.close(1);
eq("…掉了 → reconnecting", tunnelStatus().phase, "reconnecting");
check(
  "…状态里报的是第 1 次",
  (tunnelStatus().error ?? "").includes("第 1/"),
  tunnelStatus().error,
);
await new Promise((r) => setTimeout(r, 1200));
// 重连起来的第 2 条:这次**不给域名**(模拟一直起不来),让它超时再排 —— 但为了快,
// 直接 close 掉,让它走"断了再排"那条。
procs[1]?.close(1);
check(
  "…第 2 次重连时报的是第 2 次(计数没有被上一轮抹掉)",
  (tunnelStatus().error ?? "").includes("第 2/"),
  tunnelStatus().error,
);
stopTunnel();

/* ── ⚠️ 用户主动停,绝不重连 ───────────────────────────────────── */
const beforeStop = procs.length;
stopTunnel();
eq("stop 后是 stopped", tunnelStatus().phase, "stopped");
await new Promise((r) => setTimeout(r, 1400));
eq("…而且**没有**偷偷重连起来(用户停就是停)", procs.length, beforeStop);

/* ══════════════ 命名隧道(named):用户自己的域名 ══════════════════ */

/** named 模式下 cloudflared 真实输出的样子:一段启动信息,然后是连接注册。
 *  **域名不在里面** —— 这正是不能沿用 quick 那条正则的原因。 */
const NAMED_LOG = [
  "2026-09-30T04:12:01Z INF Starting tunnel tunnelID=7f1c9a2e-0b55-4c1a-9a0e-2f1b7c3d4e5f",
  "2026-09-30T04:12:01Z INF Version 2026.9.1",
  "2026-09-30T04:12:02Z INF Initial protocol quic",
  "2026-09-30T04:12:03Z INF Registered tunnel connection connIndex=0 connection=9b1a location=hkg07 protocol=quic",
].join("\n");

let spawnEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
const namedDeps = () => {
  procs = [];
  spawnArgs = [];
  spawnEnvs = [];
  configureTunnelDeps({
    findCloudflared: () => "cloudflared",
    spawnTunnel: (exe, args, env) => {
      spawnArgs.push({ exe, args });
      spawnEnvs.push(env);
      const p = new FakeProc();
      procs.push(p);
      return p as unknown as import("node:child_process").ChildProcess;
    },
    readyTimeoutMs: 60_000,
  });
};

/* ── named 1:正常起来 —— 域名来自配置,不是从日志里抠的 ───────────── */
namedDeps();
startTunnel(17331, false, { mode: "named", token: "eyJhIjoiTEST-TOKEN-1234", hostname: "mcp.example.com" });
eq("named:起的是 tunnel run,不是 --url", spawnArgs[0]?.args, ["--no-autoupdate", "tunnel", "run"]);
check(
  "named:token **不在命令行里**(进程列表看不到)",
  !JSON.stringify(spawnArgs[0]?.args ?? []).includes("TEST-TOKEN"),
  spawnArgs[0]?.args,
);
eq("named:token 走 TUNNEL_TOKEN 环境变量", spawnEnvs[0]?.TUNNEL_TOKEN, "eyJhIjoiTEST-TOKEN-1234");
eq("named:连接注册之前还在 starting", tunnelStatus().phase, "starting");
procs[0]?.emitLog(NAMED_LOG);
eq("named:认出连接注册 → ready", tunnelStatus().phase, "ready");
eq("named:域名用的是配置值", tunnelStatus().url, "https://mcp.example.com");
stopTunnel();

/* ── named 2:用户把 https:// 一起粘进来,照样对 ─────────────────── */
namedDeps();
startTunnel(17331, false, { mode: "named", token: "t", hostname: "https://m.example.com/" });
procs[0]?.emitLog("INF Registered tunnel connection connIndex=1");
eq("named:协议与尾斜杠被规整掉", tunnelStatus().url, "https://m.example.com");
stopTunnel();

/* ── named 3:token 不对 → **当场判死,不重连** ───────────────────── */
namedDeps();
startTunnel(17331, false, { mode: "named", token: "bad", hostname: "mcp.example.com" });
procs[0]?.emitLog("2026-09-30T04:13:00Z ERR Failed to parse token: invalid tunnel token");
eq("named:鉴权失败 → failed", tunnelStatus().phase, "failed");
check("named:错误里直说是 token 的事", (tunnelStatus().error ?? "").includes("Tunnel Token"), tunnelStatus().error);
const afterAuthFail = procs.length;
await new Promise((r) => setTimeout(r, 1400));
eq("named:**没有**偷偷重连(重试 6 次对坏 token 毫无意义)", procs.length, afterAuthFail);
stopTunnel();

/* ── named 3b:cloudflared 对坏 token 的**真实原话**(中间带 Tunnel) ───── */
namedDeps();
startTunnel(17331, false, { mode: "named", token: "bad", hostname: "mcp.example.com" });
procs[0]?.emitLog("Provided Tunnel token is not valid.\nSee 'cloudflared tunnel run --help'.");
eq("named:真实的坏 token 原话 → failed", tunnelStatus().phase, "failed");
check("named:真实原话也说是 token 的事", (tunnelStatus().error ?? "").includes("Tunnel Token"), tunnelStatus().error);
stopTunnel();

/* ── named 3c:token 被吊销 / 隧道被删 —— 报错行里的 Unauthorized ───────── */
namedDeps();
startTunnel(17331, false, { mode: "named", token: "revoked", hostname: "mcp.example.com" });
procs[0]?.emitLog('2026-09-30T04:14:00Z ERR Register tunnel error from server side error="Unauthorized: Failed to get tunnel" connIndex=0');
eq("named:服务端 Unauthorized → failed", tunnelStatus().phase, "failed");
stopTunnel();

/* ── named 3d:UUID 里碰巧有 401 —— **不能**当成坏 token 杀掉正常隧道 ──── */
namedDeps();
startTunnel(17331, false, { mode: "named", token: "tok", hostname: "mcp.example.com" });
procs[0]?.emitLog("2026-09-30T04:15:00Z INF Starting tunnel tunnelID=4012ab9e-0b55-4c1a-9a0e-2f1b7c3d4e5f");
eq("named:tunnelID 含 401 仍在 starting", tunnelStatus().phase, "starting");
procs[0]?.emitLog("2026-09-30T04:15:01Z INF Registered tunnel connection connIndex=0 connection=a401b2c3-1111-2222-3333-444455556666 location=hkg07");
eq("named:connection 含 401 照样 ready", tunnelStatus().phase, "ready");
eq("named:没有被杀", procs.length, 1);
stopTunnel();

/* ── named 4:少填一项 → 起都不起,直接说缺什么 ─────────────────── */
namedDeps();
startTunnel(17331, false, { mode: "named", hostname: "mcp.example.com" });
eq("named:缺 token → failed", tunnelStatus().phase, "failed");
check("named:缺 token 的话说得清", (tunnelStatus().error ?? "").includes("Tunnel Token"), tunnelStatus().error);
eq("named:缺项时**连进程都没起**", procs.length, 0);
stopTunnel();
namedDeps();
startTunnel(17331, false, { mode: "named", token: "t" });
eq("named:缺域名 → failed", tunnelStatus().phase, "failed");
check("named:缺域名的话说得清", (tunnelStatus().error ?? "").includes("公网域名"), tunnelStatus().error);
eq("named:缺项时**连进程都没起**(域名这条也一样)", procs.length, 0);
stopTunnel();

/* ── named 5:重连沿用 named 配置,不退化成 quick ─────────────────── */
namedDeps();
startTunnel(17331, false, { mode: "named", token: "tok", hostname: "mcp.example.com" });
procs[0]?.emitLog(NAMED_LOG);
eq("named:先起来", tunnelStatus().phase, "ready");
procs[0]?.close(1);
eq("named:掉了 → reconnecting", tunnelStatus().phase, "reconnecting");
await new Promise((r) => setTimeout(r, 1200));
eq("named:重连起的仍是 tunnel run(模式没丢)", spawnArgs[1]?.args, ["--no-autoupdate", "tunnel", "run"]);
eq("named:重连仍带着 token", spawnEnvs[1]?.TUNNEL_TOKEN, "tok");
procs[1]?.emitLog(NAMED_LOG);
eq("named:重连后域名还是那个", tunnelStatus().url, "https://mcp.example.com");
stopTunnel();

/* ── named 6:停掉之后再开 quick,**不吃上一轮的残留配置** ────────── */
namedDeps();
startTunnel(17331, false, { mode: "named", token: "tok", hostname: "mcp.example.com" });
stopTunnel();
startTunnel(54321);
eq("停了再开 quick:起的是 --url", spawnArgs[1]?.args?.[1], "--url");
eq("停了再开 quick:不再带 token", spawnEnvs[1], undefined);
procs[1]?.emitLog("https://back-to-quick.trycloudflare.com");
eq("停了再开 quick:域名照常抠", tunnelStatus().url, "https://back-to-quick.trycloudflare.com");
stopTunnel();

/* ── 两份隧道互不影响(手机自有域名单独一份,不依赖 MCP 那条) ────────── */
namedDeps();
{
  const phone = createTunnelManager("mobile-tunnel");
  phone.start(7331, false, { mode: "named", token: "phone-tok", hostname: "m.example.com" });
  eq("另一份:起来的是它自己的进程", procs.length, 1);
  eq("另一份:默认那份没被带起来", tunnelStatus().phase, "stopped");
  procs[0]?.emitLog(NAMED_LOG);
  eq("另一份:就绪,域名是它自己的", phone.status().url, "https://m.example.com");
  startTunnel(17331, false, { mode: "named", token: "mcp-tok", hostname: "mcp.example.com" });
  eq("默认那份另起一个进程", procs.length, 2);
  procs[1]?.emitLog(NAMED_LOG);
  eq("默认那份就绪", tunnelStatus().url, "https://mcp.example.com");
  stopTunnel();
  eq("停默认那份:它 stopped", tunnelStatus().phase, "stopped");
  eq("停默认那份:另一份仍 ready", phone.status().phase, "ready");
  procs[1]?.close(0);
  eq("默认那份迟到的 close 不影响另一份", phone.status().phase, "ready");
  phone.stop();
  eq("另一份 stop 后 stopped", phone.status().phase, "stopped");
}

/* ── 收尾:还原注入,确认 dispose 干净 ───────────────────────────── */
resetTunnelDeps();
stopTunnel();
eq("收尾后 stopped", tunnelStatus().phase, "stopped");

console.log(`\ntunnel-manager smoke: ${passed}/${checks} 通过`);
if (failures.length > 0) {
  console.log(`\n失败 ${failures.length} 条:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
