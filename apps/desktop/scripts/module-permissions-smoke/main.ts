import assert from "node:assert/strict";
import { API_CATALOG } from "../../src/main/appControl/apiCatalog.generated.js";
import { policyFor } from "../../src/main/appControl/policy.js";
import { APP_METHOD_PERMISSIONS, assertAppMethodPermission, MODULE_PERMISSION_NAMES, permissionsForAppMethod } from "@contracts/appPermission";
import { ModuleInstallSchema } from "@contracts/ipc/modules";
import { EXAMPLE_MODULE, ModuleManifestSchema, ResourceSchema, ResultSchema, type ModuleManifest } from "@contracts/modules";
import { ModuleHost } from "../../src/main/modules/ModuleHost.js";
import { ModulePermissionArchiveSchema, defaultModuleGrants } from "@contracts/modulePermissions";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name, error); }
}
const methods = API_CATALOG.map(entry => entry.method);
await check("All current RPC methods have a closed-world permission mapping", () => {
  assert.ok(methods.length >= 438);
  assert.equal(new Set(methods).size, methods.length);
  for (const method of methods) assert.ok(Object.hasOwn(APP_METHOD_PERMISSIONS,method), "Unmapped RPC method: "+method);
  for (const method of methods) {
    const required = permissionsForAppMethod(method);
    if (policyFor(method).level === "blocked" || method === "workflowEngine.load") assert.equal(required, null, method);
    else {
      assert.ok(Array.isArray(required) && required.length > 0, method);
      for (const permission of required ?? []) assert.ok((MODULE_PERMISSION_NAMES as readonly string[]).includes(permission),method);
    }
  }
});
await check("Dangerous workflow load keeps app policy but cannot be delegated to extensions", () => {
  const policy = policyFor("workflowEngine.load");
  assert.equal(policy.level, "danger");
  assert.match(policy.reason ?? "", /停止运行中的引擎并覆盖画布上的未部署草稿/);
  assert.equal(permissionsForAppMethod("workflowEngine.load"), null);
  assert.throws(() => assertAppMethodPermission("workflowEngine.load", [...MODULE_PERMISSION_NAMES]), /不可委托/);
});
await check("Nondelegable approvals and credentials cannot be granted", () => {
  const all = [...MODULE_PERMISSION_NAMES];
  for (const method of ["claude.approve", "customModel.getToken"]) {
    assert.equal(permissionsForAppMethod(method), null);
    assert.throws(() => assertAppMethodPermission(method, all), /不可委托/);
  }
});
await check("A dual-scope document conversion needs BOTH read and edit grants", () => {
  assert.deepEqual(permissionsForAppMethod("document.convert"), ["document.read","document.edit"]);
  assert.throws(() => assertAppMethodPermission("document.convert",["document.read"]),/document.edit/);
  assert.doesNotThrow(() => assertAppMethodPermission("document.convert",["document.read","document.edit"]));
});
const manifest: ModuleManifest = ModuleManifestSchema.parse({
  ...EXAMPLE_MODULE, id:"user.t48-permissions",
  permissions:["files.read","files.write","session.send"],
  contributions:[{...EXAMPLE_MODULE.contributions[0],capability:"core.t48.action"}],
});
await check("Three requested grants are selectable, install contract accepts user-chosen subset", () => {
  assert.deepEqual(defaultModuleGrants(manifest),manifest.permissions);
  const three = ModuleInstallSchema.parse({manifest,confirmReadAccess:true,grantedPermissions:[...manifest.permissions]});
  assert.equal(three.grantedPermissions?.length,3);
  assert.equal(ModuleInstallSchema.safeParse({manifest,confirmReadAccess:true,grantedPermissions:["git.write"]}).success,false);
});
let archive: string | null = null;
let persisted = 0, approvalCalls = 0, executions = 0;
const host = new ModuleHost({
  authorize: async () => {},
  persist: async () => { persisted++; },
  readModulePermissions: () => archive,
  persistModulePermissions: async text => {archive=text;},
  requestApproval: async () => {approvalCalls++; throw Error("Unexpected per-call approval");},
});
host.register({id:"core.t48.action",kind:"action",input:ResourceSchema,output:ResultSchema,
  run:async () => { executions++; return {bytes:1}; }});
const call = (requestId: string) => ({moduleId:manifest.id,contributionId:"inspect",requestId,resource:{projectPath:"C:/test",path:"C:/test/test.txt"}});
await check("Install persists the exact three grants and no fourth", async () => {
  await host.install(manifest,[...manifest.permissions]);
  assert.equal(persisted,1);
  assert.ok(archive);
  const record=ModulePermissionArchiveSchema.parse(JSON.parse(archive!)).modules[manifest.id];
  assert.deepEqual(record?.granted,manifest.permissions);
  assert.equal(host.catalog().modulePermissions?.[manifest.id]?.granted.length,3);
});
await check("Host RPC gate uses the saved install grant, rejects missing and blocked operations", () => {
  assert.doesNotThrow(() => host.authorizeAppMethod(manifest.id,"claude.sendTurn"));
  assert.throws(() => host.authorizeAppMethod(manifest.id,"git.push"),/没有 git.write 权限/);
  for (const method of ["claude.approve","customModel.getToken"]) {
    assert.throws(() => host.authorizeAppMethod(manifest.id,method),/不可委托/);
  }
});
await check("An authorized action executes without a recurring approval card", async () => {
  const reply = await host.invoke(call("allowed-1"));
  assert.equal(reply.type,"result");
  assert.equal(executions,1);
  assert.equal(approvalCalls,0);
});
await check("Live revocation prevents execution and names missing files.write", async () => {
  await host.setPermissions({moduleId:manifest.id,grantedPermissions:["files.read","session.send"]});
  assert.deepEqual(host.catalog().modulePermissions?.[manifest.id]?.granted,["files.read","session.send"]);
  await assert.rejects(host.invoke(call("denied-1")),/没有 files.write 权限/);
  assert.equal(executions,1);
  assert.equal(approvalCalls,0);
});
await check("A changed manifest requires renewed consent (even with unchanged module ID)", async () => {
  const next = {...manifest, version:"1.0.1"};
  const before=persisted;
  await assert.rejects(host.install(next),/逐项确认授权|重新逐项同意授权/);
  assert.equal(persisted,before);
  assert.equal(host.catalog().modules.find(m=>m.id===manifest.id)?.version,manifest.version);
  const upgraded=await host.install(next,["files.read","files.write"]);
  assert.ok(upgraded.catalog.modules.find(m=>m.id===manifest.id)?.version==="1.0.1");
  assert.deepEqual(host.catalog().modulePermissions?.[manifest.id]?.granted,["files.read","files.write"]);
});
await check("Revoking grants immediately refuses while no recurring approval is requested", async () => {
  await host.setPermissions({moduleId:manifest.id,grantedPermissions:[]});
  await assert.rejects(host.invoke(call("denied-2")),/没有 files.read 权限/);
  assert.equal(approvalCalls,0);
});
console.log(`module-permissions-smoke: ${passed} pass, ${failed} fail`);
if (failed) process.exitCode=1;
