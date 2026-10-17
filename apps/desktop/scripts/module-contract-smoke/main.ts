import assert from "node:assert/strict";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import {
  JsonSchemaDocumentSchema, ModuleCapabilityMetadataSchema, ModuleCapabilityDescriptorSchema,
  ModuleWorkflowTargetSchema, ModuleCatalogSchema, ModuleWorkflowCallSchema,
  ModuleWorkflowExecutionInputSchema, MODULE_SCHEMA_MAX_BYTES, MODULE_WORKFLOW_GRANT_FILE_VERSION,
  ModuleWorkflowGrantSchema, classifyModuleWorkflowGrants, serializeModuleWorkflowGrants,
  moduleWorkflowGrantKey, applyModuleWorkflowGrantChange,
} from "@contracts/moduleCapability";
import { EXAMPLE_MODULE, ModuleManifestSchema, ModuleInvokeSchema, ResourceSchema, missingCapabilityPermission, actionInvocationDenied } from "@contracts/modules";
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
for (const change of [{ schemaVersion: 2 }, { version: "latest" }, { permissions: [] }, { permissions: ["resource.read", "resource.read"] }, { limits: { maxFileBytes: -1 } }, { limits: { command: "x" } }, { supportsCancellation: "yes" }, { trusted: true }]) check("metadata rejects " + JSON.stringify(change), () => assert.equal(ModuleCapabilityMetadataSchema.safeParse({ ...metadata, ...change }).success, false));
// 【MC-060】`resource.write` 现在是**合法**权限(写能力由清单显式请求,执行仍经宿主授权)。
check("metadata accepts declared resource.write", () => assert.equal(ModuleCapabilityMetadataSchema.safeParse({ ...metadata, permissions: ["resource.read", "resource.write"] }).success, true));
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
// 【MC-036】旧契约"永不接受 user 目标"翻面:宿主现在是**唯一**决定发布哪些用户目标的一方
// (只有持有有效工作流授权的用户模块才会进 workflowTargets)。契约层只查引用一致性 ——
// 形状合法的 user 目标必须能通过,否则宿主发布的合法目录会被自己的 schema 拒掉。
check("catalog accepts a shape-valid user target; host authorization decides publication", () => {
  const userCatalog = { ...catalog, modules: [EXAMPLE_MODULE], workflowTargets: [{ ...target, moduleId: EXAMPLE_MODULE.id }] };
  assert.equal(ModuleCatalogSchema.safeParse(userCatalog).success, true);
  assert.equal(ModuleCatalogSchema.safeParse({ ...catalog, workflowTargets: [{ ...target, moduleId: "attacker.file-report" }] }).success, false, "unknown prefix still rejected");
});
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
// 【MC-060】执行点放行判定 actionInvocationDenied 是**纯函数**,与准入判定 missingCapabilityPermission
// 分开:准入问"能不能挂",这里问"这一次执行放不放行"。非 action 一律放行;action 要 resource.write
// 作用域**且**有审批通道,否则给中文拒绝原因(fail-closed)。
check("execution gate: non-action kinds never need approval", () => {
  assert.equal(actionInvocationDenied("query", ["resource.read"], false), undefined);
  assert.equal(actionInvocationDenied("task", ["resource.read"], false), undefined);
});
check("execution gate: action without resource.write scope is denied", () => {
  assert.match(actionInvocationDenied("action", ["resource.read"], true) ?? "", /resource\.write/);
});
check("execution gate: action without an approval channel is denied (fail-closed)", () => {
  assert.match(actionInvocationDenied("action", ["resource.read", "resource.write"], false) ?? "", /审批通道/);
});
check("execution gate: only scoped action with an approval channel passes this layer", () => {
  assert.equal(actionInvocationDenied("action", ["resource.read", "resource.write"], true), undefined);
});
check("admission gate (missingCapabilityPermission) is a separate decision from the execution gate", () => {
  // 准入放行(有 resource.read)不等于执行放行(action 仍要 resource.write) —— 两层不合并。
  assert.equal(missingCapabilityPermission("action", ["resource.read"]), "resource.write");
  assert.equal(missingCapabilityPermission("query", ["resource.read"]), undefined);
});
check("other runner parameter behavior is not tightened", () => {
  const legacy: NodeTypeManifest = { ...manifest, id: "legacy.prompt", runner: { kind: "prompt" }, params: [{ key: "prompt", kind: "text", label: "Prompt", required: true }] };
  assert.equal(validateNodeParams(legacy, { prompt: "hello", script: "legacy extra data" }).ok, true);
  assert.equal(validateNodeParams(legacy, {}).ok, false);
  assert.equal(NodeRunnerSchema.safeParse({ kind: "unknown-runner" }).success, false);
});
// ── 【MC-036】用户模块的工作流运行授权:模型 / 三态分类器 / 唯一写入口 ──
const userGrant = { moduleId: EXAMPLE_MODULE.id, moduleVersion: "1.0.0", contributionId: "inspect", capabilityId: "core.file.inspect", projectPath: "C:/project" };
const userTarget = { moduleId: EXAMPLE_MODULE.id, contributionId: "inspect", capabilityId: "core.file.inspect" };
const userCatalog = { modules: [EXAMPLE_MODULE], capabilities: [{ id: "core.file.inspect", kind: "task", metadata }], workflowTargets: [userTarget] };
check("grant record binds module/version/contribution/capability/workspace and nothing else", () => {
  assert.deepEqual(ModuleWorkflowGrantSchema.parse({ ...userGrant, grantedAt: 1 }), { ...userGrant, grantedAt: 1 });
  assert.equal(ModuleWorkflowGrantSchema.safeParse({ ...userGrant, grantedAt: 1, trusted: true }).success, false);
  assert.equal(ModuleWorkflowGrantSchema.safeParse({ ...userGrant, grantedAt: 1, moduleId: "core.file-report" }).success, false, "grants cover user.* only");
  assert.equal(ModuleWorkflowGrantSchema.safeParse({ ...userGrant, grantedAt: -1 }).success, false);
  assert.equal(ModuleWorkflowGrantSchema.safeParse({ ...userGrant }).success, false, "grantedAt is required");
});
check("grant archive: absent/valid/corrupt are distinct and a bad record poisons the whole table", () => {
  assert.deepEqual(classifyModuleWorkflowGrants(null), { state: "absent" });
  assert.deepEqual(classifyModuleWorkflowGrants("   "), { state: "absent" });
  assert.equal(classifyModuleWorkflowGrants("{").state, "corrupt");
  assert.equal(classifyModuleWorkflowGrants("[]").state, "corrupt", "a bare array is not the envelope");
  assert.equal(classifyModuleWorkflowGrants(JSON.stringify({ version: MODULE_WORKFLOW_GRANT_FILE_VERSION + 1, grants: [] })).state, "corrupt");
  assert.equal(classifyModuleWorkflowGrants(JSON.stringify({ version: MODULE_WORKFLOW_GRANT_FILE_VERSION, grants: "x" })).state, "corrupt");
  const oneBad = classifyModuleWorkflowGrants(JSON.stringify({ version: MODULE_WORKFLOW_GRANT_FILE_VERSION, grants: [{ ...userGrant, grantedAt: 1 }, { ...userGrant }] }));
  assert.equal(oneBad.state, "corrupt", "one malformed record must not be silently dropped");
  const good = classifyModuleWorkflowGrants(serializeModuleWorkflowGrants([{ ...userGrant, grantedAt: 5 }]));
  assert.equal(good.state, "valid");
  if (good.state === "valid") assert.deepEqual(good.grants, [{ ...userGrant, grantedAt: 5 }]);
});
check("issue is idempotent on the full identity and revoke removes exactly that record", () => {
  const first = applyModuleWorkflowGrantChange(null, { kind: "issue", grant: userGrant, grantedAt: 1 });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = applyModuleWorkflowGrantChange(first.text, { kind: "issue", grant: userGrant, grantedAt: 2 });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const parsed = classifyModuleWorkflowGrants(second.text);
  assert.equal(parsed.state, "valid");
  if (parsed.state === "valid") {
    assert.equal(parsed.grants.length, 1, "re-issuing the same identity must not accumulate rows");
    assert.equal(parsed.grants[0]?.grantedAt, 2, "re-issuing refreshes grantedAt");
  }
  // 换工作区 = 另一条授权(旧授权不会被覆盖掉)。
  const otherWorkspace = applyModuleWorkflowGrantChange(second.text, { kind: "issue", grant: { ...userGrant, projectPath: "C:/other" }, grantedAt: 3 });
  assert.equal(otherWorkspace.ok, true);
  if (otherWorkspace.ok) {
    const both = classifyModuleWorkflowGrants(otherWorkspace.text);
    assert.equal(both.state === "valid" ? both.grants.length : -1, 2);
  }
  const revoked = applyModuleWorkflowGrantChange(second.text, { kind: "revoke", grant: userGrant });
  assert.equal(revoked.ok, true);
  if (revoked.ok) {
    const after = classifyModuleWorkflowGrants(revoked.text);
    assert.equal(after.state === "valid" ? after.grants.length : -1, 0);
    assert.equal(revoked.changed, true);
  }
  // 撤销一条本来就没有的授权:幂等成功、内容不变。
  const noop = applyModuleWorkflowGrantChange(first.text, { kind: "revoke", grant: { ...userGrant, contributionId: "missing" } });
  assert.equal(noop.ok, true);
  if (noop.ok) assert.equal(noop.changed, false);
  // 幂等键对版本/能力/工作区都敏感。
  const key = moduleWorkflowGrantKey(userGrant);
  for (const change of [{ moduleVersion: "1.0.1" }, { capabilityId: "core.file.info" }, { projectPath: "C:/other" }]) {
    assert.notEqual(moduleWorkflowGrantKey({ ...userGrant, ...change }), key, JSON.stringify(change));
  }
});
check("a corrupt archive is never rewritten from an empty base", () => {
  const changed = applyModuleWorkflowGrantChange("{broken", { kind: "issue", grant: userGrant, grantedAt: 1 });
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.match(changed.error, /损坏/);
  const revoked = applyModuleWorkflowGrantChange("{broken", { kind: "revoke", grant: userGrant });
  assert.equal(revoked.ok, false);
});
check("catalog shape accepts host-granted user targets but still rejects action and unknown prefixes", () => {
  assert.equal(ModuleCatalogSchema.safeParse(userCatalog).success, true);
  assert.equal(ModuleCatalogSchema.safeParse({ ...userCatalog, modules: [{ ...EXAMPLE_MODULE, id: "other.file-report" }] }).success, false, "unknown module prefix");
  assert.equal(ModuleCatalogSchema.safeParse({ ...userCatalog, capabilities: [{ id: "core.file.inspect", kind: "action", metadata }] }).success, false, "actions never become targets");
  assert.equal(ModuleCatalogSchema.safeParse({ ...userCatalog, workflowTargets: [{ ...userTarget, capabilityId: "core.file.info" }], capabilities: [{ id: "core.file.inspect", kind: "task", metadata }, { id: "core.file.info", kind: "query", metadata }] }).success, false, "target must match the contribution's capability");
});
console.log(`${count} module contract checks passed, ${failed} failed`);
if (failed) process.exitCode = 1;
