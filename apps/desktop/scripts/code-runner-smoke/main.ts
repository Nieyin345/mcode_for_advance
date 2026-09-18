import * as path from "node:path";
import { runCodeNode } from "@main/orchestration/codeRunner.js";
import { NODE_STDOUT_PROTOCOL_PREFIX } from "@contracts/nodeType";

let total = 0;
let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void { check(name, Object.is(actual, expected), { actual, expected }); }
function controller(): AbortController { return new AbortController(); }

console.log("\nPython · JSON stdin / structured result / progress");
{
  const progress: Array<{ percent?: number; message?: string }> = [];
  const code = [
    "import sys, json",
    "x = json.loads(sys.stdin.readline())",
    `print('${NODE_STDOUT_PROTOCOL_PREFIX}progress ' + json.dumps({'percent': 50, 'message': 'half'}))`,
    `print('${NODE_STDOUT_PROTOCOL_PREFIX}result ' + json.dumps({'summary': 'done', 'outputs': {'value': x['value'] * 2}}))`,
    "print('ordinary stdout')",
  ].join("\n");
  const out = await runCodeNode({ code, language: "python", input: { value: 21 }, timeoutMs: 5000, signal: controller().signal, onProgress: p => progress.push(p) });
  eq("success", out.status, "success");
  eq("result summary", out.summary, "done");
  eq("typed output preserved", out.outputs?.value, 42);
  eq("ordinary stdout preserved", out.outputs?.stdout, "ordinary stdout");
  eq("progress delivered", progress[0]?.percent, 50);
  eq("progress message delivered", progress[0]?.message, "half");
}

console.log("\nNode · non-zero exit / stderr");
{
  const code = "console.error('boom'); process.exit(3);";
  const out = await runCodeNode({ code, language: "node", timeoutMs: 5000, signal: controller().signal });
  eq("non-zero exit is failed", out.status, "failed");
  eq("exit code exposed", out.outputs?.exitCode, 3);
  eq("stderr exposed", out.outputs?.stderr, "boom");
}

console.log("\nNode · timeout / cancellation");
{
  const timed = await runCodeNode({ code: "setInterval(() => {}, 1000);", language: "node", timeoutMs: 300, signal: controller().signal });
  eq("timeout is failed", timed.status, "failed");
  check("timeout says how long", String(timed.error).includes("300"), timed.error);

  const abort = controller();
  const pending = runCodeNode({ code: "setInterval(() => {}, 1000);", language: "node", timeoutMs: 0, signal: abort.signal });
  await new Promise(r => setTimeout(r, 200));
  abort.abort();
  const cancelled = await pending;
  eq("abort is cancelled", cancelled.status, "cancelled");
}

console.log("\nArtifact · relative URI normalization");
{
  const code = [
    "import json, sys",
    `print('${NODE_STDOUT_PROTOCOL_PREFIX}result ' + json.dumps({'summary': 'file ready', 'artifacts': [{'kind': 'file', 'uri': 'outputs/result.json', 'name': 'result.json'}]}))`,
  ].join("\n");
  const cwd = process.cwd();
  const out = await runCodeNode({ code, language: "python", input: {}, timeoutMs: 5000, cwd, signal: controller().signal });
  eq("artifact result success", out.status, "success");
  eq("artifact URI resolved", out.artifacts?.[0]?.uri, path.resolve(cwd, "outputs/result.json"));
  eq("artifact name preserved", out.artifacts?.[0]?.name, "result.json");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${total} checks`);
if (failures > 0) process.exit(1);
