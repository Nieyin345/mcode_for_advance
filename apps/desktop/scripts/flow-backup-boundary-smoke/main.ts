/**
 * ARC-006 Gate C - isolate every write beneath a disposable data root.
 * Real OS junction / symlink injection is attempted only in random temp trees.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupWorkflowDocBytes, backupWorkflowDocText, WORKFLOW_MIGRATIONS_DIR } from "../../src/main/workflowEngines/flowMigrationBackup.js";

let pass = 0;
let fail = 0;
let skip = 0;
function check(name: string, good: boolean, detail: unknown = ""): void {
  console.log(`${good ? "PASS" : "FAIL"} ${name}${good ? "" : " :: " + String(detail)}`);
  if (good) pass++; else fail++;
}
const temp = mkdtempSync(join(tmpdir(), "mcode-flow-backup-boundary-"));
try {
  const goodRoot = join(temp, "normal-root");
  mkdirSync(goodRoot);
  const src = Uint8Array.from([0x7b, 0x0a, 0xff, 0x7d]);
  const fixed = new Date("2026-10-19T01:02:03.004Z");
  const one = await backupWorkflowDocBytes(goodRoot, "test/workflow", src, { at: fixed });
  check("regular backup preserves exact original bytes", Buffer.compare(readFileSync(one.path), Buffer.from(src)) === 0);
  check("regular backup reports correct digest", one.sha256 === createHash("sha256").update(src).digest("hex"));
  const two = await backupWorkflowDocBytes(goodRoot, "test/workflow", Uint8Array.from([0x01]), { at: fixed });
  check("same-millisecond backups are unique", one.path !== two.path && existsSync(one.path) && existsSync(two.path));
  check("regular backup directory remains a real directory", lstatSync(join(goodRoot, WORKFLOW_MIGRATIONS_DIR)).isDirectory());

  const root = join(temp, "linked-root");
  const outside = join(temp, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  const link = join(root, WORKFLOW_MIGRATIONS_DIR);
  let linking = true;
  let reason = "";
  try {
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    linking = false;
    reason = String((err as NodeJS.ErrnoException).code ?? err);
    console.log(`SKIP real junction/symlink could not be created: ${reason}`);
    skip++;
  }
  if (linking) {
    check("fixture link is really a junction/symlink", lstatSync(link).isSymbolicLink());
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "unaltered");
    let rejected = false;
    try {
      await backupWorkflowDocText(root, "wf-escape", "should-not-be-written", { at: fixed });
    } catch { rejected = true; }
    check("backup rejects linked migration directory", rejected);
    check("linked destination receives no new backup", readdirSync(outside).length === 1);
    check("pre-existing outside file remains unchanged", readFileSync(sentinel, "utf8") === "unaltered");
    check("refusal never destroys pre-existing junction", lstatSync(link).isSymbolicLink());
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(`flow-backup-boundary-smoke: ${pass}/${pass + fail} PASS; ${skip} SKIP`);
if (fail) process.exitCode = 1;
