/**
 * Headless smoke for **同一个对话里,每一格各有各的常驻会话**
 * (`main/orchestration/runner.ts` 的 `nodeSessionOf` + `Session.nodeId`)。
 *
 * ## 为什么要有这一套
 *
 * 用户要的是"三方研究工作台":主模型、子代理、他本人,谁跟谁都能接着说。而"接着说"
 * 的前提是**那一格的对话还在、还认得回来**。
 *
 * 在这之前,每跑一次图,每一个格子都会 `uid("sess_")` **新造**一个会话行:上一趟跟
 * 「润色」说过的话,下一趟就再也找不回来了 —— 库里躺着几十行 `kind='node'`、
 * `parent_session_id` 相同、彼此**完全无法区分**的行(没有哪一列说得出它是图上哪一格)。
 * 于是"常驻"这个词在库层面根本不成立。
 *
 * 这一套钉的就是它:**(哪个对话, 图上哪一格) → 一个会话**,而那个键必须扛得住
 * 改标题、挪位置、连边。
 *
 * ## 钉住的六条
 *
 * 1. **同一格连跑两次,认回同一个会话**(不是又造一个);
 * 2. **同一张图里两格各是各的会话**(不能共用一个 —— 那两段对话会串在一起);
 * 3. **同一个节点 id 挂在不同对话下也是两个会话**(键是二元组,不是单看节点 id);
 * 4. **改标题 / 挪位置 / 连边之后照样认回来**(键是节点 id,建图时就定了);
 * 5. **列得出来,而且只列得出这个对话的**(`session.listNodes` 这条 IPC 的落点);
 * 6. **节点会话不许漏进左边栏**(所有别的列表查询都钉 `kind = 'chat'`)——
 *    这条是"列得出来"的**反面**:新开了一个出口,就得证明老出口没跟着漏。
 *
 * ## 为什么能无头跑、假的是哪一半
 *
 * 同 `node-live-smoke`:**引擎那一侧是假的**(真的 RuntimeManager 一 `bindSession` 就会
 * 把三家引擎实现和每个的 MCP 工具表全拉起来)。被测的 `startWorkflowRun` 是真的 ——
 * 这一套读的是真代码写出来的行,不是抄本。
 *
 * ⚠️ 数据根指向 `mktemp -d` 建的目录(run.sh 里,跑完就删)。这一套**真的建库、真的写会话行**,
 * 指错了就是拿空库盖掉用户的聊天记录。
 *
 * Run: scripts/node-session-smoke/run.sh
 */
import "./stubs/prelude.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ── 数据根必须在**任何** `@main/*` 被 import 之前钉好 ── */
const DATA = mkdtempSync(join(tmpdir(), "mcode-node-session-data-"));
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

/* ── 被测的真模块 + 夹具(动态 import:数据根要先生效) ── */

const { initDb } = await import("@main/store/db.js");
const { ProjectRepo, SessionRepo, WorkflowRepo, WorkflowRunRepo, SettingRepo } = await import("@main/store/repositories.js");
/**
 * ⚠️ **命名空间导入,不是具名导入。** 具名的写法在实现被撤掉时会变成 esbuild 的
 * "No matching export" —— 那是**打包失败**,不是断言失败,拿不到"红"那一份可读的
 * 输出(而"撤掉实现看它真红"要的正是那一份)。
 */
const runner = await import("@main/orchestration/runner.js");
const { startWorkflowRun, cancelWorkflowRun } = runner;
const { decodeSnapshot, saveRun } = await import("@main/orchestration/runStore.js");
const { workflowRevision } = await import("@main/orchestration/workflowTrust.js");
const { getWorkflow } = await import("@main/orchestration/library.js");
const rt = await import("./stubs/runtimeManager.js");
const win = await import("./stubs/window.js");
const { nodeSessionDoc, parentSession, project, WORKFLOW_ID, PARENT, PARENT_B } = await import(
  "./fixtures.js"
);

await initDb();

/** 等条件成立;超时就**认失败**(不静默通过)。时钟是冻住的,所以用桩里的真时钟。 */
async function waitFor(label: string, cond: () => boolean, timeoutMs = 8_000): Promise<boolean> {
  const deadline = rt.realNowMs() + timeoutMs;
  while (rt.realNowMs() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  check(`等到了:${label}`, false, { waitedMs: timeoutMs });
  return false;
}

/**
 * 起一次图,等它**跑完并落盘**,返回这一趟的父会话。
 *
 * ⚠️ **等待条不能是"列表里有两个"。** 第一趟跑完之后库里就留着两行了 —— 拿它当判据
 * 的话,第二趟开局的**第一个 tick 就为真**,于是 `cancelWorkflowRun` 在调度器还没派出
 * 任何东西的时候就叫停了:这一趟什么都没跑,而断言在**上一趟留下的行**上全绿。
 * (这不是假想 —— 变异验证第一轮就是被它挡住的:把复用整段撤掉,一条都不红。)
 *
 * 所以判据落在**这一趟独有的证据**上:运行时的 `bindSession` **调用记录**(见桩里的
 * `bindLog` —— 不能看 `boundSessions` 那个 Set,复用的格子绑的是同一个 id,Set 里早
 * 就有了)。入口那一格跑在主对话里、它早就绑过,所以要排除掉父会话自己。
 *
 * ⚠️ **必须等到 `done` 落地再返回。** `runs.delete(session.id)` 在 `finally` 里,而
 * "这个对话里还有没有一次在跑"正是下一趟能不能起得来的前提 —— 不等的话第二次
 * `startWorkflowRun` 会撞上那一条、静静地什么都不做。
 *
 * 两个格子都是 `mcode.agent`:它们**不** `finishTurn`(会话是常驻的),所以整张图会
 * 停在最后那一步上等。这一套要的不是"跑出结果",而是"会话行被建出来了" —— 等两格都
 * 绑上运行时之后取消,让 `done` 落地。
 */
async function runGraph(sessionId: string): Promise<void> {
  const from = rt.bindLog.length;
  const done = startWorkflowRun({
    session: SessionRepo.get(sessionId)!,
    prompt: "把这两个活儿分头做掉。",
    cwd: process.cwd(),
  });
  await waitFor(
    `${sessionId} 这一趟的两个格子都起来了`,
    () => rt.bindLog.slice(from).filter((id) => id !== sessionId).length >= 2,
  );
  cancelWorkflowRun(sessionId);
  await done;
}

/** 按节点 id 找那一格的会话。找不到返回 undefined(断言会看见)。 */
function nodeSessionOf(sessionId: string, nodeId: string) {
  return SessionRepo.findNodeByNodeId(sessionId, nodeId);
}

/* ──────────────── 夹具 ──────────────── */

console.log("node-session-smoke —— 同一个对话里,每一格各有各的常驻会话\n");

WorkflowRepo.save(nodeSessionDoc());
ProjectRepo.create(project());
SessionRepo.create(parentSession(PARENT));
SessionRepo.create(parentSession(PARENT_B));

/* ──────────────── 1. 第一趟:两格各建一个会话 ──────────────── */

await runGraph(PARENT);

const a1 = nodeSessionOf(PARENT, "agentA");
const b1 = nodeSessionOf(PARENT, "agentB");

check("第一趟跑完,入口那一格**没有**自己的会话(它跑在主对话里)", nodeSessionOf(PARENT, "entry") === undefined, {
  entry: nodeSessionOf(PARENT, "entry")?.id,
});
check("「查引用」那一格有自己的会话", a1 !== undefined, { id: a1?.id });
check("「润色」那一格有自己的会话", b1 !== undefined, { id: b1?.id });
check(
  "同一张图里两格**各是各的会话**(不能共用一个 —— 那两段对话会串在一起)",
  a1 !== undefined && b1 !== undefined && a1.id !== b1.id,
  { a: a1?.id, b: b1?.id },
);
eq("会话行的 `nodeId` 记的就是图上的节点 id", a1?.nodeId, "agentA");
eq("这两行挂在同一个对话下", a1?.parentSessionId, PARENT);
eq("它们的 `kind` 是 `node`", a1?.kind, "node");
check("标题取的是**图上的格子名**(排查时要能认出是哪一步)", a1?.title === "查引用", {
  title: a1?.title,
});

/* ──────────────── 2. 第二趟:认回来,不是又造一个 ──────────────── */

await runGraph(PARENT);

{
  const a2 = nodeSessionOf(PARENT, "agentA");
  const b2 = nodeSessionOf(PARENT, "agentB");
  eq("再跑一趟,「查引用」认回**同一个**会话(不是又造一个)", a2?.id, a1?.id);
  eq("再跑一趟,「润色」也认回同一个", b2?.id, b1?.id);
  /*
   * ⚠️ **"认回一个会话"还不够 —— 必须是它自己那一格。**
   * 判据里少了 `node_id` 的话(变异 M2),`findNodeByNodeId` 会把**这个对话下最新的**
   * 节点会话交回来,而那多半是另一格的行;"a2.id === a1.id" 照样绿(两个格子都被问成
   * 同一个),只有这一条看得出来。
   */
  eq("问「查引用」拿回来的那一行,`nodeId` 就是 `agentA`", a2?.nodeId, "agentA");
  eq("问「润色」拿回来的那一行,`nodeId` 就是 `agentB`", b2?.nodeId, "agentB");
  eq(
    "跑了两趟之后,这个对话里的节点会话**还是两行**(不是四行)",
    SessionRepo.listNodesByParent(PARENT).length,
    2,
  );
}

/* ──────────────── 3. 改图:标题 / 位置 / 连边都不许换掉会话 ──────────────── */

{
  // 用户改的是**图上那一步的说明**,不是"这是另一步"。键必须扛得住这三样。
  const doc = nodeSessionDoc();
  const edited = {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.id === "agentA"
        ? { ...n, title: "查这三篇的引用(改过名)", position: { x: 400, y: 90 } }
        : n,
    ),
    // 连边也重连一次(图上拖过线)。节点 id 没变,会话就该认回来。
    edges: [
      { id: "e1", from: "entry", to: "agentB" },
      { id: "e2", from: "entry", to: "agentA" },
    ],
  };
  WorkflowRepo.save(edited);

  await runGraph(PARENT);

  const a3 = nodeSessionOf(PARENT, "agentA");
  eq("改完标题、挪完位置、重连边之后再跑,照样认回同一个会话", a3?.id, a1?.id);
  /*
   * **复用时不覆盖任何字段,标题也不覆盖** —— 这是刻意的,不是漏了。
   *
   * 会话是个可对话的对象:用户可能自己给它改过名(`session.rename`),它也可能正带着
   * 一段跟这一步有关的对话。跑图时顺手把标题按图上的格子名重写一遍,等于**每次跑图都
   * 抹掉用户改过的名字**。图上改了名只是"这一步的说明变了",不是"这是另一步了"。
   */
  eq(
    "改了名之后会话标题**不动**(它有自己的名字,可能是用户改的 —— 见 `nodeSessionOf` 的注释)",
    a3?.title,
    "查引用",
  );
}

/* ──────────────── 4. 同一个节点 id、另一个对话 = 另一个会话 ──────────────── */

{
  await runGraph(PARENT_B);

  const other = nodeSessionOf(PARENT_B, "agentA");
  check("另一段对话里也有自己的「查引用」", other !== undefined, { id: other?.id });
  check(
    "**键是(对话, 节点)这个二元组** —— 光看节点 id 会把两段对话串成一个",
    other !== undefined && other.id !== a1?.id,
    { other: other?.id, parent: a1?.id },
  );
  eq("它挂在另一个对话下", other?.parentSessionId, PARENT_B);
}

/* ──────────────── 5. 列得出来,而且只列得出这个对话的 ──────────────── */

{
  const list = SessionRepo.listNodesByParent(PARENT);
  eq("只列这个对话的节点会话(不把另一个对话的捎进来)", list.length, 2);
  check(
    "两行都是这个对话的",
    list.every((s) => s.parentSessionId === PARENT),
    { parents: list.map((s) => s.parentSessionId) },
  );
  check("每一行都说得出自己是图上哪一格", list.every((s) => typeof s.nodeId === "string" && s.nodeId.length > 0), {
    nodeIds: list.map((s) => s.nodeId),
  });
  eq(
    "列出来的就是那两格",
    list.map((s) => s.nodeId).sort().join(","),
    "agentA,agentB",
  );
}

/* ──────────────── 6. 反面:节点会话不许漏进左边栏 ──────────────── */

{
  // 新开了一个出口就得证明老出口没跟着漏 —— 左边栏那几条查询钉的是 `kind = 'chat'`。
  const all = SessionRepo.listAll({ limit: 100, offset: 0 });
  check(
    "跨项目总列表里**一个节点会话都没有**",
    all.every((s) => s.kind === "chat"),
    { kinds: all.map((s) => s.kind) },
  );
  const byProject = SessionRepo.listByProject("p1", { limit: 100, offset: 0, archived: false });
  check(
    "项目会话列表里也没有",
    byProject.every((s) => s.kind === "chat"),
    { kinds: byProject.map((s) => s.kind) },
  );
  check(
    "按标题搜也搜不到节点会话",
    SessionRepo.searchByTitle("查引用", { limit: 50 }).every((s) => s.kind === "chat"),
    { hits: SessionRepo.searchByTitle("查引用", { limit: 50 }).map((s) => s.kind) },
  );
  eq("顺带确认:节点会话**真的在库里**(不是被上面几条过滤掉了而已)", SessionRepo.listNodesByParent(PARENT).length, 2);
}

/* ──────────────── 7. 挂在同一个对话下的**别的**会话不许混进来 ──────────────── */

{
  /*
   * `parent_session_id` 这一列**不是节点会话专用的** —— 侧边问答(`kind: "side"`)和
   * 自动化的会话(`kind: "automation"`)都挂在某条对话上。所以"按 `parent_session_id`
   * 收口"这一条判据**光有它就够不着**:少了 `kind = 'node'`,看板会把一个侧边问答
   * 列成"工作流的一步",而点进去是一段跟这张图无关的对话。
   *
   * 这不是假想 —— 变异验证第一轮把 `kind = 'node'` 拿掉时**一条都没红**,就是因为
   * 夹具里除了节点会话没有别的挂靠会话。补上这两行它才真的验到了东西。
   */
  const now = 1_700_000_000_000;
  for (const kind of ["side", "automation"] as const) {
    SessionRepo.create({
      ...parentSession(`${PARENT}__${kind}`),
      id: `${PARENT}__${kind}`,
      kind,
      parentSessionId: PARENT,
      nodeId: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  check(
    `刚插进去的两个挂靠会话真的在库里(kind=side / automation)`,
    SessionRepo.get(`${PARENT}__side`) !== undefined &&
      SessionRepo.get(`${PARENT}__automation`) !== undefined,
  );
  const list = SessionRepo.listNodesByParent(PARENT);
  eq("侧边问答 / 自动化会话挂在同一个对话下,但**不是工作流的一步** —— 一条都不许混进来", list.length, 2);
  check(
    "列出来的 `kind` 全是 `node`",
    list.every((s) => s.kind === "node"),
    { kinds: list.map((s) => s.kind) },
  );
}

/* ──────────────── 8. 图修订钉住续跑:旧档 / 改图均不可继续 ──────────────── */

{
  const original = getWorkflow(WORKFLOW_ID)!;
  const revision = workflowRevision(original);
  const recent = WorkflowRunRepo.listForSession(PARENT, 10);
  check(
    "真实启动并落盘的运行带着图修订,不是只在编码器里模拟",
    recent.some((row) => decodeSnapshot(row.payload)?.workflowRevision === revision),
    recent.map((row) => decodeSnapshot(row.payload)?.workflowRevision),
  );

  const runId = "run_revision_guard";
  const snapshot: import("@main/orchestration/runStore.js").RunSnapshot = {
    prompt: "继续旧图",
    cwd: process.cwd(),
    attempts: [],
    state: {
      record: [],
      rounds: [],
      picks: [],
      outcomes: [["agentA", { status: "failed", summary: "可重试的旧步骤" }]],
      awaiting: ["agentA"],
    },
  };
  const persist = (saved: typeof snapshot): void => void saveRun({
    runId,
    sessionId: PARENT,
    workflowId: WORKFLOW_ID,
    status: "interrupted",
    snapshot: saved,
  });
  const choice = (id = runId) => runner.resolveWorkflowChoice({ sessionId: PARENT, runId: id, nodeId: "agentA", edgeId: "e1" });
  const retry = () => runner.resolveWorkflowRetry({ sessionId: PARENT, runId, nodeId: "agentA" });

  persist(snapshot);
  check("旧快照没有图修订:岔路口不能续", choice().error?.includes("旧版") === true);
  check("旧快照没有图修订:失败步骤不能重试", retry().error?.includes("旧版") === true);
  eq("续跑时旧卡的 runId 不匹配不得续其他运行", choice("run_another").ok, false);
  eq("直接调用 runner 也不能借旧快照绕过版本校验", await startWorkflowRun({
    session: SessionRepo.get(PARENT)!,
    resume: { runId, snapshot, nodeId: "agentA", rewind: ["agentA"] },
  }), null);
  eq("拒绝续跑后旧存档仍保留而没有被覆盖", WorkflowRunRepo.get(runId)?.status, "interrupted");

  const pinned = { ...snapshot, workflowRevision: revision, inFlightNodeIds: [] as string[] };
  persist({ ...pinned, inFlightNodeIds: ["agentA"] });
  check("中断时正在执行代理:岔路口不能自动重放外部副作用", choice().error?.includes("重放") === true);
  check("中断时正在执行代理:重试也不自动重放", retry().error?.includes("重放") === true);
  eq("直调 runner 也不能绕过副作用保护", await startWorkflowRun({
    session: SessionRepo.get(PARENT)!,
    resume: { runId, snapshot: { ...pinned, inFlightNodeIds: ["agentA"] }, nodeId: "agentA", rewind: ["agentA"] },
  }), null);

  // Positive control: an unchanged graph with no in-flight external effect
  // really starts again under the old runId (not merely passes a pure helper).
  const matchingId = "run_revision_compatible";
  saveRun({
    runId: matchingId,
    sessionId: PARENT,
    workflowId: WORKFLOW_ID,
    status: "failed",
    snapshot: { ...pinned, state: { ...pinned.state, awaiting: [] } },
  });
  const resumed = runner.resolveWorkflowRetry({ sessionId: PARENT, runId: matchingId, nodeId: "agentA" });
  eq("未改图且没有在飞副作用的失败步骤可重试", resumed.ok, true);
  eq("重试沿用旧 runId 并把原行标回 running", WorkflowRunRepo.get(matchingId)?.status, "running");
  cancelWorkflowRun(PARENT);
  await waitFor("已放行的兼容运行收尾", () => !runner.hasActiveRun(PARENT));
  check("重试后仍是原来的运行行", WorkflowRunRepo.get(matchingId)?.id === matchingId);

  persist(pinned);
  WorkflowRepo.save({ ...original, description: "保存时换了图语义" });
  check("同 id 改图后岔路口不能沿用旧边和结局", choice().error?.includes("已修改") === true);
  check("同 id 改图后重试不能沿用旧结局", retry().error?.includes("已修改") === true);
  eq("改图后直接续跑也不动旧存档", await startWorkflowRun({
    session: SessionRepo.get(PARENT)!,
    resume: { runId, snapshot: pinned, nodeId: "agentA", rewind: ["agentA"] },
  }), null);
  eq("图不兼容时存档仍完整", WorkflowRunRepo.get(runId)?.status, "interrupted");
}

/* ──────────────── 收尾 ──────────────── */

/* ──────────────── 9. 存档坏掉时不可无标记执行副作用 ──────────────── */

WorkflowRepo.save(nodeSessionDoc()); // 上一节改了图,恢复可信夹具
const repo = WorkflowRunRepo as unknown as { save: typeof WorkflowRunRepo.save };
const originalRunSave = repo.save;
{
  let attempts = 0;
  const bound = rt.bindLog.length;
  repo.save = () => { attempts += 1; throw new Error("injected run-store failure"); };
  const safety = setTimeout(() => cancelWorkflowRun(PARENT), 250);
  let rejected = false;
  try {
    await startWorkflowRun({ session: SessionRepo.get(PARENT)!, prompt: "不能无存档运行", cwd: process.cwd() });
  } catch { rejected = true; }
  finally { clearTimeout(safety); repo.save = originalRunSave; }
  check("初始存档失败明确拒绝运行", rejected && attempts > 0, { rejected, attempts });
  eq("存档失败前一个引擎节点都不能派发", rt.bindLog.length, bound);
  eq("存档失败后没有僵死的 active run", runner.hasActiveRun(PARENT), false);
}
{
  let markerFailures = 0;
  const bound = rt.bindLog.length;
  rt.resetPublished();
  repo.save = (row) => {
    const snapshot = decodeSnapshot(row.payload);
    if (snapshot?.inFlightNodeIds?.includes("entry") && markerFailures === 0) {
      markerFailures += 1;
      throw new Error("injected in-flight marker failure");
    }
    return originalRunSave(row);
  };
  const safety = setTimeout(() => cancelWorkflowRun(PARENT), 250);
  try {
    await startWorkflowRun({ session: SessionRepo.get(PARENT)!, prompt: "在飞标记写不进不得执行", cwd: process.cwd() });
  } finally { clearTimeout(safety); repo.save = originalRunSave; }
  eq("真实节点派发时触发了在飞标记失败", markerFailures, 1);
  eq("标记失败时没有调用模型/命令引擎", rt.bindLog.length, bound);
  check("标记失败以错误而非成功收口", rt.published.some((e) => e.type === "turn.done" && e.reason === "error"));
  eq("标记失败后没有僵死的 active run", runner.hasActiveRun(PARENT), false);
}


/* Real runner integration: fan-out conversation nodes share one target turn.
 * The stub rejects overlapping sends just like RuntimeManager; text is emitted
 * through the real runner subscription, so this also detects buffer clobbering.
 */
{
  const workflowId = "wf_conversation_queue_integration";
  const parentId = "s_conversation_queue_integration";
  const original = nodeSessionDoc();
  WorkflowRepo.save({ ...original, id: workflowId, nodes: original.nodes.map((n) => ({
    ...n, type: n.id === "entry" ? "mcode.main" : "mcode.conversation",
  })) });
  SessionRepo.create({ ...parentSession(parentId), workflowId });
  rt.holdConversationTurns(true);
  const offset = rt.sentPrompts.length;
  const rejectedBefore = rt.busyRejections;
  const finish = (text: string): void => {
    rt.nodeEmit(parentId)?.({ type: "text.delta", sessionId: parentId, messageId: text, text });
    rt.finishTurn(parentId);
  };
  const safety = setTimeout(() => cancelWorkflowRun(parentId), 8000);
  try {
    const done = startWorkflowRun({ session: SessionRepo.get(parentId)!, prompt: "queue", cwd: process.cwd() });
    await waitFor("真实 runner 入口启动", () => rt.sentPrompts.length >= offset + 1);
    finish("entry reply");
    await waitFor("第一个并行对话节点启动", () => rt.sentPrompts.length >= offset + 2);
    await new Promise((r) => setTimeout(r, 30));
    eq("第二个对话节点仍在排队，没有同时调用提供方", rt.sentPrompts.length, offset + 2);
    finish("A reply");
    await waitFor("第一轮完成后第二个对话节点启动", () => rt.sentPrompts.length >= offset + 3);
    finish("B reply");
    const result = await done;
    eq("真实 runner 的并行对话图成功完成", result?.status, "success");
    eq("没有 provider busy 拒绝", rt.busyRejections, rejectedBefore);
    eq("第一个节点的文本没被等待节点清空", result?.outcomes.get("agentA")?.summary, "A reply");
    eq("第二个节点没有混入前一轮文本", result?.outcomes.get("agentB")?.summary, "B reply");
    eq("会话队列执行后释放 active run", runner.hasActiveRun(parentId), false);
  } finally {
    clearTimeout(safety); rt.holdConversationTurns(false); cancelWorkflowRun(parentId); rt.finishTurn(parentId);
  }
}

/* Real auto-injection handoff, including a queue wait while session ancestry changes. */
{
  const { NODE_INJECT_TARGET_KEY, NODE_INJECT_MODE_KEY } = await import("@contracts/nodeType");
  const workflowId = "wf_origin_handoff", autoId = "s_origin_handoff", chatId = "s_origin_chat";
  const doc = nodeSessionDoc();
  const entry = doc.nodes.find(n => n.id === "entry")!;
  WorkflowRepo.save({ ...doc, id: workflowId, nodes: [{ ...entry, type: "mcode.conversation", params: {
    ...entry.params, [NODE_INJECT_TARGET_KEY]: "origin", [NODE_INJECT_MODE_KEY]: "auto",
  } }], edges: [] });
  SessionRepo.create({ ...parentSession(chatId), workflowId: "default" });
  SessionRepo.create({ ...parentSession(autoId), workflowId, kind: "automation", parentSessionId: chatId });
  SettingRepo.set(`automation.eventChain.${autoId}`, JSON.stringify({ version: 1, workflowIds: ["upstream-source", workflowId] }));
  rt.holdConversationTurns(true);
  rt.runtimeManager.bindSession(SessionRepo.get(chatId)!);
  await rt.runtimeManager.sendTurn(SessionRepo.get(chatId)!, { prompt: "user busy", cwd: process.cwd(), sessionId: chatId });
  const offset = rt.sentPrompts.length;
  const safety = setTimeout(() => cancelWorkflowRun(autoId), 8000);
  try {
    const done = startWorkflowRun({ session: SessionRepo.get(autoId)!, originSessionId: chatId, prompt: "inject", cwd: process.cwd() });
    await new Promise(r => setTimeout(r, 40));
    eq("自动注入在普通聊天忙时等待", rt.sentPrompts.length, offset);
    SettingRepo.set(`automation.eventChain.${autoId}`, JSON.stringify({ version: 1, workflowIds: [workflowId] }));
    rt.finishTurn(chatId);
    await waitFor("自动注入交给普通聊天提供方", () => rt.sentPrompts.length > offset);
    eq("runner 注入目标仍是原普通聊天", rt.sentPrompts.at(-1)?.sessionId, chatId);
    eq("排队前的祖先快照传入提供方而非重读最新记录", rt.sentPrompts.at(-1)?.automationOrigin?.workflowIds.join(","), `upstream-source,${workflowId}`);
    eq("普通用户的先前请求没有自动化标记", rt.sentPrompts[offset - 1]?.automationOrigin, undefined);
    eq("自动注入不等待模型回复即可完成图", (await done)?.status, "success");
  } finally { clearTimeout(safety); rt.holdConversationTurns(false); rt.finishTurn(chatId); cancelWorkflowRun(autoId); }
  // A reused session still has chatId persisted. Without an explicit per-run
  // origin it must not send to that chat (or reconstruct the target on retry).
  const beforeManual = rt.sentPrompts.length;
  const manual = await startWorkflowRun({ session: SessionRepo.get(autoId)!, prompt: "manual", cwd: process.cwd() });
  eq("没有本次发起人时 origin 节点明确失败", manual?.status, "failed");
  eq("旧 parentSessionId 不能造成真实提供方投递", rt.sentPrompts.length, beforeManual);
}

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} 通过`);
if (failures > 0) {
  console.log(`${failures} 条没过`);
  process.exit(1);
}
console.log("全部通过");
