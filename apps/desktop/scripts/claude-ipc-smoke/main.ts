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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

import {
  IPC,
  THEME_STYLE_SETTING_KEY,
  TURN_BUDGET_SETTING_KEY,
  WORKFLOW_PINNED_DEFAULTS_SETTING_KEY,
  WORKFLOW_REVIEW_SETTING_PREFIX,
} from "@contracts/ipc";
import type { Session } from "@contracts/session";
import type { ProviderContext } from "@contracts/provider";
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, MessageRepo, SettingRepo } from "@main/store/repositories.js";
import { registerClaudeHandlers } from "@main/ipc/claude.js";
import { registerUnattendedHandlers } from "@main/ipc/unattended.js";
import { invokeAppTool } from "@main/appControl/tools.js";
import { setRendererPortForTest } from "@main/appControl/uiBridge.js";
import {
  __createSessionAndSendCount,
  __lastActionContext,
  __lastPermissionGrant,
  __resetCreateSessionAndSendCount,
  createSessionAndSend,
} from "@main/appServices/sessionCommands.js";
import { GrantStore } from "@main/appControl/grantStore.js";
import { getGrantStore, setGrantStore, assembleGrantStore } from "@main/appControl/grantStoreRuntime.js";
import {
  UnattendedPlanRefusedError,
  executeUnattendedPlan,
  issueUnattendedTaskPlan,
  unattendedPlanDigest,
  listUnattendedPlans,
  resumeUnattendedPlanWithGrant,
  abandonUnattendedPlan,
  type UnattendedTaskPlan,
} from "@main/appServices/unattendedTaskPlan.js";
import {
  assembleUnattendedPlanStore,
  setUnattendedPlanStore,
  getUnattendedPlanStore,
  unattendedPlanStorePath,
  parseUnattendedPlans,
  classifyUnattendedPlanArchive,
} from "@main/appServices/unattendedPlanStore.js";
import { resolveUnattendedInitiator } from "@main/ipc/unattended.js";
import { physicalPath } from "@main/lib/realPathWithin.js";
import type { ActorRef, CoreIntent } from "@contracts/policyEngine";

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
// 【MC-059】真 handler:无人值守计划的用户签发 + 执行入口(走真 handler,不是复述其逻辑)。
registerUnattendedHandlers(fakeIpc);

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

/* ─────── 13a2. 【ARC-006 创建≠执行授权】通用设置写不能改写执行授权标记 ───────
 *
 * `workflow.review.v1.<id>` 是"这条自动化 / 外来工作流能不能无人值守执行"的
 * 唯一事实。`app_api_call` 里的 `setting.set` 是**每次审批的写档**且可被 Agent 调用,
 * 而真正的签发口 `workflow.approve` 对 Agent 是 blocked —— 若通用设置写放行这一族,
 * 审批就退化成"点一次设置写入"(模型还能先把原值读出来再原样写回)。这里钉住:
 * 写它必须**抛错且不落库**,而同一前缀族之外/同族显示偏好照常能写。 */
{
  // 键名经**真实写入方**建出(不手写字面量):通用设置写的拒绝判据必须认得真的那一族键,
  // 两道判据若漂开(改前缀只改一处),下面第一条会红。
  const { requireWorkflowReview } = await import("@main/orchestration/workflowTrust.js");
  const probeWf = "wf_setting_probe";
  requireWorkflowReview(probeWf, "ai");
  const REVIEW_KEY = `${WORKFLOW_REVIEW_SETTING_PREFIX}${probeWf}`;
  const fixtureValue = (await call<{ value: unknown }>(IPC.SETTING_GET, { key: REVIEW_KEY })).value;
  check("夹具:真实审批标记已写入", fixtureValue !== null);
  const threw = await catching(IPC.SETTING_SET, {
    key: REVIEW_KEY,
    value: JSON.stringify({ origin: "ai", approvedRevision: "c".repeat(64) }),
  });
  check("★ ARC-006:setting.set 写执行授权标记被拒(抛出可读原因)", threw.length > 0, threw);
  check("拒绝原因说清该走哪条路", threw.includes("审查"), threw);
  const got = await call<{ value: unknown }>(IPC.SETTING_GET, { key: REVIEW_KEY });
  eq("★ ARC-006:被拒的写没有改到标记(仍是原值)", got.value, fixtureValue);
  // 正控:同前缀族之外的普通偏好照常写(判据只到 `workflow.review.v1.` 为止)。
  const prefKey = "workflow.nodePrefs.wf_setting_probe";
  const prefThrew = await catching(IPC.SETTING_SET, { key: prefKey, value: JSON.stringify({ scope: "all" }) });
  eq("正控:工作流显示偏好照常可写", prefThrew, "");
  const pref = await call<{ value: unknown }>(IPC.SETTING_GET, { key: prefKey });
  eq("正控:显示偏好确实落库", pref.value, JSON.stringify({ scope: "all" }));

  // 【ARC-006 残余】**「恢复默认」快照**(`workflow.pinnedDefaults`)同一档。
  // `restoreWorkflowDefault` 把快照**直接落库、不再过审**,它的信任前提是"只由
  // pinWorkflowDefault 写入"。放行通用设置写 = 给 Agent 一条"先种快照、再点一次
  // 恢复默认"的免审执行路 —— 与审查记录族是同一个洞,只是绕一层。
  // 键名同样不写字面量:走 contracts 的共享常量,判据漂开时这里会红。
  const pinnedThrew = await catching(IPC.SETTING_SET, {
    key: WORKFLOW_PINNED_DEFAULTS_SETTING_KEY,
    value: JSON.stringify({ wf_forged: { id: "wf_forged", name: "伪造快照", nodes: [], edges: [], builtin: false, updatedAt: 0 } }),
  });
  check("★ ARC-006 残余:setting.set 写「恢复默认」快照被拒(抛出可读原因)", pinnedThrew.length > 0, pinnedThrew);
  check("拒绝原因说清该走哪条路", pinnedThrew.includes("审查"), pinnedThrew);
  eq(
    "★ ARC-006 残余:被拒的快照没有落库",
    (await call<{ value: unknown }>(IPC.SETTING_GET, { key: WORKFLOW_PINNED_DEFAULTS_SETTING_KEY })).value,
    null,
  );
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

  // 【MC-059】mobile **生产入口**(`mobileRpc.ts` 的 `claude:startSession`)也必须经同一份命令
  // —— 此前它内联 `createOrReuseSession`,绕过服务函数(三端里唯一漏网的一条)。这条是**源码级
  // 接线不变量**(不动态 import mobileRpc,那会把整条 mobile 模块链拉进 bundle、需要更多
  // electron 桩):剥注释后断言 handler 里出现 `createSessionAndSend`、且**不再**内联
  // `createOrReuseSession(`。撤掉修复后必须真红。
  {
    const raw = readFileSync(join(process.cwd(), "src/main/mobile/mobileRpc.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const handler = /"claude:startSession":\s*async\s*\([\s\S]*?\n  \},/.exec(raw)?.[0] ?? "";
    check("★ MC-059:mobile 生产入口真的调了唯一服务函数 createSessionAndSend", handler.includes("createSessionAndSend("), handler.slice(0, 160));
    check("★ MC-059:mobile 生产入口不再内联 createOrReuseSession(三端统一)", !handler.includes("createOrReuseSession("), handler.slice(0, 160));
  }

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

/* ──────────── 19b. 【ARC-001 步③】expectedRevision —— 复用前的乐观并发修订号 ──────────── */

/**
 * ## 这条守的是什么(台账 remaining:`ActionContext.expectedRevision` 未落)
 *
 * 步②落了「谁在调」;步③落 remaining 点名的 `expectedRevision`(乐观并发修订号)。判据:
 * 调用方读了一条「新对话」空壳、拿到它的**行修订号**(会话行的 `updatedAt`,见
 * `lib/sessionStart.ts` 的 `sessionRevisionOf`),把它带进来 —— 命令在**复用前**先核对
 * 它还是不是那一版,对不上就**拒绝**(抛 `SessionRevisionConflictError`,**什么都不建、不发**),
 * 绝不静默复用/新建一条调用方没预期的会话。
 *
 * ## 承重红例(判别式 —— 必须**成对**)
 *
 *   - **正面**:带**正确**修订号 → 复用成功(证明闸门不是"一律抛"的假实现);
 *   - **反面**:带**过期**修订号 → 拒绝,且**没多出一条会话**(证明闸门真的在核、且在写之前核)。
 *
 * 两条缺一不可:只测反面,一个"永远抛"的坏实现也能全绿;只测正面,一个"从不核"的实现也全绿。
 *
 * ## 为什么用**直接建行 + 自选 updatedAt**(而不是靠两次调用自然撞号)
 *
 * `updated_at` 是 `Date.now()`,两次调用可能落在**同一毫秒** → 修订号不变 → 反面用例会
 * **偶发假绿**(没检测到冲突)。所以这里**直接 `SessionRepo.create` 一条 `updatedAt` 自选的
 * 空壳行**,让"哪一版"完全确定 —— 反面用例钉的是一个**必然不同**的旧版本号。
 */
console.log("\n19b. 【ARC-001 步③】expectedRevision —— 复用前的乐观并发修订号");

{
  const textOf19 = (r: { content: Array<{ type: string; text?: string }> }): string =>
    r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
  const codeOf = (r: { structuredContent?: Record<string, unknown> }): unknown =>
    (r.structuredContent?.operation_result as { code?: unknown } | undefined)?.code;
  const kindOf = (r: { structuredContent?: Record<string, unknown> }): unknown =>
    (r.structuredContent?.operation_result as { resultKind?: unknown } | undefined)?.resultKind;

  const appCtx19 = {
    getPermissionMode: () => undefined,
    isToolAlwaysAllowed: () => false,
    requestApproval: async () => ({ allow: true }),
  } as unknown as ProviderContext;

  /** 建一个全新项目 + 一条 `updatedAt` 自选的「新对话」空壳行(完全确定"是哪一版")。 */
  const seedShell = (projectId: string, shellId: string, dir: string, updatedAt: number): void => {
    ProjectRepo.create({
      id: projectId,
      name: `OCC 项目 ${projectId}`,
      path: dir,
      archived: false,
      group: null,
      sortOrder: 9,
      pinnedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as never);
    SessionRepo.create({
      id: shellId,
      projectId,
      providerId: "claude-sdk",
      claudeSessionId: null,
      kind: "chat",
      parentSessionId: null,
      title: "New session", // findFreshByProject 的复用判据:默认占位标题
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
      createdAt: updatedAt,
      updatedAt, // ← 断言"是哪一版"全靠它
    } as unknown as Session);
  };

  const OCC_DIR = mkdtempSync(join(tmpdir(), "mcode-occ-proj-"));

  /** 正面用例要能**干净地红**:闸门若"一律抛",这里会抛 —— 用 try 收成 null 让断言
   *  报一条 FAIL(而不是让整个套件崩在这里,把后面的用例一起带没)。 */
  const tryStart = async (raw: Record<string, unknown>): Promise<string | null> => {
    try {
      const r = await call<{ session: { id: string } }>(IPC.CLAUDE_START_SESSION, raw);
      return r.session.id;
    } catch {
      return null;
    }
  };

  // ── 路①:桌面 IPC —— 正面(修订号对)与反面(修订号过期)成对。 ──
  fresh();
  seedShell("p_occ", "s_occ_shell", OCC_DIR, 1000);
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;

  // 正面:带的正是这一版 → 复用成功(闸门不是"一律抛")。
  eq(
    "★ ARC-001③:桌面 IPC 带**正确**修订号 → 复用了那条空壳",
    await tryStart({ projectId: "p_occ", expectedRevision: "1000" }),
    "s_occ_shell",
  );

  // 反面:同一条空壳,带一个**必然不同**的旧版本号 → 拒绝(复用前核,不写任何一行)。
  const beforeCount = SessionRepo.listByProject("p_occ").length;
  const staleMsg = await catching(IPC.CLAUDE_START_SESSION, {
    projectId: "p_occ",
    expectedRevision: "999",
  });
  check("★ ARC-001③:桌面 IPC 带**过期**修订号 → 拒绝(不是静默复用)", /修订号/.test(staleMsg), staleMsg);
  eq("★ ARC-001③:被拒时没有多建会话(拒绝发生在写之前)", SessionRepo.listByProject("p_occ").length, beforeCount);

  // 正面②:重新读回当前行的修订号,再带它 → 又能复用(证明闸门读的是**活的**版本)。
  const live = SessionRepo.listByProject("p_occ").find((s) => s.id === "s_occ_shell");
  const liveRev = String(live?.updatedAt);
  __resetCreateSessionAndSendCount();
  eq(
    "★ ARC-001③:带上**当前**修订号 → 复用成功",
    await tryStart({ projectId: "p_occ", expectedRevision: liveRev }),
    "s_occ_shell",
  );

  // ── 路②:agent headless —— 同样的成对判据(经唯一业务命令,非 UI 路)。 ──
  fresh();
  seedShell("p_occ_agent", "s_occ_agent_shell", OCC_DIR, 7000);
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;

  const agentOk = await invokeAppTool(
    "app_session_new",
    { project_id: "p_occ_agent", prompt: "带着正确修订号", expected_revision: "7000" },
    "me",
    appCtx19,
  );
  check("★ ARC-001③:agent 带**正确**修订号 → 建/复用成功", agentOk.isError !== true, textOf19(agentOk));

  const agentBefore = SessionRepo.listByProject("p_occ_agent").length;
  const agentStale = await invokeAppTool(
    "app_session_new",
    { project_id: "p_occ_agent", prompt: "带着过期修订号", expected_revision: "1" },
    "me",
    appCtx19,
  );
  eq("★ ARC-001③:agent 带**过期**修订号 → REJECTED(没执行)", kindOf(agentStale), "REJECTED");
  eq("★ ARC-001③:agent 带过期修订号 → 稳定短码 revision_conflict", codeOf(agentStale), "revision_conflict");
  check("★ ARC-001③:agent 被拒时 isError=true(如实报错)", agentStale.isError === true, textOf19(agentStale));
  eq("★ ARC-001③:agent 被拒时没有多建会话(拒绝发生在写之前)", SessionRepo.listByProject("p_occ_agent").length, agentBefore);

  // ── 反面③:带修订号但**根本没有可复用的空壳** → 同样拒绝,不静默新建。 ──
  fresh();
  ProjectRepo.create({
    id: "p_occ_empty",
    name: "OCC 空项目",
    path: OCC_DIR,
    archived: false,
    group: null,
    sortOrder: 9,
    pinnedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as never);
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
  const emptyMsg = await catching(IPC.CLAUDE_START_SESSION, {
    projectId: "p_occ_empty",
    expectedRevision: "1",
  });
  check("★ ARC-001③:没有可复用空壳却带了修订号 → 拒绝(不静默新建)", /修订号/.test(emptyMsg), emptyMsg);
  eq("★ ARC-001③:被拒时一条也没建出来", SessionRepo.listByProject("p_occ_empty").length, 0);

  // ── 反面④:窗口**在**时,带修订号的请求也**不许**走 UI 路(UI 的 new_session 不认
  //     expected_revision —— 走它等于把闸悄悄绕过去)。判据:UI 桥没收到 op=new_session,
  //     且过期修订号照样被 REJECTED。 ──
  fresh();
  seedShell("p_occ_win", "s_occ_win_shell", OCC_DIR, 5000);
  {
    const { APP_CONTROL_RENDERER_GLOBAL } = await import("@contracts/appControl");
    const seen: Array<{ op: string }> = [];
    (globalThis as Record<string, unknown>).window = {
      [APP_CONTROL_RENDERER_GLOBAL]: async (raw: string) => {
        const cmd = JSON.parse(raw) as { op: string };
        seen.push(cmd);
        return JSON.stringify({ ok: true, data: { sessionId: "s_from_ui" } });
      },
    };
    setRendererPortForTest({ executeJavaScript: async (code) => (0, eval)(code) });

    const winStale = await invokeAppTool(
      "app_session_new",
      { project_id: "p_occ_win", prompt: "窗口在、带过期修订号", expected_revision: "1" },
      "me",
      appCtx19,
    );
    check("★ ARC-001③:窗口在时带修订号 → 不走 UI 路(没下发 op=new_session)", !seen.some((c) => c.op === "new_session"), seen);
    eq("★ ARC-001③:窗口在时带过期修订号 → REJECTED(闸没被 UI 路绕过)", kindOf(winStale), "REJECTED");
    eq("★ ARC-001③:窗口在、带过期修订号 → 稳定短码 revision_conflict", codeOf(winStale), "revision_conflict");

    // 对照:窗口在时**不带**修订号 → 照旧走 UI 路(没把正常路径也堵了)。
    const winLegacy = await invokeAppTool(
      "app_session_new",
      { project_id: "p_occ_win", prompt: "窗口在、不带修订号" },
      "me",
      appCtx19,
    );
    check("★ ARC-001③:窗口在、不带修订号 → 照旧走 UI 路(op=new_session)", seen.some((c) => c.op === "new_session"), seen);
    check("★ ARC-001③:窗口在、不带修订号的对照调用不失败", winLegacy.isError !== true, textOf19(winLegacy));
  }

  // ── 反向控制:不带 expectedRevision 时,行为**照旧**(闸门缺席 = 不启用)。 ──
  fresh();
  seedShell("p_occ_legacy", "s_occ_legacy_shell", OCC_DIR, 3);
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
  const legacy = await call<{ session: { id: string } }>(IPC.CLAUDE_START_SESSION, { projectId: "p_occ_legacy" });
  eq("★ ARC-001③:不带修订号 → 照旧复用(既有调用方行为不变)", legacy.session.id, "s_occ_legacy_shell");

  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
  rmSync(OCC_DIR, { recursive: true, force: true });
}

/* ──────────── 19c. 【ARC-001 步④】permissionGrant —— 计划级授权句柄(宿主核对)──────────── */

/**
 * ## 这条守的是什么(台账 remaining 点名的最后一个 ActionContext 字段)
 *
 * `ActionContext.permissionGrant`(计划级授权句柄)。授权核(`policyEngine.evaluate`)与持有核
 * (`grantStore` / `getGrantStore`)已在其它切片铺好,本切片把它接到**唯一业务命令**
 * `createSessionAndSend` 上:**不采信**调用方自报的字符串,而是由宿主从**目标项目**解析出
 * 「建会话」动作的权威资源身份(`session.create` + `projectPath`),拿 grantId 去
 * `getGrantStore()` 取回授权、交唯一判定核 `evaluate` 核对。覆盖了 → 这次建会话跑在它之下;
 * 核不到 / 失效 / 不覆盖 → **拒绝**(什么都没建)。
 *
 * ## 承重红例(判别式 —— 必须**成对**)
 *
 *   - **正面**:带**覆盖**这次建会话的、有效的用户授权 → 建会话成功 + `__lastPermissionGrant()`
 *     就是那枚 grantId + 该授权 `usedCount` +1(证明核过了、授权真承重、不是空字段);
 *   - **反面**(四种核不过,各自真红):① 授权不存在;② 授权已撤销;③ 授权**不覆盖**(方法不在
 *     表内);④ 授权**核心意图不符**(项目路径是另一个项目)→ **一律拒绝**,且**一条会话都没建**。
 *
 * 只测正面,一个"从不核"的实现全绿;只测反面,一个"一律拒"的坏实现也全绿。
 *
 * ## 为什么用**真实项目路径**造授权
 *
 * `sessionCreateCore(projectId)` 从项目行取 `path` 再经 `physicalPath`(resolve + 跟真实目的地)。
 * 故有效授权钉的 `scopedCore.projectPath` 必须**等于**那条规范化路径 —— 这里用**生产同一份**
 * `physicalPath` 算,不另抄一份格式(那会把"格式对不对"和"核没核"混在一起)。
 */
console.log("\n19c. 【ARC-001 步④】permissionGrant —— 计划级授权句柄(宿主核对,非模型自报)");

{
  const textOf19c = (r: { content: Array<{ type: string; text?: string }> }): string =>
    r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
  const codeOf19c = (r: { structuredContent?: Record<string, unknown> }): unknown =>
    (r.structuredContent?.operation_result as { code?: unknown } | undefined)?.code;
  const kindOf19c = (r: { structuredContent?: Record<string, unknown> }): unknown =>
    (r.structuredContent?.operation_result as { resultKind?: unknown } | undefined)?.resultKind;

  const appCtx19c = {
    getPermissionMode: () => undefined,
    isToolAlwaysAllowed: () => false,
    requestApproval: async () => ({ allow: true }),
  } as unknown as ProviderContext;

  const USER19c: ActorRef = { kind: "user", id: "u19c" };
  const freshStore19c = (): GrantStore => { const s = new GrantStore({ newId: (n) => `gr${n}` }); setGrantStore(s); return s; };

  const GRANT_DIR = mkdtempSync(join(tmpdir(), "mcode-grant-proj-"));
  const mkProject = (id: string, dir: string): void => {
    ProjectRepo.create({
      id, name: `授权项目 ${id}`, path: dir, archived: false, group: null,
      sortOrder: 9, pinnedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    } as never);
  };

  /** 造一份**覆盖给定项目建会话**的有效用户授权(scopedCore.projectPath = 该项目的规范化路径)。 */
  const issueFor = (
    store: GrantStore,
    projectDir: string,
    over: { allowedActions?: string[]; ttlMs?: number } = {},
  ): string => {
    const core: CoreIntent = { projectPath: physicalPath(projectDir) ?? projectDir };
    const g = store.issueGrant(
      {
        verdict: "allow", reason: "用户批准了在这个项目里开对话的计划。", compatibilityLevel: "write",
        sceneId: "scene-19c", allowedActions: over.allowedActions ?? ["session.create"], scopedCore: core,
        configHash: "cfg-19c", ttlMs: over.ttlMs ?? 3_600_000,
      },
      USER19c, Date.now(),
    );
    return g.grantId;
  };

  const headless = (): void => { setRendererPortForTest(null); delete (globalThis as Record<string, unknown>).window; };

  // ── 正面:带覆盖这次建会话的有效授权 → 建会话成功 + 授权被记为"跑在它之下" + 记账。 ──
  fresh();
  freshStore19c();
  mkProject("p_grant_ok", GRANT_DIR);
  headless();
  {
    const gid = issueFor(getGrantStore(), GRANT_DIR);
    const before = SessionRepo.listByProject("p_grant_ok").length;
    const r = await invokeAppTool("app_session_new", { project_id: "p_grant_ok", permission_grant: gid }, "me", appCtx19c);
    check("★ ARC-001④:带覆盖动作的有效授权 → 建会话成功(授权核放行)", r.isError !== true, textOf19c(r));
    eq("★ ARC-001④:真的建了会话(+1)", SessionRepo.listByProject("p_grant_ok").length, before + 1);
    eq("★ ARC-001④:服务函数记为跑在授权之下(宿主核对过、非模型自报)", __lastPermissionGrant(), gid);
    eq("★ ARC-001④:授权被记账 usedCount +1(maxCount 真承重)", getGrantStore().get(gid, Date.now())?.usedCount, 1);
  }

  // ── 反面①:授权**不存在** → 拒绝,且一条会话都没建。 ──
  fresh();
  freshStore19c();
  mkProject("p_grant_missing", GRANT_DIR);
  headless();
  {
    const r = await invokeAppTool("app_session_new", { project_id: "p_grant_missing", permission_grant: "no-such-grant" }, "me", appCtx19c);
    eq("★ ARC-001④:授权不存在 → REJECTED(没执行)", kindOf19c(r), "REJECTED");
    eq("★ ARC-001④:授权不存在 → 稳定短码 grant_refused", codeOf19c(r), "grant_refused");
    eq("★ ARC-001④:授权不存在 → 一条会话都没建", SessionRepo.listByProject("p_grant_missing").length, 0);
  }

  // ── 反面②:授权**已撤销** → 拒绝。 ──
  fresh();
  freshStore19c();
  mkProject("p_grant_revoked", GRANT_DIR);
  headless();
  {
    const store = getGrantStore();
    const gid = issueFor(store, GRANT_DIR);
    store.revoke(gid);
    const r = await invokeAppTool("app_session_new", { project_id: "p_grant_revoked", permission_grant: gid }, "me", appCtx19c);
    eq("★ ARC-001④:授权已撤销 → REJECTED", kindOf19c(r), "REJECTED");
    eq("★ ARC-001④:授权已撤销 → 稳定短码 grant_refused", codeOf19c(r), "grant_refused");
    eq("★ ARC-001④:授权已撤销 → 一条会话都没建", SessionRepo.listByProject("p_grant_revoked").length, 0);
  }

  // ── 反面③:授权存在但**不覆盖这次动作**(方法不在表内)→ 拒绝。 ──
  fresh();
  freshStore19c();
  mkProject("p_grant_method", GRANT_DIR);
  headless();
  {
    const gid = issueFor(getGrantStore(), GRANT_DIR, { allowedActions: ["session.rename"] });
    const r = await invokeAppTool("app_session_new", { project_id: "p_grant_method", permission_grant: gid }, "me", appCtx19c);
    eq("★ ARC-001④:授权不覆盖方法 session.create → REJECTED", kindOf19c(r), "REJECTED");
    eq("★ ARC-001④:授权不覆盖方法 → 稳定短码 grant_refused", codeOf19c(r), "grant_refused");
    eq("★ ARC-001④:授权不覆盖方法 → 一条会话都没建", SessionRepo.listByProject("p_grant_method").length, 0);
  }

  // ── 反面④:授权有效、方法对,但**核心意图不符**(钉的是别的项目路径)→ 拒绝。 ──
  fresh();
  freshStore19c();
  const OTHER_DIR = mkdtempSync(join(tmpdir(), "mcode-grant-other-"));
  mkProject("p_grant_scope", GRANT_DIR);
  headless();
  {
    // 授权钉的是**另一个项目**的路径 → 在 p_grant_scope 里建会话核心意图被换。
    const gid = issueFor(getGrantStore(), OTHER_DIR);
    const r = await invokeAppTool("app_session_new", { project_id: "p_grant_scope", permission_grant: gid }, "me", appCtx19c);
    eq("★ ARC-001④:授权钉的是别的项目路径(核心意图被换)→ REJECTED", kindOf19c(r), "REJECTED");
    eq("★ ARC-001④:核心意图不符 → 稳定短码 grant_refused", codeOf19c(r), "grant_refused");
    eq("★ ARC-001④:核心意图不符 → 一条会话都没建", SessionRepo.listByProject("p_grant_scope").length, 0);
    rmSync(OTHER_DIR, { recursive: true, force: true });
  }

  // ── 反向控制:不带 permission_grant → 行为**照旧**(既有调用方不受影响)。 ──
  fresh();
  freshStore19c();
  mkProject("p_grant_legacy", GRANT_DIR);
  headless();
  {
    __resetCreateSessionAndSendCount();
    const good = await invokeAppTool("app_session_new", { project_id: "p_grant_legacy" }, "me", appCtx19c);
    check("★ ARC-001④:不带授权句柄 → 照旧建会话(既有行为不变)", good.isError !== true, textOf19c(good));
    eq("★ ARC-001④:不带授权句柄 → 不记为跑在授权之下", __lastPermissionGrant(), null);
  }

  // ── 窗口**在**时,带授权句柄也**不许**走 UI 路(UI 的 new_session 不认这枚句柄)。 ──
  fresh();
  freshStore19c();
  mkProject("p_grant_win", GRANT_DIR);
  {
    const gid = issueFor(getGrantStore(), GRANT_DIR);
    const { APP_CONTROL_RENDERER_GLOBAL } = await import("@contracts/appControl");
    const seen: Array<{ op: string }> = [];
    (globalThis as Record<string, unknown>).window = {
      [APP_CONTROL_RENDERER_GLOBAL]: async (raw: string) => {
        const cmd = JSON.parse(raw) as { op: string };
        seen.push(cmd);
        return JSON.stringify({ ok: true, data: { sessionId: "s_from_ui" } });
      },
    };
    setRendererPortForTest({ executeJavaScript: async (code) => (0, eval)(code) });
    const ok = await invokeAppTool("app_session_new", { project_id: "p_grant_win", permission_grant: gid }, "me", appCtx19c);
    check("★ ARC-001④:窗口在、带授权句柄 → 不走 UI 路(没下发 op=new_session)", !seen.some((c) => c.op === "new_session"), seen);
    check("★ ARC-001④:窗口在、带授权句柄 → 走 headless 核对路并成功", ok.isError !== true, textOf19c(ok));
    eq("★ ARC-001④:窗口在、带授权句柄 → 仍记为跑在授权之下", __lastPermissionGrant(), gid);
  }

  setGrantStore(null);
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
  rmSync(GRANT_DIR, { recursive: true, force: true });
}

/* ──────────── 19d. 【MC-059】无人值守任务计划 —— 计划级授权的生产端 + 有界执行 ──────────── */

/**
 * ## 这条守的是什么(MC-059 的**生产端** —— §19c 只落了消费者)
 *
 * §19c 证的是 `createSessionAndSend` **消费**一枚覆盖 `session.create` 的授权(核不到即拒)。
 * 但全仓**没有生产签发口铸得出**这类授权 —— 那条「无人值守建会话」的路有消费者、没有生产者。
 * 本切片补上 `appServices/unattendedTaskPlan.ts`:用户在一次计划上点头后,把一个**有界的
 * 操作序列**铸成**一枚** `Grant`(绑 `planId` / 目标项目权威路径 / 用户主体 / 有效期 /
 * 次数上限),`executeUnattendedPlan` 逐条把它交给**唯一业务命令** `createSessionAndSend`
 * (带 `permissionGrant`),任一步被拒即**就地停住**。
 *
 * ## 承重红例(必须**成对**,缺一即假绿)
 *
 *   - **正面**:一份合法计划(2 条操作,各自显式标题 → 不复用空壳)→ 签出 grant →
 *     `executeUnattendedPlan` 真的建出**2 条**会话、`stoppedAt === null`、且授权 `usedCount`
 *     = 2(`recordUse` 真承重)。且 grant 的 `scopedCore.projectPath` 等于目标项目权威路径。
 *   - **反面**(各自真红、各自稳定码):
 *     ① 签发:agent 主体 → `not_user_actor`;空计划 → `empty_plan`;非正 / 超上限有效期 →
 *        `invalid_ttl`;操作条数 > maxCount → `count_exceeds_bound`;解析不出项目路径 →
 *        `unresolvable_scope`;
 *     ② 执行:某条带对不上的修订号 → **停在那条**、`stopCode === "revision_conflict"`、**该条没建**;
 *        计划已过期(`now >= expiresAt`)→ 停在第 1 条前、`stopCode === "plan_expired"`、**一条没建**;
 *        授权在签出后被撤销 → 第 1 条即 `grant_refused`、**一条没建**;
 *        同一份计划**重放**(maxCount 已用尽)→ 第 1 条即 `grant_refused`(`maxCount` 真承重,不是死字段)。
 *
 * ## 为什么每条操作给**显式标题**
 *
 * `createOrReuseSession` 对默认标题(`New session`)的项目空壳会**复用** —— 那样两条操作只
 * 建**一条**会话,计数断言失去判别力。显式标题 = 每次都各自建新行(与 `lib/sessionStart.ts`
 * 的复用判据同源),于是"2 条操作真的建出 2 条会话"是可判别的。
 */
console.log("\n19d. 【MC-059】无人值守任务计划 —— 计划级授权的生产端 + 有界执行");

{
  const USER19d: ActorRef = { kind: "user", id: "u19d" };
  const freshStore19d = (): GrantStore => { const s = new GrantStore({ newId: (n) => `up${n}` }); setGrantStore(s); return s; };

  const UTP_DIR = mkdtempSync(join(tmpdir(), "mcode-utp-proj-"));
  const mkProject = (id: string, dir: string): void => {
    ProjectRepo.create({
      id, name: `无人值守项目 ${id}`, path: dir, archived: false, group: null,
      sortOrder: 9, pinnedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    } as never);
  };
  const headless = (): void => { setRendererPortForTest(null); delete (globalThis as Record<string, unknown>).window; };

  /** 一份合法计划(2 条会话创建,各自显式标题 → 不复用空壳)。 */
  const mkPlan = (projectId: string, over: Partial<UnattendedTaskPlan> = {}): UnattendedTaskPlan => ({
    planId: `plan-${projectId}`,
    projectId,
    actor: USER19d,
    ttlMs: 600_000,
    maxCount: 2,
    operations: [
      { operationId: "op1", method: "session.create", title: "计划第一步", prompt: "第一步" },
      { operationId: "op2", method: "session.create", title: "计划第二步", prompt: "第二步" },
    ],
    ...over,
  });

  const refusalCode = (fn: () => unknown): unknown => {
    try { fn(); return null; } catch (e) { return (e as { reason_code?: unknown }).reason_code; }
  };

  // ── 正面:合法计划 → 签出 grant → 有界执行建出 2 条会话 + 授权记账。 ──
  fresh();
  freshStore19d();
  mkProject("p_utp_ok", UTP_DIR);
  headless();
  {
    const plan = mkPlan("p_utp_ok");
    const issued = issueUnattendedTaskPlan(plan, Date.now());
    check("★ MC-059:合法计划签出了 grant", typeof issued.grantId === "string" && issued.grantId.length > 0, issued.grantId);
    eq("★ MC-059:授权允许的动作含 session.create", issued.allowedActions.includes("session.create"), true);
    eq("★ MC-059:授权次数上限 = 计划声明的 maxCount", issued.maxCount, 2);
    eq("★ MC-059:授权钉住的资源身份 = 目标项目权威路径", issued.scopedCore.projectPath, physicalPath(UTP_DIR));

    const before = SessionRepo.listByProject("p_utp_ok").length;
    const report = await executeUnattendedPlan(plan, issued, "me");
    eq("★ MC-059:有界执行建出 2 条会话(计划里 2 条操作各自建行)", SessionRepo.listByProject("p_utp_ok").length, before + 2);
    eq("★ MC-059:全部操作按序跑完(stoppedAt 为 null)", report.stoppedAt, null);
    eq("★ MC-059:每条操作都 ok", report.results.every((r) => r.ok), true);
    eq("★ MC-059:授权被记账 usedCount = 2(recordUse 真承重)", getGrantStore().get(issued.grantId, Date.now())?.usedCount, 2);
  }

  // ── 反面①:签发口 —— agent 主体不能给自己发计划授权。 ──
  fresh(); freshStore19d(); mkProject("p_utp_agent", UTP_DIR); headless();
  eq(
    "★ MC-059:agent 主体签计划 → 拒绝(not_user_actor)",
    refusalCode(() => issueUnattendedTaskPlan(mkPlan("p_utp_agent", { actor: { kind: "agent", id: "a1" } }), Date.now())),
    "not_user_actor",
  );

  // ── 反面②:空计划签不出。 ──
  fresh(); freshStore19d(); mkProject("p_utp_empty", UTP_DIR); headless();
  eq(
    "★ MC-059:空计划 → 拒绝(empty_plan)",
    refusalCode(() => issueUnattendedTaskPlan(mkPlan("p_utp_empty", { operations: [] }), Date.now())),
    "empty_plan",
  );

  // ── 反面③:有效期必须为正且不超上限。 ──
  fresh(); freshStore19d(); mkProject("p_utp_ttl", UTP_DIR); headless();
  eq(
    "★ MC-059:非正有效期 → 拒绝(invalid_ttl)",
    refusalCode(() => issueUnattendedTaskPlan(mkPlan("p_utp_ttl", { ttlMs: 0 }), Date.now())),
    "invalid_ttl",
  );
  eq(
    "★ MC-059:超上限有效期 → 拒绝(invalid_ttl)",
    refusalCode(() => issueUnattendedTaskPlan(mkPlan("p_utp_ttl", { ttlMs: 99_999_999_999 }), Date.now())),
    "invalid_ttl",
  );

  // ── 反面④:次数上限不得小于声明的操作条数(声明不得超过自己声明的边界)。 ──
  fresh(); freshStore19d(); mkProject("p_utp_bound", UTP_DIR); headless();
  eq(
    "★ MC-059:操作条数 > maxCount → 拒绝(count_exceeds_bound)",
    refusalCode(() => issueUnattendedTaskPlan(mkPlan("p_utp_bound", { maxCount: 1 }), Date.now())),
    "count_exceeds_bound",
  );

  // ── 反面⑤:项目解析不出权威路径 → 拒绝签一枚空核心授权。 ──
  fresh(); freshStore19d(); headless();
  eq(
    "★ MC-059:未知项目 → 拒绝(unresolvable_scope,绝不签空核心授权)",
    refusalCode(() => issueUnattendedTaskPlan(mkPlan("p_utp_nosuch"), Date.now())),
    "unresolvable_scope",
  );

  // ── 反面⑥:执行时某条修订号对不上 → 停在那条,该条没建(不静默新建)。 ──
  fresh(); freshStore19d(); mkProject("p_utp_rev", UTP_DIR); headless();
  {
    const plan = mkPlan("p_utp_rev", {
      maxCount: 2,
      operations: [
        { operationId: "op1", method: "session.create", title: "第一步", prompt: "a" },
        // 显式标题 → 不复用空壳;再带一个修订号 → 无可复用空壳 + 断言了某版 = 冲突。
        { operationId: "op2", method: "session.create", title: "第二步", prompt: "b", expectedRevision: "999" },
      ],
    });
    const issued = issueUnattendedTaskPlan(plan, Date.now());
    const before = SessionRepo.listByProject("p_utp_rev").length;
    const report = await executeUnattendedPlan(plan, issued, "me");
    eq("★ MC-059:修订号对不上 → 停在那条(stoppedAt = op2)", report.stoppedAt, "op2");
    eq("★ MC-059:停住的稳定码是 revision_conflict", report.stopCode, "revision_conflict");
    eq("★ MC-059:只有第一条落库被拒的那条没建(建了 1 条,不是 2 条)", SessionRepo.listByProject("p_utp_rev").length, before + 1);
  }

  // ── 反面⑦:计划已过期 → 第 1 条前就停,一条都不建(不拿过期授权继续)。 ──
  fresh(); freshStore19d(); mkProject("p_utp_exp", UTP_DIR); headless();
  {
    const plan = mkPlan("p_utp_exp");
    const issued = issueUnattendedTaskPlan(plan, 1_000);
    // 执行时刻远晚于到期时刻(1_000 + 3_600_000)→ 计划已过期。
    const report = await executeUnattendedPlan(plan, issued, "me", 99_999_999);
    eq("★ MC-059:计划已过期 → 停在第 1 条(stoppedAt = op1)", report.stoppedAt, "op1");
    eq("★ MC-059:过期停住的稳定码是 plan_expired", report.stopCode, "plan_expired");
    eq("★ MC-059:过期时一条会话都没建", SessionRepo.listByProject("p_utp_exp").length, 0);
  }

  // ── 反面⑧:授权在签出后被撤销 → 第 1 条即 grant_refused,一条都不建。 ──
  fresh(); freshStore19d(); mkProject("p_utp_revoked", UTP_DIR); headless();
  {
    const plan = mkPlan("p_utp_revoked");
    const issued = issueUnattendedTaskPlan(plan, Date.now());
    getGrantStore().revoke(issued.grantId);
    const report = await executeUnattendedPlan(plan, issued, "me");
    eq("★ MC-059:授权已撤销 → 停在第 1 条", report.stoppedAt, "op1");
    eq("★ MC-059:撤销停住的稳定码是 grant_refused", report.stopCode, "grant_refused");
    eq("★ MC-059:撤销时一条会话都没建", SessionRepo.listByProject("p_utp_revoked").length, 0);
  }

  // ── 反面⑨:同一份计划重放(maxCount 已用尽)→ 第 1 条即 grant_refused(maxCount 真承重)。 ──
  fresh(); freshStore19d(); mkProject("p_utp_replay", UTP_DIR); headless();
  {
    const plan = mkPlan("p_utp_replay");
    const issued = issueUnattendedTaskPlan(plan, Date.now());
    const first = await executeUnattendedPlan(plan, issued, "me");
    eq("★ MC-059:首次执行建了 2 条(前提)", first.results.filter((r) => r.ok).length, 2);
    const midCount = SessionRepo.listByProject("p_utp_replay").length;
    const replay = await executeUnattendedPlan(plan, issued, "me");
    eq("★ MC-059:重放(maxCount 已用尽)→ 第 1 条即停", replay.stoppedAt, "op1");
    eq("★ MC-059:重放停住的稳定码是 grant_refused(maxCount 不是死字段)", replay.stopCode, "grant_refused");
    eq("★ MC-059:重放一条会话都没多建", SessionRepo.listByProject("p_utp_replay").length, midCount);
  }

  // ── 摘要:改计划内容 → 摘要变(「批准的是这一份计划吗」可核对)。 ──
  // 【MC-001 复核补漏】兑现这句「可核对」:授权钉的是**计划正文摘要**,执行端交来的
  // 正文摘要不同 → `evaluate` 判 `scenePlan` 被改 → 拒绝,不再拿同一枚授权跑别的正文。
  fresh(); freshStore19d(); mkProject("p_utp_bodybind", UTP_DIR); headless();
  {
    const plan = mkPlan("p_utp_bodybind");
    const issued = issueUnattendedTaskPlan(plan, Date.now());
    eq("★ MC-001:签发时把计划摘要钉进 scopedCore.scenePlan", issued.scopedCore.scenePlan, unattendedPlanDigest(plan));
    // 同一份正文 → 放行(正控)。
    const okRun = await executeUnattendedPlan(plan, issued, "me");
    eq("MC-001 正控:同一份计划正文 → 全部跑完", okRun.stoppedAt, null);

    // 换一份正文(标题不同 = 用户没批过的那份)→ 第一条即被拒。
    const tampered: UnattendedTaskPlan = {
      ...plan,
      operations: plan.operations.map((op) => ({ ...op, title: `${op.title ?? ""}(被换过)` })),
    };
    const beforeCount = SessionRepo.listByProject("p_utp_bodybind").length;
    const badRun = await executeUnattendedPlan(tampered, issued, "me");
    eq("★ MC-001:正文被换 → 第一条就停(不拿旧授权跑新正文)", badRun.stoppedAt, "op1");
    eq("★ MC-001:停下原因是 grant_refused(计划摘要不符)", badRun.stopCode, "grant_refused");
    eq("★ MC-001:被拒时一条会话都没多建", SessionRepo.listByProject("p_utp_bodybind").length, beforeCount);
  }


  {
    const a = mkPlan("p_utp_digest");
    const b = mkPlan("p_utp_digest", { maxCount: 3 });
    check("★ MC-059:计划内容不同 → 摘要不同", unattendedPlanDigest(a) !== unattendedPlanDigest(b), { a: unattendedPlanDigest(a), b: unattendedPlanDigest(b) });
    check("★ MC-059:同一份计划 → 摘要稳定", unattendedPlanDigest(a) === unattendedPlanDigest(mkPlan("p_utp_digest")), true);
  }

  // ── 源码级接线:生产端真调唯一业务命令 + 唯一签发口(不内联、不另造签发行)。 ──
  {
    const srcOf = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");
    const utpSrc = srcOf("src/main/appServices/unattendedTaskPlan.ts");
    check("★ MC-059:计划的执行端**真调**唯一业务命令 createSessionAndSend(不内联建会话)",
      /createSessionAndSend\s*\(/.test(utpSrc) && !/createOrReuseSession\s*\(/.test(utpSrc), utpSrc.match(/createOrReuseSession\s*\(/g));
    check("★ MC-059:计划的签发走**唯一**签发口 getGrantStore().issueGrant(不另造签发行)",
      /getGrantStore\(\)\s*\.\s*issueGrant\s*\(/.test(utpSrc));
    check("★ MC-059:签发口真的强制用户主体(subject.kind 判据在生产端)",
      /actor\.kind\s*!==\s*"user"/.test(utpSrc), utpSrc.match(/actor\.kind[^\n]*/g));
  }

  setGrantStore(null);
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
  rmSync(UTP_DIR, { recursive: true, force: true });
}


/* ──────────── 19e. 【MC-059】无人值守计划的三层 IPC 入口 —— 走**真 handler** ──────────── */

/**
 * ## 这条守的是什么(§19d 只证了服务函数,没证用户够得到)
 *
 * §19d 证的是 `issueUnattendedTaskPlan` / `executeUnattendedPlan` 这套**服务函数**,但它
 * **只在 appServices**,没有三层 IPC 入口 —— 用户够不到。本切片补上 `ipc/unattended.ts` 的
 * 两条通道(`unattended.approve` / `unattended.run`)。这一节走**真 handler**(不再复述其逻辑
 * —— 那套在有人改回老写法时照样全绿,因为套件从头到尾没碰过 handler 一行)。
 *
 * ## 承重判据(缺一即假死)
 *
 *   - **签发主体写死为 user**:approve 的 raw 里**塞一个 `actor:{kind:"agent"}`** → schema
 *     把它 strip 掉、服务函数把主体补成 user → 真签出的 grant 的 `approvalSource.kind` 是
 *     `user`(调用方给不了身份)。
 *   - **取不到授权即拒**:run 带一个不存在的 grantId → `refused` / `code=no_grant`,**一条会话
 *     都没建**(绝不静默放行)。
 *   - **授权被撤销即拒**:approve 签发后 revoke → run → `refused` / `no_grant`、一条没建。
 *   - **正面**:approve 签出的 grantId 交给 run → `ran`、逐条建出 2 条会话(与 §19d 同一条
 *     有界执行,只是入口换成了真 handler)。
 */
console.log("\n19e. 【MC-059】无人值守计划的三层 IPC 入口 —— 走真 handler(签发主体写死 user / 取不到即拒)");

{
  const freshStore19e = (): GrantStore => { const s = new GrantStore({ newId: (n) => `uh${n}` }); setGrantStore(s); return s; };
  const headless = (): void => { setRendererPortForTest(null); delete (globalThis as Record<string, unknown>).window; };

  const UTPE_DIR = mkdtempSync(join(tmpdir(), "mcode-utpe-proj-"));
  const mkProject = (id: string, dir: string): void => {
    ProjectRepo.create({
      id, name: `无人值守入口项目 ${id}`, path: dir, archived: false, group: null,
      sortOrder: 9, pinnedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    } as never);
  };
  /** 一份合法计划**声明**(与 §19d 同形,但不带 method —— method 由 handler 写死)。 */
  const approveRaw = (projectId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    planId: `plan-${projectId}`,
    projectId,
    operations: [
      { operationId: "op1", title: "入口第一步", prompt: "入口第一步" },
      { operationId: "op2", title: "入口第二步", prompt: "入口第二步" },
    ],
    ttlMs: 600_000,
    maxCount: 2,
    ...over,
  });

  check("★ MC-059:unattended.approve 通道真的注册进了 handler 表", handlers.has(IPC.UNATTENDED_APPROVE));
  check("★ MC-059:unattended.run 通道真的注册进了 handler 表", handlers.has(IPC.UNATTENDED_RUN));

  // ── 正面:approve 签发(主体写死 user)→ run 有界执行建出 2 条会话。 ──
  fresh(); freshStore19e(); mkProject("p_utpe_ok", UTPE_DIR); headless();
  {
    // ⚠️ raw 里**塞一个 actor:{kind:"agent"}** —— schema 会 strip 掉它、服务函数把主体补成
    //    user。若哪天有人把「调用方给的 actor」接上,这条会红。
    const granted = await call<{ ok: boolean; kind: string; grantId?: string; scopedProjectPath?: string }>(
      IPC.UNATTENDED_APPROVE,
      approveRaw("p_utpe_ok", { actor: { kind: "agent", id: "a-evil" } }),
    );
    check("★ MC-059:approve 合法计划 → granted", granted.ok === true && granted.kind === "granted", granted);
    eq("★ MC-059:approve 钉住的资源路径 = 目标项目权威路径", granted.scopedProjectPath, physicalPath(UTPE_DIR));
    // 签发主体必须是 user —— 调用方塞的 agent 身份被彻底忽略。
    eq("★ MC-059:签发主体写死为 user(调用方塞的 agent 身份被忽略)", getGrantStore().get(granted.grantId!, Date.now())?.approvalSource.kind, "user");

    const before = SessionRepo.listByProject("p_utpe_ok").length;
    const ran = await call<{ ok: boolean; kind: string; report?: { stoppedAt: string | null; results: Array<{ ok: boolean }> } }>(
      IPC.UNATTENDED_RUN,
      { ...approveRaw("p_utpe_ok"), grantId: granted.grantId },
    );
    check("★ MC-059:run 合法授权 → ran", ran.ok === true && ran.kind === "ran", ran);
    eq("★ MC-059:run 逐条跑完(stoppedAt 为 null)", ran.report?.stoppedAt, null);
    eq("★ MC-059:run 建出 2 条会话(计划里 2 条操作各自建行)", SessionRepo.listByProject("p_utpe_ok").length, before + 2);
  }

  // ── 反面①:run 带一个不存在的 grantId → 拒绝执行,一条都不建。 ──
  fresh(); freshStore19e(); mkProject("p_utpe_missing", UTPE_DIR); headless();
  {
    const refused = await call<{ ok: boolean; kind: string; code?: string }>(
      IPC.UNATTENDED_RUN,
      { ...approveRaw("p_utpe_missing"), grantId: "no-such-grant" },
    );
    check("★ MC-059:run 取不到授权 → refused", refused.ok === false && refused.kind === "refused", refused);
    eq("★ MC-059:run 取不到授权 → 稳定码 no_grant", refused.code, "no_grant");
    eq("★ MC-059:run 取不到授权 → 一条会话都没建(不静默放行)", SessionRepo.listByProject("p_utpe_missing").length, 0);
  }

  // ── 反面②:签出后撤销 → run 拒绝执行,一条都不建。 ──
  fresh(); freshStore19e(); mkProject("p_utpe_revoked", UTPE_DIR); headless();
  {
    const granted = await call<{ ok: boolean; grantId?: string }>(IPC.UNATTENDED_APPROVE, approveRaw("p_utpe_revoked"));
    getGrantStore().revoke(granted.grantId!);
    const refused = await call<{ ok: boolean; kind: string; code?: string }>(
      IPC.UNATTENDED_RUN,
      { ...approveRaw("p_utpe_revoked"), grantId: granted.grantId },
    );
    check("★ MC-059:run 授权已撤销 → refused", refused.ok === false && refused.kind === "refused", refused);
    eq("★ MC-059:run 授权已撤销 → 稳定码 no_grant", refused.code, "no_grant");
    eq("★ MC-059:run 授权已撤销 → 一条会话都没建", SessionRepo.listByProject("p_utpe_revoked").length, 0);
  }

  // ── 反面③:approve 的目标项目解析不出权威路径 → refused(unresolvable_scope),签发口如实报。 ──
  fresh(); freshStore19e(); headless();
  {
    const refused = await call<{ ok: boolean; kind: string; code?: string }>(
      IPC.UNATTENDED_APPROVE,
      approveRaw("p_utpe_nosuch"),
    );
    check("★ MC-059:approve 未知项目 → refused", refused.ok === false && refused.kind === "refused", refused);
    eq("★ MC-059:approve 未知项目 → 稳定码 unresolvable_scope", refused.code, "unresolvable_scope");
  }

  // ── 源码级接线:handler 真调服务函数 + 写死 session.create 方法。 ──
  {
    const srcOf = (p: string): string => readFileSync(join(process.cwd(), p), "utf8");
    const ipcSrc = srcOf("src/main/ipc/unattended.ts");
    check("★ MC-059:handler 真调签发服务 approveUnattendedPlan(不内联签发逻辑)",
      /approveUnattendedPlan\s*\(/.test(ipcSrc), ipcSrc.match(/approveUnattendedPlan[^\n]*/g));
    check("★ MC-059:handler 的执行入口只交给 runUnattendedPlanWithGrant(不内联执行)",
      /runUnattendedPlanWithGrant\s*\(/.test(ipcSrc), ipcSrc.match(/runUnattendedPlanWithGrant[^\n]*/g));
    check("★ MC-059:handler 把操作的方法写死为 SESSION_CREATE_METHOD(调用方给不了别的动作)",
      /method:\s*SESSION_CREATE_METHOD/.test(ipcSrc), ipcSrc.match(/SESSION_CREATE_METHOD[^\n]*/g));
    // 服务函数硬编码 user 主体(调用方给不了)。
    const svcSrc = srcOf("src/main/appServices/unattendedTaskPlan.ts");
    check("★ MC-059:签发服务把主体写死为 user(kind:\"user\")",
      /kind:\s*"user",\s*id:\s*"unattended\.approval"/.test(svcSrc), svcSrc.match(/unattended\.approval[^\n]*/g));
    check("★ MC-059:执行服务从 GrantStore.get 取回授权(收不到自填的授权内容)",
      /getGrantStore\(\)\s*\.\s*get\s*\(/.test(svcSrc), svcSrc.match(/getGrantStore\(\)[^\n]*/g));
  }

  setGrantStore(null);
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
  rmSync(UTPE_DIR, { recursive: true, force: true });
}


/* ── 19f. 【MC-059 残余 ②④】发起者身份可追溯 + 跨重启 WAITING_APPROVAL 闭环 ── */

/**
 * ## 这条守的是什么(§19d/§19e 只证了"能签能跑",没证这两位)
 *
 * 台账 MC-059 的两条 remaining:
 *
 *  **② 发起者身份** —— §19e 的 handler 把 `run` 的 `actorId` **写死**成 `"unattended.ipc"`,
 *  一个每次运行都一样的常量,追不到「用户本人在哪条会话里点的执行」。本切片改成由**宿主**
 *  从一枚**可信坐标**产出:渲染端给的 `initiatorSessionId` 只是一枚**坐标**(宿主拿它去
 *  `SessionRepo.get` 核实那条会话真的存在,存在才认,产出 `session:<id>`);核不到 = 伪造的
 *  坐标 → **拒绝执行**(`unknown_initiator`),**绝不**当成一个能用的身份字符串放行。缺省时
 *  退回按 IPC 事件的 `sender` 派生 `desktop:wc:<id>` —— 同样是宿主事实。**调用方给不了身份。**
 *
 *  **④ 跨重启 WAITING_APPROVAL** —— §19e 的批准与执行在同一个进程生命周期里;进程一关,
 *  授权的 sceneId 还在盘上,但「它对应哪份计划」无从读回。本切片把**计划正文**落盘(独立文件
 *  `<数据根>/appControl/unattended-plans.json`,与授权同源),于是重启后能**读回**、能**列出**
 *  「等待批准 / 待执行」、能**续跑**(跳过已建成,只跑剩下的)或**明确放弃**。过期 / 已撤销的
 *  绝不复活(列表判 `waiting_approval`、续跑取不到授权即拒)。
 *
 * ## 承重判据(缺一即假绿)
 *
 *  - 发起者:伪造坐标 → `unknown_initiator` + 一步不建;真实坐标 → 执行报告的 actorId 是
 *    `session:<id>`(不再是常量);源码级:handler 里不再出现 `"unattended.ipc"`。
 *  - 跨重启:**从同一数据根重新装配 store**(进程内状态全丢)→ 列表读得出那条计划、判 `resumable`、
 *    剩 `[op3]`;**续跑只对剩下的 op3 调一次业务命令**(计数是判据 —— 已建成的两步**没重跑**);
 *    撤销后列表判 `waiting_approval`、续跑拒 `no_grant`;`abandon` 后不再列出、续跑拒 `abandoned`;
 *    坏 JSON → 空列表(fail-safe)。
 */
console.log("\n19f. 【MC-059 残余】发起者可追溯(②)+ 计划跨重启待执行 / 续跑 / 放弃(④)");

{
  const UTPF_DIR = mkdtempSync(join(tmpdir(), "mcode-utpf-proj-"));
  const mkProject = (id: string, dir: string): void => {
    ProjectRepo.create({
      id, name: `无人值守跨重启项目 ${id}`, path: dir, archived: false, group: null,
      sortOrder: 9, pinnedAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    } as never);
  };
  const headless = (): void => { setRendererPortForTest(null); delete (globalThis as Record<string, unknown>).window; };
  /** 一条合法计划声明(与 §19e 同形,但不带 method —— method 由 handler 写死)。 */
  const planBody = (projectId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    planId: `plan-${projectId}`,
    projectId,
    operations: [
      { operationId: "op1", title: "跨重启第一步", prompt: "第一步" },
      { operationId: "op2", title: "跨重启第二步", prompt: "第二步" },
    ],
    ttlMs: 600_000,
    maxCount: 2,
    ...over,
  });
  // 计划存档真的写到 <数据根>/appControl/unattended-plans.json(与授权同源、独立文件)。
  const planStorePath = unattendedPlanStorePath(DATA);

  // ── ② 发起者身份:从可信坐标产出(单元级:解析口本身) ──
  check("★ ④:unattendedPlans.list 通道真的注册进了 handler 表", handlers.has(IPC.UNATTENDED_PLANS_LIST));
  check("★ ④:unattendedPlans.resume 通道真的注册进了 handler 表", handlers.has(IPC.UNATTENDED_PLANS_RESUME));
  check("★ ④:unattendedPlans.abandon 通道真的注册进了 handler 表", handlers.has(IPC.UNATTENDED_PLANS_ABANDON));
  mkProject("p_utpf_id", UTPF_DIR);
  headless();
  const realSid = mkSession("sess_initiator_real");
  eq("★ ②:给了真实会话坐标 → 产出 session:<id>",
    resolveUnattendedInitiator(null, "sess_initiator_real"), `session:${realSid}`);
  eq("★ ②:给了不存在的会话坐标 → null(拒绝,不采信)",
    resolveUnattendedInitiator(null, "ghost-no-such-session"), null);
  eq("★ ②:没给坐标 → 按 IPC 事件 sender 派生",
    resolveUnattendedInitiator({ sender: { id: 7 } } as never, undefined), "desktop:wc:7");
  eq("★ ②:没坐标也没 sender → 稳定兜底 desktop",
    resolveUnattendedInitiator(null, undefined), "desktop");

  // ── ② handler 走真路:伪造的发起会话 → 拒绝执行,一步不建。 ──
  fresh(); setGrantStore(null); setUnattendedPlanStore(null);
  assembleGrantStore(DATA); assembleUnattendedPlanStore(DATA); headless();
  {
    const granted = await call<{ ok: boolean; grantId?: string }>(IPC.UNATTENDED_APPROVE, planBody("p_utpf_id"));
    const before = SessionRepo.listByProject("p_utpf_id").length;
    const refused = await call<{ ok: boolean; kind: string; code?: string }>(
      IPC.UNATTENDED_RUN,
      { ...planBody("p_utpf_id"), grantId: granted.grantId, initiatorSessionId: "ghost-no-such-session" },
    );
    check("★ ②:run 用伪造的发起会话 → refused", refused.ok === false && refused.kind === "refused", refused);
    eq("★ ②:拒绝码 unknown_initiator", refused.code, "unknown_initiator");
    eq("★ ②:伪造发起者时一条会话都没建(不静默放行)", SessionRepo.listByProject("p_utpf_id").length, before);
  }

  // ── ② handler 走真路:真实的发起会话 → ran,执行报告的发起者 = session:<id>。 ──
  {
    const granted = await call<{ ok: boolean; grantId?: string }>(IPC.UNATTENDED_APPROVE, planBody("p_utpf_id"));
    const ran = await call<{ ok: boolean; kind: string }>(
      IPC.UNATTENDED_RUN,
      { ...planBody("p_utpf_id"), grantId: granted.grantId, initiatorSessionId: realSid },
    );
    check("★ ②:run 用真实发起会话 → ran", ran.ok === true && ran.kind === "ran", ran);
    eq("★ ②:执行报告里的发起者 = session:<id>(不再是写死的 unattended.ipc)",
      __lastActionContext()?.actorId, `session:${realSid}`);
  }

  // ── ② 源码级:handler 不再写死 actorId 常量,而走宿主核实的解析口。 ──
  {
    const ipcRaw = readFileSync(join(process.cwd(), "src/main/ipc/unattended.ts"), "utf8");
    // 剥掉注释再判 —— 注释里**正当**地记着"从前是 `"unattended.ipc"` 常量"这段历史,
    // 判据要落在**活代码**上(与 policy-engine-smoke 的 `code` 剥注释同款)。
    const ipcSrc = ipcRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check("★ ②:handler 活代码里不再把 actorId 写死为 unattended.ipc", !/unattended\.ipc/.test(ipcSrc),
      ipcSrc.match(/unattended\.ipc[^\n]*/g));
    check("★ ②:handler 走宿主核实的发起者解析口 resolveUnattendedInitiator",
      /resolveUnattendedInitiator\s*\(/.test(ipcSrc), ipcSrc.match(/resolveUnattendedInitiator[^\n]*/g));
  }

  // ── ④ 跨重启:签发 → 落盘 → "重启"读回 → 待执行列表 → 续跑(跳过已建成)。 ──
  mkProject("p_utpf_restart", UTPF_DIR);
  headless();
  {
    fresh(); setGrantStore(null); setUnattendedPlanStore(null);
    assembleGrantStore(DATA); assembleUnattendedPlanStore(DATA); headless();
    // 3 步计划:第三步带对不上的修订号 → 头两步建成、第三步停住(制造"执行到一半")。
    const body = planBody("p_utpf_restart", {
      planId: "plan_restart", maxCount: 3,
      operations: [
        { operationId: "op1", title: "重启第一步", prompt: "a" },
        { operationId: "op2", title: "重启第二步", prompt: "b" },
        { operationId: "op3", title: "重启第三步", prompt: "c", expectedRevision: "999" },
      ],
    });
    const granted = await call<{ ok: boolean; kind: string; grantId?: string }>(IPC.UNATTENDED_APPROVE, body);
    check("★ ④:approve → granted", granted.ok === true && granted.kind === "granted", granted);

    // 计划正文真落盘(与授权同源、独立文件;不是塞进 grants.json,也不会被授权 flush 冲掉)。
    check("★ ④:计划正文落到 <数据根>/appControl/unattended-plans.json", existsSync(planStorePath), planStorePath);
    const parsedOnDisk = parseUnattendedPlans(readFileSync(planStorePath, "utf8"));
    eq("★ ④:落盘记录里这条计划是 pending", parsedOnDisk.find((p) => p.planId === "plan_restart")?.status, "pending");
    eq("★ ④:授权文件与计划文件是两份(不混在同一份里)",
      planStorePath !== join(DATA, "appControl", "grants.json"), true);

    // 首次执行:两步成、第三步停在 revision_conflict —— 制造"执行到一半"。
    const firstRun = await call<{ ok: boolean; kind: string; report?: { stoppedAt: string | null; stopCode: string | null } }>(
      IPC.UNATTENDED_RUN, { ...body, grantId: granted.grantId, initiatorSessionId: realSid },
    );
    check("★ ④:首次执行 → ran", firstRun.ok === true && firstRun.kind === "ran", firstRun.kind);
    eq("★ ④:首次执行停在 op3", firstRun.report?.stoppedAt, "op3");
    eq("★ ④:停住码 revision_conflict", firstRun.report?.stopCode, "revision_conflict");
    const builtAfterFirst = SessionRepo.listByProject("p_utpf_restart").length;
    eq("★ ④:首次执行建出 2 条会话(前两步)", builtAfterFirst, 2);

    // ── "重启":从**同一数据根**重新装配两个 store —— 进程内状态全丢,只从盘上读回。 ──
    setGrantStore(null);
    setUnattendedPlanStore(null);
    assembleUnattendedPlanStore(DATA); // 读回 unattended-plans.json
    assembleGrantStore(DATA);          // 读回 grants.json

    // 重启后列得出「待执行」:这条计划 resumable、已完成 2、剩 op3。
    const listed = listUnattendedPlans();
    const view = listed.find((p) => p.planId === "plan_restart");
    check("★ ④:重启后列得出这条计划", view !== undefined, listed.map((p) => p.planId));
    eq("★ ④:重启后它是 resumable(授权仍有效 + 有剩下的步)", view?.kind, "resumable");
    eq("★ ④:重启后已完成数 = 2", view?.completedCount, 2);
    same("★ ④:重启后剩余 = [op3]", view?.remainingOperationIds, ["op3"]);

    // 续跑:跳过已建成的 op1/op2(不重跑),只重试剩下的 op3。
    __resetCreateSessionAndSendCount();
    const resumed = await resumeUnattendedPlanWithGrant("plan_restart", `session:${realSid}`);
    check("★ ④:续跑 → ran", resumed.ok === true && resumed.kind === "ran", resumed.kind);
    // ★★ 承重:续跑只对**剩下的 op3** 调一次业务命令 —— op1/op2 被跳过、没重跑。判据是**调用计数**
    //     (状态本来就在盘上,证明不了它没重跑;§18 的 scene resume 同款教训)。
    eq("★★ ④:续跑只重试了剩下的 op3(业务命令只被调一次 op3)", __createSessionAndSendCount(), 1);
    eq("★ ④:续跑没重跑已建成的两步(会话数不变)", SessionRepo.listByProject("p_utpf_restart").length, builtAfterFirst);

    // 撤销授权 → 列表判 waiting_approval(绝不复活);续跑拒 no_grant,一步不建。
    getGrantStore().revoke(granted.grantId!);
    eq("★ ④:授权被撤销 → 列表判 waiting_approval(需重新批准)",
      listUnattendedPlans().find((p) => p.planId === "plan_restart")?.kind, "waiting_approval");
    const nBefore = SessionRepo.listByProject("p_utpf_restart").length;
    const refusedResume = await resumeUnattendedPlanWithGrant("plan_restart", "me");
    check("★ ④:撤销后续跑 → refused", refusedResume.ok === false && refusedResume.kind === "refused", refusedResume);
    if (refusedResume.ok === false && refusedResume.kind === "refused") eq("★ ④:拒绝码 no_grant", refusedResume.code, "no_grant");
    eq("★ ④:撤销后一条会话都没建", SessionRepo.listByProject("p_utpf_restart").length, nBefore);
  }

  // ── ④ 放弃 + 过期:abandon 后不再列出 / 续跑拒 abandoned;过期授权判 waiting_approval。 ──
  mkProject("p_utpf_abandon", UTPF_DIR);
  headless();
  {
    fresh(); setGrantStore(null); setUnattendedPlanStore(null);
    assembleGrantStore(DATA); assembleUnattendedPlanStore(DATA); headless();
    await call(IPC.UNATTENDED_APPROVE, planBody("p_utpf_abandon"));
    eq("★ ④:放弃前这条计划在列表里(前提)", listUnattendedPlans().some((p) => p.planId === "plan-p_utpf_abandon"), true);
    eq("★ ④:abandon 返回 abandoned=true(真的标记了)", abandonUnattendedPlan("plan-p_utpf_abandon"), true);
    eq("★ ④:放弃后不再列出(用户已明确放弃,不再提示)", listUnattendedPlans().some((p) => p.planId === "plan-p_utpf_abandon"), false);
    const r = await resumeUnattendedPlanWithGrant("plan-p_utpf_abandon", "me");
    check("★ ④:放弃后续跑 → refused", r.ok === false && r.kind === "refused", r);
    if (r.ok === false && r.kind === "refused") eq("★ ④:拒绝码 abandoned", r.code, "abandoned");
    eq("★ ④:abandon 幂等(再放弃一个已放弃的 = false)", abandonUnattendedPlan("plan-p_utpf_abandon"), false);

    // 过期授权:签一个短有效期计划,在**未来**时刻列 / 续跑 → waiting_approval / no_grant。
    await call(IPC.UNATTENDED_APPROVE, planBody("p_utpf_abandon", { planId: "plan_expiring", ttlMs: 1_000 }));
    const future = Date.now() + 10_000_000;
    eq("★ ④:授权过期 → 列表判 waiting_approval(过期绝不复活)",
      listUnattendedPlans(future).find((p) => p.planId === "plan_expiring")?.kind, "waiting_approval");
    const expiredResume = await resumeUnattendedPlanWithGrant("plan_expiring", "me", future);
    check("★ ④:过期后续跑 → refused", expiredResume.ok === false && expiredResume.kind === "refused", expiredResume);
    if (expiredResume.ok === false && expiredResume.kind === "refused") eq("★ ④:过期拒绝码 no_grant", expiredResume.code, "no_grant");

    // 读不到记录 / 坏 JSON 的 fail-safe。
    const noRec = await resumeUnattendedPlanWithGrant("no-such-plan", "me");
    check("★ ④:续跑一条不存在的计划 → refused", noRec.ok === false && noRec.kind === "refused", noRec);
    if (noRec.ok === false && noRec.kind === "refused") eq("★ ④:拒绝码 no_record", noRec.code, "no_record");
    same("★ ④:坏 JSON → 空列表(fail-safe,不崩、不当成有效计划)", parseUnattendedPlans("{ 这不是 json"), []);
    same("★ ④:null(文件不存在)→ 空列表", parseUnattendedPlans(null), []);
  }

  // ── ★ MC-017:计划记录核的落盘失败 → 内存与磁盘不分裂(与 GrantStore / HostHookGrants
  //    同根因、同修法:先 save 候选全量,成功后才发布内存)。从前 `put` 先 `Map.set` 后
  //    `flush`、`remove` 先 `Map.delete` 后 `flush` —— save 抛错就留下「内存删了、磁盘还有」
  //    (台账 E1 红例:`AFTER_FAILED_REMOVE_MEMORY false DISK 1`),重启后记录又回来。
  {
    const { UnattendedPlanStore } = await import("@main/appServices/unattendedPlanStore.js");
    const aRecord = () => ({
      planId: "plan_mc017",
      kind: "waiting_approval" as const,
      ops: [],
      operations: [],
      completedOperationIds: [],
    }) as never;
    // ① 落盘正常:put 真的进表、remove 真的删掉(正控 —— 证明下面"不动"不是"没实现")。
    const box: { plans: unknown[] | null } = { plans: null };
    let failSave = false;
    const store = new UnattendedPlanStore({
      persist: { load: () => box.plans as never, save: (ps) => { if (failSave) throw new Error("disk error (injected)"); box.plans = ps as never; } },
    });
    store.put(aRecord());
    eq("MC-017(计划核)正控:落盘正常时 put 进表", store.listAll().length, 1);
    eq("MC-017(计划核)正控:落盘正常时 remove 真删", store.remove("plan_mc017"), true);
    // ② put 时落盘失败 → 抛错,内存里**没有**这条(不分裂)。
    failSave = true;
    let putThrew = false;
    try { store.put(aRecord()); } catch { putThrew = true; }
    eq("★ MC-017(计划核):put 落盘失败 → 抛错", putThrew, true);
    eq("★ MC-017(计划核):put 落盘失败 → 内存里没有这条(不分裂)", store.listAll().length, 0);
    // ③ remove 时落盘失败 → 抛错,内存里**仍在**(与磁盘一致,重启不会"删了的又回来")。
    failSave = false;
    store.put(aRecord());
    failSave = true;
    let removeThrew = false;
    try { store.remove("plan_mc017"); } catch { removeThrew = true; }
    eq("★ MC-017(计划核):remove 落盘失败 → 抛错", removeThrew, true);
    eq("★ MC-017(计划核):remove 落盘失败 → 内存里仍在(与磁盘一致)", store.listAll().length, 1);
  }

  // ── ★ MC-029:坏存档读成空表后,**拒绝写入** —— 下一次 put 不得覆盖原字节。
  //    台账 E1 红例:截断的 unattended-plans.json(含 p1)→ load 得空 → put(p2) 整表回写 →
  //    `OLD_BYTES_RETAINED false`,p1 永久丢失。修法:健康度 `corrupt` 时 commit 抛错。
  {
    const { UnattendedPlanStore, fileUnattendedPlanPersist, classifyUnattendedPlanArchive } =
      await import("@main/appServices/unattendedPlanStore.js");
    const aRec = (id: string) => ({
      planId: id, sceneId: "s", projectId: "p", grantId: "g",
      operations: [{ actionId: "a1", method: "m", payload: {} }],
      maxCount: 1, createdAt: 1, status: "pending" as const,
      completedOperationIds: [], lastStoppedAt: null, lastStopCode: null,
    }) as never;
    // 健康度分类：真·空 vs 损坏要分得开。
    eq("★ MC-029:null(文件不存在)→ absent", classifyUnattendedPlanArchive(null), "absent");
    eq("★ MC-029:非 JSON(截断)→ corrupt", classifyUnattendedPlanArchive("{ truncated"), "corrupt");
    eq("★ MC-029:版本不符 → corrupt", classifyUnattendedPlanArchive(JSON.stringify({ version: 999, plans: [] })), "corrupt");
    eq("★ MC-029:plans 不是数组 → corrupt", classifyUnattendedPlanArchive(JSON.stringify({ version: 1, plans: "x" })), "corrupt");

    // 端到端复现 E1:盘上有一份**被截断的** p1 存档 → store 载入 → put(p2) 必须**拒绝**。
    const blob = (() => { let t: string | null = "{ \"version\": 1, \"plans\": [ {\"pl"; return { read: () => t, write: (s: string) => { t = s; } }; })();
    const originalBytes = blob.read();
    const store = new UnattendedPlanStore({ persist: fileUnattendedPlanPersist(blob as never) });
    check("★ MC-029:坏存档被识别为 corrupt", store.isArchiveCorrupt() === true, store.isArchiveCorrupt());
    let writeThrew = false;
    try { store.put(aRec("p2")); } catch { writeThrew = true; }
    eq("★ MC-029:坏存档存在时 put → 拒绝(抛错,不静默)", writeThrew, true);
    eq("★ MC-029:原字节一字未动(没被 p2 覆盖)", blob.read(), originalBytes);
  }

  // ── ★ MC-029(读侧):坏存档时 list / resume / run / abandon / approve **显式区分**,
  //    不谎报「没有计划」;修复(用户把 JSON 修好)后一切照常。写侧闸(上一块)只保住了原字节 ——
  //    但消费端若把「读不懂」继续当成空表,用户看到的仍是「没有等待中的计划 / 这份计划不存在」,
  //    与「真的没有计划」无法区分。这里在**真装配**(盘上有真文件)下端到端验这条判据。
  {
    /** 读侧拒绝文案的稳定子串(断言不锁全文)。 */
    const READ_MARK = "unattended-plans.json 读不懂";
    /** 写侧闸(store.commit 的既有错误)文案的稳定子串。 */
    const WRITE_MARK = "unattended-plans.json 内容读不懂";

    // ── 正控(③):absent(文件不存在 / 空串)→ 正常 put;空串不误报损坏(用户亲手清空 ≠ 损坏)。
    {
      const { UnattendedPlanStore, fileUnattendedPlanPersist } = await import("@main/appServices/unattendedPlanStore.js");
      eq("★ MC-029(读侧)正控:null(文件不存在)→ absent", classifyUnattendedPlanArchive(null), "absent");
      eq("★ MC-029(读侧)正控:空串(零字节文件)→ absent,不误报损坏", classifyUnattendedPlanArchive(""), "absent");
      let t: string | null = null;
      const mem = { read: () => t, write: (s: string) => { t = s; } };
      const s = new UnattendedPlanStore({ persist: fileUnattendedPlanPersist(mem as never) });
      let putThrew = false;
      try {
        s.put({
          planId: "plan_absent_ok", sceneId: "s", projectId: "p", grantId: "g",
          operations: [{ operationId: "op1", method: "session.create", prompt: "x" }],
          maxCount: 1, createdAt: 1, status: "pending", completedOperationIds: [], lastStoppedAt: null, lastStopCode: null,
        });
      } catch { putThrew = true; }
      eq("★ MC-029(读侧)正控:absent 时 put 正常成功(不误拦)", putThrew, false);
      check("★ MC-029(读侧)正控:absent 时 put 确实落盘", mem.read() !== null);
    }

    mkProject("p_utpf_corrupt", UTPF_DIR);
    headless();
    fresh(); setGrantStore(null); setUnattendedPlanStore(null);
    assembleGrantStore(DATA); assembleUnattendedPlanStore(DATA); headless();

    // 正控(④):先弄一份**有效**存档(含一条 pending 计划)+ 一枚真授权 —— 证明驱动器本身工作。
    const granted = await call<{ ok: boolean; grantId?: string }>(
      IPC.UNATTENDED_APPROVE, planBody("p_utpf_corrupt", { planId: "plan_corrupt_keep", maxCount: 2 }),
    );
    check("★ MC-029(读侧)正控:先经 approve 落一份有效计划(granted)", granted.ok === true, granted);
    const validBytes = readFileSync(planStorePath, "utf8");
    eq("★ MC-029(读侧)正控:有效存档判 valid", classifyUnattendedPlanArchive(validBytes), "valid");
    eq("★ MC-029(读侧)正控:有效存档下列表里有这条计划",
      listUnattendedPlans().some((p) => p.planId === "plan_corrupt_keep"), true);

    // 把盘上文件换成**截断的**坏 JSON(模拟写入中断),重装配 —— 这就是「重启后读到坏存档」。
    writeFileSync(planStorePath, "{ \"version\": 1, \"plans\": [ {\"plan", "utf8");
    const corruptBytes = readFileSync(planStorePath, "utf8");
    setGrantStore(null); setUnattendedPlanStore(null);
    assembleGrantStore(DATA); assembleUnattendedPlanStore(DATA); headless();
    check("★ MC-029(读侧):坏存档重装配后持有核知道 corrupt",
      getUnattendedPlanStore().isArchiveCorrupt() === true);

    // ① list:坏存档必须**显式区分** —— 不是「没有等待中的计划」那句谎。
    //    契约层 list 没有 refusal 形状(只回 {plans}),所以显式 = **拒绝**:handler 抛错 →
    //    渲染端 useRpc 的 listError 落进 ErrorNote(现有路径;不新增契约字段、不动渲染端)。
    const listRes = await call<{ plans: unknown[] }>(IPC.UNATTENDED_PLANS_LIST).catch(() => null);
    check("★ MC-029(读侧)①:corrupt 时 list **拒绝**(不是 {plans:[]} 的空表谎)", listRes === null, listRes);
    const listErr = await catching(IPC.UNATTENDED_PLANS_LIST);
    check("★ MC-029(读侧)①:list 的拒绝话说清「存档读不懂」(与真·没有计划可区分)",
      listErr.includes(READ_MARK), listErr);

    // ③ resume:坏存档 → 明确拒绝且说清「存档读不懂」,不是谎报 no_record(「这份计划不存在」)。
    const resResume = await call<{ ok: boolean; kind: string; code?: string; reason?: string }>(
      IPC.UNATTENDED_PLANS_RESUME, { planId: "plan_corrupt_keep" },
    );
    check("★ MC-029(读侧)③:corrupt 时 resume → refused", resResume.ok === false && resResume.kind === "refused", resResume);
    eq("★ MC-029(读侧)③:拒绝码 archive_corrupt(不是 no_record 那句谎)", resResume.code, "archive_corrupt");
    check("★ MC-029(读侧)③:拒绝话说清是存档读不懂(与 no_record 可区分)",
      typeof resResume.reason === "string" && resResume.reason.includes(READ_MARK), resResume.reason);

    // ③' run:坏存档 → 同样**拒绝**,而且发生在**建任何会话之前** —— 否则会话建了、进度回写不了,
    //    重启后重试 = 重复的外部副作用。
    const beforeSessions = SessionRepo.listByProject("p_utpf_corrupt").length;
    const resRun = await call<{ ok: boolean; kind: string; code?: string }>(
      IPC.UNATTENDED_RUN,
      { ...planBody("p_utpf_corrupt", { planId: "plan_corrupt_keep" }), grantId: granted.grantId, initiatorSessionId: realSid },
    ).catch(() => null);
    check("★ MC-029(读侧)③:corrupt 时 run → refused(不执行再崩在回写)", resRun !== null && resRun.ok === false && resRun.kind === "refused", resRun);
    eq("★ MC-029(读侧)③:run 拒绝码 archive_corrupt", resRun?.code, "archive_corrupt");
    eq("★ MC-029(读侧)③:run 被拒时一条会话都没建", SessionRepo.listByProject("p_utpf_corrupt").length, beforeSessions);

    // ③'' approve:坏存档 → **先拒**,不给「授权铸了、正文记不进」的孤儿授权(台账触发链的
    //     「重启后又创建另一个 p2」正是这一步)。
    const resApprove2 = await call<{ ok: boolean; kind: string; code?: string }>(
      IPC.UNATTENDED_APPROVE, planBody("p_utpf_corrupt", { planId: "plan_corrupt_p2" }),
    );
    check("★ MC-029(读侧)③:corrupt 时 approve 新计划 → refused", resApprove2.ok === false && resApprove2.kind === "refused", resApprove2);
    eq("★ MC-029(读侧)③:approve 拒绝码 archive_corrupt(不是含糊的 unexpected)", resApprove2.code, "archive_corrupt");
    const grantsOnDisk = readFileSync(join(DATA, "appControl", "grants.json"), "utf8");
    check("★ MC-029(读侧)③:approve 被拒时没有铸出孤儿授权(正文记不进的授权不签发)",
      !grantsOnDisk.includes("plan_corrupt_p2"), grantsOnDisk.includes("plan_corrupt_p2"));

    // ②abandon/put 级兜底:坏存档 → 不谎报 abandoned=false;绕过服务层直接 put 也被写侧闸拒。
    const abandonErr = await catching(IPC.UNATTENDED_PLANS_ABANDON, { planId: "plan_corrupt_keep" });
    check("★ MC-029(读侧)②:corrupt 时 abandon 拒绝并说清(不谎报 abandoned=false)",
      abandonErr.includes(READ_MARK), abandonErr);
    let putRefused = false;
    try {
      getUnattendedPlanStore().put({
        planId: "plan_bypass_attempt", sceneId: "s", projectId: "p_utpf_corrupt", grantId: granted.grantId ?? "g",
        operations: [{ operationId: "op1", method: "session.create", prompt: "x" }],
        maxCount: 1, createdAt: 1, status: "pending", completedOperationIds: [], lastStoppedAt: null, lastStopCode: null,
      });
    } catch (err) {
      putRefused = (err as Error).message.includes(WRITE_MARK);
    }
    eq("★ MC-029(读侧)③:绕过服务层直接 put 也被写侧闸拒绝(还说清原因)", putRefused, true);

    // ④ 原字节仍未被动过(以上所有被拒操作都没写盘)。
    eq("★ MC-029(读侧)④:一串被拒操作之后坏字节仍一字未动", readFileSync(planStorePath, "utf8"), corruptBytes);

    // ⑤ 恢复:用户把 JSON 修好(用先前的有效字节),重装配后一切照常 ——
    //    list 恢复、resume 不再报 archive_corrupt(授权是否仍有效是另一条独立判定)。
    writeFileSync(planStorePath, validBytes, "utf8");
    setGrantStore(null); setUnattendedPlanStore(null);
    assembleGrantStore(DATA); assembleUnattendedPlanStore(DATA); headless();
    check("★ MC-029(读侧)⑤:修好 JSON 重装配后持有核不再报 corrupt",
      getUnattendedPlanStore().isArchiveCorrupt() === false);
    const listRes2 = await call<{ plans: Array<{ planId: string }> }>(IPC.UNATTENDED_PLANS_LIST).catch(() => null);
    check("★ MC-029(读侧)⑤:修好后 list 恢复(不再拒绝)", listRes2 !== null, listRes2);
    eq("★ MC-029(读侧)⑤:修好后那条计划又列得出来",
      listRes2?.plans.some((p) => p.planId === "plan_corrupt_keep"), true);
    const resResume2 = await call<{ ok: boolean; code?: string }>(
      IPC.UNATTENDED_PLANS_RESUME, { planId: "plan_corrupt_keep" },
    ).catch(() => null);
    check("★ MC-029(读侧)⑤:修好后 resume 不再报 archive_corrupt(授权另行判定)",
      resResume2 !== null && resResume2.code !== "archive_corrupt", resResume2);
  }

  // 复位,免得把落了盘的示例计划带进后续用例。
  setUnattendedPlanStore(null);
  setGrantStore(null);
  setRendererPortForTest(null);
  delete (globalThis as Record<string, unknown>).window;
  rmSync(UTPF_DIR, { recursive: true, force: true });
}


/* ──────────────── 收尾 ──────────────── */

rmSync(PROJECT_DIR, { recursive: true, force: true });
rmSync(DATA, { recursive: true, force: true });

console.log(`\nclaude-ipc-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
