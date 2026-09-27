import {withAuditPage} from './browser.mjs';
import {fileURLToPath} from 'node:url';
const results=[];
await withAuditPage(fileURLToPath(new URL('.',import.meta.url)),async page=>{
 const check=(name,ok,detail)=>{results.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}${ok||detail===undefined?'':' — '+JSON.stringify(detail)}`);};
 const J=JSON.stringify;
 const card=`document.querySelector('#root [role=dialog][aria-label$="正在提问"]')`;
 const q=(text,opts=['甲','乙'])=>({question:text,header:'H',multiSelect:false,options:opts.map(l=>({label:l,description:''}))});
 const seed=async(buckets)=>{await page.eval(`labStore.setState({pendingQuestionBySession:${J(buckets)}})`);await page.sleep(150);};
 const clickOption=async(label)=>page.eval(`(()=>{const b=[...${card}.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${J(label)}));if(!b)throw Error('no option '+${J(label)});b.click();})()`);
 const calls=(rid)=>page.eval(`labCalls.filter(c=>c.requestId===${J(rid)})`);
 const pending=()=>page.eval(`labStore.getState().pendingQuestionBySession`);
 const key=(target,init)=>page.eval(`(()=>{const t=${target};t.focus();t.dispatchEvent(new KeyboardEvent('keydown',Object.assign({bubbles:true,cancelable:true},${J(init)})));})()`);
 const typeInto=(sel,v)=>page.eval(`(()=>{const e=${sel};e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${J(v)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);

 await page.goto('', 'window.__ready && window.labStore');
 await page.sleep(500);
 const bootErrors=[...page.exceptions];
 if(bootErrors.length)console.log('boot-time page errors (mock bridges; informational): '+bootErrors.length);

 // ── 1. Side-chat dismiss must act on THIS pane's session, not activeSessionId.
 await seed({main:{questions:[q('主会话的问题？')],requestId:'rq-main'},side:{questions:[q('侧聊的问题？')],requestId:'rq-side'}});
 await page.waitFor(`${card} && ${card}.textContent.includes('侧聊的问题')`);
 await page.eval(`${card}.querySelector('button[aria-label="忽略这次提问"]').click()`);
 await page.sleep(250);
 const p1=await pending();
 check('★ dismiss in side pane resolves the side request (rq-side, dismissed)', (await calls('rq-side')).some(c=>c.sessionId==='side'&&c.dismissed===true), await page.eval('labCalls'));
 check('★ dismiss in side pane does NOT dismiss the parent (main) question', (await calls('rq-main')).length===0 && !!p1.main, {calls:await page.eval('labCalls'),pending:Object.keys(p1)});
 check('★ side question card is closed after dismiss', !p1.side && !(await page.eval(`!!${card}`)), Object.keys(p1));

 // ── 2. Double-clicking submit sends the answer once.
 await page.eval(`labRespondMode['rq-dbl']='slow'`);
 await seed({side:{questions:[q('只答一次？')],requestId:'rq-dbl'}});
 await page.waitFor(`${card} && ${card}.textContent.includes('只答一次')`);
 await clickOption('甲');
 await page.sleep(80);
 await page.eval(`(()=>{const b=[...${card}.querySelectorAll('button')].find(b=>b.textContent.trim()==='提交回答');b.click();b.click();})()`);
 await page.sleep(700);
 const dbl=await calls('rq-dbl');
 check('★ double click on submit → exactly one respondQuestion', dbl.length===1, dbl);
 check('control: that answer carried the picked option', dbl[0]?.answers?.['只答一次？']==='甲', dbl);

 // ── 3. A failed Enter-submit must not lock Enter for the retry.
 await page.eval(`labRespondMode['rq-retry']='fail-once'`);
 await seed({side:{questions:[q('失败后重试？')],requestId:'rq-retry'}});
 await page.waitFor(`${card} && ${card}.textContent.includes('失败后重试')`);
 const input=`${card}.querySelector('input[type=text]')`;
 await typeInto(input,'自定义回答');
 await page.sleep(60);
 await key(input,{key:'Enter'});
 await page.sleep(250);
 check('control: first Enter submitted (IPC failed, card kept for retry)', (await calls('rq-retry')).length===1 && await page.eval(`!!${card}`), await calls('rq-retry'));
 await key(input,{key:'Enter'});
 await page.sleep(250);
 const retry=await calls('rq-retry');
 check('★ second Enter retries the submit after the failure', retry.length===2, retry);
 check('control: retry succeeded and closed the card', !(await pending()).side);

 // ── 4. A NEW question replacing a pending one must start from a clean card.
 await seed({side:{questions:[q('旧问题？')],requestId:'rq-old'}});
 await page.waitFor(`${card} && ${card}.textContent.includes('旧问题')`);
 await clickOption('甲');
 await page.sleep(80);
 const before=page.exceptions.length;
 await seed({side:{questions:[q('新问题一？',['丙','丁']),q('新问题二？',['戊','己'])],requestId:'rq-new'}});
 await page.sleep(300);
 const newErrs=page.exceptions.slice(before).filter(e=>/selected|QuestionPrompt/i.test(e));
 check('★ replacing the pending question does not crash the card', newErrs.length===0 && await page.eval(`!!${card} && ${card}.textContent.includes('新问题一')`), {errs:newErrs.map(e=>e.split('\n')[0]),text:await page.eval(`${card}?.textContent?.slice(0,80)??null`)});
 check('★ replaced card starts at question 1/2 with no carried-over answers', await page.eval(`!!${card} && ${card}.textContent.includes('第 1/2 题') && ${card}.textContent.includes('0 / 2')`), await page.eval(`${card}?.textContent?.slice(0,160)??null`));
 await seed({});

 // ── 5. Pickers must not treat IME composition keys as picks.
 const host=`document.getElementById('ime-host')`;
 const openPicker=async(mode,ready)=>{await page.eval(`labPicks.length=0;__setPicker('none')`);await page.sleep(50);await page.eval(`__setPicker(${J(mode)})`);await page.waitFor(ready,5000);await page.sleep(200);};
 const picks=()=>page.eval('labPicks.map(p=>p.kind)');
 // FileMentionPicker (mention mode — the editor keeps focus).
 await openPicker('file',`document.querySelector('#pickers')?.textContent.includes('a.ts')`);
 await key(host,{key:'Enter',isComposing:true,keyCode:229});
 await key(host,{key:'Tab',isComposing:true,keyCode:229});
 await page.sleep(100);
 check('★ @ file picker ignores Enter/Tab while IME is composing', !(await picks()).includes('file'), await picks());
 await key(host,{key:'Enter'}); await page.sleep(100);
 check('control: @ file picker picks on a real Enter', (await picks()).includes('file'), await picks());
 // SlashCommandPicker.
 await openPicker('slash',`document.querySelector('#pickers [data-idx="0"]')`);
 await key(host,{key:'Enter',isComposing:true,keyCode:229});
 await page.sleep(100);
 check('★ / command picker ignores Enter while IME is composing', !(await picks()).some(k=>['command','skill','engine'].includes(k)), await picks());
 await key(host,{key:'Enter'}); await page.sleep(100);
 check('control: / command picker picks on a real Enter', (await picks()).some(k=>['command','skill','engine'].includes(k)), await picks());
 // LibraryPicker (has its own search input — pinyin uses Space/Enter to commit).
 await openPicker('library',`document.querySelector('#pickers')?.textContent.includes('Alpha')`);
 const libInput=`document.querySelector('#pickers input')`;
 await key(libInput,{key:' ',isComposing:true,keyCode:229});
 await key(libInput,{key:'Enter',isComposing:true,keyCode:229});
 await page.sleep(100);
 const libPicks=await page.eval('JSON.stringify(labPicks)');
 check('★ library picker ignores Space/Enter while IME is composing', !libPicks.includes('"library"') && await page.eval(`document.querySelector('#pickers [data-picker-mode=library]')!==null`), libPicks);
 await openPicker('library',`document.querySelector('#pickers')?.textContent.includes('Alpha')`);
 await key(libInput,{key:' '}); await key(libInput,{key:'Enter'}); await page.sleep(100);
 check('control: library picker toggles + confirms on real Space/Enter', (await page.eval('JSON.stringify(labPicks)')).includes('Alpha'), await page.eval('JSON.stringify(labPicks)'));
});
const failed=results.filter(r=>!r.ok).length;
console.log(`\n${results.length-failed}/${results.length} passed`);
if(failed)throw Error(`${failed} M22 assertions failed`);
