import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { withAuditPage } from './browser.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const checks=[];
const check=(name,pass,detail)=>{checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}${detail===undefined?'':' '+JSON.stringify(detail)}`);};
await withAuditPage(here,async page=>{
 try {
 await page.goto('', 'window.__ready && document.querySelector(".milkdown .ProseMirror")');
 await page.waitFor('document.querySelector(".milkdown .ProseMirror p")?.textContent.includes("Alpha")');
 await page.sleep(1000);
 check('opening and normalization do not save',await page.eval('__quoteAudit.writes.length')===0);
 const quoteButton='document.querySelector("[data-toolbar-item=mcode-quote]")';
 const noPicker='!document.querySelector("[data-quote-target]") && !document.querySelector("input[placeholder=\\"chatStream.quote.searchPlaceholder\\"]")';
 const select=async(paragraph=0,start=0,end)=>{
  await page.eval(`(()=>{const root=document.querySelector('.milkdown .ProseMirror');root.focus();const text=root.querySelectorAll('p')[${paragraph}].firstChild;const r=document.createRange();r.setStart(text,${start});r.setEnd(text,${end??'text.length'});const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));root.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));})()`);
  await page.sleep(250);
 };
 const clickQuote=async()=>{
  const pos=await page.eval(`(()=>{const e=${quoteButton};if(!e)throw Error('Missing native quote button');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...pos});
  await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...pos});
  await page.sleep(250);
 };
 await select(0,6,19);
 check('real native toolbar retains quote action',await page.eval(`!!${quoteButton}`));
 await clickQuote();
 check('click quotes immediately without target picker',await page.eval(noPicker));
 let quotes=await page.eval('__quoteAudit.quotes');
 check('open side conversation wins over main conversation',quotes.length===1 && quotes[0].sessionId==='side-1',quotes);
 if(quotes.length!==1){await page.screenshot('direct-quote-missing.png');return;}
 check('button names direct current-chat action',await page.eval(`${quoteButton}.getAttribute('aria-label')`)==='引用到当前对话');
 check('quote keeps only selected text and absolute file source',quotes[0].tag.kind==='quote' && quotes[0].tag.content.includes('source: /workspace/a.md') && quotes[0].tag.content.includes('\nbeta selected\n') && !quotes[0].tag.content.includes('Second paragraph'));
 check('quoting does not switch either conversation',await page.eval('__sessionStore.getState().activeSessionId==="main-1" && __sessionStore.getState().activeSideChatId==="side-1"'));
 check('native formatting remains available',await page.eval('!!document.querySelector("[data-toolbar-item=bold]")'));
 await page.sleep(1000);
 check('selection and quotation never save Markdown',await page.eval('__quoteAudit.writes.length')===0);
 // Same Crepe instance, different target: the click must resolve live store state.
 await page.eval('window.__sameEditor=document.querySelector(".milkdown .ProseMirror");__sessionStore.setState({activeSideChatId:null})');
 await select(1);await clickQuote();
 check('main conversation receives quote when side panel is closed',await page.eval('__quoteAudit.quotes.at(-1).sessionId')==='main-1');
 await page.eval('__sessionStore.setState({activeSideChatId:"node-2"})');
 await select(0);await clickQuote();
 check('newly opened node receives quote without another picker',await page.eval('__quoteAudit.quotes.at(-1).sessionId==="node-2"') && await page.eval(noPicker));
 await page.eval('__sessionStore.setState({activeSideChatId:null,activeSessionId:"main-2"})');
 await select(0);await clickQuote();
 check('switching main conversation updates target immediately',await page.eval('__quoteAudit.quotes.at(-1).sessionId')==='main-2');
 check('changing conversations does not recreate editor or lose undo history',await page.eval('__sameEditor===document.querySelector(".milkdown .ProseMirror")'));
 // No open conversation: do not create, guess a stale target, or silently drop the action.
 await page.eval('__sessionStore.setState({activeSessionId:null,activeSideChatId:null})');
 const count=await page.eval('__quoteAudit.quotes.length');
 await select(0);await clickQuote();
 check('no active conversation cannot receive a stale quote',await page.eval('__quoteAudit.quotes.length')===count);
 check('no active conversation explains what to do without a picker',await page.eval('__quoteAudit.toasts.at(-1).title')==='请先打开一个对话，再引用所选内容。' && await page.eval(noPicker));
 await page.eval('__sessionStore.setState({activeSessionId:"main-3"})');
 // Native keyboard-created selection still works.
 await page.eval(`(()=>{const e=document.querySelector('.milkdown .ProseMirror');e.focus();const n=e.querySelector('p').firstChild;const r=document.createRange();r.setStart(n,0);r.collapse(true);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
 await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,modifiers:8});
 await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39,modifiers:8});
 await page.sleep(250);await clickQuote();
 check('keyboard-selected text is quoted directly',await page.eval('__quoteAudit.quotes.at(-1).sessionId==="main-3" && __quoteAudit.quotes.at(-1).tag.content.includes("\\nA\\n")'));
 await page.eval('__openMarkdown("/workspace/b.md")');
 await page.waitFor('document.querySelector(".milkdown .ProseMirror p")?.textContent.includes("Bravo")');
 check('switching file without editing does not save',await page.eval('__quoteAudit.writes.length')===0);
 await select(0);await clickQuote();
 check('new file quote uses new text and source path',await page.eval('__quoteAudit.quotes.at(-1).tag.content.includes("source: /workspace/b.md") && __quoteAudit.quotes.at(-1).tag.content.includes("Bravo text from second file.") && !__quoteAudit.quotes.at(-1).tag.content.includes("Alpha")'));
 await page.eval(`(()=>{document.activeElement?.blur();const r=document.createRange();r.selectNodeContents(document.querySelector('#outside'));getSelection().removeAllRanges();getSelection().addRange(r);document.dispatchEvent(new Event('selectionchange'));})()`);
 const outsideCount=await page.eval('__quoteAudit.quotes.length');
 await page.eval(`${quoteButton}?.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}))`);
 await page.sleep(150);
 check('outside selection cannot quote stale editor text',await page.eval('__quoteAudit.quotes.length')===outsideCount);
 check('no interaction opens a target picker or loads its node list',await page.eval(noPicker) && await page.eval('__quoteAudit.nodeListReads')===0);
 await page.eval(`(()=>{const e=document.querySelector('.milkdown .ProseMirror');e.focus();const r=document.createRange();r.selectNodeContents(e.querySelector('p'));r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);})()`);
 await page.send('Input.insertText',{text:' EDITED'});
 await page.waitFor('__quoteAudit.writes.length>0');
 check('typing after quoting still saves normally',await page.eval('__quoteAudit.writes.at(-1).filePath==="/workspace/b.md" && __quoteAudit.writes.at(-1).content.includes("EDITED")'));
 check('real renderer has no uncaught exceptions',page.exceptions.length===0,page.exceptions);
 await page.screenshot('direct-quote-fixed.png');
 } catch(error) {
  check('browser interaction completed',false,error.stack);
  await page.screenshot('interaction-failure.png');
  writeFileSync(join(here,'interaction-failure.json'),JSON.stringify(await page.eval('({text:document.body.innerText,selection:getSelection()?.toString()})'),null,2));
 }
});
writeFileSync(join(here,'result.json'),JSON.stringify(checks,null,2));
const passed=checks.filter(x=>x.pass).length;
console.log(`Markdown direct quote browser smoke: ${passed}/${checks.length}`);
if(passed!==checks.length)process.exitCode=1;
