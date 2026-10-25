/** F029: the ONLY owner of Theia-mediated edits is the current Mcode Monaco instance.
 * This is not a second editor model. Nothing here reads/writes disk or starts a host.
 * Synchronous snapshot and undoable edits are bound to a mounted, active editor.
 */
import type { TheiaMonacoEditorSnapshot, TheiaMonacoEditRequest, TheiaInstalledInput, TheiaInstalledResult } from "@contracts/ipc/modules.js";
import type { editor } from "monaco-editor";

type Model = editor.ITextModel;
type Editor = editor.IStandaloneCodeEditor;
interface ActiveMonaco { editor:Editor; model:Model; filePath:string }
type Reader=()=>ActiveMonaco|null;
let activeReader:Reader|null=null;

/** EditPane mounts one permanent Monaco editor, but its model/path change across file tabs.
 * Read the CURRENT owner on every request. On teardown, deregister the exact same callback.
 */
export function registerTheiaMonacoOwner(read:Reader):()=>void {
  activeReader=read;
  return ()=>{if(activeReader===read)activeReader=null;};
}
function active():ActiveMonaco|null {
  const a=activeReader?.()??null;
  if(!a||a.model.isDisposed()||a.editor.getModel()!==a.model)return null;
  return a;
}
export function snapshotTheiaMonaco():TheiaMonacoEditorSnapshot|null {
  const a=active();
  if(!a)return null;
  const text=a.model.getValue();
  if(text.length>2_000_000)throw Error("编辑器文本超过 Theia 交互上限（2 百万 UTF-16 字符）");
  const selection=a.editor.getSelection();
  const point=(lineNumber:number,column:number)=>({line:lineNumber-1,character:column-1});
  return {filePath:a.filePath,languageId:a.model.getLanguageId(),text,
    ...(selection?{selection:{
      start:point(selection.startLineNumber,selection.startColumn),
      end:point(selection.endLineNumber,selection.endColumn),
    }}:{})};
}

/** No callback may claim a successful edit unless the actual Monaco model changed.
 * Monaco's edit operations also drive Mcode dirty tracking / LSP / undo; NEVER use setValue.
 */
export function applyTheiaMonacoEdit(request:TheiaMonacoEditRequest["transaction"]):boolean {
  const a=active();
  if(!a||a.filePath!==request.filePath||a.editor.getRawOptions().readOnly||
     a.model.getValue()!==request.beforeText||
     request.beforeText.length>2_000_000||request.afterText.length>2_000_000||
     !Array.isArray(request.edits)||request.edits.length===0||request.edits.length>500)return false;
  try {
    // Refuse a snapshot that became stale even while preparing the transaction.
    if(a.model.getValue()!==request.beforeText)return false;
    if(request.undoStopBefore)a.editor.pushUndoStop();
    const ok=a.editor.executeEdits("mcode-theia",request.edits.map(e=>({
      range:e.range,text:e.text,forceMoveMarkers:false,
    })));
    if(!ok)return false;
    if(request.undoStopAfter)a.editor.pushUndoStop();
    return a.model.getValue()===request.afterText;
  }catch{return false;}
}
export interface TheiaEditorTransport {
  invoke:(input:TheiaInstalledInput)=>Promise<TheiaInstalledResult>;
  subscribe:(handler:(request:TheiaMonacoEditRequest)=>void)=>()=>void;
}
/** ONE event listener per EditPane; all messages answered via the existing secured IPC. */
export function subscribeTheiaMonacoEdits(transport:TheiaEditorTransport):()=>void {
  let alive=true;
  const stop=transport.subscribe(message=>{
    if(!alive||message.channel!=="modules:theiaEditorApply")return;
    const accepted=applyTheiaMonacoEdit(message.transaction);
    void transport.invoke({op:"editorApplied",sessionId:message.sessionId,
      requestId:message.requestId,accepted}).catch(()=>{});
  });
  return ()=>{alive=false;stop();};
}
/** Shared by native Ctrl+K and the installed-extension panel. No background sync or polling.
 * The sync RPC is deliberately awaited before the extension command: the real editor
 * owns the current text/selection and is the only possible target of edits.
 */
export async function executeTheiaWithMonaco(
  invoke:(input:TheiaInstalledInput)=>Promise<TheiaInstalledResult>,sessionId:string,commandId:string,
  args?:string[],
):Promise<TheiaInstalledResult> {
  const editor=snapshotTheiaMonaco();
  const synced=await invoke({op:"editorSync",sessionId,editor});
  if(synced.kind!=="editorSynced")throw Error("未能同步 Mcode 编辑器到 Theia 扩展宿主");
  return invoke({op:"execute",sessionId,commandId,args});
}
