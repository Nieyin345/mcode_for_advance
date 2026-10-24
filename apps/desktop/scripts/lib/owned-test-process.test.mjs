import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOwnedProcess } from "./owned-test-process.mjs";

test("owned command captures status and bounded stdout without Electron", async () => {
  const r = await runOwnedProcess(process.execPath,
    ["-e", 'process.stdout.write("ok"); process.exit(7)'],
    { timeout: 4000, maxBuffer: 4096 });
  assert.equal(r.status, 7);
  assert.equal(r.stdout, "ok");
  assert.equal(r.error, undefined);
});

test("timeout terminates a hung Node child, not an unrelated process", async () => {
  const r = await runOwnedProcess(process.execPath,
    ["-e", "setInterval(() => {}, 500)"], { timeout: 160, maxBuffer: 4096 });
  assert.equal(r.status, null);
  assert.equal(r.error?.code, "ETIMEDOUT");
});

test("large output fails with ENOBUFS and stops owned process", async () => {
  const r = await runOwnedProcess(process.execPath,
    ["-e", 'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 500)'],
    { timeout: 2000, maxBuffer: 1024 });
  assert.equal(r.status, null);
  assert.equal(r.error?.code, "ENOBUFS");
});

test("timeout kills the owned grandchild as well as its Node parent", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows process-tree regression");
  const root = mkdtempSync(join(tmpdir(), "mcode-owned-tree-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "child-pid.txt");
  const source =
    'const {spawn}=require("node:child_process");' +
    'const {writeFileSync}=require("node:fs");' +
    'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});' +
    'writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000);';
  const result = await runOwnedProcess(process.execPath,
    ["-e", source, marker], { timeout: 400, maxBuffer: 4096 });
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.equal(existsSync(marker), true, "fixture child should have started");
  const grandchildPid = Number(readFileSync(marker, "utf8"));
  await new Promise(r => setTimeout(r, 100));
  assert.throws(() => process.kill(grandchildPid, 0), { code: "ESRCH" },
    "test runner must not leave a child process running after timeout");
});
