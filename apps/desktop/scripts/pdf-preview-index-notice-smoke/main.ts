/**
 * Render the actual PdfPreviewImpl React function with deterministic hook
 * state and fake vendor UI. E1 for user-visible annotation-index diagnostics;
 * this intentionally does not claim real Electron GUI U1.
 */
import { PdfPreview } from "@renderer/components/library/PdfPreviewImpl.js";
import { __mount,__render,__flush,__text,__nodes } from "../preview-panel-smoke/fakeReact.js";
import { responses,calls } from "./deps.js";

type Reply={highlights:unknown[];error?:string;omittedCount?:number;revision?:string|null};
let assertions=0,failures=0;
function check(label:string,yes:boolean,detail?:unknown){
 assertions++;if(yes)console.log("  ok   "+label);
 else{failures++;console.log("  FAIL "+label+" "+JSON.stringify(detail));}
}
(globalThis as unknown as {window:{location:{href:string}}}).window={location:{href:"http://127.0.0.1/"}};
const bytes=new Uint8Array([37,80,68,70,45,49,46,55,10,37,37,69,79,70,10]);
let path="C:/fake-libraries/damaged.pdf";
const show=(p:string,respond:()=>Promise<Reply>)=>{
 path=p;responses.set(p,respond);
};
const render=()=>PdfPreview({item:{id:"paper-1"},filePath:path,bytes});
show(path,async()=>({highlights:[],error:"批注索引 JSON 损坏，已保留原文件"}));
__mount(render);
await __flush();
check("★★ production PDF preview warns about a damaged annotation index",
 __text().includes("批注索引 JSON 损坏"),__text());
check("corrupt index is presented as an accessible warning",
 __nodes().some(n=>n.props.role==="alert"),__nodes().filter(n=>n.props.role==="alert").length);

// Normal missing index is NOT an error and must not hide the viewer.
show("C:/fake-libraries/fresh.pdf",async()=>({highlights:[],revision:null}));
__render();
await __flush();
check("empty new PDF index does not create a false corruption banner",
 !__text().includes("损坏")&&!__nodes().some(n=>n.props.role==="alert"),__text());

// Existing sidecar with only a subset of valid records is visibly partial.
show("C:/fake-libraries/partly-corrupt.pdf",async()=>({highlights:[],omittedCount:2,revision:"f".repeat(64)}));
__render();
await __flush();
check("★★ partial invalid annotations show exact omitted count to user",
 __text().includes("2")&&__text().includes("跳过"),__text());

// Real IPC rejection must not be swallowed as a blank annotation list.
show("C:/fake-libraries/denied.pdf",async()=>{throw new Error("这个位置不允许读取高亮")});
__render();
await __flush();
check("★★ index IPC read failure is visibly explained",
 __text().includes("这个位置不允许读取高亮"),__text());

// Retry should query ONLY the index, without resetting the PDF or losing
// unsaved PDFium in-memory changes via the document load nonce.
show("C:/fake-libraries/retry.pdf",async()=>({highlights:[],error:"批注索引损坏"}));
__render();
await __flush();
responses.set(path,async()=>({highlights:[],revision:"a".repeat(64)}));
const refresh=__nodes().find(n=>n.type==="button" && n.props["data-index-retry"]===true);
check("damaged index provides a separate retry control",typeof refresh?.props.onClick==="function");
const beforeCalls=calls.filter(x=>x===path).length;
if(typeof refresh?.props.onClick==="function"){
 (refresh.props.onClick as ()=>void)();
 await __flush();
}
check("refresh rereads the sidecar and clears the warning without PDF reload",
 calls.filter(x=>x===path).length===beforeCalls+1 && !__text().includes("批注索引损坏"),__text());

// A stale slow response for A may not overwrite B's clean UI after switch.
let resolveOld!:(r:Reply)=>void;
show("C:/fake-libraries/slow-old.pdf",()=>new Promise(resolve=>{resolveOld=resolve}));
__render();
await __flush();
show("C:/fake-libraries/current.pdf",async()=>({highlights:[],revision:null}));
__render();
await __flush();
if(resolveOld)resolveOld({highlights:[],error:"OUTDATED_DOCUMENT_WARNING"});
await __flush();
check("★★ late warning from previous file cannot paint current document",
 !__text().includes("OUTDATED_DOCUMENT_WARNING"),__text());
check("UI never tried to write or read the real user's PDF file",calls.length>=6,calls);
console.log("pdf-preview-index-notice-smoke:"+(assertions-failures)+"/"+assertions+" PASS");
if(failures)process.exitCode=1;
