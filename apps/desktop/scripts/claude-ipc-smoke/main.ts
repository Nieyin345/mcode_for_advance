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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

import { IPC, THEME_STYLE_SETTING_KEY, TURN_BUDGET_SETTING_KEY } from "@contracts/ipc";
import type { Session } from "@contracts/session";
import type { ProviderContext } from "@contracts/provider";
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, MessageRepo, SettingRepo } from "@main/store/repositories.js";
import { registerClaudeHandlers } from "@main/ipc/claude.js";
import { invokeAppTool } from "@main/appControl/tools.js";
import { setRendererPortForTest } from "@main/appControl/uiBridge.js";
import {
  __createSessionAndSendCount,
  __lastActionContext,
  __resetCreateSessionAndSendCount,
  createSessionAndSend,
} from "@main/appServices/sessionCommands.js";

import {
  approvals,
  bound,
  boundSessions,
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
  setFailNextSendTurn,
  setRewindResult,
  setRewindResultFull,
  setStopTaskResult,
  stopTasks,
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

console.log("\n3d. 工作树首轮:补 worktreePath 时不能把这一轮的覆盖值一起冲掉");
{
  // 物化之后 `resolveSessionCwd` 会把 worktreePath 写回库,handler 于是要重读一次把这个
  // 字段补进内存快照。⚠️ **只该补这一个字段。** 曾经的写法是整行
  // `updated = SessionRepo.get(...)`,而那一刻 `updated` 上刚打过这一轮的覆盖值
  // (model/effort/permissionMode/workflowId/customModelId/providerId)—— 整行重读把它们
  // 全丢了。`providerId` 尤其致命:它**刻意不落库**(见 handler 里那条注释),库里那份是
  // null,丢的就是用户这一轮选的引擎。`workflowId` 也会退回库里的旧值,选好的工作流静默
  // 退化成普通回合。
  //
  // 判据立在"这一轮实际用了什么"上:`bindSession` 拿到的会话快照 —— 那正是运行时解析
  // 引擎/工作流用的那份。
  fresh();
  const s = mkSession(nid("s"), { providerId: "库里那个引擎" });
  // 把它摆成"没物化的工作树意图":envMode=worktree 但 worktreePath 还是 null。
  // 本项目根**不是** git 仓库 → 物化会**降级**回 local(不建 worktree),但
  // `updated.envMode` 仍是 "worktree"、`updated.worktreePath` 仍是 null —— 于是那句重读
  // 的条件恰好成立,正是我们要考的那一步。
  SessionRepo.updateSettings(s, { envMode: "worktree" });

  const res = await call<{ session: { providerId: string; workflowId: string } }>(
    IPC.CLAUDE_SEND_TURN,
    {
      sessionId: s,
      prompt: "你好",
      providerId: "这一次要用的引擎",
      workflowId: "read",
    },
  );

  eq("★ 工作树首轮:这一轮选的引擎没被整行重读冲掉(返回快照)", res.session.providerId, "这一次要用的引擎");
  eq("★ 工作树首轮:这一轮选的工作流也没被冲掉", res.session.workflowId, "read");
  const boundTo = boundSessions.find((b) => b.id === s);
  eq("★ 交给运行时的快照也带着这一轮的引擎(不是库里的 null)", boundTo?.providerId, "这一次要用的引擎");
  eq("★ 交给运行时的快照也带着这一轮的工作流", boundTo?.workflowId, "read");
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

{
  // ── MC-049 ── 图还在跑(会话状态是 running),另一台设备又发消息 → 被明确拒绝。
  // 拒绝**不能**把库里那份 running 改成 idle:真实图还在跑,两边一分家,
  // `findFreshByProject` 就会去复用一条其实正忙的会话(与 MC-013 的状态时序同源)。
  // 从前 `updateStatus(running)` 在预检**之前**,拒绝又把状态回滚 idle,于是库说 idle。
  // 判据立在"用户/别的端看到的会话状态"上:拒绝之后必须仍是 running。
  fresh();
  setGraphRunIntent("busy");
  setParkedTeardown("never");
  const s = mkSession(nid("s"));
  // 摆出"图正在跑"的真实库状态:第一次 sendTurn 起了图,状态就停在 running。
  SessionRepo.updateStatus(s, "running");
  const threw = await catching(IPC.CLAUDE_SEND_TURN, { sessionId: s, prompt: "再发一句" });
  check("(前提)这是那条忙拒绝", threw.includes("还在跑"), threw || "(没抛)");
  eq(
    "★ 被拒之后会话状态**仍是 running**(与真实图一致,不是 idle)",
    SessionRepo.get(s)?.status,
    "running",
  );
}

{
  // 反面:普通会话走到"运行时没启动"(handle === null)那条真失败时,running 仍须回滚成
  // idle —— 上面把预检提前,不能顺手把这条回滚也去掉。
  fresh();
  const s = mkSession(nid("s"));
  setFailNextSendTurn();
  const threw = await catching(IPC.CLAUDE_SEND_TURN, { sessionId: s, prompt: "你好" });
  check("(前提)引擎预检失败如实抛出", threw.includes("provider preflight failed"), threw);
  eq(
    "★ 真失败(不是被忙拒绝)时状态仍如实回滚 idle",
    SessionRepo.get(s)?.status,
    "idle",
  );
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

/* ──────────────── 7b. 停一个子代理（不是停整轮） ──────────────── */

console.log("\n7b. 停一个子代理:只停那一个分身,绝不动整轮");

{
  fresh();
  const s = mkSession(nid("s"));
  const res = await call<{ stopped: boolean }>(IPC.CLAUDE_STOP_TASK, { sessionId: s, taskId: "task_abc" });
  eq("转发到宿主的 stopTask,带上会话与 taskId", JSON.stringify(stopTasks), JSON.stringify([{ sessionId: s, taskId: "task_abc" }]));
  // ★ 最要紧的一条:停一个子代理**绝不能**顺手把整轮打断 —— 那是灾难性的
  //   (用户只想收掉一个分身,结果整轮没了)。
  eq("★ 没有顺手动 interrupt(粒度不同)", interrupts.length, 0);
  eq("回复是 stopped:true(它发出去的那一刻停成了)", res.stopped, true);
}

{
  // 「没停成」是**正常结果**(多半是它刚好跑完了),要如实回 false 而不是抛 ——
  // 界面据此说一句平铺直叙的话,而不是弹一条红字。
  fresh();
  const s = mkSession(nid("s"));
  setStopTaskResult(false);
  const res = await call<{ stopped: boolean }>(IPC.CLAUDE_STOP_TASK, { sessionId: s, taskId: "task_gone" });
  eq("宿主说没停成 → 如实回 false", res.stopped, false);
  eq("没停成也不碰整轮", interrupts.length, 0);
}

{
  // 参数校验:taskId 空串/超长都该被挡在门外（它会一路递给引擎的控制通道）。
  fresh();
  const s = mkSession(nid("s"));
  const empty = await catching(IPC.CLAUDE_STOP_TASK, { sessionId: s, taskId: "" });
  check("空 taskId 被拒(不是静默放行)", empty !== "", empty || "(没抛)");
  const long = await catching(IPC.CLAUDE_STOP_TASK, { sessionId: s, taskId: "x".repeat(257) });
  check("超长 taskId 被拒", long !== "", long || "(没抛)");
  eq("两次坏输入都没有真的调进宿主", stopTasks.length, 0);
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
  // ★ sentinel 路 sendTurn 抛错 → 状态必须放回 idle,不能把会话永久钉在 running。
  //   主发送那条路(run==="start"之前)正是为此套了 try/catch;sentinel 这条从前漏了。
  fresh();
  const s = mkSession(nid("s"));
  setFailNextSendTurn();
  const threw = await catching(IPC.CLAUDE_RESPOND_QUESTION, {
    sessionId: s,
    requestId: "sentinel_fail",
    answers: { 问题: "答案" },
  });
  check("sendTurn 抛错时如实抛出去(不静默吞)", threw.includes("provider preflight failed"), threw);
  eq("★ 抛错后会话状态放回 idle(不再钉死在 running)", SessionRepo.get(s)?.status, "idle");
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
  setRewindResultFull(["a.ts", "b.ts"], ["c.ts"], ["d.ts"]);
  const s = mkSession(nid("s"));
  const res = await call<{ restored: string[]; failed: string[]; conflicts: string[] }>(
    IPC.CLAUDE_REWIND_TURN,
    {
      sessionId: s,
      files: [
        { filePath: "a.ts", kind: "modified", adds: 3, dels: 1, before: "原来的内容" },
      ],
      targetFiles: ["a.ts", "b.ts"],
    },
  );
  same("恢复结果原样返回给界面(它要显示「N 个文件已恢复」)", res.restored, ["a.ts", "b.ts"]);
  // ── MC-047 同源:三个数组必须**平铺**交回来,界面才能分别报"失败"与"冲突"。
  // `TurnFilesCard` 直接解构 `failed` / `conflicts` 并读 `.length` —— 少一个就是
  // `undefined.length` 的 TypeError(卡片静默画成"已撤销")。
  same("失败清单也平铺返回(界面靠它报「部分文件没恢复」)", res.failed, ["c.ts"]);
  same("冲突清单同样平铺返回(界面靠它报「文件之后又被改过、没动」)", res.conflicts, ["d.ts"]);
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

/* ─────── 13b. 【MC-083 残余】轮预算保存时主键+last-good 同事务落盘 ─────── */

// 从前 last-good 只在**下一次** sendTurn 读到合法主值时补刷。用户把额度从 A 改成 B
// 保存成功后、下一轮开始前主键就坏了,恢复出来的会是旧额度 A。现在保存那一刻
// (SETTING_SET)就同事务写主键与备份,last-good 始终等于"最近一次确认保存的值"。
console.log("\n13b. 轮预算保存:主键与 last-good 同一次提交落盘");

{
  const LG = `${TURN_BUDGET_SETTING_KEY}.last-good`;
  const budgetA = JSON.stringify({ enabled: true, maxUsd: 0.5 });
  const budgetB = JSON.stringify({ enabled: true, maxUsd: 2 });

  // 保存 A:主键与备份都应是 A。
  await call(IPC.SETTING_SET, { key: TURN_BUDGET_SETTING_KEY, value: budgetA });
  eq("保存 A 后主键是 A", SettingRepo.get(TURN_BUDGET_SETTING_KEY), budgetA);
  eq("★ 保存 A 同一次提交就把 last-good 刷成 A(不再等下一轮)", SettingRepo.get(LG), budgetA);

  // 保存 B(用户从 A 改到 B):last-good 必须**当场**变成 B —— 这才是要修的残余。
  await call(IPC.SETTING_SET, { key: TURN_BUDGET_SETTING_KEY, value: budgetB });
  eq("保存 B 后主键是 B", SettingRepo.get(TURN_BUDGET_SETTING_KEY), budgetB);
  eq("★ 保存 B 后 last-good 立刻是 B(不是旧额度 A)", SettingRepo.get(LG), budgetB);

  // 端到端:现在把主键弄坏,模拟"保存成功后、下一轮前写入中断",恢复出的必须是 B。
  SettingRepo.set(TURN_BUDGET_SETTING_KEY, "{ 写入中断,坏 JSON");
  const { parseTurnBudgetDetailed } = await import("@main/lib/turnPolicy.js");
  const recovered = parseTurnBudgetDetailed(
    SettingRepo.get(TURN_BUDGET_SETTING_KEY),
    SettingRepo.get(LG),
  );
  eq("★ 主键损坏后从 last-good 恢复 → INVALID", recovered.status, "INVALID");
  eq("★ 恢复出的额度是刚保存的 B(maxUsd=2),不是旧额度 A", recovered.budget?.maxUsd, 2);
  eq("★ 且 recovered=true", recovered.recovered, true);

  // 明确关闭也是一次合法提交:主键与备份同刷(空预算也该成为新 last-good)。
  const disabled = JSON.stringify({ enabled: false });
  await call(IPC.SETTING_SET, { key: TURN_BUDGET_SETTING_KEY, value: disabled });
  eq("明确关闭后 last-good 也刷成关闭态(不复活旧限制)", SettingRepo.get(LG), disabled);

  // 坏提交(INVALID)不许覆盖上一份好的 last-good。
  await call(IPC.SETTING_SET, { key: TURN_BUDGET_SETTING_KEY, value: JSON.stringify({ enabled: true }) });
  eq(
    "★ 提交一份 INVALID(启用却无上限)不刷新 last-good(坏的盖不掉好的)",
    SettingRepo.get(LG),
    disabled,
  );
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

{
  /**
   * **providerId 过了首条消息就锁死。** schema 的注释白纸黑字写着「once a turn has
   * run the provider is fixed」,而那道守卫此前只长在 `projectId` 那一支里 —— 单独发
   * `{sessionId, providerId}` 就能改一条已经跑过对话的会话的引擎:DB 行被改,运行时捕获
   * 的 provider 不动,界面上是 A 引擎、实际跑的是 B,一句提示都没有。
   */
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.SESSION_SAVE_MESSAGES, {
    sessionId: s,
    messages: [{ id: nid("m"), sessionId: s, role: "user", content: "已经有话了", createdAt: 1000 }],
  });
  const before = SessionRepo.get(s)?.providerId;
  const threw = await catching(IPC.SESSION_UPDATE_SETTINGS, {
    sessionId: s,
    providerId: "codex-sdk",
  });
  check("已经有消息的会话改 providerId 被拒", threw.includes("fixed once"), threw);
  eq("而且引擎真的没被改掉", SessionRepo.get(s)?.providerId, before);

  // envMode / wtStyle 同理:已物化 worktree 的会话不该再被改环境意图。
  const threwEnv = await catching(IPC.SESSION_UPDATE_SETTINGS, {
    sessionId: s,
    envMode: "worktree",
  });
  check("已经有消息的会话改 envMode 不报错(它没有 worktree,那道门只看 worktreePath)", threwEnv === "", threwEnv);
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
  // ── MC-048 ── 从前 `SESSION_UPDATE_SETTINGS` 只在**换目录**那一支查会话在不在;其余
  // 字段直接 `SessionRepo.updateSettings(id, ...)` —— 那是个 UPDATE,打不中任何行时
  // **静默什么都不做**,渲染端一句拒绝都收不到(它本该弹成一句话)。现在
  // `SessionRepo.updateSettings` 用 `getRowsModified()` 判存在性,不存在就抛。
  const threw = await catching(IPC.SESSION_UPDATE_SETTINGS, {
    sessionId: "根本没有这个会话",
    model: "x",
  });
  check(
    "★ 改一个不存在的会话**如实报错**(不再假成功)",
    threw.includes("unknown session"),
    threw || "(这是现状:没有被告知)",
  );
  // 判据落在"用户有没有被告知"上:桌面端收到的是 Not-found 类的拒绝。
  check("★ 拒绝理由点明了是哪个会话没了", threw.includes("根本没有这个会话"), threw);
}

{
  // 反面:真实存在的会话照常更新,不会被上面那道存在性检查误伤。
  fresh();
  const s = mkSession(nid("s"));
  await call(IPC.SESSION_UPDATE_SETTINGS, { sessionId: s, model: "照常改" });
  eq("★ 存在会话的正常更新不受影响", SessionRepo.get(s)?.model, "照常改");
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
  check("分叉一条不存在的会话会抛(不静默造一条空的)", threw.includes("要复制的对话已经不在了"), threw);
  check("★ 而且那句话是中文(它原样进失败 toast 的正文)", !/unknown session/i.test(threw), threw);
}

/* ──────────────── 17. 引擎清单 ──────────────── */

console.log("\n17. 引擎清单(没装引擎时说的是实话)");

{
  const res = await call<{ providers: unknown[] }>(IPC.PROVIDER_LIST);
  eq("无头环境里没有引擎 → 空清单(不是编一个出来)", res.providers.length, 0);
}

/* ──────────────── 18. 【MC-059】无渲染窗口时业务动作照常 ────────────────
 *
 * ## 这条守的是什么
 *
 * `appControl/tools.ts` 的 `app_session_new` / `app_session_send` 从前**只**经 UI 桥
 * (`webContents.executeJavaScript` → 渲染端 `window[APP_CONTROL_RENDERER_GLOBAL]`)下发。
 * 于是**没有任何渲染窗口**时(无人值守 / 自动化 / 窗口还没起来 / 窗口崩了),agent 连
 * 「开一个对话」「往对话发一句话」都做不了 —— 而这两件事的**状态(会话行、运行时)本来就
 * 归主进程**,窗口只是"把用户的视线切过去"。这就是台账 MC-059:控制面必须能脱离渲染窗口。
 *
 * 修法(已在 `tools.ts` 里,这里**证**它):UI 桥报"窗口没开/界面没准备好"时,改走主进程的
 * **同一套服务**(`createOrReuseSession` + `runtimeManager.sendTurn`,与桌面 IPC 走的是同一份
 * 实现),而不是失败。
 *
 * ## 为什么放在这一套(而不是 app-control-smoke)
 *
 * `app-control-smoke` 没有 SQLite —— `createOrReuseSession` 一碰 `ProjectRepo` 就抛。
 * 这一套有**真库**(真 sqlite、临时数据根)、真 `createOrReuseSession`、真会话表、
 * RuntimeManager 桩(记 `sendTurn`),正好是验"会话行真的落库、turn 真的派出去了"的地方。
 *
 * ## 无窗口怎么造
 *
 * `setRendererPortForTest(null)` + 本套 `@main/window.js` 桩的 `getMainWindow() → null`
 * ⇒ `runUiCommand` 的 `defaultPort()` 抛 "Mcode 主窗口没有打开,界面操作做不了" ——
 * 那正是 `uiUnavailable` 认得的"窗口没开"那一类。**刻意不用** `executeJavaScript` 桩去
 * 假装窗口在,这条要验的就是"没有窗口这条真实路径"。
 *
 * ## 反向控制(不许假绿)
 *
 * ① 纯 UI 动作(`app_ui` 切对话 / `screenshot_panel`)在同样的无窗口环境下**仍要如实报错**
 *   —— 它们**确实**绑在界面上,不是所有东西都能无窗口。
 * ② 窗口**在**时,必须走原来的 UI 路,且**没有二次发送**(不留"UI 也发一遍、headless 又发
 *   一遍"的双发)。
 */

console.log("\n18. 【MC-059】无渲染窗口时 app_session_new / app_session_send 照常,纯 UI 动作仍报错");

{
  const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
    r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");

  // 审批通道:写作档默认放行一次(与真实回合里的审批卡同形)。
  const appCtx = {
    getPermissionMode: () => undefined,
    isToolAlwaysAllowed: () => false,
    requestApproval: async () => ({ allow: true }),
  } as unknown as ProviderContext;

  // 一个**全新的项目**(零会话),这样 findFreshByProject 一定没有可复用的空壳 ——
  // 断言"会话行真的多了一条"才不会被上一段的残留空壳复用掉而假红。
  const MC059_DIR = mkdtempSync(join(tmpdir(), "mcode-mc059-proj-"));
  ProjectRepo.create({
    id: "p_mc059",
    name: "无窗口回归项目",
    path: MC059_DIR,
    archived: false,
    group: null,
    sortOrder: 2,
    pinnedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never);

  fresh();
  // —— 无窗口:端口置空;本套 window 桩的 getMainWindow() 本来就回 null。
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;

  const beforeIds = new Set(SessionRepo.listByProject("p_mc059").map((s) => s.id));
  const created = await invokeAppTool("app_session_new", { project_id: "p_mc059", prompt: "无窗口也要能开对话" }, "me", appCtx);
  check("★ app_session_new 在无窗口时不失败", created.isError !== true, textOf(created));

  const afterList = SessionRepo.listByProject("p_mc059");
  const newIds = afterList.map((s) => s.id).filter((id) => !beforeIds.has(id));
  check("★ 无窗口时 app_session_new 真的落了一条会话行(SessionRepo 查得到)", newIds.length === 1, [...beforeIds, ...afterList.map((s) => s.id)]);
  const newId = newIds[0];
  eq("★ 落库的会话属于指定项目", SessionRepo.get(newId)?.projectId, "p_mc059");
  // 那一轮真的派出去了(走 headlessNewSession → runtimeManager.sendTurn 那份实现)。
  eq("★ 无窗口时这一轮真的派出去了(sendTurn 被调到)", sendTurns.length, 1);
  eq("★ 派出去的是那句话", sendTurns[0]?.prompt, "无窗口也要能开对话");
  eq("★ 派给的是刚建的那条会话", sendTurns[0]?.sessionId, newId);
  eq("★ 跑在项目目录里(cwd 解析正确)", sendTurns[0]?.cwd, MC059_DIR);

  // —— app_session_send:往一条**已有**会话发,无窗口时应发送而不是失败。
  // 目标会话**独立**建一条(不依赖上面 app_session_new 的产物)—— 否则 app_session_new 一失败,
  // 这条就会因"缺 session_id"而红,红在了错的地方,证不了"发送本身能无窗口"。
  fresh();
  const sendTarget = mkSession(nid("s_mc059_send"), { title: "发送目标" });
  const sendRes = await invokeAppTool("app_session_send", { session_id: sendTarget, prompt: "第二条" }, "me", appCtx);
  check("★ app_session_send 在无窗口时不失败", sendRes.isError !== true, textOf(sendRes));
  eq("★ 无窗口时消息真的发出去了(sendTurn 被调到)", sendTurns.length, 1);
  eq("★ 发给了指定的那条会话", sendTurns[0]?.sessionId, sendTarget);
  eq("★ 发的是那条消息", sendTurns[0]?.prompt, "第二条");

  // —— app_workflow_run 的"无触发器 → 在对话里跑"这条路(ARC-001 步⑤):它从前也经 UI 桥。
  // 跑工作流是**纯业务**动作(会话行 + 起一轮工作流运行本就在主进程),无窗口时同样该走 headless。
  fresh();
  const wfTarget = mkSession(nid("s_mc059_wf"), { title: "工作流目标" });
  const wfRes = await invokeAppTool(
    "app_workflow_run",
    { workflow_id: "wf_mc059", prompt: "按这个工作流跑", session_id: wfTarget },
    "me",
    appCtx,
  );
  check("★ app_workflow_run 在无窗口时不失败", wfRes.isError !== true, textOf(wfRes));
  eq("★ 无窗口时工作流那一轮真的派出去了", sendTurns.length, 1);
  eq("★ 发给了指定的对话", sendTurns[0]?.sessionId, wfTarget);
  eq("★ 带着工作流 id 发出去(workflowId 随轮下发)", sendTurns[0]?.workflowId, "wf_mc059");

  // —— 反向控制①:纯 UI 动作同样无窗口时**仍要如实报错**(它们真绑在界面上)。
  // 用**字面** session_id(不依赖上面那条 newId)—— 否则会话建失败时它会因"缺参数"而红,
  // 那就成了"被上面的失败连累",不是"纯 UI 动作本来就绑窗口"这个独立事实。
  const uiRes = await invokeAppTool("app_ui", { action: "open_session", session_id: "s_literal_ui" }, "me", appCtx);
  check("★ 纯 UI 动作(切对话)在无窗口时如实报错", uiRes.isError === true && /窗口没有打开|界面/.test(textOf(uiRes)), textOf(uiRes));
  const shotRes = await invokeAppTool("app_ui", { action: "screenshot_panel" }, "me", appCtx);
  check("★ screenshot_panel 在无窗口时如实报错(不返回空图冒充成功)", shotRes.isError === true, textOf(shotRes));

  // —— 反向控制②:窗口**在**时走原 UI 路,且**没有二次发送**。
  {
    fresh();
    const { APP_CONTROL_RENDERER_GLOBAL } = await import("@contracts/appControl");
    const seen: Array<{ op: string }> = [];
    const win: Record<string, unknown> = {
      [APP_CONTROL_RENDERER_GLOBAL]: async (raw: string) => {
        const cmd = JSON.parse(raw) as { op: string };
        seen.push(cmd);
        return JSON.stringify({ ok: true, data: { sessionId: "s_from_ui" } });
      },
    };
    (globalThis as Record<string, unknown>).window = win;
    setRendererPortForTest({ executeJavaScript: async (code) => (0, eval)(code) });

    const sendsBefore = sendTurns.length;
    const viaUi = await invokeAppTool("app_session_new", { project_id: "p_mc059", prompt: "窗口在时" }, "me", appCtx);
    check("窗口在时 app_session_new 走 UI 路、不失败", viaUi.isError !== true, textOf(viaUi));
    check("★ 窗口在时下发的是 UI 命令(op=new_session)", seen.some((c) => c.op === "new_session"), seen);
    eq("★ 窗口在时**没有**走 headless 二次发送(无双发)", sendTurns.length, sendsBefore);

    const sendViaUi = await invokeAppTool("app_session_send", { session_id: "s_literal_ui_send", prompt: "窗口在时也发" }, "me", appCtx);
    check("窗口在时 app_session_send 走 UI 路、不失败", sendViaUi.isError !== true, textOf(sendViaUi));
    check("★ 窗口在时下发的是 UI 命令(op=send)", seen.some((c) => c.op === "send"), seen);
    eq("★ 窗口在时 app_session_send 也没有二次发送(无双发)", sendTurns.length, sendsBefore);

    setRendererPortForTest(null);
    delete (globalThis as Record<string, unknown>).window;
  }

  rmSync(MC059_DIR, { recursive: true, force: true });
}

/* ──────────────── 19. 【ARC-001】「建会话 + 发首条」只有一处实现 ──────────────── */

/**
 * ## 这条守的是什么(硬规矩 2:共享实现只有一份)
 *
 * ARC-001 的 remaining 点名的第①条:业务动作要从"各入口各写一遍"收成**唯一一份**服务函数
 * (`appServices/sessionCommands.ts` 的 `createSessionAndSend`)。此前桌面 `claude:startSession`
 * IPC 建会话、agent 那条 headless 路(`appControl/tools.ts` 的 `headlessNewSession`)又**内联**了
 * 「查项目 → createOrReuseSession → 解析 cwd → sendTurn」一整段 —— 两处会漂开。
 *
 * ## 判据(承重红例:**两条路都调同一个服务函数**)
 *
 * `createSessionAndSend` 里有一个调用计数器(`__createSessionAndSendCount`)。两条路各走一次,
 * 计数器必须**各加一**(共 +2)。若哪条路回去内联自己那段(绕开服务函数),它那一次就不计数 →
 * **真红**。这是**行为级**的判据,不是 grep 源码 —— 内联得再像也骗不过计数器。
 *
 * 另加一条**源码级**反向控制:两条调用方文件里都**不再**直接 `createOrReuseSession`
 * 建会话(建会话这半必须经服务函数);出现直接调用就是有人又分了一份实现。
 *
 * ## 【ARC-001 步②】ActionContext —— 「谁在调」变成结构化事实
 *
 * 台账 remaining 第②条:`createSessionAndSend` 只收一个裸的 `source` 字符串,调用方
 * 「是谁」没有结构化。本切片把它换成入参 `ActionContext`(actorKind / actorId /
 * operationId / 可选 scope),两条调用方各填自己的身份:桌面 = `user`、agent = `agent`
 * (mobile 由服务函数按 actorKind 直接支持)。判据(承重红例):桌面路传出的
 * `actorKind` **必须** `"user"`、agent 路 **必须** `"agent"` —— 把任一分支改反/撤掉,
 * 断言必须真红。用 `__lastActionContext()`(与 `__createSessionAndSendCount` 同一取向的
 * 测试观测)读回服务函数最近一次收到的 context。
 */
console.log("\n19. 【ARC-001】建会话+发首条只有一处实现(桌面 IPC 与 agent headless 共调 createSessionAndSend)");

{
  const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
    r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
  const appCtx = {
    getPermissionMode: () => undefined,
    isToolAlwaysAllowed: () => false,
    requestApproval: async () => ({ allow: true }),
  } as unknown as ProviderContext;

  // 一个**全新的项目**(不用 §2/§18 的项目,避开残留空壳的复用)。
  const ARC001_DIR = mkdtempSync(join(tmpdir(), "mcode-arc001-proj-"));
  ProjectRepo.create({
    id: "p_arc001",
    name: "ARC-001 唯一服务回归项目",
    path: ARC001_DIR,
    archived: false,
    group: null,
    sortOrder: 3,
    pinnedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never);

  // —— 路①:桌面 IPC `claude:startSession` → 服务函数应被记一次。
  fresh();
  __resetCreateSessionAndSendCount();
  const ipcRes = await call<{ session: { id: string; projectId: string } }>(IPC.CLAUDE_START_SESSION, {
    projectId: "p_arc001",
  });
  eq("ARC-001:桌面 IPC 建会话落在指定项目里(行为不变)", ipcRes.session.projectId, "p_arc001");
  eq("ARC-001:桌面 IPC 建会话经唯一服务函数(计数 +1)", __createSessionAndSendCount(), 1);

  // 【ARC-001 步②】桌面路传出的身份 = 用户(结构化「谁在调」)。
  const ipcActx = __lastActionContext();
  eq("★ ARC-001②:桌面 IPC 传出的 actorKind 是 user(结构化「谁在调」)", ipcActx?.actorKind, "user");
  eq("★ ARC-001②:桌面 IPC 的 actorId 非空", typeof ipcActx?.actorId === "string" && ipcActx.actorId.length > 0, true);
  eq("★ ARC-001②:桌面 IPC 的 operationId 非空", typeof ipcActx?.operationId === "string" && ipcActx.operationId.length > 0, true);
  eq("★ ARC-001②:桌面 IPC 带出作用域(项目 id)", ipcActx?.scope, "p_arc001");

  // —— 路②:agent 那条无窗口 headless 路 → 同一个服务函数应再记一次。
  fresh();
  __resetCreateSessionAndSendCount();
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
  const agentRes = await invokeAppTool(
    "app_session_new",
    { project_id: "p_arc001", prompt: "无窗口发首条" },
    "me",
    appCtx,
  );
  check("ARC-001:agent headless 建会话+发首条不失败", agentRes.isError !== true, textOf(agentRes));
  eq("★ ARC-001:agent headless 也走**同一个**服务函数(计数 +1,承重)", __createSessionAndSendCount(), 1);
  eq("★ ARC-001:headless 这一轮真的派出去了(sendTurn 被调到)", sendTurns.length, 1);
  eq("★ ARC-001:headless 派的是那句话", sendTurns[0]?.prompt, "无窗口发首条");

  // 【ARC-001 步②】agent 路传出的身份 = agent,actorId = 发起调用的会话 id。
  const agentActx = __lastActionContext();
  eq("★ ARC-001②:agent headless 传出的 actorKind 是 agent(结构化「谁在调」)", agentActx?.actorKind, "agent");
  eq("★ ARC-001②:agent headless 的 actorId 是发起调用的会话 id", agentActx?.actorId, "me");
  eq("★ ARC-001②:agent headless 的 operationId 非空", typeof agentActx?.operationId === "string" && agentActx.operationId.length > 0, true);

  // 【ARC-001 步②】mobile 这一档由服务函数直接支持(当前无生产调用方,直接调服务函数验映射)。
  __resetCreateSessionAndSendCount();
  const mobileRes = await createSessionAndSend(
    { input: { projectId: "p_arc001", kind: "chat", effort: "default", permissionMode: "default" } },
    { actorKind: "mobile", actorId: "phone-1", operationId: "op-mobile-1", scope: "p_arc001" },
  );
  eq("★ ARC-001②:mobile 路传出的 actorKind 是 mobile", __lastActionContext()?.actorKind, "mobile");
  eq("★ ARC-001②:mobile 路走同一份命令(计数 +1)", __createSessionAndSendCount(), 1);
  eq("★ ARC-001②:mobile 路仍落到指定项目(行为不变)", mobileRes.session.projectId, "p_arc001");

  // 两条路都经服务函数 ⇒ 服务函数是唯一实现。给一个总数复核(清零后连走两条)。
  __resetCreateSessionAndSendCount();
  await call(IPC.CLAUDE_START_SESSION, { projectId: "p_arc001" });
  await invokeAppTool("app_session_new", { project_id: "p_arc001", prompt: "再来一条" }, "me", appCtx);
  eq("★ ARC-001:桌面 IPC 与 agent headless 共调同一条命令(计数 = 2)", __createSessionAndSendCount(), 2);

  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
  rmSync(ARC001_DIR, { recursive: true, force: true });

  // —— 源码级反向控制:两条调用方都不再**直接** createOrReuseSession(建会话只该经服务函数)。
  const srcOf = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");
  const ipcSrc = srcOf("src/main/ipc/claude.ts");
  const toolsSrc = srcOf("src/main/appControl/tools.ts");
  const svcSrc = srcOf("src/main/appServices/sessionCommands.ts");
  check("★ ARC-001:桌面 IPC 不再直接调 createOrReuseSession(建会话经服务函数)", !/createOrReuseSession\s*\(/.test(ipcSrc), ipcSrc.match(/createOrReuseSession\s*\(/g));
  check("★ ARC-001:agent headless 段不再直接调 createOrReuseSession", !/createOrReuseSession\s*\(/.test(toolsSrc), toolsSrc.match(/createOrReuseSession\s*\(/g));
  check("ARC-001:服务函数本身才是 createOrReuseSession 的调用点", /createOrReuseSession\s*\(/.test(svcSrc));
}

/* ──────────────── 收尾 ──────────────── */

rmSync(PROJECT_DIR, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });

console.log(`\nclaude-ipc-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
