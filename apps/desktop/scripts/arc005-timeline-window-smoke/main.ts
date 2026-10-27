/** Time-axis virtualization, exact message/bookmark jump preservation,
 * and keyboard accessible scrolling under long conversation history. */
import { timelineDashWindow, TIMELINE_DASH_PITCH, TIMELINE_WINDOW_THRESHOLD } from "../../src/renderer/components/chat/timelineVirtualWindow.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
let n=0,fail=0;
const check=(title:string,ok:boolean)=>{n++;if(!ok)fail++;console.log((ok?"PASS ":"FAIL ")+title);};
const target=(p:string)=>readFileSync(resolve(p),"utf8");
const timeline=target("src/renderer/components/chat/MessageTimeline.tsx");
const probe=target("scripts/arc005-visual-baseline/probe.ts");
const w=(total:number,top:number,view:number)=>timelineDashWindow(total,top,view);
check("Timeline pitch matches 24px hitbox plus 6px spacing",TIMELINE_DASH_PITCH===30);
check("Timeline virtualization threshold keeps short timelines fully interactive",TIMELINE_WINDOW_THRESHOLD>=100&&TIMELINE_WINDOW_THRESHOLD<=200);
check("Empty timeline yields no mounted markers",w(0,0,700).start===0&&w(0,0,700).end===0);
check("Short list has all entries in initial window",w(70,0,2200).end===70);
check("Long 10K timeline mounts bounded initial window",w(10000,0,560).end<=40);
check("Moving to center of 10K timeline maps to correct indices",(()=>{const r=w(10000,5000*30,560);return r.start>=4990&&r.start<=5000&&r.end<=5028})());
check("Scrolling near end of timeline reveals last marker",(()=>{const r=w(10000,10000*30,560);return r.end===10000&&r.start<=10000})());
check("Bad coordinates do not produce NaN or negative windows",(()=>{const r=timelineDashWindow(1e4,NaN,-Infinity,-9);return r.start>=0&&r.end>r.start&&r.totalHeight===300000})());
check("Total-height preserves all original historical marker positions",w(1200,450,560).totalHeight===1200*30);
check("All dash identities and bookmark grouping are assembled before virtual slicing",
 timeline.includes("out.sort((a, b) => a.index - b.index)")&&
 timeline.includes("dashes.slice(range.start, range.end)")&&
 timeline.includes("key={d.key}"));
check("Original exact message/bookmark jump remains intact",
 timeline.includes("onJumpItem(d.message.id, d.index, d.excerpt)")&&
 timeline.includes("group[0].excerpt")&&timeline.includes("bm-${item.bookmarkId}"));
check("Virtualized markers use a single roving tab stop instead of tabbing only mounted rows",
 timeline.includes("tabIndex={windowed ? (ordinal === rovingDashIndex ? 0 : -1) : 0}") &&
 timeline.includes("firstFocusableOffset") &&
 !timeline.includes("tabIndex={windowed ? 0 : undefined}"));
check("Virtualized timeline supports ArrowUp/Down, PageUp/Down and Home/End",
 timeline.includes('["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]') &&
 timeline.includes("setFocusedDashKey(dashes[target]!.key)") &&
 timeline.includes("track.scrollTop = Math.max(0, nextTop)"));
check("Focused marker remains mounted when scrolling away from its virtual window",
 timeline.includes("If the user scrolls the timeline with a focused marker") &&
 timeline.includes("indices.push(validFocusedDashIndex)") &&
 timeline.includes("data-ui-timeline-dash-key={d.key}") &&
 timeline.includes("new Map(dashes.map((dash, index) => [dash.key, index] as const))") &&
 timeline.includes("dashIndexByKey.get(focusedDashKey)") &&
 timeline.includes('target?.focus({ preventScroll: true })'));
check("Timeline container delegates focus to actual dash controls",
 timeline.includes("onFocusCapture={windowed ?") &&
 timeline.includes("onBlurCapture={windowed ?") &&
 timeline.includes("onKeyDownCapture={windowed ?") &&
 !timeline.includes("tabIndex={windowed ? 0 : undefined}"));
check("Virtual window keeps timeline navigation labeled and visibly focused",
 timeline.includes('aria-label={t("chatStream.timeline.navigation")}') &&
 timeline.includes("focus-visible:outline-2"));
check("Scroll position and viewport height are observed and cleaned up",
 timeline.includes("onScroll={windowed ? (event) => {")&&timeline.includes("scrollFrameRef.current = window.requestAnimationFrame")&&
 timeline.includes("observer?.observe(track)")&&timeline.includes("observer?.disconnect()") &&
 timeline.includes("window.requestAnimationFrame(() =>") &&
 timeline.includes("window.cancelAnimationFrame(scrollFrameRef.current)"));
check("Timeline tooltips remain offscreen portal only while hovered",
 timeline.includes("hovered && createPortal(")&&timeline.includes("document.body"));
check("Real Electron long-chat verifies BOTH LegendList and timeline scrolling separately",
 probe.includes("!el.closest('[data-ui-timeline-strip]')")&&
 probe.includes("timelineMountedBefore > 90")&&
 probe.includes("timelineScrolled")&&
 probe.includes("firstDashBefore !== firstDashAfter")&&
 probe.includes("timelineJumpWorked")&&
 probe.includes("[data-ui-timeline-dash-index=\"20\"]")&&
 probe.includes('[data-message-id="stress-40"]'));
check("Negative: disabling bounded window would be caught by guard",
 !timeline.replace("dashes.slice(range.start, range.end)","dashes").includes("dashes.slice(range.start, range.end)"));
console.log("arc005-timeline-window-smoke: "+(n-fail)+"/"+n);
if(fail)process.exitCode=1;
