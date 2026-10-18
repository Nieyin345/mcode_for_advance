import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CRITICAL_SUITES, discoverSuites, resolveBash, runSuites, selectSuites } from "./run-smokes.mjs";

function fixture(t, scripts) {
  const root = mkdtempSync(join(tmpdir(), "mcode-smoke-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  for (const [name, script] of Object.entries(scripts)) {
    const dir = join(root, "scripts", name);
    mkdirSync(dir);
    if (script !== null) writeFileSync(join(dir, "run.sh"), script);
  }
  const lines = [];
  // Node is intentionally used as the fake Bash executable: fixture run.sh
  // files contain JavaScript, so these tests need no shell or repo dependencies.
  return { root, lines, options: { appDir: root, bash: process.execPath, logger: {
    log: (line) => lines.push(line), error: (line) => lines.push(line),
  } } };
}

test("default critical gate includes persistence and live device revocation", () => {
  assert.deepEqual(selectSuites([], CRITICAL_SUITES), [...CRITICAL_SUITES]);
  for (const name of ["db-migrate-smoke", "db-persistence-smoke", "mobile-pairing-smoke"]) {
    assert.ok(CRITICAL_SUITES.includes(name));
  }
});

test("all suites are selected dynamically and explicit names are deduplicated", () => {
  assert.deepEqual(selectSuites(["--all"], ["a-smoke", "b-smoke"]), ["a-smoke", "b-smoke"]);
  assert.deepEqual(selectSuites(["b-smoke", "b-smoke"], ["a-smoke", "b-smoke"]), ["b-smoke"]);
});

test("unknown, traversal, malformed flags and empty --all fail closed", () => {
  for (const args of [["missing-smoke"], ["../a-smoke"], ["--all", "a-smoke"], ["--typo"]]) {
    assert.throws(() => selectSuites(args, ["a-smoke"]));
  }
  assert.throws(() => selectSuites(["--all"], []), /No smoke suites/);
});

test("discovery includes broken entries so --all cannot silently skip them", async (t) => {
  const f = fixture(t, { "a-smoke": "process.exit(0)", "broken-smoke": null, "not-a-suite": null });
  assert.deepEqual(discoverSuites(f.root), ["a-smoke", "broken-smoke"]);
  await assert.rejects(runSuites(["--all"], f.options), /Missing entry: broken-smoke/);
  assert.equal(f.lines.length, 0, "validate everything before running anything");
});

test("Windows never falls back to an arbitrary PATH/WSL Bash", () => {
  assert.throws(() => resolveBash({}, "win32"), /Git Bash was not found/);
  assert.equal(resolveBash({}, "linux"), "bash");
  assert.throws(() => resolveBash({ MCODE_TEST_BASH: "nonexistent-mcode-test-bash" }), /existing Bash/);
});

test("explicit executable and standard Git Bash locations are supported", (t) => {
  const f = fixture(t, {});
  const gitBin = join(f.root, "Git", "bin");
  mkdirSync(gitBin, { recursive: true });
  const exe = join(gitBin, "bash.exe");
  writeFileSync(exe, "fixture");
  assert.equal(resolveBash({ ProgramFiles: f.root }, "win32"), exe);
  assert.equal(resolveBash({ MCODE_TEST_BASH: process.execPath }, "win32"), process.execPath);
});

test("a failing child propagates a nonzero result while later suites still run", async (t) => {
  const f = fixture(t, {
    "a-fail-smoke": "console.error('intentional fixture failure'); process.exit(7)",
    "b-pass-smoke": "console.log('later fixture ran'); process.exit(0)",
  });
  assert.equal(await runSuites(["--all"], f.options), 1);
  assert.ok(f.lines.some((s) => s.includes("exit=7")));
  assert.ok(f.lines.some((s) => s.includes("PASS  b-pass-smoke")));
  assert.ok(f.lines.some((s) => s.includes("1 pass, 1 fail")));
  const runs = readdirSync(join(f.root, ".tmp", "smoke-runs"));
  const log = readFileSync(join(f.root, ".tmp", "smoke-runs", runs[0], "a-fail-smoke.log"), "utf8");
  assert.match(log, /intentional fixture failure/);
});

test("successful runs return zero and never overwrite prior logs", async (t) => {
  const f = fixture(t, { "a-smoke": "console.log('ok')" });
  assert.equal(await runSuites(["--all"], f.options), 0);
  assert.equal(await runSuites(["--all"], f.options), 0);
  assert.equal(readdirSync(join(f.root, ".tmp", "smoke-runs")).length, 2);
});

test("cleanup only prunes old known smoke build dirs, never other agents or fresh runs", async (t) => {
  const f = fixture(t, { "a-smoke": "process.exit(0)" });
  const tmp = join(f.root, ".tmp");
  mkdirSync(tmp);
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const foreign = [];
  for (let i = 0; i < 9; i++) {
    const path = join(tmp, `other-agent-${String(i).padStart(6, "0")}`);
    mkdirSync(path);
    writeFileSync(join(path, "preserve.txt"), "other AI owns this");
    utimesSync(path, old, old);
    foreign.push(path);
  }
  const oldKnown = [];
  for (let i = 0; i < 9; i++) {
    const path = join(tmp, `a-${String(i).padStart(6, "0")}`);
    mkdirSync(path);
    const older = new Date(old.getTime() - (i + 1) * 60_000);
    utimesSync(path, older, older);
    oldKnown.push(path);
  }
  const knownFresh = join(tmp, "a-bbb222");
  mkdirSync(knownFresh);

  assert.equal(await runSuites(["a-smoke"], f.options), 0);
  assert.ok(oldKnown.some((path) => !existsSync(path)), "stale known smoke builds should be pruned");
  assert.ok(existsSync(knownFresh), "current in-flight build must never be pruned");
  for (const path of foreign) {
    assert.equal(readFileSync(join(path, "preserve.txt"), "utf8"), "other AI owns this",
      `cleanup touched unrelated shared build: ${path}`);
  }
});

test("another running smoke keeps all fresh build directories even beyond retention", async (t) => {
  const f = fixture(t, { "a-smoke": "process.exit(0)" });
  const tmp = join(f.root, ".tmp");
  mkdirSync(tmp);
  for (let i = 0; i < 10; i++) {
    mkdirSync(join(tmp, `a-${String(i).padStart(6, "0")}`));
  }
  assert.equal(await runSuites(["a-smoke"], f.options), 0);
  for (let i = 0; i < 10; i++) {
    assert.ok(existsSync(join(tmp, `a-${String(i).padStart(6, "0")}`)),
      "do not prune another still-running worker's build");
  }
});

test("a spawn error fails instead of reporting a passing suite", async (t) => {
  const f = fixture(t, { "a-smoke": "process.exit(0)" });
  assert.equal(await runSuites(["--all"], { ...f.options, bash: join(f.root, "absent-bash") }), 1);
  assert.ok(f.lines.some((s) => s.includes("ENOENT")));
});

test("a stalled owned child is terminated and fails the gate", { timeout: 15_000 }, async (t) => {
  const f = fixture(t, { "a-smoke": "setInterval(() => {}, 1000)" });
  assert.equal(await runSuites(["--all"], { ...f.options, timeoutMs: 100 }), 1);
  assert.ok(f.lines.some((s) => s.includes("timeout")));
});
