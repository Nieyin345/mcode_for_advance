/**
 * Headless smoke for the monitoring-panel IPC route (`main/ipc/monitoring.ts`).
 *
 * The contract and preload channel names must match the registered handlers.
 * Runs and overview are exercised with a temporary data root and real NDJSON;
 * collector subscriptions must not duplicate records. No real user DB is used.
 *
 * Run: scripts/observability-ipc-smoke/run.sh
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IpcMain } from "electron";
import type { Session } from "@contracts/session";
import type { RuntimeEvent } from "@contracts/runtime";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 多字段一次断(失败时 detail 里两串并排,一眼看出哪项漂了)。 */
function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/** 数据根必须由环境变量给 —— 桩里没设就抛,这里先钉住它没被漏掉。 */
const DATA = process.env.MCODE_SMOKE_DATA_ROOT;
if (!DATA) {
  throw new Error("MCODE_SMOKE_DATA_ROOT 没设 —— 这套脚本绝不允许落到真数据根上");
}

/* ──────────────── 0. ipcMain 的记名替身 ──────────────── */

/** Monitor handler registrations are recorded without starting Electron. */
function makeFakeIpc(): {
  ipc: IpcMain;
  handlers: Map<string, (event: unknown, raw: unknown) => unknown>;
} {
  const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const ipc = {
    handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
      handlers.set(channel, listener);
    },
  } as unknown as IpcMain;
  return { ipc, handlers };
}

/** 按 channel 取回真注册进去的那个函数。取不到 = 渠道名两边对不上,直接炸。 */
function callerOf(
  handlers: Map<string, (event: unknown, raw: unknown) => unknown>,
  channel: string,
): (raw?: unknown) => unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没有注册 ${channel}(渠道名两边对不上了?)`);
  return (raw?: unknown) => fn(null, raw);
}

const { IPC } = await import("@contracts/ipc");
const { mobileEventBus } = await import("@main/mobile/MobileEventBus.js");
const { readRunSummaries, appendRunSummary } = await import("@main/monitoring/store.js");
const { limitsSince, limitsCount } = await import("./stubs/store.js");
const { registerMonitoringHandlers } = await import("@main/ipc/monitoring.js");
const { initDb } = await import("@main/store/db.js");
const { SessionRepo, ProjectRepo } = await import("@main/store/repositories.js");
const { collectorDeps } = await import("./stubs/collector.js");
const { lines: logLines } = await import("./stubs/logger.js");

// ⚠️ `dataRoot` 必须走桩:`getDb()` 在 `initDb()` 没 resolve 前会抛,而
// `registerMonitoringHandlers` 不是 async —— 桩里那句"环境变量没设就抛"
// 就是这套脚本的安全闸。这里读一次,只为让"它没被漏掉"这件事在启动时就炸。
const { dataRoot: rootOf } = await import("@main/lib/dataRoot.js");
const DATA_FROM_STUB = rootOf();
if (DATA_FROM_STUB !== DATA) {
  throw new Error(`dataRoot 桩给出的根不对:${DATA_FROM_STUB} ≠ ${DATA}`);
}

await initDb();

/* ──────────────── 1. 夹具 ──────────────── */

const now0 = Date.now();
ProjectRepo.create({
  id: "p_obs",
  name: "可观测性冒烟项目",
  path: "D:/proj_obs",
  archived: false,
  group: null,
  sortOrder: 0,
  pinnedAt: null,
  createdAt: now0,
  updatedAt: now0,
});

/** 全字段 `Session` —— `SessionRepo.create` 是按 `SESSION_COLUMNS` 逐个 bind 的。 */
function sessionOf(id: string, kind: Session["kind"]): Session {
  const now = Date.now();
  return {
    id,
    projectId: "p_obs",
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind,
    parentSessionId: null,
    nodeId: null,
    title: "冒烟会话",
    status: "idle",
    model: "",
    effort: "default",
    permissionMode: "default",
    workflowId: "wf_obs",
    customModelId: null,
    envMode: "local",
    worktreePath: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    turnFiles: null,
    usageHistory: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: now,
    updatedAt: now,
  };
}

SessionRepo.create(sessionOf("s_chat", "chat"));

/* ──────────────── 1. ★ 渠道名:两边一字不差 ──────────────── */

console.log("\n监控 · 渠道名两边一字不差");

const mon = makeFakeIpc();

{
  // ⚠️ `ipc/monitoring.ts` 的两个渠道名是**就地定义的字符串常量**,注释说
  // 「gate 时换成 `IPC.*` 引用,字符串两边必须一字不差」。
  //
  // 渲染端实际 invoke 的那个字符串在 preload 里:
  //   `ipcRenderer.invoke(IPC.MONITORING_OVERVIEW)`
  //   `ipcRenderer.invoke(IPC.MONITORING_RUNS, input)`
  // 也就是说渲染端用的是 **`IPC.*` 的值**。所以"两边对得上"这个判据可以完全
  // 落在运行时:`registerMonitoringHandlers` 注册的键里,必须有
  // `IPC.MONITORING_OVERVIEW` 和 `IPC.MONITORING_RUNS` **这两个字符串**。
  //
  // 对不上就是真 bug:面板永远读不到数据,而且 `invoke` 的 reject 被面板自己
  // 吞成一行小字 —— "没数据"和"通道坏了"在界面上长得一模一样。
  //
  // 这一条是前两层:`IPC.*` 的值 vs 契约里写的名字(有人改契约常量会被发现)。
  eq(
    "✅ IPC.MONITORING_OVERVIEW 就是 'monitoring:overview'",
    IPC.MONITORING_OVERVIEW,
    "monitoring:overview",
  );
  eq(
    "✅ IPC.MONITORING_RUNS 就是 'monitoring:runs'",
    IPC.MONITORING_RUNS,
    "monitoring:runs",
  );
}

registerMonitoringHandlers(mon.ipc);

{
  // 第三层:handler 注册的键 vs 渲染端 invoke 的那个字符串。**这一条才真正
  // 钉住"两边一字不差"** —— 前两条只是把契约常量本身框住,两条可以同时是
  // 同一个错字(比如都写成 `monitoring:Overview`),而这一条会立刻红。
  check(
    "✅ 渲染端 invoke 的 IPC.MONITORING_OVERVIEW 真的有人接",
    mon.handlers.has(IPC.MONITORING_OVERVIEW),
  );
  check(
    "✅ 渲染端 invoke 的 IPC.MONITORING_RUNS 真的有人接",
    mon.handlers.has(IPC.MONITORING_RUNS),
  );
  same(
    "✅ 注册进来的键正好是契约那两个(没有多一个、少一个、拼错一个)",
    [...mon.handlers.keys()].sort(),
    [IPC.MONITORING_OVERVIEW, IPC.MONITORING_RUNS].sort(),
  );
}

/* ──────────────── 2. 监控 · 种数据 ──────────────── */

console.log("\n监控 · 种 600 条运行摘要");

/** NDJSON 里一行就是一次收口的运行。条数要 > 500 才验得出上界。 */
const SEEDED = 600;
{
  for (let i = 0; i < SEEDED; i += 1) {
    appendRunSummary(DATA, {
      runId: `run_${String(i).padStart(4, "0")}`,
      workflowId: "wf_obs",
      sessionId: "s_chat",
      // 每三条一条失败 —— overview 的成败计数与 lastError 都靠它。
      status: i % 3 === 0 ? "failed" : "success",
      startedAt: 1_700_000_000_000 + i,
      durationMs: 100 + i,
      nodes: [],
      endedAt: 1_700_000_000_000 + i + 100,
    });
  }
  eq(`种了 ${SEEDED} 条进 NDJSON`, readRunSummaries(DATA).length, SEEDED);
  // 落盘的地方必须是临时数据根下的 monitoring/runs.ndjson,不是别处。
  check(
    "摘要在 <临时根>/monitoring/runs.ndjson 里",
    existsSync(join(DATA, "monitoring", "runs.ndjson")),
    join(DATA, "monitoring", "runs.ndjson"),
  );
  check(
    "文件是一行一个 JSON(真 NDJSON)",
    readFileSync(join(DATA, "monitoring", "runs.ndjson"), "utf8")
      .trimEnd()
      .split("\n")
      .every((l) => {
        try {
          JSON.parse(l);
          return true;
        } catch {
          return false;
        }
      }),
  );
}

/* ──────────────── 3. ★ runs 的 limit 夹取 ──────────────── */

console.log("\n监控 · limit 夹取");

const monitoringRuns = callerOf(mon.handlers, IPC.MONITORING_RUNS);

/**
 * 每一条都单独钉。夹取写的是
 * `Math.min(Math.max(Math.trunc(n), 1), 500)`,坏值(non-finite / 非 number /
 * 缺席)回落 50。
 *
 * `expected` 是**代码算出来的那个数**,不是盘上真有几条 —— 下面有专门一条把
 * "上界>盘上条数"的情况分开验(种了 600 条,所以 500 与 1e9 都能看出差别)。
 */
const LIMIT_CASES: Array<{ name: string; arg: unknown; expected: number }> = [
  { name: "limit=0 → 夹到 1,不是 0 条", arg: { limit: 0 }, expected: 1 },
  { name: "limit=-1 → 也夹到 1", arg: { limit: -1 }, expected: 1 },
  { name: "limit=-1e9 → 同样夹到 1", arg: { limit: -1e9 }, expected: 1 },
  { name: "limit=1e9 → 被上限 500 挡住", arg: { limit: 1e9 }, expected: 500 },
  { name: "limit=501 → 被上限 500 挡住", arg: { limit: 501 }, expected: 500 },
  { name: "limit=500 是上界本身 → 放行", arg: { limit: 500 }, expected: 500 },
  { name: "limit=7 → 原样放行", arg: { limit: 7 }, expected: 7 },
  { name: "limit=1 是下界本身 → 放行", arg: { limit: 1 }, expected: 1 },
  { name: "limit=2.9 → 先 trunc 成 2(不是四舍五入成 3)", arg: { limit: 2.9 }, expected: 2 },
  { name: "limit=0.9 → trunc 成 0,再夹到 1", arg: { limit: 0.9 }, expected: 1 },
  { name: "limit=NaN → 回落默认 50(不是 1、也不是 500)", arg: { limit: NaN }, expected: 50 },
  { name: "limit=Infinity → 回落默认 50(不是 500)", arg: { limit: Infinity }, expected: 50 },
  { name: "limit=-Infinity → 回落默认 50", arg: { limit: -Infinity }, expected: 50 },
  { name: "limit='10'(字符串)→ 回落默认 50,手解不认字符串", arg: { limit: "10" }, expected: 50 },
  { name: "limit=null → 回落默认 50", arg: { limit: null }, expected: 50 },
  { name: "limit=true → 回落默认 50(布尔不是 number)", arg: { limit: true }, expected: 50 },
  { name: "limit 字段整个缺席 → 默认 50", arg: {}, expected: 50 },
];

{
  for (const c of LIMIT_CASES) {
    const rows = (await monitoringRuns(c.arg)) as unknown[];
    eq(c.name, rows.length, Math.min(c.expected, SEEDED));
  }

  // raw 整个不传(生产里 preload 那句 `invoke(IPC.MONITORING_RUNS, input)` 的
  // input 可能是 undefined —— 手机端/老调用方)也要走兜底,不能 TypeError。
  const noRaw = (await monitoringRuns()) as unknown[];
  eq("raw 整个不传 → 默认 50 条,不抛", noRaw.length, 50);
  const nilRaw = (await monitoringRuns(null)) as unknown[];
  eq("raw 传 null → 默认 50 条,不抛", nilRaw.length, 50);
  const arrRaw = (await monitoringRuns([1, 2, 3])) as unknown[];
  eq("raw 传数组(没有 limit 字段)→ 默认 50 条,不抛", arrRaw.length, 50);

  // ★ 下限夹取必须单独验一次,**看传下去的那个数**而不是最终条数。
  //
  // 为什么不能靠条数:`store.ts` 的循环是"先 push 再比"——
  //
  //   out.push(parsed);
  //   if (limit !== undefined && out.length >= limit) break;
  //
  // 所以 `limit: 0` 也先给出 1 条。把 `Math.max(trunc, 1)` 那一层**整个撤掉**,
  // 返回值**一点不变** —— 实测:撤掉它整套 smoke 全绿(变异 M3)。
  //
  // 但那是"依赖一个没承诺的行为":`store.ts` 的入参约定写着"`limit` 是去重之后
  // 还要多少条",给它 0 / 负数就是越界调用。哪天那条循环改成"先比再 push"
  // (或换一份实现),越界立刻变成"传 0 拿到 0 条" —— 用户看到面板空着。
  // 所以判据立在这里:handler 传下去的每一个 limit 都必须是 [1, 500] 里的整数。
  const probeLimit = async (arg: unknown): Promise<number | undefined> => {
    const mark = limitsCount();
    await monitoringRuns(arg);
    return limitsSince(mark).at(-1);
  };
  same(
    "★ 传 0 时下去的是 1(不是 0)—— 下限夹取在这",
    await probeLimit({ limit: 0 }),
    1,
  );
  same("★ 传 -1 时下去的是 1(不是负数)", await probeLimit({ limit: -1 }), 1);
  same("★ 传 -1e9 时下去的也是 1", await probeLimit({ limit: -1e9 }), 1);
  same("★ 传 0.9(trunc 成 0)下去的是 1", await probeLimit({ limit: 0.9 }), 1);
  same(
    "★ 传 1e9 时下去的是 500(不是 1e9)—— 上限夹取在这",
    await probeLimit({ limit: 1e9 }),
    500,
  );
  same("★ 传 NaN 时下去的是默认 50(不是 NaN)", await probeLimit({ limit: NaN }), 50);
  same("★ 不传 raw 时下去的是默认 50", await probeLimit(undefined), 50);

  // ★ 上界真的存在吗?—— `expected` 与盘上真实条数为 600 时,`limit=500` 与
  // `limit=1e9` 都会给出 500。要证明"500 那个数是上限夹出来的、不是盘上只有
  // 500 条",得同时看"不夹的话会给多少":直接读 600 条应当得到 600。
  const all = readRunSummaries(DATA).length;
  const capped = ((await monitoringRuns({ limit: 1e9 })) as unknown[]).length;
  same(
    "★ 1e9 经 handler 后是 500,而不带 limit 直接读盘是 600 —— 上限真的是夹出来的",
    [capped, all],
    [500, 600],
  );
  // 倒序切片也要对:limit=3 给的必须是**最新**三条,不是最旧三条。
  const three = (await monitoringRuns({ limit: 3 })) as Array<{ runId: string }>;
  same(
    "limit=3 给的是最新三条(倒序读,顺序就是'最新在前'的语义)",
    three.map((r) => r.runId),
    ["run_0599", "run_0598", "run_0597"],
  );
}

/* ──────────────── 4. ★ overview 是无参 handler ──────────────── */

console.log("\n监控 · overview 无参调用");

const monitoringOverview = callerOf(mon.handlers, IPC.MONITORING_OVERVIEW);

{
  // ★ 任务点名的那条:`overview` 是**无参 handler,不接 raw**。生产里 preload
  // 那句是 `invoke(IPC.MONITORING_OVERVIEW)` —— 没有第二个实参。写成
  // `(_evt, raw) => raw.limit` 那种就会在生产上炸成 TypeError,而面板把它吞成
  // 一行小字(见 `MonitoringPanel.tsx` 文件头)。所以两条都要钉:不带 raw 不抛、
  // **多带**一个 raw 也不抛(它压根不读)。
  let threw: string | null = null;
  let ov: Record<string, unknown> | null = null;
  try {
    ov = (await monitoringOverview()) as Record<string, unknown>;
  } catch (err) {
    threw = (err as Error).message;
  }
  eq("★ 不带参数调用**不抛**", threw, null);
  check(
    "★ 回的是汇总对象(面板四张卡的字段一个不少、类型都对)",
    ov !== null &&
      typeof ov === "object" &&
      typeof ov.totalRuns === "number" &&
      typeof ov.succeeded === "number" &&
      typeof ov.failed === "number" &&
      typeof ov.avgDurationMs === "number",
    ov,
  );

  // 口径:totalRuns 是**全部**收口运行(含取消),不只数成败。
  same(
    "600 条里总运行 / 成功 / 失败",
    [ov?.totalRuns, ov?.succeeded, ov?.failed],
    [600, 400, 200],
  );
  // 400 = 600 - 200。每三条一条失败,i%3===0 在 0..599 里正好 200 条。
  eq("平均耗时对全部运行平均(100..699 → 399.5 → 400)", ov?.avgDurationMs, 400);
  // 失败运行里没有带 error 的失败节点 → 契约的可选字段该**缺席**,而不是
  // 给一个 undefined 值的键(渲染端判的是 `!== undefined`,两者等价,但
  // preload 的签名是可选字段,给 undefined 值过不了结构化克隆的严格判)。
  eq(
    "没有可报的错误原因时,lastErrorMessage 缺席(不是空串)",
    "lastErrorMessage" in (ov ?? {}),
    false,
  );
  eq("同理 lastErrorAt 也缺席", "lastErrorAt" in (ov ?? {}), false);

  // ★ 多带一个 raw 也不该炸 —— 它是无参 handler,不读第二个形参。
  let withRawThrew: string | null = null;
  try {
    await monitoringOverview({ limit: 3 });
  } catch (err) {
    withRawThrew = (err as Error).message;
  }
  eq("★ 被多传一个 raw 也不抛(它根本不读)", withRawThrew, null);

  // 有失败节点、且节点带原因时,lastError* 才该出现 —— 而且取的是**最新那条**
  // 失败运行(顺序里第一个失败者)。这是面板排障唯一的入口。
  appendRunSummary(DATA, {
    runId: "run_newest_failure",
    workflowId: "wf_obs",
    sessionId: "s_chat",
    status: "failed",
    startedAt: 1_800_000_000_000,
    durationMs: 12,
    nodes: [
      { nodeId: "n_ok", kind: "model", status: "success" },
      { nodeId: "n_bad", kind: "model", status: "failed", error: "模型超时" },
    ],
    endedAt: 1_800_000_000_012,
  });
  const ov2 = (await monitoringOverview()) as Record<string, unknown>;
  same(
    "★ 最新那条失败运行里第一个失败节点的原因报出来了",
    [ov2.lastErrorMessage, ov2.lastErrorAt, ov2.totalRuns, ov2.failed],
    ["模型超时", 1_800_000_000_012, 601, 201],
  );
}

/* ──────────────── 5. ★ 采集器只挂一次(本套最关键的一条) ──────────────── */
console.log("\n监控 · 采集器只挂一次");

{
  // `ipc/monitoring.ts` 的模块级标记 `collectorStarted`。重复挂的后果是
  // **同一份事件写两遍盘** —— 用户看到的是每次运行在面板里出现两条一模一样的记录。
  //
  // 判据落在 `mobileEventBus.size` 上:`startMonitoringCollector` 真跑起来就是
  // 往总线上挂一个订阅者,而 `monitoring.ts` 已经注册过一次了(§1 那次)。
  // 所以此刻总线上应当**正好有一个**订阅者。
  eq("注册过一次之后,事件总线上只有一个监控订阅者", mobileEventBus.size, 1);

  const before = readRunSummaries(DATA).length;

  // ★ 再注册一次 —— 模块级标记必须挡住第二次挂载。
  registerMonitoringHandlers(mon.ipc);
  eq("★ 再注册一次,总线上的订阅者数量**没变**", mobileEventBus.size, 1);

  // 把后果也钉住:一次收口事件只许多写一行。
  const runId = "run_from_ipc_smoke";
  mobileEventBus.broadcast({
    type: "workflow.node.progress",
    sessionId: "s_chat",
    runId,
    nodeId: "n1",
    nodeType: "model",
    title: "第一步",
  } as RuntimeEvent);
  mobileEventBus.broadcast({
    type: "workflow.node.result",
    sessionId: "s_chat",
    runId,
    nodeId: "n1",
    nodeType: "model",
    status: "success",
    startedAt: Date.now() - 40,
    endedAt: Date.now(),
  } as unknown as RuntimeEvent);
  mobileEventBus.broadcast({
    type: "turn.done",
    sessionId: "s_chat",
    reason: "end_turn",
    endedAt: Date.now(),
  } as RuntimeEvent);

  const after = readRunSummaries(DATA);
  eq(
    "★ 一次收口在盘上只多了一行(重复挂载就会是两行)",
    after.length,
    before + 1,
  );

  // 而且这一行必须是**handler 交出去的 deps** 跑出来的:
  //   - `root` 指向临时数据根(不然上面的文件路径断言就红了);
  //   - `lookupWorkflowId` 真的查得到会话行 —— 事件本身**不带** workflowId,
  //     这一个是查库来的。给错了这里就是空串。
  eq("★ 收出来的那条是刚喂的这次运行", after[0]?.runId, runId);
  eq("★ workflowId 是 deps 里 lookupWorkflowId 查库查出来的(不是空串)", after[0]?.workflowId, "wf_obs");
  same("★ 节点定案也被记下了", after[0]?.nodes.map((n) => n.nodeId), ["n1"]);
  eq("★ 运行终态按 turn.done 的 reason 定", after[0]?.status, "success");
}

/* ──────────────── 5b. ★ 查不到会话行时不许静默 ──────────────── */

console.log("\n监控 · lookupWorkflowId 出错要留日志(不许静默吞)");

{
  // ★ 这一段钉的是 `ipc/monitoring.ts` 里 `lookupWorkflowId` 的那个 catch
  // (2026-09-20 修)。它吞掉的正是"数据库还没起来"。
  //
  // 用户会看到的现象:启动那几秒里收口的运行,在面板上 `workflowId` 一栏是**空**,
  // 而界面上没有任何东西说"这段时间的监控数据是残的" —— 排障的人只能看到"有几次
  // 运行跟丢了自己的图",查不出为什么。
  //
  // `collector.ts` 的同款 catch 有日志、`store.ts` 的同款 catch 有日志,
  // **只有这一处没有**。修法是把日志补上,口径与那两处一致:
  // 旁路可以带伤继续,但伤情要留在 main.log 里。
  const deps = collectorDeps();
  const before = logLines.length;

  // `getDb()` 在 `initDb()` 没 resolve 之前就抛 —— 这里不能用"删掉会话行"来
  // 制造异常,因为那会返回 undefined 而不是抛(catch 根本不进)。用桩直接让
  // `SessionRepo.get` 抛,模拟的就是数据库没起来那一刻。
  const repo = (await import("@main/store/repositories.js")) as {
    SessionRepo: { get(id: string): unknown };
  };
  const original = repo.SessionRepo.get;
  let rendered: unknown = "没调";
  try {
    repo.SessionRepo.get = () => {
      throw new Error("getDb() called before initDb() resolved");
    };
    rendered = deps.lookupWorkflowId?.("s_chat");
  } finally {
    repo.SessionRepo.get = original;
  }

  eq("★ 查库抛错时 lookupWorkflowId 仍然返回 undefined(不抛给采集器)", rendered, undefined);

  const after = logLines.slice(before);
  const warn = after.find(
    (l) => l.level === "warn" && l.message.includes("工作流 id 查不到"),
  );
  check(
    "★ 但它**留了一行日志**(静默吞掉的话这里什么都没有,数据残了也没人知道)",
    warn !== undefined,
    after,
  );
  check(
    "★ 日志里带上了会话 id(不然排障时不知道是谁的那次运行)",
    warn?.message.includes("s_chat") === true,
    warn,
  );
  check(
    "★ 日志里带上了原始错误(getDb 没起来 / 行被删,原因不一样)",
    warn?.message.includes("before initDb") === true,
    warn,
  );
}

/* ──────────────── 6. 扫描注册表：每个通道都真的走一遍 ──────────────── */

console.log("\n每个通道都真的走一遍(扫注册表,不手抄清单)");

{
  // 不手抄渠道清单 —— 从注册表里扫**全部**通道。`handle` 的 listener 形参个数
  // 就是判据:无参 handler 写的是 `async () => …`(length 0),收 raw 的写的是
  // `async (_evt, raw) => …`(length 2)。新加一条通道却忘了在这套里走一遍,
  // 会因为"扫到了但没走"而 FAIL —— 手抄清单的断言漏得掉新通道,这一条漏不掉。
  const noArg = [...mon.handlers.entries()].filter(([, fn]) => fn.length === 0);
  const withRaw = [...mon.handlers.entries()].filter(([, fn]) => fn.length > 0);

  eq("监控这边注册进去的通道一共两个", mon.handlers.size, 2);
  same(
    "一个是无参 handler(overview),一个是收 raw 的(runs)",
    [noArg.length, withRaw.length],
    [1, 1],
  );
  same(
    "无参的那个正是 overview — 「无参 handler 不接 raw」这条纪律的运行时证据",
    noArg.map(([c]) => c),
    [IPC.MONITORING_OVERVIEW],
  );
  same("收 raw 的那个正是 runs", withRaw.map(([c]) => c), [IPC.MONITORING_RUNS]);

  // 扫到的两个都已经被 §1–§5 真的调用过了(上面每一条断言的入参都取自适应
  // 变量,不是从清单里抄的)。这里再各自走一次最小调用,保证"扫到的都走过"
  // 这件事本身有一行断言,而不是靠读者去数上面的段落。
  const ov = (await monitoringOverview()) as { totalRuns?: number };
  const rows = (await monitoringRuns({ limit: 2 })) as unknown[];
  same(
    "扫到的两个通道都能真的调用并回出形状对的结果",
    [typeof ov?.totalRuns, Array.isArray(rows)],
    ["number", true],
  );
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\nobservability-ipc-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
