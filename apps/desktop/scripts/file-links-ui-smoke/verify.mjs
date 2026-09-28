import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { withAuditPage } from './browser.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const checks=[];
const check=(name,pass,detail)=>{checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}${detail===undefined?'':' '+JSON.stringify(detail)}`);};
await withAuditPage(here,async page=>{
 try {
 await page.goto('', 'window.__ready && document.querySelector("#fixture [role=button]")');
 const link='document.querySelector("#fixture [role=button],#fixture a")';
 const fixture=async(token,files,anchor=false)=>{
  await page.eval(`__setFiles(${JSON.stringify(files)});__fixture(${JSON.stringify(token)},${anchor})`);
  await page.waitFor(`${link}?.textContent===${JSON.stringify(token)} && !document.querySelector('[role=menu]')`);
 };
 const click=async(expression)=>{
  const pos=await page.eval(`(()=>{const r=(${expression}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await page.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...pos});
  await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...pos});
 };
 check('rendering chat links never searches',await page.eval('__audit.searches.length')===0);
 await fixture('a.ts',['src/a.ts','tests/a.ts']);await click(link);
 await page.waitFor('document.querySelectorAll("[role=menuitem]").length===2');
 check('ambiguous click opens real Base UI picker, not first file',await page.eval('__audit.opened.length===0 && document.querySelectorAll("[role=menuitem]").length===2'));
 await click('[...document.querySelectorAll("[role=menuitem]")].find(e=>e.textContent.includes("tests/a.ts"))');
 await page.waitFor('__audit.opened.length===1');
 check('choosing a result opens exactly that desktop file',await page.eval('__audit.opened[0]')==='/workspace/tests/a.ts');
 await fixture('b.ts',['src/not-b.ts','tests/b.ts']);await click(link);
 await page.waitFor('__audit.opened.length===1');
 check('unique exact suffix opens without unrelated prefix hit',await page.eval('__audit.opened[0]')==='/workspace/tests/b.ts');
 await fixture('key.ts',['src/key.ts']);
 await page.eval(`${link}.focus()`);
 await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await page.waitFor('__audit.opened.length===1');
 check('keyboard Enter activates the file link once',await page.eval('__audit.opened.length===1 && __audit.opened[0]==="/workspace/src/key.ts"'));
 await fixture('none.ts',[]);await click(link);
 await page.waitFor('document.body.textContent.includes("chatStream.fileLink.noMatch")');
 check('missing file displays no-match state without opening anything',await page.eval('__audit.opened.length')===0);
 await fixture('/workspace/anchor.md',[],true);await click(link);
 await page.waitFor('__audit.opened.length===1');
 check('Markdown anchor intercepts navigation and opens local file',await page.eval('__audit.opened[0]==="/workspace/anchor.md" && !!document.querySelector("#fixture a")'));
 check('absolute path click does not search',await page.eval('__audit.searches.length')===0);
 await fixture('mobile.md',['docs/mobile.md']);await page.eval('__setDesktop(false)');await click(link);
 await page.waitFor('__audit.mobile.length===1');
 check('mobile link uses its read-only viewer, not desktop IDE',await page.eval('__audit.opened.length===0 && __audit.mobile[0].kind==="file" && __audit.mobile[0].path==="/workspace/docs/mobile.md"'));
 check('real link/picker interactions have no uncaught exceptions',page.exceptions.length===0,page.exceptions);
 await page.screenshot('file-links.png');
 } catch(error) {check('browser interactions completed',false,error.stack);await page.screenshot('failure.png');}
});
writeFileSync(join(here,'result.json'),JSON.stringify(checks,null,2));
const passed=checks.filter(x=>x.pass).length;console.log(`File link UI smoke: ${passed}/${checks.length}`);
if(passed!==checks.length)process.exitCode=1;
