/**
 * Headless smoke for **长期任务循环**(`main/longtask/taskRunner.ts` + `@contracts/longTask`)。
 *
 * 长期任务的价值全在循环器:**回合结束 → 判定 → 续轮**这条链不能断。所以这里除了
 * 纯函数与落库,还把整个 runner 拉起来跑——`RuntimeManager` 用替身
 * (`stub-runtime-manager.ts`,esbuild alias 注入),事件是**手动喂**的,sendTurn
 * 只是记账。这样能验:
 *
 *  1. **终局判定**(`parseTaskOutcome`):无标记 = 继续;DONE/BLOCKED 提取;
 *     blocked 优先(保守)、取**最后一次**出现、空原因有兜底文案;
 *  2. **协议提示词**:preamble 带目标原话与两个标记;续轮提示带「第 N/M 轮」
 *     与剩余次数 —— 这两段文案就是用户为什么"看到它在干活"的全部理由;
 *  3. **IPC 输入**:zod schema 的边界(空 goal、maxIterations 越界);
 *  4. **LongTaskRepo round-trip**:create → get → bump → setNote → finish,
 *     finished_at 的 running 兜底(finish 回 running 时清空时间戳);
 *  5. **循环器行为**(核心):attach 门槛(会话不存在/automation 会话/重复挂)、
 *     无标记自动续轮(轮次推进、cwd 带项目路径)、DONE 收场、BLOCKED 收场、
 *     interrupted = 用户停止不续轮、error = blocked、轮数耗尽 = maxed、
 *     holdTurnEnd 的 turn.done 被闸门挡住、stop() 顺带 interrupt、
 *     重启残留 running 行被 stop() 收场、session.deleted 静默收场、
 *     sendTurn 忙时按节奏重试(剧本:busy → ok)。
 *
 * ## 它不碰用户真正的数据根
 *
 * `dataRoot()` 指到临时目录(复用 run-store-smoke 的 stubs),`mktemp -d` 建,
 * 跑完就删。
 *
 * Run: scripts/longtask-smoke/run.sh
 */
import {
  TASK_DONE_MARKER,
  TASK_BLOCKED_MARKER_PREFIX,
  DEFAULT_LONG_TASK_MAX_ITERATIONS,
  parseTaskOutcome,
  taskProtocolPreamble,
  taskContinuationPrompt,
  LongTaskStartSchema,
  LongTaskStopSchema,
} from "@contracts/longTask";
import type { Session } from "@contracts/session";
import type { LongTaskUpdateEvent } from "@contracts/longTask";
import { isWebModelSend } from "@contracts/customModel";
import { initDb } from "@main/store/db.js";
import { ProjectRepo, SessionRepo, LongTaskRepo } from "@main/store/repositories.js";
import { longTaskRunner } from "@main/longtask/taskRunner.js";
import { runtimeManager, resetRuntimeStub, runtimeStub } from "./stub-runtime-manager.js";

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

/** 等 onTurnDone 这条 async 链走完:轮询直到条件成立或超时。 */
async function waitUntil(what: string, cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

/** 喂一个回合:text.delta 几段 + turn.done,再等 runner 的 async 链落地。 */
async function runTurn(sessionId: string, text: string, reason: "end_turn" | "interrupted" | "error"): Promise<void> {
  runtimeManager.feed({ type: "text.delta", sessionId, messageId: "m_smoke", text });
  runtimeManager.feed({ type: "turn.done", sessionId, reason });
  await new Promise((r) => setTimeout(r, 10));
}

/* ────────────────────────── 1. parseTaskOutcome ────────────────────────── */

console.log("\nparseTaskOutcome · 终局判定(纯函数)");

{
  eq("没有标记 = running", parseTaskOutcome("我先分析一下问题……").outcome, "running");
  eq("DONE 单独出现 = done", parseTaskOutcome(`都做完了\n${TASK_DONE_MARKER}`).outcome, "done");
  // 不要求字面"最后一行"——判定按存在,位置约束是提示词的事(误判有 maxIterations 兜底)。
  eq("DONE 不在末尾也算", parseTaskOutcome(`${TASK_DONE_MARKER} 附言`).outcome, "done");

  const b1 = parseTaskOutcome("[[TASK_BLOCKED: 缺少 API 凭据]]");
  check("BLOCKED 完整提取原因", b1.outcome === "blocked" && b1.reason === "缺少 API 凭据", b1);
  const b2 = parseTaskOutcome("[[TASK_BLOCKED:   缺少 API 凭据]]");
  check("中文冒号/空白剥离", b2.outcome === "blocked" && b2.reason === "缺少 API 凭据", b2);
  const b3 = parseTaskOutcome("[[TASK_BLOCKED]]");
  check("空原因兜底文案", b3.outcome === "blocked" && b3.reason === "模型没有说明原因", b3);
  const b4 = parseTaskOutcome(`${TASK_BLOCKED_MARKER_PREFIX}: 忘了闭合`);
  check("没闭合也兜底", b4.outcome === "blocked" && b4.reason === "模型没有说明原因", b4);

  // 保守原则:两个都在 → blocked;取最后一次出现。
  const both = parseTaskOutcome(`a ${TASK_DONE_MARKER} b [[TASK_BLOCKED: x]]`);
  check("两个都在 = blocked 优先", both.outcome === "blocked" && both.reason === "x", both);
  const twice = parseTaskOutcome("[[TASK_BLOCKED: 第一次]] 中间 [[TASK_BLOCKED: 第二次]]");
  check("取最后一次的 blocked 原因", twice.outcome === "blocked" && twice.reason === "第二次", twice);
  const doneAfter = parseTaskOutcome("[[TASK_BLOCKED: x]] 后来又行了\n[[TASK_DONE]]");
  check("blocked 优先于 done(哪怕 done 更晚)", doneAfter.outcome === "blocked", doneAfter);

  eq("空文本 = running", parseTaskOutcome("").outcome, "running");
}

/* ────────────────────────── 2. 协议提示词 ────────────────────────── */

/* ────────────────────────── 网页模型自动武装 ────────────────────────── */

console.log("\n网页模型自动武装(isWebModelSend)");

// 网页版模型有个别的引擎没有的毛病:**它每轮答完就停**。原生几家的回合是"干到模型
// 自己收手",而网页版的页面天生一问一答 —— 于是干一件要好几步的活,它答一段就停下等
// 下一句。补那一刀的是这个循环器,而**自动挂上它**的判据就是这一段要钉的:
// 走网页模型的发送不用用户手动开。
{
  const webCfg = { id: "cm_web", webSiteId: "chatgpt" };
  const httpCfg = { id: "cm_http", webSiteId: undefined };
  const table = [webCfg, httpCfg];

  check("★ 网页模型的配置 → 自动武装", isWebModelSend("cm_web", table) === true);
  check("★ 普通 HTTP 配置 → 不武装(原生引擎本来就会跑到底)", isWebModelSend("cm_http", table) === false);
  check("★ 没有自定义配置(内置模型)→ 不武装", isWebModelSend(null, table) === false);
  check("undefined 的 customModelId → 不武装", isWebModelSend(undefined, table) === false);
  // 配置被删掉之后:宁可不开,也别对着一个不存在的配置开。
  check("★ 指向一条不存在的配置 → 不武装", isWebModelSend("cm_没了", table) === false);
  // 空表(还没加载出来)→ 同样不开。
  check("自定义模型表还没加载 → 不武装", isWebModelSend("cm_web", []) === false);

  // ⚠️ **判据是"这条配置由站点驱动",不是"驱动写好了没有"**:驱动没写完它仍然是
  // 网页模型(照样每轮就停),该有的循环照样该挂;能不能跑起来由 `webUpstream`
  // 去明确报错,不在这里替它决定。
  const undrivenCfg = { id: "cm_undriven", webSiteId: "某个还没写驱动的站" };
  check(
    "★ 站点未接入驱动也照样武装(它仍然是网页模型)",
    isWebModelSend("cm_undriven", [undrivenCfg]) === true,
  );
}

console.log("\n协议提示词(纯函数)");
{
  const goal = "把 data/ 目录里所有 PDF 摘要整理成一张表";
  const pre = taskProtocolPreamble(goal);
  check("preamble 保留目标原话", pre.startsWith(goal), pre.slice(0, 80));
  check("preamble 写明 DONE 标记", pre.includes("[[TASK_DONE]]"), true);
  check("preamble 写明 BLOCKED 标记", pre.includes("[[TASK_BLOCKED"), true);
  check("preamble 禁止只给理论", pre.includes("不要只给理论"), true);
  check("preamble 要求维护任务清单", pre.includes("任务清单"), true);

  const cont = taskContinuationPrompt(goal, 2, 5);
  check("续轮提示带轮次 3/5", cont.includes("第 3/5 轮"), cont.split("\n")[0]);
  check("续轮提示带剩余次数", cont.includes("剩余自动续轮次数:3"), true);
  check("续轮提示再交代 DONE 标记", cont.includes("[[TASK_DONE]]"), true);
}

/* ────────────────────────── 3. zod schema ────────────────────────── */

console.log("\nIPC 输入 schema");

{
  const ok = LongTaskStartSchema.safeParse({ sessionId: "s1", goal: "干活" });
  check("合法 start 通过", ok.success);
  const noGoal = LongTaskStartSchema.safeParse({ sessionId: "s1", goal: "  " });
  check("空 goal 被拒", !noGoal.success);
  const zero = LongTaskStartSchema.safeParse({ sessionId: "s1", goal: "x", maxIterations: 0 });
  check("maxIterations=0 被拒", !zero.success);
  const tooBig = LongTaskStartSchema.safeParse({ sessionId: "s1", goal: "x", maxIterations: 201 });
  check("maxIterations>200 被拒", !tooBig.success);
  const capOk = LongTaskStartSchema.safeParse({ sessionId: "s1", goal: "x", maxIterations: 200 });
  check("maxIterations=200 通过", capOk.success);
  check("stop 缺 sessionId 被拒", !LongTaskStopSchema.safeParse({}).success);
}

/* ────────────────────────── 4. LongTaskRepo round-trip ────────────────────────── */

console.log("\nLongTaskRepo · 落库 round-trip");

let repoSessionId = "";
{
  await initDb();
  const now = Date.now();
  ProjectRepo.create({
    id: "p_lt",
    name: "冒烟项目",
    path: "D:/proj_lt",
    archived: false,
    group: null,
    sortOrder: 0,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const sessionOf = (id: string, kind: Session["kind"]): Session => ({
    id,
    projectId: "p_lt",
    providerId: "claude-sdk",
    claudeSessionId: null,
    kind,
    parentSessionId: null,
    nodeId: null,
    title: "冒烟会话",
    status: "idle",
    model: "",
    effort: "default",
    permissionMode: "default",
    workflowId: "wf_smoke",
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
  });
  SessionRepo.create(sessionOf("s_chat", "chat"));
  SessionRepo.create(sessionOf("s_side", "side"));
  SessionRepo.create(sessionOf("s_auto", "automation"));
  repoSessionId = "s_chat";

  const t = LongTaskRepo.create({
    sessionId: "s_chat",
    projectId: "p_lt",
    goal: "目标一",
    maxIterations: 7,
  });
  check("id 前缀 ltask_", t.id.startsWith("ltask_"), t.id);
  eq("create 状态 running", t.status, "running");
  eq("create iterations 0", t.iterations, 0);
  eq("create maxIterations", t.maxIterations, 7);
  eq("create finishedAt null", t.finishedAt, null);

  const back = LongTaskRepo.get(t.id);
  check("get 读回一致", !!back && back.goal === "目标一" && back.sessionId === "s_chat" && back.projectId === "p_lt", back);

  const bumped = LongTaskRepo.bumpIterations(t.id);
  eq("bumpIterations 推进", bumped?.iterations, 1);

  const noted = LongTaskRepo.setNote(t.id, "中间说明");
  eq("setNote 只改 note", noted?.note, "中间说明");

  const finished = LongTaskRepo.finish(t.id, "done", "完成");
  check("finish 落 finishedAt", finished?.status === "done" && typeof finished?.finishedAt === "number", finished);

  const reopened = LongTaskRepo.finish(t.id, "running", null);
  eq("finish 回 running 会清 finishedAt(兜底)", reopened?.finishedAt, null);

  const t2 = LongTaskRepo.create({ sessionId: "s_chat", projectId: "p_lt", goal: "目标二", maxIterations: 3 });
  eq("latestOf 是最新一条", LongTaskRepo.latestOf("s_chat")?.id, t2.id);
  check("listBySession 有两条", LongTaskRepo.listBySession("s_chat").length >= 2);
}

/* ────────────────────────── 5. 循环器行为 ────────────────────────── */

console.log("\n循环器 · attach 门槛");

{
  resetRuntimeStub();
  longTaskRunner.start();

  const missing = longTaskRunner.attach({ sessionId: "s_none", goal: "x" });
  check("会话不存在 → ok:false", !missing.ok && !!missing.error, missing);

  const auto = longTaskRunner.attach({ sessionId: "s_auto", goal: "x" });
  check("automation 会话 → 拒", !auto.ok && (auto.error ?? "").includes("只有对话"), auto);

  const armed = longTaskRunner.attach({ sessionId: "s_chat", goal: "  把任务做完  " });
  check("chat 会话 → 挂上", armed.ok, armed);
  eq("goal 被 trim", armed.task?.goal, "把任务做完");
  eq("默认轮数上限", armed.task?.maxIterations, DEFAULT_LONG_TASK_MAX_ITERATIONS);
  check("isActive true", longTaskRunner.isActive("s_chat"));

  const dup = longTaskRunner.attach({ sessionId: "s_chat", goal: "再挂一个" });
  check("重复挂 → 拒", !dup.ok, dup);

  check("attach 广播了 update", runtimeStub().externals.some((e) => e.type === "longtask.update"));
}

console.log("\n循环器 · 续轮与终局");

{
  // 回合 1:没有标记 → 自动续轮。externals 快照从当前长度起算。
  const before = runtimeStub().externals.length;
  await runTurn("s_chat", "我先看看目录结构……", "end_turn");
  await waitUntil("续轮发出", () => runtimeStub().sent.length === 1);

  eq("回合1 iterations 推进", LongTaskRepo.latestOf("s_chat")?.iterations, 1);
  const sent1 = runtimeStub().sent[0];
  eq("续轮发给同一会话", sent1?.sessionId, "s_chat");
  eq("续轮 cwd 是项目路径", sent1?.cwd, "D:/proj_lt");
  check("续轮 prompt 带 2/20", (sent1?.prompt ?? "").includes("第 2/20 轮"), sent1?.prompt.slice(0, 60));
  check("续轮 prompt 带目标", (sent1?.prompt ?? "").includes("把任务做完"), true);
  const upd1 = runtimeStub().externals.slice(before).find((e) => e.type === "longtask.update") as LongTaskUpdateEvent | undefined;
  eq("update 事件里 iterations=1", upd1?.task.iterations, 1);

  // 回合 2:宣布完成 → done 收场,active 清空。
  await runTurn("s_chat", "做完了,验证过。\n[[TASK_DONE]]", "end_turn");
  await waitUntil("done 收场", () => LongTaskRepo.latestOf("s_chat")?.status === "done");
  const fin = LongTaskRepo.latestOf("s_chat");
  eq("status done", fin?.status, "done");
  eq("note 完成文案", fin?.note, "模型确认目标达成");
  check("finishedAt 落了", typeof fin?.finishedAt === "number");
  check("active 清空", !longTaskRunner.isActive("s_chat"));
  eq("done 后不再续轮", runtimeStub().sent.length, 1);

  // blocked:模型报告卡死。
  const a2 = longTaskRunner.attach({ sessionId: "s_chat", goal: "目标二" });
  check("再挂成功", a2.ok, a2);
  await runTurn("s_chat", "卡在权限上。[[TASK_BLOCKED: 需要 root 权限]]", "end_turn");
  await waitUntil("blocked 收场", () => LongTaskRepo.latestOf("s_chat")?.status === "blocked");
  eq("note 带模型给的原因", LongTaskRepo.latestOf("s_chat")?.note, "模型报告卡死:需要 root 权限");
  check("blocked 后 active 清空", !longTaskRunner.isActive("s_chat"));
}

console.log("\n循环器 · interrupted / error / maxed");

{
  // 用户 interrupt = 人的意志,不续轮。
  const sentBefore = runtimeStub().sent.length;
  longTaskRunner.attach({ sessionId: "s_chat", goal: "目标三" });
  await runTurn("s_chat", "干了一半", "interrupted");
  await waitUntil("stopped 收场", () => LongTaskRepo.latestOf("s_chat")?.status === "stopped");
  eq("note 用户停止", LongTaskRepo.latestOf("s_chat")?.note, "用户停止");
  eq("interrupted 不续轮", runtimeStub().sent.length, sentBefore);

  // error 收场 = blocked 等人来。
  longTaskRunner.attach({ sessionId: "s_chat", goal: "目标四" });
  await runTurn("s_chat", "……", "error");
  await waitUntil("error → blocked", () => LongTaskRepo.latestOf("s_chat")?.status === "blocked");
  check("error 的 note 指路", (LongTaskRepo.latestOf("s_chat")?.note ?? "").includes("错误"), true);

  // 轮数耗尽。
  longTaskRunner.attach({ sessionId: "s_chat", goal: "目标五", maxIterations: 1 });
  await runTurn("s_chat", "还在干,没完成", "end_turn");
  await waitUntil("maxed 收场", () => LongTaskRepo.latestOf("s_chat")?.status === "maxed");
  check("maxed 的 note 带上限", (LongTaskRepo.latestOf("s_chat")?.note ?? "").includes("1 轮上限"), true);
  eq("maxed 不续轮", runtimeStub().sent.length, sentBefore);
}

console.log("\n循环器 · 闸门与收场");

{
  // holdTurnEnd 的 turn.done 不是回合边界。
  const sentAtGate = runtimeStub().sent.length;
  const aHold = longTaskRunner.attach({ sessionId: "s_chat", goal: "目标六" });
  check("挂上用于闸门测试", aHold.ok);
  runtimeStub().held.add("s_chat");
  await runTurn("s_chat", "工具结果还在路上", "end_turn");
  await new Promise((r) => setTimeout(r, 30));
  eq("held 的 turn.done 不推进轮次", LongTaskRepo.latestOf("s_chat")?.iterations, 0);
  eq("held 的 turn.done 不续轮", runtimeStub().sent.length, sentAtGate);
  runtimeStub().held.delete("s_chat");
  longTaskRunner.stop("s_chat");

  // stop():顺带 interrupt。
  const interruptsBefore = runtimeStub().interrupts.length;
  longTaskRunner.attach({ sessionId: "s_chat", goal: "目标七" });
  const stopped = longTaskRunner.stop("s_chat");
  check("stop ok", stopped.ok);
  eq("stop 标 stopped", stopped.task?.status, "stopped");
  eq("stop 触发了 interrupt", runtimeStub().interrupts.length, interruptsBefore + 1);
  check("stop 后 active 清空", !longTaskRunner.isActive("s_chat"));

  // stop() 没活任务但库里有残留 running(重启场景)→ 顺手收场。
  const stale = LongTaskRepo.create({ sessionId: "s_chat", projectId: "p_lt", goal: "重启残留", maxIterations: 5 });
  const staleStop = longTaskRunner.stop("s_chat");
  check("残留 running 被 stop 收场", staleStop.ok && staleStop.task?.id === stale.id, staleStop);
  eq("残留行状态 stopped", LongTaskRepo.get(stale.id)?.status, "stopped");

  // **同一毫秒建的两条,「最新一条」必须是后建的那条。**
  //
  // ⚠️ 这条盯的是一个**偶发**故障:排序原来兜的是 `id DESC`,而 id 是
  // `ltask_<时间>_<随机>` —— 毫秒相同的两条按 id 排等于按随机串排,于是一半的机会
  // `latestOf` 返回旧那条。上面那一段"残留 running 被 stop 收场"踩的就是它
  // (五跑一红)。一次建 20 条,同毫秒的概率接近 1 —— 旧代码下这条几乎必红。
  {
    // 这一格要真建 20 条 `long_tasks` 行,而那张表对会话有外键 —— 先给它一个会话。
    // 形状照着上面那个 `sessionOf` 闭包抄(它在另一个块里,这里够不着),字段一个都
    // 不能少:`SessionRepo.create` 是**整份**写进去的。
    const now2 = Date.now();
    SessionRepo.create({
      id: "s_order",
      projectId: "p_lt",
      providerId: "claude-sdk",
      claudeSessionId: null,
      kind: "chat",
      parentSessionId: null,
      nodeId: null,
      title: "排序用例",
      status: "idle",
      model: "",
      effort: "default",
      permissionMode: "default",
      workflowId: "wf_smoke",
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
      createdAt: now2,
      updatedAt: now2,
    });
    const built = [];
    for (let i = 0; i < 20; i++) {
      built.push(
        LongTaskRepo.create({
          sessionId: "s_order",
          projectId: "p_lt",
          goal: `第 ${i} 条`,
          maxIterations: 5,
        }),
      );
    }
    const last = built[built.length - 1]!;
    eq("同毫秒连建 20 条,最新的那条就是最后建的那条", LongTaskRepo.latestOf("s_order")?.id, last.id);
    eq("历史列表的第一条也是它", LongTaskRepo.listBySession("s_order")[0]?.id, last.id);
  }

  // 没任务也没残留 → 明确失败。
  const nothing = longTaskRunner.stop("s_chat");
  check("没有任务时 stop 报错", !nothing.ok, nothing);

  // session.deleted:静默收场。
  longTaskRunner.attach({ sessionId: "s_side", goal: "侧聊目标" });
  const extBefore = runtimeStub().externals.length;
  runtimeManager.feed({ type: "session.deleted", sessionId: "s_side" });
  await new Promise((r) => setTimeout(r, 30));
  check("删除后任务收场 stopped", LongTaskRepo.latestOf("s_side")?.status === "stopped");
  check("删除后 active 清空", !longTaskRunner.isActive("s_side"));
  eq("静默收场不广播", runtimeStub().externals.length, extBefore);
  longTaskRunner.dispose();
}

console.log("\n循环器 · sendTurn 忙时重试");

{
  resetRuntimeStub();
  longTaskRunner.start();
  // 剧本:第一次续轮被拒(忙),第二次成功。
  runtimeStub().sendScript = ["busy", "ok"];
  longTaskRunner.attach({ sessionId: "s_chat", goal: "会忙一下的目标" });
  await runTurn("s_chat", "第一轮", "end_turn");
  // 重试间隔 2s,给足 5s。
  const gotContinuation = await waitUntil("忙后重试成功", () => runtimeStub().sent.length === 1, 5000);
  check("busy 后重试把续轮发出去", gotContinuation, runtimeStub().sent.length);
  eq("重试的 iterations 仍是 1(重试不重复计数)", LongTaskRepo.latestOf("s_chat")?.iterations, 1);
  longTaskRunner.dispose();
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
