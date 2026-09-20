/**
 * Owns all node-pty sessions for the integrated terminal.
 *
 * Renderer never touches PTY handles — it only sees opaque terminalIds and
 * streams I/O over IPC push channels. Paths are validated by the IPC layer
 * before create() is called; this class assumes cwd is already trusted.
 */
import { randomUUID } from "node:crypto";
import { existsSync, statSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import { IPC } from "@contracts/ipc";
import type { TerminalInfo, TerminalOrigin } from "@contracts/ipc";
import { TERMINAL_BUFFER_CHARS, USER_TERMINAL_ORIGIN } from "@contracts/ipc";
import { sendToRenderer } from "@main/window.js";
import { log } from "@main/lib/logger.js";
import { resolveDefaultShell } from "./shellResolve.js";
import { buildTerminalEnv } from "./envRefresh.js";

const require = createRequire(import.meta.url);

export interface CreateTerminalOpts {
  projectPath: string;
  cwd: string;
  cols?: number;
  rows?: number;
  /** Per-create shell override (already preferred over settings by caller). */
  shell?: string;
  /** Settings-level shell override (used when per-create shell is absent). */
  shellSetting?: string | null;
  /** 谁开的。不传 = 用户手点的(见 `USER_TERMINAL_ORIGIN`)。
   *
   *  ⚠️ **这是这条终端唯一的身份来源**,所以只有这一个入口能写它:代理 / 子代理 /
   *  工作流节点要开终端时,把自己那条会话 id 带上(`{ kind: "session", sessionId }`),
   *  而不是新造一个"代理 id"。终端自己仍是 `randomUUID` —— 一个会话能同时开好几条,
   *  拿 sessionId 当终端 id 会让第二条把第一条顶掉。 */
  origin?: TerminalOrigin;
}

export interface CreateTerminalSuccess {
  ok: true;
  terminalId: string;
  pid: number;
  cwd: string;
  shell: string;
}

export interface CreateTerminalFailure {
  ok: false;
  error: string;
}

interface LiveTerminal {
  id: string;
  pty: IPty;
  info: TerminalInfo;
  /** 输出的环(见 `TERMINAL_BUFFER_CHARS`)。**只在这个进程里**,不落盘 ——
   *  它存在的唯一目的是"列表里点开某一条终端时,那个新挂的 xterm 里得有东西",
   *  而不是给终端做归档。所以退出即丢,重启应用也丢。 */
  buffer: string;
}

/** Lazy-load node-pty so a missing native binary doesn't crash app boot —
 *  failure surfaces on first terminal.create instead. Exported for the MCP
 *  OAuth login flow, which needs a real TTY for `claude mcp login` (the CLI
 *  refuses authentication when stdin isn't a terminal). */
export function loadNodePty(): typeof import("node-pty") {
  const mod = require("node-pty") as typeof import("node-pty");
  ensureSpawnHelperExecutable();
  return mod;
}

/** node-pty on POSIX spawns a tiny `spawn-helper` binary via posix_spawnp.
 *  pnpm/tar extraction is known to drop the executable bit on that helper
 *  (the prebuild ships it as `-rw-r--r--`), which makes every `pty.spawn()`
 *  fail with the opaque `posix_spawnp failed.`. Fix it proactively: locate
 *  the helper next to the native addon and `chmod 0o755` it if it lacks +x.
 *  No-op on Windows (ConPTY path doesn't use a helper). */
function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") return;
  try {
    // node-pty's utils.js resolves the native dir as one of
    //   {build/Release, build/Debug, prebuilds/<plat>-<arch>}
    // relative to node-pty's own lib dir. Replicate that lookup so the fix
    // works both in dev (prebuilds/) and after a native rebuild (build/).
    const ptyRoot = require.resolve("node-pty/lib/unixTerminal.js");
    const libDir = dirname(ptyRoot);
    const platArch = `${process.platform}-${process.arch}`;
    const candidates = [
      join(libDir, "..", "build", "Release"),
      join(libDir, "..", "build", "Debug"),
      join(libDir, "..", "prebuilds", platArch),
    ];
    for (const dir of candidates) {
      const helper = join(dir, "spawn-helper");
      if (!existsSync(helper)) continue;
      try {
        if (!(statSync(helper).mode & 0o111)) {
          chmodSync(helper, 0o755);
          log.info(`spawn-helper chmod +x: ${helper}`);
        }
      } catch (e) {
        // chmod failing is non-fatal — the spawn will surface a clearer error.
        log.warn(`spawn-helper chmod failed (${helper}): ${e instanceof Error ? e.message : String(e)}`);
      }
      return; // first existing helper wins
    }
  } catch {
    // resolve failed / unexpected layout — fall through; node-pty will throw
    // its own (typed) error from loadNativeModule instead.
  }
}

/** 往输出尾巴里追加一段,超了就**从头部**丢掉溢出的那部分。
 *
 *  按**字符**截,不是按行 —— 一条刷屏的构建日志里,最后那几行往往是不完整的
 *  (光标控制序列也按字符进来),按行截会把它们切得更碎。20k 字符这个量级下,
 *  一个 String 的切片比自己维护一个数组便宜,而且天然是"最近的在后"。
 *
 *  ⚠️ 别换成"保留前 N 个字符" —— 那留下来的全是开屏那行欢迎语,用户点进去看到的
 *  是一条早就跑远的终端。 */
function appendToBuffer(buffer: string, data: string): string {
  const next = buffer + data;
  return next.length <= TERMINAL_BUFFER_CHARS ? next : next.slice(next.length - TERMINAL_BUFFER_CHARS);
}

class TerminalManagerImpl {
  private readonly terminals = new Map<string, LiveTerminal>();

  /**
   * Async because the env build refreshes the live Windows registry environment
   * (see envRefresh.ts) before spawning — a fresh system-terminal-equivalent
   * env costs one short-lived powershell.exe run (~hundreds of ms cold).
   */
  async create(opts: CreateTerminalOpts): Promise<CreateTerminalSuccess | CreateTerminalFailure> {
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const resolved = resolveDefaultShell(opts.shell ?? opts.shellSetting ?? null);

    let ptyMod: typeof import("node-pty");
    try {
      ptyMod = loadNodePty();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`node-pty failed to load: ${msg}`);
      return {
        ok: false,
        error: `无法加载终端原生模块 (node-pty): ${msg}`,
      };
    }

    const { env, registryVarsApplied } = await buildTerminalEnv();
    if (process.platform === "win32") {
      if (registryVarsApplied === null) {
        log.warn("terminal env: registry refresh failed, using inherited process env");
      } else {
        log.info(`terminal env: refreshed ${registryVarsApplied} vars from live registry`);
      }
    }
    env.TERM = "xterm-256color";
    env.COLORTERM = env.COLORTERM ?? "truecolor";
    // Force UTF-8 where shells honour it.
    env.LANG = env.LANG ?? "en_US.UTF-8";

    const id = randomUUID();
    let pty: IPty;
    try {
      // On Windows, force the conpty.dll path (useConptyDll: true). node-pty's
      // default ConPTY path (useConptyDll: false) forks a helper process
      // (conpty_console_list_agent) on every kill(); that helper calls
      // AttachConsole(shellPid), which races with the shell exiting and throws
      // an uncaught "Error: AttachConsole failed" from the forked child. It's
      // harmless (the child crashes, parent carries on with a 5s fallback) but
      // spams stderr on app shutdown (disposeAll -> kill each terminal) and on
      // every terminal close. The DLL path kills via inSocket.destroy() +
      // ptyNative.kill() and never forks the agent, eliminating the noise.
      // Non-Windows ignores the option.
      pty = ptyMod.spawn(resolved.file, resolved.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: opts.cwd,
        env,
        useConptyDll: process.platform === "win32",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`terminal spawn failed: ${resolved.file} ${msg}`);
      return { ok: false, error: `启动 shell 失败 (${resolved.label}): ${msg}` };
    }

    const info: TerminalInfo = {
      terminalId: id,
      cwd: opts.cwd,
      shell: resolved.label,
      pid: pty.pid,
      projectPath: opts.projectPath,
      // 不传就是"用户手点的" —— 于是 `list()` 交出来的每一条都说得出来历,
      // 终端列表不需要在渲染端猜。
      origin: opts.origin ?? USER_TERMINAL_ORIGIN,
    };

    const live: LiveTerminal = { id, pty, info, buffer: "" };
    this.terminals.set(id, live);

    pty.onData((data) => {
      // Drop if already removed (race with kill/exit).
      if (!this.terminals.has(id)) return;
      // 先记尾巴再推 —— 顺序反过来的话,刚创建就被接入的那一瞬会缺最后几行。
      live.buffer = appendToBuffer(live.buffer, data);
      sendToRenderer(IPC.TERMINAL_DATA, {
        channel: IPC.TERMINAL_DATA,
        terminalId: id,
        data,
      });
    });

    pty.onExit(({ exitCode }) => {
      // onExit may fire after kill() already deleted the entry — still notify
      // renderer so UI can flip to "exited" if it hasn't already.
      this.terminals.delete(id);
      sendToRenderer(IPC.TERMINAL_EXIT, {
        channel: IPC.TERMINAL_EXIT,
        terminalId: id,
        exitCode: typeof exitCode === "number" ? exitCode : null,
      });
      log.info(`terminal exited: ${id} code=${exitCode}`);
    });

    log.info(`terminal created: ${id} shell=${resolved.label} cwd=${opts.cwd}`);
    return {
      ok: true,
      terminalId: id,
      pid: pty.pid,
      cwd: opts.cwd,
      shell: resolved.label,
    };
  }

  write(terminalId: string, data: string): boolean {
    const live = this.terminals.get(terminalId);
    if (!live) return false;
    try {
      live.pty.write(data);
      return true;
    } catch (err) {
      log.warn(`terminal write failed: ${terminalId} ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const live = this.terminals.get(terminalId);
    if (!live) return false;
    try {
      live.pty.resize(cols, rows);
      return true;
    } catch (err) {
      log.warn(`terminal resize failed: ${terminalId} ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  kill(terminalId: string): boolean {
    const live = this.terminals.get(terminalId);
    if (!live) return false;
    this.terminals.delete(terminalId);
    try {
      live.pty.kill();
    } catch (err) {
      log.warn(`terminal kill failed: ${terminalId} ${err instanceof Error ? err.message : String(err)}`);
    }
    // Emit exit so renderer cleans up even if onExit is slow/missing.
    sendToRenderer(IPC.TERMINAL_EXIT, {
      channel: IPC.TERMINAL_EXIT,
      terminalId,
      exitCode: null,
    });
    return true;
  }

  /**
   * 列出活着的终端。
   *
   * @param projectPath 只列这个项目根下的(不传 = 全部)。
   * @param bufferFor 这一条终端**额外带上输出尾巴**(终端列表点开某一条时才用得上;
   *                  平时的轮询不该把每条终端的输出都搬一遍 IPC)。
   */
  list(projectPath?: string, bufferFor?: string): TerminalInfo[] {
    const all = [...this.terminals.values()].map((t) => t.info);
    const scoped = !projectPath ? all : all.filter((t) => t.projectPath === projectPath);
    if (!bufferFor) return scoped;
    return scoped.map((info) =>
      info.terminalId === bufferFor
        ? { ...info, buffer: this.terminals.get(info.terminalId)?.buffer ?? "" }
        : info,
    );
  }

  /** Kill every live PTY — call on app quit. */
  disposeAll(): void {
    const ids = [...this.terminals.keys()];
    for (const id of ids) {
      this.kill(id);
    }
  }
}

/** Process-wide singleton. */
export const TerminalManager = new TerminalManagerImpl();
