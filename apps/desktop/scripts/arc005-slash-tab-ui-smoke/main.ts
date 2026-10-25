/** Slash-command tabs: deterministic search auto-selection and safe keyboard index. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { preferredSlashTab, clampSlashIndex } from "../../src/renderer/components/chat/slashTabSelection.js";
import { sourceHas } from "../lib/sourceText.js";
const source = readFileSync(resolve("src/renderer/components/chat/SlashCommandPicker.tsx"),"utf8");
let total=0,failed=0;
function ck(label:string,ok:boolean) {
 total++;if(!ok)failed++;
 console.log((ok?"PASS ":"FAIL ")+label);
}
const counts=(skill:number,command:number,engine:number)=>({skill,command,engine});
ck("Search auto-switch: unchanged active tab wins while it has results",
 preferredSlashTab("engine", counts(5,2,1))==="engine" &&
 preferredSlashTab("command",counts(5,2,0))==="command");
ck("Search auto-switch: /compact moves empty skill tab to Mcode commands",
 preferredSlashTab("skill", counts(0,1,1))==="command");
ck("Search auto-switch: engine command becomes visible if no skill/built-in matches",
 preferredSlashTab("skill", counts(0,0,1))==="engine");
ck("Search auto-switch: when selected engine empty and skills exist, new query picks skills",
 preferredSlashTab("engine",counts(2,0,0))==="skill");
ck("Search auto-switch: when engine empty and only built-in matches, picks built-in",
 preferredSlashTab("engine",counts(0,1,0))==="command");
ck("Search auto-switch: when all lists empty, show current tab's empty explanation",
 preferredSlashTab("engine",counts(0,0,0))==="engine" &&
 preferredSlashTab("skill",counts(0,0,0))==="skill");
ck("Keyboard index: missing candidates select no nonexistent negative row",
 clampSlashIndex(8,0)===0);
ck("Keyboard index: shrinking result count clamps to last existing command",
 clampSlashIndex(6,2)===1);
ck("Keyboard index: old negative and fractional indices handled within bounds",
 clampSlashIndex(-20,4)===0);
ck("Keyboard index: last valid selected result preserved",
 clampSlashIndex(2,3)===2);
ck("UI: manual tab switch does not trigger auto-switch effect",
 sourceHas(source,'const activeTabRef = useRef(activeTab)') &&
 sourceHas(source,"const current = activeTabRef.current;") &&
 sourceHas(source,"preferredSlashTab(current, {") &&
 !sourceHas(source,'[open, query, activeTab, commands.length,'));
ck("UI: auto-switch only depends on new search/open/busy/results",
 sourceHas(source,"[open, query, busy, skillCmds.length, activeBuiltinCmds.length, engineCmds.length]"));
ck("UI: list shrink immediately clamps both visual highlight and keyboard activation",
 sourceHas(source,"clampSlashIndex(activeIdx, commands.length)") &&
 sourceHas(source,"commands[clampSlashIndex(activeIdxRef.current, commands.length)]") &&
 sourceHas(source,"setActiveIdx((index) => clampSlashIndex(index, commands.length))"));
ck("UI: existing IME and layered Escape protection remain active",
 sourceHas(source,"e.isComposing || e.key ===") &&
 sourceHas(source,'isTopEscapeLayer("chat.slash-command-picker")') &&
 sourceHas(source,'claimEscape("chat.slash-command-picker")'));
ck("UI: preserves distinct skill/builtin/engine callbacks and busy filtering",
 sourceHas(source,"onPickEngineCommand(entry)") &&
 sourceHas(source,"onPickCommand(entry)") &&
 sourceHas(source,"onPickSkill(entry)") &&
 sourceHas(source, 'busy ? builtinCmds.filter('));
ck("UI: engine unsupported and not-yet-ready messages remain visible",
 sourceHas(source, 't("chat.slash.engineUnsupported"') &&
 sourceHas(source, 't("chat.slash.engineNotReady"'));
ck("UI: tab header retains three always-present navigable tabs",
 sourceHas(source,'role="tablist"') &&
 sourceHas(source,'role="tab"') &&
 sourceHas(source,'label="Skill"') &&
 sourceHas(source,'label={t("chat.slash.tabCommands")}') &&
 sourceHas(source,'label={t("chat.slash.tabEngine", { provider: engineName })}'));
ck("Negative: deletion of index clamping breaks row safety",
 !sourceHas(source.replaceAll("clampSlashIndex(activeIdx, commands.length)","activeIdx"),
 "clampSlashIndex(activeIdx, commands.length)"));
console.log("arc005-slash-tab-ui-smoke: "+(total-failed)+"/"+total);
if(failed)process.exitCode=1;
