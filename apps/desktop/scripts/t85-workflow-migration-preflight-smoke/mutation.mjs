import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } = fs;
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const moduleDir = join(appDir, "src/main/workflowEngines");
const sourcePath = join(moduleDir, "workflowMigrationPreflight.ts");
const flowPath = join(moduleDir, "flowMigration.ts");
const selectionPath = join(moduleDir, "workflowEngineSelection.ts");
const entry = "scripts/t85-workflow-migration-preflight-smoke/main.ts";
const esbuildArgument = process.argv[2];
if (!esbuildArgument) throw new Error("Pass the resolved esbuild executable path from run.sh.");
const esbuildCommand = esbuildArgument === "npx esbuild" ? "npx" : process.execPath;
const esbuildPrefix = esbuildArgument === "npx esbuild" ? ["--no-install", "esbuild"] : [esbuildArgument];
const originalBytes = readFileSync(sourcePath);
const originalText = originalBytes.toString("utf8");
const originalHash = createHash("sha256").update(originalBytes).digest("hex");
const tempRoot = mkdtempSync(join(tmpdir(), "mcode-t85-mutations-"));

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function copyModules(dir, mutatedText) {
  copyFileSync(flowPath, join(dir, "flowMigration.ts"));
  copyFileSync(selectionPath, join(dir, "workflowEngineSelection.ts"));
  writeFileSync(join(dir, "workflowMigrationPreflight.ts"), mutatedText, "utf8");
}
function expectMutationToFail({ name, mutatedText, expectedFailure }) {
  const dir = join(tempRoot, name);
  const modulesDir = join(dir, "workflowEngines");
  const bundle = join(dir, "smoke.mjs");
  mkdirSync(modulesDir, { recursive: true });
  copyModules(modulesDir, mutatedText);
  const aliasPath = join(modulesDir, "workflowMigrationPreflight.ts").replace(/\\/g, "/");
  const bundlePath = bundle.replace(/\\/g, "/");
  const build = spawnSync(esbuildCommand, [
    ...esbuildPrefix,
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--tsconfig=tsconfig.json",
    "--alias:@main/workflowEngines/workflowMigrationPreflight.js=" + aliasPath,
    "--outfile=" + bundlePath,
    "--log-level=error",
  ], { cwd: appDir, encoding: "utf8", windowsHide: true });
  if (build.error || build.status !== 0) {
    throw new Error(name + " mutant failed to build: " + (build.error?.message ?? build.stderr ?? build.stdout));
  }
  const run = spawnSync(process.execPath, [bundle], { cwd: appDir, encoding: "utf8", windowsHide: true });
  const output = (run.stdout ?? "") + "\n" + (run.stderr ?? "");
  if (run.status === 0) throw new Error(name + " mutant unexpectedly passed the full smoke.");
  if (!output.includes("FAIL " + expectedFailure)) {
    throw new Error(name + " mutant failed for an unrelated reason; target assertion did not fail.");
  }
  console.log("  ok   mutation red: " + name + " causes its dedicated guard assertion to fail");
}

try {
  const unknownGuard = /    if \(migration\.report\.unmapped\.length > 0\) \{\r?\n      addReason\(row, rejectReason\(\r?\n        "unmapped-mcode-node-type",[\s\S]*?\r?\n      \)\);\r?\n    \}\r?\n/;
  const withoutUnknownGuard = originalText.replace(unknownGuard, "");
  if (withoutUnknownGuard === originalText) throw new Error("Could not locate the Mcode unknown-node guard for mutation.");
  expectMutationToFail({
    name: "unknown-node-guard-removed",
    mutatedText: withoutUnknownGuard,
    expectedFailure: "F-B unknown Mcode node type is REJECT and never SAFE",
  });

  const withoutTriggerGate = originalText.replace(/^\s*addWorkflowTriggerGate\(row\);\s*$/gm, "");
  if (withoutTriggerGate === originalText) throw new Error("Could not locate trigger semantic gates for mutation.");
  expectMutationToFail({
    name: "trigger-semantics-gate-removed",
    mutatedText: withoutTriggerGate,
    expectedFailure: "A top-level legacy trigger is HUMAN even when known fields round-trip",
  });

  const afterHash = hashFile(sourcePath);
  if (afterHash !== originalHash) throw new Error("Production source hash changed during isolated mutation tests.");
  console.log("  ok   mutation cleanup: production source hash unchanged (" + originalHash + ")");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
