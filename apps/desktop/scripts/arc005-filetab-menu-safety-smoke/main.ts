import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { liveFileTabMenu } from "../../src/renderer/components/ide/fileTabMenuSafety.js";
import { sessionTabMenuPosition } from "../../src/renderer/components/layout/sessionTabContextActions.js";
import { copyText } from "../../src/renderer/lib/clipboard.js";
const source=(path:string)=>readFileSync(resolve("src/renderer/components",path),"utf8");
const file=source("ide/OpenTabsBar.tsx"), unified=source("layout/UnifiedTabsBar.tsx");
let total=0,failed=0;
function ck(name:string,ok:boolean){total++;if(!ok)failed++;console.log((ok?"PASS ":"FAIL ")+name)}
const menu={path:"/virtual/shared.txt",x:48,y:96,projectId:"p1"};
ck("Live file tab context remains valid inside its original project",liveFileTabMenu(menu,"p1",["/virtual/shared.txt"])===menu);
ck("Cross-project context is denied even with identical file path",liveFileTabMenu(menu,"p2",["/virtual/shared.txt"])===null);
ck("A closed tab context cannot batch-close other files",liveFileTabMenu(menu,"p1",["/virtual/other.txt"])===null);
ck("Null and no-active-project are denied",liveFileTabMenu(null,"p1",["/virtual/shared.txt"])===null&&liveFileTabMenu(menu,null,["/virtual/shared.txt"])===null);
ck("Missing origin project id cannot grant context actions",liveFileTabMenu({...menu,projectId:null},"p1",["/virtual/shared.txt"])===null);
ck("Matching project and target does not mutate tab list",(()=>{const tabs=["/virtual/shared.txt"];const live=liveFileTabMenu(menu,"p1",tabs);return live!==null&&tabs.length===1})());
ck("Both file strips record project identity at contextmenu creation",file.includes("setCtxMenu({ path, projectId: pid, ...anchor })")&&unified.includes("setCtxMenu({ path, projectId: pid, ...anchor })"));
ck("Both file menus receive ONLY the validated live context",file.includes("ctxMenu={liveFileTabMenu(ctxMenu, pid, openFiles)}")&&unified.includes("ctxMenu={liveFileTabMenu(ctxMenu, pid, openFiles)}"));
ck("Both file bars clear the stale menu state on project or open-tab changes",
 file.includes("setCtxMenu((prev) => prev && !liveFileTabMenu(prev, pid, openFiles) ? null : prev)") &&
 unified.includes("setCtxMenu((prev) => prev && !liveFileTabMenu(prev, pid, openFiles) ? null : prev)"));
ck("Both file strips anchor keyboard Shift+F10 to the tab rather than screen origin",file.includes("sessionTabMenuPosition(e.clientX, e.clientY")&&unified.includes("sessionTabMenuPosition(e.clientX, e.clientY"));
ck("Both file strips stop contextmenu bubbling out of tab",file.includes("onContextMenu={(e) => {\n                    e.preventDefault();\n                    e.stopPropagation();")&&unified.includes("onContextMenu={(e) => {\n                    e.preventDefault();\n                    e.stopPropagation();"));
const rect={left:100,bottom:300};
ck("Keyboard contextmenu fallback uses real tab rectangle",sessionTabMenuPosition(0,0,rect).x===116 && sessionTabMenuPosition(0,0,rect).y===300);
ck("Actual mouse rightclick preserves cursor position",sessionTabMenuPosition(250,180,rect).x===250&&sessionTabMenuPosition(250,180,rect).y===180);
ck("File tab Copy Path uses common safe copyText fallback",file.includes("await copyText(path)")&&!file.includes("navigator.clipboard.writeText(path).catch(() => {})"));
ck("A denied clipboard write raises visible feedback",file.includes('useToastStore.getState().push')&&file.includes('t("chat.tagPopover.copyFailed")'));
// Run the production clipboard fallback against a fake DOM, without touching
// the host OS clipboard, browser data, or real user projects.
const g = globalThis as unknown as Record<string, unknown>;
const originals = {window:g.window,document:g.document};
const nativeNavigator = Object.getOwnPropertyDescriptor(globalThis,"navigator");
let nativeWrites=0, legacyCopies=0, shouldReject=false, legacySucceeds=true, throwOnLegacy=false, removed=0, restoredFocus=0;
let originalConnected=true;
let currentFocus:unknown=null;
const originalFocus = {get isConnected(){return originalConnected;},focus:(_opts?:unknown)=>{restoredFocus++;currentFocus=originalFocus;}};
currentFocus=originalFocus;
try {
  g.window = {isSecureContext:true};
  Object.defineProperty(globalThis,"navigator",{configurable:true,writable:true,value:{clipboard:{writeText:async (_text:string)=>{
    nativeWrites++;
    if(shouldReject) throw new Error("simulated denied clipboard");
  }}}});
  g.document = {
    get activeElement(){return currentFocus;},
    body:{appendChild:()=>{}},
    createElement:()=>({style:{},value:"",focus:function(){currentFocus=this;},select:()=>{},
      setSelectionRange:()=>{},remove:()=>{removed++;currentFocus=null;}}),
    execCommand:(_verb:string)=>{legacyCopies++;if(throwOnLegacy)throw new Error("simulated legacy copy failure");return legacySucceeds;},
  };
  ck("Production helper copies path through allowed secure native clipboard",
    await copyText("/virtual/shared.txt") && nativeWrites===1 && legacyCopies===0);
  shouldReject=true;
  ck("Denied native clipboard falls back to isolated legacy copy",
    await copyText("/virtual/shared.txt") && nativeWrites===2 && legacyCopies===1);
  legacySucceeds=false;
  ck("Both copy routes denied returns false for toast feedback",
    !(await copyText("/virtual/shared.txt")) && legacyCopies===2);
  (g.window as {isSecureContext:boolean}).isSecureContext=false;
  ck("Insecure context skips unavailable native clipboard without crashing",
    !(await copyText("/virtual/shared.txt")) && nativeWrites===3 && legacyCopies===3);
  throwOnLegacy=true;
  ck("Failed fallback removes its temporary textarea even on thrown execCommand",
    !(await copyText("/virtual/shared.txt")) && removed===4);
  ck("Legacy clipboard preserves original keyboard focus across success and failure",restoredFocus===4&&currentFocus===originalFocus);
  originalConnected=false;
  ck("A removed focus target is never re-focused during clipboard cleanup",
    !(await copyText("/virtual/shared.txt"))&&restoredFocus===4);
} finally {
  for(const [key,value] of Object.entries(originals)){
    if(value===undefined) delete g[key]; else g[key]=value;
  }
  if(nativeNavigator) Object.defineProperty(globalThis,"navigator",nativeNavigator);
  else delete g.navigator;
}
console.log("arc005-filetab-menu-safety "+(total-failed)+"/"+total);
if(failed)process.exitCode=1;
