/**
 * Headless smoke for **监控采集**(v2 计划 §4-G6:main/monitoring 三件套)。
 *
 * ## 它验的是什么
 *
 *  1. **事件流 → 摘要**:喂假事件(progress → result → turn.done),一条
 *     `success` 运行收出来的 summary 里 workflowId / status / 每步的耗时都对;
 *  2. **overview 数字**:totalRuns / succeeded / failed / avgDurationMs /
 *     lastError* 从存储现算,失败运行的样子(lastErrorMessage)也认得出;
 *  3. **NDJSON 持久化可重读**:写的行 JSON 往返不丢字段;坏行(半截 JSON、
 *     缺字段)跳过不炸;同一个 runId 两条取最新(续跑的形状);
 *  4. **采集器异常不外抛**:畸形事件、lookup 抛错 —— 全都只配一行日志,
 *     决不能把调用方(bus 的订阅者循环、工作流运行本体)带下去。
 *
 * 两条事件路径都要过:**直接 handle**(无头脚本最短路径)与
 * **startMonitoringCollector 经 mobileEventBus**(生产的真实接线 —— 节点事件
 * 只广播到这条总线,`runtimeManager.subscribe` 的观察者收不到)。
 *
 * 它不碰用户真正的数据根:数据根由 deps 注入,mktemp 建的目录,跑完就删。
 *
 * Run: scripts/monitoring-smoke/run.sh
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@contracts/runtime";
import { mobileEventBus } from "@main/mobile/MobileEventBus.js";
import { MonitoringCollector, startMonitoringCollector } from "@main/monitoring/collector.js";
import { appendRunSummary, readRunSummaries } from "@main/monitoring/store.js";
import { aggregateOverview } from "@main/monitoring/aggregate.js";

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 事件构造统一走这里:smoke 只关心形状,不逐条标类型。 */
const ev = (e: object): RuntimeEvent => e as RuntimeEvent;

/** 临时数据根 —— 采集器 deps 注入,与用户真实数据根无关。 */
const root = mkdtempSync(join(tmpdir(), "mcode-monitoring-smoke-"));
/** deps 约定 root 是**取根的函数**(生产传 dataRoot,每次收口动态取)。 */
const rootOf = (): string => root;

/** 永远答得上的假会话表。 */
const lookup = (sessionId: string): string | undefined =>
  ({ s1: "wf_alpha", s2: "wf_beta", s3: "wf_gamma" })[sessionId];

async function main(): Promise<void> {
  /* ── 1. 直接喂事件:一次成功的运行 ── */
  const collector = new MonitoringCollector({ root: rootOf, lookupWorkflowId: lookup });
  const endedAt1 = Date.now();

  collector.handle(ev({ type: "workflow.node.progress", sessionId: "s1", runId: "run_1", nodeId: "n1", nodeType: "agent", title: "第一步" }));
  await sleep(25);
  collector.handle(ev({ type: "workflow.node.result", sessionId: "s1", runId: "run_1", nodeId: "n1", nodeType: "agent", title: "第一步", status: "success", summary: "ok" }));
  collector.handle(ev({ type: "workflow.node.progress", sessionId: "s1", runId: "run_1", nodeId: "n2", nodeType: "command", title: "第二步" }));
  await sleep(20);
  collector.handle(ev({ type: "workflow.node.result", sessionId: "s1", runId: "run_1", nodeId: "n2", nodeType: "command", title: "第二步", status: "success", summary: "ok" }));
  // 普通聊天事件混进来 —— 采集器不该理
  collector.handle(ev({ type: "text.delta", sessionId: "s1", messageId: "m_1", text: "noise" }));
  collector.handle(ev({ type: "turn.done", sessionId: "s1", reason: "end_turn", endedAt: endedAt1 }));

  const runs1 = readRunSummaries(root);
  eq("成功运行收出一条摘要", runs1.length, 1);
  const run1 = runs1[0];
  eq("runId 对", run1?.runId, "run_1");
  eq("workflowId 从会话表查到", run1?.workflowId, "wf_alpha");
  eq("sessionId 对", run1?.sessionId, "s1");
  eq("status = success", run1?.status, "success");
  eq("节点定案两条", run1?.nodes.length, 2);
  eq("kind 取事件里的 nodeType", run1?.nodes[0]?.kind, "agent");
  check("有进度事件的节点带耗时", (run1?.nodes[0]?.durationMs ?? 0) >= 20, run1?.nodes[0]);
  check("耗时是真实流逝(不是 0)", (run1?.nodes[1]?.durationMs ?? 0) > 0, run1?.nodes[1]);
  check("summary 带 endedAt(收口时刻)", typeof run1?.endedAt === "number", run1);

  /* ── 2. 一次失败的运行:没有进度事件、最后一步失败 ── */
  const endedAt2 = Date.now() + 5;
  collector.handle(ev({ type: "workflow.node.result", sessionId: "s2", runId: "run_2", nodeId: "n1", nodeType: "agent", title: "第一步", status: "failed", summary: "", error: "boom" }));
  collector.handle(ev({ type: "turn.done", sessionId: "s2", reason: "end_turn", endedAt: endedAt2 }));

  const overview = aggregateOverview(readRunSummaries(root));
  eq("totalRuns = 2", overview.totalRuns, 2);
  eq("succeeded = 1", overview.succeeded, 1);
  eq("failed = 1", overview.failed, 1);
  check("avgDurationMs 取自成功那次", (overview.avgDurationMs ?? 0) > 0, overview);
  eq("lastErrorMessage = 第一个失败节点的原因", overview.lastErrorMessage, "boom");
  eq("lastErrorAt = 失败运行的收口时刻", overview.lastErrorAt, endedAt2);

  /* ── 3. 经 mobileEventBus(生产接线):一次被用户取消的运行 ── */
  const busCollector = startMonitoringCollector({ root: rootOf, lookupWorkflowId: lookup });
  const endedAt3 = Date.now() + 10;
  mobileEventBus.broadcast(ev({ type: "workflow.node.progress", sessionId: "s3", runId: "run_3", nodeId: "n1", nodeType: "agent", title: "第一步" }));
  mobileEventBus.broadcast(ev({ type: "turn.done", sessionId: "s3", reason: "interrupted", endedAt: endedAt3 }));

  const runs3 = readRunSummaries(root);
  eq("总线订阅也收得到(共 3 条)", runs3.length, 3);
  eq("最新的在前", runs3[0]?.runId, "run_3");
  eq("reason=interrupted 收成 cancelled", runs3[0]?.status, "cancelled");
  check("durationMs 不为负", (runs3[0]?.durationMs ?? -1) >= 0, runs3[0]);
  eq("runs(limit) 截取", readRunSummaries(root, 1).length, 1);

  /* ── 4. 续跑沿用旧 runId:存储里两条,查询取最新 ── */
  collector.handle(ev({ type: "workflow.node.result", sessionId: "s2", runId: "run_2", nodeId: "n1", nodeType: "agent", title: "第一步", status: "success", summary: "这次成了" }));
  collector.handle(ev({ type: "turn.done", sessionId: "s2", reason: "end_turn", endedAt: Date.now() + 20 }));
  const run2Latest = readRunSummaries(root).find((r) => r.runId === "run_2");
  eq("同 runId 两条取最新(续跑后 success)", run2Latest?.status, "success");

  /* ── 5. 采集器吞错:畸形事件、抛错的 lookup,都只配一行日志 ── */
  let threw = false;
  try {
    collector.handle(ev({ type: "workflow.node.result", runId: "", sessionId: "", nodeId: "", nodeType: "", status: "success" }));
    collector.handle(ev({ type: "workflow.node.progress", sessionId: "s1", runId: "run_1", nodeId: "n1" }));
    collector.handle({} as RuntimeEvent);
    (collector as unknown as { handle(e: unknown): void }).handle(undefined);
    const brokenLookup = new MonitoringCollector({
      root: rootOf,
      lookupWorkflowId: () => {
        throw new Error("db down");
      },
    });
    brokenLookup.handle(ev({ type: "workflow.node.progress", sessionId: "sx", runId: "run_x", nodeId: "n1", nodeType: "agent" }));
    brokenLookup.handle(ev({ type: "turn.done", sessionId: "sx", reason: "end_turn", endedAt: Date.now() }));
  } catch (err) {
    threw = true;
    console.log(`  (异常漏出:${(err as Error).message})`);
  }
  check("畸形事件 + lookup 抛错都不外抛", !threw);
  const runX = readRunSummaries(root).find((r) => r.runId === "run_x");
  eq("lookup 抛错的运行照样收口,workflowId 记空串", runX?.workflowId, "");
  // 总线也要兜住:一个抛错的订阅者不能带坏别的订阅者
  mobileEventBus.subscribe(() => {
    throw new Error("poison subscriber");
  });
  let busThrew = false;
  try {
    mobileEventBus.broadcast(ev({ type: "turn.done", sessionId: "nobody", reason: "end_turn", endedAt: Date.now() }));
  } catch {
    busThrew = true;
  }
  check("bus 广播畸形事件不外抛", !busThrew);

  /* ── 6. NDJSON 持久化可重读 + 坏行不炸 ── */
  const file = join(root, "monitoring", "runs.ndjson");
  check("存储文件存在", existsSync(file));
  const rawLines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  eq("文件里一行一条(4 条运行 + 1 条续跑 = 5 行)", rawLines.length, 5);
  const roundTrip = JSON.parse(rawLines[0]) as Record<string, unknown>;
  check("首行 JSON 往返不丢关键字段", typeof roundTrip.runId === "string" && typeof roundTrip.startedAt === "number", roundTrip);
  // 坏行:半截 JSON、缺字段的行 —— 读侧跳过,不炸整份查询
  appendFileSync(file, "\n{半截 JSON\n{\"runId\":\"ok-shape\"}\n", "utf8");
  const idsAfterJunk = readRunSummaries(root).map((r) => r.runId);
  // 5 行 → 4 个唯一 runId(run_2 两条取最新),坏行不占位
  check("坏行与缺字段行都被跳过", !idsAfterJunk.includes("ok-shape") && idsAfterJunk.length === 4, idsAfterJunk);

  /* ── 7. 事件自带的 workflowId 优先(从前只有 queued 带,progress/result 只能查库) ── */
  {
    // 事件带了 workflowId → 直接用,**不查会话表**(库没起来那几秒才看得出跟的是哪张图)。
    let lookupCalls = 0;
    const withEvent = new MonitoringCollector({
      root: rootOf,
      lookupWorkflowId: () => {
        lookupCalls += 1;
        return "wf_FROM_DB";
      },
    });
    // 关键形状:**lookup 查不到**(模拟库没起来)—— 从前这会记空串。
    const dbDown = new MonitoringCollector({
      root: rootOf,
      lookupWorkflowId: () => undefined,
    });
    withEvent.handle(ev({ type: "workflow.node.progress", sessionId: "s9", runId: "run_ev", workflowId: "wf_from_event", nodeId: "n1", nodeType: "agent", title: "一步" }));
    withEvent.handle(ev({ type: "workflow.node.result", sessionId: "s9", runId: "run_ev", workflowId: "wf_from_event", nodeId: "n1", nodeType: "agent", title: "一步", status: "success", summary: "ok" }));
    withEvent.handle(ev({ type: "turn.done", sessionId: "s9", reason: "end_turn", endedAt: Date.now() }));
    eq("★ 事件自带 workflowId → 记的是它", readRunSummaries(root).find((r) => r.runId === "run_ev")?.workflowId, "wf_from_event");
    eq("★ 事件带了就不查会话表", lookupCalls, 0);

    // 库查不到、但事件带了 → 仍记对(这正是"启动那几秒监控卡不空白"的判据)
    dbDown.handle(ev({ type: "workflow.node.result", sessionId: "s10", runId: "run_dbdown", workflowId: "wf_survives", nodeId: "n1", nodeType: "agent", title: "一步", status: "success", summary: "ok" }));
    dbDown.handle(ev({ type: "turn.done", sessionId: "s10", reason: "end_turn", endedAt: Date.now() }));
    eq("★ 库查不到但事件带了 → 监控卡看得出是哪张图", readRunSummaries(root).find((r) => r.runId === "run_dbdown")?.workflowId, "wf_survives");

    // 老/畸形事件(不带 workflowId)→ 仍走查库兜底(既有行为不变)
    let fallbackCalls = 0;
    const legacy = new MonitoringCollector({
      root: rootOf,
      lookupWorkflowId: () => {
        fallbackCalls += 1;
        return "wf_legacy_db";
      },
    });
    legacy.handle(ev({ type: "workflow.node.progress", sessionId: "s11", runId: "run_legacy", nodeId: "n1", nodeType: "agent", title: "一步" }));
    legacy.handle(ev({ type: "turn.done", sessionId: "s11", reason: "end_turn", endedAt: Date.now() }));
    eq("★ 老事件(不带)→ 仍查库兜底", readRunSummaries(root).find((r) => r.runId === "run_legacy")?.workflowId, "wf_legacy_db");
    check("★ …而且确实查了库", fallbackCalls > 0, fallbackCalls);
  }

  busCollector();
}

main()
  .then(() => {
    console.log(`\nmonitoring-smoke: ${total - failures}/${total} checks passed`);
    rmSync(root, { recursive: true, force: true });
    if (failures > 0) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(`monitoring-smoke crashed: ${(err as Error).stack ?? err}`);
    rmSync(root, { recursive: true, force: true });
    process.exitCode = 1;
  });
