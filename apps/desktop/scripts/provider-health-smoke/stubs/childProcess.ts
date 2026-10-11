/**
 * 【MC-076】`node:child_process` 的替身 —— 只换 `execFile`(Codex 的 `--version` 用)。
 *
 * 真那一份会真的 spawn 一个 codex 二进制。这里造一个**永不回调**的假子进程,
 * 让脚本能断言:宿主 abort 时,provider **确实调了** `child.kill()`(终止版本命令
 * 子进程),而不是把挂着的子进程留在后台。`kill()` 会触发 callback(非零退出),
 * 模拟真实 execFile 被 kill 后回调收到 SIGTERM。
 *
 * 其余具名导出(`spawn` 等)从真模块重导出,免得打断别的调用点。
 */
export * from "child_process";

interface CodexKillState {
  children: Array<{ killed: boolean }>;
  killCount: number;
  reset(): void;
}

function state(): CodexKillState {
  const g = globalThis as unknown as { __codexKillFake?: CodexKillState };
  if (!g.__codexKillFake) {
    g.__codexKillFake = {
      children: [],
      killCount: 0,
      reset() {
        this.children = [];
        this.killCount = 0;
      },
    };
  }
  return g.__codexKillFake;
}

/** 假 execFile:把 callback 留住,只有 kill() 时才以"被信号终止"回调。 */
export function execFile(
  _file: string,
  _args: readonly string[],
  _options: unknown,
  callback?: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
): { kill: () => void; pid: number } {
  const s = state();
  const child = {
    killed: false,
    kill() {
      this.killed = true;
      s.killCount += 1;
      if (callback) {
        const err = Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM", code: undefined });
        callback(err as unknown as NodeJS.ErrnoException, "", "");
      }
    },
  };
  s.children.push(child);
  return { kill: child.kill.bind(child), pid: 12345 };
}

/* 模块加载即安装到 globalThis。 */
state();
