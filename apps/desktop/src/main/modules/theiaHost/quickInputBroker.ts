/** F032: typed, bounded Quick Pick/Input Box requests. No polling or window-global hooks. */
import {randomUUID} from "node:crypto";
import type {TheiaQuickInputRequest} from "@contracts/ipc/modules.js";
type Choice=string|number[]|undefined;
interface Pending {
  senderId:number;sessionId:string;request:TheiaQuickInputRequest;resolve:(choice:Choice)=>void;
  timer:NodeJS.Timeout;
}
export class TheiaQuickInputBroker {
  private pending=new Map<string,Pending>();
  constructor(private readonly timeoutMs=45000){}
  request(senderId:number,sessionId:string,extensionId:string,
    input:Omit<TheiaQuickInputRequest,"channel"|"requestId"|"sessionId"|"extensionId">,
    send:(request:TheiaQuickInputRequest)=>void):Promise<Choice>{
    if(this.pending.size>=8)return Promise.resolve(undefined);
    const requestId=randomUUID();
    const items=input.items?.slice(0,200).map(it=>({
      label:String(it.label).slice(0,300),
      ...(it.description?{description:String(it.description).slice(0,500)}:{}),
      ...(it.detail?{detail:String(it.detail).slice(0,500)}:{}),
    }));
    const request:TheiaQuickInputRequest={
      channel:"modules:theiaQuickInput",requestId,sessionId,
      extensionId:extensionId.slice(0,225),kind:input.kind,
      ...(input.title?{title:input.title.slice(0,300)}:{}),
      ...(input.placeholder?{placeholder:input.placeholder.slice(0,300)}:{}),
      ...(input.value?{value:input.value.slice(0,4096)}:{}),
      password:input.password===true,canPickMany:input.canPickMany===true,
      ...(items?{items}:{}),
    };
    return new Promise(resolve=>{
      const timer=setTimeout(()=>this.finish(requestId,undefined),this.timeoutMs);
      timer.unref?.();
      this.pending.set(requestId,{senderId,sessionId,request,resolve,timer});
      try{send(request);}catch{this.finish(requestId,undefined);}
    });
  }
  respond(senderId:number,sessionId:string,requestId:string,choice:string|number[]|null):boolean{
    const entry=this.pending.get(requestId);
    if(!entry||entry.senderId!==senderId||entry.sessionId!==sessionId)return false;
    if(choice!==null){
      if(entry.request.kind==="input"){
        if(typeof choice!=="string"||choice.length>4096)return false;
      }else{
        if(!Array.isArray(choice)||choice.length>50||(!entry.request.canPickMany&&choice.length>1)
          ||choice.some(i=>!Number.isSafeInteger(i)||i<0||i>=(entry.request.items?.length??0))
          ||new Set(choice).size!==choice.length)return false;
      }
    }
    this.finish(requestId,choice??undefined);
    return true;
  }
  cancelSession(senderId:number,sessionId:string):void{
    for(const [id,p] of this.pending)if(p.senderId===senderId&&p.sessionId===sessionId)this.finish(id,undefined);
  }
  cancelSender(senderId:number):void{
    for(const [id,p] of this.pending)if(p.senderId===senderId)this.finish(id,undefined);
  }
  private finish(id:string,value:Choice):void{
    const p=this.pending.get(id);if(!p)return;
    clearTimeout(p.timer);this.pending.delete(id);p.resolve(value);
  }
  get size():number{return this.pending.size;}
}
