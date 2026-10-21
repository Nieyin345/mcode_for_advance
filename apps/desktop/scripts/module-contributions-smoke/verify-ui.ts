import assert from "node:assert/strict";
import {dirname} from "node:path";
import {fileURLToPath} from "node:url";
// @ts-expect-error Existing self-contained JavaScript CDP harness.
import {withAuditPage} from "../ui-interaction-smoke/browser.mjs";
const dir=dirname(fileURLToPath(import.meta.url));
interface Page {eval(source:string):Promise<unknown>;waitFor(source:string):Promise<void>;sleep(ms:number):Promise<void>;goto(params:string,ready:string):Promise<void>;exceptions:string[];}
await withAuditPage(dir,async(page:Page)=>{
 await page.goto("","window.__ready && document.querySelector('[data-testid=module-settings-group]')");
 await page.waitFor("document.querySelector('[data-testid=module-view-right] [data-testid=module-view-field-bytes]')?.textContent==='24'");
 for(const location of ["right","left","bottom"]){
   assert.equal(await page.eval("document.querySelector('[data-testid=module-view-"+location+"] [data-testid=module-view-field-bytes]')?.textContent"),"24");
 }
 console.log("PASS module views render at all 3 specified locations with live host result");
 const before=await page.eval("window.__calls.filter(x=>x.contributionId==='viewright').length");
 await page.eval("document.querySelector('[data-testid=module-view-right] [data-testid=module-view-refresh]').click()");
 await page.waitFor("window.__calls.filter(x=>x.contributionId==='viewright').length > "+before);
 console.log("PASS view refresh invokes host again");
 await page.waitFor("document.querySelector('[data-testid^=module-setting-] input')");
 await page.eval(`(()=>{const input=document.querySelector('[data-testid="module-setting-user.t50.ui-apiEndpoint"] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"https://example.invalid");input.dispatchEvent(new Event("input",{bubbles:true}));})()`);
 await page.eval("document.querySelector('[data-testid^=module-setting-] button').click()");
 await page.waitFor("window.__writes.length===1");
 assert.deepEqual(await page.eval("window.__writes[0]"),{extensionId:"user.t50.ui",key:"apiEndpoint",value:"https://example.invalid"});
 console.log("PASS extension configuration persists into extensionStore, not core setting.set");
 await page.eval("window.__mountPalette()");
 await page.waitFor("document.body.textContent.includes('acme.hello')");
 assert.equal(await page.eval("document.body.textContent.includes('打招呼')"),true);
 console.log("PASS extension command is visible in real Ctrl+K palette");
 const count=await page.eval("window.__calls.filter(x=>x.contributionId==='hello').length");
 await page.eval(`(()=>{const hit=[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('acme.hello'));if(!hit)throw Error('missing extension command option');hit.click();})()`);
 await page.waitFor("window.__calls.filter(x=>x.contributionId==='hello').length > "+count);
 console.log("PASS palette command dispatches to host contribution");
 assert.deepEqual(page.exceptions,[]);
});
