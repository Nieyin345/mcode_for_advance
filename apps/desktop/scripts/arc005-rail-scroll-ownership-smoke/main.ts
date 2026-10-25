/** ARC-005: rail keyboard navigation may only scroll its own horizontal track.
 * Tests production scroll helper with DOM-geometry stand-ins (no browser mock
 * semantics for scrollIntoView that would hide parent scrolling bugs). */
import { railScrollLeft, revealRailItemWithin, revealTabWithin } from "../../src/renderer/components/layout/panelRailScroll.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
let n=0,err=0;
const check=(name:string,ok:boolean)=>{n++;if(!ok)err++;console.log((ok?"PASS ":"FAIL ")+name)};
const source=(name:string)=>readFileSync(resolve("src/renderer",name),"utf8");
const panel=source("components/layout/RightPanel.tsx");
const terminal=source("components/ide/TerminalPanel.tsx");
const sharedTabs=source("components/layout/TabBarChrome.tsx");
const sessionTabs=source("components/layout/SessionTabs.tsx");
const unifiedTabs=source("components/layout/UnifiedTabsBar.tsx");
const openTabs=source("components/ide/OpenTabsBar.tsx");
const zh=source("lib/i18n/zh/ide.ts");
const en=source("lib/i18n/en/ide.ts");
const mk=(from:number,to:number)=>({left:from,right:to});
const track={
 scrollLeft:20,
 contains:(item:unknown)=>item!==other,
 getBoundingClientRect:()=>mk(100,380),
 scrollTo:({left,behavior}:{left:number;behavior:string})=>{
   scrollCalls.push({left,behavior});track.scrollLeft=left;
 }
};
const child={getBoundingClientRect:()=>mk(370,405)};
const other={getBoundingClientRect:()=>mk(520,555)};
const scrollCalls:Array<{left:number;behavior:string}>=[];
check("item outside rail never causes scroll",!revealRailItemWithin(track as never,other as never)&&scrollCalls.length===0);
check("offscreen item scrolls only explicit rail track",
 revealRailItemWithin(track as never,child as never)&&scrollCalls.length===1&&scrollCalls[0].left===53);
check("scroll method uses instant rail-local navigation",
 scrollCalls[0].behavior==="instant");
track.getBoundingClientRect=()=>mk(100,380);
check("already visible item causes no extra scroll",
 !revealRailItemWithin(track as never,{getBoundingClientRect:()=>mk(130,170)} as never));
check("bounded pure geometry helper still rejects invalid coordinates",
 railScrollLeft(30,Number.NaN,400,100,120)===30);
check("right panel arrow keys retain focus but never scroll ancestor workspace",
 panel.includes("nextButton.focus({ preventScroll: true })") &&
 panel.includes("revealRailItemWithin(rail, nextButton)") &&
 !panel.includes("nextButton.scrollIntoView"));
check("terminal arrow keys use same parent-safe rail helper",
 terminal.includes("tab?.focus({ preventScroll: true })") &&
 terminal.includes("revealRailItemWithin(e.currentTarget, tab)") &&
 !terminal.includes("tabs[next]?.scrollIntoView"));
check("terminal arrow selection dispatches existing active-tab handler",
 terminal.includes("tab?.click()") && terminal.includes("st.activeKey = s.key"));
check("terminal list is labeled with terminal tab purpose, not new-tab action",
 terminal.includes('role="tablist" aria-label={t("ide.term.tabs")}') &&
 zh.includes('"ide.term.tabs": "终端标签页"') &&
 en.includes('"ide.term.tabs": "Terminal tabs"'));
check("new tab remains outside tablist and does not pollute roving tab focus",
 /<\/div>\s*\{\/\* Creating a tab is a toolbar action/.test(terminal) &&
 terminal.includes('title={t("ide.term.newTerminal")}') &&
 terminal.includes('onClick={addSession}'));
check("terminal close on touch is visible and has usable 28px target",
 terminal.includes('[@media(hover:none)]:opacity-100') &&
 terminal.includes("flex size-7 shrink-0") &&
 terminal.includes('aria-label={\`\${t("ide.term.closeTerminal")}: \${sessionTitle}\`}'));
check("shared session and file keyboard strips reveal only within their own track",
 sharedTabs.includes("revealTabWithin(e.currentTarget, next)") &&
 sharedTabs.includes("next?.focus({ preventScroll: true })") &&
 sharedTabs.includes("next?.click()") &&
 !sharedTabs.includes("next?.scrollIntoView"));
check("shared tab handler remains wired to actual tablist in both views",
 sessionTabs.includes("onKeyDown={handleTabListKeyDown}") &&
 unifiedTabs.includes("onKeyDown={handleTabListKeyDown}") &&
 sharedTabs.includes("tabNavigationTargetIndex(e.key, index, tabs.length)"));
check("multi-row tab list scrolls its own vertical viewport without touching ancestor",
 (() => {
   const movements:Array<{left:number;top:number;behavior:string}>=[];
   const tabTrack = {
     scrollLeft:0,scrollTop:20,
     contains:()=>true,
     getBoundingClientRect:()=>({left:20,right:450,top:50,bottom:132}),
     scrollTo:(move:{left:number;top:number;behavior:string})=>{movements.push(move);}
   };
   const row={getBoundingClientRect:()=>({left:75,right:165,top:138,bottom:163})};
   const moved=revealTabWithin(tabTrack as never,row as never);
   return moved&&movements.length===1&&movements[0].left===0&&movements[0].top===55&&
     movements[0].behavior==="instant";
 })());
check("multi-row tab does not scroll if already visible in both axes",
 (() => {
   let calls=0;
   const tabTrack={
     scrollLeft:14,scrollTop:25,contains:()=>true,
     getBoundingClientRect:()=>({left:20,right:450,top:50,bottom:132}),
     scrollTo:()=>{calls++;}
   };
   return !revealTabWithin(tabTrack as never,{
     getBoundingClientRect:()=>({left:60,right:130,top:70,bottom:102})
   } as never)&&calls===0;
 })());
check("three active-tab effects reveal tabs only inside their own scroll viewport",
 sessionTabs.includes("revealTabWithin(track, node, tabScrollBehavior())") &&
 unifiedTabs.includes("revealTabWithin(el, node, tabScrollBehavior())") &&
 openTabs.includes("revealTabWithin(el, node, tabScrollBehavior())") &&
 !sessionTabs.includes("node?.scrollIntoView(") &&
 !unifiedTabs.includes("node.scrollIntoView(") &&
 !openTabs.includes("node.scrollIntoView("));
check("active-tab auto-reveal preserves reduced-motion preference",
 sessionTabs.includes("tabScrollBehavior()") &&
 unifiedTabs.includes("tabScrollBehavior()") &&
 openTabs.includes("tabScrollBehavior()"));
check("shared tab handler respects IME, modifiers and disabled tabs",
 sharedTabs.includes("if (!canNavigateTabKey(e)) return") &&
 sharedTabs.includes('not([aria-disabled="true"]):not([disabled])'));
check("xterm keeps its tab and content aria relationship",
 terminal.includes('aria-selected={isActive}') &&
 terminal.includes('aria-controls={\`terminal-panel-\${s.key}\`}') &&
 terminal.includes('aria-labelledby={\`terminal-tab-\${s.key}\`}'));
check("terminal retains cross-project PTY keepalive",
 terminal.includes("allTermEntries.map(({ s, path: p })") &&
 terminal.includes("inert={!isActive}") &&
 terminal.includes("active={active && isActive}"));
console.log("arc005-rail-scroll-ownership-smoke: "+(n-err)+"/"+n);
if(err)process.exitCode=1;
