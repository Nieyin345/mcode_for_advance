/** Real converters + SDK adapter + loopback HTTP. No model, Electron or DB. */
import { createServer } from "node:http";
import { anthropicToOpenAI } from "@main/providers/bridge/requestTranslator.js";
import { OpenAiToAnthropicSse } from "@main/providers/bridge/responseTranslator.js";
import { startBridge } from "@main/providers/bridge/bridgeServer.js";
import { SdkMessageAdapter } from "@main/providers/claude-sdk/SdkMessageAdapter.js";
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import type { AnthropicRequest, AnthropicSseEvent, OpenAIChoiceDelta } from "@main/providers/bridge/types.js";
import type { RuntimeEvent } from "@contracts/runtime";
let total = 0, failures = 0;
function eq(name: string, actual: unknown, expected: unknown): void {
  total++;
  if (JSON.stringify(actual) === JSON.stringify(expected)) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}: ${JSON.stringify({ actual, expected })}`); }
}
const request: AnthropicRequest = {
  model: "deepseek-v4.1-flash", max_tokens: 32768, stream: true,
  thinking: { type: "adaptive" }, output_config: { effort: "max" },
  tools: [{ name: "lookup", description: "test", input_schema: { type: "object" } }],
  messages: [
    { role: "assistant", content: [{ type: "thinking", thinking: "prior", signature: "" }, { type: "text", text: "answer" }] },
    { role: "user", content: "next" },
    { role: "assistant", content: [{ type: "thinking", thinking: "plan", signature: "" }, { type: "tool_use", id: "t", name: "lookup", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "found" }] },
  ],
};
const wire = anthropicToOpenAI(request);
eq("Max reaches DeepSeek unchanged", wire.reasoning_effort, "max");
eq("adaptive thinking enables DeepSeek", wire.thinking, { type: "enabled" });
eq("explicit token cap is never increased", wire.max_tokens, 32768);
eq("configured model is not renamed", wire.model, request.model);
eq("previous no-tool assistant reasoning is preserved when tools are enabled", wire.messages[0].reasoning_content, "prior");
eq("tool reasoning remains separate from normal content", wire.messages[2].reasoning_content, "plan");
eq("no reasoning leaks into assistant prose", wire.messages[0].content, "answer");
eq("tool arguments survive", wire.messages[2].tool_calls?.[0].function.arguments, "{}");
eq("tool result survives", wire.messages[3].tool_call_id, "t");
const other = anthropicToOpenAI({ ...request, model: "other-model" });
eq("other providers do not receive DeepSeek thinking extension", other.thinking, undefined);
eq("other providers do not receive DeepSeek reasoning history extension", other.messages[0].reasoning_content, undefined);
eq("other providers retain explicit requested effort without downgrade", other.reasoning_effort, "max");
const disabled = anthropicToOpenAI({ ...request, thinking: { type: "disabled" } });
eq("disabled thinking wins over stored Max", disabled.thinking, { type: "disabled" });
eq("disabled thinking does not send conflicting Max effort", disabled.reasoning_effort, "none");
eq("no-tools requests do not unnecessarily replay reasoning", anthropicToOpenAI({ ...request, tools: undefined }).messages[0].reasoning_content, undefined);
for (const [input, output] of [["low", "low"], ["medium", "high"], ["high", "high"], ["xhigh", "high"], ["max", "max"]]) {
  eq(`documented DeepSeek effort mapping ${input}`, anthropicToOpenAI({ ...request, output_config: { effort: input } }).reasoning_effort, output);
}
function chunk(delta: OpenAIChoiceDelta, finish_reason: string | null = null) { return { choices: [{ index: 0, delta, finish_reason }] }; }
function collect(deltas: OpenAIChoiceDelta[], reason = "stop"): AnthropicSseEvent[] {
  const t = new OpenAiToAnthropicSse();
  return [...deltas.flatMap(d => t.feed(chunk(d))), ...t.feed(chunk({}, reason)), ...t.finish()];
}
function texts(events: AnthropicSseEvent[], type: "thinking_delta" | "text_delta"): string {
  return events.flatMap(e => e.type === "content_block_delta" && e.delta.type === type ? [type === "thinking_delta" ? (e.delta as { thinking: string }).thinking : (e.delta as { text: string }).text] : []).join("");
}
for (const [name, delta] of [
  ["canonical", { reasoning_content: "thought" }],
  ["alias", { reasoning: "thought" }],
  ["empty alias must not hide canonical field", { reasoning: "", reasoning_content: "thought" }],
  ["canonical takes precedence without duplication", { reasoning: "duplicate", reasoning_content: "thought" }],
  ["typed gateway details", { reasoning_details: [{ type: "reasoning.text", text: "thought" }] }],
] as const) {
  const ev = collect([{ ...delta } as OpenAIChoiceDelta, { content: "answer" }]);
  eq(`${name} is thinking`, texts(ev, "thinking_delta"), "thought");
  eq(`${name} never becomes prose`, texts(ev, "text_delta"), "answer");
}
const tagged = collect([{ content: "<th" }, { content: "ink>thought</thi" }, { content: "nk>answer" }]);
eq("split inline tags route to thinking", texts(tagged, "thinking_delta"), "thought");
eq("split inline tags preserve answer", texts(tagged, "text_delta"), "answer");
eq("untagged text is not guessed to be reasoning", texts(collect([{ content: "Let me think carefully" }]), "text_delta"), "Let me think carefully");
eq("encrypted details are never shown as prose or invented reasoning", texts(collect([{ reasoning_details: [{ type: "reasoning.encrypted", text: "cipher" }] }]), "thinking_delta"), "");
async function adapterCase(events: AnthropicSseEvent[], sdkStop?: string): Promise<RuntimeEvent[]> {
  const emitted: RuntimeEvent[] = [];
  const adapter = new SdkMessageAdapter({ emit: e => emitted.push(e), log: { info() {}, warn() {}, error() {} } }, "test", false, process.cwd(), new FileSnapshot());
  for (const event of events) await adapter.dispatch({ type: "stream_event", event, parent_tool_use_id: null } as never);
  await adapter.dispatch({ type: "result", subtype: "success", stop_reason: sdkStop, usage: { input_tokens: 1, output_tokens: 2 }, modelUsage: {}, permission_denials: [] } as never);
  await adapter.flushFinal();
  return emitted;
}
const routed = await adapterCase(collect([{ reasoning_content: "thought" }, { content: "answer" }]));
eq("actual SDK adapter emits separate thinking runtime events", routed.filter(e => e.type === "thinking").map(e => e.text).join(""), "thought");
eq("actual SDK adapter emits only answer as text", routed.filter(e => e.type === "text.delta").map(e => e.text).join(""), "answer");
for (const sdkStop of [undefined, "end_turn"]) {
  const out = await adapterCase(collect([{ reasoning_content: "partial" }], "length"), sdkStop);
  eq(`token cap reaches existing UI warning even if SDK stop is ${sdkStop}`, out.find(e => e.type === "turn.done")?.reason, "max_tokens");
}
const reset = await adapterCase([...collect([{ content: "partial" }], "length"), ...collect([{ content: "complete" }])]);
eq("next API call clears prior token-limit flag", reset.find(e => e.type === "turn.done")?.reason, "end_turn");

// A real HTTP client and bridge; upstream is a local fixture, never a model.
let scenario = "normal";
let received: unknown;
const upstream = createServer(async (req, res) => {
  let body = ""; for await (const part of req) body += part; received = JSON.parse(body);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
  if (scenario === "malformed") { res.end("data: {broken}\n\n"); return; }
  if (scenario === "error") { send({ error: { message: "synthetic private error" } }); res.end(); return; }
  if (scenario === "primitive") { res.end("data: null\n\n"); return; }
  send(scenario === "null-error" ? { ...chunk({ reasoning_content: "thought" }), error: null } : chunk({ reasoning_content: "thought" }));
  if (scenario === "cut") { res.end(); return; }
  if (scenario === "done-only") { res.end("data: [DONE]\n\n"); return; }
  if (scenario === "timeout") return;
  if (scenario !== "only-thinking" && scenario !== "length") send(chunk({ content: "answer" }));
  const reason = scenario === "length" ? "length" : scenario === "unknown" ? "mystery" : scenario === "missing-tools" ? "tool_calls" : "stop";
  if (scenario === "tail") { res.end(`data: ${JSON.stringify(chunk({}, reason))}`); return; }
  send(chunk({}, reason));
  send({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 5 } });
  res.end("data: [DONE]\n\n");
});
await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
const addr = upstream.address() as { port: number };
const bridge = await startBridge({ baseUrl: `http://127.0.0.1:${addr.port}`, authToken: "fixture-not-secret", authMode: "api_key", timeoutMs: 700 });
try {
  for (const name of ["normal", "null-error", "tail", "length", "cut", "done-only", "unknown", "only-thinking", "missing-tools", "error", "malformed", "primitive", "timeout"]) {
    scenario = name;
    const response = await fetch(`${bridge.localUrl}/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    const failed = !["normal", "null-error", "tail", "length"].includes(name);
    eq(`${name}: only valid streams complete`, text.includes("event: message_stop"), !failed);
    eq(`${name}: broken streams emit SDK-readable SSE errors`, text.includes("event: error"), failed);
    if (name === "length") eq("HTTP bridge preserves max_tokens stop reason", text.includes('"stop_reason":"max_tokens"'), true);
    if (name === "normal") eq("real HTTP request carries Max", (received as { reasoning_effort?: string }).reasoning_effort, "max");
  }
} finally {
  bridge.close(); upstream.closeAllConnections();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
}
console.log(`openai-reasoning: ${total - failures}/${total} passed`);
process.exitCode = failures ? 1 : 0;
