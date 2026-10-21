// T58: browser-level checks of the NEW library entry. The old custom-canvas
// drag, SVG-edge and inspector assertions are obsolete and must never be faked.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { withAuditPage } from './browser.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const checks=[];const errors=[];
function check(name,ok,detail){checks.push({name,ok,detail});console.log((ok?'PASS ':'FAIL ')+name+(detail===undefined?'':' '+JSON.stringify(detail)));}
const helper=`window.__ui={
  button(t){return [...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===t);},
  open(name){const nav=document.querySelector('#workflows-panel-library nav');const b=[...nav.querySelectorAll('button')].find(x=>x.textContent.includes(name));if(!b)throw Error('Missing library row '+name);b.click();},
  field(name){const e=[...document.querySelectorAll('div.mb-2.block.w-full')].find(x=>x.getClientRects().length&&x.firstElementChild?.textContent.includes(name));if(!e)throw Error('Missing field '+name);return e;},
  set(name,value){const e=this.field(name).querySelector('input,textarea');if(!e)throw Error('No editable input '+name);Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));},
  nav(name){const b=[...document.querySelector('aside nav').querySelectorAll('button')].find(x=>x.textContent.trim()===name);if(!b)throw Error('Missing settings nav '+name);b.click();}
}`;
const nativeEntry='#workflows-panel-library section[aria-label]';
async function open(page,locale='zh'){
  await page.goto('case=workflow&locale='+locale);
  await page.eval(helper);
  await page.waitFor('document.querySelector("#workflows-panel-library nav button")');
  await page.eval('__ui.open("资料整理流程")');
  await page.waitFor(`document.querySelector("${nativeEntry}")`);
}
await withAuditPage(here,async page=>{
  async function test(name,fn){try{await fn();check(name+': no JS exceptions',page.exceptions.length===0,page.exceptions.slice());}
    catch(e){errors.push(name+': '+(e.stack??e));console.error('HARNESS ERROR '+errors.at(-1));}}
  await test('native-editor-entry',async()=>{
    await open(page);
    check('real native entry replaces deleted WorkflowCanvas',await page.eval(`!!document.querySelector('${nativeEntry}')&&!document.querySelector('[data-workflow-viewport]')`));
    check('native button is keyboard reachable',await page.eval(`(()=>{const b=document.querySelector('${nativeEntry} button');return b?.tabIndex>=0&&b?.getClientRects().length>0})()`));
    check('entry states it opens Node-RED',await page.eval(`document.querySelector('${nativeEntry}').textContent.includes('Node-RED')`));
    const row=await page.eval(`(()=>{const rows=[...document.querySelectorAll('#workflows-panel-library nav button')];return {count:rows.length,current:rows.filter(b=>b.getAttribute('aria-current')==='true').length,tabbable:rows.every(b=>b.tabIndex>=0)}})()`);
    check('library rows retain accessible active selection',row.count>=2&&row.current===1&&row.tabbable,row);
    await page.eval('__ui.open("第二条普通工作流")');
    await page.waitFor(`document.querySelector('${nativeEntry}')`);
    check('choosing a second workflow keeps native entry',await page.eval(`!!document.querySelector('${nativeEntry}')`));
    await page.eval(`document.querySelector('${nativeEntry} button').click()`);
    await page.waitFor('document.querySelector("#workflows-panel-engines")?.classList.contains("flex")');
    check('native entry loads the selected B rather than previously selected A',await page.eval('__audit.nativeLoads.at(-1)==="audit-workflow-b"'));
    check('native entry really navigates to engine tab',await page.eval('document.querySelector("#workflows-panel-engines").classList.contains("flex")'));
    await page.screenshot('native-workflow-entry.png');
  });
  await test('library-save-and-drafts',async()=>{
    await open(page);
    await page.eval('__ui.set("名称","跨栏目草稿")');
    await page.sleep(120);
    check('unsaved draft enables explicit save',await page.eval('!__ui.button("保存").disabled'));
    await page.eval('__ui.nav("自动化")');
    await page.waitFor('document.querySelector("#automation-panel-library")');
    await page.eval('__ui.nav("工作流")');
    await page.waitFor('document.querySelector("#workflows-panel-library nav button")');
    await page.eval('__ui.open("资料整理流程")');await page.waitFor(`document.querySelector('${nativeEntry}')`);
    check('draft survives settings remount',await page.eval('__ui.field("名称").querySelector("input").value==="跨栏目草稿"'));
    check('not auto-saved',await page.eval('__audit.saves.length===0'));
    await page.eval('__ui.button("放弃改动").click()');await page.sleep(120);
    check('discard restores saved title',await page.eval('__ui.field("名称").querySelector("input").value==="资料整理流程"'));
    await page.eval('__ui.set("框架","保存到库的框架说明")');
    await page.sleep(100);await page.eval('__ui.button("保存").click()');
    await page.waitFor('__audit.saves.length===1');
    check('library save still persists metadata through IPC stub',await page.eval('__audit.docs["audit-workflow"].frameworkNote==="保存到库的框架说明"'));
    check('native entry remains after metadata save',await page.eval(`!!document.querySelector('${nativeEntry}')`));
  });
  await test('native-deploy-refresh-without-losing-draft',async()=>{
    await page.goto('case=review-pending&locale=zh');
    await page.eval(helper);
    await page.waitFor('document.querySelector("#workflows-panel-library nav button")');
    await page.eval('__ui.open("资料整理流程")');
    await page.waitFor(`document.querySelector('${nativeEntry}')`);
    await page.eval('__audit.docs["audit-workflow"].nodes[1].title="Native editor renamed agent"; __audit.emitWorkflowChange()');
    await page.waitFor('document.body.innerText.includes("Native editor renamed agent")');
    check('native deploy notification refreshes selected library document',
      await page.eval('document.body.innerText.includes("Native editor renamed agent")'));
    await page.eval('__ui.set("名称","未保存的用户草稿")');
    await page.sleep(120);
    await page.eval('__audit.docs["audit-workflow"].nodes[1].title="Another native rename"; __audit.emitWorkflowChange()');
    await page.sleep(150);
    check('native sync does not overwrite dirty local draft',
      await page.eval('__ui.field("名称").querySelector("input").value==="未保存的用户草稿"'));
  });
  await test('english-and-automation',async()=>{
    await open(page,'en');
    check('English native-entry text',await page.eval(`document.querySelector('${nativeEntry}').textContent.includes('Node-RED')`));
    await page.goto('case=automation&locale=zh');
    await page.eval(helper);
    await page.waitFor('document.querySelector("#automation-panel-library nav button")');
    await page.eval(`(()=>{const b=[...document.querySelectorAll('#automation-panel-library nav button')].find(e=>e.textContent.includes('文件清单自动化'));b?.click()})()`);
    await page.waitFor('document.querySelector("#automation-panel-library section[aria-label]")');
    check('automation shares native editor entry',await page.eval('!!document.querySelector("#automation-panel-library section[aria-label] button")'));
  });
});
const result={checks,errors,summary:{passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,errors:errors.length}};
writeFileSync(join(here,'fix-verification.json'),JSON.stringify(result,null,2));
console.log('T58 WORKFLOW UI SUMMARY '+JSON.stringify(result.summary));
if(result.summary.failed||errors.length)process.exitCode=1;
