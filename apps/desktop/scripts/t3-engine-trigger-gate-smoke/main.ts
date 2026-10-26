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
    // 【Q5】手动入口不再回"由 Node-RED 引擎管理"那句 —— 它**转发到引擎**：
    // 用户在设置里点「立刻运行一次」是他唯一的手动入口，拒绝它等于删掉这个功能。
    // 无头套件里没有 EngineRuntime，所以这里可观测到的是引擎侧那句"未就绪"。
    //
    // ⚠️ 判据**不能**写成「包含 '未就绪'」就完事：那句话也可能是任何别的路径给的。
    // 这里同时钉住「旧 runner 没有自己起一次运行」—— 转发 / 拒绝都行，**自己跑不行**。
    const now = await r2.runNow(wfCron, "t_cron");
    check("runNow 对 node-red 图转发到引擎（不是旧 runner 自己跑）",
      now.ok === false && (now.error ?? "").includes("Node-RED"), now);
    const target = await r2.runWithTarget(wfFile, "t_file", { files: [join(NR_DIR, "gate-nr.md")] });
    check("runWithTarget 对 node-red 图同样转发到引擎",
      target.ok === false && (target.error ?? "").includes("Node-RED"), target);
    eq("手动入口拒绝之后没有任何运行", runs.length, 0);
  } finally {
    r2.dispose();
  }
  resetRuns();
}

/* ── ② 无 engine 的历史（用户）图：旧执行器同样不再代跑，事实表给迁移提示 ── */

console.log("\n② 无 engine 的历史（用户）图：旧执行器同样不再装监听，事实表说「请迁移」");
{
  const wfLegacy = "wf_t3_legacy_cron";
  saveDoc({
    id: wfLegacy,
    // 故意不写 engine —— 历史存档的形状。产品决定是**用户图统一到 Node-RED**，
    // 所以它和显式 node-red 的图一样不归旧执行器；差别只在事实表那句话
    // （迁移提示 vs「由引擎管理」），因为只有前者需要用户动手。
    nodes: [triggerNode("t_legacy_solo", {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: LEGACY_PROJECT,
      task: "历史图该被提示迁移",
    })],
  });
  const minute = 21_000_000;
  const at = minute * 60_000;
  const r = newRunner();
  resetRuns();
  try {
    await withClockAsync(at, () => r.start());
    eq("历史图：启动那一跳 0 次（旧执行器不再代跑用户图）", runsOfNode("t_legacy_solo").length, 0);
    withClock(at + 20_000, () => r.onTick());
    eq("历史图：同一分钟第二跳仍然 0 次", runsOfNode("t_legacy_solo").length, 0);
    check("历史图没有进入旧的触发器表", !r.entries.has(wfLegacy), [...r.entries.keys()]);
    const facts = r.statusOf(wfLegacy);
    // 事实表**必须留一行**：静默消失会让用户以为"这条自动化好好的"。
    check("历史图在事实表里留了一行（不静默消失）", facts.length === 1, facts);
    eq("历史图 armed=false（没有旧监听在跑）", facts[0]?.armed, false);
    check("历史图的事实是「请迁移到 Node-RED」那句话",
      (facts[0]?.detail ?? "").includes("请在设置 → 工作流里把它迁移过去"), facts[0]);
  } finally {
    r.dispose();
  }
  resetRuns();
}

/* ── ③ 重启不复活：旧去重记录里的 node-red 条目被清掉，第二个进程也不装监听 ── */

console.log("\n③ 重启：node-red 图与历史用户图的旧去重记录都被清掉，第二个进程也不装监听");
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
    eq("重启 #1：历史用户图同样 0 次", runsOfNode("t_legacy_restart").length, 0);
    const disk = JSON.parse(SettingRepo.get("automation.lastMinute") ?? "{}") as Record<string, number>;
    check("node-red 图的旧去重记录被清掉（残留不复活）", disk[`${wfNR}:t_nr`] === undefined, disk);
    // 【Q5】历史用户图也不再由旧执行器跑，所以它那一格旧去重记录同样该被清掉 ——
    // 保留一格永远不再被读的记录，只会在节点 id 被复用时撞出一个假「这一分钟跑过了」。
    eq("历史用户图的旧去重记录同样被清掉", disk[`${wfLegacy}:t_legacy_restart`], undefined);
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
    eq("重启 #2：历史用户图下一分钟仍然 0 次", runsOfNode("t_legacy_restart").length, 0);
    eq("重启 #2：历史用户图也没有进入旧表", r2.entries.has(wfLegacy), false);
    eq("重启 #2：node-red 图仍未进入旧表", r2.entries.has(wfNR), false);
  } finally {
    r2.dispose();
  }
  resetRuns();
}

/* ── ④ 迁移那一刻：事实表从「请迁移」翻到「由引擎管理」，且全程不派发 ── */

console.log("\n④ 历史图迁到 node-red：事实表翻页（请迁移 → 由引擎管理），全程 0 派发");
{
  const wf = "wf_t3_late_switch";
  const nodeId = "t_late";
  saveDoc({
    id: wf,
    nodes: [triggerNode(nodeId, {
      [NODE_TRIGGER_KIND_PARAM_KEY]: "schedule",
      [NODE_TRIGGER_CRON_PARAM_KEY]: EVERY_MINUTE,
      [NODE_TRIGGER_PROJECT_PARAM_KEY]: LEGACY_PROJECT,
      task: "迁移前后都不该由旧 runner 跑",
    })],
  });
  const minute = 23_000_000;
  const at = minute * 60_000;
  const registry = new ExecutorOwnershipRegistry(new InMemoryExecutorOwnershipStore());
  const r = newRunner(registry);
  resetRuns();
  try {
    await withClockAsync(at, () => r.start());
    // 【Q5】旧执行器对用户图**一条监听都不装**（①②③ 已证），所以这里不再有
    // "先装上、晚到再拒绝"那个窗口 —— 改测**迁移那一刻用户看到的话术翻转**。
    eq("迁移前：启动那一跳 0 次", runsOfNode(nodeId).length, 0);
    check("迁移前：触发器不在旧表里", !r.entries.has(wf), [...r.entries.keys()]);
    const before = r.statusOf(wf);
    check("迁移前事实是「请迁移到 Node-RED」",
      (before[0]?.detail ?? "").includes("请在设置 → 工作流里把它迁移过去"), before[0]);

    // 模拟"已存盘切到 node-red、reload 还没落地"：直接改库里的 engine（不走 saveWorkflow
    // 的切换体检 —— 这一格要测的是旧执行器读到新归属之后的表现）。
    const switched = WorkflowRepo.get(wf)!.doc;
    WorkflowRepo.save({ ...switched, engine: "node-red", updatedAt: Date.now() });

    resetRuns();
    withClock((minute + 1) * 60_000, () => r.onTick());
    eq("迁移后的 tick：一次都没派发", runsOfNode(nodeId).length, 0);
    eq("迁移全程不动 owner 账本（旧执行器从未 claim）", registry.executorOwnerOf(wf), null);

    // 真正的 reload 落地：事实表跟着翻到「由引擎管理」。
    await r.reload(wf);
    check("reload 之后旧表里仍然没有这条触发器", !r.entries.has(wf), [...r.entries.keys()]);
    const after = r.statusOf(wf);
    check("迁移后事实翻成「由 Node-RED 引擎管理」",
      (after[0]?.detail ?? "").includes(OWNED_DETAIL), after[0]);
    resetRuns();
    withClock((minute + 2) * 60_000, () => r.onTick());
    eq("reload 之后再下一分钟：仍然 0 次", runsOfNode(nodeId).length, 0);
  } finally {
    r.dispose();
  }
  resetRuns();
}

/* ── ⑤ 同一库里两种归属的文件图：一个 watcher 都不装 ── */

console.log("\n⑤ 同一数据根混排：node-red 图与历史用户图都不装 watcher");
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
      task: "历史用户图，旧执行器也不再装监听",
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
    // 【Q5】两种归属都不归旧执行器 —— 曾经的对照（"legacy 照装"）已不成立。
    check("历史用户图的项目目录没有 watcher", !r.watchers.has(LEGACY_DIR), [...r.watchers.keys()]);
    check("node-red 文件图的项目目录没有 watcher", !r.watchers.has(NR_DIR), [...r.watchers.keys()]);

    writeFileSync(join(LEGACY_DIR, "gate-legacy.md"), "# 历史用户图：不该跑");
    await sleep(FILE_SETTLE_SLACK_MS);
    eq("历史用户图文件触发器 0 次", runsOfNode("t_legacy_file").length, 0);

    writeFileSync(join(NR_DIR, "gate-nr-mixed.md"), "# node-red 不该跑");
    await sleep(FILE_SETTLE_SLACK_MS);
    eq("node-red 文件触发器 0 次", runsOfNode("t_nr_file").length, 0);
  } finally {
    r.dispose();
  }
  resetRuns();
}

/* ── ⑥ owner 冲突闸门没有因为引擎门而失效（legacy 图被 node-red 占用时照样拒绝） ── */

console.log("\n⑥ 历史图被 node-red 登记 owner 时：旧 runner 不派发、也不覆盖那条登记");
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
    // 【Q5】旧执行器对用户图**连监听都不装**，所以它不会再走到"派发时撞上 owner 冲突"
    // 那一步 —— 这一格现在验的是**账本没被动过**（旧执行器没有用 mcode 覆盖 node-red），
    // 以及事实表仍然给了用户一句可读的话（不是静默）。
    const facts = r.statusOf(wf);
    check("事实表留了一行且给了可读原因",
      facts.length === 1 && (facts[0]?.detail ?? "").length > 0, facts);
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
    // 【Q5】归 mcode 的用户图**也不再**由旧 runner 装监听。`legacy` 这个字段名现在
    // 只剩历史含义：它永远为 false。判据改看 `owner` —— 那才是"这句话该怎么说"的依据。
    eq("mcode → owner 是 mcode（事实表会给迁移提示）", probe.legacyTriggerOwnerOf({ engine: "mcode" }).owner, "mcode");
    eq("缺省 engine → owner 也是 mcode（历史图按用户图处理）", probe.legacyTriggerOwnerOf({}).owner, "mcode");
    eq("node-red → owner 是 node-red", probe.legacyTriggerOwnerOf({ engine: "node-red" }).owner, "node-red");
    // 负控：`legacy` 退化成恒真会让「一条监听都不装」那半边全绿而实际全在跑。
    eq("★ 负控：任何归属下 legacy 都不为 true",
      [probe.legacyTriggerOwnerOf({}), probe.legacyTriggerOwnerOf({ engine: "mcode" }),
       probe.legacyTriggerOwnerOf({ engine: "node-red" }), probe.legacyTriggerOwnerOf({ engine: "agent-x" })]
        .filter((r) => r.legacy === true).length, 0);
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
