/**
 * git 只读/丢弃那几条 handler 的独占套件 —— **真 git,真仓库**。
 *
 * ## 它盯的是什么
 *
 * `git.discard` 把待丢弃的文件分三类,而**只看两类**是错的:
 *
 *  - `untracked`(`?`)→ `git clean -f`,从磁盘删掉;
 *  - `added`(索引 `A`,即"新增并已 `git add`")→ **从前被当成 tracked**:
 *    `git checkout -- <file>` 对一个 HEAD 里根本没有的文件**什么都不做**,于是"丢弃"
 *    变成一次静默空操作,却回 `{ok:true}` —— 用户以为删干净了,文件还在盘上、还暂存着。
 *    正确做法是 `git rm --cached` 退暂存 + 删磁盘副本;
 *  - 其余已跟踪 → `git checkout --`(从索引还原)。
 *
 * 这三种形状只有**真跑一次 git** 才分得清(`simple-git` 的 porcelain 编码:`A ` vs `AM`
 * vs `??` vs ` M`),所以本套件建真仓库、真 `git add`、真调 handler。**不换 git 的桩。**
 *
 * ## 隔离
 *
 * 仓库是 `mkdtemp` 出来的临时目录,跑完全删。`git` 本机没有就**明确失败**(不跳过、
 * 不伪称通过)。`pathGuard` 用真的,但 `ProjectRepo.listPaths` 桩成临时仓库路径 ——
 * 于是 `findContainingWorkspaceRoot` 认它,不认别处。
 *
 * Run: scripts/git-discard-smoke/run.sh
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain } from "electron";
import { IPC } from "@contracts/ipc";
import { registerGitHandlers } from "@main/ipc/git.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function section(title: string): void {
  console.log(`\n${title}`);
}

/* ──────────────── 脚手架 ──────────────── */

const handlers = new Map<string, (...a: unknown[]) => unknown>();
const fakeIpc = {
  handle(channel: string, listener: (...a: unknown[]) => unknown): void {
    handlers.set(channel, listener);
  },
} as unknown as IpcMain;

function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`registerGitHandlers 没有注册 ${channel}`);
  return fn(null, ...args) as Promise<T>;
}

/** 真的 git(拿它建夹具)。被测 handler 里走的是 `simple-git`,两者同一套 CLI。 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "s@smoke", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "s@smoke" },
  }).trim();
}

const ROOT = mkdtempSync(join(tmpdir(), "mcode-git-discard-"));
// pathGuard 通过 ProjectRepo.listPaths 认项目根 —— 桩读这个环境变量(见 stubs.ts)。
process.env.MCODE_GIT_SMOKE_ROOT = ROOT;
registerGitHandlers(fakeIpc);

/** 建一个干净仓库,返回它的路径。 */
function makeRepo(name: string): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "committed.txt"), "原始内容\n", "utf8");
  git(dir, "add", "committed.txt");
  git(dir, "commit", "-qm", "init");
  return dir;
}

/* ──────────────── §0 安全前提 ──────────────── */

section("§0 安全前提:仓库在临时目录里");

{
  check("仓库根落在临时目录", ROOT.startsWith(tmpdir()) || existsSync(ROOT), ROOT);
  eq("通道注册上了", handlers.has(IPC.GIT_DISCARD), true);
}

/* ──────────────── §1 已跟踪的修改 → 还原 ──────────────── */

section("§1 已跟踪文件的修改:checkout 还原");

{
  const repo = makeRepo("tracked");
  writeFileSync(join(repo, "committed.txt"), "改过了\n", "utf8");
  const res = await call<{ ok: boolean; error?: string }>(IPC.GIT_DISCARD, {
    repoPath: repo,
    filePaths: ["committed.txt"],
  });
  eq("丢弃成功", res.ok, true);
  eq("内容还原成 HEAD 版", execFileSync("git", ["show", "HEAD:committed.txt"], { cwd: repo, encoding: "utf-8" }), "原始内容\n");
  check(
    "工作区也回去了(没有残留修改)",
    git(repo, "status", "--porcelain") === "",
    git(repo, "status", "--porcelain"),
  );
}

/* ──────────────── §2 未跟踪的新文件 → 删掉 ──────────────── */

section("§2 未跟踪的新文件:clean 删掉");

{
  const repo = makeRepo("untracked");
  writeFileSync(join(repo, "new.txt"), "新的\n", "utf8");
  const res = await call<{ ok: boolean; error?: string }>(IPC.GIT_DISCARD, {
    repoPath: repo,
    filePaths: ["new.txt"],
  });
  eq("丢弃成功", res.ok, true);
  check("★ 文件真的从磁盘上没了", !existsSync(join(repo, "new.txt")), { exists: existsSync(join(repo, "new.txt")) });
}

/* ──────────────── §3 ★ 已暂存的新增文件 → 退暂存 + 删盘 ──────────────── */

section("§3 ★ 已暂存的新增文件(索引 A):退暂存 + 删磁盘副本");

{
  const repo = makeRepo("added");
  writeFileSync(join(repo, "staged-new.txt"), "暂存的新增\n", "utf8");
  git(repo, "add", "staged-new.txt");
  // 确认夹具真的是那个形状:porcelain 的首列是 A。
  const porcelain = git(repo, "status", "--porcelain");
  check("夹具:这是一个已暂存的新增(A 开头)", porcelain.startsWith("A "), porcelain);

  const res = await call<{ ok: boolean; error?: string }>(IPC.GIT_DISCARD, {
    repoPath: repo,
    filePaths: ["staged-new.txt"],
  });
  eq("丢弃成功", res.ok, true);
  check(
    "★ 文件真的从磁盘上没了(不是静默空操作)",
    !existsSync(join(repo, "staged-new.txt")),
    { exists: existsSync(join(repo, "staged-new.txt")) },
  );
  eq("★ 暂存也退干净了(status 回到干净)", git(repo, "status", "--porcelain"), "");
}

/* ──────────────── §4 混合:三种一次丢 ──────────────── */

section("§4 三种形状各一条,一次丢弃");

{
  const repo = makeRepo("mixed");
  // ① 已跟踪的修改
  writeFileSync(join(repo, "committed.txt"), "改了\n", "utf8");
  // ② 未跟踪
  writeFileSync(join(repo, "loose.txt"), "散的\n", "utf8");
  // ③ 已暂存的新增
  writeFileSync(join(repo, "added.txt"), "新增\n", "utf8");
  git(repo, "add", "added.txt");

  const res = await call<{ ok: boolean; error?: string }>(IPC.GIT_DISCARD, {
    repoPath: repo,
    filePaths: ["committed.txt", "loose.txt", "added.txt"],
  });
  eq("丢弃成功", res.ok, true);
  check("已跟踪的还原了", execFileSync("git", ["show", "HEAD:committed.txt"], { cwd: repo, encoding: "utf-8" }) === "原始内容\n");
  check("未跟踪的删了", !existsSync(join(repo, "loose.txt")));
  check("暂存新增的删了", !existsSync(join(repo, "added.txt")));
  eq("整棵工作区干净", git(repo, "status", "--porcelain"), "");
}

/* ──────────────── §5 围栏:仓库不在任何已知项目内 → 拒 ──────────────── */

section("§5 围栏:仓库路径不在任何已添加的项目内");

{
  const outside = mkdtempSync(join(tmpdir(), "mcode-git-outside-"));
  git(outside, "init", "-q", "-b", "main");
  try {
    const res = await call<{ ok: boolean; error?: string }>(IPC.GIT_DISCARD, {
      repoPath: outside,
      filePaths: ["whatever.txt"],
    });
    eq("拒绝", res.ok, false);
    check("说得清为什么", typeof res.error === "string" && res.error.length > 0, res.error);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

/* ──────────────── §6 提交详情:改名文件也要带 +/- 行数 ──────────────── */

// git.showCommit 的 numstat 那一趟从前**永远匹配不上改名文件**:`diff-tree
// --numstat`(不带 -z)把改名渲染成一个展示字段 `old => new`(或同目录改名时的
// `dir/{old => new}.txt`),而文件名那一趟(diff-tree --name-status)把该文件记在
// **新路径**下。于是 `parts[parts.length - 1]`(='"old => new"')和 `byPath` 里的
// 新路径对不上,改名文件的 +/- 行数被静默丢光 —— 详情面板里只剩一个没有加号减号
// 的行。`-z` 让改名的新旧路径成为两个独立的 NUL 段,才拿得到新路径。
section("§6 提交详情:改名文件带 +/- 行数(不是静默丢)");

{
  const repo = makeRepo("rename-tally");
  // 加一个多行文件并改名 + 改两行,使 numstat 报出非零计数。
  const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1} untouched`).join("\n") + "\n";
  writeFileSync(join(repo, "oldname.txt"), body, "utf8");
  git(repo, "add", "oldname.txt");
  git(repo, "commit", "-qm", "add file to rename");
  git(repo, "mv", "oldname.txt", "newname.txt");
  writeFileSync(
    join(repo, "newname.txt"),
    body.replace("line 5 untouched", "line 5 EDITED").replace("line 9 untouched", "line 9 EDITED"),
    "utf8",
  );
  git(repo, "add", "newname.txt");
  git(repo, "commit", "-qm", "rename + edit");

  // 前提:git 自己确实把这次改动识别为改名(R 开头)。
  const ns = git(repo, "-c", "core.quotePath=false", "diff-tree", "--no-commit-id", "--name-status", "-r", "-M", "--root", "HEAD");
  check("夹具:这次提交被识别为改名(R 开头)", ns.startsWith("R"), ns);

  // commitHash 的 schema 限定十六进制(git.showCommit / git.showFile),所以要真 hash。
  const headHash = git(repo, "rev-parse", "HEAD");
  const detail = await call<{ files: Array<{ path: string; status: string; oldPath?: string; additions?: number; deletions?: number }> } | null>(
    IPC.GIT_SHOW_COMMIT,
    { repoPath: repo, commitHash: headHash },
  );
  const renamed = detail?.files.find((f) => f.path === "newname.txt");
  check("改名后的新路径出现在文件列表里", !!renamed, detail?.files);
  eq("夹具:它是 renamed 档", renamed?.status, "renamed");
  eq("记录了旧路径", renamed?.oldPath, "oldname.txt");
  // ★ 判据立在"用户看到的那两个数"上:改名文件必须带出 +2/−2(不是 undefined)。
  eq("★ 改名文件带出新增行数(不是静默丢)", renamed?.additions, 2);
  eq("★ 改名文件带出删除行数(不是静默丢)", renamed?.deletions, 2);
}

rmSync(ROOT, { recursive: true, force: true });

console.log(`\ngit-discard-smoke:${total - failures}/${total} 通过`);
if (failures > 0) process.exitCode = 1;
