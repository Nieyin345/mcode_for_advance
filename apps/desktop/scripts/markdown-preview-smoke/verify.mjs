import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {withAuditPage} from './browser.mjs';
const here=dirname(fileURLToPath(import.meta.url)),checks=[];
const check=(name,pass,detail)=>{checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}`);};
await withAuditPage(here,async page=>{
 try{
  await page.goto('','window.__ready');
  await page.waitFor('document.body.textContent.includes("Transcript")');
  const actual=await page.eval('!!document.querySelector("[data-markdown-preview=crepe-readonly] .milkdown .ProseMirror")');
  check('PDF context-menu transcript side preview uses real Milkdown/Crepe',actual);
  if(!actual)return;
  await page.waitFor('Array.from(document.querySelectorAll(".milkdown img")).filter(i=>i.complete&&i.naturalWidth>0).length>=2');
  check('transcript selection wins over original PDF filePath',await page.eval('__previewAudit.fileReads[0].which==="md"'));
  const reads=await page.eval('__previewAudit.imageReads');
  check('relative image reads resolve against actual transcription directory',reads.includes('C:/isolated/paper/images/figure 1.png'));
  check('reference-style image renders via library image proxy',reads.includes('C:/isolated/paper/images/ref.png'));
  check('image src becomes displayable data URL',await page.eval('Array.from(document.querySelectorAll(".milkdown img")).some(i=>i.src.startsWith("data:image/png")&&i.naturalWidth===1)'));
  check('Crepe is read-only',await page.eval('document.querySelector(".milkdown .ProseMirror").getAttribute("contenteditable")==="false"'));
  check('editing toolbar is absent',await page.eval('!document.querySelector("milkdown-top-bar")'));
  check('unreadable images produce visible status',await page.eval('!!document.querySelector("[role=status]")'));
  await page.send('Input.insertText',{text:'SHOULD_NOT_EDIT'});
  await page.sleep(500);
  check('preview does not write or normalize source to disk',await page.eval('__previewAudit.audit.writes.length===0&&!document.querySelector(".milkdown .ProseMirror").textContent.includes("SHOULD_NOT_EDIT")'));
  await page.eval('__switchPreview("second")');
  await page.waitFor('__previewAudit.imageReads.includes("C:/isolated/second/images/ref.png")');
  check('switching document changes image base without stale editor',await page.eval('document.querySelectorAll(".milkdown .ProseMirror").length===1'));
  check('source image references remain unchanged',await page.eval('__previewAudit.doc.includes("images/figure%201.png?rev=1#part")&&__previewAudit.audit.writes.length===0'));
 }finally{writeFileSync(join(here,'result.json'),JSON.stringify({checks},null,2));await page.screenshot('markdown-preview.png');}
});
if(checks.length<11||checks.some(c=>!c.pass))process.exitCode=1;
