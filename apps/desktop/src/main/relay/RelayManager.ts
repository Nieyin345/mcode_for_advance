/**
 * RelayManager — SSH-based remote access relay for the mobile companion.
 *
 * Connects to a user-provided VPS via SSH (`ssh2` package), sets up a reverse
 * port-forwarding tunnel (`forwardIn`), and deploys a tiny TCP forwarder on
 * the VPS (socat or python3 script) so the phone can reach the desktop's
 * MobileHttpServer from anywhere — no third-party tunnel service needed.
 *
 * Data path:
 *   phone → VPS:publicPort → forwarder → VPS:localhost:tunnelPort
 *          → SSH forwardIn → desktop ssh2 'tcp connection' → localhost:7331
 *
 * The forwarder stays running on the VPS across SSH disconnects (nohup + disown),
 * so reconnecting is fast. The SSH connection has keepalive + auto-reconnect.
 *
 * Lifecycle mirrors LspManager / TunnelManager: module-load singleton, lazy
 * connect on demand, `disposeAll()` on app shutdown. State changes are pushed
 * to the renderer via `relay:event`.
 */
import { readFileSync } from "node:fs";
import { verifyRelayHostKey, isWellFormedHostKeyFingerprint } from "./hostKey.js";
import * as nodeNet from "node:net";
import {
  Client,
  type ClientChannel,
  type SFTPWrapper,
} from "ssh2";
import { IPC, type RelayStatus, type RelayVpsConfig } from "@contracts/ipc";
import {
  RELAY_CONFIG_SETTING_KEY,
  RELAY_DEFAULT_PUBLIC_PORT,
} from "@contracts/relay";
import { log } from "@main/lib/logger.js";
import { sendToRenderer } from "@main/window.js";
import { SettingRepo } from "@main/store/repositories.js";
import { awaitDb } from "@main/store/db.js";
import { isMobileServerRunning, getMobileServer } from "@main/mobile/MobileHttpServer.js";
// The forwarder.py script content, inlined at build time via Vite's `?raw`
// suffix so it survives bundling. electron-vite emits a single main chunk and
// does not copy sibling non-JS assets into out/main, so a runtime readFileSync
// of a co-located file fails with ENOENT in dev/prod.
import FORWARDER_PY from "./forwarder.py?raw";

/** 本机手机端 HTTP 服务的端口。用契约里的默认值,别再写死一份 —— 三份 7331(`contracts/mobile.ts`
 *  的 `MOBILE_DEFAULT_PORT`、`contracts/relay.ts` 的 `RELAY_DEFAULT_PUBLIC_PORT`、这里)迟早漂开。
 *  这只是在 `getMobileServer().port` 拿不到时的兜底,契约默认值就是它。 */
const MOBILE_LOCAL_PORT = RELAY_DEFAULT_PUBLIC_PORT;

/** SSH keepalive interval (seconds). */
const KEEPALIVE_INTERVAL = 15;

/** Max reconnect attempts before giving up (user can retry manually). */
const MAX_RECONNECT_ATTEMPTS = 5;

/** Reconnect delay base (exponential backoff). */
const RECONNECT_BASE_DELAY_MS = 2000;

/** Interval between VPS port-state polls during forwarder cleanup/start. */
const PORT_POLL_INTERVAL_MS = 250;

class RelayManagerImpl {
  private conn: Client | null = null;
  private config: RelayVpsConfig | null = null;
  private tunnelPort = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;

  private status: RelayStatus = {
    state: "idle",
    endpoint: null,
    vpsHost: null,
    publicPort: RELAY_DEFAULT_PUBLIC_PORT,
    error: null,
    forwarderType: null,
  };

  /** Current status snapshot. */
  getStatus(): RelayStatus {
    return { ...this.status };
  }

  /** Read the saved VPS config from settings. */
  getConfig(): RelayVpsConfig | null {
    try {
      const raw = SettingRepo.get(RELAY_CONFIG_SETTING_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as RelayVpsConfig;
    } catch {
      return null;
    }
  }

  /** Save VPS config to settings. */
  saveConfig(config: RelayVpsConfig): void {
    SettingRepo.set(RELAY_CONFIG_SETTING_KEY, JSON.stringify(config));
    this.config = config;
    log.info(`relay: config saved for ${config.host}:${config.sshPort}`);
  }

  /** Connect to the VPS: SSH + deploy forwarder + reverse tunnel. */
  async connect(): Promise<{ ok: boolean; error?: string }> {
    await awaitDb();

    if (this.conn && this.status.state === "connected") {
      return { ok: true };
    }

    // ⚠️ **先撤掉还挂着的那只重连定时器。** 上个连接掉线后 `scheduleReconnect` 会留一只
    // （最多 32 秒后才响）。用户此时手动点「连接」（或 agent 经 `relay.connect`、或
    // autoStart）会在这里建起一条**新的好连接**；而那只旧定时器到点后照样 fire、
    // 调 `doConnect()` —— 它把 `this.conn`（刚建好的那条）当成 stale 收掉，于是
    // "刚连上、过一两秒又断一下、再重连"。`disconnect()`/`disposeAll()` 都会撤这只定时器，
    // `connect()` 从前漏了。
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Load config if not already loaded.
    if (!this.config) {
      this.config = this.getConfig();
    }
    if (!this.config) {
      const msg = "未配置 VPS，请先填写服务器信息";
      this.setState({ state: "error", error: msg });
      return { ok: false, error: msg };
    }
    if (!isWellFormedHostKeyFingerprint(this.config.hostKeyFingerprint)) {
      const msg = "缺少可信的 SSH 主机密钥 SHA256 指纹；请独立核对 VPS 指纹并重新保存配置";
      this.setState({ state: "error", error: msg });
      return { ok: false, error: msg };
    }

    // Guard: the relay forwards to the local mobile HTTP server. If it's
    // not running, the phone will see connection errors.
    if (!isMobileServerRunning()) {
      const msg = "移动端服务未运行，请先确保局域网配对功能正常工作";
      this.setState({ state: "error", error: msg });
      return { ok: false, error: msg };
    }

    this.intentionalDisconnect = false;
    this.reconnectAttempts = 0;

    return this.doConnect();
  }

  /** Disconnect from the VPS. The forwarder keeps running on the VPS. */
  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.conn) {
      this.conn.end();
      this.conn = null;
    }
    this.tunnelPort = 0;
    this.setState({
      state: "idle",
      endpoint: null,
      error: null,
      forwarderType: null,
    });
    log.info("relay: disconnected");
  }

  /** Kill the connection on app shutdown. Best-effort, synchronous. */
  disposeAll(): void {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.conn) {
      try {
        this.conn.end();
      } catch {
        // best-effort
      }
      this.conn = null;
    }
  }

  // ─────────────────────────── internal ───────────────────────────

  /** Actual SSH connection + forwarder deployment + forwardIn setup. */
  private async doConnect(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.config!;
    this.setState({
      state: "connecting",
      error: null,
      vpsHost: cfg.host,
      publicPort: cfg.publicPort,
    });

    // 上一条连接(例如握手成功但部署失败、仍然开着的那条)先收掉 —— 否则这里一覆盖
    // `this.conn`,它就再也没人能关:SSH 会话带着 keepalive 一直挂到应用退出,
    // 而它迟到的 `close` 还会把新连接的引用清掉、再触发一轮重连。
    const stale = this.conn;
    if (stale) {
      this.conn = null;
      try {
        stale.end();
      } catch {
        /* best effort */
      }
    }

    return new Promise((resolve) => {
      const conn = new Client();
      this.conn = conn;

      // ⚠️ **`connect()` 的 promise 必须**一定**settle —— 每条出口都走这里。**
      //    少了它有一个会让界面**永久卡住**的缺口:用户在握手还没完时点了"断开",
      //    `disconnect()` 走的是 `conn.end()`(干净收尾,**不触发 `error`**),于是
      //    只有 `ready` 与 `error` 两条出口的写法会让这个 promise 永远悬着。
      //    调用方是渲染端的 `handleConnect()`,它 `await api.relay.connect()` 之后
      //    才在 `finally` 里清 `busy` —— 悬着 = 那颗按钮永远转着圈点不动,直到重启应用。
      let settled = false;
      const settle = (r: { ok: boolean; error?: string }): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      let hostKeyRejected = false;
      const connectOpts: Record<string, unknown> = {
        host: cfg.host,
        port: cfg.sshPort,
        username: cfg.username,
        // ssh2 passes the raw public host key Buffer unless hostHash is set.
        // Refuse an unknown/replaced key before authentication or forwarding.
        hostVerifier: (key: Buffer) => {
          const trusted = verifyRelayHostKey(key, cfg.hostKeyFingerprint);
          if (!trusted) hostKeyRejected = true;
          return trusted;
        },
        keepaliveInterval: KEEPALIVE_INTERVAL * 1000,
        readyTimeout: 20_000,
        algorithms: {
          // Allow a broad set of algorithms for compatibility with older
          // SSH servers common on VPS images.
          serverHostKey: [
            "ssh-ed25519",
            "ecdsa-sha2-nistp256",
            "ecdsa-sha2-nistp384",
            "rsa-sha2-512",
            "rsa-sha2-256",
            "ssh-rsa",
            "ssh-dss",
          ],
        },
      };

      if (cfg.privateKeyPath) {
        try {
          connectOpts.privateKey = readFileSync(cfg.privateKeyPath, "utf8");
          if (cfg.password) connectOpts.passphrase = cfg.password;
        } catch {
          // Fall back to password auth
          connectOpts.password = cfg.password;
        }
      } else {
        connectOpts.password = cfg.password;
      }

      conn.on("ready", async () => {
        log.info("relay: SSH connected");
        try {
          await this.deployForwarder(conn, cfg);
          await this.setupForwardIn(conn, cfg);
          this.reconnectAttempts = 0;
          settle({ ok: true });
        } catch (err) {
          const msg = (err as Error).message;
          log.error(`relay: setup failed: ${msg}`);
          // Don't repaint the panel after the user asked to disconnect (or the
          // app is shutting down) — this attempt is already abandoned, and
          // flipping the panel back to "错误" would contradict the "未连接"
          // they just got.
          if (!this.intentionalDisconnect) {
            this.setState({ state: "error", error: msg });
          }
          settle({ ok: false, error: msg });
          // 部署失败就把这条 SSH 关掉(先摘下引用,`close` 便按「已作废」处理,不会
          // 把面板上的错误原因盖成「正在重连」)。原先它会一直开着,没人再关。
          if (this.conn === conn) {
            this.conn = null;
            this.tunnelPort = 0;
          }
          try {
            conn.end();
          } catch {
            /* best effort */
          }
        }
      });

      conn.on("error", (err: Error) => {
        log.error(`relay: SSH error: ${err.message}`);
        // 已作废的连接(被断开 / 被新连接替换 / 部署失败后关掉)不再影响状态与重连。
        if (this.conn !== conn) {
          settle({ ok: false, error: friendlySshError(err) });
          return;
        }
        const reason = hostKeyRejected
          ? "SSH 主机密钥指纹不匹配，已拒绝连接；请通过可信渠道核对 VPS 主机密钥（勿直接接受网络返回的密钥）"
          : friendlySshError(err);
        if (this.status.state === "connecting") {
          // Connection phase failure → resolve with error, and **say why**.
          //
          // ⚠️ 这句 `setState` 是用户能不能看到失败原因的唯一途径。渲染端的
          //    `RemoteConnectPanel.handleConnect()` 只把 `result.error` 打到 console,
          //    面板显示的**只有** `status.error`。少了这一推,用户在连接阶段看到的
          //    先是"正在重连(1/5)…"(下面那行 scheduleReconnect 立刻盖掉),几十秒后
          //    是一条泛泛的"重试 5 次后放弃" —— 于是他永远不知道到底是密码错了,
          //    还是地址错了。
          if (!this.intentionalDisconnect) {
            this.setState({ state: "error", error: reason });
          }
        }
        settle({ ok: false, error: reason });
        if (!this.intentionalDisconnect && !hostKeyRejected) {
          this.scheduleReconnect();
        }
      });

      conn.on("close", () => {
        log.info("relay: SSH closed");
        if (this.conn !== conn) {
          // 已作废的连接:只给还在等的调用方一个答复,不清新连接的引用、不重连。
          if (!settled) settle({ ok: false, error: hostKeyRejected ? "SSH 主机密钥指纹不匹配，已拒绝连接" : "SSH 连接已断开" });
          return;
        }
        this.conn = null;
        this.tunnelPort = 0;
        // 握手还没完就断了(用户按了断开、或者对端直接挂断且没给 `error`)——
        // 调用方还等着一个答复,给不出"连上了"就只能说没连上。
        if (!settled) settle({ ok: false, error: hostKeyRejected ? "SSH 主机密钥指纹不匹配，已拒绝连接" : "SSH 连接已断开" });
        if (!this.intentionalDisconnect && !hostKeyRejected) {
          this.scheduleReconnect();
        }
      });

      conn.on("tcp connection", (info: { destIP: string; destPort: number }, accept: () => ClientChannel) => {
        // A phone connection arrived through the reverse tunnel. Forward
        // it to the local mobile HTTP server.
        const stream = accept();
        this.pipeToLocal(stream);
      });

      conn.connect(connectOpts);
    });
  }

  /** Deploy the forwarder on the VPS, honoring the user's forwarder choice:
   *  "auto" tries socat first and falls back to python3; "socat"/"python3"
   *  force the choice and fail with an explicit error (no silent fallback,
   *  so the user always knows which program is actually running). */
  private async deployForwarder(conn: Client, cfg: RelayVpsConfig): Promise<void> {
    this.setState({ state: "deploying" });
    this.tunnelPort = await pickRandomPort();

    // Kill any forwarder left over from a previous session (disconnect leaves
    // it running on purpose) and wait until the port is genuinely free —
    // binding over a half-dead listener kills the new forwarder with
    // EADDRINUSE (the 2026-08-28 "socat start failed" WARN).
    await this.cleanupForwarder(conn, cfg.publicPort);

    const choice = cfg.forwarder ?? "auto";

    // socat one-liner (simplest — no file upload). Skipped entirely when the
    // user explicitly forced python3.
    if (choice !== "python3") {
      const socatPath = await execAsync(conn, "which socat 2>/dev/null");
      if (socatPath.trim()) {
        log.info("relay: using socat forwarder");
        await execAsync(conn, "mkdir -p ~/.mcode");
        const cmd =
          `nohup socat TCP-LISTEN:${cfg.publicPort},fork,reuseaddr ` +
          `TCP:127.0.0.1:${this.tunnelPort} >~/.mcode/forwarder.log 2>&1 &`;
        await execAsync(conn, cmd);
        // Verify it is actually LISTENING. A pgrep name match can hit a
        // stale forwarder, but a listener on a confirmed-free port can only
        // be the process we just started.
        if (await this.waitForPortState(conn, cfg.publicPort, 2000, true)) {
          this.setState({ forwarderType: "socat" });
          log.info(`relay: socat forwarder started on port ${cfg.publicPort}`);
          return;
        }
        const detail = await this.forwarderErrorDetail(conn);
        if (choice === "socat") {
          throw new Error(
            `socat 转发器启动失败${detail ?? "，请登录 VPS 查看 ~/.mcode/forwarder.log"}`,
          );
        }
        log.warn(`relay: socat start failed (${detail ?? "no stderr"}), falling back to python3`);
      } else if (choice === "socat") {
        throw new Error("VPS 上未安装 socat（转发服务已指定为 socat），请先安装：apt install socat");
      }
    }

    // python3 forwarder script — user-forced, or auto fallback when socat is
    // unavailable / failed to start.
    const pythonPath = await execAsync(conn, "which python3 2>/dev/null");
    if (!pythonPath.trim()) {
      throw new Error(
        choice === "python3"
          ? "VPS 上未安装 python3（转发服务已指定为 python3），请先安装：apt install python3"
          : "VPS 上没有 socat 或 python3，请安装其一：apt install socat 或 apt install python3",
      );
    }

    log.info("relay: using python3 forwarder");
    await this.uploadForwarderScript(conn);
    const cmd = `nohup python3 ~/.mcode/forwarder.py ${cfg.publicPort} ${this.tunnelPort} >~/.mcode/forwarder.log 2>&1 &`;
    await execAsync(conn, cmd);
    if (!(await this.waitForPortState(conn, cfg.publicPort, 2500, true))) {
      const detail = await this.forwarderErrorDetail(conn);
      throw new Error(
        `python3 转发器启动失败${detail ?? "，请登录 VPS 查看 ~/.mcode/forwarder.log"}`,
      );
    }
    this.setState({ forwarderType: "python3" });
    log.info(`relay: python3 forwarder started on port ${cfg.publicPort}`);
  }

  /** Kill forwarders from previous sessions and wait until the public port
   *  is really released (SIGTERM, then SIGKILL, then a loud error).
   *
   *  The pgrep/pkill patterns deliberately use the "[T]CP-LISTEN" bracket
   *  trick: the remote command runs as `bash -c '<cmd>'`, and a plain
   *  pattern matches that wrapper's own command line. That made pgrep report
   *  a phantom forwarder on every connect, and pkill SIGTERM the wrapper
   *  mid-compound so the second pkill never ran — a stale python3 forwarder
   *  survived every reconnect, held the port forever, and the relay silently
   *  pointed the phone at a dead tunnel port while status showed
   *  "connected" (2026-08-28 incident). */
  private async cleanupForwarder(conn: Client, publicPort: number): Promise<void> {
    const socatPat = `[T]CP-LISTEN:${publicPort}`;
    const pyPat = `[f]orwarder\\.py.*${publicPort}`;

    const found = await execAsync(conn, `pgrep -f "${socatPat}"; pgrep -f "${pyPat}"`);
    if (found.trim()) {
      log.info("relay: killing stale forwarder");
      await execAsync(conn, `pkill -f "${socatPat}"; pkill -f "${pyPat}"`);
    }

    if (await this.waitForPortState(conn, publicPort, 3000, false)) return;

    // Still held after SIGTERM — escalate to SIGKILL.
    log.warn("relay: forwarder did not exit after SIGTERM, sending SIGKILL");
    await execAsync(conn, `pkill -9 -f "${socatPat}"; pkill -9 -f "${pyPat}"`);
    if (await this.waitForPortState(conn, publicPort, 2500, false)) return;

    const holder = (
      await execAsync(conn, `ss -ltnp 2>/dev/null | grep ":${publicPort}"`)
    ).trim();
    throw new Error(
      `VPS 端口 ${publicPort} 释放失败${holder ? `（当前占用：${holder}）` : ""}，请登录 VPS 手动排查：ss -ltnp | grep ${publicPort}`,
    );
  }

  /** Poll the VPS until `publicPort` reaches the wanted state (listening /
   *  free) or the timeout elapses. */
  private async waitForPortState(
    conn: Client,
    publicPort: number,
    timeoutMs: number,
    wantListening: boolean,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const count = await countPortListeners(conn, publicPort);
      if (wantListening ? count > 0 : count === 0) return true;
      if (Date.now() >= deadline) return false;
      await sleep(PORT_POLL_INTERVAL_MS);
    }
  }

  /** Best-effort tail of the forwarder's stderr log (null when nothing
   *  useful) — surfaced in start-failure errors so bind failures become
   *  diagnosable instead of vanishing into /dev/null. */
  private async forwarderErrorDetail(conn: Client): Promise<string | null> {
    const tail = await execAsync(conn, `tail -c 300 ~/.mcode/forwarder.log 2>/dev/null`);
    const text = tail.trim().replace(/\s+/g, " ").slice(0, 160);
    return text || null;
  }

  /** Upload forwarder.py to the VPS via SFTP. */
  private async uploadForwarderScript(conn: Client): Promise<void> {
    await new Promise<void>((resolveP, rejectP) => {
      const fail = (err: unknown): void => {
        // ⚠️ **不能让 ssh2 的英文原文直接上中文面板。** `conn.sftp()` 在服务端拒了
        // SFTP 子系统时抛的是 `Unable to start subsystem: sftp`(纯英文),它经
        // `ready` 处理器的 catch 原样进 `status.error` → `RemoteConnectPanel` 面板。
        // 用户对着一句英文,既不知道是哪一步失败、也不知道该做什么。这一步的失败
        // **有明确的下一步**(开 SFTP 或改用 socat),所以给一句带原因与出路的实话,
        // 把英文细节留在冒号之后(同 `setupForwardIn` 的形状)。
        const detail = err instanceof Error ? err.message : String(err);
        rejectP(new Error(`无法通过 SFTP 上传转发脚本: ${detail}；请确认 VPS 的 sshd 开启了 SFTP 子系统(Subsystem sftp),或改用 socat 转发器`));
      };
      conn.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) return fail(err);
        // Ensure ~/.mcode/ exists.
        // mkdir 的错误**有意忽略**:目录通常已存在(EEXIST),真正的失败(权限不足等)会在
        // 下一条 `createWriteStream` 上以 `stream.on("error")` 冒出来 —— 那里才是判据。
        // 早先这里挂了个 `if (mkdirErr && …) { /* 空体 */ }`,两头都不做事,是死守卫。
        sftp.mkdir(".mcode", () => {
          const remotePath = ".mcode/forwarder.py";
          const stream = sftp.createWriteStream(remotePath, { mode: 0o755 });
          stream.on("error", fail);
          stream.on("close", () => resolveP());
          stream.end(FORWARDER_PY);
        });
      });
    });
  }

  /** Set up the SSH reverse tunnel via forwardIn. */
  private async setupForwardIn(conn: Client, cfg: RelayVpsConfig): Promise<void> {
    await new Promise<void>((resolveP, rejectP) => {
      // forwardIn tells the SSH server to listen on 127.0.0.1:tunnelPort
      // and forward connections back to us via 'tcp connection'.
      conn.forwardIn("127.0.0.1", this.tunnelPort, (err: Error | undefined) => {
        if (err) {
          return rejectP(new Error(`SSH 反向隧道建立失败: ${err.message}`));
        }
        log.info(`relay: forwardIn established on 127.0.0.1:${this.tunnelPort}`);
        const endpoint = `http://${cfg.host}:${cfg.publicPort}`;
        this.setState({ state: "connected", endpoint, error: null });
        resolveP();
      });
    });
  }

  /** Pipe an SSH-forwarded stream to the local mobile HTTP server. */
  private pipeToLocal(stream: ClientChannel): void {
    const server = getMobileServer();
    const localPort = server.port || MOBILE_LOCAL_PORT;
    const socket = nodeNet.connect({ host: "127.0.0.1", port: localPort }, () => {
      stream.pipe(socket);
      socket.pipe(stream);
    });
    const cleanup = () => {
      try { stream.destroy(); } catch { /* */ }
      try { socket.destroy(); } catch { /* */ }
    };
    stream.on("error", cleanup);
    stream.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("close", cleanup);
  }

  /** Schedule a reconnection with exponential backoff. */
  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    // A dropped connection fires BOTH "error" and "close"; without this
    // guard two timers race and run doConnect concurrently, deploying two
    // forwarders that fight over the public port (seen in the 2026-08-16
    // logs: duplicate "SSH connected" + "Unable to bind" tunnel errors).
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setState({
        state: "error",
        error: `连接断开，重试 ${MAX_RECONNECT_ATTEMPTS} 次后放弃。请检查网络后重试。`,
        endpoint: null,
      });
      return;
    }
    this.reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);
    log.info(`relay: reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    this.setState({ state: "connecting", error: `正在重连(${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…` });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalDisconnect) return;
      void this.doConnect().then((result) => {
        if (!result.ok && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }

  /** Update internal status + push a relay:event to the renderer. */
  private setState(patch: Partial<RelayStatus>): void {
    this.status = { ...this.status, ...patch };
    sendToRenderer(IPC.RELAY_EVENT, {
      channel: IPC.RELAY_EVENT,
      status: this.getStatus(),
    } as const);
  }
}

/** Process-wide singleton. */
export const relayManager = new RelayManagerImpl();

// ─────────────────────────── helpers ───────────────────────────

/** Execute a command via SSH and return stdout. */
function execAsync(conn: Client, cmd: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    conn.exec(cmd, (err: Error | undefined, stream: ClientChannel) => {
      if (err) return rejectP(err);
      let stdout = "";
      stream.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      stream.on("close", () => resolveP(stdout));
      stream.stderr.on("data", () => {
        // ignore stderr — some commands write to it (which, pgrep)
      });
    });
  });
}

/** Count sockets listening on `port` on the VPS. ss and netstat both put the
 *  local address in column 4, so one awk works for both; when neither tool
 *  exists the pipeline yields 0 ("free"), degrading to the old blind
 *  behavior rather than blocking deployment. */
function countPortListeners(conn: Client, port: number): Promise<number> {
  return execAsync(
    conn,
    `(ss -ltn 2>/dev/null || netstat -tln 2>/dev/null) | awk '{print $4}' | grep -c ":${port}$"`,
  ).then((out) => parseInt(out.trim(), 10) || 0);
}

/** Translate raw SSH errors into user-friendly Chinese messages. */
function friendlySshError(err: Error): string {
  const msg = err.message;
  if (/authentication failed|All configured authentication methods failed/i.test(msg)) {
    return "SSH 认证失败：请检查用户名和密码/密钥是否正确";
  }
  if (/connect ECONNREFUSED|Connection refused/i.test(msg)) {
    // ⚠️ 不要去判 `msg.includes("port")` —— 走到这里的是 `connect ECONNREFUSED 1.2.3.4:22`
    // 这种串,永远不含小写的 "port",那个三元恒取「地址」一支,是个假判断(从前正是这么写的)。
    // 端口与地址两种可能一起说,反正用户的下一步动作一样:核对着两样 + 确认 SSH 在跑。
    return "无法连接到 SSH 服务:请确认地址与端口都正确,且 SSH 服务正在运行";
  }
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
    return "无法解析服务器地址：请检查 IP/域名是否正确";
  }
  if (/ETIMEDOUT|Timed out|timeout/i.test(msg)) {
    return "SSH 连接超时：请检查服务器地址/端口和网络";
  }
  return `SSH 连接失败: ${msg}`;
}

/** Pick a random available port for the SSH reverse tunnel (internal use). */
async function pickRandomPort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = nodeNet.createServer();
    srv.unref();
    srv.on("error", rejectP);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolveP(port));
      } else {
        srv.close();
        rejectP(new Error("无法分配隧道端口"));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
