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
// 【T18】安装卡的三态会写「权限决策」—— 夹具给一份内存存档,与生产
// `module-permissions.json` 同形状(否则持久决策会被宿主按 fail-closed 拒绝)。
let permissionArchive: string | null = null;
const host=new ModuleHost({authorize:async r=>{await resolveModuleResource(r,p=>p===root);},persist:async()=>{},readModulePermissions:()=>permissionArchive,persistModulePermissions:async text=>{permissionArchive=text;}});for(const c of fileCapabilities(p=>p===root))host.register(c);
host.addBuiltin({...example,id:"core.file-report"});
const handlers:Record<string,(input:unknown)=>unknown>={catalog:()=>host.catalog(),install:x=>{const input=ModuleInstallSchema.parse(x);return host.install(input.manifest,input.grantedPermissions,input.installConsent??"allow-once");},remove:x=>host.remove(ModuleRemoveSchema.parse(x).moduleId),invoke:x=>host.invoke(ModuleInvokeSchema.parse(x)),task:x=>host.task(ModuleTaskRefSchema.parse(x)),cancel:x=>host.cancel(ModuleTaskRefSchema.parse(x)),tasks:x=>host.tasks(ModuleWorkspaceSchema.parse(x)),egressConsentGet:()=>({enabled:false,osIsolation:false})};
writeFileSync(join(dir,"index.html"),`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Module UI regression</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script>window.testApi={};window.fixtureRoot=${JSON.stringify(root)};window.fixturePath=${JSON.stringify(path)};</script><script src="/bundle.js"></script></body></html>`);
let passed=0;const pass=(name:string)=>{passed++;console.log("PASS "+name);};
interface Page {eval(source:string):Promise<unknown>;waitFor(source:string):Promise<void>;send(method:string,params:Record<string,unknown>):Promise<unknown>;sleep(ms:number):Promise<void>;goto(params:string,ready:string):Promise<void>;screenshot(name:string):Promise<void>;exceptions:string[];}
await withAuditPage(dir,async(page:Page)=>{
 await page.goto("","window.__ready && document.getElementById('fixture-file')");
 let stop=false;const pump=(async()=>{while(!stop){const calls=await page.eval("window.pendingRpc.splice(0)") as {id:number;name:string;input:unknown}[];for(const call of calls){let response;try{if(!handlers[call.name])throw Error('unknown method');response={id:call.id,data:await handlers[call.name](call.input)};}catch(e){response={id:call.id,error:String(e)};}await page.eval(`window.resolveRpc(${JSON.stringify(response)})`);}await page.sleep(20);}})();
 const click=async(text:string)=>{await page.eval(`(()=>{const e=[...document.querySelectorAll('button,[role=menuitem]')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing button '+${JSON.stringify(text)});e.click();})()`);await page.sleep(150);};
 // 【T18】安装要点过「安装权限卡」（允许一次 / 始终允许 / 拒绝）。它开卡后有
 // 500ms 的输入保护窗口（ARC-005），所以先等按钮可点再点。
 const consentToInstall=async(choice:"允许一次"|"始终允许")=>{
   await page.waitFor("(()=>{const b=[...document.querySelectorAll('[data-testid=module-install-consent] button')].find(e=>e.textContent.trim()==="+JSON.stringify(choice)+");return b&&!b.disabled;})()");
   await page.eval(`(()=>{const b=[...document.querySelectorAll('[data-testid=module-install-consent] button')].find(e=>e.textContent.trim()===${JSON.stringify(choice)});b.click();})()`);
   await page.sleep(150);
 };
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
  // 【T18】安装权限卡:键盘合同与「拒绝 = 不写盘」。用原始只读清单(它的权限只有
  // resource.read)把流程走一遍:
  //  ① 点「确认并导入」后卡片出现,焦点不在任何授权按钮上(连击/回程回车没有动作);
  //  ② 「允许」在开卡短延迟内不可点(ARC-005),拒绝按钮立即可点;
  //  ③ Esc = 拒绝 —— 卡片消失、**磁盘无写入**(宿主模块数不变)。
  {
    const before = host.catalog().modules.length;
    await page.eval(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(JSON.stringify(example))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await consentToRead();
    await click("确认并导入 / 更新");
    await page.waitFor("document.querySelector('[data-testid=module-install-consent]')");
    assert.equal(await page.eval("document.activeElement?.closest('[data-testid=module-install-consent]') !== null"), true);
    assert.equal(await page.eval("['[data-testid=module-install-allow-once]','[data-testid=module-install-allow-always]'].some(s=>document.activeElement===document.querySelector(s))"), false);
    assert.equal(await page.eval("document.querySelector('[data-testid=module-install-allow-once]').disabled"), true);
    assert.equal(await page.eval("document.querySelector('[data-testid=module-install-deny]').disabled"), false);
    pass("§T18 安装卡:焦点落在卡片上、授权按钮开卡后延迟可点、拒绝立即可用");
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.waitFor("!document.querySelector('[data-testid=module-install-consent]')");
    await page.sleep(150);
    assert.equal(host.catalog().modules.length, before);
    pass("§T18 Esc=拒绝:卡片关闭且宿主零写入(拒绝不是先装后禁用)");
  }
  const custom={...example,title:{zh:"自定义统计",en:"Custom report"},contributions:[{...example.contributions[0],title:{zh:"我的右键操作",en:"My action"},view:{title:{zh:"我的结果面板",en:"My result"},fields:[{key:"sha256",title:{zh:"自定义摘要字段",en:"Custom digest"}}]}}]};
  await page.eval(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(JSON.stringify(custom))});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await consentToRead();await click("确认并导入 / 更新");await consentToInstall("始终允许");await page.waitFor("document.body.textContent.includes('自定义统计')");assert.equal(host.catalog().modules.length,2);pass("JSON import registers external contribution through the real host");await close();await page.sleep(200);
  await menu();await click("我的右键操作");await page.waitFor(`document.body.textContent.includes(${JSON.stringify(hash)})`);assert.equal(await page.eval("document.body.textContent.includes('自定义摘要字段')"),true);pass("external menu and customized result field use the same capability");await page.screenshot("custom-result.png");await close();await page.sleep(200);
  await page.eval("document.getElementById('toggle').click()");await page.sleep(100);await page.eval("document.getElementById('toggle').click()");await page.sleep(250);await click("UI 扩展");await page.waitFor("document.body.textContent.includes('report.txt')");assert.equal(host.tasks({projectPath:root}).length,2);pass("tasks survive complete UI unmount and remain in workspace history");await page.screenshot("module-manager.png");
  await click("移除扩展");await page.waitFor("!document.body.textContent.includes('自定义统计')");assert.equal(host.catalog().modules.length,1);await close();await page.sleep(150);await menu();assert.equal(await page.eval("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent==='我的右键操作')"),false);pass("uninstall removes native menu contribution");
  assert.deepEqual(page.exceptions,[]);pass("no uncaught browser errors");
 } finally {stop=true;await pump;}
});
writeFileSync(join(dir,"results.json"),JSON.stringify({passed},null,2));console.log(`${passed} browser checks passed`);
