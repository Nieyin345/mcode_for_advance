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
// 导航/重载前发出的批准不得由同一个 webContents.id 的新文档代答。
const pending3 = bridge.request(card, A);
const staleId = requestId;
const pendingB = bridge.request(card, B);
const activeBId = requestId;
const revoke = (bridge as unknown as { cancelForSender?: (senderId: number) => number }).cancelForSender?.(A) ?? 0;
check("★ 原窗口导航后仅撤销该窗口的未决审批", revoke === 1, revoke);
check("★ 导航后的同一 sender.id 不能兑现旧请求", bridge.resolve({ requestId: staleId, approved: true }, A) === false);
check("★ 旧窗口 pending 必按拒绝结算", await pending3 === false);
check("★ 其他窗口同时存在的审批不受影响", bridge.resolve({ requestId: activeBId, approved: true }, B) === true);
check("★ 其他窗口有效批准仍可生效", await pendingB === true);
const pending4 = bridge.request(card, A);
bridge.dispose();
check("销毁/退出时未决审批默认拒绝", await pending4 === false);
const bridgeWithoutWindow = new NodeInstallApprovalBridge({send:()=>false},100);
check("无窗口立即拒绝", await bridgeWithoutWindow.request(card,A) === false);
// A sender adapter must not obtain user approval before the host has
// confirmed that the card was actually delivered. A synchronous reentrant
// callback followed by false/throw is a failed delivery, never consent.
for (const failureMode of ["false", "throw"] as const) {
  let bridge: NodeInstallApprovalBridge;
  let prematureAccepted: boolean | null = null;
  bridge = new NodeInstallApprovalBridge({
    send: (message, senderId) => {
      prematureAccepted = bridge.resolve({ requestId: message.requestId, approved: true }, senderId);
      if (failureMode === "throw") throw new Error("FAKE_CARD_DELIVERY_FAILED");
      return false;
    },
  }, 100);
  const result = await bridge.request(card, A);
  check("★ card delivery "+failureMode+" cannot synchronously pre-authorize its own request",
    prematureAccepted === false, prematureAccepted);
  check("★ undelivered/throwing approval card settles fail-closed "+failureMode,
    result === false, result);
  bridge.dispose();
}
// A sender can synchronously attempt a response before returning true.
// That premature decision is discarded, but the real user's later click
// is still accepted once the delivery was actually confirmed.
let earlyBridge: NodeInstallApprovalBridge;
let pendingEarlyId = "";
let rejectedBeforeDelivery: boolean | null = null;
earlyBridge = new NodeInstallApprovalBridge({
  send: (message, senderId) => {
    pendingEarlyId = message.requestId;
    rejectedBeforeDelivery = earlyBridge.resolve({ requestId: pendingEarlyId, approved: true }, senderId);
    return true;
  },
}, 100);
const pendingAfterDelivery = earlyBridge.request(card, A);
check("★ response before acknowledged delivery is not user consent", rejectedBeforeDelivery === false);
check("★ genuine later response after acknowledged delivery succeeds",
  earlyBridge.resolve({ requestId: pendingEarlyId, approved: true }, A) === true);
check("★ later response settles the request as approved", await pendingAfterDelivery === true);
earlyBridge.dispose();
// The approval card can be dynamically assembled from external install
// metadata: TypeScript Omit does not remove runtime "channel"/"requestId".
// The Host must own both fields even if the input object contains them.
let deliveredChannel = "";
let deliveredRequestId = "";
let forgedBridge = new NodeInstallApprovalBridge({
  send: (message) => {
    deliveredChannel = message.channel;
    deliveredRequestId = message.requestId;
    return true;
  },
}, 100);
const adversarialCard = { ...card,
  channel: "customUi:unsafeOverride",
  requestId: "attacker-chosen-request",
} as typeof card;
const forgedPending = forgedBridge.request(adversarialCard, A);
check("★ untrusted card cannot override Host approval push channel",
  deliveredChannel === "workflowEngine:nodeInstallApproval", deliveredChannel);
check("★ untrusted card cannot override Host minted approval requestId",
  deliveredRequestId !== "attacker-chosen-request" && /^[0-9a-f-]{36}$/.test(deliveredRequestId), deliveredRequestId);
check("★ forged card requestId is not a valid approval ticket",
  forgedBridge.resolve({requestId:"attacker-chosen-request",approved:true},A) === false);
check("★ Host minted ID still allows the original trusted window to reject",
  forgedBridge.resolve({requestId:deliveredRequestId,approved:false},A) === true &&
  await forgedPending === false);
forgedBridge.dispose();
// Renderer delivery is an explicit boolean acknowledgement. A truthy non-boolean
// from an unsafe adapter must not silently upgrade a request to "delivered".
for (const badAck of ["sent", 1] as const) {
  let badId = "";
  const nonBooleanBridge = new NodeInstallApprovalBridge({
    send: (message) => {
      badId = message.requestId;
      return badAck as never;
    },
  }, 20);
  const unacknowledged = nonBooleanBridge.request(card, A);
  check("★ nonboolean delivery "+String(badAck)+" must not authorize approval",
    nonBooleanBridge.resolve({requestId:badId,approved:true},A)===false);
  check("★ nonboolean delivery "+String(badAck)+" refuses without an authenticated renderer ack",
    await unacknowledged === false);
  nonBooleanBridge.dispose();
}
// A scripted/compromised UI must not allocate unlimited pending approval
// promises and timers by rapidly starting installs without answering cards.
const floodIds: string[] = [];
const floodBridge = new NodeInstallApprovalBridge({
  send: (message) => { floodIds.push(message.requestId); return true; },
}, 500);
const firstBatch = Array.from({length:32}, ()=>floodBridge.request(card,A));
const overCapacity = floodBridge.request(card,A);
const overflowId = floodIds[32] ?? "missing";
check("★ bounded approval bridge does not dispatch card number 33",
  floodIds.length===32, floodIds.length);
check("★ an excess approval cannot be approved via a forged overflow ticket",
  floodBridge.resolve({requestId:overflowId,approved:true},A)===false);
floodBridge.dispose();
check("all pending ordinary approvals are revoked when window closes",
  (await Promise.all(firstBatch)).every(v=>v===false));
check("★ excess approval fails closed without requiring renderer interaction",
  await overCapacity===false);
// A disposed bridge belongs to a destroyed renderer lifecycle. An old
// reference must never mint fresh install approvals after shutdown.
const priorId = requestId;
const postDispose = bridge.request(card, A);
const postDisposeId = requestId;
check("★ disposed bridge must not deliver a new approval card", postDisposeId === priorId);
check("★ disposed bridge cannot accept a late fresh approval",
  bridge.resolve({requestId:postDisposeId, approved:true}, A) === false);
check("★ disposed bridge request settles as denial", await postDispose === false);
// IPC data may be malformed at runtime despite static TypeScript typing.
let malformedResult: boolean | null = null;
let malformedThrew = false;
try { malformedResult = bridgeWithoutWindow.resolve(null as never, A); }
catch { malformedThrew = true; }
check("★ malformed reply does not throw across the main-process approval IPC", !malformedThrew && malformedResult === false);
// If a hostile in-process response has a throwing approved getter, the
// previous implementation deleted pending BEFORE reading it and left the
// original approval promise unsettled forever. Never strand a caller.
let hostileReplyId = "";
const hostileBridge = new NodeInstallApprovalBridge({send: (message) => { hostileReplyId = message.requestId; return true; }}, 100);
const hostilePending = hostileBridge.request(card, A);
let hostileThrew = false;
let hostileConsumed = true;
try {
  const response = { requestId: hostileReplyId, get approved(): boolean { throw new Error("hostile approved getter"); } };
  hostileConsumed = hostileBridge.resolve(response as never, A);
} catch { hostileThrew = true; }
check("★ hostile response getter must not throw or report approval accepted", !hostileThrew && hostileConsumed === false);
const hostileSettled = await Promise.race([hostilePending.then(value => value === false),
  new Promise<boolean>(resolve => setTimeout(() => resolve(false), 25))]);
check("★ hostile response getter settles its pending approval with denial", hostileSettled);
hostileBridge.dispose();
console.log(`mc057-approval-identity-smoke:${total-failures}/${total}`);
if(failures)process.exitCode=1;
