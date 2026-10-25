/**
 * Opt-in, slow real-Electron Windows performance U1 (not an every-commit smoke).
 * Reuse all of T7's real vendor build/main hooks, isolated fixture/data roots
 * and the U1 runner. Report crashes separately from assertion failures.
 */
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runElectronU1, classifyU1Run, reportIncompleteAndExit } from "../lib/electron-u1-verdict.mjs";

const here=dirname(fileURLToPath(import.meta.url));
const t7=resolve(here,"../t7-genoffice-u1");
const desktop=resolve(here,"../..");
const passthrough=process.argv.slice(2);
for (const arg of passthrough) {
  if (!["--only=sheets-shared-worker-idle-restart", "--only=six-editor-residency", "--only=sheets-nonvisual-edit-save-reopen"].includes(arg)) {
    throw new Error("Unsupported option: "+arg);
  }
}
const run=runElectronU1({
  suite:t7,
  passthrough,
  desktop,
  registry:join(here,"journeys/index.ts"),
  esbuild:join(t7,"vendor-esbuild.mjs"),
  prebuild:join(t7,"prebuild.mjs"),
  timeoutMs:10*60_000,
});
const verdict=classifyU1Run(run);
if(verdict.kind!=="completed") reportIncompleteAndExit("OFFICE-PERF-U1","real Electron idle worker",verdict);
console.log("OFFICE-PERF-U1:",verdict.status===0?"PASS":"FAIL");
process.exitCode=verdict.status;
