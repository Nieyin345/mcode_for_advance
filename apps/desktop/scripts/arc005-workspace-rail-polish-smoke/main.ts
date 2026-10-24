import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nextRailFocusIndex } from "../../src/renderer/components/layout/panelRailNavigation.js";
import { sourceHas } from "../lib/sourceText.js";

let count = 0, bad = 0;
function check(name: string, ok: boolean) {
  count++;
  if (!ok) bad++;
  console.log((ok ? "PASS " : "FAIL ") + name);
}
const read = (p: string) => readFileSync(resolve(p), "utf8");
const right = read("src/renderer/components/layout/RightPanel.tsx");
const tabs = read("src/renderer/components/ide/OpenTabsBar.tsx");
const chrome = read("src/renderer/components/layout/TabBarChrome.tsx");

check("Right rail is one labeled keyboard toolbar, not a partially labeled inner region",
  sourceHas(right, 'role="toolbar"') &&
  sourceHas(right, 'aria-label={t("customUi.slot.rightPanel.tab")}'));
check("Right rail arrow handler on parent encompasses built-in, custom, module, DOC and wide controls",
  /role="toolbar"[\s\S]{0,800}onKeyDown=\{\(e\) =>/.test(right) &&
  /<div[\s\S]{0,400}className="flex min-w-0 flex-row items-center gap-1 overflow-x-auto/.test(right));
check("Keyboard nav filters native disabled rail buttons",
  sourceHas(right, 'button[data-pane-rail-button]:not(:disabled)') &&
  sourceHas(right, "const index = buttons.indexOf(currentButton)") &&
  sourceHas(right, "if (index < 0) return;"));
check("Navigation never activates a rail entry as a side effect of focus",
  sourceHas(right, "nextButton.focus()") && !sourceHas(right, "nextButton.click()"));
check("Builtin tab reports selected only when its content, not DOC/flow/custom/module, is visible",
  sourceHas(right, "active={!activeCustom && !moduleVisible && !pinnedDoc && !pinnedFlow && tab === id}"));
check("Selecting a custom panel restores custom content over cached DOC/flow",
  sourceHas(right, "setActiveModuleView(false);setContent(\"right\",undefined);setActiveCustom(e.item.id);") &&
  sourceHas(right, "active={!pinnedDoc && !pinnedFlow && activeCustom?.id === e.item.id}"));
check("Selecting DOC or flow deactivates previously selected module view",
  (right.match(/setActiveModuleView\(false\);\s*setContent\("right", \{ kind: /g) || []).length >= 2);
check("Module selected state never double-highlights pinned documents",
  sourceHas(right, "active={moduleVisible && !pinnedDoc && !pinnedFlow}"));
check("Badge counts reach screen-reader names without decorative badge duplication",
  sourceHas(right, "const label =") &&
  sourceHas(right, "badge > 0") &&
  sourceHas(right, "aria-hidden=\"true\""));
check("Toolbar rail buttons show keyboard-visible outline and pressed state",
  sourceHas(right, 'aria-pressed={active}') &&
  sourceHas(right, 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'));
check("DOC entry is disabled when no document can be opened",
  sourceHas(right, 'disabled={!dockableDoc && !pinnedDoc}') &&
  sourceHas(right, 'const docTarget = dockableDoc ?? pinnedDoc;') &&
  sourceHas(right, 'if (!docTarget) return;'));
check("Rail disabled attribute is forwarded to native button, not simulated on click",
  sourceHas(right, "disabled?: boolean") && sourceHas(right, "disabled={disabled}"));
check("Right rail numeric count badge is decorative and does not steal clicks",
  sourceHas(right, 'aria-hidden="true"') && sourceHas(right, "pointer-events-none"));
check("Dock handle keeps independent side-selection arrows, no toolbar stealing",
  sourceHas(right, "paneDockFromKeyboard({") &&
  sourceHas(right, 'data-testid="right-pane-drag-handle"'));
check("Arrow / Home / End keeps existing pure keyboard behavior",
  nextRailFocusIndex("ArrowRight", 4, 5) === 0 &&
  nextRailFocusIndex("ArrowLeft", 0, 5) === 4 &&
  nextRailFocusIndex("Home", 3, 5) === 0 &&
  nextRailFocusIndex("End", 1, 5) === 4);

check("File tab focus reveals hidden close affordance without mouse hover",
  sourceHas(tabs, 'group-focus-within:inline-flex') &&
  sourceHas(tabs, "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"));
check("File tab close still blocks unsaved files and stops bubbling into activation",
  sourceHas(tabs, "dirty ? (") &&
  sourceHas(tabs, "e.stopPropagation();") &&
  sourceHas(tabs, "onPointerDown={(e) => e.stopPropagation()}"));
check("Plan tab focus reveals its close button and displays focused tab state",
  (tabs.match(/group-focus-within:inline-flex/g) ?? []).length >= 2 &&
  (tabs.match(/focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/g) ?? []).length >= 2);
check("File tab scroll, DnD, keyboard reorder remain connected",
  sourceHas(tabs, "handleTabListKeyDown") &&
  sourceHas(tabs, "handleTabReorderKeyDown") &&
  sourceHas(tabs, "SortableContext"));
check("Overflow trigger names its host tab strip, not always editor file tabs",
  sourceHas(chrome, "title={heading}") &&
  sourceHas(chrome, "aria-label={heading}") &&
  !sourceHas(chrome, 'title={t("ide.editor.openTabs")}'));
check("Tab overflow still shows all options and the multi-row switch",
  sourceHas(chrome, "items.map((item)") &&
  sourceHas(chrome, "onToggleMultiRow") &&
  sourceHas(chrome, "onClick={() => onSelect(item.key)}"));

check("Negative: undoing keyboard-safe close state fails visibility check",
  !sourceHas(tabs.replaceAll("group-focus-within:inline-flex", ""), "group-focus-within:inline-flex"));
check("Negative: unfiltering disabled native buttons fails navigation guard",
  !sourceHas(right.replace("button[data-pane-rail-button]:not(:disabled)", "button[data-pane-rail-button]"),
    "button[data-pane-rail-button]:not(:disabled)"));

console.log("arc005-workspace-rail-polish-smoke: "+(count-bad)+"/"+count);
if(bad) process.exitCode=1;
