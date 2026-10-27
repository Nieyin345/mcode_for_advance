/** F033: real VS Code diagnostic collection -> Monaco model markers.
 * A single App-root push subscription retains diagnostics when the editor tab
 * is closed; every mounted Mcode Monaco applies only its own file's markers.
 * No second Monaco model, language server or polling loop is created.
 */
import type * as Monaco from "monaco-editor";
import {useEffect} from "react";
import {api} from "@renderer/lib/api.js";
import type {TheiaDiagnosticsEvent,TheiaExtensionDiagnostic} from "@contracts/ipc/modules.js";

interface RecordEntry {owner:string;file:string;markers:TheiaExtensionDiagnostic[]}
const entries=new Map<string,RecordEntry>();
const updateListeners=new Set<()=>void>();
function resolveFile(uri:string):string|null{
  try{
    const parsed=new URL(uri);
    if(parsed.protocol!=="file:"||parsed.hostname&&parsed.hostname!=="localhost")return null;
    return decodeURIComponent(parsed.pathname).replace(/^\/([A-Za-z]:)/,"$1");
  }catch{return null;}
}
function canonical(file:string):string{
  const normalized=file.replace(/\\/g,"/");
  return /^([A-Za-z]:)/.test(normalized)?normalized.toLowerCase():normalized;
}
export function receiveTheiaDiagnostics(event:TheiaDiagnosticsEvent):void {
  if(event.channel!=="modules:theiaDiagnostics")return;
  const prefix=event.sessionId+":"+event.collectionId+":";
  if(event.removed){
    for(const key of entries.keys()){
      if(event.collectionId==="*"?key.startsWith(event.sessionId+":"):key.startsWith(prefix))entries.delete(key);
    }
  }else{
    const file=resolveFile(event.resource);
    if(!file)return;
    const key=prefix+canonical(file);
    if(!event.markers.length)entries.delete(key);
    else if(entries.has(key)||entries.size<600)entries.set(key,{
      owner:event.sessionId+":"+event.collectionId,file:canonical(file),
      markers:event.markers.slice(0,250),
    });
  }
  for(const listener of updateListeners)listener();
}
export function TheiaDiagnosticsHost(){
  useEffect(()=>api.on.theiaDiagnostics(receiveTheiaDiagnostics),[]);
  return null;
}
export function registerTheiaDiagnosticMarkers(
  editor:Monaco.editor.IStandaloneCodeEditor,monaco:typeof Monaco,
  currentFile:()=>string|null,
):()=>void{
  const touched=new Map<Monaco.editor.ITextModel,Set<string>>();
  const update=()=>{
    const model=editor.getModel(),file=currentFile();
    if(!model||!file)return;
    const target=canonical(file);
    let owners=touched.get(model);
    if(!owners){owners=new Set();touched.set(model,owners);}
    const live=new Set<string>();
    for(const {owner,file:src,markers} of entries.values()){
      if(src!==target)continue;
      live.add("mcode-theia:"+owner);
      const result:Monaco.editor.IMarkerData[]=markers.map(m=>({
        startLineNumber:m.startLineNumber,startColumn:m.startColumn,
        endLineNumber:m.endLineNumber,endColumn:m.endColumn,
        severity:m.severity,message:m.message,
        ...(m.source?{source:m.source}:{}),...(m.code?{code:m.code}:{}),
      }));
      monaco.editor.setModelMarkers(model,"mcode-theia:"+owner,result);
    }
    for(const previous of owners)if(!live.has(previous))monaco.editor.setModelMarkers(model,previous,[]);
    touched.set(model,live);
  };
  updateListeners.add(update);
  /* ⚠️ `onDidChangeModel` 不是所有 IStandaloneCodeEditor 实现都有 ——
   * 无头套件的 mock editor 就是合法的一种（它只需 getModel / onDidChangeModelDecorations
   * 里的子集）。硬调会让「注册诊断」这一步把整个挂载流程炸掉：
   * `ide-quote-snapshot-smoke` 就是这么崩的（`editor.onDidChangeModel is not a function`
   * → onMount 抛错 → 整棵编辑器树不渲染）。
   *
   * 没有它就退化成「只在 update() 时刷一次 + 订阅推送时刷」——**功能降级，不是错误**：
   * 换模型时会由 `receiveTheiaDiagnostics` 的推送路径补上。
   */
  const off = typeof editor.onDidChangeModel === "function"
    ? editor.onDidChangeModel(update)
    : { dispose() {} };
  update();
  return ()=>{
    off.dispose();updateListeners.delete(update);
    for(const [model,owners] of touched){
      if(model.isDisposed())continue;
      for(const owner of owners)monaco.editor.setModelMarkers(model,owner,[]);
    }
    touched.clear();
  };
}
