import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { formatOfficeCoverage, validateOfficeCoverage } from "../lib/office-coverage.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let total = 0;
function check(label, run) {
  try { run(); total++; console.log("PASS", label); }
  catch (e) { console.error("FAIL", label, e); process.exitCode = 1; }
}
const paths = {
  o0: "scripts/o0-format-fidelity-smoke/run.mjs",
  o1: "scripts/o1-three-provider-ai-smoke/run.sh",
  o3: "scripts/o3-packaged-u1/main.mjs",
};
for (const key of Object.keys(paths)) {
  check(`${key} exactly three mandatory coverage lines`, () => {
    assert.match(formatOfficeCoverage(key), /^TIER: (smoke|u1|deep)\nCOVERAGE: .+\nNOT-COVERED: .+\n$/);
  });
  check(`${key} entry point emits approved boundary`, () => {
    const source = readFileSync(join(desktop, paths[key]), "utf8");
    if (key === "o1") assert.match(source, /node scripts\/lib\/office-coverage\.mjs o1/);
    else assert.match(source, new RegExp('printOfficeCoverage\\("'+key+'"\\)'));
  });
}
for (const [key, what] of [
  ["o0", ["scripts/o0-format-fidelity-smoke/run.mjs"]],
  ["o3", ["scripts/o3-packaged-u1/main.mjs"]],
]) {
  check(`${key} runner stdout, no heavy Electron`, () => {
    const result = spawnSync(process.execPath, [...what, "--coverage-only"], {
      cwd: desktop, encoding: "utf8", timeout: 18000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, formatOfficeCoverage(key));
  });
}
const original = formatOfficeCoverage("o1");
for (const [label, mutate] of [
  ["remove NOT-COVERED", (t) => t.replace(/^NOT-COVERED:.*\n/m, "")],
  ["rename NOT-COVERED into free prose", (t) => t.replace(/^NOT-COVERED:/m, "注意：")],
  ["remove TIER", (t) => t.replace(/^TIER:.*\n/m, "")],
]) {
  check(`mutation rejects ${label}`, () => assert.throws(() => validateOfficeCoverage(mutate(original)),
    /exactly TIER, COVERAGE, NOT-COVERED/));
}
console.log(`o7-coverage-smoke: ${total}/${total} passed`);
if (process.exitCode) process.exit(1);
