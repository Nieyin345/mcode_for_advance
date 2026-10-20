/** Only the real PdfPreviewImpl is under test; no Electron, user DB or PDFium WASM. */
type HighlightsReply = {highlights:unknown[];error?:string;omittedCount?:number;revision?:string|null};
export const calls:string[]=[];
export const responses=new Map<string,()=>Promise<HighlightsReply>>();
export const api={library:{
  readPdf:async()=>{throw new Error("fixture supplies PDF bytes: no user library read");},
  readHighlights:async({pdfPath}:{pdfPath:string}):Promise<HighlightsReply>=>{
    calls.push(pdfPath);
    const handler=responses.get(pdfPath);
    if(!handler)throw Error("unexpected index lookup "+pdfPath);
    return handler();
  },
  writeHighlights:async()=>{throw Error("no real writes in render-only smoke")},
  openFile:async()=>({ok:false,error:"disabled in test"}),
}};
export const useToastStore={getState:()=>({push:()=>{}})};
let dirty=false;
export const useFileViewStore={getState:()=>({setDirty:(x:boolean)=>{dirty=x},dirty})};
export const setFileSaveHandler=(_f:unknown)=>{};
export const cn=(...parts:unknown[])=>parts.filter(Boolean).join(" ");
export const useI18n=()=>({t:(key:string)=>key});
export const PDFViewer=(_props:unknown)=>null;
export const ZoomMode={FitWidth:"fit-width"};
export const IconExternalLink=()=>null;
export const IconLoader2=()=>null;
export const IconRefresh=()=>null;
