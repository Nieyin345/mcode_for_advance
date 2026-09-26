/**
 * 中继(`main/relay/RelayManager.ts` + `main/ipc/relay.ts`)的无头 smoke。
 *
 * 这两个文件此前**零覆盖**。中继是"手机在地铁上也能连回桌面"那条路:拿用户填的
 * VPS 做 SSH 反向隧道,把桌面的移动端 HTTP 服务挂到公网上。它出错的样子不是报错,
 * 是**手机连不上而界面显示"已连接"**,或者**断了之后一秒重连一次把对端打爆**。
 *
 * ## 这套钉的判据全在"用户看到的那两样东西"上
 *
 * 状态面板那行字(`relay:event` 推给渲染端的 `RelayStatus`),以及
 * `connect()` / `disconnect()` 返回给表单的结果。内部怎么实现不设断言。
 *
 * 1. **错误文案是不是人话** —— 连不上时面板要显示中文,而不是 ssh2 抛出来的
 *    `All configured authentication methods failed`。
 * 2. **重连退避** —— 连续失败时排的定时器是 `2s/4s/8s/16s/32s`,不是忙等,
 *    上限到了就放弃并且说清楚放弃了。
 * 3. **资源不泄漏** —— 反复连断之后,中继排的定时器**没有一个**还在飞。
 * 4. **半截状态** —— 认证过了但转发器/隧道没起来时,状态**不许**是 `connected`,
 *    `endpoint` **不许**留在面板上(不然用户会拿一个连不通的地址去扫码)。
 * 5. **数据真的过得去** —— 从"手机"发一个 HTTP 请求,能穿过假 VPS 回到本机的
 *    哨兵服务并拿回正文。这是上面所有状态断言的前提:它保证"connected"不是空口说的。
 * 6. **凭据不进日志** —— SSH 密码 / 私钥内容不许出现在 logger 任何一行里。
 *
 * ## 假 VPS 是真的 `ssh2.Server`,绑回环 + 随机端口
 *
 * 不连外网、不起真 sshd。服务端的每一种反应(拒绝认证 / 拒绝端口转发 /
 * 不答 SFTP / 直接掐断)都是按需摆出来的,见 `fakeVps.ts`。
 *
 * ## 没验的(写清楚,免得被当成已验)
 *
 * - **真的 `socat` / `python3` 二进制。** 假 VPS 的"端口模型"(见 `fakeVps.ts`)会照着
 *   中继的问话如实回答:转发器起的那个命令一执行,端口就占上;`pkill` 掉就放开;端口
 *   被别人占着时**命令回 0 但没人听**(2026-08-28 那次事故的形状)。所以
 *   `deployForwarder` 的分支选择、清理顺序、失败文案都**真的走了**,但"转发器进程
 *   本身能不能干活"没被验到 —— 那要一台真 VPS。
 * - **真的 `ss` / `netstat` / `pgrep` 输出格式。** 上面那些答案是按真工具的格式摆出来
 *   的(`grep -c` 回一行计数、`ss -ltnp` 回一行 holder),但没有对着一台真机器核过。
 * - **`ssh2` 自身的 keepalive 能不能真的保住连接。** 要等 15 秒以上的真网络抖动。
 * - **移动端服务本身。** 本套用替身(真起在回环上),它不是被测对象。
 * - **渲染端的面板。** 只看推给它的 `RelayStatus`,不看它怎么显示。
 *
 * Run: scripts/relay-smoke/run.sh
 */

import * as net from "node:net";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ───────────────── 环境:必须在被测模块 import 之前 ─────────────────
 *
 * 数据根指向本套自己 mktemp 出来的目录。stubs/dataRoot.ts 没设就抛 ——
 * 指错地方等于拿空库盖掉用户的聊天记录(sql.js 整份重写文件)。
 */
const DATA = mkdtempSync(join(tmpdir(), "mcode-relay-data-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

/* ───────────────── 定时器观察台:也必须在被测模块之前 ─────────────────
 *
 * 先装,再 import 被测模块 —— 顺序反了等于没装。见 timers.ts 文件头。 */
const timers = await import("./timers.js");
timers.install();

/* ───────────────── 断言助手 ───────────────── */

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 断言某串里**不含**某个敏感片段。 */
function noSecret(name: string, haystack: string, secret: string): void {
  check(name, !haystack.includes(secret), { secretLen: secret.length, looked: haystack.length });
}

/* ───────────────── 被测模块 ───────────────── */

const { initDb, getDb } = await import("@main/store/db.js");
await initDb();
check("库真的建起来了(不是空壳桩)", !!getDb());
check("库文件落在临时数据根下", existsSync(join(DATA, "mcode.db")), { data: DATA });

const { relayManager } = await import("@main/relay/RelayManager.js");
const { registerRelayHandlers } = await import("@main/ipc/relay.js");
const { SettingRepo } = await import("@main/store/repositories.js");
const { RELAY_CONFIG_SETTING_KEY } = await import("@contracts/relay");
const { IPC } = await import("@contracts/ipc");

interface RelayStatusLike {
  state: string;
  endpoint: string | null;
  vpsHost: string | null;
  publicPort: number;
  error: string | null;
  forwarderType: string | null;
}

/** 账本桩:按顺序记下推给渲染端的每一条 `relay:event`。 */
const windowStub = (await import("@main/window.js")) as unknown as {
  __pushes(): Array<{ channel: string; status: RelayStatusLike; at: number }>;
  __reset(): void;
};

/** 哨兵服务桩:回环上一个真的 HTTP 服务,中继的 `pipeToLocal` 真的连它。 */
const mobileStub = (await import("@main/mobile/MobileHttpServer.js")) as unknown as {
  __up(): Promise<number>;
  __down(): Promise<void>;
  __hits(): number;
  LOCAL_SENTINEL: string;
};

const { startFakeVps, phoneGet, realForwarderPy } = await import("./fakeVps.js");
type FakeVpsHandle = Awaited<ReturnType<typeof startFakeVps>>;

/* ───────────────── 记账:日志里的凭据 ─────────────────
 *
 * `@main/lib/logger.js` 的桩把每一行原样打到 stderr。这里把那一路接住,一边照常
 * 打印一边攒进数组 —— 最后一条断言扫的就是它。(`console.error` 拦不住
 * `process.stderr.write`,所以只能在写这一层接。)
 */
const logLines: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
  logLines.push(String(chunk));
  return (realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as never;

/* ───────────────── 场景脚手架 ───────────────── */

/** 假 VPS 对 `exec` 的默认应答:一个"两个转发器工具都装好了"的正常机器。
 *
 *  ⚠️ **这里不许再出现 `grep -c` / `tail -c 300` / `pkill` 那几条。** 端口与进程的
 *  实况由假 VPS 的端口模型自己回答(见 `fakeVps.ts`);一旦在这里把它们写死,
 *  就等于把中继"起完转发器再确认真的在监听"那半截整个短路掉 —— 第一版就是这么写的,
 *  于是 `waitForPortState` 永远空转到超时,查出来的东西与中继无关。 */
const NORMAL_EXEC = [
  { match: "which socat", stdout: "/usr/bin/socat\n" },
  { match: "which python3", stdout: "/usr/bin/python3\n" },
];

const realSleep = timers.realSleep;

function pushes(): Array<{ channel: string; status: RelayStatusLike; at: number }> {
  return windowStub.__pushes();
}
function lastPush(): { channel: string; status: RelayStatusLike; at: number } | undefined {
  const p = windowStub.__pushes();
  return p[p.length - 1];
}

/** 一条场景:起假 VPS、清账、跑、收尾。 */
async function scenario(
  name: string,
  opts: Parameters<typeof startFakeVps>[0],
  body: (vps: FakeVpsHandle) => Promise<void>,
): Promise<void> {
  console.log(`\n── ${name}`);
  windowStub.__reset();
  timers.reset();
  // ⚠️ **`connect()` 只读一次配置就把它缓存住了**(`if (!this.config)`)—— 于是上一场
  //    留下的 `host:port` 会一直用到进程结束。第一版因此每场都连回上一场那个已经关掉
  //    的假 VPS,报出来的是 `ECONNREFUSED`,而真正要验的那条路根本没走到。
  //    把内存里那份清掉:`connect()` 下一句就重新从 settings 表读。
  dumpConfig();
  const vps = await startFakeVps({ execReplies: NORMAL_EXEC, ...opts });
  try {
    await body(vps);
  } finally {
    await relayManager.disconnect();
    dumpConfig();
    await vps.close();
    await realSleep(60);
  }
}

/** 一条场景的变体:**按住**退避定时器(用来数"排了没清")。 */
async function scenarioHeld(
  name: string,
  opts: Parameters<typeof startFakeVps>[0],
  body: (vps: FakeVpsHandle) => Promise<void>,
): Promise<void> {
  console.log(`\n── ${name}`);
  windowStub.__reset();
  timers.reset();
  dumpConfig();
  timers.setMode("hold");
  const vps = await startFakeVps({ execReplies: NORMAL_EXEC, ...opts });
  try {
    await body(vps);
  } finally {
    timers.setMode("fast");
    await relayManager.disconnect();
    dumpConfig();
    await vps.close();
    await realSleep(60);
  }
}

/** 从 settings 表里直接读回 VPS 配置。 */
function rawVpsSetting(): string | null {
  return SettingRepo.get(RELAY_CONFIG_SETTING_KEY);
}

/** 把中继内存里那份配置清掉,让它下一次 `connect()` 重新读 settings。见 `scenario`。 */
function dumpConfig(): void {
  (relayManager as unknown as { config: unknown }).config = null;
}

/** 计个端口 —— 每条场景给假 VPS 一个新的 publicPort。
 *
 *  ⚠️ **不能让每场都用 47331。** 假 VPS 的端口模型是按端口记的,上一场留下的那个
 *  "僵尸转发器"会一直挂在那儿,下一场一上来就撞上"端口被占"。
 *  从 47400 起,避开系统临时端口段(Windows 是 49152+),固定 port 断言写成 47400。 */
let nextPublicPort = 47400;
function takePort(): number {
  return (nextPublicPort += 1);
}

/** 通用"先配好 VPS,指向这个假服务端"。返回这一场用的 publicPort。 */
function saveVps(port: number, extra: Record<string, unknown> = {}): number {
  const publicPort = (extra.publicPort as number | undefined) ?? takePort();
  SettingRepo.set(
    RELAY_CONFIG_SETTING_KEY,
    JSON.stringify({
      host: "127.0.0.1",
      sshPort: port,
      username: "root",
      password: "SMOKE_SSH_PASSWORD_SENTINEL",
      publicPort,
      forwarder: "auto",
      ...extra,
    }),
  );
  return publicPort;
}

/** 等中继自己把状态推进到某个值(或超时)。 */
async function waitFor(label: string, want: (s: RelayStatusLike) => boolean, timeoutMs = 8000): Promise<RelayStatusLike> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = relayManager.getStatus() as RelayStatusLike;
    if (want(st)) return st;
    if (Date.now() >= deadline) {
      check(`${label}(等 ${timeoutMs}ms 仍不满足)`, false, { last: st });
      return st;
    }
    await realSleep(20);
  }
}

/**
 * 等一个**与状态无关**的条件(比如"账本上出现了退避定时器""服务端又看到一条连接")。
 *
 * ⚠️ **这条是必需的,不是顺手写的。** 定时器观察台把退避压成 ~1ms,于是"断开 →
 * connecting → 重连成功 → connected"整圈只有几毫秒 —— 按**状态**去轮询必然错过中间
 * 那一格(实测:`waitFor(state === "connecting")` 等到超时,报出来的 last 已经是
 * `connected`)。要盯的必须是**计数**(定时器账本、服务端连接数)那种只增不减的东西。
 */
async function waitUntil(label: string, want: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (want()) return true;
    if (Date.now() >= deadline) {
      check(`${label}(等 ${timeoutMs}ms 仍不满足)`, false);
      return false;
    }
    await realSleep(20);
  }
}

/** 哨兵端口:中继把 `tcp connection` 的流接到这里。 */
await mobileStub.__up();

/* ═══════════════════════ 0. 指纹守卫 ═══════════════════════
 *
 * ⚠️ **这一节不能省。** 退避那几条断言全靠 `scheduleReconnect` 这个字符串指纹去
 * 筛定时器记录。名字一改,筛出来恒为 0 —— 于是"没有忙等""最多 5 次"全都**空过**,
 * 全绿而什么都没验。所以先真造一个连接断开,确认那个指纹**真的**能筛到东西。
 *
 * ⚠️ **端口轮询那个指纹(部署那条路)不在这里验。** 它得先有一段"端口还没到位、
 * `sleep()` 真的被走到"的路 —— 那要等 `PORT_POLL_INTERVAL_MS` 过去(`waitForPortState`
 * 是**先查一次、不中才 sleep**)。在这一节里凑那个,等于让守门这条断言依赖一次真实的
 * 端口竞态,会 flaky。它挪到第 2 节(真部署);这里只钉**退避**那一个。
 */
console.log("\n══ 0. 指纹守卫(没有这一节,退避那几条断言会空过)");
{
  const vps = await startFakeVps({ execReplies: NORMAL_EXEC });
  saveVps(vps.port);
  windowStub.__reset();
  timers.reset();
  await relayManager.connect();
  const before = vps.totalClients;
  vps.killClients();

  // ⚠️ 等的是"服务端又看到一条连接" —— 不是 `state === "connecting"`。退避被加速
  //    之后,断开→重连成功整圈只有几毫秒,按状态轮必然错过中间那一格。见 `waitUntil`。
  await waitUntil("指纹守卫:等到断开后真的重连了一次", () => vps.totalClients > before, 8000);
  await realSleep(120);

  const byFp = timers.all().filter((e) => e.stack.includes(timers.BACKOFF_FP)).length;
  // 这一条**必须**大于 0,否则下面所有退避断言都是空过的。
  check(
    `栈指纹 ${timers.BACKOFF_FP} 能筛到中继排的重连定时器`,
    byFp > 0,
    { matched: byFp, recorded: timers.all().length },
  );
  // 退避那一类是**中继自己的**,不该被判成第三方的 —— 判错了它就不加速、
  // 永远停在"排过没执行",整条阶梯走不完(见 timers.ts 的 isThirdParty)。
  check(
    "退避定时器没被误判成第三方的(误判的话它不加速,阶梯永远走不完)",
    byFp === timers.delaysWith(timers.BACKOFF_FP).length && byFp > 0,
    { byFp, nonThirdParty: timers.delaysWith(timers.BACKOFF_FP).length },
  );
  await relayManager.disconnect();
  await vps.close();
  await realSleep(60);
}

/* ═══════════════════════ 1. 前置条件与文案 ═══════════════════════ */

console.log("\n══ 1. 前置条件");

{
  // 没配置 VPS:把设置键清掉,`getConfig()` 的 `JSON.parse("")` 抛 → null。
  SettingRepo.set(RELAY_CONFIG_SETTING_KEY, "");
  const st = relayManager.getStatus() as RelayStatusLike;
  eq("清掉配置之后,面板上的状态仍是 idle", st.state, "idle");

  // ⚠️ **这里不清 `timers`。** 上一节(指纹守卫)在场景里真的等过 60~120ms,期间中继
  //    可能已经排好了一个重连定时器;那不是"清配置排的"。所以先 `reset()`,再要一个
  //    干净的答案 —— 不清就 reset 的话,前面那些记录会混进来,这条断言恒红。
  timers.reset();
  check("指纹:清配置没排任何定时器", timers.pendingTimers() === 0, timers.pendingDetail());
}

/* ═══════════════════════ 2. 正常连接(含数据通路) ═══════════════════════ */

await scenario("正常连接:SSH 通 + 转发器起来 + 手机真的能穿过来", {}, async (vps) => {
  const publicPort = saveVps(vps.port);

  const result = await relayManager.connect();
  eq("connect() 回了 ok", result.ok, true);
  eq("connect() 没带 error", result.error, undefined);

  const st = relayManager.getStatus() as RelayStatusLike;
  eq("状态是 connected", st.state, "connected");
  eq("endpoint 是 http://<host>:<publicPort>", st.endpoint, `http://127.0.0.1:${publicPort}`);
  eq("forwarderType 记下了(用了 socat)", st.forwarderType, "socat");
  eq("error 清空", st.error, null);
  eq("vpsHost 记下了", st.vpsHost, "127.0.0.1");

  // 状态变化真的推给渲染端了(面板靠推送,不靠轮询)。
  const states = pushes().map((p) => p.status.state);
  check("状态变化推给了渲染端,最后一条是 connected", states.length > 0 && states[states.length - 1] === "connected", states);
  check(
    "推送走 relay:event 这条频道",
    pushes().every((p) => p.channel === IPC.RELAY_EVENT),
    pushes().map((p) => p.channel),
  );
  check(
    "推送里出现过 connecting 与 deploying(不是一步到 connected)",
    states.includes("connecting") && states.includes("deploying"),
    states,
  );

  // VPS 上到底做了什么。
  eq("VPS 上确认过 socat 存在", vps.execCommands.some((c) => c.includes("which socat")), true);
  eq(
    "起了 socat 转发器,监听在用户填的 publicPort 上",
    vps.execCommands.some((c) => c.includes(`nohup socat TCP-LISTEN:${publicPort}`)),
    true,
  );
  // 端口上**真的**有人听了 —— 这一条把"命令回了 0"和"转发器真起来了"分开。
  // (中继自己也是这么判断的:`ss -ltn | … | grep -c` 数出来不为 0 才算成功。)
  eq("那个 publicPort 上真的有人监听(不是只有一条成功的命令)", vps.portHeld(publicPort), true);
  eq("开了反向隧道", vps.tunnelPorts.length, 1);
  check("隧道端口是个合法端口", vps.tunnelPorts[0] > 0 && vps.tunnelPorts[0] < 65536, vps.tunnelPorts);

  // —— 数据真的过得去 ——
  check("假 VPS 起了手机口", vps.phonePorts.length === 1, vps.phonePorts);
  const before = mobileStub.__hits();
  const reply = await phoneGet(vps.phonePorts[0]);
  check("手机穿过 VPS + 反向隧道拿到了本机服务的正文", reply.includes(mobileStub.LOCAL_SENTINEL), reply.slice(0, 200));
  eq("本机哨兵服务被真的连到过一次", mobileStub.__hits(), before + 1);

  // —— 正常路径上不该排任何重连 ——
  eq("连上之后没排过重连退避", timers.delaysWith(timers.BACKOFF_FP).length, 0);
});

/* ═══════════════════════ 3. 幂等 ═══════════════════════ */

await scenario("重复 connect / disconnect 是幂等的", {}, async (vps) => {
  saveVps(vps.port);

  await relayManager.connect();
  const firstClients = vps.totalClients;

  const again = await relayManager.connect();
  eq("已经连着时再 connect 直接回 ok", again.ok, true);
  eq("没有为此再建一条 SSH 连接", vps.totalClients, firstClients);
  eq("也没有为此再开一条反向隧道", vps.tunnelPorts.length, 1);

  await relayManager.disconnect();
  await relayManager.disconnect();
  const st = relayManager.getStatus() as RelayStatusLike;
  eq("反复 disconnect 之后是 idle", st.state, "idle");
  eq("endpoint 清掉了", st.endpoint, null);
  eq("forwarderType 清掉了", st.forwarderType, null);
  eq("error 清掉了", st.error, null);
  eq("中继没留下没清的定时器", timers.pendingTimers(), 0);

  await realSleep(80);
  eq("断连之后 VPS 那边也真的没人挂着了", vps.liveClients, 0);
});

/* ═══════════════════════ 4. 连不上:用户看到的那行字 ═══════════════════════ */

await scenario("SSH 认证失败", { acceptAuth: false }, async (vps) => {
  saveVps(vps.port);

  const result = await relayManager.connect();
  eq("connect() 报了失败", result.ok, false);

  // ⚠️ **这套里最重要的一条。** 判据立在**用户看到的那行字**上:必须是中文人话,
  //    不能是 ssh2 抛出来的英文内部消息。
  check(
    "connect() 返回的失败文案是人话(中文,且不是 ssh2 的英文原话)",
    /[一-龥]/.test(result.error ?? "") && !/configured authentication methods/i.test(result.error ?? ""),
    { error: result.error },
  );
  check("文案里说了是认证问题", /认证|密码|密钥/.test(result.error ?? ""), { error: result.error });

  // 面板显示的是**推送里**的 status,不是 connect() 的返回值 —— 两边都要对。
  // 注意面板这一刻可能已经被"正在重连(n/5)"接手(连接阶段的失败也会退避),所以查的是
  // **推给它的那整条链**:一个字都不许是 ssh2 的英文原话。
  const pushedErrors = pushes().map((p) => p.status.error ?? "");
  check(
    "推给面板的每一条文案都是人话(没有 ssh2 的英文原话)",
    pushedErrors.every((e) => !/configured authentication methods|ECONNREFUSED|getaddrinfo/i.test(e)),
    pushedErrors,
  );
  check("推给面板的链上出现过认证失败那句", pushedErrors.some((e) => /认证|密码|密钥/.test(e)), pushedErrors);
  check(
    "推给面板的链上没有出现过 connected",
    pushes().every((p) => p.status.state !== "connected"),
    pushes().map((p) => p.status.state),
  );
});

await scenario("服务器地址解析不了", { connectPhone: false }, async (vps) => {
  // ⚠️ **不打外网**:`.invalid` 是保留域,`getaddrinfo` 在本地就失败。
  saveVps(vps.port, { host: "no-such-host.invalid" });
  const result = await relayManager.connect();
  eq("connect() 报失败", result.ok, false);
  check(
    "connect() 的文案是人话(中文,不是 getaddrinfo 那句英文)",
    /[一-龥]/.test(result.error ?? "") && !/getaddrinfo/i.test(result.error ?? ""),
    { error: result.error },
  );
  check("文案里说了是地址问题", /地址|域名|解析/.test(result.error ?? ""), { error: result.error });
  // 面板那边同上:整条推送链上都不许漏出英文原话。
  const pushed = pushes().map((p) => p.status.error ?? "");
  check("推给面板的链上也没有 getaddrinfo 原话", pushed.every((e) => !/getaddrinfo/i.test(e)), pushed);
  check("推给面板的链上出现过地址问题那句", pushed.some((e) => /地址|域名|解析/.test(e)), pushed);
});

await scenario("端口上没人监听", { connectPhone: false }, async (vps) => {
  // 拿一个一定没人监听的端口:先听一个再关掉。
  const dead = await new Promise<number>((res) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => res(p));
    });
  });
  saveVps(dead);
  const result = await relayManager.connect();
  eq("connect() 报失败", result.ok, false);
  check("文案提到了连不上 SSH 服务", /SSH/.test(result.error ?? ""), { error: result.error });
  check("文案是人话(不是 ECONNREFUSED)", !/ECONNREFUSED/.test(result.error ?? ""), { error: result.error });
  void vps;
});

/* ═══════════════════════ 5. 转发器部署:半截状态 ═══════════════════════ */

await scenario("指定 socat 但 VPS 上没有:显式失败,不静默退", {}, async (vps) => {
  void vps;
  const vps2 = await startFakeVps({
    execReplies: [{ match: "which socat", stdout: "" }],
  });
  saveVps(vps2.port, { forwarder: "socat" });
  windowStub.__reset();

  const result = await relayManager.connect();
  eq("connect() 报失败", result.ok, false);
  const st = relayManager.getStatus() as RelayStatusLike;
  eq("状态**不是** connected", st.state === "connected", false);
  check("文案里点了 socat 的名字", /socat/.test(st.error ?? ""), { error: st.error });
  check("文案里给了下一步(装它)", /apt install socat|安装/.test(st.error ?? ""), { error: st.error });
  eq("endpoint 没留在面板上", st.endpoint, null);
  // 半截状态的另一种:转发器没起来,但 SSH 连接**活着** —— 这是刻意的
  // (forwarder 在 VPS 上可以事后补,SSH 没必要跟着断)。钉住它。
  eq("SSH 连接本身还活着(转发器可在 VPS 上事后补)", vps2.liveClients, 1);
  // ⚠️ 面板这一刻**不能**显示"已连接":转发器没起来,手机连过去是死的。
  check(
    "整条推送链上从来没出现过 connected",
    pushes().every((p) => p.status.state !== "connected"),
    pushes().map((p) => p.status.state),
  );
  await vps2.close();
});

await scenario("auto 模式:两个转发器都没装", {}, async (vps) => {
  void vps;
  const vps2 = await startFakeVps({
    execReplies: [
      { match: "which socat", stdout: "" },
      { match: "which python3", stdout: "" },
    ],
  });
  saveVps(vps2.port);
  windowStub.__reset();

  const result = await relayManager.connect();
  eq("两条路都走不通时报失败", result.ok, false);
  const st = relayManager.getStatus() as RelayStatusLike;
  eq("状态不是 connected", st.state === "connected", false);
  eq("endpoint 没留在面板上", st.endpoint, null);
  check("文案里交代了 socat 也交代了 python3(而不是静默)", /socat/.test(st.error ?? "") && /python3/.test(st.error ?? ""), {
    error: st.error,
  });
  check("文案里给了下一步(装哪一个)", /apt install socat/.test(st.error ?? "") && /apt install python3/.test(st.error ?? ""), {
    error: st.error,
  });
  await vps2.close();
});

await scenario("auto 模式:两个都装了但都起不来(端口被占):文案里带出日志尾巴", { bindFails: true }, async (vps) => {
  void vps;
  const vps2 = await startFakeVps({
    bindFails: true,
    sftp: "accept",
    execReplies: [
      { match: "which socat", stdout: "/usr/bin/socat\n" },
      { match: "which python3", stdout: "/usr/bin/python3\n" },
    ],
  });
  saveVps(vps2.port);
  windowStub.__reset();

  const result = await relayManager.connect();
  eq("两条路都起不来时报失败", result.ok, false);
  const st = relayManager.getStatus() as RelayStatusLike;
  eq("状态不是 connected", st.state === "connected", false);
  eq("endpoint 没留在面板上", st.endpoint, null);
  check(
    "日志里能看到从 socat 退到 python3 这一步",
    logLines.some((l) => /falling back to python3/.test(l)),
    logLines.filter((l) => /relay:/.test(l)).slice(-6),
  );
  // ⚠️ **半截状态里最该说清楚的就是这一条。** 转发器命令回了 0、SSH 也活着,但端口上
  //    没人听(转发了但 bind 失败)—— 用户拿到的必须不只是"失败了",还得有**为什么**。
  //    中继把 `~/.mcode/forwarder.log` 的尾巴捞出来贴在错误里,这里钉住它。
  check(
    "文案里带上了转发器日志的尾巴(Address already in use,可诊断)",
    /Address already in use/.test(st.error ?? ""),
    { error: st.error },
  );
  check("文案里点了是哪个转发器起不来", /python3/.test(st.error ?? ""), { error: st.error });
  await vps2.close();
});

await scenario("python3 转发器:SFTP 上传真的送出去了", {}, async (vps) => {
  void vps;
  const vps2 = await startFakeVps({
    sftp: "accept",
    execReplies: [
      { match: "which socat", stdout: "" },
      { match: "which python3", stdout: "/usr/bin/python3\n" },
    ],
  });
  const publicPort = saveVps(vps2.port);

  const result = await relayManager.connect();
  eq("connect() 成功", result.ok, true);
  eq("forwarderType 记的是 python3", (relayManager.getStatus() as RelayStatusLike).forwarderType, "python3");
  eq("VPS 上建了 ~/.mcode", vps2.mkdirs.includes(".mcode"), true);
  check("forwarder.py 上传上去了", vps2.uploaded.has(".mcode/forwarder.py"), [...vps2.uploaded.keys()]);
  // 上传的**字节**必须与仓库里那个真文件一致 —— `?raw` 内联丢了内容是坏得最静的一种。
  eq("上传的内容与仓库里的 forwarder.py 逐字节一致", vps2.uploaded.get(".mcode/forwarder.py"), realForwarderPy());
  eq(
    "启动命令带上了 publicPort 与隧道端口",
    vps2.execCommands.some((c) => c.includes(`nohup python3 ~/.mcode/forwarder.py ${publicPort} `)),
    true,
  );
  eq("python3 转发器那个端口上真的有人监听", vps2.portHeld(publicPort), true);
  await vps2.close();
});

/* ═══════════════════════ 5b. 端口被占:上一轮的僵尸 vs 别人的服务 ═══════════════════════
 *
 * 这一节钉的是 2026-08-28 那次事故的**根**:端口上有东西在听时,中继起的新转发器
 * 会 bind 失败 —— 而 `nohup … &` 照样回 0。两种占法必须分开对待:
 *
 *   上一轮的僵尸  → `pkill -f "[T]CP-LISTEN:<port>"` 匹配得到,清掉,部署照常成功;
 *   别人的服务    → 清不掉,必须**大声报错**并说清端口被谁占着(不许假装 connected)。
 */

await scenario("上一轮留下的僵尸转发器:清得掉,部署照常成功", {}, async (vps) => {
  // ⚠️ 端口要在**发起部署之前**就占上:那个"僵尸"得一开始就听着 publicPort,
  //    中继才会走进 cleanupForwarder 那条路。
  const publicPort = saveVps(vps.port);
  vps.holdPort(publicPort, "stale");
  windowStub.__reset();

  const result = await relayManager.connect();
  eq("清掉僵尸之后照样连上", result.ok, true);
  const st = relayManager.getStatus() as RelayStatusLike;
  eq("状态是 connected", st.state, "connected");
  eq("forwarderType 是 socat(清完照常起)", st.forwarderType, "socat");
  check("真的去清过端口", vps.execCommands.some((c) => c.includes("pkill")), vps.execCommands.slice(0, 4));
  eq("端口最后是我们新起的转发器占着的", vps.portHeld(publicPort), true);
});

await scenario("卡住不走的转发器:SIGTERM 清不掉,升级到 SIGKILL 之后照样连上", {}, async (vps) => {
  // ⚠️ 这条**顺带钉住端口轮询那个指纹**。中继的清理是两级的:先 `pkill`(SIGTERM),
  //    等 `waitForPortState` 转 3 秒;没走才升级到 `pkill -9`,再等 2.5 秒。
  //    只有"卡住不走"的这一种占法会把**轮询循环**真的走起来(`sleep()` 被排到) ——
  //    上一节那种一 pkill 就没的僵尸是第一次查就成的,循环一次都不转。
  //    所以 `POLL_FP` 的守卫断言立在这一节,而不是立在一段靠运气的端口竞态上。
  const publicPort = saveVps(vps.port);
  vps.holdPort(publicPort, "stubborn");
  windowStub.__reset();
  timers.reset();

  const result = await relayManager.connect();
  eq("升级到 SIGKILL 之后照样连上", result.ok, true);
  eq("状态是 connected", (relayManager.getStatus() as RelayStatusLike).state, "connected");
  // 指纹守卫:没有这一条,下面"轮询真的转过"就是空过的。
  check(
    `栈指纹 ${timers.POLL_FP} 能筛到端口轮询的 sleep(清理真的走了多轮)`,
    timers.all().some((e) => e.stack.includes(timers.POLL_FP)),
    { recorded: timers.all().length },
  );
  eq("SIGTERM 那次没清掉,才升级到 SIGKILL", vps.execCommands.some((c) => c.includes("[T]CP-LISTEN")), true);
  check(
    "日志里记下了升级到 SIGKILL",
    logLines.some((l) => /SIGKILL/.test(l)),
    logLines.filter((l) => /relay:/.test(l)).slice(-4),
  );
  eq("端口最后是我们的", vps.portHeld(publicPort), true);
  // 收尾不该留定时器(SIGKILL 那之后端口就空了,不需要再转)。
  eq("清理过程没留下定时器在飞", timers.pendingTimers(), 0);
});

await scenario("端口被别的服务占着:清不掉就大声报错,说清是谁", {}, async (vps) => {
  const publicPort = saveVps(vps.port);
  vps.holdPort(publicPort, "foreign");
  windowStub.__reset();

  const result = await relayManager.connect();
  eq("清不掉时报失败", result.ok, false);
  const st = relayManager.getStatus() as RelayStatusLike;
  eq("状态**不是** connected", st.state === "connected", false);
  eq("endpoint 没留在面板上", st.endpoint, null);
  // ⚠️ 这一条是判据的核心:用户得从这行字里知道"该去 VPS 上杀谁"。
  check("文案里说了端口释放失败", /释放失败|占用/.test(st.error ?? ""), { error: st.error });
  check("文案里点了端口号", (st.error ?? "").includes(String(publicPort)), { error: st.error });
  // holder 那一行也带出来了(`ss -ltnp | grep :PORT` 的输出) —— 不然用户无从下手。
  check("文案里带上了占着它的进程(可排查)", /nginx/.test(st.error ?? ""), { error: st.error });
});

/* ═══════════════════════ 6. 反向隧道失败:半截状态 ═══════════════════════ */

await scenario("转发器起来了但反向隧道被拒:不许留 endpoint", { acceptForward: false }, async (vps) => {
  saveVps(vps.port);
  windowStub.__reset();

  const result = await relayManager.connect();
  eq("connect() 报失败", result.ok, false);
  const st = relayManager.getStatus() as RelayStatusLike;
  eq("状态**不是** connected", st.state === "connected", false);
  // ⚠️ 半截状态的核心:转发器在本机看着像好了,但隧道没通,面板上**不能**出现
  //    一个连不通的地址 —— 用户会拿它去扫码。
  eq("endpoint 没留在面板上", st.endpoint, null);
  check("文案里说了是反向隧道的问题", /隧道/.test(st.error ?? ""), { error: st.error });
  // ⚠️ 判据是"**用户先读到的是人话**",不是"一个英文字母都没有"。中继刻意保留了
  //    ssh2 的原文当细节(排查要用),所以文案是 `SSH 反向隧道建立失败: Unable to bind…`
  //    —— 开头那个 `SSH` 是无害的,要抓的是**整句就是英文原话**、用户看不出在说哪一步
  //    的那种。形状上就是:中文说明必须出现在英文细节**之前**。
  {
    const e = st.error ?? "";
    const firstCjk = e.search(/[一-龥]/);
    const firstRaw = e.search(/Unable to bind/i);
    check(
      "文案先给人话(中文说明在英文细节之前),不是 ssh2 的英文原话打头",
      firstCjk !== -1 && (firstRaw === -1 || firstCjk < firstRaw),
      { error: e, firstCjk, firstRaw },
    );
  }
  // 面板那一行有长度限制(`RemoteConnectPanel` 里就一行小字)。中继自己把 detail
  // 截到 160 字 —— 这条钉住别哪天塞进去一整段 ssh2 堆栈。
  check("文案不长(面板就那么一行)", (st.error ?? "").length <= 200, { len: (st.error ?? "").length });

  // 前面那几条推送里也不许出现过地址。
  check(
    "整条推送链上从来没出现过 endpoint",
    pushes().every((p) => p.status.endpoint === null),
    pushes().map((p) => [p.status.state, p.status.endpoint]),
  );
});

/* ═══════════════════════ 7. 断线重连:退避 ═══════════════════════ */

await scenario("连上之后 VPS 把连接掐了:退避一路退到 32s、有上限、不忙等、最后放弃", {}, async (vps) => {
  saveVps(vps.port);
  await relayManager.connect();
  windowStub.__reset();
  timers.reset();

  // ⚠️ **要让整条退避链真的走完,得让每一次重连都失败。** 只掐一次连接是不够的:
  //    fake VPS 还活着,第一次重连就成功了,阶梯停在 2s —— 那样"上限 32s""最多 5 次"
  //    "放弃了会说清楚"三条全都验不到(它们只会看到长度 1 的 delays 数组,恒绿)。
  //
  //    做法是把服务端**挡在门外**:认证一律拒(`acceptAuth:false`),但**不关**那个
  //    假 VPS —— 每条重连都得到一个"连得上但认证不过"的服务器,那正是退避该处理的
  //    情形。`killClients()` 只负责把当前这条掐掉去触发第一轮退避。
  //    (不能只 `close()`:服务端一关端口就没了,重连报 `ECONNREFUSED` —— 也失败,
  //     但那是"压根连不上",与"连上了但被拒"不是同一条路。)
  vps.refuseAuthFromNow();
  vps.killClients();

  // ⚠️ 等的是"账本上排满了 5 跳" —— **不是** `state === "error"`。给退避收尾的那次
  //    `setState({state:"error"})` 是在第 6 次 `scheduleReconnect()` 里做的,而那个
  //    调用发生在第 5 跳定时器**执行完 + doConnect 走完**之后;`waitFor` 每 20ms 才
  //    看一次状态,很容易在它落地前就超时(实测:12 秒等不到,last 停在 "重连(3/5)")。
  //    账本长度只增不减,拿它等才稳。读完账本再单独等状态(那时它已经在路上了)。
  await waitUntil("等到 5 跳退避全部排完", () => timers.delaysWith(timers.BACKOFF_FP).length >= 5, 15_000);

  // 判据立在**排定的那些数字**上(不是墙钟):观察台记的就是排定值,加速执行不影响它。
  const delays = timers.delaysWith(timers.BACKOFF_FP);
  check("排过重连定时器", delays.length > 0, delays);
  // ⚠️ **不能是一秒一次的忙等。** 起点 2s 这条就是判据:任何 < 1s 的间隔都意味着
  //    连接失败时会把对端打爆。
  check("没有小于 1s 的间隔(不是忙等)", delays.every((d) => d >= 1000), delays);
  check("每次延迟都不小于上一次(没有越退越快)", delays.every((d, i) => i === 0 || d >= delays[i - 1]), delays);
  check("每次延迟都不超过 32s(有上限)", delays.every((d) => d <= 32_000), delays);
  // ⚠️ 整条阶梯:2s/4s/8s/16s/32s,逐次翻倍、封顶 32s、恰好 5 跳
  //    (`MAX_RECONNECT_ATTEMPTS`)。长度也在这条里 —— `<= 5` 那种写法"只排了两跳
  //    就出别的事"也照样绿。
  eq("退避阶梯是 2s/4s/8s/16s/32s(逐次翻倍、封顶 32s、恰好 5 跳)", delays.join(","), "2000,4000,8000,16000,32000");

  // 上限到了要说清楚,并且**停下来**。账本到 5 只是"最后一跳排下了",那之后还要:
  // 最后一次 `doConnect()` 真的失败 → `conn.on("error")` 看到 `reconnectAttempts`
  // 已经到顶 → 才 `setState({state:"error", …})`。所以等的是**状态**,给它期限。
  // Authentication errors also temporarily use state="error" while a retry
  // is still scheduled. Wait for the explicit terminal give-up state; keep
  // the independent endpoint/timer assertions below, rather than sampling an
  // intermediate authentication error and calling it "gave up".
  const ended = await waitFor("等到退避走到上限并放弃",
    (st) => st.state === "error" && /重试 \d+ 次后放弃/.test(st.error ?? ""), 12_000);
  eq("账本排满时状态就是 error(不再显示 connecting)", ended.state, "error");
  check("放弃时给了明确的文案", /重试 \d+ 次后放弃/.test(ended.error ?? ""), { error: ended.error });
  eq("放弃之后 endpoint 清掉", ended.endpoint, null);
  eq("放弃之后状态不是 connected", ended.state === "connected", false);
  // 放弃之后**必须真的停**:再有定时器在飞就意味着它会一直打下去。
  const beforeIdle = timers.delaysWith(timers.BACKOFF_FP).length;
  await realSleep(200);
  eq("放弃之后没有再排新的退避", timers.delaysWith(timers.BACKOFF_FP).length, beforeIdle);
  eq("放弃之后退避定时器一个都不在飞", timers.pendingWith(timers.BACKOFF_FP), 0);
});

await scenario("重连成功之后回到 connected 且不留定时器", {}, async (vps) => {
  const publicPort = saveVps(vps.port);
  await relayManager.connect();
  timers.reset();

  const before = vps.totalClients;
  vps.killClients();
  // ⚠️ 等"服务端又看到一条连接",不等 `state === "connecting"`:退避被加速之后
  //    中间那一格只存在几毫秒,按状态轮必然错过(见 `waitUntil`)。
  await waitUntil("等到重连那一条真的连上来", () => vps.totalClients > before, 8000);
  await waitFor("等到重新连上", (st) => st.state === "connected", 10_000);
  // ⚠️ 还有一段尾巴要等:`reconnectAttempts = 0` 与"账本上那一跳结清"都写在
  //    `ready` 处理器的部署成功**之后**(就在状态变 connected 那一两句之内),
  //    立刻读账本会读到第 1 跳刚排下、还没执行的那一条 —— 那不是"重连之后还排退避",
  //    是这一轮还没走完。用 `readyCount >= 2`(只增不减)等到那一刻。
  await waitUntil(
    "等到这一轮真的走完(账本上没有在飞的退避)",
    () => vps.readyCount >= 2 && timers.pendingWith(timers.BACKOFF_FP) === 0,
    8000,
  );
  const st = relayManager.getStatus() as RelayStatusLike;
  eq("重新连上了", st.state, "connected");
  eq("endpoint 又有了", st.endpoint, `http://127.0.0.1:${publicPort}`);
  eq("重连之后没留定时器在飞", timers.pendingTimers(), 0);
  eq("重连之后没有再排新的退避", timers.pendingWith(timers.BACKOFF_FP), 0);
});

await scenarioHeld("按住定时器:退避排了之后**有人清**", {}, async (vps) => {
  saveVps(vps.port);
  await relayManager.connect();
  timers.reset();

  vps.killClients();
  // ⚠️ 等"账本上出现了一条退避" —— **不是** `state === "connecting"`。hold 模式下
  //    退避不会被加速执行,所以状态稳稳停在 connecting;但**第一跳是 `scheduleReconnect`
  //    自己 `setState` 的**,而排定时器的 `log.info` 写在它前面。按状态轮的话可能在
  //    定时器还没排上时就返回,`pendingWith` 当场读到 0(实测就是这样红过)。
  await waitUntil("等到退避真的排下了", () => timers.delaysWith(timers.BACKOFF_FP).length > 0, 6000);
  // hold 模式下退避定时器既不执行也不被清 —— 它就该一直"在飞"。
  check(
    "hold 模式下确实按住了退避定时器(不是空过)",
    timers.pendingWith(timers.BACKOFF_FP) > 0,
    timers.all().filter((e) => e.stack.includes(timers.BACKOFF_FP)).map((e) => [e.ms, e.fired, e.cleared]),
  );

  // 用户在等待期间点了"断开" —— `disconnect()` 必须把那个在飞的定时器清掉。
  await relayManager.disconnect();
  await realSleep(120);
  eq("disconnect() 之后退避定时器清干净了", timers.pendingWith(timers.BACKOFF_FP), 0);
  eq("disconnect() 之后一个定时器都不剩", timers.pendingTimers(), 0);
});

/* ═══════════════════════ 8. 用户点了断开 / 应用退出:不许重连 ═══════════════════════ */

await scenario("用户点了断开:不许偷偷重连", {}, async (vps) => {
  saveVps(vps.port);
  await relayManager.connect();
  timers.reset();
  windowStub.__reset();

  await relayManager.disconnect();
  // 断开时 `conn.end()` 会走 'close' 处理器 —— 那里有个"要不要重连"的岔路。
  await realSleep(400);

  eq("断开之后没有排任何重连", timers.delaysWith(timers.BACKOFF_FP).length, 0);
  eq("断开之后没有定时器在飞", timers.pendingTimers(), 0);
  const st = relayManager.getStatus() as RelayStatusLike;
  eq("状态停在 idle", st.state, "idle");
  check("断开之后没有再连上来", vps.readyCount <= 1, vps.readyCount);
  check(
    "推送里没有出现'正在重连'",
    pushes().every((p) => !/正在重连/.test(p.status.error ?? "")),
    pushes().map((p) => p.status.error),
  );
});

await scenario("disposeAll(应用退出)之后也不许重连", {}, async (vps) => {
  saveVps(vps.port);
  await relayManager.connect();
  timers.reset();

  relayManager.disposeAll();
  await realSleep(400);

  eq("disposeAll 之后没有排重连", timers.delaysWith(timers.BACKOFF_FP).length, 0);
  eq("disposeAll 之后没有定时器在飞", timers.pendingTimers(), 0);
  eq("disposeAll 之后 VPS 那边也空了", vps.liveClients, 0);
});

/* ═══════════════════════ 9. 状态泄漏:反复连断 ═══════════════════════ */

await scenario("连断 8 次之后不留定时器 / 不留连接", {}, async (vps) => {
  saveVps(vps.port);
  timers.reset();
  const before = vps.totalClients;

  for (let i = 0; i < 8; i += 1) {
    await relayManager.connect();
    await relayManager.disconnect();
    await realSleep(40);
  }
  await realSleep(300);

  eq("中继没留下任何定时器", timers.pendingTimers(), 0);
  eq("中继没排过重连", timers.delaysWith(timers.BACKOFF_FP).length, 0);
  eq("VPS 那边一条连接都不剩", vps.liveClients, 0);
  check("每轮都真的新建了一条连接", vps.totalClients >= before + 8, { before, after: vps.totalClients });
  eq("收尾状态是 idle", (relayManager.getStatus() as RelayStatusLike).state, "idle");
});

await scenario("连到一半就断开:不许留半截,`connect()` 也不许悬着", { hangAuth: true }, async (vps) => {
  saveVps(vps.port);
  timers.reset();
  windowStub.__reset();

  // ⚠️ 认证**挂着不答**(`hangAuth`)是刻意的:那条路上 `ready` 永远不会来,也不会触发
  //    `error` —— 于是只有用户在握手没完时点的 `disconnect()`(`conn.end()`)能收场。
  //    用一个"刚好还没握手完"的时序去碰运气是不行的:实测把修复撤掉时,握手常常已经
  //    走完,`ready` 那条路会替它兜住,断言照绿 —— 那就成了**空过**。
  const pending = relayManager.connect();
  await waitUntil("等到真的连上了假 VPS(握手开始)", () => vps.totalClients > 0, 6000);
  eq("这一刻还没 ready(认证挂着)", vps.readyCount, 0);

  await relayManager.disconnect();

  // ⚠️ **这一条不是"顺手核一下" —— 它钉的是一个会让界面永久卡住的缺口。**
  //    用户在握手没完时点"断开",走的是 `conn.end()`(**不触发 `error`**);只有
  //    `ready` / `error` 两条出口的写法会让这个 promise 永远悬着,而渲染端的
  //    `handleConnect()` 是在 `await api.relay.connect()` **之后**才清 `busy` ——
  //    悬着 = 那颗按钮永远转着圈、点不动,直到重启应用。所以这里给它一个期限:
  //    超时就是失败(不是"等久一点就好")。
  const raced = await Promise.race([
    pending.then((r) => ({ done: true as const, r })),
    realSleep(4000).then(() => ({ done: false as const, r: null })),
  ]);
  check(
    "半途断开时 connect() 也会给出答复(不会永远悬着,界面不会卡住)",
    raced.done,
    { vpsClients: vps.totalClients, ready: vps.readyCount },
  );
  if (raced.done) {
    eq("这个答复说的是没连上", raced.r.ok, false);
  }

  await realSleep(400);
  const st = relayManager.getStatus() as RelayStatusLike;
  eq("收尾状态是 idle(不是卡在 connecting)", st.state, "idle");
  eq("endpoint 没有留下", st.endpoint, null);
  eq("forwarderType 没有留下", st.forwarderType, null);
  eq("没有定时器在飞", timers.pendingTimers(), 0);
  eq("没有偷偷重连", timers.delaysWith(timers.BACKOFF_FP).length, 0);
  // ⚠️ 半途断开的这一次**不许**在面板上留一行错。用户自己点的断开,面板该是"未连接"。
  eq("半途断开之后面板上没有留错误文案", st.error, null);
});

/* ═══════════════════════ 10. IPC 层 ═══════════════════════ */

console.log("\n══ 10. IPC handler");

{
  /** 录下来的 `ipcMain`,照 SKILL.md 的 fakeIpc 模式。 */
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const fakeIpc = { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) } as never;
  registerRelayHandlers(fakeIpc);
  const call = (ch: string, ...args: unknown[]) => {
    const fn = handlers.get(ch);
    if (!fn) throw new Error(`没有注册 ${ch}`);
    return fn(null, ...args);
  };

  const channels = [...handlers.keys()];
  for (const ch of [
    IPC.RELAY_SAVE_CONFIG,
    IPC.RELAY_GET_CONFIG,
    IPC.RELAY_CONNECT,
    IPC.RELAY_DISCONNECT,
    IPC.RELAY_STATUS,
  ]) {
    check(`注册了 ${ch}`, channels.includes(ch), channels);
  }

  dumpConfig();
  const vps = await startFakeVps({ execReplies: NORMAL_EXEC });
  const ipcPort = takePort();
  const saved = await call(IPC.RELAY_SAVE_CONFIG, {
    host: "127.0.0.1",
    sshPort: vps.port,
    username: "root",
    password: "IPC_SENTINEL_PW",
    publicPort: ipcPort,
    forwarder: "auto",
  });
  eq("saveConfig 回了 ok", (saved as { ok: boolean }).ok, true);

  const got = (await call(IPC.RELAY_GET_CONFIG)) as { config: { host: string } | null };
  eq("getConfig 读回来的是刚存的那份", got.config?.host, "127.0.0.1");

  // ⚠️ 凭据的落盘形式是设计如此(明文,与设备令牌同一个威胁模型 —— 设置库就在用户
  //    自己的 userData 里,见 contracts/relay.ts 的注释)。钉住它,免得哪天有人
  //    换了加密而"读回来还能用"这条被悄悄忽略。
  check(
    "VPS 密码以明文存在 settings 里(设计如此)",
    rawVpsSetting()?.includes("IPC_SENTINEL_PW") === true,
    { raw: rawVpsSetting()?.slice(0, 120) },
  );
  // 明文落盘是设计,但它**还会被 getConfig 原样带回渲染端** —— 面板要回填表单,
  // 所以这是现状。钉住它:哪天有人决定中继的密码也该走 safeStorage,这条会先红。
  check(
    "getConfig 把密码也带回了渲染端(表单回填要用;见报告里「凭据」那一段)",
    got.config !== null && JSON.stringify(got.config).includes("IPC_SENTINEL_PW"),
    { keys: got.config ? Object.keys(got.config) : null },
  );

  const status = (await call(IPC.RELAY_STATUS)) as RelayStatusLike;
  check("status 返回一个快照", typeof status.state === "string", status);

  const conn = (await call(IPC.RELAY_CONNECT)) as { ok: boolean; error?: string };
  check("connect 回了一个结果(不是抛出去的)", typeof conn.ok === "boolean", conn);
  const afterStatus = (await call(IPC.RELAY_STATUS)) as RelayStatusLike;
  eq("status 与 connect 的返回值一致", afterStatus.state === "connected", conn.ok);
  if (conn.ok) eq("连上之后 status 里有 endpoint", afterStatus.endpoint, `http://127.0.0.1:${ipcPort}`);

  // 坏输入:zod 拦住它 —— 但**返回值**是刻意的"照样回 ok"(表单自己校验)。
  const bad = await call(IPC.RELAY_SAVE_CONFIG, { host: "", sshPort: 99999, username: "" });
  eq("坏输入不抛异常", (bad as { ok: boolean }).ok, true);
  const afterBad = (await call(IPC.RELAY_GET_CONFIG)) as { config: { host: string } | null };
  eq("坏输入没有覆盖掉刚才那份配置", afterBad.config?.host, "127.0.0.1");
  check(
    "坏输入也没有把库写坏(读回来的仍是一份能解析的 JSON)",
    (() => {
      try {
        JSON.parse(rawVpsSetting() ?? "null");
        return true;
      } catch {
        return false;
      }
    })(),
    rawVpsSetting(),
  );

  await call(IPC.RELAY_DISCONNECT);
  const afterDisc = (await call(IPC.RELAY_STATUS)) as RelayStatusLike;
  eq("disconnect 之后 status 是 idle", afterDisc.state, "idle");
  await vps.close();
  await relayManager.disconnect();
}

/* ═══════════════════════ 11. 凭据不进日志 ═══════════════════════ */

console.log("\n══ 11. 凭据");

{
  const all = logLines.join("\n");
  // ⚠️ 这条守卫不能省:日志一条都没有的话,下面三条"没泄露"是**空过**的。
  check("日志里确实有中继的行(下一条不是空过)", /relay:/.test(all), { lines: logLines.length });
  noSecret("SSH 密码没出现在日志里", all, "SMOKE_SSH_PASSWORD_SENTINEL");
  noSecret("IPC 那次的密码没出现在日志里", all, "IPC_SENTINEL_PW");
  noSecret("私钥内容没出现在日志里", all, "BEGIN OPENSSH PRIVATE KEY");
}

/* ═══════════════════════ 收尾 ═══════════════════════ */

await mobileStub.__down();
timers.uninstall();
process.stderr.write = realStderrWrite as never;

console.log(`\n${checks} 条断言,${failures} 条红`);
if (failures > 0) process.exit(1);
process.exit(0);
