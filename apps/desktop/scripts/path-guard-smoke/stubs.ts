/** Only path registries are stubbed; no user data is accessed. */
export const projectPaths: string[] = [];
export const worktreeRoots: string[] = [];
export const ProjectRepo = { listPaths: (): string[] => projectPaths };
export const SessionRepo = { listWorktreeRoots: (): string[] => worktreeRoots };
export function dataRoot(): never { throw new Error("No user data root in this smoke"); }
