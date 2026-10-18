/**
 * ARC-006 workflow history + hook audit read-side resource lifetime.
 * Uses the real production repositories and an isolated sql.js DB; only its
 * prepare() method is temporarily replaced by a controlled fake statement.
 * No user databases or external hosts are accessed.
 */
import { getDb, initDb, closeDb } from "@main/store/db.js";
import { WorkflowRunRepo } from "@main/store/repositories/workflowRun.js";
import { HookRunRepo } from "@main/store/repositories/hookRun.js";

let passed = 0, failed = 0;
function check(title: string, ok: boolean, info?: unknown): void {
  if (ok) { passed++; console.log("  ok   " + title); }
  else { failed++; console.log("  FAIL " + title + (info === undefined ? "" : " — " + JSON.stringify(info))); }
}
const workflowRow = {
  id: "run_demo", session_id: "session_demo", workflow_id: "workflow_demo",
  status: "interrupted", awaiting_node: "node_42,node_99", payload: "{}",
  created_at: 11, updated_at: 22,
};
const hookRow = {
  run_id: "hook_run_demo", hook_id: "hook_demo", source: "user",
  plugin_id: "user", plugin_version: null, native_event: "PreToolUse",
  command_digest: "sha_demo", matcher_digest: null, event: "tool.use",
  session_id: "session_demo", session_kind: "normal", status: "ok",
  exit_code: 0, duration_ms: 7, error: null, started_at: 33,
};
type TestCase = {
  name: string;
  run: () => unknown;
  useBind: boolean;
  sqlPart: string;
  rowId: (result: unknown) => unknown;
  expected: string;
};
const cases: TestCase[] = [
  { name: "workflow.get", run: () => WorkflowRunRepo.get("run_demo"), useBind: true,
    sqlPart: "WHERE id = ?", rowId: (r) => (r as { id?: string } | null)?.id, expected: "run_demo" },
  { name: "workflow.listForAutomationWorkflow",
    run: () => WorkflowRunRepo.listForAutomationWorkflow("workflow_demo", 10), useBind: true,
    sqlPart: "s.kind = 'automation'", rowId: (r) => (r as { id?: string }[])[0]?.id, expected: "run_demo" },
  { name: "workflow.listForSession", run: () => WorkflowRunRepo.listForSession("session_demo", 10), useBind: true,
    sqlPart: "WHERE session_id = ?", rowId: (r) => (r as { id?: string }[])[0]?.id, expected: "run_demo" },
  { name: "workflow.resumableFor", run: () => WorkflowRunRepo.resumableFor("session_demo", "node_42"), useBind: true,
    sqlPart: "status = 'interrupted'", rowId: (r) => (r as { id?: string } | null)?.id, expected: "run_demo" },
  { name: "hook.get", run: () => HookRunRepo.get("hook_run_demo"), useBind: true,
    sqlPart: "WHERE run_id = ?", rowId: (r) => (r as { runId?: string } | null)?.runId, expected: "hook_run_demo" },
  { name: "hook.listForHook", run: () => HookRunRepo.listForHook("hook_demo", 10), useBind: true,
    sqlPart: "WHERE hook_id = ?", rowId: (r) => (r as { runId?: string }[])[0]?.runId, expected: "hook_run_demo" },
  { name: "hook.list", run: () => HookRunRepo.list(10), useBind: true,
    sqlPart: "ORDER BY started_at DESC", rowId: (r) => (r as { runId?: string }[])[0]?.runId, expected: "hook_run_demo" },
];

await initDb();
const db = getDb() as unknown as { prepare: (sql: string) => unknown };
const origPrepare = db.prepare;
try {
  for (const test of cases) {
    for (const stage of ["bind", "step", "row"] as const) {
      if (stage === "bind" && !test.useBind) continue;
      const error = new Error("INJECTED_" + test.name + "_" + stage);
      let frees = 0, prepares = 0;
      db.prepare = () => {
        prepares++;
        return {
          bind: () => { if (stage === "bind") throw error; },
          step: () => { if (stage === "step") throw error; return true; },
          getAsObject: () => { if (stage === "row") throw error; return test.name.startsWith("hook.") ? hookRow : workflowRow; },
          free: () => { frees++; },
        };
      };
      let thrown: unknown = null;
      try { test.run(); } catch (e) { thrown = e; }
      check(test.name + "/" + stage + " 向上抛原始故障，不伪装空历史", thrown === error, String(thrown));
      check(test.name + "/" + stage + " 异常路径释放一次 statement", frees === 1 && prepares === 1,
        { frees, prepares });
    }
    for (const stage of ["empty", "one"] as const) {
      let frees = 0, prepares = 0, sqlText = "", binds = 0, steps = 0;
      db.prepare = (sql: string) => {
        prepares++; sqlText = sql;
        return {
          bind: () => { binds++; },
          step: () => { steps++; return stage === "one" && steps === 1; },
          getAsObject: () => test.name.startsWith("hook.") ? hookRow : workflowRow,
          free: () => { frees++; },
        };
      };
      let actual: unknown, thrown: unknown = null;
      try { actual = test.run(); } catch (e) { thrown = e; }
      check(test.name + "/" + stage + " 正常历史投影不丢失或伪造",
        thrown === null && test.rowId(actual) === (stage === "one" ? test.expected : undefined),
        { actual: thrown ? String(thrown) : test.rowId(actual), expected: stage === "one" ? test.expected : undefined });
      check(test.name + "/" + stage + " 正常结束释放一次", frees === 1 && prepares === 1 && (!test.useBind || binds === 1),
        { frees, prepares, binds });
      check(test.name + "/" + stage + " 查询条件保持一致", sqlText.includes(test.sqlPart), sqlText);
    }
  }
} finally {
  db.prepare = origPrepare;
  closeDb();
}
console.log("arc006-statement-lifetime-smoke " + passed + "/" + (passed + failed) + " PASS");
if (failed > 0) process.exitCode = 1;
