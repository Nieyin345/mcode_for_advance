/**
 * Cross-process admission control for memory-heavy Mcode UI tests.
 *
 * One lock per repository, shared by direct Electron U1 builders and the
 * smoke runner. Contention fails fast before esbuild/Chromium are started.
 * The owner is an OS PID; a crashed owner can be reclaimed, but a live owner
 * must never be preempted. This is test orchestration, not a security boundary.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_NAME = "mcode-heavy-test.lock";

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === "EPERM"; }
}

function ownerAt(dir) {
  try {
    const obj = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
    if (Number.isSafeInteger(obj.pid) && obj.pid > 0 &&
        typeof obj.token === "string" && obj.token.length > 0)
      return obj;
  } catch { /* Missing or torn metadata: refuse to steal a possibly live lease. */ }
  return null;
}

/** Reclaim only a *dead*, identified owner. A half-created lease is busy. */
function reclaimDead(dir, owner) {
  if (!owner || alive(owner.pid)) return false;
  const retired = dir + ".retired-" + randomUUID();
  try {
    // Rename is atomic. Only the process that renames the old lock can
    // remove it; do not recursively delete the shared lock path directly.
    const before = statSync(dir);
    renameSync(dir, retired);
    const after = ownerAt(retired);
    if (before.ino !== statSync(retired).ino || !after ||
        after.token !== owner.token || after.pid !== owner.pid) {
      // Could be a newer live lease (race with another reclaimer). Preserve it.
      if (!existsSync(dir)) renameSync(retired, dir);
      return false;
    }
    rmSync(retired, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

export function acquireHeavyTestLease(repoRoot, label, options = {}) {
  const dir = join(repoRoot, ".tmp", LOCK_NAME);
  mkdirSync(join(repoRoot, ".tmp"), { recursive: true });
  const inherited = options.inheritedToken ?? process.env.MCODE_HEAVY_TEST_TOKEN;
  if (inherited) {
    const owner = ownerAt(dir);
    if (!owner || owner.token !== inherited || !alive(owner.pid))
      throw new Error("Invalid inherited Mcode heavy-test lease: refusing nested test");
    return { token: inherited, inherited: true, release() {} };
  }

  const token = randomUUID();
  let got = false;
  for (let attempt = 0; attempt < 2 && !got; attempt++) {
    try { mkdirSync(dir); got = true; }
    catch (e) {
      if (e?.code !== "EEXIST") throw e;
      const owner = ownerAt(dir);
      if (attempt === 0 && reclaimDead(dir, owner)) continue;
      const who = owner ? `PID ${owner.pid}, ${owner.label}` : "unknown/initializing owner";
      throw new Error(`Mcode heavy test busy (${who}). Not starting ${label}; retry after the current test exits.`);
    }
  }
  if (!got) throw new Error("Failed to acquire Mcode heavy-test lease");
  const owner = { pid: process.pid, token, label, startedAt: new Date().toISOString() };
  try { writeFileSync(join(dir, "owner.json"), JSON.stringify(owner), { flag: "wx" }); }
  catch (e) { try { rmSync(dir, { recursive: true, force: true }); } catch {} throw e; }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = ownerAt(dir);
    if (!current || current.pid !== process.pid || current.token !== token) return;
    try {
      // A second owner cannot acquire until the current directory disappears.
      rmSync(dir, { recursive: true, force: true });
    } catch { /* dead-owner recovery handles a later retry */ }
  };
  return { token, inherited: false, release };
}

/** For standalone builders: sync exit cleanup even when a build throws. */
export function guardHeavyTestProcess(repoRoot, label) {
  const lease = acquireHeavyTestLease(repoRoot, label);
  if (!lease.inherited) {
    process.once("exit", lease.release);
    // Default signal termination will not execute JS cleanup on all platforms.
    // Exit explicitly; if killed with SIGKILL the next runner reclaims the dead PID.
    process.once("SIGINT", () => { process.exitCode = 130; process.exit(); });
    process.once("SIGTERM", () => { process.exitCode = 143; process.exit(); });
  }
  return lease;
}
