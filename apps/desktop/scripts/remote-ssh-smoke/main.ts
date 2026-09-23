import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
check("initial ssh handshake reaches ready", conn.state === "ready", conn);
const exec1 = await mgr.exec(owner, conn.connectionId, "echo one");
check("short remote exec works", exec1.stdout.includes("ran:echo one"), exec1);
let isolated = false;
try { mgr.status("sess-b", conn.connectionId); } catch { isolated = true; }
check("connection id is isolated to the creating conversation", isolated);
for (const c of [...serverClients]) c.end();
const dropped = await waitFor(() => mgr.status(owner, conn.connectionId), (s) => s.state !== "ready", 2500);
check("forced socket close is detected", dropped.state !== "ready", dropped);
const recovered = await waitFor(() => mgr.status(owner, conn.connectionId), (s) => s.state === "ready", 6000);
check("manager reconnects automatically", recovered.state === "ready", recovered);
const exec2 = await mgr.exec(owner, conn.connectionId, "echo two");
check("exec works after reconnect", exec2.stdout.includes("ran:echo two"), exec2);
await mgr.disconnect(owner, conn.connectionId);
check("intentional disconnect stops connection", mgr.status(owner, conn.connectionId).state === "closed");
await new Promise<void>((resolve) => server.close(() => resolve()));

console.log(`\nremote-ssh-smoke: ${passed}/${checks} passed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
