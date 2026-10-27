/** F032: register supported VS Code editor/context contributions directly on
 * Mcode's REAL Monaco editor. No second Theia workbench or popup.
 */
import type {editor} from "monaco-editor";
import {api} from "@renderer/lib/api.js";
import {executeTheiaWithMonaco} from "@renderer/lib/theiaMonacoOwner.js";
import {useToastStore} from "@renderer/stores/toastStore.js";
export function registerTheiaEditorMenus(instance:editor.IStandaloneCodeEditor):()=>void{
  let alive=true,epoch=0;
  let registrations:Array<{dispose():void}>=[];
  const refresh=async()=>{
    const myEpoch=++epoch;
    const next:Array<{dispose():void}>=[];
    try {
      const result=await api.modules.theiaInstalled({op:"list"});
      if(!alive||epoch!==myEpoch)return;
      if(result.kind!=="list")throw Error("扩展命令列表不可用");
      for(const extension of result.items){
        const session=extension.activeSession;
        if(!session||!extension.enabled||!extension.running)continue;
        for(const menu of session.editorMenus??[]){
          if(!session.commands.includes(menu.commandId))continue;
          const commandId=menu.commandId,sessionId=session.sessionId;
          try{
            next.push(instance.addAction({
              id:"mcode-theia:"+extension.id+":"+commandId+":"+encodeURIComponent(menu.group??"")+":"+encodeURIComponent(menu.when??""),
              label:menu.label,contextMenuGroupId:menu.group??"9_theia",
              ...(menu.when?{precondition:menu.when}:{}),
              run:async()=>{
                try{
                  await executeTheiaWithMonaco(input=>api.modules.theiaInstalled(input),sessionId,commandId);
                }catch(err){
                  useToastStore.getState().push({
                    kind:"error",title:menu.label,
                    body:err instanceof Error?err.message:String(err),
                  });
                }
              }
            }));
          }catch{/* Unsupported context-key syntax must not remove other valid menu actions. */}
        }
      }
      if(!alive||epoch!==myEpoch){for(const entry of next)entry.dispose();return;}
      for(const old of registrations)old.dispose();
      registrations=next;
    }catch{
      for(const entry of next)entry.dispose();
      if(!alive||epoch!==myEpoch)return;
      // Do not leave dead extension actions in Monaco after a failed refresh.
      for(const old of registrations)old.dispose();
      registrations=[];
    }
  };
  const off=api.on.theiaContributionChanged(()=>{void refresh();});
  void refresh();
  return ()=>{alive=false;epoch++;off();for(const old of registrations)old.dispose();registrations=[];};
}
