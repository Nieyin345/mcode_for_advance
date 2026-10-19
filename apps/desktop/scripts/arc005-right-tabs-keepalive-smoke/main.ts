import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CACHED_BUILTIN_RIGHT_TABS, prunePanelIds, rememberPanelId, rememberRightTab, shouldMountCachedBuiltin } from "../../src/renderer/components/layout/rightPanelKeepAlive.js";
import { mayShowNativeBrowserView, sidebarBrowserIsActive } from "../../src/renderer/components/browser/sidebarBrowserVisibility.js";
let ok=0, bad=0;
const check=(name:string, success:boolean)=>{console.log(`${success?"PASS":"FAIL"} ${name}`);if(success)ok++;else bad++;};
const right=readFileSync(resolve("src/renderer/components/layout/RightPanel.tsx"),"utf8");
const browser=readFileSync(resolve("src/renderer/components/browser/BrowserPanel.tsx"),"utf8");
check("Known builtins mount once and remain hidden, not unmounted, on tab switch",right.includes("shouldMountCachedBuiltin(") && right.includes("CACHED_BUILTIN_RIGHT_TABS.map("));
check("Inactive cached panes are genuinely inert and aria-hidden",right.includes("data-keepalive-tab={id}") && right.includes("inert={!selected}") && right.includes("aria-hidden={!selected}"));
check("Visited custom HTML/JS panel iframe remains mounted",right.includes("cachedPanelIds") && right.includes("visitedPanelIds") && right.includes("CustomTabView"));
check("Deleted/hidden custom panels are not retained forever",right.includes("entries.filter(") && right.includes('e.item.action.type === "panel"') && right.includes("prunePanelIds(prev, availablePanelIds)"));
check("Rail ignores shifted arrows and legacy IME composition",right.includes("e.shiftKey") && right.includes("e.nativeEvent.keyCode === 229"));
check("Native browser visibility follows selected right rail tab",right.includes('<BrowserPanel mode="sidebar" selected={selected} />') && browser.includes("sidebarBrowserIsActive(mode, open, rightOpen, settingsOpen, selected)") && !browser.includes("const activeCustomTab ="));
check("Delayed native browser show retries abort after browser tab is hidden",
  browser.includes("const isActiveRef = useRef(isActive)") &&
  browser.includes("if (!isActiveRef.current) return;"));
check("StrictMode effect re-setup restores the active ref after simulated cleanup",
  /useEffect\(\(\) => \{[\s\S]{0,180}isActiveRef\.current = isActive;\s*return \(\) => \{/.test(browser));
check("A zero-sized native browser stage cannot fall back to floating outside pane",
  browser.includes("if (attempt < 60)") && browser.includes("if (!mayShowNativeBrowserView(isActiveRef.current, r?.width, r?.height))") && browser.includes("isActiveRef.current = false"));
check("Browser toggle uses *effective* custom tab rather than stale raw custom ID",right.includes('showBuiltin(!activeCustom && tab === "browser" ? "files" : "browser")'));
check("Only stateful/expensive builtins are cached",CACHED_BUILTIN_RIGHT_TABS.join() === "files,git,browser");
const empty = new Set<"files" | "git" | "browser">();
const visitedFile = rememberRightTab(empty,"files");
check("Unvisited Git/Browser do not mount eagerly",!shouldMountCachedBuiltin("git","files",visitedFile) &&
  !shouldMountCachedBuiltin("browser","files",visitedFile));
check("Visited file tab mounts even when browser is current",shouldMountCachedBuiltin("files","browser",visitedFile));
check("Visited set identity is stable for repeat selection",rememberRightTab(visitedFile,"files") === visitedFile &&
  empty.size === 0 && visitedFile !== empty);
check("Unknown uncached builtin does not persist in cached set",rememberRightTab(visitedFile,"tasks") === visitedFile);
const visitedPanel = rememberPanelId(new Set<string>(),"html-1");
check("Custom HTML visited panel can retain identity across tab switch",visitedPanel.has("html-1") &&
  rememberPanelId(visitedPanel,"html-1") === visitedPanel);
check("Empty custom panel ID never creates phantom cached pane",rememberPanelId(visitedPanel,"") === visitedPanel);
const visitedOther = rememberPanelId(visitedPanel,"html-2");
const pruned = prunePanelIds(visitedOther, new Set(["html-1"]));
check("Removing or hiding a custom panel clears its remembered iframe ID",
  pruned.has("html-1") && !pruned.has("html-2"));
check("Pruning an unchanged custom panel cache preserves Set identity",
  prunePanelIds(pruned,new Set(["html-1","html-3"])) === pruned);
check("A re-added panel does not inherit a deleted instance's visited state",
  !pruned.has("html-2") && rememberPanelId(pruned,"html-2") !== pruned);
check("Background browser cannot float over Files, Git or custom pane",
  !sidebarBrowserIsActive("sidebar",false,true,false,false));
check("Selecting browser rail restores Native WebContentsView ownership",
  sidebarBrowserIsActive("sidebar",false,true,false,true));
check("Overlay remains independent of sidebar tab selection",
  sidebarBrowserIsActive("overlay",true,false,false,false));
check("Settings and hidden right pane suppress browser regardless of tab",
  !sidebarBrowserIsActive("sidebar",false,true,true,true) &&
  !sidebarBrowserIsActive("sidebar",false,false,false,true));
check("No native view shown after tab activation has been revoked",
  !mayShowNativeBrowserView(false,480,320));
check("No native view shown at zero or negative layout dimensions",
  !mayShowNativeBrowserView(true,0,320) && !mayShowNativeBrowserView(true,320,-1));
check("Malformed geometry (NaN/Infinity) also hides browser view",
  !mayShowNativeBrowserView(true,Number.NaN,320) && !mayShowNativeBrowserView(true,320,Infinity));
check("Measured and active browser allows native view",
  mayShowNativeBrowserView(true,480,320));
console.log(`arc005-right-tabs: ${ok}/${ok+bad}`);
if(bad) process.exitCode=1;
