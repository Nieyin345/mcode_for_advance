/** F036: Normalize results of untrusted VS Code language extensions before IPC.
 * The host never applies formatting edits: Mcode Monaco owns edits and undo.
 */
import type {TheiaLanguageRange,TheiaLanguageSymbol,TheiaSignatureHelp,TheiaLanguageTextEdit} from "@contracts/ipc/modules.js";
import * as path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";

function record(value:unknown):Record<string,unknown>|null{
  return value!==null&&typeof value==="object"&&!Array.isArray(value)
    ?value as Record<string,unknown>:null;
}
function point(value:unknown):{line:number;character:number}|null{
  const p=record(value);if(!p)return null;
  const line=Number.isSafeInteger(p.line)?Number(p.line):
    Number.isSafeInteger(p.lineNumber)?Number(p.lineNumber)-1:-1;
  const character=Number.isSafeInteger(p.character)?Number(p.character):
    Number.isSafeInteger(p.column)?Number(p.column)-1:-1;
  return line>=0&&line<=1_000_000&&character>=0&&character<=1_000_000
    ?{line,character}:null;
}
export function languageRange(value:unknown):TheiaLanguageRange|null{
  const r=record(value);if(!r)return null;
  const start=point(r.start??{lineNumber:r.startLineNumber,column:r.startColumn});
  const end=point(r.end??{lineNumber:r.endLineNumber,column:r.endColumn});
  if(!start||!end||end.line<start.line||
    (end.line===start.line&&end.character<start.character))return null;
  return {start,end};
}
export function formattingEdits(input:unknown):Array<{range:TheiaLanguageRange;text:string}>{
  if(!Array.isArray(input))return [];
  const output:Array<{range:TheiaLanguageRange;text:string}>=[];
  let size=0;
  for(const item of input.slice(0,201)){
    if(output.length>=200)break;
    const row=record(item);if(!row||typeof row.text!=="string")continue;
    const range=languageRange(row.range);
    if(!range||row.text.length>8000||size+row.text.length>100_000)continue;
    size+=row.text.length;output.push({range,text:row.text});
  }
  // Providers may be buggy or hostile: Monaco's formatter must not receive
  // overlapping changes that make a single undo transaction ambiguous.
  output.sort((a,b)=>a.range.start.line-b.range.start.line||
    a.range.start.character-b.range.start.character);
  const clean:typeof output=[];
  for(const edit of output){
    const prior=clean.at(-1);
    if(prior&&(edit.range.start.line<prior.range.end.line||
      (edit.range.start.line===prior.range.end.line&&edit.range.start.character<prior.range.end.character)))continue;
    clean.push(edit);
  }
  return clean;
}
/** Strictly convert a Theia WorkspaceEditDto to edits in the currently open
 * Mcode document. A foreign URI, file operation, snippet, overlapping edit or
 * confirmation-required entry rejects the WHOLE proposal, never a partial edit.
 */
export function localWorkspaceTextEdits(input:unknown,filePath:string,documentText:string):TheiaLanguageTextEdit[]|null{
  const outer=record(input);
  if(!outer||!Array.isArray(outer.edits)||outer.edits.length<1||outer.edits.length>80)return null;
  const lines=documentText.split(/\r\n|\r|\n/);
  const expected=path.normalize(path.resolve(filePath));
  const normalized=(value:string)=>process.platform==="win32"?value.toLowerCase():value;
  const edits:TheiaLanguageTextEdit[]=[];
  let size=0;
  for(const item of outer.edits){
    const row=record(item),resource=record(row?.resource),edit=record(row?.textEdit);
    if(!row||!resource||resource.scheme!=="file"||typeof resource.path!=="string"||
      (resource.authority!==undefined&&resource.authority!=="")||
      !edit||edit.insertAsSnippet===true||row.cellEdit!==undefined||
      record(row.metadata)?.needsConfirmation===true)return null;
    let target:string;
    try{
      const encoded=encodeURI(resource.path).replace(/#/g,"%23").replace(/\?/g,"%3F");
      target=fileURLToPath("file://"+(encoded.startsWith("/")?encoded:"/"+encoded));
    }catch{return null;}
    if(normalized(path.normalize(target))!==normalized(expected))return null;
    if(typeof edit.text!=="string"||edit.text.length>8000||size+edit.text.length>100000)return null;
    const range=languageRange(edit.range);
    if(!range)return null;
    const valid=(p:{line:number;character:number})=>p.line<lines.length&&p.character<=lines[p.line].length;
    if(!valid(range.start)||!valid(range.end))return null;
    size+=edit.text.length;edits.push({range,text:edit.text});
  }
  const clean=formattingEdits(edits);
  return clean.length===edits.length?clean:null;
}
export function documentSymbols(input:unknown):TheiaLanguageSymbol[]{
  if(!Array.isArray(input))return [];
  let count=0;
  function normalize(rows:unknown[],depth:number):TheiaLanguageSymbol[]{
    if(depth>8)return [];
    const result:TheiaLanguageSymbol[]=[];
    for(const item of rows){
      if(count>=200)break;
      const row=record(item);if(!row||typeof row.name!=="string"||!row.name||row.name.length>300)continue;
      const range=languageRange(row.range),selectionRange=languageRange(row.selectionRange??row.range);
      if(!range||!selectionRange)continue;
      const kind=typeof row.kind==="number"&&Number.isInteger(row.kind)&&row.kind>=0&&row.kind<=25?row.kind:12;
      count++;
      result.push({name:row.name.slice(0,160),detail:typeof row.detail==="string"?row.detail.slice(0,320):"",
        kind,range,selectionRange,children:Array.isArray(row.children)?normalize(row.children,depth+1):[]});
    }
    return result;
  }
  return normalize(input,0);
}
function markup(input:unknown):string|undefined{
  if(typeof input==="string")return input.slice(0,2000);
  const row=record(input);
  return typeof row?.value==="string"?row.value.slice(0,2000):undefined;
}
export function signatureHelp(input:unknown):TheiaSignatureHelp|undefined{
  const row=record(input);if(!row||!Array.isArray(row.signatures))return undefined;
  const signatures:TheiaSignatureHelp["signatures"]=[];
  for(const item of row.signatures.slice(0,16)){
    const current=record(item);if(!current||typeof current.label!=="string")continue;
    const label=current.label.slice(0,500);
    const parameters:Array<{label:string;documentation?:string}>=[];
    if(Array.isArray(current.parameters))for(const parameter of current.parameters.slice(0,32)){
      const value=record(parameter);if(!value)continue;
      const rawLabel=value.label;
      const text=typeof rawLabel==="string"?rawLabel:
        Array.isArray(rawLabel)&&rawLabel.length===2&&rawLabel.every(Number.isInteger)
          ?label.slice(Math.max(0,rawLabel[0]),Math.min(label.length,rawLabel[1])):"";
      parameters.push({label:text.slice(0,200),...(markup(value.documentation)?{documentation:markup(value.documentation)}:{})});
    }
    signatures.push({label,parameters,...(markup(current.documentation)?{documentation:markup(current.documentation)}:{}),
      ...(Number.isSafeInteger(current.activeParameter)&&Number(current.activeParameter)>=0
        ?{activeParameter:Math.min(Number(current.activeParameter),parameters.length?parameters.length-1:0)}:{})});
  }
  if(!signatures.length)return undefined;
  const activeSignature=Number.isSafeInteger(row.activeSignature)?Number(row.activeSignature):0;
  const activeParameter=Number.isSafeInteger(row.activeParameter)?Number(row.activeParameter):0;
  return {signatures,activeSignature:Math.max(0,Math.min(signatures.length-1,activeSignature)),
    activeParameter:Math.max(0,Math.min(31,activeParameter))};
}
