/**
 * Headless smoke for **`HookRunner` 自己** —— 钩子能力的最后一段没被覆盖的路。
 *
 * ## 为什么要有这一套
 *
 * `hooks-smoke` 覆盖了纯逻辑(匹配/校验/文件格式)和 `runHookCommand`(真起进程),但它
 * 的文件头明写着 `HookRunner` **没有覆盖**,理由是"要活的 RuntimeManager 和真会话"。
 * 那个理由只对了一半:真会话确实给不出,但整条链上真正会出错的那几段**都不需要它**:
 *
 *  - **一个事件该不该触发** —— `HOOK_EVENT_OF` 查表 + `matchesHook` + **`eventSubjects`
 *    那份有状态的小表**(`tool.result` 不带工具名,得回查前面那条 `tool.use`);
 *  - **扣住的收口不能触发** —— 对话节点跑在主对话里,它跑完那条 `turn.done` 如果照触发,
 *    一张十步的图会响十次;
 *  - **同一条钩子同时只跑一个进程** —— 一轮里 `tool.use` 能来几十次,不挡住就是一个慢
 *    脚本攒出几十个进程;
 *  - **按 mtime 重读 hooks.json** —— 用户直接改文件是这套东西的设计意图,而"改了没反应"
 *    是最难查的一类问题;
 *  - **绝不把异常抛回事件流**、**结果只进环不进对话**。
 *
 * 这五条每一条都是"坏了不报错、只是安静地不对"的形状,所以值得钉住。会话那一段用真的
 * `SessionRepo`/`ProjectRepo`(临时数据根 + 真 sql.js),只有 RuntimeManager 是替身。
 *
 * ## 真起进程
 *
 * 钩子命令是**真的**跑的(写一个小 `.js` 到临时目录,命令是 `node 那个文件`),因为
 * "并发互斥"和"跳过"的判据就是进程在不在跑 —— 拿假执行器验不出那条。
 *
 * Run: scripts/hook-runner-smoke/run.sh
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookSpec, DeliveryPolicy } from "@contracts/hook";
import { DEFAULT_DELIVERY_POLICY, DEFAULT_HOOK_TIMEOUT_MS, coalesceWindowMs, decideDelivery, decideRetry } from "@contracts/hook";
import type { RuntimeEvent } from "@contracts/runtime";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 轮询等一个条件成立(事件是异步处理的 —— `onEvent` 不 await,见不变量 1)。 */
async function until(what: string, cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等不到:${what}`);
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-hook-runner-"));
const WORK = mkdtempSync(join(tmpdir(), "mcode-hook-runner-work-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const { runtimeManager } = await import("@main/claude/RuntimeManager.js");
/** 桩比真的多两个方法(`emit` / `holdTurnEnd` / `releaseTurnEnd`),而 tsc 看到的是**真的**
 *  那个类型 —— 所以从这里转一道手。少实现一个方法时打包出来的会是 undefined,不是静默通过。 */
const rt = runtimeManager as unknown as {
  subscribe(fn: (e: RuntimeEvent) => void): () => void;
  emit(e: RuntimeEvent): void;
  holdTurnEnd(sessionId: string): void;
  releaseTurnEnd(sessionId: string): void;
};
const { SessionRepo, ProjectRepo } = await import("@main/store/repositories.js");
const { initDb } = await import("@main/store/db.js");
const { hooksFilePath, writeHooks } = await import("@main/hooks/store.js");
const { hookRunner } = await import("@main/hooks/HookRunner.js");

/** 钩子 id —— 与渲染端 `hooksView.makeHookId` 同一个形状(`h_` + 时间戳 + 随机)。
 *  **不复用那个模块**:它在 `components/settings/` 下,拖进来一大串 React 依赖,而这里
 *  只需要一个"图内唯一"的字符串。id 的**格式**没有契约意义(`HookSpec.id` 只是个 key),
 *  所以两份不算"共享实现掰成两半"。 */
let idSeq = 0;
const makeHookId = (): string => `h_smoke_${idSeq++}`;

await initDb();

/* ──────────────── 一个真的会话(钩子要先查到它才继续) ──────────────── */

// 会话必须真的在库里:`sessionFacts` 查不到就整条事件跳过(那段本身也是下面的一条断言)。
// 造法抄 `automation-smoke` —— 全字段塞齐,`SessionRepo.create` 收的是整条 `Session`。
const now = Date.now();
const PROJECT_ID = "p_hook_smoke";
ProjectRepo.create({
  id: PROJECT_ID,
  name: "钩子冒烟项目",
  path: WORK,
  archived: false,
  group: null,
  sortOrder: 0,
  pinnedAt: null,
  createdAt: now,
  updatedAt: now,
});
const SESSION = "s_hook_smoke";
SessionRepo.create({
  id: SESSION,
  projectId: PROJECT_ID,
  providerId: "claude-sdk",
  claudeSessionId: null,
  kind: "chat",
  parentSessionId: null,
  nodeId: null,
  title: "钩子冒烟会话",
  status: "idle",
  model: "",
  effort: "default",
  permissionMode: "default",
  workflowId: "wf_hook_smoke",
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
});

console.log(`\n会话 ${SESSION} / 项目目录 ${WORK}\n`);

/* ──────────────── 造一条钩子命令:把事件名写进一个文件 ──────────────── */

/** 每个事件名一个文件 —— 数数就是"触发了几次",比看执行记录更硬(环只有 50 条,会被顶掉)。 */
let cmdSeq = 0;
function makeCmd(opts: { tag: string; sleepMs?: number }): { command: string; hits: () => number } {
  cmdSeq += 1;
  const marker = join(WORK, `hits-${opts.tag}.txt`);
  const sleep = opts.sleepMs ? ` --sleep ${opts.sleepMs}` : "";
  // 脚本文件而不是内联 `node -e`:仓库规矩第 5 条(内联命令多层转义必炸)。
  const script = join(WORK, `hook-${opts.tag}.js`);
  writeFileSync(
    script,
    [
      `const fs = require("node:fs");`,
      `const [file, sleepMs] = process.argv.slice(2);`,
      `fs.appendFileSync(file, "x");`,
      `setTimeout(() => {}, Number(sleepMs || 0));`,
    ].join("\n"),
    "utf8",
  );
  return {
    command: `node "${script}" "${marker}"${sleep}`,
    hits: () => {
      if (!existsSync(marker)) return 0;
      return readFileSync(marker, "utf8").length;
    },
  };
}

function spec(over: Partial<HookSpec> & { command: string; tag: string }): HookSpec {
  return {
    id: makeHookId(),
    name: over.tag,
    event: "tool.use",
    enabled: true,
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    ...over,
  } as HookSpec;
}

/* ──────────────── 1. 一个事件该不该触发 ──────────────── */

console.log("事件 → 触发");

const a = makeCmd({ tag: "use" });
const hookA = spec({ command: a.command, tag: "use" });
writeHooks([hookA]);
hookRunner.start();

// mtime 变了才会重读,而 `writeHooks` 是先写临时文件再改名 —— 同一毫秒内连着写两次
// 有可能拿到同一个 mtimeMs。这里只写一次,所以不担心;下面的重读那一段会另想办法。
rt.emit({
  type: "tool.use",
  sessionId: SESSION,
  toolName: "Write",
  toolCallId: "call_1",
  input: {},
  requiresApproval: false,
} satisfies RuntimeEvent);
await until("tool.use 触发一次", () => a.hits() === 1);
eq("tool.use 触发了", a.hits(), 1);

// **matcher 不匹配就不该触发。** 这条是"配错了却每次都跑"和"配错了不跑"的分界。
const b = makeCmd({ tag: "no-match" });
writeHooks([spec({ command: b.command, tag: "no-match", matcher: "Bash" })]);
hookRunner.start();
rt.emit({
  type: "tool.use",
  sessionId: SESSION,
  toolName: "Write",
  toolCallId: "call_2",
  input: {},
  requiresApproval: false,
} satisfies RuntimeEvent);
// 给它一点时间跑 —— 反过来的断言要等一等才作数
await new Promise((r) => setTimeout(r, 600));
eq("matcher 不匹配 → 一次都没跑", b.hits(), 0);

/* ──────────────── 2. `tool.result` 的工具名要靠前面那条事件回查 ──────────────── */

console.log("\ntool.result 的工具名(有状态的那张小表)");

const c = makeCmd({ tag: "result" });
writeHooks([spec({ command: c.command, tag: "result", event: "tool.result", matcher: "Write" })]);
rt.emit({
  type: "tool.use",
  sessionId: SESSION,
  toolName: "Write",
  toolCallId: "call_3",
  input: {},
  requiresApproval: false,
} satisfies RuntimeEvent);
rt.emit({
  type: "tool.result",
  sessionId: SESSION,
  toolCallId: "call_3",
  isError: false,
  content: "ok",
} satisfies RuntimeEvent);
await until("tool.result 靠回查工具名触发了", () => c.hits() === 1);
eq("tool.result 匹配上了 Write(工具名是回查来的)", c.hits(), 1);

// 表里没有那个 id(比如应用重启后残留的结果事件)→ 不给主语 → 带 matcher 的钩子不触发。
const d = makeCmd({ tag: "orphan" });
writeHooks([spec({ command: d.command, tag: "orphan", event: "tool.result", matcher: "Write" })]);
rt.emit({
  type: "tool.result",
  sessionId: SESSION,
  toolCallId: "call_never_seen",
  isError: false,
  content: "ok",
} satisfies RuntimeEvent);
await new Promise((r) => setTimeout(r, 600));
eq("查不到工具名 → 不触发", d.hits(), 0);

/* ──────────────── 3. 扣住的收口不能触发 ──────────────── */

console.log("\n被扣住的 turn.done(对话节点跑在主对话里)");

const e = makeCmd({ tag: "turn-done" });
writeHooks([spec({ command: e.command, tag: "turn-done", event: "turn.done" })]);

rt.holdTurnEnd(SESSION);
rt.emit({
  type: "turn.done",
  sessionId: SESSION,
  reason: "end_turn",
} as RuntimeEvent);
await new Promise((r) => setTimeout(r, 700));
eq("扣住的 turn.done 不触发(否则一张十步的图会响十次)", e.hits(), 0);

rt.releaseTurnEnd(SESSION);
rt.emit({
  type: "turn.done",
  sessionId: SESSION,
  reason: "end_turn",
} as RuntimeEvent);
await until("放开之后同一条事件就触发了", () => e.hits() === 1);
eq("放开后触发", e.hits(), 1);

/* ──────────────── 4. 同一条钩子同时只跑一个进程 ──────────────── */

console.log("\n同一条钩子的并发互斥");

const f = makeCmd({ tag: "slow", sleepMs: 1200 });
const hookF = spec({ command: f.command, tag: "slow" });
writeHooks([hookF]);

for (let i = 0; i < 5; i += 1) {
  rt.emit({
    type: "tool.use",
    sessionId: SESSION,
    toolName: "Write",
    toolCallId: `call_burst_${i}`,
    input: {},
    requiresApproval: false,
  } satisfies RuntimeEvent);
}
await until("第一条跑起来了", () => f.hits() >= 1);

// 全部事件都已经派发完(`emit` 是同步的,`onEvent` 是异步的但立刻开始跑)—— 此时去看
// 执行记录:应该只有一条 `ok`,其余都是 `skipped`。
const burst = hookRunner.listRuns().filter((r) => r.hookId === hookF.id);
check("5 次事件只起了 1 个进程", f.hits() === 1, { hits: f.hits() });
check("其余记成了 skipped(不是悄悄丢掉)", burst.filter((r) => r.status === "skipped").length >= 1, {
  statuses: burst.map((r) => r.status),
});
check(
  "skipped 那条说了原因",
  burst.some((r) => r.status === "skipped" && (r.error ?? "").includes("还在跑")),
  burst.filter((r) => r.status === "skipped").map((r) => r.error),
);
await until("跑完之后又放开", () => {
  rt.emit({
    type: "tool.use",
    sessionId: SESSION,
    toolName: "Write",
    toolCallId: `call_after_${Date.now()}`,
    input: {},
    requiresApproval: false,
  } satisfies RuntimeEvent);
  return f.hits() === 2;
});
eq("跑完之后下一条事件能再起进程", f.hits(), 2);

/* ──────────────── 5. 改 hooks.json 当场生效 ──────────────── */

console.log("\n按 mtime 重读 hooks.json");

const g = makeCmd({ tag: "reload" });
// mtimeMs 的精度在有些文件系统上只到秒 —— 先等一会儿再写,免得"时间戳没变所以没重读"
// 把这条断言变成假绿。
await new Promise((r) => setTimeout(r, 1100));
writeHooks([spec({ command: g.command, tag: "reload" })]);
rt.emit({
  type: "tool.use",
  sessionId: SESSION,
  toolName: "Write",
  toolCallId: "call_reload",
  input: {},
  requiresApproval: false,
} satisfies RuntimeEvent);
await until("改了文件之后新钩子当场生效(不用重启应用)", () => g.hits() === 1);
eq("新钩子生效", g.hits(), 1);

/* ──────────────── 6. 环与坏东西 ──────────────── */

console.log("\n执行记录环 + 起不来的命令");

// 环上限 50 —— 连着触发 60 次,记录不该无限长。
const h = makeCmd({ tag: "ring" });
const hookH = spec({ command: h.command, tag: "ring" });
writeHooks([hookH]);
for (let i = 0; i < 60; i += 1) {
  rt.emit({
    type: "tool.use",
    sessionId: SESSION,
    toolName: "Write",
    toolCallId: `call_ring_${i}`,
    input: {},
    requiresApproval: false,
  } satisfies RuntimeEvent);
}
await until("环那一条至少跑过一次", () => h.hits() >= 1);
check("执行记录不超过 50 条", hookRunner.listRuns().length <= 50, { n: hookRunner.listRuns().length });

// 命令不存在 → 记 failed,而且**不抛回事件流**(抛了的话下面那句 emit 会炸)。
const bad = spec({ command: "definitely-not-a-real-command-xyz --nope", tag: "bad" });
writeHooks([bad]);
let threw = false;
try {
  rt.emit({
    type: "tool.use",
    sessionId: SESSION,
    toolName: "Write",
    toolCallId: "call_bad",
    input: {},
    requiresApproval: false,
  } satisfies RuntimeEvent);
} catch {
  threw = true;
}
check("命令起不来也没有异常抛回事件流", !threw);
await until(
  "那条记成了 failed",
  () => hookRunner.listRuns().some((r) => r.hookId === bad.id && r.status === "failed"),
);
const badRun = hookRunner.listRuns().find((r) => r.hookId === bad.id);
check("failed 那条带了原因", (badRun?.error ?? "").length > 0, badRun?.error);

// 会话没了(删了 / 是别的进程留下的)→ 整条事件跳过,不该起进程。
const i = makeCmd({ tag: "no-session" });
const hookI = spec({ command: i.command, tag: "no-session" });
writeHooks([hookI]);
rt.emit({
  type: "tool.use",
  sessionId: "sess_does_not_exist",
  toolName: "Write",
  toolCallId: "call_ghost",
  input: {},
  requiresApproval: false,
} satisfies RuntimeEvent);
await new Promise((r) => setTimeout(r, 600));
eq("会话查不到 → 不跑", i.hits(), 0);

/* ──────────────── 收尾 ──────────────── */

/* ──────────────── 7. 主语是纯的,事实是有状态的 ──────────────── */

console.log("\noneEvent → 事实一次、主语可以算很多遍");

// 这条盯的是 `automationRunner` 那个 bug 的形状:它对**每条触发器**各问一次主语,而
// 问主语早先顺带消费了"`tool.result` 的工具名"那份状态 —— 于是第一条触发器取走工具名,
// 后面几条拿到空,带 `matcher` 的**安静地不响**。修法是把 `eventSubjects` 拆成两半:
// 有状态的 `factsOf`(一次事件只调一次)和纯的 `subjectsOf`(想算几遍算几遍)。
//
// 这里直接对着那个模块验 —— 它是钩子和自动化**共用**的那一份(`automation-smoke` 里
// 也有一条同形状的,两边都钉住)。
const { createEventSubjects } = await import("@main/hooks/eventSubjects.js");
{
  const es = createEventSubjects();
  const use = {
    type: "tool.use",
    sessionId: "s",
    toolName: "Write",
    toolCallId: "c9",
    input: {},
    requiresApproval: false,
  } as unknown as RuntimeEvent;
  const result = {
    type: "tool.result",
    sessionId: "s",
    toolCallId: "c9",
    isError: false,
    content: "ok",
  } as unknown as RuntimeEvent;

  const facts = es.factsOf(use);
  eq("tool.use 的事实里有工具名", facts.toolName, "Write");
  // 主语是纯的:同一个结果事件、不同 cwd 各算一遍,每一遍都该拿到那个工具名。
  eq("第一遍主语", (es.subjectsOf(result, "D:/a", facts.toolName) ?? []).join(), "Write");
  eq("第二遍主语还是它(纯的)", (es.subjectsOf(result, "D:/b", facts.toolName) ?? []).join(), "Write");

  // 对照:`factsOf` 对 `tool.result` 是**回查即消费**的。所以"每条触发器各调一次
  // factsOf"的做法下,第一条拿到工具名,后面几条拿到空 —— 这就是那个 bug 的形状,
  // 也正是 `automationRunner` 现在只调一次、把结果传给纯的 `subjectsOf` 的原因。
  const es2 = createEventSubjects();
  es2.factsOf(use);
  eq("第一次回查拿到工具名", es2.factsOf(result).toolName, "Write");
  eq("第二次回查就没有了(消费过了)", es2.factsOf(result).toolName, undefined);

  // 路径主语那条路与工具名无关,算几遍都一样(cwd 不同结果不同,这是**对的**)。
  const files = {
    type: "turn.files",
    sessionId: "s",
    files: [{ filePath: join(WORK, "src", "a.ts") }],
  } as unknown as RuntimeEvent;
  const s1 = es.subjectsOf(files, WORK, undefined) ?? [];
  check("路径主语给出相对路径那一份", s1.includes("src/a.ts"), s1);
  eq("同一个 cwd 再算一遍结果一样", JSON.stringify(es.subjectsOf(files, WORK, undefined)), JSON.stringify(s1));
}


/* ──────────────── 8. 不属于任何会话的两条资料库事件 ──────────────── */

console.log("\n资料库事件(合成哨兵 \"(system)\" 那一路)");

// 「导入」与「下载完」都**不属于任何对话** —— 它们可能来自用户点界面、AI 的 MCP 工具、
// 或者后台下载线程。会话查不到不等于事件丢了,所以 HookRunner 对哨兵有一条专门的放行
// (见 `onEvent` 里那段)。这条放行是这两个事件**唯一**的活路:少了它,
// `sessionFacts` 返回 null,整条事件在查会话那一步就被丢掉 —— 而表现是"钩子安静地不响",
// 用户配得好好的、一个字都不报。
//
// 用户要的用法正是这个:**不让软件写死"下载完就转录"**,而是让他在钩子里自己写一条。
const sysHook = makeCmd({ tag: "downloaded" });
writeHooks([
  spec({ command: sysHook.command, tag: "downloaded", event: "library.item.downloaded" }),
]);
rt.emit({
  type: "library.item.downloaded",
  sessionId: "(system)",
  itemId: "lib_item_smoke",
  kind: "paper",
  title: "刚下完的那一篇",
  pdfPath: "papers/ab/abcdef.pdf",
} as unknown as RuntimeEvent);
await until("下载完的事件触发了钩子", () => sysHook.hits() === 1);
eq("资料库事件(不属于任何会话)照样能触发", sysHook.hits(), 1);

// 收尾前先把这条钩子撤掉 —— 它听着一个哨兵事件,留着会影响下面的断言阅读。
writeHooks([]);

/* ──────────────── 9. 订阅边界不能泄漏异步拒绝 ──────────────── */

console.log("\n异步分发故障注入");
// Intentionally fail BEFORE runOne's per-hook catch: a synchronous try/catch
// around an async onEvent call cannot see this rejection. A real event still
// must return normally, log the error, and not emit unhandledRejection.
const dispatch = hookRunner as unknown as { onEvent(e: RuntimeEvent): Promise<void> };
const originalDispatch = dispatch.onEvent;
const { log } = await import("@main/lib/logger.js");
const originalWarn = log.warn;
const warnings: string[] = [];
let unhandled = 0;
const countUnhandled = () => { unhandled += 1; };
process.on("unhandledRejection", countUnhandled);
try {
  dispatch.onEvent = async () => { throw new Error("injected hook dispatch rejection"); };
  log.warn = (message: string) => {
    warnings.push(message);
    originalWarn(message);
  };
  rt.emit({ type: "tool.use", sessionId: SESSION, toolName: "Write", toolCallId: "call_reject", input: {}, requiresApproval: false } satisfies RuntimeEvent);
  await new Promise((r) => setTimeout(r, 30));
  eq("分发拒绝不成为未处理 rejection", unhandled, 0);
  check("分发拒绝留下日志", warnings.some((m) => m.includes("injected hook dispatch rejection")), warnings);
} finally {
  dispatch.onEvent = originalDispatch;
  log.warn = originalWarn;
  process.off("unhandledRejection", countUnhandled);
}

check("hooks.json 确实落在(临时)数据根下", hooksFilePath().startsWith(DATA));

/* ──────────────── 10. 交付策略矩阵(ARC-007) ──────────────── */

console.log("\n交付策略矩阵(同一钩子一秒内 100 次)");

// 先对着**纯函数**把四种策略的判据钉死 —— 快、确定、不依赖进程调度。集成矩阵(下面)
// 再走真进程验端到端。两处一起,才既能看到"判据对不对",又能看到"判据真的驱动物理行为"。
{
  const p = (over: Partial<DeliveryPolicy>): DeliveryPolicy => ({ ...DEFAULT_DELIVERY_POLICY, ...over });
  eq("空闲 → accept", decideDelivery(p({ kind: "BEST_EFFORT" }), { inFlight: 0, coalescePending: false }).action, "accept");
  eq("到上限 → BEST_EFFORT 丢", decideDelivery(p({ kind: "BEST_EFFORT" }), { inFlight: 1, coalescePending: false }).action, "drop");
  eq("到上限 → AT_MOST_ONCE 丢(不重复)", decideDelivery(p({ kind: "AT_MOST_ONCE" }), { inFlight: 1, coalescePending: false }).action, "drop");
  eq("到上限 → COALESCE 合并", decideDelivery(p({ kind: "COALESCE" }), { inFlight: 1, coalescePending: false }).action, "coalesce");
  eq("已有待合并 → COALESCE 并进去", decideDelivery(p({ kind: "COALESCE" }), { inFlight: 1, coalescePending: true }).action, "coalesce");
  eq("上限 3、在跑 2 → accept(没到上限不丢)", decideDelivery(p({ kind: "BEST_EFFORT", maxConcurrency: 3 }), { inFlight: 2, coalescePending: false }).action, "accept");
  const dur = decideDelivery(p({ kind: "DURABLE_AT_LEAST_ONCE" }), { inFlight: 0, coalescePending: false });
  eq("DURABLE 本版不支持(明确报,不假装已持久化)", dur.action, "unsupported");
  check("不支持的理由说清楚了", dur.reason.includes("尚未支持"), dur.reason);
}

/** 跑一行矩阵:同一个钩子、一条慢命令,一秒内触发 `n` 次,回读数与计数。 */
async function matrixRun(
  tag: string,
  deliveryPolicy: DeliveryPolicy | undefined,
  n: number,
): Promise<{ hits: number; counts: { accepted: number; dropped: number; coalesced: number; unsupported: number }; hookId: string }> {
  const cmd = makeCmd({ tag, sleepMs: 1200 });
  const rowSpec = spec({ command: cmd.command, tag, ...(deliveryPolicy !== undefined ? { deliveryPolicy } : {}) });
  // ⚠️ mtime 变了才会重读 hooks.json(section 5 用的是同一个判据)。这不是"随便等" ——
  // 时间戳分辨率不够时,`writeHooks` 的新内容不会生效,这一行就会**用上一个钩子**去跑,
  // 断言看起来绿其实是假的。所以照 section 5 的做法等足一秒。
  await new Promise((r) => setTimeout(r, 1100));
  writeHooks([rowSpec]);
  for (let i = 0; i < n; i += 1) {
    rt.emit({
      type: "tool.use",
      sessionId: SESSION,
      toolName: "Write",
      toolCallId: `${tag}_${i}`,
      input: {},
      requiresApproval: false,
    } satisfies RuntimeEvent);
  }
  // 等这一行**落定**:要么第一条真的起来了(DURABLE 之外),要么已经记下了 unsupported
  // (DURABLE)。**不能只等 hits ≥ 1** —— DURABLE 一个进程都不起,等它只会白等超时。
  await until(
    `${tag} 落定(起过进程 或 记下 unsupported)`,
    () => cmd.hits() >= 1 || (hookRunner.deliveryCountsOf(rowSpec.id)?.unsupported ?? 0) > 0,
    8000,
  );
  // 再等一会儿,让慢钩子收口(以及 COALESCE 的合并兑现)落地。
  await new Promise((r) => setTimeout(r, 1800));
  return {
    hits: cmd.hits(),
    hookId: rowSpec.id,
    counts: hookRunner.deliveryCountsOf(rowSpec.id) ?? { accepted: 0, dropped: 0, coalesced: 0, unsupported: 0 },
  };
}

// ── BEST_EFFORT(也是**没声明策略时的默认**)—— 可丢,但丢要**数得出来**。
{
  const r = await matrixRun("mx-best", { kind: "BEST_EFFORT", maxConcurrency: 1 }, 100);
  eq("BEST_EFFORT:只起 1 个进程", r.hits, 1);
  eq("BEST_EFFORT:accepted 计数 1", r.counts.accepted, 1);
  eq("BEST_EFFORT:dropped 计数 99(丢是明账,不是悄悄丢)", r.counts.dropped, 99);
  eq("BEST_EFFORT:没有 coalesce / unsupported", r.counts.coalesced + r.counts.unsupported, 0);
}
// 省略 deliveryPolicy === 今天的默认行为:同一形状(1 跑 99 丢)。
{
  const r = await matrixRun("mx-default", undefined, 100);
  eq("未声明策略 = 今天的行为(1 跑 99 丢)", `${r.hits}/${r.counts.dropped}`, "1/99");
}

// ── maxConcurrency > 1 —— **旧行为做不到的那条红线**。旧的"同一条钩子同时只跑一个进程"
//    是一张 `Set`,它对"上限 2"根本没有表达位置:无论怎么配,它永远只放行 1 个。所以
//    "上限 2 → 恰好 2 个并发"这条断言,**在旧的 Set 实现下必红** —— 它才是这次改动
//    真正新增的能力,而不是"把已有的默认换个写法"。
{
  const r = await matrixRun("mx-conc2", { kind: "BEST_EFFORT", maxConcurrency: 2 }, 100);
  eq("maxConcurrency=2 → 恰好 2 个并发(旧 Set 只给 1)", r.hits, 2);
  eq("上限 2:accepted 2", r.counts.accepted, 2);
  eq("上限 2:其余 98 丢", r.counts.dropped, 98);
}

// ── AT_MOST_ONCE —— 不可重复(只 1 个),允许明确丢。
{
  const r = await matrixRun("mx-atmost", { kind: "AT_MOST_ONCE", maxConcurrency: 1 }, 100);
  eq("AT_MOST_ONCE:不重复,只 1 个进程", r.hits, 1);
  eq("AT_MOST_ONCE:accepted 1", r.counts.accepted, 1);
  eq("AT_MOST_ONCE:其余明确丢(99)", r.counts.dropped, 99);
}

// ── COALESCE —— 形成**有界**运行:1 个在跑 + 攒着的合并**兑现 1 次** = 2。这是与旧行为
//    (Skip-while-running 只给 1)的**分界**:旧实现那 99 条只是被丢,合并批次永远跑不出来。
{
  const r = await matrixRun("mx-coalesce", { kind: "COALESCE", maxConcurrency: 1 }, 100);
  eq("COALESCE:形成有界运行(1 在跑 + 1 合并兑现 = 2)", r.hits, 2);
  eq("COALESCE:accepted 2", r.counts.accepted, 2);
  eq("COALESCE:99 条并进了合并(coalesced,不是丢)", r.counts.coalesced, 99);
  eq("COALESCE:没有丢(dropped 0)", r.counts.dropped, 0);
}

// ── DURABLE_AT_LEAST_ONCE —— 本版**尚未支持**:明确报出来,不起进程,不假装已持久化。
{
  const r = await matrixRun("mx-durable", { kind: "DURABLE_AT_LEAST_ONCE" }, 100);
  eq("DURABLE:一个进程都不起(不假装跑过)", r.hits, 0);
  eq("DURABLE:100 条全记 unsupported", r.counts.unsupported, 100);
  eq("DURABLE:accepted 仍是 0", r.counts.accepted, 0);
  const runs = hookRunner.listRuns().filter((x) => x.hookId === r.hookId);
  check("DURABLE:环里那条说了「尚未支持」", runs.some((x) => (x.error ?? "").includes("尚未支持")), runs.map((x) => x.error).slice(0, 2));
}

// 矩阵跑完把钩子清掉,别让后面的收尾读到它。
writeHooks([]);

/* ──────────────── 11. 失败重试(retryBudget,ARC-007) ──────────────── */

console.log("\n失败重试(retryBudget):失败的 hook 在预算内重试,超预算才落终态");

// 先对着纯函数把判据钉死 —— 快、确定、不依赖进程调度与计时。
{
  // 语义:总尝试上限(含第一次)。budget=3 → 第 1、2 次失败可重试,第 3 次失败落终态。
  eq("budget 省略=1:第一次失败就不再试", decideRetry({ attempts: 1, retryBudget: undefined, failed: true }).retry, false);
  eq("budget=3:第 1 次失败 → 重试", decideRetry({ attempts: 1, retryBudget: 3, failed: true }).retry, true);
  eq("budget=3:第 2 次失败 → 重试", decideRetry({ attempts: 2, retryBudget: 3, failed: true }).retry, true);
  eq("budget=3:第 3 次失败 → 落终态(超预算)", decideRetry({ attempts: 3, retryBudget: 3, failed: true }).retry, false);
  eq("budget=0:一次都不跑(等价于不重试,但立即终态)", decideRetry({ attempts: 1, retryBudget: 0, failed: true }).retry, false);
  // **超时 / 起不来不重试** —— 它们不是 `failed`(判据只认退非零那种暂时性失败)。
  eq("timeout(非 failed)→ 不重试", decideRetry({ attempts: 1, retryBudget: 5, failed: false }).retry, false);
  check("非失败终态的理由说清楚了", decideRetry({ attempts: 1, retryBudget: 5, failed: false }).reason.includes("不自动重试"));
  check("落终态的理由带上了预算数字", decideRetry({ attempts: 3, retryBudget: 3, failed: true }).reason.includes("3 / 3"));
}

/** 造一条「先失败 N 次、之后成功」的钩子:每次跑把计数加一,计数 ≤ failTimes 时退非零。 */
function makeFlakyCmd(opts: { tag: string; failTimes: number }): { command: string; hits: () => number; attempts: () => number } {
  cmdSeq += 1;
  const marker = join(WORK, `hits-${opts.tag}.txt`);
  const counter = join(WORK, `count-${opts.tag}.txt`);
  const script = join(WORK, `hook-${opts.tag}.js`);
  writeFileSync(
    script,
    [
      `const fs = require("node:fs");`,
      `const [file, countFile, failTimes] = process.argv.slice(2);`,
      `let n = 0;`,
      `try { n = Number(fs.readFileSync(countFile, "utf8")) || 0; } catch {}`,
      `n += 1;`,
      `fs.writeFileSync(countFile, String(n));`,
      `fs.appendFileSync(file, "x");`,
      `process.exit(n <= Number(failTimes) ? 1 : 0);`,
    ].join("\n"),
    "utf8",
  );
  return {
    command: `node "${script}" "${marker}" "${counter}" ${opts.failTimes}`,
    hits: () => (existsSync(marker) ? readFileSync(marker, "utf8").length : 0),
    attempts: () => (existsSync(counter) ? Number(readFileSync(counter, "utf8")) || 0 : 0),
  };
}

/** 造一条**真的会挂住**的钩子:跑起来就一直不退出(用来验"超时不重试")。 */
function makeHangCmd(tag: string): { command: string; hits: () => number } {
  cmdSeq += 1;
  const marker = join(WORK, `hits-${tag}.txt`);
  const script = join(WORK, `hook-${tag}.js`);
  writeFileSync(
    script,
    [
      `const fs = require("node:fs");`,
      `const [file] = process.argv.slice(2);`,
      `fs.appendFileSync(file, "x");`,
      `setInterval(() => {}, 1000);`, // 永不退出,只能被超时杀掉
    ].join("\n"),
    "utf8",
  );
  return {
    command: `node "${script}" "${marker}"`,
    hits: () => (existsSync(marker) ? readFileSync(marker, "utf8").length : 0),
  };
}

// 起进程都是异步的(onEvent 不 await),拿一个钩子 id 轮询它的 retried / accepted 计数。
async function untilCounts(what: string, hookId: string, cond: (c: { accepted: number; dropped: number; coalesced: number; unsupported: number; retried: number }) => boolean, ms = 8000): Promise<void> {
  await until(what, () => cond(hookRunner.deliveryCountsOf(hookId) ?? { accepted: 0, dropped: 0, coalesced: 0, unsupported: 0, retried: 0 }), ms);
}

// ── retryBudget=3 —— 先失败 2 次、第 3 次成功:进程真的起了 3 回(重试接线了)。
{
  await new Promise((r) => setTimeout(r, 1100));
  const cmd = makeFlakyCmd({ tag: "mx-retry3", failTimes: 2 });
  const hook = spec({ command: cmd.command, tag: "mx-retry3", deliveryPolicy: { kind: "BEST_EFFORT", maxConcurrency: 1, retryBudget: 3 } });
  writeHooks([hook]);
  rt.emit({ type: "tool.use", sessionId: SESSION, toolName: "Write", toolCallId: "call_retry3", input: {}, requiresApproval: false } satisfies RuntimeEvent);
  await until("retry3:最终一次落成 ok(2 失败 + 1 成功)", () => hookRunner.listRuns().some((r) => r.hookId === hook.id && r.status === "ok"), 10000);
  await untilCounts("retry3:accepted 记到 3", hook.id, (c) => c.accepted >= 3, 4000);
  eq("retryBudget=3:命令真的跑了 3 次(重试接线了)", cmd.attempts(), 3);
  eq("retryBudget=3:accepted 计数 3(每次重试都算一次真起进程)", hookRunner.deliveryCountsOf(hook.id)?.accepted, 3);
  eq("retryBudget=3:retried 计数 2(重试这件事本身可数)", hookRunner.deliveryCountsOf(hook.id)?.retried, 2);
  const finalRun = hookRunner.listRuns().find((r) => r.hookId === hook.id && r.status === "ok");
  check("retryBudget=3:最终那一次落成 ok(重试后成功)", finalRun !== undefined, hookRunner.listRuns().filter((r) => r.hookId === hook.id).map((r) => r.status));
}

// ── retryBudget=1(= 省略,今天的行为)—— 失败一次就落终态,不再试。
{
  await new Promise((r) => setTimeout(r, 1100));
  const cmd = makeFlakyCmd({ tag: "mx-retry1", failTimes: 9 });
  const hook = spec({ command: cmd.command, tag: "mx-retry1" }); // 不声明策略 = 默认
  writeHooks([hook]);
  rt.emit({ type: "tool.use", sessionId: SESSION, toolName: "Write", toolCallId: "call_retry1", input: {}, requiresApproval: false } satisfies RuntimeEvent);
  await until("retry1:第一次失败就落终态", () => hookRunner.listRuns().some((r) => r.hookId === hook.id && r.status === "failed"), 8000);
  await new Promise((r) => setTimeout(r, 800));
  eq("省略策略:失败只跑 1 次(不重试 = 今天的行为)", cmd.attempts(), 1);
  eq("省略策略:retried 计数 0", hookRunner.deliveryCountsOf(hook.id)?.retried, 0);
}

// ── retryBudget=2 —— 一直失败:跑满 2 次(不是无限),预算用尽落 failed。
{
  await new Promise((r) => setTimeout(r, 1100));
  const cmd = makeFlakyCmd({ tag: "mx-retry2", failTimes: 99 });
  const hook = spec({ command: cmd.command, tag: "mx-retry2", deliveryPolicy: { kind: "BEST_EFFORT", maxConcurrency: 1, retryBudget: 2 } });
  writeHooks([hook]);
  rt.emit({ type: "tool.use", sessionId: SESSION, toolName: "Write", toolCallId: "call_retry2", input: {}, requiresApproval: false } satisfies RuntimeEvent);
  await until("retry2:预算用尽(跑满 2 次)", () => hookRunner.deliveryCountsOf(hook.id)?.retried === 1 && cmd.attempts() >= 2, 10000);
  await new Promise((r) => setTimeout(r, 800));
  eq("retryBudget=2 且一直失败:只跑 2 次(有界,不无限重试)", cmd.attempts(), 2);
  eq("retryBudget=2:retried 计数 1", hookRunner.deliveryCountsOf(hook.id)?.retried, 1);
  const runs = hookRunner.listRuns().filter((r) => r.hookId === hook.id);
  check("retryBudget=2:最终落 failed(超预算才终态)", runs.some((r) => r.status === "failed"), runs.map((r) => r.status));
}

// ── 超时**不**重试:一个永远卡住的脚本,声明 retryBudget=5 也只跑 1 次。
{
  await new Promise((r) => setTimeout(r, 1100));
  const cmd = makeHangCmd("mx-retry-timeout");
  const hook = spec({
    command: cmd.command,
    tag: "mx-retry-timeout",
    timeoutMs: 300,
    deliveryPolicy: { kind: "BEST_EFFORT", maxConcurrency: 1, retryBudget: 5 },
  });
  writeHooks([hook]);
  rt.emit({ type: "tool.use", sessionId: SESSION, toolName: "Write", toolCallId: "call_retry_timeout", input: {}, requiresApproval: false } satisfies RuntimeEvent);
  await until("retry-timeout:记到 timeout", () => hookRunner.listRuns().some((r) => r.hookId === hook.id && r.status === "timeout"), 8000);
  await new Promise((r) => setTimeout(r, 1500));
  eq("超时不重试:即便 retryBudget=5,也只跑 1 次", cmd.hits(), 1);
  eq("超时不重试:retried 计数 0", hookRunner.deliveryCountsOf(hook.id)?.retried, 0);
}

/* ──────────────── 12. 输出上限(outputLimit,ARC-007) ──────────────── */

console.log("\n输出上限(outputLimit):策略声明的字节上限盖过全局常量");

// 一条**吐 `bytes` 个字节、不带换行**的命令。不带换行 = 走残行那一路,长度就是 bytes。
function makeBigCmd(tag: string, bytes: number): { command: string } {
  cmdSeq += 1;
  const script = join(WORK, `hook-${tag}.js`);
  writeFileSync(script, [`process.stdout.write("A".repeat(${bytes}));`].join("\n"), "utf8");
  return { command: `node "${script}"` };
}

// ── 策略 outputLimit=256 —— 命令吐 3000 字节:截断并**如实报生效上限与截断事实**。
//    这条断言在"恒用全局 HOOK_OUTPUT_LIMIT(8192)"的旧行为下**必红** —— 3000 < 8192,
//    旧行为一个字节都不丢、报不出 truncated。
{
  await new Promise((r) => setTimeout(r, 1100));
  const cmd = makeBigCmd("mx-outlimit-small", 3000);
  const hook = spec({
    command: cmd.command,
    tag: "mx-outlimit-small",
    deliveryPolicy: { kind: "BEST_EFFORT", maxConcurrency: 1, outputLimit: 256 },
  });
  writeHooks([hook]);
  rt.emit({ type: "tool.use", sessionId: SESSION, toolName: "Write", toolCallId: "call_outlimit_small", input: {}, requiresApproval: false } satisfies RuntimeEvent);
  await until("outlimit-small:落成 ok", () => hookRunner.listRuns().some((r) => r.hookId === hook.id && r.status === "ok"), 8000);
  const run = hookRunner.listRuns().find((r) => r.hookId === hook.id && r.status === "ok");
  check("outlimit-small:拿到了执行记录", run !== undefined, hookRunner.listRuns().filter((r) => r.hookId === hook.id).map((r) => r.status));
  eq("outputLimit=256:标记 truncated(有东西被丢)", run?.truncated, true);
  eq("outputLimit=256:如实报生效上限 256(不是全局 8192)", run?.outputLimitBytes, 256);
  check("outputLimit=256:截断说明写的是 256", (run?.stdout ?? "").includes("输出超过 256 字节"), (run?.stdout ?? "").slice(0, 60));
  check("outputLimit=256:stdout 有界(≈256 + 说明行)", (run?.stdout?.length ?? 0) > 0 && (run?.stdout?.length ?? 0) < 256 * 2, run?.stdout?.length);
}

// ── 省略策略 —— 仍用全局 HOOK_OUTPUT_LIMIT(8192):3000 字节**不**截断。这是"旧行为
//    不变"的正控:策略字段只在声明时才盖过全局常量。
{
  await new Promise((r) => setTimeout(r, 1100));
  const cmd = makeBigCmd("mx-outlimit-default", 3000);
  const hook = spec({ command: cmd.command, tag: "mx-outlimit-default" });
  writeHooks([hook]);
  rt.emit({ type: "tool.use", sessionId: SESSION, toolName: "Write", toolCallId: "call_outlimit_default", input: {}, requiresApproval: false } satisfies RuntimeEvent);
  await until("outlimit-default:落成 ok", () => hookRunner.listRuns().some((r) => r.hookId === hook.id && r.status === "ok"), 8000);
  const run = hookRunner.listRuns().find((r) => r.hookId === hook.id && r.status === "ok");
  check("outlimit-default:拿到了执行记录", run !== undefined, hookRunner.listRuns().filter((r) => r.hookId === hook.id).map((r) => r.status));
  eq("省略策略:3000 字节 < 8192,不截断", run?.truncated, undefined);
  eq("省略策略:stdout 全长 3000(策略字段没动它)", run?.stdout?.length, 3000);
}

/* ──────────────── 13. 去抖窗口(debounceMs,ARC-007) ──────────────── */

console.log("\n去抖窗口(debounceMs):COALESCE 在窗口内把连续触发合并成一次运行,窗口末尾兑现");

// 纯函数先钉住「去抖只对 COALESCE 生效」这条判据 —— 快、确定、不依赖计时器调度。
{
  const p = (over: Partial<DeliveryPolicy>): DeliveryPolicy => ({ ...DEFAULT_DELIVERY_POLICY, ...over });
  eq("COALESCE 省略 debounceMs → 0(零窗口 = 今天的行为)", coalesceWindowMs(p({ kind: "COALESCE" })), 0);
  eq("COALESCE + debounceMs=300 → 300(真去抖窗口)", coalesceWindowMs(p({ kind: "COALESCE", debounceMs: 300 })), 300);
  eq("COALESCE + debounceMs=0 → 0(显式零窗口)", coalesceWindowMs(p({ kind: "COALESCE", debounceMs: 0 })), 0);
  eq("BEST_EFFORT 声明 debounceMs 也无效(只有 COALESCE 有合并概念)", coalesceWindowMs(p({ kind: "BEST_EFFORT", debounceMs: 300 })), 0);
  eq("AT_MOST_ONCE 声明 debounceMs 无效", coalesceWindowMs(p({ kind: "AT_MOST_ONCE", debounceMs: 300 })), 0);
  eq("DURABLE 声明 debounceMs 无效", coalesceWindowMs(p({ kind: "DURABLE_AT_LEAST_ONCE", debounceMs: 300 })), 0);
}

// ── 承重红例:COALESCE + debounceMs=400,窗口内连发 5 次 —— **一条都没立即跑**,窗口
//    末尾只跑 1 次。旧行为(零窗口:空闲就立即 accept 起进程 + 忙时攒一次)下这一组必红:
//    第一条事件一到达就 accept(hits 立刻 ≥ 1),而 coalesced 也到不了 5。
{
  await new Promise((r) => setTimeout(r, 1100)); // mtime 变了才重读 hooks.json
  const cmd = makeCmd({ tag: "dbnc-merge" });
  const hook = spec({
    command: cmd.command,
    tag: "dbnc-merge",
    deliveryPolicy: { kind: "COALESCE", maxConcurrency: 1, debounceMs: 400 },
  });
  writeHooks([hook]);
  for (let i = 0; i < 5; i += 1) {
    rt.emit({
      type: "tool.use",
      sessionId: SESSION,
      toolName: "Write",
      toolCallId: `dbnc_merge_${i}`,
      input: {},
      requiresApproval: false,
    } satisfies RuntimeEvent);
  }
  // 窗口没到(才 150ms < 400ms):**一个进程都不该起** —— 这正是"去抖"与"立即跑"的分界。
  await new Promise((r) => setTimeout(r, 150));
  eq("窗口内:一条都没跑(攒着,不是每条都立即跑)", cmd.hits(), 0);
  await until("窗口末尾兑现一次", () => cmd.hits() >= 1, 4000);
  await new Promise((r) => setTimeout(r, 800)); // 若会多跑,这里该看见
  eq("5 次连续触发合并成 1 次运行", cmd.hits(), 1);
  eq("全部 5 条并入合并(coalesced=5)", hookRunner.deliveryCountsOf(hook.id)?.coalesced, 5);
  eq("实际只起 1 个进程(accepted=1)", hookRunner.deliveryCountsOf(hook.id)?.accepted, 1);
}

// ── 尾去抖:窗口**从最后一次触发起算** —— 窗口中途来的新事件把计时器重置,窗口末尾顺延。
//    这条把"固定窗口"和"尾去抖"分开:新事件到达时,原本的窗口(400ms)该到而未到,不能兑现。
{
  await new Promise((r) => setTimeout(r, 1100));
  const cmd = makeCmd({ tag: "dbnc-reset" });
  const hook = spec({
    command: cmd.command,
    tag: "dbnc-reset",
    deliveryPolicy: { kind: "COALESCE", maxConcurrency: 1, debounceMs: 400 },
  });
  writeHooks([hook]);
  const emitOne = (i: number) =>
    rt.emit({
      type: "tool.use",
      sessionId: SESSION,
      toolName: "Write",
      toolCallId: `dbnc_reset_${i}`,
      input: {},
      requiresApproval: false,
    } satisfies RuntimeEvent);
  emitOne(0); // t≈0:开窗
  await new Promise((r) => setTimeout(r, 300));
  eq("窗口中途:还没跑", cmd.hits(), 0);
  emitOne(1); // t≈300:重置窗口 → 该到 t≈700 才兑现
  await new Promise((r) => setTimeout(r, 200)); // t≈500:旧窗口(400)已过,重置窗口还没到
  eq("新事件把窗口重置(尾去抖:从最后一次触发起算)", cmd.hits(), 0);
  await until("重置后的窗口末尾兑现", () => cmd.hits() >= 1, 4000);
  await new Promise((r) => setTimeout(r, 800));
  eq("窗口顺延后仍只跑 1 次", cmd.hits(), 1);
}

// ── 正控:省略 debounceMs = 零窗口 = **今天的行为**(空闲立即跑,不额外等)。
{
  await new Promise((r) => setTimeout(r, 1100));
  const cmd = makeCmd({ tag: "dbnc-none" });
  const hook = spec({
    command: cmd.command,
    tag: "dbnc-none",
    deliveryPolicy: { kind: "COALESCE", maxConcurrency: 1 },
  });
  writeHooks([hook]);
  rt.emit({
    type: "tool.use",
    sessionId: SESSION,
    toolName: "Write",
    toolCallId: "dbnc_none_0",
    input: {},
    requiresApproval: false,
  } satisfies RuntimeEvent);
  await until("省略 debounceMs:事件到达就立刻跑", () => cmd.hits() === 1, 3000);
  eq("省略 debounceMs = 零窗口:空闲立即跑(今天的行为不变)", cmd.hits(), 1);
}

writeHooks([]);

/* ──────────────── 14. 插件 hook 的授权消费(MC-061) ──────────────── */

console.log("\n插件 hook:授权判定**真的驱动执行**(默认拒绝)");

// 这一节是 MC-061 执行通道的**承重红例**:此前 `HookRunner` 只认 `hooks.json`(用户手写),
// 插件携带的 hook 永远不执行。现在宿主在每条事件上读启用插件声明的 hook,逐条走**唯一**判定
// 落点 `decidePluginHookExecution` —— 不 `granted` 的一律不跑,并记一条带原因的 skipped。
//
// 接缝是 `setPluginHookSource`:脚本喂一份固定声明(不真装插件),于是能验「判定真的驱动
// 物理行为」—— 授权为假时**一个进程都不起**,授权为真时才起。
const { issueHostHookGrant, revokeHostHookGrants, resetHostHookGrants } = await import(
  "@main/hooks/hostHookGrants.js"
);
const { pluginHookSpecsFrom } = await import("@main/hooks/pluginHooks.js");

resetHostHookGrants();
const phCmd = makeCmd({ tag: "plugin-hook" });
const pluginDecls = [
  { pluginId: "demo-plugin", version: "1.0.0", nativeEvent: "PreToolUse", command: phCmd.command },
];
// 候选的身份来自同一份构造(命令摘要 / 插件 / 版本),断言按它取 id。
const pluginEntry = pluginHookSpecsFrom(pluginDecls)[0];
const pluginHookId = pluginEntry.spec.id;
hookRunner.setPluginHookSource(() => pluginDecls);

// ── 默认拒绝:没授权 → **不跑**,而且**记一条 skipped + denied 计数**(不是静默丢掉)。
rt.emit({
  type: "tool.use",
  sessionId: SESSION,
  toolName: "Write",
  toolCallId: "ph_deny",
  input: {},
  requiresApproval: false,
} satisfies RuntimeEvent);
// 固定等待(不用 `until` —— 它等不到会抛、把运行整个中止;这里要的是**断言**变红,
// 而不是"测试跑不下去"):若会误跑,这里该看见进程;记账也该落定。
await new Promise((r) => setTimeout(r, 800));
eq("默认拒绝:未授权的插件 hook 一个进程都不起", phCmd.hits(), 0);
eq("默认拒绝:denied 计数 1", hookRunner.deliveryCountsOf(pluginHookId)?.denied, 1);
{
  const skipped = hookRunner.listRuns().find((r) => r.hookId === pluginHookId && r.status === "skipped");
  check("默认拒绝:环里那条记成了 skipped(不是悄悄丢掉)", skipped !== undefined, hookRunner.listRuns().filter((r) => r.hookId === pluginHookId).map((r) => r.status));
  check("默认拒绝:skipped 那条说了原因(引到授权上)", (skipped?.error ?? "").includes("授权"), skipped?.error);
}

// ── 签发覆盖这份来源的授权 → **真跑一次**(正控:判定放行时物理行为随之发生)。
issueHostHookGrant({ pluginId: "demo-plugin", version: "1.0.0", ttlMs: 600_000, now: Date.now() });
rt.emit({
  type: "tool.use",
  sessionId: SESSION,
  toolName: "Write",
  toolCallId: "ph_allow",
  input: {},
  requiresApproval: false,
} satisfies RuntimeEvent);
await until("授权后插件 hook 真跑了一次", () => phCmd.hits() === 1, 4000);
eq("有有效授权 → 真跑(判定放行驱动了进程)", phCmd.hits(), 1);
eq("授权后:accepted 计数 1", hookRunner.deliveryCountsOf(pluginHookId)?.accepted, 1);
eq("授权后:denied 计数仍是 1(这一条没再被挡)", hookRunner.deliveryCountsOf(pluginHookId)?.denied, 1);

// ── 卸载同步撤权 → 又不跑(撤权是**即时**生效的,不是"下次重启")。
eq("按插件撤掉它的有效授权", revokeHostHookGrants("demo-plugin"), 1);
rt.emit({
  type: "tool.use",
  sessionId: SESSION,
  toolName: "Write",
  toolCallId: "ph_revoked",
  input: {},
  requiresApproval: false,
} satisfies RuntimeEvent);
await new Promise((r) => setTimeout(r, 800));
eq("撤权后:插件 hook 不再跑(仍是 1 次)", phCmd.hits(), 1);
eq("撤权后:denied 计数 2", hookRunner.deliveryCountsOf(pluginHookId)?.denied, 2);

// ── 【MC-061 复审修复】**并发拖尾**的 E2 时间窗口必须被堵住 ──
//
// 独立复审点名:授权在**事件到达**时判一次 `runOne`,而 `onEvent` 是**逐条 `await`** 的
// —— 第 1 条插件 hook 真正起进程(`await runHookCommand`)期间,用户完全可能**撤权**;等
// 轮到第 2 条时,它拿的是**旧判定**。`deliver` 真正 spawn 前若不**复验**,第 2 条就会在撤权
// 之后照跑。这里用**两条**匹配同一事件的插件 hook 复现:授权有效 → 第 1 条开跑 → 在它跑
// 的过程中撤权 → 断言第 2 条**一个进程都不起**,并记一条 denied。
{
  const { issueHostHookGrant, revokeHostHookGrants, resetHostHookGrants } = await import(
    "@main/hooks/hostHookGrants.js"
  );
  const { pluginHookSpecsFrom } = await import("@main/hooks/pluginHooks.js");
  resetHostHookGrants();

  // 第 1 条:慢命令(`sleepMs` 让 `runOne` 的 await 持续一会儿,给撤权留出真实时间窗)。
  const slowCmd = makeCmd({ tag: "race-slow", sleepMs: 1000 });
  // 第 2 条:快命令。它排在 slow 之后,轮到时授权已被撤。
  const fastCmd = makeCmd({ tag: "race-fast" });
  const decls2 = [
    { pluginId: "race-plugin", version: "2.0.0", nativeEvent: "PreToolUse", command: slowCmd.command },
    { pluginId: "race-plugin", version: "2.0.0", nativeEvent: "PreToolUse", command: fastCmd.command },
  ];
  const ids2 = pluginHookSpecsFrom(decls2).map((e) => e.spec.id);
  const fastId = pluginHookSpecsFrom(decls2)[1].spec.id;
  hookRunner.setPluginHookSource(() => decls2);
  issueHostHookGrant({ pluginId: "race-plugin", version: "2.0.0", ttlMs: 600_000, now: Date.now() });

  // 发事件 → onEvent 先 await 第 1 条(慢命令,sleep 1s);在它跑起来之后、第 2 条之前撤权。
  rt.emit({
    type: "tool.use",
    sessionId: SESSION,
    toolName: "Write",
    toolCallId: "ph_race",
    input: {},
    requiresApproval: false,
  } satisfies RuntimeEvent);
  await until("第 1 条(慢)先跑起来", () => slowCmd.hits() === 1, 4000);
  revokeHostHookGrants("race-plugin"); // 撤权发生在第 2 条真正 spawn **之前**
  await new Promise((r) => setTimeout(r, 1500)); // 等第 1 条 sleep 完、第 2 条轮到
  eq("★ 复审修复:第 1 条跑完后撤权 → 第 2 条进程一个都不起", fastCmd.hits(), 0);
  check("★ 复审修复:第 2 条记一条 denied(起进程前复验未通过)", (hookRunner.deliveryCountsOf(fastId)?.denied ?? 0) >= 1, hookRunner.deliveryCountsOf(fastId));
  check("正控:第 1 条(撤权前已在跑)确实跑了", slowCmd.hits() === 1, slowCmd.hits());

  hookRunner.setPluginHookSource(() => []);
  resetHostHookGrants();
}

/* ──────────────── 15. 主机 hook 授权:跨重启持久化(MC-061) ──────────────── */

console.log("\n主机 hook 授权:签发 / 撤销落盘,重启后仍生效");

// 台账 MC-061 的「HostHookGrant 未持久化」:此前授权表**纯内存**,进程一重启就空 ——
// 用户对某条插件 hook 的授信每次开机都得重签(把「默认拒绝」错当「永远拒绝」)。这一节
// 钉住「接上落盘后,签发 / 撤销都跨重启活着」;坏数据仍 fail-safe 退回空表(**仍默认拒绝**)。
//
// 接缝是 `configureHostHookGrantPersist`(可注入 load/save,与 ARC-004 的 GrantStore 同姿势)。
// 这里先用**内存 blob 桩**(绝不去碰用户数据根)测不变量,再用**真临时目录**证它真写到了磁盘。
{
  const {
    configureHostHookGrantPersist,
    issueHostHookGrant: issueP,
    revokeHostHookGrant: revokeP,
    resetHostHookGrants: resetP,
    listHostHookGrants: listP,
    decidePluginHookExecution: decideP,
  } = await import("@main/hooks/hostHookGrants.js");
  const {
    assembleHostHookGrantPersist,
    fileHostHookGrantPersist,
    hostHookGrantStorePath,
    parseHostHookGrants,
    serializeHostHookGrants,
  } = await import("@main/hooks/hostHookGrantFile.js");

  // 内存 blob 桩:`read` 回上次写的、`write` 覆盖 —— 充当可注入的 get/set,不碰磁盘。
  const memBlob = (): { read: () => string | null; write: (t: string) => void; peek: () => string | null } => {
    let text: string | null = null;
    return { read: () => text, write: (t: string) => { text = t; }, peek: () => text };
  };

  // ── 签发 → 落盘 → 用同一份 blob 重开(模拟重启)→ 仍取得到、仍 allowed。
  const blob = memBlob();
  configureHostHookGrantPersist(fileHostHookGrantPersist(blob));
  resetP(); // 清内存(确认干净起点;装配时已 load 过一次 —— 此刻 blob 尚空)
  const gP = issueP({ pluginId: "persist-plugin", version: "1.0.0", ttlMs: 600_000, now: Date.now() });
  check("持久化:签发即写真文件(blob 非空)", blob.peek() !== null && (blob.peek() ?? "").length > 0, (blob.peek() ?? "").slice(0, 5));

  const srcP = { pluginId: "persist-plugin", version: "1.0.0", commandDigest: "", nativeEvent: "PreToolUse" };
  // 模拟重启:同一份 blob 重新装配 → load() 载回。
  configureHostHookGrantPersist(fileHostHookGrantPersist(blob));
  eq("★ 持久化:重启后该授权仍在表里(不是空表)", listP().some((x) => x.grantId === gP.grantId), true);
  eq(
    "★ 持久化:重启后该来源仍 allowed(判据据载回的表放行,不是默认拒绝)",
    decideP(srcP, "tool.use", Date.now()).decide,
    "allowed",
  );
  eq("序列化:带 version 信封 + 原样带出 expiresAt", JSON.parse(serializeHostHookGrants([gP])).grants[0].expiresAt, gP.expiresAt);

  // ── 撤销 → 落盘 → 重启后仍 revoked(撤销跨重启生效)。
  eq("持久化:撤销返回 true", revokeP(gP.grantId), true);
  configureHostHookGrantPersist(fileHostHookGrantPersist(blob)); // 重启
  eq(
    "★ 持久化:撤销后重启该授权仍 revoked(带回来)",
    listP().find((x) => x.grantId === gP.grantId)?.revoked,
    true,
  );
  eq("★ 持久化:撤销后重启该来源仍 denied", decideP(srcP, "tool.use", Date.now()).decide, "denied");

  // ── 坏数据 → 空表(fail-safe),**不崩**,且仍默认拒绝(绝不把读不懂的当成「全部允许」)。
  eq("坏数据:非 JSON → 空", parseHostHookGrants("{ not json").length, 0);
  eq("坏数据:null(文件不存在)→ 空", parseHostHookGrants(null).length, 0);
  eq("坏数据:版本不符 → 空", parseHostHookGrants(JSON.stringify({ version: 999, grants: [gP] })).length, 0);
  eq("坏数据:grants 不是数组 → 空", parseHostHookGrants(JSON.stringify({ version: 1, grants: "nope" })).length, 0);
  // 逐条:形状对的那条留下,形状不对的丢掉(丢一条授权只会收紧)。
  const mixed = JSON.stringify({ version: 1, grants: [gP, { grantId: 42 }, null] });
  eq("坏数据:混入坏条目 → 只留合法那条", parseHostHookGrants(mixed).length, 1);
  const badBlob = { read: () => "{ broken", write: () => {} };
  configureHostHookGrantPersist(fileHostHookGrantPersist(badBlob));
  eq("★ 坏数据:坏文件重开后 → 空表(仍默认拒绝)", decideP(srcP, "tool.use", Date.now()).decide, "denied");

  // ── **真落盘**:走 `atomicFileBlob` + 临时目录(不是用户数据根),证它真写到磁盘。
  const dirP = mkdtempSync(join(tmpdir(), "mcode-hosthook-grants-"));
  assembleHostHookGrantPersist(dirP);
  resetP();
  const gDisk = issueP({ pluginId: "disk-plugin", version: "2.0.0", ttlMs: 600_000, now: Date.now() });
  const fileP = hostHookGrantStorePath(dirP);
  check("真落盘:文件真的在磁盘上", existsSync(fileP), fileP);
  check("真落盘:路径在 <数据根>/hooks/host-hook-grants.json 下", fileP.endsWith(join("hooks", "host-hook-grants.json")), fileP);
  // 重启:从同一数据根再装配 → 读回先前落盘的那份。
  assembleHostHookGrantPersist(dirP);
  eq("★ 真落盘:重启后仍取得到", listP().some((x) => x.grantId === gDisk.grantId), true);
  rmSync(dirP, { recursive: true, force: true });

  // ── 源码纪律:落盘层不 import electron / sql;落点只有一份事实源;复用 atomicWrite。 ──
  {
    const raw = readFileSync(join(process.cwd(), "src/main/hooks/hostHookGrantFile.ts"), "utf8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check("★ 落盘层不 import electron", !/from\s+"electron/.test(code));
    check(
      "★ 落盘层不 import sql.js / 存储层(授权不落 SettingRepo)",
      !/from\s+"[^"]*sql|require\("sql\.js|@main\/store|settingsStore|SettingRepo/.test(code),
    );
    // 落盘复用已有一份 `AtomicFileBlob`(tmp + rename),不另写文件 IO。
    check("★ 落盘层复用 grantStoreFile 的 atomicFileBlob(不另写一份文件 IO)", /atomicFileBlob/.test(code) && /grantStoreFile\.js/.test(code));
    // 落点由 hostHookGrantStorePath 决定(单一事实源)。
    check("★ 装配复用 hostHookGrantStorePath(落点单一事实源)", /hostHookGrantStorePath\(/.test(code));
  }

  // 收尾:把持久化复位回内存版(不泄漏到套件之外)。
  configureHostHookGrantPersist(undefined);
  resetP();
}

/* ──────────────── 16. 插件 hook 执行**落盘审计**(MC-061) ──────────────── */

// MC-061 点名的缺口:执行记录只进内存里 50 条的环 + 计数,**进程一关就没了**。
// 现在插件 hook 的每次执行(含被授权挡下的)落一行持久审计(见 `HookRunRepo` /
// `hook_runs` 表)。用户手写的钩子**不落**(那是用户自己的命令,不是不受信来源,
// 逐条落库是写放大换不到审计价值 —— 判据落在 `HookRunner.auditRun`)。
console.log("\n插件 hook:执行记录**落进 DB**(不只 50 条会被顶掉的环)");

const { HookRunRepo } = await import("@main/store/repositories.js");
{
  // 上面的 section 14 里 demo-plugin 那条 hook 既被授权放行(runOne → 真起进程)、
  // 也被默认拒绝过。
  const rows = HookRunRepo.listForHook(pluginHookId, 50);
  check("审计表里有这条插件 hook 的行(环会被顶掉,DB 不会)", rows.length >= 1, rows.length);

  const okRow = rows.find((r) => r.status === "ok");
  check("落了一条终态 ok(命令真的跑成了,不是停在 running)", okRow !== undefined, rows.map((r) => r.status));
  eq("审计行的插件来源身份 = demo-plugin", okRow?.pluginId, "demo-plugin");
  eq("审计行记了原生事件名 PreToolUse", okRow?.nativeEvent, "PreToolUse");
  eq("审计行的统一事件是 tool.use", okRow?.event, "tool.use");
  check("审计行的命令摘要是 sha256 指纹(改命令 = 新来源)", (okRow?.commandDigest ?? "").startsWith("sha256:"), okRow?.commandDigest);

  const deniedRow = rows.find((r) => r.status === "skipped" && (r.error ?? "").includes("授权"));
  check("被授权挡下的那次也落了盘(带原因)", deniedRow !== undefined, rows.map((r) => ({ s: r.status, e: r.error })));
  // 落定是**覆盖同一行**(同 runId upsert),不是多插一行 —— 不留悬空的 running 行。
  check("终态覆盖 running(同一 runId,不留悬空 running 行)", rows.every((r) => r.status !== "running"), rows.map((r) => r.status));

  // 用户手写的钩子不进审计表:hookA(`hooks.json` 里那条)的 id 在 DB 里查不到。
  eq("用户手写的钩子不进审计表(它是用户自己的命令)", HookRunRepo.listForHook(hookA.id, 50).length, 0);

  // 来源身份里**可查询的**投影列:命令摘要那一条被保存下来(不是只存 id)。
  check("审计行保存了来源身份的可查询投影(plugin_id / native_event)", okRow?.pluginId === "demo-plugin" && okRow?.nativeEvent === "PreToolUse", okRow);
}

/* ──────────────── 17. 插件 hook 的**执行次数预算**(MC-061) ──────────────── */

// 台账点名的「取消预算 (cancellation budget) for host hook execution」在这个语境里**就是**
// 「授权带次数上限」:一条挂在 `tool.use` 上的插件 hook 一轮能触发几十次,`ttlMs` 只限时间、
// **不限次数**。没有上限,"一次授信"就等于"24 小时内无限次执行不受信命令"。这条预算:
//   - **有界**:授权的 `maxRuns` 声明了上限;
//   - **可核**:超界即判 `exhausted`(不是 denied —— 事实不同:授过、用完了);
//   - **可停**:用尽后 `deliver` 里记账返回 false → **不起进程**,记一条带原因的 skipped。
// 判据与 ARC-004 的 `Grant.maxCount` 共用唯一一份 `countBudgetExhausted`(仓库硬规矩 2)。
console.log("\n插件 hook 执行次数预算:有界 / 可核 / 可停(用尽即停在物理上)");

const { issueHostHookGrant: issueBudget, resetHostHookGrants: resetBudget } = await import(
  "@main/hooks/hostHookGrants.js"
);
const { pluginHookSpecsFrom: specsFromBudget } = await import("@main/hooks/pluginHooks.js");
{
  // 从干净态起:只留这一个插件来源。
  hookRunner.setPluginHookSource(() => []);
  writeHooks([]);
  resetBudget();
  const bCmd = makeCmd({ tag: "budget-hook" });
  const bDecls = [{ pluginId: "budget-plugin", version: "1.0.0", nativeEvent: "PreToolUse", command: bCmd.command }];
  const bHookId = specsFromBudget(bDecls)[0].spec.id;
  hookRunner.setPluginHookSource(() => bDecls);

  // maxRuns=2:前两条事件各真跑一次,第三条被预算挡下。
  // maxRuns=2:前两条事件各真跑一次,第三条被预算挡下。
  issueBudget({ pluginId: "budget-plugin", version: "1.0.0", maxRuns: 2, ttlMs: 600_000, now: Date.now() });
  // ⚠️ `emit` 是同步的,`onEvent` 逐条 await:连着发三条时,第一条还在跑,后两条会被**并发
  // 上限 1** 挡成 dropped —— 那样测的就不是预算。而且命令**一写标记就继续**,标记出现 ≠ 进程
  // 已退出、`inFlight` 已释放。所以每条都要**等到它真落终态**(进程退出、槽位释放)再发下一条。
  const emitBudget = (callId: string): void =>
    rt.emit({ type: "tool.use", sessionId: SESSION, toolName: "Write", toolCallId: callId, input: {}, requiresApproval: false } satisfies RuntimeEvent);
  const settledCount = (): number =>
    hookRunner.listRuns().filter((r) => r.hookId === bHookId && r.status !== "running").length;
  // 第 1 条:真跑一次。
  emitBudget("budget_0");
  await until("第 1 条真跑一次并落终态", () => bCmd.hits() === 1 && settledCount() >= 1, 8000);
  await new Promise((r) => setTimeout(r, 150)); // 等 `inFlight` 槽位释放(终态略早于 finally)
  // 第 2 条:仍在预算内,再真跑一次。
  emitBudget("budget_1");
  await until("第 2 条真跑一次(预算内)", () => bCmd.hits() === 2 && settledCount() >= 2, 8000);
  await new Promise((r) => setTimeout(r, 150));
  // 第 3 条:预算已用尽 → 判 exhausted,不起进程。
  emitBudget("budget_2");
  await until("第 3 条落定(exhausted 计数出现)", () => (hookRunner.deliveryCountsOf(bHookId)?.budgetExhausted ?? 0) >= 1, 8000);
  await new Promise((r) => setTimeout(r, 400));
  // ★ 承重:上限 2 → 真的只起了 2 个进程(第 3 条**没起**——预算在物理上停住了它)。
  eq("★ maxRuns=2:真执行恰好 2 次(超出上限的第 3 条没起进程)", bCmd.hits(), 2);
  eq("预算内两条都记 accepted", hookRunner.deliveryCountsOf(bHookId)?.accepted, 2);
  eq("★ 超界那条记 budgetExhausted(不是 denied —— 事实不同)", hookRunner.deliveryCountsOf(bHookId)?.budgetExhausted, 1);
  eq("denied 计数为 0(它是「用尽」不是「未授信」)", hookRunner.deliveryCountsOf(bHookId)?.denied, 0);
  const exhaustedRun = hookRunner.listRuns().find((r) => r.hookId === bHookId && r.status === "skipped" && (r.error ?? "").includes("用尽"));
  check("超界那条落一条带原因的 skipped(不静默)", exhaustedRun !== undefined, hookRunner.listRuns().filter((r) => r.hookId === bHookId).map((r) => ({ s: r.status, e: r.error })));

  // **用尽后重新授权就救得回来**:重签一份(复用判据跳过已用尽的那份)→ 又能跑。
  const bCmd2 = makeCmd({ tag: "budget-hook-2" });
  const bDecls2 = [{ pluginId: "budget-plugin", version: "1.0.0", nativeEvent: "PreToolUse", command: bCmd2.command }];
  const bHookId2 = specsFromBudget(bDecls2)[0].spec.id;
  hookRunner.setPluginHookSource(() => bDecls2);
  // 发一条前先等**上一条真落终态**(命令一写标记就继续,而 `inFlight` 要到进程退出后才释放;
  // 不等就发,下一条会被**并发上限 1** 挡成 dropped —— 那测的就不是预算了)。见上面的同名说明。
  const settle2 = async (): Promise<void> => {
    await until(
      "上一条真落终态(inFlight 槽位释放)",
      () => !hookRunner.listRuns().some((r) => r.hookId === bHookId2 && r.status === "running"),
      4000,
    );
    await new Promise((r) => setTimeout(r, 120));
  };
  issueBudget({ pluginId: "budget-plugin", version: "1.0.0", maxRuns: 1, ttlMs: 600_000, now: Date.now() });
  rt.emit({ type: "tool.use", sessionId: SESSION, toolName: "Write", toolCallId: "budget_re1", input: {}, requiresApproval: false } satisfies RuntimeEvent);
  await until("重签后第 1 次跑起来", () => bCmd2.hits() === 1, 4000);
  await settle2();
  // 用尽:再一条 → 被挡。
  rt.emit({ type: "tool.use", sessionId: SESSION, toolName: "Write", toolCallId: "budget_re2", input: {}, requiresApproval: false } satisfies RuntimeEvent);
  await until("第 2 条被挡下(budgetExhausted)", () => (hookRunner.deliveryCountsOf(bHookId2)?.budgetExhausted ?? 0) >= 1, 4000);
  await new Promise((r) => setTimeout(r, 200));
  eq("maxRuns=1:只跑了 1 次,第 2 条没起", bCmd2.hits(), 1);
  // 重新授权(同一来源)→ 复用判据跳过已用尽那份 → 又能跑。
  issueBudget({ pluginId: "budget-plugin", version: "1.0.0", maxRuns: 1, ttlMs: 600_000, now: Date.now() });
  rt.emit({ type: "tool.use", sessionId: SESSION, toolName: "Write", toolCallId: "budget_re3", input: {}, requiresApproval: false } satisfies RuntimeEvent);
  await until("★ 重新授权后又能跑一次", () => bCmd2.hits() === 2, 4000);
  eq("★ 用尽后重签 → 该来源又能执行(救得回来)", bCmd2.hits(), 2);

  hookRunner.setPluginHookSource(() => []);
  resetBudget();
  writeHooks([]);
}

/* ──────────────── 18. 审计表的**有界轮转**(MC-061) ──────────────── */

// 台账另一条待办:`hook_runs` 审计的**读取 / 轮转**。读取已接到 `hooks.runs`(见
// `ipc/hooks.ts`);轮转是这条:「一条挂在 `tool.use` 上的插件 hook 一轮能落几十行,
// 不设上限迟早把库撑爆」。`HookRunRepo.prune(retain)` 只留最近 retain 行,返回删了几行。
console.log("\n审计表有界轮转(prune:只留最近 N 行)");

{
  const { HookRunRepo: Repo, HOOK_RUNS_RETAIN } = await import("@main/store/repositories.js");
  // 落 6 条审计行(不同 runId —— upsert 会覆盖同行,所以每条用新 id)。
  // ⚠️ `startedAt` 取一个**远未来**的基准:prune 按 `started_at DESC` 全局留最新的,而表里
  // 已经有很多条 `startedAt ≈ 现在` 的真行(§14/§16/§17 落的)。若这里用 1970,这 6 条就是
  // **全局最旧**,prune 会先把它们删掉 —— 断言测的就不是"留最近 N 条"了。
  const BASE = 9_000_000_000_000;
  const mkRow = (n: number) => ({
    runId: `hrun_rotate_${n}`,
    hookId: "ph_rotate",
    pluginId: "rotate-plugin",
    pluginVersion: null,
    nativeEvent: "PreToolUse",
    commandDigest: "sha256:rotate",
    matcherDigest: null,
    event: "tool.use",
    sessionId: SESSION,
    sessionKind: "chat",
    status: "ok",
    exitCode: 0,
    durationMs: 1,
    error: null,
    startedAt: BASE + n,
  });
  for (let n = 0; n < 6; n += 1) Repo.record(mkRow(n));
  check("落 6 条审计行后都在表里", Repo.listForHook("ph_rotate", 50).length === 6, Repo.listForHook("ph_rotate", 50).length);
  // 轮转到只留最近 2 条(全局)→ 这 6 条是全局最新的,故只留最近两条、其余全删(含表里
  // §14/§16/§17 落的那些旧行 —— prune 是**全局**保最近 N,不是按 hook 分组)。
  const beforeCount = Repo.list(10_000).length;
  const deleted = Repo.prune(2);
  eq("★ prune(2) 后全局只留最近 2 行", Repo.list(10_000).length, 2);
  eq("prune 返回删掉的条数(可断言轮转真发生了)", deleted, beforeCount - 2);
  check("prune 真的删了东西(不是 no-op)", deleted >= 4, deleted);
  const kept = Repo.listForHook("ph_rotate", 50).map((r) => r.runId).sort();
  eq("★ 留下的是**最近**的两条(丢最旧,保住排错窗口)", kept.join(","), "hrun_rotate_4,hrun_rotate_5");
  // 保留上限是有界的常量(不是无限账本)——
  check(`保留上限 HOOK_RUNS_RETAIN 是有限正数(${HOOK_RUNS_RETAIN})`, Number.isInteger(HOOK_RUNS_RETAIN) && HOOK_RUNS_RETAIN > 0, HOOK_RUNS_RETAIN);
  // 边界:prune(0) 清空该表(retain <= 0 合法,不静默扩成无限)。
  eq("prune(0) 清空该表", Repo.prune(0) >= 0 && Repo.list(50).length, 0);
}

rmSync(DATA, { recursive: true, force: true });
rmSync(WORK, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
