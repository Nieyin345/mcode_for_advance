/**
 * T28: real shared upstream AI bridge, fake host-authorized sender/session and
 * fake Mcode SDK. A denied sender must never reach the SDK dispatch.
 */
import { EventEmitter } from "node:events";
import { registerViewAiIpc } from "../../../../genoffice/apps/pdf/src/main/mcode-view-ai.js";
import type { DocsAiPorts } from "@main/document/docsAiPorts.js";
let total = 0, failures = 0;
const check = (name:string,ok:boolean) => { total++; if (!ok) {failures++;console.error("  FAIL "+name);} else console.log("  ok  "+name); };
const handlers = new Map<string, (...a:unknown[])=>unknown>();
const ipc = { handle(ch:string,cb:(...a:unknown[])=>unknown) {handlers.set(ch,cb);},
  removeHandler(ch:string) {handlers.delete(ch);} };
class Sender extends EventEmitter {id:number; events:Array<{channel:string;chunk:unknown}>=[]; constructor(id:number) {super();this.id=id;}
  isDestroyed() {return false;} send(channel:string,chunk:unknown) {this.events.push({channel,chunk});}
}
const trusted = new Sender(100);
const stranger = new Sender(999);
let sdkRuns = 0, confirms = 0, sessionValid = true;
const ports: DocsAiPorts = {
  describe(ctx) {return sessionValid && ctx.sessionId==="host-session"
    ? {ok:true,provider:"pi-sdk",model:"test"} : {ok:false,error:"denied"};},
  async confirm() {confirms++;return true;},
  async run(req,onChunk) {
    sdkRuns++;
    onChunk({requestId:req.requestId,type:"delta",text:"Mcode session reply"});
    onChunk({requestId:req.requestId,type:"done"});
  },
};
const release = registerViewAiIpc(ipc as never,(sender:unknown) =>
  sender === trusted ? {context:{sessionId:"host-session",filePath:"/authorized.pdf"},ports} : null);
const payload = {requestId:"t28-ai",messages:[{role:"user",content:"hello"}],
  sessionId:"forged-session",context:{sessionId:"forged-session",filePath:"/outside"}};
await handlers.get("ai:stream")!({sender:stranger},payload);
check("unauthorized sender cannot reach SDK",sdkRuns===0 && confirms===0 &&
  (stranger.events[0]?.chunk as {type?:string})?.type==="error");
await handlers.get("ai:stream")!({sender:trusted},payload);
check("authorized PDF AI invokes Mcode session",sdkRuns===1 && confirms===1);
check("authorized chunks reach native ai:stream-chunk",trusted.events.some(e=>e.channel==="ai:stream-chunk" &&
  (e.chunk as {text?:string}).text==="Mcode session reply"));
sessionValid = false;
await handlers.get("ai:stream")!({sender:trusted},{...payload,requestId:"t28-revoked"});
check("revoked session is denied before SDK",sdkRuns===1 && confirms===1 &&
  trusted.events.some(e=>(e.chunk as {requestId?:string;type?:string}).requestId==="t28-revoked" &&
    (e.chunk as {type?:string}).type==="error"));
sessionValid = true;
release();
check("bridge cleans up global ai channels",!handlers.has("ai:stream"));
console.log("genoffice-native-view-ai-smoke:"+(total-failures)+"/"+total+" 通过");
if (failures) process.exitCode=1;
