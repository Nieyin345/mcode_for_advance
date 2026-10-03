/**
 * Headless smoke for the renderer session store's `session.changed` reducer —
 * specifically the TWO-SECTION routing of the per-project thread cache
 * (local list / worktree-bound list, see splitSessionSections).
 *
 * Regression anchor: removing a git worktree degenerates every referencing
 * session back to local (main's `removeWorktree` PATCHes worktreePath=NULL and
 * broadcasts one `session.changed` per row). The reducer used to materialize
 * the degraded row at the head of the local section while leaving the stale
 * worktree-bound copy in place — the same id twice in one cache array. The
 * left bar buckets its tree by `session.worktreePath`, so the ghost row kept
 * the removed worktree's group on screen ("删除工作树后工作树还在").
 *
 * Run: scripts/session-store-smoke/run.sh
 */
import { setSendTurnStub, setSessionMessagesStub } from "./prelude.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore } from "@renderer/stores/toastStore.js";
import type { ChatMessage } from "@renderer/stores/sessionStore.js";
import { outputRowsOf } from "@renderer/components/chat/outputRows.js";
import { normWorktreeKey } from "@renderer/lib/worktree.js";
import type { Session } from "@contracts/session";
import type { ContextSnapshot, SessionListEntry, TurnFileEntry } from "@contracts/runtime";

const PROJECT = "p1";
const WT_OLD = "D:\\proj\\.worktrees\\wt-1";
const WT_OTHER = "D:\\proj\\.worktrees\\wt-2";
const WT_NEW = "D:\\proj\\.worktrees\\wt-3";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

/** 值相等断言。这个 suite 早先只有 `check`(它验的是"集合里少了谁"这类),后加的几节
 *  验的是"这个字段等于什么",写成 `check(name, a === b, {a, b})` 太吵。 */
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/** 结构相等(数组 / 对象)。`eq` 走的是 `Object.is`,对 `[{…}]` 只会比引用。 */
function deepEq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

let seq = 0;
function mkSession(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    projectId: PROJECT,
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    nodeId: null,
    title: id,
    status: "idle",
    model: "default",
    effort: "default",
    permissionMode: "default",
    // 工作流:改名之后这个字段是必填的(`composerMode` 那个别名只在 IPC 入参上
    // 还留着)。夹具补上,免得 `tsc` 把这条冒烟一直漏在外面。
    workflowId: "default",
    customModelId: null,
    archived: false,
    pinnedAt: null,
    contextSnapshot: null,
    todos: null,
    subagents: null,
    planDraft: null,
    usageHistory: null,
    turnFiles: null,
    bookmarks: null,
    subagentTranscripts: null,
    createdAt: 1,
    updatedAt: 1 + seq++,
    ...over,
  };
}

/** Mirror of main's `toSessionListEntry` — the wire row carries NO heavy
 *  payloads, which is exactly what makes the merge-over-cache path load-bearing. */
function toListEntry(s: Session): SessionListEntry {
  const {
    contextSnapshot: _cs,
    todos: _td,
    subagents: _sa,
    planDraft: _pd,
    usageHistory: _uh,
    turnFiles: _tf,
    bookmarks: _bm,
    subagentTranscripts: _st,
    ...entry
  } = s;
  return entry;
}

function ingest(session: Session | SessionListEntry): void {
  useSessionStore.getState().ingestEvent({
    type: "session.changed",
    sessionId: session.id,
    session: session as SessionListEntry,
  });
}

function cache(project = PROJECT): Session[] {
  return useSessionStore.getState().sessionsByProject[project] ?? [];
}

/** LeftBar's bucketing (components/layout/LeftBar.tsx) verbatim: the tree's
 *  worktree groups are derived from cached rows that still carry a path. */
function worktreeGroups(project = PROJECT): string[] {
  const keys = new Set<string>();
  for (const s of cache(project)) {
    if (s.worktreePath) keys.add(normWorktreeKey(s.worktreePath));
  }
  return [...keys];
}

function rowsOf(id: string, project = PROJECT): Session[] {
  return cache(project).filter((s) => s.id === id);
}

function seed(sessions: Session[], opts: { total?: number; worktreeView?: boolean } = {}): void {
  useSessionStore.setState({
    activeProjectId: PROJECT,
    activeSessionId: null,
    sessionsByProject: { [PROJECT]: sessions },
    sessions,
    sessionsTotalByProject: {
      [PROJECT]: opts.total ?? sessions.filter((s) => !s.worktreePath).length,
    },
    sessionsHasMoreByProject: { [PROJECT]: false },
    pinnedSessions: [],
    archivedSessionsByProject: {},
    worktreeViewByProject: opts.worktreeView ? { [PROJECT]: true } : {},
  });
}

// ── 1. Worktree removal degenerates its sessions back to local ────────────
console.log("\n[1] worktree removal → degraded local row");
{
  const snapshot = { used: 42, total: 200_000 } as unknown as ContextSnapshot;
  const wt = mkSession("wt1", { worktreePath: WT_OLD, contextSnapshot: snapshot });
  const local = mkSession("loc1");
  seed([local, wt], { total: 1 });

  ingest(toListEntry(mkSession("wt1", { worktreePath: null })));

  check("no duplicate row for the degraded session", rowsOf("wt1").length === 1, cache().map((s) => s.id));
  check("degraded row sits in the local section (prepended)", cache()[0]?.id === "wt1");
  check("degraded row lost its worktreePath", cache()[0]?.worktreePath == null);
  check("no stale worktree-bound row remains", cache().every((s) => !s.worktreePath));
  check("left-bar worktree group is gone", worktreeGroups().length === 0, worktreeGroups());
  check(
    "heavy payload survives the degradation (merged over the cached row)",
    cache()[0]?.contextSnapshot === snapshot,
  );
  check("local total grows by one", useSessionStore.getState().sessionsTotalByProject[PROJECT] === 2);
  check("derived `sessions` alias is refreshed", useSessionStore.getState().sessions[0]?.id === "wt1");
}

// ── 2. Degrading the LAST worktree row falls the view back to local ───────
console.log("\n[2] last worktree row degrades → view flip");
{
  seed([mkSession("loc1"), mkSession("wt1", { worktreePath: WT_OLD })], { total: 1, worktreeView: true });
  ingest(toListEntry(mkSession("wt1", { worktreePath: null })));
  check("worktree view flipped back to local", useSessionStore.getState().worktreeViewByProject[PROJECT] !== true);
}

// ── 3. A sibling worktree survives its neighbour's removal ────────────────
console.log("\n[3] one worktree removed, another untouched");
{
  seed(
    [
      mkSession("loc1"),
      mkSession("wt1", { worktreePath: WT_OLD }),
      mkSession("wt2", { worktreePath: WT_OTHER }),
    ],
    { total: 1, worktreeView: true },
  );
  ingest(toListEntry(mkSession("wt1", { worktreePath: null })));
  const groups = worktreeGroups();
  check("only the removed worktree's group disappears", groups.length === 1 && groups[0] === normWorktreeKey(WT_OTHER), groups);
  check("sibling row is still worktree-bound", rowsOf("wt2")[0]?.worktreePath === WT_OTHER);
  check("view stays in the fork view", useSessionStore.getState().worktreeViewByProject[PROJECT] === true);
}

// ── 4. Materialize (local → worktree) still moves the row out of local ────
console.log("\n[4] worktree materialize");
{
  seed([mkSession("loc1"), mkSession("loc2")], { total: 2 });
  ingest(toListEntry(mkSession("loc1", { worktreePath: WT_NEW })));
  check("no duplicate row after materialize", rowsOf("loc1").length === 1, cache().map((s) => s.id));
  check("row left the local section", cache().every((s) => s.id !== "loc1" || !!s.worktreePath));
  check("worktree group appears", worktreeGroups()[0] === normWorktreeKey(WT_NEW), worktreeGroups());
  check("local total shrinks back to one", useSessionStore.getState().sessionsTotalByProject[PROJECT] === 1);
}

// ── 5. Plain local update (rename / settings) keeps the row in place ──────
console.log("\n[5] local row update");
{
  const snapshot = { used: 7, total: 100 } as unknown as ContextSnapshot;
  seed([mkSession("loc1", { contextSnapshot: snapshot }), mkSession("loc2")], { total: 2 });
  ingest(toListEntry(mkSession("loc1", { title: "renamed" })));
  check("row is updated in place", rowsOf("loc1")[0]?.title === "renamed");
  check("row count unchanged", cache().length === 2);
  check("heavy payload preserved", rowsOf("loc1")[0]?.contextSnapshot === snapshot);
  check("local total unchanged", useSessionStore.getState().sessionsTotalByProject[PROJECT] === 2);
}

// ── 6. A session created on another client lands in the local section ─────
console.log("\n[6] remote-created local session");
{
  seed([mkSession("loc1")], { total: 1 });
  ingest(toListEntry(mkSession("brand-new")));
  check("new row prepended exactly once", rowsOf("brand-new").length === 1 && cache()[0]?.id === "brand-new");
  check("local total grows", useSessionStore.getState().sessionsTotalByProject[PROJECT] === 2);
}

// ── 7. Archiving a worktree row drops it from both sections ───────────────
console.log("\n[7] archive a worktree row");
{
  seed([mkSession("loc1"), mkSession("wt1", { worktreePath: WT_OLD })], { total: 1 });
  ingest(toListEntry(mkSession("wt1", { worktreePath: WT_OLD, archived: true })));
  check("archived row leaves the cache entirely", rowsOf("wt1").length === 0, cache().map((s) => s.id));
  check("no worktree group left behind", worktreeGroups().length === 0);
  check("sibling local row survives", rowsOf("loc1").length === 1);
}

// ── 8. Events for an unloaded project are ignored ────────────────────────
console.log("\n[8] unloaded project");
{
  seed([mkSession("loc1")], { total: 1 });
  ingest(toListEntry(mkSession("other", { projectId: "p2", worktreePath: WT_OLD })));
  check("no cache bucket materialized for p2", useSessionStore.getState().sessionsByProject["p2"] === undefined);
  check("p1 untouched", cache().length === 1);
}

// ── 9. Workflow node transcripts (「看这一步的过程」) ─────────────────────
//
// 卡片上那个「过程」读的是 `workflowNodeTranscripts`,由主进程发的
// `workflow.node.transcript` 填。这里验两件事:**替换语义**(主进程每次发全量,渲染端
// 整体换掉,不是追加 —— 丢一条不会停在半截)、以及**结果卡片带上了那张表的钥匙**
// (`nodeSessionId`)。
console.log("\n[9] workflow node transcripts");
{
  seed([mkSession("conv1")], { total: 1 });
  const SID = "conv1";
  const NODE_SESSION = "sess_node_1";
  const blocksA = [{ kind: "text" as const, text: "我去查一下" }];
  const blocksB = [
    { kind: "text" as const, text: "我去查一下" },
    { kind: "tool_use" as const, toolCallId: "t1", toolName: "Read", input: {}, status: "running" as const },
  ];

  useSessionStore.getState().ingestEvent({
    type: "workflow.node.transcript",
    sessionId: SID,
    nodeSessionId: NODE_SESSION,
    blocks: blocksA,
  });
  eq(
    "第一条过程进去了",
    useSessionStore.getState().workflowNodeTranscripts[NODE_SESSION]?.length,
    1,
  );

  useSessionStore.getState().ingestEvent({
    type: "workflow.node.transcript",
    sessionId: SID,
    nodeSessionId: NODE_SESSION,
    blocks: blocksB,
  });
  eq(
    "第二条**整体替换**(不是追加成 3 块)",
    useSessionStore.getState().workflowNodeTranscripts[NODE_SESSION]?.length,
    2,
  );

  // 另一个节点是另一格,不能串味。
  useSessionStore.getState().ingestEvent({
    type: "workflow.node.transcript",
    sessionId: SID,
    nodeSessionId: "sess_node_2",
    blocks: blocksA,
  });
  eq(
    "另一个节点单独一格",
    Object.keys(useSessionStore.getState().workflowNodeTranscripts).length,
    2,
  );

  useSessionStore.getState().ingestEvent({
    type: "workflow.node.result",
    sessionId: SID,
    runId: "run1",
    nodeId: "n1",
    nodeSessionId: NODE_SESSION,
    nodeType: "mcode.agent",
    title: "查文献",
    status: "success",
    summary: "查到了 3 篇",
    // 结果事件**自带一份过程快照**。收场这一刻渲染端手上那份就是主进程刚发过来的,
    // 契约上的 `transcript` 是同一份内容(见 `WorkflowNodeResultEvent.transcript`)——
    // 这里两个都给,验的是"谁在的时候用谁"(下面的断言分两种情况)。
    transcript: blocksB,
  });
  const cards = (useSessionStore.getState().messagesBySession[SID] ?? [])
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "workflow-node-result");
  eq("结果落成一张卡片", cards.length, 1);
  const card = cards[0];
  check(
    "卡片带上了那张表的钥匙(nodeSessionId)",
    card?.kind === "workflow-node-result" && card.nodeSessionId === NODE_SESSION,
    card,
  );
  // **过程被裁掉之后,卡片上还留着收场那一刻的那一份。** 这是"跑完的每一步都还查得到
  // 它干了什么"的全部依仗:活的那张表(`workflowNodeTranscripts`)是进程生命周期的,
  // 而卡片落盘 —— 会话重开之后活的那份是空的,只能靠卡片自己带。
  eq(
    "收场时把过程拷进了卡片",
    card?.kind === "workflow-node-result" ? card.nodeTranscript?.length : undefined,
    2,
  );
  // 活的那份被顶掉(容量裁的、或者重开之后根本没有)之后,卡片依然是唯一来源。
  useSessionStore.setState({
    workflowNodeTranscripts: Object.fromEntries(
      Object.entries(useSessionStore.getState().workflowNodeTranscripts).filter(
        ([k]) => k !== NODE_SESSION,
      ),
    ),
  });
  const afterEvict = (useSessionStore.getState().messagesBySession[SID] ?? [])
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "workflow-node-result")[0];
  eq(
    "活的那份没了,卡片上的快照还在(用户照样看得见它干了什么)",
    afterEvict?.kind === "workflow-node-result" ? afterEvict.nodeTranscript?.length : undefined,
    2,
  );

  // 没跑过的节点(skipped)不带它 —— 卡片于是不会摆一个点开是空的入口。
  useSessionStore.getState().ingestEvent({
    type: "workflow.node.result",
    sessionId: SID,
    runId: "run1",
    nodeId: "n2",
    nodeType: "mcode.agent",
    title: "写初稿",
    status: "skipped",
    summary: "",
  });
  const skipped = (useSessionStore.getState().messagesBySession[SID] ?? [])
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "workflow-node-result")[1];
  check(
    "skip 掉的节点没有它(它压根没建过会话)",
    skipped?.kind === "workflow-node-result" && skipped.nodeSessionId === undefined,
    skipped,
  );
  check(
    "也没带过程快照(没跑过,没有过程可拷)",
    skipped?.kind === "workflow-node-result" && skipped.nodeTranscript === undefined,
    skipped,
  );

  // **产出变量名也要跟着卡片走。** 声明过变量的那一步,产出是一个对象、内容全在变量里
  // (见 `describeOutputVars`);卡片靠这几个名字决定"逐项摆变量"还是"摆一段文本",
  // 少了它,用户看到的就是那坨 JSON —— 他明确说过不要看的东西。
  useSessionStore.getState().ingestEvent({
    type: "workflow.node.result",
    sessionId: SID,
    runId: "run1",
    nodeId: "n3",
    nodeSessionId: "sess_node_3",
    nodeType: "mcode.main",
    title: "主代理",
    status: "success",
    summary: '{"学习计划": "上午学习"}',
    outputKeys: ["学习计划"],
  });
  const withKeys = (useSessionStore.getState().messagesBySession[SID] ?? [])
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "workflow-node-result")[2];
  deepEq(
    "声明过变量的那一步,名字跟着卡片走",
    withKeys?.kind === "workflow-node-result" ? withKeys.outputKeys : undefined,
    ["学习计划"],
  );
}

// ── 9b. 同一步回头绕第二圈:换卡,不是再插一张(A1) ─────────────────────
//
// 环回的图(写稿 → 审稿 → 回去改)会让同一个节点反复收场。每张卡都带一大段产出,
// 三圈下来对话里就是三张大差不多的卡 —— 用户要往下滚很久才看得见流程走到哪。
// 留下的是**最后一版**(环回的意义就是"改完之后那一版")。
console.log("\n[9b] workflow node round: 叠卡还是换卡");
{
  seed([mkSession("conv_round")], { total: 1 });
  const SID = "conv_round";
  const mkResult = (round: number | undefined, summary: string) => ({
    type: "workflow.node.result" as const,
    sessionId: SID,
    runId: "runR",
    nodeId: "nD",
    ...(round !== undefined ? { round } : {}),
    nodeType: "mcode.agent",
    title: "写初稿",
    status: "success" as const,
    summary,
  });

  useSessionStore.getState().ingestEvent(mkResult(undefined, "第一版"));
  const cardsAfter1 = (useSessionStore.getState().messagesBySession[SID] ?? [])
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "workflow-node-result");
  eq("第一轮:插一张卡", cardsAfter1.length, 1);
  // **第 1 轮不带 `round`** —— 没有环的图永远是第 1 轮,字段不占地方、老行为不改。
  eq(
    "第一轮那张卡上没有 round",
    cardsAfter1[0]?.kind === "workflow-node-result" ? cardsAfter1[0].round : "MISSING",
    undefined,
  );

  useSessionStore.getState().ingestEvent(mkResult(2, "第二版"));
  const cardsAfter2 = (useSessionStore.getState().messagesBySession[SID] ?? [])
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "workflow-node-result");
  // **还是那一张** —— 换掉而不是插。旧实现这里是 2 张,三圈就 3 张。
  eq("★ 第二圈:还是那一张(没多出来)", cardsAfter2.length, 1);
  eq(
    "★ 而且换成了第二版",
    cardsAfter2[0]?.kind === "workflow-node-result" ? cardsAfter2[0].summary : "",
    "第二版",
  );

  useSessionStore.getState().ingestEvent(mkResult(3, "第三版"));
  const cardsAfter3 = (useSessionStore.getState().messagesBySession[SID] ?? [])
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "workflow-node-result");
  eq("★ 第三圈:也还是一张", cardsAfter3.length, 1);
  eq(
    "★ 留下的是最后一版",
    cardsAfter3[0]?.kind === "workflow-node-result" ? cardsAfter3[0].summary : "",
    "第三版",
  );
  eq(
    "轮次也跟着更新",
    cardsAfter3[0]?.kind === "workflow-node-result" ? cardsAfter3[0].round : undefined,
    3,
  );

  // **另一次运行不受影响。** 轮次是每次运行自己数的(跨运行从 1 重来),卡片认卡用的是
  // `runId + nodeId` —— 少了 runId 这一半,上一次运行留下的卡会被这一次改掉。
  useSessionStore.getState().ingestEvent({
    type: "workflow.node.result",
    sessionId: SID,
    runId: "runOther",
    nodeId: "nD",
    nodeType: "mcode.agent",
    title: "写初稿",
    status: "success",
    summary: "另一次运行的第一版",
  });
  const allCards = (useSessionStore.getState().messagesBySession[SID] ?? [])
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "workflow-node-result");
  eq("★ 另一次运行自己一张(没把上一次那张改掉)", allCards.length, 2);
  eq(
    "上一次那张还是第三版",
    allCards[0]?.kind === "workflow-node-result" ? allCards[0].summary : "",
    "第三版",
  );
}

// ── 10. 卡片上摆什么:变量还是原文 ────────────────────────────────────────
//
// `outputRowsOf` 是那张卡片的唯一一个判断,而这正是用户报过的那件事:「我规定了主代理
// 的输出形式,但是他还是在输出形式之外多加了一段说明」。**它把 JSON 摊在卡片上,一个
// 多出来的字都藏不住** —— 所以这一段盯的是"什么时候不摊"。
console.log("\n[10] workflow node card: 变量还是原文");
{
  eq("没声明过变量 → 按原文摆", outputRowsOf('{"年份": "2024"}', undefined), null);
  eq("名字是空表 → 同上", outputRowsOf('{"年份": "2024"}', []), null);

  const rows = outputRowsOf('```\n{"年份": "2024", "标题": "量子"}\n```', ["年份", "标题"]);
  eq("围栏里的对象照样提得出来(和调度器同一个解析器)", rows?.length, 2);
  deepEq("第一样", rows?.[0], { name: "年份", text: "2024" });
  deepEq("第二样", rows?.[1], { name: "标题", text: "量子" });

  // **对象外面多写的那一段不会跟着上来** —— 卡片只摆声明过的那几样,这正是"硬约束
  // 之外的东西不该出现在界面上"的落点。
  const noisy = outputRowsOf('先说明一下:\n\n```\n{"年份": "2024"}\n```\n\n以上就是结果。', ["年份"]);
  deepEq("外面那些话进不来", noisy, [{ name: "年份", text: "2024" }]);

  // 提不出来就退回原文 —— 产出没按规矩交(那一步本来就失败了)、或者交的不是对象。
  eq("交的不是对象 → 退回原文", outputRowsOf("我觉得大概是 2024 年吧", ["年份"]), null);
  eq("交的是数组 → 也退回原文", outputRowsOf("[1, 2, 3]", ["年份"]), null);

  // 值不是字符串时不能渲染成 `[object Object]`。
  eq(
    "值是数组就铺开成文本",
    outputRowsOf('{"清单": ["a", "b"]}', ["清单"])?.[0]?.text,
    '[\n  "a",\n  "b"\n]',
  );
  eq("值缺席时给空串,不给 undefined", outputRowsOf('{"年份": null}', ["年份"])?.[0]?.text, "");

  // **`keys` 里不该出现清单声明的 `outputs`**(2026-09-19)。
  //
  // 「插入变量」菜单列的是"下游能写什么"(`referenceableOutputsOf` = 用户定的 + 清单
  // 声明的 + 分支的「出路」),而卡片这份名单回答的是**另一个问题**:"要模型交什么"
  // (`outputVarsFor` = 用户定的 + 出路,见 `runner.ts` 的 `outputKeys`)。
  //
  // 把清单声明的并进来会**当场坏掉**:三个模型类型的清单都声明了 `summary`,而模型
  // 照提示词交出来的是 `{"年份": "2024"}`(它没有 `summary` 这个键),`checkOutput`
  // 一看少一样就判失败 —— 于是卡片**退回原文**,正好是用户说过不要看见的那一坨。
  // 这条断言钉住"卡片这份名单是窄的那份"。
  eq(
    "名单里混进清单声明的 summary → 退回原文(所以它不该混进来)",
    outputRowsOf('{"年份": "2024"}', ["summary", "年份"]),
    null,
  );
  eq(
    "只要模型真交的那几样 → 照常逐项摆",
    outputRowsOf('{"年份": "2024"}', ["年份"])?.[0]?.text,
    "2024",
  );
}

// ── 11. 岔路口那张卡:一张,更新两次 ──────────────────────────────────────
//
// `workflow.node.choice` 会来**两次**:第一次没带 `chosen`(在等),第二次带上(选完了)。
// 渲染端必须认出原来那张**换掉**它 —— 追加的话对话里会出现两个格子说同一件事,其中
// 一个还摆着已经点过的按钮,而用户会去点它。
//
// 认的是 **`runId + nodeId + attempt`**:节点 id 在同一张图里每一轮都一样,只看 `nodeId`
// 的话,第二次运行时会把**上一轮那张旧卡**改掉;少了 `attempt` 的话,回头绕第二圈时会把
// **同一次运行的第一轮那张**改掉 —— 两种现象都是"一张早就点过的卡突然变了内容"。
console.log("\n[11] branch choice card: 一张卡更新两次,但每一轮是另一张");
{
  seed([mkSession("conv2")], { total: 1 });
  const SID = "conv2";
  const options = [
    { id: "e_F__B", label: "再来一轮", next: "写作②" },
    { id: "e_F__C", label: "进查重", next: "查重" },
  ];
  const choiceCards = (): Array<{
    chosen?: string;
    comment?: string;
    runId: string;
    nodeId: string;
    attempt: number;
    /** 「运行前先问我」那一问才有(见 `Block` 里那个字段)。 */
    ask?: boolean;
  }> =>
    (useSessionStore.getState().messagesBySession[SID] ?? [])
      .flatMap((m) => m.blocks)
      .filter((b) => b.kind === "workflow-branch-choice") as never;
  /** 按 (哪次运行, 哪个岔路口, 第几轮) 找那一张 —— 回头之后光靠 nodeId 认不出是谁。 */
  const cardOf = (
    runId: string,
    nodeId: string,
    attempt: number,
  ): { chosen?: string; comment?: string; ask?: boolean } | undefined =>
    choiceCards().find((c) => c.runId === runId && c.nodeId === nodeId && c.attempt === attempt);

  useSessionStore.getState().ingestEvent({
    type: "workflow.node.choice",
    sessionId: SID,
    runId: "run1",
    nodeId: "nF",
    nodeType: "mcode.branch",
    title: "下一步做什么",
    attempt: 1,
    options,
  });
  eq("第一张卡出现了", choiceCards().length, 1);
  eq("还没选", choiceCards()[0]?.chosen, undefined);

  useSessionStore.getState().ingestEvent({
    type: "workflow.node.choice",
    sessionId: SID,
    runId: "run1",
    nodeId: "nF",
    nodeType: "mcode.branch",
    title: "下一步做什么",
    attempt: 1,
    options,
    chosen: "e_F__B",
    comment: "第三章太啰嗦",
  });
  eq("★ 换掉原来那张,不是追加", choiceCards().length, 1);
  eq("记下了选的是哪一条", choiceCards()[0]?.chosen, "e_F__B");
  eq("用户临时写的那句也留着", choiceCards()[0]?.comment, "第三章太啰嗦");

  // 同一次运行里另一个分支节点 —— 那是**另一格**,该有自己的卡。
  useSessionStore.getState().ingestEvent({
    type: "workflow.node.choice",
    sessionId: SID,
    runId: "run1",
    nodeId: "nG",
    nodeType: "mcode.branch",
    title: "还有一步",
    attempt: 1,
    options,
  });
  eq("另一个岔路口各自一张", choiceCards().length, 2);

  // **上一轮那张旧卡不能被改写。** runId 不同 = 不是同一次运行 —— 哪怕节点 id 一样。
  useSessionStore.getState().ingestEvent({
    type: "workflow.node.choice",
    sessionId: SID,
    runId: "run2",
    nodeId: "nF",
    nodeType: "mcode.branch",
    title: "下一步做什么",
    attempt: 1,
    options,
  });
  eq("第二次运行是新的一张(旧的留在历史里)", choiceCards().length, 3);
  eq("旧的那张还记着上一轮选了什么", choiceCards()[0]?.chosen, "e_F__B");
  eq("新的那张还没选", choiceCards()[2]?.chosen, undefined);

  // ★ **回头:同一次运行里的第二轮是另一张卡。**
  //
  // 认卡认的是 `runId + nodeId + attempt`。少了 `attempt` 那一位的话,第二轮这张会去
  // 改**第一轮那张** —— 用户看到一个早就点过的卡片忽然变了内容,而他第一轮点的是什么
  // 就此消失,而"上一轮我选了什么"恰恰是他此刻最想回看的。
  const round = (
    attempt: number,
    extra: { chosen?: string } = {},
  ): void => {
    useSessionStore.getState().ingestEvent({
      type: "workflow.node.choice",
      sessionId: SID,
      runId: "run2",
      nodeId: "nF",
      nodeType: "mcode.branch",
      title: "下一步做什么",
      attempt,
      options,
      ...extra,
    });
  };

  round(2);
  eq("★ 第二轮是新的一张(不是改写第一轮那张)", choiceCards().length, 4);
  eq("★ 第一轮那张原样不动", cardOf("run2", "nF", 1)?.chosen, undefined);
  eq("第二轮那张还没选", cardOf("run2", "nF", 2)?.chosen, undefined);

  // 第二轮自己也要走"先等、再选"那两步 —— 换掉的只能是**第二轮**那张。
  round(2, { chosen: "e_F__C" });
  eq("★ 换掉的是第二轮那张(总数不变)", choiceCards().length, 4);
  eq("第二轮记下了它选的", cardOf("run2", "nF", 2)?.chosen, "e_F__C");
  eq("★ 第一轮那张还是没人动过", cardOf("run2", "nF", 1)?.chosen, undefined);

  // ★ **「运行前先问我」那一问:事件上的 `ask` 要原样落进 block。**
  //
  // 弹窗正是靠这一位认出"该我上场了"(见 `AskChoiceDialog` 里找 `ask === true` 的那段)。
  // 它丢在路上的话,那一问就只剩聊天流里一张带按钮的卡 —— 功能还在,但用户很容易压根
  // 没注意到:他当时多半在看别处,而那次运行会**一直停在那儿**等他。
  //
  // 放在这一段**最后**:前面那些断言盯的是张数与下标,这里会多出一张,排前面会把它们
  // 全带偏。
  useSessionStore.getState().ingestEvent({
    type: "workflow.node.choice",
    sessionId: SID,
    runId: "run3",
    nodeId: "nAsk",
    nodeType: "mcode.conversation",
    title: "按上面的结果写第三章",
    attempt: 1,
    ask: true,
    options: [{ id: "__ask_run__", label: "用这一步的指令", input: "补充说明", next: "照常跑这一步" }],
  });
  const askCard = choiceCards().find((c) => c.nodeId === "nAsk");
  check("★ 这一问也有一张卡(它是记录)", askCard !== undefined);
  eq("★ 而且带着 ask 这一位(弹窗靠它认出自己)", askCard?.ask, true);
  // 反证:边上的岔路**不带**这一位 —— 两条路走的是两个界面(卡 / 弹窗)。
  eq("岔路不带 ask", cardOf("run1", "nF", 1)?.ask, undefined);
}

// ── 12. 「有几处岔路口在等人」—— 输入框靠它决定锁不锁 ────────────────────
//
// 用户的原话:「我无法发送消息了,提示这个工作流还在跑」。根因是图停在岔路口等人的
// 时候 `runningBySession` 仍为真(那一轮没收尾),于是输入框被当成"忙" —— 敲回车只是
// 把话**排队**,而队列要等 `turn.done` 才排空,可那张图正等着他点、永远不会自己收尾。
//
// 而那个时刻**整张图唯一在做的事就是等他**,算成"忙"是不诚实的。所以 `ChatPane` 拿这个
// 计数把 `sessionBusy` 放开。这里钉两件事:**加一/减一配得平**,以及**两处岔路口同时
// 在等时是 2 不是 1**(布尔会漏掉后者)。
console.log("\n[12] waiting branches counter: 图停着等人的时候输入框不该锁");
{
  seed([mkSession("conv3")], { total: 1 });
  const SID = "conv3";
  const options = [
    { id: "e_A__1", label: "走这条", next: "一" },
    { id: "e_A__2", label: "走那条", next: "二" },
  ];
  const waiting = (): number => useSessionStore.getState().waitingBranchesBySession[SID] ?? 0;
  const choice = (nodeId: string, extra: { chosen?: string } = {}): void => {
    useSessionStore.getState().ingestEvent({
      type: "workflow.node.choice",
      sessionId: SID,
      runId: "runW",
      nodeId,
      nodeType: "mcode.branch",
      title: nodeId,
      attempt: 1,
      options,
      ...extra,
    });
  };

  eq("一开始没有人在等", waiting(), 0);
  choice("nA");
  eq("★ 一处岔路口挂起 → 1(输入框该放开)", waiting(), 1);
  choice("nA", { chosen: "e_A__1" });
  eq("★ 答完了 → 回到 0(输入框该锁回去)", waiting(), 0);

  // ★ 两处岔路口可以**同时**就绪(它们互不依赖),于是两条都在等人。布尔会把这里
  //   答成 1,答完第一处就以为没人等了。
  choice("nA");
  choice("nB");
  eq("★ 两处同时在等 → 2,不是 1", waiting(), 2);
  choice("nA", { chosen: "e_A__1" });
  eq("答掉一处还剩一处", waiting(), 1);

  // 兜底:配对失败(另一台设备点过了、只收到后一半)时夹到 0,不能是负数。
  choice("nB", { chosen: "e_A__2" });
  choice("nB", { chosen: "e_A__2" });
  eq("多减一次也不会变成负数", waiting(), 0);

  // 这一轮收尾 —— 就算卡片上还写着"在等",那个等待也跟着这次运行一起结束了。
  choice("nA");
  eq("又挂上一处", waiting(), 1);
  useSessionStore.getState().ingestEvent({
    type: "turn.done",
    sessionId: SID,
    reason: "end_turn",
    endedAt: Date.now(),
  });
  eq("★ 一轮收尾 → 清零", waiting(), 0);
}

// ── 13. ingestEvent:独立状态切片 ───────────────────────────────────────────
//
// 这个 suite 原先**只走 `session.changed` 一条路径**。而 `ingestEvent` 是个 30 分支的
// 事件分派器(1458 行),其余分支一条断言都没有 —— 那意味着"改它"没有任何安全网。
//
// 这一节起补上覆盖,目标选的是**自包含、纯状态、不看时序**的那些分支:给一个事件、
// 断言状态变成什么,不需要等 rAF、不需要 mock 流。时序敏感的那几条(text.delta 的
// 合并、turn.done 的收尾)另立一节,它们要的顺序保证多一些。
console.log("\n[13] ingestEvent:todo.update 整份替换");
{
  seed([mkSession("conv4")], { total: 1 });
  const SID = "conv4";
  const todos = (): unknown => useSessionStore.getState().todosBySession[SID];

  eq("一开始没有待办", todos(), undefined);

  const first = [
    { content: "第一步", status: "pending" as const, priority: "high" as const },
    { content: "第二步", status: "in_progress" as const, priority: "medium" as const },
  ];
  useSessionStore.getState().ingestEvent({ type: "todo.update", sessionId: SID, todos: first });
  deepEq("派一次 → 整份记下", todos(), first);

  // **REPLACE 语义,不是合并**:第二次给一份短的,原来那两条不该留痕。
  // (合并语义下"删掉一条待办"就永远办不到 —— 少给一条会被当成"没提到"。)
  const second = [{ content: "只剩这一条", status: "completed" as const, priority: "low" as const }];
  useSessionStore.getState().ingestEvent({ type: "todo.update", sessionId: SID, todos: second });
  deepEq("再派一份短的 → 是替换不是合并", todos(), second);

  useSessionStore.getState().ingestEvent({ type: "todo.update", sessionId: SID, todos: [] });
  deepEq("派空数组 → 清空(不是「没变化」)", todos(), []);
}

console.log("\n[14] ingestEvent:turn.rewound 标记那张卡片,但**不删**它");
{
  // 撤销本轮的文件回滚:那张"本轮修改"卡片要**留在流里**并打上 rewound,
  // 而不是消失 —— 用户需要看得见"这一轮被撤了"。卡片靠**路径集合相等**认领。
  seed([mkSession("conv5")], { total: 1 });
  const SID = "conv5";
  const files = [
    { filePath: "D:\\p\\a.ts", kind: "modify" as const, added: 3, removed: 1 },
    { filePath: "D:\\p\\b.ts", kind: "add" as const, added: 9, removed: 0 },
  ];
  // 两张卡片用**不同的路径集合** —— 认领判据是"路径集合相等",两张一样的话
  // 就分不出"标的是这一张还是那一张"了(下面那条"历史那张没动"也就失去意义)。
  const otherFiles = [{ filePath: "D:\\p\\c.ts", kind: "add" as const, added: 1, removed: 0 }];
  const mkTurnFiles = (id: string, isLatestTurn: boolean, fs = files): ChatMessage => ({
    id,
    sessionId: SID,
    role: "assistant",
    createdAt: 1,
    blocks: [{ kind: "turn-files", files: fs, isLatestTurn }] as unknown as ChatMessage["blocks"],
  });

  const blocksOf = (id: string): Array<Record<string, unknown>> => {
    const list = useSessionStore.getState().messagesBySession[SID] ?? [];
    const msg = list.find((m) => m.id === id);
    return (msg?.blocks ?? []) as unknown as Array<Record<string, unknown>>;
  };
  const markRewound = (): void => {
    useSessionStore.setState((s) => ({
      messagesBySession: {
        ...s.messagesBySession,
        [SID]: [mkTurnFiles("m1", true), mkTurnFiles("m2", false, otherFiles)],
      },
      turnFilesBySession: {
        ...s.turnFilesBySession,
        [SID]: files as unknown as TurnFileEntry[],
      },
    }));
  };

  markRewound();
  useSessionStore.getState().ingestEvent({
    type: "turn.rewound",
    sessionId: SID,
    files: files.map((f) => f.filePath),
    targetFiles: files.map((f) => f.filePath),
  });
  eq("最新的那张被标成 rewound", blocksOf("m1")[0]?.["rewound"], true);
  eq("历史那张**没动**(它不是这一轮)", blocksOf("m2")[0]?.["rewound"], undefined);
  eq("卡片还在流里(不是删掉)", (useSessionStore.getState().messagesBySession[SID] ?? []).length, 2);
  deepEq(
    "★ 被撤的是最新那轮 → 本轮文件桶跟着清空",
    useSessionStore.getState().turnFilesBySession[SID],
    [],
  );

  // 路径集合对不上就不该认领 —— 否则会误标一张无关的卡片。
  markRewound();
  useSessionStore.getState().ingestEvent({
    type: "turn.rewound",
    sessionId: SID,
    files: ["D:\\p\\other.ts"],
    targetFiles: ["D:\\p\\other.ts"],
  });
  eq("路径对不上 → 不标记", blocksOf("m1")[0]?.["rewound"], undefined);

  // 历史卡片的回撤**不动**本轮文件桶(那个桶属于更晚的一轮)。
  markRewound();
  useSessionStore.setState((s) => ({
    messagesBySession: { ...s.messagesBySession, [SID]: [mkTurnFiles("m1", false)] },
  }));
  useSessionStore.getState().ingestEvent({
    type: "turn.rewound",
    sessionId: SID,
    files: files.map((f) => f.filePath),
    targetFiles: files.map((f) => f.filePath),
  });
  eq("历史卡片被标记", blocksOf("m1")[0]?.["rewound"], true);
  deepEq(
    "历史卡片回撤 → 本轮文件桶不动",
    useSessionStore.getState().turnFilesBySession[SID],
    files as unknown as TurnFileEntry[],
  );
}

console.log("\n[15] ingestEvent:user.message 追加 / 去重 / 编辑截断");
{
  seed([mkSession("conv6")], { total: 1 });
  const SID = "conv6";
  const list = (): ChatMessage[] => useSessionStore.getState().messagesBySession[SID] ?? [];
  const userMsg = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
    type: "user.message" as const,
    sessionId: SID,
    messageId: id,
    blocks: [{ kind: "text", text }] as never,
    createdAt: 1,
    ...extra,
  });

  useSessionStore.getState().ingestEvent(userMsg("u1", "第一句"));
  eq("派一条 → 追加", list().length, 1);
  eq("内容对", (list()[0]?.blocks?.[0] as { text?: string } | undefined)?.text, "第一句");
  eq("角色是 user", list()[0]?.role, "user");

  // **自己发的那条会被回显** —— 发起方早就乐观追加过一遍了,再追加就是两条。
  // (手机端 / 另一个窗口共用这条路径。)
  useSessionStore.getState().ingestEvent(userMsg("u1", "第一句"));
  eq("★ 自己那条回显 → 不重复追加", list().length, 1);

  useSessionStore.getState().ingestEvent(userMsg("u2", "第二句"));
  useSessionStore.getState().ingestEvent(userMsg("u3", "第三句"));
  eq("继续追加", list().length, 3);

  // **跨端编辑**:别的设备把 u2 改了重发。它会带**新的 messageId**(编辑产生新消息),
  // 外加 `editedMessageId: "u2"` 指明"我替代的是哪一条"。收到端的陈旧尾巴
  // (旧的 u2 及其之后的 u3)必须在追加前砍掉。
  //
  // 不砍的话:另一台设备内存里留着旧 u2 + u3(以及它们的回复),它自己下一次
  // turn.done 会把这段陈旧尾巴重新落库 —— 再次打开会话就看到重复。
  useSessionStore.getState().ingestEvent(userMsg("u2b", "第二句(改过)", { editedMessageId: "u2" }));
  const after = list();
  eq("★ 编辑重发 → 截到被改的那条", after.length, 2);
  eq("被改的那条是新的内容", (after[1]?.blocks?.[0] as { text?: string } | undefined)?.text, "第二句(改过)");
  eq("后面那条被截掉了", after.some((m) => m.id === "u3"), false);

  // 编辑一个**本地没有**的 id(还没加载到 / 已被截断)→ 退回普通追加,不炸也不清空。
  useSessionStore.getState().ingestEvent(userMsg("u9", "全新", { editedMessageId: "不在场的id" }));
  eq("编辑目标不在场 → 当普通追加", list().length, 3);
}

// ── 14. ingestEvent:时序敏感的那几条 ───────────────────────────────────────
//
// 上面三条是"给一个事件、断言状态"。这一节的三条不一样:**中间隔着 rAF 缓冲**,
// 断言必须落在正确的时刻上,否则测的是自己的时序而不是产品的。
//
// 这两节包在 `async` IIFE 里 —— 它们要 `await` 一帧,而顶层块里的 `await` 不合法。
console.log("\n[16] ingestEvent:text.delta 经 rAF 缓冲后落到消息上");
await (async () => {
  seed([mkSession("conv7")], { total: 1 });
  const SID = "conv7";
  const list = (): ChatMessage[] => useSessionStore.getState().messagesBySession[SID] ?? [];
  const textOf = (): string =>
    (list()[0]?.blocks?.[0] as { text?: string } | undefined)?.text ?? "";

  useSessionStore.getState().ingestEvent({
    type: "text.delta",
    sessionId: SID,
    messageId: "m-delta",
    text: "你好",
  });
  // **缓冲还没落地** —— 这是 rAF 批处理的全部意义(一帧一次 setState,而不是一个字一次)。
  // 不钉这一条的话,"缓冲还在"和"缓冲丢了"在断言上长得一模一样。
  eq("★ 派完之后还没落地(攒在 rAF 缓冲里)", list().length, 0);

  // 等一帧。prelude 把 requestAnimationFrame 接成了 setTimeout(…, 16)。
  await new Promise((r) => setTimeout(r, 60));
  eq("一帧之后落地", list().length, 1);
  eq("内容拼起来了", textOf(), "你好");
})();

console.log("\n[17] ingestEvent:tool.use 之前先冲刷缓冲的叙述文本");
await (async () => {
  // 工具卡必须落在**它前面那段叙述之后**。缓冲没冲的话,无 messageId 的工具会挂到
  // 更早的消息上,而缓冲的叙述稍后才materialize —— 中间面板会把那段叙述误判成
  // "最终回复"并从过程区漏出去。
  seed([mkSession("conv8")], { total: 1 });
  const SID = "conv8";
  const list = (): ChatMessage[] => useSessionStore.getState().messagesBySession[SID] ?? [];

  useSessionStore.getState().ingestEvent({
    type: "text.delta",
    sessionId: SID,
    messageId: "m-narrate",
    text: "我先看一下文件。",
  });
  useSessionStore.getState().ingestEvent({
    type: "tool.use",
    sessionId: SID,
    toolCallId: "tu-1",
    toolName: "Read",
    input: { file_path: "a.ts" },
    requiresApproval: false,
  });

  const after = list();
  eq("★ tool.use 一来就把缓冲冲了(不是等一帧)", after.length >= 1, true);
  const allText = after.flatMap((m) => m.blocks).filter((b) => b.kind === "text");
  eq("叙述文本没有丢", allText.length, 1);
  eq("叙述内容是完整的", (allText[0] as { text?: string } | undefined)?.text, "我先看一下文件。");
})();

console.log("\n[18] ingestEvent:turn.done 收尾一个回合");
await (async () => {
  // 一轮结束时要把几样"这一轮的东西"收干净。这些是用户看得见的行为:
  // 待审批卡片要消失、还挂着"running"的工具卡要标成完成、等着的岔路口要清零。
  seed([mkSession("conv9")], { total: 1 });
  const SID = "conv9";
  const st = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState();

  // 摆好"这一轮正在进行"的样子:一张还跑着的工具卡 + 一处待审批 + 一处等着的岔路口。
  useSessionStore.setState((s) => ({
    messagesBySession: {
      ...s.messagesBySession,
      [SID]: [
        {
          id: "m-tool",
          sessionId: SID,
          role: "assistant",
          createdAt: 1,
          blocks: [{ kind: "tool_use", toolUseId: "tu-1", name: "Bash", status: "running" }],
        } as unknown as ChatMessage,
      ],
    },
    pendingApprovals: [
      { sessionId: SID, requestId: "r1", toolName: "Bash" },
      { sessionId: "别的会话", requestId: "r2", toolName: "Read" },
    ] as unknown as ReturnType<typeof st>["pendingApprovals"],
    waitingBranchesBySession: { ...s.waitingBranchesBySession, [SID]: 2 },
    runningTurnStartedAt: { ...s.runningTurnStartedAt, [SID]: 1 },
  }));

  eq("摆好了:两处待审批", st().pendingApprovals.length, 2);
  eq("摆好了:两处在等", st().waitingBranchesBySession[SID], 2);

  st().ingestEvent({ type: "turn.done", sessionId: SID, reason: "end_turn", endedAt: 999 });

  eq("★ 本会话的待审批被清掉", st().pendingApprovals.filter((p) => p.sessionId === SID).length, 0);
  eq("别的会话的待审批**没动**", st().pendingApprovals.filter((p) => p.sessionId === "别的会话").length, 1);
  eq("★ 等着的岔路口清零(兜底 —— 配对失败时它必须归零)", st().waitingBranchesBySession[SID], 0);
  eq("这一轮的计时锚点被清掉", st().runningTurnStartedAt[SID], undefined);

  const blocks = (st().messagesBySession[SID] ?? [])[0]?.blocks ?? [];
  const tool = blocks.find((b) => b.kind === "tool_use") as { status?: string; result?: string } | undefined;
  // 回合结束了却没有配对的 tool.result(计划模式 / 被中断)—— 那张卡不能永远转圈。
  eq("★ 还跑着的工具卡被标成 done", tool?.status, "done");
  check("并且留了一句说明(不是空着)", typeof tool?.result === "string" && tool.result.length > 0, tool?.result);
})();

console.log("\n[19] 失败回合：错误事件与 turn.done 不应重复报完成");
{
  const SID = "failed-turn-toast";
  seed([mkSession(SID)], { total: 1 });
  useSessionStore.setState({ isWindowFocused: true });
  useToastStore.getState().clear();
  const store = useSessionStore.getState();
  store.ingestEvent({ type: "error", sessionId: SID, message: "Pi 上游连接失败" });
  const afterError = useToastStore.getState().toasts;
  eq("错误先弹一条 toast", afterError.length, 1);
  eq("提示为错误，不是完成", afterError[0]?.kind, "error");
  check("用户能看到错误原因", afterError[0]?.body?.includes("连接失败") === true, afterError);
  eq("错误产生一次未读", useSessionStore.getState().unreadBySession[SID], 1);

  store.ingestEvent({ type: "turn.done", sessionId: SID, reason: "error", endedAt: Date.now() });
  eq("失败回合不再弹完成 toast", useToastStore.getState().toasts.length, 1);
  eq("失败回合不重复累计未读", useSessionStore.getState().unreadBySession[SID], 1);
  eq("失败标记仍然保留", useSessionStore.getState().turnErrorBySession[SID], true);

  // A genuine successful turn should still notify once; do not silence all turn.done events.
  const OK = "successful-turn-toast";
  seed([mkSession(OK)], { total: 1 });
  useToastStore.getState().clear();
  store.ingestEvent({ type: "turn.done", sessionId: OK, reason: "end_turn", endedAt: Date.now() });
  eq("成功回合仍弹一条 toast", useToastStore.getState().toasts.length, 1);
  eq("成功提示保持 info", useToastStore.getState().toasts[0]?.kind, "info");

  const LIMITED = "length-limited-turn-toast";
  seed([mkSession(LIMITED)], { total: 1 });
  useToastStore.getState().clear();
  store.ingestEvent({ type: "turn.done", sessionId: LIMITED, reason: "max_tokens", endedAt: Date.now() });
  const limitedToasts = useToastStore.getState().toasts;
  eq("长度截断仍然提醒用户", limitedToasts.length, 1);
  eq("长度截断用 warning 而非普通完成提示", limitedToasts[0]?.kind, "warning");
  check("截断提示不能说任务已完成", !/(回合完成|Turn complete|已完成|finished)/i.test(
    `${limitedToasts[0]?.title} ${limitedToasts[0]?.body}`,
  ), limitedToasts);
  eq("截断回合仍计一次未读", useSessionStore.getState().unreadBySession[LIMITED], 1);
  useToastStore.getState().clear();
}

console.log("\n[20] 外部投递草稿：deliverComposerDraft 递增 touch，quoteIntoComposer 追加 tag");

// 2026-09-24 的根因修复：外部在目标会话**开着**时写草稿，旧代码看不见
// （草稿还原 effect 只依赖 sessionId）。现在 deliverComposerDraft 递增
// composerDraftTouchBySession，挂载中的 ChatPane 订阅它、当场重跑还原。
// 这里验 store 层的三件事：touch 递增、save 不递增、quoteIntoComposer 追加。
void (async () => {
  const st = useSessionStore;
  const SID = "投递草稿-会话";
  try {
    // save（write-through）：写草稿但**不**碰 touch。
    st.getState().saveComposerDraft(SID, { text: "打了一半", html: "", tags: [] });
    eq("saveComposerDraft 落了草稿", st.getState().composerDraftBySession[SID]?.text, "打了一半");
    eq("…但 touch 没动（write-through 不触发重还原）", st.getState().composerDraftTouchBySession[SID], undefined);

    // deliver（外部投递）：写草稿 + touch 递增。
    st.getState().deliverComposerDraft(SID, { text: "打了一半", html: "", tags: [{ id: "t1", kind: "paste", preview: "p", content: "c" }] });
    eq("deliverComposerDraft 更新了草稿", st.getState().composerDraftBySession[SID]?.tags.length, 1);
    eq("★ touch 递增了（开着的输入框靠它当场重跑还原）", st.getState().composerDraftTouchBySession[SID], 1);
    st.getState().deliverComposerDraft(SID, { text: "打了一半", html: "", tags: [] });
    eq("再投递一次 touch 再 +1（不是置 1）", st.getState().composerDraftTouchBySession[SID], 2);

    // quoteIntoComposer：在现有草稿上**追加**，不覆盖。
    st.getState().quoteIntoComposer(SID, { id: "q1", kind: "quote", preview: "引", content: "--- user's quote (…) ---\nsource: x\n--- end ---" });
    const draft = st.getState().composerDraftBySession[SID];
    eq("quoteIntoComposer 追加了一条 quote tag", draft?.tags.length, 1);
    eq("…正文保留不动", draft?.text, "打了一半");
    eq("…quote 的 kind 对", draft?.tags[0]?.kind, "quote");

    // 空会话：没有草稿也能落。
    st.getState().quoteIntoComposer("空会话", { id: "q2", kind: "quote", preview: "引2", content: "c" });
    eq("空会话也能 quote 进来（text 为空串）", st.getState().composerDraftBySession["空会话"]?.text, "");
    // ★ quote 必须走 deliver（带 touch），不是普通 save —— 漏了 touch，开着的
    //   输入框就看不见（恰是这轮要修的 bug）。
    eq("★ quoteIntoComposer 也递增 touch", st.getState().composerDraftTouchBySession["空会话"], 1);
  } finally {
    useSessionStore.setState((s) => {
      const drafts = { ...s.composerDraftBySession };
      delete drafts[SID];
      delete drafts["空会话"];
      const touches = { ...s.composerDraftTouchBySession };
      delete touches[SID];
      return { composerDraftBySession: drafts, composerDraftTouchBySession: touches };
    });
  }
})();

console.log("\n[21] 自定义模型失效：手机 RPC / 桌面 IPC 拒绝也要显示原因,与事件去重");
await (async () => {
  const SID = "custom-model-send-rejected";
  const message = "所选自定义模型配置已删除或不存在。本次未发送到默认端点；请在“自定义模型”设置中修复配置或改选模型后重试。";
  const store = useSessionStore;
  seed([mkSession(SID, { model: "smoke-model", customModelId: "deleted-config" })]);
  store.setState((s) => ({
    activeSessionId: SID, model: "smoke-model", customModelId: "deleted-config", providerId: "claude-sdk",
    messagesBySession: { ...s.messagesBySession, [SID]: [] },
    runningBySession: { ...s.runningBySession, [SID]: false },
    turnErrorBySession: { ...s.turnErrorBySession, [SID]: false },
  }));
  useToastStore.getState().clear();
  const errors = (): string[] => (store.getState().messagesBySession[SID] ?? [])
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "error")
    .map((b) => b.message);
  const flushRpc = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  try {
    // 手机端 SSE 暂时断开:RPC 返回了明确错误,不能只 console.error。
    setSendTurnStub(async () => { throw new Error(message); });
    eq("拒绝前用户消息仍被接受", await store.getState().sendPrompt("第一问"), true);
    await flushRpc();
    deepEq("★ 没有 SSE 时聊天记录显示失败原因", errors(), [message]);
    eq("活跃聊天直接显示错误,不叠加 toast", useToastStore.getState().toasts.length, 0);
    eq("失败之后输入框解锁", store.getState().runningBySession[SID], false);
    eq("侧栏明确标记失败", store.getState().turnErrorBySession[SID], true);

    // RPC 先报错,SSE 后追上:同一轮不能出现两条错误气泡 / toast。
    store.getState().ingestEvent({ type: "error", sessionId: SID, message, code: "custom_model_unavailable" });
    deepEq("★ 迟到的 SSE 不重复加错误气泡", errors(), [message]);
    eq("迟到的 SSE 不额外弹 toast", useToastStore.getState().toasts.length, 0);

    // 真正的新一轮同样失败,却必须再次提示。桌面 IPC 的异常可能带前缀。
    setSendTurnStub(async () => { throw new Error(`Error invoking remote method 'claude:sendTurn': Error: ${message}`); });
    useToastStore.getState().clear();
    eq("改天再试仍能发送", await store.getState().sendPrompt("第二问"), true);
    await flushRpc();
    deepEq("★ 下一轮仍显示失败,且不显示 IPC 内部前缀", errors(), [message, message]);
    eq("下一轮活跃聊天仍不额外弹 toast", useToastStore.getState().toasts.length, 0);

    // SSE 先到、RPC 后报错:另一种时序也只能报一次。
    setSendTurnStub(async () => {
      store.getState().ingestEvent({ type: "error", sessionId: SID, message, code: "custom_model_unavailable" });
      throw new Error(message);
    });
    useToastStore.getState().clear();
    eq("再次尝试仍能发送", await store.getState().sendPrompt("第三问"), true);
    await flushRpc();
    deepEq("★ 先到 SSE 时 RPC 不重复报错", errors(), [message, message, message]);
    eq("先到 SSE 时活跃聊天不弹 toast", useToastStore.getState().toasts.length, 0);

    // 编辑重发也走同一条后台 RPC 路径,不能悄悄吞掉失败。
    setSendTurnStub(async () => { throw new Error(message); });
    const firstUser = store.getState().messagesBySession[SID]?.find((m) => m.role === "user");
    if (!firstUser) throw new Error("smoke: missing editable user message");
    await store.getState().editAndResendMessage(SID, firstUser.id, "修改第一问");
    await flushRpc();
    deepEq("★ 编辑重发失败也显示原因", errors(), [message]);
    eq("编辑重发释放运行标志", store.getState().runningBySession[SID], false);

    // 背景会话不在屏幕上,这里不是靠聊天气泡而是靠 toast + 未读提醒。
    const BG = "custom-model-send-rejected-background";
    seed([mkSession(BG, { model: "smoke-model", customModelId: "deleted-config" })]);
    store.setState({ model: "smoke-model", customModelId: "deleted-config", providerId: "claude-sdk" });
    useToastStore.getState().clear();
    eq("背景会话接受消息", await store.getState().sendPrompt("后台发送", undefined, undefined,
      undefined, undefined, undefined, BG), true);
    await flushRpc();
    eq("★ 背景会话也弹出失败原因", useToastStore.getState().toasts[0]?.body, message);
    store.getState().ingestEvent({ type: "error", sessionId: BG, message, code: "custom_model_unavailable" });
    eq("背景会话迟到事件也不重复弹窗", useToastStore.getState().toasts.length, 1);
  } finally {
    setSendTurnStub(null);
    useToastStore.getState().clear();
  }
})();

console.log("\n[22] 非自定义模型的发送拒绝也要显示;自动落到下一个会话要同步引擎");
await (async () => {
  const store = useSessionStore;
  const SID = "generic-send-rejected";
  seed([mkSession(SID, { model: "sonnet" })]);
  store.setState((s) => ({
    activeSessionId: SID, model: "sonnet", customModelId: null, providerId: "claude-sdk",
    messagesBySession: { ...s.messagesBySession, [SID]: [] },
    runningBySession: { ...s.runningBySession, [SID]: false },
  }));
  const errors = (): string[] => (store.getState().messagesBySession[SID] ?? [])
    .flatMap((m) => m.blocks)
    .filter((b) => b.kind === "error")
    .map((b) => b.message);
  const flushRpc = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  try {
    // 主进程专门写给用户看的拒绝(上一轮还在收尾 / 工作流还在跑……)原先只进 console。
    const busy = "这个对话上一轮还在运行，消息未发送：请等本轮结束或按停止后再发";
    setSendTurnStub(async () => { throw new Error(`Error invoking remote method 'claude:sendTurn': Error: ${busy}`); });
    eq("被拒绝前消息仍被接受", await store.getState().sendPrompt("排队消息"), true);
    await flushRpc();
    deepEq("★ 写给用户的拒绝原因显示在对话里", errors(), [`消息未发送：${busy}`]);
    eq("拒绝后输入框解锁", store.getState().runningBySession[SID], false);
    // 内部异常(英文 / 堆栈)不把细节摆到界面上,只给通用说明。
    setSendTurnStub(async () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); });
    eq("再次发送仍被接受", await store.getState().sendPrompt("再来一次"), true);
    await flushRpc();
    eq("★ 内部异常只给通用说明", errors().at(-1), "消息发送失败，详情见日志");
  } finally {
    setSendTurnStub(null);
    useToastStore.getState().clear();
  }

  // 关掉当前标签自动落到另一个会话:引擎要跟着那个会话走。原先只同步
  // model/effort/permissionMode/customModelId,providerId 停在上一个会话上。
  const CODEX = "land-codex";
  const CLAUDE = "land-claude";
  seed([
    mkSession(CODEX, { providerId: "codex-sdk", model: "gpt-5-codex" }),
    mkSession(CLAUDE, { providerId: "claude-sdk", model: "sonnet" }),
  ]);
  store.setState({ openTabs: [CLAUDE, CODEX], activeSessionId: CODEX, providerId: "codex-sdk", model: "gpt-5-codex" });
  store.getState().closeTab(CODEX);
  eq("关标签落到左侧标签", store.getState().activeSessionId, CLAUDE);
  eq("★ 关标签后引擎跟着落到的会话走", store.getState().providerId, "claude-sdk");
  eq("关标签后模型跟着走", store.getState().model, "sonnet");

  // 别的端删掉当前会话(session.deleted 事件)同理。
  seed([
    mkSession(CODEX, { providerId: "codex-sdk", model: "gpt-5-codex" }),
    mkSession(CLAUDE, { providerId: "claude-sdk", model: "sonnet" }),
  ]);
  store.setState({ openTabs: [CODEX, CLAUDE], activeSessionId: CLAUDE, providerId: "claude-sdk", model: "sonnet" });
  store.getState().ingestEvent({ type: "session.deleted", sessionId: CLAUDE });
  eq("远端删除后落到剩下的标签", store.getState().activeSessionId, CODEX);
  eq("★ 远端删除后引擎跟着落到的会话走", store.getState().providerId, "codex-sdk");
  eq("远端删除后模型跟着走", store.getState().model, "gpt-5-codex");
})();

console.log("\n[23] 历史读取失败必须让用户看见,保持可重试,成功后恢复");
await (async () => {
  const sid = "history-failed-visible";
  seed([mkSession(sid)]);
  useSessionStore.setState((s) => ({
    locale: "en", activeSessionId: sid,
    messagesBySession: { ...s.messagesBySession, [sid]: [] },
    historyLoadedBySession: { ...s.historyLoadedBySession, [sid]: false },
    loadingMessagesBySession: { ...s.loadingMessagesBySession, [sid]: false },
  }));
  useToastStore.getState().clear();
  try {
    setSessionMessagesStub(async () => { throw new Error("private database path: /secret"); });
    await useSessionStore.getState().prefetchSessionMessages(sid);
    eq("失败后骨架屏关闭", useSessionStore.getState().loadingMessagesBySession[sid], false);
    eq("失败后保留重试机会", useSessionStore.getState().historyLoadedBySession[sid], false);
    eq("★ 活跃会话也有可见错误提示", useToastStore.getState().toasts[0]?.kind, "error");
    eq("提示指向该会话", useToastStore.getState().toasts[0]?.sessionId, sid);
    check("不泄露内部路径", !JSON.stringify(useToastStore.getState().toasts).includes("/secret"));
    setSessionMessagesStub(async () => ({ messages: [], hasMore: false }));
    await useSessionStore.getState().prefetchSessionMessages(sid);
    eq("重试成功后标记已加载", useSessionStore.getState().historyLoadedBySession[sid], true);
    eq("重试不新增错误提示", useToastStore.getState().toasts.length, 1);
  } finally {
    setSessionMessagesStub(null);
    useToastStore.getState().clear();
  }
})();

// FZ16: a completed background task must wake the queue even when there is
// no second parent turn.done. Exercise real ingest/reducer/drain; only send is fake.
{
  const sid = "background-queue";
  const store = useSessionStore;
  const originalSend = store.getState().sendPrompt;
  const sent: Array<string | undefined> = [];
  const a = { taskId: "a", description: "A", status: "running" as const, isBackgrounded: true };
  const b = { taskId: "b", description: "B", status: "running" as const, isBackgrounded: true };
  seed([mkSession(sid, { model: "sonnet" })]);
  store.setState({ activeSessionId: sid, model: "sonnet", customModelId: null, providerId: "claude-sdk",
    runningBySession: { [sid]: false }, interruptedBySession: {}, subagentsBySession: { [sid]: [a, b] },
    promptQueueBySession: { [sid]: [{ id: "one", prompt: "one", displayText: "one" }, { id: "two", prompt: "two", displayText: "two" }] },
    sendPrompt: async (...args) => {
      sent.push(args[6]);
      store.setState({ runningBySession: { [sid]: true } });
      return true;
    },
  });
  try {
    store.getState().ingestEvent({ type: "subagent.update", sessionId: sid, agents: [{ ...a, status: "completed" }, b] });
    eq("queue stays blocked while another background task runs", sent.length, 0);
    store.getState().ingestEvent({ type: "subagent.update", sessionId: sid, agents: [{ ...a, status: "completed" }, { ...b, status: "completed" }] });
    eq("last background completion wakes one queued message", sent.length, 1);
    eq("wake targets the queue's owning session", sent[0], sid);
    eq("wake consumes only the queue head", store.getState().promptQueueBySession[sid]?.length, 1);
    store.getState().ingestEvent({ type: "subagent.update", sessionId: sid, agents: [] });
    eq("duplicate terminal roster cannot send twice", sent.length, 1);
    store.setState({ subagentsBySession: { [sid]: [a] }, runningBySession: { [sid]: true } });
    store.getState().ingestEvent({ type: "subagent.update", sessionId: sid, agents: [] });
    eq("a live parent turn still blocks queue draining", sent.length, 1);
    store.setState({ subagentsBySession: { [sid]: [a] }, runningBySession: { [sid]: false } });
    store.getState().ingestEvent({ type: "subagent.update", sessionId: sid, agents: [] });
    eq("a roster reset also releases the idle queue", sent.length, 2);
  } finally {
    store.setState({ sendPrompt: originalSend });
    useToastStore.getState().clear();
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
