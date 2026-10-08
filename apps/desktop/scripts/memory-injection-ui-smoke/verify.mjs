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
 await test('picker-ignores-ime-composition-enter-then-picks-on-plain-enter',async()=>{
  // 中文输入法里敲拼音、按回车**确认候选词**时,keydown 带 isComposing=true —— 那不是
  // "选定并关闭",而是输入法自己的按键。四个选择器(FileMention/Library/Slash/NewSubChat)
  // 走同一套键盘处理,前三处都挡了 IME,NewSubChatPicker 漏了 → 用户用拼音选档案时
  // 一确认候选词就把子对话建了出来(点都没点)。
  await go('?view=picker');await page.waitFor("document.body.innerText.includes('Auditor')");
  await page.eval("labPicks.length=0");
  await page.eval("document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))");await page.sleep(160);
  assert.deepEqual(await page.eval('labPicks'),[]);
  await page.eval("document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");await page.sleep(160);
  assert.equal(await page.eval('labPicks.length'),1);
 });
 await test('multi-ref-collapsed-summary-joins-with-locale-separator',async()=>{
  // 收起的那一行把选中的一组名字拼起来给用户看。分隔符**必须跟语言走**(中文「、」英文
  // ", ")—— 与 MessageBlocks / ChatPane / store 里那条 `locale === 'en' ? ', ' : '、'`
  // 同一条规矩。这里从前的实现是硬编码 `join("、")`,于是英文界面显示 "pdf、docx"。
  await go('?view=mref&lang=en');await page.waitFor("document.body.innerText.includes('pdf')");
  const text=await page.eval('document.body.innerText');
  assert.match(text,/pdf, docx/);
  assert.doesNotMatch(text,/pdf、docx/);
 });
 await test('composer-chip-tooltips-follow-locale-not-hardcoded-english',async()=>{
  // 输入框上思考级别 / 权限模式两颗 chip 的悬停说明此前是**硬编码英文**
  // (`title="Reasoning effort for the next session"` / `"Permission mode for the
  // next session"`),中文界面里冒纯英文。现在走 chat.effort.triggerTitle /
  // chat.permission.triggerTitle。判据:标题必须跟着语言走。
  const titles=async()=>page.eval("Array.from(document.querySelectorAll('[data-chip-fixture] [title]')).map(e=>e.title)");
  await go('?view=chips');await page.waitFor("document.querySelectorAll('[data-chip-fixture] [title]').length===2");
  const zh=await titles();
  assert.deepEqual(zh,['下一个会话的思考级别','下一个会话的权限模式']);
  await go('?view=chips&lang=en');await page.waitFor("document.querySelectorAll('[data-chip-fixture] [title]').length===2");
  const en=await titles();
  assert.deepEqual(en,['Reasoning effort for the next session','Permission mode for the next session']);
  // 中文界面里**不许**再漏出那句英文原话。
  assert.doesNotMatch(zh.join('|'),/Reasoning effort for the next session/);
 });
 await test('markdown-preview-banners-follow-locale-not-bilingual-hardcode',async()=>{
  // 资料库 Markdown 预览的两条横幅此前是**硬编码中英双语**拼在一起
  // (`"Markdown 预览失败 / Preview failed: …"` 与 `"部分图片无法读取（文件缺失或读取受限）
  // / Some images could not be loaded: …"`),于是中文界面里一条红字里冒出半句英文。
  // 现在走 library.preview.crepeFailed / library.preview.imagesFailed。
  // 判据:每条横幅**只**出现当前语言那一句,不许再出现另一语言,也不许出现 " / " 拼装。
  const statusText=async()=>page.eval("(document.querySelector('[data-md-preview] [role=status]')||{}).textContent||''");
  await go('?view=mdpreview');await page.waitFor("document.querySelector('[data-md-preview] [role=status]')");
  const zhStatus=await statusText();
  assert.match(zhStatus,/部分图片无法读取/);
  assert.doesNotMatch(zhStatus,/Some images could not be loaded|\/ Preview failed/);
  await go('?view=mdpreview&lang=en');await page.waitFor("document.querySelector('[data-md-preview] [role=status]')");
  const enStatus=await statusText();
  assert.match(enStatus,/Some images could not be loaded/);
  assert.doesNotMatch(enStatus,/部分图片无法读取/);
 });
 await test('markdown-preview-failure-banner-follows-locale',async()=>{
  const alertText=async()=>page.eval("(document.querySelector('[data-md-preview] [role=alert]')||{}).textContent||''");
  await go('?view=mdpreview&crepefail');await page.waitFor("document.querySelector('[data-md-preview] [role=alert]')");
  const zhAlert=await alertText();
  assert.match(zhAlert,/Markdown 预览失败/);assert.doesNotMatch(zhAlert,/Preview failed|Markdown 预览失败 \/ /);
  await go('?view=mdpreview&crepefail&lang=en');await page.waitFor("document.querySelector('[data-md-preview] [role=alert]')");
  const enAlert=await alertText();
  assert.match(enAlert,/Preview failed/);assert.doesNotMatch(enAlert,/Markdown 预览失败/);
 });
 await test('receipt-turn-and-node-labels-follow-locale-not-hardcoded-english',async()=>{
  // 回执一行里「第 N 轮」「节点：X」此前是**硬编码英文**(`· turn ${n}` / `node: ${id}`),
  // 而同一行里的 phase 标签走 t()。中文界面里于是冒出 "已提交到引擎 · turn 2" 这种中英混排。
  // 判据:这两个标签必须跟着语言走。
  const nodeReceipt='document.querySelector(\'[data-memory-receipt="a-node"] summary\')';
  const openAny=async()=>click("[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null&&/记忆与交接|Memory and handoff/.test(e.textContent))");
  await go();await open();await injection();
  await page.waitFor(nodeReceipt);
  const zh=await page.eval(`${nodeReceipt}.innerText`);
  assert.match(zh,/第 2 轮/);assert.match(zh,/节点：audit/);
  assert.doesNotMatch(zh,/turn 2|node: audit/);
  await go('?lang=en');await openAny();await injection();
  await page.waitFor(nodeReceipt);
  const en=await page.eval(`${nodeReceipt}.innerText`);
  assert.match(en,/turn 2/);assert.match(en,/node: audit/);
  assert.doesNotMatch(en,/第 2 轮|节点/);
 });
});
const failed=results.filter(r=>!r.ok).length;writeFileSync(join(dir,'results.json'),JSON.stringify({passed:results.length-failed,failed,checks:results},null,2));
console.log(`${results.length-failed}/${results.length} memory injection UI checks passed; ${failed} failed`);if(failed)throw Error(`${failed} UI checks failed; artifacts: ${dir}`);
