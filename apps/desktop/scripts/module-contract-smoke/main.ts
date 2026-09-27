import assert from "node:assert/strict";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import {
  JsonSchemaDocumentSchema, ModuleCapabilityMetadataSchema, ModuleCapabilityDescriptorSchema,
  ModuleWorkflowTargetSchema, ModuleCatalogSchema, ModuleWorkflowCallSchema,
  ModuleWorkflowExecutionInputSchema, MODULE_SCHEMA_MAX_BYTES,
} from "@contracts/moduleCapability";
import { EXAMPLE_MODULE, ModuleManifestSchema, ModuleInvokeSchema, ResourceSchema } from "@contracts/modules";
import { NodeRunnerSchema, isRunnerImplemented, isNodeRunnable, renderNodeTypeCatalog, showsNodeCapability, validateNodeParams, type NodeTypeManifest } from "@contracts/nodeType";

let count = 0;
let failed = 0;
function check(name: string, fn: () => void) { try { fn(); count++; console.log("PASS " + name); } catch (error) { failed++; console.error("FAIL " + name, error); } }
const text = { zh: "文件信息", en: "File information" };
const schema = { type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"], additionalProperties: false };
const metadata = { schemaVersion: 1, version: "1.0.0", title: text, description: text, permissions: ["resource.read"], inputSchema: schema, outputSchema: { type: "object" }, supportsCancellation: false };
const call = { moduleId: "core.file-report", contributionId: "inspect", path: "readme.md" };
const builtin = { ...EXAMPLE_MODULE, id: "core.file-report" };
const target = { moduleId: builtin.id, contributionId: "inspect", capabilityId: "core.file.inspect" };
const catalog = { modules: [builtin], capabilities: [{ id: "core.file.inspect", kind: "task", metadata }], workflowTargets: [target] };
function rejects(value: unknown) { assert.equal(JsonSchemaDocumentSchema.safeParse(value).success, false); }

check("recognizes new strict runner shape", () => assert.equal(NodeRunnerSchema.safeParse({ kind: "module-capability" }).success, true));
for (const field of ["trusted", "projectPath", "entry", "capabilityId"]) check("runner rejects " + field, () => assert.equal(NodeRunnerSchema.safeParse({ kind: "module-capability", [field]: "x" }).success, false));
check("old runner shapes retain compatibility", () => { for (const kind of ["prompt", "conversation", "branch", "condition", "trigger", "command", "code"]) assert.equal(NodeRunnerSchema.safeParse({ kind }).success, true); });
check("verified production integration activates the module runner", () => assert.equal(isRunnerImplemented("module-capability"), true));
const manifest: NodeTypeManifest = { id: "mcode.module-capability", manifestVersion: 1, name: "Module capability", runner: { kind: "module-capability" }, capability: "read", params: [] };
check("module node is runnable but never a model permission", () => { assert.equal(isNodeRunnable(manifest), true); assert.equal(showsNodeCapability(manifest), false); });
check("catalog rendering no longer marks the wired module runner unimplemented", () => assert.doesNotMatch(renderNodeTypeCatalog([{ id: manifest.id, source: "builtin", from: "mcode", manifest }]), /尚未实现/));
check("v1 user manifest unchanged", () => assert.deepEqual(ModuleManifestSchema.parse(EXAMPLE_MODULE), EXAMPLE_MODULE));
check("v1 manifest does not acquire automation/trusted flags", () => assert.equal(ModuleManifestSchema.safeParse({ ...EXAMPLE_MODULE, workflowTargets: [target] }).success, false));
check("v1 invoke envelope unchanged", () => assert.equal(ModuleInvokeSchema.safeParse({ moduleId: call.moduleId, contributionId: call.contributionId, resource: { projectPath: "C:/project", path: "C:/project/a.txt" }, requestId: "same-attempt" }).success, true));
check("workflow parameters round trip", () => assert.deepEqual(ModuleWorkflowCallSchema.parse(call), call));
check("path expressions are data, not evaluated", () => assert.equal(ModuleWorkflowCallSchema.parse({ ...call, path: "{{upstream.file}}" }).path, "{{upstream.file}}"));
for (const field of ["projectPath", "trusted", "capabilityId", "requestId", "source", "script"]) check("user call rejects " + field, () => assert.equal(ModuleWorkflowCallSchema.safeParse({ ...call, [field]: "x" }).success, false));
check("workflow path rejects blank, NUL and overlong", () => { for (const path of [" ", "a\0b", "a".repeat(4097)]) assert.equal(ModuleWorkflowCallSchema.safeParse({ ...call, path }).success, false); });
check("bad IDs and missing fields fail", () => { assert.equal(ModuleWorkflowCallSchema.safeParse({ ...call, moduleId: "CORE" }).success, false); assert.equal(ModuleWorkflowCallSchema.safeParse({ moduleId: call.moduleId, path: "x" }).success, false); });
check("parameter parsing is not an authorization grant", () => assert.equal(ModuleWorkflowCallSchema.safeParse({ ...call, moduleId: "user.file-report" }).success, true));
check("host execution input requires request identity", () => { assert.equal(ModuleWorkflowExecutionInputSchema.safeParse(call).success, false); assert.equal(ModuleWorkflowExecutionInputSchema.safeParse({ ...call, requestId: "wf:" + "a".repeat(64) }).success, true); });
check("host request identity is bounded", () => { for (const requestId of ["", " ", "a\0b", "x".repeat(101)]) assert.equal(ModuleWorkflowExecutionInputSchema.safeParse({ ...call, requestId }).success, false); });
check("host input still rejects forged workspace and trust", () => assert.equal(ModuleWorkflowExecutionInputSchema.safeParse({ ...call, requestId: "id", trusted: true }).success, false));
check("plain schema supported", () => assert.deepEqual(JSON.parse(JSON.stringify(JsonSchemaDocumentSchema.parse(schema))), schema));
check("actual installed zod generator supported", () => {
  const generated = zodToJsonSchema(ResourceSchema, "Resource");
  assert.equal(JsonSchemaDocumentSchema.safeParse(generated).success, true);
  assert.equal(JsonSchemaDocumentSchema.safeParse(zodToJsonSchema(z.object({ value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict())).success, true);
});
check("local definitions and escaped pointers supported", () => assert.equal(JsonSchemaDocumentSchema.safeParse({ $defs: { "a/b": { type: "string" } }, $ref: "#/$defs/a~1b" }).success, true));
check("finite local self reference is descriptive data", () => assert.equal(JsonSchemaDocumentSchema.safeParse({ type: "object", properties: { next: { $ref: "#" } } }).success, true));
for (const ref of ["https://example.invalid/x", "file:///private", "other.json#/x", "//example.invalid/x", "#missing", "#/missing", "#/%70roperties/x", "#/bad~2escape"]) check("rejects unsupported ref " + ref, () => rejects({ $ref: ref }));
check("reference must resolve to a schema", () => rejects({ title: "not a schema", $ref: "#/title" }));
check("boolean schema nodes cannot authorize a literal boolean ref target", () => rejects({ $defs: { flag: true }, default: true, $ref: "#/default" }));
check("reference cannot target literal example data", () => rejects({ default: { type: "string" }, $ref: "#/default" }));
for (const value of [{ script: "x" }, { type: "shell" }, { properties: { path: { execute: "x" } } }, { $id: "https://example.invalid/" }, { $dynamicRef: "#" }, { type: ["string", "oops"] }, { required: [5] }, { minLength: -1 }, { maxLength: 1.5 }, { minimum: Infinity }, { items: "string" }]) check("rejects invalid schema " + JSON.stringify(value), () => rejects(value));
check("metadata description and defaults are non-executable data", () => assert.equal(JsonSchemaDocumentSchema.safeParse({ type: "string", description: "script is only text", default: "<script>not executed</script>" }).success, true));
check("rejects invalid $schema version", () => rejects({ $schema: "https://example.invalid/schema" }));
check("rejects cyclic data", () => { const a: Record<string, unknown> = {}; a.properties = { a }; rejects(a); });
check("rejects excessive structural depth", () => { let deep: unknown = { type: "string" }; for (let i = 0; i < 10; i++) deep = { type: "object", properties: { child: deep } }; rejects(deep); });
check("rejects oversized string", () => rejects({ description: "x".repeat(MODULE_SCHEMA_MAX_BYTES + 1) }));
check("UTF-8 budget counts non-ASCII bytes", () => rejects({ description: "界".repeat(12000) }));
check("rejects excessive keys", () => rejects({ properties: Object.fromEntries(Array.from({ length: 129 }, (_, i) => ["p" + i, { type: "string" }])) }));
check("rejects excessive array length", () => rejects({ enum: Array.from({ length: 129 }, (_, i) => i) }));
check("rejects aggregate node budget", () => rejects({ enum: Array.from({ length: 100 }, () => Array.from({ length: 30 }, () => 0)) }));
check("rejects sparse arrays", () => rejects({ enum: new Array(2) }));
check("rejects non-JSON values", () => { for (const value of [undefined, () => 1, BigInt(1), NaN, Symbol("x")]) rejects({ default: value }); });
check("rejects classes and dates", () => { rejects(new Date()); rejects({ default: new (class Value { x = 1; })() }); });
check("rejects accessors without invoking schema property getter", () => { let reads = 0; const obj = Object.defineProperty({}, "properties", { enumerable: true, get() { reads++; return {}; } }); rejects(obj); assert.equal(reads, 0); });
check("rejects symbol and nonenumerable fields", () => { rejects({ [Symbol("x")]: 1 }); rejects(Object.defineProperty({}, "type", { value: "object" })); });
for (const key of ["__proto__", "constructor", "prototype"]) check("rejects pollution key " + key, () => rejects(JSON.parse('{"properties":{"' + key + '":{"type":"string"}}}')));
check("parse result cannot mutate input", () => { const input = structuredClone(schema); const parsed = JsonSchemaDocumentSchema.parse(input); (parsed.properties as Record<string, unknown>).other = true; assert.equal(Object.hasOwn(input.properties, "other"), false); });
check("metadata supports truthful file limits", () => assert.equal(ModuleCapabilityMetadataSchema.safeParse({ ...metadata, limits: { maxFileBytes: 33554432, taskTimeoutMs: 30000 } }).success, true));
for (const change of [{ schemaVersion: 2 }, { version: "latest" }, { permissions: ["resource.write"] }, { permissions: ["resource.read", "resource.read"] }, { limits: { maxFileBytes: -1 } }, { limits: { command: "x" } }, { supportsCancellation: "yes" }, { trusted: true }]) check("metadata rejects " + JSON.stringify(change), () => assert.equal(ModuleCapabilityMetadataSchema.safeParse({ ...metadata, ...change }).success, false));
check("legacy descriptor remains valid without invented defaults", () => { const legacy = { id: "core.file.inspect", kind: "task" }; assert.deepEqual(ModuleCapabilityDescriptorSchema.parse(legacy), legacy); });
check("descriptor identity cannot be overridden by metadata", () => assert.equal(ModuleCapabilityDescriptorSchema.safeParse({ id: "core.file.inspect", kind: "task", metadata: { ...metadata, id: "other.id" } }).success, false));
check("workflow target has only three public fields", () => { assert.deepEqual(ModuleWorkflowTargetSchema.parse(target), target); assert.equal(ModuleWorkflowTargetSchema.safeParse({ ...target, trusted: true }).success, false); });
check("old catalog parses without workflowTargets synthesis", () => { const legacy = { modules: [builtin], capabilities: [{ id: "core.file.inspect", kind: "task" }] }; assert.deepEqual(ModuleCatalogSchema.parse(legacy), legacy); });
check("enriched catalog round trips", () => assert.deepEqual(JSON.parse(JSON.stringify(ModuleCatalogSchema.parse(catalog))), catalog));
check("catalog rejects duplicate descriptor IDs", () => assert.equal(ModuleCatalogSchema.safeParse({ ...catalog, capabilities: [...catalog.capabilities, ...catalog.capabilities] }).success, false));
check("catalog rejects duplicate module IDs", () => assert.equal(ModuleCatalogSchema.safeParse({ ...catalog, modules: [builtin, builtin] }).success, false));
check("catalog rejects duplicate workflow targets", () => assert.equal(ModuleCatalogSchema.safeParse({ ...catalog, workflowTargets: [target, target] }).success, false));
check("catalog rejects target without matching module contribution", () => assert.equal(ModuleCatalogSchema.safeParse({ ...catalog, workflowTargets: [{ ...target, contributionId: "missing" }] }).success, false));
check("catalog rejects mismatched capability target", () => assert.equal(ModuleCatalogSchema.safeParse({ ...catalog, workflowTargets: [{ ...target, capabilityId: "core.file.info" }] }).success, false));
check("catalog never advertises action as workflow target", () => assert.equal(ModuleCatalogSchema.safeParse({ ...catalog, capabilities: [{ id: "core.file.inspect", kind: "action" }] }).success, false));
check("catalog never advertises user module as workflow target", () => assert.equal(ModuleCatalogSchema.safeParse({ ...catalog, modules: [EXAMPLE_MODULE], workflowTargets: [{ ...target, moduleId: EXAMPLE_MODULE.id }] }).success, false));
// Shared save/import validation must reuse the frozen schema even for an old
// manifest with no param specs. Execution-time validation is not a substitute.
check("shared module validator accepts the frozen three fields", () => assert.deepEqual(validateNodeParams(manifest, call), { ok: true }));
check("shared validator preserves a deferred path template", () => assert.equal(validateNodeParams(manifest, { ...call, path: "{{upstream.file}}" }).ok, true));
for (const key of ["trusted", "requestId", "projectPath", "source", "capabilityId", "script"]) check("shared module validator rejects extra " + key, () => {
  const params = { ...call, [key]: "forged" };
  const before = structuredClone(params);
  assert.equal(validateNodeParams(manifest, params).ok, false);
  assert.deepEqual(params, before, "validation must reject, not silently strip the field");
});
for (const path of ["", " ", "a\0b", "x".repeat(4097)]) check("shared module validator rejects invalid path length=" + path.length, () => assert.equal(validateNodeParams(manifest, { ...call, path }).ok, false));
check("shared validator rejects invalid identities and missing fields", () => {
  for (const params of [{ ...call, moduleId: "CORE" }, { ...call, contributionId: "" }, { moduleId: call.moduleId }]) assert.equal(validateNodeParams(manifest, params).ok, false);
});
check("shared validation is not user module authorization", () => assert.equal(validateNodeParams(manifest, { ...call, moduleId: "user.file-report" }).ok, true));
check("other runner parameter behavior is not tightened", () => {
  const legacy: NodeTypeManifest = { ...manifest, id: "legacy.prompt", runner: { kind: "prompt" }, params: [{ key: "prompt", kind: "text", label: "Prompt", required: true }] };
  assert.equal(validateNodeParams(legacy, { prompt: "hello", script: "legacy extra data" }).ok, true);
  assert.equal(validateNodeParams(legacy, {}).ok, false);
  assert.equal(NodeRunnerSchema.safeParse({ kind: "unknown-runner" }).success, false);
});
console.log(`${count} module contract checks passed, ${failed} failed`);
if (failed) process.exitCode = 1;
