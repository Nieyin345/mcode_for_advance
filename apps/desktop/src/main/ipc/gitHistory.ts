/**
 * `ipc/git.ts` 的**历史读取助手**（从 `git.ts` 拆出）。
 *
 * `git log` 输出解析（`parseLogOutput`）、blob / 提交详情读取（`showBlob` /
 * `loadCommitDetail`）、`--name-status` 解析与 numstat 合并。只依赖 `simple-git`
 * 与 `@contracts/ipc` 的类型，对 handler 注册零引用（handler 单向调用它们）。
 * **纯搬迁，函数体逐字节一致。**
 */
import type { GitCommitInfo, GitCommitFile, GitCommitFileStatus, GitCommitDetail } from "@contracts/ipc";

/** Parse `git log --format=...%x1e` output into GitCommitInfo[]. */
export function parseLogOutput(raw: string): GitCommitInfo[] {
  const commits: GitCommitInfo[] = [];
  for (const record of raw.split("\x1e")) {
    const line = record.replace(/^\n+/, "").trimEnd();
    if (!line.trim()) continue;
    const [hash, shortHash, subject, body, author, authoredAt, parentsRaw] =
      line.split("\x1f");
    if (!hash) continue;
    const parents = (parentsRaw || "")
      .split(/\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
    commits.push({
      hash,
      shortHash: shortHash || hash.slice(0, 7),
      subject: subject || "",
      body: body?.trim() || undefined,
      author: author || "",
      authoredAt: authoredAt || "",
      parents: parents.length > 0 ? parents : undefined,
    });
  }
  return commits;
}

/** Read a blob at `rev:path`. Missing path / root-parent → "". */
export async function showBlob(
  git: import("simple-git").SimpleGit,
  rev: string,
  filePath: string,
): Promise<string> {
  try {
    // `git show rev:path` — simple-git's show() returns stdout as string.
    const content = await git.show([`${rev}:${filePath}`]);
    return typeof content === "string" ? content : String(content ?? "");
  } catch {
    return "";
  }
}

/** Load commit meta + name-status file list with optional numstat tallies. */
export async function loadCommitDetail(
  git: import("simple-git").SimpleGit,
  commitHash: string,
): Promise<GitCommitDetail> {
  // Custom pretty format so we don't depend on simple-git's log field set for
  // a single-commit lookup. Fields separated by \x1f, record ends with \x1e.
  const metaRaw = await git.raw([
    "show",
    "--no-patch",
    "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI%x1f%P%x1e",
    commitHash,
  ]);
  const metaLine = metaRaw.split("\x1e")[0]?.trim() ?? "";
  const [hash, shortHash, subject, body, author, authoredAt, parentsRaw] =
    metaLine.split("\x1f");
  if (!hash) {
    throw new Error(`commit not found: ${commitHash}`);
  }
  const parents = (parentsRaw || "")
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const commit: GitCommitInfo = {
    hash,
    shortHash: shortHash || hash.slice(0, 7),
    subject: subject || "",
    body: body?.trim() || undefined,
    author: author || "",
    authoredAt: authoredAt || "",
    parents,
  };

  // name-status: status letter + path(s). --root handles the initial commit.
  const nameStatusRaw = await git.raw([
    // core.quotePath=false:否则非 ASCII 文件名(中文)被转义成 "\346\226\207…" 带引号输出,
    // 列表里是乱码、点开 diff 找不到文件、numstat 也按路径对不上。
    "-c",
    "core.quotePath=false",
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-M",
    "--root",
    commitHash,
  ]);
  const files = parseNameStatus(nameStatusRaw);

  // numstat for +/- tallies (best-effort; binary files report "-" ).
  // `-z`: NUL-terminate each record so a rename's old/new paths come as two
  // separate fields instead of git's display form (`old => new` /
  // `dir/{old => new}`) — see applyNumstat for why that form never matched.
  try {
    const numstatRaw = await git.raw([
      "-c",
      "core.quotePath=false",
      "diff-tree",
      "--no-commit-id",
      "--numstat",
      "-z",
      "-r",
      "-M",
      "--root",
      commitHash,
    ]);
    applyNumstat(files, numstatRaw);
  } catch {
    // tallies are optional
  }

  return { commit, files };
}

/** Parse `git diff-tree --name-status` output into GitCommitFile[]. */
export function parseNameStatus(raw: string): GitCommitFile[] {
  const files: GitCommitFile[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    // Formats:
    //   M\tpath
    //   A\tpath
    //   D\tpath
    //   R100\told\tnew
    //   C100\told\tnew
    const parts = trimmed.split("\t");
    if (parts.length < 2) continue;
    const code = parts[0] ?? "";
    const letter = code.charAt(0).toUpperCase();
    const status = mapCommitFileStatus(letter);
    if (letter === "R" || letter === "C") {
      const oldPath = parts[1] ?? "";
      const path = parts[2] ?? oldPath;
      files.push({ path, status, oldPath: oldPath || undefined });
    } else {
      files.push({ path: parts[1] ?? "", status });
    }
  }
  return files.filter((f) => f.path.length > 0);
}

export function mapCommitFileStatus(letter: string): GitCommitFileStatus {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "modified";
  }
}

/** Merge `git diff-tree --numstat -z` tallies into an existing file list.
 *
 *  `-z` is required, not cosmetic: without it git renders a rename's paths as
 *  one display field (`old => new`, or `dir/{old => new}.txt` when only the
 *  basename changed), so `parts[parts.length-1]` was the whole `old => new`
 *  string — never equal to the new path the name-status pass keyed the file
 *  under, so **every renamed file silently lost its +/- tallies**. With `-z`
 *  each record is NUL-terminated and a rename's two paths are separate tokens
 *  (`<add>\t<del>\t\0<old>\0<new>\0`); the empty third field is the tell. */
export function applyNumstat(files: GitCommitFile[], raw: string): void {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    // Each record begins with `<additions>\t<deletions>\t`.
    const t1 = token.indexOf("\t");
    if (t1 === -1) continue;
    const t2 = token.indexOf("\t", t1 + 1);
    if (t2 === -1) continue;
    const addStr = token.slice(0, t1);
    const delStr = token.slice(t1 + 1, t2);
    const inlinePath = token.slice(t2 + 1);
    const additions = addStr === "-" ? undefined : Number.parseInt(addStr, 10);
    const deletions = delStr === "-" ? undefined : Number.parseInt(delStr, 10);
    // Rename form: the counts token ends right after the second tab and the
    // old + new paths follow as two more NUL-terminated tokens. Key on the NEW
    // path (what name-status stored as `path` for an R/C entry).
    let path: string;
    if (inlinePath === "") {
      path = tokens[i + 2] ?? "";
      i += 2; // consume the old-path and new-path tokens
    } else {
      path = inlinePath;
    }
    const file = byPath.get(path);
    if (!file) continue;
    if (additions != null && !Number.isNaN(additions)) file.additions = additions;
    if (deletions != null && !Number.isNaN(deletions)) file.deletions = deletions;
  }
}
