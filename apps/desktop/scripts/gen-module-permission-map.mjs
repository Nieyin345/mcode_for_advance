// T48: deterministic catalogue-derived extension authorization mapping.
// Run: node --experimental-strip-types apps/desktop/scripts/gen-module-permission-map.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  // 有意的缺口**,不是遗漏。

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
/** 【T45】**新方法必须被显式分档** —— 兜底只对已经分类过的老方法有效。
 *
 * ## 为什么是「新方法」而不是「所有兜底方法」
 *
 * `policy.ts` 的文件头写明判据:**兜底是 write 而不是 read —— 新加的 RPC 没人来归类时,
 * 宁可多问一次**。所以「靠动词兜底」对**已经存在的** 200 多条方法**是设计,不是缺陷**
 * (实测:严格按「必须在四张显式表里」的判据,204 条会全部报错 —— 那不是漂移,那是重写 policy)。
 *
 * 真正的洞在这里:**兜底"宁可多问一次"只对 agent 侧成立**。扩展侧不同 ——
 * 一条方法兜底判成 `write`,`writePerm[domain]` 就发一张域写权限;判成 `read`,
 * 就发一张域读权限。**扩展拿到的是委托面,不是"多问一次"**。所以新方法一旦靠兜底,
 * 它的权限就是 `writePerm`/`readPerm` 那两张表**顺手给的**,没有人对"该不该给扩展"做过决定。
 *
 * ## 判据:什么叫「新」
 *
 * 拿**已提交的** `appPermission.ts` 当上一次快照:目录里有、快照里没有的方法 = 新方法。
 * 这正好兜住卡面描述的那 10 条(`document.apps` … `framework.reset` 当时就是这样进来的),
 * 又不会把 204 条老方法全部判红。
 *
 * ## 新方法要满足什么才放行
 *
 * 必须能把它的**档位来源**说清楚,三选一:
 *   1. 在 `policy.ts` 的四张显式表里(BLOCKED / CREDENTIAL_BEARING / DANGER / EXPLICIT);
 *   2. 在生成器自己的 `overrides` / `nonDelegableOverrides` 里(逐条写了理由);
 *   3. 在下面的 `NEW_METHOD_REVIEWED` 里 —— **明确接受兜底档位**,并写明为什么可以接受。
 *
 * 三条都不满足 = 没人做过决定 → **生成器拒绝继续**,把方法名和兜底档位打出来。
 * `NEW_METHOD_REVIEWED` 是给「确实该走兜底」的新方法留的出口,但它要求**逐条签字**,
 * 而不是像从前那样静默通过。
 */
const REVIEWED_FALLBACKS = new Map([
  // 【格式】"域.方法": "为什么这个方法的兜底档位对扩展委托面是安全的"
]);

const policySource = readFileSync(resolve(root, "apps/desktop/src/main/appControl/policy.ts"), "utf8");

/** 从 `const NAME: Record<string, ...> = { ... }` 或 `new Map([...])` 里取字符串键。
 *  只认顶格两空格的 `"a.b":` / `["a.b",` 形态 —— 注释里的示例不会被当成真键。 */
function keysOfTable(name) {
  const start = policySource.indexOf(`const ${name}`);
  if (start < 0) throw Error(`policy.ts 里找不到 ${name} —— T45 守卫的表名过时了，先更新它`);
  const nextConst = policySource.indexOf("\nconst ", start + 1);
  const slice = nextConst < 0 ? policySource.slice(start) : policySource.slice(start, nextConst);
  const keys = new Set();
  for (const m of slice.matchAll(/^\s{2}"([A-Za-z0-9_.]+)":/gm)) keys.add(m[1]);
  for (const m of slice.matchAll(/^\s{2}\["([A-Za-z0-9_.]+)",/gm)) keys.add(m[1]);
  return keys;
}

/** 四张显式表 —— 每张**单独**取键集合,不先拍平。
 *
 * 【T45】拍平成一个 Set 会丢掉"哪张表解析失败"这个信息:一张表改了写法(比如
 * `BLOCKED` 被拆成两个对象),合并后总数可能仍 >100,自检放过,而那张表里的方法
 * 全部被误判成"新方法" —— 假红混进真信号里。所以下面逐张断言非空。 */
const EXPLICIT_TABLES = ["BLOCKED", "CREDENTIAL_BEARING", "DANGER", "EXPLICIT"];
const tableKeys = Object.fromEntries(EXPLICIT_TABLES.map((name) => [name, keysOfTable(name)]));

// 守卫自检 ①:每张表都必须解析到东西。
// 「某张表读到 0 条」= 形状变了(改名/合并/换成函数),此时守卫应该**报错**,
// 而不是安静地把那张表里的方法当成"没人分类的新方法"——那会一次报出几百条假红。
for (const name of EXPLICIT_TABLES) {
  if (tableKeys[name].size === 0) {
    throw Error(
      `T45 守卫从 policy.ts 的 ${name} 里一条键都没读到 —— 表形状变了,先修 ` +
      `gen-module-permission-map.mjs 的 keysOfTable。` +
      `(不报错的话,这张表里的方法会全部被误判成"未分类的新方法"。)`,
    );
  }
}

const explicitlyClassified = new Set(EXPLICIT_TABLES.flatMap((name) => [...tableKeys[name]]));

// 守卫自检 ②:总量兜底。单表非空还不够 —— 四张表各读到 1 条也能过 ①,
// 但那说明解析退化了(比如只匹配到一行)。
if (explicitlyClassified.size < 100) {
  throw Error(
    `T45 守卫读到的显式分档条目只有 ${explicitlyClassified.size} 条(预期 >100;` +
    EXPLICIT_TABLES.map((n) => `${n}=${tableKeys[n].size}`).join(" ") + `)——` +
    `policy.ts 的表形状变了,先修 gen-module-permission-map.mjs 的 keysOfTable`,
  );
}

/** 上一次生成的结果 = **已提交的** `appPermission.ts`(不是工作区那个,否则变异/漂移看不见)。 */
function committedPermissionKeys() {
  const current = resolve(root, "packages/contracts/src/appPermission.ts");
  if (!existsSync(current)) return new Set();
  const rel = "packages/contracts/src/appPermission.ts";
  const r = spawnSync("git", ["show", `HEAD:${rel}`], { cwd: root, encoding: "utf8" });
  // 未跟踪/首次生成时没有 HEAD 版本 —— 退化成"没有任何已知老方法"。
  // 那会让所有方法都被当成新的;此时只允许在没有 git 的环境里跑,并明确说清楚。
  const body = r.status === 0 ? r.stdout : readFileSync(current, "utf8");
  const keys = new Set();
  for (const m of body.matchAll(/^  "([A-Za-z0-9_.]+)":/gm)) keys.add(m[1]);
  return keys;
}
const knownMethods = committedPermissionKeys();

/* ⚠️ `knownMethods` **只服务准入闸门**（判断"这条方法有没有人做过决定"），
 *   它**不参与映射** —— `mapped`（本文件下面那段）遍历的是**全部** `methods`。
 *
 *   这个区分是 2026-10-24 一次真实误判的产物：有人以为"方法一旦写进已提交的
 *   `appPermission.ts`，生成器就把它当老方法、不再重新分类"，于是断定
 *   `policy.ts` 里改档位必须配合手工改生成物才生效。
 *
 *   **恰好相反**：档位一改，`policyFor(method)` 立刻返回新档位，`mapped` 当场重算。
 *   想让 `task.list` 从 `["session.read"]` 变成 `null`，**只需改 `policy.ts` + 重跑本脚本**，
 *   不需要动 `appPermission.ts`（那个文件头写着 Do not edit directly，是有理由的）。
 *
 *   什么时候 `knownMethods` 才会影响输出？**从不。** 它只决定 `unreviewed` 非空时
 *   脚本是「继续」还是「拒绝继续」。 */
const newMethods = methods.filter((m) => !knownMethods.has(m));
const unreviewed = newMethods.filter((m) =>
  !explicitlyClassified.has(m) &&
  !(m in overrides) &&
  !nonDelegableOverrides.has(m) &&
  !REVIEWED_FALLBACKS.has(m),
);
if (unreviewed.length > 0) {
  console.error(`\n✖ 以下 ${unreviewed.length} 条是**新方法**，没有人对"该不该给扩展"做过决定：\n`);
  for (const method of unreviewed) {
    const p = policyFor(method);
    const [domain] = method.split(".", 2);
    const wouldGrant = p.level === "read" || p.level === "ui" ? readPerm[domain] : writePerm[domain];
    console.error(`  ${method}`);
    console.error(`      兜底档位 "${p.level}" → 会发给扩展 "${wouldGrant ?? "(无)"}"`);
  }
  console.error(
    `\n生成器拒绝继续。兜底对 agent 是"宁可多问一次",对扩展是**直接发权限**。\n` +
    `请二选一：\n` +
    `  · 在 policy.ts 的 BLOCKED / DANGER / EXPLICIT / CREDENTIAL_BEARING 里显式分档（推荐）；\n` +
    `  · 在生成器的 REVIEWED_FALLBACKS 里逐条签字，写明为什么兜底档位对扩展是安全的。\n`,
  );
  process.exit(1);
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
