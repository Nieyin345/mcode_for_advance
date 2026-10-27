import {withAuditPage} from './browser.mjs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
const here=dirname(fileURLToPath(import.meta.url)), results=[];
await withAuditPage(here,async page=>{
 const check=(name,ok,detail)=>{results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}`+(ok||detail===undefined?'':'  → '+String(typeof detail==='string'?detail:JSON.stringify(detail)).slice(0,300)));};
 const go=async mode=>{await page.goto('case='+mode,'document.querySelector("header") && window.labApi');};
 const input=async(selector,value)=>{await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');e.focus();Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await page.sleep(60);};
 const click=async selector=>{const rect=await page.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing button: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});await page.sleep(80);};
 const key=async(key,code=key,vk=key==='Enter'?13:key==='Escape'?27:key==='Tab'?9:37)=>{await page.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk});await page.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk});await page.sleep(80);};
 const test=async(name,fn)=>{try{await fn();check(name+' / no uncaught errors',page.exceptions.length===0,page.exceptions.slice());}catch(e){check(name,false,String(e));}await page.screenshot(name+'.png');};
 // ARC-005: not merely source-string checks. Chromium must compute two distinct
 // theme geometries on one and the SAME subtree, with the draft surviving a flip.
 // Fixture is purely visual: no SDK, IPC, terminal or user-data side effects.
 await test('workspace-density-computed-css',async()=>{
  await go('primitives');
  const proof=await page.eval(`(()=>{
   const host=document.createElement('div');
   host.setAttribute('data-ui-shell-variant','classic');
   host.setAttribute('id','workspace-density-probe');
   host.innerHTML='<div class="composer-card"><textarea aria-label="draft-probe">KEEP DRAFT</textarea></div><button data-sidebar-quick-action="new">New</button><div data-stream-session-row class="px-2.5 py-2">Session</div><div data-tree-session-row class="rounded-md px-1 py-1">Tree</div>';
   document.body.append(host);
   const composer=host.querySelector('.composer-card');
   const input=host.querySelector('textarea');
   const button=host.querySelector('button');
   const row=host.querySelector('[data-stream-session-row]');
   const tree=host.querySelector('[data-tree-session-row]');
   composer.style.borderRadius='var(--composer-radius)';
   const snap=()=>({
    radius:getComputedStyle(composer).borderTopLeftRadius,
    buttonHeight:getComputedStyle(button).minHeight,
    rowPadding:getComputedStyle(row).paddingTop,
    treeMinHeight:getComputedStyle(tree).minHeight,
    treePadding:getComputedStyle(tree).paddingTop,
    inputValue:input.value,
    sameNode:host.querySelector('textarea')===input
   });
   const classic=snap();
   host.setAttribute('data-ui-shell-variant','workspace');
   const workspace=snap();
   host.setAttribute('data-ui-shell-variant','classic');
   const restored=snap();
   host.remove();
   return { classic, workspace, restored };
  })()`);
  /* 【UI 重建 2026-10-27】composer 圆角不再按 `data-ui-shell-variant` 分档。
   *
   * 旧：classic 20px / workspace 14px。现在两处都是 Claude 的
   * `--cds-radius-composer` = `.875rem × 16/17` ≈ **13.18px**。
   *
   * 20px 从来不是 Claude 的值，是 Mcode 自己的旧配方；用户要「外观和 Claude 一样」，
   * 所以两档合并成一档。**判据守的意图没变**：真 Chromium 里读到的计算值
   * 必须是那个 token 算出来的数（不是某个写死的 px），且切换 variant 时**不跳变**。
   *
   * 用区间而不是等号：浏览器把 `calc(.875rem * 16/17)` 算成 13.176470…px，
   * 各版本字符串化精度不同；区间容得下舍入，容不下「退回 20 / 14」。
   * （20 和 14 都不在 [13.0, 13.4] 里，变异仍会红。） */
  const radiusPx = (s) => parseFloat(String(s ?? ""));
  check('★ 真实 Chromium: Composer 圆角 = Claude 的 --cds-radius-composer（≈13.18px）',
    radiusPx(proof.classic.radius) > 13.0 && radiusPx(proof.classic.radius) < 13.4, proof);
  check('★ 真实 Chromium: 切壳变体不改变 Composer 圆角（已合并成一档）',
    radiusPx(proof.workspace.radius) === radiusPx(proof.classic.radius), proof);
  check('★ 真实 Chromium: workspace New session 控件不低于 32px',parseFloat(proof.workspace.buttonHeight)>=32,proof);
  check('★ 真实 Chromium: workspace 会话卡压缩 padding 且 classic 保留旧尺寸',parseFloat(proof.workspace.rowPadding) < parseFloat(proof.classic.rowPadding),proof);
  check('★ 真实 Chromium: v2 树行最小 28px 且经典模式不变',parseFloat(proof.workspace.treeMinHeight)>=28 &&
   parseFloat(proof.workspace.treePadding)===4 && proof.classic.treeMinHeight!==proof.workspace.treeMinHeight,proof);
  check('★ CSS 切壳前后恢复原几何，且不替换 textarea 或损失草稿',proof.restored.radius===proof.classic.radius &&
   proof.restored.rowPadding===proof.classic.rowPadding && proof.restored.treePadding===proof.classic.treePadding &&
   proof.workspace.sameNode && proof.restored.sameNode &&
   proof.restored.inputValue==='KEEP DRAFT',proof);
 });
 await test('approval-scope',async()=>{await go('approval');await click('[aria-label="B 会话输入"]');await key('Escape');check('background approval untouched',await page.eval('labEvents.length===0'));});
 // 审批卡展开区那段「输入」标签必须走 i18n key —— 它的孪生 MessageBlocks(工具卡)用的是
 // 同一把 key `chatStream.tool.input`。用哨兵把该 key 换成 OVR::toolInput:源码走 key 则
 // 界面显示替换值;写死 "Input" 则显示原文(zh/en 两份值本就一样,光靠切语言分辨不出)。
 // 卡片在 display:none 里,但 React 已把它渲染进 DOM,`详情` 按钮的 click 仍能触发。
 await test('approval-input-label-i18n',async()=>{
  await go('approval&sentinel=approval');
  await page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='详情');b&&b.click();})()`);
  await page.sleep(120);
  const label=await page.eval(`(()=>{const d=[...document.querySelectorAll('div')].find(e=>e.children.length===0&&e.textContent.trim()==='OVR::toolInput');return d?d.textContent.trim():null;})()`);
  check('★ 审批卡的「输入」标签走 i18n key(哨兵替换可见)',label==='OVR::toolInput',label);
  const raw=await page.eval(`[...document.querySelectorAll('div')].some(e=>e.children.length===0&&e.textContent.trim()==='Input')`);
  check('审批卡没有把 Input 写死',!raw);
 });
 await test('question-scope-ime',async()=>{await go('question');await input('[role=dialog] input','typed');await click('[aria-label="另一个界面的输入框"]');await key('Enter');check('unrelated input cannot submit question',await page.eval('labEvents.length===0'));await page.eval(`document.querySelector('[role=dialog] input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);check('composing Enter does not submit',await page.eval('labEvents.length===0'));await click('[role=dialog] input');await key('Enter');check('local normal Enter submits exactly once',await page.eval('labEvents.filter(x=>x.startsWith("submit:")).length===1'));});
 await test('plan-ime',async()=>{
  await go('plan');
  check('plan primary action starts disabled during the arming window',await page.eval('document.querySelector("[data-cds=PlanApprovalPrimary]")?.disabled===true'));
  await input('main input','feedback');
  await page.eval(`document.querySelector('main input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);
  check('IME cannot approve a plan',await page.eval('labEvents.length===0'));
  await key('Enter');
  check('fast Enter cannot approve before the arming delay',await page.eval('labEvents.length===0'));
  await page.sleep(520);
  check('plan primary action arms after the delay',await page.eval('document.querySelector("[data-cds=PlanApprovalPrimary]")?.disabled===false'));
  await key('Enter');
  check('normal Enter approves plan once after arming',await page.eval('labEvents.join()==="approved"'));
 });
 await test('palette-caret',async()=>{await go('palette');await input('[role=combobox]','abc');await key('ArrowLeft','ArrowLeft',37);check('left arrow moves caret',await page.eval('document.querySelector("[role=combobox]").selectionStart===2'), await page.eval('({sel:document.querySelector("[role=combobox]")?.selectionStart, tag:document.querySelector("[role=combobox]")?.tagName})'));const ax=await page.send('Accessibility.getFullAXTree');check('palette has accessible name',ax.nodes.some(x=>x.role?.value==='dialog'&&x.name?.value));});
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
 // MarketView 的「添加来源」是一个文本输入框(用户粘 `owner/repo` 或注册中心地址)。中文
 // 输入法按 Enter 确认候选词时不能提交;只有真 Enter 才提交。兄弟文本框都带同一守卫。
 await test('market-add-enter-respects-ime',async()=>{
  await go('market');
  await click('[aria-expanded]');
  const sel='[aria-label="公开 GitHub owner/repo 或仓库网址"]';
  await input(sel,'owner/repo');
  await page.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);
  await page.sleep(120);
  check('composing Enter does not add a source',await page.eval('document.getElementById("market-events").textContent===""'));
  await page.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await page.sleep(120);
  check('plain Enter adds the source once',await page.eval('document.getElementById("market-events").textContent==="owner/repo"'));
  // 搜索框同样是文本输入(中文可打),同样只在真 Enter 上提交。
  const search='[aria-label="搜索技能"]';
  await input(search,'技能');
  await page.eval(`document.querySelector(${JSON.stringify(search)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);
  await page.sleep(120);
  check('composing Enter does not submit a search',await page.eval('document.getElementById("market-searches").textContent==="0"'));
  await page.eval(`document.querySelector(${JSON.stringify(search)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await page.sleep(120);
  check('plain Enter submits the search once',await page.eval('document.getElementById("market-searches").textContent==="1"'));
 });
 // 引擎工具页的「自定义工具名」是文本输入框。中文输入法按 Enter 确认候选词时不能把
 // 半截拼音当成工具名加进去;只有真 Enter 才加。
 await test('engine-tools-custom-enter-respects-ime',async()=>{
  await go('enginetools');
  await page.waitFor("document.querySelector('[placeholder*=\"Bash\"]')");
  const sel='[placeholder*="Bash"]';
  await input(sel,'my_tool');
  await page.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);
  await page.sleep(80);
  check('composing Enter does not add a custom tool',await page.eval('!document.body.innerText.includes("my_tool")'));
  await page.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await page.sleep(80);
  check('plain Enter adds the custom tool',await page.eval('document.body.innerText.includes("my_tool")'));
 });
 // 插件页「从 Git 安装」的 URL 是文本输入框。中文输入法按 Enter 确认候选词时不能提交安装。
 await test('plugins-git-install-enter-respects-ime',async()=>{
  await go('plugins');
  // 打开「安装 ▾」菜单 → 选「从 Git 安装」。
  await page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null&&e.textContent.includes('安装'));b&&b.click();})()`);
  await page.waitFor('document.querySelector("[role=menuitem]")');
  await page.eval(`(()=>{const m=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('Git'));m&&m.click();})()`);
  await page.waitFor("document.querySelector('[placeholder*=\"github.com\"]')");
  const sel='[placeholder*="github.com"]';
  await input(sel,'https://github.com/o/r.git');
  await page.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);
  await page.sleep(100);
  check('composing Enter does not install from git',await page.eval('labPluginEvents.filter(e=>e.m==="installGit").length===0'));
  await page.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await page.sleep(100);
  check('plain Enter installs from git once',await page.eval('labPluginEvents.filter(e=>e.m==="installGit").length===1'));
  // 插件市场 pane 的「添加市场」地址框是同一类文本框,同样只在真 Enter 上加。
  await page.eval(`(()=>{const b=[...document.querySelectorAll('[role=tab],button')].find(e=>e.textContent.trim()==='市场');b&&b.click();})()`);
  await page.waitFor('document.querySelector("[placeholder=\\"marketplace git 地址\\"]")');
  const mp='[placeholder="marketplace git 地址"]';
  // open the add form: the dashed "添加插件市场" button (no marketplaces loaded).
  await page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.offsetParent!==null&&e.textContent.includes('添加插件市场'));b&&b.click();})()`);
  await page.sleep(80);
  await input(mp,'https://git.example/mp.git');
  await page.eval(`document.querySelector(${JSON.stringify(mp)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);
  await page.sleep(100);
  check('composing Enter does not add a marketplace',await page.eval('labPluginEvents.filter(e=>e.m==="marketplaceAdd").length===0'));
  await page.eval(`document.querySelector(${JSON.stringify(mp)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await page.sleep(100);
  check('plain Enter adds the marketplace once',await page.eval('labPluginEvents.filter(e=>e.m==="marketplaceAdd").length===1'));
 });
 // 【ARC-014】插件页把「全部组件就绪(ALL)」与「部分兼容」**分开显示**,而不是只显示
 // ANY 兼容。夹具:含通用 skill + Claude 专用 command 的插件 —— Claude 全就绪、Pi 部分兼容。
 // 判据:Claude 那行显示「全部组件就绪」,Pi 那行显示「部分兼容」且**不**显示「全部组件就绪」。
 await test('plugins-component-readiness',async()=>{
  await go('plugins&readiness=1');
  await page.waitFor("document.body.innerText.includes('mixed-pack')");
  // 展开插件详情(点那一行的展开按钮 —— 它带 aria-expanded)。
  await page.eval(`(()=>{const b=[...document.querySelectorAll('button[aria-expanded]')].find(e=>e.offsetParent!==null&&e.textContent.includes('mixed-pack'));b&&b.click();})()`);
  await page.sleep(150);
  const txt=await page.eval('document.body.innerText');
  check('★ Claude 行显示「全部组件就绪」',txt.includes('全部组件就绪'),txt.slice(0,400));
  check('★ Pi 行显示「部分兼容」',txt.includes('部分兼容'),txt.slice(0,400));
  // 承重:Pi 那一行**不能**也说「全部组件就绪」—— 用行内文本定位 Pi 行。若把 ALL 判定
  // 退化成恒 true,Pi 行会也显示「全部组件就绪」,这条就会红。
  const piLine=await page.eval(`(()=>{const els=[...document.querySelectorAll('div')].filter(e=>e.children.length<=8&&e.textContent.trim().startsWith('Pi'));return els.length?els[0].textContent:''})()`);
  check('★ Pi 行不谎报「全部组件就绪」(ALL 语义承重)',!piLine.includes('全部组件就绪'),piLine);
 });
 // 界面字体名是 CJK 文本(如「思源黑体」)。中文输入法按 Enter 确认候选词时不能 blur
 // (=不能提交);只有真 Enter 才 blur 提交。判据用焦点:守卫在 → 组词后输入框仍有焦点。
 await test('font-family-enter-respects-ime',async()=>{
  await go('font');
  const sel='#setting-font-sans';
  const focused=()=>page.eval(`document.activeElement===${JSON.stringify(sel)}?'1':(document.activeElement&&document.activeElement.id)`);
  await input(sel,'思源黑体');
  await page.eval(`document.querySelector(${JSON.stringify(sel)}).focus()`);
  await page.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))`);
  await page.sleep(120);
  check('composing Enter does not blur (commit) the font field',await page.eval(`document.activeElement===document.querySelector(${JSON.stringify(sel)})`));
  await page.eval(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await page.sleep(120);
  check('plain Enter blurs (commits) the font field',await page.eval(`document.activeElement!==document.querySelector(${JSON.stringify(sel)})`));
 });

 // ── UI-001: ConfirmDialog async completion / failure protocol ──
 // Real Chromium + real React events. The dialog must AWAIT onConfirm: while a
 // promise is pending the confirm button is disabled; a rejection or `{ok:false}`
 // keeps the dialog OPEN and shows the error (never close-and-pretend-success);
 // a sync confirm still closes.
 const confirmBtn=`[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim().startsWith('删除'))`;
 const clickConfirm=async()=>{await page.eval(`(()=>{const b=${confirmBtn};if(!b)throw Error('no confirm button');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);const rect=await page.eval(`(()=>{const b=${confirmBtn};const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});await page.sleep(40);};
 await test('confirmdialog-await-resolve',async()=>{
  await go('confirmdialog');
  await page.waitFor(`${confirmBtn}`);
  await clickConfirm();
  await page.sleep(60);
  // mid-flight: dialog still open, confirm button disabled, not yet resolved
  check('★ 异步确认进行中弹窗不关闭',await page.eval(`document.getElementById('confirm-open-flag').textContent==='open'`));
  check('★ 异步确认进行中确定键被禁用(挡双击)',await page.eval(`(()=>{const b=${confirmBtn};return b&&b.disabled;})()`));
  await page.waitFor(`document.getElementById('confirm-open-flag').textContent==='closed'`);
  check('resolve 之后弹窗关闭',await page.eval(`document.getElementById('confirm-open-flag').textContent==='closed'`));
  check('resolve 之后实际只发了一次命令',await page.eval(`document.getElementById('confirm-counts').textContent==='1:1'`));
 });
 await test('confirmdialog-reject-keeps-open',async()=>{
  await go('confirmdialog');
  await page.waitFor(`${confirmBtn}`);
  await page.eval(`labConfirmReset('reject')`);
  await page.waitFor(`${confirmBtn}`);
  await clickConfirm();
  await page.sleep(320);
  check('★ onConfirm 拒绝时弹窗保持打开(不假装成功)',await page.eval(`document.getElementById('confirm-open-flag').textContent==='open'`));
  check('★ onConfirm 拒绝时把错误显示出来',await page.eval(`document.body.innerText.includes('主进程删不掉')`));
 });
 await test('confirmdialog-okfalse-keeps-open',async()=>{
  await go('confirmdialog');
  await page.waitFor(`${confirmBtn}`);
  await page.eval(`labConfirmReset('okFalse')`);
  await page.waitFor(`${confirmBtn}`);
  await clickConfirm();
  await page.sleep(120);
  check('★ {ok:false} 时弹窗保持打开(主进程真相优先)',await page.eval(`document.getElementById('confirm-open-flag').textContent==='open'`));
  check('★ {ok:false} 时显示主进程给的原因',await page.eval(`document.body.innerText.includes('主进程拒绝了')`));
 });
 await test('confirmdialog-sync-still-closes',async()=>{
  await go('confirmdialog');
  await page.waitFor(`${confirmBtn}`);
  await page.eval(`labConfirmReset('sync')`);
  await page.waitFor(`${confirmBtn}`);
  await clickConfirm();
  await page.sleep(80);
  check('纯同步 onConfirm 仍然正常关闭(无退化)',await page.eval(`document.getElementById('confirm-open-flag').textContent==='closed'`));
  check('  同步确认只触发一次',await page.eval(`document.getElementById('confirm-counts').textContent==='1:1'`));
 });
 await test('confirmdialog-double-click-single-fire',async()=>{
  await go('confirmdialog');
  await page.waitFor(`${confirmBtn}`);
  await page.eval(`labConfirmReset('slow')`);
  await page.waitFor(`${confirmBtn}`);
  // two clicks in quick succession while the action is deliberately held open
  await page.eval(`(()=>{const b=${confirmBtn};b.click();b.click();})()`);
  await page.sleep(60);
  check('★ pending 时连点两次只发一次命令(同步闸)',await page.eval(`labConfirmCalls()===1`));
  await page.eval(`labReleaseConfirm()`);
  await page.sleep(80);
  check('  释放后弹窗关闭',await page.eval(`document.getElementById('confirm-open-flag').textContent==='closed'`));
 });
 // 【UI-001】第 23.3 节 Chromium 红例：旧确认的 Promise 迟到时不得关掉**新**弹窗，
 // 也不得把旧错误写进新弹窗。步骤：slow 模式点删除 → 取消关闭 → 重新打开 → 释放旧 Promise。
 await test('confirmdialog-stale-reopen-keeps-new-open',async()=>{
  await go('confirmdialog');
  await page.waitFor(`${confirmBtn}`);
  await page.eval(`labConfirmReset('slow')`);
  await page.waitFor(`${confirmBtn}`);
  await clickConfirm();
  await page.sleep(60);
  check('  旧确认进行中弹窗打开',await page.eval(`document.getElementById('confirm-open-flag').textContent==='open'`));
  // 用户在 pending 时取消 → 关闭
  await page.eval(`labConfirmSetOpen(false)`);
  await page.sleep(40);
  check('  取消后弹窗关闭',await page.eval(`document.getElementById('confirm-open-flag').textContent==='closed'`));
  // 重新打开（新一轮）
  await page.eval(`labConfirmSetOpen(true)`);
  await page.sleep(40);
  check('  重新打开后弹窗打开',await page.eval(`document.getElementById('confirm-open-flag').textContent==='open'`));
  // 释放**旧**那一轮的 Promise —— 它绝不能关掉现在这个新弹窗
  await page.eval(`labReleaseConfirm()`);
  await page.sleep(80);
  check('★ 旧确认迟到不得关掉重新打开的新弹窗',await page.eval(`document.getElementById('confirm-open-flag').textContent==='open'`));
  check('★ 旧确认迟到不得把新弹窗误标为完成',await page.eval(`document.getElementById('confirm-open-flag').textContent!=='closed'`));
 });

 // 【UI-001 remaining】旧 **reject** 迟到:取消→重开→旧承诺被**拒绝**(不是成功)。
 // 与「旧 resolve 迟到」是两条不同路径 —— reject 分支从前写错误、清 pending;代次守卫必须
 // 让旧代的 reject 既不关新弹窗、也不把错误写进新一轮(否则新弹窗会显示一个属于旧操作的红字)。
 await test('confirmdialog-stale-reject-keeps-new-open',async()=>{
  await go('confirmdialog');
  await page.waitFor(`${confirmBtn}`);
  await page.eval(`labConfirmReset('reject')`);
  await page.waitFor(`${confirmBtn}`);
  await clickConfirm();
  await page.sleep(40);
  // 用户在 pending 时取消 → 关闭,再重开(新一轮)。
  await page.eval(`labConfirmSetOpen(false)`);
  await page.sleep(30);
  await page.eval(`labConfirmSetOpen(true)`);
  await page.sleep(30);
  check('  重开后弹窗打开',await page.eval(`document.getElementById('confirm-open-flag').textContent==='open'`));
  // 等旧的 reject 落地(夹具 200ms 后 reject)。
  await page.sleep(260);
  check('★ 旧 reject 迟到不得关掉重新打开的新弹窗',await page.eval(`document.getElementById('confirm-open-flag').textContent==='open'`));
  check('★ 旧 reject 迟到不得把新弹窗误标为完成',await page.eval(`document.getElementById('confirm-open-flag').textContent!=='closed'`));
  // 承重:旧 reject 的**错误文案**不得泄漏到新一轮弹窗里(否则用户在新弹窗看到一条
  // 属于旧操作的红字)。撤掉代次守卫时,`setError(旧错误)` 会打到新弹窗上 → 这条红。
  check('★ 旧 reject 的错误文案不得泄漏进新弹窗',await page.eval(`!document.body.innerText.includes('回收站不可用')`));
 });

 // 【UI-001 remaining】两次快速重开:第二次重开后,释放**第一次**的旧 Promise 不得关掉它。
 // 比单次重开更狠 —— 代次必须真的递增到第二次,而不是只区分"开/关"。
 await test('confirmdialog-two-rapid-reopens',async()=>{
  await go('confirmdialog');
  await page.waitFor(`${confirmBtn}`);
  await page.eval(`labConfirmReset('slow')`);
  await page.waitFor(`${confirmBtn}`);
  await clickConfirm();
  await page.sleep(40);
  // 第一次关闭 + 重开
  await page.eval(`labConfirmSetOpen(false)`); await page.sleep(25);
  await page.eval(`labConfirmSetOpen(true)`); await page.sleep(25);
  // 第二次关闭 + 重开(两个快速周期)
  await page.eval(`labConfirmSetOpen(false)`); await page.sleep(25);
  await page.eval(`labConfirmSetOpen(true)`); await page.sleep(25);
  check('  两次重开后弹窗打开',await page.eval(`document.getElementById('confirm-open-flag').textContent==='open'`));
  await page.eval(`labReleaseConfirm()`);
  await page.sleep(80);
  check('★ 两次快速重开后旧 Promise 迟到不得关掉新弹窗',await page.eval(`document.getElementById('confirm-open-flag').textContent==='open'`));
 });

 // ── UI-002: Toast primary action is a real focusable control ──
 await test('toaster-keyboard-action',async()=>{
  await go('toaster');
  await page.waitFor(`document.getElementById('toast-ready')&&document.getElementById('toast-ready').textContent==='yes'`);
  await page.waitFor(`document.querySelectorAll('[data-toast-id]').length===2`);
  // The primary action is the element carrying the "open source" label.
  const actionSel=`[...document.querySelectorAll('[data-toast-id] *')].find(x=>x.textContent.trim()==='打开来源')`;
  check('★ 「打开来源」是可聚焦的 button(不是可点的 div)',await page.eval(`(()=>{const el=${actionSel};if(!el)return false;const btn=el.closest('button');return !!btn&&btn.tagName==='BUTTON';})()`));
  await page.eval(`(()=>{const el=${actionSel};const btn=el&&el.closest('button');if(btn)btn.focus();})()`);
  check('★ 焦点确实落在「打开来源」按钮上',await page.eval(`document.activeElement&&document.activeElement.tagName==='BUTTON'&&document.activeElement.textContent.includes('打开来源')`));
  // Native button activation via Enter: Chrome needs the key text (\r) for the
  // default action to synthesize the click on a focused <button>.
  await page.eval(`labEvents.length=0`);
  await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,text:'\r'});
  await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});
  await page.sleep(120);
  check('★ 键盘 Enter 能打开来源会话',await page.eval(`labEvents.includes('openTab:sess-bg')`));
  check('  打开来源后该通知被关闭',await page.eval(`labToastIds().length===1`));
 });
 await test('toaster-no-nav-button-without-session',async()=>{
  await go('toaster');
  await page.waitFor(`document.querySelectorAll('[data-toast-id]').length===2`);
  // The sessionless (sticky error) toast must NOT render any nav button.
  const sessionlessButtons=await page.eval(`(()=>{const cards=[...document.querySelectorAll('[data-toast-id]')];const c=cards.find(x=>!x.querySelector('button')||[...x.querySelectorAll('button')].every(b=>b.getAttribute('aria-label')==='关闭'));return c?[...c.querySelectorAll('button')].filter(b=>b.getAttribute('aria-label')!=='关闭').length:-1;})()`);
  check('★ 无 sessionId 的通知不渲染导航按钮',sessionlessButtons===0,sessionlessButtons);
  check('  「打开来源」只在带 sessionId 的通知上出现一次',await page.eval(`[...document.querySelectorAll('[data-toast-id]')].filter(c=>c.textContent.includes('打开来源')).length===1`));
 });
 await test('toaster-close-visible-on-focus',async()=>{
  await go('toaster');
  await page.waitFor(`document.querySelectorAll('[data-toast-id]').length===2`);
  // Focus the close button of the session toast: its opacity must become 1
  // (group-focus-within / focus-visible), not stay opacity:0.
  await page.eval(`(()=>{const c=[...document.querySelectorAll('[data-toast-id]')].find(x=>x.textContent.includes('打开来源'));const b=c.querySelector('button[aria-label="关闭"]');b.focus();})()`);
  await page.sleep(260); // let the opacity transition settle (transition-opacity ~150ms)
  check('★ 焦点在通知内时关闭按钮可见(opacity=1)',await page.eval(`(()=>{const c=[...document.querySelectorAll('[data-toast-id]')].find(x=>x.textContent.includes('打开来源'));const b=c.querySelector('button[aria-label="关闭"]');return Number(getComputedStyle(b).opacity)===1;})()`));
 });

 // ── UI-003: Escape is scoped — no global clear-all ──
 await test('toaster-escape-does-not-clear-all',async()=>{
  await go('toaster');
  await page.waitFor(`document.querySelectorAll('[data-toast-id]').length===2`);
  // Escape with focus OUTSIDE any toast (e.g. body / an unrelated input) must
  // NOT clear the stack — sticky duration=0 errors survive.
  await page.eval(`document.body.focus()`);
  await key('Escape');
  await page.sleep(80);
  check('★ 焦点不在通知上时 Esc 不清空全部(粘性错误留下)',await page.eval(`labToastIds().length===2`));
  // Escape WITH focus inside a toast dismisses only that focused toast.
  await page.eval(`(()=>{const c=[...document.querySelectorAll('[data-toast-id]')].find(x=>x.textContent.includes('打开来源'));c.querySelector('button[aria-label="关闭"]').focus();})()`);
  await key('Escape');
  await page.sleep(80);
  check('★ 焦点在通知里时 Esc 只关掉那一条',await page.eval(`labToastIds().length===1`));
  const remaining=await page.eval(`document.querySelector('[data-toast-id]').textContent.includes('需要审批')`);
  check('  剩下的是粘性的那条(不是被误清)',remaining);
 });

 // ── UI-005: settings Escape must not close while a nested dialog is open ──
 // Calls the REAL production guard (window.escapeClosesSettings) with a real
 // [role=dialog] mounted / absent / a preventDefault-ed event.
 await test('settings-escape-respects-nested-dialog',async()=>{
  await go('primitives');
  const behavior=await page.eval(`(()=>{
    const guard=window.escapeClosesSettings;
    if(typeof guard!=='function') return {missing:true};
    const withDialog=(()=>{
      const d=document.createElement('div');d.setAttribute('role','dialog');document.body.appendChild(d);
      const r=guard({defaultPrevented:false});
      d.remove();
      return r;
    })();
    const noDialog=guard({defaultPrevented:false});
    const prevented=guard({defaultPrevented:true});
    return {withDialog,noDialog,prevented};
  })()`);
  check('★ 生产守卫可被取到',behavior.missing!==true);
  check('★ 有嵌套弹窗时 Esc 不关闭设置页',behavior.withDialog===false);
  check('★ 无弹窗时 Esc 仍能关闭设置页',behavior.noDialog===true);
  check('★ Esc 已被下层 preventDefault 时设置页不再重复关闭',behavior.prevented===false);
 });

 // ── UI-005 (source-level, secondary): the guard is wired into SettingsPage ──
 {
  const { readFileSync }=await import('node:fs');
  const { join }=await import('node:path');
  const settings=readFileSync(join(process.cwd(),'src/renderer/components/settings/SettingsPage.tsx'),'utf8');
  const confirmDialog=readFileSync(join(process.cwd(),'src/renderer/components/ui/confirm-dialog.tsx'),'utf8');
  check('★ SettingsPage 的 Esc 走 escapeClosesSettings 守卫(不再无条件关闭)',/e\.key === "Escape" && escapeClosesSettings\(e\)/.test(settings));
  check('★ SettingsPage 从共享的 confirm-dialog 引入该守卫(不是自己的平行副本)',/import \{[^}]*escapeClosesSettings[^}]*\} from "@renderer\/components\/ui\/confirm-dialog\.js"/.test(settings));
  check('★ escapeClosesSettings 尊重 defaultPrevented 与已挂载弹窗',/export function escapeClosesSettings/.test(confirmDialog)&&/defaultPrevented/.test(confirmDialog)&&/role="dialog"/.test(confirmDialog));
 }
});
writeFileSync(join(here,'results.json'),JSON.stringify(results,null,2));
if(results.some(x=>!x.ok))throw Error(`${results.filter(x=>!x.ok).length} UI interaction assertions failed; artifacts: ${here}`);
