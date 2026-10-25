import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { nextRailFocusIndex } from "../../src/renderer/components/layout/panelRailNavigation.js";
let good = 0, bad = 0;
function check(name: string, ok: boolean) { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (ok) good++; else bad++; }
const src = readFileSync(resolve("src/renderer/components/layout/RightPanel.tsx"), "utf8");
check("Pane buttons have accessible name",src.includes("aria-label={title}"));
check("Pane buttons expose selected state",src.includes("aria-pressed={active}"));
check("Rail supports keyboard arrow and Home End",src.includes("nextRailFocusIndex(e.key") && src.includes("onKeyDown={(e)"));
check("Rail moves focus without click",src.includes("nextButton.focus({ preventScroll: true })") && !src.includes("nextButton.click()"));
check("Rail reveals offscreen focus",src.includes("revealRailItemWithin(rail, nextButton)") && !src.includes("nextButton.scrollIntoView"));
check("Keyboard respects IME and modifiers",src.includes("e.nativeEvent.isComposing") && src.includes("e.altKey") && src.includes("e.ctrlKey") && src.includes("e.metaKey"));
check("Preserve existing business behavior",src.includes("toggleBrowser") && src.includes("setActiveCustom(null)") && src.includes("openCustomUiSettings"));
// E1: run the SAME production key navigation function, not a duplicated mock.
check("ArrowRight moves and wraps",nextRailFocusIndex("ArrowRight", 2, 3) === 0);
check("ArrowLeft moves and wraps",nextRailFocusIndex("ArrowLeft", 0, 3) === 2);
check("Home selects first even from last",nextRailFocusIndex("Home", 2, 3) === 0);
check("End selects last even from first",nextRailFocusIndex("End", 0, 3) === 2);
check("Unrelated key ignored",nextRailFocusIndex("Enter", 0, 3) === null);
check("Empty or corrupt focus position ignored",nextRailFocusIndex("ArrowLeft", 0, 0) === null && nextRailFocusIndex("ArrowRight", -1, 4) === null);
console.log(`arc005-panel-rail: ${good}/${good+bad}`);
if (bad) process.exitCode=1;
