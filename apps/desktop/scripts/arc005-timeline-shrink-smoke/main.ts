/** ARC-005: a virtual timeline must never go blank when history truncates
 * while the user is scrolled near the old bottom. Pure range + invariants. */
import { timelineDashWindow, TIMELINE_DASH_PITCH, TIMELINE_WINDOW_THRESHOLD } from "../../src/renderer/components/chat/timelineVirtualWindow.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let assertions=0,failures=0;
const ck=(label:string,good:boolean)=>{assertions++;if(!good)failures++;console.log((good?"PASS ":"FAIL ")+label);};
const oldTop=12000*TIMELINE_DASH_PITCH;
const shrunken=timelineDashWindow(180,oldTop,420);
ck("Large history truncation still shows tail instead of an empty marker viewport",
 shrunken.start<shrunken.end && shrunken.end===180 && shrunken.start>=0);
const tiny=timelineDashWindow(1,oldTop,420);
ck("Large history truncation down to one entry still mounts it",
 tiny.start===0 && tiny.end===1 && tiny.totalHeight===TIMELINE_DASH_PITCH);
const empty=timelineDashWindow(0,oldTop,420);
ck("Clearing all history yields a legitimate empty window", empty.start===0&&empty.end===0);
const fits=timelineDashWindow(60,oldTop,7200);
ck("History shorter than viewport shows all markers despite stale top",
 fits.start===0&&fits.end===60);
const valid=timelineDashWindow(10000,10*TIMELINE_DASH_PITCH,560);
ck("Normal scrolling still keeps visible markers near the requested offset",
 valid.start<=10 && valid.end>=29 && valid.end<50);
const first=timelineDashWindow(121,Number.POSITIVE_INFINITY,0);
ck("Invalid coordinates do not produce NaN or empty nonzero windows",
 Number.isFinite(first.start)&&Number.isFinite(first.end)&&first.end>first.start);
const pathological=timelineDashWindow(150,Number.MAX_SAFE_INTEGER,200);
ck("Massively out-of-range offsets clamp to the last visible markers",
 pathological.end===150 && pathological.start<150);
let violations=0;
for(const total of [1,2,3,10,40,120,121,122,180,320,600,1200,10000]){
 for(const view of [24,180,560,900,100000]){
  for(const top of [-100000,0,10,120,1e6,1e12,Number.NaN,Number.POSITIVE_INFINITY]){
   const range=timelineDashWindow(total,top,view);
   const okay=range.start>=0 && range.end<=total && range.end>range.start &&
     range.totalHeight===total*TIMELINE_DASH_PITCH && range.pitch===TIMELINE_DASH_PITCH;
   if(!okay)violations++;
  }
 }
}
ck("All 520 history/viewport/stale offset combinations retain nonempty in-range markers",violations===0);
const code=readFileSync(resolve("src/renderer/components/chat/timelineVirtualWindow.ts"),"utf8");
ck("Range calculation clamps old scroll position before computing both boundaries",
 code.includes("Math.min(requestedTop, Math.max(0, totalHeight - view))")&&
 code.indexOf("const top = Math.min(requestedTop")<code.indexOf("const start ="));
const timeline=readFileSync(resolve("src/renderer/components/chat/MessageTimeline.tsx"),"utf8");
ck("Real MessageTimeline uses the shared bounded range",
 timeline.includes("timelineDashWindow(dashes.length, scrollTop, viewportHeight)") &&
 timeline.includes("dashes.slice(range.start, range.end)"));
ck("Virtualization still applies only to large timelines",
 timeline.includes("dashes.length > TIMELINE_WINDOW_THRESHOLD") &&
 TIMELINE_WINDOW_THRESHOLD>=100);
const legacyEmpty=(total:number,top:number,view:number)=>{
 const start=Math.min(total,Math.max(0,Math.floor(top/30)-8));
 const end=Math.min(total,Math.max(start,Math.ceil((top+view)/30)+8));
 return start===end;
};
ck("Negative: the former unclamped implementation would have missed this regression",
 legacyEmpty(180,oldTop,420));
console.log("arc005-timeline-shrink-smoke: "+(assertions-failures)+"/"+assertions);
if(failures)process.exitCode=1;
