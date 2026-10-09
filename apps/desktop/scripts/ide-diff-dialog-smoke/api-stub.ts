/**
 * `@renderer/lib/api.js` 替身:GitDiffDialog 用到的 `git.status` 与 `git.diff`。
 * 测试直接替换 `gitHooks.status` / `gitHooks.diff` 就能扣住/放行某个仓库的回包
 * (见 main.ts)。
 */
import type { GitStatusResult, GitFileStatus } from "@contracts/ipc";

export const gitHooks = {
  status: async (_input: { repoPath: string }): Promise<{ status: GitStatusResult }> => ({
    status: { branch: "", ahead: 0, behind: 0, files: [] },
  }),
  diff: async (_input: { repoPath: string; filePath: string; staged: boolean }): Promise<{ patch: string }> => ({
    patch: "",
  }),
};

export const statusCalls: string[] = [];
export const diffCalls: string[] = [];

export function resetHooks(): void {
  statusCalls.length = 0;
  diffCalls.length = 0;
  gitHooks.status = async () => ({ status: { branch: "", ahead: 0, behind: 0, files: [] } });
  gitHooks.diff = async () => ({ patch: "" });
}

export function mkStatus(branch: string, file: string): GitStatusResult {
  const f: GitFileStatus = { path: file, index: "unmodified", workingTree: "modified" };
  return { branch, ahead: 0, behind: 0, files: [f] };
}

/** 一份列出多个文件的 status(左栏按行渲染,判据要能分辨点的是哪个)。 */
export function mkStatusMulti(branch: string, files: string[]): GitStatusResult {
  return {
    branch,
    ahead: 0,
    behind: 0,
    files: files.map((path) => ({ path, index: "unmodified", workingTree: "modified" }) as GitFileStatus),
  };
}

/** 造一段最小 unified diff,让 `parsePatchToBeforeAfter` 能解出 A/B 两侧内容。 */
export function mkPatch(marker: string): string {
  return `@@ -1,1 +1,1 @@\n-old-${marker}\n+new-${marker}`;
}

export const api = {
  git: {
    status: (input: { repoPath: string }) => {
      statusCalls.push(input.repoPath);
      return gitHooks.status(input);
    },
    diff: (input: { repoPath: string; filePath: string; staged: boolean }) => {
      diffCalls.push(input.filePath);
      return gitHooks.diff(input);
    },
  },
};
