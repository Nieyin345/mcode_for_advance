/**
 * Git 面板全家桶:状态 / 暂存 / 提交 / 推拉 / diff / 历史 / 分支 / 合并 / worktree。
 *
 * 从 `ipc.ts` 按域拆出(见该文件头)。
 */

import { z } from "zod";

/* ── Git operations (status / stage / commit / push / pull / diff) ──
 *  All git operations are scoped to a `repoPath` that must resolve inside a
 *  known project root. A single project folder may host MULTIPLE git repos
 *  (monorepo, submodules, nested projects) — `git.discoverRepos` finds them. */

/** A git repository discovered under a project folder. `path` is the absolute
 *  repo root (the directory containing `.git`). `name` is the relative path
 *  from the project root (or the basename for the root itself). */
export interface GitRepo {
  /** Absolute path to the repo root (contains `.git`). */
  path: string;
  /** Display name: path relative to the project root, or the folder name. */
  name: string;
  /** Always true — discriminator for future result unions. */
  isRepo: true;
}

/** Git status code for a single file, mirroring porcelain output. `index` is
 *  the staged (cached) status; `workingTree` is the unstaged status. Both use
 *  the same union of git status codes. */
export type GitStatusCode =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "ignored"
  | "untracked";

/** One file's status in a repo. `path` is relative to the repo root. */
export interface GitFileStatus {
  path: string;
  /** Staged status (what's in the index vs HEAD). */
  index: GitStatusCode;
  /** Working-tree status (what's on disk vs the index). */
  workingTree: GitStatusCode;
}

/** Full status of a single repo. */
export interface GitStatusResult {
  /** Current branch name (empty in detached HEAD). */
  branch: string;
  /** Commits ahead of upstream (0 if no upstream). */
  ahead: number;
  /** Commits behind upstream (0 if no upstream). */
  behind: number;
  /** All changed files (staged + unstaged + untracked). */
  files: GitFileStatus[];
}

/** Result of a git operation that may fail (push/pull/commit). `ok` is false
 *  on any error; `error` carries a human-readable message (e.g. auth failure,
 *  no upstream, merge conflict). */
export interface GitOpResult {
  ok: boolean;
  /** Error message when ok is false. */
  error?: string;
  /** Set by `git:pull` when the pull produced a merge conflict. The repo is
   *  now in a conflicted (unmerged) state; `conflictedFiles` lists the paths
   *  that need resolution before the merge can be committed. */
  conflict?: boolean;
  conflictedFiles?: string[];
}

/** Discover all git repos under a project root (recursive, max depth 3).
 *  `rootOnly: true` checks ONLY the root level itself (`.git` present there)
 *  — used by the worktree picker, whose materialization requires a repo at
 *  the project root; a repo nested in a subdirectory doesn't qualify. */
export const GitDiscoverReposSchema = z.object({
  projectPath: z.string(),
  rootOnly: z.boolean().optional(),
});
export type GitDiscoverReposInput = z.infer<typeof GitDiscoverReposSchema>;

/** Input for operations targeting a single repo. */
export const GitRepoPathSchema = z.object({
  repoPath: z.string(),
});
export type GitRepoPathInput = z.infer<typeof GitRepoPathSchema>;

/** Stage (git add) specific files. `filePaths` are relative to the repo root. */
export const GitStageSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitStageInput = z.infer<typeof GitStageSchema>;

/** Unstage (git reset) specific files. `filePaths` are relative to the repo root. */
export const GitUnstageSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitUnstageInput = z.infer<typeof GitUnstageSchema>;

/** Commit staged changes with a message. */
export const GitCommitSchema = z.object({
  repoPath: z.string(),
  message: z.string().min(1),
});
export type GitCommitInput = z.infer<typeof GitCommitSchema>;

/** Diff of a single file. `filePath` is relative to repo. When `staged` is
 *  true, diffs the index against HEAD (what will be committed); otherwise
 *  diffs the working tree against the index (unstaged changes). */
export const GitDiffSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
  /** If true, show staged (cached) diff — index vs HEAD. */
  staged: z.boolean().optional(),
});
export type GitDiffInput = z.infer<typeof GitDiffSchema>;

/** Full old-side blob for the working-tree diff view. `index` reads the
 *  staged snapshot (`git show :path`), `"HEAD"` reads the last commit
 *  (`git show HEAD:path`). A missing blob (untracked / newly added /
 *  staged deletion) yields "". */
export const GitFileBlobSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
  side: z.enum(["index", "HEAD"]),
});
export type GitFileBlobInput = z.infer<typeof GitFileBlobSchema>;

/** Discard (revert) local changes to specific files. For tracked files this
 *  runs `git checkout -- <files>` (restores to index/HEAD); for untracked files
 *  it runs `git clean -f -- <files>` (removes them). The handler decides per
 *  file based on its status. */
export const GitDiscardSchema = z.object({
  repoPath: z.string(),
  filePaths: z.array(z.string()),
});
export type GitDiscardInput = z.infer<typeof GitDiscardSchema>;

/** Generate a commit message from the staged diff using an LLM.
 *  `repoPath` scopes the diff; `customModelId` + `customModelRole` select the
 *  specific model (a config + its role binding); `prompt` is the user's
 *  configured prompt template. The handler collects the staged diff, feeds
 *  it to the model via a one-shot SDK query, and returns the generated text. */
export const GitGenerateCommitSchema = z.object({
  repoPath: z.string(),
  /** Custom-model config id (from CustomModelStore). null = use built-in. */
  customModelId: z.string().nullable(),
  /** Which role binding within the config to use (e.g. "sonnet"). Ignored
   *  when customModelId is null. */
  customModelRole: z.string().nullable(),
  /** The user's prompt template. The diff is appended after this. */
  prompt: z.string(),
  /** Optional cancellation key: when present, the AbortController driving the
   *  SDK query is registered under this id so git.cancelGenerateCommit can
   *  abort an in-flight generation. */
  requestId: z.string().optional(),
  /** Which diff feeds the generation: "staged" (default — index vs HEAD,
   *  the commit-box flow) or "worktree" (working tree vs HEAD, staged AND
   *  unstaged — the worktree merge-back flow, where agent changes are
   *  typically uncommitted). */
  scope: z.enum(["staged", "worktree"]).optional(),
});
export type GitGenerateCommitInput = z.infer<typeof GitGenerateCommitSchema>;

/** Cancel an in-flight git.generateCommitMessage call (matched by the
 *  requestId passed to it). No-op if that generation already finished. */
export const GitCancelGenerateCommitSchema = z.object({
  requestId: z.string(),
});
export type GitCancelGenerateCommitInput = z.infer<typeof GitCancelGenerateCommitSchema>;

/* ── Git history (log / show commit / show file at revision) ── */

/** One commit in a `git.log` / `git.showCommit` result. */
export interface GitCommitInfo {
  /** Full commit hash. */
  hash: string;
  /** Abbreviated hash (typically 7 chars). */
  shortHash: string;
  /** First line of the commit message. */
  subject: string;
  /** Remaining body after the subject (may be empty). */
  body?: string;
  /** Author display name. */
  author: string;
  /** Author date as ISO-8601 string. */
  authoredAt: string;
  /** Parent commit hashes (empty for root commits). Returned by git.log and
   *  showCommit alike — log's %P field feeds it (see parseLogOutput). */
  parents?: string[];
}

/** File change status inside a single commit (relative to its parent). */
export type GitCommitFileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied";

/** One file changed by a commit. */
export interface GitCommitFile {
  /** Path relative to the repo root (new path for renames). */
  path: string;
  status: GitCommitFileStatus;
  /** Previous path when status is renamed/copied. */
  oldPath?: string;
  additions?: number;
  deletions?: number;
}

/** Full detail for one commit: meta + changed files. */
export interface GitCommitDetail {
  commit: GitCommitInfo;
  files: GitCommitFile[];
}

/** Paginated commit log. `limit` defaults to 50; `skip` defaults to 0. */
export const GitLogSchema = z.object({
  repoPath: z.string(),
  /** Max commits to return (default 50, max 200). */
  limit: z.number().int().min(1).max(200).optional(),
  /** Number of commits to skip (for pagination). */
  skip: z.number().int().min(0).optional(),
  /** Optional ref to start from (branch/tag/hash). Defaults to HEAD.
   *  Restricted to safe ref characters to avoid CLI injection. */
  ref: z
    .string()
    .regex(/^(?!-)[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref")
    .optional(),
});
export type GitLogInput = z.infer<typeof GitLogSchema>;

/** Commit hashes are restricted to hex so callers cannot inject CLI args. */
const GitCommitHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{4,40}$/, "invalid commit hash");

/** Load meta + changed-file list for one commit. */
export const GitShowCommitSchema = z.object({
  repoPath: z.string(),
  commitHash: GitCommitHashSchema,
});
export type GitShowCommitInput = z.infer<typeof GitShowCommitSchema>;

/** Load parent-vs-commit file contents for Monaco diff. */
export const GitShowFileSchema = z.object({
  repoPath: z.string(),
  commitHash: GitCommitHashSchema,
  /** Path relative to the repo root (new path for renames). */
  filePath: z.string().min(1),
  /** Previous path when the file was renamed/copied in this commit. */
  oldPath: z.string().optional(),
});
export type GitShowFileInput = z.infer<typeof GitShowFileSchema>;

/* ── Git branch switching (list / checkout) ── */

/** Ref kind for `git.listBranches` entries. */
export type GitBranchType = "local" | "remote" | "tag";

/** One branch / tag entry in a `git.listBranches` result. */
export interface GitBranchInfo {
  /** Display name: short name for local (main), `origin/main` for remote,
   *  tag name for tags (v1.0.0). */
  name: string;
  /** True when this is the currently checked-out ref. */
  current: boolean;
  /** Short commit hash at this ref. */
  commit: string;
  /** Commit subject (first line of the message) at this ref. */
  label: string;
  /** Ref kind discriminator. */
  type: GitBranchType;
}

/** Grouped ref list returned by `git.listBranches`. */
export interface GitBranchListResult {
  /** Current branch name (empty string in detached HEAD). */
  current: string;
  /** True when the repo is in a detached HEAD state. */
  detached: boolean;
  /** Local branches (refs/heads). */
  local: GitBranchInfo[];
  /** Remote branches (refs/remotes), excluding the HEAD symref of each remote. */
  remote: GitBranchInfo[];
  /** Tags (refs/tags), annotated + lightweight. */
  tags: GitBranchInfo[];
}

/** Switch the working tree to another branch / tag / ref.
 *
 *  - `branch` is the target ref (local branch, remote branch, tag, or `HEAD`).
 *    Restricted to safe ref characters to avoid CLI injection (same charset as
 *    `GitLogSchema.ref`).
 *  - `newBranch`, when set, creates a new local branch from `branch` and checks
 *    it out (i.e. `git checkout -b <newBranch> <branch>`). Used both for
 *    creating a fresh branch from HEAD (`branch: "HEAD"`) and for tracking a
 *    remote branch (`branch: "origin/foo"`, `newBranch: "foo"`). */
export const GitCheckoutSchema = z.object({
  repoPath: z.string(),
  branch: z.string().regex(/^(?!-)[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref"),
  /** When provided, create this new local branch from `branch` and check it out. */
  newBranch: z
    .string()
    .regex(/^(?!-)[A-Za-z0-9._/\-]+$/, "invalid branch name")
    .optional(),
});
export type GitCheckoutInput = z.infer<typeof GitCheckoutSchema>;

/** Delete a LOCAL branch (`git branch -d` / `-D` with `force`). Remote and
 *  tag rows are not deletable from the picker (deleting a remote branch means
 *  pushing a ref deletion — out of scope here). `branch` reuses the checkout
 *  branch-name charset. */
export const GitDeleteBranchSchema = z.object({
  repoPath: z.string(),
  branch: z.string().regex(/^(?!-)[A-Za-z0-9._/\-]+$/, "invalid branch name"),
  /** Force delete (`git branch -D`) — skips the fully-merged safety check. */
  force: z.boolean().optional(),
});
export type GitDeleteBranchInput = z.infer<typeof GitDeleteBranchSchema>;

/* ── Git branch merge ── */

/** Input for `git.mergePreview` / `git.merge`: merge `source` INTO the
 *  currently checked-out branch (HEAD). `source` may be a local branch, a
 *  remote-tracking ref (`origin/foo`) or any safe ref — same charset
 *  restriction as `GitCheckoutSchema.branch`. The merge direction is fixed
 *  (source → current branch) so the UI can always state it unambiguously. */
export const GitMergeSchema = z.object({
  repoPath: z.string(),
  source: z.string().regex(/^(?!-)[A-Za-z0-9._/\-@^{}~]+$/, "invalid git ref"),
});
export type GitMergeInput = z.infer<typeof GitMergeSchema>;

/** Preview of a pending merge, computed WITHOUT touching the working tree
 *  (a single `git rev-list --left-right --count HEAD...source`). Feeds the
 *  confirm dialog: how many commits would come in, whether the merge would
 *  fast-forward, and whether it would be a no-op. */
export interface GitMergePreviewResult {
  ok: boolean;
  error?: string;
  /** True when HEAD already contains every commit of `source` — nothing to do. */
  upToDate: boolean;
  /** True when the merge can fast-forward (HEAD has no commits `source` lacks). */
  fastForward: boolean;
  /** Commits reachable from `source` but not from HEAD. */
  incomingCommits: number;
}

/** Result of `git.merge`. Mirrors `GitOpResult`'s conflict shape (pull parity)
 *  and adds merge-specific metadata for the UI's post-merge feedback. */
export interface GitMergeResult {
  ok: boolean;
  error?: string;
  /** Set when the merge stopped with conflicts. The repo is left in a merging
   *  state (MERGE_HEAD present); `git.mergeAbort` can unwind it to the
   *  pre-merge state. */
  conflict?: boolean;
  conflictedFiles?: string[];
  /** True when HEAD already contained everything (no merge was executed). */
  upToDate?: boolean;
  /** True when the merge fast-forwarded (no merge commit was created). */
  fastForward?: boolean;
}

/* ── Git worktrees (isolated agent sessions) ──
 *  Minimal single-direction lifecycle: a "worktree" session materializes a
 *  DETACHED checkout (no branch — git forbids one branch checked out in two
 *  worktrees, and branch naming is a user-level decision deferred to merge
 *  time), works in isolation, then merges its HEAD commit back into the
 *  local checkout's current branch and is removed. Worktrees live under a
 *  managed root (userData/worktrees/<repo>/<sessionId>) OUTSIDE every
 *  registered project root, so the project-scoped path guards never see
 *  them and the isolation boundary rides on the per-turn cwd alone. */

/** One linked checkout in a `git.worktreeList` result (main worktree
 *  included as the first entry, `main: true`, so the UI can state the
 *  merge-back target). */
export interface GitWorktreeInfo {
  /** Absolute path of the worktree directory. */
  path: string;
  /** Abbreviated HEAD commit hash (merge-back source; empty when missing). */
  head: string;
  /** Checked-out branch short name; "" for detached worktrees. Populated for
   *  branch-style worktrees (generated `mcode/*` refs). */
  branch: string;
  /** True for the repository's main worktree (the original checkout). */
  main: boolean;
  /** True when the worktree has uncommitted changes. */
  dirty: boolean;
  /** True when the directory no longer exists on disk (prunable). */
  missing: boolean;
  /** How many sessions reference this path as their worktreePath. Zero =
   *  orphan (its session was deleted) — safe to clean up. */
  referencedBy: number;
  /** True when NOTHING is left to merge: the worktree's HEAD is already
   *  contained in the MAIN worktree's HEAD AND the tree is clean. The
   *  ancestor probe alone is trivially true until someone commits inside
   *  the worktree (it detaches at the main HEAD; agents edit without
   *  committing), so a dirty tree must NOT read as merged — safe to clean
   *  up only when both hold. */
  merged: boolean;
}

export const GitWorktreeListSchema = z.object({
  /** The repo to list worktrees of. Any worktree of the repo works. */
  repoPath: z.string(),
});
export type GitWorktreeListInput = z.infer<typeof GitWorktreeListSchema>;

/** Single-worktree probe — the cheap variant `git.worktreeStatus` serves to
 *  pollers that only care about ONE tree (the Titlebar merge button): same
 *  enrichment semantics as the list, but one status probe instead of one
 *  per linked worktree. Null status = not a registered worktree. */
export const GitWorktreeStatusSchema = z.object({
  repoPath: z.string(),
  worktreePath: z.string(),
});
export type GitWorktreeStatusInput = z.infer<typeof GitWorktreeStatusSchema>;

/** Merge a worktree's work back into the local checkout's CURRENT branch.
 *  Orchestrated server-side: dirty worktree → auto-commit on its detached
 *  HEAD → `git merge --no-edit <worktree HEAD>` in the local repo. */
export const GitWorktreeMergeBackSchema = z.object({
  repoPath: z.string(),
  worktreePath: z.string(),
  /** Commit message for the pre-merge auto-commit of uncommitted worktree
   *  changes. Optional — blank/absent falls back to the built-in default
   *  ("worktree: auto-commit before merge back (<dir>)"). */
  message: z.string().optional(),
});
export type GitWorktreeMergeBackInput = z.infer<typeof GitWorktreeMergeBackSchema>;

export interface GitWorktreeMergeBackResult {
  ok: boolean;
  error?: string;
  /** True when the worktree had uncommitted changes that were auto-committed
   *  on its detached HEAD before merging. */
  committedChanges?: boolean;
  /** The local branch the merge landed on (for the UI's result message). */
  targetBranch?: string;
  /** True when the merge fast-forwarded (no merge commit). */
  fastForward?: boolean;
  /** Set when the merge stopped with conflicts — the local repo is left in a
   *  merging state; the existing conflict-resolution UI applies. */
  conflict?: boolean;
  conflictedFiles?: string[];
}

export const GitWorktreeRemoveSchema = z.object({
  repoPath: z.string(),
  worktreePath: z.string(),
  /** Skip the uncommitted-changes check and pass --force. */
  force: z.boolean().optional(),
  /** Before removing, persist the worktree's FULL unmerged work (commits
   *  since the merge-base with the main HEAD, plus uncommitted edits) as a
   *  binary patch under userData/worktree-snapshots/ (last-resort recovery
   *  for discarded work). `patchPath` in the result tells the user where it
   *  went. */
  exportPatch: z.boolean().optional(),
});
export type GitWorktreeRemoveInput = z.infer<typeof GitWorktreeRemoveSchema>;

export interface GitWorktreeRemoveResult {
  ok: boolean;
  error?: string;
  /** Absolute path of the exported patch, when exportPatch was requested
   *  and succeeded. */
  patchPath?: string;
  /** Set when the worktree ran on a generated `mcode/*` branch that could
   *  NOT be auto-deleted (typically a forced removal of an unmerged tree —
   *  `git branch -d` refuses, by design). The branch is RETAINED as the
   *  recovery path for the discarded commits; surface it to the user. */
  retainedBranch?: string;
}

