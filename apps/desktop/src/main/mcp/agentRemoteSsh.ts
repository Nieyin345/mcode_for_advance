/**
 * Reliable SSH + remote training jobs for mcode-agent.
 *
 * The SSH socket is disposable; job truth lives on the remote host under
 * ~/.mcode/jobs/<jobId>. A dropped MCP/chat/SSH connection therefore cannot
 * kill a training run, and reconnecting can re-attach to status/log files.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
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
/** 包在每条 exec 前面、写到 stderr 的进程号标记 —— 超时后靠它去远端杀掉整个进程组。 */
const EXEC_PID_MARK = "__MCODE_EXEC_PID=";
export type RemoteConnectionState = "connecting" | "ready" | "reconnecting" | "error" | "closed";

export interface RemoteConnectInput {
  ownerSessionId: string;
  host: string;
  port?: number;
  /** AI/user resolves SSH configuration before calling this transport. */
  username: string;
  agentPath?: string;
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
  /** 任务已结束(有退出码 / 已取消 / runner 不在了)—— 读到末尾后就不用再等了。 */
  jobFinished: boolean;
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
    // 认证失败这类不可重试的错误(state=error)绝不自动重连:重连只会一遍遍撞同一堵墙,
    // 还把状态改回 reconnecting,模型看到的就是"一直在重连"而不是真正的原因。
    if (entry.intentionalClose || entry.reconnectTimer || entry.state === "ready" || entry.state === "error") return;
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
      cfg.privateKey = readFileSync(expandHome(entry.cfg.privateKeyPath), "utf8");
      if (entry.cfg.passphrase) cfg.passphrase = entry.cfg.passphrase;
    } else if (entry.cfg.password) {
      cfg.password = entry.cfg.password;
    } else if (entry.cfg.agentPath) {
      // An explicitly selected, already configured agent. Never stat a named pipe.
      cfg.agent = entry.cfg.agentPath;
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
      if (entry.client !== client) return;
      // Explicit agent failure has no implicit fallback; report it instead of silently waiting.
      entry.lastError = friendlySshError(err);
      if (!ready) settleErr(err);
      if (!entry.intentionalClose && isRetryableSshError(err)) {
        entry.state = "reconnecting";
        scheduleReconnect(entry);
      } else if (!entry.intentionalClose) {
        entry.state = "error";
        if (!ready) { try { client.end(); } catch { /* best effort */ } }
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
        // 已判定为不可重试(认证失败等)就停在 error,不再排重连。
        if (entry.state !== "error") {
          entry.state = "reconnecting";
          scheduleReconnect(entry);
        }
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
      client.exec(wrapExecCommand(command), (err: Error | undefined, stream: ClientChannel) => {
        if (err) return reject(err);
        // 不给 stdin:立刻发 EOF。否则 `read`、`cat`、要确认的安装命令会一直等输入,
        // 直到超时。
        try { stream.end(); } catch { /* best effort */ }
        let stdout = "";
        let stderr = "";
        let remotePid: number | null = null;
        let pidParsed = false;
        /** 剥掉 stderr 开头的进程号标记(只出现一次,在最前面)。 */
        const takePid = (): void => {
          if (pidParsed) return;
          const parsed = splitExecPid(stderr);
          if (!parsed) return;
          pidParsed = true;
          remotePid = parsed.pid;
          stderr = parsed.rest;
        };
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
          takePid();
          // 只关通道,远端进程**不会**死(sshd 不给非 pty 会话发信号)—— 超时的
          // `sleep 1000`、卡住的训练脚本会一直留在服务器上。按进程号把整个进程组杀掉。
          if (remotePid !== null) killRemoteProcessGroup(client, remotePid);
          try { stream.close(); } catch { /* best effort */ }
          const partial = tailText(stdout.trim() || stderr.trim(), 2_000);
          finish(() => reject(new Error(
            `远程命令超过 ${timeout}ms，已终止${remotePid !== null ? "远端进程" : ""}；长任务请用 agent_remote_job_start` +
            (partial ? `\n--- 超时前的输出(末尾) ---\n${partial}` : ""),
          )));
        }, timeout);
        stream.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
        stream.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); takePid(); });
        stream.on("exit", (c: number | null, s: string | null) => { code = c; signal = s; });
        stream.on("error", (e: Error) => finish(() => reject(e)));
        stream.on("close", () => finish(() => { takePid(); resolve({ stdout, stderr, code, signal }); }));
      });
    });
  };

  const connect = async (input: RemoteConnectInput): Promise<RemoteConnectionInfo> => {
    const host = input.host.trim();
    const port = input.port ?? 22;
    const username = input.username?.trim();
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH port 必须为 1..65535 的整数，请先确认连接配置");
    if (!host || !username) throw new Error("SSH 配置不完整：请先由 AI 与用户确认实际 host、port、username；工具不会解析 SSH 配置或选择账号");
    const credentials = [input.privateKeyPath, input.password, input.agentPath].filter(v => typeof v === "string" && v.length > 0);
    if (credentials.length !== 1) throw new Error("SSH 认证未明确配置：请先与用户确认，并且只提供 private_key_path、agent_path 或 password 中的一种；工具不会扫描密钥、修改配置或替用户处理交互认证");
    if (input.passphrase && !input.privateKeyPath) throw new Error("passphrase 只能与 private_key_path 一起使用");
    for (const existing of entries.values()) {
      if (
        existing.ownerSessionId === input.ownerSessionId && !existing.intentionalClose &&
        existing.state !== "error" && existing.state !== "closed" &&
        existing.cfg.host === host && existing.cfg.port === port && existing.cfg.username === username &&
        existing.cfg.privateKeyPath === input.privateKeyPath && existing.cfg.password === input.password &&
        existing.cfg.agentPath === input.agentPath && existing.cfg.passphrase === input.passphrase
      ) {
        try { await ensureConnected(existing); } catch { /* background reconnect owns recovery */ }
        return infoOf(existing);
      }
    }
    const entry: RemoteEntry = {
      id: `ssh_${randomBytes(8).toString("hex")}`,
      ownerSessionId: input.ownerSessionId,
      cfg: { ...input, host, port, username },
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

  const closeEntry = (entry: RemoteEntry): void => {
    entry.intentionalClose = true;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
    const client = entry.client;
    entry.client = null;
    entry.state = "closed";
    try { client?.end(); } catch { /* best effort */ }
  };

  const disconnect = async (ownerSessionId: string, connectionId: string): Promise<void> => {
    closeEntry(owned(ownerSessionId, connectionId));
  };

  /** The owning conversation is gone: close (no auto-reconnect) and forget all
   *  of its connections. Remote tmux/nohup jobs keep running on the host by
   *  design; only the local connection state goes away. */
  const disposeOwner = (ownerSessionId: string): void => {
    for (const [id, entry] of [...entries]) {
      if (entry.ownerSessionId !== ownerSessionId) continue;
      closeEntry(entry);
      entries.delete(id);
    }
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
    const maxBytes = args.maxBytes ?? 20_000;
    if (!Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > 60_000) throw new Error("max_bytes 必须为 4..60000，至少容纳一个完整 UTF-8 字符");
    const waitMs = Math.max(0, Math.min(args.waitMs ?? 0, MAX_JOB_LOG_WAIT_MS));
    const entry = owned(args.ownerSessionId, args.connectionId);
    // exec 超时要**比等待时长更宽**:等待本身会挂满 waitMs,若 exec 超时与之相等,
    // 等待刚结束就可能被判定超时。留 5 秒余量(还要算 base64 编码 + 网络往返)。
    const execTimeoutMs = Math.max(20_000, waitMs + 5_000);
    const r = await execEntry(entry, buildJobLogCommand(args.jobId, args.stream, cursor, maxBytes, waitMs), execTimeoutMs);
    const parsed = parseJobLogOutput(r.stdout, cursor, maxBytes);
    return { jobId: args.jobId, stream: args.stream, cursor, ...parsed };
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
    disposeOwner,
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
    `job="$HOME/.mcode/jobs/${jobId}"`,
    `file="$job/${stream}.log"`,
    `if [ ! -f "$file" ]; then echo 'SIZE=0'; echo 'DONE=1'; echo 'DATA='; exit 0; fi`,
    // 任务是否已结束:有退出码 / 被取消 / runner 进程已不在(lost)。结束了就不会再有新
    // 日志,等待必须立刻停 —— 否则读到末尾的每一次调用都要白白挂满 55 秒。
    `job_done() { [ -f "$job/exit_code" ] || [ -f "$job/cancelled" ] && return 0; p="$(cat "$job/pid" 2>/dev/null || true)"; [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null; }`,
    // 等:轮询文件大小,直到超过 cursor(有新字节)或超时。
    // 0.25 秒一格 —— 够细(用户几乎看不出延迟)又不至于把远端 CPU 吃住。
    // `waitMs<=0` 时整段跳过(保持"立刻返回"的老行为,给不做等待的调用方)。
    ...(waitMs > 0
      ? [
          `waited=0`,
          // 用壁钟算而不是累加 sleep 的实际耗时 —— sleep 可能被信号打断/超时偏长。
          `deadline=$(($(date +%s) + ${Math.ceil(waitMs / 1000)}))`,
          // 只在"恰好读到末尾"(size == cursor)时等:cursor 超过文件大小(传错/文件被截断)
          // 不等,立刻把真实大小报回去。
          `while [ "$(wc -c < "$file" 2>/dev/null || echo 0)" -eq ${cursor} ] && ! job_done && [ "$(date +%s)" -lt "$deadline" ]; do sleep 0.25; done`,
          `: "$waited"`,
        ]
      : []),
    `if job_done; then done_flag=1; else done_flag=0; fi`,
    `size="$(wc -c < "$file" 2>/dev/null || echo 0)"`,
    `echo "SIZE=$size"`,
    `echo "DONE=$done_flag"`,
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

/** 解析 {@link buildJobLogCommand} 的输出。cursor 超过文件大小时把 nextCursor 拉回
 *  文件大小;读满 maxBytes 时不把被截断的半个 UTF-8 字符算进来(下次从它开头读)。 */
function parseJobLogOutput(stdout: string, cursor: number, maxBytes: number): Omit<RemoteJobLogResult, "jobId" | "stream" | "cursor"> {
  const size = Number(stdout.match(/^SIZE=(\d+)/m)?.[1] ?? 0) || 0;
  const jobFinished = /^DONE=1/m.test(stdout);
  const encoded = stdout.match(/^DATA=([A-Za-z0-9+/=]*)/m)?.[1] ?? "";
  let buf = encoded ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
  if (buf.length >= maxBytes) buf = buf.subarray(0, utf8SafeLength(buf));
  const nextCursor = cursor > size ? size : cursor + buf.length;
  return {
    text: buf.toString("utf8"),
    nextCursor,
    totalBytes: size,
    truncated: nextCursor < size,
    jobFinished,
  };
}

/** buf 末尾若是不完整的 UTF-8 多字节序列,返回去掉它之后的长度。 */
function utf8SafeLength(buf: Buffer): number {
  const len = buf.length;
  for (let back = 1; back <= Math.min(4, len); back++) {
    const b = buf[len - back];
    if ((b & 0xc0) === 0x80) continue; // 续字节,继续往前找首字节
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? len - back : len;
  }
  return len;
}

function wrapExecCommand(command: string): string {
  // 非 pty 的 sshd 会话里,登录 shell 是会话首进程,它的 pid 就是进程组号。用子 sh 的
  // $PPID 取它,而不是 $$ —— 这样登录 shell 是 fish 之类不认 $$ 的也不会语法错误。
  return `sh -c 'printf "${EXEC_PID_MARK}%s\\n" "$PPID" >&2'\n${command}`;
}

function splitExecPid(stderr: string): { pid: number | null; rest: string } | null {
  if (!stderr.startsWith(EXEC_PID_MARK)) {
    // 还没收全标记(分包)就先等;确定不是标记开头就放弃解析。
    return EXEC_PID_MARK.startsWith(stderr) ? null : { pid: null, rest: stderr };
  }
  const nl = stderr.indexOf("\n");
  if (nl < 0) return null;
  const raw = stderr.slice(EXEC_PID_MARK.length, nl).trim();
  return { pid: /^\d+$/.test(raw) && Number(raw) > 1 ? Number(raw) : null, rest: stderr.slice(nl + 1) };
}

function killRemoteProcessGroup(client: Client, pid: number): void {
  const cmd = `kill -TERM -- -${pid} 2>/dev/null; pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null; sleep 2; kill -KILL -- -${pid} 2>/dev/null; true`;
  try {
    client.exec(cmd, (err: Error | undefined, stream: ClientChannel) => {
      if (err) return;
      stream.on("data", () => undefined);
      stream.stderr.on("data", () => undefined);
      try { stream.end(); } catch { /* best effort */ }
    });
  } catch { /* 连接已断:远端进程无从清理,best effort */ }
}

function tailText(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

function isRetryableSshError(err: Error & { level?: string }): boolean {
  const msg = err.message.toLowerCase();
  if (err.level === "client-authentication") return false;
  if (err.level === "agent") return false;
  if (/authentication|private key|passphrase|host key|no supported authentication|认证未明确配置|配置不完整|enoent|eacces|eperm/i.test(msg)) return false;
  return true;
}

function friendlySshError(err: Error): string {
  const msg = err.message;
  if (/authentication|all configured authentication/i.test(msg)) {
    return "SSH 认证失败：服务器未接受指定凭据。请让 AI 与用户确认账号及 private_key_path / agent_path / password；若需加载密钥、解锁或 MFA，请先完成交互配置再连接";
  }
  if (/ENOENT/i.test(msg)) return `找不到文件：${msg.replace(/^.*ENOENT[^']*'?/, "").replace(/'$/, "") || msg}`;
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return "SSH 地址无法解析";
  if (/ECONNREFUSED|connection refused/i.test(msg)) return "SSH 端口拒绝连接";
  if (/ETIMEDOUT|timeout|timed out/i.test(msg)) return "SSH 连接超时";
  return msg;
}

export const __remoteSshTest = {
  parseJobLogOutput,
  splitExecPid,
  wrapExecCommand,
  buildJobStartCommand,
  buildJobStatusCommand,
  buildJobLogCommand,
  buildJobCancelCommand,
  parseJobStatus,
};
