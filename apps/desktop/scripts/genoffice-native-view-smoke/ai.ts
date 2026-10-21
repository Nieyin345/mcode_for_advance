/** @smoke-covers src/main/document/documentViewHost.ts
 * T53: sheets/slides real host sender->session binding, shared vendor AI IPC,
 * fake Mcode provider. An arbitrary vendor-supplied session is never authority.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { registerViewAiIpc } from "../../../../genoffice/apps/pdf/src/main/mcode-view-ai.js";
import { DocumentViewHost, type DocumentViewLike } from "@main/document/documentViewHost.js";
import type { DocsAiPorts } from "@main/document/docsAiPorts.js";

let total = 0, failures = 0;
const check = (name:string,ok:boolean,details?:unknown) => {
  total++;
  if (!ok) {failures++; console.error("  FAIL "+name,details);}
  else console.log("  ok  "+name);
};
const handlers = new Map<string, (...a:unknown[])=>unknown>();
const ipc = {handle(ch:string,cb:(...a:unknown[])=>unknown) {handlers.set(ch,cb);},
  removeHandler(ch:string) {handlers.delete(ch);}};
class Sender extends EventEmitter {
  events:Array<{channel:string;chunk:unknown}>=[];
  constructor(readonly id:number) {super();}
  isDestroyed() {return false;}
  send(channel:string,chunk:unknown) {this.events.push({channel,chunk});}
  close() {}
  loadURL(_url:string) {}
  focus() {}
  setWindowOpenHandler() {}
}
const trusted = new Sender(100);
const stranger = new Sender(999);
const sheetSender = new Sender(201);
const slideSender = new Sender(202);
const temp = mkdtempSync(join(tmpdir(),"mcode-t53-ai-"));
const sheetFile = join(temp,"authorized.xlsx");
const slideFile = join(temp,"authorized.pptx");
writeFileSync(sheetFile,"fake host fixture");
writeFileSync(slideFile,"fake host fixture");
const child:unknown[] = [];
const window = {contentView:{
  addChildView(v:unknown) {child.push(v);},
  removeChildView(v:unknown) {const i=child.indexOf(v);if(i>=0)child.splice(i,1);}
}};
let vendorCalls=0;
const host = new DocumentViewHost({
  getMainWindow:()=>window,
  withinWorkspace:p=>p.startsWith(temp+sep),
  createView:{vendor:(_p,kind):DocumentViewLike=>{
    vendorCalls++;
    const sender = kind === "sheets" ? sheetSender : slideSender;
    return {webContents:sender,setBounds(){}};
  }},
});
const open = (kind:"sheets"|"slides",file:string,session:string)=>host.open({
  docId:kind,url:`genoffice-app://${kind}/index.html`,editor:kind,
  filePath:file,mcodeSessionId:session,
  visible:true,bounds:{x:0,y:0,width:320,height:240},
});
const sheetOpened=open("sheets",sheetFile,"mcode-session-sheets");
const slideOpened=open("slides",slideFile,"mcode-session-slides");
check("sheets/slides views originate in actual host factory",
  sheetOpened.ok && slideOpened.ok && vendorCalls===2,
  {sheetOpened,slideOpened,vendorCalls});
const sheetContext=host.vendorAiContextForSender(sheetSender);
const slideContext=host.vendorAiContextForSender(slideSender);
check("host resolves Sheets sender to Mcode session and XLSX file",
  sheetContext?.sessionId==="mcode-session-sheets"&&sheetContext.filePath===sheetFile,sheetContext);
check("host resolves Slides sender to Mcode session and PPTX file",
  slideContext?.sessionId==="mcode-session-slides"&&slideContext.filePath===slideFile,slideContext);
check("stranger cannot bind through host",host.vendorAiContextForSender(stranger)===null);

let sdkRuns=0, confirms=0, sessionValid=true;
const dispatchedContexts:Array<{sessionId:string;filePath:string}>=[];
const ports:DocsAiPorts={
  describe(ctx){return sessionValid && ["host-session","mcode-session-sheets","mcode-session-slides"].includes(ctx.sessionId)
    ? {ok:true,provider:"pi-sdk",model:"test"}:{ok:false,error:"denied"};},
  async confirm(){confirms++;return true;},
  async run(req,onChunk){
    sdkRuns++;
    dispatchedContexts.push(req.context);
    onChunk({requestId:req.requestId,type:"delta",text:"Mcode session reply"});
    onChunk({requestId:req.requestId,type:"done"});
  },
};
const release=registerViewAiIpc(ipc as never,(sender:unknown)=>{
  const context=sender===trusted
    ? {sessionId:"host-session",filePath:"/authorized.pdf"}
    : host.vendorAiContextForSender(sender);
  return context ? {context,ports} : null;
});
const payload={requestId:"t53-ai",messages:[{role:"user",content:"hello"}],
  sessionId:"forged-session",context:{sessionId:"forged-session",filePath:"/outside"}};
const stream=handlers.get("ai:stream")!;
try {
  await stream({sender:stranger},payload);
  check("unauthorized sender cannot reach Mcode provider",
    sdkRuns===0&&confirms===0&&(stranger.events[0]?.chunk as {type?:string})?.type==="error");
  await stream({sender:trusted},{...payload,requestId:"t53-pdf"});
  check("existing PDF AI bridge still dispatches into host-owned Mcode session",
    sdkRuns===1&&dispatchedContexts[0]?.sessionId==="host-session");
  await stream({sender:sheetSender},{...payload,requestId:"t53-sheets"});
  check("Sheets AI reaches Mcode selected session, not forged vendor session",
    sdkRuns===2&&confirms===2&&dispatchedContexts[1]?.sessionId==="mcode-session-sheets"&&
    dispatchedContexts[1]?.filePath===sheetFile,dispatchedContexts);
  check("Sheets receives genuine Mcode model reply on upstream AI channel",
    sheetSender.events.some(e=>e.channel==="ai:stream-chunk"&&
      (e.chunk as {text?:string}).text==="Mcode session reply"));
  await stream({sender:slideSender},{...payload,requestId:"t53-slides"});
  check("Slides AI reaches Mcode selected session, not forged vendor session",
    sdkRuns===3&&confirms===3&&dispatchedContexts[2]?.sessionId==="mcode-session-slides"&&
    dispatchedContexts[2]?.filePath===slideFile,dispatchedContexts);
  check("Slides receives genuine Mcode model reply on upstream AI channel",
    slideSender.events.some(e=>e.channel==="ai:stream-chunk"&&
      (e.chunk as {text?:string}).text==="Mcode session reply"));
  sessionValid=false;
  await stream({sender:slideSender},{...payload,requestId:"t53-revoked"});
  check("revoked Slides session denied before provider",
    sdkRuns===3&&confirms===3&&slideSender.events.some(e=>
      (e.chunk as {type?:string;requestId?:string}).type==="error"&&
      (e.chunk as {requestId?:string}).requestId==="t53-revoked"));
}finally{
  release();host.dispose();rmSync(temp,{recursive:true,force:true});
}
check("AI bridge unregisters its global channels",!handlers.has("ai:stream"));
console.log("genoffice-native-view-ai-smoke:"+(total-failures)+"/"+total+" 通过");
if(failures)process.exitCode=1;
