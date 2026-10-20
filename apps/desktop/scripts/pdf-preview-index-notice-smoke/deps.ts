/** Only the real PdfPreviewImpl is under test; no Electron, user DB or PDFium WASM. */
type HighlightsReply = {highlights:unknown[];error?:string;omittedCount?:number;revision?:string|null};
export const calls:string[]=[];
export const responses=new Map<string,()=>Promise<HighlightsReply>>();
export const writes:Array<{pdfPath:string;bytesBase64:string;expectedRevision:string}>=[];
let onWrite=async (_input:unknown):Promise<{ok:boolean;error?:string}>=>({ok:true});
export const setWriteResponse=(fn:(input:unknown)=>Promise<{ok:boolean;error?:string}>)=>{onWrite=fn};
export let saveHandler:(()=>Promise<boolean>)|null=null;
export const getSaveHandler=()=>saveHandler;
export const api={library:{
  readPdf:async()=>{throw new Error("fixture supplies PDF bytes: no user library read");},
  readHighlights:async({pdfPath}:{pdfPath:string}):Promise<HighlightsReply>=>{
    calls.push(pdfPath);
    const handler=responses.get(pdfPath);
    if(!handler)throw Error("unexpected index lookup "+pdfPath);
    return handler();
  },
  writeHighlights:async(input:{pdfPath:string;bytesBase64:string;expectedRevision:string})=>{
    writes.push(input);
    return onWrite(input);
  },
  openFile:async()=>({ok:false,error:"disabled in test"}),
}};
export const useToastStore={getState:()=>({push:()=>{}})};
let dirty=false;
export const guardedTarget = {source:{kind:"project" as const,ref:"C:/fake-libraries/central.pdf"},name:"central.pdf"};
let activeTarget: unknown = guardedTarget;
export const setPreviewTarget = (target:unknown) => {activeTarget=target;};
export const useFileViewStore={getState:()=>({setDirty:(x:boolean)=>{dirty=x},dirty,target:activeTarget})};
export const setFileSaveHandler=(f:(()=>Promise<boolean>)|null)=>{saveHandler=f;return ()=>{if(saveHandler===f)saveHandler=null;};};
export const cn=(...parts:unknown[])=>parts.filter(Boolean).join(" ");
export const useI18n=()=>({t:(key:string)=>key});
export const PDFViewer=(_props:unknown)=>null;
export const ZoomMode={FitWidth:"fit-width"};
export const IconExternalLink=()=>null;
export const IconLoader2=()=>null;
export const IconRefresh=()=>null;
