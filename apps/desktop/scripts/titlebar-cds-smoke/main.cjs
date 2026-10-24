/**
 * ARC-005 / Claude Code workspace chrome contract (source-level guard).
 * Scope: visible titlebar hierarchy + startup actions, not a pixel-diff or full Electron U1.
 * Fixtures never access real user data. Run via run-smokes.mjs titlebar-cds-smoke.
 */
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const titlebar = read("src/renderer/components/layout/Titlebar.tsx");
const welcome = read("src/renderer/components/chat/EmptyThreadWelcome.tsx");
const shell = read("src/renderer/components/shell/ClassicShell.tsx");
const pane = read("src/renderer/components/layout/ThreePaneLayout.tsx");
let total = 0, fails = 0;
function check(name, ok) {
  total++;
  if (ok) console.log("  ok   " + name);
  else { fails++; console.error("  FAIL " + name); }
}
const hasHeaderChrome = (s) =>
  /data-cds-titlebar/.test(s) &&
  /h-\[45px\]/.test(s) &&
  /border-b\s+border-edge\/50\s+bg-surface/.test(s) &&
  /WebkitAppRegion:\s*"drag"/.test(s) &&
  /pr-\[138px\]/.test(s) &&
  /trafficLightSpacerWidth\(/.test(s);
const hasAccessibleToggles = (s) =>
  /aria-pressed=\{bottomTerminalOpen\}/.test(s) &&
  /aria-pressed=\{rightOpen\}/.test(s) &&
  /onClick=\{onToggleBottomTerminal\}/.test(s) &&
  /onClick=\{onToggleRight\}/.test(s) &&
  /WebkitAppRegion:\s*"no-drag"/.test(s);
const hasNeutralActive = (s) =>
  /bottomTerminalOpen\s*\?\s*"bg-surface-hover text-content"/.test(s) &&
  /rightOpen\s*\?\s*"bg-surface-hover text-content"/.test(s);
const hasWelcomeActions = (s) =>
  /data-home-section=\{id\}/.test(s) &&
  /data-home-row=\{id\}/.test(s) &&
  /void selectSession\(s\.id\)/.test(s) &&
  /setWorkflowId\(picked \? "default" : w\.id\)/.test(s) &&
  /previewLibraryItem\(it\)/.test(s) &&
  /setSettingsOpen\(true, "workflows"\)/.test(s);
const hasWelcomeHierarchy = (s) =>
  /data-arc005-welcome/.test(s) &&
  /max-w-\[760px\]/.test(s) &&
  /data-arc005-starter-card/.test(s) &&
  /\[@media\(max-height:640px\)\]:hidden/.test(s);
console.log("ARC-005 titlebar + first-screen contract");
check("45px desktop header uses one subtle dividing line and surface color, with OS dragging and control inset", hasHeaderChrome(titlebar));
check("terminal/right toggles still call their actions, expose pressed state and avoid dragging", hasAccessibleToggles(titlebar));
check("visible active toggles are neutral rather than using status/accent color", hasNeutralActive(titlebar));
check("welcome keeps all four real actions, no dummy buttons replacing business flows", hasWelcomeActions(welcome));
check("welcome content constrains its reading width, keeps action cards and low-height fallback", hasWelcomeHierarchy(welcome));
// Negative controls: deleting the rule/action must make the corresponding predicate fail.
check("negative control: removing the visual divider is detected",
  !hasHeaderChrome(titlebar.replace("border-b border-edge/50", "border-0")));
check("negative control: removing toggle accessibility is detected",
  !hasAccessibleToggles(titlebar.replace("aria-pressed={rightOpen}", "")));
check("negative control: dropping library navigation is detected",
  !hasWelcomeActions(welcome.replace("previewLibraryItem(it)", "void 0")));
const widePane = /rightSurface=\{widePanelOpen\s*\?\s*"pane"\s*:\s*"drawer"\}/;
check("wide mode uses a true resizable pane; ordinary chat keeps compact side drawer", widePane.test(shell));
check("pane and drawer render one persistent right aside, not two different trees",
  /rightEverMounted\s*&&/.test(pane) &&
  /data-right-surface=\{rightSurface\}/.test(pane) &&
  /rightWidthPct=\{widePanelOpen\s*\?\s*widePanelPct/.test(shell));
check("negative control: pinning all states to drawer fails", !widePane.test(shell.replace('rightSurface={widePanelOpen ? "pane" : "drawer"}', 'rightSurface="drawer"')));
console.log("titlebar-cds-smoke:" + (total - fails) + "/" + total + " 通过");
process.exitCode = fails ? 1 : 0;
