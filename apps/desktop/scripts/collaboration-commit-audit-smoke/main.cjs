"use strict";
/** Read-only shared dirty-tree and claim ownership regression (isolated Git). */
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { canonical, parsePorcelainV1Z, gitStatus, readClaims, analyze } =
  require("../../build/collaboration-commit-audit.cjs");

let total = 0;
function check(label, run) { run(); total++; console.log("ok " + label); }
function git(dir, ...args) {
  const p = spawnSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true });
  if (p.error || p.status !== 0) throw new Error("git " + args.join(" ") + ": " + (p.stderr || p.error));
  return p.stdout;
}

check("porcelain parser supports NUL, Unicode, embedded newlines and untracked spaces", () => {
  const parsed = parsePorcelainV1Z(" M n\néw.ts\0?? other file 🐟.tsx\0");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].path, "n\néw.ts");
  assert.equal(parsed[1].path, "other file 🐟.tsx");
  assert.equal(parsed[1].untracked, true);
});
check("renamed NUL record consumes source and destination, not two files", () => {
  const parsed = parsePorcelainV1Z("R  new-file.js\0old-file.js\0 M another.js\0");
  assert.deepEqual(parsed.map(({ path, oldPath }) => [path, oldPath]),
    [["new-file.js", "old-file.js"], ["another.js", null]]);
});
check("truncated or malformed Git status fails closed", () => {
  assert.throws(() => parsePorcelainV1Z(" M edited.js"), /Truncated/i);
  assert.throws(() => parsePorcelainV1Z("R  edited.js\0"), /rename|Truncated/i);
  assert.throws(() => parsePorcelainV1Z("NO edited.js\0"), /status/i);
});
check("claims reject parent, absolute, malformed and duplicate paths", () => {
  for (const x of ["../other", "C:/Windows/temp", "/tmp/f", "a//b", "a/./b"]) {
    assert.throws(() => canonical(x), /path/i);
  }
  assert.equal(canonical("A\\Spaced Name.TS"), "a/spaced name.ts");
});
check("owners cannot auto-claim someone else's staged changes", () => {
  const claims = new Map([
    ["ui.ts", { owner: "remote-owner-a", task: "T-A" }],
    ["backend.ts", { owner: "remote-owner-b", task: "T-B" }],
  ]);
  const files = parsePorcelainV1Z("M  ui.ts\0M  backend.ts\0?? new.ts\0");
  const r = analyze(files, claims, "remote-owner-a");
  assert.deepEqual(r.ownedDirty, ["ui.ts"]);
  assert.deepEqual(r.unsafeStaged, ["backend.ts"]);
  assert.equal(r.unclaimedChanges, 1);
  assert.equal(r.trackedChanges, 2);
  assert.equal(r.untrackedFiles, 1);
});
check("rename requires matching destination AND source claim before claiming safety", () => {
  const input = parsePorcelainV1Z("R  ui-new.ts\0ui-old.ts\0");
  const owner = { owner: "remote-owner-a", task: "T-A" };
  assert.deepEqual(analyze(input, new Map([["ui-new.ts", owner]]), "remote-owner-a").unsafeStaged, ["ui-new.ts"]);
  assert.deepEqual(analyze(input, new Map([["ui-new.ts", owner], ["ui-old.ts", owner]]), "remote-owner-a").unsafeStaged, []);
});
const dir = mkdtempSync(join(tmpdir(), "mcode-git-dirty-"));
try {
  git(dir, "init", "-q");
  writeFileSync(join(dir, "tracked a.txt"), "initial\n");
  writeFileSync(join(dir, "staged.txt"), "old\n");
  git(dir, "add", "tracked a.txt", "staged.txt");
  git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  writeFileSync(join(dir, "tracked a.txt"), "updated\n");
  writeFileSync(join(dir, "staged.txt"), "updated\n");
  git(dir, "add", "staged.txt");
  writeFileSync(join(dir, "new 你好.txt"), "untracked\n");
  check("actual isolated Git worktree detects staged, tracked and UTF-8 untracked paths", () => {
    const list = gitStatus(dir);
    const summary = analyze(list, new Map());
    assert.equal(summary.worktreeEntries, 3);
    assert.equal(summary.trackedChanges, 2);
    assert.equal(summary.untrackedFiles, 1);
    assert.equal(summary.stagedChanges, 1);
    assert.equal(summary.unclaimedChanges, 3);
    assert.ok(list.some((x) => x.path === "new 你好.txt"));
  });
  check("corrupt claim files cannot silently assign a foreign owner", () => {
    const claims = join(dir, "claims");
    mkdirSync(claims);
    writeFileSync(join(claims, "bad.json"), '{"owner":"remote-owner-a"}');
    assert.throws(() => readClaims(claims), /Malformed/i);
  });
  check("valid claim snapshot resolves from a private fixture claims directory", () => {
    const claims = join(dir, "claims");
    rmSync(join(claims, "bad.json"));
    writeFileSync(join(claims, "ok.json"), JSON.stringify({
      schema: "mcode.collaboration.claim/v1", owner: "remote-owner-a",
      task: "TASK-TEST-1", file: "staged.txt",
    }));
    const summary = analyze(gitStatus(dir), readClaims(claims), "remote-owner-a");
    assert.deepEqual(summary.unsafeStaged, []);
    assert.deepEqual(summary.ownedDirty, ["staged.txt"]);
    // This isolated fixture does not .gitignore its own claims directory,
    // so its claims/ok.json is itself an extra untracked file.
    assert.equal(summary.unclaimedChanges, 3);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("collaboration-commit-audit-smoke: " + total + "/" + total + " PASS");
