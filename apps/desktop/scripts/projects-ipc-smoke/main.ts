/**
 * Headless smoke for **`main/ipc/projects.ts`** —— 项目与会话的增删改查、以及两条分页路径。
 *
 * ## 为什么挑这个文件
 *
 * 它管着左栏那棵树:建项目、删项目、改名、分组、拖拽排序、钉住,以及每条会话的
 * 改名/归档/钉住/书签。用户**每天**都在这些操作上,而且错了**不会有任何报错** ——
 * 删掉的东西不会回来,列表少一条也不会有人弹窗。
 *
 * 这一套押在两处:
 *
 *   - **删**:删项目是级联删它下面**每一条**会话。`SESSION_DELETE` 上写着两句"不能省"
 *     的收尾(停掉还在跑的图、清掉待并回的内容),而级联删是静默的、不会逐条走那个
 *     handler。所以删项目这条路上必须自己补,漏了**一个字都不会提示**。
 *   - **分页**:`hasMore` / `total` 一旦和 `list` 的过滤口径对不上,底部那个「显示更多」
 *     会永远显示、或者提前消失,而列表本身看起来完全正常 —— 源码注释里特意写了
 *     "the count MUST mirror the list's filter"。
 *
 * ## 走真的 handler
 *
 * `ipcMain` 的记名替身(`fakeIpc`):调真的 `registerProjectHandlers`,把它注册进去的
 * 函数按 channel 收下来,然后调**用户动作本身**。不起 Electron,也没有 preload。
 *
 * ⚠️ 把 handler 里的逻辑复述一遍是没用的 —— 那一套在有人改回老写法时照样全绿。
 *
 * ## 数据
 *
 * 真 sqlite 库,数据根是 `mktemp -d`(run.sh 里设的 `MCODE_SMOKE_DATA_ROOT`)。跑完删。
 *
 * Run: scripts/projects-ipc-smoke/run.sh
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";

import { IPC } from "@contracts/ipc";
import type { Session } from "@contracts/session";
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, MessageRepo } from "@main/store/repositories.js";
import { registerProjectHandlers } from "@main/ipc/projects.js";

import { eventsOfType, resetSent, sentChannels } from "./stubs/window.js";
import { mobileEvents, resetMobileEvents } from "./stubs/mobileEventBus.js";
import { cancelAsked, markRunActive, resetRunnerStub, stoppedRuns } from "./stubs/runner.js";
import { dropped, queueBackflow, resetBackflowStub } from "./stubs/pendingBackflow.js";
import { callTrace, resetCallTrace } from "./stubs/callTrace.js";
import {
  disposedIds,
  disposedProjectIds,
  resetRuntimeStub,
} from "./stubs/runtimeManager.js";

const DATA = mkdtempSync(join(tmpdir(), "projects-ipc-smoke-"));

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/**
 * 比数组 —— **必须**用这个,不能用 `eq`。
 *
 * ⚠️ 踩过:`eq` 的判据是 `Object.is`,拿它比两个内容相同的数组**永远是红的**
 * (数组是引用比)。第一次跑有 6 条形如
 * `FAIL 归档栏里只有归档的那条 — {"actual":["s_arch"],"expected":["s_arch"]}`
 * —— 实际值和期望值**一模一样**却判失败,那种红最费时间(会先怀疑源码)。
 */
function eqArr(name: string, actual: readonly unknown[], expected: readonly unknown[]): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* ──────────────── 0. 脚手架自己 ──────────────── */

console.log("\n0. 脚手架自己(通道名对不对得上一件真事)");

const handlers = new Map<string, (evt: unknown, ...rest: unknown[]) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (evt: unknown, ...rest: unknown[]) => unknown) {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

process.env.MCODE_SMOKE_DATA_ROOT = DATA;
await initDb();
registerProjectHandlers(fakeIpc);

async function call<T = unknown>(channel: string, raw?: unknown): Promise<T> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`handler 没注册: ${channel}`);
  return (await h(null, raw)) as T;
}

/** 调一次并拿回错误消息(`""` = 没抛)。 */
async function catching(channel: string, raw?: unknown): Promise<string> {
  try {
    await call(channel, raw);
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

/** 每条断言都必须真的走到一条命中的通道 —— 没注册的通道在这里就炸,不静默。 */
{
  // 这一套要覆盖的通道,一个都不能少。
  const needed = [
    IPC.PROJECT_CREATE,
    IPC.PROJECT_LIST,
    IPC.PROJECT_SESSIONS,
    IPC.PROJECT_DELETE,
    IPC.PROJECT_ARCHIVE,
    IPC.PROJECT_SET_GROUP,
    IPC.PROJECT_REORDER,
    IPC.PROJECT_PIN,
    IPC.PROJECT_RENAME,
    IPC.SESSION_DELETE,
    IPC.SESSION_ARCHIVE,
    IPC.SESSION_RENAME,
    IPC.SESSION_PIN,
    IPC.SESSION_UPDATE_BOOKMARKS,
    IPC.SESSION_LIST_PINNED,
    IPC.SESSION_LIST_ALL,
    IPC.SESSION_SEARCH,
    IPC.SESSION_SEARCH_BOOKMARKS,
  ];
  const missing = needed.filter((c) => !handlers.has(c));
  eq("要验的通道全都注册上了", missing.length, 0);
  if (missing.length > 0) console.log(`     缺: ${JSON.stringify(missing)}`);
  // 通道名写错一个字,上面那条会红 —— 但真正要防的是**这条字符串本身**写错,
  // 那种情况下套件会拿着一个不存在的 IPC 名字一路空跑到收尾。
  eq("通道名不是编的(拿一条已知的跟契约对)", IPC.PROJECT_CREATE, "project:create");
}

function fresh(): void {
  resetSent();
  resetMobileEvents();
  resetRunnerStub();
  resetBackflowStub();
  resetRuntimeStub();
  resetCallTrace();
}

/** 建一个项目,返回 id。 */
function mkProject(name: string, path = `C:/p/${name}`): string {
  const now = Date.now();
  const id = `proj_${name}`;
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
  } as never);
  return id;
}

/** 建一条会话。`kind` 默认 chat。 */
function mkSession(
  id: string,
  projectId: string,
  over: Partial<Pick<Session, "kind" | "title" | "archived" | "pinnedAt" | "worktreePath" | "parentSessionId">> & {
    updatedAt?: number;
  } = {},
): string {
  const now = over.updatedAt ?? Date.now();
  SessionRepo.create({
    id,
    projectId,
    providerId: "claude-sdk",
    claudeSessionId: null,
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
    worktreePath: over.worktreePath ?? null,
    archived: over.archived ?? false,
    pinnedAt: over.pinnedAt ?? null,
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
  } as never);
  return id;
}

/* ──────────────── 1. 建 / 列 / 改名 / 分组 / 钉住 ──────────────── */

console.log("\n1. 项目的增改");

{
  fresh();
  const res = await call<{ project: { id: string; name: string; sortOrder: number } }>(IPC.PROJECT_CREATE, {
    name: "论文",
    path: "C:/work/paper",
  });
  eq("建出来的名字对", res.project.name, "论文");
  // handler 建完**再读一次**拿权威那行(注释写着 "the re-read below returns the
  // authoritative row")。这一条只钉"返回的是库里那行、带上了 sortOrder 这个字段"。
  //
  // ⚠️ 别在这儿断言 `> 0`:那会是在验 `ProjectRepo.create` 的
  // `MAX(sort_order)+1`(别人的职责),而且本套件共用一个库、前面几节已经建过项目,
  // 数字是多少取决于跑的顺序。第一条建的项目 sortOrder 就是 0 —— 恰恰是源码注释里
  // 说的"pre-migration rows, which all default to 0"那种情况。
  eq("返回的是**重读过的**那一行(sortOrder 是个数字,不是 undefined)", typeof res.project.sortOrder, "number");

  const list = await call<{ projects: unknown[] }>(IPC.PROJECT_LIST);
  eq("列表里有了", list.projects.length, 1);

  const renamed = await call<{ project: { name: string; path: string } }>(IPC.PROJECT_RENAME, {
    id: res.project.id,
    name: "论文 v2",
  });
  eq("改名生效", renamed.project.name, "论文 v2");
  // 路径是 cwd / 路径守卫的**功能键**,改名绝不能碰它 —— 碰了整棵树的 cwd 就错位。
  eq("改名**不碰路径**(那是功能键,不是显示字段)", renamed.project.path, "C:/work/paper");

  const grouped = await call<{ project: { group: string | null } }>(IPC.PROJECT_SET_GROUP, {
    id: res.project.id,
    group: "在读",
  });
  eq("分组设上了", grouped.project.group, "在读");
  const ungrouped = await call<{ project: { group: string | null } }>(IPC.PROJECT_SET_GROUP, {
    id: res.project.id,
    group: null,
  });
  eq("传 null 是取消分组", ungrouped.project.group, null);

  const pinned = await call<{ project: { pinnedAt: number | null; sortOrder: number } }>(IPC.PROJECT_PIN, {
    id: res.project.id,
    pinned: true,
  });
  check("钉住了(pinnedAt 有值)", pinned.project.pinnedAt !== null, pinned.project.pinnedAt);
  // 钉住**不动** sort_order —— 取消钉住要能回到用户拖的那个位置。
  eq("钉住不挪拖拽顺序", pinned.project.sortOrder, res.project.sortOrder);

  const unpinned = await call<{ project: { pinnedAt: number | null } }>(IPC.PROJECT_PIN, {
    id: res.project.id,
    pinned: false,
  });
  eq("取消钉住", unpinned.project.pinnedAt, null);
}

{
  // 认不出的 id:改名/分组/钉住/归档**都**要抛,不能静默什么都不做。
  // (对比:`claude-ipc-smoke` 里抓到过 `SESSION_UPDATE_SETTINGS` 只改模型时不查会话
  // 存在性、UPDATE 打不中静默通过 —— 这里把 projects 这一层的四个都钉住。)
  fresh();
  for (const [channel, raw] of [
    [IPC.PROJECT_RENAME, { id: "没有这个项目", name: "x" }],
    [IPC.PROJECT_SET_GROUP, { id: "没有这个项目", group: "g" }],
    [IPC.PROJECT_PIN, { id: "没有这个项目", pinned: true }],
    [IPC.PROJECT_ARCHIVE, { id: "没有这个项目", archived: true }],
  ] as const) {
    const threw = await catching(channel, raw);
    check(`${channel} 认不出的 id 抛出去(不静默)`, threw.includes("not found"), threw || "(没抛)");
  }
}

{
  fresh();
  const threw = await catching(IPC.PROJECT_CREATE, { name: "x" });
  check("建项目缺 path 被拒", threw !== "", threw || "(没抛)");
}

/* ──────────────── 2. 删项目:级联之后的那些收尾 ──────────────── */

console.log("\n2. 删项目 —— 级联删掉的每一条会话,收尾做全了没有");

{
  fresh();
  const pid = mkProject("要删的");
  const other = mkProject("别动我");
  const a = mkSession("s_a", pid, { title: "对话甲" });
  const b = mkSession("s_b", pid, { title: "对话乙" });
  const side = mkSession("s_side", pid, { kind: "side", parentSessionId: a });
  const outsider = mkSession("s_out", other);
  MessageRepo.replaceAll(a, [{ id: "m1", sessionId: a, role: "user", content: "喂", createdAt: 1 }]);

  // 甲那张图正跑到一半,乙有一段还没被带走的并回内容。
  markRunActive(a);
  queueBackflow(b, "乙这一轮的产出");

  await call(IPC.PROJECT_DELETE, { id: pid });

  // 1) 级联真的把会话带走了(这是整个问题的前提,先确认夹具没摆错)。
  eq("项目没了", ProjectRepo.get(pid), undefined);
  eq("它下面的会话被级联删了(a)", SessionRepo.get(a), undefined);
  eq("它下面的会话被级联删了(b)", SessionRepo.get(b), undefined);
  // 侧栏问答(kind="side")也挂在同一个 project 上,一样会被级联带走 —— 所以
  // 收尾也必须覆盖它,不能只收 chat。
  eq("侧栏问答也被级联删了", SessionRepo.get(side), undefined);
  eq("消息跟着走了", MessageRepo.hasAny(a), false);
  eq("别的项目的会话一条没动", SessionRepo.get(outsider)?.id, outsider);

  // 2) 收尾。这三条是这一节存在的理由。
  check(
    "**每一条**被级联删掉的会话都被问过要不要停图(不是只问第一条)",
    [a, b, side].every((id) => cancelAsked.includes(id)),
    cancelAsked,
  );
  eq("真的停在跑的那张图(甲)", stoppedRuns.length, 1);
  check("停的是甲那张图(不是别人的)", stoppedRuns[0] === a, stoppedRuns);
  check(
    "**每一条**的待并回内容都清了(不是只清第一条)",
    [a, b, side].every((id) => dropped.includes(id)),
    dropped,
  );

  // 3) 手机端那边这几条会话是"刚才还在列表里"的,要逐条告诉它。
  const deletedIds = mobileEvents
    .filter((e) => e.type === "session.deleted")
    .map((e) => (e as { sessionId: string }).sessionId);
  check(
    "手机端收到了每一条的删除(不删的话列表里挂着几条点不开的会话)",
    [a, b, side].every((id) => deletedIds.includes(id)),
    deletedIds,
  );

  // 4) 运行时也要放掉(2026-09-20 上游合并带进来的那一句)。
  //
  // 不放的后果是:主进程 `sessions` 那张表里的条目**驻留到应用退出**,而且删掉的
  // 会话上还在跑的回合会继续往死会话里写事件、把孤儿消息行插回去。都是用户看得见的。
  //
  // ⚠️ 这里钉的**不是**"调过一次",而是"**每一条**都被放了" —— 项目级那条路走的是
  // `disposeProject`,它自己去列会话;而逐条放过没有,只有桩的记录能说明。
  // 判据落在 `disposedProjectIds`(项目级)上,因为项目删除走的就是这一句。
  check(
    "删项目时**项目级**放了一次运行时(不是逐条放)",
    disposedProjectIds().includes(pid),
    disposedProjectIds(),
  );
}

{
  // 删项目那条路上,**逐条**的 `dispose` 不该被调 —— 上游给的是 `disposeProject`,
  // 它内部自己去列。这条是防止有人"顺手"再补一个循环(那会做两遍,而且第二遍是对
  // 已经不存在的会话做的)。
  fresh();
  const pid = mkProject("只放一次");
  mkSession("s_x", pid);
  mkSession("s_y", pid);
  await call(IPC.PROJECT_DELETE, { id: pid });
  eq("项目级放一次就够,没有逐条再放一遍", disposedIds().length, 0);
}

{
  // 删一个**空**项目:一个会话都没有时不该有任何收尾动作,也不该抛。
  fresh();
  const pid = mkProject("空的");
  const threw = await catching(IPC.PROJECT_DELETE, { id: pid });
  eq("删空项目不抛", threw, "");
  eq("没有会话可收尾", cancelAsked.length + dropped.length, 0);
  eq("项目真没了", ProjectRepo.get(pid), undefined);
}

{
  // 删一个**不存在**的项目:静默什么都不做(现状),但也不能把别人的东西碰坏。
  fresh();
  const keep = mkProject("留着的");
  const keepSession = mkSession("s_keep", keep);
  const threw = await catching(IPC.PROJECT_DELETE, { id: "没有这个项目" });
  eq("删不存在的项目不抛(现状:UPDATE/DELETE 打不中就什么都不做)", threw, "");
  eq("别人的会话还在", SessionRepo.get(keepSession)?.id, keepSession);
  eq("也没有对别人的会话做收尾", cancelAsked.length, 0);
}

/* ──────────────── 3. 单条会话的删除:同样两句收尾 ──────────────── */

console.log("\n3. 删一条会话");

{
  fresh();
  const pid = mkProject("p3");
  const s = mkSession("s_del", pid);
  MessageRepo.replaceAll(s, [{ id: "m", sessionId: s, role: "user", content: "hi", createdAt: 1 }]);
  markRunActive(s);
  queueBackflow(s, "待并回");

  await call(IPC.SESSION_DELETE, { id: s });

  eq("会话没了", SessionRepo.get(s), undefined);
  eq("消息跟着走了", MessageRepo.hasAny(s), false);
  eq("图被停了", stoppedRuns.length, 1);
  check("停的是这一条", stoppedRuns[0] === s, stoppedRuns);
  check("待并回内容清了", dropped.includes(s), dropped);
  check(
    "运行时也放掉了(逐条的那一句 —— 会话级的 dispose)",
    disposedIds().includes(s),
    disposedIds(),
  );
  // ⚠️ 顺序:掐图必须在放运行时**之前**。反过来的话,`dispose` 清审批池的时候节点
  // 还挂在 promise 上 —— 那正是"图永远不结束"那个 bug 本身。
  //
  // 判据读的是**同一条流水**(`callTrace`),不是拿两个各自独立的数组比下标 ——
  // `cancelAsked` 是跨用例累计的,它的下标跟 `disposedIds()` 根本不可比,第一版
  // 那么写红了一条假 FAIL。
  const iStop = callTrace.indexOf(`cancel:${s}`);
  const iDispose = callTrace.indexOf(`dispose:${s}`);
  check(
    "先掐图、再放运行时(顺序反了就是'图永远不结束'那个 bug)",
    iStop !== -1 && iDispose !== -1 && iStop < iDispose,
    { iStop, iDispose, callTrace },
  );
  check(
    "手机端收到这条会话的删除",
    mobileEvents.some((e) => e.type === "session.deleted" && (e as { sessionId: string }).sessionId === s),
    mobileEvents.map((e) => e.type),
  );
}

{
  // 删一条不存在(或已删)的会话:不抛,也不能误伤。
  // ⚠️ 这一条同时钉住"两次删除是幂等的" —— 双击删除按钮、或者桌面端和手机端同时删。
  fresh();
  const pid = mkProject("p3b");
  const s = mkSession("s_twice", pid);
  await call(IPC.SESSION_DELETE, { id: s });
  const first = cancelAsked.length;
  const threw = await catching(IPC.SESSION_DELETE, { id: s });
  eq("第二条消息删第二次不抛(双击删除是幂等的)", threw, "");
  // ⚠️ 现状:**第二次仍然会做一遍收尾** —— 它是先收尾再删,不先查会话在不在。
  // 写在这是为了让改的人看见:真要去掉这两下(比如为了省事提前 return),
  // 会顺手把"图上还在跑但会话已经被别处删了"那条路也一起掐掉。
  check(
    "第二次也照样问了一遍(现状:收尾在删除之前,不先查存在性)",
    cancelAsked.length === first + 1,
    { before: first, after: cancelAsked.length },
  );
}

/* ──────────────── 4. 会话的改名 / 归档 / 钉住 / 书签 ──────────────── */

console.log("\n4. 会话的改");

{
  fresh();
  const pid = mkProject("p4");
  const s = mkSession("s_mut", pid);

  const renamed = await call<{ session: { title: string } }>(IPC.SESSION_RENAME, { id: s, title: "改过的标题" });
  eq("改名落库", renamed.session.title, "改过的标题");
  check("广播了(手机端标题跟着变)", eventsOfType("session.changed").length === 1, sentChannels());

  resetSent();
  resetMobileEvents();
  const archived = await call<{ session: { archived: boolean } }>(IPC.SESSION_ARCHIVE, { id: s, archived: true });
  eq("归档落库", archived.session.archived, true);
  check("归档也广播了", eventsOfType("session.changed").length === 1, sentChannels());
  // 归档是**软删**,消息不能跟着没。
  const restored = await call<{ session: { archived: boolean } }>(IPC.SESSION_ARCHIVE, { id: s, archived: false });
  eq("取消归档", restored.session.archived, false);

  resetSent();
  const pinned = await call<{ session: { pinnedAt: number | null } }>(IPC.SESSION_PIN, { id: s, pinned: true });
  check("钉住了", pinned.session.pinnedAt !== null, pinned.session.pinnedAt);

  const listPinned = await call<{ sessions: Array<{ id: string }> }>(IPC.SESSION_LIST_PINNED);
  eqArr("钉住的能在「钉住」那一栏里查到", listPinned.sessions.map((x) => x.id), [s]);
}

{
  // 书签:整份替换。`title` 是可选的(改名前存下的行要能原样过),存的时候要归一成
  // `null`,否则领域类型就不是严格的了。
  fresh();
  const pid = mkProject("p4b");
  const s = mkSession("s_bm", pid);

  const res = await call<{ session: { bookmarks: Array<{ id: string; title: string | null }> } }>(
    IPC.SESSION_UPDATE_BOOKMARKS,
    {
      id: s,
      bookmarks: [
        {
          id: "bm1",
          messageId: "m1",
          excerpt: "划的那一段",
          role: "user",
          createdAt: 100,
          // 故意**不带** title —— 模拟改名前存下的行。
        },
        {
          id: "bm2",
          messageId: "m2",
          excerpt: "第二段",
          title: "我给它起的名字",
          role: "assistant",
          createdAt: 200,
        },
      ],
    },
  );
  eq("两条都存下来了", res.session.bookmarks.length, 2);
  eq("没带 title 的那条被归一成 null(不是 undefined)", res.session.bookmarks[0]?.title, null);
  eq("带了的原样保留", res.session.bookmarks[1]?.title, "我给它起的名字");

  // 再存一次,少一条 —— 整份替换的语义:少的那个要**真没了**。
  const second = await call<{ session: { bookmarks: Array<{ id: string }> } }>(IPC.SESSION_UPDATE_BOOKMARKS, {
    id: s,
    bookmarks: [
      { id: "bm2", messageId: "m2", excerpt: "第二段", title: null, role: "assistant", createdAt: 200 },
    ],
  });
  eqArr("整份替换:少的那个真没了(不是合并)", second.session.bookmarks.map((b) => b.id), ["bm2"]);

  const search = await call<{ results: Array<{ bookmark: { id: string }; sessionId: string }> }>(
    IPC.SESSION_SEARCH_BOOKMARKS,
    { query: "第二段" },
  );
  eqArr("按内容搜得到", search.results.map((r) => r.bookmark.id), ["bm2"]);
  eq("带上所属会话(面板要靠它跳过去)", search.results[0]?.sessionId, s);
}

{
  // 坏书签要显式拒,不能塞一条半成品进去。
  fresh();
  const pid = mkProject("p4c");
  const s = mkSession("s_bm_bad", pid);
  const threw = await catching(IPC.SESSION_UPDATE_BOOKMARKS, {
    id: s,
    bookmarks: [{ id: "bm", messageId: "", excerpt: "x", role: "user", createdAt: 1 }],
  });
  check("空的 messageId 被拒", threw !== "", threw || "(没抛)");
  const threw2 = await catching(IPC.SESSION_UPDATE_BOOKMARKS, {
    id: s,
    bookmarks: [{ id: "bm", messageId: "m", excerpt: "x", role: "机器人", createdAt: 1 }],
  });
  check("role 不是 user/assistant 的也被拒", threw2 !== "", threw2 || "(没抛)");
  eq("两次都没写进去", SessionRepo.get(s)?.bookmarks, null);
}

{
  // 认不出的会话:改名/归档/钉住都抛(和项目那一组同一个口径)。
  fresh();
  for (const [channel, raw] of [
    [IPC.SESSION_RENAME, { id: "没有这个会话", title: "x" }],
    [IPC.SESSION_ARCHIVE, { id: "没有这个会话", archived: true }],
    [IPC.SESSION_PIN, { id: "没有这个会话", pinned: true }],
    [IPC.SESSION_UPDATE_BOOKMARKS, { id: "没有这个会话", bookmarks: [] }],
  ] as const) {
    const threw = await catching(channel, raw);
    check(`${channel} 认不出的 id 抛出去(不静默)`, threw.includes("not found"), threw || "(没抛)");
  }
}

/* ──────────────── 5. 分页 ──────────────── */

console.log("\n5. 项目内会话列表:分页与过滤口径");

{
  fresh();
  const pid = mkProject("p5");
  // 12 条 chat,updatedAt 递增(12 最新)。列表是 updated_at DESC。
  for (let i = 1; i <= 12; i += 1) {
    mkSession(`s_${String(i).padStart(2, "0")}`, pid, { updatedAt: 1000 + i, title: `第${i}条` });
  }
  // 干扰项(**全部** updatedAt 都排在 12 条之前,免得混进第一页把"最新的排最前"搅乱):
  // 归档的、钉住的、worktree 的、side 的、别的项目的。
  mkSession("s_arch", pid, { archived: true, updatedAt: 100 });
  mkSession("s_pin", pid, { pinnedAt: 1, updatedAt: 200 });
  mkSession("s_wt", pid, { worktreePath: "C:/wt/x", updatedAt: 300 });
  mkSession("s_side", pid, { kind: "side", parentSessionId: "s_12", updatedAt: 400 });
  const other = mkProject("p5-other");
  mkSession("s_other", other, { updatedAt: 9000 });

  const page1 = await call<{ sessions: Array<{ id: string }>; hasMore: boolean; total: number }>(
    IPC.PROJECT_SESSIONS,
    { projectId: pid, archived: false },
  );
  eq("默认一页 5 条", page1.sessions.length, 5);
  eq("最新的排最前", page1.sessions[0]?.id, "s_12");
  // total/hasMore 必须是**同一套过滤口径**:归档的、钉住的、worktree 的、side 的、
  // 别的项目的,一个都不能算进来。
  //
  // ⚠️ 注意 worktree 那条:**活动列表不排除 worktree**,它一样算进来、一样显示。
  // 源码注释里的 "the count MUST mirror the list's filter" 说的是
  // `countByProject(projectId, archived, worktree)` 的前两个参数必须和 `listByProject`
  // 一致 —— `listByProject` 只在 `opts.archived === false` 时加 `pinned_at IS NULL`,
  // `countByProject` 也只在 `archived === false` 时加,两边是**对上的**。
  eq("总数正好是那 13 条(12 条 + worktree 那条;归档/钉住/side/别的项目都不算)", page1.total, 13);
  eq("而且说还有更多", page1.hasMore, true);
  eq(
    "**没有**把 side 会话混进来(它是右栏管理的,不进项目树)",
    page1.sessions.some((s) => s.id === "s_side"),
    false,
  );
  eq(
    "**没有**把钉住的混进活动列表(它渲染在左栏顶部那个独立区)",
    page1.sessions.some((s) => s.id === "s_pin"),
    false,
  );

  // 走到底,一条不重不漏。
  const seen: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await call<{ sessions: Array<{ id: string }>; hasMore: boolean; total: number }>(
      IPC.PROJECT_SESSIONS,
      { projectId: pid, archived: false, offset, limit: 5 },
    );
    seen.push(...page.sessions.map((s) => s.id));
    if (!page.hasMore) {
      // 最后一页的 total 必须还是全量 —— 它和 offset/limit 无关。
      eq("最后一页的 total 还是全量(不是这一页的条数)", page.total, 13);
      eq("最后一页的 hasMore 是 false(否则「显示更多」永远亮着)", page.hasMore, false);
      break;
    }
    offset += page.sessions.length;
    if (offset > 100) {
      check("翻页没有死循环", false, seen.length);
      break;
    }
  }
  eq("翻下来正好 13 条,不重不漏", seen.length, 13);
  eq("去重之后还是 13 条(没有重叠)", new Set(seen).size, 13);
  eq("最早那条也翻到了", seen.includes("s_01"), true);

  // 归档那一栏是另一套口径:**只有**归档的。
  const bin = await call<{ sessions: Array<{ id: string }>; total: number }>(IPC.PROJECT_SESSIONS, {
    projectId: pid,
    archived: true,
  });
  eqArr("归档栏里只有归档的那条", bin.sessions.map((s) => s.id), ["s_arch"]);

  // worktree 过滤:列表和计数必须同时收窄,否则 hasMore 会数进列表根本不返回的行。
  const local = await call<{ sessions: Array<{ id: string }>; total: number }>(IPC.PROJECT_SESSIONS, {
    projectId: pid,
    archived: false,
    worktree: "exclude",
  });
  eq("worktree=exclude 时 worktree 那条不算进列表", local.sessions.some((s) => s.id === "s_wt"), false);
  eq("**也不算进 total**(否则「显示更多」会数进列表没有的行)", local.total, 12);

  const onlyWt = await call<{ sessions: Array<{ id: string }>; total: number }>(IPC.PROJECT_SESSIONS, {
    projectId: pid,
    archived: false,
    worktree: "only",
  });
  eqArr("worktree=only 时只剩它", onlyWt.sessions.map((s) => s.id), ["s_wt"]);
  eq("而且 total 也是 1", onlyWt.total, 1);
}

/* ──────────────── 6. 跨项目聚合列表 ──────────────── */

console.log("\n6. 跨项目列表(sidebar 的「全部项目」)");

{
  fresh();
  // ⚠️ 这个套件**整份共用一个库**,前面几节建的会话全在。所以「全量」这个词在这里
  // 只有一个意思 —— 库里所有活动 chat。要验数字就得**按项目收窄**,不能拿全部。
  // 下面 `p1` 专门用来演"作用域收窄之后是不是只数自己那一份"。
  const p1 = mkProject("q1");
  const p2 = mkProject("q2");
  for (let i = 1; i <= 8; i += 1) mkSession(`q_${i}`, p1, { updatedAt: 1000 + i });
  mkSession("q_other", p2, { updatedAt: 2000 });
  mkSession("q_arch", p2, { archived: true, updatedAt: 3000 });
  mkSession("q_pin", p2, { pinnedAt: 1, updatedAt: 4000 });

  // 不设作用域:全量。只验"确实比收窄后多",不硬编数字(别把别的节的数据算进来)。
  const all = await call<{ sessions: Array<{ id: string }>; hasMore: boolean; total: number }>(
    IPC.SESSION_LIST_ALL,
    {},
  );
  check("不设作用域时总数大于 p1 那一份(证明它真在跨项目数)", all.total > 8, all.total);
  eq("归档的不在列表里", all.sessions.some((s) => s.id === "q_arch"), false);
  eq("钉住的也不在(它进的是顶部那个独立区)", all.sessions.some((s) => s.id === "q_pin"), false);

  // p1 那一份:8 条,正好装得下一页(默认 10)。
  const scopedP1 = await call<{ sessions: Array<{ id: string }>; hasMore: boolean; total: number }>(
    IPC.SESSION_LIST_ALL,
    { projectIds: [p1] },
  );
  eq("收窄到 p1 后正好那 8 条", scopedP1.total, 8);
  eq("一页装得下,所以没有更多", scopedP1.hasMore, false);
  eq("拿到的就是 8 条", scopedP1.sessions.length, 8);

  // ⚠️ 作用域收窄的核心断言:hasMore/total 必须跟着**一起**收窄。
  // 不收的话,用户切了项目之后底下那个「显示更多」还按全量在算。
  const scoped = await call<{ sessions: Array<{ id: string }>; hasMore: boolean; total: number }>(
    IPC.SESSION_LIST_ALL,
    { projectIds: [p2], limit: 1 },
  );
  eq("收窄到 q2 后 total 是它自己那 1 条(归档/钉住的不算)", scoped.total, 1);
  eq("只有 1 条,所以没有更多", scoped.hasMore, false);
  eq("而且拿到的确实是 q2 的", scoped.sessions[0]?.id, "q_other");

  // 换一个真的有多页的:把 p1 那 8 条按每页 3 条翻,验 offset 不重不漏。
  const flat: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await call<{ sessions: Array<{ id: string }>; hasMore: boolean; total: number }>(
      IPC.SESSION_LIST_ALL,
      { projectIds: [p1], limit: 3, offset },
    );
    flat.push(...page.sessions.map((s) => s.id));
    if (!page.hasMore) {
      eq("最后一页的 total 还是 8(和 offset 无关)", page.total, 8);
      break;
    }
    offset += page.sessions.length;
    if (offset > 100) {
      check("跨项目列表翻页没有死循环", false, flat.length);
      break;
    }
  }
  eq("翻下来正好 8 条", flat.length, 8);
  eq("去重之后还是 8 条(页之间不重叠)", new Set(flat).size, 8);

  // worktreeKey 作用域。
  //
  // ⚠️ 契约里写明这个 key 是**渲染端 `normWorktreeKey` 那种归一形式**
  // (小写、正斜杠、去尾斜杠),主进程用 `normPathKey` 那个孪生函数比。Windows 上
  // 大小写不敏感,所以传大写 `C:` 是**匹配不上**的 —— 第一次跑就是这里红的。
  // 夹具也照渲染端那种写法存,免得验的是一个现实里不会出现的形状。
  mkSession("q_wt", p2, { worktreePath: "c:/wt/keyed", updatedAt: 5000 });
  const wt = await call<{ sessions: Array<{ id: string }>; total: number }>(IPC.SESSION_LIST_ALL, {
    worktreeKey: "c:/wt/keyed",
  });
  eqArr("按 worktree 收窄只剩那一条", wt.sessions.map((s) => s.id), ["q_wt"]);
  eq("total 也跟着收窄", wt.total, 1);

  // 归一是**比的时候一边做**,不是两边做。
  //
  // 契约原文(`packages/contracts/src/ipc/session.ts`):
  //   "as a normalized path key (**renderer's normWorktreeKey form** — main
  //    compares with its normPathKey twin)"
  // `repositories.ts` 那句是 `normPathKey(s.worktreePath) !== wtKey` —— 归一的是
  // **库里的那份**,传进来那份**原样**拿去比。渲染端那两处 `wt:` 拼接
  // (`StreamSidebar` 的 `normWorktreeKey(w.path)`、`sessionStore` 的 `scope.slice(3)`)
  // 保证送过来的本来就是小写正斜杠。所以大小写不同是**匹配不上**的 ——
  // 这是两边约定好的分工,不是 bug。
  const wtCase = await call<{ sessions: Array<{ id: string }> }>(IPC.SESSION_LIST_ALL, {
    worktreeKey: "C:/WT/KEYED",
  });
  eqArr("传大写(不做归一的写法)匹配不上,契约要求调用方先归一", wtCase.sessions.map((s) => s.id), []);
  // 反斜杠同理:那是"渲染端没归一"的形状。归一了就该匹配上 —— 下面这条才是
  // 那个归一函数真正要挡的东西:**库里存的**是反斜杠(Windows 上 git 给的就是),
  // 传进来的是正斜杠,两边表面不一样却必须认出是同一条。
  mkSession("q_wt_bs", p2, { worktreePath: "c:\\wt\\keyed", updatedAt: 5001 });
  const wtSlash = await call<{ sessions: Array<{ id: string }> }>(IPC.SESSION_LIST_ALL, {
    worktreeKey: "c:/wt/keyed",
  });
  eqArr(
    "库里存反斜杠、传进来正斜杠,照样是同一条",
    wtSlash.sessions.map((s) => s.id).sort(),
    ["q_wt", "q_wt_bs"],
  );
}

/* ──────────────── 7. 搜索 ──────────────── */

console.log("\n7. 标题搜索(Ctrl+K)");

{
  fresh();
  const pid = mkProject("r1");
  mkSession("r_a", pid, { title: "关于扩散模型的笔记" });
  mkSession("r_b", pid, { title: "别的东西" });
  mkSession("r_arch", pid, { title: "扩散模型(归档的)", archived: true });

  const res = await call<{ sessions: Array<{ id: string }> }>(IPC.SESSION_SEARCH, { query: "扩散" });
  check("按标题子串搜到了", res.sessions.some((s) => s.id === "r_a"), res.sessions.map((s) => s.id));
  check("不相关的不进来", !res.sessions.some((s) => s.id === "r_b"), res.sessions.map((s) => s.id));
  // 注释里写明"Matches non-archived sessions only"。
  check("归档的不进搜索结果", !res.sessions.some((s) => s.id === "r_arch"), res.sessions.map((s) => s.id));

  const empty = await call<{ sessions: unknown[] }>(IPC.SESSION_SEARCH, { query: "绝对匹配不到的词" });
  eq("搜不到就是空数组,不是 undefined", empty.sessions.length, 0);
}

/* ──────────────── 收尾 ──────────────── */

rmSync(DATA, { recursive: true, force: true });

console.log(`\nprojects-ipc-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
