/**
 * 【Q8 / Q9e】**引擎按需启动的三态判据** —— `engineAutostart` 的回归网。
 *
 * ## 它守的两条路，判据不同，不能混
 *
 * | 时机 | 函数 | 判据 |
 * |---|---|---|
 * | 应用启动 | `startEngineIfNeeded` | **有 node-red 图才起** —— 不为用不到的功能付常驻内存 |
 * | 用户打开工作流界面 | `ensureEngineStarted` | **用户要用了就起**，库里有没有图无关 |
 *
 * ## 没有这条网时的实际症状（产品要求「下载即可用」）
 *
 * 全新用户的库里一张图都没有 → 启动期那条判定「不需要」静默返回 → 用户第一次
 * 点开工作流看到「引擎未就绪」，必须先按一次「启动」才能画第一张图。
 *
 * ## 三态必须分得开
 *
 * `{started:true}` / `{started:false,reason:null}`（本来就不需要）/
 * `{started:false,reason:"..."}`（需要但起不来，**必须记账**）——
 * 把后两者压成一个布尔，界面就无法区分「没事」和「坏了」。
 *
 * ## 被测的是真身
 *
 * `startEngineIfNeeded` / `ensureEngineStarted` 都是**生产那两份函数**，只有
 * `EngineRuntime` 换成记录状态的假实现（真那个会 spawn 子进程）。判据本身不抄副本。
 *
 * Run: bash scripts/engine-autostart-smoke/run.sh
 */
import {
  ensureEngineStarted,
  startEngineIfNeeded,
  type EngineAutostartPorts,
} from "@main/workflowEngines/engineAutostart.js";

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
  check(name, Object.is(actual, expected), { actual, expected });
}

/* ── 假 EngineRuntime：只答状态、记启动次数 ── */

interface FakeOptions {
  /** 初始状态。缺省 `stopped`（没起过）。 */
  state?: "stopped" | "running" | "starting";
  /** `start()` 的结局。 */
  start?: "ok" | { fail: string };
  /** false = 注册表里查不到 node-red（模拟未注册）。 */
  registered?: boolean;
}

interface Harness {
  ports: EngineAutostartPorts;
  /** `runtime.start()` 被调了几次。 */
  starts(): number;
}

function makeHarness(opts: FakeOptions = {}): Harness {
  // 失败时状态会变成 `failed` —— 所以这里的类型要含它，不能只用初始那三态。
  let state: "stopped" | "running" | "starting" | "failed" = opts.state ?? "stopped";
  let starts = 0;
  const runtime = {
    status: () => ({ state, port: null, reason: state === "stopped" ? "未启动" : null }),
    async start() {
      starts += 1;
      const outcome = opts.start ?? "ok";
      if (outcome === "ok") {
        state = "running";
        return { state: "running", port: 1880, reason: null };
      }
      state = "failed";
      return { state: "failed", port: null, reason: outcome.fail };
    },
  };
  const registry = {
    get: (id: string) => (opts.registered === false || id !== "node-red" ? null : runtime),
  };
  return {
    ports: {
      // 本套只关心「有没有图」这一个输入；它由用例显式给出，不是从库里读的。
      hasNativeWorkflows: () => HAS_NATIVE,
      engine: {
        registry: registry as unknown as EngineAutostartPorts["engine"]["registry"],
        launchSpec: () => ({ command: "node", args: () => ["engine.cjs"], dataDir: "/tmp/x", env: {} }),
        beforeStart: async () => {},
      },
    },
    starts: () => starts,
  };
}

/** 每个用例自己设，`makeHarness` 里读它。 */
let HAS_NATIVE = false;

function withNative(value: boolean): void {
  HAS_NATIVE = value;
}

/* ══════════ ① 启动期：没有 node-red 图就不起 ══════════ */

console.log("\n① startEngineIfNeeded：库里没有 node-red 图 → 静默不启动");
{
  withNative(false);
  const h = makeHarness();
  const result = await startEngineIfNeeded(h.ports);
  eq("★ 没有原生图 → started=false", result.started, false);
  eq("★ 没有原生图 → reason 是 null（不是错误）", result.reason, null);
  eq("★ 没有原生图 → 一次都没调引擎启动", h.starts(), 0);
}

/* ══════════ ② 启动期：有图就起 ══════════ */

console.log("\n② startEngineIfNeeded：有 node-red 图 → 真的启动");
{
  withNative(true);
  const h = makeHarness();
  const result = await startEngineIfNeeded(h.ports);
  eq("★ 有原生图 → started=true", result.started, true);
  eq("★ 有原生图 → reason 是 null", result.reason, null);
  eq("★ 有原生图 → 启动被调用 1 次", h.starts(), 1);
}

console.log("\n③ 已在运行 → 不重复启动（幂等）");
{
  withNative(true);
  const h = makeHarness({ state: "running" });
  const result = await startEngineIfNeeded(h.ports);
  eq("★ running → started=false", result.started, false);
  eq("★ running → reason=null（本来就不需要）", result.reason, null);
  eq("★ running → 没有再调一次启动", h.starts(), 0);
}

console.log("\n④ starting 也算「已经在起」 → 不并发起第二次");
{
  withNative(true);
  const h = makeHarness({ state: "starting" });
  const result = await startEngineIfNeeded(h.ports);
  eq("★ starting → started=false", result.started, false);
  eq("★ starting → reason=null", result.reason, null);
  eq("★ starting → 没有再调一次启动", h.starts(), 0);
}

console.log("\n⑤ 需要但起不来 → reason 非 null（必须记账，不能静默）");
{
  withNative(true);
  const h = makeHarness({ start: { fail: "端口被占用" } });
  const result = await startEngineIfNeeded(h.ports);
  eq("★ 启动失败 → started=false", result.started, false);
  check("★ 启动失败 → reason 是那句原因（不是 null）", result.reason === "端口被占用", result.reason);
}

/* ══════════ ⑥ 用户打开工作流界面：库里没图也要起 ══════════ */

console.log("\n⑥ ensureEngineStarted：库里**没有**图也要起（这是「下载即可用」的那一条）");
{
  withNative(false);
  const h = makeHarness();
  const result = await ensureEngineStarted(h.ports);
  eq("★ 无图 + 用户要用 → started=true", result.started, true);
  eq("★ 无图 + 用户要用 → 启动被调用 1 次", h.starts(), 1);

  // ★ 对照：同一份「无图」事实，启动期判据**不起** —— 证明两条路确实不同，
  // 而不是我写了两遍同一个函数（写重了的话下面这条会红）。
  withNative(false);
  const startup = makeHarness();
  const atStartup = await startEngineIfNeeded(startup.ports);
  eq("★ 对照：同一份「无图」事实，启动期判据不起", atStartup.started, false);
  eq("★ 对照：启动期那条连启动都没调", startup.starts(), 0);
}

console.log("\n⑦ ensureEngineStarted：已经在跑 → 幂等，不重复起");
{
  withNative(true);
  const h = makeHarness({ state: "running" });
  const result = await ensureEngineStarted(h.ports);
  eq("★ running → started=false", result.started, false);
  eq("★ running → 没有重复启动", h.starts(), 0);
}

console.log("\n⑧ ensureEngineStarted：起不来时同样返回 reason（界面要能显示）");
{
  withNative(false);
  const h = makeHarness({ start: { fail: "vendor 校验失败" } });
  const result = await ensureEngineStarted(h.ports);
  eq("★ 失败 → started=false", result.started, false);
  check("★ 失败 → reason 非 null", result.reason === "vendor 校验失败", result.reason);
}

console.log("\n⑨ 引擎根本没注册 → 明确报错，不是静默成功");
{
  withNative(true);
  const a = await startEngineIfNeeded(makeHarness({ registered: false }).ports);
  eq("★ 启动期：未注册 → started=false", a.started, false);
  check("★ 启动期：未注册 → reason 点名引擎", (a.reason ?? "").includes("node-red"), a.reason);

  withNative(false);
  const b = await ensureEngineStarted(makeHarness({ registered: false }).ports);
  eq("★ 界面路径：未注册 → started=false", b.started, false);
  check("★ 界面路径：未注册 → reason 点名引擎", (b.reason ?? "").includes("node-red"), b.reason);
}

console.log(`\nengine-autostart-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
