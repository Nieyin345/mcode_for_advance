/** F039: use the existing isolated Electron U1 runner, not another app/window harness.
 * This is a REAL Monaco editor in Electron with a deterministic provider transport.
 * It validates renderer interactions, not the production preload/main IPC chain.
 */
import {defineU1Journey,step} from "../../electron-u1/driver/index.js";

export const journeys=[defineU1Journey({
  name:"theia-native-monaco-rename-fix",
  launch:{page:{file:"theia-native.html"},preload:"none",
    assertions:{dom:true,visual:true,sideEffect:true}},
  steps:[
    step.waitFor("#ready","real-monaco-ready",{text:"ready",timeoutMs:20000}),
    step.assertEvaluated("window.__probe && window.__probe.model.getValue()","native-text","initial-model"),
    step.click(".monaco-editor","focus-native-editor"),
    step.press("F2","rename-keybinding"),
    step.waitFor(".rename-box input","rename-input-visible",{timeoutMs:10000}),
    step.assertEvaluated("document.querySelector('.rename-box input').value","native-text","provider-prepare-rename-placeholder"),
    step.eval("(() => {const input=document.querySelector('.rename-box input');input.focus();input.select();return input.value})()","select-rename-input"),
    step.assertEvaluated("(() => {const input=document.querySelector('.rename-box input');return input.selectionStart===0&&input.selectionEnd===input.value.length})()",true,"selected-all-current-name"),
    step.type(".rename-box input","edited-name","type-rename"),
    step.press("Enter","commit-rename"),
    step.assertEvaluated("window.__probe.model.getValue()","edited-name","rename-changed-real-monaco"),
    step.press("z","native-undo",["control"]),
    step.assertEvaluated("window.__probe.model.getValue()","native-text","undo-returns-original"),
    step.click(".monaco-editor","focus-for-fix"),
    step.press(".","trigger-quick-fix",["control"]),
    step.waitFor(".action-widget","code-action-widget-visible",{timeoutMs:10000}),
    step.screenshot("code-action-menu","real-monaco-quick-fix"),
    step.press("Enter","apply-quick-fix"),
    step.assertEvaluated("window.__probe.model.getValue()","fixed-text","fix-changed-real-monaco"),
    step.press("z","undo-quick-fix",["control"]),
    step.assertEvaluated("window.__probe.model.getValue()","native-text","fix-undo-restores-model"),
    step.assertEvaluated("window.__probe.calls.some(x=>x.op==='languageQuery'&&x.query==='rename'&&x.editContext?.prepare===true)&&window.__probe.calls.some(x=>x.op==='languageQuery'&&x.query==='codeActions')",
      true,"real-provider-calls"),
    step.eval("window.__probe.settings.rejectRename=true","reject-later-renames"),
    step.click(".monaco-editor","focus-for-rejected-rename"),
    step.press("F2","open-rejected-rename"),
    step.waitFor(".rename-box input","rejected-rename-input-visible",{timeoutMs:10000}),
    step.eval("(() => {const input=document.querySelector('.rename-box input');input.focus();input.select()})()","select-rejected-rename"),
    step.type(".rename-box input","should-not-apply","type-rejected-name"),
    step.press("Enter","submit-rejected-rename"),
    step.sleep(150,"await-rejected-provider-response"),
    step.assertEvaluated("window.__probe.model.getValue()","native-text","rejected-rename-never-edits-model"),
    step.assertEvaluated("window.__probe.calls.some(x=>x.op==='languageQuery'&&x.query==='rename'&&x.editContext?.newName==='should-not-apply')",true,"rejection-was-really-queried"),
  ],
})];
