import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withAuditPage} from './browser.mjs';
const dir=dirname(fileURLToPath(import.meta.url)),results=[];
await withAuditPage(dir,async page=>{
 const go=async q=>{await page.goto((q||'').replace(/^\?/,''),'window.__ready && document.querySelector("#root main")');await page.sleep(220);};
 const click=async expr=>{await page.eval(`(()=>{const e=${expr};if(!e)throw Error('Missing control');e.click()})()`);await page.sleep(170);};
 const btn=text=>`[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null&&e.textContent.trim()===${JSON.stringify(text)})`;
 const open=async()=>click(btn('记忆与交接'));
 const injection=async()=>click(`[...document.querySelectorAll('summary')].find(e=>/自动记忆注入|Automatic memory/.test(e.textContent))`);
 const receipt=async name=>click(`[...document.querySelectorAll('[data-memory-receipt] summary')].find(e=>e.textContent.includes(${JSON.stringify(name)}))`);
 // 失败时把当时的页面文本一并留下(截断)。只有截图的话,要么得把 png 传出去看,要么
 // 只能靠重跑碰运气 —— 而这套里最容易出问题的恰恰是时序,重跑往往就好了。
 const test=async(name,fn)=>{try{await fn();assert.deepEqual(page.exceptions,[]);results.push({name,ok:true});console.log('PASS '+name);}catch(e){const seen=(await page.eval('document.body.innerText').catch(()=>'(unreadable)')).slice(0,1200);results.push({name,ok:false,error:String(e),seen});console.log('FAIL '+name+' '+String(e));console.log('---- body ----\n'+seen+'\n---- /body ----');}await page.screenshot(name+'.png');};
 await test('actual-captured-content-not-current-disk-and-escaped-as-text',async()=>{
  await go();await open();await injection();await receipt('Main A');
  assert.match(await page.eval('document.body.innerText'),/CAPTURED_ORIGINAL_A/);
  assert.doesNotMatch(await page.eval('document.body.innerText'),/LATEST_DISK_CONTENT/);
  assert.equal(await page.eval("labCalls.filter(e=>e.method==='memory-read').length"),0);
  assert.equal(await page.eval("document.querySelectorAll('[data-memory-receipt] img').length"),0);
 });
 await test('node-off-is-not-presented-as-a-permission-ban',async()=>{
  await go();await open();await injection();await receipt('Reference auditor');
  const text=await page.eval('document.body.innerText');assert.match(text,/开关关闭/);assert.match(text,/不禁止|仍可/);assert.match(text,/audit/);
 });
 await test('failed-start-is-not-labelled-successfully-submitted',async()=>{
  await go();await open();await injection();await receipt('Failed attempt');
  const text=await page.eval("document.querySelector('[data-memory-receipt=\"a-failed\"]').innerText");
  assert.match(text,/未能启动/);assert.doesNotMatch(text,/已提交到引擎/);
 });
 await test('read-error-visible-and-retryable',async()=>{
  await go('?fail');await open();assert.match(await page.eval('document.body.innerText'),/fixture memory inspection unavailable/);
  await page.eval('labFailRead=false');await click(btn('重试'));await injection();await receipt('Main A');
  assert.match(await page.eval('document.body.innerText'),/CAPTURED_ORIGINAL_A/);
 });
 await test('session-switch-and-delayed-response-cannot-leak-old-receipts',async()=>{
  await go();await open();await injection();await page.eval("labHold.add('chat-A')");
  await click(btn('刷新'));await page.eval("labPatchState({sessionId:'chat-B',activeSessionId:'chat-B',activeProjectId:'B'})");
  // 切会话会**关掉面板**(MemoryAssistantButton 的 [sessionId] effect 里 setOpen(false))。
  // 原来这里是 sleep(200):机器一忙就不够,于是下面那次 open 落在面板还开着的时候 ——
  // 点上去是**关**,后面自然什么都找不到,报出来却是"没看到 Main B",看着像产品坏了。
  await page.waitFor("!document.querySelector('[data-memory-receipt]')");
  await open();await injection();
  // B 的回执先真的到位,再放 A 那条延迟响应 —— 否则量到的是"B 还没来",不是"A 泄漏了"。
  await page.waitFor("document.body.innerText.includes('Main B')");
  await page.eval('labHolds.splice(0).forEach(r=>r())');
  // ⚠️ 这一段 sleep 是**故意**留的,不能换成 waitFor:它要给泄漏一个发生的机会,
  // 然后再断言它没发生。等一个"不该出现的东西出现"是等不到的。
  await page.sleep(160);
  assert.match(await page.eval('document.body.innerText'),/Main B/);assert.doesNotMatch(await page.eval('document.body.innerText'),/Main A|CAPTURED_ORIGINAL_A/);
 });
 await test('empty-receipts-explain-process-lifetime-and-do-not-query-library',async()=>{
  await go();await page.eval("labReceipts['chat-A']=[]");await open();await injection();
  assert.match(await page.eval('document.body.innerText'),/暂无|还没有/);assert.match(await page.eval('document.body.innerText'),/启动|重启/);
 });
 await test('library-distinguishes-scope-history-and-instructions',async()=>{
  await go('?view=library');await page.waitFor("document.body.innerText.includes('Reference')");
  const text=await page.eval('document.body.innerText');assert.match(text,/当前项目.*全局/);assert.match(text,/聊天历史/);assert.match(text,/全局指令/);assert.match(text,/不改变|不会改变/);
 });
 await test('legacy-on-switch-agrees-with-runtime-and-remains-editable',async()=>{
  await go('?view=param&value=on');assert.equal(await page.eval("document.querySelector('[role=switch]').getAttribute('aria-checked')"),'true');
  await click("document.querySelector('[role=switch]')");assert.equal(await page.eval('labValue'),false);
 });
 await test('new-node-memory-switch-keeps-default-off-and-has-specific-label',async()=>{
  await go('?view=param&value=false');assert.equal(await page.eval("document.querySelector('[role=switch]').getAttribute('aria-checked')"),'false');
  assert.match(await page.eval('document.body.innerText'),/本步骤.*项目.*全局/);
 });
 await test('role-picker-labels-once-only-snapshot-without-merging-choices',async()=>{
  await go('?view=picker');await page.waitFor("document.body.innerText.includes('Auditor')");
  const choices=await page.eval("[...document.querySelectorAll('button')].filter(e=>e.textContent.includes('Auditor')).map(e=>({text:e.textContent,title:e.title}))");
  assert.equal(choices.length,2);assert.match(choices[1].text,/一次性|创建快照/);assert.match(choices[1].title,/第一轮|首轮/);
  await click("[...document.querySelectorAll('button')].filter(e=>e.textContent.includes('Auditor'))[1]");assert.deepEqual(await page.eval('labPicks'),[{id:'auditor',memory:true}]);
 });
 await test('english-memory-controls-use-translated-scope-and-policy',async()=>{
  await go('?view=param&value=false&lang=en');assert.match(await page.eval('document.body.innerText'),/project.*global/i);assert.doesNotMatch(await page.eval('document.body.innerText'),/注入记忆/);
 });
});
const failed=results.filter(r=>!r.ok).length;writeFileSync(join(dir,'results.json'),JSON.stringify({passed:results.length-failed,failed,checks:results},null,2));
console.log(`${results.length-failed}/${results.length} memory injection UI checks passed; ${failed} failed`);if(failed)throw Error(`${failed} UI checks failed; artifacts: ${dir}`);
