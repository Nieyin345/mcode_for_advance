let calls = 0;
export function dataRoot(): string {
  const root = process.env.P2_WORKFLOW_DATA_ROOT;
  if (!root) throw new Error("Isolated workflow data root is required");
  calls++;
  return root;
}
export function dataRootCalls(): number { return calls; }
