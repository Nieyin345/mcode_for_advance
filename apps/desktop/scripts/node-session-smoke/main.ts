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
check("真实 runner 对主节点与隔离子节点均声明记忆所有权", rt.sentPrompts.length >= 3 && rt.sentPrompts.every(p => p.memoryManagedByWorkflow === true));

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
  check("旧快照没有图修订:岔路口不能续", (await choice()).error?.includes("旧版") === true);
  check("旧快照没有图修订:失败步骤不能重试", (await retry()).error?.includes("旧版") === true);
  eq("续跑时旧卡的 runId 不匹配不得续其他运行", (await choice("run_another")).ok, false);
  eq("直接调用 runner 也不能借旧快照绕过版本校验", await startWorkflowRun({
    session: SessionRepo.get(PARENT)!,
    resume: { runId, snapshot, nodeId: "agentA", rewind: ["agentA"] },
  }), null);
  eq("拒绝续跑后旧存档仍保留而没有被覆盖", WorkflowRunRepo.get(runId)?.status, "interrupted");

  const pinned = { ...snapshot, workflowRevision: revision, inFlightNodeIds: [] as string[] };
  persist({ ...pinned, inFlightNodeIds: ["agentA"] });
  check("中断时正在执行代理:岔路口不能自动重放外部副作用", (await choice()).error?.includes("重放") === true);
  check("中断时正在执行代理:重试也不自动重放", (await retry()).error?.includes("重放") === true);
  eq("直调 runner 也不能绕过副作用保护", await startWorkflowRun({
    session: SessionRepo.get(PARENT)!,
    resume: { runId, snapshot: { ...pinned, inFlightNodeIds: ["agentA"] }, nodeId: "agentA", rewind: ["agentA"] },
  }), null);

  persist({ ...pinned, inFlightNodeIds: ["agentA"], state: { ...pinned.state, outcomes: [], awaiting: [] } });
  check("journal-only interrupted agent is still stopped by the actual replay gate", (await retry()).error?.includes("重放") === true);

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
  const resumed = await runner.resolveWorkflowRetry({ sessionId: PARENT, runId: matchingId, nodeId: "agentA" });
  eq("未改图且没有在飞副作用的失败步骤可重试", resumed.ok, true);
  await waitFor("重试通过异步引擎预检并真正启动", () => WorkflowRunRepo.get(matchingId)?.status === "running" && runner.hasActiveRun(PARENT));
  eq("重试沿用旧 runId 并把原行标回 running", WorkflowRunRepo.get(matchingId)?.status, "running");
  cancelWorkflowRun(PARENT);
  await waitFor("已放行的兼容运行收尾", () => !runner.hasActiveRun(PARENT));
  check("重试后仍是原来的运行行", WorkflowRunRepo.get(matchingId)?.id === matchingId);

  persist(pinned);
  WorkflowRepo.save({ ...original, description: "保存时换了图语义" });
  check("同 id 改图后岔路口不能沿用旧边和结局", (await choice()).error?.includes("已修改") === true);
  check("同 id 改图后重试不能沿用旧结局", (await retry()).error?.includes("已修改") === true);
  eq("改图后直接续跑也不动旧存档", await startWorkflowRun({
    session: SessionRepo.get(PARENT)!,
    resume: { runId, snapshot: pinned, nodeId: "agentA", rewind: ["agentA"] },
  }), null);
  eq("图不兼容时存档仍完整", WorkflowRunRepo.get(runId)?.status, "interrupted");

  /* ── 【ARC-016】锁版档案被改过 → 不无声污染续跑 ──────────────────────────────
   *
   * 工作流节点每轮现读当前档案。R1 起跑后用户改了档案,待恢复节点再派发时用的会是**新**
   * 指令 —— 而卡片上写着的是那次运行的上下文。这与「存档里的图版本变了就拒绝续跑」是
   * 同一条道理。这里造一个**真档案文件**、把它当时的哈希锁进快照,再改档案,断言:
   * ① 快照锁了档案且档案没变 → 续跑照常放行(正控,证明上一条不是恒拒);② 档案被改 →
   * 续跑被拒且**如实点名**。 */
  {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const agentsDir = join(DATA, "workflows", "agents");
    mkdirSync(agentsDir, { recursive: true });
    const profileBody = (note: string) => JSON.stringify({ version: 1, id: "p_arc016", name: "研究助理", type: "mcode.agent", params: { note }, createdAt: 1, updatedAt: 1 });
    writeFileSync(join(agentsDir, "p_arc016.json"), profileBody("v1"), "utf-8");
    const { agentProfileContentHash } = await import("@main/orchestration/agentProfiles.js");
    const lockedHash = agentProfileContentHash("p_arc016");
    check("夹具:档案内容哈希读得到(不是 null)", typeof lockedHash === "string" && lockedHash.length > 0, lockedHash);

    // 图恢复成可信夹具(上面那一节刚把 description 改了,版本会不匹配)。
    WorkflowRepo.save(original);
    const revision2 = workflowRevision(original);
    const driftId = "run_config_drift";
    const cfgSnap: import("@main/orchestration/runStore.js").RunSnapshot = { ...snapshot, workflowRevision: revision2, inFlightNodeIds: [], state: { ...snapshot.state, outcomes: [["agentA", { status: "failed", summary: "可重试的旧步骤" }]], awaiting: [] }, configSnapshot: { takenAt: 1, profiles: { p_arc016: lockedHash }, skills: [] } };
    // ① 正控:档案没变 → 续跑放行。
    saveRun({ runId: driftId, sessionId: PARENT, workflowId: WORKFLOW_ID, status: "failed", snapshot: cfgSnap });
    const okDrift = await runner.resolveWorkflowRetry({ sessionId: PARENT, runId: driftId, nodeId: "agentA" });
    eq("档案没变:锁了版的运行仍可续(正控,证明下一条不是恒拒)", okDrift.ok, true);
    await waitFor("正控运行真的起跑", () => runner.hasActiveRun(PARENT));
    cancelWorkflowRun(PARENT);
    await waitFor("正控运行收尾", () => !runner.hasActiveRun(PARENT));

    // ② 改档案 → 续跑被拒且点名「档案被改动」。
    saveRun({ runId: driftId, sessionId: PARENT, workflowId: WORKFLOW_ID, status: "failed", snapshot: cfgSnap });
    writeFileSync(join(agentsDir, "p_arc016.json"), profileBody("v2-改过了"), "utf-8");
    const blocked = await runner.resolveWorkflowRetry({ sessionId: PARENT, runId: driftId, nodeId: "agentA" });
    eq("★ 锁版档案被改 → 续跑被拒", blocked.ok, false);
    check("★ 拒绝原因点名档案被改动(不是一句笼统失败)", blocked.error?.includes("档案被改动") === true, blocked.error);
    check("★ 拒绝原因带上哪个档案(assetId)", blocked.error?.includes("p_arc016") === true, blocked.error);
    eq("拒绝后旧存档仍保留", WorkflowRunRepo.get(driftId)?.status, "failed");
    // 恢复档案,免得影响后续小节。
    writeFileSync(join(agentsDir, "p_arc016.json"), profileBody("v1"), "utf-8");
  }
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
    eq("实际 runner 交接了记忆注入所有权", rt.sentPrompts.at(-1)?.memoryManagedByWorkflow, true);
    eq("普通用户轮次不被标成工作流记忆", rt.sentPrompts[offset - 1]?.memoryManagedByWorkflow, undefined);
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

/* Memory assistant: real graph runner + isolated SQLite, fake provider (no model calls). */
{
  const store = await import("@main/memory/assistantStore.js");
  const { memoryAssistant } = await import("@main/memory/assistant.js");
  const { interactiveRoute } = await import("@main/lib/interactiveRoute.js");
  const reject = async (label: string, run: () => unknown) => { let failed = false; try { await run(); } catch { failed = true; } check(label, failed); };
  for (const id of ["memory-capture", "memory-checkpoint", "memory-health"]) {
    const doc = getWorkflow(id);
    check(`${id} 真正进入工作流注册表`, doc?.trigger === "manual" && doc.nodes.some(n => n.id === "memory-entry"));
  }
  const source = SessionRepo.get(PARENT)!;
  const targetId = "memory_handoff_target";
  SessionRepo.create({ ...parentSession(targetId), workflowId: "default" });
  const ready = () => {
    const job = store.createAssistantJob(source.id, source.projectId, "test-worker", "checkpoint");
    store.saveAssistantJob({ ...job, status: "ready", result: "目标、已验证进度、下一步" });
    return job;
  };
  const a = ready();
  await reject("不能交接给原对话", () => store.queueAssistantHandoff(a.id, source.id, source.id));
  await reject("不能伪造来源", () => store.queueAssistantHandoff(a.id, PARENT_B, targetId));
  const foreignProject = { ...project(), id: "memory_other_project" };
  ProjectRepo.create(foreignProject);
  SessionRepo.create({ ...parentSession("memory_foreign"), projectId: foreignProject.id });
  await reject("不能跨项目交接", () => store.queueAssistantHandoff(a.id, source.id, "memory_foreign"));

  // 【MC-092】agent 经通用接口调 memory.assistant 时,宿主装了「会话所属项目」作用域 ——
  // 来源会话属于**别的项目**时必须拒(不能借别人的会话 id 触发对其项目记忆的整理)。桌面
  // 用户(无作用域)不受约束。这条撤掉修复后必须真红:那个 throw 不再发生。
  {
    const { runWithAgentMemoryScopeForSession } = await import("@main/memory/agentScope.js");
    // 来源会话 source 属于本机项目;foreign 会话属于 memory_other_project。
    let sameProjectOk = true;
    try {
      await runWithAgentMemoryScopeForSession(source.id, () => memoryAssistant({ op: "list", sessionId: source.id }));
    } catch { sameProjectOk = false; }
    check("★ MC-092:agent 作用域下整理**本项目**记忆可以(list)", sameProjectOk);
    let crossBlocked = false;
    try {
      await runWithAgentMemoryScopeForSession(source.id, () => memoryAssistant({ op: "list", sessionId: "memory_foreign" }));
    } catch { crossBlocked = true; }
    check("★ MC-092:agent 作用域下借**别的项目**的会话 id 被拒", crossBlocked);
    // 无作用域(桌面用户):不设限,foreign 会话也能整理。
    let desktopOk = true;
    try { await memoryAssistant({ op: "list", sessionId: "memory_foreign" }); } catch { desktopOk = false; }
    check("★ MC-092:桌面用户(无作用域)仍可整理任意会话(保留全局权限)", desktopOk);
  }

  store.queueAssistantHandoff(a.id, source.id, targetId);
  eq("待交接正文可在重新读取时恢复", store.pendingAssistantHandoff(targetId)?.result, "目标、已验证进度、下一步");
  eq("重复投递同包幂等", store.queueAssistantHandoff(a.id, source.id, targetId).id, a.id);
  SettingRepo.set(`memory.assistant.target.${targetId}`, "");
  store.queueAssistantHandoff(a.id, source.id, targetId);
  eq("修复中断的指针发布", store.pendingAssistantHandoff(targetId)?.id, a.id);
  const b = ready();
  await reject("不能覆盖另一份未接收材料", () => store.queueAssistantHandoff(b.id, source.id, targetId));
  store.consumeAssistantHandoff(targetId, b.id);
  eq("过时确认不能消费另一包", store.pendingAssistantHandoff(targetId)?.id, a.id);
  for (const reason of ["error", "interrupted", "max_tokens", "tool_use"]) {
    store.acknowledgeAssistantTurn(targetId, a.id, reason);
    eq(`${reason} 不消费待交接材料`, store.pendingAssistantHandoff(targetId)?.id, a.id);
  }
  store.acknowledgeAssistantTurn(targetId, a.id, "end_turn");
  eq("成功消费后不再注入", store.pendingAssistantHandoff(targetId), null);
  eq("已消费包正文被清除", store.readAssistantJob(a.id)?.result, "");
  await reject("已消费包不能重新发送", () => store.queueAssistantHandoff(a.id, source.id, targetId));
  store.queueAssistantHandoff(b.id, source.id, targetId);
  store.saveAssistantJob({ ...store.readAssistantJob(b.id)!, expiresAt: Date.now() - 1 });
  eq("过期交接不能投递", store.pendingAssistantHandoff(targetId), null);
  eq("过期包正文清理", store.readAssistantJob(b.id)?.result, "");
  const c = ready();
  store.queueAssistantHandoff(c.id, source.id, targetId);
  await memoryAssistant({ op: "discard", sessionId: source.id, jobId: c.id });
  eq("人工撤销之后不再投递", store.pendingAssistantHandoff(targetId), null);
  const capture = store.createAssistantJob(source.id, source.projectId, "test-worker", "capture");
  store.saveAssistantJob({ ...capture, status: "ready", result: "长期建议不是交接材料" });
  await reject("长期整理结果不能伪装临时包", () => store.queueAssistantHandoff(capture.id, source.id, targetId));
  eq("交互代理多级回到可见对话", interactiveRoute("node", id => ({ node: "worker", worker: "chat" } as Record<string,string>)[id]), "chat");
  eq("交互代理循环不逃逸", interactiveRoute("node", id => ({ node: "worker", worker: "node" } as Record<string,string>)[id]), "node");
  eq("普通交互路由不变", interactiveRoute("chat", () => undefined), "chat");
  eq("★ 代理层读取失败不可把异常抛入用户批准/提问流程", interactiveRoute("node", () => {
    throw new Error("FAKE_SESSION_LOOKUP_IO_ERROR");
  }), "node");
  eq("★ 返回非法非字符串 session identity 必须保持原始用户路由",
    interactiveRoute("node", () => 42 as unknown as string), "node");
  eq("★ 空白目标 id 不能被当成受信路由", interactiveRoute("node", () => "   "), "node");
  eq("★ 代理目标非有限链路不退化至中间节点",
    interactiveRoute("node", (id) => id === "node" ? "worker" : "\u0000malformed"), "node");
  const aborted = new AbortController(); aborted.abort();
  const sends = rt.sentPrompts.length;
  eq("取消的启动不触发模型", await startWorkflowRun({ session: source, startSignal: aborted.signal }), null);
  eq("取消启动无发送", rt.sentPrompts.length, sends);

  const { MessageRepo } = await import("@main/store/repositories.js");
  MessageRepo.upsertMany(Array.from({ length: 50 }, (_, i) => ({ id: `memory-message-${String(i).padStart(3, "0")}`, sessionId: source.id, role: "user" as const,
    content: [{ type: "image", data: "NEVER_SEND_IMAGE_DATA" }, { type: "text", text: i === 0 ? "OUTSIDE_RECENT_WINDOW" : i === 49 ? `LATEST_CONTEXT sk-${"A".repeat(30)}` : "saved message" }], createdAt: Date.now() - 50 + i })));
  WorkflowRunRepo.save({ id: "zz_memory_evidence_run", sessionId: source.id, workflowId: source.workflowId, status: "success", awaiting: [], payload: JSON.stringify({ prompt: "evidence", cwd: process.cwd(), attempts: [], state: { record: [], rounds: [], picks: [], outcomes: [["evidence", { status: "success", summary: "LINKED_RUN_EVIDENCE" }]], awaiting: [] } }) });
  const launched = await memoryAssistant({ op: "start", sessionId: source.id, kind: "checkpoint" });
  const job = launched.jobs[0]!;
  check("点击入口创建独立后台自动化", SessionRepo.get(job.workerSessionId)?.kind === "automation" && job.workerSessionId !== source.id);
  eq("原对话工作流没有被切换", SessionRepo.get(source.id)?.workflowId, source.workflowId);
  await reject("重复点击不并发生成", () => memoryAssistant({ op: "start", sessionId: source.id, kind: "checkpoint" }));
  // 【Q5】记忆整理已迁到 Node-RED 执行 —— 这条套件的桩运行时看不到引擎里的节点。
  // 但它真正要守的是**交给模型的材料**（不泄漏图片/密钥、读到真实运行证据、
  // 预算数字不手抄），那件事由纯函数 `sourceContext` 决定，与谁执行无关。
  // 直接调它，比"等一个节点在桩里起来"更贴近被测对象。
  const { sourceContext } = await import("@main/memory/assistant.js");
  const prompt = sourceContext(SessionRepo.get(source.id)!);
  check("使用当前对话最近保存的内容", prompt.includes("LATEST_CONTEXT") && !prompt.includes("OUTSIDE_RECENT_WINDOW"));
  check("读取实际关联运行证据", prompt.includes("LINKED_RUN_EVIDENCE"));
  check("不序列化图片或明显密钥", !prompt.includes("NEVER_SEND_IMAGE_DATA") && !prompt.includes(`sk-${"A".repeat(30)}`));
  // ★ 提示词里对模型说的那个「文本最多 N 字」必须是**真的那个预算**,不是手抄的副本。
  //   从前这里硬编码 32000,与 `sourceText.SOURCE_BUDGET` 是同一事实的两处字面量 ——
  //   改了预算漏改这里,模型就会被喂一个与实际不符的数。
  {
    const { SOURCE_BUDGET } = await import("@main/memory/sourceText.js");
    check("★ 提示词里报的预算与 SOURCE_BUDGET 一致(不是手抄的数字)", prompt.includes(`文本最多${SOURCE_BUDGET}字`), SOURCE_BUDGET);
  }
  // 交接**结果投递**那一段（技能包 ready → deliver → consume）与执行引擎无关：
  // 它只认存储里那条 job。直接把这一轮标成 ready，验后续投递链路；
  // 「材料怎么构造」已由上面的 `sourceContext` 直接验过。
  store.saveAssistantJob({ ...store.readAssistantJob(job.id)!, status: "ready",
    result: "已完成 A；证据是测试记录；下一步 B。" });
  check("临时包保留实际模型输出", store.readAssistantJob(job.id)?.result.includes("下一步 B") === true);
  const delivered = await memoryAssistant({ op: "deliver", sessionId: source.id, jobId: job.id });
  check("交接创建同项目新对话", delivered.target?.projectId === source.projectId && delivered.target?.id !== source.id && delivered.target?.kind === "chat");
  eq("目标待投递记录已保存", store.pendingAssistantHandoff(delivered.target!.id)?.id, job.id);
  const again = await memoryAssistant({ op: "deliver", sessionId: source.id, jobId: job.id });
  eq("重复点击不重复建对话", again.target?.id, delivered.target?.id);
  store.consumeAssistantHandoff(delivered.target!.id, job.id);
  eq("交接消费状态可从源对话查看", (await memoryAssistant({ op: "list", sessionId: source.id })).jobs.find(j => j.id === job.id)?.status, "consumed");
  const abandoned = store.createAssistantJob(source.id, source.projectId, "lost-worker-after-restart", "checkpoint");
  eq("失去内存执行者的任务标失败，不自动重放", (await memoryAssistant({ op: "list", sessionId: source.id })).jobs.find(j => j.id === abandoned.id)?.status, "failed");
  const registry = await import("./stubs/providerRegistry.js");
  let releaseHealth!: () => void;
  registry.holdNextHealth(new Promise<void>(resolve => { releaseHealth = resolve; }));
  const beforeCancel = rt.sentPrompts.length;
  const launching = (await memoryAssistant({ op: "start", sessionId: source.id, kind: "checkpoint" })).jobs[0]!;
  check("再次整理使用全新的代理上下文", launching.workerSessionId !== job.workerSessionId);
  await memoryAssistant({ op: "cancel", sessionId: source.id, jobId: launching.id });
  releaseHealth();
  await new Promise(resolve => setTimeout(resolve, 30));
  eq("在引擎预检期间取消不会偷偷启动模型", rt.sentPrompts.length, beforeCancel);
  eq("被取消的后台任务不反弹成成功", store.readAssistantJob(launching.id)?.status, "cancelled");

  // ★ 会话没了 → 它名下的记忆助手行一起删掉(值里带着 AI 从对话整理的摘要)。
  //   三族键都按会话/job id 存,会话一删它们再也不会被读到,留着就是只增不减的设置行,
  //   而设置表每写一次都要重写整个 `mcode.db`。`createAssistantJob` 只"留最近 20 条"
  //   并把老的标过期、**不删行**,所以光靠它兜不住 —— 必须有这条会话级收尾。
  {
    const doomedSrc = SessionRepo.get(source.id)!;
    const cleanupJob = store.createAssistantJob(doomedSrc.id, doomedSrc.projectId, "cleanup-worker", "checkpoint");
    store.saveAssistantJob({ ...store.readAssistantJob(cleanupJob.id)!, status: "ready", result: "会话删掉后不该留存的摘要" });
    store.queueAssistantHandoff(cleanupJob.id, doomedSrc.id, delivered.target!.id);
    const jobKey = `memory.assistant.job.${cleanupJob.id}`;
    const srcKey = `memory.assistant.source.${doomedSrc.id}`;
    const tgtKey = `memory.assistant.target.${delivered.target!.id}`;
    check("收尾前:该会话的三族键都在表里", SettingRepo.get(jobKey) !== null && SettingRepo.get(srcKey) !== null && SettingRepo.get(tgtKey) !== null);

    store.dropAssistantJobs(doomedSrc.id);

    eq("★ 收尾删掉了 job 本体(带 AI 摘要的那条)", SettingRepo.get(jobKey), null);
    eq("★ 收尾删掉了该会话的 job 索引", SettingRepo.get(srcKey), null);
    eq("★ 收尾删掉了指向它的交接指针", SettingRepo.get(tgtKey), null);
    // 幂等:同一 id 再调一次不得报错(删项目那条路会为每个会话各调一次)。
    let twice = false; try { store.dropAssistantJobs(doomedSrc.id); twice = true; } catch { /* */ }
    check("重复收尾幂等", twice);
  }

  // 【MC-052】删一个会话不许碰到**别的**会话的坏 job 行。
  // 红例(台账):一条属于 foreign 会话、内容损坏的 job,在删除毫无关联的会话时被
  // 无条件删除(旧代码 catch → doomed.add)。修复后归属判据只剩"可证明归属":
  //   · 坏行不在任何被删会话的索引/指针里 → 保留原字节;
  //   · 坏行的 id 恰在被删会话的索引里(旁证) → 才删。
  //
  // 显式报告(硬规矩 3)这一半由 stderr 观察:logger 桩把 `log.warn` 原样写到 stderr,
  // 这里接住一份,断言"保留"真的说了话,而不只是"碰巧没删"。
  {
    const logLines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      for (const line of String(chunk).split("\n")) if (line.trim().length > 0) logLines.push(line);
      return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
      const doomedSrc = SessionRepo.get(PARENT_B)!;
      const foreignSrc = SessionRepo.get(PARENT)!;
      const badForeign = "memory.assistant.job.bad-foreign";
      SettingRepo.set(badForeign, "{ foreign user content damaged");

      // 目标会话自己的**健康** job(应当被删)与**损坏但索引指向它**的 job(旁证成立,应删)。
      const healthy = store.createAssistantJob(doomedSrc.id, doomedSrc.projectId, "w1", "checkpoint");
      const healthyKey = `memory.assistant.job.${healthy.id}`;
      SettingRepo.set("memory.assistant.source." + doomedSrc.id, JSON.stringify([healthy.id, "owned-bad"]));
      const ownedBad = "memory.assistant.job.owned-bad";
      SettingRepo.set(ownedBad, "{ broken owned job");

      // 【MC-052 判据未覆盖面】坏行不在**自己的索引**里,但别人的 `.target` 指针指着它:
      // 指针值就是 job id(`.target.<会话>` 只由本模块写入)—— 它是可证明的归属旁证。
      // 只在索引旁证上钉过是不够的:指针那条判据撤掉,这里必须真红。
      const pointerOwnedBad = "memory.assistant.job.pointer-owned-bad";
      SettingRepo.set(pointerOwnedBad, "{ broken pointer-owned job");
      SettingRepo.set("memory.assistant.target." + doomedSrc.id, "pointer-owned-bad");

      // 无关会话的健康 job —— 必须完好保留(旧行为就守得住,新行为不许退化)。
      const foreignHealthy = store.createAssistantJob(foreignSrc.id, foreignSrc.projectId, "w2", "capture");
      const foreignHealthyKey = `memory.assistant.job.${foreignHealthy.id}`;

      const badForeignRawBefore = SettingRepo.get(badForeign);
      check("收尾前:无关坏行在表里", badForeignRawBefore === "{ foreign user content damaged", badForeignRawBefore);

      store.dropAssistantJobs(doomedSrc.id);

      eq("★ 无关会话的坏 job 行**原字节保留**(归属未知,不越权删)", SettingRepo.get(badForeign), "{ foreign user content damaged");
      eq("★ 本会话的健康 job 照常删掉", SettingRepo.get(healthyKey), null);
      eq("★ 本会话索引可证明归属的坏 job 删掉(旁证成立)", SettingRepo.get(ownedBad), null);
      eq("★ 本会话目标指针可证明归属的坏 job 删掉(指针旁证成立)", SettingRepo.get(pointerOwnedBad), null);
      check("★ 无关会话的健康 job 完好", SettingRepo.get(foreignHealthyKey) !== null, SettingRepo.get(foreignHealthyKey));
      // ★ 显式报告:坏行被保留时必须有一条点名它的 warn,而不是静默留下/静默删掉。
      check(
        "★ 保留坏行时显式报告(硬规矩 3:不是静默跳过)",
        logLines.some((line) => line.includes("保留") && line.includes(badForeign) && line.includes("归属未知")),
        logLines.filter((line) => line.includes("记忆助手 job")),
      );

      // 再删 foreign 会话时,那条坏行仍保留(它是坏数据,但从不被任何人"顺手"删)。
      store.dropAssistantJobs(foreignSrc.id);
      eq("★ 再删 foreign 会话也不碰它(坏行从不被顺手删)", SettingRepo.get(badForeign), "{ foreign user content damaged");
      // 清场,免得后续断言的表里留着它。
      SettingRepo.deleteMany([badForeign, `memory.assistant.source.${doomedSrc.id}`, `memory.assistant.target.${doomedSrc.id}`]);
    } finally {
      process.stderr.write = origWrite as typeof process.stderr.write;
    }
  }

  // ★ 坏掉的记忆助手行报的是**同一句中文**,不是 `SyntaxError`/`ZodError` 的英文原句。
  //   `SettingRepo.get` 的值可能不是合法 JSON(半截写盘、外部改库、旧 schema),而 `op:"list"`
  //   轮询每 2 秒打一次这条路、渲染端把异常原样摆进红色危险面板。同一文件下面那句"索引形状
  //   不对"的守卫早就用了中文,坏行却分两种口径 —— 这里把两种坏法(JSON 本身坏 / job schema
  //   不合)都钉住,并且禁止英文/ZodError 字样漏出去(与 `custom-model-smoke` 同一条判据)。
  {
    const looksEnglish = (msg: string) => /zod|ZodError|invalid_|Unexpected token|\{\s*"|\[\s*\{/i.test(msg);
    const catchMsg = (run: () => unknown): string => { try { run(); return ""; } catch (e) { return (e as Error).message; } };

    SettingRepo.set(`memory.assistant.source.${source.id}`, "not-json{");
    const idxMsg = catchMsg(() => store.listAssistantJobs(source.id));
    check("★ 索引是坏 JSON 时报中文坏了、不是英文 SyntaxError",
      idxMsg.length > 0 && !looksEnglish(idxMsg) && idxMsg.includes("损坏"), idxMsg);

    SettingRepo.set(`memory.assistant.source.${source.id}`, JSON.stringify([123]));
    const shapeMsg = catchMsg(() => store.listAssistantJobs(source.id));
    check("★ 索引里混进非字符串 id 也报同一句中文",
      shapeMsg.length > 0 && !looksEnglish(shapeMsg) && shapeMsg.includes("损坏"), shapeMsg);

    SettingRepo.set(`memory.assistant.job.corrupt-job`, "{ broken");
    const jobMsg = catchMsg(() => store.readAssistantJob("corrupt-job"));
    check("★ job 本体是坏 JSON 时报中文坏了、不是英文 SyntaxError",
      jobMsg.length > 0 && !looksEnglish(jobMsg) && jobMsg.includes("损坏"), jobMsg);

    SettingRepo.set(`memory.assistant.job.corrupt-job`, JSON.stringify({ id: "corrupt-job", status: "nonsense" }));
    const schemaMsg = catchMsg(() => store.readAssistantJob("corrupt-job"));
    check("★ job 本体 schema 不合报中文,不是 ZodError JSON",
      schemaMsg.length > 0 && !looksEnglish(schemaMsg) && schemaMsg.includes("损坏"), schemaMsg);
    SettingRepo.deleteMany([`memory.assistant.source.${source.id}`, `memory.assistant.job.corrupt-job`]);
  }
}

// Ordinary launches (not only memory workers) reserve and cancel during preflight.
{
  const registry = await import("./stubs/providerRegistry.js");
  const id = "s_pending_preflight_regression";
  SessionRepo.create(parentSession(id));
  const session = SessionRepo.get(id)!;
  let release!: () => void;
  registry.holdNextHealth(new Promise<void>((resolve) => { release = resolve; }));
  const probes = registry.healthProbeCount;
  const sent = rt.sentPrompts.length;
  const first = startWorkflowRun({ session, prompt: "pending", cwd: process.cwd() });
  check("首次 await 前已占用会话", runner.hasActiveRun(id));
  eq("预检期间重复启动被拒绝", await startWorkflowRun({ session, prompt: "duplicate", cwd: process.cwd() }), null);
  await waitFor("健康预检确实在等待", () => registry.healthProbeCount > probes);
  check("普通停止可以取消预检", cancelWorkflowRun(id));
  check("取消立即释放会话", !runner.hasActiveRun(id));
  release();
  eq("旧的预检完成不会重新启动", await first, null);
  eq("未执行任何模型节点", rt.sentPrompts.length, sent);
  let reject!: (error: Error) => void;
  registry.holdNextHealth(new Promise<void>((_resolve, rejectGate) => { reject = rejectGate; }));
  const probesBeforeFailure = registry.healthProbeCount;
  const failed = startWorkflowRun({ session, prompt: "failed preflight", cwd: process.cwd() }).then(() => false, () => true);
  await waitFor("失败预检确实在等待", () => registry.healthProbeCount > probesBeforeFailure);
  reject(new Error("fixture preflight failure"));
  check("预检失败仍向调用方报错", await failed);
  check("预检异常不留下永久 busy", !runner.hasActiveRun(id));
}

// Real persisted journal-only condition -> retry endpoint -> scheduler, no model.
{
  const sid = "pure-condition-resume", workflowId = "wf_pure_condition_resume", runId = "pure-condition-run";
  const original = nodeSessionDoc();
  const nodes: import("@contracts/workflow").WorkflowNode[] = [
    { id: "pure", type: "mcode.condition", title: "Pure", position: { x: 0, y: 0 }, params: {
      expression: { logic: "and", rules: [{ ref: "{{user}}", op: "contains", value: "go" }] },
    } },
    ...["yes", "no"].map(id => ({ id, type: "mcode.trigger", title: id, position: { x: 200, y: 0 }, params: { triggerKind: "manual", enabled: false } })),
  ];
  WorkflowRepo.save({ ...original, id: workflowId, nodes, edges: [
    { id: "yes", from: "pure", to: "yes", label: "true" }, { id: "no", from: "pure", to: "no", label: "false" },
  ] });
  SessionRepo.create({ ...parentSession(sid), workflowId });
  const doc = getWorkflow(workflowId)!;
  saveRun({ runId, sessionId: sid, workflowId, status: "interrupted", snapshot: {
    prompt: "go", cwd: process.cwd(), attempts: [], workflowRevision: workflowRevision(doc), inFlightNodeIds: ["pure"],
    state: { record: [], rounds: [], picks: [], outcomes: [], awaiting: [] },
  } });
  const sends = rt.sentPrompts.length;
  eq("a journal-only pure condition is accepted by the real retry endpoint", (await runner.resolveWorkflowRetry({ sessionId: sid, runId, nodeId: "pure" })).ok, true);
  await waitFor("pure condition really finishes after restart", () => WorkflowRunRepo.get(runId)?.status === "success");
  const completed = decodeSnapshot(WorkflowRunRepo.get(runId)?.payload ?? "");
  eq("resumed pure condition produces its real outcome", completed?.state.outcomes.find(([id]) => id === "pure")?.[1].status, "success");
  eq("pure continuation never dispatches a model", rt.sentPrompts.length, sends);
  check("pure continuation releases the session", !runner.hasActiveRun(sid));
}

/* ──────────────── 【MC-003】场景任务注册表接线 ────────────────
 *
 * 从前 `SceneTaskRegistry`（父子任务治理 / 取消传播 / 外部动作 uncertain）是**纯孤岛** ——
 * 生产 0 调用端，只有 smoke 调它。本段钉的是**真接线**：跑一次真 `startWorkflowRun`，
 * 看真注册表里有没有根/子任务；`cancelWorkflowRun` 有没有把取消传播下去；往订阅者灌一条
 * SSH 工具事件之后，取消报告还诚不诚实（uncertain 不许被吞成「干净全停」）。
 */
{
  const { getSceneRegistry, setSceneRuntime } = await import("@main/orchestration/sceneTaskRuntime.js");
  setSceneRuntime(null); // 每段自己一套干净注册表（与生产装配同姿势）
  const reg = getSceneRegistry();

  const sid = "scene-wire", workflowId = "wf_scene_wire";
  const original = nodeSessionDoc();
  WorkflowRepo.save({ ...original, id: workflowId });
  SessionRepo.create({ ...parentSession(sid), workflowId });

  const from = rt.bindLog.length;
  const done = startWorkflowRun({ session: SessionRepo.get(sid)!, prompt: "两格活分头做。", cwd: process.cwd() });
  await waitFor("scene-wire 两格都起来", () => rt.bindLog.slice(from).filter((id) => id !== sid).length >= 2);

  // ① 根 + 子任务真的注册了（用任务清单反查根:唯一 parentTaskId=null 的那条）。
  const all = reg.tasksOfScene(sid);
  const rootTask = all.find((t) => t.parentTaskId === null);
  check("★ MC-003:这次运行在注册表里有根任务", rootTask !== undefined, all.map((t) => t.taskId));
  const children = all.filter((t) => t.parentTaskId !== null);
  check("★ MC-003:两格各登记了一条子任务", children.length >= 2, children.map((t) => `${t.taskId}:${t.sessionId}`));
  // 子任务绑的会话 id 与节点会话对上（取消传播按会话中断才有落点）。
  const nodeSess = children.map((c) => c.sessionId).filter((x): x is string => x !== null);
  check("★ MC-003:子任务绑的正是节点的会话", nodeSess.includes(nodeSessionOf(sid, "agentA")!.id) && nodeSess.includes(nodeSessionOf(sid, "agentB")!.id), nodeSess);

  // ② 干净取消：传播到子任务，报告如实。
  const reports: string[] = [];
  const unsub = rt.published;
  cancelWorkflowRun(sid);
  await done;
  const after = reg.tasksOfScene(sid);
  check("★ MC-003:取消传播 —— 根与子任务都进了终态", after.every((t) => ["cancelled", "uncertain", "completed", "failed"].includes(t.state)), after.map((t) => `${t.taskId}:${t.state}`));
  check("★ MC-003:没有卡在 running/pending 的孤儿", after.every((t) => t.state !== "running" && t.state !== "pending"), after.map((t) => `${t.taskId}:${t.state}`));

  // ③ 外部动作在飞 → uncertain 不许被吞。
  setSceneRuntime(null);
  const reg2 = getSceneRegistry();
  const sid2 = "scene-wire-ssh", workflowId2 = "wf_scene_wire_ssh";
  WorkflowRepo.save({ ...original, id: workflowId2 });
  SessionRepo.create({ ...parentSession(sid2), workflowId: workflowId2 });
  const from2 = rt.bindLog.length;
  const done2 = startWorkflowRun({ session: SessionRepo.get(sid2)!, prompt: "两格活分头做。", cwd: process.cwd() });
  await waitFor("scene-wire-ssh 两格都起来", () => rt.bindLog.slice(from2).filter((id) => id !== sid2).length >= 2);
  // 往 agentA 的会话灌一条 SSH 工具调用（订阅者按会话 id 找子任务标 externalActionInFlight）。
  const aSess = nodeSessionOf(sid2, "agentA")!.id;
  const emit = rt.nodeEmit(aSess);
  check("前置:拿得到 agentA 那一轮的 emit", emit !== undefined);
  emit?.({ type: "tool.use", sessionId: aSess, toolCallId: "c1", toolName: "mcp__mcode-app__agent_ssh_exec", input: { connection_id: "x", command: "git push" }, requiresApproval: false });
  // 等一拍让订阅者处理（同步 set，这里只是稳妥）。
  await new Promise((r) => setTimeout(r, 30));
  const marked = reg2.tasksOfScene(sid2).find((t) => t.sessionId === aSess);
  check("★ MC-003:SSH 工具在飞 → 该步标了外部动作在途", marked?.externalActionInFlight === true, marked && { id: marked.taskId, inflight: marked.externalActionInFlight });

  const errsBefore = rt.published.filter((e) => e.type === "error").length;
  cancelWorkflowRun(sid2);
  await done2;
  const after2 = reg2.tasksOfScene(sid2);
  const uncertain = after2.filter((t) => t.state === "uncertain");
  check("★ MC-003:外部动作在飞的步记成 uncertain（绝不谎报 cancelled）", uncertain.length === 1 && uncertain[0]!.sessionId === aSess, after2.map((t) => `${t.taskId}:${t.state}`));
  const errs = rt.published.filter((e) => e.type === "error").slice(errsBefore);
  check("★ MC-003:取消报告如实发出去（点名要人工核对）", errs.some((e) => (e as { message?: string }).message?.includes("核对") === true), errs.map((e) => (e as { message?: string }).message));
  // ③ 复核补漏:正常跑完(不是取消)时根任务也必须进终态 —— 从前只有 cancel 一条路
  //    会动根,正常结束的 run 把根永久留在 pending/running(注册表孤儿)。
  {
    setSceneRuntime(null);
    const reg3 = getSceneRegistry();
    const sid3 = "scene-wire-normal", workflowId3 = "wf_scene_wire_normal";
    // 一张**会自然跑完**的图（纯条件节点，不需要模型 → 不 park）。
    WorkflowRepo.save({
      ...original,
      id: workflowId3,
      nodes: [
        { id: "pure", type: "mcode.condition", title: "Pure", position: { x: 0, y: 0 }, params: {
          expression: { logic: "and", rules: [{ ref: "{{user}}", op: "contains", value: "go" }] },
        } },
        ...["yes", "no"].map((id) => ({ id, type: "mcode.trigger", title: id, position: { x: 200, y: 0 }, params: { triggerKind: "manual", enabled: false } })),
      ],
      edges: [
        { id: "yes", from: "pure", to: "yes", label: "true" },
        { id: "no", from: "pure", to: "no", label: "false" },
      ],
    });
    SessionRepo.create({ ...parentSession(sid3), workflowId: workflowId3 });
    const done3 = startWorkflowRun({ session: SessionRepo.get(sid3)!, prompt: "go", cwd: process.cwd() });
    await done3;
    const after3 = reg3.tasksOfScene(sid3);
    const root3 = after3.find((t) => t.parentTaskId === null);
    check("★ MC-003 复核:正常跑完后根任务进了终态(不留在 pending/running)", root3 !== undefined && ["completed", "failed", "cancelled", "uncertain"].includes(root3.state), root3 && { id: root3.taskId, state: root3.state });
    check("★ MC-003 复核:正常跑完后没有卡在 pending/running 的任务", after3.every((t) => t.state !== "running" && t.state !== "pending"), after3.map((t) => `${t.taskId}:${t.state}`));
  }

  // ④ 复核补漏:「让开」(parkedRunTeardown)也必须走注册表取消 —— 从前它只删 map + abort,
  //    根/子任务全部成为永不终态的孤儿,而 run 已不在 map 里、之后无人能取消。
  {
    setSceneRuntime(null);
    const reg4 = getSceneRegistry();
    const sid4 = "scene-wire-park", workflowId4 = "wf_scene_wire_park";
    // 一张会在岔路口**等人**的图（parked 的前提：executing === 0 且有等待中的选择）。
    WorkflowRepo.save({
      ...original,
      id: workflowId4,
      nodes: [
        { id: "entry", type: "mcode.main", title: "主对话", params: { instruction: "选一个" }, position: { x: 0, y: 0 } },
        { id: "fork", type: "mcode.branch", title: "下一步做什么", params: {}, position: { x: 0, y: 120 } },
        { id: "a", type: "mcode.agent", title: "甲", params: { instruction: "做甲" }, position: { x: 0, y: 240 } },
        { id: "b", type: "mcode.agent", title: "乙", params: { instruction: "做乙" }, position: { x: 200, y: 240 } },
      ],
      edges: [
        { id: "e1", from: "entry", to: "fork" },
        { id: "e2", from: "fork", to: "a", label: "走甲" },
        { id: "e3", from: "fork", to: "b", label: "走乙" },
      ],
    });
    SessionRepo.create({ ...parentSession(sid4), workflowId: workflowId4 });
    void startWorkflowRun({ session: SessionRepo.get(sid4)!, prompt: "帮我选。", cwd: process.cwd() });
    await waitFor("scene-wire-park 图停在岔路口等人", () => runner.isRunParked(sid4));
    const parked = runner.parkedRunTeardown(sid4);
    check("前置:让开拿到收尾 promise(图确实停在等人)", parked !== null, parked);
    await parked;
    const after4 = reg4.tasksOfScene(sid4);
    check("★ MC-003 复核:让开后根与子任务都进终态(不再留孤儿)", after4.length > 0 && after4.every((t) => !["running", "pending"].includes(t.state)), after4.map((t) => `${t.taskId}:${t.state}`));
  }
}

/* ──────────────── 10. 原生运行史：合成会话必须先存在（外键） ────────────────
 *
 * `workflow_runs.session_id` 是 `REFERENCES sessions(id)`，而原生 Node-RED 运行用的是
 * **宿主合成**的命名空间 `@node-red-runboard:<workflowId>` —— 全仓没有别处创建它。
 * `WorkflowRunRepo.save` 因此要先补一条最小占位行。
 *
 * ## 为什么这条断言只能放在这里
 *
 * 那个占位行原先只填 `id`，而 `sessions` 的 `project_id` / `title` / `status` /
 * `model` / `permission_mode` / `created_at` / `updated_at` 都是 `NOT NULL` **且
 * 无默认值** —— INSERT 被 `OR IGNORE` 静默丢掉，随后的 `workflow_runs` 撞外键，
 * 被 catch 成一行 warn。**运行史一条都写不进去，而所有套件照样全绿**：它们的
 * `WorkflowRunRepo` 被整个桩掉。只有真库能抓住。
 *
 * 实测：真 Electron U1 四条旅程全过，日志里每步都在打
 * `原生运行记录写入失败：FOREIGN KEY constraint failed`。
 */
{
  const runboardId = "@node-red-runboard:wf_external_history_probe";
  const runId = "run_external_history_probe";
  /* **不用一个独立 id 去验「本来不存在」**：本套前面的场景已经建过别的 runboard
   * 会话，而 `ensureSessionRow` 是幂等的 —— 判据落在这里会验到"已存在"而假红
   * （实测：前置那条红在 `SessionRepo.get(...) === null`）。
   * 真正要守的是**结果**：调用之后那一行在、运行史真落库、且不冒幽灵行。 */
  /* 包一层：缺陷复现时这里是**外键异常**，不包的话整个套件崩在那一行，
   * 后面所有断言白跑，而输出里只剩一条栈（看不出是哪条判据失效）。 */
  const save = (status: "running" | "success"): { ok: boolean; error?: string } => {
    try {
      WorkflowRunRepo.save({
        id: runId, sessionId: runboardId, workflowId: "wf_external_history_probe",
        status, payload: JSON.stringify({ prompt: "probe" }), awaiting: [],
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  const firstSave = save("running");
  check("★ 写一条 runboard 运行史不抛外键错误", firstSave.ok, firstSave);
  const created = SessionRepo.get(runboardId);
  check("★ 宿主合成的 runboard 会话被自动建出来（否则运行史永远写不进去）", created !== null, created);
  // 占位行不该污染「最近会话」：它代表一个命名空间，不是用户开的对话。
  const activeList = SessionRepo.listByProject("", { archived: false, limit: 50, offset: 0 });
  check("★ 占位会话不出现在活动会话列表里（archived 占位，不冒幽灵行）",
    !activeList.some((s) => s.id === runboardId), activeList.map((s) => s.id).slice(0, 5));
  const row = WorkflowRunRepo.get(runId);
  check("★ 运行史真的落库了（外键通过，不是被 catch 吞掉）", row !== null && row.sessionId === runboardId, row);
  // 幂等：再存一次不该多出第二行、也不该改掉已有会话的身份。
  save("success");
  const again = SessionRepo.get(runboardId);
  check("★ 重复保存是幂等的（不重复建会话/项目）",
    again !== null && again.createdAt === created?.createdAt, { before: created?.createdAt, after: again?.createdAt });
}

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} 通过`);
if (failures > 0) {
  console.log(`${failures} 条没过`);
  process.exit(1);
}
console.log("全部通过");
