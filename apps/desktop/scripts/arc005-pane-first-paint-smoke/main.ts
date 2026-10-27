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
/* 【UI 重建 2026-10-27】原来断言的是「这两个 key **相邻**」：
 *   source.includes("UI_PANE_WIDTHS_SETTING_KEY,\n          UI_COMPOSER_MODEL_SETTING_KEY")
 *
 * 那是个**过窄的字面量**。它守的意图是「first-paint 那批 getMany 里，pane 宽度
 * 只取一次」（取两次会多一轮 IPC，首帧几何会闪）。
 *
 * ⚠️ 同时注意：这两个 key 在**第 45 行的 import** 里也出现过一次（单行、空格分隔）。
 * 直接 `source.includes(...)` 或全局计数都会先命中 import。所以这里只截
 * `getMany({ ... keys: [ ... ] })` 那一段，在**批内部**数。 */
const firstPaintBatch = (() => {
  const start = source.indexOf("keys: [");
  if (start < 0) return "";
  const end = source.indexOf("]", start);
  return end > start ? source.slice(start, end) : "";
})();
const countKey = (k: string) => (firstPaintBatch.match(new RegExp(`\\b${k}\\b`, "g")) ?? []).length;
check("First paint getMany contains each pane layout key exactly once", (() => {
  const widths = countKey("UI_PANE_WIDTHS_SETTING_KEY");
  const layout = countKey("UI_PANE_LAYOUT_SETTING_KEY");
  return firstPaintBatch.length > 0 && widths === 1 && layout === 1;
})(), {
  widths: countKey("UI_PANE_WIDTHS_SETTING_KEY"),
  layout: countKey("UI_PANE_LAYOUT_SETTING_KEY"),
  batchKeys: firstPaintBatch.length,
});
check("Deferred settings no longer re-fetch the pane layout key",!source.includes("UI_SHORTCUTS_SETTING_KEY,\n          UI_PANE_WIDTHS_SETTING_KEY,"));
check("Pane state is set in init before deferred init schedules",source.includes("const firstPaintLayout = parseSavedPaneLayout(fp[UI_PANE_WIDTHS_SETTING_KEY]);") && source.indexOf("const firstPaintLayout") < source.indexOf("queueMicrotask(() => void get().initDeferred())"));
check("Only one parser path exists in sessionStore",!source.includes("const paneRaw = ds[UI_PANE_WIDTHS_SETTING_KEY]")&&source.includes("firstPaintLayout"));
check("Live edits are filtered before pane data are applied",source.includes("withoutLocallyEditedPaneFields(patch, paneLayoutLocalEdits)"));
check("Width clamps remain enforced on decoded values",source.includes("clampRightWidth(")&&source.includes("clampLeftWidthPct(")&&source.includes("clampBottomTerminalHeight("));
console.log("arc005-pane-first-paint "+pass+"/"+(pass+fail));if(fail)process.exitCode=1;
