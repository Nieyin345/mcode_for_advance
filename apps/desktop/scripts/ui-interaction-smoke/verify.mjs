import {withAuditPage} from './browser.mjs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
const here=dirname(fileURLToPath(import.meta.url)), results=[];
await withAuditPage(here,async page=>{
 const check=(name,ok,detail)=>{results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
 const go=async mode=>{await page.goto('case='+mode,'document.querySelector("header") && window.labApi');};
 const input=async(selector,value)=>{await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');e.focus();Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await page.sleep(60);};
 const click=async selector=>{const rect=await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing button: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});await page.sleep(80);};
 const key=async(key,code=key,vk=key==='Enter'?13:key==='Escape'?27:key==='Tab'?9:37)=>{await page.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk});await page.sleep(80);};
 const test=async(name,fn)=>{try{await fn();check(name+' / no uncaught errors',page.exceptions.length===0,page.exceptions.slice());}catch(e){check(name,false,String(e));}await page.screenshot(name+'.png');};
 await test('approval-scope',async()=>{await go('approval');await click('[aria-label="B 会话输入"]');await key('Escape');check('background approval untouched',await page.eval('labEvents.length===0'));});
 await test('question-scope-ime',async()=>{await go('question');await input('[role=dialog] input','typed');await click('[aria-label="另一个界面的输入框"]');await key('Enter');check('unrelated input cannot submit question',await page.eval('labEvents.length===0'));await page.eval(`document.querySelector('[role=dialog] input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);check('composing Enter does not submit',await page.eval('labEvents.length===0'));await click('[role=dialog] input');await key('Enter');check('local normal Enter submits exactly once',await page.eval('labEvents.filter(x=>x.startsWith("submit:")).length===1'));});
 await test('plan-ime',async()=>{
  await go('plan');await input('main input','feedback');await page.eval(`document.querySelector('main input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);check('IME cannot approve a plan',await page.eval('labEvents.length===0'));await key('Enter');check('normal Enter approves plan once',await page.eval('labEvents.join()==="approved"'));
 });
 await test('palette-caret',async()=>{await go('palette');await input('[role=combobox]','abc');await key('ArrowLeft','ArrowLeft',37);check('left arrow moves caret',await page.eval('document.querySelector("[role=combobox]").selectionStart===2'));const ax=await page.send('Accessibility.getFullAXTree');check('palette has accessible name',ax.nodes.some(x=>x.role?.value==='dialog'&&x.name?.value));});
 await test('retained-budget',async()=>{await go('budget');await input('#setting-turnbudget-usd','2');await click('[aria-label="离开设置"]');await page.eval('labMount()');await page.waitFor('document.querySelector("#setting-turnbudget-usd")');check('draft survives panel remount',await page.eval('document.querySelector("#setting-turnbudget-usd").value==="2"'));await click('[data-testid="budget-save"]');await page.waitFor('JSON.parse(labSettings["runtime.turnBudget"]).maxUsd===2');check('explicit save persists',true);});
 await test('budget-validation-error',async()=>{await go('budget');await input('#setting-turnbudget-usd','-1');await page.sleep(600);check('invalid value keeps previous cap',await page.eval('JSON.parse(labSettings["runtime.turnBudget"]).maxUsd===5'));check('invalid save disabled',await page.eval('document.querySelector("[data-testid=budget-save]").disabled'));await input('#setting-turnbudget-usd','2');await page.eval('labRejectSave=true');await click('[data-testid="budget-save"]');await page.waitFor('document.body.innerText.includes("mock: 磁盘写入失败")');check('write failure is visible and caught',await page.eval('!labEvents.some(x=>x.startsWith("unhandled:"))'));await page.eval('labRejectSave=false');await click('[data-testid="budget-save"]');await page.waitFor('JSON.parse(labSettings["runtime.turnBudget"]).maxUsd===2');check('failed save can retry',true);});
 await test('policy-save-race',async()=>{
  await go('budget');await input('#setting-turnbudget-usd','2');await page.eval('labDelaySave=true');await click('[data-testid=budget-save]');await page.waitFor('window.labReleaseSave');await page.eval('labUnmount()');await page.sleep(60);await page.eval('labMount()');await page.waitFor('document.querySelector("#setting-turnbudget-usd")');await input('#setting-turnbudget-usd','3');await page.eval('labReleaseSave()');await page.sleep(160);
  check('late save preserves new mount edit',await page.eval('document.querySelector("#setting-turnbudget-usd").value==="3"&&!document.querySelector("[data-testid=budget-save]").disabled'));
  check('late save persisted only submitted value',await page.eval('JSON.parse(labSettings["runtime.turnBudget"]).maxUsd===2'));
  await page.eval('labDelaySave=false');await click('[data-testid=budget-save]');await page.waitFor('JSON.parse(labSettings["runtime.turnBudget"]).maxUsd===3');
  await input('#setting-fallback-chain','model-b');await page.eval('labUnmount()');await page.sleep(60);await page.eval('labMount()');await page.waitFor('document.querySelector("#setting-fallback-chain")');check('fallback draft survives navigation',await page.eval('document.querySelector("#setting-fallback-chain").value==="model-b"'));await click('[data-testid=fallback-save]');await page.waitFor('labSettings["runtime.fallbackModels"]===\'["model-b"]\'');
 });
 await test('policy-hydration-race',async()=>{
  await go('budget');await input('#setting-turnbudget-usd','2');await page.eval('labDelaySave=true');await click('[data-testid=budget-save]');await page.waitFor('window.labReleaseSave');await page.eval('labDelayGet="runtime.turnBudget";labUnmount()');await page.sleep(60);await page.eval('labMount()');await page.waitFor('window.labReleaseGet');await page.eval('labReleaseSave()');await page.sleep(120);await page.eval('labReleaseGet()');await page.sleep(160);
  check('stale load cannot undo successful save',await page.eval('document.querySelector("#setting-turnbudget-usd").value==="2"'));
 });
 await test('mobile-race',async()=>{await go('mobile-defer');await page.waitFor('labPending.length>0');await page.eval('labPatch({activeProjectId:"B"})');await page.waitFor('labPending.some(x=>x.args.projectPath==="/B")');await page.eval('labPending.filter(x=>x.args.projectPath==="/B").forEach(x=>x.resolve({entries:[{name:"B-only.txt",path:"/B/B-only.txt",isDir:false}]}))');await page.waitFor('document.body.innerText.includes("B-only.txt")');await page.eval('labPending.filter(x=>x.args.projectPath==="/A").forEach(x=>x.resolve({entries:[{name:"A-only.txt",path:"/A/A-only.txt",isDir:false}]}))');await page.sleep(150);check('late A cannot overwrite B',await page.eval('document.body.innerText.includes("B-only.txt")&&!document.body.innerText.includes("A-only.txt")'));});
 await test('mobile-error',async()=>{await go('mobile-error');await page.sleep(150);check('failure is not an empty folder',await page.eval('document.body.innerText.includes("mock: 无权访问")&&!document.body.innerText.includes("空目录")'));await page.eval('labRejectFile=false');await click('main button, [role=alert] button');await page.waitFor('document.body.innerText.includes("src")');check('retry recovers',true);});
 await test('keyboard-focus',async()=>{await go('primitives');await key('Tab');check('button has visible focus indicator',await page.eval(`(()=>{const c=getComputedStyle(document.activeElement);return c.boxShadow!=='none'||(c.outlineStyle!=='none'&&!c.outlineColor.includes('0)'))})()`));const color=await page.eval(`(()=>{const e=document.querySelector('button'),c=getComputedStyle(e);return {fg:c.color,bg:c.backgroundColor}})()`);const l=c=>{const [r,g,b]=c.match(/[\d.]+/g).slice(0,3).map(Number).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b;};const a=l(color.fg),b=l(color.bg);check('primary text contrast >= 4.5',(Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,color);});
 await test('dialog-name',async()=>{await go('dialog');const ax=await page.send('Accessibility.getFullAXTree');check('close button named',!ax.nodes.some(x=>!x.ignored&&x.role?.value==='button'&&!x.name?.value));});
 await test('memory-drafts',async()=>{
  const editor='textarea[aria-label="Memory editor test input"]';
  const value=()=>page.eval(`document.querySelector(${JSON.stringify(editor)}).value`);
  await go('memory');await page.waitFor(`document.querySelector('button[title="global/facts/a.md"]')`);
  await click('button[title="global/facts/a.md"]');await page.waitFor(`document.querySelector(${JSON.stringify(editor)})&&!document.querySelector(${JSON.stringify(editor)}).readOnly`);
  await input(editor,'unsaved A');
  await click('button[title="global/facts/b.md"]');await page.sleep(120);await click('button[title="global/facts/a.md"]');await page.sleep(120);
  check('memory draft survives A/B switch',await value()==='unsaved A');
  await click('button[title="global/facts/a.md"]');await page.sleep(120);
  check('clicking current memory does not erase draft',await value()==='unsaved A');
  await page.eval('labUnmount()');await page.sleep(80);await page.eval('labMount()');await page.waitFor(`document.querySelector('button[title="global/facts/a.md"]')`);await click('button[title="global/facts/a.md"]');await page.sleep(120);
  check('memory draft survives settings unmount',await value()==='unsaved A');
 });
 await test('memory-tab-width-and-scope-label',async()=>{
  await go('memory');
  await page.waitFor('document.querySelector("section > .my-3")');
  const width=()=>page.eval('document.querySelector("section > .my-3").getBoundingClientRect().width');
  const libraryWidth=await width();
  check('default memory scope is an unambiguous placeholder',await page.eval('document.querySelector("section label select option:first-child").textContent.trim()==="---"'));
  await click('section > .my-3 button:nth-child(2)');
  const instructionsWidth=await width();
  check('memory library tab bar matches the other tabs',Math.abs(libraryWidth-instructionsWidth)<2,{libraryWidth,instructionsWidth});
  await click('section > .my-3 button:first-child');
  await click('button[title="新建文件"]');
  await input('[placeholder="文件名（不含扩展名）"]','scope-test');
  const saveButton='[placeholder="文件名（不含扩展名）"] ~ div button';
  check('placeholder still requires choosing a scope to save',await page.eval(`document.querySelector(${JSON.stringify(saveButton)})?.disabled`));
  await page.eval('(()=>{const e=document.querySelector("section label select");e.value="global";e.dispatchEvent(new Event("change",{bubbles:true}));})()');
  check('selecting global enables create',await page.eval(`!document.querySelector(${JSON.stringify(saveButton)})?.disabled`));
 });
 await test('divider-lifecycle',async()=>{await go('primitives');check('divider keyboard focusable',await page.eval('document.querySelector("[role=separator]").tabIndex===0'));await click('[role=separator]');await key('ArrowRight','ArrowRight',39);check('keyboard resizes divider',await page.eval('labEvents.some(x=>x.startsWith("resize:"))'));await page.eval('labEvents=[]');const r=await page.eval('(()=>{const r=document.querySelector("[role=separator]").getBoundingClientRect();return {x:r.x,y:r.y+40}})()');await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...r});await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...r});check('drag actually starts',await page.eval('document.body.style.userSelect==="none"'));await page.eval('labUnmount()');await page.sleep(50);await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:r.x+30,y:r.y});check('unmount releases drag',await page.eval('labEvents.length===0 && document.body.style.userSelect!=="none"'));await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:r.x+30,y:r.y});});
 // 模型配置表单里的三个字段标签此前是**裸字面量** `label="Base URL"` / `label="API Key"` /
 // `label="Token / API Key"`,绕过了字典(同页其它标签都走 `t(...)`)。zh 与 en 两份值都是
 // 同样的专有名词,所以**切语言分辨不出**"走了 key"还是"写死了字面量" —— 判据改立成
 // **哨兵覆盖**:把这三个键在运行期换成醒目串,界面显示替换值 = 走了 `t`,显示原文 = 硬编码。
 const labelsOf=()=>page.eval("[...document.querySelectorAll('label > span:first-child')].map(e=>e.textContent.trim()).filter(Boolean)");
 await test('model-form-labels-route-through-i18n-keys',async()=>{
  // Claude 端点表单(选左栏那家已存在的端点 → 右侧出表单):Base URL + Token / API Key。
  await go('models&sentinel=models');
  await click('aside nav button');
  await page.waitFor("document.body.innerText.includes('OVR::baseUrl')");
  const claude=await labelsOf();
  check('claude form base URL label comes from its i18n key',claude.includes('OVR::baseUrl'));
  check('claude form token label comes from its i18n key',claude.includes('OVR::authToken'));
  check('claude form no raw hardcoded label leaks',!claude.includes('Base URL')&&!claude.includes('Token / API Key'));
  // 切到 Codex 标签,开一家 Codex 端点:Base URL + API Key。
  await page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim().startsWith('Codex'));b&&b.click()})()`);
  await page.waitFor("document.querySelector('aside nav button')");
  await click('aside nav button');
  await page.waitFor("document.body.innerText.includes('OVR::baseUrl')");
  const codex=await labelsOf();
  check('codex form base URL label comes from its i18n key',codex.includes('OVR::baseUrl'));
  check('codex form API key label comes from its i18n key',codex.includes('OVR::apiKey'));
 });
});
writeFileSync(join(here,'results.json'),JSON.stringify(results,null,2));
if(results.some(x=>!x.ok))throw Error(`${results.filter(x=>!x.ok).length} UI interaction assertions failed; artifacts: ${here}`);
