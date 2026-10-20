import { ensureEngineNodeReady } from "../../src/main/workflowEngines/engineNodeReadiness.js";
type Registry = Parameters<typeof ensureEngineNodeReady>[0];
let passed = 0, failed = 0;
const check = (name: string, ok: boolean, details = "") => {
 console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : " " + details));
 if(ok) passed++; else failed++;
};
const calls: string[] = [];
let state: "healthy" | "corrupt" | "after-corrupt" = "corrupt";
const fake = {
 async readState() { calls.push("read"); return state === "corrupt" || (state === "after-corrupt" && calls.filter(x => x === "read").length > 1) ? {kind:"corrupt",reason:"fixture ledger unreadable"} : {kind:"ok",entries:[]}; },
 async recoverCrashBackups() { calls.push("crash"); return {blocked:[]}; },
 async recoverPendingRemovals() { calls.push("removals"); return {failed:[]}; },
 async verifyApprovedPackages() { calls.push("verify"); return {blocked:[]}; },
 async findUnregisteredNodePackages() { calls.push("orphans"); return {blocked:[]}; },
} as unknown as Registry;
async function result() {
 try {await ensureEngineNodeReady(fake); return "ok";}
 catch(e) {return e instanceof Error?e.message:String(e);}
}
check("corrupt ledger fails closed", (await result()).includes("不可读"));
check("corrupt ledger does not mutate crash backups before refusing", calls.join(",") === "read", calls.join(","));
calls.length = 0; state = "healthy";
check("healthy registry is allowed", await result() === "ok");
check("healthy registry runs preflight in integrity-first order", calls.join(",") === "read,crash,removals,read,verify,orphans,read", calls.join(","));
calls.length = 0; state="after-corrupt";
check("ledger corrupted during recovery fails closed", (await result()).includes("不可读"));
check("post-recovery corruption stops before verification", calls.join(",") === "read,crash,removals,read", calls.join(","));
// A once-present durable authorization ledger disappearing between the initial
// validation and the post-recovery validation is not first-run empty state.
// In particular, an empty filesystem scanner cannot prove old approval history.
const lostCalls: string[] = [];
let reads = 0;
const vanishing = {
  async readState() { lostCalls.push("read"); return ++reads === 1
    ? {kind:"ok",entries:[{name:"node-red-contrib-approved",state:"installed"}]}
    : {kind:"absent",entries:[]}; },
  async recoverCrashBackups() {lostCalls.push("crash"); return {blocked:[]}; },
  async recoverPendingRemovals() {lostCalls.push("removals");return {failed:[]}; },
  async verifyApprovedPackages() {lostCalls.push("verify");return {blocked:[]}; },
  async findUnregisteredNodePackages() {lostCalls.push("orphans");return {blocked:[]}; },
} as unknown as Registry;
let vanishedOutcome = "ok";
try {await ensureEngineNodeReady(vanishing);}
catch(e){vanishedOutcome=e instanceof Error?e.message:String(e);}
check("★ existing approved ledger disappearing during recovery fails closed",
  vanishedOutcome !== "ok" && /清单|丢失|消失/.test(vanishedOutcome),vanishedOutcome);
check("★ lost approval ledger must stop before execution verification",
  lostCalls.join(",")==="read,crash,removals,read",lostCalls.join(","));
// A non-deleted, installed approval must not silently disappear from a
// still-well-formed ledger; a competing actor may remove both file and row
// between reads, leaving no orphan for the last scan.
const removedCalls: string[] = [];
let removedReads = 0;
const removedInstalled = {
  async readState() {removedCalls.push("read");return ++removedReads === 1
    ? {kind:"ok",entries:[{name:"node-red-contrib-approved",state:"installed"}]}
    : {kind:"ok",entries:[]}; },
  async recoverCrashBackups() {removedCalls.push("crash");return {blocked:[]};},
  async recoverPendingRemovals() {removedCalls.push("removals");return {failed:[]};},
  async verifyApprovedPackages() {removedCalls.push("verify");return {blocked:[]};},
  async findUnregisteredNodePackages() {removedCalls.push("orphans");return {blocked:[]};},
} as unknown as Registry;
let missingInstalled = "ok";
try {await ensureEngineNodeReady(removedInstalled);}catch(e){missingInstalled=String(e);}
check("★ previously installed approval row cannot disappear unnoticed during preflight",
  missingInstalled !== "ok",missingInstalled);
check("★ missing installed approval halts before package verification",
  removedCalls.join(",")==="read,crash,removals,read",removedCalls.join(","));
// A revocation already marked pending-remove is allowed to disappear after the
// recovery routine finishes removing its executable files; first-run is too.
let pendingReads = 0;
const validRecovery = {
 async readState() {return ++pendingReads === 1
   ? {kind:"ok",entries:[{name:"node-red-contrib-revoked",state:"pending-remove"}]}
   : {kind:"ok",entries:[]}; },
 async recoverCrashBackups() {return {blocked:[]};},
 async recoverPendingRemovals() {return {failed:[]};},
 async verifyApprovedPackages() {return {blocked:[]};},
 async findUnregisteredNodePackages() {return {blocked:[]};},
} as unknown as Registry;
let recoveryResult = "ok";
try {await ensureEngineNodeReady(validRecovery);}
catch(e){recoveryResult=String(e);}
check("legitimate pending-remove recovery can remove the revoked ledger row",
 recoveryResult === "ok",recoveryResult);
// After verifying the packages and scanning orphans, a concurrent revocation
// may remove the entire ledger and files. The final snapshot must be compared
// again before the Host is allowed to spawn Node-RED.
let postScanReads = 0;
const raceCalls: string[] = [];
const changedDuringScan = {
 async readState() {raceCalls.push("read");postScanReads++;
   return postScanReads <= 2
     ? {kind:"ok",entries:[{name:"node-red-contrib-trusted",state:"installed",sha256:"a"}]}
     : {kind:"absent",entries:[]};},
 async recoverCrashBackups() {raceCalls.push("crash");return {blocked:[]};},
 async recoverPendingRemovals() {raceCalls.push("removals");return {failed:[]};},
 async verifyApprovedPackages() {raceCalls.push("verify");return {blocked:[]};},
 async findUnregisteredNodePackages() {raceCalls.push("orphans");return {blocked:[]};},
} as unknown as Registry;
let raced = "ok";
try {await ensureEngineNodeReady(changedDuringScan);}catch(e){raced=String(e);}
check("★ approval ledger replaced during integrity scan is not admitted",
 raced !== "ok" && /清单|变动|变化|替换/.test(raced),raced);
check("★ verify again after orphan scan before allowing engine spawn",
 raceCalls.join(",")==="read,crash,removals,read,verify,orphans,read",raceCalls.join(","));
console.log(`engine-node-preflight-order-smoke: ${passed}/${passed + failed}`);
if(failed) process.exitCode=1;
