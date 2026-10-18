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

/* ══════════ 7. IPC 层：fakeIpc 调真 handler ══════════ */
{
  const { registerWorkflowEngineHandlers, toStatusView } = await import("@main/ipc/workflowEngine.js");
  const { clearRpcHandlers, registeredRpcChannels } = await import("@main/appControl/registry.js");
  const { IPC } = await import("@contracts/ipc");
  clearRpcHandlers();

  const ports = makePorts();
  const runtime = new EngineRuntime("node-red", ports);
  const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const fakeIpc = {
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      if (handlers.has(channel)) throw new Error(`重复注册 ${channel}`);
      handlers.set(channel, listener);
    },
  } as unknown as Parameters<typeof registerWorkflowEngineHandlers>[0];
  registerWorkflowEngineHandlers(fakeIpc, {
    registry: { get: (id) => (id === "node-red" ? runtime : null), ids: () => ["node-red"] },
    launchSpec: (id) =>
      id === "node-red"
        ? { command: "node", args: () => ["bootstrap.cjs"], dataDir: "/tmp/engine" }
        : null,
  });
  const call = async (channel: string, raw?: unknown): Promise<unknown> =>
    (await handlers.get(channel)!(null, raw));

  eq("★ 四条 workflowEngine 通道全注册", [...handlers.keys()].sort(), [
    IPC.WORKFLOW_ENGINE_LIST, IPC.WORKFLOW_ENGINE_START, IPC.WORKFLOW_ENGINE_STATUS, IPC.WORKFLOW_ENGINE_STOP,
  ].sort());
  const rpc = new Set(registeredRpcChannels());
  eq("每条都进 recordRpcHandler（Agent 也够得到同一个函数）",
    [IPC.WORKFLOW_ENGINE_START, IPC.WORKFLOW_ENGINE_STOP, IPC.WORKFLOW_ENGINE_STATUS, IPC.WORKFLOW_ENGINE_LIST].filter((c) => !rpc.has(c)), []);

  const started = (await call(IPC.WORKFLOW_ENGINE_START, { engineId: "node-red" })) as { ok: boolean; status?: { state: string; editorUrl: string | null } };
  eq("handler start → ok", started.ok, true);
  eq("start 后状态 running", started.status?.state, "running");
  eq("★ editorUrl 是回环地址", started.status?.editorUrl, "http://127.0.0.1:3527/");

  const bad = (await call(IPC.WORKFLOW_ENGINE_START, { engineId: "Not Valid" })) as { ok: boolean; reason: string };
  check("★ 非法 engineId 被 zod 拒", bad.ok === false && typeof bad.reason === "string", bad);

  const unknown = (await call(IPC.WORKFLOW_ENGINE_START, { engineId: "unknown-engine" })) as { ok: boolean; reason: string };
  check("★ 未注册的引擎显式拒绝", unknown.ok === false && unknown.reason.includes("未知工作流引擎"), unknown);

  const listed = (await call(IPC.WORKFLOW_ENGINE_LIST)) as { engines: Array<{ engineId: string }> };
  eq("list 列出已注册引擎", listed.engines.map((e) => e.engineId), ["node-red"]);

  const stopped = (await call(IPC.WORKFLOW_ENGINE_STOP, { engineId: "node-red" })) as { ok: boolean; status?: { state: string } };
  eq("handler stop → stopped", stopped.status?.state, "stopped");

  // 状态视图：非 running 时没有 editorUrl。
  const view = toStatusView(runtime.status());
  eq("★ 未运行时 editorUrl 为 null", view.editorUrl, null);
  eq("★ 状态视图不含命令/凭据字段", Object.keys(view).sort(), ["editorUrl", "engineId", "port", "reason", "state"]);
}

console.log(`\nworkflow-engine-runtime-smoke(含IPC):${total - failures}/${total} 通过`);

/* ══════════ 8. 生产注册表：statusOf 只读、不建运行时 ══════════ */
// 【ARC-006 桥 1】执行器的条件注册经 `executionEngine.setWorkflowEngineStatusPort`
// 查询生产注册表（`main/index.ts` 装配）。那条查询发生在**启动装配期**，所以它
// 绝不能顺手建出一个运行时（那会让"从未启动"的引擎看起来像已存在）。
{
  const { ProductionWorkflowEngineRegistry } = await import("@main/workflowEngines/registry.js");
  const registry = new ProductionWorkflowEngineRegistry();
  eq("★ 未取过运行时 → statusOf 回 null(不因一句查询而建实例)", registry.statusOf("node-red"), null);
  eq("未知引擎 id 的 statusOf 也回 null", registry.statusOf("other-engine"), null);

  const created = registry.get("node-red");
  eq("get 之后 statusOf 反映真实状态(stopped)", registry.statusOf("node-red")?.state, "stopped");
  eq("statusOf 与 runtime.status() 是同一份事实", registry.statusOf("node-red")?.engineId, created?.status().engineId);
}


/* ══════════ 9. 生产端口分配：真起一个可拨通的回环端口 ══════════ */
{
  const { defaultEngineRuntimePorts } = await import("@main/workflowEngines/runtimeSupervisor.js");
  const { isBlockedPort } = await import("@main/lib/loopbackPort.js");
  // 真缺陷回归：`listenOnDialablePort` 返回 Promise<number>，早先被误当 err-first
  // 回调解构，生产每次 start 都会以「分配端口失败」进 failed（真 Electron U1 抓到）。
  // 用 catch 包住：分配失败要给一条**可读的 FAIL**，而不是让未捕获异常把整套崩掉
  // （变异验证时实测：错误解构会把端口号当 err 抛出，套件直接 terminate）。
  let port: number | null = null;
  let portError: string | null = null;
  try {
    port = await defaultEngineRuntimePorts.allocatePort();
  } catch (err) {
    portError = err instanceof Error ? err.message : String(err);
  }
  check("★ 生产端口分配真的返回一个端口号", port !== null && Number.isInteger(port) && port > 0, { port, portError });
  check("★ 分配失败时给出可读原因（不是未捕获异常）", portError === null || /端口/.test(portError), portError);
  check("★ 分配到的不是 fetch 黑名单端口", port !== null && !isBlockedPort(port), port);
}
console.log(`\nworkflow-engine-runtime-smoke(含注册表):${total - failures}/${total} 通过`);
// 退出码只在这里定一次 —— 前面 §7/§8 的失败同样要红(从前 exitCode=1 设在 §7 之前,
// §7/§8 里的 FAIL 会被仍为 0 的退出码盖过去:变异验证时实测「套件绿着而断言红着」)。
if (failures > 0) process.exitCode = 1;
