/** No Electron, real filesystem lookup, network or user data. */
export type File = { name: string; path: string; relativePath: string };
export const state = {
  projects: [] as { path: string }[],
  sessionsByProject: {} as Record<string, { worktreePath: string }[]>,
  pinnedSessions: [] as { worktreePath: string }[],
  streamSessions: [] as { worktreePath: string }[],
  worktreeInfoByRepo: {} as Record<string, { worktrees: { path: string }[] }>,
};
export const calls: string[] = [];
export let files: File[] = [];
export function reset(roots: string[] = ["/project"], entries: File[] = []) {
  state.projects = roots.map(path => ({ path }));
  state.sessionsByProject = {}; state.pinnedSessions = []; state.streamSessions = [];
  state.worktreeInfoByRepo = {}; calls.length = 0; files = entries;
}
export const api = { file: { search: async ({ query }: { query: string }) => {
  calls.push(query);
  return { files: files.filter(f => f.relativePath.toLowerCase().includes(query.toLowerCase())) };
} } };
export const useSessionStore = { getState: () => state };
