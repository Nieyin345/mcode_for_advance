import { workflowReplayError } from "@main/orchestration/workflowTrust.js";
/**
 * Headless smoke for **工作流运行的存档**(`main/orchestration/runStore.ts` +
 * `workflow_runs` 表)。
 *
 * ## 它验的是什么
 *
 * 这一层有四件事**只有真的落一次盘、真的重启一次进程**才验得了:
 *
 *  1. 写下去的那一行读得回来 —— 而且形状在 JSON 往返里一样没丢;
 *  2. **上一次进程死掉时还在跑的那些,下一次启动会被标成 `interrupted`** ——
 *     这是"能不能续跑"的**唯一判据**,而它写在 `db.ts` 的启动路径里;
 *  3. `resumableFor` 按"停在这一格"找,而且认的是**一整张列表**(两处岔路口可以
 *     同时停在等人);
 *  4. `pruneSession` 真的会把旧行删掉。
 *
 * 调度器那一半(续跑时谁重跑、谁不重跑)在 `scripts/scheduler-smoke` 里,不需要数据库。
 * 两半合起来才是完整的"进程死了还能接着跑"。
 *
 * ## 为什么要跑两遍
 *
 * 第 2 条**按定义**跨进程:`initDb` 在一个进程里是记忆化的,迁移不会跑第二次。所以
 * `run.sh` 分两趟 —— 第一趟(`write`)留下一个 `running` 的行,第二趟(`verify`)是
 * **全新的 node 进程**,它启动时跑迁移,那一行就该变成 `interrupted`。同一个进程里
 * 假装"重启一次"是做不到的,硬做出来的断言不算数。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 换成 `$MCODE_SMOKE_DATA_ROOT`(见 `stubs/`),那是 run.sh 用 `mktemp -d`
 * 建的目录,跑完就删。**不是 `~/Mcode`** —— 这一点很要紧,因为 `initDb()` 在路径不存在
 * 时会**新建一个空库**。
 *
 * Run: scripts/run-store-smoke/run.sh
 */
import type { Session } from "@contracts/session";
import type { NodeOutcome } from "@contracts/nodeType";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { readFileSync } from "node:fs";
import { armFault, clearFault, faultHits } from "../db-persistence-smoke/stubs/fs.js";
import { join } from "node:path";
import { initDb, getDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, WorkflowRunRepo } from "@main/store/repositories.js";
import { decodeSnapshot, resumableRun, retryableRun, saveRun, type RunSnapshot } from "@main/orchestration/runStore.js";
import { dataRoot, DATA_DB_FILENAME } from "./stubs/dataRoot.js";

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

/** 两趟共用的 id —— 第二趟靠它们把第一趟留下的行找回来。 */
const PROJECT = "p_smoke";
/** 那个"断在这儿"的对话。整趟只跑过**一次**运行,所以查到的一定是它。 */
const SESSION_RESUMABLE = "s_resumable";
/** 只用来验 `pruneSession` 的对话。 */
const SESSION_PRUNED = "s_pruned";
const RUN_LEFT = "run_left";

const outcomesOf = (pairs: ReadonlyArray<readonly [string, string]>): [string, NodeOutcome][] =>
  pairs.map(([id, status]) => [id, { status: status as NodeOutcome["status"], summary: `${id} 的结果` }]);

/** 一份带内容的存档 —— 空的那份往返一次什么都验不出来。 */
function snapshotOf(awaiting: string[], prompt = "写一篇引言"): RunSnapshot {
  return {
    prompt,
    cwd: "D:\\proj",
    attempts: [["F", 2]],
    state: {
      record: [
        { kind: "step", nodeId: "A", title: "A", round: 1, body: "A 的结果" },
        {
          kind: "user",
          from: "F",
          label: "再改一轮",
          note: "只改他提到的地方",
          comment: "第三章删一半",
        },
      ],
      rounds: [["A", 1]],
      picks: [["F", { edgeId: "e_F__D", comment: "第三章删一半" }]],
      outcomes: outcomesOf([
        ["A", "success"],
        ["C", "unselected"],
      ]),
      awaiting,
    },
  };
}

function countRuns(sessionId: string): number {
  const stmt = getDb().prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE session_id = ?");
  stmt.bind([sessionId]);
  stmt.step();
  const n = Number((stmt.getAsObject() as { n: number }).n);
  stmt.free();
  return n;
}

/** 建一个项目 + 两个对话。`workflow_runs.session_id` 是有外键的(启动时 `PRAGMA
 *  foreign_keys = ON`),所以不能凭空写一行运行。 */
function seed(): void {
  const now = Date.now();
  ProjectRepo.create({
    id: PROJECT,
    name: "冒烟",
    path: "D:\\proj",
    archived: false,
    group: null,
    sortOrder: 0,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  for (const id of [SESSION_RESUMABLE, SESSION_PRUNED]) {
    const session: Session = {
      id,
      projectId: PROJECT,
      providerId: "claude-sdk",
      claudeSessionId: null,
      kind: "chat",
      parentSessionId: null,
      nodeId: null,
      title: "冒烟会话",
      status: "idle",
      model: "",
      effort: "default",
      permissionMode: "default",
      workflowId: "write",
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
}

const MODE = process.argv[2];
await initDb();

if (MODE === "write") {
  // Fresh installs no longer allocate storage for two retired composer features.
  // An older DB is tested separately by db-migrate-smoke: its legacy data stays.
  const oldTable = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'long_tasks'");
  check("新库不再创建长任务表", !oldTable.step());
  oldTable.free();
  const oldColumn = getDb().prepare("SELECT name FROM pragma_table_info('sessions') WHERE name = 'active_plugin_names'");
  check("新库不再创建会话插件列", !oldColumn.step());
  oldColumn.free();
  seed();

  console.log("\n写一行运行:形状在往返里不能丢");

  saveRun({
    runId: RUN_LEFT,
    sessionId: SESSION_RESUMABLE,
    workflowId: "wf_test",
    status: "running",
    snapshot: snapshotOf(["F", "H"]),
  });

  const row = WorkflowRunRepo.get(RUN_LEFT);
  check("行真的写下去了", row !== null);
  eq("状态是 running", row?.status, "running");
  // ⚠️ 两格都在 —— 一条运行里可以**同时**有两处岔路口在等人。存单个的话,用户点
  // 先停下的那一处会看到"这条选择已经不适用了"。
  eq("停在哪几格记在列上(逗号分隔,两格都在)", row?.awaiting.join(","), "F,H");

  const back = decodeSnapshot(row?.payload ?? "");
  check("存档解得回来", back !== null);
  eq("旧存档仍可读作历史,但没有图版本", back?.workflowRevision, undefined);
  const pinned = { ...snapshotOf([]), workflowRevision: "a".repeat(64), inFlightNodeIds: ["command"] };
  eq("新存档的图版本往返后没有丢", decodeSnapshot(JSON.stringify(pinned))?.workflowRevision, pinned.workflowRevision);
  eq("新存档的执行中节点往返不丢", decodeSnapshot(JSON.stringify(pinned))?.inFlightNodeIds?.[0], "command");
  check("存档中伪造的坏图版本拒绝读取", decodeSnapshot(JSON.stringify({ ...pinned, workflowRevision: "bad" })) === null);
  check("存档中坏执行列表拒绝读取", decodeSnapshot(JSON.stringify({ ...pinned, inFlightNodeIds: [1] })) === null);
  check("已绑定图的坏结局不能被丢弃后重跑已执行节点", decodeSnapshot(JSON.stringify({
    ...pinned, state: { ...pinned.state, outcomes: [["A", { status: "unknown", summary: "was done" }]] },
  })) === null);
  check("已绑定图的坏选择不能唤醒错误支路", decodeSnapshot(JSON.stringify({
    ...pinned, state: { ...pinned.state, picks: [["F", { edgeId: "" }]] },
  })) === null);
  check("已绑定图的坏等待列表不可续跑", decodeSnapshot(JSON.stringify({
    ...pinned, state: { ...pinned.state, awaiting: [1] },
  })) === null);
  eq("无图版本的旧快照仍可宽松读取历史", decodeSnapshot(JSON.stringify({
    ...snapshotOf([]), state: { ...snapshotOf([]).state, outcomes: [["A", { status: "unknown", summary: "" }]] },
  }))?.state.outcomes.length, 0);
  eq("用户最初那句话原样回来", back?.prompt, "写一篇引言");
  eq("当时在哪个目录里跑的也在", back?.cwd, "D:\\proj");
  eq("流程记录原样回来", back?.state.record.length, 2);
  eq("用户那一次选择也在", back?.state.record[1]?.kind, "user");
  eq("轮次原样回来", back?.state.rounds[0]?.[1], 1);
  eq("岔路口的选择原样回来", back?.state.picks[0]?.[1].edgeId, "e_F__D");
  eq("结局原样回来", back?.state.outcomes.length, 2);
  eq("岔路口被问过几次也在", back?.attempts[0]?.[1], 2);
  eq("「没走这条路」也是原样的一种结局", back?.state.outcomes[1]?.[1].status, "unselected");

  // **还在跑的运行不能续。** 判据是 `status = 'interrupted'` —— 要是这条也放行,
  // 用户点一张当前这轮刚发出来的卡片会去**再起一次**运行。
  check("★ 还在跑的运行不给续", WorkflowRunRepo.resumableFor(SESSION_RESUMABLE, "F") === null);

  console.log("\n同一份存档再写一次:覆盖那一行,不新开一行");
  saveRun({
    runId: RUN_LEFT,
    sessionId: SESSION_RESUMABLE,
    workflowId: "wf_test",
    status: "running",
    snapshot: snapshotOf(["F", "H"], "改一版引言"),
  });
  eq("还是一行", countRuns(SESSION_RESUMABLE), 1);
  eq(
    "内容换成了新的",
    decodeSnapshot(WorkflowRunRepo.get(RUN_LEFT)?.payload ?? "")?.prompt,
    "改一版引言",
  );
  eq(
    "created_at 没有被改写(它是「这次运行什么时候开始的」)",
    WorkflowRunRepo.get(RUN_LEFT)?.createdAt,
    row?.createdAt,
  );

  console.log("\n清理:一个对话只留最近几次运行");
  for (let i = 0; i < 3; i += 1) {
    saveRun({
      runId: `run_old_${i}`,
      sessionId: SESSION_PRUNED,
      workflowId: "wf_test",
      status: "success",
      snapshot: snapshotOf([]),
    });
  }
  eq("先有三次", countRuns(SESSION_PRUNED), 3);
  WorkflowRunRepo.pruneSession(SESSION_PRUNED, 2);
  eq("留两次", countRuns(SESSION_PRUNED), 2);
  check("留下的不是最早那次", WorkflowRunRepo.get("run_old_0") === null);

  console.log("\n关键在飞快照:返回前已在磁盘,失败不能假装成功");
  const SQL = await initSqlJs();
  const dbFile = join(dataRoot(), DATA_DB_FILENAME);
  const diskPayload = (id: string): string | null => {
    const copy = new SQL.Database(readFileSync(dbFile));
    const stmt = copy.prepare("SELECT payload FROM workflow_runs WHERE id = ?");
    stmt.bind([id]);
    const payload = stmt.step() ? String(stmt.getAsObject().payload) : null;
    stmt.free();
    copy.close();
    return payload;
  };
  const critical = { ...snapshotOf([]), workflowRevision: "a".repeat(64), inFlightNodeIds: ["command"] };
  eq("关键快照的调用成功", saveRun({
    runId: "run_durable", sessionId: SESSION_PRUNED, workflowId: "wf_test", status: "running",
    snapshot: critical,
  }, { durable: true }), true);
  // No await between saveRun and reading from a SEPARATE SQLite handle:
  // a queued microtask flush alone cannot make this assertion pass.
  eq("节点执行前磁盘已经有在飞标记", decodeSnapshot(diskPayload("run_durable") ?? "")?.inFlightNodeIds?.[0], "command");

  // Inject a real partial write, independent of the private staging filename.
  armFault(dbFile, "write");
  try {
    eq("物理写失败时关键快照必须返回失败", saveRun({
      runId: "run_durable_fail", sessionId: SESSION_PRUNED, workflowId: "wf_test", status: "running",
      snapshot: critical,
    }, { durable: true }), false);
    check("故障确实击中了数据库写入", faultHits > 0);
    eq("物理写失败未篡改上次完好的磁盘库", diskPayload("run_durable_fail"), null);
  } finally {
    clearFault();
  }

  // ⚠️ 这一趟**故意把 RUN_LEFT 留成 `running`** —— 第二趟那个新进程启动时跑迁移,
  //    它就该变成 `interrupted`。那正是"应用被关掉"这件事在磁盘上留下的样子。
  console.log("\n(第一趟结束:那个对话里留着一行 `running`)");
} else {
  console.log("\n重启之后:上一次还在跑的那些会被标成「被中断」");

  const row = WorkflowRunRepo.get(RUN_LEFT);
  check("那一行还在(数据没丢)", row !== null);
  // ★ 这一条是整件事的判据。`db.ts` 的启动路径里那句 UPDATE 干的。
  eq("★ 启动时被标成 interrupted", row?.status, "interrupted");
  eq("停在哪几格没被这一下改掉", row?.awaiting.join(","), "F,H");

  console.log("\n按「停在这一格」找那次运行");
  check("★ 第一格找得到", WorkflowRunRepo.resumableFor(SESSION_RESUMABLE, "F") !== null);
  // ★ 第二个元素也要找得到 —— 只存最后一个的话,用户点**先停下的那一处**会扑空。
  check("★ 列表里的第二格同样找得到", WorkflowRunRepo.resumableFor(SESSION_RESUMABLE, "H") !== null);
  check("不在列表里的一格找不到", WorkflowRunRepo.resumableFor(SESSION_RESUMABLE, "Z") === null);
  check("别的对话找不到", WorkflowRunRepo.resumableFor(SESSION_PRUNED, "F") === null);

  console.log("\n把存档读回来(这一趟是全新的进程)");
  const found = resumableRun(SESSION_RESUMABLE, "F");
  check("★ 这一次运行可以续", found !== null);
  eq("runId 就是当初那一个", found?.runId, RUN_LEFT);
  eq("流程名字也在", found?.workflowId, "wf_test");
  eq("用户最初那句话原样回来", found?.snapshot.prompt, "改一版引言");
  eq("记录原样回来", found?.snapshot.state.record.length, 2);
  eq("结局原样回来", found?.snapshot.state.outcomes.length, 2);
  eq("岔路口的选择原样回来", found?.snapshot.state.picks[0]?.[1].edgeId, "e_F__D");

  console.log("\n失败重试:四道门");

  /**
   * `retryableRun` 是「再试一次」唯一的判据来源,而它的四道门各自对应界面上一种
   * "这张卡不适用了"。这里**每一道都正面撞一次** —— 少了任意一道,重跑会从一步
   * 根本没跑过的地方开始,或者去续一次已经跑完的运行。
   */
  const FAILED_RUN = "run_failed";
  const SESSION_FAILED = "s_failed";
  /** 建一个能重试的对话:`B` 失败、`A` 成功。 */
  {
    const now = Date.now();
    const session: Session = {
      id: SESSION_FAILED,
      projectId: PROJECT,
      providerId: "claude-sdk",
      claudeSessionId: null,
      kind: "chat",
      parentSessionId: null,
      nodeId: null,
      title: "重试",
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
  saveRun({
    runId: FAILED_RUN,
    sessionId: SESSION_FAILED,
    workflowId: "wf_test",
    status: "failed",
    snapshot: {
      prompt: "跑一条链",
      cwd: "D:\\proj",
      attempts: [],
      state: {
        record: [],
        rounds: [],
        picks: [],
        outcomes: [
          ["A", { status: "success", summary: "A 的结果" }],
          ["B", { status: "failed", summary: "", error: "B 炸了" }],
          ["C", { status: "skipped", summary: "" }],
        ],
        awaiting: [],
      },
    },
  });

  // ① 这一道是**能重跑**的那一种。
  const canRetry = retryableRun(SESSION_FAILED, FAILED_RUN, "B");
  check("★ 失败的运行 + 失败的那一步 → 能重试", canRetry !== null);
  eq("runId 就是它", canRetry?.runId, FAILED_RUN);
  eq("存档里的结局表原样带出来", canRetry?.snapshot.state.outcomes.length, 3);
  eq("★ 结局一起交出来(调用方靠它分辨两种重跑)", canRetry?.outcome?.status, "failed");

  /**
   * ② **成功过的那一步也能重跑** —— 用户在图上看中一步说"从这儿往下走"。
   *
   * ⚠️ 这一条**以前是反的**(这里原先断言的是"成功了的那一步不能重跑")。改成现在
   * 这样是因为用户要的是"从任一步接着往下":一张跑完了的图,他看中中间某一步、想从
   * 那儿重来一遍 —— 那正是迭代写作的常规动作。拦着它的是 `retryableRun` 里那两道
   * "必须是 failed"的门,而它们把这件事表达成了"这张卡不适用了",它明明适用。
   *
   * 判据仍要立得住的那一条是**"那一步得在存档的结局表里"**:少了它,重跑会从一步
   * 根本没跑过的地方开始(见下面 `Z`)。
   */
  const fromSuccess = retryableRun(SESSION_FAILED, FAILED_RUN, "A");
  check("★ 成功过的那一步也能重跑(图上挑起点)", fromSuccess !== null);
  eq("★ 它的结局是 success —— 调用方据此不带 note", fromSuccess?.outcome?.status, "success");
  // `skipped` 也照样:它在结局表里,而"从这一步往下"对用户是一句有效的话 ——
  // 他要的是"重跑这一片",这一步上次是跳过还是失败不影响那个意图。
  const fromSkipped = retryableRun(SESSION_FAILED, FAILED_RUN, "C");
  check("★ 上次被跳过的也能重跑", fromSkipped !== null);
  eq("它的结局是 skipped", fromSkipped?.outcome?.status, "skipped");
  // ⚠️ **这一道不能松**:存档里根本没有的节点,重跑会从一步没跑过的地方开始。
  check("★ 存档里根本没有的节点不能重跑", retryableRun(SESSION_FAILED, FAILED_RUN, "Z") === null);

  // ③ **跑成功的运行照样能从那一步重跑** —— 这就是"图跑完了还能接着迭代"那条路。
  //    (以前这一条是反的:那时只有失败卡的按钮会走到这里。)
  saveRun({
    runId: "run_done",
    sessionId: SESSION_FAILED,
    workflowId: "wf_test",
    status: "success",
    snapshot: snapshotOf([]),
  });
  check(
    "★ 跑成功的运行里、有结局的那一步能重跑",
    retryableRun(SESSION_FAILED, "run_done", "A") !== null,
  );
  // 反过来的那一道还得在:那一步不在这次运行的结局表里,照样不能重跑。
  check(
    "★ 跑成功的运行里、没有结局的那一步仍然不能重跑",
    retryableRun(SESSION_FAILED, "run_done", "Z") === null,
  );

  // ④ 找不到那一行 / 不属于这个对话 → 不重跑。
  check("★ 不存在的 runId 不能重试", retryableRun(SESSION_FAILED, "run_nope", "B") === null);
  check(
    "★ 别的对话的 runId 不能重试(卡片是别人的)",
    retryableRun(SESSION_RESUMABLE, FAILED_RUN, "B") === null,
  );

  // ⑤ 存档读不回来 → 不重跑。**故意的坏数据**:那一行在,但 payload 不是 JSON。
  saveRun({
    runId: "run_broken",
    sessionId: SESSION_FAILED,
    workflowId: "wf_test",
    status: "failed",
    snapshot: snapshotOf([]),
  });
  getDb().run("UPDATE workflow_runs SET payload = ? WHERE id = ?", ["{oops", "run_broken"]);
  check("★ 存档读不回来 → 不能重试", retryableRun(SESSION_FAILED, "run_broken", "B") === null);
  const interruptedSnapshot: RunSnapshot = {
    prompt: "interrupted", cwd: process.cwd(), attempts: [], workflowRevision: "a".repeat(64),
    inFlightNodeIds: ["unfinished"],
    state: { record: [], rounds: [], picks: [], outcomes: [], awaiting: [] },
  };
  saveRun({ runId: "journal_only", sessionId: SESSION_FAILED, workflowId: "wf_test", status: "interrupted", snapshot: interruptedSnapshot });
  const journal = retryableRun(SESSION_FAILED, "journal_only", "unfinished");
  check("an interrupted in-flight node has a continuation lookup even without an outcome", journal !== null);
  eq("lookup never fabricates an outcome for the interrupted node", journal?.outcome, undefined);
  check("journal-only lookup still rejects a different node", retryableRun(SESSION_FAILED, "journal_only", "other") === null);
  check("journal-only lookup still checks ownership", retryableRun(SESSION_RESUMABLE, "journal_only", "unfinished") === null);

}

// The origin belongs to the run, including restart/retry, not a reused session.
{
  const raw = { ...snapshotOf([]), originSessionId: "origin-for-this-run" };
  const decoded = decodeSnapshot(JSON.stringify(raw));
  eq("run origin survives snapshot decode", decoded && "originSessionId" in decoded ? decoded.originSessionId : undefined, raw.originSessionId);
  const manual = decodeSnapshot(JSON.stringify({ ...raw, originSessionId: null }));
  eq("explicitly absent origin survives decode", manual && "originSessionId" in manual ? manual.originSessionId : undefined, null);
  eq("invalid origin rejects snapshot", decodeSnapshot(JSON.stringify({ ...raw, originSessionId: 42 })), null);
}

// FG0-E: replay safety follows actual executor semantics, not a hard-coded type name.
{
  const doc = { id: "replay", name: "Replay", builtin: false, updatedAt: 0, edges: [],
    nodes: [{ id: "pure", type: "mcode.condition", title: "Pure", params: {}, position: { x: 0, y: 0 } }] };
  eq("builtin pure condition can resume", workflowReplayError(doc, ["pure"]), null);
  const custom = { ...doc, nodes: [{ ...doc.nodes[0], type: "extension.condition" }] };
  const safe = new Map([["extension.condition", { runner: { kind: "condition" as const } }]]);
  eq("custom pure condition follows its runner kind", workflowReplayError(custom, ["pure"], safe), null);
  check("unknown custom type fails closed", workflowReplayError(custom, ["pure"]) !== null);
  check("missing node fails closed", workflowReplayError(doc, ["missing"]) !== null);
  check("missing in-flight journal fails closed", workflowReplayError(doc, undefined) !== null);
  const command = new Map([["extension.condition", { runner: { kind: "command" as const } }]]);
  check("a condition-like name cannot whitelist a command", workflowReplayError(custom, ["pure"], command) !== null);
}

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
