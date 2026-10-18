/**
 * 【ARC-006 WF-INT】**第三方工作流引擎运行时监管**的无头回归网。
 *
 * ## 它验什么
 *
 * `EngineRuntime` 的四个承诺，每一个都有**可控的失败输入**：
 *  1. 端口只绑回环、由宿主分配（不接受调用方指定 host）；
 *  2. 就绪探测通过才进 running；探测一直失败 → 超时 → failed **且进程被收掉**
 *     （不能留下一个没人管的监听端口）；
 *  3. 进程意外退出 → failed，原因带退出码（用户能看到为什么）；
 *  4. stop 先 SIGTERM，宽限期后强杀；重复 stop 幂等。
 *
 * ## 为什么不用真 Node-RED
 *
 * 真引擎已在 NR0 验过（`docs/planning/arc-006-wf-integration.md`）。本套钉的是
 * **状态机**，用假进程能精确制造"就绪超时""启动即崩""忽略 SIGTERM"这些真引擎
 * 难以稳定复现的形态。真进程的端到端由后续 NR2/NR3 的真 Electron 套件覆盖。
 *
 * Run: bash scripts/workflow-engine-runtime-smoke/run.sh
 */
import { EngineRuntime, type EngineChildProcess, type EngineRuntimePorts, type EngineSpawnSpec } from "@main/workflowEngines/runtimeSupervisor.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** 可编程假进程：能按需"正常退出""报错""忽略 SIGTERM"。 */
function makeFakeChild(opts: {
  ignoreSigterm?: boolean;
} = {}): EngineChildProcess & { exited: boolean; signalReceived: string[]; exitNow(): void } {
  let exitListener: ((code: number | null, sig: NodeJS.Signals | null) => void) | null = null;
  let errorListener: ((err: Error) => void) | null = null;
  const state = {
    exited: false,
    signalReceived: [] as string[],
    exitNow() {
      if (state.exited) return;
      state.exited = true;
      exitListener?.(0, null);
    },
  };
  const child: EngineChildProcess & typeof state = {
    ...state,
    pid: 4242,
    kill(signal?: NodeJS.Signals) {
      state.signalReceived.push(signal ?? "SIGTERM");
      if (!opts.ignoreSigterm || signal === "SIGKILL") state.exitNow();
      return true;
    },
    onExit(listener) {
      exitListener = listener;
    },
    onError(listener) {
      errorListener = listener;
    },
    tailOutput() {
      return "fake-engine output";
    },
    exitNow: () => state.exitNow(),
  };
  void errorListener;
  return child;
}

function makePorts(overrides: Partial<EngineRuntimePorts> = {}): EngineRuntimePorts & {
  spawned: EngineSpawnSpec[];
} {
  const spawned: EngineSpawnSpec[] = [];
  const ports: EngineRuntimePorts & { spawned: EngineSpawnSpec[] } = {
    spawned,
    spawn: (spec) => {
      spawned.push(spec);
      return makeFakeChild();
    },
    probe: async () => true,
    allocatePort: async () => 3527,
    now: () => Date.now(),
    sleep: async () => {},
    ...overrides,
  };
  return ports;
}

const OPTS = {
  engineId: "node-red",
  dataDir: "/tmp/engine-data",
  command: "node",
  args: (port: number) => ["-e", `listen(${port})`],
};

/* ══════════ 1. 正常启动：只绑回环、env 完全替换 ══════════ */
{
  const ports = makePorts();
  const runtime = new EngineRuntime("node-red", ports);
  const status = await runtime.start(OPTS);
  eq("启动后进入 running", status.state, "running");
  eq("端口就是分配的那个", status.port, 3527);
  eq("engineId 原样回报", status.engineId, "node-red");

  const spec = ports.spawned[0];
  check("★ 子进程 cwd 是引擎自己的数据目录", spec?.cwd === OPTS.dataDir, spec?.cwd);
  eq("★ 环境变量里的 HOST 恒为 127.0.0.1", spec?.env.HOST, "127.0.0.1");
  eq("env 里带 PORT", spec?.env.PORT, "3527");
  check("★ 不继承宿主的任意 env（只给白名单 + 引擎自己的）",
    spec !== undefined && !("HOME" in spec.env) && !("ANTHROPIC_API_KEY" in spec.env),
    spec === undefined ? null : Object.keys(spec.env));
  check("env 里有 PATH（进程能起来的最低要求）", typeof spec?.env.PATH === "string");

  await runtime.stop();
  eq("stop 后是 stopped", runtime.status().state, "stopped");
  eq("stop 后端口清空", runtime.status().port, null);
}

/* ══════════ 2. 就绪探测失败 → 超时 failed 且进程被收掉 ══════════ */
{
  let kills = 0;
  const ports = makePorts({
    spawn: () => {
      const c = makeFakeChild();
      const orig = c.kill.bind(c);
      c.kill = (s) => {
        kills += 1;
        return orig(s);
      };
      return c;
    },
    probe: async () => false,
    // 时钟推进：每次 now() 前进 10s，让超时立刻发生。
    now: (() => {
      let t = 0;
      return () => (t += 10_000);
    })(),
  });
  const runtime = new EngineRuntime("node-red", ports);
  const status = await runtime.start({ ...OPTS, readyTimeoutMs: 5_000 });
  eq("★ 就绪超时进 failed", status.state, "failed");
  check("★ 失败原因说明是就绪超时", (status.reason ?? "").includes("没有就绪"), status.reason);
  check("★ 超时后进程被收掉（不留孤儿监听）", kills > 0, kills);
  eq("failed 时端口清空", status.port, null);
}

/* ══════════ 3. 进程意外退出 → failed 且带退出码 ══════════ */
{
  let fake: ReturnType<typeof makeFakeChild> | null = null;
  const ports = makePorts({
    spawn: () => {
      fake = makeFakeChild();
      return fake;
    },
    // 探活永远不成功，让 start 卡在 starting；随后我们手动让进程退出。
    probe: async () => {
      if (fake) fake.exitNow();
      return false;
    },
  });
  const runtime = new EngineRuntime("node-red", ports);
  const status = await runtime.start({ ...OPTS, readyTimeoutMs: 60_000 });
  eq("★ 进程退出后进 failed", status.state, "failed");
  check("★ 原因点名意外退出与退出码", (status.reason ?? "").includes("意外退出"), status.reason);
}

/* ══════════ 4. stop 的 SIGTERM → SIGKILL 升级与幂等 ══════════ */
{
  const fake = makeFakeChild({ ignoreSigterm: true });
  const ports = makePorts({
    spawn: () => fake,
    sleep: async () => {},
  });
  const runtime = new EngineRuntime("node-red", ports);
  await runtime.start(OPTS);
  eq("前置：已 running", runtime.status().state, "running");
  await runtime.stop(50);
  check("★ 忽略 SIGTERM 的进程会被 SIGKILL", fake.signalReceived.includes("SIGKILL"), fake.signalReceived);
  eq("stop 后 stopped", runtime.status().state, "stopped");

  // 重复 stop 幂等。
  const again = await runtime.stop();
  eq("重复 stop 仍然 stopped", again.state, "stopped");
}

/* ══════════ 5. 幂等启动：已在跑时不重复起进程 ══════════ */
{
  const ports = makePorts();
  const runtime = new EngineRuntime("node-red", ports);
  await runtime.start(OPTS);
  await runtime.start(OPTS);
  eq("★ 重复 start 不重复起进程", ports.spawned.length, 1);
  await runtime.stop();
}

/* ══════════ 6. 端口分配失败 → failed 且不起进程 ══════════ */
{
  const ports = makePorts({
    allocatePort: async () => {
      throw new Error("no dialable port");
    },
  });
  const runtime = new EngineRuntime("node-red", ports);
  const status = await runtime.start(OPTS);
  eq("分配端口失败 → failed", status.state, "failed");
  check("原因点名分配端口", (status.reason ?? "").includes("分配端口"), status.reason);
  eq("★ 端口都没分到就不该起进程", ports.spawned.length, 0);
}

console.log(`\nworkflow-engine-runtime-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
