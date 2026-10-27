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
/* 【Q5：旧执行器已退场】**这条判据原来是「旧归属工作流仍走旧入口」** —— 而 Q5 之后
 * 旧执行器对**用户图**一条监听都不装、手动入口也一律拒绝（功能文档 WF-09：
 * 「任何仍归旧执行器的用户图都不会被运行」，四个入口给**同一句话**）。
 *
 * 所以这里要验的不是"还能跑"，而是**拒绝得对不对**：
 *   - 不落到旧执行器（`legacyCalls` 不增）—— 否则就是双执行器并存；
 *   - 也不冒充成原生调用（`nativeCalls` 不增）—— 那是"看起来成功了"；
 *   - 给的话**是那句共用的迁移指引**，不是"找不到触发器"这种让人无从下手的句子。 */
const legacy=await runCustomUiAutomation(native);
check("★ 旧归属工作流的自定义 UI 运行被拒绝（旧执行器已退场）", !legacy.ok, legacy);
check("★ 拒绝时没有落到旧执行器（不并存两套执行器）", legacyCalls.length===0, legacyCalls);
check("★ 拒绝时也没有冒充原生调用", nativeCalls.length===1, nativeCalls);
check("★ 拒绝话术是**迁移指引**（与手动运行/钩子/自动化同一个说法）",
  /迁移/.test(String((legacy as { error?: string }).error ?? "")), legacy);
console.log("mcode-custom-ui-native-smoke: "+(count-failed)+"/"+count);
if(failed)process.exitCode=1;
