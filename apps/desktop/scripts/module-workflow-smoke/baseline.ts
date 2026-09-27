import assert from "node:assert/strict";
import { ExecutionEngine, executionEngine } from "../../src/main/orchestration/executionEngine.js";
import { builtinManifestById } from "../../src/main/orchestration/nodeTypes.js";
import { NodeTypeManifestSchema } from "@contracts/nodeType";
import type { ExecutionContext } from "../../src/main/orchestration/executionContext.js";

// A test-only manifest permits testing dispatch before the production node exists.
const manifest = NodeTypeManifestSchema.parse({
  id: "mcode.module-capability", manifestVersion: 1, name: "Module fixture",
  description: "Baseline fixture, not a production registration", runner: { kind: "module-capability" },
  capability: "read", params: [], outputs: [],
});
const context: ExecutionContext = {
  node: { id: "n_file", type: manifest.id, title: "File", params: {}, position: { x: 0, y: 0 } },
  manifest, cwd: process.cwd(), metadata: { sessionId: "test", runId: "test-run", nodeId: "n_file" },
  input: { prompt: "", data: { userInput: "", upstreamText: "", upstreamOutputs: {}, upstreamArtifacts: [] },
    skills: [], mcpServerNames: [], pluginNames: [], returnMode: "none", signal: new AbortController().signal,
    moduleCall: { moduleId: "core.file-report", contributionId: "info", path: "file.txt", requestId: "baseline-only" } },
};
let failures = 0;
async function check(name: string, run: () => void | Promise<void>): Promise<void> {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}
await check("production engine registers module-capability", () => {
  assert.equal(executionEngine.has("module-capability"), true);
});
await check("missing module executor fails without model fallback", async () => {
  let modelCalls = 0;
  const engine = new ExecutionEngine().setDefault({ execute: async () => {
    modelCalls++; return { status: "success", summary: "a model must never run here" };
  } });
  const result = await engine.execute(context);
  assert.equal(result.status, "failed");
  assert.equal(modelCalls, 0);
});
await check("builtin catalog contains the real module node", () => {
  assert.ok(builtinManifestById("mcode.module-capability"));
});
console.log(`Baseline: ${3 - failures} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
