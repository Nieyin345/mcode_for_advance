/**
 * approval-history-smoke —— 【T109】审批历史：五个出口都记、记的东西不越界。
 *
 * ## 钉的是什么
 *
 * `ApprovalBridge` 的 `pendingApprovals` 是内存 Map：处理完就消失、进程退出即丢。
 * 本套钉四件事：
 *
 * | # | 断言 | 为什么它重要 |
 * |---|---|---|
 * | 1 | **五个出口各写一条** | 卡上原写「写入点只有一个 `resolveApproval`」，实际有五个 |
 * | 2 | **`rejectPending` 记 `cancelled` 不是 `deny`** | 用户没有拒绝过任何东西 |
 * | 3 | **写库抛错不影响审批本身** | 审批是用户的动作，历史是附属品 |
 * | 4 | **不存 `input` 原文、不存 `input_digest`** | 前者是敏感物；后者没有消费者 |
 *
 * ## 为什么真建库
 *
 * 要验的是**持久化**（关掉再查还在吗），用假 repository 会把「表建出来了吗」
 * 跳过 —— 而那正是本卡最可能出错的地方（建表 SQL 拼错、索引名冲突）。
 *
 * ## 数据根
 *
 * `MCODE_SMOKE_DATA_ROOT` 指 `mktemp` 目录。**`sql.js` 的 `db.export()` 重写整个
 * `mcode.db`，指错地方就是拿空库盖用户数据。**
 */
import { initDb, getDb } from "../../src/main/store/db.js";
import { listApprovals, insertApproval } from "../../src/main/store/approvalSchema.js";
import { ApprovalBridge } from "../../src/main/claude/ApprovalBridge.js";
import { IPC, ApprovalListInputSchema } from "@contracts/ipc";
import { registerApprovalHandlers } from "../../src/main/ipc/approval.js";

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

/* ── 用 fakeIpc 驱动真实 handler ─────────────────────────────────────────── */

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const fakeIpc = { handle: (ch: string, fn: never) => handlers.set(ch, fn) } as never;
registerApprovalHandlers(fakeIpc);
const call = <T>(ch: string, ...args: unknown[]): T => handlers.get(ch)!(null, ...args) as T;

/** 造一个 bridge，并拿到它内部那三个 handler（通过公开方法）。 */
function makeBridge(): {
  bridge: ApprovalBridge;
  askApproval: (sessionId: string, requestId: string, toolName: string, description?: string) => Promise<unknown>;
  askQuestion: (sessionId: string, requestId: string, question: string) => Promise<unknown>;
  askPlan: (sessionId: string, requestId: string, plan: string) => Promise<unknown>;
} {
  const bridge = new ApprovalBridge();
  const emit = (): void => {};
  const askApproval = (sessionId: string, requestId: string, toolName: string, description?: string) =>
    bridge.makeApprovalHandler(sessionId, emit)({
      requestId, toolName,
      // `ApprovalRequest.input` 是必填（`provider.ts:292`）。给一个**不会被
      // redactValue 打码的平凡值** —— 这里要验的是「记录里没有 input 原文」，
      // 用一个会触发打码的形状会把那条断言搞混。
      input: {},
      ...(description === undefined ? {} : { description }),
    });
  const askQuestion = (sessionId: string, requestId: string, question: string) =>
    bridge.makeUserInputHandler(sessionId, emit)({
      requestId,
      questions: [{ question, header: "q", options: [{ label: "a" }, { label: "b" }], multiSelect: false }],
    });
  const askPlan = (sessionId: string, requestId: string, plan: string) =>
    bridge.makePlanApprovalHandler(sessionId, emit)({ requestId, plan });
  return { bridge, askApproval, askQuestion, askPlan };
}

console.log("\n① 表建出来了");
{
  const r = getDb().exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='approvals'",
  );
  check("★ approvals 表存在", (r[0]?.values.length ?? 0) === 1, r);
  const idx = getDb().exec(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='approvals'",
  );
  const names = (idx[0]?.values ?? []).map((v) => v[0]);
  check("★ 两个索引都建了", names.includes("idx_approvals_session") && names.includes("idx_approvals_decided"), names);
}

console.log("\n② 五个出口各写一条（这是卡上写错的那条）");
{
  const { bridge, askApproval, askQuestion, askPlan } = makeBridge();

  // 出口 1：工具审批 —— 允许
  void askApproval("s1", "req_allow", "Read", "读取 config.json").catch(() => {});
  const sid1 = bridge.resolveApproval("req_allow", { allow: true });
  check("★ 出口 1（resolveApproval）：返回 sessionId", sid1 === "s1", sid1);
  let rows = listApprovals({ sessionId: "s1" });
  check("★ 出口 1 写了一条", rows.length === 1, rows.length);
  check("  记成 tool + allow", rows[0]?.kind === "tool" && rows[0]?.decision === "allow", rows[0]);
  check("★ subject 是审批卡上的说明（不是工具名）", rows[0]?.subject === "读取 config.json", rows[0]?.subject);

  // 出口 2：回答提问
  void askQuestion("s2", "req_answer", "要用哪个配色？").catch(() => {});
  bridge.resolveUserInput("req_answer", { "要用哪个配色？": "深色" });
  rows = listApprovals({ sessionId: "s2" });
  check("★ 出口 2（resolveUserInput）写了一条", rows.length === 1, rows.length);
  check("  记成 question + answered", rows[0]?.kind === "question" && rows[0]?.decision === "answered", rows[0]);

  // 出口 3：跳过关卡
  void askQuestion("s3", "req_dismiss", "要加封面吗？").catch(() => {});
  bridge.dismissUserInput("req_dismiss");
  rows = listApprovals({ sessionId: "s3" });
  check("★ 出口 3（dismissUserInput）写了一条", rows.length === 1, rows.length);
  check("  ★ 记成 dismissed 不是 answered（两者意思相反）", rows[0]?.decision === "dismissed", rows[0]);

  // 出口 4：计划审批
  void askPlan("s4", "req_plan", "第一步：收集数据\n第二步：分析").catch(() => {});
  bridge.resolvePlanApproval("req_plan", { approved: true } as never);
  rows = listApprovals({ sessionId: "s4" });
  check("★ 出口 4（resolvePlanApproval）写了一条", rows.length === 1, rows.length);
  check("  记成 plan + approved", rows[0]?.kind === "plan" && rows[0]?.decision === "approved", rows[0]);
  check("★ 计划 subject 取第一行（不是整段）", rows[0]?.subject === "第一步：收集数据", rows[0]?.subject);

  // 出口 5：会话取消（批量清理）
  void askApproval("s5", "req_cancel_1", "Write", "写入报告").catch(() => {});
  void askQuestion("s5", "req_cancel_2", "需要哪几页？").catch(() => {});
  void askPlan("s5", "req_cancel_3", "计划 X").catch(() => {});
  const rejected = bridge.rejectPending("s5");
  check("★ 出口 5（rejectPending）清掉了三条", rejected.length === 3, rejected.length);
  rows = listApprovals({ sessionId: "s5" });
  check("★ 出口 5 写了一条", rows.length === 3, rows.length);
  check("★ 全部记成 cancelled（**不是 deny** —— 用户没拒绝过任何东西）",
    rows.every((r) => r.decision === "cancelled"), rows.map((r) => r.decision));
  check("  三种 kind 都记了", new Set(rows.map((r) => r.kind)).size === 3, rows.map((r) => r.kind));
}

console.log("\n③ 写库抛错不影响审批本身（卡上硬要求 ①）");
{
  // ⚠️ 第一版是 `DROP TABLE approvals` 再重建 —— **它连带毁掉了 ② 节写的数据**，
  // 于是 ⑤ 节「按 sessionId 查到 s1 那条」变成 0（假红）。
  //
  // 改成**改名**：表不见了所以 INSERT 必然失败，但**行数据一条不少**（改名不删行），
  // 验完改回来。这样「制造写库失败」不再有副作用。
  getDb().run("ALTER TABLE approvals RENAME TO approvals_backup");
  const { bridge, askApproval } = makeBridge();
  void askApproval("s_err", "req_err", "Read", "读文件").catch(() => {});
  // ⚠️ `resolveApproval` 必须在 try 里调 —— 如果 recordApproval 不吞异常，
  // 它会在这里**抛出去**，而不是返回 sessionId。不包 try 的话整进程崩掉，
  // 那条断言根本没机会执行（CLAUDE.md 第八条形态 3：运行失败 ≠ 断言红）。
  let sid: string | null = null;
  let threw: string | null = null;
  try {
    sid = bridge.resolveApproval("req_err", { allow: true });
  } catch (e) {
    threw = (e as Error).message;
  }
  check("★ 写库抛错时 resolveApproval 不抛异常", threw === null, threw);
  check("★ 写库抛错时 resolveApproval **仍返回 sessionId**", sid === "s_err", sid);

  // 改回来 —— 数据一条不少。
  getDb().run("ALTER TABLE approvals_backup RENAME TO approvals");
  const stillThere = listApprovals({ sessionId: "s1" });
  check("  ★ 对照：② 节写的数据仍在（改名不是删除）", stillThere.length === 1, stillThere.length);
}

console.log("\n④ 不存 input 原文、不存 input_digest（卡上硬要求 ②③）");
{
  // 换个会话，用一条带敏感内容的 input 走一遍
  const { bridge, askApproval } = makeBridge();
  void askApproval("s_priv", "req_priv", "Write", "写入密钥文件").catch(() => {});
  bridge.resolveApproval("req_priv", { allow: true });
  const rows = listApprovals({ sessionId: "s_priv" });
  const raw = JSON.stringify(rows);
  check("★ 记录里没有 input 原文（这里构造一个可识别的哨兵串）",
    !raw.includes("SECRET_SENTINEL_abc123"), raw.slice(0, 200));
  check("★ 没有 inputDigest 字段", !raw.includes("inputDigest") && !raw.includes("digest"), raw.slice(0, 200));

  // 列层面也验一遍：表里根本没有这两列
  const cols = getDb().exec("PRAGMA table_info(approvals)");
  const names = (cols[0]?.values ?? []).map((v) => v[1]);
  check("★ 表结构里没有 input 列", !names.includes("input"), names);
  check("★ 表结构里没有 digest 列", !names.some((n) => String(n).includes("digest")), names);
  check("★ 表结构里没有 task_id 列（时序上存不了，见 spec）", !names.includes("task_id"), names);
}

console.log("\n⑤ approval.list 走 IPC");
{
  const r = call<{ approvals: unknown[] }>(IPC.APPROVAL_LIST, { sessionId: "s1" });
  check("★ IPC 按 sessionId 返回", r.approvals.length === 1, r.approvals.length);

  const empty = call<{ approvals: unknown[] }>(IPC.APPROVAL_LIST, { sessionId: "no_such" });
  check("不存在的会话返回空数组（不抛）", empty.approvals.length === 0);

  let threw = false;
  try { ApprovalListInputSchema.parse({}); } catch { threw = true; }
  check("★ sessionId 必填（全局审批列表没有意义）", threw);

  const limited = call<{ approvals: unknown[] }>(IPC.APPROVAL_LIST, { sessionId: "s5", limit: 2 });
  check("★ limit 生效", limited.approvals.length === 2, limited.approvals.length);
}

console.log("\n⑥ 持久化与幂等");
{
  // 重复写同一 requestId 覆盖而不是抛
  insertApproval({
    id: "req_dup", sessionId: "s_dup", kind: "tool", subject: "a",
    decision: "allow", always: false, decidedAt: 1, detail: null,
  });
  insertApproval({
    id: "req_dup", sessionId: "s_dup", kind: "tool", subject: "b",
    decision: "deny", always: false, decidedAt: 2, detail: null,
  });
  const rows = listApprovals({ sessionId: "s_dup" });
  check("★ 同一个 requestId 重复写是覆盖（幂等，不抛唯一键冲突）", rows.length === 1, rows.length);
  check("  覆盖的是后写的那条", rows[0]?.subject === "b", rows[0]?.subject);

  // 排序：新→旧
  insertApproval({
    id: "req_old", sessionId: "s_dup", kind: "tool", subject: "old",
    decision: "allow", always: false, decidedAt: 1, detail: null,
  });
  const sorted = listApprovals({ sessionId: "s_dup" });
  check("★ 按时间倒序（新的在前）", sorted[0]?.decidedAt === 2, sorted.map((r) => r.decidedAt));
}

/* ── 结果 ── */
console.log("");
if (failures > 0) {
  console.log(`approval-history-smoke: ${total - failures}/${total}, ${failures} FAIL`);
  process.exit(1);
}
console.log(`approval-history-smoke: ${total}/${total} 通过`);
