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
  const newRoot = join(temp, "fresh-managed", "subdir", "data");
  const newlyCreated = await backupWorkflowDocText(newRoot, "new-root", "{ \"hello\": true }", { at: fixed });
  check("valid absent ancestor chain is created one safe component at a time",
    readFileSync(newlyCreated.path, "utf8") === "{ \"hello\": true }");
  check("a newly created root remains a regular directory",
    lstatSync(newRoot).isDirectory() && !lstatSync(newRoot).isSymbolicLink());

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
  // A trusted managed dataRoot path itself may be replaced with a Junction.
  // A recursive mkdir of dataRoot/workflow-migrations follows that link
  // BEFORE the current check of only the terminal migration directory.
  const actualRoot = join(temp, "actual-root");
  mkdirSync(actualRoot);
  const linkedDataRoot = join(temp, "linked-dataroot");
  try {
    symlinkSync(actualRoot, linkedDataRoot, process.platform === "win32" ? "junction" : "dir");
    const sentinel = join(actualRoot, "existing.txt");
    writeFileSync(sentinel, "unchanged");
    let rejected = false;
    try {
      await backupWorkflowDocText(linkedDataRoot, "wf-redirect", "must-not-follow", { at: fixed });
    } catch { rejected = true; }
    check("★ migration rejects a linked dataRoot before creating managed backup directory", rejected);
    check("★ rejected linked dataRoot does not create external backup directory",
      !existsSync(join(actualRoot, WORKFLOW_MIGRATIONS_DIR)));
    check("external original data stays byte-for-byte unchanged",readFileSync(sentinel,"utf8")==="unchanged");
  } catch (err) {
    console.log("SKIP dataRoot junction (OS privilege):", String(err));
    skip++;
  }
  // A linked ANCESTOR is more dangerous than the dataRoot itself: recursive
  // mkdir of a not-yet-existing child under it writes OUTSIDE before lstat
  // sees a normal terminal directory. Keep both root and ancestor checks.
  const ancestorOutside = join(temp, "ancestor-outside");
  const ancestorAlias = join(temp, "ancestor-alias");
  mkdirSync(ancestorOutside);
  try {
    symlinkSync(ancestorOutside, ancestorAlias, process.platform === "win32" ? "junction" : "dir");
    const rootViaAncestor = join(ancestorAlias, "app-data", "nested");
    let ancestorRejected = false;
    try {
      await backupWorkflowDocText(rootViaAncestor, "wf-ancestor", "private-backup", { at: fixed });
    } catch { ancestorRejected = true; }
    check("★ backup rejects ancestor junction before recursively creating a dataRoot", ancestorRejected);
    check("★ rejected ancestor junction never creates an outside app-data directory",
      !existsSync(join(ancestorOutside, "app-data")));
    // Even an already-existing terminal dataRoot is unsafe if a parent is a
    // Junction: checking only its own lstat falsely reports a real folder.
    const existingOutsideRoot = join(ancestorOutside, "existing-data");
    mkdirSync(existingOutsideRoot);
    const outsideSentinel = join(existingOutsideRoot, "original.txt");
    writeFileSync(outsideSentinel, "unchanged");
    let existingRootRejected = false;
    try {
      await backupWorkflowDocText(join(ancestorAlias, "existing-data"), "existing-wf", "deny", { at: fixed });
    } catch { existingRootRejected = true; }
    check("★ backup refuses existing dataRoot reached through ancestor junction", existingRootRejected);
    check("★ existing external data remains unchanged and has no backup directory",
      readFileSync(outsideSentinel, "utf8") === "unchanged" &&
      !existsSync(join(existingOutsideRoot, WORKFLOW_MIGRATIONS_DIR)));
  } catch (err) {
    console.log("SKIP ancestor junction (OS privilege):", String(err));
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
