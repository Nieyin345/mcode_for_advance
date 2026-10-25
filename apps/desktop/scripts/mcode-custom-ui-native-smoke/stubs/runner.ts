export const legacyCalls: Array<Record<string, unknown>> = [];
export const automationRunner = {
  runWithTarget: async (workflowId: string, triggerNodeId: string, target: unknown, input: unknown) => {
    legacyCalls.push({ workflowId, triggerNodeId, target, input });
    return { ok: true };
  },
};
