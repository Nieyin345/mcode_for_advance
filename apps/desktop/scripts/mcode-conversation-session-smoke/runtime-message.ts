/**
 * W18: production port error contracts. Uses actual Node-RED Host dispatch
 * with stubbed runtime/UI and a disposable SQL data root, not a copy of its
 * sessionId guard. A missing/hidden session must fail closed in Chinese for
 * mcode-conversation without changing older agent/branch error contracts.
 */
import { initDb } from "@main/store/db.js";
import { productionNodePackServices } from "@main/workflowEngines/nodePackProductionPorts.js";
let count = 0;
let failed = 0;
async function checkReject(label: string, operation: "conversation.run" | "agent.run", params: Record<string, unknown>, required: string): Promise<void> {
  count++;
  const services = productionNodePackServices(
    () => ({ state: "stopped", port: null, reason: null, engineId: "node-red" }), undefined);
  try {
    await services.execute(operation, { params, instruction: "检查一次" });
    failed++;
    console.error("  FAIL " + label + ": unexpected execution");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes(required)) {
      failed++;
      console.error("  FAIL " + label + " message=" + JSON.stringify(message));
    } else console.log("  ok   " + label);
  }
}
await initDb(); // uses MCODE_SMOKE_DATA_ROOT, never the user's database
await checkReject("对话节点缺绑定时显示中文操作步骤", "conversation.run", {}, "请在 Node-RED 节点编辑器填写");
await checkReject("对话节点绑定了不存在的会话时中文拒绝", "conversation.run", { sessionId: "not-visible-session" }, "会话不存在或不是可用的聊天会话");
// 【Q11】agent 节点不再要求手填 sessionId：没填就按 `(工作流, 节点)` 认回那一步的
// 会话。这里 payload 没有 tabId，认不回来 —— 契约是**明确拒绝并说明原因**，而不是
// 旧的那句 "Mcode sessionId is required"（用户根本不知道那是什么）。
//
// 【2026-10-28】期望串跟着新文案改。**「不属于任何一张已保存的 Mcode 工作流」
// 那句话现在是错的**：Q11 的自动认回**从来没接进执行路径**（实现在
// `nodeSessions.ts`，172 条套件守着它本身是对的，但没有调用方），所以系统
// 现在**不会**去「找一张已保存的工作流」—— 它只是要求用户手填。
// 断言如果继续要那句话，等于要求代码撒谎。
//
// 现在守的是**真的会发生的事**：拒绝，且给出可操作的中文（不是内部字段名）。
await checkReject("Agent 缺绑定且无法认回时明确拒绝", "agent.run", {}, "此节点尚未绑定 Mcode 会话");
await checkReject("Agent 找不到会话的原有错误契约不回退", "agent.run", { sessionId: "not-visible-session" }, "Mcode Host session missing or not user-visible");
console.log("W18 production-port errors: " + (count - failed) + "/" + count);
if (failed) process.exitCode = 1;
