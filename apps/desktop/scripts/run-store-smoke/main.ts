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
import { readFileSync, readdirSync } from "node:fs";
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
  // 【ARC-016】配置快照:往返不丢、形状坏就丢。
  {
    const withCfg = { ...snapshotOf([]), configSnapshot: { takenAt: 12345, profiles: { p_research_v1: "deadbeef" }, skills: ["lit"], providerId: "pi-sdk", model: "m1" } };
    const rt = decodeSnapshot(JSON.stringify(withCfg));
    eq("配置快照往返后还在", rt?.configSnapshot?.takenAt, 12345);
    eq("配置快照里的档案哈希往返不丢", rt?.configSnapshot?.profiles?.p_research_v1, "deadbeef");
    eq("配置快照里的技能往返不丢", rt?.configSnapshot?.skills?.[0], "lit");
    check("配置快照形状坏(profiles 是数组)→ 丢弃,不塞给审计",
      decodeSnapshot(JSON.stringify({ ...withCfg, configSnapshot: { takenAt: 1, profiles: [], skills: [] } }))?.configSnapshot === undefined);
  }
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
    let copy: InstanceType<typeof SQL.Database>;
    try { copy = new SQL.Database(readFileSync(dbFile)); }
    catch { return null; } // 磁盘文件被半写污染时,读侧干净地返回"读不到",别让整套崩在解析上
    try {
      const stmt = copy.prepare("SELECT payload FROM workflow_runs WHERE id = ?");
      stmt.bind([id]);
      const payload = stmt.step() ? String(stmt.getAsObject().payload) : null;
      stmt.free();
      return payload;
    } catch { return null; } finally { copy.close(); }
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

  /* ── 【MC-053】编码失败的存档**不得**覆盖上一次有效快照 ──────────────
   *
   * 从前 `saveRun` 在快照无法序列化(循环引用 / BigInt)时把 payload 置成**空串**
   * 照样写库 —— "落一行空的也比不落强"。结果是**上一次好好的可恢复快照被空串覆盖**,
   * 而 `decodeSnapshot("")` 必然读不回来:失败返回 false 已经晚了,旧存档已经毁在这一句里。
   * 这只是"return false 前就已经做了破坏性写入",调用方再检查布尔值也救不回旧快照。
   *
   * 现在:编码**先于任何仓储写入**,失败即 return false、**一个字节都不落库**。 */
  saveRun({
    runId: "run_encode_v1", sessionId: SESSION_PRUNED, workflowId: "wf_test", status: "failed",
    snapshot: snapshotOf([]),
  }, { durable: true });
  const v1Raw = diskPayload("run_encode_v1") ?? "";
  check("前置:V1 是一份有效快照(可解码)", decodeSnapshot(v1Raw) !== null, v1Raw.length);

  // V2:造一个**循环引用**的快照 → encode 必抛。
  const circular: RunSnapshot = snapshotOf([]);
  (circular as unknown as Record<string, unknown>).self = circular;
  const encoded = saveRun({
    runId: "run_encode_v1", sessionId: SESSION_PRUNED, workflowId: "wf_test", status: "failed",
    snapshot: circular,
  }, { durable: true });
  eq("★ 编码失败的存档返回 false", encoded, false);
  const v1After = diskPayload("run_encode_v1") ?? "";
  eq("★ 上一次有效快照**逐字节未变**(没被空串覆盖)", v1After, v1Raw);
  check("★ 旧快照仍可解码(重启还能续跑)", decodeSnapshot(v1After) !== null, v1After.length);

  // ⚠️ 这一趟**故意把 RUN_LEFT 留成 `running`** —— 第二趟那个新进程启动时跑迁移,
  //    它就该变成 `interrupted`。那正是"应用被关掉"这件事在磁盘上留下的样子。

  /* ── 【MC-053 后半】能编码 ≠ 可解码:结构坏掉的快照不得覆盖上一次有效快照 ──
   *
   * 上面那条只挡住"JSON.stringify 抛错"(循环引用/BigInt)。可 JSON 能序列化**远远
   * 多于** decodeSnapshot 能读回的东西:一份 `state.record` 被写成字符串的快照,
   * 编码不抛、写库成功、返回 true —— 而读侧 `decodeSnapshot` 对刚落盘的这行返回 null,
   * 调用方以为"可续"、重启却续不上。第 13 轮复查的隔离反例就是这个 `invalidAccepted`。 */
  saveRun({
    runId: "run_shape_v1", sessionId: SESSION_PRUNED, workflowId: "wf_test", status: "failed",
    snapshot: snapshotOf([]),
  }, { durable: true });
  const s1Raw = diskPayload("run_shape_v1") ?? "";
  check("前置:可解码的快照写得进去(返回 true)", decodeSnapshot(s1Raw) !== null, s1Raw.length);

  // V2:结构坏掉 —— `state.record` 不是数组。JSON.stringify 照样能吐出来。
  const broken: RunSnapshot = snapshotOf([]);
  (broken.state as unknown as Record<string, unknown>).record = "not-an-array";
  const rawBroken = JSON.stringify({ ...broken, version: 1, capturedAt: Date.now() });
  check(
    "前置:这份坏快照 JSON 编码**不抛**(正是「能编码」骗过旧判据的那一格)",
    typeof rawBroken === "string" && rawBroken.length > 0,
    rawBroken.length,
  );
  const shapeSaved = saveRun({
    runId: "run_shape_v1", sessionId: SESSION_PRUNED, workflowId: "wf_test", status: "failed",
    snapshot: broken,
  }, { durable: true });
  eq("★ 结构通不过解码器的快照返回 false(不谎称可恢复)", shapeSaved, false);
  const s1After = diskPayload("run_shape_v1") ?? "";
  eq("★ 上一次有效快照**逐字节未变**(没被坏结构覆盖)", s1After, s1Raw);
  check("★ 旧快照仍可解码(重启还能续跑)", decodeSnapshot(s1After) !== null, s1After.length);

  /* ── 【MC-053 反例三】durable 落盘失败必须**回滚内存那一行** ──────────────
   *
   * 上面两条挡住的是"写库之前"的坏快照。但写库与落盘**不是原子的**:`WorkflowRunRepo.save`
   * 改的是**内存**里的 sql.js 表,`persistNowOrThrow` 才 fsync 到磁盘。第 16 轮复查抓住了
   * 这个窗口:先 save(内存行已被换成新快照)→ persistNowOrThrow 抛(磁盘故障)→ 只
   * return false。结果是**内存里那一行已经变了**(status=success、payload=新),而磁盘上还是
   * 上一次的 V1 —— 调用方以为"没写成、旧快照留着",可同一进程后续 `resumableRun`/`get` 读的
   * 是被污染的内存行,重启后又变回 V1,两处对不上(台账实测 oldCheckpointMutated=true)。
   *
   * 判据:落盘失败后,**内存**读回的仍是 V1(不是新提交的 V2)。 */
  saveRun({
    runId: "run_durable_rollback", sessionId: SESSION_PRUNED, workflowId: "wf_test", status: "running",
    snapshot: snapshotOf([]),
  }, { durable: true });
  const memV1 = WorkflowRunRepo.get("run_durable_rollback");
  const diskV1 = diskPayload("run_durable_rollback") ?? "";
  check("前置:V1 内存与磁盘都在", memV1 !== null && diskV1.length > 0 && decodeSnapshot(diskV1) !== null);

  armFault(dbFile, "write");
  try {
    const ok = saveRun({
      runId: "run_durable_rollback", sessionId: SESSION_PRUNED, workflowId: "wf_test", status: "success",
      snapshot: snapshotOf([]),
    }, { durable: true });
    eq("★ 落盘失败的 durable 保存返回 false", ok, false);
    const memAfter = WorkflowRunRepo.get("run_durable_rollback");
    eq("★★ 内存那一行**没有被污染**(status 仍是 V1 的 running,不是 V2 的 success)", memAfter?.status, "running");
    eq("★★ 内存 payload 仍是 V1(没被新快照覆盖)", memAfter?.payload, memV1?.payload);
    eq("磁盘仍是 V1(逐字节未变)", diskPayload("run_durable_rollback") ?? "", diskV1);
  } finally {
    clearFault();
  }

  /* ── 【MC-028】durable 关口在**真实 fsync / rename 失败**下的边界 ──────────
   *
   * runner 的两个"声称 durable"的关口(岔路口等待用户 / 整图收口)现在都 `if (!writeRun(...))`
   * 检查了返回值 —— 但 maint-m28-smoke §3 钉的是**源码级**判据。台账要的比这更强:在
   * **真的**让落盘那一步坏掉(写 / fsync / rename)时,durable 写必须返回 false、磁盘上那份
   * 旧快照一个字节不动、重启后读到的仍是旧快照 —— 而**绝不能**出现"报告成功、磁盘却没有"。
   * 这里把三种物理故障各撞一次。核心不变量:**durable 写说成功 ⟺ 磁盘上真有这一份**;
   * 失败时既不许假报成功、也不许把内存/磁盘的旧状态丢掉。 */
  console.log("\n【MC-028】durable 在真实 fsync/rename 故障下:报成功 ⟺ 磁盘上真有(无假成功、无丢状态)");
  {
    // 从**独立**句柄读磁盘上的 awaiting 列 —— "提交没提交"的判据不能靠内存。
    const diskAwaiting = (id: string): string | null => {
      let copy: InstanceType<typeof SQL.Database>;
      try { copy = new SQL.Database(readFileSync(dbFile)); }
      catch { return null; } // 磁盘被半写污染 → 干净地返回"读不到"
      try {
        const stmt = copy.prepare("SELECT awaiting_node FROM workflow_runs WHERE id = ?");
        stmt.bind([id]);
        const a = stmt.step() ? String(stmt.getAsObject().awaiting_node) : null;
        stmt.free();
        return a;
      } catch { return null; } finally { copy.close(); }
    };
    for (const fault of ["write", "sync", "rename"] as const) {
      const label = `run_durable_${fault}`;
      // V1:先落一份完好的快照(成功路径)—— awaiting 为空。
      saveRun({
        runId: label, sessionId: SESSION_PRUNED, workflowId: "wf_test", status: "running",
        snapshot: snapshotOf([]),
      }, { durable: true });
      const v1Disk = diskPayload(label) ?? "";
      check(`[${fault}] 前置:V1 已在磁盘上(可解码)`, decodeSnapshot(v1Disk) !== null, v1Disk.length);
      eq(`[${fault}] 前置:磁盘上 V1 的 awaiting 为空`, diskAwaiting(label), "");

      // 注入物理故障,提交 V2(改成 success,awaiting=["H"])。
      armFault(dbFile, fault);
      let ok = true;
      try {
        ok = saveRun({
          runId: label, sessionId: SESSION_PRUNED, workflowId: "wf_test", status: "success",
          snapshot: snapshotOf(["H"]),
        }, { durable: true });
      } finally {
        clearFault();
      }
      eq(`[${fault}] ★ 物理落盘失败时 durable 写返回 false(绝不假报成功)`, ok, false);
      check(`[${fault}] 故障确实击中了落盘`, faultHits > 0);
      // ★★ 磁盘：旧快照逐字节未变、未提交的 V2 一个字节都没落上。
      eq(`[${fault}] ★★ 磁盘仍是旧快照 V1(逐字节未变,没被半写污染)`, diskPayload(label) ?? "", v1Disk);
      eq(`[${fault}] ★★ 磁盘上未提交的 V2 状态没有出现(awaiting 仍是空)`, diskAwaiting(label), "");
      check(`[${fault}] ★★ 磁盘旧快照仍可解码(重启还能续跑)`, decodeSnapshot(diskPayload(label) ?? "") !== null);
      // ★★ 内存也被回滚到 V1 —— 否则同进程后续查询会读到被污染的"已成功"行。
      const mem = WorkflowRunRepo.get(label);
      eq(`[${fault}] ★★ 内存没被污染(status 仍是 V1 的 running,不是 V2 的 success)`, mem?.status, "running");
      eq(`[${fault}] ★★ 内存 payload 仍是 V1`, mem?.payload, v1Disk);

      // 故障解除后重试 → 成功,且磁盘 == 内存(V2 真的落上了)。
      const retry = saveRun({
        runId: label, sessionId: SESSION_PRUNED, workflowId: "wf_test", status: "success",
        snapshot: snapshotOf(["H"]),
      }, { durable: true });
      eq(`[${fault}] ★ 故障解除后重试返回成功`, retry, true);
      const diskAfter = diskPayload(label) ?? "";
      eq(`[${fault}] ★★ 重试成功后磁盘真的有了 V2(awaiting=H)`, diskAwaiting(label), "H");
      eq(`[${fault}] ★★ 重试成功后磁盘 == 内存(同一份 payload)`, WorkflowRunRepo.get(label)?.payload, diskAfter);
    }
    check(
      "★ 三次故障注入后没有遗留 .persist-*.tmp 暂存文件",
      readdirSync(dataRoot()).every((f) => !f.includes(".persist-")),
      readdirSync(dataRoot()),
    );
  }
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

  /* ── 【MC-028】durable 提交跨**真实进程重启**仍成立 ─────────────────────────
   *
   * 第一趟里那三条 `run_durable_{write,sync,rename}`:先落 V1、注入物理落盘故障(写/fsync/
   * rename),_V2 提交失败但旧快照与内存都保住_,再在故障解除后重试成功。这一趟是**全新的
   * node 进程**,库是从磁盘重新打开的 —— 磁盘上到底是什么,只有此刻才说了算。
   *
   * 判据:重启后那三行必须是 V2(success + awaiting=H)—— 说明重试那一次的 durable 提交
   * 真的落到了盘上、跨进程还在;而**不是**停在 V1(running)或某份被半写污染的态。注意启动
   * 迁移会把遗留的 `running` 行标成 `interrupted`,而 V2 是 `success`,不受影响 —— 所以"看到
   * success"同时证明了"V2 真的落上、没有被故障期的旧态盖回去"。 */
  for (const fault of ["write", "sync", "rename"] as const) {
    const row = WorkflowRunRepo.get(`run_durable_${fault}`);
    eq(`★ MC-028 重启后 run_durable_${fault} 是 durable 提交的 V2(success)`, row?.status, "success");
    eq(`★ MC-028 重启后 run_durable_${fault} 的 awaiting 是 V2(H)`, row?.awaiting.join(","), "H");
    check(`★ MC-028 重启后 run_durable_${fault} 的存档仍可解码`, decodeSnapshot(row?.payload ?? "") !== null);
  }

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

  // 报错点名的是节点的**标题**(用户在图上认的那个),不是存档里的内部 id ——
  // 与同仓每一条点名节点的消息同规矩(library.ts / workflowValidation / runner.ts)。
  // 用户画一张带命令节点「训练脚本」的图,被中断后看到的是「n_cmd_1」等于什么都没说。
  const titled = { ...doc, nodes: [
    { id: "n_cmd_1", type: "mcode.command", title: "训练脚本", params: {}, position: { x: 0, y: 0 } },
  ] };
  const replayMsg = workflowReplayError(titled, ["n_cmd_1"]);
  check("被中断的危险节点按标题点名", replayMsg !== null && replayMsg.includes("训练脚本"), replayMsg);
  check("报错里不出现内部节点 id", replayMsg !== null && !replayMsg.includes("n_cmd_1"), replayMsg);
}

console.log(`\n${total - failures}/${total} passed`);
if (failures > 0) process.exit(1);
