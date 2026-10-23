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
  app:"setting.read",runs:"workflow.read",monitoring:"workflow.read",tools:"runtime.read",usage:"runtime.read",
  // 【T34】框架提示词段落(T64):list 只回段落清单与当前文本,与 `setting.read` 同档。
  framework:"setting.read"
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
  app:"setting.write",runs:"workflow.write",monitoring:"workflow.write",tools:"runtime.manage",usage:"runtime.manage",
  // 【T34】`framework.save` / `reset` 改的是**注入进每个工作流节点提示词**的引导话术
  // (`orchestration/frameworkPromptStore.ts` → `schedulerPrompt.ts` 的 `frameworkText`)。
  // 它与 `context.save`(改 CLAUDE.md / AGENTS.md,已是 danger)是同一类东西:
  // 改的不是数据,是**agent 的行为指令**。所以按 danger 处理 —— 见 nonDelegableOverrides。
  framework:"setting.write"
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
  // 【T34】`framework.save` / `reset` **应当**也在这里:它们改的是注入进每个工作流节点
  // 提示词的引导话术(`frameworkPromptStore` → `schedulerPrompt.frameworkText`),与
  // `context.save`(改 CLAUDE.md,已是 danger)同一性质 —— 改的不是数据,是 agent 的行为
  // 指令。然而 `policy.ts` 目前仍把它俩判成 `write`,而 `policy.ts` 是 **T33 的独占文件**
  // (E 正在改)。上面那条 `must retain danger policy` 守卫会在档位改对之前**拦住**把它们
  // 放进来,所以这里先留空、不硬塞 —— 等 T33 落地后由它一并加。
  //
  // 在那之前,扩展拿到 `setting.write` 仍可调 `framework.save/reset`。这是**已知的、
  // 有意的缺口**,不是遗漏:见 `tasks/T34-permission-generator-fixes.md` 回写。

  // 【T34】T33 把这两条提到了 `danger` —— 注释里写明理由是「扩展拿到 document.edit
  // 权限后改调 document.toolCall,就绕开逐次审批」。**如果生成器仍把它们映射成
  // `document.edit`,那条绕过路径会原样回来**:扩展装的时候只要 document.edit,
  // 运行期就能调任意文档工具(含改文件的),而 T19 的逐次审批只在 `policyFor` 判
  // danger **且**方法可委托时才生效 —— 不可委托时 `assertAppMethodPermission` 直接拒,
  // 比"每次都问"更严。
  //
  // 这与 T33 的意图一致,不是推翻它:档位是"agent 侧要不要问",委托面是"扩展能不能
  // 够到"。同一件事两条路,两处都要堵。
  "document.toolCall",
  "document.markdownEdit",
]);
for (const method of nonDelegableOverrides) {
  if (!methods.includes(method)) throw Error("Non-delegable override references unknown RPC method " + method);
  // 非 `danger` 的方法进这个集合说明档位判错了 —— fail-closed,不让它悄悄变窄或变宽。
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
