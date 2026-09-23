/**
 * Reliable SSH + remote training jobs for mcode-agent.
 *
 * The SSH socket is disposable; job truth lives on the remote host under
 * ~/.mcode/jobs/<jobId>. A dropped MCP/chat/SSH connection therefore cannot
 * kill a training run, and reconnecting can re-attach to status/log files.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
// 具名导入 —— **必须**这样写。`import ssh2 from "ssh2"` + 解构 `const { Client } = ssh2`
// 拿到的是**值**,而 `Client` 在这里也要当**类型**用(`client: Client | null`),那条路
// 编译不过(`'Client' refers to a value, but is being used as a type`)。同仓库的
// `relay/RelayManager.ts` 就是这么导的,照它。
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

const DEFAULT_KEEPALIVE_MS = 15_000;
const DEFAULT_KEEPALIVE_COUNT = 4;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/** `agent_ssh_exec` 的默认 / 最大超时。**导出**给工具表用 —— 那里的 zod schema 与
 *  说明文字原先各自写死 30000 / 600000,和这里靠"数字碰巧一样"对齐。三处同一个数
 *  写三遍,改一处必漂移,所以收成唯一来源(硬规矩 2)。 */
export const DEFAULT_SSH_EXEC_TIMEOUT_MS = 30_000;
export const MAX_SSH_EXEC_TIMEOUT_MS = 10 * 60_000;
const MAX_EXEC_TIMEOUT_MS = MAX_SSH_EXEC_TIMEOUT_MS;
/**
 * `agent_remote_job_logs` 的默认 / 最大**等待**时长(等新日志出现)。
 *
 * 55 秒,与本地 `agent_process_read` 同一个理由(见那边的注释):ChatGPT 对单次工具
 * 调用有 ~60 秒硬上限,留 5 秒余量。默认值就是"等到有东西"——模型不该被逼着做短轮询。
 */
export const DEFAULT_JOB_LOG_WAIT_MS = 55_000;
export const MAX_JOB_LOG_WAIT_MS = 55_000;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type RemoteConnectionState = "connecting" | "ready" | "reconnecting" | "error" | "closed";

export interface RemoteConnectInput {
  ownerSessionId: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  readyTimeoutMs?: number;
}

interface RemoteEntry {
  id: string;
  ownerSessionId: string;
  cfg: Required<Pick<RemoteConnectInput, "host" | "port" | "username">> & Omit<RemoteConnectInput, "ownerSessionId" | "host" | "port" | "username">;
  client: Client | null;
  state: RemoteConnectionState;
  intentionalClose: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connectPromise: Promise<void> | null;
  lastError: string | null;
  connectedAt: number | null;
  lastActivityAt: number | null;
}

export interface RemoteConnectionInfo {
  connectionId: string;
  host: string;
  port: number;
  username: string;
  state: RemoteConnectionState;
  reconnectAttempt: number;
  lastError: string | null;
  connectedAt: number | null;
  lastActivityAt: number | null;
}

export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}

export interface RemoteJobStatus {
  jobId: string;
  state: "starting" | "running" | "completed" | "cancelled" | "lost" | "missing";
  pid: number | null;
  exitCode: number | null;
  mode: string | null;
  tmuxSession: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface RemoteJobLogResult {
  jobId: string;
  stream: "stdout" | "stderr";
  text: string;
  cursor: number;
  nextCursor: number;
  totalBytes: number;
  truncated: boolean;
}

export function createAgentRemoteSshManager() {
  const entries = new Map<string, RemoteEntry>();

  const owned = (ownerSessionId: string, connectionId: string): RemoteEntry => {
    const entry = entries.get(connectionId);
    if (!entry || entry.ownerSessionId !== ownerSessionId) throw new Error("SSH 连接不存在，或不属于当前对话");
    return entry;
  };

  const infoOf = (entry: RemoteEntry): RemoteConnectionInfo => ({
    connectionId: entry.id,
    host: entry.cfg.host,
    port: entry.cfg.port,
    username: entry.cfg.username,
    state: entry.state,
    reconnectAttempt: entry.reconnectAttempt,
    lastError: entry.lastError,
    connectedAt: entry.connectedAt,
    lastActivityAt: entry.lastActivityAt,
  });

  const scheduleReconnect = (entry: RemoteEntry): void => {
    if (entry.intentionalClose || entry.reconnectTimer || entry.state === "ready") return;
    entry.reconnectAttempt += 1;
    const base = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(entry.reconnectAttempt - 1, 5));
    const jitter = Math.floor(base * (Math.random() * 0.3));
    const delay = base + jitter;
    entry.state = "reconnecting";
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      if (entry.intentionalClose) return;
      void ensureConnected(entry).catch(() => undefined);
    }, delay);
    entry.reconnectTimer.unref?.();
  };

  const buildConnectConfig = (entry: RemoteEntry): ConnectConfig => {
    const cfg: ConnectConfig = {
      host: entry.cfg.host,
      port: entry.cfg.port,
      username: entry.cfg.username,
      keepaliveInterval: entry.cfg.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS,
      keepaliveCountMax: entry.cfg.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT,
      readyTimeout: entry.cfg.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    };
    if (entry.cfg.privateKeyPath) {
      cfg.privateKey = readFileSync(entry.cfg.privateKeyPath, "utf8");
      if (entry.cfg.passphrase) cfg.passphrase = entry.cfg.passphrase;
    } else if (entry.cfg.password) {
      cfg.password = entry.cfg.password;
    } else if (process.env.SSH_AUTH_SOCK) {
      cfg.agent = process.env.SSH_AUTH_SOCK;
    }
    return cfg;
  };

  const openConnection = (entry: RemoteEntry): Promise<void> => new Promise((resolve, reject) => {
    const client = new Client();
    entry.client = client;
    entry.state = entry.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    let settled = false;
    let ready = false;
    const settleOk = () => { if (!settled) { settled = true; resolve(); } };
    const settleErr = (err: Error) => { if (!settled) { settled = true; reject(err); } };

    client.once("ready", () => {
      if (entry.intentionalClose || entry.client !== client) {
        try { client.end(); } catch { /* best effort */ }
        return settleErr(new Error("SSH 连接已取消"));
      }
      ready = true;
      entry.state = "ready";
      entry.reconnectAttempt = 0;
      entry.lastError = null;
      entry.connectedAt = Date.now();
      entry.lastActivityAt = Date.now();
      settleOk();
    });
    client.on("error", (err: Error & { level?: string }) => {
      entry.lastError = friendlySshError(err);
      if (!ready) settleErr(err);
      if (!entry.intentionalClose && isRetryableSshError(err)) {
        entry.state = "reconnecting";
        scheduleReconnect(entry);
      } else if (!entry.intentionalClose) {
        entry.state = "error";
      }
    });
    client.on("close", () => {
      // A late close from an obsolete client must not knock a newer successful
      // reconnect back into "reconnecting".
      if (entry.client !== client) {
        if (!settled) settleErr(new Error("SSH 连接在握手完成前关闭"));
        return;
      }
      entry.client = null;
      if (!settled) settleErr(new Error("SSH 连接在握手完成前关闭"));
      if (!entry.intentionalClose) {
        if (entry.state !== "error") entry.state = "reconnecting";
        scheduleReconnect(entry);
      } else {
        entry.state = "closed";
      }
    });
    try {
      client.connect(buildConnectConfig(entry));
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      entry.lastError = friendlySshError(e);
      entry.state = "error";
      settleErr(e);
    }
  });

  const ensureConnected = async (entry: RemoteEntry): Promise<void> => {
    if (entry.intentionalClose) throw new Error("SSH 连接已主动关闭");
    if (entry.state === "ready" && entry.client) return;
    if (entry.connectPromise) return entry.connectPromise;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    const promise = openConnection(entry).finally(() => {
      if (entry.connectPromise === promise) entry.connectPromise = null;
    });
    entry.connectPromise = promise;
    return promise;
  };

  const execEntry = async (entry: RemoteEntry, command: string, timeoutMs = DEFAULT_SSH_EXEC_TIMEOUT_MS): Promise<RemoteExecResult> => {
    await ensureConnected(entry);
    const client = entry.client;
    if (!client || entry.state !== "ready") throw new Error("SSH 尚未恢复连接");
    const timeout = Math.max(1_000, Math.min(timeoutMs, MAX_EXEC_TIMEOUT_MS));
    return new Promise<RemoteExecResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      client.exec(command, (err: Error | undefined, stream: ClientChannel) => {
        if (err) return reject(err);
        let stdout = "";
        let stderr = "";
        let code: number | null = null;
        let signal: string | null = null;
        let done = false;
        const finish = (fn: () => void) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          entry.lastActivityAt = Date.now();
          fn();
        };
        timer = setTimeout(() => {
          try { stream.close(); } catch { /* best effort */ }
          finish(() => reject(new Error(`远程命令超过 ${timeout}ms；长任务请用 agent_remote_job_start`)));
        }, timeout);
        stream.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
        stream.on("exit", (c: number | null, s: string | null) => { code = c; signal = s; });
        stream.on("error", (e: Error) => finish(() => reject(e)));
        stream.on("close", () => finish(() => resolve({ stdout, stderr, code, signal })));
      });
    });
  };

  const connect = async (input: RemoteConnectInput): Promise<RemoteConnectionInfo> => {
    const port = input.port ?? 22;
    for (const existing of entries.values()) {
      if (
        existing.ownerSessionId === input.ownerSessionId && !existing.intentionalClose &&
        existing.state !== "error" && existing.state !== "closed" &&
        existing.cfg.host === input.host && existing.cfg.port === port && existing.cfg.username === input.username
      ) {
        try { await ensureConnected(existing); } catch { /* background reconnect owns recovery */ }
        return infoOf(existing);
      }
    }
    const entry: RemoteEntry = {
      id: `ssh_${randomBytes(8).toString("hex")}`,
      ownerSessionId: input.ownerSessionId,
      cfg: { ...input, host: input.host, port, username: input.username },
      client: null,
      state: "connecting",
      intentionalClose: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      connectPromise: null,
      lastError: null,
      connectedAt: null,
      lastActivityAt: null,
    };
    entries.set(entry.id, entry);
    try {
      await ensureConnected(entry);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      entry.lastError = friendlySshError(e);
      if (isRetryableSshError(e)) scheduleReconnect(entry);
      else entry.state = "error";
    }
    return infoOf(entry);
  };

  const disconnect = async (ownerSessionId: string, connectionId: string): Promise<void> => {
    const entry = owned(ownerSessionId, connectionId);
    entry.intentionalClose = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
    const client = entry.client;
    entry.client = null;
    entry.state = "closed";
    try { client?.end(); } catch { /* best effort */ }
  };

  const startJob = async (args: {
    ownerSessionId: string; connectionId: string; command: string; cwd?: string; jobId?: string; mode?: "auto" | "tmux" | "nohup";
  }): Promise<{ jobId: string; created: boolean; status: RemoteJobStatus }> => {
    const entry = owned(args.ownerSessionId, args.connectionId);
    const jobId = args.jobId?.trim() || `job_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
    assertJobId(jobId);
    const command = buildJobStartCommand(jobId, args.command, args.cwd ?? "", args.mode ?? "auto");
    const result = await execEntry(entry, command, 30_000);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `远程任务启动失败(exit ${result.code})`);
    const created = result.stdout.includes("MCODE_JOB_CREATED");
    return { jobId, created, status: await jobStatus(args.ownerSessionId, args.connectionId, jobId) };
  };

  const jobStatus = async (ownerSessionId: string, connectionId: string, jobId: string): Promise<RemoteJobStatus> => {
    assertJobId(jobId);
    const entry = owned(ownerSessionId, connectionId);
    const r = await execEntry(entry, buildJobStatusCommand(jobId), 20_000);
    return parseJobStatus(jobId, r.stdout);
  };

  const jobLogs = async (args: {
    ownerSessionId: string; connectionId: string; jobId: string; stream: "stdout" | "stderr"; cursor?: number; maxBytes?: number; waitMs?: number;
  }): Promise<RemoteJobLogResult> => {
    assertJobId(args.jobId);
    const cursor = Math.max(0, args.cursor ?? 0);
    const maxBytes = Math.max(1, Math.min(args.maxBytes ?? 20_000, 60_000));
    const waitMs = Math.max(0, Math.min(args.waitMs ?? 0, MAX_JOB_LOG_WAIT_MS));
    const entry = owned(args.ownerSessionId, args.connectionId);
    // exec 超时要**比等待时长更宽**:等待本身会挂满 waitMs,若 exec 超时与之相等,
    // 等待刚结束就可能被判定超时。留 5 秒余量(还要算 base64 编码 + 网络往返)。
    const execTimeoutMs = Math.max(20_000, waitMs + 5_000);
    const r = await execEntry(entry, buildJobLogCommand(args.jobId, args.stream, cursor, maxBytes, waitMs), execTimeoutMs);
    const lines = r.stdout.split(/\r?\n/);
    const size = Number((lines.shift() ?? "SIZE=0").replace(/^SIZE=/, "")) || 0;
    const encoded = (lines.join("").match(/DATA=([A-Za-z0-9+/=]*)/)?.[1]) ?? "";
    const buf = encoded ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
    return {
      jobId: args.jobId,
      stream: args.stream,
      text: buf.toString("utf8"),
      cursor,
      nextCursor: cursor + buf.length,
      totalBytes: size,
      truncated: cursor + buf.length < size,
    };
  };

  const cancelJob = async (ownerSessionId: string, connectionId: string, jobId: string): Promise<RemoteJobStatus> => {
    assertJobId(jobId);
    const entry = owned(ownerSessionId, connectionId);
    await execEntry(entry, buildJobCancelCommand(jobId), 20_000);
    return jobStatus(ownerSessionId, connectionId, jobId);
  };

  const listJobs = async (ownerSessionId: string, connectionId: string): Promise<string[]> => {
    const entry = owned(ownerSessionId, connectionId);
    const r = await execEntry(entry, `base="$HOME/.mcode/jobs"; [ -d "$base" ] || exit 0; for d in "$base"/*; do [ -d "$d" ] && basename "$d"; done | sort | tail -n 100`, 20_000);
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => JOB_ID_RE.test(s));
  };

  return {
    connect,
    disconnect,
    exec: async (ownerSessionId: string, connectionId: string, command: string, timeoutMs?: number) =>
      execEntry(owned(ownerSessionId, connectionId), command, timeoutMs),
    list: (ownerSessionId: string) => [...entries.values()].filter((e) => e.ownerSessionId === ownerSessionId).map(infoOf),
    status: (ownerSessionId: string, connectionId: string) => infoOf(owned(ownerSessionId, connectionId)),
    startJob,
    jobStatus,
    jobLogs,
    cancelJob,
    listJobs,
  };
}

function assertJobId(jobId: string): void {
  if (!JOB_ID_RE.test(jobId)) throw new Error("job_id 只能用字母/数字/._-，长度 1-64，且必须以字母或数字开头");
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function buildJobStartCommand(jobId: string, command: string, cwd: string, mode: "auto" | "tmux" | "nohup"): string {
  const tmuxName = `mcode_${jobId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}`;
  const requireTmux = mode === "tmux" ? "1" : "0";
  const allowTmux = mode === "nohup" ? "0" : "1";
  return `set -eu\nbase="$HOME/.mcode/jobs"\njob="$base/${jobId}"\nmkdir -p "$base"\nif mkdir "$job" 2>/dev/null; then\n  printf '%s' '${b64(command)}' | base64 -d > "$job/command.sh"\n  printf '%s' '${b64(cwd)}' | base64 -d > "$job/cwd"\n  chmod 700 "$job/command.sh"\n  cat > "$job/runner.sh" <<'MCODE_RUNNER'\n#!/usr/bin/env bash\nset +e\njob_dir="$(cd "$(dirname "$0")" && pwd)"\ndate +%s > "$job_dir/started_at"\necho $$ > "$job_dir/pid"\ncwd="$(cat "$job_dir/cwd")"\ncase "$cwd" in ""|"~") cwd="$HOME";; "~/"*) cwd="$HOME/\${cwd#~/}";; esac\ncd "$cwd"\ncd_code=$?\nif [ "$cd_code" -ne 0 ]; then echo "$cd_code" > "$job_dir/exit_code"; date +%s > "$job_dir/finished_at"; exit "$cd_code"; fi\nbash "$job_dir/command.sh" >"$job_dir/stdout.log" 2>"$job_dir/stderr.log"\ncode=$?\necho "$code" > "$job_dir/exit_code"\ndate +%s > "$job_dir/finished_at"\nexit "$code"\nMCODE_RUNNER\n  chmod 700 "$job/runner.sh"\n  : > "$job/stdout.log"; : > "$job/stderr.log"\n  if [ '${allowTmux}' = '1' ] && command -v tmux >/dev/null 2>&1; then\n    tmux new-session -d -s '${tmuxName}' "bash '$job/runner.sh'"\n    echo tmux > "$job/mode"; echo '${tmuxName}' > "$job/tmux_session"\n  elif [ '${requireTmux}' = '1' ]; then\n    echo 'tmux requested but not installed' >&2; rm -rf "$job"; exit 127\n  else\n    if command -v setsid >/dev/null 2>&1; then nohup setsid bash "$job/runner.sh" >/dev/null 2>&1 </dev/null & else nohup bash "$job/runner.sh" >/dev/null 2>&1 </dev/null & fi\n    echo $! > "$job/launcher_pid"; echo nohup > "$job/mode"\n  fi\n  echo MCODE_JOB_CREATED\nelse\n  echo MCODE_JOB_EXISTING\nfi\nprintf 'JOB_DIR=%s\\n' "$job"`;
}

function buildJobStatusCommand(jobId: string): string {
  return `job="$HOME/.mcode/jobs/${jobId}"\nif [ ! -d "$job" ]; then echo 'STATE=missing'; exit 0; fi\npid="$(cat "$job/pid" 2>/dev/null || true)"\nexit_code="$(cat "$job/exit_code" 2>/dev/null || true)"\nalive=0\nif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then args="$(ps -p "$pid" -o args= 2>/dev/null || true)"; case "$args" in *"$job/runner.sh"*) alive=1;; esac; fi\nif [ -n "$exit_code" ]; then state=completed\nelif [ -f "$job/cancelled" ] && [ "$alive" != 1 ]; then state=cancelled\nelif [ "$alive" = 1 ]; then state=running\nelif [ -f "$job/started_at" ]; then state=lost\nelse state=starting\nfi\nprintf 'STATE=%s\\nPID=%s\\nEXIT=%s\\nMODE=%s\\nTMUX=%s\\nSTARTED=%s\\nFINISHED=%s\\nSTDOUT=%s\\nSTDERR=%s\\n' "$state" "$pid" "$exit_code" "$(cat "$job/mode" 2>/dev/null || true)" "$(cat "$job/tmux_session" 2>/dev/null || true)" "$(cat "$job/started_at" 2>/dev/null || true)" "$(cat "$job/finished_at" 2>/dev/null || true)" "$(wc -c < "$job/stdout.log" 2>/dev/null || echo 0)" "$(wc -c < "$job/stderr.log" 2>/dev/null || echo 0)"`;
}

/**
 * 读一段日志。
 *
 * `waitMs > 0` 时**在远端 shell 里等到有新字节**再返回 —— 一次 SSH 往返就把等待
 * 做完,而不是让模型"读一次空的 → 再读一次"。跑训练时这一点是决定性的:没有它,
 * 几秒一次的空往返会堆成几十次,用户看到的就是"断断续续汇报"。
 *
 * ⚠️ 为什么在**远端**等而不是在客户端 sleep 再读:等待的判据是"文件长大了",而文件
 * 在远端。远端轮询是零额外往返;客户端轮询每次都要一次 SSH 往返。代价是这条 SSH
 * exec 要挂住 `waitMs` —— 所以上限压在 ChatGPT 的 60 秒调用上限之下(见
 * {@link MAX_JOB_LOG_WAIT_MS})。
 */
function buildJobLogCommand(
  jobId: string,
  stream: "stdout" | "stderr",
  cursor: number,
  maxBytes: number,
  waitMs = 0,
): string {
  const parts = [
    `file="$HOME/.mcode/jobs/${jobId}/${stream}.log"`,
    `if [ ! -f "$file" ]; then echo 'SIZE=0'; echo 'DATA='; exit 0; fi`,
    // 等:轮询文件大小,直到超过 cursor(有新字节)或超时。
    // 0.25 秒一格 —— 够细(用户几乎看不出延迟)又不至于把远端 CPU 吃住。
    // `waitMs<=0` 时整段跳过(保持"立刻返回"的老行为,给不做等待的调用方)。
    ...(waitMs > 0
      ? [
          `waited=0`,
          // 用壁钟算而不是累加 sleep 的实际耗时 —— sleep 可能被信号打断/超时偏长。
          `deadline=$(($(date +%s) + ${Math.ceil(waitMs / 1000)}))`,
          `while [ "$(wc -c < "$file" 2>/dev/null || echo 0)" -le ${cursor} ] && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.25; done`,
          `: "$waited"`,
        ]
      : []),
    `size="$(wc -c < "$file" 2>/dev/null || echo 0)"`,
    `echo "SIZE=$size"`,
    `printf 'DATA='`,
    `dd if="$file" bs=1 skip=${cursor} count=${maxBytes} 2>/dev/null | base64 | tr -d '\\n'`,
    `echo`,
  ];
  return parts.join("\n");
}

function buildJobCancelCommand(jobId: string): string {
  return `job="$HOME/.mcode/jobs/${jobId}"\n[ -d "$job" ] || exit 0\ntmux_name="$(cat "$job/tmux_session" 2>/dev/null || true)"\npid="$(cat "$job/pid" 2>/dev/null || true)"\n[ -n "$tmux_name" ] && tmux kill-session -t "$tmux_name" 2>/dev/null || true\nif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then\n  args="$(ps -p "$pid" -o args= 2>/dev/null || true)"\n  case "$args" in *"$job/runner.sh"*) kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; sleep 1; kill -KILL -- "-$pid" 2>/dev/null || true;; esac\nfi\ndate +%s > "$job/cancelled"`;
}

function parseJobStatus(jobId: string, stdout: string): RemoteJobStatus {
  const map = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx > 0) map.set(line.slice(0, idx), line.slice(idx + 1));
  }
  const num = (key: string): number | null => {
    const raw = map.get(key)?.trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const stateRaw = map.get("STATE") ?? "lost";
  const states = new Set(["starting", "running", "completed", "cancelled", "lost", "missing"]);
  const state = (states.has(stateRaw) ? stateRaw : "lost") as RemoteJobStatus["state"];
  return {
    jobId,
    state,
    pid: num("PID"),
    exitCode: num("EXIT"),
    mode: map.get("MODE") || null,
    tmuxSession: map.get("TMUX") || null,
    startedAt: num("STARTED"),
    finishedAt: num("FINISHED"),
    stdoutBytes: num("STDOUT") ?? 0,
    stderrBytes: num("STDERR") ?? 0,
  };
}

function isRetryableSshError(err: Error & { level?: string }): boolean {
  const msg = err.message.toLowerCase();
  if (err.level === "client-authentication") return false;
  if (/authentication|private key|passphrase|host key|no supported authentication/i.test(msg)) return false;
  return true;
}

function friendlySshError(err: Error): string {
  const msg = err.message;
  if (/authentication|all configured authentication/i.test(msg)) return "SSH 认证失败，请检查用户名、密码或密钥";
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return "SSH 地址无法解析";
  if (/ECONNREFUSED|connection refused/i.test(msg)) return "SSH 端口拒绝连接";
  if (/ETIMEDOUT|timeout|timed out/i.test(msg)) return "SSH 连接超时";
  return msg;
}

export const __remoteSshTest = {
  buildJobStartCommand,
  buildJobStatusCommand,
  buildJobLogCommand,
  buildJobCancelCommand,
  parseJobStatus,
};
