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
import { initDb, getDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, WorkflowRunRepo } from "@main/store/repositories.js";
import { decodeSnapshot, resumableRun, retryableRun, saveRun, type RunSnapshot } from "@main/orchestration/runStore.js";

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

  // ② 那一步没失败(是成功的 / 是下游的 skipped)→ 不重跑。
  //    ⚠️ 这一道最要紧:少了它,用户点「再试一次」会从一步**根本没跑过**的地方重跑。
  check("★ 成功了的那一步不能重跑", retryableRun(SESSION_FAILED, FAILED_RUN, "A") === null);
  check("★ 下游那个 skipped 也不能重跑", retryableRun(SESSION_FAILED, FAILED_RUN, "C") === null);
  check("★ 存档里根本没有的节点不能重跑", retryableRun(SESSION_FAILED, FAILED_RUN, "Z") === null);

  // ③ 状态不是 failed → 不重跑(它跑成了 / 被取消了 / 还在跑)。
  saveRun({
    runId: "run_done",
    sessionId: SESSION_FAILED,
    workflowId: "wf_test",
    status: "success",
    snapshot: snapshotOf([]),
  });
  check("★ 跑成功的运行不能重试", retryableRun(SESSION_FAILED, "run_done", "B") === null);

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
}

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
