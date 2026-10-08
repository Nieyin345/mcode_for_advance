/**
 * `renderer/lib/workflowLive.ts` 的**运行现场封顶**回归网 —— 2026-10-09 立。
 *
 * ## 为什么单开一套
 *
 * `workflow-view-smoke` §8 验的是**折叠规则**(阶段流转、`awaiting` 存清、`halted`
 * 判据),但它那条「`MAX_RUNS` 封顶」的用例只喂了 `result` 事件 —— 而 `prune` 从前**只在
 * `result` 那一支**被调用。于是这个封顶有个洞:**一次运行要是一条 `result` 都没收到,它
 * 的那份现场就永远留在 `snapshot.runs` 里**,`MAX_RUNS` 形同虚设。
 *
 * 这不是理论:成功的**分支节点**不发 `result`(它的卡就是那张选择卡,见
 * `orchestration/scheduler.ts` 的 `settle` —— `node.parked`);一直「等人」被弃掉的分支也
 * 没有结果事件。一次会话翻下来,`runs` 只增不减 —— 而这块状态是**常驻内存**的
 * (`App` 启动就 `startWorkflowLive`,不再摘),正好撞在仓库那条「模块级状态只增不减」
 * 的缺陷类上。看板不直接读 `snapshot.runs`,但它按 `sessionId` 走 `halted` 与
 * `boardContinuationRunId`,那份表跟着一起涨。
 *
 * 判据立在**现场里到底留了几次运行**:同样是 40 次运行,不管它们是靠哪一类事件建起来的,
 * 留 24 条(见 `MAX_RUNS`)。
 *
 * 纯模块(只 import type + react 的 `useSyncExternalStore`),react 换成一个最小桩
 * (见 `react-stub.ts`),于是 esbuild 打包后直接 node 跑。
 *
 * Run: scripts/workflow-live-smoke/run.sh
 */
import "./prelude.js";
import {
  __applyWorkflowLiveEvent,
  __resetWorkflowLive,
  __workflowLiveSnapshot,
} from "@renderer/lib/workflowLive.js";
import type { RuntimeEvent } from "@contracts/runtime";

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
function section(t: string): void {
  console.log(`\n${t}`);
}

/** 一条最小 `workflow.node.*` 事件 —— 只是折进现场,不校验别的字段。 */
function ev(o: Record<string, unknown>): RuntimeEvent {
  return { sessionId: "s", runId: "r", nodeId: "n", ...o } as unknown as RuntimeEvent;
}
const runCount = (): number => Object.keys(__workflowLiveSnapshot().runs).length;

/* ───── 1. 每条事件路径都要遵守 MAX_RUNS(=24)封顶 ───── */

section("workflowLive:运行现场封顶(MAX_RUNS=24)");

{
  // 收场那条路(对照组 —— 这条从前就是对的,别被这次改动带偏)。
  __resetWorkflowLive();
  for (let i = 0; i < 40; i++) {
    __applyWorkflowLiveEvent(
      ev({ type: "workflow.node.result", runId: "r" + i, nodeId: "a", nodeType: "t", title: "T", status: "success", summary: "x" }),
    );
  }
  eq("result 建起来的运行被封到 24 条", runCount(), 24);
}

{
  // ★ 排队那条:**绝大多数字段都还没有**的那种运行(它可能一直等不到 result)。
  __resetWorkflowLive();
  for (let i = 0; i < 40; i++) {
    __applyWorkflowLiveEvent(ev({ type: "workflow.node.queued", runId: "q" + i, nodeId: "a", workflowId: "wf" }));
  }
  eq("★ queued 建起来的运行也要封到 24 条(它们可能永远收不到 result)", runCount(), 24);
}

{
  // ★ 进度那条:同一类问题 —— 一个跑着的运行还没收场时也只涨不落。
  __resetWorkflowLive();
  for (let i = 0; i < 40; i++) {
    __applyWorkflowLiveEvent(
      ev({ type: "workflow.node.progress", runId: "p" + i, nodeId: "a", nodeType: "t", title: "T" }),
    );
  }
  eq("★ progress 建起来的运行也要封到 24 条", runCount(), 24);
}

{
  // ★ 选择那条:**成功的分支节点不发 result**(见文件头),这条路最容易只增不减。
  __resetWorkflowLive();
  for (let i = 0; i < 40; i++) {
    __applyWorkflowLiveEvent(
      ev({
        type: "workflow.node.choice",
        runId: "c" + i,
        nodeId: "a",
        nodeType: "mcode.branch",
        title: "T",
        attempt: 1,
        options: [{ id: "e_a", label: "A" }],
      }),
    );
  }
  eq("★ choice 建起来的运行也要封到 24 条(成功的分支没有 result)", runCount(), 24);
}

/* ───── 2. 封顶不误伤:还在跑的那几条要留下来 ───── */

section("workflowLive:封顶按「最后动静」淘汰,别把刚动的挤掉");

{
  // 封顶按「最后动静」(`touchedAt`)淘汰。`Date.now()` 是毫秒精度,一瞬灌进去的事件会
  // 落在同一毫秒、排序无从区分 —— 所以这里**故意用忙等把时间推过毫秒边界**,让"哪条更
  // 新"是确定的,免得断言靠运气。
  const spin = (ms: number): void => {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* busy wait */ }
  };
  __resetWorkflowLive();
  for (let i = 0; i < 24; i++) {
    __applyWorkflowLiveEvent(ev({ type: "workflow.node.queued", runId: "k" + i, nodeId: "a", workflowId: "wf" }));
  }
  spin(5);
  // 24 条建满之后,把编号 0 的那条重新动一下 —— 它变成"最近动过"的一条。
  __applyWorkflowLiveEvent(ev({ type: "workflow.node.progress", runId: "k0", nodeId: "a", nodeType: "t", title: "T" }));
  spin(5);
  __applyWorkflowLiveEvent(ev({ type: "workflow.node.queued", runId: "k24", nodeId: "a", workflowId: "wf" }));
  __applyWorkflowLiveEvent(ev({ type: "workflow.node.queued", runId: "k25", nodeId: "a", workflowId: "wf" }));
  const s = __workflowLiveSnapshot();
  eq("仍然只有 24 条", Object.keys(s.runs).length, 24);
  check("★ 刚动过的 k0 还在", s.runs["k0"] !== undefined, Object.keys(s.runs));
  check("★ 最久没动的 k1 被挤掉了", s.runs["k1"] === undefined, Object.keys(s.runs));
  check("最新灌进来的 k25 在", s.runs["k25"] !== undefined);
}

/* ───── 3. 封顶之后 halted 跟着重建(停住提示不能指向被淘汰的运行) ───── */

section("workflowLive:封顶后 halted 与保留下来的现场一致");

{
  __resetWorkflowLive();
  __applyWorkflowLiveEvent(
    ev({ type: "workflow.node.result", runId: "old", nodeId: "a", nodeType: "t", title: "A", status: "failed", error: "x" }),
  );
  eq("先确认它报着停住", __workflowLiveSnapshot().halted["s"]?.reason, "failed");
  // 再灌 30 次别的运行,把那条失败的老运行挤出上限。
  for (let i = 0; i < 30; i++) {
    __applyWorkflowLiveEvent(ev({ type: "workflow.node.queued", runId: "z" + i, nodeId: "a", workflowId: "wf", sessionId: "other" }));
  }
  const s = __workflowLiveSnapshot();
  check("被挤出上限的那次运行不在现场了", s.runs["old"] === undefined, Object.keys(s.runs));
  check("★ halted 不再指向已经不存在的运行", s.halted["s"] === undefined, s.halted["s"]);
}

console.log(`\nworkflow-live-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
