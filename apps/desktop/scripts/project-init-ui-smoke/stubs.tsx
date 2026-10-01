import { create } from "zustand";
import { en } from "@renderer/lib/i18n/en/memory.js";
export const audit={calls:[] as {method:string;input?:any}[],toasts:[] as any[],templates:[] as any[],previews:[] as any[],applies:[] as any[],failApply:false,agent:false,failRead:false,delayedSave:false,delayed:false,pending:[] as (()=>void)[]};
let serial=0;
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
export const api={projectInit:{
 async list(){audit.calls.push({method:"list"});if(!window.api)throw Error("DESKTOP_ONLY");return {templates:audit.templates.map(({id,name,description,revision})=>({id,name,description,revision})),defaultId:null};},
 async setDefault(input:{id:string|null}){audit.calls.push({method:"setDefault",input});return {ok:true};},
 async get(input:{id:string}){audit.calls.push({method:"get",input});const value=clone(audit.templates.find(t=>t.id===input.id));if(audit.failRead)throw Error("READ_FAILED");if(audit.delayed)await new Promise<void>(resolve=>audit.pending.push(resolve));return value;},
 async save(input:any){audit.calls.push({method:"save",input});if(audit.delayedSave)await new Promise<void>(resolve=>audit.pending.push(resolve));let saved=audit.templates.find(t=>t.id===input.id);if(saved&&saved.revision!==input.expectedRevision)throw Error("REVISION_CONFLICT");const value={...clone(input.draft),id:input.id??`template-${++serial}`,revision:String(++serial).padStart(64,"0")};audit.templates=audit.templates.filter(t=>t.id!==value.id).concat(value);return clone(value);},
 async delete(input:any){audit.calls.push({method:"delete",input});audit.templates=audit.templates.filter(t=>t.id!==input.id);return {ok:true};},
 async preview(input:any){audit.previews.push(input);const value=audit.templates.find(t=>`init-${t.name}`===input.command);if(!value)throw Error("UNKNOWN_COMMAND");return {templateId:value.id,name:value.name,revision:value.revision,sessionId:input.sessionId,projectId:"p1",projectName:"Test project",root:"C:/isolated/project",digest:"a".repeat(64),actions:[...value.files.map((f:any)=>({kind:"file",path:f.path,content:f.content,status:"create"})),...value.memories.map((m:any)=>({kind:"memory",path:`projects/p1/${m.category}/${m.filename}`,content:m.content,status:"create"}))],...(audit.agent&&value.agentFile?.enabled?{agentFile:{filename:value.agentFile.filename,exists:false,shadowed:false,prompt:"PROMPT"}}:{})};},
 async apply(input:any){audit.applies.push(input);if(audit.failApply)throw Error("STALE_PREVIEW");const p=await this.preview(input);return {projectId:"p1",root:p.root,actions:p.actions.map((a:any)=>({...a,status:"created"})),...(p.agentFile?{agentPrompt:p.agentFile.prompt,agentFilename:p.agentFile.filename}:{})};},
}};
export const useSessionStore=create(()=>({locale:"en"}));
export const useToastStore=create(()=>({push(value:any){if(value.kind!=="error")throw Error("Invalid toast contract");audit.toasts.push(value);}}));
export const translate=(_locale:string,key:string,args?:Record<string,unknown>)=>t(key,args);
const common:Record<string,string>={"common.save":"Save","common.delete":"Delete","common.cancel":"Cancel","common.close":"Close","common.loading":"Loading"};
function t(key:string,args?:Record<string,unknown>){let value=(en as Record<string,string>)[key]??common[key]??key;for(const [k,v] of Object.entries(args??{}))value=value.replaceAll(`{${k}}`,String(v));return value;}
export const useI18n=()=>({t,locale:"en"});
Object.assign(window,{api:new URLSearchParams(location.search).has("mobile")?undefined:api,__audit:audit});
