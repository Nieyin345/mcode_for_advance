export const nativeCalls: Array<Record<string, unknown>> = [];
export let ready = true;
export function setNativeReady(next: boolean): void { ready = next; }
export class OwnedNodeRedRuntime {
  nativeManualTarget(workflowId: string, triggerNodeId: string): void {
    if (!ready || workflowId !== "native-flow" || triggerNodeId !== "native-manual")
      throw Error("原生手动触发节点不可用");
  }
  async runNativeManual(workflowId: string, triggerNodeId: string, facts: Record<string, unknown>) {
    this.nativeManualTarget(workflowId, triggerNodeId);
    nativeCalls.push({ workflowId, triggerNodeId, facts });
    return { ok: true };
  }
}
const instance = new OwnedNodeRedRuntime();
export const workflowEngineRegistry = { get: () => instance };
