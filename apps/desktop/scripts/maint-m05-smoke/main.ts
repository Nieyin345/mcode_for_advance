/**
 * MAINT-2026-09 / M05 smoke — CodexMessageAdapter.
 *
 * Codex collab subagents run their own threads/turns on the SAME app-server
 * connection. Item/delta frames were already routed by threadId, but the
 * turn-level frames were not:
 *   - a subagent's `turn/completed` ended the MAIN turn (the provider then
 *     disposes the app-server → main agent killed mid-turn);
 *   - a subagent's `thread/tokenUsage/updated` overwrote the main occupancy;
 *   - a subagent's terminal `error` surfaced as the main turn's error card;
 *   - a subagent's `turn/plan/updated` replaced the main todo card;
 *   - a subagent's `turn/diff/updated` replaced the main turn diff (lost
 *     main-thread writes from the file card / rewind).
 * Token accounting: Codex `inputTokens` already includes `cachedInputTokens`
 * (double-counted), and a multi-request turn reported only its last request
 * although ContextSnapshot is per-turn cumulative (budget guard / usage stats).
 */
import { CodexMessageAdapter } from "@main/providers/codex-sdk/CodexMessageAdapter.js";
import { buildCodexTokenSnapshot } from "@main/providers/codex-sdk/codexTokenUsage.js";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

type Ev = { type: string; [k: string]: unknown };
const MAIN = "thr-main";
const SUB = "thr-sub-1";

function harness() {
  const events: Ev[] = [];
  const logs: string[] = [];
  const snap = {
    lastDiff: "",
    setTurnDiff(d: string) { this.lastDiff = d; },
    async freeze() { return []; },
  };
  const ctx = {
    emit: (e: Ev) => events.push(e),
    log: {
      info: (m: string) => logs.push(`info ${m}`),
      warn: (m: string) => logs.push(`warn ${m}`),
      error: (m: string) => logs.push(`error ${m}`),
      debug: () => {},
    },
  };
  const adapter = new CodexMessageAdapter(ctx as never, "s1", snap as never, undefined);
  adapter.setMainThreadId(MAIN);
  const send = (method: string, params: Record<string, unknown>) =>
    adapter.handleNotification({ method, params } as never);
  return { adapter, events, logs, snap, send };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

console.log("\n1. subagent turn/completed must not end the main turn");
{
  const h = harness();
  let resolved: string | null = null;
  void h.adapter.waitTurnDone().then((r) => { resolved = r; });
  h.send("turn/completed", { threadId: SUB, turn: { id: "t-sub", status: "completed" } });
  await tick();
  eq("★ main turn still running after subagent completes", h.adapter.hasTurnEnded, false);
  eq("★ waitTurnDone not resolved by the subagent", resolved, null);
  eq("★ no turn.done emitted for the subagent", h.events.filter((e) => e.type === "turn.done").length, 0);
  h.send("turn/completed", { threadId: SUB, turn: { id: "t-sub2", status: "interrupted" } });
  h.send("turn/completed", { threadId: SUB, turn: { id: "t-sub3", status: "failed" } });
  await tick();
  eq("★ interrupted/failed subagent turns do not end it either", h.adapter.hasTurnEnded, false);
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t-main", status: "completed" } });
  await tick();
  eq("control: main turn/completed ends the turn", resolved, "end_turn");
  eq("control: exactly one turn.done", h.events.filter((e) => e.type === "turn.done").length, 1);
}
{
  const h = harness();
  let resolved: string | null = null;
  void h.adapter.waitTurnDone().then((r) => { resolved = r; });
  h.send("turn/completed", { turn: { id: "legacy", status: "completed" } });
  await tick();
  eq("control: frame without threadId still treated as main (legacy)", resolved, "end_turn");
}

console.log("\n2. subagent error / plan are not the main turn's");
{
  const h = harness();
  h.send("error", { threadId: SUB, willRetry: false, error: { message: "child quota exceeded" } });
  eq("★ subagent terminal error does not emit a main error card", h.events.filter((e) => e.type === "error").length, 0);
  check("subagent error is logged", h.logs.some((l) => l.includes("child quota exceeded")), h.logs);
  h.send("turn/plan/updated", { threadId: MAIN, plan: [{ step: "main step", status: "inProgress" }] });
  h.send("turn/plan/updated", { threadId: SUB, plan: [{ step: "sub step", status: "pending" }] });
  const todos = h.events.filter((e) => e.type === "todo.update");
  eq("★ only the main plan reaches the todo card", todos.length, 1);
  h.send("error", { threadId: MAIN, willRetry: false, error: { message: "main failed" } });
  eq("control: main terminal error still surfaces", h.events.filter((e) => e.type === "error" && e.message === "main failed").length, 1);
}

console.log("\n3. turn diff: subagent diff must not replace the main diff");
{
  const h = harness();
  const mainDiff = "diff --git a/main.txt b/main.txt\n--- a/main.txt\n+++ b/main.txt\n@@ -1 +1 @@\n-a\n+b\n";
  const subDiff = "diff --git a/sub.txt b/sub.txt\n--- a/sub.txt\n+++ b/sub.txt\n@@ -1 +1 @@\n-x\n+y\n";
  h.send("turn/diff/updated", { threadId: MAIN, turnId: "t-main", diff: mainDiff });
  h.send("turn/diff/updated", { threadId: SUB, turnId: "t-sub", diff: subDiff });
  check("★ main-thread section kept after a subagent diff arrives", h.snap.lastDiff.includes("a/main.txt"), h.snap.lastDiff);
  check("subagent section also present", h.snap.lastDiff.includes("a/sub.txt"), h.snap.lastDiff);
  check("main diff comes first", h.snap.lastDiff.indexOf("main.txt") < h.snap.lastDiff.indexOf("sub.txt"));
  check("no blank line injected between the two diffs", !h.snap.lastDiff.includes("+b\n\ndiff"), h.snap.lastDiff);
  const mainDiff2 = mainDiff.replace("+b", "+c");
  h.send("turn/diff/updated", { threadId: MAIN, turnId: "t-main", diff: mainDiff2 });
  check("main diff update replaces only the main part", h.snap.lastDiff.includes("+c") && !h.snap.lastDiff.includes("+b") && h.snap.lastDiff.includes("a/sub.txt"), h.snap.lastDiff);
}
{
  const h = harness();
  const d = "diff --git a/only.txt b/only.txt\n--- a/only.txt\n+++ b/only.txt\n@@ -1 +1 @@\n-a\n+b\n";
  h.send("turn/diff/updated", { threadId: MAIN, diff: d });
  eq("control: single main diff passed through unchanged", h.snap.lastDiff, d);
}

console.log("\n4. token usage");
const u = (i: number, c: number, o: number, r = 0) => ({ inputTokens: i, cachedInputTokens: c, outputTokens: o, reasoningOutputTokens: r, totalTokens: i + o });
{
  // Single request with a cache hit: 10000 input (8000 of them cached) + 500 out.
  const s = buildCodexTokenSnapshot(u(10000, 8000, 500), 200_000)!;
  eq("★ totalProcessed = input + output (cached is a subset of input)", s.totalProcessedTokens, 10500);
  eq("cacheReadTokens still reported", s.cacheReadTokens, 8000);
  eq("occupancy = last input", s.usedTokens, 10000);
  eq("pct from last input", s.pct, 5);
}
{
  const h = harness();
  // Turn with two model requests (tool loop), on a resumed thread whose
  // cumulative total already holds 50 000 input / 4 000 output.
  h.send("thread/tokenUsage/updated", { threadId: MAIN, turnId: "t", tokenUsage: { last: u(1000, 0, 100), total: u(51000, 30000, 4100), modelContextWindow: 100_000 } });
  // A subagent's (larger) usage in between must not leak into the main gauge.
  h.send("thread/tokenUsage/updated", { threadId: SUB, turnId: "ts", tokenUsage: { last: u(90000, 0, 50), total: u(90000, 0, 50), modelContextWindow: 100_000 } });
  h.send("thread/tokenUsage/updated", { threadId: MAIN, turnId: "t", tokenUsage: { last: u(1300, 1000, 150), total: u(52300, 31000, 4250), modelContextWindow: 100_000 } });
  // …and a subagent update arriving LAST (right before the main turn ends).
  h.send("thread/tokenUsage/updated", { threadId: SUB, turnId: "ts", tokenUsage: { last: u(95000, 0, 60), total: u(185000, 0, 110), modelContextWindow: 100_000 } });
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t", status: "completed" } });
  const tu = h.events.filter((e) => e.type === "token-usage.updated");
  // 主线程每次 tokenUsage 更新发一张(中途,供轮预算止损)+ 回合末一张;子代理的不发。
  eq("★ mid-turn snapshots (main thread only) + one turn-end snapshot", tu.length, 3);
  eq("★ mid-turn snapshot already counts the first request (1000 in + 100 out)", (tu[0]?.snapshot as { totalProcessedTokens: number } | undefined)?.totalProcessedTokens, 1100);
  const s = tu[tu.length - 1]?.snapshot as { usedTokens: number; totalProcessedTokens: number; outputTokens: number; cacheReadTokens: number; pct: number } | undefined;
  eq("★ occupancy is the main thread's last request, not the subagent's", s?.usedTokens, 1300);
  eq("★ turn totalProcessed covers both requests (2300 in + 250 out)", s?.totalProcessedTokens, 2550);
  eq("★ turn outputTokens covers both requests", s?.outputTokens, 250);
  eq("turn cacheReadTokens covers both requests", s?.cacheReadTokens, 1000);
}
{
  const h = harness();
  h.send("thread/tokenUsage/updated", { threadId: MAIN, tokenUsage: { last: u(700, 200, 30) } });
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t", status: "completed" } });
  const s = h.events.find((e) => e.type === "token-usage.updated")?.snapshot as { totalProcessedTokens: number } | undefined;
  eq("control: no `total` from the server → falls back to last (700 + 30)", s?.totalProcessedTokens, 730);
}
{
  const h = harness();
  h.send("turn/completed", { threadId: MAIN, turn: { id: "t", status: "completed" } });
  eq("control: no usage reported → no snapshot", h.events.filter((e) => e.type === "token-usage.updated").length, 0);
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
