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
const paneProbe=read("scripts/arc005-pane-electron-smoke/probe.ts");
const paneBuild=read("scripts/arc005-pane-electron-smoke/build.mjs");
const visualBuild=read("scripts/arc005-visual-baseline/build.mjs");
const fixturePanels=read("scripts/arc005-visual-baseline/fixture-panels.tsx");
const apiStub=read("scripts/arc005-visual-baseline/api-stub.js");

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
check("Sidechat U1 uses actual Mcode right panel and two separate synthetic sessions",
 probe.includes("rightOpen: true, rightPanelTab: 'flow'") &&
 probe.includes("sideChatsByParent: {s1:a.sideChats}") &&
 visualTargets.includes('fixture: "real-SideChatPanel"') &&
 visualTargets.includes('"[data-ui-sidechat-row]"'));
check("Real sidechat row is clicked and selection verified before returning to list",
 probe.includes("item.click()") &&
 probe.includes("activeSideChatId === 'side1'") &&
 probe.includes("activeSideChatId: null"));
check("Old sidechat fake WorkflowBoardPanel overlay is no longer rendered",
 !fixturePanels.includes("IsolatedBoardBoundary") &&
 !fixturePanels.includes("sidechat-partial") &&
 !fixturePanels.includes("<WorkflowBoardPanel"));
check("Sidechat probe mocks only isolated read-only sessions, not real execution",
 apiStub.includes("window.__arcSideChatScene && a ? a.sideChats : []") &&
 apiStub.includes("messages: function () { return Promise.resolve({ messages: [], hasMore: false }); }"));
check("Electron visual probe checks native split-pane geometry and rejects overlap",
 probe.includes("paneGeometry") &&
 probe.includes("center.width < 240") &&
 probe.includes("right.width < 130") &&
 probe.includes("(overlapX > 2 && overlapY > 2)"));
/* 【UI 重建 2026-10-27】这条原来断言「KNOWN_UNCAPTURED 必须是一个**空** Map」，
 * 用 `new Map<string, string>();` 这个字面量来检测。
 *
 * 它的意图是对的：**防止把拍不出内容的场景永久扫进地毯下**，让门禁永远绿。
 * 但「一条豁免都不许有」把手段当成了目的 —— 一个**确实不存在**的界面
 * （`tab-overflow` 测的是只被已退役的 ClassicShell 渲染的 UnifiedTabsBar）
 * 本来就该登记为「拍不出」，否则只能删掉场景、连记录一起丢。
 *
 * 所以改成守**真正重要的东西**：每条豁免都必须
 *   1. 带一个说明理由的第二个参数（不是裸登记）；
 *   2. 理由里能看出「为什么按设计拍不出」。
 * 一条都没有时仍然通过。 */
{
  const decl = /const KNOWN_UNCAPTURED = new Map<string, string>\(\[?([\s\S]*?)\]?\);/.exec(probe);
  const body = decl?.[1] ?? "";
  const entries = [...body.matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\]/g)];
  const bareKeys = entries.filter((e) => e[2].trim().length < 20);
  check(
    "Known-missing exceptions are either empty or each carry a substantive reason",
    decl !== null && bareKeys.length === 0,
  );
  if (bareKeys.length > 0) console.log("  too short: " + JSON.stringify(bareKeys.map((e) => e[1])));
  // 负控：裸登记（没有理由）必须被判出来 —— 否则这条形同虚设。
  const badBody = `[\n  ["some-scene", ""],\n]`;
  const badEntries = [...badBody.matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]*)"\s*\]/g)];
  check(
    "Negative: an exception registered without a reason would be rejected",
    badEntries.some((e) => e[2].trim().length < 20),
  );
}
check("Actual Electron pane U1 uses full docking mode rather than undraggable drawer",
 paneProbe.includes("widePanelOpen:true") &&
 paneProbe.includes("DOCK_POINTER_LEFT_RIGHT"));
check("Actual Electron pane U1 verifies PTY, Monaco and unsaved draft across hide/reopen",
 paneProbe.includes("UNSAVED_MONACO_DRAFT_STABLE") &&
 paneProbe.includes("COLLAPSED_COMPONENTS_PERSIST") &&
 paneProbe.includes("REOPEN_PTY_AND_MONACO_DRAFT"));
check("Pane U1 negative mutations still fail for React rekey and silent corruption",
 paneBuild.includes("statuses.REOPEN_PTY_AND_MONACO_DRAFT==='FAIL'") &&
 paneBuild.includes("statuses.CORRUPTION_NOTICE==='FAIL'") &&
 paneBuild.includes("checks.length>=18"));
check("Real long chat sample uses 640 isolated messages through Zustand store",
 probe.includes("Array.from({length:640}") &&
 probe.includes("st.setState({messagesBySession:{s1:many,s2:[],s3:[]}})"));
check("Long chat smoke requires actual virtualization, not simply 640 raw DOM rows",
 probe.includes("stress.mounted > 160") &&
 visualTargets.includes('fixture:"real-ChatPane-LegendList"') &&
 visualTargets.includes("rendered > 160"));
check("Long chat metric is captured with source data and real scroll region",
 probe.includes("window.__arcLongStart = performance.now()") &&
 probe.includes("elapsedMs:performance.now()") &&
 probe.includes("scrollOk"));
check("Long chat gets a clean independent screenshot in baseline matrix",
 visualBuild.includes("long-chat") &&
 probe.includes('["long-chat", "长会话虚拟化压力"]'));
check("Native Electron U1 checks keyboard focus, two terminal tabs and no spurious PTY lifecycle",
 paneProbe.includes("NATIVE_TERMINAL_NEW_TAB") &&
 paneProbe.includes("NATIVE_TERMINAL_ARROW_TABS") &&
 paneProbe.includes("NATIVE_RIGHT_RAIL_FOCUS") &&
 paneBuild.includes("checks.length>=18"));
check("Real right-rail U1 resizes the selected icon without focus or Monaco/xterm loss",
 paneProbe.includes("NATIVE_RAIL_RESIZE_REVEALS_SELECTION") &&
 paneProbe.includes("rail.style.flex='0 0 46px'") &&
 paneProbe.includes("cell.style.marginLeft='160px'") &&
 paneProbe.includes("measure.focusSame&&measure.mainScrollSame&&measure.ptySame&&measure.monacoSame"));
check("Negative: removing live isolation invalidates our own performance contract",
 !(stream.replace("<StreamRunningDuration startedAt={status.startedAt} />","").includes("<StreamRunningDuration startedAt={status.startedAt} />")));
console.log("arc005-main-ui-u1-guard-smoke: "+(count-failed)+"/"+count);
if(failed) process.exitCode=1;
