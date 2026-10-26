/**
 * A deliberately small runtime-status port for the workflow library.
 *
 * Migrating a legacy graph to Node-RED must not reassign ownership while an
 * old run is active (including its async start reservation). The graph Runner
 * registers the only live probe when its module is loaded. If it has never
 * been loaded, there cannot be a live in-process legacy graph run.
 *
 * Avoid importing runner.ts from library.ts: doing so pulls the whole agent
 * runtime into ordinary SQL saves and creates a circular library/runner import.
 */
let activeRunProbe: ((workflowId: string) => boolean) | null = null;

/** Installed by the legacy runner on module initialization. */
export function registerWorkflowRunActivityProbe(probe: (workflowId: string) => boolean): void {
  if (activeRunProbe !== null && activeRunProbe !== probe) {
    throw Error("Legacy workflow activity probe already registered");
  }
  activeRunProbe = probe;
}

/** Fail closed if the registered probe throws or cannot establish identity. */
export function hasActiveLegacyWorkflowRun(workflowId: string): boolean {
  if (activeRunProbe === null) return false;
  try {
    return activeRunProbe(workflowId);
  } catch {
    return true;
  }
}
