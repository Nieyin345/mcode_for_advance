import * as flow from "../../src/main/lib/pendingBackflow.js";
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
function check(name: string, ok: boolean) {
 console.log((ok ? "PASS " : "FAIL ") + name);
 if (ok) pass++; else fail++;
}
const api = flow as typeof flow & {
  pendingBackflowBatch?: (sessionId: string) => { text: string; through: number };
  clearBackflowThrough?: (sessionId: string, through: number) => void;
};
const id = "isolated-fixture-backflow-" + process.pid;
const batch = api.pendingBackflowBatch;
const clear = api.clearBackflowThrough;
check("snapshot batch API exists", typeof batch === "function" && typeof clear === "function");
if (batch && clear) {
 flow.queueBackflow(id, "OLD_RESULT");
 const before = batch(id);
 check("batch text includes old workflow result", before.text.includes("OLD_RESULT"));
 flow.queueBackflow(id, "NEW_DURING_PROVIDER_START");
 clear(id, before.through);
 check("sent old result removed", !flow.pendingBackflowPrompt(id).includes("OLD_RESULT"));
 check("newly queued result remains for next turn", flow.pendingBackflowPrompt(id).includes("NEW_DURING_PROVIDER_START"));
 flow.replaceBackflowSource(id, "memory.creation-snapshot", "EARLIER_MEMORY");
 const earlier = batch(id);
 flow.replaceBackflowSource(id, "memory.creation-snapshot", "LATER_MEMORY");
 clear(id, earlier.through);
 check("new source replacement survives stale ack", flow.pendingBackflowPrompt(id).includes("LATER_MEMORY"));
 check("obsolete source snapshot not re-injected", !flow.pendingBackflowPrompt(id).includes("EARLIER_MEMORY"));
 const retry = batch(id);
 check("repeat peek does not consume queue", flow.pendingBackflowPrompt(id) === retry.text);
 clear(id, retry.through);
 check("ack of sent snapshot clears all matching entries", flow.pendingBackflowPrompt(id) === "");
 flow.queueBackflow(id, "UNDELIVERED");
 const notStarted = batch(id);
 check("failed start keeps same queued text until ack", flow.pendingBackflowPrompt(id) === notStarted.text);
 flow.dropBackflow(id);
}
const budgetId = id + "-resource-bound";
let seeded = true;
try {
 for (let n = 0; n < 1024; n++) flow.queueBackflow(budgetId, "item-" + n);
} catch { seeded = false; }
check("bounded backflow permits normal 1024-entry snapshot", seeded);
const preOverflow = flow.pendingBackflowBatch(budgetId);
let overCountRejected = false;
try { flow.queueBackflow(budgetId, "overflow-item"); } catch { overCountRejected = true; }
check("backflow refuses extra entries instead of unbounded queue growth", overCountRejected);
check("backflow preserves full prior snapshot on rejected overflow",
 flow.pendingBackflowBatch(budgetId).text === preOverflow.text);
flow.dropBackflow(budgetId);
let overSizeRejected = false;
try { flow.replaceBackflowSource(budgetId, "memory.creation-snapshot", "M".repeat(4 * 1024 * 1024 + 1)); }
catch { overSizeRejected = true; }
check("oversize memory snapshot fails closed before filling main process heap", overSizeRejected);
check("oversize rejection does not leave partial source material", flow.pendingBackflowPrompt(budgetId) === "");
const stableId = budgetId + "-replace";
flow.replaceBackflowSource(stableId, "memory.creation-snapshot", "earlier");
flow.replaceBackflowSource(stableId, "memory.creation-snapshot", "updated");
check("source replacement still works within queue resource budget",
 flow.pendingBackflowPrompt(stableId).includes("updated")
 && !flow.pendingBackflowPrompt(stableId).includes("earlier"));
flow.dropBackflow(stableId);
const runtime = readFileSync("src/main/claude/RuntimeManager.ts", "utf8");
check("production RuntimeManager captures batch before provider start", runtime.includes("pendingBackflowBatch(session.id)"));
check("production RuntimeManager clears only acknowledged batch", runtime.includes("clearBackflowThrough(session.id, backflowBatch.through)"));
console.log(`backflow-inflight-smoke: ${pass}/${pass + fail}`);
if (fail) process.exitCode = 1;
