/**
 * T155 mutation: restore the old Slides close bypass, prove the dirty-close U1
 * catches the data-loss path, then restore documentViewHost.ts byte-for-byte.
 *
 * The shared heavy-test lease is honored by run.mjs. A busy lease/build failure
 * is not counted as catching the defect.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { acquireHeavyTestLease } from "../lib/heavy-test-lease.mjs";

const suite = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(suite, "../..");
const repoRoot = desktop; // same lease root as electron-u1/build.mjs
const source = join(desktop, "src/main/document/documentViewHost.ts");
const original = readFileSync(source);
const text = original.toString("utf8");

const needle = "    if (live.workflowEngineId !== null) return this.close(docId);";
const replacement = "    if (live.editor === 'slides' || live.workflowEngineId !== null) return this.close(docId);";
const count = text.split(needle).length - 1;
if (count !== 1) throw Error(`T155 mutation: 变异点不唯一（出现 ${count} 次）`);
const mutated = Buffer.from(text.replace(needle, replacement), "utf8");
if (mutated.equals(original)) throw Error("T155 mutation: 替换没有改变文件");

// Acquire before touching source so no other Electron U1 can compile/run against the mutation.
let lease;
for (let attempt = 1; attempt <= 45; attempt++) {
  try {
    lease = acquireHeavyTestLease(repoRoot, "t155-slides-close-mutation");
    break;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!message.includes("Mcode heavy test busy") || attempt === 45) throw error;
    console.log(`T155 mutation: shared Electron lease busy; retry ${attempt}/45 in 2s`);
    await delay(2_000);
  }
}
if (!lease) throw Error("T155 mutation: failed to acquire shared Electron lease");
process.once("exit", lease.release);

function runJourney(name) {
  const r = spawnSync(process.execPath, [
    join(suite, "run.mjs"), `--only=${name}`,
  ], {
    cwd: desktop,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, MCODE_HEAVY_TEST_TOKEN: lease.token },
  });
  return { exit: r.status ?? 1, signal: r.signal ?? null, log: (r.stdout ?? "") + (r.stderr ?? "") };
}

let caught = false;
try {
  writeFileSync(source, mutated);
  if (!readFileSync(source).equals(mutated)) throw Error("T155 mutation: 变异没有落盘");
  const trial = runJourney("t29-close-slides-after-unsaved-guard");
  caught = trial.exit === 2 &&
    trial.log.includes("failedStep=dirty-close-refused") &&
    trial.log.includes("UNEXPECTED FAILURE") &&
    !trial.log.includes("Mcode heavy test busy") &&
    !trial.log.includes("BUILD CRASHED");
  console.log(`T155 MUTATION detected=${caught} suiteExit=${trial.exit} signal=${trial.signal}`);
  if (!caught) console.error(trial.log.slice(-6000));
} finally {
  try {
    if (!readFileSync(source).equals(mutated)) {
      throw Error("T155 mutation: 变异期间有别的写者改了源码，拒绝覆盖");
    }
    writeFileSync(source, original);
    if (!readFileSync(source).equals(original)) throw Error("T155 mutation: 还原后字节不一致");
    console.log("T155 MUTATION source restored byte-identical (Buffer.equals)");
  } finally {
    lease.release();
  }
}
if (!caught) process.exitCode = 1;
