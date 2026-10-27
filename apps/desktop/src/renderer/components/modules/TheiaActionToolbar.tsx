/** Manifest-declared VS Code actions rendered as native Mcode titlebar buttons.
 * Only verified, running sessions contribute actions; clicking always crosses
 * the authenticated Theia IPC and never evaluates extension-controlled markup.
 */
import {useEffect,useMemo,useRef,useState} from "react";
import type {TheiaInstalledEntry,TheiaUiContribution} from "@contracts/ipc/theia.js";
import {api} from "@renderer/lib/api.js";
import {IconPuzzle} from "@renderer/lib/icons.js";
import {useToastStore} from "@renderer/stores/toastStore.js";
import {executeTheiaWithMonaco} from "@renderer/lib/theiaMonacoOwner.js";

interface ToolbarAction extends TheiaUiContribution {
  key:string;extensionId:string;sessionId:string;
}
type ContextValue=string|boolean;
type WhenContext=Record<string,ContextValue>;
function splitWhen(expression:string,operator:"&&"|"||"):string[]{
  const parts:string[]=[];let depth=0,quote="",escaped=false,start=0;
  for(let i=0;i<expression.length;i++){
    const char=expression[i]!;
    if(quote){if(escaped)escaped=false;else if(char==="\\")escaped=true;else if(char===quote)quote="";continue;}
    if(char==="\""||char==="\'"){quote=char;continue;}
    if(char==="("){depth++;continue;}if(char===")"){depth--;continue;}
    if(depth===0&&expression.startsWith(operator,i)){
      parts.push(expression.slice(start,i).trim());i+=operator.length-1;start=i+1;
    }
  }
  if(parts.length)parts.push(expression.slice(start).trim());
  return parts.length?parts:[expression.trim()];
}
function unwrapWhen(expression:string):string{
  let value=expression.trim();
  while(value.startsWith("(")&&value.endsWith(")")){
    let depth=0,quote="",escaped=false,outer=true;
    for(let i=0;i<value.length;i++){
      const char=value[i]!;
      if(quote){if(escaped)escaped=false;else if(char==="\\")escaped=true;else if(char===quote)quote="";continue;}
      if(char==="\""||char==="\'"){quote=char;continue;}
      if(char==="(")depth++;else if(char===")"&&--depth===0&&i<value.length-1){outer=false;break;}
    }
    if(!outer)break;value=value.slice(1,-1).trim();
  }
  return value;
}
function matchesWhen(expression:string|undefined,context:WhenContext):boolean{
  if(!expression||expression.trim()==="true")return true;
  const value=unwrapWhen(expression);
  if(value==="false"||!value)return false;
  const orParts=splitWhen(value,"||");
  if(orParts.length>1)return orParts.some(part=>matchesWhen(part,context));
  const andParts=splitWhen(value,"&&");
  if(andParts.length>1)return andParts.every(part=>matchesWhen(part,context));
  if(value.startsWith("!")&&!value.startsWith("!="))return !matchesWhen(value.slice(1),context);
  const comparison=value.match(/^([A-Za-z_][\w.]*)\s*(==|!=)\s*(?:"([^"]*)"|'([^']*)'|([^\s()]+))$/);
  if(comparison){
    const actual=context[comparison[1]!];if(actual===undefined)return false;
    const expected=comparison[3]??comparison[4]??comparison[5]??"";
    return comparison[2]==="=="?String(actual)===expected:String(actual)!==expected;
  }
  return context[value]===true;
}

export function TheiaActionToolbar({placement="toolbar",filePath,languageId}:{
  placement?:"toolbar"|"editor";filePath?:string;languageId?:string;
}={}){
  const [entries,setEntries]=useState<TheiaInstalledEntry[]>([]);
  const [busyAction,setBusyAction]=useState<string|null>(null);
  const busyRef=useRef(false);

  useEffect(()=>{
    let alive=true,epoch=0;
    const refresh=async()=>{
      const current=++epoch;
      try{
        const result=await api.modules.theiaInstalled({op:"list"});
        if(alive&&current===epoch&&result.kind==="list")setEntries(result.items);
      }catch{
        if(alive&&current===epoch)setEntries([]);
      }
    };
    // Listing never starts extensions; the initial snapshot restores already-running
    // sessions after renderer remounts, while invalidations keep actions in sync.
    const unsubscribe=api.on.theiaContributionChanged(()=>{void refresh();});
    void refresh();
    return ()=>{alive=false;epoch++;unsubscribe();};
  },[]);

  const actions=useMemo<ToolbarAction[]>(()=>{
    const filename=(filePath??"").replace(/\\/g,"/").split("/").at(-1)??"";
    const fileExtension=filename.includes(".")?filename.slice(filename.lastIndexOf(".")):"";
    const context:WhenContext={editorTextFocus:placement==="editor",editorLangId:languageId??"",
      resourceLangId:languageId??"",resourceExtname:fileExtension.toLowerCase(),
      resourceFilename:filename,resourceScheme:"file"};
    const result:ToolbarAction[]=[];
    const seenCommands=new Set<string>();
    for(const installed of entries){
      const session=installed.activeSession;
      if(!installed.enabled||installed.corrupted||!installed.running||!session)continue;
      for(const contribution of session.uiContributions??[]){
        const commandKey=installed.id+":"+contribution.commandId;
        if(contribution.placement!==placement||!session.commands.includes(contribution.commandId)||
          seenCommands.has(commandKey)||!matchesWhen(contribution.when,context))continue;
        seenCommands.add(commandKey);
        result.push({...contribution,key:installed.id+":"+contribution.placement+":"+contribution.commandId+
          ":"+(contribution.when??"")+":"+(contribution.group??""),
          extensionId:installed.extensionId,sessionId:session.sessionId});
      }
    }
    return result.slice(0,40);
  },[entries,placement,filePath,languageId]);

  const run=(action:ToolbarAction)=>async()=>{
    if(busyRef.current)return;
    busyRef.current=true;
    setBusyAction(action.key);
    try{
      const result=await executeTheiaWithMonaco(
        input=>api.modules.theiaInstalled(input),action.sessionId,action.commandId);
      if(result.kind!=="executed")throw Error("扩展命令未完成");
      const body=String(result.result??"").trim();
      if(body)useToastStore.getState().push({kind:"info",title:action.label,body:body.slice(0,700)});
    }catch(error){
      useToastStore.getState().push({
        kind:"error",title:action.extensionId+" · "+action.label,
        body:error instanceof Error?error.message:String(error),
      });
    }finally{
      busyRef.current=false;
      setBusyAction(null);
    }
  };

  if(!actions.length)return null;
  return <div data-testid={`theia-ui-contribution-${placement}`}
    className={`flex shrink-0 items-center gap-1 overflow-x-auto ${placement==="editor"?"max-w-[min(40vw,520px)]":"max-w-[min(20vw,280px)]"}`}
    role="group" aria-label={placement==="editor"?"扩展提供的编辑器操作":"扩展提供的 Mcode 操作"}>
    {actions.map(action=><button type="button" key={action.key}
      disabled={busyAction!==null}
      aria-busy={busyAction===action.key}
      data-testid={`theia-ui-contribution-action-${placement}`}
      title={action.extensionId+" · "+action.label}
      aria-label={action.extensionId+" · "+action.label}
      onClick={run(action)}
      className="flex h-7 max-w-32 shrink-0 items-center gap-1 rounded-[var(--radius-btn-md)] border border-edge/70 px-2 text-[11px] font-medium text-content-muted transition-colors hover:bg-surface-hover active:bg-surface-active hover:text-content focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      style={{WebkitAppRegion:"no-drag"} as React.CSSProperties}>
      <IconPuzzle size={13} className="shrink-0"/>
      <span className="truncate">{action.label}</span>
    </button>)}
  </div>;
}
