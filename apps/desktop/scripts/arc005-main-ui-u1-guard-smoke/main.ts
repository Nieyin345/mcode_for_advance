import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let count = 0, failed = 0;
function check(name: string, ok: boolean): void {
 count++; if(!ok) failed++;
 console.log((ok ? "PASS " : "FAIL ") + name);
}
const read=(p:string)=>readFileSync(resolve(p),"utf8");
const stream=read("src/renderer/components/layout/StreamSidebar.tsx");
const quick=read("src/renderer/components/layout/SidebarQuickActions.tsx");
const css=read("src/renderer/arc005-workspace-surface.css");
const main=read("src/renderer/main.tsx");
const build=read("scripts/arc005-visual-baseline/build.mjs");
const probe=read("scripts/arc005-visual-baseline/probe.ts");
const welcome=read("src/renderer/components/chat/EmptyThreadWelcome.tsx");
const pane=read("src/renderer/components/layout/ThreePaneLayout.tsx");
const tabs=read("src/renderer/components/layout/TabBarChrome.tsx");
const clock=read("src/renderer/hooks/useNow.ts");
const blocks=read("src/renderer/components/chat/MessageBlocks.tsx");
const visualTargets=read("scripts/arc005-visual-baseline/probe-assertions.ts");

check("Sidebar no longer owns one-second timer which reconciles all cards",
 !stream.includes("setNowTick(Date.now())")&&!stream.includes("now={nowTick}")&&
 !stream.includes("nowTick, activeSessionId"));
check("Only running card has live clock subscription",
 stream.includes("function StreamRunningDuration(") &&
 stream.includes("const now = useNow()") &&
 stream.includes('<StreamRunningDuration startedAt={status.startedAt} />'));
check("Live clock remains the shared singleton hook, not a new interval per row",
 stream.includes('import { useNow } from "@renderer/hooks/useNow.js"') &&
 !stream.includes('setInterval(() => setNowTick'));
check("Running status remains live, preserves established translated label",
 stream.includes('t("layout.stream.statusWorking", { dur: formatRunningDuration(now - startedAt) })'));
check("Running states retain their accent status dot and active selection",
 stream.includes('<StatusDot kind="running" />') && stream.includes('aria-current={active ? "page" : undefined}'));
check("Sortable stream rows remain keyboard-operable",
 stream.includes("useSortable({ id: session.id })") &&
 stream.includes('e.key === "Enter" || e.key === " "') &&
 stream.includes('e.key === "ArrowUp"') && stream.includes('e.key === "ArrowDown"'));
check("Stream archive/delete still prompts before destructive operation",
 stream.includes('<ConfirmDialog') && stream.includes('onContext={(x, y) => setCtxMenu'));
check("Sidebar quick actions have usable 40px click areas",
 quick.includes("min-h-10 min-w-0 w-full items-center") &&
 quick.includes('data-sidebar-quick-actions=""'));
check("Sidebar quick action labels truncate rather than force sidebar width",
 quick.includes('min-w-0 flex-1 truncate text-left'));
check("Sidebar quick actions still use shortcut overrides, not hardcoded hotkeys",
 quick.includes("resolveShortcut(commandId, overrides)") &&
 quick.includes('commandId="session.new"') &&
 quick.includes('commandId="command.palette"'));
check("Sidebar search/new still dispatch existing session and palette store actions",
 quick.includes("void startSession()") &&
 quick.includes("setCommandPaletteOpen(true)"));
check("Production Mcode loads workspace CSS after canonical theme stylesheet",
 main.indexOf('import "./styles.css"') >= 0 &&
 main.indexOf('import "./arc005-workspace-surface.css"') > main.indexOf('import "./styles.css"'));
check("Real Electron fixture now loads workspace CSS after Tailwind app.css",
 build.includes('copyFileSync(join(root, "arc005-workspace-surface.css")') &&
 build.includes('<link rel="stylesheet" href="./app.css"><link rel="stylesheet" href="./arc005-workspace-surface.css">'));
check("Visual U1 fixture uses production App and actual sidebar, not placeholder screenshots",
 build.includes('import {App} from') &&
 build.includes("const stubs = {") &&
 !build.includes('"mock-left-bar"'));
check("Visual U1 defaults to complete scene matrix; targeted selection opt-in",
 probe.includes("selectedScreens ? SCREENS.filter") &&
 probe.includes("selectedConditions ? CONDITIONS.filter") &&
 probe.includes("const captureScreens") &&
 probe.includes("cells: captureScreens.length*captureConditions.length"));
check("Visual U1 throws for invalid selection instead of capturing an empty subset",
 probe.includes('throw Error("Unknown ARC005_VISUAL_SCENES selection")') &&
 probe.includes('throw Error("Empty ARC005 visual selection")'));
check("Visual DOM evidence records that workspace layer is actually active",
 probe.includes("workspaceSkin") &&
 probe.includes('getPropertyValue("--workspace-control-size")') &&
 probe.includes('link[href="./arc005-workspace-surface.css"]'));
check("Visual U1 samples workspace, parallel sidebar and narrow window separately",
 probe.includes('["parallel", "并行会话侧栏"]') &&
 probe.includes('["narrow-window", "窗口缩窄"]') &&
 probe.includes('["projects", "项目切换"]'));
check("Scoped workspace style has no blanking or remount tricks",
 !/display:\s*none|visibility:\s*hidden|position:\s*absolute|pointer-events:\s*none/i.test(css));
check("Chat draft/composer remains single existing instance even with long path wrapping",
 css.includes("[data-chat-root] .composer-action-row") &&
 css.includes("[data-chat-root] .composer-chips") &&
 css.includes(".composer-card:focus-within"));
check("Tree/stream card visual geometry respects selection and status",
 css.includes("[data-tree-session-row]") &&
 css.includes('[data-stream-session-row][aria-current="page"]'));
check("Theme and accessibility remain scoped to workspace only",
 css.includes('html:not(.sketch) [data-ui-shell-variant="workspace"]') &&
 css.includes("@media (forced-colors: active)") &&
 css.includes("@media (prefers-reduced-motion: reduce)"));
check("Chat home responsive card grid stays keyboard-operable",
 welcome.includes("focus-visible:outline-offset-2") &&
 welcome.includes("minmax(min(260px,100%),1fr)"));
check("Pane/editor/terminal keep-alive semantics are preserved by layout",
 pane.includes("inert={!bottomTerminalOpen}") &&
 pane.includes("shouldMountRightPane(rightOpen, hasOpenedRight)"));
check("Tab chrome still provides keyboard and overflow navigation",
 tabs.includes('handleTabListKeyDown') &&
 tabs.includes("tabNavigationTargetIndex") &&
 tabs.includes('aria-current={item.active ? "true" : undefined}'));
check("Historical TurnPanel never subscribes to the running clock",
 blocks.includes("const now = useNow(!completed)") &&
 blocks.includes("turnMeta?.endedAt ?? now"));
check("Shared useNow preserves hook ordering when baseline freezes after mount",
 clock.includes("return useSyncExternalStore(enabled ? subscribe : inertSubscribe, getCurrent, getCurrent)") &&
 !clock.includes("if (frozen !== null) return frozen;"));
check("Inactive turns stop listening without creating their own intervals",
 clock.includes("export function useNow(active = true)") &&
 clock.includes("const enabled = active && frozen === null") &&
 clock.includes("function inertSubscribe("));
check("Semantic tool row marker belongs to real tool disclosure buttons",
 blocks.includes('data-ui-tool-row="" className={TOOL_ROW_CLS}') &&
 blocks.includes('data-ui-tool-summary={toolBlocks.length > 0 ? "" : undefined}'));
check("Visual tool probe targets real tool controls not incidental CSS utility strings",
 visualTargets.includes('selector: "button[data-ui-tool-row],button[data-ui-tool-summary]"') &&
 !visualTargets.includes("flex w-full items-center gap-2"));
check("Visual U1 fails closed when workspace stylesheet is missing or inactive",
 probe.includes('probe = {ok:false,reason:"ARC-005 workspace presentation layer was not active') &&
 probe.includes('skin.controlSize !== "2rem"'));
check("Negative: removing live isolation invalidates our own performance contract",
 !(stream.replace("<StreamRunningDuration startedAt={status.startedAt} />","").includes("<StreamRunningDuration startedAt={status.startedAt} />")));
console.log("arc005-main-ui-u1-guard-smoke: "+(count-failed)+"/"+count);
if(failed) process.exitCode=1;
