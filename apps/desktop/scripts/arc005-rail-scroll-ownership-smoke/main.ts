/** ARC-005: rail keyboard navigation may only scroll its own horizontal track.
 * Tests production scroll helper with DOM-geometry stand-ins (no browser mock
 * semantics for scrollIntoView that would hide parent scrolling bugs). */
import { railScrollLeft, revealRailItemWithin } from "../../src/renderer/components/layout/panelRailScroll.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
let n=0,err=0;
const check=(name:string,ok:boolean)=>{n++;if(!ok)err++;console.log((ok?"PASS ":"FAIL ")+name)};
const source=(name:string)=>readFileSync(resolve("src/renderer",name),"utf8");
const panel=source("components/layout/RightPanel.tsx");
const terminal=source("components/ide/TerminalPanel.tsx");
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
