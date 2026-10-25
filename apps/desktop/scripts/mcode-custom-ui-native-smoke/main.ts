import { runCustomUiAutomation } from "@main/customUi/runAutomation.js";
import { setEngine } from "./stubs/library.js";
import { nativeCalls, setNativeReady } from "./stubs/registry.js";
import { legacyCalls } from "./stubs/runner.js";
let count=0, failed=0;
function check(label:string,pass:boolean,detail?:unknown) {
  count++;
  if(pass)console.log("  ok   "+label);
  else { failed++;console.error("  FAIL "+label,detail); }
}
const native = {
  workflowId:"native-flow", triggerNodeId:"native-manual",
  targetMode:"context" as const, target:{kind:"collection" as const,collectionId:"c1"},
  input:{doi:"10.1000/real"},
};
setEngine("node-red");
setNativeReady(true);
const countOnly=await runCustomUiAutomation({ ...native, dryRun:true });
check("dryRun 校验原生入口但不实际派发",countOnly.ok&&nativeCalls.length===0,countOnly);
const submitted=await runCustomUiAutomation(native);
check("自定义 UI 的 context 输入交给已归属的原生运行入口",submitted.ok&&nativeCalls.length===1,submitted);
const fact=nativeCalls[0]?.facts as Record<string,unknown>|undefined;
check("调用使用旧 payloadFactsOf 语义，不改变 trigger.input.doi",
 fact?.["kind"]==="event"&&fact["event"]==="library.item.imported"
 &&fact["collectionId"]==="c1"&&fact["input.doi"]==="10.1000/real",fact);
check("Node-RED 工作流不再落进旧执行器",legacyCalls.length===0);
setNativeReady(false);
const blocked=await runCustomUiAutomation(native);
check("原生手动入口不可用时不回退旧执行器",!blocked.ok&&nativeCalls.length===1&&legacyCalls.length===0,blocked);
setEngine("mcode");
const legacy=await runCustomUiAutomation(native);
check("旧归属工作流仍走旧入口，不受 Node-RED 新路径影响",
 legacy.ok&&legacyCalls.length===1&&nativeCalls.length===1);
console.log("mcode-custom-ui-native-smoke: "+(count-failed)+"/"+count);
if(failed)process.exitCode=1;
