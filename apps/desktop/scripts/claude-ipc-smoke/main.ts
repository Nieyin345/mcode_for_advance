/**
 * Headless smoke for **`main/ipc/claude.ts`** —— 主对话那条 IPC。
 *
 * 594 行、25 个 handler,**零覆盖文件里最大的一个**,而它是整个软件的主干:用户每一次
 * 发消息、每一次批准工具、每一次回答问题、每一次撤回、每一次改会话设置都走这里。
 *
 * ## 这一套验什么、不验什么
 *
 * 这个文件一半是**引擎的传声筒**(参数原样转给 RuntimeManager),一半是**主进程自己的
 * 判断**。传声筒那半验了没意义;这一套全押在后半:
 *
 *   - 覆盖值谁赢(界面说的 vs 库里存的)
 *   - 什么该落盘、什么**只该活在内存里**(写错了就是"重启后设置被悄悄改回")
 *   - 什么时候该广播、什么时候**不该**(写错了就是手机端列表不刷新、或者闪一下)
 *   - 什么时候该拦住用户的消息、什么时候该放行
 *   - 认不出的请求 id 这条**静默**路径到底怎么走的
 *
 * ## 为什么走真的 handler
 *
 * `ipcMain` 的**记名替身**:调真的 `registerClaudeHandlers`,把它注册进去的那批函数按
 * channel 收下来,然后调**用户动作本身**。不起 Electron,也没有 preload。
 *
 * ⚠️ 复述一遍 handler 里的逻辑是**没用的** —— 那一套在有人改回老写法时照样全绿,因为
 * 套件从头到尾没碰过 handler 一行(`library-trash-smoke` 的文件头记过这个教训)。
 *
 * ## 数据
 *
 * 真 sqlite 库,数据根是 `mktemp -d`(run.sh 里设的 `MCODE_SMOKE_DATA_ROOT`)。
 * 跑完连目录一起删。
 *
 * Run: scripts/claude-ipc-smoke/run.sh
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

import { IPC, THEME_STYLE_SETTING_KEY } from "@contracts/ipc";
import type { Session } from "@contracts/session";
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, MessageRepo } from "@main/store/repositories.js";
import { registerClaudeHandlers } from "@main/ipc/claude.js";

import {
  approvals,
  bound,
  dismissed,
  injected,
  interrupts,
  notified,
  permissionModes,
  planApprovals,
  resetStub,
  rewinds,
  sendTurns,
  setDefaultResolve,
  setRewindResult,
  userAnswers,
} from "./stubs/runtimeManager.js";
import {
  cancelled,
  resetRunnerStub,
  setGraphRunIntent,
  setParkedTeardown,
  started,
  stoppedRuns,
  teardowns,
} from "./stubs/runner.js";
import {
  eventsOfType,
  resetSent,
  resetTitleBarPaints,
  sentChannels,
  titleBarOverlayPaints,
} from "./stubs/window.js";
import { resetTitleGen, titleGenCalls } from "./stubs/titleGen.js";
import { forkCalls, resetRegistryStub, setForkSupport } from "./stubs/providerRegistry.js";

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

function same(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ──────────────── 0. 建库 + 取真 handler ──────────────── */

const DATA = mkdtempSync(join(tmpdir(), "mcode-claude-ipc-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;
// ⚠️ `initDb()` 收 go 的参数、路径自己从 `dataRoot()` 取(那个桩读环境变量),
// 而且它是 **async** —— 不 await 的话第一句 `SessionRepo.create` 就撞上
// "getDb() called before initDb() resolved"。
await initDb();

const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (event: unknown, raw: unknown) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

registerClaudeHandlers(fakeIpc);

async function call<T = unknown>(channel: string, raw?: unknown): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`没有注册这个 channel: ${channel}`);
  return (await Promise.resolve(fn(null, raw))) as T;
}

/** 跑一个调用、把抛出来的话收下来(不抛时给空串)。 */
async function catching(channel: string, raw?: unknown): Promise<string> {
  try {
    await call(channel, raw);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

console.log("0. 脚手架自己(通道名对不对得上一件真事)");
check(`注册进来的 handler 有 ${handlers.size} 个(不是 0)`, handlers.size >= 20, handlers.size);
check("sendTurn 那个通道在", handlers.has(IPC.CLAUDE_SEND_TURN));
check("setting.set 那个通道在", handlers.has(IPC.SETTING_SET));
check("数据根是临时目录,不是用户的真库", process.env.MCODE_SMOKE_DATA_ROOT === DATA, DATA);

/* ──────────────── 1. 夹具 ──────────────── */

console.log("\n1. 建库与夹具");

const PROJECT_DIR = mkdtempSync(join(tmpdir(), "mcode-claude-ipc-projdir-"));
ProjectRepo.create({
  id: "p_smoke",
  name: "冒烟项目",
  path: PROJECT_DIR,
  archived: false,
  group: null,
  sortOrder: 0,
  pinnedAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
} as never);
const PID = "p_smoke";

let seq = 0;
const nid = (p: string): string => `${p}_${++seq}`;

/** 一份最小的会话行。字段清单照着 `sessionSchema.ts` 的列抄。 */
function mkSession(
  id: string,
  over: Partial<
    Pick<Session, "kind" | "title" | "parentSessionId" | "claudeSessionId" | "providerId">
  > = {},
): string {
  const now = Date.now();
  SessionRepo.create({
    id,
    projectId: PID,
    providerId: over.providerId ?? "claude-sdk",
    claudeSessionId: over.claudeSessionId ?? null,
    kind: over.kind ?? "chat",
    parentSessionId: over.parentSessionId ?? null,
    title: over.title ?? "New session",
    status: "idle",
    model: "",
    effort: "default",
    permissionMode: "default",
    workflowId: "default",
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
  } as unknown as Session);
  return id;
}

/** 一个干净的起点:每个场景开头都调,免得上一段的调用记到这一段头上。 */
function fresh(): void {
  resetStub();
  resetRunnerStub();
  resetSent();
  resetTitleGen();
}

/* ──────────────── 2. 会话创建 ──────────────── */

console.log("\n2. 新建会话 / 侧栏问答列表");

{
  fresh();
  const res = await call<{ session: { id: string; projectId: string } }>(IPC.CLAUDE_START_SESSION, {
    projectId: PID,
  });
  eq("新建会话落在指定的项目里", res.session.projectId, PID);

  const again = await call<{ session: { id: string } }>(IPC.CLAUDE_START_SESSION, {
    projectId: PID,
  });
  eq("同一个项目里再点一次「新建会话」是复用同一条(不堆空会话)", again.session.id, res.session.id);

  const parent = mkSession(nid("s_parent"), { title: "喂" });
  const list = await call<{ sessions: Array<{ id: string }> }>(IPC.CLAUDE_LIST_SIDE_CHATS, {
    parentSessionId: parent,
  });
  eq("还没有侧栏问答时列表是空的", list.sessions.length, 0);
}

/* ──────────────── 3. 发一轮:覆盖值谁赢 ──────────────── */

console.log("\n3. 发一轮 —— 界面说的覆盖值赢过库里存的");

{
  fresh();
  const s = mkSession(nid("s"));
  // 库里先存一个旧值,模拟"渲染端的 setModel 是火忘式、还没写完"。
  SessionRepo.updateSettings(s, { model: "库里存的旧模型", effort: "low" });

  const res = await call<{ session: { model: string; effort: string } }>(IPC.CLAUDE_SEND_TURN, {
    sessionId: s,
    prompt: "你好",
    model: "界面说的模型",
    effort: "high",
  });

  eq("传进来的 model 赢了库里那个", res.session.model, "界面说的模型");
  eq("传进来的 effort 也赢了", res.session.effort, "high");
  eq("那一轮真的派出去了", sendTurns.length, 1);
  eq("派出去的是同一句话", sendTurns[0]?.prompt, "你好");
  eq("跑在项目的目录里", sendTurns[0]?.cwd, PROJECT_DIR);
  eq("**覆盖值没有**写进库(它只活在这一次的内存快照里)", SessionRepo.get(s)?.model, "库里存的旧模型");
}

console.log("\n3b. providerId 是同一套规矩,理由不同(返回赢、落库不赢)");

{
  fresh();
  const s = mkSession(nid("s"), { providerId: "库里那个引擎" });
  const res = await call<{ session: { providerId: string } }>(IPC.CLAUDE_SEND_TURN, {
    sessionId: s,
    prompt: "你好",
    providerId: "这一次要用的引擎",
  });
  eq(
    "返回给渲染端的是**这一次**的引擎(否则线程图标会画错)",
    res.session.providerId,
    "这一次要用的引擎",
  );
  eq(
    "库里仍然是原来那个(每会话「首条消息后锁定引擎」的规矩靠这个)",
    SessionRepo.get(s)?.providerId,
    "库里那个引擎",
  );
}

console.log("\n3c. 状态与绑定");

{
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.CLAUDE_SEND_TURN, { sessionId: s, prompt: "你好" });
  eq("发出去之后这个会话是 running", SessionRepo.get(s)?.status, "running");
  check("把会话交给了运行时(那一轮的桥要有它)", bound.includes(s), bound);
}

/* ──────────────── 4. 首条消息:标题、广播、子会话不广播 ──────────────── */

console.log("\n4. 首条消息 —— 标题截断与「该不该广播」");

{
  fresh();
  const s = mkSession(nid("s"));
  const res = await call<{ session: { title: string } }>(IPC.CLAUDE_SEND_TURN, {
    sessionId: s,
    prompt: "一".repeat(60),
  });
  eq("标题是前 40 个字加省略号", res.session.title, "一".repeat(40) + "…");
  eq("标题落库了", SessionRepo.get(s)?.title, "一".repeat(40) + "…");
  eq(
    "普通会话改了标题要广播(手机端的列表靠它)",
    eventsOfType("session.changed").length,
    1,
  );
  eq("广播走的是 claude:event 那条流", sentChannels()[0], "claude:event");
  eq("首条消息要起标题(火忘式那条)", titleGenCalls.length, 1);
}

{
  // side 会话(侧栏问答)是"用户看不见的会话",它**不许**广播。
  fresh();
  const s = mkSession(nid("s_side"), { kind: "side", title: "Quick ask" });
  const res = await call<{ session: { title: string } }>(IPC.CLAUDE_SEND_TURN, {
    sessionId: s,
    prompt: "帮我查一下这个",
  });
  eq("侧栏问答也会把自己的占位标题改掉", res.session.title, "帮我查一下这个");
  eq(
    "但**不**广播(它不在左栏/手机端的列表里,广播了会闪一下)",
    eventsOfType("session.changed").length,
    0,
  );
}

{
  fresh();
  const s = mkSession(nid("s"), { title: "我自己起的标题" });
  await call(IPC.CLAUDE_SEND_TURN, { sessionId: s, prompt: "随便说点什么" });
  eq("用户自己起过的标题不被覆盖", SessionRepo.get(s)?.title, "我自己起的标题");
  eq("标题没改就不广播", eventsOfType("session.changed").length, 0);
  eq("也没去问模型要标题", titleGenCalls.length, 0);
}

console.log("\n4b. 空消息不该把占位标题吃掉");

{
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.CLAUDE_SEND_TURN, { sessionId: s, prompt: "   " });
  eq("全是空格的消息不改标题(占位标题留着)", SessionRepo.get(s)?.title, "New session");
  eq("也不去问模型要标题(否则会白花一次调用)", titleGenCalls.length, 0);
}

/* ──────────────── 5. 认不出的 id 显式抛 ──────────────── */

console.log("\n5. 认不出的 id —— 显式抛,不静默");

{
  fresh();
  const threw = await catching(IPC.CLAUDE_SEND_TURN, { sessionId: "根本不存在", prompt: "你好" });
  check("会话不存在时抛出去(渲染端会弹成一句话)", threw.includes("session not found"), threw);
  eq("也没有把这一轮偷偷派出去", sendTurns.length, 0);
}

/* ──────────────── 6. 图型工作流那条岔路 ──────────────── */

console.log("\n6. 图型工作流:什么时候推图、什么时候拦住用户");

{
  fresh();
  setGraphRunIntent("start");
  const s = mkSession(nid("s"));
  const res = await call<{ session: { id: string } }>(IPC.CLAUDE_SEND_TURN, {
    sessionId: s,
    prompt: "跑那张图",
  });
  eq("图型会话**不**派引擎回合(那一轮由调度器推)", sendTurns.length, 0);
  eq("推图被调了一次", started.length, 1);
  eq("推的是这个会话", (started[0]?.session as { id: string } | undefined)?.id, s);
  eq("这一轮照样立刻返回(用户要能继续打字)", res.session.id, s);
  eq(
    "**图型会话也要起标题**(generateSessionTitle 放在分岔之前就是为了这条)",
    titleGenCalls.length,
    1,
  );
}

{
  // 图停在原地等人,而用户说了句话 → 放弃那一次、按他刚说的重来。
  fresh();
  setGraphRunIntent("busy");
  setParkedTeardown(0);
  const s = mkSession(nid("s"));
  await call(IPC.CLAUDE_SEND_TURN, { sessionId: s, prompt: "算了,直接干这个" });
  eq("停着等人的图被放弃了一次", teardowns.length, 1);
  eq("等它收干净之后按新的重来", started.length, 1);
  eq("这时**不**派普通回合(整张图重跑)", sendTurns.length, 0);
}

{
  // 有节点真在跑 → `parkedRunTeardown` 返回 null → 拦住这条消息。
  fresh();
  setGraphRunIntent("busy");
  setParkedTeardown("never");
  const s = mkSession(nid("s"));
  const threw = await catching(IPC.CLAUDE_SEND_TURN, { sessionId: s, prompt: "半路插一句" });
  check(
    "有节点真在跑时抛出去,而不是把这句话默默丢掉",
    threw.includes("还在跑"),
    threw || "(没抛 —— 这句话被静默吞了)",
  );
  eq("也没有偷偷推一次图", started.length, 0);
  eq("更没有派普通回合", sendTurns.length, 0);
}

/* ──────────────── 7. 打断 ──────────────── */

console.log("\n7. 打断:图型走一条路,普通会话走另一条");

{
  fresh();
  const s = mkSession(nid("s"));
  // 真的推过一次图,`cancelWorkflowRun` 才会认领这个会话(它就是那条分岔的判据)。
  setGraphRunIntent("start");
  await call(IPC.CLAUDE_SEND_TURN, { sessionId: s, prompt: "跑那张图" });
  await call(IPC.CLAUDE_INTERRUPT, { sessionId: s });
  eq("要停的是整张图", stoppedRuns.length, 1);
  eq("停图时**不**再单独打断会话回合(整张图会逐个 interrupt)", interrupts.length, 0);
  eq("状态落成 interrupted(图那条路也要落)", SessionRepo.get(s)?.status, "interrupted");
}

{
  fresh();
  const s = mkSession(nid("s"));
  // ⚠️ 这个会话上**没有**图在跑 —— `cancelWorkflowRun` 要说"不是我的",才轮到普通回合。
  await call(IPC.CLAUDE_INTERRUPT, { sessionId: s });
  eq("没有图时,「停止」落到那一轮会话回合上(这是最常被按的那个按钮)", interrupts.length, 1);
  // 判据读的是 `stoppedRuns`(真停掉的图)不是 `cancelled`(被问过的次数):那句
  // `if (cancelWorkflowRun(id))` 本来就是"先问一句这张图是不是你的",调用一定会发生,
  // 有意义的是它**返回了什么**。
  eq("不碰图(问过了,但它说不是它的)", stoppedRuns.length, 0);
  eq("状态落成 interrupted", SessionRepo.get(s)?.status, "interrupted");
}

{
  // 图跑完之后再按「停止」:那张图已经不在调度器上了,该落到会话回合上 ——
  // 否则用户按了停止,界面停了、引擎那边还在跑。
  fresh();
  const s = mkSession(nid("s"));
  setGraphRunIntent("start");
  await call(IPC.CLAUDE_SEND_TURN, { sessionId: s, prompt: "跑那张图" });
  await call(IPC.CLAUDE_INTERRUPT, { sessionId: s });
  resetStub();
  await call(IPC.CLAUDE_INTERRUPT, { sessionId: s });
  eq("同一张图停第二次时落到会话回合上(不会静默什么都不做)", interrupts.length, 1);
}

/* ──────────────── 8. 插话 ──────────────── */

console.log("\n8. 生成过程中插话:主进程只管「塞进去没有」");

{
  fresh();
  const s = mkSession(nid("s"));
  const res = await call<{ delivered: boolean }>(IPC.CLAUDE_INJECT, {
    sessionId: s,
    text: "顺便也看一下这个",
  });
  eq("塞进去了", res.delivered, true);
  eq("文本原样交给了运行时", injected[0]?.text, "顺便也看一下这个");
  eq(
    "**主进程不落库**(那条消息由渲染端在 delivered:true 之后自己写)",
    MessageRepo.hasAny(s),
    false,
  );
}

{
  fresh();
  setDefaultResolve("injectMessage", false);
  const s = mkSession(nid("s"));
  const res = await call<{ delivered: boolean }>(IPC.CLAUDE_INJECT, {
    sessionId: s,
    text: "塞不进去的那句",
  });
  eq("运行时说没收下时,如实回报 false(渲染端据此兜回普通发送)", res.delivered, false);
}

/* ──────────────── 9. 审批 ──────────────── */

console.log("\n9. 批准工具调用");

{
  fresh();
  await call(IPC.CLAUDE_APPROVE, { sessionId: "s", requestId: "req_1", granted: true });
  eq("允许原样传下去", approvals[0]?.allow, true);
  eq("允许时不带理由", approvals[0]?.reason, undefined);
}

{
  fresh();
  await call(IPC.CLAUDE_APPROVE, { sessionId: "s", requestId: "req_2", granted: false });
  eq("拒绝时传下去", approvals[0]?.allow, false);
  eq("拒绝带上一句理由(provider 那边要靠它给模型解释)", approvals[0]?.reason, "Denied by user");
}

{
  fresh();
  await call(IPC.CLAUDE_APPROVE, {
    sessionId: "s",
    requestId: "req_3",
    granted: true,
    always: true,
  });
  eq("「始终允许」也传下去了", approvals[0]?.always, true);
}

{
  // 认不出的 id:不抛,只记一行警告 —— 这是**契约**(渲染端可能重复点/跨设备点)。
  fresh();
  setDefaultResolve("resolveApproval", false);
  const threw = await catching(IPC.CLAUDE_APPROVE, {
    sessionId: "s",
    requestId: "早就过期了",
    granted: true,
  });
  eq("认不出的审批 id 不抛(重复点不该炸界面)", threw, "");
  eq("但确实把这次决定交给了运行时(由它判断认不认得)", approvals.length, 1);
}

/* ──────────────── 10. 回答问题 ──────────────── */

console.log("\n10. 回答问题 —— 普通路 / 关卡片 / sentinel 那条路");

{
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.CLAUDE_RESPOND_QUESTION, {
    sessionId: s,
    requestId: "q_1",
    answers: { 用哪个库: "第一个" },
  });
  eq("答案交给了运行时", userAnswers.length, 1);
  eq("请求 id 对得上", userAnswers[0]?.requestId, "q_1");
  same("答案原样进去", userAnswers[0]?.answers, { 用哪个库: "第一个" });
  eq("走这条路时**不**额外起一轮", sendTurns.length, 0);
}

{
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.CLAUDE_RESPOND_QUESTION, {
    sessionId: s,
    requestId: "q_2",
    answers: {},
    dismissed: true,
  });
  eq("关卡片走 dismiss,而不是随便给个答案", dismissed[0], "q_2");
  eq("dismiss 那条路**不**起新的一轮", sendTurns.length, 0);
  check("dismiss 那条路不把状态改成 running", SessionRepo.get(s)?.status !== "running");
}

{
  // ⚠️ sentinel 路:没有 Deferred,要把答案拼成新的一轮。
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.CLAUDE_RESPOND_QUESTION, {
    sessionId: s,
    requestId: "sentinel_abc",
    answers: { 用哪个库: "第二个", 要不要图表: ["要", "而且要彩色的"], 跳过的那个: null },
  });
  eq("告诉别的客户端把卡片关掉", notified.length, 1);
  eq("关的是问题卡", notified[0]?.kind, "question");
  eq("起了一轮新的", sendTurns.length, 1);
  const prompt = sendTurns[0]?.prompt ?? "";
  check(
    "提示语里说明这是「对上一个问题的回答」",
    prompt.includes("Answers to your previous question"),
    prompt,
  );
  check("答案的键在里面", prompt.includes("用哪个库"), prompt);
  check("单个答案原样进去", prompt.includes("第二个"), prompt);
  check("多选答案用逗号连起来", prompt.includes("要, 而且要彩色的"), prompt);
  check("跳过的那个(null)不出现在提示里", !prompt.includes("跳过的那个"), prompt);
  eq("状态落成 running", SessionRepo.get(s)?.status, "running");
  check("也把会话交给了运行时(新的一轮要有桥)", bound.includes(s), bound);
}

{
  // 用户直接关掉 sentinel 卡片:没有 Deferred 可解,但要广播"别的客户端把卡片收掉"。
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.CLAUDE_RESPOND_QUESTION, {
    sessionId: s,
    requestId: "sentinel_abc",
    answers: {},
    dismissed: true,
  });
  eq("关卡片也要通知别的客户端", notified.length, 1);
  eq("不是走 dismissUserInput(那条路上没有 Deferred 可解)", dismissed.length, 0);
  eq("关卡片**不**起新的一轮", sendTurns.length, 0);
}

{
  // sentinel 路的会话被删了:该记 warn 然后**干净地返回**,不是抛。
  fresh();
  const threw = await catching(IPC.CLAUDE_RESPOND_QUESTION, {
    sessionId: "早就删掉的会话",
    requestId: "sentinel_xyz",
    answers: { 问题: "答案" },
  });
  eq("会话不在时 sentinel 路不抛(卡片还是得关掉)", threw, "");
  eq("但确实通知了别的客户端关卡片", notified.length, 1);
  eq("也**没有**凭空起一轮", sendTurns.length, 0);
}

{
  fresh();
  const threw = await catching(IPC.CLAUDE_RESPOND_QUESTION, {
    sessionId: "s",
    requestId: "q_9",
    answers: {},
  });
  eq("普通路认不出 id 也不抛(跨设备点了已过期的卡片)", threw, "");
  eq("确实问过运行时", userAnswers.length, 1);
}

/* ──────────────── 11. 计划审批 / 撤回 ──────────────── */

console.log("\n11. 计划审批 / 撤回");

{
  fresh();
  await call(IPC.CLAUDE_RESPOND_PLAN_APPROVAL, {
    sessionId: "s",
    requestId: "plan_1",
    approved: true,
    editedPlan: "改过的计划正文",
  });
  const payload = planApprovals[0]?.payload as
    | { approved?: boolean; editedPlan?: string }
    | undefined;
  eq("批准传下去了", payload?.approved, true);
  eq("改过的计划正文也传下去了", payload?.editedPlan, "改过的计划正文");
}

{
  fresh();
  setDefaultResolve("resolvePlanApproval", false);
  const threw = await catching(IPC.CLAUDE_RESPOND_PLAN_APPROVAL, {
    sessionId: "s",
    requestId: "plan_过期",
    approved: false,
  });
  eq("认不出的计划 id 不抛", threw, "");
}

{
  fresh();
  setRewindResult(["a.ts", "b.ts"]);
  const s = mkSession(nid("s"));
  const res = await call<{ restored: string[] }>(IPC.CLAUDE_REWIND_TURN, {
    sessionId: s,
    files: [
      { filePath: "a.ts", kind: "modified", adds: 3, dels: 1, before: "原来的内容" },
    ],
    targetFiles: ["a.ts", "b.ts"],
  });
  same("恢复结果原样返回给界面(它要显示「N 个文件已恢复」)", res.restored, ["a.ts", "b.ts"]);
  eq(
    "撤回时把卡片自己那份冻结清单**整条**传下去了(界面靠它做回滚,少一个字段就滚错)",
    (rewinds[0]?.files as Array<{ filePath: string; before: string }>)[0]?.filePath,
    "a.ts",
  );
  eq(
    "`before` 那份原文也跟着过去了(没有它就没法恢复)",
    (rewinds[0]?.files as Array<{ before: string }>)[0]?.before,
    "原来的内容",
  );
  eq("会话 id 也传下去了", rewinds[0]?.sessionId, s);
  same(
    "`targetFiles` 也传下去了(界面靠它在历史里定位是哪张卡片)",
    rewinds[0]?.targetFiles,
    ["a.ts", "b.ts"],
  );
}

/* ──────────────── 12. 消息落库 / 读回 / 分页 / 截断重插 ──────────────── */

console.log("\n12. 消息落库 / 读回来 / 分页 / 截断重插");

{
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.SESSION_SAVE_MESSAGES, {
    sessionId: s,
    messages: [
      { id: "m1", sessionId: s, role: "user", content: "第一句", createdAt: 1000 },
      { id: "m2", sessionId: s, role: "assistant", content: "第二句", createdAt: 2000 },
    ],
  });
  const read = await call<{ messages: Array<{ id: string }> }>(IPC.SESSION_MESSAGES, {
    sessionId: s,
  });
  eq("存了两条,读回两条", read.messages.length, 2);

  // ⚠️ 分页:读少一条用户就看不到一条历史,读多一条界面就多渲染一条。
  const paged = await call<{ messages: Array<{ id: string }>; hasMore: boolean }>(
    IPC.SESSION_MESSAGES,
    { sessionId: s, limit: 1 },
  );
  eq("limit=1 只回一条", paged.messages.length, 1);
  eq("回的是**最新**那条(分页是从后往前翻)", paged.messages[0]?.id, "m2");
  eq("并且如实说还有更多", paged.hasMore, true);

  const lastPage = await call<{ hasMore: boolean }>(IPC.SESSION_MESSAGES, {
    sessionId: s,
    limit: 5,
  });
  eq("条数不够时 hasMore 是 false(否则界面会一直转圈加载)", lastPage.hasMore, false);
}

{
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.SESSION_UPSERT_MESSAGES, {
    sessionId: s,
    messages: [
      { id: "u1", sessionId: s, role: "user", content: "旧", createdAt: 1000 },
      { id: "u1", sessionId: s, role: "user", content: "新", createdAt: 1000 },
    ],
  });
  const read = await call<{ messages: Array<{ id: string; content: string }> }>(
    IPC.SESSION_MESSAGES,
    { sessionId: s },
  );
  eq("同 id upsert 之后还是一条", read.messages.length, 1);
  eq("内容是后来那次", read.messages[0]?.content, "新");
}

{
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.SESSION_SAVE_MESSAGES, {
    sessionId: s,
    messages: [
      { id: "t1", sessionId: s, role: "user", content: "留", createdAt: 1000 },
      { id: "t2", sessionId: s, role: "assistant", content: "删", createdAt: 2000 },
      { id: "t3", sessionId: s, role: "assistant", content: "也删", createdAt: 3000 },
    ],
  });
  await call(IPC.SESSION_TRUNCATE_AND_INSERT_MESSAGES, {
    sessionId: s,
    cursorCreatedAt: 2000,
    cursorId: "t2",
    messages: [{ id: "n1", sessionId: s, role: "user", content: "换上的", createdAt: 4000 }],
  });
  const read = await call<{ messages: Array<{ id: string }> }>(IPC.SESSION_MESSAGES, {
    sessionId: s,
  });
  same(
    "游标之前的留着,游标那条和它之后的都截掉,新的插进来",
    read.messages.map((m) => m.id).sort(),
    ["n1", "t1"],
  );
}

console.log("\n12b. 往上翻页 —— 200 条以上的对话最早那段能不能翻到");

{
  // ⚠️ 这一段是照着**用户看到的东西**写的:每页 200 条(`MESSAGE_PAGE_SIZE`),用户一直
  // 往上滚,该一直滚到第 1 条。曾经翻页那一支把顺序搞反,每翻一页**跳掉** 200 条,于是
  // 长对话最早那段永远打不开 —— 而第一页看着完全正常,所以很难发现。
  fresh();
  const s = mkSession(nid("s_long"));
  const N = 450;
  const all = Array.from({ length: N }, (_, i) => ({
    id: `L${String(i).padStart(4, "0")}`,
    sessionId: s,
    role: "user" as const,
    content: `第 ${i} 条`,
    createdAt: 1000 + i,
  }));
  await call(IPC.SESSION_SAVE_MESSAGES, { sessionId: s, messages: all });

  const seen: string[] = [];
  let page = await call<{ messages: Array<{ id: string }>; hasMore: boolean }>(
    IPC.SESSION_MESSAGES,
    { sessionId: s, limit: 200 },
  );
  seen.push(...page.messages.map((m) => m.id));
  eq("第一页给的是**最新**那 200 条", page.messages[199]?.id, "L0449");

  let guard = 0;
  while (page.hasMore && guard < 10) {
    guard += 1;
    const head = page.messages[0];
    const before = all.find((m) => m.id === head.id);
    page = await call<{ messages: Array<{ id: string }>; hasMore: boolean }>(IPC.SESSION_MESSAGES, {
      sessionId: s,
      limit: 200,
      beforeCreatedAt: before?.createdAt,
      beforeId: head.id,
    });
    seen.push(...page.messages.map((m) => m.id));
  }

  eq("一直翻到底(没有翻不完的循环)", page.hasMore, false);
  eq(`翻下来的总数正好是 ${N} 条(不多不少、不重不漏)`, new Set(seen).size, N);
  check("**第 1 条终于翻到了**", seen.includes("L0000"), seen.slice(-5));
  check("翻出来的每一页自己都是升序的(界面按顺序渲染)", (() => {
    const firstPage = seen.slice(0, 200);
    for (let i = 1; i < firstPage.length; i += 1) {
      if (firstPage[i]! <= firstPage[i - 1]!) return false;
    }
    return true;
  })());
}

console.log("\n12c. 同一个时间戳的多条也要能翻页((created_at, id) 那个 tiebreaker)");

{
  fresh();
  const s = mkSession(nid("s_tie"));
  // 五条**一模一样**的 createdAt —— 只按时间排的话翻页会原地打转。
  await call(IPC.SESSION_SAVE_MESSAGES, {
    sessionId: s,
    messages: ["a", "b", "c", "d", "e"].map((k) => ({
      id: `tie_${k}`,
      sessionId: s,
      role: "user" as const,
      content: k,
      createdAt: 5000,
    })),
  });

  const p1 = await call<{ messages: Array<{ id: string }>; hasMore: boolean }>(IPC.SESSION_MESSAGES, {
    sessionId: s,
    limit: 2,
  });
  eq("第一页两条", p1.messages.length, 2);
  eq("而且说还有更多", p1.hasMore, true);

  const p2 = await call<{ messages: Array<{ id: string }>; hasMore: boolean }>(IPC.SESSION_MESSAGES, {
    sessionId: s,
    limit: 5,
    beforeCreatedAt: 5000,
    beforeId: p1.messages[0]!.id,
  });
  const overlap = p2.messages.filter((m) => p1.messages.some((x) => x.id === m.id)).length;
  eq("第二页**不重复**第一页的内容(时间戳一样时也不能重)", overlap, 0);
  eq("第二页接着往前翻,拿到剩下三条", p2.messages.length, 3);
}

/* ──────────────── 13. 设置 ──────────────── */

console.log("\n13. 设置读写 + 主题那条特殊分支");

{
  await call(IPC.SETTING_SET, { key: "smoke.key", value: "值" });
  const got = await call<{ value: unknown }>(IPC.SETTING_GET, { key: "smoke.key" });
  eq("写进去读得回来", got.value, "值");
}

{
  await call(IPC.SETTING_SET, { key: "k1", value: "一" });
  await call(IPC.SETTING_SET, { key: "k2", value: "二" });
  const many = await call<Record<string, string | null>>(IPC.SETTING_GET_MANY, {
    keys: ["k1", "k2", "k3"],
  });
  eq("批量读把要的都给回来", many["k1"], "一");
  eq("批量读第二个也对", many["k2"], "二");
  eq(
    "不存在的键**明说没有**(null,不是 undefined —— 渲染端要能把「没有」和「读失败」分开)",
    many["k3"],
    null,
  );
}

{
  // ⚠️ 设置值**只能是字符串**(`SetSettingSchema` 里就是 `z.string()`)。
  // 传个数字进来必须**显式报错**,而不是被 JSON 序列化成 `"1"` 之类存进去。
  const threw = await catching(IPC.SETTING_SET, { key: "数字键", value: 1 });
  check("值的类型不对时抛出去,不静默转成字符串存下去", threw !== "", threw || "(没抛)");
}

{
  // 主题那条:设 THEME_STYLE 会多走一步"重画原生标题栏"。无头环境里没有窗口,
  // 那一步必须**兜住**而不是把这次设置写失败。
  resetTitleBarPaints();
  const threw = await catching(IPC.SETTING_SET, { key: THEME_STYLE_SETTING_KEY, value: "sketch" });
  eq("没有窗口时设主题样式不抛", threw, "");
  const got = await call<{ value: unknown }>(IPC.SETTING_GET, { key: THEME_STYLE_SETTING_KEY });
  eq("而且值确实落库了", got.value, "sketch");
  eq(
    "并且真的去重画了一次标题栏(不重画的话原生按钮那块颜色会留着旧的)",
    titleBarOverlayPaints,
    1,
  );
}

{
  resetTitleBarPaints();
  await call(IPC.SETTING_SET, { key: "随便一个别的键", value: "1" });
  eq("别的键不碰标题栏", titleBarOverlayPaints, 0);
}

/* ──────────────── 14. 会话设置 ──────────────── */

console.log("\n14. 会话设置");

{
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.SESSION_UPDATE_SETTINGS, {
    sessionId: s,
    model: "新模型",
    effort: "high",
    permissionMode: "acceptEdits",
  });
  eq("模型落库了", SessionRepo.get(s)?.model, "新模型");
  eq("权限模式落库了", SessionRepo.get(s)?.permissionMode, "acceptEdits");
  eq(
    "权限模式**同时**同步进了运行时(半路改模式要立刻对下一次工具调用生效)",
    permissionModes.length,
    1,
  );
  eq("同步的是这个会话", permissionModes[0]?.sessionId, s);
  eq("同步的是那个模式", permissionModes[0]?.mode, "acceptEdits");
  eq("广播了(手机端的 composer 小标签靠它)", eventsOfType("session.changed").length, 1);
}

{
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.SESSION_UPDATE_SETTINGS, { sessionId: s, model: "只改模型" });
  eq("只改模型时**不**碰权限闸门(碰了会把当前模式冲掉)", permissionModes.length, 0);
  eq("没传的字段保持原样", SessionRepo.get(s)?.permissionMode, "default");
}
console.log("\n14b. 换目录:只在「还没开始」的会话上放行");

{
  fresh();
  ProjectRepo.create({
    id: "p_target",
    name: "另一个项目",
    path: mkdtempSync(join(tmpdir(), "mcode-claude-ipc-p2-")),
    archived: false,
    group: null,
    sortOrder: 1,
    pinnedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never);
  const s = mkSession(nid("s"));
  await call(IPC.SESSION_UPDATE_SETTINGS, { sessionId: s, projectId: "p_target" });
  eq("空会话可以换目录", SessionRepo.get(s)?.projectId, "p_target");
}

{
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.SESSION_SAVE_MESSAGES, {
    sessionId: s,
    messages: [{ id: "x1", sessionId: s, role: "user", content: "已经有话了", createdAt: 1000 }],
  });
  const threw = await catching(IPC.SESSION_UPDATE_SETTINGS, {
    sessionId: s,
    projectId: "p_target",
  });
  check(
    "已经有消息的会话换目录**整条被拒**(不许半应用)",
    threw.includes("already has messages"),
    threw,
  );
  eq("而且项目真的没被改掉", SessionRepo.get(s)?.projectId, PID);
}

{
  fresh();
  const s = mkSession(nid("s"));
  const threw = await catching(IPC.SESSION_UPDATE_SETTINGS, {
    sessionId: s,
    projectId: "不存在的项目",
  });
  check("换到一个不存在的项目被拒", threw.includes("missing or archived"), threw);
  eq("项目也没被改掉", SessionRepo.get(s)?.projectId, PID);
}

{
  fresh();
  // ⚠️ `SESSION_UPDATE_SETTINGS` 只在**换目录**那一支查会话在不在;其余字段是直接
  // `SessionRepo.updateSettings(id, ...)` —— 那是个 UPDATE,打不中任何行时**静默什么都不做**,
  // 而且后面 `SessionRepo.get(id)` 拿不到行、广播也就跟着不发了。渲染端那边一句拒绝都
  // 收不到(它本来会弹成一句话)。这里把这个现状记下来,判据是"用户有没有被告知"。
  const threw = await catching(IPC.SESSION_UPDATE_SETTINGS, {
    sessionId: "根本没有这个会话",
    model: "x",
  });
  check(
    "⚠️ 改一个不存在的会话**不报错**(UPDATE 打不中,静默什么都不做)",
    threw === "",
    threw || "(这是现状:没有被告知)",
  );
}

/* ──────────────── 15. 子代理保存 ──────────────── */

console.log("\n15. 子代理列表存/读");

{
  const res = await call<{ subagents: unknown[] }>(IPC.CLAUDE_SUBAGENTS_SAVE, {
    subagents: [
      {
        name: "paper-reviewer",
        description: "帮我审一段稿子",
        prompt: "你是一个严格但讲道理的审稿人。",
      },
    ],
  });
  eq("存了一条", res.subagents.length, 1);
  const back = await call<{ value: unknown }>(IPC.SETTING_GET, { key: "claude.subagents" });
  check("读回来还在(读取走通用 SETTING_GET,没有单独的读 RPC)", back.value !== undefined);

  // 坏输入必须**显式报错**,不能静默存个半成品进去 —— 而且报的话要说得清是哪一条坏了。
  const bad = await catching(IPC.CLAUDE_SUBAGENTS_SAVE, {
    subagents: [{ name: "带空格 的名字", description: "d", prompt: "p" }],
  });
  check("不合法的名字被拒", bad.includes("不合法"), bad || "(没抛)");
  check("拒绝理由里点明了是哪个名字坏了", bad.includes("带空格 的名字"), bad);

  const emptyPrompt = await catching(IPC.CLAUDE_SUBAGENTS_SAVE, {
    subagents: [{ name: "ok-name", description: "d", prompt: "   " }],
  });
  check("空提示词被拒", emptyPrompt.includes("提示词不能为空"), emptyPrompt || "(没抛)");

  const dup = await catching(IPC.CLAUDE_SUBAGENTS_SAVE, {
    subagents: [
      { name: "same", description: "d", prompt: "p" },
      { name: "same", description: "d", prompt: "p" },
    ],
  });
  check("重名的被拒", dup.includes("重复"), dup || "(没抛)");

  // ⚠️ 一次坏的调用**不能**把上一条好的一起冲掉(前面那些失败都是整份拒,不是先存一半)。
  const stillThere = await call<{ value: string | null }>(IPC.SETTING_GET, { key: "claude.subagents" });
  check(
    "被拒的那几次没有把已存的那条冲掉",
    (stillThere.value ?? "").includes("paper-reviewer"),
    stillThere.value,
  );
}

/* ──────────────── 16. 分叉 ──────────────── */

console.log("\n16. 分叉一条对话");

{
  resetRegistryStub();
  // 引擎支持复制对话 → 走成功那条路。
  setForkSupport("claude-sdk", async () => "引擎侧的新会话 id");
  const s = mkSession(nid("s"), { claudeSessionId: "cli_old" });
  await call(IPC.SESSION_SAVE_MESSAGES, {
    sessionId: s,
    messages: [{ id: "f1", sessionId: s, role: "user", content: "原型那句话", createdAt: 1000 }],
  });
  const res = await call<{ session: { id: string; title: string; claudeSessionId: string } }>(
    IPC.SESSION_FORK,
    { id: s, title: "分叉出来的" },
  );
  eq("标题用的是传进来的那个", res.session.title, "分叉出来的");
  check("新会话不是原来那条", res.session.id !== s);
  eq(
    "新会话指向引擎**新复制出来**那一段(指回源的话两个会话会抢写同一个文件)",
    res.session.claudeSessionId,
    "引擎侧的新会话 id",
  );
  eq("引擎那边确实被调了一次", forkCalls.length, 1);

  const forkedMsgs = await call<{ messages: Array<{ id: string; content: string }> }>(
    IPC.SESSION_MESSAGES,
    { sessionId: res.session.id },
  );
  eq("消息抄过来了", forkedMsgs.messages.length, 1);
  check(
    "消息 id **重编过**(照抄会撞主键,而且删源对话不该动到这一段)",
    forkedMsgs.messages[0]?.id !== "f1",
    forkedMsgs.messages[0]?.id,
  );
  eq("源会话的消息还在(复制不是搬走)", (await call<{ messages: unknown[] }>(IPC.SESSION_MESSAGES, { sessionId: s })).messages.length, 1);
}

{
  resetRegistryStub();
  const s = mkSession(nid("s"), { claudeSessionId: "cli_old2" });
  const msgsBefore = (await call<{ messages: unknown[] }>(IPC.SESSION_MESSAGES, { sessionId: s })).messages.length;
  // 库里**本来就**躺着前面十几节建的那些会话,所以要比的是"这一下有没有多出来",
  // 不是"一共几条"。
  const before = SessionRepo.listByProject(PID, { archived: false }).length;
  const threw = await catching(IPC.SESSION_FORK, { id: s, title: "x" });
  check(
    "引擎不支持复制对话时抛出去(而不是造一条看着有历史、其实模型那边是空的)",
    threw.includes("不支持复制对话"),
    threw,
  );
  // 上面那句文案要是变了,这一条会一起红 —— 但真正要守的是**它没往下走**:引擎一次都
  // 没被调、库里也没多出会话行。只验文案的话,把抛点挪到 `forkSession` 调用**之后**
  // 也照样绿,而那正是这段代码存在的理由(见 `sessionFork.ts` 文件头"两件事,顺序不能反")。
  eq("而且引擎一次都没被调(是在能力那一步就退的,不是调完才后悔)", forkCalls.length, 0);
  eq(
    "源会话本身一条消息没多也没少",
    (await call<{ messages: unknown[] }>(IPC.SESSION_MESSAGES, { sessionId: s })).messages.length,
    msgsBefore,
  );
  const after = SessionRepo.listByProject(PID, { archived: false });
  eq("库里**没有**多出一条看着有历史的半成品会话", after.length, before);
}

{
  resetRegistryStub();
  const threw = await catching(IPC.SESSION_FORK, { id: "根本不存在的会话", title: "x" });
  check("分叉一条不存在的会话会抛(不静默造一条空的)", threw.includes("unknown session"), threw);
}

/* ──────────────── 17. 引擎清单 ──────────────── */

console.log("\n17. 引擎清单(没装引擎时说的是实话)");

{
  const res = await call<{ providers: unknown[] }>(IPC.PROVIDER_LIST);
  eq("无头环境里没有引擎 → 空清单(不是编一个出来)", res.providers.length, 0);
}

/* ──────────────── 收尾 ──────────────── */

rmSync(PROJECT_DIR, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });

console.log(`\nclaude-ipc-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
