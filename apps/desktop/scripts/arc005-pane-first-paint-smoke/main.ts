import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSavedPaneLayout } from "../../src/renderer/stores/paneLayoutPrefs.js";
const source = readFileSync(resolve("src/renderer/stores/sessionStore.ts"), "utf8");
let pass=0, fail=0;
function check(name:string, valid:boolean) { if(valid)pass++;else fail++;console.log((valid?"PASS ":"FAIL ")+name); }
const sample = JSON.stringify({ leftPct:29, right:540, dock:"left", bottomTerminal:310, editor:62 });
const parsed = parseSavedPaneLayout(sample);
check("The saved left dock and every numeric pane share survives parsing",parsed?.dock==="left"&&parsed.leftPct===29&&parsed.right===540&&parsed.bottomTerminal===310&&parsed.editor===62);
check("Old widths-only preferences retain conventional right dock",parseSavedPaneLayout('{"leftPct":25,"right":400}')?.dock==="right");
check("Explicit right dock is restored",parseSavedPaneLayout('{"dock":"right"}')?.dock==="right");
check("Invalid or unknown dock is right, never an invented side",parseSavedPaneLayout('{"dock":"float"}')?.dock==="right");
check("Corrupt JSON does not crash startup",parseSavedPaneLayout('{broken')===null);
check("JSON primitives/arrays are rejected",["null","true","[]",'"\"left\""'].every(raw=>parseSavedPaneLayout(raw)===null));
check("Non-numeric layout fields are dropped instead of coercion",
 (()=>{const v=parseSavedPaneLayout('{"leftPct":"40","right":null,"editor":false,"bottomTerminal":[] }');return !!v&&v.dock==="right"&&Object.keys(v).length===1;})());
check("Overflow/invalid finite widths are dropped",!Object.hasOwn(parseSavedPaneLayout('{"right":1e999,"editor":1e999}')??{},"right"));
check("Old unused left px field is not reintroduced",!Object.hasOwn(parseSavedPaneLayout('{"left":999}')??{},"left"));
check("First paint getMany contains one pane layout key",source.includes("UI_PANE_WIDTHS_SETTING_KEY,\n          UI_COMPOSER_MODEL_SETTING_KEY"));
check("Deferred settings no longer re-fetch the pane layout key",!source.includes("UI_SHORTCUTS_SETTING_KEY,\n          UI_PANE_WIDTHS_SETTING_KEY,"));
check("Pane state is set in init before deferred init schedules",source.includes("const firstPaintLayout = parseSavedPaneLayout(fp[UI_PANE_WIDTHS_SETTING_KEY]);") && source.indexOf("const firstPaintLayout") < source.indexOf("queueMicrotask(() => void get().initDeferred())"));
check("Only one parser path exists in sessionStore",!source.includes("const paneRaw = ds[UI_PANE_WIDTHS_SETTING_KEY]")&&source.includes("firstPaintLayout"));
check("Live edits are filtered before pane data are applied",source.includes("withoutLocallyEditedPaneFields(patch, paneLayoutLocalEdits)"));
check("Width clamps remain enforced on decoded values",source.includes("clampRightWidth(")&&source.includes("clampLeftWidthPct(")&&source.includes("clampBottomTerminalHeight("));
console.log("arc005-pane-first-paint "+pass+"/"+(pass+fail));if(fail)process.exitCode=1;
