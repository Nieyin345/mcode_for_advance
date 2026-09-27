import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WorkflowDocSchema } from "@contracts/workflow";
import { loadNodeTypes } from "../../src/main/orchestration/nodeTypes.js";
import { importWorkflowDoc, validateWorkflowDoc } from "../../src/main/orchestration/workflowValidation.js";

// Cross-task integration sentinel: the shared save/import validator lives outside
// task 05's ownership. Keep this red until task 01/07 lands the narrow guard.
const types = new Map((await loadNodeTypes()).entries.map(entry => [entry.id, entry.manifest]));
const example = WorkflowDocSchema.parse(JSON.parse(await readFile(resolve("../../examples/workflows/module-file-inspect.json"), "utf8")));
let failed = 0;
for (const [name, extras] of [
  ["caller-provided trusted/requestId", { trusted: true, requestId: "forged" }],
  ["NUL path", { path: "x\0y" }],
  ["oversized path", { path: "x".repeat(4097) }],
] as const) {
  const doc = structuredClone(example);
  Object.assign(doc.nodes[1]!.params, extras);
  try {
    const accepted = {
      save: validateWorkflowDoc(doc, { types }).ok,
      import: importWorkflowDoc(JSON.stringify(doc), { types }).ok,
    };
    assert.deepEqual(accepted, { save: false, import: false }, `Save/import gates must reject ${name}`);
    console.log(`PASS strict save/import: ${name}`);
  } catch (error) { failed++; console.error(`FAIL strict save/import: ${name}`, error); }
}
console.log(`Strict save/import sentinel: ${3 - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
