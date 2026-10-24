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
await checkReject("Agent 缺绑定的原有错误契约不回退", "agent.run", {}, "Mcode sessionId is required");
await checkReject("Agent 找不到会话的原有错误契约不回退", "agent.run", { sessionId: "not-visible-session" }, "Mcode Host session missing or not user-visible");
console.log("W18 production-port errors: " + (count - failed) + "/" + count);
if (failed) process.exitCode = 1;
