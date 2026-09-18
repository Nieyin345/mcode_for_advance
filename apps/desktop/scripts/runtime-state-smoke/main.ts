/**
 * Headless smoke for **runtime state / persistence 边界**(PAR-B)。
 *
 * ## 它验的是什么
 *
 * run-store-smoke(另一份,已提交)管的是存储层与跨进程迁移;这一份管**状态语义**:
 *
 *  1. **身份层级**:`WorkflowRunIdentity(sessionId ⊇ runId)` ⊇ `WorkflowNodeRunIdentity(+ nodeId)`
 *     —— 契约类型本身(见 `@contracts/runtime` 的 PAR-B 边界注释)。
 *  2. **快照信封**:`saveRun` 写出的 payload 带 `version` / `capturedAt`;解码后
 *     record / rounds / picks / outcomes / awaiting / entry 原样往返;
 *     `workflow_runs.awaiting` 列与 `state.awaiting` 是同一时刻从同一份状态写出的投影。
 *  3. **旧存档兼容**:没有 `version` / `capturedAt` 的 payload(老进程写的)照样读得回来;
 *     未来版本、非 JSON、缺 `cwd` 才整份拒绝。
 *  4. **元素级加固**:坏元组 / 坏结局只丢那一个元素,其余照读 —— 坏掉的 `attempts`
 *     不会让续跑在 `new Map(...)` 处炸掉(crash recovery 的那道门)。
 *  5. **resume 边界**:被中断且停在某一格的运行能按格找到;settled 节点的 outcomes
 *     原样交还(它们进 `RunResume.settled`,调度器因此不重跑已定案的节点 —— 调度
 *     行为本身由 scheduler-smoke 验,这里验的是持久化层交出去的东西没走样)。
 *  6. **run 历史**:`runHistory` 从同一份快照折出完整运行;存档读不回来的行**照样列出**
 *     (snapshot 为 null)—— "发生过"与"可续跑"是两个判据。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 换成 `$MCODE_SMOKE_DATA_ROOT`(见 `stubs/`),run.sh 用 `mktemp -d` 建的
 * 目录,跑完就删。单进程即可:跨进程的 `interrupted` 迁移是 run-store-smoke 的题。
 *
 * Run: scripts/runtime-state-smoke/run.sh
 */
import assert from "node:assert/strict";
import type { Session } from "@contracts/session";
import type { NodeOutcome } from "@contracts/nodeType";
import { WORKFLOW_RUN_SNAPSHOT_VERSION, type WorkflowNodeRunIdentity, type WorkflowRunIdentity } from "@contracts/runtime";
import { initDb, getDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, WorkflowRunRepo } from "@main/store/repositories.js";
import {
  decodeSnapshot,
  resumableRun,
  runHistory,
  saveRun,
  type RunSnapshot,
} from "@main/orchestration/runStore.js";

let failures = 0;
let total = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
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

const PROJECT = "p_rt";
const SESSION = "s_rt";
/** 主体运行:一次带全量字段的运行,第 2/5/6 部分都用它。 */
const RUN_MAIN = "run_rt_main";
/** 故意写坏 payload 的那一条,验历史里"读不回来照样列出"。 */
const RUN_BROKEN = "run_rt_broken";

/** 一份带全量字段的存档 —— 空的那份往返一次什么都验不出来。 */
function snapshotOf(awaiting: string[]): RunSnapshot {
  const outcomeWithArtifact: NodeOutcome = {
    status: "success",
    summary: "产出了一份数据文件",
    outputs: { rows: 42 },
    // artifact 是**引用**:只带 uri 等定位信息,字节留在外部。
    artifacts: [{ kind: "file", uri: "file:///tmp/out.csv", name: "out.csv", mimeType: "text/csv" }],
    execution: { executorKind: "code", startedAt: 1, finishedAt: 2, durationMs: 1 },
  };
  return {
    prompt: "写一篇引言",
    cwd: "D:\\proj",
    state: {
      record: [
        { kind: "step", nodeId: "A", title: "A", round: 1, body: "A 的结果" },
        { kind: "user", from: "F", label: "再改一轮", note: "只改他提到的地方", comment: "第三章删一半" },
      ],
      rounds: [["A", 1]],
      picks: [["F", { edgeId: "e_F__D", comment: "第三章删一半" }]],
      outcomes: [
        ["A", { status: "success", summary: "A 的结果" } as NodeOutcome],
        ["C", { status: "unselected", summary: "" } as NodeOutcome],
        ["D", outcomeWithArtifact],
      ],
      awaiting,
      entry: { nodeId: "T", summary: "定时触发" },
    },
    attempts: [["F", 2]],
  };
}

function seed(): void {
  const now = Date.now();
  ProjectRepo.create({
    id: PROJECT,
    name: "runtime-state 冒烟",
    path: "D:\\proj",
    archived: false,
    group: null,
    sortOrder: 0,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const session: Session = {
    id: SESSION,
    projectId: PROJECT,
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind: "chat",
    parentSessionId: null,
    title: "冒烟会话",
    status: "idle",
    model: "",
    effort: "default",
    permissionMode: "default",
    workflowId: "wf_test",
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
  };
  SessionRepo.create(session);
}

await initDb();
seed();

/* ── 1. 身份层级 ─────────────────────────────────────────── */

console.log("\n身份层级:sessionId ⊇ runId ⊇ nodeId");
const run: WorkflowRunIdentity = { runId: "run_1", sessionId: "session_1" };
const node: WorkflowNodeRunIdentity = { ...run, nodeId: "node_1" };
check("WorkflowNodeRunIdentity 是 WorkflowRunIdentity 的扩展", node.runId === run.runId && node.sessionId === run.sessionId);
check("nodeId 是图局部的第三层", typeof node.nodeId === "string");
eq("快照信封版本当前是 1", WORKFLOW_RUN_SNAPSHOT_VERSION, 1);

/* ── 2. 快照信封 + 往返 + 投影不变量 ─────────────────────── */

console.log("\nsaveRun:信封盖章,往返不丢形状");
saveRun({ runId: RUN_MAIN, sessionId: SESSION, workflowId: "wf_test", status: "running", snapshot: snapshotOf(["F", "H"]) });
const row = WorkflowRunRepo.get(RUN_MAIN);
check("行真的写下去了", row !== null);
const payload = JSON.parse(row?.payload ?? "{}") as Record<string, unknown>;
eq("payload 带 version", payload["version"], WORKFLOW_RUN_SNAPSHOT_VERSION);
check("payload 带 capturedAt", typeof payload["capturedAt"] === "number" && (payload["capturedAt"] as number) > 0);

const back = decodeSnapshot(row?.payload ?? "");
check("存档解得回来", back !== null);
eq("用户最初那句话原样回来", back?.prompt, "写一篇引言");
eq("当时在哪个目录里跑的也在", back?.cwd, "D:\\proj");
eq("流程记录原样回来", back?.state.record.length, 2);
eq("轮次原样回来", back?.state.rounds[0]?.[1], 1);
eq("岔路口的选择原样回来", back?.state.picks[0]?.[1].edgeId, "e_F__D");
eq("结局原样回来(三条)", back?.state.outcomes.length, 3);
eq("「没走这条路」也是原样的一种结局", back?.state.outcomes[1]?.[1].status, "unselected");
eq("触发器入口原样回来", back?.state.entry?.nodeId, "T");
eq("岔路口被问过几次也在", back?.attempts[0]?.[1], 2);
// **awaiting 列是 state.awaiting 的投影** —— 同一时刻、同一份状态写出。两处不一致
// 的话,"按格找运行"和"快照里停在哪"就是两份真相。
eq("awaiting 列 == state.awaiting(投影不变量)", row?.awaiting.join(","), back?.state.awaiting.join(","));

const artifact = back?.state.outcomes[2]?.[1].artifacts?.[0];
eq("artifact 在快照里是引用(uri)", artifact?.uri, "file:///tmp/out.csv");
check("artifact 不携带内容(没有 content/data 字段)", artifact !== undefined && !("content" in artifact) && !("data" in artifact));
eq("执行元数据(execution)随结局持久化", back?.state.outcomes[2]?.[1].execution?.executorKind, "code");

/* ── 3. 旧存档兼容 ───────────────────────────────────────── */

console.log("\n旧存档:没有 version 的照样读");
const legacy = {
  prompt: "老进程写的",
  cwd: "D:\\proj",
  state: {
    record: [],
    rounds: [["A", 1]],
    picks: [],
    outcomes: [["A", { status: "success", summary: "旧" }]],
    awaiting: [],
  },
  attempts: [["A", 1]],
};
const legacyBack = decodeSnapshot(JSON.stringify(legacy));
check("★ 没有 version 的旧存档读得回来", legacyBack !== null);
eq("旧存档的内容原样", legacyBack?.prompt, "老进程写的");

check("未来版本整份拒绝", decodeSnapshot(JSON.stringify({ ...legacy, version: 99 })) === null);
check("非 JSON 整份拒绝", decodeSnapshot("这不是JSON{") === null);
check("缺 cwd 整份拒绝(补不出来)", decodeSnapshot(JSON.stringify({ prompt: "x", state: legacy.state, attempts: [] })) === null);
check("缺 state 整份拒绝", decodeSnapshot(JSON.stringify({ prompt: "x", cwd: "D:\\proj" })) === null);
const badEntry = decodeSnapshot(
  JSON.stringify({ ...legacy, state: { ...legacy.state, entry: { nodeId: 42 } } }),
);
check("entry 形状不对时丢 entry、其余照读", badEntry !== null && badEntry.state.entry === undefined);

/* ── 4. 元素级加固(crash recovery 的那道门) ─────────────── */

console.log("\n元素级加固:坏元素只丢那一个,其余照读");
const polluted = decodeSnapshot(
  JSON.stringify({
    version: WORKFLOW_RUN_SNAPSHOT_VERSION,
    prompt: "污染过的",
    cwd: "D:\\proj",
    state: {
      record: [{ kind: "step", nodeId: "A", title: "A", round: 1, body: "x" }, 42, null],
      rounds: [["A", 1], ["B", "two"], null],
      picks: [["F", { edgeId: "e1" }], ["G", { noEdgeId: true }], "junk"],
      outcomes: [["A", { status: "success", summary: "好" }], ["B", { status: "爆炸", summary: 3 }], ["C", null]],
      awaiting: ["F", 7, null],
    },
    attempts: [["F", 2], [1, 2], "junk"],
  }),
);
check("被污染的存档整体仍然可读", polluted !== null);
eq("record 丢了非对象条目", polluted?.state.record.length, 1);
eq("rounds 丢了非 [string, number] 元组", polluted?.state.rounds.length, 1);
eq("picks 丢了没有 edgeId 的选择", polluted?.state.picks.length, 1);
eq("outcomes 丢了 status 不合法的结局", polluted?.state.outcomes.length, 1);
eq("awaiting 丢了非字符串", polluted?.state.awaiting.join(","), "F");
eq("attempts 丢了非 [string, number] 元组", polluted?.attempts.length, 1);
// 加固的动机:坏元组进了 runner 的 `new Map(attempts)` 会直接抛 —— 续跑就此炸掉。
check("attempts 现在能安全地进 new Map", (() => {
  try {
    new Map(polluted?.attempts ?? []);
    return true;
  } catch {
    return false;
  }
})());

/* ── 5. resume 边界 ──────────────────────────────────────── */

console.log("\nresume:按格找运行,settled 结局原样交还");
check("还在跑的运行不给续", resumableRun(SESSION, "F") === null);
saveRun({
  runId: RUN_MAIN,
  sessionId: SESSION,
  workflowId: "wf_test",
  status: "interrupted",
  snapshot: snapshotOf(["F", "H"]),
});
const resumable = resumableRun(SESSION, "F");
check("★ 停在 F 这一格的运行找得到", resumable !== null);
check("停在 H 这一格的同一份运行也找得到(两处岔路口可同时等)", resumableRun(SESSION, "H") !== null);
check("不在 awaiting 里的一格找不到", resumableRun(SESSION, "Z") === null);
eq("runId 沿用旧 id", resumable?.runId, RUN_MAIN);
// **settled 节点不重复执行的持久化前提**:outcomes 原样交还,调度器把它们放进
// `RunResume.settled`,已经定案的节点就不再派发。这里验"交出去的没走样"。
eq("settled outcomes 完整交还(3 条)", resumable?.snapshot.state.outcomes.length, 3);
eq("settled 的选择也在", resumable?.snapshot.state.picks[0]?.[1].edgeId, "e_F__D");

/* ── 6. run 历史 ─────────────────────────────────────────── */

console.log("\nrun 历史:同一份快照折出,读不回来的照样列出");
getDb().run(
  `INSERT INTO workflow_runs (id, session_id, workflow_id, status, awaiting_node, payload, created_at, updated_at)
   VALUES (?, ?, ?, 'failed', '', '{坏掉的', 1, 2)`,
  [RUN_BROKEN, SESSION, "wf_test"],
);
const history = runHistory(SESSION, 10);
eq("两条都列出(主运行 + 坏档)", history.length, 2);
check("新的在前", history[0]?.runId === RUN_MAIN);
const mainEntry = history.find((h) => h.runId === RUN_MAIN);
eq("身份字段在行上", mainEntry?.sessionId, SESSION);
eq("workflowId 在行上", mainEntry?.workflowId, "wf_test");
eq("结局状态在行上", mainEntry?.status, "interrupted");
check("createdAt/updatedAt 在行上", typeof mainEntry?.createdAt === "number" && typeof mainEntry?.updatedAt === "number");
check("主运行的快照完整", mainEntry?.snapshot !== null && mainEntry?.snapshot !== undefined);
const brokenEntry = history.find((h) => h.runId === RUN_BROKEN);
check("★ 存档读不回来的行照样列出(发生过是真的)", brokenEntry !== undefined);
check("坏档的 snapshot 为 null(不可续,但存在)", brokenEntry?.snapshot === null);

console.log(`\nruntime-state smoke: ${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
