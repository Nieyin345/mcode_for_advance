/** F031 - Live VS Code notification actions, owned by one verified Mcode sender.
 * UI can disappear; messages time out and never hold an extension indefinitely.
 * Does not start a process, poll or persist extension choices.
 */
import {randomUUID} from "node:crypto";
import type {TheiaRuntimeMessage} from "@contracts/ipc/modules.js";
export interface RuntimeMessageInput {
  type:number;message:string;detail?:string;modal?:boolean;actions?:readonly string[];
}
interface Waiting {
  senderId:number;sessionId:string;actionCount:number;
  resolve:(index:number|undefined)=>void;timer:NodeJS.Timeout;
}
export class TheiaRuntimeMessageBroker {
  private readonly waiting=new Map<string,Waiting>();
  constructor(private readonly timeoutMs=30000) {}
  request(senderId:number,sessionId:string,extensionId:string,input:RuntimeMessageInput,
    send:(payload:TheiaRuntimeMessage)=>void):Promise<number|undefined>{
    if(this.waiting.size>=16)return Promise.resolve(undefined);
    const actions=(input.actions??[]).slice(0,8).map(v=>String(v).slice(0,100));
    const modal=input.modal===true;
    const needsResponse=modal||actions.length>0;
    const requestId=randomUUID();
    const msg:TheiaRuntimeMessage={
      channel:"modules:theiaRuntimeMessage",requestId,sessionId,extensionId:extensionId.slice(0,225),
      kind:input.type===0?"error":input.type===1?"warning":"info",
      message:String(input.message).slice(0,4000),
      ...(input.detail?{detail:input.detail.slice(0,4000)}:{}),
      modal,actions,
    };
    if(!needsResponse){
      try{send(msg);}catch{ /* closed renderer - nothing to acknowledge */ }
      return Promise.resolve(undefined);
    }
    return new Promise<number|undefined>(resolve=>{
      const timer=setTimeout(()=>this.finish(requestId,undefined),this.timeoutMs);
      timer.unref?.();
      this.waiting.set(requestId,{senderId,sessionId,actionCount:actions.length,resolve,timer});
      try{send(msg);}catch{this.finish(requestId,undefined);}
    });
  }
  respond(senderId:number,sessionId:string,requestId:string,choice:number|null):boolean{
    const pending=this.waiting.get(requestId);
    if(!pending||pending.senderId!==senderId||pending.sessionId!==sessionId)return false;
    if(choice!==null&&(!Number.isSafeInteger(choice)||choice<0||choice>=pending.actionCount))return false;
    this.finish(requestId,choice===null?undefined:choice);
    return true;
  }
  cancelSession(senderId:number,sessionId:string):void{
    for(const [id,p] of this.waiting)if(p.senderId===senderId&&p.sessionId===sessionId)this.finish(id,undefined);
  }
  cancelSender(senderId:number):void{
    for(const [id,p] of this.waiting)if(p.senderId===senderId)this.finish(id,undefined);
  }
  cancelAll():void{for(const id of this.waiting.keys())this.finish(id,undefined);}
  private finish(id:string,value:number|undefined):void{
    const pending=this.waiting.get(id);
    if(!pending)return;
    this.waiting.delete(id);clearTimeout(pending.timer);pending.resolve(value);
  }
  get pendingCount():number{return this.waiting.size;}
}
