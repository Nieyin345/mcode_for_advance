import { generateKeyPairSync } from "node:crypto";
import fs, { existsSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer as createAgentServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
const { Server: SshServer } = ssh2;
import { createAgentRemoteSshManager, __remoteSshTest, scrubConnectionSecrets, HOST_KEY_MISMATCH_MESSAGE } from "@main/mcp/agentRemoteSsh.js";
import { SettingRepo, armGetThrow, getThrowCount, armSetThrow, setThrowCount } from "./stubs/settingRepo.js";

let checks = 0;
let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); console.log(`  ✗ ${name}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | Promise<T>, pred: (v: T) => boolean, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  let last = await fn();
  while (!pred(last) && Date.now() < end) { await sleep(80); last = await fn(); }
  return last;
}
async function bash(command: string, home: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], { env: { ...process.env, HOME: home }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
function parseLog(raw: string): { size: number; data: Buffer } {
  const size = Number(raw.match(/^SIZE=(\d+)/m)?.[1] ?? 0);
  const encoded = raw.match(/^DATA=([A-Za-z0-9+/=]*)/m)?.[1] ?? "";
  return { size, data: encoded ? Buffer.from(encoded, "base64") : Buffer.alloc(0) };
}

console.log("\n[1] remote job wrapper: detached + idempotent + cursor logs");
const home = mkdtempSync(path.join(tmpdir(), "mcode-remote-ssh-"));
try {
  const jobId = "train-smoke-1";
  const command = "printf 'step-1\\n'; sleep 0.15; printf 'step-2\\n'; printf 'err-line\\n' >&2";
  const startCmd = __remoteSshTest.buildJobStartCommand(jobId, command, "", "nohup");
  const first = await bash(startCmd, home);
  check("first start succeeds", first.code === 0, first);
  check("first start says CREATED", first.stdout.includes("MCODE_JOB_CREATED"), first.stdout);
  const second = await bash(startCmd, home);
  check("same job id is idempotent", second.stdout.includes("MCODE_JOB_EXISTING"), second.stdout);

  const status = await waitFor(
    async () => __remoteSshTest.parseJobStatus(jobId, (await bash(__remoteSshTest.buildJobStatusCommand(jobId), home)).stdout),
    (s) => s.state === "completed",
  );
  check("detached job completes after launcher command returned", status.state === "completed", status);
  check("exit code persisted", status.exitCode === 0, status);
  check("stdout byte count persisted", status.stdoutBytes > 0, status);

  const page1Raw = await bash(__remoteSshTest.buildJobLogCommand(jobId, "stdout", 0, 6), home);
  const page1 = parseLog(page1Raw.stdout);
  const page2Raw = await bash(__remoteSshTest.buildJobLogCommand(jobId, "stdout", page1.data.length, 100), home);
  const page2 = parseLog(page2Raw.stdout);
  const combined = Buffer.concat([page1.data, page2.data]).toString("utf8");
  check("log cursor resumes without repeating early bytes", combined.includes("step-1") && combined.includes("step-2"), combined);
  check("reported size matches reconstructed stdout", page2.size === Buffer.byteLength(combined), { page2, combined });
  const errRaw = await bash(__remoteSshTest.buildJobLogCommand(jobId, "stderr", 0, 100), home);
  check("stderr is independently recoverable", parseLog(errRaw.stdout).data.toString("utf8").includes("err-line"), errRaw.stdout);

  /* ── 日志读取要能**阻塞等到有新输出**(wait 语义)────────────────────────
     没有这个语义时,模型读一次日志拿不到东西就得立刻再问一次 —— 跑一个几分钟的
     训练会变成几十次空往返(用户报的"断断续续汇报")。这正是本地 `agent_process_read`
     修过的病,远端这条以前漏了。

     实现方式:远端 shell 自己轮询文件大小,等到有新字节或超时才返回 ——
     一次 SSH 往返把等待做完,而不是把轮询丢回给模型。 */
  console.log("\n[1b] job log wait semantics");
  const waitId = "logwait-smoke-1";
  await bash(
    __remoteSshTest.buildJobStartCommand(waitId, "printf 'first\\n'; sleep 2; printf 'second\\n'", "", "nohup"),
    home,
  );
  const early = parseLog((await bash(__remoteSshTest.buildJobLogCommand(waitId, "stdout", 0, 100), home)).stdout);
  check("wait 前只读到已落盘的部分", early.data.toString("utf8").includes("first"), early.data.toString("utf8"));
  const waitedRaw = await bash(
    __remoteSshTest.buildJobLogCommand(waitId, "stdout", early.data.length, 100, 8000),
    home,
  );
  const waited = parseLog(waitedRaw.stdout);
  check(
    "带 wait 的读取会阻塞等到后续输出(不是立刻回空)",
    waited.data.toString("utf8").includes("second"),
    waited.data.toString("utf8"),
  );

  console.log("\n[1c] finished job: log read at EOF must not wait; cursor past EOF is clamped");
  const doneStatus = __remoteSshTest.parseJobStatus(jobId, (await bash(__remoteSshTest.buildJobStatusCommand(jobId), home)).stdout);
  check("前提:train-smoke-1 已跑完", doneStatus.state === "completed", doneStatus);
  const eofStart = Date.now();
  const eofRaw = await bash(__remoteSshTest.buildJobLogCommand(jobId, "stdout", doneStatus.stdoutBytes, 100, 8000), home);
  const eofMs = Date.now() - eofStart;
  check("已结束任务读到末尾时立即返回(不挂满 wait)", eofMs < 4000, eofMs);
  const eofParsed = __remoteSshTest.parseJobLogOutput(eofRaw.stdout, doneStatus.stdoutBytes, 100);
  check("返回 job_finished=true 且没有更多输出", eofParsed.jobFinished && !eofParsed.truncated && eofParsed.text === "", eofParsed);
  const pastStart = Date.now();
  const pastRaw = await bash(__remoteSshTest.buildJobLogCommand(jobId, "stdout", 9999, 100, 8000), home);
  check("cursor 超过文件大小时立即返回", Date.now() - pastStart < 4000, Date.now() - pastStart);
  const past = __remoteSshTest.parseJobLogOutput(pastRaw.stdout, 9999, 100);
  check("cursor 超过文件大小时 next_cursor 拉回文件大小", past.nextCursor === past.totalBytes && past.totalBytes === doneStatus.stdoutBytes, past);

  console.log("\n[2] remote job cancellation marker / completed precedence");
  await bash(__remoteSshTest.buildJobCancelCommand(jobId), home);
  const afterCancel = __remoteSshTest.parseJobStatus(jobId, (await bash(__remoteSshTest.buildJobStatusCommand(jobId), home)).stdout);
  check("cancelling an already completed job does not rewrite history as cancelled", afterCancel.state === "completed", afterCancel);

  const cancelId = "cancel-smoke-1";
  const cancelStart = await bash(
    __remoteSshTest.buildJobStartCommand(cancelId, "printf 'begin\\n'; sleep 30; printf 'end\\n'", "", "nohup"),
    home,
  );
  check("long job starts before cancellation", cancelStart.stdout.includes("MCODE_JOB_CREATED"), cancelStart);
  const running = await waitFor(
    async () => __remoteSshTest.parseJobStatus(cancelId, (await bash(__remoteSshTest.buildJobStatusCommand(cancelId), home)).stdout),
    (s) => s.state === "running",
    3000,
  );
  check("long job reaches running/started before cancellation", process.platform === "win32" ? running.startedAt !== null && running.exitCode === null : running.state === "running", running);
  await bash(__remoteSshTest.buildJobCancelCommand(cancelId), home);
  const cancelled = await waitFor(
    async () => __remoteSshTest.parseJobStatus(cancelId, (await bash(__remoteSshTest.buildJobStatusCommand(cancelId), home)).stdout),
    (s) => s.state === "cancelled",
    4000,
  );
  check("running job becomes cancelled", cancelled.state === "cancelled", cancelled);
  await sleep(300);
  const cancelledLog = parseLog((await bash(__remoteSshTest.buildJobLogCommand(cancelId, "stdout", 0, 1000), home)).stdout).data.toString("utf8");
  check("cancelled job does not continue to write trailing output", cancelledLog.includes("begin") && !cancelledLog.includes("end"), cancelledLog);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("\n[2b] pure helpers: utf-8 safe cursor / exec pid marker");
{
  const zh = Buffer.from("训练", "utf8"); // 6 字节
  const encodedCut = zh.subarray(0, 4).toString("base64");
  const cut = __remoteSshTest.parseJobLogOutput(`SIZE=6\nDONE=0\nDATA=${encodedCut}\n`, 0, 4);
  check("读满 max_bytes 时不把半个 UTF-8 字符算进 next_cursor", cut.nextCursor === 3 && cut.text === "训" && cut.truncated, cut);

  const unicode = Buffer.from("训练😀日志", "utf8");
  let cursor = 0; let output = "";
  while (cursor < unicode.length) {
    const encoded = unicode.subarray(cursor, cursor + 4).toString("base64");
    const page = __remoteSshTest.parseJobLogOutput(`SIZE=${unicode.length}\nDONE=1\nDATA=${encoded}\n`, cursor, 4);
    check("minimum accepted budget advances UTF8 cursor", page.nextCursor > cursor, page);
    if (page.nextCursor <= cursor) break;
    output += page.text; cursor = page.nextCursor;
  }
  check("minimum-budget log pages preserve Chinese and emoji", output === "训练😀日志", output);

  const sp = __remoteSshTest.splitExecPid("__MCODE_EXEC_PID=4242\nreal err\n");
  check("exec 进程号标记能解析并从 stderr 剥掉", sp?.pid === 4242 && sp.rest === "real err\n", sp);
  check("标记分包未收全时先不解析", __remoteSshTest.splitExecPid("__MCODE_EX") === null);
  check("没有标记的 stderr 原样保留", __remoteSshTest.splitExecPid("boom\n")?.rest === "boom\n");
  check("包装命令以子 sh 的 $PPID 取进程号", __remoteSshTest.wrapExecCommand("echo hi").startsWith("sh -c 'printf") && __remoteSshTest.wrapExecCommand("echo hi").endsWith("\necho hi"));
}

console.log("\n[3] ssh connection manager: real ssh2 handshake + forced reconnect");
const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
const hostKey = kp.privateKey.export({ type: "pkcs1", format: "pem" });
const serverClients = new Set<any>();
const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
  serverClients.add(client);
  client.on("close", () => serverClients.delete(client));
  client.on("authentication", (ctx) => ctx.accept());
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        stream.write(`ran:${info.command}\n`);
        stream.exit(0);
        stream.end();
      });
    });
  });
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
const addr = server.address();
if (!addr || typeof addr === "string") throw new Error("fake ssh server missing port");
const mgr = createAgentRemoteSshManager();
const owner = "sess-a";
// 【MC-052】首连不再自动信任:传输层这套用例先用**事先核对过的指纹**授信首连,后续
// 复用同一 host:port 的连接即为 TRUSTED。指纹由夹具 host key 直接算出(与 §3c 同源)。
const fixturePub = ssh2.utils.parseKey(hostKey);
if (fixturePub instanceof Error || Array.isArray(fixturePub)) throw new Error("fixture host key did not parse");
const fixtureFp = __remoteSshTest.fingerprintOfHostKey(fixturePub.getPublicSSH());
const conn = await mgr.connect({ ownerSessionId: owner, host: "127.0.0.1", port: addr.port, username: "u", password: "p", expectedFingerprint: fixtureFp, keepaliveIntervalMs: 5000 });
let rejectedImplicitAuth = false;
try { await mgr.connect({ ownerSessionId: owner, host: "127.0.0.1", port: addr.port, username: "u" }); }
catch { rejectedImplicitAuth = true; }
check("credentials must be explicit even when another connection is cached", rejectedImplicitAuth);
let rejectedTinyBudget = false;
try { await mgr.jobLogs({ ownerSessionId: owner, connectionId: conn.connectionId, jobId: "fixture", stream: "stdout", maxBytes: 1 }); }
catch (e) { rejectedTinyBudget = /max_bytes/.test(String(e)); }
check("tiny UTF8 budget rejects before remote execution", rejectedTinyBudget);

check("initial ssh handshake reaches ready", conn.state === "ready", conn);
const changedAuth = await mgr.connect({ ownerSessionId: owner, host: "127.0.0.1", port: addr.port, username: "u", password: "different" });
check("different configured auth does not reuse an authenticated session", changedAuth.connectionId !== conn.connectionId);
await mgr.disconnect(owner, changedAuth.connectionId);
for (const invalid of [
  { username: "" },
  { port: 0 },
  { password: "p", privateKeyPath: "/nonexistent-fixture-key" },
  { password: "p", passphrase: "invalid-without-key" },
]) {
  let rejected = false;
  try { await mgr.connect({ ownerSessionId: owner, host: "127.0.0.1", port: addr.port, username: "u", password: "p", ...invalid }); } catch { rejected = true; }
  check("explicit SSH configuration rejects missing/ambiguous fields", rejected);
}

const exec1 = await mgr.exec(owner, conn.connectionId, "echo one");
check("short remote exec works", exec1.stdout.includes("echo one"), exec1);
let isolated = false;
try { mgr.status("sess-b", conn.connectionId); } catch { isolated = true; }
check("connection id is isolated to the creating conversation", isolated);
for (const c of [...serverClients]) c.end();
const dropped = await waitFor(() => mgr.status(owner, conn.connectionId), (s) => s.state !== "ready", 2500);
check("forced socket close is detected", dropped.state !== "ready", dropped);
const recovered = await waitFor(() => mgr.status(owner, conn.connectionId), (s) => s.state === "ready", 6000);
check("manager reconnects automatically", recovered.state === "ready", recovered);
const exec2 = await mgr.exec(owner, conn.connectionId, "echo two");
check("exec works after reconnect", exec2.stdout.includes("echo two"), exec2);
await mgr.disconnect(owner, conn.connectionId);
// MC-018:主动断开**从记录里移除**该连接(不再只是标 closed 留着),所以 status 现在
// 应当解不出这条 id。这也是反复断/连不再让 Map 无界增长的根因。
let disconnectGone = false;
try { mgr.status(owner, conn.connectionId); } catch { disconnectGone = true; }
check("主动断开后连接记录被移除(status 不再解析)", disconnectGone);
// Conversation deleted (disposeOwner, OBS-M14-01): close without auto-reconnect
// and forget every entry of that owner.
const conn2 = await mgr.connect({ ownerSessionId: owner, host: "127.0.0.1", port: addr.port, username: "u", password: "p", keepaliveIntervalMs: 5000 });
check("second connection reaches ready", conn2.state === "ready", conn2);
mgr.disposeOwner(owner);
check("disposeOwner forgets all of the conversation's connections", mgr.list(owner).length === 0, mgr.list(owner));
let disposedGone = false;
try { mgr.status(owner, conn2.connectionId); } catch { disposedGone = true; }
check("disposed connection id no longer resolves", disposedGone);
await waitFor(() => serverClients.size, (n) => n === 0, 2500);
await new Promise((resolve) => setTimeout(resolve, 1500));
check("disposed connection is closed and does not reconnect", serverClients.size === 0, serverClients.size);
await new Promise<void>((resolve) => server.close(() => resolve()));

console.log("\n[3c] MC-052 首次信任:无 pin 且未授信 → 暂停认证(不发凭据);授信匹配才连;已 pin 复校");
{
  SettingRepo.__clear();
  let tofuPasswordAttempts = 0;
  const tofuClients = new Set<any>();
  const tserver = new SshServer({ hostKeys: [hostKey] }, (client) => {
    tofuClients.add(client);
    client.on("close", () => tofuClients.delete(client));
    // 只接受 password 认证:这样"服务器收到了密码"是**可观测**的 —— 初始 none 被拒后,
    // 客户端只有在真正走到认证阶段才会送密码。用来证明"未批准的首见连除 KEX 外没发凭据"。
    client.on("authentication", (ctx) => { if (ctx.method === "password") { tofuPasswordAttempts++; ctx.accept(); } else ctx.reject(["password"]); });
    client.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => tserver.listen(0, "127.0.0.1", () => resolve()));
  const tAddr = tserver.address();
  if (!tAddr || typeof tAddr === "string") throw new Error("tofu server missing port");
  const hostPort = `127.0.0.1:${tAddr.port}`;
  const m = createAgentRemoteSshManager();
  // ssh2 的 hostVerifier 拿到的是**公钥 blob**(SSH 线格式),不是私钥 PEM —— 用
  // parseKey 取 getPublicSSH() 才是同一份字节。
  const pubParsed = ssh2.utils.parseKey(hostKey);
  if (pubParsed instanceof Error || Array.isArray(pubParsed)) throw new Error("fixture host key did not parse");
  const expectedFp = __remoteSshTest.fingerprintOfHostKey(pubParsed.getPublicSSH());

  // ★【MC-052 核心】首见、无 pin、未给 expected_fingerprint → 暂停认证(待用户批准),
  //   绝不自动 TOFU。判据是"未进入认证"(服务器一个 authentication 事件都没收到),不是提示文字。
  const pending = await m.connect({ ownerSessionId: "tofu", host: "127.0.0.1", port: tAddr.port, username: "u", password: "p" });
  check("★ 首见未授信 → state=error(不进入认证)", pending.state === "error", pending);
  check("★ 首见未授信 → 标记待用户批准", pending.hostKeyPendingConfirmation === true, pending);
  check("★ 待批准时给出候选指纹供用户独立核对", pending.hostKeyCandidateFingerprint === expectedFp, pending.hostKeyCandidateFingerprint);
  check("★ 待批准文案要求带外核对指纹", (pending.lastError ?? "").includes("暂停认证") && (pending.lastError ?? "").includes(expectedFp), pending.lastError);
  check("★ 未授权首见 → 一个凭据都没发送(服务器未收到任何密码)", tofuPasswordAttempts === 0, tofuPasswordAttempts);
  check("★ 未授权首见 → 不写入任何指纹(不自动 TOFU)", __remoteSshTest.readKnownHosts()[hostPort] === undefined, __remoteSshTest.readKnownHosts());
  check("★ 未授权首见 → 不自动重连", pending.reconnectAttempt === 0, pending);

  // 用户带外核对一致后,以 expected_fingerprint(= 服务器实际指纹)重连 → 记录 pin 并放行认证。
  const first = await m.connect({ ownerSessionId: "tofu", host: "127.0.0.1", port: tAddr.port, username: "u", password: "p", expectedFingerprint: expectedFp });
  check("★ 事先授信指纹匹配 → 首连成功", first.state === "ready", first);
  check("★ 授信首连在结果里报告已记录指纹", first.hostKeyRecorded === true, first);
  const recorded = __remoteSshTest.readKnownHosts()[hostPort];
  check("★ 授信首连把 SHA256 指纹写入 known-hosts", __remoteSshTest.isWellFormedFingerprint(recorded), recorded);
  check("★ 记录的指纹与服务器 host key 一致", __remoteSshTest.sameFingerprint(recorded, expectedFp), { recorded, expectedFp });
  check("★ 授信首连确实进入了认证(服务器收到密码)", tofuPasswordAttempts > 0, tofuPasswordAttempts);


  // 再见(同一 host:port,同一 key):放行,不再重复报告"记录"。
  await m.disconnect("tofu", first.connectionId);
  const again = await m.connect({ ownerSessionId: "tofu", host: "127.0.0.1", port: tAddr.port, username: "u", password: "p" });
  check("已知主机再次连接成功", again.state === "ready", again);
  check("已知主机再次连接不再报告记录", again.hostKeyRecorded === false, again);

  // 无 pin 的陌生主机 + 事先给的指纹与实际**不符** → 拒绝,绝不写入(不能把"我以为的指纹"落盘)。
  await m.disconnect("tofu", again.connectionId);
  SettingRepo.delete(__remoteSshTest.SSH_KNOWN_HOSTS_SETTING_KEY); // 回到"无 pin"
  const wrongExpected = `SHA256:${"A".repeat(43)}`;
  const expMism = await m.connect({ ownerSessionId: "tofu", host: "127.0.0.1", port: tAddr.port, username: "u", password: "p", expectedFingerprint: wrongExpected });
  check("★ 期望指纹与实际不符 → state=error", expMism.state === "error", expMism);
  check("★ 期望指纹不符文案点名期望指纹对不上", (expMism.lastError ?? "").includes("期望指纹"), expMism.lastError);
  check("★ 期望不符 → 不写入任何 pin", __remoteSshTest.readKnownHosts()[hostPort] === undefined, __remoteSshTest.readKnownHosts());

  // 错配:把记录的指纹换成另一个**合法形状**的错值 → 必须拒绝,且不重连、不覆盖。
  const wrongFp = `SHA256:${"B".repeat(43)}`;
  SettingRepo.set(__remoteSshTest.SSH_KNOWN_HOSTS_SETTING_KEY, JSON.stringify({ [hostPort]: wrongFp }));
  await m.disconnect("tofu", expMism.connectionId);
  const mism = await m.connect({ ownerSessionId: "tofu", host: "127.0.0.1", port: tAddr.port, username: "u", password: "p" });
  check("指纹不一致 → state=error(拒绝连接)", mism.state === "error", mism);
  check("指纹不一致的文案点名「主机密钥变了」", (mism.lastError ?? "").includes("主机密钥变了"), mism.lastError);
  check("指纹不一致不自动重连", mism.reconnectAttempt === 0, mism);
  check("被拒后不会覆盖已记录的指纹", __remoteSshTest.readKnownHosts()[hostPort] === wrongFp, __remoteSshTest.readKnownHosts());

  // 重连也必须校验:先恢复正确指纹、连上,再把记录换成错值、强制掉线 ——
  // 自动重连走到 hostVerifier 时应当**再次拒绝**,而不是把变了的 key 当新指纹接受。
  SettingRepo.set(__remoteSshTest.SSH_KNOWN_HOSTS_SETTING_KEY, JSON.stringify({ [hostPort]: recorded }));
  await m.disconnect("tofu", mism.connectionId);
  const live = await m.connect({ ownerSessionId: "tofu", host: "127.0.0.1", port: tAddr.port, username: "u", password: "p" });
  check("恢复正确指纹后又能连上", live.state === "ready", live);
  SettingRepo.set(__remoteSshTest.SSH_KNOWN_HOSTS_SETTING_KEY, JSON.stringify({ [hostPort]: wrongFp }));
  for (const c of [...tofuClients]) c.end();
  const revdrop = await waitFor(() => m.status("tofu", live.connectionId), (s) => s.state === "error", 4000);
  check("重连也校验指纹:掉线后指纹已变 → 停到 error 不放行", revdrop.state === "error", revdrop);
  m.disposeOwner("tofu");
  await new Promise<void>((resolve) => tserver.close(() => resolve()));
}

console.log("\n[3c-3] MC-014 第47.2节:授信首连的 pin 没落盘成功 → 拒绝认证(耐久回执)");
{
  // 从前 writeKnownHost 的返回值只用来决定要不要报 hostKeyRecorded,然后**无条件
  // return true** —— pin 写不进时照样发凭据,而"被批准的主机"在信任表里并不存在。
  // 经批准的首次授信必须有**耐久回执**:写不进就拒绝认证。
  SettingRepo.__clear();
  let pwAttempts = 0;
  const clients = new Set<any>();
  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("authentication", (ctx) => { if (ctx.method === "password") { pwAttempts += 1; ctx.accept(); } else ctx.reject(["password"]); });
    client.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("3c-3 server missing port");
  const hostPort = "127.0.0.1:" + addr.port;
  const pub = ssh2.utils.parseKey(hostKey);
  if (pub instanceof Error || Array.isArray(pub)) throw new Error("fixture host key did not parse");
  const expectedFp = __remoteSshTest.fingerprintOfHostKey(pub.getPublicSSH());
  const m = createAgentRemoteSshManager();

  armSetThrow(true);
  let fail: Awaited<ReturnType<typeof m.connect>> | null = null;
  try {
    fail = await m.connect({ ownerSessionId: "durable", host: "127.0.0.1", port: addr.port, username: "u", password: "p", expectedFingerprint: expectedFp });
  } finally {
    armSetThrow(false);
  }
  check("★ pin 落盘失败 → state=error(不放行)", fail?.state === "error", fail);
  check("★ pin 落盘失败确实被触发(不是空过)", setThrowCount() > 0, setThrowCount());
  check("★ pin 落盘失败 → 未进入认证(凭据未发送)", pwAttempts === 0, pwAttempts);
  check("★ pin 落盘失败 → 信任表里没有这条 pin", __remoteSshTest.readKnownHosts()[hostPort] === undefined, __remoteSshTest.readKnownHosts());
  const retryOk = await m.connect({ ownerSessionId: "durable", host: "127.0.0.1", port: addr.port, username: "u", password: "p", expectedFingerprint: expectedFp });
  check("★ 故障解除后重新授信 → 连上并记下 pin", retryOk.state === "ready" && __remoteSshTest.readKnownHosts()[hostPort] !== undefined, { state: retryOk.state });
  check("★ 落盘失败期间服务器没收到过任何密码", pwAttempts === 1, pwAttempts);
  m.disposeOwner("durable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log("\n[3c-2] MC-014 第43.1节残余:known-hosts 损坏/读异常 → fail-closed 拒连,不自动 TOFU");
{
  SettingRepo.__clear();
  const sClients = new Set<any>();
  const sserver = new SshServer({ hostKeys: [hostKey] }, (client) => {
    sClients.add(client);
    client.on("close", () => sClients.delete(client));
    client.on("authentication", (ctx) => ctx.accept());
    client.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => sserver.listen(0, "127.0.0.1", () => resolve()));
  const sAddr = sserver.address();
  if (!sAddr || typeof sAddr === "string") throw new Error("store-invalid server missing port");
  const hostPort = `127.0.0.1:${sAddr.port}`;

  // ① 先用**事先核对过的指纹**授信首连一次 —— 记下可信指纹(模拟"此前已登记过这台主机")。
  //    【MC-052】不再有"首见自动记录":无 expected_fingerprint 的陌生主机只会停在待批准。
  let goodFp = "";
  {
    const pubParsed = ssh2.utils.parseKey(hostKey);
    if (pubParsed instanceof Error || Array.isArray(pubParsed)) throw new Error("fixture host key did not parse");
    const expectedFp = __remoteSshTest.fingerprintOfHostKey(pubParsed.getPublicSSH());
    const m = createAgentRemoteSshManager();
    const first = await m.connect({ ownerSessionId: "store", host: "127.0.0.1", port: sAddr.port, username: "u", password: "p", expectedFingerprint: expectedFp });
    goodFp = __remoteSshTest.readKnownHosts()[hostPort] ?? "";
    check("前置:授信首连成功且记下指纹", first.state === "ready" && __remoteSshTest.isWellFormedFingerprint(goodFp), first);
    m.disposeOwner("store");
  }

  // ② 把设置键写成**损坏的 JSON**(模拟存储被截断)→ 此前已登记的主机绝不能被当成"首次见面"
  //    而自动信任。判据:state=error、文案点名"信任表损坏"、且**不**重连、**不**覆盖记录。
  {
    const m = createAgentRemoteSshManager();
    SettingRepo.set(__remoteSshTest.SSH_KNOWN_HOSTS_SETTING_KEY, '{"127.0.0.1:1": {"trunca');
    const corrupt = await m.connect({ ownerSessionId: "store", host: "127.0.0.1", port: sAddr.port, username: "u", password: "p" });
    check("★ 存储损坏 → state=error(拒连,不把故障当首次见面)", corrupt.state === "error", corrupt);
    check("★ 文案点名信任表损坏/读不出来", (corrupt.lastError ?? "").includes("信任表") && (corrupt.lastError ?? "").includes("损坏"), corrupt.lastError);
    check("★ 损坏时不自动重连", corrupt.reconnectAttempt === 0, corrupt);
    check("★ 损坏的原值没有被覆盖", SettingRepo.get(__remoteSshTest.SSH_KNOWN_HOSTS_SETTING_KEY) === '{"127.0.0.1:1": {"trunca', SettingRepo.get(__remoteSshTest.SSH_KNOWN_HOSTS_SETTING_KEY));
    m.disposeOwner("store");
  }

  // ③ 设置**读取本身抛错**(库故障)→ 同样 fail-closed,不当作"没有记录"。
  {
    const m = createAgentRemoteSshManager();
    SettingRepo.set(__remoteSshTest.SSH_KNOWN_HOSTS_SETTING_KEY, JSON.stringify({ [hostPort]: "SHA256:" + "B".repeat(43) }));
    armGetThrow(true);
    let threw = false;
    let res: Awaited<ReturnType<typeof m.connect>> | null = null;
    try {
      res = await m.connect({ ownerSessionId: "store", host: "127.0.0.1", port: sAddr.port, username: "u", password: "p" });
    } catch {
      threw = true;
    } finally {
      armGetThrow(false);
    }
    check("★ 设置读取抛错 → 拒连(不静默放行/不谎报成功)", threw || (res !== null && res.state === "error"), { threw, res });
    check("★ 读故障确实被触发(不是空过)", getThrowCount() > 0, getThrowCount());
    m.disposeOwner("store");
  }

  // ④ 正控:存储恢复正常(写回正确指纹)后同一主机仍能连上、指纹未丢。
  {
    const m = createAgentRemoteSshManager();
    SettingRepo.set(__remoteSshTest.SSH_KNOWN_HOSTS_SETTING_KEY, JSON.stringify({ [hostPort]: goodFp }));
    const good = await m.connect({ ownerSessionId: "store", host: "127.0.0.1", port: sAddr.port, username: "u", password: "p" });
    check("★ 正控:存储恢复后能连上(故障不毁信任表)", good.state === "ready", good);
    m.disposeOwner("store");
  }

  SettingRepo.__clear();
  await new Promise<void>((resolve) => sserver.close(() => resolve()));
}

console.log("\n[3f] MC-052 纯判定 decideHostTrust:五种终态 + 入参校验");
{
  // 判定与授信副作用已分离:decideHostTrust 是纯函数,六个分支可在这里直接覆盖,
  // 不依赖任何真实握手。这也是"唯一会写信任的路径是事先授信首连"的可审计证据。
  const fpA = `SHA256:${"A".repeat(43)}`;
  const fpB = `SHA256:${"B".repeat(43)}`;
  const valid = (hosts: Record<string, string>) => ({ status: "VALID" as const, hosts });
  const missing = { status: "MISSING" as const, hosts: {} };

  check("无 pin + 未授信 → PENDING_CONFIRMATION(携候选指纹)",
    (() => { const d = __remoteSshTest.decideHostTrust({ read: missing, hostPort: "h:22", actual: fpA }); return d.verdict === "PENDING_CONFIRMATION" && d.candidate === fpA; })());
  check("无 pin + 授信指纹一致 → PINNED_NEW(可写 pin)",
    __remoteSshTest.decideHostTrust({ read: missing, hostPort: "h:22", actual: fpA, expectedFingerprint: fpA }).verdict === "PINNED_NEW");
  check("无 pin + 授信指纹不一致 → EXPECTED_MISMATCH(不写 pin)",
    __remoteSshTest.decideHostTrust({ read: missing, hostPort: "h:22", actual: fpA, expectedFingerprint: fpB }).verdict === "EXPECTED_MISMATCH");
  check("已 pin 且一致 → TRUSTED",
    __remoteSshTest.decideHostTrust({ read: valid({ "h:22": fpA }), hostPort: "h:22", actual: fpA }).verdict === "TRUSTED");
  check("已 pin 且变了 → MISMATCH(即使给了正确的新期望也不放行)",
    __remoteSshTest.decideHostTrust({ read: valid({ "h:22": fpA }), hostPort: "h:22", actual: fpB, expectedFingerprint: fpB }).verdict === "MISMATCH");
  check("存储损坏 → STORE_INVALID(fail-closed)",
    __remoteSshTest.decideHostTrust({ read: { status: "INVALID", hosts: {}, error: "boom" }, hostPort: "h:22", actual: fpA }).verdict === "STORE_INVALID");
  // 存储里有**其他**主机的 pin、但没有本机的 → 仍算无 pin,须待批准(不能因表非空就放行)。
  check("表中只有别的 host → 本机仍按无 pin 待批准",
    __remoteSshTest.decideHostTrust({ read: valid({ "other:22": fpA }), hostPort: "h:22", actual: fpA }).verdict === "PENDING_CONFIRMATION");
  // 入参校验:畸形期望指纹在 connect() 入口就被拒(不让"两边都畸形"造成假匹配)。
  check("畸形 expected_fingerprint 不被当作合法形状", !__remoteSshTest.isWellFormedFingerprint("SHA256:short"), __remoteSshTest.isWellFormedFingerprint("SHA256:short"));
  // 待批准文案必须同时点名"暂停认证"与候选指纹 —— 这是用户唯一能去带外核对的线索。
  const msg = __remoteSshTest.pendingConfirmationMessage(fpA);
  check("待批准文案点名暂停认证且给出候选指纹", msg.includes("暂停认证") && msg.includes(fpA), msg);
}

console.log("\n[3d] MC-018 disconnect removes the record and scrubs secrets");
{
  const lserver = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => lserver.listen(0, "127.0.0.1", () => resolve()));
  const lAddr = lserver.address();
  if (!lAddr || typeof lAddr === "string") throw new Error("lifecycle server missing port");
  const m = createAgentRemoteSshManager();
  // 反复断/连 100 次:每次 connect 都新建一条,disconnect 必须把它从记录里移除,
  // 否则 entries Map 会无界增长。
  for (let i = 0; i < 100; i++) {
    const c = await m.connect({ ownerSessionId: "o", host: "127.0.0.1", port: lAddr.port, username: "u", password: `secret-${i}`, expectedFingerprint: fixtureFp });
    if (m.list("o").length > 1) break;
    await m.disconnect("o", c.connectionId);
  }
  check("反复断/连 100 次后记录数不无界增长", m.list("o").length === 0, m.list("o").length);

  // 口令不驻留:scrubConnectionSecrets 必须清掉 password / passphrase(以及私钥路径)。
  const cfg = { host: "h", port: 22, username: "u", password: "p@ss", passphrase: "pp", privateKeyPath: "/k", agentPath: "/a" } as Record<string, unknown>;
  scrubConnectionSecrets(cfg);
  check("断开清理抹掉 password/passphrase/私钥/agent 路径", cfg.password === undefined && cfg.passphrase === undefined && cfg.privateKeyPath === undefined && cfg.agentPath === undefined, cfg);
  check("清理保留可读元数据 host/port/username", cfg.host === "h" && cfg.port === 22 && cfg.username === "u", cfg);

  // 断开后 reconnect 必须拿到**新的** connection id(证明旧记录已从 Map 移除)。
  const c1 = await m.connect({ ownerSessionId: "o", host: "127.0.0.1", port: lAddr.port, username: "u", password: "p", expectedFingerprint: fixtureFp });
  await m.disconnect("o", c1.connectionId);
  const c2 = await m.connect({ ownerSessionId: "o", host: "127.0.0.1", port: lAddr.port, username: "u", password: "p" });
  check("断开后重连拿到新的 connection id(旧记录已移除)", c2.connectionId !== c1.connectionId, { c1: c1.connectionId, c2: c2.connectionId });
  m.disposeOwner("o");
  await new Promise<void>((resolve) => lserver.close(() => resolve()));
}

console.log("\n[4] auth failure must not auto-reconnect");
{
  let authAttempts = 0;
  const denyServer = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method !== "none") authAttempts++;
      ctx.reject(["password"]);
    });
    client.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => denyServer.listen(0, "127.0.0.1", () => resolve()));
  const dAddr = denyServer.address();
  if (!dAddr || typeof dAddr === "string") throw new Error("deny server missing port");
  const mgr2 = createAgentRemoteSshManager();
  const bad = await mgr2.connect({ ownerSessionId: "o", host: "127.0.0.1", port: dAddr.port, username: "u", password: "wrong", expectedFingerprint: fixtureFp });
  check("认证失败 → state=error", bad.state === "error", bad);
  const attemptsAfterConnect = authAttempts;
  await sleep(2500);
  const later = mgr2.status("o", bad.connectionId);
  check("认证失败后不进入 reconnecting", later.state === "error" && later.reconnectAttempt === 0, later);
  check("认证失败后不再撞服务器", authAttempts === attemptsAfterConnect, { authAttempts, attemptsAfterConnect });
  check("错误信息提示 private_key_path", (later.lastError ?? "").includes("private_key_path"), later.lastError);
  mgr2.disposeOwner("o");
  await new Promise<void>((resolve) => denyServer.close(() => resolve()));
}

console.log("\n[4b] explicitly configured SSH agent (named pipe on Windows)");
{
  const agentHome = mkdtempSync(path.join(tmpdir(), "mcode-agent-fixture-"));
  const agentPath = process.platform === "win32" ? `\\\\.\\pipe\\mcode-agent-fixture-${process.pid}-${Date.now()}` : path.join(agentHome, "agent.sock");
  const parsed = ssh2.utils.parseKey(hostKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("fixture private key did not parse");
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const str = (b: Buffer) => Buffer.concat([u32(b.length), b]);
  let identities = 0; let signatures = 0;
  const sockets = new Set<import("node:net").Socket>();
  const agent = createAgentServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let pending = Buffer.alloc(0);
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= pending.readUInt32BE(0) + 4) {
        const size = pending.readUInt32BE(0); const request = pending.subarray(4, size + 4); pending = pending.subarray(size + 4);
        let response: Buffer;
        if (request[0] === 11) {
          identities++;
          response = Buffer.concat([Buffer.from([12]), u32(1), str(parsed.getPublicSSH()), str(Buffer.from("isolated-fixture"))]);
        } else if (request[0] === 13) {
          signatures++;
          let offset = 1;
          const read = () => { const n = request.readUInt32BE(offset); offset += 4; const result = request.subarray(offset, offset + n); offset += n; return result; };
          read(); const data = read(); const flags = request.readUInt32BE(offset);
          const algorithm = flags & 4 ? "rsa-sha2-512" : flags & 2 ? "rsa-sha2-256" : "ssh-rsa";
          const signature = parsed.sign(data, flags & 4 ? "sha512" : flags & 2 ? "sha256" : "sha1");
          if (signature instanceof Error) throw signature;
          response = Buffer.concat([Buffer.from([14]), str(Buffer.concat([str(Buffer.from(algorithm)), str(signature)]))]);
        } else response = Buffer.from([5]);
        socket.write(Buffer.concat([u32(response.length), response]));
      }
    });
  });
  await new Promise<void>((resolve, reject) => { agent.once("error", reject); agent.listen(agentPath, resolve); });
  const target = new SshServer({ hostKeys: [hostKey] }, client => {
    client.on("error", () => {});
    client.on("authentication", ctx => { if (ctx.method === "publickey") ctx.accept(); else ctx.reject(["publickey"]); });
  });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const targetAddress = target.address();
  if (!targetAddress || typeof targetAddress === "string") throw new Error("fixture target missing port");
  const explicit = createAgentRemoteSshManager();
  const nativeExistsSync = fs.existsSync;
  try {
    // OpenSSH service pipes and Node-created pipes have different ACL/stat behavior.
    // Deterministically reproduce a connectable endpoint whose filesystem probe is false.
    fs.existsSync = (candidate) => String(candidate) === agentPath ? false : nativeExistsSync(candidate);
    syncBuiltinESMExports();
    check("fixture simulates a false filesystem probe for the selected agent", !existsSync(agentPath));
    const connected = await explicit.connect({ ownerSessionId: "agent-fixture", host: "127.0.0.1", port: targetAddress.port, username: "fixture", agentPath, expectedFingerprint: fixtureFp });
    check("explicit agent completes real ssh2 authentication", connected.state === "ready", connected);
    check("the selected agent lists identities and signs", identities > 0 && signatures > 0, { identities, signatures });
  } finally {
    fs.existsSync = nativeExistsSync;
    syncBuiltinESMExports();
    explicit.disposeOwner("agent-fixture");
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => target.close(() => resolve()));
    await new Promise<void>(resolve => agent.close(() => resolve()));
    rmSync(agentHome, { recursive: true, force: true });
  }
}

console.log("\n[5] exec through a real shell: stdin EOF, pid marker hidden, timeout kills");
{
  const execCommands: string[] = [];
  const fixtureChildren: ReturnType<typeof spawn>[] = [];
  const shellServer = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("error", () => undefined);
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          execCommands.push(info.command);
          const stream = acceptExec();
          const child = spawn("bash", ["-c", info.command], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
          fixtureChildren.push(child);
          stream.pipe(child.stdin);
          child.stdout.on("data", (d: Buffer) => { try { stream.write(d); } catch { /* channel gone */ } });
          child.stderr.on("data", (d: Buffer) => { try { stream.stderr.write(d); } catch { /* channel gone */ } });
          child.once("close", (c) => { try { stream.exit(c ?? 1); stream.end(); } catch { /* channel gone */ } });
          stream.once("close", () => {
            try { child.kill(); } catch { /* exited */ }
            // The local Bash fixture can leave descendants holding inherited
            // pipes on Windows. Once the SSH channel is closed nobody can
            // consume them; release our pipe handles as well as the child.
            // Otherwise every assertion passes but Node never exits.
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
          });
        });
      });
    });
  });
  await new Promise<void>((resolve) => shellServer.listen(0, "127.0.0.1", () => resolve()));
  const sAddr = shellServer.address();
  if (!sAddr || typeof sAddr === "string") throw new Error("shell server missing port");
  const mgr3 = createAgentRemoteSshManager();
  const sc = await mgr3.connect({ ownerSessionId: "o", host: "127.0.0.1", port: sAddr.port, username: "u", password: "p", expectedFingerprint: fixtureFp });
  check("shell server ready", sc.state === "ready", sc);
  const t0 = Date.now();
  const rd = await mgr3.exec("o", sc.connectionId, "read x; echo \"got:[$x] rc=$?\"; echo err-line >&2", 10_000);
  check("读 stdin 的命令立刻拿到 EOF(不挂到超时)", Date.now() - t0 < 5000 && rd.stdout.includes("got:[]"), { ms: Date.now() - t0, rd });
  check("stderr 里看不到进程号标记", rd.stderr.trim() === "err-line", rd.stderr);
  let timeoutMsg = "";
  try { await mgr3.exec("o", sc.connectionId, "echo before; sleep 20", 1_500); } catch (e) { timeoutMsg = (e as Error).message; }
  check("超时报错并带上超时前的输出", timeoutMsg.includes("超过") && timeoutMsg.includes("before"), timeoutMsg);
  await waitFor(() => execCommands.some((c) => c.includes("kill -TERM -- -")), (v) => v, 3000);
  check("超时后向远端发了杀进程组的命令", execCommands.some((c) => c.includes("kill -TERM -- -")), execCommands.slice(-2));
  mgr3.disposeOwner("o");
  await new Promise<void>((resolve) => { shellServer.close(() => resolve()); setTimeout(resolve, 1500); });
  const pipesReleased = await waitFor(
    () => fixtureChildren.every(child => child.stdin?.destroyed && child.stdout?.destroyed && child.stderr?.destroyed),
    released => released, 3000,
  );
  check("模拟 SSH 通道关闭后释放全部本地子进程管道", pipesReleased, fixtureChildren.length);
}

console.log("\n[5b] MC-015 bounded exec output: tail window + byte totals + head-first truncation note");
{
  const big = 200_000;
  const tailTag = "TAIL-MARKER-END";
  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("error", () => undefined);
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        if (!info.command.includes("big")) {
          // "small" 命令:少量输出,不该被截断。
          stream.write("small-ok\n");
          stream.exit(0);
          stream.end();
          return;
        }
        // stdout:big 字节 'A' + 尾部标记。
        stream.write(Buffer.alloc(big, 0x41));
        stream.write(Buffer.from(tailTag, "utf8"));
        // stderr:超过独立(更小)的上限 + 尾部标记。
        stream.stderr.write(Buffer.alloc(40_000, 0x42));
        stream.stderr.write(Buffer.from("ERR-TAIL", "utf8"));
        stream.exit(0);
        stream.end();
      });
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const sAddr = server.address();
  if (!sAddr || typeof sAddr === "string") throw new Error("bounded server missing port");
  const m = createAgentRemoteSshManager();
  const c = await m.connect({ ownerSessionId: "o", host: "127.0.0.1", port: sAddr.port, username: "u", password: "p", expectedFingerprint: fixtureFp });
  const r = await m.exec("o", c.connectionId, "big", 30_000);
  check("超限 stdout 被标记截断", r.stdoutTruncated === true, { truncated: r.stdoutTruncated });
  check("stdout 报告接收总量(全部字节,不只是留下的)", r.stdoutTotalBytes === big + tailTag.length, r.stdoutTotalBytes);
  check("截断说明写在正文**前面**", r.stdout.startsWith("…(输出超过"), r.stdout.slice(0, 40));
  check("截断仍保留尾部内容", r.stdout.includes(tailTag), r.stdout.slice(-24));
  check("保留的 stdout 不超过尾部窗口", r.stdout.length <= __remoteSshTest.MAX_EXEC_STDOUT_BYTES + 80, r.stdout.length);
  check("超限 stderr 单独标记截断", r.stderrTruncated === true, { truncated: r.stderrTruncated });
  check("stderr 报告接收总量", r.stderrTotalBytes === 40_000 + "ERR-TAIL".length, r.stderrTotalBytes);
  check("stderr 截断说明写在前面且保留尾部", r.stderr.startsWith("…(输出超过") && r.stderr.includes("ERR-TAIL"), r.stderr.slice(0, 40) + " … " + r.stderr.slice(-12));
  check("少量输出不截断", (await m.exec("o", c.connectionId, "small", 10_000)).stdoutTruncated === false);
  m.disposeOwner("o");
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log("\n[5c] MC-017 exec streams: multi-byte chars split across chunks decode intact; stdout/stderr stay separate");
{
  // 逐字节写,强制把每个多字节字符切在两三块之间 —— 没有跨块解码器就会出 U+FFFD。
  const zhStdout = "训练😀日志";
  const zhStderr = "错误⚠️结束";
  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("error", () => undefined);
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec) => {
        const stream = acceptExec();
        void (async () => {
          const out = Buffer.from(zhStdout, "utf8");
          for (let i = 0; i < out.length; i++) {
            stream.write(out.subarray(i, i + 1));
            await sleep(6);
          }
          const err = Buffer.from(zhStderr, "utf8");
          for (let i = 0; i < err.length; i++) {
            stream.stderr.write(err.subarray(i, i + 1));
            await sleep(6);
          }
          stream.exit(0);
          stream.end();
        })();
      });
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const sAddr = server.address();
  if (!sAddr || typeof sAddr === "string") throw new Error("chunk server missing port");
  const m = createAgentRemoteSshManager();
  const c = await m.connect({ ownerSessionId: "o", host: "127.0.0.1", port: sAddr.port, username: "u", password: "p", expectedFingerprint: fixtureFp });
  const r = await m.exec("o", c.connectionId, "multibyte", 30_000);
  check("跨块的中文/emoji 在 stdout 完整还原", r.stdout === zhStdout, r.stdout);
  check("跨块的中文/emoji 在 stderr 完整还原", r.stderr === zhStderr, r.stderr);
  check("stdout 没有替换字符 U+FFFD", !r.stdout.includes("�"), r.stdout);
  check("stderr 没有替换字符 U+FFFD", !r.stderr.includes("�"), r.stderr);
  check("stdout 与 stderr 不串流", r.stdout === zhStdout && r.stderr === zhStderr, { out: r.stdout, err: r.stderr });
  m.disposeOwner("o");
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(`\nremote-ssh-smoke: ${passed}/${checks} passed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
