import assert from "node:assert/strict";
import {mkdirSync,writeFileSync,readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
// @ts-expect-error Existing self-contained JavaScript CDP harness.
import {withAuditPage} from "../ui-interaction-smoke/browser.mjs";
import {ModuleHost} from "../../src/main/modules/ModuleHost.js";
import {fileCapabilities,resolveModuleResource} from "../../src/main/modules/fileCapabilities.js";
import {ModuleInstallSchema,ModuleInvokeSchema,ModuleTaskRefSchema,ModuleWorkspaceSchema,ModuleRemoveSchema} from "@contracts/ipc";
import {EXAMPLE_MODULE as example} from "@contracts/modules";
const dir=dirname(fileURLToPath(import.meta.url)),root=join(dir,"workspace"),path=join(root,"report.txt");mkdirSync(root);writeFileSync(path,"real module backend\n");
const hash=createHash("sha256").update("real module backend\n").digest("hex");
const host=new ModuleHost({authorize:async r=>{await resolveModuleResource(r,p=>p===root);},persist:async()=>{}});for(const c of fileCapabilities(p=>p===root))host.register(c);
host.addBuiltin({...example,id:"core.file-report"});
const handlers:Record<string,(input:unknown)=>unknown>={catalog:()=>host.catalog(),install:x=>host.install(ModuleInstallSchema.parse(x).manifest),remove:x=>host.remove(ModuleRemoveSchema.parse(x).moduleId),invoke:x=>host.invoke(ModuleInvokeSchema.parse(x)),task:x=>host.task(ModuleTaskRefSchema.parse(x)),cancel:x=>host.cancel(ModuleTaskRefSchema.parse(x)),tasks:x=>host.tasks(ModuleWorkspaceSchema.parse(x)),egressConsentGet:()=>({enabled:false,osIsolation:false})};
writeFileSync(join(dir,"index.html"),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Module UI regression</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script>window.testApi={};window.fixtureRoot=${JSON.stringify(root)};window.fixturePath=${JSON.stringify(path)};</script><script src="/bundle.js"></script></body></html>`);
let passed=0;const pass=(name:string)=>{passed++;console.log("PASS "+name);};
interface Page {eval(source:string):Promise<unknown>;waitFor(source:string):Promise<void>;send(method:string,params:Record<string,unknown>):Promise<unknown>;sleep(ms:number):Promise<void>;goto(params:string,ready:string):Promise<void>;screenshot(name:string):Promise<void>;exceptions:string[];}
await withAuditPage(dir,async(page:Page)=>{
 await page.goto("","window.__ready && document.getElementById('fixture-file')");
 let stop=false;const pump=(async()=>{while(!stop){const calls=await page.eval("window.pendingRpc.splice(0)") as {id:number;name:string;input:unknown}[];for(const call of calls){let response;try{if(!handlers[call.name])throw Error('unknown method');response={id:call.id,data:await handlers[call.name](call.input)};}catch(e){response={id:call.id,error:String(e)};}await page.eval(`window.resolveRpc(${JSON.stringify(response)})`);}await page.sleep(20);}})();
 const click=async(text:string)=>{await page.eval(`(()=>{const e=[...document.querySelectorAll('button,[role=menuitem]')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing button '+${JSON.stringify(text)});e.click();})()`);await page.sleep(150);};
 const close=()=>page.eval("document.querySelector('[aria-label=关闭]')?.click()");
 // Permission picker added multiple checkboxes ahead of the read-consent row
 // in T48. Clicking the first checkbox no longer means consenting to import.
 const consentToRead=()=>page.eval("(()=>{const row=[...document.querySelectorAll('[role=dialog] label')].find(e=>e.textContent.includes('我允许此模块'));if(!row)throw Error('Read consent label missing');row.querySelector('input[type=checkbox]').click();})()");
 // A fixed delay is not a readiness signal: the closing modal backdrop can
 // still receive the right click on slower frames. Keep the existing timeout
 // and assertions; wait until the real target is no longer occluded.
 const menu=async()=>{await page.waitFor("(()=>{const e=document.getElementById('fixture-file');if(!e)return false;const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+20,r.y+20));})()");const p=await page.eval("(()=>{const r=document.getElementById('fixture-file').getBoundingClientRect();return {x:r.x+20,y:r.y+20}})()") as {x:number;y:number};await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',clickCount:1,...p});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',clickCount:1,...p});await page.waitFor("document.querySelector('[role=menuitem]')");};
 try {
  await page.sleep(300);await menu();await click("生成我的文件报告");await page.waitFor(`document.body.textContent.includes(${JSON.stringify(hash)})`);pass("native menu calls real file backend and renders its SHA-256");await page.screenshot("builtin-result.png");await close();await page.sleep(200);
  await click("UI 扩展");await page.waitFor("document.querySelector('[data-testid=module-manifest]')");assert.equal(await page.eval("Boolean(document.querySelector('[role=dialog]'))"),true);pass("module manager dialog actually opened");assert.equal(await page.eval("[...document.querySelectorAll('button')].find(e=>e.textContent==='确认并导入 / 更新').disabled"),true);pass("import requires explicit read consent");
  const invalid={...example,script:"forbidden"};
  await page.eval(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(JSON.stringify(invalid))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await consentToRead();await click("确认并导入 / 更新");await page.waitFor("[...document.querySelectorAll('[role=dialog] [role=alert]')].some(e=>e.textContent.includes('script'))");assert.equal(host.catalog().modules.length,1);pass("invalid manifest reports its disallowed script field inside the actual modal, with no install");
  // Valid executable manifest: require visible *human-readable* warning and
  // a second opt-in independent of the read-only permission. Do not install it.
  const executable={...example,contributions:[{...example.contributions[0],capability:'module.run'}],program:{source:'({run: async () => ({sha256:"fixture"})})'}};
  await page.eval(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(JSON.stringify(executable))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await page.waitFor("Boolean(document.querySelector('[data-testid=module-code-consent]'))");
  assert.equal(await page.eval("document.querySelector('[data-testid=module-code-consent]').textContent.includes('我了解此扩展包含可执行程序：它会在我这台机器上运行')"),true);
  assert.equal(await page.eval("[...document.querySelectorAll('[role=dialog] [role=alert]')].some(e=>e.textContent.includes('执行程序需要先在上方明确授权 JS-only 降级'))"),true);
  await consentToRead();
  assert.equal(await page.eval("[...document.querySelectorAll('button')].find(e=>e.textContent==='确认并导入 / 更新').disabled"),true);
  pass("executable code warning is visible to users, and install requires separate code consent");
  const custom={...example,title:{zh:"自定义统计",en:"Custom report"},contributions:[{...example.contributions[0],title:{zh:"我的右键操作",en:"My action"},view:{title:{zh:"我的结果面板",en:"My result"},fields:[{key:"sha256",title:{zh:"自定义摘要字段",en:"Custom digest"}}]}}]};
  await page.eval(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(JSON.stringify(custom))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await consentToRead();await click("确认并导入 / 更新");await page.waitFor("document.body.textContent.includes('自定义统计')");assert.equal(host.catalog().modules.length,2);pass("JSON import registers external contribution through the real host");await close();await page.sleep(200);
  await menu();await click("我的右键操作");await page.waitFor(`document.body.textContent.includes(${JSON.stringify(hash)})`);assert.equal(await page.eval("document.body.textContent.includes('自定义摘要字段')"),true);pass("external menu and customized result field use the same capability");await page.screenshot("custom-result.png");await close();await page.sleep(200);
  await page.eval("document.getElementById('toggle').click()");await page.sleep(100);await page.eval("document.getElementById('toggle').click()");await page.sleep(250);await click("UI 扩展");await page.waitFor("document.body.textContent.includes('report.txt')");assert.equal(host.tasks({projectPath:root}).length,2);pass("tasks survive complete UI unmount and remain in workspace history");await page.screenshot("module-manager.png");
  await click("移除扩展");await page.waitFor("!document.body.textContent.includes('自定义统计')");assert.equal(host.catalog().modules.length,1);await close();await page.sleep(150);await menu();assert.equal(await page.eval("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='我的右键操作')"),false);pass("uninstall removes native menu contribution");
  assert.deepEqual(page.exceptions,[]);pass("no uncaught browser errors");
 } finally {stop=true;await pump;}
});
writeFileSync(join(dir,"results.json"),JSON.stringify({passed},null,2));console.log(`${passed} browser checks passed`);
