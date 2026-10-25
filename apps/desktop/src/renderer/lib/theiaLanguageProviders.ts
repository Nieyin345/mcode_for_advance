/** F034: Actual VS Code hover/completion contributions go to Mcode's Monaco.
 * No parallel editor/workbench. The editor's current in-memory buffer is the
 * only source, and an unchanged model is not re-sent on every hover.
 */
import type * as Monaco from "monaco-editor";
import {api} from "@renderer/lib/api.js";
import {snapshotTheiaMonaco} from "./theiaMonacoOwner.js";
import type {TheiaInstalledEntry} from "@contracts/ipc/modules.js";

export function registerTheiaLanguageProviders(instance:Monaco.editor.IStandaloneCodeEditor,
  monaco:typeof Monaco):()=>void{
  let live=true,serial=0;
  const registered:Array<{dispose():void}>=[];
  const recent=new Map<string,string>();
  const inFlight=new Map<string,{revision:string;promise:Promise<boolean>}>();
  let sessions:TheiaInstalledEntry[]=[];
  const sync=async(sessionId:string,model:Monaco.editor.ITextModel)=>{
    const snapshot=snapshotTheiaMonaco();
    if(!snapshot||model!==instance.getModel()||snapshot.languageId!==model.getLanguageId()||
      snapshot.text!==model.getValue()||snapshot.text.length>2_000_000)return false;
    const modelVersion=model.getVersionId();
    const revision=snapshot.filePath+":"+modelVersion+":"+snapshot.text.length;
    if(recent.get(sessionId)===revision)return true;
    const existing=inFlight.get(sessionId);
    if(existing){
      const previous=await existing.promise;
      if(existing.revision===revision)return previous;
      // A newer document/version must wait for the older IPC roundtrip
      // before syncing. Otherwise the manager correctly rejects the second
      // concurrent editorSync and the newer completion is silently lost.
      if(!live||model!==instance.getModel()||model.getVersionId()!==modelVersion)return false;
      return sync(sessionId,model);
    }
    const pending=(async()=>{
      try{
        const outcome=await api.modules.theiaInstalled({op:"editorSync",sessionId,editor:snapshot});
        if(outcome.kind!=="editorSynced")return false;
        if(!live||model!==instance.getModel()||model.getVersionId()!==modelVersion)return false;
        recent.set(sessionId,revision);
        return true;
      }catch{return false;}
    })();
    inFlight.set(sessionId,{revision,promise:pending});
    try{return await pending;}
    finally{if(inFlight.get(sessionId)?.promise===pending)inFlight.delete(sessionId);}
  };
  const refresh=async()=>{
    const epoch=++serial;
    try{
      const response=await api.modules.theiaInstalled({op:"list"});
      if(!live||serial!==epoch||response.kind!=="list")return;
      for(const disposable of registered)disposable.dispose();
      registered.length=0;recent.clear();inFlight.clear();
      sessions=response.items.filter(s=>s.enabled&&s.running&&s.activeSession);
      for(const record of sessions){
        const active=record.activeSession!;
        const languages=new Map<string,Set<"hover"|"completion">>();
        for(const spec of active.languageProviders??[]){
          const lang=spec.language||"*";
          if(!languages.has(lang))languages.set(lang,new Set());
          languages.get(lang)!.add(spec.kind);
        }
        for(const [language,kinds] of languages){
          const selector=language==="*"?{pattern:"**/*"}:language;
          if(kinds.has("hover"))registered.push(monaco.languages.registerHoverProvider(selector,{
            provideHover:async(model,position,token)=>{
              if(!live||token.isCancellationRequested||!await sync(active.sessionId,model))return undefined;
              try {
                const result=await api.modules.theiaInstalled({op:"languageQuery",
                  sessionId:active.sessionId,query:"hover",
                  lineNumber:position.lineNumber,column:position.column});
                if(result.kind!=="languageResult"||!result.contents.length||token.isCancellationRequested)return undefined;
                return {contents:result.contents.map(value=>({value}))};
              }catch{return undefined;}
            },
          }));
          if(kinds.has("completion"))registered.push(monaco.languages.registerCompletionItemProvider(selector,{
            provideCompletionItems:async(model,position,_context,token)=>{
              if(!live||token.isCancellationRequested||!await sync(active.sessionId,model))
                return {suggestions:[]};
              try{
                const result=await api.modules.theiaInstalled({op:"languageQuery",
                  sessionId:active.sessionId,query:"completion",
                  lineNumber:position.lineNumber,column:position.column});
                if(result.kind!=="languageResult"||token.isCancellationRequested)return {suggestions:[]};
                const word=model.getWordUntilPosition(position);
                const range={startLineNumber:position.lineNumber,endLineNumber:position.lineNumber,
                  startColumn:word.startColumn,endColumn:word.endColumn};
                return {suggestions:result.suggestions.map(item=>({
                  label:item.label,insertText:item.insertText,kind:item.kind,
                  ...(item.detail?{detail:item.detail}:{}),range,
                }))};
              }catch{return {suggestions:[]};}
            }
          }));
        }
      }
    }catch{/* Mcode code editor must work even with an unavailable extension host. */}
  };
  const unsubscribe=api.on.theiaContributionChanged(()=>{void refresh();});
  void refresh();
  return ()=>{live=false;serial++;unsubscribe();for(const item of registered)item.dispose();recent.clear();inFlight.clear();};
}
