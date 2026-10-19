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
check("healthy registry runs preflight in integrity-first order", calls.join(",") === "read,crash,removals,read,verify,orphans", calls.join(","));
calls.length = 0; state="after-corrupt";
check("ledger corrupted during recovery fails closed", (await result()).includes("不可读"));
check("post-recovery corruption stops before verification", calls.join(",") === "read,crash,removals,read", calls.join(","));
console.log(`engine-node-preflight-order-smoke: ${passed}/${passed + failed}`);
if(failed) process.exitCode=1;
