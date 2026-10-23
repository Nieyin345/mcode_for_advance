/**
 * 【T99】任务是一级对象 —— `tasks` 表 + 契约 + IPC 三层的回归。
 *
 * ## 钉的是什么
 *
 * 路线图 §3 第一条：「**任务是一级对象，不依附聊天。** 一个任务有稳定 ID、目标、
 * 依赖、审批、状态、日志、检查点、产物、验收证据，可以由聊天、工作流、自动化和
 * 多个 Agent 关联或推进。」
 *
 * 在这之前，「任务」只是 `sessions` 表的一个 TEXT 列（`todos`）—— 会话删了任务就没了。
 *
 * 本套钉四件事，每件都对应路线图里的一句原话：
 *
 * | # | 断言 | 对应路线图 |
 * |---|---|---|
 * | 1 | **跨会话查得到** | 「不依附聊天」—— 这是「一级对象」的核心证明 |
 * | 2 | `done` 与 `accepted` 是两个状态 | §3「执行完成不等于验收通过」 |
 * | 3 | `rejected → running` 能返修 | §5「用户能完成、返修并重新验收」 |
 * | 4 | 执行方写不了 `accepted` | §3「证据不够应标 BLOCKED/FAIL，而不是报告成功」 |
 *
 * ## 为什么用真库
 *
 * 这一层要验的是**持久化**（跨会话 = 跨查询，跨重启 = 真正的盘上事实）。用假的
 * repository 会把「表建出来了吗」「JSON 列存得进去吗」全部跳过 —— 而那正是本卡
 * 最可能出错的地方。
 *
 * 数据根走 `MCODE_SMOKE_DATA_ROOT`（stub 没设就抛，与其余套件一致）：
 * **`sql.js` 的 `db.export()` 重写整个 `mcode.db`，指错地方就是拿空库盖用户数据。**
 */
import assert from "node:assert/strict";
import { initDb } from "../../src/main/store/db.js";
import { TaskRepo } from "../../src/main/store/repositories/task.js";
import { registerTaskHandlers } from "../../src/main/ipc/task.js";
// 【T100】执行方那四条不再是 IPC 渠道 —— 它们是进程内函数。套件 import 它们，
// 走的是和 `autoCreate.ts` 完全同一份实现（这才是「套件和生产同一段代码」的意思，
// 而注册一条渲染端够不着的渠道不是）。
import {
  linkTask as linkTaskFn,
  reopenTask as reopenTaskFn,
  transitionTaskAsExecutor,
} from "../../src/main/tasks/executor.js";
import { IPC } from "@contracts/ipc";
import type { Task } from "@contracts/ipc";

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

/* ── 用 fakeIpc 驱动真实 handler ─────────────────────────────────────────── */

// 真建库：`initDb()` 会把表建出来（含 T99 的 tasks）。
await initDb();

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const fakeIpc = { handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never;
registerTaskHandlers(fakeIpc);
const call = <T>(ch: string, ...args: unknown[]): T => handlers.get(ch)!(null, ...args) as T;

/** 执行方建任务（主进程内部路径）。
 *
 * **直接调 `TaskRepo.create`** —— 那就是产品里的建任务入口（`autoCreate.ts:169`
 * 走的是同一条）。建任务没有额外校验，为它再包一层函数只会多一个要维护的转发。 */
let seq = 0;
const createTask = (goal: string, ref = "sess-1"): Task =>
  TaskRepo.create({ id: `task_suite_${++seq}`, task: { goal, origin: { kind: "agent", ref }, dependsOn: [] } });

console.log("\n① 跨会话查得到 —— 「一级对象」的核心证明");
{
  const a = createTask("给这个季度写一份数据报告", "sess-A");
  const b = createTask("把访谈录音整理成纪要", "sess-B");
  const all = call<{ tasks: Task[] }>(IPC.TASK_LIST, {}).tasks;
  check("不带 sessionId 时列出**全部**任务（跨会话）",
    all.some((t) => t.id === a.id) && all.some((t) => t.id === b.id),
    all.map((t) => ({ id: t.id, ref: t.origin.ref })));
  check("两个任务的 origin 是不同的会话",
    all.find((t) => t.id === a.id)?.origin.ref === "sess-A"
    && all.find((t) => t.id === b.id)?.origin.ref === "sess-B");
  // 这一条是「不依附聊天」的直接证据：按 sessionId 筛时，另一个会话的任务**不出现**，
  // 但它在库里（上一条已经证明）—— 所以「查不到」是筛选的结果，不是数据没了。
  const onlyA = call<{ tasks: Task[] }>(IPC.TASK_LIST, { sessionId: "sess-A" }).tasks;
  check("按 sessionId 筛能只拿到该会话的任务",
    onlyA.some((t) => t.id === a.id) && !onlyA.some((t) => t.id === b.id),
    onlyA.map((t) => t.id));
}

console.log("\n② done 与 accepted 是两个状态（§3「执行完成不等于验收通过」）");
{
  const t = createTask("生成一份 PPT", "sess-A");
  check("新建的任务是 pending", t.status === "pending", t.status);
  const running = transitionTaskAsExecutor( { id: t.id, status: "running" });
  check("pending → running", running.status === "running", running.status);
  const done = transitionTaskAsExecutor( {
    id: t.id, status: "done",
    artifacts: [{ path: "/tmp/deck.pptx", description: "季度报告 PPT", createdAt: Date.now() }],
  });
  check("running → done", done.status === "done", done.status);
  check("★ done 时 acceptance 仍是 null（做完了 ≠ 验收过）", done.acceptance === null, done.acceptance);
  check("产物落在任务上（不是挂在会话上）", done.artifacts.length === 1 && done.artifacts[0]!.path === "/tmp/deck.pptx", done.artifacts);

  const accepted = call<Task>(IPC.TASK_ACCEPT, { id: t.id, evidence: "打开看过，图表和数字都对" });
  check("★ accept 之后才是 accepted", accepted.status === "accepted", accepted.status);
  check("验收证据被存下来", accepted.acceptance?.evidence === "打开看过，图表和数字都对", accepted.acceptance);
  check("验收轮次从 1 开始", accepted.acceptance?.round === 1, accepted.acceptance?.round);
}

console.log("\n③ rejected → running 能返修（§5「返修并重新验收」）");
{
  const t = createTask("整理一份访谈纪要", "sess-A");
  transitionTaskAsExecutor( { id: t.id, status: "running" });
  transitionTaskAsExecutor( { id: t.id, status: "done" });
  const rejected = call<Task>(IPC.TASK_REJECT, { id: t.id, reason: "第三段漏了两句" });
  check("done 可以退回 → rejected", rejected.status === "rejected", rejected.status);
  check("退回理由被存下来（返修的人要知道改什么）", rejected.rejectionReason === "第三段漏了两句", rejected.rejectionReason);

  check("★ 退回本身就算一次验收结论（轮次 = 1）", rejected.acceptance?.round === 1, rejected.acceptance?.round);

  const reopened = reopenTaskFn( { id: t.id });
  check("★ rejected → running（返修）", reopened.status === "running", reopened.status);
  // 轮次**不因 reopen 推进**：它记的是「用户给出过几次结论」，重开不是结论。
  check("返修本身不推进轮次（仍是 1）", reopened.acceptance?.round === 1, reopened.acceptance?.round);

  // 返修后能再次走完并再次验收 —— 这才叫「闭环」。
  transitionTaskAsExecutor( { id: t.id, status: "done" });
  const acceptedAgain = call<Task>(IPC.TASK_ACCEPT, { id: t.id, evidence: "第二版补上了" });
  check("返修后能再次验收通过", acceptedAgain.status === "accepted", acceptedAgain.status);
  check("第二轮验收记在第 2 轮", acceptedAgain.acceptance?.round === 2, acceptedAgain.acceptance?.round);
}

console.log("\n④ 执行方写不了 accepted / rejected（§3「不许拿报告成功冒充验收」）");
{
  const t = createTask("写一份市场分析", "sess-A");
  transitionTaskAsExecutor( { id: t.id, status: "running" });
  let escaped: unknown = null;
  try {
    transitionTaskAsExecutor( { id: t.id, status: "accepted" });
  } catch (error) {
    escaped = error;
  }
  check("★ 执行方把状态置为 accepted 被拒", escaped !== null, escaped instanceof Error ? escaped.message : escaped);
  check("被拒后任务状态没变", TaskRepo.get(t.id)?.status === "running", TaskRepo.get(t.id)?.status);
}

console.log("\n④bis ★ 纵深防御：绕过 TASK_EXECUTOR_STATUSES 也写不进 accepted");
{
  // 这一条验的是**迁移表下沉到 `TaskRepo.setStatus` 之后**的防线。
  //
  // 背景：`autoCreate.ts` 走的是 `setStatus`（回合结束自动记任务），它不经过
  // `transitionTaskAsExecutor` 那道白名单。迁移表下沉之前，那条路上 `setStatus`
  // 只查「id 存不存在」，于是**执行方能把任务直接写成 `accepted`** ——
  // 「执行完成 ≠ 验收通过」这条边界在自动记账那条路上不成立。
  //
  // 这里故意**跳过** `transitionTaskAsExecutor`，直接调 `TaskRepo.setStatus`，
  // 模拟「上游白名单漏了」的情况。如果迁移表没下沉，这一条会绿着（写成功）。
  const dt = createTask("绕道上游白名单", "sess-A");
  TaskRepo.setStatus({ id: dt.id, status: "running" });
  let dEscaped: unknown = null;
  try {
    TaskRepo.setStatus({ id: dt.id, status: "accepted" });
  } catch (error) {
    dEscaped = error;
  }
  check("★ 直接 setStatus 写 accepted 被拒（迁移表在 repo 里，不在 handler 里）",
    dEscaped !== null, dEscaped instanceof Error ? dEscaped.message : dEscaped);
  check("被拒后状态仍是 running", TaskRepo.get(dt.id)?.status === "running", TaskRepo.get(dt.id)?.status);

  // 合法的那条仍然通 —— 证明上面那条红不是因为 setStatus 坏掉了
  const dOk = TaskRepo.setStatus({ id: dt.id, status: "done" });
  check("同一入口写合法状态 done 成功（对照：不是 setStatus 全拒）", dOk.status === "done", dOk.status);
}

console.log("\n⑤ 状态机：非法迁移被拒（白名单，不是黑名单）");
{
  const t = createTask("做一份报表", "sess-A");
  let escaped: unknown = null;
  try {
    // pending → done：没跑过就说做完了
    transitionTaskAsExecutor( { id: t.id, status: "done" });
  } catch (error) {
    escaped = error;
  }
  check("★ pending → done 被拒（没跑过不能说做完）", escaped !== null, escaped instanceof Error ? escaped.message : escaped);
}

console.log("\n⑥ 验收只在 done 上合法");
{
  const t = createTask("画一张架构图", "sess-A");
  let escaped: unknown = null;
  try {
    call<Task>(IPC.TASK_ACCEPT, { id: t.id, evidence: "看着不错" });
  } catch (error) {
    escaped = error;
  }
  check("★ pending 状态不能验收", escaped !== null, escaped instanceof Error ? escaped.message : escaped);
}

console.log("\n⑦ 多来源关联（「可以由聊天、工作流、自动化和多个 Agent 关联或推进」）");
{
  const t = createTask("跨会话协作的任务", "sess-OWNER");
  const linked = linkTaskFn( { id: t.id, sessionId: "sess-HELPER" });
  check("关联另一个会话", linked.links.sessionIds.includes("sess-HELPER"), linked.links);
  check("发起者不变（关联 ≠ 改归属）", linked.origin.ref === "sess-OWNER", linked.origin.ref);
  const fromHelper = call<{ tasks: Task[] }>(IPC.TASK_LIST, { sessionId: "sess-HELPER" }).tasks;
  check("被关联的会话也能在自己的列表里看到它", fromHelper.some((x) => x.id === t.id), fromHelper.map((x) => x.id));
}

console.log("\n⑧ 持久化：JSON 列存得进去、读得回来");
{
  const t = createTask("带依赖与产物的任务", "sess-A");
  // 依赖用 create 的 dependsOn（TaskRepo.create 支持）
  const withDeps = TaskRepo.create({
    id: "task_dep_probe",
    task: { goal: "依赖另一个任务", origin: { kind: "workflow", ref: "wf-1" }, dependsOn: [t.id] },
  });
  check("dependsOn 存得住", TaskRepo.get(withDeps.id)?.dependsOn[0] === t.id, TaskRepo.get(withDeps.id)?.dependsOn);
  check("origin 的 kind=workflow 也存得住", TaskRepo.get(withDeps.id)?.origin.kind === "workflow", TaskRepo.get(withDeps.id)?.origin);
}

console.log(`\ntask-first-class-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
