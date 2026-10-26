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
  /* W15：工作流的默认页签改成了原厂画布，「库」那一页要先点页签才可见。
     这里照**用户真实路径**走一步：点「工作流库」页签（按 id，不按文案 ——
     zh/en 两套词典都通）。不点的话下面 field() 的 getClientRects 判据会认不出
     "元素在 DOM 里但整页 hidden"，报 Missing field 而不是报"你忘了切页签"。 */
  showLibrary(){const t=document.querySelector('#workflows-tab-library');if(!t)throw Error('Missing workflows library tab');if(t.getAttribute('aria-selected')!=='true')t.click();},
  field(name){const e=[...document.querySelectorAll('div.mb-2.block.w-full')].find(x=>x.getClientRects().length&&x.firstElementChild?.textContent.includes(name));if(!e)throw Error('Missing field '+name);return e;},
  set(name,value){const e=this.field(name).querySelector('input,textarea');if(!e)throw Error('No editable input '+name);Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));},
  nav(name){const b=[...document.querySelector('aside nav').querySelectorAll('button')].find(x=>x.textContent.trim()===name);if(!b)throw Error('Missing settings nav '+name);b.click();}
}`;
const nativeEntry='#workflows-panel-library section[aria-label]';
async function open(page,locale='zh'){
  await page.goto('case=workflow&locale='+locale);
  await page.eval(helper);
  await page.waitFor('document.querySelector("#workflows-tab-library")');
  await page.eval('__ui.showLibrary()');
  await page.waitFor('document.querySelector("#workflows-panel-library").classList.contains("flex")');
  await page.waitFor('document.querySelector("#workflows-panel-library nav button")');
  await page.eval('__ui.open("资料整理流程")');
  await page.waitFor(`document.querySelector("${nativeEntry}")`);
}
await withAuditPage(here,async page=>{
  async function test(name,fn){try{await fn();check(name+': no JS exceptions',page.exceptions.length===0,page.exceptions.slice());}
    catch(e){errors.push(name+': '+(e.stack??e));console.error('HARNESS ERROR '+errors.at(-1));}}
  await test('single-surface-lazy-first-frame',async()=>{
    await page.goto('case=workflow&locale=zh');
    await page.waitFor('window.__audit?.apiCalls.includes("workflowEngine.list")');
    const first=await page.eval(`({
      nav:[...document.querySelectorAll('aside nav button')].filter(b=>/^(工作流|自动化)$/.test(b.textContent.trim())).map(b=>b.textContent.trim()),
      selected:document.querySelector('#workflows-tab-engines')?.getAttribute('aria-selected'),
      calls:window.__audit.apiCalls.slice(),
      libraryMounted:!!document.querySelector('#workflows-panel-library nav button')
    })`);
    check('single workflow entry instead of separate automation settings',first.nav.length===1&&first.nav[0]==='工作流',first.nav);
    check('native Node-RED canvas is the default work surface',first.selected==='true',first.selected);
    check('first canvas paint avoids hidden library/catalog/profiles IPC and DOM work',
      !first.libraryMounted && first.calls.includes('workflowEngine.list') &&
      !first.calls.some(c=>['workflow.list','workflow.nodeTypes','workflow.agentProfiles'].includes(c)),
      first);
    await page.eval(helper);
    await page.eval('__ui.showLibrary()');
    await page.waitFor('window.__audit.apiCalls.includes("workflow.list") && window.__audit.apiCalls.includes("workflow.nodeTypes") && window.__audit.apiCalls.includes("workflow.agentProfiles")');
    check('library and metadata load on first actual visit, not on app startup',
      await page.eval('!!document.querySelector("#workflows-panel-library nav button")'));
    const metadataBefore=await page.eval(`({
      catalog:window.__audit.apiCalls.filter(v=>v==='workflow.nodeTypes').length,
      profiles:window.__audit.apiCalls.filter(v=>v==='workflow.agentProfiles').length,
    })`);
    await page.eval('document.querySelector("#workflows-tab-engines").click()');
    await page.waitFor('document.querySelector("#workflows-tab-engines")?.getAttribute("aria-selected")==="true"');
    await page.eval('document.querySelector("#workflows-tab-library").click()');
    await page.waitFor('document.querySelector("#workflows-tab-library")?.getAttribute("aria-selected")==="true"');
    await page.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const metadataAfter=await page.eval(`({
      catalog:window.__audit.apiCalls.filter(v=>v==='workflow.nodeTypes').length,
      profiles:window.__audit.apiCalls.filter(v=>v==='workflow.agentProfiles').length,
    })`);
    check('returning to the canvas and library does not re-fetch cached metadata',
      metadataBefore.catalog===1 && metadataBefore.profiles===1 &&
      JSON.stringify(metadataBefore)===JSON.stringify(metadataAfter),
      {metadataBefore,metadataAfter});
  });

  await test('deep-link-focus-is-sticky',async()=>{
    await page.goto('case=focus&locale=zh');
    await page.waitFor('window.__audit?.focusId()===null');
    check('library stays visible after one-shot focus intent is consumed',
      await page.eval('document.querySelector("#workflows-panel-library")?.classList.contains("flex") && document.querySelector("#workflows-tab-library")?.getAttribute("aria-selected")==="true"'));
    await page.waitFor('document.querySelector("#workflows-panel-library nav button[aria-current=true]")');
    check('focused workflow selected instead of showing an unrelated canvas',
      await page.eval('document.querySelector("#workflows-panel-library nav button[aria-current=true]")?.textContent.includes("资料整理流程")'));
  });
  await test('native-library-reconciliation-warning',async()=>{
    await page.goto('case=mirror-lag&locale=zh');
    await page.waitFor('document.querySelector("#workflows-panel-engines [role=alert]")?.textContent.includes("2 份工作流")');
    const notice=await page.eval('document.querySelector("#workflows-panel-engines [role=alert]")?.textContent');
    check('Node-RED mirror divergence is visible in the ONE Mcode workflow workbench',
      notice?.includes("2 份工作流") && notice.includes("未同步"),notice);
  });
  await test('native-noop-reentry-does-not-reload-editor',async()=>{
    await page.goto('case=native-unchanged&locale=zh');
    await page.eval(helper);
    await page.waitFor('document.querySelector("#workflows-tab-library")');
    await page.eval('__ui.showLibrary()');
    await page.waitFor('document.querySelector("#workflows-panel-library nav button")');
    await page.eval('__ui.open("资料整理流程")');
    await page.waitFor("document.querySelector('#workflows-panel-library section[aria-label] button')");
    await page.eval("document.querySelector('#workflows-panel-library section[aria-label] button').click()");
    await page.waitFor('document.querySelector("#workflows-tab-engines")?.getAttribute("aria-selected")==="true"');
    check('same saved workflow navigates to existing canvas without native loaded event',
      await page.eval('__audit.nativeLoads.length===1 && __audit.nativeLoadEvents.length===0'));
  });
  await test('one-engine-legacy-migration-entry',async()=>{
    await page.goto('case=legacy-migration&locale=zh');
    await page.eval(helper);
    await page.eval('__ui.showLibrary()');
    await page.waitFor('document.querySelector("#workflows-panel-library nav button")');
    await page.eval('__ui.open("资料整理流程")');
    await page.waitFor('document.querySelector("#workflows-panel-library button")?.textContent.includes("迁移") || [...document.querySelectorAll("#workflows-panel-library button")].some(b=>b.textContent.includes("迁移旧工作流"))');
    check('legacy document offers an explicit one-way migration action, not a dual-engine selector',
      await page.eval(`[...document.querySelectorAll("#workflows-panel-library button")].some(b=>b.textContent.includes("迁移旧工作流到 Node-RED")) && !document.querySelector('select[aria-label="工作流执行引擎"]')`));
    check('legacy graph cannot falsely open an unowned Node-RED native editor',
      await page.eval(`!document.querySelector('${nativeEntry}') && [...document.querySelectorAll('#workflows-panel-library [role=status]')].some(e=>e.textContent.includes('历史工作流'))`));
    const buttonState = await page.eval(`(()=>{const b=[...document.querySelectorAll("#workflows-panel-library button")].find(b=>b.textContent.includes("迁移旧工作流到 Node-RED"));return {disabled:b?.disabled,visible:!!b?.getClientRects().length}})()`);
    await page.eval('[...document.querySelectorAll("#workflows-panel-library button")].find(b=>b.textContent.includes("迁移旧工作流到 Node-RED"))?.click()');
    await page.sleep(120);
    const migrationUi = await page.eval(`({pending:[...document.querySelectorAll("#workflows-panel-library [role=status]")].map(e=>e.textContent),actions:[...document.querySelectorAll("#workflows-panel-library button")].filter(e=>e.textContent.includes("迁移")).map(e=>({text:e.textContent,disabled:e.disabled})),saveDisabled:window.__ui?.button("保存")?.disabled})`);
    check('migration selection leaves an unsaved, explicit native ownership draft',
      buttonState.disabled===false && migrationUi.pending.some(e=>e.includes("保存后")) && migrationUi.saveDisabled===false,
      {buttonState,migrationUi});
    check('choosing migration changes only the unsaved draft and still requires Save',
      await page.eval('__audit.docs["audit-workflow"].engine==="mcode" && __audit.saves.length===0 && !__ui.button("保存").disabled'));
    await page.eval('__ui.button("保存").click()');
    await page.waitFor('__audit.saveAttempts.length===1 && [...document.querySelectorAll("#workflows-panel-library button")].some(b=>b.textContent.includes("我已阅读差异，确认继续迁移"))');
    check('backend migration gate blocks an unconfirmed engine change and leaves legacy ownership intact',
      await page.eval('__audit.docs["audit-workflow"].engine==="mcode" && __audit.saves.length===0 && __audit.saveAttempts[0].confirmEngineMigration!==true'));
    check('migration blocker is shown before the explicit confirmation action',
      await page.eval('[...document.querySelectorAll("#workflows-panel-library span")].some(e=>e.textContent.includes("迁移预检要求人工确认"))'));
    await page.eval('[...document.querySelectorAll("#workflows-panel-library button")].find(b=>b.textContent.includes("我已阅读差异，确认继续迁移"))?.click()');
    await page.waitFor('__audit.saves.length===1');
    check('confirmed legacy migration submits node-red ownership through the explicit confirmation flag',
      await page.eval(`__audit.saveAttempts.length===2 && __audit.saveAttempts[1].confirmEngineMigration===true && __audit.saves[0].engine==="node-red" && !!document.querySelector('[aria-label="当前工作流引擎"]')`));
  });
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
    // 点之前先把"现在引擎页是隐藏的"钉住 —— 否则下面那条"真的切过去了"在
    // **点之前就已经成立**（默认页签、或上一次 test 留下的状态），什么也没验。
    check('before clicking, the engine tab is NOT the active view',
      await page.eval('!document.querySelector("#workflows-panel-engines")?.classList.contains("flex")'));
    await page.eval(`document.querySelector('${nativeEntry} button').click()`);
    await page.waitFor('document.querySelector("#workflows-panel-engines")?.classList.contains("flex")');
    const panelProbe=await page.eval(`(()=>{
      const ids=[...document.querySelectorAll('[id*="panel-"]')].map(e=>e.id);
      const tabs=[...document.querySelectorAll('[role=tab]')].map(e=>({id:e.id,sel:e.getAttribute('aria-selected')}));
      return {ids,tabs,html:document.body.innerHTML.length};
    })()`);
    check('engine panel exists in the DOM after the click (id prefix did not drift)',
      await page.eval('!!document.querySelector("#workflows-panel-engines")'),
      {...panelProbe,exceptions:page.exceptions.slice()});
    check('native entry loads the selected B rather than previously selected A',await page.eval('__audit.nativeLoads.at(-1)==="audit-workflow-b"'));
    check('native entry really navigates to engine tab',await page.eval('document.querySelector("#workflows-panel-engines").classList.contains("flex")'));
    await page.screenshot('native-workflow-entry.png');
  });
  await test('library-save-and-drafts',async()=>{
    await open(page);
    await page.eval('__ui.set("名称","跨栏目草稿")');
    await page.sleep(120);
    check('unsaved draft enables explicit save',await page.eval('!__ui.button("保存").disabled'));
    // Switching the category stays within ONE settings destination and
    // keeps the draft in the shared library state instead of remounting
    // two independent workflow settings trees.
    check('only one workflow settings entry is visible',await page.eval(`[...document.querySelectorAll('aside nav button')].filter(b=>b.textContent.trim()==='工作流').length===1 && ![...document.querySelectorAll('aside nav button')].some(b=>b.textContent.trim()==='自动化')`));
    await page.eval(`[...document.querySelectorAll('#workflows-panel-library [role="group"] button')].find(b=>b.textContent.trim()==='自动化')?.click()`);
    await page.waitFor('document.querySelector("#workflows-panel-library nav button")?.textContent?.includes("文件清单自动化")');
    await page.eval(`[...document.querySelectorAll('#workflows-panel-library [role="group"] button')].find(b=>b.textContent.trim()==='工作流')?.click()`);
    await page.waitFor('document.querySelector("#workflows-panel-library").classList.contains("flex")');
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
    await page.eval('__ui.showLibrary()');
    await page.waitFor('document.querySelector("#workflows-panel-library").classList.contains("flex")');
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
    await page.waitFor('document.querySelector("#workflows-panel-library nav button")');
    check('legacy automation deep link routes into one workflow surface',
      await page.eval('document.querySelector("#workflows-panel-library").classList.contains("flex") && document.querySelector("#workflows-panel-engines").classList.contains("hidden") && ![...document.querySelectorAll("aside nav button")].some(b=>b.textContent.trim()==="自动化")'));
    check('legacy automation deep link activates automation category',
      await page.eval('[...document.querySelectorAll("#workflows-panel-library [role=group] button")].some(b=>b.textContent.trim()==="自动化" && b.getAttribute("aria-pressed")==="true")'));
    await page.eval(`(()=>{const b=[...document.querySelectorAll('#workflows-panel-library nav button')].find(e=>e.textContent.includes('文件清单自动化'));b?.click()})()`);
    await page.waitFor('document.querySelector("#workflows-panel-library section[aria-label]")');
    check('automation shares native editor entry',await page.eval('!!document.querySelector("#workflows-panel-library section[aria-label] button")'));
  });
});
const result={checks,errors,summary:{passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,errors:errors.length}};
writeFileSync(join(here,'fix-verification.json'),JSON.stringify(result,null,2));
console.log('T58 WORKFLOW UI SUMMARY '+JSON.stringify(result.summary));
if(result.summary.failed||errors.length)process.exitCode=1;
