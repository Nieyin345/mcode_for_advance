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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineRuntime, type EngineChildProcess, type EngineRuntimePorts, type EngineSpawnSpec } from "@main/workflowEngines/runtimeSupervisor.js";
import {
  BOOTSTRAP_MANIFEST_FILENAME,
  BOOTSTRAP_VERSION,
  ensureEngineBootstrap,
} from "@main/workflowEngines/bootstrapManifest.js";

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

/* ══════════ 10. 引导脚本版本与完整性（ARC-006 Gate B / P1-5） ══════════ */
// 生产引导脚本的**内容**属于 Gate A（另一个切片），本段不碰它 —— 只验版本/哈希
// 清单这一层：旧版升级、篡改恢复、一致不重写、失败拒绝、flows/creds 不被碰。
console.log("\n10. 引导脚本版本与完整性（bootstrap.manifest.json）");
{
  const NEW = "// bootstrap v2 (current)\nconsole.error('current');\n";
  const OLD = "// bootstrap v1 (stale on disk)\nconsole.error('stale');\n";
  const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
  const mkDataDir = (): string => mkdtempSync(join(tmpdir(), "mcode-bootstrap-"));

  /** 只有脚本、没有清单的旧布局（正是 P1-5 说的"存档目录里任意旧 JS"）。 */
  function seedOldLayout(dir: string, text: string): void {
    writeFileSync(join(dir, "bootstrap.cjs"), text, "utf8");
  }
  function listBackups(dir: string): string[] {
    return readdirSync(dir).filter((name) => name.startsWith("bootstrap.cjs.bak-")).sort();
  }
  function readManifestOrNull(dir: string): Record<string, unknown> | null {
    try {
      return JSON.parse(readFileSync(join(dir, BOOTSTRAP_MANIFEST_FILENAME), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  // —— 10.1 盘上是旧版本（无清单）→ 启动前替换为新版、旧字节备份 ——
  {
    const dir = mkDataDir();
    seedOldLayout(dir, OLD);
    writeFileSync(join(dir, "flows.json"), JSON.stringify([{ id: "flow1", type: "tab", label: "user" }]), "utf8");
    writeFileSync(join(dir, "flows_cred.json"), JSON.stringify({ $: "user-creds" }), "utf8");
    const flowsBefore = readFileSync(join(dir, "flows.json"));
    const credsBefore = readFileSync(join(dir, "flows_cred.json"));

    const result = ensureEngineBootstrap({ engineId: "node-red", dataDir: dir, content: NEW, now: () => new Date("2026-01-02T03:04:05.678Z") });
    check("★ 旧版本 bootstrap → 启动前被替换（upgraded）", result.ok && result.action === "upgraded", result);
    eq("★ 盘上现在是新版内容（sha256 一致）", sha(readFileSync(join(dir, "bootstrap.cjs"), "utf8")), sha(NEW));
    check("★ 旧文件有备份（.bak-<时间戳>）", result.backupPath !== null && existsSync(result.backupPath), result.backupPath);
    eq("★ 备份内容 = 旧字节（逐字节）", result.backupPath === null ? null : readFileSync(result.backupPath, "utf8"), OLD);
    const manifest = readManifestOrNull(dir);
    eq("★ 清单记录当前版本号", (manifest?.bootstrap as { version?: number } | undefined)?.version, BOOTSTRAP_VERSION);
    eq("★ 清单记录新版 sha256", (manifest?.bootstrap as { sha256?: string } | undefined)?.sha256, sha(NEW));
    check("★ 清单记录生成来源", typeof (manifest?.bootstrap as { source?: unknown } | undefined)?.source === "string", manifest);
    eq("★ flows.json 一个字节都没动", readFileSync(join(dir, "flows.json")), flowsBefore);
    eq("★ flows_cred.json 一个字节都没动", readFileSync(join(dir, "flows_cred.json")), credsBefore);
    eq("★ flows.json 没有被备份/改名（用户数据不参与引导脚本管理）", listBackups(dir).length, 1);
  }

  // —— 10.1b 清单版本低于当前（v-1）+ 旧内容 → 按升级处理，不静默使用 ——
  {
    const dir = mkDataDir();
    seedOldLayout(dir, OLD);
    writeFileSync(
      join(dir, BOOTSTRAP_MANIFEST_FILENAME),
      JSON.stringify({
        schema: "mcode.workflow-engine.bootstrap/v1",
        engineId: "node-red",
        bootstrap: { version: BOOTSTRAP_VERSION - 1, sha256: sha(OLD), source: "old-release" },
      }),
      "utf8",
    );
    const result = ensureEngineBootstrap({ engineId: "node-red", dataDir: dir, content: NEW });
    check("★ 清单版本低于当前 → 升级（upgraded），旧文件有备份", result.ok && result.action === "upgraded" && result.backupPath !== null, result);
    eq("★ 低版本清单升级后盘上是新版", sha(readFileSync(join(dir, "bootstrap.cjs"), "utf8")), sha(NEW));
  }

  // —— 10.1c 文件已一致、但清单版本落后 → 只把清单升到当前版本，不碰脚本 ——
  {
    const dir = mkDataDir();
    writeFileSync(join(dir, "bootstrap.cjs"), NEW, "utf8");
    const mtimeBefore = statSync(join(dir, "bootstrap.cjs")).mtimeMs;
    writeFileSync(
      join(dir, BOOTSTRAP_MANIFEST_FILENAME),
      JSON.stringify({
        schema: "mcode.workflow-engine.bootstrap/v1",
        engineId: "node-red",
        bootstrap: { version: BOOTSTRAP_VERSION - 1, sha256: sha(NEW), source: "old-release" },
      }),
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = ensureEngineBootstrap({ engineId: "node-red", dataDir: dir, content: NEW });
    eq("★ 清单版本落后但文件一致 → 清单被升到当前版本", (readManifestOrNull(dir)?.bootstrap as { version?: number } | undefined)?.version, BOOTSTRAP_VERSION);
    eq("★ 清单升级不重写脚本（mtime 不变）", statSync(join(dir, "bootstrap.cjs")).mtimeMs, mtimeBefore);
    check("★ 清单升级不产生备份", result.backupPath === null, result);
  }

  // —— 10.2 同版本但内容被外部篡改 → 替换并说明「已恢复」 ——
  {
    const dir = mkDataDir();
    const seeded = ensureEngineBootstrap({ engineId: "node-red", dataDir: dir, content: NEW });
    check("前置：首次写入（written）", seeded.ok && seeded.action === "written", seeded);
    const tampered = `${NEW}// injected by somebody else\n`;
    writeFileSync(join(dir, "bootstrap.cjs"), tampered, "utf8");

    const result = ensureEngineBootstrap({ engineId: "node-red", dataDir: dir, content: NEW, now: () => new Date("2026-01-02T03:04:06.000Z") });
    check("★ 同版本号但内容不同 → 被替换且归类为恢复（restored）", result.ok && result.action === "restored", result);
    eq("★ 恢复后的内容 = 清单字节", sha(readFileSync(join(dir, "bootstrap.cjs"), "utf8")), sha(NEW));
    check("★ 篡改内容被备份下来（可取证）", result.backupPath !== null && readFileSync(result.backupPath, "utf8") === tampered, result.backupPath);
  }

  // —— 10.2b 清单损坏（坏 JSON）→ 按「没有清单」处理，替换并重写清单 ——
  {
    const dir = mkDataDir();
    seedOldLayout(dir, OLD);
    writeFileSync(join(dir, BOOTSTRAP_MANIFEST_FILENAME), "{ not json", "utf8");
    const result = ensureEngineBootstrap({ engineId: "node-red", dataDir: dir, content: NEW });
    check("★ 清单损坏 → 不静默使用旧脚本（替换为当前版）", result.ok && result.action === "upgraded" && result.backupPath !== null, result);
    eq("★ 清单损坏 → 新清单可读且版本正确", readManifestOrNull(dir)?.bootstrap !== undefined
      ? ((readManifestOrNull(dir)!.bootstrap as { version?: number }).version ?? null)
      : null, BOOTSTRAP_VERSION);
  }

  // —— 10.3 已一致 → 不重写（mtime 不变） ——
  {
    const dir = mkDataDir();
    ensureEngineBootstrap({ engineId: "node-red", dataDir: dir, content: NEW });
    const bootstrapPath = join(dir, "bootstrap.cjs");
    const mtimeBefore = statSync(bootstrapPath).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = ensureEngineBootstrap({ engineId: "node-red", dataDir: dir, content: NEW });
    eq("★ 已一致 → 判定 unchanged", result.action, "unchanged");
    eq("★ 已一致 → 不重写（mtime 不变）", statSync(bootstrapPath).mtimeMs, mtimeBefore);
    eq("★ 已一致 → 不产生备份", listBackups(dir).length, 0);
  }

  // —— 10.4 清单缺失但脚本已一致 → 只补清单，不重写脚本 ——
  {
    const dir = mkDataDir();
    writeFileSync(join(dir, "bootstrap.cjs"), NEW, "utf8");
    const mtimeBefore = statSync(join(dir, "bootstrap.cjs")).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = ensureEngineBootstrap({ engineId: "node-red", dataDir: dir, content: NEW });
    check("★ 清单缺失但脚本一致 → 成功且补写清单", result.ok && readManifestOrNull(dir) !== null, result);
    eq("★ 清单缺失但脚本一致 → 脚本本身不重写（mtime 不变）", statSync(join(dir, "bootstrap.cjs")).mtimeMs, mtimeBefore);
  }

  // —— 10.5 替换失败（bootstrap.cjs 是目录）→ failed + 原因，生产 launchSpec 拒绝启动 ——
  {
    const { ProductionWorkflowEngineRegistry } = await import("@main/workflowEngines/registry.js");
    const registry = new ProductionWorkflowEngineRegistry();
    const dir = registry.dataDirOf("node-red");
    // 造出"已安装 node-red"的最小标记（launchSpec 只查这个文件存在）。
    mkdirSync(join(dir, "node_modules", "node-red"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "node-red", "package.json"), JSON.stringify({ name: "node-red", version: "0.0.0-fixture" }), "utf8");
    // 「bootstrap.cjs 是个目录」制造必失败：读它 EISDIR → 当作缺失；rename 到目录上
    // 必失败。不能用只读目录模拟 —— Windows 上对只读目录照样能写（实测）。
    mkdirSync(join(dir, "bootstrap.cjs"));

    const result = ensureEngineBootstrap({ engineId: "node-red", dataDir: dir, content: NEW });
    check("★ 替换失败 → ok:false 且带可读原因", result.ok === false && (result.reason ?? "").length > 0, result);
    check("★ 替换失败 → 不归类为任何成功动作", result.action === null, result.action);

    const launch = registry.launchSpec("node-red");
    check("★ 替换失败 → 生产 launchSpec 拒绝给出启动参数（旧脚本不会被 spawn）", launch === null, launch);
    // 失败后盘上仍然只有那个目录 —— 没有留下半份新 bootstrap，也没有残留的 staging。
    check("★ 替换失败 → 没有留下半份 staging 文件", !existsSync(join(dir, "bootstrap.cjs.tmp")));
    check("★ 替换失败 → 失败现场仍是原来的目录（没有被退化成直接写）", statSync(join(dir, "bootstrap.cjs")).isDirectory());

    // 清掉失败夹具，交给 10.6 验成功路径。
    rmSync(join(dir, "bootstrap.cjs"), { recursive: true, force: true });
  }

  // —— 10.6 生产 launchSpec 真装配：旧脚本在盘 → 被替换；一致 → 不重写 ——
  {
    const { ProductionWorkflowEngineRegistry } = await import("@main/workflowEngines/registry.js");
    const registry = new ProductionWorkflowEngineRegistry();
    const dir = registry.dataDirOf("node-red");
    writeFileSync(join(dir, "bootstrap.cjs"), OLD, "utf8");
    writeFileSync(join(dir, "flows.json"), JSON.stringify([{ id: "flow1", type: "tab", label: "user" }]), "utf8");
    const flowsBefore = readFileSync(join(dir, "flows.json"));

    const launch = registry.launchSpec("node-red");
    check("★ 生产 launchSpec 认得旧脚本并给出启动参数", launch !== null, launch);
    const onDisk = readFileSync(join(dir, "bootstrap.cjs"), "utf8");
    check("★ 生产 launchSpec 启动前把旧脚本换成了当前版（不再悄悄用旧 JS）", onDisk !== OLD && onDisk.includes("mcode-engine"), onDisk.slice(0, 60));
    check("★ 生产 launchSpec 留下了旧字节备份", listBackups(dir).length >= 1, listBackups(dir));
    check("★ 生产 launchSpec 生成了清单", readManifestOrNull(dir) !== null, readManifestOrNull(dir));

    // 第二次 launchSpec：已经一致 → 不再写盘，也不再产生新备份。
    const mtimeBefore = statSync(join(dir, "bootstrap.cjs")).mtimeMs;
    const backupsBefore = listBackups(dir).length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = registry.launchSpec("node-red");
    check("★ 第二次 launchSpec 仍给出启动参数", second !== null);
    eq("★ 已一致 → 第二次不改写 bootstrap（mtime 不变）", statSync(join(dir, "bootstrap.cjs")).mtimeMs, mtimeBefore);
    eq("★ 已一致 → 不产生第二份备份", listBackups(dir).length, backupsBefore);
    eq("★ 用户 flows.json 全程未被触碰", readFileSync(join(dir, "flows.json")), flowsBefore);
  }

  console.log(`\nworkflow-engine-runtime-smoke(含引导完整性):${total - failures}/${total} 通过`);
}

// 退出码只在这里定一次 —— 前面 §7/§8 的失败同样要红(从前 exitCode=1 设在 §7 之前,
// §7/§8 里的 FAIL 会被仍为 0 的退出码盖过去:变异验证时实测「套件绿着而断言红着」)。
if (failures > 0) process.exitCode = 1;
