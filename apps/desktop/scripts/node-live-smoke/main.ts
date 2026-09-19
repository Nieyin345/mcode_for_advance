/**
 * Headless smoke for **节点跑着的时候,对话里那张卡有没有东西在动**
 * (`main/orchestration/runner.ts` 那一段进度上报)。
 *
 * ## 为什么要有这一套
 *
 * 用户的原话是「转圈转了四十分钟,看起来和卡死没有区别」。一个工作流节点跑 20~40 分钟
 * 是常事,而那张卡片从头到尾只有一行**不变的字**加一个转圈。
 *
 * 根因不是"没显示",是**主进程压根没发**:卡片上那行小字(`message`)只有
 * `emitProgress` 能写,而内置执行器里只有 `command` / `code` 两种会调它 —— 模型轮
 * 这一路(也就是**绝大多数节点**)从头到尾一条都不发。于是卡片上就只剩「执行中」三个字,
 * 而用户看不出它具体在干嘛。
 *
 * ## 这一套钉住的四条
 *
 * 1. **跑起来之后要有字在动。** 40 分钟里必须能看出它是活的 —— 时长那条("已跑 3 分
 *    12 秒")是最便宜、最不含糊的一条,而"它现在在跑 Bash"更清楚地回答了"在干嘛"。
 * 2. **不许编百分比。** `percent` 只在真的知道总量时才许带(`command` 节点那类脚本
 *    自己报的);模型轮这一步的总量无从估算,编一个数字出来只会让进度条走到 99% 然后
 *    停住 —— 那比没有进度条更糟。见 `runner.ts` 里那段注释。
 * 3. **不许灌水。** 这是个跑几十分钟的东西,一秒一条会把渲染端和消息流冲垮。
 * 4. **节点收场之后必须停。** 卡片那时已经换成结果卡,后台还在发就是幽灵事件(而且
 *    `runs` 里那条已经删了,发出去的东西没人认领)。
 *
 * ## 为什么能无头跑、假的是哪一半
 *
 * `runner.ts` 直接 import 了 `@main/claude/RuntimeManager.js`,而真的那个一旦
 * `bindSession` 就会 `providerRegistry.resolve` —— 整条引擎链(三个 SDK 实现 + 每个的
 * MCP 工具表)全在链上,无头起不来。所以**引擎那一侧是假的**(见 `stubs/runtimeManager.ts`),
 * 被测的 `startWorkflowRun` 是**真的** —— 这一套读的是真代码发出去的事件,不是抄本。
 *
 * 时钟也是**可控**的(桩里的 `advance()`):否则"已跑 3 分 12 秒"只验得出"有个数字",
 * 验不出"它在走"。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 换成 `$MCODE_SMOKE_DATA_ROOT`(run.sh 用 `mktemp -d` 建的目录,跑完就删)。
 * **不是 `~/Mcode`** —— 这一套会真的建库、真的写会话行。
 *
 * Run: scripts/node-live-smoke/run.sh
 */
import "./prelude.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ── 数据根必须在**任何** `@main/*` 被 import 之前钉好 ── */
const DATA = mkdtempSync(join(tmpdir(), "mcode-node-live-data-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ── 被测的真模块 + 夹具(动态 import:数据根要先生效) ── */

const { initDb } = await import("@main/store/db.js");
const { ProjectRepo, SessionRepo, WorkflowRepo } = await import("@main/store/repositories.js");
/**
 * ⚠️ **命名空间导入,不是具名导入。** 具名的写法(`import { NODE_PROGRESS_TICK_MS }`)
 * 在实现被撤掉时会变成 esbuild 的 "No matching export" —— 那是**打包失败**,不是断言
 * 失败,拿不到"红"那一份可读的输出(而"撤掉实现看它真红"要的正是那一份)。走命名空间
 * 就只是 `undefined`,下面回落成默认值,断言照跑照红。
 */
const runner = await import("@main/orchestration/runner.js");
const { startWorkflowRun, cancelWorkflowRun } = runner;
/** 实现里那两个窗口。撤掉实现时回落成默认值 —— 断言测的是**行为**,不是这两个数。 */
const NODE_PROGRESS_TICK_MS = (runner as { NODE_PROGRESS_TICK_MS?: number }).NODE_PROGRESS_TICK_MS ?? 1_000;
const NODE_PROGRESS_HEARTBEAT_MS =
  (runner as { NODE_PROGRESS_HEARTBEAT_MS?: number }).NODE_PROGRESS_HEARTBEAT_MS ?? 5_000;
const rt = await import("./stubs/runtimeManager.js");
const win = await import("./stubs/window.js");
const { nodeLiveDoc, parentSession, project, PARENT, AGENT_TITLE } = await import("./fixtures.js");

await initDb();

type ProgressEvent = {
  type: "workflow.node.progress";
  sessionId: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  title: string;
  percent?: number;
  message?: string;
  phase?: string;
};

/** 收一份**当前**已经发出去的全部事件(渲染端那条路 + 订阅者那条路)。 */
function sentEvents(): unknown[] {
  return [...win.sent(), ...rt.published];
}

function progressFor(nodeId: string, sessionId: string = PARENT): ProgressEvent[] {
  return sentEvents().filter(
    (e): e is ProgressEvent =>
      (e as { type?: string }).type === "workflow.node.progress" &&
      (e as ProgressEvent).nodeId === nodeId &&
      (e as ProgressEvent).sessionId === sessionId,
  );
}

/** 等条件成立;超时就**认失败**(不静默通过)。
 *
 *  ⚠️ 超时判据必须用 `rt.realNowMs()` —— 被测代码的墙上时钟是**冻住**的(见桩),
 *  拿 `Date.now()` 算 deadline 的话,只要条件不成立这个循环就永远不会退出。 */
async function waitFor(label: string, cond: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = rt.realNowMs() + timeoutMs;
  while (rt.realNowMs() < deadline) {
    if (cond()) return true;
    await sleep(10);
  }
  check(`等到了:${label}`, false, { waitedMs: timeoutMs });
  return false;
}

/**
 * 起一次图,拿到**要盯的那个节点会话**。
 *
 * 夹具那张图是「入口(`mcode.main`,跑在主对话里,立刻收场)→ 子 agent 节点」——
 * 入口那一步不是我们要盯的(它就是用户自己的对话),**第二个格子**才是("绝大多数节点"
 * 走的就是隐藏子会话这一路)。
 *
 * ⚠️ `nodeSessionIds` 收尾时会被**清空**(见 `runner.ts` 最后那段 `dispose`),所以节点
 * 会话 id 必须在跑的过程中就记下来:等到 `done` 落地之后再去看 `boundSessions`,节点会话
 * 已经被放掉了。
 */
async function startRun(
  sessionId: string,
): Promise<{ done: Promise<unknown>; nodeSession: string }> {
  const before = new Set(rt.boundSessions);
  const done = startWorkflowRun({
    session: SessionRepo.get(sessionId)!,
    prompt: "查一下这三篇的引用",
    cwd: process.cwd(),
  });
  await waitFor(
    `${sessionId} 的节点会话起来`,
    () => [...rt.boundSessions].some((id) => !before.has(id) && id !== sessionId),
  );
  await waitFor(`${sessionId} 的节点会话被记下来`, () => rt.nodeSessionOf(sessionId).length > 0);
  return { done, nodeSession: rt.nodeSessionOf(sessionId) };
}

/* ──────────────── 0. 夹具 ──────────────── */

console.log("node-live-smoke —— 节点跑着的时候,卡片上有没有东西在动\n");

WorkflowRepo.save(nodeLiveDoc());
ProjectRepo.create(project());
SessionRepo.create(parentSession());

/* ──────────────── 1. 节点起跑 ──────────────── */

const first = await startRun(PARENT);
const NODE_SESSION = first.nodeSession;

check("节点跑在**隐藏子会话**里,不是主对话", NODE_SESSION !== PARENT, { bound: [...rt.boundSessions] });

{
  const list = progressFor("agent");
  check("起跑就报了第一条进度(不是干等着工具调用)", list.length >= 1, { count: list.length });
  check("第一条带的是**这一步的标题**", list[0]?.title === AGENT_TITLE, { got: list[0]?.title });
  check(
    "第一条**不许带 percent** —— 这一步的总量无从估算",
    list.every((e) => e.percent === undefined),
    { percents: list.map((e) => e.percent) },
  );
}

/* ──────────────── 2. 跑起来之后:卡上要有字在动 ──────────────── */

const emit = rt.nodeEmit(NODE_SESSION);
check("拿得到节点会话这一轮的 emit", typeof emit === "function");

if (typeof emit !== "function") {
  console.log("\n(拿不到节点会话的 emit —— 后面几段跳过)\n");
} else {
  const tool = (id: string, name: string): void =>
    emit({
      type: "tool.use",
      sessionId: NODE_SESSION,
      toolCallId: id,
      toolName: name,
      input: {},
      requiresApproval: false,
    });

  /** 卡片上那行小字,按发出顺序。 */
  const lines = (): string[] => progressFor("agent").map((e) => e.message ?? "");
  /** 等**下一批**里出现一条满足条件的 —— `from` 之后就只看新增的。 */
  const waitLine = async (label: string, hit: (t: string) => boolean, from: number): Promise<boolean> =>
    waitFor(label, () => lines().slice(from).some(hit));

  /*
   * ⚠️ **节奏的写法**:心跳读的是**冻住的**墙上时钟(桩里的 `advance`),而 `setInterval`
   * 走的是**真**事件循环 —— 两者互不相干。所以这里不能"拨一下表然后立刻去读",那样
   * 心跳还没轮到就被读走了(测试会闪断)。正确写法是拨完表**等**它出现 —— 每步最多等
   * 1 个真实秒,而 `waitFor` 自己会认失败,不会静默通过。
   */

  // ① 工具名一出现就要报 —— 这是"它现在在干嘛"那半截。
  tool("t1", "Bash");
  // ⚠️ **必须拨表。** 两道闸门量的都是**墙上时钟**(`Date.now()`),而这个套件把它冻住
  // 了 —— 不拨的话 `now - sentAt` 永远是 0,内容变了也过不去第一道闸门(真实运行时时钟
  // 在走,所以那不是 bug,是这一套的时钟不动)。拨够第一道闸门那一档即可。
  rt.advance(NODE_PROGRESS_TICK_MS);
  const afterTool1 = lines().length;
  await waitLine("Bash 报上了卡片", (t) => t.includes("Bash"), afterTool1);

  // ② 一分钟之后换个工具:**分钟数跟着走**,工具名也换。
  rt.advance(60_000);
  tool("t2", "Grep");
  const afterTool2 = lines().length;
  await waitLine("一分钟之后的 Grep 报上了卡片", (t) => t.includes("Grep") && t.includes("1 分"), afterTool2);

  const list = progressFor("agent");
  const texts = list.map((e) => e.message ?? "");
  const distinct = [...new Set(texts)];

  check("跑起来之后,进度**变过**(不是一条到底)", distinct.length >= 2, { texts });
  check(
    "至少一条说了**它现在在干嘛**(工具名在里面)",
    texts.some((t) => /Bash|Grep|Read/.test(t)),
    { texts },
  );
  check(
    "时间那条能看出**活在走**(不是固定的一句)",
    distinct.some((t) => /已跑|分钟|秒/.test(t)),
    { texts },
  );
  check(
    "**全程不许带 percent** —— 这一步的总量无从估算",
    list.every((e) => e.percent === undefined),
    { percents: list.map((e) => e.percent) },
  );

  /* ── 2b. 不许灌水:40 条 token 增量 ── */

  const before = progressFor("agent").length;
  for (let i = 0; i < 40; i++) {
    emit({ type: "text.delta", sessionId: NODE_SESSION, messageId: "m1", text: `字${i}` });
  }
  await sleep(60);
  eq(`同一秒里灌 40 条 token 增量,进度事件一条都不许涨`, progressFor("agent").length, before);

  /* ── 2c. 不许灌水:同一时刻反复问也不许多发 ── */

  const beforeTick = progressFor("agent").length;
  for (let i = 0; i < 5; i++) await sleep(20);
  eq("同一时刻反复问,也不许多发一条", progressFor("agent").length, beforeTick);

  /* ── 2d. 秒表的**心跳闸门**:内容没变时一秒一条是被挡住的 ──
   *
   * 这道断言是上面"5 秒"那个数的正面说明 —— 少了它,"不许灌水"三条里没有一条能证明
   * 中间那档真的存在(它们只证明了"同一时刻"不重复,而那是 `line` 本身不变挡下的)。 */

  {
    const at = progressFor("agent").length;
    rt.advance(NODE_PROGRESS_TICK_MS); // 只走一道短闸门:内容没变
    await sleep(1_500); // 真事件循环里够跳好几拍
    eq(
      `内容没变时,**${NODE_PROGRESS_TICK_MS}ms 那一道是挡住的** —— 心跳只在 ${NODE_PROGRESS_HEARTBEAT_MS}ms 那一档出声`,
      progressFor("agent").length,
      at,
    );

    // 走够心跳那一档,它就该出声了 —— 否则上面那条"挡住了"可能只是**它压根不发**。
    rt.advance(NODE_PROGRESS_HEARTBEAT_MS);
    await waitLine("隔够了心跳那一档,秒表自己往前走了", (t) => t.includes("秒"), at);
  }
}

/* ──────────────── 3. 收场 ──────────────── */

rt.finishTurn(NODE_SESSION);
await first.done;
await sleep(200);

const afterResult = sentEvents().findIndex(
  (e) =>
    (e as { type?: string }).type === "workflow.node.result" &&
    (e as { nodeId?: string }).nodeId === "agent",
);
check("收场发了 `workflow.node.result`(卡片这时换成结果卡)", afterResult >= 0, { at: afterResult });

const countAtSettle = progressFor("agent").length;
await sleep(1_500);
eq("收场之后不再有任何进度事件(定时器 / 订阅都清干净了)", progressFor("agent").length, countAtSettle);

{
  // ⚠️ 判据不能是"运行时被 dispose 了" —— `nodeSessionIds` 收尾时被**清空**,而 `dispose`
  // 是遍历它调的,所以那一刻 `nodeEmit` 已经拿不到东西了。真正要钉的是**行为**:
  // 拿那个会话 id 再灌事件进去,进度一条都不许涨(幽灵事件)。
  const lateEmit = rt.nodeEmit(NODE_SESSION);
  lateEmit?.({
    type: "tool.use",
    sessionId: NODE_SESSION,
    toolCallId: "late",
    toolName: "Bash",
    input: {},
    requiresApproval: false,
  });
  await sleep(100);
  eq("收场之后往那个节点会话灌事件,也不冒进度", progressFor("agent").length, countAtSettle);
}

/* ──────────────── 4. 渲染端认不认(发出去 ≠ 看得见) ──────────────── */

{
  const { useSessionStore } = await import("@renderer/stores/sessionStore.js");
  const ingest = useSessionStore.getState().ingestEvent;
  // ⚠️ `ingestEvent` 吃的是**事件本身**,不是 IPC 那个信封(`{channel, sessionId,
  // event}`)—— 拆信封是 `useClaudeEvents` 干的(见那里 `ingest(msg.event)`)。
  // 这里喂信封的话整个 reducer 一条都不认,卡片永远是空的。
  const sentProgress = win
    .sent()
    .filter((x) => (x as { type?: string }).type === "workflow.node.progress");
  for (const e of sentProgress) ingest(e as never);

  const blocks = (useSessionStore.getState().messagesBySession[PARENT] ?? []).flatMap((m) => m.blocks);
  const cards = blocks.filter((b) => b.kind === "workflow-node-progress");
  const card = cards.at(-1) as { message?: string; phase?: string } | undefined;
  check("渲染端把进度折成了一张卡", card !== undefined);

  /*
   * ⚠️ **判据立在"用户看到的那行字"上,不是"卡上有个非空字段"。**
   *
   * 光验"非空"是不够的:起跑那条本来就带着节点标题,所以哪怕实现被撤掉、后面一条都
   * 不发,那种断言照样绿 —— 而用户看到的**正是**那一行从头到尾不变的字(这就是原始
   * 抱怨)。所以这里要的是两件更硬的事:
   *
   *  1. 卡片上留下的是**最后那条**进度(渲染端靠 `patchWorkflowNodeProgressBlock`
   *     原地换,所以"卡片跟着最新一条走"是它该有的行为);
   *  2. 那行字里**有活在走的东西** —— 时长(`已跑 …`)或工具名。这是整件事的验收点:
   *     卡片上那行字,不能是开局那一句标题。
   */
  const last = sentProgress.at(-1) as { message?: string } | undefined;
  check(
    "卡片上留的是**最后那条**进度(不是开局那一句)",
    card !== undefined && (card.message ?? "").length > 0 && card.message === last?.message,
    { card: card?.message, last: last?.message },
  );
  check(
    "**卡片上那行字里有东西在走** —— 时长或工具名,不是一句不变的话",
    /已跑/.test(card?.message ?? "") || /Bash|Grep|Read/.test(card?.message ?? ""),
    { card: card?.message },
  );
  check(
    "卡上那两格里至少有一格是非空的(否则卡片上还是「执行中」三个字)",
    (card?.message ?? "").length > 0 || (card?.phase ?? "").length > 0,
    { card },
  );
}

/* ──────────────── 5. 取消:收场之后同样要停 ──────────────── */

{
  const SECOND = "s_parent_cancel";
  SessionRepo.create(parentSession(SECOND));
  rt.resetPublished();
  win.resetSent();

  const before = new Set(rt.boundSessions);
  const p = startWorkflowRun({
    session: SessionRepo.get(SECOND)!,
    prompt: "再跑一次",
    cwd: process.cwd(),
  });
  await waitFor("第二次运行的节点会话起来", () =>
    [...rt.boundSessions].some((id) => !before.has(id) && id !== SECOND),
  );
  const nodeSession2 = rt.nodeSessionOf(SECOND);
  rt.nodeEmit(nodeSession2)?.({
    type: "tool.use",
    sessionId: nodeSession2,
    toolCallId: "c1",
    toolName: "Bash",
    input: {},
    requiresApproval: false,
  });
  cancelWorkflowRun(SECOND);
  await p;
  await sleep(300);
  const n = progressFor("agent", SECOND).length;
  rt.advance(60_000);
  await sleep(500);
  eq("取消之后进度也停了(时间那条不会自己接着走)", progressFor("agent", SECOND).length, n);
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} 通过`);
if (failures > 0) {
  console.log(`${failures} 条没过`);
  process.exit(1);
}
console.log("全部通过");
