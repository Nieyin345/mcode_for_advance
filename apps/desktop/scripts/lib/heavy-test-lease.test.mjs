import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { acquireHeavyTestLease } from "./heavy-test-lease.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mcode-heavy-lease-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("one process holds the lease, another live owner fails fast without starting a test", (t) => {
  const dir = fixture(t);
  const owner = acquireHeavyTestLease(dir, "test owner", { inheritedToken: "" });
  t.after(owner.release);
  assert.throws(() => acquireHeavyTestLease(dir, "competing test", { inheritedToken: "" }),
    /heavy test busy.*PID/);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import {acquireHeavyTestLease} from ' + JSON.stringify(new URL("./heavy-test-lease.mjs", import.meta.url).href) +
    '; try {acquireHeavyTestLease(process.argv[1], "child"); process.exit(6)} catch(e) {if (!/heavy test busy/.test(String(e))) process.exit(7); process.exit(0)}',
    dir], { timeout: 5000, encoding: "utf8", env: { ...process.env, MCODE_HEAVY_TEST_TOKEN: "" } });
  assert.equal(child.status, 0, child.stderr);
  const saved = JSON.parse(readFileSync(join(dir, ".tmp", "mcode-heavy-test.lock", "owner.json"), "utf8"));
  assert.equal(saved.pid, process.pid);
  assert.equal(saved.token, owner.token);
});

test("nested builder joins only with the actual live parent's token", (t) => {
  const dir = fixture(t);
  const owner = acquireHeavyTestLease(dir, "parent", { inheritedToken: "" });
  t.after(owner.release);
  const nested = acquireHeavyTestLease(dir, "nested", { inheritedToken: owner.token });
  assert.equal(nested.inherited, true);
  nested.release();
  assert.throws(() => acquireHeavyTestLease(dir, "forged", { inheritedToken: "wrong-token" }),
    /Invalid inherited/);
  assert.throws(() => acquireHeavyTestLease(dir, "competitor", { inheritedToken: "" }),
    /heavy test busy/);
});

test("clean exit releases exactly its own lock and can reacquire", (t) => {
  const dir = fixture(t);
  const lease = acquireHeavyTestLease(dir, "once", { inheritedToken: "" });
  lease.release();
  lease.release();
  const after = acquireHeavyTestLease(dir, "after", { inheritedToken: "" });
  after.release();
});

test("dead owner is reclaimed, but missing owner metadata fails closed", (t) => {
  const dir = fixture(t);
  const lock = join(dir, ".tmp", "mcode-heavy-test.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({
    pid: 999999999, token: "dead-token", label: "crashed-runner",
  }));
  const recovered = acquireHeavyTestLease(dir, "recovered", { inheritedToken: "" });
  recovered.release();
  mkdirSync(lock);
  assert.throws(() => acquireHeavyTestLease(dir, "half-created", { inheritedToken: "" }),
    /unknown\/initializing owner/);
});
