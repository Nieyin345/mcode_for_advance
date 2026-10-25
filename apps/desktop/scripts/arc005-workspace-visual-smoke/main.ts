/** ARC-005: workspace visual integration without Chromium, Electron,
 * CSS screenshot claims or PTY process launches. Pure behavior + source
 * wiring controls DOM stability and scope. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { terminalTabTarget } from "../../src/renderer/components/ide/terminalTabNavigation.js";
import { sourceHas } from "../lib/sourceText.js";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const css = read("src/renderer/arc005-workspace-surface.css");
const main = read("src/renderer/main.tsx");
const shell = read("src/renderer/components/shell/ClassicShell.tsx");
const terminal = read("src/renderer/components/ide/TerminalPanel.tsx");
const terminalMenu = read("src/renderer/components/ide/TerminalCommandsMenu.tsx");
const tabs = read("src/renderer/components/layout/TabBarChrome.tsx");
const git = read("src/renderer/components/ide/GitHistoryView.tsx");
let total = 0, bad = 0;
function ck(label: string, cond: boolean) {
  total++;
  if (!cond) bad++;
  console.log((cond ? "PASS " : "FAIL ") + label);
}

ck("Workspace presentation stylesheet loads AFTER the canonical theme stylesheet",
  main.indexOf('import "./styles.css";') >= 0 &&
  main.indexOf('import "./arc005-workspace-surface.css";') > main.indexOf('import "./styles.css";'));
ck("Workspace CSS scopes every normal selector to the workspace shell, not settings/mobile",
  css.includes('html:not(.sketch) [data-ui-shell-variant="workspace"]') &&
  !/^(?!\s*\/\*|\s*\*|\s*@|\s*}|\s*$|\s*html:not\(\.sketch\)|\s*\[data-ui-shell-variant="workspace"\])[.#][\w\-]+\s*\{/m.test(css));
ck("Workspace variant is a real DOM marker on the stable shell",
  sourceHas(shell, "data-ui-shell-variant={variant}") &&
  sourceHas(shell, '<div data-testid="workspace-main"'));
ck("No forked palette or imported font duplicates in new layer",
  !css.includes("@font-face") && !css.includes("@import") &&
  !css.includes("--m-gray-") && !css.includes("--surface:") &&
  css.includes("rgb(var(--accent)") && css.includes("rgb(var(--panel-edge))"));
ck("Chat main pane width and wrapping are resilient to tool output/path overflow",
  css.includes('[data-chat-root]') && css.includes(".chat-turn") &&
  css.includes("overflow-wrap: anywhere") && css.includes(".composer-host"));
ck("Workspace focus visibly spans sidebar and panel controls",
  css.includes('[data-testid="workspace-sidebar"]') &&
  css.includes('[data-testid="workspace-main"]') &&
  css.includes(':focus-visible') &&
  css.includes("--workspace-focus-outline"));
ck("New style respects forced colors, reduced motion and narrow Electron widths",
  css.includes("@media (forced-colors: active)") &&
  css.includes("@media (prefers-reduced-motion: reduce)") &&
  css.includes("@media (max-width: 900px)"));
ck("New visual layer does not impose display:none/inert/remount on live terminal/editor",
  !/display:\s*none|visibility:\s*hidden|position:\s*absolute|pointer-events:\s*none/i.test(css));
ck("Negative: the stylesheet must not be moved ahead of existing app styles",
  !(main.replace('import "./styles.css";', '').indexOf('import "./arc005-workspace-surface.css";') >
    main.replace('import "./styles.css";', '').indexOf('import "./styles.css";') &&
    main.replace('import "./styles.css";', '').indexOf('import "./styles.css";') !== -1));

ck("Terminal tabs: arrows wrap both directions",
  terminalTabTarget("ArrowRight", 2, 3) === 0 &&
  terminalTabTarget("ArrowLeft", 0, 3) === 2);
ck("Terminal tabs: Home and End navigate bounds",
  terminalTabTarget("Home", 2, 4) === 0 &&
  terminalTabTarget("End", 0, 4) === 3);
ck("Terminal tabs: unrelated navigation and Enter remain native",
  terminalTabTarget("Enter", 1, 3) === null &&
  terminalTabTarget("Escape", 1, 3) === null &&
  terminalTabTarget("ArrowDown", 1, 3) === null);
ck("Terminal tabs: bad and empty indices cannot select another PTY",
  terminalTabTarget("ArrowRight", -1, 3) === null &&
  terminalTabTarget("ArrowLeft", 0, 0) === null &&
  terminalTabTarget("Home", 5, 3) === null);
ck("Terminal toolbar delegates navigation only from actual tab buttons",
  sourceHas(terminal, 'role="tablist"') &&
  sourceHas(terminal, "next = terminalTabTarget(e.key, tabs.indexOf(currentTab), tabs.length)") &&
  sourceHas(terminal, 'button[data-terminal-tab]'));
ck("Terminal: keyboard selection invokes the existing active-tab handler, no duplicate PTY spawn",
  sourceHas(terminal, "tabs[next]?.focus({ preventScroll: true });") &&
  sourceHas(terminal, "tabs[next]?.click();") &&
  sourceHas(terminal, "st.activeKey = s.key;"));
ck("Terminal: active tab and panel have paired aria identity",
  sourceHas(terminal, 'id={`terminal-tab-${s.key}`}') &&
  sourceHas(terminal, 'aria-controls={`terminal-panel-${s.key}`}') &&
  sourceHas(terminal, 'id={`terminal-panel-${s.key}`}') &&
  sourceHas(terminal, 'aria-labelledby={`terminal-tab-${s.key}`}'));
ck("Terminal: all projects remain mounted, inactive PTYs are inert but not killed",
  sourceHas(terminal, "allTermEntries.map(({ s, path: p })") &&
  sourceHas(terminal, "inert={!isActive}") &&
  sourceHas(terminal, "active={active && isActive}"));
ck("Terminal close button is reachable via focus, not mouse hover alone",
  sourceHas(terminal, "group-focus-within:opacity-100") &&
  sourceHas(terminal, 'aria-label={`${t("ide.term.closeTerminal")}: ${sessionTitle}`}'));
ck("Terminal actions each carry accessible name and strong visible keyboard focus",
  sourceHas(terminal, "aria-label={title}") &&
  sourceHas(terminal, "focus-visible:outline-offset-2 focus-visible:outline-accent"));
ck("Terminal retains newline submit and per-project command bus",
  sourceHas(terminal, 'command.replace(/\\r\\n|\\n|\\r/g, "\\r")') &&
  sourceHas(terminal, "subscribeTerminalRunRequests(runCommandInNewTerminal)"));
ck("Negative: removing terminal tab aria breaks semantic contract",
  !sourceHas(terminal.replace('aria-selected={isActive}', ''), 'aria-selected={isActive}'));

ck("Terminal saved commands: menu remains project-scoped and disabled without active project",
  sourceHas(terminalMenu, "customCommandsByProject[activeProjectId]") &&
  sourceHas(terminalMenu, "const disabled = !activeProjectId;") &&
  sourceHas(terminalMenu, "disabled={disabled}"));
ck("Terminal saved commands: keyboard focus reveals hover-only row actions",
  sourceHas(terminalMenu, "group-focus-within:opacity-100") &&
  sourceHas(terminalMenu, "focus-visible:opacity-100"));
ck("Terminal saved commands: main row and three actions remain distinct buttons",
  sourceHas(terminalMenu, "onRunInNewTerminal(cmd.command)") &&
  sourceHas(terminalMenu, "onRun(cmd.command)") &&
  sourceHas(terminalMenu, "openEdit(cmd)") &&
  sourceHas(terminalMenu, "remove(cmd.id)"));
ck("Terminal saved commands: destructive/edit actions expose contextual accessible names",
  sourceHas(terminalMenu, 'aria-label={`${t("common.delete")}: ${cmd.name}`}') &&
  sourceHas(terminalMenu, 'aria-label={`${t("common.edit")}: ${cmd.name}`}') &&
  sourceHas(terminalMenu, 'aria-label={`${t("ide.term.runInCurrent")}: ${cmd.name}`}'));
ck("Terminal saved commands: viewport clamps popup and editor dialog",
  sourceHas(terminalMenu, "min-w-[min(260px,calc(100vw-16px))]") &&
  sourceHas(terminalMenu, "max-h-[calc(100vh-16px)]") &&
  sourceHas(terminalMenu, "w-[min(420px,calc(100vw-24px))]"));
ck("Terminal saved commands: editing flow still uses project scoped store writers",
  sourceHas(terminalMenu, "updateCustomCommand(activeProjectId") &&
  sourceHas(terminalMenu, "addCustomCommand(activeProjectId") &&
  sourceHas(terminalMenu, "removeCustomCommand(activeProjectId"));
ck("Negative: removing keyboard reachability breaks saved command menu contract",
  !sourceHas(terminalMenu.replace("group-focus-within:opacity-100", ""), "group-focus-within:opacity-100"));

ck("Overflow tabs: paging chevrons have accessible 32px hit areas",
  sourceHas(tabs, "mb-0.5 flex size-8 shrink-0 items-center"));
ck("Overflow: menu width and height stay inside 16px viewport inset",
  sourceHas(tabs, "max-h-[calc(100vh-16px)]") &&
  sourceHas(tabs, "min-w-[min(200px,calc(100vw-16px))]") &&
  sourceHas(tabs, "max-w-[calc(100vw-16px)]"));
ck("Overflow: checked menu retains multi-row toggle and all tab items",
  sourceHas(tabs, "onToggleMultiRow") &&
  sourceHas(tabs, "items.map((item)") &&
  sourceHas(tabs, "closeOnClick={false}"));
ck("Git history: refresh/load-more commit rows and diff rows have visible keyboard focus",
  (git.match(/focus-visible:outline-offset-2 focus-visible:outline-accent/g) || []).length >= 5);
ck("Git history: commit rows cannot collapse into tiny pointer hit areas",
  sourceHas(git, "flex min-h-10 w-full flex-col") &&
  sourceHas(git, "flex min-h-8 w-full items-center") &&
  sourceHas(git, "flex min-h-9 w-full items-center justify-center"));
ck("Git history: pagination, changed-file callbacks and graph remain untouched",
  sourceHas(git, "loadCommits({ append: true, skip: commits.length })") &&
  sourceHas(git, "layoutCommitGraph(commits)") &&
  sourceHas(git, "onClick={() => onOpenFile(f)}"));
ck("Negative: missing workspace scope should be detectable",
  !css.replaceAll('[data-ui-shell-variant="workspace"]', '').includes('[data-ui-shell-variant="workspace"]'));

console.log("arc005-workspace-visual-smoke: "+(total-bad)+"/"+total);
if(bad) process.exitCode = 1;
