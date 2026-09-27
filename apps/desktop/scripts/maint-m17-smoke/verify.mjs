import {withAuditPage} from './browser.mjs';
import {fileURLToPath} from 'node:url';
const results=[];
const A='global/facts/a.md', B='global/facts/b.md';
await withAuditPage(fileURLToPath(new URL('.',import.meta.url)),async page=>{
 const check=(name,ok,detail)=>{results.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}${ok||detail===undefined?'':' — '+JSON.stringify(detail)}`);};
 const J=JSON.stringify;
 const clickSel=async(expr)=>{const rect=await page.eval(`(()=>{const e=${expr};if(!e)throw Error('Missing element');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});await page.sleep(120);};
 const byText=(t,scope='document')=>`[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${J(t)}))`;
 const editor='document.querySelector(\'textarea[aria-label="Memory editor test input"]\')';
 const box=(p)=>`document.querySelector('input[type=checkbox][aria-label=${J('勾选待删除：'+p)}]')`;
 const confirmDelete=async()=>{
   const info=await page.eval(`(()=>{const btns=[...document.querySelectorAll('[role=dialog] button, [role=alertdialog] button')];const b=btns.find(b=>b.textContent.trim()==='删除');if(b)b.click();return {clicked:!!b,texts:btns.map(b=>b.textContent.trim())};})()`);
   if(!info.clicked)console.log('confirm button not found; dialog buttons: '+JSON.stringify(info.texts));
   await page.sleep(300);
 };
 const setEditor=async(v)=>{await page.eval(`(()=>{const e=${editor};e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${J(v)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await page.sleep(80);};

 await page.goto('', 'window.__ready && document.querySelector(\'button[title="global/facts/a.md"]\')');
 // 1. Unsaved draft on A, then move to B (the draft is retained, A is no longer "the dirty editor").
 await clickSel(`document.querySelector('button[title=${J(A)}]')`);
 await page.waitFor(`${editor} && !${editor}.readOnly && ${editor}.value==='saved A'`);
 await setEditor('unsaved A — not on disk yet');
 await clickSel(`document.querySelector('button[title=${J(B)}]')`);
 await page.waitFor(`${editor} && ${editor}.value==='saved B'`);
 // 2. Open the review panel; A and B are a duplicate pair.
 await clickSel(byText('整理记忆'));
 await page.waitFor(`${box(A)} && ${box(B)}`);
 check('★ A (has unsaved draft) cannot be ticked for deletion', await page.eval(`${box(A)}.disabled`));
 check('★ review row says A has an unsaved draft', await page.eval(`document.body.innerText.includes('未保存的编辑草稿')`));
 check('control: B (no draft) can be ticked', await page.eval(`!${box(B)}.disabled`));
 // 3. Try to delete A anyway.
 await clickSel(box(A));
 const delEnabled=await page.eval(`!(${byText('删除所选')}).disabled`);
 check('★ delete button stays disabled with A targeted', !delEnabled);
 if(delEnabled){
   await clickSel(byText('删除所选'));
   await page.waitFor(`document.querySelector('[role=dialog]')`);
   await confirmDelete();
   await page.sleep(400);
 }
 check('★ A was not deleted from disk (mock)', await page.eval(`!labDeleted.includes(${J(A)}) && !!labMemory[${J(A)}]`), await page.eval('labDeleted'));
 // 4. Control: deleting B (no draft) still works end to end.
 await page.eval(`(()=>{const e=${box(A)};if(e.checked){e.click();}})()`); await page.sleep(80);
 await clickSel(box(B));
 await page.waitFor(`!(${byText('删除所选')}).disabled`, 3000).catch(()=>{});
 const bEnabled=await page.eval(`!(${byText('删除所选')}).disabled`);
 check('control: delete enabled for B alone', bEnabled);
 if(bEnabled){
   await clickSel(byText('删除所选'));
   await page.waitFor(`document.querySelector('[role=dialog]')`);
   await confirmDelete();
   await page.waitFor(`labDeleted.includes(${J(B)})`, 5000).catch(()=>{});
 }
 check('control: B deleted through the review flow', await page.eval(`labDeleted.includes(${J(B)})`), await page.eval('labDeleted'));
 // 5. The draft on A is still there.
 let draftOk=false;
 try{
   await clickSel(`document.querySelector('button[title=${J(A)}]')`);
   await page.sleep(200);
   draftOk=await page.eval(`${editor}?.value==='unsaved A — not on disk yet'`);
 }catch{ draftOk=false; }
 check('A still listed and its draft intact in the editor', draftOk);
 check('no uncaught page errors', page.exceptions.length===0, page.exceptions);
});
const failed=results.filter(r=>!r.ok).length;
console.log(`\n${results.length-failed}/${results.length} passed`);
if(failed)throw Error(`${failed} M17 assertions failed`);
