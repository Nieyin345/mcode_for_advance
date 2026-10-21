/** T07 red checks: build-time mutations, never touch the source tree. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const suite = resolve(import.meta.dirname, "build.mjs");
for (const [option, expected] of [
  ["--mutate-bounds", "真实 WebContentsView 位置/尺寸未跟随"],
  ["--mutate-reload", "移动导致页面未保存状态丢失"],
]) {
  const run = spawnSync(process.execPath, [suite, option], {
    encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  });
  const output = (run.stdout ?? "") + (run.stderr ?? "");
  assert.equal(run.status, 1, option + " must turn red, actual exit " + run.status);
  assert.ok(output.includes(expected), option + " wrong failure: " + output.slice(-3500));
  assert.ok(output.includes("FAIL") || output.includes("DOCUMENT VIEW U1 FAILED"),
    option + " must report an actual test failure");
  console.log("PASS T07 mutation-red", option, "=>", expected);
}
