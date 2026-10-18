/** MC-057: caller-held requestId cannot become approval without the originating trusted renderer. */
import { NodeInstallApprovalBridge } from "@main/workflowEngines/engineNodeApprovalBridge.js";
let total = 0, failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + " — " + JSON.stringify(detail)); }
}
const card = {name:"fake-node",version:"0.0.1",source:"fixture",license:"MIT",capabilities:["network"],network:true,sha256:"f".repeat(64),intent:"install" as const};
const A = 11, B = 22;
let requestId = "";
let sentTo = 0;
const bridge = new NodeInstallApprovalBridge({ send: (message, targetId) => {
  requestId = message.requestId;
  sentTo = targetId;
  return true;
}}, 100);
const pending = bridge.request(card, A);
check("审批只发往发起该次操作的窗口", sentTo === A, sentTo);
check("其他 WebContents 拿到同一 requestId 不能代答", bridge.resolve({requestId,approved:true}, B) === false);
check("非法代答不能消耗 pending，原窗口仍可拒绝", bridge.resolve({requestId,approved:false}, A) === true);
check("拒绝不变成批准", await pending === false);
check("被消费的 requestId 不能重放", bridge.resolve({requestId,approved:true}, A) === false);
const pending2 = bridge.request(card, A);
check("即使另一窗口拿到新的 ID，仍不能批准", bridge.resolve({requestId,approved:true}, B) === false);
check("原发起窗口能批准当前请求", bridge.resolve({requestId,approved:true}, A) === true);
check("有效批准仅来自原发起窗口", await pending2 === true);
const pending3 = bridge.request(card, A);
bridge.dispose();
check("销毁/退出时未决审批默认拒绝", await pending3 === false);
const bridgeWithoutWindow = new NodeInstallApprovalBridge({send:()=>false},100);
check("无窗口立即拒绝", await bridgeWithoutWindow.request(card,A) === false);
console.log(`mc057-approval-identity-smoke:${total-failures}/${total}`);
if(failures)process.exitCode=1;
