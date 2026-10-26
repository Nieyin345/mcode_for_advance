/**
 * T155/T29 lease-aware entry for real Electron close-guard U1.
 *
 * Acquire the shared lease before launching the suite and pass its token through
 * to electron-u1/build.mjs. This avoids the race where another U1 starts between
 * checking the lock and the runner's build phase.
 *
 * Usage:
 *   node apps/desktop/scripts/t29-document-view-close-u1/run-slides-close-u1.mjs
 *   node apps/desktop/scripts/t29-document-view-close-u1/run-slides-close-u1.mjs --only=t29-close-slides-after-unsaved-guard
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { acquireHeavyTestLease } from "../lib/heavy-test-lease.mjs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repoRoot = desktop; // electron-u1/build.mjs keys the shared lease under apps/desktop/.tmp
const args = process.argv.slice(2);

let lease;
for (let attempt = 1; attempt <= 45; attempt++) {
  try {
    lease = acquireHeavyTestLease(repoRoot, "t155-slides-close-u1");
    break;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.includes("Mcode heavy test busy") || attempt === 45) throw error;
    console.log(`T155 U1: shared Electron lease busy; retry ${attempt}/45 in 2s`);
    await delay(2_000);
  }
}
if (!lease) throw Error("T155 U1: failed to acquire shared Electron lease");
process.once("exit", lease.release);

try {
  const result = spawnSync(process.execPath, [
    join(suite, "run.mjs"),
    ...args,
  ], {
    cwd: desktop,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, MCODE_HEAVY_TEST_TOKEN: lease.token },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  lease.release();
}
