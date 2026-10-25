/** F029: bounded, sender-scoped round trip from Theia TextEditor.edit to
 * the REAL desktop Monaco editor owner. The main process never applies disk edits.
 */
import {randomUUID} from "node:crypto";
import type {EditorEditTransaction} from "./editorTransactions.js";
import type {TheiaMonacoEditRequest} from "@contracts/ipc/modules.js";
interface Pending {
  senderId:number;sessionId:string;resolve:(accepted:boolean)=>void;timeout:NodeJS.Timeout;
}
export class TheiaEditorApplyBroker {
  private pending=new Map<string,Pending>();
  constructor(private readonly timeoutMs=6000){}
  request(senderId:number,sessionId:string,transaction:EditorEditTransaction,
    deliver:(msg:TheiaMonacoEditRequest)=>void):Promise<boolean>{
    if(this.pending.size>=16)return Promise.resolve(false);
    const requestId=randomUUID();
    return new Promise<boolean>(resolve=>{
      const timeout=setTimeout(()=>{this.finish(requestId,false);},this.timeoutMs);
      timeout.unref?.();
      this.pending.set(requestId,{senderId,sessionId,resolve,timeout});
      try {
        deliver({channel:"modules:theiaEditorApply",requestId,sessionId,
          transaction:{...transaction,edits:transaction.edits.map(e=>({...e,range:{...e.range}}))}});
      }catch{this.finish(requestId,false);}
    });
  }
  acknowledge(senderId:number,sessionId:string,requestId:string,accepted:boolean):boolean{
    const item=this.pending.get(requestId);
    if(!item||item.senderId!==senderId||item.sessionId!==sessionId)return false;
    this.finish(requestId,accepted===true);
    return true;
  }
  cancelSession(senderId:number,sessionId:string):void{
    for(const [requestId,item] of this.pending)
      if(item.senderId===senderId&&item.sessionId===sessionId)this.finish(requestId,false);
  }
  cancelSender(senderId:number):void{
    for(const [requestId,item] of this.pending)
      if(item.senderId===senderId)this.finish(requestId,false);
  }
  private finish(requestId:string,result:boolean):void{
    const item=this.pending.get(requestId);
    if(!item)return;
    this.pending.delete(requestId);clearTimeout(item.timeout);
    item.resolve(result);
  }
  get size():number{return this.pending.size;}
}
