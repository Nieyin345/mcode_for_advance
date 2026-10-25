/** F034: Actual VS Code hover/completion contributions go to Mcode's Monaco.
 * No parallel editor/workbench. The editor's current in-memory buffer is the
 * only source, and an unchanged model is not re-sent on every hover.
 */
import type * as Monaco from "monaco-editor";
import {api} from "@renderer/lib/api.js";
import {snapshotTheiaMonaco} from "./theiaMonacoOwner.js";
import {gotoLocation} from "./lspProviders.js";
import type {TheiaInstalledEntry,TheiaLanguageProviderKind} from "@contracts/ipc/modules.js";

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
  type NativeLocation={uri:Monaco.Uri;range:{
    startLineNumber:number;startColumn:number;endLineNumber:number;endColumn:number;
  }};
  const samePath=(left:string,right:string)=>{
    const a=left.replace(/\\/g,"/"),b=right.replace(/\\/g,"/");
    const windows=/^[a-z]:\//i.test(a)||/^[a-z]:\//i.test(b);
    return windows?a.toLowerCase()===b.toLowerCase():a===b;
  };
  const nativePath=(uri:Monaco.Uri)=>{
    const path=uri.fsPath;
    return path.replace(/^([a-z]):(?=[\\/])/i,(_match,drive:string)=>drive.toUpperCase()+":");
  };
  const queryLocations=async(sessionId:string,query:Exclude<TheiaLanguageProviderKind,"hover"|"completion">,
    model:Monaco.editor.ITextModel,position:Monaco.Position,token:Monaco.CancellationToken,
    includeDeclaration?:boolean
  ):Promise<NativeLocation[]|null>=>{
    const version=model.getVersionId();
    if(!live||token.isCancellationRequested||!await sync(sessionId,model))return null;
    try{
      const result=await api.modules.theiaInstalled({op:"languageQuery",sessionId,query,
        lineNumber:position.lineNumber,column:position.column,
        ...(includeDeclaration===undefined?{}:{includeDeclaration})});
      if(result.kind!=="languageResult"||token.isCancellationRequested||
        model!==instance.getModel()||model.getVersionId()!==version)return null;
      const locations:NativeLocation[]=[];
      for(const item of result.locations??[]){
        if(locations.length>=100)break;
        const uri=monaco.Uri.parse(item.uri);
        if(uri.scheme!=="file")continue;
        const {start,end}=item.range;
        if(![start.line,start.character,end.line,end.character].every(Number.isSafeInteger)||
          start.line<0||start.character<0||end.line<start.line||
          (end.line===start.line&&end.character<start.character))continue;
        locations.push({uri,range:{startLineNumber:start.line+1,startColumn:start.character+1,
          endLineNumber:end.line+1,endColumn:end.character+1}});
      }
      return locations;
    }catch{return null;}
  };
  const nativeNavigation=async(sessionId:string,kind:"definition"|"implementation"|"typeDefinition",
    model:Monaco.editor.ITextModel,position:Monaco.Position,token:Monaco.CancellationToken
  )=>{
    const locations=await queryLocations(sessionId,kind,model,position,token);
    if(!locations?.length)return null;
    const snapshot=snapshotTheiaMonaco();
    if(!snapshot)return null;
    const first=locations[0];
    if(!samePath(first.uri.fsPath,snapshot.filePath)){
      gotoLocation(nativePath(first.uri),first.range.startLineNumber,first.range.startColumn);
      return null;
    }
    return locations.map(location=>({...location,
      uri:samePath(location.uri.fsPath,snapshot.filePath)?model.uri:location.uri}));
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
        const languages=new Map<string,Set<TheiaLanguageProviderKind>>();
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
          if(kinds.has("definition"))registered.push(monaco.languages.registerDefinitionProvider(selector,{
            provideDefinition:(model,position,token)=>
              nativeNavigation(active.sessionId,"definition",model,position,token),
          }));
          if(kinds.has("references"))registered.push(monaco.languages.registerReferenceProvider(selector,{
            provideReferences:async(model,position,context,token)=>{
              const locations=await queryLocations(active.sessionId,"references",model,position,token,
                context.includeDeclaration);
              if(!locations?.length)return null;
              const snapshot=snapshotTheiaMonaco();
              return locations.map(location=>({...location,
                uri:snapshot&&samePath(location.uri.fsPath,snapshot.filePath)?model.uri:location.uri}));
            },
          }));
          if(kinds.has("implementation"))registered.push(monaco.languages.registerImplementationProvider(selector,{
            provideImplementation:(model,position,token)=>
              nativeNavigation(active.sessionId,"implementation",model,position,token),
          }));
          if(kinds.has("typeDefinition"))registered.push(monaco.languages.registerTypeDefinitionProvider(selector,{
            provideTypeDefinition:(model,position,token)=>
              nativeNavigation(active.sessionId,"typeDefinition",model,position,token),
          }));
        }
      }
    }catch{/* Mcode code editor must work even with an unavailable extension host. */}
  };
  const unsubscribe=api.on.theiaContributionChanged(()=>{void refresh();});
  void refresh();
  return ()=>{live=false;serial++;unsubscribe();for(const item of registered)item.dispose();recent.clear();inFlight.clear();};
}
