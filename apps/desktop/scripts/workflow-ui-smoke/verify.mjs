// Desired-behavior regression probes, intentionally red when an existing defect is reproduced.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { withAuditPage } from './browser.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const checks=[];const observations=[];const harnessErrors=[];
const check=(name,passes,detail)=>{checks.push({name,passes,detail});console.log(`${passes?'PASS':'FAIL'} ${name} ${detail===undefined?'':JSON.stringify(detail)}`);};
const observe=(name,detail)=>{observations.push({name,detail});console.log('OBSERVE '+name+' '+JSON.stringify(detail));};
const HELPERS=`window.__ui={
 visible:e=>e.getClientRects().length>0,
 button(text){return [...document.querySelectorAll('button')].find(e=>this.visible(e)&&e.textContent.trim()===text);},
 field(text){const f=[...document.querySelectorAll('div.mb-2.block.w-full')].find(e=>this.visible(e)&&e.firstElementChild?.textContent.includes(text));if(!f)throw new Error('Field missing: '+text);return f;},
 value(text){const f=this.field(text);return f.querySelector('input:not([type=hidden]),textarea')?.value ?? f.querySelector('[role=combobox]')?.textContent;},
 set(text,value){const el=this.field(text).querySelector('input:not([type=hidden]),textarea');if(!el)throw new Error('Editable field missing: '+text);el.focus();Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));},
 open(name){const nav=document.querySelector('[id$="-panel-library"] nav');const b=[...nav.querySelectorAll('button')].find(e=>e.textContent.includes(name));if(!b)throw new Error('Workflow row missing: '+name);b.click();},
 nav(text){const b=[...document.querySelector('aside nav').querySelectorAll('button')].find(e=>e.textContent.trim()===text);if(!b)throw new Error('Settings nav missing: '+text);b.click();},
 selectNode(title){const el=[...document.querySelectorAll('div[title]')].find(e=>e.getAttribute('title')===title&&e.classList.contains('absolute'));if(!el)throw new Error('Node missing: '+title);el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:10,clientY:10}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));},
 clearNode(){const el=document.querySelector('div.group.absolute[title]');if(!el)throw new Error('Canvas card missing');el.parentElement.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));}
};`;
await withAuditPage(here,async page=>{
 const open=async(scenario='workflow',name='资料整理流程')=>{await page.goto('case='+scenario);await page.eval(HELPERS);await page.waitFor(`document.querySelector('[id$="-panel-library"] nav button')`);await page.eval(`__ui.open(${JSON.stringify(name)})`);await page.waitFor('document.querySelector("div.group.absolute[title]")');await page.sleep(120);};
 const save=async()=>{const n=await page.eval('__audit.saves.length');await page.eval('__ui.button("保存").click()');await page.waitFor(`__audit.saves.length>${n}`);await page.waitFor('__ui.button("保存").disabled');await page.sleep(100);};
 const test=async(name,fn)=>{try{await fn();check(name+': renderer clean',page.exceptions.length===0,page.exceptions);}catch(e){harnessErrors.push({name,error:e.stack});console.error('HARNESS ERROR '+name+': '+e.stack);try{await page.screenshot('fix-error-'+name+'.png');writeFileSync(join(here,'fix-error-'+name+'.json'),JSON.stringify(await page.eval('({text:document.body.innerText,inputs:[...document.querySelectorAll("input,textarea")].map(x=>({value:x.value,outer:x.outerHTML}))})'),null,2));}catch{}}};
 await test('framework-save',async()=>{
  await open();await page.eval('__ui.set("框架","框架说明保存回归")');await page.sleep(100);
  check('framework enables Save',await page.eval('!__ui.button("保存").disabled'));
  await page.eval('document.dispatchEvent(new KeyboardEvent("keydown",{key:"s",ctrlKey:true,bubbles:true}))');await page.waitFor('__audit.saves.length===1');await page.waitFor('__ui.button("保存").disabled');
  check('Ctrl+S persists framework note',await page.eval('__audit.docs["audit-workflow"].frameworkNote')==='框架说明保存回归');
  await page.eval('__ui.button("代理档案").click()');await page.sleep(50);await page.eval('document.dispatchEvent(new KeyboardEvent("keydown",{key:"s",ctrlKey:true,bubbles:true}))');await page.sleep(50);
  check('hidden editor does not save from another tab',await page.eval('__audit.saves.length')===1);
  await page.eval('__ui.button("工作流库").click()');await page.sleep(50);
  const ax=await page.send('Accessibility.getFullAXTree');const unnamed=ax.nodes.filter(n=>!n.ignored&&['textbox','combobox'].includes(n.role?.value)&&!n.name?.value);
  check('visible form inputs have accessible names',unnamed.length===0,unnamed.map(n=>n.role?.value));
 });
 await test('draft-navigation',async()=>{
  await open();await page.eval('__ui.set("名称","跨栏目草稿")');await page.sleep(80);await page.eval('__ui.nav("自动化")');await page.waitFor('document.getElementById("automation-panel-library")');await page.eval('__ui.nav("工作流")');await page.waitFor('document.querySelector("#workflows-panel-library nav button")');await page.eval('__ui.open("资料整理流程")');await page.waitFor('document.querySelector("div.group.absolute[title]")');
  check('draft survives settings unmount',await page.eval('__ui.value("名称")')==='跨栏目草稿');
  check('draft is not auto-saved',await page.eval('__audit.saves.length')===0);
  await page.eval('__ui.button("放弃改动").click()');await page.waitFor('document.querySelector("div.group.absolute[title]")');await page.sleep(80);
  check('explicit discard restores saved version',await page.eval('__ui.value("名称")')==='资料整理流程');
 });
 await test('save-races',async()=>{
  await open();await page.eval('window.__originalSave=__apiImpl.workflow.save;__apiImpl.workflow.save=async x=>{await new Promise(r=>window.__releaseSave=r);return __originalSave(x)}');
  await page.eval('__ui.set("名称","saved-A")');await page.sleep(80);await page.eval('__ui.button("保存").click()');await page.waitFor('window.__releaseSave');
  await page.eval('__ui.set("框架","继续输入，不应被保存返回覆盖")');await page.sleep(80);await page.eval('__ui.open("第二条普通工作流")');await page.sleep(100);await page.eval('__ui.set("名称","dirty-B")');await page.sleep(80);await page.eval('__releaseSave()');await page.waitFor('__audit.saves.length===1');await page.sleep(250);
  check('saving A does not replace B editor',await page.eval('__ui.value("名称")')==='dirty-B');
  await page.eval('__ui.open("saved-A")');await page.sleep(130);
  check('edits made during save survive navigation',await page.eval('__ui.value("框架")')==='继续输入，不应被保存返回覆盖');
  check('later unsaved edits remain dirty',await page.eval('!__ui.button("保存").disabled'));
  await page.eval('__ui.open("第二条普通工作流")');await page.sleep(130);
  check('A save does not delete B draft',await page.eval('__ui.value("名称")')==='dirty-B');
 });
 await test('save-completion-after-remount',async()=>{
  await open();await page.eval('window.__oldSave=__apiImpl.workflow.save;__apiImpl.workflow.save=async x=>{await new Promise(r=>window.__releaseOldSave=r);return __oldSave(x)}');
  await page.eval('__ui.set("名称","pending-save-A")');await page.sleep(80);await page.eval('__ui.button("保存").click()');await page.waitFor('window.__releaseOldSave');
  await page.eval('__ui.nav("自动化")');await page.waitFor('document.getElementById("automation-panel-library")');await page.eval('__ui.nav("工作流")');await page.waitFor('document.querySelector("#workflows-panel-library nav button")');await page.eval('__ui.open("资料整理流程")');await page.waitFor('document.querySelector("div.group.absolute[title]")');
  await page.eval('__ui.set("框架","新实例的草稿，不准被旧保存清掉")');await page.sleep(80);await page.eval('__ui.nav("自动化")');await page.waitFor('document.getElementById("automation-panel-library")');
  await page.eval('__releaseOldSave()');await page.waitFor('__audit.saves.length===1');await page.sleep(150);
  await page.eval('__ui.nav("工作流")');await page.waitFor('document.querySelector("#workflows-panel-library nav button")');await page.eval('__ui.open("pending-save-A")');await page.waitFor('document.querySelector("div.group.absolute[title]")');
  check('late save from unmounted editor preserves newer instance draft',await page.eval('__ui.value("框架")')==='新实例的草稿，不准被旧保存清掉');
 });
 await test('failed-save',async()=>{
  await open();await page.eval('__apiImpl.workflow.save=async()=>({ok:false,error:"保存被注入阻断"})');await page.eval('__ui.set("名称","失败仍保留")');await page.sleep(80);await page.eval('__ui.button("保存").click()');await page.waitFor('document.body.innerText.includes("保存被注入阻断")');
  check('failed save remains dirty',await page.eval('!__ui.button("保存").disabled'));
  await page.eval('__ui.open("第二条普通工作流")');await page.sleep(100);await page.eval('__ui.open("资料整理流程")');await page.sleep(100);
  check('failed-save draft is retained',await page.eval('__ui.value("名称")')==='失败仍保留');
 });
 await test('automation-versions-and-selection',async()=>{
  await open('automation','文件清单自动化');await page.eval('__ui.selectNode("入口 A")');await page.sleep(80);
  const inspector=await page.eval('[...document.querySelectorAll("aside")].filter(e=>e.getClientRects().length>0).at(-1).innerText');
  check('manual trigger hides inactive cron/file/event fields',!inspector.includes('定时表达式')&&!inspector.includes('监听哪些文件')&&!inspector.includes('听哪些事件'));
  await page.eval('__ui.set("这次要做什么","已修改请求A")');await page.sleep(80);await page.eval('__ui.clearNode()');await page.sleep(100);
  check('dirty automation blocks manual execution',await page.eval('__ui.button("立刻运行一次").disabled'));
  await page.eval('__ui.button("立刻运行一次").click()');check('blocked execution sends no request',await page.eval('__audit.runCalls.length')===0);
  await save();await page.waitFor('!__ui.button("立刻运行一次").disabled');
  await page.eval('const s=document.querySelector("select[aria-label=选择试跑入口]");s.value="trigger-b";s.dispatchEvent(new Event("change",{bubbles:true}))');await page.sleep(60);await page.eval('__ui.button("立刻运行一次").click()');await page.waitFor('__audit.runCalls.length===1');
  check('second trigger can be chosen for manual run',await page.eval('__audit.runCalls[0].triggerNodeId')==='trigger-b');
  check('one unified history heading',await page.eval('[...document.querySelectorAll("h3")].filter(e=>e.textContent==="运行历史").length')===1);
  await page.eval('__audit.completeRun()');await page.waitFor('document.querySelector("[data-run-status=success]")',5000);
  check('completion appears without manual refresh',await page.eval('!!document.querySelector("[data-run-status=success]")'));
  await page.screenshot('fixed-automation.png');
 });
 await test('canonical-trigger-and-deletion',async()=>{
  await open('automation','文件清单自动化');await page.eval('__ui.selectNode("入口 A")');await page.sleep(80);await page.eval('__ui.field("触发方式").querySelector("[role=combobox]").click()');await page.waitFor('[...document.querySelectorAll("[role=option]")].some(e=>e.textContent.trim()==="定时")');await page.eval('[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.trim()==="定时").click()');await page.sleep(80);
  check('schedule reveals cron field',await page.eval('!!__ui.field("定时表达式")'));await save();await page.eval('__ui.clearNode()');await page.sleep(100);
  check('saved trigger summary shows schedule',await page.eval('document.querySelector("[data-automation-trigger=trigger-a]").innerText.includes("定时")'));
  await page.eval('__ui.set("框架","检查派生值回写")');await page.sleep(80);await save();
  check('subsequent save carries canonical trigger',await page.eval('__audit.saves.at(-1).trigger')==='schedule');
  await page.eval('__ui.selectNode("入口 B")');await page.sleep(80);check('extra trigger has delete action',await page.eval('!!__ui.button("删除节点")'));await page.eval('__ui.button("删除节点").click()');await page.sleep(80);await save();
  check('extra trigger can be removed',await page.eval('__audit.docs["audit-automation"].nodes.filter(n=>n.type==="mcode.trigger").length')===1);
  await page.eval('__ui.selectNode("入口 A")');await page.sleep(80);check('last trigger stays protected',await page.eval('!__ui.button("删除节点")'));
 });
 await test('disabled-trigger-manual',async()=>{
  await open('automation','文件清单自动化');await page.eval('__ui.selectNode("入口 A")');await page.sleep(80);await page.eval('__ui.field("启用").querySelector("[role=switch]").click()');await page.sleep(80);await save();await page.eval('__ui.clearNode()');await page.sleep(100);
  check('automatic disable is saved',await page.eval('__audit.docs["audit-automation"].nodes[0].params.enabled')===false);
  check('manual bypass of automatic disable is preserved',await page.eval('!__ui.button("立刻运行一次").disabled'));await page.eval('__ui.button("立刻运行一次").click()');await page.waitFor('__audit.runCalls.length===1');
 });
 for(const which of ['profiles-error','automation-error'])await test(which,async()=>{
  if(which==='profiles-error'){await page.goto('case='+which);await page.eval(HELPERS);await page.eval('__ui.button("代理档案").click()');await page.waitFor('document.body.innerText.includes("档案读取失败")');check('profile error is not empty data',!(await page.eval('document.getElementById("workflows-panel-profiles").innerText')).includes('还没有档案'));await page.eval('__apiImpl.workflow.agentProfiles=async()=>({profiles:[],problems:[]})');}
  else{await open(which,'文件清单自动化');await page.waitFor('document.body.innerText.includes("运行历史读取失败")');check('history error is not never-run',!await page.eval('document.body.innerText.includes("还没跑过")'));await page.eval('__apiImpl.automation.runs=async()=>({runs:[]});__apiImpl.automation.statusAll=async()=>[]');}
  await page.eval('__ui.button("重试").click()');await page.sleep(180);check(which+' can recover',!await page.eval('document.body.innerText.includes("读取失败")'));
 });
 await test('canvas-editing-layout',async()=>{
  await open();await page.eval('document.querySelector("div.group.absolute[title]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');await page.sleep(80);
  check('keyboard can select a node',await page.eval('document.querySelector("div.group.absolute[aria-pressed=true]")!==null'));
  await page.eval('__ui.clearNode()');await page.sleep(80);
  const overlap=await page.eval(`(()=>{const a=[...document.querySelectorAll('svg text')].map(e=>e.getBoundingClientRect());let n=0;for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++)if(Math.min(a[i].right,a[j].right)>Math.max(a[i].left,a[j].left)&&Math.min(a[i].bottom,a[j].bottom)>Math.max(a[i].top,a[j].top))n++;return n})()`);
  check('edge labels no longer overlap',overlap===0,overlap);
  await page.eval('document.querySelector("svg g[role=button]").dispatchEvent(new MouseEvent("click",{bubbles:true}))');await page.sleep(80);
  check('selecting an edge does not delete it',await page.eval('document.querySelectorAll("svg g[role=button]").length')===8);
  await page.eval('__ui.button("删除选中连线").click()');await page.sleep(80);check('explicit edge delete works',await page.eval('document.querySelectorAll("svg g[role=button]").length')===7);
  await page.eval('__ui.button("撤销").click()');await page.sleep(80);check('undo restores edge',await page.eval('document.querySelectorAll("svg g[role=button]").length')===8);
  await page.eval('__ui.button("重做").click()');await page.sleep(80);check('redo deletes edge again',await page.eval('document.querySelectorAll("svg g[role=button]").length')===7);
  await page.eval('__ui.button("撤销").click()');await page.sleep(80);check('undo to baseline is clean',await page.eval('__ui.button("保存").disabled'));
  await page.screenshot('fixed-workflow-1440.png');await page.size(1024,768);await page.sleep(200);
  const width=await page.eval('document.querySelector("[data-workflow-viewport]").getBoundingClientRect().width');check('minimum window has usable canvas width',width>=400,{width});
  await page.eval('__ui.button("适应画布").click()');await page.sleep(100);check('fit adjusts zoom',await page.eval('document.querySelector("output").textContent')!=='100%');await page.screenshot('fixed-workflow-1024.png');
  await page.eval(`(()=>{const c=document.querySelector('div.group.absolute[title]');const r=c.getBoundingClientRect();window.__dragBefore=parseFloat(c.style.left);window.__dragZoom=new DOMMatrix(getComputedStyle(c.parentElement).transform).a;const x=r.left+15,y=r.top+15;c.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:x,clientY:y}));document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x+40,clientY:y}));document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0,clientX:x+40,clientY:y}));})()`);await page.sleep(100);
  check('drag coordinates account for zoom',await page.eval('Math.abs(parseFloat(document.querySelector("div.group.absolute[title]").style.left)-__dragBefore-40/__dragZoom)<1'));
  await page.eval('document.dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true,cancelable:true}))');await page.sleep(100);
  check('Ctrl+Z undoes graph drag',await page.eval('Math.abs(parseFloat(document.querySelector("div.group.absolute[title]").style.left)-__dragBefore)<1'));
  await page.eval('__ui.clearNode()');await page.sleep(80);
  check('text editing keeps native undo',await page.eval('(()=>{const el=__ui.field("框架").querySelector("textarea");const e=new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true,cancelable:true});el.dispatchEvent(e);return !e.defaultPrevented})()'));

  await page.size(1440,900);await page.eval('__ui.selectNode("汇总结果")');await page.sleep(80);const codeText=await page.eval('[...document.querySelectorAll("aside")].filter(e=>e.getClientRects().length>0).at(-1).innerText');check('Code form labels follow Chinese locale',codeText.includes('运行语言')&&codeText.includes('输入 JSON')&&!codeText.includes('Timeout (ms)'));await page.screenshot('fixed-code-node.png');
  check('no auto-save promise remains',!await page.eval('document.body.innerText.includes("改动会自动保存")'));
 });
 await test('dark-english',async()=>{
  await page.size(1440,900);await page.goto('case=workflow&theme=dark&locale=en');await page.eval(HELPERS);await page.waitFor('document.querySelector("#workflows-panel-library nav button")');await page.eval('__ui.open("资料整理流程")');await page.waitFor('document.querySelector("div.group.absolute[title]")');await page.eval('__ui.selectNode("汇总结果")');await page.sleep(100);
  const text=await page.eval('[...document.querySelectorAll("aside")].filter(e=>e.getClientRects().length>0).at(-1).innerText');
  check('Code labels follow English locale',text.includes('Language')&&text.includes('Input JSON'));
  check('dark theme remains active',await page.eval('document.documentElement.classList.contains("dark")'));
  await page.screenshot('fixed-workflow-dark-en.png');
 });
});
const result={checks,observations,harnessErrors,summary:{passed:checks.filter(c=>c.passes).length,failed:checks.filter(c=>!c.passes).length,harnessErrors:harnessErrors.length}};
writeFileSync(join(here,'fix-verification.json'),JSON.stringify(result,null,2));console.log('FIX UI SUMMARY '+JSON.stringify(result.summary));process.exitCode=harnessErrors.length||checks.some(c=>!c.passes)?1:0;
