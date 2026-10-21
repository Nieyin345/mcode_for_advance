// T48: deterministic catalogue-derived extension authorization mapping.
// Run: node --experimental-strip-types apps/desktop/scripts/gen-module-permission-map.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = readFileSync(resolve(root, "apps/desktop/src/main/appControl/apiCatalog.generated.ts"), "utf8");
const methods = [...source.matchAll(/"method": "([^"]+)"/g)].map(m => m[1]);
if (methods.length < 400 || new Set(methods).size !== methods.length) throw Error("Missing/duplicated RPC methods in generated catalogue");
const { policyFor } = await import(pathToFileURL(resolve(root, "apps/desktop/src/main/appControl/policy.ts")).href);
const readVerb = /^(list|get|read|status|search|info|stats|overview|catalog|history|runs|sessions|tasks|task|has|show|preview|check|describe|count|health)/i;
const readPerm = {
  file:"files.read",fileSystem:"files.read",workspace:"project.read",session:"session.read",claude:"session.read",
  document:"document.read",documentView:"document.read",library:"library.read",workflow:"workflow.read",automation:"workflow.read",workflowEngine:"workflow.read",
  project:"project.read",git:"git.read",setting:"setting.read",theme:"setting.read",customModel:"setting.read",piModels:"setting.read",codexModels:"setting.read",
  modules:"modules.read",plugins:"modules.read",skills:"skills.read",mcp:"mcp.read",hooks:"hooks.read",terminal:"terminal.read",browser:"browser.read",
  context:"setting.read",outputStyle:"setting.read",memory:"memory.read",runtimes:"runtime.read",toolchain:"runtime.read",lsp:"runtime.read",rg:"runtime.read",
  provider:"runtime.read",engineTools:"setting.read",extensionStore:"modules.read",agentSsh:"terminal.read",shell:"files.read",
  scene:"workflow.read",unattended:"workflow.read",unattendedPlans:"workflow.read",projectInit:"project.read",
  voice:"ui.read",customUi:"ui.read",clipboard:"ui.read",notification:"ui.read",dialog:"ui.read",
  onlyoffice:"document.read",webBridge:"browser.read",publicMcp:"network",mobile:"network",relay:"network",
  app:"setting.read",runs:"workflow.read",monitoring:"workflow.read",tools:"runtime.read",usage:"runtime.read"
};
const writePerm = {
  file:"files.write",fileSystem:"files.write",workspace:"project.write",session:"session.control",claude:"session.send",
  document:"document.edit",documentView:"document.edit",library:"library.write",workflow:"workflow.write",automation:"workflow.run",workflowEngine:"workflow.write",
  project:"project.write",git:"git.write",setting:"setting.write",theme:"setting.write",customModel:"setting.write",piModels:"setting.write",codexModels:"setting.write",
  modules:"modules.install",plugins:"modules.install",skills:"skills.manage",mcp:"mcp.manage",hooks:"hooks.manage",terminal:"terminal.run",browser:"browser.control",
  context:"setting.write",outputStyle:"setting.write",memory:"memory.write",runtimes:"runtime.manage",toolchain:"runtime.manage",lsp:"runtime.manage",rg:"runtime.manage",
  provider:"runtime.manage",engineTools:"setting.write",extensionStore:"modules.write",agentSsh:"terminal.run",shell:"files.write",
  scene:"workflow.write",unattended:"workflow.run",unattendedPlans:"workflow.run",projectInit:"project.write",
  voice:"ui.control",customUi:"ui.control",clipboard:"ui.control",notification:"ui.control",dialog:"ui.control",
  onlyoffice:"document.edit",webBridge:"browser.control",publicMcp:"network",mobile:"network",relay:"network",
  app:"setting.write",runs:"workflow.write",monitoring:"workflow.write",tools:"runtime.manage",usage:"runtime.manage"
};
const overrides = {
  "claude.sendTurn":["session.send"], "claude.interrupt":["session.control"],
  "document.convert":["document.read","document.edit"], "workflow.run":["workflow.run"], "automation.run":["workflow.run"],
  "modules.install":["modules.install"], "modules.remove":["modules.install"],
};
// Extension RPCs bypass invokeAppTool's interactive approval gate once the host has
// authenticated the extension. Keep this method's policyFor level as "danger" for
// ordinary app_api_call, but never delegate it through the grant-only extension path.
const nonDelegableOverrides = new Set([
  "workflowEngine.load", // Stops a running engine and overwrites the native canvas draft.
]);
for (const method of nonDelegableOverrides) {
  if (!methods.includes(method)) throw Error("Non-delegable override references unknown RPC method " + method);
  if (policyFor(method).level !== "danger") throw Error("Non-delegable override must retain danger policy: " + method);
}
const mapped = Object.fromEntries(methods.map(method=>{
  const policy = policyFor(method);
  if (policy.level === "blocked" || nonDelegableOverrides.has(method)) return [method,null];
  if (overrides[method]) return [method,overrides[method]];
  const [domain,verb] = method.split(".",2);
  const isRead = policy.level === "read" || policy.level === "ui";
  const perm = isRead ? readPerm[domain] : writePerm[domain];
  if (!perm) throw Error("No domain grant for " + method);
  return [method,[perm]];
}));
const permissions = [...new Set(Object.values(mapped).flatMap(p=>p??[]))].sort();
// The three existing module runtime scopes are retained for old manifests and capability metadata.
const allPermissions = [...new Set(["resource.read","resource.write","network","code.execute","files.watch",...permissions])].sort();
const content = `// Generated by apps/desktop/scripts/gen-module-permission-map.mjs. Do not edit directly.\n// null is a structurally non-delegable method, NEVER grantable.\nexport const MODULE_PERMISSION_NAMES = ${JSON.stringify(allPermissions, null, 2)} as const;\nexport type ModulePermission = (typeof MODULE_PERMISSION_NAMES)[number];\nexport const APP_METHOD_PERMISSIONS: Readonly<Record<string, readonly ModulePermission[] | null>> = ${JSON.stringify(mapped,null,2)};\nexport function permissionsForAppMethod(method: string): readonly ModulePermission[] | null | undefined {\n  return Object.hasOwn(APP_METHOD_PERMISSIONS, method) ? APP_METHOD_PERMISSIONS[method] : undefined;\n}\nexport const MODULE_HIGH_RISK_PERMISSIONS: ReadonlySet<ModulePermission> = new Set(["code.execute", "terminal.run", "network", "modules.install"]);\n/** Common fail-closed authorization gate for every RPC method. */\nexport function assertAppMethodPermission(method: string, granted: readonly ModulePermission[]): void {\n  const required = permissionsForAppMethod(method);\n  if (required === null) throw Error(\`方法 \${method} 不可委托给扩展\`);\n  if (required === undefined) throw Error(\`未知方法 \${method}，没有可授权的权限映射\`);\n  for (const permission of required) {\n    if (!granted.includes(permission)) throw Error(\`这个扩展没有 \${permission} 权限（调用 \${method} 被拒绝）\`);\n  }\n}\n`;
writeFileSync(resolve(root, "packages/contracts/src/appPermission.ts"), content);
console.log(methods.length, "RPC methods", permissions.length, "used permissions", allPermissions.length, "total permissions",Object.values(mapped).filter(v=>v===null).length,"blocked");
