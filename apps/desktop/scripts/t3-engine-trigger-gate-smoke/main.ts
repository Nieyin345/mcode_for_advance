/**
 * T3｜Node-RED 工作流触发器单一归属门禁 —— 回归网。
 *
 * ## 它要钉住的那件事
 *
 * T14 基线：旧 `automationRunner.buildTriggers` 完全不看 `doc.engine`，`engine=node-red`
 * 的图照样被装上 cron 计时与 `fs.watch` 目录监听，与 Node-RED 自己的 inject / watch
 * **并行监听**；只是在派发前被 owner claim 与 `runner.ts` 的 assert 挡下（下游兜底）。
 *
 * 本套用**真实触发次数**证明这件事：
 *  - 冻结时钟后对 `onTick` 跑命中的分钟 → 数 `startWorkflowRun` 的调用；
 *  - 在项目目录里真写一个文件、走真 `fs.watch` → 等合并窗口收口，再数调用；
 *  - 用 `runtimeManager.emit` 推一条事件 → 数调用。
 *
 * 修复前（HEAD）这三路都会各自起一次运行；修复后一条都不能起，而且监听根本没挂
 * （`watchers` / `entries` 也断言）。**legacy 图（无 engine 标记）照旧运行** —— 这半边
 * 断言同时守着"别把旧图一起关掉"。
 *
 * ## 时钟与数据根
 *
 *  - 时钟：定时那一路的判据是"哪一分钟"，真拿 `new Date()` 跑会跨分钟漂移。冻结时钟
 *    的做法与 `automation-smoke` 第 13 节同一条（本地构造 `Date`）。
 *  - 数据根：`start()` 会写 settings（`SettingRepo.set` 内部 `persist()` 重写**整个**
 *    `mcode.db`）。`run.sh` 用 `mktemp -d` 指给 `MCODE_SMOKE_DATA_ROOT`；桩没设就抛。
 *
 * ## 为什么 `new` 执行器而不是用单例
 *
 * 单例在 `main/index.ts` 里由真实进程启动。这里从单例原型上拿构造器，`new` 出独立的
 * 实例 —— 被测的是**真实的那个类**，而每个场景互不串状态（`entries` / `watchers` /
 * `pendingFires` 全是实例字段）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  NODE_TRIGGER_CRON_PARAM_KEY,
  NODE_TRIGGER_DEBOUNCE_PARAM_KEY,
  NODE_TRIGGER_EVENTS_PARAM_KEY,
  NODE_TRIGGER_KIND_PARAM_KEY,
  NODE_TRIGGER_PATHS_PARAM_KEY,
  NODE_TRIGGER_PROJECT_PARAM_KEY,
} from "@contracts/nodeType";
import type { RuntimeEvent } from "@contracts/runtime";
import type { WorkflowDoc, WorkflowNode } from "@contracts/workflow";
import { automationRunner } from "@main/orchestration/automationRunner.js";
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, SettingRepo, WorkflowRepo } from "@main/store/repositories.js";
import {
  ExecutorOwnershipRegistry,
  InMemoryExecutorOwnershipStore,
} from "@main/workflowEngines/executorOwnership.js";
import { resetRuns, runs, runsOfNode } from "./stubs/runner.js";
import { runtimeManager } from "./stubs/runtimeManager.js";

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

/* ────────────────────────── 执行器内部表面 ────────────────────────── */

interface RunnerInternals {
  start(): Promise<void>;
  reload(workflowId: string): Promise<void>;
  dispose(): void;
  onTick(): void;
  onFsChange(dir: string, filename: string | null, eventType?: string | null): void;
  runNow(workflowId: string, triggerNodeId: string): Promise<{ ok: boolean; error?: string }>;
  runWithTarget(
    workflowId: string,
    triggerNodeId: string,
    target: { files: readonly string[] },
  ): Promise<{ ok: boolean; error?: string }>;
  statusOf(workflowId: string): Array<{ armed?: boolean; enabled?: boolean; detail?: string; lastError?: string }>;
  setExecutorOwnership(registry: ExecutorOwnershipRegistry | null): void;
  entries: Map<string, unknown[]>;
  watchers: Map<string, unknown>;
  pendingFires: Map<string, unknown>;
}

const RunnerCtor = Object.getPrototypeOf(automationRunner).constructor as new () => RunnerInternals;

/** 冻结 `Date`，跑完恢复（与 `automation-smoke` 同一手法）。 */
async function withClockAsync<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const Real = Date;
  const Frozen = function (...args: unknown[]): Date {
    if (args.length === 0) return new Real(ms);
    return new (Real as unknown as new (...a: unknown[]) => Date)(...args);
  };
  (Frozen as unknown as { now: () => number }).now = () => ms;
  (globalThis as unknown as { Date: typeof Date }).Date = Frozen as unknown as typeof Date;
  try {
    return await fn();
  } finally {
    (globalThis as unknown as { Date: typeof Date }).Date = Real;
  }
}

function withClock<T>(ms: number, fn: () => T): T {
  const Real = Date;
  const Frozen = function (...args: unknown[]): Date {
    if (args.length === 0) return new Real(ms);
    return new (Real as unknown as new (...a: unknown[]) => Date)(...args);
  };
  (Frozen as unknown as { now: () => number }).now = () => ms;
  (globalThis as unknown as { Date: typeof Date }).Date = Frozen as unknown as typeof Date;
  try {
    return fn();
  } finally {
    (globalThis as unknown as { Date: typeof Date }).Date = Real;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 文件事件从到达、到收口后再 fire 的等待上限（实现是 300ms settle + debounce）。 */
const FILE_SETTLE_SLACK_MS = 1500;

/* ────────────────────────── 夹具 ────────────────────────── */

const EVERY_MINUTE = "* * * * *";
const DATA_ROOT = process.env.MCODE_SMOKE_DATA_ROOT ?? ".";
const NR_DIR = join(DATA_ROOT, "t3-node-red-owned");
const LEGACY_DIR = join(DATA_ROOT, "t3-legacy-owned");

function triggerNode(id: string, params: Record<string, unknown>): WorkflowNode {
  return { id, type: "mcode.trigger", title: "触发器", params, position: { x: 0, y: 0 } };
}

function saveDoc(args: {
  id: string;
  engine?: WorkflowDoc["engine"];
  nodes: WorkflowNode[];
}): void {
  const doc: WorkflowDoc = {
    id: args.id,
    ...(args.engine !== undefined ? { engine: args.engine } : {}),
    name: `T3 冒烟 ${args.id}`,
    builtin: false,
    updatedAt: Date.now(),
    nodes: args.nodes,
    edges: [],
  };
  WorkflowRepo.save(doc);
}

let projSeq = 0;
function ensureProject(name: string, path: string): string {
  projSeq += 1;
  const id = `p_t3_${projSeq}`;
  const now = Date.now();
  ProjectRepo.create({
    id,
    name,
    path,
    archived: false,
    group: null,
    sortOrder: 0,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function newRunner(registry?: ExecutorOwnershipRegistry): RunnerInternals {
  const r = new RunnerCtor();
  r.setExecutorOwnership(registry ?? new ExecutorOwnershipRegistry(new InMemoryExecutorOwnershipStore()));
  return r;
}

const downloadEvent = (itemId: string): RuntimeEvent =>
  ({
    type: "library.item.downloaded",
    sessionId: "t3-event-source",
    itemId,
    title: itemId,
    pdfPath: `papers/${itemId}.pdf`,
  }) as unknown as RuntimeEvent;

/* ────────────────────────── 场景 ────────────────────────── */

await initDb();
mkdirSync(NR_DIR, { recursive: true });
mkdirSync(LEGACY_DIR, { recursive: true });
const NR_PROJECT = ensureProject("T3 Node-RED 项目", NR_DIR);
const LEGACY_PROJECT = ensureProject("T3 旧图项目", LEGACY_DIR);

const OWNED_DETAIL = "由 Node-RED 引擎管理";

/* ── ① node-red 图：定时 / 文件 / 事件三条触发一条都不许装、一次都不许起 ── */

console.log("\n① engine=node-red：旧 runner 不装监听、不起运行（真实触发次数）");
{
  const wfCron = "wf_t3_nr_cron";
  const wfFile = "wf_t3_nr_file";
  const wfEvent = "wf_t3_nr_event";
  saveDoc({
    id: wfCron,
    engine: "node-red",
    nodes: [triggerNode("t_cron", {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: LEGACY_PROJECT,
      task: "Node-RED 拥有的定时器不该由旧 runner 跑",
    })],
  });
  saveDoc({
    id: wfFile,
    engine: "node-red",
    nodes: [triggerNode("t_file", {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
      [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: NR_PROJECT,
      task: "Node-RED 拥有的文件监听不该由旧 runner 装",
    })],
  });
  saveDoc({
    id: wfEvent,
    engine: "node-red",
    nodes: [triggerNode("t_event", {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "event",
      [NODE_TRIGGER_EVENTS_PARAM_KEY]: "library.item.downloaded",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: NR_PROJECT,
      task: "Node-RED 拥有的事件触发不该由旧 runner 订阅",
    })],
  });

  const minute = 20_000_000;
  const at = minute * 60_000;
  const registry = new ExecutorOwnershipRegistry(new InMemoryExecutorOwnershipStore());
  const r = newRunner(registry);
  resetRuns();
  try {
    // start() 会当场 tick 一次（MC-021）—— 冻结时钟后启动，启动那一跳就落在本分钟。
    await withClockAsync(at, () => r.start());

    check("node-red 定时图没有进入旧的触发器表", !r.entries.has(wfCron), [...r.entries.keys()]);
    check("node-red 文件图没有进入旧的触发器表", !r.entries.has(wfFile), [...r.entries.keys()]);
    check("node-red 事件图没有进入旧的触发器表", !r.entries.has(wfEvent), [...r.entries.keys()]);
    check("node-red 文件图的目录没有装 fs.watch", !r.watchers.has(NR_DIR), [...r.watchers.keys()]);
    eq("启动 + 本分钟 tick：node-red 定时器一次都没起", runsOfNode("t_cron").length, 0);

    withClock(at + 20_000, () => r.onTick());
    withClock((minute + 1) * 60_000, () => r.onTick());
    eq("同一分钟第二跳 + 下一分钟：node-red 定时器仍然 0 次", runsOfNode("t_cron").length, 0);

    // 真 fs.watch：往 node-red 图的项目目录写一个匹配 glob 的文件，等收口。
    writeFileSync(join(NR_DIR, "gate-nr.md"), "# 这个目录归 Node-RED，不该叫醒旧 runner");
    await sleep(FILE_SETTLE_SLACK_MS);
    eq("真文件事件收口后：node-red 文件触发器 0 次", runsOfNode("t_file").length, 0);
    check("node-red 文件触发器没有攒出待派发批次", !r.pendingFires.has(`${wfFile}:t_file`), [...r.pendingFires.keys()]);

    // 真事件流：推一条它订阅的事件，等合并窗口（debounce 0）。
    runtimeManager.emit(downloadEvent("t3-nr-event"));
    await sleep(200);
    eq("真事件投递后：node-red 事件触发器 0 次", runsOfNode("t_event").length, 0);
    check("node-red 事件触发器没有攒出待派发批次", !r.pendingFires.has(`${wfEvent}:t_event`), [...r.pendingFires.keys()]);

    // 事实表要说出"由 Node-RED 管理"，不能让用户看到一条静默失联的自动化。
    const cronFacts = r.statusOf(wfCron);
    check("事实表为 node-red 触发器留了一行（不静默消失）", cronFacts.length === 1, cronFacts);
    check("事实说「由 Node-RED 引擎管理」", cronFacts[0]?.detail?.includes(OWNED_DETAIL) === true, cronFacts[0]);
    eq("node-red 触发器 armed=false（没有旧监听在跑）", cronFacts[0]?.armed, false);
    eq("node-red 触发器 enabled=true（用户开着的，是引擎在管）", cronFacts[0]?.enabled, true);

    // owner 账本必须干净：一次派发都没尝试过，就绝不能登记 mcode。
    eq("node-red 图从未被登记为 mcode owner", registry.executorOwnerOf(wfCron), null);
    eq("node-red 图从未被登记为 mcode owner（文件图）", registry.executorOwnerOf(wfFile), null);
    check("node-red 侧此刻可以正常登记 owner", registry.claim(wfCron, "node-red", { reason: "T3 冒烟：引擎接管" }).ok === true);
  } finally {
    r.dispose();
  }
  // dispose 只释放自己 claim 过的 —— node-red 的登记不许被偷走。
  eq("dispose 不会释放 node-red 的登记", registry.executorOwnerOf(wfCron), "node-red");

  // 手动入口：同样在入口就说清楚，而不是建会话、claim、到最后 assert 才失败。
  const r2 = newRunner();
  try {
    const now = await r2.runNow(wfCron, "t_cron");
    check("runNow 对 node-red 图返回可读拒绝", now.ok === false && (now.error ?? "").includes(OWNED_DETAIL), now);
    const target = await r2.runWithTarget(wfFile, "t_file", { files: [join(NR_DIR, "gate-nr.md")] });
    check("runWithTarget 对 node-red 图同样拒绝", target.ok === false && (target.error ?? "").includes(OWNED_DETAIL), target);
    eq("手动入口拒绝之后没有任何运行", runs.length, 0);
  } finally {
    r2.dispose();
  }
  resetRuns();
}

/* ── ② 无 engine 的历史图必须照旧运行（不能把旧图一起关掉） ── */

console.log("\n② 无 engine 的历史图：行为不变（定时照跑、同分钟只一次）");
{
  const wfLegacy = "wf_t3_legacy_cron";
  saveDoc({
    id: wfLegacy,
    // 故意不写 engine —— 历史存档的形状。
    nodes: [triggerNode("t_legacy_solo", {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: LEGACY_PROJECT,
      task: "历史图照旧运行",
    })],
  });
  const minute = 21_000_000;
  const at = minute * 60_000;
  const r = newRunner();
  resetRuns();
  try {
    await withClockAsync(at, () => r.start());
    eq("启动即本分钟：历史图起了 1 次", runsOfNode("t_legacy_solo").length, 1);
    withClock(at + 20_000, () => r.onTick());
    eq("同一分钟第二跳：仍然只 1 次（去重不变）", runsOfNode("t_legacy_solo").length, 1);
    check("历史图在旧触发器表里（引擎判据没有误伤）", r.entries.has(wfLegacy), [...r.entries.keys()]);
    const facts = r.statusOf(wfLegacy);
    check("历史图事实是 armed（不是 node-red 那一行）", facts[0]?.armed === true, facts[0]);
  } finally {
    r.dispose();
  }
  resetRuns();
}

/* ── ③ 重启不复活：旧去重记录里的 node-red 条目被清掉，第二个进程也不装监听 ── */

console.log("\n③ 重启：旧状态残留不复活双监听，legacy 的去重照旧跨重启");
{
  const wfNR = "wf_t3_nr_restart";
  const wfLegacy = "wf_t3_legacy_restart";
  saveDoc({
    id: wfNR,
    engine: "node-red",
    nodes: [triggerNode("t_nr", {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: LEGACY_PROJECT,
      task: "重启后也不该由旧 runner 跑",
    })],
  });
  saveDoc({
    id: wfLegacy,
    nodes: [triggerNode("t_legacy_restart", {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: LEGACY_PROJECT,
      task: "重启去重",
    })],
  });

  const minute = 22_000_000;
  const at = minute * 60_000;
  // 模拟旧版本留下的残留：node-red 图与 legacy 图在上一进程都记过这一分钟。
  SettingRepo.set("automation.lastMinute", JSON.stringify({
    [`${wfNR}:t_nr`]: minute,
    [`${wfLegacy}:t_legacy_restart`]: minute,
  }));

  const r1 = newRunner();
  resetRuns();
  try {
    await withClockAsync(at, () => r1.start());
    eq("重启 #1：node-red 定时器 0 次", runsOfNode("t_nr").length, 0);
    eq("重启 #1：legacy 去重仍跨重启（本分钟不再跑）", runsOfNode("t_legacy_restart").length, 0);
    const disk = JSON.parse(SettingRepo.get("automation.lastMinute") ?? "{}") as Record<string, number>;
    check("node-red 图的旧去重记录被清掉（残留不复活）", disk[`${wfNR}:t_nr`] === undefined, disk);
    eq("legacy 图的去重记录保留", disk[`${wfLegacy}:t_legacy_restart`], minute);
  } finally {
    r1.dispose();
  }

  const r2 = newRunner();
  resetRuns();
  try {
    await withClockAsync(at, () => r2.start());
    eq("重启 #2：node-red 定时器仍 0 次", runsOfNode("t_nr").length, 0);
    withClock((minute + 1) * 60_000, () => r2.onTick());
    eq("重启 #2：下一分钟 node-red 定时器仍 0 次", runsOfNode("t_nr").length, 0);
    eq("重启 #2：legacy 图下一分钟照跑 1 次", runsOfNode("t_legacy_restart").length, 1);
    eq("重启 #2：node-red 图仍未进入旧表", r2.entries.has(wfNR), false);
  } finally {
    r2.dispose();
  }
  resetRuns();
}

/* ── ④ 晚到的旧计时器：图在 reload 之前被切到 node-red，派发那一刻必须拒绝 ── */

console.log("\n④ 切换引擎后的晚到触发：派发时再核一次，不派发也不登记 owner");
{
  const wf = "wf_t3_late_switch";
  const nodeId = "t_late";
  saveDoc({
    id: wf,
    nodes: [triggerNode(nodeId, {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: LEGACY_PROJECT,
      task: "切换前安装、切换后晚到",
    })],
  });
  const minute = 23_000_000;
  const at = minute * 60_000;
  const registry = new ExecutorOwnershipRegistry(new InMemoryExecutorOwnershipStore());
  const r = newRunner(registry);
  resetRuns();
  try {
    await withClockAsync(at, () => r.start());
    eq("夹具：启动这一跳 legacy 图跑过 1 次", runsOfNode(nodeId).length, 1);
    check("夹具：触发器已装进旧表", r.entries.has(wf), [...r.entries.keys()]);

    // 模拟"已存盘切到 node-red、reload 还没落地"：直接改库里的 engine（不走 saveWorkflow
    // 的切换体检 —— 这一格要测的是旧执行器晚到的那一下）。
    const switched = WorkflowRepo.get(wf)!.doc;
    WorkflowRepo.save({ ...switched, engine: "node-red", updatedAt: Date.now() });

    resetRuns();
    withClock((minute + 1) * 60_000, () => r.onTick());
    eq("切换后的晚到 tick：一次都没派发", runsOfNode(nodeId).length, 0);
    eq("晚到拒绝不动 owner 账本（没有留下 mcode 登记）", registry.executorOwnerOf(wf), null);
    const facts = r.statusOf(wf);
    check("晚到拒绝写进事实（界面可见）", facts.some((f) => (f.lastError ?? "").includes(OWNED_DETAIL)), facts);

    // 随后真正的 reload 落地：旧表里的触发器被摘掉。
    await r.reload(wf);
    check("reload 之后旧表里不再有这条触发器", !r.entries.has(wf), [...r.entries.keys()]);
    resetRuns();
    withClock((minute + 2) * 60_000, () => r.onTick());
    eq("reload 之后再下一分钟：仍然 0 次", runsOfNode(nodeId).length, 0);
  } finally {
    r.dispose();
  }
  resetRuns();
}

/* ── ⑤ 同一库里 legacy 文件监听正常、node-red 文件监听不装 ── */

console.log("\n⑤ 同一数据根混排：legacy 文件监听照装照跑，node-red 目录一个 watcher 都没有");
{
  const wfLegacyFile = "wf_t3_legacy_file";
  const wfNRFile = "wf_t3_nr_file_mixed";
  saveDoc({
    id: wfLegacyFile,
    nodes: [triggerNode("t_legacy_file", {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
      [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: LEGACY_PROJECT,
      task: "legacy 文件触发照旧",
    })],
  });
  saveDoc({
    id: wfNRFile,
    engine: "node-red",
    nodes: [triggerNode("t_nr_file", {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "file",
      [NODE_TRIGGER_PATHS_PARAM_KEY]: "*.md",
      [NODE_TRIGGER_DEBOUNCE_PARAM_KEY]: 0,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: NR_PROJECT,
      task: "node-red 文件触发不该装",
    })],
  });

  const r = newRunner();
  resetRuns();
  try {
    await r.start();
    check("legacy 文件图的项目目录装了 watcher", r.watchers.has(LEGACY_DIR), [...r.watchers.keys()]);
    check("node-red 文件图的项目目录没有 watcher", !r.watchers.has(NR_DIR), [...r.watchers.keys()]);

    writeFileSync(join(LEGACY_DIR, "gate-legacy.md"), "# legacy 该跑");
    await sleep(FILE_SETTLE_SLACK_MS);
    eq("legacy 文件触发器真的起了 1 次", runsOfNode("t_legacy_file").length, 1);

    writeFileSync(join(NR_DIR, "gate-nr-mixed.md"), "# node-red 不该跑");
    await sleep(FILE_SETTLE_SLACK_MS);
    eq("node-red 文件触发器 0 次", runsOfNode("t_nr_file").length, 0);
  } finally {
    r.dispose();
  }
  resetRuns();
}

/* ── ⑥ owner 冲突闸门没有因为引擎门而失效（legacy 图被 node-red 占用时照样拒绝） ── */

console.log("\n⑥ legacy 图被 node-red 登记 owner 时：旧 runner 仍然拒绝派发");
{
  const wf = "wf_t3_conflict_legacy";
  saveDoc({
    id: wf,
    nodes: [triggerNode("t_conflict", {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: LEGACY_PROJECT,
      task: "被另一端占用时拒绝",
    })],
  });
  const minute = 24_000_000;
  const at = minute * 60_000;
  const store = new InMemoryExecutorOwnershipStore();
  const registry = new ExecutorOwnershipRegistry(store);
  registry.claim(wf, "node-red", { reason: "T3：模拟引擎已接管" });
  const r = newRunner(registry);
  resetRuns();
  try {
    await withClockAsync(at, () => r.start());
    eq("owner 冲突：一次都没派发", runsOfNode("t_conflict").length, 0);
    const facts = r.statusOf(wf);
    check("owner 冲突写进事实并点名 node-red", facts.some((f) => (f.lastError ?? "").includes("node-red") || (f.lastError ?? "").includes("另一个")), facts);
    eq("冲突不覆盖：owner 仍是 node-red", registry.executorOwnerOf(wf), "node-red");
  } finally {
    r.dispose();
  }
  eq("dispose 不会偷走 node-red 的登记", registry.executorOwnerOf(wf), "node-red");
  resetRuns();
}

/* ── ⑦ 未知引擎值：判据 fail-closed（私有判据直测 + 存储层坏档既有行为说明） ── */

console.log("\n⑦ 未知 engine：fail-closed（不把它当 mcode 装监听）");
{
  interface OwnerProbe {
    legacyTriggerOwnerOf(doc: { engine?: unknown }): { legacy: boolean; owner?: string };
  }
  const probe = newRunner() as unknown as OwnerProbe;
  try {
    const unknown = probe.legacyTriggerOwnerOf({ engine: "agent-x" });
    eq("未知 engine → 不归旧 runner", unknown.legacy, false);
    eq("未知 engine → 判成 unknown（不是 mcode、也不是 node-red）", unknown.owner, "unknown");
    eq("mcode → 归旧 runner", probe.legacyTriggerOwnerOf({ engine: "mcode" }).legacy, true);
    eq("缺省 engine → 归旧 runner（历史图兼容）", probe.legacyTriggerOwnerOf({}).legacy, true);
    eq("node-red → 不归旧 runner", probe.legacyTriggerOwnerOf({ engine: "node-red" }).legacy, false);
  } finally {
    (probe as unknown as RunnerInternals).dispose();
  }
  // 存储层的第二道：库里存了契约之外的 engine，读行时 `parseWorkflowDoc` 直接判坏档 —
  // 坏档不会变成"空文档"流进 buildTriggers（`getWorkflow` 抛错，由既有坏档路径显式报出）。
  let rejected = false;
  try {
    WorkflowRepo.save({
      id: "wf_t3_corrupt_engine",
      name: "坏引擎",
      builtin: false,
      updatedAt: Date.now(),
      nodes: [],
      edges: [],
      engine: "agent-x",
    } as unknown as WorkflowDoc);
    WorkflowRepo.get("wf_t3_corrupt_engine");
  } catch {
    rejected = true;
  }
  check("契约外 engine 若真进了库，读取层判坏档（不让它流进触发器安装）", rejected);
}

console.log(`\nt3-engine-trigger-gate-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
