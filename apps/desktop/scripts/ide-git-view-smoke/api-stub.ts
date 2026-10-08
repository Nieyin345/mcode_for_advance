/**
 * `@renderer/lib/api.js` 的替身。
 *
 * `GitHistoryView` 只用三个方法:`git.log` / `git.showCommit` / `git.showFile`。
 * 每个都可被测试直接替换成"扣住的回包"(见 main.ts),从而复现弱网下的乱序。
 *
 * 不走 HTTP、不连主进程:整个对象是内存里的。
 */
import type { GitCommitInfo, GitCommitFile } from "@contracts/ipc";

type CommitResult = { commit: GitCommitInfo; files: GitCommitFile[] };

export const gitHooks = {
  log: async (_input: { repoPath: string; limit: number; skip: number }): Promise<{ commits: GitCommitInfo[]; hasMore: boolean }> => ({
    commits: [],
    hasMore: false,
  }),
  showCommit: async (_input: { repoPath: string; commitHash: string }): Promise<CommitResult> => ({
    commit: { hash: "", shortHash: "", subject: "", author: "", authoredAt: "", parents: [] },
    files: [],
  }),
  showFile: async (_input: { repoPath: string; commitHash: string; filePath: string; oldPath?: string }): Promise<{ before: string; after: string }> => ({
    before: "",
    after: "",
  }),
};

export function resetHooks(): void {
  gitHooks.log = async () => ({ commits: [], hasMore: false });
  gitHooks.showCommit = async (input) => ({
    commit: { hash: input.commitHash, shortHash: input.commitHash.slice(0, 7), subject: "", author: "", authoredAt: "", parents: [] },
    files: [],
  });
  gitHooks.showFile = async () => ({ before: "", after: "" });
}

export const api = {
  git: {
    log: (input: { repoPath: string; limit: number; skip: number }) => gitHooks.log(input),
    showCommit: (input: { repoPath: string; commitHash: string }) => gitHooks.showCommit(input),
    showFile: (input: { repoPath: string; commitHash: string; filePath: string; oldPath?: string }) =>
      gitHooks.showFile(input),
  },
};
