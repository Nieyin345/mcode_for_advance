/**
 * T20 mutation: temporarily inject allow-same-origin into the already-audited
 * custom HTML iframe and require the SAME smoke suite to fail at its sandbox
 * assertion. Restore original bytes in finally (never touches user data).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const path = resolve("apps/desktop/src/renderer/components/customUi/PanelFrame.tsx");
const original = readFileSync(path, "utf8");
const before = '      sandbox="allow-scripts allow-forms allow-modals"';
const after = '      sandbox="allow-scripts allow-forms allow-modals allow-same-origin"';
if (original.split(before).length !== 2) throw new Error("expected exactly one sandbox declaration");
const mutated = original.replace(before, after);
try {
  writeFileSync(path, mutated, "utf8");
  if (readFileSync(path, "utf8") !== mutated) throw new Error("mutation not applied");
  const result = spawnSync(process.execPath, [
    "apps/desktop/scripts/run-smokes.mjs",
    "t20-sandbox-mic-smoke",
  ], { encoding: "utf8", cwd: process.cwd(), timeout: 120_000 });
  const output = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
  if (result.status === 0 || !output.includes("customUi PanelFrame iframe")) {
    throw new Error("mutation failed to make the intended sandbox assertion RED:\n" + output.slice(-3000));
  }
  console.log("PASS: allow-same-origin mutation caused intended PanelFrame assertion to fail");
} finally {
  if (readFileSync(path, "utf8") !== mutated) {
    throw new Error("source changed concurrently; refusing to overwrite non-mutated version");
  }
  writeFileSync(path, original, "utf8");
  if (readFileSync(path, "utf8") !== original) {
    throw new Error("failed to restore PanelFrame original bytes");
  }
}
