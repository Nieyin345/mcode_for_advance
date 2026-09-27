import assert from "node:assert/strict";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
// @ts-expect-error Existing self-contained JavaScript CDP harness.
import {withAuditPage} from "../ui-interaction-smoke/browser.mjs";
import {ModuleHost} from "../../src/main/modules/ModuleHost.js";
import {fileCapabilities,resolveModuleResource} from "../../src/main/modules/fileCapabilities.js";
import {EXAMPLE_MODULE as example} from "@contracts/modules";
import {ModuleCatalogSchema} from "@contracts/moduleCapability";

// Real host + real file capabilities; only the transport is a page<->node pump.
const dir=dirname(fileURLToPath(import.meta.url)),root=join(dir,"workspace");mkdirSync(root);writeFileSync(join(root,"report.txt"),"catalog ui\n");
const host=new ModuleHost({authorize:async r=>{await resolveModuleResource(r,p=>p===root);},persist:async()=>{}});for(const c of fileCapabilities(p=>p===root))host.register(c);
host.addBuiltin({...example,id:"core.file-report"});

/** TEST FIXTURE: a phase-1 shaped catalog (no metadata, no workflowTargets). */
const legacy={modules:[{...example,id:"core.file-report"}],capabilities:[{id:"core.file.inspect",kind:"task"},{id:"core.file.info",kind:"query"}]};
/** TEST FIXTURE validated by the frozen ModuleCatalogSchema: metadata for two
 * capabilities, one legacy capability, one host-published workflow target and a
 * user module that uses the same capability but is NOT a workflow target. */
const inspectContribution=example.contributions[0]!;
const rich=ModuleCatalogSchema.parse({
  modules:[
    {...example,id:"core.file-report",title:{zh:"内置文件报告",en:"Built-in file report"},contributions:[{...inspectContribution,title:{zh:"检查文件",en:"Inspect file"}},{...inspectContribution,id:"info",title:{zh:"文件信息",en:"File info"},capability:"core.file.info"}]},
    {...example,title:{zh:"用户导入报告",en:"Imported report"}},
  ],
  capabilities:[
    {id:"core.file.inspect",kind:"task",metadata:{schemaVersion:1,version:"1.2.0",title:{zh:"文件检查",en:"File inspection"},description:{zh:"计算文件字节数与 SHA-256。",en:"Computes byte size and SHA-256."},permissions:["resource.read"],
      inputSchema:{type:"object",properties:{path:{type:"string",description:"工作区内的文件"}},required:["path"],additionalProperties:false},
      outputSchema:{type:"object",properties:{bytes:{type:"integer"},sha256:{$ref:"#/definitions/digest"}},definitions:{digest:{type:"string",pattern:"^[a-f0-9]{64}$"}}},
      supportsCancellation:true,limits:{maxFileBytes:32*1024*1024,taskTimeoutMs:30000}}},
    {id:"core.file.info",kind:"query",metadata:{schemaVersion:1,version:"1.0.0",title:{zh:"文件信息",en:"File info"},description:{zh:"<img src=x onerror=\"window.__xss=1\"> 返回大小与修改时间。",en:"<img src=x onerror=\"window.__xss=1\"> Returns size and modification time."},permissions:["resource.read"],
      inputSchema:{type:"object"},outputSchema:{type:"object"},supportsCancellation:false}},
    {id:"core.file.legacy",kind:"query"},
  ],
  workflowTargets:[{moduleId:"core.file-report",contributionId:"inspect",capabilityId:"core.file.inspect"}],
});
type Mode="hold"|"fail"|"empty"|"real"|"legacy"|"rich";
let mode:Mode="hold";const held:Call[]=[];
interface Call {id:number;name:string;input:unknown}
const catalog=():unknown=>{if(mode==="fail")throw Error("catalog unavailable (fixture)");if(mode==="empty")return {modules:[],capabilities:[]};if(mode==="legacy")return structuredClone(legacy);if(mode==="rich")return structuredClone(rich);return host.catalog();};
const handlers:Record<string,(input:unknown)=>unknown>={catalog,tasks:()=>[]};
writeFileSync(join(dir,"index.html"),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Module catalog UI regression</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script>window.testApi={};window.fixtureRoot=${JSON.stringify(root)};</script><script src="/bundle.js"></script></body></html>`);
let passed=0;const pass=(name:string)=>{passed++;console.log("PASS "+name);};
interface Page {eval(source:string):Promise<unknown>;waitFor(source:string):Promise<void>;send(method:string,params:Record<string,unknown>):Promise<unknown>;sleep(ms:number):Promise<void>;goto(params:string,ready:string):Promise<void>;screenshot(name:string):Promise<void>;exceptions:string[];}
await withAuditPage(dir,async(page:Page)=>{
 let stop=false;
 const answer=async(call:Call)=>{let response;try{const h=handlers[call.name];if(!h)throw Error("unknown method "+call.name);response={id:call.id,data:await h(call.input)};}catch(e){response={id:call.id,error:e instanceof Error?e.message:String(e)};}await page.eval(`window.resolveRpc(${JSON.stringify(response)})`);};
 const pump=(async()=>{while(!stop){const calls=await page.eval("window.pendingRpc?window.pendingRpc.splice(0):[]") as Call[];for(const call of calls){if(call.name==="catalog"&&mode==="hold")held.push(call);else await answer(call);}if(mode!=="hold")for(const call of held.splice(0))await answer(call);await page.sleep(20);}})();
 const click=async(text:string)=>{await page.eval(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing button '+${JSON.stringify(text)});e.click();})()`);await page.sleep(150);};
 const mouse=async(selector:string)=>{const p=await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`) as {x:number;y:number};await page.send("Input.dispatchMouseEvent",{type:"mouseMoved",...p});await page.send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...p});await page.send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...p});await page.sleep(200);};
 const key=async(k:string,code:string,vk:number)=>{await page.send("Input.dispatchKeyEvent",{type:"keyDown",key:k,code,windowsVirtualKeyCode:vk,...(k==="Enter"?{text:"\r"}:{})});await page.send("Input.dispatchKeyEvent",{type:"keyUp",key:k,code,windowsVirtualKeyCode:vk});await page.sleep(150);};
 const setInput=(selector:string,value:string)=>page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const inDialog=(sel:string)=>`document.querySelector('[role=dialog] ${sel}')`;
 const text=(sel:string)=>page.eval(`(document.querySelector(${JSON.stringify(sel)})?.textContent??'')`) as Promise<string>;
 const rawKeys=()=>page.eval("/(ide\\.modules\\.|settings\\.workflows\\.module)/.test(document.body.innerText)") as Promise<boolean>;
 const open=async(params:string,m:Mode,title:string)=>{mode=m;held.length=0;await page.goto(params,"window.__ready");await page.sleep(200);await click(title);await page.waitFor("document.querySelector('[role=dialog]')");};
 const inspector=async(params:string,m:Mode)=>{mode=m;held.length=0;await page.goto("page=inspector&"+params,"window.__ready && document.querySelector('[data-testid=module-capability-fields]')");await page.sleep(200);};
 const params=()=>page.eval("window.currentDoc.nodes[0].params") as Promise<Record<string,unknown>>;
 const pathInput="[data-testid=module-capability-fields] input[type=text]";
 try {
  // ── Catalog in the native UI extensions window ──
  await open("","hold","UI 扩展");
  await page.waitFor(inDialog("[data-testid=capability-catalog-loading]"));assert.match(await text("[role=dialog] [data-testid=capability-catalog]"),/能力目录/);pass("catalog section with loading state lives in the native UI extensions window");
  mode="fail";await page.waitFor(inDialog("[data-testid=capability-catalog-error]"));assert.match(await text("[data-testid=capability-catalog-error]"),/catalog unavailable/);assert.equal(await page.eval("!!document.querySelector('[role=dialog] [data-testid=capability-catalog-error] [role=alert]')"),true);pass("catalog load failure is visible inside the modal as an alert");
  mode="real";
  await page.eval("[...document.querySelectorAll('[data-testid=capability-catalog-error] button')].find(e=>e.textContent.trim()==='重试').focus()");
  assert.equal(await page.eval("document.activeElement?.textContent.trim()"),"重试");await key("Enter","Enter",13);
  await page.waitFor(inDialog("[data-testid=capability-entry]"));
  const ids=await page.eval("[...document.querySelectorAll('[data-testid=capability-entry]')].map(e=>e.dataset.capabilityId).sort()") as string[];
  assert.deepEqual(ids,host.catalog().capabilities.map(c=>c.id).sort());assert.equal(await page.eval("!!document.querySelector('[data-testid=capability-catalog-error]')"),false);pass("keyboard retry recovers and lists exactly the capabilities registered by the real host");
  const kinds=await page.eval("Object.fromEntries([...document.querySelectorAll('[data-testid=capability-entry]')].map(e=>[e.dataset.capabilityId,e.querySelector('[data-testid=capability-kind]').textContent.trim()]))") as Record<string,string>;
  assert.deepEqual(kinds,{"core.file.info":"查询","core.file.inspect":"任务"});
  assert.match(await text("[data-capability-id='core.file.inspect'] [data-testid=capability-used-by]"),/我的文件报告/);pass("capability kind and the host contributions using it are shown");
  await page.screenshot("catalog-real.png");
  await open("","legacy","UI 扩展");await page.waitFor(inDialog("[data-testid=capability-entry]"));
  for(const id of ["core.file.inspect","core.file.info"]){assert.match(await text(`[data-capability-id='${id}'] [data-testid=capability-metadata-missing]`),/未提供说明元数据/);assert.equal(await page.eval(`!!document.querySelector("[data-capability-id='${id}'] [data-testid=capability-permissions]")`),false);}
  assert.match(await text("[data-testid=capability-workflow-none]"),/暂无可用于工作流的目标/);pass("legacy catalog without metadata shows an explicit unknown state and no invented permissions or workflow targets");
  await open("","rich","UI 扩展");await page.waitFor(inDialog("[data-testid=capability-entry]"));
  const inspect="[data-capability-id='core.file.inspect']";
  assert.match(await text(`${inspect} [data-testid=capability-title]`),/文件检查/);assert.match(await text(`${inspect} [data-testid=capability-version]`),/1\.2\.0/);
  assert.match(await text(`${inspect} [data-testid=capability-description]`),/SHA-256/);assert.match(await text(`${inspect} [data-testid=capability-permissions]`),/只读/);
  assert.match(await text(`${inspect} [data-testid=capability-limits]`),/32 MiB/);assert.match(await text(`${inspect} [data-testid=capability-limits]`),/30 秒/);assert.match(await text(`${inspect} [data-testid=capability-cancellation]`),/支持取消/);
  assert.match(await text(`${inspect} [data-testid=capability-input-schema]`),/path\s*string\s*必填/);assert.match(await text(`${inspect} [data-testid=capability-output-schema]`),/引用 #\/definitions\/digest/);
  assert.match(await text(`${inspect} [data-testid=capability-output-schema] [data-testid=schema-raw]`),/"pattern"/);
  pass("metadata shows purpose, version, read-only permission, limits, cancellation and schemas as text (local $ref not expanded)");
  const info="[data-capability-id='core.file.info']";
  assert.match(await text(`${info} [data-testid=capability-limits]`),/未声明/);assert.doesNotMatch(await text(`${info} [data-testid=capability-limits]`),/MiB|秒/);assert.match(await text(`${info} [data-testid=capability-cancellation]`),/不支持取消/);
  assert.equal(await page.eval("document.querySelector('[role=dialog] img')"),null);assert.equal(await page.eval("window.__xss"),undefined);assert.match(await text(`${info} [data-testid=capability-description]`),/<img src=x/);
  assert.match(await text("[data-capability-id='core.file.legacy'] [data-testid=capability-metadata-missing]"),/未提供说明元数据/);
  pass("undeclared limits are not invented for queries; markup in metadata renders as inert text; mixed legacy entry stays unknown");
  assert.equal(await page.eval(`document.querySelector("${inspect} [data-testid=capability-workflow]").dataset.usable`),"true");assert.match(await text(`${inspect} [data-testid=capability-workflow]`),/内置文件报告 · 检查文件/);assert.doesNotMatch(await text(`${inspect} [data-testid=capability-workflow]`),/用户导入报告/);
  assert.equal(await page.eval(`document.querySelector("${info} [data-testid=capability-workflow]").dataset.usable`),"false");assert.equal(await page.eval("!!document.querySelector('[data-testid=capability-workflow-none]')"),false);
  pass("workflow usability comes only from host workflowTargets; the user module using the same capability is not offered");
  await page.screenshot("catalog-rich.png");
  await open("","empty","UI 扩展");await page.waitFor(inDialog("[data-testid=capability-catalog-empty]"));assert.equal(await page.eval("document.querySelectorAll('[data-testid=capability-entry]').length"),0);pass("empty catalog has an explicit empty state");
  await open("locale=en","rich","UI extensions");await page.waitFor(inDialog("[data-testid=capability-entry]"));
  assert.match(await text("[role=dialog] [data-testid=capability-catalog]"),/Capability catalog/);assert.match(await text(`${inspect} [data-testid=capability-kind]`),/Task/);assert.match(await text(`${inspect} [data-testid=capability-limits]`),/max 32 MiB per file/);assert.match(await text("[data-capability-id='core.file.legacy'] [data-testid=capability-metadata-missing]"),/No descriptive metadata/);
  assert.equal(await rawKeys(),false);pass("English locale renders the catalog with no raw dictionary keys");
  await page.screenshot("catalog-en.png");
  assert.deepEqual(page.exceptions,[]);

  // ── module-capability node inspector ──
  await inspector("doc=blank","rich");await page.waitFor("document.querySelector('[data-testid=module-target-trigger]') && !document.querySelector('[data-testid=module-target-loading]')");
  assert.equal(await page.eval("[...document.querySelectorAll('[data-testid=module-capability-fields] ~ * input, aside input')].filter(e=>['moduleId','contributionId','path'].includes(e.getAttribute('aria-label')??'')).length"),0);
  assert.equal(await page.eval("[...document.querySelectorAll('aside span')].some(e=>['moduleId','contributionId'].includes(e.textContent.trim()))"),false);
  await page.eval("document.querySelector('[data-testid=module-target-trigger]').focus()");await key("ArrowDown","ArrowDown",40);
  await page.waitFor("document.querySelector('[data-testid=module-target-option]')");
  const options=await page.eval("[...document.querySelectorAll('[data-testid=module-target-option]')].map(e=>e.textContent.trim())") as string[];
  assert.deepEqual(options,["内置文件报告 · 检查文件"]);pass("node target options are exactly the host workflowTargets and open from the keyboard");
  const chosen="window.currentDoc.nodes[0].params.moduleId==='core.file-report'";
  // Keyboard selection first (Enter on the highlighted option); pointer click as the alternate path.
  await key("Enter","Enter",13);
  if(!await page.eval(chosen))await mouse("[data-testid=module-target-option]");
  await page.waitFor(chosen);
  let p=await params();assert.deepEqual({moduleId:p.moduleId,contributionId:p.contributionId},{moduleId:"core.file-report",contributionId:"inspect"});
  for(const k of ["capabilityId","requestId","projectPath","trusted"])assert.equal(Object.hasOwn(p,k),false);
  assert.match(await text("[data-testid=module-target-summary]"),/core\.file\.inspect/);
  await setInput(pathInput,"docs/a.txt");await page.sleep(100);p=await params();assert.equal(p.path,"docs/a.txt");
  pass("choosing a target stores only moduleId/contributionId, and the path parameter is saved");
  await page.eval("window.setSelected(null)");await page.sleep(100);await page.eval("window.loadDoc(JSON.parse(JSON.stringify(window.currentDoc)))");await page.eval("window.setSelected('call')");
  await page.waitFor("document.querySelector('[data-testid=module-target-summary]')");
  assert.match(await text("[data-testid=module-target-trigger]"),/内置文件报告 · 检查文件/);assert.equal(await page.eval(`document.querySelector(${JSON.stringify(pathInput)}).value`),"docs/a.txt");pass("configuration survives a serialize/reopen round trip");
  await setInput(pathInput,"{{提取.file}}");await page.waitFor("document.querySelector('[data-testid=module-path-variable]')");p=await params();assert.equal(p.path,"{{提取.file}}");assert.equal(await page.eval("!!document.querySelector('[data-testid=module-call-invalid]')"),false);
  pass("a variable path is kept as a template and flagged as resolved at run time");
  await page.screenshot("inspector-configured.png");
  await inspector("doc=stale","rich");await page.waitFor("document.querySelector('[data-testid=module-target-stale]')");
  assert.match(await text("[data-testid=module-target-trigger]"),/已失效：core\.removed \/ gone/);p=await params();assert.equal(p.moduleId,"core.removed");assert.equal(p.contributionId,"gone");pass("a selection missing from the catalog is shown as stale and never silently replaced");
  await inspector("doc=forbidden","rich");await page.waitFor("document.querySelector('[data-testid=module-forbidden-params]')");
  assert.match(await text("[data-testid=module-forbidden-params]"),/projectPath, requestId, trusted/);await click("移除这些字段");p=await params();
  assert.deepEqual(Object.keys(p).sort(),["contributionId","moduleId","path"]);pass("host-owned fields in node params are flagged and removable, not silently kept");
  await inspector("doc=blank","legacy");await page.waitFor("document.querySelector('[data-testid=module-target-none]')");
  assert.equal(await page.eval("document.querySelector('[data-testid=module-target-trigger]').hasAttribute('data-disabled')||document.querySelector('[data-testid=module-target-trigger]').disabled===true"),true);pass("a catalog without workflowTargets offers no targets (no ID-prefix fallback)");
  await inspector("doc=blank","fail");await page.waitFor("document.querySelector('[data-testid=module-target-error] [role=alert]')");assert.match(await text("[data-testid=module-target-error]"),/catalog unavailable/);
  mode="rich";await click("重试");await page.waitFor("!document.querySelector('[data-testid=module-target-error]') && !document.querySelector('[data-testid=module-target-none]')");
  assert.equal(await page.eval("document.querySelector('[data-testid=module-target-trigger]').hasAttribute('data-disabled')"),false);pass("catalog failure is visible in the inspector and retry recovers");
  assert.match(await text("[data-testid=card-host]"),/读取文件信息/);pass("workflow node card renders the new runner kind");
  await inspector("doc=blank&locale=en","rich");await page.waitFor("document.querySelector('[data-testid=module-target-trigger]') && !document.querySelector('[data-testid=module-target-loading]')");
  assert.match(await text("[data-testid=module-capability-fields]"),/Capability/);assert.match(await text("[data-testid=module-capability-fields]"),/File path/);assert.match(await text("[data-testid=module-target-trigger]"),/Choose a capability/);assert.equal(await rawKeys(),false);pass("inspector fields render in English with no raw dictionary keys");
  assert.deepEqual(page.exceptions,[]);pass("no uncaught browser errors");
 } finally {stop=true;await pump;}
});
writeFileSync(join(dir,"results.json"),JSON.stringify({passed},null,2));console.log(`${passed} catalog UI checks passed`);
