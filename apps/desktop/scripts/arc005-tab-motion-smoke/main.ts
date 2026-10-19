import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveTabScrollBehavior, tabScrollBehavior } from "../../src/renderer/components/layout/tabScrollMotion.js";
let total=0,bad=0;const ck=(s:string,b:boolean)=>{total++;if(!b)bad++;console.log((b?"PASS ":"FAIL ")+s)};
ck("Mcode app reduce-motion=true overrides OS",resolveTabScrollBehavior("true",false)==="auto");
ck("Mcode app reduce-motion=false overrides OS",resolveTabScrollBehavior("false",true)==="smooth");
ck("System reduced-motion applies when no override",resolveTabScrollBehavior(null,true)==="auto"&&resolveTabScrollBehavior(null,false)==="smooth");
ck("Malformed pref defaults to OS",resolveTabScrollBehavior("garbage",true)==="auto");
for(const p of ["layout/SessionTabs.tsx","layout/UnifiedTabsBar.tsx","ide/OpenTabsBar.tsx"]){
 const s=readFileSync(resolve("src/renderer/components",p),"utf8");
 ck(p+" invokes shared tab scroll motion",s.includes("tabScrollBehavior()")&&s.includes("tabScrollMotion.js"));
 ck(p+" does not use hardcoded smooth at tab scroll",!s.includes('behavior: "smooth"'));
}
// E1: call the production reader repeatedly in a fake desktop DOM. Neither
// system changes nor explicit preference changes require a React remount.
const g=globalThis as unknown as Record<string,unknown>;
const previous={window:g.window,document:g.document};
let override: string | null=null,osReduced=false;
try {
 g.window={matchMedia:() => ({get matches(){return osReduced;}})};
 g.document={documentElement:{getAttribute:()=>override}};
 ck("Live reader initially follows system pref",tabScrollBehavior()==="smooth");
 osReduced=true;
 ck("Live reader sees OS change without remount",tabScrollBehavior()==="auto");
 override="false";
 ck("Live reader honors an explicit app override",tabScrollBehavior()==="smooth");
 override="true";osReduced=false;
 ck("Live reader switches back to auto after app change",tabScrollBehavior()==="auto");
} finally {
 for(const [k,v] of Object.entries(previous)) if(v===undefined) delete g[k]; else g[k]=v;
}
console.log("tab scroll motion "+(total-bad)+"/"+total);if(bad)process.exitCode=1;
