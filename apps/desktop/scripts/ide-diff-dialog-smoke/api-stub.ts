/**
 * `@renderer/lib/api.js` 替身:只实现 GitDiffDialog 用到的 `git.status`。
 * 测试直接替换 `gitHooks.status` 就能扣住/放行某个仓库的回包(见 main.ts)。
 */
import type { GitStatusResult, GitFileStatus } from "@contracts/ipc";

export const gitHooks = {
  status: async (_input: { repoPath: string }): Promise<{ status: GitStatusResult }> => ({
    status: { branch: "", ahead: 0, behind: 0, files: [] },
  }),
};

export const statusCalls: string[] = [];

export function resetHooks(): void {
  statusCalls.length = 0;
  gitHooks.status = async () => ({ status: { branch: "", ahead: 0, behind: 0, files: [] } });
}

export function mkStatus(branch: string, file: string): GitStatusResult {
  const f: GitFileStatus = { path: file, index: "unmodified", workingTree: "modified" };
  return { branch, ahead: 0, behind: 0, files: [f] };
}

export const api = {
  git: {
    status: (input: { repoPath: string }) => {
      statusCalls.push(input.repoPath);
      return gitHooks.status(input);
    },
  },
};
