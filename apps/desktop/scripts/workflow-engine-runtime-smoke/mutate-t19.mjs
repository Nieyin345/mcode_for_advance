/**
 * T19 mutation proof without changing the shared working tree:
 * build the real runtime smoke with a temporary mutated runtimeSupervisor alias.
 * Each introduced bug must produce a named failing assertion.
 *
 * Run: node apps/desktop/scripts/workflow-engine-runtime-smoke/mutate-t19.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repo = path.resolve(app, "../..");
const pnpm = path.join(repo, "node_modules", ".pnpm");
const installed = fs.readdirSync(pnpm).filter((name) => /^esbuild@\d/.test(name)).sort().at(-1);
if (!installed) throw new Error("esbuild not installed");
const esbuild = require(path.join(pnpm, installed, "node_modules", "esbuild"));
const entry = path.join(app, "scripts", "workflow-engine-runtime-smoke", "main.ts");
const source = path.join(app, "src", "main", "workflowEngines", "runtimeSupervisor.ts");
const original = fs.readFileSync(source, "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcode-t19-mutate-"));
function smokeWith(sourceAlias, name) {
  const output = path.join(tmp, name + ".mjs");
  esbuild.buildSync({
    entryPoints: [entry], outfile: output, bundle: true,
    format: "esm", platform: "node", logLevel: "silent",
    tsconfig: path.join(app, "tsconfig.json"),
    alias: {
      "@main/workflowEngines/runtimeSupervisor.js": sourceAlias,
      "@main/lib/dataRoot.js": path.join(app, "scripts", "run-store-smoke", "stubs", "dataRoot.ts"),
      "@main/lib/logger.js": path.join(app, "scripts", "run-store-smoke", "stubs", "logger.ts"),
    },
  });
  return spawnSync(process.execPath, [output], {
    encoding: "utf8", timeout: 90_000,
    env: { ...process.env, MCODE_SMOKE_DATA_ROOT: path.join(tmp, name + "-isolated-data") },
  });
}
try {
  const baseline = smokeWith(source, "baseline");
  if (baseline.status !== 0) throw new Error("T19 original runtime smoke not green: " + baseline.stderr + "\n" + baseline.stdout?.slice(-1700));
  console.log("PASS baseline: runtime smoke green");

  for (const spec of [
    { name: "bad-vendor-path",
      before: 'resolve(appPath, "..", "..", "node-red")',
      after: 'resolve(appPath, "..", "..", "node-red-BROKEN")',
      red: 'FAIL ★【T19】开发态 ../../node-red 解析优先 vendor' },
    { name: "missing-version-check",
      before: 'info.name !== "node-red" || info.version !== NODE_RED_VENDOR_VERSION',
      after: 'info.name !== "node-red" || false',
      red: 'FAIL ★【T19】vendor 错误版本必须选择 npm fallback' },
  ]) {
    if (!original.includes(spec.before)) throw new Error("T19 mutation target missing: " + spec.name);
    const mutatedFile = path.join(tmp, spec.name + ".ts");
    fs.writeFileSync(mutatedFile, original.replace(spec.before, spec.after));
    const outcome = smokeWith(mutatedFile, spec.name);
    const stdout = outcome.stdout ?? "";
    if (outcome.status === 0 || !stdout.includes(spec.red)) {
      throw new Error("T19 mutation did NOT turn named assertion red: " + spec.name
        + ", exit=" + outcome.status + "\n" + stdout.slice(-2000) + "\n" + outcome.stderr);
    }
    console.log("PASS mutation rejected: " + spec.name + " => " + spec.red);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
