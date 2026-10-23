/**
 * 【T100】消息 → 任务：回合产出文件就自动记成一条任务。
 *
 * ## 钉的是什么
 *
 * T99 把 `tasks` 表和 IPC 立起来了，但**没有任何生产路径写它**。这一套钉那条路径：
 *
 * | # | 断言 | 为什么这条值得钉 |
 * |---|---|---|
 * | 1 | 产出文件的回合 → 建 `done` 任务，带产物 | 这是「任务真的被建出来」 |
 * | 2 | 纯问答（无产物）→ **不**建任务 | 否则任务列表变成聊天记录副本 |
 * | 3 | `side` / `node` / `automation` 会话 → 不建 | 用户看不见的会话不该出现在「我的任务」 |
 * | 4 | 失败回合 → 建 `failed`，带原因 | 路线图 §5「任务中心能追踪失败」 |
 * | 5 | 用户主动停止 → 不建 | 没做完的事不是任务，是没做完 |
 * | 6 | 只删不改的文件**不算**产物 | 产物列表不该是 diff 清单 |
 * | 7 | 新任务停在 `done`，**不是** `accepted` | §3「执行完成不等于验收通过」 |
 *
 * ## ★ 对照组在这里
 *
 * 第 2/3/5 条是**否定断言**（"不建"），而否定断言最容易变成「反正什么都建不出来」也照样绿。
 * 所以第 1 条和它们**共用一个 fixture 与同一个调用**，只有 `classifyTurn` 的入参不同 ——
 * 如果管线断了（建任务那一步抛错/没接上），第 1 条先红，而不是 2/3/5 一起"正确地"绿着。
 *
 * ## 为什么分类判据要单独测
 *
 * `classifyTurn` 是纯函数。把它单独抽出来测，是因为如果判据埋在订阅者闭包里，套件就只能
 * 整段模拟事件流，而模拟出来的闭包和生产不是同一份实现 —— 这个仓库栽过（见 CLAUDE.md
 * 第十三条）。这里测的是**生产代码里那一个函数**。
 *
 * 数据根走 `MCODE_SMOKE_DATA_ROOT`（stub 没设就抛）：
 * **`sql.js` 的 `db.export()` 重写整个 `mcode.db`，指错地方就是拿空库盖用户数据。**
 */
import assert from "node:assert/strict";
import { initDb } from "../../src/main/store/db.js";
import { SessionRepo, ProjectRepo } from "../../src/main/store/repositories.js";
import { TaskRepo } from "../../src/main/store/repositories/task.js";
import { classifyTurn, settleTurn, startTaskAutoCreate, stopTaskAutoCreate } from "../../src/main/tasks/autoCreate.js";
import type { TurnFileEntry } from "@contracts/runtime";

let total = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

await initDb();

/* ── fixture ─────────────────────────────────────────────────────────────── */

/** 造一个会话。`kind` 覆盖 chat / side / node / automation 四值。 */
function makeSession(args: { kind: string; title: string }): string {
  const now = Date.now();
  const projectId = `proj_${Math.random().toString(36).slice(2, 10)}`;
  // `ProjectRepo.create` 返回 void（它是 INSERT，不是 upsert-and-return），所以 id 由调用方
  // 先生成、再交给它 —— 这里拿 projectId 建会话，不指望返回值。
  ProjectRepo.create({
    id: projectId,
    name: `proj-${Math.random().toString(36).slice(2, 8)}`,
    path: `D:/tmp/${Math.random().toString(36).slice(2, 8)}`,
    archived: false,
    createdAt: now,
    updatedAt: now,
  } as never);
  const id = `sess_${Math.random().toString(36).slice(2, 10)}`;
  // 用 Session 的默认值把必填字段补齐 —— 这里只关心 kind / title / projectId,
  // 其余给「一个刚建出来的会话」该有的样子。**不去猜哪些字段可以省**:那张表是
  // SESSION_COLUMNS 驱动的,少一个字段写库时就 NOT NULL 失败。
  const session = {
    id,
    projectId,
    title: args.title,
    kind: args.kind,
    status: "idle",
    // 这几个是 NOT NULL（见 sessionSchema：provider_id / title / status / model /
    // permission_mode）。填常见值即可 —— 本套不关心引擎，但写库时它们不能是 null。
    providerId: "claude",
    model: "claude-sonnet-5-5",
    effort: "default",
    permissionMode: "default",
    workflowId: null,
    customModelId: null,
    claudeSessionId: null,
    parentSessionId: null,
    nodeId: null,
    agentProfile: null,
    archived: false,
    pinnedAt: null,
    envMode: "local",
    wtStyle: null,
    worktreePath: null,
    todos: null,
    contextSnapshot: null,
    subagents: null,
    planDraft: null,
    turnFiles: null,
    usageHistory: null,
    createdAt: now,
    updatedAt: now,
  };
  SessionRepo.create(session as never);
  return id;
}

/** 一个「真的产出了东西」的文件条目。 */
function fileEntry(path: string, kind: TurnFileEntry["kind"], adds: number, dels: number): TurnFileEntry {
  return { filePath: path, kind, adds, dels, before: "" };
}

/* ── ① 判据：该建 vs 不该建（正控与负控共用同一个函数） ────────────────── */

console.log("\n① classifyTurn —— 判据本身（正控 + 负控，同一个函数）");
{
  const good = classifyTurn({
    sessionKind: "chat",
    reason: "end_turn",
    artifacts: [{ path: "D:/tmp/r.md", description: "新建文件", createdAt: 1 }],
  });
  check("★ 正控：chat + 有产物 → 建任务", good.create === true && good.failed === false, good);

  const noArtifacts = classifyTurn({ sessionKind: "chat", reason: "end_turn", artifacts: [] });
  check("★ 负控：chat + 无产物 → **不建**（问答不是任务）", noArtifacts.create === false, noArtifacts);

  for (const kind of ["side", "node", "automation"]) {
    const v = classifyTurn({
      sessionKind: kind,
      reason: "end_turn",
      artifacts: [{ path: "D:/tmp/x.md", description: "新建文件", createdAt: 1 }],
    });
    check(`★ 负控：${kind} 会话即使有产物也不建（用户看不见的会话）`, v.create === false, v);
  }

  const interrupted = classifyTurn({
    sessionKind: "chat",
    reason: "interrupted",
    artifacts: [{ path: "D:/tmp/y.md", description: "新建文件", createdAt: 1 }],
  });
  check("★ 负控：用户主动停止 → 不建（没做完的事不是任务）", interrupted.create === false, interrupted);

  const failed = classifyTurn({ sessionKind: "chat", reason: "error", artifacts: [] });
  check("★ 失败回合 → 建，且标 failed（§5 要能追踪失败）", failed.create === true && failed.failed === true, failed);
}

/* ── ② 端到端：真写库 ───────────────────────────────────────────────────── */

console.log("\n② settleTurn —— 真的写进 tasks 表");
{
  const sid = makeSession({ kind: "chat", title: "把季度数据整理成报告" });
  // ★ 对照组证明管线通着：同一个 settleTurn，有产物就建
  const r = settleTurn({
    sessionId: sid,
    files: [fileEntry("D:/tmp/report.md", "created", 120, 0), fileEntry("D:/tmp/data.csv", "created", 40, 0)],
    reason: "end_turn",
  });
  check("★ 产出文件的回合建出了任务", r.created === true && typeof r.taskId === "string", r);

  const task = r.taskId ? TaskRepo.get(r.taskId) : null;
  check("任务真的在库里", task !== null, task);
  check("状态是 done", task?.status === "done", task?.status);
  check("★ 不是 accepted（§3 执行完成 ≠ 验收通过）", task?.status !== "accepted", task?.status);
  check("验收仍是 null（用户还没看过）", task?.acceptance === null, task?.acceptance);
  check("目标用的是会话标题（人话）", task?.goal === "把季度数据整理成报告", task?.goal);
  check("origin 指回那个会话", task?.origin.kind === "session" && task?.origin.ref === sid, task?.origin);
  check("产物落了两条", task?.artifacts.length === 2, task?.artifacts);
  check("产物带路径", task?.artifacts[0]?.path === "D:/tmp/report.md", task?.artifacts[0]);

  // ★ 同一条管线，无产物 → 库里不该多出任务
  const before = TaskRepo.list().length;
  const r2 = settleTurn({ sessionId: sid, files: [], reason: "end_turn" });
  check("★ 负控：同一会话无产物的回合不建任务", r2.created === false && TaskRepo.list().length === before, {
    r2,
    before,
    after: TaskRepo.list().length,
  });

  // ★ 同一个管线，用户看不见的会话 → 不建
  const sideSid = makeSession({ kind: "side", title: "Quick ask" });
  const before2 = TaskRepo.list().length;
  const r3 = settleTurn({
    sessionId: sideSid,
    files: [fileEntry("D:/tmp/side.md", "created", 10, 0)],
    reason: "end_turn",
  });
  check("★ 负控：side 会话有产物也不建（任务列表不该出现看不见来源的条目）",
    r3.created === false && TaskRepo.list().length === before2, { r3 });
}

console.log("\n③ 产物判据：只删不改的文件不算产物");
{
  const sid = makeSession({ kind: "chat", title: "清理旧注释" });
  // 一个「只删了几行」的 modified —— 是修改，不是产物
  const r = settleTurn({
    sessionId: sid,
    files: [fileEntry("D:/tmp/old.md", "modified", 0, 30)],
    reason: "end_turn",
  });
  check("★ 只删内容（adds=0）的回合 → 不建任务", r.created === false, r);

  // 但净增的 modified 算
  const sid2 = makeSession({ kind: "chat", title: "给文档补一节" });
  const r2 = settleTurn({
    sessionId: sid2,
    files: [fileEntry("D:/tmp/doc.md", "modified", 25, 3)],
    reason: "end_turn",
  });
  const t2 = r2.taskId ? TaskRepo.get(r2.taskId) : null;
  check("净增内容的修改算产物", r2.created === true && t2?.artifacts.length === 1, { r2, artifacts: t2?.artifacts });
}

console.log("\n④ 失败回合走的是**同一条**结算路径（不是第二份实现）");
{
  const sid = makeSession({ kind: "chat", title: "跑一次数据清洗脚本" });
  // ★ 这条断言在验「共享实现只有一份」：失败回合必须由 `settleTurn` 自己处理，
  // 而不是有个平行的 `settleFailedTurn`。第一版就是两份，于是 `classifyTurn` 里
  // 的 interrupted / kind 判据在失败那条路上走不到 —— 变异验证时只红了一条才露底。
  const r = settleTurn({ sessionId: sid, files: [], reason: "error" });
  check("★ 失败回合由 settleTurn 自己建出 failed 任务", r.created === true && r.status === "failed", r);
  const t = r.taskId ? TaskRepo.get(r.taskId) : null;
  check("失败任务带原因（用户要看得见为什么）", (t?.failureReason ?? "").includes("error"), t?.failureReason);
  check("失败任务没有产物", t?.artifacts.length === 0, t?.artifacts);

  // ★ 这一条的 fixture **必须带产物**。第一版用的是 `files: []`，于是即使撤掉
  // interrupted 判据，「无产物不建」那一条也会把它挡住 —— 断言照样绿，而它声称
  // 在验的东西根本没被验到（CLAUDE.md 第八条形态 4：同一条断言里还有别的条件兜底）。
  // 带产物之后，唯一能阻止它建任务的就是 interrupted 判据本身。
  const before = TaskRepo.list().length;
  const r2 = settleTurn({
    sessionId: sid,
    files: [fileEntry("D:/tmp/half-done.md", "created", 12, 0)],
    reason: "interrupted",
  });
  check("★ 用户主动停止仍不建（同一条路，判据仍生效）", r2.created === false && TaskRepo.list().length === before, r2);
}

console.log("\n⑤ 跨会话可查（「一级对象」），且能被验收");
{
  const list = TaskRepo.list();
  const sessionTasks = TaskRepo.list({ sessionId: "not-a-real-session" });
  check("不带 sessionId 时列出全部（跨会话）", list.length >= 2, list.length);
  check("按不存在的 sessionId 筛 → 空（筛选真的生效，不是恒等）", sessionTasks.length === 0, sessionTasks.length);

  // 走完闭环：done 的任务能被验收 → accepted
  const doneTask = list.find((t) => t.status === "done");
  check("库里有 done 的任务可供验收", doneTask !== undefined, doneTask?.id);
  if (doneTask) {
    const accepted = TaskRepo.accept({ id: doneTask.id, evidence: "打开看过，数字对" });
    check("★ 验收后变 accepted", accepted.status === "accepted", accepted.status);
    check("验收证据落库", accepted.acceptance?.evidence === "打开看过，数字对", accepted.acceptance);
  }
}

/* ── ⑥ 接线：事件流真的接上了吗 ─────────────────────────────────────────── */

console.log("\n⑥ ★ 接线：startTaskAutoCreate 真的挂上了事件流（不是只有函数没人调）");
{
  // 这是整套里最要紧的一段。前面 ⑤ 全部直接调 `settleTurn` —— 如果生产路径
  // **从来没订阅**，那些断言同样会全绿，而「回合结束自动建任务」根本没发生。
  // 这里验的是接线本身：订阅有没有挂上、事件喂进去后任务有没有真的出来。
  const { __emit, __subscriberCount } = await import(
    "./stubs/runtimeManager.js"
  );

  check("未启动前没有订阅者（对照组：证明下面的 1 是订阅造成的）", __subscriberCount() === 0, __subscriberCount());

  startTaskAutoCreate();
  check("★ startTaskAutoCreate 挂上了订阅", __subscriberCount() === 1, __subscriberCount());

  // 重复调用不该挂两个 —— 否则同一个回合会建两条任务
  startTaskAutoCreate();
  check("★ 重复启动是幂等的（不会建两条任务）", __subscriberCount() === 1, __subscriberCount());

  // 走生产那条分发路径：turn.files 先到、turn.done 收口
  const sid = makeSession({ kind: "chat", title: "从事件流里建出来的任务" });
  const before = TaskRepo.list().length;
  __emit({ type: "turn.files", sessionId: sid, files: [fileEntry("D:/tmp/from-event.md", "created", 15, 0)] } as never);
  check("turn.files 到了但还没建任务（要等 turn.done 收口）", TaskRepo.list().length === before, TaskRepo.list().length);

  __emit({ type: "turn.done", sessionId: sid, reason: "end_turn" } as never);
  const after = TaskRepo.list();
  check("★ turn.done 之后任务真的建出来了（端到端接线通）", after.length === before + 1, { before, after: after.length });
  const made = after.find((t) => t.goal === "从事件流里建出来的任务");
  check("★ 建出来的任务状态是 done", made?.status === "done", made?.status);
  check("产物来自 turn.files 事件", made?.artifacts[0]?.path === "D:/tmp/from-event.md", made?.artifacts);

  // 缓冲要被清掉 —— 否则下一轮会带着上一轮的产物
  const sid2 = makeSession({ kind: "chat", title: "第二轮不该继承上一轮的产物" });
  const before2 = TaskRepo.list().length;
  __emit({ type: "turn.done", sessionId: sid2, reason: "end_turn" } as never);
  check("★ 下一轮不继承上一轮的产物缓冲（无产物 → 不建）", TaskRepo.list().length === before2, TaskRepo.list().length - before2);

  stopTaskAutoCreate();
  check("stop 之后订阅被摘掉", __subscriberCount() === 0, __subscriberCount());
}

/* ── 收尾 ─────────────────────────────────────────────────────────────── */

console.log(`\ntask-message-auto-create-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
