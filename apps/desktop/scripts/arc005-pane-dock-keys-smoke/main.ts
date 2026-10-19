
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { paneDockFromKeyboard } from "../../src/renderer/components/layout/paneDock.js";
const rail=readFileSync(resolve("src/renderer/components/layout/RightPanel.tsx"),"utf8");
let ok=0,fail=0;function ck(name:string,b:boolean){if(b)ok++;else fail++;console.log((b?"PASS ":"FAIL ")+name);}
const base={key:"ArrowLeft",altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,isComposing:false,keyCode:0};
ck("ArrowLeft docks on left, not toggle",paneDockFromKeyboard(base)==="left");
ck("ArrowRight docks on right, not toggle",paneDockFromKeyboard({...base,key:"ArrowRight"})==="right");
ck("Repeated ArrowRight never changes to left",paneDockFromKeyboard({...base,key:"ArrowRight"})==="right");
ck("Normal Enter/Space left to native button semantics",paneDockFromKeyboard({...base,key:"Enter"})===null&&paneDockFromKeyboard({...base,key:" "})===null);
ck("Modifier shortcuts never dock",["altKey","ctrlKey","metaKey","shiftKey"].every(k=>paneDockFromKeyboard({...base,[k]:true})===null));
ck("Modern IME composition ignored",paneDockFromKeyboard({...base,isComposing:true})===null);
ck("Legacy IME keyCode229 ignored",paneDockFromKeyboard({...base,keyCode:229})===null);
ck("No accidental docking for ordinary letter keys",paneDockFromKeyboard({...base,key:"a"})===null);
ck("Real draggable rail delegates to the pure key guard",rail.includes("paneDockFromKeyboard({")&&rail.includes("if (dockSide) {"));
ck("Real draggable rail retains direct button click and drag",rail.includes('type="button" draggable')&&rail.includes("PANE_DOCK_MIME")&&rail.includes("onClick={() => setRightDock("));
ck("Arrow keys are documented for accessible docking",rail.includes('aria-keyshortcuts="ArrowLeft ArrowRight"'));
console.log("arc005-pane-dock-keys "+ok+"/"+(ok+fail));if(fail)process.exitCode=1;
