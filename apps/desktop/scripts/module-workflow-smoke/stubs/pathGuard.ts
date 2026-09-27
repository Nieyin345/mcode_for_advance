export function isKnownWorkspaceRoot(path: string): boolean {
  return path === process.env.P2_WORKFLOW_WORKSPACE;
}
