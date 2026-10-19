import {errText,describeInputError} from "@main/lib/ipcError.js";
import {z} from "zod";
let n=0,f=0; const ck=(s:string,ok:boolean,ctx?:unknown)=>{n++;console.log((ok?"ok":"FAIL")+" "+s+(ok?"":" "+String(ctx)));if(!ok)f++};
const p=z.object({age:z.number()}).safeParse({age:"wrong"});
ck("invalid object gives zod issue",!p.success && describeInputError(p.error).includes("age"));
ck("normal Error message stays unchanged",errText(new Error("safe business error"))==="safe business error");
const nullProto=Object.create(null) as object;
let safe="";
try{safe=errText(nullProto);}catch{safe="THREW";}
ck("★ null-prototype failure does not rethrow from IPC error handler",safe!=="THREW");
const evil={toString(){throw new Error("nested coercion failure");}};
let adversarial="";
try{adversarial=errText(evil);}catch{adversarial="THREW";}
ck("★ malicious error toString cannot throw again",adversarial!=="THREW");
ck("normal string passthrough",errText("timeout")==="timeout");
ck("null exception has safe readable message",errText(null)==="null");
console.log("ipc-error-boundary-smoke:"+(n-f)+"/"+n+" PASS");
if(f)process.exitCode=1;
