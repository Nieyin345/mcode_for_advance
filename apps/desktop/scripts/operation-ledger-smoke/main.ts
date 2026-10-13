/**
 * Headless smoke for **DurableOperationLedger 的 durableRevision 落账**(ARC-009)。
 *
 * ## 它证的是什么
 *
 * `OperationResult.durableRevision` 此前是个只声明不兑现的可选字段。上一步让
 * `commitNow()` 在成功落盘时带出进程内序号;这一步让**操作账本的结算**在落盘成功
 * (`DURABLE`)时把那个版本号盖进结果 —— 于是同 id 回放时,调用方能读到「这一份是哪次
 * 落盘」。失败路径**不盖**(没 fsync 就没有版本,编一个就是假成功)。
 *
 * ## 隔离
 *
 * 真 sql.js + 真临时库(数据根指向 `mktemp -d`,见 stubs 里那句「没设就抛」)。
 * 用的就是生产那份 `DurableOperationLedger`。
 *
 * Run: scripts/operation-ledger-smoke/run.sh
 */
import initSqlJs from "sql.js/dist/sql-asm.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb } from "@main/store/db.js";
import { DurableOperationLedger } from "@main/store/operationLedger.js";
import type { OperationIntent, OperationResult } from "@contracts/appControl";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const root = mkdtempSync(join(tmpdir(), "mcode-op-ledger-"));
process.env.MCODE_SMOKE_DATA_ROOT = root;

try {
  await initSqlJs().then(async () => { await initDb(); });
  const ledger = DurableOperationLedger;
  const intent = (over: Partial<OperationIntent>): OperationIntent => ({
    operationId: "op_rev",
    ownerId: "sess-A",
    sessionId: "sess-A",
    sceneId: "app_api_call",
    method: "setting.set",
    requestDigest: "digest-1",
    effectKind: "mutating",
    grantRevision: "default",
    ...over,
  });

  // ── mutating 结算:落盘成功 → 结果带 durableRevision ──
  eq("领取成功", ledger.begin(intent({})).begin, "claimed");
  const okResult: OperationResult = { resultKind: "SUCCEEDED", operationId: "op_rev", method: "setting.set", retryable: false, warnings: [], resources: [] };
  ledger.settle("op_rev", { status: "SUCCEEDED", result: okResult, body: "b" });
  const rev = ledger.get("op_rev")?.result?.durableRevision;
  check("★ mutating 结算落盘成功 → 结果带 durableRevision", typeof rev === "string" && rev.startsWith("sqlite:"), rev);

  // ── 回放读得到同一个 durableRevision(不是回放时新编) ──
  const replay = ledger.begin(intent({}));
  eq("同意图再领 → 回放", replay.begin, "replay");
  eq("★ 回放带回同一个 durableRevision", replay.record.result?.durableRevision, rev);

  // ── 只读结算:不落盘(走 persist)→ 不该带 durableRevision ──
  const roIntent = intent({ operationId: "op_ro", requestDigest: "digest-ro", effectKind: "readonly" });
  ledger.begin(roIntent);
  ledger.settle("op_ro", { status: "SUCCEEDED", result: { resultKind: "SUCCEEDED", operationId: "op_ro", method: "setting.get", retryable: false, warnings: [], resources: [] } });
  eq("★ 只读结算不落盘 → 不带 durableRevision(不编版本号)", ledger.get("op_ro")?.result?.durableRevision, undefined);

  // ── 两次 mutating 结算:版本号严格递增(回答「哪个更新」) ──
  eq("第二次领取成功", ledger.begin(intent({ operationId: "op_rev2", requestDigest: "digest-2" })).begin, "claimed");
  ledger.settle("op_rev2", { status: "SUCCEEDED", result: { resultKind: "SUCCEEDED", operationId: "op_rev2", method: "setting.set", retryable: false, warnings: [], resources: [] } });
  const rev2 = ledger.get("op_rev2")?.result?.durableRevision;
  const n1 = Number(rev?.slice("sqlite:".length));
  const n2 = Number(rev2?.slice("sqlite:".length));
  check("★ 两次落盘版本号严格递增(后一次更大)", Number.isFinite(n1) && Number.isFinite(n2) && n2 > n1, { n1, n2 });

  // ── 结算**没带** result 时不炸(留 undefined) ──
  eq("第三次领取成功", ledger.begin(intent({ operationId: "op_nr", requestDigest: "digest-3" })).begin, "claimed");
  ledger.settle("op_nr", { status: "SUCCEEDED" });
  eq("结算不带 result → 不炸,结果仍 undefined", ledger.get("op_nr")?.result, undefined);
} finally {
  try { closeDb(); } catch { /* preserve test failure */ }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\noperation-ledger-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
