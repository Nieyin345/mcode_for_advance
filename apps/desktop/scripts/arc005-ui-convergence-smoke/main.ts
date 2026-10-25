/** UI convergence smoke: workspace pane geometry, chat entry points and rail.
 * Pure geometry calculations run; component source contracts protect keepalive. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strict as assert } from "node:assert";
import { railScrollLeft } from "../../src/renderer/components/layout/panelRailScroll.js";
let tests=0, failures=0;
const check=(name:string, value:boolean)=>{tests++;if(!value)failures++;console.log((value?"PASS ":"FAIL ")+name);};
const src=(name:string)=>readFileSync(resolve("src/renderer",name),"utf8");
const panel=src("components/layout/RightPanel.tsx");
const shell=src("components/layout/ThreePaneLayout.tsx");
const chrome=src("components/layout/TabBarChrome.tsx");
const welcome=src("components/chat/EmptyThreadWelcome.tsx");
const side=src("components/chat/SideChatPanel.tsx");
const css=src("arc005-workspace-surface.css");
const main=src("main.tsx");
const almost=(a:number,b:number)=>Math.abs(a-b)<.00001;

check("Rail: visible item requires no scroll",almost(railScrollLeft(20,100,380,140,200),20));
check("Rail: offscreen right selected item enters viewport with margin",
 almost(railScrollLeft(20,100,380,365,398),46));
check("Rail: offscreen left selected item enters viewport with margin",
 almost(railScrollLeft(200,100,380,50,82),142));
check("Rail: scroll origin never becomes negative",railScrollLeft(0,100,380,50,84)===0);
check("Rail: oversized item uses a stable leading edge",
 almost(railScrollLeft(30,100,240,90,330),12));
check("Rail: invalid geometry leaves scroll unchanged",
 railScrollLeft(16,Infinity,320,200,250)===16);
check("Rail: zero viewport leaves scroll unchanged",
 railScrollLeft(16,100,100,200,250)===16);
check("Rail: selected item is revealed without browser scrollIntoView on render",
 panel.includes("railScrollLeft(track.scrollLeft") &&
 panel.includes('track.scrollTo({ left: next, behavior: "auto" })') &&
 panel.includes("railTrackRef.current") &&
 panel.includes('querySelector<HTMLElement>(\'[data-pane-rail-button][aria-pressed="true"]\')'));
check("Rail: selected item auto-scroll cleans up its animation frame",
 panel.includes("cancelAnimationFrame(id)") && panel.includes("requestAnimationFrame(() => {"));
check("Rail: keyboard focus still uses shared arrow navigation helper",
 panel.includes("nextRailFocusIndex(e.key, index, buttons.length)") && panel.includes("nextButton.focus({ preventScroll: true })"));
check("Rail: selected builtins and custom tabs keep aria-pressed semantics",
 panel.includes("aria-pressed={active}") && panel.includes("data-pane-rail-button"));
check("Rail: horizontally scrollable icon track leaves dock and wide actions accessible",
 panel.includes('data-pane-rail-track=""') && panel.includes("overscroll-x-contain") &&
 panel.includes('className="ml-auto flex shrink-0 items-center gap-1"'));
check("Rail: controls have 32px pointer/focus target",
 panel.includes('"flex size-8 items-center justify-center rounded-[var(--radius-btn-xs)]') &&
 panel.includes('className="flex size-8 shrink-0 items-center justify-center'));
check("Rail: visited file, workflow, and builtins are retained across tab switch",
 panel.includes("visitedDocs")&&panel.includes("visitedFlows")&&
 panel.includes("visitedBuiltinTabs") && panel.includes("inert={!selected}"));
check("Native pane: workspace variant marker does not fork center React tree",
 shell.includes('data-ui-pane-layout={variant}') &&
 shell.includes('data-ui-center-pane=""') &&
 shell.includes('variant === "workspace"') &&
 !shell.includes('variant === "workspace" ? <main'));
check("Native pane: right drawer / pane state are exposed to scoped design layer",
 shell.includes('data-ui-right-mode={rightSurface}') &&
 shell.includes('data-ui-right-open={rightOpen ? "true" : "false"}'));
check("Native pane: pointer drag and terminal keepalive still have state gates",
 shell.includes("onPointerCancelCapture") &&
 shell.includes("inert={!bottomTerminalOpen}") &&
 shell.includes("shouldMountRightPane(rightOpen, hasOpenedRight)"));
check("Native pane: dock-handle is keyboard visible with 32px hitbox",
 shell.includes('data-testid="pane-dnd-handle"') &&
 shell.includes('top-10 z-30 flex size-8') &&
 shell.includes("focus-visible:outline-accent"));
check("Tab bars: paging buttons are uniform 32px",
 chrome.includes('mb-0.5 flex size-8 shrink-0 items-center'));
check("Tab bars: disabled role-tabs are excluded from keyboard navigation",
 chrome.includes(':not([aria-disabled="true"]):not([disabled])'));
check("Tab bars: overflow selected item is exposed to assistive tech",
 chrome.includes('aria-current={item.active ? "true" : undefined}'));
check("Tab bars: old active tab and input preserve Enter and arrow behavior",
 chrome.includes('target.click()')&&chrome.includes("tabNavigationTargetIndex(e.key, index, tabs.length)"));
check("Welcome: workspace start points adapt to 260px narrow card widths",
 welcome.includes("minmax(min(260px,100%),1fr)") &&
 welcome.includes("max-w-[800px]") && welcome.includes("text-[clamp("));
check("Welcome: rows are at least 40px and remain keyboard navigable",
 welcome.includes('"flex min-h-10 w-full min-w-0 items-center')&&
 welcome.includes("focus-visible:outline-offset-2 focus-visible:outline-accent"));
check("Welcome: workflow choice and library preview use existing operations",
 welcome.includes('setWorkflowId(picked ? "default" : w.id)') &&
 welcome.includes("previewLibraryItem(it)"));
check("Welcome: automation failures and missed notices keep meaningful semantic status",
 welcome.includes('latestFailureOf(f)')&&welcome.includes('missedNoticeOf(f)')&&
 welcome.includes('StatusDot kind={failure ? "error" : "ready"}'));
check("Side chat: rows keep long titles constrained and list scroll owned locally",
 side.includes('data-ui-sidechat-list=""')&&side.includes("overscroll-contain")&&
 side.includes('data-ui-sidechat-row=""')&&side.includes("truncate text-xs text-content"));
check("Side chat: rows have >=44px primary hit area",
 side.includes('min-h-11 min-w-0 flex-1 items-center'));
check("Side chat: deletion still guarded during active turns and by confirmation",
 side.includes("disabled={running}")&&side.includes("onDelete={setPendingDelete}")&&
 side.includes("<ConfirmDialog")&&side.includes("!isMain"));
check("Side chat: side and parent chat reuse same ChatPane runtime",
 side.includes('sessionId={session.id} isActive chipsMode="collapsed"'));
check("Workspace CSS: loaded after theme, not duplicated in classic",
 main.indexOf('import "./styles.css"')<main.indexOf('import "./arc005-workspace-surface.css"')&&
 css.includes('html:not(.sketch) [data-ui-shell-variant="workspace"]'));
check("Workspace CSS: active rail, sidechat focus and starter cards are styled consistently",
 css.includes('[data-pane-rail-button][aria-pressed="true"]')&&
 css.includes('[data-ui-sidechat-row]:focus-within')&&
 css.includes('[data-home-section]:focus-within'));
check("Workspace CSS: no new pane stacking/remount/hide rules",
 !/display:\s*none|visibility:\s*hidden|position:\s*absolute|pointer-events:\s*none/i.test(css));
check("Workspace CSS: mobile, reduced motion and high contrast are represented",
 css.includes("@container (max-width: 360px)")&&
 css.includes("@media (forced-colors: active)")&&
 css.includes("@media (prefers-reduced-motion: reduce)"));
check("Negative: removing active rail selector must break selection assertion",
 !css.replaceAll('[data-pane-rail-button][aria-pressed="true"]',"UNAVAILABLE").includes('[data-pane-rail-button][aria-pressed="true"]'));
console.log("arc005-ui-convergence-smoke: "+(tests-failures)+"/"+tests);
if(failures)process.exitCode=1;
