import {
  runBranchNode,
  runConversationNode,
} from "@main/workflowEngines/mcodeNodeTypes.js";
import {
  branchContextForNode,
  formatBranchArrivalSection,
  normalizeBranchOptions,
} from "@main/workflowEngines/branchContext.js";
import { runAgentNode } from "@main/workflowEngines/mcodeNodePack.js";

let failures = 0;
let assertions = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  assertions++;
  if (condition) return;
  failures++;
  console.error(`FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function equal(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

async function main(): Promise<void> {
  const branchConfig = {
    id: "branch-native",
    name: "Branch",
    wires: [["target-native"], ["fallback-native"]],
    "x-mcode": {
      nodeId: "branch-logical",
      type: "mcode-branch",
      params: { decider: "user", note: "Choose the evidence route." },
      edgeMeta: [
        {
          sourceNativeId: "branch-native",
          targetNativeId: "target-native",
          sourcePort: 0,
          label: "Evidence found",
          note: "Use the retrieved evidence and cite it.",
        },
        {
          sourceNativeId: "branch-native",
          targetNativeId: "fallback-native",
          sourcePort: 1,
          label: "No evidence",
          note: "Explain what could not be found.",
        },
      ],
    },
  };

  let receivedBranchPayload: Record<string, unknown> | undefined;
  const branchResult = await runBranchNode(
    { _msgid: "msg-1", payload: { question: "Find the source." }, mcode: {} },
    branchConfig,
    {
      decide: async (payload) => {
        receivedBranchPayload = payload as unknown as Record<string, unknown>;
        return { port: 0 };
      },
    },
  );

  const options = receivedBranchPayload?.["options"] as Array<Record<string, unknown>> | undefined;
  equal("branch sends migrated edge labels to the Host", options?.[0]?.["label"], "Evidence found");
  equal("branch sends migrated edge notes to the Host", options?.[0]?.["note"], "Use the retrieved evidence and cite it.");
  equal("branch preserves port ordering", options?.[1]?.["port"], 1);

  const branch = (branchResult.msg["mcode"] as Record<string, unknown>)["branch"] as Record<string, unknown>;
  equal("branch records the exact selected target", branch["targetNodeId"], "target-native");
  equal("branch records its selected label", branch["label"], "Evidence found");
  equal("branch records the selected edge note", branch["note"], "Use the retrieved evidence and cite it.");
  equal("branch records the decision source", branch["by"], "user");

  const targetConfig = {
    id: "target-native",
    z: "tab-1",
    name: "Continue",
    instruction: "Continue using the selected route.",
    "x-mcode": {
      nodeId: "conversation-logical",
      type: "mcode-conversation",
      params: { instruction: "Continue using the selected route." },
    },
  };
  let receivedConversationPayload: Record<string, unknown> | undefined;
  const conversationResult = await runConversationNode(
    branchResult.msg,
    targetConfig,
    {
      run: async (payload) => {
        receivedConversationPayload = payload as unknown as Record<string, unknown>;
        return { text: "continued", artifacts: [], runId: "run-2" };
      },
    },
  );
  const context = receivedConversationPayload?.["branchContext"] as Record<string, unknown> | undefined;
  equal("direct target receives branch context", context?.["targetNodeId"], "target-native");
  equal("direct target receives branch note", context?.["note"], "Use the retrieved evidence and cite it.");
  equal("branch context is one-hop", (conversationResult.msg["mcode"] as Record<string, unknown>)["branch"], undefined);
  check("arrival prompt contains edge label", formatBranchArrivalSection(context).includes("Evidence found"));
  check("arrival prompt contains edge note", formatBranchArrivalSection(context).includes("cite it"));

  const unrelatedConfig = {
    ...targetConfig,
    id: "unrelated-native",
    "x-mcode": { nodeId: "unrelated-logical", type: "mcode-conversation", params: { instruction: "Continue." } },
  };
  let unrelatedPayload: Record<string, unknown> | undefined;
  const unrelatedResult = await runConversationNode(branchResult.msg, unrelatedConfig, {
    run: async (payload) => {
      unrelatedPayload = payload as unknown as Record<string, unknown>;
      return { text: "unrelated", artifacts: [], runId: "run-3" };
    },
  });
  equal("unrelated node cannot consume another target's context", unrelatedPayload?.["branchContext"], undefined);
  equal("unrelated node clears stale branch metadata", (unrelatedResult.msg["mcode"] as Record<string, unknown>)["branch"], undefined);
  equal("branch helper rejects a mismatched target", branchContextForNode(branchResult.msg["mcode"] as Record<string, unknown>, "unrelated-native"), undefined);

  let receivedAgentPayload: Record<string, unknown> | undefined;
  const agentResult = await runAgentNode(
    branchResult.msg,
    {
      ...targetConfig,
      instruction: "Summarize the evidence.",
      capability: "read",
      "x-mcode": { nodeId: "agent-logical", type: "mcode-agent", params: { instruction: "Summarize the evidence.", capability: "read" } },
    },
    {
      run: async (payload) => {
        receivedAgentPayload = payload as unknown as Record<string, unknown>;
        return { text: "summary", artifacts: [], runId: "run-4" };
      },
    },
  );
  equal("agent target receives branch note", (receivedAgentPayload?.["branchContext"] as Record<string, unknown> | undefined)?.["note"],
    "Use the retrieved evidence and cite it.");
  equal("agent consumes branch context after dispatch", (agentResult.msg["mcode"] as Record<string, unknown>)["branch"], undefined);

  const normalized = normalizeBranchOptions([
    { port: 0, label: "first", note: "first note" },
    { port: 0, label: "duplicate must be ignored" },
    { port: 9, label: "out of range" },
  ], 2);
  equal("branch option normalization retains the first valid port", normalized[0]?.label, "first");
  equal("branch option normalization rejects duplicate ports", normalized[0]?.note, "first note");
  equal("branch option normalization supplies a safe fallback", normalized[1]?.label, undefined);
  equal("invalid port counts produce no options", normalizeBranchOptions([], 13).length, 0);

  console.log(`mcode-branch-context-smoke: ${assertions - failures}/${assertions} assertions passed; failures=${failures}`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
