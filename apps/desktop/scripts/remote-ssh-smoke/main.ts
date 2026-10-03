import { generateKeyPairSync } from "node:crypto";
import fs, { existsSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer as createAgentServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
const { Server: SshServer } = ssh2;
import { createAgentRemoteSshManager, __remoteSshTest } from "@main/mcp/agentRemoteSsh.js";

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
const conn = await mgr.connect({ ownerSessionId: owner, host: "127.0.0.1", port: addr.port, username: "u", password: "p", keepaliveIntervalMs: 5000 });
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
check("intentional disconnect stops connection", mgr.status(owner, conn.connectionId).state === "closed");
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
  const bad = await mgr2.connect({ ownerSessionId: "o", host: "127.0.0.1", port: dAddr.port, username: "u", password: "wrong" });
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
    const connected = await explicit.connect({ ownerSessionId: "agent-fixture", host: "127.0.0.1", port: targetAddress.port, username: "fixture", agentPath });
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
          stream.pipe(child.stdin);
          child.stdout.on("data", (d: Buffer) => { try { stream.write(d); } catch { /* channel gone */ } });
          child.stderr.on("data", (d: Buffer) => { try { stream.stderr.write(d); } catch { /* channel gone */ } });
          child.once("close", (c) => { try { stream.exit(c ?? 1); stream.end(); } catch { /* channel gone */ } });
          stream.once("close", () => { try { child.kill(); } catch { /* exited */ } });
        });
      });
    });
  });
  await new Promise<void>((resolve) => shellServer.listen(0, "127.0.0.1", () => resolve()));
  const sAddr = shellServer.address();
  if (!sAddr || typeof sAddr === "string") throw new Error("shell server missing port");
  const mgr3 = createAgentRemoteSshManager();
  const sc = await mgr3.connect({ ownerSessionId: "o", host: "127.0.0.1", port: sAddr.port, username: "u", password: "p" });
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
}

console.log(`\nremote-ssh-smoke: ${passed}/${checks} passed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
